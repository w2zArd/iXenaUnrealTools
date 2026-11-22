'use strict';
// Executes the production webview JS against the generated HTML. Canvas is the only drawing stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { parseHTML } = require('linkedom');
const root = path.resolve(__dirname, '..', '..');
const locale = require(path.join(root, 'dist', 'i18n.js'));
const { WEBVIEW_TRANSLATIONS } = require(path.join(root, 'dist', 'webviewI18n.js'));
const localeSource = fs.readFileSync(path.join(root, 'resources', 'webviewI18n.js'), 'utf8');
const oldLoad = Module._load;
Module._load = function(request, parent, main) {
  if (request === 'vscode') return { Uri: { joinPath: (base, ...parts) => ({ toString: () => path.join(base.fsPath, ...parts) }) } };
  return oldLoad.call(this, request, parent, main);
};
let monitor;
try { monitor = require(path.join(root, 'dist', 'performanceMonitor.js')); }
finally { Module._load = oldLoad; }
const html = monitor.performanceMonitorHtml({ cspSource: 'https://unit.local/', asWebviewUri: uri => uri }, { fsPath: path.join(root, 'resources') });
const source = fs.readFileSync(path.join(root, 'resources', 'performanceMonitor.js'), 'utf8');

function setup(language = 'zh-CN') {
  locale.configureI18n(language);
  const localizedHtml = monitor.performanceMonitorHtml({ cspSource: 'https://unit.local/', asWebviewUri: uri => uri }, { fsPath: path.join(root, 'resources') });
  const { window, document } = parseHTML(localizedHtml);
  window.devicePixelRatio = 1;
  const messages = [], charts = new Map();
  let theme = 'dark';
  for (const canvas of document.querySelectorAll('canvas')) {
    let currentPath = [];
    const strokes = [];
    const context = {
      scale() {}, beginPath() { currentPath = []; },
      moveTo(x, y) { assert.ok(Number.isFinite(x) && Number.isFinite(y)); currentPath.push(['move', x, y]); },
      lineTo(x, y) { assert.ok(Number.isFinite(x) && Number.isFinite(y)); currentPath.push(['line', x, y]); },
      stroke() { strokes.push({ path: currentPath.slice(), color: context.strokeStyle }); }, fillText() {}
    };
    Object.defineProperty(canvas, 'clientWidth', { configurable: true, value: 500 });
    canvas.getContext = type => type === '2d' ? context : null;
    charts.set(canvas.id, { canvas, context, strokes });
  }
  const context = vm.createContext({ window, document, console,
    MutationObserver: window.MutationObserver,
    getComputedStyle: () => ({ getPropertyValue: name => `${theme}:${name}` }),
    acquireVsCodeApi: () => ({ postMessage: value => messages.push(value) })
  });
  vm.runInContext(localeSource, context, { filename: 'webviewI18n.js' });
  vm.runInContext(source, context, { filename: 'performanceMonitor.js' });
  assert.equal(messages.shift().type, 'ready');
  function event(target, type, data) {
    const e = new window.Event(type, { bubbles: true }); if (data !== undefined) e.data = data; target.dispatchEvent(e);
  }
  return { window, document, messages, charts, event,
    send: value => event(window, 'message', value),
    click: id => event(document.getElementById(id), 'click'),
    text: id => document.getElementById(id).textContent,
    setTheme: value => { theme = value; document.documentElement.setAttribute('class', `vscode-${value}`); }
  };
}
const sample = (offset = 0, values = {}) => ({ protocol: 1, instanceId: 'fixture', processId: 42,
  updatedAt: new Date(1700000000000 + offset).toISOString(), cpuTimePct: 25, cpuTimePctRelative: 300,
  processMemoryBytes: 500 * 1048576, peakProcessMemoryBytes: 600 * 1048576, availablePhysicalBytes: 4000 * 1048576,
  frameDeltaMs: 16.67, debuggerAttached: true, ...values });
const state = (values = {}) => ({ type: 'state', projectPath: '/Game/Demo.uproject', processId: 42,
  engineVersion: '5.9.0', paused: false, stale: false, samples: [sample(), sample(1000)], ...values });

test('performance webview renders actual CPU/memory/frame samples and draws all three graphs', () => {
  const h = setup(); h.send(state());
  assert.equal(h.text('cpu'), '25.0%');
  assert.match(h.text('cpu-relative'), /300\.0%/);
  assert.equal(h.text('memory'), '500.0');
  assert.equal(h.text('frame'), '16.67 ms');
  assert.match(h.text('debugger'), /已附加/);
  assert.match(h.text('sample-time'), /2 \/ 120/);
  for (const chart of h.charts.values()) {
    assert.equal(chart.canvas.width, 500); assert.equal(chart.canvas.height, 170);
    assert.deepEqual(chart.strokes.at(-1).path.map(point => point[0]), ['move', 'line']);
  }
});

test('stale samples freeze the displayed last reading without inventing zeros or extra points', () => {
  const h = setup(); h.send(state());
  const cpu = h.text('cpu'), memory = h.text('memory');
  h.send(state({ stale: true }));
  assert.match(h.text('state'), /冻结/);
  assert.match(h.text('notice'), /最后一次数据/);
  assert.equal(h.text('cpu'), cpu); assert.equal(h.text('memory'), memory);
  assert.match(h.text('sample-time'), /2 \/ 120/);
  assert.equal(h.charts.get('cpu-chart').strokes.at(-1).path.length, 2);
});

test('unknown CPU stays an em dash and timeline gaps break paths instead of bridging unsampled time', () => {
  const h = setup();
  h.send(state({ samples: [sample(0, { cpuTimePct: undefined, cpuTimePctRelative: undefined })] }));
  assert.equal(h.text('cpu'), '—'); assert.match(h.text('cpu-relative'), /—/);
  assert.deepEqual(h.charts.get('cpu-chart').strokes.at(-1).path, []);
  h.send(state({ samples: [sample(), sample(6000)] }));
  assert.deepEqual(h.charts.get('cpu-chart').strokes.at(-1).path.map(point => point[0]), ['move', 'move']);
});

test('pause/refresh/Insights buttons send only their intended host messages and acknowledge pause state', () => {
  const h = setup(); h.send(state());
  h.click('pause'); h.click('refresh'); h.click('insights');
  assert.deepEqual(h.messages.map(message => message.type), ['pause', 'refresh', 'insights']);
  h.send(state({ paused: true }));
  assert.equal(h.text('pause'), '继续采样'); assert.equal(h.text('state'), '已暂停采样');
  assert.equal(h.text('cpu'), '25.0%');
});

test('runtime project and error strings are rendered as plain text, not HTML or scripts', () => {
  const h = setup();
  const attack = '<img src=x onerror=alert(1)>';
  h.send(state({ projectPath: attack, error: '<script>alert(1)</script>' }));
  assert.equal(h.text('project'), attack);
  assert.equal(h.text('notice'), '<script>alert(1)</script>');
  assert.equal(h.document.querySelectorAll('img').length, 0);
  assert.equal(h.document.querySelectorAll('script').length, 2, 'Only the two bundled CSP-protected scripts exist');
});

test('theme changes repaint graphs using new VSCode color tokens', async () => {
  const h = setup(); h.send(state());
  assert.match(h.charts.get('cpu-chart').strokes.at(-1).color, /^dark:/);
  h.setTheme('light'); await new Promise(resolve => setImmediate(resolve));
  assert.match(h.charts.get('cpu-chart').strokes.at(-1).color, /^light:/);
  assert.equal(h.text('cpu'), '25.0%');
});

test('English performance UI updates labels and language switches preserve current readings and sample history', () => {
  const h = setup('en'); h.send(state({ projectPath: '/Game/已保存.uproject' }));
  assert.equal(h.document.documentElement.lang,'en');
  assert.equal(h.text('pause'),'Pause sampling');
  assert.equal(h.text('state'),'Sampling live');
  assert.equal(h.text('debugger'),'Debugger: Attached');
  assert.equal(h.text('project'),'/Game/已保存.uproject');
  const readings = [h.text('cpu'),h.text('memory'),h.text('frame')];
  h.send({ type:'language',language:'zh-CN',messages:WEBVIEW_TRANSLATIONS });
  assert.equal(h.text('pause'),'暂停采样');
  assert.deepEqual([h.text('cpu'),h.text('memory'),h.text('frame')],readings);
  assert.match(h.text('sample-time'),/2 \/ 120/);
  assert.equal(h.messages.length,0);
  locale.configureI18n('zh-CN');
});
