'use strict';
// DOM interaction tests of the production webview JavaScript. Install the isolated dependency with: npm --prefix test/ui ci
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const {parseHTML} = require('linkedom');
const root = path.resolve(__dirname, '..', '..');
const locale = require(path.join(root, 'dist', 'i18n.js'));
const { WEBVIEW_TRANSLATIONS } = require(path.join(root, 'dist', 'webviewI18n.js'));
const localeSource = fs.readFileSync(path.join(root, 'resources', 'webviewI18n.js'), 'utf8');
const model = require(path.join(root, 'dist', 'descriptorModel.js'));
const oldLoad = Module._load;
Module._load = function(request, parent, main) {
  if (request === 'vscode') return {Uri: {joinPath: (base, ...parts) => ({toString:()=>path.join(base.fsPath,...parts)})}};
  return oldLoad.call(this, request, parent, main);
};
let editor;
try { editor = require(path.join(root, 'dist', 'descriptorEditor.js')); }
finally { Module._load = oldLoad; }
const html = editor.descriptorEditorHtml({cspSource:'https://unit.local/',asWebviewUri:uri=>uri},{fsPath:root});
const sourceCode = fs.readFileSync(path.join(root,'resources','descriptorEditor.js'),'utf8');

function setup(data, savedState, language = 'zh-CN') {
  locale.configureI18n(language);
  const localizedHtml = editor.descriptorEditorHtml({cspSource:'https://unit.local/',asWebviewUri:uri=>uri},{fsPath:root});
  const {window, document} = parseHTML(localizedHtml);
  window.scrollTo = () => {};
  window.scrollY = 0;
  // linkedom supplies a getter-only select.value. Supply the standard browser setter for interaction tests.
  const select = window.HTMLSelectElement.prototype;
  const valueProperty = Object.getOwnPropertyDescriptor(select, 'value');
  const selectValues = new WeakMap();
  Object.defineProperty(select, 'value', {configurable: true,
    get() { return selectValues.has(this) ? selectValues.get(this) : valueProperty.get.call(this); },
    set(value) { selectValues.set(this,String(value)); }
  });
  let active;
  Object.defineProperty(document,'activeElement',{configurable:true,get:()=>active});
  window.HTMLElement.prototype.focus = function(){active=this;};
  const queue = [], all = [];
  let stored = savedState;
  let source = typeof data === 'string' ? data : JSON.stringify(data,null,2)+'\n';
  let disk = source, version = 1, dirty = false;
  const context = vm.createContext({window,document,console,setTimeout,clearTimeout,
    requestAnimationFrame: callback => callback(),
    acquireVsCodeApi: () => ({getState:()=>stored,setState:value=>{stored=value;},postMessage:value=>{queue.push(value);all.push(value);}})});
  vm.runInContext(localeSource, context, {filename:'webviewI18n.js'});
  vm.runInContext(sourceCode, context, {filename:'descriptorEditor.js'});
  assert.equal(queue.shift().type,'ready');
  function event(target, type, properties={}) {
    const event = new window.Event(type,{bubbles:true,cancelable:true});
    Object.assign(event,properties); target.dispatchEvent(event); return event;
  }
  function snapshot(reason, requestId) {
    return {type:'state',...model.analyzeDescriptor(source,'uplugin'),version,kind:'uplugin',filename:'PlanetWorld.uplugin',
      filePath:'D:\\Project\\PlanetWorld.uplugin',dirty,source,reason,requestId};
  }
  function send(value) {event(window,'message',{data:value});}
  function ack() {
    assert.ok(queue.length,'A client message is queued');
    const message=queue.shift();
    if(message.type==='edit') {
      try {
        model.assertDescriptorVersion(version,message.version);
        const plan=model.planDescriptorEdit(source,'uplugin',message.operation);
        if(plan.edits.length){source=plan.source;version+=1;dirty=true;}
        send(snapshot('applied',message.requestId));
      } catch(error){send({type:'error',requestId:message.requestId,message:error.message,conflict:message.version!==version});}
    } else if(message.type==='save') {disk=source;dirty=false;send(snapshot('saved',message.requestId));}
    else if(message.type==='reload') send(snapshot('reload'));
    return message;
  }
  function input(id,value,properties={}) {
    const node=document.getElementById(id);assert.ok(node,`Input ${id} exists`);node.focus();node.value=value;
    event(node,node.tagName==='SELECT'?'change':'input',properties);return node;
  }
  function button(text) {const node=[...document.querySelectorAll('button')].find(node=>node.textContent===text);assert.ok(node,`Button ${text} exists`);event(node,'click');return node;}
  send(snapshot('ready'));
  return {window,document,queue,all,event,input,button,ack,send,
    state:()=>snapshot('inspect'),stored:()=>stored,disk:()=>disk,
    external(next){source=JSON.stringify(next,null,2)+'\n';version+=1;dirty=true;send(snapshot('document'));}
  };
}
const data=()=>({FileVersion:3,Version:1,FriendlyName:'星球插件',
  Modules:[{Name:'PlanetWorld',Type:'Runtime',LoadingPhase:'Default',WhitelistPlatforms:['Win64'],VendorField:'keep'}],
  Plugins:[{Name:'EnhancedInput',Enabled:true}],UnknownRoot:{keep:17}});

test('webview renders untrusted labels as text and does not apply default values',()=>{
  const value=data();value.FriendlyName='<img src=x onerror=alert(1)>';
  const h=setup(value);
  assert.equal(h.document.getElementById('field-FriendlyName').value,value.FriendlyName);
  assert.equal(h.document.querySelectorAll('img').length,0);
  assert.equal(h.queue.length,0);
  assert.equal(h.document.getElementById('save-state').textContent,'已保存');
});

test('webview presents invalid collection structures instead of crashing before render',()=>{
  for(const invalid of [{Modules:{}},{Plugins:123},{Modules:[null]}]){
    const h=setup({...data(),...invalid});
    assert.match(h.document.getElementById('content').textContent,/请先修复 JSON/);
    assert.equal(h.document.getElementById('save').disabled,true);
    assert.equal(h.queue.length,0);
  }
});

test('rapid field typing retains latest draft and Ctrl+S waits for both acknowledgements',()=>{
  const h=setup(data());
  h.input('field-FriendlyName','Alpha');
  h.input('field-FriendlyName','AlphaBeta');
  h.event(h.document,'keydown',{ctrlKey:true,key:'s'});
  assert.equal(h.queue.length,1);
  assert.equal(h.queue[0].operation.value,'Alpha');
  h.ack();
  assert.equal(h.document.getElementById('field-FriendlyName').value,'AlphaBeta');
  assert.equal(h.queue.length,1);
  assert.equal(h.queue[0].operation.value,'AlphaBeta');
  h.ack();
  assert.equal(h.queue[0].type,'save');
  h.ack();
  assert.equal(JSON.parse(h.disk()).FriendlyName,'AlphaBeta');
  assert.equal(h.document.getElementById('save-state').textContent,'已保存');
});

test('invalid number input cannot be saved or silently labeled saved',()=>{
  const h=setup(data());
  h.input('field-Version','invalid');
  h.event(h.document,'keydown',{ctrlKey:true,key:'s'});
  assert.equal(h.queue.length,0);
  assert.equal(h.document.getElementById('field-Version').value,'invalid');
  assert.equal(h.document.getElementById('save-state').textContent,'输入未应用');
  assert.equal(h.document.getElementById('save').disabled,true);
  assert.equal(JSON.parse(h.disk()).Version,1);
});

test('external modifications preserve invalid drafts and require explicit resynchronization',()=>{
  const h=setup(data());
  h.input('field-Version','in-progress');
  h.external({...data(),FriendlyName:'外部更改'});
  assert.equal(h.document.getElementById('field-Version').value,'in-progress');
  assert.equal(h.document.getElementById('save-state').textContent,'需要同步');
  assert.equal(h.queue.length,0);
  h.button('重新读取（放弃未应用输入）');h.ack();
  assert.equal(h.document.getElementById('field-Version').value,'1');
  assert.equal(h.document.getElementById('field-FriendlyName').value,'外部更改');
});

test('switching to source waits for valid field edits to reach the document',()=>{
  const h=setup(data());h.input('field-FriendlyName','准备切换源码');h.button('JSON 源码');
  assert.equal(h.queue.length,1);assert.equal(h.queue[0].type,'edit');
  h.ack();assert.equal(h.queue.length,1);assert.equal(h.queue[0].type,'source');
  assert.equal(h.state().data.FriendlyName,'准备切换源码');
});

test('IME composition neither submits partial Chinese input nor discards it after an external update',()=>{
  const h=setup(data());const field=h.document.getElementById('field-FriendlyName');field.focus();
  h.event(field,'compositionstart');field.value='xing';h.event(field,'input',{isComposing:true});
  assert.equal(h.queue.length,0);
  h.external({...data(),FriendlyName:'外部名称'});
  assert.equal(h.document.getElementById('field-FriendlyName'),field,'Composing DOM input remains mounted');
  field.value='星链世界';h.event(field,'compositionend');
  assert.equal(h.queue.length,0,'External version change blocks submitting the composition over it');
  assert.equal(h.document.getElementById('field-FriendlyName').value,'星链世界');
  assert.equal(h.document.getElementById('save-state').textContent,'需要同步');
});

test('row removal cannot race outstanding edits and retains the remaining row identity',()=>{
  const value=data();value.Modules.push({Name:'PlanetWorldEditor',Type:'Editor',Custom:'untouched'});
  const h=setup(value);h.event(h.document.querySelector('[data-tab="modules"]'),'click');
  h.input('field-Modules-0-Name','RenamedPlanet');
  h.button('移除');h.button('确认移除');
  assert.equal(h.queue.length,1);assert.equal(h.queue[0].operation.type,'set');
  assert.match(h.document.getElementById('notices').textContent,/先完成/);
  h.ack();h.button('确认移除');
  assert.equal(h.queue[0].operation.type,'remove');h.ack();
  assert.equal(h.state().data.Modules.length,1);
  assert.equal(h.state().data.Modules[0].Name,'PlanetWorldEditor');
  assert.equal(h.state().data.Modules[0].Custom,'untouched');
});

test('an existing legacy platform key is shown as legacy without silently creating modern keys',()=>{
  const h=setup(data());h.event(h.document.querySelector('[data-tab="modules"]'),'click');
  assert.ok(h.document.getElementById('field-Modules-0-WhitelistPlatforms'));
  assert.equal(h.document.getElementById('field-Modules-0-PlatformAllowList'),null);
  h.input('field-Modules-0-LoadingPhase','PostEngineInit');h.ack();
  assert.deepEqual(h.state().data.Modules[0].WhitelistPlatforms,['Win64']);
  assert.equal('PlatformAllowList' in h.state().data.Modules[0],false);
});

test('English descriptor UI localizes static text, field metadata and validation without translating project values', () => {
  const value = data(); value.FriendlyName = '已保存';
  const h = setup(value, undefined, 'en');
  assert.equal(h.document.documentElement.lang, 'en');
  assert.equal(h.document.getElementById('source').textContent, 'JSON source');
  assert.match(h.document.getElementById('save').textContent, /Save/);
  assert.equal(h.document.getElementById('save-state').textContent, 'Saved');
  assert.equal(h.document.getElementById('field-FriendlyName').value, '已保存');
  assert.ok([...h.document.querySelectorAll('label')].some(node => node.textContent === 'Display name'));
  h.input('field-Version', 'invalid');
  assert.match(h.document.querySelector('[aria-invalid="true"]').parentElement.textContent, /Enter an integer/);
  assert.equal(h.queue.length, 0);
});

test('switching descriptor language preserves invalid drafts, document bytes and save queue', () => {
  const h = setup(data());
  const original = h.state().source;
  h.input('field-Version', '保留这个输入');
  const draftCount = h.stored().drafts.length;
  locale.configureI18n('en');
  const analysis = model.analyzeDescriptor(original, 'uplugin');
  h.send({type:'language',language:'en',messages:WEBVIEW_TRANSLATIONS,
    rootFields:analysis.rootFields,moduleFields:analysis.moduleFields,pluginFields:analysis.pluginFields});
  assert.equal(h.document.documentElement.lang,'en');
  assert.equal(h.document.getElementById('field-Version').value,'保留这个输入');
  assert.equal(h.stored().drafts.length,draftCount);
  assert.equal(h.state().source,original);
  assert.equal(h.queue.length,0);
  assert.equal(h.document.getElementById('save-state').textContent,'Input not applied');
  assert.match(h.document.getElementById('content').textContent,/Enter an integer/);
  locale.configureI18n('zh-CN');
});
