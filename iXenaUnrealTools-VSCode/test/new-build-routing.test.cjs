'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCompileDiagnostic } = require('../dist/compileDiagnostics');
const { editorProbeScript, parseEditorProbe } = require('../dist/editorProcesses');
const { decideBuild } = require('../dist/liveCoding');

test('Live Coding completion never falls back to a second UBT compile', () => {
  assert.equal(decideBuild('auto','UE5TestEditor','completed'),'live-coding');
});
test('Actual MSVC diagnostics survive UE log prefixes with exact file line and column', () => {
  const d = parseCompileDiagnostic(String.raw`LogLiveCoding: Display: D:\开发\SW\PW.cpp(396,144): error C2445: 条件表达式类型不明确`);
  assert.deepEqual(d,{file:String.raw`D:\开发\SW\PW.cpp`,line:395,column:143,severity:'error',code:'C2445',message:'条件表达式类型不明确'});
});
test('Clang diagnostics preserve POSIX path, warning option, and location', () => {
  const d = parseCompileDiagnostic('/Users/x/My Project/Foo.cpp:12:3: warning: unused variable [-Wunused-variable]');
  assert.equal(d.file,'/Users/x/My Project/Foo.cpp'); assert.equal(d.line,11); assert.equal(d.column,2); assert.equal(d.code,'-Wunused-variable');
  for(const value of ['build succeeded','Error: no server','file.cpp:0:1: error: bad','/tmp/x.cpp:1:0: error: bad']) assert.equal(parseCompileDiagnostic(value),undefined);
});
test('Editor probe is read-only, validates identity, and does not inject keys', () => {
  const project=String.raw`D:\开发 & '$\UE5Test.uproject`,engine=String.raw`D:\UE_5.9`;
  const script=editorProbeScript(project,engine);
  assert.ok(!script.includes(project));assert.ok(script.includes(Buffer.from(project).toString('base64')));
  for(const forbidden of ['SendInput','SetForegroundWindow','AppActivate','Stop-Process','taskkill']) assert.ok(!script.includes(forbidden));
  assert.throws(()=>editorProbeScript('relative.uproject',engine));
  assert.equal(parseEditorProbe('IXENA_EDITOR_STATE:running\r\n'),'running');
  assert.throws(()=>parseEditorProbe('IXENA_EDITOR_STATE:running\nIXENA_EDITOR_STATE:not-running'));
});

test('POSIX full-build guard detects Editor launched through PATH, and excludes commandlets', () => {
  const { hasPosixEditorProcess } = require('../dist/editorProcesses');
  for (const line of ['23 UnrealEditor','24 /home/x/Engine/Binaries/Linux/UnrealEditor','25 /Applications/Epic Games/UE/UnrealEditor.app/Contents/MacOS/UnrealEditor','26 UnrealEditor-Li']) assert.equal(hasPosixEditorProcess(line),true,line);
  for (const line of ['23 bash','24 /home/x/UnrealEditor-Cmd','25 helper-UnrealEditor-other','']) assert.equal(hasPosixEditorProcess(line),false,line);
});
