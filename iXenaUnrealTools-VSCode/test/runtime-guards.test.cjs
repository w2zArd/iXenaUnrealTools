'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathApi, pathKey, inspectEngine, discoverEngines, uhtArguments } = require('../dist/engineSupport');
const { resolveBuildTool } = require('../dist/dotnetResolver');
const { inspectUeTask } = require('../dist/ueTaskModel');

test('路径值异常时给出可理解的错误，不再抛 startsWith TypeError', () => {
  for (const invalid of [undefined, null, '', 0, {}]) {
    assert.throws(() => pathApi(invalid), /UE 路径未定义或不是有效字符串/);
    assert.throws(() => pathKey(invalid), /UE 路径未定义或不是有效字符串/);
  }
});

test('引擎列表中的空目录会被跳过而不是使全部发现失败', async () => {
  assert.equal(await inspectEngine(undefined), undefined);
  assert.deepEqual(await discoverEngines([undefined, null, '', 42], [undefined, '', null, false]), []);
});

test('UBT 入口和 UHT 目标缺少路径时明确提示，不访问 undefined.startsWith', async () => {
  await assert.rejects(resolveBuildTool({ engineRoot: undefined }), /所选 UE 引擎路径为空/);
  assert.throws(() => uhtArguments('GameEditor', 'Win64', 'Development', undefined), /UHT 参数无效/);
});

test('UE 任务参数包含未定义元素时只拒绝该任务，不产生 startsWith TypeError', () => {
  const raw = {
    type: 'shell', label: 'GameEditor Win64 Development Build',
    command: String.raw`Engine\Build\BatchFiles\Build.bat`,
    args: ['GameEditor', 'Win64', 'Development', undefined],
    options: { cwd: String.raw`D:\Apps\UnrealEngine\UE_5.9` }
  };
  assert.throws(() => inspectUeTask(raw, {
    cwd: String.raw`D:\Develop\UE\Game`, scopeKey: 'test', resolve: value => value
  }), /args\[3\] 必须是字符串/);
});
