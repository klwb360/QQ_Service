import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

// Independently implemented against the official NapCat 13a8a2b8 API:
// packages/napcat-onebot/action/go-cqhttp/UploadGroupFile.ts
// packages/napcat-common/src/file.ts (uriToLocalFile Base64 branch)
// packages/napcat-onebot/action/stream/UploadFileStream.ts
// Small payloads use the documented URI decoder; larger payloads stay below
// the connector's 1 MiB JSON request budget through 256 KiB stream chunks.
export const QQ_FILE_DELIVERY_LIMITS = Object.freeze({ chunkBytes: 256 * 1024, totalBytes: 20 * 1024 * 1024 });
const validGroup = value => typeof value === 'string' && /^[1-9]\d{3,19}$/u.test(value);
const error = (code, message, statusCode = 502) => Object.assign(new Error(message), { code, statusCode });
const unsupportedCodes = new Set(['ONEBOT_ACTION_UNSUPPORTED', 'ONEBOT_UNSUPPORTED_ACTION', 'UNSUPPORTED_ACTION', 'ACTION_NOT_FOUND']);
const unsupported = cause => cause?.deliveryUncertain !== true && (unsupportedCodes.has(cause?.code)
  || cause?.code === 'ONEBOT_ACTION_FAILED' && [cause.message, ...(Array.isArray(cause.details) ? cause.details : [])].some(value =>
    typeof value === 'string' && /(?:upload_file_stream|upload_group_file|\baction\b|\bapi\b|接口)/iu.test(value)
      && /(?:not\s+(?:found|supported|implemented)|unsupported|unknown\s+action|未实现|不支持|未注册|不存在的接口)/iu.test(value)));
const fileId = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(value);
const sameInteger = (value, expected) => Number.isSafeInteger(value) && value === expected;

function safeName(value) {
  if (typeof value !== 'string') throw error('QQ_FILE_INVALID', '受管文件缺少有效名称。', 400);
  const name = value.replace(/\\/gu, '/').split('/').at(-1).normalize('NFKC').replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 180).trim();
  if (!name || name === '.' || name === '..') throw error('QQ_FILE_INVALID', '受管文件缺少有效名称。', 400);
  return name;
}

function connectorPath(value, filename) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)
    || /^[a-z][a-z0-9+.-]*:\/\//iu.test(value) || value.startsWith('\\\\') || value.startsWith('//')
    || !path.posix.isAbsolute(value) && !/^[A-Za-z]:[\\/]/u.test(value)) return false;
  const pieces = value.replace(/\\/gu, '/').split('/');
  return pieces.at(-1) === filename && !pieces.includes('..');
}

/** Host-only file delivery. No argument is supplied by a model except the
 * assetId which the caller has already resolved and approved. Neither an app
 * filesystem path nor a user-supplied URL is ever sent to the connector. */
export async function sendQqFile({ asset, groupId, action, authorize, onDispatch, signal } = {}) {
  let uploadState = 'not_uploaded', deliveryAttempted = false, transferAttempted = false;
  const check = async () => {
    if (signal?.aborted) throw error('QQ_FILE_CANCELLED', '文件发送已取消。', 409);
    if (typeof authorize !== 'function') throw error('QQ_FILE_UNAUTHORIZED', '文件发送缺少当前会话授权。', 403);
    const allowed = await authorize();
    if (allowed === false || allowed?.allowed === false) throw error('QQ_FILE_UNAUTHORIZED', '文件发送授权已失效。', 403);
    if (signal?.aborted) throw error('QQ_FILE_CANCELLED', '文件发送已取消。', 409);
  };
  try {
    await check();
    if (!validGroup(groupId)) throw error('QQ_FILE_INVALID', '文件发送缺少当前群身份。', 400);
    if (typeof action !== 'function') throw Object.assign(error('QQ_ACTION_DENIED', '当前连接端不支持文件发送。', 403), { deliveryUncertain: false });
    if (!asset || !(asset.bytes instanceof Uint8Array) || !asset.bytes.byteLength || asset.bytes.byteLength > QQ_FILE_DELIVERY_LIMITS.totalBytes
      || asset.groupId !== undefined && asset.groupId !== groupId || asset.kind !== undefined && asset.kind !== 'file'
      || asset.size !== undefined && asset.size !== asset.bytes.byteLength || asset.byteLength !== undefined && asset.byteLength !== asset.bytes.byteLength
      || typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(asset.sha256)) {
      throw error('QQ_FILE_INVALID', '受管文件内容、大小或摘要无效，未开始发送。', 400);
    }
    const bytes = Buffer.from(asset.bytes), sha256 = createHash('sha256').update(bytes).digest('hex'), name = safeName(asset.name);
    if (sha256 !== asset.sha256.toLowerCase()) throw error('QQ_FILE_HASH_MISMATCH', '受管文件摘要校验失败，未开始发送。', 400);
    const call = async (name, params, { publish = false } = {}) => {
      await check();
      if (publish) {
        await onDispatch?.();
        // Quota reservation may wait on durable state. Recheck the current
        // identity and cancellation before the first irreversible QQ call.
        await check();
        deliveryAttempted = true;
      }
      transferAttempted = true;
      let result;
      try {
        const pending = Promise.resolve(action(name, params, { signal }));
        let abort;
        const cancelled = signal ? new Promise((_, reject) => {
          abort = () => reject(error('QQ_FILE_CANCELLED', '文件发送已取消。', 409));
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        }) : null;
        try { result = await (cancelled ? Promise.race([pending, cancelled]) : pending); }
        finally { if (abort) signal.removeEventListener('abort', abort); }
      } catch (cause) {
        if (cause?.code === 'QQ_FILE_CANCELLED') throw cause;
        const failed = error(typeof cause?.code === 'string' ? cause.code : 'QQ_FILE_TRANSFER_UNKNOWN', '文件传输或投递没有返回可核对的连接端回执。');
        Object.defineProperty(failed, 'cause', { value: cause });
        if (unsupported(cause)) failed.unsupported = true;
        throw failed;
      }
      await check(); return result;
    };
    let uri;
    if (bytes.length <= QQ_FILE_DELIVERY_LIMITS.chunkBytes) {
      // uriToLocalFile decodes this inside NapCat, in its own container or
      // native environment. Never ask NapCat to fetch a remote URL.
      uri = `base64://${bytes.toString('base64')}`;
    } else {
      const streamId = randomUUID(), filename = `qq-service-${streamId}.upload`;
      const totalChunks = Math.ceil(bytes.length / QQ_FILE_DELIVERY_LIMITS.chunkBytes);
      for (let index = 0; index < totalChunks; index++) {
        const params = { stream_id: streamId, chunk_index: index,
          chunk_data: bytes.subarray(index * QQ_FILE_DELIVERY_LIMITS.chunkBytes, (index + 1) * QQ_FILE_DELIVERY_LIMITS.chunkBytes).toString('base64'),
          file_retention: 300_000,
          ...(index === 0 ? { total_chunks: totalChunks, file_size: bytes.length, expected_sha256: sha256, filename } : {}) };
        const result = await call('upload_file_stream', params);
        uploadState = 'partial';
        if (!result || result.type !== 'stream' || result.status !== 'chunk_received' || result.stream_id !== streamId
          || !sameInteger(result.received_chunks, index + 1) || !sameInteger(result.total_chunks, totalChunks)) {
          throw error('QQ_FILE_STREAM_INVALID', '连接端没有确认当前文件分块，已停止上传。');
        }
      }
      const result = await call('upload_file_stream', { stream_id: streamId, is_complete: true, file_retention: 300_000 });
      if (!result || result.type !== 'response' || result.status !== 'file_complete' || result.stream_id !== streamId
        || !sameInteger(result.received_chunks, totalChunks) || !sameInteger(result.total_chunks, totalChunks)
        || !sameInteger(result.file_size, bytes.length) || result.sha256 !== sha256 || !connectorPath(result.file_path, filename)) {
        throw error('QQ_FILE_STREAM_INVALID', '连接端完成回执的文件摘要、大小或临时文件身份不一致，未投递到群。');
      }
      uploadState = 'uploaded';
      uri = result.file_path;
    }
    const delivered = await call('upload_group_file', { group_id: groupId, file: uri, name, upload_file: true }, { publish: true });
    if (!delivered || !fileId(delivered.file_id)) throw error('QQ_FILE_DELIVERY_UNKNOWN', '群文件投递未返回可核对的文件编号，请先检查实际结果。');
    uploadState = 'uploaded';
    return { executed: true, status: 'sent', groupId, fileId: delivered.file_id, name, size: bytes.length, sha256 };
  } catch (cause) {
    let failure = cause instanceof Error ? cause : error('QQ_FILE_TRANSFER_UNKNOWN', '文件发送没有返回可确认的结果。');
    // An explicitly unsupported first endpoint is a definite refusal. Never
    // fall back to another transport after a timeout or malformed response.
    if (failure.unsupported === true || unsupported(failure)) {
      deliveryAttempted = false;
      failure = Object.assign(error('QQ_ACTION_DENIED', '当前连接端未实现所需文件上传接口，请升级 NapCat；未投递到群。', 403),
        { unsupported: true });
    }
    if (transferAttempted && uploadState === 'not_uploaded' && !failure.unsupported) uploadState = 'unknown';
    failure.uploadState = uploadState;
    failure.deliveryState = deliveryAttempted ? 'unknown' : 'not_sent';
    failure.deliveryUncertain = deliveryAttempted;
    failure.transferUncertain = transferAttempted && uploadState !== 'uploaded' && !failure.unsupported;
    throw failure;
  }
}
