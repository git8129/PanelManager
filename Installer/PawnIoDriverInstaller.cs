using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using Microsoft.Win32;

namespace PanelManager.Installer;

internal static class PawnIoDriverInstaller
{
    // 原样内嵌的官方签名资源（保留原许可/签名）：
    // https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/blob/v0.9.6/LibreHardwareMonitor/Resources/PawnIO_setup.exe
    // 静默参数依据：https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/issues/1901
    internal static readonly Version RequiredVersion = new(2, 1, 0, 0);
    private const string ResourceHash = "A3A46226C5E2824F4CDD42BE0EECBABFC672C86F7889710F5AB1E6AD385B47A0";

    internal static Version? GetInstalledVersion()
    {
        using var registry = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
        using var key = registry.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PawnIO");
        return Version.TryParse(key?.GetValue("DisplayVersion") as string, out var version) ? version : null;
    }

    internal static void Install()
    {
        if (GetInstalledVersion() >= RequiredVersion) return;

        // 安装器负责驱动依赖；LHM 0.9.6 在驱动缺失时仍能 Open，却只返回 0°C。
        // 必须内嵌官方资源并验证结果，不能退回运行时下载或把启动进程当作安装成功。
        var directory = Path.Combine(Path.GetTempPath(), "PanelManager-PawnIO-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, "PawnIO_setup.exe");
        var finished = true;
        try
        {
            using (var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("PawnIO_setup.exe")
                ?? throw new InvalidOperationException("Missing embedded PawnIO driver."))
            using (var output = File.Create(path))
                resource.CopyTo(output);

            // 保持文件只读共享直至子进程退出，避免校验后被覆盖。
            using var verifiedFile = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (Convert.ToHexString(SHA256.HashData(verifiedFile)) != ResourceHash)
                throw new InvalidOperationException("Embedded PawnIO driver hash mismatch.");

            using var process = Process.Start(new ProcessStartInfo(path, "-install -silent")
            {
                WorkingDirectory = directory,
                UseShellExecute = true,
                Verb = "runas"
            }) ?? throw new InvalidOperationException("Could not start PawnIO installation.");
            finished = process.WaitForExit(120_000);
            if (!finished)
                throw new TimeoutException("PawnIO installation timed out. Wait for driver installation to finish before retrying.");
            var installedVersion = GetInstalledVersion();
            if (process.ExitCode != 0 || installedVersion == null || installedVersion < RequiredVersion)
                throw new InvalidOperationException($"PawnIO installation failed (exit code {process.ExitCode}).");
        }
        finally
        {
            // 超时不强杀系统驱动安装进程，也不删除其仍可能使用的资源。
            if (finished)
            {
                try { File.Delete(path); Directory.Delete(directory); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
        }
    }
}
