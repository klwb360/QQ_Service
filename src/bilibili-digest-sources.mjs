import { normalizeBilibiliDigestRequest } from './bilibili-digest-tools.mjs';

const MAX_CANDIDATES = 100;
const MAX_LIST_PAGES = 5;
const PAGE_SIZE = 20;
const DAY_MS = 86_400_000;
const BVID = /^BV[0-9A-Za-z]{10}$/u;
const NUMERIC_ID = /^[1-9]\d{0,19}$/u;
const fail = (message, code = 'BILIBILI_DIGEST_SOURCE_INVALID', statusCode = 502) => Object.assign(new Error(message), { code, statusCode });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function timestamp(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  if (!match) return null;
  const [, y, m, d, h, min, sec, fraction = '', zone, sign, oh = '0', om = '0'] = match;
  const numbers = [y, m, d, h, min, sec, oh, om].map(Number);
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = numbers;
  if (year < 1970 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59
    || offsetHour > 14 || offsetMinute > 59 || offsetHour === 14 && offsetMinute !== 0) return null;
  const local = new Date(Date.UTC(year, month - 1, day, hour, minute, second, Number(fraction.padEnd(3, '0'))));
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day) return null;
  return local.getTime() - (zone === 'Z' ? 0 : (sign === '+' ? 1 : -1) * (offsetHour * 60 + offsetMinute) * 60_000);
}

function itemIdentity(item) {
  if (!object(item)) return null;
  if (item.kind === 'video' && typeof item.bvid === 'string' && BVID.test(item.bvid) && item.id === `video:${item.bvid}`) return item.id;
  if (item.kind === 'article' && typeof item.articleId === 'string' && NUMERIC_ID.test(item.articleId) && item.id === `article:${item.articleId}`) return item.id;
  return null;
}

function missingContent(error) {
  const status = Number(error?.statusCode || error?.status);
  if (error?.name === 'AbortError' || /LOGIN|CREDENTIAL|RESTRICT|ABORT|AUTH|PERMISSION|FOLDER_NOT_OWNED/u.test(String(error?.code || ''))
    || [401, 403, 412, 429].includes(status)) return false;
  return ['BILIBILI_NOT_FOUND', 'BILIBILI_CONTENT_UNAVAILABLE', 'BILIBILI_VIDEO_NOT_FOUND', 'BILIBILI_ARTICLE_NOT_FOUND'].includes(error?.code)
    || [404, 410].includes(status) || Number(error?.apiCode) === -404;
}

function effectiveFilter(job, request, now) {
  if (job.effectiveTimeFilter !== undefined) {
    const supplied = job.effectiveTimeFilter;
    if (!object(supplied) || supplied.basis !== request.timeFilter.basis
      || Object.keys(supplied).some(key => !['basis', 'from', 'until'].includes(key))) throw fail('后台任务的有效时间范围无效。');
    return normalizeBilibiliDigestRequest({ ...request, timeFilter: supplied }).timeFilter;
  }
  if (!request.timeFilter.lookbackDays) return request.timeFilter;
  const time = now();
  if (!Number.isFinite(time)) throw fail('后台任务时钟无效。');
  return { basis: request.timeFilter.basis,
    from: new Date(time - request.timeFilter.lookbackDays * DAY_MS).toISOString(), until: new Date(time).toISOString() };
}

/** Read only the owner's selected library. Identity, credentials, URLs and
 * content provenance stay inside the reader; the model supplies no transport
 * or callback. Source pages and candidate counts share one bounded budget. */
export async function readBilibiliDigestSources(job, { client, signal, authorize, processedItemIds = [], now = Date.now } = {}) {
  const request = normalizeBilibiliDigestRequest(job?.request);
  if (!object(client) || typeof authorize !== 'function' || typeof now !== 'function' || !Array.isArray(processedItemIds)) throw fail('后台任务缺少受授权的内容读取器。');
  const filter = effectiveFilter(job, request, now), from = filter.from ? timestamp(filter.from) : null, until = filter.until ? timestamp(filter.until) : null;
  const dateKey = filter.basis === 'added' ? 'addedAt' : 'publishedAt';
  const filteredByDate = item => {
    const value = timestamp(item[dateKey]);
    if ((from !== null || until !== null) && value === null) return filter.basis === 'added' ? 'MISSING_ADDED_DATE' : 'MISSING_PUBLISHED_DATE';
    return from !== null && value < from || until !== null && value >= until ? 'OUTSIDE_TIME_RANGE' : null;
  };
  const check = async () => {
    if (signal?.aborted) throw fail('Bilibili 后台内容读取已取消。', 'BILIBILI_ABORTED', 409);
    await authorize();
    if (signal?.aborted) throw fail('Bilibili 后台内容读取已取消。', 'BILIBILI_ABORTED', 409);
  };
  await check();
  const selected = [
    ...request.sources.favoriteFolderIds.map(folderId => ({ id: `favorite:${folderId}`, kind: 'video', method: 'listFavoriteItems', folderId, page: 1, paged: true })),
    ...(request.sources.favoriteArticles ? [{ id: 'favorite_articles', kind: 'article', method: 'listFavoriteArticles', page: 1, paged: true }] : []),
    ...(request.sources.watchLater ? [{ id: 'watch_later', kind: 'video', method: 'listWatchLater', page: 1, paged: false }] : []),
  ];
  const skipped = [], skipKeys = new Set();
  const skip = (id, code, reason, source) => {
    const key = `${id}\0${code}\0${source || ''}`;
    if (skipKeys.has(key)) return;
    skipKeys.add(key); skipped.push({ id, code, reason, ...(source ? { source } : {}) });
  };
  const sources = selected.filter(source => {
    if (request.contentKinds.includes(source.kind)) return true;
    skip(`source:${source.id}`, 'KIND_NOT_SELECTED', '此来源的内容类型未在本次任务中选择。', source.id);
    return false;
  });
  for (const source of sources) if (typeof client[source.method] !== 'function') throw fail('Bilibili 来源读取器接口不完整。');
  const queue = sources.slice(), visited = new Set(), seen = new Set(), candidates = new Map(), processed = new Set(processedItemIds);
  const scan = { scanned: 0, filtered: 0, duplicates: 0, alreadyProcessed: 0, upstreamSkipped: 0, pages: 0,
    sourceCount: sources.length, sourcesScanned: 0, eligible: 0, contentReads: 0, selected: 0,
    truncated: false, omittedSources: [], timeFilter: { basis: filter.basis, from: filter.from || '', until: filter.until || '' } };
  while (queue.length && scan.pages < MAX_LIST_PAGES && scan.scanned < MAX_CANDIDATES) {
    const source = queue.shift(), remaining = MAX_CANDIDATES - scan.scanned;
    await check();
    const page = await client[source.method]({ ...(source.folderId ? { folderId: source.folderId } : {}),
      // Keep page size stable: changing ps on a later page changes its offset
      // in Bilibili's API and can duplicate or skip candidates.
      ...(source.paged ? { page: source.page, pageSize: PAGE_SIZE } : {}), signal });
    await check();
    scan.pages++; visited.add(source.id);
    if (!object(page) || !Array.isArray(page.items) || typeof page.hasMore !== 'boolean') throw fail('Bilibili 来源列表格式无效。');
    if (Number.isSafeInteger(page.skipped) && page.skipped > 0) scan.upstreamSkipped += page.skipped;
    if (page.truncated === true || page.items.length > remaining) scan.truncated = true;
    for (const [index, item] of page.items.slice(0, remaining).entries()) {
      scan.scanned++;
      const id = itemIdentity(item);
      if (!id) {
        scan.filtered++; skip(`invalid:${source.id}:${source.page}:${index}`, 'INVALID_ITEM', '来源条目缺少有效内容身份，未读取正文。', source.id); continue;
      }
      if (seen.has(id)) scan.duplicates++;
      seen.add(id);
      if (processed.has(id)) {
        scan.alreadyProcessed++; skip(id, 'ALREADY_PROCESSED', '此内容已经在本任务中完成总结。', source.id); continue;
      }
      if (item.kind !== source.kind || !request.contentKinds.includes(item.kind)) {
        scan.filtered++; skip(id, 'KIND_NOT_SELECTED', '此内容类型不属于本次选择的来源与类别。', source.id); continue;
      }
      const excluded = filteredByDate(item);
      if (excluded) {
        scan.filtered++; skip(id, excluded, excluded === 'OUTSIDE_TIME_RANGE' ? '内容不在所选时间范围内。'
          : filter.basis === 'added' ? '来源未提供加入时间，无法按加入时间筛选。' : '来源未提供发布时间，无法按发布时间筛选。', source.id);
        continue;
      }
      const copy = structuredClone(item), rank = timestamp(copy[dateKey]) ?? Number.NEGATIVE_INFINITY;
      const previous = candidates.get(id), sourceIds = new Set([...(previous?.sourceIds || []), source.id]);
      if (!previous || rank > previous.rank) candidates.set(id, { item: copy, rank, sourceIds });
      else previous.sourceIds = sourceIds;
    }
    if (page.hasMore) {
      if (source.paged) queue.push({ ...source, page: source.page + 1 });
      else scan.truncated = true;
    }
  }
  if (queue.length) scan.truncated = true;
  scan.sourcesScanned = visited.size;
  scan.omittedSources = sources.filter(source => !visited.has(source.id)).map(source => source.id);
  const ranked = [...candidates.values()].sort((a, b) => b.rank - a.rank || a.item.id.localeCompare(b.item.id));
  scan.eligible = ranked.length;
  if (ranked.length > request.maxItems) scan.truncated = true;
  for (const candidate of ranked.slice(request.maxItems)) skip(candidate.item.id, 'ITEM_BUDGET', '已达到本次最多处理条数，正文留待后续任务。');
  const items = [];
  for (const candidate of ranked.slice(0, request.maxItems)) {
    const item = candidate.item, method = item.kind === 'video' ? 'readVideo' : 'readArticle';
    if (typeof client[method] !== 'function') throw fail('Bilibili 正文读取器接口不完整。');
    await check();
    scan.contentReads++;
    let content;
    try { content = await client[method]({ ...(item.kind === 'video' ? { bvid: item.bvid } : { articleId: item.articleId }), signal }); }
    catch (error) {
      await check();
      if (!missingContent(error)) throw error;
      skip(item.id, 'CONTENT_UNAVAILABLE', '此内容已失效、被删除或当前无法读取。'); continue;
    }
    await check();
    if (!object(content) || itemIdentity(content.item) !== item.id || content.item.kind !== item.kind
      || !object(content.content) || typeof content.content.text !== 'string' || typeof content.content.complete !== 'boolean'
      || typeof content.content.kind !== 'string' || typeof content.content.coverage !== 'string'
      || !Array.isArray(content.sourceUrls) || !content.sourceUrls.length || content.sourceUrls.some(url => typeof url !== 'string')) throw fail('正文与选中内容的身份或来源资料不一致。', 'BILIBILI_DIGEST_SOURCE_MISMATCH');
    const mergedItem = { ...content.item, publishedAt: content.item.publishedAt ?? item.publishedAt ?? null, addedAt: item.addedAt ?? null };
    const excluded = filteredByDate(mergedItem);
    if (excluded) {
      scan.filtered++; skip(item.id, excluded, '正文核对后的内容时间不在本次所选范围内。'); continue;
    }
    items.push({ ...structuredClone(content), item: structuredClone(mergedItem),
      selection: { timeBasis: filter.basis, sourceIds: [...candidate.sourceIds] } });
  }
  await check();
  scan.selected = items.length;
  return { items, skipped, scan };
}
