'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeDescriptor, rewriteDescriptor, planDescriptorEdit, assertDescriptorVersion, descriptorKind } = require('../dist/descriptorModel.js');

test('descriptor kind recognizes project/plugin case-insensitively and excludes other files', () => {
  assert.equal(descriptorKind('D:\\中文\\Planet.UPLUGIN'), 'uplugin');
  assert.equal(descriptorKind('A.uproject'), 'uproject');
  assert.equal(descriptorKind('A.uproject.exe'), undefined);
});

test('opening and assigning identical values preserve all bytes, absence and false values', () => {
  const source = '\uFEFF{\r\n\t"FileVersion": 3,\r\n\t"FriendlyName": "中文😀",\r\n\t"CanContainContent": false\r\n}\r\n';
  const analysis = analyzeDescriptor(source, 'uplugin');
  assert.equal(analysis.valid, true);
  assert.equal(Object.hasOwn(analysis.data, 'EnabledByDefault'), false);
  assert.equal(analysis.data.CanContainContent, false);
  assert.equal(rewriteDescriptor(source, 'uplugin', { type: 'set', path: ['FriendlyName'], value: '中文😀' }), source);
  assert.deepEqual(planDescriptorEdit(source, 'uplugin', { type: 'delete', path: ['EnabledByDefault'] }).edits, []);
});

test('a property change preserves unknown root/row fields and precise number literals', () => {
  const source = '{"FileVersion":3,"Modules":[{"Name":"Planet","Type":"Runtime","LoadingPhase":"CustomPhase","Vendor":{"Flag":false}}],"VendorBigInt":9007199254740993123,"Scale":1e-12}';
  const updated = rewriteDescriptor(source, 'uplugin', { type: 'set', path: ['Modules', 0, 'Type'], value: 'Editor' });
  assert.equal(JSON.parse(updated).Modules[0].Type, 'Editor');
  assert.equal(JSON.parse(updated).Modules[0].LoadingPhase, 'CustomPhase');
  assert.deepEqual(JSON.parse(updated).Modules[0].Vendor, { Flag: false });
  assert.ok(updated.includes('9007199254740993123'));
  assert.ok(updated.includes('1e-12'));
});

test('UTF-16 offsets with BOM and astral characters target the intended property', () => {
  const source = '\uFEFF{\r\n  "FileVersion": 3,\r\n  "Description": "星球🌎",\r\n  "FriendlyName": "旧名称"\r\n}\r\n';
  const updated = rewriteDescriptor(source, 'uplugin', { type: 'set', path: ['FriendlyName'], value: '新名称🛰️' });
  assert.equal(updated.charCodeAt(0), 0xFEFF);
  assert.equal(JSON.parse(updated.slice(1)).Description, '星球🌎');
  assert.equal(JSON.parse(updated.slice(1)).FriendlyName, '新名称🛰️');
  assert.ok(updated.endsWith('\r\n'));
});

test('old platform names remain old when unrelated properties or old list are edited', () => {
  const source = '{"FileVersion":3,"Modules":[{"Name":"PW","Type":"Runtime","WhitelistPlatforms":["Win64"],"BlacklistPlatforms":["Linux"],"UnknownField":true}]}';
  const updated = rewriteDescriptor(source, 'uplugin', { type: 'set', path: ['Modules', 0, 'WhitelistPlatforms'], value: ['Win64', 'Mac'] });
  const row = JSON.parse(updated).Modules[0];
  assert.deepEqual(row.WhitelistPlatforms, ['Win64', 'Mac']);
  assert.deepEqual(row.BlacklistPlatforms, ['Linux']);
  assert.equal(row.UnknownField, true);
  assert.equal(Object.hasOwn(row, 'PlatformAllowList'), false);
  assert.equal(Object.hasOwn(row, 'PlatformDenyList'), false);
});

test('coexisting platform names and explicit empty platform semantics are surfaced without migration', () => {
  const source = '{"FileVersion":3,"Plugins":[{"Name":"X","Enabled":true,"WhitelistPlatforms":["Win64"],"PlatformAllowList":[],"HasExplicitPlatforms":true}]}';
  const state = analyzeDescriptor(source, 'uproject');
  assert.equal(state.valid, true);
  assert.ok(state.warnings.some(w => w.includes('同时含新旧平台字段')));
  assert.ok(state.warnings.some(w => w.includes('HasExplicitPlatforms')));
  assert.equal(rewriteDescriptor(source, 'uproject', { type: 'set', path: ['Plugins', 0, 'Enabled'], value: true }), source);
});

test('missing collections can be added, edited and removed without changing the other collection', () => {
  let source = '{"FileVersion":3,"Vendor":{"Keep":"yes"}}';
  source = rewriteDescriptor(source, 'uproject', { type: 'add', collection: 'Modules', value: { Name: 'Game', Type: 'Runtime', LoadingPhase: 'Default' } });
  source = rewriteDescriptor(source, 'uproject', { type: 'add', collection: 'Plugins', value: { Name: 'PlanetWorld', Enabled: true } });
  source = rewriteDescriptor(source, 'uproject', { type: 'add', collection: 'Plugins', value: { Name: 'QtQuickUI', Enabled: true, Optional: false } });
  source = rewriteDescriptor(source, 'uproject', { type: 'set', path: ['Plugins', 1, 'Enabled'], value: false });
  source = rewriteDescriptor(source, 'uproject', { type: 'remove', collection: 'Plugins', index: 0 });
  const data = JSON.parse(source);
  assert.deepEqual(data.Plugins, [{ Name: 'QtQuickUI', Enabled: false, Optional: false }]);
  assert.equal(data.Modules[0].Name, 'Game');
  assert.deepEqual(data.Vendor, { Keep: 'yes' });
});

test('false, empty array and absent field remain distinct', () => {
  let source = '{"FileVersion":3}';
  source = rewriteDescriptor(source, 'uplugin', { type: 'set', path: ['EnabledByDefault'], value: false });
  source = rewriteDescriptor(source, 'uplugin', { type: 'set', path: ['SupportedTargetPlatforms'], value: [] });
  assert.equal(JSON.parse(source).EnabledByDefault, false);
  assert.deepEqual(JSON.parse(source).SupportedTargetPlatforms, []);
  source = rewriteDescriptor(source, 'uplugin', { type: 'delete', path: ['SupportedTargetPlatforms'] });
  assert.equal(Object.hasOwn(JSON.parse(source), 'SupportedTargetPlatforms'), false);
});

test('invalid JSON, duplicate keys and malformed collections cannot be overwritten', () => {
  for (const source of ['{"FileVersion":3,}', '{/*comment*/"FileVersion":3}', '{"FileVersion":3,"FileVersion":4}',
    '{"FileVersion":3,"Vendor":{"key":1,"key":2}}', '{"FileVersion":3,"Modules":"broken"}',
    '{"FileVersion":3,"Plugins":[null]}', '[]', 'null']) {
    assert.equal(analyzeDescriptor(source, 'uplugin').valid, false, source);
    assert.throws(() => rewriteDescriptor(source, 'uplugin', { type: 'set', path: ['FriendlyName'], value: 'X' }));
  }
});

test('editing accepts existing unknown enum values but blocks arbitrary property paths', () => {
  const source = '{"FileVersion":3,"Modules":[{"Name":"Game","Type":"VendorCustomType"}]}';
  assert.equal(analyzeDescriptor(source, 'uproject').valid, true);
  assert.equal(JSON.parse(rewriteDescriptor(source, 'uproject', { type: 'set', path: ['Modules', 0, 'LoadingPhase'], value: 'VendorPhase' })).Modules[0].Type, 'VendorCustomType');
  for (const path of [[], ['__proto__', 'polluted'], ['constructor'], ['Vendor'], ['Modules', -1, 'Name'], ['Modules', 1, 'Name'], ['Modules', 0, 'Vendor']]) {
    assert.throws(() => rewriteDescriptor(source, 'uproject', { type: 'set', path, value: 'unsafe' }));
  }
  assert.equal({}.polluted, undefined);
});

test('names, required fields, integer ranges and duplicate rows are validated before editing', () => {
  const source = '{"FileVersion":3,"Modules":[{"Name":"Game","Type":"Runtime"}],"Plugins":[{"Name":"PlanetWorld","Enabled":true}]}';
  const bad = [
    { type: 'add', collection: 'Modules', value: { Name: 'game', Type: 'Editor' } },
    { type: 'add', collection: 'Plugins', value: { Name: 'PlanetWorld', Enabled: false } },
    { type: 'add', collection: 'Modules', value: { Name: 'New' } },
    { type: 'add', collection: 'Plugins', value: { Name: 'Other', Enabled: 'true' } },
    { type: 'set', path: ['Modules', 0, 'Name'], value: '12Invalid' },
    { type: 'set', path: ['FileVersion'], value: 0 },
    { type: 'set', path: ['FileVersion'], value: 1.5 },
    { type: 'set', path: ['Plugins', 0, 'PlatformAllowList'], value: ['Win64', 'win64'] },
    { type: 'delete', path: ['FileVersion'] },
    { type: 'remove', collection: 'Plugins', index: 5 }
  ];
  for (const operation of bad) assert.throws(() => rewriteDescriptor(source, 'uproject', operation), JSON.stringify(operation));
});

test('document version mismatches reject concurrent edits', () => {
  assert.doesNotThrow(() => assertDescriptorVersion(7, 7));
  for (const expected of [6, 8, '7', undefined, NaN]) assert.throws(() => assertDescriptorVersion(7, expected));
});

test('descriptor schema uses Enterprise JSON key while preserving unknown member-style keys', () => {
  const source = '{"FileVersion":3,"IsEnterpriseProject":true}';
  const analysis = analyzeDescriptor(source, 'uproject');
  assert.ok(analysis.rootFields.some(field => field.key === 'Enterprise'));
  assert.ok(!analysis.rootFields.some(field => field.key === 'IsEnterpriseProject'));
  const updated = JSON.parse(rewriteDescriptor(source, 'uproject', { type: 'set', path: ['Enterprise'], value: false }));
  assert.equal(updated.IsEnterpriseProject, true);
  assert.equal(updated.Enterprise, false);
});
