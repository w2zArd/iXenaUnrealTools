'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { optionalPathKey, chooseEngineRoot, readEngineVersion } = require('../dist/engineSupport');

const taskRoot = String.raw`D:\Apps\UnrealEngine\UE_5.9`;

test('status-bar optional engine paths do not throw when input missing', () => {
  for (const invalid of [undefined, null, false, 0, '', '  ']) {
    assert.equal(optionalPathKey(invalid), undefined);
  }
  assert.equal(optionalPathKey(String.raw`D:\Apps\UnrealEngine\UE_5.9\\`),
    optionalPathKey(taskRoot));
});

test('missing/invalid workspace engine selection falls back to UE-generated task engine', () => {
  const cases = [undefined, null, {}, [], '', '   ', '${env:UE_ROOT}', 3];
  for (const saved of cases) {
    const selected = chooseEngineRoot(saved, taskRoot, 'Development Editor');
    assert.equal(selected.source, 'task');
    assert.equal(selected.root, taskRoot);
    if (saved !== undefined) assert.match(selected.warning, /任务中定义的引擎目录/);
  }
});

test('explicit absolute selected UE engine takes priority, invalid task cannot silently fall back to arbitrary engineRoots', () => {
  const other = String.raw`D:\Apps\UnrealEngine\UE_5.8`;
  assert.equal(chooseEngineRoot(other, taskRoot, 'Development Editor').root, other);
  assert.throws(() => chooseEngineRoot(undefined, null, 'Debug Editor'), /Debug Editor.*没有可用的 UE 引擎目录/);
  assert.throws(() => chooseEngineRoot('relative\\UE_5.9', undefined, 'Development Game'),
    /Development Game.*Build.bat.*options.cwd/);
});

test('engine version candidate scan is tolerant of undefined/empty values', async () => {
  assert.equal(await readEngineVersion(undefined), undefined);
  assert.equal(await readEngineVersion(null), undefined);
  assert.equal(await readEngineVersion(''), undefined);
});
