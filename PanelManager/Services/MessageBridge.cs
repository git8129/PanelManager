using Fleck;
using PanelManager.Models;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO.Ports;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace PanelManager.Services
{
    public class MessageBridge : IDisposable
    {
        private readonly object _wsLock = new();
        private WebSocketServer? _wsServer;
        private SerialPort? _serialPort;
        private readonly List<IWebSocketConnection> _webClients = new();
        private readonly Dictionary<string, Func<Message, Task<Message>>> _hostHandlers = new();
        private string _serialBuffer = string.Empty;
        private const int SerialTxQueueCapacity = 64;
        private readonly SerialTxRingQueue _serialTxQueue = new(SerialTxQueueCapacity);
        private readonly AutoResetEvent _serialTxSignal = new(false);
        private CancellationTokenSource? _serialWorkerCts;
        private Task? _serialWorkerTask;

        // 等待设备响应的队列
        private readonly ConcurrentDictionary<string, TaskCompletionSource<Message?>> _pendingResponses = new();

        // 网速监控订阅
        //private Timer? _networkStatsTimer;
        //private bool _networkStatsSubscribed = false;
        private long _lastBytesSent = 0;
        private long _lastBytesReceived = 0;
        private long _lastTimestamp = 0;

        // 性能监控订阅
        private Timer? _performanceTimer;
        private bool _performanceSubscribed = false;
        private System.Diagnostics.PerformanceCounter? _cpuCounter;
        private System.Diagnostics.PerformanceCounter? _ramCounter;

        // 自动重连控制
        private Timer? _autoReconnectTimer;
        private bool _autoReconnectEnabled = false;
        private string? _lastConnectedPort;
        private bool _isConnecting = false;
        private bool _deviceAuthenticated = false;
        private bool _authInProgress = false;
        private long _authStartedAtMs = 0;
        private TaskCompletionSource<Message?>? _pendingChallenge;
        private TaskCompletionSource<Message?>? _pendingAuthentication;
        private System.Text.Json.JsonElement? _lastAuthChallengeData;

        private const string DeviceAuthProduct = "PanelLinkDevice";
        private const string DeviceAuthHost = "PanelLinkHost";
        private const string DeviceAuthSecret = "PanelLinkAuth:v1";
        private const string DeviceUsbVid = "3654";
        private static readonly string[] DeviceUsbPids = { "5B55", "4155" };

        public event Action<string>? OnLog;
        public event Action? OnWebSocketClientConnected;
        public event Action? OnWebSocketClientDisconnected;
        public bool IsSerialOpen => _serialPort?.IsOpen ?? false;
        public bool IsSerialConnected => IsSerialOpen && _deviceAuthenticated;
        public string? CurrentPort => _serialPort?.PortName;

        #region 启动/停止

        public void StartWebSocket(int port = 5000)
        {
            lock (_wsLock)
            {
                if (_wsServer != null)
                {
                    Log($"[WS] 服务器已启动(跳过重复启动): ws://0.0.0.0:{port}");
                    return;
                }

                try
                {
                    _wsServer = new WebSocketServer($"ws://0.0.0.0:{port}");
                    _wsServer.Start(socket =>
                    {
                        socket.OnOpen = () =>
                        {
                            _webClients.Add(socket);
                            Log($"[WS] 客户端连接: {socket.ConnectionInfo.ClientIpAddress}");

                            // 发送当前状态
                            var status = GetStatus();
                            socket.Send(Message.Event(Target.Host, Module.System, "status", status).ToJson());

                            // 通知外部：有客户端连接（用于悬浮窗重发 show 等）
                            try { OnWebSocketClientConnected?.Invoke(); } catch { }
                        };

                        socket.OnClose = () =>
                        {
                            _webClients.Remove(socket);
                            Log($"[WS] 客户端断开: {socket.ConnectionInfo.ClientIpAddress}");
                            try { OnWebSocketClientDisconnected?.Invoke(); } catch { }
                        };

                        socket.OnMessage = async msg => await HandleWebMessage(socket, msg);
                    });

                    Log($"[WS] 服务器已启动: ws://0.0.0.0:{port}");
                }
                catch (Exception ex)
                {
                    Log($"[WS] 服务器启动失败: {ex.Message}");
                    _wsServer?.Dispose();
                    _wsServer = null;
                }
            }
        }

        public bool OpenSerial(SerialConfig config)
        {
            try
            {
                CloseSerial();
                _deviceAuthenticated = false;

                _serialPort = new SerialPort
                {
                    PortName = config.Port,
                    BaudRate = config.BaudRate,
                    DataBits = config.DataBits,
                    StopBits = config.StopBits switch
                    {
                        1 => System.IO.Ports.StopBits.One,
                        2 => System.IO.Ports.StopBits.Two,
                        _ => System.IO.Ports.StopBits.One
                    },
                    Parity = config.Parity.ToLower() switch
                    {
                        "odd" => System.IO.Ports.Parity.Odd,
                        "even" => System.IO.Ports.Parity.Even,
                        _ => System.IO.Ports.Parity.None
                    },
                    // CDC/虚拟串口：尽早拉起控制线，触发设备端完成端点初始化
                    DtrEnable = true,
                    RtsEnable = true,
                    // 下位机协议(JSON)按 UTF-8 发送；否则中文会乱码
                    Encoding = Encoding.UTF8,
                    ReadTimeout = 500,
                    WriteTimeout = 500
                };

                _serialPort.Open();

                // 清掉打开瞬间可能残留/插入的零散数据，避免第一条协议消息被拼接成“尾巴”
                _serialPort.DiscardInBuffer();
                _serialPort.DiscardOutBuffer();
                _serialBuffer = string.Empty;
                _serialTxQueue.Clear();
                _serialWorkerCts = new CancellationTokenSource();
                _serialWorkerTask = Task.Run(() => SerialWorkerLoop(_serialWorkerCts.Token));

                Log($"[Serial] 已打开: {config.Port} @ {config.BaudRate}");
                BroadcastEvent(Module.Serial, "opened", new { port = config.Port, baudRate = config.BaudRate });
                return true;
            }
            catch (Exception ex)
            {
                try { _serialPort?.Dispose(); } catch { }
                _serialPort = null;
                _serialBuffer = string.Empty;
                _serialTxQueue.Clear();
                Log($"[Serial] 打开失败: {ex.Message}");
                return false;
            }
        }

        public void CloseSerial()
        {
            if (_serialPort != null)
            {
                var portObj = _serialPort;
                var port = portObj.PortName;
                var workerCts = _serialWorkerCts;
                var workerTask = _serialWorkerTask;

                _serialPort = null;
                _serialWorkerCts = null;
                _serialWorkerTask = null;
                workerCts?.Cancel();
                _serialTxSignal.Set();
                try { workerTask?.Wait(1000); } catch { }
                workerCts?.Dispose();

                if (portObj.IsOpen) portObj.Close();
                portObj.Dispose();
                _serialPort = null;
                _serialBuffer = string.Empty;
                _serialTxQueue.Clear();
                _deviceAuthenticated = false;
                _authInProgress = false;
                _authStartedAtMs = 0;
                _pendingChallenge?.TrySetResult(null);
                _pendingChallenge = null;
                _pendingAuthentication?.TrySetResult(null);
                _pendingAuthentication = null;
                _lastAuthChallengeData = null;

                Log($"[Serial] 已关闭: {port}");
                BroadcastEvent(Module.Serial, "closed", null);
            }
        }

        public void Stop()
        {
            StopAutoReconnect();
            CloseSerial();
            StopPerformanceMonitoring();
            _wsServer?.Dispose();
            _wsServer = null;
            _webClients.Clear();
            Log("[System] 服务已停止");
        }

        #endregion

        #region 自动重连

        public void StartAutoReconnect()
        {
            if (_autoReconnectEnabled) return;
            
            _autoReconnectEnabled = true;
            // 每3秒执行一次检查/重连
            _autoReconnectTimer = new Timer(async _ => await AutoReconnectCheck(), null, 0, 3000);
            Log("[Serial] 自动重连已启动");
        }

        public void StopAutoReconnect()
        {
            _autoReconnectEnabled = false;
            _autoReconnectTimer?.Dispose();
            _autoReconnectTimer = null;
            Log("[Serial] 自动重连已停止");
        }

        public string[] GetPanelLinkSerialPorts()
        {
            var serialPorts = SerialPort.GetPortNames()
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();
            var matchedPorts = GetPanelLinkSerialPortsFromRegistry(serialPorts);

            if (matchedPorts.Count == 0 && serialPorts.Length > 0)
            {
                Log("[Serial] 未找到匹配 VID/PID 的 PanelLink 串口");
            }

            return serialPorts
                .Where(port => matchedPorts.Contains(port))
                .OrderBy(port => port, StringComparer.OrdinalIgnoreCase)
                .ToArray();
        }

        private static HashSet<string> GetPanelLinkSerialPortsFromRegistry(string[] serialPorts)
        {
            var matchedPorts = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            try
            {
                using var usbRoot = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Enum\USB");
                if (usbRoot == null) return matchedPorts;

                foreach (var deviceKeyName in usbRoot.GetSubKeyNames())
                {
                    if (!IsPanelLinkDeviceKey(deviceKeyName)) continue;

                    using var deviceKey = usbRoot.OpenSubKey(deviceKeyName);
                    if (deviceKey == null) continue;

                    foreach (var instanceKeyName in deviceKey.GetSubKeyNames())
                    {
                        using var parametersKey = deviceKey.OpenSubKey($@"{instanceKeyName}\Device Parameters");
                        var port = parametersKey?.GetValue("PortName") as string;
                        if (string.IsNullOrWhiteSpace(port)) continue;

                        if (serialPorts.Contains(port, StringComparer.OrdinalIgnoreCase))
                        {
                            matchedPorts.Add(port);
                        }
                    }
                }
            }
            catch
            {
                // VID/PID filtering is best-effort; callers will see an empty match set.
            }

            return matchedPorts;
        }

        private static bool IsPanelLinkDeviceKey(string deviceKeyName)
        {
            if (string.IsNullOrWhiteSpace(deviceKeyName)) return false;

            var upper = deviceKeyName.ToUpperInvariant();
            if (!upper.Contains($"VID_{DeviceUsbVid}", StringComparison.Ordinal)) return false;

            return DeviceUsbPids.Any(pid =>
                upper.Contains($"PID_{pid}", StringComparison.Ordinal));
        }

        private async Task AutoReconnectCheck()
        {
            if (_isConnecting) return;

            try
            {
                // 情况1：串口应该打开但目前关闭了
                if (IsSerialOpen && (!_serialPort?.IsOpen ?? true))
                {
                    Log($"[Serial] 检测到连接断开: {_serialPort?.PortName ?? "unknown"}");
                    CloseSerial();
                    BroadcastEvent(Module.Serial, "disconnected", null);
                }

                // 情况2：串口未连接，尝试重连
                if (!IsSerialOpen)
                {
                    _isConnecting = true;

                    var ports = GetPanelLinkSerialPorts();
                    if (ports.Length == 0)
                    {
                        _isConnecting = false;
                        return;
                    }

                    // 优先尝试上次连接的端口
                    if (!string.IsNullOrEmpty(_lastConnectedPort) && ports.Contains(_lastConnectedPort))
                    {
                        if (await TryConnectPort(_lastConnectedPort))
                        {
                            _isConnecting = false;
                            return;
                        }
                    }

                    // 尝试所有其他端口
                    foreach (var port in ports)
                    {
                        if (port == _lastConnectedPort) continue;

                        if (await TryConnectPort(port))
                        {
                            _isConnecting = false;
                            return;
                        }
                    }

                    _isConnecting = false;
                }
            }
            catch (Exception ex)
            {
                Log($"[Serial] 自动重连错误: {ex.Message}");
                _isConnecting = false;
            }
        }

        private async Task<bool> TryConnectPort(string portName)
        {
            Log($"[Serial] 尝试连接: {portName}");

            if (OpenSerial(new SerialConfig { Port = portName }))
            {
                if (IsSerialConnected)
                {
                    return true;
                }

                var auth = await WaitForDeviceAuthenticationAsync(12000);
                if (auth != null || IsSerialConnected)
                {
                    Log($"[Serial] 连接验证成功: {portName}");
                    _lastConnectedPort = portName;
                    _deviceAuthenticated = true;
                    return true;
                }
                if (IsSerialConnected)
                {
                    return true;
                }
                else
                {

                    Log($"[Serial] 验证失败: {portName} (No Challenge)");
                    CloseSerial();
                }
            }
            return false;
        }

        private async Task<Message?> WaitForDeviceChallengeAsync(int timeoutMs)
        {
            if (_serialPort == null || !_serialPort.IsOpen) return null;

            var tcs = new TaskCompletionSource<Message?>(TaskCreationOptions.RunContinuationsAsynchronously);
            _pendingChallenge = tcs;

            try
            {
                using var cts = new CancellationTokenSource(timeoutMs);
                cts.Token.Register(() => tcs.TrySetResult(null));
                return await tcs.Task;
            }
            finally
            {
                if (ReferenceEquals(_pendingChallenge, tcs))
                {
                    _pendingChallenge = null;
                }
            }
        }

        private async Task<Message?> WaitForDeviceAuthenticationAsync(int timeoutMs)
        {
            if (_serialPort == null || !_serialPort.IsOpen) return null;
            if (_deviceAuthenticated) return new Message { Module = Module.System, Cmd = "authKey", Code = ErrorCode.Success };

            var tcs = new TaskCompletionSource<Message?>(TaskCreationOptions.RunContinuationsAsynchronously);
            _pendingAuthentication = tcs;

            try
            {
                using var cts = new CancellationTokenSource(timeoutMs);
                cts.Token.Register(() => tcs.TrySetResult(null));
                return await tcs.Task;
            }
            finally
            {
                if (ReferenceEquals(_pendingAuthentication, tcs))
                {
                    _pendingAuthentication = null;
                }
            }
        }

        private static bool IsDeviceChallenge(Message msg)
        {
            if (msg.Target != Target.Host || msg.Type != MsgType.Event || msg.Module != Module.System || msg.Cmd != "challenge")
            {
                return false;
            }

            if (msg.Version != 1)
            {
                return false;
            }

            if (msg.Data == null)
            {
                return false;
            }

            var data = msg.Data.Value;
            if (data.ValueKind != System.Text.Json.JsonValueKind.Object)
            {
                return false;
            }

            if (data.TryGetProperty("product", out var product) &&
                product.ValueKind == System.Text.Json.JsonValueKind.String &&
                product.GetString() != DeviceAuthProduct)
            {
                return false;
            }

            if (!data.TryGetProperty("challenge", out var challenge) ||
                challenge.ValueKind != System.Text.Json.JsonValueKind.String ||
                string.IsNullOrWhiteSpace(challenge.GetString()))
            {
                return false;
            }

            if (data.TryGetProperty("proto", out var proto) &&
                proto.ValueKind == System.Text.Json.JsonValueKind.Number &&
                proto.TryGetInt32(out var protoVersion) && protoVersion != 1)
            {
                return false;
            }

            return true;
        }

        private async Task<bool> AuthenticateWithDeviceAsync(Message challenge)
        {
            if (!TryGetChallengeValue(challenge, out var challengeValue))
            {
                return false;
            }

            var auth = new Message
            {
                Version = 1,
                Id = challenge.Id,
                Target = Target.Device,
                Type = MsgType.Request,
                Module = Module.System,
                Cmd = "authKey",
                Data = System.Text.Json.JsonSerializer.SerializeToElement(new
                {
                    host = DeviceAuthHost,
                    key = ComputeAuthKey(challengeValue)
                }, JsonOptions.Default),
                Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            };

            _authInProgress = true;
            try
            {
                var response = await SendToDeviceAndWaitAsync(auth, 3000);
                return response != null && response.Type == MsgType.Response &&
                    response.Module == Module.System && response.Cmd == "authKey" &&
                    response.Code == ErrorCode.Success;
            }
            finally
            {
                _authInProgress = false;
            }
        }

        private async Task AuthenticateChallengeFromReceiveAsync(Message challenge)
        {
            if (_authInProgress || _deviceAuthenticated || _serialPort == null || !_serialPort.IsOpen)
            {
                return;
            }

            if (await AuthenticateWithDeviceAsync(challenge) && _serialPort != null && _serialPort.IsOpen)
            {
                _deviceAuthenticated = true;
                _lastConnectedPort = _serialPort.PortName;
                Log($"[Serial] 设备主动认证成功: {_serialPort.PortName}");
                BroadcastEvent(Module.Serial, "connected", new { port = _serialPort.PortName, auth = challenge.Data });
            }
        }

        private bool TryQueueAuthForChallenge(Message challenge)
        {
            if (_deviceAuthenticated || _serialPort == null || !_serialPort.IsOpen)
            {
                return false;
            }

            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (_authInProgress && now - _authStartedAtMs < 3000)
            {
                return false;
            }

            if (!TryGetChallengeValue(challenge, out var challengeValue))
            {
                return false;
            }

            var auth = new Message
            {
                Version = 1,
                Id = challenge.Id,
                Target = Target.Device,
                Type = MsgType.Request,
                Module = Module.System,
                Cmd = "authKey",
                Data = System.Text.Json.JsonSerializer.SerializeToElement(new
                {
                    host = DeviceAuthHost,
                    key = ComputeAuthKey(challengeValue)
                }, JsonOptions.Default),
                Timestamp = now
            };

            _authInProgress = true;
            _authStartedAtMs = now;
            if (!SendToDeviceInternal(auth.ToJson()))
            {
                _authInProgress = false;
                _authStartedAtMs = 0;
                return false;
            }

            Log($"[Serial] 已排队认证请求: {auth.Id}");
            return true;
        }

        private void HandleAuthResponse(Message msg)
        {
            _authInProgress = false;
            _authStartedAtMs = 0;

            if (msg.Code != ErrorCode.Success || _serialPort == null || !_serialPort.IsOpen)
            {
                return;
            }

            var wasAuthenticated = _deviceAuthenticated;
            _deviceAuthenticated = true;
            _lastConnectedPort = _serialPort.PortName;
            _pendingAuthentication?.TrySetResult(msg);

            if (!wasAuthenticated)
            {
                Log($"[Serial] 设备认证成功: {_serialPort.PortName}");
                BroadcastEvent(Module.Serial, "connected", new { port = _serialPort.PortName, auth = _lastAuthChallengeData });
            }
        }

        private static bool TryGetChallengeValue(Message msg, out string challenge)
        {
            challenge = string.Empty;
            if (msg.Data == null) return false;

            var data = msg.Data.Value;
            if (data.ValueKind != System.Text.Json.JsonValueKind.Object) return false;
            if (!data.TryGetProperty("challenge", out var value) || value.ValueKind != System.Text.Json.JsonValueKind.String) return false;

            challenge = value.GetString() ?? string.Empty;
            return !string.IsNullOrWhiteSpace(challenge);
        }

        private static string ComputeAuthKey(string challenge)
        {
            const uint fnvOffset = 2166136261u;
            const uint fnvPrime = 16777619u;

            var input = $"{DeviceAuthSecret}:{challenge}";
            var hash = fnvOffset;
            foreach (var b in Encoding.UTF8.GetBytes(input))
            {
                hash ^= b;
                hash *= fnvPrime;
            }

            return hash.ToString("x8");
        }

        #endregion

        #region 网速监控

        private void PushNetworkStats()
        {
            try
            {
                GetCurrentNetworkStats(out long currentBytesSent, out long currentBytesReceived);
                long currentTimestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

                // 计算速度 (字节/秒)
                double timeDiff = (currentTimestamp - _lastTimestamp) / 1000.0;

                long uploadSpeed = 0;
                long downloadSpeed = 0;

                if (timeDiff > 0)
                {
                    uploadSpeed = (long)((currentBytesSent - _lastBytesSent) / timeDiff);
                    downloadSpeed = (long)((currentBytesReceived - _lastBytesReceived) / timeDiff);
                }

                // 推送事件
                BroadcastEvent(Module.System, "networkStats", new
                {
                    upload = uploadSpeed,
                    download = downloadSpeed,
                    timestamp = currentTimestamp
                });

                // 更新基准值
                _lastBytesSent = currentBytesSent;
                _lastBytesReceived = currentBytesReceived;
                _lastTimestamp = currentTimestamp;
            }
            catch (Exception ex)
            {
                Log($"[Network] 获取网速失败: {ex.Message}");
            }
        }

        private void GetCurrentNetworkStats(out long totalBytesSent, out long totalBytesReceived)
        {
            totalBytesSent = 0;
            totalBytesReceived = 0;

            var interfaces = System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces();

            foreach (var ni in interfaces)
            {
                if (ni.OperationalStatus == System.Net.NetworkInformation.OperationalStatus.Up &&
                    ni.NetworkInterfaceType != System.Net.NetworkInformation.NetworkInterfaceType.Loopback)
                {
                    var stats = ni.GetIPv4Statistics();
                    totalBytesSent += stats.BytesSent;
                    totalBytesReceived += stats.BytesReceived;
                }
            }
        }

        #endregion

        #region 性能监控

        public void StartPerformanceMonitoring()
        {
            if (_performanceSubscribed) return;

            _performanceSubscribed = true;

            try
            {
                // 初始化性能计数器
                _cpuCounter = new System.Diagnostics.PerformanceCounter("Processor", "% Processor Time", "_Total");
                _ramCounter = new System.Diagnostics.PerformanceCounter("Memory", "Available MBytes");

                // 第一次调用 CPU 计数器（需要预热）
                _cpuCounter.NextValue();

                // 初始化网络监控基准值
                _lastTimestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                GetCurrentNetworkStats(out _lastBytesSent, out _lastBytesReceived);

                // 每2秒推送一次
                _performanceTimer = new Timer(_ => PushPerformanceStats(), null, 2000, 2000);
                Log("[Performance] 性能监控已启动（包含网络监控）");
            }
            catch (Exception ex)
            {
                Log($"[Performance] 启动失败: {ex.Message}");
                _performanceSubscribed = false;
            }
        }

        public void StopPerformanceMonitoring()
        {
            if (!_performanceSubscribed) return;

            _performanceSubscribed = false;
            _performanceTimer?.Dispose();
            _performanceTimer = null;

            _cpuCounter?.Dispose();
            _cpuCounter = null;

            _ramCounter?.Dispose();
            _ramCounter = null;

            Log("[Performance] 性能监控已停止");
        }

        private void PushPerformanceStats()
        {
            try
            {
                // 获取 CPU 使用率
                double cpuUsage = 0;
                if (_cpuCounter != null)
                {
                    cpuUsage = Math.Round(_cpuCounter.NextValue(), 1);
                }

                // 获取内存使用情况
                double memoryUsedGB = 0;
                double memoryTotalGB = 16.0; // 默认值
                double memoryPercent = 0;

                try
                {
                    var gcMemInfo = GC.GetGCMemoryInfo();
                    memoryTotalGB = Math.Round(gcMemInfo.TotalAvailableMemoryBytes / (1024.0 * 1024.0 * 1024.0), 2);

                    if (_ramCounter != null)
                    {
                        var availableMB = _ramCounter.NextValue();
                        var totalMB = memoryTotalGB * 1024;
                        var usedMB = totalMB - availableMB;
                        memoryUsedGB = Math.Round(usedMB / 1024.0, 2);
                        memoryPercent = Math.Round((usedMB / totalMB) * 100, 1);
                    }
                }
                catch { }

                // 获取温度（Windows 一般需要 WMI 或第三方库，这里设为 0 表示不可用）
                double temperature = 0;

                // 获取网络速度（合并到性能监控中）
                long uploadSpeed = 0;
                long downloadSpeed = 0;

                try
                {
                    GetCurrentNetworkStats(out long currentBytesSent, out long currentBytesReceived);
                    long currentTimestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

                    // 计算速度 (字节/秒)
                    double timeDiff = (currentTimestamp - _lastTimestamp) / 1000.0;

                    if (timeDiff > 0)
                    {
                        uploadSpeed = (long)((currentBytesSent - _lastBytesSent) / timeDiff);
                        downloadSpeed = (long)((currentBytesReceived - _lastBytesReceived) / timeDiff);
                    }

                    // 更新基准值
                    _lastBytesSent = currentBytesSent;
                    _lastBytesReceived = currentBytesReceived;
                    _lastTimestamp = currentTimestamp;
                }
                catch { }

                // 推送事件（包含网络数据）
                BroadcastEvent(Module.System, "performanceStats", new
                {
                    cpu = cpuUsage,
                    memory = new
                    {
                        used = memoryUsedGB,
                        total = memoryTotalGB,
                        percent = memoryPercent
                    },
                    temperature = temperature,
                    network = new
                    {
                        upload = uploadSpeed,
                        download = downloadSpeed
                    },
                    timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                });
            }
            catch (Exception ex)
            {
                Log($"[Performance] 获取性能数据失败: {ex.Message}");
            }
        }

        #endregion

        #region 消息处理

        private async Task HandleWebMessage(IWebSocketConnection socket, string raw)
        {
            Log($"[WS] 收到: {raw}");

            var msg = Message.FromJson(raw);
            if (msg == null)
            {
                socket.Send(new Message { Code = ErrorCode.InvalidRequest, Msg = "Invalid JSON" }.ToJson());
                return;
            }

            // 根据目标路由
            if (msg.Target == Target.Host)
            {
                // 发给上位机
                var response = await HandleHostMessage(msg);
                socket.Send(response.ToJson());
            }
            else if (msg.Target == Target.Device)
            {
                // 转发给下位机
                if (!SendToDevice(raw))
                {
                    socket.Send(msg.Fail(ErrorCode.SerialNotOpen, "Serial port not open").ToJson());
                }
            }
        }

        private async Task<Message> HandleHostMessage(Message msg)
        {
            var key = $"{msg.Module}:{msg.Cmd}";

            if (_hostHandlers.TryGetValue(key, out var handler))
            {
                try
                {
                    return await handler(msg);
                }
                catch (Exception ex)
                {
                    Log($"[Host] 处理错误: {ex.Message}");
                    return msg.Fail(ErrorCode.Unknown, ex.Message);
                }
            }

            return msg.Fail(ErrorCode.NotFound, $"Unknown command: {key}");
        }

        private void SerialWorkerLoop(CancellationToken token)
        {
            while (!token.IsCancellationRequested)
            {
                var port = _serialPort;
                if (port == null || !port.IsOpen) break;

                var didWork = false;

                try
                {
                    var data = port.ReadExisting();
                    if (!string.IsNullOrEmpty(data))
                    {
                        didWork = true;
                        ProcessSerialData(data);
                    }

                    for (var i = 0; i < 16 && _serialTxQueue.TryDequeue(out var json); i++)
                    {
                        didWork = true;
                        port.WriteLine(json);
                        Log($"[Serial] 发送: {json}");
                    }
                }
                catch (TimeoutException)
                {
                }
                catch (InvalidOperationException)
                {
                    break;
                }
                catch (Exception ex)
                {
                    Log($"[Serial] 工作线程错误: {ex.Message}");
                    Thread.Sleep(20);
                }

                if (!didWork)
                {
                    _serialTxSignal.WaitOne(5);
                }
            }
        }

        private void ProcessSerialData(string data)
        {
            try
            {
                if (string.IsNullOrEmpty(data)) return;

                _serialBuffer += data;

                // 尝试解析完整的 JSON 消息（以换行符分隔）
                while (true)
                {
                    var newlineIndex = _serialBuffer.IndexOf('\n');
                    if (newlineIndex < 0) break;

                    var line = _serialBuffer[..newlineIndex].Trim();
                    _serialBuffer = _serialBuffer[(newlineIndex + 1)..];

                    if (string.IsNullOrEmpty(line)) continue;

                    Log($"[Serial] 收到: {line}");

                    // 尝试解析为协议消息
                    var msg = Message.FromJson(line);
                    if (msg != null)
                    {
                        var isChallenge = IsDeviceChallenge(msg);
                        if (isChallenge)
                        {
                            _lastAuthChallengeData = msg.Data;
                            if (_pendingChallenge != null)
                            {
                                _pendingChallenge.TrySetResult(msg);
                            }

                            TryQueueAuthForChallenge(msg);
                        }

                        var isAuthResponse = msg.Type == MsgType.Response && msg.Module == Module.System && msg.Cmd == "authKey";
                        if (isAuthResponse)
                        {
                            HandleAuthResponse(msg);
                        }

                        // 检查是否有等待此消息的请求
                        if (!string.IsNullOrEmpty(msg.Id) && _pendingResponses.TryRemove(msg.Id, out var tcs))
                        {
                            // 完成等待的任务
                            tcs.TrySetResult(msg);
                        }
                        
                        // 是协议消息，转发给 Web。认证 challenge 仅用于内部握手，避免前端收到周期心跳噪声。
                        var isInternalAuth = msg.Module == Module.System && msg.Cmd == "authKey";
                        if (!isChallenge && !isInternalAuth)
                        {
                            BroadcastToWeb(line);
                        }
                    }
                    else
                    {
                        // 非协议消息，作为原始数据事件转发
                        BroadcastEvent(Module.Serial, "data", new { raw = line });
                    }
                }
            }
            catch (Exception ex)
            {
                Log($"[Serial] 读取错误: {ex.Message}");
            }
        }

        #endregion

        #region 发送消息

        public bool SendToDevice(string json)
        {
            if (!_deviceAuthenticated) return false;
            return SendToDeviceInternal(json);
        }

        public bool SendToDevice(Message msg)
        {
            if (_authInProgress && msg.Module == Module.System && msg.Cmd == "authKey")
            {
                return SendToDeviceInternal(msg.ToJson());
            }

            return SendToDevice(msg.ToJson());
        }

        private bool SendToDeviceInternal(string json)
        {
            if (_serialPort == null || !_serialPort.IsOpen) return false;

            if (!_serialTxQueue.TryEnqueue(json))
            {
                Log("[Serial] 发送队列已满");
                return false;
            }

            _serialTxSignal.Set();
            return true;
        }

        private sealed class SerialTxRingQueue
        {
            private readonly string?[] _items;
            private int _readSeq;
            private int _writeSeq;

            public SerialTxRingQueue(int capacity)
            {
                _items = new string?[capacity];
            }

            public bool TryEnqueue(string item)
            {
                while (true)
                {
                    var write = Volatile.Read(ref _writeSeq);
                    var read = Volatile.Read(ref _readSeq);
                    if (write - read >= _items.Length)
                    {
                        return false;
                    }

                    if (Interlocked.CompareExchange(ref _writeSeq, write + 1, write) == write)
                    {
                        Volatile.Write(ref _items[write % _items.Length], item);
                        return true;
                    }
                }
            }

            public bool TryDequeue(out string item)
            {
                var read = Volatile.Read(ref _readSeq);
                if (read >= Volatile.Read(ref _writeSeq))
                {
                    item = string.Empty;
                    return false;
                }

                var index = read % _items.Length;
                var value = Volatile.Read(ref _items[index]);
                if (value == null)
                {
                    item = string.Empty;
                    return false;
                }

                item = value;
                Volatile.Write(ref _items[index], null);
                Volatile.Write(ref _readSeq, read + 1);
                return true;
            }

            public void Clear()
            {
                Array.Clear(_items, 0, _items.Length);
                Volatile.Write(ref _readSeq, 0);
                Volatile.Write(ref _writeSeq, 0);
            }
        }

        /// <summary>
        /// 发送消息到设备并等待响应
        /// </summary>
        /// <param name="msg">要发送的消息</param>
        /// <param name="timeoutMs">超时时间（毫秒）</param>
        /// <returns>设备响应消息，超时返回null</returns>
        public async Task<Message?> SendToDeviceAndWaitAsync(Message msg, int timeoutMs = 2000)
        {
            if (_serialPort == null || !_serialPort.IsOpen) return null;

            var tcs = new TaskCompletionSource<Message?>();
            var msgId = msg.Id ?? Guid.NewGuid().ToString("N")[..8];
            msg.Id = msgId;

            // 注册等待响应
            _pendingResponses[msgId] = tcs;

            try
            {
                // 发送消息
                if (!SendToDevice(msg))
                {
                    _pendingResponses.TryRemove(msgId, out _);
                    return null;
                }

                // 等待响应或超时
                using var cts = new CancellationTokenSource(timeoutMs);
                cts.Token.Register(() => tcs.TrySetResult(null));

                return await tcs.Task;
            }
            finally
            {
                _pendingResponses.TryRemove(msgId, out _);
            }
        }

        public void BroadcastToWeb(string json)
        {
            foreach (var client in _webClients.ToList())
            {
                try
                {
                    client.Send(json);
                }
                catch (Exception ex)
                {
                    Log($"[WS] 广播失败: {ex.Message}");
                }
            }
        }

        public void BroadcastEvent(Module module, string cmd, object? data)
        {
            try
            {
                var msg = Message.Event(Target.Host, module, cmd, data);
                BroadcastToWeb(msg.ToJson());
            }
            catch (Exception ex)
            {
                Log($"[WS] 事件广播失败: {ex.Message}");
            }
        }

        #endregion

        #region 命令注册

        public void On(Module module, string cmd, Func<Message, Task<Message>> handler)
        {
            _hostHandlers[$"{module}:{cmd}"] = handler;
        }

        public void On(Module module, string cmd, Func<Message, Message> handler)
        {
            _hostHandlers[$"{module}:{cmd}"] = msg => Task.FromResult(handler(msg));
        }

        public void On(Module module, string cmd, Func<Message, object?> handler)
        {
            _hostHandlers[$"{module}:{cmd}"] = msg => Task.FromResult(msg.Ok(handler(msg)));
        }

        public void On(Module module, string cmd, Action<Message> handler)
        {
            _hostHandlers[$"{module}:{cmd}"] = msg =>
            {
                handler(msg);
                return Task.FromResult(msg.Ok());
            };
        }

        #endregion

        #region 辅助方法

        private object GetStatus()
        {
            return new
            {
                serial = new
                {
                    open = IsSerialConnected,
                    physicalOpen = IsSerialOpen,
                    port = CurrentPort,
                    authenticated = _deviceAuthenticated
                },
                version = "1.0.0",
                bootNotice = MessageBridgeText.GetBootNotice(),
#if DEBUG
                debug = true
#else
                debug = false
#endif
            };
        }

        private void Log(string message)
        {
            OnLog?.Invoke($"[{DateTime.Now:HH:mm:ss}] {message}");
        }

        public void Dispose() => Stop();

        #endregion
    }

    internal static class MessageBridgeText
    {
        public static string GetBootNotice()
        {
            return string.Concat(
                Decode(27426, 36814, 20351, 29992, 26234, 33021, 35302, 25511, 23631, 65292),
                Decode(26412, 36719, 20214, 20813, 36153, 25552, 20379, 20351, 29992, 65292),
                Decode(35831, 21247, 29992, 20110, 21830, 29992, 25110, 29279, 21033)
            );
        }

        private static string Decode(params int[] codes)
        {
            return new string(codes.Select(static code => (char)code).ToArray());
        }
    }
}
