'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { unrealClassTemplates, resolveClassName, validateSubdirectory, validateParentHeader,
  makeCustomTemplate, makeClassPlan, inferClassLocation, checkClassPlan, createClassFiles
} = require('../dist/classTemplates');

const actor = unrealClassTemplates.find(template => template.id === 'Actor');
const settings = unrealClassTemplates.find(template => template.id === 'DeveloperSettings');
const plain = unrealClassTemplates.find(template => template.id === 'PlainCpp');
const options = (root, extra = {}) => ({ moduleName: 'UE5Test', moduleDirectory: root,
  template: actor, inputName: 'SWMachine', visibility: 'Public', subdirectory: 'Facilities/Production', ...extra });
async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ixena-classes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}
async function exists(file) { return !!(await fs.stat(file).catch(() => undefined)); }

test('class names normalize an explicit A/U/F prefix while preserving ActorHelper and UserThing stems', () => {
  assert.deepEqual(resolveClassName('SWMachine', actor), { stem: 'SWMachine', className: 'ASWMachine' });
  assert.deepEqual(resolveClassName('ASWMachine', actor), { stem: 'SWMachine', className: 'ASWMachine' });
  assert.deepEqual(resolveClassName('ActorHelper', actor), { stem: 'ActorHelper', className: 'AActorHelper' });
  assert.equal(resolveClassName('UserThing', settings).className, 'UUserThing');
  assert.equal(resolveClassName('FSWHelper', plain).stem, 'SWHelper');
  assert.equal(resolveClassName('AUFO', actor).className, 'AUFO');
});

test('class identifiers reject wrong prefixes, injection, reserved paths and parent self-inheritance', () => {
  for (const value of ['class', '1Machine', 'ASW Machine', 'ASW::Machine', 'ASW/Machine', 'ASW\\Machine',
    'ASWMachine\n', '_Machine', 'ASW__Machine', 'USWMachine', 'FSWMachine', 'AActor', 'CON', 'ANUL', 'ACOM1']) {
    assert.throws(() => resolveClassName(value, actor), Error, value);
  }
});

test('subdirectories and parent includes reject traversal, absolute paths and C++ injection', () => {
  assert.equal(validateSubdirectory(''), undefined);
  assert.equal(validateSubdirectory('Facilities/Production'), undefined);
  assert.equal(validateSubdirectory('Facilities\\Production'), undefined);
  assert.equal(validateParentHeader('Characters/SWCharacterBase.h'), undefined);
  for (const value of ['../Outside', '/Outside', 'D:/Outside', 'Valid/../Outside', 'A//B', 'A/./B',
    'A/NUL', 'A/B/', ' A', 'A/B ', 'A/"B', 'A\nB']) assert.ok(validateSubdirectory(value), value);
  for (const value of ['../Evil.h', 'Foo.cpp', 'Foo.h"\n#include "Other.h', '/tmp/Foo.h']) assert.ok(validateParentHeader(value), value);
});

test('all bundled reflected templates produce matching class declarations with generated include last', () => {
  const root = path.resolve(os.tmpdir(), 'SomeModule');
  assert.equal(unrealClassTemplates.length, 20);
  for (const template of unrealClassTemplates) {
    const plan = makeClassPlan(options(root, { template, inputName: 'SWExample' }));
    assert.match(plan.header, new RegExp(`class UE5TEST_API ${template.prefix}SWExample`));
    assert.match(plan.header, /所属模块：UE5Test/);
    assert.match(plan.source, /#include "Facilities\/Production\/SWExample.h"/);
    const includes = plan.header.split('\n').filter(line => line.startsWith('#include'));
    if (template.reflected) {
      assert.equal(includes.at(-1), '#include "SWExample.generated.h"');
      assert.match(plan.header, /GENERATED_BODY\(\)/);
      assert.match(plan.header, /UCLASS\(/);
    } else {
      assert.doesNotMatch(plan.header, /generated\.h|GENERATED_BODY|UCLASS/);
    }
    if (/Subsystem$/.test(template.id)) assert.doesNotMatch(plan.header, /Blueprintable|UCLASS\(Abstract/);
  }
});

test('Public and Private layout produces portable includes and correct dependency visibility', () => {
  const root = path.resolve(os.tmpdir(), 'Module');
  const publicPlan = makeClassPlan(options(root));
  assert.equal(publicPlan.headerPath, path.join(root, 'Public', 'Facilities', 'Production', 'SWMachine.h'));
  assert.equal(publicPlan.sourcePath, path.join(root, 'Private', 'Facilities', 'Production', 'SWMachine.cpp'));
  assert.equal(publicPlan.dependencies.kind, 'Public');
  const privatePlan = makeClassPlan(options(root, { visibility: 'Private' }));
  assert.equal(path.dirname(privatePlan.headerPath), path.dirname(privatePlan.sourcePath));
  assert.equal(privatePlan.dependencies.kind, 'Private');
  assert.match(privatePlan.source, /^#include "SWMachine.h"/);
});

test('AIController UMG and DeveloperSettings templates state the modules needed for their headers', () => {
  const root = path.resolve(os.tmpdir(), 'Module');
  for (const [id, dependency, include] of [['AIController', 'AIModule', 'AIController.h'],
    ['UserWidget', 'UMG', 'Blueprint/UserWidget.h'], ['DeveloperSettings', 'DeveloperSettings', 'Engine/DeveloperSettings.h']]) {
    const template = unrealClassTemplates.find(template => template.id === id);
    const plan = makeClassPlan(options(root, { template }));
    assert.ok(plan.dependencies.modules.includes(dependency)); assert.ok(plan.header.includes(`#include "${include}"`));
  }
});

test('custom reflected parents are explicitly abstract and plain C++ parents remain non-reflected', () => {
  const root = path.resolve(os.tmpdir(), 'Module');
  const custom = makeCustomTemplate('ASWCharacterBase', 'Characters/SWCharacterBase.h', ['PlanetWorld', 'Engine']);
  const plan = makeClassPlan(options(root, { template: custom }));
  assert.match(plan.header, /UCLASS\(Abstract\)/); assert.match(plan.header, /public ASWCharacterBase/);
  assert.ok(plan.dependencies.modules.includes('PlanetWorld'));
  const cppParent = makeCustomTemplate('FSWContext', 'SWContext.h', []);
  const cppPlan = makeClassPlan(options(root, { template: cppParent }));
  assert.match(cppPlan.header, /public FSWContext/); assert.doesNotMatch(cppPlan.header, /UCLASS|generated\.h/);
  assert.throws(() => makeCustomTemplate('std::string', 'string.h', []));
});

test('context inference selects matching module folders without trusting sibling prefixes', () => {
  const root = path.resolve(os.tmpdir(), 'Module');
  assert.deepEqual(inferClassLocation(root, path.join(root, 'Private', 'AI')), { visibility: 'Private', subdirectory: 'AI' });
  assert.deepEqual(inferClassLocation(root, path.join(root, 'Public', 'Characters', 'Player')), { visibility: 'Public', subdirectory: 'Characters/Player' });
  assert.equal(inferClassLocation(root, `${root}Other/Public`), undefined);
});

test('successful creation writes a UTF-8 pair with Chinese comments and never creates generated.h', async t => {
  const root = await temp(t); const plan = makeClassPlan(options(root));
  await createClassFiles(plan);
  assert.equal(await fs.readFile(plan.headerPath, 'utf8'), plan.header);
  assert.equal(await fs.readFile(plan.sourcePath, 'utf8'), plan.source);
  assert.equal(await exists(path.join(path.dirname(plan.headerPath), 'SWMachine.generated.h')), false);
});

test('case-insensitive module-wide collisions are refused before any files are created', async t => {
  const root = await temp(t); const plan = makeClassPlan(options(root));
  const old = path.join(root, 'Private', 'Other', 'swmachine.h');
  await fs.mkdir(path.dirname(old), { recursive: true }); await fs.writeFile(old, 'KEEP');
  await assert.rejects(createClassFiles(plan), /已经存在同名文件/);
  assert.equal(await fs.readFile(old, 'utf8'), 'KEEP'); assert.equal(await exists(plan.headerPath), false);
});

test('a new collision after preview is detected again during creation', async t => {
  const root = await temp(t); const plan = makeClassPlan(options(root)); await checkClassPlan(plan);
  await fs.mkdir(path.dirname(plan.sourcePath), { recursive: true }); await fs.writeFile(plan.sourcePath, 'KEEP RACE');
  await assert.rejects(createClassFiles(plan), /已经存在同名文件/);
  assert.equal(await fs.readFile(plan.sourcePath, 'utf8'), 'KEEP RACE'); assert.equal(await exists(plan.headerPath), false);
});

test('a second-file write failure rolls back both files created by this invocation', async t => {
  const root = await temp(t); const plan = makeClassPlan(options(root)); let writes = 0;
  await assert.rejects(createClassFiles(plan, async (handle, contents) => {
    if (++writes === 2) throw new Error('Simulated disk failure');
    await handle.writeFile(contents, 'utf8');
  }), /Simulated disk failure.*已回滚/);
  assert.equal(await exists(plan.headerPath), false); assert.equal(await exists(plan.sourcePath), false);
});

test('rollback preserves a generated file changed by another writer', async t => {
  const root = await temp(t); const plan = makeClassPlan(options(root)); let writes = 0;
  await assert.rejects(createClassFiles(plan, async (handle, contents) => {
    if (++writes === 2) { await fs.writeFile(plan.headerPath, 'USER EDIT'); throw new Error('second failure'); }
    await handle.writeFile(contents, 'utf8');
  }), /已保留这些文件/);
  assert.equal(await fs.readFile(plan.headerPath, 'utf8'), 'USER EDIT'); assert.equal(await exists(plan.sourcePath), false);
});

test('symbolic links and junctions in the destination chain cannot escape the module', async t => {
  const root = await temp(t); const outside = await temp(t);
  await fs.symlink(outside, path.join(root, 'Public'), process.platform === 'win32' ? 'junction' : 'dir');
  const plan = makeClassPlan(options(root));
  await assert.rejects(createClassFiles(plan), /符号链接/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('forged output paths outside the module are rejected before any writes', async t => {
  const root = await temp(t); const outside = await temp(t);
  const plan = makeClassPlan(options(root)); plan.headerPath = path.join(outside, 'SWMachine.h');
  await assert.rejects(createClassFiles(plan), /模块边界/); assert.deepEqual(await fs.readdir(outside), []);
});
