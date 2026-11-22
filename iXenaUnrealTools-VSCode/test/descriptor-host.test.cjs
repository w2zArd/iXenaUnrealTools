'use strict';

// 此文件使用真实 DescriptorEditorProvider、模拟 VS Code 文档/事件；真实 Host 测试见 test/host。
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

function event() {
  const listeners = new Set();
  return {
    subscribe(callback) { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; },
    fire(value) { for (const callback of [...listeners]) callback(value); },
    size() { return listeners.size; }
  };
}

function harness(initial, filename = 'PlanetWorld.uplugin') {
  const changed = event();
  const saved = event();
  const closed = event();
  const applied = [];
  const commands = [];
  const notices = [];
  let disk = initial;
  const uri = value => ({ scheme: 'file', fsPath: value, path: value,
    toString: () => `file://${value}`, with: () => uri(value) });
  const document = {
    uri: uri(path.join('/project/Plugins/PlanetWorld', filename)), version: 1,
    isDirty: false, isClosed: false, eol: 1,
    getText(range) { return range ? document.text.slice(document.offsetAt(range.start), document.offsetAt(range.end)) : document.text; },
    text: initial,
    positionAt(offset) {
      const parts = document.text.slice(0, offset).split('\n');
      return { line: parts.length - 1, character: parts[parts.length - 1].length };
    },
    offsetAt(position) {
      const lines = document.text.split('\n');
      return lines.slice(0, position.line).reduce((total, line) => total + line.length + 1, 0) + position.character;
    },
    async save() { disk = document.text; document.isDirty = false; saved.fire(document); return true; }
  };
  const fake = {
    Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    Position: class Position { constructor(line, character) { this.line = line; this.character = character; } },
    Range: class Range { constructor(start, end) { this.start = start; this.end = end; } },
    WorkspaceEdit: class WorkspaceEdit {
      constructor() { this.edits = []; }
      replace(target, range, text) { this.edits.push({ uri: target, range, text }); }
      set(target, edits) { this.edits.push(...edits.map(value => ({ uri: target, range: value.range, text: value.newText }))); }
    },
    EndOfLine: { LF: 1, CRLF: 2 },
    ViewColumn: { Active: -1, Beside: -2 },
    workspace: {
      isTrusted: true,
      textDocuments: [document],
      getConfiguration: () => ({ get: (_name, fallback) => fallback }),
      onDidChangeTextDocument: callback => changed.subscribe(callback),
      onDidSaveTextDocument: callback => saved.subscribe(callback),
      onDidCloseTextDocument: callback => closed.subscribe(callback),
      openTextDocument: async () => document,
      applyEdit: async edit => {
        const replacements = edit.edits.map(entry => ({
          start: document.offsetAt(entry.range.start), end: document.offsetAt(entry.range.end), text: entry.text
        })).sort((a, b) => b.start - a.start);
        for (const value of replacements) {
          document.text = document.text.slice(0, value.start) + value.text + document.text.slice(value.end);
        }
        applied.push(edit);
        document.version += 1;
        document.isDirty = true;
        changed.fire({ document, contentChanges: [{}] });
        return true;
      }
    },
    window: {
      showWarningMessage: async (...args) => { notices.push(args); },
      showErrorMessage: async (...args) => { notices.push(args); },
      showTextDocument: async (...args) => { commands.push(['showTextDocument', ...args]); },
      activeTextEditor: undefined
    },
    commands: { executeCommand: async (...args) => { commands.push(args); } }
  };
  const moduleFile = path.join(__dirname, '..', 'dist', 'descriptorEditor.js');
  delete require.cache[moduleFile];
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    return request === 'vscode' ? fake : originalLoad.call(this, request, parent, isMain);
  };
  let loaded;
  try { loaded = require(moduleFile); }
  finally { Module._load = originalLoad; }
  const context = {
    extensionUri: uri(path.resolve(__dirname, '..')), subscriptions: [],
    asAbsolutePath: file => path.resolve(__dirname, '..', file)
  };
  const output = [];
  const provider = new loaded.DescriptorEditorProvider(context, message => output.push(message));
  async function panel() {
    const messages = [];
    const received = event();
    const disposed = event();
    let receive;
    const view = {
      webview: {
        html: '', options: {}, cspSource: 'https://unit-test.vscode-resource/',
        asWebviewUri: value => value,
        postMessage: async value => { messages.push(value); return true; },
        onDidReceiveMessage: callback => { receive = callback; return received.subscribe(callback); }
      },
      onDidDispose: callback => disposed.subscribe(callback),
      dispose: () => disposed.fire(), visible: true
    };
    await provider.resolveCustomTextEditor(document, view, { isCancellationRequested: false });
    return { view, messages, send: async value => {
      assert.equal(typeof receive, 'function', 'Provider installed its message listener');
      await receive(value);
      // The provider may enqueue operations; allow that queue and postMessage to settle.
      await new Promise(resolve => setImmediate(resolve));
    }, state: () => messages.filter(item => item.type === 'state').at(-1) };
  }
  return { provider, document, applied, commands, notices, panel, output,
    disk: () => disk,
    external: value => { document.text = value; document.version += 1; document.isDirty = true; changed.fire({ document, contentChanges: [{}] }); },
    listeners: () => changed.size() + saved.size() + closed.size()
  };
}

function plugin() {
  return JSON.stringify({ FileVersion: 3, Version: 1, FriendlyName: '星球插件 🌍',
    CustomVendorSettings: { exact: [1, '中文'] },
    Modules: [{ Name: 'PlanetWorld', Type: 'Runtime', LoadingPhase: 'Default', VendorFlag: 'keep', WhitelistPlatforms: ['Win64'] }],
    Plugins: [{ Name: 'ProceduralMeshComponent', Enabled: true, VendorFlag: 17 }]
  }, null, 2) + '\n';
}

test('descriptor provider: ready state and CSP-backed webview do not dirty the document', async () => {
  const h = harness(plugin());
  const p = await h.panel();
  await p.send({ type: 'ready' });
  assert.equal(p.state().kind, 'uplugin');
  assert.equal(p.state().valid, true);
  assert.equal(p.state().version, 1);
  assert.equal(h.document.text, plugin());
  assert.equal(h.document.isDirty, false);
  assert.equal(h.applied.length, 0);
  assert.match(p.view.webview.html, /Content-Security-Policy/);
  assert.match(p.view.webview.html, /nonce-/);
});

test('descriptor provider: field edits remain unsaved until Save and preserve all unrelated fields', async () => {
  const original = plugin();
  const h = harness(original);
  const p = await h.panel();
  await p.send({ type: 'ready' });
  await p.send({ type: 'edit', requestId: 'name', version: h.document.version,
    operation: { type: 'set', path: ['FriendlyName'], value: '行星世界新版' } });
  assert.equal(JSON.parse(h.document.text).FriendlyName, '行星世界新版');
  assert.deepEqual(JSON.parse(h.document.text).CustomVendorSettings, JSON.parse(original).CustomVendorSettings);
  assert.deepEqual(JSON.parse(h.document.text).Modules, JSON.parse(original).Modules);
  assert.equal(h.document.isDirty, true);
  assert.equal(h.disk(), original);
  assert.ok(p.messages.some(item => item.type === 'state' && item.reason === 'applied' && item.requestId === 'name'));
  await p.send({ type: 'save' });
  assert.equal(h.disk(), h.document.text);
  assert.equal(h.document.isDirty, false);
});

test('descriptor provider: table edits preserve unknown row fields and legacy platform keys', async () => {
  const h = harness(plugin());
  const p = await h.panel();
  await p.send({ type: 'ready' });
  await p.send({ type: 'edit', requestId: 'phase', version: h.document.version,
    operation: { type: 'set', path: ['Modules', 0, 'LoadingPhase'], value: 'PostEngineInit' } });
  let data = JSON.parse(h.document.text);
  assert.equal(data.Modules[0].LoadingPhase, 'PostEngineInit');
  assert.equal(data.Modules[0].VendorFlag, 'keep');
  assert.deepEqual(data.Modules[0].WhitelistPlatforms, ['Win64']);
  assert.equal('PlatformAllowList' in data.Modules[0], false);
  await p.send({ type: 'edit', requestId: 'disable', version: h.document.version,
    operation: { type: 'set', path: ['Plugins', 0, 'Enabled'], value: false } });
  data = JSON.parse(h.document.text);
  assert.equal(data.Plugins[0].Enabled, false);
  assert.equal(data.Plugins[0].VendorFlag, 17);
});

test('descriptor provider: two views share updates, stale versions cannot overwrite newer changes', async () => {
  const h = harness(plugin());
  const a = await h.panel();
  const b = await h.panel();
  await a.send({ type: 'ready' });
  await b.send({ type: 'ready' });
  await a.send({ type: 'edit', requestId: 'a', version: 1,
    operation: { type: 'set', path: ['FriendlyName'], value: 'A 已提交' } });
  assert.equal(b.state().data.FriendlyName, 'A 已提交');
  const after = h.document.text;
  await b.send({ type: 'edit', requestId: 'b', version: 1,
    operation: { type: 'set', path: ['FriendlyName'], value: 'B 陈旧修改' } });
  assert.equal(h.document.text, after);
  assert.ok(b.messages.some(item => item.type === 'error' && item.requestId === 'b' && item.conflict === true));
});

test('descriptor provider: external edits synchronize and invalidate an old form operation', async () => {
  const h = harness(plugin());
  const p = await h.panel();
  await p.send({ type: 'ready' });
  const external = plugin().replace('星球插件 🌍', '在源码视图修改');
  h.external(external);
  assert.equal(p.state().data.FriendlyName, '在源码视图修改');
  await p.send({ type: 'edit', requestId: 'stale', version: 1,
    operation: { type: 'set', path: ['FriendlyName'], value: '过期表单' } });
  assert.equal(h.document.text, external);
  assert.ok(p.messages.some(item => item.type === 'error' && item.conflict));
});

test('descriptor provider: invalid JSON remains read-only instead of being rebuilt from defaults', async () => {
  const invalid = '{ "FileVersion": 3, "Modules": [BROKEN] }';
  const h = harness(invalid);
  const p = await h.panel();
  await p.send({ type: 'ready' });
  assert.equal(p.state().valid, false);
  assert.ok(p.state().errors.length > 0);
  await p.send({ type: 'edit', requestId: 'invalid', version: h.document.version,
    operation: { type: 'set', path: ['FriendlyName'], value: '不可覆盖' } });
  assert.equal(h.document.text, invalid);
  assert.equal(h.applied.length, 0);
  assert.ok(p.messages.some(item => item.type === 'error'));
});

test('descriptor provider: module add/remove respects order and keeps other data intact', async () => {
  const h = harness(plugin());
  const p = await h.panel();
  await p.send({ type: 'ready' });
  await p.send({ type: 'edit', requestId: 'add', version: h.document.version,
    operation: { type: 'add', collection: 'Modules', value: { Name: 'PlanetWorldEditor', Type: 'Editor', LoadingPhase: 'Default' } } });
  assert.equal(JSON.parse(h.document.text).Modules.length, 2);
  assert.equal(JSON.parse(h.document.text).Modules[1].Name, 'PlanetWorldEditor');
  await p.send({ type: 'edit', requestId: 'remove', version: h.document.version,
    operation: { type: 'remove', collection: 'Modules', index: 1 } });
  assert.deepEqual(JSON.parse(h.document.text), JSON.parse(plugin()));
});

test('descriptor provider: disposing views removes document listeners', async () => {
  const h = harness(plugin());
  const p = await h.panel();
  assert.ok(h.listeners() > 0);
  p.view.dispose();
  assert.equal(h.listeners(), 0);
});

test('descriptor provider: Save without changes is byte-identical and creates no field defaults', async () => {
  const original = '\uFEFF{\r\n\t"FileVersion": 3,\r\n\t"Version": 1,\r\n\t"FriendlyName": "保留格式"\r\n}\r\n';
  const h = harness(original);
  const p = await h.panel();
  await p.send({ type: 'ready' });
  await p.send({ type: 'save' });
  assert.equal(h.disk(), original);
  assert.equal(h.document.text, original);
  assert.equal(h.applied.length, 0);
});

test('descriptor provider: Save waits behind an already submitted edit', async () => {
  const h = harness(plugin());
  const p = await h.panel();
  await p.send({ type: 'ready' });
  const edit = p.send({ type: 'edit', requestId: 'then-save', version: h.document.version,
    operation: { type: 'set', path: ['FriendlyName'], value: '编辑后立即保存' } });
  const save = p.send({ type: 'save' });
  await Promise.all([edit, save]);
  assert.equal(JSON.parse(h.disk()).FriendlyName, '编辑后立即保存');
  assert.equal(h.document.isDirty, false);
});

test('descriptor provider: Source uses VS Code default text editor for exactly this document', async () => {
  const h = harness(plugin());
  const p = await h.panel();
  await p.send({ type: 'source' });
  assert.equal(h.commands.length, 1);
  assert.equal(h.commands[0][0], 'vscode.openWith');
  assert.equal(h.commands[0][1].fsPath, h.document.uri.fsPath);
  assert.equal(h.commands[0][2], 'default');
  assert.equal(h.applied.length, 0);
});
