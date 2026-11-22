# Changelog

## 0.6.2

- 修复 Live Coding 收到 UE 最终成功/失败结果后仍显示“构建中”：通知仅用于展示，不等待用户关闭；完整 UBT、初始化消息也不阻塞互斥锁。
- UE 插件通讯与 Epic MCP 均增加无弹窗自动重连：每秒检查一次状态，成功后每 5 秒确认一次心跳；重启 UE 后自动发现新的实例。
- 前台命令等待已开始的后台只读 ping 完成，避免请求占用冲突；自动探测绝不触发编译，也不会覆盖正在进行的操作状态。
- 在“编译与热更新”分组保留上次编译结果，编译日志仍然保存；协议 1 继续兼容 Bridge 0.5.0、0.6.0、0.6.1。
- 修复 UE5.9 JSON 对象键 `TSharedString<TCHAR>` 的 `ToLower()` 类型错误；使用 `FString(*Pair.Key).ToLower()`，此修复已在目标 Windows 环境由使用者确认编译通过。
- 自动化测试增加通知不关闭、UE 重启和自动重连、并发请求避免碰撞等场景；原生 UE5 编译仍需本机回归。

## 0.6.1

- 统一 UE 顶部 iXena：桥接插件复用 QtQuickUI 菜单，不再在 LevelEditor.MainMenu 注册第二个顶级入口；Window/工具栏保留备用入口。
- 修复连接检查受后台 UBT busy 状态阻断，失败后不再停留在“连接中”；提供实例失效与路径/版本诊断。
- 中英文 CVar/命令帮助：常见项中文概要、分类词汇检索，原始 UE 帮助完整保留；英文显示原文。
- 协议 1 继续兼容 0.5.0/0.6.0/0.6.1，中文检索功能需要 0.6.1 UE 插件。


## 0.6.0

### 初始化与仓库拆分 / Setup and component separation

- 用“初始化引擎插件”统一入口选择 iXena 插件或 Epic Unreal MCP。
- 插件方式打开 `https://github.com/w2zArd/iXenaUnrealTools`，由用户下载、放置、编译、启用和重启 UE；取消 VSIX 内的自动下载、插件构建和安装流程。
- MCP 方式提供 IP、端口和路径输入，取消时保留旧设置；项目/引擎身份检查继续严格执行。
- 仓库分为 `iXenaUnrealTools-VSCode` 和 `iXenaUnrealTools-UnrealPlugin`；独立 UE 构建入口位于后者的 Tools 中，只生成可手动复制的包。
- Initialization selects the plugin or MCP transport. The plugin flow opens the repository for manual installation; VSIX no longer bundles or automatically builds the UE plugin.

### 分类与多语言 / Organization and localization

- 通讯面板按“连接与初始化、编译与热更新、运行与调试、日志与帮助”分类。
- 加入简体中文与英文；动态 UI 支持自动跟随或手动切换，静态命令/菜单跟随 VSCode 显示语言。
- Webview 语言切换保留编辑草稿和性能历史；UE 原生面板拥有独立语言选择。
- 生成 C++ 头文件注释继续保持中文；用户命名、技术标识符和引擎输出保持原样。
- Grouped communication tools and Chinese/English interfaces, with preserved Webview drafts/history and independent UE panel language selection.

### 兼容与发布准备 / Compatibility and publishing preparation

- 协议 1 明确兼容 Bridge 0.5.0 与 0.6.0，同时保留实例、项目、引擎与请求校验。
- UE `FCompileOutput` 构造参数改为 `InCompileLogPath`，消除对应的遮蔽/C4459 问题；实际 UE 编译仍需目标引擎验收。
- 发布者更新为 `ixena-unreal-tools`，扩展 ID 更新为 `ixena-unreal-tools.ixena-unreal-tools`。需停用旧 `ixena-local` 扩展；系统菜单应先移除旧注册再重建。
- 文档统一使用 UE5Test 示例路径；补充英文说明、发布者管理页与预期公开地址的区别。
- 统一 MIT 许可，版权署名黄小宇。没有自动推送仓库或发布 Release。
- Explicit protocol compatibility, corrected native parameter shadowing, a new publisher ID and sanitized bilingual documentation. No marketplace publication is implied.

## 0.5.0

- 引入 UE Editor 通讯、可选 MCP、原生浮动面板、命令/CVar 查询、类向导与性能监测。
- 当时提供的自动构建/安装流程已在 0.6.0 移除；使用当前 README 中的手动流程。
- Introduced editor communication, optional MCP, the native panel, console queries, class creation and performance monitoring. Its automatic installer was retired in 0.6.0.

## 0.4.x 及更早 / Earlier releases

- 逐步加入已有任务构建/调试、终端复用、引擎切换、UHT、资源分栏、描述文件与模块依赖编辑、源文件配对及 Windows 系统菜单。
- Older releases introduced existing-task builds/debugging, terminal reuse, engine selection, UHT, source panes, descriptor/dependency editing, header/source switching and Windows Explorer menus.

验证方法与未完成的实机检查见 [VALIDATION.md](VALIDATION.md)。
