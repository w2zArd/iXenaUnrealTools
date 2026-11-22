#include "iXenaBridgeLocalization.h"

#include "Internationalization/Culture.h"
#include "Internationalization/Internationalization.h"
#include "Misc/ConfigCacheIni.h"

#include <atomic>

namespace iXenaBridgeLocale
{
    namespace
    {
        FString SelectedLanguage(TEXT("auto"));
        // 日志接收器可在其他线程读取，Culture 查询及配置修改仍限制在编辑器线程。
        std::atomic<bool> Chinese{false};
        constexpr const TCHAR* Section = TEXT("iXenaUnrealBridge");
    }

    void Initialize()
    {
        FString Saved;
        if (GConfig && GConfig->GetString(Section, TEXT("Language"), Saved, GEditorPerProjectIni)
            && (Saved == TEXT("zh-CN") || Saved == TEXT("en")))
        {
            SelectedLanguage = Saved;
        }
        else SelectedLanguage = TEXT("auto");
        RefreshCulture();
    }

    void RefreshCulture()
    {
        const bool bUseChinese = SelectedLanguage == TEXT("zh-CN")
            || (SelectedLanguage == TEXT("auto")
                && FInternationalization::Get().GetCurrentLanguage()->GetName().StartsWith(TEXT("zh"), ESearchCase::IgnoreCase));
        Chinese.store(bUseChinese, std::memory_order_relaxed);
    }

    void SetLanguage(const FString& Language)
    {
        SelectedLanguage = Language == TEXT("zh-CN") || Language == TEXT("en") ? Language : TEXT("auto");
        RefreshCulture();
        if (GConfig && !GEditorPerProjectIni.IsEmpty())
        {
            GConfig->SetString(Section, TEXT("Language"), *SelectedLanguage, GEditorPerProjectIni);
            GConfig->Flush(false, GEditorPerProjectIni);
        }
    }

    FString GetLanguage() { return SelectedLanguage; }
    bool IsChinese() { return Chinese.load(std::memory_order_relaxed); }
    const TCHAR* Text(const TCHAR* Zh, const TCHAR* En) { return IsChinese() ? Zh : En; }
    FText LocalizedText(const TCHAR* Zh, const TCHAR* En) { return FText::FromString(Text(Zh, En)); }
}
