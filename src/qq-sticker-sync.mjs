import { createHash } from 'node:crypto';
import { createControlledImageFetcher, parsePublicWebUrl } from './web-content.mjs';

export const QQ_STICKER_SYNC_LIMITS = Object.freeze({ count: 10, imageBytes: 8 * 1024 * 1024,
  totalBytes: 40 * 1024 * 1024, deadlineMs: 120_000 });
// Exact, sourced QQ image hosts only. Neither *.qq.com nor *.qq.com.cn is a
// permission boundary. See the source references exported below.
export const QQ_STICKER_IMAGE_HOSTS = Object.freeze(['p.qpic.cn', 'gchat.qpic.cn', 'multimedia.nt.qq.com.cn']);
export const QQ_STICKER_INTERFACE_SOURCES = Object.freeze([
  'https://github.com/NapNeko/NapCatQQ/blob/72912f293924f43463b5976b01fc094a8ae11481/packages/napcat-onebot/action/extends/FetchCustomFace.ts',
  'https://github.com/NapNeko/NapCatQQ/blob/72912f293924f43463b5976b01fc094a8ae11481/packages/napcat-core/types/constant.ts',
  'https://github.com/Mrs4s/MiraiGo/blob/54bdd873e3fed9fe1c944918924674dacec5ac76/client/face.go',
]);
const QQ = /^[1-9]\d{3,19}$/u;
const fail = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const own = (value, name) => value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, name)?.value : undefined;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export function isQqStickerImageUrl(value) {
  try { const url = value instanceof URL ? parsePublicWebUrl(value.href) : parsePublicWebUrl(value); return QQ_STICKER_IMAGE_HOSTS.includes(url.hostname); }
  catch { return false; }
}
const defaultFetchImage = createControlledImageFetcher({ allowUrl: isQqStickerImageUrl });
function entryUrl(entry) {
  if (typeof entry === 'string') return entry;
  if (plain(entry) && Object.getOwnPropertySymbols(entry).length === 0
    && Object.keys(entry).every(key => ['url'].includes(key))) return own(entry, 'url');
  return undefined;
}
function entriesOf(value) {
  const entries = Array.isArray(value) ? value : plain(value) ? own(value, 'entries') : undefined;
  if (!Array.isArray(entries) || entries.length > 10_000) throw fail('QQ_STICKER_LIST_UNKNOWN', 'QQ收藏表情列表格式无法确认，已停止同步。');
  return entries;
}
function imageType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mimeType: 'image/png', extension: 'png' };
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { mimeType: 'image/jpeg', extension: 'jpg' };
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return { mimeType: 'image/gif', extension: 'gif' };
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return { mimeType: 'image/webp', extension: 'webp' };
  throw fail('QQ_STICKER_IMAGE_REJECTED', '下载内容不是受支持的图片，未导入。');
}
const REASONS = Object.freeze({
  QQ_STICKER_SOURCE_REJECTED: '此收藏项不在受支持的QQ图片来源范围，未读取。',
  QQ_STICKER_IMAGE_REJECTED: '图片格式或大小不符合受管素材要求，未导入。',
  QQ_STICKER_MIME_MISMATCH: '图片声明类型与实际字节不一致，未导入。',
  WEB_URL_REJECTED: '图片跳转离开受支持的QQ图片来源，未导入。',
  WEB_ADDRESS_REJECTED: '图片地址解析到本机、私网或保留网络，未读取。',
  WEB_PIN_FAILED: '图片连接地址与检查结果不一致，未导入。',
  WEB_REDIRECT_REJECTED: '图片跳转不符合安全规则，未导入。',
  WEB_RESPONSE_TOO_LARGE: '图片超过本次剩余字节预算，未导入。',
  WEB_CONTENT_TYPE: 'QQ图片来源没有返回受支持的图片类型，未导入。',
  WEB_CONTENT_ENCODING: '图片内容编码不受支持，未导入。',
  WEB_HTTP_REJECTED: 'QQ图片来源没有允许读取，未导入。',
  WEB_RATE_LIMITED: 'QQ图片来源暂时限制请求频率，未导入。',
  QQ_ASSET_INPUT_INVALID: '图片未通过受管素材的格式、像素或帧数检查，未导入。',
});
function safeAsset(row, expected) {
  if (!plain(row) || typeof own(row, 'assetId') !== 'string' || !/^asset_[a-f0-9]{32}$/u.test(row.assetId)
    || typeof own(row, 'name') !== 'string' || typeof own(row, 'mimeType') !== 'string' || !Number.isSafeInteger(own(row, 'byteLength'))
    || row.byteLength !== expected.byteLength || row.mimeType !== expected.mimeType || own(row, 'actualQQ') !== expected.actualQQ
    || own(row, 'kind') !== 'sticker' || own(row, 'sha256') !== expected.sha256 || !Array.isArray(own(row, 'groupIds'))
    || expected.groupIds.some(id => !row.groupIds.includes(id))) throw fail('QQ_STICKER_IMPORT_UNKNOWN', '素材导入结果无法确认，请刷新素材列表核对。');
  return { assetId: row.assetId, name: row.name, mimeType: row.mimeType, byteLength: row.byteLength };
}

/** Trusted host operation, never an LLM download tool. listRemote is bound by
 * the runtime to the connected account's fetch_custom_face({count:limit}); its
 * official OneBot data is string[]. No URL/path comes from the owner request. */
export async function syncQqStickers({ actualQQ, groupIds, limit = 10, listRemote, assets, fetchImage = defaultFetchImage, signal, authorize } = {}) {
  if (typeof actualQQ !== 'string' || !QQ.test(actualQQ) || !Array.isArray(groupIds) || !groupIds.length || groupIds.length > 100
    || groupIds.some(id => typeof id !== 'string' || !QQ.test(id)) || new Set(groupIds).size !== groupIds.length
    || !Number.isSafeInteger(limit) || limit < 1 || limit > QQ_STICKER_SYNC_LIMITS.count
    || typeof listRemote !== 'function' || typeof fetchImage !== 'function' || typeof authorize !== 'function'
    || typeof assets?.import !== 'function' || typeof assets?.findBySha !== 'function') throw fail('QQ_STICKER_SYNC_INPUT', '请选择当前账号及明确授权的群，再同步1–10个QQ收藏表情。', 400);
  const selectedGroups = [...groupIds].sort(), selectedQQ = actualQQ;
  const deadline = performance.now() + QQ_STICKER_SYNC_LIMITS.deadlineMs;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), QQ_STICKER_SYNC_LIMITS.deadlineMs);
  const active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const result = { status: 'completed', imported: [], importedCount: 0, skippedCount: 0, failedCount: 0,
    processedCount: 0, receivedCount: 0, hasMore: false, downloadedBytes: 0, importedBytes: 0, stopped: false, failures: [],
    notice: '仅同步本人已有QQ收藏表情到明确选定群的受管素材；没有自动图像识别或视觉API调用，图片版权仍归原权利人。' };
  const stopped = () => fail('QQ_STICKER_SYNC_CANCELLED', '同步已取消，后续表情未继续处理。');
  const checkSignal = () => { if (performance.now() >= deadline && !active.aborted) controller.abort(); if (active.aborted) throw stopped(); };
  const run = async operation => {
    checkSignal(); let abort;
    const cancelled = new Promise((_, reject) => { abort = () => reject(stopped()); active.addEventListener('abort', abort, { once: true }); });
    try { return await Promise.race([Promise.resolve().then(() => { checkSignal(); return operation(); }), cancelled]); }
    finally { active.removeEventListener('abort', abort); }
  };
  const check = async phase => {
    checkSignal();
    try { if (await run(() => authorize({ actualQQ: selectedQQ, groupIds: [...selectedGroups], phase, signal: active })) === false) throw new Error(); }
    catch (error) { if (active.aborted) throw stopped(); throw fail('QQ_STICKER_SYNC_DENIED', '账号身份或同步权限已改变，后续表情未继续处理。', 403); }
    checkSignal();
  };
  const failure = (index, code, reason, uncertain = false) => { result.failedCount++; result.failures.push({ index, code, reason, ...(uncertain ? { executed: null } : { executed: false }) }); };
  let index = 0, began = false;
  try {
    await check('before-list'); began = true;
    const entries = entriesOf(await run(() => listRemote({ limit, signal: active })));
    await check('after-list'); result.receivedCount = entries.length; result.hasMore = entries.length > limit;
    const seenURLs = new Set(), seenHashes = new Set();
    for (index = 0; index < Math.min(entries.length, limit); index++) {
      await check('before-item');
      if (result.downloadedBytes >= QQ_STICKER_SYNC_LIMITS.totalBytes) { result.status = 'budget_exhausted'; result.stopped = true; break; }
      result.processedCount++;
      try {
        const url = entryUrl(entries[index]);
        if (!isQqStickerImageUrl(url)) throw fail('QQ_STICKER_SOURCE_REJECTED', REASONS.QQ_STICKER_SOURCE_REJECTED);
        if (seenURLs.has(url)) { result.skippedCount++; continue; }
        seenURLs.add(url);
        const remainingBytes = QQ_STICKER_SYNC_LIMITS.totalBytes - result.downloadedBytes;
        const image = await run(async () => {
          const value = await fetchImage(url, { signal: active, remainingBytes });
          checkSignal(); return value;
        });
        await check('after-download');
        const bytes = own(image, 'bytes'), mimeType = own(image, 'mimeType'), wireBytes = own(image, 'wireBytes') ?? (Buffer.isBuffer(bytes) ? bytes.length : 0);
        result.downloadedBytes += Math.min(remainingBytes, QQ_STICKER_SYNC_LIMITS.imageBytes,
          Math.max(Buffer.isBuffer(bytes) ? bytes.length : 0, Number.isSafeInteger(wireBytes) && wireBytes >= 0 ? wireBytes : 0));
        if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > Math.min(QQ_STICKER_SYNC_LIMITS.imageBytes, remainingBytes)
          || !Number.isSafeInteger(wireBytes) || wireBytes < 0 || wireBytes > Math.min(QQ_STICKER_SYNC_LIMITS.imageBytes, remainingBytes)) throw fail('QQ_STICKER_IMAGE_REJECTED', REASONS.QQ_STICKER_IMAGE_REJECTED);
        const type = imageType(bytes);
        if (mimeType !== type.mimeType) throw fail('QQ_STICKER_MIME_MISMATCH', REASONS.QQ_STICKER_MIME_MISMATCH);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (seenHashes.has(sha256)) { result.skippedCount++; continue; }
        await check('before-deduplicate');
        const existing = await run(() => assets.findBySha({ actualQQ: selectedQQ, groupIds: [...selectedGroups], kind: 'sticker', sha256 }));
        await check('after-deduplicate');
        if (existing) { safeAsset(existing, { actualQQ: selectedQQ, groupIds: selectedGroups, byteLength: bytes.length, mimeType, sha256 }); seenHashes.add(sha256); result.skippedCount++; continue; }
        await check('before-import');
        checkSignal();
        const imported = safeAsset(assets.import({ actualQQ: selectedQQ, groupIds: [...selectedGroups], kind: 'sticker',
          name: `QQ表情-${index + 1}.${type.extension}`, dataBase64: bytes.toString('base64'), tags: [],
          description: '从本人QQ收藏表情导入，尚未进行图像识别。' }), { actualQQ: selectedQQ, groupIds: selectedGroups, byteLength: bytes.length, mimeType, sha256 });
        result.imported.push(imported); result.importedCount++; result.importedBytes += bytes.length; seenHashes.add(sha256);
        await check('after-import');
      } catch (error) {
        const code = own(error, 'code');
        if (active.aborted || ['QQ_STICKER_SYNC_CANCELLED', 'QQ_STICKER_SYNC_DENIED'].includes(code)) throw error;
        const charged = own(error, 'receivedBytes');
        if (Number.isSafeInteger(charged) && charged > 0) result.downloadedBytes += Math.min(charged, QQ_STICKER_SYNC_LIMITS.imageBytes, QQ_STICKER_SYNC_LIMITS.totalBytes - result.downloadedBytes);
        if (Object.hasOwn(REASONS, code)) { failure(index + 1, code, REASONS[code]); continue; }
        throw error;
      }
    }
    if (result.status === 'completed' && result.failedCount) result.status = 'partial';
    return result;
  } catch (error) {
    const code = own(error, 'code');
    if (!began && code === 'QQ_STICKER_SYNC_DENIED') throw error;
    result.stopped = true;
    if (active.aborted || code === 'QQ_STICKER_SYNC_CANCELLED') result.status = 'cancelled';
    else if (code === 'QQ_STICKER_SYNC_DENIED') result.status = 'denied';
    else { result.status = 'unknown'; failure(Math.min(index + 1, limit), 'QQ_STICKER_SYNC_UNKNOWN', '本次读取或导入结果无法确认，已停止；请刷新素材列表核对，不会自动重试。', true); }
    return result;
  } finally { clearTimeout(timer); }
}
