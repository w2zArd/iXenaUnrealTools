import { t } from './i18n';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** 附加工具只触及用户选定的 .uproject 所在目录，不扫描整个 UE 引擎。 */
export function projectDirectory(projectPath: string): string {
  return path.win32.dirname(projectPath);
}

export function editorExecutable(engineRoot: string): string {
  return path.win32.join(engineRoot, 'Engine', 'Binaries', 'Win64', 'UnrealEditor.exe');
}

/** 与 UE 自动生成的 VSCode Project Files 配置相同的核心参数，不经过 .bat。 */
export function projectFilesArguments(projectPath: string): string[] {
  return ['-projectfiles', '-vscode', `-project=${projectPath}`, '-game', '-engine', '-dotnet'];
}

/** 构建命令的 PowerShell 可复制形式。完整参数始终作为 argv 传给子进程。 */
export function powershellCommand(executable: string, args: readonly string[]): string {
  const quote = (input: string): string => `'${input.replace(/'/g, "''")}'`;
  return `& ${[executable, ...args].map(quote).join(' ')}`;
}

export interface RuleFile {
  fullPath: string;
  relativePath: string;
  kind: 'Target' | 'Module';
}

/** 遍历项目 Source 和 Plugins 的规则文件；不会深入 Content、Saved 或 Intermediate。 */
export async function findRuleFiles(projectPath: string, limit = 400): Promise<RuleFile[]> {
  const base = projectDirectory(projectPath);
  const results: RuleFile[] = [];
  let visited = 0;
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 9 || results.length >= limit || ++visited > 2500) { return; }
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) { return; }
      throw error;
    }
    for (const entry of entries) {
      if (results.length >= limit || visited > 2500) { return; }
      const fullPath = path.win32.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (/^(Binaries|Intermediate|Saved|Content|DerivedDataCache|\.git|node_modules)$/i.test(entry.name)) { continue; }
        await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const kind = /\.Target\.cs$/i.test(entry.name) ? 'Target'
          : /\.Build\.cs$/i.test(entry.name) ? 'Module' : undefined;
        if (kind) { results.push({ fullPath, relativePath: path.win32.relative(base, fullPath), kind }); }
      }
    }
  }
  await walk(path.win32.join(base, 'Source'), 0);
  await walk(path.win32.join(base, 'Plugins'), 0);
  return results.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export interface LogFile {
  fullPath: string;
  title: string;
  mtime: number;
  size: number;
}

/** 项目日志 + UBT 日志；先列出实际存在的文件，不猜测最新错误在哪里。 */
export async function findLogFiles(projectPath: string, localAppData?: string): Promise<LogFile[]> {
  const result: LogFile[] = [];
  const logsDir = path.win32.join(projectDirectory(projectPath), 'Saved', 'Logs');
  let files: string[];
  try { files = await fs.readdir(logsDir); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) { throw error; }
    files = [];
  }
  for (const filename of files) {
    if (!/\.log$/i.test(filename)) { continue; }
    const fullPath = path.win32.join(logsDir, filename);
    const info = await fs.stat(fullPath).catch(() => undefined);
    if (!info?.isFile()) { continue; }
    result.push({ fullPath, title: t("项目日志 · {0}", filename), mtime: info.mtimeMs, size: info.size });
  }
  if (localAppData) {
    const fullPath = path.win32.join(localAppData, 'UnrealBuildTool', 'Log.txt');
    const info = await fs.stat(fullPath).catch(() => undefined);
    if (info?.isFile()) { result.push({ fullPath, title: 'UnrealBuildTool · Log.txt', mtime: info.mtimeMs, size: info.size }); }
  }
  return result.sort((a, b) => b.mtime - a.mtime);
}
