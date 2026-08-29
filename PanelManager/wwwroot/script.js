// ========== WebSocket连接 ==========
const WS_URL = 'ws://localhost:5000';
let ws = null;
let wsConnected = false;
let wsReconnectTimer = null;
let wsReconnectAttempts = 0;
const WS_MAX_RECONNECT_DELAY = 10000; // 最大重连延迟 10 秒
let bootNoticeShown = false;

// Host runtime flags (from system:status)
let hostDebugMode = false;
// 消息ID计数器，用于生成唯一ID
let messageIdCounter = 0;
function generateMessageId() {
    return `web_${Date.now()}_${(messageIdCounter++).toString(16)}`;
}
// 消息响应回调映射
const messageCallbacks = new Map();
function initWebSocket() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
        console.log('[WebSocket] 已存在连接，跳过初始化');
        return;
    }
    try {
        console.log('[WebSocket] 正在连接到', WS_URL);
        ws = new WebSocket(WS_URL);
        ws.onopen = () => {
            console.log('[WebSocket] ✓ 已连接到后端');
            wsConnected = true;
            wsReconnectAttempts = 0;
            //showToast('后端已连接');
            if (wsReconnectTimer) {
                clearTimeout(wsReconnectTimer);
                wsReconnectTimer = null;
            }

            // 初始化主页Widget
            initHomeWidgets();
            // 初始化Dock
            initDock();
            // 启动串口自动连接（发送指令让后端开始）
            startSerialAutoConnect();
            // 订阅性能监控（WebSocket 连接成功后）
            subscribePerformanceMonitoring();
            // 初始化WiFi状态
            initWifiStatus();
            // 初始化麦克风状态
            initMicrophoneStatus();
            // 初始化面板状态
            initPanelStatus();
            // 初始化媒体信息
            updateMediaInfo();
            // 连接后主动刷新天气
            refreshWeather(false);
            setTimeout(refreshCurrentFirmwareVersion, 300);
        };
        ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                handleWebSocketMessage(message);
            } catch (e) {
                console.error('[WebSocket] 消息解析错误:', e, event.data);
            }
        };
        ws.onerror = (error) => {
            console.error('[WebSocket] 连接错误:', error);
            wsConnected = false;
        };
        ws.onclose = () => {
            console.log('[WebSocket] 连接已关闭');
            wsConnected = false;
            resetWifiConnectionAfterTransportLoss();
            const pending = Array.from(messageCallbacks.entries());
            messageCallbacks.clear();
            pending.forEach(([id, callback]) => {
                try { callback({ code: 100, msg: 'WebSocket 已断开', reqId: id }); } catch { }
            });

            // 使用指数退避策略重连
            wsReconnectAttempts++;
            const delay = Math.min(1000 * Math.pow(2, wsReconnectAttempts - 1), WS_MAX_RECONNECT_DELAY);
            console.log(`[WebSocket] ${delay}ms 后尝试第 ${wsReconnectAttempts} 次重连`);
            wsReconnectTimer = setTimeout(initWebSocket, delay);
        };
    } catch (e) {
        console.error('[WebSocket] 初始化失败:', e);
        wsConnected = false;
    }
}

// 发送消息（使用协议格式）
function sendMessage(module, cmd, data, callback) {
    return sendMessageWithTimeout(module, cmd, data, 30000, callback);
}

// 发送消息（支持自定义超时，适用于 AI 对话 / OAuth 等长任务）
function sendMessageWithTimeout(module, cmd, data, timeoutMs, callback) {
    const moduleMap = {
        'system': 0,
        'serial': 1,
        'bluetooth': 2,
        'wifi': 3,
        'network': 4,
        'hid': 5,
        'shortcut': 6,
        'app': 7,
        'panel': 8,
        'update': 9,
        'rk628Debug': 10,
        'audio': 11
    };
    // 根据模块类型自动判断目标
    // system, serial, app -> Host (上位机处理)
    // bluetooth, wifi, network, hid, shortcut, panel, update, rk628Debug, audio -> Device (下位机处理)
    const hostModules = ['system', 'serial', 'app'];
    const target = hostModules.includes(module) ? 0 : 1; // 0=Host, 1=Device
    const hostCapability = target === 0 ? window.__panelManagerHostCapability : undefined;
    if (target === 0 && typeof hostCapability !== 'string') {
        if (callback) callback({ code: 2, msg: 'Host capability unavailable' });
        return false;
    }
    const message = {
        v: 1,
        id: generateMessageId(),
        target: target,
        type: 0,   // Request
        mod: moduleMap[module] || 0,
        cmd: cmd,
        data: data,
        cap: hostCapability,
        ts: Date.now()
    };
    if (callback) {
        messageCallbacks.set(message.id, callback);
        // 超时
        setTimeout(() => {
            if (messageCallbacks.has(message.id)) {
                messageCallbacks.delete(message.id);
                callback({ code: 5, msg: 'Timeout', localTimeout: true, reqId: message.id }); // ErrorCode.Timeout
            }
        }, Math.max(1000, Number(timeoutMs) || 30000));
    }
    if (wsConnected && ws && ws.readyState === WebSocket.OPEN) {
        const json = JSON.stringify(message);
        ws.send(json);
        console.log('[WebSocket] 发送:', { ...message, cap: message.cap ? '<redacted>' : undefined });
        return true;
    } else {
        console.warn('[WebSocket] 未连接，消息发送失败:', { ...message, cap: message.cap ? '<redacted>' : undefined });
        if (callback) {
            messageCallbacks.delete(message.id);
            callback({ code: 1, msg: 'WebSocket not connected' });
        }
        return false;
    }
}
// 处理从后端接收的消息
function handleWebSocketMessage(message) {
    console.log('[WebSocket] 接收:', message);
    // 处理响应消息
    if (message.type === 1 && message.id && messageCallbacks.has(message.id)) {
        const callback = messageCallbacks.get(message.id);
        messageCallbacks.delete(message.id);
        callback(message);
        return;
    }
    // 处理事件消息
    if (message.type === 2) {
        handleEvent(message);
        return;
    }
    console.warn('[WebSocket] 未处理的消息:', message);
}

function formatDeviceCommandError(response, fallback = '未知错误') {
    if (!response) {
        return fallback;
    }
    if (response.localTimeout || response.code === 5) {
        return response.msg || '设备响应超时';
    }
    if (response.code === 100) {
        return '串口未连接或设备未认证';
    }
    if (response.code === 102) {
        return '串口写入失败';
    }
    if (response.code === 8) {
        return response.msg || '设备拒绝：未认证或权限不足';
    }
    return response.msg || fallback;
}

function isDeviceTransportError(response) {
    if (!response) {
        return true;
    }
    return response.localTimeout ||
        response.code === 5 ||
        response.code === 100 ||
        response.code === 102 ||
        response.code === 8;
}

function isWifiOwnerFault(response) {
    return !!response && (response.code === 6 ||
        /radio reset required|owner unresponsive/i.test(String(response.msg || '')));
}

function showWifiOwnerFault(response) {
    const input = document.getElementById('wifiSwitchInput');
    const container = document.getElementById('wifiNetworksContainer');
    if (input) input.checked = false;
    if (container) container.style.display = 'none';
    stopWifiAutoScan();
    wifiStatus.mode = 0;
    wifiStatus.on = false;
    wifiStatus.connected = false;
    wifiStatus.connecting = false;
    wifiStatus.scanning = false;
    updateWifiStatusBar();
    showToast(`WiFi 开启失败: ${formatDeviceCommandError(response, 'WiFi 控制器需要恢复')}`);
}

// 处理事件消息
function handleEvent(message) {
    const moduleNames = ['system', 'serial', 'bluetooth', 'wifi', 'network', 'hid', 'shortcut', 'app', 'panel', 'update', 'rk628Debug', 'audio'];
    const moduleName = moduleNames[message.mod] || 'unknown';
    console.log(`[Event] ${moduleName}:${message.cmd}`, message.data);
    // 根据事件类型处理
    switch (`${moduleName}:${message.cmd}`) {
        case 'panel:rk628Status': {
            const d = message.data || {};
            const w = d.hdisplay || 0;
            const h = d.vdisplay || 0;
            const clk = d.clock || 0;
            const restarting = d.restarting ? 1 : 0;
            const plugin = d.plugin ? 1 : 0;
            const lock = d.lock ? 1 : 0;

            rk628QuickSetInputText(w && h ? `${w}x${h}  ${clk}kHz` : '-');

            if (restarting) {
                rk628QuickSetStatus('重启中...', '');
            } else if (!plugin) {
                rk628QuickSetStatus('未插入', '');
            } else if (lock) {
                rk628QuickSetStatus('已锁定', 'valid');
            } else {
                rk628QuickSetStatus('已插入/未锁定', '');
            }
            break;
        }
        case 'audio:micSourceChanged':
            audioRouteApplyMicData(message.data);
            audioRouteRenderSettings();
            break;
        case 'audio:eqChanged':
            audioEqReload(true);
            break;
        case 'system:status':
            console.log('[System] 状态:', message.data);
            hostDebugMode = !!message.data?.debug;
            if (!bootNoticeShown && typeof message.data?.bootNotice === 'string' && message.data.bootNotice) {
                bootNoticeShown = true;
                showToast(message.data.bootNotice, 3000);
            }
            // 检查串口状态
            if (message.data?.serial?.open) {
                const wasConnected = serialConnected;
                serialConnected = true;
                updateSerialStatusBar(true, message.data.serial.port,
                    message.data.serial.usbId);
                startSerialPolling();

                // 串口在线时刷新设备侧状态
                if (!wasConnected) {
                    initWifiStatus();
                    initBluetoothStatus();
                    audioRouteSyncFromDevice();
                    refreshCurrentFirmwareVersion();
                }

                // If settings-bluetooth is currently active, keep BT discoverable.
                if (isBluetoothSettingsActive()) {
                    sendMessage('bluetooth', 'setVisibility', { enable: 1 }, () => { });
                }
            } else {
                updateSerialStatusBar(false);
            }
            break;

        case 'system:aiSidecarProgress':
            if (message.data) {
                aiHandleProgressEvent(message.data);
            }
            break;

        case 'system:aiStatus':
            if (message.data) {
                aiHandleStatusEvent(message.data);
            }
            break;

        case 'system:aiEvent':
            if (message.data) {
                aiHandleServerEvent(message.data);
            }
            break;
        case 'system:performanceStats':
            // 接收性能监控推送（包含网络数据）
            if (message.data) {
                updatePerformanceDisplay(message.data);
            }
            break;
        case 'serial:connected':
            showToast(`串口已连接: ${message.data?.port}`);
            serialConnected = true;
            bluetoothStatusRetryCount = 0;
            updateSerialStatusBar(true, message.data?.port,
                message.data?.usbId ?? message.data?.auth?.usbId);
            promptSwitchToDeviceScreen(message.data?.port);

            // 串口连接成功后，主动刷新 WiFi/蓝牙状态，避免上位机重启后 UI 显示默认关闭
            initWifiStatus();
            initBluetoothStatus();
            audioRouteSyncFromDevice();
            refreshCurrentFirmwareVersion();
            refreshOnlineUpdateViewAfterReconnect();

            if (isBluetoothSettingsActive()) {
                sendMessage('bluetooth', 'setVisibility', { enable: 1 }, () => { });
            }
            break;
        case 'serial:disconnected':
            //showToast('串口已断开');
            serialConnected = false;
            resetWifiConnectionAfterTransportLoss();
            audioRouteApplyState.routeQueued = false;
            audioRouteApplyState.micQueued = false;
            audioRouteSetStatus('下位机已断开', 'error');
            const pending = Array.from(messageCallbacks.entries());
            messageCallbacks.clear();
            pending.forEach(([id, callback]) => {
                try { callback({ code: 100, msg: '串口已断开', reqId: id }); } catch { }
            });
            bluetoothStatusRetryCount = 0;
            if (bluetoothStatusRetryTimer) {
                clearTimeout(bluetoothStatusRetryTimer);
                bluetoothStatusRetryTimer = null;
            }
            updateSerialStatusBar(false);
            resetDeviceScreenSwitchPrompt();
            restoreFromDeviceScreenAfterSerialDisconnect();
            //handleSerialDisconnect(); // 前端不再处理断开重连逻辑
            break;
        case 'serial:opened':
            // 串口已打开但设备尚未认证，等待下位机主动 challenge 后再进入 connected。
            if (!serialConnected) {
                updateSerialStatusBar(false);
            }
            break;
        case 'serial:closed':
            // 兼容旧事件
            if (serialConnected) {
                showToast('串口已关闭');
                updateSerialStatusBar(false);
                serialConnected = false;
                resetWifiConnectionAfterTransportLoss();
                audioRouteApplyState.routeQueued = false;
                audioRouteApplyState.micQueued = false;
                audioRouteSetStatus('下位机已关闭', 'error');
                const closedPending = Array.from(messageCallbacks.entries());
                messageCallbacks.clear();
                closedPending.forEach(([id, callback]) => {
                    try { callback({ code: 100, msg: '串口已关闭', reqId: id }); } catch { }
                });
                restoreFromDeviceScreenAfterSerialDisconnect();
            }

            // 如果正在联网升级，串口断开通常意味着设备正在重启/进入安装阶段
            if (secureUpdateInProgress) {
                const updateStatusEl = document.getElementById('updateStatus');
                const detailsEl = document.getElementById('updateProgressDetails');
                if (updateStatusEl) {
                    updateStatusEl.textContent = '正在安装更新，设备将短暂离线...';
                    updateStatusEl.style.color = 'var(--text-secondary)';
                }
                if (detailsEl) {
                    detailsEl.textContent = '请等待设备完成写入/擦除并重启，然后重新连接';
                }
                showToast('设备正在安装更新，请稍候重连', 4000);
            }
            break;
        case 'serial:data':
            console.log('[Serial] 数据:', message.data);
            break;
        case 'hid:ledState':
            updateKeyboardLeds(message.data || {});
            break;
        case 'hid:touchCalibSample':
            if (typeof touchCal2OnSample === 'function') {
                touchCal2OnSample(message.data || {});
            }
            break;
        case 'hid:touchCalibRequired':
            if (typeof touchCal2OnRequired === 'function') {
                touchCal2OnRequired(message.data || {});
            }
            break;
        case 'update:log':
            if (typeof activeUpdateTerminal !== 'undefined' && activeUpdateTerminal) {
                appendTerminalLog(message.data?.text);
            }
            break;
        case 'update:event':
            // handleUpdateStatusEvent may not be defined in all contexts
            if (typeof handleUpdateStatusEvent === 'function') {
                handleUpdateStatusEvent(message.data);
            }
            // 同时处理手动更新事件
            handleManualUpdateEvent('event', message.data);
            break;
        case 'update:isdUpdateProgress':
            handleManualUpdateProgress(message.data || {});
            break;
        // 蓝牙事件处理
        case 'bluetooth:initialized':
            console.log('[Bluetooth] 已初始化:', message.data);
            showToast('蓝牙已初始化');
            // 初始化完成后获取蓝牙状态
            initBluetoothStatus();
            break;
        case 'bluetooth:scanResult':
            // 扫描到设备
            if (message.data) {
                console.log('[Bluetooth] 扫描到设备:', message.data);
                const device = {
                    addr: message.data.addr,
                    name: message.data.name,
                    class: message.data.class,
                    transport: message.data.transport || 'edr',
                    rssi: message.data.rssi,
                    paired: message.data.paired === true,
                    lastSeenMs: Date.now(),
                    scanSeq: bluetoothScanSeq
                };
                resolveBtName(device.addr, device.name);
                // 检查是否已存在
                const existsIndex = bluetoothDevices.findIndex(d => d.addr === device.addr && (d.transport || 'edr') === device.transport);
                if (existsIndex < 0) {
                    bluetoothDevices.push(device);
                } else {
                    // Update latest fields (RSSI/name can change)
                    bluetoothDevices[existsIndex] = { ...bluetoothDevices[existsIndex], ...device };
                }
                updateBluetoothStatusBar();
                scheduleRenderBluetoothList();
            }
            break;
        case 'bluetooth:scanComplete':
            // 扫描完成
            console.log('[Bluetooth] 扫描完成:', message.data);
            isScanning = false;
            bluetoothStatus.scanning = false;
            const deviceCount = message.data?.deviceCount || bluetoothDevices.length;
            console.log(`[Bluetooth] 扫描完成，发现 ${deviceCount} 个设备`);
            // Prune very old scan results to avoid unbounded growth
            {
                const now = Date.now();
                const maxAge = BLUETOOTH_SCAN_DEVICE_TTL_MS * 2;
                bluetoothDevices = (bluetoothDevices || []).filter(d => !d?.lastSeenMs || (now - d.lastSeenMs) <= maxAge);
            }
            scheduleRenderBluetoothList();
            if (pendingBtConnect?.waitingForScanStop) {
                const { addr, name } = pendingBtConnect;
                pendingBtConnect.waitingForScanStop = false;
                setTimeout(() => performBluetoothConnect(addr, name), 250);
            }
            break;
        case 'bluetooth:connected':
            // 设备已连接
            if (message.data) {
                console.log('[Bluetooth] 设备已连接:', message.data);
                bluetoothConnected = true; // 更新蓝牙连接状态
                bluetoothStatus.connected = true;
                bluetoothStatus.connectedDevice = {
                    addr: message.data.addr,
                    name: resolveFirstBtName(message.data.addr, message.data.name, pendingBtConnect?.name),
                    profiles: message.data.profiles
                };
                connectedDevice = bluetoothStatus.connectedDevice;
                updateBluetoothStatusBar();
                updateCurrentBluetoothDevice();
                // 更新设备列表
                scheduleRenderBluetoothList();
                showToast(`已连接到 ${resolveConnectedBtName(bluetoothStatus.connectedDevice) || '蓝牙设备'}`);
                pendingBtConnect = null;
            }
            break;
        case 'bluetooth:paired':
            if (message.data?.addr) {
                const addr = message.data.addr;
                const name = resolveFirstBtName(addr, message.data.name, pendingBtConnect?.name);
                showToast(`配对成功：${name || addr}`);

                // 刷新已配对设备列表
                sendMessage('bluetooth', 'getPairedDevices', null, (pairResponse) => {
                    if (pairResponse.code === 0 && pairResponse.data?.devices) {
                        pairedDevices = pairResponse.data.devices;
                        pairedDevices.forEach(d => resolveBtName(d.addr, d.name));
                        updateBluetoothStatusBar();
                        scheduleRenderBluetoothList();
                    }
                });

                // 配对发生在当前 ACL 连接上；等待 profile connected 事件，不重复建链。
            }
            break;
        case 'bluetooth:pairingCode':
            {
                const pairingCode = normalizeBluetoothPairingCode(message.data?.pairingCode);
                if (!pairingCode || pairingCode === '000000') break;
                const device = pendingBtConnect || {};
                const modalBody = window.UIComponents?.buildBluetoothPairingModal
                    ? window.UIComponents.buildBluetoothPairingModal({
                        deviceIcon: getBluetoothDeviceIcon(device.class),
                        name: device.name || '蓝牙设备',
                        pairingCode
                    })
                    : pairingCode;
                showModal('蓝牙配对', modalBody);
                const confirmBtn = document.getElementById('modalConfirm');
                const cancelBtn = document.getElementById('modalCancel');
                if (confirmBtn) confirmBtn.textContent = '知道了';
                if (cancelBtn) cancelBtn.style.display = 'none';
            }
            break;
        case 'bluetooth:disconnected':
            // 设备已断开
            if (message.data) {
                console.log('[Bluetooth] 设备已断开:', message.data);
                bluetoothConnected = false;
                bluetoothStatus.connected = false;
                bluetoothStatus.connectedDevice = null;
                connectedDevice = null;
                pendingBtConnect = null;
                audioRouteApplyState.routeQueued = false;
                audioRouteRenderSettings();
                updateBluetoothStatusBar();
                updateCurrentBluetoothDevice();
                scheduleRenderBluetoothList();
            }
            break;

        // SMTC媒体事件
        case 'system:mediaSessionsChanged':
            if (message.data && message.data.sessions) {
                console.log('[SMTC] 会话列表变化:', message.data.sessions);
                mediaSessions = message.data.sessions;

                // 更新切换按钮显示
                const switchBtn = document.getElementById('mediaSwitchBtn');
                if (mediaSessions.length > 1) {
                    switchBtn.style.display = 'inline-flex';
                } else {
                    switchBtn.style.display = 'none';
                }
            }
            break;

        case 'system:mediaInfoChanged':
            if (message.data && message.data.sessionId === currentMediaSessionId && message.data.data) {
                console.log('[SMTC] 媒体信息变化:', message.data.data);
                const { title, artist, isPlaying, thumbnail } = message.data.data;

                // 更新文字信息（带动画）
                updateMusicTextWithAnimation(title, artist);

                updateMusicPlayButton(isPlaying);

                // 更新专辑封面（带动画）
                updateAlbumCoverWithAnimation(thumbnail);
            }
            break;
        case 'bluetooth:connectFailed':
            // 连接失败
            if (message.data) {
                console.log('[Bluetooth] 连接失败:', message.data);
                showToast(`连接失败: ${message.data.reason || '未知原因'}`);
                if (pendingBtConnect && pendingBtConnect.addr === message.data.addr) {
                    pendingBtConnect = null;
                }
            }
            break;
        case 'bluetooth:mediaStateChanged':
            // 媒体状态变化
            if (message.data) {
                console.log('[Bluetooth] 媒体状态:', message.data.state);
                // 更新音乐播放器UI
                updateMusicPlayButton(message.data.state === 'playing');
            }
            break;
        case 'bluetooth:volumeChanged':
            // 音量变化
            if (message.data && message.data.volume !== undefined) {
                console.log('[Bluetooth] 音量:', message.data.volume);
                // 更新音量滑块
                const volumeSlider = document.getElementById('volumeSlider');
                const volumeValue = document.getElementById('volumeValue');
                if (volumeSlider && volumeValue) {
                    volumeSlider.value = message.data.volume;
                    volumeValue.textContent = message.data.volume + '%';
                }
            }
            break;
        case 'bluetooth:sniffStateChanged':
            // SNIFF省电模式状态变化
            console.log('[Bluetooth] SNIFF模式:', message.data?.sniffMode ? '已进入' : '已退出');
            break;
        // WiFi 事件处理
        case 'wifi:initialized':
            console.log('[WiFi] 已初始化:', message.data);
            showToast('WiFi 模块已初始化');
            // 初始化完成后获取 WiFi 状态
            sendMessage('wifi', 'getStatus', {}, (response) => {
                if (response.code === 0 && response.data) {
                    applyWifiStatusSnapshot(response.data);
                    updateWifiStatusBar();
                    renderWifiList();
                }
            });
            break;
        case 'wifi:modeChanged':
            // WiFi 模式变化
            if (message.data) {
                console.log('[WiFi] 模式变化:', message.data);
                wifiStatus.mode = message.data.mode;
                wifiStatus.on = message.data.mode !== 0;
                const modeNames = ['关闭', 'STA', 'AP', '监听', 'P2P', '简单配网'];
                showToast(`WiFi 模式: ${modeNames[message.data.mode] || '未知'}`);
            }
            break;
        case 'wifi:scanResult':
            // 扫描到网络
            if (message.data) {
                console.log('[WiFi] 扫描到网络:', message.data);
                const network = createWifiNetworkFromScan(message.data);
                if (network) {
                    wifiActiveScanNetworks?.add(network.ssid);
                    upsertWifiNetwork(network);
                    renderWifiList();
                }
            }
            break;
        case 'wifi:scanComplete':
            // 扫描完成
            console.log('[WiFi] 扫描完成:', message.data);
            wifiStatus.scanning = false;
            if (wifiActiveScanNetworks) {
                wifiActiveScanNetworks = null;
            }
            ensureConnectedWifiVisible();
            pruneStaleWifiNetworks();
            const networkCount = message.data?.count || wifiNetworks.length;
            // 静默扫描时不显示toast
            // 即使没有结果也要渲染空态，避免只剩下空的圆角容器。
            renderWifiList();
            startPendingWifiConnection();
            if (!wifiConnectOperation) startWifiAutoScan();
            break;
        case 'wifi:connected':
            // WiFi 连接成功
            if (message.data) {
                if (wifiConnectOperation && wifiConnectOperation.ssid !== message.data.ssid) {
                    console.warn('[WiFi] 忽略与当前连接事务不匹配的成功事件:', message.data);
                    initWifiStatus();
                    break;
                }
                console.log('[WiFi] 连接成功:', message.data);
                wifiStatus.on = true;
                wifiStatus.connected = true;
                wifiStatus.connecting = false;
                wifiStatus.ssid = message.data.ssid;
                wifiStatus.ip = message.data.ip;
                wifiStatus.rssi = normalizeWifiRssi(message.data.rssi)
                    ?? normalizeWifiRssi(wifiNetworks.find(network => network.ssid === message.data.ssid)?.rssi);
                wifiConnectionFailure = null;
                ensureConnectedWifiVisible();
                finishWifiConnection(message.data.ssid);
                stopWifiStatusRefresh();
                startWifiAutoScan(0);
                updateWifiStatusBar();
                // 更新网络列表
                renderWifiList();
                setTimeout(() => {
                    if (!isWifiSettingsActive() || !wifiStatus.connected || wifiStatus.ssid !== message.data.ssid) return;
                    sendMessage('wifi', 'getStatus', {}, (response) => {
                        if (response.code !== 0 || !response.data) return;
                        applyWifiStatusSnapshot(response.data);
                        updateWifiStatusBar();
                        renderWifiList();
                    });
                }, 500);
                showToast(`已连接到 ${message.data.ssid}`);
            }
            break;
        case 'wifi:disconnected':
            // WiFi 断开连接
            if (message.data) {
                console.log('[WiFi] 断开连接:', message.data);
                const disconnectedSsid = message.data.ssid || wifiStatus.ssid;
                wifiStatus.connected = false;
                if (!wifiConnectOperation) {
                    wifiStatus.connecting = false;
                }
                wifiStatus.ssid = null;
                wifiStatus.ip = null;
                wifiStatus.rssi = null;
                markWifiNetworkUnavailable(disconnectedSsid);
                updateWifiStatusBar();
                renderWifiList();
                showToast(`已断开 ${disconnectedSsid || ''} ${message.data.reason ? '(' + message.data.reason + ')' : ''}`);
                setTimeout(initWifiStatus, 500);
            }
            break;
        case 'wifi:connectFailed':
            // WiFi 连接失败
            if (message.data) {
                if (wifiConnectOperation && message.data.ssid &&
                    wifiConnectOperation.ssid !== message.data.ssid) {
                    console.warn('[WiFi] 忽略与当前连接事务不匹配的失败事件:', message.data);
                    break;
                }
                console.log('[WiFi] 连接失败:', message.data);
                wifiConnectionFailure = {
                    ssid: message.data.ssid || wifiConnectOperation?.ssid || '',
                    reason: formatWifiConnectionFailure(message.data.reason)
                };
                failWifiConnection(message.data.ssid);
                showToast(`连接 ${message.data.ssid} 失败: ${message.data.reason || '未知原因'}`);
            }
            break;
        case 'wifi:dhcpSuccess':
            // DHCP 成功
            if (message.data) {
                console.log('[WiFi] DHCP 成功:', message.data);
                wifiStatus.ip = message.data.ip;
                showToast(`获取 IP 地址: ${message.data.ip}`);
            }
            break;
        case 'wifi:clientConnected':
            // 客户端连接 (AP 模式)
            console.log('[WiFi] 客户端连接:', message.data);
            showToast(`客户端 ${message.data?.mac} 已连接`);
            break;
        case 'wifi:clientDisconnected':
            // 客户端断开 (AP 模式)
            console.log('[WiFi] 客户端断开:', message.data);
            showToast(`客户端 ${message.data?.mac} 已断开`);
            break;
        case 'wifi:powerSaveChanged':
            // 省电模式变化
            console.log('[WiFi] 省电模式:', message.data?.enabled ? '已启用' : '已禁用');
            break;
        // 面板事件处理
        case 'panel:brightnessChanged':
            // 亮度变化事件
            if (message.data && message.data.brightness !== undefined) {
                const brightness = message.data.brightness;
                console.log('[Panel] 亮度已变化:', brightness + '%');
                // 更新slider和显示值
                document.getElementById('brightnessSlider').value = brightness;
                document.getElementById('brightnessValue').textContent = brightness + '%';
            }
            break;
        case 'panel:statusChanged':
            // 面板状态变化事件
            if (message.data) {
                console.log('[Panel] 状态已变化:', message.data);
                if (message.data.enabled !== undefined) {
                    console.log('[Panel] 面板已' + (message.data.enabled ? '启用' : '禁用'));
                }
                if (message.data.brightness !== undefined) {
                    const brightness = message.data.brightness;
                    document.getElementById('brightnessSlider').value = brightness;
                    document.getElementById('brightnessValue').textContent = brightness + '%';
                }
            }
            break;
        // 固件更新事件处理
        case 'update:updateEvent':
            if (message.data) {
                handleUpdateEvent(message.data);
            }
            break;
        case 'update:secureStatus':
            // 安全更新实时状态（由下位机推送）
            if (message.data) {
                updateUpdateProgress(message.data);

                if (message.data.status === 'success' || message.data.status === 'error') {
                    secureUpdateInProgress = false;
                }

                // 错误提示：仅在“更新面板已展开/更新进行中”时弹出，避免和检查更新的响应提示重复
                if (message.data.status === 'error') {
                    const panel = document.getElementById('updateProgress');
                    const panelVisible = panel && !panel.hidden && panel.style.display !== 'none';
                    if (panelVisible) {
                        const errText = message.data.error || message.data.detail || '联网更新失败';
                        showToast(errText, 3000);
                    }
                }
            }
            break;
        case 'panel:operationComplete':
        case 'hid:operationComplete':
        case 'rk628Debug:operationComplete':
            settleDeviceOperation(message.data);
            break;
        case 'update:checkComplete':
            if (message.data) {
                const operationId = message.data.operationId || message.data.requestId;
                if (secureUpdateCheckOperationId &&
                    operationId === secureUpdateCheckOperationId) {
                    secureUpdateCheckOperationId = null;
                    finishSecureUpdateCheck(
                        message.data.code,
                        message.data.msg,
                        message.data
                    );
                }
            }
            break;
        case 'system:floatingShow':
            showToast('已进入悬浮模式');
            break;
        case 'system:floatingRestored':
            showToast('已恢复主界面');
            break;
        case 'system:floatingError':
            showToast(message.data?.msg || '悬浮图标操作失败');
            break;
        default:
            console.log('[Event] 未处理事件:', message);
    }
}
// 安全类型编号转名称
function getSecurityName(securityCode) {
    const securityNames = ['open', 'wep', 'wpa', 'wpa2', 'wpa3', 'wpa_wpa2'];
    return securityNames[securityCode] || 'unknown';
}

// ========== 串口自动连接 ==========
let serialConnected = false;
let currentSerialPort = null; // 当前连接的串口名称
let currentUsbId = null; // 下位机 challenge 报告的实际 CDC 控制器
let serialAutoConnectTimer = null;
let serialPollingTimer = null;
let deviceScreenSwitchPromptPort = null;
let deviceScreenSwitchInProgress = false;
let touchCalibrationGuidePromptPort = null;
const SERIAL_POLL_INTERVAL = 60000; // 60秒轮询一次串口列表
// ========== 蓝牙连接状态 ==========
let bluetoothConnected = false;
// ========== 音量静音状态 ==========
let isMuted = false;
let volumeBeforeMute = 50; // 静音前的音量
// 网速统计
let lastNetworkStats = { upload: 0, download: 0, timestamp: Date.now() };
// 格式化网速显示（字节/秒 -> 人类可读格式）
function formatSpeed(bytesPerSec) {
    if (bytesPerSec < 1024) {
        return `${bytesPerSec.toFixed(0)} B/s`;
    } else if (bytesPerSec < 1024 * 1024) {
        return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
    } else {
        return `${(bytesPerSec / (1024 * 1024)).toFixed(2)} MB/s`;
    }
}
// 更新状态栏串口状态
function normalizeUsbId(value) {
    const usbId = Number(value);
    return Number.isInteger(usbId) && (usbId === 0 || usbId === 1)
        ? usbId
        : null;
}

function usbVersionLabel(usbId) {
    return usbId === 0 ? 'USB1.1' : usbId === 1 ? 'USB2.0' : '';
}

function updateSerialStatusBar(connected, port = null, usbId = null) {
    const statusIcon = document.getElementById('serialStatusIcon');
    const statusText = document.getElementById('serialStatus');
    const usbIndicator = document.getElementById('usbPortIndicator');
    if (connected && port) {
        statusIcon.textContent = '✅';
        statusText.textContent = port;
        currentSerialPort = port;
        currentUsbId = normalizeUsbId(usbId);
        if (usbIndicator) {
            usbIndicator.textContent = usbVersionLabel(currentUsbId);
            usbIndicator.hidden = currentUsbId === null;
            usbIndicator.title = currentUsbId === 0
                ? '当前 CDC 来自硬件 USB0'
                : currentUsbId === 1
                    ? '当前 CDC 来自硬件 USB1'
                    : '';
        }
    } else {
        statusIcon.textContent = '🔌';
        statusText.textContent = '串口未连接';
        currentSerialPort = null;
        currentUsbId = null;
        if (usbIndicator) {
            usbIndicator.textContent = '';
            usbIndicator.hidden = true;
            usbIndicator.title = '';
        }
    }
}
// 更新状态栏网速
function updateNetworkSpeedBar(uploadSpeed, downloadSpeed) {
    const uploadElem = document.getElementById('uploadSpeed');
    const downloadElem = document.getElementById('downloadSpeed');
    uploadElem.textContent = formatSpeed(uploadSpeed);
    downloadElem.textContent = formatSpeed(downloadSpeed);
}
// 串口自动连接
// 串口自动连接 (触发后端服务)
function startSerialAutoConnect() {
    console.log('[Serial] 启动后端自动连接服务...');
    sendMessage('serial', 'autoConnect', {}, (response) => {
        if (response && response.code === 0) {
            console.log('[Serial] 服务启动成功:', response.data);
            if (response.data.status === 'connected' || response.data.status === 'already_connected') {
                serialConnected = true;
                updateSerialStatusBar(true, response.data.port, response.data.usbId);
                promptSwitchToDeviceScreen(response.data.port);
            } else {
                updateSerialStatusBar(false, null); // 显示未连接状态，等待后端事件
            }
        } else {
            console.error('[Serial] 服务启动失败:', response);
        }
    });
}

function promptSwitchToDeviceScreen(port) {
    const promptKey = port || 'connected';
    if (deviceScreenSwitchInProgress || deviceScreenSwitchPromptPort === promptKey) {
        return;
    }

    deviceScreenSwitchPromptPort = promptKey;
    confirmModal('串口已成功连接到设备。是否将界面显示切换到设备屏幕？', () => {
        deviceScreenSwitchInProgress = true;
        showToast('正在切换到设备屏幕...', 2500);
        sendMessage('system', 'switchToDeviceScreen', {}, (response) => {
            deviceScreenSwitchInProgress = false;
            if (response && response.code === 0) {
                const data = response.data || {};
                const rotatedText = data.rotated ? '，已切换为横屏' : '';
                showToast(`已切换到设备屏幕${rotatedText}`, 3000);
            } else {
                showToast(`设备屏幕切换失败: ${response?.msg || '未知错误'}`, 5000);
            }
        });
    }, '切换显示');
}

function resetTouchCalibrationGuidePrompt() {
    touchCalibrationGuidePromptPort = null;
}

function resetDeviceScreenSwitchPrompt() {
    deviceScreenSwitchPromptPort = null;
    deviceScreenSwitchInProgress = false;
    resetTouchCalibrationGuidePrompt();
}

function restoreFromDeviceScreenAfterSerialDisconnect() {
    fullscreenActive = false;
    updateFullscreenButtonState(false);
    sendMessage('system', 'restoreFromDeviceScreen', {}, (response) => {
        if (response && response.code !== 0) {
            console.warn('[Display] restore failed:', response.msg || response);
        }
    });
}

// ========== 工具函数 ==========
/**
 * 显示Toast消息
 * @param {string} message - 消息内容
 * @param {string|number} typeOrDuration - 类型('success'|'error'|'warning'|'info')或持续时间(毫秒)
 * @param {number} duration - 持续时间(毫秒)，默认2000ms
 */
function showToast(message, typeOrDuration = 2000, duration = 2000) {
    const toast = document.getElementById('toast');

    let ms = 2000;
    if (typeof typeOrDuration === 'number') {
        ms = typeOrDuration;
    } else if (typeof typeOrDuration === 'string') {
        // 兼容旧调用：showToast(msg, 'success'|'error'...)
        ms = (typeof duration === 'number') ? duration : 2500;
    } else {
        ms = 2000;
    }

    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), Math.max(500, ms));
}

function showModal(title, content, onConfirm = null, size = 'md') {
    const modal = document.getElementById('modal');
    const modalContent = modal.querySelector('.modal-content');
    document.getElementById('modalTitle').textContent = title;
    if (window.UIComponents?.setModalBodyContent) {
        window.UIComponents.setModalBodyContent(content);
    } else {
        document.getElementById('modalBody').innerHTML = content;
    }

    // 移除所有尺寸类
    modalContent.classList.remove('modal-sm', 'modal-md', 'modal-lg', 'modal-xl');
    // 添加指定尺寸类
    modalContent.classList.add(`modal-${size}`);
    modal.classList.add('active');
    const confirmBtn = document.getElementById('modalConfirm');
    const cancelBtn = document.getElementById('modalCancel');
    const closeBtn = document.getElementById('modalClose');

    // 重置按钮状态（有些页面会在 showModal 后再自定义）
    if (confirmBtn) {
        confirmBtn.textContent = '确定';
        confirmBtn.style.display = '';
        confirmBtn.disabled = false;
    }
    if (cancelBtn) {
        cancelBtn.textContent = '取消';
        cancelBtn.style.display = '';
        cancelBtn.disabled = false;
    }
    if (closeBtn) {
        closeBtn.disabled = false;
    }
    const closeModal = () => {
        modal.classList.remove('active');
        confirmBtn.onclick = null;
        cancelBtn.onclick = null;
        closeBtn.onclick = null;
    };
    confirmBtn.onclick = () => {
        if (onConfirm) {
            // 如果onConfirm返回false，则不关闭modal
            const result = onConfirm();
            if (result === false) {
                return;
            }
        }
        closeModal();
    };
    cancelBtn.onclick = closeModal;
    closeBtn.onclick = closeModal;
}

// 强制关闭主 modal（用于自定义按钮场景）
function closeMainModal() {
    const modal = document.getElementById('modal');
    if (modal) {
        modal.classList.remove('active');
    }
    const confirmBtn = document.getElementById('modalConfirm');
    const cancelBtn = document.getElementById('modalCancel');
    const closeBtn = document.getElementById('modalClose');
    if (confirmBtn) confirmBtn.onclick = null;
    if (confirmBtn) confirmBtn.disabled = false;
    if (cancelBtn) {
        cancelBtn.onclick = null;
        cancelBtn.disabled = false;
    }
    if (closeBtn) {
        closeBtn.onclick = null;
        closeBtn.disabled = false;
    }
}
function confirmModal(message, onConfirm, title = '确认') {
    const safeMessage = typeof escapeHtml === 'function' ? escapeHtml(String(message)) : String(message);
    const content = `<div style="line-height: 1.6;">${safeMessage.replace(/\n/g, '<br>')}</div>`;
    showModal(title, content, onConfirm, 'sm');
}
// ========== 页面导航 ==========
let currentPage = 0;
function initPagination() {
    const container = document.getElementById('pagesContainer');
    let startX = 0;
    let currentX = 0;
    let isDragging = false;
    container.addEventListener('touchstart', (e) => {
        startX = e.touches[0].clientX;
        isDragging = true;
    });
    container.addEventListener('touchmove', (e) => {
        if (!isDragging) return;
        currentX = e.touches[0].clientX;
        const diff = currentX - startX;
        container.style.transform = `translateX(calc(-${currentPage * 100}% + ${diff}px))`;
    });
    container.addEventListener('touchend', () => {
        if (!isDragging) return;
        isDragging = false;
        const diff = currentX - startX;
        if (Math.abs(diff) > 100) {
            if (diff > 0 && currentPage > 0) {
                goToPage(currentPage - 1);
            } else if (diff < 0 && currentPage < 1) {
                goToPage(currentPage + 1);
            } else {
                goToPage(currentPage);
            }
        } else {
            goToPage(currentPage);
        }
    });
}
window.goToPage = (page) => {
    currentPage = page;
    document.getElementById('pagesContainer').style.transform = `translateX(-${page * 100}%)`;
    document.querySelectorAll('.indicator').forEach((ind, idx) => {
        ind.classList.toggle('active', idx === page);
    });
};
function initSettingsNav(defaultTargetId = null) {
    const settingsPage = document.getElementById('page-settings');
    const nav = settingsPage?.querySelector('.settings-nav');
    if (!nav) {
        return;
    }
    const buttons = Array.from(nav.querySelectorAll('.settings-nav-item'));
    const panels = Array.from(settingsPage.querySelectorAll('.settings-section'));
    if (buttons.length === 0 || panels.length === 0) {
        return;
    }
    const syncSettingsDetailHeight = () => {
        if (window.matchMedia('(max-width: 720px)').matches) {
            settingsPage.style.removeProperty('--settings-detail-height');
            return;
        }
        settingsPage.style.setProperty('--settings-detail-height', `${nav.offsetHeight}px`);
    };
    if (!nav._settingsDetailResizeObserver) {
        nav._settingsDetailResizeObserver = new ResizeObserver(syncSettingsDetailHeight);
        nav._settingsDetailResizeObserver.observe(nav);
        window.addEventListener('resize', syncSettingsDetailHeight);
    }
    requestAnimationFrame(syncSettingsDetailHeight);
    const activate = (targetId) => {
        panels.forEach((panel) => {
            panel.classList.toggle('active', panel.id === targetId);
        });
        buttons.forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.settingsTarget === targetId);
        });

        // 仅在对应页面启动自动扫描，离开页面立即停止
        if (targetId === 'settings-wifi') {
            beginWifiScanSession();
            initWifiStatus();
        } else {
            stopWifiStatusRefresh();
            stopWifiAutoScan();
            stopWifiDeviceScan();
        }

        if (targetId === 'settings-bluetooth') {
            initBluetoothStatus();
            // entering bluetooth page: enable discoverable/connectable
            sendMessage('bluetooth', 'setVisibility', { enable: 1 }, () => { });
        } else {
            stopBluetoothAutoScan();
            // leaving bluetooth page: disable discoverable/connectable (save power)
            sendMessage('bluetooth', 'setVisibility', { enable: 0 }, () => { });
        }

        if (targetId === 'settings-display') {
            rk628ScaleModeLoad(true);
            statusLedConfigLoad(true);
        }
    };
    if (nav.dataset.bound !== '1') {
        buttons.forEach((btn) => {
            btn.addEventListener('click', () => activate(btn.dataset.settingsTarget));
        });
        nav.dataset.bound = '1';
    }
    const defaultButton = defaultTargetId
        ? nav.querySelector(`.settings-nav-item[data-settings-target="${defaultTargetId}"]`)
        : (nav.querySelector('.settings-nav-item.active') || buttons[0]);
    if (defaultButton) {
        activate(defaultButton.dataset.settingsTarget);
    }
}
window.openPage = (pageName, tabName) => {
    if (pageName !== 'settings') {
        stopWifiAutoScan();
        stopWifiDeviceScan();
    }

    document.getElementById('desktop-view').classList.remove('active');
    document.querySelectorAll('.detail-page').forEach(page => page.classList.remove('active'));
    const pageEl = document.getElementById('page-' + pageName);
    pageEl.classList.add('active');

    // no-dock 页面隐藏 Dock（参考虚拟触摸板）
    try {
        const dock = document.querySelector('.dock-bar');
        if (dock) {
            dock.style.display = pageEl.classList.contains('no-dock') ? 'none' : '';
        }
    } catch { }
    // 如果指定了tab，切换到对应的tab
    if (pageName === 'input' && tabName) {
        switchInputTab(tabName);
    }
    // 如果打开监控页面,初始化canvas并开始更新数据
    if (pageName === 'monitor') {
        // 延迟一帧确保页面已经渲染
        setTimeout(() => {
            initMonitoring();
        }, 50);
    }
    // 如果打开设置页面，确保应用列表已加载
    if (pageName === 'settings') {
        // 如果应用列表为空，加载它
        if (systemApps.length === 0) {
            loadSystemApps();
        } else {
            // 否则只是刷新显示
            renderAppsList();
        }
        initSettingsNav(tabName || null);
    }

    // 如果打开 AI 页面，启动/连接 OpenCode sidecar
    if (pageName === 'ai') {
        aiInitPage();
    }

    if (pageName === 'touch-calibration') {
        touchCal2OpenPage();
    }

    if (pageName === 'audio-eq') {
        audioEqOpenPage();
    }
};
window.closePage = () => {
    const touchCalPage = document.getElementById('page-touch-calibration');
    if (touchCalPage && touchCalPage.classList.contains('active')) {
        touchCal2Stop(true);
    }

    // 离开设置页：如果蓝牙设置处于激活状态，关闭可发现/可连接
    try {
        if (isBluetoothSettingsActive()) {
            sendMessage('bluetooth', 'setVisibility', { enable: 0 }, () => { });
        }
    } catch (e) {
        // 忽略
    }
    sendMessage('system', 'setNoActivate', { enable: false });
    // 如果番茄钟页面正在运行，停止计时器
    const pomodoroPage = document.getElementById('page-pomodoro');
    if (pomodoroPage && pomodoroPage.classList.contains('active')) {
        if (typeof pomodoroIsRunning !== 'undefined' && pomodoroIsRunning) {
            togglePomodoro(); // 暂停番茄钟
        }
    }
    // 如果监控页面正在运行,停止定时器
    const monitorPage = document.getElementById('page-monitor');
    if (monitorPage && monitorPage.classList.contains('active')) {
        if (monitorUpdateInterval) {
            clearInterval(monitorUpdateInterval);
            monitorUpdateInterval = null;
        }
    }

    const keyboardPage = document.getElementById('page-keyboard');
    if (keyboardPage && keyboardPage.classList.contains('active')) {
        resetVirtualKeyboardState('closePage');
    }

    // 离开详情页时停止 WiFi/蓝牙自动扫描（仅在对应设置页开启）
    stopWifiAutoScan();
    stopWifiDeviceScan();
    stopBluetoothAutoScan();

    document.querySelectorAll('.detail-page').forEach(page => page.classList.remove('active'));
    document.getElementById('desktop-view').classList.add('active');

    // 返回桌面时恢复 Dock
    try {
        const dock = document.querySelector('.dock-bar');
        if (dock) {
            dock.style.display = '';
        }
    } catch { }
};

// ========== Home Clock (HH:MM) ==========
// Avoid calling host getTime every second; sync occasionally and tick locally.
const homeClockState = {
    initialized: false,
    synced: false,
    baseTs: 0,
    basePerf: 0,
    tickTimer: null,     // setTimeout id
    resyncTimer: null,   // setInterval id
    lastKey: ''
};

function getHomeClockNowMs() {
    if (homeClockState.synced && homeClockState.baseTs) {
        return homeClockState.baseTs + (performance.now() - homeClockState.basePerf);
    }
    return Date.now();
}

function renderHomeClock() {
    const timeEl = document.getElementById('currentTime');
    const dateEl = document.getElementById('currentDate');
    if (!timeEl || !dateEl) {
        return;
    }

    const now = new Date(getHomeClockNowMs());
    const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    if (key === homeClockState.lastKey) {
        return;
    }
    homeClockState.lastKey = key;

    timeEl.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const months = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
    const days = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    dateEl.textContent = `${months[now.getMonth()]}${now.getDate()}日 ${days[now.getDay()]}`;
}

function scheduleHomeClockTick() {
    if (homeClockState.tickTimer) {
        clearTimeout(homeClockState.tickTimer);
        homeClockState.tickTimer = null;
    }
    // Check once per second so small host/local clock offsets cannot skip a minute boundary.
    const nowMs = getHomeClockNowMs();
    let wait = 1000 - (nowMs % 1000);
    if (wait < 50) {
        wait += 1000;
    }
    homeClockState.tickTimer = setTimeout(() => {
        renderHomeClock();
        scheduleHomeClockTick();
    }, wait);
}

function syncHomeClockFromHost() {
    if (!wsConnected) {
        homeClockState.synced = false;
        homeClockState.baseTs = 0;
        homeClockState.basePerf = 0;
        renderHomeClock();
        return;
    }
    sendMessage('system', 'getTime', {}, (response) => {
        if (response && response.code === 0 && response.data && typeof response.data.timestamp === 'number') {
            homeClockState.synced = true;
            homeClockState.baseTs = response.data.timestamp;
            homeClockState.basePerf = performance.now();
            homeClockState.lastKey = '';
            renderHomeClock();
            scheduleHomeClockTick();
            return;
        }
        // Fallback to local time.
        homeClockState.synced = false;
        homeClockState.baseTs = 0;
        homeClockState.basePerf = 0;
        homeClockState.lastKey = '';
        renderHomeClock();
        scheduleHomeClockTick();
    });
}

function startHomeClock() {
    renderHomeClock();
    syncHomeClockFromHost();
    scheduleHomeClockTick();

    if (homeClockState.resyncTimer) {
        clearInterval(homeClockState.resyncTimer);
        homeClockState.resyncTimer = null;
    }
    // The monotonic local tick handles display updates; host time only corrects long-term drift.
    homeClockState.resyncTimer = setInterval(syncHomeClockFromHost, 5 * 60 * 1000);

    if (!homeClockState.initialized) {
        homeClockState.initialized = true;
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                homeClockState.lastKey = '';
                syncHomeClockFromHost();
                renderHomeClock();
                scheduleHomeClockTick();
            }
        });
    }
}

// ========== 主页Widget ==========
function initHomeWidgets() {
    // 时间更新（本地tick + 低频同步）
    startHomeClock();
    // 天气动画效果
    initWeatherWidget();
    // 音量亮度控制（修复纵向滑动）
    const volumeSlider = document.getElementById('volumeSlider');
    const volumeIcon = document.getElementById('volumeIcon');
    const brightnessSlider = document.getElementById('brightnessSlider');
    // 音量图标点击事件 - 切换静音
    volumeIcon.addEventListener('click', () => {
        toggleMute();
    });
    volumeSlider.addEventListener('input', (e) => {
        const volume = parseInt(e.target.value);
        const volumeValue = document.getElementById('volumeValue');
        // 更新显示
        if (volumeValue) {
            volumeValue.textContent = volume + '%';
        }
        // 如果正在静音状态，拖动滑块时自动取消静音
        if (isMuted && volume > 0) {
            isMuted = false;
            // 如果是上位机音量，取消系统静音
            if (!bluetoothConnected) {
                sendMessage('system', 'setMute', { mute: false });
            }
        }
        // 保存当前音量（用于静音恢复）
        if (volume > 0) {
            volumeBeforeMute = volume;
        }
        // 更新音量图标
        updateVolumeIcon();
        // 根据蓝牙连接状态决定调用哪个API
        if (bluetoothConnected) {
            // 蓝牙已连接，通过下位机设置音量
            sendMessage('bluetooth', 'setVolume', { volume: volume }, (response) => {
                if (response.code !== 0) {
                    console.warn('[Volume] 蓝牙音量设置失败:', response.msg);
                    showToast('蓝牙音量设置失败');
                }
            });
        } else {
            // 蓝牙未连接，设置上位机系统音量
            sendMessage('system', 'setVolume', { volume: volume }, (response) => {
                if (response.code !== 0) {
                    console.warn('[Volume] 系统音量设置失败:', response.msg);
                    showToast('系统音量设置失败');
                } else {
                    console.log('[Volume] 系统音量已设置为:', volume);
                }
            });
        }
    });
    // 亮度slider事件 - 实时更新显示
    brightnessSlider.addEventListener('input', (e) => {
        const brightness = parseInt(e.target.value);
        document.getElementById('brightnessValue').textContent = brightness + '%';
    });
    // 亮度slider松开时发送到下位机
    brightnessSlider.addEventListener('change', (e) => {
        const brightness = parseInt(e.target.value);
        sendMessage('panel', 'setBrightness', { brightness: brightness }, (response) => {
            if (response.code === 0) {
                console.log('[Panel] 亮度设置成功:', brightness + '%');
            } else {
                console.error('[Panel] 亮度设置失败:', response.msg);
                showToast('亮度设置失败: ' + (response.msg || '未知错误'));
            }
        });
    });
    // 注意：性能监控订阅已移至 WebSocket 连接成功后自动触发
}
// ========== 音量控制辅助函数 ==========
// 切换静音状态
function toggleMute() {
    isMuted = !isMuted;
    if (bluetoothConnected) {
        // 蓝牙已连接，通过下位机切换静音
        const volumeSlider = document.getElementById('volumeSlider');
        const currentVolume = parseInt(volumeSlider.value);
        if (isMuted) {
            // 进入静音：保存当前音量并设置为0
            volumeBeforeMute = currentVolume;
            volumeSlider.value = 0;
            document.getElementById('volumeValue').textContent = '0%';
            sendMessage('bluetooth', 'setVolume', { volume: 0 }, (response) => {
                if (response.code !== 0) {
                    console.warn('[Volume] 蓝牙静音失败:', response.msg);
                    isMuted = false; // 恢复状态
                }
            });
        } else {
            // 取消静音：恢复之前的音量
            volumeSlider.value = volumeBeforeMute;
            document.getElementById('volumeValue').textContent = volumeBeforeMute + '%';
            sendMessage('bluetooth', 'setVolume', { volume: volumeBeforeMute }, (response) => {
                if (response.code !== 0) {
                    console.warn('[Volume] 蓝牙取消静音失败:', response.msg);
                    isMuted = true; // 恢复状态
                }
            });
        }
    } else {
        // 蓝牙未连接，使用系统静音API
        sendMessage('system', 'setMute', { mute: isMuted }, (response) => {
            if (response.code === 0) {
                console.log('[Volume] 静音状态已切换为:', isMuted);
            } else {
                console.warn('[Volume] 切换静音失败:', response.msg);
                isMuted = !isMuted; // 恢复状态
            }
        });
    }
    updateVolumeIcon();
}
// 更新音量图标
function updateVolumeIcon() {
    const volumeIcon = document.getElementById('volumeIcon');
    if (!volumeIcon) return;
    if (isMuted) {
        volumeIcon.textContent = '🔇'; // 静音图标
    } else {
        const volumeSlider = document.getElementById('volumeSlider');
        const volume = parseInt(volumeSlider.value);
        if (volume === 0) {
            volumeIcon.textContent = '🔇'; // 音量为0
        } else if (volume < 33) {
            volumeIcon.textContent = '🔈'; // 低音量
        } else if (volume < 66) {
            volumeIcon.textContent = '🔉'; // 中音量
        } else {
            volumeIcon.textContent = '🔊'; // 高音量
        }
    }
}
// 订阅性能监控
function subscribePerformanceMonitoring() {
    sendMessage('system', 'subscribePerformance', {}, (response) => {
        if (response.code === 0) {
            console.log('[Performance] 已订阅性能监控');
        } else {
            console.error('[Performance] 订阅失败:', response.msg);
        }
    });
}
// 更新性能显示
function updatePerformanceDisplay(data) {
    // 更新首页小组件
    const miniCpuValue = document.getElementById('miniCpuValue');
    const miniMemValue = document.getElementById('miniMemValue');
    const miniTempValue = document.getElementById('miniTempValue');
    if (miniCpuValue) {
        miniCpuValue.textContent = Math.round(data.cpu) + '%';
        drawMiniChart('miniCpuChart', data.cpu);
    }
    if (miniMemValue && data.memory) {
        miniMemValue.textContent = data.memory.used.toFixed(1) + ' GB';
        drawMiniChart('miniMemChart', data.memory.percent);
    }
    if (miniTempValue) {
        if (data.temperature > 0) {
            miniTempValue.textContent = Math.round(data.temperature) + '°C';
            drawMiniChart('miniTempChart', data.temperature);
        } else {
            miniTempValue.textContent = 'N/A';
            drawMiniChart('miniTempChart', 0);
        }
    }
    // 更新状态栏网络速度显示（如果有网络数据）
    if (data.network) {
        updateNetworkSpeedBar(data.network.download, data.network.upload);
    }
    // 更新详情页（如果已打开）
    updatePerformanceDetailPage(data);
}
// 更新性能监控详情页
function updatePerformanceDetailPage(data) {
    // 只有在详情页打开时才更新
    const monitorPage = document.getElementById('page-monitor');
    if (!monitorPage || !monitorPage.classList.contains('active')) {
        return;
    }
    // 使用来自后端的网络数据（保持字节单位，以便与状态栏格式一致）
    const networkDownloadBytes = data.network ? data.network.download : 0;
    const networkUploadBytes = data.network ? data.network.upload : 0;
    // 调试：输出网络数据
    console.log('[Monitor] Network data:', {
        raw: data.network,
        downloadBytes: networkDownloadBytes,
        uploadBytes: networkUploadBytes
    });
    // 转换数据格式以匹配原有的 updateMonitorData 函数
    const formattedData = {
        cpu: data.cpu,
        memory: data.memory ? data.memory.used * 1024 : 0, // 转换为 MB
        memoryTotal: data.memory ? data.memory.total * 1024 : 16384,
        temperature: data.temperature || 0,
        network: {
            download: networkDownloadBytes,
            upload: networkUploadBytes
        }
    };
    updateMonitorData(formattedData);
}
function drawMiniChart(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    const numericValue = Number(value);
    const percentage = Number.isFinite(numericValue)
        ? Math.min(100, Math.max(0, numericValue))
        : 0;
    const fill = el.querySelector('.mini-chart-fill');
    if (fill) fill.style.width = `${percentage}%`;
    el.setAttribute('aria-valuenow', String(Math.round(percentage)));

    const item = el.closest('.perf-item-large');
    if (item) {
        item.classList.toggle('is-warning', percentage >= 70 && percentage < 85);
        item.classList.toggle('is-critical', percentage >= 85);
    }
}

// 截图
window.takeScreenshot = () => {
    sendMessage('app', 'screenshot', {}, (response) => {
        if (response.code === 0) {
            showToast('✓ 截图工具已启动');
        } else {
            showToast('✗ 截图工具启动失败: ' + (response.msg || '未知错误'));
        }
    });
};
// 退出应用
window.exitApp = () => {
    showModal('退出应用', '确定要退出应用吗？', () => {
        sendMessage('system', 'exit', null, (response) => {
            if (response.code === 0) {
                showToast('应用已退出');
            } else {
                showToast(`退出失败: ${response.msg || '未知错误'}`);
            }
        });
        showToast('正在退出...');
    });
};

// ========== AI ==========

const aiState = {
    mode: 'build',
    model: '',
    variant: '',
    defaultAgent: '',
    defaultModel: '',

    status: { running: false, url: '', version: '' },
    statusHint: '',
    statusHintLoading: false,
    runtimeLastText: '',
    runtimeLastAt: 0,
    initModalShown: false,
    ai2Bound: false,
    modelsLoaded: false,
    configPrompted: false,

    sessionId: null,
    attachments: [],

    providerList: null,
    providerAuth: {},
    connectedProviders: new Set(),
    modelCatalog: { providers: [], flat: [] },
    modelCatalogRaw: null,

    sendInFlight: false,
    lastSendSig: '',
    lastSendTs: 0,
    creatingSessionPromise: null,
    awaitingReply: false,
    awaitingTimer: null,
    sessionStatusType: 'idle',
    abortInFlight: false,

    messageOrder: [],
    messageInfo: new Map(),
    messageParts: new Map(),
    optimisticText: new Map(),
    selectedMessageId: null,

    permissionQueue: [],
    questionQueue: [],
    permissionSeen: new Set(),
    questionSeen: new Set(),
    pendingSynced: false,
    currentPrompt: null,

    hydrateTimer: null,
    hydrateInFlight: false
};

function setAiMode(mode) {
    aiState.mode = (mode === 'plan') ? 'plan' : 'build';
    const planBtn = document.getElementById('aiModePlanBtn');
    const buildBtn = document.getElementById('aiModeBuildBtn');
    if (planBtn) planBtn.classList.toggle('active', aiState.mode === 'plan');
    if (buildBtn) buildBtn.classList.toggle('active', aiState.mode === 'build');
}

window.setAiMode = setAiMode;

function aiShowInitModal() {
    if (aiState.initModalShown) {
        const modal = document.getElementById('modal');
        if (modal && modal.classList.contains('active') && document.getElementById('aiInitStage')) {
            return;
        }
        aiState.initModalShown = false;
    }

    const body = `
        <div style="display:flex; flex-direction:column; gap:12px;">
            <div class="text-muted" id="aiInitStage" style="font-size: var(--font-body-lg);">准备启动 OpenCode 服务...</div>
            <div style="width:100%; height:16px; border-radius:999px; background: rgba(255,255,255,0.12); overflow:hidden;">
                <div id="aiInitBar" style="width:0%; height:100%; background: var(--accent-blue); transition: width 0.2s ease;"></div>
            </div>

            <div style="background:#0d0d0f; border: 1px solid rgba(255,255,255,0.10); border-radius: 14px; overflow:hidden;">
                <div class="log-terminal" id="aiInitDetail" style="height: 360px; font-size: var(--font-body);"></div>
            </div>

            <div class="update-log-status" style="line-height:1.6;">
                本机未找到可用 OpenCode，可在此查看下载/解压进度；完成后将自动启动 <code>opencode serve</code>。
            </div>
        </div>
    `;

    showModal('AI 初始化', body, null, 'lg');
    aiState.initModalShown = true;

    const confirmBtn = document.getElementById('modalConfirm');
    const cancelBtn = document.getElementById('modalCancel');
    if (confirmBtn) confirmBtn.textContent = '后台运行';
    if (cancelBtn) cancelBtn.style.display = 'none';
}

function aiHideInitModalIfAny() {
    const modal = document.getElementById('modal');
    if (modal && modal.classList.contains('active')) {
        modal.classList.remove('active');
    }
    const confirmBtn = document.getElementById('modalConfirm');
    const cancelBtn = document.getElementById('modalCancel');
    if (confirmBtn) confirmBtn.textContent = '确定';
    if (cancelBtn) cancelBtn.style.display = '';
    aiState.initModalShown = false;
}

function aiUpdateInitProgress(p) {
    const stageEl = document.getElementById('aiInitStage');
    const barEl = document.getElementById('aiInitBar');
    const detailEl = document.getElementById('aiInitDetail');
    if (stageEl && p?.text) {
        stageEl.textContent = p.text;
    }

    if (detailEl) {
        const lines = [];
        if (p?.stage) lines.push(`阶段: ${p.stage}`);
        if (p?.version) lines.push(`版本: ${p.version}`);
        if (typeof p?.current === 'number' && typeof p?.total === 'number' && p.total > 0) {
            lines.push(`进度: ${formatBytes(p.current)} / ${formatBytes(p.total)}`);
        }
        if (p?.error) lines.push(`错误: ${p.error}`);
        detailEl.textContent = lines.join('\n');
    }

    if (barEl && typeof p?.percent === 'number') {
        barEl.style.width = `${Math.max(0, Math.min(100, p.percent))}%`;
    }
}

function updateAiStatusUi() {
    const connEl = document.getElementById('aiConnectionText');
    const verEl = document.getElementById('aiVersionText');
    if (connEl) connEl.textContent = aiState.status.running ? '已连接' : '未连接';

    if (!verEl) return;

    const runtime = aiGetRuntimeStatusSummary();
    if (runtime.active) {
        verEl.textContent = runtime.text;
        verEl.title = runtime.title || runtime.text;
        verEl.classList.toggle('is-loading', !!runtime.loading);
        return;
    }

    if (aiState.statusHint) {
        verEl.textContent = aiState.statusHint;
        verEl.title = aiState.statusHint;
        verEl.classList.toggle('is-loading', !!aiState.statusHintLoading);
        return;
    }

    verEl.classList.remove('is-loading');
    if (aiState.status.running) {
        verEl.textContent = aiState.status.version ? `v${aiState.status.version}` : '已连接';
        verEl.title = aiState.status.version ? `版本 ${aiState.status.version}` : '已连接';
        return;
    }

    verEl.textContent = '未启动';
    verEl.title = '未启动';
}

function aiTouchRuntimeStatus(text = '') {
    aiState.runtimeLastAt = Date.now();
    if (text) {
        aiState.runtimeLastText = String(text || '').trim();
    }
}

function aiFormatRuntimeAge(ts) {
    if (!ts) return '';
    const diff = Math.max(0, Date.now() - ts);
    if (diff < 5000) return '刚刚更新';
    if (diff < 60000) return `${Math.max(1, Math.round(diff / 1000))} 秒前更新`;
    return `${Math.max(1, Math.round(diff / 60000))} 分钟前更新`;
}

function aiFindNestedStringByKey(value, matcher) {
    const visited = new Set();
    const walk = (current) => {
        if (!current) return '';
        if (typeof current === 'string') {
            const text = current.trim();
            return text;
        }
        if (typeof current !== 'object') return '';
        if (visited.has(current)) return '';
        visited.add(current);

        if (Array.isArray(current)) {
            for (let i = 0; i < current.length; i++) {
                const found = walk(current[i]);
                if (found) return found;
            }
            return '';
        }

        const keys = Object.keys(current);
        for (const key of keys) {
            if (!matcher.test(key)) continue;
            const found = walk(current[key]);
            if (found) return found;
        }
        for (const key of keys) {
            const found = walk(current[key]);
            if (found) return found;
        }
        return '';
    };
    return walk(value);
}

function aiSummarizeCommandText(text) {
    const source = String(text || '').replace(/\s+/g, ' ').trim();
    if (!source) return '';

    const ps1 = source.match(/([A-Za-z0-9._-]+\.ps1)\b/i);
    if (ps1) return ps1[1];

    const cmdFile = source.match(/([A-Za-z0-9._-]+\.(?:cmd|bat|sh))\b/i);
    if (cmdFile) return cmdFile[1];

    const dotnetVerb = source.match(/\bdotnet\s+(restore|build|publish|test|run)\b/i);
    if (dotnetVerb) return `dotnet ${dotnetVerb[1].toLowerCase()}`;

    const pwshFile = source.match(/-File\s+["']?([^"'\s]+)["']?/i);
    if (pwshFile) {
        const file = pwshFile[1].split(/[\\/]/).pop();
        if (file) return file;
    }

    return source.length > 64 ? `${source.slice(0, 64)}...` : source;
}

function aiFormatToolStatus(status) {
    const s = String(status || '').toLowerCase();
    if (!s) return '运行中';
    if (s === 'running' || s === 'in_progress' || s === 'working' || s === 'executing' || s === 'pending' || s === 'retry') return '运行中';
    if (s === 'completed' || s === 'success' || s === 'done' || s === 'finished') return '已完成';
    if (s === 'failed' || s === 'error') return '失败';
    if (s === 'cancelled' || s === 'canceled' || s === 'aborted') return '已中止';
    return s;
}

function aiFindLatestToolActivity(messageID = null) {
    const ids = messageID ? [messageID] : aiState.messageOrder.slice().reverse();
    const activeStates = new Set(['running', 'in_progress', 'working', 'executing', 'pending', 'retry']);
    let fallback = null;

    for (const id of ids) {
        const info = aiState.messageInfo.get(id);
        if (!info) continue;
        if (!aiIsMessageVisible(info)) continue;
        if (info.role !== 'assistant') continue;

        const parts = aiGetNonTextParts(id);
        for (let i = parts.length - 1; i >= 0; i--) {
            const part = parts[i];
            if (!part || part.type !== 'tool') continue;

            const rawStatus = String(part.state?.status || '').toLowerCase();
            const commandText = aiFindNestedStringByKey(part, /(?:command|script|cmd|file|path|program|argv|args)/i);
            const label = aiSummarizeCommandText(commandText) || String(part.tool || '工具');
            const activity = {
                label,
                status: aiFormatToolStatus(rawStatus),
                rawStatus,
                isError: rawStatus === 'error' || rawStatus === 'failed',
                isActive: activeStates.has(rawStatus) || (!rawStatus && aiState.awaitingReply)
            };
            if (activity.isActive) return activity;
            if (!fallback) fallback = activity;
        }
        if (messageID) break;
    }

    return fallback;
}

function aiGetRuntimeStatusSummary() {
    if (aiState.statusHint && aiState.statusHintLoading) {
        return {
            active: true,
            loading: true,
            text: aiState.statusHint,
            title: aiState.statusHint
        };
    }

    if (aiState.awaitingReply || aiState.sessionStatusType === 'busy' || aiState.sessionStatusType === 'retry') {
        const toolActivity = aiFindLatestToolActivity();
        if (toolActivity) {
            const age = aiFormatRuntimeAge(aiState.runtimeLastAt);
            const text = `执行中 · ${toolActivity.label}`;
            const title = `${text}${age ? `（${age}）` : ''}；状态：${toolActivity.status}`;
            return {
                active: true,
                loading: !toolActivity.isError,
                text,
                title
            };
        }

        const fallback = aiState.runtimeLastText || 'OpenCode 正在处理中';
        const age = aiFormatRuntimeAge(aiState.runtimeLastAt);
        return {
            active: true,
            loading: true,
            text: fallback,
            title: age ? `${fallback}（${age}）` : fallback
        };
    }

    return { active: false, loading: false, text: '', title: '' };
}

// ========== AI v2 重构（覆盖旧实现） ==========
const AI2_MODEL_KEY = 'pm_ai_model';
const AI2_VARIANT_KEY = 'pm_ai_variant';
const AI2_HIDDEN_MODELS_KEY = 'pm_ai_hidden_models';
const AI2_HELP_SEEN_KEY = 'pm_ai_help_seen_v1';
const AI2_POPULAR_PROVIDERS = ['opencode', 'anthropic', 'github-copilot', 'openai', 'google', 'openrouter', 'vercel'];

const ai2ModalState = {
    open: false,
    view: 'model', // model | provider | connect | manage
    search: '',
    providerSearch: '',
    manageSearch: '',
    selectedModelKey: '',
    selectedProvider: '',
    selectedMethodIndex: null,
    authorization: null,
    pending: false,
    error: '',
    hidden: new Set(),
    oauthPollToken: 0,
    oauthStatus: ''
};

function ai2LsGet(k) {
    try { return localStorage.getItem(k); } catch { return null; }
}
function ai2LsSet(k, v) {
    try { localStorage.setItem(k, v); } catch { }
}
function ai2LsDel(k) {
    try { localStorage.removeItem(k); } catch { }
}

const AUDIO_SOURCE_HDMI = 'hdmi';
const AUDIO_SOURCE_UAC = 'uac';
const AUDIO_MIC_ONBOARD = 'onboard';
const AUDIO_MIC_HEADSET = 'headset';
const AUDIO_MIC_BLUETOOTH = 'bluetooth';
const AUDIO_EQ_DEFAULT_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const AUDIO_EQ_MIN_FREQ = 20;
const AUDIO_EQ_MAX_FREQ = 22000;
const AUDIO_EQ_MIN_GAIN = -18;
const AUDIO_EQ_MAX_GAIN = 18;
const AUDIO_EQ_TYPES = [
    { value: 'peak', label: '峰值', id: 2 },
    { value: 'lowShelf', label: '低架', id: 4 },
    { value: 'highShelf', label: '高架', id: 3 },
    { value: 'highPass', label: '高通', id: 0 },
    { value: 'lowPass', label: '低通', id: 1 }
];
let audioRouteState = {
    audioSource: AUDIO_SOURCE_HDMI,
    micInput: AUDIO_MIC_ONBOARD
};

let audioRouteCommitted = { ...audioRouteState };
const deviceOperationWaiters = new Map();
const deviceOperationResults = new Map();

function cacheDeviceOperationResult(operationId, data) {
    deviceOperationResults.set(operationId, data);
    while (deviceOperationResults.size > 32) {
        deviceOperationResults.delete(deviceOperationResults.keys().next().value);
    }
    setTimeout(() => {
        if (deviceOperationResults.get(operationId) === data) {
            deviceOperationResults.delete(operationId);
        }
    }, 60000);
}

function settleDeviceOperation(data) {
    const operationId = data?.operationId || data?.requestId;
    if (!operationId) return;
    const waiter = deviceOperationWaiters.get(operationId);
    if (!waiter) {
        cacheDeviceOperationResult(operationId, data);
        return;
    }
    deviceOperationWaiters.delete(operationId);
    clearTimeout(waiter.timer);
    if (data.code === 0) waiter.resolve(data);
    else waiter.reject(data);
}

function waitForDeviceOperation(operationId, timeoutMs = 30000) {
    if (!operationId || deviceOperationWaiters.has(operationId)) {
        return Promise.reject({ code: 2, msg: '无效或重复的 operationId' });
    }
    const completed = deviceOperationResults.get(operationId);
    if (completed) {
        deviceOperationResults.delete(operationId);
        return completed.code === 0
            ? Promise.resolve(completed)
            : Promise.reject(completed);
    }
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            deviceOperationWaiters.delete(operationId);
            reject({ code: 5, msg: '等待设备操作完成超时' });
        }, timeoutMs);
        deviceOperationWaiters.set(operationId, { resolve, reject, timer });
    });
}
let audioRouteApplyState = {
    active: '',
    routeRunning: false,
    routeQueued: false,
    routeSeq: 0,
    micRunning: false,
    micQueued: false,
    micSeq: 0,
    syncRunning: false
};

function audioRouteSetStatus(text, state = '') {
    const el = document.getElementById('audioRouteStatus');
    if (!el) return;
    el.textContent = `音频来源状态：${text}`;
    if (state) el.dataset.state = state;
    else delete el.dataset.state;
}

let audioEqState = {
    loaded: false,
    dirty: false,
    globalGain: 0,
    selectedIndex: 0,
    draggingIndex: null,
    bands: AUDIO_EQ_DEFAULT_FREQS.map((freq, index) => ({ index, freq, gain: 0, q: 0.7, type: 'peak' }))
};

function audioSourceNormalize(value, fallback = AUDIO_SOURCE_HDMI) {
    return value === AUDIO_SOURCE_HDMI || value === AUDIO_SOURCE_UAC ? value : fallback;
}

function audioMicNormalize(value, fallback = AUDIO_MIC_ONBOARD) {
    return value === AUDIO_MIC_HEADSET || value === AUDIO_MIC_BLUETOOTH ? value : fallback;
}

function audioRouteRenderSettings() {
    const sourceSelect = document.getElementById('audioSourceSelect');
    const micSelect = document.getElementById('audioMicRouteSelect');
    if (sourceSelect) sourceSelect.value = audioRouteState.audioSource;
    if (micSelect) micSelect.value = audioRouteState.micInput;
}

function audioRouteDeviceReady() {
    return serialConnected === true;
}

function audioRouteApplyDeviceData(data) {
    if (!data) return;
    if (data.audio_source) {
        audioRouteState.audioSource = audioSourceNormalize(data.audio_source, AUDIO_SOURCE_HDMI);
    }
    audioRouteCommitted.audioSource = audioRouteState.audioSource;
}

function audioRouteApplyMicData(data) {
    if (!data || !data.source) return;
    audioRouteState.micInput = audioMicNormalize(data.source, AUDIO_MIC_ONBOARD);
    audioRouteCommitted.micInput = audioRouteState.micInput;
}

function sendAudioCommand(cmd, data = null) {
    return new Promise((resolve, reject) => {
        sendMessage('audio', cmd, data, (response) => {
            if (response.code === 0) {
                resolve(response);
            } else {
                reject(response);
            }
        });
    });
}

async function audioRouteSyncFromDevice() {
    if (audioRouteApplyState.syncRunning || audioRouteApplyState.active) return false;
    audioRouteApplyState.syncRunning = true;
    if (!audioRouteDeviceReady()) {
        audioRouteRenderSettings();
        audioRouteSetStatus('等待下位机连接');
        audioRouteApplyState.syncRunning = false;
        return false;
    }

    try {
        const result = await sendRK628Command(21, null);
        const data = result?.data || {};
        audioRouteApplyDeviceData(data);
        try {
            const micResult = await sendAudioCommand('getMicSource', null);
            audioRouteApplyMicData(micResult?.data);
        } catch (micErr) {
            console.warn('[AudioRoute] sync mic source failed:', micErr);
        }
        try {
            const eqResult = await sendAudioCommand('getEq', null);
            audioEqApplyDeviceData(eqResult?.data);
        } catch (eqErr) {
            console.warn('[AudioRoute] sync EQ failed:', eqErr);
        }
        audioRouteRenderSettings();
        audioRouteSetStatus('已从下位机确认', 'success');
        audioRouteApplyState.syncRunning = false;
        return true;
    } catch (err) {
        console.warn('[AudioRoute] sync from device failed:', err);
        audioRouteRenderSettings();
        audioRouteSetStatus(formatDeviceCommandError(err, '读取音频来源失败'), 'error');
        audioRouteApplyState.syncRunning = false;
        return false;
    }
}

async function audioRouteApplyToDevice(silent = false) {
    if (!audioRouteDeviceReady()) {
        if (!silent) showToast('下位机未连接，无法修改音频来源', 2500);
        audioRouteSetStatus('等待下位机连接');
        audioRouteRenderSettings();
        return null;
    }
    audioRouteApplyState.routeSeq += 1;
    audioRouteApplyState.routeQueued = true;
    if (audioRouteApplyState.routeRunning) return null;

    while (audioRouteApplyState.active && audioRouteApplyState.active !== 'route' && audioRouteDeviceReady()) {
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!audioRouteDeviceReady()) return null;

    audioRouteApplyState.active = 'route';
    audioRouteApplyState.routeRunning = true;
    let lastResponse = null;
    try {
        while (audioRouteApplyState.routeQueued && audioRouteDeviceReady()) {
            audioRouteApplyState.routeQueued = false;
            const seq = audioRouteApplyState.routeSeq;
            const desired = audioRouteState.audioSource;
            audioRouteSetStatus('正在切换音频来源...', 'busy');
            try {
                lastResponse = await sendRK628AudioCommandWithTimeout(20, { audio_source: desired });
                const operationId = lastResponse?.data?.operationId;
                if (!lastResponse?.data?.accepted || !operationId) {
                    throw { code: 9000, msg: '设备未接受异步音频来源操作' };
                }
                await waitForDeviceOperation(operationId, 12000);
                const confirmed = await sendRK628AudioCommandWithTimeout(21, null, 8000);
                const data = confirmed?.data || {};
                if (data.audio_source !== desired) {
                    throw { code: 1, msg: '下位机回读的音频来源与目标不一致' };
                }
                if (seq === audioRouteApplyState.routeSeq) {
                    audioRouteApplyDeviceData(data);
                    audioRouteRenderSettings();
                    audioRouteSetStatus('音频来源已确认', 'success');
                    if (!silent) showToast('音频来源已确认');
                }
            } catch (err) {
                if (seq === audioRouteApplyState.routeSeq) {
                    audioRouteState.audioSource = audioRouteCommitted.audioSource;
                    audioRouteRenderSettings();
                    const message = formatDeviceCommandError(err, '音频来源切换失败');
                    audioRouteSetStatus(message, 'error');
                    if (!silent) showToast(message, 3500);
                }
                console.warn('[AudioRoute] audio source apply failed:', err);
            }
        }
    } finally {
        audioRouteApplyState.routeRunning = false;
        if (audioRouteApplyState.active === 'route') audioRouteApplyState.active = '';
    }
    return lastResponse;
}

async function audioMicApplyToDevice(silent = false) {
    if (!audioRouteDeviceReady()) {
        if (!silent) showToast('下位机未连接，无法修改麦克风来源', 2500);
        audioRouteSetStatus('等待下位机连接');
        audioRouteRenderSettings();
        return null;
    }
    audioRouteApplyState.micSeq += 1;
    audioRouteApplyState.micQueued = true;
    if (audioRouteApplyState.micRunning) return null;

    while (audioRouteApplyState.active && audioRouteApplyState.active !== 'mic' && audioRouteDeviceReady()) {
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!audioRouteDeviceReady()) return null;

    audioRouteApplyState.active = 'mic';
    audioRouteApplyState.micRunning = true;
    let lastResponse = null;
    try {
        while (audioRouteApplyState.micQueued && audioRouteDeviceReady()) {
            audioRouteApplyState.micQueued = false;
            const seq = audioRouteApplyState.micSeq;
            const desired = audioRouteState.micInput;
            audioRouteSetStatus('正在切换麦克风来源...', 'busy');
            try {
                lastResponse = await sendAudioCommandWithTimeout('setMicSource', { source: desired });
                let confirmed = null;
                for (let attempt = 0; attempt < 8; attempt += 1) {
                    await new Promise(resolve => setTimeout(resolve, 250));
                    confirmed = await sendAudioCommandWithTimeout('getMicSource', null, 8000);
                    if (confirmed?.data?.source === desired &&
                        (desired !== AUDIO_MIC_BLUETOOTH || confirmed?.data?.available !== false)) break;
                }
                if (!confirmed?.data || confirmed.data.source !== desired ||
                    (desired === AUDIO_MIC_BLUETOOTH && confirmed.data.available === false)) {
                    throw { code: 1, msg: '下位机未确认麦克风来源已生效' };
                }
                if (seq === audioRouteApplyState.micSeq) {
                    audioRouteApplyMicData(confirmed.data);
                    audioRouteRenderSettings();
                    audioRouteSetStatus('麦克风来源已确认', 'success');
                    if (!silent) showToast('麦克风来源已确认');
                }
            } catch (err) {
                if (seq === audioRouteApplyState.micSeq) {
                    audioRouteState.micInput = audioRouteCommitted.micInput;
                    audioRouteRenderSettings();
                    const message = formatDeviceCommandError(err, '麦克风来源切换失败');
                    audioRouteSetStatus(message, 'error');
                    if (!silent) showToast(message, 3500);
                }
                console.warn('[AudioRoute] microphone source apply failed:', err);
            }
        }
    } finally {
        audioRouteApplyState.micRunning = false;
        if (audioRouteApplyState.active === 'mic') audioRouteApplyState.active = '';
    }
    return lastResponse;
}

function audioEqFormatFreq(freq) {
    const n = Number(freq) || 0;
    return n >= 1000 ? `${Number((n / 1000).toFixed(n >= 10000 ? 0 : 1))} kHz` : `${Math.round(n)} Hz`;
}

function audioEqClampGain(value) {
    const n = Number.parseFloat(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(AUDIO_EQ_MIN_GAIN, Math.min(AUDIO_EQ_MAX_GAIN, Math.round(n * 10) / 10));
}

function audioEqClampFreq(value) {
    const n = Number.parseFloat(value);
    if (!Number.isFinite(n)) return 1000;
    return Math.max(AUDIO_EQ_MIN_FREQ, Math.min(AUDIO_EQ_MAX_FREQ, Math.round(n)));
}

function audioEqClampQ(value) {
    const n = Number.parseFloat(value);
    if (!Number.isFinite(n)) return 0.7;
    return Math.max(0.3, Math.min(30, Math.round(n * 100) / 100));
}

function audioEqNormalizeType(value, typeId = null) {
    if (typeof value === 'string' && AUDIO_EQ_TYPES.some(t => t.value === value)) return value;
    if (value === 'bandPass') return 'peak';
    const id = Number(typeId ?? value);
    const matched = AUDIO_EQ_TYPES.find(t => t.id === id);
    return matched ? matched.value : 'peak';
}

function audioEqTypeLabel(type) {
    return (AUDIO_EQ_TYPES.find(t => t.value === type) || AUDIO_EQ_TYPES[0]).label;
}

function audioEqFreqToX(freq) {
    const min = Math.log10(AUDIO_EQ_MIN_FREQ);
    const max = Math.log10(AUDIO_EQ_MAX_FREQ);
    return ((Math.log10(audioEqClampFreq(freq)) - min) / (max - min)) * 100;
}

function audioEqXToFreq(xPercent) {
    const min = Math.log10(AUDIO_EQ_MIN_FREQ);
    const max = Math.log10(AUDIO_EQ_MAX_FREQ);
    const t = Math.max(0, Math.min(100, xPercent)) / 100;
    return audioEqClampFreq(10 ** (min + (max - min) * t));
}

function audioEqGainToY(gain) {
    return ((AUDIO_EQ_MAX_GAIN - audioEqClampGain(gain)) / (AUDIO_EQ_MAX_GAIN - AUDIO_EQ_MIN_GAIN)) * 100;
}

function audioEqYToGain(yPercent) {
    const t = Math.max(0, Math.min(100, yPercent)) / 100;
    return audioEqClampGain(AUDIO_EQ_MAX_GAIN - (AUDIO_EQ_MAX_GAIN - AUDIO_EQ_MIN_GAIN) * t);
}

function audioEqCurvePoints(width = 1000, height = 360) {
    return audioEqState.bands
        .map((band) => ({ x: audioEqFreqToX(band.freq), y: audioEqGainToY(band.gain) }))
        .sort((a, b) => a.x - b.x)
        .map(p => `${(p.x / 100) * width},${(p.y / 100) * height}`)
        .join(' ');
}

function audioEqSetStatus(text) {
    const el = document.getElementById('audioEqStatusText');
    if (el) el.textContent = text;
}

function audioEqApplyDeviceData(data) {
    if (!data) return;
    audioEqState.globalGain = audioEqClampGain(Number.isFinite(Number(data.ggx)) ? Number(data.ggx) / 10 : (Number.isFinite(Number(data.global_gain_x10)) ? Number(data.global_gain_x10) / 10 : (data.global_gain ?? 0)));
    const deviceBands = Array.isArray(data.bands) ? data.bands : (Array.isArray(data.b) ? data.b : []);
    if (deviceBands.length > 0) {
        audioEqState.bands = deviceBands.slice(0, 10).map((band, index) => ({
            index: Number.isFinite(Number(band.i ?? band.index)) ? Number(band.i ?? band.index) : index,
            freq: Number.isFinite(Number(band.f ?? band.freq)) ? Number(band.f ?? band.freq) : (AUDIO_EQ_DEFAULT_FREQS[index] || 0),
            gain: audioEqClampGain(Number.isFinite(Number(band.gx ?? band.gain_x10)) ? Number(band.gx ?? band.gain_x10) / 10 : (band.gain ?? 0)),
            q: audioEqClampQ(Number.isFinite(Number(band.qx ?? band.q_x100)) ? Number(band.qx ?? band.q_x100) / 100 : (band.q ?? 0.7)),
            type: audioEqNormalizeType(band.type, band.t ?? band.type_id)
        }));
    }
    while (audioEqState.bands.length < 10) {
        const index = audioEqState.bands.length;
        audioEqState.bands.push({ index, freq: AUDIO_EQ_DEFAULT_FREQS[index], gain: 0, q: 0.7, type: 'peak' });
    }
    if (!audioEqState.bands[audioEqState.selectedIndex]) {
        audioEqState.selectedIndex = 0;
    }
    audioEqState.loaded = true;
    audioEqState.dirty = false;
    audioEqUpdateSettingsSummary();
}

function audioEqUpdateSettingsSummary() {
    const el = document.getElementById('audioEqSettingsSummary');
    if (!el) return;
    const changedBands = audioEqState.bands.filter((band, index) =>
        band.freq !== AUDIO_EQ_DEFAULT_FREQS[index] ||
        band.gain !== 0 || band.q !== 0.7 || band.type !== 'peak').length;
    const parts = [];
    if (changedBands) parts.push(`${changedBands} 段已调整`);
    if (audioEqState.globalGain !== 0) parts.push(`总增益 ${audioEqState.globalGain} dB`);
    if (!parts.length) parts.push('平直');
    if (audioEqState.dirty) parts.push('未保存');
    el.textContent = parts.join(' · ');
}

function audioEqRender() {
    const container = document.getElementById('audioEqBands');
    const global = document.getElementById('audioEqGlobalGain');
    const globalValue = document.getElementById('audioEqGlobalValue');
    if (global) global.value = String(audioEqState.globalGain);
    if (globalValue) globalValue.textContent = `${audioEqState.globalGain} dB`;
    if (!container) return;
    const selected = audioEqState.bands[audioEqState.selectedIndex] || audioEqState.bands[0];

    container.innerHTML = `
        <div class="audio-eq-workspace">
            <div class="audio-eq-graph-card">
                <div class="audio-eq-plot" id="audioEqPlot">
                    <div class="audio-eq-gain-mark top">+18 dB</div>
                    <div class="audio-eq-gain-mark mid">0 dB</div>
                    <div class="audio-eq-gain-mark bottom">-18 dB</div>
                    <svg class="audio-eq-curve" viewBox="0 0 1000 360" preserveAspectRatio="none" aria-hidden="true">
                        <polyline id="audioEqCurveLine" points="${audioEqCurvePoints()}" />
                    </svg>
                    ${audioEqState.bands.map((band, index) => `
                        <button class="audio-eq-point${index === audioEqState.selectedIndex ? ' active' : ''}" type="button" data-eq-index="${index}" aria-label="控制点 ${index + 1}，${audioEqFormatFreq(band.freq)}，${band.gain} dB，Q ${band.q}，${audioEqTypeLabel(band.type)}" aria-pressed="${index === audioEqState.selectedIndex}" style="left:${audioEqFreqToX(band.freq)}%;top:${audioEqGainToY(band.gain)}%;">
                            <span>${index + 1}</span>
                            <em>${audioEqFormatFreq(band.freq)} · ${band.gain} dB · Q ${band.q} · ${audioEqTypeLabel(band.type)}</em>
                        </button>
                    `).join('')}
                </div>
                <div class="audio-eq-frequency-ruler">
                    <span>20 Hz</span><span>100 Hz</span><span>1 kHz</span><span>10 kHz</span><span>22 kHz</span>
                </div>
            </div>
            <div class="audio-eq-editor">
                <div class="audio-eq-editor-title">控制点 ${audioEqState.selectedIndex + 1}</div>
                <label><span>中心频率</span><input id="audioEqFreqInput" class="input-base" type="number" min="${AUDIO_EQ_MIN_FREQ}" max="${AUDIO_EQ_MAX_FREQ}" step="1" value="${selected?.freq ?? 1000}"></label>
                <label><span>增益 dB</span><input id="audioEqGainInput" class="input-base" type="number" min="${AUDIO_EQ_MIN_GAIN}" max="${AUDIO_EQ_MAX_GAIN}" step="0.1" value="${selected?.gain ?? 0}"></label>
                <label><span>Q 值</span><input id="audioEqQInput" class="input-base" type="number" min="0.3" max="30" step="0.01" value="${selected?.q ?? 0.7}"></label>
                <label><span>类型</span><select id="audioEqTypeSelect" class="select-base">
                    ${AUDIO_EQ_TYPES.map(type => `<option value="${type.value}"${type.value === (selected?.type ?? 'peak') ? ' selected' : ''}>${type.label}</option>`).join('')}
                </select></label>
                <div class="audio-eq-editor-hint">悬停控制点可查看当前参数；拖动控制点会同时更新频率和增益。</div>
            </div>
        </div>
    `;

    audioEqBindGraph();
    audioEqBindEditor();
}

function audioEqUpdateEditorValues() {
    const band = audioEqState.bands[audioEqState.selectedIndex];
    if (!band) return;
    const title = document.querySelector('.audio-eq-editor-title');
    const freq = document.getElementById('audioEqFreqInput');
    const gain = document.getElementById('audioEqGainInput');
    const q = document.getElementById('audioEqQInput');
    const type = document.getElementById('audioEqTypeSelect');
    if (title) title.textContent = `控制点 ${audioEqState.selectedIndex + 1}`;
    if (freq) freq.value = String(band.freq);
    if (gain) gain.value = String(band.gain);
    if (q) q.value = String(band.q);
    if (type) type.value = band.type;
}

function audioEqUpdateGraphDom() {
    const curve = document.getElementById('audioEqCurveLine');
    if (curve) curve.setAttribute('points', audioEqCurvePoints());
    document.querySelectorAll('.audio-eq-point').forEach((point) => {
        const index = Number(point.dataset.eqIndex);
        const band = audioEqState.bands[index];
        if (!band) return;
        point.style.left = `${audioEqFreqToX(band.freq)}%`;
        point.style.top = `${audioEqGainToY(band.gain)}%`;
        point.classList.toggle('active', index === audioEqState.selectedIndex);
        point.setAttribute('aria-pressed', index === audioEqState.selectedIndex ? 'true' : 'false');
        point.setAttribute('aria-label', `控制点 ${index + 1}，${audioEqFormatFreq(band.freq)}，${band.gain} dB，Q ${band.q}，${audioEqTypeLabel(band.type)}`);
        const bubble = point.querySelector('em');
        if (bubble) bubble.textContent = `${audioEqFormatFreq(band.freq)} · ${band.gain} dB · Q ${band.q} · ${audioEqTypeLabel(band.type)}`;
    });
    audioEqUpdateEditorValues();
    audioEqUpdateSettingsSummary();
}

function audioEqSetBandFromPointer(index, clientX, clientY) {
    const plot = document.getElementById('audioEqPlot');
    const band = audioEqState.bands[index];
    if (!plot || !band) return;
    const rect = plot.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 100;
    const y = ((clientY - rect.top) / rect.height) * 100;
    band.freq = audioEqXToFreq(x);
    band.gain = audioEqYToGain(y);
    audioEqState.dirty = true;
    audioEqUpdateGraphDom();
}

function audioEqBindGraph() {
    const container = document.getElementById('audioEqBands');
    if (!container) return;
    container.querySelectorAll('.audio-eq-point').forEach((point) => {
        point.addEventListener('focus', (e) => {
            const index = Number(e.currentTarget.dataset.eqIndex);
            if (!audioEqState.bands[index]) return;
            audioEqState.selectedIndex = index;
            audioEqUpdateGraphDom();
        });
        point.addEventListener('pointerdown', (e) => {
            const index = Number(e.currentTarget.dataset.eqIndex);
            if (!audioEqState.bands[index]) return;
            e.preventDefault();
            audioEqState.selectedIndex = index;
            audioEqState.draggingIndex = index;
            e.currentTarget.setPointerCapture?.(e.pointerId);
            audioEqSetBandFromPointer(index, e.clientX, e.clientY);
        });
    });
}

document.addEventListener('pointermove', (e) => {
    if (audioEqState.draggingIndex === null) return;
    audioEqSetBandFromPointer(audioEqState.draggingIndex, e.clientX, e.clientY);
});

document.addEventListener('pointerup', () => {
    audioEqState.draggingIndex = null;
});

function audioEqBindEditor() {
    const freq = document.getElementById('audioEqFreqInput');
    const gain = document.getElementById('audioEqGainInput');
    const q = document.getElementById('audioEqQInput');
    const type = document.getElementById('audioEqTypeSelect');
    const apply = () => {
        const band = audioEqState.bands[audioEqState.selectedIndex];
        if (!band) return;
        if (freq) band.freq = audioEqClampFreq(freq.value);
        if (gain) band.gain = audioEqClampGain(gain.value);
        if (q) band.q = audioEqClampQ(q.value);
        if (type) band.type = audioEqNormalizeType(type.value);
        audioEqState.dirty = true;
        audioEqUpdateGraphDom();
    };
    [freq, gain, q, type].forEach((el) => {
        if (el) el.addEventListener('input', apply);
    });
}

function audioEqBindPage() {
    const global = document.getElementById('audioEqGlobalGain');
    if (global && !global.dataset.bound) {
        global.dataset.bound = '1';
        global.addEventListener('input', (e) => {
            audioEqState.globalGain = audioEqClampGain(e.target.value);
            audioEqState.dirty = true;
            const value = document.getElementById('audioEqGlobalValue');
            if (value) value.textContent = `${audioEqState.globalGain} dB`;
            audioEqUpdateSettingsSummary();
        });
    }
}

function audioEqOpenPage() {
    audioEqBindPage();
    audioEqRender();
    if (audioEqState.dirty) {
        audioEqSetStatus('当前有未保存的 EQ 修改');
    } else {
        audioEqReload(false);
    }
}

function audioEqReload(silent = false, force = false) {
    const page = document.getElementById('page-audio-eq');
    if (silent && (!page || !page.classList.contains('active'))) return;
    if (audioEqState.dirty && !force) {
        if (silent) return;
        confirmModal('重新读取会覆盖当前未保存的 EQ 修改，是否继续？', () => audioEqReload(false, true), '放弃未保存修改');
        return;
    }
    if (!audioRouteDeviceReady()) {
        audioEqSetStatus('下位机未连接，无法读取 EQ');
        if (!silent) showToast('下位机未连接，无法读取 EQ', 2500);
        return;
    }

    audioEqSetStatus('正在读取下位机保存的 EQ...');
    sendAudioCommand('getEq', null).then((resp) => {
        audioEqApplyDeviceData(resp?.data);
        audioEqRender();
        audioEqSetStatus('已读取下位机保存的 EQ');
    }).catch((err) => {
        console.warn('[AudioEQ] getEq failed:', err);
        audioEqSetStatus('读取 EQ 失败，请检查下位机状态');
        if (!silent) showToast('读取 EQ 失败', 2500);
    });
}

function audioEqBuildPayload() {
    return {
        persist: true,
        global_gain_x10: Math.round(audioEqState.globalGain * 10),
        bands: audioEqState.bands.map((band, index) => ({
            index,
            freq: audioEqClampFreq(band.freq),
            gain_x10: Math.round(audioEqClampGain(band.gain) * 10),
            q_x100: Math.round(audioEqClampQ(band.q) * 100),
            type: audioEqNormalizeType(band.type)
        }))
    };
}

function audioEqSave() {
    if (!audioRouteDeviceReady()) {
        showToast('下位机未连接，无法保存 EQ', 2500);
        return;
    }
    audioEqSetStatus('正在保存 EQ 到下位机...');
    sendAudioCommand('setEq', audioEqBuildPayload()).then((resp) => {
        audioEqApplyDeviceData(resp?.data);
        audioEqRender();
        audioEqSetStatus('EQ 已保存，下次启动会自动加载');
        showToast('EQ 已保存到下位机');
    }).catch((err) => {
        console.warn('[AudioEQ] setEq failed:', err);
        audioEqSetStatus('保存 EQ 失败，请检查参数或下位机状态');
        showToast('保存 EQ 失败', 2500);
    });
}

function audioEqReset() {
    audioEqState.globalGain = 0;
    audioEqState.bands = audioEqState.bands.map((band, index) => ({
        index,
        freq: AUDIO_EQ_DEFAULT_FREQS[index] || band.freq || 1000,
        gain: 0,
        q: 0.7,
        type: 'peak'
    }));
    audioEqState.selectedIndex = 0;
    audioEqState.dirty = true;
    audioEqRender();
    audioEqSetStatus('已恢复平直参数，尚未保存');
    audioEqUpdateSettingsSummary();
}

function initAudioRouteSettings() {
    audioRouteRenderSettings();

    const sourceSelect = document.getElementById('audioSourceSelect');
    const micSelect = document.getElementById('audioMicRouteSelect');

    if (sourceSelect && !sourceSelect.dataset.bound) {
        sourceSelect.dataset.bound = '1';
        sourceSelect.addEventListener('change', async (e) => {
            audioRouteState.audioSource = audioSourceNormalize(e.target.value, AUDIO_SOURCE_HDMI);
            audioRouteRenderSettings();
            await audioRouteApplyToDevice(false);
        });
    }

    if (micSelect && !micSelect.dataset.bound) {
        micSelect.dataset.bound = '1';
        micSelect.addEventListener('change', async (e) => {
            audioRouteState.micInput = audioMicNormalize(e.target.value, AUDIO_MIC_ONBOARD);
            audioRouteRenderSettings();
            await audioMicApplyToDevice(false);
        });
    }

    audioRouteSyncFromDevice();
}

function aiIsMessageVisible(info) {
    if (!info) return false;
    if (!aiState.sessionId) return true;
    if (info.guide) return false;
    return info.sessionID === aiState.sessionId;
}

function aiBuildWelcomeHelpText() {
    return [
        '欢迎使用 PanelManager AI。你可以直接说目标，我会尽量自己迭代到可编译。',
        '',
        '- 编译项目：`请编译项目` 或 `请用最小化 CLI 编译 Windows 版本`',
        '- 新增功能：`请为 xxx 增加功能，完成后自检并继续修到编译通过`',
        '- 修改 Bug：`请排查 xxx 问题，只修首个错误并持续重试`',
        '- 页面调试：会优先安装并使用 `agent-browser`',
        '- 编译结果：当前工程的 `.sandbox/artifacts/build-cli`',
        '- 发布结果：当前工程的 `.sandbox/artifacts/publish/windows-win-x64`',
        '- 源码包：发布目录中的 `PanelManager-source-*.zip`',
        '- 替换旧版本：先验证新目录，再备份旧版本后替换，不直接覆盖当前运行目录'
    ].join('\n');
}

function aiInsertWelcomeHelpIfNeeded() {
    if (ai2LsGet(AI2_HELP_SEEN_KEY) === '1') return;
    if (aiState.sessionId) return;
    if (aiState.messageOrder.length > 0) return;

    const id = `guide-${Date.now()}`;
    aiState.optimisticText.set(id, aiBuildWelcomeHelpText());
    aiUpsertMessageInfo({
        id,
        sessionID: '__guide__',
        role: 'system',
        guide: true,
        time: { created: Date.now() }
    });
    ai2LsSet(AI2_HELP_SEEN_KEY, '1');
}

function ai2InitHiddenModels() {
    const raw = ai2LsGet(AI2_HIDDEN_MODELS_KEY);
    if (!raw) {
        ai2ModalState.hidden = new Set();
        return;
    }
    try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
            ai2ModalState.hidden = new Set(arr.filter((x) => typeof x === 'string'));
            return;
        }
    } catch { }
    ai2ModalState.hidden = new Set();
}

function ai2SaveHiddenModels() {
    ai2LsSet(AI2_HIDDEN_MODELS_KEY, JSON.stringify(Array.from(ai2ModalState.hidden)));
}

function ai2ProviderBadge(id) {
    if (!id) return '●';
    return String(id).slice(0, 1).toUpperCase();
}

function ai2ModelMatches(m, q) {
    if (!q) return true;
    const s = q.toLowerCase();
    const hay = `${m.key} ${m.name || ''} ${m.providerName || ''} ${m.family || ''}`.toLowerCase();
    return hay.includes(s);
}

function ai2IsFreeModel(m) {
    return m?.providerID === 'opencode' && (!m?.cost || !m.cost.input || m.cost.input === 0);
}

function ai2FindModel(key) {
    if (!key || !aiState.modelCatalog) return null;
    return aiState.modelCatalog.flat.find((x) => x.key === key) || null;
}

function ai2BuildModelCatalog(configProvidersResp, connectedSet, hiddenSet) {
    const providersRaw = Array.isArray(configProvidersResp?.providers) ? configProvidersResp.providers : [];
    const connected = connectedSet || new Set();
    const hidden = hiddenSet || new Set();

    const providers = providersRaw
        .map((p) => {
            const providerID = p?.id || p?.providerID || p?.name;
            const providerName = p?.name || providerID;
            const modelsObj = (p?.models && typeof p.models === 'object') ? p.models : {};
            const models = Object.entries(modelsObj)
                .map(([k, m]) => {
                    const modelID = (m && (m.id || m.modelID)) ? (m.id || m.modelID) : k;
                    const key = `${providerID}/${modelID}`;
                    if (hidden.has(key)) {
                        return null;
                    }
                    return {
                        key,
                        providerID,
                        providerName,
                        modelID,
                        name: (m && m.name) ? m.name : modelID,
                        family: m?.family,
                        capabilities: m?.capabilities,
                        modalities: m?.modalities,
                        reasoning: m?.reasoning,
                        limit: m?.limit,
                        cost: m?.cost,
                        latest: !!m?.latest,
                        variants: (m?.variants && typeof m.variants === 'object') ? m.variants : {}
                    };
                })
                .filter(Boolean);

            models.sort((a, b) => {
                const c = (a.name || '').localeCompare(b.name || '');
                if (c !== 0) return c;
                return (a.modelID || '').localeCompare(b.modelID || '');
            });

            return {
                id: providerID,
                name: providerName,
                connected: connected.has(providerID),
                models
            };
        })
        .filter((p) => p.id && p.models.length > 0);

    providers.sort((a, b) => {
        const ai = AI2_POPULAR_PROVIDERS.indexOf(a.id);
        const bi = AI2_POPULAR_PROVIDERS.indexOf(b.id);
        if (ai >= 0 && bi >= 0) return ai - bi;
        if (ai >= 0) return -1;
        if (bi >= 0) return 1;
        return a.id.localeCompare(b.id);
    });

    return {
        providers,
        flat: providers.flatMap((p) => p.models)
    };
}

function ai2Call(cmd, data = {}, timeout = 30000) {
    return new Promise((resolve) => {
        sendMessageWithTimeout('system', cmd, data, timeout, (resp) => {
            resolve(resp || { code: -1, msg: 'No response' });
        });
    });
}

let aiMessageIdLastTs = 0;
let aiMessageIdCounter = 0;

function aiRandomBase62(len) {
    const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    const bytes = new Uint8Array(Math.max(0, len | 0));
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
        window.crypto.getRandomValues(bytes);
    } else {
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = Math.floor(Math.random() * 256);
        }
    }

    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        out += chars[bytes[i] % 62];
    }
    return out;
}

function aiCreateOpenCodeMessageId() {
    const now = Date.now();
    if (now !== aiMessageIdLastTs) {
        aiMessageIdLastTs = now;
        aiMessageIdCounter = 0;
    }
    aiMessageIdCounter += 1;

    const n = (BigInt(now) * 0x1000n) + BigInt(aiMessageIdCounter);
    const bytes = new Uint8Array(6);
    for (let i = 0; i < 6; i++) {
        const shift = BigInt(40 - (8 * i));
        bytes[i] = Number((n >> shift) & 0xffn);
    }

    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, '0');
    }

    return `msg_${hex}${aiRandomBase62(14)}`;
}

async function aiHydrateSessionMessagesOnce() {
    const sid = aiState.sessionId;
    if (!sid || aiState.hydrateInFlight) {
        return;
    }

    const partMapEqual = (a, b) => {
        if (!a && !b) return true;
        if (!a || !b) return false;
        if (a.size !== b.size) return false;
        for (const [id, part] of b.entries()) {
            if (!a.has(id)) return false;
            const prev = a.get(id);
            if (JSON.stringify(prev) !== JSON.stringify(part)) return false;
        }
        return true;
    };

    aiState.hydrateInFlight = true;
    try {
        const resp = await ai2Call('aiSessionMessages', { sessionId: sid, limit: 200 }, 30000);
        if (resp.code !== 0 || !Array.isArray(resp.data)) {
            return;
        }

        let changed = false;
        const hydratedIds = new Set();
        resp.data.forEach((item) => {
            const info = item?.info;
            if (info?.id && info?.sessionID === sid && info?.role) {
                hydratedIds.add(info.id);
                const existed = aiState.messageInfo.has(info.id);
                aiState.messageInfo.set(info.id, info);
                if (!existed) {
                    let idx = aiState.messageOrder.findIndex((x) => x.localeCompare(info.id) > 0);
                    if (idx < 0) idx = aiState.messageOrder.length;
                    aiState.messageOrder.splice(idx, 0, info.id);
                }
                if (!aiState.selectedMessageId) {
                    aiState.selectedMessageId = info.id;
                }
                changed = true;
            }

            const parts = Array.isArray(item?.parts) ? item.parts : [];
            if (info?.id && info?.sessionID === sid) {
                const nextMap = new Map();
                parts.forEach((part) => {
                    if (!part?.id || !part?.messageID || part?.sessionID !== sid) {
                        return;
                    }
                    nextMap.set(part.id, part);
                });

                const prevMap = aiState.messageParts.get(info.id);
                if (!partMapEqual(prevMap, nextMap)) {
                    aiState.messageParts.set(info.id, nextMap);
                    changed = true;
                }
            }
        });

        aiState.messageParts.forEach((_, messageID) => {
            const info = aiState.messageInfo.get(messageID);
            if (!info || info.sessionID !== sid) return;
            if (hydratedIds.has(messageID)) return;
            // 本轮服务端列表未包含该消息，保留现状（通常是本地 optimistic 或尚未持久化）
        });

        if (changed) {
            aiRenderMessageList();
            aiRenderDetailsPanel();
        }
    } finally {
        aiState.hydrateInFlight = false;
    }
}

function aiStartHydratePolling() {
    if (aiState.hydrateTimer) {
        return;
    }
    void aiHydrateSessionMessagesOnce();
    aiState.hydrateTimer = setInterval(() => {
        if (!aiState.awaitingReply) {
            aiStopHydratePolling();
            return;
        }
        void aiHydrateSessionMessagesOnce();
    }, 1800);
}

function aiStopHydratePolling() {
    if (!aiState.hydrateTimer) {
        return;
    }
    clearInterval(aiState.hydrateTimer);
    aiState.hydrateTimer = null;
}

function aiSetBusy(show, text = '', loading = show) {
    if (show) {
        aiState.statusHint = text || '处理中...';
        aiState.statusHintLoading = !!loading;
        aiTouchRuntimeStatus(text || '处理中...');
    } else {
        aiState.statusHint = '';
        aiState.statusHintLoading = false;
    }
    updateAiStatusUi();

    const busy = document.getElementById('ai2Busy');
    const txt = document.getElementById('ai2BusyText');
    if (busy) {
        // 进度提示统一移动到头部状态栏，这里保留节点但不再显示遮罩
        busy.style.display = 'none';
    }
    if (txt && text) {
        txt.textContent = text;
    }
}

function aiUpdateSendButton() {
    const btn = document.getElementById('aiSendBtn');
    if (!btn) return;

    btn.classList.toggle('is-loading', !!aiState.abortInFlight);

    if (aiState.abortInFlight) {
        btn.textContent = '⟳';
        btn.setAttribute('aria-label', '停止中');
        btn.title = '停止中...';
        btn.disabled = true;
        return;
    }

    if (aiState.awaitingReply) {
        btn.textContent = '■';
        btn.setAttribute('aria-label', '停止');
        btn.title = '停止生成';
        btn.disabled = aiState.sendInFlight;
        return;
    }

    btn.textContent = '➤';
    btn.setAttribute('aria-label', '发送');
    btn.title = '发送';
    btn.disabled = aiState.sendInFlight;
}

function aiSetAwaitingReply(v) {
    aiState.awaitingReply = !!v;
    aiUpdateSendButton();

    if (aiState.awaitingTimer) {
        clearTimeout(aiState.awaitingTimer);
        aiState.awaitingTimer = null;
    }

    if (aiState.awaitingReply) {
        aiStartHydratePolling();
        aiState.awaitingTimer = setTimeout(() => {
            aiState.awaitingReply = false;
            aiState.awaitingTimer = null;
            aiStopHydratePolling();
            void aiHydrateSessionMessagesOnce();
            aiUpdateSendButton();
        }, 90000);
    } else {
        aiStopHydratePolling();
        void aiHydrateSessionMessagesOnce();
    }
}

async function aiAbortCurrentSession() {
    const sid = aiState.sessionId;
    if (!sid || aiState.abortInFlight) {
        return;
    }

    aiState.abortInFlight = true;
    aiUpdateSendButton();
    try {
        const resp = await ai2Call('aiAbortSession', { sessionId: sid }, 15000);
        if (resp.code !== 0) {
            showToast(`停止失败: ${resp.msg || '未知错误'}`, 3000);
            return;
        }
        aiState.sessionStatusType = 'idle';
        aiSetAwaitingReply(false);
    } finally {
        aiState.abortInFlight = false;
        aiUpdateSendButton();
    }
}

function aiHandleProgressEvent(p) {
    const stage = p?.stage || '';
    const text = p?.text || 'AI 初始化中...';
    aiTouchRuntimeStatus(text);

    if (stage === 'done') {
        aiSetBusy(false, '');
        aiHideInitModalIfAny();
        return;
    }

    aiSetBusy(true, text, stage !== 'error');

    const installStage = stage === 'download' || stage === 'verify' || stage === 'extract';
    if (installStage && !aiState.initModalShown) {
        aiShowInitModal();
    }

    if (aiState.initModalShown) {
        aiUpdateInitProgress(p);
    }

    if (stage === 'error') {
        const err = p?.error || p?.text || 'AI 初始化失败';
        aiSetBusy(true, `初始化失败: ${err}`, false);
        if (aiState.initModalShown) {
            aiUpdateInitProgress(p);
        }
        showToast(err, 15000);
    }
}

function aiHandleStatusEvent(status) {
    aiState.status = status || { running: false, url: '', version: '' };
    updateAiStatusUi();

    if (aiState.status.running) {
        aiSetBusy(false, '');
        aiHideInitModalIfAny();
        aiLoadConfigOnce();
        aiRefreshModelsList();
        if (aiState.sessionId) {
            aiSyncPendingPrompts();
            aiUpdatePromptDock();
        }
        aiMaybePromptModelConfig();
        return;
    }

    aiSetAwaitingReply(false);
    aiSetBusy(true, 'AI 未连接', false);
}

function aiUpdateModelTriggerLabel() {
    const main = document.getElementById('aiModelTriggerMain');
    const sub = document.getElementById('aiModelTriggerSub');
    const icon = document.getElementById('aiModelTriggerIcon');
    if (!main || !sub || !icon) return;

    const selectedKey = aiState.model;
    const defaultKey = aiState.defaultModel;
    const key = selectedKey || defaultKey || '';
    const model = ai2FindModel(key);

    if (!key) {
        main.textContent = '选择模型';
        sub.textContent = '自动/默认';
        icon.textContent = '●';
        return;
    }

    main.textContent = model ? (model.name || key) : key;
    sub.textContent = selectedKey ? key : `默认: ${key}`;
    icon.textContent = ai2ProviderBadge(model?.providerID || key.split('/')[0]);
}

function aiRefreshVariantOptions() {
    if (aiState.variant) {
        aiState.variant = '';
        ai2LsDel(AI2_VARIANT_KEY);
    }
}

function aiRefreshAttachmentUi() {
    const wrap = document.getElementById('ai2Attachments');
    const list = document.getElementById('ai2AttachmentList');
    if (!wrap || !list) return;

    list.innerHTML = '';
    if (!Array.isArray(aiState.attachments) || aiState.attachments.length === 0) {
        wrap.style.display = 'none';
        return;
    }

    wrap.style.display = '';
    aiState.attachments.forEach((path) => {
        const chip = document.createElement('div');
        chip.className = 'ai2-attachment-chip';
        chip.innerHTML = `<span>${escapeHtml(path)}</span>`;

        const btn = document.createElement('button');
        btn.className = 'ai2-attachment-remove';
        btn.type = 'button';
        btn.textContent = '×';
        btn.setAttribute('aria-label', '移除附件');
        btn.onclick = () => {
            aiState.attachments = aiState.attachments.filter((x) => x !== path);
            aiRefreshAttachmentUi();
        };

        chip.appendChild(btn);
        list.appendChild(chip);
    });
}

function aiGetPrimaryText(messageID, role) {
    const map = aiState.messageParts.get(messageID);
    const parts = map ? Array.from(map.values()) : [];
    const hasFilePart = parts.some((p) => p && p.type === 'file');
    const texts = parts.filter((p) => p && p.type === 'text' && typeof p.text === 'string');
    const filtered = (role === 'assistant') ? texts.filter((p) => !p.ignored) : texts;
    const userVisible = texts.filter((p) => !p.synthetic && !p.ignored);

    const normalize = (arr) => {
        const values = arr
            .map((p) => String(p.text || '').trim())
            .filter((t) => t.length > 0);
        if (values.length === 0) return '';

        const uniq = [];
        const seen = new Set();
        values.forEach((t) => {
            if (seen.has(t)) return;
            seen.add(t);
            uniq.push(t);
        });

        if (role === 'assistant' && uniq.length > 1) {
            let longest = uniq[0] || '';
            uniq.forEach((t) => {
                if (t.length > longest.length) longest = t;
            });
            const related = uniq.filter((t) => longest.includes(t) || t.includes(longest)).length;
            if (related >= Math.ceil(uniq.length * 0.6)) {
                return longest;
            }
        }

        return uniq.join('\n');
    };

    if (role === 'user' && userVisible.length > 0) {
        const primary = normalize(userVisible);
        if (primary) return primary;
    }

    if (role === 'user' && hasFilePart) {
        const optimistic = aiState.optimisticText.get(messageID);
        return optimistic ? String(optimistic) : '';
    }

    if (filtered.length > 0) {
        const primary = normalize(filtered);
        if (primary) return primary;
    }

    // 某些 Provider 会把最终文本标成 ignored；若前面没有可显示文本，这里回退展示。
    if (role === 'assistant' && texts.length > 0) {
        const fallback = normalize(texts);
        if (fallback) return fallback;
    }

    const optimistic = aiState.optimisticText.get(messageID);
    return optimistic ? String(optimistic) : '';
}

function aiGetFileLabels(messageID) {
    const map = aiState.messageParts.get(messageID);
    if (!map) return [];

    const labels = [];
    const seen = new Set();
    Array.from(map.values()).forEach((p) => {
        if (!p || p.type !== 'file') return;

        let label = '';
        if (typeof p.filename === 'string' && p.filename.trim()) {
            label = p.filename.trim();
        } else if (typeof p.url === 'string' && p.url.startsWith('file://')) {
            try {
                const raw = decodeURIComponent(p.url.slice('file://'.length));
                label = raw.replace(/^\//, '');
            } catch {
                label = p.url.slice('file://'.length).replace(/^\//, '');
            }
        }

        if (!label || seen.has(label)) return;
        seen.add(label);
        labels.push(label);
    });

    return labels;
}

function aiGetNonTextParts(messageID) {
    const map = aiState.messageParts.get(messageID);
    if (!map) return [];
    return Array.from(map.values()).filter((p) => p && p.type && p.type !== 'text');
}

function aiFindLatestReasoningText(messageID) {
    const parts = aiGetNonTextParts(messageID);
    if (!parts.length) return '';

    const pickText = (value) => {
        if (typeof value !== 'string') return '';
        const text = value.trim();
        return text;
    };

    const collectByKey = (value, matcher) => {
        const visited = new Set();
        const walk = (current) => {
            if (!current || typeof current !== 'object') return '';
            if (visited.has(current)) return '';
            visited.add(current);

            if (Array.isArray(current)) {
                for (let i = current.length - 1; i >= 0; i--) {
                    const found = walk(current[i]);
                    if (found) return found;
                }
                return '';
            }

            const keys = Object.keys(current);
            for (let i = keys.length - 1; i >= 0; i--) {
                const key = keys[i];
                const next = current[key];
                if (matcher.test(key)) {
                    const direct = pickText(next);
                    if (direct) return direct;
                    const nested = walk(next);
                    if (nested) return nested;
                }
            }

            for (let i = keys.length - 1; i >= 0; i--) {
                const nested = walk(current[keys[i]]);
                if (nested) return nested;
            }

            return '';
        };

        return walk(value);
    };

    const partTypeMatchers = [/(?:reason|think|analysis|thought|summary)/i, /.*/];
    const keyMatchers = [/(?:reason|think|analysis|thought|summary)/i, /(?:text|content|message|output|body)/i];

    for (let i = parts.length - 1; i >= 0; i--) {
        const part = parts[i];
        if (!part || typeof part !== 'object') continue;

        for (const partMatcher of partTypeMatchers) {
            const type = String(part.type || '');
            if (!partMatcher.test(type)) continue;

            for (const keyMatcher of keyMatchers) {
                const found = collectByKey(part, keyMatcher);
                if (found) return found;
            }
        }
    }

    return '';
}

function aiIsLatestAssistantMessage(messageID) {
    for (let i = aiState.messageOrder.length - 1; i >= 0; i--) {
        const id = aiState.messageOrder[i];
        const info = aiState.messageInfo.get(id);
        if (!info) continue;
        if (aiState.sessionId && info.sessionID !== aiState.sessionId) continue;
        if (info.role === 'assistant') {
            return id === messageID;
        }
    }
    return false;
}

function aiPartSummary(part) {
    const t = part?.type;
    if (t === 'tool') {
        const name = part.tool || 'tool';
        const status = part.state?.status || 'unknown';
        return `${name} · ${status}`;
    }
    if (t === 'step-start') return 'step-start';
    if (t === 'step-finish') return 'step-finish';
    if (t === 'patch') return `patch · ${part.files ? part.files.length : 0} files`;
    if (t === 'snapshot') return 'snapshot';
    if (t === 'file') return part.filename ? `file · ${part.filename}` : 'file';
    return String(t || 'part');
}

function aiRenderMarkdownText(text) {
    const source = String(text || '');
    if (!source.trim()) return '';

    let html = parseMarkdown(escapeHtml(source));
    html = html.replace(/<a href="([^"]*)" target="_blank">/g, (_m, href) => {
        const safe = /^(https?:\/\/|mailto:)/i.test(String(href || '')) ? href : '#';
        return `<a href="${safe}" target="_blank" rel="noopener noreferrer">`;
    });
    html = html.replace(/<img\s+[^>]*>/gi, '');
    return `<div class="ai2-msg-md">${html}</div>`;
}

function aiRenderMessageList() {
    const container = document.getElementById('ai2Messages');
    if (!container) return;

    container.innerHTML = '';
    aiState.messageOrder.forEach((id) => {
        const info = aiState.messageInfo.get(id);
        if (!info) return;
        if (aiState.sessionId && info.sessionID !== aiState.sessionId) return;

        const role = info.role || 'assistant';
        const row = document.createElement('div');
        row.className = `ai2-msg ${role}` + ((aiState.selectedMessageId === id) ? ' selected' : '');

        const meta = document.createElement('div');
        meta.className = 'ai2-msg-meta';
        const roleLabel = role === 'user' ? '你' : (role === 'system' ? '系统' : 'OpenCode');
        const stateLabel = info?.error ? '失败' : ((!!info?.finish || !!info?.time?.completed) ? '完成' : '进行中');
        meta.innerHTML = `<span class="ai2-msg-role">${escapeHtml(roleLabel)}</span><span class="ai2-msg-state">${escapeHtml(stateLabel)}</span>`;
        row.appendChild(meta);

        const bubble = document.createElement('div');
        bubble.className = 'ai2-msg-bubble';
        const text = aiGetPrimaryText(id, role);
        if (text) {
            bubble.innerHTML = aiRenderMarkdownText(text);
        } else if (role === 'assistant') {
            const done = !!info?.error || !!info?.finish || !!info?.time?.completed;
            const waitingLatest = aiState.awaitingReply && aiIsLatestAssistantMessage(id);
            const toolActivity = waitingLatest ? aiFindLatestToolActivity(id) : null;
            bubble.innerHTML = (done && !waitingLatest)
                ? '<span class="text-muted">已完成（暂无文本输出）</span>'
                : `<span class="text-muted">${escapeHtml(toolActivity ? `正在执行：${toolActivity.label}` : '思考中...')}</span>`;
        } else {
            bubble.innerHTML = '<span class="text-muted">(无文本)</span>';
        }
        bubble.onclick = () => {
            const selection = window.getSelection ? window.getSelection() : null;
            if (selection && String(selection).trim()) {
                return;
            }
            aiState.selectedMessageId = id;
            aiRenderMessageList();
            aiRenderDetailsPanel();
        };

        row.appendChild(bubble);

        const fileLabels = (role === 'user') ? aiGetFileLabels(id) : [];
        if (fileLabels.length > 0) {
            const files = document.createElement('div');
            files.className = 'ai2-msg-files';
            fileLabels.forEach((label) => {
                const chip = document.createElement('div');
                chip.className = 'ai2-msg-file-chip';
                chip.textContent = label;
                files.appendChild(chip);
            });
            row.appendChild(files);
        }

        container.appendChild(row);
    });

    container.scrollTop = container.scrollHeight;
    updateAiStatusUi();
}

function aiRenderDetailsPanel() {
    const panel = document.getElementById('ai2Details');
    if (!panel) return;

    panel.style.minHeight = '0';
    panel.style.overflowY = 'auto';
    panel.style.overflowX = 'hidden';
    panel.style.webkitOverflowScrolling = 'touch';

    const id = aiState.selectedMessageId;
    if (!id) {
        panel.innerHTML = '<div class="ai2-empty">点击一条消息查看最新推理内容</div>';
        return;
    }

    const reasoning = aiFindLatestReasoningText(id);
    if (!reasoning) {
        panel.innerHTML = '<div class="ai2-empty">该消息暂无可显示的推理内容</div>';
        return;
    }

    panel.innerHTML = `<div class="ai2-detail-reasoning">${escapeHtml(reasoning)}</div>`;
}

function aiUpsertMessageInfo(info) {
    const id = info?.id;
    const sessionID = info?.sessionID;
    const role = info?.role;
    if (!id || !sessionID || !role) return;
    if (aiState.sessionId && sessionID !== aiState.sessionId) return;

    const existed = aiState.messageInfo.has(id);
    aiState.messageInfo.set(id, info);

    if (!existed) {
        const order = aiState.messageOrder;
        let idx = order.findIndex((x) => x.localeCompare(id) > 0);
        if (idx < 0) idx = order.length;
        order.splice(idx, 0, id);
    }

    if (!aiState.selectedMessageId) {
        aiState.selectedMessageId = id;
    }

    aiRenderMessageList();
    aiRenderDetailsPanel();
}

function aiUpsertPart(part) {
    const messageID = part?.messageID;
    const sessionID = part?.sessionID;
    const partID = part?.id;
    if (!messageID || !sessionID || !partID) return;
    if (aiState.sessionId && sessionID !== aiState.sessionId) return;

    if (!aiState.messageInfo.has(messageID)) {
        aiUpsertMessageInfo({ id: messageID, role: 'assistant', sessionID, time: { created: Date.now() } });
    }

    let map = aiState.messageParts.get(messageID);
    if (!map) {
        map = new Map();
        aiState.messageParts.set(messageID, map);
    }
    map.set(partID, part);
    aiRenderMessageList();
    if (!aiState.selectedMessageId || aiState.selectedMessageId === messageID) {
        aiState.selectedMessageId = messageID;
    }
    aiRenderDetailsPanel();
}

function aiRemovePart(messageID, partID) {
    const map = aiState.messageParts.get(messageID);
    if (!map) return;
    map.delete(partID);
    aiRenderMessageList();
    aiRenderDetailsPanel();
}

function aiRemoveMessage(messageID) {
    aiState.messageInfo.delete(messageID);
    aiState.messageParts.delete(messageID);
    aiState.optimisticText.delete(messageID);
    aiState.messageOrder = aiState.messageOrder.filter((x) => x !== messageID);
    if (aiState.selectedMessageId === messageID) {
        aiState.selectedMessageId = aiState.messageOrder[aiState.messageOrder.length - 1] || null;
    }
    aiRenderMessageList();
    aiRenderDetailsPanel();
}

function aiUnwrapServerEvent(evt) {
    const payload = evt?.payload;
    if (payload && typeof payload === 'object' && typeof payload.type === 'string') {
        return payload;
    }
    return evt;
}

function aiHandleServerEvent(evt) {
    const event = aiUnwrapServerEvent(evt);
    const type = event?.type;
    if (!type || typeof type !== 'string') return;
    const runtimeText = (type === 'session.status')
        ? `会话状态：${event?.properties?.status?.type || 'unknown'}`
        : (type === 'message.part.updated')
            ? aiPartSummary(event?.properties?.part)
            : type;
    aiTouchRuntimeStatus(runtimeText);

    if (type === 'permission.asked') {
        aiEnqueuePermission(event);
        return;
    }
    if (type === 'question.asked') {
        aiEnqueueQuestion(event);
        return;
    }
    if (type === 'permission.replied') {
        const props = event?.properties;
        if (props?.sessionID && aiState.sessionId && props.sessionID !== aiState.sessionId) return;
        if (props?.requestID) aiDismissPermission(props.requestID);
        return;
    }
    if (type === 'question.replied' || type === 'question.rejected') {
        const props = event?.properties;
        if (props?.sessionID && aiState.sessionId && props.sessionID !== aiState.sessionId) return;
        if (props?.requestID) aiDismissQuestion(props.requestID);
        return;
    }

    if (type === 'message.updated') {
        aiUpsertMessageInfo(event?.properties?.info);
        return;
    }
    if (type === 'message.part.updated') {
        aiUpsertPart(event?.properties?.part);
        return;
    }
    if (type === 'message.part.removed') {
        const props = event?.properties;
        if (props?.messageID && props?.partID) aiRemovePart(props.messageID, props.partID);
        return;
    }
    if (type === 'message.removed') {
        const props = event?.properties;
        if (props?.messageID) aiRemoveMessage(props.messageID);
        return;
    }
    if (type === 'session.error') {
        const sid = event?.properties?.sessionID;
        if (sid && aiState.sessionId && sid !== aiState.sessionId) return;
        const err = event?.properties?.error;
        aiState.sessionStatusType = 'idle';
        aiSetAwaitingReply(false);
        if (err) showToast(typeof err === 'string' ? err : JSON.stringify(err), 3000);
        return;
    }
    if (type === 'session.idle') {
        const sid = event?.properties?.sessionID;
        if (sid && aiState.sessionId && sid !== aiState.sessionId) return;
        aiState.sessionStatusType = 'idle';
        aiSetAwaitingReply(false);
        return;
    }
    if (type === 'session.status') {
        const sid = event?.properties?.sessionID;
        if (sid && aiState.sessionId && sid !== aiState.sessionId) return;
        const statusType = event?.properties?.status?.type;
        aiState.sessionStatusType = typeof statusType === 'string' ? statusType : 'idle';
        if (statusType === 'idle') {
            aiSetAwaitingReply(false);
            return;
        }
        if (statusType === 'busy' || statusType === 'retry') {
            aiSetAwaitingReply(true);
        }
    }
}

function aiSyncPendingPrompts() {
    if (aiState.pendingSynced) return;
    if (!aiState.status?.running) return;
    if (!aiState.sessionId) return;
    aiState.pendingSynced = true;

    sendMessage('system', 'aiPermissionList', {}, (resp) => {
        if (resp.code === 0 && Array.isArray(resp.data)) {
            resp.data.forEach((p) => aiEnqueuePermission({ type: 'permission.asked', properties: p }));
        }
    });
    sendMessage('system', 'aiQuestionList', {}, (resp) => {
        if (resp.code === 0 && Array.isArray(resp.data)) {
            resp.data.forEach((q) => aiEnqueueQuestion({ type: 'question.asked', properties: q }));
        }
    });
}

function aiEnqueuePermission(evt) {
    const req = evt?.properties || evt || null;
    const id = req?.id;
    if (!id) return;
    if (aiState.sessionId && req?.sessionID && req.sessionID !== aiState.sessionId) return;
    if (aiState.permissionSeen.has(id)) return;
    aiState.permissionSeen.add(id);
    aiState.permissionQueue.push(req);
    aiUpdatePromptDock();
}

function aiEnqueueQuestion(evt) {
    const req = evt?.properties || evt || null;
    const id = req?.id;
    if (!id) return;
    if (aiState.sessionId && req?.sessionID && req.sessionID !== aiState.sessionId) return;
    if (aiState.questionSeen.has(id)) return;
    aiState.questionSeen.add(id);
    aiState.questionQueue.push(req);
    aiUpdatePromptDock();
}

function aiDismissPermission(requestID) {
    aiState.permissionQueue = aiState.permissionQueue.filter((x) => x?.id !== requestID);
    if (aiState.currentPrompt?.type === 'permission' && aiState.currentPrompt?.req?.id === requestID) {
        aiState.currentPrompt = null;
    }
    aiUpdatePromptDock();
}

function aiDismissQuestion(requestID) {
    aiState.questionQueue = aiState.questionQueue.filter((x) => x?.id !== requestID);
    if (aiState.currentPrompt?.type === 'question' && aiState.currentPrompt?.req?.id === requestID) {
        aiState.currentPrompt = null;
    }
    aiUpdatePromptDock();
}

function aiUpdatePromptDock() {
    const dock = document.getElementById('ai2PromptDock');
    if (!dock) return;

    if (!aiState.currentPrompt) {
        const nextPermission = aiState.permissionQueue[0];
        const nextQuestion = aiState.questionQueue[0];
        if (nextPermission) aiState.currentPrompt = { type: 'permission', req: nextPermission };
        else if (nextQuestion) aiState.currentPrompt = { type: 'question', req: nextQuestion };
    }

    if (!aiState.currentPrompt) {
        dock.style.display = 'none';
        dock.innerHTML = '';
        return;
    }

    dock.style.display = '';
    const p = aiState.currentPrompt;
    if (p.type === 'permission') {
        aiRenderPermissionDock(dock, p.req);
    } else {
        aiRenderQuestionDock(dock, p.req);
    }
}

function aiDockDone(kind) {
    if (kind === 'permission') aiState.permissionQueue.shift();
    else aiState.questionQueue.shift();
    aiState.currentPrompt = null;
    aiUpdatePromptDock();
}

function aiDockLater(kind) {
    if (kind === 'permission') {
        const first = aiState.permissionQueue.shift();
        if (first) aiState.permissionQueue.push(first);
    } else {
        const first = aiState.questionQueue.shift();
        if (first) aiState.questionQueue.push(first);
    }
    aiState.currentPrompt = null;
    aiUpdatePromptDock();
}

function aiRenderPermissionDock(dock, req) {
    const patterns = Array.isArray(req?.patterns) ? req.patterns : [];
    const patternHtml = patterns.length > 0
        ? patterns.map((p) => `<div class="ai2-prompt-path">${escapeHtml(String(p || ''))}</div>`).join('')
        : '<div class="ai2-prompt-path is-empty">(none)</div>';
    dock.innerHTML = `
        <div class="ai2-prompt-dock-inner">
            <div class="ai2-prompt-dock-header">
                <div class="ai2-prompt-dock-title">需要授权：${escapeHtml(req?.permission || 'permission')}</div>
                <div class="ai2-prompt-dock-actions ai2-prompt-dock-actions-side ai2-prompt-dock-actions-permission">
                    <button class="btn-base ai2-prompt-icon-btn" id="ai2PermLater" type="button" title="稍后" aria-label="稍后" data-tip="稍后">🕒</button>
                    <button class="btn-base ai2-prompt-icon-btn is-danger" id="ai2PermReject" type="button" title="拒绝" aria-label="拒绝" data-tip="拒绝">✕</button>
                    <button class="btn-base ai2-prompt-icon-btn is-success" id="ai2PermAlways" type="button" title="始终允许" aria-label="始终允许" data-tip="始终允许">✓</button>
                    <button class="btn-base ai2-prompt-icon-btn is-primary" id="ai2PermOnce" type="button" title="仅本次允许" aria-label="仅本次允许" data-tip="仅本次允许">✓</button>
                </div>
            </div>
            <div class="ai2-prompt-dock-layout ai2-prompt-dock-layout-permission">
                <div class="ai2-prompt-dock-main ai2-prompt-dock-main-permission">
                    <div class="ai2-modal-text ai2-prompt-dock-desc">以下路径/模式将受影响：</div>
                    <div class="ai2-prompt-path-list">${patternHtml}</div>
                </div>
                <div class="ai2-prompt-dock-side ai2-prompt-dock-side-permission">
                    <div class="ai2-modal-text ai2-prompt-dock-desc">拒绝原因（可选）：</div>
                    <input class="input-base ai2-prompt-dock-input ai2-prompt-dock-reject-input" id="ai2PermRejectMsg" placeholder="输入拒绝原因" />
                </div>
            </div>
        </div>
    `;

    const laterBtn = document.getElementById('ai2PermLater');
    const rejectBtn = document.getElementById('ai2PermReject');
    const alwaysBtn = document.getElementById('ai2PermAlways');
    const onceBtn = document.getElementById('ai2PermOnce');

    if (laterBtn) laterBtn.onclick = () => aiDockLater('permission');

    const reply = (kind) => {
        const msgEl = document.getElementById('ai2PermRejectMsg');
        const message = msgEl ? (msgEl.value || '') : '';
        sendMessageWithTimeout('system', 'aiPermissionReply', {
            sessionId: req.sessionID || aiState.sessionId || '',
            requestId: req.id,
            reply: kind,
            message: kind === 'reject' ? message : null
        }, 30000, (resp) => {
            if (resp.code !== 0) {
                showToast(`授权处理失败: ${resp.msg || '未知错误'}`, 3000);
                return;
            }
            aiDockDone('permission');
        });
    };

    if (rejectBtn) rejectBtn.onclick = () => reply('reject');
    if (alwaysBtn) alwaysBtn.onclick = () => reply('always');
    if (onceBtn) onceBtn.onclick = () => reply('once');
}

function aiRenderQuestionDock(dock, req) {
    const questions = Array.isArray(req?.questions) ? req.questions : [];
    const renderQuestion = (q, idx) => {
        const multiple = !!q?.multiple;
        const inputType = multiple ? 'checkbox' : 'radio';
        const name = `ai2Q_${req.id}_${idx}`;
        const opts = Array.isArray(q?.options) ? q.options : [];
        const options = opts.map((o, i) => {
            const id = `${name}_${i}`;
            return `<label for="${id}" class="ai2-modal-text" style="display:flex; gap:10px; align-items:flex-start;">
                <input id="${id}" name="${name}" type="${inputType}" value="${escapeHtml(String(o?.label || ''))}" />
                <span>${escapeHtml(String(o?.label || ''))}${o?.description ? ` - ${escapeHtml(String(o.description))}` : ''}</span>
            </label>`;
        }).join('');
        return `<div class="ai2-detail-card"><div class="ai2-detail-head">${escapeHtml(q?.header || `问题 ${idx + 1}`)}</div><div class="ai2-detail-body">${escapeHtml(String(q?.question || '')).replace(/\n/g, '<br>')}<div class="ai2-question-options">${options}</div></div></div>`;
    };

    dock.innerHTML = `
        <div class="ai2-prompt-dock-inner">
            <div class="ai2-prompt-dock-layout ai2-prompt-dock-layout-question">
                <div class="ai2-prompt-dock-main">
                    <div class="ai2-prompt-dock-title">需要你的回答</div>
                    <div class="ai2-question-list">${questions.map(renderQuestion).join('')}</div>
                </div>
                <div class="ai2-prompt-dock-actions ai2-prompt-dock-actions-side">
                    <button class="btn-base ai2-prompt-icon-btn" id="ai2QuestionLater" type="button" title="稍后" aria-label="稍后" data-tip="稍后">🕒</button>
                    <button class="btn-base ai2-prompt-icon-btn is-danger" id="ai2QuestionReject" type="button" title="拒绝" aria-label="拒绝" data-tip="拒绝">✕</button>
                    <button class="btn-base ai2-prompt-icon-btn is-primary" id="ai2QuestionSubmit" type="button" title="提交" aria-label="提交" data-tip="提交">✓</button>
                </div>
            </div>
        </div>
    `;

    const laterBtn = document.getElementById('ai2QuestionLater');
    const rejectBtn = document.getElementById('ai2QuestionReject');
    const submitBtn = document.getElementById('ai2QuestionSubmit');
    if (laterBtn) laterBtn.onclick = () => aiDockLater('question');
    if (rejectBtn) rejectBtn.onclick = () => {
        sendMessageWithTimeout('system', 'aiQuestionReject', { requestId: req.id }, 30000, (resp) => {
            if (resp.code !== 0) {
                showToast(`拒绝失败: ${resp.msg || '未知错误'}`, 3000);
                return;
            }
            aiDockDone('question');
        });
    };
    if (submitBtn) submitBtn.onclick = () => {
        const answers = [];
        for (let i = 0; i < questions.length; i++) {
            const name = `ai2Q_${req.id}_${i}`;
            const picked = [];
            Array.from(document.querySelectorAll(`input[name="${name}"]`)).forEach((el) => {
                if (el && el.checked && el.value) picked.push(String(el.value));
            });
            if (picked.length === 0) {
                showToast(`请回答问题 ${i + 1}`, 2500);
                return;
            }
            answers.push(picked);
        }

        sendMessageWithTimeout('system', 'aiQuestionReply', { requestId: req.id, answers }, 30000, (resp) => {
            if (resp.code !== 0) {
                showToast(`提交失败: ${resp.msg || '未知错误'}`, 3000);
                return;
            }
            aiDockDone('question');
        });
    };
}

function aiMaybePromptModelConfig() {
    if (aiState.configPrompted) return;
    aiState.configPrompted = true;

    sendMessage('system', 'aiProviders', {}, (resp) => {
        const connected = resp.data?.connected || [];
        if (resp.code === 0 && Array.isArray(connected) && connected.length > 0) {
            return;
        }
        showModal('需要配置模型', '<div class="ai2-modal-text">未检测到已连接的 Provider，请先在模型弹窗中连接。</div>', () => {
            openAiModelConfig();
        }, 'sm');
        const confirmBtn = document.getElementById('modalConfirm');
        if (confirmBtn) confirmBtn.textContent = '去连接';
    });
}

async function aiLoadConfigOnce() {
    const resp = await ai2Call('aiConfigGet', {}, 20000);
    if (resp.code !== 0 || !resp.data) return;

    aiState.defaultAgent = (typeof resp.data.default_agent === 'string') ? resp.data.default_agent : '';
    aiState.defaultModel = (typeof resp.data.model === 'string') ? resp.data.model : '';

    const nextAgent = (aiState.defaultAgent === 'plan' || aiState.defaultAgent === 'build') ? aiState.defaultAgent : 'build';
    setAiMode(nextAgent);
    aiUpdateModelTriggerLabel();
    aiRefreshVariantOptions();
}

async function aiRefreshModelsList() {
    const [cfgResp, providerResp, authResp] = await Promise.all([
        ai2Call('aiConfigProviders', {}, 30000),
        ai2Call('aiProviders', {}, 30000),
        ai2Call('aiProviderAuth', {}, 30000)
    ]);

    if (providerResp.code === 0 && providerResp.data) {
        aiState.providerList = providerResp.data;
        aiState.connectedProviders = new Set(Array.isArray(providerResp.data.connected) ? providerResp.data.connected : []);
    }
    if (authResp.code === 0 && authResp.data) {
        aiState.providerAuth = authResp.data;
    }
    if (cfgResp.code !== 0 || !cfgResp.data) {
        aiState.modelCatalog = { providers: [], flat: [] };
        aiState.modelsLoaded = false;
        return;
    }

    aiState.modelCatalogRaw = cfgResp.data;
    aiState.modelCatalog = ai2BuildModelCatalog(cfgResp.data, aiState.connectedProviders, ai2ModalState.hidden);
    aiState.modelsLoaded = aiState.modelCatalog.flat.length > 0;

    aiUpdateModelTriggerLabel();
    aiRefreshVariantOptions();
}

function aiSelectModel(key) {
    aiState.model = key || '';
    if (aiState.model) ai2LsSet(AI2_MODEL_KEY, aiState.model);
    else ai2LsDel(AI2_MODEL_KEY);
    aiState.variant = '';
    ai2LsDel(AI2_VARIANT_KEY);
    aiUpdateModelTriggerLabel();
    aiRefreshVariantOptions();
}

async function aiSetDefaultModel(modelKey) {
    if (!modelKey) return;
    const resp = await ai2Call('aiPatchConfig', { model: modelKey }, 30000);
    if (resp.code !== 0) {
        showToast(`设置默认模型失败: ${resp.msg || '未知错误'}`, 3000);
        return;
    }
    aiState.defaultModel = modelKey;
    showToast('默认模型已更新', 2000);
    aiUpdateModelTriggerLabel();
    aiRefreshVariantOptions();
}

function ai2CloseModelModal() {
    ai2ModalState.oauthPollToken += 1;
    ai2ModalState.open = false;
    ai2ModalState.pending = false;
    ai2ModalState.error = '';
    ai2ModalState.oauthStatus = '';
}

function ai2RenderModelModal() {
    const root = document.getElementById('ai2ModelModalRoot');
    if (!root) return;

    if (ai2ModalState.view === 'provider') {
        ai2RenderProviderView(root);
        return;
    }
    if (ai2ModalState.view === 'connect') {
        ai2RenderConnectView(root);
        return;
    }
    if (ai2ModalState.view === 'manage') {
        ai2RenderManageView(root);
        return;
    }
    ai2RenderModelView(root);
}

function ai2RenderModelView(root) {
    const catalog = aiState.modelCatalog || { providers: [], flat: [] };
    const selectedKey = ai2ModalState.selectedModelKey || aiState.model || aiState.defaultModel || '';
    ai2ModalState.selectedModelKey = selectedKey;

    root.innerHTML = `
        <div class="ai2-modal">
            <div class="ai2-modal-head">
                <div class="ai2-modal-title">模型选择</div>
                <div class="ai2-modal-top-actions">
                    <button class="btn-base btn-tonal" id="ai2OpenProviderSelect">连接提供商</button>
                    <button class="btn-base btn-tonal" id="ai2OpenManageModels">管理模型</button>
                </div>
            </div>
            <div class="ai2-modal-layout">
                <div class="ai2-modal-col">
                    <div class="ai2-modal-search"><input class="input-base" id="ai2ModelSearch" placeholder="搜索模型 / Provider" style="width:100%;" /></div>
                    <div class="ai2-modal-list" id="ai2ModelList"></div>
                </div>
                <div class="ai2-modal-col"><div class="ai2-modal-panel" id="ai2ModelPanel"></div></div>
            </div>
        </div>
    `;

    const search = document.getElementById('ai2ModelSearch');
    const list = document.getElementById('ai2ModelList');
    const panel = document.getElementById('ai2ModelPanel');
    const providerBtn = document.getElementById('ai2OpenProviderSelect');
    const manageBtn = document.getElementById('ai2OpenManageModels');
    if (!list || !panel) return;

    if (providerBtn) providerBtn.onclick = () => {
        ai2ModalState.view = 'provider';
        ai2RenderModelModal();
    };
    if (manageBtn) manageBtn.onclick = () => {
        ai2ModalState.view = 'manage';
        ai2RenderModelModal();
    };

    const render = () => {
        const q = (ai2ModalState.search || '').trim();
        list.innerHTML = '';

        catalog.providers.forEach((p) => {
            const models = p.models.filter((m) => ai2ModelMatches(m, q));
            if (models.length === 0) return;

            const title = document.createElement('div');
            title.className = 'ai2-modal-group-title';
            title.textContent = p.name || p.id;
            list.appendChild(title);

            models.forEach((m) => {
                const item = document.createElement('div');
                item.className = 'ai2-modal-item' + (ai2ModalState.selectedModelKey === m.key ? ' selected' : '');
                item.innerHTML = `<div class="ai2-modal-item-name">${escapeHtml(m.name || m.modelID)}</div><div class="ai2-modal-item-sub">${escapeHtml(m.key)}</div>`;
                const tags = document.createElement('div');
                tags.className = 'ai2-tags';
                if (ai2IsFreeModel(m)) {
                    const t = document.createElement('span');
                    t.className = 'ai2-tag good';
                    t.textContent = '免费';
                    tags.appendChild(t);
                }
                if (m.capabilities?.reasoning) {
                    const t = document.createElement('span');
                    t.className = 'ai2-tag rec';
                    t.textContent = 'reasoning';
                    tags.appendChild(t);
                }
                if (tags.children.length > 0) {
                    item.appendChild(tags);
                }
                item.onclick = () => {
                    ai2ModalState.selectedModelKey = m.key;
                    render();
                    ai2RenderModelPanel(panel, m);
                };
                list.appendChild(item);
            });
        });

        const model = ai2FindModel(ai2ModalState.selectedModelKey) || catalog.flat.find((m) => ai2ModelMatches(m, q)) || null;
        if (model) {
            ai2ModalState.selectedModelKey = model.key;
            ai2RenderModelPanel(panel, model);
        } else {
            panel.innerHTML = '<div class="ai2-modal-text">没有匹配的模型</div>';
        }
    };

    if (search) {
        search.value = ai2ModalState.search || '';
        search.oninput = () => {
            ai2ModalState.search = search.value || '';
            render();
        };
        setTimeout(() => { try { search.focus(); } catch { } }, 0);
    }

    render();
}

function ai2RenderModelPanel(panel, model) {
    const inputs = (() => {
        const labelMap = {
            text: '文本',
            image: '图片',
            audio: '音频',
            video: '视频',
            pdf: 'PDF'
        };
        if (model.capabilities?.input) {
            const order = ['text', 'image', 'audio', 'video', 'pdf'];
            const keys = order.filter((k) => !!model.capabilities.input[k]);
            if (keys.length === 0) return '文本';
            return keys.map((k) => labelMap[k] || String(k)).join('，');
        }
        const raw = model.modalities?.input;
        if (Array.isArray(raw) && raw.length > 0) {
            return raw.map((k) => labelMap[k] || String(k)).join('，');
        }
        return '文本';
    })();

    const reasoning = (model.capabilities && typeof model.capabilities.reasoning === 'boolean')
        ? (model.capabilities.reasoning ? '支持推理' : '不支持推理')
        : (model.reasoning ? '支持推理' : '不支持推理');

    const context = (typeof model.limit?.context === 'number' && model.limit.context > 0)
        ? `上下文: ${Math.round(model.limit.context).toLocaleString()}`
        : '上下文: -';

    panel.innerHTML = `
        <h4>${escapeHtml(model.name || model.modelID)}</h4>
        <div class="ai2-modal-text">${escapeHtml(model.key)}</div>
        <div class="ai2-modal-text">支持：${escapeHtml(inputs)}</div>
        <div class="ai2-modal-text">${reasoning}</div>
        <div class="ai2-modal-text">${context}</div>
        <div class="ai2-modal-actions">
            <button class="btn-base btn-primary" id="ai2PickModelBtn" type="button">使用此模型</button>
            <button class="btn-base btn-tonal" id="ai2SetDefaultModelBtn" type="button">设为默认</button>
        </div>
    `;

    const pickBtn = document.getElementById('ai2PickModelBtn');
    const defaultBtn = document.getElementById('ai2SetDefaultModelBtn');

    if (pickBtn) pickBtn.onclick = () => {
        aiSelectModel(model.key);
        ai2CloseModelModal();
        closeMainModal();
    };
    if (defaultBtn) defaultBtn.onclick = () => {
        aiSetDefaultModel(model.key);
    };
}

function ai2RenderProviderView(root) {
    const all = Array.isArray(aiState.providerList?.all) ? aiState.providerList.all : [];
    const connected = new Set(Array.isArray(aiState.providerList?.connected) ? aiState.providerList.connected : []);

    root.innerHTML = `
        <div class="ai2-modal">
            <div class="ai2-modal-head">
                <div class="ai2-modal-title">连接提供商</div>
                <div class="ai2-modal-top-actions"><button class="btn-base btn-tonal" id="ai2BackToModels">返回模型</button></div>
            </div>
            <div class="ai2-modal-col" style="min-height:520px;">
                <div class="ai2-modal-search"><input class="input-base" id="ai2ProviderSearch" placeholder="搜索 Provider" style="width:100%;" /></div>
                <div class="ai2-modal-list" id="ai2ProviderList"></div>
            </div>
        </div>
    `;

    const backBtn = document.getElementById('ai2BackToModels');
    if (backBtn) backBtn.onclick = () => { ai2ModalState.view = 'model'; ai2RenderModelModal(); };

    const searchEl = document.getElementById('ai2ProviderSearch');
    const listEl = document.getElementById('ai2ProviderList');
    if (!listEl) return;

    const render = () => {
        const q = (ai2ModalState.providerSearch || '').trim().toLowerCase();
        const rows = all.filter((p) => {
            const name = String(p?.name || '').toLowerCase();
            const id = String(p?.id || '').toLowerCase();
            if (!q) return true;
            return name.includes(q) || id.includes(q);
        });

        rows.sort((a, b) => {
            const ai = AI2_POPULAR_PROVIDERS.indexOf(a.id);
            const bi = AI2_POPULAR_PROVIDERS.indexOf(b.id);
            if (ai >= 0 && bi >= 0) return ai - bi;
            if (ai >= 0) return -1;
            if (bi >= 0) return 1;
            return String(a.name || a.id).localeCompare(String(b.name || b.id));
        });

        listEl.innerHTML = '';
        rows.forEach((p) => {
            const row = document.createElement('div');
            row.className = 'ai2-provider-row';
            const left = document.createElement('div');
            left.innerHTML = `<div class="name">${escapeHtml(p.name || p.id)}</div><div class="text-muted" style="font-size: var(--font-body);">${escapeHtml(p.id || '')}</div>`;
            const right = document.createElement('div');
            right.style.display = 'flex';
            right.style.gap = '8px';

            if (p.id === 'opencode') {
                const t = document.createElement('span');
                t.className = 'ai2-tag rec';
                t.textContent = '推荐';
                right.appendChild(t);
            }
            const s = document.createElement('span');
            s.className = connected.has(p.id) ? 'ai2-tag good' : 'ai2-tag';
            s.textContent = connected.has(p.id) ? '已连接' : '未连接';
            right.appendChild(s);

            row.appendChild(left);
            row.appendChild(right);
            row.onclick = () => {
                ai2ModalState.selectedProvider = p.id;
                ai2ModalState.selectedMethodIndex = null;
                ai2ModalState.authorization = null;
                ai2ModalState.error = '';
                ai2ModalState.view = 'connect';
                ai2RenderModelModal();
            };
            listEl.appendChild(row);
        });
    };

    if (searchEl) {
        searchEl.value = ai2ModalState.providerSearch || '';
        searchEl.oninput = () => {
            ai2ModalState.providerSearch = searchEl.value || '';
            render();
        };
    }

    render();
}

function ai2CurrentMethods(providerID) {
    const all = aiState.providerAuth?.[providerID];
    if (Array.isArray(all) && all.length > 0) return all;
    return [{ type: 'api', label: 'API Key' }];
}

async function ai2ConnectProviderSuccess(providerID) {
    ai2ModalState.oauthPollToken += 1;
    await ai2Call('aiDisposeInstance', {}, 60000);
    showToast(`已连接: ${providerID}`, 2000);
    await aiRefreshModelsList();
    aiState.configPrompted = false;
    ai2ModalState.view = 'model';
    ai2ModalState.selectedProvider = '';
    ai2ModalState.selectedMethodIndex = null;
    ai2ModalState.authorization = null;
    ai2ModalState.pending = false;
    ai2ModalState.error = '';
    ai2ModalState.oauthStatus = '';
    ai2RenderModelModal();
}

async function ai2CheckOAuthAuto(providerID, methodIndex) {
    const cb = await ai2Call('aiOauthCallback', { id: providerID, method: methodIndex }, 60000);
    if (cb.code === 0) {
        await ai2ConnectProviderSuccess(providerID);
        return true;
    }
    return false;
}

function ai2StartOAuthAutoPolling(providerID, methodIndex) {
    const token = ++ai2ModalState.oauthPollToken;
    const startedAt = Date.now();
    ai2ModalState.pending = true;
    ai2ModalState.error = '';
    ai2ModalState.oauthStatus = '等待你在浏览器完成授权...';
    ai2RenderModelModal();

    const tick = async () => {
        if (token !== ai2ModalState.oauthPollToken) return;
        if (ai2ModalState.view !== 'connect') return;

        const ok = await ai2CheckOAuthAuto(providerID, methodIndex);
        if (token !== ai2ModalState.oauthPollToken) return;
        if (ok) return;

        const elapsed = Date.now() - startedAt;
        if (elapsed >= 180000) {
            ai2ModalState.pending = false;
            ai2ModalState.error = '等待授权超时，请完成浏览器授权后点击“继续检查”';
            ai2ModalState.oauthStatus = '';
            ai2RenderModelModal();
            return;
        }

        ai2ModalState.oauthStatus = '等待授权中...';
        setTimeout(tick, 2500);
    };

    setTimeout(tick, 1200);
}

async function ai2StartOAuth(providerID, methodIndex) {
    ai2ModalState.pending = true;
    ai2ModalState.error = '';
    ai2ModalState.oauthStatus = '';
    ai2RenderModelModal();

    const resp = await ai2Call('aiOauthAuthorize', { id: providerID, method: methodIndex }, 60000);
    if (resp.code !== 0) {
        ai2ModalState.pending = false;
        ai2ModalState.error = resp.msg || 'OAuth 初始化失败';
        ai2RenderModelModal();
        return;
    }

    const auth = resp.data || null;
    ai2ModalState.authorization = auth;
    ai2ModalState.pending = false;
    ai2RenderModelModal();

    if (auth?.url) {
        sendMessage('app', 'launch', { path: auth.url }, () => { });
    }

    if (auth?.method === 'auto') {
        ai2StartOAuthAutoPolling(providerID, methodIndex);
    }
}

function ai2RenderConnectView(root) {
    const providerID = ai2ModalState.selectedProvider;
    const provider = Array.isArray(aiState.providerList?.all) ? aiState.providerList.all.find((p) => p.id === providerID) : null;
    const methods = ai2CurrentMethods(providerID);

    root.innerHTML = `
        <div class="ai2-modal">
            <div class="ai2-modal-head">
                <div class="ai2-modal-title">${escapeHtml(provider?.name || providerID || '连接 Provider')}</div>
                <div class="ai2-modal-top-actions"><button class="btn-base btn-tonal" id="ai2BackToProviderList">返回</button></div>
            </div>
            <div class="ai2-modal-layout">
                <div class="ai2-modal-col"><div class="ai2-modal-panel" id="ai2ConnectLeft"></div></div>
                <div class="ai2-modal-col"><div class="ai2-modal-panel" id="ai2ConnectRight"></div></div>
            </div>
        </div>
    `;

    const backBtn = document.getElementById('ai2BackToProviderList');
    if (backBtn) backBtn.onclick = () => {
        ai2ModalState.oauthPollToken += 1;
        ai2ModalState.view = 'provider';
        ai2RenderModelModal();
    };

    const left = document.getElementById('ai2ConnectLeft');
    const right = document.getElementById('ai2ConnectRight');
    if (!left || !right) return;

    left.innerHTML = '<h4>认证方式</h4><div class="ai2-method-list" id="ai2MethodList"></div>';
    const list = document.getElementById('ai2MethodList');
    if (list) {
        methods.forEach((m, idx) => {
            const row = document.createElement('div');
            row.className = 'ai2-method-item' + (ai2ModalState.selectedMethodIndex === idx ? ' active' : '');
            row.textContent = (m.type === 'oauth') ? (m.label || 'OAuth') : (m.label || 'API Key');
            row.onclick = async () => {
                ai2ModalState.oauthPollToken += 1;
                ai2ModalState.selectedMethodIndex = idx;
                ai2ModalState.authorization = null;
                ai2ModalState.error = '';
                ai2ModalState.oauthStatus = '';
                ai2RenderModelModal();
                if (m.type === 'oauth') {
                    await ai2StartOAuth(providerID, idx);
                }
            };
            list.appendChild(row);
        });
    }

    if (ai2ModalState.selectedMethodIndex === null && methods.length === 1) {
        ai2ModalState.selectedMethodIndex = 0;
    }

    const idx = ai2ModalState.selectedMethodIndex;
    const method = (typeof idx === 'number') ? methods[idx] : null;
    if (!method) {
        right.innerHTML = '<div class="ai2-modal-text">请选择认证方式</div>';
        return;
    }

    if (method.type === 'api') {
        const zen = providerID === 'opencode'
            ? '<div class="ai2-modal-text">OpenCode Zen：<a href="#" id="ai2ZenLink">https://opencode.ai/zen</a></div>'
            : '<div class="ai2-modal-text">请输入 API Key 完成连接</div>';

        right.innerHTML = `
            <h4>API Key</h4>
            ${zen}
            <input class="input-base" id="ai2ApiKeyInput" placeholder="API Key" />
            <div class="ai2-modal-actions">
                <button class="btn-base btn-primary" id="ai2ApiConnectBtn" type="button">连接</button>
            </div>
            <div class="ai2-modal-text" id="ai2ApiConnectHint"></div>
        `;

        const zenLink = document.getElementById('ai2ZenLink');
        if (zenLink) {
            zenLink.onclick = (e) => {
                e.preventDefault();
                sendMessage('app', 'launch', { path: 'https://opencode.ai/zen' }, () => { });
            };
        }

        const btn = document.getElementById('ai2ApiConnectBtn');
        if (btn) {
            btn.onclick = async () => {
                const input = document.getElementById('ai2ApiKeyInput');
                const hint = document.getElementById('ai2ApiConnectHint');
                const key = input ? (input.value || '').trim() : '';
                if (!key) {
                    if (hint) hint.textContent = '请输入 API Key';
                    return;
                }
                if (hint) hint.textContent = '正在连接...';
                const resp = await ai2Call('aiSetAuth', { id: providerID, auth: { type: 'api', key } }, 60000);
                if (resp.code !== 0) {
                    if (hint) hint.textContent = '';
                    showToast(`连接失败: ${resp.msg || '未知错误'}`, 3000);
                    return;
                }
                await ai2ConnectProviderSuccess(providerID);
            };
        }
        return;
    }

    if (ai2ModalState.pending) {
        right.innerHTML = `<div class="ai2-modal-text"><span class="spinner" style="width:16px;height:16px;display:inline-block;vertical-align:middle;margin-right:8px;"></span>${escapeHtml(ai2ModalState.oauthStatus || '正在进行 OAuth 授权...')}</div>`;
        return;
    }

    if (ai2ModalState.error) {
        right.innerHTML = `<div class="ai2-modal-text" style="color: var(--accent-red);">${escapeHtml(ai2ModalState.error)}</div><div class="ai2-modal-actions"><button class="btn-base btn-tonal" id="ai2RetryOauth" type="button">重试</button><button class="btn-base btn-tonal" id="ai2CheckOauthNow" type="button">继续检查</button></div>`;
        const retry = document.getElementById('ai2RetryOauth');
        const checkNow = document.getElementById('ai2CheckOauthNow');
        if (retry) {
            retry.onclick = async () => {
                await ai2StartOAuth(providerID, idx);
            };
        }
        if (checkNow) {
            checkNow.onclick = async () => {
                ai2ModalState.pending = true;
                ai2ModalState.error = '';
                ai2ModalState.oauthStatus = '正在检查授权结果...';
                ai2RenderModelModal();
                const ok = await ai2CheckOAuthAuto(providerID, idx);
                if (!ok) {
                    ai2ModalState.pending = false;
                    ai2ModalState.error = '尚未完成授权，请在浏览器完成后重试';
                    ai2ModalState.oauthStatus = '';
                    ai2RenderModelModal();
                }
            };
        }
        return;
    }

    const auth = ai2ModalState.authorization;
    if (!auth) {
        right.innerHTML = '<div class="ai2-modal-text">请选择 OAuth 方式，系统将自动打开浏览器。</div>';
        return;
    }

    if (auth.method === 'code') {
        right.innerHTML = `
            <h4>OAuth 授权码</h4>
            <div class="ai2-modal-text">${escapeHtml(auth.instructions || '请在浏览器完成登录后粘贴 Code')}</div>
            <input class="input-base" id="ai2OauthCodeInput" placeholder="Code" />
            <div class="ai2-modal-actions"><button class="btn-base btn-primary" id="ai2OauthCodeSubmit" type="button">提交</button></div>
        `;
        const submit = document.getElementById('ai2OauthCodeSubmit');
        if (submit) {
            submit.onclick = async () => {
                const codeEl = document.getElementById('ai2OauthCodeInput');
                const code = codeEl ? (codeEl.value || '').trim() : '';
                if (!code) {
                    showToast('请输入授权码', 2000);
                    return;
                }
                ai2ModalState.pending = true;
                ai2RenderModelModal();
                const cb = await ai2Call('aiOauthCallback', { id: providerID, method: idx, code }, 60000);
                ai2ModalState.pending = false;
                if (cb.code !== 0) {
                    ai2ModalState.error = cb.msg || 'OAuth 回调失败';
                    ai2RenderModelModal();
                    return;
                }
                await ai2ConnectProviderSuccess(providerID);
            };
        }
        return;
    }

    right.innerHTML = `
        <h4>OAuth 自动授权</h4>
        <div class="ai2-modal-text">${escapeHtml(auth.instructions || '请在浏览器中完成授权，系统会自动回调。')}</div>
        <div class="ai2-modal-text"><span class="spinner" style="width:16px;height:16px;display:inline-block;vertical-align:middle;margin-right:8px;"></span>${escapeHtml(ai2ModalState.oauthStatus || '等待回调完成...')}</div>
        <div class="ai2-modal-actions"><button class="btn-base btn-tonal" id="ai2CheckOauthAutoNow" type="button">我已完成授权，继续检查</button></div>
    `;

    const checkAutoBtn = document.getElementById('ai2CheckOauthAutoNow');
    if (checkAutoBtn) {
        checkAutoBtn.onclick = async () => {
            ai2ModalState.pending = true;
            ai2ModalState.oauthStatus = '正在检查授权结果...';
            ai2RenderModelModal();
            const ok = await ai2CheckOAuthAuto(providerID, idx);
            if (!ok) {
                ai2ModalState.pending = false;
                ai2ModalState.error = '尚未完成授权，请在浏览器完成后重试';
                ai2ModalState.oauthStatus = '';
                ai2RenderModelModal();
            }
        };
    }
}

function ai2RenderManageView(root) {
    const allModels = aiState.modelCatalogRaw ? ai2BuildModelCatalog(aiState.modelCatalogRaw, aiState.connectedProviders, new Set()).flat : [];

    root.innerHTML = `
        <div class="ai2-modal">
            <div class="ai2-modal-head">
                <div class="ai2-modal-title">管理模型</div>
                <div class="ai2-modal-top-actions"><button class="btn-base btn-tonal" id="ai2ManageOpenProvider">连接提供商</button></div>
            </div>
            <div class="ai2-modal-col" style="min-height:520px;">
                <div class="ai2-modal-search"><input class="input-base" id="ai2ManageSearch" placeholder="搜索模型" style="width:100%;" /></div>
                <div class="ai2-modal-list" id="ai2ManageList"></div>
            </div>
        </div>
    `;

    const openProvider = document.getElementById('ai2ManageOpenProvider');
    if (openProvider) openProvider.onclick = () => { ai2ModalState.view = 'provider'; ai2RenderModelModal(); };

    const search = document.getElementById('ai2ManageSearch');
    const list = document.getElementById('ai2ManageList');
    if (!list) return;

    const render = () => {
        const q = (ai2ModalState.manageSearch || '').trim().toLowerCase();
        list.innerHTML = '';

        const rows = allModels.filter((m) => {
            if (!q) return true;
            const hay = `${m.key} ${m.name || ''} ${m.providerName || ''}`.toLowerCase();
            return hay.includes(q);
        });

        rows.forEach((m) => {
            const hidden = ai2ModalState.hidden.has(m.key);
            const row = document.createElement('div');
            row.className = 'ai2-provider-row';
            row.innerHTML = `<div><div class="name">${escapeHtml(m.name || m.modelID)}</div><div class="text-muted" style="font-size: var(--font-body);">${escapeHtml(m.key)}</div></div>`;
            const right = document.createElement('div');
            right.className = 'ai2-manage-switch-wrap';

            const tip = document.createElement('span');
            tip.className = 'ai2-manage-switch-text';
            tip.textContent = hidden ? '隐藏' : '显示';

            const sw = document.createElement('label');
            sw.className = 'ios-switch';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = !hidden;
            const slider = document.createElement('span');
            slider.className = 'ios-switch-slider';
            sw.appendChild(input);
            sw.appendChild(slider);

            input.onchange = (e) => {
                e.stopPropagation();
                if (input.checked) ai2ModalState.hidden.delete(m.key);
                else ai2ModalState.hidden.add(m.key);
                ai2SaveHiddenModels();
                aiState.modelCatalog = ai2BuildModelCatalog(aiState.modelCatalogRaw, aiState.connectedProviders, ai2ModalState.hidden);
                aiUpdateModelTriggerLabel();
                aiRefreshVariantOptions();
                render();
            };

            right.appendChild(tip);
            right.appendChild(sw);
            row.appendChild(right);
            list.appendChild(row);
        });
    };

    if (search) {
        search.value = ai2ModalState.manageSearch || '';
        search.oninput = () => {
            ai2ModalState.manageSearch = search.value || '';
            render();
        };
    }

    render();
}

async function aiOpenModelSelector(startView = 'model') {
    if (!aiState.status?.running) {
        showToast('AI 未连接', 2000);
        return;
    }

    ai2ModalState.open = true;
    ai2ModalState.view = startView;
    ai2ModalState.selectedModelKey = aiState.model || aiState.defaultModel || '';

    showModal('模型与提供商', '<div id="ai2ModelModalRoot" class="ai2-modal"><div class="ai2-modal-text">加载中...</div></div>', () => {
        ai2CloseModelModal();
    }, 'xl');

    const confirmBtn = document.getElementById('modalConfirm');
    const cancelBtn = document.getElementById('modalCancel');
    const closeBtn = document.getElementById('modalClose');
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (confirmBtn) {
        confirmBtn.textContent = '关闭';
        confirmBtn.onclick = () => {
            ai2CloseModelModal();
            closeMainModal();
        };
    }
    if (closeBtn) {
        closeBtn.onclick = () => {
            ai2CloseModelModal();
            closeMainModal();
        };
    }

    await aiRefreshModelsList();
    ai2RenderModelModal();
}

function openAiModelConfig() {
    aiOpenModelSelector('provider');
}

async function ai2EnsureSession() {
    if (aiState.sessionId) {
        return aiState.sessionId;
    }

    if (aiState.creatingSessionPromise) {
        return await aiState.creatingSessionPromise;
    }

    aiState.creatingSessionPromise = (async () => {
        const resp = await ai2Call('aiNewSession', { title: 'PanelManager AI' }, 30000);
        if (resp.code !== 0) {
            showToast(`创建会话失败: ${resp.msg || '未知错误'}`, 3000);
            return null;
        }
        const sid = resp.data?.id || resp.data?.sessionId || resp.data?.info?.id;
        if (!sid) {
            showToast('创建会话失败: 返回缺少 sessionId', 3000);
            return null;
        }

        aiState.sessionId = sid;
        aiState.pendingSynced = false;
        aiSyncPendingPrompts();
        aiUpdatePromptDock();
        return sid;
    })();

    try {
        return await aiState.creatingSessionPromise;
    } finally {
        aiState.creatingSessionPromise = null;
    }
}

function aiResetChatUi() {
    const oldSessionId = aiState.sessionId;
    if (oldSessionId) {
        void ai2Call('aiAbortSession', { sessionId: oldSessionId }, 10000);
    }

    aiState.sessionId = null;
    aiState.attachments = [];
    aiState.messageOrder = [];
    aiState.messageInfo.clear();
    aiState.messageParts.clear();
    aiState.optimisticText.clear();
    aiState.selectedMessageId = null;
    aiState.permissionQueue = [];
    aiState.questionQueue = [];
    aiState.currentPrompt = null;
    aiState.pendingSynced = false;
    aiState.sessionStatusType = 'idle';
    aiState.permissionSeen = new Set();
    aiState.questionSeen = new Set();
    aiState.runtimeLastText = '';
    aiState.runtimeLastAt = 0;
    aiStopHydratePolling();
    aiState.hydrateInFlight = false;
    aiState.abortInFlight = false;
    aiSetAwaitingReply(false);
    aiUpdateSendButton();
    aiRenderMessageList();
    aiRenderDetailsPanel();
    aiRefreshAttachmentUi();
    aiUpdatePromptDock();
}

async function aiPickAttachment() {
    const resp = await ai2Call('pickFile', { title: '选择附件', extensions: ['.*'] }, 30000);
    if (resp.code !== 0) {
        showToast(`文件选择失败: ${resp.msg || '未知错误'}`, 3000);
        return;
    }
    const path = resp.data?.path;
    if (!path) return;
    if (aiState.attachments.includes(path)) {
        showToast('已添加该文件', 1500);
        return;
    }
    aiState.attachments.push(path);
    aiRefreshAttachmentUi();
}

async function aiSend() {
    const input = document.getElementById('aiPrompt');
    const text = input ? (input.value || '').trim() : '';

    if (aiState.awaitingReply) {
        await aiAbortCurrentSession();
        return;
    }

    if (!text) return;

    if (aiState.sendInFlight) {
        return;
    }

    aiState.sendInFlight = true;
    aiUpdateSendButton();

    try {
        const sid = await ai2EnsureSession();
        if (!sid) return;

        const sig = `${sid}|${text}|${aiState.mode}|${aiState.model || ''}`;
        const now = Date.now();
        if (aiState.lastSendSig === sig && (now - aiState.lastSendTs) < 1200) {
            return;
        }
        aiState.lastSendSig = sig;
        aiState.lastSendTs = now;

        const messageId = aiCreateOpenCodeMessageId();
        aiState.optimisticText.set(messageId, text);
        aiUpsertMessageInfo({ id: messageId, role: 'user', sessionID: sid, time: { created: Date.now() } });
        aiState.selectedMessageId = messageId;
        aiRenderMessageList();
        aiRenderDetailsPanel();

        if (input) input.value = '';

        const resp = await ai2Call('aiPromptAsync', {
            messageId,
            sessionId: sid,
            text,
            agent: aiState.mode,
            model: aiState.model || '',
            attachments: aiState.attachments
        }, 60000);

        if (resp.code !== 0) {
            showToast(`发送失败: ${resp.msg || '未知错误'}`, 3000);
            aiSetAwaitingReply(false);
        } else {
            aiState.attachments = [];
            aiRefreshAttachmentUi();
            aiSetAwaitingReply(true);
        }
    } finally {
        aiState.sendInFlight = false;
        aiUpdateSendButton();
    }
}

async function aiInitPage() {
    if (!aiState.ai2Bound) {
        aiState.ai2Bound = true;
        ai2InitHiddenModels();

        const savedModel = ai2LsGet(AI2_MODEL_KEY);
        if (savedModel) aiState.model = savedModel;
        ai2LsDel(AI2_VARIANT_KEY);

        const prompt = document.getElementById('aiPrompt');
        if (prompt && prompt.dataset.bound !== '1') {
            prompt.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' || e.shiftKey) return;
                // 中文/日文输入法选词时，Enter 也会触发 keydown；这里避免误发送
                if (e.isComposing || e.keyCode === 229 || e.which === 229) return;
                e.preventDefault();
                aiSend();
            });
            prompt.dataset.bound = '1';
        }

    }

    setAiMode(aiState.mode || 'build');
    aiUpdateModelTriggerLabel();
    aiRefreshVariantOptions();
    aiRefreshAttachmentUi();
    aiUpdateSendButton();
    aiInsertWelcomeHelpIfNeeded();
    aiRenderMessageList();
    aiRenderDetailsPanel();
    aiUpdatePromptDock();

    aiSetBusy(true, '检查 AI 服务状态...');
    const statusResp = await ai2Call('aiStatus', {}, 15000);
    if (statusResp.code === 0 && statusResp.data?.running) {
        aiHandleStatusEvent(statusResp.data);
        return;
    }

    aiSetBusy(true, '正在启动 AI 服务...');
    const startResp = await ai2Call('aiStart', { version: 'latest' }, 60000);
    if (startResp.code === 0 && startResp.data) {
        aiHandleStatusEvent(startResp.data);
        return;
    }

    if (startResp.code !== 0) {
        const errMsg = String(startResp.msg || '');
        if (errMsg.startsWith('OPENCODE_PROCESS_EXISTS')) {
            aiSetBusy(false, '');
            showModal(
                'OpenCode 实例冲突',
                '<div style="line-height:1.7;">检测到系统里已有 OpenCode 进程，但当前会话无法自动接管。<br>是否强制结束旧进程并重新拉起新实例？</div>',
                () => {
                    aiSetBusy(true, '正在强制重启 OpenCode...', true);
                    void (async () => {
                        const retryResp = await ai2Call('aiStart', { version: 'latest', forceRestart: true }, 90000);
                        if (retryResp.code === 0 && retryResp.data) {
                            aiHandleStatusEvent(retryResp.data);
                            showToast('OpenCode 已重启并连接');
                            return;
                        }
                        aiSetBusy(true, '启动失败', false);
                        showToast(`AI 启动失败: ${retryResp.msg || '未知错误'}`, 4000);
                    })();
                },
                'md'
            );
            const confirmBtn = document.getElementById('modalConfirm');
            if (confirmBtn) confirmBtn.textContent = '强制重启';
            return;
        }

        aiSetBusy(true, '启动失败', false);
        showToast(`AI 启动失败: ${startResp.msg || '未知错误'}`, 3000);
    }
}

window.aiInitPage = aiInitPage;
window.aiSend = aiSend;
window.aiPickAttachment = aiPickAttachment;
window.openAiModelConfig = openAiModelConfig;
window.aiNewChat = () => {
    aiResetChatUi();
};

// ========== 触摸校准向导（设备侧 raw -> HID 横屏坐标） ==========

const TOUCH_CAL2_STEPS = [
    { key: 'tl', label: '左上角', shortLabel: '左上', x: '8%', y: '12%' },
    { key: 'tr', label: '右上角', shortLabel: '右上', x: '92%', y: '12%' },
    { key: 'br', label: '右下角', shortLabel: '右下', x: '92%', y: '88%' },
    { key: 'bl', label: '左下角', shortLabel: '左下', x: '8%', y: '88%' },
];

const touchCal2State = {
    active: false,
    phase: 'screen',
    step: 0,
    samples: [],
    saving: false,
};

function touchCal2SetText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function touchCal2SetStatus(id, text, state = '') {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.classList.remove('ok', 'warn', 'error');
    if (state) el.classList.add(state);
}

function touchCal2SetPhase(phase) {
    touchCal2State.phase = phase;
    ['touchCalStepScreen', 'touchCalStepCoords', 'touchCalStepDone'].forEach((id) => {
        document.getElementById(id)?.classList.remove('active', 'done');
    });
    ['touchCalScreenPanel', 'touchCalCoordPanel', 'touchCalDonePanel'].forEach((id) => {
        document.getElementById(id)?.classList.remove('active');
    });

    const screenDone = phase === 'coords' || phase === 'done';
    const coordDone = phase === 'done';
    document.getElementById('touchCalStepScreen')?.classList.toggle('active', phase === 'screen');
    document.getElementById('touchCalStepScreen')?.classList.toggle('done', screenDone);
    document.getElementById('touchCalStepCoords')?.classList.toggle('active', phase === 'coords');
    document.getElementById('touchCalStepCoords')?.classList.toggle('done', coordDone);
    document.getElementById('touchCalStepDone')?.classList.toggle('active', phase === 'done');
    document.getElementById('touchCalScreenPanel')?.classList.toggle('active', phase === 'screen');
    document.getElementById('touchCalCoordPanel')?.classList.toggle('active', phase === 'coords');
    document.getElementById('touchCalDonePanel')?.classList.toggle('active', phase === 'done');
}

function touchCal2RenderProgress() {
    const progress = document.getElementById('touchCalProgress');
    if (progress) {
        progress.innerHTML = TOUCH_CAL2_STEPS.map((s, idx) => {
            const cls = idx < touchCal2State.step ? 'done' : (idx === touchCal2State.step && touchCal2State.active ? 'active' : '');
            return `<div class="touch-cal-progress-item ${cls}"><span>${idx + 1}</span><b>${s.shortLabel}</b></div>`;
        }).join('');
    }

    const target = document.getElementById('touchCalTarget');
    const current = TOUCH_CAL2_STEPS[touchCal2State.step];
    if (target) {
        target.classList.remove('visible', 'hit');
        if (touchCal2State.active && current) {
            target.style.left = current.x;
            target.style.top = current.y;
            target.classList.add('visible');
        }
    }

    const done = touchCal2State.step >= TOUCH_CAL2_STEPS.length;
    if (done) {
        touchCal2SetText('touchCalPromptTitle', touchCal2State.saving ? '正在保存校准数据' : '四个点已采集完成');
        touchCal2SetText('touchCalPromptText', '请稍等，正在计算坐标映射并下发到下位机。');
    } else if (touchCal2State.active && current) {
        touchCal2SetText('touchCalPromptTitle', `请触摸 ${current.label}`);
        touchCal2SetText('touchCalPromptText', '看准屏幕上的蓝色目标点，用手指轻点一次。收到样本后会自动进入下一个点。');
    } else {
        touchCal2SetText('touchCalPromptTitle', '点击“开始采样”');
        touchCal2SetText('touchCalPromptText', '开始后，下位机会进入采样模式。请按屏幕上的亮点位置依次触摸四个角，每个角只点一次。');
    }
}

function touchCal2ResetSamples() {
    touchCal2State.active = false;
    touchCal2State.step = 0;
    touchCal2State.samples = [];
    touchCal2State.saving = false;
    touchCal2RenderProgress();
    touchCal2SetStatus('touchCalCoordStatus', '准备就绪。请先点击“开始采样”。');
}

function touchCal2OpenPage() {
    touchCal2SetPhase('screen');
    touchCal2ResetSamples();
    touchCal2SetStatus('touchCalScreenStatus', '正在检测下位机触摸屏状态...', 'warn');
    sendMessage('hid', 'touchCalib', { action: 'get' }, (response) => {
        if (response?.code !== 0) {
            touchCal2SetStatus('touchCalScreenStatus', `读取触摸状态失败：${response?.msg || '未知错误'}`, 'error');
            return;
        }
        if (response.data?.touch_present === false) {
            touchCal2SetStatus('touchCalScreenStatus', '未检测到触摸屏，无法进行触摸校准。请确认触摸屏已连接并重启设备。', 'error');
            return;
        }
        const driver = response.data?.driver ? `（${response.data.driver}）` : '';
        touchCal2SetStatus('touchCalScreenStatus', `已检测到触摸屏${driver}。请先完成屏幕归属确认。`, 'ok');
    });
}

function touchCal2SwitchToDeviceScreen() {
    touchCal2SetStatus('touchCalScreenStatus', '正在查找设备屏幕并切换到横屏全屏...', 'warn');
    sendMessage('system', 'switchToDeviceScreen', {}, (response) => {
        if (response?.code === 0) {
            const rotatedText = response.data?.rotated ? '，已从竖屏切为横屏' : '';
            touchCal2SetStatus('touchCalScreenStatus', `已切换到设备屏幕${rotatedText}。请继续下一步。`, 'ok');
        } else {
            touchCal2SetStatus('touchCalScreenStatus', `切换失败：${response?.msg || '未知错误'}。如果界面已在设备屏幕，也可以继续下一步。`, 'error');
        }
    });
}

function touchCal2LaunchWindowsTouchMapper() {
    touchCal2SetStatus('touchCalScreenStatus', '正在打开 Windows 触摸屏归属校准工具...', 'warn');
    sendMessage('app', 'launch', { path: 'MultiDigiMon.exe', args: '-touch' }, (response) => {
        if (response?.code === 0) {
            touchCal2SetStatus('touchCalScreenStatus', '系统触摸归属校准已打开。完成后回到本向导继续坐标采样。', 'ok');
        } else {
            touchCal2SetStatus('touchCalScreenStatus', `启动失败：${response?.msg || '未知错误'}`, 'error');
        }
    });
}

function touchCal2GoCoordinateStep() {
    sendMessage('hid', 'touchCalib', { action: 'get' }, (response) => {
        if (response?.code !== 0) {
            touchCal2SetStatus('touchCalScreenStatus', `读取触摸状态失败：${response?.msg || '未知错误'}`, 'error');
            return;
        }
        if (response.data?.touch_present === false) {
            touchCal2SetStatus('touchCalScreenStatus', '未检测到触摸屏，无法继续。请确认触摸屏已连接并重启设备。', 'error');
            return;
        }
        touchCal2Stop(true);
        touchCal2ResetSamples();
        touchCal2SetPhase('coords');
    });
}

function touchCal2OnRequired(data) {
    if (touchCalibrationGuidePromptPort === 'device-required') return;
    touchCalibrationGuidePromptPort = 'device-required';
    const driver = data?.driver ? `（${data.driver}）` : '';
    showToast(`检测到触摸屏${driver}尚未校准，请完成触摸校准向导`, 6000);
    openPage('touch-calibration');
}

function touchCal2ComputeCfg(samples) {
    const tl = samples[0];
    const tr = samples[1];
    const br = samples[2];
    const bl = samples[3];
    const avg2 = (a, b) => (a + b) / 2;

    const left = { x: avg2(tl.raw_x, bl.raw_x), y: avg2(tl.raw_y, bl.raw_y) };
    const right = { x: avg2(tr.raw_x, br.raw_x), y: avg2(tr.raw_y, br.raw_y) };
    const swap_xy = Math.abs(right.x - left.x) < Math.abs(right.y - left.y);
    const axis = (p) => swap_xy ? { x: p.raw_y, y: p.raw_x } : { x: p.raw_x, y: p.raw_y };

    const atl = axis(tl);
    const atr = axis(tr);
    const abr = axis(br);
    const abl = axis(bl);
    const x_left = avg2(atl.x, abl.x);
    const x_right = avg2(atr.x, abr.x);
    const y_top = avg2(atl.y, atr.y);
    const y_bottom = avg2(abl.y, abr.y);
    const mirror_x = x_right < x_left;
    const mirror_y = y_bottom < y_top;

    const pad = 8;
    let in_min_x = Math.max(0, Math.floor(Math.min(x_left, x_right) - pad));
    let in_max_x = Math.max(in_min_x + 1, Math.ceil(Math.max(x_left, x_right) + pad));
    let in_min_y = Math.max(0, Math.floor(Math.min(y_top, y_bottom) - pad));
    let in_max_y = Math.max(in_min_y + 1, Math.ceil(Math.max(y_top, y_bottom) + pad));

    return {
        enabled: 1,
        swap_xy: swap_xy ? 1 : 0,
        mirror_x: mirror_x ? 1 : 0,
        mirror_y: mirror_y ? 1 : 0,
        in_min_x,
        in_max_x,
        in_min_y,
        in_max_y,
    };
}

function touchCal2Start() {
    if (touchCal2State.active || touchCal2State.saving) return false;
    touchCal2ResetSamples();
    touchCal2SetStatus('touchCalCoordStatus', '正在让下位机进入采样模式...', 'warn');
    sendMessage('hid', 'touchCalib', { action: 'start' }, (resp) => {
        if (resp?.code === 0) {
            touchCal2State.active = true;
            touchCal2RenderProgress();
            touchCal2SetStatus('touchCalCoordStatus', '采样已开始。请触摸屏幕上的蓝色目标点。', 'ok');
        } else {
            touchCal2SetStatus('touchCalCoordStatus', `采样启动失败：${resp?.msg || '未知错误'}`, 'error');
        }
    });
    return false;
}

function touchCal2Stop(silent = false) {
    if (!touchCal2State.active && !touchCal2State.saving) return;
    touchCal2State.active = false;
    touchCal2State.saving = false;
    sendMessage('hid', 'touchCalib', { action: 'stop' }, () => { });
    touchCal2RenderProgress();
    if (!silent) touchCal2SetStatus('touchCalCoordStatus', '采样已停止。可重新点击“开始采样”。', 'warn');
}

function touchCal2OnSample(d) {
    if (!touchCal2State.active || touchCal2State.saving) return;
    if (!d || typeof d.raw_x !== 'number' || typeof d.raw_y !== 'number') return;
    if (touchCal2State.step >= TOUCH_CAL2_STEPS.length) return;

    const step = TOUCH_CAL2_STEPS[touchCal2State.step];
    touchCal2State.samples.push({ raw_x: d.raw_x, raw_y: d.raw_y, src: d.src || '', contacts: d.contacts || 0 });
    touchCal2State.step++;

    const target = document.getElementById('touchCalTarget');
    if (target) {
        target.classList.add('hit');
        setTimeout(() => target.classList.remove('hit'), 260);
    }

    touchCal2SetStatus('touchCalCoordStatus', `已收到${step.label}样本：raw(${d.raw_x}, ${d.raw_y})`, 'ok');
    touchCal2RenderProgress();

    if (touchCal2State.step >= TOUCH_CAL2_STEPS.length) {
        touchCal2FinishSamples();
    }
}

function touchCal2FinishSamples() {
    touchCal2State.active = false;
    touchCal2State.saving = true;
    touchCal2RenderProgress();
    const writeFlash = !!document.getElementById('touchCal2WriteFlash')?.checked;
    const cfg = touchCal2ComputeCfg(touchCal2State.samples);
    touchCal2SetStatus('touchCalCoordStatus', '四个点已采集，正在保存到下位机...', 'warn');

    sendMessage('hid', 'touchCalib', { action: 'set', write_flash: writeFlash ? 1 : 0, cfg }, (resp) => {
        touchCal2State.saving = false;
        sendMessage('hid', 'touchCalib', { action: 'stop' }, () => { });
        if (resp?.code === 0) {
            touchCal2SetText('touchCalDoneText', writeFlash ? '配置已写入下位机 Flash，重启后仍会生效。' : '配置已应用到本次运行，重启后需要重新校准。');
            touchCal2SetPhase('done');
            showToast(writeFlash ? '触摸校准已保存' : '触摸校准已应用');
        } else {
            touchCal2SetStatus('touchCalCoordStatus', `保存失败：${resp?.msg || '未知错误'}。请重新采样。`, 'error');
            touchCal2State.step = 0;
            touchCal2State.samples = [];
            touchCal2RenderProgress();
        }
    });
}

window.touchCal2SwitchToDeviceScreen = touchCal2SwitchToDeviceScreen;
window.touchCal2LaunchWindowsTouchMapper = touchCal2LaunchWindowsTouchMapper;
window.touchCal2GoCoordinateStep = touchCal2GoCoordinateStep;
window.touchCal2Start = touchCal2Start;
window.touchCal2Stop = touchCal2Stop;
window.openTouchCalibration = () => openPage('touch-calibration');

// 全屏切换
let fullscreenActive = false;
function updateFullscreenButtonState(active) {
    const labelEl = document.getElementById('fullscreenLabel');

    if (labelEl) {
        labelEl.textContent = active ? '退出全屏' : '全屏';
    }
}
window.toggleFullscreen = () => {
    const targetState = !fullscreenActive;
    sendMessage('system', 'fullscreen', { enable: targetState }, (response) => {
        if (response.code === 0) {
            fullscreenActive = targetState;
            updateFullscreenButtonState(fullscreenActive);
            showToast(targetState ? '已请求全屏' : '已请求退出全屏');
        } else {
            showToast(`全屏操作失败: ${response.msg || '未知错误'}`);
        }
    });
};
// 初始化按钮文案
updateFullscreenButtonState(fullscreenActive);

// ========== 电子木鱼 ==========
let woodenFishCount = 0;
let woodenFishTodayCount = 0;
let woodenFishLastDate = '';
let woodenFishSoundEnabled = true;
let woodenFishAudioContext = null;

function getWoodenFishAudioContext() {
    if (!woodenFishAudioContext) {
        woodenFishAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (woodenFishAudioContext.state === 'suspended') {
        woodenFishAudioContext.resume().catch(() => { });
    }
    return woodenFishAudioContext;
}

// 加载木鱼功德数
function loadWoodenFishCount() {
    const saved = localStorage.getItem('woodenFishCount');
    const savedToday = localStorage.getItem('woodenFishTodayCount');
    const savedDate = localStorage.getItem('woodenFishLastDate');
    const today = new Date().toDateString();

    if (saved) {
        woodenFishCount = parseInt(saved, 10) || 0;
    }

    // 检查是否是新的一天
    if (savedDate === today && savedToday) {
        woodenFishTodayCount = parseInt(savedToday, 10) || 0;
    } else {
        // 新的一天，重置今日计数
        woodenFishTodayCount = 0;
        woodenFishLastDate = today;
        localStorage.setItem('woodenFishLastDate', today);
        localStorage.setItem('woodenFishTodayCount', '0');
    }

    updateWoodenFishDisplay();
}

// 保存木鱼功德数
function saveWoodenFishCount() {
    localStorage.setItem('woodenFishCount', woodenFishCount.toString());
    localStorage.setItem('woodenFishTodayCount', woodenFishTodayCount.toString());
    localStorage.setItem('woodenFishLastDate', new Date().toDateString());
}

// 更新显示
function updateWoodenFishDisplay() {
    const countElement = document.getElementById('woodenFishCount');
    const todayElement = document.getElementById('woodenFishToday');

    if (countElement) {
        countElement.textContent = woodenFishCount.toString();
    }
    if (todayElement) {
        todayElement.textContent = woodenFishTodayCount.toString();
    }
}

// 敲击木鱼
window.knockWoodenFish = (event) => {
    // 阻止事件冒泡，避免触发重置按钮
    if (event && event.target.tagName === 'BUTTON') {
        return;
    }

    woodenFishCount++;
    woodenFishTodayCount++;
    saveWoodenFishCount();
    updateWoodenFishDisplay();

    // 播放音效（使用 Web Audio API 生成木鱼音效）
    if (woodenFishSoundEnabled) {
        playWoodenFishSound();
    }

    // 触发动画
    const icon = document.getElementById('woodenFishIcon');
    if (icon) {
        icon.classList.remove('knock');
        void icon.offsetWidth; // 触发重排
        icon.classList.add('knock');
        setTimeout(() => icon.classList.remove('knock'), 300);
    }

    // 显示祝福语
    const blessingElement = document.getElementById('woodenFishBlessing');
    const blessings = [
        '功德+1 🙏',
        '心诚则灵 ✨',
        '阿弥陀佛 🕉️',
        '善哉善哉 🌟',
        '福慧双修 💫',
        '吉祥如意 🎋',
        '消灾延寿 🌸',
        '平安喜乐 🌈',
        '六时吉祥 ⭐',
        '法喜充满 🌺',
        '南无阿弥陀佛 🪷',
        '诸恶莫作 众善奉行 🌟'
    ];
    const blessing = blessings[Math.floor(Math.random() * blessings.length)];

    if (blessingElement) {
        blessingElement.textContent = blessing;
        blessingElement.classList.remove('show');
        void blessingElement.offsetWidth; // 触发重排
        blessingElement.classList.add('show');
        setTimeout(() => blessingElement.classList.remove('show'), 2000);
    }
};

// 重置功德数
window.resetWoodenFish = (event) => {
    event.stopPropagation(); // 阻止事件冒泡到父元素

    showModal('重置功德', '确定要重置所有功德数吗？', () => {
        woodenFishCount = 0;
        woodenFishTodayCount = 0;
        saveWoodenFishCount();
        updateWoodenFishDisplay();
        showToast('功德已重置 🙏');
    });
};

// 生成木鱼音效
function playWoodenFishSound() {
    try {
        const audioContext = getWoodenFishAudioContext();
        const now = audioContext.currentTime;

        // 短促木质敲击声，带带宽滤波模拟木鱼共振
        const mainOsc = audioContext.createOscillator();
        const overtoneOsc = audioContext.createOscillator();
        const bandpass = audioContext.createBiquadFilter();
        const gainNode = audioContext.createGain();

        bandpass.type = 'bandpass';
        bandpass.frequency.setValueAtTime(480, now);
        bandpass.Q.setValueAtTime(12, now);

        mainOsc.type = 'sine';
        mainOsc.frequency.setValueAtTime(420, now);
        mainOsc.frequency.exponentialRampToValueAtTime(220, now + 0.14);

        overtoneOsc.type = 'triangle';
        overtoneOsc.frequency.setValueAtTime(860, now);
        overtoneOsc.frequency.exponentialRampToValueAtTime(520, now + 0.1);

        gainNode.gain.setValueAtTime(0.001, now);
        gainNode.gain.linearRampToValueAtTime(0.28, now + 0.005);
        gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);

        mainOsc.connect(bandpass);
        overtoneOsc.connect(bandpass);
        bandpass.connect(gainNode);
        gainNode.connect(audioContext.destination);

        mainOsc.start(now);
        overtoneOsc.start(now);
        mainOsc.stop(now + 0.18);
        overtoneOsc.stop(now + 0.12);
    } catch (error) {
        console.error('Failed to play wooden fish sound:', error);
    }
}

// 页面加载时初始化
if (typeof window !== 'undefined') {
    window.addEventListener('DOMContentLoaded', loadWoodenFishCount);
}
// ========== 音乐控制 (SMTC兼容) ==========
// SMTC (System Media Transport Controls) 只支持基本的播放控制
// 不支持: 播放列表、进度条、音量控制等
let musicPlaying = true;
function updateMusicPlayButton(isPlaying) {
    const playBtn = document.getElementById('musicPlayBtn');
    if (!playBtn) return;

    musicPlaying = Boolean(isPlaying);
    playBtn.classList.toggle('is-playing', musicPlaying);

    const label = musicPlaying ? '暂停' : '播放';
    playBtn.setAttribute('aria-label', label);
    playBtn.title = label;
}

function updateMusicStatus(data) {
    // 从后端SMTC接收的音乐状态更新
    if (data.title !== undefined || data.artist !== undefined) {
        updateMusicTextWithAnimation(data.title, data.artist);
    }

    // 更新专辑封面（带动画）
    if (data.thumbnail !== undefined) {
        updateAlbumCoverWithAnimation(data.thumbnail);
    }

    if (data.isPlaying !== undefined) {
        updateMusicPlayButton(data.isPlaying);
    }
}
// ========== 音乐控制 ==========
let currentMediaSessionId = 0;
let mediaSessions = [];
let isBluetoothReceiveMode = false;
let musicPlayPauseRequestSeq = 0;

// 专辑封面切换动画
function updateAlbumCoverWithAnimation(thumbnail) {
    const albumElement = document.querySelector('.music-album');
    if (!albumElement) return;

    // 添加淡出效果
    albumElement.classList.add('fade-out');

    // 等待淡出动画完成后更新内容
    setTimeout(() => {
        if (thumbnail) {
            albumElement.style.backgroundImage = `url(${thumbnail})`;
            albumElement.style.backgroundSize = 'cover';
            albumElement.style.backgroundPosition = 'center';
            albumElement.textContent = ''; // 清除emoji
        } else {
            albumElement.style.backgroundImage = 'none';
            albumElement.textContent = '🎵'; // 恢复默认emoji
        }

        // 移除淡出，添加淡入效果
        albumElement.classList.remove('fade-out');
        albumElement.classList.add('fade-in');

        // 动画完成后清理class
        setTimeout(() => {
            albumElement.classList.remove('fade-in');
        }, 300);
    }, 300);
}

// 文字信息更新动画
function updateMusicTextWithAnimation(title, artist) {
    const titleElement = document.getElementById('musicTitle');
    const artistElement = document.getElementById('musicArtist');

    if (titleElement) {
        titleElement.textContent = title || '未在播放';
        titleElement.classList.remove('fade-text');
        void titleElement.offsetWidth; // 触发重排
        titleElement.classList.add('fade-text');
        setTimeout(() => titleElement.classList.remove('fade-text'), 300);
    }

    if (artistElement) {
        artistElement.textContent = artist || '等待媒体信息...';
        artistElement.classList.remove('fade-text');
        void artistElement.offsetWidth; // 触发重排
        artistElement.classList.add('fade-text');
        setTimeout(() => artistElement.classList.remove('fade-text'), 300);
    }
}

// 更新媒体信息
function updateMediaInfo() {
    // 首先检查蓝牙是否处于接收模式
    sendMessage('bluetooth', 'getMode', {}, (response) => {
        if (response && response.code === 0 && response.data && response.data.mode === 'receive') {
            isBluetoothReceiveMode = true;
            // 蓝牙接收模式下的媒体信息会通过事件推送
            document.getElementById('mediaSwitchBtn').style.display = 'none';
        } else {
            isBluetoothReceiveMode = false;
            // 非蓝牙模式，获取系统媒体信息
            getSystemMediaInfo();
        }
    });
}

// 获取系统媒体会话列表
function getSystemMediaInfo() {
    sendMessage('system', 'getMediaSessions', {}, (response) => {
        if (response && response.code === 0 && response.data) {
            mediaSessions = response.data.sessions || [];

            // 显示或隐藏切换按钮
            const switchBtn = document.getElementById('mediaSwitchBtn');
            if (mediaSessions.length > 1) {
                switchBtn.style.display = 'inline-flex';
            } else {
                switchBtn.style.display = 'none';
            }

            // 获取当前会话的媒体信息
            getCurrentMediaInfo();
        }
    });
}

// 获取当前媒体会话信息
function getCurrentMediaInfo() {
    sendMessage('system', 'getCurrentMediaInfo', { sessionId: currentMediaSessionId }, (response) => {
        if (response && response.code === 0 && response.data) {
            const { title, artist, isPlaying, thumbnail } = response.data;

            // 更新文字信息（带动画）
            updateMusicTextWithAnimation(title, artist);

            updateMusicPlayButton(isPlaying);

            // 更新专辑封面（带动画）
            updateAlbumCoverWithAnimation(thumbnail);
        }
    });
}

window.musicPlayPause = () => {
    const requestSeq = ++musicPlayPauseRequestSeq;
    const previousPlaying = musicPlaying;
    updateMusicPlayButton(!previousPlaying);

    const handleResponse = (response) => {
        if (requestSeq !== musicPlayPauseRequestSeq) return;
        if (!response || response.code !== 0) {
            updateMusicPlayButton(previousPlaying);
            showToast(`操作失败: ${response?.msg || '未知错误'}`);
            return;
        }

        if (!isBluetoothReceiveMode) {
            setTimeout(() => {
                if (requestSeq === musicPlayPauseRequestSeq) {
                    getCurrentMediaInfo();
                }
            }, 600);
        }
    };

    if (isBluetoothReceiveMode) {
        // 蓝牙模式
        sendMessage('bluetooth', 'playPause', null, handleResponse);
    } else {
        sendMessage('system', 'mediaPlayPause', { sessionId: currentMediaSessionId }, handleResponse);
    }
};

window.musicPrev = () => {
    if (isBluetoothReceiveMode) {
        sendMessage('bluetooth', 'previous', null, (response) => {
            if (response.code === 0) {
                showToast('上一首');
            } else {
                showToast(`操作失败: ${response.msg || '未知错误'}`);
            }
        });
    } else {
        // 系统媒体模式（后端会自动推送更新事件）
        sendMessage('system', 'mediaPrevious', { sessionId: currentMediaSessionId }, (response) => {
            if (response && response.code === 0) {
                showToast('上一首');
            } else {
                showToast('操作失败');
            }
        });
    }
};

window.musicNext = () => {
    if (isBluetoothReceiveMode) {
        sendMessage('bluetooth', 'next', null, (response) => {
            if (response.code === 0) {
                showToast('下一首');
            } else {
                showToast(`操作失败: ${response.msg || '未知错误'}`);
            }
        });
    } else {
        // 系统媒体模式（后端会自动推送更新事件）
        sendMessage('system', 'mediaNext', { sessionId: currentMediaSessionId }, (response) => {
            if (response && response.code === 0) {
                showToast('下一首');
            } else {
                showToast('操作失败');
            }
        });
    }
};

window.switchMediaSession = () => {
    if (mediaSessions.length <= 1) return;

    currentMediaSessionId = (currentMediaSessionId + 1) % mediaSessions.length;
    const session = mediaSessions[currentMediaSessionId];
    showToast(`切换到: ${session.sourceAppId || '媒体 ' + (currentMediaSessionId + 1)}`);

    // 切换会话时需要主动获取新会话的信息（不同于播放控制，切换会话不会触发后端事件）
    getCurrentMediaInfo();
};
// ========== 输入控制 ==========
let shortcutsEditMode = false;
let emojisEditMode = false;
let shortcuts = [];
let emojis = [];
window.switchInputTab = (tabName) => {
    // 移除所有tab的active状态
    document.querySelectorAll('.input-tab-button').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.input-tab-content').forEach(content => content.classList.remove('active'));

    // 激活对应的内容区域
    const tabContent = document.getElementById(tabName + '-tab');
    if (tabContent) {
        tabContent.classList.add('active');
    }

    // 根据onclick属性查找并激活对应的tab按钮
    const tabButtons = document.querySelectorAll('.input-tab-button');
    tabButtons.forEach(btn => {
        const onclickAttr = btn.getAttribute('onclick');
        if (onclickAttr && onclickAttr.includes(`'${tabName}'`)) {
            btn.classList.add('active');
        }
    });
};
function initInputControl() {
    // 加载快捷键
    const savedShortcuts = localStorage.getItem('shortcuts');
    if (savedShortcuts) {
        shortcuts = JSON.parse(savedShortcuts);
    } else {
        shortcuts = [
            { id: 1, label: '复制', key: 'Ctrl+C', icon: '⧉', group: 'EDIT', note: 'Clipboard' },
            { id: 2, label: '粘贴', key: 'Ctrl+V', icon: '📥', group: 'EDIT', note: 'Clipboard' },
            { id: 3, label: '剪切', key: 'Ctrl+X', icon: '✂️', group: 'EDIT', note: 'Clipboard' },
            { id: 4, label: '撤销', key: 'Ctrl+Z', icon: '↩️', group: 'EDIT', note: 'History' },
            { id: 5, label: '重做', key: 'Ctrl+Shift+Z', icon: '↪️', group: 'EDIT', note: 'History' },
            { id: 6, label: '保存', key: 'Ctrl+S', icon: '💾', group: 'EDIT', note: 'Project' },
            { id: 7, label: '查找', key: 'Ctrl+F', icon: '🔍', group: 'EDIT', note: 'Search' },
            { id: 8, label: '新标签页', key: 'Ctrl+T', icon: '➕', group: 'BROWSER', note: 'Tab' },
            { id: 9, label: '关闭标签页', key: 'Ctrl+W', icon: '✕', group: 'BROWSER', note: 'Tab' },
            { id: 10, label: '切换窗口', key: 'Alt+Tab', icon: '⇥', group: 'SYSTEM', note: 'Switch' },
            { id: 11, label: '显示桌面', key: 'Win+D', icon: '🪟', group: 'SYSTEM', note: 'Desktop' },
            { id: 12, label: '锁屏', key: 'Win+L', icon: '🔒', group: 'SYSTEM', note: 'Security' },
            { id: 13, label: '截图', key: 'Win+Shift+S', icon: '📸', group: 'SYSTEM', note: 'Capture' },
            {
                id: 14,
                label: '播放/暂停',
                icon: '⏯️',
                group: 'MEDIA',
                note: 'Consumer',
                lua: 'function OnEvent(event, arg)\n  if event == \"G_PRESSED\" then\n    PressKey(\"playpause\")\n  end\nend'
            },
            {
                id: 15,
                label: '下一首',
                icon: '⏭️',
                group: 'MEDIA',
                note: 'Consumer',
                lua: 'function OnEvent(event, arg)\n  if event == \"G_PRESSED\" then\n    PressKey(\"nexttrack\")\n  end\nend'
            },
            {
                id: 16,
                label: '上一首',
                icon: '⏮️',
                group: 'MEDIA',
                note: 'Consumer',
                lua: 'function OnEvent(event, arg)\n  if event == \"G_PRESSED\" then\n    PressKey(\"prevtrack\")\n  end\nend'
            },
            {
                id: 17,
                label: '音量增加',
                icon: '🔊',
                group: 'MEDIA',
                note: 'Consumer',
                lua: 'function OnEvent(event, arg)\n  if event == \"G_PRESSED\" then\n    PressKey(\"volumeup\")\n  end\nend'
            },
            {
                id: 18,
                label: '音量减少',
                icon: '🔉',
                group: 'MEDIA',
                note: 'Consumer',
                lua: 'function OnEvent(event, arg)\n  if event == \"G_PRESSED\" then\n    PressKey(\"volumedown\")\n  end\nend'
            },
            {
                id: 19,
                label: '静音',
                icon: '🔇',
                group: 'MEDIA',
                note: 'Consumer',
                lua: 'function OnEvent(event, arg)\n  if event == \"G_PRESSED\" then\n    PressKey(\"mute\")\n  end\nend'
            }
        ];
    }
    initLuaRuntime();
    // 加载Emoji
    const savedEmojis = localStorage.getItem('emojis');
    if (savedEmojis) {
        emojis = JSON.parse(savedEmojis);
    } else {
        // 内置20个常用emoji表情包
        emojis = [
            { type: 'emoji', content: '😀', isBuiltIn: true },
            { type: 'emoji', content: '😂', isBuiltIn: true },
            { type: 'emoji', content: '❤️', isBuiltIn: true },
            { type: 'emoji', content: '👍', isBuiltIn: true },
            { type: 'emoji', content: '🎉', isBuiltIn: true },
            { type: 'emoji', content: '🔥', isBuiltIn: true },
            { type: 'emoji', content: '✨', isBuiltIn: true },
            { type: 'emoji', content: '💯', isBuiltIn: true },
            { type: 'emoji', content: '🚀', isBuiltIn: true },
            { type: 'emoji', content: '👀', isBuiltIn: true },
            { type: 'emoji', content: '💪', isBuiltIn: true },
            { type: 'emoji', content: '🙏', isBuiltIn: true },
            { type: 'emoji', content: '😍', isBuiltIn: true },
            { type: 'emoji', content: '🤔', isBuiltIn: true },
            { type: 'emoji', content: '😎', isBuiltIn: true },
            { type: 'emoji', content: '🎵', isBuiltIn: true },
            { type: 'emoji', content: '📱', isBuiltIn: true },
            { type: 'emoji', content: '💻', isBuiltIn: true },
            { type: 'emoji', content: '☕', isBuiltIn: true },
            { type: 'emoji', content: '🌟', isBuiltIn: true }
        ];
    }
    renderShortcuts();
    renderEmojis();
    const addShortcutBtn = document.getElementById('addShortcut');
    if (addShortcutBtn) {
        addShortcutBtn.addEventListener('click', () => {
            showAddShortcutBtn();
        });
    }
    // 移除emoji编辑按钮的事件监听（已删除按钮）
}
function renderShortcuts() {
    const grid = document.getElementById('shortcutsGrid');
    if (window.UIShortcuts?.renderShortcutGrid) {
        window.UIShortcuts.renderShortcutGrid(grid, shortcuts, {
            onAdd: showAddShortcutBtn,
            onTap: runShortcutTap,
            onEdit: showEditShortcutModal,
            onDelete: (item) => {
                confirmModal(`确定删除“${String(item.label || '')}”吗？`, () => {
                    deleteShortcut(item.id);
                });
            },
        });
    }
}
async function runShortcutTap(shortcut) {
    await runShortcutMacro(shortcut, true);
    setTimeout(() => {
        runShortcutMacro(shortcut, false);
    }, 40);
}
function validateShortcutKeyInput(shortcutStr) {
    const parsed = parseShortcutKey(shortcutStr);
    if (!parsed) {
        return { valid: false, message: '按键组合格式不正确，请检查键名与分隔符' };
    }
    return { valid: true };
}
function validateLuaScriptInput(luaSource) {
    const trimmed = luaSource.trim();
    if (!trimmed) {
        return { valid: false, message: '请填写 Lua 脚本' };
    }
    const fengari = window.Fengari;
    if (!fengari || !fengari.lua || !fengari.lauxlib || !fengari.to_luastring || !fengari.to_jsstring) {
        return { valid: false, message: 'Lua 运行时未就绪，无法校验脚本' };
    }
    const { lua, lauxlib, to_luastring, to_jsstring } = fengari;
    const L = lauxlib.luaL_newstate();
    const status = lauxlib.luaL_loadstring(L, to_luastring(trimmed));
    if (status !== lua.LUA_OK) {
        const msg = to_jsstring(lua.lua_tostring(L, -1));
        lua.lua_pop(L, 1);
        if (lua.lua_close) {
            lua.lua_close(L);
        }
        const brief = msg ? msg.split('\n')[0] : '语法错误';
        return { valid: false, message: `Lua 脚本语法错误: ${brief}` };
    }
    if (lua.lua_close) {
        lua.lua_close(L);
    }
    return { valid: true };
}
function showShortcutModal(options) {
    const title = options && options.title ? options.title : '';
    const shortcut = options && options.shortcut ? options.shortcut : {};
    const modalBody = window.UIShortcuts?.buildShortcutModal
        ? window.UIShortcuts.buildShortcutModal(shortcut)
        : '';
    showModal(title, modalBody, () => {
        const { label, key, lua } = window.UIShortcuts?.readShortcutFormValues
            ? window.UIShortcuts.readShortcutFormValues()
            : { label: '', key: '', lua: '' };
        const hasKey = key.length > 0;
        const hasLua = lua.length > 0;
        if (!label) {
            showToast('请填写名称');
            return false;
        }
        if (hasKey && hasLua) {
            showToast('按键组合与 Lua 脚本只能二选一');
            return false;
        }
        if (!hasKey && !hasLua) {
            showToast('请提供按键组合或 Lua 脚本');
            return false;
        }
        if (hasKey) {
            const keyCheck = validateShortcutKeyInput(key);
            if (!keyCheck.valid) {
                showToast(keyCheck.message);
                return false;
            }
        }
        if (hasLua) {
            const luaCheck = validateLuaScriptInput(lua);
            if (!luaCheck.valid) {
                showToast(luaCheck.message);
                return false;
            }
        }
        if (options && typeof options.onSave === 'function') {
            options.onSave({ label, key, lua });
        }
    });
}

function showEditShortcutModal(shortcut) {
    sendMessage('system', 'setNoActivate', { enable: false });
    showShortcutModal({
        title: '编辑快捷键',
        shortcut,
        onSave: ({ label, key, lua }) => {
            if (window.UIShortcuts?.applyEditAndSave) {
                shortcuts = window.UIShortcuts.applyEditAndSave(shortcuts, shortcut, { label, key, lua });
            }
            renderShortcuts();
            showToast('已更新');
        }
    });
    sendMessage('system', 'setNoActivate', { enable: true });
}

function showAddShortcutBtn() {
    sendMessage('system', 'setNoActivate', { enable: false });
    showShortcutModal({
        title: '添加快捷键',
        onSave: ({ label, key, lua }) => {
            if (window.UIShortcuts?.appendShortcutAndSave) {
                shortcuts = window.UIShortcuts.appendShortcutAndSave(shortcuts, { label, key, lua });
            }
            renderShortcuts();
            showToast('已添加');
        }
    });
    sendMessage('system', 'setNoActivate', { enable: true });
}

window.deleteShortcut = (id) => {
    if (window.UIShortcuts?.removeShortcut) {
        shortcuts = window.UIShortcuts.removeShortcut(shortcuts, id);
    }
    renderShortcuts();
    showToast('已删除');
};
async function runShortcutMacro(shortcut, isPressed) {
    const key = shortcut.key ? shortcut.key.trim() : '';
    const lua = shortcut.lua ? shortcut.lua.trim() : '';
    if (key) {
        if (!isPressed) {
            return;
        }
        const success = await sendShortcutKey(key);
        if (success) {
            showToast('已发送: ' + shortcut.label);
        } else {
            showToast('发送失败: ' + shortcut.label, 'error');
        }
        return;
    }
    if (lua) {
        const eventName = isPressed ? 'G_PRESSED' : 'G_RELEASED';
        const ok = await runLuaMacro(lua, eventName, shortcut.id, 'kb', shortcut.label);
        if (!ok) {
            showToast('Lua macro error', 'error');
        }
        return;
    }
    if (isPressed) {
        showToast('Shortcut has no action', 'error');
    }
}
// ========== Lua macro runtime (Logitech G-series API subset) ==========
let luaInitPromise = null;
let luaRuntimeReady = false;
let luaModule = null;
const macroStates = new Map();
const LUA_KEY_TAP_DELAY_MS = 30;
let mKeyState = 1;
let enablePrimaryMouseButtonEvents = false;
function initLuaRuntime() {
    if (luaInitPromise) return;
    luaInitPromise = waitForFengariReady()
        .then((module) => {
            luaModule = module;
            luaRuntimeReady = true;
        })
        .catch((err) => {
            console.error('[Lua] init failed:', err);
        });
}
function waitForFengariReady() {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const timer = setInterval(() => {
            if (window.Fengari) {
                clearInterval(timer);
                resolve(window.Fengari);
                return;
            }
            if (Date.now() - start > 5000) {
                clearInterval(timer);
                reject(new Error('Fengari not loaded'));
            }
        }, 50);
    });
}
function createMacroContext(id, label) {
    return {
        id,
        label: label || String(id),
        startWallTime: Date.now(),
        nowOffset: 0,
        keyboard: {
            modifiers: 0,
            keys: []
        },
        mouse: {
            buttons: 0,
            x: 0,
            y: 0
        },
        queue: [],
        timers: []
    };
}
function scheduleAction(ctx, fn) {
    ctx.queue.push({ delayMs: ctx.nowOffset, fn });
}
function runMacroQueue(ctx) {
    let maxDelay = 0;
    ctx.queue.forEach(item => {
        const delay = Math.max(0, item.delayMs);
        if (delay > maxDelay) maxDelay = delay;
        const timer = setTimeout(() => {
            item.fn();
        }, delay);
        ctx.timers.push(timer);
    });
    ctx.queue = [];
    const cleanupTimer = setTimeout(() => {
        macroStates.delete(ctx.id);
    }, maxDelay + 100);
    ctx.timers.push(cleanupTimer);
}
function abortMacroById(id) {
    const ctx = macroStates.get(id);
    if (!ctx) return;
    ctx.timers.forEach(timer => clearTimeout(timer));
    ctx.timers = [];
    ctx.queue = [];
    macroStates.delete(id);
}
async function runLuaMacro(luaSource, eventName, arg, family, label) {
    if (!luaInitPromise) initLuaRuntime();
    await luaInitPromise;
    if (!luaRuntimeReady || !luaModule) return false;
    const ctx = createMacroContext(arg, label);
    macroStates.set(ctx.id, ctx);
    try {
        executeLuaMacro(luaSource, eventName, arg, family, ctx);
        runMacroQueue(ctx);
        return true;
    } catch (err) {
        console.error('[Lua] runtime error:', err);
        abortMacroById(ctx.id);
        return false;
    }
}
function executeLuaMacro(luaSource, eventName, arg, family, ctx) {
    const { lua, lauxlib, lualib, to_luastring, to_jsstring, interop } = luaModule;
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    lauxlib.luaL_requiref(L, to_luastring('js'), interop.luaopen_js, 1);
    lua.lua_pop(L, 1);
    registerLuaApi(L, ctx);
    const loadStatus = lauxlib.luaL_loadstring(L, to_luastring(luaSource));
    if (loadStatus !== lua.LUA_OK) {
        const msg = to_jsstring(lua.lua_tostring(L, -1));
        lua.lua_pop(L, 1);
        throw new Error(msg);
    }
    if (lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) {
        const msg = to_jsstring(lua.lua_tostring(L, -1));
        lua.lua_pop(L, 1);
        throw new Error(msg);
    }
    lua.lua_getglobal(L, to_luastring('OnEvent'));
    if (lua.lua_isfunction(L, -1)) {
        lua.lua_pushstring(L, to_luastring(eventName));
        lua.lua_pushinteger(L, arg || 0);
        if (family) {
            lua.lua_pushstring(L, to_luastring(family));
            if (lua.lua_pcall(L, 3, 0, 0) !== lua.LUA_OK) {
                const msg = to_jsstring(lua.lua_tostring(L, -1));
                lua.lua_pop(L, 1);
                throw new Error(msg);
            }
        } else {
            if (lua.lua_pcall(L, 2, 0, 0) !== lua.LUA_OK) {
                const msg = to_jsstring(lua.lua_tostring(L, -1));
                lua.lua_pop(L, 1);
                throw new Error(msg);
            }
        }
    } else {
        lua.lua_pop(L, 1);
    }
}
function registerLuaApi(L, ctx) {
    const { lua, to_luastring, to_jsstring } = luaModule;
    function getArgCount() {
        return lua.lua_gettop(L);
    }
    function getStringArg(idx) {
        if (!lua.lua_isstring(L, idx)) return null;
        return to_jsstring(lua.lua_tostring(L, idx));
    }
    function getNumberArg(idx) {
        if (!lua.lua_isnumber(L, idx)) return null;
        return lua.lua_tonumber(L, idx);
    }
    function getArgsAsList() {
        const n = getArgCount();
        const args = [];
        for (let i = 1; i <= n; i++) {
            if (lua.lua_isnumber(L, i)) {
                args.push(lua.lua_tonumber(L, i));
            } else if (lua.lua_isstring(L, i)) {
                args.push(to_jsstring(lua.lua_tostring(L, i)));
            }
        }
        return args;
    }
    function pushBoolean(value) {
        lua.lua_pushboolean(L, value ? 1 : 0);
    }
    function pushNumber(value) {
        lua.lua_pushnumber(L, value);
    }
    function setGlobal(name, fn) {
        lua.lua_pushcfunction(L, fn);
        lua.lua_setglobal(L, to_luastring(name));
    }
    setGlobal('Sleep', () => {
        const ms = getNumberArg(1) || 0;
        ctx.nowOffset += Math.max(0, ms);
        return 0;
    });
    setGlobal('OutputLogMessage', () => {
        const args = getArgsAsList();
        if (args.length === 0) return 0;
        const msg = formatLuaMessage(args[0], args.slice(1));
        console.log('[Lua]', msg);
        return 0;
    });
    setGlobal('OutputDebugMessage', () => {
        const args = getArgsAsList();
        if (args.length === 0) return 0;
        const msg = formatLuaMessage(args[0], args.slice(1));
        console.log('[Lua]', msg);
        return 0;
    });
    setGlobal('GetRunningTime', () => {
        pushNumber(Date.now() - ctx.startWallTime);
        return 1;
    });
    setGlobal('GetDate', () => {
        pushString(new Date().toString());
        return 1;
    });
    setGlobal('ClearLog', () => 0);
    setGlobal('OutputLCDMessage', () => 0);
    setGlobal('ClearLCD', () => 0);
    setGlobal('SetBacklightColor', () => 0);
    setGlobal('SetMouseDPITable', () => 0);
    setGlobal('SetMouseDPITableIndex', () => 0);
    setGlobal('EnablePrimaryMouseButtonEvents', () => {
        const enabled = lua.lua_toboolean(L, 1);
        enablePrimaryMouseButtonEvents = !!enabled;
        return 0;
    });
    setGlobal('GetMKeyState', () => {
        pushNumber(mKeyState);
        return 1;
    });
    setGlobal('SetMKeyState', () => {
        const state = getNumberArg(1);
        if (state) mKeyState = state;
        return 0;
    });
    setGlobal('PressKey', () => {
        const args = getArgsAsList();
        scheduleAction(ctx, () => applyKeyAction(ctx, 'down', args));
        return 0;
    });
    setGlobal('ReleaseKey', () => {
        const args = getArgsAsList();
        scheduleAction(ctx, () => applyKeyAction(ctx, 'up', args));
        return 0;
    });
    setGlobal('PressAndReleaseKey', () => {
        const args = getArgsAsList();
        scheduleAction(ctx, () => applyKeyAction(ctx, 'down', args));
        ctx.nowOffset += LUA_KEY_TAP_DELAY_MS;
        scheduleAction(ctx, () => applyKeyAction(ctx, 'up', args));
        return 0;
    });
    setGlobal('IsModifierPressed', () => {
        const key = (getStringArg(1) || '').toLowerCase();
        const mask = modifierMaskForKey(key);
        pushBoolean((ctx.keyboard.modifiers & mask) !== 0);
        return 1;
    });
    setGlobal('PressMouseButton', () => {
        const button = getNumberArg(1) || 0;
        scheduleAction(ctx, () => applyMouseButton(ctx, 'down', button));
        return 0;
    });
    setGlobal('ReleaseMouseButton', () => {
        const button = getNumberArg(1) || 0;
        scheduleAction(ctx, () => applyMouseButton(ctx, 'up', button));
        return 0;
    });
    setGlobal('PressAndReleaseMouseButton', () => {
        const button = getNumberArg(1) || 0;
        scheduleAction(ctx, () => applyMouseButton(ctx, 'down', button));
        ctx.nowOffset += LUA_KEY_TAP_DELAY_MS;
        scheduleAction(ctx, () => applyMouseButton(ctx, 'up', button));
        return 0;
    });
    setGlobal('IsMouseButtonPressed', () => {
        const button = getNumberArg(1) || 0;
        const mask = mouseButtonMask(button);
        pushBoolean((ctx.mouse.buttons & mask) !== 0);
        return 1;
    });
    setGlobal('MoveMouseRelative', () => {
        const x = getNumberArg(1) || 0;
        const y = getNumberArg(2) || 0;
        scheduleAction(ctx, () => sendMouseReport(ctx, x, y, 0));
        return 0;
    });
    setGlobal('MoveMouseWheel', () => {
        const value = getNumberArg(1) || 0;
        scheduleAction(ctx, () => sendMouseReport(ctx, 0, 0, value));
        return 0;
    });
    setGlobal('MoveMouseTo', () => {
        const x = getNumberArg(1);
        const y = getNumberArg(2);
        if (x != null && y != null) {
            scheduleAction(ctx, () => sendMouseToAbsolute(ctx, x, y));
        }
        return 0;
    });
    setGlobal('MoveMouseToVirtual', () => {
        const x = getNumberArg(1);
        const y = getNumberArg(2);
        if (x != null && y != null) {
            scheduleAction(ctx, () => sendMouseToAbsolute(ctx, x, y));
        }
        return 0;
    });
    setGlobal('GetMousePosition', () => {
        pushNumber(ctx.mouse.x || 0);
        pushNumber(ctx.mouse.y || 0);
        return 2;
    });
    setGlobal('PlayMacro', () => {
        const name = getStringArg(1);
        if (name) {
            const target = shortcuts.find(s => s.label === name || String(s.id) === name);
            if (target && target.lua) {
                runLuaMacro(target.lua, 'G_PRESSED', target.id, 'kb', target.label);
            }
        }
        return 0;
    });
    setGlobal('AbortMacro', () => {
        const name = getStringArg(1);
        if (name) {
            const target = shortcuts.find(s => s.label === name || String(s.id) === name);
            if (target) abortMacroById(target.id);
        } else {
            abortMacroById(ctx.id);
        }
        return 0;
    });
    setGlobal('IsKeyLockOn', () => {
        pushBoolean(false);
        return 1;
    });
    function pushString(value) {
        lua.lua_pushstring(L, to_luastring(value));
    }
}
function formatLuaMessage(format, args) {
    if (typeof format !== 'string') return String(format);
    let index = 0;
    return format.replace(/%[sdif]/g, () => {
        const value = args[index++];
        return value === undefined ? '' : String(value);
    });
}
function applyKeyAction(ctx, action, args) {
    const parsed = parseLuaKeyArgs(args);
    if (parsed.consumerMask) {
        sendConsumerReport(parsed.consumerMask);
        sendConsumerReport(0);
    }
    if (parsed.modifiersMask !== 0) {
        if (action === 'down') {
            ctx.keyboard.modifiers |= parsed.modifiersMask;
        } else {
            ctx.keyboard.modifiers &= ~parsed.modifiersMask;
        }
    }
    parsed.keyCodes.forEach(code => {
        if (action === 'down') {
            if (!ctx.keyboard.keys.includes(code)) {
                ctx.keyboard.keys.push(code);
            }
        } else {
            const idx = ctx.keyboard.keys.indexOf(code);
            if (idx >= 0) ctx.keyboard.keys.splice(idx, 1);
        }
    });
    sendKeyboardReport(ctx);
}
function parseLuaKeyArgs(args) {
    const keyCodes = [];
    let modifiersMask = 0;
    let consumerMask = 0;
    args.forEach(arg => {
        if (typeof arg === 'number') {
            const code = scancodeToHid(arg);
            if (code) keyCodes.push(code);
            return;
        }
        const name = String(arg).toLowerCase();
        const modMask = modifierMaskForKey(name);
        if (modMask) {
            modifiersMask |= modMask;
            return;
        }
        const consumer = consumerMaskForKey(name);
        if (consumer) {
            consumerMask |= consumer;
            return;
        }
        const keyCode = keyNameToHid(name);
        if (keyCode) keyCodes.push(keyCode);
    });
    return { keyCodes, modifiersMask, consumerMask };
}
function sendKeyboardReport(ctx) {
    // 使用通用的报文生成函数
    const report = generateKeyboardReport(ctx.keyboard);
    sendHIDReport(report);
}
function sendMouseReport(ctx, x, y, wheel) {
    // 使用通用的报文生成函数
    const report = generateMouseReport(ctx.mouse.buttons, x, y, wheel);
    sendHIDReport(report);
}
function sendMouseToAbsolute(ctx, x, y) {
    const dx = clampSignedByte(x - ctx.mouse.x);
    const dy = clampSignedByte(y - ctx.mouse.y);
    ctx.mouse.x = x;
    ctx.mouse.y = y;
    sendMouseReport(ctx, dx, dy, 0);
}
function applyMouseButton(ctx, action, button) {
    const mask = mouseButtonMask(button);
    if (action === 'down') {
        ctx.mouse.buttons |= mask;
    } else {
        ctx.mouse.buttons &= ~mask;
    }
    sendMouseReport(ctx, 0, 0, 0);
}
function clampSignedByte(value) {
    let v = Math.round(Number(value) || 0);
    if (v > 127) v = 127;
    if (v < -127) v = -127;
    return v & 0xFF;
}
function mouseButtonMask(button) {
    switch (button) {
        case 1: return 0x01;
        case 2: return 0x04;
        case 3: return 0x02;
        case 4: return 0x08;
        case 5: return 0x10;
        default: return 0x00;
    }
}
function modifierMaskForKey(name) {
    switch (name) {
        case 'lctrl':
        case 'ctrl':
            return 0x01;
        case 'lshift':
        case 'shift':
            return 0x02;
        case 'lalt':
        case 'alt':
            return 0x04;
        case 'lgui':
        case 'win':
        case 'gui':
            return 0x08;
        case 'rctrl':
            return 0x10;
        case 'rshift':
            return 0x20;
        case 'ralt':
            return 0x40;
        case 'rgui':
            return 0x80;
        default:
            return 0;
    }
}
function consumerMaskForKey(name) {
    switch (name) {
        case 'mute':
            return 1 << 0;
        case 'volumeup':
        case 'volup':
            return 1 << 1;
        case 'volumedown':
        case 'voldown':
            return 1 << 2;
        case 'nexttrack':
            return 1 << 3;
        case 'prevtrack':
            return 1 << 4;
        case 'stop':
            return 1 << 5;
        case 'playpause':
            return 1 << 6;
        case 'mail':
            return 1 << 8;
        case 'calculator':
            return 1 << 9;
        case 'mycomputer':
            return 1 << 10;
        case 'search':
            return 1 << 11;
        case 'home':
            return 1 << 12;
        case 'back':
            return 1 << 13;
        case 'forward':
            return 1 << 14;
        case 'acstop':
            return 1 << 15;
        default:
            return 0;
    }
}
function sendConsumerReport(mask) {
    const report = new Uint8Array(3);
    report[0] = 0x05;
    report[1] = mask & 0xFF;
    report[2] = (mask >> 8) & 0xFF;
    sendHIDReport(report);
}
function keyNameToHid(name) {
    return LOGI_KEYNAME_TO_HID[name] || 0;
}
function scancodeToHid(code) {
    return SCANCODE_TO_HID[code] || 0;
}
const LOGI_KEYNAME_TO_HID = {
    'a': 0x04, 'b': 0x05, 'c': 0x06, 'd': 0x07, 'e': 0x08, 'f': 0x09,
    'g': 0x0A, 'h': 0x0B, 'i': 0x0C, 'j': 0x0D, 'k': 0x0E, 'l': 0x0F,
    'm': 0x10, 'n': 0x11, 'o': 0x12, 'p': 0x13, 'q': 0x14, 'r': 0x15,
    's': 0x16, 't': 0x17, 'u': 0x18, 'v': 0x19, 'w': 0x1A, 'x': 0x1B,
    'y': 0x1C, 'z': 0x1D,
    '1': 0x1E, '2': 0x1F, '3': 0x20, '4': 0x21, '5': 0x22,
    '6': 0x23, '7': 0x24, '8': 0x25, '9': 0x26, '0': 0x27,
    'enter': 0x28,
    'escape': 0x29,
    'esc': 0x29,
    'backspace': 0x2A,
    'tab': 0x2B,
    'spacebar': 0x2C,
    'space': 0x2C,
    'minus': 0x2D,
    'equals': 0x2E,
    'lbracket': 0x2F,
    'rbracket': 0x30,
    'backslash': 0x31,
    'semicolon': 0x33,
    'apostrophe': 0x34,
    'grave': 0x35,
    'tilde': 0x35,
    'comma': 0x36,
    'period': 0x37,
    'slash': 0x38,
    'capslock': 0x39,
    'f1': 0x3A, 'f2': 0x3B, 'f3': 0x3C, 'f4': 0x3D, 'f5': 0x3E, 'f6': 0x3F,
    'f7': 0x40, 'f8': 0x41, 'f9': 0x42, 'f10': 0x43, 'f11': 0x44, 'f12': 0x45,
    'printscreen': 0x46,
    'scrolllock': 0x47,
    'pause': 0x48,
    'insert': 0x49,
    'home': 0x4A,
    'pageup': 0x4B,
    'delete': 0x4C,
    'end': 0x4D,
    'pagedown': 0x4E,
    'right': 0x4F,
    'left': 0x50,
    'down': 0x51,
    'up': 0x52,
    'numlock': 0x53
};
const SCANCODE_TO_HID = {
    0x01: 0x29,
    0x02: 0x1E, 0x03: 0x1F, 0x04: 0x20, 0x05: 0x21, 0x06: 0x22,
    0x07: 0x23, 0x08: 0x24, 0x09: 0x25, 0x0A: 0x26, 0x0B: 0x27,
    0x0C: 0x2D, 0x0D: 0x2E, 0x0E: 0x2A,
    0x0F: 0x2B, 0x10: 0x14, 0x11: 0x1A, 0x12: 0x08, 0x13: 0x15,
    0x14: 0x17, 0x15: 0x1C, 0x16: 0x18, 0x17: 0x0C, 0x18: 0x12,
    0x19: 0x13, 0x1A: 0x2F, 0x1B: 0x30, 0x1C: 0x28, 0x1D: 0xE0,
    0x1E: 0x04, 0x1F: 0x16, 0x20: 0x07, 0x21: 0x09, 0x22: 0x0A,
    0x23: 0x0B, 0x24: 0x0D, 0x25: 0x0E, 0x26: 0x0F, 0x27: 0x33,
    0x28: 0x34, 0x29: 0x35, 0x2A: 0xE1, 0x2B: 0x31, 0x2C: 0x1D,
    0x2D: 0x1B, 0x2E: 0x06, 0x2F: 0x19, 0x30: 0x05, 0x31: 0x11,
    0x32: 0x10, 0x33: 0x36, 0x34: 0x37, 0x35: 0x38, 0x36: 0xE5,
    0x39: 0x2C, 0x3A: 0x39,
    0x3B: 0x3A, 0x3C: 0x3B, 0x3D: 0x3C, 0x3E: 0x3D, 0x3F: 0x3E,
    0x40: 0x3F, 0x41: 0x40, 0x42: 0x41, 0x43: 0x42, 0x44: 0x43,
    0x45: 0x44, 0x46: 0x45,
    0x47: 0x47, 0x48: 0x52, 0x49: 0x49, 0x4B: 0x50, 0x4D: 0x4F,
    0x4F: 0x4D, 0x50: 0x51, 0x51: 0x4E, 0x52: 0x4C
};
function dataUrlToBlob(dataUrl) {
    const parts = String(dataUrl).split(',');
    if (parts.length < 2) return null;
    const header = parts[0];
    const data = parts[1];
    const match = header.match(/data:(.*?);base64/i);
    const mime = match ? match[1] : 'image/png';
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
}
async function copyEmojiItemToClipboard(emojiItem) {
    if (!emojiItem) return false;
    if (emojiItem.type === 'image') {
        if (!navigator.clipboard || !navigator.clipboard.write || !window.ClipboardItem) {
            return false;
        }
        try {
            const blob = dataUrlToBlob(emojiItem.content);
            if (!blob) return false;
            await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
            return true;
        } catch (err) {
            console.error('[Emoji] Copy image failed:', err);
            return false;
        }
    }
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
        return false;
    }
    try {
        await navigator.clipboard.writeText(emojiItem.content || '');
        return true;
    } catch (err) {
        console.error('[Emoji] Copy text failed:', err);
        return false;
    }
}
function renderEmojis() {
    const grid = document.getElementById('emojiGrid');
    grid.innerHTML = '';
    if (window.UIMisc?.renderEmojiGrid) {
        window.UIMisc.renderEmojiGrid(grid, emojis, {
            onAdd: showAddEmojiBtn,
            onDelete: (index) => {
                confirmModal('确定删除这个表情吗?', () => {
                    deleteEmoji(index);
                });
            },
            onClick: async (emojiItem) => {
                const content = emojiItem.type === 'image' ? '[图片表情]' : emojiItem.content;
                const copied = await copyEmojiItemToClipboard(emojiItem);
                if (!copied) {
                    showToast('复制失败，请允许剪切板权限');
                    return;
                }
                const pasted = await sendShortcutKey('Ctrl+V');
                if (!pasted) {
                    showToast('发送粘贴快捷键失败');
                    return;
                }
                showToast('已插入: ' + content);
            },
        });
    }
}
function showAddEmojiBtn() {
    // 计算emoji网格最大容量 (12列 × 可见行数)
    const maxEmojiCount = 12 * 5; // 12列 × 5行 = 60个
    if (emojis.length >= maxEmojiCount) {
        showToast('表情包已满，无法添加新表情');
        return;
    }
    const remainingSlots = maxEmojiCount - emojis.length;
    const modalBody = window.UIMisc?.buildEmojiModal
        ? window.UIMisc.buildEmojiModal(remainingSlots)
        : '';
    showModal('添加表情', modalBody, () => {
        const { emojiText, imageFiles } = window.UIMisc?.readEmojiFormValues
            ? window.UIMisc.readEmojiFormValues()
            : { emojiText: '', imageFiles: [] };
        if (!emojiText && imageFiles.length === 0) {
            showToast('请输入Emoji或选择图片');
            return false; // 阻止关闭modal
        }
        if (emojis.length >= maxEmojiCount) {
            showToast('表情包已满，无法添加');
            return false; // 阻止关闭modal
        }
        if (imageFiles.length > 0) {
            // 批量处理图片上传
            const filesToProcess = Math.min(imageFiles.length, remainingSlots);
            let processed = 0;
            if (filesToProcess < imageFiles.length) {
                showToast(`空间不足，仅添加前${filesToProcess}个图片`);
            }
            // 在modal中添加进度条
            const progressContainer = window.UIMisc?.createEmojiUploadProgress
                ? window.UIMisc.createEmojiUploadProgress(filesToProcess)
                : document.createElement('div');
            const modalBody = document.getElementById('modalBody');
            modalBody.appendChild(progressContainer);
            for (let i = 0; i < filesToProcess; i++) {
                const reader = new FileReader();
                reader.onload = (e) => {
                    const base64 = e.target.result;
                    emojis.push({
                        type: 'image',
                        content: base64,
                        isBuiltIn: false
                    });
                    processed++;
                    // 更新进度条
                    if (window.UIMisc?.updateEmojiUploadProgress) {
                        window.UIMisc.updateEmojiUploadProgress(processed, filesToProcess);
                    }
                    if (processed === filesToProcess) {
                        // 所有图片都处理完成后再保存
                        if (window.UIMisc?.saveEmojis) {
                            window.UIMisc.saveEmojis(emojis);
                        }
                        renderEmojis();
                        showToast(`✅ 已成功添加 ${filesToProcess} 个图片表情`);
                        // 正确关闭modal
                        if (window.UIMisc?.closeMainModalSilently) {
                            window.UIMisc.closeMainModalSilently();
                        }
                    }
                };
                reader.onerror = () => {
                    console.error(`图片 ${i + 1} 读取失败`);
                    processed++;
                    // 更新进度条
                    if (window.UIMisc?.updateEmojiUploadProgress) {
                        window.UIMisc.updateEmojiUploadProgress(processed, filesToProcess);
                    }
                    if (processed === filesToProcess) {
                        if (window.UIMisc?.saveEmojis) {
                            window.UIMisc.saveEmojis(emojis);
                        }
                        renderEmojis();
                        showToast(`部分图片添加失败，已添加 ${emojis.length - (maxEmojiCount - remainingSlots)} 个`);
                        // 正确关闭modal
                        if (window.UIMisc?.closeMainModalSilently) {
                            window.UIMisc.closeMainModalSilently();
                        }
                    }
                };
                reader.readAsDataURL(imageFiles[i]);
            }
            return false; // 阻止立即关闭modal，等待异步处理完成
        } else if (emojiText) {
            // 添加文本emoji
            emojis.push({
                type: 'emoji',
                content: emojiText,
                isBuiltIn: false
            });
            if (window.UIMisc?.saveEmojis) {
                window.UIMisc.saveEmojis(emojis);
            }
            renderEmojis();
            showToast('✅ Emoji已添加');
            return true; // 允许关闭modal
        }
    });
    // 添加图片预览功能
    setTimeout(() => {
        const imageInput = document.getElementById('emojiImage');
        const preview = document.getElementById('imagePreview');
        if (imageInput) {
            imageInput.addEventListener('change', (e) => {
                const files = e.target.files;
                if (files.length > 0) {
                    preview.innerHTML = '';
                    const filesToShow = Math.min(files.length, remainingSlots);
                    for (let i = 0; i < filesToShow; i++) {
                        const reader = new FileReader();
                        reader.onload = (event) => {
                            const imgContainer = window.UIComponents?.createEmojiPreviewImage
                                ? window.UIComponents.createEmojiPreviewImage(event.target.result)
                                : document.createElement('div');
                            preview.appendChild(imgContainer);
                        };
                        reader.readAsDataURL(files[i]);
                    }
                    if (files.length > remainingSlots) {
                        const warning = document.createElement('div');
                        warning.style.cssText = 'grid-column: 1 / -1; padding: 8px; background: rgba(255, 149, 0, 0.1); border-radius: 6px; font-size: 12px; color: var(--accent-orange); text-align: center;';
                        warning.textContent = `⚠️ 已选择${files.length}张,仅能添加${remainingSlots}张`;
                        preview.appendChild(warning);
                    }
                }
            });
        }
    }, 100);
}
window.deleteEmoji = (index) => {
    emojis.splice(index, 1);
    if (window.UIMisc?.saveEmojis) {
        window.UIMisc.saveEmojis(emojis);
    }
    renderEmojis();
    showToast('已删除');
};
// ========== 浏览器控制 ==========
let currentZoom = 100;
const BROWSER_SHORTCUTS = {
    back: 'Alt+ArrowLeft',
    forward: 'Alt+ArrowRight',
    refresh: 'Ctrl+R',
    home: 'Alt+Home',
    newTab: 'Ctrl+T',
    closeTab: 'Ctrl+W',
    bookmark: 'Ctrl+D',
    downloads: 'Ctrl+J',
    history: 'Ctrl+H',
    print: 'Ctrl+P',
    find: 'Ctrl+F',
    devTools: 'F12',
    zoomIn: 'Ctrl+Shift+Equal',
    zoomOut: 'Ctrl+Minus',
    zoomReset: 'Ctrl+0'
};
const BROWSER_ZOOM_STEP = 10;
const BROWSER_ZOOM_MIN = 25;
const BROWSER_ZOOM_MAX = 500;
function setBrowserZoom(value) {
    currentZoom = Math.max(BROWSER_ZOOM_MIN, Math.min(BROWSER_ZOOM_MAX, value));
    const zoomValue = document.getElementById('zoom-value');
    if (zoomValue) {
        zoomValue.textContent = `${currentZoom}%`;
    }
}
async function triggerBrowserShortcut(shortcut, label) {
    const ok = await sendShortcutKey(shortcut);
    if (!ok) {
        const message = label ? `${label}发送失败` : '快捷键发送失败';
        showToast(message);
    }
    return ok;
}
window.browserBack = () => triggerBrowserShortcut(BROWSER_SHORTCUTS.back, '后退');
window.browserForward = () => triggerBrowserShortcut(BROWSER_SHORTCUTS.forward, '前进');
window.browserRefresh = () => triggerBrowserShortcut(BROWSER_SHORTCUTS.refresh, '刷新');
window.browserHome = () => triggerBrowserShortcut(BROWSER_SHORTCUTS.home, '主页');
window.newTab = () => triggerBrowserShortcut(BROWSER_SHORTCUTS.newTab, '新标签');
window.closeTab = () => triggerBrowserShortcut(BROWSER_SHORTCUTS.closeTab, '关闭标签');
window.bookmarkPage = () => triggerBrowserShortcut(BROWSER_SHORTCUTS.bookmark, '收藏');
window.openDownloads = () => triggerBrowserShortcut(BROWSER_SHORTCUTS.downloads, '下载');
window.openHistory = () => triggerBrowserShortcut(BROWSER_SHORTCUTS.history, '历史记录');
window.openPrint = () => triggerBrowserShortcut(BROWSER_SHORTCUTS.print, '打印');
window.openFind = () => triggerBrowserShortcut(BROWSER_SHORTCUTS.find, '查找');
window.openDevTools = () => triggerBrowserShortcut(BROWSER_SHORTCUTS.devTools, '开发者工具');
window.zoomIn = async () => {
    const ok = await triggerBrowserShortcut(BROWSER_SHORTCUTS.zoomIn, '放大');
    if (ok) setBrowserZoom(currentZoom + BROWSER_ZOOM_STEP);
};
window.zoomOut = async () => {
    const ok = await triggerBrowserShortcut(BROWSER_SHORTCUTS.zoomOut, '缩小');
    if (ok) setBrowserZoom(currentZoom - BROWSER_ZOOM_STEP);
};
window.zoomReset = async () => {
    const ok = await triggerBrowserShortcut(BROWSER_SHORTCUTS.zoomReset, '重置缩放');
    if (ok) setBrowserZoom(100);
};
setBrowserZoom(currentZoom);

// ========== 性能监控 ==========
const monitorData = {
    cpu: [], memory: [], temperature: [], networkDown: [], networkUp: []
};
const MAX_DATA_POINTS = 30;
const CHART_ANIMATION_DURATION = 520;
let monitorUpdateInterval = null;
let chartAnimations = {};
function initMonitoring() {
    if (monitorUpdateInterval) {
        clearInterval(monitorUpdateInterval);
        monitorUpdateInterval = null;
    }
    const intervalSelect = document.getElementById('updateInterval');
    if (intervalSelect) {
        intervalSelect.style.display = 'none';
    }
    drawAllMonitorCharts();
    console.log('[Monitor] 性能监控详情页已初始化，数据来自订阅推送');
}

function sendAudioCommandWithTimeout(cmd, data = null, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
        sendMessageWithTimeout('audio', cmd, data, timeoutMs, (response) => {
            if (response?.code === 0) resolve(response);
            else reject(response || { code: 5, msg: '设备未返回响应' });
        });
    });
}

function sendRK628AudioCommandWithTimeout(action, data = null, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
        const commandData = { action };
        if (data) commandData.data = data;
        sendMessageWithTimeout('panel', 'rk628Config', commandData, timeoutMs, (response) => {
            if (response?.code === 0) resolve(response);
            else reject(response || { code: 5, msg: '设备未返回响应' });
        });
    });
}

function getLastFiniteValue(values, fallback = 0) {
    for (let index = values.length - 1; index >= 0; index--) {
        const value = Number(values[index]);
        if (Number.isFinite(value)) return value;
    }
    return fallback;
}

function getAnimatedValue(animation, now = performance.now()) {
    if (!animation) return null;
    const progress = Math.min(1, Math.max(0, (now - animation.startedAt) / CHART_ANIMATION_DURATION));
    const eased = 1 - Math.pow(1 - progress, 3);
    return animation.from + (animation.to - animation.from) * eased;
}

function startChartAnimation(canvasId, fromValue, toValue) {
    const current = getAnimatedValue(chartAnimations[canvasId]);
    chartAnimations[canvasId] = {
        from: Number.isFinite(current) ? current : fromValue,
        to: toValue,
        startedAt: performance.now(),
        frameId: null
    };
}

function prepareChartCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, width, height };
}

function updateMonitorValue(id, text) {
    const element = document.getElementById(id);
    if (!element || element.textContent === text) return;
    element.textContent = text;
    element.classList.remove('is-updating');
    void element.offsetWidth;
    element.classList.add('is-updating');
}

function updateMonitorData(data) {
    const cpu = Number(data.cpu) || 0;
    const memoryTotal = Number(data.memoryTotal) || 0;
    const memory = Number(data.memory) || 0;
    const memoryPercent = memoryTotal > 0 ? (memory / memoryTotal) * 100 : 0;
    const temperature = Number(data.temperature) || 0;
    const networkDown = Number(data.network.download) || 0;
    const networkUp = Number(data.network.upload) || 0;
    const previous = {
        cpu: getLastFiniteValue(monitorData.cpu, cpu),
        memory: getLastFiniteValue(monitorData.memory, memoryPercent),
        temperature: getLastFiniteValue(monitorData.temperature, temperature),
        networkDown: getLastFiniteValue(monitorData.networkDown, networkDown),
        networkUp: getLastFiniteValue(monitorData.networkUp, networkUp)
    };

    monitorData.cpu.push(cpu);
    monitorData.memory.push(memoryPercent);
    if (temperature > 0) monitorData.temperature.push(temperature);
    monitorData.networkDown.push(networkDown);
    monitorData.networkUp.push(networkUp);
    Object.keys(monitorData).forEach(key => {
        if (monitorData[key].length > MAX_DATA_POINTS) monitorData[key].shift();
    });

    startChartAnimation('cpuChart', previous.cpu, cpu);
    startChartAnimation('memChart', previous.memory, memoryPercent);
    if (temperature > 0) startChartAnimation('tempChart', previous.temperature, temperature);
    startChartAnimation('netChartDown', previous.networkDown, networkDown);
    startChartAnimation('netChartUp', previous.networkUp, networkUp);

    updateMonitorValue('cpuValue', `${Math.round(cpu)}%`);
    updateMonitorValue('memValue', `${(memory / 1024).toFixed(1)} / ${(memoryTotal / 1024).toFixed(1)} GB`);
    updateMonitorValue('tempValue', temperature > 0 ? `${Math.round(temperature)}°C` : 'N/A');
    updateMonitorValue('netValue', `↓ ${formatSpeed(networkDown)}  ↑ ${formatSpeed(networkUp)}`);

    const cpuTempDanger = parseInt(localStorage.getItem('cpuTempDanger') || '85');
    const cpuTempWarning = parseInt(localStorage.getItem('cpuTempWarning') || '70');
    const tempValue = document.getElementById('tempValue');
    if (temperature > cpuTempDanger) {
        tempValue.classList.add('danger');
        tempValue.classList.remove('warning');
    } else if (temperature > cpuTempWarning) {
        tempValue.classList.add('warning');
        tempValue.classList.remove('danger');
    } else {
        tempValue.classList.remove('warning', 'danger');
    }
    drawAllMonitorCharts();
}

function drawAllMonitorCharts() {
    drawChart('cpuChart', monitorData.cpu, { color: '#0a84ff', unit: '%', minY: 0, maxY: 100 });
    drawChart('memChart', monitorData.memory, { color: '#30d158', unit: '%', minY: 0, maxY: 100 });
    drawChart('tempChart', monitorData.temperature, { color: '#ff9f0a', unit: '°C', minY: 0, maxY: 100 });
    drawNetworkChart();
}

function formatChartValue(value, unit, decimals = 0) {
    return `${Number(value).toFixed(decimals)}${unit}`;
}

function drawChartLabel(ctx, text, x, y, color, bounds, placement = 'above') {
    ctx.save();
    ctx.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    const width = ctx.measureText(text).width + 16;
    const height = 24;
    const left = Math.min(bounds.right - width, Math.max(bounds.left, x - width / 2));
    const preferredTop = placement === 'below' ? y + 10 : y - height - 12;
    const top = Math.min(bounds.bottom - height, Math.max(bounds.top, preferredTop));
    ctx.fillStyle = 'rgba(20, 20, 24, 0.9)';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(left, top, width, height, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, left + width / 2, top + height / 2);
    ctx.restore();
}

function getChartPoints(data, animation, plot, minY, maxY) {
    const values = data.map(value => Number(value)).filter(Number.isFinite);
    if (values.length === 0) return [];
    const animatedValue = getAnimatedValue(animation);
    if (Number.isFinite(animatedValue)) values[values.length - 1] = animatedValue;
    const xStep = (plot.right - plot.left) / (MAX_DATA_POINTS - 1);
    const yRange = Math.max(1, maxY - minY);
    return values.map((value, index) => ({
        x: plot.right - (values.length - 1 - index) * xStep,
        y: plot.bottom - ((Math.min(maxY, Math.max(minY, value)) - minY) / yRange) * (plot.bottom - plot.top),
        value
    }));
}

function traceSmoothLine(ctx, points, continuePath = false) {
    points.forEach((point, index) => {
        if (index === 0) {
            if (!continuePath) ctx.moveTo(point.x, point.y);
            return;
        }
        const previous = points[index - 1];
        const middleX = (previous.x + point.x) / 2;
        ctx.bezierCurveTo(middleX, previous.y, middleX, point.y, point.x, point.y);
    });
}

function scheduleChartFrame(canvasId, draw) {
    const animation = chartAnimations[canvasId];
    if (!animation || getAnimatedValue(animation) === animation.to) return;
    if (animation.frameId) cancelAnimationFrame(animation.frameId);
    animation.frameId = requestAnimationFrame(() => {
        animation.frameId = null;
        draw();
    });
}

function drawChart(canvasId, data, options) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const { color, unit, minY, maxY } = options;
    const { ctx, width, height } = prepareChartCanvas(canvas);
    const plot = { left: 62, right: width - 24, top: 30, bottom: height - 30 };
    ctx.clearRect(0, 0, width, height);
    ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillStyle = 'rgba(235, 235, 245, 0.56)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
        const y = plot.top + (plot.bottom - plot.top) * (i / 4);
        const value = Math.round(maxY - (maxY - minY) * (i / 4));
        ctx.strokeStyle = i === 0 || i === 4 ? 'rgba(255, 255, 255, 0.13)' : 'rgba(255, 255, 255, 0.07)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(plot.left, y);
        ctx.lineTo(plot.right, y);
        ctx.stroke();
        ctx.fillText(formatChartValue(value, unit), plot.left - 10, y);
    }
    const points = getChartPoints(data, chartAnimations[canvasId], plot, minY, maxY);
    if (points.length > 0) {
        const gradient = ctx.createLinearGradient(0, plot.top, 0, plot.bottom);
        gradient.addColorStop(0, `${color}52`);
        gradient.addColorStop(1, `${color}05`);
        ctx.beginPath();
        ctx.moveTo(points[0].x, plot.bottom);
        ctx.lineTo(points[0].x, points[0].y);
        traceSmoothLine(ctx, points, true);
        ctx.lineTo(points[points.length - 1].x, plot.bottom);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();

        ctx.beginPath();
        traceSmoothLine(ctx, points);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.shadowColor = `${color}80`;
        ctx.shadowBlur = 8;
        ctx.stroke();
        ctx.shadowBlur = 0;

        const latest = points[points.length - 1];
        ctx.beginPath();
        ctx.arc(latest.x, latest.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.stroke();
        drawChartLabel(ctx, formatChartValue(latest.value, unit), latest.x, latest.y, color, plot);
    }
    ctx.fillStyle = 'rgba(235, 235, 245, 0.48)';
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('60 秒前', plot.left, height - 8);
    ctx.fillText('现在', plot.right, height - 8);
    scheduleChartFrame(canvasId, () => drawChart(canvasId, data, options));
}

function drawNetworkChart() {
    const canvas = document.getElementById('netChart');
    if (!canvas) return;
    const { ctx, width, height } = prepareChartCanvas(canvas);
    const plot = { left: 88, right: width - 24, top: 34, bottom: height - 30 };
    ctx.clearRect(0, 0, width, height);
    const peakValue = Math.max(...monitorData.networkDown, ...monitorData.networkUp, 0);
    const maxValue = Math.max(1024, peakValue * 1.15);
    ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillStyle = 'rgba(235, 235, 245, 0.56)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
        const y = plot.top + (plot.bottom - plot.top) * (i / 4);
        const valueBytes = maxValue * (4 - i) / 4;
        ctx.strokeStyle = i === 0 || i === 4 ? 'rgba(255, 255, 255, 0.13)' : 'rgba(255, 255, 255, 0.07)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(plot.left, y);
        ctx.lineTo(plot.right, y);
        ctx.stroke();
        ctx.fillText(formatSpeed(valueBytes), plot.left - 10, y);
    }
    drawSmoothLine(ctx, monitorData.networkDown, '#0a84ff', plot, maxValue, '↓', chartAnimations.netChartDown, 'above');
    drawSmoothLine(ctx, monitorData.networkUp, '#30d158', plot, maxValue, '↑', chartAnimations.netChartUp, 'below');
    ctx.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#0a84ff';
    ctx.fillText('↓ 下载', plot.left, 18);
    ctx.fillStyle = '#30d158';
    ctx.fillText('↑ 上传', plot.left + 72, 18);
    ctx.fillStyle = 'rgba(235, 235, 245, 0.48)';
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('60 秒前', plot.left, height - 8);
    ctx.fillText('现在', plot.right, height - 8);
    scheduleChartFrame('netChartDown', drawNetworkChart);
    scheduleChartFrame('netChartUp', drawNetworkChart);
}
function drawSmoothLine(ctx, data, color, plot, maxValue, label, animation, placement) {
    const points = getChartPoints(data, animation, plot, 0, maxValue);
    if (points.length === 0) return;
    const gradient = ctx.createLinearGradient(0, plot.top, 0, plot.bottom);
    gradient.addColorStop(0, `${color}38`);
    gradient.addColorStop(1, `${color}04`);
    ctx.beginPath();
    ctx.moveTo(points[0].x, plot.bottom);
    ctx.lineTo(points[0].x, points[0].y);
    traceSmoothLine(ctx, points, true);
    ctx.lineTo(points[points.length - 1].x, plot.bottom);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.beginPath();
    traceSmoothLine(ctx, points);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.25;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    const latest = points[points.length - 1];
    ctx.beginPath();
    ctx.arc(latest.x, latest.y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.stroke();
    drawChartLabel(ctx, `${label} ${formatSpeed(latest.value)}`, latest.x, latest.y, color, plot, placement);
}
// ========== Dock应用管理 ==========
let applications = []; // Dock 中的应用（用户添加的）
let systemApps = []; // 系统中所有可用的应用
function initDock() {
    // 加载用户保存的 Dock 应用
    const savedApps = localStorage.getItem('applications');
    if (savedApps) {
        applications = JSON.parse(savedApps);
    }
    if (applications.length === 0) {
        loadSystemApps();
    }
    renderDock();
    const addBtn = document.getElementById('addApp');
    if (addBtn && !addBtn.dataset.bound) {
        addBtn.addEventListener('click', showAddAppDialog);
        addBtn.dataset.bound = '1';
    }
}
// 从上位机获取系统应用列表
function loadSystemApps() {
    sendMessage('app', 'list', null, (response) => {
        if (response.code === 0 && response.data && response.data.apps) {
            systemApps = response.data.apps.map(app => ({
                id: app.id,
                name: app.name,
                path: app.path,
                icon: app.icon // 使用上位机传来的实际图标（Base64）
            }));
            console.log(`[Apps] 加载了 ${systemApps.length} 个系统应用`);

            // 同步已保存的 Dock 数据（补齐/更新图标、路径等）
            if (applications.length > 0) {
                const sysMap = new Map(systemApps.map(a => [a.id, a]));
                let changed = false;
                applications = applications.map(a => {
                    const s = sysMap.get(a.id);
                    if (!s) return a;

                    const merged = { ...a };
                    if (!merged.name && s.name) { merged.name = s.name; changed = true; }
                    if (!merged.path && s.path) { merged.path = s.path; changed = true; }
                    if ((!merged.icon || merged.icon === '') && s.icon) { merged.icon = s.icon; changed = true; }
                    return merged;
                });
                if (changed) {
                    localStorage.setItem('applications', JSON.stringify(applications));
                }
            }

            // 如果是首次加载且 Dock 为空，自动添加常用应用
            if (applications.length === 0) {
                autoAddCommonApps();
            }

            // 应用列表是异步加载的：这里补一次渲染，确保首次启动 Dock 不为空
            renderDock();
            renderAppsList();
        } else {
            console.error('[Apps] 获取应用列表失败:', response.msg);
            showToast('获取应用列表失败');
        }
    });
}
// 自动添加常用应用到 Dock
function autoAddCommonApps() {
    applications = systemApps.slice(0, 8).map(app => ({ ...app }));
    if (applications.length > 0) {
        localStorage.setItem('applications', JSON.stringify(applications));
    }
}

function renderDock() {
    const dockApps = document.getElementById('dockApps');
    if (window.UIApps?.renderDock) {
        window.UIApps.renderDock(dockApps, applications, {
            onDelete: deleteApp,
            onLaunch: launchApp,
        });
    }
}
// 启动应用
function launchApp(app) {
    sendMessage('app', 'launch', { id: app.id, path: app.path }, (response) => {
        if (response.code === 0) {
            showToast(window.UIApps?.getLaunchToastMessage ? window.UIApps.getLaunchToastMessage(app, true) : `✓ 启动 ${app.name}`);
        } else {
            showToast(window.UIApps?.getLaunchToastMessage ? window.UIApps.getLaunchToastMessage(app, false, response.msg) : `✗ 启动失败: ${response.msg || '未知错误'}`);
        }
    });
}
function renderAppsList() {
    const appsList = document.getElementById('appsList');
    if (!appsList) return;
    if (window.UIApps?.renderAppsList) {
        window.UIApps.renderAppsList(appsList, systemApps, applications, {
            onToggle: toggleDockApp,
            onLaunch: launchApp,
        });
    }
}
// 刷新应用列表
function showAddAppDialog() {
    // 重新加载系统应用列表
    loadSystemApps();
    showToast(window.UIApps?.getRefreshToastMessage ? window.UIApps.getRefreshToastMessage() : '正在刷新应用列表...');
}
// 切换应用在 Dock 中的状态
window.toggleDockApp = (appId) => {
    const result = window.UIApps?.toggleDockApp
        ? window.UIApps.toggleDockApp(applications, systemApps, appId)
        : { applications, changed: false, message: '' };
    applications = result.applications;
    if (!result.changed && result.message) {
        showToast(result.message);
        return;
    }
    renderDock();
    renderAppsList();
    if (result.message) {
        showToast(result.message);
    }
};
// 从 Dock 删除应用
window.deleteApp = (id) => {
    const result = window.UIApps?.deleteApp
        ? window.UIApps.deleteApp(applications, id)
        : { applications, changed: false, message: '' };
    applications = result.applications;
    if (!result.changed) return;
    renderDock();
    renderAppsList();
    if (result.message) {
        showToast(result.message);
    }
};
// ========== 设置 ==========
// 阈值调整辅助函数
function adjustThreshold(inputId, delta) {
    const input = document.getElementById(inputId);
    if (!input) return;

    const currentValue = parseInt(input.value) || 0;
    const min = parseInt(input.min) || 0;
    const max = parseInt(input.max) || 100;
    const step = parseInt(input.step) || 1;

    let newValue = currentValue + delta;
    newValue = Math.max(min, Math.min(max, newValue));

    // 对齐到步长
    newValue = Math.round(newValue / step) * step;

    input.value = newValue;

    // 触发 change 事件以保存到 localStorage
    input.dispatchEvent(new Event('change', { bubbles: true }));
}

function initSettings() {
    const languageSelect = document.getElementById('languageSelect');
    languageSelect.value = localStorage.getItem('language') || 'zh-CN';
    languageSelect.addEventListener('change', (e) => {
        localStorage.setItem('language', e.target.value);
        //changeLanguage(e.target.value);
        showToast('语言已更新');
    });
    ['cpuTempWarning', 'cpuTempDanger', 'memoryWarning'].forEach(id => {
        const input = document.getElementById(id);
        input.value = localStorage.getItem(id) || input.value;
        input.addEventListener('change', (e) => {
            localStorage.setItem(id, e.target.value);
            showToast('阈值已更新');
        });
    });
    // WiFi开关
    const wifiSwitchInput = document.getElementById('wifiSwitchInput');
    const wifiSwitchRow = document.getElementById('wifiSwitchRow');
    if (wifiSwitchInput && wifiSwitchRow) {
        wifiSwitchRow.addEventListener('click', function (e) {
            if (e.target && e.target.closest && e.target.closest('input')) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            wifiSwitchInput.checked = !wifiSwitchInput.checked;
            handleWifiSwitchChange(wifiSwitchInput.checked);
        });
        wifiSwitchInput.addEventListener('click', function (e) {
            e.stopPropagation();
        });
        wifiSwitchInput.addEventListener('change', function (e) {
            e.stopPropagation();
            handleWifiSwitchChange(this.checked);
        });
    }
    // 蓝牙扫描按钮
    // Bluetooth switch event listener
    const bluetoothSwitchInput = document.getElementById('bluetoothSwitchInput');
    const bluetoothSwitchRow = document.getElementById('bluetoothSwitchRow');
    if (bluetoothSwitchInput && bluetoothSwitchRow) {
        bluetoothSwitchRow.addEventListener('click', function (e) {
            if (e.target && e.target.closest && e.target.closest('input')) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            bluetoothSwitchInput.checked = !bluetoothSwitchInput.checked;
            handleBluetoothSwitchChange(bluetoothSwitchInput.checked);
        });
        bluetoothSwitchInput.addEventListener('click', function (e) {
            e.stopPropagation();
        });
        bluetoothSwitchInput.addEventListener('change', function (e) {
            e.stopPropagation();
            handleBluetoothSwitchChange(e.target.checked);
        });
    }

    initAudioRouteSettings();
    initRk628ScaleModeSetting();
    initStatusLedSetting();
}
// ========== WiFi管理 ==========
let wifiNetworks = [];  // 扫描到的 WiFi 网络列表
let wifiActiveScanNetworks = null;
let wifiStatus = {
    mode: 0,  // 0=Disabled, 1=STA, 2=AP
    on: false,
    connected: false,
    connecting: false,
    ssid: null,
    ip: null,
    mac: null,
    rssi: null,
    scanning: false
};

function isWifiSettingsActive() {
    const page = document.getElementById('page-settings');
    const panel = document.getElementById('settings-wifi');
    return !!(page && page.classList.contains('active') && panel && panel.classList.contains('active'));
}

function updateWifiStatusBar() {
    const el = document.getElementById('wifiStatus');
    const icon = document.getElementById('wifiStatusIcon');
    if (!el || !icon) return;
    if (wifiStatus.connected && wifiStatus.ssid) {
        el.textContent = wifiStatus.ssid;
        const scannedRssi = wifiNetworks.find(network => network.ssid === wifiStatus.ssid)?.rssi;
        const signal = window.UIComponents.getWifiSignalMeta(wifiStatus.rssi ?? scannedRssi);
        icon.dataset.level = String(signal.level);
        icon.classList.add('connected');
        icon.title = signal.rssi === null ? 'Wi-Fi 已连接，信号未知' : `Wi-Fi 信号${signal.label} · ${signal.rssi} dBm`;
        icon.setAttribute('aria-label', icon.title);
        return;
    }
    if (wifiStatus.connecting) {
        const waitingForScan = wifiConnectOperation?.phase === 'waitingScan';
        el.textContent = wifiConnectOperation?.ssid
            ? `${waitingForScan ? '等待扫描后连接' : '正在连接'} ${wifiConnectOperation.ssid}`
            : waitingForScan ? '等待扫描后连接' : '正在连接';
        icon.dataset.level = '0';
        icon.classList.remove('connected');
        icon.title = 'Wi-Fi 正在连接';
        icon.setAttribute('aria-label', icon.title);
        return;
    }
    el.textContent = '未连接';
    icon.dataset.level = '0';
    icon.classList.remove('connected');
    icon.title = 'Wi-Fi 未连接';
    icon.setAttribute('aria-label', icon.title);
}

function normalizeWifiRssi(value) {
    const rssi = Number(value);
    return Number.isFinite(rssi) && rssi < 0 ? rssi : null;
}
let wifiAutoScanTimer = null;
let wifiScanSessionStopTimer = null;
let wifiScanSessionDeadline = 0;
let wifiScanSessionExpired = false;
let wifiScanSessionNeedsImmediateScan = false;
let wifiBusyRecoveryTimer = null;
const WIFI_SCAN_DISCONNECTED_INTERVAL_MS = 5000;
const WIFI_SCAN_CONNECTED_INTERVAL_MS = 5000;
const WIFI_SCAN_BUSY_RETRY_MS = 1000;
const WIFI_SCAN_SESSION_MAX_MS = 180000;
const WIFI_SCAN_QUEUE_TIMEOUT_MS = 35000;
const WIFI_CONNECT_TIMEOUT_MS = 35000;
const WIFI_NETWORK_STALE_MS = 30000;
const WIFI_SCAN_REQUEST_DURATION_S = 10;
let wifiConnectOperation = null;
let wifiConnectSequence = 0;
let wifiSavedSsids = new Set();
let wifiConnectionFailure = null;
let wifiStatusRefreshTimer = null;
let wifiStatusRefreshDeadline = 0;

function formatWifiConnectionFailure(reason) {
    const labels = {
        'SSID not found': '未找到网络',
        'Association failed': '认证或密码错误',
        'Association timeout': '信号弱或认证超时',
        'DHCP timeout': '获取 IP 地址超时',
        'Connection timeout': '连接超时'
    };
    return labels[reason] || reason || '连接失败';
}
const wifiOrderMap = new Map();
let wifiOrderCounter = 0;

function ensureWifiOrder(ssid) {
    if (!wifiOrderMap.has(ssid)) {
        wifiOrderMap.set(ssid, wifiOrderCounter++);
    }
    return wifiOrderMap.get(ssid);
}

function compareWifiNetworks(a, b) {
    const aConnected = wifiStatus.connected && a?.ssid === wifiStatus.ssid;
    const bConnected = wifiStatus.connected && b?.ssid === wifiStatus.ssid;
    if (aConnected !== bConnected) return aConnected ? -1 : 1;
    const aRssi = normalizeWifiRssi(a?.rssi);
    const bRssi = normalizeWifiRssi(b?.rssi);
    if (aRssi !== null || bRssi !== null) {
        if (aRssi === null) return 1;
        if (bRssi === null) return -1;
        if (aRssi !== bRssi) return bRssi - aRssi;
    }
    return ensureWifiOrder(a.ssid) - ensureWifiOrder(b.ssid);
}

function stopWifiStatusRefresh() {
    if (wifiStatusRefreshTimer) {
        clearTimeout(wifiStatusRefreshTimer);
        wifiStatusRefreshTimer = null;
    }
    wifiStatusRefreshDeadline = 0;
}

function scheduleWifiStatusRefresh(delayMs = 0, durationMs = 20000) {
    if (!isWifiSettingsActive()) return;
    if (!wifiStatusRefreshDeadline || durationMs > 0) {
        wifiStatusRefreshDeadline = Date.now() + durationMs;
    }
    if (wifiStatusRefreshTimer) clearTimeout(wifiStatusRefreshTimer);
    wifiStatusRefreshTimer = setTimeout(() => {
        wifiStatusRefreshTimer = null;
        if (!isWifiSettingsActive() || !wifiStatus.on) {
            stopWifiStatusRefresh();
            return;
        }
        sendMessage('wifi', 'getStatus', {}, (response) => {
            if (response.code === 0 && response.data) {
                applyWifiStatusSnapshot(response.data, { preserveConnecting: true });
                updateWifiStatusBar();
                renderWifiList();
                if (wifiStatus.connected) {
                    stopWifiStatusRefresh();
                    startWifiAutoScan(0);
                    return;
                }
            }
            if (Date.now() < wifiStatusRefreshDeadline) {
                scheduleWifiStatusRefresh(1000, 0);
            } else {
                stopWifiStatusRefresh();
            }
        });
    }, Math.max(0, delayMs));
}

function syncWifiSavedSsids(data) {
    const stored = Array.isArray(data?.storedSsids)
        ? data.storedSsids
        : data?.storedSsid ? [data.storedSsid] : [];
    wifiSavedSsids = new Set(
        stored.filter(ssid => typeof ssid === 'string' && ssid.length > 0)
    );
}

function createWifiNetworkFromScan(data) {
    if (!data || typeof data.ssid !== 'string' || data.ssid.length === 0) return null;
    return {
        ssid: data.ssid,
        bssid: data.bssid || null,
        rssi: normalizeWifiRssi(data.rssi),
        security: getSecurityName(data.security),
        channel: data.channel ?? null,
        lastSeenAt: Date.now()
    };
}

function upsertWifiNetwork(network) {
    if (!network || typeof network.ssid !== 'string' || network.ssid.length === 0) return false;
    const index = wifiNetworks.findIndex(item => item.ssid === network.ssid);
    if (index < 0) {
        wifiNetworks.push(network);
        return true;
    }
    const existing = wifiNetworks[index];
    wifiNetworks[index] = {
        ...existing,
        ...network,
        bssid: network.bssid || existing.bssid || null,
        rssi: network.rssi ?? existing.rssi ?? null,
        security: network.security || existing.security,
        channel: network.channel ?? existing.channel ?? null,
        lastSeenAt: network.lastSeenAt || Date.now()
    };
    return true;
}

function ensureConnectedWifiVisible() {
    if (!wifiStatus.connected || !wifiStatus.ssid) return false;
    return upsertWifiNetwork({
        ssid: wifiStatus.ssid,
        bssid: null,
        rssi: wifiStatus.rssi,
        security: wifiNetworks.find(network => network.ssid === wifiStatus.ssid)?.security || 'unknown',
        channel: null,
        lastSeenAt: Date.now()
    });
}

function markWifiNetworkUnavailable(ssid) {
    if (!ssid) return false;
    const network = wifiNetworks.find(item => item.ssid === ssid);
    if (!network) return false;
    network.rssi = null;
    network.channel = null;
    network.lastSeenAt = Date.now() - WIFI_NETWORK_STALE_MS - 1;
    return true;
}

function pruneStaleWifiNetworks() {
    const now = Date.now();
    wifiNetworks = wifiNetworks.filter(network => {
        if (wifiStatus.connected && network.ssid === wifiStatus.ssid) return true;
        const isFresh = !network.lastSeenAt || now - network.lastSeenAt <= WIFI_NETWORK_STALE_MS;
        if (isFresh) return true;
        if (wifiSavedSsids.has(network.ssid)) {
            network.rssi = null;
            network.channel = null;
            return true;
        }
        return false;
    });
}

function applyWifiStatusSnapshot(data, { preserveConnecting = false } = {}) {
    if (!data) return false;
    const previousSsid = wifiStatus.ssid;
    const wasConnected = wifiStatus.connected;
    const wifiEnabled = data.enabled === undefined ? !!data.on : !!data.enabled;
    const ssid = typeof data.ssid === 'string' && data.ssid.length > 0 ? data.ssid : null;
    const hasIp = typeof data.ip === 'string' && data.ip.length > 0;
    const connected = !!data.connected || (wifiEnabled && !!ssid && !data.connecting && (data.mode === 1 || hasIp));
    wifiStatus.mode = data.mode || 0;
    wifiStatus.on = wifiEnabled || !!data.on || connected;
    wifiStatus.connected = connected;
    wifiStatus.connecting = preserveConnecting
        ? (!!data.connecting || !!wifiConnectOperation || (wifiStatus.on && !wifiStatus.connected))
        : (!!data.connecting || !!wifiConnectOperation);
    wifiStatus.scanning = !!data.scanning;
    syncWifiSavedSsids(data);
    wifiStatus.ssid = ssid;
    wifiStatus.ip = data.ip || null;
    wifiStatus.mac = data.mac || wifiStatus.mac || null;
    wifiStatus.rssi = normalizeWifiRssi(data.rssi);
    if (wasConnected && !wifiStatus.connected) {
        markWifiNetworkUnavailable(previousSsid || ssid);
    }
    ensureConnectedWifiVisible();
    return true;
}
// 初始化WiFi状态
function initWifiStatus() {
    if (isWifiSettingsActive() && !wifiScanSessionDeadline && !wifiScanSessionExpired) {
        beginWifiScanSession();
    }
    sendMessage('wifi', 'getStatus', {}, (response) => {
        if (response.code === 0 && response.data) {
            const data = response.data;
            applyWifiStatusSnapshot(data);

            updateWifiStatusBar();

            // 显示设备 MAC
            {
                const macEl = document.getElementById('wifiDeviceMac');
                if (macEl) {
                    macEl.textContent = wifiStatus.mac || '--';
                }
            }
            // 更新UI
            const wifiSwitchInput = document.getElementById('wifiSwitchInput');
            const wifiNetworksContainer = document.getElementById('wifiNetworksContainer');
            const wifiEnabled = data.enabled === undefined ? !!data.on : !!data.enabled;
            if (wifiEnabled) {
                // WiFi已开启（不强制要求一定在 STA_MODE）
                wifiSwitchInput.checked = true;
                wifiNetworksContainer.style.display = 'block';
                // 更新网络名称
                updateWifiStatusBar();
                // WiFi 页面内持续扫描；连接事务执行时会短暂让出射频。
                if (isWifiSettingsActive()) {
                    const initialDelay = wifiScanSessionNeedsImmediateScan ? 0 : undefined;
                    wifiScanSessionNeedsImmediateScan = false;
                    startWifiAutoScan(initialDelay);
                }
            } else {
                wifiSwitchInput.checked = false;
                wifiNetworksContainer.style.display = 'none';
            }
            console.log('[WiFi] 状态初始化完成:', wifiStatus);

            // 同步首页状态栏显示
            updateWifiStatusBar();
            renderWifiList();
        } else {
            // 串口未就绪/设备未响应时保持 UI 不变，等待后续 serial:opened / system:status 再刷新
            console.warn('[WiFi] 状态初始化失败:', response);
        }
    });
}
// 安全类型映射
function getSecurityIcon(security) {
    return security === 'open' ? '📶' : '🔒';
}
// WiFi开关切换
function toggleWifiSwitch() {
    const wifiSwitchInput = document.getElementById('wifiSwitchInput');
    wifiSwitchInput.checked = !wifiSwitchInput.checked;
    handleWifiSwitchChange(wifiSwitchInput.checked);
}
// 处理WiFi开关状态变化
function handleWifiSwitchChange(isOn) {
    const wifiNetworksContainer = document.getElementById('wifiNetworksContainer');
    if (isOn) {
        if (isWifiSettingsActive() && !wifiScanSessionDeadline) {
            beginWifiScanSession();
        }
        wifiScanSessionNeedsImmediateScan = true;
        wifiStatus.mode = 1;
        wifiStatus.on = true;
        wifiStatus.connected = false;
        wifiStatus.connecting = true;
        wifiStatus.scanning = false;
        wifiNetworksContainer.style.display = 'block';
        updateWifiStatusBar();
        renderWifiList();
        scheduleWifiStatusRefresh(0, 20000);
        // 开启WiFi：优先尝试 STA 自动连接（不带 SSID，依赖下位机已保存网络）
        // 如果下位机返回“需要 SSID/无已保存网络”，再退回 MONITOR 扫描模式。
        sendMessage('wifi', 'getStatus', {}, (statusResponse) => {
            if (statusResponse.code === 0 && statusResponse.data) {
                const currentMode = statusResponse.data.mode || 0;
                if (currentMode === 1 || currentMode === 3) {
                    initWifiStatus();
                    return;
                }
            }
            switchToStaModeAuto();
        });
    } else {
        // 关闭WiFi
        sendMessage('wifi', 'setMode', { mode: 0 }, (response) => {
            if (response.code === 0) {
                wifiStatus.mode = 0;
                wifiStatus.connected = false;
                wifiStatus.connecting = false;
                clearWifiConnectionOperation();
                stopWifiStatusRefresh();
                wifiStatus.ssid = null;
                wifiStatus.rssi = null;
                updateWifiStatusBar();
                wifiNetworksContainer.style.display = 'none';
                // 停止自动扫描
                stopWifiAutoScan();
                // 保留短 TTL 扫描缓存，重新打开 WiFi 时先显示最近发现，再由新扫描刷新。
                renderWifiList();
                showToast('WiFi 已关闭');
            } else {
                // 失败则恢复开关状态
                document.getElementById('wifiSwitchInput').checked = true;
                showToast(`WiFi 关闭失败: ${formatDeviceCommandError(response)}`);
            }
        });
    }
}
// 根据是否有保存网络决定切换到哪个模式
function switchToWifiMode(hasSavedNetwork) {
    if (hasSavedNetwork) {
        // 有保存的网络，切换到STA模式自动连接
        console.log('[WiFi] 检测到保存的网络，切换到 STA 模式');
        showToast('正在连接到已保存的网络...');
        switchToStaMode();
    } else {
        // 没有保存的网络，切换到MONITOR模式进行扫描
        console.log('[WiFi] 没有保存的网络，切换到 MONITOR 模式');
        showToast('正在开启 WiFi 扫描...');
        switchToMonitorMode();
    }
}
// 切换到STA模式（连接模式）
function switchToStaMode() {
    sendMessage('wifi', 'setMode', { mode: 1 }, (response) => {
        if (response.code === 0) {
            wifiStatus.mode = 1;
            initWifiStatus();
            showToast('WiFi 已开启（连接模式）');
        } else {
            if (isWifiOwnerFault(response)) {
                showWifiOwnerFault(response);
                return;
            }
            // 失败则恢复开关状态
            document.getElementById('wifiSwitchInput').checked = false;
            showToast(`WiFi 开启失败: ${formatDeviceCommandError(response)}`);
        }
    });
}
// 切换到MONITOR模式（扫描模式）
function switchToMonitorMode() {
    sendMessage('wifi', 'setMode', { mode: 3 }, (response) => {
        if (response.code === 0) {
            wifiStatus.mode = 3;
            enableWifiUI();
            showToast('WiFi 已开启（扫描模式）');
            // MONITOR模式下立即开始扫描
            setTimeout(() => {
                scanWifi();
            }, 1000);  // 延迟1秒确保模式切换完成
        } else {
            if (isWifiOwnerFault(response)) {
                showWifiOwnerFault(response);
                return;
            }
            // 失败则恢复开关状态
            document.getElementById('wifiSwitchInput').checked = false;
            showToast(`WiFi 开启失败: ${formatDeviceCommandError(response)}`);
        }
    });
}
// 启用WiFi UI
function enableWifiUI() {
    const wifiNetworksContainer = document.getElementById('wifiNetworksContainer');
    wifiNetworksContainer.style.display = 'block';
    wifiStatus.on = true;
    if (isWifiSettingsActive()) {
        startWifiAutoScan(0);
    }
}

function pauseWifiAutoScan() {
    if (wifiAutoScanTimer) {
        clearTimeout(wifiAutoScanTimer);
        wifiAutoScanTimer = null;
    }
}

function beginWifiScanSession() {
    stopWifiAutoScan();
    wifiScanSessionDeadline = Date.now() + WIFI_SCAN_SESSION_MAX_MS;
    wifiScanSessionExpired = false;
    wifiScanSessionNeedsImmediateScan = true;
    wifiScanSessionStopTimer = setTimeout(() => {
        pauseWifiAutoScan();
        if (wifiBusyRecoveryTimer) {
            clearTimeout(wifiBusyRecoveryTimer);
            wifiBusyRecoveryTimer = null;
        }
        wifiScanSessionDeadline = 0;
        wifiScanSessionExpired = true;
        wifiScanSessionStopTimer = null;
    }, WIFI_SCAN_SESSION_MAX_MS);
}

function startWifiAutoScan(delayMs = undefined) {
    if (!isWifiSettingsActive() || !wifiScanSessionDeadline ||
        Date.now() >= wifiScanSessionDeadline) {
        pauseWifiAutoScan();
        return;
    }
    pauseWifiAutoScan();
    const interval = delayMs ?? (wifiStatus.connected
        ? WIFI_SCAN_CONNECTED_INTERVAL_MS
        : WIFI_SCAN_DISCONNECTED_INTERVAL_MS);
    const remaining = wifiScanSessionDeadline - Date.now();
    wifiAutoScanTimer = setTimeout(() => {
        wifiAutoScanTimer = null;
        if (!isWifiSettingsActive() || !wifiStatus.on ||
            Date.now() >= wifiScanSessionDeadline) return;
        if (wifiStatus.connecting || wifiStatus.scanning || wifiConnectOperation) {
            startWifiAutoScan(WIFI_SCAN_BUSY_RETRY_MS);
            return;
        }
        scanWifiSilent();
    }, Math.max(0, Math.min(interval, remaining)));
}
// 停止WiFi自动扫描
function stopWifiAutoScan() {
    pauseWifiAutoScan();
    if (wifiScanSessionStopTimer) {
        clearTimeout(wifiScanSessionStopTimer);
        wifiScanSessionStopTimer = null;
    }
    if (wifiBusyRecoveryTimer) {
        clearTimeout(wifiBusyRecoveryTimer);
        wifiBusyRecoveryTimer = null;
    }
    wifiScanSessionDeadline = 0;
    wifiScanSessionExpired = false;
    wifiScanSessionNeedsImmediateScan = false;
}
function stopWifiDeviceScan() {
    // 驱动没有取消扫描接口；离开页面只停止后续扫描，当前扫描由完成事件收尾。
}

function recoverWifiScanBusy() {
    pauseWifiAutoScan();
    if (wifiBusyRecoveryTimer) clearTimeout(wifiBusyRecoveryTimer);
    wifiBusyRecoveryTimer = setTimeout(() => {
        wifiBusyRecoveryTimer = null;
        if (!isWifiSettingsActive()) return;
        if (wifiConnectOperation) {
            sendMessage('wifi', 'getStatus', {}, (response) => {
                if (response.code !== 0 || !response.data) return;
                const data = response.data;
                wifiStatus.connected = !!data.connected;
                wifiStatus.connecting = !!data.connecting;
                wifiStatus.scanning = !!data.scanning;
                if (wifiStatus.connected && data.ssid === wifiConnectOperation.ssid) {
                    wifiStatus.ssid = data.ssid;
                    finishWifiConnection(data.ssid);
                    startWifiAutoScan();
                } else if (!wifiStatus.connecting && !wifiStatus.scanning) {
                    startPendingWifiConnection();
                } else {
                    recoverWifiScanBusy();
                }
            });
            return;
        }
        initWifiStatus();
    }, WIFI_SCAN_BUSY_RETRY_MS);
}

// 静默扫描WiFi（不显示加载状态）
function scanWifiSilent() {
    // WiFi 未开启时不扫描
    if (!wifiStatus.on || wifiStatus.connecting || wifiStatus.scanning) {
        return;
    }
    // 仅在 WiFi 页面可见时扫描
    if (!isWifiSettingsActive()) {
        return;
    }
    if (wifiNetworks.length === 0) {
        renderDeviceListState(
            document.getElementById('wifiList'),
            '正在扫描 WiFi 网络...'
        );
    }
    wifiActiveScanNetworks = new Set();
    wifiStatus.scanning = true;
    // 发送开始扫描命令到下位机
    sendMessage('wifi', 'startScan', { duration: WIFI_SCAN_REQUEST_DURATION_S }, (response) => {
        if (response.code !== 0) {
            console.warn('[WiFi] 扫描失败:', response.msg);
            wifiStatus.scanning = false;
            wifiActiveScanNetworks = null;
            if (response.code === 6) {
                recoverWifiScanBusy();
                return;
            }
            renderDeviceListState(
                document.getElementById('wifiList'),
                `WiFi 扫描失败：${formatDeviceCommandError(response, '请重试')}`
            );
            startPendingWifiConnection();
            startWifiAutoScan();
        }
        // 扫描结果会通过事件推送
    });
}
function scanWifi() {
    const wifiList = document.getElementById('wifiList');
    if (wifiNetworks.length === 0) {
        renderDeviceListState(wifiList, '正在扫描 WiFi 网络...');
    }
    scanWifiSilent();
}

function renderDeviceListState(list, message) {
    if (!list) return;
    const state = document.createElement('div');
    state.className = 'device-list-empty';
    state.textContent = message;
    const fragment = document.createDocumentFragment();
    fragment.appendChild(state);
    replaceAnimatedDeviceList(list, fragment);
}

function replaceAnimatedDeviceList(list, fragment) {
    if (!list) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const previousRects = new Map();
    const listRect = list.getBoundingClientRect();
    const nextKeys = new Set(
        Array.from(fragment.querySelectorAll('[data-device-key]'), item => item.dataset.deviceKey)
    );
    const leavingItems = [];
    list.querySelectorAll('[data-device-key]').forEach(item => {
        const rect = item.getBoundingClientRect();
        previousRects.set(item.dataset.deviceKey, rect);
        if (!reduceMotion && !nextKeys.has(item.dataset.deviceKey)) {
            leavingItems.push({ clone: item.cloneNode(true), rect });
        }
    });

    list.replaceChildren(fragment);
    if (reduceMotion || typeof Element.prototype.animate !== 'function') return;

    leavingItems.forEach(({ clone, rect }) => {
        clone.removeAttribute('data-device-key');
        clone.classList.add('device-item-leaving');
        clone.setAttribute('aria-hidden', 'true');
        clone.inert = true;
        clone.style.top = `${rect.top - listRect.top}px`;
        clone.style.left = `${rect.left - listRect.left}px`;
        clone.style.width = `${rect.width}px`;
        clone.style.height = `${rect.height}px`;
        list.appendChild(clone);
        const animation = clone.animate(
            [
                { opacity: 1, transform: 'scale(1)' },
                { opacity: 0, transform: 'scale(0.985)' }
            ],
            { duration: 160, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
        );
        animation.finished.finally(() => clone.remove());
    });

    list.querySelectorAll('[data-device-key]').forEach(item => {
        const previous = previousRects.get(item.dataset.deviceKey);
        if (!previous) {
            item.animate(
                [
                    { opacity: 0, transform: 'translateY(8px)' },
                    { opacity: 1, transform: 'translateY(0)' }
                ],
                { duration: 220, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
            );
            return;
        }

        const current = item.getBoundingClientRect();
        const offset = previous.top - current.top;
        if (Math.abs(offset) < 1) return;
        item.animate(
            [
                { transform: `translateY(${offset}px)` },
                { transform: 'translateY(0)' }
            ],
            { duration: 220, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
        );
    });
}

function reconcileDeviceList(list, orderedItems) {
    if (!list) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const previousKeys = new Set();
    list.querySelectorAll('[data-device-key]').forEach(item => {
        previousKeys.add(item.dataset.deviceKey);
    });

    const nextItems = new Set(orderedItems);
    list.querySelectorAll('[data-device-key]').forEach(item => {
        if (!nextItems.has(item)) item.remove();
    });
    list.querySelectorAll('.device-list-empty').forEach(item => item.remove());

    orderedItems.forEach((item, index) => {
        const current = list.children[index] || null;
        if (current !== item) list.insertBefore(item, current);
    });

    if (reduceMotion || typeof Element.prototype.animate !== 'function') return;
    orderedItems.forEach(item => {
        if (previousKeys.has(item.dataset.deviceKey)) return;
        item.animate(
            [
                { opacity: 0, transform: 'translateY(8px)' },
                { opacity: 1, transform: 'translateY(0)' }
            ],
            { duration: 220, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
        );
    });
}

// 渲染 WiFi 列表
function renderWifiList() {
    const wifiList = document.getElementById('wifiList');
    if (!wifiList) return;
    updateWifiStatusBar();
    if (wifiNetworks.length === 0) {
        renderDeviceListState(wifiList, '未发现 WiFi 网络');
        return;
    }
    const sortedNetworks = [...wifiNetworks].sort(compareWifiNetworks);
    if (!renderWifiList._itemMap) renderWifiList._itemMap = new Map();
    const itemMap = renderWifiList._itemMap;
    const nextKeys = new Set();
    const orderedItems = [];
    sortedNetworks.forEach(network => {
        const key = `wifi:${network.ssid}`;
        nextKeys.add(key);
        let item = itemMap.get(key);
        if (!item) {
            item = document.createElement('div');
            item.className = 'device-item';
            item.dataset.deviceKey = key;
            itemMap.set(key, item);
        }
        const isConnected = wifiStatus.connected && wifiStatus.ssid === network.ssid;
        const isConnecting = !!wifiConnectOperation && wifiConnectOperation.ssid === network.ssid;
        const isWaitingForScan = isConnecting && wifiConnectOperation.phase === 'waitingScan';
        const isSaved = wifiSavedSsids.has(network.ssid);
        const connectionFailure = wifiConnectionFailure?.ssid === network.ssid
            ? wifiConnectionFailure.reason
            : null;
        item.classList.toggle('is-connected', isConnected);
        window.UIComponents.renderWifiListItem(item, {
            network,
            isConnected,
            isConnecting,
            isWaitingForScan,
            isSaved,
            connectionFailure,
            connectDisabled: !!wifiConnectOperation,
            getSecurityIcon,
            onDetails: () => window.showWifiDetails(network.ssid),
            onDisconnect: () => window.disconnectWifi(),
            onConnect: () => window.connectWifi(network.ssid, network.security)
        });
        orderedItems.push(item);
    });
    Array.from(itemMap.keys()).forEach(key => {
        if (!nextKeys.has(key)) itemMap.delete(key);
    });
    reconcileDeviceList(wifiList, orderedItems);
}

// 尝试 STA 自动连接（不带 SSID）
function switchToStaModeAuto() {
    console.log('[WiFi] 尝试 STA 自动连接...');
    showToast('正在尝试自动连接...');
    setTimeout(() => {
        initWifiStatus();
    }, 1500);
    sendMessage('wifi', 'setMode', { mode: 1 }, (response) => {
        if (response.code === 0) {
            wifiStatus.mode = 1;
            initWifiStatus();
            showToast('WiFi 已开启（自动连接）');
            return;
        }
        if (isDeviceTransportError(response)) {
            console.warn('[WiFi] STA 自动连接请求失败:', response);
            sendMessage('wifi', 'getStatus', {}, (statusResponse) => {
                if (statusResponse.code === 0 && statusResponse.data) {
                    const wifiEnabled = statusResponse.data.enabled === undefined
                        ? !!statusResponse.data.on
                        : !!statusResponse.data.enabled;
                    if (wifiEnabled) {
                        applyWifiStatusSnapshot(statusResponse.data, { preserveConnecting: true });
                        document.getElementById('wifiSwitchInput').checked = true;
                        initWifiStatus();
                        showToast('WiFi 已开启，设备正在后台自动连接');
                        return;
                    }
                }
                document.getElementById('wifiSwitchInput').checked = false;
                wifiStatus.on = false;
                wifiStatus.connecting = false;
                updateWifiStatusBar();
                showToast(`WiFi 开启失败: ${formatDeviceCommandError(response)}`);
            });
            return;
        }
        if (isWifiOwnerFault(response)) {
            showWifiOwnerFault(response);
            return;
        }
        console.log('[WiFi] STA 自动连接不可用，切换到扫描模式:', response);
        switchToMonitorMode();
    });
}

window.deleteWifiNetwork = (ssid) => {
    if (!ssid) return;
    const modalBody = document.createElement('div');
    modalBody.style.lineHeight = '1.6';
    const message = document.createElement('div');
    message.append('确定要删除 ');
    const name = document.createElement('strong');
    name.textContent = ssid;
    message.appendChild(name);
    message.append(' 吗？');
    const hint = document.createElement('div');
    hint.className = 'text-muted';
    hint.style.marginTop = '8px';
    hint.textContent = '删除后需要重新输入密码才能连接。';
    modalBody.append(message, hint);
    showModal('删除网络', modalBody, () => {
        sendMessage('wifi', 'forget', { ssid }, (resp) => {
            if (resp.code === 0) {
                showToast('已删除该网络');
                wifiSavedSsids.delete(ssid);
                // 刷新状态/列表
                sendMessage('wifi', 'getStatus', {}, (statusResponse) => {
                    if (statusResponse.code === 0 && statusResponse.data) {
                        wifiStatus.connected = statusResponse.data.connected || false;
                        wifiStatus.connecting = !!statusResponse.data.connecting || !!wifiConnectOperation;
                        syncWifiSavedSsids(statusResponse.data);
                        wifiStatus.ssid = statusResponse.data.ssid || null;
                        wifiStatus.ip = statusResponse.data.ip || null;
                        wifiStatus.rssi = normalizeWifiRssi(statusResponse.data.rssi);
                        updateWifiStatusBar();
                    }
                    // 重新扫描以刷新列表
                    scanWifiSilent();
                });
            } else {
                showToast(resp.msg || '删除失败');
            }
        });
    }, 'md');
};
window.forgetWifi = window.deleteWifiNetwork;
// HTML转义函数
function escapeHtml(text) {
    if (window.UIComponents?.escapeHtml) {
        return window.UIComponents.escapeHtml(text);
    }
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return String(text).replace(/[&<>"']/g, m => map[m]);
}

function clearWifiConnectionOperation() {
    if (wifiConnectOperation?.timer) {
        clearTimeout(wifiConnectOperation.timer);
    }
    if (wifiConnectOperation) {
        wifiConnectOperation.password = '';
    }
    wifiConnectOperation = null;
}

function resumeWifiDiscovery() {
    if (!serialConnected || !wifiStatus.on || wifiStatus.connecting ||
        !isWifiSettingsActive()) return;
    startWifiAutoScan(0);
}

function finishWifiConnection(ssid) {
    if (wifiConnectOperation && wifiConnectOperation.ssid !== ssid) return;
    clearWifiConnectionOperation();
    wifiStatus.connecting = false;
    renderWifiList();
}

function failWifiConnection(ssid = null, resumeDiscovery = true) {
    if (wifiConnectOperation && ssid && wifiConnectOperation.ssid !== ssid) return;
    clearWifiConnectionOperation();
    wifiStatus.connecting = false;
    updateWifiStatusBar();
    renderWifiList();
    if (resumeDiscovery) {
        resumeWifiDiscovery();
    }
}

function resetWifiConnectionAfterTransportLoss() {
    clearWifiConnectionOperation();
    wifiStatus.connecting = false;
    wifiStatus.scanning = false;
    wifiActiveScanNetworks = null;
    stopWifiAutoScan();
    updateWifiStatusBar();
    renderWifiList();
}

function startPendingWifiConnection() {
    const operation = wifiConnectOperation;
    if (!operation || operation.started || wifiStatus.scanning) return;

    operation.started = true;
    operation.phase = 'connecting';
    clearTimeout(operation.timer);
    updateWifiStatusBar();
    renderWifiList();
    operation.timer = setTimeout(() => {
        if (wifiConnectOperation?.id !== operation.id) return;
        console.warn('[WiFi] 连接及 DHCP 等待超时:', operation.ssid);
        wifiConnectionFailure = { ssid: operation.ssid, reason: '连接超时' };
        failWifiConnection(operation.ssid, false);
        showToast(`连接 ${operation.ssid} 超时`);
        initWifiStatus();
    }, WIFI_CONNECT_TIMEOUT_MS);
    sendMessage('wifi', 'connect', {
        ssid: operation.ssid,
        password: operation.password || '',
        useSaved: operation.useSaved,
        save: true
    }, (response) => {
        operation.password = '';
        if (wifiConnectOperation?.id !== operation.id) return;
        if (response.code === 0) {
            wifiStatus.mode = 1;
            console.log('[WiFi] 连接请求已接受:', operation.ssid);
            return;
        }
        if (response.code === 6) {
            operation.started = false;
            recoverWifiScanBusy();
            return;
        }
        wifiConnectionFailure = {
            ssid: operation.ssid,
            reason: formatWifiConnectionFailure(response.msg)
        };
        failWifiConnection(operation.ssid);
        showToast(`连接失败: ${formatDeviceCommandError(response)}`);
        initWifiStatus();
    });
}

function queueWifiConnection(ssid, password, useSaved = false) {
    if (wifiConnectOperation) {
        const target = wifiConnectOperation?.ssid;
        showToast(target ? `正在连接到 ${target}，请稍候` : 'WiFi 正在连接，请稍候');
        return;
    }

    pauseWifiAutoScan();
    wifiConnectionFailure = null;
    wifiStatus.connecting = true;
    wifiConnectOperation = {
        id: ++wifiConnectSequence,
        ssid,
        password: password || '',
        useSaved,
        phase: wifiStatus.scanning ? 'waitingScan' : 'connecting',
        started: false,
        timer: null
    };
    const operation = wifiConnectOperation;
    operation.timer = setTimeout(() => {
        if (wifiConnectOperation?.id !== operation.id) return;
        const target = operation.ssid;
        console.warn('[WiFi] 等待扫描完成超时:', target);
        wifiConnectionFailure = { ssid: target, reason: '等待扫描完成超时' };
        failWifiConnection(target, false);
        showToast(`等待扫描后连接 ${target} 超时，请重试`);
        initWifiStatus();
    }, WIFI_SCAN_QUEUE_TIMEOUT_MS);
    updateWifiStatusBar();
    renderWifiList();
    showToast(wifiStatus.scanning ? `等待扫描完成后连接 ${ssid}...` : `正在连接到 ${ssid}...`);
    startPendingWifiConnection();
}

window.connectWifi = (ssid, security) => {
    const doConnect = (ssid, password, useSaved = false) =>
        queueWifiConnection(ssid, password, useSaved);
    if (wifiSavedSsids.has(ssid)) {
        doConnect(ssid, '', true);
        return;
    }
    if (security === 'open') {
        // 开放网络直接连接
        doConnect(ssid, '');
    } else {
        // 加密网络需要密码
        const modalBody = window.UIComponents?.buildWifiPasswordModal
            ? window.UIComponents.buildWifiPasswordModal(ssid)
            : `
                <div style="display: flex; flex-direction: column; gap: 14px;">
                    <div>
                        <label style="display: block; margin-bottom: 6px; font-weight: 600;">网络名称</label>
                        <input type="text" value="${escapeHtml(ssid)}" disabled class="input-base control-md" style="width: 100%;">
                    </div>
                    <div>
                        <label style="display: block; margin-bottom: 6px; font-weight: 600;">密码</label>
                        <input type="password" id="wifiPassword" class="input-base control-md" placeholder="输入WiFi密码" style="width: 100%;">
                    </div>
                </div>
            `;
        showModal('连接到 WiFi', modalBody, () => {
            const password = document.getElementById('wifiPassword').value;
            if (!password) {
                showToast('请输入密码');
                return;
            }
            doConnect(ssid, password);
        });
    }
};
window.disconnectWifi = () => {
    if (!wifiStatus.connected) {
        showToast('当前未连接任何网络');
        return;
    }
    const ssid = wifiStatus.ssid;
    showToast(`正在断开 ${ssid}...`);
    sendMessage('wifi', 'disconnect', {}, (response) => {
        if (response.code === 0) {
            console.log('[WiFi] 断开请求已发送');
            // 断开结果会通过事件推送
        } else {
            showToast(`断开失败: ${response.msg || '未知错误'}`);
        }
    });
};
window.showWifiDetails = (ssid) => {
    if (!wifiStatus.connected || wifiStatus.ssid !== ssid) {
        showToast('请先连接到该网络');
        return;
    }
    // 获取 WiFi IP 配置详情
    sendMessage('wifi', 'getIp', {}, (response) => {
        if (response.code !== 0) {
            showToast('获取网络配置失败');
            return;
        }
        const ipConfig = response.data || {};
        // 同时获取 WiFi 状态信息
        sendMessage('wifi', 'getStatus', {}, (statusResponse) => {
            const status = statusResponse.data || {};
            const useDhcp = !ipConfig.ip || ipConfig.ip === status.ip; // 如果配置的IP和当前IP相同，可能是DHCP
            const modalBody = window.UIComponents?.buildWifiDetailsModal
                ? window.UIComponents.buildWifiDetailsModal({ ssid, status, ipConfig, useDhcp })
                : '';
            showModal(`📶 ${ssid}`, modalBody, () => {
                // 保存配置
                const dhcpEnabled = document.getElementById('wifiDhcpToggle').checked;
                if (dhcpEnabled) {
                    // 启用 DHCP - 发送空配置或特殊标记
                    showToast('正在启用 DHCP...');
                    // 注意: 这里可能需要根据下位机实际实现调整
                    // 某些实现可能需要发送特殊的IP地址(如0.0.0.0)来表示启用DHCP
                    sendMessage('wifi', 'setIp', {
                        ip: '0.0.0.0',  // 特殊标记表示启用DHCP
                        netmask: '0.0.0.0',
                        gateway: '0.0.0.0'
                    }, (setResponse) => {
                        if (setResponse.code === 0) {
                            showToast('DHCP 已启用');
                        } else {
                            showToast(`配置失败: ${setResponse.msg || '未知错误'}`);
                        }
                    });
                } else {
                    // 静态 IP
                    const newIp = document.getElementById('wifiIpAddress').value;
                    const newMask = document.getElementById('wifiSubnetMask').value;
                    const newGateway = document.getElementById('wifiGateway').value;
                    // 简单验证
                    if (!newIp || !newMask || !newGateway) {
                        showToast('请填写完整的 IP 配置');
                        return;
                    }
                    // IP 地址格式验证
                    const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
                    if (!ipRegex.test(newIp) || !ipRegex.test(newMask) || !ipRegex.test(newGateway)) {
                        showToast('IP 地址格式不正确');
                        return;
                    }
                    showToast('正在设置静态 IP...');
                    sendMessage('wifi', 'setIp', {
                        ip: newIp,
                        netmask: newMask,
                        gateway: newGateway
                    }, (setResponse) => {
                        if (setResponse.code === 0) {
                            showToast('静态 IP 配置已保存');
                        } else {
                            showToast(`配置失败: ${setResponse.msg || '未知错误'}`);
                        }
                    });
                }
            }, '保存');
            const deleteBtn = document.getElementById('wifiDeleteNetworkBtn');
            if (deleteBtn) {
                deleteBtn.addEventListener('click', () => {
                    closeMainModal();
                    window.deleteWifiNetwork(ssid);
                });
            }
        });
    });
};
// 切换 DHCP 模式
window.toggleWifiDhcpMode = () => {
    const dhcpEnabled = document.getElementById('wifiDhcpToggle').checked;
    const inputs = ['wifiIpAddress', 'wifiSubnetMask', 'wifiGateway'];
    const badge = document.getElementById('dhcpStatusBadge');
    inputs.forEach(inputId => {
        const input = document.getElementById(inputId);
        if (input) {
            input.disabled = dhcpEnabled;
            input.style.opacity = dhcpEnabled ? '0.6' : '1';
        }
    });
    if (badge) {
        badge.textContent = dhcpEnabled ? 'DHCP 自动' : '静态 IP';
        badge.style.background = dhcpEnabled ? 'rgba(10, 132, 255, 0.2)' : 'rgba(255, 149, 0, 0.2)';
        badge.style.color = dhcpEnabled ? 'var(--accent-blue)' : 'var(--accent-orange)';
    }
};
// ========== 蓝牙管理 ==========
// 存储扫描到的蓝牙设备
let bluetoothDevices = [];
// 存储已配对的设备
let pairedDevices = [];
// 当前连接的设备
let connectedDevice = null;
// 蓝牙名称缓存 (addr -> name)
const bluetoothNameCache = new Map();
// 等待配对完成后重试连接
let pendingBtConnect = null; // { addr, name }
// 正在扫描标志
let isScanning = false;
// 蓝牙状态
let bluetoothStatus = {
    enabled: false,
    connected: false,
    scanning: false,
    connectedDevice: null,
    mac: null
};
// 蓝牙自动扫描定时器
let bluetoothAutoScanInterval = null;
const BLUETOOTH_AUTO_SCAN_INTERVAL = 10000; // 10秒自动扫描一次

const BLUETOOTH_SCAN_DEVICE_TTL_MS = 30000;
let bluetoothScanSeq = 0;
let bluetoothRenderScheduled = false;
let bluetoothOrderCounter = 0;
const bluetoothOrderMap = new Map(); // key -> order
let bluetoothStatusRetryTimer = null;
let bluetoothStatusRetryCount = 0;
const BLUETOOTH_STATUS_RETRY_LIMIT = 6;

function scheduleBluetoothStatusRetry() {
    if (bluetoothStatusRetryTimer || !serialConnected || bluetoothStatusRetryCount >= BLUETOOTH_STATUS_RETRY_LIMIT) return;
    bluetoothStatusRetryCount++;
    bluetoothStatusRetryTimer = setTimeout(() => {
        bluetoothStatusRetryTimer = null;
        initBluetoothStatus();
    }, 1200);
}

function normalizeBtAddr(addr) {
    return String(addr || '').trim().toLowerCase();
}

function normalizeBluetoothPairingCode(value) {
    const digits = String(value ?? '').replace(/\D/g, '');
    return digits ? digits.padStart(6, '0').slice(-6) : '';
}

function btDeviceKey(device) {
    const addr = normalizeBtAddr(device?.addr);
    const transport = (device?.transport || 'edr');
    return `${addr}|${transport}`;
}

function ensureBtOrder(key) {
    if (!bluetoothOrderMap.has(key)) {
        bluetoothOrderMap.set(key, bluetoothOrderCounter++);
    }
    return bluetoothOrderMap.get(key);
}

const BLUETOOTH_PLACEHOLDER_NAMES = new Set([
    'connected device',
    'bluetooth device',
    'bt device',
    'unknown',
    'unknown device',
    '未连接',
    '蓝牙设备',
    '已连接'
]);

function isUsableBtName(addr, name) {
    const value = String(name || '').trim();
    if (!value) return false;
    const normalized = value.toLowerCase().replace(/[\s_-]+/g, ' ');
    const normalizedAddr = normalizeBtAddr(addr).toLowerCase();
    return normalized !== normalizedAddr && !BLUETOOTH_PLACEHOLDER_NAMES.has(normalized);
}

function resolveBtName(addr, name) {
    const a = normalizeBtAddr(addr);
    if (isUsableBtName(a, name)) {
        bluetoothNameCache.set(a, String(name).trim());
    }
    const cached = bluetoothNameCache.get(a) || '';
    if (!isUsableBtName(a, cached)) {
        bluetoothNameCache.delete(a);
        return '';
    }
    return cached;
}

function resolveFirstBtName(addr, ...names) {
    for (const name of names) {
        const resolved = resolveBtName(addr, name);
        if (resolved) return resolved;
    }
    return resolveBtName(addr);
}

function resolveConnectedBtName(device) {
    if (!device) return '';
    const addr = normalizeBtAddr(device.addr);
    const directName = resolveBtName(addr, device.name);
    if (directName) return directName;

    const candidates = [pendingBtConnect, ...(pairedDevices || []), ...(bluetoothDevices || [])];
    for (const candidate of candidates) {
        if (normalizeBtAddr(candidate?.addr) !== addr) continue;
        const name = resolveBtName(addr, candidate?.name);
        if (name) return name;
    }
    return '';
}

function updateBluetoothStatusBar() {
    const statusEl = document.getElementById('btStatus');
    if (!statusEl) return;
    const device = bluetoothStatus.connectedDevice || connectedDevice;
    if (!bluetoothStatus.connected || !device) {
        statusEl.textContent = '未连接';
        statusEl.title = '蓝牙未连接';
        return;
    }
    const name = resolveConnectedBtName(device);
    statusEl.textContent = name || '已连接';
    statusEl.title = name ? `蓝牙已连接：${name}` : '蓝牙已连接';
}

function scheduleRenderBluetoothList() {
    if (bluetoothRenderScheduled) {
        return;
    }
    bluetoothRenderScheduled = true;
    requestAnimationFrame(() => {
        bluetoothRenderScheduled = false;
        renderBluetoothList();
    });
}

function isBluetoothSettingsActive() {
    const page = document.getElementById('page-settings');
    const panel = document.getElementById('settings-bluetooth');
    return !!(page && page.classList.contains('active') && panel && panel.classList.contains('active'));
}
// 初始化蓝牙状态
function initBluetoothStatus() {
    sendMessage('bluetooth', 'getStatus', null, (response) => {
        if (!response || response.code !== 0 || !response.data) {
            bluetoothStatus.localName = null;
            updateBluetoothLocalName();
            scheduleBluetoothStatusRetry();
            return;
        }
        if (bluetoothStatusRetryTimer) {
            clearTimeout(bluetoothStatusRetryTimer);
            bluetoothStatusRetryTimer = null;
        }
        {
            const mode = response.data.mode || 0;
            bluetoothStatus.mac = response.data.mac || null;

            if (typeof response.data.localName === 'string' && response.data.localName.trim()) {
                bluetoothStatus.localName = response.data.localName.trim();
            } else {
                bluetoothStatus.localName = null;
            }

            // Best-effort: some firmwares may return current connection info in getStatus
            if (response.data.connected === true && response.data.connectedDevice?.addr) {
                bluetoothStatus.connected = true;
                bluetoothStatus.connectedDevice = {
                    addr: response.data.connectedDevice.addr,
                    name: resolveFirstBtName(response.data.connectedDevice.addr, response.data.connectedDevice.name),
                    profiles: response.data.connectedDevice.profiles || [],
                    channelState: response.data.connectedDevice.channelState,
                    hfpMicrophoneAvailable: response.data.connectedDevice.hfpMicrophoneAvailable === true
                };
                connectedDevice = bluetoothStatus.connectedDevice;
                bluetoothConnected = true;
                bluetoothStatusRetryCount = 0;
            } else if (response.data.connected === true && response.data.addr) {
                bluetoothStatus.connected = true;
                bluetoothStatus.connectedDevice = {
                    addr: response.data.addr,
                    name: resolveFirstBtName(response.data.addr, response.data.name)
                };
                connectedDevice = bluetoothStatus.connectedDevice;
                bluetoothConnected = true;
                bluetoothStatusRetryCount = 0;
            } else {
                bluetoothStatus.connected = false;
                bluetoothStatus.connectedDevice = null;
                connectedDevice = null;
                bluetoothConnected = false;
                if (mode !== 0) scheduleBluetoothStatusRetry();
            }

            updateBluetoothStatusBar();

            // 显示设备 MAC
            {
                const macEl = document.getElementById('bluetoothDeviceMac');
                if (macEl) {
                    macEl.textContent = bluetoothStatus.mac || '--';
                }
            }
            const bluetoothSwitchInput = document.getElementById('bluetoothSwitchInput');
            const bluetoothDevicesContainer = document.getElementById('bluetoothDevicesContainer');
            const bluetoothModeRow = document.getElementById('bluetoothModeRow');
            const bluetoothModeSelect = document.getElementById('bluetoothModeSelect');
            const bluetoothLocalNameRow = document.getElementById('bluetoothLocalNameRow');
            if (mode !== 0) {
                bluetoothStatus.enabled = true;
                bluetoothSwitchInput.checked = true;
                bluetoothDevicesContainer.style.display = 'block';
                if (bluetoothModeRow) bluetoothModeRow.style.display = 'flex';
                if (bluetoothModeSelect) bluetoothModeSelect.value = String(mode);
                if (bluetoothLocalNameRow) bluetoothLocalNameRow.style.display = 'flex';
                updateCurrentBluetoothDevice();
                updateBluetoothLocalName();
                // 获取已配对设备
                sendMessage('bluetooth', 'getPairedDevices', null, (pairResponse) => {
                    if (pairResponse.code === 0 && pairResponse.data?.devices) {
                        pairedDevices = pairResponse.data.devices;
                        pairedDevices.forEach(d => resolveBtName(d.addr, d.name));
                        updateBluetoothStatusBar();
                        scheduleRenderBluetoothList();
                    }
                });
                // 启动自动扫描
                if (mode === 2) {
                    startBluetoothAutoScan();
                    scanBluetoothSilent();
                } else {
                    // 接收模式用于被手机发现/连接：不要后台反复发起 inquiry 扫描
                    stopBluetoothAutoScan();
                    bluetoothDevices = [];
                    scheduleRenderBluetoothList();
                }
            } else {
                bluetoothStatus.enabled = false;
                bluetoothSwitchInput.checked = false;
                bluetoothDevicesContainer.style.display = 'none';
                if (bluetoothModeRow) bluetoothModeRow.style.display = 'none';
                if (bluetoothLocalNameRow) bluetoothLocalNameRow.style.display = 'none';
            }
            audioRouteRenderSettings();
            console.log('[Bluetooth] 状态初始化完成 - Mode:', mode, bluetoothStatus);
        }
    });
}

function updateBluetoothLocalName() {
    const el = document.getElementById('bluetoothLocalName');
    if (!el) return;
    const name = (bluetoothStatus && bluetoothStatus.localName) ? String(bluetoothStatus.localName).trim() : '';
    el.textContent = name || '--';
}

window.renameLocalBluetoothDevice = () => {
    if (!bluetoothStatus.enabled) {
        showToast('请先开启蓝牙');
        return;
    }
    const current = (bluetoothStatus && bluetoothStatus.localName) ? String(bluetoothStatus.localName) : '';
    const safeCurrent = typeof escapeHtml === 'function' ? escapeHtml(current) : current;
    showModal('修改本机蓝牙名称', `
        <div style="display:flex; flex-direction:column; gap:10px;">
            <div style="color: var(--text-secondary); font-size: 13px; line-height: 1.4;">
                名称将写入设备底层配置并立即生效（部分手机需要重新搜索/重连才能看到新名称）。
            </div>
            <div>
                <div class="text-muted" style="margin-bottom:6px;">当前名称</div>
                <div style="font-weight: 600;">${safeCurrent || '--'}</div>
            </div>
            <div>
                <div class="text-muted" style="margin-bottom:6px;">新名称</div>
                <input id="btLocalNameInput" class="input-base control-md" maxlength="31" placeholder="请输入 1-31 字符" value="${safeCurrent || ''}" />
            </div>
        </div>
    `, () => {
        const input = document.getElementById('btLocalNameInput');
        const name = input ? String(input.value || '').trim() : '';
        if (!name) {
            showToast('名称不能为空');
            return false;
        }
        if (name.length > 31) {
            showToast('名称过长（最多31字符）');
            return false;
        }
        sendMessage('bluetooth', 'setLocalName', { name }, (resp) => {
            if (resp && resp.code === 0) {
                initBluetoothStatus();
                showToast('蓝牙名称已更新');
                return;
            }
            showToast(`改名失败: ${resp?.msg || '未知错误'}`);
        });
        return true;
    }, 'sm');
};
// 蓝牙开关切换
function toggleBluetoothSwitch() {
    const bluetoothSwitchInput = document.getElementById('bluetoothSwitchInput');
    bluetoothSwitchInput.checked = !bluetoothSwitchInput.checked;
    handleBluetoothSwitchChange(bluetoothSwitchInput.checked);
}
// 处理蓝牙开关状态变化
function handleBluetoothSwitchChange(isOn) {
    const bluetoothDevicesContainer = document.getElementById('bluetoothDevicesContainer');
    const bluetoothModeRow = document.getElementById('bluetoothModeRow');
    const bluetoothModeSelect = document.getElementById('bluetoothModeSelect');
    const bluetoothLocalNameRow = document.getElementById('bluetoothLocalNameRow');
    if (isOn) {
        // 开启蓝牙：默认发射模式；如已选择模式则按选择启用
        const desiredMode = bluetoothModeSelect ? parseInt(bluetoothModeSelect.value, 10) : 2;
        const modeToSet = (desiredMode === 1 || desiredMode === 2) ? desiredMode : 2;
        sendMessage('bluetooth', 'setMode', { mode: modeToSet }, (response) => {
            if (response.code === 0) {
                bluetoothStatus.enabled = true;
                enableBluetoothUI();
                if (bluetoothModeRow) bluetoothModeRow.style.display = 'flex';
                if (bluetoothLocalNameRow) bluetoothLocalNameRow.style.display = 'flex';
                showToast(modeToSet === 2 ? '蓝牙已开启 (发射模式)' : '蓝牙已开启 (接收模式)');

                // If currently on bluetooth settings page, keep discoverable.
                sendMessage('bluetooth', 'setVisibility', { enable: isBluetoothSettingsActive() ? 1 : 0 }, () => { });
            } else {
                // 失败则恢复开关状态
                document.getElementById('bluetoothSwitchInput').checked = false;
                showToast(`蓝牙开启失败: ${formatDeviceCommandError(response)}`);
            }
        });
    } else {
        // 关闭蓝牙：切换到 DISABLED 模式
        // Ensure visibility off when turning off
        sendMessage('bluetooth', 'setVisibility', { enable: 0 }, () => { });

        sendMessage('bluetooth', 'setMode', { mode: 0 }, (response) => {
            if (response.code === 0) {
                bluetoothStatus.enabled = false;
                bluetoothStatus.connected = false;
                bluetoothStatus.connectedDevice = null;
                connectedDevice = null;
                const btStatusEl = document.getElementById('btStatus');
                if (btStatusEl) btStatusEl.textContent = '未连接';
                updateCurrentBluetoothDevice();
                if (bluetoothLocalNameRow) bluetoothLocalNameRow.style.display = 'none';
                bluetoothDevicesContainer.style.display = 'none';
                if (bluetoothModeRow) bluetoothModeRow.style.display = 'none';
                // 停止自动扫描
                stopBluetoothAutoScan();
                // 清空设备列表
                bluetoothDevices = [];
                pairedDevices = [];
                document.getElementById('bluetoothList').innerHTML = '';
                showToast('蓝牙已关闭');
            } else {
                // 失败则恢复开关状态
                document.getElementById('bluetoothSwitchInput').checked = true;
                showToast(`蓝牙关闭失败: ${formatDeviceCommandError(response)}`);
            }
        });
    }
}

// 蓝牙模式切换
document.addEventListener('change', function (e) {
    const target = e.target;
    if (!target || target.id !== 'bluetoothModeSelect') return;
    const mode = parseInt(target.value, 10);
    if (!bluetoothStatus.enabled) return;
    if (mode !== 1 && mode !== 2) return;
    sendMessage('bluetooth', 'setMode', { mode }, (response) => {
        if (response.code !== 0) {
            console.warn('[Bluetooth] 模式切换失败:', response.msg);
            return;
        }
        bluetoothDevices = [];
        scheduleRenderBluetoothList();
        if (mode === 2) {
            startBluetoothAutoScan();
            scanBluetoothSilent();
        } else {
            stopBluetoothAutoScan();
        }

        // Apply visibility based on whether bluetooth page is active
        sendMessage('bluetooth', 'setVisibility', { enable: isBluetoothSettingsActive() ? 1 : 0 }, () => { });
    });
});
// 启用蓝牙 UI
function enableBluetoothUI() {
    const bluetoothDevicesContainer = document.getElementById('bluetoothDevicesContainer');
    const bluetoothModeRow = document.getElementById('bluetoothModeRow');
    const bluetoothLocalNameRow = document.getElementById('bluetoothLocalNameRow');
    bluetoothDevicesContainer.style.display = 'block';
    if (bluetoothModeRow) bluetoothModeRow.style.display = 'flex';
    if (bluetoothLocalNameRow) bluetoothLocalNameRow.style.display = 'flex';
    updateCurrentBluetoothDevice();
    updateBluetoothLocalName();
    // 获取已配对设备
    sendMessage('bluetooth', 'getPairedDevices', null, (response) => {
        if (response.code === 0 && response.data?.devices) {
            pairedDevices = response.data.devices;
            pairedDevices.forEach(d => resolveBtName(d.addr, d.name));
            updateBluetoothStatusBar();
            scheduleRenderBluetoothList();
        }
    });
    if (isBluetoothSettingsActive()) {
        const bluetoothModeSelect = document.getElementById('bluetoothModeSelect');
        const mode = bluetoothModeSelect ? parseInt(bluetoothModeSelect.value, 10) : 2;
        if (mode === 2) {
            scanBluetoothSilent();
            startBluetoothAutoScan();
        } else {
            stopBluetoothAutoScan();
        }
    }
}
// 启动蓝牙自动扫描
function startBluetoothAutoScan() {
    if (!isBluetoothSettingsActive()) {
        return;
    }
    stopBluetoothAutoScan(); // 先停止已有的定时器
    bluetoothAutoScanInterval = setInterval(() => {
        if (isBluetoothSettingsActive() && bluetoothStatus.enabled && !bluetoothStatus.scanning) {
            scanBluetoothSilent();
        }
    }, BLUETOOTH_AUTO_SCAN_INTERVAL);
}
// 停止蓝牙自动扫描
function stopBluetoothAutoScan() {
    if (bluetoothAutoScanInterval) {
        clearInterval(bluetoothAutoScanInterval);
        bluetoothAutoScanInterval = null;
    }
}
// 静默扫描蓝牙（不显示加载状态）
function scanBluetoothSilent() {
    if (!isBluetoothSettingsActive()) {
        return;
    }
    // Do not clear the list on each scan; keep previous results to avoid flicker.
    bluetoothScanSeq++;

    isScanning = true;
    bluetoothStatus.scanning = true;
    scheduleRenderBluetoothList();
    // 发送开始扫描命令
    sendMessage('bluetooth', 'startScan', { duration: 8 }, (response) => {
        if (response.code !== 0) {
            console.warn('[Bluetooth] 扫描失败:', response.msg);
            isScanning = false;
            bluetoothStatus.scanning = false;
            scheduleRenderBluetoothList();
        }
        // 扫描结果会通过事件推送
    });
}
// 更新当前连接的蓝牙设备名称
function updateCurrentBluetoothDevice() {
    const currentBluetoothDevice = document.getElementById('currentBluetoothDevice');
    if (!currentBluetoothDevice) {
        return;
    }
    const dev = bluetoothStatus.connected
        ? (bluetoothStatus.connectedDevice || connectedDevice)
        : null;
    if (dev) {
        const name = resolveConnectedBtName(dev);
        currentBluetoothDevice.textContent = name || dev.addr || '已连接';
    } else {
        currentBluetoothDevice.textContent = '未连接';
    }
}
// 更新蓝牙UI状态
function updateBluetoothUI(status) {
    if (status.connected && status.connectedDevice) {
        bluetoothStatus.connected = true;
        bluetoothStatus.connectedDevice = status.connectedDevice;
        bluetoothConnected = true; // 更新蓝牙连接状态
        connectedDevice = status.connectedDevice;
    } else {
        bluetoothStatus.connected = false;
        bluetoothStatus.connectedDevice = null;
        bluetoothConnected = false; // 更新蓝牙连接状态
        connectedDevice = null;
    }
    updateBluetoothStatusBar();
    updateCurrentBluetoothDevice();
    scheduleRenderBluetoothList();
}
// 旧的扫描蓝牙设备函数已移除，现在使用自动扫描机制（类似WiFi）
// 渲染蓝牙设备列表
function renderBluetoothList() {
    const bluetoothList = document.getElementById('bluetoothList');
    if (!bluetoothList) return;

    const now = Date.now();
    const pairedByAddr = new Map();
    const scannedByKey = new Map();

    // Normalize paired devices
    (pairedDevices || []).forEach(d => {
        if (!d || !d.addr) return;
        const addr = normalizeBtAddr(d.addr);
        const pd = { ...d };
        pd.addr = d.addr;
        pd.transport = d.transport || 'edr';
        pd.paired = true;
        pd.name = resolveBtName(pd.addr, pd.name);
        pairedByAddr.set(addr, pd);
        ensureBtOrder(btDeviceKey(pd));
    });

    // Normalize scanned devices
    (bluetoothDevices || []).forEach(d => {
        if (!d || !d.addr) return;
        const sd = { ...d };
        sd.transport = d.transport || 'edr';
        sd.paired = sd.paired === true;
        sd.name = resolveBtName(sd.addr, sd.name);
        if (!sd.lastSeenMs) sd.lastSeenMs = now;
        scannedByKey.set(btDeviceKey(sd), sd);
        ensureBtOrder(btDeviceKey(sd));
    });

    // Merge: paired always shown; scanned shown if fresh and not already paired
    const merged = [];
    pairedByAddr.forEach(pd => {
        // If also scanned, merge RSSI/class
        const scanKey = btDeviceKey({ addr: pd.addr, transport: pd.transport });
        const sd = scannedByKey.get(scanKey);
        if (sd) {
            if (typeof sd.rssi !== 'undefined') pd.rssi = sd.rssi;
            if (sd.class) pd.class = sd.class;
            if (sd.lastSeenMs) pd.lastSeenMs = sd.lastSeenMs;
        }
        merged.push(pd);
    });

    scannedByKey.forEach(sd => {
        const addr = normalizeBtAddr(sd.addr);
        if (pairedByAddr.has(addr)) return;
        merged.push(sd);
    });

    const connAddr = bluetoothStatus.connected
        ? normalizeBtAddr((bluetoothStatus.connectedDevice || connectedDevice)?.addr)
        : '';
    merged.sort((a, b) => ensureBtOrder(btDeviceKey(a)) - ensureBtOrder(btDeviceKey(b)));

    // Keyed DOM reuse to avoid flicker
    if (!renderBluetoothList._itemMap) {
        renderBluetoothList._itemMap = new Map();
    }
    const itemMap = renderBluetoothList._itemMap;
    const nextKeys = new Set();
    const orderedItems = [];

    if (merged.length === 0) {
        renderDeviceListState(
            bluetoothList,
            bluetoothStatus.scanning ? '正在搜索设备...' : '暂无设备'
        );
        return;
    }

    merged.forEach(device => {
        const key = btDeviceKey(device);
        nextKeys.add(key);

        let refs = itemMap.get(key);
        if (!refs) {
            const item = document.createElement('div');
            item.className = 'device-item ui-list-item';
            item.dataset.deviceKey = `bluetooth:${key}`;

            const icon = document.createElement('div');
            icon.className = 'icon-md';

            const info = document.createElement('div');
            info.className = 'device-info';

            const nameEl = document.createElement('div');
            nameEl.className = 'device-name';

            const metaEl = document.createElement('div');
            metaEl.className = 'text-muted';

            info.appendChild(nameEl);
            info.appendChild(metaEl);

            const actions = document.createElement('div');
            actions.className = 'device-actions';

            item.appendChild(icon);
            item.appendChild(info);
            item.appendChild(actions);

            refs = { item, icon, nameEl, metaEl, actions, actionMode: '', device: null };
            itemMap.set(key, refs);
        }

        const isConnected = connAddr && normalizeBtAddr(device.addr) === connAddr;
        const isPaired = !!device.paired;
        const isBle = (device.transport || 'edr') === 'ble';
        const deviceIcon = getBluetoothDeviceIcon(device.class);
        refs.item.classList.toggle('is-connected', Boolean(isConnected));

        refs.icon.textContent = deviceIcon;
        refs.nameEl.textContent = resolveBtName(device.addr, device.name) || 'Unknown Device';

        if (isConnected) {
            refs.metaEl.textContent = '已连接';
        } else if (isPaired) {
            refs.metaEl.textContent = '已配对';
        } else {
            const rssiText = (typeof device.rssi === 'number' || typeof device.rssi === 'string') ? String(device.rssi) : 'N/A';
            refs.metaEl.textContent = isBle ? `BLE 设备 | RSSI: ${rssiText} dBm` : `RSSI: ${rssiText} dBm`;
        }

        refs.device = device;
        const actionMode = isConnected ? 'connected' : isBle ? 'ble' : isPaired ? 'paired' : 'available';
        if (refs.actionMode !== actionMode) {
            refs.actions.replaceChildren();
            if (isConnected) {
                const btnDisc = document.createElement('button');
                btnDisc.className = 'btn-base btn-sm btn-warning';
                btnDisc.textContent = '断开';
                btnDisc.addEventListener('click', () => disconnectBluetooth(refs.device.addr, refs.nameEl.textContent));
                const btnForget = document.createElement('button');
                btnForget.className = 'btn-base btn-sm btn-secondary';
                btnForget.textContent = '忘记';
                btnForget.addEventListener('click', () => forgetBluetooth(refs.device.addr, refs.nameEl.textContent));
                refs.actions.appendChild(btnDisc);
                refs.actions.appendChild(btnForget);
            } else if (isBle) {
                const btnBle = document.createElement('button');
                btnBle.className = 'btn-base btn-sm btn-secondary';
                btnBle.textContent = 'BLE';
                btnBle.disabled = true;
                btnBle.title = 'BLE设备暂不支持经典蓝牙连接';
                refs.actions.appendChild(btnBle);
            } else {
                const btnConn = document.createElement('button');
                btnConn.className = 'btn-base btn-sm btn-success';
                btnConn.textContent = isPaired ? '连接' : '配对并连接';
                btnConn.addEventListener('click', () => connectBluetooth(refs.device.addr, refs.nameEl.textContent));
                refs.actions.appendChild(btnConn);
                if (isPaired) {
                    const btnForget = document.createElement('button');
                    btnForget.className = 'btn-base btn-sm btn-secondary';
                    btnForget.textContent = '忘记';
                    btnForget.addEventListener('click', () => forgetBluetooth(refs.device.addr, refs.nameEl.textContent));
                    refs.actions.appendChild(btnForget);
                }
            }
            refs.actionMode = actionMode;
        }

        orderedItems.push(refs.item);
    });

    // Cleanup removed keys
    Array.from(itemMap.keys()).forEach(k => {
        if (!nextKeys.has(k)) {
            itemMap.delete(k);
        }
    });

    reconcileDeviceList(bluetoothList, orderedItems);
}
// 根据设备类型获取图标
function getBluetoothDeviceIcon(deviceClass) {
    if (!deviceClass) return '📱';
    const classStr = deviceClass.toLowerCase();
    if (classStr.includes('audio') || classStr.includes('headset') || classStr.includes('headphone')) return '🎧';
    if (classStr.includes('keyboard')) return '⌨️';
    if (classStr.includes('mouse') || classStr.includes('pointing')) return '🖱️';
    if (classStr.includes('speaker')) return '🔊';
    if (classStr.includes('phone')) return '📱';
    if (classStr.includes('computer')) return '💻';
    return '📱';
}
// 连接蓝牙设备
window.connectBluetooth = (addr, name) => {
    if (bluetoothStatus.scanning || isScanning) {
        stopBluetoothAutoScan();
        pendingBtConnect = { addr, name, waitingForScanStop: true };
        showToast(`正在停止搜索并连接到 ${name}...`);
        sendMessage('bluetooth', 'stopScan', {}, (response) => {
            if (response.code !== 0) {
                showToast(`停止搜索失败: ${response.msg || '未知错误'}`);
                pendingBtConnect = null;
                return;
            }

            // stopScan clears the device scan state before the controller emits
            // inquiry-complete, so keep a bounded fallback for older firmware.
            setTimeout(() => {
                if (pendingBtConnect?.waitingForScanStop &&
                    normalizeBtAddr(pendingBtConnect.addr) === normalizeBtAddr(addr)) {
                    pendingBtConnect.waitingForScanStop = false;
                    isScanning = false;
                    bluetoothStatus.scanning = false;
                    performBluetoothConnect(addr, name);
                }
            }, 800);
        });
        return;
    }
    performBluetoothConnect(addr, name);
};
// 执行实际的蓝牙连接
function performBluetoothConnect(addr, name) {
    showToast(`正在连接到 ${name}...`);
    resolveBtName(addr, name);
    pendingBtConnect = { addr, name };
    sendMessage('bluetooth', 'connect', { addr: addr }, (response) => {
        if (response.code === 0) {
            console.log('[Bluetooth] 连接请求已发送');
            // 实际连接成功会通过 'connected' 事件通知
        } else {
            showToast(`连接失败: ${response.msg || '未知错误'}`);
            pendingBtConnect = null;
        }
    });
}
// 断开蓝牙设备
window.disconnectBluetooth = (addr, name) => {
    showToast(`正在断开 ${name}...`);
    sendMessage('bluetooth', 'disconnect', { addr: addr }, (response) => {
        if (response.code === 0) {
            console.log('[Bluetooth] 断开请求已发送');
            connectedDevice = null;
            document.getElementById('btStatus').textContent = '未连接';
            bluetoothStatus.connected = false;
            bluetoothStatus.connectedDevice = null;
            updateCurrentBluetoothDevice();
            scheduleRenderBluetoothList();
            showToast(`已断开 ${name}`);
        } else {
            showToast(`断开失败: ${response.msg || '未知错误'}`);
        }
    });
};
// 忘记蓝牙设备
window.forgetBluetooth = (addr, name) => {
    confirmModal(`确定要忘记设备 "${String(name || '')}" 吗？`, () => {
        sendMessage('bluetooth', 'forgetDevice', { addr: addr }, (response) => {
            if (response.code === 0) {
                // 从已配对列表中移除
                pairedDevices = pairedDevices.filter(d => d.addr !== addr);
                bluetoothDevices = bluetoothDevices.filter(d => d.addr !== addr);
                // 如果忘记的是当前连接的设备，更新状态
                if (connectedDevice && connectedDevice.addr === addr) {
                    connectedDevice = null;
                    document.getElementById('btStatus').textContent = '未连接';
                }
                bluetoothStatus.connected = false;
                bluetoothStatus.connectedDevice = null;
                updateCurrentBluetoothDevice();
                scheduleRenderBluetoothList();
                showToast(`已忘记 ${name}`);
                if (pendingBtConnect && pendingBtConnect.addr === addr) {
                    pendingBtConnect = null;
                }
            } else {
                showToast(`操作失败: ${response.msg || '未知错误'}`);
            }
        });
    });
};

// ========== 错误处理和LocalStorage包装 ==========
function safeLocalStorage(action, key, value = null) {
    try {
        if (action === 'get') {
            return localStorage.getItem(key);
        } else if (action === 'set') {
            localStorage.setItem(key, value);
            return true;
        } else if (action === 'remove') {
            localStorage.removeItem(key);
            return true;
        }
    } catch (e) {
        console.error('LocalStorage错误:', e);
        showToast('存储数据失败，请检查浏览器设置');
        return action === 'get' ? null : false;
    }
}
// ========== 定时器管理（内存清理）==========
const activeTimers = {
    statusBar: null,
    homeWidgets: null,
    monitoring: null
};
function clearAllTimers() {
    Object.values(activeTimers).forEach(timer => {
        if (timer) clearInterval(timer);
    });
}
// 页面卸载时清理
window.addEventListener('beforeunload', clearAllTimers);
// ========== 天气小组件 ==========
const WEATHER_REFRESH_MS = 15 * 60 * 1000;
let weatherTimer = null;
let weatherRequestInFlight = false;

function getWeatherElements() {
    return {
        widget: document.getElementById('weatherWidget'),
        icon: document.getElementById('weatherIcon'),
        temp: document.getElementById('temperature')
    };
}

function formatWeatherTitle(location, description, tempText) {
    const parts = [];
    if (location) parts.push(location);
    if (description) parts.push(description);
    if (tempText) parts.push(tempText);
    return parts.join(' · ') || '天气';
}

function initWeatherWidget() {
    const { widget } = getWeatherElements();
    if (!widget) {
        return;
    }
    widget.addEventListener('click', () => refreshWeather(true));
    refreshWeather(false);
    if (weatherTimer) {
        clearInterval(weatherTimer);
    }
    weatherTimer = setInterval(() => refreshWeather(false), WEATHER_REFRESH_MS);
    activeTimers.homeWidgets = weatherTimer;
}

function refreshWeather(isManual = false) {
    if (weatherRequestInFlight) {
        return;
    }
    const { widget, icon, temp } = getWeatherElements();
    if (!widget || !icon || !temp) {
        return;
    }
    if (!wsConnected) {
        widget.title = '后端未连接';
        if (!widget.dataset.loaded) {
            icon.textContent = '⚠️';
            temp.textContent = '--°C';
        }
        if (isManual) {
            showToast('后端未连接');
        }
        return;
    }
    weatherRequestInFlight = true;
    if (!widget.dataset.loaded) {
        icon.textContent = '⏳';
        temp.textContent = '--°C';
        widget.title = '天气加载中';
    }
    sendMessage('system', 'getWeather', { refresh: isManual }, (response) => {
        weatherRequestInFlight = false;
        if (response && response.code === 0 && response.data) {
            updateWeatherData(response.data);
            return;
        }
        widget.title = '天气获取失败';
        if (!widget.dataset.loaded) {
            icon.textContent = '⚠️';
            temp.textContent = '--°C';
        }
        if (isManual) {
            showToast('天气获取失败');
        }
        console.warn('[Weather] host request failed:', response);
    });
}

function updateWeatherData(data) {
    const { widget, icon, temp } = getWeatherElements();
    if (!widget || !icon || !temp || !data) {
        return;
    }
    if (data.icon) {
        icon.textContent = data.icon;
    }
    if (data.temperature !== undefined && data.temperature !== null && data.temperature !== '') {
        temp.textContent = `${data.temperature}°C`;
    }
    widget.title = formatWeatherTitle(data.location, data.description, temp.textContent);
    widget.dataset.loaded = '1';
}
// ========== 第二页Widget功能 ==========
let calendarRefreshInterval = null;
let calendarDataLoaded = false;
let calendarDataLoading = null;
let calendarRules = null;
let calendarLunarMonthIndex = null;
let calendarLunarDayIndex = null;
const calendarDataByDate = new Map();
const calendarState = { year: null, month: null };
let calendarSwipeReady = false;

function buildCalendarDateKey(year, month, day) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function buildValueIndex(values) {
    const map = {};
    if (!Array.isArray(values)) {
        return map;
    }
    values.forEach((value, index) => {
        if (value) {
            map[value] = index + 1;
        }
    });
    return map;
}

function resolveLunarMonthIndex(monthText) {
    if (!monthText || !calendarLunarMonthIndex) {
        return 0;
    }
    let index = calendarLunarMonthIndex[monthText];
    if (!index && monthText.length > 1) {
        const first = monthText[0];
        if (first === '闰' || first === '闎') {
            index = calendarLunarMonthIndex[monthText.slice(1)];
        }
    }
    return index || 0;
}

function resolveLunarDayIndex(dayText) {
    if (!dayText || !calendarLunarDayIndex) {
        return 0;
    }
    return calendarLunarDayIndex[dayText] || 0;
}


async function loadCalendarData() {
    if (calendarDataLoaded) {
        return;
    }
    if (calendarDataLoading) {
        return calendarDataLoading;
    }
    calendarDataLoading = (async () => {
        try {
            const response = await fetch('slim_v2.json', { cache: 'force-cache' });
            if (!response.ok) {
                throw new Error(`Calendar data HTTP ${response.status}`);
            }
            const payload = await response.json();
            if (Array.isArray(payload)) {
                calendarRules = null;
                calendarLunarMonthIndex = null;
                calendarLunarDayIndex = null;
                payload.forEach((item) => {
                    const g = item && item.gregorian;
                    if (!g) {
                        return;
                    }
                    calendarDataByDate.set(buildCalendarDateKey(g.year, g.month, g.date), item);
                });
                calendarDataLoaded = true;
                return;
            }
            const dict = payload && payload.dict;
            const schema = payload && payload.schema;
            const rows = payload && payload.data;
            if (!dict || !schema || !Array.isArray(rows)) {
                throw new Error('Calendar data format error');
            }
            calendarRules = payload.rules || null;
            calendarLunarMonthIndex = buildValueIndex(dict.lunarMonth);
            calendarLunarDayIndex = buildValueIndex(dict.lunarDay);
            const indexMap = {};
            schema.forEach((key, index) => {
                indexMap[key] = index;
            });
            const dayDict = dict.day || [];
            const lunarYearDict = dict.lunarYear || [];
            const lunarMonthDict = dict.lunarMonth || [];
            const lunarDayDict = dict.lunarDay || [];
            const solarTermDict = dict.solarTerm || [];
            rows.forEach((row) => {
                if (!Array.isArray(row)) {
                    return;
                }
                const year = row[indexMap.y];
                const month = row[indexMap.m];
                const date = row[indexMap.d];
                if (!year || !month || !date) {
                    return;
                }
                const lunarYear = lunarYearDict[row[indexMap.ly]] || '';
                const lunarMonth = lunarMonthDict[row[indexMap.lm]] || '';
                const lunarDay = lunarDayDict[row[indexMap.ld]] || '';
                const leapMonth = row[indexMap.leap] === 1;
                const dayIndex = indexMap.day !== undefined ? row[indexMap.day] : -1;
                const dayText = dayIndex >= 0 ? dayDict[dayIndex] : '';
                const solarTermIndex = indexMap.solarTerm !== undefined ? row[indexMap.solarTerm] : -1;
                const solarTerm = solarTermIndex >= 0 ? solarTermDict[solarTermIndex] : '';
                const entry = {
                    day: dayText,
                    gregorian: { year, month, date },
                    lunar: {
                        year: lunarYear,
                        month: lunarMonth,
                        date: lunarDay,
                        leapMonth
                    }
                };
                const zodiac = getZodiacFromLunarYear(lunarYear);
                if (zodiac) {
                    entry.zodiac = zodiac;
                }
                if (solarTerm) {
                    entry.solarTerm = solarTerm;
                }
                calendarDataByDate.set(buildCalendarDateKey(year, month, date), entry);
            });
            calendarDataLoaded = true;
        } catch (err) {
            console.error('[Calendar] failed to load calendar data', err);
            calendarDataLoaded = false;
        } finally {
            calendarDataLoading = null;
        }
    })();
    return calendarDataLoading;
}

function getZodiacFromLunarYear(lunarYear) {
    if (!lunarYear) {
        return '';
    }
    const branch = lunarYear[lunarYear.length - 1];
    const rules = calendarRules && calendarRules.zodiac;
    const map = rules && rules.branchToAnimal;
    if (map && map[branch]) {
        return map[branch];
    }
    return '';
}

function getLunarText(entry) {
    if (!entry || !entry.lunar) {
        return '';
    }
    const lunar = entry.lunar;
    if (!lunar.month || !lunar.date) {
        return '';
    }
    let monthText = lunar.month;
    if (lunar.leapMonth) {
        monthText = '\u95f0' + monthText;
    }
    if (lunar.date === '\u521d\u4e00') {
        return monthText;
    }
    return lunar.date;
}

function getNthWeekdayDate(year, monthIndex, weekday, nth) {
    const firstDay = new Date(year, monthIndex, 1);
    const offset = (7 + weekday - firstDay.getDay()) % 7;
    return 1 + offset + (nth - 1) * 7;
}

function getSolarFestivalText(year, monthIndex, day) {
    const rules = calendarRules && calendarRules.festival;
    if (!rules) {
        return '';
    }
    const key = `${monthIndex + 1}-${day}`;
    const fixed = rules.fixed;
    if (fixed && fixed[key]) {
        return fixed[key];
    }
    const nthWeekdayRules = rules.nthWeekday;
    if (Array.isArray(nthWeekdayRules)) {
        for (const rule of nthWeekdayRules) {
            if (!rule || rule.monthIndex !== monthIndex) {
                continue;
            }
            if (day === getNthWeekdayDate(year, monthIndex, rule.weekday, rule.nth)) {
                return rule.name || '';
            }
        }
    }
    return '';
}



function getLunarFestivalText(entry, year, monthIndex, day) {
    if (!entry || !entry.lunar || entry.lunar.leapMonth) {
        return '';
    }
    const rules = calendarRules && calendarRules.lunarFestival;
    if (!rules) {
        return '';
    }
    const lunarMonth = resolveLunarMonthIndex(entry.lunar.month);
    const lunarDay = resolveLunarDayIndex(entry.lunar.date);
    if (!lunarMonth || !lunarDay) {
        return '';
    }
    const key = `${lunarMonth}-${lunarDay}`;
    const fixed = rules.fixed;
    if (fixed && fixed[key]) {
        return fixed[key];
    }
    if (lunarMonth === 12 && (lunarDay === 29 || lunarDay === 30)) {
        const nextDate = new Date(year, monthIndex, day);
        nextDate.setDate(nextDate.getDate() + 1);
        const nextKey = buildCalendarDateKey(nextDate.getFullYear(), nextDate.getMonth() + 1, nextDate.getDate());
        const nextEntry = calendarDataByDate.get(nextKey);
        if (nextEntry && nextEntry.lunar) {
            const nextMonth = resolveLunarMonthIndex(nextEntry.lunar.month);
            if (nextMonth === 1) {
                return rules.newYearEve || '';
            }
        }
    }
    return '';
}


function getFestivalText(entry, year, monthIndex, day) {
    if (!entry) {
        return '';
    }
    const solarFestival = getSolarFestivalText(year, monthIndex, day);
    if (solarFestival) {
        return solarFestival;
    }
    const lunarFestival = getLunarFestivalText(entry, year, monthIndex, day);
    if (lunarFestival) {
        return lunarFestival;
    }
    return entry.solarTerm || '';
}


function renderCalendarMonth() {
    const monthLabel = document.getElementById('calendarMonthLabel');
    const daysContainer = document.getElementById('calendarDays');
    if (!monthLabel || !daysContainer) return;

    const today = new Date();
    if (calendarState.year == null) {
        calendarState.year = today.getFullYear();
        calendarState.month = today.getMonth();
    }

    const { year, month: monthIndex } = calendarState;
    monthLabel.textContent = `${year}年${monthIndex + 1}月`;

    // 更新状态标签（如果存在）
    const statusLabel = document.getElementById('calendarStatusLabel');
    if (statusLabel) {
        statusLabel.textContent = !calendarDataLoaded
            ? (calendarDataLoading ? '加载中...' : '数据加载失败')
            : '农历/节气';
    }

    // 计算日历参数
    const firstDay = new Date(year, monthIndex, 1);
    const startOffset = (firstDay.getDay() + 6) % 7; // 周一为起始
    const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();

    // 生成日历单元格
    const cells = Array.from({ length: 42 }, (_, i) => {
        const day = i - startOffset + 1;
        const isCurrentMonth = day >= 1 && day <= daysInMonth;
        const date = new Date(year, monthIndex, day);
        const actualDay = date.getDate();

        // 获取日历数据
        const dateKey = buildCalendarDateKey(date.getFullYear(), date.getMonth() + 1, actualDay);
        const entry = calendarDataByDate.get(dateKey);
        const lunarText = entry ? getLunarText(entry) : '';
        const festivalText = isCurrentMonth ? (entry ? getFestivalText(entry, year, monthIndex, day) : '') : '';

        // 计算样式类
        const isToday = isCurrentMonth && year === today.getFullYear()
            && monthIndex === today.getMonth() && day === today.getDate();
        const classes = [
            'calendar-day',
            !isCurrentMonth && 'other-month',
            isToday && 'today',
            festivalText && 'festival'
        ].filter(Boolean).join(' ');

        // 显示文本
        const subText = festivalText || lunarText || (calendarDataLoaded ? '--' : '');
        const lunarClass = festivalText ? 'calendar-day-lunar festival-text' : 'calendar-day-lunar';

        return `<div class="${classes}">
            <div class="calendar-day-number">${actualDay}</div>
            <div class="${lunarClass}">${subText}</div>
        </div>`;
    });

    daysContainer.innerHTML = cells.join('');
}

// 确保日历状态已初始化
function ensureCalendarState() {
    if (calendarState.year == null) {
        const now = new Date();
        calendarState.year = now.getFullYear();
        calendarState.month = now.getMonth();
    }
}

function shiftCalendarMonth(delta) {
    ensureCalendarState();
    const date = new Date(calendarState.year, calendarState.month + delta, 1);
    calendarState.year = date.getFullYear();
    calendarState.month = date.getMonth();
    renderCalendarMonth();
}

function shiftCalendarYear(delta) {
    ensureCalendarState();
    calendarState.year += delta;
    renderCalendarMonth();
}

// 导出日历导航函数
window.calendarPrevMonth = () => shiftCalendarMonth(-1);
window.calendarNextMonth = () => shiftCalendarMonth(1);
window.calendarPrevYear = () => shiftCalendarYear(-1);
window.calendarNextYear = () => shiftCalendarYear(1);
window.calendarGoToday = () => {
    const now = new Date();
    calendarState.year = now.getFullYear();
    calendarState.month = now.getMonth();
    renderCalendarMonth();
};

function initCalendarSwipe() {
    if (calendarSwipeReady) return;
    const widget = document.getElementById('calendarWidget');
    if (!widget) return;

    calendarSwipeReady = true;
    let swipeStart = { x: 0, y: 0, time: 0 };

    widget.addEventListener('touchstart', (e) => {
        const touch = e.changedTouches?.[0];
        if (touch) {
            swipeStart = { x: touch.clientX, y: touch.clientY, time: Date.now() };
        }
    }, { passive: true });

    widget.addEventListener('touchend', (e) => {
        const touch = e.changedTouches?.[0];
        if (!touch) return;

        const dx = touch.clientX - swipeStart.x;
        const dy = touch.clientY - swipeStart.y;
        const dt = Date.now() - swipeStart.time;

        // 水平滑动：距离>60px，横向大于纵向，时间<600ms
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) && dt < 600) {
            shiftCalendarMonth(dx < 0 ? 1 : -1);
        }
    }, { passive: true });
}

function initCalendarWidget() {
    renderCalendarMonth();
    initCalendarSwipe();

    // 每小时刷新一次日历
    if (calendarRefreshInterval) clearInterval(calendarRefreshInterval);
    calendarRefreshInterval = setInterval(renderCalendarMonth, 60 * 60 * 1000);

    // 加载日历数据后重新渲染
    loadCalendarData().then(renderCalendarMonth, renderCalendarMonth);
}
// ========== 倒计时功能 ==========
let countdownConfig = {
    type: 'weekend', // weekend, newyear, springfestival, nationalday, birthday, custom
    label: '距离周末还有',
    targetDate: null,
    emoji: '🎉'
};
let countdownInterval = null;
// 加载倒计时配置
function loadCountdownConfig() {
    const saved = localStorage.getItem('countdownConfig');
    if (saved) {
        try {
            countdownConfig = JSON.parse(saved);
        } catch (e) {
            console.error('Failed to load countdown config:', e);
        }
    }
}
// 保存倒计时配置
function saveCountdownConfigToStorage() {
    localStorage.setItem('countdownConfig', JSON.stringify(countdownConfig));
}
// 计算目标日期
function getTargetDate() {
    const now = new Date();
    switch (countdownConfig.type) {
        case 'weekend':
            const dayOfWeek = now.getDay();
            const daysUntilWeekend = dayOfWeek === 0 ? 6 : (dayOfWeek === 6 ? 0 : 6 - dayOfWeek);
            const weekend = new Date(now);
            weekend.setDate(now.getDate() + daysUntilWeekend);
            weekend.setHours(0, 0, 0, 0);
            return weekend;
        case 'newyear':
            const nextYear = now.getFullYear() + 1;
            return new Date(nextYear, 0, 1, 0, 0, 0, 0);
        case 'springfestival':
            // 2026年春节: 2月17日
            return new Date(2026, 1, 17, 0, 0, 0, 0);
        case 'nationalday':
            let nationalday = new Date(now.getFullYear(), 9, 1, 0, 0, 0, 0);
            if (now > nationalday) {
                nationalday.setFullYear(now.getFullYear() + 1);
            }
            return nationalday;
        case 'nextholiday':
            // 使用存储的目标日期
            if (countdownConfig.targetDate) {
                return new Date(countdownConfig.targetDate);
            }
            return new Date(now.getTime() + 24 * 60 * 60 * 1000); // 备用：明天
        case 'custom':
            if (countdownConfig.targetDate) {
                return new Date(countdownConfig.targetDate);
            }
            return new Date(now.getTime() + 24 * 60 * 60 * 1000); // 默认明天
        default:
            return new Date(now.getTime() + 24 * 60 * 60 * 1000);
    }
}
// 更新倒计时显示
function updateCountdown() {
    const now = new Date();
    const target = getTargetDate();
    const diff = target - now;
    // 更新标签和表情
    document.getElementById('countdownLabel').textContent = countdownConfig.label;
    document.getElementById('countdownEmoji').textContent = countdownConfig.emoji;
    if (diff <= 0) {
        // 倒计时结束
        document.getElementById('countdownDays').textContent = '0';
        document.getElementById('countdownHours').textContent = '00';
        document.getElementById('countdownMinutes').textContent = '00';
        document.getElementById('countdownSeconds').textContent = '00';
        // 显示庆祝消息
        if (countdownConfig.type === 'weekend') {
            const dayOfWeek = now.getDay();
            if (dayOfWeek === 0 || dayOfWeek === 6) {
                document.getElementById('countdownLabel').textContent = '周末愉快！';
            }
        }
        return;
    }
    // 计算时间差
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);
    // 更新显示
    document.getElementById('countdownDays').textContent = days;
    document.getElementById('countdownHours').textContent = String(hours).padStart(2, '0');
    document.getElementById('countdownMinutes').textContent = String(minutes).padStart(2, '0');
    document.getElementById('countdownSeconds').textContent = String(seconds).padStart(2, '0');
}
// 启动倒计时
function startCountdown() {
    loadCountdownConfig();
    updateCountdown();
    if (countdownInterval) {
        clearInterval(countdownInterval);
    }
    countdownInterval = setInterval(updateCountdown, 1000); // 每秒更新
}
// 打开倒计时配置页面
window.openCountdownPage = function () {
    openPage('countdown');
    // 填充表单数据
    setTimeout(() => {
        if (countdownConfig.type === 'custom') {
            // 移除"距离"和"还有"，只保留事件名称
            let eventName = countdownConfig.label;
            eventName = eventName.replace('距离', '').replace('还有', '');
            document.getElementById('countdownCustomLabel').value = eventName;
            if (countdownConfig.targetDate) {
                const date = new Date(countdownConfig.targetDate);
                const dateString = date.toISOString().slice(0, 16);
                document.getElementById('countdownCustomDate').value = dateString;
            }
            const emojiSelect = document.getElementById('countdownCustomEmoji');
            for (let i = 0; i < emojiSelect.options.length; i++) {
                if (emojiSelect.options[i].value === countdownConfig.emoji) {
                    emojiSelect.selectedIndex = i;
                    break;
                }
            }
        }
    }, 100);
};

// 从日历数据中获取下一个节日
function getNextHolidayFromCalendar() {
    if (!calendarDataLoaded || !calendarRules) {
        // 日历数据未加载，尝试加载
        loadCalendarData();
        return null;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // 节日 emoji 映射
    const holidayEmojis = {
        '元旦': '🎉', '春节': '🧧', '除夕': '🧧', '元宵节': '🏮',
        '清明节': '🌿', '劳动节': '👷', '端午节': '🐉', '七夕节': '💕',
        '中秋节': '🥮', '重阳节': '🍂', '国庆节': '🇨🇳', '腊八节': '🥣',
        '小年': '🧹', '情人节': '💝', '妇女节': '👩', '植树节': '🌳',
        '愚人节': '🤡', '青年节': '💪', '儿童节': '👶', '建党节': '🎗️',
        '建军节': '🎖️', '教师节': '📚', '圣诞节': '🎄', '平安夜': '🎄'
    };

    // 在未来365天内搜索（从明天开始）
    for (let i = 1; i <= 365; i++) {
        const checkDate = new Date(today);
        checkDate.setDate(checkDate.getDate() + i);

        const year = checkDate.getFullYear();
        const month = checkDate.getMonth() + 1;
        const day = checkDate.getDate();

        // 获取阳历节日
        const solarFestival = getSolarFestivalText(year, month - 1, day);
        if (solarFestival) {
            return {
                name: solarFestival,
                date: checkDate,
                emoji: holidayEmojis[solarFestival] || '🎉'
            };
        }

        // 获取农历节日
        const key = buildCalendarDateKey(year, month, day);
        const entry = calendarDataByDate.get(key);
        if (entry) {
            const lunarFestival = getLunarFestivalText(entry, year, month - 1, day);
            if (lunarFestival) {
                return {
                    name: lunarFestival,
                    date: checkDate,
                    emoji: holidayEmojis[lunarFestival] || '🎉'
                };
            }
        }
    }

    return null;
}

// 设置预设倒计时
window.setCountdownPreset = function (preset) {
    switch (preset) {
        case 'weekend':
            countdownConfig = {
                type: 'weekend',
                label: '距离周末还有',
                targetDate: null,
                emoji: '🎉'
            };
            break;
        case 'newyear':
            countdownConfig = {
                type: 'newyear',
                label: '距离新年还有',
                targetDate: null,
                emoji: '🎆'
            };
            break;
        case 'springfestival':
            countdownConfig = {
                type: 'springfestival',
                label: '距离春节还有',
                targetDate: null,
                emoji: '🧧'
            };
            break;
        case 'nextholiday':
            // 自动找到下一个节日
            const nextHoliday = getNextHolidayFromCalendar();
            if (nextHoliday) {
                countdownConfig = {
                    type: 'nextholiday',
                    label: `距离${nextHoliday.name}还有`,
                    targetDate: nextHoliday.date.toISOString(),
                    emoji: nextHoliday.emoji || '🎉'
                };
            } else {
                // 找不到节日时显示提示
                showToast('未找到即将到来的节日');
                return;
            }
            break;
    }
    saveCountdownConfigToStorage();
    updateCountdown();
    closePage();
    showToast('倒计时已更新');
};
// 保存自定义倒计时配置
window.saveCountdownConfig = function () {
    const label = document.getElementById('countdownCustomLabel').value.trim();
    const dateStr = document.getElementById('countdownCustomDate').value;
    const emoji = document.getElementById('countdownCustomEmoji').value;
    if (!label) {
        showToast('请输入事件名称');
        return;
    }
    if (!dateStr) {
        showToast('请选择目标日期');
        return;
    }
    const targetDate = new Date(dateStr);
    if (targetDate <= new Date()) {
        showToast('目标日期必须在未来');
        return;
    }
    countdownConfig = {
        type: 'custom',
        label: `距离${label}还有`,
        targetDate: targetDate.toISOString(),
        emoji: emoji
    };
    saveCountdownConfigToStorage();
    updateCountdown();
    closePage();
    showToast('倒计时已保存');
};
// ========== 虚拟键盘功能 ==========
// HID键盘状态
const keyboardState = {
    modifiers: 0x00,        // 修饰键位掩码 (Ctrl, Shift, Alt, Win)
    pressedKeys: []         // 当前按下的普通键 (最多6个)
};
// 修饰键映射表
const MODIFIER_KEYS = {
    '0xE0': 0x01,  // Left Ctrl
    '0xE1': 0x02,  // Left Shift
    '0xE2': 0x04,  // Left Alt
    '0xE3': 0x08,  // Left Win/GUI
    '0xE4': 0x10,  // Right Ctrl
    '0xE5': 0x20,  // Right Shift
    '0xE6': 0x40,  // Right Alt
    '0xE7': 0x80   // Right Win/GUI
};
// 生成HID键盘报文 (通用函数，支持传入状态对象)
function generateKeyboardReport(state) {
    state = state || keyboardState;
    const report = new Uint8Array(9);  // 9字节: ReportID(1) + Modifiers(1) + Reserved(1) + Keys(6)
    report[0] = 0x04;  // Report ID
    report[1] = state.modifiers || 0;  // Modifier keys
    report[2] = 0x00;  // Reserved
    // 兼容 pressedKeys 和 keys 两种字段名
    const keys = (state.pressedKeys || state.keys || []).slice(0, 6);
    for (let i = 0; i < 6; i++) {
        report[3 + i] = keys[i] || 0x00;
    }
    return report;
}
// 兼容旧调用: generateHIDReport()
function generateHIDReport() {
    return generateKeyboardReport(keyboardState);
}

// 生成HID鼠标报文 (通用函数)
function generateMouseReport(buttons, deltaX, deltaY, wheel = 0) {
    // 限制移动范围 [-127, 127]
    deltaX = Math.max(-127, Math.min(127, Math.round(deltaX)));
    deltaY = Math.max(-127, Math.min(127, Math.round(deltaY)));
    wheel = Math.max(-127, Math.min(127, Math.round(wheel)));
    // 构建HID报文: Report ID 0x03, 5字节
    const report = new Uint8Array(5);
    report[0] = 0x03;  // Report ID
    report[1] = buttons & 0xFF;
    report[2] = deltaX & 0xFF;
    report[3] = deltaY & 0xFF;
    report[4] = wheel & 0xFF;
    return report;
}
// 发送HID报文到下位机
function sendHIDReport(report) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('[Keyboard] WebSocket未连接');
        return false;
    }
    try {
        // 使用统一协议格式发送HID报文到下位机
        const message = {
            v: 1,
            id: generateMessageId(),
            target: 1,  // Device (下位机)
            type: 0,    // Request
            mod: 5,     // HID 模块
            cmd: 'sendReport',
            data: {
                reportId: report[0],  // Report ID (0x04 for keyboard)
                report: Array.from(report)  // 完整HID报文
            },
            ts: Date.now()
        };
        ws.send(JSON.stringify(message));
        console.log('[Keyboard] HID报文已发送:', Array.from(report).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '));
        return true;
    } catch (error) {
        console.error('[Keyboard] 发送HID报文失败:', error);
        return false;
    }
}
// 快捷键字符到HID键码的映射表
const SHORTCUT_KEY_MAP = {
    // 字母键
    'A': 0x04, 'B': 0x05, 'C': 0x06, 'D': 0x07, 'E': 0x08, 'F': 0x09,
    'G': 0x0A, 'H': 0x0B, 'I': 0x0C, 'J': 0x0D, 'K': 0x0E, 'L': 0x0F,
    'M': 0x10, 'N': 0x11, 'O': 0x12, 'P': 0x13, 'Q': 0x14, 'R': 0x15,
    'S': 0x16, 'T': 0x17, 'U': 0x18, 'V': 0x19, 'W': 0x1A, 'X': 0x1B,
    'Y': 0x1C, 'Z': 0x1D,
    // 数字键
    '1': 0x1E, '2': 0x1F, '3': 0x20, '4': 0x21, '5': 0x22,
    '6': 0x23, '7': 0x24, '8': 0x25, '9': 0x26, '0': 0x27,
    // 符号键
    'Minus': 0x2D, 'Equal': 0x2E, 'Comma': 0x36,
    // 功能键
    'F1': 0x3A, 'F2': 0x3B, 'F3': 0x3C, 'F4': 0x3D, 'F5': 0x3E, 'F6': 0x3F,
    'F7': 0x40, 'F8': 0x41, 'F9': 0x42, 'F10': 0x43, 'F11': 0x44, 'F12': 0x45,
    // 特殊键
    'Enter': 0x28, 'Esc': 0x29, 'Backspace': 0x2A, 'Tab': 0x2B,
    'Space': 0x2C, 'Delete': 0x4C, 'Home': 0x4A, 'End': 0x4D,
    'PageUp': 0x4B, 'PageDown': 0x4E,
    // 箭头键
    'ArrowRight': 0x4F, 'ArrowLeft': 0x50, 'ArrowDown': 0x51, 'ArrowUp': 0x52
};
// 修饰键符号到位掩码的映射
const SHORTCUT_MODIFIER_MAP = {
    '⌘': 0x08,      // Left Win/Cmd
    'Cmd': 0x08,
    'Win': 0x08,
    'Ctrl': 0x01,   // Left Ctrl
    'Alt': 0x04,    // Left Alt
    'Shift': 0x02,  // Left Shift
    '⇧': 0x02       // Shift符号
};
/**
 * 解析快捷键字符串为HID修饰键和按键码
 * @param {string} shortcutStr - 快捷键字符串，如 "⌘C", "Ctrl+V", "⌘⇧Z"
 * @returns {object} { modifiers: byte, keyCode: byte } 或 null
 */
function parseShortcutKey(shortcutStr) {
    let modifiers = 0x00;
    let keyChar = '';
    // 首先提取所有修饰符符号 (⌘, ⇧等)
    let remaining = shortcutStr;
    for (const symbol in SHORTCUT_MODIFIER_MAP) {
        if (remaining.includes(symbol)) {
            modifiers |= SHORTCUT_MODIFIER_MAP[symbol];
            remaining = remaining.replace(new RegExp(symbol, 'g'), '');
        }
    }
    // 处理带分隔符的格式 (Ctrl+C, Alt+F4等)
    const parts = remaining.split(/[\+\-\s]+/).filter(p => p.trim().length > 0);
    if (parts.length === 0) {
        console.error('[Shortcut] 无法解析快捷键:', shortcutStr);
        return null;
    }
    // 处理剩余部分
    for (const part of parts) {
        const trimmed = part.trim();
        // 检查是否是修饰键名称
        if (SHORTCUT_MODIFIER_MAP[trimmed]) {
            modifiers |= SHORTCUT_MODIFIER_MAP[trimmed];
        } else if (SHORTCUT_MODIFIER_MAP[trimmed.toLowerCase().charAt(0).toUpperCase() + trimmed.toLowerCase().slice(1)]) {
            // 处理大小写不敏感的修饰键
            const normalized = trimmed.toLowerCase().charAt(0).toUpperCase() + trimmed.toLowerCase().slice(1);
            modifiers |= SHORTCUT_MODIFIER_MAP[normalized];
        } else {
            // 否则是按键字符
            keyChar = trimmed;
        }
    }
    // 如果还没有找到按键字符，使用最后一个部分
    if (!keyChar && parts.length > 0) {
        keyChar = parts[parts.length - 1];
    }
    // 转换按键字符为HID键码
    const upperKey = keyChar.toUpperCase();
    const keyCode = SHORTCUT_KEY_MAP[upperKey] || SHORTCUT_KEY_MAP[keyChar];
    if (!keyCode) {
        console.error('[Shortcut] 无法识别的按键:', keyChar, '原始字符串:', shortcutStr);
        return null;
    }
    return { modifiers, keyCode };
}
/**
 * 发送快捷键组合
 * @param {string} shortcutStr - 快捷键字符串，如 "⌘C", "Ctrl+V"
 */
async function sendShortcutKey(shortcutStr) {
    console.log('[Shortcut] 发送快捷键:', shortcutStr);
    const parsed = parseShortcutKey(shortcutStr);
    if (!parsed) {
        console.error('[Shortcut] 解析快捷键失败:', shortcutStr);
        return false;
    }
    const { modifiers, keyCode } = parsed;
    console.log('[Shortcut] 解析结果:', {
        modifiers: '0x' + modifiers.toString(16).padStart(2, '0'),
        keyCode: '0x' + keyCode.toString(16).padStart(2, '0')
    });
    // 1. 发送按键按下报文
    const pressReport = new Uint8Array(9);
    pressReport[0] = 0x04;          // Report ID
    pressReport[1] = modifiers;     // 修饰键
    pressReport[2] = 0x00;          // Reserved
    pressReport[3] = keyCode;       // 第一个按键
    pressReport[4] = 0x00;          // 其余按键槽为空
    pressReport[5] = 0x00;
    pressReport[6] = 0x00;
    pressReport[7] = 0x00;
    pressReport[8] = 0x00;
    sendHIDReport(pressReport);
    // 2. 等待50ms
    await new Promise(resolve => setTimeout(resolve, 50));
    // 3. 发送按键释放报文 (全0)
    const releaseReport = new Uint8Array(9);
    releaseReport[0] = 0x04;        // Report ID
    releaseReport[1] = 0x00;        // 无修饰键
    releaseReport[2] = 0x00;        // Reserved
    releaseReport[3] = 0x00;        // 无按键
    releaseReport[4] = 0x00;
    releaseReport[5] = 0x00;
    releaseReport[6] = 0x00;
    releaseReport[7] = 0x00;
    releaseReport[8] = 0x00;
    sendHIDReport(releaseReport);
    console.log('[Shortcut] 快捷键发送完成');
    return true;
}
// 处理按键按下
function handleKeyDown(keyCode, isModifier, modifierMask) {
    console.group('⬇️ [Keyboard] 按键按下事件');
    if (isModifier) {
        // 处理修饰键按下
        const oldModifiers = keyboardState.modifiers;
        keyboardState.modifiers |= modifierMask;
        console.log('⌨️ 修饰键按下:', {
            mask: '0x' + modifierMask.toString(16).padStart(2, '0'),
            modifiersBefore: '0b' + oldModifiers.toString(2).padStart(8, '0'),
            modifiersAfter: '0b' + keyboardState.modifiers.toString(2).padStart(8, '0'),
            description: getModifierDescription(modifierMask)
        });
    } else {
        // 处理普通键
        const code = parseInt(keyCode);
        // 避免重复添加
        if (!keyboardState.pressedKeys.includes(code)) {
            // 最多支持6个同时按下的键
            if (keyboardState.pressedKeys.length < 6) {
                keyboardState.pressedKeys.push(code);
                console.log('🔘 普通键按下:', {
                    keyCode: keyCode,
                    decimal: code,
                    hex: '0x' + code.toString(16).padStart(2, '0').toUpperCase(),
                    currentPressedKeys: keyboardState.pressedKeys.map(k => '0x' + k.toString(16).padStart(2, '0').toUpperCase()),
                    pressedCount: keyboardState.pressedKeys.length + '/6'
                });
            } else {
                console.warn('⚠️ 已达到最大同时按键数(6),无法添加新按键');
            }
        } else {
            console.warn('⚠️ 键已按下,忽略重复:', keyCode);
        }
    }
    // 生成并发送HID报文
    const report = generateHIDReport();
    const success = sendHIDReport(report);
    console.log('📊 当前键盘完整状态:', {
        modifiers: {
            binary: '0b' + keyboardState.modifiers.toString(2).padStart(8, '0'),
            hex: '0x' + keyboardState.modifiers.toString(16).padStart(2, '0').toUpperCase(),
            active: getActiveModifiers()
        },
        pressedKeys: keyboardState.pressedKeys.map(k => '0x' + k.toString(16).padStart(2, '0').toUpperCase()),
        pressedKeysCount: keyboardState.pressedKeys.length + '/6',
        reportSent: success ? '✅' : '❌'
    });
    console.groupEnd();
}
// 处理按键释放
function handleKeyUp(keyCode, isModifier, modifierMask) {
    console.group('⬆️ [Keyboard] 按键释放事件');
    if (isModifier) {
        // 处理修饰键释放
        const oldModifiers = keyboardState.modifiers;
        keyboardState.modifiers &= ~modifierMask;
        console.log('⌨️ 修饰键释放:', {
            mask: '0x' + modifierMask.toString(16).padStart(2, '0'),
            modifiersBefore: '0b' + oldModifiers.toString(2).padStart(8, '0'),
            modifiersAfter: '0b' + keyboardState.modifiers.toString(2).padStart(8, '0'),
            description: getModifierDescription(modifierMask)
        });
    } else {
        // 处理普通键释放
        const code = parseInt(keyCode);
        const index = keyboardState.pressedKeys.indexOf(code);
        if (index > -1) {
            keyboardState.pressedKeys.splice(index, 1);
            console.log('🔘 普通键释放:', {
                keyCode: keyCode,
                decimal: code,
                hex: '0x' + code.toString(16).padStart(2, '0').toUpperCase(),
                remainingKeys: keyboardState.pressedKeys.map(k => '0x' + k.toString(16).padStart(2, '0').toUpperCase()),
                pressedCount: keyboardState.pressedKeys.length + '/6'
            });
        } else {
            console.warn('⚠️ 键不在按下列表中:', keyCode);
        }
    }
    // 生成并发送HID报文
    const report = generateHIDReport();
    const success = sendHIDReport(report);
    console.log('📊 当前键盘完整状态:', {
        modifiers: {
            binary: '0b' + keyboardState.modifiers.toString(2).padStart(8, '0'),
            hex: '0x' + keyboardState.modifiers.toString(16).padStart(2, '0').toUpperCase(),
            active: getActiveModifiers()
        },
        pressedKeys: keyboardState.pressedKeys.map(k => '0x' + k.toString(16).padStart(2, '0').toUpperCase()),
        pressedKeysCount: keyboardState.pressedKeys.length + '/6',
        reportSent: success ? '✅' : '❌'
    });
    console.groupEnd();
}
// 辅助函数:获取修饰键描述
function getModifierDescription(mask) {
    const descriptions = {
        0x01: 'Left Ctrl',
        0x02: 'Left Shift',
        0x04: 'Left Alt',
        0x08: 'Left Win/GUI',
        0x10: 'Right Ctrl',
        0x20: 'Right Shift',
        0x40: 'Right Alt',
        0x80: 'Right Win/GUI'
    };
    return descriptions[mask] || 'Unknown';
}
// 辅助函数:获取当前激活的修饰键列表
function getActiveModifiers() {
    const active = [];
    if (keyboardState.modifiers & 0x01) active.push('LCtrl');
    if (keyboardState.modifiers & 0x02) active.push('LShift');
    if (keyboardState.modifiers & 0x04) active.push('LAlt');
    if (keyboardState.modifiers & 0x08) active.push('LWin');
    if (keyboardState.modifiers & 0x10) active.push('RCtrl');
    if (keyboardState.modifiers & 0x20) active.push('RShift');
    if (keyboardState.modifiers & 0x40) active.push('RAlt');
    if (keyboardState.modifiers & 0x80) active.push('RWin');
    return active.length > 0 ? active : ['None'];
}

function updateKeyboardLeds(ledState = {}) {
    const leds = document.querySelectorAll('.numpad-led');
    if (!leds || leds.length < 3) return;
    const states = [!!ledState.num, !!ledState.caps, !!ledState.scroll];
    states.forEach((on, idx) => {
        const el = leds[idx];
        if (!el) return;
        if (on) {
            el.classList.add('active');
        } else {
            el.classList.remove('active');
        }
    });
}

function sendKeyboardReleaseReport() {
    const report = new Uint8Array(9);
    report[0] = 0x04;
    sendHIDReport(report);
}

function resetVirtualKeyboardState(reason) {
    const hadPressedKeys = keyboardState.modifiers !== 0 || keyboardState.pressedKeys.length > 0;
    keyboardState.modifiers = 0;
    keyboardState.pressedKeys = [];
    activePointers.clear();
    keyPointerCount.clear();
    document.querySelectorAll('.virtual-keyboard .key.active').forEach(key => key.classList.remove('active'));
    if (hadPressedKeys) {
        console.warn(`[Keyboard] reset stuck state (${reason || 'unknown'})`);
        sendKeyboardReleaseReport();
    }
}

// ========== 增强的多点触摸管理 ==========
// 指针跟踪: pointerId -> { key, isPressed }
const activePointers = new Map();
// 按键指针计数: keyElement -> pointerCount (用于防止多个手指同时触摸同一个键)
const keyPointerCount = new Map();
const AUTO_RELEASE_KEY_CODES = new Set([0x39, 0x47, 0x53]); // Caps Lock, Scroll Lock, Num Lock

/**
 * 初始化虚拟键盘 - 支持完整的多点触摸和组合键
 * 特点:
     * 1. 使用 Pointer Events 同时支持触摸和鼠标,避免 touch/mouse 双触发
     * 2. 完美组合键 - 可同时按住多个修饰键(Ctrl+Shift+Alt等)
     * 3. 防误触 - 智能识别滑动和点击
     * 4. 性能优化 - 使用Map数据结构,O(1)复杂度查找
 */
function initVirtualKeyboard() {
    console.log('[Keyboard] 🎹 初始化虚拟键盘 (增强多点触摸版本)...');

    const keyboardContainer = document.querySelector('.virtual-keyboard');
    if (!keyboardContainer) {
        console.error('[Keyboard] ❌ 未找到虚拟键盘容器');
        return;
    }

    const keys = document.querySelectorAll('.virtual-keyboard .key');
    console.log(`[Keyboard] ✅ 找到 ${keys.length} 个按键,准备绑定事件`);

    if (keys.length === 0) {
        console.error('[Keyboard] ❌ 未找到任何按键元素');
        return;
    }

    // ===== 工具函数 =====

    /**
     * 获取按键信息
     */
    const getKeyInfo = (key) => {
        const keyCode = key.getAttribute('data-key');
        const modifierCode = key.getAttribute('data-modifier');
        const isModifier = !!modifierCode;
        return { keyCode, modifierCode, isModifier };
    };

    /**
     * 增加按键触摸计数
     */
    const incrementKeyTouchCount = (key) => {
        const count = keyPointerCount.get(key) || 0;
        keyPointerCount.set(key, count + 1);
        return count + 1;
    };

    /**
     * 减少按键触摸计数
     */
    const decrementKeyTouchCount = (key) => {
        const count = keyPointerCount.get(key) || 0;
        const newCount = Math.max(0, count - 1);
        if (newCount === 0) {
            keyPointerCount.delete(key);
        } else {
            keyPointerCount.set(key, newCount);
        }
        return newCount;
    };

    const isAutoReleaseKey = (keyCode) => AUTO_RELEASE_KEY_CODES.has(parseInt(keyCode));

    /**
     * 处理按键按下
     */
    const pressKey = (key, pointerId) => {
        const { keyCode, modifierCode, isModifier } = getKeyInfo(key);
        const touchCount = incrementKeyTouchCount(key);

        // 只在第一次触摸时真正执行按键逻辑,避免重复发送
        if (touchCount === 1) {
            key.classList.add('active');

            if (isModifier) {
                const modifierMask = MODIFIER_KEYS[modifierCode];
                if (typeof modifierMask === 'number') {
                    handleKeyDown(null, true, modifierMask);
                } else {
                    console.warn(`[Keyboard] 未知修饰键编码: ${modifierCode}`);
                }
            } else if (keyCode) {
                handleKeyDown(keyCode, false, null);

                // 锁定键如果释放事件丢失会触发主机持续回传LED Output Report,这里按点击键处理。
                if (isAutoReleaseKey(keyCode)) {
                    setTimeout(() => {
                        const pointerData = activePointers.get(pointerId);
                        if (pointerData && pointerData.key === key && pointerData.isPressed) {
                            releaseKey(key, pointerId);
                            activePointers.set(pointerId, { key: null, isPressed: false });
                        }
                    }, 40);
                }
            }

            console.log(`[Keyboard] ⬇️  按键按下: ${key.textContent.trim()} (pointerId: ${pointerId})`);
        } else {
            console.log(`[Keyboard] 📌 按键已被其他手指按下,跳过 (触摸计数: ${touchCount})`);
        }
    };

    /**
     * 处理按键释放
     */
    const releaseKey = (key, pointerId) => {
        const { keyCode, modifierCode, isModifier } = getKeyInfo(key);
        const touchCount = decrementKeyTouchCount(key);

        // 仅在最后一个触摸点离开时释放按键
        if (touchCount === 0) {
            if (isModifier) {
                const modifierMask = MODIFIER_KEYS[modifierCode];
                if (typeof modifierMask === 'number') {
                    // 先更新逻辑状态,再根据最新状态同步样式
                    handleKeyUp(null, true, modifierMask);
                    if (!(keyboardState.modifiers & modifierMask)) {
                        key.classList.remove('active');
                    }
                } else {
                    console.warn(`[Keyboard] 未知修饰键编码: ${modifierCode}`);
                    key.classList.remove('active');
                }
            } else {
                key.classList.remove('active');
                if (keyCode) {
                    handleKeyUp(keyCode, false, null);
                }
            }

            console.log(`[Keyboard] ⬆️  按键释放: ${key.textContent.trim()} (pointerId: ${pointerId})`);
        } else {
            console.log(`[Keyboard] 📌 按键仍被其他手指按下,保持状态 (触摸计数: ${touchCount})`);
        }
    };

    /**
     * 根据坐标查找按键元素
     */
    const getKeyFromPoint = (clientX, clientY) => {
        const element = document.elementFromPoint(clientX, clientY);
        const key = element && element.closest ? element.closest('.virtual-keyboard .key') : null;
        if (key && !key.classList.contains('key-arrow-spacer')) {
            return key;
        }
        return null;
    };

    const releasePointer = (pointerId) => {
        const pointerData = activePointers.get(pointerId);
        if (pointerData && pointerData.key && pointerData.isPressed) {
            releaseKey(pointerData.key, pointerId);
        }
        activePointers.delete(pointerId);
    };

    // ===== Pointer Events: 同一套路径支持触摸/鼠标/笔,避免合成鼠标事件导致重复计数 =====
    keyboardContainer.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const key = getKeyFromPoint(e.clientX, e.clientY);
        if (!key) {
            return;
        }
        try {
            keyboardContainer.setPointerCapture(e.pointerId);
        } catch { }
        activePointers.set(e.pointerId, { key, isPressed: true });
        pressKey(key, e.pointerId);
        console.log(`[Keyboard] 🖐️  当前活跃指针: ${activePointers.size}`);
    }, { passive: false });

    keyboardContainer.addEventListener('pointermove', (e) => {
        e.preventDefault();
        const pointerData = activePointers.get(e.pointerId);
        if (!pointerData) {
            return;
        }
        const currentKey = getKeyFromPoint(e.clientX, e.clientY);
        const previousKey = pointerData.key;
        if (currentKey === previousKey) {
            return;
        }
        if (previousKey && pointerData.isPressed) {
            releaseKey(previousKey, e.pointerId);
        }
        if (currentKey) {
            activePointers.set(e.pointerId, { key: currentKey, isPressed: true });
            pressKey(currentKey, e.pointerId);
        } else {
            activePointers.set(e.pointerId, { key: null, isPressed: false });
        }
    }, { passive: false });

    keyboardContainer.addEventListener('pointerup', (e) => {
        e.preventDefault();
        releasePointer(e.pointerId);
        try {
            if (keyboardContainer.hasPointerCapture(e.pointerId)) {
                keyboardContainer.releasePointerCapture(e.pointerId);
            }
        } catch { }
        console.log(`[Keyboard] 🖐️  当前活跃指针: ${activePointers.size}`);
    }, { passive: false });

    keyboardContainer.addEventListener('pointercancel', (e) => {
        e.preventDefault();
        releasePointer(e.pointerId);
        console.log(`[Keyboard] ⚠️  指针被取消,清理状态`);
    }, { passive: false });

    keyboardContainer.addEventListener('lostpointercapture', (e) => {
        if (activePointers.has(e.pointerId)) {
            releasePointer(e.pointerId);
        }
    });

    window.addEventListener('blur', () => resetVirtualKeyboardState('window blur'));
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            resetVirtualKeyboardState('document hidden');
        }
    });
    window.addEventListener('pagehide', () => resetVirtualKeyboardState('pagehide'));

    console.log('[Keyboard] ✅ 虚拟键盘初始化完成');
    console.log('[Keyboard] 📊 功能特性:');
    console.log('  - ✅ Pointer Events单路径');
    console.log('  - ✅ 完美组合键支持');
    console.log('  - ✅ 防重复触发');
    console.log('  - ✅ 滑动切换按键');
    console.log('  - ✅ 锁定键自动释放');
}
// 在页面加载完成后初始化键盘
document.addEventListener('DOMContentLoaded', () => {
    // 等待DOM完全加载后再初始化
    setTimeout(() => {
        initVirtualKeyboard();
    }, 500);
});
// 初始化第二页Widget
function initPage2Widgets() {
    // 启动倒计时
    startCountdown();
    initCalendarWidget();
    // 世界时钟 - 纽约时间
    function updateWorldClock() {
        const now = new Date();
        const nyTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const nyTimeEl = document.getElementById('nyTime');
        if (nyTimeEl) {
            nyTimeEl.textContent = `${String(nyTime.getHours()).padStart(2, '0')}:${String(nyTime.getMinutes()).padStart(2, '0')}`;
        }
    }
    updateWorldClock();
    setInterval(updateWorldClock, 1000);
    // 模拟系统运行时间
    let uptime = Math.floor(Math.random() * 300000); // 随机初始运行时间（分钟）
    function updateUptime() {
        uptime += 1;
        const days = Math.floor(uptime / (60 * 24));
        const hours = Math.floor((uptime % (60 * 24)) / 60);
        const minutes = uptime % 60;
        const uptimeEl = document.getElementById('uptimeInfo');
        if (uptimeEl) {
            uptimeEl.textContent = `${days}天 ${hours}小时 ${minutes}分`;
        }
    }
    updateUptime();
    setInterval(updateUptime, 60000); // 每分钟更新
}

// ========== 蓝牙电话功能 ==========
let phoneNumber = '';
let phoneCallState = 'idle'; // idle, dialing, ringing, active, hangup
let phoneBtConnected = false;
let phoneMuted = false;
let phoneSpeaker = false;

// 打开蓝牙电话页面
window.openBluetoothPhone = () => {
    if (window.UIPhone?.openPageUi) {
        window.UIPhone.openPageUi(phoneBtConnected, phoneNumber);
    }
};

// 添加数字到号码
window.phoneAddDigit = (digit) => {
    if (phoneCallState !== 'idle' && phoneCallState !== 'active') return;

    if (phoneNumber.length < 20) {
        phoneNumber += digit;
        phoneUpdateDisplay();
    }
};

// 删除最后一位数字
window.phoneDeleteDigit = () => {
    if (phoneCallState !== 'idle') return;

    if (phoneNumber.length > 0) {
        phoneNumber = phoneNumber.slice(0, -1);
        phoneUpdateDisplay();
    }
};

// 更新号码显示
function phoneUpdateDisplay() {
    if (window.UIPhone?.updateDisplay) {
        window.UIPhone.updateDisplay(phoneNumber);
    }
}

// 更新蓝牙状态显示
function phoneUpdateBtStatus() {
    if (window.UIPhone?.updateBtStatus) {
        window.UIPhone.updateBtStatus(phoneBtConnected);
    }
}

// 更新通话状态显示
function phoneUpdateCallStatus(status) {
    if (window.UIPhone?.updateCallStatus) {
        window.UIPhone.updateCallStatus(phoneCallState, status, phoneBtConnected);
    }
}

// 拨打电话 / 挂断电话
window.phoneCall = () => {
    if (phoneCallState === 'idle') {
        // 拨打电话
        if (!phoneNumber) {
            showToast('请输入电话号码');
            return;
        }

        if (!phoneBtConnected) {
            showToast('蓝牙未连接');
            return;
        }

        phoneCallState = 'dialing';
        phoneUpdateCallStatus('正在拨号...');

        // 调用蓝牙API拨号
        sendMessage('bluetooth', {
            action: 'dial',
            number: phoneNumber
        });

        // 模拟拨号过程
        setTimeout(() => {
            if (phoneCallState === 'dialing') {
                phoneCallState = 'ringing';
                phoneUpdateCallStatus('呼叫中...');
            }
        }, 1000);

    } else {
        // 挂断电话
        phoneCallState = 'hangup';
        phoneUpdateCallStatus('正在挂断...');

        // 调用蓝牙API挂断
        sendMessage('bluetooth', {
            action: 'hangup'
        });

        setTimeout(() => {
            phoneCallState = 'idle';
            phoneUpdateCallStatus('');
            phoneMuted = false;
            phoneSpeaker = false;
            if (window.UIPhone?.updateMuteButton) {
                window.UIPhone.updateMuteButton(phoneMuted);
            }
            if (window.UIPhone?.updateSpeakerButton) {
                window.UIPhone.updateSpeakerButton(phoneSpeaker);
            }
        }, 500);
    }
};

// 接听电话
window.phoneAnswer = () => {
    if (phoneCallState === 'ringing') {
        phoneCallState = 'active';
        phoneUpdateCallStatus('通话中');

        // 调用蓝牙API接听
        sendMessage('bluetooth', {
            action: 'answer'
        });
    }
};

// 切换静音
window.phoneToggleMute = () => {
    phoneMuted = !phoneMuted;
    if (window.UIPhone?.updateMuteButton) {
        window.UIPhone.updateMuteButton(phoneMuted);
    }
    showToast(phoneMuted ? '已静音' : '取消静音');

    // 调用蓝牙API设置静音
    sendMessage('bluetooth', {
        action: 'setMute',
        muted: phoneMuted
    });
};

// 切换扬声器
window.phoneToggleSpeaker = () => {
    phoneSpeaker = !phoneSpeaker;
    if (window.UIPhone?.updateSpeakerButton) {
        window.UIPhone.updateSpeakerButton(phoneSpeaker);
    }
    showToast(phoneSpeaker ? '扬声器已开启' : '扬声器已关闭');

    // 调用蓝牙API切换扬声器
    sendMessage('bluetooth', {
        action: 'setSpeaker',
        enabled: phoneSpeaker
    });
};

// 显示键盘(在通话中)
window.phoneShowKeypad = () => {
    showToast('DTMF键盘');
    // 可以在这里添加DTMF拨号音功能
};

// 处理蓝牙事件
function handleBluetoothPhoneEvent(event) {
    switch (event.type) {
        case 'connected':
            phoneBtConnected = true;
            phoneUpdateBtStatus();
            showToast('蓝牙已连接');
            break;

        case 'disconnected':
            phoneBtConnected = false;
            phoneUpdateBtStatus();
            if (phoneCallState !== 'idle') {
                phoneCallState = 'idle';
                phoneUpdateCallStatus('');
            }
            showToast('蓝牙已断开');
            break;

        case 'incoming':
            // 来电
            phoneNumber = event.number || '未知号码';
            phoneCallState = 'ringing';
            phoneUpdateDisplay();
            phoneUpdateCallStatus('来电: ' + phoneNumber);
            showToast('来电: ' + phoneNumber);
            // 添加到通话记录
            addCallHistory({ type: 'incoming', number: phoneNumber, name: getContactName(phoneNumber) });
            break;

        case 'call_active':
            phoneCallState = 'active';
            phoneUpdateCallStatus('通话中');
            break;

        case 'call_ended':
            phoneCallState = 'idle';
            phoneUpdateCallStatus('');
            phoneNumber = '';
            phoneUpdateDisplay();
            phoneMuted = false;
            phoneSpeaker = false;
            if (window.UIPhone?.updateMuteButton) {
                window.UIPhone.updateMuteButton(phoneMuted);
            }
            if (window.UIPhone?.updateSpeakerButton) {
                window.UIPhone.updateSpeakerButton(phoneSpeaker);
            }
            showToast('通话已结束');
            break;

        case 'contacts_synced':
            // 通讯录同步完成
            if (event.contacts && Array.isArray(event.contacts)) {
                phoneContacts = event.contacts;
                contactsSyncStatus = 'synced';
                loadContacts();
                showToast(`已同步 ${event.contacts.length} 个联系人`);
            } else {
                contactsSyncStatus = 'error';
                loadContacts();
                showToast('通讯录同步失败');
            }
            break;

        case 'call_history_synced':
            // 通话记录同步完成
            if (event.history && Array.isArray(event.history)) {
                callHistory = event.history;
                historySyncStatus = 'synced';
                loadCallHistory(currentHistoryFilter);
                showToast(`已同步 ${event.history.length} 条通话记录`);
            } else {
                historySyncStatus = 'error';
                loadCallHistory(currentHistoryFilter);
                showToast('通话记录同步失败');
            }
            break;
    }
}

// ========== 标签页切换功能 ==========
let currentPhoneTab = 'keypad';

window.switchPhoneTab = (tabName) => {
    currentPhoneTab = tabName;
    if (window.UIPhone?.switchTab) {
        window.UIPhone.switchTab(tabName, event);
    }

    // 加载对应数据
    if (tabName === 'contacts') {
        loadContacts();
    } else if (tabName === 'history') {
        loadCallHistory();
    }
};

// ========== 通讯录功能 ==========
let phoneContacts = [];  // 从手机蓝牙同步的通讯录
let contactsSyncStatus = 'idle';  // idle, syncing, synced, error

function loadContacts() {
    const contactList = document.getElementById('phoneContactList');
    if (!contactList) return;

    // 检查是否需要同步通讯录
    if (contactsSyncStatus === 'idle' && phoneBtConnected) {
        syncContactsFromPhone();
        return;
    }

    if (window.UIPhone?.renderContacts) {
        window.UIPhone.renderContacts(contactList, {
            contactsSyncStatus,
            phoneBtConnected,
            phoneContacts,
            onSync: () => syncContactsFromPhone(),
        });
    }
    bindPhoneContactEvents();
}

// 从手机同步通讯录
window.syncContactsFromPhone = () => {
    if (!phoneBtConnected) {
        showToast('请先连接蓝牙');
        return;
    }

    contactsSyncStatus = 'syncing';
    loadContacts();  // 刷新显示加载状态

    // 请求蓝牙同步通讯录
    sendMessage('bluetooth', {
        action: 'syncContacts'
    });

    // 模拟超时
    setTimeout(() => {
        if (contactsSyncStatus === 'syncing') {
            contactsSyncStatus = 'error';
            showToast('通讯录同步超时，请重试');
        }
    }, 30000);  // 30秒超时
};

window.searchContacts = () => {
    const searchInput = document.getElementById('contactSearchInput');
    const query = searchInput.value.toLowerCase();

    const filtered = phoneContacts.filter(contact =>
        contact.name.toLowerCase().includes(query) ||
        contact.number.includes(query)
    );

    const contactList = document.getElementById('phoneContactList');
    if (!contactList) return;

    contactList.innerHTML = filtered.map(contact => window.UIComponents?.renderPhoneContactItem
        ? window.UIComponents.renderPhoneContactItem(contact)
        : '').join('');
    bindPhoneContactEvents();
};

function bindPhoneContactEvents() {
    const contactList = document.getElementById('phoneContactList');
    if (!contactList || contactList.dataset.bound === '1') return;

    contactList.addEventListener('click', (event) => {
        const item = event.target.closest('.phone-contact-item');
        const number = item?.getAttribute('data-phone-number');
        if (number) {
            dialContact(number);
        }
    });
    contactList.dataset.bound = '1';
}

window.dialContact = (number) => {
    phoneNumber = number;
    phoneUpdateDisplay();
    switchPhoneTab('keypad');
    showToast('已填入号码: ' + number);
};

function getContactName(number) {
    const contact = phoneContacts.find(c => c.number === number);
    return contact ? contact.name : number;
}

// ========== 通话记录功能 ==========
let callHistory = [];  // 从手机蓝牙同步的通话记录
let historySyncStatus = 'idle';  // idle, syncing, synced, error
let currentHistoryFilter = 'all';

window.syncCallHistoryFromPhone = () => {
    if (!phoneBtConnected) {
        showToast('请先连接蓝牙');
        return;
    }

    historySyncStatus = 'syncing';
    loadCallHistory(currentHistoryFilter);

    // 请求蓝牙同步通话记录
    sendMessage('bluetooth', {
        action: 'syncCallHistory'
    });
};

function loadCallHistory(filter = 'all') {
    const historyList = document.getElementById('phoneHistoryList');
    if (!historyList) return;

    if (window.UIPhone?.renderCallHistory) {
        window.UIPhone.renderCallHistory(historyList, {
            historySyncStatus,
            callHistory,
            filter,
            onSync: () => syncCallHistoryFromPhone(),
        });
    }
    bindPhoneHistoryEvents();
}

function bindPhoneHistoryEvents() {
    const historyList = document.getElementById('phoneHistoryList');
    if (!historyList || historyList.dataset.bound === '1') return;

    historyList.addEventListener('click', (event) => {
        const item = event.target.closest('.phone-history-item');
        const number = item?.getAttribute('data-phone-number');
        if (number) {
            dialContact(number);
        }
    });
    historyList.dataset.bound = '1';
}

window.filterCallHistory = (filter) => {
    currentHistoryFilter = filter;

    // 更新过滤按钮状态
    document.querySelectorAll('.phone-filter-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    event.target.classList.add('active');

    loadCallHistory(filter);
};

function addCallHistory(call) {
    const now = new Date();
    const timeStr = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;

    callHistory.unshift({
        id: Date.now(),
        type: call.type,
        number: call.number,
        name: call.name || call.number,
        time: '今天 ' + timeStr,
        duration: call.duration || null
    });

    // 限制记录数量
    if (callHistory.length > 50) {
        callHistory = callHistory.slice(0, 50);
    }

    // 如果当前在通话记录页面，刷新列表
    if (currentPhoneTab === 'history') {
        loadCallHistory(currentHistoryFilter);
    }
}

// ========== 计算器功能 ==========
let calcDisplay = '0';
let calcPrevValue = null;
let calcOperation = null;
let calcNewNumber = true;
let calcCurrentOperation = null; // 当前正在进行的运算符
window.openCalculator = () => {
    const calculatorHTML = `
        <div class="calculator-fullscreen">
            <div class="calc-display-area">
                <div class="calc-expression" id="calcExpression"></div>
                <div class="calc-display" id="calcDisplay">0</div>
            </div>
            <div class="calc-buttons">
                <button class="btn-base btn-glass calc-btn calc-btn-function" onclick="calcClear()">AC</button>
                <button class="btn-base btn-glass calc-btn calc-btn-function" onclick="calcToggleSign()">+/−</button>
                <button class="btn-base btn-glass calc-btn calc-btn-function" onclick="calcPercent()">%</button>
                <button class="btn-base btn-glass blue calc-btn calc-btn-operator" onclick="calcSetOperation('÷')" data-op="÷">÷</button>
                <button class="btn-base btn-glass calc-btn calc-btn-number" onclick="calcNumber('7')">7</button>
                <button class="btn-base btn-glass calc-btn calc-btn-number" onclick="calcNumber('8')">8</button>
                <button class="btn-base btn-glass calc-btn calc-btn-number" onclick="calcNumber('9')">9</button>
                <button class="btn-base btn-glass blue calc-btn calc-btn-operator" onclick="calcSetOperation('×')" data-op="×">×</button>
                <button class="btn-base btn-glass calc-btn calc-btn-number" onclick="calcNumber('4')">4</button>
                <button class="btn-base btn-glass calc-btn calc-btn-number" onclick="calcNumber('5')">5</button>
                <button class="btn-base btn-glass calc-btn calc-btn-number" onclick="calcNumber('6')">6</button>
                <button class="btn-base btn-glass blue calc-btn calc-btn-operator" onclick="calcSetOperation('−')" data-op="−">−</button>
                <button class="btn-base btn-glass calc-btn calc-btn-number" onclick="calcNumber('1')">1</button>
                <button class="btn-base btn-glass calc-btn calc-btn-number" onclick="calcNumber('2')">2</button>
                <button class="btn-base btn-glass calc-btn calc-btn-number" onclick="calcNumber('3')">3</button>
                <button class="btn-base btn-glass blue calc-btn calc-btn-operator" onclick="calcSetOperation('+')" data-op="+">+</button>
                <button class="btn-base btn-glass calc-btn calc-btn-number calc-btn-zero" onclick="calcNumber('0')">0</button>
                <button class="btn-base btn-glass calc-btn calc-btn-number" onclick="calcDecimal()">.</button>
                <button class="btn-base btn-glass blue calc-btn calc-btn-equals" onclick="calcEquals()">=</button>
            </div>
        </div>
    `;
    openPage('calculator');
    const detailPage = document.querySelector('.detail-page.active .page-content');
    if (detailPage) {
        detailPage.innerHTML = calculatorHTML;
        calcReset();
    }
};
function calcReset() {
    calcDisplay = '0';
    calcPrevValue = null;
    calcOperation = null;
    calcCurrentOperation = null;
    calcNewNumber = true;
    calcUpdateDisplay();
    calcUpdateExpression();
    calcClearOperatorHighlight();
}
function calcUpdateDisplay() {
    const display = document.getElementById('calcDisplay');
    if (display) {
        // 格式化显示数字，添加千分位分隔符
        let displayText = calcDisplay;
        if (calcDisplay !== 'Error' && !isNaN(calcDisplay)) {
            const num = parseFloat(calcDisplay);
            // 限制小数位数
            if (Math.abs(num) < 1e10) {
                displayText = num.toLocaleString('en-US', {
                    maximumFractionDigits: 8,
                    useGrouping: true
                });
            }
        }
        display.textContent = displayText;
    }
}
function calcUpdateExpression() {
    const expressionEl = document.getElementById('calcExpression');
    if (expressionEl) {
        if (calcPrevValue !== null && calcOperation) {
            expressionEl.textContent = `${calcPrevValue.toLocaleString()} ${calcOperation}`;
        } else {
            expressionEl.textContent = '';
        }
    }
}
function calcClearOperatorHighlight() {
    document.querySelectorAll('.calc-btn-operator').forEach(btn => {
        btn.classList.remove('active');
    });
}
function calcSetOperatorHighlight(op) {
    calcClearOperatorHighlight();
    document.querySelectorAll(`.calc-btn-operator[data-op="${op}"]`).forEach(btn => {
        btn.classList.add('active');
    });
}
window.calcNumber = (num) => {
    if (calcDisplay === 'Error') {
        calcReset();
    }
    if (calcNewNumber) {
        calcDisplay = num;
        calcNewNumber = false;
    } else {
        // 限制输入长度
        if (calcDisplay.replace(/[,\.]/g, '').length < 12) {
            calcDisplay = calcDisplay === '0' ? num : calcDisplay + num;
        }
    }
    calcUpdateDisplay();
};
window.calcDecimal = () => {
    if (calcDisplay === 'Error') {
        calcReset();
        return;
    }
    if (calcNewNumber) {
        calcDisplay = '0.';
        calcNewNumber = false;
    } else if (!calcDisplay.includes('.')) {
        calcDisplay += '.';
    }
    calcUpdateDisplay();
};
window.calcClear = () => {
    calcReset();
};
window.calcToggleSign = () => {
    if (calcDisplay === 'Error' || calcDisplay === '0') return;
    const num = parseFloat(calcDisplay);
    calcDisplay = String(-num);
    calcUpdateDisplay();
};
window.calcPercent = () => {
    if (calcDisplay === 'Error') return;
    const num = parseFloat(calcDisplay);
    calcDisplay = String(num / 100);
    calcUpdateDisplay();
};
window.calcSetOperation = (op) => {
    if (calcDisplay === 'Error') {
        calcReset();
        return;
    }
    const current = parseFloat(calcDisplay);
    // 如果已经有上一个值且不是新输入，先计算
    if (calcPrevValue !== null && !calcNewNumber && calcOperation) {
        calcPerformOperation();
    } else {
        calcPrevValue = current;
    }
    calcOperation = op;
    calcCurrentOperation = op;
    calcNewNumber = true;
    calcUpdateExpression();
    calcSetOperatorHighlight(op);
};
window.calcEquals = () => {
    if (calcPrevValue === null || calcOperation === null || calcDisplay === 'Error') {
        return;
    }
    calcPerformOperation();
    calcOperation = null;
    calcCurrentOperation = null;
    calcUpdateExpression();
    calcClearOperatorHighlight();
};
function calcPerformOperation() {
    const current = parseFloat(calcDisplay);
    let result = 0;
    switch (calcOperation) {
        case '+':
            result = calcPrevValue + current;
            break;
        case '−':
            result = calcPrevValue - current;
            break;
        case '×':
            result = calcPrevValue * current;
            break;
        case '÷':
            if (current === 0) {
                calcDisplay = 'Error';
                calcPrevValue = null;
                calcUpdateDisplay();
                showToast('除数不能为零');
                return;
            }
            result = calcPrevValue / current;
            break;
    }
    // 处理浮点数精度问题
    result = Math.round(result * 1e10) / 1e10;
    calcDisplay = String(result);
    calcPrevValue = result;
    calcNewNumber = true;
    calcUpdateDisplay();
}
// ========== 番茄钟功能 ==========
let pomodoroTimer = null;
let pomodoroSeconds = 25 * 60; // 25分钟
let pomodoroIsRunning = false;
let pomodoroMode = 'focus'; // focus 或 break
window.openPomodoro = () => {
    const pomodoroHTML = `
        <div class="pomodoro-container">
            <div class="pomodoro-mode-selector">
                <button class="pomodoro-mode-btn active" onclick="setPomodoroMode('focus')" id="focusBtn">专注</button>
                <button class="pomodoro-mode-btn" onclick="setPomodoroMode('break')" id="breakBtn">休息</button>
            </div>
            <div class="pomodoro-timer">
                <div class="pomodoro-circle">
                    <svg class="pomodoro-progress" viewBox="0 0 200 200">
                        <circle cx="100" cy="100" r="90" class="pomodoro-progress-bg"></circle>
                        <circle cx="100" cy="100" r="90" class="pomodoro-progress-fill" id="pomodoroProgress"></circle>
                    </svg>
                    <div class="pomodoro-time" id="pomodoroTime">25:00</div>
                </div>
            </div>
            <div class="pomodoro-controls">
                <button class="btn-base btn-md btn-primary" onclick="togglePomodoro()" id="pomodoroToggleBtn">
                    <span>▶ 开始</span>
                </button>
                <button class="btn-base btn-md btn-danger" onclick="resetPomodoro()">
                    <span>↻ 重置</span>
                </button>
            </div>
            <div class="pomodoro-stats">
                <div class="pomodoro-stat">
                    <div class="pomodoro-stat-value" id="pomodoroCount">0</div>
                    <div class="pomodoro-stat-label">完成次数</div>
                </div>
                <div class="pomodoro-stat">
                    <div class="pomodoro-stat-value" id="pomodoroTotal">0</div>
                    <div class="pomodoro-stat-label">总时长(分)</div>
                </div>
            </div>
        </div>
    `;
    openPage('pomodoro');
    const detailPage = document.querySelector('.detail-page.active .page-content');
    if (detailPage) {
        detailPage.innerHTML = pomodoroHTML;
        loadPomodoroStats();
        updatePomodoroDisplay();
    }
};
window.setPomodoroMode = (mode) => {
    if (pomodoroIsRunning) {
        showToast('请先停止计时器');
        return;
    }
    pomodoroMode = mode;
    pomodoroSeconds = mode === 'focus' ? 25 * 60 : 5 * 60;
    // 更新按钮状态
    document.getElementById('focusBtn').classList.toggle('active', mode === 'focus');
    document.getElementById('breakBtn').classList.toggle('active', mode === 'break');
    updatePomodoroDisplay();
};
window.togglePomodoro = () => {
    pomodoroIsRunning = !pomodoroIsRunning;
    const toggleBtn = document.getElementById('pomodoroToggleBtn');
    if (pomodoroIsRunning) {
        toggleBtn.innerHTML = '<span class="pomodoro-btn-icon">⏸</span><span>暂停</span>';
        startPomodoroTimer();
    } else {
        toggleBtn.innerHTML = '<span class="pomodoro-btn-icon">▶</span><span>开始</span>';
        stopPomodoroTimer();
    }
};
window.resetPomodoro = () => {
    stopPomodoroTimer();
    pomodoroIsRunning = false;
    pomodoroSeconds = pomodoroMode === 'focus' ? 25 * 60 : 5 * 60;
    const toggleBtn = document.getElementById('pomodoroToggleBtn');
    if (toggleBtn) {
        toggleBtn.innerHTML = '<span class="pomodoro-btn-icon">▶</span><span>开始</span>';
    }
    updatePomodoroDisplay();
};
function startPomodoroTimer() {
    if (pomodoroTimer) clearInterval(pomodoroTimer);
    pomodoroTimer = setInterval(() => {
        if (pomodoroSeconds > 0) {
            pomodoroSeconds--;
            updatePomodoroDisplay();
        } else {
            // 计时完成
            stopPomodoroTimer();
            pomodoroIsRunning = false;
            if (pomodoroMode === 'focus') {
                // 保存统计
                savePomodoroSession();
                showToast('🎉 专注时间完成！休息一下吧');
                // 播放提示音（可选）
                playNotificationSound();
            } else {
                showToast('⏰ 休息时间结束！继续加油');
            }
            const toggleBtn = document.getElementById('pomodoroToggleBtn');
            if (toggleBtn) {
                toggleBtn.innerHTML = '<span class="pomodoro-btn-icon">▶</span><span>开始</span>';
            }
        }
    }, 1000);
}
function stopPomodoroTimer() {
    if (pomodoroTimer) {
        clearInterval(pomodoroTimer);
        pomodoroTimer = null;
    }
}
function updatePomodoroDisplay() {
    const minutes = Math.floor(pomodoroSeconds / 60);
    const seconds = pomodoroSeconds % 60;
    const timeStr = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    const timeDisplay = document.getElementById('pomodoroTime');
    if (timeDisplay) {
        timeDisplay.textContent = timeStr;
    }
    // 更新进度圆环
    const totalSeconds = pomodoroMode === 'focus' ? 25 * 60 : 5 * 60;
    const progress = ((totalSeconds - pomodoroSeconds) / totalSeconds) * 100;
    const progressCircle = document.getElementById('pomodoroProgress');
    if (progressCircle) {
        const circumference = 2 * Math.PI * 90;
        const offset = circumference - (progress / 100) * circumference;
        progressCircle.style.strokeDashoffset = offset;
    }
}
function savePomodoroSession() {
    const stats = JSON.parse(localStorage.getItem('pomodoroStats') || '{"count":0,"total":0}');
    stats.count += 1;
    stats.total += 25;
    localStorage.setItem('pomodoroStats', JSON.stringify(stats));
    loadPomodoroStats();
}
function loadPomodoroStats() {
    const stats = JSON.parse(localStorage.getItem('pomodoroStats') || '{"count":0,"total":0}');
    const countEl = document.getElementById('pomodoroCount');
    const totalEl = document.getElementById('pomodoroTotal');
    if (countEl) countEl.textContent = stats.count;
    if (totalEl) totalEl.textContent = stats.total;
}
function playNotificationSound() {
    // 使用Web Audio API播放简单提示音
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        oscillator.frequency.value = 800;
        oscillator.type = 'sine';
        gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);
        oscillator.start(audioContext.currentTime);
        oscillator.stop(audioContext.currentTime + 0.5);
    } catch (e) {
        console.log('音频播放失败:', e);
    }
}
// ========== 笔记管理系统 ==========
let notesData = {
    notes: [],
    currentNoteId: null
};

// 初始化笔记数据
function initNotesData() {
    const saved = localStorage.getItem('notesData');
    if (saved) {
        notesData = JSON.parse(saved);
    } else {
        notesData = {
            notes: [],
            currentNoteId: null
        };
    }
}

// 保存笔记数据到 localStorage
function saveNotesData() {
    localStorage.setItem('notesData', JSON.stringify(notesData));
}

// 生成唯一 ID
function generateNoteId() {
    return 'note_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// 打开笔记页面
window.openNotes = () => {
    initNotesData();
    openPage('notes');
    renderNotesList();

    // 如果有笔记，加载第一个或当前笔记
    if (notesData.notes.length > 0) {
        const noteId = notesData.currentNoteId || notesData.notes[0].id;
        loadNote(noteId);
    } else {
        // 没有笔记时，创建一个新笔记
        createNewNote();
    }
};

// 渲染笔记列表
function renderNotesList() {
    const notesList = document.getElementById('notesList');
    if (!notesList) return;

    if (notesData.notes.length === 0) {
        notesList.innerHTML = `
            <div class="notes-empty-state">
                <div class="notes-empty-state-icon">📝</div>
                <div class="notes-empty-state-text">暂无笔记</div>
            </div>
        `;
        return;
    }

    notesList.innerHTML = notesData.notes.map(note => window.UIComponents?.renderNoteListItem
        ? window.UIComponents.renderNoteListItem(note, notesData.currentNoteId)
        : '').join('');

    bindNotesListEvents();
}

function bindNotesListEvents() {
    const notesList = document.getElementById('notesList');
    if (!notesList || notesList.dataset.bound) return;

    notesList.addEventListener('click', (event) => {
        const deleteBtn = event.target.closest('.note-list-item-delete');
        if (deleteBtn) {
            const noteId = deleteBtn.getAttribute('data-note-delete');
            if (noteId) {
                event.stopPropagation();
                deleteNoteById(noteId);
            }
            return;
        }
        const item = event.target.closest('.note-list-item');
        const noteId = item?.dataset.noteId;
        if (noteId) {
            loadNote(noteId);
        }
    });

    notesList.dataset.bound = '1';
}

// 创建新笔记
window.createNewNote = () => {
    const newNote = {
        id: generateNoteId(),
        title: '',
        content: '',
        createdAt: Date.now(),
        updatedAt: Date.now()
    };

    notesData.notes.unshift(newNote);
    notesData.currentNoteId = newNote.id;
    saveNotesData();
    renderNotesList();
    loadNote(newNote.id);

    // 聚焦到标题输入框
    setTimeout(() => {
        const titleInput = document.getElementById('noteTitle');
        if (titleInput) titleInput.focus();
    }, 100);
};

// 加载笔记
function loadNote(noteId) {
    const note = notesData.notes.find(n => n.id === noteId);
    if (!note) return;

    notesData.currentNoteId = noteId;
    saveNotesData();

    const titleInput = document.getElementById('noteTitle');
    const contentTextarea = document.getElementById('noteContent');

    if (titleInput) titleInput.value = note.title || '';
    if (contentTextarea) contentTextarea.value = note.content || '';

    renderNotesList();
    updateWordCount();

    // 设置自动保存
    setupAutoSave();
}

window.loadNote = loadNote;

function handleNoteContentInput() {
    saveCurrentNote();
    updateWordCount();
}

// 设置自动保存
function setupAutoSave() {
    const titleInput = document.getElementById('noteTitle');
    const contentTextarea = document.getElementById('noteContent');

    if (titleInput) {
        titleInput.removeEventListener('input', saveCurrentNote);
        titleInput.addEventListener('input', saveCurrentNote);
    }

    if (contentTextarea) {
        contentTextarea.removeEventListener('input', handleNoteContentInput);
        contentTextarea.addEventListener('input', handleNoteContentInput);
    }
}

// 保存当前笔记
function saveCurrentNote() {
    if (!notesData.currentNoteId) return;

    const note = notesData.notes.find(n => n.id === notesData.currentNoteId);
    if (!note) return;

    const titleInput = document.getElementById('noteTitle');
    const contentTextarea = document.getElementById('noteContent');

    note.title = titleInput?.value || '';
    note.content = contentTextarea?.value || '';
    note.updatedAt = Date.now();

    saveNotesData();
    renderNotesList();
}

// 更新字数统计
function updateWordCount() {
    const contentTextarea = document.getElementById('noteContent');
    const wordCountEl = document.getElementById('noteWordCount');

    if (contentTextarea && wordCountEl) {
        const text = contentTextarea.value;
        const count = text.length;
        wordCountEl.textContent = `${count} 字`;
    }
}

// 切换预览模式
window.toggleNotePreview = () => {
    const editorWrapper = document.getElementById('editorWrapper');
    const previewWrapper = document.getElementById('previewWrapper');
    const previewToggle = document.getElementById('previewToggle');

    if (!editorWrapper || !previewWrapper) return;

    const isPreviewVisible = previewWrapper.style.display !== 'none';

    if (isPreviewVisible) {
        // 切换回编辑模式
        editorWrapper.style.display = 'block';
        previewWrapper.style.display = 'none';
        previewToggle.innerHTML = '<span>👁️</span><span>预览</span>';
    } else {
        // 切换到预览模式
        editorWrapper.style.display = 'none';
        previewWrapper.style.display = 'block';
        previewToggle.innerHTML = '<span>✏️</span><span>编辑</span>';
        renderMarkdownPreview();
    }
};

// 渲染 Markdown 预览
function renderMarkdownPreview() {
    const contentTextarea = document.getElementById('noteContent');
    const previewEl = document.getElementById('notePreview');

    if (!contentTextarea || !previewEl) return;

    const markdown = contentTextarea.value;
    previewEl.innerHTML = parseMarkdown(markdown);
}

// 简易 Markdown 解析器
function parseMarkdown(markdown) {
    if (!markdown) return '<p class="text-muted">无内容</p>';

    let html = markdown;

    // 代码块（需要在其他规则之前处理）
    html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');

    // 行内代码
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // 标题
    html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
    html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
    html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');

    // 粗体
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__(.*?)__/g, '<strong>$1</strong>');

    // 斜体
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    html = html.replace(/_(.*?)_/g, '<em>$1</em>');

    // 删除线
    html = html.replace(/~~(.*?)~~/g, '<del>$1</del>');

    // 链接
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

    // 图片
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width: 100%; border-radius: 8px;" />');

    // 分割线
    html = html.replace(/^---$/gim, '<hr>');
    html = html.replace(/^\*\*\*$/gim, '<hr>');

    // 引用
    html = html.replace(/^&gt; (.*$)/gim, '<blockquote>$1</blockquote>');
    html = html.replace(/^> (.*$)/gim, '<blockquote>$1</blockquote>');

    // 无序列表
    html = html.replace(/^\* (.*$)/gim, '<li>$1</li>');
    html = html.replace(/^- (.*$)/gim, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');

    // 有序列表
    html = html.replace(/^\d+\. (.*$)/gim, '<li>$1</li>');

    // 段落
    html = html.split('\n\n').map(para => {
        if (para.match(/^<(h[1-3]|ul|ol|pre|blockquote|hr)/)) {
            return para;
        }
        return '<p>' + para.replace(/\n/g, '<br>') + '</p>';
    }).join('\n');

    return html;
}

// 导出当前笔记
window.exportCurrentNote = () => {
    if (!notesData.currentNoteId) {
        showToast('请先选择一个笔记');
        return;
    }

    const note = notesData.notes.find(n => n.id === notesData.currentNoteId);
    if (!note) return;

    const content = `# ${note.title || '无标题笔记'}\n\n${note.content}`;
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${note.title || '笔记'}_${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast('笔记已导出');
};

// 批量导出所有笔记
window.exportAllNotes = () => {
    if (notesData.notes.length === 0) {
        showToast('暂无笔记可导出');
        return;
    }

    // 合并所有笔记为一个 Markdown 文件
    const allContent = notesData.notes.map(note => {
        return `# ${note.title || '无标题笔记'}\n\n${note.content}\n\n---\n`;
    }).join('\n');

    const blob = new Blob([allContent], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `所有笔记_${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast(`已导出 ${notesData.notes.length} 篇笔记`);
};

// 删除当前笔记（从右栏工具栏调用）
window.deleteCurrentNote = () => {
    if (!notesData.currentNoteId) {
        showToast('请先选择一个笔记');
        return;
    }
    deleteNoteById(notesData.currentNoteId);
};

// 删除指定笔记（从列表项调用）
window.deleteNoteById = (noteId) => {
    const note = notesData.notes.find(n => n.id === noteId);
    if (!note) return;

    const confirmMsg = `确定要删除笔记"${note.title || '无标题笔记'}"吗？`;
    showModal('删除笔记', confirmMsg, () => {
        notesData.notes = notesData.notes.filter(n => n.id !== noteId);

        // 如果删除的是当前笔记，切换到其他笔记
        if (notesData.currentNoteId === noteId) {
            if (notesData.notes.length > 0) {
                notesData.currentNoteId = notesData.notes[0].id;
                loadNote(notesData.currentNoteId);
            } else {
                notesData.currentNoteId = null;
                const titleInput = document.getElementById('noteTitle');
                const contentTextarea = document.getElementById('noteContent');
                if (titleInput) titleInput.value = '';
                if (contentTextarea) contentTextarea.value = '';
                updateWordCount();
            }
        }

        saveNotesData();
        renderNotesList();
        showToast('笔记已删除');
    });
};

// ========== 麦克风和摄像头控制 ==========
let microphoneEnabled = true;
let cameraEnabled = true;

// 初始化麦克风状态
function initMicrophoneStatus() {
    sendMessage('system', 'getMicrophoneStatus', {}, (response) => {
        if (response && response.code === 0) {
            microphoneEnabled = response.data.enabled;
            updateMicrophoneUI();
        }
    });
}

// 更新麦克风UI显示
function updateMicrophoneUI() {
    const micIcon = document.getElementById('micIcon');
    const micLabel = document.getElementById('micLabel');
    const micBadge = document.getElementById('micBadge');

    if (microphoneEnabled) {
        micIcon.textContent = '🎙️';
        micLabel.textContent = '麦克风';
        micBadge.style.display = 'block';
        micBadge.style.color = '#34c759'; // 绿色圆点
    } else {
        micIcon.textContent = '🎙️';
        micLabel.textContent = '已禁用';
        micBadge.style.display = 'block';
        micBadge.style.color = '#ff453a'; // 红色圆点
    }
}

window.toggleMicrophone = () => {
    const newState = !microphoneEnabled;

    sendMessage('system', 'setMicrophoneStatus', { enabled: newState }, (response) => {
        if (response && response.code === 0) {
            microphoneEnabled = newState;
            updateMicrophoneUI();
            showToast(microphoneEnabled ? '麦克风已启用' : '麦克风已禁用');
        } else {
            showToast('麦克风状态切换失败');
        }
    });
};

// ========== 面板开关控制 ==========
let panelEnabled = true;

// 初始化面板状态
function initPanelStatus() {
    sendMessage('panel', 'getStatus', {}, (response) => {
        if (response && response.code === 0) {
            panelEnabled = response.data.enabled;
            updatePanelUI();
        }
    });
}

// 更新面板UI显示
function updatePanelUI() {
    const panelIcon = document.getElementById('panelIcon');
    const panelLabel = document.getElementById('panelLabel');
    const panelBadge = document.getElementById('panelBadge');

    if (panelEnabled) {
        panelIcon.textContent = '💡';
        panelLabel.textContent = '面板';
        panelBadge.style.display = 'block';
        panelBadge.style.color = '#34c759'; // 绿色圆点
    } else {
        panelIcon.textContent = '💡';
        panelLabel.textContent = '已关闭';
        panelBadge.style.display = 'block';
        panelBadge.style.color = '#ff453a'; // 红色圆点
    }
}

window.togglePanel = () => {
    const newState = !panelEnabled;

    sendMessage('panel', 'setEnabled', { enabled: newState }, (response) => {
        if (response && response.code === 0) {
            panelEnabled = newState;
            updatePanelUI();
            showToast(panelEnabled ? '面板已开启' : '面板已关闭');
        } else {
            console.warn('[Panel] 状态切换失败:', response);
            showToast(`面板状态切换失败: ${formatDeviceCommandError(response)}`);
        }
    });
};

// ========== 显示配置警告 ==========
let countdownTimer = null;

window.openDisplayConfig = () => {
    // Debug build: skip the warning modal to speed up iteration.
    if (hostDebugMode) {
        openPage('rk628-config');
        return;
    }

    const warningContent = `
        <div style="line-height: 1.6; color: var(--text-primary); padding: 30px;">
            <!-- 顶部警告标题 -->
            <div style="text-align: center; margin-bottom: 30px;">
                <div style="font-size: 80px; margin-bottom: 15px;">⚠️</div>
                <div style="font-size: 32px; font-weight: 700; color: #ff453a;">
                    危险操作警告
                </div>
            </div>

            <!-- 两栏布局 -->
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 30px; margin-bottom: 30px;">
                <!-- 左栏：可能后果 -->
                <div style="background: rgba(255, 69, 58, 0.12); padding: 25px; border-radius: 12px; border: 2px solid rgba(255, 69, 58, 0.3);">
                    <div style="font-size: 26px; font-weight: 700; color: #ff453a; margin-bottom: 20px; display: flex; align-items: center; gap: 10px;">
                        <span style="font-size: 32px;">⚠️</span>
                        <span>可能导致的严重后果</span>
                    </div>
                    <ul style="margin: 0; padding-left: 35px; list-style: none;">
                        <li style="margin: 15px 0; font-size: 22px; color: var(--text-primary); position: relative; padding-left: 10px;">
                            <span style="position: absolute; left: -25px; color: #ff453a; font-weight: bold;">•</span>
                            屏幕黑屏，无法显示任何内容
                        </li>
                        <li style="margin: 15px 0; font-size: 22px; color: var(--text-primary); position: relative; padding-left: 10px;">
                            <span style="position: absolute; left: -25px; color: #ff453a; font-weight: bold;">•</span>
                            屏幕损坏，出现花屏、竖线等异常
                        </li>
                        <li style="margin: 15px 0; font-size: 22px; color: var(--text-primary); position: relative; padding-left: 10px;">
                            <span style="position: absolute; left: -25px; color: #ff453a; font-weight: bold;">•</span>
                            系统无法启动，需要重新刷机
                        </li>
                        <li style="margin: 15px 0; font-size: 22px; color: var(--text-primary); position: relative; padding-left: 10px;">
                            <span style="position: absolute; left: -25px; color: #ff453a; font-weight: bold;">•</span>
                            硬件永久性损坏，无法修复
                        </li>
                    </ul>
                </div>

                <!-- 右栏：操作前提 -->
                <div style="background: rgba(255, 159, 10, 0.12); padding: 25px; border-radius: 12px; border: 2px solid rgba(255, 159, 10, 0.3);">
                    <div style="font-size: 26px; font-weight: 700; color: #ff9f0a; margin-bottom: 20px; display: flex; align-items: center; gap: 10px;">
                        <span style="font-size: 32px;">⚡</span>
                        <span>操作前请确保</span>
                    </div>
                    <ul style="margin: 0; padding-left: 35px; list-style: none;">
                        <li style="margin: 15px 0; font-size: 22px; color: var(--text-primary); position: relative; padding-left: 10px;">
                            <span style="position: absolute; left: -25px; color: #ff9f0a; font-weight: bold;">✓</span>
                            完全了解RK628显示芯片的工作原理
                        </li>
                        <li style="margin: 15px 0; font-size: 22px; color: var(--text-primary); position: relative; padding-left: 10px;">
                            <span style="position: absolute; left: -25px; color: #ff9f0a; font-weight: bold;">✓</span>
                            知道当前屏幕的正确时序参数
                        </li>
                        <li style="margin: 15px 0; font-size: 22px; color: var(--text-primary); position: relative; padding-left: 10px;">
                            <span style="position: absolute; left: -25px; color: #ff9f0a; font-weight: bold;">✓</span>
                            已备份当前的配置参数
                        </li>
                        <li style="margin: 15px 0; font-size: 22px; color: var(--text-primary); position: relative; padding-left: 10px;">
                            <span style="position: absolute; left: -25px; color: #ff9f0a; font-weight: bold;">✓</span>
                            有能力在出现问题时恢复系统
                        </li>
                    </ul>
                </div>
            </div>

            <!-- 底部倒计时 -->
            <div style="text-align: center; background: rgba(255, 69, 58, 0.08); padding: 20px; border-radius: 12px;">
                <div style="font-size: 24px; font-weight: 700; color: #ff453a;" id="countdownText">
                    请仔细阅读以上警告信息 (<span id="countdown" style="font-size: 28px; font-weight: 800;">10</span> 秒后可继续)
                </div>
            </div>
        </div>
    `;

    showModal('⚠️ 显示配置 - 危险操作警告', warningContent, () => {
        // 确认后打开显示配置页面
        openPage('rk628-config');
    }, 'lg');

    // 禁用确认按钮
    const confirmBtn = document.getElementById('modalConfirm');
    confirmBtn.disabled = true;
    confirmBtn.style.opacity = '0.5';
    confirmBtn.style.cursor = 'not-allowed';

    // 开始倒计时
    let countdown = 10;
    const countdownSpan = document.getElementById('countdown');
    const countdownText = document.getElementById('countdownText');

    // 清除之前的计时器
    if (countdownTimer) {
        clearInterval(countdownTimer);
    }

    countdownTimer = setInterval(() => {
        countdown--;
        if (countdownSpan) {
            countdownSpan.textContent = countdown;
        }

        if (countdown <= 0) {
            clearInterval(countdownTimer);
            countdownTimer = null;

            // 启用确认按钮
            confirmBtn.disabled = false;
            confirmBtn.style.opacity = '1';
            confirmBtn.style.cursor = 'pointer';

            // 更新提示文本
            if (countdownText) {
                countdownText.innerHTML = '<span style="color: #34c759; font-size: 24px; font-weight: 700;">✓ 您可以点击"确定"按钮继续</span>';
            }
        }
    }, 1000);
};

// ========== 便签功能 ==========
// 自动保存定时器
let autoSaveTimer = null;
// 自动保存便签
function autoSaveStickyNote() {
    const noteContent = document.getElementById('notesTextarea').value;
    localStorage.setItem('stickyNote', noteContent);
}

// 监听便签输入，实现自动保存
function initAutoSaveSticky() {
    const textarea = document.getElementById('notesTextarea');
    if (textarea) {
        textarea.addEventListener('input', () => {
            // 清除之前的定时器
            if (autoSaveTimer) {
                clearTimeout(autoSaveTimer);
            }
            // 500ms后自动保存
            autoSaveTimer = setTimeout(autoSaveStickyNote, 500);
        });
    }
}
function loadStickyNote() {
    const savedNote = localStorage.getItem('stickyNote');
    if (savedNote) {
        const textarea = document.getElementById('notesTextarea');
        if (textarea) textarea.value = savedNote;
    }
}
// ========== 待办事项功能 ==========
let todoItems = [];
// 添加待办事项
window.addTodoItem = () => {
    const textarea = document.getElementById('notesTextarea');
    const content = textarea.value.trim();
    if (!content) {
        showToast('请输入待办内容');
        textarea.focus();
        return;
    }
    const todo = {
        id: Date.now(),
        content: content,
        completed: false,
        createdAt: new Date().toLocaleString('zh-CN')
    };
    todoItems.unshift(todo);
    saveTodoItems();
    renderTodoList();
    // 清空输入框并聚焦
    textarea.value = '';
    textarea.focus();
    autoSaveStickyNote();
    showToast('待办已添加');
};
// 切换待办完成状态
function toggleTodo(id) {
    const todo = todoItems.find(item => item.id === id);
    if (todo) {
        todo.completed = !todo.completed;
        saveTodoItems();
        renderTodoList();
    }
}
// 删除待办事项
function deleteTodo(id) {
    todoItems = todoItems.filter(item => item.id !== id);
    saveTodoItems();
    renderTodoList();
    showToast('待办已删除');
}
// 渲染待办列表
function renderTodoList() {
    const todoList = document.getElementById('todoList');
    if (!todoList) return;
    // 更新待办计数
    updateTodoCounter();

    if (window.UIMisc?.renderTodoList) {
        window.UIMisc.renderTodoList(todoList, todoItems);
    }
    if (window.UIMisc?.bindTodoList) {
        window.UIMisc.bindTodoList(todoList, {
            onToggle: toggleTodo,
            onDelete: deleteTodo,
        });
    }
}
// 更新待办计数器
function updateTodoCounter() {
    const header = document.querySelector('.notes-header span');
    if (!header) return;
    const total = todoItems.length;
    const completed = todoItems.filter(item => item.completed).length;
    const pending = total - completed;
    if (total === 0) {
        header.textContent = '📝 便签';
    } else {
        header.textContent = `📝 便签 (${pending}/${total})`;
    }
}
// 保存待办到本地存储
function saveTodoItems() {
    if (window.UIMisc?.saveTodoItems) {
        window.UIMisc.saveTodoItems(todoItems);
    }
}
// 加载待办列表
function loadTodoItems() {
    const saved = localStorage.getItem('todoItems');
    if (saved) {
        try {
            todoItems = JSON.parse(saved);
            renderTodoList();
        } catch (e) {
            console.error('加载待办列表失败:', e);
            todoItems = [];
        }
    }
}
// 初始化便签快捷键
function initNotesKeyboard() {
    const textarea = document.getElementById('notesTextarea');
    if (textarea) {
        textarea.addEventListener('keydown', (e) => {
            // Ctrl+Enter 添加待办
            if (e.ctrlKey && e.key === 'Enter') {
                e.preventDefault();
                addTodoItem();
            }
        });
    }
}
// 取色器
let currentHue = 210;
let currentSaturation = 100;
let currentBrightness = 100;
let recentColors = ['#0a84ff', '#ff3b30', '#34c759', '#ff9500', '#af52de', '#5856d6'];
const presetColors = [
    '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#30b0c7',
    '#0a84ff', '#5856d6', '#af52de', '#ff2d55', '#a2845e', '#8e8e93',
    '#ff6961', '#ffb347', '#fdfd96', '#77dd77', '#84b6f4', '#b19cd9',
    '#000000', '#444444', '#888888', '#cccccc', '#eeeeee', '#ffffff'
];
window.openColorPicker = () => {
    const colorPickerHTML = window.UIMisc?.buildColorPickerModal
        ? window.UIMisc.buildColorPickerModal(presetColors, currentHue, currentSaturation, currentBrightness, recentColors)
        : '';
    showModal('🎨 取色器', colorPickerHTML, null, 'xl');
    setTimeout(() => {
        if (window.UIMisc?.initColorPicker) {
            window.UIMisc.initColorPicker({
                presetColors,
                recentColors,
                currentHue,
                currentSaturation,
                currentBrightness,
            }, {
                onStateChange: (next) => {
                    currentHue = next.currentHue;
                    currentSaturation = next.currentSaturation;
                    currentBrightness = next.currentBrightness;
                }
            });
        }
    }, 100);
};
// ========== 壁纸设置 ==========
const DEFAULT_WALLPAPER = 'linear-gradient(135deg, #00c6ff 0%, #0072ff 100%)';
const presetWallpapers = [
    { name: '深空灰', type: 'gradient', value: 'linear-gradient(135deg, #1a1a1d 0%, #2d2d30 100%)' },
    { name: '午夜蓝', type: 'gradient', value: 'linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)' },
    { name: '日落橙', type: 'gradient', value: 'linear-gradient(135deg, #ff6b6b 0%, #ee5a6f 50%, #c44569 100%)' },
    { name: '森林绿', type: 'gradient', value: 'linear-gradient(135deg, #134e5e 0%, #71b280 100%)' },
    { name: '紫色迷雾', type: 'gradient', value: 'linear-gradient(135deg, #2b5876 0%, #4e4376 100%)' },
    { name: '极光', type: 'gradient', value: DEFAULT_WALLPAPER },
    { name: '玫瑰金', type: 'gradient', value: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)' },
    // { name: '纯黑', type: 'solid', value: '#000000' },
    { name: '深灰', type: 'solid', value: '#1c1c1e' },
    { name: '墨蓝', type: 'solid', value: '#1a1f3a' }
];
window.openWallpaperSettings = () => {
    const currentBg = localStorage.getItem('wallpaper') || DEFAULT_WALLPAPER;
    const wallpaperBody = window.UIMisc?.buildWallpaperModal
        ? window.UIMisc.buildWallpaperModal(currentBg, presetWallpapers)
        : '';
    showModal('🖼️ 壁纸设置', wallpaperBody, null, 'lg');
    setTimeout(() => {
        if (window.UIMisc?.bindWallpaperControls) {
            window.UIMisc.bindWallpaperControls(presetWallpapers, {
                onApplyWallpaper: (value) => window.UIMisc?.applyWallpaper && window.UIMisc.applyWallpaper(value),
                onUpdatePreview: (value) => window.UIMisc?.updateWallpaperPreview && window.UIMisc.updateWallpaperPreview(value),
                onLocalUpload: handleLocalImageUpload,
                onApplyColor: () => window.UIMisc?.applyCustomColor && window.UIMisc.applyCustomColor(),
                onApplyImage: () => window.UIMisc?.applyCustomImage && window.UIMisc.applyCustomImage(),
                onReset: () => window.UIMisc?.resetWallpaper && window.UIMisc.resetWallpaper(DEFAULT_WALLPAPER),
            });
        }
    }, 100);
};
// 处理本地图片上传
const handleLocalImageUpload = (e) => {
    const file = e.target.files[0];
    const result = window.UIMisc?.handleLocalWallpaperFile
        ? window.UIMisc.handleLocalWallpaperFile(file)
        : { ok: false, message: '请选择图片文件' };
    if (!result.ok) {
        showToast(result.message);
        return;
    }
    if (window.UIMisc?.readLocalWallpaperFile) {
        window.UIMisc.readLocalWallpaperFile(file, {
            onLoad: (base64Image) => {
                const wallpaperValue = `url('${base64Image}')`;
                if (window.UIMisc?.applyWallpaper) {
                    window.UIMisc.applyWallpaper(wallpaperValue);
                }
                if (window.UIMisc?.updateWallpaperPreview) {
                    window.UIMisc.updateWallpaperPreview(wallpaperValue);
                }
                showToast('本地图片已应用');
            },
            onError: () => {
                showToast('图片读取失败');
            },
        });
    }
};
window.applyCustomColor = () => {
    if (window.UIMisc?.applyCustomColor) {
        window.UIMisc.applyCustomColor();
    }
};
window.applyCustomImage = () => {
    if (!window.UIMisc?.applyCustomImage) {
        return;
    }
    const result = window.UIMisc.applyCustomImage();
    if (!result.ok) {
        showToast(result.message);
    }
};
window.resetWallpaper = () => {
    if (window.UIMisc?.resetWallpaper) {
        window.UIMisc.resetWallpaper(DEFAULT_WALLPAPER);
    }
    showToast('已恢复默认壁纸');
};

// ========== 主初始化函数 ==========
document.addEventListener('DOMContentLoaded', () => {
    console.log('[System] 智能触控条启动中...');
    try {
        // Home clock should tick even if WebSocket is down
        startHomeClock();
        // 初始化WebSocket
        initWebSocket();
        // 初始化页面导航
        initPagination();
        // 初始化第二页Widget
        initPage2Widgets();
        // 初始化输入控制
        initInputControl();
        // 性能监控将在打开监控页面时初始化(不在这里初始化)

        // 初始化设置
        initSettings();
        // 加载便签内容
        loadStickyNote();
        // 初始化自动保存
        initAutoSaveSticky();
        // 加载待办列表
        loadTodoItems();
        // 初始化便签快捷键
        initNotesKeyboard();
        // 加载壁纸设置
        if (window.UIMisc?.loadSavedWallpaper) {
            window.UIMisc.loadSavedWallpaper(DEFAULT_WALLPAPER);
        }
        // 应用已保存的语言设置
        const savedLang = localStorage.getItem('language');
        // if (savedLang) {
        //     changeLanguage(savedLang);
        // }
        console.log('[System] ✓ 所有模块初始化完成');
        // 注意：网络监控已合并到性能监控订阅中，无需单独订阅
    } catch (error) {
        console.error('[System] 初始化错误:', error);
        showToast('系统初始化失败，请刷新页面', 5000);
    }
});
// ==================== 系统更新功能（安全更新）====================
let secureUpdateCheckOperationId = null;
let secureUpdateAvailableInfo = null;
let secureUpdateCheckTimer = null;
let onlineUpdateStartedAt = 0;
let onlineUpdateElapsedTimer = null;

function setOnlineUpdateProgressVisible(visible) {
    const progress = document.getElementById('updateProgress');
    const summary = document.getElementById('onlineUpdateSummary');
    if (progress) {
        progress.hidden = !visible;
        progress.style.display = visible ? 'flex' : 'none';
    }
    if (summary) summary.hidden = visible;
}

function updateOnlineUpdateElapsed() {
    const elapsed = document.getElementById('updateProgressElapsed');
    if (!elapsed || !onlineUpdateStartedAt) return;
    const seconds = Math.max(0, Math.floor((Date.now() - onlineUpdateStartedAt) / 1000));
    const minutes = Math.floor(seconds / 60);
    elapsed.textContent = `耗时 ${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function resetOnlineUpdateProgress() {
    onlineUpdateStartedAt = Date.now();
    updateOnlineUpdateElapsed();
    if (onlineUpdateElapsedTimer) clearInterval(onlineUpdateElapsedTimer);
    onlineUpdateElapsedTimer = setInterval(updateOnlineUpdateElapsed, 1000);
    setOnlineUpdateProgressVisible(true);
}

function finishOnlineUpdateProgress() {
    if (onlineUpdateElapsedTimer) {
        clearInterval(onlineUpdateElapsedTimer);
        onlineUpdateElapsedTimer = null;
    }
    updateOnlineUpdateElapsed();
}

function resetOnlineUpdateView() {
    finishOnlineUpdateProgress();
    onlineUpdateStartedAt = 0;
    secureUpdateAvailableInfo = null;
    secureUpdateCheckOperationId = null;
    secureUpdateInProgress = false;
    if (secureUpdateCheckTimer) {
        clearTimeout(secureUpdateCheckTimer);
        secureUpdateCheckTimer = null;
    }
    setOnlineUpdateAction('check');
    setOnlineUpdateProgressVisible(false);

    const updateStatus = document.getElementById('updateStatus');
    const progress = document.getElementById('updateProgress');
    const fill = document.getElementById('updateProgressFill');
    const text = document.getElementById('updateProgressText');
    const stage = document.getElementById('updateProgressStage');
    const units = document.getElementById('updateProgressUnits');
    const elapsed = document.getElementById('updateProgressElapsed');
    const details = document.getElementById('updateProgressDetails');
    if (updateStatus) {
        updateStatus.textContent = '准备就绪';
        updateStatus.style.color = '';
    }
    if (progress) progress.dataset.state = 'waiting';
    if (fill) fill.style.width = '0%';
    if (text) text.textContent = '0%';
    if (stage) stage.textContent = '等待开始';
    if (units) units.textContent = '阶段 0/3';
    if (elapsed) elapsed.textContent = '耗时 00:00';
    if (details) details.textContent = '准备中...';
}

function refreshOnlineUpdateViewAfterReconnect() {
    sendMessageWithTimeout('update', 'getProgress', {}, 5000, (response) => {
        const data = response?.data;
        if (response?.code !== 0 || !data) return;
        if (data.status === 'idle' && !data.readyToInstall) {
            resetOnlineUpdateView();
            return;
        }
        updateUpdateProgress(data);
    });
}

function refreshCurrentFirmwareVersion() {
    sendMessageWithTimeout('update', 'getVersion', {}, 3000, (response) => {
        const version = response?.data?.version;
        const element = document.getElementById('currentVersion');
        if (element) element.textContent = version || '未知';
    });
}

function setOnlineUpdateAction(action) {
    const checkButton = document.getElementById('checkUpdateBtn');
    const updateButton = document.getElementById('updateBtn');
    if (!checkButton || !updateButton) return;

    if (action === 'check') {
        checkButton.style.display = 'inline-flex';
        checkButton.disabled = false;
        updateButton.style.display = 'none';
        return;
    }

    checkButton.style.display = 'none';
    updateButton.style.display = 'inline-flex';
    updateButton.disabled = false;
    updateButton.style.opacity = '1';
    updateButton.classList.remove('btn-danger');
    updateButton.classList.add('btn-primary');
    if (action === 'download') {
        updateButton.onclick = startSecureDownload;
        updateButton.querySelector('span:last-child').textContent = '开始下载更新';
        updateButton.querySelector('.btn-icon').textContent = '⬇️';
    } else {
        updateButton.onclick = startSecureUpdate;
        updateButton.querySelector('span:last-child').textContent = '开始安全更新';
        updateButton.querySelector('.btn-icon').textContent = '🔐';
    }
}

const secureUpdateDetailLabels = {
    'preparing source': '正在准备更新源...',
    'metadata received': '已获取固件元数据',
    'metadata signature verified': '固件签名验证通过',
    'manifest validated': '版本清单验证完成',
    'downloaded and verified; ready to install': '固件下载并校验完成，等待安装'
};

function localizeSecureUpdateDetail(detail) {
    if (!detail) return '';
    if (secureUpdateDetailLabels[detail]) return secureUpdateDetailLabels[detail];
    const sourceMatch = /^connecting source (\d+)\/(\d+)$/.exec(detail);
    return sourceMatch
        ? `正在连接更新源 ${sourceMatch[1]}/${sourceMatch[2]}...`
        : detail;
}

function renderSecureUpdateCheckProgress(percent, detail, state = 'running') {
    const progress = document.getElementById('updateProgress');
    const fill = document.getElementById('updateProgressFill');
    const text = document.getElementById('updateProgressText');
    const details = document.getElementById('updateProgressDetails');
    const stage = document.getElementById('updateProgressStage');
    const units = document.getElementById('updateProgressUnits');
    const value = Math.max(0, Math.min(100, Number(percent) || 0));

    // Source fallback can take seconds. Keep device-reported check progress
    // visible; do not regress this flow to the status text alone.
    setOnlineUpdateProgressVisible(true);
    progress.dataset.state = state;
    fill.style.width = `${value}%`;
    text.textContent = `${Math.round(value)}%`;
    if (stage) stage.textContent = state === 'error' ? '检查失败' : (state === 'success' ? '检查完成' : '检查更新');
    if (units) units.textContent = '阶段 1/3';
    details.textContent = localizeSecureUpdateDetail(detail) || '正在检查更新...';
}

function finishSecureUpdateCheck(code, message, data) {
    const updateStatus = document.getElementById('updateStatus');
    const checkUpdateBtn = document.getElementById('checkUpdateBtn');
    const updateBtn = document.getElementById('updateBtn');

    if (secureUpdateCheckTimer) {
        clearTimeout(secureUpdateCheckTimer);
        secureUpdateCheckTimer = null;
    }
    finishOnlineUpdateProgress();

    checkUpdateBtn.disabled = false;
    checkUpdateBtn.style.opacity = '1';
    if (code === 0) {
        renderSecureUpdateCheckProgress(
            100,
            data && data.version ? `发现新版本 ${data.version}` : (message || '已是最新版本'),
            'success'
        );
        if (data && data.version) {
            if (isUpdateVersionIgnored(data.version)) {
                updateStatus.textContent = `已忽略更新 ${data.version}`;
                updateStatus.style.color = 'var(--text-secondary)';
                secureUpdateAvailableInfo = null;
                setOnlineUpdateAction('check');
                showToast(`已忽略 ${data.version}`, 2000);
                return;
            }
            updateStatus.textContent = `发现新版本 ${data.version}`;
            updateStatus.style.color = '#32d74b';
            secureUpdateAvailableInfo = data;
            setOnlineUpdateAction('download');
            showToast('发现新版本', 2000);
        } else {
            updateStatus.textContent = message || '已是最新版本';
            updateStatus.style.color = 'var(--text-secondary)';
            secureUpdateAvailableInfo = null;
            setOnlineUpdateAction('check');
            showToast(message || '已是最新版本', 2000);
        }
        return;
    }

    const currentPercent = parseFloat(document.getElementById('updateProgressText')?.textContent) || 0;
    renderSecureUpdateCheckProgress(currentPercent, message || '检查更新失败', 'error');
    updateStatus.textContent = message || '检查更新失败';
    updateStatus.style.color = '#ff453a';
    secureUpdateAvailableInfo = null;
    setOnlineUpdateAction('check');
    showToast(message || '检查更新失败', 3000);
}

function startSecureDownload() {
    const updateButton = document.getElementById('updateBtn');
    const updateStatus = document.getElementById('updateStatus');
    if (!secureUpdateAvailableInfo) {
        setOnlineUpdateAction('check');
        return;
    }
    updateButton.disabled = true;
    updateButton.style.opacity = '0.5';
    updateStatus.textContent = '正在下载并校验固件...';
    updateStatus.style.color = 'var(--accent-color)';
    resetOnlineUpdateProgress();
    renderSecureUpdateCheckProgress(0, '正在启动固件下载...', 'running');
    const stage = document.getElementById('updateProgressStage');
    const units = document.getElementById('updateProgressUnits');
    if (stage) stage.textContent = '下载固件';
    if (units) units.textContent = '阶段 1/3';
    sendMessage('update', 'startDownload', {}, (response) => {
        if (response.code !== 0) {
            updateButton.disabled = false;
            updateButton.style.opacity = '1';
            renderSecureUpdateCheckProgress(0, response.msg || '启动下载失败', 'error');
            finishOnlineUpdateProgress();
            showToast(response.msg || '启动下载失败', 3000);
            return;
        }
        secureUpdateInProgress = true;
        updateProgressTimer = null;
        showToast('固件下载已开始', 2000);
    });
}

/**
 * 检查安全更新（连接服务器查询是否有新版本）
 */
function checkSecureUpdate() {
    const updateStatus = document.getElementById('updateStatus');
    const checkUpdateBtn = document.getElementById('checkUpdateBtn');
    const updateBtn = document.getElementById('updateBtn');
    setOnlineUpdateAction('check');
    // 禁用检查按钮
    checkUpdateBtn.disabled = true;
    checkUpdateBtn.style.opacity = '0.5';
    updateStatus.textContent = '正在连接更新服务器...';
    updateStatus.style.color = 'var(--accent-color)';
    resetOnlineUpdateProgress();
    renderSecureUpdateCheckProgress(2, '正在准备更新源...');
    // 发送检查更新请求（服务器会返回最新版本信息）
    // 注意：这里不需要实际下载，只是查询版本信息
    sendMessage('update', 'checkUpdate', {}, (response) => {
        if (response.code !== 0) {
            finishSecureUpdateCheck(response.code, response.msg, null);
            return;
        }
        if (!response.data?.accepted || !response.data.operationId) {
            finishSecureUpdateCheck(9000, '设备返回了无效的检查更新响应', null);
            return;
        }
        secureUpdateCheckOperationId = response.data.operationId;
        updateStatus.textContent = '正在检查更新...';
        secureUpdateCheckTimer = setTimeout(() => {
            secureUpdateCheckOperationId = null;
            finishSecureUpdateCheck(9000, '检查更新超过 33 秒，请稍后重试', null);
        }, 32800);
    });
}
/**
 * 开始安全固件更新
 */
function startSecureUpdate() {
    const updateStatus = document.getElementById('updateStatus');
    const updateBtn = document.getElementById('updateBtn');
    const updateProgress = document.getElementById('updateProgress');
    const updateProgressFill = document.getElementById('updateProgressFill');
    const updateProgressText = document.getElementById('updateProgressText');
    const updateProgressDetails = document.getElementById('updateProgressDetails');
    // 确认对话框
    showConfirmDialog(
        '确认安全更新',
        '已下载并校验的固件将提交到备用分区，设备随后重启切换。\n\n请确保电源稳定。确定要开始安全更新吗？',
        () => {
            // 用户确认，开始安全更新
            resetOnlineUpdateProgress();
            updateBtn.disabled = true;
            updateBtn.style.opacity = '0.5';
            updateStatus.textContent = '正在连接更新服务器...';
            updateStatus.style.color = 'var(--accent-color)';
            setOnlineUpdateProgressVisible(true);
            updateProgress.dataset.state = 'running';
            updateProgressFill.style.width = '0%';
            updateProgressText.textContent = '0%';
            updateProgressDetails.textContent = '正在连接更新服务器...';
            // 发送安全更新请求到下位机（服务器URL已内置）
            sendMessage('update', 'startUpdate', {}, (response) => {
                if (response.code === 0) {
                    updateStatus.textContent = '设备认证中...';
                    updateProgressDetails.textContent = '正在进行HMAC-SHA256认证...';
                    showToast('安全更新已开始', 2000);
                    // 进度/错误由下位机实时推送 update:secureStatus
                    secureUpdateInProgress = true;
                } else {
                    updateBtn.disabled = false;
                    updateBtn.style.opacity = '1';
                    updateProgress.dataset.state = 'error';
                    updateStatus.textContent = response.msg || '启动更新失败';
                    updateStatus.style.color = '#ff453a';
                    updateProgressDetails.textContent = response.msg || '启动更新失败';
                    finishOnlineUpdateProgress();
                    showToast(response.msg || '启动更新失败', 3000);
                }
            });
        },
        () => {
            // 用户取消
            console.log('[SecureUpdate] 用户取消安全更新');
        }
    );
}
/**
 * 轮询更新进度
 */
let updateProgressTimer = null;
let secureUpdateInProgress = false;

function focusUpdateSettingsPanel() {
    try {
        // 打开设置页
        if (typeof openPage === 'function') {
            openPage('settings');
        }

        // 切到“更新”分区
        setTimeout(() => {
            const btn = document.querySelector('.settings-nav-item[data-settings-target="settings-update"]');
            if (btn) {
                btn.click();
            }

            const p = document.getElementById('updateProgress');
            if (p) {
                setOnlineUpdateProgressVisible(true);
            }
        }, 50);
    } catch (e) {
        console.warn('[Update] focusUpdateSettingsPanel failed:', e);
    }
}
function startUpdateProgressPolling() {
    if (updateProgressTimer) {
        clearInterval(updateProgressTimer);
    }
    updateProgressTimer = setInterval(() => {
        sendMessage('update', 'getProgress', {}, (response) => {
            if (response.code === 0 && response.data) {
                updateUpdateProgress(response.data);
            }
        });
    }, 500); // 每500ms查询一次
}
/**
 * 更新进度显示（支持安全更新流程）
 */
function updateUpdateProgress(data) {
    const updateStatus = document.getElementById('updateStatus');
    const updateProgress = document.getElementById('updateProgress');
    const updateProgressStage = document.getElementById('updateProgressStage');
    const updateProgressUnits = document.getElementById('updateProgressUnits');
    const updateProgressElapsed = document.getElementById('updateProgressElapsed');
    const updateProgressFill = document.getElementById('updateProgressFill');
    const updateProgressText = document.getElementById('updateProgressText');
    const updateProgressDetails = document.getElementById('updateProgressDetails');
    let percent = Number(data.percent || 0);
    if (!Number.isFinite(percent)) {
        percent = 0;
    }
    if (percent < 0) percent = 0;
    if (percent > 100) percent = 100;
    const detail = localizeSecureUpdateDetail(data.detail || '');
    if (!onlineUpdateStartedAt && !['idle', 'success', 'error'].includes(data.status)) {
        resetOnlineUpdateProgress();
    } else {
        setOnlineUpdateProgressVisible(true);
    }
    if (data.status !== 'success' && data.status !== 'error') {
        updateProgress.dataset.state = data.status === 'idle' ? 'waiting' : 'running';
    }
    updateProgressFill.style.width = `${percent}%`;
    updateProgressText.textContent = `${percent}%`;
    if (updateProgressElapsed) updateOnlineUpdateElapsed();
    if (data.status === 'idle') {
        // 空闲状态
        updateStatus.textContent = '准备就绪';
        if (updateProgressStage) updateProgressStage.textContent = '等待开始';
        if (updateProgressUnits) updateProgressUnits.textContent = '阶段 0/3';
        if (updateProgressDetails) updateProgressDetails.textContent = '等待开始...';
    } else if (data.status === 'authenticating') {
        // 设备认证中
        updateStatus.textContent = '设备认证中...';
        if (updateProgressStage) updateProgressStage.textContent = '设备认证';
        if (updateProgressUnits) updateProgressUnits.textContent = '阶段 1/3';
        if (updateProgressDetails) updateProgressDetails.textContent = detail || 'HMAC-SHA256认证中...';
    } else if (data.status === 'checking') {
        // 检查更新中
        updateProgress.dataset.state = 'running';
        updateStatus.textContent = '检查更新中...';
        if (updateProgressStage) updateProgressStage.textContent = '检查更新';
        if (updateProgressUnits) updateProgressUnits.textContent = '阶段 1/3';
        if (updateProgressDetails) updateProgressDetails.textContent = detail || '正在连接服务器...';
    } else if (data.status === 'downloading') {
        // 下载中
        const downloaded = Math.max(0, Number(data.downloaded) || 0);
        const total = Math.max(0, Number(data.total) || 0);
        const transferText = total > 0
            ? `已下载并写入 ${downloaded}/${total} KB`
            : `已下载并写入 ${downloaded} KB`;
        updateStatus.textContent = '正在下载并写入固件...';
        if (updateProgressStage) updateProgressStage.textContent = '下载固件';
        if (updateProgressUnits) updateProgressUnits.textContent = total > 0 ? `${downloaded}/${total} KB` : `${downloaded} KB`;
        if (updateProgressDetails) {
            updateProgressDetails.textContent = transferText;
        } else {
            updateStatus.textContent = `正在下载并写入固件... ${transferText}`;
        }
    } else if (data.status === 'decrypting') {
        // 固件数据处理中
        updateStatus.textContent = '正在解密固件...';
        if (updateProgressStage) updateProgressStage.textContent = '处理固件';
        if (updateProgressUnits) updateProgressUnits.textContent = '阶段 2/3';
        if (updateProgressDetails) updateProgressDetails.textContent = detail || 'AES-CTR解密 + SHA256校验...';
    } else if (data.status === 'writing') {
        // 写入Flash中
        updateStatus.textContent = '正在写入Flash...';
        if (updateProgressStage) updateProgressStage.textContent = '写入固件';
        if (updateProgressUnits) updateProgressUnits.textContent = '阶段 2/3';
        if (updateProgressDetails) updateProgressDetails.textContent = detail || '写入固件到存储器...';
    } else if (data.status === 'verifying') {
        // 校验中
        updateStatus.textContent = '正在校验固件...';
        if (updateProgressStage) updateProgressStage.textContent = '校验固件';
        if (updateProgressUnits) updateProgressUnits.textContent = '阶段 3/3';
        if (updateProgressDetails) updateProgressDetails.textContent = detail || '验证SHA256完整性...';
    } else if (data.status === 'success') {
        // 更新成功
        updateProgressFill.style.width = '100%';
        updateProgressText.textContent = '100%';
        updateProgress.dataset.state = 'success';
        if (updateProgressStage) updateProgressStage.textContent = data.readyToInstall ? '下载完成' : '更新完成';
        if (updateProgressUnits) updateProgressUnits.textContent = '阶段 3/3';
        if (data.readyToInstall) {
            finishOnlineUpdateProgress();
            updateStatus.textContent = '固件已下载并校验完成';
            updateStatus.style.color = '#32d74b';
            secureUpdateAvailableInfo = secureUpdateAvailableInfo || { version: data.version };
            setOnlineUpdateAction('install');
            if (updateProgressDetails) updateProgressDetails.textContent = detail || '固件已准备好，点击“开始安全更新”安装';
            secureUpdateInProgress = false;
            return;
        }
        updateStatus.textContent = '✓ 更新成功！系统将在2秒后重启...';
        updateStatus.style.color = '#32d74b';
        if (updateProgressDetails) updateProgressDetails.textContent = detail || '固件校验通过，准备重启...';
        finishOnlineUpdateProgress();
        secureUpdateAvailableInfo = null;
        secureUpdateInProgress = false;
        setOnlineUpdateAction('check');
        showToast('更新成功，系统即将重启', 3000);
        if (updateProgressTimer) {
            clearInterval(updateProgressTimer);
            updateProgressTimer = null;
        }
    } else if (data.status === 'error') {
        // 更新失败
        updateStatus.textContent = '✗ 更新失败';
        updateStatus.style.color = '#ff453a';
        updateProgress.dataset.state = 'error';
        if (updateProgressStage) updateProgressStage.textContent = '更新失败';
        finishOnlineUpdateProgress();
        if (updateProgressDetails) {
            updateProgressDetails.textContent = data.error || detail || '未知错误';
        } else {
            updateStatus.textContent = data.error || detail || '更新失败';
        }
        secureUpdateInProgress = false;
        setOnlineUpdateAction('check');
        showToast(data.error || '更新失败', 3000);
        if (updateProgressTimer) {
            clearInterval(updateProgressTimer);
            updateProgressTimer = null;
        }
    }
}
/**
 * 显示确认对话框
 */
function showConfirmDialog(title, message, onConfirm, onCancel) {
    const modal = document.getElementById('modal');
    const modalTitle = document.getElementById('modalTitle');
    const modalBody = document.getElementById('modalBody');
    const modalConfirm = document.getElementById('modalConfirm');
    const modalCancel = document.getElementById('modalCancel');
    const modalClose = document.getElementById('modalClose');
    modalTitle.textContent = title;
    modalBody.textContent = message;
    modal.style.display = 'flex';
    const confirmHandler = () => {
        modal.style.display = 'none';
        if (onConfirm) onConfirm();
        cleanup();
    };
    const cancelHandler = () => {
        modal.style.display = 'none';
        if (onCancel) onCancel();
        cleanup();
    };
    const cleanup = () => {
        modalConfirm.removeEventListener('click', confirmHandler);
        modalCancel.removeEventListener('click', cancelHandler);
        modalClose.removeEventListener('click', cancelHandler);
    };
    modalConfirm.addEventListener('click', confirmHandler);
    modalCancel.addEventListener('click', cancelHandler);
    modalClose.addEventListener('click', cancelHandler);
}

// ========== 手动固件更新 ==========
/**
 * 浏览选择固件文件
 */
function browseFirmwareFile() {
    console.log('[browseFirmwareFile] Calling pickFirmwareFile...');
    // 使用 system 模块，确保发送到上位机
    sendMessage('system', 'pickFirmwareFile', {}, (response) => {
        console.log('[browseFirmwareFile] Response:', response);
        if (response.code === 0 && response.data) {
            if (response.data.path) {
                document.getElementById('manualUpdatePath').value = response.data.path;
                showToast(`已选择: ${response.data.name}`);
            } else if (response.data.cancelled) {
                console.log('[browseFirmwareFile] User cancelled');
            }
        } else {
            console.error('[browseFirmwareFile] Error:', response);
            showToast('固件文件选择失败');
        }
    });
}

/**
 * 开始手动固件更新
 */
function startManualUpdate() {
    const pathInput = document.getElementById('manualUpdatePath');
    const preserveInput = document.getElementById('manualUpdatePreserveUserData');

    const pmfwPath = pathInput.value.trim();
    const preserveUserData = preserveInput ? preserveInput.checked : true;
    if (!pmfwPath) {
        showToast('请选择 PMFW 固件包');
        return;
    }

    if (!preserveUserData) {
        confirmFormatAllBeforeManualUpdate(pmfwPath);
        return;
    }

    continueManualUpdateAfterDataWarning(pmfwPath, preserveUserData);
}

function confirmFormatAllBeforeManualUpdate(pmfwPath) {
    showModal('确认清空用户数据', `
        <div style="line-height:1.7;">
            <div style="font-weight:900; color: rgba(255, 69, 58, 1);">危险操作：本次烧录将执行全量格式化。</div>
            <div style="margin-top:10px; color:var(--text-secondary);">未勾选“保留用户数据”时，上位机会擦除完整 16 MiB Flash，包括 VM、USER、FlashDB、EXTFLASH 等用户/数据库/扩展数据区。</div>
            <div style="margin-top:10px; color:var(--text-secondary);">如果需要保留配网、绑定、数据库或扩展存储数据，请取消并重新勾选“保留用户数据”。</div>
        </div>
    `, () => {
        closeMainModal();
        continueManualUpdateAfterDataWarning(pmfwPath, false);
        return false;
    }, 'md');

    const confirmBtn = document.getElementById('modalConfirm');
    if (confirmBtn) confirmBtn.textContent = '确认清空并继续';
}

function continueManualUpdateAfterDataWarning(pmfwPath, preserveUserData) {
    sendMessage('system', 'manualUpdatePreflight', {}, (response) => {
        if (!response || response.code !== 0) {
            showToast('无法检查更新设备状态，请稍后重试', 3000);
            return;
        }

        const state = response.data || {};
        if (state.downloadModePresent) {
            startManualUpdateTask(pmfwPath, preserveUserData, false);
            return;
        }

        if (state.serialConnected || serialConnected) {
            const usbId = normalizeUsbId(state.usbId ?? currentUsbId);
            if (usbId !== 0) {
                showUsb0UpdateGuidance(pmfwPath, preserveUserData, usbId);
                return;
            }
            confirmEnterUpgradeModeBeforeManualUpdate(pmfwPath, preserveUserData);
            return;
        }

        startManualUpdateTask(pmfwPath, preserveUserData, false);
    });
}

function showUsb0UpdateGuidance(pmfwPath, preserveUserData, usbId) {
    const current = usbVersionLabel(usbId) || '未知 USB 端口';
    showModal('请翻转 Type-C 接口', `
        <div class="usb0-guidance">
            <div class="usb0-guidance__current">当前串口连接：${current}，不是烧录所需的 USB0。</div>
            <div class="usb0-guidance__steps">请拔出并翻转设备的 Type-C 插头后重新插入，等待状态栏 COM 口旁显示“USB1.1”，再点击“重新检测”。</div>
        </div>
    `, () => {
        closeMainModal();
        continueManualUpdateAfterDataWarning(pmfwPath, preserveUserData);
        return false;
    }, 'md');

    const confirmBtn = document.getElementById('modalConfirm');
    if (confirmBtn) confirmBtn.textContent = '重新检测';
}

function confirmEnterUpgradeModeBeforeManualUpdate(pmfwPath, preserveUserData) {
    showModal('确认进入烧录模式', `
        <div style="line-height:1.7;">
            <div>当前设备仍处于正常连接状态，需要先重启到烧录模式。</div>
            <div style="margin-top:10px;color:var(--text-secondary);">点击“继续”后，上位机会先退出设备屏全屏并恢复原窗口位置，然后发送进入烧录模式指令。</div>
        </div>
    `, () => {
        const confirmBtn = document.getElementById('modalConfirm');
        const cancelBtn = document.getElementById('modalCancel');
        const closeBtn = document.getElementById('modalClose');
        if (confirmBtn) confirmBtn.disabled = true;
        if (cancelBtn) cancelBtn.disabled = true;
        if (closeBtn) closeBtn.disabled = true;

        sendMessage('system', 'restoreFromDeviceScreen', {}, (restoreResp) => {
            if (restoreResp && restoreResp.code !== 0) {
                console.warn('[ManualUpdate] 恢复窗口失败，仍继续进入烧录模式:', restoreResp.msg || restoreResp);
            }
            fullscreenActive = false;
            updateFullscreenButtonState(false);
            closeMainModal();
            startManualUpdateTask(pmfwPath, preserveUserData, true);
        });
        return false;
    }, 'md');

    const confirmBtn = document.getElementById('modalConfirm');
    if (confirmBtn) confirmBtn.textContent = '继续';
}

function startManualUpdateTask(pmfwPath, preserveUserData, enterUpgradeConfirmed) {
    const btn = document.getElementById('manualUpdateBtn');
    setManualUpdateButtonBusy(true);
    resetManualUpdateProgress(preserveUserData);
    renderManualUpdateProgress(
        0,
        enterUpgradeConfirmed ? '正在请求设备进入烧录模式...' : '正在准备固件和设备...',
        'running');

    sendMessage('system', 'manualUpdate', { path: pmfwPath, preserveUserData, enterUpgradeConfirmed }, (response) => {
        if (response.code !== 0) {
            const message = localizeManualUpdateError(response.msg);
            renderManualUpdateProgress(0, message, 'error');
            finishManualUpdateProgress();
            setManualUpdateButtonBusy(false);
            showToast(message, 3000);
        }
    });
}

const manualUpdateStageLabels = {
    OpeningPackage: '正在打开并验证 PMFW',
    PackageValidated: 'PMFW 验证通过',
    CapturingDeviceBaseline: '正在采集设备基线',
    RequestingUpgradeMode: '正在请求设备进入烧录模式',
    WaitingForDevice: '正在等待下载态设备',
    OpeningDevice: '正在等待并打开下载态设备',
    UploadingLoader: '正在上传并启动设备加载程序',
    NegotiatingSession: '正在建立加密下载会话',
    QueryingDevice: '正在读取芯片和闪存信息',
    ScanningPrivateData: '正在扫描用户数据区',
    ErasingFlash: '正在擦除完整 Flash',
    ProgrammingFlash: '正在比较并写入固件扇区',
    VerifyingFlash: '正在执行完整 Flash CRC 校验',
    ResettingDevice: '正在复位设备',
    WaitingForNormalMode: '正在等待正常模式稳定重枚举',
    Completed: '固件下载完成'
};
const manualUpdateStageOrder = [
    'OpeningPackage',
    'PackageValidated',
    'CapturingDeviceBaseline',
    'RequestingUpgradeMode',
    'WaitingForDevice',
    'OpeningDevice',
    'UploadingLoader',
    'NegotiatingSession',
    'QueryingDevice',
    'ScanningPrivateData',
    'ErasingFlash',
    'ProgrammingFlash',
    'VerifyingFlash',
    'ResettingDevice',
    'WaitingForNormalMode',
    'Completed'
];
let manualUpdateLastPercent = 0;
let manualUpdateStartedAt = 0;
let manualUpdateElapsedTimer = null;

function resetManualUpdateProgress(preserveUserData) {
    manualUpdateStartedAt = Date.now();
    const mode = document.getElementById('manualUpdateProgressMode');
    if (mode) mode.textContent = preserveUserData ? '保留用户数据' : '完整擦除 16 MiB';
    updateManualUpdateElapsed();
    if (manualUpdateElapsedTimer) clearInterval(manualUpdateElapsedTimer);
    manualUpdateElapsedTimer = setInterval(updateManualUpdateElapsed, 1000);
}

function finishManualUpdateProgress() {
    if (manualUpdateElapsedTimer) {
        clearInterval(manualUpdateElapsedTimer);
        manualUpdateElapsedTimer = null;
    }
    updateManualUpdateElapsed();
}

function updateManualUpdateElapsed() {
    const elapsed = document.getElementById('manualUpdateProgressElapsed');
    if (!elapsed || !manualUpdateStartedAt) return;
    const seconds = Math.max(0, Math.floor((Date.now() - manualUpdateStartedAt) / 1000));
    const minutes = Math.floor(seconds / 60);
    elapsed.textContent = `耗时 ${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function setManualUpdateButtonBusy(busy) {
    const btn = document.getElementById('manualUpdateBtn');
    if (!btn) return;
    btn.disabled = busy;
    btn.style.opacity = busy ? '0.55' : '1';
}

function renderManualUpdateProgress(percent, message, state = 'running') {
    const progress = document.getElementById('manualUpdateProgress');
    const warning = document.getElementById('manualUpdateWarning');
    const fill = document.getElementById('manualUpdateProgressFill');
    const text = document.getElementById('manualUpdateProgressText');
    const details = document.getElementById('manualUpdateProgressDetails');
    const value = Math.max(0, Math.min(100, Number(percent) || 0));
    manualUpdateLastPercent = value;
    if (warning) warning.hidden = true;
    if (progress) {
        progress.hidden = false;
        progress.dataset.state = state;
    }
    if (fill) fill.style.width = `${value}%`;
    if (text) text.textContent = `${value}%`;
    if (details) details.textContent = message || '处理中...';
}

function formatManualUpdateUnits(stage, completedUnits, totalUnits) {
    const index = manualUpdateStageOrder.indexOf(stage);
    const stageProgress = index >= 0 ? `阶段 ${index + 1}/${manualUpdateStageOrder.length}` : `阶段 ${stage || '未知'}`;
    if (!Number.isFinite(completedUnits) || !Number.isFinite(totalUnits) || totalUnits <= 0) {
        return stageProgress;
    }
    if (stage === 'UploadingLoader') {
        return `${stageProgress} · Loader ${completedUnits.toLocaleString()}/${totalUnits.toLocaleString()} 字节`;
    }
    if (stage === 'WaitingForNormalMode') {
        return `${stageProgress} · 稳定样本 ${completedUnits}/${totalUnits}`;
    }
    const sectorStages = ['ScanningPrivateData', 'ErasingFlash', 'ProgrammingFlash', 'VerifyingFlash'];
    if (sectorStages.includes(stage)) {
        return `${stageProgress} · 扇区 ${completedUnits.toLocaleString()}/${totalUnits.toLocaleString()}`;
    }
    return `${stageProgress} · ${completedUnits.toLocaleString()}/${totalUnits.toLocaleString()}`;
}

function handleManualUpdateProgress(data) {
    const stage = String(data.stage || '');
    const stageLabel = manualUpdateStageLabels[stage] || '正在处理固件更新';
    const completedUnits = Number(data.completedUnits);
    const totalUnits = Number(data.totalUnits);
    const stageElement = document.getElementById('manualUpdateProgressStage');
    const unitsElement = document.getElementById('manualUpdateProgressUnits');
    if (stageElement) stageElement.textContent = stageLabel;
    if (unitsElement) unitsElement.textContent = formatManualUpdateUnits(stage, completedUnits, totalUnits);
    renderManualUpdateProgress(data.percent, data.message || stageLabel, stage === 'Completed' ? 'success' : 'running');
}

function localizeManualUpdateError(error) {
    const raw = String(error || '');
    console.error('[ManualUpdate] 原始错误:', raw);
    if (/不是 USB0|翻转 Type-C/i.test(raw)) return '当前连接不是 USB0，请翻转 Type-C 插头，等待状态栏显示 USB1.1 后重试';
    if (/journal.*already completed/i.test(raw)) return '上次烧录记录已完成，请重新开始烧录';
    if (/another firmware update|recovery lease|already running/i.test(raw)) return '已有固件更新任务正在运行';
    if (/timeout|timed out|within 45 seconds/i.test(raw)) return '等待设备响应超时，请检查 USB 连接后重试';
    if (/pmfw|package/i.test(raw)) return 'PMFW 固件包无效或无法读取';
    if (/sha|hash|allowlist|signature|trusted/i.test(raw)) return '固件或设备加载程序完整性校验失败';
    if (/flash|sector|crc|verification/i.test(raw)) return '闪存写入或校验失败，请重新进入烧录模式后重试';
    if (/loader/i.test(raw)) return '设备加载程序启动失败，请重新连接设备后重试';
    if (/device|wl82|usb|scsi|storage/i.test(raw)) return '未找到可用的下载态设备，请检查 USB 连接后重试';
    return '固件烧录失败，请检查设备连接和固件包后重试';
}

/**
 * 处理手动更新事件 (WebSocket事件)
 */
function handleManualUpdateEvent(eventType, data) {
    if (eventType !== 'event' || !data) return;
    if (data.status === 'confirm_enter_upgrade') {
        handleManualUpdateConfirmation(data);
        return;
    }
    if (data.status === 'success') {
        renderManualUpdateProgress(100, '固件写入、校验和正常态启动均已完成', 'success');
        finishManualUpdateProgress();
        setManualUpdateButtonBusy(false);
        showToast('固件烧录成功', 3000);
    } else if (data.status === 'error') {
        renderManualUpdateProgress(manualUpdateLastPercent, localizeManualUpdateError(data.error), 'error');
        finishManualUpdateProgress();
        setManualUpdateButtonBusy(false);
        showToast('固件烧录失败', 3000);
    }
}

function handleManualUpdateConfirmation(data) {
    const requestId = data?.requestId;
    if (!requestId) {
        renderManualUpdateProgress(manualUpdateLastPercent, '缺少烧录确认 ID', 'error');
        finishManualUpdateProgress();
        setManualUpdateButtonBusy(false);
        return;
    }

    renderManualUpdateProgress(
        manualUpdateLastPercent,
        '等待确认进入烧录模式',
        'waiting');

    let responded = false;
    const respond = (ok) => {
        if (responded) return;
        responded = true;
        sendMessage('system', 'manualUpdateBootConfirm', { requestId, continue: ok }, (resp) => {
            if (!resp || resp.code !== 0) {
                renderManualUpdateProgress(manualUpdateLastPercent, '烧录确认响应失败，请重新开始', 'error');
                finishManualUpdateProgress();
                setManualUpdateButtonBusy(false);
            }
        });
    };

    const title = '确认进入烧录模式';
    const content = `
        <div style="line-height:1.7;">
            <div>设备即将重启到烧录模式，屏幕可能会短暂黑屏或断开连接。</div>
            <div style="margin-top:10px;color:var(--text-secondary);">点击“继续”后，上位机会先退出设备屏全屏并恢复原窗口位置，再发送重启到烧录模式指令。</div>
        </div>
    `;

    showModal(title, content, () => {
        renderManualUpdateProgress(manualUpdateLastPercent, '正在恢复主窗口并重启设备...', 'running');
        sendMessage('system', 'restoreFromDeviceScreen', {}, (restoreResp) => {
            if (restoreResp && restoreResp.code !== 0) {
                console.warn('[ManualUpdate] 恢复窗口失败，仍继续进入烧录模式:', restoreResp.msg || restoreResp);
            }
            fullscreenActive = false;
            updateFullscreenButtonState(false);
            renderManualUpdateProgress(manualUpdateLastPercent, '正在请求设备进入烧录模式...', 'running');
            respond(true);
        });
    }, 'md');

    const confirmBtn = document.getElementById('modalConfirm');
    const cancelBtn = document.getElementById('modalCancel');
    const closeBtn = document.getElementById('modalClose');
    if (confirmBtn) confirmBtn.textContent = '继续';
    const cancel = () => {
        renderManualUpdateProgress(manualUpdateLastPercent, '已取消固件烧录', 'error');
        finishManualUpdateProgress();
        setManualUpdateButtonBusy(false);
        respond(false);
        closeMainModal();
    };
    if (cancelBtn) {
        cancelBtn.textContent = '取消';
        cancelBtn.onclick = cancel;
    }
    if (closeBtn) closeBtn.onclick = cancel;
}

// ========== 固件更新事件处理 ==========
// ========== 联网更新：忽略版本 ==========
const IGNORED_UPDATE_VERSIONS_KEY = 'ignoredUpdateVersions';

function getIgnoredUpdateVersions() {
    try {
        const raw = localStorage.getItem(IGNORED_UPDATE_VERSIONS_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.filter(v => typeof v === 'string') : [];
    } catch (e) {
        return [];
    }
}

function isUpdateVersionIgnored(version) {
    if (!version) return false;
    return getIgnoredUpdateVersions().includes(String(version));
}

function ignoreUpdateVersion(version) {
    if (!version) return;
    const v = String(version);
    const list = getIgnoredUpdateVersions();
    if (!list.includes(v)) {
        list.push(v);
        localStorage.setItem(IGNORED_UPDATE_VERSIONS_KEY, JSON.stringify(list));
    }
}

/**
 * 处理固件更新事件
 * @param {Object} data - 更新事件数据
 * @param {string} data.event - 事件类型: available, downloading, ready_to_install, download_failed
 * @param {string} data.version - 固件版本
 * @param {string} data.changelog - 更新日志
 * @param {number} data.size - 固件大小（字节）
 * @param {boolean} data.force - 是否强制更新
 * @param {boolean} data.silent - 是否静默更新
 */
function handleUpdateEvent(data) {
    console.log('[Update] 收到更新事件:', data);
    switch (data.event) {
        case 'available':
            // 有新版本可用
            showUpdateAvailableDialog(data);
            break;
        case 'downloading':
            // 正在后台下载
            showToast('正在后台下载固件更新...', 3000);
            break;
        case 'ready_to_install':
            // 下载完成，准备安装
            showUpdateReadyDialog(data);
            break;
        case 'download_failed':
            // 下载失败
            showUpdateFailedDialog(data);
            break;
        default:
            console.warn('[Update] 未知更新事件:', data.event);
    }
}
/**
 * 显示"新版本可用"对话框
 */
function showUpdateAvailableDialog(updateInfo) {
    // 强制更新不允许忽略
    if (!updateInfo.force && isUpdateVersionIgnored(updateInfo.version)) {
        console.log('[Update] 已忽略该版本，跳过提示:', updateInfo.version);
        return;
    }

    const sizeInMB = (updateInfo.size / 1024 / 1024).toFixed(2);
    const forceText = updateInfo.force ? '<p style="color: #ff6b6b; font-weight: bold;">⚠ 这是强制更新，必须安装</p>' : '';
    const ignoreCtl = updateInfo.force
        ? ''
        : `<label class="update-ignore-row" style="margin-top: 14px; display: flex; gap: 10px; align-items: center; justify-content: flex-end;">
                <input type="checkbox" id="ignoreUpdateCheckbox">
                <span style="color: var(--text-secondary);">忽略此版本（不再提示 ${updateInfo.version}）</span>
           </label>`;
    const content = `
        <div style="text-align: left;">
            <p><strong>新版本:</strong> ${updateInfo.version}</p>
            <p><strong>大小:</strong> ${sizeInMB} MB</p>
            ${forceText}
            <div style="margin-top: 15px;">
                <strong>更新内容:</strong>
                <div class="update-changelog" style="margin-top: 8px;">
                    ${updateInfo.changelog ? updateInfo.changelog.replace(/\n/g, '<br>') : '（无）'}
                </div>
            </div>
            ${ignoreCtl}
        </div>
    `;
    showModal('发现新版本固件', content, () => {
        // 用户确认更新
        showToast('开始下载固件更新...', 3000);
        resetOnlineUpdateProgress();
        renderSecureUpdateCheckProgress(0, '正在启动固件下载...', 'running');
        sendMessage('update', 'startDownload', {}, (response) => {
            if (response.code === 0) {
                console.log('[Update] 下载已开始');
                secureUpdateInProgress = true;
                // 自动切到设置-更新页显示进度
                focusUpdateSettingsPanel();
            } else {
                finishOnlineUpdateProgress();
                renderSecureUpdateCheckProgress(0, response.msg || '启动下载失败', 'error');
                showToast('启动下载失败: ' + (response.msg || '未知错误'), 3000);
            }
        });
    });

    // 绑定“忽略此版本”复选框：勾选即生效并关闭弹窗
    if (!updateInfo.force) {
        setTimeout(() => {
            const cb = document.getElementById('ignoreUpdateCheckbox');
            if (!cb) return;
            cb.checked = false;
            cb.onchange = () => {
                if (!cb.checked) return;
                ignoreUpdateVersion(updateInfo.version);
                showToast(`已忽略 ${updateInfo.version}`, 2500);

                const statusEl = document.getElementById('updateStatus');
                const updateBtn = document.getElementById('updateBtn');
                if (statusEl) {
                    statusEl.textContent = `已忽略更新 ${updateInfo.version}`;
                    statusEl.style.color = 'var(--text-secondary)';
                }
                if (updateBtn) {
                    updateBtn.style.display = 'none';
                }

                const cancelBtn = document.getElementById('modalCancel');
                if (cancelBtn) cancelBtn.click();
            };
        }, 0);
    }
}
/**
 * 显示"更新已准备好安装"对话框
 */
function showUpdateReadyDialog(updateInfo) {
    const content = `
        <div style="text-align: left;">
            <p><strong>版本:</strong> ${updateInfo.version}</p>
            <p style="margin-top: 15px;">固件已下载完成并校验通过。</p>
            <p style="color: #ff6b6b; margin-top: 10px;">⚠ 设备将重启并安装新固件，请确保设备电源稳定。</p>
        </div>
    `;
    showModal('固件已准备好', content, () => {
        // 用户确认重启安装
        showToast('设备即将重启并安装更新...', 5000);
        sendMessage('update', 'installAndReboot', {}, (response) => {
            if (response.code === 0) {
                console.log('[Update] 设备正在重启...');
            } else {
                showToast('安装失败: ' + (response.msg || '未知错误'), 3000);
            }
        });
    });
}
/**
 * 显示"更新下载失败"对话框
 */
function showUpdateFailedDialog(updateInfo) {
    const content = `
        <div style="text-align: left;">
            <p><strong>版本:</strong> ${updateInfo.version}</p>
            <p style="margin-top: 15px; color: #ff6b6b;">固件下载或校验失败，可能是网络问题或服务器问题。</p>
            <p style="margin-top: 10px;">是否重新尝试下载？</p>
        </div>
    `;
    showModal('更新失败', content, () => {
        // 用户选择重试
        showToast('正在重新下载...', 3000);
        sendMessage('update', 'startDownload', {}, (response) => {
            if (response.code === 0) {
                console.log('[Update] 重新下载已开始');
            } else {
                showToast('启动下载失败: ' + (response.msg || '未知错误'), 3000);
            }
        });
    });
}
// ========== RK628配置页面功能 ==========
// RK628配置数据缓存
let rk628ConfigData = {
    src_mode: {},
    dst_mode: {},
    edid: ''
};
const DRM_MODE_FLAG_PHSYNC = 0x01;
const DRM_MODE_FLAG_NHSYNC = 0x02;
const DRM_MODE_FLAG_PVSYNC = 0x04;
const DRM_MODE_FLAG_NVSYNC = 0x08;

function rk628BuildSyncFlags(hPositive, vPositive) {
    return (hPositive ? DRM_MODE_FLAG_PHSYNC : DRM_MODE_FLAG_NHSYNC)
        | (vPositive ? DRM_MODE_FLAG_PVSYNC : DRM_MODE_FLAG_NVSYNC);
}

function rk628IsHSyncPositive(flags) {
    return (Number(flags) & DRM_MODE_FLAG_PHSYNC) !== 0;
}

function rk628IsVSyncPositive(flags) {
    return (Number(flags) & DRM_MODE_FLAG_PVSYNC) !== 0;
}

/**
 * 发送RK628配置命令（Promise封装）
 */
function sendRK628Command(action, data = null) {
    return new Promise((resolve, reject) => {
        const commandData = { action };
        if (data) {
            commandData.data = data;
        }
        sendMessage('panel', 'rk628Config', commandData, async (response) => {
            if (response.code !== 0) {
                reject(response);
                return;
            }
            const operationId = (response?.data?.accepted || response?.accepted)
                ? (response?.data?.operationId || response?.operationId)
                : '';
            if (!operationId) {
                resolve(response);
                return;
            }
            try {
                resolve(await waitForDeviceOperation(operationId, 45000));
            } catch (error) {
                reject(error);
            }
        });
    });
}

function sendRK628CommandWithTimeout(action, data = null, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const commandData = { action };
        if (data) {
            commandData.data = data;
        }
        sendMessageWithTimeout('panel', 'rk628Config', commandData, timeoutMs, async (response) => {
            if (response.code !== 0) {
                reject(response);
                return;
            }
            const operationId = (response?.data?.accepted || response?.accepted)
                ? (response?.data?.operationId || response?.operationId)
                : '';
            if (!operationId) {
                resolve(response);
                return;
            }
            try {
                resolve(await waitForDeviceOperation(operationId, timeoutMs));
            } catch (error) {
                reject(error);
            }
        });
    });
}

const STATUS_LED_KEYS = ['handshake', 'noSignal', 'fido2', 'bluetooth',
    'bluetoothSearch', 'ready', 'error'];
const STATUS_LED_DEFAULTS = {
    handshake: 4,
    noSignal: 2,
    fido2: 3,
    bluetooth: 0,
    bluetoothSearch: 7,
    ready: 0,
    error: 5,
};
let statusLedConfigState = { ...STATUS_LED_DEFAULTS };
let statusLedConfigInFlight = false;

function statusLedModeNormalize(value) {
    const mode = Number(value);
    return Number.isInteger(mode) && mode >= 0 && mode <= 8 ? mode : 0;
}

function statusLedConfigNormalize(data) {
    const config = data?.config || data?.led_config || data || {};
    return STATUS_LED_KEYS.reduce((result, key) => {
        result[key] = statusLedModeNormalize(config[key]);
        return result;
    }, {});
}

function statusLedConfigSetStatus(text, tone = '') {
    const status = document.getElementById('statusLedConfigStatus');
    if (!status) return;
    status.textContent = text;
    status.classList.toggle('is-ready', tone === 'ready');
    status.classList.toggle('is-busy', tone === 'busy');
}

function statusLedConfigRender() {
    document.querySelectorAll('.status-led-select').forEach((select) => {
        const key = select.dataset.ledState;
        if (!STATUS_LED_KEYS.includes(key)) return;
        select.value = String(statusLedConfigState[key]);
        select.disabled = statusLedConfigInFlight;

        const preview = document.querySelector(`[data-led-preview="${key}"]`);
        if (!preview) return;
        const mode = statusLedConfigState[key];
        preview.classList.remove('is-on', 'is-breath', 'is-flash', 'is-heartbeat');
        if (mode === 1) preview.classList.add('is-on');
        else if (mode === 2) preview.classList.add('is-breath');
        else if ([3, 4, 5, 6, 7].includes(mode)) preview.classList.add('is-flash');
        else if (mode === 8) preview.classList.add('is-heartbeat');
        preview.dataset.mode = String(mode);
    });
    const saveButton = document.getElementById('statusLedSaveButton');
    const resetButton = document.getElementById('statusLedResetButton');
    if (saveButton) saveButton.disabled = statusLedConfigInFlight;
    if (resetButton) resetButton.disabled = statusLedConfigInFlight;
}

async function statusLedConfigLoad(silent = false) {
    if (statusLedConfigInFlight) return;
    statusLedConfigInFlight = true;
    statusLedConfigSetStatus('读取中...', 'busy');
    statusLedConfigRender();
    try {
        const response = await sendRK628CommandWithTimeout(28, null, 5000);
        const data = response?.data || {};
        if (data.supported === false) {
            const error = new Error('当前下位机固件不支持状态指示灯配置');
            error.unsupported = true;
            throw error;
        }
        statusLedConfigState = statusLedConfigNormalize(data);
        statusLedConfigSetStatus('已同步', 'ready');
    } catch (error) {
        statusLedConfigSetStatus(error?.unsupported ? '固件不支持' : '读取失败');
        if (!silent) {
            showToast('读取指示灯设置失败: ' + rk628ExtractErrorMessage(error), 'error');
        }
    } finally {
        statusLedConfigInFlight = false;
        statusLedConfigRender();
    }
}

function statusLedConfigReadForm() {
    return STATUS_LED_KEYS.reduce((result, key) => {
        const select = document.querySelector(`.status-led-select[data-led-state="${key}"]`);
        result[key] = select
            ? statusLedModeNormalize(select.value)
            : statusLedConfigState[key];
        return result;
    }, {});
}

async function statusLedConfigSave(config = statusLedConfigReadForm()) {
    if (statusLedConfigInFlight) return false;
    const previous = statusLedConfigState;
    statusLedConfigState = { ...config };
    statusLedConfigInFlight = true;
    statusLedConfigSetStatus('保存中...', 'busy');
    statusLedConfigRender();
    try {
        await sendRK628CommandWithTimeout(29, { ...statusLedConfigState, persist: 1 }, 6000);
        statusLedConfigSetStatus('已保存', 'ready');
        showToast('指示灯设置已保存', 'success');
        return true;
    } catch (error) {
        statusLedConfigState = previous;
        statusLedConfigSetStatus('保存失败');
        showToast('保存指示灯设置失败: ' + rk628ExtractErrorMessage(error), 'error');
        return false;
    } finally {
        statusLedConfigInFlight = false;
        statusLedConfigRender();
    }
}

function initStatusLedSetting() {
    const selects = document.querySelectorAll('.status-led-select');
    if (!selects.length || selects[0].dataset.bound === '1') return;
    selects.forEach((select) => {
        select.addEventListener('change', () => {
            const key = select.dataset.ledState;
            statusLedConfigState[key] = statusLedModeNormalize(select.value);
            statusLedConfigRender();
        });
        select.dataset.bound = '1';
    });
    document.getElementById('statusLedSaveButton')?.addEventListener('click', () => {
        statusLedConfigSave();
    });
    document.getElementById('statusLedResetButton')?.addEventListener('click', () => {
        statusLedConfigState = { ...STATUS_LED_DEFAULTS };
        statusLedConfigRender();
        statusLedConfigSave();
    });
    statusLedConfigRender();
}

const RK628_SCALE_MODE_FULLSCREEN = 0;
const RK628_SCALE_MODE_ASPECT_FIT = 1;
let rk628ScaleModeState = {
    mode: RK628_SCALE_MODE_FULLSCREEN,
    inFlight: false,
    applySeq: null,
    aspectSupported: true,
    aspectError: '',
};

function rk628ScaleModeNormalize(value) {
    return Number(value) === RK628_SCALE_MODE_FULLSCREEN
        ? RK628_SCALE_MODE_FULLSCREEN
        : RK628_SCALE_MODE_ASPECT_FIT;
}

function rk628ScaleModeRender() {
    const select = document.getElementById('displayScaleModeSelect');
    if (!select) return;
    const aspectOption = select.querySelector(`option[value="${RK628_SCALE_MODE_ASPECT_FIT}"]`);
    if (aspectOption) {
        aspectOption.textContent = rk628ScaleModeState.aspectSupported
            ? '等比缩放'
            : '等比缩放（不支持）';
    }
    select.value = String(rk628ScaleModeState.mode);
    select.disabled = rk628ScaleModeState.inFlight;
}

function rk628ScaleModeReadState(data) {
    const rawMode = data?.scale_mode;
    if (!Number.isFinite(Number(rawMode)) ||
        ![RK628_SCALE_MODE_FULLSCREEN, RK628_SCALE_MODE_ASPECT_FIT].includes(Number(rawMode))) {
        const error = new Error('当前下位机固件不支持显示缩放设置');
        error.unsupported = true;
        throw error;
    }

    const hasApplyStatus = ['scale_apply_seq', 'scale_applied_mode',
        'scale_apply_result', 'scale_persist_result', 'scale_reapply_result']
        .every(key => Object.prototype.hasOwnProperty.call(data || {}, key));
    const rawSeq = Number(data?.scale_apply_seq);
    return {
        mode: Number(rawMode),
        hasApplyStatus,
        applySeq: hasApplyStatus && Number.isFinite(rawSeq) ? rawSeq : null,
        appliedMode: hasApplyStatus ? Number(data.scale_applied_mode) : null,
        applyResult: hasApplyStatus ? Number(data.scale_apply_result) : null,
        persistResult: hasApplyStatus ? Number(data.scale_persist_result) : null,
        reapplyResult: hasApplyStatus ? Number(data.scale_reapply_result) : null,
        aspectSupported: data?.scale_aspect_supported !== false &&
            Number(data?.scale_aspect_supported) !== 0,
        aspectError: typeof data?.scale_aspect_error === 'string'
            ? data.scale_aspect_error
            : '',
    };
}

async function rk628ScaleModeWaitForApply(targetMode, previousSeq) {
    for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 150));
        const result = await sendRK628CommandWithTimeout(10, null, 5000);
        const state = rk628ScaleModeReadState(result?.data);
        rk628ScaleModeState.applySeq = state.applySeq;

        const completed = state.mode === targetMode && (
            state.hasApplyStatus
                ? state.applySeq !== null && state.applySeq !== previousSeq &&
                    state.appliedMode === targetMode
                : true
        );
        if (!completed) continue;
        if (state.applyResult !== 0) {
            throw new Error(`下位机应用缩放参数失败 (${state.applyResult})`);
        }
        if (state.persistResult !== 0) {
            throw new Error(`缩放参数已应用但持久化失败 (${state.persistResult})`);
        }
        if (state.reapplyResult !== 0) {
            throw new Error(`缩放参数已保存但显示重配置失败 (${state.reapplyResult})`);
        }
        return state.hasApplyStatus;
    }
    throw new Error('下位机未在超时时间内确认缩放设置');
}

async function rk628ScaleModeLoad(silent = false) {
    if (rk628ScaleModeState.inFlight) return;
    rk628ScaleModeState.inFlight = true;
    rk628ScaleModeRender();
    try {
        const result = await sendRK628CommandWithTimeout(10, null, 5000);
        const state = rk628ScaleModeReadState(result?.data);
        rk628ScaleModeState.mode = state.mode;
        rk628ScaleModeState.applySeq = state.applySeq;
        rk628ScaleModeState.aspectSupported = state.aspectSupported;
        rk628ScaleModeState.aspectError = state.aspectError;
    } catch (error) {
        if (error?.unsupported) {
            showToast(rk628ExtractErrorMessage(error), 'error');
        } else if (!silent) {
            showToast('读取缩放规则失败: ' + rk628ExtractErrorMessage(error), 'error');
        }
    } finally {
        rk628ScaleModeState.inFlight = false;
        rk628ScaleModeRender();
    }
}

async function rk628ScaleModeSave(mode) {
    if (rk628ScaleModeState.inFlight) return;
    const previousMode = rk628ScaleModeState.mode;
    rk628ScaleModeState.mode = rk628ScaleModeNormalize(mode);
    rk628ScaleModeState.inFlight = true;
    rk628ScaleModeRender();
    try {
        // The device sequence restarts at zero after reboot. Always establish
        // a fresh baseline so an old UI cache cannot collide with the new seq.
        const baselineResult = await sendRK628CommandWithTimeout(10, null, 5000);
        const baseline = rk628ScaleModeReadState(baselineResult?.data);
        const previousSeq = baseline.applySeq;
        rk628ScaleModeState.applySeq = baseline.applySeq;
        rk628ScaleModeState.aspectSupported = baseline.aspectSupported;
        rk628ScaleModeState.aspectError = baseline.aspectError;
        await sendRK628CommandWithTimeout(24, {
            name: 'scale_mode',
            value: rk628ScaleModeState.mode,
            persist: 1,
            restart: 0,
        }, 6000);
        const fullyConfirmed = await rk628ScaleModeWaitForApply(
            rk628ScaleModeState.mode, previousSeq);
        if (fullyConfirmed) {
            showToast(rk628ScaleModeState.mode === RK628_SCALE_MODE_FULLSCREEN
                ? '已切换为全屏拉伸'
                : '已切换为等比缩放', 'success');
        } else {
            showToast('已回读到目标缩放值，但当前固件无法确认持久化和显示重配置结果', 'warning');
        }
    } catch (error) {
        rk628ScaleModeState.mode = previousMode;
        showToast(rk628ExtractErrorMessage(error), 'error');
    } finally {
        rk628ScaleModeState.inFlight = false;
        rk628ScaleModeRender();
    }
}

function initRk628ScaleModeSetting() {
    const select = document.getElementById('displayScaleModeSelect');
    if (!select || select.dataset.bound === '1') return;
    select.dataset.bound = '1';
    rk628ScaleModeRender();
    select.addEventListener('change', (event) => {
        rk628ScaleModeSave(event.target.value);
    });
}

function rk628ExtractErrorMessage(err) {
    if (!err) return 'error';
    if (typeof err === 'string') return err.replace(/<[^>]+>/g, ' ');
    if (err.msg) return String(err.msg).replace(/<[^>]+>/g, ' ');
    if (err.message) return String(err.message).replace(/<[^>]+>/g, ' ');
    try {
        return JSON.stringify(err).replace(/<[^>]+>/g, ' ');
    } catch {
        return 'error';
    }
}

function rk628GetTabButton(tabName) {
    const container = document.getElementById('page-rk628-config');
    if (!container) return null;
    return container.querySelector(`.input-tab-button[data-rk628-tab="${tabName}"]`);
}
/**
 * 切换RK628标签页
 */
let rk628ActiveTab = 'edid';

function switchRK628Tab(tabName, sourceButton = null) {
    const container = document.getElementById('page-rk628-config');
    if (!container) return false;

    const quickTab = tabName === 'edid-tuning';
    const contentId = quickTab ? 'tab-edid-quick' : ('tab-' + tabName);
    const content = document.getElementById(contentId);
    const triggerButton = sourceButton?.matches?.('[data-rk628-tab]')
        ? sourceButton
        : rk628GetTabButton(tabName);
    if (!triggerButton || !content || !container.contains(content)) {
        console.warn('[RK628] 无效的标签页:', tabName);
        return false;
    }

    container.querySelectorAll('.rk628-config-tabsbar [data-rk628-tab]').forEach(tab => {
        tab.classList.remove('active');
        tab.setAttribute('aria-selected', 'false');
    });
    triggerButton.classList.add('active');
    triggerButton.setAttribute('aria-selected', 'true');

    Array.from(container.children).forEach(child => {
        if (child.classList.contains('input-tab-content')) child.classList.remove('active');
    });
    content.classList.add('active');
    rk628ActiveTab = tabName;

    // 快速切换页改为事件驱动：不轮询下位机状态
    if (quickTab) {
        try { switchRK628QuickView('tuning'); } catch (e) { /* ignore */ }
        try { rk628QuickPpLoad(); } catch (e) { /* ignore */ }
        try { rk628QuickPowerLoad(); } catch (e) { /* ignore */ }
    }

    // 实时配置：切换到页面时自动从下位机读取寄存器对应参数
    if (tabName === 'dst-live') {
        try { rk628RtOnOpen(); } catch (e) { /* ignore */ }
    }

	// 初始化序列：若本地为空则自动读取下位机；应用后缓存到 localStorage
	if (tabName === 'init-seq') {
		try { rk628InitSeqOnOpen(); } catch (e) { /* ignore */ }
	}
    return true;
}

function ensureRK628TabState() {
    const container = document.getElementById('page-rk628-config');
    if (!container) return;
    const selected = container.querySelector('.rk628-config-tabsbar [data-rk628-tab][aria-selected="true"]')
        || container.querySelector('.rk628-config-tabsbar [data-rk628-tab].active');
    const tabName = rk628GetTabButton(rk628ActiveTab)
        ? rk628ActiveTab
        : (selected?.dataset.rk628Tab || 'edid');
    if (!switchRK628Tab(tabName)) switchRK628Tab('edid');
}

function switchRK628QuickView(tabName) {
    const container = document.getElementById('tab-edid-quick');
    if (!container) return;
    container.querySelectorAll('.rk628-quick-subcontent').forEach((content) => {
        content.classList.remove('active');
    });

    const content = document.getElementById(`rk628-quick-view-${tabName}`);
    if (content) content.classList.add('active');
}
/**
 * 加载RK628配置
 */
async function loadRK628Config() {
    try {
        const result = await sendRK628CommandWithTimeout(1, null, 12000); // action=1: 获取所有配置
        rk628ConfigData = result.data;

        // 使用 Flash dst_mode 作为“屏幕输出(实时配置)”面板的初始值
        const dst = result.data.dst_mode;
        try {
            if (document.getElementById('rt-hsync-len')) {
                // Use flash dst_mode as an initial value; the user can still "从下位机读取" for runtime state.
                rk628RtApplyModeToUi(dst, false);
            }
        } catch (e) {
            // ignore (avoid breaking the whole page if some elements are missing)
        }

        // 填充EDID
        document.getElementById('edid-hex').value = formatEdidHex(result.data.edid);
        updateEdidCharCount();

        showToast('配置加载成功', 'success');
    } catch (error) {
        console.error('Load RK628 config error:', error);
        showToast('配置加载失败: ' + rk628ExtractErrorMessage(error), 'error');
    }
}
function formatEdidHex(hexString) {
    const cleanHex = String(hexString || '').replace(/\s/g, '').toUpperCase();
    if (!cleanHex) return '';
    const bytes = cleanHex.match(/.{1,2}/g) || [];
    const lines = [];
    for (let i = 0; i < bytes.length; i += 16) {
        lines.push(bytes.slice(i, i + 16).join(' '));
    }
    return lines.join('\n');
}

function parseEdidHex(hexText) {
    const source = String(hexText || '');
    const compact = source.replace(/\s/g, '');
    const byteCount = Math.floor(compact.length / 2);
    const result = {
        valid: false,
        byteCount,
        cleanHex: compact.toLowerCase(),
        bytes: null,
        error: '未加载',
        baseValid: false,
        extensionValid: false,
    };

    if (!compact) return result;
    if (/[^0-9a-fA-F]/.test(compact)) {
        result.error = '包含非十六进制字符';
        return result;
    }
    if (compact.length !== 512) {
        result.error = `长度错误: ${byteCount}/256 字节`;
        return result;
    }

    const bytes = new Uint8Array(256);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(compact.slice(i * 2, i * 2 + 2), 16);
    }
    result.bytes = bytes;

    const header = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];
    if (!header.every((value, index) => bytes[index] === value)) {
        result.error = 'EDID Header 无效';
        return result;
    }
    if (bytes[0x7E] !== 1) {
        result.error = '扩展块数量必须为 1';
        return result;
    }

    const blockValid = (offset) => {
        let sum = 0;
        for (let i = offset; i < offset + 128; i++) sum = (sum + bytes[i]) & 0xFF;
        return sum === 0;
    };
    result.baseValid = blockValid(0);
    result.extensionValid = blockValid(128);
    if (!result.baseValid || !result.extensionValid) {
        result.error = !result.baseValid ? 'Base Checksum 无效' : 'Extension Checksum 无效';
        return result;
    }

    result.valid = true;
    result.error = '';
    return result;
}

function updateEdidStatus(result) {
    const byteCountElem = document.getElementById('edid-byte-count');
    const statusElem = document.getElementById('edid-status');
    const baseCheck = document.getElementById('edid-base-check');
    const extensionCheck = document.getElementById('edid-extension-check');
    const saveButton = document.getElementById('edid-save-button');

    if (byteCountElem) {
        byteCountElem.textContent = result.byteCount;
    }

    if (statusElem) {
        statusElem.classList.remove('valid', 'error');
        const statusText = statusElem.querySelector('span:last-child');
        if (result.valid) {
            statusElem.classList.add('valid');
            if (statusText) statusText.textContent = 'EDID 有效';
        } else if (result.byteCount === 0) {
            if (statusText) statusText.textContent = '未加载';
        } else {
            statusElem.classList.add('error');
            if (statusText) statusText.textContent = result.error;
        }
    }

    const setBlockState = (element, label, valid) => {
        if (!element) return;
        element.classList.toggle('valid', valid);
        element.classList.toggle('error', !!result.bytes && !valid);
        element.textContent = `${label} ${valid ? 'OK' : '--'}`;
    };
    setBlockState(baseCheck, 'Base', result.baseValid);
    setBlockState(extensionCheck, 'Extension', result.extensionValid);
    if (saveButton) saveButton.disabled = !result.valid;
}

/**
 * 从文件加载EDID
 */
function loadEdidFromFile(input) {
    const file = input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
        const arrayBuffer = e.target.result;
        const bytes = new Uint8Array(arrayBuffer);
        input.value = '';

        if (bytes.length !== 256) {
            showToast(`EDID 文件必须为 256 字节，当前为 ${bytes.length} 字节`, 'error');
            return;
        }

        // 转换为十六进制字符串
        let hexString = '';
        for (let i = 0; i < bytes.length; i++) {
            hexString += bytes[i].toString(16).padStart(2, '0');
        }

        // 更新隐藏的textarea
        document.getElementById('edid-hex').value = formatEdidHex(hexString);
        updateEdidCharCount();

        showToast(`已加载 EDID 文件: ${file.name} (${bytes.length} 字节)`, 'success');
    };

    reader.onerror = function () {
        showToast('读取文件失败', 'error');
    };

    reader.readAsArrayBuffer(file);
}

/**
 * 下载EDID文件
 */
function downloadEdidFile() {
    const result = parseEdidHex(document.getElementById('edid-hex').value);
    if (!result.valid) {
        showToast('无法导出: ' + result.error, 'error');
        return;
    }

    // 创建Blob
    const blob = new Blob([result.bytes], { type: 'application/octet-stream' });

    // 创建下载链接
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'edid.bin';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast('已导出 EDID 文件 (256 字节)', 'success');
}

/**
 * 复制EDID Hex
 */
async function copyEdidHex() {
    const edidInput = document.getElementById('edid-hex');
    if (!edidInput) return;

    const result = parseEdidHex(edidInput.value);
    if (!result.cleanHex) {
        showToast('没有可复制的EDID数据', 'error');
        return;
    }

    if (!navigator.clipboard || !navigator.clipboard.writeText) {
        showToast('浏览器不支持剪贴板复制', 'error');
        return;
    }

    try {
        await navigator.clipboard.writeText(formatEdidHex(result.cleanHex));
        showToast('已复制EDID HEX', 'success');
    } catch (error) {
        console.error('Copy EDID Hex error:', error);
        showToast('复制失败，请检查浏览器权限', 'error');
    }
}

/**
 * 粘贴EDID Hex
 */
async function pasteEdidHex() {
    const edidInput = document.getElementById('edid-hex');
    if (!edidInput) return;

    if (!navigator.clipboard || !navigator.clipboard.readText) {
        showToast('浏览器不支持剪贴板粘贴', 'error');
        return;
    }

    try {
        const text = await navigator.clipboard.readText();
        if (!text) {
            showToast('剪贴板为空', 'error');
            return;
        }

        const result = parseEdidHex(text);
        edidInput.value = result.valid ? formatEdidHex(result.cleanHex) : text;
        updateEdidCharCount();
        showToast(result.valid ? '已粘贴有效 EDID' : '已粘贴，请修正: ' + result.error,
            result.valid ? 'success' : 'warning');
    } catch (error) {
        console.error('Paste EDID Hex error:', error);
        showToast('粘贴失败，请检查浏览器权限', 'error');
    }
}

/**
 * 清空EDID Hex
 */
function clearEdidHex() {
    const edidInput = document.getElementById('edid-hex');
    if (!edidInput) return;

    edidInput.value = '';
    updateEdidCharCount();
    showToast('已清空EDID数据', 'success');
}

/**
 * 更新EDID字符计数（兼容旧代码）
 */
function updateEdidCharCount() {
    const edidHex = document.getElementById('edid-hex')?.value || '';
    renderEdidHexDecorations(edidHex);
    updateEdidStatus(parseEdidHex(edidHex));
}

function renderEdidHexDecorations(hexText) {
    const offsets = document.getElementById('edid-offsets');
    const ascii = document.getElementById('edid-ascii');
    if (!offsets || !ascii) return;

    const compact = String(hexText || '').replace(/\s/g, '');
    const offsetLines = [];
    const asciiLines = [];
    for (let row = 0; row < 16; row++) {
        offsetLines.push(`0x${(row * 16).toString(16).toUpperCase().padStart(4, '0')}`);
        let text = '';
        for (let column = 0; column < 16; column++) {
            const byteIndex = row * 16 + column;
            const pair = compact.slice(byteIndex * 2, byteIndex * 2 + 2);
            const value = /^[0-9a-fA-F]{2}$/.test(pair) ? parseInt(pair, 16) : -1;
            text += value >= 0x20 && value <= 0x7E ? String.fromCharCode(value) : '.';
        }
        asciiLines.push(text);
    }
    offsets.textContent = offsetLines.join('\n');
    ascii.textContent = asciiLines.join('\n');
    syncEdidEditorScroll();
}

function syncEdidEditorScroll() {
    const input = document.getElementById('edid-hex');
    const offsets = document.getElementById('edid-offsets');
    const ascii = document.getElementById('edid-ascii');
    if (!input || !offsets || !ascii) return;
    offsets.scrollTop = input.scrollTop;
    ascii.scrollTop = input.scrollTop;
}

// 页面加载时初始化EDID编辑器
document.addEventListener('DOMContentLoaded', function () {
    const edidInput = document.getElementById('edid-hex');
    if (edidInput) {
        edidInput.addEventListener('scroll', syncEdidEditorScroll, { passive: true });
        updateEdidCharCount();
    }
});
// 当打开RK628配置页面时自动加载配置
const originalOpenPage = window.openPage;
const originalClosePage = window.closePage;
/**
 * 保存并应用EDID配置
 */
function applyEdidConfig() {
    const result = parseEdidHex(document.getElementById('edid-hex')?.value || '');
    if (!result.valid) {
        showToast('无法写入: ' + result.error, 'error');
        return;
    }

    confirmModal('写入后将重新加载 RK628，显示会短暂中断。确定继续吗？', async () => {
        const saveButton = document.getElementById('edid-save-button');
        if (saveButton) saveButton.disabled = true;
        try {
            showToast('正在写入 EDID...', 'info');
            await sendRK628CommandWithTimeout(4, { edid: result.cleanHex }, 6000);
            await sendRK628CommandWithTimeout(7, {
                power_cycle: 1,
                poweroff_ms: 200,
                reset_ms: 10,
                settle_ms: 50,
            }, 10000);
            showToast('EDID 写入和重载请求已提交', 'success');
        } catch (error) {
            console.error('Apply EDID config error:', error);
            showToast('写入 EDID 失败: ' + rk628ExtractErrorMessage(error), 'error');
        } finally {
            updateEdidCharCount();
        }
    }, '写入 EDID');
}
// ========== RK628 状态与高级调试 ==========
const rk628QuickRestartDefaults = {
    poweroff: 200,
    reset: 10,
    settle: 50,
};

function rk628QuickSetStatus(text, level = '') {
    const el = document.getElementById('rk628-quick-status');
    if (!el) return;
    el.classList.remove('valid', 'error');
    if (level === 'valid') el.classList.add('valid');
    if (level === 'error') el.classList.add('error');
    const span = el.querySelector('span:last-child');
    if (span) span.textContent = text;
}

function rk628QuickSetInputText(text) {
    const el = document.getElementById('rk628-quick-input');
    if (el) el.textContent = text;
}

async function loadRK628Status() {
    try {
        const result = await sendRK628CommandWithTimeout(8, null, 3000);
        const data = result?.data || {};
        const width = Number(data.hdisplay) || 0;
        const height = Number(data.vdisplay) || 0;
        const clock = Number(data.clock) || 0;
        rk628QuickSetInputText(width && height ? `${width}x${height}  ${clock}kHz` : '-');
        if (data.restarting) {
            rk628QuickSetStatus('重载中', '');
        } else if (data.hdmirx_lock) {
            rk628QuickSetStatus('已锁定', 'valid');
        } else if (data.hdmirx_plugin) {
            rk628QuickSetStatus('已连接', '');
        } else {
            rk628QuickSetStatus('无输入', '');
        }
    } catch {
        rk628QuickSetStatus('状态不可用', 'error');
        rk628QuickSetInputText('-');
    }
}

function rk628QuickPpSetDebug(text) {
    const el = document.getElementById('rk628-pp-debug');
    if (el) el.value = String(text || '');
}

function rk628QuickPpSetCheckbox(id, checked) {
    const el = document.getElementById(id);
    if (el) el.checked = !!checked;
}

function rk628QuickPpGetCheckbox(id, def = false) {
    const el = document.getElementById(id);
    return el ? !!el.checked : !!def;
}

function rk628QuickPpGetNumber(id, def = 0) {
    const el = document.getElementById(id);
    const v = parseInt(el?.value ?? '');
    return Number.isFinite(v) ? v : def;
}

let rk628QuickPowerState = {
    supported: false,
    enabled: false,
    loaded: false,
    inFlight: false,
};

function rk628QuickPowerDesiredMode() {
    return !!document.getElementById('rk628-power-mcu')?.checked;
}

function rk628QuickPowerSelect(enabled) {
    const screen = document.getElementById('rk628-power-screen');
    const mcu = document.getElementById('rk628-power-mcu');
    if (screen) screen.checked = !enabled;
    if (mcu) mcu.checked = !!enabled;
}

function rk628QuickPowerRender() {
    const section = document.getElementById('rk628-power-section');
    const status = document.getElementById('rk628-power-status');
    const screen = document.getElementById('rk628-power-screen');
    const mcu = document.getElementById('rk628-power-mcu');
    const disabled = !rk628QuickPowerState.supported || rk628QuickPowerState.inFlight;

    if (screen) screen.disabled = disabled;
    if (mcu) mcu.disabled = disabled;
    if (section) section.classList.toggle('is-enabled', rk628QuickPowerState.enabled);
    if (status) {
        if (rk628QuickPowerState.inFlight) status.textContent = '切换中';
        else if (!rk628QuickPowerState.loaded) status.textContent = '读取中';
        else if (!rk628QuickPowerState.supported) status.textContent = '当前固件不支持';
        else status.textContent = rk628QuickPowerState.enabled ? '兜底已启用' : '默认模式';
    }
}

async function rk628QuickPowerLoad(silent = false) {
    rk628QuickPowerState.inFlight = true;
    rk628QuickPowerRender();
    try {
        const res = await sendRK628CommandWithTimeout(17, null, 5000);
        const data = res?.data || {};
        const hasCapability = Object.prototype.hasOwnProperty.call(data, 'mcu_power_fallback_supported');
        rk628QuickPowerState.supported = hasCapability && Number(data.mcu_power_fallback_supported) === 1;
        rk628QuickPowerState.enabled = rk628QuickPowerState.supported && Number(data.mcu_power_fallback) === 1;
        rk628QuickPowerState.loaded = true;
        rk628QuickPowerSelect(rk628QuickPowerState.enabled);
    } catch (error) {
        rk628QuickPowerState.supported = false;
        rk628QuickPowerState.enabled = false;
        rk628QuickPowerState.loaded = true;
        rk628QuickPowerSelect(false);
        if (!silent) showToast('读取屏幕供电模式失败: ' + rk628ExtractErrorMessage(error), 'error');
    } finally {
        rk628QuickPowerState.inFlight = false;
        rk628QuickPowerRender();
    }
}

async function rk628QuickPowerWaitForMode(expected) {
    for (let attempt = 0; attempt < 8; attempt++) {
        await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 900 : 350));
        try {
            const res = await sendRK628CommandWithTimeout(17, null, 5000);
            const data = res?.data || {};
            if (Number(data.mcu_power_fallback_supported) !== 1) continue;
            const enabled = Number(data.mcu_power_fallback) === 1;
            if (enabled === expected) return;
        } catch {
            // The panel-only restart may briefly delay device responses.
        }
    }
    throw new Error('下位机未确认新的供电模式');
}

async function rk628QuickPowerApply(enabled) {
    rk628QuickPowerState.inFlight = true;
    rk628QuickPowerRender();
    try {
        await sendRK628CommandWithTimeout(18, {
            mcu_power_fallback: enabled ? 1 : 0,
            persist: 1,
            restart: 1,
            power_cycle: 0,
            reset_ms: 10,
            settle_ms: 50,
        }, 7000);
        await rk628QuickPowerWaitForMode(!!enabled);
        rk628QuickPowerState.enabled = !!enabled;
        rk628QuickPowerSelect(!!enabled);
        showToast(enabled ? 'MCU 供电兜底已启用' : '已恢复屏幕控制供电', 'success');
    } catch (error) {
        rk628QuickPowerSelect(rk628QuickPowerState.enabled);
        showToast('切换屏幕供电模式失败: ' + rk628ExtractErrorMessage(error), 'error');
    } finally {
        rk628QuickPowerState.inFlight = false;
        rk628QuickPowerRender();
    }
}

function rk628QuickPowerConfirmEnable() {
    showModal('启用 MCU 供电兜底', `
        <div class="rk628-power-confirm">
            <div class="rk628-power-confirm-warning">
                此模式仅用于 S6E3FA3 屏幕无法正常点亮时的调试兜底。启用后 MCU 将直接驱动供电 IC，屏幕亮度将无法正确调节。
            </div>
            <div class="rk628-power-confirm-checks">
                <label class="flag-checkbox"><input type="checkbox" id="rk628-power-confirm-resistors"><span>我已确认 R46、R39 均未贴装</span></label>
                <label class="flag-checkbox"><input type="checkbox" id="rk628-power-confirm-brightness"><span>我已知悉启用后亮度无法正确调节</span></label>
            </div>
        </div>
    `, () => {
        const resistors = document.getElementById('rk628-power-confirm-resistors');
        const brightness = document.getElementById('rk628-power-confirm-brightness');
        if (!resistors?.checked || !brightness?.checked) return false;
        rk628QuickPowerApply(true);
        return true;
    }, 'md');

    const confirm = document.getElementById('modalConfirm');
    const updateConfirm = () => {
        const resistors = document.getElementById('rk628-power-confirm-resistors');
        const brightness = document.getElementById('rk628-power-confirm-brightness');
        if (confirm) {
            confirm.disabled = !resistors?.checked || !brightness?.checked;
            confirm.style.opacity = confirm.disabled ? '0.45' : '1';
            confirm.style.cursor = confirm.disabled ? 'not-allowed' : 'pointer';
        }
    };
    if (confirm) confirm.textContent = '确认启用并重启显示';
    document.getElementById('rk628-power-confirm-resistors')?.addEventListener('change', updateConfirm);
    document.getElementById('rk628-power-confirm-brightness')?.addEventListener('change', updateConfirm);
    updateConfirm();
}

function rk628QuickPowerConfirmScreenControl() {
    showModal('切换为屏幕控制', `
        <div class="rk628-power-confirm">
            <div class="rk628-power-confirm-warning">
                将关闭 MCU 供电兜底，PA0 和 PA1 恢复高阻态，并重启显示输出。
            </div>
        </div>
    `, () => {
        rk628QuickPowerApply(false);
        return true;
    }, 'sm');
    const confirm = document.getElementById('modalConfirm');
    if (confirm) confirm.textContent = '确认切换并重启显示';
}

function rk628QuickPowerModeChanged() {
    if (!rk628QuickPowerState.supported || rk628QuickPowerState.inFlight) return;
    const desired = rk628QuickPowerDesiredMode();
    if (desired === rk628QuickPowerState.enabled) return;
    rk628QuickPowerSelect(rk628QuickPowerState.enabled);
    rk628QuickPowerRender();
    if (desired) rk628QuickPowerConfirmEnable();
    else rk628QuickPowerConfirmScreenControl();
}

function rk628QuickPpApplyUiState(t) {
    if (!t || typeof t !== 'object') return;
    rk628QuickPpSetCheckbox('rk628-pp-cap-psync', !!t.cap_psync);
    rk628QuickPpSetCheckbox('rk628-pp-cap-async', !!t.cap_async);
    rk628QuickPpSetCheckbox('rk628-pp-progress', !!t.progress);

    rk628QuickPpSetCheckbox('rk628-pp-keep-aspect', !!t.keep_aspect);
    rk628QuickPpSetCheckbox('rk628-pp-dst-clock-follow', !!t.dst_clock_follow);

    rk628QuickPpSetCheckbox('rk628-pp-force-hpol', !!t.force_hsync_pol);
    rk628QuickPpSetCheckbox('rk628-pp-hpol', !!t.hsync_pol);
    rk628QuickPpSetCheckbox('rk628-pp-force-vpol', !!t.force_vsync_pol);
    rk628QuickPpSetCheckbox('rk628-pp-vpol', !!t.vsync_pol);

    const fixed = !!t.dsp_frame_fixed;
    const rFixed = document.getElementById('rk628-pp-dsp-fixed');
    const rAuto = document.getElementById('rk628-pp-dsp-auto');
    if (rFixed && rAuto) {
        rFixed.checked = fixed;
        rAuto.checked = !fixed;
    }
    const hstEl = document.getElementById('rk628-pp-dsp-hst');
    const vstEl = document.getElementById('rk628-pp-dsp-vst');
    if (hstEl) hstEl.value = String(t.dsp_frame_hst ?? 0);
    if (vstEl) vstEl.value = String(t.dsp_frame_vst ?? 4);
}

async function rk628QuickPpLoad() {
    try {
        rk628QuickPpSetDebug('读取中...');
        const res = await sendRK628CommandWithTimeout(10, null, 2500);
        const t = res?.data || {};
        rk628QuickPpApplyUiState(t);
        rk628QuickPpSetDebug(JSON.stringify({ tune: t }, null, 2));
        showToast('已读取当前抓取参数', 'success');
    } catch (e) {
        rk628QuickPpSetDebug('读取失败: ' + rk628ExtractErrorMessage(e));
        showToast('读取失败: ' + rk628ExtractErrorMessage(e), 'error');
    }
}

function rk628QuickPpCollectFromUi() {
    const fixed = rk628QuickPpGetCheckbox('rk628-pp-dsp-fixed', true);
    return {
        cap_psync: rk628QuickPpGetCheckbox('rk628-pp-cap-psync') ? 1 : 0,
        cap_async: rk628QuickPpGetCheckbox('rk628-pp-cap-async', true) ? 1 : 0,
        progress: rk628QuickPpGetCheckbox('rk628-pp-progress', true) ? 1 : 0,

        keep_aspect: rk628QuickPpGetCheckbox('rk628-pp-keep-aspect', false) ? 1 : 0,
        dst_clock_follow: rk628QuickPpGetCheckbox('rk628-pp-dst-clock-follow', false) ? 1 : 0,

        force_hsync_pol: rk628QuickPpGetCheckbox('rk628-pp-force-hpol', true) ? 1 : 0,
        hsync_pol: rk628QuickPpGetCheckbox('rk628-pp-hpol', true) ? 1 : 0,
        force_vsync_pol: rk628QuickPpGetCheckbox('rk628-pp-force-vpol', true) ? 1 : 0,
        vsync_pol: rk628QuickPpGetCheckbox('rk628-pp-vpol', true) ? 1 : 0,

        dsp_frame_fixed: fixed ? 1 : 0,
        dsp_frame_hst: rk628QuickPpGetNumber('rk628-pp-dsp-hst', 0),
        dsp_frame_vst: rk628QuickPpGetNumber('rk628-pp-dsp-vst', 4),

        // default: keep legacy auto-frame behavior unless firmware overrides
        dsp_frame_legacy: 1,
    };
}

async function rk628QuickPpApply() {
    try {
        const powerCycle = rk628QuickPpGetCheckbox('rk628-pp-power-cycle', false) ? 1 : 0;

        const data = rk628QuickPpCollectFromUi();
        data.restart = 1;
        data.power_cycle = powerCycle;
        data.poweroff_ms = rk628QuickRestartDefaults.poweroff;
        data.reset_ms = rk628QuickRestartDefaults.reset;
        data.settle_ms = rk628QuickRestartDefaults.settle;

        rk628QuickPpSetDebug('下发中...');
        await sendRK628CommandWithTimeout(9, data, 4000);
        rk628QuickSetStatus('已下发调参，等待重启...', '');
        showToast('已应用抓取参数（已触发软重启）', 'success');

        setTimeout(() => {
            rk628QuickPpLoad();
        }, 1200);
    } catch (e) {
        rk628QuickPpSetDebug('应用失败: ' + rk628ExtractErrorMessage(e));
        rk628QuickSetStatus('调参失败', 'error');
        showToast('应用失败: ' + rk628ExtractErrorMessage(e), 'error');
    }
}

async function rk628QuickPpBaseline() {
    rk628QuickPpSetCheckbox('rk628-pp-cap-psync', false);
    rk628QuickPpSetCheckbox('rk628-pp-cap-async', true);
    rk628QuickPpSetCheckbox('rk628-pp-progress', true);

    // 默认 scaler 配置：参考 D:\wifi_story_machine（不加黑边，拉伸全屏）
    rk628QuickPpSetCheckbox('rk628-pp-keep-aspect', false);

    // 默认输出时钟策略：参考 D:\wifi_story_machine（按比例跟随输入）
    rk628QuickPpSetCheckbox('rk628-pp-dst-clock-follow', true);
    rk628QuickPpSetCheckbox('rk628-pp-force-hpol', true);
    rk628QuickPpSetCheckbox('rk628-pp-hpol', true);
    rk628QuickPpSetCheckbox('rk628-pp-force-vpol', true);
    rk628QuickPpSetCheckbox('rk628-pp-vpol', true);

    // 默认 dsp_frame：自动计算（legacy x=5）
    rk628QuickPpSetCheckbox('rk628-pp-dsp-fixed', false);
    rk628QuickPpSetCheckbox('rk628-pp-dsp-auto', true);
    const hst = document.getElementById('rk628-pp-dsp-hst');
    const vst = document.getElementById('rk628-pp-dsp-vst');
    if (hst) hst.value = '0';
    if (vst) vst.value = '4';
    rk628QuickPpSetCheckbox('rk628-pp-power-cycle', false);
    await rk628QuickPpApply();
}

async function rk628QuickPpPreset(key) {
    switch (String(key || '')) {
        case 'psyncOnly':
            rk628QuickPpSetCheckbox('rk628-pp-cap-psync', true);
            rk628QuickPpSetCheckbox('rk628-pp-cap-async', false);
            rk628QuickPpSetCheckbox('rk628-pp-progress', true);
            // keep polarities as-is
            rk628QuickPpSetCheckbox('rk628-pp-dsp-fixed', true);
            {
                const hst = document.getElementById('rk628-pp-dsp-hst');
                const vst = document.getElementById('rk628-pp-dsp-vst');
                if (hst) hst.value = '0';
                if (vst) vst.value = '4';
            }
            rk628QuickPpSetCheckbox('rk628-pp-power-cycle', false);
            break;
        case 'autoFrame':
            // keep capture flags as-is, only switch frame strategy
            rk628QuickPpSetCheckbox('rk628-pp-dsp-fixed', false);
            rk628QuickPpSetCheckbox('rk628-pp-dsp-auto', true);
            break;
        case 'noForcePol':
            rk628QuickPpSetCheckbox('rk628-pp-force-hpol', false);
            rk628QuickPpSetCheckbox('rk628-pp-force-vpol', false);
            break;
        default:
            showToast('未知预设: ' + key, 'error');
            return;
    }
    await rk628QuickPpApply();
}

async function rk628QuickPpDumpRegs() {
    try {
        rk628QuickPpSetDebug('读取寄存器中...');
        const res = await sendRK628CommandWithTimeout(11, null, 2500);
        rk628QuickPpSetDebug(JSON.stringify({ regs: res?.data || {} }, null, 2));
        showToast('已读取寄存器快照', 'success');
    } catch (e) {
        rk628QuickPpSetDebug('读取失败: ' + rk628ExtractErrorMessage(e));
        showToast('读取失败: ' + rk628ExtractErrorMessage(e), 'error');
    }
}

// ========== RK628 实时配置（调试用，不写Flash） ==========

let rk628RtState = {
    inFlight: false,
    loadedOnce: false,
    lastLoadTs: 0,
    runtimeOverride: false,
};

function rk628RtGetNumber(id, def = 0) {
    const el = document.getElementById(id);
    const v = parseInt(el?.value ?? '');
    return Number.isFinite(v) ? v : def;
}

function rk628RtSetNumber(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = String(value ?? '');
}

function rk628RtUpdateFlags() {
    const hPositive = document.getElementById('rt-hsync-positive')?.checked;
    const vPositive = document.getElementById('rt-vsync-positive')?.checked;

    const out = document.getElementById('rt-flags');
    if (out) out.value = String(rk628BuildSyncFlags(!!hPositive, !!vPositive));
}

function initRtFlagsListeners() {
    const h = document.getElementById('rt-hsync-positive');
    const v = document.getElementById('rt-vsync-positive');
    if (h) h.addEventListener('change', rk628RtUpdateFlags);
    if (v) v.addEventListener('change', rk628RtUpdateFlags);
}

window.rk628RtUpdateTiming = function () {
    const hsyncLen = rk628RtGetNumber('rt-hsync-len', 0);
    const hback = rk628RtGetNumber('rt-hback', 0);
    const hdisplay = rk628RtGetNumber('rt-hdisplay', 0);
    const hfront = rk628RtGetNumber('rt-hfront', 0);

    const vsyncLen = rk628RtGetNumber('rt-vsync-len', 0);
    const vback = rk628RtGetNumber('rt-vback', 0);
    const vdisplay = rk628RtGetNumber('rt-vdisplay', 0);
    const vfront = rk628RtGetNumber('rt-vfront', 0);

    const htotal = hsyncLen + hback + hdisplay + hfront;
    const vtotal = vsyncLen + vback + vdisplay + vfront;

    const hEl = document.getElementById('rt-htotal-display');
    const vEl = document.getElementById('rt-vtotal-display');
    if (hEl) hEl.textContent = String(htotal || '-');
    if (vEl) vEl.textContent = String(vtotal || '-');

    rk628RtUpdateFlags();

};

function rk628RtApplyLaneRateToUi(laneRate) {
    const lane = Number(laneRate);
    rk628RtSetNumber('rt-lane-rate', Number.isFinite(lane) && lane >= 0 ? lane : 0);
}

function rk628RtApplyModeToUi(mode, runtimeOverride) {
    if (!mode || typeof mode !== 'object') return;

    const hsyncLen = (mode.hsync_end ?? 0) - (mode.hsync_start ?? 0);
    const hfront = (mode.hsync_start ?? 0) - (mode.hdisplay ?? 0);
    const hback = (mode.htotal ?? 0) - (mode.hsync_end ?? 0);

    const vsyncLen = (mode.vsync_end ?? 0) - (mode.vsync_start ?? 0);
    const vfront = (mode.vsync_start ?? 0) - (mode.vdisplay ?? 0);
    const vback = (mode.vtotal ?? 0) - (mode.vsync_end ?? 0);

    rk628RtSetNumber('rt-hsync-len', Math.max(0, hsyncLen));
    rk628RtSetNumber('rt-hback', Math.max(0, hback));
    rk628RtSetNumber('rt-hdisplay', mode.hdisplay ?? 0);
    rk628RtSetNumber('rt-hfront', Math.max(0, hfront));

    rk628RtSetNumber('rt-vsync-len', Math.max(0, vsyncLen));
    rk628RtSetNumber('rt-vback', Math.max(0, vback));
    rk628RtSetNumber('rt-vdisplay', mode.vdisplay ?? 0);
    rk628RtSetNumber('rt-vfront', Math.max(0, vfront));

    rk628RtSetNumber('rt-clock', mode.clock ?? 0);

    // Polarity
    const flags = mode.flags ?? 0;
    const hPositive = rk628IsHSyncPositive(flags);
    const vPositive = rk628IsVSyncPositive(flags);
    const hEl = document.getElementById('rt-hsync-positive');
    const vEl = document.getElementById('rt-vsync-positive');
    if (hEl) hEl.checked = hPositive;
    if (vEl) vEl.checked = vPositive;

    const out = document.getElementById('rt-flags');
    if (out) out.value = String(flags);

    window.rk628RtUpdateTiming();

    rk628RtState.runtimeOverride = !!runtimeOverride;
}

window.rk628RtReload = async function (silent = false) {
    if (rk628RtState.inFlight) return;
    rk628RtState.inFlight = true;
    try {
        let data = null;
        let modeLoaded = false;
        try {
            const knobs = await sendRK628CommandWithTimeout(17, null, 5000);
            data = knobs?.data || null;
            const mode = data?.effective_dst_mode || data?.mode || data?.dst_mode;
            if (mode) {
                rk628RtApplyModeToUi(mode, !!data.runtime_dst_mode);
                modeLoaded = true;
            }
            rk628RtApplyLaneRateToUi(data?.fixed_lane_rate_mbps ?? 0);
        } catch {
            // Older firmware may not expose display knobs; fall back to mode-only read.
        }

        if (!modeLoaded) {
            const res = await sendRK628CommandWithTimeout(12, null, 5000);
            data = res?.data || {};
            rk628RtApplyModeToUi(data.mode || data.dst_mode || data, !!data.runtime_override);
        }

        rk628RtState.loadedOnce = true;
        rk628RtState.lastLoadTs = Date.now();

        if (!silent) {
            showToast(rk628RtState.runtimeOverride ? '已读取当前运行参数' : '已读取当前生效参数', 'success');
        }
    } catch (e) {
        if (!silent) {
            showToast('从下位机读取失败: ' + rk628ExtractErrorMessage(e), 'error');
        }
    } finally {
        rk628RtState.inFlight = false;
    }
};

function rk628RtBuildModeFromUi() {
    const hsyncLen = rk628RtGetNumber('rt-hsync-len', 0);
    const hback = rk628RtGetNumber('rt-hback', 0);
    const hdisplay = rk628RtGetNumber('rt-hdisplay', 0);
    const hfront = rk628RtGetNumber('rt-hfront', 0);

    const vsyncLen = rk628RtGetNumber('rt-vsync-len', 0);
    const vback = rk628RtGetNumber('rt-vback', 0);
    const vdisplay = rk628RtGetNumber('rt-vdisplay', 0);
    const vfront = rk628RtGetNumber('rt-vfront', 0);

    const hsync_start = hdisplay + hfront;
    const hsync_end = hsync_start + hsyncLen;
    const htotal = hsyncLen + hback + hdisplay + hfront;

    const vsync_start = vdisplay + vfront;
    const vsync_end = vsync_start + vsyncLen;
    const vtotal = vsyncLen + vback + vdisplay + vfront;

    const flags = parseInt(document.getElementById('rt-flags')?.value ?? '0');

    return {
        clock: rk628RtGetNumber('rt-clock', 0),
        hdisplay,
        hsync_start,
        hsync_end,
        htotal,
        vdisplay,
        vsync_start,
        vsync_end,
        vtotal,
        flags: Number.isFinite(flags) ? flags : 0,
    };
}

function rk628RtReadLaneRate() {
    const value = Number(document.getElementById('rt-lane-rate')?.value);
    if (!Number.isInteger(value) || !(value === 0 || (value >= 80 && value <= 1500))) {
        throw new Error('Lane Rate 必须为 0（自动）或 80 到 1500 Mbps 的整数');
    }
    return value;
}

window.rk628RtApply = function () {
    (async () => {
        try {
            const mode = rk628RtBuildModeFromUi();
            const laneRate = rk628RtReadLaneRate();
            showToast('正在测试当前参数...', 'info');
            await sendRK628CommandWithTimeout(18, {
                fixed_lane_rate_mbps: laneRate,
                persist: 0,
                restart: 0,
            }, 4000);
            await sendRK628CommandWithTimeout(13, { mode, restart: 1, power_cycle: 0 }, 10000);
            showToast('参数已下发并请求重启（未写入 Flash），请观察画面确认', 'success');

            setTimeout(() => {
                try { window.rk628RtReload(true); } catch { }
            }, 1500);
        } catch (e) {
            showToast('测试当前参数失败: ' + rk628ExtractErrorMessage(e), 'error');
        }
    })();
};

window.rk628RtWriteFlash = function () {
	showModal(
		'保存当前参数',
		`
		<div style="line-height:1.65; color: var(--text-primary); padding: 10px 2px;">
			<div style="font-weight:900; font-size: var(--font-body-lg); margin-bottom: 10px; color: rgba(255, 69, 58, 1);">保存当前参数到 Flash</div>
			<div style="color: rgba(235, 235, 245, 0.75); margin-bottom: 10px;">
				将当前屏幕输出时序和 Lane Rate 保存到下位机 Flash。写错配置可能导致：
			</div>
			<ul style="margin: 0; padding-left: 18px; color: rgba(235, 235, 245, 0.75);">
				<li>屏幕黑屏、花屏、闪屏，设备看起来“死机”</li>
				<li>串口/网络仍在但无法看见画面，调试难度大幅上升</li>
				<li>需要通过恢复默认/重新刷写配置/断电重启才能恢复</li>
			</ul>
			<div style="margin-top: 10px; color: rgba(235, 235, 245, 0.75);">建议：先点击“测试当前参数”确认画面稳定，再保存当前参数。</div>
		</div>
		`,
		async () => {
			try {
				const mode = rk628RtBuildModeFromUi();
				const laneRate = rk628RtReadLaneRate();
				showToast('正在保存当前参数...', 'info');
				await sendRK628CommandWithTimeout(3, mode, 6000); // action=3: 保存目标模式到Flash
				await sendRK628CommandWithTimeout(18, {
					fixed_lane_rate_mbps: laneRate,
					persist: 1,
					restart: 0,
				}, 6000);
				await sendRK628CommandWithTimeout(7, {
					power_cycle: 0,
					reset_ms: 10,
					settle_ms: 80,
				}, 10000);
				showToast('保存请求已提交并请求硬重启，请重启后重新读取确认', 'success');
			} catch (e) {
				showToast('保存当前参数失败: ' + rk628ExtractErrorMessage(e), 'error');
			}
		},
		'md'
	);
};

function rk628RtOnOpen() {
    const now = Date.now();
    if (rk628RtState.inFlight) return;
    // Avoid spamming device if user taps the tab repeatedly.
    if (rk628RtState.loadedOnce && (now - rk628RtState.lastLoadTs) < 800) return;
    window.rk628RtReload(true);
}

// expose for HTML
window.rk628RtOnOpen = rk628RtOnOpen;

// ========== RK628 初始化序列调试 ==========

let rk628InitSeqState = {
    inFlight: false,
};

const RK628_INITSEQ_LS_KEY_TEXT = 'rk628:initseq:text:v1';
const RK628_INITSEQ_LS_KEY_MODEFLAGS = 'rk628:initseq:mode_flags:v1';

function rk628InitSeqGetTextareaEl() {
    return document.getElementById('rk628-init-seq-text');
}

function rk628InitSeqTextIsEmpty(text) {
    return !String(text ?? '').trim();
}

function rk628InitSeqLoadFromLocalStorage() {
    let text = '';
    let modeFlags = undefined;
    try { text = String(localStorage.getItem(RK628_INITSEQ_LS_KEY_TEXT) ?? ''); } catch (e) { /* ignore */ }
    try {
        const mf = localStorage.getItem(RK628_INITSEQ_LS_KEY_MODEFLAGS);
        if (mf != null && mf !== '') modeFlags = Number(mf) >>> 0;
    } catch (e) { /* ignore */ }
    return { text, modeFlags };
}

function rk628InitSeqSaveToLocalStorage(text, modeFlags) {
    try { localStorage.setItem(RK628_INITSEQ_LS_KEY_TEXT, String(text ?? '')); } catch (e) { /* ignore */ }
    try {
        if (typeof modeFlags !== 'undefined') {
            localStorage.setItem(RK628_INITSEQ_LS_KEY_MODEFLAGS, String((Number(modeFlags) >>> 0)));
        }
    } catch (e) { /* ignore */ }
}

async function rk628InitSeqOnOpen() {
    // Ensure the mode_flags label is correct even before any load.
    rk628InitSeqBindModeFlagsListenersOnce();

    const el = rk628InitSeqGetTextareaEl();
    if (!el) return;

    // If user already has something on screen, don't overwrite.
    if (!rk628InitSeqTextIsEmpty(el.value)) return;

    // Prefer local cache if present.
    const cached = rk628InitSeqLoadFromLocalStorage();
    if (!rk628InitSeqTextIsEmpty(cached.text)) {
        el.value = cached.text;
        if (typeof cached.modeFlags !== 'undefined') {
            rk628InitSeqSetModeFlagsToUi(cached.modeFlags);
        } else {
            rk628InitSeqSetModeFlagsToUi(rk628InitSeqGetModeFlagsFromUi());
        }
        showToast('已从本地缓存加载初始化序列', 'success');
        return;
    }

    // Otherwise auto-read from device.
    try { await window.rk628InitSeqReload(); } catch (e) { /* ignore */ }
}

const RK628_MIPI_DSI_MODE_FLAGS = {
    VIDEO: 1 << 0,
    VIDEO_BURST: 1 << 1,
    VIDEO_SYNC_PULSE: 1 << 2,
    VIDEO_HFP: 1 << 5,
    VIDEO_HBP: 1 << 6,
    EOT_PACKET: 1 << 9,
    CLOCK_NON_CONTINUOUS: 1 << 10,
    LPM: 1 << 11,
};

function rk628InitSeqGetModeFlagsFromUi() {
    const get = (id) => !!document.getElementById(id)?.checked;
    let flags = 0;
    if (get('initseq-flag-video')) flags |= RK628_MIPI_DSI_MODE_FLAGS.VIDEO;
    if (get('initseq-flag-burst')) flags |= RK628_MIPI_DSI_MODE_FLAGS.VIDEO_BURST;
    if (get('initseq-flag-syncpulse')) flags |= RK628_MIPI_DSI_MODE_FLAGS.VIDEO_SYNC_PULSE;
    if (get('initseq-flag-hfp')) flags |= RK628_MIPI_DSI_MODE_FLAGS.VIDEO_HFP;
    if (get('initseq-flag-hbp')) flags |= RK628_MIPI_DSI_MODE_FLAGS.VIDEO_HBP;
    if (get('initseq-flag-eot')) flags |= RK628_MIPI_DSI_MODE_FLAGS.EOT_PACKET;
    if (get('initseq-flag-noncont')) flags |= RK628_MIPI_DSI_MODE_FLAGS.CLOCK_NON_CONTINUOUS;
    if (get('initseq-flag-lpm')) flags |= RK628_MIPI_DSI_MODE_FLAGS.LPM;
    return flags >>> 0;
}

function rk628InitSeqSetModeFlagsToUi(flags) {
    const f = Number(flags) >>> 0;
    const set = (id, bit) => {
        const el = document.getElementById(id);
        if (el) el.checked = !!(f & bit);
    };
    set('initseq-flag-video', RK628_MIPI_DSI_MODE_FLAGS.VIDEO);
    set('initseq-flag-burst', RK628_MIPI_DSI_MODE_FLAGS.VIDEO_BURST);
    set('initseq-flag-syncpulse', RK628_MIPI_DSI_MODE_FLAGS.VIDEO_SYNC_PULSE);
    set('initseq-flag-hfp', RK628_MIPI_DSI_MODE_FLAGS.VIDEO_HFP);
    set('initseq-flag-hbp', RK628_MIPI_DSI_MODE_FLAGS.VIDEO_HBP);
    set('initseq-flag-eot', RK628_MIPI_DSI_MODE_FLAGS.EOT_PACKET);
    set('initseq-flag-noncont', RK628_MIPI_DSI_MODE_FLAGS.CLOCK_NON_CONTINUOUS);
    set('initseq-flag-lpm', RK628_MIPI_DSI_MODE_FLAGS.LPM);

    const label = document.getElementById('initseq-modeflags-value');
    if (label) {
        label.textContent = '0x' + f.toString(16).toUpperCase().padStart(8, '0');
    }
}

function rk628InitSeqBindModeFlagsListenersOnce() {
    const ids = [
        'initseq-flag-video',
        'initseq-flag-burst',
        'initseq-flag-syncpulse',
        'initseq-flag-hfp',
        'initseq-flag-hbp',
        'initseq-flag-eot',
        'initseq-flag-noncont',
        'initseq-flag-lpm',
    ];
    for (const id of ids) {
        const el = document.getElementById(id);
        if (!el || el.dataset.bound === '1') continue;
        el.addEventListener('change', () => {
            rk628InitSeqSetModeFlagsToUi(rk628InitSeqGetModeFlagsFromUi());
        });
        el.dataset.bound = '1';
    }
    // initial paint
    rk628InitSeqSetModeFlagsToUi(rk628InitSeqGetModeFlagsFromUi());
}

function rk628InitSeqParseByte(tok) {
    if (tok == null) return null;
    const s0 = String(tok).trim();
    if (!s0) return null;
    const s = s0.toLowerCase().startsWith('0x') ? s0.slice(2) : s0;
    if (!/^[0-9a-fA-F]{1,2}$/.test(s)) return null;
    const v = parseInt(s, 16);
    if (!Number.isFinite(v) || v < 0 || v > 255) return null;
    return v;
}

function rk628InitSeqParseTextToCmds(text) {
    const lines = String(text ?? '').split(/\r?\n/);
    const cmds = [];
    for (let idx = 0; idx < lines.length; idx++) {
        let line = lines[idx];
        // strip comments (# or //)
        line = line.replace(/\s*(#|\/\/).*$/, '').trim();
        if (!line) continue;
        const parts = line.split(/\s+/).filter(Boolean);
        if (parts.length < 3) {
            throw new Error(`第 ${idx + 1} 行格式错误：至少需要 DT DELAY LEN`);
        }
        const dt = rk628InitSeqParseByte(parts[0]);
        const delay = rk628InitSeqParseByte(parts[1]);
        const len = rk628InitSeqParseByte(parts[2]);
        if (dt == null) throw new Error(`第 ${idx + 1} 行 DT 无效`);
        if (delay == null) throw new Error(`第 ${idx + 1} 行 DELAY 无效`);
        if (len == null) throw new Error(`第 ${idx + 1} 行 LEN 无效`);
        if (len > 61) throw new Error(`第 ${idx + 1} 行 LEN 过大（最大 3D=61）`);
        if (parts.length !== 3 + len) {
            throw new Error(`第 ${idx + 1} 行 PAYLOAD 数量不匹配：LEN=${len} 但给了 ${parts.length - 3} 个`);
        }
        const arr = [dt, delay, len];
        for (let i = 0; i < len; i++) {
            const b = rk628InitSeqParseByte(parts[3 + i]);
            if (b == null) throw new Error(`第 ${idx + 1} 行 PAYLOAD[${i}] 无效`);
            arr.push(b);
        }
        cmds.push(arr);
    }
    if (cmds.length === 0) {
        throw new Error('初始化序列为空');
    }
    if (cmds.length > 128) {
        throw new Error('初始化序列过长（最多 128 条）');
    }
    return cmds;
}

function rk628InitSeqFormatCmdsToText(cmds) {
    if (!Array.isArray(cmds)) return '';
    const lines = [];
    for (const cmd of cmds) {
        if (!Array.isArray(cmd) || cmd.length < 3) continue;
        const dt = cmd[0] ?? 0;
        const delay = cmd[1] ?? 0;
        const len = cmd[2] ?? 0;
        const row = [dt, delay, len];
        for (let i = 0; i < len; i++) {
            row.push(cmd[3 + i] ?? 0);
        }
        lines.push(row.map(v => {
            const n = Number(v) & 0xFF;
            return n.toString(16).toUpperCase().padStart(2, '0');
        }).join(' '));
    }
    return lines.join('\n');
}

window.rk628InitSeqReload = async function () {
    if (rk628InitSeqState.inFlight) return;
    rk628InitSeqState.inFlight = true;
    try {
        const res = await sendRK628CommandWithTimeout(16, null, 4000);
        const data = res?.data || {};
        const cmds = data.cmds;
        const modeFlags = (typeof data.mode_flags !== 'undefined') ? data.mode_flags : undefined;
        if (!Array.isArray(cmds) || cmds.length === 0) {
            throw new Error('下位机返回的初始化序列为空');
        }
        const seq = rk628InitSeqFormatCmdsToText(cmds);
        const el = document.getElementById('rk628-init-seq-text');
        if (el && typeof seq === 'string') {
            el.value = seq;
        }

        rk628InitSeqBindModeFlagsListenersOnce();
        if (typeof modeFlags !== 'undefined') {
            rk628InitSeqSetModeFlagsToUi(modeFlags);
        }
        showToast('已读取初始化序列', 'success');
    } catch (e) {
        showToast('读取失败: ' + rk628ExtractErrorMessage(e), 'error');
    } finally {
        rk628InitSeqState.inFlight = false;
    }
};

window.rk628InitSeqApply = async function () {
    if (rk628InitSeqState.inFlight) return;
    rk628InitSeqState.inFlight = true;
    try {
        const el = document.getElementById('rk628-init-seq-text');
        const seqText = (el?.value ?? '');
        const cmds = rk628InitSeqParseTextToCmds(seqText);

        rk628InitSeqBindModeFlagsListenersOnce();
        const modeFlags = rk628InitSeqGetModeFlagsFromUi();

        showToast('正在应用初始化序列...', 'info');
        await sendRK628CommandWithTimeout(15, { cmds, mode_flags: modeFlags, power_cycle: 0 }, 15000);

		rk628InitSeqSaveToLocalStorage(seqText, modeFlags);
        showToast('初始化序列已应用（未写Flash）', 'success');
    } catch (e) {
        showToast('应用失败: ' + rk628ExtractErrorMessage(e), 'error');
    } finally {
        rk628InitSeqState.inFlight = false;
    }
};

window.rk628InitSeqWriteFlash = function () {
	showModal(
		'写入Flash',
		`
		<div style="line-height:1.65; color: var(--text-primary); padding: 10px 2px;">
			<div style="font-weight:900; font-size: var(--font-body-lg); margin-bottom: 10px; color: rgba(255, 69, 58, 1);">写入Flash（危险操作）</div>
			<div style="color: rgba(235, 235, 245, 0.75); margin-bottom: 10px;">
				将当前初始化序列写入下位机Flash。写错初始化序列可能导致：
			</div>
			<ul style="margin: 0; padding-left: 18px; color: rgba(235, 235, 245, 0.75);">
				<li>屏幕无法点亮、一直黑屏</li>
				<li>每次启动都会使用错误序列，需要手动恢复/重新刷写</li>
			</ul>
			<div style="margin-top: 10px; color: rgba(235, 235, 245, 0.75);">建议：先用“应用(不写Flash)”验证可用，再写入Flash。</div>
		</div>
		`,
		async () => {
			try {
				const el = document.getElementById('rk628-init-seq-text');
				const seqText = (el?.value ?? '');
				const cmds = rk628InitSeqParseTextToCmds(seqText);

				rk628InitSeqBindModeFlagsListenersOnce();
				const modeFlags = rk628InitSeqGetModeFlagsFromUi();

				showToast('正在写入Flash并应用...', 'info');
				await sendRK628CommandWithTimeout(15, { cmds, mode_flags: modeFlags, write_flash: 1, power_cycle: 0 }, 20000);

				rk628InitSeqSaveToLocalStorage(seqText, modeFlags);
				showToast('已写入Flash并应用', 'success');
			} catch (e) {
				showToast('写入Flash失败: ' + rk628ExtractErrorMessage(e), 'error');
			}
		},
		'md'
	);
};

// 页面加载时初始化实时配置 polarity 监听器
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initRtFlagsListeners);
} else {
    initRtFlagsListeners();
}

// ========== 触摸优化的数字输入框 ==========
/**
 * 将所有 input[type="number"] 包装为带有触摸友好按钮的控件
 */
function initTouchFriendlyNumberInputs() {
    // 获取所有未被包装的 number 输入框
    const numberInputs = document.querySelectorAll('input[type="number"]:not(.number-wrapped)');
    numberInputs.forEach(input => {
        // 标记为已处理
        input.classList.add('number-wrapped');
        // 创建包装器
        const wrapper = document.createElement('div');
        wrapper.className = 'number-input-wrapper';
        // 创建减少按钮
        const decreaseBtn = document.createElement('button');
        decreaseBtn.className = 'number-btn decrease';
        decreaseBtn.innerHTML = '−';
        decreaseBtn.type = 'button';
        decreaseBtn.setAttribute('aria-label', '减少');
        // 创建增加按钮
        const increaseBtn = document.createElement('button');
        increaseBtn.className = 'number-btn increase';
        increaseBtn.innerHTML = '+';
        increaseBtn.type = 'button';
        increaseBtn.setAttribute('aria-label', '增加');
        // 获取步长
        const step = parseFloat(input.step) || 1;
        const min = input.min !== '' ? parseFloat(input.min) : -Infinity;
        const max = input.max !== '' ? parseFloat(input.max) : Infinity;
        // 减少按钮点击事件
        decreaseBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const currentValue = parseFloat(input.value) || 0;
            const newValue = Math.max(min, currentValue - step);
            input.value = newValue;
            // 触发 input 和 change 事件
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            // 如果有 oninput 属性,手动调用
            if (input.getAttribute('oninput')) {
                const oninputCode = input.getAttribute('oninput');
                try {
                    eval(oninputCode);
                } catch (e) {
                    console.error('Error executing oninput:', e);
                }
            }
        });
        // 增加按钮点击事件
        increaseBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const currentValue = parseFloat(input.value) || 0;
            const newValue = Math.min(max, currentValue + step);
            input.value = newValue;
            // 触发 input 和 change 事件
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            // 如果有 oninput 属性,手动调用
            if (input.getAttribute('oninput')) {
                const oninputCode = input.getAttribute('oninput');
                try {
                    eval(oninputCode);
                } catch (e) {
                    console.error('Error executing oninput:', e);
                }
            }
        });
        // 长按支持
        let longPressTimer = null;
        let longPressInterval = null;
        const startLongPress = (btn, isIncrease) => {
            longPressTimer = setTimeout(() => {
                longPressInterval = setInterval(() => {
                    btn.click();
                }, 100);
            }, 500);
        };
        const stopLongPress = () => {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
            if (longPressInterval) {
                clearInterval(longPressInterval);
                longPressInterval = null;
            }
        };
        // 为减少按钮添加长按
        decreaseBtn.addEventListener('mousedown', () => startLongPress(decreaseBtn, false));
        decreaseBtn.addEventListener('mouseup', stopLongPress);
        decreaseBtn.addEventListener('mouseleave', stopLongPress);
        decreaseBtn.addEventListener('touchstart', () => startLongPress(decreaseBtn, false));
        decreaseBtn.addEventListener('touchend', stopLongPress);
        // 为增加按钮添加长按
        increaseBtn.addEventListener('mousedown', () => startLongPress(increaseBtn, true));
        increaseBtn.addEventListener('mouseup', stopLongPress);
        increaseBtn.addEventListener('mouseleave', stopLongPress);
        increaseBtn.addEventListener('touchstart', () => startLongPress(increaseBtn, true));
        increaseBtn.addEventListener('touchend', stopLongPress);
        // 插入到DOM
        input.parentNode.insertBefore(wrapper, input);
        wrapper.appendChild(decreaseBtn);
        wrapper.appendChild(input);
        wrapper.appendChild(increaseBtn);
    });
}
// 页面加载时初始化
document.addEventListener('DOMContentLoaded', () => {
    initTouchFriendlyNumberInputs();
});
// 提供全局函数,用于动态添加的输入框
window.initTouchFriendlyNumberInputs = initTouchFriendlyNumberInputs;

// ========== 虚拟触摸板功能 ==========

/**
 * 虚拟触摸板 - 多点触控支持
 * 使用HID鼠标协议 (Report ID 0x03)
 * 报文格式: [0x03, buttons, x, y, wheel]
 *   - buttons: 按键状态 (bit0=左键, bit1=右键, bit2=中键)
 *   - x, y: 相对移动量 (signed byte, -127 to 127)
 *   - wheel: 滚轮 (signed byte)
 */

function initVirtualTouchpad() {
    const touchpadSurface = document.getElementById('touchpadSurface');
    const leftBtn = document.getElementById('touchpadBtnLeft');
    const rightBtn = document.getElementById('touchpadBtnRight');
    const touchCountDisplay = document.getElementById('touchpadTouchCount');
    const sensitivityDisplay = document.getElementById('touchpadSensitivity');

    if (!touchpadSurface) {
        console.warn('[Touchpad] touchpadSurface element not found');
        return;
    }

    // 触摸板状态
    let sensitivity = 1.0; // 灵敏度系数
    let buttonState = 0;   // 按键状态 (bit mask)
    const activeTouches = new Map(); // touchId -> {x, y, lastX, lastY}
    let lastSendTime = 0;
    const SEND_INTERVAL = 8; // 发送间隔 (ms), 约125Hz

    // 调整灵敏度
    window.adjustSensitivity = function (delta) {
        sensitivity = Math.max(0.2, Math.min(3.0, sensitivity + delta));
        if (sensitivityDisplay) {
            sensitivityDisplay.textContent = sensitivity.toFixed(1) + '×';
        }
    };

    // 发送HID鼠标报文 (使用统一的 sendHIDReport)
    function sendMouseReportLocal(buttons, deltaX, deltaY, wheel = 0) {
        const report = generateMouseReport(buttons, deltaX, deltaY, wheel);
        sendHIDReport(report);
    }

    // 更新触摸点显示
    function updateTouchIndicators() {
        // 移除所有现有指示器
        const existingIndicators = touchpadSurface.querySelectorAll('.touch-indicator');
        existingIndicators.forEach(indicator => indicator.remove());

        // 为每个活动触点创建指示器
        activeTouches.forEach((touch, touchId) => {
            const indicator = document.createElement('div');
            indicator.className = 'touch-indicator';
            indicator.style.left = touch.x + 'px';
            indicator.style.top = touch.y + 'px';
            touchpadSurface.appendChild(indicator);
        });

        // 更新触点计数
        if (touchCountDisplay) {
            touchCountDisplay.textContent = activeTouches.size;
        }
    }

    // 处理触摸开始
    function handleTouchStart(e) {
        e.preventDefault();
        const rect = touchpadSurface.getBoundingClientRect();

        Array.from(e.changedTouches).forEach(touch => {
            const x = touch.clientX - rect.left;
            const y = touch.clientY - rect.top;

            activeTouches.set(touch.identifier, {
                x: x,
                y: y,
                lastX: x,
                lastY: y,
                startTime: Date.now()
            });
        });

        updateTouchIndicators();
    }

    // 处理触摸移动
    function handleTouchMove(e) {
        e.preventDefault();
        const rect = touchpadSurface.getBoundingClientRect();
        const now = Date.now();

        // 限流: 避免过于频繁发送
        if (now - lastSendTime < SEND_INTERVAL) {
            return;
        }
        lastSendTime = now;

        let totalDeltaX = 0;
        let totalDeltaY = 0;
        let touchCount = 0;

        Array.from(e.changedTouches).forEach(touch => {
            const touchData = activeTouches.get(touch.identifier);
            if (!touchData) return;

            const x = touch.clientX - rect.left;
            const y = touch.clientY - rect.top;

            // 计算相对移动量
            const deltaX = (x - touchData.lastX) * sensitivity;
            const deltaY = (y - touchData.lastY) * sensitivity;

            totalDeltaX += deltaX;
            totalDeltaY += deltaY;
            touchCount++;

            // 更新位置
            touchData.x = x;
            touchData.y = y;
            touchData.lastX = x;
            touchData.lastY = y;
        });

        // 平均移动量
        if (touchCount > 0) {
            const avgDeltaX = totalDeltaX / touchCount;
            const avgDeltaY = totalDeltaY / touchCount;

            // 发送鼠标移动报文
            if (Math.abs(avgDeltaX) > 0.5 || Math.abs(avgDeltaY) > 0.5) {
                sendMouseReportLocal(buttonState, avgDeltaX, avgDeltaY, 0);
            }
        }

        updateTouchIndicators();
    }

    // 处理触摸结束
    function handleTouchEnd(e) {
        e.preventDefault();

        Array.from(e.changedTouches).forEach(touch => {
            const touchData = activeTouches.get(touch.identifier);
            if (!touchData) return;

            const duration = Date.now() - touchData.startTime;

            // 轻触判定: 短时间内无明显移动 = 左键点击
            if (duration < 200) {
                const deltaX = Math.abs(touchData.x - touchData.lastX);
                const deltaY = Math.abs(touchData.y - touchData.lastY);

                if (deltaX < 5 && deltaY < 5) {
                    // 模拟左键点击
                    sendMouseReportLocal(0x01, 0, 0, 0); // 按下
                    setTimeout(() => sendMouseReportLocal(0x00, 0, 0, 0), 50); // 释放
                }
            }

            activeTouches.delete(touch.identifier);
        });

        updateTouchIndicators();
    }

    // 处理触摸取消
    function handleTouchCancel(e) {
        e.preventDefault();

        Array.from(e.changedTouches).forEach(touch => {
            activeTouches.delete(touch.identifier);
        });

        updateTouchIndicators();
    }

    // 左键按钮
    leftBtn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        buttonState |= 0x01; // 设置左键位
        leftBtn.classList.add('pressed');
        sendMouseReportLocal(buttonState, 0, 0, 0);
    });

    leftBtn.addEventListener('touchend', (e) => {
        e.preventDefault();
        buttonState &= ~0x01; // 清除左键位
        leftBtn.classList.remove('pressed');
        sendMouseReportLocal(buttonState, 0, 0, 0);
    });

    leftBtn.addEventListener('touchcancel', (e) => {
        e.preventDefault();
        buttonState &= ~0x01;
        leftBtn.classList.remove('pressed');
        sendMouseReportLocal(buttonState, 0, 0, 0);
    });

    // 右键按钮
    rightBtn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        buttonState |= 0x02; // 设置右键位
        rightBtn.classList.add('pressed');
        sendMouseReportLocal(buttonState, 0, 0, 0);
    });

    rightBtn.addEventListener('touchend', (e) => {
        e.preventDefault();
        buttonState &= ~0x02; // 清除右键位
        rightBtn.classList.remove('pressed');
        sendMouseReportLocal(buttonState, 0, 0, 0);
    });

    rightBtn.addEventListener('touchcancel', (e) => {
        e.preventDefault();
        buttonState &= ~0x02;
        rightBtn.classList.remove('pressed');
        sendMouseReportLocal(buttonState, 0, 0, 0);
    });

    // 触摸板表面事件
    touchpadSurface.addEventListener('touchstart', handleTouchStart, { passive: false });
    touchpadSurface.addEventListener('touchmove', handleTouchMove, { passive: false });
    touchpadSurface.addEventListener('touchend', handleTouchEnd, { passive: false });
    touchpadSurface.addEventListener('touchcancel', handleTouchCancel, { passive: false });

    console.log('[Touchpad] Virtual touchpad initialized');
}

// 页面打开时初始化触摸板
window.openPage = function (pageName, tabName) {
    originalOpenPage(pageName, tabName);

    // 输入控制页：让窗口不抢焦点，避免影响主机输入
    if (pageName === 'input' && (tabName === 'shortcuts' || tabName === 'emoji' || tabName === 'browser')) {
        sendMessage('system', 'setNoActivate', { enable: true });
    } else {
        sendMessage('system', 'setNoActivate', { enable: false });
    }

    // 打开虚拟触摸板时初始化事件绑定（幂等）
    if (pageName === 'touchpad') {
        try {
            initVirtualTouchpad();
        } catch (e) {
            console.warn('[Touchpad] init failed', e);
        }
    }

    // 打开 RK628 配置页时自动加载配置
    if (pageName === 'rk628-config') {
        ensureRK628TabState();
        try {
            loadRK628Config();
        } catch (e) {
            console.warn('[RK628] load config failed', e);
        }
        loadRK628Status();
    }
};

window.closePage = function () {
    originalClosePage();
};
