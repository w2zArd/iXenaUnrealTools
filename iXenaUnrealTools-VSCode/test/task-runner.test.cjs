'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const path = require('node:path');

function fakeVscode() {
  class Emitter {
    listeners = new Set();
    event = callback => {
      this.listeners.add(callback);
      return { dispose: () => this.listeners.delete(callback) };
    };
    fire(value) { for (const callback of [...this.listeners]) callback(value); }
    dispose() { this.listeners.clear(); }
  }
  const events = { start: new Emitter(), end: new Emitter(), processEnd: new Emitter() };
  class CancellationTokenSource {
    token = { isCancellationRequested: false };
    cancel() { this.token.isCancellationRequested = true; }
    dispose() {}
  }
  class Task {
    constructor(definition, scope, name, source, execution, problemMatchers) {
      Object.assign(this, { definition, scope, name, source, execution, problemMatchers });
      this.presentationOptions = {};
      this.runOptions = {};
    }
  }
  class ProcessExecution {
    constructor(process, args, options) { Object.assign(this, { process, args, options }); }
  }
  const api = {
    EventEmitter: Emitter,
    CancellationTokenSource,
    Task,
    ProcessExecution,
    TaskGroup: { Build: { id: 'build' } },
    TaskRevealKind: { Always: 1 },
    TaskPanelKind: { Shared: 1, Dedicated: 2 },
    window: { terminals: [] },
    tasks: {
      taskExecutions: [],
      onDidStartTask: events.start.event,
      onDidEndTask: events.end.event,
      onDidEndTaskProcess: events.processEnd.event,
      executeTask: async () => { throw new Error('Test did not install an executor'); }
    }
  };
  const makeExecution = task => ({
    task,
    terminated: 0,
    terminate() {
      this.terminated++;
      events.processEnd.fire({ execution: this, exitCode: undefined });
      events.end.fire({ execution: this });
    }
  });
  return { api, events, makeExecution };
}

function loadRunner(api) {
  const filename = path.resolve(__dirname, '..', 'dist', 'taskRunner.js');
  const original = Module._load;
  delete require.cache[filename];
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return api;
    return original.call(this, request, parent, isMain);
  };
  try { return require(filename).NativeTaskRunner; }
  finally { Module._load = original; }
}

const prepared = label => ({
  label,
  scope: 2,
  process: 'D:\\UE\\Engine\\Binaries\\ThirdParty\\DotNet\\10.0\\win-x64\\dotnet.exe',
  args: ['UnrealBuildTool.dll', 'ExampleEditor', 'Win64', 'Development', '-Project=D:\\A B\\Example.uproject'],
  cwd: 'D:\\UE',
  problemMatchers: ['$msCompile']
});
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('fast task exit before executeTask resolves retains success and the problem matcher', async () => {
  const fake = fakeVscode();
  const Runner = loadRunner(fake.api);
  let emittedTask;
  fake.api.tasks.executeTask = async task => {
    emittedTask = task;
    const execution = fake.makeExecution(task);
    fake.events.start.fire({ execution });
    fake.events.processEnd.fire({ execution, exitCode: 0 });
    fake.events.end.fire({ execution });
    return execution;
  };
  const runner = new Runner(() => {});
  try {
    const result = await runner.run('Build', async () => [prepared('Build')]);
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(emittedTask.problemMatchers, ['$msCompile']);
    assert.ok(emittedTask.execution instanceof fake.api.ProcessExecution);
    assert.equal(emittedTask.execution.args[4], '-Project=D:\\A B\\Example.uproject');
    assert.equal(emittedTask.presentationOptions.close, false);
    assert.equal(emittedTask.presentationOptions.clear, false);
    assert.equal(emittedTask.presentationOptions.panel, fake.api.TaskPanelKind.Dedicated);
    assert.equal(runner.state.status, 'idle');
  } finally { runner.dispose(); }
});

test('stop before executeTask resolves sends only one Ctrl+C to own task terminal', async () => {
  const fake = fakeVscode();
  const Runner = loadRunner(fake.api);
  let startTask;
  let execution;
  let task;
  const signals = [];
  fake.api.tasks.executeTask = newTask => new Promise(resolve => {
    task = newTask;
    execution = fake.makeExecution(task);
    startTask = () => {
      // Build task opens its own named terminal; another terminal remains untouched.
      fake.api.window.terminals.push({ name: `Task - ${task.name}`,
        sendText(text, execute) { signals.push({ text, execute }); } });
      fake.events.start.fire({ execution });
      resolve(execution);
    };
  });
  const other = fake.makeExecution({ definition: { type: 'shell' }, name: 'Other build' });
  fake.api.tasks.taskExecutions = [other];
  const runner = new Runner(() => {});
  try {
    const promise = runner.run('Build', async () => [prepared('Build')]);
    await nextTurn();
    runner.cancel();
    runner.cancel();
    assert.equal(runner.state.status, 'stopping');
    assert.equal(other.terminated, 0);
    startTask();
    await nextTurn();
    assert.deepEqual(signals, [{ text: '\u0003', execute: false }]);
    assert.equal(execution.terminated, 0, 'Ctrl+C is preferred over terminate()');
    fake.events.processEnd.fire({ execution, exitCode: 1 });
    fake.events.end.fire({ execution });
    assert.equal((await promise).status, 'cancelled');
    assert.equal(other.terminated, 0);
    assert.equal(runner.state.status, 'idle');
  } finally { runner.dispose(); }
});

test('unrelated task end events cannot complete the active build', async () => {
  const fake = fakeVscode();
  const Runner = loadRunner(fake.api);
  let execution;
  fake.api.tasks.executeTask = async task => {
    execution = fake.makeExecution(task);
    fake.events.start.fire({ execution });
    return execution;
  };
  const runner = new Runner(() => {});
  try {
    const promise = runner.run('Build', async () => [prepared('Build')]);
    await nextTurn();
    const unrelated = fake.makeExecution({ definition: { type: 'shell' }, name: 'Build' });
    fake.events.processEnd.fire({ execution: unrelated, exitCode: 0 });
    fake.events.end.fire({ execution: unrelated });
    await nextTurn();
    assert.equal(runner.isBusy, true);
    fake.events.processEnd.fire({ execution, exitCode: 1 });
    fake.events.end.fire({ execution });
    assert.equal((await promise).status, 'failed');
    assert.equal(runner.isBusy, false);
  } finally { runner.dispose(); }
});

test('a clean failure prevents later build; task end without exit code is failure', async () => {
  const fake = fakeVscode();
  const Runner = loadRunner(fake.api);
  const names = [];
  fake.api.tasks.executeTask = async task => {
    names.push(task.name);
    const execution = fake.makeExecution(task);
    fake.events.start.fire({ execution });
    fake.events.end.fire({ execution });
    return execution;
  };
  const runner = new Runner(() => {});
  try {
    const result = await runner.run('Rebuild', async () => [prepared('Clean'), prepared('Build')]);
    assert.equal(result.status, 'failed');
    assert.equal(names.length, 1);
    assert.match(names[0], /^iXena Unreal Build \[ixena-[0-9a-f]{8}\]$/);
  } finally { runner.dispose(); }
});

test('preparation cancellation starts no process and overlapping run is rejected', async () => {
  const fake = fakeVscode();
  const Runner = loadRunner(fake.api);
  let prepareFinished;
  let calls = 0;
  fake.api.tasks.executeTask = async () => { calls++; throw new Error('Must not execute'); };
  const runner = new Runner(() => {});
  try {
    const promise = runner.run('Build', () => new Promise(resolve => { prepareFinished = resolve; }));
    await assert.rejects(runner.run('Second build', async () => [prepared('Second')]), /已有/);
    runner.cancel();
    prepareFinished([prepared('Build')]);
    assert.equal((await promise).status, 'cancelled');
    assert.equal(calls, 0);
    assert.equal(runner.isBusy, false);
  } finally { runner.dispose(); }
});


test('terminal matching needs the unique run marker; never sends Ctrl+C to unrelated active PowerShell', async () => {
  const fake = fakeVscode();
  const Runner = loadRunner(fake.api);
  let execution;
  let task;
  let wrongSignals = 0;
  let rightSignals = 0;
  const unrelated = { name: 'PowerShell - UE5Test', sendText() { wrongSignals++; } };
  fake.api.window.terminals.push(unrelated);
  fake.api.tasks.executeTask = async t => {
    task = t;
    execution = fake.makeExecution(t);
    fake.events.start.fire({ execution });
    return execution;
  };
  const runner = new Runner(() => {});
  try {
    const promise = runner.run('Build', async () => [prepared('Build')]);
    await nextTurn();
    runner.cancel();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(wrongSignals, 0);
    fake.api.window.terminals.push({ name: `Task - ${task.name}`,
      sendText(t, e) { assert.equal(t, '\u0003'); assert.equal(e, false); rightSignals++; } });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(rightSignals, 1);
    assert.equal(wrongSignals, 0);
    assert.equal(execution.terminated, 0);
    fake.events.processEnd.fire({ execution, exitCode: 0 });
    fake.events.end.fire({ execution });
    assert.equal((await promise).status, 'cancelled');
  } finally { runner.dispose(); }
});

test('missing target terminal safely falls back to terminate without interrupting unrelated terminals', async () => {
  const fake = fakeVscode();
  const Runner = loadRunner(fake.api);
  let execution;
  let unrelatedSignals = 0;
  fake.api.window.terminals.push({ name: 'PowerShell', sendText() { unrelatedSignals++; } });
  fake.api.tasks.executeTask = async task => {
    execution = fake.makeExecution(task);
    fake.events.start.fire({ execution });
    return execution;
  };
  const logs = [];
  const runner = new Runner(line => logs.push(line));
  try {
    const promise = runner.run('Build', async () => [prepared('Build')]);
    await nextTurn();
    runner.cancel();
    assert.equal((await promise).status, 'cancelled');
    assert.equal(execution.terminated, 1);
    assert.equal(unrelatedSignals, 0);
    assert.ok(logs.some(line => line.includes('未找到本次构建专属终端')));
  } finally { runner.dispose(); }
});

test('terminal title matching rejects ambiguous or unrelated names', () => {
  const fake = fakeVscode();
  const fn = loadRunner(fake.api); // load module with mocked vscode and inspect exported helper
  assert.ok(fn);
  const filename = path.resolve(__dirname, '..', 'dist', 'taskRunner.js');
  const { matchingTaskTerminal } = require(filename);
  const t = { name: 'Task - Example [ixena-abcd1234]' };
  assert.equal(matchingTaskTerminal([t, { name: 'PowerShell' }], 'ixena-abcd1234'), t);
  assert.equal(matchingTaskTerminal([t, { name: t.name }], 'ixena-abcd1234'), undefined);
  assert.equal(matchingTaskTerminal([t], 'ixena-deadbeef'), undefined);
});


test('build, rebuild and clean share a stable task identity/terminal for the same project', async () => {
  const fake = fakeVscode();
  const Runner = loadRunner(fake.api);
  const tasks = [];
  fake.api.tasks.executeTask = async task => {
    tasks.push(task);
    const execution = fake.makeExecution(task);
    fake.events.start.fire({ execution });
    fake.events.processEnd.fire({ execution, exitCode: 0 });
    fake.events.end.fire({ execution });
    return execution;
  };
  const runner = new Runner(() => {});
  try {
    const build = prepared('Build');
    build.projectPath = 'D:\\Project\\Example.uproject';
    assert.equal((await runner.run('Build', async () => [build])).status, 'succeeded');
    const clean = { ...build, label: 'Clean' };
    assert.equal((await runner.run('Rebuild', async () => [clean, build])).status, 'succeeded');
    assert.equal(tasks.length, 3);
    assert.equal(new Set(tasks.map(t => t.name)).size, 1);
    assert.equal(new Set(tasks.map(t => t.definition.taskKey)).size, 1);
    assert.ok(tasks.every(t => t.presentationOptions.panel === fake.api.TaskPanelKind.Dedicated));
    assert.ok(tasks.every(t => t.presentationOptions.clear === false && t.presentationOptions.close === false));
  } finally { runner.dispose(); }
});

test('different projects have distinct task identities, no accidental terminal cross-use', async () => {
  const fake = fakeVscode();
  const Runner = loadRunner(fake.api);
  const tags = [];
  fake.api.tasks.executeTask = async task => {
    tags.push(task.name);
    const execution = fake.makeExecution(task);
    fake.events.start.fire({ execution });
    fake.events.processEnd.fire({ execution, exitCode: 0 });
    fake.events.end.fire({ execution });
    return execution;
  };
  const runner = new Runner(() => {});
  try {
    await runner.run('Build', async () => [{ ...prepared('Build'), projectPath: 'D:\\A\\A.uproject' }]);
    await runner.run('Build', async () => [{ ...prepared('Build'), projectPath: 'D:\\B\\B.uproject' }]);
    assert.notEqual(tags[0], tags[1]);
  } finally { runner.dispose(); }
});
