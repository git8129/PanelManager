const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = readFileSync(join(__dirname, '../wwwroot/script.js'), 'utf8');
const functions = [
    'handleEvent', 'isWifiOwnerFault', 'showWifiOwnerFault', 'formatDeviceCommandError',
    'isDeviceTransportError',
    'stopWifiStatusRefresh', 'scheduleWifiStatusRefresh', 'syncWifiSavedSsids',
    'isWifiIntentOn', 'applyWifiStatusSnapshot', 'initWifiStatus',
    'handleWifiSwitchChange', 'switchToStaModeAuto', 'pauseWifiAutoScan',
    'beginWifiScanSession', 'startWifiAutoScan', 'stopWifiAutoScan',
    'clearWifiScanWatchdog', 'armWifiScanWatchdog', 'stopWifiDeviceScan',
    'recoverWifiScanBusy', 'scanWifiSilent', 'clearWifiConnectionOperation',
    'resumeWifiDiscovery', 'finishWifiConnection', 'failWifiConnection',
    'resetWifiConnectionAfterTransportLoss', 'startPendingWifiConnection',
    'queueWifiConnection', 'formatWifiConnectionFailure', 'hasWifiIp'
];

// Execute production declarations/functions, replacing only I/O and rendering.
function harness() {
    let now = 1000;
    let nextTimer = 0;
    let active = true;
    const timers = new Map();
    const requests = [];
    const toasts = [];
    const elements = new Map();
    const context = vm.createContext({
        console: { log() {}, warn() {} },
        Date: { now: () => now },
        document: { getElementById(id) {
            if (!elements.has(id)) elements.set(id, { checked: false, style: {} });
            return elements.get(id);
        } },
        setTimeout(fn, delay) {
            const id = ++nextTimer;
            timers.set(id, { fn, at: now + delay });
            return id;
        },
        clearTimeout: id => timers.delete(id),
        updateWifiStatusBar() {}, renderWifiList() {}, renderDeviceListState() {},
        showToast: message => toasts.push(message), markWifiNetworkUnavailable() {}, ensureConnectedWifiVisible() {},
        pruneStaleWifiNetworks() {}, serialConnected: true
    });
    const evaluate = code => vm.runInContext(code, context);
    evaluate(source.slice(source.indexOf('let wifiNetworks ='),
        source.indexOf('function formatWifiConnectionFailure(')));
    context.isWifiSettingsActive = () => active;
    context.updateWifiStatusBar = () => {};
    for (const name of functions) {
        const start = source.indexOf(`function ${name}(`);
        assert.notEqual(start, -1, name);
        const end = source.indexOf('\n}', start);
        assert.notEqual(end, -1, name);
        evaluate(source.slice(start, end + 2));
    }
    context.sendMessageWithTimeout = (module, cmd, data, timeout, callback) => {
        const request = { module, cmd, data, timeout, done: false };
        const timer = context.setTimeout(() => request.reply({ code: 5, localTimeout: true }), timeout);
        request.reply = response => {
            assert.equal(request.done, false, 'response delivered only once');
            request.done = true;
            timers.delete(timer);
            callback?.(response);
        };
        requests.push(request);
        return true;
    };
    context.sendMessage = (module, cmd, data, callback) =>
        context.sendMessageWithTimeout(module, cmd, data, 30000, callback);
    return {
        context, evaluate, requests, elements, toasts,
        leave() { active = false; context.stopWifiAutoScan(); },
        enter() { active = true; context.beginWifiScanSession(); context.initWifiStatus(); },
        pending(cmd) { return requests.filter(r => r.cmd === cmd && !r.done); },
        advance(ms) {
            const target = now + ms;
            let count = 0;
            while (true) {
                const next = [...timers.entries()].filter(([, t]) => t.at <= target)
                    .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
                if (!next) break;
                assert(++count < 10000, 'timer storm');
                now = next[1].at;
                timers.delete(next[0]);
                next[1].fn();
            }
            now = target;
        },
        status(data = {}) {
            const request = this.pending('getStatus')[0];
            assert(request, 'expected a status query');
            request.reply({ code: 0, data: {
                mode: 1, enabled: true, on: true, connected: false,
                connecting: false, scanning: false, ...data
            } });
        },
        event(cmd, data = {}) { context.handleEvent({ mod: 3, cmd, data }); }
    };
}

test('enable sends setMode immediately; old OFF cannot cancel pending intent', () => {
    const h = harness();
    h.context.handleWifiSwitchChange(true);
    assert.equal(h.requests[0].cmd, 'setMode');
    assert.equal(h.requests[0].data.mode, 1);
    assert.equal(h.requests[0].timeout, 35000);
    h.advance(0);
    h.status({ mode: 0, enabled: false, on: false });
    assert(h.evaluate('isWifiIntentOn()'));
    assert(h.elements.get('wifiSwitchInput').checked);
    h.advance(1000);
    assert.equal(h.pending('getStatus').length, 1);
    assert.equal(h.requests.filter(r => r.cmd === 'setMode').length, 1);
});

test('closing invalidates old enable and status callbacks, including rapid re-enable', () => {
    const h = harness();
    h.context.handleWifiSwitchChange(true);
    const oldEnable = h.pending('setMode')[0];
    h.advance(0);
    const oldStatus = h.pending('getStatus')[0];
    h.context.handleWifiSwitchChange(false);
    oldEnable.reply({ code: 4 });
    oldStatus.reply({ code: 0, data: { enabled: true, on: true } });
    assert.equal(h.evaluate('isWifiIntentOn()'), false);
    assert.equal(h.requests.filter(r => r.cmd === 'setMode').length, 2);
    const oldDisable = h.pending('setMode')[0];
    h.context.handleWifiSwitchChange(true);
    oldDisable.reply({ code: 0 });
    assert(h.evaluate('wifiEnablePending'));
    assert(h.evaluate('isWifiIntentOn()'));
});

test('no saved network terminal uses snapshot before scanning', () => {
    const h = harness();
    h.context.handleWifiSwitchChange(true);
    h.pending('setMode')[0].reply({ code: 4 });
    h.status();
    h.advance(0);
    assert.equal(h.pending('startScan').length, 1);
    assert.equal(h.pending('startScan')[0].timeout, 2000);
});

test('initial query timeout retries briefly and starts scanning without page switch', () => {
    const h = harness();
    h.enter();
    h.advance(3000);
    assert.equal(h.requests.filter(r => r.cmd === 'getStatus').length, 2);
    h.status();
    h.advance(0);
    assert.equal(h.pending('startScan').length, 1);
});

test('busy snapshot is queried until idle, without duplicate queries or scans', () => {
    const h = harness();
    h.enter();
    h.status({ scanning: true });
    for (let i = 0; i < 10; i++) h.context.scheduleWifiStatusRefresh();
    h.advance(1000);
    assert.equal(h.pending('getStatus').length, 1);
    h.context.initWifiStatus();
    assert.equal(h.pending('getStatus').length, 1);
    h.status({ connecting: true });
    assert.equal(h.pending('startScan').length, 0);
    h.advance(1000);
    h.status();
    h.advance(0);
    assert.equal(h.pending('startScan').length, 1);
});

for (const terminals of [
    ['completion'], ['scanComplete'], ['completion', 'scanComplete'],
    ['scanComplete', 'completion']
]) {
    test(`scan terminals reconcile once: ${terminals.join(', ')}`, () => {
        const h = harness();
        h.enter();
        h.status();
        h.advance(0);
        h.pending('startScan')[0].reply({ code: 0 });
        for (const cmd of terminals) h.event(cmd, { cmd: 'startScan', code: 0, count: 0 });
        h.advance(1000);
        assert.equal(h.pending('getStatus').length, 1);
        h.status();
        h.advance(5000);
        assert.equal(h.requests.filter(r => r.cmd === 'startScan').length, 2);
    });
}

test('watchdog reconciles even after another snapshot clears local scanning', () => {
    const h = harness();
    h.enter(); h.status(); h.advance(0);
    h.pending('startScan')[0].reply({ code: 0 });
    h.evaluate('wifiStatus.scanning = false');
    h.advance(16000);
    assert.equal(h.pending('getStatus').length, 1);
    assert.equal(h.pending('getStatus')[0].timeout, 2000);
    h.status(); h.advance(5000);
    assert.equal(h.requests.filter(r => r.cmd === 'startScan').length, 2);
});

test('lost scan acceptance queries owner before issuing another scan', () => {
    const h = harness();
    h.enter(); h.status(); h.advance(0);
    h.advance(3000);
    h.status({ scanning: true });
    assert.equal(h.requests.filter(r => r.cmd === 'startScan').length, 1);
    h.advance(1000); h.status(); h.advance(5000);
    assert.equal(h.requests.filter(r => r.cmd === 'startScan').length, 2);
});

test('failed recovery window cannot be extended by events or repeated init', () => {
    const h = harness();
    h.enter();
    h.advance(25000);
    const count = h.requests.length;
    for (let i = 0; i < 30; i++) {
        h.context.initWifiStatus();
        h.event('completion', { cmd: 'startScan', code: 0 });
        h.advance(1000);
    }
    assert.equal(h.requests.length, count);
    assert(count <= 8, 'recovery request budget');
    h.leave(); h.enter(); h.status(); h.advance(0);
    assert.equal(h.pending('startScan').length, 1);
});

test('continuously busy owner exhausts recovery without issuing scans', () => {
    const h = harness();
    h.enter(); h.status({ scanning: true });
    for (let i = 0; i < 25; i++) {
        h.advance(1000);
        if (h.pending('getStatus').length) h.status({ scanning: true });
    }
    const count = h.requests.length;
    h.advance(30000);
    assert.equal(h.requests.length, count);
    assert(count <= 20);
    assert.equal(h.pending('startScan').length, 0);
});

test('late terminal from previous scan cannot clear a new owner scan', () => {
    const h = harness();
    h.enter(); h.status(); h.advance(0);
    h.pending('startScan')[0].reply({ code: 0 });
    h.event('completion', { cmd: 'startScan', code: 0 });
    h.advance(1000); h.status({ scanning: true });
    assert(h.evaluate('wifiStatus.scanning'));
    h.advance(1000);
    assert.equal(h.pending('getStatus').length, 1);
    assert.equal(h.requests.filter(r => r.cmd === 'startScan').length, 1);
});

test('enable timeout ends pending intent and old query cannot overwrite terminal snapshot', () => {
    const h = harness();
    h.context.handleWifiSwitchChange(true);
    h.advance(0);
    const oldStatus = h.pending('getStatus')[0];
    h.pending('setMode')[0].reply({ code: 0 });
    const latest = h.pending('getStatus').at(-1);
    latest.reply({ code: 0, data: { enabled: true, on: true } });
    oldStatus.reply({ code: 0, data: { enabled: false, on: false } });
    assert(h.evaluate('isWifiIntentOn()'));
    const failed = harness();
    failed.context.handleWifiSwitchChange(true);
    failed.advance(60000);
    assert.equal(failed.evaluate('wifiEnablePending'), false);
    const count = failed.requests.length;
    failed.advance(60000);
    assert.equal(failed.requests.length, count);
    assert.equal(failed.requests.filter(r => r.cmd === 'setMode').length, 1);
});

test('session expiration and leaving ignore late status and scan acceptance', () => {
    const h = harness();
    h.enter();
    const oldStatus = h.pending('getStatus')[0];
    h.leave();
    oldStatus.reply({ code: 0, data: { enabled: true, on: true } });
    assert.equal(h.evaluate('wifiStatus.on'), false);
    h.enter(); h.status(); h.advance(0);
    const oldScan = h.pending('startScan')[0];
    h.leave(); oldScan.reply({ code: 0 });
    assert.equal(h.evaluate('wifiScanWatchdogTimer'), null);
    h.enter(); h.status({ scanning: true });
    h.advance(180000);
    const count = h.requests.length;
    h.event('scanComplete'); h.context.initWifiStatus(); h.advance(10000);
    assert.equal(h.requests.length, count + 1, 'only explicit init reads status; no scan session restart');
    assert.equal(h.evaluate('wifiScanSessionDeadline'), 0);
});

test('busy connect retry keeps password and original deadline, accepted clears it', () => {
    const h = harness();
    h.enter(); h.status();
    h.context.queueWifiConnection('test-network', 'test-only-placeholder', false);
    const deadline = h.evaluate('wifiConnectOperation.deadline');
    h.pending('connect')[0].reply({ code: 6 });
    h.advance(1000); h.status();
    const retry = h.pending('connect')[0];
    assert.equal(retry.data.password, 'test-only-placeholder');
    assert.equal(retry.data.useSaved, false);
    assert.equal(h.evaluate('wifiConnectOperation.deadline'), deadline);
    retry.reply({ code: 0 });
    assert.equal(h.evaluate('wifiConnectOperation.password'), '');
    h.context.clearWifiConnectionOperation();
    assert.equal(h.evaluate('wifiConnectOperation'), null);
});

test('busy retries stop at original deadline and cancellation clears retained secret', () => {
    const h = harness();
    h.enter(); h.status();
    h.context.queueWifiConnection('test-network', 'test-only-placeholder', false);
    const operation = h.evaluate('wifiConnectOperation');
    for (let i = 0; i < 34; i++) {
        h.pending('connect')[0].reply({ code: 6 });
        h.advance(1000); h.status();
    }
    h.pending('connect')[0].reply({ code: 6 });
    h.advance(1000);
    assert.equal(h.evaluate('wifiConnectOperation'), null);
    assert.equal(operation.password, '');
    const cancelled = harness();
    cancelled.enter(); cancelled.status();
    cancelled.context.queueWifiConnection('test-network', 'test-only-placeholder', false);
    const retained = cancelled.evaluate('wifiConnectOperation');
    cancelled.pending('connect')[0].reply({ code: 6 });
    cancelled.context.handleWifiSwitchChange(false);
    assert.equal(retained.password, '');
    cancelled.advance(1000);
    assert.equal(cancelled.requests.filter(r => r.cmd === 'connect').length, 1);
});

for (const response of [{ code: 6, msg: 'busy' }, { code: 5, localTimeout: true }]) {
    test(`disable failure restores consistent last-known UI after query exhaustion: ${response.code}`, () => {
        const h = harness();
        h.enter(); h.status({ connected: true, ssid: 'test-network', rssi: -50 });
        const before = h.evaluate('JSON.stringify(wifiStatus)');
        h.context.handleWifiSwitchChange(false);
        h.pending('setMode')[0].reply(response);
        h.advance(25000);
        assert.equal(h.evaluate('JSON.stringify(wifiStatus)'), before);
        assert.equal(h.elements.get('wifiSwitchInput').checked, true);
        assert.equal(h.elements.get('wifiNetworksContainer').style.display, 'block');
        assert(h.toasts.some(message => message.includes(response.code === 6
            ? '关闭失败' : '关闭状态待确认')));
        assert(!h.toasts.some(message => message.includes('已关闭')));
    });
}

for (const startAt of [178500, 179500]) {
    test(`connection recovery survives scan expiry before or during query: ${startAt}`, () => {
        const h = harness();
        h.enter(); h.status({ mode: 0, enabled: false, on: false });
        h.advance(startAt);
        h.context.queueWifiConnection('test-network', 'test-only-placeholder', false);
        const operation = h.evaluate('wifiConnectOperation');
        h.pending('connect')[0].reply({ code: 6 });
        for (let i = 0; i < 10; i++) h.context.recoverWifiScanBusy();
        h.advance(1000);
        assert.equal(h.pending('getStatus').length, 1);
        for (let i = 0; i < 10; i++) h.context.recoverWifiScanBusy();
        assert.equal(h.pending('getStatus').length, 1);
        if (startAt === 178500) h.advance(600);
        assert.equal(h.evaluate('wifiScanSessionDeadline'), 0);
        h.status();
        assert.equal(h.requests.filter(r => r.cmd === 'connect').length, 2);
        assert.equal(h.evaluate('wifiConnectOperation'), operation);
        assert.equal(h.pending('connect')[0].data.password, 'test-only-placeholder');
        h.pending('connect')[0].reply({ code: 6 });
        h.advance(1000); h.status({ scanning: true });
        h.advance(40000);
        const count = h.requests.length;
        assert.equal(h.evaluate('wifiConnectOperation'), null);
        assert.equal(operation.password, '');
        h.advance(10000);
        assert.equal(h.requests.length, count);
        assert.equal(h.requests.filter(r => r.cmd === 'startScan').length, 0);
    });
}

for (const queryInFlight of [false, true]) {
    test(`leaving stops connection recovery independently of scan expiry: ${queryInFlight}`, () => {
        const h = harness();
        h.enter(); h.status({ mode: 0, enabled: false, on: false });
        h.context.queueWifiConnection('test-network', 'test-only-placeholder', false);
        h.pending('connect')[0].reply({ code: 6 });
        if (queryInFlight) h.advance(1000);
        const query = h.pending('getStatus')[0];
        h.leave();
        if (query) {
            h.enter();
            query.reply({ code: 0, data: { scanning: false, connecting: false } });
            assert.equal(h.requests.filter(r => r.cmd === 'connect').length, 1);
            h.leave();
        }
        h.advance(5000);
        assert.equal(h.requests.filter(r => r.cmd === 'connect').length, 1);
        assert.equal(h.pending('getStatus').length, 0);
    });
}

test('explicit disconnected snapshot with SSID never implies IP readiness', () => {
    const h = harness();
    for (const ip of ['0.0.0.0', '', '192.0.2.8']) {
        h.context.applyWifiStatusSnapshot({ mode: 1, on: true, connected: false,
            ssid: 'test-network', ip });
        assert.equal(h.evaluate('wifiStatus.connected'), false);
    }
});

test('association without IP waits; DHCP failure remains visible on status bar', () => {
    const h = harness();
    h.enter(); h.status();
    h.context.queueWifiConnection('test-network', '', true);
    h.event('connected', { ssid: 'test-network', ip: '0.0.0.0' });
    assert.equal(h.evaluate('wifiStatus.connected'), false);
    assert.equal(h.evaluate('wifiStatus.ip'), null);
    assert(h.evaluate('wifiConnectOperation'));
    assert(h.toasts.some(text => text.includes('等待获取 IP')));
    h.event('connectFailed', { ssid: 'test-network', reason: 'DHCP timeout' });
    assert.equal(h.evaluate('wifiConnectOperation'), null);
    const start = source.indexOf('function updateWifiStatusBar(');
    h.evaluate(source.slice(start, source.indexOf('\n}', start) + 2));
    h.context.document.getElementById('wifiStatusIcon').dataset = {};
    h.elements.get('wifiStatusIcon').classList = { remove() {} };
    h.elements.get('wifiStatusIcon').setAttribute = () => {};
    h.context.updateWifiStatusBar();
    assert.equal(h.elements.get('wifiStatus').textContent, '获取 IP 地址超时');
});

test('DHCP event reconciles snapshot rather than assigning an unidentified IP', () => {
    const h = harness();
    h.enter(); h.status({ connected: true, ssid: 'test-network', ip: '0.0.0.0' });
    assert(h.evaluate('wifiStatus.waitingForIp'));
    h.event('dhcpSuccess', { ip: '192.0.2.9' });
    assert.equal(h.evaluate('wifiStatus.ip'), null);
    h.status({ connected: true, ssid: 'test-network', ip: '192.0.2.8' });
    assert(h.evaluate('wifiStatus.connected'));
    assert.equal(h.evaluate('wifiStatus.waitingForIp'), false);
    assert.equal(h.evaluate('wifiStatus.ip'), '192.0.2.8');
});
