import { createHash } from 'node:crypto';

export const DEFAULT_CONFIG = {
  schemaVersion: 2, ownerQQ: '', botQQ: '',
  permissions: { released: false, privateReplies: false },
  qq: { enabled: false, wsUrl: 'ws://127.0.0.1:3001', webUiUrl: 'http://127.0.0.1:6099' },
  models: {
    deepseek: { enabled: false, baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', maxTokens: 1024, temperature: 0.7 },
    codex: { enabled: false, model: '', timeoutSeconds: 180 },
    apis: []
  },
  chat: { enabled: false, provider: 'deepseek', persona: '你是一个友好、简洁的群聊助手。', contextMessages: 12 },
  groups: [],
  plugins: [],
  tools: { enabled: false, triggers: ['mention', 'poke', 'name'], aliases: [], prefix: '/工具', skill: '', grants: [] },
  summary: { enabled: false, provider: 'deepseek', scheduleEnabled: false, time: '18:00', backgroundAuthorized: false, sendToOwner: false, retentionDays: 7, maxMessages: 200 },
  favorites: { enabled: false, provider: 'deepseek', count: 50 }
};

export class ConfigError extends Error {
  constructor(details) {
    super('配置校验未通过');
    this.issues = details.map(detail => typeof detail === 'string'
      ? { path: 'config', message: detail, action: '请检查对应配置后重试。' }
      : { path: detail.path || 'config', message: detail.message, action: detail.action || '请检查此项配置后重试。' });
    this.details = this.issues.map(issue => issue.message);
    this.statusCode = 400;
  }
}

export const isApiProviderId = value => typeof value === 'string' && /^api_[A-Za-z0-9_-]{1,64}$/.test(value);
export const apiSecretName = id => {
  if (!isApiProviderId(id)) throw new TypeError('API 通道标识无效');
  return `apiKey:${id}`;
};
export function parsePluginSecretName(value) {
  const match = typeof value === 'string' && value.match(/^pluginSecret:([a-z][a-z0-9-]{0,63}):([A-Za-z][A-Za-z0-9_]{0,63})$/);
  return match && !['constructor', 'prototype', '__proto__'].includes(match[2]) ? { pluginId: match[1], key: match[2] } : null;
}
export const pluginSecretName = (id, key) => {
  const name = `pluginSecret:${id}:${key}`;
  if (!parsePluginSecretName(name)) throw new TypeError('插件凭据名称无效');
  return name;
};
export const isCredentialName = value => value === 'deepseekApiKey' || value === 'napcatToken'
  || Boolean(parsePluginSecretName(value)) || (typeof value === 'string' && value.startsWith('apiKey:') && isApiProviderId(value.slice(7)));
export function getModelConfig(config, provider) {
  if (provider === 'deepseek' || provider === 'codex') return config?.models?.[provider];
  return isApiProviderId(provider) && Array.isArray(config?.models?.apis)
    ? config.models.apis.find(api => api.id === provider) : undefined;
}

export const GROUP_TRIGGER_IDS = Object.freeze(['mention', 'prefix', 'casual', 'poke', 'group_name', 'member_join', 'member_leave', 'admin_change', 'mute', 'recall', 'group_card', 'emoji_like']);
const LEGACY_GROUP_TRIGGERS = ['mention', 'prefix', 'casual'];
export function effectiveGroupTriggers(group) {
  if (Array.isArray(group?.triggers)) return [...new Set(group.triggers.filter(trigger => GROUP_TRIGGER_IDS.includes(trigger)))];
  // An explicitly malformed selection must never silently grant a trigger.
  if (group?.triggers !== undefined) return [];
  return LEGACY_GROUP_TRIGGERS.includes(group?.trigger) ? [group.trigger] : ['mention'];
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
  const issue = (path, message, action) => errors.push({ path, message, action });
  const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!object(input)) throw new ConfigError(['配置必须是 JSON 对象']);
  input = migrateConfig(input);
  const result = structuredClone(DEFAULT_CONFIG);
  const knownKeys = new Set(Object.keys(result));
  for (const key of Object.keys(input)) if (!knownKeys.has(key)) issue(key, `不支持的配置字段：${key}`, '请通过界面重新保存配置，或移除此字段。');
  const string = (value, fallback, label, max = 2000, path = 'config') => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || value.length > max) { issue(path, `${label}必须是最多 ${max} 字符的文本`, '请缩短此字段，并使用文本格式。'); return fallback; }
    return value.trim();
  };
  const bool = (value, fallback, label, path = 'config') => {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') { issue(path, `${label}必须是开关`, '请使用界面上的开关设置此项。'); return fallback; }
    return value;
  };
  const number = (value, fallback, label, min, max, integer = true, path = 'config') => {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      issue(path, `${label}须在 ${min}–${max} 之间${integer ? '且为整数' : ''}`, `请填写 ${min}–${max} 范围内的数值。`); return fallback;
    }
    return value;
  };
  const section = (name) => {
    if (input[name] !== undefined && !object(input[name])) issue(name, `${name} 必须是对象`, '请通过界面重新保存此项配置。');
    return object(input[name]) ? input[name] : {};
  };
  const id = (value, label, path = 'config') => {
    const v = string(value, '', label, 20, path);
    if (v && !/^[1-9]\d{3,19}$/.test(v)) issue(path, `${label}须为 4–20 位数字，使用文本形式`, '请填写 QQ 号码或群号，不要填写昵称。');
    return v;
  };
  result.ownerQQ = id(input.ownerQQ, '私聊指令与汇总接收 QQ 号', 'ownerQQ'); result.botQQ = id(input.botQQ, '控制的 QQ 号', 'botQQ');
  const permissions = section('permissions');
  result.permissions.released = bool(permissions.released, false, '账号权限释放', 'permissions.released');
  result.permissions.privateReplies = bool(permissions.privateReplies, false, '私聊回复权限', 'permissions.privateReplies');
  const qq = section('qq');
  result.qq.enabled = bool(qq.enabled, false, 'QQ 接入', 'qq.enabled');
  for (const [key, protocols] of [['wsUrl', ['ws:']], ['webUiUrl', ['http:']]]) {
    result.qq[key] = string(qq[key], result.qq[key], key, 300, `qq.${key}`);
    try {
      const url = new URL(result.qq[key]);
      if (!protocols.includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error();
      if (key === 'wsUrl' && !['', '/'].includes(url.pathname)) throw new Error();
      if (key === 'webUiUrl' && !['', '/', '/webui', '/webui/'].includes(url.pathname)) throw new Error();
    } catch { issue(`qq.${key}`, `${key} 必须是无凭据、查询参数的本机 ${protocols[0]} 地址`, key === 'wsUrl' ? '在 NapCat 的 OneBot 服务中启用正向 WebSocket，再复制本机地址；Token 请填写在独立的凭据栏。' : '请填写 NapCat 本机 WebUI 地址，例如 http://127.0.0.1:6099。'); }
  }
  const models = section('models');
  for (const key of ['deepseek', 'codex']) if (models[key] !== undefined && !object(models[key])) issue(`models.${key}`, `${key} 模型配置必须是对象`, '请通过模型设置重新保存此通道。');
  const ds = object(models.deepseek) ? models.deepseek : {};
  const cx = object(models.codex) ? models.codex : {};
  result.models.deepseek.enabled = bool(ds.enabled, false, 'DeepSeek', 'models.deepseek.enabled');
  result.models.deepseek.baseUrl = string(ds.baseUrl, result.models.deepseek.baseUrl, 'DeepSeek 地址', 300, 'models.deepseek.baseUrl').replace(/\/+$/, '');
  try {
    const url = new URL(result.models.deepseek.baseUrl);
    if (url.protocol !== 'https:' || !['api.deepseek.com'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.port) throw new Error();
    if (!['', '/', '/v1'].includes(url.pathname)) throw new Error();
  } catch { issue('models.deepseek.baseUrl', 'DeepSeek 官方通道仅支持 https://api.deepseek.com 或其 /v1 地址', '其他厂商或中转服务请添加“兼容 API”通道。'); }
  result.models.deepseek.model = string(ds.model, 'deepseek-chat', 'DeepSeek 模型', 120, 'models.deepseek.model');
  if (!/^[\w.:-]{1,120}$/.test(result.models.deepseek.model)) issue('models.deepseek.model', 'DeepSeek 模型名称无效', '请填写 deepseek-chat 或服务商提供的有效模型 ID。');
  result.models.deepseek.maxTokens = number(ds.maxTokens, 1024, '输出 token 上限', 128, 8192, true, 'models.deepseek.maxTokens');
  result.models.deepseek.temperature = number(ds.temperature, 0.7, '温度', 0, 2, false, 'models.deepseek.temperature');
  result.models.codex.enabled = bool(cx.enabled, false, 'GPT 订阅', 'models.codex.enabled');
  result.models.codex.model = string(cx.model, '', 'Codex 模型', 120, 'models.codex.model');
  if (result.models.codex.model && !/^[\w.:-]{1,120}$/.test(result.models.codex.model)) issue('models.codex.model', 'Codex 模型名称无效', '可留空使用 Codex 默认模型，或填写官方 CLI 支持的模型 ID。');
  result.models.codex.timeoutSeconds = number(cx.timeoutSeconds, 180, 'GPT 超时', 30, 600, true, 'models.codex.timeoutSeconds');
  if (models.apis !== undefined && !Array.isArray(models.apis)) issue('models.apis', '兼容 API 列表必须是数组', '请通过“添加 API”创建模型通道。');
  else if (models.apis?.length > 20) issue('models.apis', '每个账号最多配置 20 个兼容 API 通道', '请移除暂时不使用的 API 通道。');
  else if (Array.isArray(models.apis)) {
    const seen = new Set();
    result.models.apis = models.apis.map((entry, i) => {
      const prefix = `models.apis.${i}`;
      if (!object(entry)) { issue(prefix, `第 ${i + 1} 个 API 通道必须是对象`, '请删除此通道后重新添加。'); entry = {}; }
      const label = `第 ${i + 1} 个 API`;
      const api = {
        id: string(entry.id, '', `${label}标识`, 68, `${prefix}.id`),
        label: string(entry.label, '兼容 API', `${label}名称`, 80, `${prefix}.label`),
        enabled: bool(entry.enabled, false, label, `${prefix}.enabled`),
        baseUrl: string(entry.baseUrl, 'https://api.openai.com/v1', `${label}地址`, 500, `${prefix}.baseUrl`).replace(/\/+$/, ''),
        model: string(entry.model, '', `${label}模型`, 200, `${prefix}.model`),
        maxTokens: number(entry.maxTokens, 1024, `${label}输出 token 上限`, 128, 131072, true, `${prefix}.maxTokens`),
        temperature: number(entry.temperature, 0.7, `${label}温度`, 0, 2, false, `${prefix}.temperature`),
      };
      if (!isApiProviderId(api.id)) issue(`${prefix}.id`, `${label}的通道标识无效`, '请删除此通道后重新添加；通道标识由应用生成。');
      if (seen.has(api.id)) issue(`${prefix}.id`, '兼容 API 通道标识重复', '请为每个模型添加独立的 API 通道。');
      seen.add(api.id);
      if (!api.label) issue(`${prefix}.label`, `${label}请填写名称`, '填写一个便于选择的名称，例如“OpenAI 工作助手”。');
      try {
        const url = new URL(api.baseUrl);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
      } catch { issue(`${prefix}.baseUrl`, `${label}地址必须使用 HTTPS，且不能携带账号、密码或查询参数`, '填写服务商提供的 API 基础地址，例如 https://api.openai.com/v1；API Key 请填在密钥栏。'); }
      if (api.model && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(api.model)) issue(`${prefix}.model`, `${label}模型名称无效`, '请复制服务商文档中的模型 ID，支持字母、数字、点、短横线、冒号和斜杠。');
      if (api.enabled && !api.model && applying) issue(`${prefix}.model`, `${label}尚未填写模型名称`, '请填写服务商的模型 ID 后再测试或应用。');
      for (const key of Object.keys(entry)) if (!['id', 'label', 'enabled', 'baseUrl', 'model', 'maxTokens', 'temperature'].includes(key)) issue(`${prefix}.${key}`, `${label}含不支持的配置字段`, key === 'apiKey' ? 'API Key 必须填写在密钥栏，不能写入可导出的配置。' : '请通过界面重新保存此 API 通道。');
      return api;
    });
  }
  const provider = (value, fallback, label, path) => {
    const selected = string(value, fallback, label, 68, path);
    if (!getModelConfig(result, selected)) issue(path, `${label}引用了不存在的模型通道`, '请重新选择 DeepSeek、ChatGPT 订阅或已添加的兼容 API 通道。');
    return selected;
  };
  // Packages are global; activation and plain scalar settings belong to this
  // account's normal saved/applied configuration transaction.
  if (input.plugins !== undefined && (!Array.isArray(input.plugins) || input.plugins.length > 50)) {
    issue('plugins', '插件配置必须为最多 50 项的数组', '请移除不再使用的账号插件配置。');
  } else if (Array.isArray(input.plugins)) {
    const seen = new Set();
    result.plugins = input.plugins.map((entry, index) => {
      const prefix = `plugins.${index}`;
      if (!object(entry)) { issue(prefix, '插件配置必须为对象'); entry = {}; }
      const pluginId = string(entry.id, '', '插件标识', 64, `${prefix}.id`);
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(pluginId) || seen.has(pluginId)) issue(`${prefix}.id`, '插件标识无效或重复', '请重新选择已安装的插件。');
      seen.add(pluginId);
      for (const key of Object.keys(entry)) if (!['id', 'enabled', 'settings'].includes(key)) issue(`${prefix}.${key}`, '不支持的插件配置字段');
      const settings = {};
      if (entry.settings !== undefined && !object(entry.settings)) issue(`${prefix}.settings`, '插件参数必须是对象');
      else if (object(entry.settings)) {
        if (Object.keys(entry.settings).length > 50) issue(`${prefix}.settings`, '每个插件最多支持 50 个参数');
        for (const [key, value] of Object.entries(entry.settings)) {
          if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key)) issue(`${prefix}.settings`, '插件参数名称无效');
          else if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value)) || (typeof value === 'string' && value.length > 6000)) issue(`${prefix}.settings.${key}`, '插件参数仅支持最多 6000 字符的文本、有限数值或开关');
          else settings[key] = value;
        }
      }
      return { id: pluginId, enabled: bool(entry.enabled, false, '插件启用', `${prefix}.enabled`), settings };
    });
    if (Buffer.byteLength(JSON.stringify(result.plugins)) > 64 * 1024) issue('plugins', '账号插件参数总计不能超过 64 KiB');
  }
  const chat = section('chat');
  result.chat.enabled = bool(chat.enabled, false, '聊天与回复', 'chat.enabled');
  result.chat.provider = provider(chat.provider, 'deepseek', '默认聊天模型', 'chat.provider');
  result.chat.persona = string(chat.persona, result.chat.persona, '群聊风格', 4000, 'chat.persona');
  result.chat.contextMessages = number(chat.contextMessages, 12, '群聊上下文条数', 0, 50, true, 'chat.contextMessages');
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
      if (g.trigger !== undefined && !LEGACY_GROUP_TRIGGERS.includes(g.trigger)) issue(`groups.${i}.trigger`, `${label}旧版触发方式无效`, '请通过新的触发条件勾选框重新设置。');
      if (g.triggers !== undefined && (!Array.isArray(g.triggers) || g.triggers.length > GROUP_TRIGGER_IDS.length || g.triggers.some(trigger => !GROUP_TRIGGER_IDS.includes(trigger)))) issue(`groups.${i}.triggers`, `${label}触发条件无效`, '请使用触发条件勾选框；可同时选择多个，也可清空以停止自动回复。');
      const read = bool(g.read, true, `${label}读取权限`);
      const send = bool(g.send, false, `${label}发送权限`);
      if (send && !read) errors.push(`${label}发送消息需要先允许读取`);
      return { id: groupId, name: string(g.name, '', `${label}名称`, 80), mode: g.mode === 'work' ? 'work' : 'social', read, send, trigger: g.trigger || 'mention', triggers: effectiveGroupTriggers(g), prefix: string(g.prefix, '/ai', `${label}命令前缀`, 30), probability: number(g.probability, 0.03, `${label}插话概率`, 0, 0.25, false), cooldownSeconds: number(g.cooldownSeconds, 30, `${label}冷却秒数`, 5, 3600) };
    });
    if (result.groups.length !== input.groups.length) errors.push('每个群配置必须是对象');
  }
  const summary = section('summary');
  for (const key of ['enabled', 'scheduleEnabled', 'backgroundAuthorized', 'sendToOwner']) result.summary[key] = bool(summary[key], result.summary[key], `汇总 ${key}`, `summary.${key}`);
  result.summary.provider = provider(summary.provider, 'deepseek', '汇总模型通道', 'summary.provider');
  result.summary.time = string(summary.time, '18:00', '每日汇总时间', 5, 'summary.time');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(result.summary.time)) issue('summary.time', '汇总时间须为 HH:MM', '请使用 24 小时制，例如 18:00。');
  result.summary.retentionDays = number(summary.retentionDays, 7, '消息保留天数', 1, 90, true, 'summary.retentionDays');
  result.summary.maxMessages = number(summary.maxMessages, 200, '汇总最大消息数', 1, 500, true, 'summary.maxMessages');
  const favorites = section('favorites');
  result.favorites.enabled = bool(favorites.enabled, false, '收藏', 'favorites.enabled');
  result.favorites.provider = provider(favorites.provider, 'deepseek', '收藏整理模型通道', 'favorites.provider');
  result.favorites.count = number(favorites.count, 50, '收藏列表条数', 1, 100, true, 'favorites.count');
  const tools = section('tools');
  for (const key of Object.keys(tools)) if (!['enabled', 'triggers', 'aliases', 'prefix', 'skill', 'grants'].includes(key)) issue(`tools.${key}`, '不支持的工具配置字段');
  result.tools.enabled = bool(tools.enabled, false, '群友工具调用', 'tools.enabled');
  result.tools.prefix = string(tools.prefix, '/工具', '工具指令前缀', 30, 'tools.prefix');
  if (!result.tools.prefix) issue('tools.prefix', '工具前缀不能为空');
  result.tools.skill = string(tools.skill, '', '工具 Skill', 8000, 'tools.skill');
  if (tools.triggers !== undefined) {
    if (!Array.isArray(tools.triggers) || tools.triggers.length > 4 || tools.triggers.some(value => !['mention', 'poke', 'name', 'command'].includes(value))) issue('tools.triggers', '工具唤醒方式无效');
    else result.tools.triggers = [...new Set(tools.triggers)];
  }
  if (tools.aliases !== undefined) {
    if (!Array.isArray(tools.aliases) || tools.aliases.length > 10 || tools.aliases.some(value => typeof value !== 'string' || !value.trim() || value.length > 20 || /[\r\n]/.test(value))) issue('tools.aliases', '最多填写 10 个称呼，每个 1–20 字符');
    else result.tools.aliases = [...new Set(tools.aliases.map(value => value.trim()))];
  }
  if (tools.grants !== undefined) {
    if (!Array.isArray(tools.grants) || tools.grants.length > 20) issue('tools.grants', '每个账号最多授权 20 个工具');
    else {
      const seen = new Set();
      result.tools.grants = tools.grants.map((grant, index) => {
        const prefix = `tools.grants.${index}`;
        if (!object(grant)) { issue(prefix, '工具授权必须是对象'); grant = {}; }
        for (const key of Object.keys(grant)) if (!['tool', 'groupIds', 'userIds', 'allowWrite'].includes(key)) issue(`${prefix}.${key}`, '不支持的工具授权字段');
        const tool = string(grant.tool, '', '工具标识', 113, `${prefix}.tool`);
        if (!/^[a-z][a-z0-9-]{0,63}\/[a-z][a-z0-9_]{0,47}$/.test(tool) || seen.has(tool)) issue(`${prefix}.tool`, '工具标识无效或重复');
        seen.add(tool);
        const ids = (key, label) => {
          if (!Array.isArray(grant[key]) || grant[key].length > 100) { issue(`${prefix}.${key}`, `${label}须为最多 100 项的号码数组`); return []; }
          return [...new Set(grant[key].map(value => id(value, label, `${prefix}.${key}`)))];
        };
        return { tool, groupIds: ids('groupIds', '授权群号'), userIds: ids('userIds', '允许调用的 QQ'), allowWrite: bool(grant.allowWrite, false, '外部写入授权', `${prefix}.allowWrite`) };
      });
    }
  }
  if (applying) {
    if (result.qq.enabled && !result.botQQ) issue('botQQ', '启用 QQ 连接前请填写控制的 QQ 号', '先在账号配置中填写准备登录 NapCat 的 QQ 号码。');
    if (result.qq.enabled && !hasSecret('napcatToken')) issue('secrets.napcatToken', '请先安装 NapCat 或填写其 OneBot Token', '先在 NapCat 登录此 QQ、启用正向 WebSocket，再填写同一个 OneBot Token 并测试连接。');
    if (result.models.deepseek.enabled && !hasSecret('deepseekApiKey')) issue('models.deepseek.apiKey', '启用 DeepSeek 前请填写 API Key', '在模型配置中填写 DeepSeek 开放平台的 API Key，保存后再测试。');
    for (const [i, api] of result.models.apis.entries()) if (api.enabled && isApiProviderId(api.id) && !hasSecret(apiSecretName(api.id))) issue(`models.apis.${i}.apiKey`, `${api.label}尚未填写 API Key`, '在此 API 通道的密钥栏填写服务商 API Key，保存后再测试。');
    if (result.summary.enabled && !getModelConfig(result, result.summary.provider)?.enabled) issue('summary.provider', '汇总选用的模型通道尚未启用', '请启用所选模型，或为通知汇总选择另一个已启用的模型。');
    if (result.summary.scheduleEnabled && (!result.summary.enabled || !result.summary.backgroundAuthorized)) issue('summary.backgroundAuthorized', '定时汇总需要启用汇总并明确授权后台执行', '先启用通知汇总，并勾选允许后台定时执行。');
    if (result.chat.enabled && !getModelConfig(result, result.chat.provider)?.enabled) issue('chat.provider', '聊天与回复选用的模型通道尚未启用', '请启用所选模型，或为聊天选择另一个已启用的模型。');
    if (result.favorites.enabled && !result.qq.enabled) issue('favorites.enabled', '读取收藏需要启用 QQ 接入', '请先连接 QQ，或暂时关闭收藏功能。');
    if (result.permissions.privateReplies || (result.summary.enabled && result.summary.sendToOwner)) {
      if (!result.ownerQQ) issue('ownerQQ', '启用私聊回复或发送汇总前，请填写私聊指令与汇总接收 QQ 号', '填写另一个用于接收消息的 QQ；只做群聊或在仪表盘查看结果时，请关闭私聊回复和私聊发送汇总。');
      if (result.ownerQQ && result.ownerQQ === result.botQQ) issue('ownerQQ', '私聊接收 QQ 必须使用不同号码；当前填写的是正在控制的 QQ，无法向自己发送私聊。群聊和本地查看结果不受影响。', '要接收私聊，请改填另一个 QQ；只做群聊或本地查看时，关闭“私聊回复”和“私聊发送汇总”，无需再建账号。');
    }
    if (result.summary.enabled && result.summary.sendToOwner && !result.permissions.privateReplies) issue('permissions.privateReplies', '发送私人汇总需要在群与消息权限中允许私聊回复', '允许私聊回复，或关闭“私聊发送汇总”以仅在仪表盘查看结果。');
  }
  if (errors.length) throw new ConfigError(errors);
  return result;
}

export function configHash(config) { return createHash('sha256').update(JSON.stringify(config)).digest('hex'); }
