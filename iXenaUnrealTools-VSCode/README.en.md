# iXenaUnrealTools 0.6.2

## 0.6.2: reconnect and completion status

The extension automatically checks the Editor connection every second and confirms connected endpoints every five seconds. Live Coding completion immediately releases the busy indicator; notifications do not block the build flow. The latest result remains visible in the Build & Live Coding group. Background probes never compile.

[简体中文](README.md) · **Author: 黄小宇** · **MIT** · VSCode 1.96+

Unreal Engine C++ workspace tools for existing build/debug tasks, engine selection, UHT, source panes, module dependencies, descriptor editing and communication with a running UE Editor.

**Version 0.6.1 uses manual UE plugin installation.** The VSIX provides an **Initialize Engine Plugin** entry and communication clients. It no longer bundles UE source, downloads binaries, runs a plugin installer or starts a plugin build automatically. UE source and standalone build scripts live in the sibling component.

| Location | Contents |
| --- | --- |
| [w2zArd/iXenaUnrealTools](https://github.com/w2zArd/iXenaUnrealTools) | Repository |
| `iXenaUnrealTools-VSCode` | VSCode extension |
| `iXenaUnrealTools-UnrealPlugin/iXenaUnrealBridge` | UE plugin source |
| `iXenaUnrealTools-UnrealPlugin/Tools` | Manual build scripts |

## Install the VSCode extension

Choose **Install from VSIX** in VSCode's Extensions view, install `ixena-unreal-tools-0.6.2.vsix`, then reload the window.

The publisher is `ixena-unreal-tools`; the new extension ID is **`ixena-unreal-tools.ixena-unreal-tools`**. The earlier local ID was `ixena-local.ixena-unreal-tools`, so installing this package does not replace it under the same ID. Disable or uninstall the old extension to avoid duplicate commands and buttons. If the old version registered Windows Explorer menus, remove those menus with the old extension before registering the new ones.

The [publisher management page](https://marketplace.visualstudio.com/manage/publishers/ixena-unreal-tools) is for uploading and managing extensions, not a public listing. The [planned public listing](https://marketplace.visualstudio.com/items?itemName=ixena-unreal-tools.ixena-unreal-tools) follows the current publisher/name; its publication has not been verified. This delivery does not push the repository or publish a Marketplace/GitHub release.

## Initialize a connection

Open **iXena Unreal → Editor Communication → Connection & setup → Initialize engine plugin…**. The same action is available from Quick Actions and the Command Palette.

| Mode | What initialization does | Required preparation |
| --- | --- | --- |
| iXena plugin | Saves the mode and opens the GitHub repository | Download source or a matching build, copy it manually, compile, enable and restart UE |
| Epic Unreal MCP | Prompts for IP, port and endpoint path, then saves a validated client address | Enable the official Unreal MCP service; compilation also requires its Live Coding toolset |

Initialization does not edit `.uproject`, start UAT or create a plugin directory. After preparing UE, select the intended project/engine and use **Check connection / plugin status**.

### Plugin mode

Download the entire `iXenaUnrealTools-UnrealPlugin/iXenaUnrealBridge` folder, including its `.uplugin` and Source. Save and close UE before placing it in one of these locations. Avoid loading duplicate copies in the same project/engine.

| Scope | Example |
| --- | --- |
| Project | `D:\Develop\UnrealEngine\UE5Test\Plugins\iXenaUnrealBridge` |
| Engine | `D:\Engines\UE_5.9\Engine\Plugins\iXena\iXenaUnrealBridge` |

Build Development Editor with that engine's C++ toolchain. Enable **iXena Unreal Bridge** under **UE Plugins → iXena**, then restart as required. Alternatively, build a package with the scripts below and copy the complete output. Keep the descriptor, module manifests and required build metadata together with the native library.

Run these examples from `iXenaUnrealTools-UnrealPlugin`. Create the output parent directory first. The package directory must be absent or empty, outside the engine and plugin source.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Tools\Build-Plugin.ps1 `
  -EngineRoot "D:\Engines\UE_5.9" `
  -Package "D:\Builds\iXenaUnrealBridge-UE5.9" `
  -Language en
```

```bash
bash ./Tools/Build-Plugin.sh \
  --engine "/opt/UnrealEngine/UE_5.9" \
  --package "/tmp/iXenaUnrealBridge-UE5.9" \
  --language en
```

These scripts stream the selected host engine's UAT/UBT output, propagate its exit code and inspect the result. They **build only; they do not install**. PDB/dSYM symbols are removed by default; use `-KeepSymbols` / `--keep-symbols` to retain them. The Windows script rejects CMD metacharacters in paths. Rebuild for a different engine, operating system or architecture.

### MCP mode

Defaults are `127.0.0.1`, `8000` and `/mcp`, producing `http://127.0.0.1:8000/mcp`. The wizard accepts explicit IPv4, IPv6 or localhost. Cancelling input preserves the previous settings.

The address configures the client only; it does not change UE's listener. The official service defaults to local use. Entering another IP does not automatically enable cross-machine operation: the service must be reachable and must report the exact selected project/engine identity. This version does not map remote paths to local paths. Third-party similarly named MCP plugins may expose different tools and metadata.

Console commands and performance monitoring use a loaded iXena Bridge independently of the chosen Live Coding transport, so they can still be used when MCP is selected for compilation.

## Organized panels and languages

Connection status stays at the top. Actions are grouped in four collapsible sections:

| Group | Actions |
| --- | --- |
| Connection & setup | Initialization, project/engine selection, connection mode and checks; MCP endpoint when selected |
| Build & Live Coding | Live Coding and native Editor full build |
| Runtime & debugging | CPU/memory monitor, Unreal Insights and UE commands/CVars |
| Logs & help | Live output, last Live Coding log and repository instructions |

Simplified Chinese and English are supported. Dynamic UI follows VSCode by default; choose **Interface Language**, or set `iXenaUnrealTools.language` to `auto`, `zh-CN` or `en`. Status bars, sidebars and dynamic panels update; Webviews retain uncommitted edits and performance history.

**Command Palette entries, context menus and static view titles follow VSCode's display language.** The manual extension setting controls dynamic UI only. Follow VSCode's restart instructions when changing its display language. The native UE floating panel has its own Auto / English / 简体中文 selector; Auto follows the UE UI culture.

Source code, technical identifiers, engine-produced logs and user names are preserved. Generated C++ header comments remain Chinese by design.

## Main features

| Feature | Behavior |
| --- | --- |
| Build / Stop / Debug | Uses existing `.code-workspace`, tasks and launch settings. Debugging uses a matching launch. Complex tasks can run through the original VSCode task picker |
| Build terminal | Tries to reuse a terminal per project. Ordinary task cancellation first uses Ctrl+C, then falls back to task termination if needed; UBT logs are archived when available |
| Multiple engines | Discovers engines from tasks/settings. Toolchain switching does not change EngineAssociation; regenerate launch settings if executable paths no longer match |
| UHT / IntelliSense | Refresh UHT independently and request a language-server rescan. Engines without the standalone mode need their normal build workflow |
| Source panes | Choose a project/plugin scope and browse Public, Private and other folders. Existing `multiExplorer.panes` is supported; absent pane settings hide this view |
| Header/source switch | Context actions match filenames and module paths; multiple candidates require selection |
| C++ class wizard | 20 built-in parent templates and custom parents, module/name/visibility/subdirectory selection and preview; existing files are not overwritten |
| Build.cs dependencies | Visual editing of recognized static Public/Private dependencies; complex conditional C# remains a manual edit |
| Descriptors | Visual `.uproject/.uplugin` editing preserves unknown fields and updates the document buffer; saving remains explicit |
| UE console | Searches registered commands/CVars, shows help/current values and previews the command and target before sending |
| CPU/memory | Samples the selected UE Editor process, retaining up to 120 samples; breakpoints or stalls preserve the last reading and mark it stale |
| Unreal Insights | Opens the instance's engine tool without automatically starting Trace recording |
| Windows Explorer | Explicitly register/remove current-user `.uproject/.uplugin` menus; Windows 11 uses Show more options |

The class wizard previews required module dependencies; use the Build.cs editor to add them. New reflected classes, module changes and Build.cs/Target.cs changes generally require a full build and an editor restart as appropriate.

After enabling the UE plugin, use **UE top menu iXena → Open Tools Panel** for a movable native window with status, commands and current performance values.

## Compilation, output and platform boundaries

Windows smart builds request Live Coding only after matching the Editor to the selected project/engine. The existing UBT task is used when no matching Editor is confirmed. Connection failure, compilation failure or an uncertain result does not trigger another UBT build. Protocol 1 explicitly accepts Bridge 0.5.0, 0.6.0 and 0.6.1.

Plugin Live Coding output consists of actual captured UE GLog messages; the separate Live Coding Console **does not necessarily forward every compiler line**. MCP progress depends on server notifications. Recognized absolute file diagnostics enter a dedicated Problems collection. A timeout does not cancel UE compilation, and this version has no reliable Live Coding cancellation command.

macOS/Linux have plugin source, manual build scripts, console/performance interfaces and a native full-build entry. Live Coding reports unavailable on these platforms in this version. Existing Windows task adaptation and Explorer integration do not imply all legacy features are cross-platform.

This delivery environment has no real UE C++ toolchain or Windows/macOS GUI validation, and no full build matrix across older UE5 versions. The `FCompileOutput` constructor parameter is now `InCompileLogPath` to address the reported shadowing/C4459 issue; static correction does not replace a target-engine build. See [VALIDATION.md](VALIDATION.md) for validation boundaries.

## Workspace example

Merge the relevant entries into an existing workspace; retain UE-generated tasks and launch configurations.

```jsonc
{
  "folders": [
    { "name": "UE5Test", "path": "D:\\Develop\\UnrealEngine\\UE5Test" }
  ],
  "settings": {
    "iXenaUnrealTools.language": "auto",
    "iXenaUnrealTools.engineRoots": ["D:\\Engines\\UE_5.9"],
    "iXenaUnrealTools.performance.autoStartDebug": true,
    "iXenaUnrealTools.explorer.panes": [
      { "label": "Public", "roots": ["${workspaceFolder:UE5Test}/Source/UE5Test/Public"] },
      { "label": "Private", "roots": ["${workspaceFolder:UE5Test}/Source/UE5Test/Private"] }
    ]
  }
}
```

## Development and license

From `iXenaUnrealTools-VSCode`:

```bash
npm ci
npm test
npm --prefix test/ui ci
npm run test:ui
npm run package
```

`npm run test:host` additionally requires a working desktop/display service. Development dependencies are excluded from the VSIX.

Licensed under the [MIT License](LICENSE), copyright 黄小宇. Preserve copyright and permission notices in distributed copies. Unreal Engine and other dependencies retain their respective licenses.

### 0.6.1: bilingual console help, connection and menu fixes

Chinese mode adds curated meanings for common CVars while retaining the untouched native UE help, including all parameters. English mode uses the original help. Unknown entries are not machine-translated. Chinese keyword search requires the matching 0.6.1 bridge. Connection checks are not blocked by ongoing UBT tasks and report stale or mismatched bridge files. The bridge extends QtQuickUI’s existing iXena submenu and also provides Window/toolbar access. Restart UE after replacing the native module.
