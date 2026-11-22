# iXenaUnrealTools Explorer bridge. Windows PowerShell 5.1 / PowerShell 7.
# This file is copied to a stable, per-user globalStorage directory at registration.
# All file names are literal parameters. No command text is accepted from Explorer.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('open', 'edit', 'source')]
    [string]$Action,
    [Parameter(Mandatory = $true)]
    [string]$DescriptorPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Assert-AbsolutePath([object]$Value, [string]$Label) {
    if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt 8192 -or $Value -match '[\x00-\x1f\x7f<>"|?*]') {
        throw "$Label 路径无效或过长。"
    }
    $normalized = $Value.Replace('/', '\')
    if ($normalized -match '^\\\\[.?]\\' -or $normalized -match '^\\\?\?\\') {
        throw "$Label 不支持 Windows 设备路径。"
    }
    if ($normalized -notmatch '^[A-Za-z]:\\' -and $normalized -notmatch '^\\\\[^\\]+\\[^\\]+\\') {
        throw "$Label 必须是绝对本地路径或完整 UNC 路径。"
    }
    $tail = if ($normalized -match '^[A-Za-z]:\\') { $normalized.Substring(3) } else { $normalized.Substring(2) }
    foreach ($part in $tail.Split('\')) {
        if ([string]::IsNullOrEmpty($part) -or $part -eq '.' -or $part -eq '..' -or $part -match '[.: ]$' -or $part.Contains(':')) {
            throw "$Label 包含无效路径段。"
        }
        if ($part -match '^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)') {
            throw "$Label 包含 Windows 保留设备名称。"
        }
    }
    return [IO.Path]::GetFullPath($normalized)
}

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw '资源管理器右键桥接仅支持 Windows。'
    }
    $configPath = Join-Path $PSScriptRoot 'explorer-config.json'
    $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($config -isnot [pscustomobject]) { throw '右键菜单配置格式无效，请在 VSCode 中重新注册菜单。' }
    $required = @('schemaVersion', 'codeExe', 'powershellExe', 'bridgePath', 'uriScheme', 'extensionId')
    $actual = @($config.PSObject.Properties.Name)
    if ($actual.Count -ne $required.Count -or @($required | Where-Object { $_ -cnotin $actual }).Count -gt 0 -or
        ($config.schemaVersion -isnot [int] -and $config.schemaVersion -isnot [long]) -or
        $config.schemaVersion -ne 1 -or $config.extensionId -cne 'ixena-unreal-tools.ixena-unreal-tools') {
        throw '右键菜单配置无效，请在 VSCode 中重新注册菜单。'
    }
    if ($config.uriScheme -isnot [string] -or $config.uriScheme -cnotmatch '^[a-z][a-z0-9+.-]{0,63}$') {
        throw 'VSCode URI scheme 无效，请重新注册右键菜单。'
    }
    $codeExe = Assert-AbsolutePath $config.codeExe 'VSCode'
    if ([IO.Path]::GetExtension($codeExe) -ine '.exe' -or !(Test-Path -LiteralPath $codeExe -PathType Leaf)) {
        throw '找不到 VSCode 程序，安装位置可能已变化。请在 VSCode 中重新注册右键菜单。'
    }
    $file = Assert-AbsolutePath $DescriptorPath '描述文件'
    if ($file -notmatch '\.(uproject|uplugin)$' -or !(Test-Path -LiteralPath $file -PathType Leaf)) {
        throw '所选 .uproject 或 .uplugin 文件不存在。'
    }
    $payload = @{ version = 1; action = $Action; file = $file } | ConvertTo-Json -Compress
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    if ($encoded.Length + 8 -gt 24576) {
        throw '右键菜单请求过长。'
    }
    $uri = $config.uriScheme + '://ixena-unreal-tools.ixena-unreal-tools/explorer?payload=' + $encoded
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $codeExe
    # Base64url and the validated scheme contain no quotes or shell metacharacters.
    $start.Arguments = '--open-url "' + $uri + '"'
    $start.WorkingDirectory = [IO.Path]::GetDirectoryName($codeExe)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')
    $process = [Diagnostics.Process]::Start($start)
    if ($null -eq $process) { throw '无法启动 VSCode。' }
    $process.Dispose()
    exit 0
} catch {
    $message = 'iXenaUnrealTools Explorer: ' + $_.Exception.Message
    try {
        $logPath = Join-Path $PSScriptRoot 'bridge.log'
        if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 1048576) {
            [IO.File]::WriteAllText($logPath, '', [Text.UTF8Encoding]::new($false))
        }
        [IO.File]::AppendAllText($logPath, ([DateTime]::Now.ToString('s') + ' ' + $message + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
    } catch { }
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [void][System.Windows.Forms.MessageBox]::Show($message, 'iXenaUnrealTools', 'OK', 'Error')
    } catch { }
    [Console]::Error.WriteLine($message)
    exit 1
}
