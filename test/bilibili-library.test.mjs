import test from 'node:test';
import assert from 'node:assert/strict';
import { createBilibiliLibraryClient } from '../src/bilibili-library.mjs';

const BV = 'BV1xx411c7mD';
const OTHER_BV = 'BV1CZ4y1T7gC';
const SESSION = 'own-library-session%2Cfixture';
const timestamp = 1700000000;
const iso = seconds => new Date(seconds * 1000).toISOString();
const video = fields => ({ bvid: BV, aid: 1111, title: '星空摄影入门', desc: '视频简介', owner: { name: '测试UP' },
  pubdate: timestamp, ctime: timestamp - 1000, cid: 1234, videos: 1,
  pages: [{ cid: 1234, page: 1, part: '第一P', duration: 60 }], ...fields });
const favorite = fields => ({ id: 1111, type: 2, attr: 0, bvid: BV, title: '收藏视频', intro: '收藏简介',
  upper: { name: '收藏UP' }, pubtime: timestamp, ctime: timestamp - 1000, fav_time: timestamp + 1000, ...fields });
const article = fields => ({ id: 4321, title: '摄影专栏', publish_time: timestamp, ctime: timestamp - 1000,
  mtime: timestamp + 500, author: { name: '专栏UP' }, summary: '开头摘要', type: 0, content: '<p>这是完整正文。</p>', ...fields });
const json = (data, status = 200) => new Response(JSON.stringify({ code: 0, data }), { status, headers: { 'content-type': 'application/json' } });
const apiFailure = (code, message = '') => new Response(JSON.stringify({ code, message }), { status: 200 });

function fixture(overrides = {}, { getSession = () => SESSION } = {}) {
  const calls = [];
  const routes = {
    '/x/web-interface/nav': () => json({ isLogin: true, mid: 654321, uname: '本人测试账号' }),
    '/x/v3/fav/folder/created/list-all': () => json({ count: 1, list: [{ id: 1001, fid: 10, mid: 654321, title: '自选收藏夹', attr: 1, media_count: 1 }] }),
    '/x/v3/fav/resource/list': () => json({ info: { id: 1001, mid: 654321, media_count: 1 }, medias: [favorite()], has_more: false }),
    '/x/v2/history/toview': () => json({ count: 1, list: [video({ add_at: timestamp + 2000 })] }),
    '/x/article/favorites/list/all': () => json({ page: { num: 1, size: 16, total: 1 }, favorites: [article({ fav_time: timestamp + 3000 })] }),
    '/x/web-interface/view': () => json(video()),
    '/x/player/v2': () => json({ bvid: BV, cid: 1234, subtitle: { subtitles: [{ lan: 'zh-Hans', lan_doc: '简体中文',
      subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/fixture.json?auth_key=ephemeral-signed-key' }] } }),
    '/bfs/subtitle/fixture.json': () => new Response(JSON.stringify({ body: [{ from: 0, to: 5, content: '第一段字幕。' }, { from: 5, to: 12, content: '第二段字幕。' }] })),
    '/x/article/view': () => json(article()),
    ...overrides,
  };
  const client = createBilibiliLibraryClient({ getSession, now: () => (timestamp + 10000) * 1000,
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      const entry = { url, init: { ...init, headers: { ...init.headers } } };
      calls.push(entry);
      assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
      const route = routes[url.pathname];
      assert.ok(route, `Unknown fixture request: ${url.pathname}`);
      return route(url, init, calls);
    } });
  return { client, calls };
}
const code = expected => error => error?.code === expected;

test('library navigation and owned folders bind to the current SESSDATA identity', async () => {
  const f = fixture();
  assert.deepEqual(await f.client.nav(), { uid: '654321', username: '本人测试账号' });
  assert.deepEqual(await f.client.listFavoriteFolders(), { uid: '654321', folders: [{ id: '1001', title: '自选收藏夹', count: 1 }] });
  assert.equal(f.calls[2].url.searchParams.get('up_mid'), '654321');
  assert.equal(f.calls[2].url.searchParams.get('type'), '2');
  assert.ok(f.calls.every(call => call.url.hostname === 'api.bilibili.com' && call.init.headers.Cookie === `SESSDATA=${SESSION}`));
});

test('favorite videos preserve distinct publication and collection dates, bounded pagination and known skipped types', async () => {
  const f = fixture({ '/x/v3/fav/resource/list': () => json({ info: { id: 1001, mid: 654321 },
    medias: [favorite(), { type: 12, title: '音频' }, favorite({ bvid: OTHER_BV, attr: 9 })], has_more: true }) });
  const result = await f.client.listFavoriteItems({ folderId: '1001', page: 2, pageSize: 7 });
  assert.equal(result.hasMore, true); assert.equal(result.skipped, 2);
  assert.deepEqual(result.items, [{ id: `video:${BV}`, kind: 'video', bvid: BV, title: '收藏视频',
    url: `https://www.bilibili.com/video/${BV}`, uploader: '收藏UP', publishedAt: iso(timestamp), addedAt: iso(timestamp + 1000), description: '收藏简介' }]);
  const query = f.calls.at(-1).url.searchParams;
  assert.equal(query.get('media_id'), '1001'); assert.equal(query.get('pn'), '2'); assert.equal(query.get('ps'), '7');
  assert.equal(query.get('type'), '0'); assert.equal(query.get('order'), 'mtime'); assert.equal(query.get('platform'), 'web');
});

test('a favorite folder must be freshly confirmed as owned by the same credential identity', async () => {
  const f = fixture();
  await assert.rejects(f.client.listFavoriteItems({ folderId: '9999' }), code('BILIBILI_FOLDER_NOT_OWNED'));
  assert.equal(f.calls.some(call => call.url.pathname === '/x/v3/fav/resource/list'), false);
  const foreign = fixture({ '/x/v3/fav/folder/created/list-all': () => json({ count: 1, list: [{ id: 1001, mid: 777777, title: '另一个账号' }] }) });
  await assert.rejects(foreign.client.listFavoriteFolders(), code('BILIBILI_RESPONSE_INVALID'));
  const mismatched = fixture({ '/x/v3/fav/resource/list': () => json({ info: { id: 1001, mid: 777777 }, medias: [favorite()], has_more: false }) });
  await assert.rejects(mismatched.client.listFavoriteItems({ folderId: '1001' }), code('BILIBILI_RESPONSE_INVALID'));
});

test('one operation captures one session, and a later operation cannot reuse a previous user folder catalog', async () => {
  let credential = 'first-session', reads = 0;
  const f = fixture({
    '/x/web-interface/nav': (_url, init) => json({ isLogin: true, mid: init.headers.Cookie.includes('second-session') ? 777777 : 654321, uname: '当前账号' }),
    '/x/v3/fav/folder/created/list-all': url => json({ count: 1, list: [{ id: url.searchParams.get('up_mid') === '654321' ? 1001 : 2002,
      mid: Number(url.searchParams.get('up_mid')), title: '当前账号夹' }] }),
  }, { getSession: () => { reads++; return credential; } });
  await f.client.listFavoriteItems({ folderId: '1001' });
  assert.equal(reads, 1);
  credential = 'second-session';
  await assert.rejects(f.client.listFavoriteItems({ folderId: '1001' }), code('BILIBILI_FOLDER_NOT_OWNED'));
  assert.equal(reads, 2);
  assert.equal(f.calls.filter(call => call.url.pathname === '/x/v3/fav/resource/list').length, 1);
});

test('watch later is a separate video source and uses pubdate and add_at, never ctime as a substitute', async () => {
  const f = fixture({ '/x/v2/history/toview': () => json({ count: 2, list: [video({ add_at: timestamp + 2000 }), video({ bvid: OTHER_BV, pubdate: 0, add_at: 0 })] }) });
  const result = await f.client.listWatchLater();
  assert.equal(result.hasMore, false); assert.equal(result.items[0].publishedAt, iso(timestamp));
  assert.equal(result.items[0].addedAt, iso(timestamp + 2000));
  assert.equal(result.items[1].publishedAt, null); assert.equal(result.items[1].addedAt, null);
  assert.ok(result.items.every(item => item.kind === 'video'));
  assert.equal(f.calls[0].url.pathname, '/x/web-interface/nav');
});

test('article favorites use the documented independent list shape and conservative 16-item pages', async () => {
  const f = fixture({ '/x/article/favorites/list/all': () => json({ page: { num: 1, size: 16, total: 17 },
    favorites: [article({ author: [{ name: '数组作者' }] }), article({ id: 4322, valid: false })] }) });
  const result = await f.client.listFavoriteArticles({ page: 1, pageSize: 20 });
  assert.equal(result.pageSize, 16); assert.equal(result.hasMore, true); assert.equal(result.skipped, 1);
  assert.equal(f.calls.at(-1).url.pathname, '/x/article/favorites/list/all');
  assert.equal(f.calls.at(-1).url.searchParams.get('ps'), '16');
  assert.deepEqual(result.items[0], { id: 'article:4321', kind: 'article', articleId: '4321', title: '摄影专栏',
    url: 'https://www.bilibili.com/read/cv4321', uploader: '数组作者', publishedAt: iso(timestamp), addedAt: null, description: '开头摘要' });
});

test('unknown source response shapes and partial watch-later snapshots fail rather than reporting empty success', async t => {
  const cases = [
    ['/x/v3/fav/folder/created/list-all', { count: 0 }, client => client.listFavoriteFolders()],
    ['/x/v3/fav/resource/list', { info: { id: 1001 }, medias: [], has_more: 0 }, client => client.listFavoriteItems({ folderId: '1001' })],
    ['/x/v2/history/toview', { count: 0, list: null }, client => client.listWatchLater()],
    ['/x/v2/history/toview', { count: 3, list: [video()] }, client => client.listWatchLater()],
    ['/x/article/favorites/list/all', { list: [], total: 0 }, client => client.listFavoriteArticles()],
  ];
  for (const [endpoint, response, invoke] of cases) await t.test(endpoint, async () => {
    const f = fixture({ [endpoint]: () => json(response) });
    await assert.rejects(invoke(f.client), code('BILIBILI_RESPONSE_INVALID'));
  });
});

test('missing or malformed credentials and invalid identity never access a private library', async t => {
  for (const value of ['', 'SESSDATA=whole-cookie', 'token;other=x', 'line\nvalue', { toString() { throw new Error('must not invoke'); } }]) await t.test(typeof value === 'string' ? JSON.stringify(value) : 'object', async () => {
    const f = fixture({}, { getSession: () => value });
    await assert.rejects(f.client.listWatchLater(), code(value === '' ? 'BILIBILI_LOGIN_REQUIRED' : 'BILIBILI_CREDENTIAL_INVALID'));
    assert.equal(f.calls.length, 0);
  });
  const f = fixture({ '/x/web-interface/nav': () => json({ isLogin: false, mid: 654321 }) });
  await assert.rejects(f.client.listFavoriteFolders(), code('BILIBILI_LOGIN_REQUIRED'));
  assert.equal(f.calls.length, 1);
});

test('only temporary authorization callback failures retain a safe retry signal without exposing their original error', async () => {
  const original = Object.assign(new Error(`QQ disconnected: ${SESSION}`), { retryable: true, code: `unsafe-${SESSION}`, statusCode: 418,
    debug: { session: SESSION } });
  for (const getSession of [() => { throw original; }, async () => { throw original; }]) {
    const f = fixture({}, { getSession });
    await assert.rejects(f.client.listWatchLater(), error => error.code === 'BILIBILI_AUTHORIZATION_UNAVAILABLE'
      && error.statusCode === 503 && error.retryable === true && error.bilibiliPublic === true
      && !error.message.includes(SESSION) && !JSON.stringify(error).includes(SESSION) && error.debug === undefined && error.cause === undefined);
    assert.equal(f.calls.length, 0);
  }
  const ordinary = fixture({}, { getSession: () => { throw new Error(SESSION); } });
  await assert.rejects(ordinary.client.nav(), error => error.code === 'BILIBILI_REQUEST_FAILED' && error.retryable === undefined
    && !error.message.includes(SESSION));
  const invalidSession = fixture({}, { getSession: () => '' });
  await assert.rejects(invalidSession.client.nav(), error => error.code === 'BILIBILI_LOGIN_REQUIRED' && error.retryable === undefined);
});

test('input bounds reject arbitrary URLs and paths before any network request', async () => {
  const f = fixture();
  for (const input of [{ bvid: 'https://example.com' }, { bvid: '../../secret' }]) await assert.rejects(f.client.readVideo(input), code('BILIBILI_LIBRARY_INVALID'));
  for (const input of [{ articleId: '0' }, { articleId: 'https://www.bilibili.com/read/cv1' }]) await assert.rejects(f.client.readArticle(input), code('BILIBILI_LIBRARY_INVALID'));
  for (const input of [{ folderId: '1001', page: 0 }, { folderId: '1001', pageSize: 21 }]) await assert.rejects(f.client.listFavoriteItems(input), code('BILIBILI_LIBRARY_INVALID'));
  assert.equal(f.calls.length, 0);
});

test('login, validation and rate restrictions stop after one request and do not reflect secret messages', async t => {
  for (const [status, apiCode, expected] of [[401, null, 'BILIBILI_LOGIN_REQUIRED'], [403, null, 'BILIBILI_RESTRICTED'],
    [412, null, 'BILIBILI_RESTRICTED'], [429, null, 'BILIBILI_RESTRICTED'], [200, -101, 'BILIBILI_LOGIN_REQUIRED'], [200, -352, 'BILIBILI_RESTRICTED']]) await t.test(`${status}/${apiCode}`, async () => {
      const f = fixture({ '/x/web-interface/nav': () => apiCode === null ? new Response(SESSION, { status }) : apiFailure(apiCode, SESSION) });
      await assert.rejects(f.client.nav(), error => error.code === expected && error.retryable === undefined && !error.message.includes(SESSION));
      assert.equal(f.calls.length, 1);
    });
});

test('video reader fetches real subtitle text without forwarding cookies or returning signed URLs', async () => {
  const f = fixture();
  const result = await f.client.readVideo({ bvid: BV });
  assert.equal(result.content.kind, 'subtitles'); assert.equal(result.content.complete, true);
  assert.equal(result.content.text, '第一段字幕。\n第二段字幕。');
  assert.deepEqual(result.content.segments, [{ from: 0, to: 5, text: '第一段字幕。' }, { from: 5, to: 12, text: '第二段字幕。' }]);
  const player = f.calls.find(call => call.url.pathname === '/x/player/v2');
  assert.equal(player.url.searchParams.get('cid'), '1234'); assert.equal(player.url.searchParams.get('bvid'), BV);
  const cdn = f.calls.find(call => call.url.hostname === 'aisubtitle.hdslb.com');
  assert.equal(cdn.url.protocol, 'https:'); assert.equal(cdn.init.headers.Cookie, undefined); assert.equal(cdn.init.headers.Authorization, undefined);
  assert.deepEqual(result.sourceUrls, [`https://www.bilibili.com/video/${BV}`]);
  assert.equal(JSON.stringify(result).includes('auth_key'), false); assert.equal(JSON.stringify(result).includes('ephemeral-signed-key'), false);
});

test('multi-part video coverage only claims the fetched first part, and missing subtitles stay metadata-only', async () => {
  const f = fixture({ '/x/web-interface/view': () => json(video({ videos: 2, pages: [{ cid: 1234, page: 1 }, { cid: 5678, page: 2 }] })) });
  const result = await f.client.readVideo({ bvid: BV });
  assert.equal(result.content.complete, false); assert.match(result.content.coverage, /仅读取第1P.*共2P/u);
  assert.equal(f.calls.filter(call => call.url.pathname === '/x/player/v2').length, 1);
  const empty = fixture({ '/x/player/v2': () => json({ bvid: BV, cid: 1234, need_login_subtitle: true, subtitle: { subtitles: [] } }) }, { getSession: () => '' });
  const metadata = await empty.client.readVideo({ bvid: BV });
  assert.equal(metadata.content.kind, 'metadata_only'); assert.equal(metadata.content.complete, false); assert.match(metadata.content.reason, /登录/u);
  assert.equal(empty.calls.length, 2); assert.ok(empty.calls.every(call => !call.init.headers.Cookie));
});

test('metadata-only videos and empty-text articles retain a real title even when their description is absent', async () => {
  const f = fixture({ '/x/web-interface/view': () => json(video({ title: '只有标题的视频', desc: '' })),
    '/x/player/v2': () => json({ subtitle: { subtitles: [] } }),
    '/x/article/view': () => json(article({ title: '只有标题的专栏', summary: '', content: '<img src="https://i0.hdslb.com/image.jpg">' })) });
  const videoResult = await f.client.readVideo({ bvid: BV });
  assert.equal(videoResult.content.kind, 'metadata_only'); assert.equal(videoResult.content.complete, false);
  assert.equal(videoResult.content.text, '标题：只有标题的视频');
  assert.match(videoResult.content.coverage, /未读取视频字幕、画面或音频/u);
  const articleResult = await f.client.readArticle({ articleId: '4321' });
  assert.equal(articleResult.content.kind, 'metadata_only'); assert.equal(articleResult.content.complete, false);
  assert.equal(articleResult.content.text, '标题：只有标题的专栏');
  assert.match(articleResult.content.coverage, /未取得可总结的正文/u);
  const described = fixture({ '/x/player/v2': () => json({ subtitle: { subtitles: [] } }) });
  const result = await described.client.readVideo({ bvid: BV });
  assert.equal(result.content.text, '标题：星空摄影入门\n简介：视频简介');
});

test('untrusted subtitle hosts, protocols, ports, credentials and paths are rejected before contacting them', async t => {
  for (const target of ['http://aisubtitle.hdslb.com/bfs/subtitle/a.json', 'https://127.0.0.1/bfs/subtitle/a.json',
    'https://aisubtitle.hdslb.com.evil.example/bfs/subtitle/a.json', 'https://aisubtitle.hdslb.com:444/bfs/subtitle/a.json',
    'https://name:password@aisubtitle.hdslb.com/bfs/subtitle/a.json', 'https://aisubtitle.hdslb.com/other/a.json',
    'https://aisubtitle.hdslb.com/bfs/subtitle/a.json#fragment']) await t.test(target, async () => {
      const f = fixture({ '/x/player/v2': () => json({ subtitle: { subtitles: [{ subtitle_url: target }] } }) });
      await assert.rejects(f.client.readVideo({ bvid: BV }), code('BILIBILI_SUBTITLE_URL_REJECTED'));
      assert.equal(f.calls.length, 2);
    });
});

test('redirect responses and mismatched content identity never become successful content', async () => {
  const redirect = fixture({ '/bfs/subtitle/fixture.json': () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } }) });
  await assert.rejects(redirect.client.readVideo({ bvid: BV }), code('BILIBILI_REDIRECT_REJECTED'));
  assert.equal(redirect.calls.length, 3);
  const mismatch = fixture({ '/x/web-interface/view': () => json(video({ bvid: OTHER_BV })) });
  await assert.rejects(mismatch.client.readVideo({ bvid: BV }), code('BILIBILI_RESPONSE_INVALID'));
  const badPlayer = fixture({ '/x/player/v2': () => json({ bvid: BV, cid: 9999, subtitle: { subtitles: [] } }) });
  await assert.rejects(badPlayer.client.readVideo({ bvid: BV }), code('BILIBILI_RESPONSE_INVALID'));
});

test('HTML article extraction removes active content and reports unread media without fetching it', async () => {
  const f = fixture({ '/x/article/view': () => json(article({ content: '<h1>标题</h1><p>第一段&nbsp;&amp; 第二段</p><script>fetch("http://127.0.0.1")</script><style>body{display:none}</style><p>2 < 3</p><img src="http://127.0.0.1/private">' })) });
  const result = await f.client.readArticle({ articleId: '4321' });
  assert.equal(result.content.kind, 'article_text'); assert.equal(result.content.complete, false);
  assert.match(result.content.text, /第一段 & 第二段/u); assert.match(result.content.text, /2 < 3/u);
  assert.equal(result.content.text.includes('fetch'), false); assert.equal(result.content.text.includes('display:none'), false);
  assert.match(result.content.coverage, /图片.*未读取/u); assert.equal(f.calls.length, 1);
  assert.deepEqual(result.sourceUrls, ['https://www.bilibili.com/read/cv4321']);
});

test('article rich-text ops extract only real text inserts; image-only and unknown formats are explicit', async () => {
  const f = fixture({ '/x/article/view': () => json(article({ type: 3, content: JSON.stringify({ ops: [
    { insert: '实际正文第一段\n' }, { insert: { 'native-image': { src: 'https://evil.example/unused' } } }, { insert: '第二段正文' },
  ] }) })) });
  const result = await f.client.readArticle({ articleId: 4321 });
  assert.equal(result.content.text, '实际正文第一段\n第二段正文'); assert.equal(result.content.complete, false);
  assert.equal(f.calls.length, 1);
  const image = fixture({ '/x/article/view': () => json(article({ content: '<img src="https://i0.hdslb.com/image.jpg">' })) });
  assert.equal((await image.client.readArticle({ articleId: '4321' })).content.kind, 'metadata_only');
  const unsupported = fixture({ '/x/article/view': () => json(article({ type: 8 })) });
  await assert.rejects(unsupported.client.readArticle({ articleId: '4321' }), code('BILIBILI_RESPONSE_INVALID'));
});

test('long article and subtitle text is capped with incomplete coverage and redacted before clipping', async () => {
  const secret = 'long-private-session-value-'.repeat(50);
  const f = fixture({ '/x/article/view': () => json(article({ title: secret + '标题', content: `<p>${'文'.repeat(23990)}${secret}后续${'字'.repeat(2000)}</p>` })) }, { getSession: () => secret });
  const result = await f.client.readArticle({ articleId: '4321' });
  assert.equal(result.content.text.length, 24000); assert.equal(result.content.complete, false);
  assert.equal(JSON.stringify(result).includes('long-private-session-value-'), false);
  const videoFx = fixture({ '/bfs/subtitle/fixture.json': () => new Response(JSON.stringify({ body: [{ from: 0, to: 60, content: '字'.repeat(25000) }] })) });
  const subtitle = await videoFx.client.readVideo({ bvid: BV });
  assert.equal(subtitle.content.text.length, 24000); assert.equal(subtitle.content.complete, false); assert.match(subtitle.content.coverage, /截断/u);
});

test('response bodies have a hard byte limit and cancellation propagates through a stalled body', async () => {
  let cancelled = false;
  const large = fixture({ '/x/web-interface/nav': () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(600000)); controller.enqueue(new Uint8Array(600000)); }, cancel() { cancelled = true; },
  })) });
  await assert.rejects(large.client.nav(), code('BILIBILI_RESPONSE_TOO_LARGE')); assert.equal(cancelled, true);
  const abortController = new AbortController(); let sawSignal;
  const stalled = fixture({ '/x/web-interface/nav': (_url, init) => {
    sawSignal = init.signal;
    setTimeout(() => abortController.abort(), 10);
    return new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }));
  } });
  await assert.rejects(stalled.client.nav({ signal: abortController.signal }), code('BILIBILI_ABORTED'));
  assert.equal(sawSignal.aborted, true); assert.equal(stalled.calls.length, 1);
});

test('a single absolute10second deadline covers all stages rather than resetting per request', { timeout: 14000 }, async () => {
  const wait = init => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 5200);
    init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
  });
  const f = fixture({
    '/x/web-interface/view': async (_url, init) => { await wait(init); return json(video()); },
    '/x/player/v2': async (_url, init) => { await wait(init); return json({ subtitle: { subtitles: [] } }); },
  });
  const start = Date.now();
  await assert.rejects(f.client.readVideo({ bvid: BV }), code('BILIBILI_TIMEOUT'));
  assert.ok(Date.now() - start < 13000); assert.equal(f.calls.length, 2);
});
