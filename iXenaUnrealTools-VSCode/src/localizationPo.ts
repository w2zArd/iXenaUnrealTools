import { createHash } from 'node:crypto';
import { tr } from './i18n';

/** PO 是翻译交换格式；这里不重写 UE 的 manifest、archive 或二进制 locres。 */
export interface PoEntry {
  id: string;
  context: string;
  source: string;
  pluralSource?: string;
  translations: string[];
  comments: string[];
  references: string[];
  flags: string[];
  obsolete: boolean;
  header: boolean;
  line: number;
}
export interface PoDocument { text: string; entries: PoEntry[]; newline: string; bom: boolean; }
export interface PoChange { id: string; translations: string[]; reviewed?: boolean; }
export interface CatalogStats { total: number; translated: number; untranslated: number; review: number; }
export interface CatalogImport { changes: PoChange[]; matched: number; skipped: number; warnings: string[]; }
interface Line { text: string; start: number; end: number; after: number; number: number; }
interface Field { name: 'msgctxt' | 'msgid' | 'msgid_plural' | 'msgstr'; index?: number; value: string; start: number; end: number; indent: string; }
interface EntrySpans { fields: Field[]; flags: Line[]; firstField: number; }
interface Builder { fields: Field[]; comments: string[]; flags: Line[]; obsolete?: boolean; line: number; }
const details = new WeakMap<PoDocument, Map<string, EntrySpans>>();
const MAX_BYTES = 64 * 1024 * 1024;

function fail(chinese: string, english: string, ...args: unknown[]): never { throw new Error(tr(chinese, english, ...args)); }
function identity(context: string, source: string, pluralSource?: string): string {
  return createHash('sha256').update(JSON.stringify([context, source, pluralSource ?? null])).digest('hex');
}
function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let start = text.startsWith('\uFEFF') ? 1 : 0, number = 1;
  while (start < text.length) {
    const lf = text.indexOf('\n', start), after = lf < 0 ? text.length : lf + 1;
    const end = lf < 0 ? text.length : lf > start && text[lf - 1] === '\r' ? lf - 1 : lf;
    lines.push({ text: text.slice(start, end), start, end, after, number: number++ });
    start = after;
  }
  return lines;
}

/** 不使用 eval；遇到不认识的转义或语法时中止，避免保存后悄悄丢失数据。 */
function decodeQuoted(value: string, line: number): string {
  if (!/^"(?:[^"\\]|\\.)*"$/u.test(value)) {
    fail('PO 第 {0} 行的字符串引号不完整。', 'Invalid quoted PO string on line {0}.', line);
  }
  let result = '';
  for (let index = 1; index < value.length - 1; index++) {
    const character = value[index];
    if (character !== '\\') { result += character; continue; }
    const escaped = value[++index];
    const simple: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', a: '\x07', '\\': '\\', '"': '"', '?': '?' };
    if (Object.hasOwn(simple, escaped)) { result += simple[escaped]; continue; }
    if (/[0-7x]/.test(escaped)) {
      // PO 数字转义描述编码后的字节，不能把 UTF-8 的 \303\251 误当成两个 Unicode 字符。
      const bytes: number[] = [];
      while (true) {
        const first = value[index];
        let digits: string;
        if (first === 'x') {
          const match = /^[0-9a-fA-F]+/.exec(value.slice(index + 1))?.[0];
          if (!match) fail('PO 第 {0} 行的十六进制转义无效。', 'Invalid hexadecimal escape on PO line {0}.', line);
          digits = match; index += digits.length;
          const byte = parseInt(digits, 16);
          if (byte > 255) fail('PO 第 {0} 行的字节转义超出范围。', 'A byte escape on PO line {0} is out of range.', line);
          bytes.push(byte);
        } else {
          digits = first;
          while (digits.length < 3 && /[0-7]/.test(value[index + 1] ?? 'x')) digits += value[++index];
          const byte = parseInt(digits, 8);
          if (byte > 255) fail('PO 第 {0} 行的字节转义超出范围。', 'A byte escape on PO line {0} is out of range.', line);
          bytes.push(byte);
        }
        if (value[index + 1] === '\\' && /[0-7x]/.test(value[index + 2] ?? 'z')) index += 2;
        else break;
      }
      try { result += new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)); }
      catch { fail('PO 第 {0} 行的字节转义不是有效 UTF-8。', 'Byte escapes on PO line {0} are not valid UTF-8.', line); }
      continue;
    }
    fail('PO 第 {0} 行包含不支持的转义：{1}。', 'Unsupported escape on PO line {0}: {1}.', line, `\\${escaped}`);
  }
  return result;
}
function encodeQuoted(value: string): string {
  return '"' + value.replace(/[\\"\x00-\x1f\x7f]/g, character => {
    const simple: Record<string, string> = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f', '\v': '\\v', '\x07': '\\a' };
    return simple[character] ?? `\\${character.charCodeAt(0).toString(8).padStart(3, '0')}`;
  }) + '"';
}

export function parsePo(text: string): PoDocument {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
    fail('PO 文件无效或超过 64 MiB。', 'The PO file is invalid or exceeds 64 MiB.');
  }
  const document: PoDocument = { text, entries: [], newline: text.includes('\r\n') ? '\r\n' : '\n', bom: text.startsWith('\uFEFF') };
  const spans = new Map<string, EntrySpans>(), activeIds = new Set<string>();
  let builder: Builder = { fields: [], comments: [], flags: [], line: 1 };
  let continuation: Field | undefined;
  const finish = () => {
    if (!builder.fields.length) { builder = { fields: [], comments: [], flags: [], line: 1 }; continuation = undefined; return; }
    const sources = builder.fields.filter(field => field.name === 'msgid');
    const contexts = builder.fields.filter(field => field.name === 'msgctxt');
    const plurals = builder.fields.filter(field => field.name === 'msgid_plural');
    const translations = builder.fields.filter(field => field.name === 'msgstr');
    if (sources.length !== 1 || contexts.length > 1 || plurals.length > 1 || !translations.length) {
      fail('PO 第 {0} 行附近缺少或重复 msgid / msgstr 字段。', 'Missing or duplicate msgid / msgstr near PO line {0}.', builder.line);
    }
    if (plurals.length) {
      const indices = translations.map(field => field.index);
      if (indices.some((index, position) => index !== position)) {
        fail('PO 第 {0} 行的复数翻译必须从 msgstr[0] 连续编号。', 'Plural translations near PO line {0} must be consecutively numbered from msgstr[0].', builder.line);
      }
    } else if (translations.length !== 1 || translations[0].index !== undefined) {
      fail('PO 第 {0} 行的单数条目必须只有一个 msgstr。', 'A singular entry near PO line {0} must contain exactly one msgstr.', builder.line);
    }
    const context = contexts[0]?.value ?? '', source = sources[0].value, pluralSource = plurals[0]?.value;
    const obsolete = Boolean(builder.obsolete);
    const stableId = identity(context, source, pluralSource);
    if (!obsolete && activeIds.has(stableId)) fail('PO 存在重复的文本身份，已停止编辑：{0}', 'Duplicate PO identity; editing was stopped: {0}', context || source);
    if (!obsolete) activeIds.add(stableId);
    // 废弃条目单独编号，既能完整保留，又不会与现用条目发生碰撞。
    const id = obsolete ? `${stableId}:obsolete:${document.entries.length}` : stableId;
    const flags = builder.comments.filter(comment => /^#,/.test(comment)).flatMap(comment => comment.slice(2).split(',').map(flag => flag.trim()).filter(Boolean));
    const entry: PoEntry = { id, context, source, pluralSource, translations: translations.map(field => field.value),
      comments: [...builder.comments], references: builder.comments.filter(comment => /^#:/.test(comment)).map(comment => comment.slice(2).trim()).filter(Boolean),
      flags: [...new Set(flags)], obsolete, header: !obsolete && !context && source === '' && pluralSource === undefined,
      line: builder.line };
    document.entries.push(entry);
    spans.set(id, { fields: builder.fields, flags: builder.flags, firstField: builder.fields[0].start });
    builder = { fields: [], comments: [], flags: [], line: 1 }; continuation = undefined;
  };
  for (const line of linesOf(text)) {
    let normalized = line.text.trim();
    if (!normalized) { finish(); continue; }
    const obsolete = /^#~\s/.test(normalized);
    if (obsolete) normalized = normalized.replace(/^#~\s*/, '');
    if (normalized.startsWith('#')) {
      if (builder.fields.some(field => field.name === 'msgstr')) finish();
      builder.comments.push(normalized);
      if (/^#,/.test(normalized)) builder.flags.push(line);
      continuation = undefined; continue;
    }
    const match = /^(msgctxt|msgid_plural|msgid|msgstr)(?:\[(\d+)\])?\s+(".*")$/.exec(normalized);
    if (match) {
      const name = match[1] as Field['name'];
      if ((name === 'msgctxt' && builder.fields.length) || (name === 'msgid' && builder.fields.some(field => field.name === 'msgid'))
          || (builder.obsolete !== undefined && builder.obsolete !== obsolete)) finish();
      if (match[2] !== undefined && name !== 'msgstr') fail('PO 第 {0} 行只有 msgstr 可以有复数下标。', 'Only msgstr may have a plural index on PO line {0}.', line.number);
      if (!builder.fields.length) builder.line = line.number;
      builder.obsolete = obsolete;
      const field: Field = { name, index: match[2] === undefined ? undefined : Number(match[2]), value: decodeQuoted(match[3], line.number),
        start: line.start, end: line.end, indent: /^\s*/.exec(line.text)?.[0] ?? '' };
      if (name !== 'msgctxt' && name !== 'msgid' && !builder.fields.some(previous => previous.name === 'msgid')) {
        fail('PO 第 {0} 行的字段顺序无效，尚未出现 msgid。', 'Invalid PO field order on line {0}: msgid has not appeared.', line.number);
      }
      builder.fields.push(field); continuation = field; continue;
    }
    if (normalized.startsWith('"')) {
      if (!continuation || builder.obsolete !== obsolete) fail('PO 第 {0} 行的续行没有对应字段。', 'The continuation on PO line {0} has no field.', line.number);
      continuation.value += decodeQuoted(normalized, line.number); continuation.end = line.end; continue;
    }
    fail('无法识别 PO 第 {0} 行；为保护文件，已停止编辑。', 'Unrecognized PO syntax on line {0}; editing was stopped to protect the file.', line.number);
  }
  finish();
  const header = document.entries.find(entry => entry.header)?.translations[0] ?? '';
  const charset = /charset[ \t]*=[ \t]*([^;\s]+)/i.exec(header)?.[1];
  if (charset && !/^(?:UTF-?8|CHARSET)$/i.test(charset)) {
    fail('仅支持 UTF-8 PO 文件；当前编码为 {0}，请先转换编码。', 'Only UTF-8 PO files are supported; convert the current {0} encoding first.', charset);
  }
  details.set(document, spans);
  return document;
}

/** 始终依据原始文本重新校验；只替换翻译字段，不重新排版整个 PO。 */
export function updatePoTranslations(document: PoDocument, changes: readonly PoChange[]): string {
  const verified = parsePo(document.text), spans = details.get(verified)!;
  const lookup = new Map(verified.entries.map(entry => [entry.id, entry]));
  const edits: Array<{ start: number; end: number; value: string }> = [], seen = new Set<string>();
  for (const change of changes) {
    if (!change || typeof change.id !== 'string' || seen.has(change.id)) fail('翻译修改包含无效或重复的条目。', 'Translation edits contain an invalid or duplicate entry.');
    seen.add(change.id);
    const entry = lookup.get(change.id);
    if (!entry || entry.header || entry.obsolete) fail('无法修改不存在、废弃或头部条目。', 'Missing, obsolete and header entries cannot be edited.');
    if (!Array.isArray(change.translations) || change.translations.length !== entry.translations.length
        || change.translations.some(value => typeof value !== 'string') || (change.reviewed !== undefined && typeof change.reviewed !== 'boolean')) {
      fail('翻译的类型或复数数量与原始 PO 不一致。', 'Translation types or plural-form count do not match the original PO.');
    }
    const entrySpans = spans.get(entry.id)!;
    const fields = entrySpans.fields.filter(field => field.name === 'msgstr');
    fields.forEach((field, index) => {
      if (change.translations[index] !== entry.translations[index]) edits.push({ start: field.start, end: field.end,
        value: `${field.indent}msgstr${field.index === undefined ? '' : `[${field.index}]`} ${encodeQuoted(change.translations[index])}` });
    });
    if (change.reviewed === true && entry.flags.includes('fuzzy')) {
      for (const line of entrySpans.flags) {
        const current = line.text.trim().slice(2).split(',').map(flag => flag.trim()).filter(Boolean);
        if (!current.includes('fuzzy')) continue;
        const remaining = current.filter(flag => flag !== 'fuzzy');
        edits.push({ start: line.start, end: remaining.length ? line.end : line.after,
          value: remaining.length ? `${/^\s*/.exec(line.text)?.[0] ?? ''}#, ${remaining.join(', ')}` : '' });
      }
    } else if (change.reviewed === false && !entry.flags.includes('fuzzy')) {
      edits.push({ start: entrySpans.firstField, end: entrySpans.firstField, value: `#, fuzzy${verified.newline}` });
    }
  }
  edits.sort((left, right) => right.start - left.start || right.end - left.end);
  let result = verified.text, boundary = result.length;
  for (const edit of edits) {
    if (edit.end > boundary) fail('PO 修改范围重叠，已取消保存。', 'PO edits overlap; saving was cancelled.');
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
    boundary = edit.start;
  }
  parsePo(result);
  return result;
}

function placeholders(value: string): Set<string> {
  const unescaped = value.replace(/`[{}|`]/g, '');
  return new Set([...unescaped.matchAll(/\{([\p{L}\p{N}_]+)\}/gu)].map(match => match[1]));
}
export function getEntryIssues(entry: PoEntry): string[] {
  if (entry.header || entry.obsolete) return [];
  const issues: string[] = [];
  if (entry.flags.includes('fuzzy')) issues.push(tr('此翻译标记为 fuzzy，需要复核。', 'This translation is marked fuzzy and needs review.'));
  entry.translations.forEach((translation, index) => {
    if (!translation) return;
    const source = index > 0 && entry.pluralSource !== undefined ? entry.pluralSource : entry.source;
    const expected = placeholders(source), actual = placeholders(translation);
    const missing = [...expected].filter(name => !actual.has(name)), extra = [...actual].filter(name => !expected.has(name));
    if (missing.length || extra.length) issues.push(tr('翻译 {0} 的格式参数不一致；缺少 [{1}]，多出 [{2}]。',
      'Translation {0} has different format arguments; missing [{1}], extra [{2}].', index + 1, missing.join(', '), extra.join(', ')));
    if ((source.match(/\n/g)?.length ?? 0) !== (translation.match(/\n/g)?.length ?? 0)) {
      issues.push(tr('翻译 {0} 的换行数量与原文不同，请确认排版。', 'Translation {0} has a different number of line breaks; check its layout.', index + 1));
    }
  });
  return issues;
}
export function catalogStats(document: PoDocument): CatalogStats {
  const entries = document.entries.filter(entry => !entry.header && !entry.obsolete);
  const translated = entries.filter(entry => entry.translations.every(value => value.length > 0)).length;
  return { total: entries.length, translated, untranslated: entries.length - translated,
    review: entries.filter(entry => getEntryIssues(entry).length > 0).length };
}

interface ExchangeRow { context: string; source: string; pluralSource?: string; translations: string[]; reviewed?: boolean; }
const csvFields = ['schema', 'culture', 'context', 'source', 'pluralSource', 'translations', 'reviewed'];
function checkCulture(culture: unknown): asserts culture is string {
  if (typeof culture !== 'string' || !/^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/.test(culture)) fail('语言代码无效。', 'Invalid culture code.');
}
function sameCulture(left: string, right: string): boolean { return left.toLowerCase().replace(/_/g, '-') === right.toLowerCase().replace(/_/g, '-'); }
function assertCulture(received: unknown, culture: string): void {
  checkCulture(received);
  if (!sameCulture(received, culture)) fail('导入语言 {0} 与当前语言 {1} 不一致。', 'Imported culture {0} does not match selected culture {1}.', received, culture);
}
/** Excel 公式防护采用可逆的单引号前缀，原有前导单引号也会加倍。 */
function needsExcelEscape(value: string): boolean { return /^[\t\r\n']/.test(value) || /^\s*[=+@-]/.test(value); }
function csvEncode(value: string): string { const safe = needsExcelEscape(value) ? `'${value}` : value; return `"${safe.replace(/"/g, '""')}"`; }
function csvDecode(value: string): string { return value.startsWith("'") && needsExcelEscape(value.slice(1)) ? value.slice(1) : value; }
function readCsv(text: string): string[][] {
  text = text.replace(/^\uFEFF/, '');
  const rows: string[][] = []; let row: string[] = [], value = '', quoted = false, closed = false;
  for (let index = 0; index < text.length; index++) {
    const c = text[index];
    if (quoted) {
      if (c === '"') { if (text[index + 1] === '"') { value += '"'; index++; } else { quoted = false; closed = true; } }
      else value += c;
    } else if (c === '"') {
      if (value || closed) fail('CSV 引号格式无效。', 'Invalid CSV quoting.');
      quoted = true;
    } else if (c === ',') { row.push(value); value = ''; closed = false; }
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[index + 1] === '\n') index++;
      row.push(value); if (row.length > 1 || row[0] !== '') rows.push(row);
      row = []; value = ''; closed = false;
    } else {
      if (closed) fail('CSV 引号结束后包含多余字符。', 'Unexpected text after a CSV closing quote.');
      value += c;
    }
  }
  if (quoted) fail('CSV 引号未闭合。', 'Unclosed CSV quoted field.');
  if (value || row.length || closed) { row.push(value); rows.push(row); }
  return rows;
}
function exchangeRows(document: PoDocument): ExchangeRow[] {
  return document.entries.filter(entry => !entry.header && !entry.obsolete).map(entry => ({ context: entry.context,
    source: entry.source, pluralSource: entry.pluralSource, translations: [...entry.translations], reviewed: !entry.flags.includes('fuzzy') }));
}
export function exportCatalog(document: PoDocument, format: 'csv' | 'json', culture: string): string {
  checkCulture(culture);
  const entries = exchangeRows(parsePo(document.text));
  if (format === 'json') return JSON.stringify({ format: 'ixena-localization', version: 1, culture, entries }, null, 2) + '\n';
  if (format !== 'csv') fail('不支持此导出格式。', 'Unsupported export format.');
  const rows = entries.map(entry => ['ixena-po-csv-v1', culture, entry.context, entry.source,
    JSON.stringify(entry.pluralSource ?? null), JSON.stringify(entry.translations), String(entry.reviewed)]);
  return '\uFEFF' + [csvFields, ...rows].map(row => row.map(csvEncode).join(',')).join('\r\n') + '\r\n';
}

function validateRow(raw: unknown): ExchangeRow {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('导入条目不是有效对象。', 'An imported entry is not a valid object.');
  const row = raw as Record<string, unknown>;
  if (typeof row.context !== 'string' || typeof row.source !== 'string' || (row.pluralSource != null && typeof row.pluralSource !== 'string')
      || !Array.isArray(row.translations) || !row.translations.length || row.translations.some(value => typeof value !== 'string')
      || (row.reviewed !== undefined && typeof row.reviewed !== 'boolean')) fail('导入条目的文本、复数或复核字段无效。', 'An imported entry has invalid text, plural or review fields.');
  return { context: row.context, source: row.source, pluralSource: row.pluralSource as string | undefined ?? undefined,
    translations: row.translations as string[], reviewed: row.reviewed as boolean | undefined };
}
export function importCatalog(document: PoDocument, text: string, format: 'po' | 'csv' | 'json', culture: string): CatalogImport {
  checkCulture(culture);
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) fail('导入文件无效或超过 64 MiB。', 'The import file is invalid or exceeds 64 MiB.');
  const current = parsePo(document.text), warnings: string[] = [];
  let rows: ExchangeRow[];
  if (format === 'po') {
    const imported = parsePo(text);
    const header = imported.entries.find(entry => entry.header)?.translations[0] ?? '';
    const language = /^Language:[ \t]*([^\r\n]*)/mi.exec(header)?.[1]?.trim();
    if (language) assertCulture(language, culture);
    else warnings.push(tr('导入 PO 没有 Language 头，按所选语言处理。', 'The imported PO has no Language header; the selected culture is used.'));
    rows = exchangeRows(imported);
  } else if (format === 'json') {
    let data: unknown;
    try { data = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { fail('导入 JSON 格式无效。', 'Invalid import JSON.'); }
    const root = data as Record<string, unknown>;
    if (!root || root.format !== 'ixena-localization' || root.version !== 1 || !Array.isArray(root.entries)) fail('请导入 iXena 导出的本地化 JSON（版本 1）。', 'Import localization JSON exported by iXena (version 1).');
    assertCulture(root.culture, culture);
    rows = root.entries.map(validateRow);
  } else if (format === 'csv') {
    const csv = readCsv(text);
    if (!csv.length || JSON.stringify(csv[0]) !== JSON.stringify(csvFields)) fail('CSV 列与 iXena 导出格式不一致，请保留表头和复数数组。', 'CSV columns do not match the iXena export format; keep the header and plural arrays.');
    rows = csv.slice(1).map((columns, index) => {
      if (columns.length !== csvFields.length) fail('CSV 第 {0} 行的列数不正确。', 'CSV row {0} has an incorrect column count.', index + 2);
      const cells = columns.map(csvDecode);
      if (cells[0] !== 'ixena-po-csv-v1') fail('CSV 格式标记无效。', 'Invalid CSV format marker.');
      assertCulture(cells[1], culture);
      let pluralSource: unknown, translations: unknown;
      try { pluralSource = JSON.parse(cells[4]); translations = JSON.parse(cells[5]); } catch { fail('CSV 第 {0} 行的复数或翻译数组不是有效 JSON。', 'CSV row {0} has invalid JSON for plural source or translations.', index + 2); }
      if (!['true', 'false'].includes(cells[6])) fail('CSV reviewed 列必须为 true 或 false。', 'The CSV reviewed column must be true or false.');
      return validateRow({ context: cells[2], source: cells[3], pluralSource, translations, reviewed: cells[6] === 'true' });
    });
  } else fail('不支持此导入格式。', 'Unsupported import format.');
  const lookup = new Map(current.entries.filter(entry => !entry.header && !entry.obsolete).map(entry => [entry.id, entry]));
  const seen = new Set<string>(), changes: PoChange[] = [];
  let matched = 0, skipped = 0;
  for (const row of rows) {
    const id = identity(row.context, row.source, row.pluralSource);
    if (seen.has(id)) fail('导入文件存在重复文本身份，已取消导入：{0}', 'Duplicate identity in the import; import was cancelled: {0}', row.context || row.source);
    seen.add(id);
    const entry = lookup.get(id);
    if (!entry) { skipped++; continue; }
    if (row.translations.length !== entry.translations.length) fail('条目 {0} 的复数数量不一致，已取消导入。', 'Plural-form count differs for {0}; import was cancelled.', row.context || row.source);
    matched++;
    const reviewChanged = row.reviewed !== undefined && row.reviewed === entry.flags.includes('fuzzy');
    if (JSON.stringify(row.translations) !== JSON.stringify(entry.translations) || reviewChanged) {
      changes.push({ id, translations: row.translations, reviewed: row.reviewed });
      if (warnings.length < 100) {
        const updated = { ...entry, translations: row.translations, flags: row.reviewed === true ? entry.flags.filter(flag => flag !== 'fuzzy')
          : row.reviewed === false ? [...new Set([...entry.flags, 'fuzzy'])] : entry.flags };
        warnings.push(...getEntryIssues(updated).map(issue => `${row.context || row.source}: ${issue}`).slice(0, 100 - warnings.length));
      }
    }
  }
  if (skipped) warnings.push(tr('跳过 {0} 条身份或原文不匹配的记录，未覆盖当前翻译。', 'Skipped {0} entries with mismatching identity or source; current translations were preserved.', skipped));
  return { changes, matched, skipped, warnings };
}
