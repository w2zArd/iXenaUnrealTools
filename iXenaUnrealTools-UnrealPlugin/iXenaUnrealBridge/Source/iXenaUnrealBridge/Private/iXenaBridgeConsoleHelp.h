#pragma once

#include "CoreMinimal.h"

/** Optional bilingual summaries. Never replaces UE's authoritative console help. */
namespace iXenaBridgeConsoleHelp
{
    FString Localize(const FString& Name, const FString& Original, bool bChinese);
    bool Matches(const FString& Name, const FString& Original, const FString& Query, bool bChinese);
}
