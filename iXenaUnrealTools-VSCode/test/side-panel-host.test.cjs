'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
function makeMock(projectDir) {
  const commands = new Map(), views = new Map(), contexts = new Map(), events = [], executed = [];
  let picker = items => items.find(item => item.label.includes('PlanetWorld'));
  class Emitter {
    event = () => ({ dispose() {} });
    fire(value) { events.push(value); }
    dispose() {}
  }
  class ThemeIcon { constructor(id) { this.id=id; } }
  class TreeItem { constructor(label,state) { this.label=label; this.collapsibleState=state; } }
  let legacy = [{label:'✳️ 公有',roots:['${workspaceFolder:➡️ 当前项目}/Source/UE5Test/Public']}];
  const folder = {name:'➡️ 当前项目',uri:{scheme:'file',fsPath:projectDir}};
  const api = {
    EventEmitter: Emitter,ThemeIcon,TreeItem,
    TreeItemCollapsibleState:{None:0,Collapsed:1,Expanded:2},
    Uri:{file:f=>({scheme:'file',fsPath:f})},
    workspace:{
      workspaceFolders:[folder],
      workspaceFile:{scheme:'file',fsPath:path.join(projectDir,'Project.code-workspace')},
      getConfiguration:(section)=>({
        inspect:(prop)=>({ workspaceValue:section==='multiExplorer'&&prop==='panes'?legacy:undefined }),
        get:(prop,defaultValue)=>defaultValue
      }),
      onDidChangeConfiguration:()=>({dispose(){}}),
      onDidChangeWorkspaceFolders:()=>({dispose(){}}),
      createFileSystemWatcher:()=>({
        dispose(){}, onDidChange:()=>({dispose(){}}),onDidCreate:()=>({dispose(){}}),onDidDelete:()=>({dispose(){}})
      })
    },
    window:{
      createTreeView:(name,options)=>{views.set(name,options.treeDataProvider);return { description:'',dispose(){} };},
      showQuickPick:async items=>picker(items),
      showInformationMessage:async()=>undefined
    },
    commands:{
      registerCommand:(name,fn)=>{commands.set(name,fn);return{dispose(){commands.delete(name);}};},
      executeCommand:async(name,key,value)=>{executed.push({name,key,value});if(name==='setContext'){contexts.set(key,value);} }
    }
  };
  return { api, views, commands, contexts, executed, setLegacy:(v)=>{legacy=v;}, setPicker:fn=>{picker=fn;}, folder };
}
function loadModule(api) {
  const filename=path.resolve(__dirname,'../dist/sidePanel.js');
  const old=Module._load; delete require.cache[filename];
  Module._load=function(request,parent,isMain){if(request==='vscode')return api;return old.call(this,request,parent,isMain);};
  try{return require(filename);}finally{Module._load=old;}
}
test('扩展侧面板可读取旧工作区分栏，切换插件，并在没有配置时隐藏资源视图', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'ixena-side-panel-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const mk=async(name)=>{const location=path.join(root,name);await fs.mkdir(path.dirname(location),{recursive:true});await fs.writeFile(location,'');};
  await mk('UE5Test.uproject');
  await mk('Source/UE5Test/UE5Test.Build.cs');
  await mk('Source/UE5Test.Target.cs');
  await mk('Source/UE5Test/Public/SWActor.h');
  await mk('Plugins/PlanetWorld/PlanetWorld.uplugin');
  await mk('Plugins/PlanetWorld/Source/PlanetWorld/PlanetWorld.Build.cs');
  await mk('Plugins/PlanetWorld/Source/PlanetWorld/Public/PWPlanet.h');
  const fake = makeMock(root);
  const {UnrealSidePanel}=loadModule(fake.api);
  const state={value:undefined,async update(_k,v){this.value=v;},get(){return this.value;}};
  const panel = new UnrealSidePanel({workspaceState:state}, {selectedProject:()=>undefined,output:()=>{}});
  try {
    await panel.refresh(true);
    assert.equal(fake.contexts.get('iXenaUnrealTools.explorerConfigured'),true);
    assert.equal(panel.projects.length,1);
    assert.equal(panel.modules.length,2);
    const explorer=fake.views.get('ixenaUnrealTools.explorer');
    assert.deepEqual((await explorer.getChildren()).map(n=>n.label),['✳️ 公有']);
    const items=await explorer.getChildren((await explorer.getChildren())[0]);
    assert.equal(items.some(n=>n.label==='SWActor.h'),true);
    await fake.commands.get('iXenaUnrealTools.selectExplorerScope')();
    assert.equal(state.value.startsWith('plugin:'),true);
    const sections=await explorer.getChildren();
    assert.equal(sections.some(n=>n.label==='Public'),true);
    const rules=fake.views.get('ixenaUnrealTools.rules');
    const roots=await rules.getChildren();
    assert.deepEqual(roots.map(n=>n.label),['主项目 · UE5Test','插件 · 1']);
    const main=await rules.getChildren(roots[0]);
    assert.equal(main[0].label,'UE5Test.uproject');
    assert.equal(main[0].type,'descriptor');
    const command=rules.getTreeItem(main[0]).command;
    assert.equal(command.command,'iXenaUnrealTools.editDescriptor');
    assert.equal(command.arguments[0].fsPath,path.join(root,'UE5Test.uproject'));
    assert.ok(main.some(n=>n.label==='Targets · Target.cs'));
    assert.ok(main.some(n=>n.label==='Modules · Build.cs'));
    const targetFiles=await rules.getChildren(main.find(n=>n.label.startsWith('Targets')));
    assert.equal(targetFiles[0].label,'UE5Test.Target.cs');
    const pluginGroups=await rules.getChildren(roots[1]);
    assert.equal(pluginGroups[0].label,'PlanetWorld');
    const pluginNodes=await rules.getChildren(pluginGroups[0]);
    assert.equal(pluginNodes[0].label,'PlanetWorld.uplugin');
    assert.equal(pluginNodes[0].type,'descriptor');
    assert.ok(pluginNodes.some(n=>n.label==='Modules · Build.cs'));

    fake.setPicker(items=>items.find(n=>n.actionKind==='descriptor'&&n.filename.endsWith('PlanetWorld.uplugin')));
    await fake.commands.get('iXenaUnrealTools.selectRuleFile')();
    assert.equal(fake.executed.at(-1).name,'iXenaUnrealTools.editDescriptor');
    assert.equal(fake.executed.at(-1).key.fsPath,path.join(root,'Plugins','PlanetWorld','PlanetWorld.uplugin'));
    fake.setPicker(items=>items.find(n=>n.actionKind==='dependencies'&&n.module.name==='PlanetWorld'));
    await fake.commands.get('iXenaUnrealTools.selectRuleFile')();
    assert.equal(fake.executed.at(-1).name,'iXenaUnrealTools.editDependencies');
    assert.equal(fake.executed.at(-1).key.module.name,'PlanetWorld');
    fake.setPicker(items=>items.find(n=>n.actionKind==='source'&&n.filename.endsWith('UE5Test.Target.cs')));
    await fake.commands.get('iXenaUnrealTools.selectRuleFile')();
    assert.equal(fake.executed.at(-1).name,'vscode.open');
    assert.equal(fake.executed.at(-1).key.fsPath,path.join(root,'Source','UE5Test.Target.cs'));

    fake.setLegacy(undefined);
    await panel.refresh(false);
    assert.equal(fake.contexts.get('iXenaUnrealTools.explorerConfigured'),false);
  } finally { panel.dispose(); }
});
