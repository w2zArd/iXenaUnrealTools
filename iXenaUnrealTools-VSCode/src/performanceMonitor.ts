import { t, getLanguage, onDidChangeLanguage } from './i18n';
import { webviewLanguage, webviewLanguageAttributes } from './webviewI18n';
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { BridgeInstance } from './editorBridge';
import { pathApi, pathKey } from './engineSupport';

/** 来自 UE Editor 主线程的一秒采样；缺失能力用 undefined，不把未知数据伪装成零。 */
export interface PerformanceSample {
  protocol: 1;
  instanceId: string;
  processId: number;
  updatedAt: string;
  processMemoryBytes?: number;
  peakProcessMemoryBytes?: number;
  availablePhysicalBytes?: number;
  cpuTimePct?: number;
  cpuTimePctRelative?: number;
  frameDeltaMs?: number;
  debuggerAttached?: boolean;
}
const monitors = new Map<string, vscode.WebviewPanel>();
const MAX_BYTES = 32 * 1024;
export const PERFORMANCE_SAMPLE_LIMIT = 120;

export function parsePerformanceSample(raw: unknown, instance: Pick<BridgeInstance, 'instanceId' | 'processId'>, now = Date.now()): PerformanceSample {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { throw new Error(t("UE 运行指标不是对象。")); }
  const value = raw as Record<string, unknown>;
  if (value.protocol !== 1 || value.instanceId !== instance.instanceId || value.processId !== instance.processId ||
      !Number.isSafeInteger(value.processId) || Number(value.processId) < 1 ||
      typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)) || Date.parse(value.updatedAt) > now) {
    throw new Error(t("UE 运行指标的实例、时间戳或协议不匹配。"));
  }
  const sample: PerformanceSample = { protocol: 1, instanceId: instance.instanceId, processId: instance.processId, updatedAt: value.updatedAt };
  const limits: Record<string, number> = { processMemoryBytes: Number.MAX_SAFE_INTEGER, peakProcessMemoryBytes: Number.MAX_SAFE_INTEGER,
    availablePhysicalBytes: Number.MAX_SAFE_INTEGER, cpuTimePct: 100.01, cpuTimePctRelative: 1_000_000, frameDeltaMs: 3_600_000 };
  for (const [key, limit] of Object.entries(limits)) {
    const metric = value[key];
    if (metric === undefined || metric === null) { continue; }
    if (typeof metric !== 'number' || !Number.isFinite(metric) || metric < 0 || metric > limit ||
        (key.endsWith('Bytes') && !Number.isSafeInteger(metric))) { throw new Error(t("UE 运行指标 {0} 无效。", key)); }
    (sample as unknown as Record<string, unknown>)[key] = metric;
  }
  if (value.debuggerAttached !== undefined && value.debuggerAttached !== null) {
    if (typeof value.debuggerAttached !== 'boolean') { throw new Error(t("UE 调试器状态无效。")); }
    sample.debuggerAttached = value.debuggerAttached;
  }
  return sample;
}

export async function readPerformanceSample(instance: BridgeInstance, now?: number): Promise<PerformanceSample> {
  const p = pathApi(instance.directory);
  if (!/^[1-9]\d*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(instance.instanceId)) {
    throw new Error(t("运行监测实例标识无效。"));
  }
  // 只读取经过桥实例验证的目录下固定文件，不接受消息提供的任意路径。
  const expected = p.join(p.dirname(instance.projectPath), 'Saved', 'iXenaUnrealBridge', 'instances', instance.instanceId);
  if (pathKey(expected) !== pathKey(instance.directory)) { throw new Error(t("运行监测目录不属于当前项目实例。")); }
  const directory = await fs.lstat(instance.directory);
  if (!directory.isDirectory() || directory.isSymbolicLink()) { throw new Error(t("运行监测目录无效。")); }
  const filename = p.join(instance.directory, 'metrics.json');
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) { throw new Error(t("运行指标文件类型或大小无效。")); }
  const handle = await fs.open(filename, 'r');
  try {
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    if (result.bytesRead > MAX_BYTES) { throw new Error(t("运行指标文件超过 32 KiB。")); }
    return parsePerformanceSample(JSON.parse(buffer.subarray(0, result.bytesRead).toString('utf8').replace(/^\uFEFF/, '')), instance, now ?? Date.now());
  } finally { await handle.close(); }
}

export function isPerformanceSampleStale(sample: PerformanceSample | undefined, now = Date.now()): boolean {
  return !sample || now - Date.parse(sample.updatedAt) > 3000;
}

export function appendPerformanceSample(samples: readonly PerformanceSample[], sample: PerformanceSample): PerformanceSample[] {
  const previous = samples.at(-1);
  if (previous && Date.parse(sample.updatedAt) <= Date.parse(previous.updatedAt)) { return [...samples]; }
  return [...samples, sample].slice(-PERFORMANCE_SAMPLE_LIMIT);
}

function escapeAttribute(value: string): string { return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

export function performanceMonitorHtml(webview: vscode.Webview, resources: vscode.Uri): string {
  const nonce = randomBytes(18).toString('hex');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(resources, 'performanceMonitor.js')).toString();
  const localeScript = webview.asWebviewUri(vscode.Uri.joinPath(resources, 'webviewI18n.js')).toString();
  const css = webview.asWebviewUri(vscode.Uri.joinPath(resources, 'performanceMonitor.css')).toString();
  return `<!doctype html><html lang="${getLanguage()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escapeAttribute(webview.cspSource)}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${escapeAttribute(css)}"><title>iXena 运行监测</title></head><body ${webviewLanguageAttributes()}>
<header><div><p class="eyebrow">iXena Unreal Tools</p><h1>运行监测</h1><p id="project" class="muted">正在连接 UE 实例…</p></div><div class="actions"><button id="pause" type="button">暂停采样</button><button id="refresh" type="button">立即刷新</button><button id="insights" type="button">打开 Unreal Insights</button></div></header>
<main><section class="status-row"><span id="state" role="status">等待首个采样</span><span id="identity" class="muted"></span></section><p id="notice" class="notice" aria-live="polite">指标由 UE 插件提供。</p>
<section class="cards" aria-label="最新运行指标"><article><h2>UE 进程 CPU</h2><p id="cpu" class="value">—</p><p class="muted">按整机 CPU 容量</p><p id="cpu-relative" class="small muted">单核 100%：—</p></article><article><h2>UE 进程驻留内存</h2><p id="memory" class="value">—</p><p class="muted">RSS / 工作集 · MiB</p><p id="memory-peak" class="small muted">峰值：—</p></article><article><h2>引擎帧间隔</h2><p id="frame" class="value">—</p><p class="muted">FApp::GetDeltaTime · ms</p><p class="small muted">固定帧率时可能为模拟步长</p></article><article><h2>主机可用物理内存</h2><p id="available" class="value">—</p><p class="muted">MiB</p><p id="debugger" class="small muted">调试器：—</p></article></section>
<section class="charts"><article><div class="chart-heading"><h2>CPU 使用率</h2><span>%</span></div><canvas id="cpu-chart" aria-label="UE进程CPU使用率历史折线图" role="img"></canvas></article><article><div class="chart-heading"><h2>驻留内存</h2><span>MiB</span></div><canvas id="memory-chart" aria-label="UE进程驻留内存历史折线图" role="img"></canvas></article><article><div class="chart-heading"><h2>引擎帧间隔</h2><span>ms</span></div><canvas id="frame-chart" aria-label="引擎帧间隔历史折线图" role="img"></canvas></article></section>
<footer><span id="sample-time">尚无采样</span><span>每秒采样 · 最多保留 120 个样本 · 面板隐藏时停止读取</span><p>断点暂停、Editor 忙碌或退出会令主线程采样停止；超过 3 秒未更新时保留最后数值并标为冻结。这不是函数级 CPU 分析或内存泄漏分析；深入分析请使用 Unreal Insights。</p></footer></main>
<script nonce="${nonce}" src="${escapeAttribute(localeScript)}"></script>
<script nonce="${nonce}" src="${escapeAttribute(script)}"></script></body></html>`;
}

export async function showPerformanceMonitor(instance: BridgeInstance): Promise<void> {
  const key = pathKey(instance.directory);
  const existing = monitors.get(key);
  if (existing) { existing.reveal(vscode.ViewColumn.Beside, true); return; }
  const resources = vscode.Uri.file(path.resolve(__dirname, '..', 'resources'));
  const panel = vscode.window.createWebviewPanel('iXenaUnrealTools.performance', t("iXena 运行监测"),
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, localResourceRoots: [resources], retainContextWhenHidden: false });
  monitors.set(key, panel);
  panel.webview.html = performanceMonitorHtml(panel.webview, resources);
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposed = false, paused = false, reading = false;
  let samples: PerformanceSample[] = [];
  let error: string | undefined;
  const listeners: vscode.Disposable[] = [];
  listeners.push(onDidChangeLanguage(() => {
    panel.title = t('iXena 运行监测');
    void panel.webview.postMessage({ type: 'language', ...webviewLanguage() });
  }));
  const sendState = (): void => {
    if (!disposed && panel.visible) { void panel.webview.postMessage({ type: 'state', locale: webviewLanguage(), projectPath: instance.projectPath,
      processId: instance.processId, engineVersion: instance.engineVersion, paused, error,
      stale: isPerformanceSampleStale(samples.at(-1)), samples, now: Date.now() }); }
  };
  const sample = async (): Promise<void> => {
    if (disposed || !panel.visible || reading) { return; }
    if (paused) { sendState(); return; }
    reading = true;
    try {
      const next = await readPerformanceSample(instance);
      if (!disposed && panel.visible) { samples = appendPerformanceSample(samples, next); error = undefined; }
    } catch (caught) {
      error = (caught as NodeJS.ErrnoException).code === 'ENOENT'
        ? t("尚未收到 metrics.json：请确认通讯插件已更新并加载，或 UE 实例仍在运行。")
        : caught instanceof Error ? caught.message : String(caught);
    } finally { reading = false; sendState(); }
  };
  const updateTimer = (): void => {
    if (timer) { clearInterval(timer); timer = undefined; }
    if (!disposed && panel.visible) { timer = setInterval(() => { void sample(); }, 1000); void sample(); }
  };
  listeners.push(panel.webview.onDidReceiveMessage((message: unknown) => {
    if (!message || typeof message !== 'object') { return; }
    const type = (message as { type?: unknown }).type;
    if (type === 'ready') { sendState(); void sample(); }
    else if (type === 'pause') { paused = !paused; sendState(); }
    else if (type === 'refresh') { paused = false; void sample(); }
    else if (type === 'insights') {
      void vscode.commands.executeCommand('iXenaUnrealTools.openUnrealInsights', instance.engineRoot).then(undefined,
        () => vscode.window.showWarningMessage(t("当前扩展尚未提供 Unreal Insights 启动命令。请从引擎目录手动打开 Unreal Insights。")));
    }
  }));
  listeners.push(panel.onDidChangeViewState(() => updateTimer()));
  listeners.push(panel.onDidDispose(() => {
    disposed = true; if (timer) { clearInterval(timer); timer = undefined; }
    monitors.delete(key); for (const listener of listeners) { listener.dispose(); }
  }));
  updateTimer();
}

export function disposePerformanceMonitor(): void { for (const panel of [...monitors.values()]) { panel.dispose(); } monitors.clear(); }
