#!/usr/bin/env node
'use strict';

// 真实 VS Code Extension Host 测试。Linux 无桌面时请在 xvfb-run 中运行。
// 可用 IXENA_UNREALTOOLS_TEST_VSCODE 指定已经下载的 code 可执行文件。
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const extensionRoot = path.resolve(__dirname, '..');
  const session = await fs.mkdtemp(path.join(os.tmpdir(), 'ixena-unreal-tools-host-'));
  const workspace = path.join(session, 'project');
  await fs.mkdir(path.join(workspace, '.vscode'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'Example.cpp'), 'int main() {\n    return 0;\n}\n');
  await fs.writeFile(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({
    'security.workspace.trust.enabled': false,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'workbench.startupEditor': 'none',
    'terminal.integrated.enablePersistentSessions': false
  }, null, 2));
  try {
    await runTests({
      version: '1.96.4',
      vscodeExecutablePath: process.env.IXENA_UNREALTOOLS_TEST_VSCODE || undefined,
      extensionDevelopmentPath: extensionRoot,
      extensionTestsPath: path.join(extensionRoot, 'test', 'host', 'index.cjs'),
      extensionTestsEnv: {
        IXENA_UNREALTOOLS_TEST_NODE: process.execPath,
        IXENA_UNREALTOOLS_TEST_WORKSPACE: workspace,
        IXENA_UNREALTOOLS_TEST_RESULTS: path.join(session, 'results.json')
      },
      launchArgs: [
        workspace,
        '--user-data-dir', path.join(session, 'user-data'),
        '--extensions-dir', path.join(session, 'extensions'),
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-updates',
        '--disable-extensions',
        '--disable-gpu',
        '--no-sandbox'
      ]
    });
    console.log(await fs.readFile(path.join(session, 'results.json'), 'utf8'));
  } finally {
    // 保留失败日志以便查错；临时目录不会进入 VSIX 或源码压缩包。
    console.log(`Extension Host logs: ${session}`);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
