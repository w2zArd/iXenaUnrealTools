import { t } from './i18n';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { StringDecoder } from 'node:string_decoder';
import { pathApi, pathKey } from './engineSupport';

export const BRIDGE_PROTOCOL = 1;
export const BRIDGE_VERSION = '0.6.2';
// Both releases use protocol 1 and the same request/metric capabilities. Keep
// explicit compatibility with an already-loaded 0.5.0 instance during upgrades.
const COMPATIBLE_BRIDGE_VERSIONS = new Set(['0.5.0', '0.6.0', '0.6.1', BRIDGE_VERSION]);
const INSTANCE_ID = /^[1-9]\d*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_DESCRIPTOR_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_LOG_BYTES = 4 * 1024 * 1024 + 4096;
const pendingInstances = new Set<string>();

/** 与 UE Editor 中的 iXenaUnrealBridge 对应；token 仅用于本机实例关联，不能写入日志。 */
export interface BridgeInstance {
  protocol: 1;
  pluginVersion: string;
  instanceId: string;
  token: string;
  processId: number;
  projectPath: string;
  engineRoot: string;
  engineVersion: string;
  platform?: string;
  startedAt: string;
  updatedAt: string;
  status: 'ready' | 'compiling';
  liveCodingAvailable: boolean;
  liveCodingEnabled: boolean;
  directory: string;
  stale: boolean;
}

export type BridgeCompileStatus = 'Success' | 'NoChanges' | 'Failure' | 'NotEnabled' |
  'NotAvailable' | 'CompileStillActive' | 'NotStarted' | 'Cancelled' | 'Unknown' | 'Ready' | 'InvalidRequest' | 'Expired' |
  'ConsoleList' | 'Executed' | 'NotHandled';
export interface BridgeConsoleItem { name: string; help: string; type: 'command' | 'variable'; value?: string; flags: number; }
export interface BridgeConsoleListData { items: BridgeConsoleItem[]; total: number; nextCursor?: number; }
export type BridgeCommand = 'ping' | 'compile' | 'listConsole' | 'executeConsole';
export interface ConsoleListParameters { filter: string; cursor: number; limit: number; locale?: 'zh-CN' | 'en'; }
export interface ConsoleExecuteParameters { command: string; }
export interface BridgeResponse {
  protocol: 1;
  id: string;
  instanceId: string;
  ok: boolean;
  status: BridgeCompileStatus;
  output: string;
  message: string;
  completedAt: string;
  data?: BridgeConsoleListData;
}
export interface BridgeRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 测试/慢速文件系统可调整；生产默认 100 毫秒。 */
  pollIntervalMs?: number;
  /** 实时 UTF-8 编译日志；最终尚未推送的尾部也经此回调交付，response.output 保留完整日志用于归档。 */
  onOutput?: (chunk: string) => void;
  /** 仅控制台操作带参数；编译和 ping 不接受参数。 */
  parameters?: ConsoleListParameters | ConsoleExecuteParameters;
}

/** 已被 UE 领取的请求发生超时不等于编译取消，调用方不得自动重发或回退 UBT。 */
export class BridgeTimeoutError extends Error {
  constructor(message: string, readonly outcomeUnknown: boolean) {
    super(message); this.name = 'BridgeTimeoutError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function boundedJson(file: string, maxBytes: number): Promise<unknown> {
  const entry = await fs.lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > maxBytes) { throw new Error(t("通讯文件类型或大小无效。")); }
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) { throw new Error(t("通讯文件超过大小限制。")); }
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, ''));
  } finally { await handle.close(); }
}

function validateProjectPath(projectPath: string): void {
  if (typeof projectPath !== 'string' || !pathApi(projectPath).isAbsolute(projectPath) || !/\.uproject$/i.test(projectPath)) {
    throw new Error(t("插件通讯需要有效的 .uproject 绝对路径。"));
  }
}

/** 不接受描述文件自带的目录路径；路径全部由当前项目及受限实例名派生。 */
export function parseBridgeDescriptor(value: unknown, directory: string, projectPath: string, engineRoot: string, now = Date.now()): BridgeInstance {
  const p = pathApi(directory);
  if (!record(value) || value.protocol !== BRIDGE_PROTOCOL || typeof value.instanceId !== 'string' ||
      !INSTANCE_ID.test(value.instanceId) || p.basename(directory) !== value.instanceId ||
      typeof value.token !== 'string' || !/^[0-9a-f]{64}$/.test(value.token) ||
      !Number.isSafeInteger(value.processId) || Number(value.processId) < 1 ||
      !value.instanceId.startsWith(`${value.processId}-`) ||
      typeof value.projectPath !== 'string' || pathKey(value.projectPath) !== pathKey(projectPath) ||
      typeof value.engineRoot !== 'string' || pathKey(value.engineRoot) !== pathKey(engineRoot) ||
      typeof value.pluginVersion !== 'string' || !COMPATIBLE_BRIDGE_VERSIONS.has(value.pluginVersion) ||
      typeof value.engineVersion !== 'string' || typeof value.startedAt !== 'string' ||
      typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt)) ||
      !Number.isFinite(Date.parse(value.updatedAt)) || Date.parse(value.updatedAt) > now + 30_000 ||
      (value.status !== 'ready' && value.status !== 'compiling') ||
      typeof value.liveCodingAvailable !== 'boolean' || typeof value.liveCodingEnabled !== 'boolean') {
    throw new Error(t("UE 通讯实例的版本、身份或项目/引擎路径不匹配。"));
  }
  return {
    protocol: BRIDGE_PROTOCOL, pluginVersion: value.pluginVersion, instanceId: value.instanceId,
    token: value.token, processId: Number(value.processId), projectPath: value.projectPath,
    engineRoot: value.engineRoot, engineVersion: value.engineVersion,
    platform: typeof value.platform === 'string' ? value.platform : undefined,
    startedAt: value.startedAt, updatedAt: value.updatedAt, status: value.status,
    liveCodingAvailable: value.liveCodingAvailable, liveCodingEnabled: value.liveCodingEnabled,
    directory, stale: now - Date.parse(value.updatedAt) > 15_000
  };
}

async function realDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) { throw new Error(t("UE 通讯目录不是普通目录。")); }
}

/** Discovery keeps rejected descriptor counts visible for diagnosis; token and request contents are never logged. */
export interface BridgeDiscoveryReport {
  instances: BridgeInstance[];
  rejected: { instance: string; reason: 'project' | 'engine' | 'version' | 'invalid' }[];
  stale: number;
}

export async function inspectEditorBridges(projectPath: string, engineRoot: string): Promise<BridgeDiscoveryReport> {
  validateProjectPath(projectPath);
  const p = pathApi(projectPath);
  const root = p.join(p.dirname(projectPath), 'Saved', 'iXenaUnrealBridge', 'instances');
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const report: BridgeDiscoveryReport = { instances: [], rejected: [], stale: 0 };
  for (const entry of entries.slice(0, 128)) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !INSTANCE_ID.test(entry.name)) continue;
    const directory = p.join(root, entry.name);
    try {
      await realDirectory(directory);
      const value = await boundedJson(p.join(directory, 'instance.json'), MAX_DESCRIPTOR_BYTES);
      report.instances.push(parseBridgeDescriptor(value, directory, projectPath, engineRoot));
    } catch {
      // Do not include identity tokens, descriptor contents, or arbitrary parse exceptions.
      let reason: BridgeDiscoveryReport['rejected'][number]['reason'] = 'invalid';
      try {
        const value = await boundedJson(p.join(directory, 'instance.json'), MAX_DESCRIPTOR_BYTES);
        if (record(value)) {
          if (typeof value.projectPath === 'string' && pathKey(value.projectPath) !== pathKey(projectPath)) reason = 'project';
          else if (typeof value.engineRoot === 'string' && pathKey(value.engineRoot) !== pathKey(engineRoot)) reason = 'engine';
          else if (value.pluginVersion !== undefined && !COMPATIBLE_BRIDGE_VERSIONS.has(String(value.pluginVersion))) reason = 'version';
        }
      } catch { /* Missing, incomplete or unreadable descriptors remain invalid. */ }
      report.rejected.push({ instance: entry.name, reason });
    }
  }
  report.instances.sort((a, b) => Number(a.stale) - Number(b.stale) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  report.stale = report.instances.filter(item => item.stale).length;
  return report;
}

export async function discoverEditorBridges(projectPath: string, engineRoot: string): Promise<BridgeInstance[]> {
  return (await inspectEditorBridges(projectPath, engineRoot)).instances;
}

export function parseBridgeResponse(value: unknown, requestId: string, instanceId: string): BridgeResponse {
  const statuses: BridgeCompileStatus[] = ['Success', 'NoChanges', 'Failure', 'NotEnabled', 'NotAvailable',
    'CompileStillActive', 'NotStarted', 'Cancelled', 'Unknown', 'Ready', 'InvalidRequest', 'Expired',
    'ConsoleList', 'Executed', 'NotHandled'];
  if (!record(value) || value.protocol !== BRIDGE_PROTOCOL || value.id !== requestId || value.instanceId !== instanceId ||
      typeof value.ok !== 'boolean' || typeof value.status !== 'string' || !statuses.includes(value.status as BridgeCompileStatus) ||
      typeof value.output !== 'string' || typeof value.message !== 'string' || typeof value.completedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.completedAt))) { throw new Error(t("UE 通讯返回了不匹配或无效的响应。")); }
  if (value.ok !== ['Ready', 'Success', 'NoChanges', 'ConsoleList', 'Executed'].includes(value.status)) {
    throw new Error(t("UE 通讯响应的成功标志与编译结果不一致。"));
  }
  if (value.status === 'ConsoleList') {
    const data = value.data;
    if (!record(data) || !Array.isArray(data.items) || data.items.length > 100 || !Number.isSafeInteger(data.total) || Number(data.total) < 0 ||
        (data.nextCursor !== undefined && (!Number.isSafeInteger(data.nextCursor) || Number(data.nextCursor) < 1 || Number(data.nextCursor) > Number(data.total)))) {
      throw new Error(t("UE 返回的控制台目录无效。"));
    }
    for (const item of data.items) {
      if (!record(item) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 512 || /[\r\n\0;|]/.test(item.name) ||
          typeof item.help !== 'string' || item.help.length > 65536 || (item.type !== 'command' && item.type !== 'variable') ||
          (item.value !== undefined && typeof item.value !== 'string') || !Number.isSafeInteger(item.flags)) {
        throw new Error(t("UE 返回的控制台条目无效。"));
      }
    }
  }
  return value as unknown as BridgeResponse;
}

export function validateBridgeParameters(command: BridgeCommand, parameters: BridgeRequestOptions['parameters']): void {
  if (command === 'ping' || command === 'compile') {
    if (parameters !== undefined) { throw new Error(t("编译和 ping 不接受额外参数。")); }
    return;
  }
  if (!record(parameters)) { throw new Error(t("控制台操作缺少参数。")); }
  if (command === 'listConsole') {
    if (typeof parameters.filter !== 'string' || parameters.filter.length > 256 || /[\r\n\0]/.test(parameters.filter) ||
        (parameters.locale !== undefined && parameters.locale !== 'en' && parameters.locale !== 'zh-CN') ||
        !Number.isSafeInteger(parameters.cursor) || Number(parameters.cursor) < 0 ||
        !Number.isInteger(parameters.limit) || Number(parameters.limit) < 1 || Number(parameters.limit) > 100) {
      throw new Error(t("控制台搜索参数无效。"));
    }
  } else if (command === 'executeConsole') {
    if (typeof parameters.command !== 'string' || !parameters.command.trim() || parameters.command.length > 4096 ||
        /[\r\n\0;|]/.test(parameters.command)) { throw new Error(t("仅支持一条不含换行、分号或管道的 UE 控制台命令。")); }
  } else { throw new Error(t("不支持的 UE 通讯命令。")); }
}

export async function sendBridgeCommand(instance: BridgeInstance, command: BridgeCommand, options: BridgeRequestOptions = {}): Promise<BridgeResponse> {
  if (!['ping', 'compile', 'listConsole', 'executeConsole'].includes(command)) { throw new Error(t("不支持的 UE 通讯命令。")); }
  validateBridgeParameters(command, options.parameters);
  const timeoutMs = options.timeoutMs ?? (command === 'compile' ? 900_000 : command === 'executeConsole' ? 30_000 : 5000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 3_600_000) { throw new Error(t("UE 通讯超时设置无效。")); }
  if (options.signal?.aborted) { throw new BridgeTimeoutError(t("已取消尚未发送的 UE 通讯请求。"), false); }
  const p = pathApi(instance.directory);
  const current = parseBridgeDescriptor(await boundedJson(p.join(instance.directory, 'instance.json'), MAX_DESCRIPTOR_BYTES),
    instance.directory, instance.projectPath, instance.engineRoot);
  if (current.instanceId !== instance.instanceId || current.token !== instance.token) { throw new Error(t("UE 通讯实例已更换，请重新连接。")); }
  if (command === 'compile' && current.stale) { throw new Error(t("UE 通讯心跳已过期，请先检查连接；不会自动触发编译。")); }
  if (command !== 'ping' && current.status === 'compiling') { throw new Error(t("UE Editor 已在编译，请等待本次编译结束。")); }
  const key = pathKey(instance.directory);
  if (pendingInstances.has(key)) { throw new Error(t("此 UE 实例已有通讯请求正在进行。")); }
  pendingInstances.add(key);
  const id = randomUUID();
  const requests = p.join(instance.directory, 'Requests');
  const responses = p.join(instance.directory, 'Responses');
  const requestPath = p.join(requests, `${id}.json`);
  const tempPath = p.join(requests, `${id}.tmp`);
  const responsePath = p.join(responses, `${id}.json`);
  const logPath = p.join(instance.directory, 'Logs', `${id}.log`);
  const decoder = new StringDecoder('utf8');
  let logPosition = 0;
  let streamedText = '';
  const emit = (chunk: string): void => { if (chunk) { streamedText += chunk; options.onOutput?.(chunk); } };
  const readLogs = async (): Promise<void> => {
    if (!options.onOutput || logPosition >= MAX_LOG_BYTES) { return; }
    const file = await fs.lstat(logPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') { return undefined; } throw error;
    });
    if (!file) { return; }
    if (!file.isFile() || file.isSymbolicLink()) { throw new Error(t("UE 日志文件类型无效。")); }
    const count = Math.min(file.size - logPosition, MAX_LOG_BYTES - logPosition, 256 * 1024);
    if (count <= 0) { return; }
    const handle = await fs.open(logPath, 'r');
    try {
      const buffer = Buffer.alloc(count);
      const { bytesRead } = await handle.read(buffer, 0, count, logPosition);
      logPosition += bytesRead; emit(decoder.write(buffer.subarray(0, bytesRead)));
    } finally { await handle.close(); }
  };
  let published = false;
  try {
    await realDirectory(instance.directory);
    await realDirectory(requests); await realDirectory(responses);
    await fs.writeFile(tempPath, JSON.stringify({ protocol: BRIDGE_PROTOCOL, id, instanceId: current.instanceId,
      token: current.token, command, createdAt: new Date().toISOString(),
      ...(options.parameters ? { parameters: options.parameters } : {}) }), { flag: 'wx', mode: 0o600 });
    if (options.signal?.aborted) { throw new BridgeTimeoutError(t("已取消尚未发送的 UE 通讯请求。"), false); }
    await fs.rename(tempPath, requestPath); published = true;
    const deadline = Date.now() + timeoutMs;
    const interval = Math.max(10, Math.min(options.pollIntervalMs ?? 100, 1000));
    while (Date.now() < deadline && !options.signal?.aborted) {
      await readLogs();
      try {
        const response = parseBridgeResponse(await boundedJson(responsePath, MAX_RESPONSE_BYTES), id, current.instanceId);
        if (options.onOutput) {
          // 结果已落盘时日志文件也已 Flush；继续读完，避免最终一批输出丢失。
          let prior = -1;
          while (prior !== logPosition && logPosition < MAX_LOG_BYTES) { prior = logPosition; await readLogs(); }
          emit(decoder.end());
          if (response.output.startsWith(streamedText)) { emit(response.output.slice(streamedText.length)); }
          else if (!streamedText) { emit(response.output); }
        }
        await fs.unlink(responsePath).catch(() => undefined);
        return response;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
      }
      await delay(Math.min(interval, Math.max(1, deadline - Date.now())));
    }
    // UE 先把请求移入 Processing 再执行；成功删除队列文件才可确认它尚未被领取。
    let outcomeUnknown = true;
    try { await fs.unlink(requestPath); outcomeUnknown = false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
    throw new BridgeTimeoutError(outcomeUnknown
      ? command === 'compile'
        ? t("等待 UE 响应已超时或取消。请求已被领取，UE 编译可能仍在继续；请查看 UE Live Coding 日志，不要立即重复编译。")
        : t("等待 UE 响应已超时或取消。请求已被领取，UE 可能仍在处理；请检查编辑器和日志，不要立即重复发送操作。")
      : t("UE 未及时领取请求，已移除本次待处理请求。请检查插件是否加载、编辑器是否忙碌。"), outcomeUnknown);
  } finally {
    pendingInstances.delete(key);
    await fs.unlink(tempPath).catch(() => undefined);
    // 仅清理由此调用创建且仍未被 UE 领取的请求；不删除正在处理的远端操作。
    if (published) { await fs.unlink(requestPath).catch(() => undefined); }
  }
}
