using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;

namespace PanelManager.Models
{
    #region 枚举定义

    /// <summary>
    /// 消息目标
    /// </summary>
    public enum Target
    {
        Host = 0,       // 上位机
        Device = 1,     // 下位机
    }

    /// <summary>
    /// 模块分类
    /// </summary>
    public enum Module
    {
        System = 0,     // 系统
        Serial = 1,     // 串口
        Bluetooth = 2,  // 蓝牙
        Wifi = 3,       // WiFi
        Network = 4,    // 网络设置
        Hid = 5,        // HID 报文
        Shortcut = 6,   // 快捷指令
        App = 7,        // 应用管理
        Panel = 8,      // 面板控制 (亮度/背光)
        Update = 9,     // 系统更新 (OTA固件升级)
    }

    /// <summary>
    /// 消息类型
    /// </summary>
    public enum MsgType
    {
        Request = 0,    // 请求
        Response = 1,   // 响应
        Event = 2,      // 事件
    }

    #endregion

    #region 消息定义

    /// <summary>
    /// 统一消息格式
    /// </summary>
    public class Message
    {
        /// <summary>
        /// 协议版本
        /// </summary>
        [JsonPropertyName("v")]
        public int Version { get; set; } = 1;

        /// <summary>
        /// 消息ID，用于匹配请求和响应
        /// </summary>
        [JsonPropertyName("id")]
        public string Id { get; set; } = GenerateId();

        /// <summary>
        /// 消息目标
        /// </summary>
        [JsonPropertyName("target")]
        public Target Target { get; set; }

        /// <summary>
        /// 消息类型
        /// </summary>
        [JsonPropertyName("type")]
        public MsgType Type { get; set; }

        /// <summary>
        /// 模块
        /// </summary>
        [JsonPropertyName("mod")]
        public Module Module { get; set; }

        /// <summary>
        /// 命令/事件名称
        /// </summary>
        [JsonPropertyName("cmd")]
        public string Cmd { get; set; } = string.Empty;

        /// <summary>
        /// 数据负载
        /// </summary>
        [JsonPropertyName("data")]
        public JsonElement? Data { get; set; }

        /// <summary>
        /// 状态码 (0=成功, 非0=错误码)
        /// </summary>
        [JsonPropertyName("code")]
        public int Code { get; set; } = 0;

        /// <summary>
        /// 错误/状态消息
        /// </summary>
        [JsonPropertyName("msg")]
        public string? Msg { get; set; }

        /// <summary>
        /// 时间戳
        /// </summary>
        [JsonPropertyName("ts")]
        public long Timestamp { get; set; } = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        #region 静态方法

        private static string GenerateId() => Guid.NewGuid().ToString("N")[..8];

        public string ToJson() => JsonSerializer.Serialize(this, JsonOptions.Default);

        public static Message? FromJson(string json)
        {
            try
            {
                return JsonSerializer.Deserialize<Message>(json, JsonOptions.Default);
            }
            catch
            {
                return null;
            }
        }

        /// <summary>
        /// 创建成功响应
        /// </summary>
        public Message Ok(object? data = null)
        {
            return new Message
            {
                Id = this.Id,
                Target = this.Target,
                Type = MsgType.Response,
                Module = this.Module,
                Cmd = this.Cmd,
                Code = 0,
                Data = data != null ? JsonSerializer.SerializeToElement(data, JsonOptions.Default) : null
            };
        }

        /// <summary>
        /// 创建失败响应
        /// </summary>
        public Message Fail(int code, string msg)
        {
            return new Message
            {
                Id = this.Id,
                Target = this.Target,
                Type = MsgType.Response,
                Module = this.Module,
                Cmd = this.Cmd,
                Code = code,
                Msg = msg
            };
        }

        /// <summary>
        /// 创建事件
        /// </summary>
        public static Message Event(Target target, Module module, string cmd, object? data = null)
        {
            return new Message
            {
                Target = target,
                Type = MsgType.Event,
                Module = module,
                Cmd = cmd,
                Data = data != null ? JsonSerializer.SerializeToElement(data, JsonOptions.Default) : null
            };
        }

        /// <summary>
        /// 创建请求
        /// </summary>
        public static Message Request(Target target, Module module, string cmd, object? data = null)
        {
            return new Message
            {
                Target = target,
                Type = MsgType.Request,
                Module = module,
                Cmd = cmd,
                Data = data != null ? JsonSerializer.SerializeToElement(data, JsonOptions.Default) : null
            };
        }

        /// <summary>
        /// 获取强类型数据
        /// </summary>
        public T? GetData<T>()
        {
            if (Data == null) return default;
            return JsonSerializer.Deserialize<T>(Data.Value.GetRawText(), JsonOptions.Default);
        }

        #endregion
    }

    /// <summary>
    /// JSON 序列化选项
    /// </summary>
    public static class JsonOptions
    {
        public static readonly JsonSerializerOptions Default = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            // 不使用 JsonStringEnumConverter，让枚举序列化为数字
        };
    }

    #endregion

    #region 错误码定义

    /// <summary>
    /// 错误码
    /// </summary>
    public static class ErrorCode
    {
        public const int Success = 0;
        public const int Unknown = 1;
        public const int InvalidRequest = 2;
        public const int InvalidParams = 3;
        public const int NotFound = 4;
        public const int Timeout = 5;
        public const int Busy = 6;
        public const int DeviceNotFound = 7;

        // 串口错误 100-199
        public const int SerialNotOpen = 100;
        public const int SerialOpenFailed = 101;
        public const int SerialWriteFailed = 102;

        // 蓝牙错误 200-299
        public const int BluetoothDisabled = 200;
        public const int BluetoothScanFailed = 201;
        public const int BluetoothPairFailed = 202;
        public const int BluetoothConnectFailed = 203;
        public const int BluetoothDisconnectFailed = 204;
        public const int BluetoothNotConnected = 205;
        public const int BluetoothAlreadyConnected = 206;
        public const int BluetoothDeviceNotFound = 207;
        public const int BluetoothInvalidMode = 208;

        // WiFi 错误 300-399
        public const int WifiDisabled = 300;
        public const int WifiScanFailed = 301;
        public const int WifiConnectFailed = 302;

        // 网络错误 400-499
        public const int NetworkConfigFailed = 400;

        // 应用错误 500-599
        public const int AppNotFound = 500;
        public const int AppLaunchFailed = 501;

        // 面板控制错误 800-899
        public const int PanelPwmFailed = 800;
        public const int PanelBrightnessInvalid = 801;

        // 内部错误 9000+
        public const int Internal = 9000;
        public const int OperationFailed = 9001;
    }

    #endregion

    #region 数据模型

    // ===== 串口相关 =====
    public class SerialConfig
    {
        [JsonPropertyName("port")]
        public string Port { get; set; } = string.Empty;

        [JsonPropertyName("baudRate")]
        public int BaudRate { get; set; } = 115200;

        [JsonPropertyName("dataBits")]
        public int DataBits { get; set; } = 8;

        [JsonPropertyName("stopBits")]
        public int StopBits { get; set; } = 1;

        [JsonPropertyName("parity")]
        public string Parity { get; set; } = "none";
    }

    public class SerialInfo
    {
        [JsonPropertyName("port")]
        public string Port { get; set; } = string.Empty;

        [JsonPropertyName("description")]
        public string Description { get; set; } = string.Empty;
    }

    // ===== 蓝牙相关 =====

    /// <summary>
    /// 蓝牙工作模式
    /// </summary>
    public enum BluetoothMode
    {
        Disabled = 0,   // 关闭
        Receiver = 1,   // 接收器模式 (耳机/音箱)
        Emitter = 2     // 发射器模式 (主动连接)
    }

    /// <summary>
    /// 蓝牙设备类型
    /// </summary>
    public enum BluetoothDeviceType
    {
        Unknown = 0,
        Classic = 1,    // 经典蓝牙
        BLE = 2,        // 低功耗蓝牙
        Dual = 3        // 双模
    }

    /// <summary>
    /// 蓝牙配置文件
    /// </summary>
    public enum BluetoothProfile
    {
        A2DP = 0,       // Advanced Audio Distribution Profile (高质量音频)
        AVRCP = 1,      // Audio/Video Remote Control Profile (远程控制)
        HFP = 2,        // Hands-Free Profile (免提)
        HSP = 3,        // Headset Profile (耳机)
        SPP = 4,        // Serial Port Profile (串口)
        HID = 5,        // Human Interface Device (人机接口)
        PBAP = 6,       // Phone Book Access Profile (电话簿)
    }

    /// <summary>
    /// 蓝牙连接状态
    /// </summary>
    public enum BluetoothConnectionState
    {
        Disconnected = 0,   // 未连接
        Connecting = 1,     // 连接中
        Connected = 2,      // 已连接
        Disconnecting = 3   // 断开中
    }

    /// <summary>
    /// 蓝牙音频状态
    /// </summary>
    public enum BluetoothAudioState
    {
        Stopped = 0,    // 停止
        Playing = 1,    // 播放中
        Paused = 2      // 暂停
    }

    /// <summary>
    /// 蓝牙设备信息
    /// </summary>
    public class BluetoothDevice
    {
        /// <summary>
        /// 设备MAC地址 (格式: XX:XX:XX:XX:XX:XX)
        /// </summary>
        [JsonPropertyName("addr")]
        public string Address { get; set; } = string.Empty;

        /// <summary>
        /// 设备名称
        /// </summary>
        [JsonPropertyName("name")]
        public string Name { get; set; } = string.Empty;

        /// <summary>
        /// 是否已配对
        /// </summary>
        [JsonPropertyName("paired")]
        public bool Paired { get; set; }

        /// <summary>
        /// 是否已连接
        /// </summary>
        [JsonPropertyName("connected")]
        public bool Connected { get; set; }

        /// <summary>
        /// 信号强度 (RSSI, dBm)
        /// </summary>
        [JsonPropertyName("rssi")]
        public int? Rssi { get; set; }

        /// <summary>
        /// 设备类型 (CoD - Class of Device)
        /// </summary>
        [JsonPropertyName("class")]
        public string? Class { get; set; }

        /// <summary>
        /// 设备类型 (classic/ble/dual)
        /// </summary>
        [JsonPropertyName("type")]
        public string Type { get; set; } = "classic";

        /// <summary>
        /// 支持的配置文件列表
        /// </summary>
        [JsonPropertyName("profiles")]
        public string[]? Profiles { get; set; }

        /// <summary>
        /// 最后连接时间戳
        /// </summary>
        [JsonPropertyName("lastConnected")]
        public long? LastConnected { get; set; }
    }

    /// <summary>
    /// 蓝牙模式设置请求
    /// </summary>
    public class BluetoothModeRequest
    {
        /// <summary>
        /// 模式: 0=关闭, 1=接收器, 2=发射器
        /// </summary>
        [JsonPropertyName("mode")]
        public int Mode { get; set; }
    }

    /// <summary>
    /// 蓝牙扫描请求
    /// </summary>
    public class BluetoothScanRequest
    {
        /// <summary>
        /// 扫描持续时间(秒), 默认20秒
        /// </summary>
        [JsonPropertyName("duration")]
        public int Duration { get; set; } = 20;

        /// <summary>
        /// 设备名称过滤 (可选)
        /// </summary>
        [JsonPropertyName("nameFilter")]
        public string? NameFilter { get; set; }

        /// <summary>
        /// 设备地址过滤 (可选)
        /// </summary>
        [JsonPropertyName("addrFilter")]
        public string? AddrFilter { get; set; }
    }

    /// <summary>
    /// 蓝牙连接请求
    /// </summary>
    public class BluetoothConnectRequest
    {
        /// <summary>
        /// 设备MAC地址
        /// </summary>
        [JsonPropertyName("addr")]
        public string Address { get; set; } = string.Empty;

        /// <summary>
        /// 指定配置文件 (可选, 如: a2dp, hfp)
        /// </summary>
        [JsonPropertyName("profile")]
        public string? Profile { get; set; }
    }

    /// <summary>
    /// 蓝牙断开请求
    /// </summary>
    public class BluetoothDisconnectRequest
    {
        /// <summary>
        /// 设备MAC地址 (可选，不提供则断开所有)
        /// </summary>
        [JsonPropertyName("addr")]
        public string? Address { get; set; }
    }

    /// <summary>
    /// 蓝牙配对请求
    /// </summary>
    public class BluetoothPairRequest
    {
        /// <summary>
        /// 设备MAC地址
        /// </summary>
        [JsonPropertyName("addr")]
        public string Address { get; set; } = string.Empty;

        /// <summary>
        /// PIN码 (可选)
        /// </summary>
        [JsonPropertyName("pin")]
        public string? Pin { get; set; }
    }

    /// <summary>
    /// 蓝牙忘记设备请求
    /// </summary>
    public class BluetoothForgetDeviceRequest
    {
        /// <summary>
        /// 设备MAC地址
        /// </summary>
        [JsonPropertyName("addr")]
        public string Address { get; set; } = string.Empty;
    }

    /// <summary>
    /// 蓝牙音量设置请求
    /// </summary>
    public class BluetoothVolumeRequest
    {
        /// <summary>
        /// 音量值 (0-100)
        /// </summary>
        [JsonPropertyName("volume")]
        public int Volume { get; set; }
    }

    /// <summary>
    /// 蓝牙状态信息
    /// </summary>
    public class BluetoothStatusInfo
    {
        /// <summary>
        /// 当前模式 (0=关闭, 1=接收器, 2=发射器)
        /// </summary>
        [JsonPropertyName("mode")]
        public int Mode { get; set; }

        /// <summary>
        /// 模式名称
        /// </summary>
        [JsonPropertyName("modeName")]
        public string ModeName { get; set; } = string.Empty;

        /// <summary>
        /// 是否正在扫描
        /// </summary>
        [JsonPropertyName("scanning")]
        public bool Scanning { get; set; }

        /// <summary>
        /// 是否已连接任何设备
        /// </summary>
        [JsonPropertyName("connected")]
        public bool Connected { get; set; }

        /// <summary>
        /// 已连接设备列表
        /// </summary>
        [JsonPropertyName("connectedDevices")]
        public BluetoothDevice[]? ConnectedDevices { get; set; }

        /// <summary>
        /// 音频播放状态
        /// </summary>
        [JsonPropertyName("audioState")]
        public string? AudioState { get; set; }

        /// <summary>
        /// 当前音量 (0-100)
        /// </summary>
        [JsonPropertyName("volume")]
        public int? Volume { get; set; }
    }

    /// <summary>
    /// 蓝牙扫描结果事件数据
    /// </summary>
    public class BluetoothScanResultData
    {
        /// <summary>
        /// 设备MAC地址
        /// </summary>
        [JsonPropertyName("addr")]
        public string Address { get; set; } = string.Empty;

        /// <summary>
        /// 设备名称
        /// </summary>
        [JsonPropertyName("name")]
        public string Name { get; set; } = string.Empty;

        /// <summary>
        /// 设备类型 (CoD)
        /// </summary>
        [JsonPropertyName("class")]
        public string? Class { get; set; }

        /// <summary>
        /// 信号强度 (dBm)
        /// </summary>
        [JsonPropertyName("rssi")]
        public int Rssi { get; set; }
    }

    /// <summary>
    /// 蓝牙扫描完成事件数据
    /// </summary>
    public class BluetoothScanCompleteData
    {
        /// <summary>
        /// 扫描到的设备数量
        /// </summary>
        [JsonPropertyName("deviceCount")]
        public int DeviceCount { get; set; }
    }

    /// <summary>
    /// 蓝牙连接成功事件数据
    /// </summary>
    public class BluetoothConnectedData
    {
        /// <summary>
        /// 设备MAC地址
        /// </summary>
        [JsonPropertyName("addr")]
        public string Address { get; set; } = string.Empty;

        /// <summary>
        /// 设备名称
        /// </summary>
        [JsonPropertyName("name")]
        public string Name { get; set; } = string.Empty;

        /// <summary>
        /// 已连接的配置文件
        /// </summary>
        [JsonPropertyName("profiles")]
        public string[] Profiles { get; set; } = Array.Empty<string>();
    }

    /// <summary>
    /// 蓝牙断开事件数据
    /// </summary>
    public class BluetoothDisconnectedData
    {
        /// <summary>
        /// 设备MAC地址
        /// </summary>
        [JsonPropertyName("addr")]
        public string Address { get; set; } = string.Empty;

        /// <summary>
        /// 断开原因
        /// </summary>
        [JsonPropertyName("reason")]
        public string? Reason { get; set; }
    }

    /// <summary>
    /// 蓝牙连接失败事件数据
    /// </summary>
    public class BluetoothConnectFailedData
    {
        /// <summary>
        /// 设备MAC地址
        /// </summary>
        [JsonPropertyName("addr")]
        public string Address { get; set; } = string.Empty;

        /// <summary>
        /// 失败原因
        /// </summary>
        [JsonPropertyName("reason")]
        public string Reason { get; set; } = string.Empty;
    }

    /// <summary>
    /// 蓝牙音频状态变化事件数据
    /// </summary>
    public class BluetoothMediaStateChangedData
    {
        /// <summary>
        /// 音频状态 (playing/stopped/paused)
        /// </summary>
        [JsonPropertyName("state")]
        public string State { get; set; } = string.Empty;
    }

    /// <summary>
    /// 蓝牙音量变化事件数据
    /// </summary>
    public class BluetoothVolumeChangedData
    {
        /// <summary>
        /// 音量值 (0-100)
        /// </summary>
        [JsonPropertyName("volume")]
        public int Volume { get; set; }
    }

    /// <summary>
    /// 蓝牙已配对设备列表响应
    /// </summary>
    public class BluetoothPairedDevicesResponse
    {
        /// <summary>
        /// 已配对设备列表
        /// </summary>
        [JsonPropertyName("devices")]
        public BluetoothDevice[] Devices { get; set; } = Array.Empty<BluetoothDevice>();
    }

    /// <summary>
    /// 蓝牙初始化完成事件数据
    /// </summary>
    public class BluetoothInitializedData
    {
        /// <summary>
        /// 固件版本
        /// </summary>
        [JsonPropertyName("version")]
        public string Version { get; set; } = string.Empty;

        /// <summary>
        /// 芯片型号
        /// </summary>
        [JsonPropertyName("chipModel")]
        public string ChipModel { get; set; } = string.Empty;

        /// <summary>
        /// 本机MAC地址
        /// </summary>
        [JsonPropertyName("localAddr")]
        public string? LocalAddr { get; set; }

        /// <summary>
        /// 本机蓝牙名称
        /// </summary>
        [JsonPropertyName("localName")]
        public string? LocalName { get; set; }
    }

    /// <summary>
    /// 蓝牙SNIFF模式状态变化事件数据
    /// </summary>
    public class BluetoothSniffStateChangedData
    {
        /// <summary>
        /// 是否进入SNIFF模式 (省电模式)
        /// </summary>
        [JsonPropertyName("sniffMode")]
        public bool SniffMode { get; set; }
    }

    // ===== WiFi 相关 =====

    /// <summary>
    /// WiFi工作模式
    /// </summary>
    public enum WifiMode
    {
        Disabled = 0,       // 关闭
        STA = 1,            // Station模式 (客户端)
        AP = 2,             // Access Point模式 (热点)
        Monitor = 3,        // 监听模式
        P2P = 4,            // P2P模式
        SmpCfg = 5          // 简单配网模式
    }

    /// <summary>
    /// WiFi加密类型
    /// </summary>
    public enum WifiSecurity
    {
        Open = 0,           // 开放网络
        WEP = 1,            // WEP加密
        WPA = 2,            // WPA加密
        WPA2 = 3,           // WPA2加密
        WPA3 = 4,           // WPA3加密
        WPA_WPA2 = 5        // WPA/WPA2混合
    }

    /// <summary>
    /// WiFi连接状态
    /// </summary>
    public enum WifiConnectionState
    {
        Disconnected = 0,   // 未连接
        Connecting = 1,     // 连接中
        Connected = 2,      // 已连接
        Disconnecting = 3,  // 断开中
        Failed = 4          // 连接失败
    }

    /// <summary>
    /// WiFi扫描到的网络信息
    /// </summary>
    public class WifiNetwork
    {
        /// <summary>
        /// SSID (网络名称)
        /// </summary>
        [JsonPropertyName("ssid")]
        public string Ssid { get; set; } = string.Empty;

        /// <summary>
        /// BSSID (MAC地址)
        /// </summary>
        [JsonPropertyName("bssid")]
        public string? Bssid { get; set; }

        /// <summary>
        /// 信号强度 (dBm)
        /// </summary>
        [JsonPropertyName("rssi")]
        public int Rssi { get; set; }

        /// <summary>
        /// 加密类型 (open, wep, wpa, wpa2, wpa3)
        /// </summary>
        [JsonPropertyName("security")]
        public string Security { get; set; } = string.Empty;

        /// <summary>
        /// 信道号
        /// </summary>
        [JsonPropertyName("channel")]
        public int? Channel { get; set; }

        /// <summary>
        /// 是否已连接
        /// </summary>
        [JsonPropertyName("connected")]
        public bool Connected { get; set; }

        /// <summary>
        /// 是否已保存
        /// </summary>
        [JsonPropertyName("saved")]
        public bool Saved { get; set; }
    }

    /// <summary>
    /// WiFi模式设置请求
    /// </summary>
    public class WifiModeRequest
    {
        /// <summary>
        /// 模式: 0=关闭, 1=STA, 2=AP
        /// </summary>
        [JsonPropertyName("mode")]
        public int Mode { get; set; }

        /// <summary>
        /// SSID (AP模式或STA模式需要)
        /// </summary>
        [JsonPropertyName("ssid")]
        public string? Ssid { get; set; }

        /// <summary>
        /// 密码 (AP模式或STA模式需要)
        /// </summary>
        [JsonPropertyName("pwd")]
        public string? Password { get; set; }

        /// <summary>
        /// 是否强制使用默认模式
        /// </summary>
        [JsonPropertyName("forceDefault")]
        public bool ForceDefault { get; set; }
    }

    /// <summary>
    /// WiFi扫描请求
    /// </summary>
    public class WifiScanRequest
    {
        /// <summary>
        /// 扫描超时时间(秒), 默认10秒
        /// </summary>
        [JsonPropertyName("timeout")]
        public int Timeout { get; set; } = 10;

        /// <summary>
        /// SSID过滤 (可选)
        /// </summary>
        [JsonPropertyName("ssidFilter")]
        public string? SsidFilter { get; set; }
    }

    /// <summary>
    /// WiFi连接请求 (STA模式)
    /// </summary>
    public class WifiConnectRequest
    {
        /// <summary>
        /// SSID
        /// </summary>
        [JsonPropertyName("ssid")]
        public string Ssid { get; set; } = string.Empty;

        /// <summary>
        /// 密码
        /// </summary>
        [JsonPropertyName("pwd")]
        public string? Password { get; set; }

        /// <summary>
        /// 加密类型 (可选)
        /// </summary>
        [JsonPropertyName("security")]
        public string? Security { get; set; }
    }

    /// <summary>
    /// WiFi IP设置请求
    /// </summary>
    public class WifiIpSettingRequest
    {
        /// <summary>
        /// IP地址 (例如: "192.168.1.1")
        /// </summary>
        [JsonPropertyName("ip")]
        public string IpAddress { get; set; } = string.Empty;

        /// <summary>
        /// 子网掩码 (例如: "255.255.255.0")
        /// </summary>
        [JsonPropertyName("netmask")]
        public string Netmask { get; set; } = "255.255.255.0";

        /// <summary>
        /// 网关 (例如: "192.168.1.1")
        /// </summary>
        [JsonPropertyName("gateway")]
        public string Gateway { get; set; } = string.Empty;

        /// <summary>
        /// DHCP服务器IP (AP模式)
        /// </summary>
        [JsonPropertyName("dhcpServer")]
        public string? DhcpServer { get; set; }

        /// <summary>
        /// DHCP客户端起始IP (AP模式)
        /// </summary>
        [JsonPropertyName("dhcpClientStart")]
        public string? DhcpClientStart { get; set; }
    }

    /// <summary>
    /// WiFi低功耗设置请求
    /// </summary>
    public class WifiPowerSaveRequest
    {
        /// <summary>
        /// 是否启用低功耗模式 (仅STA模式有效)
        /// </summary>
        [JsonPropertyName("enable")]
        public bool Enable { get; set; }
    }

    /// <summary>
    /// WiFi状态信息
    /// </summary>
    public class WifiStatusInfo
    {
        /// <summary>
        /// 当前模式 (0=关闭, 1=STA, 2=AP)
        /// </summary>
        [JsonPropertyName("mode")]
        public int Mode { get; set; }

        /// <summary>
        /// 模式名称
        /// </summary>
        [JsonPropertyName("modeName")]
        public string ModeName { get; set; } = string.Empty;

        /// <summary>
        /// 是否正在扫描
        /// </summary>
        [JsonPropertyName("scanning")]
        public bool Scanning { get; set; }

        /// <summary>
        /// 连接状态 (STA模式)
        /// </summary>
        [JsonPropertyName("connected")]
        public bool Connected { get; set; }

        /// <summary>
        /// 当前连接的SSID (STA模式)
        /// </summary>
        [JsonPropertyName("ssid")]
        public string? Ssid { get; set; }

        /// <summary>
        /// IP地址
        /// </summary>
        [JsonPropertyName("ip")]
        public string? IpAddress { get; set; }

        /// <summary>
        /// 子网掩码
        /// </summary>
        [JsonPropertyName("netmask")]
        public string? Netmask { get; set; }

        /// <summary>
        /// 网关
        /// </summary>
        [JsonPropertyName("gateway")]
        public string? Gateway { get; set; }

        /// <summary>
        /// 信道号
        /// </summary>
        [JsonPropertyName("channel")]
        public int? Channel { get; set; }

        /// <summary>
        /// 信号强度 (dBm, STA模式)
        /// </summary>
        [JsonPropertyName("rssi")]
        public int? Rssi { get; set; }

        /// <summary>
        /// 已连接的客户端数量 (AP模式)
        /// </summary>
        [JsonPropertyName("clientCount")]
        public int? ClientCount { get; set; }

        /// <summary>
        /// 是否启用低功耗模式
        /// </summary>
        [JsonPropertyName("powerSave")]
        public bool PowerSave { get; set; }

        /// <summary>
        /// 上传速率 (KB/s)
        /// </summary>
        [JsonPropertyName("uploadRate")]
        public int? UploadRate { get; set; }

        /// <summary>
        /// 下载速率 (KB/s)
        /// </summary>
        [JsonPropertyName("downloadRate")]
        public int? DownloadRate { get; set; }
    }

    /// <summary>
    /// WiFi客户端信息 (AP模式)
    /// </summary>
    public class WifiClient
    {
        /// <summary>
        /// 客户端MAC地址
        /// </summary>
        [JsonPropertyName("mac")]
        public string MacAddress { get; set; } = string.Empty;

        /// <summary>
        /// 分配的IP地址
        /// </summary>
        [JsonPropertyName("ip")]
        public string? IpAddress { get; set; }

        /// <summary>
        /// 连接时间戳
        /// </summary>
        [JsonPropertyName("connectedAt")]
        public long? ConnectedAt { get; set; }
    }

    /// <summary>
    /// WiFi初始化完成事件数据
    /// </summary>
    public class WifiInitializedData
    {
        /// <summary>
        /// 固件版本
        /// </summary>
        [JsonPropertyName("version")]
        public string Version { get; set; } = string.Empty;

        /// <summary>
        /// 芯片型号
        /// </summary>
        [JsonPropertyName("chipModel")]
        public string ChipModel { get; set; } = string.Empty;

        /// <summary>
        /// MAC地址
        /// </summary>
        [JsonPropertyName("macAddr")]
        public string? MacAddress { get; set; }
    }

    /// <summary>
    /// WiFi模式变化事件数据
    /// </summary>
    public class WifiModeChangedData
    {
        /// <summary>
        /// 新模式 (0=关闭, 1=STA, 2=AP)
        /// </summary>
        [JsonPropertyName("mode")]
        public int Mode { get; set; }

        /// <summary>
        /// SSID
        /// </summary>
        [JsonPropertyName("ssid")]
        public string? Ssid { get; set; }
    }

    /// <summary>
    /// WiFi扫描结果事件数据
    /// </summary>
    public class WifiScanResultData
    {
        /// <summary>
        /// SSID
        /// </summary>
        [JsonPropertyName("ssid")]
        public string Ssid { get; set; } = string.Empty;

        /// <summary>
        /// BSSID (MAC地址)
        /// </summary>
        [JsonPropertyName("bssid")]
        public string? Bssid { get; set; }

        /// <summary>
        /// 信号强度 (dBm)
        /// </summary>
        [JsonPropertyName("rssi")]
        public int Rssi { get; set; }

        /// <summary>
        /// 加密类型
        /// </summary>
        [JsonPropertyName("security")]
        public string Security { get; set; } = string.Empty;

        /// <summary>
        /// 信道号
        /// </summary>
        [JsonPropertyName("channel")]
        public int Channel { get; set; }
    }

    /// <summary>
    /// WiFi扫描完成事件数据
    /// </summary>
    public class WifiScanCompleteData
    {
        /// <summary>
        /// 扫描到的网络数量
        /// </summary>
        [JsonPropertyName("count")]
        public int Count { get; set; }
    }

    /// <summary>
    /// WiFi连接成功事件数据
    /// </summary>
    public class WifiConnectedData
    {
        /// <summary>
        /// SSID
        /// </summary>
        [JsonPropertyName("ssid")]
        public string Ssid { get; set; } = string.Empty;

        /// <summary>
        /// IP地址
        /// </summary>
        [JsonPropertyName("ip")]
        public string? IpAddress { get; set; }

        /// <summary>
        /// 信道号
        /// </summary>
        [JsonPropertyName("channel")]
        public int? Channel { get; set; }
    }

    /// <summary>
    /// WiFi断开连接事件数据
    /// </summary>
    public class WifiDisconnectedData
    {
        /// <summary>
        /// SSID
        /// </summary>
        [JsonPropertyName("ssid")]
        public string? Ssid { get; set; }

        /// <summary>
        /// 断开原因
        /// </summary>
        [JsonPropertyName("reason")]
        public string? Reason { get; set; }
    }

    /// <summary>
    /// WiFi连接失败事件数据
    /// </summary>
    public class WifiConnectFailedData
    {
        /// <summary>
        /// SSID
        /// </summary>
        [JsonPropertyName("ssid")]
        public string Ssid { get; set; } = string.Empty;

        /// <summary>
        /// 失败原因
        /// </summary>
        [JsonPropertyName("reason")]
        public string Reason { get; set; } = string.Empty;
    }

    /// <summary>
    /// WiFi DHCP成功事件数据
    /// </summary>
    public class WifiDhcpSuccessData
    {
        /// <summary>
        /// IP地址
        /// </summary>
        [JsonPropertyName("ip")]
        public string IpAddress { get; set; } = string.Empty;

        /// <summary>
        /// 子网掩码
        /// </summary>
        [JsonPropertyName("netmask")]
        public string Netmask { get; set; } = string.Empty;

        /// <summary>
        /// 网关
        /// </summary>
        [JsonPropertyName("gateway")]
        public string Gateway { get; set; } = string.Empty;

        /// <summary>
        /// DNS服务器
        /// </summary>
        [JsonPropertyName("dns")]
        public string[]? Dns { get; set; }
    }

    /// <summary>
    /// WiFi客户端连接事件数据 (AP模式)
    /// </summary>
    public class WifiClientConnectedData
    {
        /// <summary>
        /// 客户端MAC地址
        /// </summary>
        [JsonPropertyName("mac")]
        public string MacAddress { get; set; } = string.Empty;

        /// <summary>
        /// 分配的IP地址
        /// </summary>
        [JsonPropertyName("ip")]
        public string? IpAddress { get; set; }
    }

    /// <summary>
    /// WiFi客户端断开事件数据 (AP模式)
    /// </summary>
    public class WifiClientDisconnectedData
    {
        /// <summary>
        /// 客户端MAC地址
        /// </summary>
        [JsonPropertyName("mac")]
        public string MacAddress { get; set; } = string.Empty;
    }

    /// <summary>
    /// WiFi低功耗状态变化事件数据
    /// </summary>
    public class WifiPowerSaveChangedData
    {
        /// <summary>
        /// 是否启用低功耗模式
        /// </summary>
        [JsonPropertyName("enabled")]
        public bool Enabled { get; set; }
    }

    /// <summary>
    /// WiFi客户端列表响应
    /// </summary>
    public class WifiClientsResponse
    {
        /// <summary>
        /// 客户端列表
        /// </summary>
        [JsonPropertyName("clients")]
        public WifiClient[] Clients { get; set; } = Array.Empty<WifiClient>();
    }

    // ===== Panel 相关 (面板亮度控制) =====

    /// <summary>
    /// 面板亮度设置请求
    /// </summary>
    public class PanelBrightnessRequest
    {
        /// <summary>
        /// 亮度值 (0-100)
        /// </summary>
        [JsonPropertyName("brightness")]
        public int Brightness { get; set; }
    }

    /// <summary>
    /// 面板启用/禁用请求
    /// </summary>
    public class PanelEnabledRequest
    {
        /// <summary>
        /// 是否启用
        /// </summary>
        [JsonPropertyName("enabled")]
        public bool Enabled { get; set; }
    }

    /// <summary>
    /// 面板状态信息
    /// </summary>
    public class PanelStatusInfo
    {
        /// <summary>
        /// 是否启用
        /// </summary>
        [JsonPropertyName("enabled")]
        public bool Enabled { get; set; }

        /// <summary>
        /// 当前亮度 (0-100)
        /// </summary>
        [JsonPropertyName("brightness")]
        public int Brightness { get; set; }

        /// <summary>
        /// PWM占空比 (0.00-100.00)
        /// </summary>
        [JsonPropertyName("pwmDuty")]
        public float PwmDuty { get; set; }

        /// <summary>
        /// PWM频率 (Hz)
        /// </summary>
        [JsonPropertyName("pwmFreq")]
        public int PwmFreq { get; set; }
    }

    /// <summary>
    /// 面板亮度变化事件数据
    /// </summary>
    public class PanelBrightnessChangedData
    {
        /// <summary>
        /// 新亮度值 (0-100)
        /// </summary>
        [JsonPropertyName("brightness")]
        public int Brightness { get; set; }
    }

    /// <summary>
    /// 面板状态变化事件数据
    /// </summary>
    public class PanelStatusChangedData
    {
        /// <summary>
        /// 是否启用
        /// </summary>
        [JsonPropertyName("enabled")]
        public bool Enabled { get; set; }

        /// <summary>
        /// 当前亮度 (0-100)
        /// </summary>
        [JsonPropertyName("brightness")]
        public int Brightness { get; set; }
    }

    // ===== 网络配置相关 =====
    public class NetworkConfig
    {
        [JsonPropertyName("interface")]
        public string Interface { get; set; } = string.Empty; // eth0, wlan0

        [JsonPropertyName("dhcp")]
        public bool Dhcp { get; set; } = true;

        [JsonPropertyName("ip")]
        public string? Ip { get; set; }

        [JsonPropertyName("gateway")]
        public string? Gateway { get; set; }

        [JsonPropertyName("dns")]
        public string[]? Dns { get; set; }

        [JsonPropertyName("subnet")]
        public string? Subnet { get; set; }
    }

    // ===== HID 相关 =====
    public class HidReport
    {
        [JsonPropertyName("type")]
        public string Type { get; set; } = string.Empty; // keyboard, mouse, consumer

        [JsonPropertyName("data")]
        public byte[] Data { get; set; } = Array.Empty<byte>();
    }

    public class HidKeyboard
    {
        [JsonPropertyName("modifiers")]
        public byte Modifiers { get; set; } // Ctrl, Shift, Alt, GUI

        [JsonPropertyName("keys")]
        public byte[] Keys { get; set; } = Array.Empty<byte>();
    }

    public class HidMouse
    {
        [JsonPropertyName("buttons")]
        public byte Buttons { get; set; }

        [JsonPropertyName("x")]
        public sbyte X { get; set; }

        [JsonPropertyName("y")]
        public sbyte Y { get; set; }

        [JsonPropertyName("wheel")]
        public sbyte Wheel { get; set; }
    }

    // ===== 快捷指令相关 =====
    public class Shortcut
    {
        [JsonPropertyName("id")]
        public string Id { get; set; } = string.Empty;

        [JsonPropertyName("name")]
        public string Name { get; set; } = string.Empty;

        [JsonPropertyName("type")]
        public string Type { get; set; } = string.Empty; // key, macro, script

        [JsonPropertyName("content")]
        public string Content { get; set; } = string.Empty;
    }

    // ===== 应用相关 =====
    public class AppStartInfo
    {
        [JsonPropertyName("id")]
        public string Id { get; set; } = string.Empty;

        [JsonPropertyName("name")]
        public string Name { get; set; } = string.Empty;

        [JsonPropertyName("path")]
        public string Path { get; set; } = string.Empty;

        [JsonPropertyName("icon")]
        public string? Icon { get; set; } // Base64 图标
    }

    public class AppLaunchRequest
    {
        [JsonPropertyName("id")]
        public string? Id { get; set; }

        [JsonPropertyName("path")]
        public string? Path { get; set; }

        [JsonPropertyName("args")]
        public string? Args { get; set; }
    }

    #endregion

    #region Update 模块 (Module = 9)

    /// <summary>
    /// 更新请求 - 检查更新 (Action = 1)
    /// </summary>
    public class UpdateCheckRequest
    {
        [JsonPropertyName("url")]
        public string? Url { get; set; } // 固件下载地址
    }

    /// <summary>
    /// 更新请求 - 开始更新 (Action = 2)
    /// </summary>
    public class UpdateStartRequest
    {
        [JsonPropertyName("url")]
        public string? Url { get; set; } // 固件下载地址
    }

    /// <summary>
    /// 更新进度数据 (Action = 3 响应)
    /// </summary>
    public class UpdateProgressData
    {
        [JsonPropertyName("status")]
        public string? Status { get; set; } // downloading/writing/verifying/success/error

        [JsonPropertyName("percent")]
        public int Percent { get; set; } // 进度百分比 0-100

        [JsonPropertyName("downloaded")]
        public long Downloaded { get; set; } // 已下载字节数 (KB)

        [JsonPropertyName("total")]
        public long Total { get; set; } // 总字节数 (KB)

        [JsonPropertyName("error")]
        public string? Error { get; set; } // 错误信息
    }

    #endregion
}
