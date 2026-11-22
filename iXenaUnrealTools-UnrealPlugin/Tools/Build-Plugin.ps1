#requires -Version 5.1
# 只生成可手动安装的插件包，不复制到项目/引擎，不修改 .uproject。
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$EngineRoot,
    [Parameter(Mandatory = $true)][string]$Package,
    [string]$Plugin = (Join-Path $PSScriptRoot '..\iXenaUnrealBridge\iXenaUnrealBridge.uplugin'),
    [ValidateSet('auto', 'zh-CN', 'en')][string]$Language = 'auto',
    [switch]$KeepSymbols
)
$ErrorActionPreference = 'Stop'
$UseChinese = $Language -eq 'zh-CN' -or ($Language -eq 'auto' -and (Get-UICulture).Name.StartsWith('zh', [StringComparison]::OrdinalIgnoreCase))
function Say([string]$Chinese, [string]$English) {
    if ($UseChinese) { Write-Host $Chinese } else { Write-Host $English }
}
function Fail([string]$Chinese, [string]$English) {
    if ($UseChinese) { throw $Chinese } else { throw $English }
}
try {
    if ($env:OS -ne 'Windows_NT') { Fail 'Windows 使用此脚本；macOS/Linux 请使用 Build-Plugin.sh。' 'Use this script on Windows; use Build-Plugin.sh on macOS/Linux.' }
    foreach ($InputPath in @($EngineRoot, $Package, $Plugin)) {
        # Windows 批处理经过 CMD；显式拒绝元字符，避免把路径内容解释成命令。
        if ($InputPath.IndexOfAny([char[]]"`r`n`"%!&|<>^") -ge 0) { Fail '路径不能包含 CMD 元字符（例如 %、!、&、引号或换行）。' 'Paths cannot contain CMD metacharacters such as %, !, &, quotes or line breaks.' }
    }
    if ($EngineRoot -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])' -or $Package -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])') {
        Fail '引擎和输出路径必须为绝对路径。' 'Engine and output paths must be absolute.'
    }
    $EngineRoot = [IO.Path]::GetFullPath($EngineRoot).TrimEnd([char[]]"\/")
    $Plugin = [IO.Path]::GetFullPath($Plugin)
    $Package = [IO.Path]::GetFullPath($Package).TrimEnd([char[]]"\/")
    $RunUat = Join-Path $EngineRoot 'Engine\Build\BatchFiles\RunUAT.bat'
    if (-not (Test-Path -LiteralPath (Join-Path $EngineRoot 'Engine\Build\Build.version') -PathType Leaf) -or -not (Test-Path -LiteralPath $RunUat -PathType Leaf)) {
        Fail '所选目录缺少 Build.version 或 RunUAT.bat。' 'The selected engine lacks Build.version or RunUAT.bat.'
    }
    if (-not (Test-Path -LiteralPath $Plugin -PathType Leaf) -or [IO.Path]::GetFileName($Plugin) -ne 'iXenaUnrealBridge.uplugin') {
        Fail '未找到 iXenaUnrealBridge.uplugin 源文件。' 'The iXenaUnrealBridge.uplugin source file was not found.'
    }
    $SourceDirectory = [IO.Path]::GetDirectoryName($Plugin)
    $OutputParent = [IO.Path]::GetDirectoryName($Package)
    if ([string]::IsNullOrWhiteSpace($OutputParent) -or -not (Test-Path -LiteralPath $OutputParent -PathType Container)) { Fail '请先创建输出目录的父目录；不能以磁盘根目录作为输出。' 'Create the output parent directory first; a drive root cannot be used as output.' }
    foreach ($ProtectedPath in @($EngineRoot, $SourceDirectory)) {
        if ($Package.Equals($ProtectedPath, [StringComparison]::OrdinalIgnoreCase) -or $Package.StartsWith($ProtectedPath + '\', [StringComparison]::OrdinalIgnoreCase)) {
            Fail '输出目录必须位于引擎和插件源码之外。' 'The output must be outside the engine and plugin source.'
        }
    }
    # 不通过链接/联接目录让 UAT 覆盖到另一个位置。
    $Ancestor = Get-Item -LiteralPath $OutputParent
    while ($null -ne $Ancestor) {
        if (($Ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail '输出路径不能经过符号链接或目录联接。' 'The output path cannot traverse a symlink or directory junction.' }
        $Ancestor = $Ancestor.Parent
    }
    if (Test-Path -LiteralPath $Package) {
        $Existing = Get-Item -LiteralPath $Package
        if (-not $Existing.PSIsContainer -or ($Existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or @(Get-ChildItem -LiteralPath $Package -Force).Count -gt 0) {
            Fail '输出位置非空或为链接；请选择新目录，不自动删除旧文件。' 'The output is not empty or is a link; choose a new directory. Existing files are not deleted.'
        }
    }
    Say '[1/3] 路径已确认；即将启动 UAT。' '[1/3] Paths verified; starting UAT.'
    Write-Host "Engine: $EngineRoot"
    Write-Host "Source: $Plugin"
    Write-Host "Package: $Package"
    Say '[2/3] 构建中，下面实时显示 UAT / UBT 输出。' '[2/3] Building; live UAT / UBT output follows.'
    $BuildArguments = @('BuildPlugin', "-Plugin=$Plugin", "-Package=$Package", '-TargetPlatforms=Win64')
    & $RunUat @BuildArguments
    $BuildResult = $LASTEXITCODE
    if ($BuildResult -isnot [int]) { Fail '没有收到 UAT 退出码，不能确认构建成功。' 'No UAT exit code was received; build success cannot be confirmed.' }
    if ($BuildResult -ne 0) {
        Say "UAT 构建失败，退出码 $BuildResult；未安装插件。" "UAT failed with exit code $BuildResult; nothing was installed."
        exit $BuildResult
    }
    Say '[3/3] 检查插件包。' '[3/3] Checking the plugin package.'
    $Binaries = Join-Path $Package 'Binaries\Win64'
    if (-not (Test-Path -LiteralPath (Join-Path $Package 'iXenaUnrealBridge.uplugin') -PathType Leaf) -or -not (Test-Path -LiteralPath $Binaries -PathType Container)) { Fail 'UAT 返回成功，但插件包缺少描述文件或二进制目录。' 'UAT returned success, but the package lacks the descriptor or binaries directory.' }
    if (@(Get-ChildItem -LiteralPath $Binaries -Filter '*.modules' -File).Count -eq 0 -or @(Get-ChildItem -LiteralPath $Binaries -Filter '*iXenaUnrealBridge*.dll' -File).Count -eq 0) {
        Fail 'UAT 返回成功，但插件包缺少模块清单或本机 DLL。' 'UAT returned success, but the package lacks a module manifest or native DLL.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Package 'Resources\ConsoleHelp.zh-CN.json') -PathType Leaf)) {
        Fail '构建包缺少中文命令帮助资源文件，请确认 Resources 目录已随插件打包。' 'The plugin package is missing Resources/ConsoleHelp.zh-CN.json; verify the Resources directory was packaged.'
    }
    if (-not $KeepSymbols) {
        Get-ChildItem -LiteralPath $Package -Filter '*.pdb' -File -Recurse | Remove-Item -Force
        Get-ChildItem -LiteralPath $Package -Filter '*.dSYM' -Directory -Recurse | Remove-Item -Force -Recurse
    }
    Say '构建成功。请将输出目录完整复制为项目 Plugins\iXenaUnrealBridge 或引擎 Engine\Plugins\iXena\iXenaUnrealBridge。' 'Build succeeded. Copy the complete output folder to project Plugins\iXenaUnrealBridge or engine Engine\Plugins\iXena\iXenaUnrealBridge.'
    Say '先关闭 UE 再替换插件；随后在 Plugins → iXena 中启用并重启编辑器。此脚本没有自动安装。' 'Close UE before replacing the plugin; enable it under Plugins → iXena and restart the Editor. This script did not install it.'
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
