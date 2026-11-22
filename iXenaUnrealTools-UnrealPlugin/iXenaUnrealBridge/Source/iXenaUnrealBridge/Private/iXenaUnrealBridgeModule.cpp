#include "iXenaUnrealBridgeModule.h"
#include "iXenaBridgeWindow.h"
#include "iXenaBridgeLocalization.h"
#include "iXenaBridgeConsoleHelp.h"

#include "Containers/StringConv.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Editor.h"
#include "Editor/EditorEngine.h"
#include "Engine/World.h"
#include "Framework/Application/SlateApplication.h"
#include "Framework/Commands/UIAction.h"
#include "HAL/CriticalSection.h"
#include "HAL/FileManager.h"
#include "HAL/IConsoleManager.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformMemory.h"
#include "HAL/PlatformMisc.h"
#include "HAL/PlatformTime.h"
#include "Misc/App.h"
#include "Misc/DateTime.h"
#include "Misc/EngineVersion.h"
#include "Misc/FileHelper.h"
#include "Misc/Guid.h"
#include "Misc/OutputDevice.h"
#include "Misc/OutputDeviceRedirector.h"
#include "Misc/Paths.h"
#include "Misc/ScopeLock.h"
#include "Modules/ModuleManager.h"
#include "Serialization/Archive.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Styling/AppStyle.h"
#include "Templates/UnrealTemplate.h"
#include "ToolMenus.h"
#include "Widgets/SWindow.h"

#if WITH_LIVE_CODING && PLATFORM_WINDOWS
#include "ILiveCodingModule.h"
#endif

DEFINE_LOG_CATEGORY_STATIC(LogiXenaUnrealBridge, Log, All);

namespace iXenaBridge
{
    constexpr int32 ProtocolVersion = 1;
    constexpr int64 MaxRequestBytes = 16 * 1024;
    constexpr int32 MaxOutputCharacters = 1024 * 1024;
    constexpr int32 MaxLogBytes = 4 * 1024 * 1024;

    FString NormalizePath(const FString& Path)
    {
        FString Result = FPaths::ConvertRelativePathToFull(Path);
        FPaths::NormalizeFilename(Result);
        FPaths::CollapseRelativeDirectories(Result);
        return Result;
    }

    const TCHAR* PlatformName()
    {
#if PLATFORM_WINDOWS
        return TEXT("Win64");
#elif PLATFORM_MAC
        return TEXT("Mac");
#elif PLATFORM_LINUX
        return TEXT("Linux");
#else
        return TEXT("Unsupported");
#endif
    }

    bool IsRequestId(const FString& Value)
    {
        FGuid Parsed;
        return Value.Len() == 36 && FGuid::ParseExact(Value, EGuidFormats::DigitsWithHyphens, Parsed)
            && Parsed.ToString(EGuidFormats::DigitsWithHyphens).ToLower() == Value;
    }

    bool PublishJson(const FString& Destination, const TSharedRef<FJsonObject>& Object)
    {
        FString Text;
        const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Text);
        if (!FJsonSerializer::Serialize(Object, Writer))
        {
            return false;
        }
        const FString Temporary = Destination + TEXT(".") + FGuid::NewGuid().ToString(EGuidFormats::Digits) + TEXT(".tmp");
        if (!FFileHelper::SaveStringToFile(Text, *Temporary, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM))
        {
            return false;
        }
        const bool bMoved = IFileManager::Get().Move(*Destination, *Temporary, true, false, false, true);
        if (!bMoved)
        {
            IFileManager::Get().Delete(*Temporary, false, false, true);
        }
        return bMoved;
    }

    /** 同时保存有界文本和可被 VSCode 增量读取的 UTF-8 日志，不向 GLog 回写。 */
    class FCompileOutput final : public FOutputDevice
    {
    public:
        explicit FCompileOutput(const FString& InCompileLogPath)
            : File(IFileManager::Get().CreateFileWriter(*InCompileLogPath, FILEWRITE_AllowRead | FILEWRITE_Silent))
        {
        }

        virtual bool CanBeUsedOnAnyThread() const override { return true; }
        virtual bool CanBeUsedOnMultipleThreads() const override { return true; }

        virtual void Serialize(const TCHAR* Text, ELogVerbosity::Type Verbosity, const FName& Category) override
        {
            const FString CategoryText = Category.ToString();
            // Live Coding 的原生控制台并不保证把全部 UBT 输出送入 GLog；这里只转发真正收到的行。
            if (CategoryText.Contains(TEXT("LiveCoding")) || CategoryText.Contains(TEXT("UnrealBuildTool"))
                || (Verbosity & ELogVerbosity::VerbosityMask) <= ELogVerbosity::Warning)
            {
                Append(FString::Printf(TEXT("[%s] %s\n"), *CategoryText, Text));
            }
        }

        void Append(const FString& Line)
        {
            FScopeLock Lock(&Mutex);
            if (bTruncated)
            {
                return;
            }
            const FTCHARToUTF8 Encoded(*Line);
            if (Output.Len() + Line.Len() > MaxOutputCharacters || WrittenBytes + Encoded.Length() > MaxLogBytes)
            {
                const FString Notice(iXenaBridgeLocale::Text(TEXT("\n[iXenaUnrealBridge] 日志达到上限，后续输出请在 UE Live Coding Console 查看。\n"), TEXT("\n[iXenaUnrealBridge] Log limit reached. View additional output in the UE Live Coding Console.\n")));
                Output += Notice;
                WriteLine(Notice);
                bTruncated = true;
                return;
            }
            Output += Line;
            WriteLine(Line);
        }

        FString GetText()
        {
            FScopeLock Lock(&Mutex);
            return Output;
        }

    private:
        void WriteLine(const FString& Line)
        {
            if (File)
            {
                const FTCHARToUTF8 Encoded(*Line);
                File->Serialize(const_cast<ANSICHAR*>(Encoded.Get()), Encoded.Length());
                File->Flush();
                WrittenBytes += Encoded.Length();
            }
        }

        FCriticalSection Mutex;
        TUniquePtr<FArchive> File;
        FString Output;
        int32 WrittenBytes = 0;
        bool bTruncated = false;
    };

    /** 在析构前注销输出设备，防止后续线程访问已销毁的栈对象。 */
    class FScopedOutputRegistration final
    {
    public:
        explicit FScopedOutputRegistration(FOutputDevice& InDevice) : Device(InDevice)
        {
            if (GLog) GLog->AddOutputDevice(&Device);
        }
        ~FScopedOutputRegistration()
        {
            if (GLog) GLog->RemoveOutputDevice(&Device);
        }
    private:
        FOutputDevice& Device;
    };

    /** 控制台回复的有界接收器：查询大量条目时也不无限增长内存。 */
    class FConsoleReply final : public FOutputDevice
    {
    public:
        virtual void Serialize(const TCHAR* Text, ELogVerbosity::Type Verbosity, const FName& Category) override
        {
            constexpr int32 Limit = 256 * 1024;
            if (Output.Len() >= Limit || bTruncated) return;
            const FString Line = FString(Text) + TEXT("\n");
            if (Output.Len() + Line.Len() > Limit)
            {
                Output += Line.Left(Limit - Output.Len());
                Output += iXenaBridgeLocale::Text(TEXT("\n[iXenaUnrealBridge] 控制台回复达到上限，请在 UE Output Log 查看剩余输出。\n"), TEXT("\n[iXenaUnrealBridge] Console reply limit reached. View additional output in the UE Output Log.\n"));
                bTruncated = true;
            }
            else Output += Line;
        }
        FString Output;
    private:
        bool bTruncated = false;
    };

    bool ContainsForbiddenCommandCharacter(const FString& Text)
    {
        for (int32 Index = 0; Index < Text.Len(); ++Index)
        {
            const TCHAR Character = Text[Index];
            if (Character == 0 || Character == TEXT('\r') || Character == TEXT('\n')
                || Character == TEXT('|') || Character == TEXT(';')) return true;
        }
        return false;
    }

#if WITH_LIVE_CODING && PLATFORM_WINDOWS
    FString CompileResultName(ELiveCodingCompileResult Result)
    {
        switch (Result)
        {
        case ELiveCodingCompileResult::Success: return TEXT("Success");
        case ELiveCodingCompileResult::NoChanges: return TEXT("NoChanges");
        case ELiveCodingCompileResult::Failure: return TEXT("Failure");
        // WaitForCompletion 后仍处于 InProgress 不应被当作成功。
        default: return TEXT("Unknown");
        }
    }

    // 某些旧版本的 Compile 不提供结果参数；只有支持明确结果的签名才执行，禁止猜测成功。
    template<typename TModule>
    auto CompileAndWait(TModule* Module, FString& OutStatus, FString& OutDetail, int)
        -> decltype(static_cast<bool>(Module->Compile(ELiveCodingCompileFlags::WaitForCompletion,
            static_cast<ELiveCodingCompileResult*>(nullptr))), bool())
    {
        ELiveCodingCompileResult Result = static_cast<ELiveCodingCompileResult>(-1);
        const bool bAccepted = Module->Compile(ELiveCodingCompileFlags::WaitForCompletion, &Result);
        OutStatus = CompileResultName(Result);
        OutDetail = iXenaBridgeLocale::IsChinese()
            ? FString::Printf(TEXT("UE Compile 返回 %s，原始结果枚举值 %d。"), bAccepted ? TEXT("true") : TEXT("false"), static_cast<int32>(Result))
            : FString::Printf(TEXT("UE Compile returned %s; native result enum value: %d."), bAccepted ? TEXT("true") : TEXT("false"), static_cast<int32>(Result));
        return true;
    }

    template<typename TModule>
    bool CompileAndWait(TModule*, FString& OutStatus, FString& OutDetail, long)
    {
        OutStatus = TEXT("NotAvailable");
        OutDetail = iXenaBridgeLocale::Text(TEXT("此引擎的 Live Coding API 不提供本插件所需的同步结果接口；未启动编译，请在 UE 中手动编译。 "), TEXT("This engine does not provide the required synchronous Live Coding result API. Compilation was not started; compile manually in UE."));
        return false;
    }
#endif
}

void FiXenaUnrealBridgeModule::StartupModule()
{
    if (IsRunningCommandlet() || !FPaths::IsProjectFilePathSet())
    {
        return;
    }
    iXenaBridgeLocale::Initialize();
    ProjectPath = iXenaBridge::NormalizePath(FPaths::GetProjectFilePath());
    EngineRoot = iXenaBridge::NormalizePath(FPaths::RootDir());
    InstanceId = FString::Printf(TEXT("%u-%s"), FPlatformProcess::GetCurrentProcessId(),
        *FGuid::NewGuid().ToString(EGuidFormats::DigitsWithHyphens).ToLower());
    Token = FGuid::NewGuid().ToString(EGuidFormats::Digits).ToLower()
        + FGuid::NewGuid().ToString(EGuidFormats::Digits).ToLower();
    StartedAt = FDateTime::UtcNow().ToIso8601();
    InstanceDirectory = FPaths::Combine(FPaths::GetPath(ProjectPath), TEXT("Saved/iXenaUnrealBridge/instances"), InstanceId);

    for (const TCHAR* Subdirectory : { TEXT("Requests"), TEXT("Responses"), TEXT("Processing"), TEXT("Logs") })
    {
        if (!IFileManager::Get().MakeDirectory(*FPaths::Combine(InstanceDirectory, Subdirectory), true))
        {
            if (iXenaBridgeLocale::IsChinese())
            { UE_LOG(LogiXenaUnrealBridge, Error, TEXT("无法创建通讯目录：%s"), *InstanceDirectory); }
            else
            { UE_LOG(LogiXenaUnrealBridge, Error, TEXT("Cannot create the communication directory: %s"), *InstanceDirectory); }
            InstanceDirectory.Empty();
            return;
        }
    }
    if (!PublishInstance())
    {
        if (iXenaBridgeLocale::IsChinese())
        { UE_LOG(LogiXenaUnrealBridge, Error, TEXT("无法发布通讯实例：%s"), *InstanceDirectory); }
        else
        { UE_LOG(LogiXenaUnrealBridge, Error, TEXT("Cannot publish the communication instance: %s"), *InstanceDirectory); }
        InstanceDirectory.Empty();
        return;
    }
    TickerHandle = FTSTicker::GetCoreTicker().AddTicker(
        FTickerDelegate::CreateRaw(this, &FiXenaUnrealBridgeModule::Tick), 0.1f);
    PublishMetrics();
    WindowCallbackLifetime = MakeShared<bool>(true);
    UToolMenus::RegisterStartupCallback(FSimpleMulticastDelegate::FDelegate::CreateRaw(this,
        &FiXenaUnrealBridgeModule::RegisterMenus));
    if (iXenaBridgeLocale::IsChinese())
    { UE_LOG(LogiXenaUnrealBridge, Display, TEXT("iXenaUnrealBridge 0.6.2 已启动，项目：%s；平台：%s"), *ProjectPath, iXenaBridge::PlatformName()); }
    else
    { UE_LOG(LogiXenaUnrealBridge, Display, TEXT("iXenaUnrealBridge 0.6.2 started; project: %s; platform: %s"), *ProjectPath, iXenaBridge::PlatformName()); }
}

void FiXenaUnrealBridgeModule::ShutdownModule()
{
    if (WindowCallbackLifetime.IsValid()) *WindowCallbackLifetime = false;
    WindowCallbackLifetime.Reset();
    UToolMenus::UnRegisterStartupCallback(this);
    UToolMenus::UnregisterOwner(this);
    if (TSharedPtr<SWindow> Window = ToolWindow.Pin()) Window->RequestDestroyWindow();
    ToolWindow.Reset();
    if (TickerHandle.IsValid())
    {
        FTSTicker::GetCoreTicker().RemoveTicker(TickerHandle);
        TickerHandle.Reset();
    }
    // 只移除自己的在线标志；保留此次实例的编译日志，便于退出后排查。
    if (!InstanceDirectory.IsEmpty())
    {
        IFileManager::Get().Delete(*FPaths::Combine(InstanceDirectory, TEXT("instance.json")), false, false, true);
        IFileManager::Get().Delete(*FPaths::Combine(InstanceDirectory, TEXT("metrics.json")), false, false, true);
    }
}

void FiXenaUnrealBridgeModule::PublishMetrics()
{
    const FPlatformMemoryStats Memory = FPlatformMemory::GetStats();
    const FCPUTime Cpu = FPlatformTime::GetCPUTime();
    const double FrameDeltaMs = FApp::GetDeltaTime() * 1000.0;
    const bool bDebugger = FPlatformMisc::IsDebuggerPresent();
    const TSharedRef<FJsonObject> Metrics = MakeShared<FJsonObject>();
    Metrics->SetNumberField(TEXT("protocol"), iXenaBridge::ProtocolVersion);
    Metrics->SetStringField(TEXT("instanceId"), InstanceId);
    Metrics->SetNumberField(TEXT("processId"), FPlatformProcess::GetCurrentProcessId());
    Metrics->SetStringField(TEXT("updatedAt"), FDateTime::UtcNow().ToIso8601());
    Metrics->SetNumberField(TEXT("processMemoryBytes"), static_cast<double>(Memory.UsedPhysical));
    Metrics->SetNumberField(TEXT("peakProcessMemoryBytes"), static_cast<double>(Memory.PeakUsedPhysical));
    Metrics->SetNumberField(TEXT("availablePhysicalBytes"), static_cast<double>(Memory.AvailablePhysical));
    Metrics->SetBoolField(TEXT("debuggerAttached"), bDebugger);
    if (FMath::IsFinite(FrameDeltaMs) && FrameDeltaMs >= 0.0) Metrics->SetNumberField(TEXT("frameDeltaMs"), FrameDeltaMs);
    const bool bValidCpu = bCpuSamplePrimed && FMath::IsFinite(Cpu.CPUTimePct) && Cpu.CPUTimePct >= 0.0
        && FMath::IsFinite(Cpu.CPUTimePctRelative) && Cpu.CPUTimePctRelative >= 0.0;
    if (bValidCpu)
    {
        Metrics->SetNumberField(TEXT("cpuTimePct"), Cpu.CPUTimePct);
        Metrics->SetNumberField(TEXT("cpuTimePctRelative"), Cpu.CPUTimePctRelative);
    }
    bCpuSamplePrimed = true;
    const FString FrameText = FMath::IsFinite(FrameDeltaMs) && FrameDeltaMs >= 0.0
        ? FString::Printf(TEXT("%.2f ms"), FrameDeltaMs) : FString(iXenaBridgeLocale::Text(TEXT("不可用"), TEXT("Unavailable")));
    const FString CpuText = bValidCpu
        ? (iXenaBridgeLocale::IsChinese()
            ? FString::Printf(TEXT("%.1f%%（整机容量），%.1f%%（单核100%%）"), Cpu.CPUTimePct, Cpu.CPUTimePctRelative)
            : FString::Printf(TEXT("%.1f%% (total capacity), %.1f%% (one core = 100%%)"), Cpu.CPUTimePct, Cpu.CPUTimePctRelative))
        : FString(iXenaBridgeLocale::Text(TEXT("等待采样"), TEXT("Waiting for a sample")));
    CachedMetricsSummary = iXenaBridgeLocale::IsChinese()
        ? FString::Printf(TEXT("进程内存 %.1f MiB · 峰值 %.1f MiB · 系统可用 %.1f GiB\nCPU %s · 帧间隔 %s · 调试器%s"),
            static_cast<double>(Memory.UsedPhysical) / (1024.0 * 1024.0),
            static_cast<double>(Memory.PeakUsedPhysical) / (1024.0 * 1024.0),
            static_cast<double>(Memory.AvailablePhysical) / (1024.0 * 1024.0 * 1024.0),
            *CpuText, *FrameText, bDebugger ? TEXT("已附加") : TEXT("未附加"))
        : FString::Printf(TEXT("Process memory %.1f MiB · peak %.1f MiB · system available %.1f GiB\nCPU %s · frame interval %s · debugger %s"),
            static_cast<double>(Memory.UsedPhysical) / (1024.0 * 1024.0),
            static_cast<double>(Memory.PeakUsedPhysical) / (1024.0 * 1024.0),
            static_cast<double>(Memory.AvailablePhysical) / (1024.0 * 1024.0 * 1024.0),
            *CpuText, *FrameText, bDebugger ? TEXT("attached") : TEXT("not attached"));
    iXenaBridge::PublishJson(FPaths::Combine(InstanceDirectory, TEXT("metrics.json")), Metrics);
}

void FiXenaUnrealBridgeModule::RegisterMenus()
{
    FToolMenuOwnerScoped Owner(this);
    // QtQuickUI already owns the top-level "iXena" entry under MainFrame.MainMenu.
    // Extend its actual submenu instead of registering a second top-level menu in LevelEditor.MainMenu.
    // ExtendMenu is safe if QtQuickUI has not registered its menu yet; the toolbar and Window menu
    // remain independent entry points if this UE installation does not have QtQuickUI.
    UToolMenu* SharediXenaMenu = UToolMenus::Get()->ExtendMenu(TEXT("MainFrame.MainMenu.iXena"));
    PopulateMenu(SharediXenaMenu);

    UToolMenu* WindowMenu = UToolMenus::Get()->ExtendMenu(TEXT("LevelEditor.MainMenu.Window"));
    PopulateMenu(WindowMenu);
    UToolMenu* Toolbar = UToolMenus::Get()->ExtendMenu(TEXT("LevelEditor.LevelEditorToolBar.User"));
    Toolbar->FindOrAddSection(TEXT("iXenaTools")).AddEntry(FToolMenuEntry::InitToolBarButton(
        TEXT("iXenaOpenTools"), FUIAction(FExecuteAction::CreateRaw(this, &FiXenaUnrealBridgeModule::OpenToolWindow)),
        FText::FromString(TEXT("iXena")), TAttribute<FText>::CreateLambda([] { return FText::FromString(iXenaBridgeLocale::Text(TEXT("打开 iXena Unreal 悬浮工具面板。"), TEXT("Open the floating iXena Unreal tools panel."))); }),
        FSlateIcon(FAppStyle::GetAppStyleSetName(), TEXT("LevelEditor.GameSettings"))));
}

void FiXenaUnrealBridgeModule::PopulateMenu(UToolMenu* Menu)
{
    Menu->FindOrAddSection(TEXT("iXenaUnrealBridge")).AddMenuEntry(TEXT("OpeniXenaToolWindow"),
        TAttribute<FText>::CreateLambda([] { return FText::FromString(iXenaBridgeLocale::Text(TEXT("打开工具面板"), TEXT("Open tools panel"))); }), TAttribute<FText>::CreateLambda([] { return FText::FromString(iXenaBridgeLocale::Text(TEXT("打开可悬浮的命令、变量、性能和 Live Coding 工具面板。"), TEXT("Open the floating panel for commands, variables, performance and Live Coding."))); }),
        FSlateIcon(), FUIAction(FExecuteAction::CreateRaw(this, &FiXenaUnrealBridgeModule::OpenToolWindow)));
}

FString FiXenaUnrealBridgeModule::GetWindowStatus() const
{
    bool bAvailable = false, bEnabled = false;
    GetLiveCodingState(bAvailable, bEnabled);
    const TCHAR* Coding = bCompiling ? iXenaBridgeLocale::Text(TEXT("正在编译"), TEXT("compiling")) : !bAvailable ? iXenaBridgeLocale::Text(TEXT("此平台/构建不可用"), TEXT("unavailable on this platform/build")) : !bEnabled ? iXenaBridgeLocale::Text(TEXT("未启用"), TEXT("disabled")) : iXenaBridgeLocale::Text(TEXT("可用"), TEXT("available"));
    return iXenaBridgeLocale::IsChinese()
        ? FString::Printf(TEXT("项目：%s\n通讯：插件已加载 · PID %u · %s · Live Coding %s\n%s"),
            *FPaths::GetBaseFilename(ProjectPath), FPlatformProcess::GetCurrentProcessId(), iXenaBridge::PlatformName(), Coding, *CachedMetricsSummary)
        : FString::Printf(TEXT("Project: %s\nCommunication: plugin loaded · PID %u · %s · Live Coding %s\n%s"),
            *FPaths::GetBaseFilename(ProjectPath), FPlatformProcess::GetCurrentProcessId(), iXenaBridge::PlatformName(), Coding, *CachedMetricsSummary);
}

void FiXenaUnrealBridgeModule::OpenToolWindow()
{
    if (!FSlateApplication::IsInitialized()) return;
    if (TSharedPtr<SWindow> Existing = ToolWindow.Pin())
    {
        Existing->BringToFront(true);
        return;
    }
    const TWeakPtr<bool> Lifetime(WindowCallbackLifetime);
    const TSharedRef<SWindow> Window = SNew(SWindow).Title_Lambda([] { return iXenaBridgeLocale::LocalizedText(TEXT("iXena Unreal 工具"), TEXT("iXena Unreal Tools")); })
        .ClientSize(FVector2D(920.0f, 850.0f)).SupportsMaximize(true).SupportsMinimize(true);
    Window->SetContent(SNew(SiXenaBridgePanel)
        .OnGetStatus(FiXenaWindowGetStatus::CreateLambda([this, Lifetime]()
        {
            const TSharedPtr<bool> Active = Lifetime.Pin();
            return Active.IsValid() && *Active ? GetWindowStatus() : FString(iXenaBridgeLocale::Text(TEXT("通讯模块已关闭。"), TEXT("The communication module is closed.")));
        }))
        .OnExecute(FiXenaWindowExecute::CreateLambda([this, Lifetime](const FString& Command)
        {
            const TSharedPtr<bool> Active = Lifetime.Pin();
            if (!Active.IsValid() || !*Active) return FString(iXenaBridgeLocale::Text(TEXT("通讯模块已关闭。"), TEXT("The communication module is closed.")));
            if (bProcessing || bCompiling) return FString(iXenaBridgeLocale::Text(TEXT("已有编译或通讯操作正在处理，请稍候。"), TEXT("Another build or communication operation is in progress. Please wait.")));
            TGuardValue<bool> Guard(bProcessing, true);
            FString Status, Output, Message;
            RunConsoleCommand(Command, Status, Output, Message);
            return TEXT("> ") + Command + TEXT("\n[") + Status + TEXT("] ") + Message + TEXT("\n") + Output;
        }))
        .OnCompile(FiXenaWindowCompile::CreateLambda([this, Lifetime]()
        {
            const TSharedPtr<bool> Active = Lifetime.Pin();
            if (!Active.IsValid() || !*Active) return FString(iXenaBridgeLocale::Text(TEXT("通讯模块已关闭。"), TEXT("The communication module is closed.")));
            if (bProcessing || bCompiling) return FString(iXenaBridgeLocale::Text(TEXT("已有编译或通讯操作正在处理，请稍候。"), TEXT("Another build or communication operation is in progress. Please wait.")));
            TGuardValue<bool> Guard(bProcessing, true);
            FString Status, Output, Message;
            Compile(FGuid::NewGuid().ToString(EGuidFormats::DigitsWithHyphens).ToLower(), Status, Output, Message);
            return TEXT("[") + Status + TEXT("] ") + Message + TEXT("\n") + Output;
        }))
        .OnCanCompile(FiXenaWindowCanCompile::CreateLambda([this, Lifetime]()
        {
            const TSharedPtr<bool> Active = Lifetime.Pin();
            if (!Active.IsValid() || !*Active || bProcessing || bCompiling) return false;
            bool bAvailable = false, bEnabled = false;
            GetLiveCodingState(bAvailable, bEnabled);
            return bAvailable && bEnabled;
        })));
    ToolWindow = Window;
    FSlateApplication::Get().AddWindow(Window);
}

bool FiXenaUnrealBridgeModule::PublishInstance()
{
    bool bAvailable = false;
    bool bEnabled = false;
    GetLiveCodingState(bAvailable, bEnabled);
    const TSharedRef<FJsonObject> Object = MakeShared<FJsonObject>();
    Object->SetNumberField(TEXT("protocol"), iXenaBridge::ProtocolVersion);
    Object->SetStringField(TEXT("pluginVersion"), TEXT("0.6.2"));
    Object->SetStringField(TEXT("instanceId"), InstanceId);
    Object->SetStringField(TEXT("token"), Token);
    Object->SetNumberField(TEXT("processId"), FPlatformProcess::GetCurrentProcessId());
    Object->SetStringField(TEXT("projectPath"), ProjectPath);
    Object->SetStringField(TEXT("engineRoot"), EngineRoot);
    Object->SetStringField(TEXT("engineVersion"), FEngineVersion::Current().ToString());
    Object->SetStringField(TEXT("platform"), iXenaBridge::PlatformName());
    Object->SetStringField(TEXT("startedAt"), StartedAt);
    Object->SetStringField(TEXT("updatedAt"), FDateTime::UtcNow().ToIso8601());
    Object->SetStringField(TEXT("status"), bCompiling ? TEXT("compiling") : TEXT("ready"));
    Object->SetBoolField(TEXT("liveCodingAvailable"), bAvailable);
    Object->SetBoolField(TEXT("liveCodingEnabled"), bEnabled);
    LastHeartbeat = FPlatformTime::Seconds();
    return iXenaBridge::PublishJson(FPaths::Combine(InstanceDirectory, TEXT("instance.json")), Object);
}

bool FiXenaUnrealBridgeModule::Tick(float DeltaTime)
{
    if (!IsInGameThread() || InstanceDirectory.IsEmpty()) return true;
    iXenaBridgeLocale::RefreshCulture();
    const double Now = FPlatformTime::Seconds();
    if (Now - LastHeartbeat >= 1.0)
    {
        PublishInstance();
        PublishMetrics();
    }
    if (bProcessing) return true;
    TGuardValue<bool> Guard(bProcessing, true);

    // 同时最多领取八个请求，避免异常客户端占满编辑器的一帧。
    TArray<FString> Files;
    IFileManager::Get().FindFiles(Files, *FPaths::Combine(InstanceDirectory, TEXT("Requests/*.json")), true, false);
    Files.Sort();
    const int32 Count = FMath::Min(Files.Num(), 8);
    for (int32 Index = 0; Index < Count; ++Index) ProcessRequest(Files[Index]);

    // 每分钟清理本实例超过一天的已完成消息与日志，不碰其他编辑器的实例。
    if (Now - LastPrune >= 60.0)
    {
        LastPrune = Now;
        const FDateTime Cutoff = FDateTime::UtcNow() - FTimespan::FromDays(1);
        for (const TCHAR* Subdirectory : { TEXT("Responses"), TEXT("Logs") })
        {
            TArray<FString> OldFiles;
            const FString Directory = FPaths::Combine(InstanceDirectory, Subdirectory);
            IFileManager::Get().FindFiles(OldFiles, *FPaths::Combine(Directory, TEXT("*")), true, false);
            for (const FString& File : OldFiles)
            {
                const FString Path = FPaths::Combine(Directory, File);
                if (IFileManager::Get().GetTimeStamp(*Path) < Cutoff)
                    IFileManager::Get().Delete(*Path, false, false, true);
            }
        }
    }
    return true;
}

void FiXenaUnrealBridgeModule::ProcessRequest(const FString& RequestFileName)
{
    const FString RequestId = FPaths::GetBaseFilename(RequestFileName);
    if (!iXenaBridge::IsRequestId(RequestId)) return;
    const FString Original = FPaths::Combine(InstanceDirectory, TEXT("Requests"), RequestFileName);
    const FString Claimed = FPaths::Combine(InstanceDirectory, TEXT("Processing"), RequestFileName);
    // 即使响应已被客户端清理，已领取的 UUID 也不能在重试时重复热更新。
    if (ClaimedRequestIds.Contains(RequestId)
        || IFileManager::Get().FileExists(*FPaths::Combine(InstanceDirectory, TEXT("Responses"), RequestFileName)))
    {
        IFileManager::Get().Delete(*Original, false, false, true);
        return;
    }
    if (!IFileManager::Get().Move(*Claimed, *Original, false, false, false, true)) return;
    ClaimedRequestIds.Add(RequestId);

    const int64 Size = IFileManager::Get().FileSize(*Claimed);
    FString Text;
    TSharedPtr<FJsonObject> Request;
    if (Size < 1 || Size > iXenaBridge::MaxRequestBytes || !FFileHelper::LoadFileToString(Text, *Claimed)
        || !FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Request) || !Request.IsValid())
    {
        IFileManager::Get().Delete(*Claimed, false, false, true);
        Respond(RequestId, false, TEXT("InvalidRequest"), TEXT(""), iXenaBridgeLocale::Text(TEXT("请求不是有效的有界 JSON 对象。"), TEXT("The request is not a valid bounded JSON object.")));
        return;
    }
    IFileManager::Get().Delete(*Claimed, false, false, true);

    double Protocol = 0;
    FString Id, RequestedInstance, RequestedToken, Command, CreatedAt;
    if (!Request->TryGetNumberField(TEXT("protocol"), Protocol) || Protocol != iXenaBridge::ProtocolVersion
        || !Request->TryGetStringField(TEXT("id"), Id) || Id != RequestId
        || !Request->TryGetStringField(TEXT("instanceId"), RequestedInstance) || RequestedInstance != InstanceId
        || !Request->TryGetStringField(TEXT("token"), RequestedToken) || RequestedToken != Token
        || !Request->TryGetStringField(TEXT("command"), Command)
        || !Request->TryGetStringField(TEXT("createdAt"), CreatedAt))
    {
        Respond(RequestId, false, TEXT("InvalidRequest"), TEXT(""), iXenaBridgeLocale::Text(TEXT("协议、请求编号或编辑器实例身份不匹配。"), TEXT("The protocol, request ID or Editor instance identity does not match.")));
        return;
    }
    FDateTime RequestTime;
    if (!FDateTime::ParseIso8601(*CreatedAt, RequestTime))
    {
        Respond(RequestId, false, TEXT("InvalidRequest"), TEXT(""), iXenaBridgeLocale::Text(TEXT("createdAt 必须是 UTC ISO8601 时间。"), TEXT("createdAt must be an ISO8601 UTC timestamp.")));
        return;
    }
    const double AgeSeconds = (FDateTime::UtcNow() - RequestTime).GetTotalSeconds();
    if (AgeSeconds > 60.0 || AgeSeconds < -30.0)
    {
        Respond(RequestId, false, TEXT("Expired"), TEXT(""), iXenaBridgeLocale::Text(TEXT("请求已过期或本机时间不一致；没有执行编译。"), TEXT("The request expired or the system clock differs. Compilation was not started.")));
        return;
    }
    if (Command == TEXT("ping"))
    {
        Respond(RequestId, true, TEXT("Ready"), TEXT(""), iXenaBridgeLocale::Text(TEXT("编辑器通讯正常，当前编译状态见 instance.json。"), TEXT("Editor communication is ready. See instance.json for current build status.")));
        return;
    }
    if (Command == TEXT("listConsole") || Command == TEXT("executeConsole"))
    {
        const TSharedPtr<FJsonObject>* Parameters = nullptr;
        if (!Request->TryGetObjectField(TEXT("parameters"), Parameters) || !Parameters || !Parameters->IsValid())
        {
            Respond(RequestId, false, TEXT("InvalidRequest"), TEXT(""), iXenaBridgeLocale::Text(TEXT("控制台请求必须提供 parameters 对象。"), TEXT("Console requests require a parameters object.")));
            return;
        }
        if (Command == TEXT("listConsole")) ListConsole(RequestId, *Parameters);
        else ExecuteConsole(RequestId, *Parameters);
        return;
    }
    if (Command != TEXT("compile"))
    {
        Respond(RequestId, false, TEXT("InvalidRequest"), TEXT(""), iXenaBridgeLocale::Text(TEXT("仅支持 ping、compile、listConsole 和 executeConsole。"), TEXT("Only ping, compile, listConsole and executeConsole are supported.")));
        return;
    }

    FString Status, Output, Message;
    Compile(RequestId, Status, Output, Message);
    Respond(RequestId, Status == TEXT("Success") || Status == TEXT("NoChanges"), Status, Output, Message);
}

void FiXenaUnrealBridgeModule::ListConsole(const FString& RequestId, const TSharedPtr<FJsonObject>& Parameters)
{
    FString Filter;
    FString RequestedLanguage(TEXT("en"));
    double CursorNumber = 0.0;
    double LimitNumber = 100.0;
    if ((Parameters->HasField(TEXT("locale")) && !Parameters->TryGetStringField(TEXT("locale"), RequestedLanguage))
        || (RequestedLanguage != TEXT("en") && RequestedLanguage != TEXT("zh-CN"))
        || (Parameters->HasField(TEXT("filter")) && !Parameters->TryGetStringField(TEXT("filter"), Filter))
        || (Parameters->HasField(TEXT("cursor")) && !Parameters->TryGetNumberField(TEXT("cursor"), CursorNumber))
        || (Parameters->HasField(TEXT("limit")) && !Parameters->TryGetNumberField(TEXT("limit"), LimitNumber))
        || Filter.Len() > 256 || iXenaBridge::ContainsForbiddenCommandCharacter(Filter)
        || !FMath::IsFinite(CursorNumber) || CursorNumber < 0 || CursorNumber > 50000
        || CursorNumber != static_cast<int32>(CursorNumber)
        || !FMath::IsFinite(LimitNumber) || LimitNumber < 1 || LimitNumber > 100
        || LimitNumber != static_cast<int32>(LimitNumber))
    {
        Respond(RequestId, false, TEXT("InvalidRequest"), TEXT(""), iXenaBridgeLocale::Text(TEXT("控制台查询要求 filter 最多 256 字符，cursor 为非负整数，limit 为 1–100。"), TEXT("Console queries require filter up to 256 characters, a non-negative integer cursor, and limit from 1 to 100.")));
        return;
    }
    const double Now = FPlatformTime::Seconds();
    if (Now - LastConsoleScan >= 2.0)
    {
        ConsoleNames.Reset();
        IConsoleManager::Get().ForEachConsoleObjectThatStartsWith(FConsoleObjectVisitor::CreateLambda(
            [this](const TCHAR* Name, IConsoleObject* Object)
            {
                if (Name && Object && !Object->TestFlags(ECVF_Unregistered) && ConsoleNames.Num() < 50000)
                {
                    ConsoleNames.Add(Name);
                }
            }), TEXT(""));
        ConsoleNames.Sort();
        LastConsoleScan = Now;
    }

    TArray<FString> Matches;
    for (const FString& Name : ConsoleNames)
    {
        if (Name.Len() > 512) continue;
        if (Filter.IsEmpty() || Name.Contains(Filter, ESearchCase::IgnoreCase)) { Matches.Add(Name); continue; }
        // Chinese summaries are searchable only when explicitly requested by this client.
        // Names/parameters remain untouched; other clients keep native search behavior.
        if (RequestedLanguage == TEXT("zh-CN"))
        {
            IConsoleObject* Object = IConsoleManager::Get().FindConsoleObject(*Name);
            if (Object && iXenaBridgeConsoleHelp::Matches(Name,
                FString(Object->GetHelp() ? Object->GetHelp() : TEXT("")), Filter, true)) Matches.Add(Name);
        }
    }
    const int32 Cursor = static_cast<int32>(CursorNumber);
    const int32 End = FMath::Min(Matches.Num(), Cursor + static_cast<int32>(LimitNumber));
    TArray<TSharedPtr<FJsonValue>> Items;
    for (int32 Index = Cursor; Index < End; ++Index)
    {
        IConsoleObject* Object = IConsoleManager::Get().FindConsoleObject(*Matches[Index]);
        if (!Object || Object->TestFlags(ECVF_Unregistered)) continue;
        const TSharedRef<FJsonObject> Item = MakeShared<FJsonObject>();
        Item->SetStringField(TEXT("name"), Matches[Index]);
        // Keep the native UE help intact on the wire. UI clients localize a short summary,
        // not the original parameter/flag semantics (which can differ by engine version).
        Item->SetStringField(TEXT("help"), FString(Object->GetHelp() ? Object->GetHelp() : TEXT("")).Left(2048));
        Item->SetNumberField(TEXT("flags"), static_cast<uint32>(Object->GetFlags()));
        if (IConsoleVariable* Variable = Object->AsVariable())
        {
            Item->SetStringField(TEXT("type"), TEXT("variable"));
            Item->SetStringField(TEXT("value"), Variable->GetString().Left(4096));
        }
        else Item->SetStringField(TEXT("type"), TEXT("command"));
        Items.Add(MakeShared<FJsonValueObject>(Item));
    }
    const TSharedRef<FJsonObject> Data = MakeShared<FJsonObject>();
    Data->SetArrayField(TEXT("items"), Items);
    Data->SetNumberField(TEXT("total"), Matches.Num());
    if (End < Matches.Num()) Data->SetNumberField(TEXT("nextCursor"), End);
    Respond(RequestId, true, TEXT("ConsoleList"), TEXT(""),
        iXenaBridgeLocale::Text(TEXT("这是当前编辑器注册的命令/CVar；部分 stat/show 等 Exec 命令不会出现在注册表中。"), TEXT("These are commands/CVars registered in the current Editor. Some Exec commands such as stat/show do not appear in the registry.")), Data);
}

void FiXenaUnrealBridgeModule::ExecuteConsole(const FString& RequestId, const TSharedPtr<FJsonObject>& Parameters)
{
    FString Command;
    if (!Parameters->TryGetStringField(TEXT("command"), Command))
    {
        Respond(RequestId, false, TEXT("InvalidRequest"), TEXT(""), iXenaBridgeLocale::Text(TEXT("parameters.command 必须为字符串。"), TEXT("parameters.command must be a string.")));
        return;
    }
    FString Status, Output, Message;
    const bool bHandled = RunConsoleCommand(Command, Status, Output, Message);
    Respond(RequestId, bHandled, Status, Output, Message);
}

bool FiXenaUnrealBridgeModule::RunConsoleCommand(const FString& InputCommand, FString& OutStatus,
    FString& OutOutput, FString& OutMessage)
{
    OutOutput.Empty();
    FString Command = InputCommand;
    if (Command.IsEmpty() || Command.Len() > 4096 || iXenaBridge::ContainsForbiddenCommandCharacter(Command))
    {
        OutStatus = TEXT("InvalidRequest");
        OutMessage = iXenaBridgeLocale::Text(TEXT("控制台命令必须是最多 4096 字符的单行，且不能包含 NUL、换行、分号或竖线。"), TEXT("A console command must be a single line of up to 4096 characters, without NUL, line breaks, semicolons or pipes."));
        return false;
    }
    Command.TrimStartAndEndInline();
    if (Command.IsEmpty())
    {
        OutStatus = TEXT("InvalidRequest"); OutMessage = iXenaBridgeLocale::Text(TEXT("控制台命令不能为空。"), TEXT("The console command cannot be empty."));
        return false;
    }
    if (!GEditor)
    {
        OutStatus = TEXT("NotAvailable"); OutMessage = iXenaBridgeLocale::Text(TEXT("编辑器对象尚未就绪。"), TEXT("The Editor object is not ready."));
        return false;
    }

    iXenaBridge::FConsoleReply Capture;
    UWorld* World = GEditor->GetEditorWorldContext().World();
    // 注册的命令和 CVar 走 ConsoleManager；stat/show 等 Exec 命令再交给编辑器。
    bool bHandled = IConsoleManager::Get().ProcessUserConsoleInput(*Command, Capture, World);
    if (!bHandled) bHandled = GEditor->Exec(World, *Command, Capture);
    IConsoleManager::Get().CallAllConsoleVariableSinks();
    OutStatus = bHandled ? TEXT("Executed") : TEXT("NotHandled");
    OutOutput = Capture.Output;
    OutMessage = bHandled ? iXenaBridgeLocale::Text(TEXT("UE 已识别并处理该控制台输入；这不代表命令触发的异步任务已经完成。"), TEXT("UE recognized and handled this console input. Any asynchronous work it triggered may still be running."))
        : iXenaBridgeLocale::Text(TEXT("UE 未识别该控制台输入，或当前编辑器/世界上下文不支持此命令。"), TEXT("UE did not recognize this console input, or it is unavailable in the current Editor/world context."));
    return bHandled;
}

void FiXenaUnrealBridgeModule::GetLiveCodingState(bool& bOutAvailable, bool& bOutEnabled) const
{
    bOutAvailable = false;
    bOutEnabled = false;
#if WITH_LIVE_CODING && PLATFORM_WINDOWS
    ILiveCodingModule* LiveCoding = FModuleManager::GetModulePtr<ILiveCodingModule>(TEXT("LiveCoding"));
    bOutAvailable = LiveCoding != nullptr;
    bOutEnabled = LiveCoding && LiveCoding->IsEnabledForSession();
#endif
}

void FiXenaUnrealBridgeModule::Compile(const FString& RequestId, FString& OutStatus, FString& OutOutput, FString& OutMessage)
{
    iXenaBridge::FCompileOutput Capture(FPaths::Combine(InstanceDirectory, TEXT("Logs"), RequestId + TEXT(".log")));
#if WITH_LIVE_CODING && PLATFORM_WINDOWS
    ILiveCodingModule* LiveCoding = FModuleManager::GetModulePtr<ILiveCodingModule>(TEXT("LiveCoding"));
    if (!LiveCoding)
    {
        OutStatus = TEXT("NotAvailable");
        OutMessage = iXenaBridgeLocale::Text(TEXT("当前编辑器未加载 LiveCoding 模块。请检查本机引擎构建是否支持 Live Coding。 "), TEXT("The Editor has not loaded the LiveCoding module. Check whether this engine build supports Live Coding."));
    }
    else if (!LiveCoding->IsEnabledForSession())
    {
        OutStatus = TEXT("NotEnabled");
        OutMessage = iXenaBridgeLocale::Text(TEXT("请在 UE Editor Preferences > General > Live Coding 启用 Live Coding，并按编辑器提示重启。 "), TEXT("Enable Live Coding in UE Editor Preferences > General > Live Coding and restart if requested."));
    }
    else if (LiveCoding->IsCompiling() || bCompiling)
    {
        OutStatus = TEXT("CompileStillActive");
        OutMessage = iXenaBridgeLocale::Text(TEXT("UE 已有 Live Coding 编译正在进行；本次请求没有再次启动编译。 "), TEXT("A UE Live Coding build is already in progress. This request did not start another build."));
    }
    else
    {
        bCompiling = true;
        PublishInstance();
        Capture.Append(iXenaBridgeLocale::Text(TEXT("[iXenaUnrealBridge] 已接收请求，正在调用 UE Live Coding；编译日志按收到的顺序同步。\n"), TEXT("[iXenaUnrealBridge] Request accepted. Calling UE Live Coding; received build output is forwarded in order.\n")));
        {
            iXenaBridge::FScopedOutputRegistration Registration(Capture);
            // 返回值只表示能否启动；必须等待并读取 Result，不能把“请求已发出”当作编译成功。
            iXenaBridge::CompileAndWait(LiveCoding, OutStatus, OutMessage, 0);
        }
        bCompiling = false;
        PublishInstance();
        OutMessage += (OutStatus == TEXT("Success") || OutStatus == TEXT("NoChanges"))
            ? iXenaBridgeLocale::Text(TEXT(" UE Live Coding 已返回最终结果。"), TEXT(" UE Live Coding returned its final result."))
            : iXenaBridgeLocale::Text(TEXT(" UE Live Coding 未成功完成，请查看同步日志和 UE Live Coding Console。 "), TEXT(" UE Live Coding did not complete successfully. Check the received output and the UE Live Coding Console."));
    }
#else
    OutStatus = TEXT("NotAvailable");
    OutMessage = iXenaBridgeLocale::Text(TEXT("通讯插件工作正常，但当前平台/引擎构建不提供 Windows Live Coding。macOS/Linux 请关闭 UE 编辑器后使用标准 UBT 构建。 "), TEXT("Communication is ready, but this platform/engine build does not provide Windows Live Coding. On macOS/Linux, close the Editor and use a full UBT build."));
#endif
    Capture.Append(FString::Printf(TEXT("[iXenaUnrealBridge] Result: %s\n%s\n"), *OutStatus, *OutMessage));
    OutOutput = Capture.GetText();
}

void FiXenaUnrealBridgeModule::Respond(const FString& RequestId, bool bOk, const FString& Status,
    const FString& Output, const FString& Message, const TSharedPtr<FJsonObject>& Data) const
{
    const TSharedRef<FJsonObject> Response = MakeShared<FJsonObject>();
    Response->SetNumberField(TEXT("protocol"), iXenaBridge::ProtocolVersion);
    Response->SetStringField(TEXT("id"), RequestId);
    Response->SetStringField(TEXT("instanceId"), InstanceId);
    Response->SetBoolField(TEXT("ok"), bOk);
    Response->SetStringField(TEXT("status"), Status);
    Response->SetStringField(TEXT("output"), Output);
    Response->SetStringField(TEXT("message"), Message);
    Response->SetStringField(TEXT("completedAt"), FDateTime::UtcNow().ToIso8601());
    if (Data.IsValid()) Response->SetObjectField(TEXT("data"), Data);
    if (!iXenaBridge::PublishJson(FPaths::Combine(InstanceDirectory, TEXT("Responses"), RequestId + TEXT(".json")), Response))
    {
        if (iXenaBridgeLocale::IsChinese())
        { UE_LOG(LogiXenaUnrealBridge, Error, TEXT("无法保存请求 %s 的结果；请检查 Saved 目录的可写权限。"), *RequestId); }
        else
        { UE_LOG(LogiXenaUnrealBridge, Error, TEXT("Cannot save the result of request %s; check write access to the Saved directory."), *RequestId); }
    }
}

IMPLEMENT_MODULE(FiXenaUnrealBridgeModule, iXenaUnrealBridge)
