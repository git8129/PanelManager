using System;
using System.IO;
using System.Threading.Tasks;

namespace PanelManager.WinUI;

internal static class CrashLog
{
    private static bool _installed;
    private static readonly object LockObj = new();

    public static void Install()
    {
        lock (LockObj)
        {
            if (_installed)
            {
                return;
            }

            _installed = true;

            // 写一条启动记录，便于定位日志路径（即便不是托管异常导致退出）
            try { Write("Startup", null); } catch { }

            AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            {
                try
                {
                    Write("UnhandledException", e.ExceptionObject as Exception);
                }
                catch { }
            };

            TaskScheduler.UnobservedTaskException += (_, e) =>
            {
                try
                {
                    Write("UnobservedTaskException", e.Exception);
                }
                catch { }
            };
        }
    }

    public static void Write(string tag, Exception? ex)
    {
        var now = DateTimeOffset.Now.ToString("yyyy-MM-dd HH:mm:ss.fff zzz");
        var msg = ex?.ToString() ?? "(null)";
        var text = $"[{now}] {tag}\r\n{msg}\r\n\r\n";

        // 1) 优先写入 MSIX LocalState（如果可用）
        try
        {
            var localState = TryGetPackageLocalStatePath();
            if (!string.IsNullOrWhiteSpace(localState))
            {
                var dir = Path.Combine(localState, "PanelManager", "Logs");
                Directory.CreateDirectory(dir);
                File.AppendAllText(Path.Combine(dir, "crash.log"), text);
            }
        }
        catch { }

        // 2) 同时写一份到普通的 LocalAppData（方便未打包/某些环境下排查）
        try
        {
            var baseDir = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            var dir = Path.Combine(baseDir, "PanelManager", "Logs");
            Directory.CreateDirectory(dir);
            File.AppendAllText(Path.Combine(dir, "crash.log"), text);
        }
        catch { }
    }

    private static string? TryGetPackageLocalStatePath()
    {
        try
        {
            // 仅在已打包（MSIX）上下文可用；未打包会抛异常
            return Windows.Storage.ApplicationData.Current.LocalFolder.Path;
        }
        catch
        {
            return null;
        }
    }
}
