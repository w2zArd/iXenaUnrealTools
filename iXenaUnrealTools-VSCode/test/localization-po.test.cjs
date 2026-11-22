'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePo, updatePoTranslations, catalogStats, getEntryIssues, exportCatalog, importCatalog } = require('../dist/localizationPo.js');

// 使用可读而明确的 PO 数据，避免测试自身的嵌套引号掩盖文件内容。
const SIMPLE = String.raw`# translator
msgid ""
msgstr ""
"Language: zh-CN\n"
"Content-Type: text/plain; charset=UTF-8\n"

#. Key: Welcome
#: Source/Game/Welcome.cpp:24
#, fuzzy, c-format
msgctxt "Game,Welcome"
msgid "Hello {Player}\n"
"from space \"quoted\""
msgstr "旧翻译"

msgctxt "Game,Count"
msgid "One {Count} planet"
msgid_plural "Many {Count} planets"
msgstr[0] "一个 {Count} 星球"
msgstr[1] ""

#~ msgctxt "Old,Gone"
#~ msgid "Removed"
#~ msgstr "已删除"
`;

test('PO reads multiline Unicode, references, flags, plural forms and obsolete records', () => {
  const doc = parsePo(SIMPLE);
  assert.equal(doc.entries.length, 4);
  assert.equal(doc.entries[0].header, true);
  assert.equal(doc.entries[1].source, 'Hello {Player}\nfrom space "quoted"');
  assert.deepEqual(doc.entries[1].references, ['Source/Game/Welcome.cpp:24']);
  assert.deepEqual(doc.entries[1].flags, ['fuzzy', 'c-format']);
  assert.deepEqual(doc.entries[2].translations, ['一个 {Count} 星球', '']);
  assert.equal(doc.entries[3].obsolete, true);
  assert.deepEqual(catalogStats(doc), { total: 2, translated: 1, untranslated: 1, review: 1 });
});

test('one PO translation edit preserves BOM, CRLF, headers, comments, source and obsolete content', () => {
  const source = '\uFEFF' + SIMPLE.replace(/\n/g, '\r\n');
  const doc = parsePo(source), entry = doc.entries[1];
  assert.equal(updatePoTranslations(doc, []), source);
  const translation = '你好 {Player}\n来自星际 🛰️ "引用" \\ 路径';
  const result = updatePoTranslations(doc, [{ id: entry.id, translations: [translation] }]);
  const expected = source.replace('msgstr "旧翻译"', String.raw`msgstr "你好 {Player}\n来自星际 🛰️ \"引用\" \\ 路径"`);
  assert.equal(result, expected);
  assert.equal(parsePo(result).entries[1].translations[0], translation);
});

test('explicit review removes only fuzzy, keeps other flags and all other entries', () => {
  const doc = parsePo(SIMPLE), entry = doc.entries[1];
  const result = updatePoTranslations(doc, [{ id: entry.id, translations: entry.translations, reviewed: true }]);
  assert.equal(result, SIMPLE.replace('#, fuzzy, c-format', '#, c-format'));
  const marked = updatePoTranslations(parsePo(result), [{ id: entry.id, translations: entry.translations, reviewed: false }]);
  assert.ok(parsePo(marked).entries[1].flags.includes('fuzzy'));
  assert.ok(parsePo(marked).entries[1].flags.includes('c-format'));
});

test('review can remove a lone fuzzy comment without leaving malformed syntax', () => {
  const source = '#, fuzzy\r\nmsgctxt "A"\r\nmsgid "Hello"\r\nmsgstr "你好"\r\n';
  const entry = parsePo(source).entries[0];
  assert.equal(updatePoTranslations(parsePo(source), [{ id: entry.id, translations: ['你好'], reviewed: true }]), source.slice('#, fuzzy\r\n'.length));
});

test('same source in different namespaces keeps separate stable identities', () => {
  const source = 'msgctxt "A,Key"\nmsgid "Hello"\nmsgstr "A"\n\nmsgctxt "B,Key"\nmsgid "Hello"\nmsgstr "B"\n';
  const doc = parsePo(source);
  assert.notEqual(doc.entries[0].id, doc.entries[1].id);
  assert.equal(parsePo('# credit\n' + source).entries[0].id, doc.entries[0].id);
  const result = updatePoTranslations(doc, [{ id: doc.entries[1].id, translations: ['新 B'] }]);
  assert.equal(parsePo(result).entries[0].translations[0], 'A');
  assert.equal(parsePo(result).entries[1].translations[0], '新 B');
});

test('invalid or ambiguous PO cannot be silently rewritten', () => {
  for (const bad of [
    'msgid "Hello"\nmsgstr "broken',
    'msgid "Hello"\nmsgstr "bad\\q"\n',
    'msgid "Hello"\n',
    'msgid "Hello"\nmsgstr "A"\n\nmsgid "Hello"\nmsgstr "B"\n',
    'msgid "One"\nmsgid_plural "Many"\nmsgstr[1] "A"\n',
    'msgid "One"\nmsgid_plural "Many"\nmsgstr[0] "A"\nmsgstr[2] "B"\n',
    '"orphan"\n', 'not-a-po-file'
  ]) assert.throws(() => parsePo(bad), undefined, bad);
});

test('edits reject header, obsolete, unknown IDs, duplicated requests and changed plural shape', () => {
  const doc = parsePo(SIMPLE);
  for (const id of [doc.entries[0].id, doc.entries[3].id, 'missing']) assert.throws(() => updatePoTranslations(doc, [{ id, translations: ['x'] }]));
  assert.throws(() => updatePoTranslations(doc, [{ id: doc.entries[2].id, translations: ['lost plural'] }]));
  const change = { id: doc.entries[1].id, translations: ['x'] };
  assert.throws(() => updatePoTranslations(doc, [change, change]));
});

test('JSON export/import round-trips every plural and changes only matched source identities', () => {
  const doc = parsePo(SIMPLE);
  const json = JSON.parse(exportCatalog(doc, 'json', 'zh-CN'));
  assert.equal(json.entries.length, 2);
  assert.deepEqual(json.entries[1].translations, ['一个 {Count} 星球', '']);
  json.entries[1].translations = ['一颗 {Count} 星球', '多颗 {Count} 星球'];
  json.entries.push({ context: 'Game,Welcome', source: 'OLD SOURCE', translations: ['不能覆盖'] });
  const imported = importCatalog(doc, JSON.stringify(json), 'json', 'zh-CN');
  assert.equal(imported.matched, 2); assert.equal(imported.skipped, 1);
  const result = parsePo(updatePoTranslations(doc, imported.changes));
  assert.equal(result.entries[1].translations[0], '旧翻译');
  assert.deepEqual(result.entries[2].translations, json.entries[1].translations);
  assert.ok(imported.warnings.length > 0);
});

test('CSV is Excel-safe, reversible for leading apostrophes, quoted commas and multiline fields', () => {
  const source = String.raw`msgctxt "=HYPERLINK(\"evil\")"
msgid "  +SUM(1,2)\nsecond line"
msgstr "'literal,\"comma\"\n中文"

msgctxt "'literal-key"
msgid "@SUM(1,2)"
msgstr "=formula in translation is inside JSON"
`;
  const doc = parsePo(source), csv = exportCatalog(doc, 'csv', 'en');
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"\'=HYPERLINK'));
  assert.ok(csv.includes('"\'  +SUM'));
  assert.ok(csv.includes('"\'\'literal-key"'));
  assert.ok(csv.includes('"\'@SUM'));
  const imported = importCatalog(doc, csv, 'csv', 'en');
  assert.equal(imported.matched, 2); assert.equal(imported.skipped, 0);
  assert.deepEqual(imported.changes, []);
  assert.equal(updatePoTranslations(doc, imported.changes), source);
});

test('PO imports preserve source and context distinction, accept underscore culture equivalent', () => {
  const doc = parsePo(SIMPLE);
  const simpler = SIMPLE.replace('Language: zh-CN', 'Language: zh_CN').replace('msgstr "旧翻译"', 'msgstr "新翻译"');
  const imported = importCatalog(doc, simpler, 'po', 'zh-CN');
  assert.equal(imported.matched, 2);
  assert.equal(parsePo(updatePoTranslations(doc, imported.changes)).entries[1].translations[0], '新翻译');
});

test('wrong language, duplicate rows, invalid CSV and missing plural data fail before changes apply', () => {
  const doc = parsePo(SIMPLE);
  const json = JSON.parse(exportCatalog(doc, 'json', 'zh-CN'));
  assert.throws(() => importCatalog(doc, JSON.stringify({ ...json, culture: 'fr' }), 'json', 'zh-CN'));
  assert.throws(() => importCatalog(doc, SIMPLE.replace('Language: zh-CN', 'Language: fr'), 'po', 'zh-CN'));
  assert.throws(() => importCatalog(doc, JSON.stringify({ ...json, entries: [json.entries[0], json.entries[0]] }), 'json', 'zh-CN'));
  const incomplete = structuredClone(json); incomplete.entries[1].translations = ['only one'];
  assert.throws(() => importCatalog(doc, JSON.stringify(incomplete), 'json', 'zh-CN'));
  const csv = exportCatalog(doc, 'csv', 'zh-CN');
  assert.throws(() => importCatalog(doc, csv.replace('zh-CN', 'fr'), 'csv', 'zh-CN'));
  assert.throws(() => importCatalog(doc, csv + '"not closed', 'csv', 'zh-CN'));
});

test('format checks detect missing/extra UE arguments, line breaks and fuzzy without treating escaped braces as arguments', () => {
  const entry = parsePo('msgid "Hi {Player}\\n`{literal`} {Count}"\nmsgstr "Hi {Other} {Count}"\n').entries[0];
  const issues = getEntryIssues(entry);
  assert.equal(issues.length, 2);
  assert.ok(issues[0].includes('Player')); assert.ok(issues[0].includes('Other'));
  assert.ok(!issues[0].includes('literal'));
  entry.translations = ['你好 {Player}\n`{literal`} {Count}'];
  assert.deepEqual(getEntryIssues(entry), []);
});

test('numeric byte escapes decode as UTF-8 and unsupported charsets cannot be rewritten', () => {
  const doc = parsePo(String.raw`msgid "Caf\303\251"
msgstr "\xE6\x98\x9F\xE7\x90\x83"
`);
  assert.equal(doc.entries[0].source, 'Café');
  assert.equal(doc.entries[0].translations[0], '星球');
  assert.throws(() => parsePo('msgid ""\nmsgstr "Content-Type: text/plain; charset=ISO-8859-1\\n"\n'));
  assert.throws(() => parsePo(String.raw`msgid "Bad \377"
msgstr ""
`));
  assert.throws(() => parsePo(String.raw`msgid "Bad \x1234"
msgstr ""
`));
});

test('an empty Language header does not consume the following Content-Type header', () => {
  const doc = parsePo(SIMPLE);
  const incoming = SIMPLE.replace('Language: zh-CN', 'Language:');
  const imported = importCatalog(doc, incoming, 'po', 'zh-CN');
  assert.equal(imported.matched, 2);
  assert.ok(imported.warnings.length > 0);
});
