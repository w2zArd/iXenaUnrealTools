'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const i18n = require('../dist/i18n');
const { coreTranslations } = require('../dist/locales/core');
const { unrealClassTemplates, makeClassPlan, validateModuleName, makeCustomTemplate } = require('../dist/classTemplates');

test('language selection follows Chinese VSCode locales and falls back to English, with explicit overrides', () => {
  for (const locale of ['zh-cn','zh-tw','zh-Hant','zh']) assert.equal(i18n.resolveLanguage('auto',locale),'zh-CN');
  for (const locale of ['en','de','ja','ko','']) assert.equal(i18n.resolveLanguage('auto',locale),'en');
  assert.equal(i18n.resolveLanguage('zh-CN','en'),'zh-CN');
  assert.equal(i18n.resolveLanguage('en','zh-cn'),'en');
  assert.equal(i18n.resolveLanguage('unexpected','fr'),'en');
});

test('runtime language notifications update actual text once and dispose cleanly', () => {
  i18n.configureI18n('zh-CN');
  const observed=[];
  const subscription=i18n.onDidChangeLanguage(()=>observed.push(i18n.t('开始调试')));
  try {
    i18n.configureI18n('en');
    i18n.configureI18n('en');
    i18n.configureI18n('zh-CN');
    assert.deepEqual(observed,['Start Debugging','开始调试']);
    subscription.dispose();
    i18n.configureI18n('en');
    assert.equal(observed.length,2);
  } finally {subscription.dispose();i18n.configureI18n('zh-CN');}
});

test('substitutions preserve user strings, paths, technical tokens and literal braces', () => {
  i18n.configureI18n('en');
  try {
    const userValue=String.raw`D:\Projects\中文 {1} $&\UE5Test.uproject`;
    assert.equal(i18n.t('项目文件不存在：{0}',userValue),`The project file does not exist: ${userValue}`);
    assert.equal(i18n.tr('值 {0} / {1}','Value {0} / {1}',userValue,'{0}'),`Value ${userValue} / {0}`);
    assert.equal(i18n.t('Unknown technical identifier'),'Unknown technical identifier');
    assert.equal(i18n.t('未注册的可读消息'),'未注册的可读消息');
  } finally {i18n.configureI18n('zh-CN');}
});

test('English class labels and errors do not change generated Chinese source comments or C++ identifiers', () => {
  i18n.configureI18n('en');
  try {
    assert.equal(i18n.t(unrealClassTemplates.find(x=>x.id==='Character').description),'Pawn with character movement');
    assert.equal(i18n.t(unrealClassTemplates.find(x=>x.id==='PlainCpp').label),'Plain C++ class');
    assert.match(validateModuleName('bad module'),/valid C\+\+ identifier/);
    const template=unrealClassTemplates.find(x=>x.id==='Character');
    const plan=makeClassPlan({moduleName:'UE5Test',moduleDirectory:path.resolve('test-module'),template,inputName:'ExampleCharacter',visibility:'Public'});
    assert.match(plan.header,/所属模块：UE5Test/);
    assert.match(plan.header,/带角色移动能力的 Pawn/);
    assert.match(plan.header,/UE5TEST_API AExampleCharacter : public ACharacter/);
    const custom=makeCustomTemplate('AExampleBase','Characters/ExampleBase.h',[]);
    const customPlan=makeClassPlan({moduleName:'UE5Test',moduleDirectory:path.resolve('test-module'),template:custom,inputName:'ExampleChild',visibility:'Private'});
    assert.match(customPlan.header,/继承已有父类/);
  } finally {i18n.configureI18n('zh-CN');}
});

test('every translated runtime message preserves its positional placeholders', () => {
  for(const [source,translated] of Object.entries(coreTranslations)) {
    const slots=x=>[...x.matchAll(/\{\d+\}/g)].map(v=>v[0]).sort();
    assert.deepEqual(slots(translated),slots(source),source);
    assert.doesNotMatch(translated,/\p{Script=Han}/u,source);
  }
});

test('core runtime t calls have English catalog entries, excluding preserved code and user data', () => {
  const ts = require('typescript');
  const files=['classTemplates','classWizard','dotnetResolver','editorBridge','editorProcesses','engineSupport','explorerIntegration','explorerModel','extension','liveCoding','sidePanel','sourceSwitcher','taskRunner','ueConsole','ueExtras','ueTaskModel','ueWorkspace','workspaceModel'];
  for(const name of files){
    const text=fs.readFileSync(path.join(__dirname,'..','src',name+'.ts'),'utf8');
    const source=ts.createSourceFile(name+'.ts',text,ts.ScriptTarget.Latest,true);
    function walk(node){
      if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='t'&&node.arguments.length&&ts.isStringLiteral(node.arguments[0])){
        const key=node.arguments[0].text;
        if(/\p{Script=Han}/u.test(key)) assert.equal(typeof coreTranslations[key],'string',`${name}: ${key}`);
      }
      ts.forEachChild(node,walk);
    }walk(source);
  }
});

test('sidebar groups and action labels rebuild in English and retain the one initialization action', async () => {
  i18n.configureI18n('zh-CN');
  const views=new Map();let changes=0;
  class Emitter{event=()=>({dispose(){}});fire(){changes++;}dispose(){}}
  class TreeItem{constructor(label,state){this.label=label;this.collapsibleState=state;}}
  const disposable=()=>({dispose(){}});
  const api={EventEmitter:Emitter,ThemeIcon:class{constructor(id){this.id=id;}},TreeItem,
    TreeItemCollapsibleState:{None:0,Collapsed:1},
    Uri:{file:f=>({scheme:'file',fsPath:f})},
    workspace:{workspaceFolders:[],getConfiguration:()=>({inspect:()=>undefined,get:(_k,f)=>f}),
      onDidChangeConfiguration:disposable,onDidChangeWorkspaceFolders:disposable,
      createFileSystemWatcher:()=>({dispose(){},onDidChange:disposable,onDidCreate:disposable,onDidDelete:disposable})},
    window:{createTreeView:(id,options)=>{views.set(id,options.treeDataProvider);return disposable();}},
    commands:{registerCommand:disposable,executeCommand:async()=>undefined}};
  const filename=path.resolve(__dirname,'../dist/sidePanel.js');const previous=Module._load;
  delete require.cache[filename];
  Module._load=function(name,parent,isMain){return name==='vscode'?api:previous.call(this,name,parent,isMain);};
  let Panel;
  try{Panel=require(filename).UnrealSidePanel;}finally{Module._load=previous;}
  const panel=new Panel({workspaceState:{get:()=>undefined,update:async()=>{}}},{selectedProject:()=>undefined,output:()=>{}});
  try{
    const actions=views.get('ixenaUnrealTools.actions');
    assert.equal((await actions.getChildren())[0].label,'编译与调试');
    i18n.configureI18n('en');
    await new Promise(resolve=>setImmediate(resolve));
    const roots=await actions.getChildren();
    assert.equal(roots[0].label,'Build and Debug');
    const tools=await roots.find(x=>x.label==='Unreal Engine Tools').children();
    assert.equal(tools.filter(x=>x.commandId==='iXenaUnrealTools.initializeEnginePlugin').length,1);
    assert.equal(tools.find(x=>x.commandId==='iXenaUnrealTools.initializeEnginePlugin').label,'Initialize Engine Plugin');
    assert.ok(changes>0);
    i18n.configureI18n('zh-CN');
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal((await actions.getChildren())[0].label,'编译与调试');
  }finally{panel.dispose();i18n.configureI18n('zh-CN');}
});
