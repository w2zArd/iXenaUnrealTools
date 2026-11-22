import { t } from './i18n';
import './webviewI18n';
/**
 * 保守的 UE ModuleRules 依赖分析/局部编辑器。
 * 不是 C# 解释器：仅可写入构造函数顶层的单一字面量 AddRange。
 * 包含条件、变量、多个调用等复杂规则时拒绝修改，以免改变构建语义。
 */
export type DependencyKind = 'Public' | 'Private';

export interface DependencyGroup {
  kind: DependencyKind;
  values: string[];
  editable: boolean;
  reason?: string;
  /** 数组字面量 { 与 } 之间的绝对字符范围。 */
  span?: { start: number; end: number };
  /** 保存当前数组的大括号，用于确定缩进。 */
  openBrace?: number;
  closeBrace?: number;
  missing: boolean;
}

export interface DependencyAnalysis {
  groups: Record<DependencyKind, DependencyGroup>;
  constructorBrace?: number;
  constructorIndent?: string;
}

/** 注释与字符串替换为空格，同时保持所有原始偏移和换行位置。 */
export function maskCSharp(text: string): string {
  const chars = text.split('');
  const blank = (i: number) => { if (chars[i] !== '\n' && chars[i] !== '\r') { chars[i] = ' '; } };
  let i = 0;
  while (i < text.length) {
    const ch = text[i], next = text[i + 1];
    if (ch === '/' && next === '/') {
      blank(i++); blank(i++);
      while (i < text.length && text[i] !== '\n') { blank(i++); }
      continue;
    }
    if (ch === '/' && next === '*') {
      blank(i++); blank(i++);
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { blank(i++); }
      if (i < text.length) { blank(i++); blank(i++); }
      continue;
    }
    const verbatim = ch === '@' && next === '"';
    if (verbatim || ch === '"' || ch === '\'') {
      const delimiter = verbatim ? '"' : ch;
      if (verbatim) { blank(i++); }
      blank(i++);
      while (i < text.length) {
        if (!verbatim && text[i] === '\\' && i + 1 < text.length) { blank(i++); blank(i++); continue; }
        if (verbatim && text[i] === '"' && text[i + 1] === '"') { blank(i++); blank(i++); continue; }
        const close = text[i] === delimiter;
        blank(i++);
        if (close) { break; }
      }
      continue;
    }
    i++;
  }
  return chars.join('');
}

function matching(masked: string, at: number, open: string, close: string): number {
  if (masked[at] !== open) { return -1; }
  let depth = 0;
  for (let index = at; index < masked.length; index++) {
    if (masked[index] === open) { depth++; }
    else if (masked[index] === close && --depth === 0) { return index; }
  }
  return -1;
}

/** 只接受注释、逗号和简单的模块名字符串，不对表达式求值。 */
function readLiteralNames(body: string): string[] | undefined {
  const list: string[] = [];
  let i = 0;
  let needSeparator = false;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) { i++; }
    if (body.slice(i, i + 2) === '//') {
      i += 2; while (i < body.length && body[i] !== '\n') { i++; } continue;
    }
    if (body.slice(i, i + 2) === '/*') {
      const end = body.indexOf('*/', i + 2);
      if (end < 0) { return undefined; }
      i = end + 2; continue;
    }
    if (i >= body.length) { break; }
    if (body[i] === ',') {
      if (!needSeparator) { return undefined; }
      needSeparator = false; i++; continue;
    }
    if (needSeparator || body[i] !== '"') { return undefined; }
    const start = ++i;
    while (i < body.length && body[i] !== '"') {
      if (body[i] === '\\' || body[i] === '\n' || body[i] === '\r') { return undefined; }
      i++;
    }
    if (i >= body.length) { return undefined; }
    const name = body.slice(start, i++);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) { return undefined; }
    list.push(name);
    needSeparator = true;
  }
  const names = new Set(list.map(value => value.toLowerCase()));
  return names.size === list.length ? list : undefined;
}

function topLevel(masked: string, constructorBrace: number, index: number): boolean {
  if (index <= constructorBrace) { return false; }
  let depth = 1;
  for (let i = constructorBrace + 1; i < index; i++) {
    if (masked[i] === '{') { depth++; }
    else if (masked[i] === '}') { depth--; if (depth < 1) { return false; } }
  }
  return depth === 1;
}

export function analyzeBuildCs(source: string): DependencyAnalysis {
  const masked = maskCSharp(source);
  const constructorMatches = [...masked.matchAll(/\bpublic\s+([A-Za-z_]\w*)\s*\(\s*ReadOnlyTargetRules\s+[A-Za-z_]\w*\s*\)\s*:\s*base\s*\([^)]*\)\s*\{/g)];
  const constructorBrace = constructorMatches.length === 1
    ? constructorMatches[0].index! + constructorMatches[0][0].length - 1 : undefined;
  const constructorEnd = constructorBrace === undefined ? -1 : matching(masked, constructorBrace, '{', '}');
  const constructorIndent = constructorBrace === undefined ? undefined
    : (source.slice(source.lastIndexOf('\n', constructorBrace) + 1, constructorBrace).match(/^\s*/)?.[0] ?? '') + '    ';
  const groups = {} as Record<DependencyKind, DependencyGroup>;
  for (const kind of ['Public', 'Private'] as const) {
    const name = `${kind}DependencyModuleNames`;
    const references = [...masked.matchAll(new RegExp(`\\b${name}\\b`, 'g'))];
    const group: DependencyGroup = { kind, values: [], editable: false, missing: references.length === 0 };
    groups[kind] = group;
    if (constructorBrace === undefined || constructorEnd < 0) {
      group.reason = t("无法唯一确定 ModuleRules 构造函数（要求 public 模块名(ReadOnlyTargetRules Target) : base(Target)）。");
      continue;
    }
    if (references.length === 0) { group.editable = true; continue; }
    if (references.length !== 1) {
      group.reason = t("依赖列表被多处引用，可能包含条件构建或追加调用。");
      continue;
    }
    const reference = references[0];
    const index = reference.index!;
    const suffix = masked.slice(index + name.length);
    const signature = /^\s*\.\s*AddRange\s*\(/.exec(suffix);
    if (!signature) { group.reason = t("依赖不是单一 AddRange(new string[] { ... }) 格式。"); continue; }
    const parenOpen = index + name.length + signature[0].length - 1;
    const parenClose = matching(masked, parenOpen, '(', ')');
    if (parenClose < 0 || masked.slice(parenClose + 1).match(/^\s*;/)?.index !== 0) {
      group.reason = t("依赖调用缺少可识别的结束位置。"); continue;
    }
    const before = masked.slice(parenOpen + 1, parenClose);
    const initializer = /^\s*new\s+(?:string\s*\[\s*\]|\[\s*\])\s*\{/i.exec(before);
    if (!initializer) { group.reason = t("依赖数组包含动态表达式或不支持的初始化形式。"); continue; }
    const openBrace = parenOpen + 1 + initializer[0].length - 1;
    const closeBrace = matching(masked, openBrace, '{', '}');
    if (closeBrace < 0 || masked.slice(closeBrace + 1, parenClose).trim()) {
      group.reason = t("AddRange 数组后存在其他表达式。"); continue;
    }
    const body = source.slice(openBrace + 1, closeBrace);
    const values = readLiteralNames(body);
    if (!values) { group.reason = t("依赖数组包含非纯字符串、重复项或不安全内容。"); continue; }
    group.values = values;
    if (/\/\/|\/\*/.test(body)) { group.reason = t("数组字面量包含注释；为避免丢失注释，请直接编辑 Build.cs。"); continue; }
    const statementBoundary = Math.max(masked.lastIndexOf(';', index), masked.lastIndexOf('{', index), masked.lastIndexOf('}', index));
    if (masked.slice(statementBoundary + 1, index).trim()) {
      group.reason = t("依赖调用不是独立语句，可能在无花括号的 if 或其他条件表达式中。"); continue;
    }
    // C# 预处理器 #if / #else 不增加花括号嵌套，同样必须拒绝改写。
    const preprocessorLines = source.slice(constructorBrace + 1, index).match(/^\s*#(if|elif|else|endif)\b[^\r\n]*/gm) ?? [];
    let conditionalDepth = 0;
    for (const line of preprocessorLines) {
      if (/^\s*#if\b/.test(line)) { conditionalDepth++; }
      if (/^\s*#endif\b/.test(line)) { conditionalDepth--; }
    }
    if (conditionalDepth !== 0) {
      group.reason = t("依赖位于 C# 预处理条件内，不能进行统一静态修改。"); continue;
    }
    if (!topLevel(masked, constructorBrace, index) || parenClose > constructorEnd) {
      group.reason = t("依赖 AddRange 位于 if/循环/其他作用域中，可能按平台或配置变化。"); continue;
    }
    group.editable = true;
    group.missing = false;
    group.span = { start: openBrace + 1, end: closeBrace };
    group.openBrace = openBrace;
    group.closeBrace = closeBrace;
  }
  return { groups, constructorBrace, constructorIndent };
}

function equivalent(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function formatBody(source: string, group: DependencyGroup, values: readonly string[], lineEnd: string): string {
  const original = source.slice(group.span!.start, group.span!.end);
  if (!original.includes('\n')) { return values.length ? ` ${values.map(value => `"${value}"`).join(', ')} ` : ' '; }
  const closingIndent = source.slice(source.lastIndexOf('\n', group.closeBrace!) + 1, group.closeBrace!).match(/^\s*/)?.[0] ?? '';
  const match = original.match(/\r?\n([ \t]*)"/);
  const valueIndent = match?.[1] ?? `${closingIndent}    `;
  return values.length ? `${lineEnd}${values.map(value => `${valueIndent}"${value}"`).join(`,${lineEnd}`)}${lineEnd}${closingIndent}`
    : `${lineEnd}${closingIndent}`;
}

export function validateNames(names: unknown, currentModule?: string): string[] {
  if (!Array.isArray(names) || names.length > 250 || names.some(value => typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))) {
    throw new Error(t("模块依赖名称只能包含字母、数字、下划线，且最多 250 项。"));
  }
  const unique = new Set((names as string[]).map(name => name.toLowerCase()));
  if (unique.size !== names.length) { throw new Error(t("依赖名称不允许重复（忽略大小写）。")); }
  if (currentModule && unique.has(currentModule.toLowerCase())) { throw new Error(t("模块不能依赖自身。")); }
  return [...names] as string[];
}

/** 仅替换已识别数组的内部文本，缺失时在构造函数第一行插入独立的 AddRange。 */
export function rewriteBuildCs(source: string, pub: unknown, priv: unknown, currentModule?: string): string {
  const names = {
    Public: validateNames(pub, currentModule),
    Private: validateNames(priv, currentModule)
  };
  const analysis = analyzeBuildCs(source);
  const newLine = source.includes('\r\n') ? '\r\n' : '\n';
  const edits: Array<{ start: number; end: number; value: string }> = [];
  const additions: string[] = [];
  for (const kind of ['Public', 'Private'] as const) {
    const group = analysis.groups[kind];
    if (equivalent(group.values, names[kind])) { continue; }
    if (!group.editable) { throw new Error(t("{0} 依赖无法安全编辑：{1}", kind, group.reason ?? t("规则复杂"))); }
    if (group.missing) {
      if (names[kind].length) {
        additions.push(`${analysis.constructorIndent}${kind}DependencyModuleNames.AddRange(new string[] { ${names[kind].map(v => `"${v}"`).join(', ')} });`);
      }
    } else {
      edits.push({ start: group.span!.start, end: group.span!.end, value: formatBody(source, group, names[kind], newLine) });
    }
  }
  if (additions.length) {
    if (analysis.constructorBrace === undefined) { throw new Error(t("无法找到构造函数插入位置。")); }
    edits.push({ start: analysis.constructorBrace + 1, end: analysis.constructorBrace + 1,
      value: `${newLine}${additions.join(newLine)}` });
  }
  return edits.sort((a, b) => b.start - a.start).reduce((value, edit) =>
    value.slice(0, edit.start) + edit.value + value.slice(edit.end), source);
}
