using PanelManager.Models;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Collections.Concurrent;
using System.IO.Ports;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Drawing;
using System.Globalization;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using NAudio.CoreAudioApi;
using System.Runtime.InteropServices;

#if WINDOWS
using Windows.Media.Control;
#endif

namespace PanelManager.Services
{
    /// <summary>
    /// 上位机命令处理器
    /// </summary>
public static class HostCommandHandler
{
        private static readonly ConcurrentDictionary<string, TaskCompletionSource<bool>> _manualUpdateBootConfirmations = new();

        public static void Register(MessageBridge bridge, FloatingWindowManager floatingWindowManager, OpenCodeSidecarService openCode)
        {
            floatingWindowManager.AttachBridge(bridge);

            // 初始化SMTC监控
            InitializeSmtcMonitoring(bridge);

            // ===== System 模块 =====
            bridge.On(Module.System, "ping", _ => new { pong = true, time = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() });

            bridge.On(Module.System, "exit", msg =>
            {
                // 延迟退出，确保响应能发送出去
                Task.Run(async () =>
                {
                    await Task.Delay(200); // 等待 200ms 让响应发送完成

                    Environment.Exit(0);
                });

                return msg.Ok(new { message = "Application will exit" });
            });

            bridge.On(Module.System, "status", _ => new
            {
                serial = new { open = bridge.IsSerialConnected, physicalOpen = bridge.IsSerialOpen, port = bridge.CurrentPort },
                version = "1.0.0",
                bootNotice = MessageBridgeText.GetBootNotice()
            });

            // ===== AI (OpenCode sidecar) =====
            bridge.On(Module.System, "aiStart", async msg =>
            {
                try
                {
                    var data = msg.GetData<AiStartRequest>();
                    var snapshot = await openCode.EnsureStartedAsync(data?.Version, data?.ForceRestart ?? false);
                    return msg.Ok(snapshot);
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, ex.Message);
                }
            });

            bridge.On(Module.System, "aiStop", async msg =>
            {
                try
                {
                    await openCode.StopAsync();
                    return msg.Ok(new { stopped = true });
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, ex.Message);
                }
            });

            bridge.On(Module.System, "aiStatus", msg =>
            {
                try
                {
                    return msg.Ok(openCode.GetStatusSnapshot());
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, ex.Message);
                }
            });

            bridge.On(Module.System, "aiProviders", async msg =>
            {
                try
                {
                    var json = await openCode.GetJsonAsync("/provider");
                    return msg.Ok(json);
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, ex.Message);
                }
            });

            bridge.On(Module.System, "aiProviderAuth", async msg =>
            {
                try
                {
                    var json = await openCode.GetJsonAsync("/provider/auth");
                    return msg.Ok(json);
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, ex.Message);
                }
            });

            bridge.On(Module.System, "aiConfigProviders", async msg =>
            {
                try
                {
                    var json = await openCode.GetJsonAsync("/config/providers");
                    return msg.Ok(json);
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, ex.Message);
                }
            });

            bridge.On(Module.System, "aiConfigGet", async msg =>
            {
                try
                {
                    var json = await openCode.GetJsonAsync("/config");
                    return msg.Ok(json);
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, ex.Message);
                }
            });

            bridge.On(Module.System, "aiSetAuth", async msg =>
            {
                try
                {
                    var data = msg.GetData<AiAuthSetRequest>();
                    if (data == null || string.IsNullOrWhiteSpace(data.Id))
                    {
                        return msg.Fail(ErrorCode.InvalidParams, "Missing provider id");
                    }

                    if (data.Auth.ValueKind == System.Text.Json.JsonValueKind.Undefined || data.Auth.ValueKind == System.Text.Json.JsonValueKind.Null)
                    {
                        return msg.Fail(ErrorCode.InvalidParams, "Missing auth payload");
                    }

                    var ok = await openCode.PutAuthAsync(data.Id, data.Auth);
                    return msg.Ok(new { ok });
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, ex.Message);
                }
            });

            bridge.On(Module.System, "aiOauthAuthorize", async msg =>
            {
                try
                {
                    var data = msg.GetData<AiOauthAuthorizeRequest>();
                    if (data == null || string.IsNullOrWhiteSpace(data.Id))
                    {
                        return msg.Fail(ErrorCode.InvalidParams, "Missing provider id");
                    }

                    var payload = System.Text.Json.JsonSerializer.SerializeToElement(new { method = data.Method }, JsonOptions.Default);
                    var json = await openCode.PostJsonAsync($"/provider/{Uri.EscapeDataString(data.Id)}/oauth/authorize", payload);
                    return msg.Ok(json);
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, ex.Message);
                }
            });

            bridge.On(Module.System, "aiOauthCallback", async msg =>
            {
                try
                {
                    var data = msg.GetData<AiOauthCallbackRequest>();
                    if (data == null || string.IsNullOrWhiteSpace(data.Id))
                    {
                        return msg.Fail(ErrorCode.InvalidParams, "Missing provider id");
                    }

                    var payload = System.Text.Json.JsonSerializer.SerializeToElement(new
                    {
                        method = data.Method,
                        code = string.IsNullOrWhiteSpace(data.Code) ? null : data.Code.Trim()
                    }, JsonOptions.Default);

                    var json = await openCode.PostJsonAsync($"/provider/{Uri.EscapeDataString(data.Id)}/oauth/callback", payload);
                    return msg.Ok(json);
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, ex.Message);
                }
            });

            bridge.On(Module.System, "aiDisposeInstance", async msg =>
            {
                try
                {
                    var json = await openCode.PostNoBodyAsync("/instance/dispose");
                    return msg.Ok(json);
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, ex.Message);
                }
            });

             bridge.On(Module.System, "aiPermissionRespond", async msg =>
             {
                 try
                 {
                     var data = msg.GetData<AiPermissionRespondRequest>();
                     if (data == null || string.IsNullOrWhiteSpace(data.SessionId) || string.IsNullOrWhiteSpace(data.PermissionId))
                     {
                         return msg.Fail(ErrorCode.InvalidParams, "Missing sessionId/permissionId");
                     }
                     if (string.IsNullOrWhiteSpace(data.Response))
                     {
                         return msg.Fail(ErrorCode.InvalidParams, "Missing response");
                     }

                    var payload = System.Text.Json.JsonSerializer.SerializeToElement(new { response = data.Response }, JsonOptions.Default);
                    var path = $"/session/{Uri.EscapeDataString(data.SessionId)}/permissions/{Uri.EscapeDataString(data.PermissionId)}";
                     var json = await openCode.PostJsonAsync(path, payload);
                     return msg.Ok(json);
                 }
                 catch (Exception ex)
                 {
                     return msg.Fail(ErrorCode.Unknown, ex.Message);
                 }
             });

            bridge.On(Module.System, "aiPermissionList", async msg =>
            {
                try
                {
                    var json = await openCode.GetJsonAsync("/permission");
                    return msg.Ok(json);
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, ex.Message);
                }
            });

            bridge.On(Module.System, "aiPermissionReply", async msg =>
            {
                try
                {
                    var data = msg.GetData<AiPermissionReplyRequest>();
                    if (data == null || string.IsNullOrWhiteSpace(data.RequestId) || string.IsNullOrWhiteSpace(data.SessionId))
                    {
                        return msg.Fail(ErrorCode.InvalidParams, "Missing sessionId/requestId");
                    }
                    if (string.IsNullOrWhiteSpace(data.Reply))
                    {
                        return msg.Fail(ErrorCode.InvalidParams, "Missing reply");
                    }

                    var response = data.Reply.Trim().ToLowerInvariant();
                    if (response != "once" && response != "always" && response != "reject")
                    {
                        return msg.Fail(ErrorCode.InvalidParams, $"Unsupported reply: {data.Reply}");
                    }

                    var payload = System.Text.Json.JsonSerializer.SerializeToElement(new
                    {
                        response,
                        message = string.IsNullOrWhiteSpace(data.Message) ? null : data.Message.Trim()
                    }, JsonOptions.Default);
                    var path = $"/session/{Uri.EscapeDataString(data.SessionId.Trim())}/permissions/{Uri.EscapeDataString(data.RequestId.Trim())}";
                    var json = await openCode.PostJsonAsync(path, payload);
                    return msg.Ok(json);
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, ex.Message);
                }
            });

            bridge.On(Module.System, "aiQuestionList", async msg =>
            {
                try
                {
                    var json = await openCode.GetJsonAsync("/question");
                    return msg.Ok(json);
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, ex.Message);
                }
            });

            bridge.On(Module.System, "aiQuestionReply", async msg =>
            {
                try
                {
                    var data = msg.GetData<AiQuestionReplyRequest>();
                    if (data == null || string.IsNullOrWhiteSpace(data.RequestId))
                    {
                        return msg.Fail(ErrorCode.InvalidParams, "Missing requestId");
                    }
                    if (data.Answers == null)
                    {
                        return msg.Fail(ErrorCode.InvalidParams, "Missing answers");
                    }

                    var payload = System.Text.Json.JsonSerializer.SerializeToElement(new
                    {
                        answers = data.Answers
                    }, JsonOptions.Default);
                    var path = $"/question/{Uri.EscapeDataString(data.RequestId.Trim())}/reply";
                    var json = await openCode.PostJsonAsync(path, payload);
                    return msg.Ok(json);
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, ex.Message);
                }
            });

            bridge.On(Module.System, "aiQuestionReject", async msg =>
            {
                try
                {
                    var data = msg.GetData<AiQuestionRejectRequest>();
                    if (data == null || string.IsNullOrWhiteSpace(data.RequestId))
                    {
                        return msg.Fail(ErrorCode.InvalidParams, "Missing requestId");
                    }

                    var path = $"/question/{Uri.EscapeDataString(data.RequestId.Trim())}/reject";
                    var json = await openCode.PostNoBodyAsync(path);
                    return msg.Ok(json);
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, ex.Message);
                }
            });

            bridge.On(Module.System, "aiPatchConfig", async msg =>
            {
                try
                {
                    var patch = msg.Data.HasValue
                        ? msg.Data.Value
                        : System.Text.Json.JsonDocument.Parse("{}").RootElement.Clone();
                    var json = await openCode.PatchConfigAsync(patch);
                    return msg.Ok(json);
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, ex.Message);
                }
            });

            bridge.On(Module.System, "aiNewSession", async msg =>
            {
                try
                {
                    var data = msg.GetData<AiNewSessionRequest>();
                    var payload = System.Text.Json.JsonSerializer.SerializeToElement(new
                    {
                        title = string.IsNullOrWhiteSpace(data?.Title) ? null : data.Title.Trim()
                    }, JsonOptions.Default);

                    var json = await openCode.PostJsonAsync("/session", payload);
                    return msg.Ok(json);
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, ex.Message);
                }
            });

            bridge.On(Module.System, "aiSessionMessages", async msg =>
            {
                try
                {
                    var data = msg.GetData<AiSessionMessagesRequest>();
                    if (data == null || string.IsNullOrWhiteSpace(data.SessionId))
                    {
                        return msg.Fail(ErrorCode.InvalidParams, "Missing sessionId");
                    }

                    var sessionId = Uri.EscapeDataString(data.SessionId.Trim());
                    var path = $"/session/{sessionId}/message";
                    if (data.Limit.HasValue && data.Limit.Value > 0)
                    {
                        path += $"?limit={data.Limit.Value}";
                    }

                    var json = await openCode.GetJsonAsync(path);
                    return msg.Ok(json);
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, ex.Message);
                }
            });

            bridge.On(Module.System, "aiAbortSession", async msg =>
            {
                try
                {
                    var data = msg.GetData<AiSessionMessagesRequest>();
                    if (data == null || string.IsNullOrWhiteSpace(data.SessionId))
                    {
                        return msg.Fail(ErrorCode.InvalidParams, "Missing sessionId");
                    }

                    var sessionId = Uri.EscapeDataString(data.SessionId.Trim());
                    var json = await openCode.PostNoBodyAsync($"/session/{sessionId}/abort");
                    return msg.Ok(json);
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, ex.Message);
                }
            });

            bridge.On(Module.System, "aiSendMessage", async msg =>
            {
                try
                {
                    var data = msg.GetData<AiSendMessageRequest>();
                    if (data == null || string.IsNullOrWhiteSpace(data.SessionId))
                    {
                        return msg.Fail(ErrorCode.InvalidParams, "Missing sessionId");
                    }
                    if (string.IsNullOrWhiteSpace(data.Text))
                    {
                        return msg.Fail(ErrorCode.InvalidParams, "Missing text");
                    }

                    var parts = BuildPromptParts(data.Text, data.Attachments);

                    var payloadDict = new Dictionary<string, object?>
                    {
                        ["parts"] = parts
                    };

                    var agent = string.IsNullOrWhiteSpace(data.Agent) ? null : data.Agent.Trim();
                    if (!string.IsNullOrWhiteSpace(agent))
                    {
                        payloadDict["agent"] = agent;
                    }

                    var variant = string.IsNullOrWhiteSpace(data.Variant) ? null : data.Variant.Trim();
                    if (!string.IsNullOrWhiteSpace(variant))
                    {
                        payloadDict["variant"] = variant;
                    }

                    var messageID = string.IsNullOrWhiteSpace(data.MessageId) ? null : data.MessageId.Trim();
                    if (!string.IsNullOrWhiteSpace(messageID))
                    {
                        payloadDict["messageID"] = messageID;
                    }

                    if (TryParseModelKey(data.Model, out var providerID, out var modelID))
                    {
                        payloadDict["model"] = new { providerID, modelID };
                    }

                     var system = string.IsNullOrWhiteSpace(data.System) ? TryLoadAiSystemPrompt(openCode) : data.System;
                     if (!string.IsNullOrWhiteSpace(system))
                     {
                         payloadDict["system"] = system;
                     }

                    var payload = System.Text.Json.JsonSerializer.SerializeToElement(payloadDict, JsonOptions.Default);

                    var path = $"/session/{Uri.EscapeDataString(data.SessionId)}/message";
                    var json = await openCode.PostJsonAsync(path, payload);
                    return msg.Ok(json);
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, ex.Message);
                }
            });

            bridge.On(Module.System, "aiPromptAsync", async msg =>
            {
                try
                {
                    var data = msg.GetData<AiSendMessageRequest>();
                    if (data == null || string.IsNullOrWhiteSpace(data.SessionId))
                    {
                        return msg.Fail(ErrorCode.InvalidParams, "Missing sessionId");
                    }
                    if (string.IsNullOrWhiteSpace(data.Text))
                    {
                        return msg.Fail(ErrorCode.InvalidParams, "Missing text");
                    }

                    var parts = BuildPromptParts(data.Text, data.Attachments);
                    var payloadDict = new Dictionary<string, object?>
                    {
                        ["parts"] = parts
                    };

                    var agent = string.IsNullOrWhiteSpace(data.Agent) ? null : data.Agent.Trim();
                    if (!string.IsNullOrWhiteSpace(agent))
                    {
                        payloadDict["agent"] = agent;
                    }

                    var variant = string.IsNullOrWhiteSpace(data.Variant) ? null : data.Variant.Trim();
                    if (!string.IsNullOrWhiteSpace(variant))
                    {
                        payloadDict["variant"] = variant;
                    }

                    var messageID = string.IsNullOrWhiteSpace(data.MessageId) ? null : data.MessageId.Trim();
                    if (!string.IsNullOrWhiteSpace(messageID))
                    {
                        payloadDict["messageID"] = messageID;
                    }

                    if (TryParseModelKey(data.Model, out var providerID, out var modelID))
                    {
                        payloadDict["model"] = new { providerID, modelID };
                    }

                     var system = string.IsNullOrWhiteSpace(data.System) ? TryLoadAiSystemPrompt(openCode) : data.System;
                     if (!string.IsNullOrWhiteSpace(system))
                     {
                         payloadDict["system"] = system;
                     }

                    var payload = System.Text.Json.JsonSerializer.SerializeToElement(payloadDict, JsonOptions.Default);
                    var path = $"/session/{Uri.EscapeDataString(data.SessionId)}/prompt_async";
                    var ok = await openCode.PostJsonAllowEmptyAsync(path, payload);
                    return msg.Ok(ok);
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, ex.Message);
                }
            });

            // ===== 前端 → 悬浮窗命令（通过广播事件转发） =====
            bridge.On(Module.System, "enterFloating", async msg =>
            {
                try
                {
                    var ok = await floatingWindowManager.EnterFloatingAsync();
                    return ok
                        ? msg.Ok(new { floating = true })
                        : msg.Fail(ErrorCode.Busy, "无法进入悬浮模式");
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, $"Enter floating failed: {ex.Message}");
                }
            });

            // ===== 悬浮窗 → 主程序命令 =====
            bridge.On(Module.System, "floatingRestore", async msg =>
            {
                try
                {
                    var ok = await floatingWindowManager.RestoreFromFloatingAsync();
                    return ok
                        ? msg.Ok(new { restored = true })
                        : msg.Fail(ErrorCode.Busy, "恢复主窗口失败");
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, $"Restore failed: {ex.Message}");
                }
            });

            bridge.On(Module.System, "floatingExitAll", msg =>
            {
                bridge.BroadcastEvent(Module.System, "appExit", null);
                floatingWindowManager.Dispose();

                // 延迟退出，确保响应能发送出去
                Task.Run(async () =>
                {
                    await Task.Delay(200);
                    Microsoft.Maui.Controls.Application.Current?.Quit();
                });

                return msg.Ok(new { message = "Application will exit" });
            });

            bridge.On(Module.System, "subscribePerformance", msg =>
            {
                bridge.StartPerformanceMonitoring();
                return msg.Ok(new { subscribed = true });
            });

            bridge.On(Module.System, "unsubscribePerformance", msg =>
            {
                bridge.StopPerformanceMonitoring();
                return msg.Ok(new { subscribed = false });
            });

            bridge.On(Module.System, "getTime", _ => new
            {
                timestamp = DateTimeOffset.Now.ToUnixTimeMilliseconds(),
                year = DateTime.Now.Year,
                month = DateTime.Now.Month,
                day = DateTime.Now.Day,
                hour = DateTime.Now.Hour,
                minute = DateTime.Now.Minute,
                second = DateTime.Now.Second,
                dayOfWeek = (int)DateTime.Now.DayOfWeek,
                formatted = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss")
            });

            bridge.On(Module.System, "getWeather", async msg =>
            {
                var req = msg.GetData<WeatherRequest>();
                var forceRefresh = req?.Refresh ?? false;

                try
                {
                    var weather = await GetWeatherAsync(forceRefresh);
                    return msg.Ok(weather);
                }
                catch (Exception ex)
                {
                    var cached = GetCachedWeather();
                    if (cached != null)
                    {
                        return msg.Ok(cached);
                    }
                    return msg.Fail(ErrorCode.OperationFailed, $"Failed to get weather: {ex.Message}");
                }
            });

            bridge.On(Module.System, "setVolume", msg =>
            {
                var data = msg.GetData<VolumeRequest>();
                if (data == null || data.Volume < 0 || data.Volume > 100)
                {
                    return msg.Fail(ErrorCode.InvalidParams, "Invalid volume value (0-100)");
                }

                try
                {
                    SetSystemVolume(data.Volume);
                    return msg.Ok(new { volume = data.Volume });
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, $"Failed to set volume: {ex.Message}");
                }
            });

            bridge.On(Module.System, "getVolume", _ =>
            {
                try
                {
                    var volume = 0;// GetSystemVolume(); 未实现
                    return new { volume = volume };
                }
                catch (Exception ex)
                {
                    return new { volume = 0, error = ex.Message };
                }
            });

            bridge.On(Module.System, "setMute", msg =>
            {
                var data = msg.GetData<MuteRequest>();
                if (data == null)
                {
                    return msg.Fail(ErrorCode.InvalidParams, "Invalid mute parameter");
                }

                try
                {
                    SetSystemMute(data.Mute);
                    return msg.Ok(new { mute = data.Mute });
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, $"Failed to set mute: {ex.Message}");
                }
            });

            bridge.On(Module.System, "getMute", _ =>
            {
                try
                {
                    var mute = GetSystemMute();
                    return new { mute = mute };
                }
                catch (Exception ex)
                {
                    return new { mute = false, error = ex.Message };
                }
            });

            bridge.On(Module.System, "fullscreen", async msg =>
            {
                var data = msg.GetData<FullscreenRequest>();
                if (data == null)
                {
                    return msg.Fail(ErrorCode.InvalidParams, "缺少 enable 参数");
                }

                var (ok, error) = await floatingWindowManager.SetFullscreenAsync(data.Enable);
                if (ok)
                {
                    return msg.Ok(new { fullscreen = data.Enable });
                }

                return msg.Fail(ErrorCode.OperationFailed, $"Fullscreen failed: {error ?? "unknown"}");
            });

            bridge.On(Module.System, "switchToDeviceScreen", async msg =>
            {
#if WINDOWS
                var result = await WinUI.App.SwitchToDeviceScreenAsync();
                if (result.Ok)
                {
                    return msg.Ok(result);
                }

                return msg.Fail(ErrorCode.OperationFailed, result.Error ?? "切换设备屏幕失败");
#else
                await Task.Delay(0);
                return msg.Fail(ErrorCode.OperationFailed, "当前平台不支持设备屏幕切换");
#endif
            });

            bridge.On(Module.System, "restoreFromDeviceScreen", async msg =>
            {
#if WINDOWS
                var result = await WinUI.App.RestoreFromDeviceScreenAsync();
                if (result.Ok)
                {
                    return msg.Ok(new { restored = true });
                }

                return msg.Fail(ErrorCode.OperationFailed, result.Error ?? "恢复主窗口失败");
#else
                await Task.Delay(0);
                return msg.Fail(ErrorCode.OperationFailed, "当前平台不支持窗口恢复");
#endif
            });

            bridge.On(Module.System, "setNoActivate", async msg =>
            {
                var data = msg.GetData<NoActivateRequest>();
                if (data == null)
                {
                    return msg.Fail(ErrorCode.InvalidParams, "缺少 enable 参数");
                }

                var (ok, error) = await floatingWindowManager.SetNoActivateAsync(data.Enable);
                if (ok)
                {
                    return msg.Ok(new { noActivate = data.Enable });
                }

                return msg.Fail(ErrorCode.OperationFailed, $"SetNoActivate failed: {error ?? "unknown"}");
            });

            bridge.On(Module.System, "getMicrophoneStatus", _ =>
            {
                try
                {
                    var muted = GetMicrophoneMute();
                    return new { enabled = !muted };
                }
                catch (Exception ex)
                {
                    return new { enabled = false, error = ex.Message };
                }
            });

            bridge.On(Module.System, "setMicrophoneStatus", msg =>
            {
                var data = msg.GetData<MicrophoneRequest>();
                if (data == null)
                {
                    return msg.Fail(ErrorCode.InvalidParams, "Invalid microphone parameter");
                }

                try
                {
                    SetMicrophoneMute(!data.Enabled);
                    return msg.Ok(new { enabled = data.Enabled });
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, $"Failed to set microphone: {ex.Message}");
                }
            });

            // ===== 系统媒体控制 (SMTC) =====
            bridge.On(Module.System, "getMediaSessions", async msg =>
            {
                try
                {
                    var sessions = await GetMediaSessionsAsync();
                    return msg.Ok(new { sessions });
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, $"Failed to get media sessions: {ex.Message}");
                }
            });

            bridge.On(Module.System, "getCurrentMediaInfo", async msg =>
            {
                try
                {
                    var data = msg.GetData<MediaSessionRequest>();
                    var sessionId = data?.SessionId ?? 0;
                    var mediaInfo = await GetCurrentMediaInfoAsync(sessionId);
                    return msg.Ok(mediaInfo);
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, $"Failed to get media info: {ex.Message}");
                }
            });

            bridge.On(Module.System, "mediaPlayPause", async msg =>
            {
                try
                {
                    var data = msg.GetData<MediaSessionRequest>();
                    var sessionId = data?.SessionId ?? 0;
                    await MediaPlayPauseAsync(sessionId);
                    return msg.Ok();
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, $"Failed to play/pause: {ex.Message}");
                }
            });

            bridge.On(Module.System, "mediaNext", async msg =>
            {
                try
                {
                    var data = msg.GetData<MediaSessionRequest>();
                    var sessionId = data?.SessionId ?? 0;
                    await MediaNextAsync(sessionId);
                    return msg.Ok();
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, $"Failed to next: {ex.Message}");
                }
            });

            bridge.On(Module.System, "mediaPrevious", async msg =>
            {
                try
                {
                    var data = msg.GetData<MediaSessionRequest>();
                    var sessionId = data?.SessionId ?? 0;
                    await MediaPreviousAsync(sessionId);
                    return msg.Ok();
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, $"Failed to previous: {ex.Message}");
                }
            });

            // ===== Serial 模块 =====
            bridge.On(Module.Serial, "list", _ =>
            {
                var ports = bridge.GetPanelLinkSerialPorts()
                    .Select(p => new SerialInfo { Port = p, Description = p })
                    .ToArray();
                return new { ports };
            });

            bridge.On(Module.Serial, "open", msg =>
            {
                var config = msg.GetData<SerialConfig>();
                if (config == null || string.IsNullOrEmpty(config.Port))
                {
                    return msg.Fail(ErrorCode.InvalidParams, "Invalid serial config");
                }

                return bridge.OpenSerial(config)
                    ? msg.Ok(new { port = config.Port })
                    : msg.Fail(ErrorCode.SerialOpenFailed, "Failed to open serial port");
            });

            bridge.On(Module.Serial, "close", msg =>
            {
                bridge.CloseSerial();
                return msg.Ok();
            });

            bridge.On(Module.Serial, "send", msg =>
            {
                var data = msg.GetData<SerialSendRequest>();
                if (data == null) return msg.Fail(ErrorCode.InvalidParams, "Invalid data");

                return bridge.SendToDevice(data.Raw)
                    ? msg.Ok()
                    : msg.Fail(ErrorCode.SerialWriteFailed, "Failed to write to serial");
            });

            // 自动连接串口
            bridge.On(Module.Serial, "autoConnect", msg =>
            {
                // 启动自动重连服务
                bridge.StartAutoReconnect();
                
                // 如果已连接，返回当前状态
                if (bridge.IsSerialConnected)
                {
                    return Task.FromResult(msg.Ok(new { port = bridge.CurrentPort, status = "connected" }));
                }
                if (bridge.IsSerialOpen)
                {
                    return Task.FromResult(msg.Ok(new { port = bridge.CurrentPort, status = "listening" }));
                }
                else
                {
                    // 返回 pending 状态，前端等待连接事件
                    return Task.FromResult(msg.Ok(new { status = "scanning" }));
                }
            });

            // ===== App 模块 =====
            bridge.On(Module.App, "list", _ =>
            {
                var apps = GetDesktopApps();
                return new { apps };
            });

            bridge.On(Module.App, "launch", msg =>
            {
                var req = msg.GetData<AppLaunchRequest>();
                if (req == null) return msg.Fail(ErrorCode.InvalidParams, "Invalid request");

                try
                {
                    var path = req.Path ?? req.Id;
                    if (string.IsNullOrEmpty(path)) return msg.Fail(ErrorCode.InvalidParams, "Path required");

                    Process.Start(new ProcessStartInfo
                    {
                        FileName = path,
                        Arguments = req.Args ?? string.Empty,
                        UseShellExecute = true
                    });
                    return msg.Ok();
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.AppLaunchFailed, ex.Message);
                }
            });

            bridge.On(Module.App, "screenshot", msg =>
            {
                try
                {
                    // Windows 10/11 截图工具路径
                    // 优先使用 Snipping Tool (Win+Shift+S 截图工具)
                    var snippingToolPath = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.System),
                        "SnippingTool.exe"
                    );

                    // Windows 11 新版截图工具
                    var snippingToolWin11 = "ms-screenclip:";

                    try
                    {
                        // 优先使用 Windows 11 截图工具 (ms-screenclip: URI)
                        // 这会打开截图覆盖层,允许用户框选区域
                        Process.Start(new ProcessStartInfo
                        {
                            FileName = snippingToolWin11,
                            UseShellExecute = true
                        });
                        return msg.Ok(new { method = "win11-screenclip" });
                    }
                    catch
                    {
                        // 回退到传统的 Snipping Tool
                        if (File.Exists(snippingToolPath))
                        {
                            Process.Start(new ProcessStartInfo
                            {
                                FileName = snippingToolPath,
                                UseShellExecute = true
                            });
                            return msg.Ok(new { method = "snipping-tool" });
                        }
                        else
                        {
                            return msg.Fail(ErrorCode.AppLaunchFailed, "Screenshot tool not found");
                        }
                    }
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.AppLaunchFailed, ex.Message);
                }
            });
            // ===== 手动固件更新 (发送到上位机处理) =====
            bridge.On(Module.System, "manualUpdate", async msg =>
            {
                try
                {
                    var data = msg.GetData<ManualUpdateRequest>();
                    
                    if (data == null || string.IsNullOrWhiteSpace(data.Path))
                    {
                        return msg.Fail(ErrorCode.InvalidParams, "Missing sdk.elf path");
                    }

                    if (_updateTaskRunning)
                    {
                        return msg.Fail(ErrorCode.Busy, "Update already in progress");
                    }
                     
                    // 启动后台任务，确保异常被捕获
                    _ = Task.Run(async () =>
                    {
                        try
                        {
                            await ManualUpdateTask(bridge, data.Path, data.PreserveUserData, data.EnterUpgradeConfirmed);
                        }
                        catch (Exception ex)
                        {
                            bridge.BroadcastEvent(Module.Update, "log", new { text = $"[Error] Unhandled: {ex.Message}" });
                            bridge.BroadcastEvent(Module.Update, "event", new { status = "error", error = ex.Message });
                            _updateTaskRunning = false;
                        }
                    });

                    return msg.Ok(new { status = "started" });
                }
                catch (Exception ex)
                {
                    bridge.BroadcastEvent(Module.Update, "event", new { status = "error", error = ex.Message });
                    return msg.Fail(ErrorCode.Unknown, ex.Message);
                }
            });

            bridge.On(Module.System, "manualUpdateBootConfirm", msg =>
            {
                var data = msg.GetData<ManualUpdateBootConfirmRequest>();
                if (data == null || string.IsNullOrWhiteSpace(data.RequestId))
                {
                    return msg.Fail(ErrorCode.InvalidParams, "Missing requestId");
                }

                if (_manualUpdateBootConfirmations.TryRemove(data.RequestId, out var tcs))
                {
                    tcs.TrySetResult(data.Continue);
                    return msg.Ok(new { accepted = true });
                }

                return msg.Fail(ErrorCode.NotFound, "Confirmation request not found or expired");
            });

            // 文件选择器 - 放在 System 模块确保发送到上位机
            bridge.On(Module.System, "pickFile", async msg =>
            {
                try
                {
                    var data = msg.GetData<PickFileRequest>();
                    var title = string.IsNullOrWhiteSpace(data?.Title) ? "选择文件" : data.Title.Trim();
                    var exts = data?.Extensions ?? new List<string>();
                    return await PickFileAsync(msg, title, exts);
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, $"Failed to open file picker: {ex.Message}");
                }
            });

            bridge.On(Module.System, "pickFirmwareFile", async msg =>
            {
                try
                {
                    return await PickFileAsync(msg, "选择固件文件", new List<string> { ".elf", ".bin" });
                }
                catch (Exception ex)
                {
                    return msg.Fail(ErrorCode.Unknown, $"Failed to open file picker: {ex.Message}");
                }
            });
        }

        private static async Task<Message> PickFileAsync(Message msg, string title, List<string> extensions)
        {
            // extensions 为空或包含通配符时，允许选择任意文件
            bool any = extensions.Count == 0 || extensions.Any(e => e == "*" || e == ".*" || e == "*.*");

            PickOptions options;
            if (any)
            {
                options = new PickOptions { PickerTitle = title };
            }
            else
            {
                var winExts = extensions.Select(e => e.StartsWith('.') ? e : "." + e).ToArray();
                var macExts = extensions.Select(e => e.TrimStart('.')).ToArray();

                var customFileType = new FilePickerFileType(
                    new Dictionary<DevicePlatform, IEnumerable<string>>
                    {
                        { DevicePlatform.WinUI, winExts },
                        { DevicePlatform.macOS, macExts },
                    });

                options = new PickOptions
                {
                    PickerTitle = title,
                    FileTypes = customFileType
                };
            }

            var result = await FilePicker.Default.PickAsync(options);
            if (result != null)
            {
                return msg.Ok(new { path = result.FullPath, name = result.FileName });
            }
            return msg.Ok(new { path = (string?)null, cancelled = true });
        }

        private static string? TryLoadTextFile(string path)
        {
            try
            {
                if (File.Exists(path)) return File.ReadAllText(path);
            }
            catch
            {
                // ignore
            }

            return null;
        }

        private static string? TryLoadAiSystemPrompt(OpenCodeSidecarService openCode)
        {
            string? baseText = null;
            var baseDir = AppDomain.CurrentDomain.BaseDirectory;

            if (openCode != null)
            {
                var workspaceSourceDir = openCode.WorkspaceSourceDir;
                if (!string.IsNullOrWhiteSpace(workspaceSourceDir))
                {
                    var workspaceSkill = Path.Combine(workspaceSourceDir, "skills", "panelmanager-opencode", "SKILL.md");
                    baseText = TryLoadTextFile(workspaceSkill);
                    if (string.IsNullOrWhiteSpace(baseText))
                    {
                        var workspaceAgents = Path.Combine(workspaceSourceDir, "AGENTS.md");
                        baseText = TryLoadTextFile(workspaceAgents);
                    }
                }
            }

            if (string.IsNullOrWhiteSpace(baseText))
            {
                var outputSkill = Path.Combine(baseDir, "skills", "panelmanager-opencode", "SKILL.md");
                baseText = TryLoadTextFile(outputSkill);
            }

            if (string.IsNullOrWhiteSpace(baseText))
            {
                // 兼容旧版本：仍允许回退到运行目录中的 AI_AGENT.md
                var legacyPrompt = Path.Combine(baseDir, "AI_AGENT.md");
                baseText = TryLoadTextFile(legacyPrompt);
            }

            if (openCode == null)
            {
                return baseText;
            }

            var wsDir = openCode.WorkspaceDir;
            var srcDir = openCode.WorkspaceSourceDir;
            var sandboxDir = openCode.WorkspaceSandboxDir;
            var origin = openCode.WorkspaceOrigin;
            var repoRoot = openCode.WorkspaceRepoRoot;

            if (string.IsNullOrWhiteSpace(wsDir) && string.IsNullOrWhiteSpace(srcDir))
            {
                return baseText;
            }

            var extra = new StringBuilder();
            extra.AppendLine();
            extra.AppendLine();
            extra.AppendLine("## Runtime Workspace Context (Injected by PanelManager)");
            if (!string.IsNullOrWhiteSpace(wsDir)) extra.AppendLine($"- Workspace: `{wsDir}`");
            if (!string.IsNullOrWhiteSpace(srcDir)) extra.AppendLine($"- Workspace Root: `{srcDir}`");
            if (!string.IsNullOrWhiteSpace(sandboxDir)) extra.AppendLine($"- Tool Sandbox: `{sandboxDir}`");
            if (!string.IsNullOrWhiteSpace(repoRoot)) extra.AppendLine($"- Origin Repo Root: `{repoRoot}`");
            if (!string.IsNullOrWhiteSpace(origin)) extra.AppendLine($"- Source Origin: `{origin}`");
            extra.AppendLine();
            extra.AppendLine("工作规则（强制）：");
            if (!string.IsNullOrWhiteSpace(srcDir))
            {
                extra.AppendLine($"- 项目根目录就是 `Workspace Root`（其中包含 `PanelManager.sln`），不要再假定额外的 `src/` 子目录。");
                extra.AppendLine($"- 只在 `Workspace Root` 下读写/搜索/构建项目；不要在其它目录修改源码。");
                extra.AppendLine($"- 优先使用本地工程 skill：`{Path.Combine(srcDir, "skills", "panelmanager-opencode", "SKILL.md")}`。");
            }
            extra.AppendLine("- 如果需要构建/发布，请在工作区内进行，避免污染当前运行目录。");
            extra.AppendLine("- 默认将工具安装、缓存、配置限制在 `Tool Sandbox` 或 `Workspace Root/.sandbox/` 内；不要修改主系统。");

            if (string.IsNullOrWhiteSpace(baseText))
            {
                return extra.ToString().Trim();
            }
            return baseText.TrimEnd() + extra.ToString();
        }

        private sealed class AiStartRequest
        {
            [System.Text.Json.Serialization.JsonPropertyName("version")]
            public string? Version { get; set; }

            [System.Text.Json.Serialization.JsonPropertyName("forceRestart")]
            public bool ForceRestart { get; set; }
        }

        private sealed class AiAuthSetRequest
        {
            [System.Text.Json.Serialization.JsonPropertyName("id")]
            public string Id { get; set; } = string.Empty;

            [System.Text.Json.Serialization.JsonPropertyName("auth")]
            public System.Text.Json.JsonElement Auth { get; set; }
        }

        private sealed class AiOauthAuthorizeRequest
        {
            [System.Text.Json.Serialization.JsonPropertyName("id")]
            public string Id { get; set; } = string.Empty;

            [System.Text.Json.Serialization.JsonPropertyName("method")]
            public int Method { get; set; }
        }

        private sealed class AiOauthCallbackRequest
        {
            [System.Text.Json.Serialization.JsonPropertyName("id")]
            public string Id { get; set; } = string.Empty;

            [System.Text.Json.Serialization.JsonPropertyName("method")]
            public int Method { get; set; }

            [System.Text.Json.Serialization.JsonPropertyName("code")]
            public string? Code { get; set; }
        }

         private sealed class AiPermissionRespondRequest
         {
            [System.Text.Json.Serialization.JsonPropertyName("sessionId")]
            public string SessionId { get; set; } = string.Empty;

            [System.Text.Json.Serialization.JsonPropertyName("permissionId")]
            public string PermissionId { get; set; } = string.Empty;

            [System.Text.Json.Serialization.JsonPropertyName("response")]
             public string Response { get; set; } = string.Empty;
         }

        private sealed class AiPermissionReplyRequest
        {
            [System.Text.Json.Serialization.JsonPropertyName("sessionId")]
            public string SessionId { get; set; } = string.Empty;

            [System.Text.Json.Serialization.JsonPropertyName("requestId")]
            public string RequestId { get; set; } = string.Empty;

            [System.Text.Json.Serialization.JsonPropertyName("reply")]
            public string Reply { get; set; } = string.Empty;

            [System.Text.Json.Serialization.JsonPropertyName("message")]
            public string? Message { get; set; }
        }

        private sealed class AiQuestionReplyRequest
        {
            [System.Text.Json.Serialization.JsonPropertyName("requestId")]
            public string RequestId { get; set; } = string.Empty;

            [System.Text.Json.Serialization.JsonPropertyName("answers")]
            public List<List<string>>? Answers { get; set; }
        }

        private sealed class AiQuestionRejectRequest
        {
            [System.Text.Json.Serialization.JsonPropertyName("requestId")]
            public string RequestId { get; set; } = string.Empty;
        }

        private sealed class AiNewSessionRequest
        {
            [System.Text.Json.Serialization.JsonPropertyName("title")]
            public string? Title { get; set; }
        }

        private sealed class AiSendMessageRequest
        {
            [System.Text.Json.Serialization.JsonPropertyName("messageId")]
            public string? MessageId { get; set; }

            [System.Text.Json.Serialization.JsonPropertyName("sessionId")]
            public string SessionId { get; set; } = string.Empty;

            [System.Text.Json.Serialization.JsonPropertyName("text")]
            public string Text { get; set; } = string.Empty;

            [System.Text.Json.Serialization.JsonPropertyName("agent")]
            public string? Agent { get; set; }

            [System.Text.Json.Serialization.JsonPropertyName("model")]
            public string? Model { get; set; }

            [System.Text.Json.Serialization.JsonPropertyName("variant")]
            public string? Variant { get; set; }

            [System.Text.Json.Serialization.JsonPropertyName("system")]
            public string? System { get; set; }

            [System.Text.Json.Serialization.JsonPropertyName("attachments")]
            public List<string>? Attachments { get; set; }
        }

        private sealed class AiSessionMessagesRequest
        {
            [System.Text.Json.Serialization.JsonPropertyName("sessionId")]
            public string SessionId { get; set; } = string.Empty;

            [System.Text.Json.Serialization.JsonPropertyName("limit")]
            public int? Limit { get; set; }
        }

        private static List<object> BuildPromptParts(string text, List<string>? attachments)
        {
            var parts = new List<object>
            {
                new { type = "text", text }
            };

            if (attachments == null)
            {
                return parts;
            }

            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            foreach (var raw in attachments)
            {
                var p = string.IsNullOrWhiteSpace(raw) ? null : raw.Trim();
                if (string.IsNullOrWhiteSpace(p))
                {
                    continue;
                }

                if (!seen.Add(p))
                {
                    continue;
                }

                var url = BuildFileUrl(p);
                var filename = Path.GetFileName(p);
                parts.Add(new
                {
                    type = "file",
                    mime = "text/plain",
                    url,
                    filename = string.IsNullOrWhiteSpace(filename) ? null : filename
                });
            }

            return parts;
        }

        private static bool TryParseModelKey(string? model, out string providerID, out string modelID)
        {
            providerID = string.Empty;
            modelID = string.Empty;
            if (string.IsNullOrWhiteSpace(model))
            {
                return false;
            }

            var s = model.Trim();
            var idx = s.IndexOf('/');
            if (idx <= 0 || idx >= s.Length - 1)
            {
                return false;
            }

            providerID = s.Substring(0, idx).Trim();
            modelID = s.Substring(idx + 1).Trim();
            return !(string.IsNullOrWhiteSpace(providerID) || string.IsNullOrWhiteSpace(modelID));
        }

        // 对齐 OpenCode Desktop 的 encodeFilePath 语义（Windows:
        // - 反斜杠转正斜杠
        // - 盘符路径前加 '/'
        // - 分段编码，但保留盘符段（"C:"）的冒号
        private static string BuildFileUrl(string filePath)
        {
            var normalized = filePath.Replace('\\', '/');
            if (normalized.Length >= 2 && char.IsLetter(normalized[0]) && normalized[1] == ':')
            {
                normalized = "/" + normalized;
            }

            var segments = normalized.Split('/', StringSplitOptions.None);
            for (var i = 0; i < segments.Length; i++)
            {
                var seg = segments[i];
                if (i == 1 && seg.Length == 2 && char.IsLetter(seg[0]) && seg[1] == ':')
                {
                    // keep drive letter
                    continue;
                }
                segments[i] = Uri.EscapeDataString(seg);
            }

            var encoded = string.Join("/", segments);
            return "file://" + encoded;
        }

        private sealed class PickFileRequest
        {
            [System.Text.Json.Serialization.JsonPropertyName("title")]
            public string? Title { get; set; }

            [System.Text.Json.Serialization.JsonPropertyName("extensions")]
            public List<string>? Extensions { get; set; }
        }

        private static bool _updateTaskRunning = false;

        private class ManualUpdateRequest
        {
            [System.Text.Json.Serialization.JsonPropertyName("path")]
            public string Path { get; set; } = string.Empty;

            [System.Text.Json.Serialization.JsonPropertyName("preserveUserData")]
            public bool PreserveUserData { get; set; } = true;

            [System.Text.Json.Serialization.JsonPropertyName("enterUpgradeConfirmed")]
            public bool EnterUpgradeConfirmed { get; set; }
        }

        private sealed class ManualUpdateBootConfirmRequest
        {
            [System.Text.Json.Serialization.JsonPropertyName("requestId")]
            public string RequestId { get; set; } = string.Empty;

            [System.Text.Json.Serialization.JsonPropertyName("continue")]
            public bool Continue { get; set; }
        }

        private static async Task ManualUpdateTask(MessageBridge bridge, string sdkElfPath, bool preserveUserData, bool enterUpgradeConfirmed)
        {
            _updateTaskRunning = true;
            
            try
            {
                bridge.BroadcastEvent(Module.Update, "log", new { text = $"[System] Update task started for: {sdkElfPath}" });
                bridge.BroadcastEvent(Module.Update, "log", new { text = $"[System] Preserve user data: {(preserveUserData ? "YES" : "NO (format all)")}" });

                // 1. 确定工作目录 - 只使用 appDir/Tools
                var appDir = AppDomain.CurrentDomain.BaseDirectory;
                var toolsDir = Path.Combine(appDir, "Tools");
                
                bridge.BroadcastEvent(Module.Update, "log", new { text = $"[System] AppDir: {appDir}" });
                bridge.BroadcastEvent(Module.Update, "log", new { text = $"[System] Tools directory: {toolsDir}" });

                if (!Directory.Exists(toolsDir))
                {
                    throw new DirectoryNotFoundException($"Tools directory not found at: {toolsDir}");
                }
            
                bridge.BroadcastEvent(Module.Update, "log", new { text = $"[System] Using Tools directory: {toolsDir}" });

                if (!File.Exists(sdkElfPath))
                {
                    throw new FileNotFoundException($"Input sdk.elf not found at: {sdkElfPath}");
                }
                
                // 验证关键工具
                var requiredTools = new[] { "isd_download.exe", "llvm-objcopy.exe" };
                foreach (var tool in requiredTools)
                {
                    if (!File.Exists(Path.Combine(toolsDir, tool)))
                    {
                         throw new FileNotFoundException($"Required tool not found in Tools dir: {tool}");
                    }
                }

                // 2. 执行固件生成流程 (模拟 download.bat)
                
                // 2.1 objcopy 生成 bin 文件 (直接使用 sdk.elf 绝对路径，无需拷贝)
                string objcopyExe = "llvm-objcopy.exe";
                string elfPath = sdkElfPath.Replace("\\", "/"); // 确保路径格式兼容
                
                // 生成 text.bin
                await RunCommand(bridge, toolsDir, objcopyExe, $"-O binary -j .text \"{elfPath}\" text.bin");
                // 生成 data.bin
                await RunCommand(bridge, toolsDir, objcopyExe, $"-O binary -j .data \"{elfPath}\" data.bin");
                // 生成 ram0_data.bin
                await RunCommand(bridge, toolsDir, objcopyExe, $"-O binary -j .ram0_data \"{elfPath}\" ram0_data.bin");
                // 生成 cache_ram_data.bin
                await RunCommand(bridge, toolsDir, objcopyExe, $"-O binary -j .cache_ram_data \"{elfPath}\" cache_ram_data.bin");
                
                // 2.2 合并 bin (根据 download.bat: copy /b text.bin+data.bin+ram0_data.bin+cache_ram_data.bin app.bin)
                await CombineFilesAsync(toolsDir, "app.bin", new[] { "text.bin", "data.bin", "ram0_data.bin", "cache_ram_data.bin" });
                bridge.BroadcastEvent(Module.Update, "log", new { text = "[System] Generated app.bin" });
                
                // 3. 如果串口已连接，发送命令让设备自动进入升级模式
                if (bridge.IsSerialConnected)
                {
                    if (!enterUpgradeConfirmed)
                    {
                        bridge.BroadcastEvent(Module.Update, "log", new { text = "[System] Serial port connected, waiting for user confirmation before rebooting device..." });
                        if (!await RequestManualUpdateBootConfirmationAsync(bridge))
                        {
                            throw new OperationCanceledException("用户取消进入烧录模式");
                        }
                    }

                    bridge.BroadcastEvent(Module.Update, "log", new { text = "[System] Sending enterUpgradeMode command..." });
                    
                    // 构造进入升级模式的命令
                    var enterUpgradeMsg = new Message
                    {
                        Version = 1,
                        Id = Guid.NewGuid().ToString("N")[..8],
                        Target = Target.Device,
                        Type = MsgType.Request,
                        Module = Module.Update,
                        Cmd = "enterUpgradeMode",
                        Data = System.Text.Json.JsonSerializer.SerializeToElement(new { }),
                        Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                    };
                    
                    // 发送命令
                    bridge.SendToDevice(enterUpgradeMsg);
                    bridge.BroadcastEvent(Module.Update, "log", new { text = "[System] Command sent, waiting for device to reboot (3s)..." });
                    
                    // 等待设备重启进入升级模式
                    await Task.Delay(3000);
                    
                    bridge.BroadcastEvent(Module.Update, "log", new { text = "[System] Device should be in upgrade mode now" });
                    if (!await RequestManualUpdateDeviceReadyConfirmationAsync(bridge))
                    {
                        throw new OperationCanceledException("用户取消开始烧录");
                    }

                    bridge.BroadcastEvent(Module.Update, "log", new { text = "[System] User confirmed device is in upgrade mode" });
                }
                else
                {
                    bridge.BroadcastEvent(Module.Update, "log", new { text = "[System] Serial port not connected, please manually enter upgrade mode (press upgrade button)" });
                }
                
                // 4. 下载 (使用预置的资源目录: audlogo, ui_res, cfg)
                var dataModeArgs = preserveUserData ? " -update_files normal" : " -format all";
                var downloadArgs = $"isd_config.ini -gen2 -tonorflash -dev wl82 -boot 0x1c02000 -div1 -wait 300 -uboot uboot.boot -app app.bin cfg_tool.bin -res audlogo ui_res cfg -reboot 500{dataModeArgs} -extend-bin";
                
                bridge.BroadcastEvent(Module.Update, "log", new { text = "[System] Starting download..." });
                bridge.BroadcastEvent(Module.Update, "log", new { text = $"[System] Command: isd_download.exe {downloadArgs}" });
                var (downloadSuccess, downloadOutput) = await RunCommand(bridge, toolsDir, "isd_download.exe", 
                    downloadArgs, 
                    true);
                
                if (!downloadSuccess)
                {
                    // 提取错误信息
                    string errorDetail = "Download failed";
                    if (downloadOutput.Contains("Device Offline"))
                    {
                        errorDetail = "Device Offline - 设备未连接或未进入烧录模式";
                    }
                    throw new Exception(errorDetail);
                }
                
                bridge.BroadcastEvent(Module.Update, "event", new { status = "success" });
            }
            catch (Exception ex)
            {
                bridge.BroadcastEvent(Module.Update, "log", new { text = $"[Error] {ex.Message}" });
                bridge.BroadcastEvent(Module.Update, "event", new { status = "error", error = ex.Message });
            }
            finally
            {
                // 清理临时文件 (无论成功或失败)
                try
                {
                    var appDir = AppDomain.CurrentDomain.BaseDirectory;
                    var toolsDir = Path.Combine(appDir, "Tools");
                    var tempFiles = new[] { "text.bin", "data.bin", "ram0_data.bin", "cache_ram_data.bin", "app.bin" };
                    
                    bridge.BroadcastEvent(Module.Update, "log", new { text = "[System] Cleaning up temporary files..." });
                    foreach (var tempFile in tempFiles)
                    {
                        var tempPath = Path.Combine(toolsDir, tempFile);
                        if (File.Exists(tempPath))
                        {
                            try
                            {
                                File.Delete(tempPath);
                            }
                            catch (Exception cleanupEx)
                            {
                                bridge.BroadcastEvent(Module.Update, "log", new { text = $"[Warning] Could not delete {tempFile}: {cleanupEx.Message}" });
                            }
                        }
                    }
                    bridge.BroadcastEvent(Module.Update, "log", new { text = "[System] Cleanup complete." });
                }
                catch (Exception cleanupEx)
                {
                    bridge.BroadcastEvent(Module.Update, "log", new { text = $"[Warning] Cleanup error: {cleanupEx.Message}" });
                }
                
                _updateTaskRunning = false;
                bridge.BroadcastEvent(Module.Update, "log", new { text = "[System] Update task finished." });
            }
        }

        private static async Task<bool> RequestManualUpdateBootConfirmationAsync(MessageBridge bridge)
        {
            var requestId = Guid.NewGuid().ToString("N");
            var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            _manualUpdateBootConfirmations[requestId] = tcs;

            bridge.BroadcastEvent(Module.Update, "event", new
            {
                status = "confirm_enter_upgrade",
                requestId,
                message = "设备即将重启到烧录模式。确认后将先退出全屏并恢复主窗口，再继续发送重启指令。"
            });

            var completed = await Task.WhenAny(tcs.Task, Task.Delay(TimeSpan.FromMinutes(5)));
            if (completed != tcs.Task)
            {
                _manualUpdateBootConfirmations.TryRemove(requestId, out _);
                return false;
            }

            return await tcs.Task;
        }

        private static async Task<bool> RequestManualUpdateDeviceReadyConfirmationAsync(MessageBridge bridge)
        {
            var requestId = Guid.NewGuid().ToString("N");
            var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            _manualUpdateBootConfirmations[requestId] = tcs;

            bridge.BroadcastEvent(Module.Update, "event", new
            {
                status = "confirm_upgrade_ready",
                requestId,
                message = "请确认设备已经重启并进入烧录模式。确认后才会开始写入固件。"
            });

            var completed = await Task.WhenAny(tcs.Task, Task.Delay(TimeSpan.FromMinutes(10)));
            if (completed != tcs.Task)
            {
                _manualUpdateBootConfirmations.TryRemove(requestId, out _);
                return false;
            }

            return await tcs.Task;
        }

        private static async Task CombineFilesAsync(string workDir, string outputFile, string[] inputFiles)
        {
             var outPath = Path.Combine(workDir, outputFile);
             using var fsOut = new FileStream(outPath, FileMode.Create);
             foreach (var inputFile in inputFiles)
             {
                 var inPath = Path.Combine(workDir, inputFile);
                 // 容错：如果 section 文件不存在 (空 section)，跳过
                 if (File.Exists(inPath))
                 {
                     using var fsIn = new FileStream(inPath, FileMode.Open);
                     await fsIn.CopyToAsync(fsOut);
                 }
             }
        }

        private static async Task<(bool Success, string Output)> RunCommand(MessageBridge bridge, string workDir, string exeName, string args, bool checkOutput = false)
        {
            var psi = new ProcessStartInfo
            {
                FileName = Path.Combine(workDir, exeName),
                Arguments = args,
                WorkingDirectory = workDir,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                StandardOutputEncoding = System.Text.Encoding.UTF8,
                StandardErrorEncoding = System.Text.Encoding.UTF8
            };
            
            // 如果找不到exe，尝试直接用文件名(依赖PATH)
            if (!File.Exists(psi.FileName))
            {
                psi.FileName = exeName;
            }

            bridge.BroadcastEvent(Module.Update, "log", new { text = $"> {exeName} {args}" });

            var outputBuilder = new System.Text.StringBuilder();
            var lineBuffer = new System.Text.StringBuilder();
            
            using var p = new Process { StartInfo = psi };
            p.Start();

            // 使用字符级读取实现实时输出
            async Task ReadStreamAsync(StreamReader reader)
            {
                var buffer = new char[1];
                while (!reader.EndOfStream)
                {
                    int read = await reader.ReadAsync(buffer, 0, 1);
                    if (read > 0)
                    {
                        char c = buffer[0];
                        lock (outputBuilder) { outputBuilder.Append(c); }
                        
                        if (c == '\n')
                        {
                            // 完整行，发送并清空缓冲
                            var line = lineBuffer.ToString().TrimEnd('\r');
                            if (!string.IsNullOrEmpty(line))
                            {
                                bridge.BroadcastEvent(Module.Update, "log", new { text = line });
                            }
                            lineBuffer.Clear();
                        }
                        else if (c == '\r')
                        {
                            // 回车符 - 发送当前内容（用于进度显示）
                            var line = lineBuffer.ToString();
                            if (!string.IsNullOrEmpty(line))
                            {
                                bridge.BroadcastEvent(Module.Update, "log", new { text = line });
                            }
                            lineBuffer.Clear();
                        }
                        else
                        {
                            lineBuffer.Append(c);
                        }
                    }
                }
                // 处理剩余内容
                if (lineBuffer.Length > 0)
                {
                    bridge.BroadcastEvent(Module.Update, "log", new { text = lineBuffer.ToString() });
                    lineBuffer.Clear();
                }
            }

            var stdoutTask = ReadStreamAsync(p.StandardOutput);
            var stderrTask = ReadStreamAsync(p.StandardError);

            await Task.WhenAll(stdoutTask, stderrTask);
            await p.WaitForExitAsync();

            var output = outputBuilder.ToString();
            
            // 检查退出码
            if (p.ExitCode != 0)
            {
                throw new Exception($"Command {exeName} failed with exit code {p.ExitCode}");
            }
            
            // 如果需要检查输出内容
            if (checkOutput)
            {
                // 定义错误关键词
                var errorKeywords = new[] { "Device Offline", "ERROR", "failed", "Failed", "FAIL" };
                // 定义成功关键词（至少要匹配一个才算成功）
                var successKeywords = new[] { "Download completed", "rebooting device" };
                
                bool hasError = errorKeywords.Any(keyword => output.Contains(keyword));
                bool hasSuccess = successKeywords.Any(keyword => output.Contains(keyword));
                
                if (hasError && !hasSuccess)
                {
                    return (false, output);
                }
            }
            
            return (true, output);
        }

        private static List<AppStartInfo> GetDesktopApps()
        {
            var apps = new List<AppStartInfo>();
            var addedNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            try
            {
                // 1. 获取桌面快捷方式和可执行文件
                var desktopPath = Environment.GetFolderPath(Environment.SpecialFolder.Desktop);
                var commonDesktop = Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory);

                foreach (var path in new[] { desktopPath, commonDesktop })
                {
                    if (!Directory.Exists(path)) continue;

                    // 添加 .lnk 快捷方式
                    foreach (var file in Directory.GetFiles(path, "*.lnk"))
                    {
                        var name = Path.GetFileNameWithoutExtension(file);
                        if (addedNames.Add(name))
                        {
                            var icon = ExtractIconAsBase64(file);
                            apps.Add(new AppStartInfo
                            {
                                Id = name,
                                Name = name,
                                Path = file,
                                Icon = icon
                            });
                        }
                    }

                    // 添加 .exe 可执行文件
                    foreach (var file in Directory.GetFiles(path, "*.exe"))
                    {
                        var name = Path.GetFileNameWithoutExtension(file);
                        if (addedNames.Add(name))
                        {
                            var icon = ExtractIconAsBase64(file);
                            apps.Add(new AppStartInfo
                            {
                                Id = name,
                                Name = name,
                                Path = file,
                                Icon = icon
                            });
                        }
                    }
                }

                // 2. 获取开始菜单程序
                var startMenu = Environment.GetFolderPath(Environment.SpecialFolder.StartMenu);
                var commonStartMenu = Environment.GetFolderPath(Environment.SpecialFolder.CommonStartMenu);

                foreach (var path in new[] { startMenu, commonStartMenu })
                {
                    if (!Directory.Exists(path)) continue;

                    // 添加开始菜单中的 .lnk 快捷方式
                    foreach (var file in Directory.GetFiles(path, "*.lnk", SearchOption.AllDirectories))
                    {
                        var name = Path.GetFileNameWithoutExtension(file);
                        if (addedNames.Add(name))
                        {
                            var icon = ExtractIconAsBase64(file);
                            apps.Add(new AppStartInfo
                            {
                                Id = name,
                                Name = name,
                                Path = file,
                                Icon = icon
                            });
                        }
                    }

                    // 添加开始菜单中的 .exe 可执行文件
                    foreach (var file in Directory.GetFiles(path, "*.exe", SearchOption.AllDirectories))
                    {
                        var name = Path.GetFileNameWithoutExtension(file);
                        if (addedNames.Add(name))
                        {
                            var icon = ExtractIconAsBase64(file);
                            apps.Add(new AppStartInfo
                            {
                                Id = name,
                                Name = name,
                                Path = file,
                                Icon = icon
                            });
                        }
                    }
                }

                // 3. 获取 Program Files 中的常用应用
                var programFiles = new[]
                {
                    Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                    Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86)
                };

                foreach (var baseDir in programFiles)
                {
                    if (!Directory.Exists(baseDir)) continue;

                    try
                    {
                        // 只扫描 Program Files 根目录下的第一层文件夹
                        foreach (var appDir in Directory.GetDirectories(baseDir))
                        {
                            // 查找主可执行文件（与文件夹同名或常见名称）
                            var dirName = Path.GetFileName(appDir);
                            var exePatterns = new[] { $"{dirName}.exe", "*.exe" };

                            foreach (var pattern in exePatterns)
                            {
                                foreach (var file in Directory.GetFiles(appDir, pattern, SearchOption.TopDirectoryOnly))
                                {
                                    var name = Path.GetFileNameWithoutExtension(file);

                                    // 跳过常见的安装/卸载程序
                                    if (name.Contains("unins", StringComparison.OrdinalIgnoreCase) ||
                                        name.Contains("setup", StringComparison.OrdinalIgnoreCase) ||
                                        name.Contains("install", StringComparison.OrdinalIgnoreCase))
                                        continue;

                                    if (addedNames.Add(name))
                                    {
                                        var icon = ExtractIconAsBase64(file);
                                        apps.Add(new AppStartInfo
                                        {
                                            Id = name,
                                            Name = name,
                                            Path = file,
                                            Icon = icon
                                        });
                                    }

                                    // 如果找到与文件夹同名的exe，停止继续搜索这个文件夹
                                    if (pattern == $"{dirName}.exe")
                                        break;
                                }

                                if (pattern == $"{dirName}.exe")
                                    break;
                            }
                        }
                    }
                    catch { /* 忽略权限错误 */ }
                }
            }
            catch { }

            return apps.OrderBy(a => a.Name).ToList();
        }

        private static string? ExtractIconAsBase64(string path)
        {
            try
            {
                // 获取目标路径（如果是快捷方式）
                string targetPath = path;
                if (path.EndsWith(".lnk", StringComparison.OrdinalIgnoreCase))
                {
                    targetPath = GetShortcutTarget(path) ?? path;
                }

                if (string.IsNullOrEmpty(targetPath) || !File.Exists(targetPath))
                    return null;

                // 使用 PrivateExtractIcons 提取最高质量图标
                Bitmap? bitmap = ExtractBestQualityIcon(targetPath);

                if (bitmap == null) return null;

                // 转换为高质量 PNG Base64（无损压缩）
                using (bitmap)
                using (var ms = new MemoryStream())
                {
                    bitmap.Save(ms, System.Drawing.Imaging.ImageFormat.Png);
                    var base64 = Convert.ToBase64String(ms.ToArray());
                    return $"data:image/png;base64,{base64}";
                }
            }
            catch (Exception ex)
            {
                _ = ex;
                return null;
            }
        }

        /// <summary>
        /// 提取文件的最高质量图标
        /// </summary>
        /// <param name="filePath">文件路径</param>
        /// <returns>最高质量的图标 Bitmap</returns>
        private static Bitmap? ExtractBestQualityIcon(string filePath)
        {
            // 优先级顺序: 256x256 > 128x128 > 48x48 > 32x32 > 16x16
            var iconSizes = new[] { 256, 128, 48, 32, 16 };

            foreach (var size in iconSizes)
            {
                try
                {
                    var bitmap = ExtractIconWithSize(filePath, size);
                    if (bitmap != null)
                    {
                        return bitmap;
                    }
                }
                catch { /* 继续尝试下一个尺寸 */ }
            }

            // 回退方案: 提取文件中的第一个图标（任意尺寸）
            return ExtractFirstAvailableIcon(filePath);
        }

        /// <summary>
        /// 使用 PrivateExtractIcons 提取指定尺寸的图标
        /// </summary>
        /// <param name="filePath">文件路径</param>
        /// <param name="size">图标尺寸（像素）</param>
        /// <returns>指定尺寸的图标 Bitmap，失败返回 null</returns>
        private static Bitmap? ExtractIconWithSize(string filePath, int size)
        {
            try
            {
                IntPtr[] hIcons = new IntPtr[1];
                int[] ids = new int[1];

                // 调用 PrivateExtractIcons 提取指定尺寸的图标
                uint successCount = PrivateExtractIcons(
                    filePath,
                    0,           // 图标索引 (0 = 第一个)
                    size,        // 宽度
                    size,        // 高度
                    hIcons,      // 输出图标句柄
                    ids,         // 输出图标 ID
                    1,           // 提取1个图标
                    0            // 标志 (0 = 默认)
                );

                if (successCount == 0 || hIcons[0] == IntPtr.Zero)
                {
                    return null;
                }

                try
                {
                    // 转换图标句柄为高质量 Bitmap
                    using (Icon icon = Icon.FromHandle(hIcons[0]))
                    {
                        return IconToBitmapHighQuality(icon);
                    }
                }
                finally
                {
                    // 释放图标句柄
                    DestroyIcon(hIcons[0]);
                }
            }
            catch
            {
                return null;
            }
        }

        /// <summary>
        /// 提取文件中第一个可用的图标（任意尺寸）
        /// </summary>
        /// <param name="filePath">文件路径</param>
        /// <returns>图标 Bitmap，失败返回 null</returns>
        private static Bitmap? ExtractFirstAvailableIcon(string filePath)
        {
            try
            {
                // 第一次调用: 获取图标总数
                uint iconTotalCount = PrivateExtractIcons(filePath, 0, 0, 0, null, null, 0, 0);

                if (iconTotalCount == 0)
                {
                    // 最后的回退: 使用 Icon.ExtractAssociatedIcon
                    using var icon = Icon.ExtractAssociatedIcon(filePath);
                    if (icon != null)
                    {
                        return IconToBitmapHighQuality(icon);
                    }
                    return null;
                }

                // 准备接收数组
                IntPtr[] hIcons = new IntPtr[iconTotalCount];
                int[] ids = new int[iconTotalCount];

                // 第二次调用: 提取所有图标（最大256x256）
                uint successCount = PrivateExtractIcons(
                    filePath,
                    0,           // 从第一个图标开始
                    256,         // 最大宽度
                    256,         // 最大高度
                    hIcons,
                    ids,
                    iconTotalCount,
                    0
                );

                if (successCount == 0)
                {
                    return null;
                }

                // 找到最大尺寸的图标
                Bitmap? bestBitmap = null;
                int maxSize = 0;

                for (int i = 0; i < successCount; i++)
                {
                    if (hIcons[i] == IntPtr.Zero) continue;

                    try
                    {
                        using (Icon icon = Icon.FromHandle(hIcons[i]))
                        {
                            int iconSize = icon.Width * icon.Height;
                            if (iconSize > maxSize)
                            {
                                maxSize = iconSize;
                                bestBitmap?.Dispose();
                                bestBitmap = IconToBitmapHighQuality(icon);
                            }
                        }
                    }
                    finally
                    {
                        DestroyIcon(hIcons[i]);
                    }
                }

                return bestBitmap;
            }
            catch
            {
                return null;
            }
        }

        /// <summary>
        /// 将图标转换为高质量 Bitmap
        /// </summary>
        /// <param name="icon">图标对象</param>
        /// <returns>高质量 Bitmap</returns>
        private static Bitmap IconToBitmapHighQuality(Icon icon)
        {
            // 创建高质量 Bitmap，保留 Alpha 通道（透明度）
            Bitmap bitmap = new Bitmap(icon.Width, icon.Height, System.Drawing.Imaging.PixelFormat.Format32bppArgb);

            using (Graphics g = Graphics.FromImage(bitmap))
            {
                // 设置最高质量的渲染选项
                g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.HighQuality;
                g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
                g.CompositingQuality = System.Drawing.Drawing2D.CompositingQuality.HighQuality;

                // 绘制图标到 Bitmap
                g.DrawIcon(icon, new Rectangle(0, 0, icon.Width, icon.Height));
            }

            return bitmap;
        }

        // ===== 系统音量控制 =====

        private static void SetSystemVolume(int volume)
        {
            // 使用 NAudio 设置系统音量
            // 音量范围: 0.0f (0%) 到 1.0f (100%)
            float volumeLevel = Math.Clamp(volume / 100.0f, 0.0f, 1.0f);

            try
            {
                using var enumerator = new MMDeviceEnumerator();
                var device = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
                device.AudioEndpointVolume.MasterVolumeLevelScalar = volumeLevel;
            }
            catch (Exception ex)
            {
                _ = ex;
                throw;
            }
        }

        private static void SetSystemMute(bool mute)
        {
            // 使用 NAudio 设置系统静音状态
            try
            {
                using var enumerator = new MMDeviceEnumerator();
                var device = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
                device.AudioEndpointVolume.Mute = mute;
            }
            catch (Exception ex)
            {
                _ = ex;
                throw;
            }
        }

        private static bool GetSystemMute()
        {
            // 使用 NAudio 获取系统静音状态
            try
            {
                using var enumerator = new MMDeviceEnumerator();
                var device = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
                return device.AudioEndpointVolume.Mute;
            }
            catch (Exception ex)
            {
                _ = ex;
                throw;
            }
        }

        // ===== 麦克风控制 =====

        private static void SetMicrophoneMute(bool mute)
        {
            // 使用 NAudio 设置麦克风静音状态
            try
            {
                using var enumerator = new MMDeviceEnumerator();
                var device = enumerator.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Communications);
                device.AudioEndpointVolume.Mute = mute;
            }
            catch (Exception ex)
            {
                _ = ex;
                throw;
            }
        }

        private static bool GetMicrophoneMute()
        {
            // 使用 NAudio 获取麦克风静音状态
            try
            {
                using var enumerator = new MMDeviceEnumerator();
                var device = enumerator.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Communications);
                return device.AudioEndpointVolume.Mute;
            }
            catch (Exception ex)
            {
                _ = ex;
                throw;
            }
        }

        // ===== 系统媒体控制 (SMTC) =====

        private static MessageBridge? bridgeInstance;
        private static bool smtcInitialized = false;

#if WINDOWS
        private static GlobalSystemMediaTransportControlsSessionManager? smtcManager;
        private static List<GlobalSystemMediaTransportControlsSession> smtcSessions = new();
#endif
        private static readonly HttpClient WeatherHttp = CreateWeatherHttp();
        private static readonly object WeatherLock = new object();
        private static WeatherSnapshot? WeatherCache;
        private static DateTimeOffset WeatherCacheAt = DateTimeOffset.MinValue;
        private static WeatherLocation? WeatherLocationCache;
        private static DateTimeOffset WeatherLocationAt = DateTimeOffset.MinValue;

        public static async void InitializeSmtcMonitoring(MessageBridge bridge)
        {
            if (smtcInitialized) return;

            bridgeInstance = bridge;

#if WINDOWS
            try
            {
                smtcManager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
                smtcManager.SessionsChanged += (sender, args) => { _ = Task.Run(RebuildSmtcSessionsAndBroadcastAsync); };

                await RebuildSmtcSessionsAndBroadcastAsync();

                smtcInitialized = true;
            }
            catch (Exception ex)
            {
                _ = ex;
            }
#else
            smtcInitialized = true;
#endif
        }

#if WINDOWS
        private static async Task RebuildSmtcSessionsAndBroadcastAsync()
        {
            if (smtcManager == null)
            {
                return;
            }

            try
            {
                // 重新抓取会话列表，按 SourceAppUserModelId 排序以提供稳定顺序
                var sessions = smtcManager.GetSessions()
                    .OrderBy(s => s.SourceAppUserModelId ?? string.Empty, StringComparer.OrdinalIgnoreCase)
                    .ToList();

                // 解除旧订阅
                foreach (var old in smtcSessions)
                {
                    try { old.MediaPropertiesChanged -= OnSmtcMediaPropertiesChanged; } catch { }
                    try { old.PlaybackInfoChanged -= OnSmtcPlaybackInfoChanged; } catch { }
                }

                smtcSessions = sessions;

                // 订阅新会话变化
                foreach (var s in smtcSessions)
                {
                    try { s.MediaPropertiesChanged += OnSmtcMediaPropertiesChanged; } catch { }
                    try { s.PlaybackInfoChanged += OnSmtcPlaybackInfoChanged; } catch { }
                }

                PushSmtcSessionsList_NoThrow();

                // 推送当前聚焦会话（或第一个）
                var focused = smtcManager.GetCurrentSession() ?? smtcSessions.FirstOrDefault();
                if (focused != null)
                {
                    await PushSmtcMediaInfo_NoThrow(focused);
                }
            }
            catch (Exception ex)
            {
                _ = ex;
            }
        }

        private static void OnSmtcMediaPropertiesChanged(GlobalSystemMediaTransportControlsSession sender, MediaPropertiesChangedEventArgs args)
        {
            _ = Task.Run(() => PushSmtcMediaInfo_NoThrow(sender));
        }

        private static void OnSmtcPlaybackInfoChanged(GlobalSystemMediaTransportControlsSession sender, PlaybackInfoChangedEventArgs args)
        {
            _ = Task.Run(() => PushSmtcMediaInfo_NoThrow(sender));
        }

        private static void PushSmtcSessionsList_NoThrow()
        {
            try
            {
                var sessionList = new List<object>(smtcSessions.Count);
                for (int i = 0; i < smtcSessions.Count; i++)
                {
                    sessionList.Add(new
                    {
                        id = i,
                        sourceAppId = smtcSessions[i].SourceAppUserModelId
                    });
                }

                bridgeInstance?.BroadcastEvent(Module.System, "mediaSessionsChanged", new { sessions = sessionList });
            }
            catch (Exception ex)
            {
                _ = ex;
            }
        }

        private static async Task PushSmtcMediaInfo_NoThrow(GlobalSystemMediaTransportControlsSession session)
        {
            try
            {
                var sessionId = smtcSessions.IndexOf(session);
                if (sessionId < 0)
                {
                    return;
                }

                var mediaInfo = await GetMediaInfoAsync(session);
                bridgeInstance?.BroadcastEvent(Module.System, "mediaInfoChanged", new
                {
                    sessionId = sessionId,
                    data = mediaInfo
                });
            }
            catch (Exception ex)
            {
                _ = ex;
            }
        }

        private static async Task<object> GetMediaInfoAsync(GlobalSystemMediaTransportControlsSession session)
        {
            try
            {
                var mediaProperties = await session.TryGetMediaPropertiesAsync();
                var playbackInfo = session.GetPlaybackInfo();

                return new
                {
                    title = mediaProperties?.Title ?? "未知标题",
                    artist = mediaProperties?.Artist ?? "未知艺术家",
                    album = mediaProperties?.AlbumTitle ?? "",
                    thumbnail = (string?)null,
                    isPlaying = playbackInfo?.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing
                };
            }
            catch (Exception ex)
            {
                _ = ex;
                return new { title = "未知标题", artist = "未知艺术家", album = "", thumbnail = (string?)null, isPlaying = false };
            }
        }
#endif

        private static Task<List<object>> GetMediaSessionsAsync()
        {
#if WINDOWS
            if (smtcManager == null)
            {
                return Task.FromResult(new List<object>());
            }

            var sessionList = new List<object>(smtcSessions.Count);
            for (int i = 0; i < smtcSessions.Count; i++)
            {
                sessionList.Add(new
                {
                    id = i,
                    sourceAppId = smtcSessions[i].SourceAppUserModelId
                });
            }

            return Task.FromResult(sessionList);
#else
            return Task.FromResult(new List<object>());
#endif
        }

        private static async Task<object> GetCurrentMediaInfoAsync(int sessionId)
        {
#if WINDOWS
            if (smtcManager == null)
            {
                return new { title = "未在播放", artist = "", isPlaying = false };
            }

            if (sessionId < 0 || sessionId >= smtcSessions.Count)
            {
                return new { title = "未在播放", artist = "", isPlaying = false };
            }

            var session = smtcSessions[sessionId];
            return await GetMediaInfoAsync(session);
#else
            return new { title = "未在播放", artist = "", isPlaying = false };
#endif
        }

        private static async Task MediaPlayPauseAsync(int sessionId)
        {
#if WINDOWS
            if (smtcManager == null) return;
            if (sessionId < 0 || sessionId >= smtcSessions.Count) return;

            var session = smtcSessions[sessionId];
            var playbackInfo = session.GetPlaybackInfo();

            if (playbackInfo?.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing)
            {
                await session.TryPauseAsync();
            }
            else
            {
                await session.TryPlayAsync();
            }
#else
            await Task.CompletedTask;
#endif
        }

        private static async Task MediaNextAsync(int sessionId)
        {
#if WINDOWS
            if (smtcManager == null) return;
            if (sessionId < 0 || sessionId >= smtcSessions.Count) return;

            var session = smtcSessions[sessionId];
            await session.TrySkipNextAsync();
#else
            await Task.CompletedTask;
#endif
        }

        private static async Task MediaPreviousAsync(int sessionId)
        {
#if WINDOWS
            if (smtcManager == null) return;
            if (sessionId < 0 || sessionId >= smtcSessions.Count) return;

            var session = smtcSessions[sessionId];
            await session.TrySkipPreviousAsync();
#else
            await Task.CompletedTask;
#endif
        }

        // ===== 天气获取 (上位机) =====

        private static HttpClient CreateWeatherHttp()
        {
            var handler = new HttpClientHandler
            {
                AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate
            };
            var client = new HttpClient(handler)
            {
                Timeout = TimeSpan.FromSeconds(6)
            };
            client.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36");
            client.DefaultRequestHeaders.Accept.ParseAdd("application/json,text/plain,*/*");
            client.DefaultRequestHeaders.AcceptLanguage.ParseAdd("zh-CN,zh;q=0.9,en;q=0.8");
            return client;
        }

        private sealed class WeatherLocation
        {
            public double Latitude { get; set; }
            public double Longitude { get; set; }
            public string? Name { get; set; }
        }

        private sealed class WeatherSnapshot
        {
            public int Temperature { get; set; }
            public string Description { get; set; } = string.Empty;
            public string Icon { get; set; } = string.Empty;
            public string? Location { get; set; }
            public long FetchedAt { get; set; }
            public string Source { get; set; } = string.Empty;
        }

        private static WeatherSnapshot? GetCachedWeather()
        {
            lock (WeatherLock)
            {
                if (WeatherCache == null) return null;
                if (DateTimeOffset.UtcNow - WeatherCacheAt > TimeSpan.FromMinutes(30))
                {
                    return null;
                }
                return WeatherCache;
            }
        }

        private static async Task<WeatherSnapshot> GetWeatherAsync(bool forceRefresh)
        {
            var now = DateTimeOffset.UtcNow;

            lock (WeatherLock)
            {
                if (!forceRefresh && WeatherCache != null && now - WeatherCacheAt < TimeSpan.FromMinutes(10))
                {
                    return WeatherCache;
                }
            }

            var location = await GetWeatherLocationAsync();
            var snapshot = await FetchWeatherAsync(location);

            lock (WeatherLock)
            {
                WeatherCache = snapshot;
                WeatherCacheAt = now;
            }

            return snapshot;
        }

        private static async Task<WeatherLocation> GetWeatherLocationAsync()
        {
            var now = DateTimeOffset.UtcNow;

            lock (WeatherLock)
            {
                if (WeatherLocationCache != null && now - WeatherLocationAt < TimeSpan.FromHours(12))
                {
                    return WeatherLocationCache;
                }
            }

            using var response = await WeatherHttp.GetAsync("https://ipapi.co/json/");
            response.EnsureSuccessStatusCode();

            var content = await response.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(content);
            var root = doc.RootElement;

            var latitude = TryGetDouble(root, "latitude");
            var longitude = TryGetDouble(root, "longitude");
            var city = TryGetString(root, "city");
            var region = TryGetString(root, "region");
            var country = TryGetString(root, "country_name");

            var locationName = BuildLocationName(city, region, country);
            var location = new WeatherLocation
            {
                Latitude = latitude,
                Longitude = longitude,
                Name = locationName
            };

            lock (WeatherLock)
            {
                WeatherLocationCache = location;
                WeatherLocationAt = now;
            }

            return location;
        }

        private static async Task<WeatherSnapshot> FetchWeatherAsync(WeatherLocation location)
        {
            var lat = location.Latitude.ToString(CultureInfo.InvariantCulture);
            var lon = location.Longitude.ToString(CultureInfo.InvariantCulture);
            var url = $"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current=temperature_2m,weather_code&timezone=auto";

            using var response = await WeatherHttp.GetAsync(url);
            response.EnsureSuccessStatusCode();

            var content = await response.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(content);
            var current = doc.RootElement.GetProperty("current");

            var temp = TryGetDouble(current, "temperature_2m");
            var code = TryGetInt(current, "weather_code");

            var (description, icon) = MapWeatherCode(code);

            return new WeatherSnapshot
            {
                Temperature = (int)Math.Round(temp),
                Description = description,
                Icon = icon,
                Location = location.Name,
                FetchedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                Source = "open-meteo"
            };
        }

        private static (string description, string icon) MapWeatherCode(int code)
        {
            return code switch
            {
                0 => ("晴", "☀️"),
                1 => ("少云", "🌤️"),
                2 => ("多云", "⛅"),
                3 => ("阴", "☁️"),
                45 => ("雾", "🌫️"),
                48 => ("雾", "🌫️"),
                51 => ("小毛毛雨", "🌦️"),
                53 => ("毛毛雨", "🌦️"),
                55 => ("毛毛雨", "🌧️"),
                56 => ("冻雨", "🌧️"),
                57 => ("冻雨", "🌧️"),
                61 => ("小雨", "🌧️"),
                63 => ("中雨", "🌧️"),
                65 => ("大雨", "🌧️"),
                66 => ("冻雨", "🌧️"),
                67 => ("冻雨", "🌧️"),
                71 => ("小雪", "🌨️"),
                73 => ("中雪", "🌨️"),
                75 => ("大雪", "❄️"),
                77 => ("雪粒", "❄️"),
                80 => ("阵雨", "🌦️"),
                81 => ("强阵雨", "🌧️"),
                82 => ("暴雨", "🌧️"),
                85 => ("阵雪", "🌨️"),
                86 => ("大阵雪", "❄️"),
                95 => ("雷暴", "⛈️"),
                96 => ("雷暴冰雹", "⛈️"),
                99 => ("强雷暴冰雹", "⛈️"),
                _ => ("未知", "⛅")
            };
        }

        private static string? BuildLocationName(string? city, string? region, string? country)
        {
            var parts = new List<string>();
            if (!string.IsNullOrWhiteSpace(city))
            {
                parts.Add(city);
            }
            if (!string.IsNullOrWhiteSpace(region) && !string.Equals(region, city, StringComparison.OrdinalIgnoreCase))
            {
                parts.Add(region);
            }
            if (parts.Count == 0 && !string.IsNullOrWhiteSpace(country))
            {
                parts.Add(country);
            }
            return parts.Count > 0 ? string.Join(" ", parts) : null;
        }

        private static string? TryGetString(JsonElement element, string propertyName)
        {
            if (!element.TryGetProperty(propertyName, out var value))
            {
                return null;
            }
            return value.ValueKind == JsonValueKind.String ? value.GetString() : value.ToString();
        }

        private static double TryGetDouble(JsonElement element, string propertyName)
        {
            if (!element.TryGetProperty(propertyName, out var value))
            {
                throw new InvalidOperationException($"Missing property: {propertyName}");
            }
            if (value.ValueKind == JsonValueKind.Number)
            {
                return value.GetDouble();
            }
            if (value.ValueKind == JsonValueKind.String &&
                double.TryParse(value.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed))
            {
                return parsed;
            }
            throw new InvalidOperationException($"Invalid number: {propertyName}");
        }

        private static int TryGetInt(JsonElement element, string propertyName)
        {
            if (!element.TryGetProperty(propertyName, out var value))
            {
                throw new InvalidOperationException($"Missing property: {propertyName}");
            }
            if (value.ValueKind == JsonValueKind.Number)
            {
                if (value.TryGetInt32(out var intValue))
                {
                    return intValue;
                }
                return (int)Math.Round(value.GetDouble());
            }
            if (value.ValueKind == JsonValueKind.String &&
                int.TryParse(value.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed))
            {
                return parsed;
            }
            throw new InvalidOperationException($"Invalid int: {propertyName}");
        }

        // ===== Windows API P/Invoke 声明 =====

        /// <summary>
        /// 从可执行文件、DLL 或图标文件中提取图标
        /// 这是一个未公开的 API，但广泛使用且稳定
        /// </summary>
        /// <param name="szFileName">文件路径</param>
        /// <param name="nIconIndex">图标索引 (0 = 第一个)</param>
        /// <param name="cxIcon">请求的图标宽度 (0 = 获取总数)</param>
        /// <param name="cyIcon">请求的图标高度 (0 = 获取总数)</param>
        /// <param name="phicon">输出图标句柄数组</param>
        /// <param name="piconid">输出图标 ID 数组</param>
        /// <param name="nIcons">要提取的图标数量</param>
        /// <param name="flags">标志 (0 = 默认, LR_DEFAULTCOLOR = 0)</param>
        /// <returns>提取成功的图标数量，或图标总数（当 cxIcon 和 cyIcon 为 0 时）</returns>
        [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern uint PrivateExtractIcons(
            string szFileName,
            int nIconIndex,
            int cxIcon,
            int cyIcon,
            IntPtr[]? phicon,
            int[]? piconid,
            uint nIcons,
            uint flags
        );

        /// <summary>
        /// 销毁图标句柄，释放资源
        /// </summary>
        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool DestroyIcon(IntPtr hIcon);

        private static string? GetShortcutTarget(string shortcutPath)
        {
            try
            {
                using var fs = new FileStream(shortcutPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                using var reader = new BinaryReader(fs, Encoding.Default, leaveOpen: false);

                if (fs.Length < 0x4C) return null;

                var headerSize = reader.ReadUInt32();
                if (headerSize != 0x4C) return null;

                var clsid = new Guid(reader.ReadBytes(16));
                if (clsid != new Guid("00021401-0000-0000-C000-000000000046")) return null;

                var linkFlags = reader.ReadUInt32();
                fs.Position = 0x4C;

                const uint HasLinkTargetIdList = 0x00000001;
                const uint HasLinkInfo = 0x00000002;

                if ((linkFlags & HasLinkTargetIdList) != 0)
                {
                    if (fs.Position + 2 > fs.Length) return null;
                    var idListSize = reader.ReadUInt16();
                    fs.Position += idListSize;
                }

                if ((linkFlags & HasLinkInfo) == 0 || fs.Position + 4 > fs.Length)
                {
                    return null;
                }

                var linkInfoStart = fs.Position;
                var linkInfoSize = reader.ReadUInt32();
                if (linkInfoSize < 0x1C || linkInfoStart + linkInfoSize > fs.Length) return null;

                var linkInfoHeaderSize = reader.ReadUInt32();
                var linkInfoFlags = reader.ReadUInt32();
                _ = reader.ReadUInt32(); // VolumeIDOffset
                var localBasePathOffset = reader.ReadUInt32();
                _ = reader.ReadUInt32(); // CommonNetworkRelativeLinkOffset
                var commonPathSuffixOffset = reader.ReadUInt32();

                uint localBasePathOffsetUnicode = 0;
                uint commonPathSuffixOffsetUnicode = 0;
                if (linkInfoHeaderSize >= 0x24 && fs.Position + 8 <= fs.Length)
                {
                    localBasePathOffsetUnicode = reader.ReadUInt32();
                    commonPathSuffixOffsetUnicode = reader.ReadUInt32();
                }

                var localBasePath = ReadLinkInfoString(fs, linkInfoStart, linkInfoSize, localBasePathOffsetUnicode, unicode: true)
                    ?? ReadLinkInfoString(fs, linkInfoStart, linkInfoSize, localBasePathOffset, unicode: false);

                var commonPathSuffix = ReadLinkInfoString(fs, linkInfoStart, linkInfoSize, commonPathSuffixOffsetUnicode, unicode: true)
                    ?? ReadLinkInfoString(fs, linkInfoStart, linkInfoSize, commonPathSuffixOffset, unicode: false);

                if (string.IsNullOrWhiteSpace(localBasePath))
                {
                    return null;
                }

                if (string.IsNullOrWhiteSpace(commonPathSuffix))
                {
                    return localBasePath;
                }

                if (Path.IsPathRooted(commonPathSuffix))
                {
                    return commonPathSuffix;
                }

                return Path.Combine(localBasePath, commonPathSuffix);
            }
            catch
            {
                return null;
            }
        }

        private static string? ReadLinkInfoString(Stream stream, long linkInfoStart, uint linkInfoSize, uint offset, bool unicode)
        {
            if (offset == 0) return null;

            var absoluteOffset = linkInfoStart + offset;
            var linkInfoEnd = linkInfoStart + linkInfoSize;
            if (absoluteOffset < linkInfoStart || absoluteOffset >= linkInfoEnd || absoluteOffset >= stream.Length)
            {
                return null;
            }

            stream.Position = absoluteOffset;
            return unicode
                ? ReadNullTerminatedUnicodeString(stream, linkInfoEnd)
                : ReadNullTerminatedAnsiString(stream, linkInfoEnd);
        }

        private static string? ReadNullTerminatedAnsiString(Stream stream, long maxPosition)
        {
            using var ms = new MemoryStream();
            while (stream.Position < maxPosition && stream.Position < stream.Length)
            {
                var value = stream.ReadByte();
                if (value < 0 || value == 0) break;
                ms.WriteByte((byte)value);
            }

            if (ms.Length == 0) return null;
            return Encoding.Default.GetString(ms.ToArray()).Trim();
        }

        private static string? ReadNullTerminatedUnicodeString(Stream stream, long maxPosition)
        {
            var bytes = new List<byte>();
            while (stream.Position + 1 < maxPosition && stream.Position + 1 < stream.Length)
            {
                var b1 = stream.ReadByte();
                var b2 = stream.ReadByte();
                if (b1 < 0 || b2 < 0) break;
                if (b1 == 0 && b2 == 0) break;
                bytes.Add((byte)b1);
                bytes.Add((byte)b2);
            }

            if (bytes.Count == 0) return null;
            return Encoding.Unicode.GetString(bytes.ToArray()).Trim();
        }

    }

    public class SerialSendRequest
    {
        public string Raw { get; set; } = string.Empty;
    }

    public class VolumeRequest
    {
        public int Volume { get; set; }
    }

    public class MuteRequest
    {
        public bool Mute { get; set; }
    }

    public class NightLightRequest
    {
        public bool Enabled { get; set; }
    }

    public class MicrophoneRequest
    {
        public bool Enabled { get; set; }
    }

    public class MediaSessionRequest
    {
        public int SessionId { get; set; }
    }

    public class WeatherRequest
    {
        public bool Refresh { get; set; }
    }

    public class FullscreenRequest
    {
        public bool Enable { get; set; }
    }

    public class NoActivateRequest
    {
        public bool Enable { get; set; }
    }
}
