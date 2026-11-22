'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

// 上传的 UE 工作区精简副本。只保留发现任务所需的 folders / tasks / launch / terminal env。
const fixture = {"folders":[{"name":"🚀 UE引擎","path":"D:\\Apps\\UnrealEngine\\UE_5.9"},{"name":"➡️ 当前项目","path":"."}],"tasks":{"version":"2.0.0","tasks":[{"label":"UE5Test Win64 Debug Build","group":"build","command":"Engine\\Build\\BatchFiles\\Build.bat","args":["UE5Test","Win64","Debug","D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject","-waitmutex"],"problemMatcher":"$msCompile","type":"shell","options":{"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9"}},{"label":"UE5Test Win64 Debug Rebuild","group":"build","command":"Engine\\Build\\BatchFiles\\Build.bat","args":["UE5Test","Win64","Debug","D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject","-waitmutex"],"problemMatcher":"$msCompile","dependsOn":["UE5Test Win64 Debug Clean"],"type":"shell","options":{"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9"}},{"label":"UE5Test Win64 Debug Clean","group":"build","command":"Engine\\Build\\BatchFiles\\Clean.bat","args":["UE5Test","Win64","Debug","D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject","-waitmutex"],"problemMatcher":"$msCompile","type":"shell","options":{"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9"}},{"label":"UE5Test Win64 DebugGame Build","group":"build","command":"Engine\\Build\\BatchFiles\\Build.bat","args":["UE5Test","Win64","DebugGame","D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject","-waitmutex"],"problemMatcher":"$msCompile","type":"shell","options":{"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9"}},{"label":"UE5Test Win64 DebugGame Rebuild","group":"build","command":"Engine\\Build\\BatchFiles\\Build.bat","args":["UE5Test","Win64","DebugGame","D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject","-waitmutex"],"problemMatcher":"$msCompile","dependsOn":["UE5Test Win64 DebugGame Clean"],"type":"shell","options":{"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9"}},{"label":"UE5Test Win64 DebugGame Clean","group":"build","command":"Engine\\Build\\BatchFiles\\Clean.bat","args":["UE5Test","Win64","DebugGame","D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject","-waitmutex"],"problemMatcher":"$msCompile","type":"shell","options":{"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9"}},{"label":"UE5Test Win64 Development Build","group":"build","command":"Engine\\Build\\BatchFiles\\Build.bat","args":["UE5Test","Win64","Development","D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject","-waitmutex"],"problemMatcher":"$msCompile","type":"shell","options":{"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9"}},{"label":"UE5Test Win64 Development Rebuild","group":"build","command":"Engine\\Build\\BatchFiles\\Build.bat","args":["UE5Test","Win64","Development","D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject","-waitmutex"],"problemMatcher":"$msCompile","dependsOn":["UE5Test Win64 Development Clean"],"type":"shell","options":{"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9"}},{"label":"UE5Test Win64 Development Clean","group":"build","command":"Engine\\Build\\BatchFiles\\Clean.bat","args":["UE5Test","Win64","Development","D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject","-waitmutex"],"problemMatcher":"$msCompile","type":"shell","options":{"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9"}},{"label":"UE5Test Win64 Test Build","group":"build","command":"Engine\\Build\\BatchFiles\\Build.bat","args":["UE5Test","Win64","Test","D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject","-waitmutex"],"problemMatcher":"$msCompile","type":"shell","options":{"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9"}},{"label":"UE5Test Win64 Test Rebuild","group":"build","command":"Engine\\Build\\BatchFiles\\Build.bat","args":["UE5Test","Win64","Test","D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject","-waitmutex"],"problemMatcher":"$msCompile","dependsOn":["UE5Test Win64 Test Clean"],"type":"shell","options":{"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9"}},{"label":"UE5Test Win64 Test Clean","group":"build","command":"Engine\\Build\\BatchFiles\\Clean.bat","args":["UE5Test","Win64","Test","D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject","-waitmutex"],"problemMatcher":"$msCompile","type":"shell","options":{"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9"}},{"label":"UE5Test Win64 Shipping Build","group":"build","command":"Engine\\Build\\BatchFiles\\Build.bat","args":["UE5Test","Win64","Shipping","D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject","-waitmutex"],"problemMatcher":"$msCompile","type":"shell","options":{"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9"}},{"label":"UE5Test Win64 Shipping Rebuild","group":"build","command":"Engine\\Build\\BatchFiles\\Build.bat","args":["UE5Test","Win64","Shipping","D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject","-waitmutex"],"problemMatcher":"$msCompile","dependsOn":["UE5Test Win64 Shipping Clean"],"type":"shell","options":{"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9"}},{"label":"UE5Test Win64 Shipping Clean","group":"build","command":"Engine\\Build\\BatchFiles\\Clean.bat","args":["UE5Test","Win64","Shipping","D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject","-waitmutex"],"problemMatcher":"$msCompile","type":"shell","options":{"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9"}},{"label":"UE5TestEditor Win64 Debug Build","group":"build","command":"Engine\\Build\\BatchFiles\\Build.bat","args":["UE5TestEditor","Win64","Debug","D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject","-waitmutex"],"problemMatcher":"$msCompile","type":"shell","options":{"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9"}},{"label":"UE5TestEditor Win64 Debug Rebuild","group":"build","command":"Engine\\Build\\BatchFiles\\Build.bat","args":["UE5TestEditor","Win64","Debug","D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject","-waitmutex"],"problemMatcher":"$msCompile","dependsOn":["UE5TestEditor Win64 Debug Clean"],"type":"shell","options":{"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9"}},{"label":"UE5TestEditor Win64 Debug Clean","group":"build","command":"Engine\\Build\\BatchFiles\\Clean.bat","args":["UE5TestEditor","Win64","Debug","D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject","-waitmutex"],"problemMatcher":"$msCompile","type":"shell","options":{"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9"}},{"label":"UE5TestEditor Win64 DebugGame Build","group":"build","command":"Engine\\Build\\BatchFiles\\Build.bat","args":["UE5TestEditor","Win64","DebugGame","D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject","-waitmutex"],"problemMatcher":"$msCompile","type":"shell","options":{"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9"}},{"label":"UE5TestEditor Win64 DebugGame Rebuild","group":"build","command":"Engine\\Build\\BatchFiles\\Build.bat","args":["UE5TestEditor","Win64","DebugGame","D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject","-waitmutex"],"problemMatcher":"$msCompile","dependsOn":["UE5TestEditor Win64 DebugGame Clean"],"type":"shell","options":{"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9"}},{"label":"UE5TestEditor Win64 DebugGame Clean","group":"build","command":"Engine\\Build\\BatchFiles\\Clean.bat","args":["UE5TestEditor","Win64","DebugGame","D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject","-waitmutex"],"problemMatcher":"$msCompile","type":"shell","options":{"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9"}},{"label":"UE5TestEditor Win64 Development Build","group":"build","command":"Engine\\Build\\BatchFiles\\Build.bat","args":["UE5TestEditor","Win64","Development","D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject","-waitmutex"],"problemMatcher":"$msCompile","type":"shell","options":{"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9"}},{"label":"UE5TestEditor Win64 Development Rebuild","group":"build","command":"Engine\\Build\\BatchFiles\\Build.bat","args":["UE5TestEditor","Win64","Development","D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject","-waitmutex"],"problemMatcher":"$msCompile","dependsOn":["UE5TestEditor Win64 Development Clean"],"type":"shell","options":{"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9"}},{"label":"UE5TestEditor Win64 Development Clean","group":"build","command":"Engine\\Build\\BatchFiles\\Clean.bat","args":["UE5TestEditor","Win64","Development","D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject","-waitmutex"],"problemMatcher":"$msCompile","type":"shell","options":{"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9"}}]},"launch":{"version":"0.2.0","configurations":[{"name":"Launch UE5Test (Debug)","request":"launch","program":"D:\\Develop\\UnrealEngine\\UE5Test\\Binaries\\Win64\\UnrealGame-Win64-Debug.exe","preLaunchTask":"UE5Test Win64 Debug Build","args":[],"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9","stopAtEntry":false,"console":"integratedTerminal","type":"cppvsdbg","visualizerFile":"D:\\Apps\\UnrealEngine\\UE_5.9\\Engine\\Extras\\VisualStudioDebugging\\Unreal.natvis","sourceFileMap":{"D:\\build\\++UE5\\Sync":"D:\\Apps\\UnrealEngine\\UE_5.9"},"sourceMap":{"D:\\build\\++UE5\\Sync":"D:\\Apps\\UnrealEngine\\UE_5.9"}},{"name":"Launch UE5Test (DebugGame)","request":"launch","program":"D:\\Develop\\UnrealEngine\\UE5Test\\Binaries\\Win64\\UnrealGame-Win64-DebugGame.exe","preLaunchTask":"UE5Test Win64 DebugGame Build","args":[],"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9","stopAtEntry":false,"console":"integratedTerminal","type":"cppvsdbg","visualizerFile":"D:\\Apps\\UnrealEngine\\UE_5.9\\Engine\\Extras\\VisualStudioDebugging\\Unreal.natvis","sourceFileMap":{"D:\\build\\++UE5\\Sync":"D:\\Apps\\UnrealEngine\\UE_5.9"},"sourceMap":{"D:\\build\\++UE5\\Sync":"D:\\Apps\\UnrealEngine\\UE_5.9"}},{"name":"Launch UE5Test (Development)","request":"launch","program":"D:\\Develop\\UnrealEngine\\UE5Test\\Binaries\\Win64\\UnrealGame.exe","preLaunchTask":"UE5Test Win64 Development Build","args":[],"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9","stopAtEntry":false,"console":"integratedTerminal","type":"cppvsdbg","visualizerFile":"D:\\Apps\\UnrealEngine\\UE_5.9\\Engine\\Extras\\VisualStudioDebugging\\Unreal.natvis","sourceFileMap":{"D:\\build\\++UE5\\Sync":"D:\\Apps\\UnrealEngine\\UE_5.9"},"sourceMap":{"D:\\build\\++UE5\\Sync":"D:\\Apps\\UnrealEngine\\UE_5.9"}},{"name":"Launch UE5Test (Test)","request":"launch","program":"D:\\Develop\\UnrealEngine\\UE5Test\\Binaries\\Win64\\UnrealGame-Win64-Test.exe","preLaunchTask":"UE5Test Win64 Test Build","args":[],"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9","stopAtEntry":false,"console":"integratedTerminal","type":"cppvsdbg","visualizerFile":"D:\\Apps\\UnrealEngine\\UE_5.9\\Engine\\Extras\\VisualStudioDebugging\\Unreal.natvis","sourceFileMap":{"D:\\build\\++UE5\\Sync":"D:\\Apps\\UnrealEngine\\UE_5.9"},"sourceMap":{"D:\\build\\++UE5\\Sync":"D:\\Apps\\UnrealEngine\\UE_5.9"}},{"name":"Launch UE5Test (Shipping)","request":"launch","program":"D:\\Develop\\UnrealEngine\\UE5Test\\Binaries\\Win64\\UnrealGame-Win64-Shipping.exe","preLaunchTask":"UE5Test Win64 Shipping Build","args":[],"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9","stopAtEntry":false,"console":"integratedTerminal","type":"cppvsdbg","visualizerFile":"D:\\Apps\\UnrealEngine\\UE_5.9\\Engine\\Extras\\VisualStudioDebugging\\Unreal.natvis","sourceFileMap":{"D:\\build\\++UE5\\Sync":"D:\\Apps\\UnrealEngine\\UE_5.9"},"sourceMap":{"D:\\build\\++UE5\\Sync":"D:\\Apps\\UnrealEngine\\UE_5.9"}},{"name":"Launch UE5TestEditor (Debug)","request":"launch","program":"D:\\Apps\\UnrealEngine\\UE_5.9\\Engine\\Binaries\\Win64\\UnrealEditor-Win64-Debug.exe","preLaunchTask":"UE5TestEditor Win64 Debug Build","args":["D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject"],"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9","stopAtEntry":false,"console":"integratedTerminal","type":"cppvsdbg","visualizerFile":"D:\\Apps\\UnrealEngine\\UE_5.9\\Engine\\Extras\\VisualStudioDebugging\\Unreal.natvis","sourceFileMap":{"D:\\build\\++UE5\\Sync":"D:\\Apps\\UnrealEngine\\UE_5.9"},"sourceMap":{"D:\\build\\++UE5\\Sync":"D:\\Apps\\UnrealEngine\\UE_5.9"}},{"name":"Launch UE5TestEditor (DebugGame)","request":"launch","program":"D:\\Apps\\UnrealEngine\\UE_5.9\\Engine\\Binaries\\Win64\\UnrealEditor-Win64-DebugGame.exe","preLaunchTask":"UE5TestEditor Win64 DebugGame Build","args":["D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject"],"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9","stopAtEntry":false,"console":"integratedTerminal","type":"cppvsdbg","visualizerFile":"D:\\Apps\\UnrealEngine\\UE_5.9\\Engine\\Extras\\VisualStudioDebugging\\Unreal.natvis","sourceFileMap":{"D:\\build\\++UE5\\Sync":"D:\\Apps\\UnrealEngine\\UE_5.9"},"sourceMap":{"D:\\build\\++UE5\\Sync":"D:\\Apps\\UnrealEngine\\UE_5.9"}},{"name":"Launch UE5TestEditor (Development)","request":"launch","program":"D:\\Apps\\UnrealEngine\\UE_5.9\\Engine\\Binaries\\Win64\\UnrealEditor.exe","preLaunchTask":"UE5TestEditor Win64 Development Build","args":["D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject"],"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9","stopAtEntry":false,"console":"integratedTerminal","type":"cppvsdbg","visualizerFile":"D:\\Apps\\UnrealEngine\\UE_5.9\\Engine\\Extras\\VisualStudioDebugging\\Unreal.natvis","sourceFileMap":{"D:\\build\\++UE5\\Sync":"D:\\Apps\\UnrealEngine\\UE_5.9"},"sourceMap":{"D:\\build\\++UE5\\Sync":"D:\\Apps\\UnrealEngine\\UE_5.9"}},{"name":"Generate Project Files","type":"coreclr","request":"launch","preLaunchTask":"UnrealBuildTool Win64 Development Build","program":"D:\\Apps\\UnrealEngine\\UE_5.9\\Engine\\Build\\BatchFiles\\RunUBT.bat","args":["-projectfiles","-vscode","-project=D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject","-game","-engine","-dotnet"],"env":{"PATH":"D:\\Apps\\UnrealEngine\\UE_5.9\\Engine\\Binaries\\ThirdParty\\DotNet\\10.0\\win-x64;${env:PATH}","DOTNET_ROOT":"D:\\Apps\\UnrealEngine\\UE_5.9\\Engine\\Binaries\\ThirdParty\\DotNet\\10.0\\win-x64","DOTNET_HOST_PATH":"D:\\Apps\\UnrealEngine\\UE_5.9\\Engine\\Binaries\\ThirdParty\\DotNet\\10.0\\win-x64\\dotnet.exe","DOTNET_MULTILEVEL_LOOKUP":"0","DOTNET_ROLL_FORWARD":"LatestMajor"},"console":"integratedTerminal","stopAtEntry":false,"cwd":"D:\\Apps\\UnrealEngine\\UE_5.9"}]},"settings":{"terminal.integrated.env.windows":{"UE_ROOT":"D:\\Apps\\UnrealEngine\\UE_5.9","PATH":"D:\\Apps\\UnrealEngine\\UE_5.9\\Engine\\Binaries\\ThirdParty\\DotNet\\10.0\\win-x64;${env:PATH}","DOTNET_ROOT":"D:\\Apps\\UnrealEngine\\UE_5.9\\Engine\\Binaries\\ThirdParty\\DotNet\\10.0\\win-x64","DOTNET_HOST_PATH":"D:\\Apps\\UnrealEngine\\UE_5.9\\Engine\\Binaries\\ThirdParty\\DotNet\\10.0\\win-x64\\dotnet.exe","DOTNET_MULTILEVEL_LOOKUP":"0","DOTNET_ROLL_FORWARD":"LatestMajor"}}};


const clone = value => JSON.parse(JSON.stringify(value));
const projectRoot = String.raw`D:\Develop\UnrealEngine\UE5Test`;
const engineRoot = String.raw`D:\Apps\UnrealEngine\UE_5.9`;
const workspacePath = path.win32.join(projectRoot, 'Project.code-workspace');
const keyFor = value => path.win32.normalize(value).toLowerCase();

function uri(fsPath) {
  return {
    scheme: 'file', fsPath,
    toString: () => `file:///${fsPath.replace(/\\/g, '/')}`,
  };
}

function createApi(document = fixture, reverse = false) {
  const source = clone(document);
  const folderSettings = new Map();
  const documents = new Map([[keyFor(workspacePath), Buffer.from(JSON.stringify(source))]]);
  let runtimeFolders = source.folders.map((folder, index) => ({
    name: folder.name,
    index,
    uri: uri(path.win32.resolve(projectRoot, folder.path)),
  }));
  if (reverse) { runtimeFolders = runtimeFolders.reverse().map((folder, index) => ({ ...folder, index })); }
  const nativeTasks = (source.tasks?.tasks ?? []).map(raw => ({ name: raw.label, scope: 2, marker: `workspace:${raw.label}` }));
  const api = {
    TaskScope: { Global: 1, Workspace: 2 },
    TaskRevealKind: { Always: 1, Silent: 2, Never: 3 },
    TaskPanelKind: { Shared: 1, Dedicated: 2, New: 3 },
    Uri: { joinPath: (base, ...parts) => uri(path.win32.join(base.fsPath, ...parts)) },
    workspace: {
      workspaceFile: uri(workspacePath),
      workspaceFolders: runtimeFolders,
      fs: { readFile: async requested => {
        const bytes = documents.get(keyFor(requested.fsPath));
        if (bytes === undefined) { const error = new Error('Fixture file does not exist'); error.code = 'FileNotFound'; throw error; }
        return bytes;
      } },
      getConfiguration: (section, resource) => ({ get: (name, fallback) => {
        const settings = { ...source.settings, ...(resource ? folderSettings.get(keyFor(resource.fsPath)) : {}) };
        return settings[section ? `${section}.${name}` : name] ?? fallback;
      } }),
    },
    tasks: { fetchTasks: async () => nativeTasks },
  };
  const modulePath = path.resolve(__dirname, '..', 'dist', 'workspaceModel.js');
  const originalLoad = Module._load;
  delete require.cache[modulePath];
  Module._load = function(request, parent, isMain) {
    if (request === 'vscode') { return api; }
    return originalLoad.call(this, request, parent, isMain);
  };
  let model;
  try { model = require(modulePath); }
  finally { Module._load = originalLoad; }
  return { api, source, model, nativeTasks, documents, folderSettings };
}

function projectFolder(fake) { return fake.api.workspace.workspaceFolders.find(folder => folder.name === '➡️ 当前项目'); }
function workspaceOrigin(fake, baseDirectory = projectRoot) {
  return { key: `workspace:${fake.api.workspace.workspaceFile.toString()}`, uri: fake.api.workspace.workspaceFile,
    label: 'Project.code-workspace', baseDirectory };
}

for (const reverse of [false, true]) {
  test(`完整真实工作区发现稳定：${reverse ? '项目根在前' : '引擎根在前'}`, async () => {
    const fake = createApi(fixture, reverse);
    const logs = [];
    const catalogue = await fake.model.loadCatalogue(message => logs.push(message));
    assert.deepEqual(catalogue.issues, []);
    assert.equal(catalogue.entries.length, 24);
    assert.equal(catalogue.configurations.length, 8);
    assert.equal(catalogue.launches.length, 9);
    assert.equal(catalogue.configurations[0].title, 'Development Editor');
    assert.equal(catalogue.configurations[0].origin.baseDirectory, projectRoot);
    const selected = catalogue.configurations[0];
    assert.equal(selected.tasks.Build.spec.label, 'UE5TestEditor Win64 Development Build');
    assert.equal(selected.tasks.Build.resolve('${workspaceFolder}'), projectRoot);
    assert.equal(selected.tasks.Build.resolve('${workspaceFolder:➡️ 当前项目}'), projectRoot);
    assert.equal(selected.tasks.Build.env.DOTNET_HOST_PATH,
      String.raw`D:\Apps\UnrealEngine\UE_5.9\Engine\Binaries\ThirdParty\DotNet\10.0\win-x64\dotnet.exe`);
    const launches = fake.model.matchingLaunches(selected, catalogue.launches);
    assert.equal(launches.length, 1);
    assert.equal(launches[0].config.name, 'Launch UE5TestEditor (Development)');
    assert.equal(launches[0].config.preLaunchTask, selected.tasks.Build.spec.label);
    assert.ok(catalogue.entries.every(entry => entry.native?.scope === 2));
    assert.ok(logs.some(message => message.includes('24') && message.includes('8') && message.includes('9')));
  });
}

test('工作区和文件夹出现同名任务/launch 时按作用域精确匹配', async () => {
  const document = clone(fixture);
  const task = document.tasks.tasks.find(entry => entry.label === 'UE5TestEditor Win64 Development Build');
  const launch = document.launch.configurations.find(entry => entry.preLaunchTask === task.label);
  document.tasks.tasks = [task];
  document.launch.configurations = [launch];
  const fake = createApi(document);
  const folder = projectFolder(fake);
  const folderTask = { name: task.label, scope: folder, marker: 'folder-specific' };
  const engineFolder = fake.api.workspace.workspaceFolders.find(value => value.name === '🚀 UE引擎');
  fake.nativeTasks.push(folderTask, { name: task.label, scope: engineFolder, marker: 'wrong-engine-folder' });
  fake.documents.set(keyFor(path.win32.join(folder.uri.fsPath, '.vscode', 'tasks.json')),
    Buffer.from(JSON.stringify({ version: '2.0.0', tasks: [task] })));
  fake.documents.set(keyFor(path.win32.join(folder.uri.fsPath, '.vscode', 'launch.json')),
    Buffer.from(JSON.stringify({ version: '0.2.0', configurations: [launch] })));
  const catalogue = await fake.model.loadCatalogue(() => {});
  assert.deepEqual(catalogue.issues, []);
  assert.equal(catalogue.entries.length, 2);
  assert.equal(catalogue.configurations.length, 2);
  assert.equal(catalogue.launches.length, 2);
  assert.notEqual(catalogue.entries[0].id, catalogue.entries[1].id);
  const workspaceEntry = catalogue.entries.find(entry => !entry.origin.folder);
  const folderEntry = catalogue.entries.find(entry => entry.origin.folder);
  assert.equal(workspaceEntry.native.marker, `workspace:${task.label}`);
  assert.equal(folderEntry.native, folderTask);
  for (const config of catalogue.configurations) {
    const matches = fake.model.matchingLaunches(config, catalogue.launches);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].origin.key, config.origin.key);
  }
});

test('原生任务本身重名歧义时不随意挑选一个 native handle', async () => {
  const fake = createApi();
  const duplicate = fake.nativeTasks[0];
  fake.nativeTasks.push({ ...duplicate, marker: 'ambiguous' });
  const catalogue = await fake.model.loadCatalogue(() => {});
  assert.equal(catalogue.entries.find(entry => entry.spec.label === duplicate.name).native, undefined);
  assert.equal(catalogue.entries.length, 24);
});

test('复杂继承使用 VS Code 已解析 command/argv/env，不猜测全局参数或深合并环境', () => {
  const { model } = createApi();
  const root = {
    version: '2.0.0', tasks: [], inputs: [],
    command: 'global.exe', type: 'shell', problemMatcher: '$msCompile', args: ['--global-arg'],
    options: { cwd: 'D:\\Global', env: { GLOBAL: 'yes', ORDER: 'global' } },
    presentation: { reveal: 'always', panel: 'shared', clear: false },
    windows: {
      args: ['--global-windows-arg'], options: { env: { WINDOWS: 'yes', ORDER: 'global-windows' } },
      presentation: { reveal: 'never' },
    },
  };
  const raw = {
    label: 'ExampleEditor Win64 Development Build',
    command: String.raw`Engine\Build\BatchFiles\Build.bat`, args: ['ExampleEditor', 'Win64', 'Development', 'D:\\Example.uproject'],
    options: { env: { TASK: 'yes', ORDER: 'task' } }, presentation: { clear: true },
    windows: {
      options: { cwd: 'D:\\WindowsUE', env: { TASK_WINDOWS: 'yes', ORDER: 'task-windows' } },
      presentation: { panel: 'dedicated' },
    },
  };
  // 由 VS Code 提供的结果才是最终 argv/env；这些值故意与普通深合并结果不同。
  const resolved = {
    command: { value: String.raw`D:\Native UE\Engine\Build\BatchFiles\Build.bat`, quoting: 2 },
    args: [...raw.args, '-NoUBA'],
    options: { cwd: 'D:\\Native UE', env: { TASK_WINDOWS: 'yes', ORDER: 'native-effective' } },
  };
  const snapshot = clone({ root, raw, resolved });
  const merged = model.mergeTaskConfig(root, raw, resolved);
  assert.deepEqual(merged.args, resolved.args);
  assert.equal(merged.args.includes('--global-arg'), false);
  assert.deepEqual(merged.command, resolved.command);
  assert.equal(merged.options.cwd, resolved.options.cwd);
  assert.deepEqual(merged.options.env, resolved.options.env);
  assert.equal('GLOBAL' in merged.options.env, false);
  assert.equal('WINDOWS' in merged.options.env, false);
  assert.deepEqual(merged.presentation, { reveal: 'never', panel: 'dedicated', clear: true });
  assert.equal(merged.problemMatcher, '$msCompile');
  for (const field of ['tasks', 'inputs', 'windows', 'version']) { assert.equal(field in merged, false); }
  assert.deepEqual({ root, raw, resolved }, snapshot, '合并读取不修改配置或已解析执行输入');
  assert.throws(() => model.mergeTaskConfig(root, raw), /无法取得 VS Code 解析后的命令/);
  assert.throws(() => model.mergeTaskConfig(root, raw, { callback: () => {} }), /无法取得 VS Code 解析后的命令/);

  const environmentOnly = { options: { env: { GLOBAL: 'yes' } } };
  assert.throws(() => model.mergeTaskConfig(environmentOnly, raw), /多层环境继承/);
  const processExecution = { process: 'D:\\UE\\Build.exe', args: ['final-arg'], options: {} };
  const fromProcess = model.mergeTaskConfig(root, raw, processExecution);
  assert.equal(fromProcess.command, processExecution.process);
  assert.deepEqual(fromProcess.args, ['final-arg']);
  assert.equal(fromProcess.options.cwd, undefined);
  assert.equal(fromProcess.options.env, undefined);

  const simple = model.mergeTaskConfig({ options: { cwd: 'D:\\UE' }, presentation: { reveal: 'always' } },
    { label: 'Example', command: raw.command, args: raw.args, presentation: { clear: true } });
  assert.equal(simple.options.cwd, 'D:\\UE');
  assert.deepEqual(simple.presentation, { reveal: 'always', clear: true });
});

test('变量解析根据任务来源与具名工作区，不采用第一个根目录', () => {
  const fake = createApi();
  const folders = fake.api.workspace.workspaceFolders;
  const origin = workspaceOrigin(fake);
  const resolve = fake.model.makeResolver(origin, { UE_ROOT: engineRoot }, folders);
  assert.equal(folders[0].name, '🚀 UE引擎');
  assert.equal(resolve('${workspaceFolder}'), projectRoot);
  assert.equal(resolve('${workspaceFolder:➡️ 当前项目}'), projectRoot);
  assert.equal(resolve('${workspaceFolder:🚀 UE引擎}'), engineRoot);
  assert.equal(resolve('${workspaceFolderBasename}'), 'UE5Test');
  assert.equal(resolve('${env:ue_root}'), engineRoot);
  assert.equal(resolve('%UE_ROOT%'), engineRoot);
  assert.throws(() => resolve('${env:IXENA_UNREALTOOLS_TEST_UNSET}'), /未设置/);
  assert.throws(() => resolve('${workspaceFolder:不存在}'), /唯一定位/);
  assert.throws(() => resolve('${input:ChooseTarget}'), /不支持变量/);
  const ambiguous = fake.model.makeResolver(workspaceOrigin(fake, 'D:\\ExternalWorkspaces'), {}, folders);
  assert.throws(() => ambiguous('${workspaceFolder}'), /不明确/);
  const tiedToFolder = fake.model.makeResolver({ ...origin, folder: projectFolder(fake) }, {}, folders);
  assert.equal(tiedToFolder('${workspaceFolder}'), projectRoot);
  const cycle = fake.model.makeResolver(origin, { A: '${env:B}', B: '${env:A}' }, folders);
  assert.throws(() => cycle('${env:A}'), /循环引用/);
});

test('terminal/task 字符串环境按层覆盖；null 删除明确拒绝且不修改 Node 环境', async t => {
  const key = 'IXENA_UNREALTOOLS_TEST_REMOVE';
  const previous = process.env[key];
  process.env[key] = 'process-value';
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  const document = clone(fixture);
  document.tasks.tasks = [document.tasks.tasks.find(entry => entry.label.endsWith('Development Build'))];
  document.tasks.tasks[0].options.env = { FROM_TERMINAL: '${env:UE_ROOT}', PATH: '${env:PATH};D:\\TaskExtraBin' };
  const fake = createApi(document);
  const catalogue = await fake.model.loadCatalogue(() => {});
  assert.deepEqual(catalogue.issues, []);
  const entry = catalogue.entries[0];
  assert.equal(entry.env.FROM_TERMINAL, engineRoot);
  assert.ok(fake.model.envGet(entry.env, 'PATH').endsWith(';D:\\TaskExtraBin'));
  assert.ok(fake.model.envGet(entry.env, 'PATH').includes('10.0\\win-x64'));

  const deletingTaskEnv = clone(document);
  deletingTaskEnv.tasks.tasks[0].options.env[key] = null;
  const rejectedTask = await createApi(deletingTaskEnv).model.loadCatalogue(() => {});
  assert.equal(rejectedTask.entries.length, 0);
  assert.ok(rejectedTask.issues.some(issue => issue.includes('null 删除') && issue.includes('ProcessExecution')));
  const deletingTerminalEnv = clone(document);
  deletingTerminalEnv.settings['terminal.integrated.env.windows'][key] = null;
  const rejectedTerminal = await createApi(deletingTerminalEnv).model.loadCatalogue(() => {});
  assert.equal(rejectedTerminal.entries.length, 0);
  assert.ok(rejectedTerminal.issues.some(issue => issue.includes('null 删除')));
  assert.equal(process.env[key], 'process-value');
});

test('UTF-8 BOM、JSONC 注释和尾逗号可读，真正解析错误进入 issues', async () => {
  const fake = createApi();
  const original = fake.documents.get(keyFor(workspacePath)).toString('utf8');
  fake.documents.set(keyFor(workspacePath), Buffer.from(`\uFEFF// 用户手写注释\n${original.slice(0, -1)},}`.replace(/\\n/, '\n')));
  const accepted = await fake.model.loadCatalogue(() => {});
  assert.deepEqual(accepted.issues, []);
  assert.equal(accepted.entries.length, 24);
  fake.documents.set(keyFor(workspacePath), Buffer.from('{ "tasks": [ broken JSON }'));
  const rejected = await fake.model.loadCatalogue(() => {});
  assert.equal(rejected.entries.length, 0);
  assert.ok(rejected.issues.length > 0);
});


test('Windows launch 覆盖决定精确匹配，内存副本删除两层 preLaunchTask 而不改源配置', async () => {
  const fake = createApi();
  const catalogue = await fake.model.loadCatalogue(() => {});
  const config = catalogue.configurations.find(value => value.title === 'Development Editor');
  const target = config.tasks.Build.spec.label;
  const original = {
    name: 'Windows 调试覆盖', type: 'cppvsdbg', request: 'launch', preLaunchTask: 'Other platform build',
    program: 'base-program', args: ['-base'], postDebugTask: 'Cleanup after debug',
    windows: { preLaunchTask: target, program: 'win-program', args: ['-windows'], env: { KEEP: 'yes' } },
    linux: { preLaunchTask: 'Linux build', program: 'linux-program' },
  };
  const entry = { id: 'windows-override', origin: config.origin, config: original };
  assert.deepEqual(fake.model.matchingLaunches(config, [entry]), [entry]);
  assert.equal(fake.model.launchPreLaunchTask(original), target);
  const topOnlyMatch = clone(original);
  topOnlyMatch.preLaunchTask = target;
  topOnlyMatch.windows.preLaunchTask = 'Actually another build';
  assert.deepEqual(fake.model.matchingLaunches(config, [{ ...entry, config: topOnlyMatch }]), []);
  const noWindowsPreBuild = clone(original);
  noWindowsPreBuild.preLaunchTask = target;
  noWindowsPreBuild.windows.preLaunchTask = null;
  assert.deepEqual(fake.model.matchingLaunches(config, [{ ...entry, config: noWindowsPreBuild }]), []);

  const snapshot = clone(original);
  const prepared = fake.model.withoutPreLaunchTask(original);
  assert.equal('preLaunchTask' in prepared, false);
  assert.equal('preLaunchTask' in prepared.windows, false);
  assert.equal(fake.model.launchPreLaunchTask(prepared), undefined);
  assert.equal(prepared.postDebugTask, original.postDebugTask);
  assert.equal(prepared.windows.program, original.windows.program);
  assert.deepEqual(prepared.windows.args, original.windows.args);
  assert.deepEqual(prepared.linux, original.linux);
  prepared.windows.env.KEEP = 'modified copy';
  prepared.windows.args.push('-copy-only');
  assert.deepEqual(original, snapshot, '用户 launch 源 JSON 及其嵌套值保持不变');
});
