import { createHash } from 'node:crypto';

const MAX_CONFIG_BYTES = 512 * 1024;
const MAX_SERVERS = 20;
const MAX_TOOLS = 200;
const own = (value, key) => Object.hasOwn(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = message => Object.assign(new Error(message), { statusCode: 400, code: 'MCP_CONFIG_INVALID' });
const validServerId = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
const envKey = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value);
const headerKey = value => typeof value === 'string' && /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(value);
const printable = value => typeof value === 'string' && Boolean(value.trim()) && !/[\u0000-\u001f\u007f]/u.test(value);
const dangerous = new Set(['__proto__', 'constructor', 'prototype']);

// Importing configuration is data processing only. Inspect descriptors before
// reading values, and never call an imported object's getters or toJSON method.
function cloneJson(value, maxBytes = MAX_CONFIG_BYTES) {
  const ancestors = new Set();
  let nodes = 0, bytes = 0;
  const add = value => { bytes += value; if (bytes > maxBytes) throw fail('MCP 配置或工具定义超过大小限制。'); };
  const visit = (item, depth) => {
    if (++nodes > 20000 || depth > 32) throw fail('MCP 配置或工具定义嵌套过深、项目过多。');
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) { add(16); return item; }
    if (typeof item === 'string') { add(Buffer.byteLength(item, 'utf8') + 2); return item; }
    if ((!Array.isArray(item) && !plain(item)) || ancestors.has(item) || Object.getOwnPropertySymbols(item).length) throw fail('MCP 配置必须为无循环的纯 JSON 数据。');
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item), keys = Object.keys(item);
    if (Array.isArray(item) && (keys.length !== item.length || keys.some((key, index) => key !== String(index)))) throw fail('MCP 配置数组格式无效。');
    const result = Array.isArray(item) ? [] : {};
    add(2);
    for (const key of keys) {
      if (dangerous.has(key) || !own(descriptors[key], 'value')) throw fail('MCP 配置不能包含动态或危险字段。');
      add(Buffer.byteLength(key, 'utf8') + 3);
      result[key] = visit(descriptors[key].value, depth + 1);
    }
    ancestors.delete(item);
    return result;
  };
  return visit(value, 0);
}
const keysOnly = (value, allowed, label) => {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fail(`${label}包含无效字段。`);
};
const boundedString = (value, max, label, { optional = false, trim = true } = {}) => {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw fail(`${label}格式或长度无效。`);
  return trim ? value.trim() : value;
};
const remoteName = value => {
  if (!printable(value) || value.length > 256) throw fail('MCP 工具名称须为 1–256 个可显示字符。');
  return value;
};

export function mcpToolId(serverId, name) {
  if (!validServerId(serverId)) throw fail('MCP 服务标识无效。');
  remoteName(name);
  return `mcp:${serverId}/${createHash('sha256').update(name).digest('hex').slice(0, 24)}`;
}

export function mcpDefinitionHash(definition) {
  const value = cloneJson(definition, 256 * 1024);
  if (!plain(value)) throw fail('MCP 工具定义须为对象。');
  const canonical = item => Array.isArray(item) ? item.map(canonical) : plain(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export const mcpToolDefinitionHash = mcpDefinitionHash;

export function mcpSecretName(serverId, kind, key) {
  if (!validServerId(serverId) || !['env', 'header'].includes(kind)
    || !(kind === 'env' ? envKey(key) : headerKey(key))) throw fail('MCP 凭据名称无效。');
  return `mcpSecret:${serverId}:${kind}:${kind === 'header' ? key.toLowerCase() : key}`;
}

export function parseMcpSecretName(value) {
  if (typeof value !== 'string') return null;
  const match = /^mcpSecret:([a-z][a-z0-9-]{0,63}):(env|header):([^:]+)$/.exec(value);
  if (!match || !(match[2] === 'env' ? envKey(match[3]) : headerKey(match[3]))
    || (match[2] === 'header' && match[3] !== match[3].toLowerCase())) return null;
  return { serverId: match[1], kind: match[2], key: match[3] };
}

function keyList(value, kind) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50 || value.some(key => !(kind === 'env' ? envKey(key) : headerKey(key)))) throw fail(`MCP ${kind === 'env' ? '环境变量' : '请求头'}只能保存最多 50 个名称，值须放入凭据库。`);
  const keys = value.map(key => kind === 'header' ? key.toLowerCase() : key);
  if (new Set(keys).size !== keys.length) throw fail('MCP 凭据名称不能重复。');
  return keys;
}
export function validateMcpServerUrl(value) {
  const text = boundedString(value, 4096, 'MCP 服务地址');
  let url;
  try { url = new URL(text); } catch { throw fail('MCP 服务地址须为完整 HTTP(S) URL。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw fail('MCP 服务地址仅支持无用户名、密码和片段的 HTTP(S) URL。');
  const credentialKeys = new Set(['key', 'apikey', 'token', 'accesstoken', 'refreshtoken', 'secret', 'password', 'authorization', 'auth', 'session', 'sessionid', 'sid']);
  if ([...url.searchParams.keys()].some(key => {
    const normalized = key.replace(/[-_]/g, '').toLowerCase();
    return credentialKeys.has(normalized) || /token|secret|password|authorization|apikey|credential|sessionid/.test(normalized);
  })) throw fail('MCP 地址中的密钥或会话标识请改为独立请求头凭据，避免配置导出泄露。');
  const hostname = url.hostname.toLowerCase();
  const loopback = ['localhost', '[::1]'].includes(hostname) || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(hostname);
  const deploymentHosts = process.env.QQ_SERVICE_CONTAINER === '1'
    ? (process.env.QQ_SERVICE_MCP_HOSTS || '').split(',').map(host => host.trim().toLowerCase())
      .filter(host => /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) : [];
  if (url.protocol === 'http:' && !loopback && !deploymentHosts.includes(hostname)) throw fail('远程 MCP 服务须使用 HTTPS；容器内部 HTTP 服务需由部署环境显式允许。');
  return url.href;
}
export const validateMcpUrl = validateMcpServerUrl;

export function validateMcpServerConfig(input) {
  const value = cloneJson(input);
  keysOnly(value, ['id', 'label', 'enabled', 'transport', 'command', 'args', 'url', 'envKeys', 'headerKeys', 'timeoutSeconds', 'tools'], 'MCP 服务');
  if (!validServerId(value.id)) throw fail('MCP 服务标识须为小写字母开头的 1–64 位字母、数字或连字符。');
  const label = value.label === undefined ? value.id : boundedString(value.label, 100, 'MCP 显示名称');
  if (!printable(label)) throw fail('MCP 显示名称须为可显示文本。');
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw fail('MCP 服务启用状态须为开关。');
  if (!['stdio', 'http', 'sse'].includes(value.transport)) throw fail('MCP 连接方式须为 stdio、http 或 sse。');
  const command = boundedString(value.command, 1024, 'MCP 启动程序', { optional: true });
  const args = value.args === undefined ? [] : value.args;
  if (!Array.isArray(args) || args.length > 100 || args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))
    || args.reduce((total, arg) => total + arg.length, 0) > 32 * 1024) throw fail('MCP 启动参数须为最多 100 项的文字数组，总长最多 32 KiB。');
  const envKeys = keyList(value.envKeys, 'env'), headerKeys = keyList(value.headerKeys, 'header');
  const url = value.transport === 'stdio' ? boundedString(value.url, 4096, 'MCP 服务地址', { optional: true }) : validateMcpServerUrl(value.url);
  if (value.transport === 'stdio' ? !printable(command) || Boolean(url) || headerKeys.length
    : Boolean(command) || args.length || envKeys.length) throw fail('stdio 只使用程序、参数和环境变量；HTTP/SSE 只使用 URL 和请求头。');
  const timeoutSeconds = value.timeoutSeconds ?? 30;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) throw fail('MCP 超时须为 1–300 秒。');
  if (value.tools !== undefined && (!Array.isArray(value.tools) || value.tools.length > MAX_TOOLS)) throw fail(`每个 MCP 服务最多保存 ${MAX_TOOLS} 项工具授权。`);
  const seen = new Set();
  const tools = (value.tools || []).map(tool => {
    keysOnly(tool, ['name', 'enabled', 'effect', 'definitionHash', 'connectionHash'], 'MCP 工具授权');
    const name = remoteName(tool.name);
    if (seen.has(name)) throw fail('MCP 工具名称不能重复。');
    seen.add(name);
    if (tool.enabled !== undefined && typeof tool.enabled !== 'boolean') throw fail('MCP 工具启用状态须为开关。');
    const effect = tool.effect ?? 'write';
    if (!['read', 'write'].includes(effect)) throw fail('MCP 工具效果须为 read 或 write。');
    const definitionHash = tool.definitionHash ?? '';
    if (typeof definitionHash !== 'string' || (definitionHash !== '' && !/^[a-f0-9]{64}$/.test(definitionHash))) throw fail('MCP 工具定义摘要无效。');
    const connectionHash = tool.connectionHash ?? '';
    if (typeof connectionHash !== 'string' || (connectionHash !== '' && !/^[a-f0-9]{64}$/.test(connectionHash))) throw fail('MCP 连接审批摘要无效。');
    if (tool.enabled && (!definitionHash || !connectionHash)) throw fail('启用 MCP 工具前须先发现并确认工具定义及当前连接。');
    return { name, enabled: tool.enabled === true, effect, definitionHash, connectionHash };
  });
  return { id: value.id, label, enabled: value.enabled === true, transport: value.transport,
    command, args: [...args], url, envKeys, headerKeys, timeoutSeconds, tools };
}

/** Public connection shape for the host's private-key HMAC. This is not an
 * approval hash by itself: the host must also include this server's secrets. */
export function mcpConnectionDescriptor(input) {
  const server = validateMcpServerConfig(input);
  return { id: server.id, transport: server.transport, command: server.command, args: [...server.args], url: server.url,
    envKeys: [...server.envKeys].sort(), headerKeys: [...server.headerKeys].sort() };
}
export const canonicalMcpConnection = mcpConnectionDescriptor;

export function validateMcpConfig(input = { servers: [] }) {
  const value = cloneJson(input);
  keysOnly(value, ['servers'], 'MCP 配置');
  if (!Array.isArray(value.servers) || value.servers.length > MAX_SERVERS) throw fail(`MCP 配置须包含最多 ${MAX_SERVERS} 项 servers。`);
  const servers = value.servers.map(validateMcpServerConfig);
  if (new Set(servers.map(server => server.id)).size !== servers.length) throw fail('MCP 服务标识不能重复。');
  return { servers };
}

const importId = label => {
  if (validServerId(label)) return label;
  const slug = label.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 42);
  return `${/^[a-z]/.test(slug) ? slug : `server-${slug || 'mcp'}`}-${createHash('sha256').update(label).digest('hex').slice(0, 10)}`;
};

/** Parse common MCP client exports without executing, installing or connecting.
 * Literal env/header values leave the public descriptor and become vault updates. */
export function importMcpConfig(input) {
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > MAX_CONFIG_BYTES) throw fail('MCP 导入文件最多 512 KiB。');
    try { input = JSON.parse(input); } catch { throw fail('MCP 导入内容不是有效 JSON。'); }
  }
  const value = cloneJson(input), secretUpdates = {};
  let entries;
  if (Array.isArray(value)) entries = value.map((server, index) => [server?.label || server?.id || `server-${index + 1}`, server]);
  else if (plain(value) && own(value, 'mcpServers')) {
    keysOnly(value, ['mcpServers'], 'MCP 导入文件');
    if (!plain(value.mcpServers)) throw fail('mcpServers 须为服务名称到配置的映射。');
    entries = Object.entries(value.mcpServers);
  } else if (plain(value) && Array.isArray(value.servers)) { keysOnly(value, ['servers'], 'MCP 导入文件'); entries = value.servers.map((server, index) => [server?.label || server?.id || `server-${index + 1}`, server]); }
  else throw fail('请导入 mcpServers 映射或 servers 配置列表。');
  if (entries.length > MAX_SERVERS) throw fail(`一次最多导入 ${MAX_SERVERS} 项 MCP 服务。`);
  const servers = entries.map(([label, server]) => {
    if (!printable(label) || label.length > 100) throw fail('导入 MCP 服务名称无效。');
    keysOnly(server, ['id', 'label', 'enabled', 'transport', 'type', 'command', 'args', 'url', 'env', 'headers', 'envKeys', 'headerKeys', 'timeoutSeconds', 'tools'], '导入 MCP 服务');
    const id = server.id ?? importId(label);
    if (!validServerId(id)) throw fail('导入 MCP 服务标识无效。');
    const envKeys = keyList(server.envKeys, 'env'), headerKeys = keyList(server.headerKeys, 'header');
    const credentials = (values, kind, declared) => {
      if (values === undefined) return;
      if (Array.isArray(values)) { for (const key of keyList(values, kind)) if (!declared.includes(key)) declared.push(key); return; }
      if (!plain(values) || Object.keys(values).length > 50) throw fail('MCP 凭据须为名称与文字值的映射。');
      const seen = new Set();
      for (const [name, secret] of Object.entries(values)) {
        const key = kind === 'header' ? name.toLowerCase() : name;
        const secretName = mcpSecretName(id, kind, key);
        if (seen.has(key)) throw fail('MCP 请求头凭据不能重复。');
        seen.add(key);
        if (typeof secret !== 'string' || secret.length > 16384 || secret.includes('\0') || (kind === 'header' && /[\r\n]/.test(secret))) throw fail('MCP 凭据须为长度有效的文字；请求头不能包含换行。');
        if (!declared.includes(key)) declared.push(key);
        if (secret) secretUpdates[secretName] = secret;
      }
    };
    credentials(server.env, 'env', envKeys); credentials(server.headers, 'header', headerKeys);
    const declaredTransport = server.transport ?? server.type;
    const transport = declaredTransport === 'streamable-http' || declaredTransport === 'streamableHttp' ? 'http'
      : declaredTransport ?? (server.url ? 'http' : 'stdio');
    if (server.tools !== undefined && !Array.isArray(server.tools)) throw fail('导入 MCP 工具授权须为列表。');
    const tools = (server.tools || []).map(tool => {
      if (!plain(tool)) throw fail('导入 MCP 工具授权须为对象。');
      return { name: remoteName(tool.name), enabled: false, effect: 'write', definitionHash: '', connectionHash: '' };
    });
    return validateMcpServerConfig({ id, label: server.label ?? label, enabled: false, transport,
      command: server.command ?? '', args: server.args ?? [], url: server.url ?? '', envKeys, headerKeys,
      timeoutSeconds: server.timeoutSeconds ?? 30, tools });
  });
  return { servers: validateMcpConfig({ servers }).servers, secretUpdates };
}
