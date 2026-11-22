# Changelog

## 0.6.2

- UE5.9 编译修复：JSON 键在新版引擎中为 `TSharedString<TCHAR>`，不能直接调用 `ToLower()`；两处均先转成 `FString(*Pair.Key)`。已由用户在 UE5.9 实机确认该修改可编译。
- 保持原生菜单、语言资源、通信协议和手动插件编译流程不变。VSCode 的一秒自动重连与不阻塞构建状态为客户端更新，现有 0.6.1 已编译插件兼容。

## 0.6.1

- 避免重复顶部菜单，将通讯工具挂接到 QtQuickUI 的 `MainFrame.MainMenu.iXena`，另提供 Window/toolbar 入口。
- 加入中英文命令帮助词库，保留 UE 原文；UE 界面切换语言时即时更新命令说明。
- 扩展控制台查询可选 `locale` 参数，支持按中文概述检索，不改变命令名称或执行内容。
- 资源文件必须与 DLL 一起发布；没有 UE C++ 实际编译验证。


## 0.6.0

- Replaced VSCode-hosted automatic installation with standalone native build scripts and manual placement instructions.
- Added Auto / Simplified Chinese / English for the native UE tools panel and bridge-generated messages, without changing UE global language.
- Grouped the plugin under the iXena category; retained the iXena toolbar and menu.
- Fixed UE5.9 C4459 caused by a constructor parameter shadowing the global LogPath category; renamed it to InCompileLogPath.
- Kept internal plugin/module identity iXenaUnrealBridge and file protocol 1.
- Added Chinese/English documentation using the neutral UE5Test example project.
- Licensed under MIT, copyright 2026 黄小宇.
