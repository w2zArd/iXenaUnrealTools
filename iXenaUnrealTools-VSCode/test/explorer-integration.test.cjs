'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');

function loadIntegration(options = {}) {
  const calls = [];
  const opened = [];
  const notices = [];
  const files = options.files;
  const uri = file => ({ scheme: 'file', fsPath: file, path: file, toString: () => `file://${file}` });
  const fake = {
    UIKind: { Desktop: 1, Web: 2 },
    env: { uriScheme: 'vscode', remoteName: undefined, uiKind: 1, appRoot: '/app/resources/app',
      openExternal: async value => { calls.push(['openExternal', value]); } },
    Uri: { file: uri },
    workspace: {
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      workspaceFolders: [], workspaceFile: undefined
    },
    window: {
      showQuickPick: async values => { calls.push(['showQuickPick', values]); return options.pick?.(values); },
      showOpenDialog: async () => undefined,
      showInformationMessage: async (...args) => { notices.push(args); },
      showErrorMessage: async (...args) => { notices.push(args); },
      registerUriHandler: handler => { calls.push(['registerUriHandler', handler]); return { dispose() {} }; }
    },
    commands: { executeCommand: async (...args) => { calls.push(args); } }
  };
  const file = path.join(__dirname, '..', 'dist', 'explorerIntegration.js');
  delete require.cache[file];
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'vscode') return fake;
    if (request === 'node:fs/promises' && files) return files;
    if (request === 'node:path' && options.windowsPaths) return path.win32;
    return originalLoad.call(this, request, parent, isMain);
  };
  let loaded;
  try { loaded = require(file); }
  finally { Module._load = originalLoad; }
  const context = { globalStorageUri: uri(options.storage || '/tmp/ixena-unused-storage'),
    extensionPath: path.resolve(__dirname, '..') };
  const integration = new loaded.ExplorerIntegration(context, {
    output: message => calls.push(['log', message]),
    openDescriptor: async value => { opened.push(value); }
  });
  return { ...loaded, integration, fake, context, calls, opened, notices, uri };
}

function explorerUri(action, file, overrides = {}) {
  return { scheme: 'vscode', authority: 'ixena-unreal-tools.ixena-unreal-tools-vscode', path: '/explorer', fragment: '',
    query: `payload=${Buffer.from(JSON.stringify({ version: 1, action, file }), 'utf8').toString('base64url')}`,
    ...overrides };
}

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ixena-explorer-integration-'));
  t.after(async () => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('Explorer integration rejects non-local hosts before touching registry or opening files', async () => {
  const h = loadIntegration();
  assert.equal(h.windowsIntegrationUnavailable('win32', undefined, 1), undefined);
  assert.match(h.windowsIntegrationUnavailable('linux', undefined, 1), /Windows/);
  assert.match(h.windowsIntegrationUnavailable('win32', 'wsl', 1), /WSL/);
  assert.match(h.windowsIntegrationUnavailable('win32', undefined, 2), /网页/);
  if (process.platform !== 'win32') {
    await assert.rejects(h.integration.register(), /Windows/);
    await assert.rejects(h.integration.unregister(), /Windows/);
    await assert.rejects(h.integration.handleUri(explorerUri('edit', String.raw`D:\Game\Game.uproject`)), /Windows/);
    assert.equal(h.calls.length, 0);
  }
});

test('Explorer integration finds only project-containing workspaces, independent of folder order', async t => {
  const dir = await temporary(t);
  const write = (name, content) => fs.writeFile(path.join(dir, name), content);
  await write('Game.uproject', '{}');
  await write('Project.code-workspace', '\uFEFF{ // UE root may come first\n"folders": [{"name":"Engine","path":"../UE_5.9"},{"name":"Project","path":"."}], }');
  await write('Other.code-workspace', JSON.stringify({ folders: [{ path: '../Other' }] }));
  await write('Broken.code-workspace', '{ BROKEN }');
  await write('Variables.code-workspace', JSON.stringify({ folders: [{ path: '${workspaceFolder}' }] }));
  await write('Absolute.code-workspace', JSON.stringify({ folders: [{ path: dir }] }));
  const h = loadIntegration();
  const matches = await h.findProjectWorkspaces(path.join(dir, 'Game.uproject'));
  assert.deepEqual(matches.map(value => path.basename(value)), ['Absolute.code-workspace', 'Project.code-workspace']);
});

test('Explorer URI edit and source route the clicked descriptor exactly, ignoring current workspace', async () => {
  const file = String.raw`D:\星球 & 50% #插件\PlanetWorld.uplugin`;
  const h = loadIntegration({ windowsPaths: true, files: { stat: async value => {
    assert.equal(value, file); return { isFile: () => true };
  } } });
  h.integration.checkAvailable = () => {};
  h.fake.workspace.workspaceFile = h.uri(String.raw`D:\Other\Project.code-workspace`);
  await h.integration.handleUri(explorerUri('edit', file));
  assert.equal(h.opened.length, 1);
  assert.equal(h.opened[0].fsPath, file);
  await h.integration.handleUri(explorerUri('source', file));
  const source = h.calls.find(call => call[0] === 'vscode.openWith');
  assert.equal(source[1].fsPath, file);
  assert.equal(source[2], 'default');
  assert.equal(h.calls.some(call => /build|runTask/i.test(call[0])), false);
});

test('Explorer URI rejects wrong scheme, extension, fragments, and missing files without actions', async () => {
  const file = String.raw`D:\Game\Game.uproject`;
  let stats = 0;
  const h = loadIntegration({ files: { stat: async () => { stats += 1; throw new Error('ENOENT'); } } });
  h.integration.checkAvailable = () => {};
  for (const override of [{ scheme: 'https' }, { authority: 'someone.other' }, { fragment: 'anything' }]) {
    await assert.rejects(h.integration.handleUri(explorerUri('edit', file, override)), /无法识别/);
  }
  assert.equal(stats, 0);
  await assert.rejects(h.integration.handleUri(explorerUri('edit', file)), /不存在|不可读取/);
  assert.equal(stats, 1);
  assert.equal(h.opened.length, 0);
  assert.equal(h.calls.length, 0);
});

test('Explorer URI opens a plugin folder in a new window and never replaces an unrelated workspace', async () => {
  const file = String.raw`D:\Project\Plugins\PlanetWorld\PlanetWorld.uplugin`;
  const h = loadIntegration({ windowsPaths: true, files: { stat: async () => ({ isFile: () => true }) } });
  h.integration.checkAvailable = () => {};
  h.fake.workspace.workspaceFile = h.uri(String.raw`D:\Other\Project.code-workspace`);
  await h.integration.handleUri(explorerUri('open', file));
  const open = h.calls.find(call => call[0] === 'vscode.openFolder');
  assert.equal(open[1].fsPath, String.raw`D:\Project\Plugins\PlanetWorld`);
  assert.deepEqual(open[2], { forceNewWindow: true });
});

test('Explorer URI focuses an already open plugin directory without spawning a duplicate window', async () => {
  const file = String.raw`D:\Project\Plugins\PlanetWorld\PlanetWorld.uplugin`;
  const h = loadIntegration({ windowsPaths: true, files: { stat: async () => ({ isFile: () => true }) } });
  h.integration.checkAvailable = () => {};
  h.fake.workspace.workspaceFolders = [{ uri: h.uri(String.raw`D:\Project\Plugins\PlanetWorld`) }];
  await h.integration.handleUri(explorerUri('open', file));
  assert.ok(h.calls.some(call => call[0] === 'workbench.view.explorer'));
  assert.equal(h.calls.some(call => call[0] === 'vscode.openFolder'), false);
});

test('Explorer registration copies stable bridge files and uses fixed Install/Remove operations', async t => {
  const dir = await temporary(t);
  const h = loadIntegration({ storage: path.join(dir, 'user storage 中文') });
  h.integration.checkAvailable = () => {};
  h.integration.powershellPath = async () => String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
  h.integration.codePath = async () => String.raw`C:\Apps\VS Code\Code.exe`;
  const operations = [];
  h.integration.runRegistry = async operation => {
    operations.push(operation);
    return operation === 'Install' ? { installed: true, project: true, plugin: true } : { project: false, plugin: false };
  };
  await h.integration.register();
  const folder = path.join(h.context.globalStorageUri.fsPath, 'explorer');
  const raw = await fs.readFile(path.join(folder, 'explorer-config.json'), 'utf8');
  assert.equal(raw.charCodeAt(0), 0xfeff, 'PowerShell 5.1 UTF-8 BOM');
  const config = JSON.parse(raw.slice(1));
  assert.equal(config.extensionId, 'ixena-unreal-tools.ixena-unreal-tools-vscode');
  assert.equal(config.uriScheme, 'vscode');
  assert.equal(config.bridgePath, path.join(folder, 'ExplorerBridge.ps1'));
  assert.equal(config.codeExe, String.raw`C:\Apps\VS Code\Code.exe`);
  for (const filename of ['ExplorerBridge.ps1', 'ExplorerRegistry.ps1', 'Remove-ExplorerMenu.ps1']) {
    await fs.access(path.join(folder, filename));
  }
  await h.integration.unregister();
  assert.deepEqual(operations, ['Install', 'Remove']);
});

test('Explorer initialization registers one URI handler and performs no automatic registry installation', async () => {
  const h = loadIntegration();
  h.integration.initialize();
  h.integration.initialize();
  assert.equal(h.calls.filter(call => call[0] === 'registerUriHandler').length, 1);
  assert.equal(h.calls.filter(call => call[0] !== 'registerUriHandler' && call[0] !== 'setContext').length, 0);
});
