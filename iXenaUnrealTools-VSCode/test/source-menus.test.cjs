'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const manifest = require('../package.json');
const command = 'iXenaUnrealTools.switchHeaderSource';
test('Switch command is present in all intended VSCode right-click menus and editor title', () => {
  assert.ok(manifest.contributes.commands.some(item => item.command === command));
  for (const menu of ['editor/context','editor/title/context','explorer/context','view/item/context','editor/title']) {
    const entries = manifest.contributes.menus[menu].filter(item => item.command === command);
    assert.equal(entries.length,1,menu);
    assert.match(entries[0].when,/resourceExtname/);
    assert.match(entries[0].when,/!\(resourceFilename =~/);
  }
  const custom = manifest.contributes.menus['view/item/context'].find(item => item.command === command);
  assert.match(custom.when, /ixenaUnrealTools\.explorer/);
  assert.match(custom.when, /viewItem == file/);
  assert.equal(manifest.publisher, 'ixena-unreal-tools');
});
