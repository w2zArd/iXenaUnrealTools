#include "iXenaBridgeWindow.h"
#include "iXenaBridgeLocalization.h"
#include "iXenaBridgeConsoleHelp.h"

#include "HAL/IConsoleManager.h"
#include "HAL/PlatformApplicationMisc.h"
#include "Misc/MessageDialog.h"
#include "Styling/CoreStyle.h"
#include "Templates/UnrealTemplate.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SComboBox.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Input/SMultiLineEditableTextBox.h"
#include "Widgets/Input/SSearchBox.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Views/STableRow.h"

void SiXenaBridgePanel::Construct(const FArguments& InArgs)
{
    GetStatus = InArgs._OnGetStatus;
    Execute = InArgs._OnExecute;
    Compile = InArgs._OnCompile;
    CompileAvailable = InArgs._OnCanCompile;
    Languages = { MakeShared<FString>(TEXT("auto")), MakeShared<FString>(TEXT("zh-CN")), MakeShared<FString>(TEXT("en")) };
    TSharedPtr<FString> SelectedLanguage = Languages[0];
    for (const TSharedPtr<FString>& Language : Languages)
    {
        if (*Language == iXenaBridgeLocale::GetLanguage()) SelectedLanguage = Language;
    }

    ChildSlot
    [
        SNew(SBorder).Padding(14)
        [
            SNew(SVerticalBox)
            + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 6)
            [ SNew(STextBlock).Text_Lambda([] { return FText::FromString(iXenaBridgeLocale::Text(TEXT("iXena Unreal 工具"), TEXT("iXena Unreal Tools"))); })
                .Font(FCoreStyle::GetDefaultFontStyle(TEXT("Bold"), 18)) ]
            + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 8)
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0, 0, 8, 0)
                [ SNew(STextBlock).Text_Lambda([] { return iXenaBridgeLocale::LocalizedText(TEXT("界面语言"), TEXT("Interface language")); }) ]
                + SHorizontalBox::Slot().AutoWidth()
                [ SNew(SComboBox<TSharedPtr<FString>>).OptionsSource(&Languages).InitiallySelectedItem(SelectedLanguage)
                    .OnGenerateWidget(this, &SiXenaBridgePanel::GenerateLanguageOption)
                    .OnSelectionChanged(this, &SiXenaBridgePanel::LanguageChanged)
                    [ SNew(STextBlock).Text(this, &SiXenaBridgePanel::LanguageText) ] ]
            ]
            + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 10)
            [ SNew(STextBlock).Text(this, &SiXenaBridgePanel::StatusText).AutoWrapText(true) ]
            + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 8)
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().AutoWidth().Padding(0, 0, 8, 0)
                [ SNew(SButton).Text_Lambda([] { return FText::FromString(iXenaBridgeLocale::Text(TEXT("Live Coding 热更新"), TEXT("Live Coding"))); })
                    .ToolTipText_Lambda([] { return FText::FromString(iXenaBridgeLocale::Text(TEXT("调用 UE 原生 Live Coding 并显示实际结果。仅支持此引擎启用的 Windows Live Coding。"), TEXT("Run native UE Live Coding and display its actual result. Requires supported and enabled Windows Live Coding."))); })
                    .IsEnabled(this, &SiXenaBridgePanel::CanCompile).OnClicked(this, &SiXenaBridgePanel::CompileClicked) ]
                + SHorizontalBox::Slot().AutoWidth()
                [ SNew(SButton).Text_Lambda([] { return FText::FromString(iXenaBridgeLocale::Text(TEXT("刷新命令 / 变量"), TEXT("Refresh commands / variables"))); })
                    .OnClicked(this, &SiXenaBridgePanel::RefreshClicked) ]
            ]
            + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 6)
            [ SNew(SSearchBox).HintText_Lambda([] { return FText::FromString(iXenaBridgeLocale::Text(TEXT("搜索当前引擎已注册的命令或 CVar 名称，例如 r.Shadow、t.MaxFPS"), TEXT("Search registered commands or CVar names, such as r.Shadow or t.MaxFPS"))); })
                .OnTextChanged(this, &SiXenaBridgePanel::SearchChanged) ]
            + SVerticalBox::Slot().FillHeight(0.45f).Padding(0, 0, 0, 4)
            [ SAssignNew(ListView, SListView<FItem>).ListItemsSource(&Items)
                .SelectionMode(ESelectionMode::Single)
                .OnGenerateRow(this, &SiXenaBridgePanel::GenerateRow)
                .OnSelectionChanged(this, &SiXenaBridgePanel::SelectionChanged) ]
            + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 6)
            [ SNew(STextBlock).Text(this, &SiXenaBridgePanel::CountText) ]
            + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 8)
            [ SNew(SBox).HeightOverride(105)
                [ SNew(SScrollBox) + SScrollBox::Slot()
                    [ SNew(STextBlock).Text(this, &SiXenaBridgePanel::DetailsText).AutoWrapText(true) ] ] ]
            + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 6)
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().AutoWidth().Padding(0, 0, 6, 0)
                [ SNew(SButton).Text(FText::FromString(TEXT("stat fps"))).OnClicked(this, &SiXenaBridgePanel::RunPreset, FString(TEXT("stat fps"))) ]
                + SHorizontalBox::Slot().AutoWidth().Padding(0, 0, 6, 0)
                [ SNew(SButton).Text(FText::FromString(TEXT("stat unit"))).OnClicked(this, &SiXenaBridgePanel::RunPreset, FString(TEXT("stat unit"))) ]
                + SHorizontalBox::Slot().AutoWidth()
                [ SNew(SButton).Text(FText::FromString(TEXT("show collision"))).OnClicked(this, &SiXenaBridgePanel::RunPreset, FString(TEXT("show collision"))) ]
            ]
            + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 8)
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().FillWidth(1.0f).Padding(0, 0, 8, 0)
                [ SAssignNew(CommandBox, SEditableTextBox)
                    .HintText_Lambda([] { return FText::FromString(iXenaBridgeLocale::Text(TEXT("输入单行控制台命令，或输入 CVar 名称和值；回车执行"), TEXT("Enter one console command or a CVar name and value; press Enter to execute"))); })
                    .OnTextCommitted(this, &SiXenaBridgePanel::CommandCommitted) ]
                + SHorizontalBox::Slot().AutoWidth()
                [ SNew(SButton).Text_Lambda([] { return FText::FromString(iXenaBridgeLocale::Text(TEXT("执行"), TEXT("Execute"))); })
                    .ToolTipText_Lambda([] { return FText::FromString(iXenaBridgeLocale::Text(TEXT("发送当前输入。这里只表示 UE 识别并处理命令，不代表异步任务完成。"), TEXT("Send the current input. Acceptance means UE handled it, not that any asynchronous work has finished."))); })
                    .OnClicked(this, &SiXenaBridgePanel::ExecuteClicked) ]
            ]
            + SVerticalBox::Slot().AutoHeight().Padding(0, 0, 0, 4)
            [
                SNew(SHorizontalBox)
                + SHorizontalBox::Slot().FillWidth(1.0f).VAlign(VAlign_Center)
                [ SNew(STextBlock).Text_Lambda([] { return FText::FromString(iXenaBridgeLocale::Text(TEXT("本次结果（可选择并复制）"), TEXT("Result (selectable and copyable)"))); }) ]
                + SHorizontalBox::Slot().AutoWidth()
                [ SNew(SButton).Text_Lambda([] { return FText::FromString(iXenaBridgeLocale::Text(TEXT("复制结果"), TEXT("Copy result"))); }).OnClicked(this, &SiXenaBridgePanel::CopyOutputClicked) ]
            ]
            + SVerticalBox::Slot().FillHeight(0.35f)
            [ SAssignNew(OutputBox, SMultiLineEditableTextBox).IsReadOnly(true).AutoWrapText(true) ]
        ]
    ];
    RefreshItems();
    SetOutput(iXenaBridgeLocale::Text(TEXT("通讯插件已加载。选择命令可查看帮助；执行使用当前 Editor 世界上下文。"), TEXT("Bridge loaded. Select a command to view help; execution uses the current Editor world context.")));
}

void SiXenaBridgePanel::RefreshItems()
{
    TArray<FString> Names;
    IConsoleManager::Get().ForEachConsoleObjectThatStartsWith(FConsoleObjectVisitor::CreateLambda(
        [this, &Names](const TCHAR* Name, IConsoleObject* Object)
        {
            if (Name && Object && !Object->TestFlags(ECVF_Unregistered)
                && (Filter.IsEmpty() || iXenaBridgeConsoleHelp::Matches(FString(Name),
                    FString(Object->GetHelp() ? Object->GetHelp() : TEXT("")), Filter, iXenaBridgeLocale::IsChinese()))) Names.Add(Name);
        }), TEXT(""));
    Names.Sort();
    TotalMatches = Names.Num();
    Items.Reset();
    for (int32 Index = 0; Index < FMath::Min(Names.Num(), 200); ++Index)
    {
        IConsoleObject* Object = IConsoleManager::Get().FindConsoleObject(*Names[Index]);
        if (!Object || Object->TestFlags(ECVF_Unregistered)) continue;
        const FItem Item = MakeShared<FiXenaConsoleItem>();
        Item->Name = Names[Index];
        Item->Help = FString(Object->GetHelp() ? Object->GetHelp() : TEXT("")).Left(4096);
        if (IConsoleVariable* Variable = Object->AsVariable())
        {
            Item->bVariable = true;
            Item->Value = Variable->GetString().Left(4096);
        }
        Items.Add(Item);
    }
    if (ListView.IsValid()) ListView->RequestListRefresh();
}

void SiXenaBridgePanel::SearchChanged(const FText& Text)
{
    Filter = Text.ToString().Left(256);
    RefreshItems();
}

TSharedRef<ITableRow> SiXenaBridgePanel::GenerateRow(FItem Item, const TSharedRef<STableViewBase>& Owner)
{
    return SNew(STableRow<FItem>, Owner).Padding(4)
    [
        SNew(SHorizontalBox)
        + SHorizontalBox::Slot().FillWidth(0.65f)
        [ SNew(STextBlock).Text(FText::FromString(Item->Name)) ]
        + SHorizontalBox::Slot().FillWidth(0.35f)
        [ SNew(STextBlock).Text_Lambda([Item] { return FText::FromString(Item->bVariable ? Item->Value.Left(80) : iXenaBridgeLocale::Text(TEXT("命令"), TEXT("Command"))); }) ]
    ];
}

void SiXenaBridgePanel::SelectionChanged(FItem Item, ESelectInfo::Type SelectInfo)
{
    Selected = Item;
    if (Item.IsValid() && CommandBox.IsValid()) CommandBox->SetText(FText::FromString(Item->Name));
}

void SiXenaBridgePanel::CommandCommitted(const FText& Text, ETextCommit::Type CommitType)
{
    if (CommitType == ETextCommit::OnEnter) ExecuteClicked();
}

FReply SiXenaBridgePanel::ExecuteClicked()
{
    if (bExecuting || !Execute.IsBound() || !CommandBox.IsValid()) return FReply::Handled();
    const FString Command = CommandBox->GetText().ToString().TrimStartAndEnd();
    TArray<FString> Words;
    Command.ParseIntoArrayWS(Words);
    const FString FirstWord = Words.Num() ? Words[0].ToLower() : FString();
    if (FirstWord == TEXT("quit") || FirstWord == TEXT("exit") || FirstWord == TEXT("restart")
        || FirstWord == TEXT("open") || FirstWord == TEXT("map"))
    {
        if (FMessageDialog::Open(EAppMsgType::YesNo, FText::FromString(
            (iXenaBridgeLocale::IsChinese()
                ? FString::Printf(TEXT("该命令可能关闭编辑器或替换当前关卡。请确认已保存需要的内容。\n\n执行：%s"), *Command)
                : FString::Printf(TEXT("This command may close the Editor or replace the current level. Save your work first.\n\nExecute: %s"), *Command)))) != EAppReturnType::Yes)
            return FReply::Handled();
    }
    TGuardValue<bool> Guard(bExecuting, true);
    SetOutput(Execute.Execute(Command));
    RefreshItems();
    return FReply::Handled();
}

FReply SiXenaBridgePanel::CompileClicked()
{
    if (!CanCompile()) return FReply::Handled();
    TGuardValue<bool> Guard(bExecuting, true);
    SetOutput(iXenaBridgeLocale::Text(TEXT("正在等待 UE Live Coding 返回结果。实时编译详情可在 Live Coding Console 或 VSCode 通讯日志中查看。"), TEXT("Waiting for the UE Live Coding result. See the Live Coding Console or VSCode communication output for available build details.")));
    SetOutput(Compile.Execute());
    return FReply::Handled();
}

FReply SiXenaBridgePanel::RefreshClicked() { RefreshItems(); return FReply::Handled(); }
FReply SiXenaBridgePanel::CopyOutputClicked() { FPlatformApplicationMisc::ClipboardCopy(*LastOutput); return FReply::Handled(); }
FReply SiXenaBridgePanel::RunPreset(FString Command)
{
    if (CommandBox.IsValid()) CommandBox->SetText(FText::FromString(Command));
    return ExecuteClicked();
}

FText SiXenaBridgePanel::StatusText() const
{
    return FText::FromString(GetStatus.IsBound() ? GetStatus.Execute() : iXenaBridgeLocale::Text(TEXT("通讯模块已关闭。"), TEXT("The communication module is closed.")));
}

FText SiXenaBridgePanel::DetailsText() const
{
    if (!Selected.IsValid()) return FText::FromString(iXenaBridgeLocale::Text(TEXT("选择条目查看帮助。变量不带参数时查询当前值，追加参数后修改值。stat/show 等部分 Exec 命令不在注册表内，可使用下方快捷按钮或手动输入。"), TEXT("Select an entry to view help. A variable without arguments queries its value; append arguments to change it. Some Exec commands, including stat/show, are not in this registry; use a preset or type them directly.")));
    FString Value = Selected->Value;
    if (Selected->bVariable)
    {
        if (IConsoleVariable* Variable = IConsoleManager::Get().FindConsoleVariable(*Selected->Name)) Value = Variable->GetString();
    }
    return FText::FromString(Selected->Name + (Selected->bVariable ? TEXT(" = ") + Value : iXenaBridgeLocale::Text(TEXT("（命令）"), TEXT(" (command)"))) + TEXT("\n\n") + iXenaBridgeConsoleHelp::Localize(Selected->Name, Selected->Help, iXenaBridgeLocale::IsChinese()));
}

FText SiXenaBridgePanel::CountText() const
{
    return FText::FromString(iXenaBridgeLocale::IsChinese()
        ? FString::Printf(TEXT("匹配 %d 项，显示前 %d 项；可继续输入关键词缩小范围。"), TotalMatches, Items.Num())
        : FString::Printf(TEXT("%d matches; showing the first %d. Add more keywords to narrow the results."), TotalMatches, Items.Num()));
}

bool SiXenaBridgePanel::CanCompile() const
{
    return !bExecuting && Compile.IsBound() && CompileAvailable.IsBound() && CompileAvailable.Execute();
}

void SiXenaBridgePanel::SetOutput(const FString& Text)
{
    LastOutput = Text;
    if (OutputBox.IsValid()) OutputBox->SetText(FText::FromString(Text));
}

FText SiXenaBridgePanel::LanguageText() const
{
    const FString Language = iXenaBridgeLocale::GetLanguage();
    if (Language == TEXT("zh-CN")) return FText::FromString(TEXT("简体中文"));
    if (Language == TEXT("en")) return FText::FromString(TEXT("English"));
    return iXenaBridgeLocale::LocalizedText(TEXT("自动（跟随 UE）"), TEXT("Auto (follow UE)"));
}

TSharedRef<SWidget> SiXenaBridgePanel::GenerateLanguageOption(TSharedPtr<FString> Item)
{
    return SNew(STextBlock).Text_Lambda([Item]
    {
        if (*Item == TEXT("zh-CN")) return FText::FromString(TEXT("简体中文"));
        if (*Item == TEXT("en")) return FText::FromString(TEXT("English"));
        return iXenaBridgeLocale::LocalizedText(TEXT("自动（跟随 UE）"), TEXT("Auto (follow UE)"));
    });
}

void SiXenaBridgePanel::LanguageChanged(TSharedPtr<FString> Item, ESelectInfo::Type SelectInfo)
{
    if (Item.IsValid()) iXenaBridgeLocale::SetLanguage(*Item);
    // Dynamic help text uses the new locale; refreshing search also enables Chinese summary matches.
    RefreshItems();
    // Retain current input and result history; never reconstruct the editor controls.
}
