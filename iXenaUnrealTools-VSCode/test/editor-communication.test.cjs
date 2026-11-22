'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { randomUUID, randomBytes } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { decideBuild } = require('../dist/liveCoding');

class Uri {
  constructor(fsPath) { this.fsPath = fsPath; this.scheme = 'file'; }
  static file(fsPath) { return new Uri(fsPath); }
  static parse(value) { return { value, toString: () => value }; }
  static joinPath(uri, ...parts) { return new Uri(path.join(uri.fsPath, ...parts)); }
  toString() { return `file://${this.fsPath}`; }
}
class Range {
  constructor(a, b, c, d) {
    this.start = typeof a === 'object' ? a : { line: a, character: b };
    this.end = typeof c === 'undefined' ? b : { line: c, character: d };
  }
  isEqual(other) { return JSON.stringify(this.start) === JSON.stringify(other.start) && JSON.stringify(this.end) === JSON.stringify(other.end); }
}
class Diagnostic { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } }
class WorkspaceEdit { constructor() { this.edits = []; } replace(uri, range, content) { this.edits.push({ uri, range, content }); } }
function positionAt(text, offset) { const lines = text.slice(0, offset).split('\n'); return { line: lines.length - 1, character: lines.at(-1).length }; }
function offsetAt(text, position) { const lines = text.split('\n'); return lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character; }

async function temporary(t, cleanup = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ixena-communication-'));
  t.after(async () => { for (const action of cleanup) await action(); await fs.rm(root, { recursive: true, force: true }); }); return root;
}

function loadController(fake, substitutes = {}) {
  const filename = path.join(__dirname, '..', 'dist', 'editorCommunication.js');
  delete require.cache[filename]; const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return fake;
    if (parent?.filename === filename && Object.hasOwn(substitutes, request)) return substitutes[request];
    return original.call(this, request, parent, isMain);
  };
  try { return require(filename).EditorCommunication; } finally { Module._load = original; }
}

async function harness(t, overrides = {}) {
  const cleanup = []; const root = await temporary(t, cleanup); const projectPath = path.join(root, 'Star', 'Star.uproject');
  await fs.mkdir(path.dirname(projectPath), { recursive: true }); await fs.writeFile(projectPath, '{}');
  const engineRoot = path.join(root, 'UE_5.9'); await fs.mkdir(engineRoot);
  const target = { projectPath, engineRoot };
  const settings = { 'liveCoding.transport': 'plugin', ...overrides.settings };
  const infos = [], warnings = [], commands = [], logs = [], tasks = [], writes = [], opened = [], entries = new Map(), state = new Map();
  const output = { text: 'PREVIOUS BUILD\n', append(value) { this.text += value; }, appendLine(value) { this.text += `${value}\n`; }, show() {} };
  const diagnostics = { clear() { entries.clear(); }, set(uri, values) { entries.set(uri.fsPath, values); } };
  const documents = new Map();
  const fake = {
    Uri, Range, Diagnostic, WorkspaceEdit, DiagnosticSeverity: { Error: 0, Warning: 1 },
    TaskScope: { Workspace: 2 }, TaskGroup: { Build: 'build' }, ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    workspace: {
      isTrusted: true, workspaceFolders: [], saveAll: async () => true,
      getConfiguration: () => ({ get: (key, fallback) => Object.hasOwn(settings, key) ? settings[key] : fallback, update: async (key,value,scope) => { writes.push({key,value,scope}); settings[key]=value; } }),
      getWorkspaceFolder: () => undefined,
      openTextDocument: async uri => {
        if (!documents.has(uri.fsPath)) {
          let text = await fs.readFile(uri.fsPath, 'utf8');
          const document = { uri, isDirty: false, getText: () => text,
            positionAt: offset => positionAt(text, offset), setText: value => { text = value; document.isDirty = true; },
            save: async () => { await fs.writeFile(uri.fsPath, text); document.isDirty = false; return true; } };
          documents.set(uri.fsPath, document);
        }
        return documents.get(uri.fsPath);
      },
      applyEdit: async edit => {
        for (const change of [...edit.edits].reverse()) {
          const doc = documents.get(change.uri.fsPath), original = doc.getText();
          doc.setText(original.slice(0, offsetAt(original, change.range.start)) + change.content + original.slice(offsetAt(original, change.range.end)));
        }
        return true;
      }
    },
    window: {
      showInformationMessage: async message => { infos.push(message); },
      showWarningMessage: async message => { warnings.push(message); },
      showQuickPick: async values => overrides.quickPick ? overrides.quickPick(values) : values[0],
      showTextDocument: async () => {},
      showInputBox: async options => overrides.input ? overrides.input(options) : options.value
    },
    env: { openExternal: async uri => { opened.push(uri.toString()); return true; } },
    commands: { executeCommand: async (...args) => { commands.push(args); } }
  };
  const Class = loadController(fake, overrides.substitutes);
  const object = Object.create(Class.prototype);
  Object.assign(object, { context: { extensionPath: path.dirname(__dirname), globalStorageUri: Uri.file(path.join(root, 'storage')),
      workspaceState: { get: key => state.get(key), update: async (key, value) => state.set(key, value) } },
    hooks: { preferredTarget: () => target, projects: () => [projectPath], engines: () => [engineRoot], buildBusy: () => false,
      changed: () => {}, log: value => logs.push(value), runTask: async (label, steps) => { tasks.push({ label, steps }); return { status: 'succeeded' }; } },
    emitter: { fire() {} }, output, diagnostics, target, state: '尚未检查连接', busy: false });
  return { object, target, root, fake, infos, warnings, commands, logs, tasks, output, entries, savedState: state, cleanup, writes, opened, settings };
}

async function bridgeFixture(t, h, handler) {
  const id = `${process.pid}-${randomUUID()}`;
  const directory = path.join(path.dirname(h.target.projectPath), 'Saved', 'iXenaUnrealBridge', 'instances', id);
  for (const name of ['Requests', 'Responses', 'Processing', 'Logs']) await fs.mkdir(path.join(directory, name), { recursive: true });
  const descriptor = { protocol: 1, pluginVersion: '0.5.0', instanceId: id, token: randomBytes(32).toString('hex'),
    processId: process.pid, ...h.target, engineVersion: '5.9', platform: 'Win64', startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), status: 'ready', liveCodingAvailable: true, liveCodingEnabled: true };
  await fs.writeFile(path.join(directory, 'instance.json'), JSON.stringify(descriptor));
  const requests = []; let running = true; let serverError; let releaseShutdown;
  const shutdown = new Promise(resolve => { releaseShutdown = resolve; });
  const server = (async () => {
    while (running) {
      for (const name of await fs.readdir(path.join(directory, 'Requests'))) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(directory, 'Requests', name);
        const request = JSON.parse(await fs.readFile(file, 'utf8'));
        await fs.rename(file, path.join(directory, 'Processing', name)); requests.push(request);
        const respond = async (status, output = '', message = '') => {
          if (!running) return;
          const data = { protocol: 1, id: request.id, instanceId: id,
            ok: ['Ready', 'Success', 'NoChanges'].includes(status), status, output, message, completedAt: new Date().toISOString() };
          const temp = path.join(directory, 'Responses', `${request.id}.tmp`);
          await fs.writeFile(temp, JSON.stringify(data)); await fs.rename(temp, path.join(directory, 'Responses', `${request.id}.json`));
        };
        if (request.command === 'ping') await respond('Ready');
        else await Promise.race([handler({ request, respond, directory }), shutdown]);
      }
      await delay(5);
    }
  })().catch(error => { serverError = error; });
  h.cleanup.push(async () => { running = false; releaseShutdown(); await server; if (serverError) throw serverError; });
  return { directory, descriptor, requests };
}

test('bridge compile keeps busy until UE Failure, retains logs and creates Problems without starting UBT', async t => {
  const h = await harness(t);
  let release, entered; const gate = new Promise(resolve => { release = resolve; }); const ready = new Promise(resolve => { entered = resolve; });
  t.after(() => release());
  const diagnostic = String.raw`D:\Star\Source\Star\Machine.cpp(8,4): error C2445: ambiguous ternary` + '\n';
  const server = await bridgeFixture(t, h, async ({ request, respond, directory }) => {
    await fs.writeFile(path.join(directory, 'Logs', `${request.id}.log`), diagnostic); entered();
    await gate; await respond('Failure', diagnostic, 'Compilation failed');
  });
  const compile = h.object.compile(h.target); await ready;
  for (let attempt = 0; attempt < 50 && !h.output.text.includes('C2445'); attempt++) await delay(10);
  assert.equal(h.object.isBusy, true); assert.match(h.output.text, /C2445/);
  await assert.rejects(h.object.check(), /已有构建或通讯操作/);
  release(); const result = await compile;
  assert.equal(result.status, 'Failure'); assert.equal(h.object.isBusy, false); assert.equal(h.tasks.length, 0);
  assert.equal(server.requests.filter(item => item.command === 'compile').length, 1);
  assert.match(h.output.text, /PREVIOUS BUILD/); assert.match(h.object.state, /未成功.*Failure/);
  const diagnostics = [...h.entries.values()].flat(); assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].range.start.line, 7); assert.equal(diagnostics[0].code, 'C2445');
  const saved = h.savedState.get('communication.lastLog'); assert.ok(saved);
  assert.match(await fs.readFile(saved, 'utf8'), /C2445[\s\S]*Compilation failed[\s\S]*Failure/);
});

test('bridge timeout after request is claimed leaves an archived unknown result and does not retry', async t => {
  const h = await harness(t); h.object.timeoutSeconds = () => 0.16;
  const server = await bridgeFixture(t, h, async ({ request, directory }) => {
    await fs.writeFile(path.join(directory, 'Logs', `${request.id}.log`), 'Compiler started\n');
    // Simulate an editor still compiling after the client deadline. No final response.
  });
  await assert.rejects(h.object.compile(h.target), error => error.name === 'BridgeTimeoutError' && error.outcomeUnknown);
  assert.equal(h.object.isBusy, false); assert.equal(h.tasks.length, 0);
  assert.equal(server.requests.filter(item => item.command === 'compile').length, 1);
  const text = await fs.readFile(h.savedState.get('communication.lastLog'), 'utf8');
  assert.match(text, /Compiler started/); assert.match(text, /不会自动重试编译/);
});

test('missing Live Coding platform capability blocks compile even when the bridge connection exists', async t => {
  const h = await harness(t);
  const fixture = await bridgeFixture(t, h, async () => assert.fail('Must never compile'));
  await fs.writeFile(path.join(fixture.directory, 'instance.json'), JSON.stringify({ ...fixture.descriptor, liveCodingAvailable: false, liveCodingEnabled: false }));
  await assert.rejects(h.object.compile(h.target), /macOS\/Linux/);
  assert.equal(fixture.requests.length, 0); assert.equal(h.tasks.length, 0);
  await h.object.check(); assert.match(h.object.state, /插件已连接.*此平台无 Live Coding/);
});

test('MCP connection and Live Coding availability remain separate UI states', async t => {
  let compileCalls = 0;
  const h = await harness(t, { settings: { 'liveCoding.transport': 'mcp' }, substitutes: {
    './unrealMcp': { checkUnrealMcp: async () => ({ processId: 321, liveCodingAvailable: false,
      message: 'macOS Editor connected; Live Coding unavailable', toolName: '' }),
    compileViaUnrealMcp: async () => { compileCalls++; return { status: 'NotAvailable', rawOutput: 'No tool on this host', isError: true }; } }
  } });
  await h.object.check(); assert.equal(compileCalls, 0);
  assert.match(h.object.state, /MCP 已连接.*Live Coding 不可用/);
  assert.match(h.output.text, /macOS Editor connected/); assert.equal(h.tasks.length, 0);
});

test('MCP explicit compilation failure is displayed as failure and preserves actual diagnostics', async t => {
  const h = await harness(t, { settings: { 'liveCoding.transport': 'mcp' }, substitutes: {
    './unrealMcp': { compileViaUnrealMcp: async (_config, progress) => {
      progress('Compiling'); return { status: 'Failure', isError: true,
        rawOutput: '/Users/x/Star/Source/Foo.cpp:3:2: error: missing member\n' };
    } }
  } });
  const result = await h.object.compile(h.target);
  assert.equal(result.status, 'Failure'); assert.equal(h.tasks.length, 0); assert.equal(h.entries.size, 1);
  assert.ok(h.warnings.some(message => /Failure/.test(message)));
  assert.match(await fs.readFile(h.savedState.get('communication.lastLog'), 'utf8'), /missing member/);
});

test('completed communication is a terminal smart-build branch for success or failure', () => {
  assert.equal(decideBuild('auto', 'StarEditor', 'completed'), 'live-coding');
  assert.equal(decideBuild('auto', 'StarEditor', 'not-running'), 'ubt');
  assert.equal(decideBuild('auto', 'StarEditor', 'unverified-project'), 'blocked');
  assert.equal(decideBuild('auto', 'StarEditor', 'engine-mismatch'), 'blocked');
});

function buildController(fake, state, target, compile) {
  const filename = path.join(__dirname, '..', 'dist', 'extension.js');
  delete require.cache[filename]; const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return fake;
    if (request === './editorProcesses' && parent?.filename === filename) return { probeWindowsEditor: async () => state };
    return original.call(this, request, parent, isMain);
  };
  let Class;
  try { Class = require(filename).BuildController; } finally { Module._load = original; }
  const object = Object.create(Class.prototype), calls = [];
  const entry = { spec: { ...target, target: 'StarEditor', platform: 'Win64' }, origin: { folder: undefined } };
  const selected = { ...target, target: 'StarEditor', platform: 'Win64', tasks: { Build: entry } };
  Object.assign(object, { checkBuildAllowed() {}, debugStarting: false, updateBar() {}, log() {},
    ensureSelection: async () => selected, currentEngineRoot: () => target.engineRoot,
    communication: { compile: async () => { calls.push('live'); return compile(); } },
    executeEntry: async () => { calls.push('ubt'); return { status: 'succeeded' }; } });
  return { object, calls };
}

test('smart-build root route retains Failure and unconfirmed outcomes without falling back to UBT', async t => {
  const h = await harness(t);
  for (const result of [{ status: 'Failure', isError: true, rawOutput: 'error' }, undefined]) {
    const { object, calls } = buildController(h.fake, 'running', h.target, async () => result);
    await object.build('Build');
    assert.deepEqual(calls, ['live']); assert.equal(object.liveCodingDispatching, false);
    if (result) assert.match(object.lastResult.text, /error/);
  }
  const stopped = buildController(h.fake, 'not-running', h.target, async () => assert.fail('No editor must not compile live'));
  await stopped.object.build('Build'); assert.deepEqual(stopped.calls, ['ubt']);
});

test('smart-build root route refuses UBT on transport failure or unverified editor identity', async t => {
  const h = await harness(t);
  const timeout = buildController(h.fake, 'running', h.target, async () => { throw new Error('Outcome unknown'); });
  await assert.rejects(timeout.object.build('Build'), /Outcome unknown/);
  assert.deepEqual(timeout.calls, ['live']); assert.equal(timeout.object.liveCodingDispatching, false);
  for (const state of ['unknown', 'engine-mismatch']) {
    const route = buildController(h.fake, state, h.target, async () => assert.fail('No request is safe'));
    await assert.rejects(route.object.build('Build'));
    assert.deepEqual(route.calls, []); assert.equal(route.object.liveCodingDispatching, false);
  }
});

test('automatic debug monitoring requires matching Editor engine and absolute project argument', async t => {
  const h = await harness(t);
  const filename = path.join(__dirname, '..', 'dist', 'editorCommunication.js');
  const { matchesDebugLaunch } = require(filename);
  const program = path.join(h.target.engineRoot,'Engine','Binaries','Linux','UnrealEditor');
  assert.equal(matchesDebugLaunch({request:'launch',program,args:[h.target.projectPath]},h.target),true);
  assert.equal(matchesDebugLaunch({request:'launch',program,args:[`-Project=${h.target.projectPath}`]},h.target),true);
  assert.equal(matchesDebugLaunch({request:'launch',program,args:['Other.uproject']},h.target),false);
  assert.equal(matchesDebugLaunch({request:'launch',program:path.join(h.root,'OtherEngine','UnrealEditor'),args:[h.target.projectPath]},h.target),false);
  assert.equal(matchesDebugLaunch({request:'launch',program:'',args:[h.target.projectPath]},h.target),false);
  assert.equal(matchesDebugLaunch({request:'attach',program,args:[h.target.projectPath]},h.target),false);
});


test('plugin initialization opens the fixed repository and never builds or writes the project', async t => {
  const h = await harness(t);
  const before = await fs.readFile(h.target.projectPath, 'utf8');
  await h.object.initialize();
  assert.deepEqual(h.opened, ['https://github.com/w2zArd/iXenaUnrealTools']);
  assert.deepEqual(h.writes.map(w => [w.key,w.value]), [['liveCoding.transport','plugin']]);
  assert.equal(h.tasks.length,0);
  assert.equal(await fs.readFile(h.target.projectPath,'utf8'),before);
  assert.match(h.object.state,/手动安装/);
});

test('MCP initialization asks for IP port and path and saves one validated endpoint', async t => {
  const answers=['::1','8765','/custom/mcp']; const prompts=[];
  const h=await harness(t,{quickPick:values=>values.find(x=>x.value==='mcp'),input:options=>{
    const answer=answers.shift();prompts.push(options.title);assert.equal(options.validateInput(answer),undefined);return answer;
  }});
  await h.object.initialize();
  assert.equal(prompts.length,3);
  assert.equal(h.settings['liveCoding.mcpUrl'],'http://[::1]:8765/custom/mcp');
  assert.equal(h.settings['liveCoding.transport'],'mcp');
  assert.equal(h.tasks.length,0);assert.equal(h.opened.length,0);
});

test('cancelling MCP setup leaves prior connection settings and project untouched', async t => {
  let calls=0;
  const h=await harness(t,{quickPick:values=>values.find(x=>x.value==='mcp'),input:()=>++calls===1?'127.0.0.1':undefined});
  await h.object.initialize();
  assert.equal(h.writes.length,0);assert.equal(h.tasks.length,0);assert.equal(h.opened.length,0);
});

test('missing bridge prompts manual initialization and releases busy without launching installation', async t => {
  const h=await harness(t);
  await assert.rejects(h.object.compile(h.target),/初始化引擎插件/);
  assert.equal(h.object.isBusy,false);assert.equal(h.tasks.length,0);assert.equal(h.opened.length,0);
  assert.equal(await fs.readFile(h.target.projectPath,'utf8'),'{}');
});

test('communication tools are grouped with stable IDs and one initialization action', async t => {
  const h=await harness(t);const rows=h.object.getChildren();
  assert.deepEqual(rows.filter(r=>r.children).map(r=>r.id),['connection','build','runtime','logs']);
  assert.equal(rows.find(r=>r.id==='connection').expanded,true);
  const leaves=rows.flatMap(r=>r.children??[r]);
  assert.equal(leaves.filter(r=>r.command==='initializeEnginePlugin').length,1);
  assert.equal(leaves.some(r=>r.command==='installEditorBridge'||r.command==='openBridgeSource'),false);
  assert.deepEqual(h.object.getChildren(rows[1]),rows[1].children);
});

test('initialization owns the busy state until completion and restores state on cancel',async t=>{
 let release, entered; const gate=new Promise(resolve=>release=resolve);const ready=new Promise(resolve=>entered=resolve);
 const h=await harness(t,{quickPick:async()=>{entered();await gate;return undefined;}});
 const original=h.object.state;const pending=h.object.initialize();await ready;
 assert.equal(h.object.isBusy,true);await assert.rejects(h.object.check(),/已有构建或通讯操作/);
 release();await pending;assert.equal(h.object.isBusy,false);assert.equal(h.object.state,original);assert.equal(h.writes.length,0);
});

test('UE Success releases compile busy even while VSCode success notification remains open', async t => {
  const h = await harness(t);
  let closeToast;
  const toastIsOpen = new Promise(resolve => { closeToast = resolve; });
  t.after(() => closeToast());
  h.fake.window.showInformationMessage = message => { h.infos.push(message); return toastIsOpen; };
  const server = await bridgeFixture(t, h, async ({ respond }) => { await respond('Success', 'Compiled & patched', 'Confirmed by UE'); });
  const compile = await Promise.race([h.object.compile(h.target), delay(2500).then(() => { throw new Error('compile blocked by notification'); })]);
  assert.equal(compile.status, 'Success');
  assert.equal(h.object.isBusy, false);
  assert.equal(server.requests.filter(item => item.command === 'compile').length, 1);
  assert.match(h.output.text, /热更新成功（UE 已确认）/);
  assert.ok(h.infos.some(text => text.includes('热更新成功')));
  const rows = h.object.getChildren();
  const buildRows = rows.find(row => row.id === 'build').children;
  assert.ok(buildRows.some(row => /上次热更新结果/.test(row.label) && /热更新成功/.test(row.detail)));
});

test('UE Failure releases compile busy even while warning with an action remains open', async t => {
  const h = await harness(t);
  let closeToast; const toastIsOpen = new Promise(resolve => { closeToast = resolve; });
  t.after(() => closeToast());
  h.fake.window.showWarningMessage = message => { h.warnings.push(message); return toastIsOpen; };
  await bridgeFixture(t, h, async ({ respond }) => { await respond('Failure', 'error C1000', 'Compiler rejected'); });
  const compile = await Promise.race([h.object.compile(h.target), delay(2500).then(() => { throw new Error('compile blocked by warning'); })]);
  assert.equal(compile.status, 'Failure');
  assert.equal(h.object.isBusy, false);
  assert.ok(h.warnings.some(text => /Failure/.test(text)));
});

test('silent automatic detection reconnects after UE restarts and never compiles on its own', async t => {
  const h = await harness(t);
  await h.object.autoReconnect();
  assert.match(h.object.state, /等待 UE 启动/);
  const first = await bridgeFixture(t, h, async ({ respond }) => { await respond('Success'); });
  await h.object.autoReconnect();
  assert.match(h.object.state, /插件已连接/);
  assert.equal(first.requests.filter(item => item.command === 'compile').length, 0);
  // Stale instance persists on disk when an editor exits; do not reuse its token.
  await fs.writeFile(path.join(first.directory, 'instance.json'), JSON.stringify({ ...first.descriptor, updatedAt: new Date(Date.now()-600000).toISOString() }));
  await h.object.autoReconnect();
  assert.match(h.object.state, /等待 UE 启动/);
  const next = await bridgeFixture(t, h, async ({ respond }) => { await respond('Success'); });
  await h.object.autoReconnect();
  assert.match(h.object.state, /插件已连接/);
  assert.equal(h.object.confirmedConnection.instanceId, next.descriptor.instanceId);
  assert.equal(next.requests.filter(item => item.command === 'compile').length, 0);
  assert.equal(h.infos.length, 0);
});

test('foreground Live Coding waits for a previously running background handshake', async t => {
  const h = await harness(t);
  await bridgeFixture(t, h, async ({ respond }) => { await respond('Success'); });
  let finishPoll;
  h.object.reconnectInFlight = new Promise(resolve => { finishPoll = resolve; });
  const compilePromise = h.object.compile(h.target);
  assert.equal(h.object.isBusy, true);
  await delay(40);
  assert.equal(h.object.isBusy, true);
  finishPoll();
  const result = await compilePromise;
  assert.equal(result.status, 'Success');
  assert.equal(h.object.isBusy, false);
});

test('MCP automatic reconnect uses identity-only probe and throttles healthy handshakes', async t => {
  let checks = 0;
  const h = await harness(t, { settings: { 'liveCoding.transport': 'mcp' }, substitutes: {
    './unrealMcp': {
      probeUnrealMcpIdentity: async () => { checks++; return { processId: 7711 }; },
      checkUnrealMcp: async () => { throw new Error('Must not enumerate tools on timer'); },
      compileViaUnrealMcp: async () => { throw new Error('Must never compile on timer'); }
    }
  } });
  // Object.create test harness bypasses class field initializers.
  h.object.connectedRecheckMs = 5000;
  await h.object.autoReconnect();
  assert.match(h.object.state, /MCP 已连接.*7711/);
  await h.object.autoReconnect();
  assert.equal(checks, 1);
  h.object.confirmedConnection.at -= 5001;
  await h.object.autoReconnect();
  assert.equal(checks, 2);
  assert.equal(h.infos.length, 0);
});
