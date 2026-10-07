using System.Diagnostics;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;
using PanelManager.Models;

namespace PanelManager.Services;

public sealed record AppUpdateSnapshot(string Status, string CurrentVersion, string? LatestVersion,
    string Notes, int Percent, string Message, bool CanInstall, long Revision);

// 上位机软件更新的唯一 owner：单个有界网络操作，命令只接收版本确认，不接收 URL/程序路径。
public sealed class AppUpdateService : IDisposable
{
    private readonly object _gate = new();
    private readonly MessageBridge _bridge;
    private readonly FloatingWindowManager _floating;
    private readonly OpenCodeSidecarService _openCode;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly HttpClient _systemProxy = CreateClient(true);
    private readonly HttpClient _direct = CreateClient(false);
    private CancellationTokenSource? _downloadCancellation;
    private AppRelease? _release;
    private Process? _installer;
    private bool _started;
    private bool _disposed;
    private AppUpdateSnapshot _snapshot = new("idle", AppReleasePolicy.CurrentVersionText, null, "", 0, "", false, 0);

    public AppUpdateService(MessageBridge bridge, FloatingWindowManager floating, OpenCodeSidecarService openCode)
    {
        _bridge = bridge;
        _floating = floating;
        _openCode = openCode;
    }

    private static HttpClient CreateClient(bool useProxy)
    {
        var client = new HttpClient(new HttpClientHandler { UseProxy = useProxy }) { Timeout = Timeout.InfiniteTimeSpan };
        client.DefaultRequestHeaders.UserAgent.ParseAdd($"PanelManager/{AppReleasePolicy.CurrentVersionText}");
        return client;
    }

    public AppUpdateSnapshot GetStatus()
    {
        lock (_gate) return _snapshot;
    }

    public void Start()
    {
        lock (_gate)
        {
            if (_started || _disposed) return;
            _started = true;
        }
        _ = Task.Run(CheckAfterStartupAsync);
    }

    private void SetStatus(string status, string message, int percent = 0, bool canInstall = false)
    {
        AppUpdateSnapshot snapshot;
        lock (_gate)
        {
            if (_disposed) return;
            snapshot = _snapshot = new(status, AppReleasePolicy.CurrentVersionText, _release?.Tag,
                _release?.Notes ?? "", percent, message, canInstall, _snapshot.Revision + 1);
        }
        try { _bridge.BroadcastEvent(Module.System, "appUpdateStatus", snapshot); }
        catch (Exception ex) { Debug.WriteLine($"[AppUpdate] 状态推送失败: {ex.Message}"); }
    }

    private async Task CheckAfterStartupAsync()
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(15), _lifetime.Token);
            for (var attempt = 0; attempt < 2; attempt++)
            {
                SetStatus("checking", "正在检查 PanelManager 新版本…");
                try
                {
                    var release = await FetchLatestAsync(_lifetime.Token);
                    lock (_gate) _release = release;
                    SetStatus(release == null ? "current" : "available",
                        release == null ? "当前已是最新版本。" : $"发现 PanelManager {release.Tag}", canInstall: release != null);
                    return;
                }
                catch (Exception ex) when (ex is not OperationCanceledException || !_lifetime.IsCancellationRequested)
                {
                    Debug.WriteLine($"[AppUpdate] 检查失败: {ex.Message}");
                    SetStatus("checkFailed", attempt == 0
                        ? "暂时无法检查软件更新，将在 60 秒后重试。"
                        : "暂时无法检查软件更新，将在下次启动时重试。");
                }
                if (attempt == 0) await Task.Delay(TimeSpan.FromSeconds(60), _lifetime.Token);
            }
        }
        catch (OperationCanceledException) { }
    }

    private async Task<AppRelease?> FetchLatestAsync(CancellationToken cancellation)
    {
        Exception? lastError = null;
        // GitHub API 是版本和 digest 的权威源；系统代理失败时再尝试直连。
        foreach (var client in new[] { _systemProxy, _direct })
        {
            try
            {
                using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
                deadline.CancelAfter(TimeSpan.FromSeconds(15));
                using var request = new HttpRequestMessage(HttpMethod.Get,
                    AppReleasePolicy.LatestApi + "?pm=" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
                request.Headers.CacheControl = new CacheControlHeaderValue { NoCache = true };
                using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
                response.EnsureSuccessStatusCode();
                if (response.RequestMessage?.RequestUri is not { Scheme: "https", Host: "api.github.com" })
                    throw new InvalidDataException("GitHub API 响应来源不正确。");
                await using var stream = await response.Content.ReadAsStreamAsync(deadline.Token);
                using var body = new MemoryStream();
                var buffer = new byte[16 * 1024];
                int read;
                while ((read = await stream.ReadAsync(buffer, deadline.Token)) > 0)
                {
                    if (body.Length + read > 1024 * 1024) throw new InvalidDataException("Release 元数据过大。");
                    body.Write(buffer, 0, read);
                }
                using var document = JsonDocument.Parse(body.ToArray());
                return AppReleasePolicy.ParseLatest(document.RootElement);
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !cancellation.IsCancellationRequested)
            {
                lastError = ex;
            }
        }
        throw new HttpRequestException("无法从 GitHub 获取最新版本。", lastError);
    }

    public bool TryInstall(string? version)
    {
        AppRelease release;
        CancellationTokenSource cancellation;
        lock (_gate)
        {
            if (_disposed || _release == null || version != _release.Tag || !_snapshot.CanInstall || _downloadCancellation != null)
                return false;
            if (_installer != null && !_installer.HasExited) return false;
            _installer?.Dispose();
            _installer = null;
            release = _release;
            cancellation = _downloadCancellation = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
        }
        SetStatus("downloading", "正在准备下载安装包…");
        _ = Task.Run(() => DownloadAndLaunchAsync(release, cancellation));
        return true;
    }

    public void DismissOrCancel()
    {
        AppUpdateSnapshot snapshot;
        lock (_gate)
        {
            if (_snapshot.Status is "starting" or "handedOff") return;
            if (_downloadCancellation != null)
            {
                _downloadCancellation.Cancel();
                return;
            }
            if (_release == null) return;
            snapshot = _snapshot = _snapshot with
            {
                Status = "dismissed", Message = "本次启动暂不更新。", CanInstall = false, Revision = _snapshot.Revision + 1
            };
        }
        try { _bridge.BroadcastEvent(Module.System, "appUpdateStatus", snapshot); }
        catch (Exception ex) { Debug.WriteLine($"[AppUpdate] 状态推送失败: {ex.Message}"); }
    }

    private async Task DownloadAndLaunchAsync(AppRelease release, CancellationTokenSource cancellation)
    {
        string? directory = null;
        bool handedOff = false;
        bool launched = false;
        string? terminalStatus = null;
        string terminalMessage = "";
        bool canRetry = false;
        try
        {
            directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "PanelManager", "Updates", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            var installerPath = Path.Combine(directory, AppReleasePolicy.InstallerName);
            await DownloadVerifiedAsync(release, installerPath, cancellation.Token);
            cancellation.Token.ThrowIfCancellationRequested();
            SetStatus("starting", "安装包已校验，正在启动安装程序…", 100);

            // 安装器完成窗口初始化才发送 ready；不能把 Process.Start 成功等同于已接管。
            var eventName = @"Local\PanelManager.UpdateReady." + Guid.NewGuid().ToString("N");
            using var ready = new EventWaitHandle(false, EventResetMode.ManualReset, eventName);
            using var verifiedFile = new FileStream(installerPath, FileMode.Open, FileAccess.Read, FileShare.Read);
            var finalHash = Convert.ToHexString(await SHA256.HashDataAsync(verifiedFile, cancellation.Token));
            if (!finalHash.Equals(release.Sha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("安装包启动前校验失败。");
            var fileVersion = FileVersionInfo.GetVersionInfo(installerPath);
            if (new Version(fileVersion.FileMajorPart, fileVersion.FileMinorPart, fileVersion.FileBuildPart, fileVersion.FilePrivatePart) != release.Version)
                throw new InvalidDataException("安装包内版本与 Release 标签不一致，已停止更新。");
            var info = new ProcessStartInfo(installerPath) { UseShellExecute = true, WorkingDirectory = directory };
            info.ArgumentList.Add("/update-ready-event");
            info.ArgumentList.Add(eventName);
            info.ArgumentList.Add("/update-dir");
            info.ArgumentList.Add(Path.TrimEndingDirectorySeparator(AppContext.BaseDirectory));
            var process = Process.Start(info) ?? throw new InvalidOperationException("无法启动安装程序。");
            lock (_gate) _installer = process;
            launched = true;
            var until = Stopwatch.StartNew();
            while (!ready.WaitOne(0))
            {
                if (process.HasExited) throw new InvalidOperationException("安装程序在就绪前退出，当前程序将继续运行。");
                if (until.Elapsed > TimeSpan.FromSeconds(20))
                    throw new TimeoutException("安装程序未确认就绪，当前程序将继续运行；请检查安装器窗口。");
                await Task.Delay(100, _lifetime.Token);
            }
            if (process.HasExited) throw new InvalidOperationException("安装程序已退出，当前程序将继续运行。");
            handedOff = true;
            SetStatus("handedOff", "安装程序已接管，正在退出 PanelManager…", 100);
            try { await _floating.ShutdownAsync().WaitAsync(TimeSpan.FromSeconds(3)); } catch { }
            try { await _openCode.StopAsync().WaitAsync(TimeSpan.FromSeconds(3)); } catch { }
            Environment.Exit(0);
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested || _lifetime.IsCancellationRequested)
        {
            terminalStatus = "dismissed";
            terminalMessage = "已取消软件更新。";
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[AppUpdate] {ex}");
            bool running;
            lock (_gate) running = _installer != null && !_installer.HasExited;
            terminalStatus = "error";
            terminalMessage = ex is OperationCanceledException ? "下载超时，请稍后重试。" : "软件更新未完成：" + ex.Message;
            canRetry = !running;
        }
        finally
        {
            // 启动后的资源由安装器继续使用；失败只清理本次 GUID 目录中的已知文件，不递归删除。
            if (!handedOff && !launched && directory != null)
            {
                try
                {
                    File.Delete(Path.Combine(directory, AppReleasePolicy.InstallerName + ".part"));
                    File.Delete(Path.Combine(directory, AppReleasePolicy.InstallerName));
                    Directory.Delete(directory);
                }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
            lock (_gate)
            {
                _downloadCancellation = null;
                cancellation.Dispose();
            }
            if (terminalStatus != null) SetStatus(terminalStatus, terminalMessage, canInstall: canRetry);
        }
    }

    private async Task DownloadVerifiedAsync(AppRelease release, string destination, CancellationToken cancellation)
    {
        using var overall = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        overall.CancelAfter(TimeSpan.FromMinutes(12));
        Exception? lastError = null;
        var sourceIndex = 0;
        var sources = new[] { (Client: _systemProxy, Url: release.DownloadUrl) }
            .Concat(AppReleasePolicy.DownloadSources(release).Select(url => (Client: _direct, Url: url))).ToArray();
        foreach (var source in sources)
        {
            sourceIndex++;
            try
            {
                using var sourceDeadline = CancellationTokenSource.CreateLinkedTokenSource(overall.Token);
                sourceDeadline.CancelAfter(TimeSpan.FromMinutes(3));
                using var headersDeadline = CancellationTokenSource.CreateLinkedTokenSource(sourceDeadline.Token);
                headersDeadline.CancelAfter(TimeSpan.FromSeconds(15));
                SetStatus("downloading", $"正在连接下载源 {sourceIndex}/{sources.Length}…");
                using var response = await source.Client.GetAsync(source.Url, HttpCompletionOption.ResponseHeadersRead, headersDeadline.Token);
                headersDeadline.CancelAfter(Timeout.InfiniteTimeSpan);
                response.EnsureSuccessStatusCode();
                if (response.RequestMessage?.RequestUri?.Scheme != "https") throw new InvalidDataException("下载必须使用 HTTPS。");
                if (response.Content.Headers.ContentLength is long size && size != release.Size)
                    throw new InvalidDataException("安装包长度与 GitHub 发布信息不符。");
                await using (var input = await response.Content.ReadAsStreamAsync(sourceDeadline.Token))
                await using (var output = new FileStream(destination + ".part", FileMode.Create, FileAccess.Write, FileShare.None, 65536, true))
                using (var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256))
                {
                    var buffer = new byte[65536];
                    long received = 0;
                    var lastPercent = -1;
                    while (true)
                    {
                        using var idle = CancellationTokenSource.CreateLinkedTokenSource(sourceDeadline.Token);
                        idle.CancelAfter(TimeSpan.FromSeconds(20));
                        var read = await input.ReadAsync(buffer, idle.Token);
                        if (read == 0) break;
                        received += read;
                        if (received > release.Size) throw new InvalidDataException("安装包超出预期长度。");
                        hash.AppendData(buffer, 0, read);
                        await output.WriteAsync(buffer.AsMemory(0, read), sourceDeadline.Token);
                        var percent = (int)(received * 100 / release.Size);
                        if (percent != lastPercent)
                        {
                            lastPercent = percent;
                            SetStatus("downloading", $"正在下载安装包（源 {sourceIndex}/{sources.Length}）…", percent);
                        }
                    }
                    if (received != release.Size || !Convert.ToHexString(hash.GetHashAndReset()).Equals(release.Sha256, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("安装包长度或 SHA-256 校验失败。");
                }
                File.Move(destination + ".part", destination, true);
                return;
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !overall.IsCancellationRequested)
            {
                lastError = ex;
                Debug.WriteLine($"[AppUpdate] 下载源 {sourceIndex} 失败: {ex.Message}");
                // 重试从零开始，不能拼接不同代理的缓存内容。
            }
        }
        throw new IOException("所有下载源均失败，请稍后重试。", lastError);
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
            _lifetime.Cancel();
        }
        _systemProxy.Dispose();
        _direct.Dispose();
    }
}
