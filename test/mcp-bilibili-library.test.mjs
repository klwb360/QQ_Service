import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createBilibiliMcpServer, bilibiliMcpTools } from '../examples/mcp/bilibili.mjs';
import { BILIBILI_HOST_TOOL_NAMES, bilibiliDigestHostTools, bilibiliDigestToolEffect,
  normalizeBilibiliDigestRequest, normalizeBilibiliDigestToolInput } from '../src/bilibili-digest-tools.mjs';

const BV = 'BV1xx411c7mD';
const articleId = '123456';
const item = (fields = {}) => ({ id: `video:${BV}`, kind: 'video', bvid: BV, title: '星空摄影指南', uploader: '测试UP', description: '原始简介',
  url: `https://www.bilibili.com/video/${BV}`, publishedAt: '2026-11-01T00:00:00.000Z', addedAt: '2026-11-10T00:00:00.000Z', ...fields });
const article = () => item({ id: `article:${articleId}`, kind: 'article', bvid: undefined, articleId, url: `https://www.bilibili.com/read/cv${articleId}` });
const request = () => ({ sources: { favoriteFolderIds: ['123'], watchLater: true, favoriteArticles: true } });
const parse = result => JSON.parse(result.content[0].text);
async function fixture(options = {}) {
  const server = createBilibiliMcpServer(options);
  const client = new Client({ name: 'library-fixture', version: '1.0.0' }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  return { client, async close() { await client.close(); await server.close(); } };
}

test('background task schemas normalize explicit time ranges independently from runtime windows', () => {
  const normalized = normalizeBilibiliDigestRequest({ ...request(),
    timeFilter: { basis: 'published', from: '2026-11-01T00:00:00+08:00', until: '2026-11-12T00:00:00+08:00' },
    schedule: { mode: 'daily', timeZone: 'Asia/Shanghai', activeStart: '23:00', activeEnd: '06:30' }, focus: '  关注实操步骤  ',
  });
  assert.deepEqual(normalized.timeFilter, { basis: 'published', from: '2026-10-31T16:00:00.000Z', until: '2026-11-11T16:00:00.000Z' });
  assert.deepEqual(normalized.schedule, { mode: 'daily', timeZone: 'Asia/Shanghai', activeStart: '23:00', activeEnd: '06:30' });
  assert.equal(normalized.focus, '关注实操步骤'); assert.equal(normalized.maxItems, 5);
  assert.deepEqual(normalized.contentKinds, ['video', 'article']);
  const defaults = normalizeBilibiliDigestRequest({ sources: { watchLater: true } });
  assert.deepEqual(defaults.timeFilter, { basis: 'published', from: '', until: '' });
  assert.deepEqual(defaults.schedule, { mode: 'once', timeZone: 'Asia/Shanghai', activeStart: '00:00', activeEnd: '00:00' });
  assert.deepEqual(defaults.sources, { favoriteFolderIds: [], watchLater: true, favoriteArticles: false });
  const rolling = normalizeBilibiliDigestRequest({ sources: { watchLater: true }, timeFilter: { basis: 'added', lookbackDays: 7 }, schedule: { mode: 'daily' } });
  assert.deepEqual(rolling.timeFilter, { basis: 'added', from: '', until: '', lookbackDays: 7 });
});

test('background task normalization rejects impossible dates, ambiguous zones and new destinations', () => {
  for (const value of [
    {}, { sources: {} }, { sources: { favoriteFolderIds: ['https://example.com/'] } },
    { sources: { watchLater: true }, contentKinds: ['article'] },
    { ...request(), timeFilter: { from: '2026-11-01' } },
    { ...request(), timeFilter: { from: '2026-02-30T00:00:00Z' } },
    { ...request(), timeFilter: { from: '2026-13-01T00:00:00Z' } },
    { ...request(), timeFilter: { from: '2026-11-01T24:00:00Z' } },
    { ...request(), timeFilter: { from: '2026-11-01T00:00:00+14:01' } },
    { ...request(), timeFilter: { from: '2026-11-02T00:00:00Z', until: '2026-11-01T00:00:00Z' } },
    { ...request(), timeFilter: { lookbackDays: 0 } },
    { ...request(), timeFilter: { lookbackDays: 366 } },
    { ...request(), timeFilter: { lookbackDays: 1.5 } },
    { ...request(), timeFilter: { lookbackDays: 7, from: '2026-11-01T00:00:00Z' } },
    { ...request(), timeFilter: { lookbackDays: 7, until: '2026-11-01T00:00:00Z' } },
    { ...request(), schedule: { timeZone: '+08:00' } },
    { ...request(), schedule: { timeZone: 'Asia/NotARealZone' } },
    { ...request(), schedule: { activeStart: '25:00' } },
    { ...request(), schedule: { activeEnd: '24:00' } },
    { ...request(), maxItems: 11 }, { ...request(), accountId: 'other' },
    { ...request(), sources: { watchLater: true, url: 'http://localhost/secret' } },
    { ...request(), callbackUrl: 'https://evil.example/steal' },
    { ...request(), modelKey: 'secret' },
  ]) assert.throws(() => normalizeBilibiliDigestRequest(value), undefined, JSON.stringify(value));
});

test('host tasks have explicit effects and only accept actual job identities for status or cancellation', () => {
  assert.deepEqual(bilibiliDigestHostTools().map(tool => tool.name), BILIBILI_HOST_TOOL_NAMES);
  assert.equal(bilibiliDigestToolEffect('queue_library_digest'), 'write');
  assert.equal(bilibiliDigestToolEffect('cancel_library_digest'), 'write');
  assert.equal(bilibiliDigestToolEffect('library_digest_status'), 'read');
  assert.deepEqual(normalizeBilibiliDigestToolInput('library_digest_status', {}), {});
  const jobId = 'a5c83ade-8643-43ac-8ddc-e964e60b9c42';
  assert.deepEqual(normalizeBilibiliDigestToolInput('cancel_library_digest', { jobId: jobId.toUpperCase() }), { jobId });
  for (const input of [{}, { jobId: 'guessed-job' }, { jobId, groupId: 'another' }]) {
    assert.throws(() => normalizeBilibiliDigestToolInput('cancel_library_digest', input));
  }
});

test('standalone MCP never claims to queue a host job or accesses credentials when returning requiresHost', async () => {
  let sessions = 0, queries = 0;
  const f = await fixture({ getSession: () => { sessions++; throw new Error('must not read'); }, handler: async () => { queries++; } });
  try {
    for (const [name, args] of [
      ['queue_library_digest', request()], ['library_digest_status', {}],
      ['cancel_library_digest', { jobId: 'a5c83ade-8643-43ac-8ddc-e964e60b9c42' }],
    ]) {
      const result = await f.client.callTool({ name, arguments: args });
      assert.equal(result.isError, true); assert.equal(parse(result).requiresHost, true);
      assert.match(parse(result).error, /未创建或更改/);
    }
    assert.equal(sessions, 0); assert.equal(queries, 0);
  } finally { await f.close(); }
});

test('library MCP dispatches only fixed methods and returns real publication and addition timestamps separately', async () => {
  const calls = [];
  const libraryClient = Object.fromEntries(['listFavoriteFolders', 'listFavoriteItems', 'listWatchLater', 'listFavoriteArticles', 'readVideo', 'readArticle'].map(name => [name, async input => {
    calls.push({ name, input });
    if (name === 'listFavoriteFolders') return { uid: '999999', folders: [{ id: '123', title: '学习资料', count: 1 }] };
    if (name === 'readVideo' || name === 'readArticle') return { item: name === 'readVideo' ? item() : article(), content: {
      kind: name === 'readVideo' ? 'subtitles' : 'article_text', text: '可核对的正文。', complete: true, coverage: '已取得文字正文' }, sourceUrls: ['https://aisubtitle.hdslb.com/bfs/subtitle/one.json?auth_key=private'] };
    return { items: [name === 'listFavoriteArticles' ? article() : item()], hasMore: false };
  }]));
  const f = await fixture({ getSession: () => 'own-session', libraryClient });
  try {
    const cases = [ ['list_favorite_folders', {}], ['list_favorite_items', { folderId: '123', page: 2, pageSize: 5 }],
      ['list_watch_later', {}], ['list_favorite_articles', { page: 1 }], ['read_video_content', { bvid: BV }], ['read_article_content', { articleId }] ];
    for (const [name, args] of cases) {
      const result = await f.client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, result.content[0].text);
      const data = parse(result); assert.equal(data.source.tool, name);
      assert.ok(Buffer.byteLength(result.content[0].text) <= 24 * 1024);
      assert.equal(result.content[0].text.includes('auth_key'), false);
      if (data.items?.[0]) {
        assert.equal(data.items[0].publishedAt, '2026-11-01T00:00:00.000Z');
        assert.equal(data.items[0].addedAt, '2026-11-10T00:00:00.000Z');
      }
      if (data.content) { assert.ok(data.sourceUrls[0].startsWith('https://www.bilibili.com/')); assert.equal(data.content.complete, true); }
    }
    assert.equal(calls.length, 6); assert.ok(calls.every(call => call.input.signal instanceof AbortSignal));
  } finally { await f.close(); }
});

test('library MCP bounds pagination and never executes site-write or model-supplied URLs', async () => {
  let methods = 0, sessions = 0;
  const client = { listFavoriteItems: async () => { methods++; return { items: [] }; } };
  const f = await fixture({ getSession: () => { sessions++; return ''; }, libraryClient: client });
  try {
    for (const [name, args] of [
      ['list_favorite_items', { folderId: 'https://localhost/private' }], ['list_favorite_items', { folderId: '123', pageSize: 21 }],
      ['list_watch_later', { delete: true }], ['list_favorite_folders', { uid: 'other-user' }], ['read_article_content', { articleId: 'http://x.y/' }],
      ['read_video_content', { bvid: BV, url: 'https://evil.example/' }], ['comment_and_mention', { bvid: BV, comment: 'never' }],
    ]) assert.equal((await f.client.callTool({ name, arguments: args })).isError, true);
    assert.equal(sessions, 0); assert.equal(methods, 0);
  } finally { await f.close(); }
});

test('long library content is clipped as valid JSON with honest coverage and no signed URLs or session fragments', async () => {
  const session = 'private-lib-session-%2F' + 'a'.repeat(1200);
  const f = await fixture({ getSession: () => session, libraryClient: { readVideo: async () => ({
    item: item({ title: session + 'test' }), content: { kind: 'subtitles', complete: true,
      coverage: '原字幕全文', text: session + encodeURIComponent(session) + ' https://aisubtitle.hdslb.com/bfs/subtitle/a.json?auth_key=PRIVATE-CDN-KEY ' + '正文'.repeat(10000),
      segments: Array.from({ length: 100 }, (_, index) => ({ from: index, to: index + 1, text: '字幕'.repeat(500) })) },
    sourceUrls: ['https://aisubtitle.hdslb.com/private.json?auth_key=PRIVATE-CDN-KEY'],
  }) } });
  try {
    const result = await f.client.callTool({ name: 'read_video_content', arguments: { bvid: BV } });
    assert.notEqual(result.isError, true, result.content[0].text);
    const encoded = result.content[0].text, data = JSON.parse(encoded);
    assert.ok(Buffer.byteLength(encoded) <= 24 * 1024); assert.equal(data.truncated, true); assert.equal(data.content.complete, false);
    for (const value of ['private-lib-session', 'PRIVATE-CDN-KEY', 'auth_key']) assert.equal(encoded.includes(value), false);
    assert.match(data.content.coverage, /截断/); assert.deepEqual(data.sourceUrls, [`https://www.bilibili.com/video/${BV}`]);
  } finally { await f.close(); }
});

test('metadata-only and partial video sources stay honest and mismatched content identities fail', async () => {
  let wrong = false;
  const f = await fixture({ libraryClient: { readVideo: async () => ({ item: item({ bvid: wrong ? 'BV1yy411c7mD' : BV }),
    content: { kind: 'metadata_only', text: '仅有标题与简介', complete: false, coverage: '只有元数据', reason: '没有可读取字幕' } }) } });
  try {
    const result = parse(await f.client.callTool({ name: 'read_video_content', arguments: { bvid: BV } }));
    assert.equal(result.content.kind, 'metadata_only'); assert.equal(result.content.complete, false); assert.match(result.content.reason, /没有/);
    wrong = true;
    assert.equal((await f.client.callTool({ name: 'read_video_content', arguments: { bvid: BV } })).isError, true);
    const definitions = bilibiliMcpTools(); assert.equal(definitions.length, 12);
    assert.equal(definitions.filter(tool => tool.annotations.readOnlyHint === false).length, 2);
  } finally { await f.close(); }
});
