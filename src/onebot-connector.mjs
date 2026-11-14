import { performance } from 'node:perf_hooks';

/** QQ transport differences live here; model, memory and permission policy do not. */
export const SNOWLUMA_REVIEW = Object.freeze({
  state: 'external_protocol_adapter',
  available: true,
  verified: false,
  experimental: true,
  externalRuntime: true,
  runtimeManaged: false,
  windowsDynamic: 'pending',
  liveQQ: 'pending',
  publicSourceBuild: 'completed-isolated',
  nativeBuild: 'precompiled-input-only',
  repository: 'TomyJan/SnowLuma',
  version: '2.4.2',
  commit: 'f2ea3354f8bbe8672cbb4ae6a2b4e1fbeff44faf',
  windowsLiteSha256: '14c6f137196d5f556e6c601a880ee8aa238ffaf4227696848a146209f96d0f31',
  windowsFullSha256: '0912926c5e73260f35b000278a8658493fc9452f36782c32fa86f0e825bad81a',
  reason: '提供固定 SnowLuma 2.4.2 的外部实验协议适配，需用户自行审查并运行连接端；不下载、启动或分发其原生组件。Windows 动态安全检查和真实 QQ 兼容验证尚未完成。',
});

const BACKENDS = Object.freeze({
  napcat: Object.freeze({ id: 'napcat', name: 'NapCat Shell', available: true, experimental: false, transport: 'websocket' }),
  snowluma: Object.freeze({ id: 'snowluma', name: 'SnowLuma', available: true, experimental: true,
    externalRuntime: true, runtimeManaged: false, transport: 'websocket+http', reason: SNOWLUMA_REVIEW.reason }),
});

function failure(code, message, status = 502, extra = {}) {
  return Object.assign(new Error(message), { code, status, statusCode: status, nextStep: 'connection', ...extra });
}

function backendId(value) {
  const id = value === undefined ? 'napcat' : value;
  if (!Object.hasOwn(BACKENDS, id)) throw failure('QQ_BACKEND_INVALID', 'QQ 连接端无效，请选择 NapCat Shell 或 SnowLuma。', 400, { field: 'qq.backend' });
  return id;
}

/** Return copies so dashboard code cannot change the production admission gate. */
export function connectorCatalog() {
  return Object.values(BACKENDS).map(entry => ({ ...entry, ...(entry.id === 'snowluma' ? { review: { ...SNOWLUMA_REVIEW } } : {}) }));
}

export function assertBackendAvailable(value = 'napcat') {
  const id = backendId(value);
  if (!BACKENDS[id].available) throw failure('SNOWLUMA_REVIEW_REQUIRED', SNOWLUMA_REVIEW.reason, 409, {
    field: 'qq.backend', action: '请使用已开放的连接端，并核对固定版本和该账号独立连接配置。',
  });
  return id;
}

/** Resolve saved settings without applying, starting, or approving the backend. */
export function resolveConnector(config = {}) {
  const qq = config.qq || {};
  const backend = backendId(qq.backend);
  const saved = qq.connections?.[backend] || {};
  return {
    ...BACKENDS[backend], backend,
    wsUrl: qq.wsUrl || saved.wsUrl || 'ws://127.0.0.1:3001',
    webUiUrl: qq.webUiUrl || saved.webUiUrl || (backend === 'napcat' ? 'http://127.0.0.1:6099' : 'http://127.0.0.1:5099'),
    httpUrl: backend === 'snowluma' ? qq.httpUrl || saved.httpUrl || 'http://127.0.0.1:3000' : '',
    wsTokenName: backend === 'napcat' ? 'napcatToken' : 'snowlumaWsToken',
    httpTokenName: backend === 'snowluma' ? 'snowlumaHttpToken' : '',
  };
}

/** Read-only capability declaration; never send a message to discover support. */
export function getBackendCapabilities(value = 'napcat') {
  const backend = backendId(value);
  const common = { text: 'supported', mention: 'supported', groupList: 'supported', identity: 'supported' };
  if (backend === 'snowluma') return { backend, available: true, verified: false, experimental: true,
    externalRuntime: true, runtimeManaged: false, sourceCommit: SNOWLUMA_REVIEW.commit,
    protocolValidation: 'fixture-tested', windowsDynamic: 'pending', liveQQ: 'pending',
    ...Object.fromEntries([...Object.keys(common), 'reply', 'groupInfo', 'groupMembers', 'poke', 'reaction', 'image', 'sticker',
      'file', 'fileStream', 'forward', 'recall', 'notices', 'groupFiles', 'favorites', 'favoriteStickers'].map(key => [key, 'source-contract'])),
    reason: SNOWLUMA_REVIEW.reason };
  return { backend, available: true, verified: true, ...common, poke: 'version-dependent', notices: 'version-dependent', favorites: 'version-dependent' };
}

const safeId = value => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return '';
  return ['string', 'number', 'bigint'].includes(typeof value) && /^[1-9]\d{0,19}$/.test(String(value)) ? String(value) : '';
};

/** Keep unknown event types intact; normalize only documented field aliases. */
export function normalizeConnectorPacket(packet, { backend = 'napcat', expectedQQ = '' } = {}) {
  backendId(backend);
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return null;
  const self = packet.self_id ?? packet.selfId;
  if (backend === 'snowluma' && expectedQQ && self === undefined && ['message', 'message_sent', 'notice', 'meta_event'].includes(packet.post_type)) return null;
  if (self !== undefined && (!safeId(self) || (expectedQQ && safeId(self) !== String(expectedQQ)))) return null;
  const result = { ...packet, ...(self === undefined ? {} : { self_id: safeId(self) }) };
  if (backend === 'snowluma' && packet.post_type === 'notice' && packet.notice_type === 'notify' && packet.sub_type === 'poke') {
    const sender = safeId(packet.user_id ?? packet.sender_id ?? packet.sender?.user_id);
    const target = safeId(packet.target_id ?? packet.targetId);
    if (!sender || !target) return null;
    result.user_id = sender; result.target_id = target;
  }
  // SnowLuma f2ea3354 emits add/remove, while the shared group normalizer
  // consumes NapCat's boolean is_add. Never infer from arbitrary truthiness.
  if (backend === 'snowluma' && packet.post_type === 'notice' && packet.notice_type === 'group_msg_emoji_like'
    && ['add', 'remove'].includes(packet.sub_type)) {
    const added = packet.sub_type === 'add';
    if (packet.is_add !== undefined && packet.is_add !== added) return null;
    result.is_add = added;
  }
  return result;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Extra hosts must come from trusted deployment settings, never a request body. */
export function validateConnectorUrl(value, { kind = 'http', allowedHosts = [] } = {}) {
  let url;
  try { url = new URL(value); } catch { throw failure('ONEBOT_WRONG_ENDPOINT', 'OneBot 地址格式无效。', 400); }
  const protocols = kind === 'ws' ? ['ws:', 'wss:'] : ['http:', 'https:'];
  const allowed = new Set(allowedHosts.map(host => String(host).trim().toLowerCase()));
  if (!protocols.includes(url.protocol) || url.username || url.password || url.search || url.hash
    || (url.pathname && url.pathname !== '/') || (!LOOPBACK.has(url.hostname) && !allowed.has(url.hostname.toLowerCase()))) {
    throw failure('ONEBOT_WRONG_ENDPOINT', 'OneBot 地址须使用本机或部署明确允许的主机，不能包含凭据、查询参数或路径。', 400);
  }
  return url;
}

const READ_ACTIONS = new Set(['get_login_info', 'get_group_list', 'get_status', 'get_version_info', 'get_stranger_info',
  'get_group_info', 'get_group_member_info', 'get_group_member_list', 'get_msg', 'get_forward_msg', 'get_image',
  'get_record', 'get_friend_list', 'get_group_file_system_info', 'get_group_root_files', 'get_group_files_by_folder', 'get_collection_list',
  '_get_group_notice', 'fetch_custom_face']);

export const SNOWLUMA_HTTP_LIMITS = Object.freeze({ requestBytes: 1024 * 1024, imageBytes: 8 * 1024 * 1024,
  imageRequestBytes: 12 * 1024 * 1024 });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exactKeys = (value, allowed) => plain(value) && Object.keys(value).every(key => allowed.includes(key));

// Only the host's fixed single-image message shape earns the larger budget.
// Other actions, URLs, custom segments, extra fields and text remain at 1 MiB.
function approvedImageMessage(action, value) {
  const target = action === 'send_group_msg' ? 'group_id' : action === 'send_private_msg' ? 'user_id' : '';
  if (!target || !exactKeys(value, [target, 'message']) || !safeId(value[target])
    || !Array.isArray(value.message) || !value.message.length || value.message.length > 4) return false;
  let images = 0;
  for (const segment of value.message) {
    if (!exactKeys(segment, ['type', 'data'])) return false;
    if (segment.type === 'text') {
      if (!exactKeys(segment.data, ['text']) || typeof segment.data.text !== 'string' || segment.data.text.length > 12_000) return false;
      continue;
    }
    if (segment.type !== 'image' || ++images > 1 || !exactKeys(segment.data, ['file', 'sub_type'])
      || segment.data.sub_type !== undefined && ![0, 1].includes(segment.data.sub_type)
      || typeof segment.data.file !== 'string' || !segment.data.file.startsWith('base64://')) return false;
    const encoded = segment.data.file.slice(9);
    if (!encoded.length || encoded.length % 4 || /[^A-Za-z0-9+/=]/u.test(encoded)) return false;
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    if (encoded.indexOf('=') !== (padding ? encoded.length - padding : -1)
      || encoded.length / 4 * 3 - padding > SNOWLUMA_HTTP_LIMITS.imageBytes) return false;
  }
  return images === 1;
}

function discardBody(body) {
  try { void Promise.resolve(body?.cancel?.()).catch(() => {}); } catch {}
}

/** SnowLuma action transport. Admission and QQ identity are checked by the caller.
 * There are deliberately no retries: a lost response may already have sent a message.
 */
export function createSnowLumaHttpClient({ baseUrl, token, allowedHosts = [], fetchImpl = globalThis.fetch,
  timeoutMs = 15_000, maxResponseBytes = 1024 * 1024 } = {}) {
  const base = validateConnectorUrl(baseUrl, { allowedHosts });
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw failure('ONEBOT_TOKEN_MISSING', '请配置 SnowLuma HTTP Token。', 409, { field: 'secrets.snowlumaHttpToken' });
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 16 * 1024 * 1024) throw new TypeError('OneBot HTTP limits are invalid');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const controllers = new Set();
  let closed = false;
  const redact = text => String(text || '').split(token).join('[已隐藏]')
    .replace(/(?:base64:\/\/|data:[^;,\s]+;base64,)[A-Za-z0-9+/=]+/giu, '[图片数据已隐藏]').slice(0, 200);
  const request = async (action, params = {}, { signal, isSend } = {}) => {
    const started = performance.now();
    if (closed) throw failure('ONEBOT_CONNECTION_CLOSED', 'SnowLuma HTTP 连接已关闭。', 409);
    if (!(action === '_get_group_notice' || /^[a-z][a-z0-9_]{0,63}$/.test(action))
      || !params || typeof params !== 'object' || Array.isArray(params)) throw failure('ONEBOT_ACTION_INVALID', 'OneBot 操作或参数无效。', 400);
    const body = JSON.stringify(params);
    const bodyBytes = Buffer.byteLength(body);
    if (bodyBytes > SNOWLUMA_HTTP_LIMITS.requestBytes && (bodyBytes > SNOWLUMA_HTTP_LIMITS.imageRequestBytes
      || !approvedImageMessage(action, JSON.parse(body)))) throw failure('ONEBOT_REQUEST_TOO_LARGE', 'OneBot 操作参数过大，或不符合受管图片消息范围。', 400);
    const writes = isSend === true || !READ_ACTIONS.has(action);
    const controller = new AbortController();
    controllers.add(controller);
    let timedOut = false, attempted = false, definitiveFailure = false;
    const deadline = started + timeoutMs;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, deadline - performance.now()));
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const check = () => {
      if (performance.now() >= deadline) { timedOut = true; controller.abort(); }
      if (controller.signal.aborted) throw failure(timedOut ? 'ONEBOT_TIMEOUT' : 'ONEBOT_CANCELLED',
        timedOut ? 'SnowLuma HTTP 操作超时。' : 'SnowLuma 操作已取消。', timedOut ? 502 : 409);
    };
    const wait = async (operation, late = () => {}) => {
      check(); let listener;
      const cancelled = new Promise((_, reject) => {
        listener = () => { try { check(); } catch (error) { reject(error); } };
        controller.signal.addEventListener('abort', listener, { once: true });
      });
      const pending = Promise.resolve().then(() => { check(); return operation(); });
      void pending.then(value => { if (controller.signal.aborted || performance.now() >= deadline) late(value); }).catch(() => {});
      try { const value = await Promise.race([pending, cancelled]); check(); return value; }
      finally { controller.signal.removeEventListener('abort', listener); }
    };
    try {
      check();
      const response = await wait(() => {
        attempted = true;
        return fetchImpl(new URL(action, base), { method: 'POST', redirect: 'error',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body, signal: controller.signal });
      }, value => discardBody(value?.body));
      if (!response || typeof response.status !== 'number') throw failure('ONEBOT_INVALID_RESPONSE', 'SnowLuma 没有返回有效的 OneBot 数据。');
      if (response.redirected) { discardBody(response.body); throw failure('ONEBOT_HTTP_FAILED', 'SnowLuma HTTP 地址发生跳转，已停止读取。'); }
      if (!response.ok) {
        discardBody(response.body);
        definitiveFailure = [400, 401, 403, 404, 405, 413, 415].includes(response.status);
        if ([401, 403].includes(response.status)) throw failure('ONEBOT_AUTH_FAILED', 'SnowLuma 拒绝了 HTTP Token，请核对该账号 HTTP 服务的 Token。', 401, { field: 'secrets.snowlumaHttpToken' });
        throw failure('ONEBOT_HTTP_FAILED', `SnowLuma HTTP 操作失败（HTTP ${response.status}）。`);
      }
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > maxResponseBytes) {
        discardBody(response.body);
        throw failure('ONEBOT_RESPONSE_TOO_LARGE', 'SnowLuma 返回的数据超过限制。');
      }
      const reader = response.body?.getReader();
      if (!reader) throw failure('ONEBOT_INVALID_RESPONSE', 'SnowLuma 没有返回有效的 OneBot 数据。');
      let size = 0;
      const chunks = [];
      try {
        while (true) {
          const chunk = await wait(() => reader.read());
          if (chunk.done) break;
          if (!(chunk.value instanceof Uint8Array)) throw failure('ONEBOT_INVALID_RESPONSE', 'SnowLuma 返回了无效的数据流。');
          size += chunk.value.byteLength;
          if (size > maxResponseBytes) {
            throw failure('ONEBOT_RESPONSE_TOO_LARGE', 'SnowLuma 返回的数据超过限制。');
          }
          chunks.push(Buffer.from(chunk.value));
        }
      } catch (error) {
        try { void Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
        throw error;
      } finally { try { reader.releaseLock(); } catch {} }
      check();
      let result;
      try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('ONEBOT_INVALID_RESPONSE', 'SnowLuma 返回的 OneBot 数据不是有效 JSON。'); }
      if (!result || typeof result !== 'object' || Array.isArray(result) || result.status !== 'ok' || result.retcode !== 0) {
        // Generic runtime failures (SnowLuma 100/1200) may follow a real QQ
        // side effect. Only known validation/unknown-action codes attest that
        // the action was refused before execution; no failed write is retried.
        definitiveFailure = Boolean(result && result.status === 'failed' && [1400, 1404, 1413].includes(result.retcode));
        const code = action === 'get_login_info' ? 'QQ_NOT_LOGGED_IN' : action === 'get_group_list' ? 'GROUP_LIST_UNAVAILABLE' : 'ONEBOT_ACTION_FAILED';
        throw failure(code, `SnowLuma 操作未成功（${redact(result?.wording || result?.message || result?.retcode || '无有效结果')}）。`);
      }
      check(); return result.data;
    } catch (error) {
      const issue = error?.code && error.status ? error : failure(timedOut ? 'ONEBOT_TIMEOUT' : controller.signal.aborted ? 'ONEBOT_CANCELLED' : 'ONEBOT_HTTP_FAILED',
        timedOut ? 'SnowLuma HTTP 操作超时。' : controller.signal.aborted ? 'SnowLuma 操作已取消。' : '未能完成 SnowLuma HTTP 操作，请检查服务与地址。', controller.signal.aborted && !timedOut ? 409 : 502);
      if (writes && attempted && !definitiveFailure) issue.deliveryUncertain = true;
      throw issue;
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); controllers.delete(controller);
    }
  };
  return {
    request,
    getIdentity: options => request('get_login_info', {}, options),
    close() { closed = true; for (const controller of controllers) controller.abort(); controllers.clear(); },
  };
}
