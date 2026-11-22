'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, readFile, rm, utimes } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { archiveUbtLog, MAX_ARCHIVED_LOG_BYTES } = require('../dist/buildLogs.js');

async function withDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ixena-logs-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('archive current UBT log after cancelled build, preserving content', async () => withDir(async dir => {
  const logPath = path.join(dir, 'Log.txt');
  const body = '[8/30] Compile [x64] ...\nerror C2445: example\n';
  await writeFile(logPath, body);
  const saved = await archiveUbtLog({
    sourcePath: logPath, destinationDirectory: path.join(dir, 'history'),
    label: 'UE5TestEditor Win64 Development Build', status: 'cancelled',
    startedAtMs: Date.now() - 1000, now: new Date('2026-11-21T12:00:00.000Z')
  });
  assert.ok(saved && saved.endsWith('cancelled.log'));
  const archived = await readFile(saved, 'utf8');
  assert.match(archived, /error C2445: example/);
  assert.match(archived, /UE5TestEditor/);
}));

test('archive skips stale or nonexistent logs rather than showing an old build', async () => withDir(async dir => {
  const logPath = path.join(dir, 'Log.txt');
  const options = { sourcePath: logPath, destinationDirectory: path.join(dir, 'history'), label: 'Build', status: 'cancelled', startedAtMs: Date.now() };
  assert.equal(await archiveUbtLog(options), undefined);
  await writeFile(logPath, 'previous build');
  const old = new Date(Date.now() - 100000);
  await utimes(logPath, old, old);
  assert.equal(await archiveUbtLog(options), undefined);
}));

test('archive caps very large logs to a tail segment', async () => withDir(async dir => {
  const logPath = path.join(dir, 'Log.txt');
  await writeFile(logPath, Buffer.concat([Buffer.alloc(200, 88), Buffer.from('END\n')]));
  // The exported maximum is intentionally bounded to avoid loading huge UE logs into VS Code.
  assert.ok(MAX_ARCHIVED_LOG_BYTES > 1024 * 1024 && MAX_ARCHIVED_LOG_BYTES <= 32 * 1024 * 1024);
  const result = await archiveUbtLog({ sourcePath: logPath, destinationDirectory: dir,
    label: '../ Test ❤', status: 'failed', startedAtMs: Date.now() - 1000 });
  assert.ok(result && path.basename(result).indexOf('/') === -1);
  assert.match(await readFile(result, 'utf8'), /END/);
}));
