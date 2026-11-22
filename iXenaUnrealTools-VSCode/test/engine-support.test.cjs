'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { discoverEngines, readEngineVersion, engineAssociationMismatch, isUhtRelevantHeader,
  uhtArguments, readProjectEngineAssociation } = require('../dist/engineSupport');
const { resolveBuildTool } = require('../dist/dotnetResolver');

async function createUE(parent, name, minor, runtimeLayout = 'win-x64') {
  const root = path.join(parent, name);
  await fs.mkdir(path.join(root, 'Engine', 'Build', 'BatchFiles'), { recursive: true });
  await fs.mkdir(path.join(root, 'Engine', 'Binaries', 'DotNET', 'UnrealBuildTool'), { recursive: true });
  await fs.mkdir(path.join(root, 'Engine', 'Binaries', 'ThirdParty', 'DotNet', minor === 0 ? 'Windows' : minor === 1 ? '6.0.302' : '10.0', runtimeLayout), { recursive: true });
  const runtimeDir = path.join(root, 'Engine', 'Binaries', 'ThirdParty', 'DotNet', minor === 0 ? 'Windows' : minor === 1 ? '6.0.302' : '10.0', runtimeLayout);
  await fs.mkdir(path.join(root, 'Engine', 'Build'), { recursive: true });
  await fs.writeFile(path.join(root, 'Engine', 'Build', 'Build.version'), JSON.stringify({ MajorVersion: 5, MinorVersion: minor, PatchVersion: 3 }));
  await fs.writeFile(path.join(root, 'Engine', 'Build', 'BatchFiles', 'Build.bat'), '');
  if (minor === 0) await fs.writeFile(path.join(root, 'Engine', 'Binaries', 'DotNET', 'UnrealBuildTool', 'UnrealBuildTool.exe'), '');
  else await fs.writeFile(path.join(root, 'Engine', 'Binaries', 'DotNET', 'UnrealBuildTool', 'UnrealBuildTool.dll'), '');
  await fs.writeFile(path.join(runtimeDir, 'dotnet.exe'), '');
  return root;
}

test('discovers UE5.0, 5.1 and 5.9, excludes UE4/non-engines, avoids recursive scan', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ixena-engine-test-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const ue50 = await createUE(temp, 'UE_5.0', 0, 'windows');
  await createUE(temp, 'UE_5.1', 1, 'windows');
  await createUE(temp, 'UE_5.9', 9);
  await fs.mkdir(path.join(temp, 'UE_4.27', 'Engine', 'Build'), { recursive: true });
  await fs.writeFile(path.join(temp, 'UE_4.27', 'Engine', 'Build', 'Build.version'), JSON.stringify({ MajorVersion: 4, MinorVersion: 27 }));
  const discovered = await discoverEngines([ue50, ue50], [temp]);
  assert.deepEqual(discovered.map(item => item.version.minor), [9, 1, 0]);
  assert.equal((await readEngineVersion(ue50)).minor, 0);
});

test('UE5.0 with only UBT.exe runs directly, no forced UE5.9 dotnet path', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ixena-engine-legacy-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = await createUE(temp, 'UE_5.0', 0, 'windows');
  const tool = await resolveBuildTool({ engineRoot: root });
  assert.equal(tool.source, 'legacy-exe');
  assert.equal(tool.prefixArgs.length, 0);
  assert.match(tool.process, /UnrealBuildTool\.exe$/);
});

test('UE5.1 windows, UE5.9 win-x64 dotnet layouts both load', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ixena-engine-sdks-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const roots = [await createUE(temp, 'UE_5.1', 1, 'windows'), await createUE(temp, 'UE_5.9', 9)];
  for (const root of roots) {
    const tool = await resolveBuildTool({ engineRoot: root, env: { DOTNET_HOST_PATH: '/other/engine/dotnet.exe' } });
    assert.match(tool.process, /dotnet\.exe$/);
    assert.equal(tool.prefixArgs.length, 1);
    assert.match(tool.prefixArgs[0], /UnrealBuildTool\.dll$/);
  }
});

test('UHT is a standalone target mode (not a full C++ build) with inner project quotes', () => {
  const args = uhtArguments('UE5TestEditor', 'Win64', 'Development', 'D:\\Game Folder\\UE5Test.uproject');
  assert.equal(args[0], '-Mode=UnrealHeaderTool');
  assert.deepEqual(args.slice(1), ['-Target=UE5TestEditor Win64 Development -Project="D:\\Game Folder\\UE5Test.uproject"']);
  assert.throws(() => uhtArguments('bad target', 'Win64', 'Development', 'x.uproject'));
});

test('project association warning only for explicitly numbered versions', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ixena-project-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const project = path.join(temp, 'P.uproject');
  await fs.writeFile(project, JSON.stringify({ EngineAssociation: '5.4' }));
  const association = await readProjectEngineAssociation(project);
  assert.equal(association, '5.4');
  assert.equal(engineAssociationMismatch(association, { major: 5, minor: 9, patch: 0 }), true);
  assert.equal(engineAssociationMismatch('5.9', { major: 5, minor: 9, patch: 2 }), false);
  assert.equal(engineAssociationMismatch('{SOME-GUID}', { major: 5, minor: 0, patch: 0 }), false);
});

test('auto-UHT restricts to project reflection headers under Source/Plugins only', () => {
  const project = 'D:\\Game\\UE5Test.uproject';
  assert.equal(isUhtRelevantHeader('D:\\Game\\Source\\P.h', project, 'UCLASS()\nGENERATED_BODY()'), true);
  assert.equal(isUhtRelevantHeader('D:\\Game\\Plugins\\P\\Source\\P.h', project, 'UPROPERTY()'), true);
  assert.equal(isUhtRelevantHeader('D:\\Game\\Source\\P.cpp', project, 'GENERATED_BODY()'), false);
  assert.equal(isUhtRelevantHeader('D:\\Game\\Intermediate\\P.h', project, 'GENERATED_BODY()'), false);
  assert.equal(isUhtRelevantHeader('D:\\Other\\Source\\P.h', project, 'GENERATED_BODY()'), false);
  assert.equal(isUhtRelevantHeader('D:\\Game\\Source\\P.h', project, '// plain header'), false);
});
