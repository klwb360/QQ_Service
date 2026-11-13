import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.mjs';
import { createQqMessageOrigin, qqMessageReference } from '../src/qq-message-origin.mjs';
import { executeBuiltinQQTool } from '../src/qq-tools.mjs';

const actualQQ = '111111', groupId = '222222', userId = '333333';
const isDenied = error => error.code === 'QQ_ACTION_DENIED';
const isInvalid = error => error.statusCode === 400;
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-origin-tools-'));
  const store = createStore(dataDir);
  t.after(() => { store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const origin = createQqMessageOrigin('snowluma'), oldOrigin = createQqMessageOrigin('napcat');
  const calls = [], sent = [], forwards = [], recalls = [];
  const context = { actualQQ, groupId, store, messageOrigin: origin, authorize: async () => true,
    action: async (name, params) => { calls.push({ name, params }); return {}; },
    sendMessage: async input => { sent.push(input); return { messageId: '-9988', messageIds: ['-9988'] }; },
    sendForward: async input => { forwards.push(input); return { executed: true, messageId: '-6677' }; },
    recallMessage: async input => { recalls.push(input); return { executed: true }; },
  };
  const record = (nativeMessageId = '-12345', source = origin, fields = {}) => store.conversation.recordTransport({
    actualQQ, groupId, userId, role: 'user', text: '当前群收到的消息', time: Math.floor(Date.now() / 1000),
    nativeMessageId, origin: source, ...fields });
  return { store, origin, oldOrigin, calls, sent, forwards, recalls, context, record,
    invoke: (name, input = {}) => executeBuiltinQQTool('qq:' + name, input, context) };
}

test('current and old connector messages retain unique readable IDs, but only current proven rows are actionable', async t => {
  const f = fixture(t), old = f.record('-12345', f.oldOrigin), current = f.record('-12345');
  f.store.conversation.record({ actualQQ, groupId, messageId: '-55', userId, role: 'user', text: '旧版没有来源的消息' });
  const forged = qqMessageReference({ origin: f.origin, nativeMessageId: '-999' });
  // record() is not the trusted transport admission: a lookalike prefix or
  // caller-supplied origin fields must never upgrade a legacy row.
  f.store.conversation.record({ actualQQ, groupId, messageId: forged, userId, role: 'user', text: '只有前缀没有来源',
    origin: f.origin, nativeMessageId: '-999' });
  const recent = await f.invoke('current_group_recent');
  assert.equal(recent.messages.length, 4);
  assert.equal(recent.messages.find(row => row.messageId === current.messageId).actionable, true);
  assert.equal(recent.messages.find(row => row.messageId === current.messageId).nativeMessageId, '-12345');
  for (const id of [old.messageId, '-55', forged]) assert.equal(recent.messages.find(row => row.messageId === id).actionable, false);
  assert.notEqual(old.messageId, current.messageId);
  assert.match(recent.notice, /不能|不用nativeMessageId/);
});

test('reaction converts exactly one current cache reference to its native ID and rejects old, raw, guessed and opaque IDs', async t => {
  const f = fixture(t), old = f.record('-12345', f.oldOrigin), current = f.record('-12345');
  const opaque = f.record('transport-fallback');
  await f.invoke('react_message', { messageId: current.messageId, emojiId: '66', set: true });
  assert.deepEqual(f.calls, [{ name: 'set_msg_emoji_like', params: { message_id: '-12345', emoji_id: '66', set: true } }]);
  for (const id of [old.messageId, qqMessageReference({ origin: f.origin, nativeMessageId: '-777' })]) {
    await assert.rejects(f.invoke('react_message', { messageId: id, emojiId: '66', set: false }), isDenied);
  }
  for (const id of ['-12345', opaque.messageId]) {
    await assert.rejects(f.invoke('react_message', { messageId: id, emojiId: '66', set: false }), isInvalid);
  }
  assert.equal(f.calls.length, 1);
});

test('prefix-only provenance cannot authorize a write even when its ID has the current generation', async t => {
  const f = fixture(t), forged = qqMessageReference({ origin: f.origin, nativeMessageId: '-999' });
  f.store.conversation.record({ actualQQ, groupId, messageId: forged, userId, role: 'user', text: '没有宿主来源元数据' });
  await assert.rejects(f.invoke('react_message', { messageId: forged, emojiId: '66', set: true }), isDenied);
  assert.equal(f.calls.length, 0);
});

test('reply callbacks receive a native destination plus canonical semantic source, and ACKs return current references', async t => {
  const f = fixture(t), current = f.record();
  const value = await f.invoke('send_message', { text: '真实引用回复', replyToMessageId: current.messageId });
  assert.deepEqual(f.sent, [{ text: '真实引用回复', mentionUserIds: [], replyToMessageId: '-12345', replyToSourceId: current.messageId }]);
  assert.equal(value.messageId, qqMessageReference({ origin: f.origin, nativeMessageId: '-9988' }));
  assert.equal(value.nativeMessageId, '-9988'); assert.equal(value.replyToMessageId, current.messageId);
  assert.equal(value.nativeReplyToMessageId, '-12345');
  assert.deepEqual(value.messageIds, [value.messageId]); assert.deepEqual(value.nativeMessageIds, ['-9988']);
  await assert.rejects(f.invoke('send_message', { text: '旧数字不是当前引用', replyToMessageId: '-12345' }), isInvalid);
  assert.equal(f.sent.length, 1);
});

test('forward validates the whole current-source batch and passes only native IDs in requested order', async t => {
  const f = fixture(t), first = f.record('-11'), second = f.record('-22'), old = f.record('-11', f.oldOrigin);
  await assert.rejects(f.invoke('forward_messages', { messageIds: [first.messageId, old.messageId] }), isDenied);
  assert.equal(f.forwards.length, 0);
  const value = await f.invoke('forward_messages', { messageIds: [second.messageId, first.messageId, second.messageId] });
  assert.deepEqual(f.forwards, [{ messageIds: ['-22', '-11'], sourceMessageIds: [second.messageId, first.messageId] }]);
  assert.equal(value.forwardedCount, 2); assert.deepEqual(value.sourceMessageIds, [second.messageId, first.messageId]);
  assert.equal(value.messageId, qqMessageReference({ origin: f.origin, nativeMessageId: '-6677' }));
  assert.equal(value.nativeMessageId, '-6677');
});

test('own recall cannot borrow an old assistant proof for the same native ID now owned by a human', async t => {
  const f = fixture(t), old = f.record('-88', f.oldOrigin, { userId: actualQQ, role: 'assistant', delivery: 'sent' });
  const currentHuman = f.record('-88'), currentOwn = f.record('-99', f.origin, { userId: actualQQ, role: 'assistant', delivery: 'sent' });
  for (const id of [old.messageId, currentHuman.messageId]) await assert.rejects(f.invoke('recall_own_message', { messageId: id }), isDenied);
  assert.equal(f.recalls.length, 0);
  const result = await f.invoke('recall_own_message', { messageId: currentOwn.messageId });
  assert.deepEqual(f.recalls, [{ messageId: '-99', sourceMessageId: currentOwn.messageId }]);
  assert.equal(result.messageId, currentOwn.messageId); assert.equal(result.nativeMessageId, '-99');
});

test('current-origin references still obey session clear and authorization changes during the visible read', async t => {
  const f = fixture(t), current = f.record();
  const state = f.store.conversationState.get({ actualQQ, groupId });
  f.store.conversationState.clear({ actualQQ, groupId, version: state.version });
  await assert.rejects(f.invoke('react_message', { messageId: current.messageId, emojiId: '66', set: true }), isDenied);
  const next = f.record('-54321'); let allowed = true;
  const list = f.store.conversation.list;
  f.store.conversation.list = async args => { const rows = list(args); allowed = false; return rows; };
  f.context.authorize = async () => allowed;
  await assert.rejects(f.invoke('send_message', { text: '不可晚发', replyToMessageId: next.messageId }), /授权已失效/);
  assert.equal(f.sent.length, 0); assert.equal(f.calls.length, 0);
});

test('an explicitly malformed origin cannot fall back to legacy numeric authorization', async t => {
  const f = fixture(t); f.store.conversation.record({ actualQQ, groupId, messageId: '-55', userId, role: 'user', text: '旧消息' });
  for (const bad of [null, {}, { backend: 'snowluma', connectionId: 'not-a-generation' }]) {
    f.context.messageOrigin = bad;
    await assert.rejects(f.invoke('react_message', { messageId: '-55', emojiId: '66', set: true }), isInvalid);
  }
  assert.equal(f.calls.length, 0);
});
