import { t } from './i18n';
import './webviewI18n';
import { applyEdits, getNodeValue, modify, Node, ParseError, parseTree, printParseErrorCode, Edit } from 'jsonc-parser';

/** 仅修改用户选择的 JSON 路径；未展示的字段、旧版本字段和原始格式均留在原文中。 */
export type DescriptorKind = 'uproject' | 'uplugin';
export type DescriptorPath = Array<string | number>;
export type FieldType = 'string' | 'text' | 'integer' | 'boolean' | 'list' | 'choice';
export interface DescriptorField {
  key: string; label: string; type: FieldType; help?: string; required?: boolean;
  choices?: readonly string[]; min?: number; legacy?: boolean;
}
export interface DescriptorAnalysis {
  valid: boolean; data: Record<string, unknown>; errors: string[]; warnings: string[];
  rootFields: readonly DescriptorField[]; moduleFields: readonly DescriptorField[]; pluginFields: readonly DescriptorField[];
}
export type DescriptorOperation =
  | { type: 'set'; path: DescriptorPath; value: unknown }
  | { type: 'delete'; path: DescriptorPath }
  | { type: 'add'; collection: 'Modules' | 'Plugins'; value: Record<string, unknown> }
  | { type: 'remove'; collection: 'Modules' | 'Plugins'; index: number };

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const own = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const baseFields: readonly DescriptorField[] = [
  { key: 'FileVersion', label: '描述文件格式版本', type: 'integer', min: 1, required: true, help: '通常为 3；这是描述文件格式版本，不是 UE 版本。' },
  { key: 'Category', label: '分类', type: 'string' },
  { key: 'Description', label: '说明', type: 'text' }
];
export const projectFields: readonly DescriptorField[] = [
  baseFields[0],
  { key: 'EngineAssociation', label: '关联引擎', type: 'string', help: '保留版本号或源码引擎 GUID。修改关联不会自动切换工具栏的构建引擎。' },
  ...baseFields.slice(1),
  { key: 'DisableEnginePluginsByDefault', label: '默认禁用引擎插件', type: 'boolean', help: '启用后，需要在 Plugins 或 Target 规则中明确启用所需插件。' },
  { key: 'Enterprise', label: '企业项目', type: 'boolean', help: '对应 Unreal 的 IsEnterpriseProject；描述文件使用 Enterprise 字段。' },
  { key: 'TargetPlatforms', label: '目标平台', type: 'list', help: '逗号或换行分隔，例如 Win64, Linux。未设置与空数组分别保留。' },
  { key: 'AdditionalPluginDirectories', label: '额外插件目录', type: 'list', help: '仅编辑目录列表，不扫描或执行这些目录中的代码。' }
];
export const pluginFields: readonly DescriptorField[] = [
  baseFields[0],
  { key: 'FriendlyName', label: '显示名称', type: 'string' },
  { key: 'Version', label: '版本序号', type: 'integer', min: 0 },
  { key: 'VersionName', label: '版本名称', type: 'string', help: '例如 1.0.0。' },
  ...baseFields.slice(1),
  { key: 'CreatedBy', label: '作者', type: 'string' },
  { key: 'CreatedByURL', label: '作者主页', type: 'string' },
  { key: 'DocsURL', label: '文档链接', type: 'string' },
  { key: 'MarketplaceURL', label: '市场链接', type: 'string' },
  { key: 'SupportURL', label: '支持链接', type: 'string' },
  { key: 'EngineVersion', label: '引擎版本声明', type: 'string', help: '兼容声明通常使用完整版本号，如 5.3.0；本工具不会据此判断二进制兼容性。' },
  { key: 'EnabledByDefault', label: '默认启用', type: 'boolean' },
  { key: 'CanContainContent', label: '可以包含内容资源', type: 'boolean' },
  { key: 'IsBetaVersion', label: 'Beta 版本', type: 'boolean' },
  { key: 'IsExperimentalVersion', label: '实验性版本', type: 'boolean' },
  { key: 'Installed', label: '已安装插件', type: 'boolean' },
  { key: 'ExplicitlyLoaded', label: '显式加载', type: 'boolean', help: '启用后不会按常规流程自动加载模块和挂载内容。' },
  { key: 'SupportedTargetPlatforms', label: '支持的目标平台', type: 'list', help: '逗号或换行分隔。保留未设置、空数组之间的区别。' },
  { key: 'HasExplicitPlatforms', label: '使用显式平台扩展', type: 'boolean', help: '为 true 时，空平台列表可能表示不支持任何平台。请结合引擎版本和平台扩展使用。' }
];
export const moduleTypes = ['Runtime', 'RuntimeNoCommandlet', 'RuntimeAndProgram', 'CookedOnly', 'UncookedOnly',
  'Developer', 'DeveloperTool', 'Editor', 'EditorNoCommandlet', 'EditorAndProgram', 'Program', 'ServerOnly',
  'ClientOnly', 'ClientOnlyNoCommandlet'] as const;
export const loadingPhases = ['EarliestPossible', 'PostConfigInit', 'PostSplashScreen', 'PreEarlyLoadingScreen',
  'PreLoadingScreen', 'PreDefault', 'Default', 'PostDefault', 'PostEngineInit', 'None'] as const;
const platformFields: readonly DescriptorField[] = [
  { key: 'PlatformAllowList', label: '允许平台', type: 'list' },
  { key: 'PlatformDenyList', label: '排除平台', type: 'list' },
  { key: 'WhitelistPlatforms', label: '允许平台（旧字段）', type: 'list', legacy: true },
  { key: 'BlacklistPlatforms', label: '排除平台（旧字段）', type: 'list', legacy: true }
];
export const moduleFields: readonly DescriptorField[] = [
  { key: 'Name', label: '模块名称', type: 'string', required: true, help: '必须与 Source 中模块及 Build.cs 的名称一致；本操作不重命名源码。' },
  { key: 'Type', label: '模块类型', type: 'choice', choices: moduleTypes, required: true },
  { key: 'LoadingPhase', label: '加载时机', type: 'choice', choices: loadingPhases },
  ...platformFields,
  { key: 'AdditionalDependencies', label: '额外依赖声明', type: 'list', help: '保留旧项目声明。C++ 模块依赖仍应在 Build.cs 中维护。' },
  { key: 'HasExplicitPlatforms', label: '使用显式平台扩展', type: 'boolean' }
];
export const pluginReferenceFields: readonly DescriptorField[] = [
  { key: 'Name', label: '插件名称', type: 'string', required: true },
  { key: 'Enabled', label: '启用', type: 'boolean', required: true },
  { key: 'Optional', label: '允许缺失', type: 'boolean', help: '启用时，缺少此插件可被忽略；不会安装插件。' },
  ...platformFields,
  { key: 'SupportedTargetPlatforms', label: '插件支持平台', type: 'list' },
  { key: 'HasExplicitPlatforms', label: '使用显式平台扩展', type: 'boolean' },
  { key: 'Description', label: '引用说明', type: 'text' },
  { key: 'MarketplaceURL', label: '获取插件链接', type: 'string' }
];

function localizeFields(fields: readonly DescriptorField[]): DescriptorField[] {
  return fields.map(field => ({ ...field, label: t(field.label), help: field.help ? t(field.help) : undefined }));
}

export function descriptorKind(filename: string): DescriptorKind | undefined {
  if (/\.uproject$/i.test(filename)) { return 'uproject'; }
  if (/\.uplugin$/i.test(filename)) { return 'uplugin'; }
  return undefined;
}

function inspectTree(node: Node, location: string, errors: string[]): void {
  if (node.type === 'object') {
    const keys = new Set<string>();
    for (const property of node.children ?? []) {
      const [key, value] = property.children ?? [];
      if (!key || !value) { continue; }
      const name = String(key.value);
      if (keys.has(name)) { errors.push(t("{0} 存在重复字段 {1}，请先在源码中消除歧义。", location, name)); }
      keys.add(name);
      inspectTree(value, `${location}.${name}`, errors);
    }
  } else if (node.type === 'array') {
    (node.children ?? []).forEach((child, index) => inspectTree(child, `${location}[${index}]`, errors));
  }
}

export function analyzeDescriptor(source: string, kind: DescriptorKind): DescriptorAnalysis {
  const errors: string[] = [], warnings: string[] = [];
  const result: DescriptorAnalysis = { valid: false, data: {}, errors, warnings,
    rootFields: localizeFields(kind === 'uproject' ? projectFields : pluginFields), moduleFields: localizeFields(moduleFields), pluginFields: localizeFields(pluginReferenceFields) };
  if (source.length > 4 * 1024 * 1024) { errors.push(t("描述文件超过 4 MiB，请使用 JSON 源码编辑器。")); return result; }
  const parseErrors: ParseError[] = [];
  // BOM 用等长空格代替，只用于分析，保证 jsonc-parser 的 UTF-16 偏移仍对应原文。
  const parseSource = source.charCodeAt(0) === 0xFEFF ? ' ' + source.slice(1) : source;
  const tree = parseTree(parseSource, parseErrors, { allowTrailingComma: false, disallowComments: true });
  for (const error of parseErrors.slice(0, 8)) {
    const line = parseSource.slice(0, error.offset).split('\n').length;
    errors.push(t("第 {0} 行：{1}。描述文件必须是有效 JSON（不能有注释或尾随逗号）。", line, printParseErrorCode(error.error)));
  }
  if (!tree || tree.type !== 'object') { errors.push(t("描述文件的最外层必须是 JSON 对象。")); return result; }
  inspectTree(tree, '$', errors);
  if (errors.length) { return result; }
  result.data = getNodeValue(tree) as Record<string, unknown>;
  for (const field of result.rootFields) {
    if (!own(result.data, field.key)) { continue; }
    try { validateValue(field, result.data[field.key]); }
    catch (error) { warnings.push(error instanceof Error ? error.message : String(error)); }
  }
  if (result.data.HasExplicitPlatforms === true) { warnings.push(t("插件启用了 HasExplicitPlatforms；空 SupportedTargetPlatforms 不一定表示支持所有平台。")); }
  for (const collection of ['Modules', 'Plugins']) {
    const value = result.data[collection];
    if (value !== undefined && !Array.isArray(value)) { errors.push(t("{0} 必须是数组；请先在源码中修复。", collection)); continue; }
    const names = new Set<string>();
    for (const [index, row] of (Array.isArray(value) ? value : []).entries()) {
      if (!isObject(row)) { errors.push(t("{0}[{1}] 必须是对象；请先在源码中修复。", collection, index)); continue; }
      const fields = collection === 'Modules' ? moduleFields : pluginReferenceFields;
      for (const field of fields.filter(item => item.key !== 'Name')) {
        if (!own(row, field.key)) {
          if (field.required) { warnings.push(t("{0}[{1}] 缺少必需字段 {2}。", collection, index, field.key)); }
          continue;
        }
        try { validateValue(field, row[field.key]); }
        catch (error) { warnings.push(`${collection}[${index}]：${error instanceof Error ? error.message : String(error)}`); }
      }
      if (typeof row.Name !== 'string' || !identifier.test(row.Name)) { warnings.push(t("{0}[{1}] 的 Name 不是有效模块或插件名称，可在表单中修正。", collection, index)); }
      else if (names.has(row.Name.toLowerCase())) { warnings.push(t("{0} 存在重复名称 {1}。", collection, row.Name)); }
      else { names.add(row.Name.toLowerCase()); }
      if ((own(row, 'PlatformAllowList') && own(row, 'WhitelistPlatforms')) || (own(row, 'PlatformDenyList') && own(row, 'BlacklistPlatforms'))) {
        warnings.push(t("{0}[{1}] 同时含新旧平台字段；两套字段分别保留，请依据使用的 UE 版本检查。", collection, index));
      }
      if (row.HasExplicitPlatforms === true) { warnings.push(t("{0}[{1}] 启用了 HasExplicitPlatforms，空平台列表不一定表示所有平台。", collection, index)); }
    }
  }
  if (!own(result.data, 'FileVersion')) { warnings.push(t("未声明 FileVersion；请按使用的 UE 版本填写描述格式版本。")); }
  result.valid = errors.length === 0;
  return result;
}

function fieldForPath(analysis: DescriptorAnalysis, path: DescriptorPath): DescriptorField {
  if (!Array.isArray(path) || path.some(part => typeof part === 'string' && ['__proto__', 'prototype', 'constructor'].includes(part))) {
    throw new Error(t("无效的字段路径。"));
  }
  if (path.length === 1 && typeof path[0] === 'string') {
    const field = analysis.rootFields.find(item => item.key === path[0]);
    if (field) { return field; }
  }
  if (path.length === 3 && ['Modules', 'Plugins'].includes(String(path[0])) && Number.isInteger(path[1]) && typeof path[2] === 'string') {
    const rows = analysis.data[String(path[0])];
    const index = path[1] as number;
    if (!Array.isArray(rows) || index < 0 || index >= rows.length || !isObject(rows[index])) { throw new Error(t("所选行已不存在，请重新读取文件。")); }
    const field = (path[0] === 'Modules' ? analysis.moduleFields : analysis.pluginFields).find(item => item.key === path[2]);
    if (field) { return field; }
  }
  throw new Error(t("此字段没有可视化编辑入口，请在 JSON 源码中编辑。"));
}

function validateValue(field: DescriptorField, value: unknown): void {
  if (field.type === 'boolean') {
    if (typeof value !== 'boolean') { throw new Error(t("{0} 必须是布尔值。", field.key)); }
  } else if (field.type === 'integer') {
    if (!Number.isSafeInteger(value) || (value as number) < (field.min ?? 0)) { throw new Error(t("{0} 必须是大于或等于 {1} 的安全整数。", field.key, field.min ?? 0)); }
  } else if (field.type === 'list') {
    if (!Array.isArray(value) || value.length > 1024 || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 2048)) {
      throw new Error(t("{0} 必须是字符串数组，单项不能为空。", field.key));
    }
    if (new Set(value.map(item => (item as string).toLowerCase())).size !== value.length) { throw new Error(t("{0} 含有重复项。", field.key)); }
  } else {
    if (typeof value !== 'string' || value.length > 65536) { throw new Error(t("{0} 必须是字符串。", field.key)); }
    if (field.required && !value.trim()) { throw new Error(t("{0} 不能为空。", field.key)); }
    if (field.key === 'Name' && !identifier.test(value)) { throw new Error(t("Name 只能包含英文字母、数字和下划线，且不能以数字开头。")); }
    if (field.type === 'choice' && !value.trim()) { throw new Error(t("{0} 不能为空；可使用“移除此字段”恢复缺省。", field.key)); }
  }
}

function currentValue(data: Record<string, unknown>, path: DescriptorPath): unknown {
  let value: unknown = data;
  for (const part of path) {
    if (value === null || typeof value !== 'object') { return undefined; }
    value = (value as Record<string | number, unknown>)[part];
  }
  return value;
}

function ensureUniqueName(data: Record<string, unknown>, collection: string, value: unknown, except = -1): void {
  const rows = data[collection];
  if (!Array.isArray(rows) || typeof value !== 'string') { return; }
  if (rows.some((row, index) => index !== except && isObject(row) && typeof row.Name === 'string' && row.Name.toLowerCase() === value.toLowerCase())) {
    throw new Error(t("{0} 已包含名称 {1}。", collection, value));
  }
}

export function assertDescriptorVersion(actual: number, expected: unknown): void {
  if (!Number.isInteger(expected) || actual !== expected) { throw new Error(t("文件已在其他位置修改。表单输入已保留，请先重新读取，避免覆盖其他修改。")); }
}

export function planDescriptorEdit(source: string, kind: DescriptorKind, rawOperation: unknown): { edits: Edit[]; source: string } {
  const analysis = analyzeDescriptor(source, kind);
  if (!analysis.valid) { throw new Error(analysis.errors[0] ?? t("描述文件无效。")); }
  if (!isObject(rawOperation)) { throw new Error(t("无效的编辑请求。")); }
  let path: DescriptorPath, value: unknown;
  if (rawOperation.type === 'set' || rawOperation.type === 'delete') {
    path = rawOperation.path as DescriptorPath;
    const field = fieldForPath(analysis, path);
    if (rawOperation.type === 'delete') {
      if (field.required) { throw new Error(t("{0} 是必需字段，不能移除。", field.key)); }
      value = undefined;
    } else {
      value = rawOperation.value;
      validateValue(field, value);
      if (path.length === 3 && path[2] === 'Name') { ensureUniqueName(analysis.data, String(path[0]), value, path[1] as number); }
    }
    if (JSON.stringify(currentValue(analysis.data, path)) === JSON.stringify(value)) { return { edits: [], source }; }
  } else if (rawOperation.type === 'add' || rawOperation.type === 'remove') {
    const collection = rawOperation.collection;
    if (collection !== 'Modules' && collection !== 'Plugins') { throw new Error(t("只允许添加或移除 Modules / Plugins 项。")); }
    const rows = analysis.data[collection] as Record<string, unknown>[] | undefined;
    if (rawOperation.type === 'remove') {
      const index = rawOperation.index;
      if (!Number.isInteger(index) || !rows || (index as number) < 0 || (index as number) >= rows.length) { throw new Error(t("所选行已不存在。")); }
      path = [collection, index as number]; value = undefined;
    } else {
      if (!isObject(rawOperation.value)) { throw new Error(t("新条目必须是对象。")); }
      const fields = collection === 'Modules' ? moduleFields : pluginReferenceFields;
      for (const [key, entryValue] of Object.entries(rawOperation.value)) {
        const field = fields.find(item => item.key === key);
        if (!field) { throw new Error(t("不允许添加字段 {0}。", key)); }
        validateValue(field, entryValue);
      }
      for (const field of fields.filter(item => item.required)) {
        if (!own(rawOperation.value, field.key)) { throw new Error(t("新条目缺少 {0}。", field.key)); }
      }
      ensureUniqueName(analysis.data, collection, rawOperation.value.Name);
      if ((rows?.length ?? 0) >= 4096) { throw new Error(t("条目过多，请使用 JSON 源码编辑器。")); }
      path = rows ? [collection, rows.length] : [collection];
      value = rows ? rawOperation.value : [rawOperation.value];
    }
  } else { throw new Error(t("未知的描述文件编辑操作。")); }
  const indentation = /\r?\n([\t ]+)"/.exec(source)?.[1] ?? '  ';
  const parseSource = source.charCodeAt(0) === 0xFEFF ? ' ' + source.slice(1) : source;
  const edits = modify(parseSource, path, value, { formattingOptions: {
    insertSpaces: !indentation.includes('\t'), tabSize: indentation.includes('\t') ? 4 : Math.max(1, indentation.length),
    eol: source.includes('\r\n') ? '\r\n' : '\n', keepLines: true
  }, isArrayInsertion: rawOperation.type === 'add' && path.length === 2 });
  const rewritten = applyEdits(source, edits);
  const next = analyzeDescriptor(rewritten, kind);
  if (!next.valid) { throw new Error(t("此次修改会产生无效 JSON，已取消写入。")); }
  return { edits, source: rewritten };
}

export function rewriteDescriptor(source: string, kind: DescriptorKind, operation: unknown): string {
  return planDescriptorEdit(source, kind, operation).source;
}
