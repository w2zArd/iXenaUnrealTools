'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {planSourcePair, rankSourcePairs, findUeModuleRoot} = require('../dist/sourcePairModel.js');

test('UE module pairs Public header with Private source preserving nested relative paths', () => {
  const base = '/Game/Plugins/PlanetWorld/Source/PlanetWorld';
  const header = `${base}/Public/Planet/Terrain/PlanetWorld.h`;
  const expected = `${base}/Private/Planet/Terrain/PlanetWorld.cpp`;
  const plan = planSourcePair(header);
  assert.equal(plan.moduleRoot, base);
  assert.deepEqual(plan.directPaths.slice(0, 2), [
    `${base}/Public/Planet/Terrain/PlanetWorld.cpp`, expected
  ]);
  const reversed = planSourcePair(expected);
  assert.equal(reversed.moduleRoot, base);
  assert.ok(reversed.directPaths.includes(header));
  assert.ok(reversed.directPaths.indexOf(header) < reversed.directPaths.indexOf(`${base}/Classes/Planet/Terrain/PlanetWorld.h`));
});

test('UE Classes header pairs to Private source; Private source looks in Public and Classes', () => {
  const source = '/Game/Source/SW/Private/Gameplay/Actor.cpp';
  const classes = '/Game/Source/SW/Classes/Gameplay/Actor.h';
  assert.ok(planSourcePair(classes).directPaths.includes(source));
  assert.ok(planSourcePair(source).directPaths.includes(classes));
});

test('UE engine category is included in module root, avoiding matching other modules', () => {
  const header = '/UE/Engine/Source/Runtime/Engine/Public/Camera/CameraComponent.h';
  assert.equal(findUeModuleRoot(header), '/UE/Engine/Source/Runtime/Engine');
  assert.ok(planSourcePair(header).directPaths.includes(
    '/UE/Engine/Source/Runtime/Engine/Private/Camera/CameraComponent.cpp'));
});

test('Windows paths, mixed case suffixes, CPP↔h/hpp and stand-alone files work', () => {
  const header = String.raw`D:\Projects\Project\Plugins\UI\Source\UI\Public\Widget.H`;
  const target = String.raw`D:\Projects\Project\Plugins\UI\Source\UI\Private\Widget.cpp`;
  const plan = planSourcePair(header);
  assert.equal(plan.moduleRoot, String.raw`D:\Projects\Project\Plugins\UI\Source\UI`);
  assert.ok(plan.directPaths.includes(target));
  assert.ok(planSourcePair(target).directPaths.includes(header.replace(/\.H$/, '.h')));
  const lonely = planSourcePair('/tmp/MyClass.cpp');
  assert.deepEqual(lonely.directPaths, ['/tmp/MyClass.h','/tmp/MyClass.hpp','/tmp/MyClass.hh','/tmp/MyClass.hxx']);
  assert.equal(lonely.moduleRoot, undefined);
});

test('Only C++ file extensions are handled, and generated code is excluded', () => {
  for (const source of ['/tmp/A.generated.h','/tmp/A.gen.cpp','/tmp/A.init.gen.cpp','/tmp/A.generated.cpp','/tmp/A.inl','/tmp/A.Build.cs','/tmp/A.txt','']) {
    assert.equal(planSourcePair(source), undefined, source);
  }
  assert.equal(planSourcePair('/tmp/MyClass.hpp').targetExtensions[0], '.cpp');
  assert.equal(planSourcePair('/tmp/MyClass.cc').targetExtensions[0], '.h');
});

test('Ranking filters unrelated and generated classes and prefers same-module candidates', () => {
  const plan = planSourcePair('/Game/Source/SW/Public/Actor.h');
  assert.deepEqual(rankSourcePairs(plan, [
    '/Game/Plugins/Other/Source/Other/Private/Actor.cpp',
    '/Game/Source/SW/Private/Actor.cpp',
    '/Game/Source/SW/Private/Actor.generated.cpp',
    '/Game/Source/SW/Private/NotActor.cpp',
    '/Game/Source/SW/Private/Actor.cpp'
  ]), ['/Game/Source/SW/Private/Actor.cpp','/Game/Plugins/Other/Source/Other/Private/Actor.cpp']);
});
