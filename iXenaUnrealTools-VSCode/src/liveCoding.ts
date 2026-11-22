import { t } from './i18n';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** The Win32 Editor's Live Coding compile is owned by the running editor, NOT by a UBT invocation. */
export type LiveCodingResult = 'completed' | 'dispatched' | 'not-running' | 'different-project' |
  'unverified-project' | 'multiple-editors' | 'engine-mismatch' |
  'no-window' | 'focus-denied' | 'different-session' | 'input-blocked';
export type BuildMode = 'auto' | 'ubt';
export type BuildDecision = 'live-coding' | 'ubt' | 'blocked';

/** Keep the ordinary UBT path for non-Editor targets; never silently fall back after an ambiguous check. */
export function decideBuild(mode: BuildMode, target: string, result: LiveCodingResult): BuildDecision {
  if (mode === 'ubt' || !/Editor$/i.test(target)) { return 'ubt'; }
  if (result === 'completed' || result === 'dispatched') { return 'live-coding'; }
  if (result === 'not-running' || result === 'different-project') { return 'ubt'; }
  return 'blocked';
}

export function explainLiveCodingResult(result: LiveCodingResult, projectPath: string): string {
  switch (result) {
    case 'completed': return t("通讯请求已完成，编译是否成功以 UE 返回的结果状态为准。");
    case 'not-running': return t("未检测到运行中的 Unreal Editor。Live Coding 必须由已经打开的 UE 编辑器触发。");
    case 'different-project': return t("正在运行的 Unreal Editor 并未打开当前项目：{0}。为避免编译错误项目，未发送快捷键。", projectPath);
    case 'unverified-project': return t("无法从 Unreal Editor 进程参数中确认其 .uproject 路径；未发送可能作用到其他项目的快捷键。请在目标 UE 编辑器中使用 Ctrl+Alt+F11。");
    case 'multiple-editors': return t("检测到多个 Unreal Editor 实例。UE 的 Live Coding 快捷键是全局快捷键，无法保证作用于当前项目；未发送快捷键。请在目标 UE 编辑器中使用 Ctrl+Alt+F11，或关闭其他编辑器后重试。");
    case 'engine-mismatch': return t("运行中的 UE 编辑器与所选 UE 工具链引擎目录不一致。请在插件中切换正确的 UE 引擎，或关闭旧编辑器后重试。");
    case 'no-window': return t("已定位到 Unreal Editor 进程，但其主窗口不可用（可能正在启动、关闭或运行在后台桌面）。请确认 UE 编辑器已进入主界面。");
    case 'focus-denied': return t("Windows 拒绝把目标 Unreal Editor 窗口置于前台，未发送快捷键。请先切换到 UE 编辑器后重试，或手动按 Ctrl+Alt+F11。");
    case 'different-session': return t("Unreal Editor 与 VSCode 不在同一个 Windows 登录会话，无法安全传送热更新快捷键。");
    case 'input-blocked': return t("Windows 拒绝注入 Live Coding 快捷键。若 UE 以管理员身份运行，请检查 VSCode 是否具有相同权限，并尝试在 UE 内手动按 Ctrl+Alt+F11。");
    case 'dispatched': return t("快捷键已发送到经验证的 Unreal Editor 前台窗口，但尚不能确认 UE 是否开始 Live Coding；请以 UE 的 Live Coding Console 为准。");
  }
}

/**
 * Match exactly one running editor to its full .uproject and engine directory.  Before
 * injecting the shortcut, bring THAT editor's top-level window to the foreground and
 * verify foreground ownership by process ID.  In UE5.6+ the optional Live++ 2 path
 * can handle the hotkey in the editor rather than in a global broker; dispatching
 * against a hidden PowerShell window (as 0.4.3 did) is not reliable.
 *
 * This is still ONLY input dispatch, not proof that Live Coding started or completed.
 * Win32 SetForegroundWindow may legitimately refuse focus; we fail closed rather
 * than claiming success when the shortcut may have gone to a different application.
 *
 * All project/engine text enters the script as Base64 UTF-8 constants (not code).
 */
export function makeLiveCodingScript(projectPath: string, engineRoot: string): string {
  if (!/^[A-Za-z]:[\\/]|^\\\\/.test(projectPath) || !/\.uproject$/i.test(projectPath)) {
    throw new Error(t("Live Coding 需要完整的 Windows .uproject 绝对路径。"));
  }
  if (!/^[A-Za-z]:[\\/]|^\\\\/.test(engineRoot)) {
    throw new Error(t("Live Coding 需要完整的 Windows UE 引擎路径。"));
  }
  const project64 = Buffer.from(projectPath, 'utf8').toString('base64');
  const engine64 = Buffer.from(engineRoot, 'utf8').toString('base64');
  return String.raw`$ErrorActionPreference = 'Stop'
$project = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${project64}')).Replace('/', '\')
$engine = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${engine64}')).Replace('/', '\')
$engine = [IO.Path]::GetFullPath($engine).TrimEnd('\') + '\'
function Result([string]$value) {
    [Console]::Out.WriteLine('IXENA_LIVE_CODING_RESULT:' + $value)
}
# Only the full Unreal Editor process can accept the Live Coding shortcut. Never
# select UnrealEditor-Cmd or a process with no verifiable .uproject command line.
$editors = @(Get-CimInstance -ClassName Win32_Process -Filter "Name LIKE 'UnrealEditor%.exe'" -ErrorAction Stop |
    Where-Object { $_.Name -match '^UnrealEditor(?:-Win64-(?:Debug|DebugGame|Development))?\.exe$' })
if ($editors.Count -eq 0) { Result 'not-running'; return }
if ($editors.Count -ne 1) { Result 'multiple-editors'; return }
$editor = $editors[0]
if ([string]::IsNullOrWhiteSpace($editor.CommandLine) -or [string]::IsNullOrWhiteSpace($editor.ExecutablePath)) {
    Result 'unverified-project'; return
}
$commandLine = $editor.CommandLine.Replace('/', '\')
$pattern = '(?i)(?:^|[\s=])"?' + [Regex]::Escape([IO.Path]::GetFullPath($project)) + '"?(?=$|[\s"])'
if (-not [Regex]::IsMatch($commandLine, $pattern)) {
    if ($commandLine -match '(?i)\.uproject(?:"|\s|$)') { Result 'different-project' }
    else { Result 'unverified-project' }
    return
}
$actualExe = [IO.Path]::GetFullPath($editor.ExecutablePath)
if (-not $actualExe.StartsWith($engine, [StringComparison]::OrdinalIgnoreCase)) {
    Result 'engine-mismatch'; return
}
if (-not [Environment]::Is64BitProcess) { throw 'Live Coding requires 64-bit Windows PowerShell.' }
$process = Get-Process -Id $editor.ProcessId -ErrorAction Stop
if ($process.SessionId -ne (Get-Process -Id $PID).SessionId) {
    Result 'different-session'; return
}
$handle = $process.MainWindowHandle
if ($handle -eq [IntPtr]::Zero) { Result 'no-window'; return }
$code = @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
[StructLayout(LayoutKind.Explicit, Size = 40)]
public struct IXenaKeyboardInput {
    [FieldOffset(0)] public int Type;
    [FieldOffset(8)] public ushort VirtualKey;
    [FieldOffset(10)] public ushort ScanCode;
    [FieldOffset(12)] public uint Flags;
    [FieldOffset(16)] public uint Time;
    [FieldOffset(24)] public IntPtr ExtraInfo;
}
public static class IXenaLiveCodingKeyboard {
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, IXenaKeyboardInput[] inputs, int size);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(IntPtr hwnd, int cmd);
    private static IntPtr originalWindow = IntPtr.Zero;
    private static uint targetPid;
    private static IXenaKeyboardInput Key(ushort vk, bool up) {
        return new IXenaKeyboardInput { Type = 1, VirtualKey = vk, Flags = up ? 2u : 0u };
    }
    public static bool Focus(IntPtr targetWindow, uint pid) {
        originalWindow = GetForegroundWindow();
        targetPid = pid;
        if (IsIconic(targetWindow)) ShowWindowAsync(targetWindow, 9); // SW_RESTORE
        uint activePid;
        GetWindowThreadProcessId(GetForegroundWindow(), out activePid);
        if (activePid != pid) {
            SetForegroundWindow(targetWindow);
            for (int i = 0; i < 12; ++i) {
                Thread.Sleep(65);
                GetWindowThreadProcessId(GetForegroundWindow(), out activePid);
                if (activePid == pid) break;
            }
        }
        GetWindowThreadProcessId(GetForegroundWindow(), out activePid);
        return activePid == pid;
    }
    public static bool IsForeground(uint pid) {
        uint activePid;
        GetWindowThreadProcessId(GetForegroundWindow(), out activePid);
        return activePid == pid;
    }
    public static bool Compile() {
        // Do not send to another foreground app if focus changed while we waited.
        uint activePid;
        GetWindowThreadProcessId(GetForegroundWindow(), out activePid);
        if (activePid != targetPid) return false;
        // CTRL down, ALT down, F11 down/up, ALT up, CTRL up.
        var inputs = new [] { Key(0x11, false), Key(0x12, false), Key(0x7A, false),
                               Key(0x7A, true), Key(0x12, true), Key(0x11, true) };
        uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(IXenaKeyboardInput)));
        if (sent != (uint)inputs.Length) return false;
        // Let the editor's message loop process the hotkey before restoring IDE focus.
        Thread.Sleep(350);
        return true;
    }
    public static void Restore() {
        // Best effort only: do not override a new user-driven window switch.
        if (originalWindow == IntPtr.Zero) return;
        uint activePid;
        GetWindowThreadProcessId(GetForegroundWindow(), out activePid);
        if (activePid == targetPid) SetForegroundWindow(originalWindow);
    }
}
'@
Add-Type -TypeDefinition $code -ErrorAction Stop
if (-not [IXenaLiveCodingKeyboard]::Focus($handle, [uint32]$editor.ProcessId)) {
    # Some Windows foreground-lock states reject SetForegroundWindow directly.
    # Use the built-in Windows Script Host COM object as a best-effort fallback.
    # Never proceed without independently verifying the foreground PID again.
    try {
        $shell = New-Object -ComObject WScript.Shell -ErrorAction Stop
        $null = $shell.AppActivate([int]$editor.ProcessId)
        Start-Sleep -Milliseconds 200
    } catch { }
    if (-not [IXenaLiveCodingKeyboard]::IsForeground([uint32]$editor.ProcessId)) {
        Result 'focus-denied'; return
    }
}
try {
    if (-not [IXenaLiveCodingKeyboard]::Compile()) { Result 'input-blocked'; return }
    Result 'dispatched'
} finally {
    [IXenaLiveCodingKeyboard]::Restore()
}
`;
}

export function parseLiveCodingResult(stdout: string): LiveCodingResult {
  const allowed: readonly LiveCodingResult[] = [
    'dispatched', 'not-running', 'different-project', 'unverified-project', 'multiple-editors', 'engine-mismatch',
    'no-window', 'focus-denied', 'different-session', 'input-blocked'
  ];
  const matches = [...stdout.matchAll(/^IXENA_LIVE_CODING_RESULT:([\w-]+)\s*$/gm)];
  if (matches.length !== 1 || !allowed.includes(matches[0][1] as LiveCodingResult)) {
    throw new Error(t("Live Coding 检测脚本未返回有效状态。请查看插件输出日志。"));
  }
  return matches[0][1] as LiveCodingResult;
}

export async function requestLiveCoding(projectPath: string, engineRoot: string,
  run: typeof execFileAsync = execFileAsync): Promise<LiveCodingResult> {
  if (process.platform !== 'win32') { throw new Error(t("UE Live Coding 触发仅支持 Windows。")); }
  const script = makeLiveCodingScript(projectPath, engineRoot);
  // -EncodedCommand prevents quoting/injection problems with Chinese, spaces and symbols in paths.
  const command = Buffer.from(script, 'utf16le').toString('base64');
  try {
    const result = await run('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', command
    ], { windowsHide: true, timeout: 15000, maxBuffer: 256 * 1024 });
    return parseLiveCodingResult(result.stdout.toString());
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(t("Live Coding 编辑器定位或快捷键发送失败（未确认编译）：{0}", detail));
  }
}
