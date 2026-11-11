import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';

async function connect(t) {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../examples/mcp/local-notes.mjs', import.meta.url))], stderr: 'pipe' });
  transport.stderr?.resume();
  const client = new Client({ name: 'qq-service-example-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await transport.close(); });
  await client.connect(transport);
  return client;
}
const body = result => JSON.parse(result.content.find(item => item.type === 'text').text);

test('bundled stdio example discovers read/write tools and completes an isolated notes round trip', async t => {
  const client = await connect(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ['calculate', 'list_notes', 'add_note']);
  assert.equal(tools.find(tool => tool.name === 'add_note').annotations.readOnlyHint, false);
  assert.equal(body(await client.callTool({ name: 'calculate', arguments: { operation: 'multiply', a: 6, b: 7 } })).result, 42);
  assert.equal(body(await client.callTool({ name: 'list_notes', arguments: {} })).notes.length, 0);
  await Promise.all(['first', 'second'].map(text => client.callTool({ name: 'add_note', arguments: { text } })));
  const notes = body(await client.callTool({ name: 'list_notes', arguments: {} })).notes;
  assert.deepEqual(notes.map(note => note.text).sort(), ['first', 'second']);
  const other = await connect(t);
  assert.equal(body(await other.callTool({ name: 'list_notes', arguments: {} })).notes.length, 0, 'separate server processes must not share demo data');
});

test('bundled stdio example rejects path injection, expression evaluation and invalid arithmetic', async t => {
  const client = await connect(t);
  for (const input of [
    { name: 'list_notes', arguments: { path: '/etc/passwd' } },
    { name: 'add_note', arguments: { text: 'note', path: '/tmp/unrelated-file' } },
    { name: 'calculate', arguments: { operation: 'eval', a: 1, b: 2 } },
    { name: 'calculate', arguments: { operation: 'divide', a: 1, b: 0 } },
  ]) assert.equal((await client.callTool(input)).isError, true);
});

test('bundled Streamable HTTP example requires its service token and preserves notes across requests', async t => {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../examples/mcp/http-notes.mjs', import.meta.url))], {
    env: { ...process.env, MCP_DEMO_HOST: '127.0.0.1', MCP_DEMO_PORT: String(port), MCP_DEMO_TOKEN: 'isolated-http-demo-test-token' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  t.after(async () => { if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('HTTP MCP demo startup timeout')), 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('HTTP MCP demo exited early')); });
    child.stderr.on('data', chunk => { if (chunk.toString().includes('ready on')) { clearTimeout(timer); resolve(); } });
  });
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  const untrusted = new Client({ name: 'unauthenticated-test', version: '1' });
  await assert.rejects(untrusted.connect(new StreamableHTTPClientTransport(url)), error => error.code === 401);
  await untrusted.close();
  const client = new Client({ name: 'authenticated-test', version: '1' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer isolated-http-demo-test-token' } } }));
  assert.equal((await client.listTools()).tools.length, 3);
  assert.equal((await client.callTool({ name: 'add_note', arguments: { text: 'HTTP note' } })).isError, undefined);
  assert.deepEqual(body(await client.callTool({ name: 'list_notes', arguments: {} })).notes.map(note => note.text), ['HTTP note']);
});
