const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EXPLORER_EXTENSION_ID, EXPLORER_URI_PATH, EXPLORER_MAX_QUERY_LENGTH,
  parseExplorerRequest, encodeExplorerRequest, validateExplorerFilePath,
  explorerRegistryKeyName, explorerRegistryPaths,
} = require('../dist/explorerModel.js');

const rawQuery = value => 'payload=' + Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
const request = (file = 'D:\\Games\\Test.uproject', action = 'edit') => ({ version: 1, action, file });

test('Explorer payload round-trips Unicode, shell characters and literal percent escapes without double decoding', () => {
  for (const file of [
    'D:\\我的工程 😀\\A & B # 100% + $`\' ; () = @ [test]\\Star%26chain.uproject',
    'C:\\Plugins\\PlanetWorld.uplugin',
    '\\\\server\\shared projects\\星球#100% & moon\\PlanetWorld.uplugin',
  ]) {
    for (const action of ['open', 'edit', 'source']) {
      const expected = request(file, action);
      const query = encodeExplorerRequest(expected);
      assert.match(query, /^payload=[A-Za-z0-9_-]+$/);
      assert.deepEqual(parseExplorerRequest(EXPLORER_URI_PATH, query), expected);
      // URL/URI decoding cannot reinterpret a percent-encoded substring in the file path.
      assert.deepEqual(parseExplorerRequest(EXPLORER_URI_PATH, decodeURIComponent(query)), expected);
    }
  }
});

test('Explorer accepts Windows drive and UNC paths independent of the test host', () => {
  assert.equal(validateExplorerFilePath('c:/Games/Star.UPROJECT'), 'c:\\Games\\Star.UPROJECT');
  assert.equal(validateExplorerFilePath('//server/share/Planet.uplugin'), '\\\\server\\share\\Planet.uplugin');
});

test('Explorer rejects unsupported protocols, routes, extra query keys and invalid base64url', () => {
  const query = encodeExplorerRequest(request());
  for (const route of ['', '/build', '/explorer/', 'explorer', '/command/execute']) {
    assert.throws(() => parseExplorerRequest(route, query));
  }
  for (const invalid of ['', 'file=D%3A%5CP.uproject', query + '&action=build', query + '&payload=x',
    query + '=', 'payload=aa+', 'payload=aa/', 'payload=aa%3D', 'payload=Z', 'payload=Zh']) {
    assert.throws(() => parseExplorerRequest(EXPLORER_URI_PATH, invalid));
  }
  assert.throws(() => parseExplorerRequest(EXPLORER_URI_PATH, 'payload=' + 'a'.repeat(EXPLORER_MAX_QUERY_LENGTH)));
});

test('Explorer rejects arbitrary actions, schema versions, inherited and unexpected command fields', () => {
  for (const invalid of [null, [], 'x', 1, {}, { ...request(), version: '1' }, { ...request(), version: 2 },
    { ...request(), action: 'build' }, { ...request(), action: 'iXenaUnrealTools.build' },
    { ...request(), command: 'calc.exe' }, { ...request(), args: [] }, { ...request(), file: null },
    JSON.parse('{"version":1,"action":"edit","file":"D:\\\\P.uproject","__proto__":{}}')]) {
    assert.throws(() => parseExplorerRequest(EXPLORER_URI_PATH, rawQuery(invalid)));
  }
});

test('Explorer rejects malformed UTF-8 instead of replacing invalid bytes inside paths', () => {
  const prefix = Buffer.from('{"version":1,"action":"edit","file":"D:\\\\');
  const suffix = Buffer.from('.uproject"}');
  const malformed = Buffer.concat([prefix, Buffer.from([0xc0, 0xaf]), suffix]);
  assert.throws(() => parseExplorerRequest(EXPLORER_URI_PATH, 'payload=' + malformed.toString('base64url')));
});

test('Explorer rejects relative, device, reserved, ADS and malformed descriptor paths', () => {
  for (const invalid of [
    '', 'Planet.uproject', 'C:Planet.uproject', '\\Planet.uproject', '/tmp/Planet.uproject',
    'https://example.com/P.uproject', 'file:///C:/P.uproject', '\\\\?\\C:\\Planet.uproject',
    '\\\\.\\C:\\Planet.uproject', '\\??\\C:\\Planet.uproject', '\\\\server\\P.uproject',
    'D:\\NUL.uproject', 'D:\\AUX\\Planet.uproject', 'D:\\Test.cpp', 'D:\\P.uproject:stream',
    'D:\\project \\P.uproject', 'D:\\project.\\P.uproject', 'D:\\..\\P.uproject',
    'D:\\project\\.\\P.uproject', 'D:\\project\\\\P.uproject', 'D:\\a\nP.uproject',
    'D:\\a\u0000P.uproject', 'D:\\a"P.uproject', 'D:\\a*P.uproject', 'D:\\a?P.uproject',
    'D:\\' + 'a'.repeat(8192) + '.uproject',
  ]) {
    assert.throws(() => validateExplorerFilePath(invalid), invalid);
    assert.throws(() => parseExplorerRequest(EXPLORER_URI_PATH, rawQuery(request(invalid))), invalid);
  }
});

test('Explorer registry ownership stays limited to current-user descriptor verbs and separates VSCode editions', () => {
  assert.equal(EXPLORER_EXTENSION_ID, 'ixena-unreal-tools.ixena-unreal-tools-vscode');
  assert.equal(explorerRegistryKeyName('vscode'), 'iXenaUnrealTools.vscode');
  assert.equal(explorerRegistryKeyName('vscode-insiders'), 'iXenaUnrealTools.vscode-insiders');
  const stable = explorerRegistryPaths('vscode');
  const insiders = explorerRegistryPaths('vscode-insiders');
  assert.deepEqual(stable, [
    'HKCU\\Software\\Classes\\SystemFileAssociations\\.uproject\\shell\\iXenaUnrealTools.vscode',
    'HKCU\\Software\\Classes\\SystemFileAssociations\\.uplugin\\shell\\iXenaUnrealTools.vscode',
  ]);
  assert.equal(insiders.length, 2);
  assert.ok(insiders.every(key => !stable.includes(key)));
  for (const invalid of ['', '1invalid', 'vscode\\..\\shell', 'vscode/evil', 'VSCODE', 'vscode:', 'vscode\n', 'a'.repeat(65)]) {
    assert.throws(() => explorerRegistryPaths(invalid));
  }
});
