# iXenaUnrealTools

## 0.6.2：连接和热更新状态修复

VSCode 每秒静默检查通信状态，UE 重启后自动寻找并验证新实例；收到 Live Coding 最终响应后立即释放构建状态，弹出的通知不需要手动关闭。UE5.9 JSON 键类型修正为 `FString(*Pair.Key).ToLower()`。已有 0.6.1 UE DLL 可继续配合新版 VSIX 使用；原生修复需在 Windows 重新编译。

[English](README.en.md) · **简体中文**

面向 Unreal Engine 5 的 VSCode 工具箱与 UE Editor 通讯插件。作者：**黄小宇**。许可证：**MIT**。

本仓库版本：**0.6.2**。两个组件分别维护源码；VSCode 扩展通过初始化向导配置连接，UE 插件由使用者下载、放置和本机构建。

## 仓库结构

| 目录 | 内容 |
| --- | --- |
| [iXenaUnrealTools-VSCode](iXenaUnrealTools-VSCode/README.md) | VSCode 扩展：任务构建/停止/调试、多引擎、UHT、类向导、模块/描述文件编辑、通讯、命令与性能监测 |
| [iXenaUnrealTools-UnrealPlugin](iXenaUnrealTools-UnrealPlugin/README.md) | UE Editor 插件源码、独立 Tools 构建脚本和本机验收步骤 |

`iXenaUnrealTools-VSCode` / `iXenaUnrealTools-UnrealPlugin` 是仓库组件目录，可以使用连字符。真正的 UE 插件位于 `iXenaUnrealTools-UnrealPlugin/iXenaUnrealBridge`；描述文件和 C++ 模块继续使用 `iXenaUnrealBridge`，不需要按仓库目录重命名。插件浏览器的 Category 为 **iXena**。

## 快速开始

1. 安装配套 `ixena-unreal-tools-0.6.2.vsix`，重新加载 VSCode。
2. 打开 UE 项目的工作区，在 iXena 侧栏的 **编辑器连接与工具 → 连接与初始化** 点击 **初始化引擎插件**。
3. 选择连接方式：
   - **iXena Unreal Plugin**：打开本仓库。下载 UE 组件，将其中 `iXenaUnrealBridge` 放到项目 `Plugins`，或引擎 `Engine/Plugins/iXena`。自行构建，或运行 UE 组件的 `Tools` 脚本生成可安装包；启用后重新打开 Editor。
   - **Epic Unreal MCP**：依次输入 IP、端口、路径，默认 `127.0.0.1`、`8000`、`/mcp`。配置保存后，在 UE 中启用官方 Unreal MCP 与所需工具集，再检查连接。
4. 在 **项目 / 引擎** 选定实际目标，点击 **检查连接 / 插件状态**。
5. 按需要展开编译、运行/调试和日志分组。

初始化不会自动下载、运行 UAT、复制插件或编辑 `.uproject`。检测到插件文件也不代表 Editor 已加载它。普通项目构建和明确点击的 Live Coding 功能仍按原有命令执行。

### 安装路径示例

文档仅使用示例项目：

- 项目：`D:\Develop\UnrealEngine\UE5Test\UE5Test.uproject`
- 项目插件：`D:\Develop\UnrealEngine\UE5Test\Plugins\iXenaUnrealBridge`
- 引擎：`D:\Engines\UE_5.9`
- 引擎插件：`D:\Engines\UE_5.9\Engine\Plugins\iXena\iXenaUnrealBridge`

选择项目或引擎其中一个位置，避免同名插件重复。脚本产物包括 UE 必需的描述文件和模块清单，不能只复制 DLL。

## 界面分组

| 分组 | 操作 |
| --- | --- |
| 连接与初始化 | 初始化引擎插件、选择项目/引擎、查看方式与 MCP 地址、检查连接 |
| 编译与热更新 | Live Coding、本机 Editor 完整编译 |
| 运行与调试 | CPU/内存监测、Unreal Insights、UE 命令/CVar |
| 日志与帮助 | 实时输出、上次热更新日志、仓库/手动安装说明 |

连接组默认展开，其余组可按需展开；分组 ID 稳定，语言切换不改变分组身份。UE 顶部 **iXena → 打开工具面板** 提供独立原生浮动窗口。

## 0.6.1：菜单、连接与中英文命令帮助

- 当项目同时使用 QtQuickUI 和桥接插件时，只由 QtQuickUI 注册顶部 `iXena`。桥接插件扩展 `MainFrame.MainMenu.iXena`；若该菜单未注册，也可在 **窗口（Window）** 菜单和关卡工具栏打开桥接面板。需要关闭并重开 UE 以加载新版 DLL。
- VSCode 的“检查连接”允许与普通 UBT 构建任务并行执行，不再把后台任务占用当作握手失败。现在会报告旧心跳、工程／引擎身份不匹配及不支持的桥接版本；只有收到 UE `ping` 响应才显示“已连接”。
- 控制台的中文帮助词库保存在两个组件各自的 `resources/ConsoleHelp.zh-CN.json` / `Resources/ConsoleHelp.zh-CN.json`。常见命令提供中文概要，其他项按功能前缀给出中文类别，始终保留 UE 原始帮助的英文参数说明；英文界面只显示原文，避免误译特殊 CVar。
- UE 浮动面板和 VSCode 命令搜索支持中文概要词汇查询，但需要新版桥接插件（0.6.1）才能从 UE 端按中文帮助搜索完整注册命令目录。

## 多语言

- VSCode 动态界面支持 **auto / 简体中文 / English**。Auto 跟随 VSCode；中文区域使用简体中文，其他区域回退英文。
- 命令面板、右键菜单、设置描述和视图标题使用 `package.nls*.json`，跟随 **VSCode 显示语言**。通过 `Configure Display Language` 切换这些标题并重新加载。
- 动态界面可用 **切换界面语言** 命令或 `iXenaUnrealTools.language` 设置独立切换。已打开的编辑器表单保留未保存输入；性能面板保留历史样本。
- UE 浮动面板有独立 **Auto / 简体中文 / English** 选择。Auto 跟随 UE 当前语言，不更改 UE 全局语言设置。
- C++ 标识符、路径、用户输入和引擎原始日志保持原文。新建类模板的头文件注释保留中文。

## 从 0.5.0 升级

新发布者为 `ixena-unreal-tools`，完整扩展 ID：`ixena-unreal-tools.ixena-unreal-tools`。旧测试版 ID 是 `ixena-local.ixena-unreal-tools`，两者在 VSCode 中是不同扩展。请先停止旧任务，并停用或卸载旧扩展，避免重复按钮和命令。

如果旧版注册过 Windows 系统右键菜单，请先用旧版移除，再用新版注册；系统菜单需要指向新的扩展 ID。旧版工作区状态不会自动迁移，首次需重新选择构建配置和引擎。

UE 通讯协议仍为 1，VSCode 客户端明确兼容 0.5.0、0.6.0 和 0.6.1 的 Bridge。新语言面板和 C4459 修复需要使用 0.6.1 插件源码重新构建；更新已加载的 UE 模块后需要重开 Editor。

## 发布信息

- 仓库：[w2zArd/iXenaUnrealTools](https://github.com/w2zArd/iXenaUnrealTools)
- 下载：[GitHub Releases](https://github.com/w2zArd/iXenaUnrealTools/releases)；具体资产由维护者上传。
- 预期公开商店页：[iXenaUnrealTools](https://marketplace.visualstudio.com/items?itemName=ixena-unreal-tools.ixena-unreal-tools)。需发布后才可使用，本源码不代表扩展已经上架。
- 发布者管理页：[ixena-unreal-tools](https://marketplace.visualstudio.com/manage/publishers/ixena-unreal-tools)，用于维护者登录发布，不是用户安装页。

根目录只需两个组件目录与通用说明/许可证。不需要额外创建 `UnrealPlugins` 中间层。GitHub 文件夹网页通常为 `仓库/tree/<分支>/<目录>`；组件文档使用相对链接，因此不依赖默认分支名称。初始化直接打开仓库首页。

## 构建与验证

VSCode：进入 `iXenaUnrealTools-VSCode`，执行 `npm ci`、`npm test`、`npm --prefix test/ui ci`、`npm run test:ui`、`npm run package`。

UE：进入 `iXenaUnrealTools-UnrealPlugin`，按对应 README 运行 `Tools/Build-Plugin.ps1` 或 `Tools/Build-Plugin.sh`。脚本直接调用目标引擎的 RunUAT BuildPlugin，并显示原始输出；无需 Node。只能在具有相应 UE 工具链的主机上构建。

本次有 TypeScript、通讯模拟、DOM 交互与手动脚本测试。没有真实 UE C++、Windows PowerShell或原生 Slate 窗口运行验收。测试记录见各组件说明；源码实现不能替代目标引擎实编译。

Live Coding 按平台和引擎能力开放；当前 Bridge 在 macOS/Linux 不提供 Live Coding。完整构建、控制台、监测和界面源码另有对应平台路径。官方 MCP 默认仅本机监听；填写其他 IP 不会修改服务端配置，客户端仍严格校验项目与引擎身份。

## 许可证

MIT，Copyright (c) 2026 黄小宇。见 [LICENSE](LICENSE)。第三方依赖保留各自许可证。
