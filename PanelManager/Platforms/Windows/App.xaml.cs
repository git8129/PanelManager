using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.Maui.ApplicationModel;
using System;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Threading;
using WinRT.Interop;
using Windows.Graphics;

namespace PanelManager.WinUI
{
    public partial class App : MauiWinUIApplication
    {
        private const string SingleInstanceMutexName = "Local\\PanelManager.SingleInstance";
        private static Mutex? _singleInstanceMutex;

        private static AppWindow? _appWindow;
        private static IntPtr _hwnd;
        private static Microsoft.UI.Xaml.Window? _mainWindow;
        private static WndProcDelegate? _newWndProc;
        private static IntPtr _oldWndProc;
        private static RectInt32? _restoreRectBeforeDeviceFullscreen;

        // Win32 API 导入
        private const int GWL_EXSTYLE = -20;
        private const int GWL_STYLE = -16;
        private const int WS_EX_TOOLWINDOW = 0x00000080;  // 不在任务栏显示
        private const int WS_EX_APPWINDOW = 0x00040000;   // 在任务栏显示
        private const int WS_MAXIMIZEBOX = 0x00010000;    // 最大化按钮
        private const int WM_SYSCOMMAND = 0x0112;
        private const int SC_MINIMIZE = 0xF020;
        private const int GWL_WNDPROC = -4;
        private const int SW_SHOWNORMAL = 1;
        private const int SW_RESTORE = 9;
        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_NOMOVE = 0x0002;
        private static readonly IntPtr HWND_TOPMOST = new(-1);
        private static readonly IntPtr HWND_NOTOPMOST = new(-2);

        private delegate IntPtr WndProcDelegate(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern int GetWindowLong(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

        [DllImport("user32.dll")]
        private static extern IntPtr CallWindowProc(IntPtr lpPrevWndFunc, IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool BringWindowToTop(IntPtr hWnd);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetActiveWindow(IntPtr hWnd);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern bool EnumDisplayDevices(string? lpDevice, uint iDevNum, ref DisplayDevice lpDisplayDevice, uint dwFlags);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern bool EnumDisplaySettingsEx(string lpszDeviceName, int iModeNum, ref DevMode lpDevMode, uint dwFlags);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int ChangeDisplaySettingsEx(string lpszDeviceName, ref DevMode lpDevMode, IntPtr hwnd, uint dwflags, IntPtr lParam);

        /// <summary>
        /// Initializes the singleton application object.  This is the first line of authored code
        /// executed, and as such is the logical equivalent of main() or WinMain().
        /// </summary>
        public App()
        {
            this.InitializeComponent();

            // 捕获未处理异常并写入本地日志，便于排查启动闪退。
            try { CrashLog.Install(); } catch { }
        }

        private static void EnsureSingleInstanceOrExit()
        {
            if (_singleInstanceMutex != null)
            {
                return;
            }

            bool createdNew;
            _singleInstanceMutex = new Mutex(initiallyOwned: true, name: SingleInstanceMutexName, createdNew: out createdNew);
            if (!createdNew)
            {
                Environment.Exit(0);
            }

            AppDomain.CurrentDomain.ProcessExit += (_, __) =>
            {
                try
                {
                    _singleInstanceMutex?.ReleaseMutex();
                    _singleInstanceMutex?.Dispose();
                    _singleInstanceMutex = null;
                }
                catch
                {
                    // 忽略
                }
            };
        }

        protected override MauiApp CreateMauiApp() => MauiProgram.CreateMauiApp();

        protected override void OnLaunched(LaunchActivatedEventArgs args)
        {
            try
            {
                EnsureSingleInstanceOrExit();

#if DEBUG
                // Enable WebView2 remote debugging for agent-browser / DevTools in DEBUG only.
                // Must be set before WebView2 spins up (do this before base.OnLaunched).
                const string envKey = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
                const string debugArg = "--remote-debugging-port=9222";
                var currentArgs = Environment.GetEnvironmentVariable(envKey);
                if (string.IsNullOrWhiteSpace(currentArgs))
                {
                    Environment.SetEnvironmentVariable(envKey, debugArg);
                }
                else if (!currentArgs.Contains("--remote-debugging-port", StringComparison.OrdinalIgnoreCase))
                {
                    Environment.SetEnvironmentVariable(envKey, $"{currentArgs} {debugArg}");
                }
#endif

                base.OnLaunched(args);

                var mauiApp = Microsoft.Maui.Controls.Application.Current;
                var mauiWindow = mauiApp?.Windows?.FirstOrDefault();
                var currentWindow = mauiWindow?.Handler?.PlatformView as Microsoft.UI.Xaml.Window;

                if (currentWindow != null)
                {
                    _hwnd = WindowNative.GetWindowHandle(currentWindow);
                    _mainWindow = currentWindow;
                    if (_hwnd == IntPtr.Zero)
                    {
                        try { CrashLog.Write("OnLaunched:GetWindowHandle", new InvalidOperationException("HWND is zero")); } catch { }
                        return;
                    }
                    var windowId = Win32Interop.GetWindowIdFromWindow(_hwnd);
                    _appWindow = AppWindow.GetFromWindowId(windowId);

                    // 2) 禁用最大化按钮
                    var style = GetWindowLong(_hwnd, GWL_STYLE);
                    style &= ~WS_MAXIMIZEBOX;
                    SetWindowLong(_hwnd, GWL_STYLE, style);

                    // 3) 禁用最大化/缩放
                    if (_appWindow.Presenter is OverlappedPresenter presenter)
                    {
                        presenter.IsMaximizable = false;
                        presenter.IsResizable = false;
                    }

                    // 4) 子类化窗口以拦截最小化消息
                    SubclassWindow(_hwnd);

                    EnsureWindowVisibleOnTop(currentWindow);
                }
            }
            catch (Exception ex)
            {
                try { CrashLog.Write("OnLaunched", ex); } catch { }
                throw;
            }
        }

        private static void EnsureWindowVisibleOnTop(Microsoft.UI.Xaml.Window currentWindow)
        {
            try
            {
                TryBringWindowToFront(currentWindow);
                ScheduleBringToFrontRetry(currentWindow, 120);
                ScheduleBringToFrontRetry(currentWindow, 360);
            }
            catch
            {
                // ignore
            }
        }

        private static void ScheduleBringToFrontRetry(Microsoft.UI.Xaml.Window currentWindow, int delayMs)
        {
            _ = Task.Delay(delayMs).ContinueWith(_ =>
            {
                try
                {
                    currentWindow.DispatcherQueue.TryEnqueue(() => TryBringWindowToFront(currentWindow));
                }
                catch
                {
                    // ignore
                }
            }, TaskScheduler.Default);
        }

        private static void TryBringWindowToFront(Microsoft.UI.Xaml.Window currentWindow)
        {
            _appWindow?.Show();
            currentWindow.Activate();

            if (_hwnd == IntPtr.Zero)
            {
                return;
            }

            ShowWindow(_hwnd, IsIconic(_hwnd) ? SW_RESTORE : SW_SHOWNORMAL);
            SetWindowPos(_hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
            SetWindowPos(_hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
            BringWindowToTop(_hwnd);
            SetActiveWindow(_hwnd);
            SetForegroundWindow(_hwnd);
        }

        public static void SetWindowTaskbarVisibility(bool show)
        {
            if (_hwnd == IntPtr.Zero) return;
            var exStyle = GetWindowLong(_hwnd, GWL_EXSTYLE);
            if (show)
            {
                exStyle |= WS_EX_APPWINDOW;
                exStyle &= ~WS_EX_TOOLWINDOW;
            }
            else
            {
                exStyle |= WS_EX_TOOLWINDOW;
                exStyle &= ~WS_EX_APPWINDOW;
            }
            SetWindowLong(_hwnd, GWL_EXSTYLE, exStyle);
        }

        public static async Task<DeviceScreenSwitchResult> SwitchToDeviceScreenAsync()
        {
            if (_appWindow == null || _mainWindow == null || _hwnd == IntPtr.Zero)
            {
                return DeviceScreenSwitchResult.Fail("主窗口未初始化");
            }

            try
            {
                var display = FindDevicePortraitDisplay();
                if (display == null)
                {
                    return DeviceScreenSwitchResult.Fail("未找到 1080x1920 的竖屏显示器");
                }

                var rotated = false;
                if (display.Value.Mode.dmPelsWidth < display.Value.Mode.dmPelsHeight)
                {
                    var rotateError = TryRotateDisplayToLandscape(display.Value.DeviceName, display.Value.Mode);
                    if (rotateError != null)
                    {
                        return DeviceScreenSwitchResult.Fail(rotateError);
                    }

                    rotated = true;
                    var refreshed = GetDisplayInfo(display.Value.DeviceName, display.Value.DisplayName);
                    if (refreshed == null)
                    {
                        return DeviceScreenSwitchResult.Fail("屏幕方向已切换，但无法读取新的显示器参数");
                    }

                    display = refreshed;
                }

                var target = display.Value;
                var bounds = new RectInt32(
                    target.Mode.dmPositionX,
                    target.Mode.dmPositionY,
                    (int)target.Mode.dmPelsWidth,
                    (int)target.Mode.dmPelsHeight);

                await MainThread.InvokeOnMainThreadAsync(() =>
                {
                    if (_restoreRectBeforeDeviceFullscreen == null)
                    {
                        var pos = _appWindow.Position;
                        var size = _appWindow.Size;
                        _restoreRectBeforeDeviceFullscreen = new RectInt32(pos.X, pos.Y, size.Width, size.Height);
                    }

                    if (_appWindow.Presenter?.Kind == AppWindowPresenterKind.FullScreen)
                    {
                        _appWindow.SetPresenter(AppWindowPresenterKind.Overlapped);
                    }

                    _appWindow.Show();
                    _appWindow.MoveAndResize(bounds);
                    _appWindow.SetPresenter(AppWindowPresenterKind.FullScreen);
                    SetWindowTaskbarVisibility(false);
                    _mainWindow.Activate();
                    SetForegroundWindow(_hwnd);
                });

                return DeviceScreenSwitchResult.Success(target.DisplayName, target.DeviceName, bounds.X, bounds.Y, bounds.Width, bounds.Height, rotated);
            }
            catch (Exception ex)
            {
                try { CrashLog.Write("SwitchToDeviceScreenAsync", ex); } catch { }
                return DeviceScreenSwitchResult.Fail(ex.Message);
            }
        }

        public static async Task<DeviceScreenSwitchResult> RestoreFromDeviceScreenAsync()
        {
            if (_appWindow == null || _mainWindow == null || _hwnd == IntPtr.Zero)
            {
                return DeviceScreenSwitchResult.Fail("主窗口未初始化");
            }

            try
            {
                await MainThread.InvokeOnMainThreadAsync(() =>
                {
                    if (_appWindow.Presenter?.Kind == AppWindowPresenterKind.FullScreen)
                    {
                        _appWindow.SetPresenter(AppWindowPresenterKind.Overlapped);
                    }

                    if (_restoreRectBeforeDeviceFullscreen.HasValue)
                    {
                        _appWindow.MoveAndResize(_restoreRectBeforeDeviceFullscreen.Value);
                    }

                    if (_appWindow.Presenter is OverlappedPresenter presenter)
                    {
                        presenter.SetBorderAndTitleBar(true, true);
                        presenter.IsResizable = false;
                        presenter.IsMaximizable = false;
                        presenter.IsMinimizable = true;
                    }

                    _restoreRectBeforeDeviceFullscreen = null;
                    SetWindowTaskbarVisibility(true);
                    _appWindow.Show();
                    _mainWindow.Activate();
                    SetForegroundWindow(_hwnd);
                });

                return DeviceScreenSwitchResult.Success("", "", 0, 0, 0, 0, false);
            }
            catch (Exception ex)
            {
                try { CrashLog.Write("RestoreFromDeviceScreenAsync", ex); } catch { }
                return DeviceScreenSwitchResult.Fail(ex.Message);
            }
        }

        private static DisplayInfo? FindDevicePortraitDisplay()
        {
            DisplayInfo? landscapeFallback = null;

            for (uint i = 0; ; i++)
            {
                var device = CreateDisplayDevice();
                if (!EnumDisplayDevices(null, i, ref device, 0))
                {
                    break;
                }

                if ((device.StateFlags & DisplayDeviceActive) == 0)
                {
                    continue;
                }

                var info = GetDisplayInfo(device.DeviceName, device.DeviceString);
                if (info == null)
                {
                    continue;
                }

                var mode = info.Value.Mode;
                if (mode.dmPelsWidth == 1080 && mode.dmPelsHeight == 1920)
                {
                    return info;
                }

                if (mode.dmPelsWidth == 1920 && mode.dmPelsHeight == 1080)
                {
                    landscapeFallback ??= info;
                }
            }

            return landscapeFallback;
        }

        private static DisplayInfo? GetDisplayInfo(string deviceName, string displayName)
        {
            var mode = CreateDevMode();
            if (!EnumDisplaySettingsEx(deviceName, EnumCurrentSettings, ref mode, 0))
            {
                return null;
            }

            return new DisplayInfo(deviceName, displayName, mode);
        }

        private static string? TryRotateDisplayToLandscape(string deviceName, DevMode currentMode)
        {
            var candidates = GetLandscapeOrientationCandidates(currentMode.dmDisplayOrientation);
            foreach (var orientation in candidates)
            {
                var mode = currentMode;
                mode.dmSize = (ushort)Marshal.SizeOf<DevMode>();
                mode.dmPelsWidth = 1920;
                mode.dmPelsHeight = 1080;
                mode.dmDisplayOrientation = orientation;
                mode.dmFields = DmPelsWidth | DmPelsHeight | DmDisplayOrientation | DmPosition;

                var testResult = ChangeDisplaySettingsEx(deviceName, ref mode, IntPtr.Zero, CdsTest, IntPtr.Zero);
                if (testResult != DispChangeSuccessful)
                {
                    continue;
                }

                var applyResult = ChangeDisplaySettingsEx(deviceName, ref mode, IntPtr.Zero, 0, IntPtr.Zero);
                return applyResult == DispChangeSuccessful
                    ? null
                    : $"屏幕方向切换失败，错误码 {applyResult}";
            }

            return "显示器不接受 1920x1080 横屏模式";
        }

        private static uint[] GetLandscapeOrientationCandidates(uint currentOrientation)
        {
            return currentOrientation switch
            {
                Dmdo90 => new[] { DmdoDefault, Dmdo180, Dmdo270, Dmdo90 },
                Dmdo270 => new[] { DmdoDefault, Dmdo180, Dmdo90, Dmdo270 },
                Dmdo180 => new[] { Dmdo90, Dmdo270, DmdoDefault, Dmdo180 },
                _ => new[] { Dmdo90, Dmdo270, DmdoDefault, Dmdo180 }
            };
        }

        private static DisplayDevice CreateDisplayDevice()
        {
            return new DisplayDevice { cb = Marshal.SizeOf<DisplayDevice>() };
        }

        private static DevMode CreateDevMode()
        {
            return new DevMode { dmSize = (ushort)Marshal.SizeOf<DevMode>() };
        }

        private static void SubclassWindow(IntPtr hwnd)
        {
            // 保存原始窗口过程
            _oldWndProc = GetWindowLongPtr(hwnd, GWL_WNDPROC);
            
            // 创建新的窗口过程委托（需要保持引用防止GC）
            _newWndProc = new WndProcDelegate(NewWndProc);
            
            // 设置新的窗口过程
            SetWindowLongPtr(hwnd, GWL_WNDPROC, Marshal.GetFunctionPointerForDelegate(_newWndProc));
        }

        private static IntPtr NewWndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
        {
            // 拦截系统命令
            if (msg == WM_SYSCOMMAND)
            {
                var command = wParam.ToInt32() & 0xFFF0;
                
                // 拦截最小化命令
                if (command == SC_MINIMIZE)
                {
                    // 异步调用显示悬浮窗
                    _ = ShowFloatingWindowAsync();
                    
                    // 返回0表示已处理，不执行默认最小化
                    return IntPtr.Zero;
                }
            }

            // 调用原始窗口过程处理其他消息
            return CallWindowProc(_oldWndProc, hWnd, msg, wParam, lParam);
        }

        private static async Task ShowFloatingWindowAsync()
        {
            try
            {
                // 获取 FloatingWindowManager 服务
                var services = Microsoft.Maui.Controls.Application.Current?.Handler?.MauiContext?.Services;
                var floatingManager = services?.GetService<PanelManager.Services.FloatingWindowManager>();

                if (floatingManager != null)
                {
                    var result = await floatingManager.EnterFloatingAsync();
                    if (!result)
                    {
                        try { CrashLog.Write("ShowFloatingWindowAsync:EnterFloatingAsync", new InvalidOperationException("EnterFloatingAsync returned false")); } catch { }
                    }
                }
            }
            catch (Exception ex)
            {
                try { CrashLog.Write("ShowFloatingWindowAsync", ex); } catch { }
            }
        }

        private const int EnumCurrentSettings = -1;
        private const int DisplayDeviceActive = 0x00000001;
        private const int DispChangeSuccessful = 0;
        private const uint CdsTest = 0x00000002;
        private const uint DmPosition = 0x00000020;
        private const uint DmPelsWidth = 0x00080000;
        private const uint DmPelsHeight = 0x00100000;
        private const uint DmDisplayOrientation = 0x00000080;
        private const uint DmdoDefault = 0;
        private const uint Dmdo90 = 1;
        private const uint Dmdo180 = 2;
        private const uint Dmdo270 = 3;

        private readonly record struct DisplayInfo(string DeviceName, string DisplayName, DevMode Mode);

        public sealed class DeviceScreenSwitchResult
        {
            public bool Ok { get; init; }
            public string? Error { get; init; }
            public string? DisplayName { get; init; }
            public string? DeviceName { get; init; }
            public int X { get; init; }
            public int Y { get; init; }
            public int Width { get; init; }
            public int Height { get; init; }
            public bool Rotated { get; init; }

            public static DeviceScreenSwitchResult Success(string displayName, string deviceName, int x, int y, int width, int height, bool rotated) => new()
            {
                Ok = true,
                DisplayName = displayName,
                DeviceName = deviceName,
                X = x,
                Y = y,
                Width = width,
                Height = height,
                Rotated = rotated
            };

            public static DeviceScreenSwitchResult Fail(string error) => new() { Ok = false, Error = error };
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct DisplayDevice
        {
            public int cb;

            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
            public string DeviceName;

            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
            public string DeviceString;

            public int StateFlags;

            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
            public string DeviceID;

            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
            public string DeviceKey;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct DevMode
        {
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
            public string dmDeviceName;
            public ushort dmSpecVersion;
            public ushort dmDriverVersion;
            public ushort dmSize;
            public ushort dmDriverExtra;
            public uint dmFields;
            public int dmPositionX;
            public int dmPositionY;
            public uint dmDisplayOrientation;
            public uint dmDisplayFixedOutput;
            public short dmColor;
            public short dmDuplex;
            public short dmYResolution;
            public short dmTTOption;
            public short dmCollate;

            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
            public string dmFormName;
            public ushort dmLogPixels;
            public uint dmBitsPerPel;
            public uint dmPelsWidth;
            public uint dmPelsHeight;
            public uint dmDisplayFlags;
            public uint dmDisplayFrequency;
            public uint dmICMMethod;
            public uint dmICMIntent;
            public uint dmMediaType;
            public uint dmDitherType;
            public uint dmReserved1;
            public uint dmReserved2;
            public uint dmPanningWidth;
            public uint dmPanningHeight;
        }
    }
}

