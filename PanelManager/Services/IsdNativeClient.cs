using System.Runtime.InteropServices;
using System.Text.Json;

namespace PanelManager.Services;

internal static class IsdNativeClient
{
    private const uint AbiVersion = 1;
    private const uint AllowDestructive = 1 << 0;
    private const uint EraseEntireFlash = 1 << 1;
    private static readonly NativeProgressCallback ProgressCallback = HandleNativeProgress;

    internal enum Stage : uint
    {
        WaitingForDevice = 1,
        OpeningDevice = 2,
        UploadingLoader = 3,
        NegotiatingSession = 4,
        QueryingDevice = 5,
        ScanningPrivateData = 6,
        ErasingFlash = 7,
        ProgrammingFlash = 8,
        VerifyingFlash = 9,
        ResettingDevice = 10,
        WaitingForNormalMode = 11,
        Completed = 12
    }

    internal sealed record Progress(
        Stage Stage,
        int Percent,
        string Message,
        ulong CompletedUnits,
        ulong TotalUnits);

    internal sealed record DownloadResult(
        string PackageSha256,
        string FlashUuid,
        uint UpdatedSectors,
        uint UnchangedSectors,
        uint LoaderBytes,
        uint LoaderBlocks,
        bool NormalModeConfirmed);

    internal sealed class Package : IDisposable
    {
        private readonly NativeHandle _handle;

        internal Package(NativeHandle handle, PackageMetadata metadata)
        {
            _handle = handle;
            Metadata = metadata;
        }

        internal PackageMetadata Metadata { get; }
        internal ulong Handle => _handle.Value;

        public void Dispose() => _handle.Dispose();
    }

    internal sealed class Baseline : IDisposable
    {
        private readonly NativeHandle _handle;

        internal Baseline(NativeHandle handle) => _handle = handle;
        internal ulong Handle => _handle.Value;

        public void Dispose() => _handle.Dispose();
    }

    internal sealed class Operation : IDisposable
    {
        private readonly NativeHandle _handle;

        internal Operation(NativeHandle handle) => _handle = handle;
        internal ulong Handle => _handle.Value;

        internal void Cancel()
        {
            if (!_handle.IsClosed && !_handle.IsInvalid)
            {
                _ = NativeMethods.OperationCancel(_handle.Value);
            }
        }

        public void Dispose() => _handle.Dispose();
    }

    internal sealed class PackageMetadata
    {
        public string PackageSha256 { get; init; } = string.Empty;
        public string SigningKeyId { get; init; } = string.Empty;
        public string Product { get; init; } = string.Empty;
        public string Board { get; init; } = string.Empty;
        public string Layout { get; init; } = string.Empty;
        public string FirmwareVersion { get; init; } = string.Empty;
        public string FirmwareType { get; init; } = string.Empty;
        public string BuildId { get; init; } = string.Empty;
        public string CreatedUtc { get; init; } = string.Empty;
        public ulong SecurityCounter { get; init; }
        public string Changelog { get; init; } = string.Empty;
        public bool ForceUpdate { get; init; }
        public bool SilentUpdate { get; init; }
        public string UsbProfile { get; init; } = string.Empty;
        public uint FlashCapacity { get; init; }
        public uint FlashLength { get; init; }
        public uint SectorSize { get; init; }
        public uint CodeBoundary { get; init; }
        public string DataPolicy { get; init; } = string.Empty;
        public string FlashSha256 { get; init; } = string.Empty;
        public string LoaderSha256 { get; init; } = string.Empty;
        public uint LoaderLength { get; init; }
    }

    internal static Package OpenPackage(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        EnsureAbi();
        ThrowIfError(NativeMethods.PackageOpen(path, out var handle), "打开并验证 PMFW");
        var nativeHandle = new NativeHandle(handle);
        try
        {
            var json = ReadUtf8((buffer, capacity) =>
                NativeMethods.PackageInfo(nativeHandle.Value, buffer, capacity));
            var metadata = JsonSerializer.Deserialize<PackageMetadata>(json, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true
            }) ?? throw new InvalidDataException("IsdDownload.dll 返回了空 PMFW 元数据。");
            return new Package(nativeHandle, metadata);
        }
        catch
        {
            nativeHandle.Dispose();
            throw;
        }
    }

    internal static Baseline CaptureBaseline()
    {
        EnsureAbi();
        ThrowIfError(NativeMethods.BaselineCapture(out var handle), "采集下载设备基线");
        return new Baseline(new NativeHandle(handle));
    }

    internal static Operation CreateOperation()
    {
        EnsureAbi();
        ThrowIfError(NativeMethods.OperationCreate(out var handle), "创建下载操作");
        return new Operation(new NativeHandle(handle));
    }

    internal static async Task<DownloadResult> DownloadAsync(
        Package package,
        Baseline baseline,
        Operation operation,
        bool preserveUserData,
        string journalPath,
        IProgress<Progress>? progress,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(package);
        ArgumentNullException.ThrowIfNull(baseline);
        ArgumentNullException.ThrowIfNull(operation);
        ArgumentException.ThrowIfNullOrWhiteSpace(journalPath);

        using var registration = cancellationToken.Register(operation.Cancel);
        return await Task.Run(
            () => DownloadCore(
                package,
                baseline,
                operation,
                preserveUserData,
                journalPath,
                progress),
            CancellationToken.None).ConfigureAwait(false);
    }

    private static unsafe DownloadResult DownloadCore(
        Package package,
        Baseline baseline,
        Operation operation,
        bool preserveUserData,
        string journalPath,
        IProgress<Progress>? progress)
    {
        var callbackState = progress is null ? default : GCHandle.Alloc(progress);
        var journalPathUtf8 = Marshal.StringToCoTaskMemUTF8(journalPath);
        try
        {
            var options = new NativeDownloadOptions
            {
                Size = (uint)Marshal.SizeOf<NativeDownloadOptions>(),
                Version = AbiVersion,
                Flags = AllowDestructive | (preserveUserData ? 0u : EraseEntireFlash),
                DeviceWaitTimeoutSeconds = 45,
                NormalModeTimeoutSeconds = 600,
                JournalPathUtf8 = journalPathUtf8,
                ProgressCallback = progress is null
                    ? IntPtr.Zero
                    : Marshal.GetFunctionPointerForDelegate(ProgressCallback),
                ProgressUserData = progress is null
                    ? IntPtr.Zero
                    : GCHandle.ToIntPtr(callbackState)
            };
            var result = new NativeDownloadResult
            {
                Size = (uint)Marshal.SizeOf<NativeDownloadResult>(),
                Version = AbiVersion
            };
            ThrowIfError(
                NativeMethods.Download(
                    package.Handle,
                    baseline.Handle,
                    operation.Handle,
                    ref options,
                    ref result),
                "执行 PMFW 下载");

            string packageSha256;
            string flashUuid;
            byte* packageHash = result.PackageSha256;
            byte* uuid = result.FlashUuid;
            packageSha256 = Convert.ToHexString(new ReadOnlySpan<byte>(packageHash, 32));
            flashUuid = Convert.ToHexString(new ReadOnlySpan<byte>(uuid, 16));
            return new DownloadResult(
                packageSha256,
                flashUuid,
                result.UpdatedSectors,
                result.UnchangedSectors,
                result.LoaderBytes,
                result.LoaderBlocks,
                result.NormalModeConfirmed != 0);
        }
        finally
        {
            Marshal.FreeCoTaskMem(journalPathUtf8);
            if (callbackState.IsAllocated)
            {
                callbackState.Free();
            }
        }
    }

    private static void EnsureAbi()
    {
        var version = NativeMethods.ApiVersion();
        if (version != AbiVersion)
        {
            throw new InvalidDataException(
                $"IsdDownload.dll ABI 版本不兼容：实际 {version}，要求 {AbiVersion}。");
        }
    }

    private static void ThrowIfError(int code, string operation)
    {
        if (code == 0)
        {
            return;
        }
        var detail = ReadLastError();
        throw code switch
        {
            6 => new OperationCanceledException(detail),
            7 => new TimeoutException(detail),
            _ => new InvalidOperationException($"{operation}失败（ISD 错误 {code}）：{detail}")
        };
    }

    private static string ReadLastError()
    {
        var required = NativeMethods.LastError(IntPtr.Zero, 0);
        if (required == 0)
        {
            return "原生库未提供错误详情。";
        }
        var buffer = Marshal.AllocHGlobal(checked((int)required));
        try
        {
            _ = NativeMethods.LastError(buffer, required);
            return Marshal.PtrToStringUTF8(buffer) ?? "原生库返回了空错误详情。";
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static string ReadUtf8(Func<IntPtr, nuint, nuint> read)
    {
        var required = read(IntPtr.Zero, 0);
        if (required == 0)
        {
            throw new InvalidOperationException(ReadLastError());
        }
        var buffer = Marshal.AllocHGlobal(checked((int)required));
        try
        {
            var secondRequired = read(buffer, required);
            if (secondRequired == 0)
            {
                throw new InvalidOperationException(ReadLastError());
            }
            if (secondRequired > required)
            {
                throw new InvalidDataException("IsdDownload.dll 返回的 UTF-8 元数据长度发生变化。");
            }
            return Marshal.PtrToStringUTF8(buffer) ?? string.Empty;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static void HandleNativeProgress(IntPtr progressPointer, IntPtr userData)
    {
        try
        {
            if (progressPointer == IntPtr.Zero || userData == IntPtr.Zero)
            {
                return;
            }
            var reporter = GCHandle.FromIntPtr(userData).Target as IProgress<Progress>;
            if (reporter is null)
            {
                return;
            }
            var native = Marshal.PtrToStructure<NativeProgress>(progressPointer);
            if (native.Size != Marshal.SizeOf<NativeProgress>() || native.Version != AbiVersion)
            {
                return;
            }
            reporter.Report(new Progress(
                (Stage)native.Stage,
                checked((int)native.Percent),
                Marshal.PtrToStringUTF8(native.MessageUtf8) ?? string.Empty,
                native.CompletedUnits,
                native.TotalUnits));
        }
        catch
        {
            // Managed exceptions must never cross the native callback boundary.
        }
    }

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate void NativeProgressCallback(IntPtr progress, IntPtr userData);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeProgress
    {
        public uint Size;
        public uint Version;
        public uint Stage;
        public uint Percent;
        public ulong CompletedUnits;
        public ulong TotalUnits;
        public IntPtr MessageUtf8;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeDownloadOptions
    {
        public uint Size;
        public uint Version;
        public uint Flags;
        public uint DeviceWaitTimeoutSeconds;
        public uint NormalModeTimeoutSeconds;
        public IntPtr JournalPathUtf8;
        public IntPtr ProgressCallback;
        public IntPtr ProgressUserData;
    }

    [StructLayout(LayoutKind.Sequential)]
    private unsafe struct NativeDownloadResult
    {
        public uint Size;
        public uint Version;
        public fixed byte PackageSha256[32];
        public fixed byte FlashUuid[16];
        public uint UpdatedSectors;
        public uint UnchangedSectors;
        public uint LoaderBytes;
        public uint LoaderBlocks;
        public uint NormalModeConfirmed;
        public uint Reserved;
    }

    internal sealed class NativeHandle : SafeHandle
    {
        internal NativeHandle(ulong value)
            : base(IntPtr.Zero, true)
        {
            SetHandle(unchecked((IntPtr)(long)value));
        }

        internal ulong Value => unchecked((ulong)handle.ToInt64());
        public override bool IsInvalid => handle == IntPtr.Zero;

        protected override bool ReleaseHandle()
        {
            return NativeMethods.HandleRelease(Value) == 0;
        }
    }

    private static class NativeMethods
    {
        private const string Library = "IsdDownload.dll";

        [DllImport(Library, EntryPoint = "isd_api_version", CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)]
        internal static extern uint ApiVersion();

        [DllImport(Library, EntryPoint = "isd_last_error_utf8", CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)]
        internal static extern nuint LastError(IntPtr buffer, nuint capacity);

        [DllImport(Library, EntryPoint = "isd_package_open", CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)]
        internal static extern int PackageOpen(
            [MarshalAs(UnmanagedType.LPUTF8Str)] string path,
            out ulong packageHandle);

        [DllImport(Library, EntryPoint = "isd_package_info_utf8", CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)]
        internal static extern nuint PackageInfo(ulong packageHandle, IntPtr buffer, nuint capacity);

        [DllImport(Library, EntryPoint = "isd_baseline_capture", CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)]
        internal static extern int BaselineCapture(out ulong baselineHandle);

        [DllImport(Library, EntryPoint = "isd_operation_create", CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)]
        internal static extern int OperationCreate(out ulong operationHandle);

        [DllImport(Library, EntryPoint = "isd_operation_cancel", CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)]
        internal static extern int OperationCancel(ulong operationHandle);

        [DllImport(Library, EntryPoint = "isd_download", CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)]
        internal static extern int Download(
            ulong packageHandle,
            ulong baselineHandle,
            ulong operationHandle,
            ref NativeDownloadOptions options,
            ref NativeDownloadResult result);

        [DllImport(Library, EntryPoint = "isd_handle_release", CallingConvention = CallingConvention.Cdecl, ExactSpelling = true)]
        internal static extern int HandleRelease(ulong handle);
    }
}
