'use strict';

// 真实文件与 LocalizationManager，模拟 VS Code 文档/任务边界；不会启动 Unreal Editor。
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const PO = String.raw`msgid ""
msgstr ""
"Language: zh-CN\n"
"Content-Type: text/plain; charset=UTF-8\n"

#. Key: Welcome
msgctxt "Game,Welcome"
msgid "Hello {Player}"
msgstr "你好 {Player}"
`;

function event() {
  const listeners = new Set();
  return { subscribe: callback => { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; },
    fire: value => { for (const callback of [...listeners]) callback(value); } };
}
async function walk(root) {
  const found = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...await walk(filename)); else found.push(filename);
  }
  return found;
}

async function harness(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ixena-localization-host-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'UE5 Test 中文'), projectPath = path.join(projectRoot, 'UE5Test.uproject');
  const dataDirectory = path.join(projectRoot, 'Content', 'Localization', 'Game');
  const configDirectory = path.join(projectRoot, 'Config', 'Localization');
  await fs.mkdir(path.join(projectRoot, 'Source'), { recursive: true });
  await fs.mkdir(path.join(dataDirectory, 'zh-CN'), { recursive: true });
  await fs.mkdir(path.join(dataDirectory, 'en'), { recursive: true });
  await fs.mkdir(configDirectory, { recursive: true });
  await fs.writeFile(projectPath, '{"FileVersion":3}\n');
  const file = path.join(dataDirectory, 'zh-CN', 'Game.po');
  const nativeFile = path.join(dataDirectory, 'en', 'Game.po');
  await fs.writeFile(file, options.bom ? '\uFEFF' + PO : PO);
  await fs.writeFile(nativeFile, PO.replace('Language: zh-CN', 'Language: en').replace('你好 {Player}', 'Hello {Player}'));
  if (options.manifest !== false) await fs.writeFile(path.join(dataDirectory, 'Game.manifest'), '{}');
  const common = '[CommonSettings]\nSourcePath=Content/Localization/Game\nDestinationPath=Content/Localization/Game\nManifestName=Game.manifest\nArchiveName=Game.archive\nPortableObjectName=Game.po\nNativeCulture=en\nCulturesToGenerate=en\nCulturesToGenerate=zh-CN\n';
  const configs = {
    Gather: '\n[GatherTextStep0]\nCommandletClass=GenerateGatherManifest\n[GatherTextStep1]\nCommandletClass=GenerateGatherArchive\n',
    Export: '\n[GatherTextStep0]\nCommandletClass=InternationalizationExport\nbExportLoc=true\nbUseCultureDirectory=true\n',
    Import: '\n[GatherTextStep0]\nCommandletClass=InternationalizationExport\nbImportLoc=true\nbUseCultureDirectory=true\n',
    Compile: '\n[GatherTextStep0]\nCommandletClass=GenerateTextLocalizationResource\n'
  };
  for (const [name, body] of Object.entries(configs)) {
    if (options.missingImport && name === 'Import') continue;
    await fs.writeFile(path.join(configDirectory, `Game_${name}.ini`), common + body);
  }
  const engine = path.join(root, 'UE Engine');
  const platformFolder = process.platform === 'win32' ? 'Win64' : process.platform === 'darwin' ? 'Mac' : 'Linux';
  const executable = path.join(engine, 'Engine', 'Binaries', platformFolder, process.platform === 'win32' ? 'UnrealEditor-Cmd.exe' : 'UnrealEditor-Cmd');
  await fs.mkdir(path.dirname(executable), { recursive: true }); await fs.writeFile(executable, 'mock-only');

  const saved = event(), changed = event(), visibility = event(), watched = event();
  const messages = [], logs = [], calls = [], docs = new Map(), state = new Map(), registered = new Map();
  const configValues = { 'localization.autoExportOnSave': Boolean(options.autoExport) };
  class Uri {
    constructor(filename) { this.fsPath = filename; this.path = filename; this.scheme = 'file'; }
    static file(filename) { return new Uri(filename); }
    static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
    toString() { return `file://${this.fsPath}`; }
  }
  class EventEmitter {
    constructor() { this.channel = event(); this.event = this.channel.subscribe; }
    fire(value) { this.channel.fire(value); }
    dispose() {}
  }
  const documents = [];
  async function document(uri) {
    if (docs.has(uri.fsPath)) return docs.get(uri.fsPath);
    const diskText = await fs.readFile(uri.fsPath, 'utf8');
    const doc = { uri, text: diskText.replace(/^\uFEFF/, ''), hasBom: diskText.startsWith('\uFEFF'), isDirty: false, version: 1,
      getText() { return this.text; }, positionAt(offset) { return { offset }; },
      async save() { await fs.writeFile(uri.fsPath, (this.hasBom ? '\uFEFF' : '') + this.text, 'utf8'); this.isDirty = false; saved.fire(this); return true; }
    };
    docs.set(uri.fsPath, doc); documents.push(doc); return doc;
  }
  const fake = {
    Uri, EventEmitter,
    TreeItem: class { constructor(label) { this.label = label; } }, ThemeIcon: class { constructor(id) { this.id = id; } },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    WorkspaceEdit: class { constructor() { this.edits = []; } replace(uri, range, text) { this.edits.push({ uri, range, text }); } },
    ViewColumn: { One: 1 }, TaskScope: { Workspace: 2 }, ConfigurationTarget: { Workspace: 2 },
    commands: { registerCommand(name, callback) { registered.set(name, callback); return { dispose() { registered.delete(name); } }; } },
    workspace: {
      isTrusted: true, workspaceFolders: [{ uri: Uri.file(projectRoot), name: 'UE5Test' }], textDocuments: documents,
      getWorkspaceFolder: () => ({ uri: Uri.file(projectRoot), name: 'UE5Test' }),
      openTextDocument: document,
      getConfiguration: () => ({ get: (name, fallback) => configValues[name] ?? fallback,
        update: async (name, value) => { configValues[name] = value; } }),
      onDidChangeConfiguration: changed.subscribe, onDidSaveTextDocument: saved.subscribe,
      createFileSystemWatcher: () => ({ onDidChange: watched.subscribe, onDidCreate: watched.subscribe, onDidDelete: watched.subscribe, dispose() {} }),
      applyEdit: async edit => {
        for (const value of edit.edits) {
          const doc = await document(value.uri);
          doc.text = doc.text.slice(0, value.range.start.offset) + value.text + doc.text.slice(value.range.end.offset);
          doc.isDirty = true; doc.version++;
        }
        return true;
      }
    },
    window: {
      createTreeView: () => ({ onDidChangeVisibility: visibility.subscribe, dispose() {} }),
      createWebviewPanel: () => {
        const received = event(), disposed = event();
        return { webview: { html: '', cspSource: 'https://unit-test.invalid', asWebviewUri: value => value,
          onDidReceiveMessage: received.subscribe, postMessage: async value => { messages.push(value); return true; } },
        reveal() {}, onDidDispose: disposed.subscribe, dispose() { disposed.fire(); } };
      },
      showErrorMessage: async message => { messages.push({ type: 'error', message }); },
      showWarningMessage: async (_text, _options, action) => action,
      showInformationMessage: async (_text, _options, action) => action,
      showOpenDialog: async () => options.openDialog?.map(Uri.file),
      showSaveDialog: async () => options.saveDialog ? Uri.file(options.saveDialog) : undefined,
      showTextDocument: async () => {}, showQuickPick: async items => items[0], showInputBox: async () => undefined
    }
  };
  const managerFile = path.resolve(__dirname, '../dist/localizationManager.js');
  const viewFile = path.resolve(__dirname, '../dist/localizationView.js');
  delete require.cache[managerFile]; delete require.cache[viewFile];
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) { return request === 'vscode' ? fake : originalLoad.call(this, request, parent, isMain); };
  let Constructor;
  try { Constructor = require(managerFile).LocalizationManager; } finally { Module._load = originalLoad; }
  const hooks = { projects: () => [projectPath], preferredProject: () => projectPath, engineForProject: () => engine,
    engines: () => [engine], buildBusy: () => false,
    runTask: async (label, steps) => { calls.push({ label, steps }); return options.runTask ? options.runTask(label, steps) : { status: 'succeeded', exitCode: 0 }; },
    stopTask: () => { calls.push({ stop: true }); }, log: value => logs.push(value) };
  const manager = new Constructor({ extensionUri: Uri.file(path.resolve(__dirname, '..')),
    workspaceState: { get: (key, fallback) => state.get(key) ?? fallback, update: async (key, value) => { state.set(key, value); } } }, hooks);
  t.after(() => manager.dispose());
  await manager.open();
  await manager.dispatch({ type: 'ready' });
  const latest = () => messages.filter(message => message.type === 'state').at(-1);
  const save = (translation, extra = {}) => manager.dispatch({ type: 'save', filePath: latest().filePath, revision: latest().revision,
    changes: [{ id: latest().entries[0].id, translations: [translation] }], ...extra });
  return { root, projectRoot, projectPath, file, nativeFile, dataDirectory, configDirectory, fake, manager, hooks,
    messages, calls, logs, configValues, latest, save, saved, workspaceState: state, document: () => document(Uri.file(file)), options };
}

test('localization host: scans actual target data and preserves PO bytes on merely opening the panel', async t => {
  const h = await harness(t);
  assert.equal(h.latest().targets.length, 1);
  assert.equal(h.latest().culture, 'zh-CN');
  assert.equal(h.latest().entries[0].context, 'Game,Welcome');
  assert.equal(await fs.readFile(h.file, 'utf8'), PO);
  assert.equal(h.calls.length, 0);
});

test('localization host: stale revision and forged file destination cannot overwrite translations', async t => {
  const h = await harness(t);
  await h.save('不可保存', { revision: 'stale' });
  await h.save('不可覆盖其他语言', { filePath: h.nativeFile });
  assert.equal(await fs.readFile(h.file, 'utf8'), PO);
  assert.ok((await fs.readFile(h.nativeFile, 'utf8')).includes('Hello {Player}'));
  assert.equal(h.messages.filter(message => message.type === 'error').length, 2);
});

test('localization host: external disk or open-editor changes are protected by independent hashes', async t => {
  const h = await harness(t);
  const external = PO.replace('你好 {Player}', '外部保存 {Player}');
  await fs.writeFile(h.file, external);
  await h.save('不应覆盖磁盘 {Player}');
  assert.equal(await fs.readFile(h.file, 'utf8'), external);
  await fs.writeFile(h.file, PO);
  const doc = await h.document(); doc.text = PO.replace('你好 {Player}', '编辑器草稿 {Player}'); doc.isDirty = true;
  await h.save('不应覆盖草稿 {Player}');
  assert.ok(doc.text.includes('编辑器草稿'));
  assert.equal(await fs.readFile(h.file, 'utf8'), PO);
  assert.equal(h.messages.filter(message => message.type === 'error').length, 2);
});

test('localization host: untrusted workspace can view but cannot save or launch a commandlet', async t => {
  const h = await harness(t); h.fake.workspace.isTrusted = false;
  await h.save('blocked');
  await h.manager.dispatch({ type: 'pipeline', action: 'gatherExport' });
  assert.equal(await fs.readFile(h.file, 'utf8'), PO);
  assert.equal(h.calls.length, 0);
  assert.equal(h.messages.filter(message => message.type === 'error').length, 2);
});

test('localization host: save writes PO then exports three language-specific formats when enabled', async t => {
  const h = await harness(t, { autoExport: true });
  await h.save('欢迎 {Player}');
  assert.ok((await fs.readFile(h.file, 'utf8')).includes('欢迎 {Player}'));
  const files = await walk(path.join(h.projectRoot, 'Saved', 'iXenaUnrealTools', 'LocalizationExports'));
  assert.deepEqual(files.map(file => path.extname(file)).sort(), ['.csv', '.json', '.po']);
  const json = JSON.parse(await fs.readFile(files.find(file => file.endsWith('.json')), 'utf8'));
  assert.equal(json.culture, 'zh-CN'); assert.equal(json.entries[0].translations[0], '欢迎 {Player}');
  assert.equal(await fs.readFile(files.find(file => file.endsWith('.po')), 'utf8'), await fs.readFile(h.file, 'utf8'));
  assert.equal(h.latest().busy, false);
});

test('localization host: queued on-save exports use the saved snapshot, not later unsaved edits', async t => {
  const h = await harness(t, { autoExport: true });
  const doc = await h.document();
  let release; h.manager.queue = new Promise(resolve => { release = resolve; });
  h.saved.fire(doc);
  doc.text = PO.replace('你好 {Player}', '尚未保存 {Player}'); doc.isDirty = true;
  release(); await h.manager.queue;
  const files = await walk(path.join(h.projectRoot, 'Saved', 'iXenaUnrealTools', 'LocalizationExports'));
  assert.equal(await fs.readFile(files.find(file => file.endsWith('.po')), 'utf8'), PO);
});

test('localization host: gather/export imports existing PO first and backs it up before tasks', async t => {
  const h = await harness(t);
  await h.manager.dispatch({ type: 'pipeline', action: 'gatherExport' });
  assert.equal(h.calls.length, 1);
  const steps = h.calls[0].steps;
  assert.deepEqual(steps.map(step => path.basename(step.args.find(arg => arg.startsWith('-config=')).slice(8))), ['Game_Import.ini', 'Game_Gather.ini', 'Game_Export.ini']);
  assert.ok(steps.every(step => step.args[0] === h.projectPath && step.args.includes('-run=GatherText')));
  assert.ok(steps.every(step => step.args.some(arg => arg.startsWith('-abslog='))));
  const backups = (await walk(path.join(h.projectRoot, 'Saved', 'iXenaUnrealTools', 'LocalizationRuns'))).filter(file => file.endsWith('.po'));
  assert.equal(backups.length, 2);
  assert.ok(await Promise.all(backups.map(file => fs.readFile(file, 'utf8'))).then(contents => contents.includes(PO)));
});

test('localization host: restored PO without manifest gathers before import, still imports before export', async t => {
  const h = await harness(t, { manifest: false });
  await h.manager.dispatch({ type: 'pipeline', action: 'gatherExport' });
  assert.deepEqual(h.calls[0].steps.map(step => path.basename(step.args.find(arg => arg.startsWith('-config=')).slice(8))), ['Game_Gather.ini', 'Game_Import.ini', 'Game_Export.ini']);
});

test('localization host: missing import config cannot silently export over existing PO', async t => {
  const h = await harness(t, { missingImport: true });
  await h.manager.dispatch({ type: 'pipeline', action: 'gatherExport' });
  assert.equal(h.calls.length, 0);
  assert.equal(await fs.readFile(h.file, 'utf8'), PO);
  assert.ok(h.messages.some(message => message.type === 'error' && /import/i.test(message.message)));
});

test('localization host: failed commandlet reports final status and retains translations and backups', async t => {
  const h = await harness(t, { runTask: async () => ({ status: 'failed', exitCode: 7 }) });
  await h.manager.dispatch({ type: 'pipeline', action: 'importCompile' });
  assert.equal(h.calls.length, 1);
  assert.equal(h.latest().busy, false);
  assert.match(h.latest().status, /7/);
  assert.equal(await fs.readFile(h.file, 'utf8'), PO);
  const backups = (await walk(path.join(h.projectRoot, 'Saved', 'iXenaUnrealTools', 'LocalizationRuns'))).filter(file => file.endsWith('.po'));
  assert.equal(backups.length, 2);
});

test('localization host: manual export refuses another culture PO and target INI as its destination', async t => {
  const options = {};
  const h = await harness(t, options);
  for (const destination of [h.nativeFile, path.join(h.configDirectory, 'Game_Gather.ini')]) {
    const before = await fs.readFile(destination, 'utf8');
    options.saveDialog = destination;
    await h.manager.dispatch({ type: 'export', format: 'po', all: false });
    assert.equal(await fs.readFile(destination, 'utf8'), before);
  }
  assert.equal(h.messages.filter(message => message.type === 'error').length, 2);
});

test('localization host: unsaved drafts survive closing the panel and restore before the first state', async t => {
  const h = await harness(t), current = h.latest();
  const draft = { version: 1, filePath: current.filePath, revision: current.revision,
    targetId: current.targetId, culture: current.culture,
    changes: [{ id: current.entries[0].id, translations: ['尚未保存的译文 🛰️ {Player}'] }] };
  await h.manager.dispatch({ type: 'storeDraft', draft });
  assert.deepEqual(h.workspaceState.get('localizationDraft'), draft);
  h.manager.panel.dispose();
  const before = h.messages.length;
  await h.manager.open();
  assert.equal(h.messages.slice(before).some(message => message.type === 'state'), false,
    'The new panel must not receive state before the ready handshake');
  await h.manager.dispatch({ type: 'ready' });
  const incoming = h.messages.slice(before);
  const restoredIndex = incoming.findIndex(message => message.type === 'restoreDraft');
  const stateIndex = incoming.findIndex(message => message.type === 'state');
  assert.ok(restoredIndex >= 0 && restoredIndex < stateIndex);
  assert.deepEqual(incoming[restoredIndex].draft, draft);
  assert.equal(await fs.readFile(h.file, 'utf8'), PO);
});

test('localization host: explicitly empty draft clears durable state even while another operation is busy', async t => {
  const h = await harness(t), current = h.latest();
  const draft = { version: 1, filePath: current.filePath, revision: current.revision,
    targetId: current.targetId, culture: current.culture,
    changes: [{ id: current.entries[0].id, translations: ['暂存'] }] };
  await h.manager.dispatch({ type: 'storeDraft', draft });
  h.manager.operation = true;
  await h.manager.dispatch({ type: 'storeDraft', draft: { ...draft, changes: [] } });
  h.manager.operation = false;
  assert.equal(h.workspaceState.get('localizationDraft'), undefined);
  h.manager.panel.dispose(); const before = h.messages.length;
  await h.manager.open(); await h.manager.dispatch({ type: 'ready' });
  assert.equal(h.messages.slice(before).some(message => message.type === 'restoreDraft'), false);
});

test('localization host: refresh never pairs stale editor text with a new disk baseline for overwriting', async t => {
  const h = await harness(t), original = h.latest();
  const external = PO.replace('你好 {Player}', '外部新版本 {Player}');
  await fs.writeFile(h.file, external);
  await h.manager.dispatch({ type: 'refresh' });
  await h.manager.dispatch({ type: 'save', filePath: original.filePath, revision: h.latest().revision ?? original.revision,
    changes: [{ id: original.entries[0].id, translations: ['不可覆盖 {Player}'] }] });
  assert.equal(await fs.readFile(h.file, 'utf8'), external);
});

test('localization host: a UTF-8 BOM hidden by VS Code is not treated as an external conflict', async t => {
  const h = await harness(t, { bom: true });
  assert.equal(h.latest().entries[0].source, 'Hello {Player}');
  await h.save('带 BOM 保存 {Player}');
  const disk = await fs.readFile(h.file, 'utf8');
  assert.ok(disk.startsWith('\uFEFF'));
  assert.ok(disk.includes('带 BOM 保存 {Player}'));
  assert.equal(h.messages.some(message => message.type === 'error'), false);
});
