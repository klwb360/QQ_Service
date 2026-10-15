import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson } from './store.mjs';

export const PLATFORMS = Object.freeze([
  { id: 'qq', name: 'QQ', available: true, adapter: 'onebot-v11' },
  { id: 'wechat', name: '微信', available: false, status: 'planned' },
  { id: 'telegram', name: 'Telegram', available: false, status: 'planned' },
]);

export const validAccountId = value => typeof value === 'string' && (value === 'legacy' || /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
const invalid = message => Object.assign(new Error(message), { statusCode: 400 });

export function createAccountCatalog(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'accounts.json');
  let catalog = { schemaVersion: 1, accounts: [] };
  if (fs.existsSync(file)) {
    catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.accounts)) throw invalid('账号目录格式不受支持，请保留资料并检查。');
    const ids = new Set();
    for (const account of catalog.accounts) {
      if (!validAccountId(account.id) || ids.has(account.id) || account.platform !== 'qq') throw invalid('账号目录包含无效或重复的账号。');
      ids.add(account.id);
    }
  } else if (fs.existsSync(path.join(dataDir, 'config.json'))) {
    catalog.accounts.push({ id: 'legacy', name: '原有 QQ 账号', platform: 'qq', createdAt: new Date().toISOString() });
    atomicJson(file, catalog);
  }
  const save = () => atomicJson(file, catalog);
  const list = () => structuredClone(catalog.accounts);
  const get = id => catalog.accounts.find(account => account.id === id);
  return {
    list,
    get(id) {
      if (!validAccountId(id) || !get(id)) throw Object.assign(new Error('账号不存在。'), { statusCode: 404 });
      return structuredClone(get(id));
    },
    directory(id) {
      if (!validAccountId(id)) throw invalid('账号 ID 无效。');
      return id === 'legacy' ? dataDir : path.join(dataDir, 'accounts', id);
    },
    ensureLegacy() {
      if (!get('legacy')) {
        catalog.accounts.push({ id: 'legacy', name: 'QQ 账号', platform: 'qq', createdAt: new Date().toISOString() });
        save();
      }
      return structuredClone(get('legacy'));
    },
    create({ name, platform = 'qq', qqNumber = '' } = {}) {
      if (platform !== 'qq') throw invalid('当前可接入 QQ；微信和 Telegram 仍在规划中。');
      if (typeof qqNumber !== 'string' || (qqNumber && !/^[1-9]\d{3,19}$/.test(qqNumber))) throw invalid('接入 QQ 号须为 4–20 位数字文本。');
      if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.trim().length > 80)) throw invalid('账号名称须为 1–80 个字符。');
      const account = { id: randomUUID(), name: name?.trim() || (qqNumber ? `QQ ${qqNumber}` : '新 QQ 账号'), platform, createdAt: new Date().toISOString() };
      catalog.accounts.push(account);
      try { save(); } catch (error) { catalog.accounts.pop(); throw error; }
      return { ...structuredClone(account), qqNumber };
    },
    rename(id, name) {
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw invalid('账号名称须为 1–80 个字符。');
      const account = get(id);
      if (!account) throw Object.assign(new Error('账号不存在。'), { statusCode: 404 });
      const previous = account.name;
      account.name = name.trim();
      try { save(); } catch (error) { account.name = previous; throw error; }
      return structuredClone(account);
    },
  };
}
