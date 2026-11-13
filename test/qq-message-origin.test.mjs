import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createQqMessageOrigin, normalizeQqMessageOrigin, qqMessageReference, parseQqMessageReference, matchesQqMessageOrigin } from '../src/qq-message-origin.mjs';
import { createMemoryStore } from '../src/memory-store.mjs';
import { createStore } from '../src/store.mjs';
import { createMemoryStorageSettings } from '../src/memory-storage.mjs';

const key = { actualQQ: '111111', groupId: '222222' }, userId = '333333';
const incoming = { ...key, nativeMessageId: '-123', userId, role: 'user', text: '这是当前连接的一条消息。' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-message-origin-'));
  const dataDir = path.join(root, 'data'); let store = createStore(dataDir);
  const config = store.getConfig(); config.botQQ = key.actualQQ; config.groups = [{ id: key.groupId, read: true, social: { enabled: true } }];
  store.saveDraft(config); store.commitDraft();
  t.after(() => { store?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, dataDir, get store() { return store; }, set store(value) { store = value; } };
}

test('host connection generations are random, strictly typed and deterministic only within one source', () => {
  const first = createQqMessageOrigin('napcat'), second = createQqMessageOrigin('napcat'), snow = createQqMessageOrigin('snowluma');
  assert.notEqual(first.connectionId, second.connectionId); assert.equal(Object.isFrozen(first), true);
  const id = qqMessageReference({ origin: first, nativeMessageId: '-123' });
  assert.equal(id, qqMessageReference({ origin: first, nativeMessageId: '-123' }));
  assert.notEqual(id, qqMessageReference({ origin: second, nativeMessageId: '-123' }));
  assert.notEqual(id, qqMessageReference({ origin: snow, nativeMessageId: '-123' }));
  assert.deepEqual(parseQqMessageReference(id), { origin: first, nativeMessageId: '-123' });
  for (const invalid of ['123', 'qqref:v2:napcat:123:n:1', id + ':extra', id.replace(':n:-123', ':n:0')]) assert.equal(parseQqMessageReference(invalid), null);
  for (const backend of ['', 'telegram', '__proto__']) assert.throws(() => createQqMessageOrigin(backend));
  let getterRan = false;
  const getter = { get backend() { getterRan = true; return 'napcat'; }, connectionId: first.connectionId };
  assert.throws(() => normalizeQqMessageOrigin(getter)); assert.equal(getterRan, false);
  assert.throws(() => normalizeQqMessageOrigin({ ...first, approved: true }));
});

test('parsing a cache ID alone never supplies action proof, and arbitrary fallback IDs remain nonactionable', () => {
  const origin = createQqMessageOrigin('snowluma'), other = createQqMessageOrigin('snowluma');
  const messageId = qqMessageReference({ origin, nativeMessageId: '-123' });
  assert.equal(matchesQqMessageOrigin({ messageId }, origin), false);
  assert.equal(matchesQqMessageOrigin({ messageId, nativeMessageId: '-123', origin }, origin), true);
  assert.equal(matchesQqMessageOrigin({ messageId, nativeMessageId: '-123', origin }, other), false);
  assert.equal(matchesQqMessageOrigin({ messageId, nativeMessageId: '-456', origin }, origin), false);
  const fallback = qqMessageReference({ origin, nativeMessageId: 'missing-id:arbitrary fallback' });
  assert.equal(parseQqMessageReference(fallback).opaque, true);
  assert.equal(matchesQqMessageOrigin({ messageId: fallback, nativeMessageId: 'missing-id:arbitrary fallback', origin }, origin), false);
});

test('same native ID across backends, generations, profiles and groups cannot overwrite or lend proof', t => {
  const f = fixture(t), napcat = createQqMessageOrigin('napcat'), snow = createQqMessageOrigin('snowluma'), reconnect = createQqMessageOrigin('snowluma');
  const records = [
    f.store.conversation.recordTransport({ ...incoming, origin: napcat, text: 'NapCat原消息' }),
    f.store.conversation.recordTransport({ ...incoming, origin: snow, text: 'SnowLuma新消息' }),
    f.store.conversation.recordTransport({ ...incoming, origin: reconnect, text: 'SnowLuma重连后消息' }),
  ];
  assert.equal(new Set(records.map(row => row.messageId)).size, 3);
  assert.deepEqual(f.store.conversation.list(key).map(row => row.text), ['NapCat原消息', 'SnowLuma新消息', 'SnowLuma重连后消息']);
  assert.deepEqual(f.store.conversation.actionMessages({ ...key, origin: snow }).map(row => row.messageId), [records[1].messageId]);
  assert.equal(f.store.conversation.actionMessages({ ...key, actualQQ: '999999', origin: snow }).length, 0);
  assert.equal(f.store.conversation.actionMessages({ ...key, groupId: '999999', origin: snow }).length, 0);
  assert.equal(f.store.conversation.actionMessages({ ...key, origin: createQqMessageOrigin('snowluma') }).length, 0);
  const other = createStore(path.join(f.root, 'other-profile'));
  try { assert.equal(other.conversation.actionMessages({ ...key, origin: snow }).length, 0); }
  finally { other.close(); }
  const copy = f.store.conversation.list(key)[0]; copy.origin.backend = 'snowluma';
  assert.equal(f.store.conversation.list(key)[0].origin.backend, 'napcat', 'returned metadata is not a mutable grant');
});

test('legacy rows, including prefix-shaped IDs, stay readable without origin and never become actions', t => {
  const f = fixture(t), origin = createQqMessageOrigin('napcat');
  const fakePrefix = qqMessageReference({ origin, nativeMessageId: '987' });
  for (const messageId of ['-123', fakePrefix]) f.store.conversation.record({ ...incoming, messageId, origin });
  const rows = f.store.conversation.list(key);
  assert.equal(rows.length, 2); assert.ok(rows.every(row => !row.origin && !row.nativeMessageId));
  assert.ok(rows.every(row => !matchesQqMessageOrigin(row, origin)));
  assert.deepEqual(f.store.conversation.actionMessages({ ...key, origin }), []);
});

test('canonical and native reply links preserve one unique memory source and reject a different connection generation', t => {
  const f = fixture(t), origin = createQqMessageOrigin('napcat'), other = createQqMessageOrigin('napcat');
  const first = f.store.conversation.recordTransport({ ...incoming, origin });
  const assistant = { ...key, userId: key.actualQQ, role: 'assistant', text: '引用回复', delivery: 'sent', origin };
  const canonical = f.store.conversation.recordTransport({ ...assistant, nativeMessageId: '124', replyTo: first.messageId });
  const explicit = f.store.conversation.recordTransport({ ...assistant, nativeMessageId: '125', replyToSourceId: first.messageId });
  const native = f.store.conversation.recordTransport({ ...assistant, nativeMessageId: '126', nativeReplyTo: incoming.nativeMessageId });
  for (const id of [canonical.messageId, explicit.messageId, native.messageId]) assert.equal(f.store.conversation.list(key).find(row => row.messageId === id).replyTo, first.messageId);
  const foreign = qqMessageReference({ origin: other, nativeMessageId: incoming.nativeMessageId });
  assert.throws(() => f.store.conversation.recordTransport({ ...assistant, nativeMessageId: '127', replyTo: foreign }), /不属于当前/);
  assert.throws(() => f.store.conversation.recordTransport({ ...assistant, nativeMessageId: '127', replyToSourceId: foreign }), /不属于当前/);
});

test('recall updates only the exact current-origin sent assistant row and cannot fall back to plain native IDs', t => {
  const f = fixture(t), old = createQqMessageOrigin('napcat'), current = createQqMessageOrigin('snowluma');
  const assistant = { ...incoming, userId: key.actualQQ, role: 'assistant', text: '本人回复', delivery: 'sent' };
  const previous = f.store.conversation.recordTransport({ ...assistant, origin: old });
  const latest = f.store.conversation.recordTransport({ ...assistant, origin: current });
  assert.equal(f.store.conversation.markTransportRecalled({ ...key, messageId: previous.messageId, origin: current }), false);
  assert.equal(f.store.conversation.markTransportRecalled({ ...key, messageId: incoming.nativeMessageId, origin: current }), false);
  assert.equal(f.store.conversation.markRecalled({ ...key, messageId: latest.messageId }), false, 'legacy API cannot bypass provenance');
  assert.equal(f.store.conversation.markTransportRecalled({ ...key, messageId: latest.messageId, origin: current }), true);
  assert.deepEqual(f.store.conversation.list(key).map(row => row.messageId), [previous.messageId]);
});

test('additive upgrade preserves legacy rowids and does not infer a connector for historic rows', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE conversation_messages (
      actual_qq TEXT NOT NULL,group_id TEXT NOT NULL,message_id TEXT NOT NULL,user_id TEXT NOT NULL,
      role TEXT NOT NULL,text TEXT NOT NULL,time INTEGER NOT NULL,reply_to TEXT NOT NULL,
      display_name TEXT NOT NULL,delivery TEXT NOT NULL,PRIMARY KEY(actual_qq,group_id,message_id))`);
    db.prepare('INSERT INTO conversation_messages(rowid,actual_qq,group_id,message_id,user_id,role,text,time,reply_to,display_name,delivery) VALUES(77,?,?,?,?,?,?,?,?,?,?)')
      .run(key.actualQQ, key.groupId, 'legacy', userId, 'user', '旧消息证据', Math.floor(Date.now() / 1000), '', '群友', 'received');
    const memory = createMemoryStore({ db, getState: () => ({ applied: {}, draft: {} }) });
    assert.equal(db.prepare('SELECT rowid FROM conversation_messages').get().rowid, 77);
    assert.equal(db.prepare('PRAGMA table_info(conversation_messages)').all().length, 13);
    assert.equal(memory.conversation.list(key)[0].messageId, 'legacy');
    assert.equal(memory.conversation.list(key)[0].origin, undefined);
    assert.deepEqual(memory.conversation.actionMessages({ ...key, origin: createQqMessageOrigin('napcat') }), []);
  } finally { db.close(); }
});

test('memory clear watermarks and directory migration retain unique sources without resurrecting action evidence', t => {
  const f = fixture(t), origin = createQqMessageOrigin('snowluma');
  const before = f.store.conversation.recordTransport({ ...incoming, origin });
  f.store.conversationState.clear(key);
  assert.deepEqual(f.store.conversationState.filterHistory({ ...key, messages: f.store.conversation.actionMessages({ ...key, origin }) }), []);
  const manager = createMemoryStorageSettings({ dataDir: f.dataDir, profiles: [{ id: 'legacy', directory: f.dataDir }] });
  manager.stage({ directory: path.join(f.root, 'custom-memory') });
  f.store.close(); f.store = null;
  const restarted = createMemoryStorageSettings({ dataDir: f.dataDir, profiles: [{ id: 'legacy', directory: f.dataDir }] });
  assert.equal(restarted.get().restartRequired, false);
  f.store = createStore(f.dataDir, { memoryDirectory: restarted.profileDirectory('legacy', f.dataDir), profileId: 'legacy' });
  const migrated = f.store.conversation.list(key);
  assert.equal(migrated[0].messageId, before.messageId); assert.deepEqual(migrated[0].origin, origin);
  assert.deepEqual(f.store.conversationState.filterHistory({ ...key, messages: migrated }), []);
  assert.deepEqual(f.store.conversation.actionMessages({ ...key, origin: createQqMessageOrigin('snowluma') }), []);
  const after = f.store.conversation.recordTransport({ ...incoming, nativeMessageId: '-124', text: '清空后的新消息', origin });
  const visible = f.store.conversationState.filterHistory({ ...key, messages: f.store.conversation.actionMessages({ ...key, origin }) });
  assert.deepEqual(visible.map(row => row.messageId), [after.messageId]);
});

test('missing native IDs and unconfirmed outbound delivery cannot create an actionable stored row', t => {
  const f = fixture(t), origin = createQqMessageOrigin('napcat');
  assert.throws(() => f.store.conversation.recordTransport({ ...incoming, origin, nativeMessageId: '' }));
  const fallback = f.store.conversation.recordTransport({ ...incoming, origin, nativeMessageId: 'fallback-without-native-id' });
  const failed = f.store.conversation.recordTransport({ ...incoming, origin, nativeMessageId: '124', userId: key.actualQQ, role: 'assistant', delivery: 'unknown' });
  assert.equal(failed.stored, false);
  const stored = f.store.conversation.list(key);
  assert.equal(stored.length, 1); assert.equal(stored[0].messageId, fallback.messageId); assert.equal(stored[0].actionable, false);
  assert.deepEqual(f.store.conversation.actionMessages({ ...key, origin }), []);
});
