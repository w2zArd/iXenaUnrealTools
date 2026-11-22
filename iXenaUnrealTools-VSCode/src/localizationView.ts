import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { getLanguage } from './i18n';

function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 本地化面板只加载扩展自带资源；项目文本由脚本以 textContent / value 显示。 */
export function localizationHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(24).toString('hex');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'localizationEditor.js')).toString();
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'localizationEditor.css')).toString();
  return `<!doctype html>
<html lang="${getLanguage()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${attr(webview.cspSource)}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${attr(css)}"><title>iXena · Localization</title></head>
<body>
<header class="page-header"><div><p class="eyebrow">iXena Unreal Tools <span class="tag">LOCALIZATION</span></p>
<h1 data-i18n="title">本地化工作台</h1><p class="subtitle" data-i18n="subtitle">收集项目文本，管理各语言翻译，生成 UE 本地化资源。</p></div>
<span id="connection-state" class="status-chip" role="status" data-i18n="ready">就绪</span></header>
<main>
<section class="target-bar" aria-label="Localization target">
<label class="target-field"><span data-i18n="target">本地化目标</span><select id="target-select"></select></label>
<label class="culture-field"><span data-i18n="culture">翻译语言</span><select id="culture-select"></select></label>
<div class="target-actions"><button id="refresh" type="button" data-i18n="refresh">扫描 / 刷新</button><button id="new-target" type="button" data-i18n="newTarget">新建目标</button><button id="add-culture" type="button" data-i18n="addCulture">添加语言</button></div>
</section>
<p id="project-path" class="path"></p>
<section class="stat-grid" aria-label="Translation progress">
<article class="stat"><span data-i18n="total">文本总数</span><strong id="stat-total">0</strong></article>
<article class="stat translated"><span data-i18n="translated">已翻译</span><strong id="stat-translated">0</strong></article>
<article class="stat"><span data-i18n="untranslated">未翻译</span><strong id="stat-untranslated">0</strong></article>
<article class="stat review"><span data-i18n="review">需复核</span><strong id="stat-review">0</strong></article>
</section>
<div class="progress-row"><progress id="translation-progress" max="100" value="0" aria-label="Translation completion"></progress><span id="progress-label">0%</span></div>
<section class="workflow-bar" aria-label="Localization workflow">
<div class="button-group"><button id="gather-export" type="button" data-i18n="gatherExport">采集并导出</button><button id="import-compile" type="button" data-i18n="importCompile">导入并编译</button><button id="stop" type="button" class="danger" hidden data-i18n="stop">停止任务</button></div>
<div class="button-group"><button id="import-translations" type="button" data-i18n="importTranslations">导入翻译文件</button><label class="sr-only" for="export-format" data-i18n="exportFormat">导出格式</label><select id="export-format"><option value="po">PO</option><option value="csv">CSV</option><option value="json">JSON</option></select><label class="export-scope"><input id="export-all" type="checkbox"><span data-i18n="allLanguages">所有语言</span></label><button id="export" type="button" data-i18n="export">导出</button></div>
</section>
<div class="preferences-row"><label><input id="auto-export" type="checkbox"><span data-i18n="autoExport">保存后自动导出 PO / CSV / JSON</span></label><button id="open-file" class="link-button" type="button" data-i18n="openFile">打开原始 PO 文件</button></div>
<details class="advanced"><summary data-i18n="advanced">单独执行步骤 / 打开配置</summary><div class="advanced-content"><div class="button-group"><span data-i18n="runStep">执行步骤</span><button id="run-gather" type="button" data-i18n="gather">采集</button><button id="run-export" type="button" data-i18n="exportPo">导出 PO</button><button id="run-import" type="button" data-i18n="importPo">导入 PO</button><button id="run-compile" type="button" data-i18n="compile">编译资源</button></div><div class="button-group"><span data-i18n="openConfig">打开配置</span><button id="config-gather" type="button">Gather.ini</button><button id="config-export" type="button">Export.ini</button><button id="config-import" type="button">Import.ini</button><button id="config-compile" type="button">Compile.ini</button></div></div></details>
<section id="warnings" class="warnings" hidden aria-live="polite"></section>
<p id="message" class="message" role="status" aria-live="polite" hidden></p>
<section id="draft-banner" class="draft-banner" hidden aria-live="polite"><div><strong id="draft-title"></strong><span id="draft-detail"></span></div><div class="button-group"><button id="restore-draft" type="button" hidden data-i18n="restoreDraft">恢复草稿</button><button id="discard" type="button" data-i18n="discard">放弃修改</button><button id="save" type="button" class="primary" data-i18n="save">保存翻译</button></div></section>
<section class="catalog" aria-label="Translation table">
<div class="catalog-toolbar"><label class="search-field"><span class="sr-only" data-i18n="search">搜索原文、翻译、标识或引用</span><input id="search" type="search" data-placeholder="search" autocomplete="off"></label><label class="filter-field"><span class="sr-only" data-i18n="filter">筛选</span><select id="filter"><option value="all" data-i18n="all">全部文本</option><option value="untranslated" data-i18n="untranslated">未翻译</option><option value="review" data-i18n="review">需复核</option><option value="modified" data-i18n="modified">本次修改</option></select></label><span id="result-count" class="muted"></span></div>
<div class="table-container"><table><thead><tr><th class="identity-column" scope="col" data-i18n="identity">命名空间 / 标识</th><th scope="col" data-i18n="source">源文本</th><th scope="col" data-i18n="translation">译文</th></tr></thead><tbody id="entries"></tbody></table></div>
<div id="empty-state" class="empty-state" hidden><strong id="empty-title"></strong><p id="empty-detail"></p></div>
<footer class="catalog-footer"><span id="page-label"></span><div class="button-group"><button id="prev-page" type="button" data-i18n="previous">上一页</button><button id="next-page" type="button" data-i18n="next">下一页</button></div></footer>
</section>
<footer class="page-footer"><p id="file-path" class="path"></p><p data-i18n="workflowHint">保存写入 PO；“导入并编译”后 UE 才能使用更新后的本地化资源。资源加载与打包语言仍由项目设置决定。</p></footer>
</main><script nonce="${nonce}" src="${attr(script)}"></script></body></html>`;
}
