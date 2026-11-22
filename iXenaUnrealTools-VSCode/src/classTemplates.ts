import { t } from './i18n';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { FileHandle } from 'node:fs/promises';

/** 新建类向导的数据模型。所有模板只声明空继承，不生成 Tick 或未经验证的业务逻辑。 */
export interface UnrealClassTemplate {
  id: string;
  label: string;
  description: string;
  parentClass?: string;
  parentHeader?: string;
  prefix: 'A' | 'U' | 'F';
  reflected: boolean;
  specifiers?: string;
  dependencyModules: readonly string[];
  custom?: boolean;
}

const actor = (id: string, label: string, description: string, parentHeader: string,
  dependency = 'Engine'): UnrealClassTemplate => ({ id, label, description, parentClass: `A${id}`,
  parentHeader, prefix: 'A', reflected: true, dependencyModules: ['Core', 'CoreUObject', dependency] });
const object = (id: string, label: string, description: string, parentHeader: string,
  dependency = 'Engine', specifiers = ''): UnrealClassTemplate => ({ id, label, description,
  parentClass: `U${id}`, parentHeader, prefix: 'U', reflected: true, specifiers,
  dependencyModules: [...new Set(['Core', 'CoreUObject', dependency])] });

export const unrealClassTemplates: readonly UnrealClassTemplate[] = [
  actor('Actor', 'Actor', '可放入场景的基础对象', 'GameFramework/Actor.h'),
  actor('Pawn', 'Pawn', '可由控制器操控的对象', 'GameFramework/Pawn.h'),
  actor('Character', 'Character', '带角色移动能力的 Pawn', 'GameFramework/Character.h'),
  object('ActorComponent', 'Actor Component', '可挂载到 Actor 的功能组件', 'Components/ActorComponent.h', 'Engine', 'ClassGroup=(Custom), meta=(BlueprintSpawnableComponent)'),
  object('SceneComponent', 'Scene Component', '具有场景变换的组件', 'Components/SceneComponent.h', 'Engine', 'ClassGroup=(Custom), meta=(BlueprintSpawnableComponent)'),
  actor('GameModeBase', 'Game Mode Base', '游戏规则与默认角色配置', 'GameFramework/GameModeBase.h'),
  actor('GameStateBase', 'Game State Base', '游戏级状态', 'GameFramework/GameStateBase.h'),
  actor('PlayerController', 'Player Controller', '玩家控制器', 'GameFramework/PlayerController.h'),
  actor('PlayerState', 'Player State', '玩家状态', 'GameFramework/PlayerState.h'),
  actor('AIController', 'AI Controller', 'AI 控制器，需要 AIModule 依赖', 'AIController.h', 'AIModule'),
  object('Object', 'UObject', '支持反射和垃圾回收的对象', 'UObject/Object.h', 'CoreUObject', 'BlueprintType'),
  object('DataAsset', 'Data Asset', '可编辑的数据资产', 'Engine/DataAsset.h', 'Engine', 'BlueprintType'),
  object('PrimaryDataAsset', 'Primary Data Asset', '可由 Asset Manager 管理的数据资产', 'Engine/DataAsset.h', 'Engine', 'BlueprintType'),
  object('UserWidget', 'User Widget', 'UMG 控件，需要 UMG 依赖', 'Blueprint/UserWidget.h', 'UMG'),
  object('WorldSubsystem', 'World Subsystem', '随 UWorld 生命周期创建的子系统', 'Subsystems/WorldSubsystem.h'),
  object('GameInstanceSubsystem', 'Game Instance Subsystem', '随 GameInstance 生命周期创建的子系统', 'Subsystems/GameInstanceSubsystem.h'),
  object('EngineSubsystem', 'Engine Subsystem', '随引擎生命周期创建的子系统', 'Subsystems/EngineSubsystem.h'),
  object('LocalPlayerSubsystem', 'Local Player Subsystem', '随本地玩家生命周期创建的子系统', 'Subsystems/LocalPlayerSubsystem.h'),
  object('DeveloperSettings', 'Developer Settings', '项目设置入口，需要 DeveloperSettings 依赖', 'Engine/DeveloperSettings.h', 'DeveloperSettings', 'Config=Game, DefaultConfig'),
  { id: 'PlainCpp', label: '纯 C++ 类', description: '不参与 UObject 反射的普通 C++ 类', prefix: 'F',
    reflected: false, dependencyModules: ['Core'] }
];

const reserved = new Set(('alignas alignof and and_eq asm atomic_cancel atomic_commit atomic_noexcept auto bitand bitor bool break case catch char char8_t char16_t char32_t class compl concept const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept not not_eq nullptr operator or or_eq private protected public reflexpr register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch synchronized template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while xor xor_eq').split(' '));
const devices = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

export function validateModuleName(value: string): string | undefined {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(value) && !reserved.has(value) ? undefined : t("模块名必须是有效的 C++ 标识符。");
}

/** 完整 ASWMachine / USWData 与不带前缀的 SWMachine 都可输入；ActorHelper 不会被误去掉 A。 */
export function resolveClassName(input: string, template: UnrealClassTemplate): { stem: string; className: string } {
  if (typeof input !== 'string' || input !== input.trim() || !/^[A-Z][A-Za-z0-9_]*$/.test(input) || input.length > 100 || input.includes('__')) {
    throw new Error(t("类名须以大写英文字母开头，只能包含字母、数字和单下划线，长度不超过 100；不能包含空格、路径或命名空间。"));
  }
  if (reserved.has(input) || input.startsWith('_')) throw new Error(t("不能使用 C++ 保留标识符作为类名。"));
  let stem = input;
  if (/^[AUF][A-Z]/.test(input)) {
    if (input[0] !== template.prefix) throw new Error(t("此父类要求 {0} 前缀；请输入不带前缀的名字，或完整的 {1}{2}。", template.prefix, template.prefix, input));
    stem = input.slice(1);
  }
  if (!stem || devices.test(stem)) throw new Error(t("此文件名是 Windows 保留名称，请更换类名。"));
  const className = template.prefix + stem;
  if (className === template.parentClass) throw new Error(t("新类不能与父类同名。"));
  return { stem, className };
}

export function validateSubdirectory(value: string): string | undefined {
  if (value === '') return undefined;
  if (typeof value !== 'string' || value.length > 180 || value !== value.trim()) return t("子目录不能有首尾空格，长度最多 180。");
  const parts = value.replace(/\\/g, '/').split('/');
  if (parts.some(part => !/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(part) || devices.test(part))) {
    return t("子目录使用字母、数字、下划线或连字符，层级以 / 分隔；不允许 ..、绝对路径或保留名称。");
  }
  return undefined;
}

export function validateParentHeader(value: string): string | undefined {
  if (!/\.h$/i.test(value)) return t("父类头文件必须以 .h 结尾。");
  const withoutExtension = value.slice(0, -2);
  return validateSubdirectory(withoutExtension);
}

export function makeCustomTemplate(parentClass: string, parentHeader: string, modules: readonly string[]): UnrealClassTemplate {
  if (!/^[AUF][A-Z][A-Za-z0-9_]*$/.test(parentClass) || parentClass.includes('__')) throw new Error(t("自定义父类须填写完整 A/U/F 前缀类名，例如 AExampleCharacterBase。"));
  const headerError = validateParentHeader(parentHeader);
  if (headerError) throw new Error(headerError);
  if (modules.some(name => validateModuleName(name))) throw new Error(t("依赖模块名称无效。"));
  const prefix = parentClass[0] as 'A' | 'U' | 'F';
  return { id: 'Custom', label: t("自定义 · {0}", parentClass), description: '继承已有父类；构造函数与纯虚函数需按父类约束补充',
    parentClass, parentHeader: parentHeader.replace(/\\/g, '/'), prefix, reflected: prefix !== 'F',
    // 未知父类可能有纯虚函数；默认声明为抽象反射类，补齐业务实现后可移除 Abstract。
    specifiers: prefix === 'F' ? '' : 'Abstract', dependencyModules: [...new Set(['Core', ...(prefix === 'F' ? [] : ['CoreUObject']), ...modules])], custom: true };
}

export interface UnrealClassPlan {
  moduleName: string; moduleDirectory: string; template: UnrealClassTemplate;
  className: string; stem: string; visibility: 'Public' | 'Private'; subdirectory: string;
  headerPath: string; sourcePath: string; header: string; source: string;
  dependencies: { kind: 'Public' | 'Private'; modules: string[] };
}

export function makeClassPlan(options: {
  moduleName: string; moduleDirectory: string; template: UnrealClassTemplate;
  inputName: string; visibility: 'Public' | 'Private'; subdirectory?: string;
}): UnrealClassPlan {
  const moduleError = validateModuleName(options.moduleName);
  if (moduleError) throw new Error(moduleError);
  if (!path.isAbsolute(options.moduleDirectory)) throw new Error(t("目标模块目录必须是绝对路径。"));
  if (!['Public', 'Private'].includes(options.visibility)) throw new Error(t("头文件位置必须为 Public 或 Private。"));
  const subdirectory = (options.subdirectory ?? '').replace(/\\/g, '/');
  const folderError = validateSubdirectory(subdirectory);
  if (folderError) throw new Error(folderError);
  const { template } = options;
  const { stem, className } = resolveClassName(options.inputName, template);
  const headerPath = path.join(options.moduleDirectory, options.visibility, subdirectory, `${stem}.h`);
  const sourcePath = path.join(options.moduleDirectory, 'Private', subdirectory, `${stem}.cpp`);
  const api = `${options.moduleName.toUpperCase()}_API`;
  const includes = ['#include "CoreMinimal.h"', ...(template.parentHeader ? [`#include "${template.parentHeader}"`] : []),
    ...(template.reflected ? [`#include "${stem}.generated.h"`] : [])];
  const header = `// 使用 iXenaUnrealTools 创建。请在实现后补充此类的职责说明。\n#pragma once\n\n${includes.join('\n')}\n\n/**\n * ${stem}：${template.description}。\n *\n * 所属模块：${options.moduleName}。\n * 在此声明成员与接口，业务实现放入对应的 .cpp 文件。\n${template.custom ? ' * 自定义父类的构造与纯虚函数需要手动核对；反射类默认使用 Abstract。\n' : ''} */\n${template.reflected ? `UCLASS(${template.specifiers ?? ''})\n` : ''}class ${api} ${className}${template.parentClass ? ` : public ${template.parentClass}` : ''}\n{\n${template.reflected ? '    GENERATED_BODY()\n\n' : ''}public:\n    // 在这里添加该类对外提供的接口。\n};\n`;
  const ownHeader = options.visibility === 'Public' && subdirectory ? `${subdirectory}/${stem}.h` : `${stem}.h`;
  const source = `#include "${ownHeader}"\n\n// 在这里实现 ${className} 的成员函数。\n`;
  return { moduleName: options.moduleName, moduleDirectory: path.resolve(options.moduleDirectory), template,
    className, stem, visibility: options.visibility, subdirectory, headerPath, sourcePath, header, source,
    dependencies: { kind: options.visibility, modules: [...new Set(template.dependencyModules)].filter(name => name !== options.moduleName) } };
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

export function inferClassLocation(moduleDirectory: string, clickedDirectory: string): { visibility: 'Public' | 'Private'; subdirectory: string } | undefined {
  if (!inside(moduleDirectory, clickedDirectory)) return undefined;
  const parts = path.relative(moduleDirectory, clickedDirectory).split(path.sep).filter(Boolean);
  if (parts[0] !== 'Public' && parts[0] !== 'Private') return { visibility: 'Public', subdirectory: '' };
  const subdirectory = parts.slice(1).join('/');
  return validateSubdirectory(subdirectory) ? { visibility: parts[0], subdirectory: '' } : { visibility: parts[0], subdirectory };
}

/** 拒绝目标路径中的符号链接/联接点；不能通过 Public/Private 链接写出选定模块。 */
async function verifyDirectoryChain(root: string, directory: string, create: boolean): Promise<void> {
  if (!inside(root, directory)) throw new Error(t("输出目录越过了目标模块边界。"));
  const rootInfo = await fs.lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error(t("目标模块必须是实体目录，不能是符号链接。"));
  const rootReal = await fs.realpath(root);
  let current = root;
  for (const part of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!info && create) {
      await fs.mkdir(current).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
      info = await fs.lstat(current);
    }
    if (!info) break;
    if (info.isSymbolicLink() || !info.isDirectory() || !inside(rootReal, await fs.realpath(current))) {
      throw new Error(t("输出目录包含符号链接、非目录或越界路径：{0}", current));
    }
  }
}

async function findCollision(root: string, stem: string): Promise<string | undefined> {
  const pending = [root]; let examined = 0;
  while (pending.length) {
    const folder = pending.pop()!;
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      if (++examined > 50000) throw new Error(t("模块文件过多，无法完成同名文件检查；请缩小模块后重试。"));
      const file = path.join(folder, entry.name);
      if (entry.isDirectory() && !['Binaries', 'Intermediate', '.git', 'node_modules'].includes(entry.name)) pending.push(file);
      else if (entry.name.toLowerCase() === `${stem}.h`.toLowerCase() || entry.name.toLowerCase() === `${stem}.cpp`.toLowerCase()) return file;
    }
  }
  return undefined;
}

/** 创建前可重复调用，预览后外部生成同名文件也会拒绝；不会覆盖已有文件。 */
export async function checkClassPlan(plan: UnrealClassPlan): Promise<void> {
  for (const file of [plan.headerPath, plan.sourcePath]) {
    if (!inside(plan.moduleDirectory, file)) throw new Error(t("输出文件越过了目标模块边界。"));
    await verifyDirectoryChain(plan.moduleDirectory, path.dirname(file), false);
  }
  const existing = await findCollision(plan.moduleDirectory, plan.stem);
  if (existing) throw new Error(t("模块内已经存在同名文件：{0}。请更换类名，避免重复定义或生成头文件冲突。", existing));
}

type CreatedFile = { path: string; handle: FileHandle; dev: number; ino: number; expected: string };

/** 成对排他创建；失败时只回滚本轮创建且未被外部修改的文件。write 用于 I/O 故障验证。 */
export async function createClassFiles(plan: UnrealClassPlan,
  write: (handle: FileHandle, contents: string) => Promise<void> = (handle, contents) => handle.writeFile(contents, 'utf8')): Promise<void> {
  await checkClassPlan(plan);
  const created: CreatedFile[] = [];
  try {
    for (const file of [plan.headerPath, plan.sourcePath]) {
      await verifyDirectoryChain(plan.moduleDirectory, path.dirname(file), true);
      const handle = await fs.open(file, 'wx', 0o644);
      const stat = await handle.stat();
      created.push({ path: file, handle, dev: stat.dev, ino: stat.ino, expected: '' });
    }
    await write(created[0].handle, plan.header); created[0].expected = plan.header;
    await write(created[1].handle, plan.source); created[1].expected = plan.source;
  } catch (error) {
    const preserved: string[] = [];
    for (const file of created) {
      await file.handle.close().catch(() => {});
      const now = await fs.lstat(file.path).catch(() => undefined);
      if (!now) continue;
      if (now.dev === file.dev && now.ino === file.ino && !now.isSymbolicLink() &&
          await fs.readFile(file.path, 'utf8').catch(() => undefined) === file.expected) await fs.unlink(file.path).catch(() => preserved.push(file.path));
      else preserved.push(file.path);
    }
    const explanation = error instanceof Error ? error.message : String(error);
    throw new Error(t("新建类失败：{0}{1}", explanation, preserved.length ? t("。检测到外部修改或未完成写入，已保留这些文件供检查：{0}", preserved.join('、')) : t("。本轮已创建的文件已回滚。")));
  } finally { await Promise.all(created.map(file => file.handle.close().catch(() => {}))); }
}
