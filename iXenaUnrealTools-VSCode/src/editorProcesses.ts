import { t } from './i18n';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export type EditorProcessState = 'running' | 'not-running' | 'engine-mismatch' | 'unknown';
const run = promisify(execFile);

/** 只读检查：用于智能编译决定能否使用标准 UBT，绝不发送按键或改变窗口。 */
export function editorProbeScript(projectPath: string, engineRoot: string): string {
  for (const value of [projectPath, engineRoot]) {
    if (typeof value !== 'string' || !/^(?:[A-Za-z]:[\\/]|\\\\)/.test(value) || /[\0\r\n]/.test(value)) {
      throw new Error(t("编辑器检测需要完整的 Windows 项目和引擎路径。"));
    }
  }
  if (!/\.uproject$/i.test(projectPath)) { throw new Error(t("编辑器检测需要 .uproject 文件。")); }
  const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');
  return String.raw`$ErrorActionPreference='Stop'
$project=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(projectPath)}')).Replace('/','\')
$engine=[IO.Path]::GetFullPath([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(engineRoot)}'))).TrimEnd('\')+'\'
$found=$false; $unknown=$false; $wrong=$false
$escaped=[Regex]::Escape($project)
$pattern='(?i)(?:^|[\s=])"?'+$escaped+'"?(?=$|[\s"])'
foreach($item in @(Get-CimInstance Win32_Process -Filter "Name LIKE 'UnrealEditor%.exe'")) {
 if($item.Name -notmatch '^UnrealEditor(?:-Win64-(?:Debug|DebugGame|Development))?\.exe$'){continue}
 if(-not $item.CommandLine -or -not $item.ExecutablePath){$unknown=$true;continue}
 if($item.CommandLine.Replace('/','\') -match $pattern) {
   if(([IO.Path]::GetFullPath($item.ExecutablePath)).StartsWith($engine,[StringComparison]::OrdinalIgnoreCase)){$found=$true}else{$wrong=$true}
 } else {
   # 相对路径启动不能证明是另一个项目；只接受一个明确的绝对项目参数。
   $absolute=@([Regex]::Matches($item.CommandLine.Replace('/','\'), '(?i)(?:^|[\s=])(?:"(?:[a-z]:\\|\\\\)[^"\r\n]+\.uproject"|(?:[a-z]:\\|\\\\)[^\s"]+\.uproject)(?=$|\s)'))
   if($absolute.Count -ne 1){$unknown=$true}
 }
}
$state=if($wrong){'engine-mismatch'}elseif($found){'running'}elseif($unknown){'unknown'}else{'not-running'}
[Console]::Out.WriteLine('IXENA_EDITOR_STATE:'+$state)`;
}

export function parseEditorProbe(output: string): EditorProcessState {
  const states = [...output.matchAll(/^IXENA_EDITOR_STATE:(running|not-running|engine-mismatch|unknown)\s*$/gm)];
  if (states.length !== 1) { throw new Error(t("没有取得唯一有效的 UE Editor 进程状态。")); }
  return states[0][1] as EditorProcessState;
}

export async function probeWindowsEditor(projectPath: string, engineRoot: string): Promise<EditorProcessState> {
  if (process.platform !== 'win32') { throw new Error(t("Windows 编辑器进程检测不能在此平台执行。")); }
  const result = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(editorProbeScript(projectPath, engineRoot), 'utf16le').toString('base64')],
  { windowsHide: true, timeout: 12000, maxBuffer: 128 * 1024 });
  return parseEditorProbe(result.stdout);
}

/** macOS/Linux 完整 Editor 构建前保守检查；没有桥插件也不能据此误判 Editor 已关闭。 */
export function hasPosixEditorProcess(output: string): boolean {
  return output.split('\n').some(line => /(?:^|[\s/])UnrealEditor(?:-(?!Cmd(?:\s|$))[^\s/]*)?(?:\s|$)/.test(line));
}
export async function assertPosixEditorsClosed(): Promise<void> {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error(t("此检查仅适用于 macOS/Linux。"));
  const result = await run('/bin/ps', ['-axo', 'pid=,comm='], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  if (hasPosixEditorProcess(result.stdout)) throw new Error(t("检测到运行中的 UE Editor。请先保存并关闭编辑器，再进行完整构建。"));
}
