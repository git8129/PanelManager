using System.ComponentModel;
using System.Diagnostics;
using System.Security.Principal;

namespace PanelManager.Services;

internal static class StartupPrivileges
{
    internal static bool IsElevated
    {
        get
        {
            using var identity = WindowsIdentity.GetCurrent();
            return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
        }
    }

    internal static bool TryStartElevated()
    {
        try
        {
            if (IsElevated || Environment.GetCommandLineArgs().Contains("--compatibility-mode")) return false;
            var executable = Environment.ProcessPath;
            if (string.IsNullOrEmpty(executable)) return false;
            var start = new ProcessStartInfo(executable)
            {
                UseShellExecute = true,
                Verb = "runas",
                WorkingDirectory = AppContext.BaseDirectory
            };
            foreach (var argument in Environment.GetCommandLineArgs().Skip(1))
                start.ArgumentList.Add(argument);
            using var process = Process.Start(start);
            return process != null;
        }
        catch (Win32Exception ex) when (ex.NativeErrorCode == 1223)
        {
            // 启动 owner：拒绝 UAC 是兼容模式，不是启动失败；禁止 requireAdministrator manifest。
            return false;
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[Performance] 无法提权，以兼容模式启动: {ex.Message}");
            return false;
        }
    }
}
