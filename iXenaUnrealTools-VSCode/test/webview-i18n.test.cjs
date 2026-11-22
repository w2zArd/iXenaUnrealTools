'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {configureI18n}=require('../dist/i18n');
const {WEBVIEW_TRANSLATIONS}=require('../dist/webviewI18n');
const {analyzeDescriptor,rewriteDescriptor}=require('../dist/descriptorModel');
const {rewriteBuildCs}=require('../dist/dependencyModel');

test('descriptor metadata follows language changes while preserving descriptor values and bytes',()=>{
 const source='{"FileVersion":3,"FriendlyName":"已保存","Unknown":"模块"}';
 try {
  configureI18n('en');
  const english=analyzeDescriptor(source,'uplugin');
  assert.equal(english.rootFields.find(f=>f.key==='FriendlyName').label,'Display name');
  assert.equal(english.data.FriendlyName,'已保存');
  assert.equal(rewriteDescriptor(source,'uplugin',{type:'set',path:['FriendlyName'],value:'已保存'}),source);
  configureI18n('zh-CN');
  assert.equal(analyzeDescriptor(source,'uplugin').rootFields.find(f=>f.key==='FriendlyName').label,'显示名称');
 }finally{configureI18n('zh-CN');}
});

test('descriptor and dependency validation messages use English without altering field identifiers',()=>{
 try {
  configureI18n('en');
  assert.throws(()=>rewriteDescriptor('{"FileVersion":3}', 'uplugin', {type:'set',path:['FileVersion'],value:-1}),/FileVersion must be a safe integer/);
  assert.throws(()=>rewriteBuildCs('public class Demo : ModuleRules { public Demo(ReadOnlyTargetRules Target) : base(Target) {} }',['Bad Name'],[],'Demo'),/Dependency names may contain only/);
 }finally{configureI18n('zh-CN');}
});

test('webview translations preserve parameter placeholders and contain no untranslated Chinese prose',()=>{
 for(const [source,english] of Object.entries(WEBVIEW_TRANSLATIONS)){
  const slots=value=>(value.match(/\{\d+\}/g)||[]).sort();
  assert.deepEqual(slots(english),slots(source),source);
  assert.ok(!/\p{Script=Han}/u.test(english),source);
 }
});
