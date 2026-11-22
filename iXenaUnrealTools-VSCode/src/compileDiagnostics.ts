/** MSVC / Clang 编译输出中的位置；不修改 clangd 或 C/C++ 扩展自己的诊断。 */
export interface CompileDiagnostic {
  file: string; line: number; column: number; severity: 'error' | 'warning'; code?: string; message: string;
}

export function parseCompileDiagnostic(line: string): CompileDiagnostic | undefined {
  const clean = line.replace(/\x1b\[[0-9;]*m/g, '').replace(/^\[[^\]]+\]\s*/, '');
  // 某些 UE 日志在原始诊断前附加 LogLiveCoding: Display:。
  const text = clean.replace(/^Log[A-Za-z0-9_]+:\s*(?:(?:Display|Warning|Error|Log):\s*)?/, '');
  const msvc = /^(.*?\.(?:h|hpp|hh|hxx|cpp|cc|cxx|c))\((\d+)(?:,(\d+))?\):\s*(fatal error|error|warning)\s+([A-Za-z]+\d+):\s*(.*)$/i.exec(text);
  const clang = /^(.*?):(\d+):(\d+):\s*(fatal error|error|warning):\s*(.*?)(?:\s+\[(-W[^\]]+)\])?$/i.exec(text);
  const m = msvc ?? clang;
  if (!m || !/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(m[1])) { return undefined; }
  const lineNumber = Number(m[2]), columnNumber = Number(m[3] ?? 1);
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 1 || !Number.isSafeInteger(columnNumber) || columnNumber < 1) { return undefined; }
  return { file: m[1], line: lineNumber - 1, column: columnNumber - 1,
    severity: /error/i.test(m[4]) ? 'error' : 'warning',
    code: msvc ? m[5] : m[6], message: msvc ? m[6] : m[5] };
}
