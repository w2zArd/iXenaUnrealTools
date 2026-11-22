# iXenaUnrealTools

## 0.6.2: reconnect and build-state fix

VSCode silently probes the connection every second and discovers a restarted Editor. Successful or failed Live Coding responses release build-busy state without waiting for a notification to be dismissed. UE5.9 JSON string keys are converted using `FString(*Pair.Key).ToLower()`. Existing 0.6.1 native binaries remain protocol-compatible.

**English** · [简体中文](README.md)

A VSCode toolbox and Editor communication plugin for Unreal Engine 5. Author: **黄小宇**. License: **MIT**. Source release: **0.6.2**.

## Components

| Directory | Purpose |
| --- | --- |
| [iXenaUnrealTools-VSCode](iXenaUnrealTools-VSCode/README.en.md) | Build/stop/debug tasks, engine selection, UHT, class creation, project editors, connections, console commands, and performance monitoring |
| [iXenaUnrealTools-UnrealPlugin](iXenaUnrealTools-UnrealPlugin/README.en.md) | UE Editor plugin source, standalone Tools build scripts, and local validation instructions |

The repository component names may contain hyphens. The actual UE plugin is `iXenaUnrealTools-UnrealPlugin/iXenaUnrealBridge`; its descriptor and C++ module remain named `iXenaUnrealBridge`. Its Plugins browser category is **iXena**.

## Getting started

1. Install `ixena-unreal-tools-0.6.2.vsix` and reload VSCode.
2. Open your UE workspace. In **Editor Connection & Tools → Connection & setup**, select **Initialize engine plugin**.
3. Choose the connection:
   - **iXena Unreal Plugin** opens this repository. Download the UE component. Put `iXenaUnrealBridge` under project `Plugins` or engine `Engine/Plugins/iXena`, build it with the chosen engine, enable it, and restart Editor. The component's Tools scripts can create an installable package.
   - **Epic Unreal MCP** asks for the IP address, port, and path, defaulting to `127.0.0.1`, `8000`, `/mcp`. Enable official Unreal MCP and the required toolsets in UE, then check the connection.
4. Select the actual project and engine and run **Check connection / plugin status**.

Initialization does not download files, launch UAT, copy plugins, or edit a project descriptor. Existing project-build and explicit Live Coding commands remain available.

Example paths throughout the documentation are public examples:

- Project: `D:\Develop\UnrealEngine\UE5Test\UE5Test.uproject`
- Project plugin: `D:\Develop\UnrealEngine\UE5Test\Plugins\iXenaUnrealBridge`
- Engine plugin: `D:\Engines\UE_5.9\Engine\Plugins\iXena\iXenaUnrealBridge`

Use one installation location. Retain the descriptor, module manifests, and other required build output; copying only the DLL is insufficient.

## Grouped tools

| Group | Contents |
| --- | --- |
| Connection & setup | Initialization, target selection, connection mode/endpoint, status |
| Build & Live Coding | Live Coding and native Editor full builds |
| Runtime & debugging | CPU/memory monitor, Unreal Insights, console commands/CVars |
| Logs & help | Live output, last Live Coding log, repository/manual installation |

Only the connection group is expanded by default. Stable group IDs preserve identity across language changes. The native UE floating window is available under **iXena → Open Tools Panel**.

## Languages

VSCode runtime UI supports `auto`, `zh-CN`, and `en`. Auto uses Simplified Chinese for Chinese VSCode locales and English otherwise. Use **Switch Interface Language** or `iXenaUnrealTools.language` for dynamic UI.

Static command/context-menu titles, view names, and settings descriptions use `package.nls*.json` and follow the VSCode **display language**. Use Configure Display Language and reload to change them. Open webviews update their language without replacing unsaved drafts or monitoring history.

The UE window has its own Auto / 简体中文 / English selector. Auto follows UE's current language without modifying the Editor's global setting. Identifiers, paths, user content, and original engine logs are not translated. Generated C++ header comments remain Chinese.

## Upgrading from 0.5.0

The publisher is now `ixena-unreal-tools`, making the extension ID `ixena-unreal-tools.ixena-unreal-tools`. The previous local extension used `ixena-local.ixena-unreal-tools`. Stop old tasks and disable/uninstall the old extension before installing this release to avoid duplicate commands.

If the old version registered Windows Explorer menus, remove those with the old extension before registering the new menus. Stored per-extension workspace state is not automatically migrated; reselect your configuration and engine.

Bridge protocol 1 explicitly supports plugin versions 0.5.0, 0.6.0 and 0.6.1. Rebuild the 0.6.1 plugin for the new native language selector and the C4459 parameter-shadowing fix. Restart UE after replacing a loaded module.

## Publishing

- [Repository](https://github.com/w2zArd/iXenaUnrealTools)
- [Releases](https://github.com/w2zArd/iXenaUnrealTools/releases): assets are uploaded by the maintainer.
- Planned [public Marketplace page](https://marketplace.visualstudio.com/items?itemName=ixena-unreal-tools.ixena-unreal-tools): available only after publication; this source bundle does not assert a live listing.
- [Publisher management](https://marketplace.visualstudio.com/manage/publishers/ixena-unreal-tools): maintainer sign-in page, not the user installation URL.

Keep the two component directories at the repository root; an additional UnrealPlugins directory is unnecessary. GitHub directory URLs use `tree/<branch>/<directory>`. Documentation uses relative links and initialization opens the repository root, avoiding assumptions about the default branch.

## Building and validation

In the VSCode component: `npm ci`, `npm test`, `npm --prefix test/ui ci`, `npm run test:ui`, then `npm run package`.

In the UE component: follow its README for `Tools/Build-Plugin.ps1` or `Tools/Build-Plugin.sh`. They call the chosen engine's RunUAT BuildPlugin directly with inherited output and need no Node runtime. Each platform requires its own supported UE C++ toolchain.

TypeScript, protocol simulation, DOM interaction, and manual script tests are provided. Actual UE C++ compilation, Windows PowerShell execution, and native Slate runtime validation were unavailable in the delivery environment. Follow each component's validation guide on the target machine.

Live Coding depends on engine and platform capabilities; the Bridge does not expose it on macOS/Linux. Official Unreal MCP listens locally by default. Configuring a client IP does not change the UE listener, and project/engine identity checks still apply.

## License

MIT — Copyright (c) 2026 黄小宇. See [LICENSE](LICENSE). Third-party dependencies retain their own licenses.
