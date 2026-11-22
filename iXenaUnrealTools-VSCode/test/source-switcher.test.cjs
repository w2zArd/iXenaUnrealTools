'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
function harness(fileList = [], options = {}) {
  const shown = [], notices = [], searches = [], picked = [];
  class Uri {
    constructor(fsPath) { this.scheme='file'; this.fsPath=fsPath; }
    static file(fsPath) { return new Uri(fsPath); }
  }
  class RelativePattern {
    constructor(base, pattern) { this.base = base; this.pattern = pattern; }
  }
  const fake = {
    Uri, RelativePattern, FileType: { File: 1, Directory: 2 },
    window: {
      activeTextEditor: {document: {uri: Uri.file(options.active || '/not-a-header.txt')}},
      showTextDocument: async (uri) => { shown.push(uri.fsPath); },
      showInformationMessage: async (message) => { notices.push(message); },
      showQuickPick: async (items) => { picked.push(items); return options.select?.(items); }
    },
    workspace: {
      fs: {stat: async uri => {
        if (fileList.includes(uri.fsPath) && !options.onlyIndexed?.includes(uri.fsPath)) return {type:1};
        throw Object.assign(new Error('Not found'), {code:'ENOENT'});
      }},
      getWorkspaceFolder: uri => ({uri: Uri.file(options.workspace || '/Game')}),
      findFiles: async (glob, exclusion, maxResults) => {
        searches.push({scope:glob.base,pattern:glob.pattern,exclusion,maxResults});
        const result = options.indexedFiles || [];
        if (options.scoped) return result.filter(file => file.startsWith(glob.base + '/')).map(Uri.file);
        return result.map(Uri.file);
      }
    }
  };
  const filename = path.resolve(__dirname,'../dist/sourceSwitcher.js');
  const old = Module._load;
  delete require.cache[filename];
  Module._load = function(request,parent,isMain) { if (request === 'vscode') return fake; return old.call(this,request,parent,isMain); };
  let source;
  try { source = require(filename); } finally { Module._load = old; }
  return { ...source, Uri, shown, notices, searches, picked };
}

test('Editor menu opens Public↔Private matching file without invoking workspace search', async () => {
  const header = '/Game/Source/Game/Public/HUD/Foo.h';
  const source = '/Game/Source/Game/Private/HUD/Foo.cpp';
  const h = harness([header, source]);
  await h.switchHeaderSource(h.Uri.file(header));
  await h.switchHeaderSource(h.Uri.file(source));
  assert.deepEqual(h.shown, [source, header]);
  assert.deepEqual(h.searches, []);
});

test('Command palette uses active file when no URI argument is supplied', async () => {
  const header = '/Game/Source/Game/Public/Foo.h';
  const source = '/Game/Source/Game/Private/Foo.cpp';
  const h = harness([source], {active: header});
  await h.switchHeaderSource();
  assert.deepEqual(h.shown, [source]);
});

test('Indexed search stays inside source module and picks unique match', async () => {
  const origin = '/Game/Plugins/Foo/Source/Foo/Public/FooBar.h';
  const match = '/Game/Plugins/Foo/Source/Foo/Private/Helpers/FooBar.cpp';
  const wrong = '/Game/Source/Game/Private/Helpers/FooBar.cpp';
  const h = harness([], {indexedFiles:[match,wrong],scoped:true, workspace:'/Game'});
  await h.switchHeaderSource(h.Uri.file(origin));
  assert.deepEqual(h.shown,[match]);
  assert.equal(h.searches.length,1);
  assert.equal(h.searches[0].scope,'/Game/Plugins/Foo/Source/Foo');
  assert.equal(h.searches[0].pattern,'**/FooBar.{cpp,cc,cxx,c}');
});

test('Ambiguous same-name matches require QuickPick instead of choosing wrong class', async () => {
  const first='/Game/Source/Game/Private/A/Foo.cpp';
  const second='/Game/Source/Game/Private/B/Foo.cpp';
  const h=harness([], {indexedFiles:[first,second],scoped:true,select:items=>items[1]});
  await h.switchHeaderSource(h.Uri.file('/Game/Source/Game/Public/Foo.h'));
  assert.equal(h.picked.length,1);
  assert.equal(h.picked[0].length,2);
  assert.deepEqual(h.shown,[second]);
});

test('No counterpart does not create files or open an unrelated editor', async () => {
  const h=harness([], {indexedFiles:[],scoped:true});
  await h.switchHeaderSource(h.Uri.file('/Game/Source/Game/Public/Missing.h'));
  assert.deepEqual(h.shown, []);
  assert.match(h.notices[0], /未找到/);
});

test('Generated sources are ignored', async () => {
  const h=harness(['/Game/Source/Game/Private/Foo.cpp']);
  await h.switchHeaderSource(h.Uri.file('/Game/Source/Game/Intermediate/Foo.generated.h'));
  assert.deepEqual(h.shown,[]);
  assert.match(h.notices[0], /生成文件/);
});

test('An out-of-module single match is not opened without confirmation', async () => {
  const other='/Game/Plugins/Other/Source/Other/Private/Actor.cpp';
  const h=harness([], {indexedFiles:[other],scoped:true, workspace:'/Game',select:items=>undefined});
  await h.switchHeaderSource(h.Uri.file('/Game/Source/Game/Public/Actor.h'));
  assert.equal(h.picked.length, 1);
  assert.deepEqual(h.shown, []);
});
