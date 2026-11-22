import * as fs from 'node:fs/promises';
import { pathApi } from './engineSupport';
import { tr } from './i18n';

export interface BridgeInstallation { scope: 'project' | 'engine'; directory: string; descriptorPath: string; version?: string; hasBinaries: boolean; }

/** 扫描插件目录的有限层级；可识别手动放入 Engine/Plugins 或 Marketplace 的同名插件。 */
export async function inspectBridgeInstallations(projectPath: string, engineRoot: string): Promise<BridgeInstallation[]> {
  const p = pathApi(projectPath);
  if (!p.isAbsolute(projectPath) || !/\.uproject$/i.test(projectPath)) { throw new Error(tr('检查插件需要 .uproject 绝对路径。', 'Plugin inspection requires an absolute .uproject path.')); }
  const roots: ['project' | 'engine', string][] = [
    ['project', p.join(p.dirname(projectPath), 'Plugins')],
    ['engine', pathApi(engineRoot).join(engineRoot, 'Engine', 'Plugins')]
  ];
  const found: BridgeInstallation[] = [];
  for (const [scope, root] of roots) {
    let visited = 0;
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (visited++ > 1500 || depth > 4) { return; }
      const api = pathApi(directory);
      const stat = await fs.lstat(directory).catch(() => undefined);
      if (!stat?.isDirectory() || stat.isSymbolicLink()) { return; }
      const descriptorPath = api.join(directory, 'iXenaUnrealBridge.uplugin');
      try {
        const descriptor = JSON.parse((await fs.readFile(descriptorPath, 'utf8')).replace(/^\uFEFF/, ''));
        if (Array.isArray(descriptor.Modules) && descriptor.Modules.some((module: { Name?: unknown }) => module?.Name === 'iXenaUnrealBridge')) {
          const platform = ({ win32: 'Win64', darwin: 'Mac', linux: 'Linux' } as Record<string, string>)[process.platform];
          const hasBinaries = platform ? await fs.access(api.join(directory, 'Binaries', platform, 'UnrealEditor.modules')).then(() => true, () => false) : false;
          found.push({ scope, directory, descriptorPath, version: typeof descriptor.VersionName === 'string' ? descriptor.VersionName : undefined,
            hasBinaries });
        }
        return;
      } catch { /* 不是桥插件；继续查找有限深度的子目录。 */ }
      for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.') ||
            ['Source', 'Content', 'Intermediate', 'Binaries', 'Saved', 'Resources', 'Config'].includes(entry.name)) { continue; }
        await walk(api.join(directory, entry.name), depth + 1);
      }
    };
    await walk(root, 0);
  }
  return found;
}
