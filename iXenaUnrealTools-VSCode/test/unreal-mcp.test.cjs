'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { UnrealMcpClient, UnrealMcpError, validateMcpEndpoint, verifyMcpIdentity,
  parseCompileToolResponse } = require('../dist/unrealMcp');

const config = { url: 'http://127.0.0.1:8000/mcp', projectPath: String.raw`D:\项目\Star\Star.uproject`,
  engineRoot: String.raw`D:\UE\UE_5.9`, timeoutSeconds: 30 };
const directName = 'LiveCodingToolset.LiveCodingToolset.CompileLiveCoding';
const emptySchema = { type: 'object', properties: {} };
const directTool = { name: directName, inputSchema: emptySchema };
const init = (overrides = {}) => ({ protocolVersion: '2025-03-26', capabilities: { tools: {} },
  serverInfo: { name: 'unreal-mcp', version: '5.9' },
  _meta: { 'com.epicgames.unrealengine/instance': { processId: 123, projectFile: config.projectPath,
    engineDirectory: `${config.engineRoot}/Engine/`, engineVersion: '5.9', ...overrides } } });
const textResult = (text) => ({ content: [{ type: 'text', text }] });
const jsonResult = (body, session) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'Content-Type': 'application/json', ...(session ? { 'Mcp-Session-Id': session } : {}) } });

function mockServer({ initialize = init(), tools = [directTool], responses = {}, compile = textResult('Success\nPatch complete') } = {}) {
  const calls = [];
  const httpFetch = async (url, options) => {
    assert.equal(url, config.url); assert.equal(options.redirect, 'error');
    if (options.method === 'DELETE') { calls.push({ method: 'DELETE', headers: options.headers }); return new Response(null, { status: 204 }); }
    const request = JSON.parse(options.body); calls.push({ ...request, headers: options.headers });
    if (request.method === 'initialize') return jsonResult({ jsonrpc: '2.0', id: request.id, result: initialize }, 'session-one');
    assert.equal(options.headers['Mcp-Session-Id'], 'session-one');
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (request.method === 'tools/list') return jsonResult({ jsonrpc: '2.0', id: request.id, result: { tools } });
    if (request.method === 'tools/call') {
      const name = request.params.name;
      const result = Object.hasOwn(responses, name) ? responses[name] : compile;
      if (result instanceof Error) throw result;
      if (typeof result === 'function') return result(request, options);
      return jsonResult({ jsonrpc: '2.0', id: request.id, result });
    }
    assert.fail(`Unexpected method ${request.method}`);
  };
  return { calls, httpFetch };
}

test('MCP endpoints accept explicitly configured IPs but reject credentials queries and non-HTTP schemes', () => {
  for (const value of [config.url,'http://127.0.0.1:8765/custom/path','http://localhost:8000/mcp','http://[::1]:8765/mcp','https://192.168.1.20:8443/mcp']) {
    assert.equal(validateMcpEndpoint(value), value);
  }
  for (const value of [undefined,null,'','file:///mcp','ftp://127.0.0.1/mcp','http://example.com/mcp',
    'http://user:password@127.0.0.1/mcp','http://127.0.0.1/mcp?key=x','http://127.0.0.1/mcp#section','http://127.0.0.1/','http://127.0.0.1:0/mcp']) {
    assert.throws(() => validateMcpEndpoint(value), UnrealMcpError);
  }
});

test('MCP identity requires an exact project and engine, including Unicode Windows paths', () => {
  const identity = verifyMcpIdentity(init({ projectFile: config.projectPath.replaceAll('\\', '/').toUpperCase() }), config);
  assert.equal(identity.processId, 123);
  assert.throws(() => verifyMcpIdentity(init({ projectFile: String.raw`D:\项目\Other\Other.uproject` }), config), /另一个项目/);
  assert.throws(() => verifyMcpIdentity(init({ engineDirectory: 'D:/UE/UE_5.90/Engine' }), config), /引擎目录/);
  assert.throws(() => verifyMcpIdentity(init({ processId: 0 }), config), /进程 ID/);
  assert.throws(() => verifyMcpIdentity({ ...init(), _meta: {} }, config), /身份信息/);
  assert.throws(() => verifyMcpIdentity({ ...init(), serverInfo: { name: 'third-party-mcp' } }, config), /身份信息/);
});

test('MCP identity accepts POSIX paths but does not lowercase them', () => {
  const cfg = { ...config, projectPath: '/Users/x/Star/Star.uproject', engineRoot: '/Applications/UE_5.9' };
  const response = init({ projectFile: cfg.projectPath, engineDirectory: '/Applications/UE_5.9/Engine/' });
  assert.equal(verifyMcpIdentity(response, cfg).projectPath, cfg.projectPath);
  assert.throws(() => verifyMcpIdentity(init({ projectFile: '/users/x/Star/Star.uproject', engineDirectory: cfg.engineRoot }), cfg), /另一个项目/);
});

test('read-only connection discovery never dispatches CompileLiveCoding and releases only its own session', async () => {
  const server = mockServer();
  const client = new UnrealMcpClient(config, undefined, server.httpFetch);
  const result = await client.discoverLiveCoding();
  assert.equal(result.liveCodingAvailable, true); assert.equal(result.toolName, directName);
  assert.equal(server.calls.some(call => call.method === 'tools/call'), false);
  await client.close();
  assert.equal(server.calls.at(-1).method, 'DELETE');
  assert.equal(server.calls.at(-1).headers['Mcp-Session-Id'], 'session-one');
});

test('wrong project aborts immediately after initialize, before any tool discovery or mutation', async () => {
  const server = mockServer({ initialize: init({ projectFile: 'D:/Wrong/Wrong.uproject' }) });
  const client = new UnrealMcpClient(config, undefined, server.httpFetch);
  await assert.rejects(client.compileLiveCoding(), /另一个项目/);
  assert.deepEqual(server.calls.map(call => call.method), ['initialize']);
});

test('direct Live Coding tool uses an empty argument object and reports actual success', async () => {
  const server = mockServer(); const messages = [];
  const client = new UnrealMcpClient(config, message => messages.push(message), server.httpFetch);
  const result = await client.compileLiveCoding();
  assert.equal(result.status, 'Success'); assert.equal(result.isError, false);
  const compile = server.calls.find(call => call.method === 'tools/call');
  assert.equal(compile.params.name, directName); assert.deepEqual(compile.params.arguments, {});
  assert.ok(compile.params._meta.progressToken); assert.ok(messages.some(message => message.includes('实际编译结果')));
});

function metaTools(describer = 'describe_toolsets') {
  const name = describer === 'describe_toolset' ? 'toolset_name' : describer === 'describe_tools' ? 'tool_names' : 'toolset_names';
  return [{ name: 'list_toolsets', inputSchema: emptySchema },
    { name: describer, inputSchema: { type: 'object', properties: {
      [name]: { type: describer === 'describe_toolset' ? 'string' : 'array' }, include_schemas: { type: 'boolean' }
    }, required: [name] } },
    { name: 'call_tool', inputSchema: { type: 'object', properties: {
      toolset_name: { type: 'string' }, tool_name: { type: 'string' }, arguments: { type: 'object' }
    }, required: ['tool_name', 'arguments'] } }];
}

for (const describer of ['describe_toolsets', 'describe_toolset', 'describe_tools']) {
  test(`tool-search mode inspects ${describer} schema before one compile dispatch`, async () => {
    const server = mockServer({ tools: metaTools(describer), responses: {
      list_toolsets: textResult(JSON.stringify({ toolsets: [{ name: 'LiveCodingToolset.LiveCodingToolset' }] })),
      [describer]: { structuredContent: { tools: [{ name: 'CompileLiveCoding', input_schema: emptySchema }] } },
      call_tool: { structuredContent: { result: 'NoChanges\nNothing to compile' } }
    } });
    const client = new UnrealMcpClient(config, undefined, server.httpFetch);
    const connection = await client.discoverLiveCoding(); assert.equal(connection.liveCodingAvailable, true);
    assert.equal(server.calls.filter(call => call.params?.name === 'call_tool').length, 0);
    const result = await client.compileLiveCoding(); assert.equal(result.status, 'NoChanges');
    const requests = server.calls.filter(call => call.params?.name === 'call_tool'); assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].params.arguments, { toolset_name: 'LiveCodingToolset.LiveCodingToolset', tool_name: 'CompileLiveCoding', arguments: {} });
  });
}

test('new required compile parameters cause a clear error instead of guessing or dispatching', async () => {
  const server = mockServer({ tools: [{ ...directTool, inputSchema: { type: 'object', required: ['instance'], properties: { instance: { type: 'string' } } } }] });
  const client = new UnrealMcpClient(config, undefined, server.httpFetch);
  await assert.rejects(client.compileLiveCoding(), /必需参数 instance/);
  assert.equal(server.calls.some(call => call.method === 'tools/call'), false);
});

test('connected MCP without Live Coding capability reports NotAvailable without compilation', async () => {
  const server = mockServer({ tools: [] }); const client = new UnrealMcpClient(config, undefined, server.httpFetch);
  const connection = await client.discoverLiveCoding();
  assert.equal(connection.liveCodingAvailable, false); assert.match(connection.message, /MCP 已连接/);
  const result = await client.compileLiveCoding(); assert.equal(result.status, 'NotAvailable');
  assert.equal(server.calls.some(call => call.method === 'tools/call'), false);
});

test('unknown or contradictory output is never mislabeled successful', () => {
  for (const value of [textResult('Accepted'), textResult('Compilation log\nSuccess'),
    textResult('Other work: Success'), { isError: true, ...textResult('Success') },
    textResult(JSON.stringify({ isError: true, result: 'Success' }))]) {
    const result = parseCompileToolResponse(value); assert.equal(result.status, 'Unknown'); assert.equal(result.isError, true);
  }
  assert.equal(parseCompileToolResponse(textResult('Live Coding compile result: Failure\nA.cpp(1): error C1234')).status, 'Failure');
  assert.equal(parseCompileToolResponse({ structuredContent: { status: 'NoChanges', output: 'No C++ changed' } }).isError, false);
  assert.equal(parseCompileToolResponse({ structuredContent: { result: 'ELiveCodingCompileResult::Success\nPatched' } }).status, 'Success');
});

test('compile response SSE streams resolve on matching JSON-RPC ID without waiting for stream closure', async () => {
  let cancelled = false;
  const server = mockServer({ compile: (request) => {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({ start(controller) {
      const progress = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { message: 'Compiling 8/10' } });
      const wrong = JSON.stringify({ jsonrpc: '2.0', id: request.id + 100, result: textResult('Failure') });
      const own = JSON.stringify({ jsonrpc: '2.0', id: request.id, result: textResult('Success\n中文输出') });
      const data = `: heartbeat\r\n\r\ndata: ${progress}\r\n\r\ndata: ${wrong}\n\ndata: ${own}\n\n`;
      const bytes = encoder.encode(data); const split = bytes.indexOf(0xe4);
      controller.enqueue(bytes.slice(0, split + 1)); controller.enqueue(bytes.slice(split + 1));
      // Deliberately leave the stream open. The client must stop after its own response.
    }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  const messages = []; const client = new UnrealMcpClient(config, message => messages.push(message), server.httpFetch);
  const result = await client.compileLiveCoding();
  assert.equal(result.status, 'Success'); assert.match(result.rawOutput, /中文输出/);
  assert.equal(cancelled, true); assert.ok(messages.includes('Compiling 8/10'));
});

test('compile network failures are uncertain and never retried', async () => {
  const server = mockServer({ compile: new Error('socket closed') });
  const client = new UnrealMcpClient(config, undefined, server.httpFetch);
  await assert.rejects(client.compileLiveCoding(), error => error instanceof UnrealMcpError && error.uncertain && /不会自动重试/.test(error.message));
  assert.equal(server.calls.filter(call => call.params?.name === directName).length, 1);
});

test('JSON-RPC errors and wrong response IDs cannot become compile success', async () => {
  for (const kind of ['error', 'id']) {
    const server = mockServer({ compile: request => jsonResult(kind === 'error' ?
      { jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'Live Coding unavailable' } } :
      { jsonrpc: '2.0', id: request.id + 1, result: textResult('Success') }) });
    const client = new UnrealMcpClient(config, undefined, server.httpFetch);
    await assert.rejects(client.compileLiveCoding(), error => error instanceof UnrealMcpError && error.uncertain);
  }
});

test('HTTP 404 does not reinitialize or resend a mutating request', async () => {
  const server = mockServer({ compile: () => new Response(null, { status: 404 }) });
  const client = new UnrealMcpClient(config, undefined, server.httpFetch);
  await assert.rejects(client.compileLiveCoding(), /HTTP 404/);
  assert.equal(server.calls.filter(call => call.method === 'initialize').length, 1);
  assert.equal(server.calls.filter(call => call.params?.name === directName).length, 1);
});

test('tool discovery follows advertised pagination without duplicate cursor loops', async () => {
  const base = mockServer(); let page = 0;
  const fetchPages = async (url, options) => {
    if (options.method === 'POST') {
      const request = JSON.parse(options.body);
      if (request.method === 'tools/list') {
        page++;
        return jsonResult({ jsonrpc: '2.0', id: request.id, result: page === 1 ?
          { tools: [], nextCursor: 'second-page' } : { tools: [directTool] } });
      }
    }
    return base.httpFetch(url, options);
  };
  const client = new UnrealMcpClient(config, undefined, fetchPages);
  assert.equal((await client.discoverLiveCoding()).liveCodingAvailable, true); assert.equal(page, 2);
});

test('MCP automatic identity-only probe verifies the target without discovering tools or compiling', async () => {
  const server = mockServer();
  const client = new UnrealMcpClient(config, undefined, server.httpFetch, 1500);
  try {
    const identity = await client.probeIdentity();
    assert.equal(identity.processId, 123);
    assert.equal(identity.projectPath, config.projectPath);
    assert.deepEqual(server.calls.map(call => call.method), ['initialize', 'notifications/initialized']);
  } finally { await client.close(); }
  assert.equal(server.calls.at(-1).method, 'DELETE');
});
