import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBilibiliClient } from '../examples/plugins/bilibili-assistant/http.mjs';
import { callTool, run } from '../examples/plugins/bilibili-assistant/index.mjs';
import { createPluginManager } from '../src/plugins.mjs';

const BV = 'BV1xx411c7mD';
const video = overrides => ({ bvid: BV, aid: 123456, title: '天文 &amp; 星空', desc: '一段视频简介', owner: { name: '示例 UP' }, duration: 180, ...overrides });
const ok = data => new Response(JSON.stringify({ code: 0, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const settings = { maxResults: 5, targetUid: '987654321', targetName: '固定接收人' };
const secrets = { sessdata: 'fake-session%2Cvalue', csrf: 'fake-csrf-value' };

test('Bilibili 示例可按插件契约安装，手动检查不联网也不声称登录成功', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bilibili-plugin-'));
  const manager = createPluginManager({ dataDir: directory });
  try {
    await manager.install(fileURLToPath(new URL('../examples/plugins/bilibili-assistant/', import.meta.url)));
    const manifest = manager.get('bilibili-assistant');
    assert.deepEqual(manifest.tools.map(tool => tool.name), ['popular_videos', 'search_videos', 'video_details', 'comment_and_mention']);
    assert.equal(manifest.tools.find(tool => tool.name === 'comment_and_mention').effect, 'write');
    assert.deepEqual(manifest.secretsSchema.map(field => field.key), ['sessdata', 'csrf']);
    const result = await manager.execute('bilibili-assistant', { handler: 'run', settings: {}, context: {} });
    assert.match(result.text, /不联网.*不验证真实登录/);
    assert.match((await run()).text, /写入授权/);
  } finally { await manager.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('热门和搜索只调用固定接口，限制条数并把视频元数据与观看内容区分', async () => {
  const requests = [];
  const client = createBilibiliClient({ fetchImpl: async (url, request) => {
    requests.push({ url: new URL(url), request });
    if (url.pathname.endsWith('/popular')) return ok({ list: [video(), video({ bvid: 'BV1ab411c7mD' }), video({ bvid: 'BV1cd411c7mD' })] });
    return ok({ result: [video({ title: '<em class="keyword">天文</em> &amp; 星空', author: '作者', owner: undefined, duration: '3:00' })] });
  } });
  const popular = await client.popular({ limit: 8, page: 2 }, { maxResults: 2 });
  assert.equal(popular.videos.length, 2);
  assert.match(popular.basis, /未观看/);
  assert.equal(popular.videos[0].url, `https://www.bilibili.com/video/${BV}`);
  assert.equal(popular.videos[0].title, '天文 & 星空');
  const search = await client.search({ keyword: '天文 & 星空?', page: 1, limit: 3 }, settings, secrets);
  assert.equal(search.videos[0].title, '天文 & 星空');
  assert.equal(search.videos[0].uploader, '作者');
  assert.equal(requests[0].url.origin, 'https://api.bilibili.com');
  assert.equal(requests[0].url.pathname, '/x/web-interface/popular');
  assert.equal(requests[0].url.searchParams.get('ps'), '2');
  assert.equal(requests[0].url.searchParams.get('pn'), '2');
  assert.equal(requests[1].url.pathname, '/x/web-interface/search/type');
  assert.equal(requests[1].url.searchParams.get('search_type'), 'video');
  assert.equal(requests[1].url.searchParams.get('keyword'), '天文 & 星空?');
  for (const { request } of requests) {
    assert.equal(request.method, 'GET'); assert.equal(request.redirect, 'error');
    assert.ok(request.signal instanceof AbortSignal);
  }
  assert.equal(requests[1].request.headers.Cookie, `SESSDATA=${secrets.sessdata}; bili_jct=${secrets.csrf}`);
  assert.equal(JSON.stringify(search).includes(secrets.sessdata), false);
});

test('视频详情核对 BV 与 aid，拒绝任意网址、超限参数和错误视频身份', async () => {
  const requests = [];
  const client = createBilibiliClient({ fetchImpl: async url => { requests.push(new URL(url)); return ok(video()); } });
  const result = await client.details({ bvid: BV });
  assert.equal(result.video.aid, '123456');
  assert.equal(requests[0].pathname, '/x/web-interface/view');
  assert.equal(requests[0].searchParams.get('bvid'), BV);
  for (const bvid of ['https://evil.test/video', '../escape', 'BV1']) await assert.rejects(client.details({ bvid }), /BV/);
  await assert.rejects(client.search({ keyword: '' }), /搜索词/);
  await assert.rejects(client.search({ keyword: 'a'.repeat(101) }), /搜索词/);
  await assert.rejects(client.popular({ page: 6 }), /页码/);
  await assert.rejects(client.popular({ limit: 0 }), /条数/);
  assert.equal(requests.length, 1);
  const mismatched = createBilibiliClient({ fetchImpl: async () => ok(video({ bvid: 'BV1ab411c7mD' })) });
  await assert.rejects(mismatched.details({ bvid: BV }), /身份/);
  const unsafeAid = createBilibiliClient({ fetchImpl: async () => ok(video({ aid: Number.MAX_SAFE_INTEGER + 1 })) });
  await assert.rejects(unsafeAid.details({ bvid: BV }), /身份/);
});

test('评论只使用主人固定的 @ 目标，先核对 aid，再做一次受登录保护的 POST', async () => {
  const requests = [];
  const client = createBilibiliClient({ fetchImpl: async (url, request) => {
    requests.push({ url: new URL(url), request });
    return request.method === 'GET' ? ok(video()) : ok({ rpid_str: '12345678901234567890' });
  } });
  const result = await client.commentAndMention({ bvid: BV, comment: '这个科普很有趣。' }, settings, secrets);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].request.method, 'GET');
  assert.equal(requests[1].url.href, 'https://api.bilibili.com/x/v2/reply/add');
  assert.equal(requests[1].request.method, 'POST');
  assert.equal(requests[1].request.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(requests[1].request.body);
  assert.equal(form.get('type'), '1'); assert.equal(form.get('oid'), '123456');
  assert.equal(form.get('message'), '@固定接收人 这个科普很有趣。');
  assert.deepEqual(JSON.parse(form.get('at_name_to_mid')), { 固定接收人: '987654321' });
  assert.equal(form.get('csrf'), secrets.csrf);
  assert.equal(result.rpid, '12345678901234567890');
  assert.equal(result.action, 'comment_submitted');
  assert.equal(result.mentionNotificationVerified, false);
  assert.equal(JSON.stringify(result).includes(secrets.sessdata), false);
  assert.equal(JSON.stringify(result).includes(secrets.csrf), false);
});

test('评论凭据、固定目标与正文不合格时在发请求前拒绝', async () => {
  let calls = 0;
  const client = createBilibiliClient({ fetchImpl: async () => { calls++; return ok(video()); } });
  await assert.rejects(client.commentAndMention({ bvid: BV, comment: '正文' }, settings), /凭据/);
  await assert.rejects(client.commentAndMention({ bvid: BV, comment: '正文' }, {}, secrets), /UID/);
  await assert.rejects(client.commentAndMention({ bvid: BV, comment: '@其他人 正文' }, settings, secrets), /其他 @/);
  await assert.rejects(client.commentAndMention({ bvid: BV, comment: '正文' }, settings, { ...secrets, sessdata: 'value; injected=1' }), /单个凭据/);
  await assert.rejects(client.commentAndMention({ bvid: BV, comment: 'a'.repeat(301) }, settings, secrets), /300/);
  assert.equal(calls, 0);
});

test('登录、风控和频率错误停止且不自动重试，不回显服务端凭据内容', async () => {
  for (const status of [403, 412, 429]) {
    let calls = 0;
    const client = createBilibiliClient({ fetchImpl: async () => { calls++; return new Response(secrets.sessdata, { status }); } });
    await assert.rejects(client.popular(), error => !error.message.includes(secrets.sessdata) && /不会绕过/.test(error.message));
    assert.equal(calls, 1);
  }
  for (const code of [-101, -111, -352, -509, 12015, 12051]) {
    let calls = 0;
    const client = createBilibiliClient({ fetchImpl: async () => { calls++; return new Response(JSON.stringify({ code, message: secrets.sessdata }), { status: 200 }); } });
    await assert.rejects(client.popular(), error => !error.message.includes(secrets.sessdata));
    assert.equal(calls, 1);
  }
  const redirect = createBilibiliClient({ fetchImpl: async () => ({ ok: true, status: 200, redirected: true, url: 'https://evil.test/' }) });
  await assert.rejects(redirect.popular(), /重定向/);
});

test('评论网络和回执失败报告结果未知，绝不自动重复提交', async () => {
  for (const failure of ['network', 'invalid-json', 'missing-receipt']) {
    let posts = 0, gets = 0;
    const client = createBilibiliClient({ fetchImpl: async (_url, request) => {
      if (request.method === 'GET') { gets++; return ok(video()); }
      posts++;
      if (failure === 'network') throw new Error(secrets.sessdata);
      if (failure === 'invalid-json') return new Response(secrets.csrf, { status: 200 });
      return ok({});
    } });
    await assert.rejects(client.commentAndMention({ bvid: BV, comment: '正文' }, settings, secrets), error =>
      /未知|无法确认/.test(error.message) && !error.message.includes(secrets.sessdata) && !error.message.includes(secrets.csrf));
    assert.equal(posts, 1); assert.equal(gets, 1);
  }
});

test('读取严格限制响应大小和解析错误，网络异常不带出原始异常文本', async () => {
  const tooLarge = createBilibiliClient({ fetchImpl: async () => new Response('small', { headers: { 'content-length': String(1024 * 1024 + 1) } }) });
  await assert.rejects(tooLarge.popular(), /1 MiB/);
  const streamed = createBilibiliClient({ fetchImpl: async () => new Response('x'.repeat(1024 * 1024 + 1)) });
  await assert.rejects(streamed.popular(), /1 MiB/);
  const invalid = createBilibiliClient({ fetchImpl: async () => new Response(secrets.sessdata) });
  await assert.rejects(invalid.popular(), error => /JSON/.test(error.message) && !error.message.includes(secrets.sessdata));
  const network = createBilibiliClient({ fetchImpl: async () => { throw new Error(secrets.csrf); } });
  await assert.rejects(network.popular(), error => /无法连接/.test(error.message) && !error.message.includes(secrets.csrf));
});

test('真实插件入口保留文字协议并遮盖意外回显的本插件凭据', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return ok({ list: [video({ desc: `简介里意外出现 ${secrets.sessdata} ${secrets.csrf}` })] }); };
  try {
    const result = await callTool({ name: 'popular_videos', arguments: {}, settings, secrets });
    assert.match(result.text, /已隐藏/);
    assert.equal(result.text.includes(secrets.sessdata), false);
    assert.equal(result.text.includes(secrets.csrf), false);
    assert.ok(result.text.length <= 6000);
    await assert.rejects(callTool({ name: 'not_a_tool' }), /不支持/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});
