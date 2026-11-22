import { t } from './i18n';
import * as path from 'node:path';
import { TextDecoder } from 'node:util';

/** Explorer 协议只传递描述文件和固定动作，不接受任意命令。 */
export const EXPLORER_EXTENSION_ID = 'ixena-unreal-tools.ixena-unreal-tools';
export const EXPLORER_URI_PATH = '/explorer';
export const EXPLORER_CONFIG_FILENAME = 'explorer-config.json';
export const EXPLORER_MAX_QUERY_LENGTH = 24576;
export const EXPLORER_MAX_FILE_LENGTH = 8192;

export type ExplorerAction = 'open' | 'edit' | 'source';

export interface ExplorerRequest {
  version: 1;
  action: ExplorerAction;
  file: string;
}

/** 拒绝设备路径、ADS、控制字符等；只接受 Windows 本地或 UNC 描述文件。 */
export function validateExplorerFilePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > EXPLORER_MAX_FILE_LENGTH) {
    throw new Error(t("右键请求缺少有效的描述文件路径，或路径过长。"));
  }
  if (/[\x00-\x1f\x7f<>"|?*]/.test(value)) {
    throw new Error(t("右键请求的路径含有不允许的字符。"));
  }
  const windowsPath = value.replace(/\//g, '\\');
  if (/^\\\\[.?]\\/.test(windowsPath) || /^\\\?\?\\/.test(windowsPath)) {
    throw new Error(t("右键请求不支持 Windows 设备路径。"));
  }
  const drivePath = /^[A-Za-z]:\\/.test(windowsPath);
  const uncPath = /^\\\\[^\\]+\\[^\\]+\\/.test(windowsPath);
  if (!drivePath && !uncPath) {
    throw new Error(t("右键请求必须使用 Windows 绝对路径或完整 UNC 文件路径。"));
  }
  const parts = (drivePath ? windowsPath.slice(3) : windowsPath.slice(2)).split('\\');
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || /[.: ]$/.test(part) || part.includes(':')) {
      throw new Error(t("右键请求的路径包含空段、相对路径段、流名称或尾随空格。"));
    }
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) {
      throw new Error(t("右键请求不支持 Windows 保留设备名称。"));
    }
  }
  const normalized = path.win32.normalize(windowsPath);
  if (!/\.(?:uproject|uplugin)$/i.test(normalized)) {
    throw new Error(t("右键请求只接受 .uproject 或 .uplugin 文件。"));
  }
  return normalized;
}

function validateRequest(value: unknown): ExplorerRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(t("右键请求格式无效。"));
  }
  const request = value as Record<string, unknown>;
  const keys = Object.keys(request).sort();
  if (keys.join(',') !== 'action,file,version' || request.version !== 1) {
    throw new Error(t("右键请求版本或字段无效。"));
  }
  if (request.action !== 'open' && request.action !== 'edit' && request.action !== 'source') {
    throw new Error(t("右键请求包含不支持的动作。"));
  }
  return { version: 1, action: request.action, file: validateExplorerFilePath(request.file) };
}

/** 返回不含问号的查询字符串；base64url 避免 URI 多次解码改变文件名。 */
export function encodeExplorerRequest(request: ExplorerRequest): string {
  const value = validateRequest(request);
  const query = `payload=${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}`;
  if (query.length > EXPLORER_MAX_QUERY_LENGTH) {
    throw new Error(t("右键请求过长。"));
  }
  return query;
}

/** scheme/authority 由 URI handler 验证；这里只解析固定路由和严格编码的载荷。 */
export function parseExplorerRequest(uriPath: string, query: string): ExplorerRequest {
  if (uriPath !== EXPLORER_URI_PATH || typeof query !== 'string' || query.length > EXPLORER_MAX_QUERY_LENGTH) {
    throw new Error(t("右键请求路由无效或请求过长。"));
  }
  const match = /^payload=([A-Za-z0-9_-]+)$/.exec(query);
  if (!match) {
    throw new Error(t("右键请求必须包含唯一的 base64url payload。"));
  }
  const bytes = Buffer.from(match[1], 'base64url');
  if (bytes.toString('base64url') !== match[1]) {
    throw new Error(t("右键请求使用了非规范的 base64url 编码。"));
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error(t("右键请求的 UTF-8 JSON 载荷无效。"));
  }
  return validateRequest(value);
}

/** 自有键名只由合法 URI scheme 派生，防止拼接到其他注册表分支。 */
export function validateExplorerUriScheme(uriScheme: unknown): string {
  if (typeof uriScheme !== 'string' || !/^[a-z][a-z0-9+.-]{0,63}$/.test(uriScheme)) {
    throw new Error(t("无法使用此 VSCode URI scheme 注册右键菜单。"));
  }
  return uriScheme;
}

export function explorerRegistryKeyName(uriScheme: string): string {
  return `iXenaUnrealTools.${validateExplorerUriScheme(uriScheme)}`;
}

/** 仅当前用户、两个固定扩展名；不改文件类型的默认关联或 Unreal 菜单。 */
export function explorerRegistryPaths(uriScheme: string): string[] {
  const key = explorerRegistryKeyName(uriScheme);
  return ['.uproject', '.uplugin'].map(extension =>
    `HKCU\\Software\\Classes\\SystemFileAssociations\\${extension}\\shell\\${key}`);
}
