using System.Collections.Concurrent;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace FloatingWindow
{
    /// <summary>
    /// WebSocket 客户端，连接到主程序的 MessageBridge。
    /// </summary>
    public class WebSocketClient
    {
        private readonly string _url;
        private readonly SemaphoreSlim _connectGate = new(1, 1);
        private readonly SemaphoreSlim _sendGate = new(1, 1);
        private readonly ConcurrentDictionary<string, TaskCompletionSource<WebSocketResponse>> _pendingRequests = new();
        private ClientWebSocket? _client;
        private CancellationTokenSource? _cancellationTokenSource;
        private Task? _receiveTask;
        private int _isReconnecting;
        private bool _isStopping;

        public event Action<string, JsonElement>? OnEvent;
        public event Action<string>? OnLog;
        public event Action? OnConnected;
        public event Action? OnDisconnected;
        public event Action? OnConnectionLost;

        public bool IsConnected => _client?.State == WebSocketState.Open;

        public WebSocketClient(string url = "ws://localhost:5000")
        {
            _url = url;
        }

        public async Task<bool> ConnectAsync()
        {
            await _connectGate.WaitAsync();
            try
            {
                if (_client?.State == WebSocketState.Open)
                {
                    return true;
                }

                _client?.Dispose();
                _cancellationTokenSource?.Dispose();

                var client = new ClientWebSocket();
                var cancellationTokenSource = new CancellationTokenSource();
                try
                {
                    OnLog?.Invoke($"Connecting to {_url}...");
                    using var connectTimeout = CancellationTokenSource.CreateLinkedTokenSource(
                        cancellationTokenSource.Token);
                    connectTimeout.CancelAfter(TimeSpan.FromSeconds(3));
                    await client.ConnectAsync(new Uri(_url), connectTimeout.Token);

                    _client = client;
                    _cancellationTokenSource = cancellationTokenSource;
                    _isStopping = false;
                    _receiveTask = Task.Run(() => ReceiveLoopAsync(client, cancellationTokenSource.Token));
                    OnLog?.Invoke($"Connected to WebSocket server, State: {client.State}");
                    OnConnected?.Invoke();
                    return true;
                }
                catch (Exception ex)
                {
                    client.Dispose();
                    cancellationTokenSource.Dispose();
                    OnLog?.Invoke($"Connection failed: {ex.Message}");
                    return false;
                }
            }
            finally
            {
                _connectGate.Release();
            }
        }

        public async Task DisconnectAsync()
        {
            _isStopping = true;
            var client = _client;
            var cancellationTokenSource = _cancellationTokenSource;
            try
            {
                if (client?.State == WebSocketState.Open)
                {
                    using var closeTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                    await client.CloseAsync(
                        WebSocketCloseStatus.NormalClosure,
                        "Closing",
                        closeTimeout.Token);
                }
            }
            catch (Exception ex)
            {
                OnLog?.Invoke($"Disconnect error: {ex.Message}");
            }
            finally
            {
                cancellationTokenSource?.Cancel();
                FailPendingRequests("WebSocket disconnected");
                OnLog?.Invoke("Disconnected from WebSocket server");
            }
        }

        public async Task<WebSocketResponse?> SendRequestAsync(
            string module,
            string cmd,
            object? data = null,
            int timeoutMs = 3000)
        {
            var client = _client;
            if (client?.State != WebSocketState.Open)
            {
                OnLog?.Invoke("Cannot send: not connected");
                return null;
            }

            var id = Guid.NewGuid().ToString("N")[..8];
            var completion = new TaskCompletionSource<WebSocketResponse>(
                TaskCreationOptions.RunContinuationsAsynchronously);
            if (!_pendingRequests.TryAdd(id, completion))
            {
                return null;
            }

            try
            {
                using var requestTimeout = new CancellationTokenSource(
                    TimeSpan.FromMilliseconds(timeoutMs));
                var message = new
                {
                    v = 1,
                    id,
                    target = 0,
                    type = 0,
                    mod = module == "System" ? 0 : 1,
                    cmd,
                    data,
                    ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                };
                var json = JsonSerializer.Serialize(message);
                if (!await SendTextAsync(client, json, requestTimeout.Token))
                {
                    return null;
                }

                return await completion.Task.WaitAsync(requestTimeout.Token);
            }
            catch (OperationCanceledException)
            {
                OnLog?.Invoke($"Request timed out: {module}.{cmd}");
                return null;
            }
            finally
            {
                _pendingRequests.TryRemove(id, out _);
            }
        }

        private async Task<bool> SendTextAsync(
            ClientWebSocket client,
            string json,
            CancellationToken cancellationToken)
        {
            var bytes = Encoding.UTF8.GetBytes(json);
            await _sendGate.WaitAsync(cancellationToken);
            try
            {
                if (client.State != WebSocketState.Open)
                {
                    return false;
                }

                await client.SendAsync(
                    new ArraySegment<byte>(bytes),
                    WebSocketMessageType.Text,
                    true,
                    cancellationToken);
                return true;
            }
            catch (Exception ex)
            {
                OnLog?.Invoke($"Send error: {ex.Message}");
                return false;
            }
            finally
            {
                _sendGate.Release();
            }
        }

        private async Task ReceiveLoopAsync(ClientWebSocket client, CancellationToken cancellationToken)
        {
            var buffer = new byte[8192];
            try
            {
                while (client.State == WebSocketState.Open && !cancellationToken.IsCancellationRequested)
                {
                    using var payload = new MemoryStream();
                    WebSocketReceiveResult result;
                    do
                    {
                        result = await client.ReceiveAsync(new ArraySegment<byte>(buffer), cancellationToken);
                        if (result.MessageType == WebSocketMessageType.Close)
                        {
                            OnLog?.Invoke("Server closed connection");
                            return;
                        }

                        payload.Write(buffer, 0, result.Count);
                        if (payload.Length > 1024 * 1024)
                        {
                            throw new InvalidDataException("WebSocket message exceeds 1 MiB");
                        }
                    }
                    while (!result.EndOfMessage);

                    if (result.MessageType == WebSocketMessageType.Text)
                    {
                        HandleIncomingMessage(Encoding.UTF8.GetString(payload.ToArray()));
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
            finally
            {
                FailPendingRequests("WebSocket connection closed");
                OnDisconnected?.Invoke();
                if (!_isStopping && !cancellationToken.IsCancellationRequested)
                {
                    _ = TryReconnectAsync();
                }
            }
        }

        private void HandleIncomingMessage(string json)
        {
            try
            {
                using var document = JsonDocument.Parse(json);
                var root = document.RootElement;
                if (!root.TryGetProperty("type", out var typeProperty))
                {
                    return;
                }

                var messageType = typeProperty.GetInt32();
                if (messageType == 1 &&
                    root.TryGetProperty("id", out var idProperty) &&
                    _pendingRequests.TryGetValue(idProperty.GetString() ?? string.Empty, out var completion))
                {
                    var response = new WebSocketResponse(
                        root.TryGetProperty("code", out var codeProperty) ? codeProperty.GetInt32() : -1,
                        root.TryGetProperty("msg", out var messageProperty) ? messageProperty.GetString() : null,
                        root.TryGetProperty("data", out var dataProperty) ? dataProperty.Clone() : null);
                    completion.TrySetResult(response);
                    return;
                }

                if (messageType == 2 && root.TryGetProperty("cmd", out var commandProperty))
                {
                    var eventName = commandProperty.GetString() ?? string.Empty;
                    var data = root.TryGetProperty("data", out var dataProperty)
                        ? dataProperty.Clone()
                        : default;
                    OnEvent?.Invoke(eventName, data);
                }
            }
            catch (Exception ex)
            {
                OnLog?.Invoke($"Parse error: {ex.Message}");
            }
        }

        private void FailPendingRequests(string message)
        {
            foreach (var request in _pendingRequests.Values)
            {
                request.TrySetResult(new WebSocketResponse(-1, message, null));
            }
        }

        private async Task TryReconnectAsync()
        {
            if (Interlocked.Exchange(ref _isReconnecting, 1) != 0)
            {
                return;
            }

            try
            {
                OnLog?.Invoke("Connection lost, attempting to reconnect...");
                const int maxRetries = 20;
                const int retryDelayMs = 500;
                for (var attempt = 0; attempt < maxRetries && !_isStopping; attempt++)
                {
                    await Task.Delay(retryDelayMs);
                    if (await ConnectAsync())
                    {
                        OnLog?.Invoke("Reconnected successfully");
                        return;
                    }
                }

                if (!_isStopping)
                {
                    OnLog?.Invoke("Failed to reconnect after multiple attempts");
                    OnConnectionLost?.Invoke();
                }
            }
            finally
            {
                Interlocked.Exchange(ref _isReconnecting, 0);
            }
        }
    }

    public sealed record WebSocketResponse(int Code, string? Message, JsonElement? Data);
}
