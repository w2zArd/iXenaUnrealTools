import { t } from './i18n';
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { discoverProjects, UeModule } from './ueWorkspace';
import { unrealClassTemplates, UnrealClassTemplate, resolveClassName, validateSubdirectory,
  validateParentHeader, validateModuleName, makeCustomTemplate, makeClassPlan,
  inferClassLocation, checkClassPlan, createClassFiles } from './classTemplates';

const TITLE = 'iXena · 新建 Unreal C++ 类';
const COMMAND = 'iXenaUnrealTools';
type ClassChoice = vscode.QuickPickItem & { template?: UnrealClassTemplate; custom?: boolean };
type ModuleChoice = vscode.QuickPickItem & { module: UeModule; preferred: boolean };

async function customTemplate(): Promise<UnrealClassTemplate | undefined> {
  const parentClass = await vscode.window.showInputBox({ title: t("{0} · 自定义父类", t(TITLE)),
    prompt: t("已有父类完整 C++ 名称，例如 AExampleCharacterBase / UExampleInventory / FExampleHelper；不会自动生成纯虚函数实现。"),
    placeHolder: 'AExampleCharacterBase', ignoreFocusOut: true,
    validateInput: value => /^[AUF][A-Z][A-Za-z0-9_]*$/.test(value) && !value.includes('__') ? undefined : t("请填写完整 A/U/F 前缀的父类名。") });
  if (parentClass === undefined) return undefined;
  const parentHeader = await vscode.window.showInputBox({ title: t("{0} · 父类头文件", t(TITLE)),
    prompt: t("填写模块 Public 路径下的 include，不带双引号。例如 Characters/ExampleCharacterBase.h。"),
    value: `${parentClass.slice(1)}.h`, ignoreFocusOut: true, validateInput: validateParentHeader });
  if (parentHeader === undefined) return undefined;
  const dependencies = await vscode.window.showInputBox({ title: t("{0} · 父类模块依赖", t(TITLE)),
    prompt: t("父类所在模块名，可用逗号分隔；留空表示父类在当前模块。向导会列出依赖供你核对，不改写复杂 Build.cs。"),
    value: '', ignoreFocusOut: true, validateInput: value => value.split(',').map(item => item.trim()).filter(Boolean)
      .some(item => validateModuleName(item)) ? t("模块名须是有效标识符，多个模块用英文逗号分隔。") : undefined });
  if (dependencies === undefined) return undefined;
  return makeCustomTemplate(parentClass, parentHeader, dependencies.split(',').map(item => item.trim()).filter(Boolean));
}

function isWithin(root: string, item: string): boolean {
  const relative = path.relative(root, item);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

async function candidateProjects(selectedPath: string | undefined, initial: readonly string[]): Promise<string[]> {
  const projects = new Set(initial);
  const roots = new Set((vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath));
  if (selectedPath) {
    let current = (await fs.stat(selectedPath).catch(() => undefined))?.isDirectory() ? selectedPath : path.dirname(selectedPath);
    for (let depth = 0; depth < 12; depth++) {
      roots.add(current);
      const next = path.dirname(current); if (next === current) break; current = next;
    }
  }
  for (const root of roots) {
    const children = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const child of children) if (child.isFile() && /\.uproject$/i.test(child.name)) projects.add(path.join(root, child.name));
  }
  return [...projects];
}

/** 原生多步向导：父类、目标模块、名称、Public/Private、子目录、预览、成对创建。 */
export async function createUnrealClass(argument?: vscode.Uri | { fsPath?: string },
  options?: { projectPaths?: string[] }): Promise<void> {
  if (!vscode.workspace.isTrusted) throw new Error(t("请先信任工作区，再创建 C++ 文件。"));
  if (argument instanceof vscode.Uri && argument.scheme !== 'file') throw new Error(t("新建类向导只处理本地文件系统目录。"));
  const selectedPath = argument?.fsPath ?? (vscode.window.activeTextEditor?.document.uri.scheme === 'file'
    ? vscode.window.activeTextEditor.document.uri.fsPath : undefined);
  const projects = await discoverProjects(await candidateProjects(selectedPath, options?.projectPaths ?? []));
  if (!projects.some(project => project.scopes.some(scope => scope.modules.length))) {
    await vscode.window.showInformationMessage(t("没有找到带 .Build.cs 的项目模块。请打开 UE C++ 项目，或先在 UE 编辑器中创建首个 C++ 模块。"));
    return;
  }
  const choices: ClassChoice[] = unrealClassTemplates.map(template => ({ label: t(template.label),
    description: template.parentClass ?? t("F 前缀 · 无反射"), detail: t(template.description), template }));
  choices.push({ label: t("自定义父类…"), description: t("继承项目或插件中已有的类"),
    detail: t("填写父类名、头文件与模块；反射派生类默认 Abstract，需按父类约束补充实现。"), custom: true });
  const chosen = await vscode.window.showQuickPick(choices, { title: t("{0} · 1/6 选择父类", t(TITLE)),
    placeHolder: t("选择类用途，也可搜索父类名"), matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: true });
  if (!chosen) return;
  const template = chosen.custom ? await customTemplate() : chosen.template;
  if (!template) return;

  const modules: ModuleChoice[] = projects.flatMap(project => project.scopes.flatMap(scope => scope.modules.map(module => {
    const preferred = !!selectedPath && isWithin(module.directory, selectedPath);
    return { label: `${preferred ? '$(target) ' : ''}${module.name}`,
      description: `${project.name} · ${scope.kind === 'project' ? t("主项目") : t("插件 {0}", scope.name)}`,
      detail: module.rulePath, module, preferred };
  }))).sort((a, b) => Number(b.preferred) - Number(a.preferred) || a.label.localeCompare(b.label));
  const selectedModule = await vscode.window.showQuickPick(modules, { title: t("{0} · 2/6 目标模块", t(TITLE)),
    placeHolder: t("选择主项目或插件模块；带靶标的是右键目录所属模块"), matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: true });
  if (!selectedModule) return;
  const module = selectedModule.module;
  const inputName = await vscode.window.showInputBox({ title: t("{0} · 3/6 类名", t(TITLE)),
    prompt: t("可输入 NewClass 或完整 {0}NewClass。文件名省略 {1} 前缀，类名前缀为 {2}。", template.prefix, template.prefix, template.prefix),
    value: `New${template.id === 'PlainCpp' || template.custom ? 'Class' : template.id}`, ignoreFocusOut: true,
    validateInput: value => { try { resolveClassName(value, template); return undefined; } catch (error) { return error instanceof Error ? error.message : String(error); } } });
  if (inputName === undefined) return;
  const selectedDirectory = selectedPath && (await fs.stat(selectedPath).catch(() => undefined))?.isDirectory()
    ? selectedPath : selectedPath ? path.dirname(selectedPath) : module.directory;
  const inferred = inferClassLocation(module.directory, selectedDirectory) ?? { visibility: 'Public', subdirectory: '' };
  const visibilityOptions: Array<vscode.QuickPickItem & { value: 'Public' | 'Private' }> = [
    { label: t("Public 头文件 + Private 源文件"), description: t("供其他模块引用"), value: 'Public' },
    { label: t("Private 头文件 + Private 源文件"), description: t("仅在当前模块内部使用"), value: 'Private' }
  ];
  visibilityOptions.sort((a, b) => Number(b.value === inferred.visibility) - Number(a.value === inferred.visibility));
  const visibility = await vscode.window.showQuickPick(visibilityOptions, { title: t("{0} · 4/6 头文件可见性", t(TITLE)),
    placeHolder: t("根据右键目录推荐排序；.cpp 始终放在 Private"), ignoreFocusOut: true });
  if (!visibility) return;
  const subdirectory = await vscode.window.showInputBox({ title: t("{0} · 5/6 子目录", t(TITLE)),
    prompt: t("相对于 Public/Private 的子目录，例如 Characters/Player；留空直接放入 Public/Private。"),
    value: inferred.subdirectory, ignoreFocusOut: true, validateInput: validateSubdirectory });
  if (subdirectory === undefined) return;
  const plan = makeClassPlan({ moduleName: module.name, moduleDirectory: module.directory,
    template, inputName, visibility: visibility.value, subdirectory });
  await checkClassPlan(plan);
  const dependencies = `${plan.dependencies.kind}DependencyModuleNames: ${plan.dependencies.modules.join(', ') || t("无需新增模块")}`;
  const preview = await vscode.workspace.openTextDocument({ language: 'cpp', content:
    t("// 新建类预览：{0}\n// 此页是预览，不是实际文件；确认创建后会生成下面两个文件。\n", plan.className) +
    t("// 模块依赖请在 Build.cs 核对：{0}\n// Build.cs 不会被本向导自动改写。\n\n", dependencies) +
    `// ===== ${plan.headerPath} =====\n${plan.header}\n// ===== ${plan.sourcePath} =====\n${plan.source}` });
  await vscode.window.showTextDocument(preview, { preview: true });
  const confirmation = await vscode.window.showQuickPick([
    { label: t("$(new-file) 创建 {0}.h 和 {1}.cpp", plan.stem, plan.stem),
      description: plan.className, detail: `${plan.headerPath}\n${plan.sourcePath}`, action: 'create' },
    { label: t("取消创建"), description: t("保留预览，文件系统不发生修改"), action: 'cancel' }
  ], { title: t("{0} · 6/6 确认创建", t(TITLE)), placeHolder: t("请确认预览与依赖：{0}", dependencies), ignoreFocusOut: true });
  if (confirmation?.action !== 'create') return;
  // 第二次排他检查封住预览期间新出现的同名文件；故障回滚不会删除已有文件。
  await createClassFiles(plan);
  await vscode.window.showTextDocument(vscode.Uri.file(plan.headerPath), { preview: false });
  const next = await vscode.window.showInformationMessage(
    t("已创建 {0}。请核对 {1}。{2}", plan.className, dependencies, template.reflected ? t("新反射类建议关闭 UE 后完整编译，再重新打开编辑器。") : t("可在对应 cpp 中添加实现。")),
    t("管理模块依赖"), t("打开 .cpp"));
  if (next === t("管理模块依赖")) await vscode.commands.executeCommand(`${COMMAND}.editDependencies`, { module, fsPath: module.rulePath });
  else if (next === t("打开 .cpp")) await vscode.window.showTextDocument(vscode.Uri.file(plan.sourcePath), { preview: false });
}
