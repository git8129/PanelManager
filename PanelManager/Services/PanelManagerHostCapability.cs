using System.Security.Cryptography;

namespace PanelManager.Services;

internal static class PanelManagerHostCapability
{
    private static readonly byte[] TokenBytes = RandomNumberGenerator.GetBytes(32);

    public static string Token { get; } = Convert.ToHexString(TokenBytes);

    public static bool Matches(string? value)
    {
        if (value is null || value.Length != Token.Length)
        {
            return false;
        }
        try
        {
            return CryptographicOperations.FixedTimeEquals(
                Convert.FromHexString(value),
                TokenBytes);
        }
        catch (FormatException)
        {
            return false;
        }
    }
}
