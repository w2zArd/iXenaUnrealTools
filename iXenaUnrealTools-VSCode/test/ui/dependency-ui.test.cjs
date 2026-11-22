'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { parseHTML } = require('linkedom');
const root = path.resolve(__dirname, '../..');
const locale = require(path.join(root, 'dist/i18n.js'));
const { WEBVIEW_TRANSLATIONS } = require(path.join(root, 'dist/webviewI18n.js'));
const oldLoad = Module._load;
Module._load = function(request, parent, main) {
  if (request === 'vscode') return { Uri:{joinPath:(base,...parts)=>({toString:()=>path.join(base.fsPath,...parts)})} };
  return oldLoad.call(this,request,parent,main);
};
let editor;
try { editor = require(path.join(root,'dist/dependencyEditor.js')); } finally { Module._load=oldLoad; }
const localeSource = fs.readFileSync(path.join(root,'resources/webviewI18n.js'),'utf8');
function setup(language) {
  locale.configureI18n(language);
  const html = editor.dependencyEditorHtml({cspSource:'https://unit.local',asWebviewUri:uri=>uri},'test-nonce',{fsPath:root});
  const {window,document}=parseHTML(html);
  const messages=[];
  const context=vm.createContext({window,document,console,acquireVsCodeApi:()=>({postMessage:m=>messages.push(m)})});
  vm.runInContext(localeSource,context);
  const inline=[...document.querySelectorAll('script')].find(node=>!node.getAttribute('src'));
  vm.runInContext(inline.textContent,context);
  assert.equal(messages.shift().type,'ready');
  const send=m=>{const event=new window.Event('message');event.data=m;window.dispatchEvent(event);};
  const click=id=>document.getElementById(id).dispatchEvent(new window.Event('click'));
  send({type:'init',module:'UE5Test',file:'/Game/UE5Test.Build.cs',suggestions:['Core','Engine','Networking'],public:['Core'],private:['Engine'],publicEditable:true,privateEditable:true});
  return {document,messages,send,click};
}

test('dependency webview switches language without discarding unapplied module lists or search text',()=>{
  const h=setup('zh-CN');
  h.document.getElementById('search').value='Networking';
  h.click('add-public');
  assert.match(h.document.getElementById('public-list').textContent,/Networking/);
  h.send({type:'language',language:'en',messages:WEBVIEW_TRANSLATIONS});
  assert.equal(h.document.documentElement.lang,'en');
  assert.equal(h.document.getElementById('source').textContent,'Open Build.cs');
  assert.equal(h.document.getElementById('dirty').textContent,'● Unapplied changes');
  assert.equal(h.document.getElementById('search').value,'Networking');
  h.click('apply');
  assert.deepEqual(Array.from(h.messages[0].public),['Core','Networking']);
  assert.deepEqual(Array.from(h.messages[0].private),['Engine']);
  locale.configureI18n('zh-CN');
});

test('English dependency webview translates validation and leaves module identifiers unchanged',()=>{
  const h=setup('en');
  assert.equal(h.document.querySelector('h1').textContent,'Module dependency manager');
  assert.equal(h.document.getElementById('module').textContent,'UE5Test · ModuleRules');
  h.document.getElementById('search').value='Bad Name';h.click('add-private');
  assert.match(h.document.getElementById('status').textContent,/Module names may contain only/);
  assert.equal(h.messages.length,0);
  locale.configureI18n('zh-CN');
});
