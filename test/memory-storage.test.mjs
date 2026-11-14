import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../src/store.mjs';
import { createMemoryStorageSettings, MEMORY_TABLES, MEMORY_STORAGE_LIMITS } from '../src/memory-storage.mjs';
import { buildPersonaContext } from '../src/persona.mjs';

const key = { actualQQ: '111111', groupId: '222222' };
const quote = text => `"${text.replaceAll('"', '""')}"`;
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-storage-'));
  const dataDir = path.join(root, 'data'), custom = path.join(root, 'independent');
  const profiles = [{ id: 'legacy', directory: dataDir }];
  return { root, dataDir, custom, profiles, manager: () => createMemoryStorageSettings({ dataDir, profiles }),
    close() { fs.rmSync(root, { recursive: true, force: true }); } };
}
function configure(store) {
  const config = store.getConfig();
  config.botQQ = key.actualQQ; config.chat.enabled = true;
  config.groups = [{ id: key.groupId, read: true, social: { enabled: true } }];
  store.saveDraft(config); store.commitDraft();
  store.memory.setGroup({ ...key, enabled: true });
}
function record(store, messageId, text = '记住我喜欢科幻。', extra = {}) {
  return store.conversation.record({ ...key, messageId, userId: '333333', role: 'user', text, ...extra });
}
function seedLegacy(f) {
  const store = createStore(f.dataDir); configure(store); record(store, 'cleared');
  const fact = store.memory.mutate({ ...key, action: 'create', userId: '333333', text: '喜欢科幻。' });
  const note = store.experiences.mutate({ ...key, action: 'create', text: '看过一场流星雨。' });
  store.conversationState.clear(key);
  store.setTask('write-ledger-private', { state: 'attempted', secretMarker: 'DO_NOT_MIGRATE' });
  store.setSecret('deepseekApiKey', 'fixture-private-key');
  const memoryPath = store.memoryPath; store.close();
  const db = new DatabaseSync(path.join(f.dataDir, 'history.sqlite'));
  db.prepare('ATTACH DATABASE ? AS old_memory').run(memoryPath);
  for (const table of MEMORY_TABLES.filter(name => name !== 'memory_storage_meta')) {
    const row = db.prepare("SELECT sql FROM old_memory.sqlite_master WHERE type='table' AND name=?").get(table);
    if (!row) continue;
    db.exec(row.sql);
    db.exec(`INSERT INTO ${quote(table)}(rowid,${db.prepare(`PRAGMA old_memory.table_info(${quote(table)})`).all().map(column => quote(column.name)).join(',')}) SELECT rowid,* FROM old_memory.${quote(table)}`);
  }
  db.exec('DETACH DATABASE old_memory'); db.close();
  fs.unlinkSync(memoryPath); fs.unlinkSync(path.join(f.dataDir, 'memory-storage-owner.json'));
  return { fact, note };
}

test('legacy tables split once with verified rows, clear watermarks and backup; credentials and ledgers stay local', () => {
  const f = fixture(); let store;
  try {
    const { fact, note } = seedLegacy(f);
    store = createStore(f.dataDir);
    assert.equal(store.memory.list(key)[0].id, fact.id);
    assert.equal(store.experiences.list(key)[0].id, note.id);
    assert.equal(store.conversation.list(key)[0].messageId, 'cleared');
    assert.deepEqual(store.conversationState.filterHistory({ ...key, messages: store.conversation.list(key) }), []);
    assert.equal(store.getSecret('deepseekApiKey'), 'fixture-private-key');
    const external = new DatabaseSync(store.memoryPath);
    const names = external.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
    assert.ok(names.every(name => MEMORY_TABLES.includes(name)));
    assert.ok(!names.includes('tasks')); assert.ok(!names.includes('messages'));
    external.close();
    assert.ok(fs.existsSync(path.join(f.dataDir, 'history.pre-memory-split.backup.sqlite')));
    store.memory.mutate({ ...key, id: fact.id, version: fact.version, action: 'delete' });
    store.close(); store = createStore(f.dataDir);
    assert.equal(store.memory.list(key).length, 0, 'old source must never resurrect a deleted memory');
    assert.deepEqual(store.getTask('write-ledger-private'), { state: 'attempted', secretMarker: 'DO_NOT_MIGRATE' });
  } finally { store?.close(); f.close(); }
});

test('directory changes stage only, reject live migration, and preserve writes up to shutdown', () => {
  const f = fixture(); let store;
  try {
    const manager = f.manager(); store = createStore(f.dataDir); configure(store); record(store, 'before');
    assert.equal(manager.stage({ directory: f.custom }).restartRequired, true);
    assert.equal(manager.get().activeRoot, '');
    assert.ok(f.manager().get().lastError, 'a running store lock blocks migration');
    record(store, 'after-staging'); store.close(); store = null;
    const restarted = f.manager();
    assert.equal(restarted.get().restartRequired, false);
    assert.equal(restarted.get().activeRoot, fs.realpathSync(f.custom));
    store = createStore(f.dataDir, { memoryDirectory: restarted.profileDirectory('legacy', f.dataDir), profileId: 'legacy' });
    assert.deepEqual(store.conversation.list(key).map(row => row.messageId), ['before', 'after-staging']);
    record(store, 'independent');
    restarted.stage({ directory: '' }); store.close(); store = null;
    const restored = f.manager(); assert.equal(restored.get().activeRoot, '');
    store = createStore(f.dataDir);
    assert.equal(store.conversation.list(key).length, 3);
    assert.ok(fs.readdirSync(f.dataDir).some(name => name.includes('before-move-') && name.endsWith('.backup')));
    assert.ok(fs.existsSync(path.join(f.custom, 'profiles', 'legacy', 'memory.sqlite')), 'previous source remains recoverable');
  } finally { store?.close(); f.close(); }
});

test('profile identity and physical directory boundaries reject collisions and missing databases', () => {
  const f = fixture(); let store;
  try {
    store = createStore(f.dataDir); configure(store); record(store, 'must-survive');
    const original = store.memoryPath; store.close(); store = null;
    const moved = `${original}.saved`; fs.renameSync(original, moved);
    assert.throws(() => createStore(f.dataDir), cause => cause.code === 'MEMORY_STORAGE_MISSING');
    assert.equal(fs.existsSync(original), false, 'missing data cannot silently become empty memory');
    fs.renameSync(moved, original);
    const unrelated = path.join(f.root, 'other-profile');
    assert.throws(() => createStore(unrelated, { memoryDirectory: f.dataDir, profileId: 'other' }), cause => cause.code === 'MEMORY_STORAGE_OWNER_MISMATCH');
    store = createStore(f.dataDir); assert.equal(store.conversation.list(key).length, 1);
    assert.deepEqual(store.conversation.list({ actualQQ: '444444', groupId: key.groupId }), []);
  } finally { store?.close(); f.close(); }
});

test('11x storage retains 330 days and larger facts/notes without increasing model context', () => {
  const f = fixture(); let store;
  try {
    store = createStore(f.dataDir); configure(store);
    const now = Math.floor(Date.now() / 1000);
    record(store, 'day-329', '较早保存的对话', { time: now - 329 * 86400 });
    record(store, 'day-331', '已超出保存期', { time: now - 331 * 86400 });
    record(store, 'today');
    assert.deepEqual(store.conversation.list(key).map(row => row.messageId), ['day-329', 'today']);
    const fact = store.memory.mutate({ ...key, action: 'create', userId: '333333', text: '忆'.repeat(6600) });
    const note = store.experiences.mutate({ ...key, action: 'create', text: '札'.repeat(3300) });
    assert.equal(fact.text.length, 6600); assert.equal(note.text.length, 3300);
    assert.throws(() => store.memory.mutate({ ...key, action: 'create', userId: '333333', text: '忆'.repeat(6601) }));
    assert.throws(() => store.experiences.mutate({ ...key, action: 'create', text: '札'.repeat(3301) }));
    const prompt = buildPersonaContext({ config: store.getConfig(), group: { id: key.groupId }, actualQQ: key.actualQQ, memories: [fact], experiences: [note] });
    assert.ok(!prompt.includes('忆'.repeat(501))); assert.ok(!prompt.includes('札'.repeat(301)));
    assert.equal(MEMORY_STORAGE_LIMITS.activeExperiencesPerGroup, 440);
    const visible = store.conversationState.filterHistory({ ...key, messages: store.conversation.list(key) });
    assert.deepEqual(visible.map(row => row.messageId), ['today'], 'model retrieval window remains 30 days');
  } finally { store?.close(); f.close(); }
});

test('two profile IDs under one global root remain separate with identical QQ and group keys', () => {
  const f = fixture(); let first, second;
  try {
    const otherDir = path.join(f.dataDir, 'accounts', 'second');
    const manager = createMemoryStorageSettings({ dataDir: f.dataDir, profiles: [] }); manager.stage({ directory: f.custom });
    const active = createMemoryStorageSettings({ dataDir: f.dataDir, profiles: [] });
    first = createStore(f.dataDir, { memoryDirectory: active.profileDirectory('legacy', f.dataDir), profileId: 'legacy' });
    second = createStore(otherDir, { memoryDirectory: active.profileDirectory('second', otherDir), profileId: 'second' });
    configure(first); configure(second); record(first, 'first'); record(second, 'second');
    assert.deepEqual(first.conversation.list(key).map(row => row.messageId), ['first']);
    assert.deepEqual(second.conversation.list(key).map(row => row.messageId), ['second']);
  } finally { first?.close(); second?.close(); f.close(); }
});

test('staged migration never falls back to obsolete legacy memory after the split', () => {
  const f = fixture(); let store;
  try {
    const { fact } = seedLegacy(f);
    store = createStore(f.dataDir);
    store.memory.mutate({ ...key, action: 'delete', id: fact.id, version: fact.version });
    const file = store.memoryPath; store.close(); store = null;
    f.manager().stage({ directory: f.custom });
    fs.renameSync(file, `${file}.recoverable`);
    const restarted = f.manager();
    assert.equal(restarted.get().activeRoot, ''); assert.equal(restarted.get().restartRequired, true);
    assert.match(restarted.get().migrationError, /禁止从旧备份重建/);
    assert.equal(fs.existsSync(path.join(f.custom, 'profiles', 'legacy', 'memory.sqlite')), false);
  } finally { store?.close(); f.close(); }
});

test('profile metadata mismatch and unowned destination databases are never adopted', () => {
  const f = fixture(); let store;
  try {
    store = createStore(f.dataDir); configure(store); record(store, 'owned');
    const file = store.memoryPath; store.close(); store = null;
    assert.throws(() => createStore(f.dataDir, { profileId: 'other' }), cause => cause.code === 'MEMORY_STORAGE_PROFILE_MISMATCH');
    const manager = f.manager(); manager.stage({ directory: f.custom });
    const target = path.join(f.custom, 'profiles', 'legacy', 'memory.sqlite');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const unknown = new DatabaseSync(target); unknown.exec('CREATE TABLE unrelated (value TEXT)'); unknown.prepare('INSERT INTO unrelated VALUES (?)').run('keep'); unknown.close();
    const restarted = f.manager();
    assert.equal(restarted.get().activeRoot, ''); assert.equal(restarted.get().restartRequired, true);
    assert.match(restarted.get().lastError, /未标记/);
    const preserved = new DatabaseSync(target); assert.equal(preserved.prepare('SELECT value FROM unrelated').get().value, 'keep'); preserved.close();
    store = createStore(f.dataDir); assert.equal(store.conversation.list(key)[0].messageId, 'owned');
    assert.ok(fs.existsSync(file));
  } finally { store?.close(); f.close(); }
});

for (const damage of ['zero-byte', 'empty-sqlite', 'missing-marker']) test(`initialized ${damage} source cannot be recreated from old history or activated by migration`, () => {
  const f = fixture(); let store;
  try {
    const { fact } = seedLegacy(f); store = createStore(f.dataDir);
    store.memory.mutate({ ...key, action: 'delete', id: fact.id, version: fact.version });
    const file = store.memoryPath; store.close(); store = null;
    if (damage === 'missing-marker') {
      const broken = new DatabaseSync(file); broken.exec("DELETE FROM memory_storage_meta WHERE key='imported'"); broken.close();
    } else {
      fs.truncateSync(file, 0);
      if (damage === 'empty-sqlite') { const empty = new DatabaseSync(file); empty.exec('PRAGMA user_version=1'); empty.close(); }
    }
    assert.throws(() => createStore(f.dataDir), cause => cause.code === 'MEMORY_STORAGE_UNOWNED_SOURCE');
    f.manager().stage({ directory: f.custom });
    const restarted = f.manager();
    assert.equal(restarted.get().activeRoot, ''); assert.equal(restarted.get().restartRequired, true);
    assert.match(restarted.get().lastError, /标记/);
    assert.equal(fs.existsSync(path.join(f.custom, 'profiles', 'legacy', 'memory.sqlite')), false);
  } finally { store?.close(); f.close(); }
});
