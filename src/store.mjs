import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { DEFAULT_CONFIG, configHash, migrateConfig, isCredentialName } from './config.mjs';
import { createMemoryStore } from './memory-store.mjs';

export function atomicJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function createStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const configFile = path.join(dataDir, 'config.json');
  const vaultFile = path.join(dataDir, 'vault.json');
  const keyFile = path.join(dataDir, 'vault.key');
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
  const key = fs.readFileSync(keyFile);
  if (key.length !== 32) throw new Error('本地凭据存储密钥损坏，请从备份恢复');
  let secrets = {};
  if (fs.existsSync(vaultFile)) {
    const encrypted = JSON.parse(fs.readFileSync(vaultFile, 'utf8'));
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
    secrets = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted.data, 'base64')), decipher.final()]).toString('utf8'));
  }
  const initial = { draft: structuredClone(DEFAULT_CONFIG), applied: structuredClone(DEFAULT_CONFIG), revision: 0, appliedRevision: 0, previous: null };
  let state = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : initial;
  const migrated = { ...state };
  let needsMigration = false;
  for (const name of ['draft', 'applied', 'previous']) {
    if (name === 'previous' && state[name] == null) continue;
    migrated[name] = migrateConfig(state[name]);
    needsMigration ||= state[name].schemaVersion !== migrated[name].schemaVersion;
  }
  if (needsMigration) {
    // The legacy profile keeps this directory, including existing CLI login,
    // vault and NapCat bind mounts. Only its configuration schema changes.
    const backupFile = path.join(dataDir, 'config.v1.backup.json');
    if (!fs.existsSync(backupFile)) {
      fs.copyFileSync(configFile, backupFile, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(backupFile, 0o600);
    }
    atomicJson(configFile, migrated);
  }
  state = migrated;
  const db = new DatabaseSync(path.join(dataDir, 'history.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS messages (account_id TEXT NOT NULL, group_id TEXT NOT NULL, message_id TEXT NOT NULL, user_id TEXT NOT NULL, time INTEGER NOT NULL, text TEXT NOT NULL, mode TEXT NOT NULL, PRIMARY KEY(account_id,group_id,message_id));
    CREATE INDEX IF NOT EXISTS messages_group_time ON messages(group_id,time);
    CREATE TABLE IF NOT EXISTS summaries (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS favorites (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);`);
  const saveSecrets = () => {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()]);
    atomicJson(vaultFile, { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
  };
  const saveState = (next) => { atomicJson(configFile, next); state = next; };
  const stagedSecretNames = () => Object.keys(secrets).filter(name => name.startsWith('draft:') && isCredentialName(name.slice(6)));
  const secretsPending = () => stagedSecretNames().some(name => secrets[name] !== secrets[name.slice(6)]);
  const { memory, conversation } = createMemoryStore({ db, getState: () => state });
  return {
    dataDir,
    memory, conversation,
    getState: () => structuredClone(state),
    getConfig: () => structuredClone(state.applied),
    getSecret: (name) => secrets[name] || '',
    hasSecret: (name) => Boolean(secrets[name]),
    hasDraftSecret: (name) => Boolean(secrets[`draft:${name}`] ?? secrets[name]),
    getSecretSnapshot: () => structuredClone(secrets),
    restoreSecrets(snapshot) { secrets = structuredClone(snapshot); saveSecrets(); },
    stageSecrets(updates) {
      for (const [name, value] of Object.entries(updates)) if (!isCredentialName(name) || typeof value !== 'string') throw new TypeError('凭据字段无效');
      for (const [name, value] of Object.entries(updates)) if (value.trim()) secrets[`draft:${name}`] = value.trim();
      saveSecrets();
    },
    commitSecrets() { for (const stagedName of stagedSecretNames()) { secrets[stagedName.slice(6)] = secrets[stagedName]; delete secrets[stagedName]; } saveSecrets(); },
    secretsPending,
    setSecret(name, value) { if (!isCredentialName(name) || typeof value !== 'string') throw new TypeError('凭据字段无效'); secrets[name] = value; saveSecrets(); },
    saveDraft(config) { saveState({ ...state, draft: structuredClone(config), revision: state.revision + 1 }); },
    commitDraft() { saveState({ ...state, previous: structuredClone(state.applied), applied: structuredClone(state.draft), appliedRevision: state.revision }); },
    restoreState(next) { saveState(next); },
    rollback() {
      if (!state.previous) throw new Error('还没有可回滚的已应用配置');
      const previous = structuredClone(state.previous);
      saveState({ draft: previous, applied: previous, revision: state.revision + 1, appliedRevision: state.revision + 1, previous: structuredClone(state.applied) });
    },
    pendingChanges: () => configHash(state.draft) !== configHash(state.applied) || secretsPending(),
    recordMessage(record) {
      const time = Number(record.time) || Math.floor(Date.now() / 1000);
      const rawText = String(record.text);
      const text = rawText.slice(0, 12000) + (rawText.length > 12000 ? '\n[本地缓存达到文字长度限制，原消息未完整保存。]' : '');
      db.prepare('INSERT OR IGNORE INTO messages VALUES (?,?,?,?,?,?,?)').run(String(record.accountId || ''), String(record.groupId), String(record.messageId), String(record.userId), time > 1e12 ? Math.floor(time / 1000) : Math.floor(time), text, record.mode);
      const cutoff = Math.floor(Date.now() / 1000) - state.applied.summary.retentionDays * 86400;
      db.prepare('DELETE FROM messages WHERE time < ?').run(cutoff);
    },
    listMessages(groupId, limit = 200, mode = 'work') {
      const cutoff = Math.floor(Date.now() / 1000) - state.applied.summary.retentionDays * 86400;
      return db.prepare('SELECT account_id AS accountId,group_id AS groupId,message_id AS messageId,user_id AS userId,time,text,mode FROM messages WHERE group_id=? AND mode=? AND time>=? ORDER BY time DESC,rowid DESC LIMIT ?').all(String(groupId), mode, cutoff, Math.max(1, Math.min(501, Number(limit) || 200))).reverse();
    },
    saveSummary(summary) { const item = { ...summary, createdAt: summary.createdAt || new Date().toISOString() }; db.prepare('INSERT OR REPLACE INTO summaries VALUES (?,?,?)').run(item.id, JSON.stringify(item), item.createdAt); db.exec('DELETE FROM summaries WHERE id NOT IN (SELECT id FROM summaries ORDER BY created_at DESC LIMIT 100)'); },
    getSummaries: () => {
      const cutoff = new Date(Date.now() - state.applied.summary.retentionDays * 86400000).toISOString();
      db.prepare('DELETE FROM summaries WHERE created_at < ?').run(cutoff);
      db.prepare('DELETE FROM messages WHERE time < ?').run(Math.floor(Date.now() / 1000) - state.applied.summary.retentionDays * 86400);
      return db.prepare('SELECT payload FROM summaries ORDER BY created_at DESC LIMIT 30').all().map(r => JSON.parse(r.payload));
    },
    saveFavorites(list) { db.prepare('INSERT OR REPLACE INTO favorites VALUES (1,?)').run(JSON.stringify(list)); },
    getFavorites: () => { const row = db.prepare('SELECT payload FROM favorites WHERE id=1').get(); return row ? JSON.parse(row.payload) : []; },
    getTask: (key) => { const row = db.prepare('SELECT value FROM tasks WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; },
    setTask(key, value) { db.prepare('INSERT OR REPLACE INTO tasks VALUES (?,?)').run(key, JSON.stringify(value)); },
    metrics: () => ({ storedMessages: db.prepare('SELECT count(*) AS n FROM messages').get().n, storedSummaries: db.prepare('SELECT count(*) AS n FROM summaries').get().n }),
    close: () => db.close()
  };
}
