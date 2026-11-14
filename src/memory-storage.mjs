import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

export const MEMORY_STORAGE_LIMITS = Object.freeze({ multiplier: 11, conversationRetentionDays: 330,
  conversationTextChars: 132000, memberMemoryTextChars: 6600, experienceTextChars: 3300,
  activeExperiencesPerGroup: 440, managementListRecords: 11000, personaHistoryRecords: 1100 });
export const MEMORY_TABLES = Object.freeze(['conversation_messages', 'memory_groups', 'member_memories', 'memory_fingerprints',
  'experience_groups', 'experiences', 'experience_versions', 'experience_fingerprints', 'dialogue_states',
  'dialogue_cleared_sources', 'dialogue_pending_experiences', 'persona_revisions', 'memory_storage_meta']);
const fail = (message, code = 'MEMORY_STORAGE_FAILED', statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const quote = name => `"${name.replaceAll('"', '""')}"`;
const exists = file => fs.existsSync(file);
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function ownerId(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'memory-storage-owner.json');
  if (!exists(file)) atomic(file, { id: randomUUID() });
  const id = JSON.parse(fs.readFileSync(file, 'utf8')).id;
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw fail('记忆资料身份文件损坏，请保留原目录并从备份恢复。');
  return id;
}
function acquire(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.owner.lock`, token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
      return () => {
        try { if (JSON.parse(fs.readFileSync(lock, 'utf8')).token === token) fs.unlinkSync(lock); } catch {}
      };
    } catch (cause) {
      if (cause.code !== 'EEXIST') throw cause;
      let prior;
      try { prior = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { throw fail('记忆目录锁损坏，请关闭其他实例并保留此目录检查。', 'MEMORY_STORAGE_BUSY'); }
      if (!Number.isSafeInteger(prior.pid) || prior.pid < 1) throw fail('记忆目录锁无效。', 'MEMORY_STORAGE_BUSY');
      let alive = true;
      try { process.kill(prior.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw fail('此记忆资料正在被另一个应用实例使用。请完全退出旧实例后重试。', 'MEMORY_STORAGE_BUSY');
      fs.unlinkSync(lock);
    }
  }
  throw fail('无法锁定记忆资料目录。', 'MEMORY_STORAGE_BUSY');
}
function integrity(db) {
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw fail('记忆数据库完整性校验未通过；原资料未切换。');
}
function tableNames(db, schema = 'main') {
  return db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type='table'`).all().map(row => row.name).filter(name => MEMORY_TABLES.includes(name));
}
function digest(db, table, schema = 'main') {
  const hash = createHash('sha256'); let count = 0;
  for (const row of db.prepare(`SELECT rowid,* FROM ${schema}.${quote(table)} ORDER BY rowid`).iterate()) {
    hash.update(JSON.stringify(row)); count++;
  }
  return { count, sha256: hash.digest('hex') };
}
function meta(db, name) {
  if (!tableNames(db).includes('memory_storage_meta')) return undefined;
  return db.prepare('SELECT value FROM memory_storage_meta WHERE key=?').get(name)?.value;
}
function initMeta(db, owner, profileId) {
  db.exec('CREATE TABLE IF NOT EXISTS memory_storage_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const priorOwner = meta(db, 'owner');
  const priorProfile = meta(db, 'profile');
  if (priorOwner && priorOwner !== owner) throw fail('目标记忆目录属于其他资料配置，已停止切换以保护账号隔离。', 'MEMORY_STORAGE_OWNER_MISMATCH');
  if (priorProfile && priorProfile !== profileId) throw fail('记忆资料的配置标识不匹配，已停止访问。', 'MEMORY_STORAGE_PROFILE_MISMATCH');
  db.prepare('INSERT OR IGNORE INTO memory_storage_meta VALUES (?,?)').run('owner', owner);
  db.prepare('INSERT OR IGNORE INTO memory_storage_meta VALUES (?,?)').run('profile', profileId);
}

/** Copy only memory tables, in one synchronous SQLite snapshot. No vault,
 * config, task ledger or transport credentials can enter the destination. */
function importTables(db, source, owner, profileId) {
  db.prepare('ATTACH DATABASE ? AS memory_source').run(source);
  try {
    if (db.prepare('PRAGMA memory_source.quick_check').get().quick_check !== 'ok') throw fail('原记忆数据库完整性校验失败。');
    db.exec('BEGIN IMMEDIATE');
    try {
      const available = tableNames(db, 'memory_source');
      if (path.basename(source) === 'memory.sqlite' && !available.includes('memory_storage_meta')) throw fail('原记忆库缺少身份标记，已停止迁移。', 'MEMORY_STORAGE_UNOWNED_SOURCE');
      if (available.includes('memory_storage_meta')) {
        const sourceOwner = db.prepare("SELECT value FROM memory_source.memory_storage_meta WHERE key='owner'").get()?.value;
        const sourceProfile = db.prepare("SELECT value FROM memory_source.memory_storage_meta WHERE key='profile'").get()?.value;
        const imported = db.prepare("SELECT value FROM memory_source.memory_storage_meta WHERE key='imported'").get()?.value;
        if (!sourceOwner || !sourceProfile || !imported) throw fail('原记忆库身份标记不完整，已停止迁移。', 'MEMORY_STORAGE_UNOWNED_SOURCE');
        if (sourceOwner && sourceOwner !== owner) throw fail('原记忆资料身份不匹配，已停止迁移。', 'MEMORY_STORAGE_OWNER_MISMATCH');
        if (sourceProfile && sourceProfile !== profileId) throw fail('原记忆资料配置标识不匹配，已停止迁移。', 'MEMORY_STORAGE_PROFILE_MISMATCH');
      }
      for (const table of available) {
        if (table === 'memory_storage_meta') continue;
        const sql = db.prepare("SELECT sql FROM memory_source.sqlite_master WHERE type='table' AND name=?").get(table).sql;
        db.exec(sql.replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?/i, 'CREATE TABLE IF NOT EXISTS '));
        db.exec(`INSERT INTO main.${quote(table)}(rowid,${db.prepare(`PRAGMA memory_source.table_info(${quote(table)})`).all().map(column => quote(column.name)).join(',')}) SELECT rowid,* FROM memory_source.${quote(table)}`);
        if (JSON.stringify(digest(db, table)) !== JSON.stringify(digest(db, table, 'memory_source'))) throw fail(`记忆表 ${table} 迁移校验失败。`);
      }
      initMeta(db, owner, profileId);
      db.prepare('INSERT OR REPLACE INTO memory_storage_meta VALUES (?,?)').run('imported', new Date().toISOString());
      db.exec('COMMIT');
    } catch (cause) { db.exec('ROLLBACK'); throw cause; }
  } finally { db.exec('DETACH DATABASE memory_source'); }
  integrity(db);
}

export function openMemoryDatabase({ dataDir, memoryDirectory = dataDir, profileId = 'legacy', legacyDb }) {
  const file = path.join(memoryDirectory, 'memory.sqlite'), release = acquire(file);
  let db;
  try {
    const owner = ownerId(dataDir);
    const ownerFile = path.join(dataDir, 'memory-storage-owner.json');
    const ownerState = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    if (ownerState.initialized && !exists(file)) throw fail('原记忆数据库不可用，禁止创建空库代替。请连接原磁盘或从迁移备份恢复。', 'MEMORY_STORAGE_MISSING');
    db = new DatabaseSync(file);
    if (ownerState.initialized) {
      if (!meta(db, 'imported') || !meta(db, 'owner') || !meta(db, 'profile')) throw fail('当前记忆数据库缺少完整身份标记，禁止从旧备份重建或创建空库。', 'MEMORY_STORAGE_UNOWNED_SOURCE');
      if (meta(db, 'owner') !== owner) throw fail('当前记忆数据库身份不匹配。', 'MEMORY_STORAGE_OWNER_MISMATCH');
      if (meta(db, 'profile') !== profileId) throw fail('当前记忆数据库配置标识不匹配。', 'MEMORY_STORAGE_PROFILE_MISMATCH');
      integrity(db);
    }
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    if (!meta(db, 'imported')) {
      // An unmarked nonempty destination is never merged or overwritten.
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name<>'memory_storage_meta' LIMIT 1").get()) throw fail('目标记忆库缺少迁移标记，已保留原资料，请检查后重试。');
      const legacyTables = legacyDb ? tableNames(legacyDb).filter(name => name !== 'memory_storage_meta') : [];
      if (legacyTables.length) {
        const backup = path.join(dataDir, 'history.pre-memory-split.backup.sqlite');
        if (!exists(backup)) legacyDb.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
        importTables(db, path.join(dataDir, 'history.sqlite'), owner, profileId);
      } else {
        initMeta(db, owner, profileId);
        db.prepare('INSERT INTO memory_storage_meta VALUES (?,?)').run('imported', new Date().toISOString());
      }
    }
    initMeta(db, owner, profileId); integrity(db);
    atomic(ownerFile, { ...ownerState, initialized: true });
    return { db, file, close() { try { db.close(); } finally { release(); } } };
  } catch (cause) { try { db?.close(); } finally { release(); } throw cause; }
}

function migrateFile(source, destination, owner, profileId) {
  if (path.resolve(source) === path.resolve(destination) || !exists(source)) return;
  const releaseSource = acquire(source); let releaseTarget, target, previous;
  const temporary = `${destination}.${randomUUID()}.migration.sqlite`;
  try {
    releaseTarget = acquire(destination);
    if (path.basename(source) === 'history.sqlite') {
      const backup = path.join(path.dirname(source), 'history.pre-memory-split.backup.sqlite');
      if (!exists(backup)) {
        const legacy = new DatabaseSync(source);
        try { legacy.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`); } finally { legacy.close(); }
      }
    }
    if (exists(destination)) {
      previous = new DatabaseSync(destination);
      const targetOwner = meta(previous, 'owner');
      if (!targetOwner || !meta(previous, 'imported') || !meta(previous, 'profile')) throw fail('目标目录已有未标记的数据库，已停止迁移，不能自动接管。', 'MEMORY_STORAGE_UNOWNED_TARGET');
      if (targetOwner !== owner) throw fail('目标目录已有其他配置的记忆资料，不能覆盖。', 'MEMORY_STORAGE_OWNER_MISMATCH');
      if (meta(previous, 'profile') !== profileId) throw fail('目标目录的配置标识不同，不能覆盖。', 'MEMORY_STORAGE_PROFILE_MISMATCH');
      previous.exec('PRAGMA wal_checkpoint(TRUNCATE)'); previous.close(); previous = null;
    }
    target = new DatabaseSync(temporary);
    importTables(target, source, owner, profileId); target.close(); target = null;
    if (exists(destination)) fs.renameSync(destination, `${destination}.before-move-${randomUUID()}.backup`);
    fs.rmSync(`${destination}-wal`, { force: true }); fs.rmSync(`${destination}-shm`, { force: true });
    fs.renameSync(temporary, destination);
  } finally {
    previous?.close(); target?.close(); fs.rmSync(temporary, { force: true }); releaseTarget?.(); releaseSource();
  }
}

/** Global pointer lives beside accounts.json; changes are staged while running.
 * Construct once at startup, before any account store is opened. */
export function createMemoryStorageSettings({ dataDir, profiles = [] }) {
  const file = path.join(dataDir, 'memory-storage-settings.json');
  let state = { version: 1, activeRoot: '', pendingRoot: null, lastError: '' };
  if (exists(file)) {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (loaded.version !== 1 || typeof loaded.activeRoot !== 'string' || !(loaded.pendingRoot === null || typeof loaded.pendingRoot === 'string')) throw fail('记忆目录设置损坏，请保留设置和原目录检查。');
    for (const value of [loaded.activeRoot, loaded.pendingRoot]) if (value !== null && (value.length > 4096 || value.includes('\0') || value && !path.isAbsolute(value))) throw fail('记忆目录设置必须使用有效绝对路径。');
    state = { ...state, ...loaded };
  }
  const directoryFor = (root, id, original) => {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw fail('记忆配置身份无效。');
    return root ? path.join(root, 'profiles', id) : original;
  };
  if (state.pendingRoot !== null) {
    try {
      for (const profile of profiles) {
        const fromDirectory = directoryFor(state.activeRoot, profile.id, profile.directory);
        const sourceFile = path.join(fromDirectory, 'memory.sqlite');
        const ownerFile = path.join(profile.directory, 'memory-storage-owner.json');
        const previouslySplit = exists(ownerFile) && JSON.parse(fs.readFileSync(ownerFile, 'utf8')).initialized === true;
        if (!exists(sourceFile) && previouslySplit) throw fail('原记忆数据库不可用，禁止从旧备份重建。请连接原磁盘或恢复当前记忆数据库。', 'MEMORY_STORAGE_MISSING');
        const source = exists(sourceFile) ? sourceFile : !state.activeRoot ? path.join(profile.directory, 'history.sqlite') : '';
        if (!source || !exists(source)) {
          if (state.activeRoot) throw fail('原记忆目录不可用，已保留原目录设置；请重新连接磁盘后再启动。');
          continue;
        }
        migrateFile(source, path.join(directoryFor(state.pendingRoot, profile.id, profile.directory), 'memory.sqlite'), ownerId(profile.directory), profile.id);
      }
      const next = { ...state, activeRoot: state.pendingRoot, pendingRoot: null, lastError: '' };
      atomic(file, next); state = next;
    } catch (cause) {
      // Every old source remains intact. Never point at partially copied data.
      state.lastError = String(cause.message || '记忆迁移失败，原资料保持不变。'); atomic(file, state);
    }
  }
  const get = () => ({ activeRoot: state.activeRoot || '', pendingRoot: state.pendingRoot,
    restartRequired: state.pendingRoot !== null, lastError: state.lastError, migrationError: state.lastError,
    defaultRoot: dataDir, capacityMultiplier: 11, limits: { ...MEMORY_STORAGE_LIMITS } });
  return {
    get,
    profileDirectory(id, originalDirectory) { return directoryFor(state.activeRoot, id, originalDirectory); },
    stage(input = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'directory')) throw fail('仅能设置记忆保存目录。', 'MEMORY_STORAGE_INVALID_DIRECTORY', 400);
      const { directory } = input;
      if (typeof directory !== 'string' || directory.length > 4096 || directory.includes('\0') || directory && !path.isAbsolute(directory)) throw fail('请选择有效的绝对目录。', 'MEMORY_STORAGE_INVALID_DIRECTORY', 400);
      let chosen = '';
      if (directory) {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        chosen = fs.realpathSync(directory);
        const probe = path.join(chosen, `.qq-service-memory-write-${randomUUID()}`);
        try { fs.writeFileSync(probe, '', { flag: 'wx', mode: 0o600 }); } finally { fs.rmSync(probe, { force: true }); }
      }
      const next = { ...state, pendingRoot: chosen === state.activeRoot ? null : chosen, lastError: '' };
      atomic(file, next); state = next; return get();
    },
  };
}
