const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');

const html = readFileSync(join(__dirname, '../wwwroot/index.html'), 'utf8');
const script = readFileSync(join(__dirname, '../wwwroot/script.js'), 'utf8');

test('audio settings expose wired microphone controls', () => {
    assert.match(html, /id="settings-audio"/);
    assert.match(html, /id="usbEffectDns"/);
    assert.match(html, /id="usbEffectAec"/);
    assert.match(html, /音频降噪/);
    assert.doesNotMatch(html, /需 8\/16 kHz 单声道录音/);
    assert.match(html, /id="usbEffectGain"/);
    assert.match(html, /onchange="usbEffectsApply\(\)"/);
    assert.doesNotMatch(html, /usb-effects-desktop-page|保存麦克风设置/);
    assert.equal((html.match(/class="indicator/g) || []).length, 2);
});

test('audio settings use the USB microphone control protocol', () => {
    assert.match(script, /sendAudioCommandWithTimeout\('getUsbEffects'/);
    assert.match(script, /sendAudioCommandWithTimeout\('setUsbEffects'/);
    assert.match(script, /window\.usbEffectsApply/);
    assert.match(script, /targetId === 'settings-audio'/);
});
