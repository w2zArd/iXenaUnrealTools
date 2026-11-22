'use strict';
// 执行真实面板脚本；仅模拟 VS Code 消息通道，不以字符串快照替代交互验证。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { parseHTML } = require('linkedom');
const root = path.resolve(__dirname, '../..');
const originalLoad = Module._load;
let view;
Module._load = function(request, parent, main) {
  if (request === 'vscode') return { Uri: { joinPath: (base, ...parts) => ({ toString: () => path.join(base.fsPath, ...parts) }) } };
  return originalLoad.call(this, request, parent, main);
};
try { view = require(path.join(root, 'dist/localizationView.js')); }
finally { Module._load = originalLoad; }
const script = fs.readFileSync(path.join(root, 'resources/localizationEditor.js'), 'utf8');

function entry(id, values = {}) {
  return { id, context: `Menu,${id}`, source: `Source ${id}`, translations: [''], comments: [], references: [`Source/Menu.cpp:${id}`], flags: [], obsolete: false, header: false, line: 10, ...values };
}
function state(values = {}) {
  return { type: 'state', language: 'zh-CN', targets: [{ id: 'game', name: 'Game', scopeName: 'UE5Test', projectPath: '/Project/UE5Test.uproject', cultures: ['en', 'zh-Hans'], warnings: [], configs: { gather: 'Gather.ini', export: 'Export.ini', import: 'Import.ini', compile: 'Compile.ini' } }],
    targetId: 'game', culture: 'zh-Hans', filePath: '/Project/Content/Localization/Game/zh-Hans/Game.po', revision: 'rev-1', entries: [entry('1'), entry('2', { translations: ['已翻译'] }), entry('3', { translations: ['待复核'], flags: ['fuzzy'] })], stats: { total: 3, translated: 1, untranslated: 1, review: 1 }, issues: {}, busy: false, autoExport: false, warnings: [], ...values };
}
function setup(savedState) {
  const html = view.localizationHtml({ cspSource: 'https://unit.local', asWebviewUri: uri => uri }, { fsPath: root });
  const { document, window } = parseHTML(html);
  // linkedom 缺少浏览器原生的 select.value setter。
  const prototype = window.HTMLSelectElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  const selectedValues = new WeakMap();
  Object.defineProperty(prototype, 'value', { configurable: true,
    get() { return selectedValues.has(this) ? selectedValues.get(this) : descriptor.get.call(this); },
    set(value) { selectedValues.set(this, String(value)); }
  });
  const messages = [], draftMessages = []; let stored = savedState;
  const context = vm.createContext({ window, document, console, acquireVsCodeApi: () => ({ getState: () => stored, setState: value => { stored = value; },
    postMessage: value => { if (value.type === 'storeDraft') draftMessages.push(value); else messages.push(value); } }) });
  vm.runInContext(script, context, { filename: 'localizationEditor.js' });
  const ready = messages.shift(); assert.equal(ready.type, 'ready');
  const element = id => document.getElementById(id);
  function event(target, type, extra = {}) { const event = new window.Event(type, { bubbles: true, cancelable: true }); Object.assign(event, extra); target.dispatchEvent(event); }
  return { html, document, window, messages, draftMessages, ready, element, stored: () => stored,
    send: value => event(window, 'message', { data: value }),
    click: id => { if (!element(id).disabled) event(element(id), 'click'); },
    input: (target, value) => { const node = typeof target === 'string' ? element(target) : target; node.value = value; event(node, node.tagName === 'SELECT' ? 'change' : 'input'); },
    check: (target, value) => { const node = typeof target === 'string' ? element(target) : target; node.checked = value; event(node, 'change'); },
    event, rows: () => [...document.querySelectorAll('#entries tr')], areas: () => [...document.querySelectorAll('.translation-input')] };
}

test('localization view uses CSP and renders source/context/reference as text', () => {
  const h = setup(), attack = '<img src=x onerror=alert(1)>';
  assert.match(h.html, /default-src 'none'/); assert.match(h.html, /script-src 'nonce-[a-f0-9]+'/);
  h.send(state({ entries: [entry('1', { source: attack, context: attack, comments: [attack], references: [attack] })], warnings: [attack] }));
  assert.equal(h.rows().length, 1); assert.ok(h.rows()[0].textContent.includes(attack));
  assert.equal(h.document.querySelectorAll('img').length, 0); assert.equal(h.document.querySelectorAll('script').length, 1);
  assert.equal(h.element('stat-total').textContent, '3');
});

test('typing preserves exact draft and sends versioned changes only after Save', () => {
  const h = setup(); h.send(state());
  h.input(h.areas()[0], '你好 {Name}\n第二行'); h.input(h.areas()[0], '你好 {Name}\n第二行！');
  assert.equal(h.messages.length, 0); assert.equal(h.stored().changes.length, 1);
  assert.equal(h.element('draft-banner').hidden, false);
  h.click('save');
  const message = h.messages.shift(); assert.equal(message.type, 'save'); assert.equal(message.revision, 'rev-1');
  assert.equal(message.changes[0].translations[0], '你好 {Name}\n第二行！');
  assert.equal(h.element('save').disabled, true);
  h.send(state({ reason: 'saved', revision: 'rev-2', entries: [entry('1', { translations: ['你好 {Name}\n第二行！'] })] }));
  assert.equal(h.stored().changes.length, 0); assert.equal(h.element('draft-banner').hidden, true);
});

test('dirty navigation and pipelines are blocked and a failed save keeps translations', () => {
  const h = setup(); h.send(state()); h.input(h.areas()[0], '草稿');
  h.click('refresh'); h.click('gather-export'); h.input('culture-select', 'en'); h.click('import-translations');
  assert.equal(h.messages.length, 0); assert.equal(h.element('culture-select').value, 'zh-Hans');
  h.click('save'); h.messages.shift(); h.send({ type: 'error', message: 'File permission denied' });
  assert.equal(h.areas()[0].value, '草稿'); assert.equal(h.stored().changes.length, 1);
  assert.equal(h.element('save').disabled, false); assert.match(h.element('message').textContent, /permission/);
});

test('disk conflicts preserve draft, forbid stale save, and require explicit discard', () => {
  const h = setup(); h.send(state()); h.input(h.areas()[0], '我的草稿');
  h.send(state({ revision: 'rev-2', entries: [entry('1', { translations: ['外部更新'] })] }));
  assert.equal(h.areas()[0].value, '我的草稿'); assert.equal(h.element('save').disabled, true);
  assert.match(h.element('draft-title').textContent, /文件已变化/);
  h.click('discard'); assert.equal(h.messages.at(-1).type, 'discard');
  assert.equal(h.areas()[0].value, '外部更新'); assert.equal(h.stored().changes.length, 0);
});

test('saved PO acknowledgement clears drafts even when follow-up automatic export reports an error', () => {
  const h = setup(); h.send(state()); h.input(h.areas()[0], '已落盘'); h.click('save');
  h.send({ type: 'error', message: 'The PO was saved, but automatic export failed.' });
  h.send(state({ reason: 'saved', revision: 'rev-2', entries: [entry('1', { translations: ['已落盘'] })] }));
  assert.equal(h.stored().changes.length, 0); assert.equal(h.element('draft-banner').hidden, true);
  assert.match(h.element('message').textContent, /export failed/);
});

test('error state does not replace the actionable error with a previous success status', () => {
  const h = setup(); h.send(state()); h.input(h.areas()[0], '继续保留'); h.click('save');
  h.send({ type: 'error', message: 'File changed externally' });
  h.send(state({ reason: 'error', status: 'Previous run succeeded' }));
  assert.equal(h.element('message').textContent, 'File changed externally');
  assert.equal(h.stored().changes[0].translations[0], '继续保留');
});

test('language change retains drafts, localized labels and multiline source', () => {
  const h = setup(); h.send(state()); h.input(h.areas()[0], '未保存');
  h.send(state({ language: 'en' }));
  assert.equal(h.document.documentElement.lang, 'en'); assert.equal(h.element('gather-export').textContent, 'Gather and export');
  assert.equal(h.areas()[0].value, '未保存'); assert.match(h.element('draft-title').textContent, /unsaved/);
  h.event(h.document, 'keydown', { ctrlKey: true, key: 's' });
  assert.equal(h.messages[0].type, 'save');
});

test('search, review and untranslated filters operate on identities and edited translations', () => {
  const h = setup(); h.send(state());
  h.input('filter', 'untranslated'); assert.equal(h.rows().length, 1);
  h.input('filter', 'review'); assert.equal(h.rows().length, 1); assert.match(h.rows()[0].textContent, /Menu,3/);
  h.input('filter', 'all'); h.input('search', 'Menu,2'); assert.equal(h.rows().length, 1);
  h.input('search', '不存在'); assert.equal(h.rows().length, 0); assert.equal(h.element('empty-state').hidden, false);
  h.input('search', ''); h.input(h.areas()[0], '可搜索草稿'); h.input('search', '可搜索草稿'); assert.equal(h.rows().length, 1);
});

test('plural forms, fuzzy review, and page navigation retain distinct edits', () => {
  const h = setup();
  const entries = Array.from({ length: 205 }, (_, index) => entry(String(index)));
  entries[0] = entry('0', { source: '{Count} apple', pluralSource: '{Count} apples', translations: ['', '', ''], flags: ['fuzzy'] });
  h.send(state({ entries, stats: { total: 205, translated: 0, untranslated: 205, review: 1 } }));
  assert.equal(h.rows().length, 100); assert.equal(h.areas().length, 102);
  h.input(h.areas()[2], '三种复数形式'); h.check(h.document.querySelector('.review-checkbox'), true);
  h.click('next-page'); assert.equal(h.rows().length, 100);
  h.input(h.areas()[0], '第二页译文'); h.click('next-page'); assert.equal(h.rows().length, 5);
  h.click('save'); const message = h.messages[0];
  assert.equal(message.changes.length, 2); assert.equal(message.changes[0].translations[2], '三种复数形式'); assert.equal(message.changes[0].reviewed, true);
  assert.equal(message.changes[1].id, '100');
});

test('export all languages sends scope and format, filters do not change the export request', () => {
  const h = setup(); h.send(state()); h.input('filter', 'untranslated');
  h.input('export-format', 'csv'); h.check('export-all', true); h.click('export');
  assert.equal(h.messages[0].type, 'export'); assert.equal(h.messages[0].format, 'csv'); assert.equal(h.messages[0].all, true);
  assert.equal(Object.hasOwn(h.messages[0], 'entries'), false);
  h.check('auto-export', true); assert.equal(h.messages[1].type, 'setAutoExport'); assert.equal(h.messages[1].enabled, true);
});

test('read-only PO remains inspectable and runnable while translations cannot be changed', () => {
  const h = setup(); h.send(state({ readOnly: true }));
  assert.equal(h.areas()[0].disabled, true); assert.equal(h.element('import-translations').disabled, true);
  assert.equal(h.element('gather-export').disabled, false);
  h.input('export-format', 'csv'); assert.equal(h.element('export').disabled, true);
  h.input('export-format', 'po'); h.click('export'); assert.equal(h.messages[0].format, 'po');
});

test('persisted unsaved changes request original target/culture and survive reopening', () => {
  const original = setup(); original.send(state()); original.input(original.areas()[0], '重启后恢复');
  const h = setup(original.stored());
  assert.equal(h.ready.targetId, 'game'); assert.equal(h.ready.culture, 'zh-Hans');
  h.send(state()); assert.equal(h.areas()[0].value, '重启后恢复'); assert.equal(h.element('draft-banner').hidden, false);
  h.click('save'); assert.equal(h.messages[0].changes[0].translations[0], '重启后恢复');
});

test('every draft edit is synchronously sent to the host, including the clear after discard', () => {
  const h = setup(); h.send(state());
  assert.equal(h.draftMessages.at(-1).draft.changes.length, 0);
  h.input(h.areas()[0], '输入一');
  assert.equal(h.draftMessages.at(-1).draft.changes[0].translations[0], '输入一');
  h.input(h.areas()[0], '输入二');
  assert.equal(h.draftMessages.at(-1).draft.changes[0].translations[0], '输入二');
  assert.equal(h.draftMessages.at(-1).draft.revision, 'rev-1');
  h.click('discard'); assert.equal(h.draftMessages.at(-1).draft.changes.length, 0);
});

test('a new panel restores host-persisted draft without emitting a restore loop', () => {
  const oldPanel = setup(); oldPanel.send(state()); oldPanel.input(oldPanel.areas()[0], '关闭后仍存在');
  const draft = oldPanel.draftMessages.at(-1).draft;
  const h = setup(); assert.equal(h.ready.targetId, undefined);
  h.send({ type: 'restoreDraft', draft });
  assert.equal(h.draftMessages.length, 0, 'Restore itself does not post a new store operation');
  h.send(state()); assert.equal(h.areas()[0].value, '关闭后仍存在');
  assert.equal(h.stored().changes[0].translations[0], '关闭后仍存在');
  h.click('save'); assert.equal(h.messages[0].revision, 'rev-1');
});

test('restored drafts revalidate disk revision and do not overwrite newer local drafts', () => {
  const oldPanel = setup(); oldPanel.send(state()); oldPanel.input(oldPanel.areas()[0], '旧草稿');
  const draft = oldPanel.draftMessages.at(-1).draft;
  const h = setup(); h.send({ type: 'restoreDraft', draft });
  h.send(state({ revision: 'changed-on-disk' }));
  assert.equal(h.areas()[0].value, '旧草稿'); assert.equal(h.element('save').disabled, true);
  assert.match(h.element('draft-title').textContent, /文件已变化/);
  const fresh = setup(); fresh.send(state()); fresh.input(fresh.areas()[0], '更新的输入');
  fresh.send({ type: 'restoreDraft', draft });
  assert.equal(fresh.areas()[0].value, '更新的输入');
  assert.equal(fresh.stored().changes[0].translations[0], '更新的输入');
});

test('restoration ignores malformed draft payloads and restores the search/filter/page choices', () => {
  const h = setup();
  h.send({ type: 'restoreDraft', draft: { version: 1, filePath: '/x.po', changes: [{ id: '1', translations: [42] }] } });
  const entries = Array.from({ length: 205 }, (_, index) => entry(String(index)));
  const draft = { version: 1, filePath: state().filePath, revision: 'rev-1', targetId: 'game', culture: 'zh-Hans',
    changes: [{ id: '1', translations: ['保留草稿'] }], query: 'Source', filter: 'all', page: 1 };
  h.send({ type: 'restoreDraft', draft }); h.send(state({ entries }));
  assert.equal(h.element('search').value, 'Source'); assert.equal(h.element('filter').value, 'all');
  assert.match(h.element('page-label').textContent, /^101/); assert.equal(h.rows().length, 100);
  assert.equal(h.stored().changes[0].translations[0], '保留草稿');
});

test('busy task enables stopping, disables write actions, and retains rendered log status', () => {
  const h = setup(); h.send(state()); h.send({ type: 'status', busy: true, message: 'GatherText running' });
  assert.equal(h.element('stop').hidden, false); assert.equal(h.element('refresh').disabled, true);
  assert.equal(h.areas()[0].disabled, true); h.click('stop'); assert.equal(h.messages[0].type, 'stop');
  h.send({ type: 'status', busy: false, message: 'Cancelled' });
  assert.equal(h.element('stop').hidden, true); assert.equal(h.areas()[0].disabled, false); assert.equal(h.element('message').textContent, 'Cancelled');
});
