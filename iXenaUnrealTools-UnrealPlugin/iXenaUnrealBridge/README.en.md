# iXena Unreal Bridge 0.6.2

## 0.6.2 update

Both JSON help-key conversions use `FString(*Pair.Key).ToLower()` for UE5.9. The user confirmed this compiles. Protocol 1 is unchanged; the VSCode auto-reconnect needs no UE-side feature change.

Author: **黄小宇** · [MIT License](LICENSE) · [简体中文](README.md)

Copy this complete folder to a project's `Plugins/iXenaUnrealBridge` or an engine's `Engine/Plugins/iXena/iXenaUnrealBridge`, using one location only. Save and close UE before replacing a plugin. Enable **iXena Unreal Bridge** under **Plugins → iXena**, build with the matching Development Editor toolchain, then reopen the project.

The repository's sibling `Tools` folder contains native PowerShell/Bash build scripts. They call the selected engine's UAT with live output, create a package, and do not install or modify `.uproject`. See the component README in [the repository](https://github.com/w2zArd/iXenaUnrealTools) for complete instructions.

Open **iXena → Open tools panel** in UE. The floating window has command/CVar search, help and current values, command execution, current Editor CPU/memory/frame metrics and supported Windows Live Coding. VSCode can communicate through the same local file protocol without an MCP service.

The language selector offers **Auto / 简体中文 / English**. Auto follows UE's display language (`zh*` selects Simplified Chinese, otherwise English). The preference belongs to this plugin's per-project Editor user settings; it never changes UE's global culture. Dynamic labels update without clearing input or prior results. Engine-generated logs and help remain unchanged.

Only UE `Success`/`NoChanges` responses mean compilation succeeded. A timeout does not cancel UE or justify retrying. Captured GLog output may not include every line from the separate Live Coding Console. macOS/Linux communication and UI source are provided, while Live Coding returns `NotAvailable` on those platforms. Metrics are Editor-process statistics, not a full profiler; sampling can pause at breakpoints or during synchronous compilation.

0.6.1 fixes the UE5.9 C4459 parameter collision with the global `LogPath` category by renaming the argument to `InCompileLogPath`. No warnings were disabled. This package contains source, not verified native binaries; real compilation and UI validation are still required in the target engine.

Protocol field names and status values remain stable at version 1; see [PROTOCOL.md](PROTOCOL.md).

### 0.6.1 menu and locale details

The bridge no longer creates a second top-level iXena menu. It extends `MainFrame.MainMenu.iXena` (QtQuickUI), and provides Window menu and toolbar fallbacks. The Chinese glossary in `Resources/ConsoleHelp.zh-CN.json` must be copied with the packaged plugin. UE original help and flags stay unchanged. Rebuild/restart the Editor to replace a loaded native module.
