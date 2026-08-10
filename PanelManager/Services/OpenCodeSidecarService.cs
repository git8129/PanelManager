using PanelManager.Models;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace PanelManager.Services;

public sealed class OpenCodeSidecarService : IDisposable
{
    private readonly MessageBridge _bridge;
    private readonly HttpClient _githubHttp;
    private readonly HttpClient _localHttp;
    private readonly SemaphoreSlim _gate = new(1, 1);

    private Process? _process;
    private string _serverUrl = string.Empty;
    private string _serverPassword = string.Empty;
    private string _serverVersion = string.Empty;
    private string _selectedVersion = "latest";

    private readonly string _baseDir;
    private readonly string _downloadsDir;
    private readonly string _versionsDir;
    private readonly string _configDir;
    private readonly string _dataDir;
    private readonly string _runtimeStatePath;

    private readonly string _workspacesDir;
    private string _workspaceId = string.Empty;
    private string _workspaceDir = string.Empty;
    private string _workspaceSourceDir = string.Empty;
    private string _workspaceSandboxDir = string.Empty;
    private string _workspaceRepoRoot = string.Empty;
    private string _workspaceSourceOrigin = string.Empty;

    private CancellationTokenSource? _eventLoopCts;
    private Task? _eventLoopTask;
    private string _eventEndpoint = "/global/event";
    private const string ExistingProcessConflictCode = "OPENCODE_PROCESS_EXISTS";

    public OpenCodeSidecarService(MessageBridge bridge)
    {
        _bridge = bridge;

        _baseDir = ResolveOpenCodeBaseDir();
        _downloadsDir = Path.Combine(_baseDir, "downloads");
        _versionsDir = Path.Combine(_baseDir, "versions");
        _configDir = Path.Combine(_baseDir, "config");
        _dataDir = Path.Combine(_baseDir, "data");
        _runtimeStatePath = Path.Combine(_baseDir, "runtime.json");

        _workspacesDir = Path.Combine(_baseDir, "workspaces");

        Directory.CreateDirectory(_downloadsDir);
        Directory.CreateDirectory(_versionsDir);
        Directory.CreateDirectory(_configDir);
        Directory.CreateDirectory(_dataDir);
        Directory.CreateDirectory(_workspacesDir);

        _githubHttp = new HttpClient();
        _githubHttp.DefaultRequestHeaders.UserAgent.ParseAdd("PanelManager/1.0");
        _githubHttp.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));

        var handler = new HttpClientHandler
        {
            Proxy = null,
            UseProxy = false,
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate
        };
        _localHttp = new HttpClient(handler);
        _localHttp.Timeout = TimeSpan.FromMinutes(10);
    }

    private static string ResolveOpenCodeBaseDir()
    {
        var appBase = AppDomain.CurrentDomain.BaseDirectory;
        return Path.Combine(appBase, ".sandbox", "OpenCode");
    }

    public object GetStatusSnapshot()
    {
        var running = _process != null && !_process.HasExited;
        return new
        {
            running,
            url = running ? _serverUrl : string.Empty,
            version = running ? _serverVersion : string.Empty,
            selectedVersion = _selectedVersion,
            workspace = new
            {
                id = string.IsNullOrWhiteSpace(_workspaceId) ? null : _workspaceId,
                dir = string.IsNullOrWhiteSpace(_workspaceDir) ? null : _workspaceDir,
                sourceDir = string.IsNullOrWhiteSpace(_workspaceSourceDir) ? null : _workspaceSourceDir,
                sandboxDir = string.IsNullOrWhiteSpace(_workspaceSandboxDir) ? null : _workspaceSandboxDir,
                repoRoot = string.IsNullOrWhiteSpace(_workspaceRepoRoot) ? null : _workspaceRepoRoot,
                origin = string.IsNullOrWhiteSpace(_workspaceSourceOrigin) ? null : _workspaceSourceOrigin
            }
        };
    }

    public object GetWorkspaceSnapshot()
    {
        return new
        {
            id = string.IsNullOrWhiteSpace(_workspaceId) ? null : _workspaceId,
            dir = string.IsNullOrWhiteSpace(_workspaceDir) ? null : _workspaceDir,
            sourceDir = string.IsNullOrWhiteSpace(_workspaceSourceDir) ? null : _workspaceSourceDir,
            sandboxDir = string.IsNullOrWhiteSpace(_workspaceSandboxDir) ? null : _workspaceSandboxDir,
            repoRoot = string.IsNullOrWhiteSpace(_workspaceRepoRoot) ? null : _workspaceRepoRoot,
            origin = string.IsNullOrWhiteSpace(_workspaceSourceOrigin) ? null : _workspaceSourceOrigin
        };
    }

    public string? WorkspaceId => string.IsNullOrWhiteSpace(_workspaceId) ? null : _workspaceId;
    public string? WorkspaceDir => string.IsNullOrWhiteSpace(_workspaceDir) ? null : _workspaceDir;
    public string? WorkspaceSourceDir => string.IsNullOrWhiteSpace(_workspaceSourceDir) ? null : _workspaceSourceDir;
    public string? WorkspaceSandboxDir => string.IsNullOrWhiteSpace(_workspaceSandboxDir) ? null : _workspaceSandboxDir;
    public string? WorkspaceRepoRoot => string.IsNullOrWhiteSpace(_workspaceRepoRoot) ? null : _workspaceRepoRoot;
    public string? WorkspaceOrigin => string.IsNullOrWhiteSpace(_workspaceSourceOrigin) ? null : _workspaceSourceOrigin;

    public async Task<object> EnsureStartedAsync(string? versionSpec, bool forceRestart = false, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            _selectedVersion = string.IsNullOrWhiteSpace(versionSpec) ? "latest" : versionSpec.Trim();

            if (_process != null && !_process.HasExited)
            {
                BroadcastStatus();
                return GetStatusSnapshot();
            }

            if (await TryAdoptExistingServerAsync(ct).ConfigureAwait(false))
            {
                BroadcastStatus();
                return GetStatusSnapshot();
            }

            await StopInternalAsync().ConfigureAwait(false);

            // Prepare a fresh sandbox workspace per OpenCode start.
            await PrepareWorkspaceAsync(forceNew: true, ct).ConfigureAwait(false);

            if (HasRunningOpenCodeProcess())
            {
                if (!forceRestart)
                {
                    throw new InvalidOperationException($"{ExistingProcessConflictCode}: 检测到已有 OpenCode 进程，但无法自动接管");
                }

                var killed = KillAllOpenCodeProcesses();
                await Task.Delay(250, ct).ConfigureAwait(false);
                if (HasRunningOpenCodeProcess())
                {
                    throw new InvalidOperationException($"{ExistingProcessConflictCode}: 强制结束已有 OpenCode 进程失败（已结束 {killed} 个）");
                }
            }

            var (localExe, localTag) = FindLocalOpenCodeExe(_selectedVersion);
            if (!string.IsNullOrWhiteSpace(localExe))
            {
                BroadcastProgress(new OpenCodeSidecarProgress("start", localTag, null, null, null, "启动本地 OpenCode 服务...", null));
                await StartServerAsync(localExe, localTag, ct).ConfigureAwait(false);
                BroadcastStatus();
                return GetStatusSnapshot();
            }

            BroadcastProgress(new OpenCodeSidecarProgress("start", _selectedVersion, 0, null, null, "准备下载 OpenCode...", null));

            using var release = await GetReleaseAsync(_selectedVersion, ct).ConfigureAwait(false);
            var (assetName, assetUrl, assetDigestHex, assetSize, tagName) = PickWindowsAsset(release);

            var versionDir = Path.Combine(_versionsDir, tagName);
            var exePath = FindOpenCodeExe(versionDir);
            if (exePath == null)
            {
                var zipPath = Path.Combine(_downloadsDir, $"{tagName}-{assetName}");
                await DownloadAssetAsync(assetUrl, zipPath, assetDigestHex, assetSize, tagName, ct).ConfigureAwait(false);
                await ExtractZipAsync(zipPath, versionDir, tagName, ct).ConfigureAwait(false);
                exePath = FindOpenCodeExe(versionDir);
            }

            if (exePath == null)
            {
                throw new FileNotFoundException("未找到 opencode.exe（解压后）");
            }

            await StartServerAsync(exePath, tagName, ct).ConfigureAwait(false);
            BroadcastStatus();
            return GetStatusSnapshot();
        }
        catch (Exception ex)
        {
            BroadcastProgress(new OpenCodeSidecarProgress("error", _selectedVersion, null, null, null, "AI 初始化失败", ex.Message));
            await StopInternalAsync().ConfigureAwait(false);
            BroadcastStatus();
            throw;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task StopAsync()
    {
        await _gate.WaitAsync();
        try
        {
            await StopInternalAsync().ConfigureAwait(false);
            BroadcastStatus();
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<JsonElement> GetJsonAsync(string path, CancellationToken ct = default)
    {
        var url = GetServerUrlOrThrow();
        var req = new HttpRequestMessage(HttpMethod.Get, new Uri(new Uri(url), path));
        AddBasicAuth(req);
        using var resp = await _localHttp.SendAsync(req, ct).ConfigureAwait(false);
        var text = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"OpenCode API 请求失败: {(int)resp.StatusCode} {resp.ReasonPhrase}: {text}");
        }
        using var doc = JsonDocument.Parse(text);
        return doc.RootElement.Clone();
    }

    public async Task<JsonElement> PostJsonAsync(string path, JsonElement body, CancellationToken ct = default)
    {
        var url = GetServerUrlOrThrow();
        var req = new HttpRequestMessage(HttpMethod.Post, new Uri(new Uri(url), path));
        AddBasicAuth(req);
        req.Content = new StringContent(body.GetRawText(), Encoding.UTF8, "application/json");
        using var resp = await _localHttp.SendAsync(req, ct).ConfigureAwait(false);
        var text = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"OpenCode API POST 失败: {(int)resp.StatusCode} {resp.ReasonPhrase}: {text}");
        }
        using var doc = JsonDocument.Parse(text);
        return doc.RootElement.Clone();
    }

    // 允许 204/空响应的 POST（例如 /session/{id}/prompt_async）
    public async Task<JsonElement> PostJsonAllowEmptyAsync(string path, JsonElement body, CancellationToken ct = default)
    {
        var url = GetServerUrlOrThrow();
        var req = new HttpRequestMessage(HttpMethod.Post, new Uri(new Uri(url), path));
        AddBasicAuth(req);
        req.Content = new StringContent(body.GetRawText(), Encoding.UTF8, "application/json");
        using var resp = await _localHttp.SendAsync(req, ct).ConfigureAwait(false);
        var text = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"OpenCode API POST 失败: {(int)resp.StatusCode} {resp.ReasonPhrase}: {text}");
        }
        if (string.IsNullOrWhiteSpace(text))
        {
            return JsonDocument.Parse("true").RootElement.Clone();
        }
        using var doc = JsonDocument.Parse(text);
        return doc.RootElement.Clone();
    }

    public async Task<JsonElement> PostNoBodyAsync(string path, CancellationToken ct = default)
    {
        var url = GetServerUrlOrThrow();
        var req = new HttpRequestMessage(HttpMethod.Post, new Uri(new Uri(url), path));
        AddBasicAuth(req);
        using var resp = await _localHttp.SendAsync(req, ct).ConfigureAwait(false);
        var text = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"OpenCode API POST 失败: {(int)resp.StatusCode} {resp.ReasonPhrase}: {text}");
        }
        if (string.IsNullOrWhiteSpace(text))
        {
            return JsonDocument.Parse("true").RootElement.Clone();
        }
        using var doc = JsonDocument.Parse(text);
        return doc.RootElement.Clone();
    }

    public async Task<bool> PutAuthAsync(string providerId, JsonElement credentials, CancellationToken ct = default)
    {
        var url = GetServerUrlOrThrow();
        var req = new HttpRequestMessage(HttpMethod.Put, new Uri(new Uri(url), $"/auth/{Uri.EscapeDataString(providerId)}"));
        AddBasicAuth(req);
        req.Content = new StringContent(credentials.GetRawText(), Encoding.UTF8, "application/json");
        using var resp = await _localHttp.SendAsync(req, ct).ConfigureAwait(false);
        var text = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"OpenCode API /auth 失败: {(int)resp.StatusCode} {resp.ReasonPhrase}: {text}");
        }
        // Returns boolean
        return text.Trim().Equals("true", StringComparison.OrdinalIgnoreCase);
    }

    public async Task<JsonElement> PatchConfigAsync(JsonElement patch, CancellationToken ct = default)
    {
        var url = GetServerUrlOrThrow();
        var req = new HttpRequestMessage(HttpMethod.Patch, new Uri(new Uri(url), "/config"));
        AddBasicAuth(req);
        req.Content = new StringContent(patch.GetRawText(), Encoding.UTF8, "application/json");
        using var resp = await _localHttp.SendAsync(req, ct).ConfigureAwait(false);
        var text = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"OpenCode API /config 失败: {(int)resp.StatusCode} {resp.ReasonPhrase}: {text}");
        }
        using var doc = JsonDocument.Parse(text);
        return doc.RootElement.Clone();
    }

    private string GetServerUrlOrThrow()
    {
        if (_process == null || _process.HasExited || string.IsNullOrWhiteSpace(_serverUrl))
        {
            throw new InvalidOperationException("OpenCode 服务未启动");
        }
        return _serverUrl;
    }

    private void BroadcastStatus()
    {
        try { _bridge.BroadcastEvent(Module.System, "aiStatus", GetStatusSnapshot()); } catch { }
    }

    private void BroadcastProgress(OpenCodeSidecarProgress progress)
    {
        try { _bridge.BroadcastEvent(Module.System, "aiSidecarProgress", progress); } catch { }
    }

    private async Task StopInternalAsync()
    {
        try
        {
            _eventLoopCts?.Cancel();
        }
        catch { }
        _eventLoopCts = null;
        _eventLoopTask = null;

        _serverUrl = string.Empty;
        _serverPassword = string.Empty;
        _serverVersion = string.Empty;
        _eventEndpoint = "/global/event";

        ClearRuntimeState();

        if (_process == null)
        {
            return;
        }

        try
        {
            if (!_process.HasExited)
            {
                _process.Kill(entireProcessTree: true);
            }
        }
        catch { }

        try { _process.Dispose(); } catch { }
        _process = null;

        await Task.CompletedTask;
    }

    private async Task PrepareWorkspaceAsync(bool forceNew, CancellationToken ct)
    {
        if (!forceNew && !string.IsNullOrWhiteSpace(_workspaceSourceDir) && Directory.Exists(_workspaceSourceDir))
        {
            if (string.IsNullOrWhiteSpace(_workspaceSandboxDir) && !string.IsNullOrWhiteSpace(_workspaceDir))
            {
                _workspaceSandboxDir = Path.Combine(_workspaceDir, ".sandbox");
                EnsureWorkspaceSandboxLayout();
            }
            return;
        }

        _workspaceId = string.Empty;
        _workspaceDir = string.Empty;
        _workspaceSourceDir = string.Empty;
        _workspaceSandboxDir = string.Empty;
        _workspaceRepoRoot = string.Empty;
        _workspaceSourceOrigin = string.Empty;

        Directory.CreateDirectory(_workspacesDir);
        var ts = DateTime.Now.ToString("yyyyMMdd-HHmmss");
        var suffix = Guid.NewGuid().ToString("N").Substring(0, 6);
        _workspaceId = $"{ts}-{suffix}";
        _workspaceDir = Path.Combine(_workspacesDir, _workspaceId);
        _workspaceSourceDir = _workspaceDir;
        _workspaceSandboxDir = Path.Combine(_workspaceDir, ".sandbox");
        Directory.CreateDirectory(_workspaceSourceDir);
        EnsureWorkspaceSandboxLayout();

        BroadcastProgress(new OpenCodeSidecarProgress("workspace", _selectedVersion, 0, null, null, $"准备工作区: {_workspaceId}", null));

        var appBase = AppDomain.CurrentDomain.BaseDirectory;

        // 1) Prefer source archive in output (publish).
        var archive = TryFindSourceArchive(appBase);
        if (!string.IsNullOrWhiteSpace(archive) && File.Exists(archive))
        {
            try
            {
                BroadcastProgress(new OpenCodeSidecarProgress("workspace", _selectedVersion, 10, null, null, "解压源码包...", null));
                ExtractSourceArchiveBestEffort(archive, _workspaceSourceDir);
                _workspaceSourceOrigin = "archive";
            }
            catch
            {
                // fall through
            }
        }

        // 2) Fallback to repo copy (debug/dev).
        if (string.IsNullOrWhiteSpace(_workspaceSourceOrigin))
        {
            var repoRoot = TryDiscoverRepoRoot(appBase);
            if (!string.IsNullOrWhiteSpace(repoRoot) && Directory.Exists(repoRoot))
            {
                _workspaceRepoRoot = repoRoot;
                _workspaceSourceOrigin = "repo";
                BroadcastProgress(new OpenCodeSidecarProgress("workspace", _selectedVersion, 15, null, null, "复制源码到工作区...", null));
                await CopyRepoToWorkspaceAsync(repoRoot, _workspaceSourceDir, ct).ConfigureAwait(false);
            }
        }

        BroadcastProgress(new OpenCodeSidecarProgress("workspace", _selectedVersion, 100, null, null, "工作区就绪", null));
    }

    private static string? TryFindSourceArchive(string baseDir)
    {
        try
        {
            return Directory.GetFiles(baseDir, "PanelManager-source-*.zip", SearchOption.TopDirectoryOnly)
                .OrderByDescending(File.GetLastWriteTimeUtc)
                .FirstOrDefault();
        }
        catch
        {
            return null;
        }
    }

    private static string? TryDiscoverRepoRoot(string baseDir)
    {
        try
        {
            var cur = new DirectoryInfo(baseDir);
            for (var i = 0; i < 10 && cur != null; i++)
            {
                var sln = Path.Combine(cur.FullName, "PanelManager.sln");
                if (File.Exists(sln) && Directory.Exists(Path.Combine(cur.FullName, "PanelManager")))
                {
                    return cur.FullName;
                }
                cur = cur.Parent;
            }
        }
        catch
        {
            // ignore
        }
        return null;
    }

    private static void ExtractSourceArchiveBestEffort(string zipPath, string destDir)
    {
        using var fs = new FileStream(zipPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var za = new ZipArchive(fs, ZipArchiveMode.Read);

        foreach (var entry in za.Entries)
        {
            if (string.IsNullOrWhiteSpace(entry.FullName) || entry.FullName.EndsWith("/", StringComparison.Ordinal))
            {
                continue;
            }

            var name = entry.FullName.Replace('\\', '/').TrimStart('/');
            if (name.Length >= 3 && char.IsLetter(name[0]) && name[1] == ':' && name[2] == '/')
            {
                name = name.Substring(3);
            }

            var firstSlash = name.IndexOf('/');
            if (firstSlash > 0)
            {
                var firstSegment = name.Substring(0, firstSlash);
                var knownRoots = new[] { "PanelManager", "FloatingWindow", "Installer", "scripts", "skills", ".sandbox", "README.md", "AGENTS.md", "PanelManager.sln" };
                if (!knownRoots.Contains(firstSegment, StringComparer.OrdinalIgnoreCase))
                {
                    name = name.Substring(firstSlash + 1);
                }
            }

            if (string.IsNullOrWhiteSpace(name))
            {
                continue;
            }
            if (name.Contains("../", StringComparison.Ordinal) || name.Contains("..\\", StringComparison.Ordinal))
            {
                continue;
            }

            var outPath = Path.Combine(destDir, name.Replace('/', Path.DirectorySeparatorChar));
            var outDir = Path.GetDirectoryName(outPath);
            if (!string.IsNullOrWhiteSpace(outDir))
            {
                Directory.CreateDirectory(outDir);
            }
            entry.ExtractToFile(outPath, overwrite: true);
        }
    }

    private static async Task CopyRepoToWorkspaceAsync(string repoRoot, string destSrcDir, CancellationToken ct)
    {
        var items = new (string rel, bool isDir)[]
        {
            ("PanelManager", true),
            ("FloatingWindow", true),
            ("Installer", true),
            ("scripts", true),
            ("skills", true),
            ("Directory.Build.props", false),
            ("PanelManager.sln", false),
            ("README.md", false),
            ("AGENTS.md", false),
        };

        foreach (var (rel, isDir) in items)
        {
            ct.ThrowIfCancellationRequested();
            var src = Path.Combine(repoRoot, rel);
            var dst = Path.Combine(destSrcDir, rel);
            if (isDir)
            {
                if (!Directory.Exists(src)) continue;
                CopyDirectoryFiltered(src, dst);
            }
            else
            {
                if (!File.Exists(src)) continue;
                Directory.CreateDirectory(Path.GetDirectoryName(dst) ?? destSrcDir);
                File.Copy(src, dst, overwrite: true);
            }
            await Task.Yield();
        }
    }

    private static void CopyDirectoryFiltered(string sourceDir, string destDir)
    {
        Directory.CreateDirectory(destDir);

        foreach (var dir in Directory.GetDirectories(sourceDir))
        {
            var name = Path.GetFileName(dir);
            if (ShouldSkipName(name)) continue;
            CopyDirectoryFiltered(dir, Path.Combine(destDir, name));
        }

        foreach (var file in Directory.GetFiles(sourceDir))
        {
            var name = Path.GetFileName(file);
            if (ShouldSkipName(name)) continue;
            File.Copy(file, Path.Combine(destDir, name), overwrite: true);
        }
    }

    private static void CopyDirectoryAll(string sourceDir, string destDir)
    {
        Directory.CreateDirectory(destDir);

        foreach (var dir in Directory.GetDirectories(sourceDir, "*", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(sourceDir, dir);
            Directory.CreateDirectory(Path.Combine(destDir, rel));
        }

        foreach (var file in Directory.GetFiles(sourceDir, "*", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(sourceDir, file);
            var dst = Path.Combine(destDir, rel);
            Directory.CreateDirectory(Path.GetDirectoryName(dst) ?? destDir);
            File.Copy(file, dst, overwrite: true);
        }
    }

    private static bool ShouldSkipName(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return true;
        if (string.Equals(name, "bin", StringComparison.OrdinalIgnoreCase)) return true;
        if (string.Equals(name, "obj", StringComparison.OrdinalIgnoreCase)) return true;
        if (string.Equals(name, "Tools", StringComparison.OrdinalIgnoreCase)) return true;
        if (string.Equals(name, ".git", StringComparison.OrdinalIgnoreCase)) return true;
        if (string.Equals(name, ".vs", StringComparison.OrdinalIgnoreCase)) return true;
        if (string.Equals(name, "workspaces", StringComparison.OrdinalIgnoreCase)) return true;
        if (string.Equals(name, "releases", StringComparison.OrdinalIgnoreCase)) return true;
        if (string.Equals(name, "artifacts", StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    private async Task<JsonDocument> GetReleaseAsync(string versionSpec, CancellationToken ct)
    {
        var url = versionSpec.Equals("latest", StringComparison.OrdinalIgnoreCase)
            ? "https://api.github.com/repos/anomalyco/opencode/releases/latest"
            : $"https://api.github.com/repos/anomalyco/opencode/releases/tags/{Uri.EscapeDataString(versionSpec)}";

        using var resp = await _githubHttp.GetAsync(url, ct).ConfigureAwait(false);
        var text = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"获取 OpenCode Release 失败: {(int)resp.StatusCode} {resp.ReasonPhrase}: {text}");
        }
        return JsonDocument.Parse(text);
    }

    private static (string name, string url, string sha256Hex, long size, string tagName) PickWindowsAsset(JsonDocument release)
    {
        var root = release.RootElement;
        var tag = root.GetProperty("tag_name").GetString() ?? "latest";

        var assets = root.GetProperty("assets").EnumerateArray().ToList();
        var preferred = assets.FirstOrDefault(a => a.GetProperty("name").GetString() == "opencode-windows-x64.zip");
        if (preferred.ValueKind == JsonValueKind.Undefined)
        {
            preferred = assets.FirstOrDefault(a => a.GetProperty("name").GetString() == "opencode-windows-x64-baseline.zip");
        }
        if (preferred.ValueKind == JsonValueKind.Undefined)
        {
            throw new InvalidOperationException("Release 中未找到 Windows 可执行包（opencode-windows-x64.zip）");
        }

        var name = preferred.GetProperty("name").GetString() ?? "opencode-windows-x64.zip";
        var url = preferred.GetProperty("browser_download_url").GetString() ?? throw new InvalidOperationException("missing browser_download_url");
        var digest = preferred.TryGetProperty("digest", out var d) ? d.GetString() : null;
        if (string.IsNullOrWhiteSpace(digest) || !digest.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("Release 未提供 sha256 digest，无法校验下载包");
        }
        var sha256Hex = digest.Substring("sha256:".Length).Trim();
        var size = preferred.TryGetProperty("size", out var s) ? s.GetInt64() : 0;
        return (name, url, sha256Hex, size, tag);
    }

    private async Task DownloadAssetAsync(string assetUrl, string zipPath, string sha256Hex, long size, string tag, CancellationToken ct)
    {
        BroadcastProgress(new OpenCodeSidecarProgress("download", tag, 0, 0, size, "下载中...", null));

        using var resp = await _githubHttp.GetAsync(assetUrl, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        resp.EnsureSuccessStatusCode();

        var total = resp.Content.Headers.ContentLength ?? (size > 0 ? size : 0);
        await using var input = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);

        var buffer = new byte[1024 * 64];
        long done = 0;
        var lastTick = Environment.TickCount64;

        // 注意：校验 sha256 需要重新打开 zip 文件读取。
        // 如果这里一直持有输出流（且 FileShare=None），后续校验会因为文件锁而失败。
        using (var output = new FileStream(zipPath, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            while (true)
            {
                var read = await input.ReadAsync(buffer, ct).ConfigureAwait(false);
                if (read <= 0)
                {
                    break;
                }
                await output.WriteAsync(buffer.AsMemory(0, read), ct).ConfigureAwait(false);
                done += read;

                var now = Environment.TickCount64;
                if (now - lastTick >= 200)
                {
                    lastTick = now;
                    int? percent = null;
                    if (total > 0)
                    {
                        percent = (int)Math.Round(done * 100.0 / total);
                    }
                    BroadcastProgress(new OpenCodeSidecarProgress("download", tag, percent, done, total, "下载中...", null));
                }
            }
            await output.FlushAsync(ct).ConfigureAwait(false);
        }

        BroadcastProgress(new OpenCodeSidecarProgress("verify", tag, null, null, null, "校验中...", null));
        // 少量重试：避免被杀软/索引器短暂占用导致失败
        var actual = string.Empty;
        for (var attempt = 0; attempt < 6; attempt++)
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                actual = ComputeSha256Hex(zipPath);
                break;
            }
            catch (IOException) when (attempt < 5)
            {
                await Task.Delay(200 + attempt * 200, ct).ConfigureAwait(false);
            }
        }
        if (!actual.Equals(sha256Hex, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException($"sha256 校验失败：期望 {sha256Hex}，实际 {actual}");
        }
    }

    private async Task ExtractZipAsync(string zipPath, string versionDir, string tag, CancellationToken ct)
    {
        BroadcastProgress(new OpenCodeSidecarProgress("extract", tag, 0, 0, null, "解压中...", null));

        if (Directory.Exists(versionDir))
        {
            // 避免旧文件混入
            Directory.Delete(versionDir, recursive: true);
        }
        Directory.CreateDirectory(versionDir);

        using var fs = new FileStream(zipPath, FileMode.Open, FileAccess.Read, FileShare.Read);
        using var archive = new ZipArchive(fs, ZipArchiveMode.Read);
        var entries = archive.Entries.Where(e => !string.IsNullOrEmpty(e.Name)).ToList();
        var total = entries.Count;

        for (int i = 0; i < total; i++)
        {
            ct.ThrowIfCancellationRequested();
            var e = entries[i];

            var destPath = Path.GetFullPath(Path.Combine(versionDir, e.FullName));
            if (!destPath.StartsWith(Path.GetFullPath(versionDir), StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            Directory.CreateDirectory(Path.GetDirectoryName(destPath)!);
            e.ExtractToFile(destPath, overwrite: true);

            if (i % 5 == 0 || i == total - 1)
            {
                var percent = total > 0 ? (int)Math.Round((i + 1) * 100.0 / total) : 0;
                BroadcastProgress(new OpenCodeSidecarProgress("extract", tag, percent, i + 1, total, "解压中...", null));
            }
        }

        await Task.CompletedTask;
    }

    private async Task StartServerAsync(string exePath, string tag, CancellationToken ct)
    {
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException("OpenCode sidecar 目前仅支持 Windows");
        }

        var port = GetFreePort();
        var password = Guid.NewGuid().ToString("N");

        BroadcastProgress(new OpenCodeSidecarProgress("start", tag, null, null, null, "启动服务...", null));

        var psi = new ProcessStartInfo
        {
            FileName = exePath,
            Arguments = $"serve --hostname 127.0.0.1 --port {port}",
            UseShellExecute = false,
            RedirectStandardOutput = false,
            RedirectStandardError = false,
            CreateNoWindow = true,
            // Point OpenCode's default cwd to the prepared workspace source directory.
            WorkingDirectory = (!string.IsNullOrWhiteSpace(_workspaceSourceDir) && Directory.Exists(_workspaceSourceDir))
                ? _workspaceSourceDir
                : (Path.GetDirectoryName(exePath) ?? AppDomain.CurrentDomain.BaseDirectory)
        };

        psi.Environment["OPENCODE_SERVER_PASSWORD"] = password;
        psi.Environment["NO_PROXY"] = UpsertNoProxy(psi.Environment.TryGetValue("NO_PROXY", out var v) ? v : null);
        psi.Environment["no_proxy"] = UpsertNoProxy(psi.Environment.TryGetValue("no_proxy", out var v2) ? v2 : null);

        // 隔离 OpenCode 数据/配置到应用目录，避免污染用户全局目录
        psi.Environment["OPENCODE_CONFIG_DIR"] = _configDir;
        psi.Environment["XDG_CONFIG_HOME"] = _configDir;
        psi.Environment["XDG_DATA_HOME"] = _dataDir;
        ConfigureWorkspaceToolEnvironment(psi);

        var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
        AttachProcessExitHandler(proc);

        if (!proc.Start())
        {
            throw new InvalidOperationException("无法启动 opencode 进程");
        }

        _process = proc;
        _serverUrl = $"http://127.0.0.1:{port}";
        _serverPassword = password;

        BroadcastProgress(new OpenCodeSidecarProgress("health", tag, null, null, null, "健康检查...", null));
        var (healthy, version) = await WaitForHealthAsync(ct).ConfigureAwait(false);
        if (!healthy)
        {
            throw new InvalidOperationException("OpenCode 健康检查失败");
        }

        _serverVersion = version;
        SaveRuntimeState();
        StartEventLoop();
        BroadcastProgress(new OpenCodeSidecarProgress("done", tag, 100, null, null, "已连接", null));
    }

    private void StartEventLoop()
    {
        try
        {
            _eventLoopCts?.Cancel();
        }
        catch { }

        _eventLoopCts = new CancellationTokenSource();
        var token = _eventLoopCts.Token;

        _eventLoopTask = Task.Run(async () =>
        {
            while (!token.IsCancellationRequested)
            {
                if (_process == null || _process.HasExited || string.IsNullOrWhiteSpace(_serverUrl))
                {
                    await Task.Delay(250, token).ConfigureAwait(false);
                    continue;
                }

                try
                {
                    await SubscribeEventsOnce(token).ConfigureAwait(false);
                }
                catch
                {
                    // ignore
                }

                if (token.IsCancellationRequested)
                {
                    break;
                }

                await Task.Delay(250, token).ConfigureAwait(false);
            }
        }, token);
    }

    private async Task SubscribeEventsOnce(CancellationToken ct)
    {
        var url = GetServerUrlOrThrow();
        var req = new HttpRequestMessage(HttpMethod.Get, new Uri(new Uri(url), _eventEndpoint));
        AddBasicAuth(req);
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));

        using var resp = await _localHttp.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);

        if (resp.StatusCode == HttpStatusCode.NotFound && _eventEndpoint.Equals("/global/event", StringComparison.Ordinal))
        {
            // 兼容较旧的 OpenCode 版本（仅提供 /event）
            _eventEndpoint = "/event";
            SaveRuntimeState();
            return;
        }

        resp.EnsureSuccessStatusCode();

        await using var stream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        using var reader = new StreamReader(stream, Encoding.UTF8);

        var data = new StringBuilder();
        while (!ct.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync().ConfigureAwait(false);
            if (line == null)
            {
                break;
            }

            if (line.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
            {
                var chunk = line.Substring("data:".Length).TrimStart();
                if (data.Length > 0)
                {
                    data.Append('\n');
                }
                data.Append(chunk);
                continue;
            }

            if (line.Length == 0)
            {
                if (data.Length > 0)
                {
                    HandleServerEventData(data.ToString());
                    data.Clear();
                }
                continue;
            }
        }
    }

    private void HandleServerEventData(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement.Clone();
            // 透明转发：不筛选/改写 OpenCode 事件语义
            _bridge.BroadcastEvent(Module.System, "aiEvent", root);
        }
        catch
        {
            // ignore
        }
    }

    private async Task<(bool healthy, string version)> WaitForHealthAsync(CancellationToken ct)
    {
        var deadline = DateTimeOffset.UtcNow.AddSeconds(30);
        while (DateTimeOffset.UtcNow < deadline)
        {
            ct.ThrowIfCancellationRequested();
            if (_process == null || _process.HasExited)
            {
                return (false, string.Empty);
            }

            try
            {
                var req = new HttpRequestMessage(HttpMethod.Get, new Uri(new Uri(_serverUrl), "/global/health"));
                AddBasicAuth(req);
                using var resp = await _localHttp.SendAsync(req, ct).ConfigureAwait(false);
                if (resp.IsSuccessStatusCode)
                {
                    var text = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
                    using var doc = JsonDocument.Parse(text);
                    var root = doc.RootElement;
                    var healthy = root.TryGetProperty("healthy", out var h) && h.GetBoolean();
                    var version = root.TryGetProperty("version", out var v) ? (v.GetString() ?? string.Empty) : string.Empty;
                    if (healthy)
                    {
                        return (true, version);
                    }
                }
            }
            catch
            {
                // ignore
            }

            await Task.Delay(250, ct).ConfigureAwait(false);
        }

        return (false, string.Empty);
    }

    private void AddBasicAuth(HttpRequestMessage req)
    {
        if (string.IsNullOrWhiteSpace(_serverPassword))
        {
            return;
        }
        var token = Convert.ToBase64String(Encoding.UTF8.GetBytes($"opencode:{_serverPassword}"));
        req.Headers.Authorization = new AuthenticationHeaderValue("Basic", token);
    }

    private static string? FindOpenCodeExe(string versionDir)
    {
        if (!Directory.Exists(versionDir))
        {
            return null;
        }
        try
        {
            return Directory.GetFiles(versionDir, "opencode.exe", SearchOption.AllDirectories).FirstOrDefault();
        }
        catch
        {
            return null;
        }
    }

    private (string? exePath, string tag) FindLocalOpenCodeExe(string versionSpec)
    {
        if (!versionSpec.Equals("latest", StringComparison.OrdinalIgnoreCase))
        {
            var fixedDir = Path.Combine(_versionsDir, versionSpec);
            return (FindOpenCodeExe(fixedDir), versionSpec);
        }

        try
        {
            var dirs = Directory.GetDirectories(_versionsDir)
                .Select(path => new DirectoryInfo(path))
                .OrderByDescending(dir => dir.LastWriteTimeUtc);

            foreach (var dir in dirs)
            {
                var exe = FindOpenCodeExe(dir.FullName);
                if (!string.IsNullOrWhiteSpace(exe))
                {
                    return (exe, dir.Name);
                }
            }
        }
        catch
        {
            // ignore
        }

        return (null, "latest");
    }

    private static bool HasRunningOpenCodeProcess()
    {
        try
        {
            foreach (var p in Process.GetProcessesByName("opencode"))
            {
                try
                {
                    if (!p.HasExited)
                    {
                        return true;
                    }
                }
                catch
                {
                    // ignore
                }
                finally
                {
                    try { p.Dispose(); } catch { }
                }
            }
        }
        catch
        {
            // ignore
        }

        return false;
    }

    private static int KillAllOpenCodeProcesses()
    {
        var killed = 0;
        try
        {
            foreach (var p in Process.GetProcessesByName("opencode"))
            {
                try
                {
                    if (!p.HasExited)
                    {
                        p.Kill(entireProcessTree: true);
                        killed++;
                    }
                }
                catch
                {
                    // ignore
                }
                finally
                {
                    try { p.Dispose(); } catch { }
                }
            }
        }
        catch
        {
            // ignore
        }

        return killed;
    }

    private async Task<bool> TryAdoptExistingServerAsync(CancellationToken ct)
    {
        var state = TryReadRuntimeState();
        if (state == null)
        {
            return false;
        }

        if (string.IsNullOrWhiteSpace(state.Url) || string.IsNullOrWhiteSpace(state.Password) || state.Pid <= 0)
        {
            ClearRuntimeState();
            return false;
        }

        Process? proc = null;
        try
        {
            proc = Process.GetProcessById(state.Pid);
            if (proc.HasExited)
            {
                proc.Dispose();
                ClearRuntimeState();
                return false;
            }

            _process = proc;
            _serverUrl = state.Url;
            _serverPassword = state.Password;
            _serverVersion = state.Version;
            _eventEndpoint = string.IsNullOrWhiteSpace(state.EventEndpoint) ? "/global/event" : state.EventEndpoint;
            if (!string.IsNullOrWhiteSpace(state.SelectedVersion))
            {
                _selectedVersion = state.SelectedVersion;
            }

            if (!string.IsNullOrWhiteSpace(state.WorkspaceId)) _workspaceId = state.WorkspaceId;
            if (!string.IsNullOrWhiteSpace(state.WorkspaceDir)) _workspaceDir = state.WorkspaceDir;
            if (!string.IsNullOrWhiteSpace(state.WorkspaceSourceDir)) _workspaceSourceDir = state.WorkspaceSourceDir;
            if (!string.IsNullOrWhiteSpace(state.WorkspaceSandboxDir)) _workspaceSandboxDir = state.WorkspaceSandboxDir;
            if (!string.IsNullOrWhiteSpace(state.WorkspaceRepoRoot)) _workspaceRepoRoot = state.WorkspaceRepoRoot;
            if (!string.IsNullOrWhiteSpace(state.WorkspaceSourceOrigin)) _workspaceSourceOrigin = state.WorkspaceSourceOrigin;
            if (string.IsNullOrWhiteSpace(_workspaceSandboxDir) && !string.IsNullOrWhiteSpace(_workspaceDir))
            {
                _workspaceSandboxDir = Path.Combine(_workspaceDir, ".sandbox");
            }
            EnsureWorkspaceSandboxLayout();

            var (healthy, version) = await WaitForHealthAsync(ct).ConfigureAwait(false);
            if (!healthy)
            {
                _process = null;
                _serverUrl = string.Empty;
                _serverPassword = string.Empty;
                _serverVersion = string.Empty;
                _eventEndpoint = "/global/event";
                try { proc.Dispose(); } catch { }
                ClearRuntimeState();
                return false;
            }

            if (!string.IsNullOrWhiteSpace(version))
            {
                _serverVersion = version;
            }

            // Older runtime state may not include workspace info; ensure one exists for prompt injection.
            if (string.IsNullOrWhiteSpace(_workspaceSourceDir) || !Directory.Exists(_workspaceSourceDir))
            {
                await PrepareWorkspaceAsync(forceNew: true, ct).ConfigureAwait(false);
            }

            AttachProcessExitHandler(proc);
            StartEventLoop();
            SaveRuntimeState();
            return true;
        }
        catch
        {
            if (proc != null)
            {
                try { proc.Dispose(); } catch { }
            }
            _process = null;
            _serverUrl = string.Empty;
            _serverPassword = string.Empty;
            _serverVersion = string.Empty;
            _eventEndpoint = "/global/event";
            ClearRuntimeState();
            return false;
        }
    }

    private RuntimeState? TryReadRuntimeState()
    {
        try
        {
            if (!File.Exists(_runtimeStatePath))
            {
                return null;
            }

            var text = File.ReadAllText(_runtimeStatePath);
            if (string.IsNullOrWhiteSpace(text))
            {
                return null;
            }

            return JsonSerializer.Deserialize<RuntimeState>(text);
        }
        catch
        {
            return null;
        }
    }

    private void SaveRuntimeState()
    {
        try
        {
            if (_process == null || _process.HasExited || string.IsNullOrWhiteSpace(_serverUrl) || string.IsNullOrWhiteSpace(_serverPassword))
            {
                return;
            }

            var state = new RuntimeState
            {
                Pid = _process.Id,
                Url = _serverUrl,
                Password = _serverPassword,
                Version = _serverVersion,
                SelectedVersion = _selectedVersion,
                EventEndpoint = _eventEndpoint,
                WorkspaceId = _workspaceId,
                WorkspaceDir = _workspaceDir,
                WorkspaceSourceDir = _workspaceSourceDir,
                WorkspaceSandboxDir = _workspaceSandboxDir,
                WorkspaceRepoRoot = _workspaceRepoRoot,
                WorkspaceSourceOrigin = _workspaceSourceOrigin
            };

            var text = JsonSerializer.Serialize(state);
            File.WriteAllText(_runtimeStatePath, text);
        }
        catch
        {
            // ignore
        }
    }

    private void ClearRuntimeState()
    {
        try
        {
            if (File.Exists(_runtimeStatePath))
            {
                File.Delete(_runtimeStatePath);
            }
        }
        catch
        {
            // ignore
        }
    }

    private void AttachProcessExitHandler(Process proc)
    {
        proc.EnableRaisingEvents = true;
        proc.Exited += (_, __) =>
        {
            try
            {
                _serverUrl = string.Empty;
                _serverPassword = string.Empty;
                _serverVersion = string.Empty;
                _eventEndpoint = "/global/event";
                ClearRuntimeState();
                BroadcastStatus();
            }
            catch { }
        };
    }

    private sealed class RuntimeState
    {
        public int Pid { get; set; }

        public string Url { get; set; } = string.Empty;

        public string Password { get; set; } = string.Empty;

        public string Version { get; set; } = string.Empty;

        public string SelectedVersion { get; set; } = "latest";

        public string EventEndpoint { get; set; } = "/global/event";

        public string WorkspaceId { get; set; } = string.Empty;

        public string WorkspaceDir { get; set; } = string.Empty;

        public string WorkspaceSourceDir { get; set; } = string.Empty;

        public string WorkspaceSandboxDir { get; set; } = string.Empty;

        public string WorkspaceRepoRoot { get; set; } = string.Empty;

        public string WorkspaceSourceOrigin { get; set; } = string.Empty;
    }

    private static int GetFreePort()
    {
        var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    private static string UpsertNoProxy(string? current)
    {
        var hosts = new List<string>();
        if (!string.IsNullOrWhiteSpace(current))
        {
            hosts.AddRange(current.Split(',').Select(v => v.Trim()).Where(v => !string.IsNullOrWhiteSpace(v)));
        }
        foreach (var h in new[] { "127.0.0.1", "localhost", "::1" })
        {
            if (!hosts.Any(v => v.Equals(h, StringComparison.OrdinalIgnoreCase)))
            {
                hosts.Add(h);
            }
        }
        return string.Join(",", hosts);
    }

    private void EnsureWorkspaceSandboxLayout()
    {
        if (string.IsNullOrWhiteSpace(_workspaceSandboxDir)) return;

        foreach (var dir in new[]
        {
            _workspaceSandboxDir,
            Path.Combine(_workspaceSandboxDir, "home"),
            Path.Combine(_workspaceSandboxDir, "home", "AppData", "Roaming"),
            Path.Combine(_workspaceSandboxDir, "home", "AppData", "Local"),
            Path.Combine(_workspaceSandboxDir, "tmp"),
            Path.Combine(_workspaceSandboxDir, "npm-prefix"),
            Path.Combine(_workspaceSandboxDir, "npm-cache"),
            Path.Combine(_workspaceSandboxDir, "nuget"),
            Path.Combine(_workspaceSandboxDir, "nuget", "packages"),
            Path.Combine(_workspaceSandboxDir, "nuget", "http-cache"),
            Path.Combine(_workspaceSandboxDir, "nuget", "plugins-cache"),
            Path.Combine(_workspaceSandboxDir, "pnpm-home"),
            Path.Combine(_workspaceSandboxDir, "pip-cache"),
            Path.Combine(_workspaceSandboxDir, "uv-cache"),
            Path.Combine(_workspaceSandboxDir, "cargo-home"),
            Path.Combine(_workspaceSandboxDir, "rustup-home"),
            Path.Combine(_workspaceSandboxDir, "go-bin"),
            Path.Combine(_workspaceSandboxDir, "go-cache"),
            Path.Combine(_workspaceSandboxDir, "go-mod-cache"),
            Path.Combine(_workspaceSandboxDir, "gem-home")
        })
        {
            Directory.CreateDirectory(dir);
        }
    }

    private void ConfigureWorkspaceToolEnvironment(ProcessStartInfo psi)
    {
        if (string.IsNullOrWhiteSpace(_workspaceSandboxDir)) return;

        EnsureWorkspaceSandboxLayout();

        var homeDir = Path.Combine(_workspaceSandboxDir, "home");
        var roamingDir = Path.Combine(homeDir, "AppData", "Roaming");
        var localDir = Path.Combine(homeDir, "AppData", "Local");
        var tempDir = Path.Combine(_workspaceSandboxDir, "tmp");
        var npmPrefixDir = Path.Combine(_workspaceSandboxDir, "npm-prefix");
        var npmCacheDir = Path.Combine(_workspaceSandboxDir, "npm-cache");
        var nugetPackagesDir = Path.Combine(_workspaceSandboxDir, "nuget", "packages");
        var nugetHttpCacheDir = Path.Combine(_workspaceSandboxDir, "nuget", "http-cache");
        var nugetPluginsCacheDir = Path.Combine(_workspaceSandboxDir, "nuget", "plugins-cache");
        var pnpmHomeDir = Path.Combine(_workspaceSandboxDir, "pnpm-home");
        var pipCacheDir = Path.Combine(_workspaceSandboxDir, "pip-cache");
        var uvCacheDir = Path.Combine(_workspaceSandboxDir, "uv-cache");
        var cargoHomeDir = Path.Combine(_workspaceSandboxDir, "cargo-home");
        var rustupHomeDir = Path.Combine(_workspaceSandboxDir, "rustup-home");
        var goBinDir = Path.Combine(_workspaceSandboxDir, "go-bin");
        var goCacheDir = Path.Combine(_workspaceSandboxDir, "go-cache");
        var goModCacheDir = Path.Combine(_workspaceSandboxDir, "go-mod-cache");
        var gemHomeDir = Path.Combine(_workspaceSandboxDir, "gem-home");

        psi.Environment["HOME"] = homeDir;
        psi.Environment["USERPROFILE"] = homeDir;
        psi.Environment["APPDATA"] = roamingDir;
        psi.Environment["LOCALAPPDATA"] = localDir;
        psi.Environment["TEMP"] = tempDir;
        psi.Environment["TMP"] = tempDir;

        psi.Environment["NPM_CONFIG_PREFIX"] = npmPrefixDir;
        psi.Environment["npm_config_prefix"] = npmPrefixDir;
        psi.Environment["NPM_CONFIG_CACHE"] = npmCacheDir;
        psi.Environment["npm_config_cache"] = npmCacheDir;
        psi.Environment["NUGET_PACKAGES"] = nugetPackagesDir;
        psi.Environment["RestorePackagesPath"] = nugetPackagesDir;
        psi.Environment["NUGET_HTTP_CACHE_PATH"] = nugetHttpCacheDir;
        psi.Environment["NUGET_PLUGINS_CACHE_PATH"] = nugetPluginsCacheDir;
        psi.Environment["PNPM_HOME"] = pnpmHomeDir;
        psi.Environment["PIP_CACHE_DIR"] = pipCacheDir;
        psi.Environment["UV_CACHE_DIR"] = uvCacheDir;
        psi.Environment["CARGO_HOME"] = cargoHomeDir;
        psi.Environment["RUSTUP_HOME"] = rustupHomeDir;
        psi.Environment["GOBIN"] = goBinDir;
        psi.Environment["GOCACHE"] = goCacheDir;
        psi.Environment["GOMODCACHE"] = goModCacheDir;
        psi.Environment["GEM_HOME"] = gemHomeDir;
        psi.Environment["GEM_SPEC_CACHE"] = Path.Combine(gemHomeDir, "specs");
        psi.Environment["PIP_DISABLE_PIP_VERSION_CHECK"] = "1";

        var prepend = new[]
        {
            npmPrefixDir,
            Path.Combine(npmPrefixDir, "node_modules", ".bin"),
            pnpmHomeDir,
            goBinDir
        };
        psi.Environment["PATH"] = PrependPath(psi.Environment.TryGetValue("PATH", out var currentPath) ? currentPath : null, prepend);
    }

    private static string PrependPath(string? current, IEnumerable<string> entries)
    {
        var values = new List<string>();
        foreach (var entry in entries)
        {
            if (string.IsNullOrWhiteSpace(entry)) continue;
            values.Add(entry);
        }

        if (!string.IsNullOrWhiteSpace(current))
        {
            values.AddRange(current.Split(Path.PathSeparator).Where(v => !string.IsNullOrWhiteSpace(v)));
        }

        return string.Join(Path.PathSeparator.ToString(), values.Distinct(StringComparer.OrdinalIgnoreCase));
    }

    private static string ComputeSha256Hex(string filePath)
    {
        using var sha = SHA256.Create();
        // 允许其他进程读/写共享（配合上方重试），降低被占用导致的失败概率
        using var fs = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        var hash = sha.ComputeHash(fs);
        var sb = new StringBuilder(hash.Length * 2);
        foreach (var b in hash)
        {
            sb.Append(b.ToString("x2"));
        }
        return sb.ToString();
    }

    public void Dispose()
    {
        try { _process?.Dispose(); } catch { }
        _process = null;
        _githubHttp.Dispose();
        _localHttp.Dispose();
        _gate.Dispose();
    }

    private sealed record OpenCodeSidecarProgress(
        string stage,
        string version,
        int? percent,
        long? current,
        long? total,
        string text,
        string? error);
}
