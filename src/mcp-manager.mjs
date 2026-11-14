import { createHash, createHmac, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mcpToolId, mcpDefinitionHash, mcpSecretName, mcpConnectionDescriptor, validateMcpServerConfig } from './mcp-config.mjs';
import { compileMcpToolSchema, validateMcpToolInput } from './mcp-schema.mjs';
import { toolFunctionName } from './tool-router.mjs';

const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_BYTES = 32 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = value => structuredClone(value);
const fail = (message, code = 'MCP_UNAVAILABLE', statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const connectionShape = mcpConnectionDescriptor;
const shapeHash = server => createHash('sha256').update(JSON.stringify(connectionShape(server))).digest('hex');
const defaultFactory = async (server, options) => (await import('./mcp-client.mjs')).createMcpClient(server, options);
const bundledBilibiliPath = fileURLToPath(new URL('../examples/mcp/bilibili.mjs', import.meta.url));
const appDirectory = fileURLToPath(new URL('../', import.meta.url));
const BILIBILI_NAMES = new Set(['popular_videos', 'search_videos', 'video_details', 'list_favorite_folders',
  'list_favorite_items', 'list_watch_later', 'list_favorite_articles', 'read_video_content', 'read_article_content',
  'queue_library_digest', 'library_digest_status', 'cancel_library_digest']);
const samePath = (left, right) => process.platform === 'win32'
  ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);

/** Host task handling is available only to the application's exact bundled
 * stdio entrypoint. A remote service cannot opt in by copying a tool name. */
export function isBundledBilibiliServer(server) {
  if (!server || typeof server.command !== 'string' || server.transport !== 'stdio' || server.url
    || !Array.isArray(server.envKeys ?? []) || !Array.isArray(server.headerKeys ?? []) || server.headerKeys?.length
    || !Array.isArray(server.args) || server.args.length !== 1
    || typeof server.args[0] !== 'string' || (server.envKeys || []).some(key => key !== 'BILIBILI_SESSDATA')) return false;
  if (!['node', 'node.exe'].includes(server.command) && !samePath(String(server.command || ''), process.execPath)) return false;
  const argument = server.args[0].replaceAll('{appDir}', appDirectory);
  return path.isAbsolute(argument) && samePath(argument, bundledBilibiliPath);
}

function redactText(value, secrets) {
  let result = String(value ?? '');
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) if (secret) {
    result = result.split(secret).join('[已隐藏]');
    try { result = result.split(encodeURIComponent(secret)).join('[已隐藏]'); } catch {}
  }
  return result.replace(/(Bearer\s+)[^\s"']+/gi, '$1[已隐藏]')
    .replace(/((?:access_token|api_key|apiKey|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',}\]]+/gi, '$1[已隐藏]');
}

function redactData(value, secrets, depth = 0) {
  if (depth > 40) throw fail('MCP 资料嵌套过深。', 'MCP_DATA_INVALID', 502);
  if (typeof value === 'string') return redactText(value, secrets);
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => redactData(item, secrets, depth + 1));
  if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail('MCP 返回了非 JSON 资料。', 'MCP_DATA_INVALID', 502);
  const result = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable) continue;
    if (!Object.hasOwn(descriptor, 'value') || ['__proto__', 'constructor', 'prototype'].includes(key)) throw fail('MCP 资料包含无效字段。', 'MCP_DATA_INVALID', 502);
    const safeKey = redactText(key, secrets);
    if (['__proto__', 'constructor', 'prototype'].includes(safeKey)) throw fail('MCP 资料包含无效字段。', 'MCP_DATA_INVALID', 502);
    result[safeKey] = redactData(descriptor.value, secrets, depth + 1);
  }
  return result;
}

function clippedText(value, bytes) {
  const input = Buffer.from(value, 'utf8');
  return input.length <= bytes ? value : input.subarray(0, Math.max(0, bytes)).toString('utf8').replace(/\uFFFD$/u, '');
}

/** Only textual and structured data leave the manager. Resource links never
 * initiate a fetch, and binary image/audio payloads never enter model context. */
function flattenResult(result, secrets) {
  if (!object(result)) throw fail('MCP 工具没有返回有效结果。', 'MCP_RESULT_INVALID', 502);
  const texts = (Array.isArray(result.content) ? result.content : [])
    .filter(item => object(item) && item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text);
  // Joining first also protects multiline credentials split across text blocks.
  // The transport has already bounded the complete remote payload to2MiB.
  const visibleText = redactText(texts.join('\n'), secrets).slice(0, 128 * 1024);
  if (result.isError === true) throw fail(visibleText.slice(0, 500) || 'MCP 服务报告工具执行失败。', 'MCP_TOOL_ERROR', 502);
  const value = { text: visibleText };
  if (result.structuredContent !== undefined) value.structuredContent = redactData(result.structuredContent, secrets);
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_RESULT_BYTES) {
    // Keep useful text when a structured payload is too large. Never return a
    // half JSON object that might be mistaken for complete structured output.
    if (value.structuredContent !== undefined) delete value.structuredContent;
    value.truncated = true;
    while (Buffer.byteLength(JSON.stringify(value)) > MAX_RESULT_BYTES) {
      const over = Buffer.byteLength(JSON.stringify(value)) - MAX_RESULT_BYTES;
      value.text = clippedText(value.text, Buffer.byteLength(value.text) - Math.max(over, 128));
    }
  }
  return value;
}

/** Each manager belongs to one account/profile. Merely constructing it or
 * importing/saving a server does not spawn a process or open a connection. */
export function createMcpManager({ getConfig, getSecret = () => '', store = {}, log = () => {},
  clientFactory = defaultFactory, fingerprint, onToolsChanged = () => {}, refreshDelayMs = 250 } = {}) {
  if (typeof getConfig !== 'function') throw new TypeError('MCP manager requires getConfig.');
  const states = new Map(), cached = new Map(), jobs = new Set(), testControllers = new Set();
  const privateKey = randomBytes(32);
  let generation = 0, closed = false;
  const configured = () => getConfig()?.mcp?.servers || [];
  const currentServer = id => configured().find(server => server.id === id);
  const live = state => !closed && state.generation === generation && states.get(state.server.id) === state && !state.controller.signal.aborted;
  const safeLog = (state, message, level = 'info') => log(`[MCP ${state.server.id}] ${redactText(message, state.secrets).slice(0, 1000)}`, level);
  const track = promise => {
    const task = Promise.resolve(promise).catch(() => {});
    jobs.add(task); task.finally(() => jobs.delete(task)); return task;
  };
  const safeError = (state, error, toolId) => Object.assign(fail(
    redactText(`MCP ${state.server.label || state.server.id}${toolId ? ` / ${toolId}` : ''}：${error?.message || '操作失败。'}`, state.secrets).slice(0, 800),
    typeof error?.code === 'string' ? error.code : 'MCP_REQUEST_FAILED', error?.statusCode || 502), { serverId: state.server.id, ...(toolId ? { toolId } : {}) });

  async function credentials(server, source) {
    const values = new Map();
    for (const [kind, keys] of [['env', server.envKeys], ['header', server.headerKeys]]) for (const key of keys || []) {
      const name = mcpSecretName(server.id, kind, key);
      const value = await source(name);
      if (value !== undefined && typeof value !== 'string') throw fail('MCP 凭据须为文本。', 'MCP_CREDENTIAL_INVALID', 400);
      values.set(name, value || '');
    }
    const scopedGetter = name => {
      if (!values.has(name)) throw fail('MCP 服务请求了未声明或其他服务的凭据。', 'MCP_CREDENTIAL_SCOPE', 403);
      return values.get(name);
    };
    const hash = fingerprint ? await fingerprint(server, scopedGetter)
      : createHmac('sha256', privateKey).update(JSON.stringify({ connection: connectionShape(server), credentials: [...values] })).digest('hex');
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash)) throw fail('MCP 连接指纹无效。', 'MCP_FINGERPRINT_INVALID', 500);
    return { getSecret: scopedGetter, hash, secrets: new Set([...values.values()].filter(Boolean)) };
  }

  function bounded(state, action, operation, { signal, timeoutMs } = {}) {
    const controller = new AbortController();
    const signals = [state.controller.signal, controller.signal, ...(signal ? [signal] : [])];
    const combined = AbortSignal.any(signals);
    const limit = Math.min(state.server.timeoutSeconds * 1000,
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : state.server.timeoutSeconds * 1000);
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error, value) => {
        if (done) return; done = true;
        clearTimeout(timer); combined.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(fail(`${action}已取消。`, 'MCP_REQUEST_ABORTED', 409));
      const timer = setTimeout(() => { finish(fail(`${action}超时；没有自动重试。`, 'MCP_REQUEST_TIMEOUT', 408)); controller.abort(); }, limit);
      combined.addEventListener('abort', abort, { once: true });
      if (combined.aborted) { abort(); return; }
      Promise.resolve().then(() => operation(combined, limit)).then(value => finish(null, value), error => finish(error));
    });
  }

  async function discover(state, client, signal, timeoutMs) {
    const response = await client.listTools({ signal, timeoutMs });
    const rawTools = Array.isArray(response) ? response : response?.tools;
    if (!Array.isArray(rawTools) || rawTools.length > 200) throw fail('MCP 工具目录格式无效或超过200项。', 'MCP_CATALOG_INVALID', 502);
    const names = new Set(), definitions = [];
    let bytes = 0;
    for (const input of rawTools) {
      const definitionHash = mcpDefinitionHash(input);
      const raw = structuredClone(input);
      const id = mcpToolId(state.server.id, raw.name);
      if (names.has(raw.name)) throw fail('MCP 工具目录含重复名称。', 'MCP_CATALOG_INVALID', 502);
      names.add(raw.name); bytes += Buffer.byteLength(JSON.stringify(raw));
      if (bytes > MAX_CATALOG_BYTES) throw fail('MCP 工具目录超过2 MiB。', 'MCP_CATALOG_INVALID', 502);
      definitions.push({ raw, id, definitionHash });
    }
    const result = new Array(definitions.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, definitions.length) }, async () => {
      while (next < definitions.length) {
        const index = next++, { raw, id, definitionHash } = definitions[index];
        // Redact full strings before shortening display fields. Otherwise a
        // credential straddling a clipping boundary becomes an unrecognizable
        // secret prefix and could survive later redaction and persistence.
        const reflectedSecret = JSON.stringify(raw) !== JSON.stringify(redactData(raw, state.secrets));
        const entry = { id, name: raw.name, definitionHash, description: typeof raw.description === 'string' ? redactText(raw.description, state.secrets).slice(0, 4000) : '',
          inputSchema: raw.inputSchema === undefined ? null : raw.inputSchema, ...(raw.outputSchema !== undefined ? { outputSchema: raw.outputSchema } : {}),
          ...(typeof raw.title === 'string' ? { title: redactText(raw.title, state.secrets).slice(0, 200) } : {}),
          readOnlyHint: raw.annotations?.readOnlyHint === true, supported: true, unsupportedReason: '' };
        try {
          entry.inputSchema = await compileMcpToolSchema(raw.inputSchema, signal);
          if (raw.outputSchema !== undefined) entry.outputSchema = await compileMcpToolSchema(raw.outputSchema, signal);
        } catch (error) {
          entry.supported = false; entry.unsupportedReason = redactText(error.message, state.secrets).slice(0, 400);
        }
        const sanitized = redactData(entry, state.secrets);
        // A reflected secret must not leak through a plain metadata hash either.
        if (reflectedSecret || JSON.stringify(entry) !== JSON.stringify(sanitized)) {
          entry.supported = false; entry.unsupportedReason = '工具定义反射了服务凭据，已禁止调用。';
          entry.definitionHash = ''; entry.id = mcpToolId(state.server.id, `redacted-tool-${index}`);
        }
        result[index] = redactData(entry, state.secrets);
      }
    }));
    if (signal.aborted) throw fail('MCP 工具发现已取消。', 'MCP_REQUEST_ABORTED', 409);
    return result;
  }

  function record(state, status = state.status) {
    return { id: state.server.id, serverId: state.server.id, label: redactText(state.server.label, state.secrets), transport: state.server.transport,
      status, state: status, connected: status === 'connected' && state.catalogValid,
      connectionHash: state.connectionHash || '', testedAt: state.checkedAt || null, checkedAt: state.checkedAt || null,
      lastError: redactText(state.lastError || '', state.secrets).slice(0, 1000), tools: copy(state.tools || []) };
  }

  async function persist(state, status = 'tested') {
    const publishable = () => !closed && state.generation === generation && !state.controller.signal.aborted
      && (state.testing || states.get(state.server.id) === state);
    if (!publishable()) throw fail('MCP 目录已过期，不再保存。', 'MCP_STALE_CATALOG');
    const value = record(state, status); value.connected = false;
    await store.setTask?.(`mcp-catalog:${state.server.id}`, value);
    if (!publishable()) throw fail('MCP 目录已过期，不再发布。', 'MCP_STALE_CATALOG');
    cached.set(state.server.id, value);
    return value;
  }

  async function loadCache(server, expectedGeneration) {
    try {
      const value = await store.getTask?.(`mcp-catalog:${server.id}`);
      if (closed || expectedGeneration !== generation || !object(value) || value.serverId !== server.id
        || !Array.isArray(value.tools) || value.tools.length > 200 || Buffer.byteLength(JSON.stringify(value)) > MAX_CATALOG_BYTES) return;
      const previous = cached.get(server.id);
      if (!previous || Date.parse(value.testedAt || value.checkedAt || '') > Date.parse(previous.testedAt || previous.checkedAt || '')) {
        cached.set(server.id, { ...copy(value), status: 'disconnected', state: 'disconnected', connected: false });
      }
    } catch {}
  }

  async function refreshState(state) {
    if (!live(state) || !state.client) return;
    if (state.refreshPromise) { state.refreshQueued = true; return state.refreshPromise; }
    const revision = state.catalogRevision;
    state.refreshPromise = (async () => {
      try {
        const tools = await bounded(state, 'MCP 工具发现', (signal, timeoutMs) => discover(state, state.client, signal, timeoutMs));
        if (!live(state) || revision !== state.catalogRevision) return;
        state.tools = tools; state.catalogValid = true; state.checkedAt = new Date().toISOString(); state.status = 'connected'; state.lastError = '';
        await persist(state);
      } catch (cause) {
        if (live(state)) { state.catalogValid = false; state.status = 'error'; state.lastError = safeError(state, cause).message; safeLog(state, state.lastError, 'warn'); }
      } finally {
        state.refreshPromise = null;
        if (state.refreshQueued && live(state)) { state.refreshQueued = false; scheduleRefresh(state); }
      }
    })();
    return state.refreshPromise;
  }

  function scheduleRefresh(state) {
    if (!live(state) || state.refreshTimer) return;
    state.refreshTimer = setTimeout(() => { state.refreshTimer = null; track(refreshState(state)); }, Math.max(0, refreshDelayMs));
    state.refreshTimer.unref?.();
  }
  function toolsChanged(state) {
    if (!live(state)) return;
    const wasValid = state.catalogValid;
    state.catalogValid = false; state.catalogRevision++;
    if (wasValid) { try { onToolsChanged({ serverId: state.server.id, reason: 'catalog_changed' }); } catch {} }
    scheduleRefresh(state);
  }
  function disconnected(state, cause) {
    if (!live(state)) return;
    const wasValid = state.catalogValid;
    state.catalogValid = false; state.catalogRevision++; state.status = 'error';
    state.lastError = safeError(state, cause || fail('MCP 连接已关闭。', 'MCP_DISCONNECTED', 502)).message;
    if (wasValid) { try { onToolsChanged({ serverId: state.server.id, reason: 'disconnected' }); } catch {} }
  }

  async function connectState(state) {
    try {
      const auth = await credentials(state.server, getSecret);
      state.secrets = auth.secrets; state.connectionHash = auth.hash;
      if (!live(state)) return;
      await bounded(state, 'MCP 连接', async (signal, timeoutMs) => {
        const client = await clientFactory(state.server, { getSecret: auth.getSecret, signal: state.controller.signal,
          log: (message, level) => safeLog(state, message, level), onToolsChanged: () => toolsChanged(state), onClose: cause => disconnected(state, cause) });
        if (!live(state) || signal.aborted) { await client.close(); return; }
        state.client = client;
        await client.connect({ signal, timeoutMs });
      });
      if (live(state)) await refreshState(state);
    } catch (cause) {
      if (live(state)) { state.catalogValid = false; state.status = 'error'; state.lastError = safeError(state, cause).message; safeLog(state, state.lastError, 'warn'); }
      if (state.client) await Promise.resolve(state.client.close()).catch(() => {});
    }
  }

  function approval(state, tool) {
    if (!live(state)) return null;
    const server = currentServer(state.server.id);
    if (state.status !== 'connected' || !state.catalogValid || !server?.enabled
      || shapeHash(server) !== state.shapeHash || !tool.supported) return null;
    const policy = server.tools?.find(item => item.name === tool.name);
    return policy?.enabled === true && policy.definitionHash === tool.definitionHash
      && policy.connectionHash === state.connectionHash && ['read', 'write'].includes(policy.effect) ? policy : null;
  }

  async function closeState(state) {
    state.controller.abort(); state.catalogValid = false;
    clearTimeout(state.refreshTimer); state.refreshTimer = null;
    if (state.client) await Promise.resolve(state.client.close()).catch(() => {});
    if (state.refreshPromise) await Promise.resolve(state.refreshPromise).catch(() => {});
    // In-flight rejections may still need redaction after the client closes.
    // This state is no longer reachable from the manager and is collected once
    // those operations settle; never clear its redaction set prematurely.
  }

  const manager = {
    start() { return manager.reload(); },
    async reload() {
      if (closed) throw fail('MCP 管理器已关闭。', 'MCP_MANAGER_CLOSED');
      generation++;
      const old = [...states.values()]; states.clear();
      if (old.some(state => state.catalogValid && state.tools.length)) {
        try { onToolsChanged({ reason: 'reloaded' }); } catch {}
      }
      const closing = Promise.allSettled(old.map(closeState));
      for (const input of configured()) {
        const server = validateMcpServerConfig(input);
        const state = { server, generation, shapeHash: shapeHash(server), controller: new AbortController(), secrets: new Set(),
          status: server.enabled ? 'connecting' : 'disabled', client: null, tools: [], catalogValid: false, catalogRevision: 0,
          connectionHash: '', checkedAt: null, lastError: '', refreshTimer: null, refreshPromise: null, refreshQueued: false };
        states.set(server.id, state); track(loadCache(server, generation));
        if (server.enabled) track(closing.then(() => { if (live(state)) return connectState(state); }));
      }
      // A previously tested draft may not yet be in the applied configuration.
      for (const draft of store.getState?.().draft?.mcp?.servers || []) if (!states.has(draft.id)) track(loadCache(draft, generation));
      track(closing); return manager.status();
    },
    async ready() { while (jobs.size) await Promise.all([...jobs]); return manager.status(); },
    status() { return [...states.values()].map(state => ({ ...record(state), tools: undefined })); },
    catalog(serverId) {
      const values = new Map(cached);
      for (const state of states.values()) {
        const old = values.get(state.server.id);
        if (!old || state.catalogValid && old.connectionHash === state.connectionHash || !old.tools?.length) values.set(state.server.id, record(state));
        else if (old.connectionHash === state.connectionHash) values.set(state.server.id, { ...old, status: state.status, state: state.status, connected: false, lastError: redactText(state.lastError, state.secrets) });
      }
      const output = [...values.values()].map(copy);
      return serverId === undefined ? output : output.find(value => value.serverId === serverId) || null;
    },
    listTools() {
      return [...states.values()].flatMap(state => state.tools.flatMap(tool => {
        const policy = approval(state, tool);
        if (!policy) return [];
        return [{ id: tool.id, name: toolFunctionName(tool.id), remoteName: tool.name, serverId: state.server.id,
          description: tool.description || tool.name, effect: policy.effect, inputSchema: copy(tool.inputSchema),
          definitionHash: tool.definitionHash, connectionHash: state.connectionHash, source: 'mcp' }];
      }));
    },
    builtinBilibiliBinding(toolId) {
      const state = [...states.values()].find(item => item.tools.some(tool => tool.id === toolId));
      const tool = state?.tools.find(item => item.id === toolId);
      if (!tool || !BILIBILI_NAMES.has(tool.name) || !isBundledBilibiliServer(currentServer(state.server.id))
        || !approval(state, tool)) return null;
      return { serverId: state.server.id, connectionHash: state.connectionHash,
        definitionHash: tool.definitionHash, toolId, remoteName: tool.name };
    },
    async refresh(serverId) {
      const state = states.get(serverId);
      if (!state?.client || !live(state)) throw fail('请先启用并连接该 MCP 服务。');
      const wasValid = state.catalogValid;
      state.catalogValid = false; state.catalogRevision++;
      if (wasValid) { try { onToolsChanged({ serverId, reason: 'catalog_refresh' }); } catch {} }
      await refreshState(state); return manager.catalog(serverId);
    },
    async disconnect(serverId) {
      const state = states.get(serverId);
      if (!state) throw fail('MCP 服务不存在。', 'MCP_SERVER_NOT_FOUND', 404);
      const wasValid = state.catalogValid;
      state.catalogValid = false; state.catalogRevision++; state.status = 'disconnected'; state.lastError = '';
      if (wasValid) { try { onToolsChanged({ serverId, reason: 'disconnected' }); } catch {} }
      await closeState(state); return record(state);
    },
    test(input, { getSecret: draftGetter = getSecret, signal } = {}) {
      const operation = (async () => {
      if (closed) throw fail('MCP 管理器已关闭。', 'MCP_MANAGER_CLOSED');
      const server = validateMcpServerConfig(input), startGeneration = generation;
      const state = { server, generation: startGeneration, testing: true, controller: new AbortController(), secrets: new Set(), tools: [], status: 'tested', catalogValid: false, lastError: '', checkedAt: null };
      testControllers.add(state.controller);
      let client;
      try {
        const auth = await credentials(server, draftGetter); state.secrets = auth.secrets; state.connectionHash = auth.hash;
        await bounded(state, 'MCP 测试连接', async (combined, timeoutMs) => {
          client = await clientFactory(server, { getSecret: auth.getSecret, signal: state.controller.signal, log: (message, level) => safeLog(state, message, level), onToolsChanged() {} });
          if (combined.aborted || state.controller.signal.aborted || closed) { await client.close(); throw fail('MCP 测试已取消。', 'MCP_REQUEST_ABORTED'); }
          await client.connect({ signal: combined, timeoutMs });
          state.tools = await discover(state, client, combined, timeoutMs);
        }, { signal });
        if (closed || state.controller.signal.aborted || startGeneration !== generation) throw fail('MCP 配置已变化，测试结果已取消。', 'MCP_STALE_TEST');
        state.checkedAt = new Date().toISOString(); state.catalogValid = true;
        const active = states.get(server.id);
        if (active?.connectionHash === state.connectionHash && active.catalogValid
          && JSON.stringify(active.tools.map(tool => [tool.name, tool.definitionHash])) !== JSON.stringify(state.tools.map(tool => [tool.name, tool.definitionHash]))) toolsChanged(active);
        return await persist(state);
      } catch (cause) { throw safeError(state, cause); }
      finally { state.controller.abort(); testControllers.delete(state.controller); if (client) await Promise.resolve(client.close()).catch(() => {}); }
      })();
      track(operation); return operation;
    },
    call(toolId, args, { signal, timeoutMs } = {}) {
      const operation = (async () => {
      const state = [...states.values()].find(item => item.tools.some(tool => tool.id === toolId));
      const tool = state?.tools.find(item => item.id === toolId), policy = tool && approval(state, tool);
      if (!policy) throw fail('MCP 工具未连接、尚未审批，或定义/连接已变化。', 'MCP_TOOL_NOT_APPROVED');
      const revision = state.catalogRevision, effect = policy.effect;
      const check = signal => {
        const current = approval(state, tool);
        if (signal?.aborted || !current || state.catalogRevision !== revision || current.effect !== effect) throw fail('MCP 目录或授权已更新，旧工具请求结果已取消。', 'MCP_STALE_CALL');
      };
      try {
        return await bounded(state, 'MCP 工具调用', async (combined, limit) => {
          check(combined); const input = await validateMcpToolInput(tool.inputSchema, args, combined); check(combined);
          const result = await state.client.callTool(tool.name, input, { signal: combined, timeoutMs: limit }); check(combined);
          if (result?.isError !== true && tool.outputSchema !== undefined) {
            if (result?.structuredContent === undefined) throw fail('工具声明了输出定义，但没有返回 structuredContent。', 'MCP_OUTPUT_MISSING', 502);
            await validateMcpToolInput(tool.outputSchema, result.structuredContent, combined); check(combined);
          }
          return flattenResult(result, state.secrets);
        }, { signal, timeoutMs });
      } catch (cause) {
        const error = safeError(state, cause, toolId);
        if (effect === 'write') error.deliveryUncertain = true;
        if (state.client?.status && state.client.status().connected === false && live(state)) {
          disconnected(state, error);
        }
        throw error;
      }
      })();
      track(operation); return operation;
    },
    async close() {
      if (closed) return;
      closed = true; generation++;
      for (const controller of testControllers) controller.abort();
      testControllers.clear();
      const old = [...states.values()]; states.clear();
      await Promise.allSettled(old.map(closeState));
      while (jobs.size) await Promise.all([...jobs]);
      cached.clear(); privateKey.fill(0);
    },
  };
  return manager;
}
