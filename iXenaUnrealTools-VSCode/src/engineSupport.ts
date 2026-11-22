import { t } from './i18n';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface EngineVersion { major: number; minor: number; patch: number; }
export interface EngineInstallation { root: string; label: string; version?: EngineVersion; }

export function pathApi(value: string): typeof path.win32 | typeof path.posix {
  // VS Code 的工作区设置与状态持久化属于运行时数据，即使 TS 声明为 string 也可能出现 undefined。
  // 在这里提供明确报错，避免 TypeError: Cannot read properties of undefined (reading 'startsWith')。
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(t("UE 路径未定义或不是有效字符串。请检查所选构建配置、引擎路径和工作区设置 iXenaUnrealTools.engineRoots。"));
  }
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') ? path.win32 : path.posix;
}
/** 可选路径比较用于 UI 和恢复逻辑；空值不应让状态栏、插件候选扫描崩溃。 */
export function optionalPathKey(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) { return undefined; }
  return pathKey(value);
}

/** 仅用于明确的项目引擎路径；不把未配置的 engineRoots 当成构建失败原因。 */
export function chooseEngineRoot(remembered: unknown, fromTask: unknown, label: string): { root: string; source: 'remembered' | 'task'; warning?: string } {
  const valid = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0 && pathApi(value).isAbsolute(value);
  if (valid(remembered)) { return { root: pathApi(remembered).normalize(remembered), source: 'remembered' }; }
  if (valid(fromTask)) {
    return {
      root: pathApi(fromTask).normalize(fromTask), source: 'task',
      warning: remembered === undefined ? undefined : t("忽略 {0} 的无效引擎选择记录，改用任务中定义的引擎目录。", label)
    };
  }
  throw new Error(t("构建配置“{0}”没有可用的 UE 引擎目录；请检查该任务的 Build.bat 路径及 options.cwd。", label));
}

export function pathKey(value: string): string {
  const p = pathApi(value);
  const normalized = p.normalize(value).replace(/[\\/]$/, '');
  return p === path.win32 ? normalized.toLowerCase() : normalized;
}
async function isFile(file: string): Promise<boolean> {
  return (await fs.stat(file).catch(() => undefined))?.isFile() ?? false;
}

/** UE5.0～5.x 的 Build.version 字段较稳定；禁止把不明目录误当引擎。 */
export async function readEngineVersion(root: string): Promise<EngineVersion | undefined> {
  // 引擎候选扫描的单个无效路径只能被忽略，不能阻断整个插件。
  if (typeof root !== 'string' || !root.trim()) { return undefined; }
  try {
    const p = pathApi(root);
    const parsed: unknown = JSON.parse(await fs.readFile(p.join(root, 'Engine', 'Build', 'Build.version'), 'utf8'));
    if (!parsed || typeof parsed !== 'object') { return undefined; }
    const x = parsed as Record<string, unknown>;
    const values = [x.MajorVersion, x.MinorVersion, x.PatchVersion];
    if (!Number.isInteger(values[0]) || !Number.isInteger(values[1])) { return undefined; }
    return { major: values[0] as number, minor: values[1] as number,
      patch: Number.isInteger(values[2]) ? values[2] as number : 0 };
  } catch { return undefined; }
}

export function versionName(version?: EngineVersion): string {
  return version ? `UE${version.major}.${version.minor}.${version.patch}` : t("UE5（版本未知）");
}

/** 能识别已安装的二进制引擎与源码引擎；源码引擎未构建 UBT 时仍能列出，但运行会报告前置条件。 */
export async function inspectEngine(root: string): Promise<EngineInstallation | undefined> {
  if (typeof root !== 'string' || !root.trim()) { return undefined; }
  const p = pathApi(root);
  if (!p.isAbsolute(root)) { return undefined; }
  const normalized = p.normalize(root);
  const version = await readEngineVersion(normalized);
  if (version?.major !== 5) { return undefined; }
  const build = p.join(normalized, 'Engine', 'Build', 'BatchFiles', 'Build.bat');
  const ubt = p.join(normalized, 'Engine', 'Binaries', 'DotNET', 'UnrealBuildTool', 'UnrealBuildTool.dll');
  const ubtExe = p.join(normalized, 'Engine', 'Binaries', 'DotNET', 'UnrealBuildTool', 'UnrealBuildTool.exe');
  if (!await isFile(build) && !await isFile(ubt) && !await isFile(ubtExe)) { return undefined; }
  return { root: normalized, version, label: `${versionName(version)} · ${normalized}` };
}

export async function discoverEngines(roots: readonly string[], parentDirectories: readonly string[]): Promise<EngineInstallation[]> {
  const candidates = new Map<string, string>();
  for (const root of roots) {
    if (typeof root !== 'string' || !root.trim()) { continue; }
    const p = pathApi(root);
    if (p.isAbsolute(root)) { candidates.set(pathKey(root), p.normalize(root)); }
  }
  // 仅扫描配置过的引擎父目录的直接子目录，绝不递归扫描整个磁盘。
  for (const directory of parentDirectories) {
    if (typeof directory !== 'string' || !directory.trim()) { continue; }
    const p = pathApi(directory);
    if (!p.isAbsolute(directory)) { continue; }
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.slice(0, 500)) {
      if (!entry.isDirectory() || !/(?:^UE[_ -]?5[._-]?\d+|^UnrealEngine)/i.test(entry.name)) { continue; }
      const root = p.join(directory, entry.name);
      candidates.set(pathKey(root), root);
    }
  }
  const matches = await Promise.all([...candidates.values()].map(inspectEngine));
  return matches.filter((item): item is EngineInstallation => Boolean(item))
    .sort((a, b) => b.version!.minor - a.version!.minor || b.version!.patch - a.version!.patch || a.root.localeCompare(b.root));
}

export function uhtArguments(target: string, platform: string, configuration: string, projectPath: string): string[] {
  if (typeof projectPath !== 'string' || !/^[\w.-]+$/.test(target) || !/^[\w.-]+$/.test(platform) || !/^[\w.-]+$/.test(configuration)
      || !/\.uproject$/i.test(projectPath) || !pathApi(projectPath).isAbsolute(projectPath)) {
    throw new Error(t("UHT 参数无效，请先选择有效的 UE C++ 构建配置。"));
  }
  // 按 Epic UHT 文档：-Target 是单独的一个 argv，含项目文件内层双引号。
  return ['-Mode=UnrealHeaderTool', `-Target=${target} ${platform} ${configuration} -Project="${projectPath}"`];
}

export async function readProjectEngineAssociation(projectPath: string): Promise<string | undefined> {
  try {
    const info = JSON.parse(await fs.readFile(projectPath, 'utf8')) as Record<string, unknown>;
    return typeof info.EngineAssociation === 'string' ? info.EngineAssociation : undefined;
  } catch { return undefined; }
}

export function engineAssociationMismatch(association: string | undefined, version: EngineVersion | undefined): boolean {
  if (!association || !version) { return false; }
  const match = /^(?:UE[_ -]?)?(5)\.(\d+)(?:\.\d+)?$/.exec(association);
  return Boolean(match && (Number(match[1]) !== version.major || Number(match[2]) !== version.minor));
}

/** 只监听所属项目 Source / Plugins 内带有反射宏的 .h 文件，不监听引擎文件及 Intermediate。 */
export function isUhtRelevantHeader(filePath: string, projectPath: string, documentText: string): boolean {
  if (!/\.h$/i.test(filePath) || !/\b(?:GENERATED_BODY|GENERATED_UCLASS_BODY|UCLASS|USTRUCT|UENUM|UINTERFACE|UPROPERTY|UFUNCTION)\b/.test(documentText)) {
    return false;
  }
  const p = pathApi(projectPath);
  const relative = p.relative(p.dirname(projectPath), filePath).replace(/\\/g, '/');
  if (relative.startsWith('../') || relative === '..' || p.isAbsolute(relative)) { return false; }
  return /^(Source|Plugins)\//i.test(relative) && !/(?:^|\/)Intermediate\//i.test(relative);
}
