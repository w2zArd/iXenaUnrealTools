import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { getLanguage, onDidChangeLanguage, tr } from './i18n';
import { discoverProjects } from './ueWorkspace';
import { pathKey } from './engineSupport';
import { PreparedTask, RunResult } from './taskRunner';
import { LocalizationTarget, discoverLocalizationTargets, createTargetPlan, addCulturePlan, runnerCommand } from './localizationConfig';
import { PoDocument, PoChange, parsePo, updatePoTranslations, exportCatalog, importCatalog, catalogStats, getEntryIssues } from './localizationPo';
import { localizationHtml } from './localizationView';

const P = 'iXenaUnrealTools';
const MAX_PO_BYTES = 64 * 1024 * 1024;
type Action = 'gather' | 'export' | 'import' | 'compile';
interface Snapshot { path: string; document: PoDocument; revision: string; diskHash: string; readOnly: boolean; }
export interface LocalizationHooks {
  projects(): string[];
  preferredProject(): string | undefined;
  engineForProject(projectPath: string): string | undefined;
  engines(): string[];
  buildBusy(): boolean;
  runTask(label: string, steps: PreparedTask[]): Promise<RunResult>;
  stopTask(): void;
  log(message: string): void;
}
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const fileExists = async (file: string): Promise<boolean> => (await fs.stat(file).catch(() => undefined))?.isFile() ?? false;
const safeName = (value: string): string => value.replace(/[^\p{L}\p{N}_.-]/gu, '_').slice(0, 120) || 'target';

/** 本地化入口复用现有任务执行器；UE 负责采集/导入/编译，面板只编辑 PO。 */
export class LocalizationManager implements vscode.Disposable, vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changed = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscriptions: vscode.Disposable[] = [];
  private panel?: vscode.WebviewPanel;
  private panelReady = false;
  private targets: LocalizationTarget[] = [];
  private targetId?: string;
  private culture?: string;
  private snapshot?: Snapshot;
  private operation = false;
  private pipelineRunning = false;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private queue: Promise<unknown> = Promise.resolve();
  private status = '';

  constructor(private readonly context: vscode.ExtensionContext, private readonly hooks: LocalizationHooks) {
    const view = vscode.window.createTreeView('ixenaUnrealTools.localization', { treeDataProvider: this, showCollapseAll: true });
    this.subscriptions.push(view, this.changed, onDidChangeLanguage(() => {
      this.changed.fire(undefined);
      if (!this.operation) void this.dispatch({ type: 'refresh' });
      else void this.sendState('language');
    }));
    this.subscriptions.push(view.onDidChangeVisibility(event => { if (event.visible && !this.operation) void this.dispatch({ type: 'refresh' }); }));
    const commands: Record<string, (...args: any[]) => unknown> = {
      openLocalization: (argument?: vscode.Uri | { targetId?: string; culture?: string; fsPath?: string }) => this.open(argument),
      refreshLocalization: () => this.dispatch({ type: 'refresh' }),
      newLocalizationTarget: async () => { await this.open(); await this.dispatch({ type: 'newTarget' }); },
      gatherLocalization: async () => { await this.open(); await this.dispatch({ type: 'pipeline', action: 'gatherExport' }); },
      compileLocalization: async () => { await this.open(); await this.dispatch({ type: 'pipeline', action: 'importCompile' }); },
      stopLocalization: () => { if (this.pipelineRunning) this.hooks.stopTask(); }
    };
    for (const [name, callback] of Object.entries(commands)) {
      this.subscriptions.push(vscode.commands.registerCommand(`${P}.${name}`, async (...args: any[]) => {
        try { return await callback(...args); } catch (error) { this.error(error); }
      }));
    }
    const watcher = vscode.workspace.createFileSystemWatcher('**/{*.po,*_Gather.ini,*_Export.ini,*_Import.ini,*_Compile.ini,iXena.*.ini,*.ixena-loc.json}');
    const schedule = () => {
      if (!this.panel || this.disposed || this.operation) return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => { void this.dispatch({ type: 'refresh' }); }, 600);
    };
    this.subscriptions.push(watcher, watcher.onDidChange(schedule), watcher.onDidCreate(schedule), watcher.onDidDelete(schedule));
    this.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(`${P}.localization`)) void this.sendState('configuration');
    }));
    this.subscriptions.push(vscode.workspace.onDidSaveTextDocument(doc => {
      if (this.operation || !this.autoExport || !/\.po$/i.test(doc.uri.fsPath)) return;
      const target = this.targets.find(t => t.poFiles.some(p => pathKey(p.path) === pathKey(doc.uri.fsPath)));
      const po = target?.poFiles.find(p => pathKey(p.path) === pathKey(doc.uri.fsPath));
      if (!target || !po) return;
      const savedText = doc.getText();
      void this.enqueue(async () => { await this.autoExportFile(target, po.culture, savedText); }).catch(error => this.error(error));
    }));
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }
  getChildren(item?: vscode.TreeItem): vscode.TreeItem[] {
    if (item) return [];
    const action = (label: string, name: string, icon: string): vscode.TreeItem => {
      const result = new vscode.TreeItem(label); result.iconPath = new vscode.ThemeIcon(icon);
      result.command = { command: `${P}.${name}`, title: label }; return result;
    };
    const items = [action(tr('打开本地化工作台', 'Open Localization Workbench'), 'openLocalization', 'globe'),
      action(tr('新建本地化目标', 'New Localization Target'), 'newLocalizationTarget', 'new-file')];
    for (const target of this.targets) {
      const entry = new vscode.TreeItem(`${target.scopeName} / ${target.name}`);
      entry.description = tr('{0} 种语言', '{0} cultures', target.cultures.length);
      entry.tooltip = target.dataDirectory; entry.iconPath = new vscode.ThemeIcon('globe');
      entry.command = { command: `${P}.openLocalization`, title: tr('编辑翻译', 'Edit translations'), arguments: [{ targetId: target.id }] };
      items.push(entry);
    }
    if (!this.targets.length) {
      const note = new vscode.TreeItem(tr('扫描项目及插件的 Config / Content / Localization', 'Scan project and plugin Config / Content / Localization'));
      note.iconPath = new vscode.ThemeIcon('info'); items.push(note);
    }
    return items;
  }
  private get target(): LocalizationTarget | undefined { return this.targets.find(value => value.id === this.targetId); }
  private get autoExport(): boolean { return vscode.workspace.getConfiguration(P).get('localization.autoExportOnSave', false); }
  private enqueue<T>(callback: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(callback); this.queue = next; return next;
  }
  private error(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.hooks.log(`[Localization] ${message}`);
    if (this.panel) void this.panel.webview.postMessage({ type: 'error', message });
    else void vscode.window.showErrorMessage(`iXenaUnrealTools: ${message}`);
  }
  private requireTrusted(): void {
    if (!vscode.workspace.isTrusted) throw new Error(tr('请先信任工作区，再修改翻译或运行 UE。', 'Trust this workspace before editing translations or running UE.'));
  }

  async open(argument?: vscode.Uri | { targetId?: string; culture?: string; fsPath?: string }): Promise<void> {
    if (this.disposed) return;
    if (!this.panel) {
      this.panelReady = false;
      this.panel = vscode.window.createWebviewPanel('iXenaUnrealTools.localization', tr('iXena · 本地化', 'iXena · Localization'), vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'resources')] });
      this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'ixena.svg');
      this.panel.webview.html = localizationHtml(this.panel.webview, this.context.extensionUri);
      const panel = this.panel;
      const receiver = panel.webview.onDidReceiveMessage(raw => { void this.dispatch(raw); });
      const close = panel.onDidDispose(() => { receiver.dispose(); close.dispose(); if (this.panel === panel) this.panel = undefined; });
    }
    this.panel.reveal();
    await this.dispatch({ type: 'refresh' });
    const file = argument instanceof vscode.Uri ? argument.fsPath : argument?.fsPath;
    if (file) {
      const target = this.targets.find(t => t.poFiles.some(p => pathKey(p.path) === pathKey(file)) || pathKey(t.projectPath) === pathKey(file)
        || pathKey(t.scopeRoot) === pathKey(path.dirname(file)));
      if (target) {
        this.targetId = target.id; this.culture = target.poFiles.find(p => pathKey(p.path) === pathKey(file))?.culture;
        await this.loadSelected(); await this.sendState('selection');
      }
    } else if (!(argument instanceof vscode.Uri) && argument?.targetId && this.targets.some(t => t.id === argument.targetId)) {
      this.targetId = argument.targetId; this.culture = argument.culture;
      await this.loadSelected(); await this.sendState('selection');
    }
  }

  private async projectPaths(): Promise<string[]> {
    const candidates = new Set(this.hooks.projects());
    const preferred = this.hooks.preferredProject(); if (preferred) candidates.add(preferred);
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== 'file') continue;
      for (const file of await fs.readdir(folder.uri.fsPath, { withFileTypes: true }).catch(() => [])) {
        if (file.isFile() && /\.uproject$/i.test(file.name)) candidates.add(path.join(folder.uri.fsPath, file.name));
      }
    }
    return [...candidates].filter(file => typeof file === 'string' && /\.uproject$/i.test(file));
  }

  private async scan(): Promise<void> {
    this.targets = await discoverLocalizationTargets(await this.projectPaths());
    if (!this.target) {
      const saved = this.context.workspaceState.get<{ targetId?: string; culture?: string }>('localizationSelection');
      const selection = this.targets.find(t => t.id === saved?.targetId)
        ?? this.targets.find(t => t.projectPath === this.hooks.preferredProject()) ?? this.targets[0];
      this.targetId = selection?.id; this.culture = saved?.culture;
    }
    await this.loadSelected(); this.changed.fire(undefined);
  }
  private async loadSelected(): Promise<void> {
    const target = this.target; this.snapshot = undefined;
    if (!target) return;
    if (!this.culture || !target.cultures.includes(this.culture)) this.culture = target.cultures.find(c => c !== target.nativeCulture) ?? target.cultures[0];
    await this.context.workspaceState.update('localizationSelection', { targetId: target.id, culture: this.culture });
    const file = target.poFiles.find(p => p.culture === this.culture);
    if (!file) return;
    const stat = await fs.stat(file.path);
    if (stat.size > MAX_PO_BYTES) throw new Error(tr('PO 大于 64 MiB，请拆分本地化目标后编辑。', 'The PO exceeds 64 MiB. Split this localization target before editing.'));
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file.path));
    const text = doc.getText(); const disk = await fs.readFile(file.path, 'utf8');
    // VS Code 文档不显示编码 BOM；除此之外，缓冲区与磁盘必须属于同一版本。
    // 否则不能把旧缓冲区和新磁盘哈希拼成一个“新基线”，让后续保存覆盖外部变更。
    if (text.replace(/^\uFEFF/, '') !== disk.replace(/^\uFEFF/, '')) {
      throw new Error(tr('PO 编辑器内容与磁盘版本不同，已暂停表格写入。请先在原始文件中保存或处理冲突，再重新扫描。',
        'The PO editor buffer differs from the disk revision; table editing is paused. Save or resolve the source-file conflict, then rescan.'));
    }
    const parsed = parsePo(text);
    const readOnly = parsed.entries.some(entry => entry.header && entry.translations.some(value => /X-Crowdin-SourceKey\s*:/i.test(value)));
    this.snapshot = { path: file.path, document: parsed, revision: digest(text), diskHash: digest(disk), readOnly };
  }
  private async sendState(reason = 'refresh'): Promise<void> {
    if (!this.panel || !this.panelReady || this.disposed) return;
    const snap = this.snapshot;
    const entries = snap?.document.entries.filter(entry => !entry.header && !entry.obsolete) ?? [];
    const warnings = [...(this.target?.warnings ?? [])];
    if (snap?.readOnly) warnings.push(tr('此 PO 使用 Crowdin 身份格式：表格暂为只读，请使用原始文件或 Crowdin 编辑，避免把文本 ID 当作源文。',
      'This PO uses Crowdin identity format. The table is read-only; use the source file or Crowdin to avoid treating IDs as source text.'));
    if (this.target && !snap) warnings.push(tr('该语言尚无 PO。请先“采集并导出”，或检查目标的导出配置。', 'This culture has no PO yet. Run Gather & Export, or check the target export configuration.'));
    void this.panel.webview.postMessage({ type: 'state', reason, language: getLanguage(), targets: this.targets,
      targetId: this.targetId, culture: this.culture, filePath: snap?.path, revision: snap?.revision,
      entries, stats: snap ? catalogStats(snap.document) : { total: 0, translated: 0, untranslated: 0, review: 0 },
      issues: Object.fromEntries(entries.map(entry => [entry.id, getEntryIssues(entry)])),
      busy: this.operation, readOnly: snap?.readOnly ?? false, autoExport: this.autoExport, status: this.status, warnings });
  }

  /** Webview 的文件路径仅作并发标识；实际写入始终使用已扫描并选中的 PO。 */
  async dispatch(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object' || this.disposed) return;
    const message = raw as Record<string, unknown>;
    if (message.type === 'storeDraft') {
      // 草稿与源文件分开保存，关闭面板或重载窗口后仍可恢复；消息不允许触发任意文件写入。
      if (!this.panelReady || !message.draft || typeof message.draft !== 'object') return;
      const draft = message.draft as Record<string, unknown>;
      if (draft.version !== 1 || typeof draft.filePath !== 'string' || !Array.isArray(draft.changes)) return;
      if (Buffer.byteLength(JSON.stringify(draft), 'utf8') > 8 * 1024 * 1024) {
        this.error(new Error(tr('草稿超过 8 MiB，请先保存部分翻译。', 'The draft exceeds 8 MiB. Save some translations first.'))); return;
      }
      await this.context.workspaceState.update('localizationDraft', draft.changes.length ? draft : undefined);
      return;
    }
    if (message.type === 'stop') { if (this.pipelineRunning) this.hooks.stopTask(); return; }
    if (this.operation && !['ready'].includes(String(message.type))) {
      this.error(new Error(tr('本地化操作正在执行，请等待结束。', 'A localization operation is running. Wait for it to finish.'))); return;
    }
    return this.enqueue(async () => {
      if (this.disposed) return;
      this.operation = true;
      void this.panel?.webview.postMessage({ type: 'status', message: this.status, busy: true });
      let reason = String(message.type);
      try {
        switch (message.type) {
          case 'ready':
          case 'refresh':
            await this.scan();
            if (message.type === 'ready') {
              const draft = this.context.workspaceState.get<Record<string, unknown>>('localizationDraft');
              const selection = typeof message.targetId === 'string' ? message : draft;
              if (selection && typeof selection.targetId === 'string' && this.targets.some(t => t.id === selection.targetId)) {
                this.targetId = selection.targetId; this.culture = typeof selection.culture === 'string' ? selection.culture : undefined; await this.loadSelected();
              }
              this.panelReady = true;
              if (draft && !message.targetId) void this.panel?.webview.postMessage({ type: 'restoreDraft', draft });
            }
            break;
          case 'selectTarget':
            if (!this.targets.some(target => target.id === message.targetId)) throw new Error(tr('本地化目标不存在，请重新扫描。', 'The localization target is missing. Rescan the project.'));
            this.targetId = String(message.targetId); this.culture = undefined; await this.loadSelected(); break;
          case 'selectCulture':
            if (!this.target?.cultures.includes(String(message.culture))) throw new Error(tr('语言不属于当前目标。', 'The culture does not belong to the selected target.'));
            this.culture = String(message.culture); await this.loadSelected(); break;
          case 'save': await this.save(message); reason = 'saved'; break;
          case 'discard': await this.loadSelected(); reason = 'discarded'; break;
          case 'import': await this.importFile(message); reason = 'saved'; break;
          case 'export': await this.exportFiles(message); break;
          case 'pipeline': await this.pipeline(String(message.action)); reason = 'pipeline'; break;
          case 'newTarget': await this.newTarget(); break;
          case 'addCulture': await this.addCulture(); break;
          case 'setAutoExport':
            this.requireTrusted(); if (typeof message.enabled !== 'boolean') throw new Error('Invalid auto-export option');
            await vscode.workspace.getConfiguration(P).update('localization.autoExportOnSave', message.enabled, vscode.ConfigurationTarget.Workspace); break;
          case 'openFile': if (this.snapshot) await vscode.window.showTextDocument(vscode.Uri.file(this.snapshot.path)); break;
          case 'openConfig': {
            const config = this.target?.configs[String(message.action) as Action];
            if (config) await vscode.window.showTextDocument(vscode.Uri.file(config)); break;
          }
          default: return;
        }
      } catch (error) { this.error(error); reason = 'error'; }
      finally { this.operation = false; await this.sendState(reason); }
    });
  }

  private assertSnapshot(message: Record<string, unknown>): Snapshot {
    this.requireTrusted();
    const snap = this.snapshot;
    if (!snap || typeof message.filePath !== 'string' || message.filePath !== snap.path || message.revision !== snap.revision)
      throw new Error(tr('文件或版本已变化，请保留草稿并重新载入后再保存。', 'The file or revision changed. Preserve your draft and reload before saving.'));
    if (snap.readOnly) throw new Error(tr('Crowdin 身份格式不支持此表格写入，请打开原始文件。', 'This table cannot write Crowdin identity-format PO files. Open the source file.'));
    return snap;
  }
  private async save(message: Record<string, unknown>): Promise<void> {
    const snap = this.assertSnapshot(message);
    if (!Array.isArray(message.changes) || message.changes.length > 100000) throw new Error(tr('翻译修改格式无效。', 'Invalid translation changes.'));
    const changes = message.changes as PoChange[];
    const updated = updatePoTranslations(snap.document, changes);
    await this.writeSelected(snap, updated);
  }
  private async writeSelected(snap: Snapshot, updated: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(snap.path));
    const disk = await fs.readFile(snap.path, 'utf8');
    if (digest(doc.getText()) !== snap.revision || digest(disk) !== snap.diskHash)
      throw new Error(tr('PO 已被外部修改，本次未覆盖。请重新载入并合并草稿。', 'The PO was changed externally and was not overwritten. Reload and merge your draft.'));
    if (updated !== doc.getText()) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), updated);
      if (!await vscode.workspace.applyEdit(edit)) throw new Error(tr('VS Code 未应用翻译修改。', 'VS Code did not apply the translation edits.'));
    }
    if (!await doc.save()) throw new Error(tr('PO 保存失败，请检查文件权限和冲突。', 'Saving the PO failed. Check permissions and conflicts.'));
    await this.loadSelected();
    await this.context.workspaceState.update('localizationDraft', undefined);
    this.status = tr('翻译已保存；导入并编译后才会生成 UE 运行时资源。', 'Translations saved. Import & Compile generates the UE runtime resources.');
    if (this.autoExport && this.target && this.culture) {
      try { await this.autoExportFile(this.target, this.culture, doc.getText()); }
      catch (error) { this.error(new Error(tr('PO 已保存，但自动导出失败：{0}', 'The PO was saved, but automatic export failed: {0}', String(error)))); }
    }
  }
  private async importFile(message: Record<string, unknown>): Promise<void> {
    const snap = this.assertSnapshot(message);
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Translation files': ['po', 'csv', 'json'] },
      title: tr('导入当前语言的翻译（仅匹配相同身份与源文）', 'Import translations for this culture (exact identity and source matches)') });
    if (!picked?.[0]) return;
    const stat = await fs.stat(picked[0].fsPath); if (stat.size > MAX_PO_BYTES) throw new Error(tr('导入文件超过 64 MiB。', 'The import file exceeds 64 MiB.'));
    const format = path.extname(picked[0].fsPath).slice(1).toLowerCase();
    if (!['po', 'csv', 'json'].includes(format)) throw new Error('Unsupported translation format');
    const result = importCatalog(snap.document, await fs.readFile(picked[0].fsPath, 'utf8'), format as 'po' | 'csv' | 'json', this.culture ?? '');
    const confirm = await vscode.window.showInformationMessage(tr('将更新 {0} 条匹配翻译，跳过 {1} 条。{2}',
      'Update {0} matching translations; skip {1}. {2}', result.matched, result.skipped, result.warnings.join('\n')),
      { modal: true }, tr('导入', 'Import'));
    if (!confirm) return;
    await this.writeSelected(snap, updatePoTranslations(snap.document, result.changes));
  }
  private async exportFiles(message: Record<string, unknown>): Promise<void> {
    this.requireTrusted();
    const target = this.target;
    if (!target) throw new Error(tr('请先选择本地化目标。', 'Select a localization target first.'));
    const format = String(message.format);
    if (!['po', 'csv', 'json'].includes(format)) throw new Error('Unsupported translation format');
    const files = message.all === true ? target.poFiles : target.poFiles.filter(p => p.culture === this.culture);
    if (!files.length) throw new Error(tr('还没有可导出的 PO，请先采集并导出。', 'There are no PO files yet. Run Gather & Export first.'));
    if (message.all === true) {
      const directory = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        title: tr('选择全部语言的导出目录', 'Choose an export folder for all cultures') });
      if (!directory?.[0]) return;
      const root = path.join(directory[0].fsPath, `${safeName(target.scopeName)}-${safeName(target.name)}-${digest(target.id).slice(0, 8)}`);
      for (const file of files) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file.path));
        const content = format === 'po' ? doc.getText() : exportCatalog(parsePo(doc.getText()), format as 'csv' | 'json', file.culture);
        const destination = path.join(root, safeName(file.culture), `${safeName(target.name)}.${format}`);
        this.assertExportDestination(destination);
        if (await fileExists(destination)) {
          const overwrite = await vscode.window.showWarningMessage(tr('导出文件已存在：{0}', 'The export already exists: {0}', destination),
            { modal: true }, tr('覆盖', 'Overwrite'));
          if (!overwrite) continue;
        }
        await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, content, 'utf8');
      }
      this.status = tr('导出目录：{0}', 'Export folder: {0}', root);
    } else {
      const file = files[0]; const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file.path));
      const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(path.dirname(target.projectPath), 'Saved',
        `${safeName(target.name)}.${safeName(file.culture)}.${format}`)), filters: { [format.toUpperCase()]: [format] } });
      if (!uri) return;
      this.assertExportDestination(uri.fsPath);
      const content = format === 'po' ? doc.getText() : exportCatalog(parsePo(doc.getText()), format as 'csv' | 'json', file.culture);
      await fs.mkdir(path.dirname(uri.fsPath), { recursive: true }); await fs.writeFile(uri.fsPath, content, 'utf8');
      this.status = tr('已导出：{0}', 'Exported: {0}', uri.fsPath);
    }
  }
  private assertExportDestination(filename: string): void {
    const protectedPaths = this.targets.flatMap(target => [...target.poFiles.map(file => file.path),
      ...Object.values(target.configs).filter((file): file is string => typeof file === 'string'),
      ...(target.metadataPath ? [target.metadataPath] : [])]);
    if (protectedPaths.some(file => pathKey(file) === pathKey(filename)))
      throw new Error(tr('导出位置指向已有本地化源文件或配置，请选择单独的导出目录。',
        'The export destination is an existing localization source or config. Choose a separate export folder.'));
  }
  private async autoExportFile(target: LocalizationTarget, culture: string, text: string): Promise<void> {
    this.requireTrusted();
    const directory = path.join(path.dirname(target.projectPath), 'Saved', 'iXenaUnrealTools', 'LocalizationExports',
      safeName(target.scopeName), `${safeName(target.name)}-${digest(target.id).slice(0, 8)}`, safeName(culture));
    const doc = parsePo(text); await fs.mkdir(directory, { recursive: true });
    for (const format of ['po', 'csv', 'json'] as const) {
      const content = format === 'po' ? text : exportCatalog(doc, format, culture);
      await fs.writeFile(path.join(directory, `${safeName(target.name)}.${format}`), content, 'utf8');
    }
    this.hooks.log(tr('本地化已自动导出：{0}', 'Localization exported automatically: {0}', directory));
  }

  private async chooseEngine(projectPath: string): Promise<string> {
    const selected = this.hooks.engineForProject(projectPath); if (selected) return selected;
    const roots = [...new Set(this.hooks.engines().filter(root => typeof root === 'string' && root.trim()))];
    if (roots.length === 1) return roots[0];
    if (roots.length > 1) {
      const item = await vscode.window.showQuickPick(roots, { title: tr('选择此项目的 UE 引擎', 'Select the UE engine for this project') });
      if (item) return item;
    }
    throw new Error(tr('未选择引擎。请先使用“切换 UE5 引擎版本”，或配置 iXenaUnrealTools.engineRoots。',
      'No engine selected. Use Select UE5 Engine or configure iXenaUnrealTools.engineRoots.'));
  }
  private async pipeline(action: string): Promise<void> {
    this.requireTrusted();
    const target = this.target;
    if (!target) throw new Error(tr('请先新建或选择本地化目标。', 'Create or select a localization target first.'));
    if (this.hooks.buildBusy()) throw new Error(tr('构建任务正在执行，请结束后运行本地化。', 'A build is running. Finish it before running localization.'));
    const dirty = vscode.workspace.textDocuments.find(doc => doc.isDirty && target.poFiles.some(file => pathKey(file.path) === pathKey(doc.uri.fsPath)));
    if (dirty) throw new Error(tr('请先保存 PO：{0}', 'Save this PO first: {0}', dirty.uri.fsPath));
    let actions: Action[];
    const hasPo = target.poFiles.length > 0;
    if (action === 'gatherExport' || action === 'gather') {
      // Gather 不写 PO。已有 manifest 时先导入；首次恢复只有 PO 的目标，则先 Gather 再 Import。
      const manifest = (await fs.readdir(target.dataDirectory).catch(() => [])).some(name => /\.manifest$/i.test(name));
      actions = hasPo ? (manifest ? ['import', 'gather'] : ['gather', 'import']) : ['gather'];
      if (action === 'gatherExport') actions.push('export');
    } else if (action === 'importCompile' || action === 'compile') actions = hasPo ? ['import', 'compile'] : ['compile'];
    else if (action === 'export') actions = hasPo ? ['import', 'export'] : ['export'];
    else if (action === 'import') actions = ['import'];
    else throw new Error('Unsupported localization action');
    for (const step of actions) {
      if (!target.configs[step] || !await fileExists(target.configs[step]!))
        throw new Error(tr('缺少 {0} 配置。请在 UE 本地化面板执行相应操作生成配置，或在此新建受管理目标。',
          'Missing {0} config. Run that action in the UE Localization Dashboard to generate it, or create a managed target here.', step));
    }
    const engine = await this.chooseEngine(target.projectPath);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archiveDir = path.join(path.dirname(target.projectPath), 'Saved', 'iXenaUnrealTools', 'LocalizationRuns', stamp);
    await fs.mkdir(archiveDir, { recursive: true });
    // 每次运行前备份可编辑 PO；引擎失败或被停止后，译文仍有独立副本。
    for (const po of target.poFiles) {
      const backup = path.join(archiveDir, 'PO', safeName(po.culture), path.basename(po.path));
      await fs.mkdir(path.dirname(backup), { recursive: true }); await fs.copyFile(po.path, backup);
    }
    const steps: PreparedTask[] = actions.map((step, index) => {
      const command = runnerCommand(engine, target.projectPath, target.configs[step]!);
      return { projectPath: target.projectPath, label: `Localization · ${target.name} · ${step}`,
        scope: vscode.workspace.getWorkspaceFolder(vscode.Uri.file(target.projectPath)) ?? vscode.TaskScope.Workspace,
        process: command.executable, args: [...command.args, `-abslog=${path.join(archiveDir, `${index + 1}-${step}.log`)}`],
        cwd: path.dirname(target.projectPath), problemMatchers: [] };
    });
    this.status = tr('执行本地化：{0}；实时输出见终端。', 'Running localization: {0}; live output is in the terminal.', actions.join(' → '));
    void this.panel?.webview.postMessage({ type: 'status', busy: true, message: this.status });
    this.pipelineRunning = true;
    try {
      const result = await this.hooks.runTask(this.status, steps);
      this.status = result.status === 'succeeded' ? tr('本地化操作完成。日志与 PO 备份：{0}', 'Localization completed. Logs and PO backups: {0}', archiveDir)
        : result.status === 'cancelled' ? tr('已停止；日志与 PO 备份：{0}', 'Stopped. Logs and PO backups: {0}', archiveDir)
        : tr('本地化失败（退出码 {0}）；后续步骤未运行。日志：{1}', 'Localization failed (exit {0}); later steps did not run. Logs: {1}', result.exitCode ?? '?', archiveDir);
      this.hooks.log(this.status); await this.scan();
    } finally { this.pipelineRunning = false; }
  }

  private async newTarget(): Promise<void> {
    this.requireTrusted();
    const projects = await discoverProjects(await this.projectPaths());
    const scopes = projects.flatMap(project => project.scopes.map(scope => ({ label: `${project.name} / ${scope.name}`,
      description: scope.kind, scope })));
    if (!scopes.length) throw new Error(tr('工作区中未找到 .uproject。请打开 UE 项目目录后重试。', 'No .uproject found. Open a UE project folder and try again.'));
    const selected = scopes.length === 1 ? scopes[0] : await vscode.window.showQuickPick(scopes, { title: tr('选择主项目或项目插件', 'Select a project or project plugin') });
    if (!selected) return;
    const name = await vscode.window.showInputBox({ title: tr('本地化目标名称', 'Localization target name'), value: 'Game',
      prompt: tr('创建独立受 iXena 管理的配置，不覆盖 UE Dashboard 的目标设置。', 'Creates independent iXena-managed configs; does not replace UE Dashboard target settings.'),
      validateInput: value => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? undefined : tr('使用字母开头的英文字母、数字和下划线。', 'Start with a letter; use ASCII letters, digits and underscores.') });
    if (!name) return;
    const native = await vscode.window.showInputBox({ title: tr('源语言（Native Culture）', 'Native culture'), value: 'en',
      prompt: tr('例如 en、zh-Hans、ja；应与实际源文语言一致。', 'For example en, zh-Hans, ja. Match the language of your source text.') });
    if (!native) return;
    const cultures = await vscode.window.showInputBox({ title: tr('目标语言，用逗号分隔', 'Target cultures, comma separated'), value: `${native},zh-Hans`,
      prompt: tr('例如 en,zh-Hans,ja；源语言会自动保留。', 'For example en,zh-Hans,ja. The native culture is always retained.') });
    if (!cultures) return;
    const plan = await createTargetPlan(selected.scope.projectPath, selected.scope.directory, name, native.trim(), cultures.split(/[,，]/).map(v => v.trim()).filter(Boolean));
    for (const file of plan.files) if (await fileExists(file.path)) throw new Error(tr('目标文件已存在，未覆盖：{0}', 'A target file already exists and was not overwritten: {0}', file.path));
    const created: string[] = [];
    try {
      for (const file of plan.files) { await fs.mkdir(path.dirname(file.path), { recursive: true }); await fs.writeFile(file.path, file.content, { encoding: 'utf8', flag: 'wx' }); created.push(file.path); }
    } catch (error) { for (const file of created) await fs.unlink(file).catch(() => {}); throw error; }
    await this.scan(); this.targetId = plan.target.id; this.culture = undefined; await this.loadSelected();
    this.status = tr('目标已创建。请采集并导出；加载路径与打包语言仍需在 UE 中配置。', 'Target created. Run Gather & Export; configure runtime loading paths and packaging cultures in UE.');
  }
  private async addCulture(): Promise<void> {
    this.requireTrusted();
    const target = this.target; if (!target) return;
    if (!target.managed) throw new Error(tr('此目标由 UE Dashboard 管理，请在那里添加语言并导出，然后重新扫描；避免 Dashboard 下次操作覆盖配置。',
      'This target is managed by the UE Dashboard. Add the culture and export there, then rescan, so future Dashboard actions do not overwrite it.'));
    const culture = await vscode.window.showInputBox({ title: tr('添加目标语言', 'Add a target culture'), prompt: tr('例如 zh-Hans、en、ja、fr', 'For example zh-Hans, en, ja, fr') });
    if (!culture) return;
    const plan = await addCulturePlan(target, culture.trim());
    const edit = new vscode.WorkspaceEdit(); const documents: vscode.TextDocument[] = [];
    for (const file of plan.files) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file.path));
      const expected = (file as { expectedText?: string }).expectedText;
      if (doc.isDirty || (expected !== undefined && doc.getText() !== expected)) throw new Error(tr('配置已被修改，请先保存并重新扫描：{0}', 'The config changed. Save it and rescan first: {0}', file.path));
      edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), file.content); documents.push(doc);
    }
    if (!await vscode.workspace.applyEdit(edit)) throw new Error(tr('未能更新语言配置。', 'Could not update culture configs.'));
    for (const doc of documents) if (!await doc.save()) throw new Error(tr('配置保存失败：{0}', 'Could not save config: {0}', doc.uri.fsPath));
    await this.scan(); this.culture = culture.trim(); await this.loadSelected();
    this.status = tr('语言已添加。请采集并导出以生成对应 PO。', 'Culture added. Run Gather & Export to generate its PO.');
  }

  dispose(): void {
    this.disposed = true; if (this.timer) clearTimeout(this.timer);
    this.panel?.dispose(); for (const disposable of this.subscriptions) disposable.dispose();
  }
}
