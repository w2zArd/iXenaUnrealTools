'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { discoverLocalizationTargets, createTargetPlan, addCulturePlan, runnerCommand } = require('../dist/localizationConfig');
const { configureI18n } = require('../dist/i18n');
configureI18n('en');

async function fixture(t, { source = false, content = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ixena-loc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectPath = path.join(root, 'UE5Test.uproject');
  await fs.writeFile(projectPath, '{}');
  if (source) { await fs.mkdir(path.join(root, 'Source')); }
  if (content) { await fs.mkdir(path.join(root, 'Content')); }
  return { root, projectPath };
}
async function write(filename, text) { await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, text); }
async function applyPlan(plan) { for (const file of plan.files) { await write(file.path, file.content); } }
function fileFor(plan, action) { return plan.files.find(file => file.path === plan.target.configs[action]); }
async function plugin(root, name) {
  const folder = path.join(root, 'Plugins', 'Category', name);
  await write(path.join(folder, `${name}.uplugin`), '{}');
  await fs.mkdir(path.join(folder, 'Content'));
  return folder;
}
function common(directory = 'Content/Localization/Game') {
  return `[CommonSettings]\nSourcePath=${directory}\nDestinationPath=${directory}\nManifestName=Game.manifest\nArchiveName=Game.archive\nNativeCulture=en\nCulturesToGenerate=en\nCulturesToGenerate=zh-Hans\n`;
}

test('new Blueprint-only target plans native UE operations without a nonexistent Source gather', async t => {
  const { root, projectPath } = await fixture(t);
  const plan = await createTargetPlan(projectPath, root, 'Game', 'en', ['zh-Hans', 'en', 'ja']);
  assert.equal(plan.files.length, 5);
  assert.deepEqual(plan.target.cultures, ['en', 'zh-Hans', 'ja']);
  assert.equal(plan.target.managed, true);
  const gather = fileFor(plan, 'gather').content;
  assert.match(gather, /CommandletClass=GatherTextFromAssets/);
  assert.doesNotMatch(gather, /GatherTextFromSource/);
  assert.match(gather, /IncludePathFilters=Content\/\*/);
  assert.match(gather, /PackageFileNameFilters=\*\.uasset/);
  assert.match(gather, /PackageFileNameFilters=\*\.umap/);
  assert.match(gather, /CommandletClass=GenerateGatherManifest/);
  assert.match(fileFor(plan, 'export').content, /bExportLoc=true/);
  assert.match(fileFor(plan, 'import').content, /bImportLoc=true/);
  assert.match(fileFor(plan, 'compile').content, /ResourceName=Game.locres/);
  assert.ok(plan.target.warnings.some(value => /Dashboard/.test(value)));
  assert.equal(await fs.stat(plan.target.metadataPath).catch(() => undefined), undefined, 'plan does not write files');
  assert.equal(await fs.stat(path.join(root, 'Config', 'DefaultEditor.ini')).catch(() => undefined), undefined);
  await applyPlan(plan);
  const discovered = await discoverLocalizationTargets([projectPath]);
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].id, plan.target.id);
  assert.deepEqual(discovered[0].configs, plan.target.configs);
  assert.deepEqual(discovered[0].cultures, ['en', 'ja', 'zh-Hans']);
  assert.deepEqual(discovered[0].poFiles, []);
  await assert.rejects(createTargetPlan(projectPath, root, 'Game', 'en', ['ja']), /already exists/);
});

test('C++ project gathers Source and Config with modern settings and project-relative portable paths', async t => {
  const { root, projectPath } = await fixture(t, { source: true });
  await write(path.join(root, 'Config', 'DefaultGame.ini'), '[Core]\n');
  const plan = await createTargetPlan(projectPath, root, 'Game', 'en', ['fr']);
  const gather = fileFor(plan, 'gather').content;
  assert.match(gather, /SearchDirectoryPaths=Source/);
  assert.match(gather, /SearchDirectoryPaths=Config/);
  assert.match(gather, /FileNameFilters=\*\.cpp/);
  assert.doesNotMatch(gather, /SourceCulture=|SourceFileSearchFilters=|PackageExtensions=/);
  assert.doesNotMatch(gather, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('project and nested plugin targets sharing the same name remain separate and merge all cultures', async t => {
  const { root, projectPath } = await fixture(t);
  const pluginA = await plugin(root, 'Plugin A');
  const pluginB = await plugin(root, 'PluginB');
  for (const scope of [root, pluginA, pluginB]) {
    const plan = await createTargetPlan(projectPath, scope, 'Game', 'en', ['zh-Hans']);
    await applyPlan(plan);
    await write(path.join(plan.target.dataDirectory, 'en', 'Game.po'), 'msgid ""\nmsgstr ""\n');
    await write(path.join(plan.target.dataDirectory, 'zh-Hans', 'Game.po'), 'msgid ""\nmsgstr ""\n');
    if (scope === pluginA) {
      await write(path.join(plan.target.dataDirectory, 'ja', 'Game.po'), 'msgid ""\nmsgstr ""\n');
      assert.match(fileFor(plan, 'gather').content, /SourcePath=Plugins\/Category\/Plugin A\/Content\/Localization\/Game/);
      assert.match(fileFor(plan, 'gather').content, /IncludePathFilters=Plugins\/Category\/Plugin A\/Content\/\*/);
    }
  }
  const targets = await discoverLocalizationTargets([projectPath, projectPath]);
  assert.equal(targets.length, 3);
  assert.equal(new Set(targets.map(target => target.id)).size, 3);
  assert.equal(targets.find(target => target.scopeRoot === pluginA).poFiles.length, 3);
  assert.deepEqual(targets.find(target => target.scopeRoot === pluginA).cultures, ['en', 'ja', 'zh-Hans']);
  assert.equal(targets.find(target => target.scopeRoot === pluginB).poFiles.length, 2);
});

test('existing UE INI keys and sections are case-insensitive and retain their original configuration path', async t => {
  const { root, projectPath } = await fixture(t);
  const filename = path.join(root, 'Config', 'Localization', 'DoesNotMatchTargetName.INI');
  const original = '[COMMONSETTINGS]\r\nsOuRcEpAtH="Content/Localization/Actual"\r\nDESTINATIONPATH="Content/Localization/Actual"\r\nMANIFESTNAME=Actual.manifest\r\nNATIVECULTURE=en\r\n+CulturesToGenerate=en\r\n+CulturesToGenerate=zh-Hans\r\n+CulturesToGenerate=fr\r\n-CulturesToGenerate=fr\r\n\r\n[GATHERTEXTSTEP0]\r\nCOMMANDLETCLASS=GatherTextFromAssets\r\n';
  await write(filename, original);
  const targets = await discoverLocalizationTargets([projectPath]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].name, 'Actual');
  assert.equal(targets[0].configs.gather, filename);
  assert.equal(targets[0].managed, false);
  assert.deepEqual(targets[0].cultures, ['en', 'zh-Hans']);
  assert.equal(await fs.readFile(filename, 'utf8'), original);
});

test('PO files and targets are discovered even without commandlet configuration', async t => {
  const { root, projectPath } = await fixture(t);
  const filename = path.join(root, 'Content', 'Localization', 'Menu', 'pt-BR', 'Menu.po');
  await write(filename, 'msgid "Play"\nmsgstr "Jogar"\n');
  const targets = await discoverLocalizationTargets([projectPath]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].name, 'Menu');
  assert.deepEqual(targets[0].configs, {});
  assert.deepEqual(targets[0].poFiles, [{ culture: 'pt-BR', path: filename }]);
  assert.equal(targets[0].nativeCulture, undefined);
});

test('export destination and import source may be separate from the archive data directory', async t => {
  const { root, projectPath } = await fixture(t);
  await write(path.join(root, 'Config', 'Localization', 'Game_Export.ini'),
    common().replace('DestinationPath=Content/Localization/Game', 'DestinationPath=Translations/Game')
    + '\n[GatherTextStep0]\nCommandletClass=InternationalizationExport\nbExportLoc=true\n');
  const po = path.join(root, 'Translations', 'Game', 'zh-Hans', 'Game.po');
  await write(po, 'msgid "Play"\nmsgstr "开始"\n');
  const targets = await discoverLocalizationTargets([projectPath]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].dataDirectory, path.join(root, 'Content', 'Localization', 'Game'));
  assert.deepEqual(targets[0].poFiles, [{ culture: 'zh-Hans', path: po }]);
});

test('combined pipelines are not silently exposed as a single import or compile action', async t => {
  const { root, projectPath } = await fixture(t);
  await write(path.join(root, 'Config', 'Localization', 'Game.ini'), common()
    + '\n[GatherTextStep0]\nCommandletClass=GenerateGatherManifest\n'
    + '\n[GatherTextStep1]\nCommandletClass=GenerateTextLocalizationResource\n');
  const [target] = await discoverLocalizationTargets([projectPath]);
  assert.deepEqual(target.configs, {});
  assert.ok(target.warnings.some(value => /Combined/.test(value)));
});

test('scope, localization directory and PO file symlinks cannot escape discovery', async t => {
  const { root, projectPath } = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ixena-loc-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await write(path.join(outside, 'Outside.uplugin'), '{}');
  await write(path.join(outside, 'Content', 'Localization', 'Secret', 'en', 'Secret.po'), 'secret');
  await fs.mkdir(path.join(root, 'Plugins'));
  await fs.symlink(outside, path.join(root, 'Plugins', 'Escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.mkdir(path.join(root, 'Content', 'Localization'), { recursive: true });
  await fs.symlink(path.join(outside, 'Content', 'Localization', 'Secret'), path.join(root, 'Content', 'Localization', 'Alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const insideCulture = path.join(root, 'Content', 'Localization', 'Game', 'en');
  await fs.mkdir(insideCulture, { recursive: true });
  await fs.symlink(path.join(outside, 'Content', 'Localization', 'Secret', 'en', 'Secret.po'), path.join(insideCulture, 'Secret.po'));
  const targets = await discoverLocalizationTargets([projectPath]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].name, 'Game');
  assert.deepEqual(targets[0].poFiles, []);
  await assert.rejects(createTargetPlan(projectPath, path.join(root, 'Plugins', 'Escape'), 'More', 'en', []), /symbolic link/);
});

test('config data paths outside the project or through symlinks are not followed', async t => {
  const { root, projectPath } = await fixture(t);
  const external = path.resolve(root, '..', 'outside-localization-data');
  await write(path.join(root, 'Config', 'Localization', 'Unsafe.ini'), common(external)
    + '\n[GatherTextStep0]\nCommandletClass=GenerateGatherManifest\n');
  await write(path.join(root, 'Config', 'Localization', 'Engine.ini'), common('%LOCENGINEROOT%Content/Localization/Engine')
    + '\n[GatherTextStep0]\nCommandletClass=GenerateGatherManifest\n');
  const targets = await discoverLocalizationTargets([projectPath]);
  assert.equal(targets.length, 1, 'an inert placeholder makes skipped external configurations visible');
  assert.deepEqual(targets[0].configs, {});
  assert.deepEqual(targets[0].poFiles, []);
  assert.equal(targets[0].warnings.length, 2);
  assert.ok(targets[0].warnings.every(value => /Skipped/.test(value)));
});

test('new target rejects unsafe names, cultures and out-of-project scopes without writing', async t => {
  const { root, projectPath } = await fixture(t);
  for (const name of ['../Other', 'Game\nX=Y', 'CON', '', 'a'.repeat(65)]) {
    await assert.rejects(createTargetPlan(projectPath, root, name, 'en', []));
  }
  for (const culture of ['../en', 'en\nCulturesToGenerate=xx', 'en_US', 'en/US', 'NUL']) {
    await assert.rejects(createTargetPlan(projectPath, root, 'Game', 'en', [culture]));
  }
  await assert.rejects(createTargetPlan(projectPath, path.dirname(root), 'Game', 'en', []), /outside|scope/);
  await assert.rejects(createTargetPlan(projectPath, path.join(root, 'Content'), 'Game', 'en', []), /Plugins/);
  assert.equal(await fs.stat(path.join(root, 'Config')).catch(() => undefined), undefined);
});

test('adding a culture preserves comments and custom configuration and includes optimistic expectedText', async t => {
  const { root, projectPath } = await fixture(t);
  const originalPlan = await createTargetPlan(projectPath, root, 'Game', 'en', ['zh-Hans']);
  await applyPlan(originalPlan);
  const gatherFile = originalPlan.target.configs.gather;
  let gather = await fs.readFile(gatherFile, 'utf8');
  gather = gather.replace('[CommonSettings]', '[COMMONSETTINGS]\n; Custom comment\nCustomSetting=keep-me');
  gather = gather.replace(/\n/g, '\r\n');
  await fs.writeFile(gatherFile, gather);
  const [target] = await discoverLocalizationTargets([projectPath]);
  const plan = await addCulturePlan(target, 'fr');
  assert.equal(plan.files.length, 5);
  const changedGather = plan.files.find(file => file.path === gatherFile);
  assert.equal(changedGather.expectedText, gather);
  assert.match(changedGather.content, /; Custom comment\r\nCustomSetting=keep-me/);
  assert.match(changedGather.content, /CulturesToGenerate=fr\r\n\[GatherTextStep0\]/);
  assert.equal(await fs.readFile(gatherFile, 'utf8'), gather, 'planning must not write');
  await applyPlan(plan);
  const [updated] = await discoverLocalizationTargets([projectPath]);
  assert.deepEqual(updated.cultures, ['en', 'fr', 'zh-Hans']);
  const again = await addCulturePlan(updated, 'FR');
  assert.equal((again.files.find(file => file.path === gatherFile).content.match(/CulturesToGenerate=fr/gi) ?? []).length, 1);
});

test('Dashboard targets refuse blind culture edits and modified managed configurations are reported', async t => {
  const { root, projectPath } = await fixture(t);
  const plan = await createTargetPlan(projectPath, root, 'Game', 'en', []);
  await applyPlan(plan);
  await assert.rejects(addCulturePlan({ ...plan.target, managed: false }, 'fr'), /UE Localization Dashboard/);
  const config = plan.target.configs.compile;
  const changed = fileFor(plan, 'compile').content.replaceAll('Content/Localization/Game', 'Content/Localization/Other');
  await fs.writeFile(config, changed);
  const targets = await discoverLocalizationTargets([projectPath]);
  const original = targets.find(target => target.name === 'Game' && target.managed);
  assert.equal(original.configs.compile, undefined);
  assert.ok(original.warnings.some(value => /no longer matches/.test(value)));
  await assert.rejects(addCulturePlan(original, 'fr'), /missing|changed/);
});

test('Windows commandlet execution preserves spaces as single argv values and prefers -Cmd', async t => {
  const { root, projectPath } = await fixture(t);
  const engine = path.join(root, 'Engine Root');
  const executable = path.join(engine, 'Engine', 'Binaries', 'Win64', 'UnrealEditor-Cmd.exe');
  await write(executable, '');
  const config = path.join(root, 'Config', 'Localization', 'My Target.ini');
  const command = runnerCommand(engine, projectPath, config, 'win32');
  assert.equal(command.executable, executable);
  assert.equal(command.args[0], projectPath);
  assert.equal(command.args.find(value => value.startsWith('-config=')), `-config=${config}`);
  assert.ok(command.args.includes('-run=GatherText'));
  assert.ok(command.args.includes('-unattended'));
  assert.ok(command.args.includes('-UTF8Output'));
  assert.ok(!command.args.some(value => value.includes('"')));
  assert.ok(!command.args.includes('-Preview'), 'UE5.0 compatibility');
});

test('macOS application bundle and Linux fallback binaries are resolved without Windows scripts', async t => {
  const { root, projectPath } = await fixture(t);
  const mac = path.join(root, 'UE-Mac'); const linux = path.join(root, 'UE-Linux');
  const macExecutable = path.join(mac, 'Engine', 'Binaries', 'Mac', 'UnrealEditor.app', 'Contents', 'MacOS', 'UnrealEditor');
  const linuxExecutable = path.join(linux, 'Engine', 'Binaries', 'Linux', 'UnrealEditor');
  await write(macExecutable, ''); await write(linuxExecutable, '');
  const config = path.join(root, 'Game.ini');
  assert.equal(runnerCommand(mac, projectPath, config, 'darwin').executable, macExecutable);
  assert.equal(runnerCommand(linux, projectPath, config, 'linux').executable, linuxExecutable);
  assert.throws(() => runnerCommand(mac, projectPath, config, 'win32'), /not found/);
  assert.throws(() => runnerCommand(mac, projectPath, config, 'freebsd'), /not configured/);
  assert.throws(() => runnerCommand(mac, projectPath, 'relative.ini', 'darwin'), /absolute/);
  assert.throws(() => runnerCommand(mac, projectPath, `${config}\n-extra`, 'darwin'), /absolute/);
});

test('targets sharing a data directory use manifest identity and PortableObjectName without cross-associating translations', async t => {
  const { root, projectPath } = await fixture(t);
  const shared = 'Content/Localization/Shared';
  for (const [name, poName] of [['Game', 'GameText.po'], ['Menu', 'MenuText.po']]) {
    const config = common(shared).replace('ManifestName=Game.manifest', `ManifestName=${name}.manifest`)
      .replace('ArchiveName=Game.archive', `ArchiveName=${name}.archive`)
      + `PortableObjectName=${poName}\n\n[GatherTextStep0]\nCommandletClass=InternationalizationExport\nbExportLoc=true\n`;
    await write(path.join(root, 'Config', 'Localization', `${name}_Export.ini`), config);
    await write(path.join(root, shared, 'en', poName), `msgid "${name}"\nmsgstr ""\n`);
  }
  await write(path.join(root, shared, 'en', 'Unrelated.po'), 'msgid "Unrelated"\nmsgstr ""\n');
  const targets = await discoverLocalizationTargets([projectPath]);
  assert.equal(targets.length, 2);
  assert.equal(new Set(targets.map(target => target.id)).size, 2);
  assert.deepEqual(targets.find(target => target.name === 'Game').poFiles.map(file => path.basename(file.path)), ['GameText.po']);
  assert.deepEqual(targets.find(target => target.name === 'Menu').poFiles.map(file => path.basename(file.path)), ['MenuText.po']);
});

test('multiple PO candidates for a culture are reported and not silently selected', async t => {
  const { root, projectPath } = await fixture(t);
  await write(path.join(root, 'Config', 'Localization', 'Game_Export.ini'),
    common().replace('DestinationPath=Content/Localization/Game', 'DestinationPath=Translations/Game')
    + 'PortableObjectName=Game.po\n\n[GatherTextStep0]\nCommandletClass=InternationalizationExport\nbExportLoc=true\n');
  await write(path.join(root, 'Content', 'Localization', 'Game', 'en', 'Game.po'), 'old');
  await write(path.join(root, 'Translations', 'Game', 'en', 'Game.po'), 'new');
  const [target] = await discoverLocalizationTargets([projectPath]);
  assert.deepEqual(target.poFiles, []);
  assert.ok(target.warnings.some(value => /multiple matching PO/.test(value)));
});

test('new targets cannot claim an existing Dashboard target before manifest or PO files are generated', async t => {
  const { root, projectPath } = await fixture(t);
  await write(path.join(root, 'Config', 'Localization', 'Game_Gather.ini'), common()
    + '\n[GatherTextStep0]\nCommandletClass=GatherTextFromAssets\n');
  await assert.rejects(createTargetPlan(projectPath, root, 'Game', 'en', []), /already exists/);
  await fs.rm(path.join(root, 'Config', 'Localization', 'Game_Gather.ini'));
  await write(path.join(root, 'Config', 'DefaultEditor.ini'),
    '[/Script/Localization.LocalizationSettings]\n+GameTargetsSettings=(Name="Game",NativeCultureIndex=0)\n');
  await assert.rejects(createTargetPlan(projectPath, root, 'Game', 'en', []), /already exists/);
  const pluginRoot = await plugin(root, 'OwnedPlugin');
  await write(path.join(pluginRoot, 'OwnedPlugin.uplugin'), JSON.stringify({ LocalizationTargets: [{ Name: 'PluginText', LoadingPolicy: 'Game' }] }));
  await assert.rejects(createTargetPlan(projectPath, pluginRoot, 'PluginText', 'en', []), /already exists/);
});

test('discovery exposes truncation and follows the current UI language', async t => {
  const { root, projectPath } = await fixture(t);
  const plan = await createTargetPlan(projectPath, root, 'Game', 'en', []);
  await applyPlan(plan);
  const [english] = await discoverLocalizationTargets(Array(65).fill(projectPath));
  assert.ok(english.warnings.some(value => /truncated/.test(value)));
  configureI18n('zh-CN');
  try {
    const [chinese] = await discoverLocalizationTargets([projectPath]);
    assert.ok(chinese.warnings.some(value => /本地化面板/.test(value)));
    await assert.rejects(addCulturePlan({ ...chinese, managed: false }, 'fr'), /UE 本地化面板/);
    assert.throws(() => runnerCommand('', projectPath, 'relative.ini'), /绝对路径/);
  } finally { configureI18n('en'); }
});

test('PO cultures missing from import or compile configurations remain editable with an explicit warning', async t => {
  const { root, projectPath } = await fixture(t);
  const plan = await createTargetPlan(projectPath, root, 'Game', 'en', []);
  await applyPlan(plan);
  await write(path.join(plan.target.dataDirectory, 'fr', 'Game.po'), 'msgid "Play"\nmsgstr "Jouer"\n');
  const [target] = await discoverLocalizationTargets([projectPath]);
  assert.equal(target.poFiles[0].culture, 'fr');
  assert.ok(target.warnings.some(value => /fr.*import.*does not enable/.test(value)));
  assert.ok(target.warnings.some(value => /fr.*compile.*does not enable/.test(value)));
  const update = await addCulturePlan(target, 'fr');
  await applyPlan(update);
  const [enabled] = await discoverLocalizationTargets([projectPath]);
  assert.ok(!enabled.warnings.some(value => /does not enable/.test(value)));
});
