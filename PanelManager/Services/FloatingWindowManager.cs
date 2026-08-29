using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Maui.ApplicationModel;
using PanelManager.Models;

#if WINDOWS
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Windows.Graphics;
using WinUIWindow = Microsoft.UI.Xaml.Window;
#endif

namespace PanelManager.Services
{
    /// <summary>
    /// 管理悬浮图标窗与主窗口的切换，使用独立的 WPF 进程作为悬浮窗。
    /// 通过 WebSocket (MessageBridge) 与悬浮窗通信。
    /// </summary>
    public class FloatingWindowManager
    {
        private MessageBridge? _bridge;
        private readonly SemaphoreSlim _transitionGate = new(1, 1);
        private readonly object _stateLock = new();
        private bool _isFloating;
        private bool _floatingClientReady;
        private bool _desiredFloating;
        private string? _currentTransitionId;
        private string? _floatingSessionToken;
        private TaskCompletionSource<bool>? _readyCompletion;
        private TaskCompletionSource<bool>? _visibleCompletion;
        private Process? _floatingWindowProcess;
        private const string FloatingTokenEnvironmentVariable = "PANELMANAGER_FLOATING_TOKEN";
        private static readonly TimeSpan FloatingReadyTimeout = TimeSpan.FromSeconds(5);
        private static readonly TimeSpan FloatingVisibleTimeout = TimeSpan.FromSeconds(3);

#if WINDOWS
        private WinUIWindow? _mainWindow;
        private AppWindow? _mainAppWindow;
        private bool _isFullscreen;
        private RectInt32? _restoreRect;
        private AppWindowPresenterKind? _restorePresenterKind;
#endif

        public void AttachBridge(MessageBridge bridge)
        {
            if (ReferenceEquals(_bridge, bridge))
            {
                return;
            }

            if (_bridge != null)
            {
                _bridge.OnFloatingClientDisconnected -= HandleFloatingClientDisconnected;
            }

            _bridge = bridge;
            _bridge.OnFloatingClientDisconnected += HandleFloatingClientDisconnected;
        }

        public void AttachMainWindow(object? window, object? appWindow)
        {
#if WINDOWS
            _mainWindow = window as WinUIWindow;
            _mainAppWindow = appWindow as AppWindow;
#endif
        }

        public bool IsFloating
        {
            get
            {
                lock (_stateLock)
                {
                    return _isFloating;
                }
            }
        }

        /// <summary>
        /// 初始化 WPF 悬浮窗进程（后台运行，不显示），在主窗加载后调用。
        /// </summary>
        public async Task<bool> InitializeFloatingWindowProcessAsync()
        {
#if WINDOWS
            Process? existingProcess;
            lock (_stateLock)
            {
                existingProcess = _floatingWindowProcess;
            }

            if (existingProcess != null)
            {
                try
                {
                    if (!existingProcess.HasExited)
                    {
                        LogInfo("Floating window process already initialized");
                        return true;
                    }
                }
                catch (InvalidOperationException)
                {
                }

                lock (_stateLock)
                {
                    if (ReferenceEquals(_floatingWindowProcess, existingProcess))
                    {
                        _floatingWindowProcess = null;
                        _floatingSessionToken = null;
                        _floatingClientReady = false;
                    }
                }
                existingProcess.Dispose();
            }

            // 查找 FloatingWindow.exe
            var exePath = FindFloatingWindowExecutable();
            if (string.IsNullOrEmpty(exePath))
            {
                _bridge?.BroadcastEvent(Module.System, "floatingError", new { msg = "找不到 FloatingWindow.exe" });
                return false;
            }

            try
            {
                if (_bridge == null)
                {
                    return false;
                }

                var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
                var startInfo = new ProcessStartInfo
                {
                    FileName = exePath,
                    Arguments = $"--parent-pid {Environment.ProcessId}",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WorkingDirectory = Path.GetDirectoryName(exePath),
                    WindowStyle = ProcessWindowStyle.Hidden
                };
                startInfo.Environment[FloatingTokenEnvironmentVariable] = token;

                var process = new Process
                {
                    StartInfo = startInfo,
                    EnableRaisingEvents = true
                };
                process.Exited += (_, _) => HandleFloatingProcessExited(process, token);

                _bridge.PrepareFloatingClientSession(token);
                lock (_stateLock)
                {
                    _floatingWindowProcess = process;
                    _floatingSessionToken = token;
                    _floatingClientReady = false;
                }

                if (!process.Start())
                {
                    throw new InvalidOperationException("Floating window process did not start");
                }

                LogInfo($"Floating window process started (PID: {process.Id})");
                await Task.CompletedTask;
                return true;
            }
            catch (Exception ex)
            {
                Process? failedProcess;
                string? failedToken;
                lock (_stateLock)
                {
                    failedProcess = _floatingWindowProcess;
                    failedToken = _floatingSessionToken;
                    _floatingWindowProcess = null;
                    _floatingSessionToken = null;
                    _floatingClientReady = false;
                }
                if (failedToken != null)
                {
                    _bridge?.ClearFloatingClientSession(failedToken);
                }
                failedProcess?.Dispose();
                LogInfo($"Failed to start floating window process: {ex.Message}");
                _bridge?.BroadcastEvent(Module.System, "floatingError", new { msg = $"无法启动悬浮窗进程: {ex.Message}" });
                return false;
            }
#else
            await Task.Delay(0);
            return false;
#endif
        }

        /// <summary>
        /// 进入/退出全屏
        /// </summary>
        public async Task<(bool ok, string? error)> SetFullscreenAsync(bool enable)
        {
#if WINDOWS
            if (_mainAppWindow == null)
            {
                LogInfo("Fullscreen ignored: mainAppWindow is null");
                return (false, "主窗口未初始化");
            }

            try
            {
                // 先计算分辨率，不抛异常阻塞 UI
                if (enable)
                {
                    var appPos = _mainAppWindow.Position;
                    var appSize = _mainAppWindow.Size;
                    var windowRect = new RectInt32(appPos.X, appPos.Y, appSize.Width, appSize.Height);
                    var displayArea = DisplayArea.GetFromRect(windowRect, DisplayAreaFallback.Nearest);
                    var outerBounds = displayArea.OuterBounds;
                    if (outerBounds.Width != 1920 || outerBounds.Height != 1080)
                    {
                        var msg = $"当前分辨率是 {outerBounds.Width}x{outerBounds.Height}，无法全屏";
                        LogInfo(msg);
                        return (false, msg);
                    }
                }

                await MainThread.InvokeOnMainThreadAsync(() =>
                {
                    if (enable)
                    {
                        if (_isFullscreen) return;

                        var pos = _mainAppWindow.Position;
                        var size = _mainAppWindow.Size;
                        _restoreRect = new RectInt32(pos.X, pos.Y, size.Width, size.Height);
                        _restorePresenterKind = _mainAppWindow.Presenter?.Kind;

                        _mainAppWindow.SetPresenter(AppWindowPresenterKind.FullScreen);
                        _isFullscreen = true;
                        WinUI.App.SetWindowTaskbarVisibility(false);
                        LogInfo("Entered fullscreen");
                    }
                    else
                    {
                        if (_mainAppWindow.Presenter?.Kind != AppWindowPresenterKind.FullScreen && !_isFullscreen)
                        {
                            LogInfo("Exit fullscreen ignored: not in fullscreen");
                        }

                        _mainAppWindow.SetPresenter(AppWindowPresenterKind.Overlapped);

                        if (_restoreRect.HasValue)
                        {
                            _mainAppWindow.MoveAndResize(_restoreRect.Value);
                        }

                        if (_restorePresenterKind.HasValue && _restorePresenterKind.Value != AppWindowPresenterKind.Overlapped)
                        {
                            _mainAppWindow.SetPresenter(_restorePresenterKind.Value);
                        }

                        if (_mainAppWindow.Presenter is OverlappedPresenter presenter)
                        {
                            presenter.SetBorderAndTitleBar(true, true);
                            presenter.IsResizable = false;
                            presenter.IsMaximizable = false;
                            presenter.IsMinimizable = true;
                        }

                        _isFullscreen = false;
                        _restoreRect = null;
                        _restorePresenterKind = null;
                        WinUI.App.SetWindowTaskbarVisibility(true);
                        LogInfo("Exited fullscreen");
                    }
                });

                return (true, null);
            }
            catch (Exception ex)
            {
                LogInfo($"Fullscreen error: {ex.Message}");
                return (false, ex.Message);
            }
#else
            await Task.Delay(0);
            return (false, "当前平台不支持全屏控制");
#endif
        }

        /// <summary>
        /// 进入悬浮模式：隐藏主窗口，广播事件通知悬浮窗显示
        /// </summary>
        public async Task<(bool ok, string? error)> SetNoActivateAsync(bool enable)
        {
#if WINDOWS
            if (_mainWindow == null)
            {
                LogInfo("NoActivate ignored: mainWindow is null");
                return (false, "main window not initialized");
            }

            try
            {
                await MainThread.InvokeOnMainThreadAsync(() =>
                {
                    var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(_mainWindow);
                    SetWindowNoActivate(hwnd, enable);
                });

                return (true, null);
            }
            catch (Exception ex)
            {
                LogInfo($"SetNoActivate error: {ex.Message}");
                return (false, ex.Message);
            }
#else
            await Task.Delay(0);
            return (false, "platform not supported");
#endif
        }

        public async Task<bool> EnterFloatingAsync()
        {
#if WINDOWS
            await _transitionGate.WaitAsync();
            try
            {
                lock (_stateLock)
                {
                    if (_isFloating)
                    {
                        LogInfo("Already in floating mode");
                        return true;
                    }
                }

                if (_mainWindow == null || _mainAppWindow == null || _bridge == null)
                {
                    LogInfo("Main window or message bridge not initialized");
                    return false;
                }

                var transitionId = Guid.NewGuid().ToString("N");
                TaskCompletionSource<bool> readyCompletion;
                TaskCompletionSource<bool> visibleCompletion;
                lock (_stateLock)
                {
                    _desiredFloating = true;
                    _currentTransitionId = transitionId;
                    readyCompletion = NewCompletionSource();
                    visibleCompletion = NewCompletionSource();
                    _readyCompletion = readyCompletion;
                    _visibleCompletion = visibleCompletion;
                    if (_floatingClientReady && _bridge.HasFloatingClient)
                    {
                        readyCompletion.TrySetResult(true);
                    }
                }

                if (!await InitializeFloatingWindowProcessAsync() ||
                    !await WaitForSignalAsync(readyCompletion, FloatingReadyTimeout))
                {
                    await RollBackFloatingEntryAsync("悬浮窗连接超时");
                    return false;
                }

                var showSent = await _bridge.SendFloatingEventAsync(
                    Module.System,
                    "floatingShow",
                    new { transitionId });
                if (!showSent || !await WaitForSignalAsync(visibleCompletion, FloatingVisibleTimeout))
                {
                    await RollBackFloatingEntryAsync("悬浮窗显示超时");
                    return false;
                }

                lock (_stateLock)
                {
                    if (!_floatingClientReady || !_bridge.HasFloatingClient)
                    {
                        visibleCompletion.TrySetResult(false);
                        throw new InvalidOperationException("Floating client disconnected before main window was hidden");
                    }
                    _isFloating = true;
                }

                await MainThread.InvokeOnMainThreadAsync(() => _mainAppWindow.Hide());

                lock (_stateLock)
                {
                    _readyCompletion = null;
                    _visibleCompletion = null;
                }
                LogInfo("Entered floating mode");
                return true;
            }
            catch (Exception ex)
            {
                LogInfo($"Enter floating failed: {ex.Message}");
                await RollBackFloatingEntryAsync("进入悬浮模式失败");
                return false;
            }
            finally
            {
                _transitionGate.Release();
            }
#else
            await Task.Delay(0);
            return false;
#endif
        }

        public async Task<bool> RestoreFromFloatingAsync()
        {
#if WINDOWS
            await _transitionGate.WaitAsync();
            try
            {
                if (_mainAppWindow == null || _mainWindow == null)
                {
                    LogInfo("Restore ignored: mainAppWindow or mainWindow is null");
                    return false;
                }

                lock (_stateLock)
                {
                    _desiredFloating = false;
                    _readyCompletion?.TrySetResult(false);
                    _visibleCompletion?.TrySetResult(false);
                }

                await ShowAndActivateMainWindowAsync();

                var transitionId = Guid.NewGuid().ToString("N");
                if (_bridge != null)
                {
                    var hideSent = await _bridge.SendFloatingEventAsync(
                        Module.System,
                        "floatingHide",
                        new { transitionId });
                    if (!hideSent)
                    {
                        LogInfo("Floating hide was not delivered; disconnect recovery will keep the main window visible");
                    }
                }

                lock (_stateLock)
                {
                    _isFloating = false;
                    _currentTransitionId = null;
                    _readyCompletion = null;
                    _visibleCompletion = null;
                }
                _bridge?.BroadcastEvent(Module.System, "floatingRestored", new { mode = "1080p" });
                LogInfo("Restored from floating mode (1080p)");

                return true;
            }
            catch (Exception ex)
            {
                LogInfo($"Restore from floating failed: {ex.Message}");
                return false;
            }
            finally
            {
                _transitionGate.Release();
            }
#else
            await Task.Delay(0);
            return false;
#endif
        }

        public void NotifyFloatingClientReady()
        {
            string? transitionId = null;
            var shouldReshow = false;
            var shouldHide = false;
            lock (_stateLock)
            {
                _floatingClientReady = true;
                _readyCompletion?.TrySetResult(true);
                shouldReshow = _isFloating && _desiredFloating;
                shouldHide = !_desiredFloating;
                transitionId = _currentTransitionId;
            }

            if (shouldReshow && transitionId != null && _bridge != null)
            {
                _ = _bridge.SendFloatingEventAsync(
                    Module.System,
                    "floatingShow",
                    new { transitionId });
            }
            else if (shouldHide && _bridge != null)
            {
                _ = _bridge.SendFloatingEventAsync(Module.System, "floatingHide", null);
            }
        }

        public bool NotifyFloatingWindowVisible(string? transitionId, bool visible)
        {
            lock (_stateLock)
            {
                if (string.IsNullOrEmpty(transitionId) ||
                    !string.Equals(transitionId, _currentTransitionId, StringComparison.Ordinal))
                {
                    return false;
                }

                _visibleCompletion?.TrySetResult(visible);
                return true;
            }
        }

        private static TaskCompletionSource<bool> NewCompletionSource()
        {
            return new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        private static async Task<bool> WaitForSignalAsync(
            TaskCompletionSource<bool> completion,
            TimeSpan timeout)
        {
            try
            {
                return await completion.Task.WaitAsync(timeout);
            }
            catch (TimeoutException)
            {
                return false;
            }
        }

        private async Task RollBackFloatingEntryAsync(string reason)
        {
            lock (_stateLock)
            {
                _desiredFloating = false;
                _isFloating = false;
                _currentTransitionId = null;
                _readyCompletion = null;
                _visibleCompletion = null;
            }

            if (_mainAppWindow != null && _mainWindow != null)
            {
                await ShowAndActivateMainWindowAsync();
            }
            if (_bridge != null)
            {
                await _bridge.SendFloatingEventAsync(Module.System, "floatingHide", null);
                _bridge.BroadcastEvent(Module.System, "floatingError", new { msg = reason });
            }
            LogInfo(reason);
        }

#if WINDOWS
        private Task ShowAndActivateMainWindowAsync()
        {
            return MainThread.InvokeOnMainThreadAsync(() =>
            {
                _mainAppWindow!.Show();
                _mainWindow!.Activate();
            });
        }
#endif

        private void HandleFloatingClientDisconnected()
        {
            var shouldRecover = false;
            lock (_stateLock)
            {
                _floatingClientReady = false;
                _readyCompletion?.TrySetResult(false);
                _visibleCompletion?.TrySetResult(false);
                shouldRecover = _isFloating;
            }

            if (shouldRecover)
            {
                _ = RecoverMainWindowAsync("悬浮窗连接已断开");
            }
        }

        private void HandleFloatingProcessExited(Process process, string token)
        {
            lock (_stateLock)
            {
                if (!ReferenceEquals(_floatingWindowProcess, process))
                {
                    return;
                }

                _floatingWindowProcess = null;
                _floatingSessionToken = null;
                _floatingClientReady = false;
                _readyCompletion?.TrySetResult(false);
                _visibleCompletion?.TrySetResult(false);
            }

            _bridge?.ClearFloatingClientSession(token);
            try { process.Dispose(); } catch { }
            _ = RecoverMainWindowAsync("悬浮窗进程已退出");
        }

        private async Task RecoverMainWindowAsync(string reason)
        {
#if WINDOWS
            await _transitionGate.WaitAsync();
            try
            {
                lock (_stateLock)
                {
                    if (!_isFloating)
                    {
                        return;
                    }

                    _desiredFloating = false;
                    _isFloating = false;
                    _currentTransitionId = null;
                    _readyCompletion = null;
                    _visibleCompletion = null;
                }

                if (_mainAppWindow != null && _mainWindow != null)
                {
                    await ShowAndActivateMainWindowAsync();
                }
                _bridge?.BroadcastEvent(Module.System, "floatingRestored", new { mode = "1080p", reason });
                LogInfo(reason);
            }
            catch (Exception ex)
            {
                LogInfo($"Failed to recover main window: {ex.Message}");
            }
            finally
            {
                _transitionGate.Release();
            }
#else
            await Task.CompletedTask;
#endif
        }

        /// <summary>
        /// 清理资源
        /// </summary>
        public async Task ShutdownAsync()
        {
            await _transitionGate.WaitAsync();
            try
            {
                lock (_stateLock)
                {
                    _desiredFloating = false;
                    _isFloating = false;
                    _readyCompletion?.TrySetResult(false);
                    _visibleCompletion?.TrySetResult(false);
                }

                if (_bridge != null)
                {
                    await _bridge.SendFloatingEventAsync(Module.System, "floatingClose", null);
                }
                await Task.Delay(200);

                Process? process;
                string? token;
                lock (_stateLock)
                {
                    process = _floatingWindowProcess;
                    token = _floatingSessionToken;
                    _floatingWindowProcess = null;
                    _floatingSessionToken = null;
                    _floatingClientReady = false;
                    _currentTransitionId = null;
                    _readyCompletion = null;
                    _visibleCompletion = null;
                }

                if (token != null)
                {
                    _bridge?.ClearFloatingClientSession(token);
                }
                if (process != null)
                {
                    try
                    {
                        if (!process.HasExited)
                        {
                            process.Kill();
                            await process.WaitForExitAsync();
                        }
                    }
                    catch (InvalidOperationException)
                    {
                    }
                    finally
                    {
                        process.Dispose();
                    }
                }

                LogInfo("Floating window process stopped");
            }
            catch (Exception ex)
            {
                LogInfo($"Error stopping floating window process: {ex.Message}");
            }
            finally
            {
                _transitionGate.Release();
            }
        }

        public void Dispose()
        {
            _ = ShutdownAsync();
        }

        private string? FindFloatingWindowExecutable()
        {
            var baseDir = AppDomain.CurrentDomain.BaseDirectory;

            // 开发环境路径
            // baseDir 通常在: PanelManager/PanelManager/bin/(Debug|Release)/.../，需要回到解决方案根目录
            var solutionDir = Path.GetFullPath(Path.Combine(baseDir, "..", "..", "..", "..", ".."));

            var devCandidates = new[]
            {
                // FloatingWindow.csproj 设置了 AppendTargetFrameworkToOutputPath=false
                Path.Combine(solutionDir, "FloatingWindow", "bin", "Debug", "FloatingWindow.exe"),
                Path.Combine(solutionDir, "FloatingWindow", "bin", "Release", "FloatingWindow.exe"),
                // 兼容默认输出路径(如果未来恢复 TFM 子目录)
                Path.Combine(solutionDir, "FloatingWindow", "bin", "Debug", "net9.0-windows", "FloatingWindow.exe"),
                Path.Combine(solutionDir, "FloatingWindow", "bin", "Release", "net9.0-windows", "FloatingWindow.exe"),
            };

            foreach (var p in devCandidates)
            {
                var full = Path.GetFullPath(p);
                if (File.Exists(full))
                {
                    return full;
                }
            }

            // 发布环境路径（同目录）
            var releasePath = Path.Combine(baseDir, "FloatingWindow.exe");
            if (File.Exists(releasePath))
            {
                return releasePath;
            }

            // 发布环境路径（子目录）
            releasePath = Path.Combine(baseDir, "FloatingWindow", "FloatingWindow.exe");
            if (File.Exists(releasePath))
            {
                return releasePath;
            }

            return null;
        }

#if WINDOWS
        private const int GwlExStyle = -20;
        private const int WsExNoactivate = 0x08000000;
        private const uint SwpNosize = 0x0001;
        private const uint SwpNomove = 0x0002;
        private const uint SwpNozorder = 0x0004;
        private const uint SwpFramechanged = 0x0020;

        [DllImport("user32.dll", SetLastError = true)]
        private static extern int GetWindowLong(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetWindowPos(
            IntPtr hWnd,
            IntPtr hWndInsertAfter,
            int x,
            int y,
            int cx,
            int cy,
            uint uFlags);

        private static void SetWindowNoActivate(IntPtr hwnd, bool enable)
        {
            var exStyle = GetWindowLong(hwnd, GwlExStyle);
            if (enable)
            {
                exStyle |= WsExNoactivate;
            }
            else
            {
                exStyle &= ~WsExNoactivate;
            }

            SetWindowLong(hwnd, GwlExStyle, exStyle);
            SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, SwpNomove | SwpNosize | SwpNozorder | SwpFramechanged);
        }
#endif

        private void LogInfo(string message)
        {
            _ = message;
        }
    }
}
