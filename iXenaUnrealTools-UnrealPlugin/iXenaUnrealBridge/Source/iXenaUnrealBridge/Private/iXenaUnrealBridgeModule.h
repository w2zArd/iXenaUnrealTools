#pragma once

#include "CoreMinimal.h"
#include "Containers/Ticker.h"
#include "Modules/ModuleInterface.h"

class FJsonObject;
class SWindow;
class UToolMenu;

/**
 * 本机编辑器通讯模块。消息仅放在当前项目的 Saved 目录中，不开启网络端口。
 *
 * 模块只接受身份匹配且未过期的请求；在游戏线程调用 Live Coding 或用户确认的控制台命令，
 * 用真实编译结果生成响应。请求被领取后不会自动重放，超时也不等于 UE 已取消编译。
 * 本模块没有游戏运行时职责，不进入打包后的游戏。
 */
class FiXenaUnrealBridgeModule final : public IModuleInterface
{
public:
    virtual void StartupModule() override;
    virtual void ShutdownModule() override;

    /** 编译过程中包含原生调用和日志接收器，禁止动态卸载通讯模块本身。 */
    virtual bool SupportsDynamicReloading() override { return false; }

private:
    /** 每 100 毫秒检查请求；编译期间的重入调用只维持状态，不再次触发编译。 */
    bool Tick(float DeltaTime);

    /** 原子发布实例描述，VSCode 用于校验项目、引擎、进程和当前运行状态。 */
    bool PublishInstance();

    /** 主线程每秒发布一次进程性能快照；断点暂停时自然停止更新，不伪造零值。 */
    void PublishMetrics();

    /** 在当前实例内领取一个请求，先移入 Processing 再解析与执行。 */
    void ProcessRequest(const FString& RequestFileName);

    /** 返回最终编译状态；仅 Success 和 NoChanges 表示成功。 */
    void Compile(const FString& RequestId, FString& OutStatus, FString& OutOutput, FString& OutMessage);

    /** 查询当前引擎真正注册的命令/CVar，支持名称过滤与有界分页，不执行命令。 */
    void ListConsole(const FString& RequestId, const TSharedPtr<FJsonObject>& Parameters);

    /** 仅执行显式发送的单行控制台命令；返回“识别/接受”，不保证异步任务完成。 */
    void ExecuteConsole(const FString& RequestId, const TSharedPtr<FJsonObject>& Parameters);

    /** IPC 和 UE 原生面板共用同一条受限单行执行路径。 */
    bool RunConsoleCommand(const FString& Command, FString& OutStatus, FString& OutOutput, FString& OutMessage);

    /** 注册顶部 iXena 菜单，并打开可复用的原生 Slate 浮动窗口。 */
    void RegisterMenus();
    void PopulateMenu(UToolMenu* Menu);
    void OpenToolWindow();
    FString GetWindowStatus() const;

    /** 输出响应时不使用客户端提供的路径；文件名只允许规范 UUID。 */
    void Respond(const FString& RequestId, bool bOk, const FString& Status,
        const FString& Output, const FString& Message, const TSharedPtr<FJsonObject>& Data = nullptr) const;

    /** 获取当前 Live Coding 模块状态，不自动改变用户的 Live Coding 开关。 */
    void GetLiveCodingState(bool& bOutAvailable, bool& bOutEnabled) const;

    FString InstanceDirectory;
    FString InstanceId;
    FString Token;
    FString ProjectPath;
    FString EngineRoot;
    FString StartedAt;
    FTSTicker::FDelegateHandle TickerHandle;
    double LastHeartbeat = 0.0;
    double LastPrune = 0.0;
    bool bProcessing = false;
    bool bCompiling = false;
    /** 响应可由客户端读取后删除；已领取的 UUID 仍须保留，禁止同会话内重复执行。 */
    TSet<FString> ClaimedRequestIds;
    /** 仅缓存名称，分页时读取最新值；两秒内的重复查询不重复遍历全局注册表。 */
    TArray<FString> ConsoleNames;
    double LastConsoleScan = -10.0;
    TWeakPtr<SWindow> ToolWindow;
    /** 模块关闭时先清除有效标记，使待销毁窗口的委托不再调用模块。 */
    TSharedPtr<bool> WindowCallbackLifetime;
    FString CachedMetricsSummary;
    bool bCpuSamplePrimed = false;
};
