const API_ORIGIN = 'https://api.bilibili.com';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const BVID = /^BV[0-9A-Za-z]{10}$/;
const UID = /^[1-9]\d{0,19}$/;

const fail = message => Object.assign(new Error(message), { bilibiliPublic: true });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positiveId = value => {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) return '';
  return ['number', 'string'].includes(typeof value) && UID.test(String(value)) ? String(value) : '';
};
const cleanText = (value, max) => String(value ?? '')
  .replace(/<[^>]*>/g, '')
  .replace(/&(?:amp|lt|gt|quot|apos|#39);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'" })[entity])
  .replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const videoUrl = bvid => `https://www.bilibili.com/video/${bvid}`;
const boundedInteger = (value, fallback, min, max, label) => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw fail(`${label}须为 ${min}–${max} 的整数。`);
  return value;
};
const requireBvid = bvid => {
  if (typeof bvid !== 'string' || !BVID.test(bvid)) throw fail('请提供有效的 BV 视频编号。');
  return bvid;
};

function secretValue(secrets, key) {
  const value = secrets?.[key];
  if (value === undefined || value === '') return '';
  // Each field is one cookie value, never an arbitrary Cookie header.
  if (typeof value !== 'string' || value.length > 2000 || /[\s;\r\n\u0000-\u001f\u007f]/u.test(value)) {
    throw fail('Bilibili 登录字段格式无效；请填写单个凭据值。');
  }
  return value;
}

function credentials(secrets = {}) {
  const sessdata = secretValue(secrets, 'sessdata');
  const csrf = secretValue(secrets, 'csrf');
  return { sessdata, csrf, cookie: [sessdata && `SESSDATA=${sessdata}`, csrf && `bili_jct=${csrf}`].filter(Boolean).join('; ') };
}

function apiFailure(code) {
  if ([-101, -102].includes(code)) return 'Bilibili 登录已失效或账号不可用，请到网站核对登录状态。';
  if (code === -111) return 'Bilibili CSRF 校验失败，请核对同一次登录的凭据。';
  if ([-352, -412, -509, 12015].includes(code)) return 'Bilibili 要求验证或限制请求频率；请在网站处理后重试，本插件不会绕过验证。';
  if (code === 12051) return 'Bilibili 拒绝重复评论；本插件没有自动重试。';
  if ([12002, 12003, 12052].includes(code)) return '当前 Bilibili 评论区不允许发表评论。';
  if (code === -404) return 'Bilibili 未找到该视频或内容不可访问。';
  return 'Bilibili 未接受本次请求，请在网站核对账号和内容状态。';
}

async function boundedJson(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel?.();
    throw fail('Bilibili 响应超过 1 MiB，已停止处理。');
  }
  let raw;
  if (response.body?.[Symbol.asyncIterator]) {
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw fail('Bilibili 响应超过 1 MiB，已停止处理。');
      chunks.push(Buffer.from(chunk));
    }
    raw = Buffer.concat(chunks, bytes).toString('utf8');
  } else {
    raw = await response.text();
    if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) throw fail('Bilibili 响应超过 1 MiB，已停止处理。');
  }
  try { return JSON.parse(raw); }
  catch { throw fail('Bilibili 返回的内容不是可用的 JSON。'); }
}

function summarizeVideo(item, { detail = false, queriedBvid } = {}) {
  if (!object(item)) return null;
  const bvid = queriedBvid || item.bvid;
  if (typeof bvid !== 'string' || !BVID.test(bvid)) return null;
  if (queriedBvid && item.bvid && item.bvid !== queriedBvid) throw fail('Bilibili 返回的视频身份与请求不一致。');
  return {
    bvid, aid: positiveId(item.aid), title: cleanText(item.title, 120),
    description: cleanText(item.desc ?? item.description, detail ? 3000 : 160),
    uploader: cleanText(item.owner?.name ?? item.author, 60),
    duration: typeof item.duration === 'number' && Number.isFinite(item.duration) ? Math.max(0, Math.floor(item.duration)) : cleanText(item.duration, 12),
    url: videoUrl(bvid),
  };
}

export function createBilibiliClient({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl 必须为函数。');

  async function request(pathname, { query = {}, form, secrets = {} } = {}) {
    const url = new URL(pathname, API_ORIGIN);
    if (url.origin !== API_ORIGIN || !['/x/web-interface/popular', '/x/web-interface/search/type', '/x/web-interface/view', '/x/v2/reply/add'].includes(url.pathname)) {
      throw fail('不支持的 Bilibili 接口。');
    }
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const auth = credentials(secrets);
    const headers = { Accept: 'application/json', 'User-Agent': 'QQ_Service-BilibiliPlugin/1.0', Referer: 'https://www.bilibili.com/' };
    if (auth.cookie) headers.Cookie = auth.cookie;
    if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; headers.Origin = 'https://www.bilibili.com'; }
    let response;
    try {
      response = await fetchImpl(url, { method: form ? 'POST' : 'GET', headers, redirect: 'error',
        signal: AbortSignal.timeout(10_000), ...(form ? { body: new URLSearchParams(form).toString() } : {}) });
    } catch {
      throw fail(form ? 'Bilibili 评论请求结果未知；未自动重试，请先在网站核对，避免重复发布。' : '无法连接 Bilibili；请检查网络或稍后在网站重试。');
    }
    let responseOrigin = API_ORIGIN;
    try { if (response.url) responseOrigin = new URL(response.url).origin; }
    catch { throw fail('Bilibili 响应地址无效，已停止请求。'); }
    if (response.redirected || responseOrigin !== API_ORIGIN) throw fail('Bilibili 返回了重定向，已停止请求。');
    if ([403, 412, 429].includes(response.status)) throw fail('Bilibili 拒绝或限制了请求；请在网站核对，本插件不会绕过验证或自动重试。');
    if (!response.ok) throw fail(form ? 'Bilibili 评论请求未获得成功响应；请先在网站核对结果，插件不会自动重试。' : `Bilibili 请求未成功（HTTP ${response.status}）。`);
    let payload;
    try { payload = await boundedJson(response); }
    catch (error) { throw fail(form ? 'Bilibili 评论返回结果无法确认；请先在网站核对，插件不会自动重试。' : error.bilibiliPublic ? error.message : 'Bilibili 响应读取失败，请稍后在网站核对。'); }
    if (!object(payload) || !Number.isInteger(payload.code)) throw fail(form ? 'Bilibili 评论返回结果无法确认；请先在网站核对。' : 'Bilibili 响应缺少有效的状态码。');
    if (payload.code !== 0) throw fail(apiFailure(payload.code));
    return payload.data;
  }

  const resultLimit = (args, settings) => Math.min(
    boundedInteger(settings?.maxResults, 5, 1, 10, '每次最多条数'),
    boundedInteger(args?.limit, 5, 1, 10, '条数'),
  );

  return {
    async popular(args = {}, settings = {}, secrets = {}) {
      const limit = resultLimit(args, settings);
      const page = boundedInteger(args.page, 1, 1, 5, '页码');
      const data = await request('/x/web-interface/popular', { query: { pn: page, ps: limit }, secrets });
      if (!Array.isArray(data?.list)) throw fail('Bilibili 热门视频列表格式不可用。');
      return { basis: '标题、简介、UP 主等元数据；未观看视频内容。', videos: data.list.slice(0, limit).map(item => summarizeVideo(item)).filter(Boolean), page };
    },
    async search(args = {}, settings = {}, secrets = {}) {
      if (typeof args.keyword !== 'string' || !args.keyword.trim() || Array.from(args.keyword).length > 100) throw fail('搜索词须为 1–100 字符。');
      const limit = resultLimit(args, settings);
      const page = boundedInteger(args.page, 1, 1, 5, '页码');
      const data = await request('/x/web-interface/search/type', { query: { search_type: 'video', keyword: args.keyword.trim(), page, page_size: limit }, secrets });
      if (!Array.isArray(data?.result)) throw fail('Bilibili 搜索列表格式不可用，可能需要在网站登录或验证。');
      return { basis: '视频搜索元数据；未观看视频内容。', videos: data.result.slice(0, limit).map(item => summarizeVideo(item)).filter(Boolean), page };
    },
    async details(args = {}, _settings = {}, secrets = {}) {
      const bvid = requireBvid(args.bvid);
      const data = await request('/x/web-interface/view', { query: { bvid }, secrets });
      const video = summarizeVideo(data, { detail: true, queriedBvid: bvid });
      if (!video || !video.aid) throw fail('Bilibili 视频详情缺少有效身份信息。');
      return { basis: '视频详情和简介；未观看视频内容。', video };
    },
    async commentAndMention(args = {}, settings = {}, secrets = {}) {
      const bvid = requireBvid(args.bvid);
      if (typeof args.comment !== 'string' || !args.comment.trim() || Array.from(args.comment).length > 300 || /[@＠\u0000-\u001f\u007f]/u.test(args.comment)) {
        throw fail('评论须为 1–300 字符，不能携带其他 @ 目标或控制字符。');
      }
      const targetUid = settings.targetUid;
      const targetName = settings.targetName;
      if (typeof targetUid !== 'string' || !UID.test(targetUid)
        || typeof targetName !== 'string' || !targetName.trim() || Array.from(targetName).length > 50 || /[@＠\u0000-\u001f\u007f]/u.test(targetName)) {
        throw fail('请由应用主人先配置 Bilibili 接收提醒的 UID 和对应昵称。');
      }
      const auth = credentials(secrets);
      if (!auth.sessdata || !auth.csrf) throw fail('发表评论需要当前插件的 SESSDATA 和 bili_jct，请先配置并应用同一次登录的凭据。');
      const { video } = await this.details({ bvid }, settings, secrets);
      const name = targetName.trim();
      const data = await request('/x/v2/reply/add', { secrets, form: { type: '1', oid: video.aid, plat: '1',
        message: `@${name} ${args.comment.trim()}`, at_name_to_mid: JSON.stringify({ [name]: targetUid }), csrf: auth.csrf } });
      const rpid = positiveId(data?.rpid_str ?? data?.rpid ?? data?.reply?.rpid_str ?? data?.reply?.rpid);
      if (!rpid) throw fail('Bilibili 未返回可核对的评论编号；发布结果未知，请先在网站检查，不要直接重复提交。');
      return { action: 'comment_submitted', rpid, videoUrl: video.url, targetUid, targetName: name,
        mentionNotificationVerified: false, note: '平台返回了评论编号；@ 提醒是否送达仍需在 Bilibili 核对。' };
    },
  };
}
