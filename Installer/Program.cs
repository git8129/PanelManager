using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;

namespace PanelManager.Installer;

internal sealed class InstallerState
{
    public required InstallerText Text { get; init; }
    public required bool UninstallMode { get; init; }
    public required IntPtr Hwnd { get; init; }
    public IntPtr PathTextBox { get; set; }
    public IntPtr BrowseButton { get; set; }
    public IntPtr DesktopShortcutCheck { get; set; }
    public IntPtr StartAfterCheck { get; set; }
    public IntPtr PrimaryButton { get; set; }
    public IntPtr ProgressBar { get; set; }
    public IntPtr StatusLabel { get; set; }
    public IntPtr ButtonPanel { get; set; }
    public bool Busy { get; set; }
    public bool IsDarkMode { get; set; }
    public IntPtr BackgroundBrush { get; set; }
    public IntPtr PanelBrush { get; set; }
    public List<IntPtr> Fonts { get; } = new();
}

internal sealed class InstallerText
{
    public string WindowTitleInstall { get; init; } = "";
    public string WindowTitleUninstall { get; init; } = "";
    public string UninstallPrompt { get; init; } = "";
    public string InstallTo { get; init; } = "";
    public string Browse { get; init; } = "";
    public string CreateDesktopShortcut { get; init; } = "";
    public string StartAfterInstall { get; init; } = "";
    public string Ready { get; init; } = "";
    public string Install { get; init; } = "";
    public string Uninstall { get; init; } = "";
    public string ChooseInstallFolder { get; init; } = "";
    public string InstallComplete { get; init; } = "";
    public string UninstallComplete { get; init; } = "";
    public string InstallCompleteMessage { get; init; } = "";
    public string UninstallCompleteMessage { get; init; } = "";
    public string Failed { get; init; } = "";
    public string InstallPathEmpty { get; init; } = "";
    public string StoppingApplication { get; init; } = "";
    public string RunningAppPrompt { get; init; } = "";
    public string ExtractingFiles { get; init; } = "";
    public string CreatingShortcuts { get; init; } = "";
    public string RegisteringUninstallEntry { get; init; } = "";
    public string RemovingShortcuts { get; init; } = "";
    public string RemovingUninstallEntry { get; init; } = "";
    public string SchedulingCleanup { get; init; } = "";
    public string Done { get; init; } = "";

    public static InstallerText Create()
    {
        var culture = CultureInfo.CurrentUICulture.Name;
        return culture.StartsWith("zh", StringComparison.OrdinalIgnoreCase) ? ZhCn() : En();
    }

    private static InstallerText ZhCn() => new()
    {
        WindowTitleInstall = "PanelManager 安装程序",
        WindowTitleUninstall = "PanelManager 卸载程序",
        UninstallPrompt = "您确定要卸载 PanelManager 及其所有组件吗？",
        InstallTo = "安装到：",
        Browse = "浏览...",
        CreateDesktopShortcut = "创建桌面快捷方式",
        StartAfterInstall = "安装完成后启动 PanelManager",
        Ready = "准备就绪。",
        Install = "安装",
        Uninstall = "卸载",
        ChooseInstallFolder = "选择 PanelManager 安装文件夹",
        InstallComplete = "安装完成。",
        UninstallComplete = "卸载完成。",
        InstallCompleteMessage = "PanelManager 已安装完成。",
        UninstallCompleteMessage = "PanelManager 已卸载完成。",
        Failed = "失败。",
        InstallPathEmpty = "安装路径为空。",
        StoppingApplication = "正在停止运行中的程序...",
        RunningAppPrompt = "检测到 PanelManager 正在运行。是否强制关闭后继续？",
        ExtractingFiles = "正在解压文件...",
        CreatingShortcuts = "正在创建快捷方式...",
        RegisteringUninstallEntry = "正在注册卸载入口...",
        RemovingShortcuts = "正在移除快捷方式...",
        RemovingUninstallEntry = "正在移除卸载入口...",
        SchedulingCleanup = "正在安排文件清理...",
        Done = "完成。",
    };

    private static InstallerText En() => new()
    {
        WindowTitleInstall = "PanelManager Setup",
        WindowTitleUninstall = "PanelManager Uninstall",
        UninstallPrompt = "Are you sure you want to completely remove PanelManager?",
        InstallTo = "Install to:",
        Browse = "Browse...",
        CreateDesktopShortcut = "Create desktop shortcut",
        StartAfterInstall = "Start PanelManager after installation",
        Ready = "Ready.",
        Install = "Install",
        Uninstall = "Uninstall",
        ChooseInstallFolder = "Choose PanelManager install folder",
        InstallComplete = "Install complete.",
        UninstallComplete = "Uninstall complete.",
        InstallCompleteMessage = "PanelManager has been installed.",
        UninstallCompleteMessage = "PanelManager has been uninstalled.",
        Failed = "Failed.",
        InstallPathEmpty = "Install path is empty.",
        StoppingApplication = "Stopping running application...",
        RunningAppPrompt = "PanelManager is running. Force close it and continue?",
        ExtractingFiles = "Extracting files...",
        CreatingShortcuts = "Creating shortcuts...",
        RegisteringUninstallEntry = "Registering uninstall entry...",
        RemovingShortcuts = "Removing shortcuts...",
        RemovingUninstallEntry = "Removing uninstall entry...",
        SchedulingCleanup = "Scheduling file cleanup...",
        Done = "Done.",
    };
}

internal static class Program
{
    private const string AppName = "PanelManager";
    private const string AppExeName = "PanelManager.exe";
    private const string FloatingWindowExeName = "FloatingWindow.exe";
    private const string UninstallerExeName = "PanelManagerUninstall.exe";
    private const string PayloadResourceName = "payload.7z";
    private const string SevenZipResourceName = "7zr.exe";
    private const string UninstallRegKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\PanelManager";
    private const string WindowClassName = "PanelManagerInstallerClass";

    private const int WM_APP_PROGRESS = 0x8001;
    private const int WM_APP_COMPLETE = 0x8002;

    [SupportedOSPlatform("windows")]
    [STAThread]
    private static void Main(string[] args)
    {
        var uninstallMode = args.Any(a => string.Equals(a, "/uninstall", StringComparison.OrdinalIgnoreCase));
        var text = InstallerText.Create();

        var hInstance = Win32.GetModuleHandle(null);
        var classNamePtr = Marshal.StringToHGlobalUni(WindowClassName);
        var iconLarge = LoadAppIcon(hInstance, Win32.GetSystemMetrics(Win32.SM_CXICON), Win32.GetSystemMetrics(Win32.SM_CYICON));
        var iconSmall = LoadAppIcon(hInstance, Win32.GetSystemMetrics(Win32.SM_CXSMICON), Win32.GetSystemMetrics(Win32.SM_CYSMICON));

        var isDarkMode = IsSystemDarkMode();
        var bgBrush = isDarkMode ? Win32.CreateSolidBrush(0x00202020) : (IntPtr)(Win32.COLOR_WINDOW + 1);
        var panelBrush = isDarkMode ? Win32.CreateSolidBrush(0x002D2D2D) : Win32.CreateSolidBrush(0x00F0F0F0);

        var wc = new Win32.WNDCLASSEX
        {
            cbSize = (uint)Marshal.SizeOf<Win32.WNDCLASSEX>(),
            lpfnWndProc = Win32.WndProc,
            hInstance = hInstance,
            hIcon = iconLarge,
            hCursor = Win32.LoadCursor(IntPtr.Zero, (IntPtr)32512),
            hbrBackground = bgBrush,
            lpszClassName = classNamePtr,
            hIconSm = iconSmall,
        };

        Win32.RegisterClassEx(ref wc);
        Marshal.FreeHGlobal(classNamePtr);

        var title = uninstallMode ? text.WindowTitleUninstall : text.WindowTitleInstall;

        var hwnd = Win32.CreateWindowEx(
            0,
            WindowClassName,
            title,
            Win32.WS_OVERLAPPED | Win32.WS_CAPTION | Win32.WS_SYSMENU | Win32.WS_MINIMIZEBOX,
            Win32.CW_USEDEFAULT, Win32.CW_USEDEFAULT,
            600, uninstallMode ? 302 : 436,
            IntPtr.Zero, IntPtr.Zero, hInstance, IntPtr.Zero);

        if (isDarkMode)
        {
            int trueValue = 1;
            Win32.DwmSetWindowAttribute(hwnd, Win32.DWMWA_USE_IMMERSIVE_DARK_MODE, ref trueValue, sizeof(int));
        }
        int cornerPref = Win32.DWMWCP_ROUND;
        Win32.DwmSetWindowAttribute(hwnd, Win32.DWMWA_WINDOW_CORNER_PREFERENCE, ref cornerPref, sizeof(int));

        Win32.SendMessage(hwnd, Win32.WM_SETICON, (IntPtr)Win32.ICON_BIG, iconLarge);
        Win32.SendMessage(hwnd, Win32.WM_SETICON, (IntPtr)Win32.ICON_SMALL, iconSmall);

        var state = new InstallerState
        {
            Text = text,
            UninstallMode = uninstallMode,
            Hwnd = hwnd,
            IsDarkMode = isDarkMode,
            BackgroundBrush = isDarkMode ? bgBrush : Win32.GetSysColorBrush(Win32.COLOR_WINDOW),
            PanelBrush = panelBrush,
        };

        Win32.SetWindowLongPtr(hwnd, Win32.GWLP_USERDATA, GCHandle.ToIntPtr(GCHandle.Alloc(state)));

        BuildUi(state);

        CenterWindow(hwnd);
        Win32.ShowWindow(hwnd, Win32.SW_SHOW);
        Win32.UpdateWindow(hwnd);

        while (Win32.GetMessage(out var msg, IntPtr.Zero, 0, 0) > 0)
        {
            Win32.TranslateMessage(ref msg);
            Win32.DispatchMessage(ref msg);
        }

        foreach (var font in state.Fonts)
        {
            Win32.DeleteObject(font);
        }
        if (isDarkMode) Win32.DeleteObject(bgBrush);
        Win32.DeleteObject(panelBrush);
    }

    private static bool IsSystemDarkMode()
    {
        try
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            var value = key?.GetValue("AppsUseLightTheme");
            return value is int i && i == 0;
        }
        catch { return false; }
    }

    private static void CenterWindow(IntPtr hwnd)
    {
        Win32.RECT rect;
        Win32.GetWindowRect(hwnd, out rect);
        var w = rect.right - rect.left;
        var h = rect.bottom - rect.top;

        var screenW = Win32.GetSystemMetrics(0);
        var screenH = Win32.GetSystemMetrics(1);

        var x = (screenW - w) / 2;
        var y = (screenH - h) / 2;

        Win32.SetWindowPos(hwnd, IntPtr.Zero, x, y, 0, 0, Win32.SWP_NOSIZE | Win32.SWP_NOZORDER);
    }

    private static IntPtr LoadAppIcon(IntPtr hInstance, int width, int height)
    {
        var icon = Win32.LoadImage(hInstance, (IntPtr)Win32.IDI_APPLICATION, Win32.IMAGE_ICON, width, height, Win32.LR_DEFAULTCOLOR);
        if (icon != IntPtr.Zero)
        {
            return icon;
        }

        icon = Win32.LoadIcon(hInstance, (IntPtr)Win32.IDI_APPLICATION);
        return icon != IntPtr.Zero ? icon : Win32.LoadIcon(IntPtr.Zero, (IntPtr)Win32.IDI_APPLICATION);
    }

    private static void BuildUi(InstallerState state)
    {
        var hwnd = state.Hwnd;
        var text = state.Text;
        var uninstallMode = state.UninstallMode;

        var titleText = uninstallMode ? text.WindowTitleUninstall : text.WindowTitleInstall;

        Win32.CreateWindowEx(
            0, "STATIC", null,
            Win32.WS_CHILD | Win32.WS_VISIBLE | Win32.SS_ICON,
            36, 32, 64, 64,
            hwnd, IntPtr.Zero, Win32.GetModuleHandle(null), IntPtr.Zero);
        
        var iconHandle = LoadAppIcon(Win32.GetModuleHandle(null), 64, 64);
        var iconControl = Win32.FindWindowEx(hwnd, IntPtr.Zero, "STATIC", null); // Gets the first static control (the icon)
        Win32.SendMessage(iconControl, Win32.STM_SETICON, iconHandle, IntPtr.Zero);

        if (uninstallMode)
        {
            CreateLabel(hwnd, text.UninstallPrompt, 116, 52, 440, 24, 11f, false, state);
        }
        else
        {
            CreateLabel(hwnd, text.InstallTo, 36, 112, 120, 20, 10f, false, state);

            state.PathTextBox = Win32.CreateWindowEx(
                Win32.WS_EX_CLIENTEDGE,
                "EDIT",
                GetDefaultInstallDir(),
                Win32.WS_CHILD | Win32.WS_VISIBLE | Win32.ES_AUTOHSCROLL,
                36, 138,
                412, 26,
                hwnd, IntPtr.Zero, Win32.GetModuleHandle(null), IntPtr.Zero);

            var editFont = Win32.CreateFontW(-14, 0, 0, 0, 400, 0, 0, 0, Win32.DEFAULT_CHARSET, 0, 0, 5, 0, "Segoe UI");
            state.Fonts.Add(editFont);
            Win32.SendMessage(state.PathTextBox, Win32.WM_SETFONT, editFont, 1);

            state.BrowseButton = CreateButton(hwnd, text.Browse, 458, 136, 90, 30, state);
            state.DesktopShortcutCheck = CreateCheckBox(hwnd, text.CreateDesktopShortcut, 36, 180, 240, state);
            state.StartAfterCheck = CreateCheckBox(hwnd, text.StartAfterInstall, 36, 210, 260, state);
            Win32.SendMessage(state.DesktopShortcutCheck, Win32.BM_SETCHECK, Win32.BST_CHECKED, 0);
            Win32.SendMessage(state.StartAfterCheck, Win32.BM_SETCHECK, Win32.BST_CHECKED, 0);
        }

        var progressY = uninstallMode ? 128 : 260;
        state.ProgressBar = Win32.CreateWindowEx(
            0, "msctls_progress32", null,
            Win32.WS_CHILD | Win32.WS_VISIBLE | Win32.PBS_SMOOTH,
            36, progressY, 512, 24,
            hwnd, IntPtr.Zero, Win32.GetModuleHandle(null), IntPtr.Zero);

        var statusY = uninstallMode ? 160 : 292;
        state.StatusLabel = CreateLabel(hwnd, text.Ready, 36, statusY, 512, 20, 9.5f, false, state);

        var buttonPanelY = uninstallMode ? 196 : 328;
        state.ButtonPanel = Win32.CreateWindowEx(
            0, "STATIC", null,
            Win32.WS_CHILD | Win32.WS_VISIBLE,
            0, buttonPanelY, 600, 66,
            hwnd, IntPtr.Zero, Win32.GetModuleHandle(null), IntPtr.Zero);

        state.PrimaryButton = CreateButton(hwnd, uninstallMode ? text.Uninstall : text.Install, 436, buttonPanelY + 16, 112, 34, state);
    }

    private static IntPtr CreateLabel(IntPtr parent, string text, int x, int y, int w, int h, float fontSize, bool bold, InstallerState state)
    {
        var hwnd = Win32.CreateWindowEx(
            0, "STATIC", text,
            Win32.WS_CHILD | Win32.WS_VISIBLE | Win32.SS_LEFT,
            x, y, w, h,
            parent, IntPtr.Zero, Win32.GetModuleHandle(null), IntPtr.Zero);

        var hFont = Win32.CreateFontW(
            (int)Math.Round(-fontSize * 96f / 72f), 0, 0, 0,
            bold ? 700 : 400, 0, 0, 0,
            Win32.DEFAULT_CHARSET, 0, 0, 5, 0, "Segoe UI");
        state.Fonts.Add(hFont);

        Win32.SendMessage(hwnd, Win32.WM_SETFONT, hFont, 1);
        return hwnd;
    }

    private static IntPtr CreateButton(IntPtr parent, string text, int x, int y, int w, int h, InstallerState state)
    {
        var hwnd = Win32.CreateWindowEx(
            0, "BUTTON", text,
            Win32.WS_CHILD | Win32.WS_VISIBLE | Win32.BS_PUSHBUTTON,
            x, y, w, h,
            parent, IntPtr.Zero, Win32.GetModuleHandle(null), IntPtr.Zero);

        var btnFont = Win32.CreateFontW(-14, 0, 0, 0, 400, 0, 0, 0, Win32.DEFAULT_CHARSET, 0, 0, 5, 0, "Segoe UI");
        state.Fonts.Add(btnFont);
        Win32.SendMessage(hwnd, Win32.WM_SETFONT, btnFont, 1);

        return hwnd;
    }

    private static IntPtr CreateCheckBox(IntPtr parent, string text, int x, int y, int w, InstallerState state)
    {
        var hwnd = Win32.CreateWindowEx(
            0, "BUTTON", text,
            Win32.WS_CHILD | Win32.WS_VISIBLE | Win32.BS_AUTOCHECKBOX,
            x, y, w, 22,
            parent, IntPtr.Zero, Win32.GetModuleHandle(null), IntPtr.Zero);

        var chkFont = Win32.CreateFontW(-14, 0, 0, 0, 400, 0, 0, 0, Win32.DEFAULT_CHARSET, 0, 0, 5, 0, "Segoe UI");
        state.Fonts.Add(chkFont);
        Win32.SendMessage(hwnd, Win32.WM_SETFONT, chkFont, 1);

        return hwnd;
    }

    private static void CreateSeparator(IntPtr parent, int x, int y, int w)
    {
        Win32.CreateWindowEx(
            0, "STATIC", null,
            Win32.WS_CHILD | Win32.WS_VISIBLE | Win32.SS_ETCHEDHORZ,
            x, y, w, 2,
            parent, IntPtr.Zero, Win32.GetModuleHandle(null), IntPtr.Zero);
    }

    private static string GetDefaultInstallDir()
    {
        using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(UninstallRegKey);
        var installedPath = key?.GetValue("InstallLocation") as string;
        if (!string.IsNullOrWhiteSpace(installedPath))
        {
            return installedPath;
        }

        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", AppName);
    }

    internal static void OnBrowse(InstallerState state)
    {
        var bi = new Win32.BROWSEINFO
        {
            hwndOwner = state.Hwnd,
            lpszTitle = state.Text.ChooseInstallFolder,
            ulFlags = 0x00000040 | 0x00000008,
        };

        var pidl = Win32.SHBrowseForFolder(ref bi);
        if (pidl != IntPtr.Zero)
        {
            var path = new StringBuilder(260);
            if (Win32.SHGetPathFromIDList(pidl, path))
            {
                Win32.SetWindowText(state.PathTextBox, path.ToString());
            }
            Win32.CoTaskMemFree(pidl);
        }
    }

    internal static void OnPrimaryClick(InstallerState state)
    {
        if (state.Busy) return;

        string installDir;
        if (state.UninstallMode)
        {
            installDir = GetDefaultInstallDir();
        }
        else
        {
            var pathBuffer = new StringBuilder(260);
            Win32.SendMessage(state.PathTextBox, 0x000D, (IntPtr)260, pathBuffer);
            installDir = pathBuffer.ToString().Trim();
        }

        if (string.IsNullOrWhiteSpace(installDir))
        {
            Win32.MessageBox(state.Hwnd, state.Text.InstallPathEmpty, state.Text.Failed, 0x00000010);
            return;
        }

        if (HasRunningAppProcesses())
        {
            var caption = state.UninstallMode ? state.Text.WindowTitleUninstall : state.Text.WindowTitleInstall;
            var result = Win32.MessageBox(state.Hwnd, state.Text.RunningAppPrompt, caption, Win32.MB_ICONQUESTION | Win32.MB_YESNO);
            if (result != Win32.IDYES)
            {
                return;
            }
        }

        SetBusy(state, true);

        Task.Run(() =>
        {
            try
            {
                if (state.UninstallMode)
                {
                    DoUninstall(installDir, state);
                }
                else
                {
                    DoInstall(installDir, state);
                }

                Win32.PostMessage(state.Hwnd, WM_APP_COMPLETE, IntPtr.Zero, IntPtr.Zero);
            }
            catch (Exception ex)
            {
                Win32.PostMessage(state.Hwnd, WM_APP_COMPLETE, (IntPtr)1, Marshal.StringToHGlobalUni(ex.Message));
            }
        });
    }

    internal static void OnComplete(InstallerState state, IntPtr wParam, IntPtr lParam)
    {
        var isError = wParam.ToInt32() != 0;

        if (isError)
        {
            var errorMsg = Marshal.PtrToStringUni(lParam) ?? "Unknown error";
            Marshal.FreeHGlobal(lParam);

            SetStatusText(state, state.Text.Failed);
            Win32.MessageBox(state.Hwnd, errorMsg, state.UninstallMode ? state.Text.WindowTitleUninstall : state.Text.WindowTitleInstall, 0x00000010);
            SetBusy(state, false);
            return;
        }

        if (state.UninstallMode)
        {
            SetStatusText(state, state.Text.UninstallComplete);
            Win32.MessageBox(state.Hwnd, state.Text.UninstallCompleteMessage, state.Text.WindowTitleUninstall, 0x00000040);
        }
        else
        {
            SetStatusText(state, state.Text.InstallComplete);
            Win32.MessageBox(state.Hwnd, state.Text.InstallCompleteMessage, state.Text.WindowTitleInstall, 0x00000040);

            var startChecked = Win32.SendMessage(state.StartAfterCheck, 0x00F0, IntPtr.Zero, IntPtr.Zero).ToInt32();
            if (startChecked == Win32.BST_CHECKED)
            {
                var pathBuffer = new StringBuilder(260);
                Win32.SendMessage(state.PathTextBox, 0x000D, (IntPtr)260, pathBuffer);
                var installDir = pathBuffer.ToString().Trim();
                var appExe = Path.Combine(installDir, AppExeName);

                try
                {
                    Process.Start(new ProcessStartInfo(appExe)
                    {
                        WorkingDirectory = installDir,
                        UseShellExecute = true,
                    });
                }
                catch
                {
                }
            }
        }

        Win32.DestroyWindow(state.Hwnd);
        Win32.PostQuitMessage(0);
    }

    internal static void OnProgress(InstallerState state, IntPtr wParam, IntPtr lParam)
    {
        var value = wParam.ToInt32();
        var msgPtr = lParam;
        var message = msgPtr != IntPtr.Zero ? Marshal.PtrToStringUni(msgPtr) ?? "" : "";

        Win32.SendMessage(state.ProgressBar, Win32.PBM_SETPOS, (IntPtr)Math.Clamp(value, 0, 100), IntPtr.Zero);
        if (!string.IsNullOrEmpty(message))
        {
            SetStatusText(state, message);
        }
    }

    private static void DoInstall(string installDir, InstallerState state)
    {
        PostProgress(state, 10, state.Text.StoppingApplication);
        StopAppProcesses();

        PostProgress(state, 25, state.Text.ExtractingFiles);
        Directory.CreateDirectory(installDir);
        ExtractPayload(installDir);

        PostProgress(state, 65, state.Text.CreatingShortcuts);
        var appExe = Path.Combine(installDir, AppExeName);
        var uninstallerExe = Path.Combine(installDir, UninstallerExeName);
        var currentExe = Environment.ProcessPath ?? AppContext.BaseDirectory + "PanelManagerSetup.exe";
        File.Copy(currentExe, uninstallerExe, overwrite: true);

        CreateShortcut(GetStartMenuShortcutPath(), appExe, installDir, appExe);

        var desktopChecked = Win32.SendMessage(state.DesktopShortcutCheck, 0x00F0, IntPtr.Zero, IntPtr.Zero).ToInt32();
        if (desktopChecked == Win32.BST_CHECKED)
        {
            CreateShortcut(GetDesktopShortcutPath(), appExe, installDir, appExe);
        }

        PostProgress(state, 82, state.Text.RegisteringUninstallEntry);
        RegisterUninstallEntry(installDir, appExe, uninstallerExe);

        PostProgress(state, 100, state.Text.Done);
    }

    private static void DoUninstall(string installDir, InstallerState state)
    {
        PostProgress(state, 15, state.Text.StoppingApplication);
        StopAppProcesses();

        PostProgress(state, 40, state.Text.RemovingShortcuts);
        TryDeleteFile(GetStartMenuShortcutPath());
        TryDeleteFile(GetDesktopShortcutPath());

        PostProgress(state, 60, state.Text.RemovingUninstallEntry);
        Microsoft.Win32.Registry.CurrentUser.DeleteSubKey(UninstallRegKey, throwOnMissingSubKey: false);

        PostProgress(state, 85, state.Text.SchedulingCleanup);
        ScheduleDirectoryRemoval(installDir);

        PostProgress(state, 100, state.Text.Done);
    }

    private static void PostProgress(InstallerState state, int value, string message)
    {
        var msgPtr = Marshal.StringToHGlobalUni(message);
        Win32.PostMessage(state.Hwnd, WM_APP_PROGRESS, (IntPtr)value, msgPtr);
        Thread.Sleep(50);
    }

    private static void SetStatusText(InstallerState state, string text)
    {
        Win32.SetWindowText(state.StatusLabel, text);
    }

    private static void SetBusy(InstallerState state, bool busy)
    {
        state.Busy = busy;
        Win32.EnableWindow(state.PrimaryButton, !busy);
        Win32.EnableWindow(state.PathTextBox, !busy && !state.UninstallMode);

        if (state.DesktopShortcutCheck != IntPtr.Zero)
        {
            Win32.EnableWindow(state.DesktopShortcutCheck, !busy && !state.UninstallMode);
        }
        if (state.StartAfterCheck != IntPtr.Zero)
        {
            Win32.EnableWindow(state.StartAfterCheck, !busy && !state.UninstallMode);
        }
    }

    private static void ExtractPayload(string installDir)
    {
        var tempDir = Path.Combine(Path.GetTempPath(), "PanelManagerInstaller-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDir);

        try
        {
            var payloadPath = Path.Combine(tempDir, PayloadResourceName);
            var sevenZipPath = Path.Combine(tempDir, SevenZipResourceName);

            ExtractEmbeddedResource(PayloadResourceName, payloadPath);
            ExtractEmbeddedResource(SevenZipResourceName, sevenZipPath);
            ClearReadOnlyAttributes(installDir);

            var startInfo = new ProcessStartInfo(sevenZipPath)
            {
                WorkingDirectory = tempDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            startInfo.ArgumentList.Add("x");
            startInfo.ArgumentList.Add(payloadPath);
            startInfo.ArgumentList.Add("-o" + installDir);
            startInfo.ArgumentList.Add("-y");
            startInfo.ArgumentList.Add("-bd");
            startInfo.ArgumentList.Add("-bb0");

            using var process = Process.Start(startInfo)
                ?? throw new InvalidOperationException("Failed to start embedded 7-Zip extractor.");
            var outputTask = process.StandardOutput.ReadToEndAsync();
            var errorTask = process.StandardError.ReadToEndAsync();
            process.WaitForExit();

            if (process.ExitCode != 0)
            {
                var output = outputTask.GetAwaiter().GetResult();
                var error = errorTask.GetAwaiter().GetResult();
                var details = string.IsNullOrWhiteSpace(error) ? output : error;
                throw new InvalidOperationException("7-Zip payload extraction failed." + Environment.NewLine + details.Trim());
            }
        }
        finally
        {
            TryDeleteDirectory(tempDir);
        }
    }

    private static void ExtractEmbeddedResource(string resourceName, string destinationPath)
    {
        using var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName)
            ?? throw new InvalidOperationException($"Installer resource is missing: {resourceName}. Rebuild the installer package.");
        using var file = File.Create(destinationPath);
        resource.CopyTo(file);
    }

    private static void ClearReadOnlyAttributes(string directoryPath)
    {
        if (!Directory.Exists(directoryPath))
        {
            return;
        }

        foreach (var filePath in Directory.EnumerateFiles(directoryPath, "*", SearchOption.AllDirectories))
        {
            try
            {
                var attributes = File.GetAttributes(filePath);
                if ((attributes & FileAttributes.ReadOnly) != 0)
                {
                    File.SetAttributes(filePath, attributes & ~FileAttributes.ReadOnly);
                }
            }
            catch
            {
            }
        }
    }

    private static void TryDeleteDirectory(string directoryPath)
    {
        try
        {
            if (Directory.Exists(directoryPath))
            {
                Directory.Delete(directoryPath, recursive: true);
            }
        }
        catch
        {
        }
    }

    private static void RegisterUninstallEntry(string installDir, string appExe, string uninstallerExe)
    {
        using var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(UninstallRegKey);
        key.SetValue("DisplayName", AppName);
        key.SetValue("DisplayIcon", appExe);
        key.SetValue("DisplayVersion", "1.0");
        key.SetValue("Publisher", "PanelManager");
        key.SetValue("InstallLocation", installDir);
        key.SetValue("UninstallString", $"\"{uninstallerExe}\" /uninstall");
        key.SetValue("QuietUninstallString", $"\"{uninstallerExe}\" /uninstall /quiet");
        key.SetValue("NoModify", 1, Microsoft.Win32.RegistryValueKind.DWord);
        key.SetValue("NoRepair", 1, Microsoft.Win32.RegistryValueKind.DWord);
    }

    [SupportedOSPlatform("windows")]
    private static void CreateShortcut(string shortcutPath, string targetPath, string workingDirectory, string iconPath)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(shortcutPath)!);
        using var stream = File.Create(shortcutPath);
        using var writer = new BinaryWriter(stream, Encoding.UTF8, leaveOpen: false);

        targetPath = Path.GetFullPath(targetPath);
        workingDirectory = Path.GetFullPath(workingDirectory);

        WriteShellLinkHeader(writer, targetPath);
        WriteLinkTargetIdList(writer, targetPath);
        WriteLinkInfo(writer, targetPath);
        WriteUnicodeStringData(writer, GetShortcutRelativePath(shortcutPath, targetPath));
        WriteUnicodeStringData(writer, workingDirectory);
        writer.Write(0u);
    }

    private static void WriteShellLinkHeader(BinaryWriter writer, string targetPath)
    {
        const uint hasLinkTargetIdList = 0x00000001;
        const uint hasLinkInfo = 0x00000002;
        const uint hasRelativePath = 0x00000008;
        const uint hasWorkingDir = 0x00000010;
        const uint isUnicode = 0x00000080;

        var creationTime = 0L;
        var accessTime = 0L;
        var writeTime = 0L;
        var fileSize = 0u;
        var fileAttributes = 0u;

        if (File.Exists(targetPath))
        {
            var info = new FileInfo(targetPath);
            creationTime = info.CreationTimeUtc.ToFileTimeUtc();
            accessTime = info.LastAccessTimeUtc.ToFileTimeUtc();
            writeTime = info.LastWriteTimeUtc.ToFileTimeUtc();
            fileSize = info.Length > uint.MaxValue ? 0u : (uint)info.Length;
            fileAttributes = (uint)File.GetAttributes(targetPath);
        }

        writer.Write(0x0000004Cu);
        writer.Write(new byte[] { 0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46 });
        writer.Write(hasLinkTargetIdList | hasLinkInfo | hasRelativePath | hasWorkingDir | isUnicode);
        writer.Write(fileAttributes);
        writer.Write(creationTime);
        writer.Write(accessTime);
        writer.Write(writeTime);
        writer.Write(fileSize);
        writer.Write(0);
        writer.Write(1u);
        writer.Write((ushort)0);
        writer.Write((ushort)0);
        writer.Write(0u);
        writer.Write(0u);
    }

    private static void WriteLinkTargetIdList(BinaryWriter writer, string targetPath)
    {
        var result = Win32.SHParseDisplayName(targetPath, IntPtr.Zero, out var pidl, 0, out _);
        if (result != 0 || pidl == IntPtr.Zero)
        {
            throw new InvalidOperationException($"Failed to create shortcut target ID list. HRESULT=0x{result:X8}");
        }

        try
        {
            var size = GetPidlByteSize(pidl);
            if (size > ushort.MaxValue)
            {
                throw new InvalidOperationException("Shortcut target ID list is too large.");
            }

            var bytes = new byte[size];
            Marshal.Copy(pidl, bytes, 0, size);
            writer.Write((ushort)size);
            writer.Write(bytes);
        }
        finally
        {
            Win32.CoTaskMemFree(pidl);
        }
    }

    private static int GetPidlByteSize(IntPtr pidl)
    {
        var offset = 0;
        while (true)
        {
            var itemSize = (ushort)Marshal.ReadInt16(pidl, offset);
            offset += sizeof(ushort);
            if (itemSize == 0)
            {
                return offset;
            }

            offset += itemSize - sizeof(ushort);
        }
    }

    private static string GetShortcutRelativePath(string shortcutPath, string targetPath)
    {
        var shortcutDirectory = Path.GetDirectoryName(Path.GetFullPath(shortcutPath));
        if (string.IsNullOrWhiteSpace(shortcutDirectory))
        {
            return targetPath;
        }

        try
        {
            var relative = Path.GetRelativePath(shortcutDirectory, targetPath);
            return relative.StartsWith(".", StringComparison.Ordinal) ? targetPath : relative;
        }
        catch
        {
            return targetPath;
        }
    }

    private static void WriteLinkInfo(BinaryWriter writer, string targetPath)
    {
        const uint volumeIdAndLocalBasePath = 0x00000001;
        const uint linkInfoHeaderSize = 0x00000024;

        var localBasePathAnsi = GetNullTerminatedAscii(targetPath);
        var commonPathSuffixAnsi = GetNullTerminatedAscii(string.Empty);
        var localBasePathUnicode = GetNullTerminatedUnicode(targetPath);
        var commonPathSuffixUnicode = GetNullTerminatedUnicode(string.Empty);
        var volumeId = CreateVolumeId();

        var volumeIdOffset = linkInfoHeaderSize;
        var localBasePathOffset = volumeIdOffset + (uint)volumeId.Length;
        var commonPathSuffixOffset = localBasePathOffset + (uint)localBasePathAnsi.Length;
        var localBasePathOffsetUnicode = commonPathSuffixOffset + (uint)commonPathSuffixAnsi.Length;
        var commonPathSuffixOffsetUnicode = localBasePathOffsetUnicode + (uint)localBasePathUnicode.Length;
        var linkInfoSize = commonPathSuffixOffsetUnicode + (uint)commonPathSuffixUnicode.Length;

        writer.Write(linkInfoSize);
        writer.Write(linkInfoHeaderSize);
        writer.Write(volumeIdAndLocalBasePath);
        writer.Write(volumeIdOffset);
        writer.Write(localBasePathOffset);
        writer.Write(0u);
        writer.Write(commonPathSuffixOffset);
        writer.Write(localBasePathOffsetUnicode);
        writer.Write(commonPathSuffixOffsetUnicode);
        writer.Write(volumeId);
        writer.Write(localBasePathAnsi);
        writer.Write(commonPathSuffixAnsi);
        writer.Write(localBasePathUnicode);
        writer.Write(commonPathSuffixUnicode);
    }

    private static byte[] CreateVolumeId()
    {
        using var stream = new MemoryStream();
        using var writer = new BinaryWriter(stream, Encoding.UTF8, leaveOpen: true);
        writer.Write(0x00000011u);
        writer.Write(0x00000003u);
        writer.Write(0u);
        writer.Write(0x00000010u);
        writer.Write((byte)0);
        writer.Flush();
        return stream.ToArray();
    }

    private static byte[] GetNullTerminatedAscii(string value)
    {
        return Encoding.ASCII.GetBytes(value + '\0');
    }

    private static byte[] GetNullTerminatedUnicode(string value)
    {
        return Encoding.Unicode.GetBytes(value + '\0');
    }

    private static void WriteUnicodeStringData(BinaryWriter writer, string value)
    {
        if (value.Length > ushort.MaxValue)
        {
            throw new InvalidOperationException("Shortcut string is too long.");
        }

        writer.Write((ushort)value.Length);
        writer.Write(Encoding.Unicode.GetBytes(value));
    }

    private static void ScheduleDirectoryRemoval(string installDir)
    {
        if (string.IsNullOrWhiteSpace(installDir) || !Directory.Exists(installDir))
        {
            return;
        }

        var command = $"/c timeout /t 2 /nobreak >nul & rmdir /s /q \"{installDir}\"";
        Process.Start(new ProcessStartInfo("cmd.exe", command)
        {
            CreateNoWindow = true,
            UseShellExecute = false,
            WindowStyle = ProcessWindowStyle.Hidden,
        });
    }

    private static void StopAppProcesses()
    {
        foreach (var processName in new[] { Path.GetFileNameWithoutExtension(FloatingWindowExeName), Path.GetFileNameWithoutExtension(AppExeName) })
        {
            foreach (var process in Process.GetProcessesByName(processName))
            {
                try
                {
                    if (process.Id == Environment.ProcessId)
                    {
                        continue;
                    }

                    process.CloseMainWindow();
                    if (!process.WaitForExit(2500))
                    {
                        process.Kill(entireProcessTree: true);
                    }
                }
                catch
                {
                }
                finally
                {
                    process.Dispose();
                }
            }
        }
    }

    private static bool HasRunningAppProcesses()
    {
        foreach (var processName in new[] { Path.GetFileNameWithoutExtension(AppExeName), Path.GetFileNameWithoutExtension(FloatingWindowExeName) })
        {
            foreach (var process in Process.GetProcessesByName(processName))
            {
                try
                {
                    if (process.Id != Environment.ProcessId)
                    {
                        return true;
                    }
                }
                catch
                {
                }
                finally
                {
                    process.Dispose();
                }
            }
        }

        return false;
    }

    private static string GetStartMenuShortcutPath()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", "PanelManager.lnk");
    }

    private static string GetDesktopShortcutPath()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "PanelManager.lnk");
    }

    private static void TryDeleteFile(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch
        {
        }
    }
}

internal static class Win32
{
    public const uint WS_OVERLAPPED = 0x00000000;
    public const uint WS_CAPTION = 0x00C00000;
    public const uint WS_SYSMENU = 0x00080000;
    public const uint WS_MINIMIZEBOX = 0x00020000;
    public const uint WS_CHILD = 0x40000000;
    public const uint WS_VISIBLE = 0x10000000;
    public const uint WS_EX_CLIENTEDGE = 0x00000200;
    public const uint ES_AUTOHSCROLL = 0x0080;
    public const uint BS_PUSHBUTTON = 0x00000000;
    public const uint BS_AUTOCHECKBOX = 0x00000003;
    public const uint SS_WHITERECT = 0x00000006;
    public const uint SS_ETCHEDHORZ = 0x00000010;
    public const uint SS_LEFT = 0x00000000;
    public const uint SS_ICON = 0x00000003;
    public const uint DEFAULT_CHARSET = 1;
    public const int COLOR_WINDOW = 5;
    public const int CW_USEDEFAULT = unchecked((int)0x80000000);
    public const int SW_SHOW = 5;
    public const int SM_CXICON = 11;
    public const int SM_CYICON = 12;
    public const int SM_CXSMICON = 49;
    public const int SM_CYSMICON = 50;
    public const int GWLP_USERDATA = -21;
    public const int WM_SETICON = 0x0080;
    public const int WM_SETFONT = 0x0030;
    public const int WM_COMMAND = 0x0111;
    public const int WM_CLOSE = 0x0010;
    public const int WM_DESTROY = 0x0002;
    public const int WM_CTLCOLORSTATIC = 0x0138;
    public const int WM_CTLCOLORBTN = 0x0135;
    public const int EM_SETREADONLY = 0x00CF;
    public const int BM_SETCHECK = 0x00F1;
    public const int STM_SETICON = 0x0170;
    public const int BST_CHECKED = 1;
    public const int PBM_SETPOS = 0x0402;
    public const int PBS_SMOOTH = 0x01;
    public const int SWP_NOSIZE = 0x0001;
    public const int SWP_NOZORDER = 0x0004;
    public const int ICON_SMALL = 0;
    public const int ICON_BIG = 1;
    public const int IDI_APPLICATION = 32512;
    public const uint MB_YESNO = 0x00000004;
    public const uint MB_ICONQUESTION = 0x00000020;
    public const int IDYES = 6;
    public const uint IMAGE_ICON = 1;
    public const uint LR_DEFAULTCOLOR = 0x00000000;
    public const int TRANSPARENT = 1;

    private const int WM_APP_PROGRESS = 0x8001;
    private const int WM_APP_COMPLETE = 0x8002;

    public static WndProcDelegate WndProc = WndProcHandler;

    public delegate IntPtr WndProcDelegate(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

    private static IntPtr WndProcHandler(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        if (msg == WM_CLOSE)
        {
            var ptr = GetWindowLongPtr(hwnd, GWLP_USERDATA);
            if (ptr != IntPtr.Zero)
            {
                var state = (InstallerState)GCHandle.FromIntPtr(ptr).Target!;
                if (state.Busy)
                {
                    return IntPtr.Zero;
                }
            }
            DestroyWindow(hwnd);
            return IntPtr.Zero;
        }

        if (msg == WM_DESTROY)
        {
            var ptr = GetWindowLongPtr(hwnd, GWLP_USERDATA);
            if (ptr != IntPtr.Zero)
            {
                var handle = GCHandle.FromIntPtr(ptr);
                if (handle.IsAllocated)
                {
                    handle.Free();
                }
            }
            PostQuitMessage(0);
            return IntPtr.Zero;
        }

        if (msg == WM_CTLCOLORSTATIC || msg == WM_CTLCOLORBTN)
        {
            var ptr = GetWindowLongPtr(hwnd, GWLP_USERDATA);
            if (ptr != IntPtr.Zero)
            {
                var state = (InstallerState)GCHandle.FromIntPtr(ptr).Target!;
                SetBkMode(wParam, TRANSPARENT);
                
                if (state.IsDarkMode)
                {
                    SetTextColor(wParam, 0x00FFFFFF);
                }
                else
                {
                    SetTextColor(wParam, 0x00000000);
                }

                if (lParam == state.ButtonPanel)
                {
                    return state.PanelBrush;
                }
                return state.BackgroundBrush;
            }
            SetBkMode(wParam, TRANSPARENT);
            return GetSysColorBrush(COLOR_WINDOW);
        }

        if (msg == WM_APP_PROGRESS)
        {
            var state = GetState(hwnd);
            Program.OnProgress(state, wParam, lParam);
            if (lParam != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(lParam);
            }
            return IntPtr.Zero;
        }

        if (msg == WM_APP_COMPLETE)
        {
            var state = GetState(hwnd);
            Program.OnComplete(state, wParam, lParam);
            return IntPtr.Zero;
        }

        if (msg == WM_COMMAND)
        {
            var state = GetState(hwnd);
            var controlHwnd = lParam;

            if (state.PrimaryButton != IntPtr.Zero && controlHwnd == state.PrimaryButton)
            {
                Program.OnPrimaryClick(state);
                return IntPtr.Zero;
            }

            if (state.BrowseButton != IntPtr.Zero && controlHwnd == state.BrowseButton)
            {
                Program.OnBrowse(state);
                return IntPtr.Zero;
            }
        }

        return DefWindowProc(hwnd, msg, wParam, lParam);
    }

    private static InstallerState GetState(IntPtr hwnd)
    {
        var ptr = GetWindowLongPtr(hwnd, GWLP_USERDATA);
        return GCHandle.FromIntPtr(ptr).Target as InstallerState ?? throw new InvalidOperationException();
    }

    [DllImport("user32.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateWindowExW(uint dwExStyle, string lpClassName, string? lpWindowName, uint dwStyle, int x, int y, int nWidth, int nHeight, IntPtr hWndParent, IntPtr hMenu, IntPtr hInstance, IntPtr lpParam);

    public static IntPtr CreateWindowEx(uint dwExStyle, string lpClassName, string? lpWindowName, uint dwStyle, int x, int y, int nWidth, int nHeight, IntPtr hWndParent, IntPtr hMenu, IntPtr hInstance, IntPtr lpParam)
    {
        return CreateWindowExW(dwExStyle, lpClassName, lpWindowName, dwStyle, x, y, nWidth, nHeight, hWndParent, hMenu, hInstance, lpParam);
    }

    [DllImport("user32.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindowExW(IntPtr hwndParent, IntPtr hwndChildAfter, string? lpszClass, string? lpszWindow);

    public static IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter, string? lpszClass, string? lpszWindow)
    {
        return FindWindowExW(hwndParent, hwndChildAfter, lpszClass, lpszWindow);
    }

    [DllImport("user32.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr DefWindowProcW(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

    public static IntPtr DefWindowProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam) => DefWindowProcW(hwnd, msg, wParam, lParam);

    [DllImport("user32.dll")]
    public static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    public static extern int TranslateMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    public static extern IntPtr DispatchMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hwnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool UpdateWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern void PostQuitMessage(int nExitCode);

    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern IntPtr LoadCursor(IntPtr hInstance, IntPtr lpCursorName);

    [DllImport("user32.dll")]
    public static extern IntPtr LoadIcon(IntPtr hInstance, IntPtr lpIconName);

    [DllImport("user32.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr LoadImageW(IntPtr hinst, IntPtr name, uint type, int cx, int cy, uint fuLoad);

    public static IntPtr LoadImage(IntPtr hinst, IntPtr name, uint type, int cx, int cy, uint fuLoad) => LoadImageW(hinst, name, type, cx, cy, fuLoad);

    [DllImport("user32.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    public static extern ushort RegisterClassExW(ref WNDCLASSEX lpwcx);

    public static ushort RegisterClassEx(ref WNDCLASSEX lpwcx) => RegisterClassExW(ref lpwcx);

    [DllImport("kernel32.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr GetModuleHandleW(string? lpModuleName);

    public static IntPtr GetModuleHandle(string? lpModuleName) => GetModuleHandleW(lpModuleName);

    [DllImport("user32.dll")]
    public static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int nIndex, IntPtr dwNewLong);

    [DllImport("user32.dll")]
    public static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int nIndex);

    [DllImport("user32.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessageW(IntPtr hwnd, int msg, IntPtr wParam, StringBuilder lParam);

    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam);

    public static IntPtr SendMessage(IntPtr hwnd, int msg, IntPtr wParam, StringBuilder lParam) => SendMessageW(hwnd, msg, wParam, lParam);

    [DllImport("user32.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    public static extern bool SetWindowTextW(IntPtr hwnd, string lpString);

    public static bool SetWindowText(IntPtr hwnd, string lpString) => SetWindowTextW(hwnd, lpString);

    [DllImport("user32.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    public static extern int MessageBoxW(IntPtr hwnd, string lpText, string lpCaption, uint uType);

    public static int MessageBox(IntPtr hwnd, string lpText, string lpCaption, uint uType) => MessageBoxW(hwnd, lpText, lpCaption, uType);

    [DllImport("gdi32.dll")]
    public static extern IntPtr CreateFontW(int nHeight, int nWidth, int nEscapement, int nOrientation, int fnWeight, uint fdwItalic, uint fdwUnderline, uint fdwStrikeOut, uint fdwCharSet, uint fdwOutputPrecision, uint fdwClipPrecision, uint fdwQuality, uint fdwPitchAndFamily, string lpszFace);

    [DllImport("gdi32.dll")]
    public static extern bool DeleteObject(IntPtr hObject);

    [DllImport("user32.dll")]
    public static extern bool EnableWindow(IntPtr hwnd, bool bEnable);

    [DllImport("user32.dll")]
    public static extern bool DestroyWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hwnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hwnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);

    [DllImport("user32.dll")]
    public static extern IntPtr GetSysColorBrush(int nIndex);

    [DllImport("gdi32.dll")]
    public static extern int SetBkMode(IntPtr hdc, int mode);

    [DllImport("gdi32.dll")]
    public static extern IntPtr CreateSolidBrush(uint crColor);

    [DllImport("gdi32.dll")]
    public static extern uint SetTextColor(IntPtr hdc, uint color);

    [DllImport("dwmapi.dll")]
    public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

    public const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
    public const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    public const int DWMWCP_ROUND = 2;

    [DllImport("shell32.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr SHBrowseForFolderW(ref BROWSEINFO lpbi);

    public static IntPtr SHBrowseForFolder(ref BROWSEINFO lpbi) => SHBrowseForFolderW(ref lpbi);

    [DllImport("shell32.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    public static extern bool SHGetPathFromIDListW(IntPtr pidl, StringBuilder pszPath);

    public static bool SHGetPathFromIDList(IntPtr pidl, StringBuilder pszPath) => SHGetPathFromIDListW(pidl, pszPath);

    [DllImport("shell32.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    public static extern int SHParseDisplayName(string pszName, IntPtr pbc, out IntPtr ppidl, uint sfgaoIn, out uint psfgaoOut);

    [DllImport("ole32.dll")]
    public static extern void CoTaskMemFree(IntPtr pv);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct BROWSEINFO
    {
        public IntPtr hwndOwner;
        public IntPtr pidlRoot;
        public string pszDisplayName;
        public string lpszTitle;
        public uint ulFlags;
        public IntPtr lpfn;
        public IntPtr lParam;
        public int iImage;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int pt_x;
        public int pt_y;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct WNDCLASSEX
    {
        public uint cbSize;
        public uint style;
        public WndProcDelegate lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        public IntPtr lpszMenuName;
        public IntPtr lpszClassName;
        public IntPtr hIconSm;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int left;
        public int top;
        public int right;
        public int bottom;
    }
}
