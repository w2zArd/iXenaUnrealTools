'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

/**
 * 直接调用 BuildController.prepareTasks()，覆盖实际点击 Build 进入的构建准备路径。
 * 0.3.3 在这里错误地把 TaskEntry 当作 BuildConfiguration，之前的解析单元测试没发现。
 */
function loadController() {
  const fake = {
    TaskScope: { Workspace: 2 },
    TaskGroup: { Build: { id: 'build' }, Clean: { id: 'clean' } },
    TaskRevealKind: { Always: 1, Never: 2, Silent: 3 },
    TaskPanelKind: { Dedicated: 1, Shared: 2, New: 3 },
    workspace: {
      getConfiguration: () => ({ get: (_name, fallback) => fallback }),
      saveAll: async () => true
    }
  };
  const filename = path.join(__dirname, '..', 'dist', 'extension.js');
  const original = Module._load;
  delete require.cache[filename];
  Module._load = function(request, parent, isMain) {
    if (request === 'vscode') return fake;
    return original.call(this, request, parent, isMain);
  };
  try { return require(filename).BuildController; }
  finally { Module._load = original; }
}

function mockEntry(projectPath, action = 'Build', label = 'UE5TestEditor Win64 Development Build') {
  const spec = {
    label, scopeKey: 'workspace:starchain', target: 'UE5TestEditor',
    platform: 'Win64', configuration: 'Development', action,
    projectPath, engineRoot: String.raw`D:\Apps\UnrealEngine\UE_5.9`,
    cwd: String.raw`D:\Apps\UnrealEngine\UE_5.9`,
    args: ['UE5TestEditor', 'Win64', 'Development', projectPath, '-WaitMutex'],
    dependencies: [], problemMatchers: ['$msCompile'], configKey: 'starchain-editor-development'
  };
  return { spec, raw: { problemMatcher: '$msCompile' }, env: {},
    origin: { key: 'workspace:starchain', folder: undefined, label: 'Project.code-workspace' } };
}

function mockedController(BuildController, entries, remembered) {
  const instance = Object.create(BuildController.prototype);
  instance.catalogue = { entries, configurations: [], launches: [], issues: [] };
  instance.context = { workspaceState: { get: key => {
    assert.match(key, /^engine\.[0-9a-f]{64}$/);
    return remembered;
  } } };
  instance.log = () => {};
  instance.resolveSelectedTool = async (_entry, engineRoot) => ({
    process: path.win32.join(engineRoot, 'dotnet.exe'),
    prefixArgs: ['UnrealBuildTool.dll']
  });
  instance.buildTaskEnvironment = (_entry, _engineRoot, _tool) => ({ TEST: 'yes' });
  return instance;
}

async function projectFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ixena-build-config-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'UE5Test.uproject');
  await fs.writeFile(project, '{}');
  return project;
}

for (const remembered of [undefined, String.raw`D:\Apps\UnrealEngine\UE_5.8`]) {
  test(`prepareTasks uses TaskEntry.spec.projectPath, engine override: ${remembered ?? 'none'}`, async t => {
    const BuildController = loadController();
    const project = await projectFixture(t);
    const entry = mockEntry(project);
    const controller = mockedController(BuildController, [entry], remembered);
    const planned = await controller.prepareTasks(entry, { isCancellationRequested: false });
    assert.equal(planned.length, 1);
    assert.equal(planned[0].projectPath, project);
    assert.equal(planned[0].cwd, remembered ?? entry.spec.engineRoot);
    assert.equal(planned[0].args[0], 'UnrealBuildTool.dll');
    assert.equal(planned[0].args[4], project);
    assert.deepEqual(planned[0].problemMatchers, ['$msCompile']);
    assert.deepEqual(planned[0].env, { TEST: 'yes' });
  });
}

test('Clean and Rebuild use the same selected engine and valid .uproject', async t => {
  const BuildController = loadController();
  const project = await projectFixture(t);
  const clean = mockEntry(project, 'Clean', 'UE5TestEditor Win64 Development Clean');
  const rebuild = mockEntry(project, 'Rebuild', 'UE5TestEditor Win64 Development Rebuild');
  rebuild.spec.dependencies = [clean.spec.label];
  const chosen = String.raw`D:\Apps\UnrealEngine\UE_5.8`;
  const controller = mockedController(BuildController, [rebuild, clean], chosen);
  const planned = await controller.prepareTasks(rebuild, { isCancellationRequested: false });
  assert.deepEqual(planned.map(item => item.label), [clean.spec.label, rebuild.spec.label]);
  assert.deepEqual(planned.map(item => item.projectPath), [project, project]);
  assert.deepEqual(planned.map(item => item.cwd), [chosen, chosen]);
});

test('missing project yields precise error before launching dotnet', async t => {
  const BuildController = loadController();
  const project = await projectFixture(t);
  const entry = mockEntry(project.replace(/\.uproject$/, '-deleted.uproject'));
  const controller = mockedController(BuildController, [entry], undefined);
  let toolStarted = false;
  controller.resolveSelectedTool = async () => { toolStarted = true; throw new Error('Unexpected tool launch'); };
  await assert.rejects(controller.prepareTasks(entry, { isCancellationRequested: false }), /项目文件不存在/);
  assert.equal(toolStarted, false);
});
