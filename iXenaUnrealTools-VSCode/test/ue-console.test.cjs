'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

function harness(options = {}) {
  const rpc = [], pickers = [], inputs = [], notices = [], warnings = [], output = [];
  const picks = [...(options.picks || [])], answers = [...(options.answers || [])];
  const channel = { append: value => output.push(value), appendLine: value => output.push(`${value}\n`), show() {}, dispose() {} };
  const vscode = { window: {
    createOutputChannel: () => channel,
    showQuickPick: async (items, config) => { pickers.push({ items, config }); const fn = picks.shift(); return fn?.(items); },
    showInputBox: async config => { inputs.push(config); return answers.shift(); },
    showInformationMessage: async value => { notices.push(value); },
    showWarningMessage: async (...args) => { warnings.push(args); return options.confirmWarning; }
  } };
  const bridge = { sendBridgeCommand: async (_instance, command, config) => {
    rpc.push({ command, parameters: config.parameters });
    if (command === 'listConsole') return { ok: true, status: 'ConsoleList', data: options.page?.(config.parameters) || { items: [], total: 0 } };
    config.onOutput?.('UE actual output\n'); return { ok: true, status: 'Executed', output: 'UE actual output\n', message: 'Accepted, not completion.' };
  } };
  const file = path.resolve(__dirname, '../dist/ueConsole.js'); delete require.cache[file];
  const original = Module._load;
  Module._load = function (request, parent, main) {
    if (request === 'vscode') return vscode;
    if (request === './editorBridge' && parent?.filename === file) return bridge;
    return original.call(this, request, parent, main);
  };
  let api; try { api = require(file); } finally { Module._load = original; }
  const instance = { instanceId: 'fixture', projectPath: '/Game/Demo.uproject', processId: 42 };
  return { ...api, instance, rpc, pickers, inputs, notices, warnings, output };
}
const action = name => items => items.find(item => item.action === name);
const preset = command => items => items.find(item => item.preset?.command === command);

test('console search cancellation never sends a mutating command', async () => {
  const h = harness({ picks: [action('search')], answers: [undefined] });
  await h.showUnrealConsole(h.instance);
  assert.deepEqual(h.rpc, []);
});

test('custom commands require preview confirmation and destructive commands require explicit second confirmation', async () => {
  const cancelled = harness({ picks: [action('custom'), action('cancel')], answers: ['quit'] });
  await cancelled.showUnrealConsole(cancelled.instance); assert.equal(cancelled.rpc.length, 0);
  const guarded = harness({ picks: [action('custom'), action('send')], answers: ['quit'] });
  await guarded.showUnrealConsole(guarded.instance);
  assert.equal(guarded.rpc.length, 0); assert.equal(guarded.warnings[0][1].modal, true);
  const approved = harness({ picks: [action('custom'), action('send')], answers: ['quit'], confirmWarning: '确认发送' });
  await approved.showUnrealConsole(approved.instance);
  assert.deepEqual(approved.rpc, [{ command: 'executeConsole', parameters: { command: 'quit' } }]);
});

test('CVar preset reads actual current value and sends the edited value exactly once', async () => {
  const h = harness({ picks: [preset('t.MaxFPS'), action('send')], answers: ['120'],
    page: () => ({ total: 1, items: [{ name: 't.MaxFPS', help: 'Maximum framerate', type: 'variable', value: '60', flags: 0 }] }) });
  await h.showUnrealConsole(h.instance);
  assert.equal(h.inputs[0].value, '60');
  assert.deepEqual(h.rpc.map(item => item.command), ['listConsole', 'executeConsole']);
  assert.equal(h.rpc[1].parameters.command, 't.MaxFPS 120');
  assert.equal(h.output.join('').match(/UE actual output/g).length, 1);
  assert.match(h.notices[0], /异步操作/);
});

test('missing preset CVar is not fabricated or executed', async () => {
  const h = harness({ picks: [preset('r.VSync')] });
  await h.showUnrealConsole(h.instance);
  assert.equal(h.rpc.length, 1); assert.equal(h.rpc[0].command, 'listConsole');
  assert.match(h.warnings[0][0], /没有返回/);
});

test('registered console browsing pages actual results and cancellation preserves state', async () => {
  const h = harness({ picks: [action('search'), action('next'), action('item'), action('cancel')], answers: ['r.', ''],
    page: parameters => parameters.cursor === 0 ? { items: [], total: 101, nextCursor: 100 }
      : { items: [{ name: 'r.Example', help: 'Actual UE help', type: 'variable', value: '1', flags: 0 }], total: 101 } });
  await h.showUnrealConsole(h.instance);
  assert.deepEqual(h.rpc.map(item => item.parameters.cursor), [0, 100]);
  assert.equal(h.inputs[1].value, '1');
  assert.match(h.output.join(''), /Actual UE help/);
});

test('single-command validation and destructive command detection cover separators and travel', () => {
  const h = harness();
  for (const command of ['stat fps;quit', 'stat fps\nquit', 'x|y', 'a\0b', '']) assert.ok(h.validateConsoleCommand(command));
  assert.equal(h.validateConsoleCommand('r.ScreenPercentage 75'), undefined);
  for (const command of ['quit', 'open /Game/Map', 'obj garbage', 'py print(1)', 'servertravel /Game/Map']) assert.equal(h.consoleCommandNeedsConfirmation(command), true);
  assert.equal(h.consoleCommandNeedsConfirmation('stat fps'), false);
});
