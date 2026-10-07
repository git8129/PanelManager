const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../wwwroot/script.js'), 'utf8');
const start = script.indexOf("const TEMPERATURE_SOURCE_STORAGE_KEY = 'temperatureSource';");
const end = script.indexOf('function updatePerformanceDetailPage(data) {', start);
assert.ok(start >= 0 && end > start);

function setup({ saved = null, storageFails = false } = {}) {
    const elements = Object.fromEntries(['temperatureHint', 'miniTempValue', 'miniCpuValue', 'miniMemValue',
        'miniTemperatureLabel', 'temperatureSourceLabel']
        .map(id => [id, { textContent: '', hidden: true, title: '' }]));
    elements.temperatureSourceSelect = {
        value: '', dataset: {}, options: [], rebuilds: 0,
        replaceChildren(...options) { this.options = options; this.rebuilds++; }
    };
    const charts = [];
    const details = [];
    const storage = new Map(saved ? [['temperatureSource', saved]] : []);
    const monitorData = { cpu: [10], temperature: [50, 52] };
    const chartAnimations = { tempChart: { from: 50, to: 52 } };
    const context = vm.createContext({
        document: { getElementById: id => elements[id], createElement: () => ({ textContent: '', value: '' }) },
        localStorage: {
            getItem(key) { if (storageFails) throw new Error('denied'); return storage.get(key) || null; },
            setItem(key, value) { if (storageFails) throw new Error('denied'); storage.set(key, value); }
        },
        monitorData,
        chartAnimations,
        drawMiniChart: (id, value) => charts.push([id, value]),
        updateNetworkSpeedBar() {},
        updatePerformanceDetailPage(data) { details.push(data); }
        // 不提供 alert/toast；非侵入性提示不能触发弹窗。
    });
    vm.runInContext(script.slice(start, end), context);
    return { elements, charts, details, storage, monitorData, chartAnimations,
        update: data => context.updatePerformanceDisplay(data),
        select: id => context.changeTemperatureSource(id) };
}

test('兼容模式显示原因，其他性能数据仍正常刷新', () => {
    const { elements, update } = setup();
    update({ cpu: 23, memory: { used: 8.5, percent: 50 }, temperature: 0,
        temperatureHint: '兼容模式：未获得管理员权限，CPU 温度不可用；其他功能可继续使用。' });
    assert.equal(elements.miniTempValue.textContent, 'N/A');
    assert.match(elements.temperatureHint.textContent, /兼容模式/);
    assert.equal(elements.temperatureHint.hidden, false);
    assert.equal(elements.miniTempValue.title, elements.temperatureHint.textContent);
    assert.equal(elements.miniCpuValue.textContent, '23%');
    assert.equal(elements.miniMemValue.textContent, '8.5 GB');
});

test('恢复有效采样后自动隐藏提示并显示实测温度', () => {
    const { elements, update } = setup();
    update({ cpu: 0, temperature: 0, temperatureHint: '驱动不可用' });
    update({ cpu: 1, temperature: 58.2, temperatureHint: '旧提示' });
    assert.equal(elements.miniTempValue.textContent, '58°C');
    assert.equal(elements.temperatureHint.hidden, true);
    assert.equal(elements.temperatureHint.textContent, '');
    assert.equal(elements.miniTempValue.title, '');
});

test('旧宿主缺少新增提示字段时仍能降级显示', () => {
    const { elements, update } = setup();
    update({ cpu: 1, temperature: 0 });
    assert.equal(elements.miniTempValue.textContent, 'N/A');
    assert.equal(elements.temperatureHint.textContent, '暂未读取到有效 CPU 温度');
});

test('提示按纯文本处理，兼容没有提示元素的旧页面', () => {
    const { elements, update } = setup();
    update({ cpu: 1, temperature: 0, temperatureHint: '<img src=x onerror=alert(1)>' });
    assert.equal(elements.temperatureHint.textContent, '<img src=x onerror=alert(1)>');
    assert.equal(elements.temperatureHint.innerHTML, undefined);
    delete elements.temperatureHint;
    assert.doesNotThrow(() => update({ cpu: 1, temperature: 0 }));
});

const cpu = { id: '/cpu/0/temperature/0', kind: 'CPU', hardware: 'Processor', name: 'Package', value: 60 };
const gpu = { id: '/gpu/0/temperature/0', kind: 'GPU', hardware: 'Graphics', name: 'Core', value: 42.5 };
const stats = { cpu: 12, temperature: 60, temperatureSensors: [cpu, gpu] };

test('选择 GPU 后首页和详情使用同一值，保留原始快照并清除旧来源历史', () => {
    const { elements, update, select, details, monitorData, chartAnimations, storage } = setup();
    update(stats);
    select(gpu.id);
    assert.equal(elements.miniTempValue.textContent, '43°C');
    assert.equal(elements.miniTemperatureLabel.textContent, '🌡️ GPU');
    assert.equal(details.at(-1).temperature, 42.5);
    assert.equal(elements.temperatureSourceSelect.value, gpu.id);
    assert.equal(JSON.parse(storage.get('temperatureSource')).id, gpu.id);
    assert.deepEqual(monitorData.temperature, []);
    assert.deepEqual(monitorData.cpu, [10]);
    assert.equal(chartAnimations.tempChart, undefined);
    assert.equal(stats.temperature, 60);
    select('');
    assert.equal(elements.miniTempValue.textContent, '60°C');
    assert.equal(details.at(-1).temperature, 60);
});

test('重载后恢复选择，来源消失时不回退 CPU，重新出现后自动恢复', () => {
    const { elements, update, details } = setup({ saved: JSON.stringify({ id: gpu.id, label: 'GPU · Graphics · Core' }) });
    update({ cpu: 10, temperature: 60, temperatureSensors: [cpu] });
    assert.equal(elements.miniTempValue.textContent, 'N/A');
    assert.equal(details.at(-1).temperature, 0);
    assert.match(elements.temperatureHint.textContent, /所选温度传感器暂不可用/);
    assert.equal(elements.temperatureSourceSelect.value, gpu.id);
    assert.match(elements.temperatureSourceSelect.options.at(-1).textContent, /暂不可用/);
    update(stats);
    assert.equal(elements.miniTempValue.textContent, '43°C');
    assert.equal(elements.temperatureHint.hidden, true);
});

test('已选传感器无效读数不借用默认 CPU 温度', () => {
    const { elements, update, select } = setup();
    update(stats);
    select(gpu.id);
    for (const value of [null, undefined, NaN, Infinity, 0, -5, 150, '42']) {
        update({ ...stats, temperatureSensors: [cpu, { ...gpu, value }] });
        assert.equal(elements.miniTempValue.textContent, 'N/A');
        assert.equal(elements.temperatureHint.hidden, false);
    }
});

test('传感器数值刷新不重建下拉框，稳定 ID 区分同名传感器', () => {
    const { elements, update, select } = setup();
    const otherGpu = { ...gpu, id: '/gpu/1/temperature/0', value: 70 };
    update({ ...stats, temperatureSensors: [gpu, otherGpu] });
    const count = elements.temperatureSourceSelect.rebuilds;
    update({ ...stats, temperatureSensors: [{ ...gpu, value: 44 }, otherGpu] });
    assert.equal(elements.temperatureSourceSelect.rebuilds, count);
    select(otherGpu.id);
    assert.equal(elements.miniTempValue.textContent, '70°C');
});

test('存储损坏或禁止访问时仍可选择，传感器名称只作为文本', () => {
    for (const options of [{ saved: '{broken' }, { storageFails: true }]) {
        const { elements, update, select } = setup(options);
        const unusual = { ...gpu, name: '<img src=x onerror=alert(1)>' };
        update({ ...stats, temperatureSensors: [unusual] });
        select(gpu.id);
        assert.equal(elements.miniTempValue.textContent, '43°C');
        assert.match(elements.temperatureSourceSelect.options[1].textContent, /<img/);
        assert.equal(elements.temperatureSourceSelect.options[1].innerHTML, undefined);
    }
});

test('保存了特定传感器时，旧宿主不提供列表也不能悄悄切换来源', () => {
    const { elements, update, select } = setup({ saved: JSON.stringify({ id: gpu.id, label: 'GPU' }) });
    update({ cpu: 10, temperature: 60 });
    assert.equal(elements.miniTempValue.textContent, 'N/A');
    select('');
    assert.equal(elements.miniTempValue.textContent, '60°C');
});
