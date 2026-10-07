using System.Text.Json;
using System.Text.RegularExpressions;

namespace PanelManager.Services;

internal sealed record AppRelease(string Tag, Version Version, string Notes, Uri DownloadUrl, long Size, string Sha256);

internal static class AppReleasePolicy
{
    internal const string Repository = "git8129/PanelManager";
    internal const string InstallerName = "PanelManagerSetup.exe";
    internal const long MaxInstallerBytes = 512L * 1024 * 1024;
    internal static readonly Uri LatestApi = new($"https://api.github.com/repos/{Repository}/releases/latest");
    internal static string CurrentVersionText
    {
        get
        {
            var version = typeof(AppReleasePolicy).Assembly.GetName().Version;
            return version == null ? "1.1.4" : version.ToString(version.Revision > 0 ? 4 : 3);
        }
    }

    internal static Version ParseVersion(string text)
    {
        // 仅正式数字版本；拒绝 preview/未知标签，避免误升级和按字符串比较 1.10/1.9。
        if (!Regex.IsMatch(text, @"\Av?[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?\z", RegexOptions.CultureInvariant))
            throw new InvalidDataException("Release 标签不是受支持的正式版本号。");
        var version = Version.Parse(text.TrimStart('v'));
        return new Version(version.Major, version.Minor, version.Build, Math.Max(0, version.Revision));
    }

    internal static AppRelease? ParseLatest(JsonElement root)
    {
        if (root.GetProperty("draft").GetBoolean() || root.GetProperty("prerelease").GetBoolean())
            return null;
        var tag = root.GetProperty("tag_name").GetString() ?? "";
        var version = ParseVersion(tag);
        if (version <= ParseVersion(CurrentVersionText)) return null;

        var assets = root.GetProperty("assets").EnumerateArray()
            .Where(asset => asset.GetProperty("name").GetString() == InstallerName).ToArray();
        if (assets.Length != 1) throw new InvalidDataException("最新 Release 缺少唯一的 Windows 安装包。");
        var asset = assets[0];
        if (asset.GetProperty("state").GetString() != "uploaded")
            throw new InvalidDataException("安装包尚未上传完成。");
        var expected = new Uri($"https://github.com/{Repository}/releases/download/{Uri.EscapeDataString(tag)}/{InstallerName}");
        var actual = new Uri(asset.GetProperty("browser_download_url").GetString() ?? "");
        if (actual != expected) throw new InvalidDataException("安装包地址不属于指定 Release。");
        var size = asset.GetProperty("size").GetInt64();
        if (size <= 0 || size > MaxInstallerBytes) throw new InvalidDataException("安装包大小超出支持范围。");
        var digest = asset.TryGetProperty("digest", out var value) ? value.GetString() : null;
        if (digest == null || !Regex.IsMatch(digest, @"\Asha256:[0-9a-fA-F]{64}\z", RegexOptions.CultureInvariant))
            throw new InvalidDataException("GitHub 未提供安装包 SHA-256，无法自动安装。");
        var notes = root.TryGetProperty("body", out var body) ? body.GetString() ?? "" : "";
        return new AppRelease(tag, version, notes.Length > 4000 ? notes[..4000] + "…" : notes,
            actual, size, digest[7..]);
    }

    internal static IEnumerable<Uri> DownloadSources(AppRelease release)
    {
        yield return release.DownloadUrl;
        // 参考固件下载的固定顺序回退；不按延迟选镜像、不混源续传、不从代理获取可信摘要。
        foreach (var prefix in new[] { "https://ghproxy.net/", "https://ghfast.top/", "https://gh-proxy.org/" })
            yield return new Uri(prefix + release.DownloadUrl.AbsoluteUri);
    }
}
