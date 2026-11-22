const test=require('node:test');const assert=require('node:assert/strict');
const {buildMcpEndpoint,endpointParts}=require('../dist/connectionSetup');
const {configureI18n}=require('../dist/i18n');
test('endpoint inputs support IPv4 localhost IPv6 and reject accidental URL credentials or port injection',()=>{
 assert.equal(buildMcpEndpoint(' 127.0.0.1 ','8000'), 'http://127.0.0.1:8000/mcp');
 assert.equal(buildMcpEndpoint('[::1]',8765,'/mcp'), 'http://[::1]:8765/mcp');
 for(const input of ['https://127.0.0.1','user@127.0.0.1','127.0.0.1/mcp','example.com','']) assert.throws(()=>buildMcpEndpoint(input,8000));
 for(const input of ['0','65536','1e3','3.2','8000;exec'])assert.throws(()=>buildMcpEndpoint('localhost',input));
 for(const input of ['/','//other','/mcp?x=1','/mcp#x','/a b','/mcp\nnext','/a/..','/%2e%2e'])assert.throws(()=>buildMcpEndpoint('localhost',8000,input));
 assert.deepEqual(endpointParts('http://[::1]:8765/mcp'),{host:'::1',port:'8765',route:'/mcp',protocol:'http:'});
});
test('setup validation localizes messages without changing input values',()=>{
 configureI18n('en');assert.throws(()=>buildMcpEndpoint('localhost',0),/port must be/);
 configureI18n('zh-CN');assert.throws(()=>buildMcpEndpoint('localhost',0),/端口/);
});

test('reconfiguring HTTPS preserves the scheme and rejects root-normalizing paths',()=>{
 const p=endpointParts('https://127.0.0.1:8443/mcp');
 assert.equal(buildMcpEndpoint(p.host,p.port,p.route,p.protocol),'https://127.0.0.1:8443/mcp');
 for(const route of ['/a/..','/%2e%2e'])assert.throws(()=>buildMcpEndpoint('localhost',8000,route));
});

test('untranslated property-like strings remain literal text in English',()=>{
 const {t,registerTranslations}=require('../dist/i18n');configureI18n('en');
 try {
  for(const value of ['constructor','toString','__proto__'])assert.equal(t(value),value);
  registerTranslations({'Unknown message {0}':'Unknown message {0}'});
  assert.equal(t('Unknown message {0}','constructor'),'Unknown message constructor');
 } finally { configureI18n('zh-CN'); }
});
