# iXenaUnrealTools · Unreal Plugin 0.6.2

## 0.6.2: UE5.9 compiler compatibility

`iXenaBridgeConsoleHelp.cpp` converts both JSON object keys with `FString(*Pair.Key).ToLower()` to support `TSharedString<TCHAR>` in UE5.9. The user verified that correction compiles. 0.6.1 binaries remain wire-protocol compatible with the updated VSCode client.

[简体中文](README.md) · Author: **黄小宇** · **MIT License**

This directory contains the UE Editor bridge for [iXenaUnrealTools](https://github.com/w2zArd/iXenaUnrealTools). The VSCode **Initialize engine plugin** action selects a transport and opens the repository. Users download, place and compile the UE plugin themselves. Building this component does not require Node, a VSCode process or an MCP service.

## Layout and identity

| Path | Purpose |
| --- | --- |
| `iXenaUnrealBridge/` | Actual UE plugin directory to copy into `Plugins` |
| `iXenaUnrealBridge/iXenaUnrealBridge.uplugin` | Descriptor, categorized under **iXena** |
| `iXenaUnrealBridge/Source/` | C++ source; the internal module remains `iXenaUnrealBridge` |
| `Tools/Build-Plugin.ps1` | Native Windows build entry point |
| `Tools/Build-Plugin.sh` | Native macOS/Linux build entry point |
| `Tests/test_manual_build.py` | Regression tests using a fake UAT process |

`iXenaUnrealTools-UnrealPlugin` is a repository/distribution folder, not a module name. Copy its inner **iXenaUnrealBridge** directory, or the complete built package.

## Option 1: install source and build with a project

1. Save your work and close UE Editor.
2. Download the repository ZIP or clone it.
3. Copy `iXenaUnrealBridge` into one location:

   - Project: `D:\Develop\UnrealEngine\UE5Test\Plugins\iXenaUnrealBridge`.
   - Engine: `<UE_ROOT>\Engine\Plugins\iXena\iXenaUnrealBridge`.

4. Enable **iXena Unreal Bridge** under **Plugins → iXena** and reopen the Editor when requested. Build the project's **Development Editor** target with that engine's C++ toolchain when binaries are needed.
5. If the project cannot build source plugins at startup, use the standalone `Tools` scripts below first.
6. Check the connection in VSCode and verify project, engine and PID. In UE, open **iXena → Open tools panel**.

Keep only one copy of the same plugin across the project and engine. The plugin is disabled by default. Copying it does not edit `.uproject`; enable it in the Editor or update the matching entry in the project's `Plugins` array to `{"Name":"iXenaUnrealBridge","Enabled":true}`, preserving other entries.

## Option 2: build a package, then copy it

These scripts invoke the selected engine's **RunUAT → BuildPlugin** with inherited live output. They do not install, edit projects, download binaries or cross-compile. The output must be outside the engine and source directories, must not exist or must be empty, and its parent must already exist.

### Windows

From this directory:

```powershell
New-Item -ItemType Directory -Force "D:\Builds" | Out-Null

powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Tools\Build-Plugin.ps1 `
    -EngineRoot "D:\Engines\UE_5.9" `
    -Package "D:\Builds\iXenaUnrealBridge-UE5Test-0.6.2"
```

Optional: `-Language zh-CN` / `-Language en`, or `-KeepSymbols`. Auto follows PowerShell's UI culture. Normal paths containing spaces or Chinese characters are supported; Windows batch paths containing CMD metacharacters such as `%`, `!`, `&` or quotes are rejected explicitly. The script uses UTF-8 with BOM for Windows PowerShell 5.1.

### macOS/Linux

```bash
mkdir -p /tmp/ixena-builds

bash ./Tools/Build-Plugin.sh \
    --engine "/absolute/path/to/UE_5.x" \
    --package "/tmp/ixena-builds/iXenaUnrealBridge-0.6.2"
```

Optional: `--language zh-CN` / `--language en`, or `--keep-symbols`. Auto follows the shell locale. The native host selects `Mac` or `Linux`; the selected engine/toolchain determines supported architectures.

### After building

Success requires a zero UAT exit code plus the descriptor, a native module library and `.modules` manifest in the package. Nonzero exit codes are retained. Existing nonempty output folders are rejected rather than emptied.

Close UE and copy the **complete output folder** to the project or engine as `iXenaUnrealBridge`; enable it and reopen the project. Debugging symbols are removed by default, while the other required UAT output is kept. This is an optimized Development Editor module, not a Shipping game module. A bare DLL is not a complete UE plugin.

Windows builds DLLs, macOS dylibs and Linux shared objects. A different engine, BuildId, host platform or architecture requires a matching local build.

## Languages

The native panel has **Auto (follow UE) / 简体中文 / English** options.

- Auto reads UE's current language: `zh*` uses Simplified Chinese; other languages fall back to English.
- A manual override affects this plugin only, not UE's global language or VSCode.
- The preference is stored in the current project's Editor user settings.
- Menus, window labels, buttons, help, status and bridge-generated messages use the selected language. Changing it preserves command input and past output.
- Engine-provided help, CVar names, source identifiers and original compiler logs remain unchanged. Past output is not retroactively translated.

## Features and limits

The native floating window provides searchable registered commands/CVars, current values and help, explicit single-command execution, Editor CPU/memory/frame statistics, debugger state and supported Windows Live Coding. Menu and toolbar actions reuse the same window.

File IPC keeps protocol 1 and existing field identities. The bridge opens no TCP listener and requires no MCP toggle. macOS/Linux include source support for communication, commands and UI; Live Coding reports `NotAvailable` there, and a full build requires closing the Editor.

Metrics cover the current **Editor process**. A breakpoint or synchronous compile can suspend sampling. Clients should retain the last sample and mark it stale; frame interval is not CPU/GPU function duration. Use Unreal Insights for deeper analysis.

Live Coding output includes only the GLog messages actually received by the bridge. The separate Live Coding Console may not forward all UBT lines. A client timeout does not cancel UE compilation and must not trigger an automatic retry.

## Fixes and validation

0.6.1 fixes the reported UE5.9 **C4459**: the `FCompileOutput` argument `LogPath` shadowed an engine log category. It is now `InCompileLogPath`; warnings remain enabled.

Eight standard-library Python tests cover fake-UAT success, symbol preservation, failure exit codes, missing output, existing-file preservation, output boundaries/symlinks, the C4459 regression and plugin category/language scope:

```bash
python3 -m unittest discover -s Tests -v
```

**The test UAT is simulated. The delivery environment has no UE, Windows PowerShell or macOS Xcode; actual C++ compilation, Windows script execution and native UI behavior remain unverified.** Older UE5 versions use public APIs and capability checks but still require a real first build. Keep the first C++ error and engine version when reporting a failure.

## Protocol and license

See the [file protocol](iXenaUnrealBridge/PROTOCOL.md) and [MIT License](LICENSE). Copyright attribution is **黄小宇**; retain the copyright and license when distributing. Unreal Engine itself remains subject to Epic's license.

### 0.6.1: bilingual console help, connection and menu fixes

Chinese mode adds curated meanings for common CVars while retaining the untouched native UE help, including all parameters. English mode uses the original help. Unknown entries are not machine-translated. Chinese keyword search requires the matching 0.6.1 bridge. Connection checks are not blocked by ongoing UBT tasks and report stale or mismatched bridge files. The bridge extends QtQuickUI’s existing iXena submenu and also provides Window/toolbar access. Restart UE after replacing the native module.
