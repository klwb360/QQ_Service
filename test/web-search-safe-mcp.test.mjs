import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { createWebSearchSafeServer } from '../examples/mcp/web-search-safe.mjs';

test('real SDK exposes only readonly web tools and validates parameters before injected work', async () => {
  const calls = [];
  const server = createWebSearchSafeServer({ client: {
    async fetchPage(url, options) { calls.push({ name: 'fetch', url, signal: options.signal }); return { sourceURL: url, text: 'fixture', truncated: false }; },
    async search(args, options) { calls.push({ name: 'search', args, signal: options.signal }); return { results: [{ url: 'https://example.com/result' }] }; },
  } });
  const client = new Client({ name: 'offline-test', version: '1.0.0' });
  const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(right); await client.connect(left);
  try {
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map(tool => tool.name), ['web_search', 'web_fetch']);
    assert(tools.every(tool => tool.annotations.readOnlyHint === true && tool.annotations.destructiveHint === false));
    const page = await client.callTool({ name: 'web_fetch', arguments: { url: 'https://example.com/page' } });
    assert.equal(JSON.parse(page.content[0].text).text, 'fixture'); assert.equal(calls.length, 1); assert(calls[0].signal instanceof AbortSignal);
    const search = await client.callTool({ name: 'web_search', arguments: { query: 'test', count: 2 } });
    assert.equal(JSON.parse(search.content[0].text).results[0].url, 'https://example.com/result'); assert.equal(calls.length, 2);
    for (const parameters of [{ name: 'web_fetch', arguments: { url: 'https://example.com', headers: { Cookie: 'private' } } },
      { name: 'web_search', arguments: { query: 'x', count: 20 } }, { name: 'shell', arguments: {} }]) {
      const rejected = await client.callTool(parameters); assert.equal(rejected.isError, true);
    }
    assert.equal(calls.length, 2);
  } finally { await client.close(); await server.close(); }
});

test('raw errors never expose stacks or credentials through MCP results', async () => {
  const server = createWebSearchSafeServer({ client: { async fetchPage() { throw new Error('fixture-secret /private/file:21 stack'); } } });
  const client = new Client({ name: 'offline-test', version: '1.0.0' });
  const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(right); await client.connect(left);
  try {
    const result = await client.callTool({ name: 'web_fetch', arguments: { url: 'https://example.com' } });
    assert.equal(result.isError, true); assert.equal(JSON.parse(result.content[0].text).code, 'WEB_NETWORK_FAILED');
    assert(!JSON.stringify(result).includes('fixture-secret')); assert(!JSON.stringify(result).includes('/private/'));
  } finally { await client.close(); await server.close(); }
});

test('standalone stdio service starts without credentials and honestly reports missing search setup', async () => {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../examples/mcp/web-search-safe.mjs', import.meta.url))],
    env: { BRAVE_SEARCH_API_KEY: '', SEARXNG_BASE_URL: '' }, stderr: 'pipe' });
  const client = new Client({ name: 'stdio-offline-test', version: '1.0.0' });
  try {
    await client.connect(transport); assert.equal((await client.listTools()).tools.length, 2);
    const result = await client.callTool({ name: 'web_search', arguments: { query: 'no network fixture' } });
    assert.equal(result.isError, true); const body = JSON.parse(result.content[0].text);
    assert.equal(body.needsSetup, true); assert.equal(body.code, 'WEB_SEARCH_SETUP');
  } finally { await client.close(); await transport.close(); }
});
