using System;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace FloatingWindow
{
    /// <summary>
    /// WebSocket 客户端，连接到主程序的 MessageBridge
    /// </summary>
    public class WebSocketClient
    {
        private ClientWebSocket? _client;
        private CancellationTokenSource? _cancellationTokenSource;
        private Task? _receiveTask;
        private readonly string _url;
        private bool _isReconnecting = false;

        public event Action<string, JsonElement>? OnEvent;
        public event Action<string>? OnLog;
        public event Action? OnConnected;
        public event Action? OnDisconnected;
        public event Action? OnConnectionLost; // 连接丢失且无法恢复

        public bool IsConnected => _client?.State == WebSocketState.Open;

        public WebSocketClient(string url = "ws://localhost:5000")
        {
            _url = url;
        }

        /// <summary>
        /// 连接到 WebSocket 服务器
        /// </summary>
        public async Task<bool> ConnectAsync()
        {
            try
            {
                _client = new ClientWebSocket();
                _cancellationTokenSource = new CancellationTokenSource();

                OnLog?.Invoke($"Connecting to {_url}...");
                await _client.ConnectAsync(new Uri(_url), _cancellationTokenSource.Token);
                OnLog?.Invoke($"Connected to WebSocket server, State: {_client.State}");

                OnConnected?.Invoke();

                // 启动接收循环
                _receiveTask = Task.Run(() => ReceiveLoop(_cancellationTokenSource.Token));

                return true;
            }
            catch (Exception ex)
            {
                OnLog?.Invoke($"Connection failed: {ex.Message}");
                return false;
            }
        }

        /// <summary>
        /// 断开连接
        /// </summary>
        public async Task DisconnectAsync()
        {
            try
            {
                _cancellationTokenSource?.Cancel();

                if (_client?.State == WebSocketState.Open)
                {
                    await _client.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closing", CancellationToken.None);
                }

                _receiveTask?.Wait(1000);
                _client?.Dispose();
                _client = null;

                OnDisconnected?.Invoke();
                OnLog?.Invoke("Disconnected from WebSocket server");
            }
            catch (Exception ex)
            {
                OnLog?.Invoke($"Disconnect error: {ex.Message}");
            }
        }

        /// <summary>
        /// 发送消息到服务器（使用主程序的 Message 格式）
        /// </summary>
        public async Task<bool> SendAsync(string module, string cmd, object? data = null)
        {
            if (_client?.State != WebSocketState.Open)
            {
                OnLog?.Invoke("Cannot send: not connected");
                return false;
            }

            try
            {
                // 使用主程序的 Message 格式
                var message = new
                {
                    v = 1,
                    id = Guid.NewGuid().ToString("N")[..8],
                    target = 0, // Target.Host
                    type = 0,   // MsgType.Request
                    mod = module == "System" ? 0 : 1,  // Module.System = 0
                    cmd = cmd,
                    data = data,
                    ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                };

                var json = JsonSerializer.Serialize(message);
                var bytes = Encoding.UTF8.GetBytes(json);

                await _client.SendAsync(
                    new ArraySegment<byte>(bytes),
                    WebSocketMessageType.Text,
                    true,
                    CancellationToken.None);

                OnLog?.Invoke($"Sent: {module}.{cmd}");
                return true;
            }
            catch (Exception ex)
            {
                OnLog?.Invoke($"Send error: {ex.Message}");
                return false;
            }
        }

        /// <summary>
        /// 接收消息循环
        /// </summary>
        private async Task ReceiveLoop(CancellationToken cancellationToken)
        {
            var buffer = new byte[8192];

            try
            {
                while (_client != null && _client.State == WebSocketState.Open && !cancellationToken.IsCancellationRequested)
                {
                    var result = await _client.ReceiveAsync(new ArraySegment<byte>(buffer), cancellationToken);

                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        OnLog?.Invoke("Server closed connection");
                        break;
                    }

                    if (result.MessageType == WebSocketMessageType.Text)
                    {
                        var json = Encoding.UTF8.GetString(buffer, 0, result.Count);
                        OnLog?.Invoke($"Received: {json}");

                        try
                        {
                            var doc = JsonDocument.Parse(json);
                            var root = doc.RootElement;

                            // 检查是否是 Event 类型的消息 (type = 2)
                            if (root.TryGetProperty("type", out var msgType) && msgType.GetInt32() == 2)
                            {
                                // 这是一个事件消息，提取 cmd 和 data
                                if (root.TryGetProperty("cmd", out var cmdElement))
                                {
                                    var eventName = cmdElement.GetString() ?? "";
                                    var data = root.TryGetProperty("data", out var dataElement)
                                        ? dataElement
                                        : new JsonElement();

                                    OnLog?.Invoke($"Event received: {eventName}");
                                    OnEvent?.Invoke(eventName, data);
                                }
                            }
                        }
                        catch (Exception ex)
                        {
                            OnLog?.Invoke($"Parse error: {ex.Message}");
                        }
                    }
                }
            }
            catch (OperationCanceledException)
            {
                OnLog?.Invoke("Receive loop cancelled");
            }
            catch (Exception ex)
            {
                OnLog?.Invoke($"Receive error: {ex.Message}");
            }

            OnDisconnected?.Invoke();

            // 连接断开后尝试重连
            if (!cancellationToken.IsCancellationRequested)
            {
                _ = TryReconnectAsync();
            }
        }

        /// <summary>
        /// 尝试重新连接
        /// </summary>
        private async Task TryReconnectAsync()
        {
            if (_isReconnecting)
            {
                return;
            }

            _isReconnecting = true;
            OnLog?.Invoke("Connection lost, attempting to reconnect...");

            const int maxRetries = 20;     // ~10s
            const int retryDelayMs = 500;

            for (int i = 0; i < maxRetries; i++)
            {
                OnLog?.Invoke($"Reconnection attempt {i + 1}/{maxRetries}...");
                await Task.Delay(retryDelayMs);

                if (await ConnectAsync())
                {
                    OnLog?.Invoke("Reconnected successfully");
                    _isReconnecting = false;
                    return;
                }
            }

            // 重连失败
            OnLog?.Invoke("Failed to reconnect after multiple attempts");
            _isReconnecting = false;
            OnConnectionLost?.Invoke();
        }
    }
}
