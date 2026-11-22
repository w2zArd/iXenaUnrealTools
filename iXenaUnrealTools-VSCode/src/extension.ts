import { t, tr, configureI18n, onDidChangeLanguage } from './i18n';
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { access, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { UnrealSidePanel, UnrealTreeNode } from './sidePanel';
import { showDependencyEditor } from './dependencyEditor';
import { editorExecutable, projectFilesArguments, powershellCommand } from './ueExtras';
import { findLogs, UeModule } from './ueWorkspace';
import { NativeTaskRunner, PreparedTask, RunResult } from './taskRunner';
import { archiveUbtLog } from './buildLogs';
import { DescriptorEditorProvider, DESCRIPTOR_VIEW_TYPE, openDescriptor } from './descriptorEditor';
import { ExplorerIntegration } from './explorerIntegration';
import { switchHeaderSource } from './sourceSwitcher';
import { decideBuild, explainLiveCodingResult, BuildMode } from './liveCoding';
import { probeWindowsEditor } from './editorProcesses';
import { EditorCommunication } from './editorCommunication';
import { createUnrealClass } from './classWizard';
import { LocalizationManager } from './localizationManager';
import { resolveBuildTool, BuildToolInvocation, DotnetSelectionCancelledError } from './dotnetResolver';
import { discoverEngines, inspectEngine, readEngineVersion, readProjectEngineAssociation,
  engineAssociationMismatch, EngineInstallation, isUhtRelevantHeader, pathKey, optionalPathKey, chooseEngineRoot, uhtArguments, versionName } from './engineSupport';
import { validatePlan } from './ueTaskModel';
import {
  BuildConfiguration, TaskEntry, LaunchEntry, WorkspaceCatalogue,
  loadCatalogue, matchingLaunches, nativePresentation, envGet, withoutPreLaunchTask
} from './workspaceModel';

const PREFIX = 'iXenaUnrealTools';
let controller: BuildController | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  configureI18n(vscode.workspace.getConfiguration(PREFIX).get("language", "auto"), vscode.env.language);
  const descriptorProvider = new DescriptorEditorProvider(context);
  context.subscriptions.push(descriptorProvider);
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(DESCRIPTOR_VIEW_TYPE,
    descriptorProvider, {
      supportsMultipleEditorsPerDocument: true, webviewOptions: { retainContextWhenHidden: true }
    }));
  controller = new BuildController(context);
  context.subscriptions.push(controller);
  await controller.initialize();
}

export function deactivate(): void { controller?.dispose(); controller = undefined; }

/** UI、工作区发现和构建准备；真正的执行/取消由 NativeTaskRunner 负责。 */
export class BuildController implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel('iXenaUnrealTools');
  private readonly subscriptions: vscode.Disposable[] = [this.output];
  private readonly runner = new NativeTaskRunner(message => this.log(message));
  private catalogue: WorkspaceCatalogue = { configurations: [], entries: [], launches: [], issues: [] };
  private selection?: BuildConfiguration;
  private readonly selector: vscode.StatusBarItem;
  private readonly buildButton: vscode.StatusBarItem;
  private readonly liveCodingButton: vscode.StatusBarItem;
  private liveCodingDispatching = false;
  private readonly debugButton: vscode.StatusBarItem;
  private readonly engineButton: vscode.StatusBarItem;
  private readonly engineChoices: EngineInstallation[] = [];
  private uhtSaveTimer?: ReturnType<typeof setTimeout>;
  private autoUhtRunning = false;
  private readonly menuButton: vscode.StatusBarItem;
  private refreshPromise?: Promise<void>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private lastResult?: { text: string; tooltip: string };
  private lastBuildLogPath?: string;
  private debugStarting = false;
  private readonly sidePanel: UnrealSidePanel;
  private readonly explorerIntegration: ExplorerIntegration;
  private readonly communication: EditorCommunication;
  private readonly localization: LocalizationManager;

  constructor(private readonly context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration(PREFIX);
    const alignment = config.get<string>('alignment', 'left') === 'right'
      ? vscode.StatusBarAlignment.Right : vscode.StatusBarAlignment.Left;
    const priority = config.get('priority', 100);
    this.selector = this.bar('configuration', t("iXenaUnrealTools 构建配置"), alignment, priority, 'selectConfiguration');
    this.buildButton = this.bar('build', t("iXenaUnrealTools 智能编译 / 停止"), alignment, priority - 2, 'toggleBuild');
    this.liveCodingButton = this.bar('liveCoding', t("iXenaUnrealTools Live Coding 热更新"), alignment, priority - 3, 'liveCoding');
    this.engineButton = this.bar('engine', t("iXenaUnrealTools UE5 引擎选择"), alignment, priority - 1, 'selectEngine');
    this.debugButton = this.bar('debug', t("iXenaUnrealTools 开始调试"), alignment, priority - 4, 'debug');
    this.menuButton = this.bar('menu', t("iXenaUnrealTools 构建操作"), alignment, priority - 5, 'menu');
    this.subscriptions.push(this.runner, this.runner.onDidChangeState(() => this.updateBar()));
    this.sidePanel = new UnrealSidePanel(context, { selectedProject: () => this.selection?.projectPath, output: message => this.log(message) });
    this.subscriptions.push(this.sidePanel);
    this.communication = new EditorCommunication(context, {
      preferredTarget: () => {
        try { return this.selection ? { projectPath: this.selection.projectPath, engineRoot: this.currentEngineRoot(this.selection) } : undefined; }
        catch { return undefined; }
      },
      projects: () => this.sidePanel.projects.map(project => project.projectPath),
      engines: () => [...this.engineChoices.map(engine => engine.root),
        ...(vscode.workspace.getConfiguration(PREFIX).get<string[]>('engineRoots', []) ?? []).filter(root => typeof root === 'string')],
      buildBusy: () => this.runner.isBusy || this.debugStarting,
      runTask: (label, tasks) => this.runner.run(label, async token => token.isCancellationRequested ? [] : tasks),
      changed: () => this.updateBar(), log: message => this.log(message)
    });
    this.subscriptions.push(this.communication);
    this.localization = new LocalizationManager(context, {
      projects: () => this.sidePanel.projects.map(project => project.projectPath),
      preferredProject: () => this.selection?.projectPath,
      engineForProject: projectPath => {
        const configuration = this.selection?.projectPath === projectPath ? this.selection
          : this.catalogue.configurations.find(item => item.projectPath === projectPath);
        try { return configuration ? this.currentEngineRoot(configuration) : undefined; }
        catch { return undefined; }
      },
      engines: () => [...this.engineChoices.map(engine => engine.root),
        ...(vscode.workspace.getConfiguration(PREFIX).get<string[]>('engineRoots', []) ?? [])],
      buildBusy: () => this.runner.isBusy || this.debugStarting || this.communication.isBusy,
      runTask: (label, steps) => this.runner.run(label, async token => token.isCancellationRequested ? [] : steps),
      stopTask: () => this.runner.cancel(), log: message => this.log(message)
    });
    this.subscriptions.push(this.localization);
    this.explorerIntegration = new ExplorerIntegration(context, {
      output: message => this.log(message), openDescriptor: uri => openDescriptor(uri)
    });
    this.explorerIntegration.initialize();
    this.subscriptions.push(this.explorerIntegration);
    const commands: Record<string, (...args: any[]) => unknown> = {
      selectConfiguration: () => this.selectConfiguration(),
      selectLanguage: () => this.selectLanguage(),
      selectEngine: () => this.selectEngine(),
      resetEngine: () => this.resetEngine(),
      refreshUht: () => this.refreshUht(false),
      fixIntelliSense: () => this.refreshUht(true),
      build: () => this.build('Build'),
      buildStandard: () => this.build('Build', true),
      liveCoding: () => this.compileLiveCoding(),
      newClass: (argument?: vscode.Uri | UnrealTreeNode) => createUnrealClass(argument, { projectPaths: this.sidePanel.projects.map(project => project.projectPath) }),
      selectBuildMode: () => this.selectBuildMode(),
      rebuild: () => this.build('Rebuild'),
      clean: () => this.build('Clean'),
      toggleBuild: () => this.runner.isBusy ? this.runner.cancel() : this.build('Build'),
      stop: () => this.runner.cancel(),
      debug: () => this.startDebug(),
      selectDebug: () => this.selectDebug(),
      refresh: () => this.refresh(true),
      showLog: () => this.output.show(true),
      openLastBuildLog: () => this.openLastBuildLog(),
      menu: () => this.showMenu(),
      openSource: () => this.openSource(),
      runOriginal: () => vscode.commands.executeCommand('workbench.action.tasks.runTask'),
      launchEditor: () => this.launchEditor(),
      generateProjectFiles: () => this.generateProjectFiles(),
      copyBuildCommand: () => this.copyBuildCommand(),
      openProjectDirectory: () => this.openProjectDirectory(),
      editDependencies: (node?: UnrealTreeNode) => this.editDependencies(node),
      editDescriptor: (argument?: vscode.Uri | UnrealTreeNode) => openDescriptor(
        argument && 'fsPath' in argument && !(argument instanceof vscode.Uri)
          ? argument.fsPath ? vscode.Uri.file(argument.fsPath) : undefined : argument as vscode.Uri | undefined),
      switchHeaderSource: (argument?: vscode.Uri | UnrealTreeNode) => switchHeaderSource(
        argument instanceof vscode.Uri ? argument : argument?.fsPath ? vscode.Uri.file(argument.fsPath) : undefined),
      registerExplorerMenu: () => this.explorerIntegration.register(),
      removeExplorerMenu: () => this.explorerIntegration.unregister(),
      explorerMenuStatus: () => this.explorerIntegration.showStatus(),
      tailLog: (node?: UnrealTreeNode) => this.tailLog(node)
    };
    for (const [name, callback] of Object.entries(commands)) {
      this.subscriptions.push(vscode.commands.registerCommand(`${PREFIX}.${name}`, async (...args: any[]) => {
        try { return await callback(...args); }
        catch (error) { await this.reportError(error); }
      }));
    }
    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration(`${PREFIX}.language`)) { configureI18n(vscode.workspace.getConfiguration(PREFIX).get('language', 'auto'), vscode.env.language); }
        if (event.affectsConfiguration(PREFIX) || event.affectsConfiguration('tasks') || event.affectsConfiguration('launch')
          || event.affectsConfiguration('terminal.integrated.env.windows')) { this.scheduleRefresh(); }
      }),
      vscode.workspace.onDidSaveTextDocument(document => {
        if (document.uri.toString() === vscode.workspace.workspaceFile?.toString()
          || /[\\/]\.vscode[\\/](tasks|launch)\.json$/i.test(document.uri.fsPath)) { this.scheduleRefresh(); }
        this.onHeaderSaved(document);
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh())
    );
    this.subscriptions.push(onDidChangeLanguage(() => this.updateBar()));
    // UE 重新生成工作区/任务文件时，刷新菜单，不改写生成结果。
    const watcher = vscode.workspace.createFileSystemWatcher('**/.vscode/{tasks,launch}.json');
    this.subscriptions.push(watcher, watcher.onDidCreate(() => this.scheduleRefresh()),
      watcher.onDidChange(() => this.scheduleRefresh()), watcher.onDidDelete(() => this.scheduleRefresh()));
    if (vscode.workspace.workspaceFile?.scheme === 'file') {
      const file = vscode.workspace.workspaceFile;
      const workspaceWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(path.dirname(file.fsPath), path.basename(file.fsPath))
      );
      this.subscriptions.push(workspaceWatcher, workspaceWatcher.onDidChange(() => this.scheduleRefresh()));
    }
  }

  async initialize(): Promise<void> {
    this.lastBuildLogPath = this.context.workspaceState.get<string>('lastBuildLogPath');
    this.log(tr("iXenaUnrealTools 0.7.0 已激活：UE 本地化工作台、PO 翻译编辑、自动导出与原有 Unreal 开发工具。", "iXenaUnrealTools 0.7.0 activated: UE Localization Workbench, PO translation editing, automatic exports and Unreal development tools."));
    try {
      await this.refresh(false);
    } catch (error) {
      // 资源发现或自定义设置异常不能使扩展整体失效；允许用户从命令面板重试。
      this.log(t("初始化失败：{0}", error instanceof Error ? error.stack ?? error.message : String(error)));
      this.updateBar();
      void vscode.window.showWarningMessage(t("iXenaUnrealTools 初始化未完成，请查看“输出 → iXenaUnrealTools”中的详细调用堆栈。"));
    }
  }

  private bar(id: string, name: string, alignment: vscode.StatusBarAlignment, priority: number, command: string): vscode.StatusBarItem {
    const item = vscode.window.createStatusBarItem(`${PREFIX}.${id}`, alignment, priority);
    item.name = name;
    item.command = `${PREFIX}.${command}`;
    this.subscriptions.push(item);
    return item;
  }

  private log(message: string): void {
    this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
    this.refreshTimer = setTimeout(() => void this.refresh(false).catch(error => this.log(String(error))), 400);
  }

  private async refresh(notify: boolean): Promise<void> {
    if (!this.refreshPromise) {
      this.refreshPromise = (async () => {
        this.catalogue = await loadCatalogue(message => this.log(message));
        const stored = this.selection?.id ?? this.context.workspaceState.get<string>('selectedConfiguration');
        this.selection = this.catalogue.configurations.find(value => value.id === stored);
        if (!this.selection) {
          const projects = new Set(this.catalogue.configurations.filter(value => optionalPathKey(value.projectPath))
            .map(value => `${value.origin.key}|${value.projectPath.toLowerCase()}`));
          // 只有一个明确项目时自动选 Development Editor；多个项目必须让用户选一次。
          if (projects.size === 1) { this.selection = this.catalogue.configurations[0]; }
        }
        if (this.selection) {
          this.log(t("当前构建配置：{0}；任务引擎：{1}；项目：{2}", this.selection.title, String(this.selection.tasks.Build?.spec.engineRoot ?? t("<缺失>")), String(this.selection.projectPath ?? t("<缺失>"))));
        }
        await this.sidePanel.refresh(true);
        try { await this.refreshEngineChoices(); }
        catch (error) {
          // 引擎版本候选扫描属于辅助功能，不应阻断已有 Build/Stop 与 Problems。
          this.engineChoices.splice(0, this.engineChoices.length);
          this.log(t("引擎候选扫描失败：{0}", error instanceof Error ? error.stack ?? error.message : String(error)));
        }
        this.updateBar();
      })().finally(() => { this.refreshPromise = undefined; });
    }
    await this.refreshPromise;
    if (notify) {
      const count = this.catalogue.configurations.length;
      const extra = this.catalogue.issues.length ? t("；{0} 条配置提示见输出日志", this.catalogue.issues.length) : '';
      void vscode.window.showInformationMessage(t("iXenaUnrealTools：已发现 {0} 个 UE 构建配置{1}。", count, extra));
    }
  }

  private updateBar(): void {
    if (this.disposed) { return; }
    const config = vscode.workspace.getConfiguration(PREFIX);
    this.selector.name = t("iXenaUnrealTools 构建配置");
    this.buildButton.name = t("iXenaUnrealTools 智能编译 / 停止");
    this.liveCodingButton.name = t("iXenaUnrealTools Live Coding 热更新");
    this.engineButton.name = t("iXenaUnrealTools UE5 引擎选择");
    this.debugButton.name = t("iXenaUnrealTools 开始调试");
    this.menuButton.name = t("iXenaUnrealTools 构建操作");
    const visible = this.runner.isBusy || this.liveCodingDispatching || this.catalogue.configurations.length > 0 || !config.get('hideWhenNoTasks', true);
    for (const item of [this.selector, this.engineButton, this.buildButton, this.liveCodingButton, this.debugButton, this.menuButton]) {
      if (visible) { item.show(); } else { item.hide(); }
    }
    if (!config.get('showDebugButton', true)) { this.debugButton.hide(); }
    this.selector.text = this.selection ? `$(settings-gear) ${this.selection.title} $(chevron-down)` : t("$(settings-gear) 选择 UE 配置");
    this.selector.tooltip = this.selection
      ? t("{0} · {1}\n{2}\n来源：{3}\n点击切换构建配置", this.selection.projectName, this.selection.platform, this.selection.target, this.selection.origin.uri.fsPath)
      : t("从已有的 UE 构建任务中选择配置");
    let engineRoot: string | undefined;
    try { engineRoot = this.selection ? this.currentEngineRoot(this.selection) : undefined; }
    catch { engineRoot = undefined; }
    const selectedKey = optionalPathKey(engineRoot);
    const engine = selectedKey ? this.engineChoices.find(item => optionalPathKey(item?.root) === selectedKey) : undefined;
    this.engineButton.text = `$(layers) ${engine?.version ? `UE${engine.version.major}.${engine.version.minor}` : 'UE5'} $(chevron-down)`;
    this.engineButton.tooltip = t("当前工具链：{0}\n只切换插件使用的引擎，不修改 .uproject 或工作区任务。", engineRoot ?? t("尚未选择项目"));
    const state = this.runner.state;
    const buildMode = vscode.workspace.getConfiguration(PREFIX, this.selection?.origin.folder?.uri).get<BuildMode>('build.mode', 'auto');
    this.liveCodingButton.text = this.liveCodingDispatching ? t("$(loading~spin) 热更新") : t("$(zap) 热更新");
    this.liveCodingButton.tooltip = tr("通过 iXena Editor 插件或 Epic Unreal MCP 请求 Live Coding，并等待实际编译结果。\n请在侧栏初始化连接并检查状态。", "Request Live Coding through the iXena Editor plugin or Epic Unreal MCP, then wait for the actual result.\nInitialize the connection and check its status in the sidebar.");
    if (process.platform !== 'win32') { this.liveCodingButton.hide(); }
    this.buildButton.backgroundColor = undefined;
    this.buildButton.color = undefined;
    if ((this.liveCodingDispatching || this.communication?.isBusy) && !this.runner.isBusy) {
      this.buildButton.text = t("$(loading~spin) UE 通讯");
      this.buildButton.tooltip = tr("正在检查连接或等待 UE 编译结果；Live Coding 由编辑器执行，此按钮不会强行结束 UE。", "Checking the connection or waiting for UE to compile. Live Coding runs inside the editor; this button will not forcibly stop UE.");
    } else if (state.status === 'stopping') {
      this.buildButton.text = t("$(loading~spin) 正在停止");
      this.buildButton.tooltip = t("已请求停止；收到任务结束事件后恢复按钮。");
    } else if (this.runner.isBusy) {
      this.buildButton.text = t("$(debug-stop) 停止");
      this.buildButton.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.buildButton.tooltip = t("{0}：{1}\n点击停止本插件的当前构建", state.status === 'preparing' ? t("准备中") : t("构建中"), state.label ?? '');
    } else {
      this.buildButton.text = this.lastResult?.text ?? t("$(tools) 编译");
      this.buildButton.tooltip = t("{0}\n点击开始{1}", this.lastResult?.tooltip ?? t("编译所选配置"), buildMode === 'auto' ? t("智能编译（编辑器运行时优先 Live Coding）") : t("标准 UBT 编译"));
    }
    this.debugButton.text = this.debugStarting ? t("$(loading~spin) 启动调试") : t("$(debug-start) 调试");
    this.debugButton.tooltip = t("使用与当前构建配置对应的已有 launch 配置；预编译成功后启动调试。");
    this.menuButton.text = '$(ellipsis)';
    this.menuButton.tooltip = t("智能编译、Live Coding、标准 UBT、重建、清理、刷新和查看日志");
    void vscode.commands.executeCommand('setContext', 'iXenaUnrealTools.busy', this.runner.isBusy);
    void vscode.commands.executeCommand('setContext', 'iXenaUnrealTools.communicationBusy', this.communication?.isBusy || this.liveCodingDispatching);
    void vscode.commands.executeCommand('setContext', 'iXenaUnrealTools.hasConfigurations', this.catalogue.configurations.length > 0);
  }

  private async selectLanguage(): Promise<void> {
    const selected = await vscode.window.showQuickPick([
      { label: tr('跟随 VSCode', 'Follow VSCode'), value: 'auto' },
      { label: '简体中文', value: 'zh-CN' },
      { label: 'English', value: 'en' }
    ], { title: tr('iXena · 界面语言', 'iXena · Interface Language'),
      placeHolder: tr('动态面板立即更新；命令和右键菜单跟随 VSCode 的显示语言', 'Dynamic panels update immediately; commands and context menus follow the VSCode display language') });
    if (!selected) return;
    const target = vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await vscode.workspace.getConfiguration(PREFIX).update('language', selected.value, target);
    configureI18n(selected.value, vscode.env.language);
  }

  private async selectConfiguration(): Promise<BuildConfiguration | undefined> {
    await this.refresh(false);
    if (!this.catalogue.configurations.length) {
      this.output.show(true);
      throw new Error(t("未找到可直接运行的 UE 任务。请打开 UE 生成的 .code-workspace，或查看 iXenaUnrealTools 输出中的具体原因。"));
    }
    const groups = new Map<string, BuildConfiguration[]>();
    for (const config of this.catalogue.configurations) {
      const key = `${config.origin.key}|${config.projectPath}|${config.target}`;
      const values = groups.get(key) ?? [];
      values.push(config);
      groups.set(key, values);
    }
    const items: Array<vscode.QuickPickItem & { config?: BuildConfiguration }> = [];
    for (const values of groups.values()) {
      items.push({ label: `${values[0].target} · ${values[0].origin.label}`, kind: vscode.QuickPickItemKind.Separator });
      for (const config of values) {
        items.push({ label: config.title,
          description: `${config.projectName} · ${config.platform}`,
          detail: `${config.target} — ${config.origin.label}`,
          picked: this.selection?.id === config.id,
          config });
      }
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: t("iXenaUnrealTools — 选择构建配置"), placeHolder: t("配置来自已有任务；不会创建不存在的 Client / Server 目标"),
      matchOnDescription: true, matchOnDetail: true
    });
    if (!picked?.config) { return undefined; }
    this.selection = picked.config;
    this.lastResult = undefined;
    await this.context.workspaceState.update('selectedConfiguration', picked.config.id);
    this.updateBar();
    return picked.config;
  }

  private async ensureSelection(): Promise<BuildConfiguration | undefined> {
    await this.refresh(false);
    return this.selection ?? this.selectConfiguration();
  }

  private checkBuildAllowed(): void {
    if (!vscode.workspace.isTrusted) { throw new Error(t("请先信任此工作区，再运行构建或调试。")); }
    if (process.platform !== 'win32') { throw new Error(t("此版本的 UE 直接构建适配 Windows / Win64。当前平台可以查看配置，但不会运行 Windows 构建命令。")); }
    if (this.runner.isBusy || this.liveCodingDispatching || this.communication?.isBusy) { throw new Error(t("已有构建或 Live Coding 触发操作正在进行。")); }
  }

  private async prepareTasks(entry: TaskEntry, token: vscode.CancellationToken): Promise<PreparedTask[]> {
    // 固定本次构建的配置快照；保存工作区或选择 SDK 期间的自动刷新只影响下一次构建。
    const entries = [...this.catalogue.entries];
    const plan = validatePlan(entry.spec, entries.map(value => value.spec));
    const sources = plan.map(spec => {
      const source = entries.find(value => value.spec === spec);
      if (!source) { throw new Error(t("构建任务已变化，请刷新后重试。")); }
      return source;
    });
    if (vscode.workspace.getConfiguration(PREFIX, entry.origin.folder?.uri).get('saveBeforeBuild', true)) {
      if (!await vscode.workspace.saveAll(false)) { throw new Error(t("部分文件未能保存，已取消构建。")); }
    }
    if (token.isCancellationRequested) { return []; }
    // TaskEntry 和 BuildConfiguration 是两种不同对象：当前操作必须使用任务中实际解析的
    // .uproject 路径及引擎根目录，而不是将 TaskEntry 当作配置传给 currentEngineRoot()。
    // 一个 Rebuild 计划包含 Clean + Build，整次操作锁定同一个引擎选择快照。
    const engineRoot = this.taskEngineRoot(entry);
    const result: PreparedTask[] = [];
    for (const source of sources) {
      if (token.isCancellationRequested) { return []; }
      const spec = source.spec;
      if (!/^Win64$/i.test(spec.platform)) { throw new Error(t("此版本仅适配 Win64，当前平台为 {0}。", spec.platform)); }
      await access(spec.projectPath).catch(() => { throw new Error(t("项目文件不存在：{0}", spec.projectPath)); });
      const tool = await this.resolveSelectedTool(source, engineRoot);
      if (token.isCancellationRequested) { return []; }
      const cleanEnv = this.buildTaskEnvironment(source, engineRoot, tool);
      result.push({
        original: source.native, projectPath: spec.projectPath,
        label: spec.label, scope: source.origin.folder ?? vscode.TaskScope.Workspace,
        process: tool.process, args: [...tool.prefixArgs, ...spec.args],
        cwd: engineRoot, env: cleanEnv,
        problemMatchers: spec.problemMatchers, presentation: nativePresentation(source.raw),
        group: spec.action === 'Clean' ? vscode.TaskGroup.Clean : vscode.TaskGroup.Build
      });
    }
    return result;
  }

  private async executeEntry(entry: TaskEntry): Promise<RunResult> {
    const startedAtMs = Date.now();
    this.lastResult = undefined;
    let result: RunResult;
    try { result = await this.runner.run(entry.spec.label, token => this.prepareTasks(entry, token)); }
    catch (error) {
      if (error instanceof DotnetSelectionCancelledError) { result = { status: 'cancelled' }; }
      else { throw error; }
    }
    // Ctrl+C 优先保留终端；若最终退回 terminate()，仍有日志快照兜底。
    // 这里保存 UBT 最新日志为独立文件，并提供命令/侧栏入口查看。
    // 不从 Tasks API 读取终端，因为官方 API 没有终端输出流。
    try {
      const logPath = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
        'UnrealBuildTool', 'Log.txt');
      const archived = await archiveUbtLog({
        sourcePath: logPath,
        destinationDirectory: path.join(this.context.globalStorageUri.fsPath, 'build-logs'),
        label: entry.spec.label,
        status: result.status,
        startedAtMs
      });
      if (archived) {
        this.lastBuildLogPath = archived;
        await this.context.workspaceState.update('lastBuildLogPath', archived);
        this.log(t("本次 UBT 日志已保存：{0}", archived));
        if (result.status === 'cancelled' && vscode.workspace.getConfiguration(PREFIX).get('openLogAfterStop', false)) {
          await this.openLastBuildLog();
        }
      } else if (result.status === 'cancelled') {
        this.log(t("停止时没有检测到本次更新的 UBT 日志，可能在 UBT 写日志之前就已停止。"));
      }
    } catch (error) {
      this.log(t("保留 UBT 日志失败（不影响构建结果）：{0}", String(error)));
    }
    this.lastResult = result.status === 'succeeded'
      ? { get text() { return t("$(check) 编译"); }, get tooltip() { return t("已完成：{0}", entry.spec.label); } }
      : result.status === 'cancelled'
        ? { get text() { return t("$(tools) 编译"); }, get tooltip() { return t("上次构建已取消"); } }
        : { get text() { return t("$(error) 编译"); }, get tooltip() { return t("构建未成功（退出码 {0}），请查看终端 / Problems", String(result.exitCode)); } };
    this.updateBar();
    if (result.status === 'failed') {
      void vscode.window.showWarningMessage(t("构建未成功。编译诊断保留在 Problems，完整输出见任务终端。"), t("查看 Problems")).then(choice => {
        if (choice) { return vscode.commands.executeCommand('workbench.actions.view.problems'); }
        return undefined;
      });
    }
    return result;
  }

  /** Smart Build: only the running editor may patch its own loaded DLLs. Never use UBT -LiveCoding flags directly. */
  private async build(action: 'Build' | 'Rebuild' | 'Clean', forceStandard = false): Promise<void> {
    this.checkBuildAllowed();
    if (this.debugStarting) { throw new Error(t("正在启动调试，请等待当前操作完成。")); }
    const selected = await this.ensureSelection();
    if (!selected) { return; }
    const entry = selected.tasks[action];
    if (!entry) { throw new Error(t("所选配置没有已有的 {0} 任务。请使用 UE 重新生成 VS Code 项目文件。", action)); }
    const mode = vscode.workspace.getConfiguration(PREFIX, entry.origin.folder?.uri).get<BuildMode>('build.mode', 'auto');
    if (action === 'Build' && !forceStandard && mode === 'auto' && /Editor$/i.test(selected.target)) {
      const result = await this.tryLiveCoding(selected);
      const decision = decideBuild('auto', selected.target, result);
      if (decision === 'live-coding') { return; }
      if (decision === 'blocked') { throw new Error(explainLiveCodingResult(result, selected.projectPath) + t("\n可用“标准 UBT 编译”绕过自动检测，但请先确认没有正在使用该项目 DLL 的编辑器。")); }
      this.log(t("智能编译：{0}，改用原有 UBT 编译任务。", result));
    }
    await this.executeEntry(entry);
  }

  private async compileLiveCoding(): Promise<void> {
    this.checkBuildAllowed();
    if (this.debugStarting) { throw new Error(t("正在启动调试，不能同时触发热更新。")); }
    const selected = await this.ensureSelection();
    if (!selected) { return; }
    if (!/Editor$/i.test(selected.target)) {
      throw new Error(t("Live Coding 热更新需要 Editor 构建配置，当前是 {0}。请切换到 Development Editor 或 DebugGame Editor。", selected.target));
    }
    const result = await this.tryLiveCoding(selected);
    if (result !== 'completed' && result !== 'dispatched') { throw new Error(explainLiveCodingResult(result, selected.projectPath)); }
  }

  private async tryLiveCoding(selected: BuildConfiguration): Promise<import('./liveCoding').LiveCodingResult> {
    this.liveCodingDispatching = true; this.updateBar();
    try {
      const engineRoot = this.currentEngineRoot(selected);
      await access(selected.projectPath);
      const state = await probeWindowsEditor(selected.projectPath, engineRoot);
      if (state === 'not-running') return 'not-running';
      if (state === 'engine-mismatch') throw new Error(t("当前项目运行中的 Editor 与所选引擎不一致，请切换正确引擎；未发送编译。"));
      if (state === 'unknown') throw new Error(t("无法确认运行中 Editor 的项目身份；请先检查进程权限和启动路径，未发送编译。"));
      const result = await this.communication.compile({ projectPath: selected.projectPath, engineRoot });
      const success = result && !result.isError && ['Success', 'NoChanges'].includes(result.status);
      this.lastResult = result
        ? { get text() { return success ? t("$(check) 热更新") : t("$(error) 热更新"); }, get tooltip() { return t("UE 实际返回：{0}；详细输出在 iXena Unreal · Live Coding。", result.status); } }
        : { get text() { return t("$(tools) 编译"); }, get tooltip() { return tr("初始化流程已结束；请检查侧面板连接状态。", "Initialization finished. Check the connection status in the sidebar."); } };
      return 'completed';
    } finally { this.liveCodingDispatching = false; this.updateBar(); }
  }

  private async selectBuildMode(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration(PREFIX);
    const current = configuration.get<BuildMode>('build.mode', 'auto');
    const picked = await vscode.window.showQuickPick([
      { label: t("$(zap) 智能编译（推荐）"), description: t("Editor 运行时用 Live Coding，未运行时用 UBT"), value: 'auto' as const, picked: current === 'auto' },
      { label: t("$(tools) 始终标准 UBT"), description: t("不自动触发 Live Coding；运行中的编辑器可能拒绝正常构建"), value: 'ubt' as const, picked: current === 'ubt' }
    ], { title: t("选择 iXenaUnrealTools 编译模式") });
    if (picked) {
      await configuration.update('build.mode', picked.value, vscode.ConfigurationTarget.Workspace);
      this.log(t("编译模式：{0}", picked.value));
      this.updateBar();
    }
  }

  private debugCandidates(config: BuildConfiguration): LaunchEntry[] { return matchingLaunches(config, this.catalogue.launches); }

  private async chooseDebug(config: BuildConfiguration, force: boolean): Promise<LaunchEntry | undefined> {
    const candidates = this.debugCandidates(config);
    if (!candidates.length) {
      throw new Error(t("未找到 preLaunchTask 与所选 Build 任务同名、同作用域的 launch 配置。请在已有 launch 中绑定该任务，或从 VS Code 的“运行和调试”面板启动原配置。"));
    }
    const previous = this.context.workspaceState.get<string>(`debug.${config.id}`);
    if (!force) {
      const stored = candidates.find(value => value.id === previous);
      if (stored) { return stored; }
      if (candidates.length === 1) { return candidates[0]; }
    }
    const choice = await vscode.window.showQuickPick(candidates.map(value => ({ label: value.config.name,
      description: value.origin.label, detail: String(value.config.program ?? value.config.request), entry: value })), {
      title: t("选择 {0} 对应的调试配置", config.title)
    });
    if (choice) { await this.context.workspaceState.update(`debug.${config.id}`, choice.entry.id); }
    return choice?.entry;
  }

  private async selectDebug(): Promise<void> {
    const selected = await this.ensureSelection();
    if (selected) { await this.chooseDebug(selected, true); }
  }

  private async startDebug(): Promise<void> {
    this.checkBuildAllowed();
    if (this.debugStarting) { return; }
    this.debugStarting = true;
    this.updateBar();
    try {
      const selected = await this.ensureSelection();
      if (!selected?.tasks.Build) { return; }
      const launch = await this.chooseDebug(selected, false);
      if (!launch) { return; }
      if (optionalPathKey(this.currentEngineRoot(selected)) !== optionalPathKey(selected.tasks.Build?.spec.engineRoot)) {
        throw new Error(t("当前引擎与 UE 自动生成的 launch 调试配置不一致。请切回任务引擎，或使用所选 UE 引擎重新生成工作区调试配置。"));
      }
      const result = await this.executeEntry(selected.tasks.Build);
      if (result.status !== 'succeeded') { return; }
      // 只移除已经成功执行过的精确匹配预构建；保留其余全部原始调试字段。
      const copied = withoutPreLaunchTask(launch.config);
      const started = await vscode.debug.startDebugging(launch.origin.folder, copied);
      if (!started) { this.log(t("调试器未启动；请查看 VS Code 的调试提示。")); }
    } finally { this.debugStarting = false; this.updateBar(); }
  }

  private async openSource(): Promise<void> {
    const selected = await this.ensureSelection();
    if (selected) { await vscode.window.showTextDocument(selected.origin.uri); }
  }

  private async showMenu(): Promise<void> {
    const items = [
      { label: tr("$(globe) 界面语言", "$(globe) Interface Language"), command: 'selectLanguage' },
      { label: tr("$(plug) 编辑器连接状态", "$(plug) Editor Connection Status"), description: t("选择插件或 MCP，检查当前项目连接"), command: 'checkCommunication' },
      { label: tr("$(extensions) 初始化引擎插件", "$(extensions) Initialize Engine Plugin"), description: tr("配置 MCP，或打开仓库下载插件并手动构建", "Configure MCP, or open the repository to download and build the plugin manually"), command: 'initializeEnginePlugin' },
      { label: t("$(new-file) 新建 Unreal C++ 类"), description: t("常用父类、模块、Public/Private 与中文头注释"), command: 'newClass' },
      { label: t("$(terminal) UE 命令 / 选项"), description: t("搜索控制台命令和变量并发送到当前 UE Editor"), command: 'ueConsole' },
      { label: t("$(zap) Live Coding 热更新"), description: t("编辑器运行且已开启 Live Coding，实时修补 C++（不等于完整构建）"), command: 'liveCoding' },
      { label: t("$(tools) 标准 UBT 编译"), description: t("绕过自动 Live Coding，执行原来的 UBT Build 任务"), command: 'buildStandard' },
      { label: t("$(settings-gear) 智能编译模式"), description: t("Editor 运行时优先 Live Coding；可切回始终 UBT"), command: 'selectBuildMode' },
      { label: t("$(refresh) 重建当前配置"), description: t("按已有依赖先 Clean，再 Build"), command: 'rebuild' },
      { label: t("$(clear-all) 清理当前配置"), description: t("执行当前配置的 UBT Clean"), command: 'clean' },
      { label: t("$(debug-alt) 选择调试配置"), description: t("使用已有 launch 配置"), command: 'selectDebug' },
      { label: t("$(layers) 切换 UE5 引擎版本"), description: t("识别不同 UE5 安装，不修改项目 EngineAssociation"), command: 'selectEngine' },
      { label: t("$(refresh) 只刷新 UHT"), description: t("无需完整编译，更新 .generated.h"), command: 'refreshUht' },
      { label: t("$(symbol-color) 修复 UE IntelliSense"), description: t("运行 UHT 后请求重扫语言服务器"), command: 'fixIntelliSense' },
      { label: t("$(sync) 刷新构建配置"), description: t("UE 重新生成项目文件后可手动刷新"), command: 'refresh' },
      { label: t("$(go-to-file) 打开任务来源文件"), description: t("查看原有 workspace / tasks 文件"), command: 'openSource' },
      { label: t("$(file-text) 查看上次编译日志"), description: t("已归档的 UBT 日志，停止后仍可查看"), command: 'openLastBuildLog' },
      { label: t("$(output) 查看插件日志"), description: t("SDK 路径、参数、状态和配置提示"), command: 'showLog' },
      { label: t("$(terminal) 运行原始 VS Code 任务…"), description: t("打开原生任务菜单；保留原始批处理与停止行为"), command: 'runOriginal' },
      { label: t("$(play) 启动 Unreal Editor"), description: t("使用本配置所属引擎启动当前项目"), command: 'launchEditor' },
      { label: t("$(file-code) 生成 VSCode 工程文件"), description: t("直接调用 UBT，不运行 Build.bat"), command: 'generateProjectFiles' },
      { label: t("$(list-selection) 选择工程 / 规则文件"), description: t("快速选择 .uproject、.uplugin、Target.cs 或 Build.cs"), command: 'selectRuleFile' },
      { label: t("$(references) 模块依赖管理"), description: t("可视化修改简单的 Build.cs 静态依赖"), command: 'editDependencies' },
      { label: t("$(edit) 项目 / 插件描述编辑器"), description: t("可视化编辑 .uproject / .uplugin"), command: 'editDescriptor' },
      { label: t("$(window) 注册 / 更新 Windows 右键菜单"), description: t("为 .uproject / .uplugin 添加当前用户菜单"), command: 'registerExplorerMenu' },
      { label: t("$(info) Windows 右键菜单状态"), description: t("检查注册、维护目录及手动移除脚本"), command: 'explorerMenuStatus' },
      { label: t("$(remove) 移除 Windows 右键菜单"), description: t("移除本插件注册项"), command: 'removeExplorerMenu' },
      { label: t("$(folder-opened) 项目文件夹"), description: t("打开 .uproject 所在目录"), command: 'openProjectDirectory' },
      { label: t("$(copy) 复制编译命令"), description: t("复制当前 UBT 直接编译命令"), command: 'copyBuildCommand' }
    ];
    const choice = await vscode.window.showQuickPick(items, { title: 'iXenaUnrealTools' });
    if (choice) { await vscode.commands.executeCommand(`${PREFIX}.${choice.command}`); }
  }

  private async launchEditor(): Promise<void> {
    if (!vscode.workspace.isTrusted) { throw new Error(t("请信任工作区后再启动 Unreal Editor。")); }
    if (process.platform !== 'win32') { throw new Error(t("当前编辑器启动命令仅适配 Windows UE 引擎。")); }
    const selected = await this.ensureSelection();
    const spec = selected?.tasks.Build?.spec;
    if (!spec) { throw new Error(t("请先选择一个 UE 构建配置。")); }
    const executable = editorExecutable(this.currentEngineRoot(selected!));
    await access(executable);
    const child = spawn(executable, [selected!.projectPath], {
      cwd: path.win32.dirname(executable), detached: true, stdio: 'ignore', windowsHide: false
    });
    // Node spawn 在 ENOENT 等情况下异步发出 error；先等 spawn 事件再反馈成功。
    await new Promise<void>((resolve, reject) => { child.once('spawn', () => resolve()); child.once('error', reject); });
    child.unref();
    this.log(t("已启动 Unreal Editor：{0} {1}", executable, selected!.projectPath));
  }

  private projectEngineKey(projectPath: string): string {
    return `engine.${createHash('sha256').update(pathKey(projectPath)).digest('hex')}`;
  }

  /** 所有调用方共享同一项目引擎选择逻辑，但不混用 TaskEntry 与 BuildConfiguration。 */
  private resolveProjectEngineRoot(projectPath: string, originalRoot: string | undefined, label: string): string {
    if (!optionalPathKey(projectPath) || !/\.uproject$/i.test(projectPath)) {
      throw new Error(t("“{0}” 缺少有效的 .uproject 路径；请检查工作区任务。", label));
    }
    const stored: unknown = this.context.workspaceState.get(this.projectEngineKey(projectPath));
    const selected = chooseEngineRoot(stored, originalRoot, label);
    if (selected.warning) { this.log(selected.warning); }
    return selected.root;
  }

  private currentEngineRoot(config: BuildConfiguration): string {
    return this.resolveProjectEngineRoot(config.projectPath,
      config.tasks.Build?.spec.engineRoot ?? config.tasks.Rebuild?.spec.engineRoot
        ?? config.tasks.Clean?.spec.engineRoot, config.title);
  }

  /** 从 TaskEntry.spec 取路径；不要读取只存在于 BuildConfiguration 顶层的 projectPath。 */
  private taskEngineRoot(entry: TaskEntry): string {
    return this.resolveProjectEngineRoot(entry.spec.projectPath, entry.spec.engineRoot, entry.spec.label);
  }

  private async refreshEngineChoices(): Promise<void> {
    const roots = this.catalogue.entries.map(entry => entry.spec.engineRoot)
      .filter((root): root is string => typeof root === 'string' && !!root.trim());
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme === 'file' && typeof folder.uri.fsPath === 'string' && folder.uri.fsPath.trim()) {
        roots.push(folder.uri.fsPath);
      }
    }
    const configured: unknown = vscode.workspace.getConfiguration(PREFIX).get('engineRoots', []);
    if (Array.isArray(configured)) {
      roots.push(...configured.filter((item): item is string => typeof item === 'string' && item.trim().length > 0));
      const ignored = configured.length - configured.filter(item => typeof item === 'string' && item.trim().length > 0).length;
      if (ignored) { this.log(t("已忽略 iXenaUnrealTools.engineRoots 中的 {0} 项非字符串/空路径。", ignored)); }
    } else { this.log(t("iXenaUnrealTools.engineRoots 必须是路径数组，已忽略无效配置。")); }
    const remembered: unknown = optionalPathKey(this.selection?.projectPath)
      ? this.context.workspaceState.get(this.projectEngineKey(this.selection!.projectPath)) : undefined;
    if (typeof remembered === 'string' && remembered.trim()) { roots.push(remembered); }
    const parents = new Set(roots.filter(x => typeof x === 'string' && /^[A-Za-z]:[\\/]/.test(x))
      .map(x => path.win32.dirname(x)));
    const searchPath = vscode.workspace.getConfiguration('uetools').get<string>('unrealEngineInstallationSearchPath', '');
    if (searchPath) { parents.add(searchPath); }
    this.engineChoices.splice(0, this.engineChoices.length, ...await discoverEngines(roots, [...parents]));
  }

  private async selectEngine(): Promise<void> {
    if (this.runner.isBusy || this.liveCodingDispatching || this.communication?.isBusy) { throw new Error(t("请先结束构建或通讯操作，再切换引擎。")); }
    const selected = await this.ensureSelection();
    if (!selected?.tasks.Build) { return; }
    await this.refreshEngineChoices();
    const original = selected.tasks.Build.spec.engineRoot;
    const entries: Array<vscode.QuickPickItem & { root?: string; action?: string }> = [
      { label: t("$(history) 使用 UE 任务指定的原始引擎"), description: original, action: 'reset' },
      ...this.engineChoices.map(engine => ({ label: `$(layers) ${versionName(engine.version)}`,
        description: engine.root, root: engine.root })),
      { label: t("$(folder-opened) 浏览其他 UE5 引擎目录…"), action: 'browse' }
    ];
    const choice = await vscode.window.showQuickPick(entries, { title: t("选择本项目使用的 UE5 引擎"),
      placeHolder: t("只影响 iXenaUnrealTools 本工作区操作；不会修改 .uproject 或已有 tasks") });
    if (!choice) { return; }
    if (choice.action === 'reset') { await this.resetEngine(); return; }
    let root = choice.root;
    if (choice.action === 'browse') {
      const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true,
        canSelectMany: false, openLabel: t("选择 UE5 根目录") });
      if (!picked?.length) { return; }
      const candidate = await inspectEngine(picked[0].fsPath);
      if (!candidate) { throw new Error(t("所选目录不是有效的 UE5 根目录（检查 Engine/Build/Build.version 与 UBT）。")); }
      root = candidate.root;
    }
    if (!root) { return; }
    const engine = await inspectEngine(root);
    if (!engine) { throw new Error(t("所选 UE5 引擎已不存在或不是有效安装。")); }
    const association = await readProjectEngineAssociation(selected.projectPath);
    const mismatch = engineAssociationMismatch(association, engine.version);
    if (mismatch) {
      const action = await vscode.window.showWarningMessage(
        t("项目 EngineAssociation={0}，你选择了 {1}。使用不匹配的引擎构建可能修改 Intermediate 或触发兼容问题。插件不会修改 .uproject。", association, versionName(engine.version)),
        { modal: true }, t("仅切换插件工具链"));
      if (action !== t("仅切换插件工具链")) { return; }
    }
    await this.context.workspaceState.update(this.projectEngineKey(selected.projectPath), root);
    this.log(t("本项目工具链已切换为 {0}（项目 EngineAssociation 不变）。", root));
    await this.refreshEngineChoices();
    this.updateBar();
  }

  private async resetEngine(): Promise<void> {
    const selected = await this.ensureSelection();
    if (!selected) { return; }
    await this.context.workspaceState.update(this.projectEngineKey(selected.projectPath), undefined);
    this.log(t("本项目已恢复使用 UE Tasks 自带的引擎：{0}", selected.tasks.Build?.spec.engineRoot));
    this.updateBar();
  }

  private async resolveSelectedTool(entry: TaskEntry, engineRoot: string): Promise<BuildToolInvocation> {
    const engineKey = createHash('sha256').update(pathKey(engineRoot)).digest('hex');
    const override = vscode.workspace.getConfiguration(PREFIX, entry.origin.folder?.uri).get<string>('dotnetPath', '').trim();
    const selectedTool = await resolveBuildTool({ engineRoot,
      explicitPath: override ? entry.resolve(override) : undefined,
      // 只接受位于当前引擎下的宿主，避免切换旧版本时继承 UE5.9 SDK。
      env: entry.env, rememberedPath: this.context.workspaceState.get<string>(`dotnet.${engineKey}`),
      choose: async candidates => {
        const picked = await vscode.window.showQuickPick(candidates.map(candidate => ({
          label: path.win32.relative(engineRoot, candidate), value: candidate
        })), { title: t("选择当前 UE 引擎的 .NET SDK") });
        return picked?.value;
      }
    });
    if (selectedTool.dotnetPath) {
      await this.context.workspaceState.update(`dotnet.${engineKey}`, selectedTool.dotnetPath);
    }
    this.log(t("UE 工具链：{0}；UBT 来源：{1}", engineRoot, selectedTool.source));
    return selectedTool;
  }

  private buildTaskEnvironment(entry: TaskEntry, engineRoot: string, tool: BuildToolInvocation): Record<string, string> {
    const env = { ...entry.env };
    const set = (key: string, value: string | undefined) => {
      for (const name of Object.keys(env)) { if (name.toLowerCase() === key.toLowerCase()) { delete env[name]; } }
      if (value !== undefined) { env[key] = value; }
    };
    set('UE_ROOT', engineRoot);
    set('DOTNET_HOST_PATH', tool.dotnetPath);
    set('DOTNET_ROOT', tool.dotnetPath ? path.win32.dirname(tool.dotnetPath) : undefined);
    set('DOTNET_MULTILEVEL_LOOKUP', tool.dotnetPath ? '0' : undefined);
    // 无论 UBT.exe 或 UBT.dll 都不能把上一引擎的 DotNet 路径带进新构建。
    const original = envGet(entry.env, 'PATH') ?? process.env.PATH ?? '';
    const sanitized = original.split(';').filter(part => !/[\\/]Engine[\\/]Binaries[\\/]ThirdParty[\\/]DotNet[\\/]/i.test(part));
    set('PATH', `${tool.dotnetPath ? path.win32.dirname(tool.dotnetPath) + ';' : ''}${sanitized.join(';')}`);
    return Object.fromEntries(Object.entries(env).filter((pair): pair is [string, string] => typeof pair[1] === 'string'));
  }

  private async generateProjectFiles(): Promise<void> {
    this.checkBuildAllowed();
    const selected = await this.ensureSelection();
    const entry = selected?.tasks.Build;
    if (!selected || !entry) { throw new Error(t("未选择有效构建配置。")); }
    const engineRoot = this.currentEngineRoot(selected);
    const result = await this.runner.run(t("生成 VSCode 工程文件"), async token => {
      if (token.isCancellationRequested) { return []; }
      const tool = await this.resolveSelectedTool(entry, engineRoot);
      if (token.isCancellationRequested) { return []; }
      return [{ label: t("生成 VSCode 工程文件"), projectPath: selected.projectPath,
        scope: entry.origin.folder ?? vscode.TaskScope.Workspace,
        process: tool.process, args: [...tool.prefixArgs, ...projectFilesArguments(selected.projectPath)],
        cwd: engineRoot, env: this.buildTaskEnvironment(entry, engineRoot, tool),
        problemMatchers: [], group: vscode.TaskGroup.Build }];
    });
    if (result.status === 'succeeded') {
      void vscode.window.showInformationMessage(t("UE VSCode 工程文件已生成，正在刷新构建配置。"));
      await this.refresh(true);
    } else if (result.status === 'failed') {
      throw new Error(t("生成项目文件失败，请查看任务终端 / 输出日志。"));
    }
  }

  private onHeaderSaved(document: vscode.TextDocument): void {
    const settings = vscode.workspace.getConfiguration(PREFIX, document.uri);
    if (!settings.get<boolean>('intelliSense.refreshOnHeaderSave', false) || document.uri.scheme !== 'file') { return; }
    const selected = this.selection;
    if (!selected || !isUhtRelevantHeader(document.uri.fsPath, selected.projectPath, document.getText())) { return; }
    if (this.uhtSaveTimer) { clearTimeout(this.uhtSaveTimer); }
    const debounce = Math.min(30000, Math.max(500, settings.get<number>('intelliSense.debounceMs', 1800)));
    this.uhtSaveTimer = setTimeout(() => {
      this.uhtSaveTimer = undefined;
      if (this.runner.isBusy || this.autoUhtRunning || this.liveCodingDispatching || this.communication?.isBusy) {
        this.log(t("头文件已保存；当前正在执行构建/UHT，本次自动 UHT 刷新已合并跳过。"));
        return;
      }
      this.autoUhtRunning = true;
      void this.refreshUht(settings.get<boolean>('intelliSense.refreshLanguageServer', true), true)
        .catch(error => this.log(t("自动刷新 UHT 失败：{0}", String(error))))
        .finally(() => { this.autoUhtRunning = false; });
    }, debounce);
  }

  /** UBT 的单独 UHT 模式仅运行反射生成阶段，不等待后续 C++ 编译成功。 */
  private async refreshUht(restartLanguageServer: boolean, automatic = false): Promise<void> {
    this.checkBuildAllowed();
    const selected = await this.ensureSelection();
    if (!selected?.tasks.Build) { throw new Error(t("未找到可运行的 UE 构建目标。")); }
    // 多数游戏模块由 Editor Target 加载，优先选择同项目的 Editor 目标生成反射文件。
    const selectedProjectKey = optionalPathKey(selected.projectPath);
    const config = this.catalogue.configurations.find(value =>
      selectedProjectKey !== undefined && optionalPathKey(value.projectPath) === selectedProjectKey && /Editor$/i.test(value.target)
        && value.configuration === 'Development') ?? selected;
    const entry = config.tasks.Build!;
    const engineRoot = this.currentEngineRoot(selected);
    const version = await readEngineVersion(engineRoot);
    if (version?.major !== 5) { throw new Error(t("仅支持已识别的 Unreal Engine 5.x。")); }
    if (!automatic && vscode.workspace.getConfiguration(PREFIX).get<boolean>('saveBeforeBuild', true)) {
      if (!await vscode.workspace.saveAll(false)) { throw new Error(t("未保存全部文件，已取消刷新 UHT。")); }
    }
    const result = await this.runner.run(t("刷新 UnrealHeaderTool"), async token => {
      if (token.isCancellationRequested) { return []; }
      const tool = await this.resolveSelectedTool(entry, engineRoot);
      if (token.isCancellationRequested) { return []; }
      return [{ label: `UHT ${config.target} (${versionName(version)})`, projectPath: selected.projectPath,
        scope: entry.origin.folder ?? vscode.TaskScope.Workspace,
        process: tool.process,
        args: [...tool.prefixArgs, ...uhtArguments(config.target, config.platform, config.configuration, selected.projectPath)],
        cwd: engineRoot, env: this.buildTaskEnvironment(entry, engineRoot, tool),
        problemMatchers: entry.spec.problemMatchers, group: vscode.TaskGroup.Build }];
    });
    if (result.status === 'failed') {
      const detail = version.minor <= 1
        ? t("较早的 UE5.0/5.1 可能未支持独立 UHT Target 模式，请使用该引擎的标准编译触发 UHT，或查看输出后确认可用模式。")
        : t("请查看任务终端中的 UHT 错误；头文件生成失败不会当作 IntelliSense 修复成功。");
      if (!automatic) { void vscode.window.showWarningMessage(t("UHT 未成功：{0}", detail)); }
      this.log(t("UHT 未成功：{0}", detail));
    } else if (result.status === 'succeeded') {
      this.log(t("UHT 已完成：{0} {1}", versionName(version), config.target));
      if (restartLanguageServer) { await this.refreshLanguageServer(); }
      if (!automatic) { void vscode.window.showInformationMessage(t("UHT 刷新完成；不会进行完整 C++ 编译。")); }
    }
  }

  private async refreshLanguageServer(): Promise<void> {
    // 没有通用的 VS Code “清理所有 C++ 诊断”接口；只调用已注册的扩展命令。
    const commands = new Set(await vscode.commands.getCommands(true));
    const candidates = [
      ['llvm-vs-code-extensions.vscode-clangd', 'clangd.restart'],
      ['ms-vscode.cpptools', 'C_Cpp.RescanWorkspace']
    ] as const;
    let refreshed = false;
    for (const [extensionId, command] of candidates) {
      if (!vscode.extensions.getExtension(extensionId) || !commands.has(command)) { continue; }
      try { await vscode.commands.executeCommand(command); refreshed = true; this.log(t("已请求 C++ 语言服务器刷新：{0}", command)); }
      catch (error) { this.log(t("{0} 不可用：{1}", command, String(error))); }
    }
    if (!refreshed) { this.log(t("UHT 已更新；未找到已注册的 clangd/CppTools 刷新命令。可手动重启语言服务器。")); }
  }

  private async openProjectDirectory(): Promise<void> {
    const selected = await this.ensureSelection();
    const projectPath = selected?.projectPath ?? this.sidePanel.currentProject?.projectPath;
    if (!projectPath) { throw new Error(t("没有发现 .uproject。")); }
    await vscode.env.openExternal(vscode.Uri.file(path.win32.dirname(projectPath)));
  }

  private async copyBuildCommand(): Promise<void> {
    const selected = await this.ensureSelection();
    const entry = selected?.tasks.Build;
    if (!entry) { throw new Error(t("当前配置没有 Build 任务。")); }
    const tool = await this.resolveSelectedTool(entry, this.currentEngineRoot(selected!));
    const command = powershellCommand(tool.process, [...tool.prefixArgs, ...entry.spec.args]);
    await vscode.env.clipboard.writeText(command);
    void vscode.window.showInformationMessage(t("已复制当前配置的 PowerShell UBT 编译命令。"));
  }

  private async editDependencies(node?: UnrealTreeNode): Promise<void> {
    const modules = this.sidePanel.modules;
    let module: UeModule | undefined = node?.module
      ? modules.find(mod => mod.rulePath === node.module?.rulePath) : undefined;
    if (!module) {
      if (!modules.length) { throw new Error(t("未发现可编辑的 Build.cs 模块；请检查 UE 项目结构。")); }
      const choice = await vscode.window.showQuickPick(modules.map(mod => ({
        label: mod.name, description: path.win32.relative(path.win32.dirname(mod.projectPath), mod.rulePath), module: mod
      })), { title: t("选择要可视化编辑的 Build.cs 模块"), matchOnDescription: true });
      module = choice?.module;
    }
    if (module) { await showDependencyEditor(this.context, module, modules, message => this.log(message)); }
  }

  private async tailLog(node?: UnrealTreeNode): Promise<void> {
    let logfile = node?.log;
    if (!logfile) {
      const logs = await findLogs(this.sidePanel.projects, process.env.LOCALAPPDATA);
      const choice = await vscode.window.showQuickPick(logs.map(log => ({
        label: `${t(log.kind)} · ${log.name}`, description: log.fullPath, log
      })), { title: t("选择 UBT / 项目日志") });
      logfile = choice?.log;
    }
    if (!logfile) { return; }
    const handle = await open(logfile.fullPath, 'r');
    let output = '';
    try {
      const stat = await handle.stat();
      const bytes = Math.min(stat.size, 512 * 1024);
      const start = stat.size - bytes;
      const buffer = Buffer.alloc(bytes);
      const result = await handle.read(buffer, 0, bytes, start);
      output = buffer.subarray(0, result.bytesRead).toString('utf8');
      if (start) {
        const index = output.indexOf('\n');
        output = output.slice(index < 0 ? 0 : index + 1);
        output = t("[只显示日志最后 512 KiB，完整文件：{0}]\n\n", logfile.fullPath) + output;
      } else { output = t("[原始文件：{0}]\n\n", logfile.fullPath) + output; }
    } finally { await handle.close(); }
    const document = await vscode.workspace.openTextDocument({ content: output, language: 'log' });
    await vscode.window.showTextDocument(document, { preview: false });
  }

  /** 显示最近一次已归档的 UBT 日志；即使 VS Code 已销毁任务终端也可查看。 */
  private async openLastBuildLog(): Promise<void> {
    const filePath = this.lastBuildLogPath ?? this.context.workspaceState.get<string>('lastBuildLogPath');
    if (!filePath) {
      void vscode.window.showInformationMessage(t("暂无已归档的 UBT 编译日志。请先运行一次构建。"));
      return;
    }
    try {
      await access(filePath);
    } catch {
      void vscode.window.showWarningMessage(t("上次 UBT 日志已不存在，请重新运行一次构建。"));
      return;
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(document, { preview: false });
  }

  private async reportError(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    // 界面提示保持简洁，但输出面板记录 stack，方便定位具体源码行。
    this.log(t("操作失败：{0}", error instanceof Error ? error.stack ?? error.message : String(error)));
    this.lastResult = { get text() { return t("$(tools) 编译"); }, get tooltip() { return message; } };
    this.updateBar();
    const choice = await vscode.window.showErrorMessage(`iXenaUnrealTools：${message}`, t("查看日志"));
    if (choice) { this.output.show(true); }
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
    if (this.uhtSaveTimer) { clearTimeout(this.uhtSaveTimer); }
    this.subscriptions.forEach(value => value.dispose());
  }
}
