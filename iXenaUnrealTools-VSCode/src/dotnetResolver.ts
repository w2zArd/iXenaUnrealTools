import { t } from './i18n';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface DotnetOptions {
  engineRoot: string;
  explicitPath?: string;
  env?: Record<string, string | undefined>;
  rememberedPath?: string;
  /** 当前适配 Windows 引擎包；测试可在 Linux 上使用真实临时目录。 */
  platform?: 'win32' | 'linux';
  choose?: (candidates: string[]) => Promise<string | undefined>;
}

export interface DotnetResult {
  dotnetPath: string;
  ubtPath: string;
  source: 'explicit' | 'DOTNET_HOST_PATH' | 'DOTNET_ROOT' | 'remembered' | 'bundled-single' | 'selected';
}

export class DotnetSelectionCancelledError extends Error {
  constructor() {
    super(t("已取消 .NET SDK 选择。"));
    this.name = 'DotnetSelectionCancelledError';
  }
}

async function isFile(file: string): Promise<boolean> {
  try { return (await fs.stat(file)).isFile(); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') { return false; }
    throw error;
  }
}

function environmentValue(env: Record<string, string | undefined>, key: string): string | undefined {
  const entry = Object.keys(env).find(candidate => candidate.toUpperCase() === key);
  return entry ? env[entry] : undefined;
}

/**
 * 从当前引擎的实际文件选择 dotnet.exe；不硬编码版本、不调用批处理、不使用系统 PATH。
 * 多个版本且没有明确配置时交给用户选择，避免随机启动不匹配的宿主。
 */
export async function resolveDotnet(options: DotnetOptions): Promise<DotnetResult> {
  if (!options.engineRoot || /\$\{|%[^%]+%/.test(options.engineRoot)) {
    throw new Error(t("UE 引擎根目录为空或含未解析变量。"));
  }
  const windowsStyle = /^[a-z]:[\\/]/i.test(options.engineRoot) || options.engineRoot.startsWith('\\\\');
  const paths = windowsStyle ? path.win32 : path.posix;
  const root = paths.normalize(options.engineRoot);
  if (!paths.isAbsolute(root)) { throw new Error(t("UE 引擎根目录必须是绝对路径。")); }
  const bundled = paths.join(root, 'Engine', 'Binaries', 'ThirdParty', 'DotNet');
  const ubtPath = paths.join(root, 'Engine', 'Binaries', 'DotNET', 'UnrealBuildTool', 'UnrealBuildTool.dll');
  if (!await isFile(ubtPath)) {
    throw new Error(t("找不到 UnrealBuildTool.dll：{0}。源码引擎请先使用 UE 官方构建流程完成 UBT 初始化。", ubtPath));
  }
  const canonical = (value: string): string => windowsStyle ? paths.normalize(value).toLowerCase() : paths.normalize(value);
  const candidatePath = (value: string): string => paths.resolve(root, value.replace(/^"(.*)"$/, '$1'));
  const inBundle = (value: string): boolean => {
    const relative = paths.relative(canonical(bundled), canonical(value));
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
  };
  const winX64Host = (value: string): boolean => paths.basename(value).toLowerCase() === 'dotnet.exe'
    && ['win-x64', 'windows'].includes(paths.basename(paths.dirname(value)).toLowerCase());

  if (options.explicitPath?.trim()) {
    if (/\$\{|%[^%]+%/.test(options.explicitPath)) { throw new Error(t("dotnetPath 含未解析变量。")); }
    const explicit = candidatePath(options.explicitPath);
    if (paths.basename(explicit).toLowerCase() !== 'dotnet.exe' || !await isFile(explicit)) {
      throw new Error(t("配置的 dotnetPath 不是有效的 dotnet.exe 文件：{0}", explicit));
    }
    return { dotnetPath: explicit, ubtPath, source: 'explicit' };
  }

  const env = options.env ?? {};
  const host = environmentValue(env, 'DOTNET_HOST_PATH');
  const dotnetRoot = environmentValue(env, 'DOTNET_ROOT');
  const specified: Array<{ value?: string; source: 'DOTNET_HOST_PATH' | 'DOTNET_ROOT' }> = [
    { value: host, source: 'DOTNET_HOST_PATH' },
    { value: dotnetRoot ? paths.join(dotnetRoot, 'dotnet.exe') : undefined, source: 'DOTNET_ROOT' },
  ];
  for (const { value, source } of specified) {
    if (!value || /\$\{|%[^%]+%/.test(value)) { continue; }
    const candidate = candidatePath(value);
    if (inBundle(candidate) && winX64Host(candidate) && await isFile(candidate)) {
      return { dotnetPath: candidate, ubtPath, source };
    }
  }

  const candidates: string[] = [];
  // 兼容 UE5.0/5.1 的 Windows/windows 目录与 UE5.9 的 win-x64 布局。
  for (const folder of ['win-x64', 'windows', 'Windows']) {
    const direct = paths.join(bundled, folder, 'dotnet.exe');
    if (await isFile(direct)) { candidates.push(direct); }
  }
  let entries: string[];
  try { entries = await fs.readdir(bundled); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') { throw error; }
    entries = [];
  }
  // 只看正式版本目录下一层 win-x64/windows；不做不受控的递归扫描。
  for (const version of entries) {
    if (!/^\d+(?:\.\d+)*(?:[-+][a-z0-9.-]+)?$/i.test(version)) { continue; }
    for (const folder of ['win-x64', 'windows', 'Windows']) {
      const candidate = paths.join(bundled, version, folder, 'dotnet.exe');
      if (await isFile(candidate)) { candidates.push(candidate); }
    }
  }
  // Windows 文件系统不区分大小写：Windows 与 windows 不能算作两个 SDK。
  const uniqueCandidates = [...new Map(candidates.map(candidate => [canonical(candidate), candidate])).values()];
  uniqueCandidates.sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
  candidates.splice(0, candidates.length, ...uniqueCandidates);
  if (!candidates.length) {
    throw new Error(t("在 {0} 中找不到 Windows x64 的 dotnet.exe，请设置 iXenaUnrealTools.dotnetPath 指向此引擎需要的宿主。", bundled));
  }
  if (candidates.length === 1) {
    return { dotnetPath: candidates[0], ubtPath, source: 'bundled-single' };
  }
  if (options.rememberedPath) {
    const remembered = candidates.find(candidate => canonical(candidate) === canonical(candidatePath(options.rememberedPath!)));
    if (remembered) { return { dotnetPath: remembered, ubtPath, source: 'remembered' }; }
  }
  if (!options.choose) {
    throw new Error(t("此引擎包含 {0} 个 .NET 宿主，请选择或配置明确的 dotnetPath。", candidates.length));
  }
  const selected = await options.choose([...candidates]);
  if (selected === undefined) { throw new DotnetSelectionCancelledError(); }
  const match = candidates.find(candidate => canonical(candidate) === canonical(candidatePath(selected)));
  if (!match || !await isFile(match)) { throw new Error(t("所选 .NET 宿主不在当前有效候选列表中，请重新选择。")); }
  return { dotnetPath: match, ubtPath, source: 'selected' };
}


/** UE5.0 部分构建提供 UBT.exe；UE5.1+ 普遍为 dotnet.exe + UBT.dll。按实际文件能力选择。 */
export interface BuildToolInvocation {
  process: string;
  prefixArgs: string[];
  ubtPath: string;
  dotnetPath?: string;
  source: string;
}

export async function resolveBuildTool(options: DotnetOptions): Promise<BuildToolInvocation> {
  if (typeof options?.engineRoot !== 'string' || !options.engineRoot.trim()) {
    throw new Error(t("无法调用 UBT：所选 UE 引擎路径为空。请重新选择构建配置或引擎版本。"));
  }
  const windowsStyle = /^[a-z]:[\\/]/i.test(options.engineRoot) || options.engineRoot.startsWith('\\\\');
  const p = windowsStyle ? path.win32 : path.posix;
  const base = p.join(options.engineRoot, 'Engine', 'Binaries', 'DotNET', 'UnrealBuildTool');
  const dll = p.join(base, 'UnrealBuildTool.dll');
  if (await isFile(dll)) {
    const resolved = await resolveDotnet(options);
    return { process: resolved.dotnetPath, prefixArgs: [resolved.ubtPath],
      ubtPath: resolved.ubtPath, dotnetPath: resolved.dotnetPath, source: resolved.source };
  }
  const executables = [p.join(base, 'UnrealBuildTool.exe'),
    p.join(options.engineRoot, 'Engine', 'Binaries', 'DotNET', 'UnrealBuildTool.exe')];
  for (const executable of executables) {
    if (await isFile(executable)) {
      return { process: executable, prefixArgs: [], ubtPath: executable, source: 'legacy-exe' };
    }
  }
  throw new Error(t("此引擎尚未生成 UnrealBuildTool（{0}）。源码版 UE 请先构建 UBT。", base));
}
