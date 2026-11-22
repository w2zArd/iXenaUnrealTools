'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const {
  makeLiveCodingScript, parseLiveCodingResult, decideBuild, explainLiveCodingResult
} = require('../dist/liveCoding');

const project = String.raw`D:\开发 目录\UE5Test (test)'&%.uproject`;
const engine = String.raw`D:\Apps\UnrealEngine\UE_5.9`;

test('PowerShell only receives UTF-8 Base64-encoded paths, never raw interpolated project input', () => {
  const ps = makeLiveCodingScript(project, engine);
  assert.ok(ps.includes(Buffer.from(project, 'utf8').toString('base64')));
  assert.ok(ps.includes(Buffer.from(engine, 'utf8').toString('base64')));
  assert.ok(!ps.includes(project));
  assert.ok(ps.includes('Get-CimInstance'));
  assert.ok(ps.includes('ExecutablePath'));
  assert.ok(ps.includes('IXENA_LIVE_CODING_RESULT:'));
  assert.ok(ps.includes('SendInput'));
  assert.ok(ps.includes('SetForegroundWindow'));
  assert.ok(ps.includes('GetForegroundWindow'));
  assert.ok(ps.includes('GetWindowThreadProcessId'));
  assert.ok(ps.includes('MainWindowHandle'));
  assert.ok(ps.includes('WScript.Shell'));
  assert.ok(ps.includes('AppActivate'));
  assert.ok(ps.includes('::IsForeground([uint32]$editor.ProcessId)'));
  assert.ok(ps.includes('SessionId'));
  assert.ok(ps.includes("if (-not [IXenaLiveCodingKeyboard]::Focus($handle, [uint32]$editor.ProcessId))"));
  assert.ok(ps.includes("if (-not [IXenaLiveCodingKeyboard]::Compile())"));
  assert.ok(ps.includes("Result 'focus-denied'; return"));
  assert.ok(ps.includes("Result 'input-blocked'; return"));
  assert.ok(ps.includes('finally {'));
  assert.ok(ps.includes('[IXenaLiveCodingKeyboard]::Restore()'));
  assert.ok(ps.indexOf('::Focus($handle') < ps.indexOf('::Compile()'));
  assert.ok(ps.indexOf('::Compile()') < ps.indexOf("Result 'dispatched'"));
  assert.ok(ps.includes('multiple-editors'));
  assert.ok(ps.includes('engine-mismatch'));
  assert.ok(ps.includes('IXenaLiveCodingKeyboard]::Compile()'));
});

test('Live Coding rejects invalid or partial .uproject and UE paths', () => {
  for (const invalid of ['', 'test.uproject', '../Project.uproject', 'D:\\Project.txt']) {
    assert.throws(() => makeLiveCodingScript(invalid, engine), /uproject/);
  }
  for (const invalid of ['', 'Engine', 'UE_5.9']) {
    assert.throws(() => makeLiveCodingScript(project, invalid), /引擎路径/);
  }
});

test('PowerShell result parser rejects unsupported, missing or repeated sentinels', () => {
  for (const state of ['dispatched', 'not-running', 'different-project', 'unverified-project', 'multiple-editors', 'engine-mismatch', 'no-window', 'focus-denied', 'different-session', 'input-blocked']) {
    assert.equal(parseLiveCodingResult(`IXENA_LIVE_CODING_RESULT:${state}\r\n`), state);
  }
  for (const raw of ['dispatched', '', 'IXENA_LIVE_CODING_RESULT:SUCCESS',
    'IXENA_LIVE_CODING_RESULT:dispatched\nIXENA_LIVE_CODING_RESULT:dispatched']) {
    assert.throws(() => parseLiveCodingResult(raw), /有效状态/);
  }
});

test('auto build requires an Editor target and only falls back to UBT for no editor or another project', () => {
  assert.equal(decideBuild('auto', 'UE5TestEditor', 'dispatched'), 'live-coding');
  assert.equal(decideBuild('auto', 'UE5TestEditor', 'not-running'), 'ubt');
  assert.equal(decideBuild('auto', 'UE5TestEditor', 'different-project'), 'ubt');
  assert.equal(decideBuild('ubt', 'UE5TestEditor', 'dispatched'), 'ubt');
  assert.equal(decideBuild('auto', 'UE5Test', 'dispatched'), 'ubt');
  for (const unsafe of ['multiple-editors', 'unverified-project', 'engine-mismatch', 'no-window', 'focus-denied', 'different-session', 'input-blocked']) {
    assert.equal(decideBuild('auto', 'UE5TestEditor', unsafe), 'blocked');
    assert.match(explainLiveCodingResult(unsafe, project), /未发送|目录不一致|不可用|拒绝|登录会话/);
  }
});

function loadController() {
  const fakeVscode = {
    workspace: { getConfiguration: () => ({ get: (_name, fallback) => fallback }) }
  };
  const filename = path.join(__dirname, '..', 'dist', 'extension.js');
  const load = Module._load;
  delete require.cache[filename];
  Module._load = function(request, parent, isMain) {
    if (request === 'vscode') return fakeVscode;
    return load.call(this, request, parent, isMain);
  };
  try { return require(filename).BuildController; }
  finally { Module._load = load; }
}

function instanceFor(target, result) {
  const cls = loadController();
  const object = Object.create(cls.prototype);
  const entry = { spec: { projectPath: project, target, platform: 'Win64' }, origin: { folder: undefined } };
  object.checkBuildAllowed = () => {};
  object.debugStarting = false;
  object.ensureSelection = async () => ({ target, platform: 'Win64', projectPath: project,
    tasks: { Build: entry, Rebuild: entry, Clean: entry } });
  const calls = [];
  object.tryLiveCoding = async () => { calls.push('live'); return result; };
  object.executeEntry = async () => { calls.push('ubt'); return { status: 'succeeded' }; };
  object.log = () => {};
  return { object, calls };
}

test('actual BuildController.build dispatches to Live Coding only for a matching running Editor', async () => {
  const { object, calls } = instanceFor('UE5TestEditor', 'dispatched');
  await object.build('Build');
  assert.deepEqual(calls, ['live']);
});

test('actual BuildController.build falls back to UBT when Editor is not running', async () => {
  const { object, calls } = instanceFor('UE5TestEditor', 'not-running');
  await object.build('Build');
  assert.deepEqual(calls, ['live', 'ubt']);
});

test('actual BuildController.build fails closed with multiple editors or mismatched engine', async () => {
  for (const result of ['multiple-editors', 'unverified-project', 'engine-mismatch', 'no-window', 'focus-denied', 'different-session', 'input-blocked']) {
    const { object, calls } = instanceFor('UE5TestEditor', result);
    await assert.rejects(object.build('Build'), /未发送|目录不一致|不可用|拒绝|登录会话/);
    assert.deepEqual(calls, ['live']);
  }
});

test('actual BuildController.buildStandard never triggers Live Coding', async () => {
  const { object, calls } = instanceFor('UE5TestEditor', 'dispatched');
  await object.build('Build', true);
  assert.deepEqual(calls, ['ubt']);
});

test('actual BuildController Rebuild/Clean and non-Editor Build remain standard UBT', async () => {
  const { object, calls } = instanceFor('UE5TestEditor', 'dispatched');
  await object.build('Rebuild');
  await object.build('Clean');
  assert.deepEqual(calls, ['ubt', 'ubt']);
  const other = instanceFor('UE5Test', 'dispatched');
  await other.object.build('Build');
  assert.deepEqual(other.calls, ['ubt']);
});

test('explicit Live Coding command refuses Game targets and nonmatching editor', async () => {
  const nonEditor = instanceFor('UE5Test', 'dispatched');
  await assert.rejects(nonEditor.object.compileLiveCoding(), /Editor 构建配置/);
  assert.deepEqual(nonEditor.calls, []);
  const wrong = instanceFor('UE5TestEditor', 'different-project');
  await assert.rejects(wrong.object.compileLiveCoding(), /并未打开当前项目/);
  assert.deepEqual(wrong.calls, ['live']);
});

test('injected shortcut is not confused with compilation acknowledgement', () => {
  const message = explainLiveCodingResult('dispatched', project);
  assert.match(message, /尚不能确认/);
  assert.match(message, /Console/);
});

test('PowerShell uses a bounded EncodedCommand and avoids user-driven script injection', () => {
  const script = makeLiveCodingScript(project, engine);
  assert.ok(Buffer.from(script, 'utf16le').toString('base64').length < 30000);
  assert.ok(script.includes("[Convert]::FromBase64String('"));
  assert.ok(!script.includes(project));
  assert.ok(!script.includes(engine));
});
