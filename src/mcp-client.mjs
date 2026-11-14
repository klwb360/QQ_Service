import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ListToolsResultSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { mcpSecretName, validateMcpServerConfig, validateMcpServerUrl } from './mcp-config.mjs';

export const MCP_TRANSPORT_LIMIT = 2 * 1024 * 1024;
const appDirectory = fileURLToPath(new URL('../', import.meta.url));
const fail = (code, message, statusCode = 502) => Object.assign(new Error(message), { code, statusCode, status: statusCode });
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const FORBIDDEN_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'proxy-authorization',
  'mcp-session-id', 'mcp-protocol-version', 'accept', 'content-type']);

/** No shell expansion, including on Windows. npm/npx use the bundled Node CLI. */
export function resolveMcpStdioCommand(command, args = [], { platform = process.platform, nodeExecutable = process.execPath,
  appDir = appDirectory, exists = fs.existsSync, realpath = fs.realpathSync,
  isFile = candidate => fs.statSync(candidate).isFile(), environment = restrictedMcpEnvironment({ platform, nodeExecutable }) } = {}) {
  if (typeof command !== 'string' || !command.trim() || command.includes('\0') || !Array.isArray(args)
    || args.some(argument => typeof argument !== 'string' || argument.includes('\0'))) throw fail('MCP_COMMAND_INVALID', 'MCP 启动程序或参数无效。', 400);
  const actualArgs = args.map(argument => argument.replaceAll('{appDir}', appDir));
  const name = command.toLowerCase();
  if (name === 'node' || name === 'node.exe') return { command: nodeExecutable, args: actualArgs };
  if (platform === 'win32') {
    if (['npm', 'npx', 'npm.cmd', 'npx.cmd'].includes(name)) {
      const binary = name.startsWith('npx') ? 'npx-cli.js' : 'npm-cli.js';
      const cli = path.join(path.dirname(nodeExecutable), 'node_modules', 'npm', 'bin', binary);
      if (!exists(cli)) throw fail('MCP_NODE_WRAPPER_MISSING', '当前运行环境缺少配套 npm/npx。请使用应用自带 Node 环境，或选择明确的可执行程序。', 409);
      return { command: nodeExecutable, args: [cli, ...actualArgs] };
    }
    if (/\.(?:cmd|bat)$/i.test(command)) throw fail('MCP_BATCH_UNSUPPORTED', '不能直接运行未知 CMD/BAT 启动脚本。请选择真正的 EXE，或使用 node、npm、npx 及独立参数。', 400);
    // cross-spawn resolves PATHEXT and may implicitly invoke cmd.exe even with
    // shell:false. Resolve ourselves and pass only a real EXE/COM file.
    const windowsPath = path.win32;
    const extension = windowsPath.extname(command);
    if (extension && !/^\.(?:exe|com)$/i.test(extension)) throw fail('MCP_COMMAND_UNSUPPORTED', 'Windows MCP 程序必须是 EXE/COM，不能依赖脚本或批处理文件关联。', 400);
    const names = extension ? [command] : [command + '.exe', command + '.com'];
    const explicitPath = windowsPath.isAbsolute(command) || /[\\/]/.test(command);
    const directories = explicitPath ? [''] : String(environment.PATH || '').split(';').filter(Boolean);
    for (const directory of directories) for (const name of names) {
      const candidate = explicitPath ? windowsPath.resolve(appDir, name) : windowsPath.join(directory, name);
      try {
        if (!exists(candidate)) continue;
        const actual = realpath(candidate);
        if (!/^\.(?:exe|com)$/i.test(windowsPath.extname(actual)) || !isFile(actual)) continue;
        return { command: actual, args: actualArgs };
      } catch {}
    }
    throw fail('MCP_EXECUTABLE_NOT_FOUND', '未找到可直接执行的 Windows MCP 程序。请选择 EXE 的完整路径；未知 CMD/BAT 不会自动运行。', 409);
  }
  return { command, args: actualArgs };
}

/** SDK also merges its defaults, so override every inherited key explicitly. */
export function restrictedMcpEnvironment({ inherited = process.env, platform = process.platform, nodeExecutable = process.execPath } = {}) {
  const env = Object.create(null);
  for (const key of DEFAULT_INHERITED_ENV_VARS) env[key] = '';
  const allowed = platform === 'win32'
    ? ['APPDATA', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERNAME', 'USERPROFILE', 'PROGRAMFILES', 'PROGRAMDATA']
    : ['HOME', 'LOGNAME', 'USER', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ'];
  for (const key of allowed) if (typeof inherited[key] === 'string' && !inherited[key].includes('\0') && !inherited[key].startsWith('()')) env[key] = inherited[key];
  const systemRoot = env.SYSTEMROOT || 'C:\\Windows';
  const directories = platform === 'win32'
    ? [path.dirname(nodeExecutable), path.join(systemRoot, 'System32'), systemRoot]
    : [path.dirname(nodeExecutable), '/usr/local/bin', '/usr/bin', '/bin'];
  env.PATH = [...new Set(directories)].join(platform === 'win32' ? ';' : ':');
  return env;
}

/** Official SDK client. Constructing/importing descriptors never starts a process.
 * No sampling, elicitation, roots or task capability is advertised or handled.
 */
export function createMcpClient(input, { getSecret = () => '', log = () => {}, signal: lifecycleSignal,
  onToolsChanged = () => {}, onClose = () => {}, fetchImpl = globalThis.fetch } = {}) {
  const descriptor = validateMcpServerConfig(input);
  const timeoutDefault = descriptor.timeoutSeconds * 1000;
  let client = null, transport = null, phase = 'idle', lastError = '', closePromise = null, connectionPromise = null;
  let serverInfo = null, toolsChangedAt = null, attempt = 0;
  const secrets = new Set(), operations = new Set();
  let networkController = new AbortController();
  const redact = message => {
    let text = String(message || 'MCP 操作失败。');
    for (const value of [...secrets].sort((a, b) => b.length - a.length)) if (value) text = text.split(value).join('[已隐藏]');
    return text.replace(/(Bearer\s+)[^\s"']+/gi, '$1[已隐藏]').slice(0, 600);
  };
  const safeError = (error, fallback = 'MCP_REQUEST_FAILED') => fail(typeof error?.code === 'string' && error.code.startsWith('MCP_') ? error.code : fallback, redact(error?.message || error), error?.statusCode || 502);
  const report = message => { try { log(redact(message)); } catch {} };
  const status = () => ({ state: phase, connected: phase === 'connected', transport: descriptor.transport,
    serverInfo: serverInfo ? { ...serverInfo } : null, toolsChangedAt, lastError, pid: transport instanceof StdioClientTransport ? transport.pid : null });

  const shutdown = async ({ terminal = false, error, terminate = false } = {}) => {
    if (closePromise) { if (terminal) phase = 'closed'; return closePromise; }
    let finish;
    const closing = new Promise(resolve => { finish = resolve; });
    closePromise = closing;
    if (terminal) phase = 'closed'; else if (error && phase !== 'closed') { phase = 'error'; lastError = redact(error.message || error); }
    else if (phase !== 'closed') phase = 'disconnected';
    const oldClient = client, oldTransport = transport;
    client = null; transport = null; connectionPromise = null;
    if (!terminal) {
      try { Promise.resolve(onClose(error ? safeError(error) : undefined)).catch(cause => report(cause.message)); }
      catch (cause) { report(cause.message); }
    }
    for (const operation of operations) operation.abort();
    try {
      if (terminate && oldTransport instanceof StreamableHTTPClientTransport && oldTransport.sessionId && !networkController.signal.aborted) {
        let timer;
        await Promise.race([oldTransport.terminateSession().catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 1000); timer.unref?.(); })]);
        clearTimeout(timer);
      }
      networkController.abort();
      try { await oldClient?.close(); } catch {}
      try { await oldTransport?.close(); } catch {}
    } finally { closePromise = null; finish(); }
  };

  const lifecycleAbort = () => { void shutdown({ terminal: true }); };
  lifecycleSignal?.addEventListener('abort', lifecycleAbort, { once: true });

  async function readSecret(kind, key) {
    const value = await getSecret(mcpSecretName(descriptor.id, kind, key));
    if (typeof value !== 'string' || !value || value.includes('\0')) throw fail('MCP_SECRET_MISSING', `请填写本 MCP 服务的 ${kind === 'env' ? '环境变量' : '请求头'} ${key}。`, 409);
    secrets.add(value); return value;
  }

  function guardedFetch(base, headers) {
    const posted = new Set();
    let streams = 0;
    return async (resource, init = {}) => {
      const target = new URL(typeof resource === 'string' || resource instanceof URL ? resource : resource.url, base);
      if (target.origin !== base.origin || target.username || target.password || target.hash) throw fail('MCP_ENDPOINT_REJECTED', 'MCP 连接端点离开了已配置的来源，已拒绝发送凭据。');
      if (networkController.signal.aborted) throw fail('MCP_CANCELLED', 'MCP 会话已关闭。', 409);
      const method = String(init.method || (resource instanceof Request ? resource.method : 'GET')).toUpperCase();
      if (method === 'GET' && ++streams > 1) throw fail('MCP_RECONNECT_DISABLED', 'MCP 事件流已断开，请手动重新连接；不会自动恢复或重放请求。');
      if (method === 'POST' && typeof init.body === 'string') {
        if (Buffer.byteLength(init.body) > MCP_TRANSPORT_LIMIT) throw fail('MCP_REQUEST_TOO_LARGE', 'MCP 请求超过2 MiB限制。', 400);
        let message; try { message = JSON.parse(init.body); } catch { throw fail('MCP_REQUEST_INVALID', 'MCP 请求必须是有效 JSON。', 400); }
        if (message?.id !== undefined) {
          const identity = `${typeof message.id}:${message.id}`;
          if (posted.has(identity)) throw fail('MCP_RETRY_DISABLED', '同一个 MCP 请求不能自动重复提交。');
          posted.add(identity);
          if (posted.size > 10_000) throw fail('MCP_SESSION_LIMIT', 'MCP 会话请求数量达到限制，请手动重新连接。');
        }
      }
      const mergedHeaders = new Headers(init.headers || {});
      for (const [name, value] of headers) mergedHeaders.set(name, value);
      const signals = [networkController.signal, init.signal].filter(Boolean);
      const response = await fetchImpl(target, { ...init, headers: mergedHeaders, redirect: 'error', signal: AbortSignal.any(signals) });
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw fail('MCP_REDIRECT_REJECTED', 'MCP 服务返回重定向，已拒绝跟随。'); }
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MCP_TRANSPORT_LIMIT) { await response.body?.cancel(); throw fail('MCP_RESPONSE_TOO_LARGE', 'MCP 响应超过2 MiB限制。'); }
      if (!response.body) return response;
      const reader = response.body.getReader(); let size = 0;
      const bounded = new ReadableStream({
        async pull(controller) {
          try {
            const result = await reader.read();
            if (result.done) { reader.releaseLock(); controller.close(); return; }
            size += result.value.byteLength;
            if (size > MCP_TRANSPORT_LIMIT) { await reader.cancel(); reader.releaseLock(); controller.error(fail('MCP_RESPONSE_TOO_LARGE', 'MCP 响应或事件流超过2 MiB限制。')); return; }
            controller.enqueue(result.value);
          } catch (error) { controller.error(error); }
        },
        async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } },
      });
      return new Response(bounded, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
  }

  async function boundedOperation(label, operation, { signal, timeoutMs = timeoutDefault, duringConnect = false, write = false } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw fail('MCP_TIMEOUT_INVALID', 'MCP 超时设置无效。', 400);
    if (lifecycleSignal?.aborted || signal?.aborted || phase === 'closed') throw fail('MCP_CANCELLED', 'MCP 操作已取消。', 409);
    if (!duringConnect && phase !== 'connected') throw fail('MCP_NOT_CONNECTED', '请先连接当前 MCP 服务。', 409);
    const controller = new AbortController(); operations.add(controller);
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : []), ...(lifecycleSignal ? [lifecycleSignal] : [])]);
    let timer, timedOut = false, completed = false, started = false;
    const cancelled = new Promise((_, reject) => {
      const abort = () => {
        const issue = fail(timedOut ? 'MCP_TIMEOUT' : 'MCP_CANCELLED', timedOut ? `MCP ${label}超过设定时限。` : 'MCP 操作已取消。', 409);
        if (write && started) issue.deliveryUncertain = true;
        reject(issue);
        if (!completed) void shutdown({ error: issue });
      };
      combined.addEventListener('abort', abort, { once: true });
      controller.cleanup = () => combined.removeEventListener('abort', abort);
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs); timer.unref?.();
    });
    try {
      started = true;
      const result = await Promise.race([operation({ signal: combined, timeout: timeoutMs, maxTotalTimeout: timeoutMs,
        resetTimeoutOnProgress: false, onprogress: () => {} }), cancelled]);
      if (combined.aborted) throw fail('MCP_CANCELLED', 'MCP 操作已取消。', 409);
      if (bytes(result) > MCP_TRANSPORT_LIMIT) throw fail('MCP_RESPONSE_TOO_LARGE', 'MCP 返回内容超过2 MiB限制。');
      return result;
    } catch (error) {
      const issue = safeError(error);
      if (write && started && (error?.deliveryUncertain || combined.aborted || error?.code !== -32602)) issue.deliveryUncertain = true;
      if (combined.aborted || error?.code === 'MCP_RESPONSE_TOO_LARGE') await shutdown({ error: issue });
      throw issue;
    } finally {
      completed = true; clearTimeout(timer); controller.cleanup?.(); operations.delete(controller);
    }
  }

  function connect(options = {}) {
    if (phase === 'connected') return Promise.resolve(status());
    if (phase === 'closed' || lifecycleSignal?.aborted) return Promise.reject(fail('MCP_CANCELLED', 'MCP 会话已关闭。', 409));
    if (connectionPromise) return connectionPromise;
    const work = beginConnect(options);
    connectionPromise = work;
    work.finally(() => { if (connectionPromise === work) connectionPromise = null; }).catch(() => {});
    return work;
  }

  async function beginConnect(options) {
    await closePromise;
    if (phase === 'closed' || lifecycleSignal?.aborted) throw fail('MCP_CANCELLED', 'MCP 会话已关闭。', 409);
    phase = 'connecting'; lastError = ''; networkController = new AbortController(); const currentAttempt = ++attempt;
    const work = boundedOperation('连接', async requestOptions => {
      const session = new Client({ name: 'QQ_Service', version: '0.8.0' }, { capabilities: {} });
      client = session;
      session.onclose = () => {
        if (client === session && !['closed', 'error', 'disconnected'].includes(phase)) void shutdown({ error: fail('MCP_CONNECTION_CLOSED', 'MCP 连接已关闭，请手动重新连接。') });
      };
      session.onerror = error => {
        if (client !== session) return;
        const issue = safeError(error, 'MCP_TRANSPORT_ERROR'); report(issue.message);
        void shutdown({ error: issue });
      };
      session.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        if (client !== session) return;
        toolsChangedAt = new Date().toISOString();
        Promise.resolve().then(() => onToolsChanged()).catch(error => report(error.message));
      });
      if (descriptor.transport === 'stdio') {
        const executable = resolveMcpStdioCommand(descriptor.command, descriptor.args);
        const env = restrictedMcpEnvironment();
        for (const name of descriptor.envKeys) env[name] = await readSecret('env', name);
        transport = new StdioClientTransport({ ...executable, env, cwd: appDirectory, stderr: 'pipe', maxBufferSize: MCP_TRANSPORT_LIMIT });
        let stderrBytes = 0;
        transport.stderr?.on('data', chunk => {
          // Drain stderr continuously but do not persist arbitrary server output
          // or secret values in the dashboard logs.
          stderrBytes += chunk.length;
          if (stderrBytes > MCP_TRANSPORT_LIMIT) { void shutdown({ error: fail('MCP_STDERR_TOO_LARGE', 'MCP 服务错误输出过多，已关闭连接。') }); }
        });
      } else {
        const url = new URL(validateMcpServerUrl(descriptor.url));
        const headers = new Headers();
        for (const name of descriptor.headerKeys) {
          if (FORBIDDEN_HEADERS.has(name.toLowerCase())) throw fail('MCP_HEADER_RESERVED', '自定义 MCP 请求头不能覆盖传输或会话协议字段。', 400);
          const value = await readSecret('header', name);
          if (/[\r\n]/.test(value)) throw fail('MCP_HEADER_INVALID', 'MCP 请求头不能包含换行。', 400);
          headers.set(name, value);
        }
        const fetch = guardedFetch(url, headers), requestInit = { headers, redirect: 'error' };
        transport = descriptor.transport === 'http'
          ? new StreamableHTTPClientTransport(url, { fetch, requestInit, reconnectionOptions: {
            maxRetries: 0, maxReconnectionDelay: 0, initialReconnectionDelay: 0, reconnectionDelayGrowFactor: 1,
          } })
          : new SSEClientTransport(url, { fetch, requestInit, eventSourceInit: { fetch } });
      }
      if (requestOptions.signal.aborted || currentAttempt !== attempt) throw fail('MCP_CANCELLED', 'MCP 连接已取消。', 409);
      const currentTransport = transport;
      await session.connect(currentTransport, requestOptions);
      if (client !== session || requestOptions.signal.aborted || currentAttempt !== attempt) throw fail('MCP_CANCELLED', 'MCP 连接已取消。', 409);
      const version = session.getServerVersion();
      serverInfo = version ? { name: redact(version.name).slice(0, 100), version: redact(version.version).slice(0, 100) } : null;
      phase = 'connected'; return status();
    }, { ...options, duringConnect: true });
    try { return await work; } catch (error) { if (currentAttempt === attempt) await shutdown({ error }); throw error; }
  }

  return {
    connect, status,
    async listTools(options = {}) {
      return boundedOperation('工具目录读取', async requestOptions => {
        const session = client, tools = [], cursors = new Set(); let cursor;
        do {
          // Client.listTools synchronously compiles remote outputSchema on the
          // main thread. The manager owns schema compilation in its worker.
          const result = await session.request({ method: 'tools/list', params: cursor ? { cursor } : {} }, ListToolsResultSchema, requestOptions);
          tools.push(...result.tools);
          if (tools.length > 200 || bytes(tools) > MCP_TRANSPORT_LIMIT) throw fail('MCP_CATALOG_TOO_LARGE', 'MCP 工具目录超过200项或2 MiB限制。');
          cursor = result.nextCursor;
          if (cursor && (typeof cursor !== 'string' || cursor.length > 1024 || cursors.has(cursor))) throw fail('MCP_CURSOR_INVALID', 'MCP 工具目录分页游标无效或重复。');
          if (cursor) cursors.add(cursor);
        } while (cursor);
        return tools;
      }, options);
    },
    async callTool(name, args = {}, options = {}) {
      if (typeof name !== 'string' || !name.trim() || name.length > 256 || !args || typeof args !== 'object' || Array.isArray(args)
        || bytes(args) > MCP_TRANSPORT_LIMIT) throw fail('MCP_TOOL_INVALID', 'MCP 工具名称或参数无效。', 400);
      return boundedOperation('工具调用', requestOptions => client.callTool({ name, arguments: args }, undefined, requestOptions), { ...options, write: true });
    },
    async close() { attempt++; lifecycleSignal?.removeEventListener('abort', lifecycleAbort); await shutdown({ terminal: true, terminate: true }); },
  };
}
