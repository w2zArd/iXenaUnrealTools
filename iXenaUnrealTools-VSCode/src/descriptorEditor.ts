import { t, getLanguage, onDidChangeLanguage } from './i18n';
import { webviewLanguage, webviewLanguageAttributes } from './webviewI18n';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { analyzeDescriptor, assertDescriptorVersion, descriptorKind, DescriptorKind, planDescriptorEdit } from './descriptorModel';

export const DESCRIPTOR_VIEW_TYPE = 'iXenaUnrealTools.descriptorEditor';

/** 原生 TextDocument 驱动的描述文件编辑器，保存、撤销、重做和热退出由 VS Code 管理。 */
export class DescriptorEditorProvider implements vscode.CustomTextEditorProvider, vscode.Disposable {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly cleanups = new Set<() => void>();

  constructor(private readonly context: vscode.ExtensionContext, private readonly output: (message: string) => void = () => {}) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel, _token: vscode.CancellationToken): void {
    const kind = descriptorKind(document.uri.path);
    if (!kind) { throw new Error(t("仅支持 .uproject 和 .uplugin 描述文件。")); }
    panel.webview.options = { enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'resources')] };
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'ixena.svg');
    panel.webview.html = descriptorEditorHtml(panel.webview, this.context.extensionUri);
    let disposed = false, applying = false;
    const sendState = (reason: string, requestId?: string) => {
      if (disposed) { return; }
      const source = document.getText();
      void panel.webview.postMessage({ type: 'state', locale: webviewLanguage(), ...analyzeDescriptor(source, kind),
        version: document.version, kind, filename: path.basename(document.uri.fsPath), filePath: document.uri.fsPath,
        dirty: document.isDirty, source, reason, requestId });
    };
    const listeners: vscode.Disposable[] = [];
    listeners.push(onDidChangeLanguage(() => {
      const analysis = analyzeDescriptor(document.getText(), kind);
      void panel.webview.postMessage({ type: 'language', ...webviewLanguage(), rootFields: analysis.rootFields,
        moduleFields: analysis.moduleFields, pluginFields: analysis.pluginFields });
    }));
    listeners.push(vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.toString() === document.uri.toString() && !applying && event.contentChanges.length > 0) {
        sendState('document');
      }
    }));
    listeners.push(vscode.workspace.onDidSaveTextDocument(saved => {
      if (saved.uri.toString() === document.uri.toString()) { sendState('saved'); }
    }));
    const receive = async (raw: unknown): Promise<void> => {
      if (disposed || !raw || typeof raw !== 'object') { return; }
      const message = raw as Record<string, unknown>;
      const requestId = typeof message.requestId === 'string' && message.requestId.length <= 128 ? message.requestId : undefined;
      if (message.type === 'ready' || message.type === 'reload') { sendState(String(message.type)); return; }
      if (!['edit', 'save', 'source'].includes(String(message.type))) { return; }
      const key = document.uri.toString();
      // 同一 TextDocument 的多个视图共用串行队列，每次编辑仍需匹配各自看到的版本。
      const operation = (this.queues.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
        if (disposed) { return; }
        try {
          if (message.type === 'source') {
            await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
            return;
          }
          if (!vscode.workspace.isTrusted) { throw new Error(t("请先信任工作区，再修改描述文件。")); }
          if (message.type === 'save') {
            if (!await document.save()) { throw new Error(t("VS Code 未能保存文件，请检查文件权限或保存冲突。")); }
            sendState('saved', requestId); return;
          }
          if (!requestId) { throw new Error(t("编辑请求缺少有效标识。")); }
          assertDescriptorVersion(document.version, message.version);
          const plan = planDescriptorEdit(document.getText(), kind, message.operation);
          if (plan.edits.length) {
            const edit = new vscode.WorkspaceEdit();
            for (const change of plan.edits) {
              edit.replace(document.uri, new vscode.Range(document.positionAt(change.offset),
                document.positionAt(change.offset + change.length)), change.content);
            }
            applying = true;
            try {
              if (!await vscode.workspace.applyEdit(edit)) { throw new Error(t("文件已发生变化或无法写入，VS Code 未应用此次修改。")); }
            } finally { applying = false; }
          }
          sendState('applied', requestId);
        } catch (error) {
          applying = false;
          const text = error instanceof Error ? error.message : String(error);
          this.output(t("描述文件编辑：{0}", text));
          if (!disposed) { void panel.webview.postMessage({ type: 'error', requestId, message: text,
            conflict: message.type === 'edit' && document.version !== message.version }); }
        }
      });
      this.queues.set(key, operation);
      await operation;
      if (this.queues.get(key) === operation) { this.queues.delete(key); }
    };
    listeners.push(panel.webview.onDidReceiveMessage(receive));
    const cleanup = () => {
      if (disposed) { return; }
      disposed = true;
      for (const listener of listeners) { listener.dispose(); }
      this.cleanups.delete(cleanup);
    };
    listeners.push(panel.onDidDispose(cleanup));
    this.cleanups.add(cleanup);
  }

  dispose(): void {
    for (const cleanup of [...this.cleanups]) { cleanup(); }
    this.queues.clear();
  }
}

type DescriptorArgument = vscode.Uri | { uri?: vscode.Uri; resourceUri?: vscode.Uri; fullPath?: string; path?: string };

/** 可从 VS Code 文件树、扩展资源树、活动编辑器或文件选择器打开。 */
export async function openDescriptor(argument?: DescriptorArgument): Promise<void> {
  let uri: vscode.Uri | undefined;
  if (argument instanceof vscode.Uri) { uri = argument; }
  else if (argument && typeof argument === 'object') {
    const node = argument as Exclude<DescriptorArgument, vscode.Uri>;
    uri = node.uri ?? node.resourceUri;
    const filePath = node.fullPath ?? node.path;
    if (!uri && typeof filePath === 'string') { uri = vscode.Uri.file(filePath); }
  }
  if (!uri) {
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active && descriptorKind(active.path)) { uri = active; }
  }
  if (!uri) {
    const selected = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
      title: t("选择 Unreal 项目或插件描述文件"), filters: { [t("Unreal 描述文件")]: ['uproject', 'uplugin'] } });
    uri = selected?.[0];
  }
  if (!uri) { return; }
  if (!descriptorKind(uri.path)) { throw new Error(t("请选择 .uproject 或 .uplugin 文件。")); }
  await vscode.commands.executeCommand('vscode.openWith', uri, DESCRIPTOR_VIEW_TYPE);
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function descriptorEditorHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(18).toString('hex');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'descriptorEditor.js'));
  const localeScript = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'webviewI18n.js'));
  const stylesheet = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'descriptorEditor.css'));
  return `<!DOCTYPE html>
<html lang="${getLanguage()}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escapeAttribute(webview.cspSource)}; script-src 'nonce-${nonce}';">
<title>Unreal 描述文件</title><link rel="stylesheet" href="${escapeAttribute(stylesheet.toString())}"></head>
<body ${webviewLanguageAttributes()}>
<header class="topbar"><div class="brand"><span class="brand-mark" aria-hidden="true">U</span><div><p class="eyebrow">iXena Unreal Tools</p><h1 id="filename">描述文件编辑器</h1><p class="filepath" id="filepath"></p></div></div>
<div class="toolbar"><span class="save-state" id="save-state" role="status">读取中…</span><button id="source" type="button">JSON 源码</button><button id="save" type="button" class="primary">保存 <kbd>Ctrl+S</kbd></button></div></header>
<main><div id="notices" aria-live="polite"></div><nav class="tabs" aria-label="描述文件内容"><button data-tab="overview" class="active" type="button">概览</button><button data-tab="modules" type="button">模块 <span id="module-count">0</span></button><button data-tab="plugins" type="button">插件依赖 <span id="plugin-count">0</span></button><button data-tab="json" type="button">JSON 预览</button></nav>
<section id="content" aria-live="polite"><p class="empty">正在读取 Unreal 描述文件…</p></section>
<footer>字段修改会写入编辑器缓冲区，Ctrl+S 保存；撤销 / 重做与文本编辑器共用。新增模块只修改声明，不生成源码。</footer></main>
<script nonce="${nonce}" src="${escapeAttribute(localeScript.toString())}"></script>
<script nonce="${nonce}" src="${escapeAttribute(script.toString())}"></script></body></html>`;
}
