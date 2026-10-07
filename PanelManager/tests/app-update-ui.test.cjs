const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../wwwroot/ui_app_update.js'), 'utf8');

function setup() {
    const nodes = Object.fromEntries(['appUpdateDialog', 'appUpdateVersion', 'appUpdateNotes', 'appUpdateMessage',
        'appUpdateProgress', 'appUpdateConfirm', 'appUpdateCancel', 'hostAppVersion'].map(id => [id, {
        id, textContent: '', open: false, hidden: false, disabled: false, value: 0, listeners: {},
        addEventListener(event, callback) { this.listeners[event] = callback; },
        showModal() { this.open = true; }, close() { this.open = false; },
        getClientRects() { return this.open ? [1] : []; }
    }]));
    const other = { id: 'modal', open: false, getClientRects() { return this.open ? [1] : []; } };
    const requests = [];
    const timers = new Map();
    let timerId = 0;
    const document = {
        hidden: false, getElementById: id => nodes[id], querySelectorAll: () => [nodes.appUpdateDialog, other],
        addEventListener() {}
    };
    const window = { addEventListener() {} };
    const context = vm.createContext({ window, document, wsConnected: false,
        getComputedStyle: node => ({ display: 'block', visibility: node.visibility || 'visible' }),
        setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
        clearTimeout: id => timers.delete(id),
        sendMessageWithTimeout: (module, cmd, data, timeout, callback) => requests.push({ module, cmd, data, timeout, callback })
    });
    vm.runInContext(source, context);
    return { nodes, other, requests, timers, document, context, handle: window.AppUpdateUI.handle,
        click: id => nodes[id].listeners.click(),
        runPrompt: () => {
            const entry = Array.from(timers).find(([, timer]) => timer.delay === 1000);
            assert.ok(entry);
            timers.delete(entry[0]); entry[1].callback();
        } };
}

function state(status, revision = 1, extra = {}) {
    return { status, revision, currentVersion: '1.1.4', latestVersion: 'v1.1.5',
        notes: '改进与修复', message: '发现新版', percent: 0, canInstall: status === 'available', ...extra };
}

test('检查失败或没有新版时不弹窗，发现新版才提示', () => {
    const { handle, nodes, requests } = setup();
    for (const [index, status] of ['checking', 'checkFailed', 'current'].entries()) handle(state(status, index));
    assert.equal(nodes.appUpdateDialog.open, false);
    handle(state('available', 4));
    assert.equal(nodes.appUpdateDialog.open, true);
    assert.match(nodes.appUpdateVersion.textContent, /1\.1\.4.*v1\.1\.5/);
    assert.equal(requests.length, 0);
});

test('确认只发送一次版本确认，不接受客户端路径或 URL', () => {
    const { handle, click, requests, nodes } = setup();
    handle(state('available'));
    click('appUpdateConfirm'); click('appUpdateConfirm');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].module, 'system');
    assert.equal(requests[0].cmd, 'appUpdateInstall');
    assert.deepEqual(JSON.parse(JSON.stringify(requests[0].data)), { version: 'v1.1.5' });
    assert.equal(nodes.appUpdateConfirm.disabled, true);
});

test('稍后再说通知宿主，本次会话不重复提醒同一版本', () => {
    const { handle, click, requests, nodes } = setup();
    handle(state('available'));
    click('appUpdateCancel');
    assert.equal(nodes.appUpdateDialog.open, false);
    assert.equal(requests[0].cmd, 'appUpdateDismiss');
    handle(state('available', 2));
    assert.equal(nodes.appUpdateDialog.open, false);
});

test('旧状态响应不能覆盖下载进度，重复确认不重复启动', () => {
    const { handle, click, nodes, requests } = setup();
    handle(state('available', 1));
    click('appUpdateConfirm');
    handle(state('downloading', 3, { percent: 53, message: '正在下载', canInstall: false }));
    handle(state('available', 2));
    assert.equal(nodes.appUpdateProgress.value, 53);
    assert.equal(nodes.appUpdateConfirm.disabled, true);
    click('appUpdateConfirm');
    assert.equal(requests.length, 1);
});

test('下载取消必须由宿主确认，不能只关弹窗留下后台安装', () => {
    const { handle, click, nodes, requests } = setup();
    handle(state('downloading', 2));
    click('appUpdateCancel');
    assert.equal(nodes.appUpdateDialog.open, true);
    assert.equal(requests[0].cmd, 'appUpdateDismiss');
    requests[0].callback({ code: 0, data: state('dismissed', 3) });
    assert.equal(nodes.appUpdateDialog.open, false);
});

test('安装器启动交接中禁止重复操作和 Escape 取消', () => {
    const { handle, click, nodes, requests } = setup();
    handle(state('starting', 5, { percent: 100 }));
    click('appUpdateConfirm'); click('appUpdateCancel');
    let prevented = false;
    nodes.appUpdateDialog.listeners.cancel({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(requests.length, 0);
    assert.equal(nodes.appUpdateDialog.open, true);
});

test('现有弹窗或后台窗口未结束时推迟提示，只保留一个等待定时器', () => {
    const { handle, other, document, runPrompt, timers, nodes } = setup();
    other.open = true;
    handle(state('available'));
    handle(state('available', 2));
    assert.equal(timers.size, 1);
    assert.equal(nodes.appUpdateDialog.open, false);
    other.open = false; document.hidden = true;
    runPrompt();
    assert.equal(nodes.appUpdateDialog.open, false);
    document.hidden = false; runPrompt();
    assert.equal(nodes.appUpdateDialog.open, true);
});

test('Release 说明只按纯文本显示，下载失败可显式重试', () => {
    const { handle, nodes, click, requests } = setup();
    handle(state('error', 2, { notes: '<img src=x onerror=alert(1)>', canInstall: true, message: '校验失败' }));
    assert.equal(nodes.appUpdateNotes.textContent, '<img src=x onerror=alert(1)>');
    assert.equal(nodes.appUpdateNotes.innerHTML, undefined);
    assert.equal(nodes.appUpdateConfirm.textContent, '重试更新');
    click('appUpdateConfirm');
    assert.equal(requests[0].cmd, 'appUpdateInstall');
});

test('常驻 display:flex 但 visibility:hidden 的旧弹窗不阻止软件更新提示', () => {
    const { handle, other, nodes } = setup();
    other.open = true;
    other.visibility = 'hidden';
    handle(state('available'));
    assert.equal(nodes.appUpdateDialog.open, true);
});

test('安装器已启动但未确认就绪时不给出重复启动按钮', () => {
    const { handle, nodes, click, requests } = setup();
    handle(state('error', 10, { canInstall: false, message: '安装程序未确认就绪' }));
    assert.equal(nodes.appUpdateConfirm.hidden, true);
    click('appUpdateConfirm');
    assert.equal(requests.length, 0);
    assert.equal(nodes.appUpdateCancel.disabled, false);
});
