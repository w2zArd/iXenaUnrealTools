import { t } from './i18n';
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse, ParseError, printParseErrorCode } from 'jsonc-parser';
import { inspectUeTask, UeTaskSpec } from './ueTaskModel';

type JsonObject = Record<string, any>;

export interface ConfigOrigin {
  key: string;
  uri: vscode.Uri;
  folder?: vscode.WorkspaceFolder;
  label: string;
  baseDirectory: string;
}

export interface TaskEntry {
  id: string;
  origin: ConfigOrigin;
  raw: JsonObject;
  spec: UeTaskSpec;
  native?: vscode.Task;
  env: Record<string, string | undefined>;
  resolve: (value: string) => string;
}

export interface BuildConfiguration {
  id: string;
  title: string;
  target: string;
  platform: string;
  configuration: string;
  projectName: string;
  projectPath: string;
  origin: ConfigOrigin;
  tasks: Partial<Record<'Build' | 'Rebuild' | 'Clean', TaskEntry>>;
}

export interface LaunchEntry {
  id: string;
  origin: ConfigOrigin;
  config: vscode.DebugConfiguration;
}

export interface WorkspaceCatalogue {
  configurations: BuildConfiguration[];
  entries: TaskEntry[];
  launches: LaunchEntry[];
  issues: string[];
}

/** 环境变量在 Windows 中大小写不敏感。 */
export function envGet(env: Record<string, string | undefined>, name: string): string | undefined {
  const key = Object.keys(env).find(value => value.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

function envSet(env: Record<string, string | undefined>, name: string, value: string | undefined): void {
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === name.toLowerCase()) { delete env[key]; }
  }
  env[name] = value;
}

export function pathApi(value: string): typeof path.win32 {
  return /^[A-Za-z]:[\\/]|^\\\\/.test(value) ? path.win32 : path;
}

export function makeResolver(
  origin: ConfigOrigin,
  env: Record<string, string | undefined>,
  folders: readonly vscode.WorkspaceFolder[]
): (value: string) => string {
  // workspace 级任务没有隐含的“第一个文件夹”；无名变量只在唯一/同目录项目中解析。
  const baseFolder = origin.folder ?? folders.find(folder => samePath(folder.uri.fsPath, origin.baseDirectory))
    ?? (folders.length === 1 ? folders[0] : undefined);
  return (value: string): string => {
    let current = value;
    for (let depth = 0; depth < 8; depth++) {
      const next = current.replace(/\$\{([^}]+)\}/g, (_whole, expression: string) => {
        if (expression.startsWith('env:')) {
          const result = envGet(env, expression.slice(4));
          if (result === undefined) { throw new Error(t("环境变量 {0} 未设置。", expression.slice(4))); }
          return result;
        }
        if (expression === 'workspaceFolder') {
          if (!baseFolder) { throw new Error(t("多根工作区的 ${workspaceFolder} 不明确，请在已有任务中指定文件夹名称。")); }
          return baseFolder.uri.fsPath;
        }
        if (expression.startsWith('workspaceFolder:')) {
          const name = expression.slice('workspaceFolder:'.length);
          const matches = folders.filter(folder => folder.name === name);
          if (matches.length !== 1) { throw new Error(t("无法唯一定位工作区文件夹：{0}", name)); }
          return matches[0].uri.fsPath;
        }
        if (expression === 'workspaceFolderBasename') {
          if (!baseFolder) { throw new Error(t("workspaceFolderBasename 没有明确的任务文件夹。")); }
          return pathApi(baseFolder.uri.fsPath).basename(baseFolder.uri.fsPath);
        }
        if (expression === 'userHome') { return os.homedir(); }
        if (expression === 'pathSeparator' || expression === '/') { return '\\'; }
        if (expression.startsWith('config:')) {
          const result = vscode.workspace.getConfiguration(undefined, origin.folder?.uri).get<unknown>(expression.slice(7));
          if (typeof result !== 'string') { throw new Error(t("配置变量 {0} 不是字符串。", expression)); }
          return result;
        }
        throw new Error(t("直接构建暂不支持变量 ${{0}}；请使用“运行原始任务”。", expression));
      }).replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_whole, name: string) => {
        const result = envGet(env, name);
        if (result === undefined) { throw new Error(t("环境变量 {0} 未设置。", name)); }
        return result;
      });
      if (next === current) {
        if (/\$\{[^}]+\}/.test(next)) { throw new Error(t("任务变量存在循环引用。")); }
        return next;
      }
      current = next;
    }
    throw new Error(t("任务变量展开层数过多，请检查循环引用。"));
  };
}

/**
 * 合并只读元数据。复杂的命令/环境继承必须使用 VS Code 解析后的 execution，
 * 不能用普通对象深合并来猜测 VS Code 的全局 command/args/env 继承语义。
 */
export function mergeTaskConfig(root: JsonObject, raw: JsonObject, execution?: vscode.ShellExecution | vscode.ProcessExecution | vscode.CustomExecution): JsonObject {
  const layers = [root, root.windows ?? {}, raw, raw.windows ?? {}];
  const result: JsonObject = {};
  for (const layer of layers) {
    const previousOptions = result.options ?? {};
    const previousPresentation = result.presentation ?? {};
    Object.assign(result, layer);
    if (layer.options) {
      result.options = { ...previousOptions, ...layer.options,
        env: { ...previousOptions.env, ...layer.options.env } };
    }
    if (layer.presentation) { result.presentation = { ...previousPresentation, ...layer.presentation }; }
  }
  delete result.tasks;
  delete result.inputs;
  delete result.windows;
  delete result.linux;
  delete result.osx;
  delete result.version;
  const executable = execution && ('command' in execution ? execution.command : 'process' in execution ? execution.process : undefined);
  const argumentsList = execution && 'args' in execution ? execution.args : undefined;
  const needsNative = [root, root.windows ?? {}].some(layer => layer.command !== undefined || layer.args !== undefined)
    || layers.filter(layer => layer.options?.env !== undefined).length > 1;
  if (needsNative && (executable === undefined || !Array.isArray(argumentsList))) {
    throw new Error(t("此任务包含全局命令、参数或多层环境继承，但无法取得 VS Code 解析后的命令；请运行原始任务。"));
  }
  if (executable !== undefined && Array.isArray(argumentsList)) {
    result.command = executable;
    result.args = [...argumentsList];
    const options = execution && 'options' in execution ? execution.options : undefined;
    result.options ??= {};
    delete result.options.cwd;
    delete result.options.env;
    if (options?.cwd !== undefined) { result.options.cwd = options.cwd; }
    if (options?.env !== undefined) { result.options.env = { ...options.env }; }
  }
  return result;
}

export function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => pathApi(value).normalize(value).replace(/[\\/]$/, '').toLowerCase();
  return normalize(left) === normalize(right);
}

function nativeFor(origin: ConfigOrigin, label: string, tasks: vscode.Task[]): vscode.Task | undefined {
  const matches = tasks.filter(task => {
    if (task.name !== label) { return false; }
    if (origin.folder) {
      return typeof task.scope === 'object' && task.scope.uri.toString() === origin.folder.uri.toString();
    }
    return task.scope === vscode.TaskScope.Workspace;
  });
  return matches.length === 1 ? matches[0] : undefined;
}

async function readJson(uri: vscode.Uri, optional: boolean): Promise<JsonObject | undefined> {
  let bytes: Uint8Array;
  try { bytes = await vscode.workspace.fs.readFile(uri); }
  catch (error) {
    if (optional && (error as { code?: string }).code === 'FileNotFound') { return undefined; }
    throw error;
  }
  const errors: ParseError[] = [];
  const document = parse(Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) { throw new Error(t("{0}：{1}（偏移 {2}）", uri.fsPath, printParseErrorCode(errors[0].error), errors[0].offset)); }
  if (!document || Array.isArray(document) || typeof document !== 'object') { throw new Error(t("{0} 不是 JSON 对象。", uri.fsPath)); }
  return document;
}

function buildEnv(origin: ConfigOrigin, task: JsonObject, folders: readonly vscode.WorkspaceFolder[]): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  const terminal = vscode.workspace.getConfiguration('terminal.integrated', origin.folder?.uri)
    .get<Record<string, string | null>>('env.windows', {});
  // 每层基于上一层解析，因此 PATH=${env:PATH} 正确引用继承值，而不是递归引用自身。
  for (const layer of [terminal, task.options?.env ?? {}]) {
    const resolve = makeResolver(origin, { ...env }, folders);
    for (const [name, value] of Object.entries(layer)) {
      if (value === null) {
        throw new Error(t("环境变量 {0} 使用 null 删除；稳定的 ProcessExecution API 无法无损表达此删除，请使用原始任务。", name));
      }
      else if (typeof value === 'string') { envSet(env, name, resolve(value)); }
      else { throw new Error(t("任务环境变量 {0} 必须是字符串或 null。", name)); }
    }
  }
  return env;
}

export async function loadCatalogue(log: (message: string) => void): Promise<WorkspaceCatalogue> {
  const catalogue: WorkspaceCatalogue = { configurations: [], entries: [], launches: [], issues: [] };
  const folders = vscode.workspace.workspaceFolders ?? [];
  const sources: Array<{ origin: ConfigOrigin; kind: 'workspace' | 'tasks' | 'launch'; optional: boolean }> = [];
  const workspaceFile = vscode.workspace.workspaceFile;
  if (workspaceFile?.scheme === 'file') {
    sources.push({ origin: { key: `workspace:${workspaceFile.toString()}`, uri: workspaceFile,
      label: pathApi(workspaceFile.fsPath).basename(workspaceFile.fsPath), baseDirectory: pathApi(workspaceFile.fsPath).dirname(workspaceFile.fsPath) },
      kind: 'workspace', optional: false });
  }
  for (const folder of folders) {
    for (const kind of ['tasks', 'launch'] as const) {
      const uri = vscode.Uri.joinPath(folder.uri, '.vscode', `${kind}.json`);
      sources.push({ origin: { key: `folder:${folder.uri.toString()}`, uri, folder,
        label: folder.name, baseDirectory: folder.uri.fsPath }, kind, optional: true });
    }
  }
  const nativeTasksPromise = vscode.tasks.fetchTasks().then(tasks => tasks, error => {
    catalogue.issues.push(t("VS Code 任务发现失败：{0}", String(error)));
    return [] as vscode.Task[];
  });
  const documents = await Promise.all(sources.map(async source => {
    try { return { source, document: await readJson(source.origin.uri, source.optional) }; }
    catch (error) { catalogue.issues.push(String(error)); return { source, document: undefined }; }
  }));
  const nativeTasks = await nativeTasksPromise;
  for (const { source, document } of documents) {
    if (!document) { continue; }
    const origin = source.origin;
    const taskRoot = source.kind === 'workspace' ? document.tasks : source.kind === 'tasks' ? document : undefined;
    if (Array.isArray(taskRoot?.tasks)) {
      const labels = new Set<string>();
      for (const raw of taskRoot.tasks) {
        if (!raw || typeof raw !== 'object') { continue; }
        try {
          const native = nativeFor(origin, raw.label, nativeTasks);
          const merged = mergeTaskConfig(taskRoot, raw, native?.execution);
          // 仅解析明确的 UE 批处理入口。普通npm、脚本等不因变量而出现无关警告。
          const command = typeof merged.command === 'string' ? merged.command : merged.command?.value;
          if (typeof command !== 'string' || !/(?:^|[\\/])(?:Build|Clean)\.bat["']?$/i.test(command)) { continue; }
          const env = buildEnv(origin, merged, folders);
          const resolve = makeResolver(origin, env, folders);
          const spec = inspectUeTask(merged, { cwd: origin.baseDirectory, resolve, scopeKey: origin.key });
          if (!spec) { continue; }
          if (labels.has(spec.label)) { throw new Error(t("同一来源存在重复任务名称：{0}", spec.label)); }
          labels.add(spec.label);
          catalogue.entries.push({ id: `${origin.key}|${spec.label}`, origin, raw: merged, spec,
            native, env, resolve });
        } catch (error) { catalogue.issues.push(`${origin.label} / ${String(raw.label ?? raw.taskName ?? t("任务"))}：${String(error)}`); }
      }
    }
    const launchRoot = source.kind === 'workspace' ? document.launch : source.kind === 'launch' ? document : undefined;
    if (Array.isArray(launchRoot?.configurations)) {
      for (const config of launchRoot.configurations) {
        if (!config || typeof config !== 'object' || typeof config.name !== 'string' || !config.type) { continue; }
        catalogue.launches.push({ id: `${origin.key}|${config.name}`, origin, config });
      }
    }
  }
  const configurations = new Map<string, BuildConfiguration>();
  for (const entry of catalogue.entries) {
    const spec = entry.spec;
    const id = `${entry.origin.key}|${spec.configKey}`;
    let config = configurations.get(id);
    if (!config) {
      const kind = /Editor$/i.test(spec.target) ? 'Editor' : /Client$/i.test(spec.target) ? 'Client'
        : /Server$/i.test(spec.target) ? 'Server' : 'Game';
      config = { id, title: `${spec.configuration} ${kind}`, target: spec.target, platform: spec.platform,
        configuration: spec.configuration, projectPath: spec.projectPath,
        projectName: path.win32.basename(spec.projectPath, '.uproject'), origin: entry.origin, tasks: {} };
      configurations.set(id, config);
    }
    if (config.tasks[spec.action]) {
      catalogue.issues.push(t("{0} 存在重复 {1} 任务，保留首个：{2}", config.title, spec.action, config.tasks[spec.action]!.spec.label));
      continue;
    }
    config.tasks[spec.action] = entry;
  }
  catalogue.configurations = [...configurations.values()].filter(config => config.tasks.Build)
    .sort((left, right) => {
      const rank = (config: BuildConfiguration) => config.title === 'Development Editor' ? 0
        : config.title === 'DebugGame Editor' ? 1 : /Editor$/.test(config.title) ? 2 : 3;
      return rank(left) - rank(right) || left.projectName.localeCompare(right.projectName) || left.title.localeCompare(right.title);
    });
  for (const issue of catalogue.issues) { log(issue); }
  log(t("发现 {0} 个受支持的 UE 任务、{1} 个构建配置、{2} 个调试配置。", catalogue.entries.length, catalogue.configurations.length, catalogue.launches.length));
  return catalogue;
}

/** 根据 preLaunchTask 的明确名称和作用域映射，不根据“看起来相似”的 launch 名字猜测。 */
export function matchingLaunches(config: BuildConfiguration, launches: LaunchEntry[]): LaunchEntry[] {
  const label = config.tasks.Build?.spec.label;
  return launches.filter(launch => launch.origin.key === config.origin.key && launchPreLaunchTask(launch.config) === label);
}

/** 平台覆盖由调试器稍后应用；匹配预构建时必须先考虑 Windows 的有效值。 */
export function launchPreLaunchTask(config: vscode.DebugConfiguration): unknown {
  return config.windows && Object.prototype.hasOwnProperty.call(config.windows, 'preLaunchTask')
    ? config.windows.preLaunchTask : config.preLaunchTask;
}

/** 只创建内存副本，并移除已经执行过的预构建，避免 Windows 覆盖再次运行批处理。 */
export function withoutPreLaunchTask(config: vscode.DebugConfiguration): vscode.DebugConfiguration {
  const copied = structuredClone(config);
  delete copied.preLaunchTask;
  if (copied.windows) { delete copied.windows.preLaunchTask; }
  return copied;
}

export function nativePresentation(raw: JsonObject): vscode.TaskPresentationOptions {
  const value = raw.presentation ?? {};
  const result: vscode.TaskPresentationOptions = {};
  const reveal: Record<string, vscode.TaskRevealKind> = { always: vscode.TaskRevealKind.Always, silent: vscode.TaskRevealKind.Silent, never: vscode.TaskRevealKind.Never };
  const panel: Record<string, vscode.TaskPanelKind> = { shared: vscode.TaskPanelKind.Shared, dedicated: vscode.TaskPanelKind.Dedicated, new: vscode.TaskPanelKind.New };
  if (value.reveal in reveal) { result.reveal = reveal[value.reveal]; }
  if (value.panel in panel) { result.panel = panel[value.panel]; }
  for (const key of ['clear', 'echo', 'focus', 'showReuseMessage', 'close'] as const) {
    if (typeof value[key] === 'boolean') { result[key] = value[key]; }
  }
  return result;
}
