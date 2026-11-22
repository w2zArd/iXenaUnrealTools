#include "iXenaBridgeConsoleHelp.h"
#include "iXenaBridgeLocalization.h"

#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Interfaces/IPluginManager.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

namespace iXenaBridgeConsoleHelp
{
    namespace
    {
        struct FCatalog
        {
            TMap<FString, FString> Exact;
            TArray<TPair<FString, FString>> Prefixes;
        };

        const FCatalog& GetCatalog()
        {
            // Static source data is read only on first use, and only on the Editor/UI thread.
            static const FCatalog Catalog = []
            {
                FCatalog Result;
                const TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("iXenaUnrealBridge"));
                if (!Plugin.IsValid()) return Result;
                const FString File = FPaths::Combine(Plugin->GetBaseDir(), TEXT("Resources/ConsoleHelp.zh-CN.json"));
                FString Contents;
                if (!FFileHelper::LoadFileToString(Contents, *File)) return Result;
                TSharedPtr<FJsonObject> Document;
                if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Contents), Document) || !Document.IsValid()) return Result;
                const TSharedPtr<FJsonObject>* Exact = nullptr;
                if (Document->TryGetObjectField(TEXT("exact"), Exact) && Exact && Exact->IsValid())
                {
                    for (const auto& Pair : (*Exact)->Values)
                    {
                        FString Value;
                        if (Pair.Value.IsValid() && Pair.Value->TryGetString(Value)) Result.Exact.Add(FString(*Pair.Key).ToLower(), Value);
                    }
                }
                const TSharedPtr<FJsonObject>* Prefixes = nullptr;
                if (Document->TryGetObjectField(TEXT("prefixes"), Prefixes) && Prefixes && Prefixes->IsValid())
                {
                    for (const auto& Pair : (*Prefixes)->Values)
                    {
                        FString Value;
                        if (Pair.Value.IsValid() && Pair.Value->TryGetString(Value)) Result.Prefixes.Emplace(FString(*Pair.Key).ToLower(), Value);
                    }
                    Result.Prefixes.Sort([](const TPair<FString, FString>& A, const TPair<FString, FString>& B)
                    { return A.Key.Len() > B.Key.Len(); });
                }
                return Result;
            }();
            return Catalog;
        }
    }

    FString Localize(const FString& Name, const FString& Original, bool bChinese)
    {
        if (!bChinese) return Original;
        const FCatalog& Catalog = GetCatalog();
        const FString Key = Name.ToLower();
        FString Description;
        if (const FString* Exact = Catalog.Exact.Find(Key)) Description = *Exact;
        else
        {
            for (const auto& Entry : Catalog.Prefixes)
            {
                if (Key.StartsWith(Entry.Key))
                {
                    Description = FString::Printf(TEXT("分类：%s。具体用途、参数及有效值请参考 UE 原始说明。"), *Entry.Value);
                    break;
                }
            }
        }
        if (Description.IsEmpty()) return Original;
        return Original.TrimStartAndEnd().IsEmpty() ? Description : Description + TEXT("\n\nUE 原始帮助：\n") + Original;
    }

    bool Matches(const FString& Name, const FString& Original, const FString& Query, bool bChinese)
    {
        return Query.IsEmpty() || Name.Contains(Query, ESearchCase::IgnoreCase)
            || Localize(Name, Original, bChinese).Contains(Query, ESearchCase::IgnoreCase);
    }
}
