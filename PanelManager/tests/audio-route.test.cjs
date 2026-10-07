const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = readFileSync(join(__dirname, '../wwwroot/script.js'), 'utf8');

function evaluateAudioDeclarations() {
    const start = source.indexOf("const AUDIO_SOURCE_HDMI = 'hdmi';");
    const end = source.indexOf('function audioRouteRenderSettings()', start);
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);
    const context = vm.createContext({ window: {} });
    vm.runInContext(`${source.slice(start, end)}\nthis.normalizeMic = audioMicNormalize;`, context);
    return context;
}

function audioApplyHarness() {
    const start = source.indexOf("const AUDIO_SOURCE_HDMI = 'hdmi';");
    const end = source.indexOf('function audioEqApplyDeviceData(', start);
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);
    const calls = [];
    const context = vm.createContext({
        console: { warn() {} },
        window: {},
        serialConnected: true,
        document: { getElementById() { return { value: '', dataset: {}, closest() { return null; } }; } },
        setTimeout(callback) { callback(); return 1; },
        clearTimeout() {},
        showToast() {},
        formatDeviceCommandError(error, fallback) { return error?.msg || fallback; },
    });
    vm.runInContext(source.slice(start, end), context);
    context.sendAudioCommandWithTimeout = async (cmd, data) => {
        calls.push({ cmd, data });
        if (cmd === 'getMicSource') {
            return { code: 0, data: { source: 'pcOutput', available: false } };
        }
        return { code: 0, data: {} };
    };
    vm.runInContext(`
        audioRouteState.micInput = AUDIO_MIC_PC_OUTPUT;
        this.applyMic = audioMicApplyToDevice;
    `, context);
    return { context, calls };
}

test('PC output is a stable microphone source value', () => {
    const context = evaluateAudioDeclarations();
    assert.equal(context.normalizeMic('pcOutput'), 'pcOutput');
    assert.equal(context.normalizeMic('invalid'), 'onboard');
});

test('audio settings expose the PC output recording source', () => {
    const html = readFileSync(join(__dirname, '../wwwroot/index.html'), 'utf8');
    assert.match(html, /<option value="pcOutput">PC 输出（内录）<\/option>/);
});

test('PC output sends and confirms the device microphone-source contract', async () => {
    const { context, calls } = audioApplyHarness();
    await context.applyMic(true);
    assert.equal(calls[0].cmd, 'setMicSource');
    assert.equal(calls[0].data.source, 'pcOutput');
    assert.equal(calls[1].cmd, 'getMicSource');
});

test('microphone effects hide for internal recording and restore on source change', () => {
    const { context } = audioApplyHarness();
    const dnsRow = { hidden: false };
    const aecRow = { hidden: false };
    const controls = {
        usbEffectDns: { closest() { return dnsRow; } },
        usbEffectAec: { closest() { return aecRow; } },
        audioSourceSelect: {}, audioMicRouteSelect: {}, usbEffectGain: {}, usbEffectGainValue: {},
    };
    context.document.getElementById = id => controls[id] || null;
    vm.runInContext('usbEffectsState.aecSupported = true; audioRouteRenderSettings();', context);
    assert.equal(dnsRow.hidden, true);
    assert.equal(aecRow.hidden, true);
    vm.runInContext("audioRouteApplyMicData({ source: 'headset' }); audioRouteRenderSettings();", context);
    assert.equal(dnsRow.hidden, false);
    assert.equal(aecRow.hidden, false);
    assert.equal(controls.usbEffectAec.disabled, false);
});

test('microphone switch changes persist and retain confirmed values', async () => {
    const { context } = audioApplyHarness();
    const controls = {
        usbEffectDns: { checked: true, closest() { return null; } },
        usbEffectAec: { checked: true, closest() { return null; } },
        usbEffectGain: { value: '80' }, usbEffectGainValue: {},
    };
    context.document.getElementById = id => controls[id] || null;
    vm.runInContext("audioRouteState.micInput = AUDIO_MIC_ONBOARD; usbEffectsState.aecSupported = true;", context);
    const requests = [];
    context.sendAudioCommandWithTimeout = async (cmd, data) => {
        requests.push({ cmd, data });
        return { code: 0, data: { dns: data.dns, aec: data.aec, gain: data.gain } };
    };
    await vm.runInContext('usbEffectsApply()', context);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].cmd, 'setUsbEffects');
    assert.equal(requests[0].data.dns, true);
    assert.equal(requests[0].data.aec, true);
    assert.equal(requests[0].data.persist, true);
    assert.equal(controls.usbEffectDns.checked, true);
    assert.equal(controls.usbEffectAec.checked, true);
});
