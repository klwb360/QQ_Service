import { createHash } from 'node:crypto';

export const DEFAULT_CONFIG = {
  schemaVersion: 2, ownerQQ: '', botQQ: '',
  permissions: { released: false, privateReplies: false },
  qq: { enabled: false, wsUrl: 'ws://127.0.0.1:3001', webUiUrl: 'http://127.0.0.1:6099' },
  models: {
    deepseek: { enabled: false, baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', maxTokens: 1024, temperature: 0.7 },
    codex: { enabled: false, model: '', timeoutSeconds: 180 }
  },
  chat: { enabled: false, provider: 'deepseek', persona: '你是一个友好、简洁的群聊助手。', contextMessages: 12 },
  groups: [],
  summary: { enabled: false, provider: 'deepseek', scheduleEnabled: false, time: '18:00', backgroundAuthorized: false, sendToOwner: false, retentionDays: 7, maxMessages: 200 },
  favorites: { enabled: false, provider: 'deepseek', count: 50 }
};

export class ConfigError extends Error {
  constructor(details) { super('配置校验未通过'); this.details = details; this.statusCode = 400; }
}

// Only documents that explicitly identify themselves as v1 inherit the old
// permissions. A new/malformed document must never gain legacy send rights.
export function migrateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConfigError(['配置必须是 JSON 对象']);
  if (input.schemaVersion === 2) return structuredClone(input);
  if (input.schemaVersion !== 1) throw new ConfigError(['配置版本必须为 1 或 2']);
  const config = structuredClone(input);
  const connected = config.qq?.enabled === true;
  const hasRecipient = typeof config.ownerQQ === 'string' && Boolean(config.ownerQQ.trim()) && config.ownerQQ !== config.botQQ;
  return {
    ...config,
    schemaVersion: 2,
    permissions: { released: connected, privateReplies: connected && hasRecipient },
    chat: {
      ...config.chat,
      enabled: config.models?.deepseek?.enabled === true || config.models?.codex?.enabled === true,
      provider: config.models?.deepseek?.enabled === true || config.models?.codex?.enabled !== true ? 'deepseek' : 'codex',
    },
    groups: Array.isArray(config.groups) ? config.groups.map(group => group && typeof group === 'object' && !Array.isArray(group)
      ? { ...group, read: true, send: group.mode === 'social' } : group) : config.groups,
    summary: { ...config.summary, sendToOwner: config.summary?.sendToOwner ?? true },
    favorites: { ...config.favorites, provider: config.summary?.provider ?? 'deepseek' },
  };
}

export function validateConfig(input, { applying = false, hasSecret = () => false } = {}) {
  const errors = [];
  const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!object(input)) throw new ConfigError(['配置必须是 JSON 对象']);
  input = migrateConfig(input);
  const result = structuredClone(DEFAULT_CONFIG);
  const knownKeys = new Set(Object.keys(result));
  for (const key of Object.keys(input)) if (!knownKeys.has(key)) errors.push(`不支持的配置字段：${key}`);
  const string = (value, fallback, label, max = 2000) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || value.length > max) { errors.push(`${label}必须是最多 ${max} 字符的文本`); return fallback; }
    return value.trim();
  };
  const bool = (value, fallback, label) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') { errors.push(`${label}必须是开关`); return fallback; }
    return value;
  };
  const number = (value, fallback, label, min, max, integer = true) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      errors.push(`${label}须在 ${min}–${max} 之间${integer ? '且为整数' : ''}`); return fallback;
    }
    return value;
  };
  const section = (name) => {
    if (input[name] !== undefined && !object(input[name])) errors.push(`${name} 必须是对象`);
    return object(input[name]) ? input[name] : {};
  };
  const id = (value, label) => {
    const v = string(value, '', label, 20);
    if (v && !/^[1-9]\d{3,19}$/.test(v)) errors.push(`${label}须为 4–20 位数字，使用文本形式`);
    return v;
  };
  result.ownerQQ = id(input.ownerQQ, '私聊指令与汇总接收 QQ 号'); result.botQQ = id(input.botQQ, '控制的 QQ 号');
  const permissions = section('permissions');
  result.permissions.released = bool(permissions.released, false, '账号权限释放');
  result.permissions.privateReplies = bool(permissions.privateReplies, false, '私聊回复权限');
  const qq = section('qq');
  result.qq.enabled = bool(qq.enabled, false, 'QQ 接入');
  for (const [key, protocols] of [['wsUrl', ['ws:']], ['webUiUrl', ['http:']]]) {
    result.qq[key] = string(qq[key], result.qq[key], key, 300);
    try {
      const url = new URL(result.qq[key]);
      if (!protocols.includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error();
      if (key === 'wsUrl' && !['', '/'].includes(url.pathname)) throw new Error();
      if (key === 'webUiUrl' && !['', '/', '/webui', '/webui/'].includes(url.pathname)) throw new Error();
    } catch { errors.push(`${key} 必须是无凭据、查询参数的本机 ${protocols[0]} 地址`); }
  }
  const models = section('models');
  const ds = object(models.deepseek) ? models.deepseek : {};
  const cx = object(models.codex) ? models.codex : {};
  result.models.deepseek.enabled = bool(ds.enabled, false, 'DeepSeek');
  result.models.deepseek.baseUrl = string(ds.baseUrl, result.models.deepseek.baseUrl, 'DeepSeek 地址', 300).replace(/\/+$/, '');
  try {
    const url = new URL(result.models.deepseek.baseUrl);
    if (url.protocol !== 'https:' || !['api.deepseek.com'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.port) throw new Error();
    if (!['', '/', '/v1'].includes(url.pathname)) throw new Error();
  } catch { errors.push('首版 DeepSeek 仅支持 https://api.deepseek.com 或其 /v1 地址'); }
  result.models.deepseek.model = string(ds.model, 'deepseek-chat', 'DeepSeek 模型', 120);
  if (!/^[\w.:-]{1,120}$/.test(result.models.deepseek.model)) errors.push('DeepSeek 模型名称无效');
  result.models.deepseek.maxTokens = number(ds.maxTokens, 1024, '输出 token 上限', 128, 8192);
  result.models.deepseek.temperature = number(ds.temperature, 0.7, '温度', 0, 2, false);
  result.models.codex.enabled = bool(cx.enabled, false, 'GPT 订阅');
  result.models.codex.model = string(cx.model, '', 'Codex 模型', 120);
  if (result.models.codex.model && !/^[\w.:-]{1,120}$/.test(result.models.codex.model)) errors.push('Codex 模型名称无效');
  result.models.codex.timeoutSeconds = number(cx.timeoutSeconds, 180, 'GPT 超时', 30, 600);
  const chat = section('chat');
  result.chat.enabled = bool(chat.enabled, false, '聊天与回复');
  result.chat.provider = string(chat.provider, 'deepseek', '默认聊天模型', 20);
  if (!['deepseek', 'codex'].includes(result.chat.provider)) errors.push('聊天通道须为 deepseek 或 codex');
  result.chat.persona = string(chat.persona, result.chat.persona, '群聊风格', 4000);
  result.chat.contextMessages = number(chat.contextMessages, 12, '群聊上下文条数', 0, 50);
  if (!Array.isArray(input.groups)) errors.push('群列表必须是数组');
  else if (input.groups.length > 100) errors.push('首版最多配置 100 个群');
  else {
    const seen = new Set();
    result.groups = input.groups.filter(object).map((g, i) => {
      const label = `第 ${i + 1} 个群`; const groupId = id(g.id, `${label}群号`);
      if (!groupId) errors.push(`${label}请填写群号`);
      if (seen.has(groupId)) errors.push(`群号 ${groupId} 重复，不能同时作为社交群和工作群`);
      seen.add(groupId);
      if (!['social', 'work'].includes(g.mode)) errors.push(`${label}用途必须为 social 或 work`);
      if (g.trigger !== undefined && !['mention', 'prefix', 'casual'].includes(g.trigger)) errors.push(`${label}触发方式无效`);
      const read = bool(g.read, true, `${label}读取权限`);
      const send = bool(g.send, false, `${label}发送权限`);
      if (send && !read) errors.push(`${label}发送消息需要先允许读取`);
      return { id: groupId, name: string(g.name, '', `${label}名称`, 80), mode: g.mode === 'work' ? 'work' : 'social', read, send, trigger: g.trigger || 'mention', prefix: string(g.prefix, '/ai', `${label}命令前缀`, 30), probability: number(g.probability, 0.03, `${label}插话概率`, 0, 0.25, false), cooldownSeconds: number(g.cooldownSeconds, 30, `${label}冷却秒数`, 5, 3600) };
    });
    if (result.groups.length !== input.groups.length) errors.push('每个群配置必须是对象');
  }
  const summary = section('summary');
  for (const key of ['enabled', 'scheduleEnabled', 'backgroundAuthorized', 'sendToOwner']) result.summary[key] = bool(summary[key], result.summary[key], `汇总 ${key}`);
  result.summary.provider = string(summary.provider, 'deepseek', '汇总模型通道', 20);
  if (!['deepseek', 'codex'].includes(result.summary.provider)) errors.push('汇总通道须为 deepseek 或 codex');
  result.summary.time = string(summary.time, '18:00', '每日汇总时间', 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(result.summary.time)) errors.push('汇总时间须为 HH:MM');
  result.summary.retentionDays = number(summary.retentionDays, 7, '消息保留天数', 1, 90);
  result.summary.maxMessages = number(summary.maxMessages, 200, '汇总最大消息数', 1, 500);
  const favorites = section('favorites');
  result.favorites.enabled = bool(favorites.enabled, false, '收藏');
  result.favorites.provider = string(favorites.provider, 'deepseek', '收藏整理模型通道', 20);
  if (!['deepseek', 'codex'].includes(result.favorites.provider)) errors.push('收藏整理通道须为 deepseek 或 codex');
  result.favorites.count = number(favorites.count, 50, '收藏列表条数', 1, 100);
  if (applying) {
    if (result.qq.enabled && !result.botQQ) errors.push('启用 QQ 连接前请填写控制的 QQ 号');
    if (result.qq.enabled && !hasSecret('napcatToken')) errors.push('请先安装 NapCat 或填写其 OneBot Token');
    if (result.models.deepseek.enabled && !hasSecret('deepseekApiKey')) errors.push('启用 DeepSeek 前请填写 API Key');
    if (result.summary.enabled && !result.models[result.summary.provider]?.enabled) errors.push('汇总选用的模型通道尚未启用');
    if (result.summary.scheduleEnabled && (!result.summary.enabled || !result.summary.backgroundAuthorized)) errors.push('定时汇总需要启用汇总并明确授权后台执行');
    if (result.chat.enabled && !result.models[result.chat.provider]?.enabled) errors.push('聊天与回复选用的模型通道尚未启用');
    if (result.favorites.enabled && !result.qq.enabled) errors.push('读取收藏需要启用 QQ 接入');
    if (result.permissions.privateReplies || (result.summary.enabled && result.summary.sendToOwner)) {
      if (!result.ownerQQ) errors.push('启用私聊回复或发送汇总前，请填写私聊指令与汇总接收 QQ 号');
      if (result.ownerQQ && result.ownerQQ === result.botQQ) errors.push('私聊接收 QQ 号必须与控制的 QQ 号不同；同一账号可在仪表盘查看本地结果');
    }
    if (result.summary.enabled && result.summary.sendToOwner && !result.permissions.privateReplies) errors.push('发送私人汇总需要在群与消息权限中允许私聊回复');
  }
  if (errors.length) throw new ConfigError(errors);
  return result;
}

export function configHash(config) { return createHash('sha256').update(JSON.stringify(config)).digest('hex'); }
