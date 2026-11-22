'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { localizedConsoleHelp, consoleHelpMatches } = require('../dist/consoleHelp');
const bridgeRoot = path.join(__dirname, '../../iXenaUnrealTools-UnrealPlugin/iXenaUnrealBridge');

test('Chinese summaries augment actual UE help; English restores untouched original', () => {
  const original = 'Maximum frames per second, 0 = unlimited';
  const chinese = localizedConsoleHelp('t.MaxFPS', original, 'zh-CN');
  assert.match(chinese, /帧率上限/);
  assert.match(chinese, /UE 原始帮助/);
  assert.match(chinese, /0 = unlimited/);
  assert.equal(localizedConsoleHelp('t.MaxFPS', original, 'en'), original);
  assert.equal(localizedConsoleHelp('unknown.Custom', original, 'zh-CN'), original);
  assert.equal(localizedConsoleHelp('r.SomeNewThing', '', 'zh-CN').includes('渲染'), true);
});

test('console search supports Chinese category words and English command names', () => {
  assert.equal(consoleHelpMatches('r.Lumen.Reflections.Allow', 'Allow reflections', '反射', 'zh-CN'), true);
  assert.equal(consoleHelpMatches('r.Lumen.Reflections.Allow', 'Allow reflections', 'lumen', 'en'), true);
  assert.equal(consoleHelpMatches('r.Lumen.Reflections.Allow', 'Allow reflections', '反射', 'en'), false);
});

test('VSCode and native UE plugin ship the same Chinese console glossary', () => {
  const frontend = JSON.parse(fs.readFileSync(path.join(__dirname, '../resources/ConsoleHelp.zh-CN.json'), 'utf8'));
  const native = JSON.parse(fs.readFileSync(path.join(bridgeRoot, 'Resources/ConsoleHelp.zh-CN.json'), 'utf8'));
  assert.deepEqual(frontend, native);
  assert.ok(Object.keys(frontend.exact).length >= 20);
});

test('bridge contributes only to existing iXena menu and exposes fallback menu', () => {
  const code = fs.readFileSync(path.join(bridgeRoot, 'Source/iXenaUnrealBridge/Private/iXenaUnrealBridgeModule.cpp'), 'utf8');
  assert.match(code, /ExtendMenu\(TEXT\("MainFrame\.MainMenu\.iXena"\)\)/);
  assert.match(code, /ExtendMenu\(TEXT\("LevelEditor\.MainMenu\.Window"\)\)/);
  assert.doesNotMatch(code, /AddSubMenu\(TEXT\("iXenaToolsMenu"\)/);
});
