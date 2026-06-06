using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
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
        private bool _isFloating;
        private Process? _floatingWindowProcess;

        private void HandleWsClientConnected()
        {
            // 悬浮窗进程可能在 show 广播之后才连上 WS；这里在新客户端连接时补发一次 show
            if (_isFloating)
            {
                _bridge?.BroadcastEvent(Module.System, "floatingShow", null);
            }
        }

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
                _bridge.OnWebSocketClientConnected -= HandleWsClientConnected;
            }

            _bridge = bridge;
            _bridge.OnWebSocketClientConnected += HandleWsClientConnected;
        }

        public void AttachMainWindow(object? window, object? appWindow)
        {
#if WINDOWS
            _mainWindow = window as WinUIWindow;
            _mainAppWindow = appWindow as AppWindow;
#endif
        }

        public bool IsFloating => _isFloating;

        /// <summary>
        /// 初始化 WPF 悬浮窗进程（后台运行，不显示），在主窗加载后调用。
        /// </summary>
        public async Task<bool> InitializeFloatingWindowProcessAsync()
        {
#if WINDOWS
            if (_floatingWindowProcess != null)
            {
                LogInfo("Floating window process already initialized");
                return true;
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
                _floatingWindowProcess = new Process
                {
                    StartInfo = new ProcessStartInfo
                    {
                        FileName = exePath,
                        Arguments = $"--parent-pid {Environment.ProcessId}",
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        WorkingDirectory = Path.GetDirectoryName(exePath),
                        WindowStyle = ProcessWindowStyle.Hidden
                    }
                };

                _floatingWindowProcess.Start();
                LogInfo($"Floating window process started (PID: {_floatingWindowProcess.Id})");

                // 等待进程启动
                await Task.Delay(1000);
                return true;
            }
            catch (Exception ex)
            {
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
            if (_isFloating)
            {
                LogInfo("Already in floating mode");
                return true;
            }

            if (_mainWindow == null || _mainAppWindow == null)
            {
                LogInfo("Main window not initialized");
                return false;
            }

            // 确保悬浮窗进程已启动
            if (_floatingWindowProcess == null || _floatingWindowProcess.HasExited)
            {
                var initialized = await InitializeFloatingWindowProcessAsync();
                if (!initialized)
                {
                    return false;
                }
            }

            // 隐藏主窗口
            await MainThread.InvokeOnMainThreadAsync(() =>
            {
                _mainAppWindow.Hide();
            });

            // 通过 WebSocket 广播事件显示悬浮窗
            _bridge?.BroadcastEvent(Module.System, "floatingShow", null);

            _isFloating = true;
            LogInfo("Entered floating mode");
            return true;
#else
            await Task.Delay(0);
            return false;
#endif
        }

        public async Task<bool> RestoreFromFloatingAsync()
        {
#if WINDOWS
            if (_mainAppWindow == null || _mainWindow == null)
            {
                LogInfo($"Restore ignored: mainAppWindow or mainWindow is null");
                return false;
            }

            string mode = "1080p";

            await MainThread.InvokeOnMainThreadAsync(() =>
            {
                var displayArea = DisplayArea.Primary;
                var workArea = displayArea.WorkArea;

                _mainAppWindow.Show();
                _mainWindow.Activate();
            });

            // 通过 WebSocket 广播事件隐藏悬浮窗
            _bridge?.BroadcastEvent(Module.System, "floatingHide", null);

            _isFloating = false;
            _bridge?.BroadcastEvent(Module.System, "floatingRestored", new { mode });
            LogInfo($"Restored from floating mode ({mode})");

            return true;
#else
            await Task.Delay(0);
            return false;
#endif
        }

        /// <summary>
        /// 清理资源
        /// </summary>
        public void Dispose()
        {
            try
            {
                // 通知悬浮窗关闭
                _bridge?.BroadcastEvent(Module.System, "floatingClose", null);

                // 等待一会儿让悬浮窗处理关闭
                Task.Delay(500).Wait();

                if (_floatingWindowProcess != null && !_floatingWindowProcess.HasExited)
                {
                    _floatingWindowProcess.Kill();
                    _floatingWindowProcess.Dispose();
                    _floatingWindowProcess = null;
                }

                LogInfo("Floating window process stopped");
            }
            catch (Exception ex)
            {
                LogInfo($"Error stopping floating window process: {ex.Message}");
            }
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
