import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createCipheriv, createDecipheriv, createHmac } from 'node:crypto';
import { DEFAULT_CONFIG, configHash, migrateConfig, isCredentialName } from './config.mjs';
import { createMemoryStore } from './memory-store.mjs';
import { createPersonaStore, normalizePersona } from './persona.mjs';
import { createExperienceStore } from './experience-store.mjs';
import { createConversationStateStore } from './conversation-state.mjs';
import { canonicalMcpConnection, mcpSecretName, parseMcpSecretName } from './mcp-config.mjs';
import { openMemoryDatabase } from './memory-storage.mjs';

export function atomicJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function createStore(dataDir, { memoryDirectory = dataDir, profileId = 'legacy' } = {}) {
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
    needsMigration ||= JSON.stringify(state[name]) !== JSON.stringify(migrated[name]);
  }
  if (needsMigration) {
    // Only configuration changes. Retired login directories and account data
    // remain untouched, including when no schema-version bump is needed.
    const oldVersion = Math.min(...['draft', 'applied', 'previous'].filter(name => state[name]).map(name => state[name].schemaVersion || 4));
    const backupFile = path.join(dataDir, oldVersion < 4 ? `config.v${oldVersion}.backup.json` : 'config.pre-api-only.backup.json');
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
  db.exec(`CREATE TABLE IF NOT EXISTS event_receipts (
    actual_qq TEXT NOT NULL,backend TEXT NOT NULL,event_key TEXT NOT NULL,cross_key TEXT NOT NULL,received_at INTEGER NOT NULL,
    PRIMARY KEY(actual_qq,backend,event_key));
    CREATE INDEX IF NOT EXISTS receipts_recent ON event_receipts(actual_qq,received_at);`);
  const saveSecrets = () => {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()]);
    atomicJson(vaultFile, { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
  };
  const saveState = (next) => { atomicJson(configFile, next); state = next; };
  const stagedSecretNames = () => Object.keys(secrets).filter(name => name.startsWith('draft:') && isCredentialName(name.slice(6)));
  const secretsPending = () => stagedSecretNames().some(name => secrets[name] !== secrets[name.slice(6)]);
  let memoryStorage;
  try { memoryStorage = openMemoryDatabase({ dataDir, memoryDirectory, profileId, legacyDb: db }); }
  catch (cause) { db.close(); throw cause; }
  const memoryDb = memoryStorage.db;
  const { memory, conversation } = createMemoryStore({ db: memoryDb, legacyDb: db, getState: () => state });
  const personas = createPersonaStore({ db: memoryDb });
  const experiences = createExperienceStore({ db: memoryDb, getState: () => state });
  const conversationState = createConversationStateStore({ db: memoryDb, legacyDb: db, getState: () => state });
  const recordPersona = (config = state.applied) => {
    if (!/^[1-9]\d{3,19}$/.test(config.botQQ || '')) return;
    const current = personas.get({ actualQQ: config.botQQ });
    return personas.save({ actualQQ: config.botQQ, persona: normalizePersona(config), expectedRevision: current?.revision || 0 });
  };
  recordPersona();
  const setupKey = actualQQ => `account-setup-completed:${actualQQ}`;
  const recordSetupCompleted = actualQQ => {
    if (!/^[1-9]\d{3,19}$/.test(actualQQ || '')) return;
    db.prepare('INSERT OR IGNORE INTO tasks VALUES (?,?)').run(setupKey(actualQQ), JSON.stringify({ completedAt: new Date().toISOString() }));
  };
  // Existing explicitly started accounts stay in editing mode after a later
  // apply returns them to read-only, or when the QQ transport goes offline.
  for (const config of [state.applied, state.previous]) if (config?.permissions?.released === true) recordSetupCompleted(config.botQQ);
  return {
    dataDir, memoryPath: memoryStorage.file,
    memory, conversation, personas, experiences, conversationState, recordPersona, recordSetupCompleted,
    isSetupCompleted: actualQQ => Boolean(db.prepare('SELECT 1 FROM tasks WHERE key=?').get(setupKey(actualQQ))),
    getState: () => structuredClone(state),
    getConfig: () => structuredClone(state.applied),
    getSecret: (name) => secrets[name] || '',
    getDraftSecret: name => secrets[`draft:${name}`] ?? secrets[name] ?? '',
    mcpConnectionHash(server, getSecretValue = name => secrets[name] || '') {
      const descriptor = canonicalMcpConnection(server);
      const read = (kind, name) => {
        const value = getSecretValue(mcpSecretName(descriptor.id, kind, name));
        if (typeof value !== 'string') throw new TypeError('MCP 连接指纹需要同步文字凭据读取器。');
        return [name, value];
      };
      const credentials = { env: descriptor.envKeys.map(name => read('env', name)), headers: descriptor.headerKeys.map(name => read('header', name)) };
      return createHmac('sha256', key).update(JSON.stringify({ version: 1, descriptor, credentials })).digest('hex');
    },
    hasSecret: (name) => Boolean(secrets[name]),
    hasDraftSecret: (name) => Boolean(secrets[`draft:${name}`] ?? secrets[name]),
    getSecretSnapshot: () => structuredClone(secrets),
    restoreSecrets(snapshot) { secrets = structuredClone(snapshot); saveSecrets(); },
    stageSecrets(updates) {
      for (const [name, value] of Object.entries(updates)) if (!isCredentialName(name) || typeof value !== 'string') throw new TypeError('凭据字段无效');
      for (const [name, value] of Object.entries(updates)) if (value.trim()) secrets[`draft:${name}`] = parseMcpSecretName(name) ? value : value.trim();
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
    claimEvent({ actualQQ, backend, key: eventKey, crossKey }) {
      const cutoff = Date.now() - 120_000;
      db.prepare('DELETE FROM event_receipts WHERE received_at < ?').run(cutoff);
      const duplicate = db.prepare('SELECT 1 FROM event_receipts WHERE actual_qq=? AND (event_key=? OR (cross_key=? AND backend<>?)) LIMIT 1').get(actualQQ, eventKey, crossKey, backend);
      if (duplicate) return false;
      db.prepare('INSERT INTO event_receipts VALUES (?,?,?,?,?)').run(actualQQ, backend, eventKey, crossKey, Date.now());
      return true;
    },
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
    close: () => { try { memoryStorage.close(); } finally { db.close(); } }
  };
}
