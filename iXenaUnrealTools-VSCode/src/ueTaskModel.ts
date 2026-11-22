import { t } from './i18n';
import * as path from 'node:path';

/** 原生 UE 任务解析后的单个构建步骤。参数保持为 argv，不再经过 cmd.exe。 */
export interface UeTaskSpec {
  label: string;
  scopeKey: string;
  target: string;
  platform: string;
  configuration: string;
  action: 'Build' | 'Rebuild' | 'Clean';
  projectPath: string;
  engineRoot: string;
  cwd: string;
  args: string[];
  dependencies: string[];
  problemMatchers: string[];
  configKey: string;
}

export interface InspectContext {
  cwd: string;
  resolve: (value: string) => string;
  scopeKey: string;
}

const windows = path.win32;
const knownConfiguration = /^(Debug|DebugGame|Development|Test|Shipping)$/i;
const batchSuffix = /(?:^|[\\/])Engine[\\/]Build[\\/]BatchFiles[\\/](Build|Clean)\.bat$/i;

function unquote(value: string): string {
  if (typeof value !== 'string') { throw new Error(t("任务包含未定义的命令行参数，无法安全执行 UBT。")); }
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value === 'string') { return value; }
  if (value && typeof value === 'object' && 'value' in value && typeof value.value === 'string') {
    return value.value;
  }
  throw new Error(t("{0} 必须是字符串或 ShellQuotedString，无法安全转换此任务。", field));
}

/** 已解析的任务不允许继续含有需要 shell 或交互输入才能解释的占位符。 */
function resolved(value: unknown, field: string, context: InspectContext): string {
  const result = unquote(context.resolve(stringValue(value, field)));
  if (/\$\{[^}]*\}|\$env:|%[^%\r\n]+%/i.test(result)) {
    throw new Error(t("{0} 仍包含未解析变量，请使用原生任务或配置可解析的路径。", field));
  }
  if (/[\r\n\0]/.test(result)) {
    throw new Error(t("{0} 包含换行或空字符，无法安全转换此任务。", field));
  }
  return result;
}

function fullyQualified(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(value);
}

function parseMatchers(raw: unknown): string[] {
  if (raw === undefined) { return ['$msCompile']; }
  const values = Array.isArray(raw) ? raw : [raw];
  if (values.some(value => typeof value !== 'string' || !value.startsWith('$'))) {
    throw new Error(t("此任务使用内联或无效 problemMatcher；请保留原生任务执行，避免丢失编译诊断。"));
  }
  return [...values] as string[];
}

function parseDependencies(raw: unknown): string[] {
  if (raw === undefined) { return []; }
  const values = Array.isArray(raw) ? raw : [raw];
  if (values.some(value => typeof value !== 'string' || !value.trim())) {
    throw new Error(t("此任务使用复杂 dependsOn 定义；请使用原生任务执行。"));
  }
  return [...values] as string[];
}

/**
 * 只识别 UE 生成的 Build.bat / Clean.bat 路径及参数数组。
 * 不解析任意 shell 命令；无法无损转换时给出原因，而不是静默丢弃任务语义。
 */
export function inspectUeTask(raw: Record<string, any>, context: InspectContext): UeTaskSpec | undefined {
  if (raw.type !== undefined && raw.type !== 'shell' && raw.type !== 'process') { return undefined; }
  if (raw.command === undefined) { return undefined; }
  let commandText: string;
  try { commandText = unquote(stringValue(raw.command, 'command')); }
  catch { return undefined; }
  if (!batchSuffix.test(commandText)) { return undefined; }

  const label = typeof raw.label === 'string' ? raw.label : '';
  if (!label.trim()) { throw new Error(t("UE 任务缺少 label，无法关联原生任务。")); }
  if (raw.isBackground === true) {
    throw new Error(t("“{0}” 是后台任务，不能按普通编译进程转换。", label));
  }
  if (raw.options?.shell !== undefined) {
    throw new Error(t("“{0}” 自定义了 shell，无法确认启动环境；请使用原生任务。", label));
  }

  const cwd = resolved(raw.options?.cwd ?? context.cwd, 'options.cwd', context);
  const baseCwd = resolved(context.cwd, t("任务默认工作目录"), context);
  if ((!fullyQualified(cwd) && !fullyQualified(baseCwd)) || /^[a-z]:(?![\\/])/i.test(cwd)) {
    throw new Error(t("“{0}” 的工作目录必须可解析为完整 Windows 路径。", label));
  }
  const normalizedCwd = fullyQualified(cwd) ? windows.normalize(cwd) : windows.resolve(baseCwd, cwd);
  const command = resolved(raw.command, 'command', context);
  if (/^[a-z]:(?![\\/])/i.test(command)) { throw new Error(t("“{0}” 的命令不能使用盘符相对路径。", label)); }
  const commandPath = windows.resolve(normalizedCwd, command);
  const scriptMatch = batchSuffix.exec(commandPath);
  if (!scriptMatch) { throw new Error(t("“{0}” 的命令不再指向标准 UE 批处理目录。", label)); }
  let engineRoot = commandPath;
  for (let depth = 0; depth < 4; depth++) { engineRoot = windows.dirname(engineRoot); }

  if (!Array.isArray(raw.args) || raw.args.length < 4) {
    throw new Error(t("“{0}” 需要明确的目标、平台、配置和 .uproject 参数。", label));
  }
  const args = raw.args.map((value: unknown, index: number) => resolved(value, `args[${index}]`, context));
  const [target, platform, configuration] = args;
  if (!/^[a-z0-9_][a-z0-9_.-]*$/i.test(target) || !/^[a-z][a-z0-9_]*$/i.test(platform)
      || !knownConfiguration.test(configuration)) {
    throw new Error(t("“{0}” 的前三个参数不符合 UE 的目标、平台、配置格式。", label));
  }
  if (args.some(arg => /^-(?:targets?|mode)(?:=|$)/i.test(arg))) {
    throw new Error(t("“{0}” 含多目标或特殊 UBT 模式，不能按单个构建配置转换。", label));
  }
  if (args.some(arg => /^(?:[|&;]|&&|\|\||[<>].*)$/.test(arg))) {
    throw new Error(t("“{0}” 含 shell 管道或重定向，请使用原生任务执行。", label));
  }

  const projectArguments: Array<{ index: number; value: string; named: boolean }> = [];
  for (let index = 3; index < args.length; index++) {
    const arg = args[index];
    if (typeof arg !== 'string') {
      throw new Error(t("“{0}” 的 args[{1}] 未解析为字符串，已停止任务转换。", label, index));
    }
    if (/^-project$/i.test(arg)) {
      throw new Error(t("“{0}” 请使用 -Project=路径 或单独的 .uproject 路径参数。", label));
    }
    if (/^-project=/i.test(arg)) {
      projectArguments.push({ index, value: unquote(arg.slice(arg.indexOf('=') + 1)), named: true });
    } else if (!arg.startsWith('-') && /\.uproject$/i.test(arg)) {
      projectArguments.push({ index, value: arg, named: false });
    }
  }
  if (projectArguments.length !== 1 || !/\.uproject$/i.test(projectArguments[0].value)) {
    throw new Error(t("“{0}” 必须包含且只包含一个明确的 .uproject 路径。", label));
  }
  const projectArgument = projectArguments[0];
  if (/^[a-z]:(?![\\/])/i.test(projectArgument.value)) {
    throw new Error(t("“{0}” 的项目不能使用盘符相对路径。", label));
  }
  const projectPath = windows.resolve(normalizedCwd, projectArgument.value);
  args[projectArgument.index] = projectArgument.named ? `-Project=${projectPath}` : projectPath;

  const cleaning = scriptMatch[1].toLowerCase() === 'clean' || args.some(arg => /^-clean$/i.test(arg));
  const action: UeTaskSpec['action'] = cleaning ? 'Clean' : /(?:^|\s)Rebuild$/i.test(label) ? 'Rebuild' : 'Build';
  if (cleaning && !args.some(arg => /^-clean$/i.test(arg))) { args.push('-clean'); }
  const configKey = [windows.normalize(projectPath), target, platform, configuration]
    .map(part => part.toLowerCase()).join('\0');

  return {
    label, scopeKey: context.scopeKey, target, platform, configuration, action,
    projectPath, engineRoot, cwd: normalizedCwd, args,
    dependencies: parseDependencies(raw.dependsOn),
    problemMatchers: parseMatchers(raw.problemMatcher), configKey,
  };
}

/** 复用 UE 的常见重建依赖：同一作用域、同一配置的 Clean 成功后才执行 Rebuild。 */
export function validatePlan(selected: UeTaskSpec, all: UeTaskSpec[]): UeTaskSpec[] {
  if (!selected.dependencies.length) { return [selected]; }
  if (selected.action !== 'Rebuild' || selected.dependencies.length !== 1) {
    throw new Error(t("“{0}” 含自定义依赖；本版本仅转换 UE 标准的 Clean → Rebuild，请使用原生任务。", selected.label));
  }
  const matches = all.filter(candidate => candidate.scopeKey === selected.scopeKey
    && candidate.label === selected.dependencies[0]);
  if (matches.length !== 1) {
    throw new Error(t("无法在同一任务作用域内唯一找到“{0}”。", selected.dependencies[0]));
  }
  const clean = matches[0];
  if (clean.action !== 'Clean' || clean.configKey !== selected.configKey || clean.dependencies.length
      || clean.engineRoot.toLowerCase() !== selected.engineRoot.toLowerCase()) {
    throw new Error(t("“{0}” 的依赖不是同一引擎、同一配置的独立 Clean 任务，请使用原生任务。", selected.label));
  }
  return [clean, selected];
}
