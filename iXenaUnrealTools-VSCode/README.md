# iXenaUnrealTools 0.6.2

## 0.6.2：自动重连与编译完成状态

通讯状态每秒自动检查；已连接时每 5 秒向 UE/MCP 进行一次确认。无需点击通知解除连接/构建状态：收到 UE Live Coding 最终结果就解锁编译按钮，“编译与热更新”分组保留最近一次结果。后台探测只执行 ping/身份检查，不自动启动编译，前台操作会避开正在进行的后台 ping。

[English](README.en.md) · **作者：黄小宇** · **MIT** · VSCode 1.96+

面向 Unreal Engine C++ 工作区的 VSCode 工具箱：已有任务构建与调试、多引擎选择、UHT、源码分栏、模块依赖和描述文件编辑，以及与运行中 UE Editor 的通讯。

**0.6.1 改为手动安装 UE 插件。** VSIX 只提供“初始化引擎插件”入口和通讯客户端，不再包含 UE 插件源码、自动下载、自动编译或安装器。UE 源码和独立构建脚本位于同仓库的 `iXenaUnrealTools-UnrealPlugin`。

- 仓库：[w2zArd/iXenaUnrealTools](https://github.com/w2zArd/iXenaUnrealTools)
- VSCode 源码目录：`iXenaUnrealTools-VSCode`
- UE 源码目录：`iXenaUnrealTools-UnrealPlugin/iXenaUnrealBridge`
- 手动构建脚本：`iXenaUnrealTools-UnrealPlugin/Tools`

## 安装 VSCode 扩展

在 VSCode 的扩展视图选择 **从 VSIX 安装**，安装 `ixena-unreal-tools-0.6.2.vsix`，然后重新加载窗口。

本版发布者为 `ixena-unreal-tools`，扩展 ID 为 **`ixena-unreal-tools.ixena-unreal-tools`**。旧本地版 ID 为 `ixena-local.ixena-unreal-tools`，不会被同 ID 升级覆盖；请停用或卸载旧版，避免两套按钮和命令同时激活。若旧版注册过 Windows 系统菜单，先用旧版移除菜单，再安装本版并重新注册。

[发布者管理页](https://marketplace.visualstudio.com/manage/publishers/ixena-unreal-tools)用于上传和管理扩展，**不是公开扩展详情页**。[预期公开地址](https://marketplace.visualstudio.com/items?itemName=ixena-unreal-tools.ixena-unreal-tools)按当前 publisher/name 组成；本交付没有验证它已发布，也没有代为推送仓库或发布 Marketplace / GitHub Release。

## 初始化连接

打开左侧 **iXena Unreal → 编辑器通讯 → 连接与初始化 → 初始化引擎插件…**。快捷操作和命令面板也提供同一入口。

| 选择 | 初始化会做什么 | 你需要准备什么 |
| --- | --- | --- |
| iXena 插件 | 保存通讯方式并打开上面的 GitHub 仓库 | 下载源码或对应引擎的构建产物，手动放置、编译、启用并重开 UE |
| Epic Unreal MCP | 输入 IP、端口和路径，保存通过校验的客户端地址 | 在对应 UE 中开启官方 Unreal MCP；热更新需要 Live Coding 工具集 |

初始化不会修改 `.uproject` 的插件启用项，不会后台启动 UAT，也不会创建项目插件目录。完成手动准备后，选择正确的项目/引擎，再点击 **检查连接 / 插件状态**。

### 插件方式

下载仓库中的整个 `iXenaUnrealTools-UnrealPlugin/iXenaUnrealBridge` 文件夹，保留 `.uplugin` 和 Source 结构。保存并关闭 UE，再放到以下任一位置；同一项目不要同时加载两份同名插件。

| 安装范围 | 示例位置 |
| --- | --- |
| 项目 | `D:\Develop\UnrealEngine\UE5Test\Plugins\iXenaUnrealBridge` |
| 引擎 | `D:\Engines\UE_5.9\Engine\Plugins\iXena\iXenaUnrealBridge` |

使用对应引擎的 C++ 工具链构建 Development Editor，在 **UE Plugins → iXena** 分类启用 **iXena Unreal Bridge**，按提示重开编辑器。也可先运行 `Tools` 脚本生成插件包，再复制完整输出目录。`.uplugin`、模块清单和其他必需元数据都要保留，不能只复制一个 DLL。

在仓库的 `iXenaUnrealTools-UnrealPlugin` 目录运行以下示例。输出父目录需提前存在，目标输出目录必须不存在或为空，并且位于引擎和插件源码之外。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Tools\Build-Plugin.ps1 `
  -EngineRoot "D:\Engines\UE_5.9" `
  -Package "D:\Builds\iXenaUnrealBridge-UE5.9" `
  -Language zh-CN
```

```bash
bash ./Tools/Build-Plugin.sh \
  --engine "/opt/UnrealEngine/UE_5.9" \
  --package "/tmp/iXenaUnrealBridge-UE5.9" \
  --language en
```

脚本实时显示选定主机引擎的 UAT / UBT 输出，返回实际退出码并检查产物，**只构建、不安装**。默认移除 PDB/dSYM；需要保留时用 `-KeepSymbols` / `--keep-symbols`。Windows 路径中的 CMD 元字符会被明确拒绝。不同引擎、系统和架构需要分别构建。

### MCP 方式

默认输入为 `127.0.0.1`、`8000`、`/mcp`，组合成 `http://127.0.0.1:8000/mcp`。向导接受明确的 IPv4、IPv6 或 localhost；取消输入不会覆盖之前的配置。

填写 IP/端口只设置客户端连接地址，不会改变 UE 的监听地址。官方服务默认面向本机；填写其他 IP 并不自动获得跨机器工作能力。服务仍须能访问并返回与当前选择完全匹配的项目/引擎身份；本版不提供远端与本地路径映射。第三方同名 MCP 插件不保证具有相同工具和元数据。

插件方式的命令和性能监测不依赖 MCP。选用 MCP 热更新后，仍可通过已经加载的 iXena Bridge 使用这些功能。

## 面板分类与语言

通讯面板将操作分为四组，连接状态单独置顶：

| 分组 | 内容 |
| --- | --- |
| 连接与初始化 | 初始化、项目/引擎选择、通讯方式、连接检查；MCP 方式显示地址 |
| 编译与热更新 | Live Coding、本机 Editor 完整编译 |
| 运行与调试 | CPU/内存监测、Unreal Insights、命令/CVar |
| 日志与帮助 | 实时输出、上次热更新日志、仓库说明 |

支持简体中文与英文。动态界面默认跟随 VSCode，可用 **界面语言** 命令或 `iXenaUnrealTools.language` 设置 `auto`、`zh-CN`、`en`。状态栏、侧栏和动态面板更新语言；Webview 切换会保留未提交输入和性能历史。

**命令面板、右键菜单和静态视图标题由 VSCode 的显示语言决定。** 手动语言设置只控制扩展的动态界面；更改 VSCode 显示语言时按 VSCode 要求重启。UE 原生浮动面板独立提供 Auto / English / 简体中文，Auto 跟随 UE 界面语言。

源代码、技术标识符、引擎原生日志、用户命名不会被自动翻译。类向导生成的头文件注释按设计保持中文。

## 主要功能

| 功能 | 使用说明 |
| --- | --- |
| 构建/停止/调试 | 读取已有 `.code-workspace` / `tasks` / `launch`，选择配置后构建；调试复用匹配的 launch。复杂任务可用“运行原始 VSCode 任务” |
| 构建终端 | 同一项目尽量复用终端；普通任务停止优先 Ctrl+C，必要时回退 VSCode 任务终止；尽量归档 UBT 日志 |
| 多引擎 | 从任务和设置发现引擎；切换工具链不自动改项目 EngineAssociation，launch 路径不匹配时需重新生成工程 |
| UHT / IntelliSense | 提供独立 UHT 刷新和语言服务刷新；旧引擎能力不足时需用常规完整构建 |
| 源码分栏 | 选择主项目/插件范围，按 Public、Private 等查看；可复用 `multiExplorer.panes`；未配置分栏则隐藏 |
| `.h/.cpp` 切换 | 编辑器或资源树右键，按同名文件与模块路径配对；多候选让用户选择 |
| 新建 C++ 类 | 20 个内置父类模板及自定义父类，选择模块、命名、Public/Private、子目录并预览；不覆盖文件 |
| Build.cs 依赖 | 可视化修改可识别的静态 Public/Private 依赖；复杂条件逻辑保留人工编辑 |
| `.uproject/.uplugin` | 可视化编辑声明与插件引用，保留未知字段；写入文档缓冲区，由用户保存 |
| UE 命令/CVar | 搜索实际注册项，查看帮助与当前值，确认完整命令和目标后发送 |
| CPU/内存 | 采样当前 UE Editor 进程，显示最多 120 个样本；断点/忙碌时保留最后读数并标记过期 |
| Unreal Insights | 打开实例所属引擎的工具；不会自动开始 Trace 录制 |
| Windows 系统菜单 | 显式注册/移除当前用户 `.uproject/.uplugin` 菜单；Windows 11 位于“显示更多选项” |

类向导列出所需模块依赖，生成后可打开 Build.cs 编辑器补齐。新增反射类、修改模块或 Build.cs/Target.cs 后，应使用完整构建并按需要重开编辑器。

UE 插件启用后，还可通过 **UE 顶部 iXena → 打开工具面板** 使用原生可移动浮动窗口，查看状态、命令和性能数值。

## 热更新、日志与平台边界

Windows 智能编译只有在确认 Editor 与项目、引擎匹配时才发送 Live Coding；确认没有匹配的 Editor 时使用原有 UBT。连接失败、编译失败或结果不确定不会自动再提交普通 UBT。协议 1 明确兼容 Bridge 0.5.0 和 0.6.1。

插件热更新输出来自实际捕获的 UE GLog，独立 Live Coding Console **不保证转发所有编译器行**。MCP 进度取决于服务端通知。可识别的绝对文件诊断进入专属 Problems；等待超时不代表 UE 已停止编译，本版没有可靠的 Live Coding 取消入口。

macOS/Linux 提供通讯插件源码、手动构建脚本、命令/性能面板，以及本机完整编译入口；本版 Live Coding 在这些平台返回不可用。原有 Windows Tasks 自动转换和系统菜单不代表已移植为所有平台功能。

当前交付没有真实 UE C++ 工具链和 Windows/macOS GUI 验收，旧 UE5 也没有逐版本实编译矩阵。C++ 源码已修正 `FCompileOutput` 构造参数遮蔽问题，使用 `InCompileLogPath`，但该静态修复不能代替目标引擎构建结果。完整验证范围见 [VALIDATION.md](VALIDATION.md)。

## 工作区示例

以下是可合并到已有 `.code-workspace` 的示例；保留你原有 UE 生成的 tasks 和 launch。

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

## 开发与许可证

在 `iXenaUnrealTools-VSCode` 目录运行：

```bash
npm ci
npm test
npm --prefix test/ui ci
npm run test:ui
npm run package
```

`npm run test:host` 另需有效桌面/显示服务。开发依赖不会包含在 VSIX 中。

本项目使用 [MIT License](LICENSE)，版权署名为黄小宇。分发源码或软件副本时保留版权和许可声明；Unreal Engine 与其他依赖仍适用各自许可。

### 0.6.1 补充：多语言与连接诊断

常用 CVar/控制台命令在中文环境显示中文用途概览及 UE 原始英文帮助；未收录条目保留英文，避免误译。英文界面原样显示 UE 帮助。中文关键词匹配需新版通讯插件，变更语言不会改写 CVar 名称、值或引擎原始日志。

检查连接只进行受限的状态读取和 ping，即使后台存在 UBT 任务也可操作；只在收到 UE 响应后显示已连接。桥接插件不再注册第二个顶级 iXena 菜单，通过 QtQuickUI 现有菜单、Window 菜单或工具栏打开。替换已加载的 DLL 前请关闭 UE Editor。
