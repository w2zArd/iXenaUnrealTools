# iXenaUnrealTools · Unreal Plugin 0.6.2

## 目录和命名

| 目录 / 文件 | 用途 |
| --- | --- |
| `iXenaUnrealBridge/` | 真正放入 UE `Plugins` 的插件目录 |
| `iXenaUnrealBridge/iXenaUnrealBridge.uplugin` | 插件描述文件；分类统一为 **iXena** |
| `iXenaUnrealBridge/Source/` | UE C++ 源码，内部模块名保持 `iXenaUnrealBridge` |
| `Tools/Build-Plugin.ps1` | Windows 本机构建脚本 |
| `Tools/Build-Plugin.sh` | macOS / Linux 本机构建脚本 |
| `Tests/test_manual_build.py` | 手动构建脚本的模拟 UAT 回归测试 |

仓库子目录 `iXenaUnrealTools-UnrealPlugin` 是分发目录；不要把它的名字当作 UE 模块名。需要手动复制的是里面的 **`iXenaUnrealBridge`** 文件夹，或构建脚本输出的完整插件包。

## 方式一：放入源码，再用项目编译

1. 保存并关闭 UE Editor。
2. 下载仓库 ZIP 或克隆仓库。
3. 把 `iXenaUnrealBridge` 复制到一个安装位置：

   - 项目：`D:\Develop\UnrealEngine\UE5Test\Plugins\iXenaUnrealBridge`。
   - 引擎：`<UE_ROOT>\Engine\Plugins\iXena\iXenaUnrealBridge`。

4. 在 UE 的 **Plugins → iXena** 分类中启用 **iXena Unreal Bridge**；按提示重新打开编辑器。需要生成二进制时，使用该引擎的 C++ 工具链构建项目的 **Development Editor** 目标。
5. 如果项目缺少 C++ 构建环境、无法在启动时构建插件，先使用下面的 `Tools` 脚本生成插件包。
6. 在 VSCode 检查连接，核对项目、引擎和 PID；UE 顶部 **iXena → 打开工具面板** 可以打开原生浮动窗口。

项目和引擎中请只保留一份同名插件。插件默认禁用，复制源码不会自动修改 `.uproject`。需要手动配置时，可在项目的 `Plugins` 数组中加入或更新 `{"Name":"iXenaUnrealBridge","Enabled":true}`，保留已有其他插件条目。

## 方式二：使用 Tools 构建后复制

脚本调用你选择的引擎自带 **RunUAT → BuildPlugin**，直接显示 UAT / UBT 输出；不自动复制安装、不改写项目、不下载 DLL、不进行跨平台交叉编译。输出目录必须是尚不存在的目录或空目录，且位于引擎和插件源码之外，父目录需要先存在。

### Windows

在本目录打开 PowerShell，先创建示例输出父目录，再构建：

```powershell
New-Item -ItemType Directory -Force "D:\Builds" | Out-Null

powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Tools\Build-Plugin.ps1 `
    -EngineRoot "D:\Engines\UE_5.9" `
    -Package "D:\Builds\iXenaUnrealBridge-UE5Test-0.6.2"
```

可添加 `-Language zh-CN` / `-Language en`，默认跟随当前 PowerShell 界面语言；添加 `-KeepSymbols` 保留 PDB / dSYM。脚本支持包含空格、中文的普通路径；Windows 批处理路径中的 CMD 元字符（例如 `%`、`!`、`&`、引号）会被明确拒绝。脚本以 UTF-8 BOM 保存，兼容 Windows PowerShell 5.1 读取中文。

### macOS / Linux

```bash
mkdir -p /tmp/ixena-builds

bash ./Tools/Build-Plugin.sh \
    --engine "/absolute/path/to/UE_5.x" \
    --package "/tmp/ixena-builds/iXenaUnrealBridge-0.6.2"
```

可选 `--language zh-CN` / `--language en`、`--keep-symbols`；默认跟随 Shell 的语言环境。脚本按当前系统选择 `Mac` 或 `Linux`，继承引擎当前可用的架构/工具链。

### 构建完成后

只有 UAT 返回成功、输出存在 `.uplugin`、本机动态库和 `.modules` 清单时，脚本才报告成功。返回失败时保留实际退出码；输出目录已有内容时会直接拒绝，不自动清空。

关闭 UE 后，把**完整输出目录**复制为项目或引擎下的 `iXenaUnrealBridge`，然后启用并重新打开项目。输出默认移除调试符号，但保留 UAT 生成的其他必要文件。Editor 插件使用优化后的 Development Editor 构建；不能只拿 Shipping 游戏 DLL 替代，也不能仅复制单个 DLL。

Windows 输出 DLL，macOS 输出 dylib，Linux 输出 so。更换引擎、BuildId、系统或架构后，需要使用对应工具链重新构建。

## 界面语言

原生工具面板顶部有 **自动（跟随 UE） / 简体中文 / English** 选项。

- Auto 读取 UE 当前界面语言；`zh` 系列使用简体中文，其余语言回退英文。
- 手动选择只改变本插件，不修改 UE 全局语言，也不改变 VSCode 的语言设置。
- 选择保存在当前项目的编辑器用户设置中。
- 菜单、窗口、按钮、帮助、状态和本插件产生的响应使用相应语言；切换不清除命令输入或历史输出。
- 引擎返回的控制台帮助、CVar 名称、源码标识符及已有编译日志保留原文。已有输出不会重新翻译。

## 功能和边界

- 原生可移动、缩放的工具窗口；顶部菜单和工具栏共用一个窗口。
- 查询实际注册的命令/CVar、帮助和当前值；发送明确提交的单行命令。
- CPU、驻留内存、峰值内存、系统可用内存、帧间隔和调试器状态。
- 本机文件通讯；协议 1，兼容既有实例字段。没有 TCP 监听，不依赖 MCP 开关。
- 引擎支持且启用时，通过 Windows Live Coding 返回实际结果。
- macOS/Linux 提供通讯、控制台和面板源码；Live Coding 返回 `NotAvailable`，完整构建需要关闭 Editor。

CPU/内存指标针对当前 **Editor 进程**。同步编译或断点可能暂停主线程采样，VSCode 应保留最后读数并标记过期；帧间隔不是 CPU/GPU 函数耗时。深入分析可使用 Unreal Insights。

Live Coding 日志仅包含插件实际从 GLog 收到的内容。独立 Live Coding Console 不一定转发所有 UBT 行，因此不承诺全量编译输出。客户端超时不代表 UE 已取消编译，也不能自动重复提交。

## 本次修复和验证

0.6.1 修复用户报告的 UE5.9 **C4459**：`FCompileOutput` 的 `LogPath` 参数与引擎全局日志类别同名，现改为 `InCompileLogPath`。没有通过关闭警告或修改引擎设置规避问题。

本目录的 Python 标准库测试覆盖 8 项：模拟 UAT 成功、符号保留、失败退出码、缺少产物、非空目录保护、输出边界/链接检查、C4459 命名回归和插件分类/语言范围。执行方式：

```bash
python3 -m unittest discover -s Tests -v
```

**测试中的 UAT 是受控模拟；当前环境没有 UE、Windows PowerShell 或 macOS Xcode，未执行实际 C++ 构建、Windows 脚本运行或原生窗口验收。** UE5 旧版本采用公开 API 和能力检查适配，仍需在对应版本首次编译确认。实际构建失败时应保留第一条 C++ 错误和引擎版本。

## 协议与许可

文件通讯和性能字段详见 [协议文档](iXenaUnrealBridge/PROTOCOL.md)。代码采用 [MIT License](LICENSE)，版权署名为 **黄小宇**。分发时保留许可证及版权声明；Unreal Engine 本身仍遵循 Epic 的许可条款。

