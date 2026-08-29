using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;

namespace FloatingWindow
{
    public partial class MainWindow : Window
    {
        private WebSocketClient? _wsClient;
        private readonly int _parentProcessId;
        private readonly string? _floatingSessionToken;
        private readonly System.Windows.Threading.DispatcherTimer _parentWatchTimer;
        private int _commandInProgress;
        private const string FloatingTokenEnvironmentVariable = "PANELMANAGER_FLOATING_TOKEN";

        // Win32 API 导入

        [DllImport("user32.dll")]
        private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);

        [DllImport("user32.dll")]
        private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT
        {
            public int Left, Top, Right, Bottom;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
        private struct MONITORINFO
        {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public uint dwFlags;
        }

        private const uint MONITOR_DEFAULTTONEAREST = 2;
        private const int SnapThreshold = 80;
        private const int SnapMargin = 8;

        public MainWindow()
        {
            InitializeComponent();

            _parentProcessId = TryGetParentProcessId();
            _floatingSessionToken = Environment.GetEnvironmentVariable(FloatingTokenEnvironmentVariable);
            Environment.SetEnvironmentVariable(FloatingTokenEnvironmentVariable, null);
            _parentWatchTimer = new System.Windows.Threading.DispatcherTimer
            {
                Interval = TimeSpan.FromSeconds(2)
            };
            _parentWatchTimer.Tick += (_, _) => CheckParentProcessAlive();
            _parentWatchTimer.Start();

            // 初始化 WebSocket 客户端
            _wsClient = new WebSocketClient("ws://localhost:5000");
            _wsClient.OnEvent += OnWebSocketEvent;
            _wsClient.OnConnected += OnWebSocketConnected;
            _wsClient.OnDisconnected += OnWebSocketDisconnected;
            _wsClient.OnConnectionLost += OnConnectionLost;

            if (string.IsNullOrWhiteSpace(_floatingSessionToken) || _parentProcessId <= 0)
            {
                Dispatcher.BeginInvoke(() => Application.Current.Shutdown());
                return;
            }

            // 连接到主程序
            _ = ConnectToMainAppAsync();
        }

        private static int TryGetParentProcessId()
        {
            var args = Environment.GetCommandLineArgs();
            for (var i = 0; i < args.Length - 1; i++)
            {
                if (string.Equals(args[i], "--parent-pid", StringComparison.OrdinalIgnoreCase) &&
                    int.TryParse(args[i + 1], out var pid) && pid > 0)
                {
                    return pid;
                }
            }

            return 0;
        }

        private void CheckParentProcessAlive()
        {
            if (_parentProcessId <= 0)
            {
                return;
            }

            try
            {
                using var process = Process.GetProcessById(_parentProcessId);
                if (process.HasExited || !string.Equals(process.ProcessName, "PanelManager", StringComparison.OrdinalIgnoreCase))
                {
                    Application.Current.Shutdown();
                }
            }
            catch
            {
                Application.Current.Shutdown();
            }
        }

        private async Task ConnectToMainAppAsync()
        {
            // 等待主程序的 WebSocket 服务器启动
            const int maxRetries = 50;      // ~10s
            const int retryDelayMs = 200;

            for (int i = 0; i < maxRetries; i++)
            {
                if (await _wsClient!.ConnectAsync())
                {
                    return;
                }
                await Task.Delay(retryDelayMs);
            }

            // 启动时连接失败，自动退出
            Dispatcher.Invoke(() =>
            {
                Application.Current.Shutdown();
            });
        }

        private async void OnWebSocketConnected()
        {
            try
            {
                var response = await _wsClient!.SendRequestAsync(
                    "System",
                    "floatingReady",
                    new
                    {
                        token = _floatingSessionToken,
                        parentPid = _parentProcessId,
                        clientPid = Environment.ProcessId
                    },
                    5000);
                if (response != null && response.Code > 0)
                {
                    Dispatcher.Invoke(() => Application.Current.Shutdown());
                }
            }
            catch
            {
                Dispatcher.Invoke(() => Application.Current.Shutdown());
            }
        }

        private void Window_Loaded(object sender, RoutedEventArgs e)
        {
            // 加载图标
            LoadIcon();

            // 设置窗口位置到右下角
            PositionWindowBottomRight();
        }

        private void LoadIcon()
        {
            try
            {
                // 首先尝试加载用户自定义图标
                var customIconPath = GetCustomIconPath();
                if (!string.IsNullOrEmpty(customIconPath) && System.IO.File.Exists(customIconPath))
                {
                    LoadIconFromPath(customIconPath);
                    return;
                }

                // 否则加载内置的默认图标（嵌入资源）
                LoadDefaultIcon();
            }
            catch (Exception ex)
            {
                _ = ex;
            }
        }

        private void LoadDefaultIcon()
        {
            try
            {
                // 从嵌入资源加载图标
                var bitmap = new BitmapImage();
                bitmap.BeginInit();
                bitmap.UriSource = new Uri("pack://application:,,,/menu-bar.png", UriKind.Absolute);
                bitmap.CacheOption = BitmapCacheOption.OnLoad;
                bitmap.EndInit();
                IconImage.Source = bitmap;
            }
            catch (Exception ex)
            {
                _ = ex;
            }
        }

        private void LoadIconFromPath(string iconPath)
        {
            var bitmap = new BitmapImage();
            bitmap.BeginInit();
            bitmap.UriSource = new Uri(iconPath, UriKind.Absolute);
            bitmap.CacheOption = BitmapCacheOption.OnLoad;
            bitmap.EndInit();
            IconImage.Source = bitmap;
        }

        private string? GetCustomIconPath()
        {
            try
            {
                var settingsPath = System.IO.Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    "PanelManager",
                    "icon_settings.txt");

                if (System.IO.File.Exists(settingsPath))
                {
                    return System.IO.File.ReadAllText(settingsPath).Trim();
                }
            }
            catch (Exception ex)
            {
                _ = ex;
            }
            return null;
        }

        private void SaveCustomIconPath(string iconPath)
        {
            try
            {
                var settingsDir = System.IO.Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    "PanelManager");

                System.IO.Directory.CreateDirectory(settingsDir);

                var settingsPath = System.IO.Path.Combine(settingsDir, "icon_settings.txt");
                System.IO.File.WriteAllText(settingsPath, iconPath);
            }
            catch (Exception ex)
            {
                _ = ex;
            }
        }

        private void PositionWindowBottomRight()
        {
            var workingArea = SystemParameters.WorkArea;
            Left = workingArea.Right - Width - 24;
            Top = workingArea.Bottom - Height - 48;
        }

        private void FloatingBall_MouseEnter(object sender, MouseEventArgs e)
        {
            var storyboard = (Storyboard)FindResource("HoverInAnimation");
            storyboard.Begin();
        }

        private void FloatingBall_MouseLeave(object sender, MouseEventArgs e)
        {
            var storyboard = (Storyboard)FindResource("HoverOutAnimation");
            storyboard.Begin();
        }

        private void Window_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
        {
            try
            {
                DragMove();
            }
            catch
            {
                // 忽略
            }

            SnapToEdge();

            var storyboard = (Storyboard)FindResource("HoverOutAnimation");
            storyboard.Begin();
        }

        private void SnapToEdge()
        {
            var hwnd = new System.Windows.Interop.WindowInteropHelper(this).Handle;
            var hMon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);

            var mi = new MONITORINFO();
            mi.cbSize = Marshal.SizeOf<MONITORINFO>();
            if (!GetMonitorInfo(hMon, ref mi)) return;

            int winW = (int)Width;
            int winH = (int)Height;
            int winL = (int)Left;
            int winT = (int)Top;
            int winR = winL + winW;
            int winB = winT + winH;

            int leftDist = Math.Abs(winL - mi.rcWork.Left);
            int rightDist = Math.Abs(mi.rcWork.Right - winR);
            int topDist = Math.Abs(winT - mi.rcWork.Top);
            int bottomDist = Math.Abs(mi.rcWork.Bottom - winB);

            int min = Math.Min(Math.Min(leftDist, rightDist), Math.Min(topDist, bottomDist));

            if (min > SnapThreshold) return;

            if (min == leftDist)
            {
                Left = mi.rcWork.Left + SnapMargin;
            }
            else if (min == rightDist)
            {
                Left = mi.rcWork.Right - winW - SnapMargin;
            }
            else if (min == topDist)
            {
                Top = mi.rcWork.Top + SnapMargin;
            }
            else if (min == bottomDist)
            {
                Top = mi.rcWork.Bottom - winH - SnapMargin;
            }

            // 限制在工作区内
            Left = Math.Max(mi.rcWork.Left + SnapMargin, Math.Min(Left, mi.rcWork.Right - winW - SnapMargin));
            Top = Math.Max(mi.rcWork.Top + SnapMargin, Math.Min(Top, mi.rcWork.Bottom - winH - SnapMargin));
        }

        private void OnWebSocketEvent(string eventName, System.Text.Json.JsonElement data)
        {
            string? visibleTransitionId = null;
            Dispatcher.Invoke(() =>
            {
                switch (eventName)
                {
                    case "floatingShow":
                        if (data.ValueKind == System.Text.Json.JsonValueKind.Object &&
                            data.TryGetProperty("transitionId", out var transitionProperty))
                        {
                            visibleTransitionId = transitionProperty.GetString();
                        }
                        Visibility = Visibility.Visible;
                        Activate();
                        Topmost = true;
                        UpdateLayout();
                        break;
                    case "floatingHide":
                        Visibility = Visibility.Hidden;
                        break;
                    case "floatingClose":
                        Close();
                        break;
                }
            });

            if (eventName == "floatingShow" && !string.IsNullOrEmpty(visibleTransitionId))
            {
                _ = _wsClient?.SendRequestAsync(
                    "System",
                    "floatingVisible",
                    new { transitionId = visibleTransitionId, visible = true });
            }
        }

        private void OnConnectionLost()
        {
            Dispatcher.Invoke(() =>
            {
                Application.Current.Shutdown();
            });
        }

        private void OnWebSocketDisconnected()
        {
            Dispatcher.Invoke(() => Visibility = Visibility.Hidden);
        }

        private async Task SendCommandToMainAppAsync(string action)
        {
            if (Interlocked.Exchange(ref _commandInProgress, 1) != 0)
            {
                return;
            }

            try
            {
                if (_wsClient != null)
                {
                    await _wsClient.SendRequestAsync("System", action, null, 5000);
                }
            }
            finally
            {
                Interlocked.Exchange(ref _commandInProgress, 0);
            }
        }

        protected override void OnClosed(EventArgs e)
        {
            _parentWatchTimer.Stop();
            _ = _wsClient?.DisconnectAsync();
            base.OnClosed(e);
        }

        private async void Window_MouseDoubleClick(object sender, MouseButtonEventArgs e)
        {
            await SendCommandToMainAppAsync("floatingRestore");
            e.Handled = true;
        }

        // 右键菜单事件处理
        private async void MenuItem_Restore_Click(object sender, RoutedEventArgs e)
        {
            await SendCommandToMainAppAsync("floatingRestore");
        }

        private void MenuItem_ChangeIcon_Click(object sender, RoutedEventArgs e)
        {
            var openFileDialog = new Microsoft.Win32.OpenFileDialog
            {
                Title = "选择图标文件",
                Filter = "图片文件|*.png;*.jpg;*.jpeg;*.bmp;*.gif;*.ico|所有文件|*.*",
                FilterIndex = 1
            };

            if (openFileDialog.ShowDialog() == true)
            {
                try
                {
                    LoadIconFromPath(openFileDialog.FileName);
                    SaveCustomIconPath(openFileDialog.FileName);
                    MessageBox.Show("图标已更换成功！", "成功", MessageBoxButton.OK, MessageBoxImage.Information);
                }
                catch (Exception ex)
                {
                    MessageBox.Show($"更换图标失败: {ex.Message}", "错误", MessageBoxButton.OK, MessageBoxImage.Error);
                }
            }
        }

        private async void MenuItem_ExitApp_Click(object sender, RoutedEventArgs e)
        {
            var result = MessageBox.Show(
                "确定要退出整个程序吗？\n这将关闭悬浮窗和主程序。",
                "确认退出",
                MessageBoxButton.YesNo,
                MessageBoxImage.Warning);

            if (result == MessageBoxResult.Yes)
            {
                await SendCommandToMainAppAsync("floatingExitAll");
                // floatingClose 事件会由主程序发送，触发窗口关闭
            }
        }
    }
}
