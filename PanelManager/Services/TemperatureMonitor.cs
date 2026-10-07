using LibreHardwareMonitor.Hardware;

namespace PanelManager.Services;

// 温度 owner 独占 LHM；驱动访问不进入性能推送/界面线程，最多一个采集线程和一份快照。
internal sealed class TemperatureMonitor : IDisposable
{
    internal sealed record SensorReading(string Id, string Hardware, string Kind, string Name, double? Value);
    internal sealed record Snapshot(double CpuTemperature, SensorReading[] Sensors, long SampledAt);
    private readonly object _gate = new();
    private readonly AutoResetEvent _wake = new(false);
    private Thread? _worker;
    private bool _enabled;
    private bool _disposed;
    private Snapshot _latest = new(0, [], 0);

    internal void Start()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _enabled = true;
            if (_worker == null)
            {
                _worker = new Thread(Run) { IsBackground = true, Name = "PanelManager.Temperature" };
                _worker.Start();
            }
            _wake.Set();
        }
    }

    internal void Stop()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _enabled = false;
            _latest = new(0, [], 0);
            _wake.Set();
        }
    }

    internal Snapshot Read()
    {
        Snapshot snapshot;
        lock (_gate) snapshot = _latest;
        if (Environment.TickCount64 - snapshot.SampledAt <= 10_000) return snapshot;
        // 采集卡住时保留可选身份但清空值，不能把旧温度当作实时读数。
        return new(0, snapshot.Sensors.Select(sensor => sensor with { Value = null }).ToArray(), snapshot.SampledAt);
    }

    private void Run()
    {
        Computer? computer = null;
        try
        {
            while (true)
            {
                bool enabled;
                lock (_gate)
                {
                    if (_disposed) return;
                    enabled = _enabled;
                }
                if (!enabled)
                {
                    Close(ref computer);
                    _wake.WaitOne();
                    continue;
                }

                try
                {
                    if (computer == null)
                    {
                        computer = new Computer { IsCpuEnabled = true };
                        computer.Open();
                        // GPU 初始化异常不能废弃已经可用的 CPU 传感器。
                        try { computer.IsGpuEnabled = true; }
                        catch (Exception ex) { System.Diagnostics.Debug.WriteLine($"[Temperature] GPU: {ex.Message}"); }
                    }
                    var sensors = new List<SensorReading>();
                    foreach (var hardware in computer.Hardware)
                        Collect(hardware, hardware.Name, hardware.HardwareType == HardwareType.Cpu ? "CPU" : "GPU", sensors);
                    var snapshot = new Snapshot(SelectCpuTemperature(sensors), sensors.ToArray(), Environment.TickCount64);
                    lock (_gate)
                    {
                        if (_enabled && !_disposed) _latest = snapshot;
                    }
                }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine($"[Temperature] {ex.Message}");
                    Close(ref computer);
                }
                _wake.WaitOne(2000);
            }
        }
        finally
        {
            Close(ref computer);
            _wake.Dispose();
        }
    }

    private static void Collect(IHardware hardware, string deviceName, string kind, List<SensorReading> readings)
    {
        if (readings.Count >= 256) return;
        try
        {
            var updated = true;
            try { hardware.Update(); }
            catch { updated = false; }
            foreach (var sensor in hardware.Sensors)
            {
                if (readings.Count >= 256) break;
                if (sensor.SensorType != SensorType.Temperature) continue;
                // 已实测：缺 PawnIO/权限时 LHM 可 Open 但返回 0。禁止把它作为有效温度。
                double? value = updated && sensor.Value is float temperature && temperature > 0 && temperature < 150
                    ? Math.Round(temperature, 1) : null;
                readings.Add(new(sensor.Identifier.ToString(), deviceName, kind, sensor.Name, value));
            }
            foreach (var child in hardware.SubHardware) Collect(child, deviceName, kind, readings);
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"[Temperature] {hardware.Identifier}: {ex.Message}");
        }
    }

    private static double SelectCpuTemperature(List<SensorReading> sensors)
    {
        var candidates = sensors.Where(sensor => sensor.Kind == "CPU" && sensor.Value.HasValue).ToArray();
        foreach (var preferred in new[] { "CPU Package", "Tctl/Tdie", "CPU (Tctl/Tdie)", "Core Max" })
        {
            var sensor = candidates.FirstOrDefault(sensor => sensor.Name.Contains(preferred, StringComparison.OrdinalIgnoreCase));
            if (sensor != null) return sensor.Value!.Value;
        }
        return candidates.Length == 0 ? 0 : candidates.Max(sensor => sensor.Value!.Value);
    }

    private static void Close(ref Computer? computer)
    {
        try { computer?.Close(); }
        catch (Exception ex) { System.Diagnostics.Debug.WriteLine($"[Temperature] Close: {ex.Message}"); }
        finally { computer = null; }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
            _enabled = false;
            _latest = new(0, [], 0);
            if (_worker == null) _wake.Dispose();
            else _wake.Set();
        }
    }
}
