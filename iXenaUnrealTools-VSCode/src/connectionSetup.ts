import { isIP } from 'node:net';
import { tr } from './i18n';

export const REPOSITORY_URL = 'https://github.com/w2zArd/iXenaUnrealTools';
export const DEFAULT_MCP_URL = 'http://127.0.0.1:8000/mcp';

/** 输入仅构造客户端地址；不会修改 UE 的监听地址或安装任何插件。 */
export function normalizeMcpHost(value: string): string {
  const host = value.trim().replace(/^\[([^\]]+)\]$/, '$1');
  if (host.toLowerCase() === 'localhost') return 'localhost';
  if (!isIP(host)) throw new Error(tr('请输入有效的 IPv4、IPv6 或 localhost。', 'Enter a valid IPv4 address, IPv6 address, or localhost.'));
  return host;
}

export function normalizeMcpPort(value: string | number): number {
  const text = String(value).trim();
  if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 65535) {
    throw new Error(tr('端口必须是 1～65535 的整数。', 'The port must be an integer from 1 to 65535.'));
  }
  return Number(text);
}

export function normalizeMcpPath(value: string): string {
  const route = value.trim();
  if (!route.startsWith('/') || route === '/' || /[\s\\?#\u0000-\u001f]/.test(route) || route.startsWith('//')) {
    throw new Error(tr('路径需以 / 开头，例如 /mcp；不能包含空格、查询或片段。', 'Use a path such as /mcp without spaces, a query, or a fragment.'));
  }
  return route;
}

export function buildMcpEndpoint(hostValue: string, portValue: string | number, pathValue = '/mcp', protocol: 'http:' | 'https:' = 'http:'): string {
  const host = normalizeMcpHost(hostValue);
  const port = normalizeMcpPort(portValue);
  const route = normalizeMcpPath(pathValue);
  const endpoint = new URL(`${protocol}//${isIP(host) === 6 ? `[${host}]` : host}:${port}${route}`);
  normalizeMcpPath(endpoint.pathname);
  return endpoint.toString();
}

export function endpointParts(value: string): { host: string; port: string; route: string; protocol: 'http:' | 'https:' } {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid protocol');
    return { protocol: url.protocol as 'http:' | 'https:', host: normalizeMcpHost(url.hostname), port: url.port || (url.protocol === 'https:' ? '443' : '80'), route: normalizeMcpPath(url.pathname) };
  } catch { return { host: '127.0.0.1', port: '8000', route: '/mcp', protocol: 'http:' }; }
}
