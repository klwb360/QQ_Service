const API = 'https://api.bilibili.com';
const MAX_BYTES = 1024 * 1024;
const MAX_TEXT = 24000;
const TIMEOUT_MS = 10000;
const BVID = /^BV[0-9A-Za-z]{10}$/u;
const IDENTIFIER = /^[1-9]\d{0,19}$/u;
const API_PATHS = new Set(['/x/web-interface/nav', '/x/v3/fav/folder/created/list-all', '/x/v3/fav/resource/list',
  '/x/v2/history/toview', '/x/article/favorites/list/all', '/x/web-interface/view', '/x/player/v2', '/x/article/view']);
const SUBTITLE_HOSTS = new Set(['aisubtitle.hdslb.com', 'i0.hdslb.com', 'i1.hdslb.com', 'i2.hdslb.com']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message, code = 'BILIBILI_LIBRARY_INVALID', statusCode = 400) => Object.assign(new Error(message), { code, statusCode, bilibiliPublic: true });
const invalid = message => fail(message, 'BILIBILI_RESPONSE_INVALID', 502);
const numericId = (value, label) => {
  if ((typeof value === 'number' && !Number.isSafeInteger(value)) || !['string', 'number'].includes(typeof value)
    || !IDENTIFIER.test(String(value))) throw fail(`${label}须为有效的数字编号。`);
  return String(value);
};
const responseId = (value, label) => {
  try { return numericId(value, label); } catch { throw invalid(`${label}格式无法识别。`); }
};
const integer = (value, fallback, min, max, label) => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw fail(`${label}须为 ${min}–${max} 的整数。`);
  return value;
};
const iso = value => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 253402300799) return null;
  return new Date(value * 1000).toISOString();
};
const decodeEntities = text => text.replace(/&(?:#x[0-9a-f]{1,8}|#\d{1,10}|amp|quot|apos|lt|gt|nbsp);/giu, entity => {
  const known = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' };
  const lower = entity.toLowerCase();
  if (Object.hasOwn(known, lower)) return known[lower];
  const code = Number.parseInt(lower.slice(lower.startsWith('&#x') ? 3 : 2, -1), lower.startsWith('&#x') ? 16 : 10);
  return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
});
const plainText = text => String(text ?? '').replace(/\r\n?/gu, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');

// A bounded linear tag scan; no DOM execution, resource loading or untrusted
// regular expressions. Image/embedded media never count as read text.
function articleHtml(source) {
  const lower = source.toLowerCase(), chunks = [];
  let cursor = 0, embedded = false, malformed = false;
  while (cursor < source.length) {
    const opening = source.indexOf('<', cursor);
    if (opening < 0) { chunks.push(source.slice(cursor)); break; }
    chunks.push(source.slice(cursor, opening));
    if (source.startsWith('<!--', opening)) {
      const end = source.indexOf('-->', opening + 4);
      if (end < 0) { malformed = true; break; }
      cursor = end + 3; continue;
    }
    if (!/[A-Za-z!/?]/u.test(source[opening + 1] || '')) { chunks.push('<'); cursor = opening + 1; continue; }
    const closing = source.indexOf('>', opening + 1);
    if (closing < 0) { malformed = true; break; }
    const tag = /^<\s*(\/?)([a-z][a-z0-9-]*)\b/iu.exec(source.slice(opening, closing + 1));
    cursor = closing + 1;
    if (!tag) continue;
    const name = tag[2].toLowerCase();
    if (!tag[1] && ['script', 'style', 'noscript', 'head', 'iframe'].includes(name)) {
      if (name === 'iframe') embedded = true;
      const stop = lower.indexOf(`</${name}`, cursor);
      if (stop < 0) { malformed = true; break; }
      const end = source.indexOf('>', stop);
      if (end < 0) { malformed = true; break; }
      cursor = end + 1; continue;
    }
    if (['img', 'video', 'audio', 'canvas', 'svg', 'object', 'embed'].includes(name)) embedded = true;
    if (['p', 'div', 'li', 'br', 'hr', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote'].includes(name)) chunks.push('\n');
  }
  return { text: plainText(decodeEntities(chunks.join(''))).replace(/[ \t]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim(), embedded, malformed };
}

/** Read-only library client. Each operation captures one credential and uses a
 * single absolute deadline, including DNS/fetch, response bodies and parsing.
 * Nothing in this module updates watch history, favorites or remote content. */
export function createBilibiliLibraryClient({ fetchImpl = globalThis.fetch, getSession = () => '', now = () => Date.now() } = {}) {
  if (typeof fetchImpl !== 'function' || typeof getSession !== 'function' || typeof now !== 'function') throw new TypeError('Bilibili library client callbacks must be functions.');

  async function operation(options, required, action) {
    const controller = new AbortController(), inputSignal = options?.signal;
    let timedOut = false, session = '';
    const abort = () => controller.abort();
    inputSignal?.addEventListener('abort', abort, { once: true });
    if (inputSignal?.aborted) controller.abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
    const check = () => {
      if (controller.signal.aborted) throw fail(timedOut ? 'Bilibili 读取超过10秒，已停止；没有自动重试。' : 'Bilibili 读取已取消。', timedOut ? 'BILIBILI_TIMEOUT' : 'BILIBILI_ABORTED', timedOut ? 408 : 409);
    };
    const redact = value => {
      let text = String(value ?? '');
      if (session) for (const secret of [...new Set([session, encodeURIComponent(session)])].sort((a, b) => b.length - a.length)) text = text.split(secret).join('[已隐藏]');
      return text;
    };
    const awaiting = promise => {
      check();
      return new Promise((resolve, reject) => {
        const cancelled = () => { try { check(); } catch (error) { reject(error); } };
        controller.signal.addEventListener('abort', cancelled, { once: true });
        Promise.resolve(promise).then(value => { check(); resolve(value); }, reject)
          .catch(reject).finally(() => controller.signal.removeEventListener('abort', cancelled));
      });
    };
    const clean = (value, max = 3000) => redact(articleHtml(redact(typeof value === 'string' || typeof value === 'number' ? String(value) : '')).text).slice(0, max);
    const ctx = { signal: controller.signal, check, awaiting, redact, clean, session: '' };
    try {
      check();
      try { session = await awaiting(getSession()); }
      catch (error) {
        // The trusted authorization callback may be temporarily unavailable
        // while its QQ account is reconnecting. Preserve only that signal;
        // callback messages, codes and other fields may contain credentials.
        if (error?.retryable === true) throw Object.assign(fail('当前账号暂时无法确认授权，请恢复连接后再试。', 'BILIBILI_AUTHORIZATION_UNAVAILABLE', 503), { retryable: true });
        throw error;
      }
      if (typeof session !== 'string' || session.length > 2000 || /^SESSDATA=/iu.test(session) || /[\s;\u0000-\u001f\u007f]/u.test(session)) {
        session = ''; throw fail('Bilibili 登录字段格式无效，请填写单个 SESSDATA 值。', 'BILIBILI_CREDENTIAL_INVALID');
      }
      if (required && !session) throw fail('请先为当前账号配置 Bilibili SESSDATA 并确认登录身份。', 'BILIBILI_LOGIN_REQUIRED', 401);
      ctx.session = session;
      const value = await awaiting(action(ctx)); check(); return value;
    } catch (error) {
      if (controller.signal.aborted) check();
      if (error?.bilibiliPublic) {
        error.message = redact(error.message).slice(0, 600); throw error;
      }
      throw fail('Bilibili 读取未完成，请检查网络或在网站核对登录状态；没有自动重试。', 'BILIBILI_REQUEST_FAILED', 502);
    } finally { clearTimeout(timer); inputSignal?.removeEventListener('abort', abort); }
  }

  async function jsonResponse(response, ctx) {
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      await response.body?.cancel?.(); throw fail('Bilibili 响应超过1 MiB，已停止读取。', 'BILIBILI_RESPONSE_TOO_LARGE', 502);
    }
    if (!response.body?.getReader) throw invalid('Bilibili 没有返回可读取的 JSON 正文。');
    const reader = response.body.getReader(), parts = [];
    let bytes = 0, done = false;
    try {
      while (true) {
        const next = await ctx.awaiting(reader.read()); ctx.check();
        if (next.done) { done = true; break; }
        bytes += next.value.byteLength;
        if (bytes > MAX_BYTES) throw fail('Bilibili 响应超过1 MiB，已停止读取。', 'BILIBILI_RESPONSE_TOO_LARGE', 502);
        parts.push(Buffer.from(next.value));
      }
    } finally {
      if (!done) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    ctx.check();
    try { return JSON.parse(Buffer.concat(parts, bytes).toString('utf8')); }
    catch { throw invalid('Bilibili 返回的正文不是有效 JSON。'); }
  }

  async function request(ctx, pathname, params = {}, { subtitleUrl } = {}) {
    ctx.check();
    const url = subtitleUrl ? new URL(subtitleUrl) : new URL(pathname, API);
    if (!subtitleUrl && (url.origin !== API || !API_PATHS.has(url.pathname))) throw fail('不支持的 Bilibili 读取接口。');
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
    const headers = { Accept: 'application/json', 'User-Agent': 'QQ_Service-BilibiliLibrary/1.0', Referer: 'https://www.bilibili.com/' };
    if (!subtitleUrl && ctx.session) headers.Cookie = `SESSDATA=${ctx.session}`;
    let response;
    try { response = await ctx.awaiting(fetchImpl(url, { method: 'GET', headers, redirect: 'error', signal: ctx.signal })); }
    catch (error) { if (error?.bilibiliPublic) throw error; ctx.check(); throw fail('无法连接 Bilibili 读取接口；没有自动重试。', 'BILIBILI_REQUEST_FAILED', 502); }
    ctx.check();
    if (response.redirected || response.status >= 300 && response.status < 400) { await response.body?.cancel?.(); throw fail('Bilibili 读取接口返回重定向，已停止。', 'BILIBILI_REDIRECT_REJECTED', 502); }
    if (response.url) {
      let actual;
      try { actual = new URL(response.url); } catch { throw invalid('Bilibili 响应来源无法核对。'); }
      if (actual.origin !== url.origin || actual.pathname !== url.pathname || actual.username || actual.password) throw invalid('Bilibili 响应来源与请求不一致。');
    }
    if (response.status === 401) throw fail('Bilibili 登录已失效，请在网站重新确认。', 'BILIBILI_LOGIN_REQUIRED', 401);
    if ([403, 412, 429].includes(response.status)) throw fail('Bilibili 要求验证、限制频率或拒绝访问，已停止且未重试。', 'BILIBILI_RESTRICTED', response.status);
    if (!response.ok) throw fail(`Bilibili 读取失败（HTTP ${response.status}）。`, 'BILIBILI_HTTP_ERROR', 502);
    const payload = await jsonResponse(response, ctx);
    if (subtitleUrl) return payload;
    if (!object(payload) || !Number.isSafeInteger(payload.code)) throw invalid('Bilibili 返回了无法识别的状态格式。');
    if ([-101, -102, -111].includes(payload.code)) throw fail('Bilibili 登录已失效，请在网站重新确认。', 'BILIBILI_LOGIN_REQUIRED', 401);
    if ([-352, -403, -412, -509, 12015].includes(payload.code)) throw fail('Bilibili 要求验证、限制频率或拒绝访问，已停止且未重试。', 'BILIBILI_RESTRICTED', 403);
    if (payload.code === -404) throw fail('Bilibili 内容不存在或当前账号无权读取。', 'BILIBILI_NOT_FOUND', 404);
    if (payload.code !== 0) throw fail('Bilibili 未接受本次读取，请在网站核对；没有自动重试。', 'BILIBILI_API_ERROR', 502);
    return payload.data;
  }

  async function currentUser(ctx) {
    const data = await request(ctx, '/x/web-interface/nav');
    if (!object(data) || data.isLogin !== true) throw fail('Bilibili 尚未确认登录，请核对本账号 SESSDATA。', 'BILIBILI_LOGIN_REQUIRED', 401);
    let uid;
    try { uid = numericId(data.mid, '当前登录 UID'); } catch { throw invalid('Bilibili 登录身份编号无效。'); }
    return { uid, username: ctx.clean(data.uname, 80) };
  }
  async function ownFolders(ctx) {
    const user = await currentUser(ctx);
    const data = await request(ctx, '/x/v3/fav/folder/created/list-all', { up_mid: user.uid, type: 2, web_location: '333.1387' });
    if (!object(data) || !Number.isSafeInteger(data.count) || data.count < 0
      || !(Array.isArray(data.list) || data.count === 0 && data.list === null)) throw invalid('Bilibili 收藏夹列表格式无法识别。');
    const seen = new Set();
    const folders = (data.list || []).map(row => {
      if (!object(row) || typeof row.title !== 'string') throw invalid('Bilibili 收藏夹信息不完整。');
      const id = responseId(row.id, '收藏夹 ID');
      if (seen.has(id) || row.mid !== undefined && responseId(row.mid, '收藏夹所有者') !== user.uid) throw invalid('Bilibili 收藏夹不属于当前登录用户或编号重复。');
      seen.add(id);
      return { id, title: ctx.clean(row.title, 100), count: Number.isSafeInteger(row.media_count) && row.media_count >= 0 ? row.media_count : null };
    });
    if (folders.length > 1000) throw invalid('Bilibili 收藏夹数量超出本次读取预算。');
    return { uid: user.uid, folders };
  }

  function videoItem(row, ctx, source = 'detail') {
    if (!object(row)) throw invalid('Bilibili 视频条目格式无法识别。');
    const bvid = row.bvid || row.bv_id;
    if (source === 'favorite' && row.type !== 2 || row.attr !== undefined && row.attr !== 0
      || row.state !== undefined && Number(row.state) < 0) return null;
    if (typeof bvid !== 'string' || !BVID.test(bvid) || typeof row.title !== 'string') throw invalid('Bilibili 视频条目缺少有效 BV 编号或标题。');
    return { id: `video:${bvid}`, kind: 'video', bvid, title: ctx.clean(row.title, 160), url: `https://www.bilibili.com/video/${bvid}`,
      uploader: ctx.clean(row.upper?.name ?? row.owner?.name, 80), publishedAt: iso(source === 'favorite' ? row.pubtime : row.pubdate),
      addedAt: source === 'favorite' ? iso(row.fav_time) : source === 'watch_later' ? iso(row.add_at) : null,
      description: ctx.clean(row.intro ?? row.desc, 3000) };
  }
  function articleItem(row, ctx) {
    if (!object(row)) throw invalid('Bilibili 专栏条目格式无法识别。');
    if (row.valid === false) return null;
    const articleId = responseId(row.id, '专栏 ID');
    if (typeof row.title !== 'string') throw invalid('Bilibili 专栏条目缺少标题。');
    const author = Array.isArray(row.author) ? row.author[0] : row.author;
    return { id: `article:${articleId}`, kind: 'article', articleId, title: ctx.clean(row.title, 160),
      url: `https://www.bilibili.com/read/cv${articleId}`, uploader: ctx.clean(author?.name, 80),
      publishedAt: iso(row.publish_time), addedAt: iso(row.fav_time), description: ctx.clean(row.summary, 3000) };
  }
  const metadataText = item => [item.title ? `标题：${item.title}` : '', item.description ? `简介：${item.description}` : ''].filter(Boolean).join('\n');
  const metadata = (item, reason) => ({ item, content: { kind: 'metadata_only', text: metadataText(item), complete: false,
    coverage: '仅读取标题和可用简介，未读取视频字幕、画面或音频。', reason }, sourceUrls: [item.url] });

  function validatedSubtitle(raw) {
    let url;
    try { url = new URL(raw?.startsWith('//') ? `https:${raw}` : raw); } catch { throw fail('字幕来源不是有效的官方 HTTPS 地址。', 'BILIBILI_SUBTITLE_URL_REJECTED'); }
    if (url.protocol !== 'https:' || !SUBTITLE_HOSTS.has(url.hostname) || !['', '443'].includes(url.port) || url.username || url.password || url.hash
      || !/^\/bfs\/subtitle\/[A-Za-z0-9][A-Za-z0-9._/-]*\.json$/u.test(url.pathname)) {
      throw fail('字幕来源不在允许的官方 HTTPS 地址范围内。', 'BILIBILI_SUBTITLE_URL_REJECTED');
    }
    return url.href;
  }

  return {
    nav: (options = {}) => operation(options, true, currentUser),
    listFavoriteFolders: (options = {}) => operation(options, true, ownFolders),
    listFavoriteItems: (options = {}) => operation(options, true, async ctx => {
      const folderId = numericId(options.folderId, '收藏夹 ID');
      const page = integer(options.page, 1, 1, 1000, '页码'), pageSize = integer(options.pageSize, 20, 1, 20, '每页条数');
      const own = await ownFolders(ctx);
      if (!own.folders.some(folder => folder.id === folderId)) throw fail('只能读取当前登录用户创建并选定的收藏夹。', 'BILIBILI_FOLDER_NOT_OWNED', 403);
      const data = await request(ctx, '/x/v3/fav/resource/list', { media_id: folderId, pn: page, ps: pageSize,
        order: 'mtime', type: 0, tid: 0, platform: 'web', web_location: '333.1387' });
      if (!object(data) || !object(data.info) || typeof data.has_more !== 'boolean'
        || !(Array.isArray(data.medias) || data.info.media_count === 0 && data.medias === null && !data.has_more)) throw invalid('Bilibili 收藏夹内容格式无法识别。');
      if (responseId(data.info.id, '响应收藏夹 ID') !== folderId || data.info.mid !== undefined && responseId(data.info.mid, '响应收藏夹所有者') !== own.uid) throw invalid('Bilibili 收藏夹内容来源与已确认的账号范围不一致。');
      if ((data.medias || []).length > pageSize) throw invalid('Bilibili 收藏夹内容超过请求页大小。');
      const items = (data.medias || []).map(row => videoItem(row, ctx, 'favorite')).filter(Boolean);
      return { items, hasMore: data.has_more, skipped: (data.medias || []).length - items.length };
    }),
    listWatchLater: (options = {}) => operation(options, true, async ctx => {
      await currentUser(ctx);
      const data = await request(ctx, '/x/v2/history/toview');
      if (!object(data) || !Number.isSafeInteger(data.count) || data.count < 0 || !Array.isArray(data.list)) throw invalid('Bilibili 稍后再看列表格式无法识别。');
      if (data.list.length > 1000 || data.count > data.list.length) throw invalid('Bilibili 稍后再看返回了不完整或超出预算的列表。');
      const items = data.list.map(row => videoItem(row, ctx, 'watch_later')).filter(Boolean);
      return { items, hasMore: false, skipped: data.list.length - items.length };
    }),
    listFavoriteArticles: (options = {}) => operation(options, true, async ctx => {
      const page = integer(options.page, 1, 1, 1000, '页码');
      const pageSize = Math.min(integer(options.pageSize, 16, 1, 20, '每页条数'), 16);
      await currentUser(ctx);
      const data = await request(ctx, '/x/article/favorites/list/all', { pn: page, ps: pageSize });
      if (!object(data) || !Array.isArray(data.favorites) || !object(data.page) || !Number.isSafeInteger(data.page.total) || data.page.total < 0
        || data.favorites.length > pageSize) throw invalid('Bilibili 专栏收藏列表格式无法识别。');
      const items = data.favorites.map(row => articleItem(row, ctx)).filter(Boolean);
      return { items, hasMore: page * pageSize < data.page.total, pageSize, skipped: data.favorites.length - items.length };
    }),
    readVideo: (options = {}) => operation(options, false, async ctx => {
      if (typeof options.bvid !== 'string' || !BVID.test(options.bvid)) throw fail('请填写有效的 BV 视频编号，不接受任意网址。');
      const data = await request(ctx, '/x/web-interface/view', { bvid: options.bvid });
      if (!object(data) || data.bvid !== options.bvid) throw invalid('Bilibili 视频详情与请求编号不一致。');
      const item = videoItem(data, ctx);
      if (!item) throw fail('此视频已失效或当前无法读取。', 'BILIBILI_NOT_FOUND', 404);
      const pages = Array.isArray(data.pages) && data.pages.length ? data.pages : [{ cid: data.cid, page: 1, part: data.title, duration: data.duration }];
      const first = pages[0];
      if (!object(first)) throw invalid('Bilibili 视频分P信息无法识别。');
      const cid = responseId(first.cid, '视频分P CID');
      const player = await request(ctx, '/x/player/v2', { bvid: options.bvid, cid });
      if (!object(player) || player.bvid !== undefined && player.bvid !== options.bvid
        || player.cid !== undefined && String(player.cid) !== cid) throw invalid('Bilibili 字幕索引与视频分P身份不一致。');
      const subtitle = player.subtitle;
      if (subtitle === undefined || subtitle === null) return metadata(item, player.need_login_subtitle ? '字幕需要登录或当前账号无权读取。' : '此视频没有提供可用字幕。');
      if (!object(subtitle) || !Array.isArray(subtitle.subtitles)) throw invalid('Bilibili 字幕索引格式无法识别。');
      if (!subtitle.subtitles.length) return metadata(item, player.need_login_subtitle ? '字幕需要登录或当前账号无权读取。' : '此视频没有提供可用字幕。');
      if (subtitle.subtitles.length > 100) throw invalid('Bilibili 字幕轨道数量超出读取预算。');
      const track = subtitle.subtitles.find(row => object(row) && /^(?:zh|ai-zh)(?:-|$)/iu.test(row.lan || '')) || subtitle.subtitles[0];
      if (!object(track) || typeof track.subtitle_url !== 'string') throw invalid('Bilibili 字幕轨道缺少可用来源。');
      const raw = await request(ctx, '', {}, { subtitleUrl: validatedSubtitle(track.subtitle_url) });
      if (!object(raw) || !Array.isArray(raw.body) || raw.body.length > 10000) throw invalid('Bilibili 字幕正文格式无法识别。');
      const segments = []; let remaining = MAX_TEXT, truncated = false;
      for (const row of raw.body) {
        if (!object(row) || typeof row.content !== 'string' || typeof row.from !== 'number' || typeof row.to !== 'number'
          || !Number.isFinite(row.from) || !Number.isFinite(row.to) || row.from < 0 || row.to < row.from) throw invalid('Bilibili 字幕段落格式无法识别。');
        const text = plainText(ctx.redact(row.content)).trim();
        if (!text) continue;
        const separator = Number(segments.length > 0);
        if (remaining <= separator) { truncated = true; break; }
        const cropped = text.slice(0, remaining - separator);
        segments.push({ from: row.from, to: row.to, text: cropped }); remaining -= cropped.length + separator;
        if (cropped.length < text.length) { truncated = true; break; }
      }
      if (!segments.length) return metadata(item, '字幕文件没有提供可用文字。');
      const multipart = pages.length > 1 || Number(data.videos) > 1;
      const language = ctx.clean(track.lan_doc || track.lan, 50) || '未标注语言';
      const parts = multipart ? `多P视频仅读取第1P（共${pages.length > 1 ? pages.length : data.videos}P）` : '读取第1P';
      return { item, content: { kind: 'subtitles', text: segments.map(row => row.text).join('\n'), complete: !multipart && !truncated,
        coverage: `${parts}的${language}可用字幕${truncated ? '，文字达到24000字符预算，已截断' : '文字'}；未观看视频画面或音频${track.ai_type ? '；来源包含自动生成字幕' : ''}。`, segments,
        ...(truncated ? { reason: '字幕文字超过本次读取预算。' } : {}) }, sourceUrls: [item.url] };
    }),
    readArticle: (options = {}) => operation(options, false, async ctx => {
      const articleId = numericId(options.articleId, '专栏 ID');
      const data = await request(ctx, '/x/article/view', { id: articleId });
      if (!object(data) || responseId(data.id, '响应专栏 ID') !== articleId || typeof data.content !== 'string') throw invalid('Bilibili 专栏正文与请求身份不一致或格式不可用。');
      const item = articleItem(data, ctx);
      if (!item) throw fail('此专栏已失效或当前无法读取。', 'BILIBILI_NOT_FOUND', 404);
      let extracted;
      if (data.type === 0) extracted = articleHtml(ctx.redact(data.content));
      else if (data.type === 3) {
        let payload;
        try { payload = JSON.parse(data.content); } catch { throw invalid('Bilibili 专栏富文本不是有效 JSON。'); }
        if (!object(payload) || !Array.isArray(payload.ops) || payload.ops.length > 20000) throw invalid('Bilibili 专栏富文本结构无法识别。');
        const chunks = []; let embedded = false;
        for (const row of payload.ops) {
          if (!object(row) || !(typeof row.insert === 'string' || object(row.insert))) throw invalid('Bilibili 专栏富文本段落无法识别。');
          if (typeof row.insert === 'string') chunks.push(row.insert); else embedded = true;
        }
        extracted = { text: plainText(ctx.redact(chunks.join(''))).trim(), embedded, malformed: false };
      } else throw invalid('Bilibili 返回了当前不支持的专栏正文类型。');
      ctx.check();
      extracted.text = ctx.redact(extracted.text);
      if (!extracted.text) return { item, content: { kind: 'metadata_only', text: metadataText(item), complete: false,
        coverage: '仅取得专栏标题和可用开头摘要，未取得可总结的正文文字。', reason: '专栏正文没有可提取文字，图片与嵌入内容未读取。' }, sourceUrls: [item.url] };
      const truncated = extracted.text.length > MAX_TEXT;
      return { item, content: { kind: 'article_text', text: extracted.text.slice(0, MAX_TEXT),
        complete: !truncated && !extracted.embedded && !extracted.malformed,
        coverage: `已提取接口提供的专栏正文文字${truncated ? '，达到24000字符预算并截断' : ''}${extracted.embedded ? '；图片、视频及其他嵌入内容未读取' : ''}${extracted.malformed ? '；部分HTML结构不完整' : ''}。`,
        ...(truncated ? { reason: '专栏正文超过本次读取预算。' } : {}) }, sourceUrls: [item.url] };
    }),
  };
}
