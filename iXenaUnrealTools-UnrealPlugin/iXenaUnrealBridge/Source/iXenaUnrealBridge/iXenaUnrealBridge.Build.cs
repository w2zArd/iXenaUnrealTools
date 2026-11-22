using UnrealBuildTool;

public class iXenaUnrealBridge : ModuleRules
{
    public iXenaUnrealBridge(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
        PrivateDependencyModuleNames.AddRange(new[] {
            "Core", "CoreUObject", "Engine", "UnrealEd", "Json", "Projects",
            "Slate", "SlateCore", "ToolMenus", "InputCore", "ApplicationCore"
        });
        // 编辑器插件使用 Development Editor 生成优化后的 DLL，不构建 Shipping 游戏模块。
        OptimizeCode = CodeOptimization.InNonDebugBuilds;
        PrecompileForTargets = PrecompileTargetsType.Any;
        if (Target.Platform == UnrealTargetPlatform.Win64 && Target.bWithLiveCoding)
        {
            PrivateDependencyModuleNames.Add("LiveCoding");
        }
    }
}
