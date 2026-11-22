'use strict';

// 使用真实 VS Code Tasks API 验证事件、停止和 $msCompile 诊断，不模拟 UE 编译器。
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitUntil(check, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await check();
    if (value) return value;
    await pause(50);
  }
  throw new Error(`Condition did not become true within ${timeout} ms`);
}

// 在真实 VS Code TextDocument / WorkspaceEdit 上验证编辑、脏标记、撤销、重做和保存。
// 不向生产扩展添加测试命令；消息入口通过同一个 Provider 的轻量 webview 接口驱动。
async function descriptorHostChecks(root, workspace, extension, results) {
  const { DescriptorEditorProvider, DESCRIPTOR_VIEW_TYPE } = require(path.join(root, 'dist', 'descriptorEditor.js'));
  const filename = path.join(workspace, 'HostDescriptor.uplugin');
  const original = JSON.stringify({ FileVersion: 3, Version: 1, FriendlyName: '星球 🌍',
    VendorExtension: { keep: true },
    Modules: [{ Name: 'PlanetWorld', Type: 'Runtime', LoadingPhase: 'Default', WhitelistPlatforms: ['Win64'], Extra: 11 }]
  }, null, 2) + '\n';
  await fs.writeFile(filename, original);
  const uri = vscode.Uri.file(filename);
  await vscode.commands.executeCommand('vscode.openWith', uri, DESCRIPTOR_VIEW_TYPE);
  await waitUntil(() => vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
    tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === uri.toString()
      && tab.input.viewType === DESCRIPTOR_VIEW_TYPE)));
  results.push('Custom text editor is contributed and opens with vscode.openWith');

  const document = await vscode.workspace.openTextDocument(uri);
  const provider = new DescriptorEditorProvider({ extensionUri: extension.extensionUri,
    subscriptions: [], asAbsolutePath: file => path.join(root, file) }, console.log);
  const disposed = new vscode.EventEmitter();
  const messages = [];
  let receiver;
  const panel = {
    webview: { html: '', options: {}, cspSource: 'https://host-test.vscode-resource/',
      asWebviewUri: value => value,
      postMessage: async value => { messages.push(value); return true; },
      onDidReceiveMessage(callback) { receiver = callback; return new vscode.Disposable(() => {}); }
    },
    onDidDispose: disposed.event,
    visible: true
  };
  await provider.resolveCustomTextEditor(document, panel, { isCancellationRequested: false });
  try {
    await receiver({ type: 'ready' });
    const initialVersion = document.version;
    await receiver({ type: 'edit', requestId: 'host-name', version: initialVersion,
      operation: { type: 'set', path: ['FriendlyName'], value: '可撤销的新名称' } });
    await waitUntil(() => JSON.parse(document.getText()).FriendlyName === '可撤销的新名称');
    const edited = document.getText();
    assert.equal(document.isDirty, true);
    assert.equal(await fs.readFile(filename, 'utf8'), original);
    assert.deepEqual(JSON.parse(edited).Modules, JSON.parse(original).Modules);
    assert.deepEqual(JSON.parse(edited).VendorExtension, { keep: true });

    await receiver({ type: 'edit', requestId: 'host-stale', version: initialVersion,
      operation: { type: 'set', path: ['FriendlyName'], value: '拒绝过期修改' } });
    await waitUntil(() => messages.some(message => message.type === 'error' && message.requestId === 'host-stale'));
    assert.equal(document.getText(), edited);
    results.push('Descriptor provider edits real TextDocument, preserves unknown fields and rejects stale versions');

    await vscode.window.showTextDocument(document, { preview: false });
    await vscode.commands.executeCommand('undo');
    await waitUntil(() => document.getText() === original);
    await vscode.commands.executeCommand('redo');
    await waitUntil(() => document.getText() === edited);
    await receiver({ type: 'save' });
    await waitUntil(() => !document.isDirty);
    assert.equal(await fs.readFile(filename, 'utf8'), edited);
    results.push('Native undo / redo / save persist descriptor changes with shared document synchronization');
  } finally {
    disposed.fire();
    disposed.dispose();
    if (typeof provider.dispose === 'function') provider.dispose();
  }
}

exports.run = async function run() {
  const results = [];
  const root = path.resolve(__dirname, '..', '..');
  const workspace = process.env.IXENA_UNREALTOOLS_TEST_WORKSPACE;
  const sourceFile = path.join(workspace, 'Example.cpp');
  const extension = vscode.extensions.getExtension('ixena-unreal-tools.ixena-unreal-tools');
  assert.ok(extension, 'Development extension is registered');
  await extension.activate();
  assert.ok(extension.isActive, 'Extension activates');
  results.push('VS Code Extension Host: extension activates');
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.some(id => id.startsWith('iXenaUnrealTools.')), 'iXenaUnrealTools commands are registered');
  results.push('iXenaUnrealTools commands are registered');

  const { NativeTaskRunner } = require(path.join(root, 'dist', 'taskRunner.js'));
  const runner = new NativeTaskRunner(message => console.log('[iXenaUnrealTools test]', message));
  const states = [];
  const listener = runner.onDidChangeState(state => states.push(state.status));
  const folder = vscode.workspace.workspaceFolders[0];
  const step = (label, source) => ({
    label,
    scope: folder,
    process: process.env.IXENA_UNREALTOOLS_TEST_NODE,
    args: ['-e', source],
    cwd: workspace,
    env: { ELECTRON_RUN_AS_NODE: '1' },
    problemMatchers: ['$msCompile'],
    presentation: { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Shared, focus: false }
  });

  try {
    const failure = await runner.run('诊断测试', async () => [step('iXenaUnrealTools diagnostic test',
      `console.log(${JSON.stringify(`${sourceFile}(2,5): error C2445: IXENA_UNREALTOOLS_HOST_DIAGNOSTIC`)}); process.exitCode = 1;`
    )]);
    assert.equal(failure.status, 'failed');
    assert.equal(failure.exitCode, 1);
    const diagnostics = await waitUntil(() => {
      const list = vscode.languages.getDiagnostics(vscode.Uri.file(sourceFile));
      return list.some(item => item.message.includes('IXENA_UNREALTOOLS_HOST_DIAGNOSTIC')) && list;
    });
    const diagnostic = diagnostics.find(item => item.message.includes('IXENA_UNREALTOOLS_HOST_DIAGNOSTIC'));
    assert.equal(diagnostic.range.start.line, 1);
    assert.equal(diagnostic.range.start.character, 4);
    assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Error);
    results.push('Native ProcessExecution: failed exit and real $msCompile Problems diagnostic with line/column');

    const success = await runner.run('成功测试', async () => [step('iXenaUnrealTools success test', "console.log('success')")]);
    assert.equal(success.status, 'succeeded');
    assert.equal(runner.isBusy, false);
    results.push('Successful task returns to idle');

    const marker = path.join(workspace, 'must-not-build.txt');
    const rebuild = await runner.run('重建失败测试', async () => [
      step('iXenaUnrealTools clean failure', 'process.exit(2)'),
      step('iXenaUnrealTools build after clean', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'wrong')`)
    ]);
    assert.equal(rebuild.status, 'failed');
    await assert.rejects(fs.access(marker));
    results.push('Failed clean prevents subsequent build');

    const cancellation = runner.run('取消测试', async () => [step('iXenaUnrealTools stop test',
      "console.log('started'); setInterval(() => {}, 1000)"
    )]);
    await waitUntil(() => runner.state.status === 'running');
    runner.cancel();
    const cancelled = await cancellation;
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(runner.isBusy, false);
    assert.ok(states.includes('stopping'));
    results.push('Native task cancellation: running → stopping → idle and cancelled result');

    const pending = runner.run('准备中取消测试', async token => {
      await pause(100);
      assert.equal(token.isCancellationRequested, true);
      return [step('Should not start', 'process.exit(99)')];
    });
    runner.cancel();
    assert.equal((await pending).status, 'cancelled');
    results.push('Cancellation during preparation does not start a process');

    await descriptorHostChecks(root, workspace, extension, results);

    await fs.writeFile(process.env.IXENA_UNREALTOOLS_TEST_RESULTS, JSON.stringify({
      vscode: vscode.version,
      platform: process.platform,
      passed: results,
      limitations: ['Does not run Windows UE, MSVC, UBT, UBA, or Windows Explorer registry integration.']
    }, null, 2));
    console.log('IXENA_UNREALTOOLS_HOST_TESTS_PASSED', results.length);
  } finally {
    listener.dispose();
    runner.dispose();
  }
};
