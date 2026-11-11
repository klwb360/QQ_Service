import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMcpClient, resolveMcpStdioCommand, restrictedMcpEnvironment, MCP_TRANSPORT_LIMIT } from '../src/mcp-client.mjs';

const descriptor = (transport, values = {}) => ({ id: 'fixture', label: 'Local SDK fixture', enabled: true, transport,
  command: '', args: [], url: '', envKeys: [], headerKeys: [], timeoutSeconds: 2, tools: [], ...values });
const textResult = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });
const definition = { name: 'echo', description: 'Fixture echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false } };
const waitFor = async predicate => {
  const end = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > end) throw new Error('MCP fixture timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
};

async function httpFixture(mode = 'http', { handler, listHandler, responseHook } = {}) {
  const sessions = new Map(), servers = new Set(), requests = [];
  let calls = 0, listings = 0;
  const makeServer = () => {
    const server = new Server({ name: 'sdk-fixture', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
    server.setRequestHandler(ListToolsRequestSchema, request => {
      listings++; return listHandler ? listHandler(request) : { tools: [definition] };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      calls++; return handler ? handler(request, extra, server) : textResult(request.params.arguments?.text || 'ok');
    });
    servers.add(server); return server;
  };
  const web = http.createServer(async (request, response) => {
    try {
      let body = '';
      if (request.method === 'POST') for await (const chunk of request) body += chunk;
      const message = body ? JSON.parse(body) : undefined;
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, rpc: message });
      if (responseHook && await responseHook(request, response, message)) return;
      if (mode === 'sse') {
        if (request.method === 'GET' && request.url === '/sse') {
          const transport = new SSEServerTransport('/messages', response);
          sessions.set(transport.sessionId, transport);
          await makeServer().connect(transport); return;
        }
        const transport = sessions.get(new URL(request.url, 'http://localhost').searchParams.get('sessionId'));
        if (!transport) { response.writeHead(404); response.end(); return; }
        await transport.handlePostMessage(request, response, message); return;
      }
      let transport = sessions.get(request.headers['mcp-session-id']);
      if (!transport && request.method === 'POST') {
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true,
          onsessioninitialized: id => sessions.set(id, transport) });
        await makeServer().connect(transport);
      }
      if (!transport) { response.writeHead(405); response.end(); return; }
      await transport.handleRequest(request, response, message);
    } catch (error) { if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${web.address().port}/${mode === 'sse' ? 'sse' : 'mcp'}`, requests,
    get calls() { return calls; }, get listings() { return listings; }, servers,
    async close() { await Promise.all([...servers].map(server => server.close().catch(() => {}))); web.closeAllConnections(); await new Promise(resolve => web.close(resolve)); },
  };
}

async function stdioFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-service-mcp-stdio-'));
  const moduleUrl = suffix => new URL('../node_modules/@modelcontextprotocol/sdk/dist/esm/' + suffix, import.meta.url).href;
  const source = `import {Server} from ${JSON.stringify(moduleUrl('server/index.js'))};
import {StdioServerTransport} from ${JSON.stringify(moduleUrl('server/stdio.js'))};
import {ListToolsRequestSchema,CallToolRequestSchema} from ${JSON.stringify(moduleUrl('types.js'))};
const server = new Server({name:'stdio-fixture',version:'1.0.0'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'environment',inputSchema:{type:'object'}}]}));
server.setRequestHandler(CallToolRequestSchema,async()=>({content:[{type:'text',text:JSON.stringify({
 own:process.env.MCP_FIXTURE_SECRET==='only-this-service',
 hostApi:Boolean(process.env.OPENAI_API_KEY),gh:Boolean(process.env.GH_TOKEN),qq:Boolean(process.env.NAPCAT_TOKEN),
 nodeOptions:Boolean(process.env.NODE_OPTIONS),capabilities:server.getClientCapabilities()
})}]}));
await server.connect(new StdioServerTransport());`;
  const file = path.join(dir, 'server.mjs'); fs.writeFileSync(file, source);
  return { descriptor: descriptor('stdio', { command: 'node', args: [file], envKeys: ['MCP_FIXTURE_SECRET'] }), close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('constructing a stdio descriptor is inert; explicit connect uses the bundled Node and only service env', async () => {
  const fixture = await stdioFixture(), previous = {};
  for (const [key, value] of Object.entries({ OPENAI_API_KEY: 'host-api', GH_TOKEN: 'host-gh', NAPCAT_TOKEN: 'host-qq', NODE_OPTIONS: '--no-warnings' })) {
    previous[key] = process.env[key]; process.env[key] = value;
  }
  const requestedSecrets = [];
  const client = createMcpClient(fixture.descriptor, { getSecret: key => { requestedSecrets.push(key); return 'only-this-service'; } });
  try {
    assert.equal(client.status().state, 'idle'); assert.deepEqual(requestedSecrets, []);
    await client.connect(); assert.equal(client.status().connected, true); const pid = client.status().pid;
    assert.ok(pid > 0);
    assert.equal((await client.listTools())[0].name, 'environment');
    const value = JSON.parse((await client.callTool('environment')).content[0].text);
    assert.deepEqual(value, { own: true, hostApi: false, gh: false, qq: false, nodeOptions: false, capabilities: {} });
    assert.deepEqual(requestedSecrets, ['mcpSecret:fixture:env:MCP_FIXTURE_SECRET']);
    await client.close(); assert.equal(client.status().state, 'closed');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    await client.close(); fixture.close();
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test('Windows wrappers never invoke unknown batch files or interpolate shell/env text', () => {
  const settings = { platform: 'win32', nodeExecutable: '/bundled/node.exe', appDir: '/app root', exists: () => true };
  assert.deepEqual(resolveMcpStdioCommand('npx.cmd', ['-y', 'fixture', '$(echo secret)'], settings), {
    command: '/bundled/node.exe', args: ['/bundled/node_modules/npm/bin/npx-cli.js', '-y', 'fixture', '$(echo secret)'],
  });
  assert.deepEqual(resolveMcpStdioCommand('node', ['{appDir}/examples/server.mjs', '$HOME', '{HOME}'], settings).args,
    ['/app root/examples/server.mjs', '$HOME', '{HOME}']);
  assert.throws(() => resolveMcpStdioCommand('C:\\unknown\\launch.cmd', [], settings), { code: 'MCP_BATCH_UNSUPPORTED' });
  assert.throws(() => resolveMcpStdioCommand('npx', [], { ...settings, exists: () => false }), { code: 'MCP_NODE_WRAPPER_MISSING' });
  const windows = { ...settings, appDir: 'C:\\app', environment: { PATH: 'C:\\safe' },
    exists: candidate => candidate === 'C:\\safe\\real.exe', realpath: candidate => candidate, isFile: () => true };
  assert.equal(resolveMcpStdioCommand('real', [], windows).command, 'C:\\safe\\real.exe');
  assert.throws(() => resolveMcpStdioCommand('batch-only', [], { ...windows, exists: candidate => candidate.endsWith('.cmd') }), { code: 'MCP_EXECUTABLE_NOT_FOUND' });
  assert.throws(() => resolveMcpStdioCommand('real', [], { ...windows, realpath: () => 'C:\\safe\\hidden.cmd' }), { code: 'MCP_EXECUTABLE_NOT_FOUND' });
  const env = restrictedMcpEnvironment({ inherited: { HOME: '/tmp', PATH: '/untrusted', GH_TOKEN: 'no', NODE_OPTIONS: 'no', OPENAI_API_KEY: 'no' } });
  assert.equal(env.GH_TOKEN, undefined); assert.equal(env.NODE_OPTIONS, undefined); assert.ok(!env.PATH.includes('/untrusted'));
});

for (const mode of ['http', 'sse']) test(`official SDK ${mode} transport lists and calls tools with vault headers`, async () => {
  const fixture = await httpFixture(mode);
  const client = createMcpClient(descriptor(mode, { url: fixture.url, headerKeys: ['authorization'] }), {
    getSecret: key => { assert.equal(key, 'mcpSecret:fixture:header:authorization'); return 'Bearer service-only'; },
  });
  try {
    await client.connect();
    const tools = await client.listTools(); assert.equal(tools[0].name, 'echo');
    assert.equal((await client.callTool('echo', { text: 'hello SDK' })).content[0].text, 'hello SDK');
    assert.equal(fixture.calls, 1);
    assert.ok(fixture.requests.every(request => request.authorization === 'Bearer service-only'));
    assert.equal(fixture.requests.filter(request => request.rpc?.method === 'tools/call').length, 1);
  } finally { await client.close(); await fixture.close(); }
});

test('list-changed is surfaced without enabling roots, sampling or automatic execution', async () => {
  const fixture = await httpFixture('sse'); let changed = 0;
  const client = createMcpClient(descriptor('sse', { url: fixture.url }), { onToolsChanged: () => { changed++; } });
  try {
    await client.connect();
    for (const server of fixture.servers) {
      assert.deepEqual(server.getClientCapabilities(), {});
      await server.sendToolListChanged();
    }
    await waitFor(() => changed === 1);
    assert.equal(fixture.listings, 0, 'notifications cannot silently refresh or execute tools in the client');
    assert.equal(fixture.calls, 0);
  } finally { await client.close(); await fixture.close(); }
});

test('HTTP redirect is rejected without forwarding credentials or retrying', async () => {
  const fixture = await httpFixture('http', { responseHook: (request, response) => { response.writeHead(302, { location: '/redirect-target' }); response.end(); return true; } });
  const client = createMcpClient(descriptor('http', { url: fixture.url, headerKeys: ['authorization'] }), { getSecret: () => 'Bearer private-value' });
  try {
    await assert.rejects(client.connect());
    assert.equal(fixture.requests.length, 1);
    assert.ok(!client.status().lastError.includes('private-value'));
  } finally { await client.close(); await fixture.close(); }
});

test('tools/call lost response times out absolutely and is not retried', async () => {
  const fixture = await httpFixture('http', { handler: async () => new Promise(() => {}) });
  const client = createMcpClient(descriptor('http', { url: fixture.url }));
  try {
    await client.connect();
    await assert.rejects(client.callTool('echo', {}, { timeoutMs: 80 }), error => error.code === 'MCP_TIMEOUT' && error.deliveryUncertain === true);
    assert.equal(fixture.calls, 1);
    assert.equal(client.status().connected, false);
  } finally { await client.close(); await fixture.close(); }
});

test('progress notifications cannot extend the tool request deadline', async () => {
  const fixture = await httpFixture('sse', { handler: async (request, extra, server) => {
    const timer = setInterval(() => server.notification({ method: 'notifications/progress', params: { progressToken: request.params._meta?.progressToken ?? 'unused', progress: 1 } }).catch(() => {}), 10);
    extra.signal.addEventListener('abort', () => clearInterval(timer), { once: true });
    const stop = setTimeout(() => clearInterval(timer), 500); stop.unref();
    return new Promise(() => {});
  } });
  const client = createMcpClient(descriptor('sse', { url: fixture.url }));
  try {
    await client.connect(); const started = Date.now();
    await assert.rejects(client.callTool('echo', {}, { timeoutMs: 80 }), { code: 'MCP_TIMEOUT' });
    assert.ok(Date.now() - started < 1000);
    assert.equal(fixture.calls, 1);
  } finally { await client.close(); await fixture.close(); }
});

test('HTTP response hard limit also applies to chunked tool responses', async () => {
  const fixture = await httpFixture('http', { responseHook: (request, response, message) => {
    if (message?.method !== 'tools/call') return false;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"jsonrpc":"2.0","id":' + message.id + ',"result":{"content":[{"type":"text","text":"');
    response.end('x'.repeat(MCP_TRANSPORT_LIMIT) + '"}]}}'); return true;
  } });
  const client = createMcpClient(descriptor('http', { url: fixture.url }));
  try {
    await client.connect(); await assert.rejects(client.callTool('echo'));
    assert.equal(client.status().connected, false);
    assert.equal(fixture.requests.filter(request => request.rpc?.method === 'tools/call').length, 1);
  } finally { await client.close(); await fixture.close(); }
});

test('tool pagination is bounded and repeated cursors cannot loop forever', async () => {
  const fixture = await httpFixture('http', { listHandler: () => ({ tools: [definition], nextCursor: 'same' }) });
  const client = createMcpClient(descriptor('http', { url: fixture.url }));
  try {
    await client.connect(); await assert.rejects(client.listTools(), { code: 'MCP_CURSOR_INVALID' });
    assert.equal(fixture.listings, 2);
  } finally { await client.close(); await fixture.close(); }
});

test('concurrent explicit connect calls share one SDK initialization and manual close is quiet', async () => {
  const fixture = await httpFixture(); let closed = 0;
  const client = createMcpClient(descriptor('http', { url: fixture.url }), { onClose: () => { closed++; } });
  try {
    await Promise.all([client.connect(), client.connect(), client.connect()]);
    assert.equal(fixture.requests.filter(request => request.rpc?.method === 'initialize').length, 1);
    assert.equal(client.status().connected, true);
    await client.close(); assert.equal(closed, 0); assert.equal(client.status().state, 'closed');
  } finally { await client.close(); await fixture.close(); }
});

test('aborting an in-flight call closes the SDK session and notifies the catalog owner once', async () => {
  const fixture = await httpFixture('http', { handler: async () => new Promise(() => {}) });
  let closed = 0;
  const client = createMcpClient(descriptor('http', { url: fixture.url }), { onClose: () => { closed++; } });
  try {
    await client.connect(); const controller = new AbortController();
    const pending = client.callTool('echo', {}, { signal: controller.signal });
    await waitFor(() => fixture.calls === 1); controller.abort();
    await assert.rejects(pending, { code: 'MCP_CANCELLED' });
    assert.equal(client.status().connected, false); assert.equal(closed, 1);
    await client.close(); assert.equal(client.status().state, 'closed'); assert.equal(closed, 1);
  } finally { await client.close(); await fixture.close(); }
});
