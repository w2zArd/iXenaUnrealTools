import { t } from './i18n';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** 仅扫描项目 Source / Plugins 的入口，不递归引擎源文件或大体积缓存。 */
export interface UeModule {
  name: string;
  directory: string;
  rulePath: string;
  scopeId: string;
  projectPath: string;
}
export interface UeScope {
  id: string;
  name: string;
  kind: 'project' | 'plugin';
  directory: string;
  projectPath: string;
  modules: UeModule[];
  targets: string[];
}
export interface UeProject { projectPath: string; name: string; directory: string; scopes: UeScope[]; }
export interface PathEntry { name: string; fullPath: string; directory: boolean; }
export interface UeLog { name: string; fullPath: string; kind: '项目' | 'UBT'; mtimeMs: number; size: number; projectPath: string; }

const ignored = new Set(['.git', '.vs', '.vscode', 'Binaries', 'Intermediate', 'Saved', 'DerivedDataCache', 'node_modules']);
export const sectionOrder = ['Public', 'Private', 'Classes', 'QMLs', 'Resources', 'Shaders', 'Tests'];
export const rootOrder = ['Config', 'Content', 'Resources', 'Shaders', 'Source'];

async function entries(directory: string): Promise<import('node:fs').Dirent[]> {
  try { return await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) { return []; }
    throw error;
  }
}
export async function isDirectory(directory: string): Promise<boolean> {
  return (await fs.stat(directory).catch(() => undefined))?.isDirectory() ?? false;
}
export async function isFile(filename: string): Promise<boolean> {
  return (await fs.stat(filename).catch(() => undefined))?.isFile() ?? false;
}
export async function listFiles(directory: string, showHidden = false, max = 1500): Promise<PathEntry[]> {
  const children = (await entries(directory)).filter(item => (showHidden || !item.name.startsWith('.')) && !ignored.has(item.name))
    .filter(item => item.isFile() || item.isDirectory())
    .sort((a, b) => Number(!a.isDirectory()) - Number(!b.isDirectory()) || a.name.localeCompare(b.name));
  return children.slice(0, max).map(entry => ({ name: entry.name, fullPath: path.join(directory, entry.name), directory: entry.isDirectory() }));
}

async function findModules(scope: UeScope): Promise<UeModule[]> {
  const modules: UeModule[] = [];
  const sourceDir = path.join(scope.directory, 'Source');
  for (const entry of await entries(sourceDir)) {
    if (!entry.isDirectory() || ignored.has(entry.name)) { continue; }
    const dir = path.join(sourceDir, entry.name);
    const expectedRule = path.join(dir, `${entry.name}.Build.cs`);
    const children = await entries(dir);
    const rule = children.find(child => child.isFile() && child.name.toLowerCase() === `${entry.name}.build.cs`.toLowerCase())
      ?? children.find(child => child.isFile() && /\.Build\.cs$/i.test(child.name));
    if (rule) { modules.push({ name: entry.name, directory: dir, rulePath: path.join(dir, rule.name) || expectedRule,
      scopeId: scope.id, projectPath: scope.projectPath }); }
  }
  return modules.sort((a, b) => a.name.localeCompare(b.name));
}
async function findTargets(directory: string): Promise<string[]> {
  return (await entries(path.join(directory, 'Source')))
    .filter(child => child.isFile() && /\.Target\.cs$/i.test(child.name))
    .map(child => path.join(directory, 'Source', child.name)).sort();
}
async function pluginsWithin(dir: string, limit = 150, depth = 0): Promise<string[]> {
  if (depth > 4 || limit < 1) { return []; }
  const results: string[] = [];
  for (const item of await entries(dir)) {
    if (!item.isDirectory() || ignored.has(item.name) || results.length >= limit) { continue; }
    const folder = path.join(dir, item.name);
    if ((await entries(folder)).some(child => child.isFile() && /\.uplugin$/i.test(child.name))) {
      results.push(folder);
    } else if (depth < 4) {
      const nested = await pluginsWithin(folder, limit - results.length, depth + 1);
      results.push(...nested);
    }
  }
  return results;
}
export async function discoverProjects(projectPaths: readonly string[]): Promise<UeProject[]> {
  const projects: UeProject[] = [];
  const seen = new Set<string>();
  for (const projectPath of projectPaths) {
    if (!/\.uproject$/i.test(projectPath) || !(await isFile(projectPath))) { continue; }
    const directory = path.dirname(projectPath);
    const key = path.normalize(directory).toLowerCase();
    if (seen.has(key)) { continue; }
    seen.add(key);
    const name = path.basename(projectPath, path.extname(projectPath));
    const root: UeScope = { id: `project:${key}`, name, directory, kind: 'project', projectPath, modules: [], targets: [] };
    root.modules = await findModules(root);
    root.targets = await findTargets(directory);
    const scopes: UeScope[] = [root];
    for (const pluginRoot of await pluginsWithin(path.join(directory, 'Plugins'))) {
      const name = path.basename(pluginRoot);
      const scope: UeScope = { id: `plugin:${pluginRoot.toLowerCase()}`, name, kind: 'plugin',
        directory: pluginRoot, modules: [], targets: [], projectPath };
      scope.modules = await findModules(scope);
      scopes.push(scope);
    }
    projects.push({ projectPath, name, directory, scopes });
  }
  return projects;
}

export async function sectionPaths(scope: UeScope, section: string, showContent = false): Promise<string[]> {
  if (section === 'Content' && !showContent) { return []; }
  const paths: string[] = [];
  for (const module of scope.modules) {
    const location = path.join(module.directory, section);
    if (await isDirectory(location)) { paths.push(location); }
  }
  return paths;
}

export async function extraPaths(scope: UeScope, showContent = false): Promise<Array<{ name: string; fullPath: string }>> {
  const extras = rootOrder.filter(name => name !== 'Source' && (name !== 'Content' || showContent));
  const result: Array<{ name: string; fullPath: string }> = [];
  for (const name of extras) {
    const location = path.join(scope.directory, name);
    if (await isDirectory(location)) { result.push({ name, fullPath: location }); }
  }
  return result;
}

export async function findLogs(projects: readonly UeProject[], localAppData?: string): Promise<UeLog[]> {
  const logs: UeLog[] = [];
  for (const project of projects) {
    const directory = path.join(project.directory, 'Saved', 'Logs');
    for (const file of await entries(directory)) {
      if (!file.isFile() || !/\.(log|txt)$/i.test(file.name)) { continue; }
      const fullPath = path.join(directory, file.name);
      const info = await fs.stat(fullPath).catch(() => undefined);
      if (info) { logs.push({ name: file.name, fullPath, kind: '项目', mtimeMs: info.mtimeMs, size: info.size, projectPath: project.projectPath }); }
    }
  }
  if (localAppData) {
    for (const name of ['Log.txt', 'Log-backup.txt']) {
      const fullPath = path.join(localAppData, 'UnrealBuildTool', name);
      const info = await fs.stat(fullPath).catch(() => undefined);
      if (info?.isFile()) { logs.push({ name, fullPath, kind: 'UBT', mtimeMs: info.mtimeMs, size: info.size,
        projectPath: projects[0]?.projectPath ?? '' }); }
    }
  }
  return logs.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export interface PaneDefinition { label: string; roots: string[]; }
export function normalizePanes(value: unknown): PaneDefinition[] {
  if (!Array.isArray(value)) { return []; }
  return value.slice(0, 30).filter((pane): pane is PaneDefinition => !!pane && typeof pane.label === 'string'
    && pane.label.length > 0 && pane.label.length < 90 && Array.isArray(pane.roots)
    && pane.roots.length <= 20 && pane.roots.every((root: unknown) => typeof root === 'string' && root.length > 0));
}

export function resolvePaneRoot(value: string, workspaceFolders: readonly { name: string; directory: string }[],
  workspaceDirectory: string, defaultFolder?: string): string {
  let result = value.replace(/\$\{workspaceFolder(?::([^}]+))?\}/g, (_whole, explicitName: string | undefined) => {
    if (explicitName) {
      const matches = workspaceFolders.filter(folder => folder.name === explicitName);
      if (matches.length !== 1) { throw new Error(t("无法唯一解析工作区文件夹：{0}", explicitName)); }
      return matches[0].directory;
    }
    if (workspaceFolders.length === 1) { return workspaceFolders[0].directory; }
    if (defaultFolder) { return defaultFolder; }
    throw new Error(t("多根工作区请使用 ${workspaceFolder:文件夹名称}。"));
  });
  if (/\$\{[^}]+\}/.test(result)) { throw new Error(t("资源管理器路径中存在不支持的变量：{0}", value)); }
  if (!path.isAbsolute(result)) { result = path.resolve(workspaceDirectory, result); }
  return path.normalize(result);
}
