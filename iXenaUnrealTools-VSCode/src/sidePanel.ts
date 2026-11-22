import { t, tr, onDidChangeLanguage } from './i18n';
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import {
  discoverProjects, UeProject, UeScope, UeModule, UeLog, findLogs,
  isDirectory, listFiles, normalizePanes, PaneDefinition, resolvePaneRoot,
  sectionOrder, sectionPaths, extraPaths
} from './ueWorkspace';

const P = 'iXenaUnrealTools';
export interface ExplorerState {
  projects: UeProject[];
  panes: PaneDefinition[];
  enabled: boolean;
  scopeId: string;
}

export class UnrealTreeNode {
  constructor(public readonly label: string,
    public readonly type: 'group' | 'directory' | 'file' | 'module' | 'descriptor' | 'log' | 'action' | 'note',
    public readonly children?: () => Promise<UnrealTreeNode[]>,
    public readonly fsPath?: string,
    public readonly module?: UeModule,
    public readonly log?: UeLog,
    public readonly commandId?: string,
    public readonly description?: string,
    public readonly iconName?: string) {}
}

class Provider implements vscode.TreeDataProvider<UnrealTreeNode> {
  private readonly emitter = new vscode.EventEmitter<UnrealTreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(private readonly roots: () => Promise<UnrealTreeNode[]>) {}
  getTreeItem(node: UnrealTreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, node.children ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.description = node.description;
    item.tooltip = node.fsPath ?? node.description ?? node.label;
    item.contextValue = node.type === 'module' ? 'ixenaModule' : node.type === 'log' ? 'ixenaLog'
      : node.type === 'descriptor' ? 'ixenaDescriptor' : node.type;
    if (node.fsPath) {
      item.resourceUri = vscode.Uri.file(node.fsPath);
      if (node.type === 'directory' || node.type === 'file' || node.type === 'module') {
        item.iconPath = undefined; // 文件使用 VSCode 原生主题图标 / 文件关联图标
      }
    }
    if (node.iconName) { item.iconPath = new vscode.ThemeIcon(node.iconName); }
    if (node.commandId) {
      item.command = { title: node.label, command: node.commandId,
        arguments: node.type === 'module' || node.type === 'log' || node.type === 'descriptor' ? [node] : [] };
    } else if (node.fsPath && !node.children && (node.type === 'file' || node.type === 'module')) {
      item.command = { command: 'vscode.open', title: node.label, arguments: [vscode.Uri.file(node.fsPath)] };
    }
    return item;
  }
  async getChildren(node?: UnrealTreeNode): Promise<UnrealTreeNode[]> { return node?.children ? node.children() : node ? [] : this.roots(); }
  refresh(): void { this.emitter.fire(undefined); }
  dispose(): void { this.emitter.dispose(); }
}

export interface PanelHooks {
  selectedProject(): string | undefined;
  output(message: string): void;
}

/** 侧面板视图数据均按需读取；不改变引擎或者项目目录。 */
export class UnrealSidePanel implements vscode.Disposable {
  private state: ExplorerState = { projects: [], panes: [], enabled: false, scopeId: 'configured' };
  private readonly providers: { explorer: Provider; rules: Provider; logs: Provider; actions: Provider };
  private readonly views: vscode.TreeView<UnrealTreeNode>[];
  private readonly disposables: vscode.Disposable[] = [];
  constructor(private readonly context: vscode.ExtensionContext, private readonly hooks: PanelHooks) {
    this.providers = {
      explorer: new Provider(() => this.explorerRoots()),
      rules: new Provider(() => this.ruleRoots()),
      logs: new Provider(() => this.logRoots()),
      actions: new Provider(() => this.actionRoots())
    };
    this.views = [
      vscode.window.createTreeView('ixenaUnrealTools.explorer', { treeDataProvider: this.providers.explorer, showCollapseAll: true }),
      vscode.window.createTreeView('ixenaUnrealTools.rules', { treeDataProvider: this.providers.rules, showCollapseAll: true }),
      vscode.window.createTreeView('ixenaUnrealTools.logs', { treeDataProvider: this.providers.logs, showCollapseAll: true }),
      vscode.window.createTreeView('ixenaUnrealTools.actions', { treeDataProvider: this.providers.actions })
    ];
    this.disposables.push(...this.views, ...Object.values(this.providers));
    this.disposables.push(onDidChangeLanguage(() => { void this.refresh(false).catch(error => this.hooks.output(String(error))); }));
    this.disposables.push(vscode.commands.registerCommand(`${P}.selectExplorerScope`, () => this.selectScope()));
    this.disposables.push(vscode.commands.registerCommand(`${P}.selectRuleFile`, () => this.selectRuleFile()));
    this.disposables.push(vscode.commands.registerCommand(`${P}.refreshSidePanel`, () => this.refresh(true)));
    this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration(`${P}.explorer`) || event.affectsConfiguration('multiExplorer.panes')) { void this.refresh(true); }
    }));
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void this.refresh(true)));
    const watcher = vscode.workspace.createFileSystemWatcher('**/{*.uproject,*.uplugin,*.Build.cs,*.Target.cs}');
    this.disposables.push(watcher, watcher.onDidChange(() => void this.refresh(true)),
      watcher.onDidCreate(() => void this.refresh(true)), watcher.onDidDelete(() => void this.refresh(true)));
  }
  get projects(): UeProject[] { return this.state.projects; }
  get modules(): UeModule[] { return this.state.projects.flatMap(project => project.scopes.flatMap(scope => scope.modules)); }
  get currentProject(): UeProject | undefined {
    const preferred = this.hooks.selectedProject();
    return this.projects.find(project => path.normalize(project.projectPath).toLowerCase() === path.normalize(preferred ?? '').toLowerCase())
      ?? (this.projects.length === 1 ? this.projects[0] : undefined);
  }

  private configuredPanes(): PaneDefinition[] {
    const userConfig = vscode.workspace.getConfiguration(P);
    const explicit = userConfig.inspect<unknown>('explorer.panes');
    const specific = explicit?.workspaceValue ?? explicit?.workspaceFolderValue;
    // 显式设为 [] 即禁用；否则兼容已配置的 multiExplorer.panes，无需双份维护。
    if (specific !== undefined) { return normalizePanes(specific); }
    const legacy = vscode.workspace.getConfiguration('multiExplorer').inspect<unknown>('panes');
    return normalizePanes(legacy?.workspaceValue ?? legacy?.workspaceFolderValue);
  }

  async refresh(discover = true): Promise<void> {
    const panes = this.configuredPanes();
    let projects = this.state.projects;
    if (discover) {
      const candidate = new Set<string>();
      const preferred = this.hooks.selectedProject();
      if (preferred) { candidate.add(preferred); }
      // 从项目根目录读取 .uproject，避免仅凭工作区文件夹顺序推断项目。
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (folder.uri.scheme !== 'file') { continue; }
        for (const item of await fs.readdir(folder.uri.fsPath, { withFileTypes: true }).catch(() => [])) {
          if (item.isFile() && /\.uproject$/i.test(item.name)) { candidate.add(path.join(folder.uri.fsPath, item.name)); }
        }
      }
      for (const project of this.state.projects) { candidate.add(project.projectPath); }
      try { projects = await discoverProjects([...candidate]); }
      catch (error) { this.hooks.output(t("工程扫描失败：{0}", String(error))); }
    }
    const possible = new Set(['configured', ...projects.flatMap(p => [
      `all-plugins:${p.projectPath}`, ...p.scopes.map(s => s.id)
    ])]);
    const stored = this.context.workspaceState.get<string>('explorerScope');
    const selection = this.state.scopeId !== 'configured' && possible.has(this.state.scopeId) ? this.state.scopeId
      : stored && possible.has(stored) ? stored : 'configured';
    this.state = { projects, panes, enabled: panes.length > 0, scopeId: selection };
    await vscode.commands.executeCommand('setContext', `${P}.explorerConfigured`, this.state.enabled);
    this.views[0].description = selection === 'configured' ? t("工作区分栏") : projects.flatMap(p => p.scopes).find(s => s.id === selection)?.name ?? t("全部插件");
    Object.values(this.providers).forEach(provider => provider.refresh());
  }

  private async fileChildren(directory: string): Promise<UnrealTreeNode[]> {
    const showHidden = vscode.workspace.getConfiguration(P).get<boolean>('explorer.showHidden', false);
    const children = await listFiles(directory, showHidden);
    return children.map(entry => entry.directory ? this.directoryNode(entry.name, entry.fullPath)
      : new UnrealTreeNode(entry.name, 'file', undefined, entry.fullPath));
  }
  private directoryNode(label: string, directory: string): UnrealTreeNode {
    return new UnrealTreeNode(label, 'directory', () => this.fileChildren(directory), directory);
  }
  private note(label: string): UnrealTreeNode { return new UnrealTreeNode(label, 'note', undefined, undefined, undefined, undefined, undefined, 'info'); }
  private group(label: string, children: () => Promise<UnrealTreeNode[]>, iconName = 'folder'): UnrealTreeNode {
    return new UnrealTreeNode(label, 'group', children, undefined, undefined, undefined, undefined, undefined, iconName);
  }

  private async configuredRoots(): Promise<UnrealTreeNode[]> {
    const folderRefs = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file')
      .map(folder => ({ name: folder.name, directory: folder.uri.fsPath }));
    const workspaceDirectory = vscode.workspace.workspaceFile?.scheme === 'file'
      ? path.dirname(vscode.workspace.workspaceFile.fsPath) : folderRefs[0]?.directory ?? process.cwd();
    const defaultFolder = this.state.projects.length === 1 ? this.state.projects[0].directory : undefined;
    return this.state.panes.map(pane => this.group(pane.label, async () => {
      const roots: string[] = [];
      for (const raw of pane.roots) {
        try {
          const resolved = resolvePaneRoot(raw, folderRefs, workspaceDirectory, defaultFolder);
          if (await isDirectory(resolved)) { roots.push(resolved); }
          else { this.hooks.output(t("资源分栏路径不存在：{0}", resolved)); }
        } catch (error) { this.hooks.output(t("资源分栏 {0}：{1}", pane.label, String(error))); }
      }
      if (!roots.length) { return [this.note(t("没有可读取的目录，请检查工作区设置。"))]; }
      if (roots.length === 1) { return this.fileChildren(roots[0]); }
      return roots.map(root => this.directoryNode(path.basename(root) || root, root));
    }, 'root-folder'));
  }

  private async scopeRoots(scope: UeScope): Promise<UnrealTreeNode[]> {
    const result: UnrealTreeNode[] = [];
    for (const section of sectionOrder) {
      const paths = await sectionPaths(scope, section);
      if (!paths.length) { continue; }
      result.push(this.group(section, async () => paths.length === 1 ? this.fileChildren(paths[0])
        : paths.map(dir => this.directoryNode(path.basename(path.dirname(dir)), dir)), section === 'Public' ? 'symbol-interface'
        : section === 'Private' ? 'lock' : 'folder'));
    }
    const showContent = vscode.workspace.getConfiguration(P).get<boolean>('explorer.showContent', false);
    for (const extra of await extraPaths(scope, showContent)) {
      result.push(this.group(extra.name, () => this.fileChildren(extra.fullPath)));
    }
    if (!result.length) { result.push(this.note(t("该目录尚未发现 Public、Private 等源码目录。"))); }
    return result;
  }

  private async explorerRoots(): Promise<UnrealTreeNode[]> {
    if (!this.state.enabled) { return []; }
    if (this.state.scopeId === 'configured') { return this.configuredRoots(); }
    const targetScope = this.projects.flatMap(project => project.scopes).find(scope => scope.id === this.state.scopeId);
    if (targetScope) { return this.scopeRoots(targetScope); }
    const project = this.projects.find(p => `all-plugins:${p.projectPath}` === this.state.scopeId);
    if (project) { return project.scopes.filter(scope => scope.kind === 'plugin')
      .map(scope => this.group(scope.name, () => this.scopeRoots(scope), 'package')); }
    return [];
  }

  async selectScope(): Promise<void> {
    if (!this.state.enabled) {
      void vscode.window.showInformationMessage(t("请先在 Project.code-workspace 中设置 iXenaUnrealTools.explorer.panes 或 multiExplorer.panes，资源分栏才会显示。"));
      return;
    }
    const items: Array<vscode.QuickPickItem & { id: string }> = [
      { label: t("$(layout) 工作区自定义分栏"), description: t("使用 workspace 预设 Public / Private / UI 等栏目"), id: 'configured' }
    ];
    for (const project of this.projects) {
      items.push({ label: t("$(root-folder) {0} · 主项目", project.name), id: project.scopes[0].id });
      if (project.scopes.length > 1) { items.push({ label: t("$(package) {0} · 所有插件", project.name), id: `all-plugins:${project.projectPath}` }); }
      for (const plugin of project.scopes.slice(1)) {
        items.push({ label: `$(extensions) ${plugin.name}`, description: project.name, id: plugin.id });
      }
    }
    const selected = await vscode.window.showQuickPick(items, {
      title: t("iXena Unreal Tools · 切换资源管理范围"), placeHolder: t("主项目 / 全部插件 / 指定插件 / 工作区自定义分栏")
    });
    if (!selected) { return; }
    this.state.scopeId = selected.id;
    await this.context.workspaceState.update('explorerScope', selected.id);
    this.views[0].description = selected.label.replace(/\$\([^)]+\)\s*/g, '');
    this.providers.explorer.refresh();
  }

  /** 将描述文件与 Target / Build 规则放在同一个主项目 / 插件目录下。 */
  private async scopeDescriptors(project: UeProject, scope: UeScope): Promise<string[]> {
    if (scope.kind === 'project') { return [project.projectPath]; }
    return (await fs.readdir(scope.directory, { withFileTypes: true }).catch(() => []))
      .filter(entry => entry.isFile() && /\.uplugin$/i.test(entry.name))
      .map(entry => path.join(scope.directory, entry.name)).sort((a, b) => a.localeCompare(b));
  }

  private descriptorNode(filename: string, scope: UeScope): UnrealTreeNode {
    return new UnrealTreeNode(path.basename(filename), 'descriptor', undefined, filename, undefined, undefined,
      `${P}.editDescriptor`, scope.kind === 'project' ? t("主项目 · 可视化编辑") : t("插件 · 可视化编辑"),
      scope.kind === 'project' ? 'edit' : 'extensions');
  }

  private moduleNode(module: UeModule): UnrealTreeNode {
    return new UnrealTreeNode(`${module.name}.Build.cs`, 'module', undefined, module.rulePath, module,
      undefined, undefined, t("点击打开源码；右侧图标可视化编辑依赖"));
  }

  private async scopeRuleChildren(project: UeProject, scope: UeScope): Promise<UnrealTreeNode[]> {
    const descriptors = (await this.scopeDescriptors(project, scope)).map(filename => this.descriptorNode(filename, scope));
    const children: UnrealTreeNode[] = [...descriptors];
    if (scope.kind === 'project' || scope.targets.length) {
      children.push(this.group('Targets · Target.cs', async () => scope.targets.length
        ? scope.targets.map(filename => new UnrealTreeNode(path.basename(filename), 'file', undefined, filename))
        : [this.note(t("未发现 Target.cs"))], 'symbol-class'));
    }
    children.push(this.group('Modules · Build.cs', async () => scope.modules.length
      ? scope.modules.map(module => this.moduleNode(module)) : [this.note(t("未发现 Build.cs"))], 'references'));
    return children.length ? children : [this.note(t("没有发现可编辑的工程规则文件"))];
  }

  private async rulesForProject(project: UeProject): Promise<UnrealTreeNode[]> {
    const root = project.scopes[0];
    if (!root) { return []; }
    const result = [this.group(t("主项目 · {0}", project.name),
      () => this.scopeRuleChildren(project, root), 'root-folder')];
    const plugins = project.scopes.slice(1);
    if (plugins.length) {
      result.push(this.group(t("插件 · {0}", plugins.length), async () => plugins.map(plugin =>
        this.group(plugin.name, () => this.scopeRuleChildren(project, plugin), 'extensions')), 'extensions'));
    }
    return result;
  }

  private async ruleRoots(): Promise<UnrealTreeNode[]> {
    if (this.projects.length === 1) { return this.rulesForProject(this.projects[0]); }
    return this.projects.map(project => this.group(project.name, () => this.rulesForProject(project), 'root-folder'));
  }

  /** 列出本工作区所有可编辑的 .uproject/.uplugin 与构建规则，避免手动浏览目录。 */
  private async selectRuleFile(): Promise<void> {
    type RulePick = vscode.QuickPickItem & { filename: string; actionKind: 'descriptor' | 'dependencies' | 'source'; module?: UeModule };
    const items: RulePick[] = [];
    for (const project of this.projects) {
      for (const scope of project.scopes) {
        const scopeName = scope.kind === 'project' ? t("主项目 · {0}", project.name) : t("插件 · {0} ({1})", scope.name, project.name);
        for (const filename of await this.scopeDescriptors(project, scope)) {
          items.push({ label: `$(edit) ${path.basename(filename)}`, description: scopeName,
            detail: t("可视化编辑 Unreal 描述文件"), filename, actionKind: 'descriptor' });
        }
        for (const target of scope.targets) {
          items.push({ label: `$(symbol-class) ${path.basename(target)}`, description: scopeName,
            detail: t("打开 Target.cs 源码"), filename: target, actionKind: 'source' });
        }
        for (const module of scope.modules) {
          items.push({ label: `$(references) ${module.name}.Build.cs`, description: scopeName,
            detail: t("可视化编辑 Public / Private 模块依赖"), filename: module.rulePath,
            module, actionKind: 'dependencies' });
        }
      }
    }
    if (!items.length) {
      void vscode.window.showInformationMessage(t("未找到 .uproject、.uplugin、Target.cs 或 Build.cs，请先刷新 UE 工程。"));
      return;
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: t("iXena Unreal · 选择工程描述或模块规则"),
      placeHolder: t("搜索主项目、插件、.uproject、.uplugin、Target.cs 或 Build.cs"),
      matchOnDescription: true, matchOnDetail: true
    });
    if (!picked) { return; }
    if (picked.actionKind === 'descriptor') {
      await vscode.commands.executeCommand(`${P}.editDescriptor`, vscode.Uri.file(picked.filename));
    } else if (picked.actionKind === 'dependencies') {
      await vscode.commands.executeCommand(`${P}.editDependencies`, new UnrealTreeNode(
        path.basename(picked.filename), 'module', undefined, picked.filename, picked.module));
    } else {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(picked.filename));
    }
  }

  private async logRoots(): Promise<UnrealTreeNode[]> {
    const items = await findLogs(this.projects, process.env.LOCALAPPDATA);
    const groups = [
      { title: 'UnrealBuildTool', kind: 'UBT' as const },
      { title: t("项目日志"), kind: '项目' as const }
    ];
    return groups.map(group => this.group(group.title, async () => items.filter(item => item.kind === group.kind).slice(0, 80)
      .map(item => new UnrealTreeNode(item.name, 'log', undefined, item.fullPath, undefined, item,
        `${P}.tailLog`, `${new Date(item.mtimeMs).toLocaleString()} · ${(item.size / 1024).toFixed(0)} KB`, 'output')), 'book'));
  }

  private async actionRoots(): Promise<UnrealTreeNode[]> {
    return [
      this.group(t("编译与调试"), async () => [
        this.action(t("选择构建配置"), 'selectConfiguration', 'settings-gear'),
        this.action(t("切换 UE5 引擎版本"), 'selectEngine', 'layers'),
        this.action(t("智能编译 / 停止"), 'toggleBuild', 'tools'),
        this.action(t("Live Coding 热更新"), 'liveCoding', 'zap'),
        this.action(t("标准 UBT 编译"), 'buildStandard', 'tools'),
        this.action(t("选择编译模式"), 'selectBuildMode', 'settings-gear'),
        this.action(t("重建"), 'rebuild', 'refresh'),
        this.action(t("清理"), 'clean', 'clear-all'),
        this.action(t("开始调试"), 'debug', 'debug-start')
      ], 'tools'),
      this.group(t("Unreal Engine 工具"), async () => [
        this.action(tr("本地化工作台", "Localization Workbench"), 'openLocalization', 'globe'),
        this.action(tr("初始化引擎插件", "Initialize Engine Plugin"), 'initializeEnginePlugin', 'extensions'),
        this.action(t("新建 Unreal C++ 类"), 'newClass', 'new-file'),
        this.action(t("启动 Unreal Editor"), 'launchEditor', 'play'),
        this.action(t("生成 VSCode 工程文件"), 'generateProjectFiles', 'file-code'),
        this.action(t("单独刷新 UHT"), 'refreshUht', 'refresh-cw'),
        this.action(t("修复 UE IntelliSense"), 'fixIntelliSense', 'symbol-color'),
        this.action(t("选择工程描述 / Target / Module"), 'selectRuleFile', 'list-selection'),
        this.action(t("可视化模块依赖"), 'editDependencies', 'symbol-interface'),
        this.action(t("项目 / 插件描述可视化编辑"), 'editDescriptor', 'edit'),
        this.action(t("复制构建命令"), 'copyBuildCommand', 'copy'),
        this.action(t("打开项目目录"), 'openProjectDirectory', 'folder-opened'),
        this.action(t("刷新 UE 工程"), 'refreshSidePanel', 'sync'),
        this.action(t("上次构建日志"), 'openLastBuildLog', 'file-text'),
        this.action(t("插件日志"), 'showLog', 'output'),
        this.action(tr("界面语言", "Interface Language"), 'selectLanguage', 'globe')
      ], 'rocket'),
      ...(process.platform === 'win32' ? [this.group(t("Windows 资源管理器"), async () => [
        this.action(t("注册 / 更新系统右键菜单"), 'registerExplorerMenu', 'add'),
        this.action(t("查看系统菜单状态"), 'explorerMenuStatus', 'info'),
        this.action(t("移除系统右键菜单"), 'removeExplorerMenu', 'remove')
      ], 'window')] : [])
    ];
  }
  private action(label: string, command: string, iconName: string): UnrealTreeNode {
    return new UnrealTreeNode(label, 'action', undefined, undefined, undefined, undefined, `${P}.${command}`, undefined, iconName);
  }
  dispose(): void { this.disposables.forEach(disposable => disposable.dispose()); }
}
