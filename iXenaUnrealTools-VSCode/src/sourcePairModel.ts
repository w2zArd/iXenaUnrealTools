import * as path from 'node:path';

export interface SourcePairPlan {
  /** Input path, retaining its original casing. */
  source: string;
  /** Case-sensitive filename stem (FooActor, without the extension). */
  stem: string;
  /** Ordered candidate extensions; .h ↔ .cpp is always first. */
  targetExtensions: readonly string[];
  /** File paths to check directly, in preference order. */
  directPaths: readonly string[];
  /** The smallest UE module containing this file, if detectable. */
  moduleRoot?: string;
}

const HEADER_EXTENSIONS = new Set(['.h', '.hpp', '.hh', '.hxx']);
const SOURCE_EXTENSIONS = new Set(['.cpp', '.cc', '.cxx', '.c']);
const ENGINE_MODULE_CATEGORIES = new Set(['runtime', 'editor', 'developer', 'thirdparty', 'programs']);
const GENERATED_FILE_RE = /(?:\.generated\.h|\.gen\.cpp|\.generated\.cpp|\.init\.gen\.cpp)$/i;

function pathApi(filePath: string): typeof path {
  return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(filePath) ? path.win32 : path;
}

function splitPath(relative: string, api: typeof path): string[] {
  return relative.split(api.sep).filter(Boolean);
}

/** UE project: Source/Module; UE engine: Engine/Source/Runtime/Module. */
export function findUeModuleRoot(filePath: string): string | undefined {
  const api = pathApi(filePath);
  const directory = api.dirname(filePath);
  const parsed = api.parse(directory);
  const segments = splitPath(directory.substring(parsed.root.length), api);
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].toLowerCase() !== 'source' || i + 1 >= segments.length) continue;
    let end = i + 1;
    if (ENGINE_MODULE_CATEGORIES.has(segments[end].toLowerCase()) && end + 1 < segments.length) {
      end++;
    }
    // Only regard a path as a module when a file is *under* that module directory.
    if (end + 1 >= segments.length) continue;
    return api.join(parsed.root, ...segments.slice(0, end + 1));
  }
  return undefined;
}

/** Generate safe, ordered physical candidates without scanning the whole UE engine. */
export function planSourcePair(filePath: string): SourcePairPlan | undefined {
  if (typeof filePath !== 'string' || !filePath || GENERATED_FILE_RE.test(filePath)) return undefined;
  const api = pathApi(filePath);
  const extension = api.extname(filePath).toLowerCase();
  const header = HEADER_EXTENSIONS.has(extension);
  if (!header && !SOURCE_EXTENSIONS.has(extension)) return undefined;
  const stem = api.basename(filePath, api.extname(filePath));
  if (!stem || stem.endsWith('.generated') || stem.endsWith('.gen')) return undefined;
  const extensions = header ? ['.cpp', '.cc', '.cxx', '.c'] : ['.h', '.hpp', '.hh', '.hxx'];
  const moduleRoot = findUeModuleRoot(filePath);
  const inputDirectory = api.dirname(filePath);
  const folders: string[] = [inputDirectory];
  if (moduleRoot) {
    const relative = api.relative(moduleRoot, inputDirectory);
    if (relative !== '..' && !relative.startsWith('..' + api.sep) && !api.isAbsolute(relative)) {
      const parts = splitPath(relative, api);
      const first = parts[0]?.toLowerCase();
      const defaultDirectories = header ? ['Private', 'Public', 'Classes'] : ['Public', 'Classes', 'Private'];
      if (first === 'public' || first === 'private' || first === 'classes') {
        const afterFolder = parts.slice(1);
        for (const folder of defaultDirectories) {
          folders.push(api.join(moduleRoot, folder, ...afterFolder));
        }
      } else {
        for (const folder of defaultDirectories) {
          folders.push(api.join(moduleRoot, folder, ...parts));
        }
      }
      // For headers nested under Public/Subdirectory and sources flattened under Private.
      for (const folder of defaultDirectories) folders.push(api.join(moduleRoot, folder));
      folders.push(moduleRoot);
    }
  }
  const directPaths: string[] = [];
  const seen = new Set<string>();
  // Prefer extension priority first, then structural proximity: .cpp wins over .cc.
  for (const extension of extensions) {
    for (const folder of folders) {
      const candidate = api.join(folder, stem + extension);
      const key = api === path.win32 ? candidate.toLowerCase() : candidate;
      if (!seen.has(key)) { seen.add(key); directPaths.push(candidate); }
    }
  }
  return { source: filePath, stem, targetExtensions: extensions, directPaths, moduleRoot };
}

/** Stable, predictable ordering of indexed matches, preserving UE module locality. */
export function rankSourcePairs(plan: SourcePairPlan, matches: readonly string[]): string[] {
  const api = pathApi(plan.source);
  const sourceDir = api.dirname(plan.source);
  const original = plan.directPaths;
  const directRanks = new Map(original.map((item, index) => [api === path.win32 ? item.toLowerCase() : item, index]));
  const uniq = new Map<string, string>();
  for (const candidate of matches) {
    if (!candidate || GENERATED_FILE_RE.test(candidate)) continue;
    const ext = api.extname(candidate).toLowerCase();
    const candidateStem = api.basename(candidate, api.extname(candidate));
    if (!plan.targetExtensions.includes(ext) ||
      (api === path.win32 ? candidateStem.toLowerCase() !== plan.stem.toLowerCase() : candidateStem !== plan.stem)) continue;
    uniq.set(api === path.win32 ? candidate.toLowerCase() : candidate, candidate);
  }
  const score = (candidate: string): number => {
    const key = api === path.win32 ? candidate.toLowerCase() : candidate;
    const direct = directRanks.get(key);
    if (direct !== undefined) return direct;
    const candidateDir = api.dirname(candidate);
    const sameModule = plan.moduleRoot && (api === path.win32
      ? candidateDir.toLowerCase().startsWith(plan.moduleRoot.toLowerCase() + api.sep)
      : candidateDir.startsWith(plan.moduleRoot + api.sep));
    const relative = api.relative(sourceDir, candidateDir);
    const hops = splitPath(relative, api).length;
    const priority = plan.targetExtensions.indexOf(api.extname(candidate).toLowerCase());
    return (sameModule ? 1000 : 10000) + priority * 100 + hops;
  };
  return [...uniq.values()].sort((a, b) => score(a) - score(b) || a.localeCompare(b));
}
