'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { parseBridgeDescriptor, discoverEditorBridges, inspectEditorBridges, sendBridgeCommand, parseBridgeResponse, BridgeTimeoutError, validateBridgeParameters } = require('../dist/editorBridge');

async function fixture(t, overrides = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ixena-bridge-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const projectPath = path.join(temp, 'Project', 'Demo.uproject');
  const engineRoot = path.join(temp, 'UE');
  const instanceId = `12345-${randomUUID()}`;
  const directory = path.join(path.dirname(projectPath), 'Saved', 'iXenaUnrealBridge', 'instances', instanceId);
  for (const dir of ['Requests', 'Responses', 'Processing', 'Logs']) await fs.mkdir(path.join(directory, dir), { recursive: true });
  const descriptor = { protocol: 1, pluginVersion: '0.5.0', instanceId, token: 'ab'.repeat(32), processId: 12345,
    projectPath, engineRoot, engineVersion: '5.9.0', platform: 'Win64', startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), status: 'ready', liveCodingAvailable: true, liveCodingEnabled: true, ...overrides };
  await fs.writeFile(path.join(directory, 'instance.json'), JSON.stringify(descriptor));
  return { temp, projectPath, engineRoot, directory, descriptor, instance: parseBridgeDescriptor(descriptor, directory, projectPath, engineRoot) };
}

async function takeRequest(directory) {
  for (let i = 0; i < 200; i++) {
    const names = (await fs.readdir(path.join(directory, 'Requests'))).filter(x => x.endsWith('.json'));
    if (names.length) {
      const file = path.join(directory, 'Requests', names[0]);
      const processing = path.join(directory, 'Processing', names[0]);
      await fs.rename(file, processing);
      return JSON.parse(await fs.readFile(processing, 'utf8'));
    }
    await sleep(5);
  }
  throw new Error('mock editor did not receive request');
}
async function respond(f, req, status, output = '') {
  const target = path.join(f.directory, 'Responses', `${req.id}.json`);
  const value = { protocol: 1, id: req.id, instanceId: f.descriptor.instanceId,
    ok: ['Success', 'NoChanges', 'Ready'].includes(status), status, output, message: '', completedAt: new Date().toISOString() };
  await fs.writeFile(`${target}.tmp`, JSON.stringify(value)); await fs.rename(`${target}.tmp`, target);
}

test('bridge discovery matches the current project, engine and protocol and exposes stale heartbeat', async t => {
  const f = await fixture(t);
  assert.equal((await discoverEditorBridges(f.projectPath, f.engineRoot)).length, 1);
  assert.equal((await discoverEditorBridges(f.projectPath, path.join(f.temp, 'OtherUE'))).length, 0);
  const old = { ...f.descriptor, updatedAt: new Date(Date.now() - 30_000).toISOString() };
  assert.equal(parseBridgeDescriptor(old, f.directory, f.projectPath, f.engineRoot).stale, true);
  assert.throws(() => parseBridgeDescriptor({ ...old, protocol: 2 }, f.directory, f.projectPath, f.engineRoot));
  assert.throws(() => parseBridgeDescriptor({ ...old, token: 'too short' }, f.directory, f.projectPath, f.engineRoot));
});

test('bridge ping uses an atomic correlated request and requires actual Editor response', async t => {
  const f = await fixture(t);
  const pending = sendBridgeCommand(f.instance, 'ping', { timeoutMs: 1500, pollIntervalMs: 10 });
  const request = await takeRequest(f.directory);
  assert.equal(request.command, 'ping'); assert.equal(request.token, f.descriptor.token);
  assert.equal(request.instanceId, f.descriptor.instanceId);
  assert.match(request.id, /^[0-9a-f-]{36}$/);
  await respond(f, request, 'Ready');
  assert.equal((await pending).status, 'Ready');
  assert.deepEqual(await fs.readdir(path.join(f.directory, 'Responses')), []);
});

test('compile streams split UTF8 and does not repeat final output', async t => {
  const f = await fixture(t); let received = '';
  const pending = sendBridgeCommand(f.instance, 'compile', { timeoutMs: 1500, pollIntervalMs: 10, onOutput: chunk => { received += chunk; } });
  const request = await takeRequest(f.directory);
  const log = path.join(f.directory, 'Logs', `${request.id}.log`);
  const buffer = Buffer.from('正在编译\n');
  await fs.writeFile(log, buffer.subarray(0, 2)); await sleep(35);
  await fs.appendFile(log, buffer.subarray(2)); await sleep(35);
  assert.equal(received, '正在编译\n');
  await respond(f, request, 'Success', '正在编译\n编译完成\n');
  const result = await pending;
  assert.equal(result.output, '正在编译\n编译完成\n');
  assert.equal(received, result.output);
  assert.equal(received.includes('\ufffd'), false);
});

test('an unclaimed timed-out request is removed; consumed timeout is explicitly uncertain', async t => {
  const f = await fixture(t);
  await assert.rejects(sendBridgeCommand(f.instance, 'ping', { timeoutMs: 60, pollIntervalMs: 10 }), error => error instanceof BridgeTimeoutError && !error.outcomeUnknown);
  assert.deepEqual(await fs.readdir(path.join(f.directory, 'Requests')), []);
  const pending = sendBridgeCommand(f.instance, 'compile', { timeoutMs: 120, pollIntervalMs: 10 });
  const checked = assert.rejects(pending, error => error instanceof BridgeTimeoutError && error.outcomeUnknown);
  await takeRequest(f.directory); await checked;
});

test('stale or busy Editor cannot receive another compile and queued requests serialize per instance', async t => {
  const f = await fixture(t);
  const descriptor = { ...f.descriptor, status: 'compiling' };
  await fs.writeFile(path.join(f.directory, 'instance.json'), JSON.stringify(descriptor));
  await assert.rejects(sendBridgeCommand(f.instance, 'compile'), /已在编译/);
  await fs.writeFile(path.join(f.directory, 'instance.json'), JSON.stringify(f.descriptor));
  const pending = sendBridgeCommand(f.instance, 'ping', { timeoutMs: 1500, pollIntervalMs: 10 });
  const request = await takeRequest(f.directory);
  await assert.rejects(sendBridgeCommand(f.instance, 'compile'), /请求正在进行/);
  await respond(f, request, 'Ready'); await pending;
});

test('rejects mismatched response identities and contradictory success flags', () => {
  const response = { protocol: 1, id: 'req', instanceId: 'instance', ok: true, status: 'Success', output: '', message: '', completedAt: new Date().toISOString() };
  assert.throws(() => parseBridgeResponse(response, 'another', 'instance'));
  assert.throws(() => parseBridgeResponse({ ...response, status: 'Failure' }, 'req', 'instance'));
  assert.throws(() => parseBridgeResponse({ ...response, status: 'Success', ok: false }, 'req', 'instance'));
  assert.equal(parseBridgeResponse({ ...response, status: 'Failure', ok: false }, 'req', 'instance').status, 'Failure');
});

test('symbolic-link communication directories are not followed', async t => {
  const f = await fixture(t);
  const requests = path.join(f.directory, 'Requests');
  await fs.rmdir(requests); await fs.mkdir(path.join(f.temp, 'outside'));
  await fs.symlink(path.join(f.temp, 'outside'), requests, 'dir');
  await assert.rejects(sendBridgeCommand(f.instance, 'ping'), /普通目录/);
  assert.deepEqual(await fs.readdir(path.join(f.temp, 'outside')), []);
});

test('console protocol validates bounded search parameters and rejects compound commands', () => {
  validateBridgeParameters('listConsole', { filter: 'r.', cursor: 100, limit: 100, locale: 'zh-CN' });
  assert.throws(() => validateBridgeParameters('listConsole', { filter: 'r.', cursor: 0, limit: 20, locale: 'invalid' }));
  validateBridgeParameters('executeConsole', { command: 'stat fps' });
  assert.throws(() => validateBridgeParameters('listConsole', { filter: '', cursor: 0, limit: 101 }));
  assert.throws(() => validateBridgeParameters('executeConsole', { command: 'stat fps;quit' }));
  assert.throws(() => validateBridgeParameters('compile', { command: 'stat fps' }));
  const value = { protocol: 1, id: 'req', instanceId: 'instance', ok: true, status: 'ConsoleList', output: '', message: '',
    completedAt: new Date().toISOString(), data: { items: [{ name: 'r.VSync', help: 'Real help', type: 'variable', value: '0', flags: 0 }], total: 1 } };
  assert.equal(parseBridgeResponse(value, 'req', 'instance').data.items[0].value, '0');
  assert.throws(() => parseBridgeResponse({ ...value, data: { ...value.data, nextCursor: -1 } }, 'req', 'instance'));
});

test('console command parameters reach Editor without shell evaluation', async t => {
  const f = await fixture(t);
  const pending = sendBridgeCommand(f.instance, 'executeConsole', { parameters: { command: 't.MaxFPS 120' }, timeoutMs: 1500, pollIntervalMs: 10 });
  const request = await takeRequest(f.directory);
  assert.deepEqual(request.parameters, { command: 't.MaxFPS 120' });
  await respond(f, request, 'NotHandled', 'not supported');
  assert.equal((await pending).ok, false);
});

test('protocol 1 supports explicit current and previous bridge versions without relaxing identity checks', async t => {
  const f = await fixture(t);
  for (const version of ['0.5.0','0.6.0','0.6.1','0.6.2']) {
    const value={...f.descriptor,pluginVersion:version};
    assert.equal(parseBridgeDescriptor(value,f.directory,f.projectPath,f.engineRoot).pluginVersion,version);
    assert.throws(()=>parseBridgeDescriptor({...value,protocol:2},f.directory,f.projectPath,f.engineRoot));
    assert.throws(()=>parseBridgeDescriptor({...value,token:'invalid'},f.directory,f.projectPath,f.engineRoot));
    assert.throws(()=>parseBridgeDescriptor({...value,projectPath:path.join(f.temp,'Other.uproject')},f.directory,f.projectPath,f.engineRoot));
  }
  for (const pluginVersion of ['0.4.4','0.5.1','0.7.0','1.0.0','']) {
    assert.throws(()=>parseBridgeDescriptor({...f.descriptor,pluginVersion},f.directory,f.projectPath,f.engineRoot));
  }
});


test('discovery reports path/version mismatches instead of silently discarding loaded Editor files', async t => {
  const f = await fixture(t);
  const instanceFile = path.join(f.directory, 'instance.json');
  await fs.writeFile(instanceFile, JSON.stringify({ ...f.descriptor, engineRoot: path.join(f.temp, 'OtherEngine') }));
  let diagnostics = await inspectEditorBridges(f.projectPath, f.engineRoot);
  assert.equal(diagnostics.instances.length, 0);
  assert.equal(diagnostics.rejected[0].reason, 'engine');
  await fs.writeFile(instanceFile, JSON.stringify({ ...f.descriptor, projectPath: path.join(f.temp, 'Other.uproject') }));
  diagnostics = await inspectEditorBridges(f.projectPath, f.engineRoot);
  assert.equal(diagnostics.rejected[0].reason, 'project');
  await fs.writeFile(instanceFile, JSON.stringify({ ...f.descriptor, pluginVersion: '0.0.1' }));
  diagnostics = await inspectEditorBridges(f.projectPath, f.engineRoot);
  assert.equal(diagnostics.rejected[0].reason, 'version');
  await fs.writeFile(instanceFile, JSON.stringify(f.descriptor));
  diagnostics = await inspectEditorBridges(f.projectPath, f.engineRoot);
  assert.equal(diagnostics.instances.length, 1);
  assert.equal(diagnostics.rejected.length, 0);
});
