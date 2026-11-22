import { t } from './i18n';
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { parse, ParseError } from 'jsonc-parser';
import {
  EXPLORER_EXTENSION_ID, EXPLORER_CONFIG_FILENAME, parseExplorerRequest,
  explorerRegistryPaths
} from './explorerModel';

export interface ExplorerIntegrationHooks {
  output(message: string): void;
  openDescriptor(uri: vscode.Uri): Promise<void>;
}

interface ShellConfiguration {
  schemaVersion: 1;
  extensionId: string;
  uriScheme: string;
  codeExe: string;
  powershellExe: string;
  bridgePath: string;
}

/** 只接受本地 Windows 桌面；远程扩展宿主不能替用户电脑注册 Explorer 菜单。 */
export function windowsIntegrationUnavailable(platform = process.platform, remoteName = vscode.env.remoteName,
  uiKind = vscode.env.uiKind): string | undefined {
  if (platform !== 'win32') { return t("Windows 资源管理器菜单仅适用于本地 Windows 版 VSCode。"); }
  if (remoteName || uiKind !== vscode.UIKind.Desktop) {
    return t("请在本地 Windows 桌面窗口中操作；WSL、SSH、容器和网页版窗口不注册系统右键菜单。");
  }
  return undefined;
}

/** 只考虑所点击项目目录内，且 folders 确实包含该目录的工作区文件。 */
export async function findProjectWorkspaces(projectFile: string): Promise<string[]> {
  const directory = path.dirname(projectFile);
  const names = (await fs.readdir(directory, { withFileTypes: true }))
    .filter(item => item.isFile() && /\.code-workspace$/i.test(item.name)).slice(0, 80);
  const matches: string[] = [];
  const key = (value: string) => path.normalize(value).replace(/[\\/]+$/, '').toLowerCase();
  for (const item of names) {
    const file = path.join(directory, item.name);
    try {
      if ((await fs.stat(file)).size > 2 * 1024 * 1024) { continue; }
      const errors: ParseError[] = [];
      const raw = parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''), errors,
        { allowTrailingComma: true, disallowComments: false });
      if (errors.length || !Array.isArray(raw?.folders)) { continue; }
      const containsProject = raw.folders.some((folder: unknown) => {
        if (!folder || typeof folder !== 'object') { return false; }
        const value = (folder as { path?: unknown }).path;
        if (typeof value !== 'string' || value.includes('${')) { return false; }
        return key(path.resolve(directory, value)) === key(directory);
      });
      if (containsProject) { matches.push(file); }
    } catch { /* 单个失效的工作区文件不阻止打开项目目录。 */ }
  }
  return matches.sort((a, b) => a.localeCompare(b));
}

/**
 * Explorer 菜单桥接。只有“注册/移除”命令写当前用户注册表。
 * URI 仅支持打开目录、可视化编辑、查看源码；绝不接受任意 VSCode / Shell 命令。
 */
export class ExplorerIntegration implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private initialized = false;
  private registryBusy = false;

  constructor(private readonly context: vscode.ExtensionContext, private readonly hooks: ExplorerIntegrationHooks) {}

  initialize(): void {
    if (this.initialized) { return; }
    this.initialized = true;
    this.disposables.push(vscode.window.registerUriHandler({ handleUri: uri => this.handleUri(uri).catch(error => {
      this.hooks.output(t("Explorer 请求失败：{0}", error instanceof Error ? error.stack ?? error.message : String(error)));
      void vscode.window.showErrorMessage(`iXenaUnrealTools：${error instanceof Error ? error.message : String(error)}`);
    }) }));
    void vscode.commands.executeCommand('setContext', 'iXenaUnrealTools.windowsIntegrationAvailable',
      !windowsIntegrationUnavailable());
  }

  private checkAvailable(): void {
    const reason = windowsIntegrationUnavailable();
    if (reason) { throw new Error(reason); }
  }

  private get storageDirectory(): string { return path.join(this.context.globalStorageUri.fsPath, 'explorer'); }
  private get configFile(): string { return path.join(this.storageDirectory, EXPLORER_CONFIG_FILENAME); }
  private get registryScript(): string { return path.join(this.storageDirectory, 'ExplorerRegistry.ps1'); }

  private async powershellPath(): Promise<string> {
    const windows = process.env.SystemRoot || process.env.WINDIR;
    if (!windows || !path.win32.isAbsolute(windows)) { throw new Error(t("未找到 Windows 系统目录（SystemRoot）。")); }
    const executable = path.win32.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    await fs.access(executable);
    return executable;
  }

  private async codePath(): Promise<string | undefined> {
    const raw: unknown = vscode.workspace.getConfiguration('iXenaUnrealTools').get('explorerIntegration.codePath', '');
    if (raw !== null && raw !== undefined && typeof raw !== 'string') {
      throw new Error(t("explorerIntegration.codePath 应填写 VSCode .exe 路径字符串，或留空自动检测。"));
    }
    const configured = typeof raw === 'string' ? raw.trim() : '';
    if (configured.trim()) {
      if (!path.win32.isAbsolute(configured) || !/\.exe$/i.test(configured)) {
        throw new Error(t("explorerIntegration.codePath 必须是 VSCode 桌面程序的绝对 .exe 路径。"));
      }
      if (!(await fs.stat(configured).catch(() => undefined))?.isFile()) {
        throw new Error(t("配置的 VSCode 程序不存在：{0}", configured));
      }
      return configured;
    }
    const appDirectory = path.resolve(vscode.env.appRoot, '..', '..');
    const candidates = [process.execPath, path.join(appDirectory, 'Code.exe'),
      path.join(appDirectory, 'Code - Insiders.exe'), path.join(appDirectory, 'VSCodium.exe')];
    for (const candidate of candidates) {
      // 本地 Node 扩展宿主的 process.execPath 通常是 Code.exe，但不能把 node.exe 当成 Code。
      if (!/^(?:code(?:\s*-\s*(?:insiders|exploration))?|vscodium)\.exe$/i.test(path.basename(candidate))) { continue; }
      if ((await fs.stat(candidate).catch(() => undefined))?.isFile()) { return candidate; }
    }
    const selected = await vscode.window.showOpenDialog({
      title: t("选择当前 VSCode 桌面程序（Code.exe / Code - Insiders.exe）"),
      openLabel: t("使用这个 VSCode"), canSelectMany: false, canSelectFolders: false,
      filters: { [t("VSCode 程序")]: ['exe'] }
    });
    const file = selected?.[0];
    if (!file) { return undefined; }
    if (file.scheme !== 'file' || !/\.exe$/i.test(file.fsPath)) { throw new Error(t("请选择本地 VSCode .exe 程序。")); }
    return file.fsPath;
  }

  private async writeConfig(config: ShellConfiguration): Promise<void> {
    // PowerShell 5.1 使用 BOM 识别 UTF-8，中文用户目录和文件名也能正确往返。
    await fs.writeFile(this.configFile + '.tmp', '\uFEFF' + JSON.stringify(config, null, 2), 'utf8');
    await fs.rename(this.configFile + '.tmp', this.configFile);
  }

  private async prepareRegistryScript(): Promise<void> {
    await fs.mkdir(this.storageDirectory, { recursive: true });
    await fs.copyFile(path.join(this.context.extensionPath, 'resources', 'ExplorerRegistry.ps1'), this.registryScript);
    const remove = [
      '$ErrorActionPreference = "Stop"',
      '& (Join-Path $PSScriptRoot "ExplorerRegistry.ps1") -Operation Remove -ConfigPath (Join-Path $PSScriptRoot "explorer-config.json")',
      'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
      'Write-Host "iXena Unreal Tools Explorer menus removed."', ''
    ].join('\r\n');
    await fs.writeFile(path.join(this.storageDirectory, 'Remove-ExplorerMenu.ps1'), '\uFEFF' + remove, 'utf8');
  }

  private async existingOrPlaceholderConfig(powershellExe: string): Promise<void> {
    try {
      const raw = JSON.parse((await fs.readFile(this.configFile, 'utf8')).replace(/^\uFEFF/, ''));
      if (raw.schemaVersion === 1 && raw.extensionId === EXPLORER_EXTENSION_ID && raw.uriScheme === vscode.env.uriScheme) { return; }
    } catch { /* 新安装或损坏的自有配置可从当前产品参数重建，移除仍不依赖 Code.exe 存在。 */ }
    await this.writeConfig({ schemaVersion: 1, extensionId: EXPLORER_EXTENSION_ID,
      uriScheme: vscode.env.uriScheme, powershellExe,
      codeExe: path.join(path.resolve(vscode.env.appRoot, '..', '..'), 'Code.exe'),
      bridgePath: path.join(this.storageDirectory, 'ExplorerBridge.ps1') });
  }

  private async runRegistry(operation: 'Install' | 'Remove' | 'Status', powershellExe: string): Promise<Record<string, unknown>> {
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      this.registryScript, '-Operation', operation, '-ConfigPath', this.configFile];
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(powershellExe, args, { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
        encoding: 'utf8' }, (error, out, stderr) => {
        if (error) { reject(new Error(t("系统菜单{0}失败：{1}", operation === 'Remove' ? t("移除") : operation === 'Install' ? t("注册") : t("查询"), String(stderr || error.message).trim().slice(0, 3000)))); }
        else { resolve(out); }
      });
    });
    return JSON.parse(stdout.trim().replace(/^\uFEFF/, '')) as Record<string, unknown>;
  }

  async register(): Promise<void> {
    this.checkAvailable();
    if (this.registryBusy) { throw new Error(t("正在更新系统菜单，请稍后再试。")); }
    this.registryBusy = true;
    try {
      const powershellExe = await this.powershellPath();
      const codeExe = await this.codePath();
      if (!codeExe) { return; }
      await this.prepareRegistryScript();
      const bridgePath = path.join(this.storageDirectory, 'ExplorerBridge.ps1');
      await fs.copyFile(path.join(this.context.extensionPath, 'resources', 'ExplorerBridge.ps1'), bridgePath);
      await this.writeConfig({ schemaVersion: 1, extensionId: EXPLORER_EXTENSION_ID,
        uriScheme: vscode.env.uriScheme, codeExe, powershellExe, bridgePath });
      const result = await this.runRegistry('Install', powershellExe);
      if (!result.installed) { throw new Error(t("注册后未能验证两类文件的菜单，请查看插件日志。")); }
      this.hooks.output(t("已注册当前用户 Explorer 菜单：{0}。桥接目录：{1}", explorerRegistryPaths(vscode.env.uriScheme).join('；'), this.storageDirectory));
      void vscode.window.showInformationMessage(t("已注册 .uproject / .uplugin 的 iXena Unreal Tools 右键菜单。Windows 11 请在“显示更多选项”中查看。"));
    } finally { this.registryBusy = false; }
  }

  async unregister(): Promise<void> {
    this.checkAvailable();
    if (this.registryBusy) { throw new Error(t("正在更新系统菜单，请稍后再试。")); }
    this.registryBusy = true;
    try {
      const powershellExe = await this.powershellPath();
      await this.prepareRegistryScript();
      await this.existingOrPlaceholderConfig(powershellExe);
      const result = await this.runRegistry('Remove', powershellExe);
      if (result.project || result.plugin || result.projectKeyPresent || result.pluginKeyPresent) {
        throw new Error(t("部分菜单未能移除，请查看插件日志。"));
      }
      this.hooks.output(t("已移除本插件的当前用户 Explorer 菜单。"));
      void vscode.window.showInformationMessage(t("已移除 iXena Unreal Tools 系统右键菜单，UE 原有菜单保持不变。"));
    } finally { this.registryBusy = false; }
  }

  async showStatus(): Promise<void> {
    this.checkAvailable();
    if (this.registryBusy) { throw new Error(t("正在更新系统菜单，请稍后再试。")); }
    this.registryBusy = true;
    try {
      const powershellExe = await this.powershellPath();
      await this.prepareRegistryScript();
      await this.existingOrPlaceholderConfig(powershellExe);
      const result = await this.runRegistry('Status', powershellExe);
      const registered = Boolean(result.installed);
      this.hooks.output(t("Explorer 菜单状态：{0}；桥接目录：{1}", JSON.stringify(result), this.storageDirectory));
      const choice = await vscode.window.showInformationMessage(
        `.uproject：${result.project ? t("已注册") : t("未注册")}；.uplugin：${result.plugin ? t("已注册") : t("未注册")}`,
        t("打开菜单维护目录"), registered ? t("更新注册") : t("注册菜单"));
      if (choice === t("打开菜单维护目录")) { await vscode.env.openExternal(vscode.Uri.file(this.storageDirectory)); }
      else if (choice) { this.registryBusy = false; await this.register(); }
    } finally { this.registryBusy = false; }
  }

  async handleUri(uri: vscode.Uri): Promise<void> {
    this.checkAvailable();
    if (uri.scheme !== vscode.env.uriScheme || uri.authority !== EXPLORER_EXTENSION_ID || uri.fragment) {
      throw new Error(t("无法识别的 iXena Unreal Tools 系统菜单链接。"));
    }
    const request = parseExplorerRequest(uri.path, uri.query);
    const file = vscode.Uri.file(request.file);
    const stat = await fs.stat(request.file).catch(() => undefined);
    if (!stat?.isFile()) { throw new Error(t("描述文件不存在或不可读取：{0}", request.file)); }
    this.hooks.output(`Explorer ${request.action}：${request.file}`);
    if (request.action === 'edit') { await this.hooks.openDescriptor(file); return; }
    if (request.action === 'source') { await vscode.commands.executeCommand('vscode.openWith', file, 'default'); return; }
    const directory = path.dirname(request.file);
    let target = directory;
    if (/\.uproject$/i.test(request.file)) {
      const candidates = await findProjectWorkspaces(request.file);
      if (candidates.length === 1) { target = candidates[0]; }
      else if (candidates.length > 1) {
        const picked = await vscode.window.showQuickPick([
          ...candidates.map(filename => ({ label: path.basename(filename), description: t("已有 UE 工作区"), filename })),
          { label: t("直接打开项目文件夹"), description: directory, filename: directory }
        ], { title: t("选择这个项目的 VSCode 工作区") });
        if (!picked) { return; }
        target = picked.filename;
      }
    }
    const same = (a?: string, b?: string) => Boolean(a && b && path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase());
    const current = vscode.workspace.workspaceFile;
    const inThisWindow = same(current?.scheme === 'file' ? current.fsPath : undefined, target)
      || (!current && vscode.workspace.workspaceFolders?.some(folder => folder.uri.scheme === 'file' && same(folder.uri.fsPath, target)));
    if (inThisWindow) { await vscode.commands.executeCommand('workbench.view.explorer'); }
    else { await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: true }); }
  }

  dispose(): void { this.disposables.splice(0).forEach(item => item.dispose()); }
}
