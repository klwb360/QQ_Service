import test from 'node:test';
import assert from 'node:assert/strict';
import { readBilibiliDigestSources } from '../src/bilibili-digest-sources.mjs';

const FROM = '2026-11-01T00:00:00.000Z';
const UNTIL = '2026-11-12T00:00:00.000Z';
const NOW = Date.parse(UNTIL);
const clone = value => structuredClone(value);
const video = (index, values = {}) => {
  const bvid = `BV${String(index).padStart(10, '0')}`;
  return { id: `video:${bvid}`, kind: 'video', bvid, title: `视频${index}`, uploader: '测试UP',
    url: `https://www.bilibili.com/video/${bvid}`, publishedAt: FROM, addedAt: FROM, ...values };
};
const article = (index, values = {}) => ({ id: `article:${index}`, kind: 'article', articleId: String(index), title: `专栏${index}`,
  uploader: '测试作者', url: `https://www.bilibili.com/read/cv${index}`, publishedAt: FROM, addedAt: FROM, ...values });
const content = (item, values = {}) => ({ item: { ...clone(item), addedAt: null },
  content: { kind: item.kind === 'video' ? 'subtitles' : 'article_text', text: `${item.title}的实际来源文字`, complete: true, coverage: '测试的完整来源文字', ...values },
  sourceUrls: [item.url] });
const job = values => ({ request: { sources: { favoriteFolderIds: ['11'], watchLater: false, favoriteArticles: false }, maxItems: 10, ...values } });

function fixture({ favorites = { 11: [] }, watch = [], articles = [], read } = {}) {
  const calls = [];
  const allItems = [...Object.values(favorites).flat(), ...watch, ...articles];
  const pageOf = (items, { page, pageSize }) => ({ items: clone(items.slice((page - 1) * pageSize, page * pageSize)), hasMore: page * pageSize < items.length });
  const client = {
    async listFavoriteItems(options) { calls.push({ method: 'favorites', ...options }); return pageOf(favorites[options.folderId] || [], options); },
    async listWatchLater(options) { calls.push({ method: 'watch', ...options }); return { items: clone(watch), hasMore: false }; },
    async listFavoriteArticles(options) { calls.push({ method: 'articles', ...options }); return pageOf(articles, options); },
    async readVideo(options) {
      calls.push({ method: 'video', ...options });
      const item = allItems.find(item => item.bvid === options.bvid);
      return read ? read(item, options) : content(item);
    },
    async readArticle(options) {
      calls.push({ method: 'article', ...options });
      const item = allItems.find(item => item.articleId === options.articleId);
      return read ? read(item, options) : content(item);
    },
  };
  return { client, calls, options: { client, authorize: () => {}, now: () => NOW } };
}

test('published filtering is lower-inclusive/upper-exclusive, never substitutes added dates, and sorts before reading', async () => {
  const first = video(1, { publishedAt: FROM }), newer = video(2, { publishedAt: '2026-11-10T00:00:00.000Z' });
  const atEnd = video(3, { publishedAt: UNTIL });
  const missing = video(4, { publishedAt: null, addedAt: '2026-11-11T00:00:00.000Z' });
  const before = video(5, { publishedAt: '2026-10-31T23:59:59.999Z' });
  const f = fixture({ favorites: { 11: [first, atEnd, missing, before, newer] } });
  const result = await readBilibiliDigestSources(job({ timeFilter: { basis: 'published', from: FROM, until: UNTIL } }), f.options);
  assert.deepEqual(result.items.map(row => row.item.id), [newer.id, first.id]);
  assert.deepEqual(f.calls.filter(call => call.method === 'video').map(call => call.bvid), [newer.bvid, first.bvid]);
  assert.ok(result.skipped.some(row => row.id === missing.id && row.code === 'MISSING_PUBLISHED_DATE'));
  assert.equal(result.skipped.filter(row => row.code === 'OUTSIDE_TIME_RANGE').length, 2);
  assert.equal(result.scan.scanned, 5); assert.equal(result.scan.filtered, 3);
});

test('added-date selection considers every selected source before deduplicating and preserves its membership date', async () => {
  const old = video(1, { addedAt: '2026-10-01T00:00:00.000Z' });
  const selected = { ...old, addedAt: '2026-11-10T00:00:00.000Z' };
  const f = fixture({ favorites: { 11: [old] }, watch: [selected] });
  const result = await readBilibiliDigestSources(job({ sources: { favoriteFolderIds: ['11'], watchLater: true },
    timeFilter: { basis: 'added', from: FROM, until: UNTIL } }), f.options);
  assert.equal(result.items.length, 1); assert.equal(result.items[0].item.addedAt, selected.addedAt);
  assert.deepEqual(result.items[0].selection.sourceIds, ['watch_later']);
  assert.equal(result.scan.duplicates, 1); assert.equal(f.calls.filter(call => call.method === 'video').length, 1);
});

test('processed items and repeated source identities never cause duplicate content reads', async () => {
  const a = video(1), done = video(2), b = article(3);
  const f = fixture({ favorites: { 11: [a, done], 22: [a] }, watch: [a], articles: [b] });
  const result = await readBilibiliDigestSources(job({ sources: { favoriteFolderIds: ['11', '22'], watchLater: true, favoriteArticles: true } }),
    { ...f.options, processedItemIds: [done.id] });
  assert.deepEqual(result.items.map(row => row.item.id).sort(), [a.id, b.id].sort());
  assert.equal(result.scan.duplicates, 2); assert.equal(result.scan.alreadyProcessed, 1);
  assert.equal(f.calls.filter(call => ['video', 'article'].includes(call.method)).length, 2);
  assert.ok(result.skipped.some(row => row.id === done.id && row.code === 'ALREADY_PROCESSED'));
  assert.deepEqual(new Set(result.items.find(row => row.item.id === a.id).selection.sourceIds), new Set(['favorite:11', 'favorite:22', 'watch_later']));
});

test('missing dates are retained only without a bounded time filter, and content categories avoid unnecessary source requests', async () => {
  const a = article(1, { publishedAt: null, addedAt: null });
  const f = fixture({ favorites: { 11: [video(1)] }, watch: [video(2)], articles: [a] });
  const result = await readBilibiliDigestSources(job({ sources: { favoriteFolderIds: ['11'], watchLater: true, favoriteArticles: true }, contentKinds: ['article'] }), f.options);
  assert.equal(result.items.length, 1); assert.equal(result.items[0].item.id, a.id);
  assert.ok(f.calls.every(call => ['articles', 'article'].includes(call.method)));
  assert.equal(result.skipped.filter(row => row.code === 'KIND_NOT_SELECTED').length, 2);
  const bounded = await readBilibiliDigestSources(job({ sources: { favoriteArticles: true }, contentKinds: ['article'],
    timeFilter: { basis: 'added', from: FROM } }), f.options);
  assert.equal(bounded.items.length, 0);
  assert.ok(bounded.skipped.some(row => row.code === 'MISSING_ADDED_DATE'));
});

test('all selected paginated sources share five pages; content count has a separate maxItems limit', async () => {
  const rows = Array.from({ length: 160 }, (_, index) => video(index + 1, { publishedAt: new Date(NOW - (index + 1) * 1000).toISOString() }));
  const f = fixture({ favorites: { 11: rows, 22: rows.slice(100) }, articles: Array.from({ length: 30 }, (_, index) => article(index + 1)) });
  const result = await readBilibiliDigestSources(job({ sources: { favoriteFolderIds: ['11', '22'], favoriteArticles: true }, maxItems: 3 }), f.options);
  const listings = f.calls.filter(call => ['favorites', 'articles'].includes(call.method));
  assert.equal(listings.length, 5); assert.equal(result.scan.pages, 5);
  assert.equal(result.scan.scanned, 100); assert.equal(result.scan.truncated, true);
  assert.equal(result.scan.sourcesScanned, 3); assert.equal(result.items.length, 3);
  assert.equal(result.scan.contentReads, 3); assert.ok(result.skipped.some(row => row.code === 'ITEM_BUDGET'));
  assert.ok(listings.every(call => call.pageSize === 20));
});

test('large non-paginated watch-later responses stop at100 candidates and report their truncation', async () => {
  const f = fixture({ watch: Array.from({ length: 150 }, (_, index) => video(index + 1)) });
  const result = await readBilibiliDigestSources(job({ sources: { watchLater: true }, maxItems: 2 }), f.options);
  assert.equal(result.scan.scanned, 100); assert.equal(result.scan.pages, 1);
  assert.equal(result.scan.truncated, true); assert.equal(result.items.length, 2);
  assert.equal(f.calls.length, 3);
});

test('fixed list page sizes do not shift offsets when the remaining global candidate budget becomes smaller', async () => {
  const favorites = Array.from({ length: 60 }, (_, index) => video(index + 1));
  const articles = Array.from({ length: 35 }, (_, index) => article(index + 1));
  const f = fixture({ favorites: { 11: favorites }, watch: Array.from({ length: 45 }, (_, index) => video(index + 100)), articles });
  const result = await readBilibiliDigestSources(job({ sources: { favoriteFolderIds: ['11'], favoriteArticles: true, watchLater: true }, maxItems: 1 }), f.options);
  assert.equal(result.scan.scanned, 100);
  const pages = f.calls.filter(call => call.method === 'favorites');
  assert.deepEqual(pages.map(call => [call.page, call.pageSize]), [[1, 20], [2, 20]]);
  assert.equal(result.scan.truncated, true);
});

test('a metadata-only reader result is preserved as incomplete evidence, not promoted to a full-video summary', async () => {
  const item = video(1);
  const f = fixture({ favorites: { 11: [item] }, read: row => content(row, {
    kind: 'metadata_only', text: '视频简介', complete: false, coverage: '仅标题和简介，无字幕。', reason: '没有可用字幕。',
  }) });
  const result = await readBilibiliDigestSources(job(), f.options);
  assert.equal(result.items[0].content.kind, 'metadata_only');
  assert.equal(result.items[0].content.complete, false); assert.match(result.items[0].content.reason, /字幕/);
});

test('missing content is skipped but login, restriction and unexpected source failures propagate', async t => {
  const item = video(1);
  for (const [code, statusCode, skips] of [
    ['BILIBILI_NOT_FOUND', 404, true], ['BILIBILI_LOGIN_REQUIRED', 401, false], ['BILIBILI_CREDENTIAL_INVALID', 400, false],
    ['BILIBILI_RESTRICTED', 429, false], ['BILIBILI_ABORTED', 409, false], ['BILIBILI_TIMEOUT', 408, false], ['BILIBILI_REQUEST_FAILED', 502, false],
    ['BILIBILI_RESPONSE_INVALID', 502, false],
  ]) await t.test(code, async () => {
    const error = Object.assign(new Error('Controlled source error'), { code, statusCode });
    const f = fixture({ favorites: { 11: [item] }, read: () => { throw error; } });
    if (skips) {
      const result = await readBilibiliDigestSources(job(), f.options);
      assert.equal(result.items.length, 0); assert.equal(result.skipped[0].code, 'CONTENT_UNAVAILABLE');
    } else await assert.rejects(readBilibiliDigestSources(job(), f.options), cause => cause === error);
  });
  const f = fixture(); f.client.listFavoriteItems = async () => { throw Object.assign(new Error('No owned folder'), { code: 'BILIBILI_FOLDER_NOT_OWNED', statusCode: 403 }); };
  await assert.rejects(readBilibiliDigestSources(job(), f.options), { code: 'BILIBILI_FOLDER_NOT_OWNED' });
});

test('revocation after a list await stops content reads, and cancellation during a read prevents further content work', async () => {
  const a = video(1), b = video(2), f = fixture({ favorites: { 11: [a, b] } });
  let allowed = true;
  const original = f.client.listFavoriteItems;
  f.client.listFavoriteItems = async options => { const result = await original(options); allowed = false; return result; };
  await assert.rejects(readBilibiliDigestSources(job(), { ...f.options, authorize() { if (!allowed) throw new Error('Permission revoked'); } }), /Permission revoked/);
  assert.equal(f.calls.filter(call => call.method === 'video').length, 0);
  const controller = new AbortController();
  const other = fixture({ favorites: { 11: [a, b] }, read: row => { controller.abort(); return content(row); } });
  await assert.rejects(readBilibiliDigestSources(job(), { ...other.options, signal: controller.signal }), { code: 'BILIBILI_ABORTED' });
  assert.equal(other.calls.filter(call => call.method === 'video').length, 1);
});

test('no sources, malformed job scopes and already aborted work never touch a source client', async () => {
  const f = fixture({ favorites: { 11: [video(1)] } });
  await assert.rejects(readBilibiliDigestSources(job({ sources: {} }), f.options), /来源/);
  await assert.rejects(readBilibiliDigestSources(job({ sources: { favoriteFolderIds: ['https://bad'] } }), f.options), /收藏夹编号/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readBilibiliDigestSources(job(), { ...f.options, signal: controller.signal }), { code: 'BILIBILI_ABORTED' });
  assert.deepEqual(f.calls, []);
});

test('content identity or updated publication date cannot bypass the selected metadata scope', async () => {
  const selected = video(1), other = video(2);
  const mismatch = fixture({ favorites: { 11: [selected] }, read: () => content(other) });
  await assert.rejects(readBilibiliDigestSources(job(), mismatch.options), { code: 'BILIBILI_DIGEST_SOURCE_MISMATCH' });
  const shifted = fixture({ favorites: { 11: [selected] }, read: row => content({ ...row, publishedAt: UNTIL }) });
  const result = await readBilibiliDigestSources(job({ timeFilter: { basis: 'published', from: FROM, until: UNTIL } }), shifted.options);
  assert.equal(result.items.length, 0); assert.equal(result.skipped[0].code, 'OUTSIDE_TIME_RANGE');
});

test('daily lookback bounds are recalculated for each run instead of freezing the task creation date', async () => {
  const previous = video(1, { publishedAt: '2026-11-10T12:00:00.000Z' }), recent = video(2, { publishedAt: '2026-11-12T12:00:00.000Z' });
  const f = fixture({ favorites: { 11: [previous, recent] } });
  const daily = job({ timeFilter: { basis: 'published', lookbackDays: 1 }, schedule: { mode: 'daily' } });
  const before = clone(daily);
  const first = await readBilibiliDigestSources(daily, { ...f.options, now: () => Date.parse('2026-11-11T00:00:00.000Z') });
  const later = await readBilibiliDigestSources(daily, { ...f.options, now: () => Date.parse('2026-11-13T00:00:00.000Z') });
  assert.deepEqual(first.items.map(row => row.item.id), [previous.id]);
  assert.deepEqual(later.items.map(row => row.item.id), [recent.id]);
  assert.deepEqual(daily, before);
  const effective = await readBilibiliDigestSources({ ...daily, effectiveTimeFilter: { basis: 'published', from: '2026-11-12T00:00:00.000Z', until: '2026-11-13T00:00:00.000Z' } }, f.options);
  assert.deepEqual(effective.items.map(row => row.item.id), [recent.id]);
});

test('more selected sources than the page budget are explicitly reported instead of claimed as fully scanned', async () => {
  const favorites = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [String(index + 1), [video(index + 1)]]));
  const f = fixture({ favorites });
  const result = await readBilibiliDigestSources(job({ sources: { favoriteFolderIds: Object.keys(favorites) } }), f.options);
  assert.equal(result.scan.sourceCount, 8); assert.equal(result.scan.sourcesScanned, 5); assert.equal(result.scan.pages, 5);
  assert.deepEqual(result.scan.omittedSources, ['favorite:6', 'favorite:7', 'favorite:8']);
  assert.equal(result.scan.truncated, true); assert.equal(result.items.length, 5);
});

test('malformed missing publication dates are not interpreted through rollover or added dates', async () => {
  const f = fixture({ favorites: { 11: [video(1, { publishedAt: '2026-02-30T00:00:00Z', addedAt: FROM }),
    video(2, { publishedAt: '2026-11-01T08:00:00+08:00' })] } });
  const result = await readBilibiliDigestSources(job({ timeFilter: { basis: 'published', from: FROM, until: UNTIL } }), f.options);
  assert.deepEqual(result.items.map(row => row.item.id), [video(2).id]);
  assert.ok(result.skipped.some(row => row.id === video(1).id && row.code === 'MISSING_PUBLISHED_DATE'));
});
