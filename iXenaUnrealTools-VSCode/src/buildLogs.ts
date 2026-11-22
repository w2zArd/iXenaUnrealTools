import * as path from 'node:path';
import { mkdir, open, stat, writeFile, readdir, unlink } from 'node:fs/promises';

/** 独立保存 UBT 已写入磁盘的日志。TaskExecution.terminate() 可能导致任务终端被回收，
 * VS Code Tasks API 不提供读取历史终端输出的接口，所以使用 UBT 自身的 Log.txt 做兜底。
 */
export const MAX_ARCHIVED_LOG_BYTES = 16 * 1024 * 1024;
export const MAX_ARCHIVED_LOG_FILES = 20;

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 64) || 'build';
}

export interface ArchiveOptions {
  sourcePath: string;
  destinationDirectory: string;
  label: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  startedAtMs: number;
  now?: Date;
}

/** 只有 UBT 日志在本次任务开始后更新过，才会保存，防止误将上次构建归为本次。 */
export async function archiveUbtLog(options: ArchiveOptions): Promise<string | undefined> {
  const metadata = await stat(options.sourcePath).catch(() => undefined);
  if (!metadata?.isFile() || metadata.size <= 0 || metadata.mtimeMs < options.startedAtMs - 2000) {
    return undefined;
  }
  const suffixSize = Math.min(MAX_ARCHIVED_LOG_BYTES, metadata.size);
  const offset = metadata.size - suffixSize;
  const contents = Buffer.alloc(suffixSize);
  const reader = await open(options.sourcePath, 'r');
  let bytesRead = 0;
  try {
    while (bytesRead < suffixSize) {
      const result = await reader.read(contents, bytesRead, suffixSize - bytesRead, offset + bytesRead);
      if (result.bytesRead === 0) { break; }
      bytesRead += result.bytesRead;
    }
  } finally { await reader.close(); }
  if (bytesRead === 0) { return undefined; }

  const now = options.now ?? new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const filename = `${timestamp}-${safeFilename(options.label)}-${options.status}.log`;
  await mkdir(options.destinationDirectory, { recursive: true });
  const filePath = path.join(options.destinationDirectory, filename);
  const header = [
    `iXenaUnrealTools - ${options.status} - ${options.label}`,
    `Source: ${options.sourcePath}`,
    offset > 0 ? `Note: retained the last ${MAX_ARCHIVED_LOG_BYTES / (1024 * 1024)} MiB; older output was truncated.` : 'Note: original UnrealBuildTool log snapshot.',
    ''
  ].join('\n') + '\n';
  await writeFile(filePath, Buffer.concat([Buffer.from(header, 'utf8'), contents.subarray(0, bytesRead)]));
  // 仅清理本插件在私有目录生成的快照，避免长期构建无限占用磁盘。
  const entries = (await readdir(options.destinationDirectory)).filter(name => /^\d{4}-\d{2}-\d{2}T.*-(?:succeeded|failed|cancelled)\.log$/.test(name)).sort();
  const obsolete = entries.slice(0, Math.max(0, entries.length - MAX_ARCHIVED_LOG_FILES));
  for (const oldName of obsolete) { await unlink(path.join(options.destinationDirectory, oldName)).catch(() => undefined); }
  return filePath;
}
