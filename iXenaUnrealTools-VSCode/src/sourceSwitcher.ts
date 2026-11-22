import { t } from './i18n';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { planSourcePair, rankSourcePairs } from './sourcePairModel';

const SOURCE_EXCLUDES = '**/{Binaries,Intermediate,Saved,DerivedDataCache,.git,node_modules}/**';

async function existingFile(uri: vscode.Uri): Promise<boolean> {
  try {
    return !!((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.File);
  } catch {
    return false;
  }
}

function asLocalUri(value: unknown): vscode.Uri | undefined {
  if (value instanceof vscode.Uri && value.scheme === 'file') return value;
  return undefined;
}

function escapeGlobFilename(value: string): string {
  return value.replace(/[\\*?{}\[\]]/g, letter => `[${letter}]`);
}

/** VSCode editor/context and explorer/context pass the clicked file Uri; palette uses active editor. */
export async function switchHeaderSource(clicked?: vscode.Uri): Promise<void> {
  const origin = asLocalUri(clicked) ?? asLocalUri(vscode.window.activeTextEditor?.document.uri);
  if (!origin) {
    await vscode.window.showInformationMessage(t("请先打开或右击本地的 .h / .cpp 源码文件。"));
    return;
  }
  const plan = planSourcePair(origin.fsPath);
  if (!plan) {
    await vscode.window.showInformationMessage(t("仅支持切换 C/C++ 头文件与源文件（.h/.hpp/.hh/.hxx ↔ .cpp/.cc/.cxx/.c），不处理 UE 生成文件。"));
    return;
  }

  // Fast path: canonical Unreal layout (Public/Foo.h -> Private/Foo.cpp), zero workspace scans.
  for (const candidate of plan.directPaths) {
    if (await existingFile(vscode.Uri.file(candidate))) {
      await vscode.window.showTextDocument(vscode.Uri.file(candidate), { preview: false });
      return;
    }
  }

  // A same-name source may live deeper in the same module (e.g. Private/Systems/Foo.cpp).
  // Search only that module first to avoid same-name classes in plugins / engine source.
  const scope = plan.moduleRoot || vscode.workspace.getWorkspaceFolder(origin)?.uri.fsPath;
  if (!scope) {
    await vscode.window.showInformationMessage(t("未找到 {0} 对应的头文件或源文件；当前文件不在工作区内。", plan.stem));
    return;
  }
  const suffix = plan.targetExtensions.length > 1
    ? `{${plan.targetExtensions.map(ext => ext.slice(1)).join(',')}}` : plan.targetExtensions[0].slice(1);
  const pattern = `**/${escapeGlobFilename(plan.stem)}.${suffix}`;
  let matches = await vscode.workspace.findFiles(new vscode.RelativePattern(scope, pattern), SOURCE_EXCLUDES, 100);
  // In unstructured projects use the owning workspace root, but never scan every engine root.
  const ownRoot = vscode.workspace.getWorkspaceFolder(origin)?.uri.fsPath;
  if (matches.length === 0 && ownRoot && scope !== ownRoot) {
    matches = await vscode.workspace.findFiles(new vscode.RelativePattern(ownRoot, pattern), SOURCE_EXCLUDES, 100);
  }
  const files = rankSourcePairs(plan, matches.map(uri => uri.fsPath));
  if (files.length === 0) {
    await vscode.window.showInformationMessage(t("未找到 {0} 对应的头文件或源文件。", path.basename(origin.fsPath)));
    return;
  }
  // Only an unambiguous match inside the UE module is safe to open without user confirmation.
  const moduleMatches = plan.moduleRoot ? files.filter(file => {
    const relative = path.relative(plan.moduleRoot!, file);
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  }) : files;
  const candidates = moduleMatches.length > 0 ? moduleMatches : files;
  if (candidates.length === 1 && (moduleMatches.length > 0 || !plan.moduleRoot)) {
    await vscode.window.showTextDocument(vscode.Uri.file(candidates[0]), { preview: false });
    return;
  }
  const picked = await vscode.window.showQuickPick(candidates.map(file => ({
    label: path.basename(file),
    description: path.relative(ownRoot || scope, path.dirname(file)) || '.',
    detail: file,
    file
  })), {
    placeHolder: t("找到多个可能的配对文件，请确认要打开的文件"),
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (picked) await vscode.window.showTextDocument(vscode.Uri.file(picked.file), { preview: false });
}
