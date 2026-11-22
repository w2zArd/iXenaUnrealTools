'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { analyzeBuildCs, rewriteBuildCs, validateNames, maskCSharp } = require('../dist/dependencyModel');
const { discoverProjects, sectionPaths, findLogs, normalizePanes, resolvePaneRoot, listFiles } = require('../dist/ueWorkspace');

const fixture = `using UnrealBuildTool;\n\npublic class Example : ModuleRules\n{\n    public Example(ReadOnlyTargetRules Target) : base(Target)\n    {\n        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;\n        PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject" });\n        PrivateDependencyModuleNames.AddRange(new string[]\n        {\n            "Engine",\n            "Slate"\n        });\n    }\n}\n`;

test('Build.cs 静态 AddRange 同时读取 Public / Private，精确修改而不改变其它字段', () => {
  const model = analyzeBuildCs(fixture);
  assert.equal(model.groups.Public.editable, true);
  assert.equal(model.groups.Private.editable, true);
  assert.deepEqual(model.groups.Public.values, ['Core', 'CoreUObject']);
  assert.deepEqual(model.groups.Private.values, ['Engine', 'Slate']);
  const edited = rewriteBuildCs(fixture, ['Core', 'CoreUObject', 'InputCore'], ['Engine', 'Slate', 'AIModule'], 'Example');
  assert.match(edited, /"InputCore"/);
  assert.match(edited, /"AIModule"/);
  assert.match(edited, /PCHUsage = PCHUsageMode\.UseExplicitOrSharedPCHs;/);
  assert.equal(analyzeBuildCs(edited).groups.Private.values[2], 'AIModule');
  assert.equal(rewriteBuildCs(fixture, ['Core', 'CoreUObject'], ['Engine', 'Slate']), fixture);
});

test('复杂 Build.cs 引用、条件依赖和动态表达式保持只读，修改被拒绝', () => {
  const conditional = fixture.replace('PrivateDependencyModuleNames.AddRange', 'if (Target.Platform == UnrealTargetPlatform.Win64) PrivateDependencyModuleNames.AddRange');
  assert.equal(analyzeBuildCs(conditional).groups.Private.editable, false);
  assert.throws(() => rewriteBuildCs(conditional, ['Core', 'CoreUObject'], ['Engine'], 'Example'), /无法安全编辑/);
  const multi = fixture.replace('    }\n}', '        PublicDependencyModuleNames.Add("Extra");\n    }\n}');
  assert.equal(analyzeBuildCs(multi).groups.Public.editable, false);
  const dynamic = fixture.replace('"CoreUObject"', 'Target.bBuildEditor ? "UnrealEd" : "CoreUObject"');
  assert.equal(analyzeBuildCs(dynamic).groups.Public.editable, false);
});

test('数组有注释时禁止改写，以免丢失项目中的设计意图', () => {
  const source = fixture.replace('"Core", "CoreUObject"', '"Core", /* 重要理由 */ "CoreUObject"');
  assert.deepEqual(analyzeBuildCs(source).groups.Public.values, ['Core','CoreUObject']);
  assert.equal(analyzeBuildCs(source).groups.Public.editable, false);
  assert.throws(() => rewriteBuildCs(source, ['Core'], ['Engine','Slate']), /包含注释/);
});

test('单个范围缺失时自动插入 AddRange；保留 CRLF、中文以及 emoji 偏移', () => {
  const source = fixture.replace(/\s*PrivateDependencyModuleNames\.AddRange\([\s\S]*?\);/, '').replace(/\n/g, '\r\n').replace('PCHUsage =', '// 🪐 测试\r\n        PCHUsage =');
  assert.equal(analyzeBuildCs(source).groups.Private.missing, true);
  const edited = rewriteBuildCs(source, ['Core', 'CoreUObject'], ['Slate', 'RHI'], 'Example');
  assert.match(edited, /PrivateDependencyModuleNames.AddRange\(new string\[\] \{ "Slate", "RHI" \}\);/);
  assert.match(edited, /\/\/ 🪐 测试/);
  assert.ok(edited.includes('\r\n'));
  assert.equal(analyzeBuildCs(edited).groups.Private.editable, true);
});

test('模块名称防注入，拒绝重复或依赖自身', () => {
  assert.deepEqual(validateNames(['Engine', 'Slate']), ['Engine', 'Slate']);
  assert.throws(() => validateNames(['Engine', 'engine']), /重复/);
  assert.throws(() => validateNames(['Engine\"); System.IO.File.Delete(']), /只能包含/);
  assert.throws(() => validateNames(['Example'], 'Example'), /自身/);
});

test('工作区配置可沿用 multiExplorer.panes 并支持具名多根路径', () => {
  const panes = normalizePanes([{ label: '✳️ 公有', roots: ['${workspaceFolder:➡️ 当前项目}/Source/Example/Public'] }]);
  assert.equal(panes.length, 1);
  assert.equal(resolvePaneRoot(panes[0].roots[0], [{ name: '➡️ 当前项目', directory: '/tmp/MyGame' },
    { name: '🚀 UE引擎', directory: '/tmp/UE' }], '/tmp'), '/tmp/MyGame/Source/Example/Public');
  assert.throws(() => resolvePaneRoot('${workspaceFolder}/Source', [{ name:'A',directory:'/tmp/A' },
    { name:'B',directory:'/tmp/B' }], '/tmp'), /多根/);
  assert.deepEqual(normalizePanes([{}, 1, {label:'A',roots:['/ok']}]).map(p=>p.label), ['A']);
});

test('识别主项目/插件/Target.cs/Build.cs/日志，忽略 Intermediate 和缓存', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ixena-ue-toolkit-'));
  t.after(() => fs.rm(base, { recursive:true, force:true }));
  const mk = async (file, text='') => { await fs.mkdir(path.dirname(path.join(base,file)),{ recursive:true }); await fs.writeFile(path.join(base,file),text); };
  await mk('UE5Test.uproject','{}');
  await mk('Source/UE5Test.Target.cs','');
  await mk('Source/UE5Test/UE5Test.Build.cs','');
  await mk('Source/UE5Test/Public/SWActor.h','');
  await mk('Source/UE5Test/Private/SWActor.cpp','');
  await mk('Source/UE5Test/Intermediate/Ignore.cpp','');
  await mk('Plugins/PlanetWorld/PlanetWorld.uplugin','{}');
  await mk('Plugins/PlanetWorld/Source/PlanetWorld/PlanetWorld.Build.cs','');
  await mk('Plugins/PlanetWorld/Source/PlanetWorld/Public/PWPlanet.h','');
  await mk('Saved/Logs/UE5Test.log','Log Test');
  const projects = await discoverProjects([path.join(base,'UE5Test.uproject')]);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].scopes.length,2);
  assert.deepEqual(projects[0].scopes[0].modules.map(m=>m.name),['UE5Test']);
  assert.equal(projects[0].scopes[0].targets.length,1);
  assert.equal(projects[0].scopes[1].name,'PlanetWorld');
  assert.equal((await sectionPaths(projects[0].scopes[1],'Public')).length,1);
  const files = await listFiles(path.join(base,'Source/UE5Test'));
  assert.equal(files.some(f=>f.name==='Intermediate'),false);
  const logs = await findLogs(projects);
  assert.equal(logs.length,1);
  assert.equal(logs[0].kind,'项目');
});
