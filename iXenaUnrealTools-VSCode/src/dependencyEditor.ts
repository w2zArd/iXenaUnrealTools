import { t, getLanguage, onDidChangeLanguage } from './i18n';
import { webviewLanguage, webviewLanguageAttributes } from './webviewI18n';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { UeModule } from './ueWorkspace';
import { analyzeBuildCs, rewriteBuildCs } from './dependencyModel';

function nonce(): string { return randomBytes(18).toString('hex'); }
const commonModules = [
  'Core', 'CoreUObject', 'Engine', 'InputCore', 'Projects', 'DeveloperSettings',
  'RenderCore', 'RHI', 'Renderer', 'Slate', 'SlateCore', 'UMG', 'UMGEditor',
  'EnhancedInput', 'GameplayTags', 'GameplayTasks', 'AIModule', 'NavigationSystem',
  'GameplayAbilities', 'GameplayCameras', 'NetCore', 'Networking', 'Sockets',
  'HTTP', 'Json', 'JsonUtilities', 'OnlineSubsystem', 'OnlineSubsystemUtils',
  'PhysicsCore', 'Niagara', 'NiagaraCore', 'Chaos', 'ProceduralMeshComponent',
  'Landscape', 'PCG', 'AssetRegistry', 'AssetTools', 'UnrealEd', 'EditorSubsystem',
  'ToolMenus', 'LevelEditor', 'PropertyEditor', 'InteractiveToolsFramework',
  'MovieScene', 'MovieSceneTracks', 'AnimationCore', 'AnimGraphRuntime', 'MassEntity'
];

/** 可视化操作只会修改用户点击的 .Build.cs，工作区仍可通过 Ctrl+Z 撤销。 */
export async function showDependencyEditor(context: vscode.ExtensionContext, module: UeModule,
  allModules: readonly UeModule[], output: (message: string) => void): Promise<void> {
  const uri = vscode.Uri.file(module.rulePath);
  let document = await vscode.workspace.openTextDocument(uri);
  let source = document.getText();
  const panel = vscode.window.createWebviewPanel('ixenaDependencies', t("依赖 · {0}", module.name),
    vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'resources')] });
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'ixena.svg');
  const key = nonce();
  panel.webview.html = dependencyEditorHtml(panel.webview, key, context.extensionUri);
  const suggestions = [...new Set([...allModules.map(item => item.name), ...commonModules])]
    .filter(name => name.toLowerCase() !== module.name.toLowerCase()).sort((a, b) => a.localeCompare(b));
  const sendState = () => {
    const analysis = analyzeBuildCs(source);
    void panel.webview.postMessage({ type: 'init', locale: webviewLanguage(), module: module.name, file: module.rulePath, suggestions,
      public: analysis.groups.Public.values, private: analysis.groups.Private.values,
      publicEditable: analysis.groups.Public.editable, privateEditable: analysis.groups.Private.editable,
      publicReason: analysis.groups.Public.reason, privateReason: analysis.groups.Private.reason });
  };
  const messageListener = panel.webview.onDidReceiveMessage(async (message: unknown) => {
    const command = message && typeof message === 'object' && 'type' in message ? (message as { type: string }).type : undefined;
    try {
      if (command === 'ready') { sendState(); return; }
      if (command === 'source') { await vscode.window.showTextDocument(uri, { preview: false, preserveFocus: false }); return; }
      if (command === 'reload') {
        document = await vscode.workspace.openTextDocument(uri); source = document.getText(); sendState(); return;
      }
      if (command !== 'apply') { return; }
      if (!vscode.workspace.isTrusted) { throw new Error(t("需要信任工作区才能修改 Build.cs。")); }
      document = await vscode.workspace.openTextDocument(uri);
      if (document.getText() !== source) { throw new Error(t("Build.cs 已在其他位置发生修改，请先点击“重新读取”。")); }
      const object = message as { public?: unknown; private?: unknown };
      const rewritten = rewriteBuildCs(source, object.public, object.private, module.name);
      if (rewritten === source) { void panel.webview.postMessage({ type: 'status', value: t("没有需要应用的修改。") }); return; }
      const approval = await vscode.window.showWarningMessage(
        t("将 {0}.Build.cs 的 Public / Private 依赖写入编辑器。修改可撤销，不会自动保存到磁盘。", module.name),
        { modal: true }, t("应用修改"));
      if (approval !== t("应用修改")) { return; }
      document = await vscode.workspace.openTextDocument(uri);
      if (document.getText() !== source) { throw new Error(t("Build.cs 已发生修改，请重新读取后再编辑。")); }
      // 找出最小连续差异，避免不必要地改写整个文档；保留其它 C# 逻辑。
      let start = 0;
      while (start < source.length && start < rewritten.length && source[start] === rewritten[start]) { start++; }
      let oldEnd = source.length, newEnd = rewritten.length;
      while (oldEnd > start && newEnd > start && source[oldEnd - 1] === rewritten[newEnd - 1]) { oldEnd--; newEnd--; }
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(document.positionAt(start), document.positionAt(oldEnd)), rewritten.slice(start, newEnd));
      if (!await vscode.workspace.applyEdit(edit)) { throw new Error(t("VSCode 未能应用源码修改。")); }
      document = await vscode.workspace.openTextDocument(uri);
      source = document.getText();
      await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
      sendState();
      output(t("已写入 {0} 的编辑器缓冲区（未自动保存）。", module.rulePath));
      void panel.webview.postMessage({ type: 'status', value: t("已应用到 Build.cs，可按 Ctrl+Z 撤销；需要手动保存文件。") });
    } catch (error) {
      const value = error instanceof Error ? error.message : String(error);
      output(t("依赖编辑失败：{0}", value));
      void vscode.window.showErrorMessage(`iXenaUnrealTools：${value}`);
      void panel.webview.postMessage({ type: 'status', value });
    }
  });
  const languageListener = onDidChangeLanguage(() => {
    panel.title = t('依赖 · {0}', module.name);
    const analysis = analyzeBuildCs(source);
    void panel.webview.postMessage({ type: 'language', ...webviewLanguage(),
      publicReason: analysis.groups.Public.reason, privateReason: analysis.groups.Private.reason });
  });
  panel.onDidDispose(() => { messageListener.dispose(); languageListener.dispose(); });
}

export function dependencyEditorHtml(webview: vscode.Webview, n: string, extensionUri: vscode.Uri): string {
  const localeScript = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'webviewI18n.js')).toString().replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html>
<html lang="${getLanguage()}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'nonce-${n}'; script-src 'nonce-${n}';">
<title>iXena Unreal Modules</title>
<style nonce="${n}">
:root{font-family:var(--vscode-font-family);color:var(--vscode-foreground);font-size:13px}
*{box-sizing:border-box}body{margin:0;padding:24px;background:var(--vscode-editor-background)}
header{display:flex;gap:20px;align-items:center;justify-content:space-between;margin-bottom:18px;flex-wrap:wrap}
h1{font-size:20px;font-weight:600;margin:0}small,.subtle{color:var(--vscode-descriptionForeground)}
.path{margin-top:5px;word-break:break-all}button{cursor:pointer;border:1px solid var(--vscode-button-border,transparent);border-radius:4px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);padding:6px 10px}
button:hover{background:var(--vscode-button-secondaryHoverBackground)}button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button.primary:hover{background:var(--vscode-button-hoverBackground)}
button:disabled{opacity:.45;cursor:not-allowed}
.top-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.notice{background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-widget-border);border-radius:6px;padding:12px;margin-bottom:16px;line-height:1.7}
.layout{display:grid;grid-template-columns:minmax(200px,0.8fr) minmax(245px,1fr) minmax(245px,1fr);gap:16px;align-items:stretch}
.column{border:1px solid var(--vscode-panel-border);border-radius:8px;min-height:330px;overflow:hidden;display:flex;flex-direction:column}
.column-head{background:var(--vscode-sideBar-background);padding:12px 14px;border-bottom:1px solid var(--vscode-panel-border);display:flex;align-items:center;justify-content:space-between;gap:5px}
.column-head strong{font-size:14px}.body{padding:10px;flex:1;overflow:auto;min-height:140px}
input{width:100%;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));color:var(--vscode-input-foreground);padding:8px;border-radius:4px;outline:none}
input:focus{border-color:var(--vscode-focusBorder)}.module{display:flex;justify-content:space-between;align-items:center;gap:5px;padding:7px 5px;border-bottom:1px solid var(--vscode-panel-border)}
.module:hover{background:var(--vscode-list-hoverBackground)}.module code{font-family:var(--vscode-editor-font-family);font-size:12px;overflow-wrap:anywhere}
.controls{display:flex;gap:4px;flex-shrink:0}.controls button{padding:3px 7px}.footer{margin-top:15px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.count{color:var(--vscode-descriptionForeground);font-variant-numeric:tabular-nums}.warning{font-size:12px;color:var(--vscode-editorWarning-foreground);padding:7px}
#status{color:var(--vscode-descriptionForeground)}
@media(max-width:940px){.layout{grid-template-columns:1fr}}
</style></head><body ${webviewLanguageAttributes()}>
<header><div><h1>模块依赖管理</h1><div id="module" class="subtle" style="margin-top:5px"></div><div id="path" class="subtle path"></div></div>
<div class="top-actions"><button id="source">打开 Build.cs</button><button id="reload">重新读取</button><button class="primary" id="apply">应用到文件</button></div></header>
<div class="notice"><strong>可视化管理 Public / Private 依赖</strong><div class="subtle">从模块库添加依赖，在列表中移动或移除。只编辑 Build.cs 中可安全识别的静态 AddRange；条件依赖、变量表达式会保持只读。插件依赖还可能需要更新 .uplugin，不会自动修改。</div></div>
<div class="layout"><section class="column"><div class="column-head"><strong>模块库</strong><span class="count" id="pool-count"></span></div><div class="body"><input id="search" placeholder="筛选或输入模块名"><div class="module" style="margin:8px 0"><code>自定义模块名</code><span class="controls"><button id="add-public">+ Public</button><button id="add-private">+ Private</button></span></div><div id="pool"></div></div></section>
<section class="column"><div class="column-head"><strong>Public 依赖</strong><span class="count" id="public-count"></span></div><div class="body"><div id="public-note" class="warning"></div><div id="public-list"></div></div></section>
<section class="column"><div class="column-head"><strong>Private 依赖</strong><span class="count" id="private-count"></span></div><div class="body"><div id="private-note" class="warning"></div><div id="private-list"></div></div></section></div>
<div class="footer"><button class="primary" id="apply-bottom">应用修改</button><span id="dirty" class="subtle"></span><span id="status" role="status"></span></div>
<script nonce="${n}" src="${localeScript}"></script>
<script nonce="${n}">
'use strict';
const { t } = window.ixenaLocale;
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
let state = {module:'',public:[],private:[],suggestions:[],publicEditable:false,privateEditable:false,publicReason:'',privateReason:'',initialPublic:[],initialPrivate:[]};
function el(tag, text, parent, cls){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;if(parent)parent.appendChild(node);return node;}
function normalize(v){return v.toLowerCase();}
function contains(list,name){return list.some(v=>normalize(v)===normalize(name));}
function changed(){return JSON.stringify(state.public)!==JSON.stringify(state.initialPublic)||JSON.stringify(state.private)!==JSON.stringify(state.initialPrivate);}
function add(name, scope){name=name.trim();if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)){status(t("模块名称仅允许字母、数字和下划线。"));return;}
if(normalize(name)===normalize(state.module)){status(t("不能依赖自身。"));return;}
const key=scope==='Public'?'public':'private';if(!state[key+'Editable']){status(scope+t(" 依赖不可编辑。"));return;}
if(contains(state[key],name))return;if(contains(state[scope==='Public'?'private':'public'],name)){status(t("该模块已存在另一个依赖列表，请使用“移动”。"));return;}
state[key].push(name);render();}
function remove(name,scope){const key=scope==='Public'?'public':'private';if(!state[key+'Editable'])return;state[key]=state[key].filter(v=>v!==name);render();}
function move(name,scope){const from=scope==='Public'?'public':'private',to=scope==='Public'?'private':'public';if(!state[from+'Editable']||!state[to+'Editable'])return;state[from]=state[from].filter(v=>v!==name);if(!contains(state[to],name))state[to].push(name);render();}
function order(name,scope,d){const key=scope==='Public'?'public':'private';const arr=state[key],i=arr.indexOf(name),j=i+d;if(!state[key+'Editable']||i<0||j<0||j>=arr.length)return;[arr[i],arr[j]]=[arr[j],arr[i]];render();}
function renderList(scope){const key=scope==='Public'?'public':'private',root=$(key+'-list');root.replaceChildren();$(key+'-count').textContent=state[key].length+t(" 项");
$(key+'-note').textContent=state[key+'Editable']?'':(t("只读：")+(state[key+'Reason']||t("存在复杂构建规则")));
state[key].forEach(name=>{const row=el('div',undefined,root,'module');el('code',name,row);const buttons=el('span',undefined,row,'controls');
const up=el('button','↑',buttons);up.title=t("上移");up.disabled=!state[key+'Editable'];up.onclick=()=>order(name,scope,-1);
const down=el('button','↓',buttons);down.title=t("下移");down.disabled=!state[key+'Editable'];down.onclick=()=>order(name,scope,1);
const mv=el('button',scope==='Public'?'→ Private':'← Public',buttons);mv.disabled=!state.publicEditable||!state.privateEditable;mv.onclick=()=>move(name,scope);
const del=el('button','×',buttons);del.title=t("移除依赖");del.disabled=!state[key+'Editable'];del.onclick=()=>remove(name,scope);
});}
function render(){renderList('Public');renderList('Private');const dirty=changed();$('dirty').textContent=dirty?t("● 有尚未应用的修改"):t("所有修改均已应用");$('apply').disabled=$('apply-bottom').disabled=!dirty;
const filter=$('search').value.trim().toLowerCase();const pool=$('pool');pool.replaceChildren();const names=state.suggestions.filter(name=>name.toLowerCase().includes(filter)).slice(0,120);
$('pool-count').textContent=names.length+'/'+state.suggestions.length;
names.forEach(name=>{const row=el('div',undefined,pool,'module');el('code',name,row);const controls=el('span',undefined,row,'controls');
const pub=el('button','+ P',controls);pub.title=t("添加到 Public");pub.disabled=!state.publicEditable||contains(state.public,name)||contains(state.private,name);pub.onclick=()=>add(name,'Public');
const priv=el('button','+ Pr',controls);priv.title=t("添加到 Private");priv.disabled=!state.privateEditable||contains(state.public,name)||contains(state.private,name);priv.onclick=()=>add(name,'Private');});}
function status(text){$('status').textContent=text;}
window.addEventListener('message',event=>{const m=event.data;
if(m?.type==='language'){window.ixenaLocale.setLanguage(m);status(window.ixenaLocale.translateMessage($('status').textContent));state.publicReason=m.publicReason||'';state.privateReason=m.privateReason||'';render();return;}
if(m?.type==='init'){
if(m.locale)window.ixenaLocale.setLanguage(m.locale);
state={module:m.module,public:[...m.public],private:[...m.private],suggestions:m.suggestions,publicEditable:m.publicEditable,privateEditable:m.privateEditable,
publicReason:m.publicReason||'',privateReason:m.privateReason||'',initialPublic:[...m.public],initialPrivate:[...m.private]};
$('module').textContent=m.module+' · ModuleRules';$('path').textContent=m.file;status('');render();}
if(m?.type==='status')status(m.value);});
$('search').addEventListener('input',render);
$('add-public').onclick=()=>add($('search').value,'Public');$('add-private').onclick=()=>add($('search').value,'Private');
$('source').onclick=()=>vscode.postMessage({type:'source'});$('reload').onclick=()=>vscode.postMessage({type:'reload'});
function apply(){vscode.postMessage({type:'apply',public:state.public,private:state.private});}
$('apply').onclick=$('apply-bottom').onclick=apply;
vscode.postMessage({type:'ready'});
</script></body></html>`;
}
