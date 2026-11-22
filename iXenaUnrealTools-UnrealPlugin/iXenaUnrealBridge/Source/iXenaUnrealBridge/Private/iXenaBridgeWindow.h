#pragma once

#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/Views/SListView.h"

class SEditableTextBox;
class SMultiLineEditableTextBox;

/** 原生工具窗口中的一条已注册命令/变量；不缓存引擎对象指针。 */
struct FiXenaConsoleItem
{
    FString Name;
    FString Help;
    FString Value;
    bool bVariable = false;
};

DECLARE_DELEGATE_RetVal(FString, FiXenaWindowGetStatus);
DECLARE_DELEGATE_RetVal_OneParam(FString, FiXenaWindowExecute, const FString&);
DECLARE_DELEGATE_RetVal(FString, FiXenaWindowCompile);
DECLARE_DELEGATE_RetVal(bool, FiXenaWindowCanCompile);

/**
 * UE 编辑器内的 Slate 工具面板：搜索命令/CVar、查看帮助和值、单行执行及 Live Coding。
 * 所有操作发生在编辑器游戏线程，命令由模块提供的共用执行路径处理。
 * 列表最多展示 200 个匹配项，避免一次生成数万条 Slate 行。
 */
class SiXenaBridgePanel final : public SCompoundWidget
{
public:
    SLATE_BEGIN_ARGS(SiXenaBridgePanel) {}
        SLATE_EVENT(FiXenaWindowGetStatus, OnGetStatus)
        SLATE_EVENT(FiXenaWindowExecute, OnExecute)
        SLATE_EVENT(FiXenaWindowCompile, OnCompile)
        SLATE_EVENT(FiXenaWindowCanCompile, OnCanCompile)
    SLATE_END_ARGS()

    void Construct(const FArguments& InArgs);

private:
    using FItem = TSharedPtr<FiXenaConsoleItem>;
    void RefreshItems();
    void SearchChanged(const FText& Text);
    void CommandCommitted(const FText& Text, ETextCommit::Type CommitType);
    void SelectionChanged(FItem Item, ESelectInfo::Type SelectInfo);
    TSharedRef<ITableRow> GenerateRow(FItem Item, const TSharedRef<STableViewBase>& Owner);
    FReply ExecuteClicked();
    FReply CompileClicked();
    FReply RefreshClicked();
    FReply CopyOutputClicked();
    FReply RunPreset(FString Command);
    FText StatusText() const;
    FText DetailsText() const;
    FText CountText() const;
    FText LanguageText() const;
    TSharedRef<SWidget> GenerateLanguageOption(TSharedPtr<FString> Item);
    void LanguageChanged(TSharedPtr<FString> Item, ESelectInfo::Type SelectInfo);
    bool CanCompile() const;
    void SetOutput(const FString& Text);

    FiXenaWindowGetStatus GetStatus;
    FiXenaWindowExecute Execute;
    FiXenaWindowCompile Compile;
    FiXenaWindowCanCompile CompileAvailable;
    TArray<FItem> Items;
    TSharedPtr<SListView<FItem>> ListView;
    TSharedPtr<SEditableTextBox> CommandBox;
    TSharedPtr<SMultiLineEditableTextBox> OutputBox;
    FItem Selected;
    FString Filter;
    FString LastOutput;
    int32 TotalMatches = 0;
    bool bExecuting = false;
    TArray<TSharedPtr<FString>> Languages;
};
