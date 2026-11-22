import { getLanguage, t } from './i18n';
import { localizedConsoleHelp } from './consoleHelp';
import * as vscode from 'vscode';
import { BridgeConsoleItem, BridgeConsoleListData, BridgeInstance, sendBridgeCommand } from './editorBridge';

interface ConsolePreset { command: string; description: string; type: 'command' | 'variable'; }
interface ConsoleChoice extends vscode.QuickPickItem {
  action: 'preset' | 'search' | 'custom' | 'item' | 'next' | 'back' | 'send' | 'cancel';
  preset?: ConsolePreset;
  item?: BridgeConsoleItem;
}
export const CONSOLE_PRESETS: readonly ConsolePreset[] = [
  { command: 'stat fps', description: '切换帧率统计显示', type: 'command' },
  { command: 'stat unit', description: '切换帧 / Game / Draw / GPU 时间统计', type: 'command' },
  { command: 'stat unitgraph', description: '切换帧时间曲线', type: 'command' },
  { command: 'stat memory', description: '切换内存统计', type: 'command' },
  { command: 'show collision', description: '切换碰撞体显示', type: 'command' },
  { command: 't.MaxFPS', description: '读取或修改帧率上限', type: 'variable' },
  { command: 'r.VSync', description: '读取或修改垂直同步', type: 'variable' },
  { command: 'r.ScreenPercentage', description: '读取或修改渲染分辨率百分比', type: 'variable' }
];
let consoleOutput: vscode.OutputChannel | undefined;
const activeInstances = new Set<string>();

function output(): vscode.OutputChannel {
  return consoleOutput ??= vscode.window.createOutputChannel('iXena Unreal · Console');
}

/** 扩展关闭时释放输出频道；输出本身在每次发送后保留。 */
export function disposeUnrealConsole(): void { consoleOutput?.dispose(); consoleOutput = undefined; }

export function validateConsoleCommand(value: string): string | undefined {
  if (!value.trim()) { return t("请输入 UE 控制台命令。"); }
  if (value.length > 4096) { return t("命令不能超过 4096 个字符。"); }
  if (/[\r\n\0;|]/.test(value)) { return t("只支持一条命令；不能包含换行、分号、管道或 NUL。"); }
  return undefined;
}

/** 已知会退出、切图或执行脚本的命令，额外进行一次明确确认；普通设置也有完整命令预览。 */
export function consoleCommandNeedsConfirmation(value: string): boolean {
  return /^(?:(?:quit|exit|restart|restartlevel|load|open|map|travel|servertravel|disconnect|reconnect|exec|py|python|ce|ke|debug)\b|obj\s+(?:garbage|gc)\b|gc\b|(?:crash|fatal|assert)\b)/i.test(value.trim());
}

async function consolePage(instance: BridgeInstance, filter: string, cursor: number): Promise<BridgeConsoleListData> {
  const response = await sendBridgeCommand(instance, 'listConsole', { parameters: { filter, cursor, limit: 100, locale: getLanguage() }, timeoutMs: 8000 });
  if (!response.ok || response.status !== 'ConsoleList' || !response.data) {
    throw new Error(response.message || t("UE 未返回已注册控制台命令列表。"));
  }
  return response.data;
}

async function chooseRegistered(instance: BridgeInstance): Promise<BridgeConsoleItem | undefined> {
  let filter = await vscode.window.showInputBox({ title: t("搜索 UE 已注册的命令 / CVar"),
    prompt: t("按 UE 当前运行实例查询；输入名称片段，例如 r.、nanite、shadow。留空分页浏览。"),
    placeHolder: t("每次确认查询一次，不会随每次键入发送请求"),
    validateInput: value => value.length > 256 || /[\r\n\0]/.test(value) ? t("搜索文本最多 256 字，不能含换行。") : undefined });
  if (filter === undefined) { return undefined; }
  let cursor = 0;
  while (true) {
    const page = await consolePage(instance, filter, cursor);
    const choices: ConsoleChoice[] = page.items.map(item => ({
      label: `${item.type === 'variable' ? '$(symbol-variable)' : '$(terminal)'} ${item.name}`,
      description: item.type === 'variable' ? t("当前值：{0}", item.value ?? t("未知")) : t("命令"),
      detail: localizedConsoleHelp(item.name, item.help).slice(0, 1200), action: 'item', item
    }));
    if (page.nextCursor !== undefined) {
      if (page.nextCursor <= cursor) { throw new Error(t("UE 返回了不能前进的控制台分页位置。")); }
      choices.push({ label: t("$(chevron-right) 下一页"), description: `${Math.min(page.nextCursor, page.total)} / ${page.total}`, action: 'next' });
    }
    choices.push({ label: t("$(search) 换一个关键词搜索"), action: 'search' });
    choices.push({ label: t("$(arrow-left) 返回"), action: 'back' });
    const choice = await vscode.window.showQuickPick(choices, { title: t("UE 控制台 · {0} 个匹配 · 从 {1} 开始", page.total, cursor + 1),
      placeHolder: t("键入可筛选本页；需要从全部注册项查询时选择“换一个关键词搜索”"), matchOnDescription: true, matchOnDetail: true });
    if (!choice || choice.action === 'back') { return undefined; }
    if (choice.action === 'item') { return choice.item; }
    if (choice.action === 'next') { cursor = page.nextCursor!; continue; }
    filter = await vscode.window.showInputBox({ title: t("搜索 UE 已注册的命令 / CVar"), value: filter,
      validateInput: value => value.length > 256 || /[\r\n\0]/.test(value) ? t("搜索文本最多 256 字，不能含换行。") : undefined });
    if (filter === undefined) { return undefined; }
    cursor = 0;
  }
}

async function commandForItem(item: BridgeConsoleItem): Promise<string | undefined> {
  const channel = output();
  channel.appendLine(t("\n[帮助] {0} · {1} · flags=0x{2}", item.name, item.type, item.flags.toString(16)));
  channel.appendLine(localizedConsoleHelp(item.name, item.help) || t("UE 没有为此条目提供帮助文本。"));
  if (item.type === 'variable') { channel.appendLine(t("[当前值] {0}", item.value ?? t("未知"))); }
  const detail = localizedConsoleHelp(item.name, item.help).replace(/\s+/g, ' ').slice(0, 350);
  if (item.type === 'variable') {
    const value = await vscode.window.showInputBox({ title: `UE CVar · ${item.name}`,
      value: item.value ?? '', prompt: t("当前值：{0}。留空只查询；输入值后预览发送。{1}", item.value ?? t("未知"), detail),
      validateInput: text => /[\r\n\0;|]/.test(text) || text.length > 3500 ? t("值不能含多条命令分隔符，长度不能超过 3500。") : undefined });
    if (value === undefined) { return undefined; }
    return value.trim() ? `${item.name} ${value.trim()}` : item.name;
  }
  const parameters = await vscode.window.showInputBox({ title: t("UE 命令参数 · {0}", item.name),
    prompt: t("可留空。{0}", detail || t("此命令未提供帮助，发送前请确认参数。")),
    validateInput: text => /[\r\n\0;|]/.test(text) || text.length > 3500 ? t("参数必须是单行，不能包含分号或管道。") : undefined });
  if (parameters === undefined) { return undefined; }
  return parameters.trim() ? `${item.name} ${parameters.trim()}` : item.name;
}

async function chooseCommand(instance: BridgeInstance): Promise<string | undefined> {
  const choices: ConsoleChoice[] = [
    { label: t("$(search) 搜索 UE 已注册命令 / CVar"), description: t("从当前 Editor 读取名称、帮助与变量值"), action: 'search' },
    ...CONSOLE_PRESETS.map(preset => ({ label: `$(terminal) ${preset.command}`, description: t(preset.description),
      action: 'preset' as const, preset })),
    { label: t("$(edit) 输入自定义控制台命令"), description: t("单条命令；不会通过系统 Shell 执行"), action: 'custom' }
  ];
  const selected = await vscode.window.showQuickPick(choices, { title: t("UE 控制台 · PID {0}", instance.processId),
    placeHolder: t("选择常用命令，或搜索当前 UE 注册的命令与变量"), matchOnDescription: true });
  if (!selected) { return undefined; }
  if (selected.action === 'custom') {
    return vscode.window.showInputBox({ title: t("UE 控制台 · 单条自定义命令"),
      prompt: t("下一步会显示完整命令供你确认；执行目标为当前选中的 UE Editor。"), validateInput: validateConsoleCommand });
  }
  if (selected.action === 'search') {
    const item = await chooseRegistered(instance); return item ? commandForItem(item) : undefined;
  }
  const preset = selected.preset!;
  if (preset.type === 'command') { return preset.command; }
  // 常用 CVar 仍向当前实例查询，绝不捏造当前值或假定所有 UE 版本都注册了它。
  const page = await consolePage(instance, preset.command, 0);
  const actual = page.items.find(item => item.name.toLowerCase() === preset.command.toLowerCase() && item.type === 'variable');
  if (!actual) {
    await vscode.window.showWarningMessage(t("当前 UE 实例没有返回 {0}，本次不会发送修改。", preset.command)); return undefined;
  }
  return commandForItem(actual);
}

/** 控制台 UI 始终走已验证的 UE 桥实例，与 Live Coding 选择 MCP 还是插件无关。 */
export async function showUnrealConsole(instance: BridgeInstance): Promise<void> {
  if (activeInstances.has(instance.instanceId)) { throw new Error(t("此 UE 实例已有控制台面板正在操作。")); }
  activeInstances.add(instance.instanceId);
  try {
    const command = (await chooseCommand(instance))?.trim();
    if (command === undefined) { return; }
    const error = validateConsoleCommand(command); if (error) { throw new Error(error); }
    const review = await vscode.window.showQuickPick<ConsoleChoice>([
      { label: t("$(send) 发送到 UE"), description: command, detail: `${instance.projectPath} · PID ${instance.processId}`, action: 'send' },
      { label: t("取消"), action: 'cancel' }
    ], { title: t("确认 UE 控制台命令"), placeHolder: command, ignoreFocusOut: true });
    if (review?.action !== 'send') { return; }
    if (consoleCommandNeedsConfirmation(command)) {
      const confirm = await vscode.window.showWarningMessage(t("即将向 UE 发送：{0}", command), {
        modal: true, detail: t("此命令可能退出编辑器、切换地图、回收对象或执行脚本。请先保存必要的工作。")
      }, t("确认发送"));
      if (confirm !== t("确认发送")) { return; }
    }
    const channel = output(); channel.show(true);
    channel.appendLine(`\n[${new Date().toLocaleTimeString()}] ${instance.projectPath} · PID ${instance.processId}`);
    channel.appendLine(`> ${command}`);
    try {
      const response = await sendBridgeCommand(instance, 'executeConsole', { parameters: { command }, timeoutMs: 30_000,
        onOutput: chunk => channel.append(chunk) });
      channel.appendLine(`\n[${response.status}] ${response.message}`);
      if (response.ok && response.status === 'Executed') {
        await vscode.window.showInformationMessage(t("UE 已接受控制台命令；输出已保留。异步操作是否完成请查看 UE 状态。"));
      } else { await vscode.window.showWarningMessage(t("UE 未处理此命令（{0}）。请查看 iXena Unreal · Console 输出。", response.status)); }
    } catch (error) { channel.appendLine(t("[通讯异常] {0}", error instanceof Error ? error.message : String(error))); throw error; }
  } finally { activeInstances.delete(instance.instanceId); }
}
