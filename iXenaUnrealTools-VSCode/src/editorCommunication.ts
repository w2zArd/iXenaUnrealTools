import { t } from './i18n';
import { communicationTranslations } from './locales/communication';
import { registerTranslations } from './i18n';
registerTranslations(communicationTranslations);
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { BridgeInstance, discoverEditorBridges, inspectEditorBridges, sendBridgeCommand } from './editorBridge';
import { inspectBridgeInstallations } from './bridgeInstallation';
import { tr, onDidChangeLanguage } from './i18n';
import { REPOSITORY_URL, DEFAULT_MCP_URL, buildMcpEndpoint, endpointParts, normalizeMcpHost, normalizeMcpPort, normalizeMcpPath } from './connectionSetup';
import { checkUnrealMcp, probeUnrealMcpIdentity, compileViaUnrealMcp, McpCompileResult } from './unrealMcp';
import { inspectEngine, pathApi, pathKey } from './engineSupport';
import { parseCompileDiagnostic } from './compileDiagnostics';
import { PreparedTask, RunResult } from './taskRunner';
import { showUnrealConsole, disposeUnrealConsole } from './ueConsole';
import { assertPosixEditorsClosed } from './editorProcesses';
import { showPerformanceMonitor, disposePerformanceMonitor } from './performanceMonitor';
const P = 'iXenaUnrealTools';
export interface CommunicationTarget {
    projectPath: string;
    engineRoot: string;
}
export interface CommunicationHooks {
    preferredTarget(): CommunicationTarget | undefined;
    projects(): readonly string[];
    engines(): readonly string[];
    buildBusy(): boolean;
    runTask(label: string, tasks: PreparedTask[]): Promise<RunResult>;
    changed(): void;
    log(message: string): void;
}
interface Row {
    label: string;
    detail?: string;
    command?: string;
    icon?: string;
    id?: string;
    children?: Row[];
    expanded?: boolean;
}
/** 自动监测只跟随明确启动当前项目的 Editor；不因另一个调试会话启动就显示错误进程。 */
export function matchesDebugLaunch(configuration: Record<string, unknown>, target: CommunicationTarget): boolean {
    const program = configuration.program;
    if (configuration.request !== 'launch' || typeof program !== 'string' || !program.trim() || !pathApi(program).isAbsolute(program)
        || !/(?:^|[\\/])UnrealEditor(?:-[^\\/]+)?(?:\.exe)?$/i.test(program))
        return false;
    const paths = pathApi(target.engineRoot);
    if (!pathKey(program).startsWith(pathKey(target.engineRoot) + paths.sep))
        return false;
    return Array.isArray(configuration.args) && configuration.args.some(argument => {
        if (typeof argument !== 'string')
            return false;
        const candidate = argument.replace(/^-project=/i, '').replace(/^"(.*)"$/, '$1');
        return /\.uproject$/i.test(candidate) && pathApi(candidate).isAbsolute(candidate) && pathKey(candidate) === pathKey(target.projectPath);
    });
}
/** 管理初始化、握手和实际编译结果；与 UE Tasks 配置分离，因此无 Windows Tasks 的 Mac 工程也能使用。 */
export class EditorCommunication implements vscode.Disposable, vscode.TreeDataProvider<Row> {
    private readonly emitter = new vscode.EventEmitter<Row | undefined>();
    readonly onDidChangeTreeData = this.emitter.event;
    private readonly output = vscode.window.createOutputChannel('iXena Unreal · Live Coding');
    private readonly diagnostics = vscode.languages.createDiagnosticCollection('ixena-live-coding');
    private readonly disposables: vscode.Disposable[] = [this.emitter, this.output, this.diagnostics];
    private target?: CommunicationTarget;
    private state = t("尚未检查连接");
    private busy = false;
    private lastLog?: string;
    private disposed = false;
    private readonly debugMonitorTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private reconnectTimer?: ReturnType<typeof setTimeout>;
    private autoCheckRunning = false;
    private reconnectInFlight?: Promise<void>;
    private lastCompileResult?: string;
    /** A successful handshake belongs to one exact project, engine, transport and Editor instance. */
    private confirmedConnection?: { key: string; instanceId: string; at: number };
    private readonly reconnectPeriodMs = 1000;
    private readonly connectedRecheckMs = 5000;
    constructor(private readonly context: vscode.ExtensionContext, private readonly hooks: CommunicationHooks) {
        this.lastLog = context.workspaceState.get<string>('communication.lastLog');
        this.disposables.push(vscode.window.createTreeView('ixenaUnrealTools.communication', { treeDataProvider: this }));
        const commands: Record<string, (...args: unknown[]) => Promise<unknown> | unknown> = {
            selectCommunicationTarget: () => this.chooseTarget(),
            initializeEnginePlugin: () => this.initialize(),
            selectCommunicationTransport: () => this.initialize(),
            checkCommunication: () => this.check(),
            installEditorBridge: () => this.initialize(),
            compileThroughConnection: () => this.compile(),
            ueConsole: () => this.console(),
            showPerformance: () => this.performance(),
            openUnrealInsights: (engineRoot?: unknown) => this.openInsights(engineRoot),
            showLiveCodingLog: () => this.output.show(true),
            openLiveCodingLog: () => this.openLastLog(),
            buildNativeEditor: () => this.nativeEditorBuild(),
            openPluginRepository: () => this.openRepository(),
            openBridgeSource: () => this.openRepository()
        };
        for (const [name, action] of Object.entries(commands)) {
            this.disposables.push(vscode.commands.registerCommand(`${P}.${name}`, async (...args: unknown[]) => {
                try {
                    return await action(...args);
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    this.state = t("操作未完成：{0}", message.split('\n')[0]);
                    this.refresh();
                    this.hooks.log(message);
                    await vscode.window.showErrorMessage(`iXenaUnrealTools：${message}`, t("查看通讯日志")).then(choice => {
                        if (choice)
                            this.output.show(true);
                    });
                }
            }));
        }
        this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration(`${P}.liveCoding`)) {
                this.confirmedConnection = undefined;
                this.updateConnectionState(tr('连接设置已更改，正在自动检测', 'Connection settings changed; reconnecting automatically'));
            }
        }));
        this.disposables.push(onDidChangeLanguage(() => { this.confirmedConnection = undefined; this.updateConnectionState(tr('语言已切换，正在自动检测连接', 'Language changed; checking connection automatically')); }));
        this.disposables.push(vscode.debug.onDidStartDebugSession(session => { void this.autoMonitor(session); }));
        this.disposables.push(vscode.debug.onDidTerminateDebugSession(session => {
            const timer = this.debugMonitorTimers.get(session.id);
            if (timer)
                clearTimeout(timer);
            this.debugMonitorTimers.delete(session.id);
        }));
        // Never block the extension host or the build buttons on a notification.
        // Timer is owned by this view and released when the extension deactivates.
        this.scheduleReconnect();
    }
    get isBusy(): boolean { return this.busy; }
    refresh(): void { this.emitter.fire(undefined); this.hooks.changed(); }
    /** A toast is presentation only: never hold an exclusive operation until dismissal. */
    private notifyInfo(message: string): void {
        void vscode.window.showInformationMessage(message).then(undefined, error => this.hooks.log(String(error)));
    }
    private updateConnectionState(next: string): void {
        // A probe that began before an interactive action must never overwrite its UI state.
        if (this.disposed || this.busy) return;
        if (this.state !== next) { this.state = next; this.refresh(); }
    }
    private connectionKey(target: CommunicationTarget, transport: 'plugin' | 'mcp'): string {
        const url = transport === 'mcp' ? this.mcpConfig(target).url : '';
        return [transport, pathKey(target.projectPath), pathKey(target.engineRoot), url].join('\n');
    }
    private scheduleReconnect(): void {
        if (this.disposed || this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            this.reconnectInFlight = this.autoReconnect();
            void this.reconnectInFlight.finally(() => {
                this.reconnectInFlight = undefined;
                this.scheduleReconnect();
            });
        }, this.reconnectPeriodMs);
        this.reconnectTimer.unref?.();
    }
    /** A read-only, silent probe. No QuickPick, notification, compilation, or duplicate ping.
     *  Even on failure this only updates the side panel; repeated failures never flood Output.
     *  A discovered heartbeat is not treated as a connection until a real ping succeeds.
     */
    private async autoReconnect(): Promise<void> {
        if (this.disposed || this.autoCheckRunning || this.busy || !vscode.workspace.isTrusted) return;
        const target = this.target ?? this.hooks.preferredTarget();
        if (!target) return; // Never show a project-selection dialog on a timer.
        this.autoCheckRunning = true;
        try {
            const transport = this.transport(target);
            const key = this.connectionKey(target, transport);
            if (this.confirmedConnection && this.confirmedConnection.key !== key) this.confirmedConnection = undefined;
            if (transport === 'plugin') {
                const instances = (await discoverEditorBridges(target.projectPath, target.engineRoot)).filter(instance => !instance.stale);
                if (!instances.length) {
                    this.confirmedConnection = undefined;
                    this.updateConnectionState(tr('插件未连接 · 等待 UE 启动（每秒自动重试）', 'Plugin offline · waiting for UE (retrying every second)'));
                    return;
                }
                // Do not arbitrarily pick a process when several Editors opened the same project.
                const instance = instances.length === 1 ? instances[0] :
                    instances.find(item => this.confirmedConnection?.key === key && this.confirmedConnection.instanceId === item.instanceId);
                if (!instance) {
                    this.updateConnectionState(tr('多个 UE Editor 实例 · 请手动选择连接目标', 'Multiple UE Editors · select a connection target manually'));
                    return;
                }
                if (instance.status === 'compiling') {
                    this.updateConnectionState(t('Editor PID {0} 报告正在编译，暂不发送新请求', instance.processId));
                    return;
                }
                const connected = this.confirmedConnection?.key === key && this.confirmedConnection.instanceId === instance.instanceId;
                if (!connected || Date.now() - this.confirmedConnection!.at >= this.connectedRecheckMs) {
                    try {
                        const response = await sendBridgeCommand(instance, 'ping', { timeoutMs: 1000 });
                        if (!response.ok || response.status !== 'Ready') throw new Error('Invalid ping response');
                        this.confirmedConnection = { key, instanceId: instance.instanceId, at: Date.now() };
                    } catch {
                        this.confirmedConnection = undefined;
                        this.updateConnectionState(tr('插件尚未响应 · 每秒自动重试', 'Plugin not responding · retrying every second'));
                        return;
                    }
                }
                this.updateConnectionState(t('插件已连接 · PID {0}{1}', instance.processId,
                    !instance.liveCodingAvailable ? t(' · 此平台无 Live Coding') : !instance.liveCodingEnabled ? t(' · Live Coding 未启用') : ''));
            } else {
                // An MCP identity handshake is enough for connection status; do not list all
                // tools on every tick. Explicit Check still discovers Live Coding capabilities.
                const connected = this.confirmedConnection?.key === key;
                if (!connected || Date.now() - this.confirmedConnection!.at >= this.connectedRecheckMs) {
                    try {
                        const identity = await probeUnrealMcpIdentity(this.mcpConfig(target));
                        this.confirmedConnection = { key, instanceId: String(identity.processId), at: Date.now() };
                    } catch {
                        this.confirmedConnection = undefined;
                        this.updateConnectionState(tr('MCP 未连接 · 每秒自动重试', 'MCP offline · retrying every second'));
                        return;
                    }
                }
                this.updateConnectionState(t('MCP 已连接 · PID {0}', this.confirmedConnection!.instanceId));
            }
        } catch (error) {
            this.confirmedConnection = undefined;
            this.updateConnectionState(tr('自动连接检测失败 · 每秒重试', 'Automatic connection check failed · retrying every second'));
            // Avoid logging the same error once per second.
        } finally { this.autoCheckRunning = false; }
    }
    getTreeItem(row: Row): vscode.TreeItem {
        const item = new vscode.TreeItem(row.label, row.children
            ? row.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None);
        item.id = row.id;
        item.description = row.detail;
        item.tooltip = row.detail ?? row.label;
        item.iconPath = new vscode.ThemeIcon(row.icon ?? 'circle-outline');
        if (row.command)
            item.command = { command: `${P}.${row.command}`, title: row.label };
        return item;
    }
    getChildren(row?: Row): Row[] {
        if (row)
            return row.children ?? [];
        const target = this.target ?? this.hooks.preferredTarget();
        const transport = this.transport(target);
        const connection: Row[] = [
            { label: tr('初始化引擎插件…', 'Initialize engine plugin…'), command: 'initializeEnginePlugin', icon: 'plug' },
            { label: tr('项目 / 引擎', 'Project / engine'), detail: target ? `${pathApi(target.projectPath).basename(target.projectPath)} · ${target.engineRoot}` : tr('点击选择', 'Select…'), command: 'selectCommunicationTarget', icon: 'root-folder' },
            { label: tr('通讯方式', 'Connection mode'), detail: transport === 'plugin' ? tr('iXena 插件 · 手动安装', 'iXena plugin · manual installation') : 'Epic Unreal MCP', icon: 'plug' },
            { label: tr('检查连接 / 插件状态', 'Check connection / plugin status'), command: 'checkCommunication', icon: 'refresh' }
        ];
        if (transport === 'mcp')
            connection.splice(3, 0, { label: 'MCP IP / Port', detail: this.settings(target).get<string>('liveCoding.mcpUrl', DEFAULT_MCP_URL), icon: 'globe' });
        return [
            { label: tr('连接状态', 'Connection status'), detail: this.state, command: 'checkCommunication', icon: this.busy ? 'loading~spin' : 'info', id: 'connection-status' },
            { label: tr('连接与初始化', 'Connection & setup'), id: 'connection', icon: 'plug', expanded: true, children: connection },
            { label: tr('编译与热更新', 'Build & Live Coding'), id: 'build', icon: 'tools', children: [
                    ...(this.lastCompileResult ? [{ label: tr('上次热更新结果', 'Last Live Coding result'), detail: this.lastCompileResult, command: 'showLiveCodingLog', icon: 'history' }] : []),
                    { label: tr('Live Coding 热更新', 'Live Coding'), command: 'compileThroughConnection', icon: 'zap' },
                    { label: tr('本机 Editor 完整编译…', 'Build native Editor…'), command: 'buildNativeEditor', icon: 'tools' }
                ] },
            { label: tr('运行与调试', 'Runtime & debugging'), id: 'runtime', icon: 'debug-alt', children: [
                    { label: tr('CPU / 内存运行监测', 'CPU / memory monitor'), command: 'showPerformance', icon: 'pulse' },
                    { label: tr('打开 Unreal Insights', 'Open Unreal Insights'), command: 'openUnrealInsights', icon: 'graph-line' },
                    { label: tr('搜索 UE 命令 / 修改选项', 'Search UE commands / options'), command: 'ueConsole', icon: 'terminal' }
                ] },
            { label: tr('日志与帮助', 'Logs & help'), id: 'logs', icon: 'book', children: [
                    { label: tr('实时热更新输出', 'Live Coding output'), command: 'showLiveCodingLog', icon: 'output' },
                    { label: tr('上次热更新日志', 'Last Live Coding log'), command: 'openLiveCodingLog', icon: 'file-text' },
                    { label: tr('打开仓库 / 手动安装说明', 'Repository / manual installation'), command: 'openPluginRepository', icon: 'github' }
                ] }
        ];
    }
    private settings(target?: CommunicationTarget): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration(P, target ? vscode.Uri.file(target.projectPath) : undefined);
    }
    private transport(target?: CommunicationTarget): 'plugin' | 'mcp' {
        return this.settings(target).get<string>('liveCoding.transport', 'plugin') === 'mcp' ? 'mcp' : 'plugin';
    }
    private async exclusive<T>(title: string, action: () => Promise<T>, allowConcurrentBuild = false): Promise<T> {
        if (!vscode.workspace.isTrusted)
            throw new Error(t("请先信任此工作区。"));
        // A background UBT task must not block a read-only connection check. The former
        // 0.6.0 gate caused an indefinitely unverified status even with a loaded UE bridge.
        if (this.busy || (!allowConcurrentBuild && this.hooks.buildBusy()))
            throw new Error(t("已有构建或通讯操作在进行，请等待完成。"));
        this.busy = true;
        this.state = title;
        this.refresh();
        try {
            // Background ping and foreground compile share the same UE request queue.
            // Wait for an already-running read-only probe before sending a new request;
            // further probes are inhibited by busy=true until this action completes.
            if (this.reconnectInFlight) await this.reconnectInFlight;
            return await action();
        }
        catch (error) {
            // Do not leave the tree displaying "Connecting…" after a rejected handshake.
            const message = error instanceof Error ? error.message : String(error);
            this.state = tr('通讯失败：{0}', 'Connection failed: {0}', message);
            this.output.appendLine(`[iXenaUnrealTools] ${this.state}`);
            throw error;
        }
        finally {
            this.busy = false;
            this.refresh();
        }
    }
    private async resolveTarget(force = false): Promise<CommunicationTarget | undefined> {
        const preferred = this.target ?? this.hooks.preferredTarget();
        if (preferred && !force)
            return preferred;
        const projects = [...new Set(this.hooks.projects())];
        let projectPath: string | undefined;
        if (projects.length === 1 && !force)
            projectPath = projects[0];
        else if (projects.length) {
            const picked = await vscode.window.showQuickPick([
                ...projects.map(value => ({ label: pathApi(value).basename(value), description: value, value })),
                { label: t("浏览 .uproject\u2026"), description: '', value: '' }
            ], { title: t("通讯插件 \u00B7 选择项目"), matchOnDescription: true });
            if (!picked)
                return undefined;
            projectPath = picked.value;
        }
        if (!projectPath) {
            const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { [t("Unreal 项目")]: ['uproject'] }, title: t("选择通讯使用的 .uproject") });
            if (!files?.length)
                return undefined;
            projectPath = files[0].fsPath;
        }
        await fs.access(projectPath);
        const storedKey = `communication.engine.${createHash('sha256').update(pathKey(projectPath)).digest('hex')}`;
        const previous = this.context.workspaceState.get<string>(storedKey);
        const candidates = [...new Set([...(preferred && pathKey(preferred.projectPath) === pathKey(projectPath) ? [preferred.engineRoot] : []),
                ...(previous ? [previous] : []), ...this.hooks.engines()])];
        const engines = (await Promise.all(candidates.map(candidate => inspectEngine(candidate)))).filter(value => !!value);
        const picked = await vscode.window.showQuickPick([
            ...engines.map(engine => ({ label: engine!.label, value: engine!.root })),
            { label: t("浏览 UE 引擎根目录\u2026"), value: '' }
        ], { title: t("选择此项目实际使用的 UE 引擎（包含 Engine 文件夹的目录）") });
        if (!picked)
            return undefined;
        let engineRoot = picked.value;
        if (!engineRoot) {
            const folders = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: t("选择 UE 引擎根目录") });
            if (!folders?.length)
                return undefined;
            engineRoot = folders[0].fsPath;
        }
        if (!await inspectEngine(engineRoot))
            throw new Error(t("此目录不是可识别的 UE5 引擎根目录。"));
        this.target = { projectPath, engineRoot };
        this.confirmedConnection = undefined;
        await this.context.workspaceState.update(storedKey, engineRoot);
        this.state = t("项目 / 引擎已选择，请检查连接");
        this.refresh();
        return this.target;
    }
    private async chooseTarget(): Promise<void> {
        if (this.busy || this.hooks.buildBusy())
            throw new Error(t("操作进行中，暂时不能切换项目或引擎。"));
        await this.resolveTarget(true);
    }
    /** 只保存客户端配置或打开下载页，不启动 UAT，也不写入项目 Plugins。 */
    async initialize(): Promise<void> {
        const previousState = this.state;
        await this.exclusive(tr('正在初始化连接', 'Initializing connection'), async () => {
            const target = this.target ?? this.hooks.preferredTarget();
            const picked = await vscode.window.showQuickPick([
                { label: '$(extensions) iXena Unreal Plugin', description: tr('打开仓库，手动下载、放置并编译插件', 'Open the repository to download, place, and build the plugin manually'), value: 'plugin' },
                { label: '$(plug) Epic Unreal MCP', description: tr('配置 IP、端口和 /mcp 路径', 'Configure the IP address, port, and /mcp path'), value: 'mcp' }
            ], { title: tr('初始化引擎插件 · 选择连接方式', 'Initialize engine plugin · connection mode') });
            if (!picked)
                { this.state = previousState; return; }
            const scope = target && vscode.workspace.getWorkspaceFolder(vscode.Uri.file(target.projectPath)) && (vscode.workspace.workspaceFolders?.length ?? 0) > 1
                ? vscode.ConfigurationTarget.WorkspaceFolder
                : vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
            const settings = this.settings(target);
            if (picked.value === 'mcp') {
                const initial = endpointParts(settings.get<string>('liveCoding.mcpUrl', DEFAULT_MCP_URL));
                const validate = (fn: (input: string) => unknown) => (input: string): string | undefined => {
                    try {
                        fn(input);
                        return undefined;
                    }
                    catch (error) {
                        return error instanceof Error ? error.message : String(error);
                    }
                };
                const host = await vscode.window.showInputBox({ title: tr('MCP IP 地址 · 1/3', 'MCP IP address · 1/3'), value: initial.host,
                    prompt: tr('默认 127.0.0.1；客户端地址不会更改 UE 服务监听设置。', 'Default: 127.0.0.1. This does not change the UE server listener.'), ignoreFocusOut: true, validateInput: validate(normalizeMcpHost) });
                if (host === undefined)
                    { this.state = previousState; return; }
                const port = await vscode.window.showInputBox({ title: tr('MCP 端口 · 2/3', 'MCP port · 2/3'), value: initial.port, ignoreFocusOut: true, validateInput: validate(normalizeMcpPort) });
                if (port === undefined)
                    { this.state = previousState; return; }
                const route = await vscode.window.showInputBox({ title: tr('MCP 路径 · 3/3', 'MCP path · 3/3'), value: initial.route, ignoreFocusOut: true, validateInput: validate(normalizeMcpPath) });
                if (route === undefined)
                    { this.state = previousState; return; }
                const url = buildMcpEndpoint(host, port, route, initial.protocol);
                await settings.update('liveCoding.mcpUrl', url, scope);
                await settings.update('liveCoding.transport', 'mcp', scope);
                this.state = tr('MCP 地址已保存，等待连接检查', 'MCP endpoint saved; connection not checked');
                this.refresh();
                this.notifyInfo(tr('已保存 {0}。已启用自动连接检测。', 'Saved {0}. Automatic connection detection is enabled.', url));
            }
            else {
                await settings.update('liveCoding.transport', 'plugin', scope);
                await this.openRepository();
                this.state = tr('仓库已打开；等待手动安装并重开 UE', 'Repository opened; install the plugin and restart UE');
                this.refresh();
                this.notifyInfo(tr('下载 iXenaUnrealTools-UnrealPlugin 中的 iXenaUnrealBridge，放到项目或引擎的 Plugins，编译、启用后重开 UE。Tools 内提供构建脚本。', 'Download iXenaUnrealBridge from iXenaUnrealTools-UnrealPlugin. Place it in project or engine Plugins, build and enable it, then restart UE. Build scripts are in Tools.'));
            }
        });
    }
    private async openRepository(): Promise<void> {
        if (!await vscode.env.openExternal(vscode.Uri.parse(REPOSITORY_URL))) {
            throw new Error(tr('无法打开仓库，请手动访问：{0}', 'Could not open the repository. Visit {0} manually.', REPOSITORY_URL));
        }
    }
    private mcpConfig(target: CommunicationTarget) {
        return { ...target, url: this.settings(target).get<string>('liveCoding.mcpUrl', 'http://127.0.0.1:8000/mcp'),
            timeoutSeconds: this.timeoutSeconds(target) };
    }
    private timeoutSeconds(target: CommunicationTarget): number {
        const value = this.settings(target).get<number>('liveCoding.timeoutSeconds', 900);
        return typeof value === 'number' && Number.isFinite(value) ? Math.min(3600, Math.max(30, value)) : 900;
    }
    private async pickInstance(target: CommunicationTarget): Promise<BridgeInstance | undefined> {
        const instances = (await discoverEditorBridges(target.projectPath, target.engineRoot)).filter(instance => !instance.stale);
        if (!instances.length)
            return undefined;
        if (instances.length === 1)
            return instances[0];
        const picked = await vscode.window.showQuickPick(instances.map(instance => ({ label: `UE ${instance.engineVersion} · PID ${instance.processId}`,
            description: instance.status === 'compiling' ? t("正在编译") : t("可连接"), detail: t("启动于 {0}", instance.startedAt), instance })), { title: t("当前项目打开了多个 Editor，请选择此次通讯目标") });
        return picked?.instance;
    }
    async check(): Promise<void> {
        await this.exclusive(t("正在检查连接"), async () => {
            const target = await this.resolveTarget();
            if (!target)
                return;
            if (this.transport(target) === 'mcp') {
                const info = await checkUnrealMcp(this.mcpConfig(target), message => this.output.appendLine(message));
                this.state = t("MCP 已连接 \u00B7 PID {0}{1}", info.processId, info.liveCodingAvailable ? '' : t(" \u00B7 Live Coding 不可用"));
                this.confirmedConnection = { key: this.connectionKey(target, 'mcp'), instanceId: String(info.processId), at: Date.now() };
                this.output.appendLine(`${this.state}\n${info.message ?? info.toolName}`);
            }
            else {
                const instance = await this.pickInstance(target);
                if (!instance) {
                    this.confirmedConnection = undefined;
                    const report = await inspectEditorBridges(target.projectPath, target.engineRoot);
                    const installed = await inspectBridgeInstallations(target.projectPath, target.engineRoot);
                    if (report.rejected.length || report.stale) {
                        this.state = tr('发现 UE 通讯文件但尚未连接，请查看诊断输出', 'UE communication files found, but not connected; see diagnostics');
                        this.output.appendLine(tr('通讯诊断：{0} 个旧心跳，{1} 个身份不匹配或无效实例。',
                            'Bridge diagnostics: {0} stale heartbeat(s), {1} rejected instance(s).', report.stale, report.rejected.length));
                        for (const rejected of report.rejected)
                            this.output.appendLine(tr('实例 {0}：{1}', 'Instance {0}: {1}', rejected.instance,
                                rejected.reason === 'engine' ? tr('引擎路径不匹配', 'engine path mismatch') :
                                rejected.reason === 'project' ? tr('项目路径不匹配', 'project path mismatch') :
                                rejected.reason === 'version' ? tr('桥接协议版本不受支持', 'bridge version unsupported') :
                                tr('描述文件不存在或不完整', 'descriptor missing or invalid')));
                        if (report.stale) this.output.appendLine(tr('UE 可能已退出，或正在调试断点／同步编译；旧实例不会接收新请求。',
                            'UE may have exited or be paused at a breakpoint / synchronous compile. Stale instances will not receive new requests.'));
                    } else {
                        this.state = installed.length ? t("已检测到插件文件；未连接（需编译、启用或重开 Editor）") : t("未安装通讯插件");
                    }
                    this.output.appendLine(this.state);
                    for (const item of installed)
                        this.output.appendLine(t("{0}: {1} \u00B7 版本 {2} \u00B7 {3}", item.scope, item.directory, item.version ?? t("未知"), item.hasBinaries ? t("存在模块清单") : t("缺少本机模块清单")));
                }
                else if (instance.status === 'compiling') {
                    this.state = t("Editor PID {0} 报告正在编译，暂不发送新请求", instance.processId);
                }
                else {
                    const ping = await sendBridgeCommand(instance, 'ping', { timeoutMs: 5000 });
                    if (!ping.ok || ping.status !== 'Ready') throw new Error(tr('UE ping 未确认连接成功。', 'UE ping did not confirm the connection.'));
                    this.confirmedConnection = { key: this.connectionKey(target, 'plugin'), instanceId: instance.instanceId, at: Date.now() };
                    this.state = t("插件已连接 \u00B7 PID {0}{1}", instance.processId, !instance.liveCodingAvailable ? t(" \u00B7 此平台无 Live Coding") : !instance.liveCodingEnabled ? t(" \u00B7 Live Coding 未启用") : '');
                }
            }
            // Do not await showInformationMessage here: the user must NOT have to
            // dismiss a toast for exclusive() to release busy and complete the handshake.
            // The connection status is already visible in the tree and status bar.
        }, true);
    }
    private async console(): Promise<void> {
        await this.exclusive(t("正在打开 UE 命令面板"), async () => {
            const target = await this.resolveTarget();
            if (!target)
                return;
            const instance = await this.pickInstance(target);
            if (!instance)
                throw new Error(t("UE 命令面板需要已加载的 iXenaUnrealBridge。请先安装插件、重新打开 Editor 并检查连接；无需更改热更新的 MCP 设置。"));
            if (instance.status === 'compiling')
                throw new Error(t("当前 UE Editor 正在编译，完成后再执行控制台命令。"));
            await sendBridgeCommand(instance, 'ping', { timeoutMs: 5000 });
            await showUnrealConsole(instance);
            this.state = t("插件已连接 \u00B7 PID {0}", instance.processId);
        });
    }
    private async performance(): Promise<void> {
        const target = await this.resolveTarget();
        if (!target)
            return;
        const instance = await this.pickInstance(target);
        if (!instance)
            throw new Error(t("运行监测需要已加载的 iXenaUnrealBridge。请先安装插件并重新打开 UE Editor。"));
        await showPerformanceMonitor(instance);
    }
    private async autoMonitor(session: vscode.DebugSession): Promise<void> {
        const target = this.hooks.preferredTarget() ?? this.target;
        if (!target || !this.settings(target).get<boolean>('performance.autoStartDebug', true))
            return;
        const isLaunch = matchesDebugLaunch(session.configuration, target);
        const attachPid = session.configuration.request === 'attach' && /^\d+$/.test(String(session.configuration.processId))
            ? Number(session.configuration.processId) : undefined;
        if (!isLaunch && !attachPid)
            return;
        const began = Date.now();
        const poll = async (): Promise<void> => {
            this.debugMonitorTimers.delete(session.id);
            if (this.disposed || !vscode.debug.activeDebugSession || vscode.debug.activeDebugSession.id !== session.id)
                return;
            try {
                const instances = (await discoverEditorBridges(target.projectPath, target.engineRoot)).filter(item => !item.stale &&
                    (attachPid ? item.processId === attachPid : Date.parse(item.startedAt) >= began - 10000));
                if (instances.length === 1) {
                    await showPerformanceMonitor(instances[0]);
                    return;
                }
                if (instances.length > 1) {
                    this.hooks.log(t("同一项目存在多个新 Editor，自动监测已跳过，请从面板选择实例。"));
                    return;
                }
            }
            catch (error) {
                this.hooks.log(t("等待 UE 运行监测实例：{0}", String(error)));
            }
            if (Date.now() - began < 120000)
                this.debugMonitorTimers.set(session.id, setTimeout(() => { void poll(); }, 2000));
        };
        await poll();
    }
    private async openInsights(requestedEngine?: unknown): Promise<void> {
        const inspected = typeof requestedEngine === 'string' ? await inspectEngine(requestedEngine) : undefined;
        if (requestedEngine !== undefined && !inspected)
            throw new Error(t("监测实例所使用的引擎路径已失效，无法启动对应版本的 Insights。"));
        const target = inspected ? { engineRoot: inspected.root } : await this.resolveTarget();
        if (!target)
            return;
        const candidates = process.platform === 'win32'
            ? [path.join(target.engineRoot, 'Engine', 'Binaries', 'Win64', 'UnrealInsights.exe')]
            : process.platform === 'darwin'
                ? [path.join(target.engineRoot, 'Engine', 'Binaries', 'Mac', 'UnrealInsights.app', 'Contents', 'MacOS', 'UnrealInsights'), path.join(target.engineRoot, 'Engine', 'Binaries', 'Mac', 'UnrealInsights')]
                : [path.join(target.engineRoot, 'Engine', 'Binaries', 'Linux', 'UnrealInsights')];
        let executable: string | undefined;
        for (const file of candidates) {
            if (await fs.stat(file).then(stat => stat.isFile(), () => false)) {
                executable = file;
                break;
            }
        }
        if (!executable)
            throw new Error(t("所选引擎没有找到 Unreal Insights 可执行文件，请使用该引擎的官方流程安装或构建 UnrealInsights。"));
        await new Promise<void>((resolve, reject) => {
            const child = spawn(executable!, [], { cwd: target.engineRoot, detached: true, stdio: 'ignore' });
            child.once('error', reject);
            child.once('spawn', () => { child.unref(); resolve(); });
        });
    }
    async compile(explicit?: CommunicationTarget): Promise<McpCompileResult | undefined> {
        return this.exclusive(t("准备 Live Coding"), async () => {
            const target = explicit ?? await this.resolveTarget();
            if (!target)
                return undefined;
            this.target = target;
            const transport = this.transport(target);
            if (this.settings(target).get('saveBeforeBuild', true) && !await vscode.workspace.saveAll(false))
                throw new Error(t("部分文件未保存，已停止热更新。"));
            let instance: BridgeInstance | undefined;
            if (transport === 'plugin') {
                instance = await this.pickInstance(target);
                if (!instance) {
                    const installed = await inspectBridgeInstallations(target.projectPath, target.engineRoot);
                    if (!installed.length) {
                        throw new Error(tr('未安装通讯插件。请点击“初始化引擎插件”，从仓库手动安装后重开 UE。', 'The bridge plugin is not installed. Use Initialize engine plugin to open the repository, install it manually, and restart UE.'));
                    }
                    throw new Error(t("检测到通讯插件文件，但当前项目没有可连接的实例。请确认插件已编译、启用，且已重新打开对应 UE Editor，再检查连接。"));
                }
                if (!instance.liveCodingAvailable)
                    throw new Error(t("通讯已建立，但此编辑器/平台未提供 Live Coding。macOS/Linux 请关闭 Editor 后使用\u201C本机 Editor 完整编译\u201D。"));
                if (!instance.liveCodingEnabled)
                    throw new Error(t("通讯已建立，但 UE 尚未启用 Live Coding；请到 Editor Preferences \u2192 General \u2192 Live Coding 开启。"));
                if (instance.status === 'compiling')
                    throw new Error(t("当前 UE Editor 已在编译，请等待结束后重试。"));
                await sendBridgeCommand(instance, 'ping', { timeoutMs: 5000 });
            }
            this.state = t("UE 正在编译；等待实际结果");
            this.refresh();
            const header = `\n=== ${new Date().toISOString()} · ${transport} · ${target.projectPath} ===\n`;
            this.output.append(header);
            this.output.show(true);
            this.diagnostics.clear();
            let captured = '', pendingLine = '';
            const byFile = new Map<string, vscode.Diagnostic[]>();
            const addDiagnostic = (line: string): void => {
                const parsed = parseCompileDiagnostic(line);
                if (!parsed)
                    return;
                const item = new vscode.Diagnostic(new vscode.Range(parsed.line, parsed.column, parsed.line, parsed.column + 1), parsed.message, parsed.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
                item.source = 'UE Live Coding';
                item.code = parsed.code;
                const values = byFile.get(parsed.file) ?? [];
                if (!values.some(old => old.range.isEqual(item.range) && old.message === item.message))
                    values.push(item);
                byFile.set(parsed.file, values);
                this.diagnostics.set(vscode.Uri.file(parsed.file), values);
            };
            const onOutput = (chunk: string): void => {
                this.output.append(chunk);
                if (captured.length < 16 * 1024 * 1024)
                    captured += chunk.slice(0, 16 * 1024 * 1024 - captured.length);
                pendingLine += chunk;
                const lines = pendingLine.split(/\r?\n/);
                pendingLine = (lines.pop() ?? '').slice(-65536);
                for (const line of lines)
                    addDiagnostic(line);
            };
            let result: McpCompileResult | undefined;
            try {
                if (instance) {
                    const response = await sendBridgeCommand(instance, 'compile', { timeoutMs: this.timeoutSeconds(target) * 1000, onOutput });
                    result = { status: ['Ready', 'InvalidRequest', 'Expired'].includes(response.status) ? 'Unknown' : response.status as McpCompileResult['status'],
                        rawOutput: response.output, isError: !response.ok };
                    if (response.message)
                        onOutput(`\n${response.message}\n`);
                }
                else {
                    result = await compileViaUnrealMcp(this.mcpConfig(target), message => onOutput(`[MCP] ${message}\n`));
                    if (result.rawOutput)
                        onOutput(`${result.rawOutput}\n`);
                }
                if (pendingLine)
                    addDiagnostic(pendingLine);
                const success = !result.isError && (result.status === 'Success' || result.status === 'NoChanges');
                this.state = result.status === 'NoChanges' && success ? t("编译完成：没有代码变化") : success ? t("热更新成功（UE 已确认）") : t("热更新未成功：{0}", result.status);
                onOutput(t("\n[结果] {0}\n", this.state));
                this.lastCompileResult = this.state;
                if (success) {
                    // Do NOT await this notification. UE already returned a terminal result;
                    // UI acknowledgement must not keep exclusive() busy or the build spinner active.
                    this.notifyInfo(this.state);
                } else {
                    void vscode.window.showWarningMessage(t("{0}。请查看 Live Coding 输出和 Problems。", this.state), t("查看 Problems")).then(choice => {
                        if (choice) void vscode.commands.executeCommand('workbench.actions.view.problems');
                    }, error => this.hooks.log(String(error)));
                }
                return result;
            }
            catch (error) {
                this.state = t("通讯中断或结果未确认；不会自动重试编译");
                this.lastCompileResult = this.state;
                onOutput(`\n${this.state}\n${error instanceof Error ? error.message : String(error)}\n`);
                throw error;
            }
            finally {
                const folder = path.join(this.context.globalStorageUri.fsPath, 'LiveCodingLogs');
                try {
                    await fs.mkdir(folder, { recursive: true });
                    this.lastLog = path.join(folder, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.log`);
                    await fs.writeFile(this.lastLog, header + captured, 'utf8');
                    await this.context.workspaceState.update('communication.lastLog', this.lastLog);
                    this.output.appendLine(t("日志已保留：{0}", this.lastLog));
                }
                catch (error) {
                    this.hooks.log(t("归档热更新日志失败：{0}", String(error)));
                }
            }
        });
    }
    private async openLastLog(): Promise<void> {
        if (!this.lastLog) {
            this.output.show(true);
            return;
        }
        await vscode.window.showTextDocument(vscode.Uri.file(this.lastLog));
    }
    /** Mac/Linux 直接运行所选引擎的官方脚本；Windows 继续使用已有 UBT Tasks 适配。 */
    private async nativeEditorBuild(): Promise<void> {
        if (process.platform === 'win32') {
            await vscode.commands.executeCommand(`${P}.buildStandard`);
            return;
        }
        await this.exclusive(t("准备本机 Editor 构建"), async () => {
            const target = await this.resolveTarget();
            if (!target)
                return;
            if (!['darwin', 'linux'].includes(process.platform))
                throw new Error(t("当前主机平台不支持 Editor 构建。"));
            await assertPosixEditorsClosed();
            const instances = await discoverEditorBridges(target.projectPath, target.engineRoot);
            if (instances.some(instance => !instance.stale))
                throw new Error(t("请先保存并关闭 UE Editor，再执行完整编译。"));
            const source = path.join(path.dirname(target.projectPath), 'Source');
            const targets = (await fs.readdir(source)).filter(name => /\.Target\.cs$/i.test(name));
            const editorTargets: string[] = [];
            for (const file of targets) {
                const code = (await fs.readFile(path.join(source, file), 'utf8')).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
                if (/\bType\s*=\s*TargetType\.Editor\b/.test(code))
                    editorTargets.push(file.replace(/\.Target\.cs$/i, ''));
            }
            if (!editorTargets.length)
                throw new Error(t("Source 下未找到明确的 Editor Target.cs，请使用 UE 生成的原始任务。"));
            const editorTarget = editorTargets.length === 1 ? editorTargets[0] : await vscode.window.showQuickPick(editorTargets, { title: t("选择实际存在的 Editor Target") });
            if (!editorTarget)
                return;
            const configuration = await vscode.window.showQuickPick(['Development', 'DebugGame', 'Debug'], { title: t("选择本机 Editor 构建配置（开始前请保存并关闭 Editor）") });
            if (!configuration)
                return;
            if (!await vscode.workspace.saveAll(false))
                throw new Error(t("部分文件未保存，已取消编译。"));
            await assertPosixEditorsClosed();
            const host = process.platform === 'darwin' ? 'Mac' : 'Linux';
            const script = path.join(target.engineRoot, 'Engine', 'Build', 'BatchFiles', host, 'Build.sh');
            await fs.access(script);
            const result = await this.hooks.runTask(`${editorTarget} ${host} ${configuration}`, [{ label: `${editorTarget} ${host} ${configuration}`,
                    projectPath: target.projectPath, scope: vscode.workspace.getWorkspaceFolder(vscode.Uri.file(target.projectPath)) ?? vscode.TaskScope.Workspace,
                    process: '/bin/bash', args: [script, editorTarget, host, configuration, `-Project=${target.projectPath}`, '-WaitMutex'],
                    cwd: target.engineRoot, problemMatchers: ['$gcc'], group: vscode.TaskGroup.Build }]);
            this.state = result.status === 'succeeded' ? t("Editor 完整构建成功，可重新打开编辑器") : t("Editor 构建{0}，见任务终端", result.status === 'cancelled' ? t("已停止") : t("失败"));
            this.notifyInfo(this.state);
        });
    }
    dispose(): void {
        this.disposed = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
        for (const timer of this.debugMonitorTimers.values())
            clearTimeout(timer);
        this.debugMonitorTimers.clear();
        this.disposables.forEach(item => item.dispose());
        disposeUnrealConsole();
        disposePerformanceMonitor();
    }
}
