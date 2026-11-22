# iXena Unreal Bridge 0.6.2

## 安装和构建

VSCode 的“初始化引擎插件”只选择连接方式并打开仓库。请下载源码，将整个 `iXenaUnrealBridge` 目录放入一个位置，再由本机 UE C++ 工具链编译：

- 项目：`D:\Develop\UnrealEngine\UE5Test\Plugins\iXenaUnrealBridge`。
- 引擎：`<UE_ROOT>/Engine/Plugins/iXena/iXenaUnrealBridge/`。

同一项目/引擎只保留一份同名插件。保存并关闭 Editor 后安装；在 **Plugins → iXena** 中启用 **iXena Unreal Bridge**，使用 Development Editor 构建，按提示重新打开编辑器。插件默认禁用，复制源码不会修改 .uproject；请通过插件界面或描述文件手动启用。

仓库 `iXenaUnrealTools-UnrealPlugin/Tools` 提供 `Build-Plugin.ps1`（Windows）和 `Build-Plugin.sh`（macOS/Linux）。参数分别为 `-EngineRoot ... -Package ...` 与 `--engine ... --package ...`，直接调用所选引擎 UAT，并实时输出日志。脚本只生成包，不安装、不改项目，也不需要 Node 或 VSCode。完整示例见 [仓库](https://github.com/w2zArd/iXenaUnrealTools) 中的组件说明。

项目中仍需启用 UE 自身的 Live Coding 设置；通讯桥不会替用户修改该开关。

UE 编辑器插件不能用 Shipping 游戏 DLL 替代。Development Editor 会生成适合编辑器加载的优化构建。Windows 产物包含 DLL，macOS 是 dylib，Linux 是 so；必须同时保留 `.uplugin`、`.modules` 和构建工具生成的其他必需元数据，不应只复制一个动态库。更换引擎版本、平台或架构后需要重建；即使版本号相同，源码引擎和安装版引擎的 BuildId 也可能不同。

此包包含源码，不包含已验证的 UE 二进制。当前交付环境没有 Unreal Engine C++ 工具链，未在 UE5 各版本、Windows、macOS 或 Linux 上实编译；源码按 UE5 的公共 Core/Json/Module API 编写，并避免依赖 UE5.8/5.9 的 MCP Toolset 模块。首次构建输出是本机兼容性验证依据。

## 平台能力

| 平台 | 编辑器通讯 | Live Coding 编译 |
| --- | --- | --- |
| Windows x64 | 支持 | 使用本机引擎的 `ILiveCodingModule`；须启用 Live Coding |
| macOS | 插件设计支持 | 返回 `NotAvailable`；关闭编辑器后用标准 UBT 构建 |
| Linux | 插件设计支持 | 返回 `NotAvailable`；关闭编辑器后用标准 UBT 构建 |

所有平台的原生加载和实际构建仍需在对应系统验证。插件不会把不支持的 Live Coding 替换为另一种未经确认的热更新路径。

## 通讯和结果

每个编辑器启动时在项目 `Saved/iXenaUnrealBridge/instances/` 下创建自己的 `<进程号>-<GUID>` 文件夹，并写入 `instance.json`。客户端核对项目路径、引擎路径、协议、实例编号与心跳后发送请求。支持连接检查、Live Coding、查询控制台命令/CVar，以及执行用户明确提交的单行控制台输入。不会打开 TCP/HTTP 端口；查询和连接检查不会执行控制台命令。

编译请求在游戏线程调用：

```cpp
LiveCoding->Compile(ELiveCodingCompileFlags::WaitForCompletion, &Result);
```

返回 `Success` 或 `NoChanges` 才表示成功；`Failure` 表示编译失败。预检查可返回 `NotEnabled`、`NotAvailable`、`CompileStillActive`。其他原生结果保守标记为 `Unknown`，附上原始枚举数字，不依赖各版本可能不同的其他枚举成员名字。旧引擎如果没有带明确结果参数的同步接口，模板适配会返回 `NotAvailable`，不会猜测编译成功。客户端断开或等待超时不代表 UE 已取消编译；同一请求不会被自动重放。

`Logs/<请求 UUID>.log` 是 UTF-8 增量日志。插件实时写入在本轮编译中收到的 `LogLiveCoding` / `UnrealBuildTool` 类别输出以及 UE 警告、错误，逐次刷新，供 VSCode 读取。不同 UE 版本的独立 Live Coding Console 不保证把完整 UBT 输出送入 `GLog`，因此这里不能承诺每一条编译进度都会同步；完整原生输出仍以 UE Live Coding Console 为准。插件不会猜测并混入其他项目的全局 UBT 日志。

单次日志最多约 4 MiB，内存文本最多约 100 万个 TCHAR；达到上限后会写入提示。当前实例超过一天的响应和日志会清理。正常退出仅删除本实例在线描述，保留日志供排查。异常退出后留下的旧实例描述由客户端心跳校验排除。

消息目录沿用项目目录的本机文件权限。会话 token 用来防止误发和旧实例重放，不是对具有项目文件读取权限的本机程序的安全隔离；请使用可信项目目录。

## UE 内原生浮动面板

启用并重启编辑器后，在顶部主菜单 **iXena → 打开工具面板** 或关卡编辑器工具栏的 **iXena** 按钮打开 Slate 浮动窗口。重复点击会激活已有窗口。它提供：

- 当前项目、平台、PID、通讯及 Live Coding 状态。
- 搜索当前引擎真正注册的控制台命令和 CVar，列表最多显示前 200 个匹配项，显示帮助和当前变量值。
- 单行命令输入、回车/按钮执行，以及 `stat fps`、`stat unit`、`show collision` 快捷入口。部分 Exec 命令不在注册表中，可直接输入。
- 本次执行结果和复制按钮。命令 `Executed` 表示 UE 已识别并处理输入，不表示其触发的异步操作已经完成。
- Live Coding 按钮；当前平台或引擎未提供 Live Coding、未启用或正在忙时禁用。
- 每秒刷新的进程 CPU、进程驻留物理内存/峰值、系统可用内存、帧间隔和调试器附加状态。

原生面板和 VSCode 通讯使用同一个控制台执行函数，拒绝 NUL、换行、分号、竖线和超过 4096 字符的输入。原生面板对 `quit`、`exit`、`restart`、`open`、`map` 等关闭编辑器或切换关卡的直接命令要求确认。执行上下文为 Editor 世界；某些命令的显示效果还取决于 UE 当前视口和运行模式。

## 性能指标

`metrics.json` 与实例心跳同周期更新，包含 `FPlatformMemory::GetStats()` 的 `UsedPhysical` / `PeakUsedPhysical` / `AvailablePhysical`。前两个是当前编辑器进程的物理内存统计，后一个是系统可用物理内存，两者不会混作同一个指标。

`cpuTimePct` 对应 `FCPUTime::CPUTimePct`，按整机 CPU 容量计；`cpuTimePctRelative` 按单核 100% 计，可大于 100%。首个尚未建立基线的采样省略 CPU 字段。`frameDeltaMs` 是 `FApp::GetDeltaTime()*1000` 的帧间隔，并不是 Game Thread、Render Thread 或 GPU 的独立耗时。调试器断点暂停时采样也暂停，客户端应保留最后值并显示过期状态，不能写成零。

窗口只显示缓存的性能快照，不在每次绘制时重复取样。这里提供轻量进程监控；调用栈、对象生命周期和详细线程/GPU 分析仍应使用对应调试器或 Unreal Insights。

## 本机验收

1. 用所选引擎的插件构建命令完成 Development Editor 构建；确认动态库和 `.modules` 均生成。
2. 将产物放到所选插件目录，启用插件，重启 UE。输出日志应出现 `iXenaUnrealBridge 0.6.1 已启动`。
3. 在 VSCode 检查连接，应看到当前项目、引擎、PID、平台和 Live Coding 状态；检查连接不会编译。
4. Windows 上只修改已有 `.cpp` 函数体，执行热更新；收到 `Success`，或没有改动时收到 `NoChanges`。
5. 引入一个 C++ 语法错误；响应应为 `Failure`，VSCode 显示收到的日志，UE Live Coding Console 保留完整原生日志。
6. 关闭 Live Coding，重试；应返回 `NotEnabled`。macOS/Linux 应明确返回 `NotAvailable`。
7. 多项目、多引擎编辑器同时打开时，检查 VSCode 始终使用已选择项目的实例；删除或修改请求的实例编号/token 时，不应触发编译。
8. 在编译期间关闭 VSCode；UE 编译不应被报告为已取消。重新连接时先检查编辑器状态，不能自动重放先前请求。
9. 打开 UE 顶部 iXena 工具面板，查询 `t.MaxFPS`；读回原值后执行测试值，确认查询更新，再恢复原值。重复打开菜单应复用一个窗口。
10. 检查进程内存与系统可用内存分别显示；附加调试器并打断点后，VSCode 应显示采样过期，恢复执行后继续更新。

## API 参考

- [Epic：Live Coding 使用和平台条件](https://dev.epicgames.com/documentation/en-us/unreal-engine/using-live-coding-to-recompile-unreal-engine-applications-at-runtime)
- [Epic：LiveCodingToolset 编译等待与结果说明](https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/LiveCodingToolset/ULiveCodingToolset/CompileLiveCoding)
- [Epic：FTSTicker](https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Core/FTSTicker)
- [Epic：FOutputDevice](https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Core/FOutputDevice)
- [Epic：EFileWrite / FILEWRITE_AllowRead](https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Core/EFileWrite)
- [Epic：IConsoleManager 与用户控制台输入](https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Core/IConsoleManager)
- [Epic：ToolMenus 启动注册与所有者卸载](https://dev.epicgames.com/documentation/unreal-engine/API/Developer/ToolMenus/UToolMenus)
- [Epic：CPU 时间百分比字段](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Core/FCPUTime)

`ILiveCodingModule` 的精确接口以所选本机引擎的 `Engine/Source/Developer/Windows/LiveCoding/Public/ILiveCodingModule.h` 为准。

