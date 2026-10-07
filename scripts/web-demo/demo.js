// Only the static export loads this adapter. The desktop host uses its own bridge.
(() => {
    const demoMessage = '静态演示：此操作需要桌面上位机或设备';
    const apps = [['edge', '浏览器', '🌐'], ['explorer', '文件管理', '📁'],
        ['notepad', '记事本', '📝'], ['calculator', '计算器', '🧮'],
        ['terminal', '终端', '💻'], ['music', '音乐', '🎵']].map(([id, name, icon]) => ({
        id, name, path: '',
        icon: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><text x="48" y="72" text-anchor="middle" font-size="72">${icon}</text></svg>`)}`
    }));
    const networks = [
        { ssid: 'Demo Wi-Fi', rssi: -42, security: 3, channel: 6 },
        { ssid: 'Studio Network', rssi: -58, security: 3, channel: 11 },
        { ssid: 'Guest Wi-Fi', rssi: -71, security: 0, channel: 1 }
    ];
    const wifi = { mode: 1, on: true, enabled: true, connected: true,
        ssid: 'Demo Wi-Fi', ip: '192.0.2.10', mac: '02:00:00:00:00:01', rssi: -42,
        storedSsids: ['Demo Wi-Fi'], scanning: false };
    const media = { title: '午后时光', artist: 'PanelManager · 演示曲目', isPlaying: false };
    const stats = { cpu: 32, memory: { used: 8.2, total: 16, percent: 51.25 },
        temperature: 48, network: { download: 1280000, upload: 96000 },
        temperatureSensors: [
            { id: 'demo-cpu', kind: 'CPU', hardware: 'Demo CPU', name: 'Package', value: 48 },
            { id: 'demo-gpu', kind: 'GPU', hardware: 'Demo GPU', name: 'Core', value: 42 }
        ] };
    const fixtures = {
        'app:list': () => ({ apps }),
        'system:getTime': () => ({ timestamp: Date.now() }),
        'system:getWeather': () => ({ icon: '☀️', temperature: 24,
            location: '演示城市', description: '晴 · 示例数据' }),
        'system:getMicrophoneStatus': () => ({ enabled: microphoneEnabled }),
        'system:getMediaSessions': () => ({ sessions: [{ id: 'demo', name: '演示播放器' }] }),
        'system:getCurrentMediaInfo': () => media,
        'system:appUpdateStatus': () => ({ revision: 1, status: 'idle',
            currentVersion: 'demo', canInstall: false }),
        'wifi:getStatus': () => wifi,
        'wifi:getIp': () => ({ ip: wifi.ip, mask: '255.255.255.0', gateway: '192.0.2.1' }),
        'bluetooth:getStatus': () => ({ mode: 0, connected: false,
            localName: 'PanelManager Demo', mac: '02:00:00:00:00:02' }),
        'bluetooth:getMode': () => ({ mode: 'off' }),
        'panel:getStatus': () => ({ enabled: panelEnabled })
    };
    const localControls = new Set(['system:setVolume', 'system:setMute',
        'system:setMicrophoneStatus', 'system:setNoActivate', 'panel:setBrightness',
        'panel:setEnabled', 'bluetooth:setVisibility', 'wifi:stopScan', 'bluetooth:stopScan']);

    // This is the demo's sole command owner: all responses are local, no socket exists.
    sendMessageWithTimeout = (module, cmd, data, timeoutMs, callback) => {
        const key = `${module}:${cmd}`;
        let result = fixtures[key]?.();
        if (key === 'system:mediaPlayPause') {
            media.isPlaying = !media.isPlaying;
            result = {};
        }
        if (key === 'system:mediaNext' || key === 'system:mediaPrevious') {
            media.title = media.title === '午后时光' ? '城市漫步' : '午后时光';
            getCurrentMediaInfo();
            result = {};
        }
        const supported = result !== undefined || localControls.has(key);
        if (callback) queueMicrotask(() => callback({ code: supported ? 0 : 2,
            msg: supported ? '静态演示' : demoMessage, data: result || {} }));
        else if (!supported) showToast(demoMessage);
        return supported;
    };

    startWifiAutoScan = scanWifiSilent = () => {
        networks.forEach(network => upsertWifiNetwork(createWifiNetworkFromScan(network)));
        renderWifiList();
    };
    launchApp = () => showToast(demoMessage);
    aiInitPage = () => {
        setAiMode(aiState.mode || 'build');
        aiUpdateModelTriggerLabel();
        aiInsertWelcomeHelpIfNeeded();
        aiRenderMessageList();
        aiRenderDetailsPanel();
        aiSetBusy(false);
        document.getElementById('aiConnectionText').textContent = '静态演示 · AI 服务未启动';
    };
    aiSend = () => showToast(demoMessage);
    openDisplayConfig = () => openPage('rk628-config');

    initWebSocket = () => {
        // Enable existing UI initialization, without starting host/device connections.
        wsConnected = true;
        initHomeWidgets();
        initDock();
        initWifiStatus();
        initMicrophoneStatus();
        initPanelStatus();
        updateMediaInfo();
        updatePerformanceDisplay(stats);
        document.getElementById('serialStatus').textContent = '静态演示 · 未连接设备';
        document.getElementById('serialStatus').title = '天气、网络、媒体和性能均为示例数据';
    };
    const open = window.openPage;
    window.openPage = (name, tab) => {
        open(name, tab);
        if (name === 'monitor') {
            for (let i = 0; i < 30; i++) {
                updatePerformanceDetailPage({ ...stats, cpu: 32 + Math.sin(i / 3) * 12 });
            }
        }
    };
})();
