'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const Module = require('node:module');

function load() {
  const panels = [], messages = [];
  class Uri {
    constructor(file) { this.fsPath = file; }
    toString() { return `resource:${this.fsPath}`; }
    static file(file) { return new Uri(file); }
    static joinPath(uri, ...parts) { return new Uri(path.join(uri.fsPath, ...parts)); }
  }
  const fake = { Uri, ViewColumn: { Beside: 2 }, commands: { executeCommand: async () => {} },
    window: { showWarningMessage: async () => {}, createWebviewPanel: (_type, _title, _column, options) => {
      const panel = { visible: true, options, webview: { cspSource: 'test-resource:', asWebviewUri: uri => uri,
        onDidReceiveMessage: fn => { panel.receive = fn; return { dispose() {} }; },
        postMessage: async value => { messages.push(value); return true; } },
        onDidChangeViewState: fn => { panel.view = fn; return { dispose() {} }; },
        onDidDispose: fn => { panel.close = fn; return { dispose() {} }; },
        dispose: () => panel.close(), reveal() {} };
      panels.push(panel); return panel;
    } } };
  const file = path.resolve(__dirname, '../dist/performanceMonitor.js'); delete require.cache[file];
  const old = Module._load;
  Module._load = function(request, parent, main) { if (request === 'vscode') return fake; return old.call(this, request, parent, main); };
  let api; try { api = require(file); } finally { Module._load = old; }
  return { ...api, panels, messages, Uri };
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ixena-metrics-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const instanceId = `123-${randomUUID()}`;
  const projectPath = path.join(root, 'Demo.uproject');
  const directory = path.join(root, 'Saved', 'iXenaUnrealBridge', 'instances', instanceId);
  await fs.mkdir(directory, { recursive: true });
  const instance = { instanceId, processId: 123, projectPath, directory, engineRoot: '/engine', engineVersion: '5.9.0' };
  const sample = { protocol: 1, instanceId, processId: 123, updatedAt: new Date().toISOString(),
    processMemoryBytes: 1024 * 1024 * 500, peakProcessMemoryBytes: 1024 * 1024 * 600,
    availablePhysicalBytes: 1024 * 1024 * 4000, cpuTimePct: 25, cpuTimePctRelative: 300, frameDeltaMs: 16.67, debuggerAttached: true };
  const file = path.join(directory, 'metrics.json'); await fs.writeFile(file, JSON.stringify(sample));
  return { instance, sample, file, root };
}

test('performance metrics retain both CPU normalizations and missing CPU is unknown rather than zero', async t => {
  const h = load(), f = await fixture(t);
  const parsed = await h.readPerformanceSample(f.instance);
  assert.equal(parsed.cpuTimePct, 25); assert.equal(parsed.cpuTimePctRelative, 300);
  const { cpuTimePct, cpuTimePctRelative, ...withoutCpu } = f.sample;
  assert.equal(h.parsePerformanceSample(withoutCpu, f.instance).cpuTimePct, undefined);
  h.disposePerformanceMonitor();
});

test('performance metrics reject mismatched identity, invalid values and future timestamps', async t => {
  const h = load(), f = await fixture(t);
  for (const edit of [{ instanceId: 'other' }, { processId: 999 }, { cpuTimePct: NaN }, { processMemoryBytes: -1 },
    { frameDeltaMs: Infinity }, { updatedAt: new Date(Date.now() + 60000).toISOString() }]) {
    assert.throws(() => h.parsePerformanceSample({ ...f.sample, ...edit }, f.instance));
  }
  const old = { ...f.sample, updatedAt: new Date(Date.now() - 4000).toISOString() };
  assert.equal(h.isPerformanceSampleStale(old), true);
  assert.equal(h.isPerformanceSampleStale(f.sample), false);
});

test('metrics readers reject oversized files and directories outside the selected project', async t => {
  const h = load(), f = await fixture(t);
  await fs.writeFile(f.file, ' '.repeat(33000));
  await assert.rejects(h.readPerformanceSample(f.instance), /大小/);
  await assert.rejects(h.readPerformanceSample({ ...f.instance, directory: f.root }), /不属于/);
  await assert.rejects(h.readPerformanceSample({ ...f.instance, instanceId: '../outside' }), /标识无效/);
});

test('history is bounded at 120 unique timestamped samples; repeated stale values do not create fake points', async t => {
  const h = load(), f = await fixture(t); let history = [];
  const start = Date.now() - 200000;
  for (let i = 0; i < 130; i++) history = h.appendPerformanceSample(history, { ...f.sample, updatedAt: new Date(start + i * 1000).toISOString() });
  assert.equal(history.length, 120);
  assert.equal(h.appendPerformanceSample(history, history.at(-1)).length, 120);
  assert.equal(h.appendPerformanceSample(history, history[0]).at(-1).updatedAt, history.at(-1).updatedAt);
});

test('monitor uses restrictive CSP and pauses its timer when hidden, then clears resources on disposal', async t => {
  const h = load(), f = await fixture(t);
  const timers = new Set(); let timerId = 0;
  const oldSet = global.setInterval, oldClear = global.clearInterval;
  global.setInterval = callback => { const timer = { id: ++timerId, callback }; timers.add(timer); return timer; };
  global.clearInterval = timer => { timers.delete(timer); };
  try {
    await h.showPerformanceMonitor(f.instance);
    const panel = h.panels[0];
    assert.match(panel.webview.html, /default-src 'none'/);
    assert.match(panel.webview.html, /script-src 'nonce-/);
    assert.equal(panel.options.retainContextWhenHidden, false);
    assert.equal(timers.size, 1);
    panel.visible = false; panel.view({ webviewPanel: panel }); assert.equal(timers.size, 0);
    panel.visible = true; panel.view({ webviewPanel: panel }); assert.equal(timers.size, 1);
    panel.receive({ type: 'pause' });
    assert.equal(h.messages.at(-1).paused, true);
    panel.dispose(); assert.equal(timers.size, 0);
  } finally { h.disposePerformanceMonitor(); global.setInterval = oldSet; global.clearInterval = oldClear; }
});
