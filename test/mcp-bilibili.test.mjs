import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpClient } from '../src/mcp-client.mjs';
import { bilibiliMcpTools, createBilibiliMcpServer } from '../examples/mcp/bilibili.mjs';

const BV = 'BV1xx411c7mD';
const sample = (overrides = {}) => ({ bvid: BV, aid: '12345', title: '科普视频', description: '标题与简介资料', uploader: '测试UP', duration: 300,
  url: `https://www.bilibili.com/video/${BV}`, ...overrides });
async function fixture(options) {
  const server = createBilibiliMcpServer(options), client = new Client({ name: 'offline-fixture', version: '1.0.0' }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  return { client, async close() { await client.close(); await server.close(); } };
}

test('Bilibili MCP is inert on import and only defines the three fixed read tools', async () => {
  const previous = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('must not access the network'); };
  try {
    await import('../examples/mcp/bilibili.mjs?inert-import-check');
    const definitions = bilibiliMcpTools();
    assert.deepEqual(definitions.map(tool => tool.name), ['popular_videos', 'search_videos', 'video_details']);
    assert.ok(definitions.every(tool => tool.annotations.readOnlyHint === true));
    assert.equal(definitions[0].inputSchema.properties.limit.maximum, 5);
    assert.equal(definitions[1].inputSchema.properties.limit.maximum, 5);
    assert.equal(requests, 0);
  } finally { globalThis.fetch = previous; }
});

test('offline handler gets fixed settings and only this service optional session, returning honest metadata links', async () => {
  const calls = [];
  const f = await fixture({ getSession: () => 'only-this-service', handler: async input => {
    calls.push(input); return { text: JSON.stringify(input.name === 'video_details' ? { video: sample() } : { videos: [sample()], page: 1 }) };
  } });
  try {
    const popular = await f.client.callTool({ name: 'popular_videos', arguments: { limit: 2 } });
    const result = JSON.parse(popular.content[0].text);
    assert.equal(result.source.kind, 'video_metadata'); assert.match(result.basis, /未观看/);
    assert.equal(result.videos[0].url, `https://www.bilibili.com/video/${BV}`);
    assert.deepEqual(calls[0].settings, { maxResults: 5 });
    assert.deepEqual(calls[0].secrets, { sessdata: 'only-this-service' });
    const detail = await f.client.callTool({ name: 'video_details', arguments: { bvid: BV } });
    assert.equal(JSON.parse(detail.content[0].text).video.bvid, BV);
    assert.equal(calls.length, 2);
  } finally { await f.close(); }
});

test('write names, arbitrary URLs/files and invalid arguments are rejected before handler or session access', async () => {
  let handlers = 0, sessions = 0;
  const f = await fixture({ getSession: () => { sessions++; return ''; }, handler: async () => { handlers++; throw new Error('must not execute'); } });
  try {
    const invalid = [ ['comment_and_mention', { bvid: BV, comment: 'never post' }], ['popular_videos', { limit: 6 }],
      ['popular_videos', { url: 'http://localhost/secret' }], ['search_videos', { keyword: '   ' }],
      ['search_videos', { keyword: '科普', file: '/etc/passwd' }], ['video_details', { bvid: 'http://a.b.c' }],
      ['video_details', { bvid: 'not-a-bv-id!' }], ['video_details', { bvid: BV, comment: 'never' }] ];
    for (const [name, args] of invalid) {
      const result = await f.client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, name + JSON.stringify(args));
      assert.doesNotThrow(() => JSON.parse(result.content[0].text));
    }
    assert.equal(handlers, 0); assert.equal(sessions, 0);
  } finally { await f.close(); }
});

test('output remains complete bounded JSON, limits videos and scrubs session before trimming', async () => {
  const secret = 'long-session-%2F' + 'z'.repeat(900);
  const f = await fixture({ getSession: () => secret, handler: async () => ({ text: JSON.stringify({ videos:
    Array.from({ length: 10 }, () => sample({ title: secret + '标题'.repeat(100), description: encodeURIComponent(secret) + secret + '长简介'.repeat(5000), url: 'https://evil.example/file' })) }) }) });
  try {
    const result = await f.client.callTool({ name: 'popular_videos', arguments: {} });
    const text = result.content[0].text, data = JSON.parse(text);
    assert.ok(Buffer.byteLength(text) <= 24 * 1024); assert.ok(data.videos.length <= 5); assert.equal(data.truncated, true);
    assert.equal(text.includes('long-session-'), false); assert.equal(text.includes('evil.example'), false);
    assert.ok(data.videos.every(video => video.url === `https://www.bilibili.com/video/${BV}`));
  } finally { await f.close(); }
});

test('long raw or encoded sessions are masked before the public error is shortened', async () => {
  const secret = 'error-session-%2F' + 'z'.repeat(900);
  const f = await fixture({ getSession: () => secret, handler: async () => { throw new Error(secret + encodeURIComponent(secret) + 'verification required'); } });
  try {
    const result = await f.client.callTool({ name: 'popular_videos', arguments: {} });
    assert.equal(result.isError, true); assert.equal(result.content[0].text.includes('error-session-'), false);
    assert.match(result.content[0].text, /已隐藏/);
  } finally { await f.close(); }
});

test('non-string session values fail without coercion or invoking the query handler', async () => {
  let coerced = 0, called = 0;
  const f = await fixture({ getSession: () => ({ toString() { coerced++; return 'unsafe'; } }), handler: async () => { called++; } });
  try {
    assert.equal((await f.client.callTool({ name: 'popular_videos', arguments: {} })).isError, true);
    assert.equal(coerced, 0); assert.equal(called, 0);
  } finally { await f.close(); }
});

test('site verification failures become explicit read-only errors with no retry or cookie bypass', async () => {
  let calls = 0;
  const f = await fixture({ handler: async () => { calls++; throw new Error('Bilibili 要求验证或限制请求频率，请在网站处理后重试。'); } });
  try {
    const result = await f.client.callTool({ name: 'search_videos', arguments: { keyword: '科普' } });
    assert.equal(result.isError, true); assert.match(result.content[0].text, /要求验证/); assert.equal(calls, 1);
  } finally { await f.close(); }
});

test('real official SDK stdio can list the Bilibili example and reject writes/invalid input without network', async () => {
  const client = createMcpClient({ id: 'bilibili-example', label: 'Bilibili read-only', enabled: true, transport: 'stdio',
    command: 'node', args: [fileURLToPath(new URL('../examples/mcp/bilibili.mjs', import.meta.url))], envKeys: [], headerKeys: [], url: '', timeoutSeconds: 5, tools: [] });
  try {
    await client.connect();
    assert.deepEqual((await client.listTools()).map(tool => tool.name), ['popular_videos', 'search_videos', 'video_details']);
    assert.equal((await client.callTool('comment_and_mention', {})).isError, true);
    assert.equal((await client.callTool('search_videos', { keyword: '' })).isError, true);
    assert.equal((await client.callTool('video_details', { bvid: 'https://x.y/' })).isError, true);
  } finally { await client.close(); }
});
