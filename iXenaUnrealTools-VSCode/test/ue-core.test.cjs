'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { inspectUeTask, validatePlan } = require('../dist/ueTaskModel');
const { resolveDotnet, DotnetSelectionCancelledError } = require('../dist/dotnetResolver');

// 用户 UE 生成的真实任务节选：保留全部 24 个任务，不包含无关的插件/包含目录配置。
const generatedTasks = [
  {
    "label": "UE5Test Win64 Debug Build",
    "group": "build",
    "command": "Engine\\Build\\BatchFiles\\Build.bat",
    "args": [
      "UE5Test",
      "Win64",
      "Debug",
      "D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject",
      "-waitmutex"
    ],
    "problemMatcher": "$msCompile",
    "type": "shell",
    "options": {
      "cwd": "D:\\Apps\\UnrealEngine\\UE_5.9"
    }
  },
  {
    "label": "UE5Test Win64 Debug Rebuild",
    "group": "build",
    "command": "Engine\\Build\\BatchFiles\\Build.bat",
    "args": [
      "UE5Test",
      "Win64",
      "Debug",
      "D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject",
      "-waitmutex"
    ],
    "problemMatcher": "$msCompile",
    "dependsOn": [
      "UE5Test Win64 Debug Clean"
    ],
    "type": "shell",
    "options": {
      "cwd": "D:\\Apps\\UnrealEngine\\UE_5.9"
    }
  },
  {
    "label": "UE5Test Win64 Debug Clean",
    "group": "build",
    "command": "Engine\\Build\\BatchFiles\\Clean.bat",
    "args": [
      "UE5Test",
      "Win64",
      "Debug",
      "D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject",
      "-waitmutex"
    ],
    "problemMatcher": "$msCompile",
    "type": "shell",
    "options": {
      "cwd": "D:\\Apps\\UnrealEngine\\UE_5.9"
    }
  },
  {
    "label": "UE5Test Win64 DebugGame Build",
    "group": "build",
    "command": "Engine\\Build\\BatchFiles\\Build.bat",
    "args": [
      "UE5Test",
      "Win64",
      "DebugGame",
      "D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject",
      "-waitmutex"
    ],
    "problemMatcher": "$msCompile",
    "type": "shell",
    "options": {
      "cwd": "D:\\Apps\\UnrealEngine\\UE_5.9"
    }
  },
  {
    "label": "UE5Test Win64 DebugGame Rebuild",
    "group": "build",
    "command": "Engine\\Build\\BatchFiles\\Build.bat",
    "args": [
      "UE5Test",
      "Win64",
      "DebugGame",
      "D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject",
      "-waitmutex"
    ],
    "problemMatcher": "$msCompile",
    "dependsOn": [
      "UE5Test Win64 DebugGame Clean"
    ],
    "type": "shell",
    "options": {
      "cwd": "D:\\Apps\\UnrealEngine\\UE_5.9"
    }
  },
  {
    "label": "UE5Test Win64 DebugGame Clean",
    "group": "build",
    "command": "Engine\\Build\\BatchFiles\\Clean.bat",
    "args": [
      "UE5Test",
      "Win64",
      "DebugGame",
      "D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject",
      "-waitmutex"
    ],
    "problemMatcher": "$msCompile",
    "type": "shell",
    "options": {
      "cwd": "D:\\Apps\\UnrealEngine\\UE_5.9"
    }
  },
  {
    "label": "UE5Test Win64 Development Build",
    "group": "build",
    "command": "Engine\\Build\\BatchFiles\\Build.bat",
    "args": [
      "UE5Test",
      "Win64",
      "Development",
      "D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject",
      "-waitmutex"
    ],
    "problemMatcher": "$msCompile",
    "type": "shell",
    "options": {
      "cwd": "D:\\Apps\\UnrealEngine\\UE_5.9"
    }
  },
  {
    "label": "UE5Test Win64 Development Rebuild",
    "group": "build",
    "command": "Engine\\Build\\BatchFiles\\Build.bat",
    "args": [
      "UE5Test",
      "Win64",
      "Development",
      "D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject",
      "-waitmutex"
    ],
    "problemMatcher": "$msCompile",
    "dependsOn": [
      "UE5Test Win64 Development Clean"
    ],
    "type": "shell",
    "options": {
      "cwd": "D:\\Apps\\UnrealEngine\\UE_5.9"
    }
  },
  {
    "label": "UE5Test Win64 Development Clean",
    "group": "build",
    "command": "Engine\\Build\\BatchFiles\\Clean.bat",
    "args": [
      "UE5Test",
      "Win64",
      "Development",
      "D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject",
      "-waitmutex"
    ],
    "problemMatcher": "$msCompile",
    "type": "shell",
    "options": {
      "cwd": "D:\\Apps\\UnrealEngine\\UE_5.9"
    }
  },
  {
    "label": "UE5Test Win64 Test Build",
    "group": "build",
    "command": "Engine\\Build\\BatchFiles\\Build.bat",
    "args": [
      "UE5Test",
      "Win64",
      "Test",
      "D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject",
      "-waitmutex"
    ],
    "problemMatcher": "$msCompile",
    "type": "shell",
    "options": {
      "cwd": "D:\\Apps\\UnrealEngine\\UE_5.9"
    }
  },
  {
    "label": "UE5Test Win64 Test Rebuild",
    "group": "build",
    "command": "Engine\\Build\\BatchFiles\\Build.bat",
    "args": [
      "UE5Test",
      "Win64",
      "Test",
      "D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject",
      "-waitmutex"
    ],
    "problemMatcher": "$msCompile",
    "dependsOn": [
      "UE5Test Win64 Test Clean"
    ],
    "type": "shell",
    "options": {
      "cwd": "D:\\Apps\\UnrealEngine\\UE_5.9"
    }
  },
  {
    "label": "UE5Test Win64 Test Clean",
    "group": "build",
    "command": "Engine\\Build\\BatchFiles\\Clean.bat",
    "args": [
      "UE5Test",
      "Win64",
      "Test",
      "D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject",
      "-waitmutex"
    ],
    "problemMatcher": "$msCompile",
    "type": "shell",
    "options": {
      "cwd": "D:\\Apps\\UnrealEngine\\UE_5.9"
    }
  },
  {
    "label": "UE5Test Win64 Shipping Build",
    "group": "build",
    "command": "Engine\\Build\\BatchFiles\\Build.bat",
    "args": [
      "UE5Test",
      "Win64",
      "Shipping",
      "D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject",
      "-waitmutex"
    ],
    "problemMatcher": "$msCompile",
    "type": "shell",
    "options": {
      "cwd": "D:\\Apps\\UnrealEngine\\UE_5.9"
    }
  },
  {
    "label": "UE5Test Win64 Shipping Rebuild",
    "group": "build",
    "command": "Engine\\Build\\BatchFiles\\Build.bat",
    "args": [
      "UE5Test",
      "Win64",
      "Shipping",
      "D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject",
      "-waitmutex"
    ],
    "problemMatcher": "$msCompile",
    "dependsOn": [
      "UE5Test Win64 Shipping Clean"
    ],
    "type": "shell",
    "options": {
      "cwd": "D:\\Apps\\UnrealEngine\\UE_5.9"
    }
  },
  {
    "label": "UE5Test Win64 Shipping Clean",
    "group": "build",
    "command": "Engine\\Build\\BatchFiles\\Clean.bat",
    "args": [
      "UE5Test",
      "Win64",
      "Shipping",
      "D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject",
      "-waitmutex"
    ],
    "problemMatcher": "$msCompile",
    "type": "shell",
    "options": {
      "cwd": "D:\\Apps\\UnrealEngine\\UE_5.9"
    }
  },
  {
    "label": "UE5TestEditor Win64 Debug Build",
    "group": "build",
    "command": "Engine\\Build\\BatchFiles\\Build.bat",
    "args": [
      "UE5TestEditor",
      "Win64",
      "Debug",
      "D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject",
      "-waitmutex"
    ],
    "problemMatcher": "$msCompile",
    "type": "shell",
    "options": {
      "cwd": "D:\\Apps\\UnrealEngine\\UE_5.9"
    }
  },
  {
    "label": "UE5TestEditor Win64 Debug Rebuild",
    "group": "build",
    "command": "Engine\\Build\\BatchFiles\\Build.bat",
    "args": [
      "UE5TestEditor",
      "Win64",
      "Debug",
      "D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject",
      "-waitmutex"
    ],
    "problemMatcher": "$msCompile",
    "dependsOn": [
      "UE5TestEditor Win64 Debug Clean"
    ],
    "type": "shell",
    "options": {
      "cwd": "D:\\Apps\\UnrealEngine\\UE_5.9"
    }
  },
  {
    "label": "UE5TestEditor Win64 Debug Clean",
    "group": "build",
    "command": "Engine\\Build\\BatchFiles\\Clean.bat",
    "args": [
      "UE5TestEditor",
      "Win64",
      "Debug",
      "D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject",
      "-waitmutex"
    ],
    "problemMatcher": "$msCompile",
    "type": "shell",
    "options": {
      "cwd": "D:\\Apps\\UnrealEngine\\UE_5.9"
    }
  },
  {
    "label": "UE5TestEditor Win64 DebugGame Build",
    "group": "build",
    "command": "Engine\\Build\\BatchFiles\\Build.bat",
    "args": [
      "UE5TestEditor",
      "Win64",
      "DebugGame",
      "D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject",
      "-waitmutex"
    ],
    "problemMatcher": "$msCompile",
    "type": "shell",
    "options": {
      "cwd": "D:\\Apps\\UnrealEngine\\UE_5.9"
    }
  },
  {
    "label": "UE5TestEditor Win64 DebugGame Rebuild",
    "group": "build",
    "command": "Engine\\Build\\BatchFiles\\Build.bat",
    "args": [
      "UE5TestEditor",
      "Win64",
      "DebugGame",
      "D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject",
      "-waitmutex"
    ],
    "problemMatcher": "$msCompile",
    "dependsOn": [
      "UE5TestEditor Win64 DebugGame Clean"
    ],
    "type": "shell",
    "options": {
      "cwd": "D:\\Apps\\UnrealEngine\\UE_5.9"
    }
  },
  {
    "label": "UE5TestEditor Win64 DebugGame Clean",
    "group": "build",
    "command": "Engine\\Build\\BatchFiles\\Clean.bat",
    "args": [
      "UE5TestEditor",
      "Win64",
      "DebugGame",
      "D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject",
      "-waitmutex"
    ],
    "problemMatcher": "$msCompile",
    "type": "shell",
    "options": {
      "cwd": "D:\\Apps\\UnrealEngine\\UE_5.9"
    }
  },
  {
    "label": "UE5TestEditor Win64 Development Build",
    "group": "build",
    "command": "Engine\\Build\\BatchFiles\\Build.bat",
    "args": [
      "UE5TestEditor",
      "Win64",
      "Development",
      "D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject",
      "-waitmutex"
    ],
    "problemMatcher": "$msCompile",
    "type": "shell",
    "options": {
      "cwd": "D:\\Apps\\UnrealEngine\\UE_5.9"
    }
  },
  {
    "label": "UE5TestEditor Win64 Development Rebuild",
    "group": "build",
    "command": "Engine\\Build\\BatchFiles\\Build.bat",
    "args": [
      "UE5TestEditor",
      "Win64",
      "Development",
      "D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject",
      "-waitmutex"
    ],
    "problemMatcher": "$msCompile",
    "dependsOn": [
      "UE5TestEditor Win64 Development Clean"
    ],
    "type": "shell",
    "options": {
      "cwd": "D:\\Apps\\UnrealEngine\\UE_5.9"
    }
  },
  {
    "label": "UE5TestEditor Win64 Development Clean",
    "group": "build",
    "command": "Engine\\Build\\BatchFiles\\Clean.bat",
    "args": [
      "UE5TestEditor",
      "Win64",
      "Development",
      "D:\\Develop\\UnrealEngine\\UE5Test\\UE5Test.uproject",
      "-waitmutex"
    ],
    "problemMatcher": "$msCompile",
    "type": "shell",
    "options": {
      "cwd": "D:\\Apps\\UnrealEngine\\UE_5.9"
    }
  }
];


const context = { cwd: 'D:\\Develop\\UnrealEngine\\UE5Test', resolve: value => value, scopeKey: 'workspace:project' };
const specs = generatedTasks.map(raw => inspectUeTask(raw, context));
const build = generatedTasks.find(raw => raw.label === 'UE5TestEditor Win64 Development Build');
const copy = value => JSON.parse(JSON.stringify(value));

test('真实 UE workspace: 24 个任务对应 8 个配置，并保持原参数与诊断', () => {
  assert.equal(specs.length, 24);
  assert.ok(specs.every(Boolean));
  assert.equal(new Set(specs.map(spec => spec.configKey)).size, 8);
  for (let index = 0; index < specs.length; index++) {
    const spec = specs[index];
    const original = generatedTasks[index];
    assert.equal(spec.engineRoot, 'D:\\Apps\\UnrealEngine\\UE_5.9');
    assert.deepEqual(spec.problemMatchers, ['$msCompile']);
    assert.deepEqual(spec.args.slice(0, original.args.length), original.args);
    assert.equal(spec.args.filter(arg => arg.toLowerCase() === '-clean').length, spec.action === 'Clean' ? 1 : 0);
  }
});

test('重建精确遵从同一配置的 Clean → Rebuild', () => {
  for (const spec of specs.filter(value => value.action === 'Rebuild')) {
    const plan = validatePlan(spec, specs);
    assert.deepEqual(plan.map(value => value.action), ['Clean', 'Rebuild']);
    assert.equal(plan[0].configKey, spec.configKey);
  }
  for (const spec of specs.filter(value => value.action !== 'Rebuild')) {
    assert.deepEqual(validatePlan(spec, specs), [spec]);
  }
});

test('多根工作区重复标签不会串用另一作用域的清理任务', () => {
  const selected = specs.find(value => value.action === 'Rebuild');
  const clean = specs.find(value => value.label === selected.dependencies[0]);
  const otherScope = { ...clean, scopeKey: 'folder:another-project' };
  assert.equal(validatePlan(selected, [...specs, otherScope])[0], clean);
  assert.throws(() => validatePlan(selected, [otherScope]), /同一任务作用域/);
  assert.throws(() => validatePlan(selected, [...specs, { ...clean }]), /唯一/);
  assert.throws(() => validatePlan(selected, [{ ...clean, configKey: 'different-project' }]), /同一引擎、同一配置/);
});

test('不悄悄丢弃复杂依赖、后台任务和内联 problemMatcher', () => {
  assert.throws(() => validatePlan({ ...specs[0], dependencies: ['Generate assets'] }, specs), /自定义依赖/);
  assert.throws(() => inspectUeTask({ ...build, problemMatcher: { pattern: { regexp: '.*' } } }, context), /内联/);
  assert.throws(() => inspectUeTask({ ...build, problemMatcher: ['$msCompile', { base: '$msCompile' }] }, context), /内联/);
  assert.throws(() => inspectUeTask({ ...build, isBackground: true }, context), /后台/);
  assert.throws(() => inspectUeTask({ ...build, options: { ...build.options, shell: { executable: 'custom.exe' } } }, context), /shell/);
  assert.throws(() => inspectUeTask({ ...build, dependsOn: [{ type: 'npm', script: 'build' }] }, context), /复杂/);
  assert.deepEqual(inspectUeTask({ ...build, problemMatcher: [] }, context).problemMatchers, []);
});

test('路径带空格、ShellQuotedString、相对路径及额外 UBT 参数均保持 argv 边界', () => {
  const raw = copy(build);
  raw.command = { value: '${env:UE_ROOT}\\Engine\\Build\\BatchFiles\\Build.bat', quoting: 2 };
  raw.options.cwd = '..\\UE Engine';
  raw.args[3] = '-Project="D:\\My Games\\Planet Project\\Planet.uproject"';
  raw.args.push({ value: '-Log=D:\\My Logs\\ubt.log', quoting: 2 }, '-NoUBA');
  const customContext = {
    ...context,
    cwd: 'D:\\Workspace\\Project',
    resolve: value => value.replace('${env:UE_ROOT}', 'D:\\UE Engine'),
  };
  const spec = inspectUeTask(raw, customContext);
  assert.equal(spec.engineRoot, 'D:\\UE Engine');
  assert.equal(spec.cwd, 'D:\\Workspace\\UE Engine');
  assert.equal(spec.projectPath, 'D:\\My Games\\Planet Project\\Planet.uproject');
  assert.equal(spec.args[3], '-Project=D:\\My Games\\Planet Project\\Planet.uproject');
  assert.deepEqual(spec.args.slice(-2), ['-Log=D:\\My Logs\\ubt.log', '-NoUBA']);
});

test('不解释自定义 shell、交互变量、多目标、重复项目或重定向', () => {
  assert.equal(inspectUeTask({ label: 'npm', command: 'npm', args: ['build'], type: 'shell' }, context), undefined);
  assert.equal(inspectUeTask({ ...build, command: 'cmd.exe /c "Engine\\Build\\BatchFiles\\Build.bat"' }, context), undefined);
  for (const extra of ['${input:target}', '-Target=Second', '|', '>build.log']) {
    assert.throws(() => inspectUeTask({ ...build, args: [...build.args, extra] }, context));
  }
  assert.throws(() => inspectUeTask({ ...build, args: [...build.args, '-Project=D:\\Other.uproject'] }, context), /只包含一个/);
});

async function fakeEngine(t, versions = ['10.0']) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'starchain-engine-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ubtPath = path.join(root, 'Engine', 'Binaries', 'DotNET', 'UnrealBuildTool', 'UnrealBuildTool.dll');
  await fs.mkdir(path.dirname(ubtPath), { recursive: true });
  await fs.writeFile(ubtPath, 'fixture; not executable');
  const hosts = [];
  for (const version of versions) {
    const file = path.join(root, 'Engine', 'Binaries', 'ThirdParty', 'DotNet', version, 'win-x64', 'dotnet.exe');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'fixture; not executable');
    hosts.push(file);
  }
  return { root, ubtPath, hosts };
}

test('实际版本目录可自动发现，无需假设 10.0.100', async t => {
  const engine = await fakeEngine(t);
  const resolved = await resolveDotnet({ engineRoot: engine.root, platform: 'win32' });
  assert.equal(resolved.dotnetPath, engine.hosts[0]);
  assert.equal(resolved.ubtPath, engine.ubtPath);
  assert.equal(resolved.source, 'bundled-single');
});

test('多个 SDK 时必须精确配置、有效记忆或选择，不能自动取第一个', async t => {
  const engine = await fakeEngine(t, ['8.0.300', '10.0']);
  await assert.rejects(resolveDotnet({ engineRoot: engine.root }), /2 个 .NET 宿主/);
  const configured = await resolveDotnet({ engineRoot: engine.root, env: { DOTNET_HOST_PATH: engine.hosts[1] } });
  assert.equal(configured.dotnetPath, engine.hosts[1]);
  assert.equal(configured.source, 'DOTNET_HOST_PATH');
  const remembered = await resolveDotnet({ engineRoot: engine.root, rememberedPath: engine.hosts[0] });
  assert.equal(remembered.source, 'remembered');
  let shown;
  const chosen = await resolveDotnet({ engineRoot: engine.root, choose: async candidates => { shown = candidates; return candidates[1]; } });
  assert.deepEqual(new Set(shown), new Set(engine.hosts));
  assert.equal(chosen.dotnetPath, engine.hosts[1]);
  assert.equal(chosen.source, 'selected');
  await assert.rejects(resolveDotnet({ engineRoot: engine.root, choose: async () => undefined }), DotnetSelectionCancelledError);
  await assert.rejects(resolveDotnet({ engineRoot: engine.root, choose: async () => '/unexpected/dotnet.exe' }), /不在当前有效候选/);
});

test('忽略另一引擎的环境变量、arm64 与 backup 候选；不忽略显式无效配置', async t => {
  const current = await fakeEngine(t);
  const other = await fakeEngine(t, ['9.0']);
  for (const tail of [['10.0', 'win-arm64'], ['backup', 'win-x64']]) {
    const file = path.join(current.root, 'Engine', 'Binaries', 'ThirdParty', 'DotNet', ...tail, 'dotnet.exe');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'fixture');
  }
  const resolved = await resolveDotnet({ engineRoot: current.root, env: { DOTNET_HOST_PATH: other.hosts[0], DOTNET_ROOT: path.dirname(other.hosts[0]) } });
  assert.equal(resolved.dotnetPath, current.hosts[0]);
  await assert.rejects(resolveDotnet({ engineRoot: current.root, explicitPath: '/missing/dotnet.exe' }), /配置的 dotnetPath/);
  const explicit = await resolveDotnet({ engineRoot: current.root, explicitPath: other.hosts[0] });
  assert.equal(explicit.source, 'explicit');
});

test('源码引擎缺少 UBT 时明确报错，不自行执行批处理初始化', async t => {
  const engine = await fakeEngine(t);
  await fs.unlink(engine.ubtPath);
  await assert.rejects(resolveDotnet({ engineRoot: engine.root }), /官方构建流程完成 UBT 初始化/);
});
