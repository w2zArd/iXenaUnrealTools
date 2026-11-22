import * as fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { tr } from './i18n';

/** 本地化配置只负责发现与生成计划；写盘、冲突检查、UE 进程均由宿主管理。 */
export type LocalizationOperation = 'gather' | 'export' | 'import' | 'compile';
export interface LocalizationTarget {
  id: string;
  name: string;
  scopeName: string;
  scopeRoot: string;
  projectPath: string;
  dataDirectory: string;
  nativeCulture?: string;
  cultures: string[];
  poFiles: Array<{ culture: string; path: string }>;
  configs: Partial<Record<LocalizationOperation, string>>;
  managed: boolean;
  warnings: string[];
  metadataPath?: string;
}
export interface LocalizationTargetPlan {
  files: Array<{ path: string; content: string; expectedText?: string }>;
  target: LocalizationTarget;
}

interface ManagedMetadata {
  schemaVersion: 1;
  managedBy: 'iXenaUnrealTools';
  targetName: string;
  nativeCulture: string;
  cultures: string[];
  dataDirectory: string;
  configs: Record<LocalizationOperation, string>;
}
interface Scope { projectPath: string; root: string; name: string; }
interface TargetState {
  target: LocalizationTarget;
  poRoots: Set<string>;
  poNames: Set<string>;
  explicitPoNames: boolean;
  configuredCultures: Partial<Record<LocalizationOperation, Set<string>>>;
}
interface ScanBudget { directories: number; warnings: Set<string>; }
type Ini = Map<string, Map<string, string[]>>;

const operations: LocalizationOperation[] = ['gather', 'export', 'import', 'compile'];
const maxConfigBytes = 1024 * 1024;
const maxChildren = 2000;
const ignored = new Set(['.git', '.vs', '.vscode', 'binaries', 'intermediate', 'saved', 'deriveddatacache', 'node_modules']);
function managedWarning(): string {
  return tr('此目标由 iXena 管理。其命令行 INI 与 UE 本地化面板的设置独立；运行时加载和打包仍需在 UE 中配置。',
    'This target is managed by iXena. Its commandlet INI files are separate from UE Localization Dashboard settings; runtime loading and packaging still need to be configured in UE.');
}

function localKey(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function safeString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\u0000\r\n]/.test(value);
}
function safeName(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(value);
}
function safeCulture(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value)
    && value.length <= 48 && !/^(?:con|prn|aux|nul)$/i.test(value);
}
function safeFilename(value: unknown): value is string {
  return safeString(value) && !/[\\/:]/.test(value) && value !== '.' && value !== '..' && value.length <= 180;
}
function culturesWithNative(nativeCulture: string, cultures: readonly string[]): string[] {
  if (!safeCulture(nativeCulture) || !Array.isArray(cultures) || cultures.length > 100 || !cultures.every(safeCulture)) {
    throw new Error(tr('请输入 en、zh-Hans、ja 或 pt-BR 等语言代码，不能使用路径或 INI 表达式。', 'Use culture codes such as en, zh-Hans, ja or pt-BR; paths and INI expressions are not culture codes.'));
  }
  const seen = new Set<string>();
  return [nativeCulture, ...cultures].filter(culture => {
    const key = culture.toLowerCase();
    if (seen.has(key)) { return false; }
    seen.add(key); return true;
  });
}
function addCulture(target: LocalizationTarget, culture: string): void {
  if (safeCulture(culture) && !target.cultures.some(value => value.toLowerCase() === culture.toLowerCase())) {
    target.cultures.push(culture);
  }
}

/** 明确项目根允许由用户选择；根内部不跟随符号链接/Windows junction。 */
async function safePath(root: string, candidate: string): Promise<boolean> {
  if (!within(root, candidate)) { return false; }
  const parts = path.relative(root, candidate).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const info = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') { return undefined; }
      throw error;
    });
    if (!info) { return true; }
    if (info.isSymbolicLink()) { return false; }
  }
  const realRoot = await fs.realpath(root).catch(() => undefined);
  const realCandidate = await fs.realpath(candidate).catch(() => undefined);
  return !realRoot || !realCandidate || within(realRoot, realCandidate);
}
async function children(root: string, directory: string, budget?: ScanBudget): Promise<syncFs.Dirent[]> {
  if (budget && budget.directories-- <= 0) {
    budget.warnings.add(tr('发现范围超过 10,000 个目录，扫描已截断；请缩小项目范围后重试。', 'Discovery exceeded 10,000 directories and was truncated; narrow the project scope and retry.'));
    return [];
  }
  if (!await safePath(root, directory)) { return []; }
  try {
    // opendir 不会先把意外的大目录全部装入内存。
    const result: syncFs.Dirent[] = [];
    const handle = await fs.opendir(directory);
    let inspected = 0;
    for await (const entry of handle) {
      if (inspected++ >= maxChildren) {
        budget?.warnings.add(tr('目录条目超过 {0} 个，扫描已截断：{1}', 'Directory entries exceeded {0}; discovery was truncated: {1}', maxChildren, directory));
        break;
      }
      if (!entry.isSymbolicLink()) { result.push(entry); }
    }
    return result.sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) { return []; }
    throw error;
  }
}
async function smallText(root: string, filename: string, limit = maxConfigBytes): Promise<string | undefined> {
  if (!await safePath(root, filename)) { return undefined; }
  const info = await fs.lstat(filename).catch(() => undefined);
  if (!info?.isFile() || info.size > limit) { return undefined; }
  return fs.readFile(filename, 'utf8').catch(() => undefined);
}

/** section/key 大小写无关；保留重复数组键，支持 UE 的 + / . / - / ! 前缀。 */
function parseIni(text: string): Ini {
  const document: Ini = new Map();
  let section: Map<string, string[]> | undefined;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^[;#]/.test(trimmed)) { continue; }
    const heading = /^\[([^\]]+)\]\s*(?:[;#].*)?$/.exec(trimmed);
    if (heading) {
      const key = heading[1].trim().toLowerCase();
      section = document.get(key) ?? new Map(); document.set(key, section); continue;
    }
    const match = /^([+.!-]?)([^=]+)=(.*)$/.exec(trimmed);
    if (!section || !match) { continue; }
    const key = match[2].trim().toLowerCase();
    let value = match[3].trim();
    if (value.startsWith('"') && value.endsWith('"')) { value = value.slice(1, -1); }
    const current = section.get(key) ?? [];
    if (match[1] === '!') { section.set(key, []); }
    else if (match[1] === '-') { section.set(key, current.filter(item => item !== value)); }
    else if (match[1] !== '+' || !current.includes(value)) { section.set(key, [...current, value]); }
  }
  return document;
}
function getValue(section: Map<string, string[]> | undefined, key: string): string | undefined {
  return section?.get(key.toLowerCase())?.at(-1);
}
function classifyConfig(document: Ini): LocalizationOperation[] {
  const found = new Set<LocalizationOperation>();
  for (const [name, section] of document) {
    if (!/^gathertextstep\d+$/.test(name)) { continue; }
    const commandlet = getValue(section, 'CommandletClass')?.replace(/Commandlet$/i, '').toLowerCase();
    if (['gathertextfromsource', 'gathertextfromassets', 'gathertextfrommetadata', 'generategathermanifest', 'generategatherarchive'].includes(commandlet ?? '')) { found.add('gather'); }
    else if (commandlet === 'generatetextlocalizationresource') { found.add('compile'); }
    else if (commandlet === 'internationalizationexport') {
      if (/^(true|1)$/i.test(getValue(section, 'bImportLoc') ?? '')) { found.add('import'); }
      if (/^(true|1)$/i.test(getValue(section, 'bExportLoc') ?? '')) { found.add('export'); }
    }
  }
  return [...found];
}
function declaredCultures(document: Ini): Set<string> {
  const result = new Set<string>();
  for (const section of document.values()) {
    for (const culture of section.get('culturestogenerate') ?? []) {
      if (safeCulture(culture)) { result.add(culture.toLowerCase()); }
    }
  }
  return result;
}
function resolveIniPath(value: string, projectRoot: string): string | undefined {
  if (!safeString(value)) { return undefined; }
  const expanded = value.replace(/%LOCPROJECTROOT%/gi, `${projectRoot}${path.sep}`);
  if (/%[A-Za-z_]+%|\$\{[^}]+\}/.test(expanded)) { return undefined; }
  // Windows 分隔符可出现在共享的 INI 中；绝对 Windows 路径不能在 Unix 上误当相对路径。
  if (process.platform !== 'win32' && /^(?:[A-Za-z]:[\\/]|\\\\)/.test(expanded)) { return undefined; }
  const normalized = expanded.replace(/[\\/]/g, path.sep);
  return path.resolve(projectRoot, normalized);
}
function makeTarget(scope: Scope, name: string, dataDirectory: string): LocalizationTarget {
  return {
    id: `loc:${createHash('sha256').update(`${localKey(scope.projectPath)}\0${localKey(scope.root)}\0${localKey(dataDirectory)}\0${name}`).digest('hex').slice(0, 24)}`,
    name, scopeName: scope.name, scopeRoot: scope.root, projectPath: scope.projectPath, dataDirectory,
    cultures: [], poFiles: [], configs: {}, managed: false, warnings: []
  };
}
function readMetadata(text: string): ManagedMetadata | undefined {
  try {
    const value = JSON.parse(text.replace(/^\uFEFF/, '')) as Partial<ManagedMetadata>;
    if (value.schemaVersion !== 1 || value.managedBy !== 'iXenaUnrealTools' || !safeName(value.targetName ?? '')
      || !safeCulture(value.nativeCulture) || !Array.isArray(value.cultures) || value.cultures.length > 100
      || !value.cultures.every(safeCulture) || !safeString(value.dataDirectory) || !value.configs
      || !operations.every(operation => safeFilename(value.configs?.[operation]) && /\.ini$/i.test(value.configs[operation]))) { return undefined; }
    if (value.dataDirectory !== `Content/Localization/${value.targetName}`) { return undefined; }
    return value as ManagedMetadata;
  } catch { return undefined; }
}

async function projectScopes(projectPaths: readonly string[], budget: ScanBudget): Promise<Scope[]> {
  const scopes: Scope[] = [];
  const seen = new Set<string>();
  if (projectPaths.length > 64) { budget.warnings.add(tr('项目数量超过 64 个，扫描已截断。', 'More than 64 projects were provided; discovery was truncated.')); }
  for (const input of projectPaths.slice(0, 64)) {
    if (!safeString(input) || !path.isAbsolute(input) || !/\.uproject$/i.test(input)) { continue; }
    const projectPath = path.resolve(input);
    const root = path.dirname(projectPath);
    if (seen.has(localKey(projectPath)) || !await safePath(root, projectPath)
      || !(await fs.lstat(projectPath).catch(() => undefined))?.isFile()) { continue; }
    seen.add(localKey(projectPath));
    scopes.push({ projectPath, root, name: path.basename(projectPath, path.extname(projectPath)) });
    const queue = [{ folder: path.join(root, 'Plugins'), depth: 0 }];
    let directories = 0;
    let pluginCount = 0;
    while (queue.length && directories++ < 1000 && pluginCount < 256) {
      const current = queue.shift()!;
      const entries = await children(root, current.folder, budget);
      const descriptor = entries.find(entry => entry.isFile() && /\.uplugin$/i.test(entry.name));
      if (descriptor && current.depth > 0) {
        scopes.push({ projectPath, root: current.folder, name: path.basename(descriptor.name, path.extname(descriptor.name)) });
        pluginCount++; continue;
      }
      if (current.depth >= 6) {
        if (entries.some(entry => entry.isDirectory() && !ignored.has(entry.name.toLowerCase()))) {
          budget.warnings.add(tr('插件目录层级超过 6 层，深层目录未扫描：{0}', 'Plugin directory depth exceeded 6; deeper directories were not scanned: {0}', current.folder));
        }
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && !ignored.has(entry.name.toLowerCase())) {
          if (queue.length < 1000) { queue.push({ folder: path.join(current.folder, entry.name), depth: current.depth + 1 }); }
          else { budget.warnings.add(tr('插件目录队列超过 1,000 项，扫描已截断。', 'The plugin directory queue exceeded 1,000 entries; discovery was truncated.')); }
        }
      }
    }
    if (queue.length) { budget.warnings.add(tr('达到插件扫描限制（1,000 个目录或 256 个插件），结果可能不完整。', 'The plugin scan limit (1,000 directories or 256 plugins) was reached; results may be incomplete.')); }
  }
  return scopes;
}

/** 自动发现主项目与项目 Plugins；不扫描整个引擎，也不跟随工作区外部链接。 */
export async function discoverLocalizationTargets(projectPaths: readonly string[]): Promise<LocalizationTarget[]> {
  const result: LocalizationTarget[] = [];
  const budget: ScanBudget = { directories: 10000, warnings: new Set() };
  for (const scope of await projectScopes(projectPaths, budget)) {
    const root = path.dirname(scope.projectPath);
    const states = new Map<string, TargetState>();
    const ensure = (name: string, dataDirectory: string): TargetState => {
      const key = `${localKey(dataDirectory)}\0${name}`;
      let state = states.get(key);
      if (!state) {
        state = { target: makeTarget(scope, name, dataDirectory), poRoots: new Set([dataDirectory]), poNames: new Set([`${name}.po`]), explicitPoNames: false, configuredCultures: {} };
        if (states.size < 500) { states.set(key, state); }
        else { budget.warnings.add(tr('作用域中的本地化目标超过 500 个，扫描已截断：{0}', 'More than 500 localization targets were found in a scope; discovery was truncated: {0}', scope.root)); }
      }
      return state;
    };
    const configDirectory = path.join(scope.root, 'Config', 'Localization');
    const configEntries = await children(root, configDirectory, budget);
    for (const entry of configEntries) {
      if (!entry.isFile() || !/\.ini$/i.test(entry.name)) { continue; }
      const filename = path.join(configDirectory, entry.name);
      const text = await smallText(root, filename);
      if (text === undefined) { continue; }
      const ini = parseIni(text); const common = ini.get('commonsettings');
      const manifest = getValue(common, 'ManifestName');
      const actions = classifyConfig(ini);
      if (!safeFilename(manifest) || !/\.manifest$/i.test(manifest) || actions.length === 0) { continue; }
      const name = manifest.slice(0, -'.manifest'.length);
      if (!name) { continue; }
      const action = actions[0];
      const rawData = action === 'import' || action === 'gather'
        ? getValue(common, 'DestinationPath') ?? getValue(common, 'SourcePath')
        : getValue(common, 'SourcePath') ?? getValue(common, 'DestinationPath');
      const dataDirectory = rawData && resolveIniPath(rawData, root);
      if (!dataDirectory || !await safePath(root, dataDirectory)) {
        // 显示不可执行的占位目标，使未扫描的引擎/外部目标不会被误认为“项目没有本地化”。
        const fallback = path.join(scope.root, 'Content', 'Localization', name);
        if (await safePath(root, fallback)) {
          ensure(name, fallback).target.warnings.push(tr('已跳过 {0}：数据路径位于项目外、包含未解析变量或符号链接。请打开原始 INI 检查。', 'Skipped {0}: its data path is outside the project, uses an unresolved variable, or contains a symbolic link. Open the original INI to inspect it.', entry.name));
        }
        continue;
      }
      const state = ensure(name, dataDirectory); const target = state.target;
      if (!within(scope.root, dataDirectory)) { target.warnings.push(tr('配置的数据路径相对于项目根目录解析：{0}', 'The configuration resolves its data path relative to the project root: {0}', dataDirectory)); }
      const native = getValue(common, 'NativeCulture');
      if (safeCulture(native)) {
        if (target.nativeCulture && target.nativeCulture.toLowerCase() !== native.toLowerCase()) { target.warnings.push(tr('不同配置文件的源语言 NativeCulture 不一致。', 'The configuration files disagree about NativeCulture.')); }
        else { target.nativeCulture = native; addCulture(target, native); }
      }
      for (const culture of common?.get('culturestogenerate') ?? []) { addCulture(target, culture); }
      if (actions.length !== 1) {
        target.warnings.push(tr('此 INI 包含多个步骤类型，未将其绑定为单一操作：{0}', 'Combined commandlet pipeline was not assigned to a single action: {0}', entry.name));
      } else if (target.configs[action] && target.configs[action] !== filename) {
        target.warnings.push(tr('发现多个 {0} 配置；请打开 INI 确认当前选择。', 'Multiple {0} configurations were found; open the INI to verify the selected one.', action));
      } else { target.configs[action] = filename; state.configuredCultures[action] = declaredCultures(ini); }
      const poName = getValue(common, 'PortableObjectName');
      if (safeFilename(poName) && /\.po$/i.test(poName)) {
        if (!state.explicitPoNames) { state.poNames.clear(); state.explicitPoNames = true; }
        state.poNames.add(poName);
      }
      const rawPoRoot = action === 'export' ? getValue(common, 'DestinationPath') : action === 'import' ? getValue(common, 'SourcePath') : undefined;
      const poRoot = rawPoRoot && resolveIniPath(rawPoRoot, root);
      if (poRoot && await safePath(root, poRoot)) { state.poRoots.add(poRoot); }
    }
    for (const entry of configEntries) {
      if (!entry.isFile() || !/\.ixena-loc\.json$/i.test(entry.name)) { continue; }
      const metadataPath = path.join(configDirectory, entry.name);
      const text = await smallText(root, metadataPath, 64 * 1024);
      const metadata = text === undefined ? undefined : readMetadata(text);
      if (!metadata) { continue; }
      const directory = path.resolve(scope.root, metadata.dataDirectory);
      if (!await safePath(root, directory)) { continue; }
      const state = ensure(metadata.targetName, directory); const target = state.target;
      target.managed = true; target.metadataPath = metadataPath;
      target.nativeCulture = metadata.nativeCulture;
      for (const culture of culturesWithNative(metadata.nativeCulture, metadata.cultures)) { addCulture(target, culture); }
      target.warnings.push(managedWarning());
      for (const action of operations) {
        const filename = path.join(configDirectory, metadata.configs[action]);
        const configText = await smallText(root, filename);
        if (configText === undefined) { target.warnings.push(tr('缺少 iXena 管理的 {0} 配置：{1}', 'Missing managed {0} configuration: {1}', action, metadata.configs[action])); continue; }
        const ini = parseIni(configText); const common = ini.get('commonsettings');
        const rawDirectory = action === 'import' || action === 'gather'
          ? getValue(common, 'DestinationPath') ?? getValue(common, 'SourcePath')
          : getValue(common, 'SourcePath') ?? getValue(common, 'DestinationPath');
        const resolved = rawDirectory && resolveIniPath(rawDirectory, root);
        const actions = classifyConfig(ini);
        if (!resolved || localKey(resolved) !== localKey(directory) || actions.length !== 1 || actions[0] !== action) {
          target.warnings.push(tr('iXena 管理的 {0} 配置已不再匹配此目标，未将其绑定为操作。', 'Managed {0} configuration no longer matches this target; it was not assigned.', action)); continue;
        }
        target.configs[action] = filename; state.configuredCultures[action] = declaredCultures(ini);
      }
    }
    for (const directory of await children(root, path.join(scope.root, 'Content', 'Localization'), budget)) {
      if (!directory.isDirectory() || directory.name.startsWith('.')) { continue; }
      const directoryPath = path.join(scope.root, 'Content', 'Localization', directory.name);
      if (![...states.values()].some(state => localKey(state.target.dataDirectory) === localKey(directoryPath))) { ensure(directory.name, directoryPath); }
      if (states.size >= 500) {
        budget.warnings.add(tr('作用域中的本地化目标达到 500 个，目录发现已停止：{0}', 'The scope reached 500 localization targets; directory discovery stopped: {0}', scope.root));
        break;
      }
    }
    for (const state of states.values()) {
      const target = state.target; const seen = new Set<string>();
      const cultureCandidates = new Map<string, Array<{ culture: string; path: string }>>();
      for (const poRoot of state.poRoots) {
        for (const cultureDirectory of await children(root, poRoot, budget)) {
          if (!cultureDirectory.isDirectory() || !safeCulture(cultureDirectory.name)) { continue; }
          const culture = cultureDirectory.name;
          const location = path.join(poRoot, culture);
          for (const po of await children(root, location, budget)) {
            if (!po.isFile() || !state.poNames.has(po.name)) { continue; }
            const filename = path.join(location, po.name);
            const key = localKey(filename);
            if (!seen.has(key)) {
              seen.add(key);
              const candidates = cultureCandidates.get(culture.toLowerCase()) ?? [];
              candidates.push({ culture, path: filename }); cultureCandidates.set(culture.toLowerCase(), candidates); addCulture(target, culture);
            }
            if (seen.size >= 1000) { break; }
          }
          if (seen.size >= 1000) { break; }
        }
        if (seen.size >= 1000) { target.warnings.push(tr('此目标的 PO 候选文件达到 1,000 个，扫描已截断。', 'This target reached 1,000 candidate PO files; discovery was truncated.')); break; }
      }
      for (const [culture, candidates] of cultureCandidates) {
        if (candidates.length === 1) { target.poFiles.push(candidates[0]); }
        else { target.warnings.push(tr('语言 {0} 有多个匹配的 PO 文件，未自动选择，以免混用目标或覆盖导出。请检查 PortableObjectName 和导入/导出目录。', 'Culture {0} has multiple matching PO files; none was selected automatically to avoid mixing targets or overwriting exports. Check PortableObjectName and import/export directories.', culture)); }
        for (const action of ['import', 'compile'] as const) {
          if (target.configs[action] && !state.configuredCultures[action]?.has(culture)) {
            target.warnings.push(tr('已发现 {0} 的 PO，但 {1} 配置没有启用此语言。编辑 PO 不会自动加入 CulturesToGenerate；请先更新目标的语言设置。',
              'A PO file was found for {0}, but the {1} configuration does not enable this culture. Editing the PO does not add it to CulturesToGenerate; update the target culture settings first.', culture, action));
          }
        }
      }
      target.cultures.sort((a, b) => a.localeCompare(b));
      target.poFiles.sort((a, b) => a.culture.localeCompare(b.culture) || a.path.localeCompare(b.path));
      target.warnings = [...new Set(target.warnings)];
      result.push(target);
    }
  }
  for (const target of result) { target.warnings.push(...budget.warnings); }
  return result.sort((a, b) => a.scopeName.localeCompare(b.scopeName) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

async function checkedScope(projectPath: string, scopeRoot: string): Promise<Scope> {
  if (!safeString(projectPath) || !path.isAbsolute(projectPath) || !/\.uproject$/i.test(projectPath)
    || !safeString(scopeRoot) || !path.isAbsolute(scopeRoot)) { throw new Error(tr('请选择绝对路径的 .uproject 和项目或插件作用域。', 'Select an absolute .uproject path and a project or plugin scope.')); }
  projectPath = path.resolve(projectPath); scopeRoot = path.resolve(scopeRoot);
  const projectRoot = path.dirname(projectPath);
  if (!await safePath(projectRoot, projectPath) || !(await fs.lstat(projectPath).catch(() => undefined))?.isFile()
    || !await safePath(projectRoot, scopeRoot) || !(await fs.stat(scopeRoot).catch(() => undefined))?.isDirectory()) {
    throw new Error(tr('项目或作用域不存在、位于项目外，或包含符号链接。', 'The project or scope does not exist, is outside the project, or contains a symbolic link.'));
  }
  let name = path.basename(projectPath, path.extname(projectPath));
  if (localKey(scopeRoot) !== localKey(projectRoot)) {
    if (!within(path.join(projectRoot, 'Plugins'), scopeRoot)) { throw new Error(tr('插件作用域必须位于此项目的 Plugins 目录中。', 'A plugin scope must be under this project\'s Plugins directory.')); }
    const descriptor = (await children(projectRoot, scopeRoot)).find(entry => entry.isFile() && /\.uplugin$/i.test(entry.name));
    if (!descriptor) { throw new Error(tr('所选作用域没有 .uplugin 描述文件。', 'The selected scope has no .uplugin descriptor.')); }
    name = path.basename(descriptor.name, path.extname(descriptor.name));
  }
  return { projectPath, root: scopeRoot, name };
}
function relativeIniPath(projectRoot: string, filename: string): string {
  const relative = path.relative(projectRoot, filename).split(path.sep).join('/');
  if (!safeString(relative) || /["\u0000\r\n]/.test(relative)) { throw new Error(tr('所选路径包含无法安全写入 INI 的字符。', 'The selected path cannot be represented safely in an INI file.')); }
  return relative;
}
function metadataText(metadata: ManagedMetadata): string { return `${JSON.stringify(metadata, null, 2)}\n`; }

/** 仅生成文件计划。与 UE Dashboard 独立，既不覆盖其 INI，也不改 DefaultEditor.ini。 */
export async function createTargetPlan(
  projectPath: string, scopeRoot: string, name: string, nativeCulture: string, cultures: readonly string[]
): Promise<LocalizationTargetPlan> {
  if (!safeName(name)) { throw new Error(tr('目标名称须以字母开头，只含字母、数字或下划线，最多 64 个字符。', 'Target names must start with a letter and use up to 64 letters, digits or underscores.')); }
  const normalizedCultures = culturesWithNative(nativeCulture, cultures);
  const scope = await checkedScope(projectPath, scopeRoot);
  const root = path.dirname(scope.projectPath);
  const configDirectory = path.join(scope.root, 'Config', 'Localization');
  const dataDirectory = path.join(scope.root, 'Content', 'Localization', name);
  if (!await safePath(root, configDirectory) || !await safePath(root, dataDirectory)) { throw new Error(tr('本地化目录必须位于项目内，且不能经过符号链接。', 'Localization directories must stay within the project without symbolic links.')); }
  const owned = (await discoverLocalizationTargets([scope.projectPath])).some(existing => localKey(existing.scopeRoot) === localKey(scope.root)
    && (existing.name.toLowerCase() === name.toLowerCase() || localKey(existing.dataDirectory) === localKey(dataDirectory)));
  let dashboardOwned = false;
  if (localKey(scope.root) === localKey(root)) {
    const editorIni = await smallText(root, path.join(root, 'Config', 'DefaultEditor.ini'));
    const settings = editorIni === undefined ? undefined : parseIni(editorIni).get('/script/localization.localizationsettings');
    dashboardOwned = (settings?.get('gametargetssettings') ?? []).some(value => {
      const match = /^\(\s*Name\s*=\s*"?([A-Za-z][A-Za-z0-9_]*)"?\s*(?:,|\))/i.exec(value);
      return match?.[1].toLowerCase() === name.toLowerCase();
    });
  } else {
    const descriptor = (await children(root, scope.root)).find(entry => entry.isFile() && /\.uplugin$/i.test(entry.name));
    if (descriptor) {
      const text = await smallText(root, path.join(scope.root, descriptor.name));
      try {
        const value = JSON.parse(text ?? '{}') as { LocalizationTargets?: Array<{ Name?: string }> };
        dashboardOwned = Array.isArray(value.LocalizationTargets) && value.LocalizationTargets.some(entry => entry.Name?.toLowerCase() === name.toLowerCase());
      } catch { /* 配置发现负责报告不支持的描述文件；这里不重写描述文件。 */ }
    }
  }
  if (owned || dashboardOwned) {
    throw new Error(tr('同名本地化目标或数据目录已有配置所有者。请打开已有目标，不能创建第二套配置覆盖它。',
      'A localization target with this name or data directory already exists. Open the existing target instead of creating a second configuration owner.'));
  }
  const target = makeTarget(scope, name, dataDirectory);
  target.nativeCulture = nativeCulture; target.cultures = normalizedCultures; target.managed = true; target.warnings = [managedWarning()];
  const configs = Object.fromEntries(operations.map(operation => [operation, `iXena.${name}.${operation}.ini`])) as Record<LocalizationOperation, string>;
  const metadata: ManagedMetadata = { schemaVersion: 1, managedBy: 'iXenaUnrealTools', targetName: name,
    nativeCulture, cultures: normalizedCultures, dataDirectory: `Content/Localization/${name}`, configs };
  const dataPath = relativeIniPath(root, dataDirectory);
  const common = ['[CommonSettings]', `SourcePath=${dataPath}`, `DestinationPath=${dataPath}`,
    `ManifestName=${name}.manifest`, `ArchiveName=${name}.archive`, `NativeCulture=${nativeCulture}`,
    ...normalizedCultures.map(culture => `CulturesToGenerate=${culture}`)];
  const header = tr('; 由 iXena Unreal Tools 管理。本文件是命令行配置，不会自动添加 UE 本地化面板目标。\n; UE 本地化面板使用独立设置，可能重新生成其自身的配置文件。\n',
    '; Managed by iXena Unreal Tools. This is a commandlet configuration, not a UE Dashboard target.\n; UE Dashboard uses separate settings and may regenerate its own configuration files.\n');
  const sourceDirectory = path.join(scope.root, 'Source');
  const contentDirectory = path.join(scope.root, 'Content');
  const hasSource = await safePath(root, sourceDirectory) && (await fs.stat(sourceDirectory).catch(() => undefined))?.isDirectory();
  const hasContent = await safePath(root, contentDirectory) && (await fs.stat(contentDirectory).catch(() => undefined))?.isDirectory();
  const gatherSteps: string[][] = [];
  if (hasSource) {
    const step = ['CommandletClass=GatherTextFromSource', `SearchDirectoryPaths=${relativeIniPath(root, sourceDirectory)}`];
    const configRoot = path.join(scope.root, 'Config');
    if (await safePath(root, configRoot) && (await fs.stat(configRoot).catch(() => undefined))?.isDirectory()) {
      step.push(`SearchDirectoryPaths=${relativeIniPath(root, configRoot)}`);
    }
    step.push(`ExcludePathFilters=${relativeIniPath(root, configDirectory)}/*`, 'FileNameFilters=*.h', 'FileNameFilters=*.cpp',
      'FileNameFilters=*.inl', 'FileNameFilters=*.ini', 'ShouldGatherFromEditorOnlyData=false');
    gatherSteps.push(step);
  }
  if (hasContent) {
    gatherSteps.push(['CommandletClass=GatherTextFromAssets', `IncludePathFilters=${relativeIniPath(root, contentDirectory)}/*`,
      `ExcludePathFilters=${relativeIniPath(root, path.join(contentDirectory, 'Localization'))}/*`,
      `ExcludePathFilters=${relativeIniPath(root, path.join(contentDirectory, 'L10N'))}/*`,
      'PackageFileNameFilters=*.uasset', 'PackageFileNameFilters=*.umap', 'ShouldGatherFromEditorOnlyData=false']);
  }
  if (!hasSource && !hasContent) { throw new Error(tr('所选作用域需先包含 Source 或 Content 目录，才能创建本地化目标。', 'The selected scope needs a Source or Content directory before a localization target can be created.')); }
  gatherSteps.push(['CommandletClass=GenerateGatherManifest'], ['CommandletClass=GenerateGatherArchive']);
  const steps = (value: string[][]): string => value.map((step, index) => `\n[GatherTextStep${index}]\n${step.join('\n')}\n`).join('');
  const bodies: Record<LocalizationOperation, string> = {
    gather: common.join('\n') + '\n' + steps(gatherSteps),
    export: [...common, `PortableObjectName=${name}.po`].join('\n') + '\n' + steps([['CommandletClass=InternationalizationExport',
      'bExportLoc=true', 'bUseCultureDirectory=true', 'LocalizedTextCollapseMode=ELocalizedTextCollapseMode::IdenticalTextIdAndSource',
      'POFormat=EPortableObjectFormat::Unreal', 'ShouldPersistCommentsOnExport=true']]),
    import: [...common, `PortableObjectName=${name}.po`].join('\n') + '\n' + steps([['CommandletClass=InternationalizationExport',
      'bImportLoc=true', 'bUseCultureDirectory=true', 'LocalizedTextCollapseMode=ELocalizedTextCollapseMode::IdenticalTextIdAndSource', 'POFormat=EPortableObjectFormat::Unreal']]),
    compile: [...common, `ResourceName=${name}.locres`, 'bSkipSourceCheck=false', 'bValidateFormatPatterns=true', 'bValidateSafeWhitespace=false'].join('\n')
      + '\n' + steps([['CommandletClass=GenerateTextLocalizationResource']])
  };
  const files: LocalizationTargetPlan['files'] = operations.map(operation => {
    const filename = path.join(configDirectory, configs[operation]); target.configs[operation] = filename;
    return { path: filename, content: header + bodies[operation] };
  });
  target.metadataPath = path.join(configDirectory, `${name}.ixena-loc.json`);
  files.push({ path: target.metadataPath, content: metadataText(metadata) });
  for (const file of files) {
    if (await fs.lstat(file.path).catch(() => undefined)) { throw new Error(tr('本地化配置已存在：{0}', 'The localization configuration already exists: {0}', file.path)); }
  }
  if ((await children(root, dataDirectory)).length) { throw new Error(tr('此目标已有本地化数据。请打开其已有配置，不能创建第二套所有者。', 'This target already has localization data. Open its existing configuration instead of creating a second owner.')); }
  return { files, target };
}

function appendCulture(text: string, culture: string): string {
  const ini = parseIni(text);
  const common = ini.get('commonsettings');
  if (!common) { throw new Error(tr('iXena 管理的 INI 没有 CommonSettings 分段。', 'The managed INI has no CommonSettings section.')); }
  if ((common.get('culturestogenerate') ?? []).some(value => value.toLowerCase() === culture.toLowerCase())) { return text; }
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => /^\s*\[commonsettings\]\s*(?:[;#].*)?$/i.test(line.replace(/^\uFEFF/, '')));
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) { end++; }
  lines.splice(end, 0, `CulturesToGenerate=${culture}`);
  return lines.join(newline);
}

/** 已有 Dashboard 目标不盲改；只为本扩展拥有的配置生成追加语言计划。 */
export async function addCulturePlan(target: LocalizationTarget, culture: string): Promise<LocalizationTargetPlan> {
  if (!safeCulture(culture)) { throw new Error(tr('语言代码无效。', 'Invalid culture code.')); }
  if (!target.managed || !target.metadataPath) { throw new Error(tr('请在 UE 本地化面板中为此目标添加语言，然后重新生成命令行配置。', 'Add cultures to this UE Dashboard target in the UE Localization Dashboard, then regenerate its commandlet configuration.')); }
  const scope = await checkedScope(target.projectPath, target.scopeRoot);
  const root = path.dirname(scope.projectPath);
  const configDirectory = path.join(scope.root, 'Config', 'Localization');
  if (path.dirname(target.metadataPath) !== configDirectory) { throw new Error(tr('管理元数据必须位于此作用域的 Config/Localization 目录。', 'The managed metadata must be in this scope\'s Config/Localization directory.')); }
  const before = await smallText(root, target.metadataPath, 64 * 1024);
  const metadata = before === undefined ? undefined : readMetadata(before);
  if (!metadata || metadata.targetName !== target.name) { throw new Error(tr('本地化管理元数据缺失，或不匹配此目标。', 'The managed localization metadata is missing or does not match this target.')); }
  const cultures = culturesWithNative(metadata.nativeCulture, [...metadata.cultures, culture]);
  const files: LocalizationTargetPlan['files'] = [];
  for (const operation of operations) {
    const filename = path.join(configDirectory, metadata.configs[operation]);
    if (target.configs[operation] !== filename) { throw new Error(tr('iXena 管理的 {0} 配置缺失或已更改，请先刷新目标。', 'The managed {0} configuration is missing or has changed. Refresh the target first.', operation)); }
    const text = await smallText(root, filename);
    if (text === undefined) { throw new Error(tr('无法安全读取 iXena 管理的配置：{0}', 'Cannot safely read the managed configuration: {0}', filename)); }
    files.push({ path: filename, content: appendCulture(text, culture), expectedText: text });
  }
  files.push({ path: target.metadataPath, content: metadataText({ ...metadata, cultures }), expectedText: before });
  return { files, target: { ...target, cultures } };
}

/** 直接执行编辑器 Commandlet；argv 不带 shell 引号、不依赖 Bridge 或 MCP。 */
export function runnerCommand(engineRoot: string, projectPath: string, configPath: string, platform: NodeJS.Platform = process.platform): { executable: string; args: string[] } {
  const pathFor = (value: string): typeof path.win32 | typeof path.posix => /^[A-Za-z]:[\\/]|^\\\\/.test(value) ? path.win32 : path.posix;
  if (![engineRoot, projectPath, configPath].every(value => safeString(value) && pathFor(value).isAbsolute(value))
    || !/\.uproject$/i.test(projectPath) || !/\.ini$/i.test(configPath)) { throw new Error(tr('请选择绝对路径的引擎目录、.uproject 和本地化 INI。', 'Select absolute engine, .uproject and localization INI paths.')); }
  const join = pathFor(engineRoot).join;
  const binaryRoot = join(engineRoot, 'Engine', 'Binaries');
  const candidates = platform === 'win32' ? [join(binaryRoot, 'Win64', 'UnrealEditor-Cmd.exe'), join(binaryRoot, 'Win64', 'UnrealEditor.exe')]
    : platform === 'darwin' ? [join(binaryRoot, 'Mac', 'UnrealEditor-Cmd'), join(binaryRoot, 'Mac', 'UnrealEditor-Cmd.app', 'Contents', 'MacOS', 'UnrealEditor-Cmd'),
      join(binaryRoot, 'Mac', 'UnrealEditor.app', 'Contents', 'MacOS', 'UnrealEditor'), join(binaryRoot, 'Mac', 'UnrealEditor')]
      : platform === 'linux' ? [join(binaryRoot, 'Linux', 'UnrealEditor-Cmd'), join(binaryRoot, 'Linux', 'UnrealEditor')] : [];
  if (!candidates.length) { throw new Error(tr('尚未为平台 {0} 配置 UE 本地化命令行入口。', 'UE localization commandlets are not configured for platform {0}.', platform)); }
  const executable = candidates.find(filename => { try { return syncFs.statSync(filename).isFile(); } catch { return false; } });
  if (!executable) { throw new Error(tr('在 {0} 下没有找到 UnrealEditor 命令行可执行文件。', 'UnrealEditor commandlet executable was not found under {0}.', binaryRoot)); }
  return { executable, args: [projectPath, '-run=GatherText', `-config=${configPath}`, '-unattended', '-nop4', '-UTF8Output', '-stdout', '-FullStdOutLogOutput'] };
}
