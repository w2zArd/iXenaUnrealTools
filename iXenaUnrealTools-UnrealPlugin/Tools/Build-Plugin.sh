#!/usr/bin/env bash
# 只构建可手动安装的插件包；不复制到项目/引擎，不改写 .uproject。
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
engine=""
package=""
plugin="$script_dir/../iXenaUnrealBridge/iXenaUnrealBridge.uplugin"
language="auto"
keep_symbols=0

usage() {
  cat <<'HELP'
Usage: bash Tools/Build-Plugin.sh --engine /absolute/UE_5.x --package /absolute/output/iXenaUnrealBridge [options]
  --plugin PATH       Optional source .uplugin (defaults to the adjacent source folder).
  --language VALUE    auto, zh-CN or en. Auto follows the shell locale.
  --keep-symbols      Keep .pdb / .dSYM debugging symbols.
The output parent directory must exist. The output must be absent or empty.
This script runs the selected host engine's RunUAT.sh BuildPlugin with live output.
It does not install the package or edit a project descriptor.
HELP
}
while (($#)); do
  case "$1" in
    --engine|--package|--plugin|--language)
      if (($# < 2)); then printf 'Missing value for %s\n' "$1" >&2; exit 2; fi
      case "$1" in
        --engine) engine="$2";; --package) package="$2";; --plugin) plugin="$2";; --language) language="$2";;
      esac
      shift 2;;
    --keep-symbols) keep_symbols=1; shift;;
    --help|-h) usage; exit 0;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2;;
  esac
done
case "$language" in auto|zh-CN|en) ;; *) printf 'Invalid --language; choose auto, zh-CN or en.\n' >&2; exit 2;; esac
chinese=0
if [[ "$language" == zh-CN || ( "$language" == auto && "${LC_ALL:-${LC_MESSAGES:-${LANG:-en}}}" == zh* ) ]]; then chinese=1; fi
say() { if ((chinese)); then printf '%s\n' "$1"; else printf '%s\n' "$2"; fi; }
fail() { say "$1" "$2" >&2; exit "${3:-1}"; }
[[ -n "$engine" && -n "$package" ]] || { usage >&2; exit 2; }
[[ "$engine" == /* && "$package" == /* && "$plugin" == /* ]] || fail '引擎、输出和插件路径必须为绝对路径。' 'Engine, output and plugin paths must be absolute.' 2
[[ "$package" != *$'\n'* && "$engine" != *$'\n'* && "$plugin" != *$'\n'* ]] || fail '路径不能包含换行。' 'Paths cannot contain line breaks.' 2
[[ -d "$engine" && -f "$engine/Engine/Build/Build.version" ]] || fail '未找到引擎的 Engine/Build/Build.version。' 'Engine/Build/Build.version was not found.' 2
engine="$(cd -- "$engine" && pwd -P)"
[[ -f "$plugin" ]] || fail '未找到源码 .uplugin 文件。' 'The source .uplugin file was not found.' 2
plugin_dir="$(cd -- "$(dirname -- "$plugin")" && pwd -P)"
plugin="$plugin_dir/$(basename -- "$plugin")"
[[ "$(basename -- "$plugin")" == iXenaUnrealBridge.uplugin ]] || fail '此脚本仅构建 iXenaUnrealBridge.uplugin。' 'This script builds iXenaUnrealBridge.uplugin only.' 2
package="${package%/}"
[[ -n "$package" && "$package" != / ]] || fail '不能将根目录作为输出目录。' 'The filesystem root cannot be used as output.' 2
package_parent="$(dirname -- "$package")"
[[ -d "$package_parent" ]] || fail '请先创建输出目录的父目录。' 'Create the output parent directory first.' 2
package_name="$(basename -- "$package")"
[[ "$package_name" != . && "$package_name" != .. ]] || fail '输出目录名不能为 . 或 ..。' 'The output directory name cannot be . or .. .' 2
package="$(cd -- "$package_parent" && pwd -P)/$package_name"
[[ ! -L "$package" ]] || fail '输出目录不能是符号链接。' 'The output directory cannot be a symbolic link.' 2
case "$package/" in "$engine/"*|"$plugin_dir/"*) fail '输出目录必须位于引擎和插件源码之外。' 'The output must be outside the engine and plugin source.' 2;; esac
if [[ -e "$package" ]]; then
  [[ -d "$package" && -z "$(find "$package" -mindepth 1 -print -quit)" ]] || fail '输出位置非空；请选择新目录，不自动删除旧文件。' 'The output exists and is not empty; choose a new directory. Existing files are not deleted.' 2
fi
case "$(uname -s)" in Darwin) host=Mac; suffix=dylib;; Linux) host=Linux; suffix=so;; *) fail '请在 macOS/Linux 上使用此脚本；Windows 使用 Build-Plugin.ps1。' 'Use this script on macOS/Linux; use Build-Plugin.ps1 on Windows.' 2;; esac
uat="$engine/Engine/Build/BatchFiles/RunUAT.sh"
[[ -f "$uat" ]] || fail '未找到所选引擎的 RunUAT.sh。' 'RunUAT.sh was not found in the selected engine.' 2
say '[1/3] 路径已确认；即将启动 UAT。' '[1/3] Paths verified; starting UAT.'
printf 'Engine: %s\nSource: %s\nPackage: %s\nHost: %s\n' "$engine" "$plugin" "$package" "$host"
say '[2/3] 构建中，下面实时显示 UAT / UBT 输出。' '[2/3] Building; live UAT / UBT output follows.'
set +e
/bin/bash "$uat" BuildPlugin "-Plugin=$plugin" "-Package=$package" "-TargetPlatforms=$host"
build_result=$?
set -e
((build_result == 0)) || fail "UAT 构建失败，退出码 $build_result；未安装插件。" "UAT failed with exit code $build_result; nothing was installed." "$build_result"
say '[3/3] 检查插件包。' '[3/3] Checking the plugin package.'
shopt -s nullglob
manifests=("$package/Binaries/$host/"*.modules)
binaries=("$package/Binaries/$host/"*iXenaUnrealBridge*."$suffix")
[[ -f "$package/iXenaUnrealBridge.uplugin" && ${#manifests[@]} -gt 0 && ${#binaries[@]} -gt 0 ]] || fail 'UAT 返回成功，但插件包缺少描述文件、模块清单或本机动态库。' 'UAT returned success, but the package lacks a descriptor, module manifest or native library.'
[[ -f "$package/Resources/ConsoleHelp.zh-CN.json" ]] || fail '构建包缺少中文命令帮助资源文件，请确认 Resources 目录已随插件打包。' 'The plugin package is missing Resources/ConsoleHelp.zh-CN.json; verify Resources was packaged.'
if ((keep_symbols == 0)); then
  find "$package" -type f -name '*.pdb' -delete
  find "$package" -type d -name '*.dSYM' -prune -exec rm -rf -- {} +
fi
say '构建成功。请将输出目录完整复制为项目 Plugins/iXenaUnrealBridge 或引擎 Engine/Plugins/iXena/iXenaUnrealBridge。' 'Build succeeded. Copy the complete output folder to project Plugins/iXenaUnrealBridge or engine Engine/Plugins/iXena/iXenaUnrealBridge.'
say '先关闭 UE 再替换插件；随后在 Plugins → iXena 中启用并重启编辑器。此脚本没有自动安装。' 'Close UE before replacing the plugin; enable it under Plugins → iXena and restart the Editor. This script did not install it.'
