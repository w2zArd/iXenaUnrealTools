# iXenaUnrealTools per-user Explorer menu registration. No administrator rights.
# Only two owned SystemFileAssociations shell keys are written or removed.
# Invoke this copied script with -Operation Remove for manual recovery after uninstall.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Install', 'Remove', 'Status')]
    [string]$Operation,
    [Parameter(Mandatory = $true)]
    [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Assert-FilePath([object]$Value, [string]$Label, [bool]$MustExist) {
    if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt 8192 -or $Value -match '[\x00-\x1f\x7f<>"|?*]') {
        throw "$Label 路径无效或过长。"
    }
    $normalized = $Value.Replace('/', '\')
    if ($normalized -match '^\\\\[.?]\\' -or $normalized -match '^\\\?\?\\' -or
        ($normalized -notmatch '^[A-Za-z]:\\' -and $normalized -notmatch '^\\\\[^\\]+\\[^\\]+\\')) {
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
    $result = [IO.Path]::GetFullPath($normalized)
    if ($MustExist -and !(Test-Path -LiteralPath $result -PathType Leaf)) {
        throw "找不到 $Label 文件：$result"
    }
    return $result
}

function Read-OwnedKey([string]$SubKey) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($SubKey, $false)
    if ($null -eq $key) { return $false }
    try {
        if ($key.GetValue('iXenaOwner', '') -cne 'ixena-local.ixena-unreal-tools') {
            throw "同名注册表项未标记为本插件所有，无法覆盖或删除：HKCU\$SubKey"
        }
        return $true
    } finally { $key.Dispose() }
}

function Test-CompleteMenu([string]$SubKey, [hashtable]$Commands) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($SubKey, $false)
    if ($null -eq $key) { return $false }
    try {
        if ($key.GetValue('MUIVerb', '') -cne 'iXena Unreal Tools' -or
            @($key.GetValueNames()) -cnotcontains 'SubCommands') { return $false }
        $actions = @('open', 'edit', 'source')
        for ($item = 0; $item -lt $actions.Count; $item++) {
            $commandKey = $key.OpenSubKey(('shell\{0:00}_{1}\command' -f ($item + 1), $actions[$item]), $false)
            if ($null -eq $commandKey) { return $false }
            try {
                if ($commandKey.GetValue('', '') -cne $Commands[$actions[$item]]) { return $false }
            } finally { $commandKey.Dispose() }
        }
        return $true
    } finally { $key.Dispose() }
}

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw '资源管理器右键菜单注册仅支持 Windows。'
    }
    $configFile = Assert-FilePath $ConfigPath '菜单配置' $true
    $config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($config -isnot [pscustomobject]) { throw '右键菜单配置格式无效。' }
    $required = @('schemaVersion', 'codeExe', 'powershellExe', 'bridgePath', 'uriScheme', 'extensionId')
    $actual = @($config.PSObject.Properties.Name)
    if ($actual.Count -ne $required.Count -or @($required | Where-Object { $_ -cnotin $actual }).Count -gt 0) {
        throw '右键菜单配置字段无效。'
    }
    if (($config.schemaVersion -isnot [int] -and $config.schemaVersion -isnot [long]) -or $config.schemaVersion -ne 1 -or $config.extensionId -cne 'ixena-local.ixena-unreal-tools') {
        throw '右键菜单配置版本或插件标识无效。'
    }
    if ($config.uriScheme -isnot [string] -or $config.uriScheme -cnotmatch '^[a-z][a-z0-9+.-]{0,63}$') {
        throw 'VSCode URI scheme 无效。'
    }
    # Removal and status still work after a VSCode installation has moved or disappeared.
    $mustExist = $Operation -eq 'Install'
    $codeExe = Assert-FilePath $config.codeExe 'VSCode' $mustExist
    $powerShellExe = Assert-FilePath $config.powershellExe 'PowerShell' $mustExist
    $bridgePath = Assert-FilePath $config.bridgePath '右键菜单桥接' $mustExist
    if ([IO.Path]::GetExtension($codeExe) -ine '.exe' -or
        [IO.Path]::GetFileName($powerShellExe) -notmatch '^(powershell|pwsh)\.exe$' -or
        [IO.Path]::GetFileName($bridgePath) -ine 'ExplorerBridge.ps1') {
        throw '配置中的可执行程序或桥接文件名无效。'
    }
    if ([IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetDirectoryName($bridgePath)) 'explorer-config.json')) -ine $configFile) {
        throw 'ExplorerBridge.ps1 与 explorer-config.json 必须位于同一目录。'
    }
    $keyName = 'iXenaUnrealTools.' + $config.uriScheme
    $keyPaths = @(
        ('Software\Classes\SystemFileAssociations\.uproject\shell\' + $keyName),
        ('Software\Classes\SystemFileAssociations\.uplugin\shell\' + $keyName)
    )
    # Validate all existing ownership and all command arguments before the first mutation.
    $present = @($keyPaths | ForEach-Object { Read-OwnedKey $_ })
    $commands = @{}
    foreach ($actionName in @('open', 'edit', 'source')) {
        $commands[$actionName] = '"{0}" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{1}" -Action {2} -DescriptorPath "%1"' -f $powerShellExe, $bridgePath, $actionName
    }
    if ($Operation -eq 'Install') {
        for ($index = 0; $index -lt $keyPaths.Count; $index++) {
            $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($keyPaths[$index])
            try {
                $key.SetValue('iXenaOwner', 'ixena-local.ixena-unreal-tools', [Microsoft.Win32.RegistryValueKind]::String)
                $key.SetValue('iXenaSchema', 1, [Microsoft.Win32.RegistryValueKind]::DWord)
                $key.SetValue('MUIVerb', 'iXena Unreal Tools', [Microsoft.Win32.RegistryValueKind]::String)
                $key.SetValue('Icon', ('"' + $codeExe + '",0'), [Microsoft.Win32.RegistryValueKind]::String)
                $key.SetValue('SubCommands', '', [Microsoft.Win32.RegistryValueKind]::String)
                $key.SetValue('MultiSelectModel', 'Single', [Microsoft.Win32.RegistryValueKind]::String)
                $key.DeleteValue('', $false)
                $labels = if ($index -eq 0) { @('在 VSCode 中打开项目', '可视化编辑项目描述', '编辑原始 JSON') } else { @('在 VSCode 中打开插件目录', '可视化编辑插件描述', '编辑原始 JSON') }
                $actions = @('open', 'edit', 'source')
                for ($item = 0; $item -lt $actions.Count; $item++) {
                    $verb = $key.CreateSubKey(('shell\{0:00}_{1}' -f ($item + 1), $actions[$item]))
                    try {
                        $verb.SetValue('MUIVerb', $labels[$item], [Microsoft.Win32.RegistryValueKind]::String)
                        $verb.SetValue('MultiSelectModel', 'Single', [Microsoft.Win32.RegistryValueKind]::String)
                        $commandKey = $verb.CreateSubKey('command')
                        try { $commandKey.SetValue('', $commands[$actions[$item]], [Microsoft.Win32.RegistryValueKind]::String) }
                        finally { $commandKey.Dispose() }
                    } finally { $verb.Dispose() }
                }
            } finally { $key.Dispose() }
        }
    } elseif ($Operation -eq 'Remove') {
        foreach ($subKey in $keyPaths) {
            [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($subKey, $false)
        }
    }
    # Notify Explorer without restarting or terminating the user's Explorer process.
    $shellNotified = $false
    if ($Operation -ne 'Status') {
        try {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace Ixena.UnrealTools {
    public static class ExplorerNotification {
        [DllImport("shell32.dll")]
        public static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);
    }
}
'@
            [Ixena.UnrealTools.ExplorerNotification]::SHChangeNotify(0x08000000, 0x3000, [IntPtr]::Zero, [IntPtr]::Zero)
            $shellNotified = $true
        } catch {
            # The registration remains valid when policy prevents Add-Type.
            # Closing and reopening the context menu/Explorer refreshes its view.
        }
    }
    $present = @($keyPaths | ForEach-Object { Read-OwnedKey $_ })
    $complete = @($keyPaths | ForEach-Object { Test-CompleteMenu $_ $commands })
    $result = [ordered]@{
        schemaVersion = 1
        operation = $Operation
        installed = ($complete[0] -and $complete[1])
        project = $complete[0]
        plugin = $complete[1]
        projectKeyPresent = $present[0]
        pluginKeyPresent = $present[1]
        shellNotified = $shellNotified
        uriScheme = $config.uriScheme
        keys = @($keyPaths | ForEach-Object { 'HKCU\' + $_ })
    }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 5 -Compress))
    exit 0
} catch {
    [Console]::Error.WriteLine(('iXenaUnrealTools Explorer registry: ' + $_.Exception.Message))
    exit 1
}
