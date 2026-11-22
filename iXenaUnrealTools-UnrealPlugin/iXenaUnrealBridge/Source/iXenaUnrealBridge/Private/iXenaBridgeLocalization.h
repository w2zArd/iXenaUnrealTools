#pragma once

#include "CoreMinimal.h"

/**
 * 插件自己的界面语言。auto 跟随 UE 编辑器语言；不修改引擎的全局 Culture。
 * 选择保存在当前项目的 EditorPerProjectUserSettings，语言表不依赖外部 locres。
 */
namespace iXenaBridgeLocale
{
    void Initialize();
    void RefreshCulture();
    void SetLanguage(const FString& Language);
    FString GetLanguage();
    bool IsChinese();
    const TCHAR* Text(const TCHAR* Chinese, const TCHAR* English);
    FText LocalizedText(const TCHAR* Chinese, const TCHAR* English);
}
