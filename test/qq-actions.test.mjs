import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.mjs';
import { executeBuiltinQQTool, listBuiltinQQTools, BUILTIN_QQ_TOOL_IDS } from '../src/qq-tools.mjs';

const actualQQ = '111111', groupId = '222222', userId = '333333';
const row = (fields = {}) => ({ actualQQ, groupId, userId, messageId: '-12345', role: 'user', text: '真实收到的本群文字',
  time: Math.floor(Date.now() / 1000), displayName: '群友', delivery: 'received', ...fields });
const person = (id = userId, fields = {}) => ({ group_id: groupId, user_id: id, nickname: '群友昵称', card: '群名片', role: 'member', ...fields });
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve }; };
function fixture(options = {}) {
  const calls = [], sent = []; let checks = 0;
  const context = { actualQQ, groupId, signal: options.signal,
    authorize: async () => { checks++; return options.authorize?.(); },
    store: options.store || { conversation: { list: async args => {
      assert.deepEqual(args, { actualQQ, groupId, limit: 100 }); return options.rows || [row()];
    } }, conversationState: { filterHistory: async args => options.filter ? options.filter(args) : args.messages } },
    action: async (name, params, extra) => {
      calls.push({ name, params: structuredClone(params) });
      if (options.action) return options.action(name, params, extra);
      if (name === 'get_group_member_info') return person(params.user_id);
      if (name === 'get_group_member_list') return [person()];
      return null;
    },
    sendMessage: async args => {
      sent.push(structuredClone(args)); return options.sendMessage ? options.sendMessage(args) : { messageId: '-9988' };
    },
  };
  return { context, calls, sent, checks: () => checks,
    invoke: (name, args = {}) => executeBuiltinQQTool(`qq:${name}`, args, context) };
}
const isInvalid = error => error.statusCode === 400;
const isDenied = error => error.code === 'QQ_ACTION_DENIED' && error.statusCode === 403;

test('the fixed seven-tool directory preserves cached reads and marks only actual QQ writes as write effects', () => {
  const tools = listBuiltinQQTools();
  assert.equal(tools.length, 7); assert.deepEqual(tools.map(tool => tool.id), BUILTIN_QQ_TOOL_IDS);
  assert.deepEqual(tools.filter(tool => tool.effect === 'write').map(tool => tool.id), ['qq:poke_member', 'qq:send_message', 'qq:react_message']);
  assert.ok(tools.filter(tool => tool.id.startsWith('qq:current_group_')).every(tool => tool.effect === 'read'));
  assert.ok(tools.every(tool => tool.source === 'qq' && tool.inputSchema.additionalProperties === false));
  tools[0].inputSchema.properties.unapproved = { type: 'string' };
  assert.equal(listBuiltinQQTools()[0].inputSchema.properties.unapproved, undefined);
});

test('members search exposes only bounded QQ/name/card/role data from the current group', async () => {
  const f = fixture({ action: async name => {
    assert.equal(name, 'get_group_member_list');
    return [person('333333', { nickname: '星空摄影', card: '摄影群友', role: 'admin', age: 99, secret: 'unrelated' }),
      person('444444', { nickname: '旅行爱好者' }), person('555555', { group_id: '999999', nickname: '星空摄影外群' })];
  } });
  const result = await f.invoke('current_group_members', { query: '星空 摄影' });
  assert.deepEqual(f.calls[0], { name: 'get_group_member_list', params: { group_id: groupId } });
  assert.deepEqual(result.members, [{ userId, nickname: '星空摄影', card: '摄影群友', role: 'admin' }]);
  assert.equal(JSON.stringify(result).includes('unrelated'), false); assert.equal(result.hasMore, false);
  const large = fixture({ action: async () => Array.from({ length: 100 }, (_, i) => person(String(400000 + i), { nickname: '中'.repeat(300), card: '文'.repeat(300) })) });
  const bounded = await large.invoke('current_group_members', { limit: 50 });
  assert.ok(bounded.members.length <= 50); assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 24 * 1024);
  assert.equal(bounded.hasMore, true);
});

test('single-member lookup proves both the current group and the requested QQ before returning metadata', async () => {
  const f = fixture();
  const result = await f.invoke('current_group_member', { userId });
  assert.deepEqual(result, { groupId, member: { userId, nickname: '群友昵称', card: '群名片', role: 'member' } });
  for (const mismatch of [person('444444'), person(userId, { group_id: '999999' }), { user_id: userId }, null]) {
    const refused = fixture({ action: async () => mismatch });
    await assert.rejects(refused.invoke('current_group_member', { userId }), isDenied);
    assert.equal(refused.calls.length, 1);
  }
});

test('poke verifies a real current-group member before one fixed group_poke action', async () => {
  const f = fixture();
  const result = await f.invoke('poke_member', { userId });
  assert.deepEqual(f.calls, [
    { name: 'get_group_member_info', params: { group_id: groupId, user_id: userId, no_cache: true } },
    { name: 'group_poke', params: { group_id: groupId, user_id: userId } },
  ]);
  assert.deepEqual(result, { executed: true, status: 'applied', action: 'poke', groupId, userId });
  const unknown = fixture({ action: async () => person(userId, { group_id: '999999' }) });
  await assert.rejects(unknown.invoke('poke_member', { userId }), isDenied);
  assert.equal(unknown.calls.some(call => call.name === 'group_poke'), false);
});

test('send verifies mentions and cached replies, then delegates only typed business fields to the host sender', async () => {
  const f = fixture();
  const text = '这只是普通文字 [CQ:at,qq=all]，不执行CQ。';
  const result = await f.invoke('send_message', { text, mentionUserIds: [userId, userId, '444444'], replyToMessageId: '-12345' });
  assert.deepEqual(f.calls.map(call => call.params.user_id), [userId, '444444']);
  assert.deepEqual(f.sent, [{ text, mentionUserIds: [userId, '444444'], replyToMessageId: '-12345' }]);
  assert.equal(result.executed, true); assert.equal(result.status, 'sent'); assert.equal(result.messageId, '-9988');
  const simple = fixture(); await simple.invoke('send_message', { text: '普通消息' });
  assert.deepEqual(simple.sent[0], { text: '普通消息', mentionUserIds: [] }); assert.equal(simple.calls.length, 0);
});

test('reply and reaction targets must be signed IDs in the current verified and still-visible cache', async () => {
  const f = fixture();
  const result = await f.invoke('react_message', { messageId: '-12345', emojiId: '66', set: false });
  assert.deepEqual(f.calls, [{ name: 'set_msg_emoji_like', params: { message_id: '-12345', emoji_id: '66', set: false } }]);
  assert.equal(result.executed, true); assert.equal(result.status, 'applied');
  for (const hiddenRows of [[], [row({ actualQQ: '999999' })], [row({ groupId: '888888' })], [row({ role: 'assistant', userId: actualQQ, delivery: 'failed' })],
    [row({ isNotice: true })], [row({ time: Math.floor(Date.now() / 1000) - 31 * 86400 })]]) {
    const hidden = fixture({ rows: hiddenRows });
    await assert.rejects(hidden.invoke('react_message', { messageId: '-12345', emojiId: '66', set: true }), isDenied);
    assert.equal(hidden.calls.length, 0);
    await assert.rejects(hidden.invoke('send_message', { text: '不能引用隐藏消息', replyToMessageId: '-12345' }), isDenied);
    assert.equal(hidden.sent.length, 0);
  }
});

test('real SQLite conversation clear revokes cached message actions without get_msg or cross-group fallback', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-fixed-actions-')), store = createStore(directory);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  store.conversation.record(row()); store.conversation.record(row({ groupId: '888888', messageId: '-99999' }));
  const f = fixture({ store });
  await f.invoke('react_message', { messageId: '-12345', emojiId: '66', set: true });
  await assert.rejects(f.invoke('react_message', { messageId: '-99999', emojiId: '66', set: true }), isDenied);
  const current = store.conversationState.get({ actualQQ, groupId });
  store.conversationState.clear({ actualQQ, groupId, version: current.version });
  await assert.rejects(f.invoke('react_message', { messageId: '-12345', emojiId: '66', set: false }), isDenied);
  assert.deepEqual(f.calls.map(call => call.name), ['set_msg_emoji_like']);
});

test('unknown parameters, @all, arbitrary segments, invalid signed IDs and out-of-range inputs never dispatch', async () => {
  const f = fixture();
  for (const [name, args] of [
    ['poke_member', { userId, groupId: '888888' }], ['poke_member', { userId: 'all' }], ['poke_member', { userId: '0000' }],
    ['send_message', { text: 'x', message: [{ type: 'at', data: { qq: 'all' } }] }],
    ['send_message', { text: 'x', mentionUserIds: ['all'] }], ['send_message', { text: 'x', mentionUserIds: [userId, '444444', '555555', '666666'] }],
    ['send_message', { text: ' ' }], ['send_message', { text: 'x'.repeat(1801) }], ['send_message', { text: 'x', replyToMessageId: 'out:fake' }],
    ['react_message', { messageId: '0', emojiId: '66', set: true }], ['react_message', { messageId: '-12345', emojiId: '-1', set: true }],
    ['react_message', { messageId: '-12345', emojiId: '66', set: true, action: 'delete_msg' }],
    ['current_group_members', { limit: 51 }], ['current_group_member', { userId: 'all' }],
  ]) await assert.rejects(f.invoke(name, args), isInvalid, `${name} ${JSON.stringify(args)}`);
  assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
});

test('definite missing-member errors are business refusals while transport errors retain their original identity', async () => {
  const absent = Object.assign(new Error('member not found'), { code: 'GROUP_MEMBER_NOT_FOUND' });
  const missing = fixture({ action: async () => { throw absent; } });
  await assert.rejects(missing.invoke('poke_member', { userId }), isDenied);
  assert.equal(missing.calls.length, 1);
  const transport = Object.assign(new Error('member lookup socket closed'), { code: 'ECONNRESET' });
  const offline = fixture({ action: async () => { throw transport; } });
  await assert.rejects(offline.invoke('poke_member', { userId }), error => error === transport);
  assert.equal(transport.deliveryUncertain, undefined); assert.equal(offline.calls.length, 1);
  const writeTimeout = Object.assign(new Error('poke response timed out'), { code: 'ONEBOT_TIMEOUT' });
  const uncertain = fixture({ action: async name => { if (name === 'get_group_member_info') return person(); throw writeTimeout; } });
  await assert.rejects(uncertain.invoke('poke_member', { userId }), error => error === writeTimeout && error.deliveryUncertain === true);
  assert.equal(uncertain.calls.filter(call => call.name === 'group_poke').length, 1, 'uncertain writes must never retry');
});

test('revocation or clear while a member/cache read is pending passes through authorization and prevents every write', async () => {
  const entered = deferred(), pending = deferred(); let permitted = true;
  const revoked = Object.assign(new Error('scope changed'), { code: 'AUTH_REVOKED', statusCode: 409 });
  const f = fixture({ authorize: () => { if (!permitted) throw revoked; }, action: async () => { entered.resolve(); return pending.promise; } });
  const running = f.invoke('poke_member', { userId }); await entered.promise; permitted = false; pending.resolve(person());
  await assert.rejects(running, error => error === revoked);
  assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 0);
  const cacheEntered = deferred(), cachePending = deferred(); let cacheAllowed = true;
  const cleared = fixture({ authorize: () => { if (!cacheAllowed) throw revoked; }, filter: async () => { cacheEntered.resolve(); return cachePending.promise; } });
  const reaction = cleared.invoke('react_message', { messageId: '-12345', emojiId: '66', set: true });
  await cacheEntered.promise; cacheAllowed = false; cachePending.resolve([row()]);
  await assert.rejects(reaction, error => error === revoked); assert.equal(cleared.calls.length, 0);
});

test('a lost response after write submission stays uncertain and never becomes a safe-denial object', async () => {
  const entered = deferred(), pending = deferred(); let permitted = true;
  const revoked = Object.assign(new Error('cleared after action submission'), { statusCode: 409, code: 'AUTH_REVOKED' });
  const f = fixture({ authorize: () => { if (!permitted) throw revoked; }, action: async name => {
    if (name === 'get_group_member_info') return person(); entered.resolve(); return pending.promise;
  } });
  const action = f.invoke('poke_member', { userId }); await entered.promise; permitted = false; pending.resolve(null);
  await assert.rejects(action, error => error === revoked && error.deliveryUncertain === true);
  assert.equal(f.calls.filter(call => call.name === 'group_poke').length, 1);
  const controller = new AbortController(); controller.abort(); const stopped = fixture({ signal: controller.signal });
  await assert.rejects(stopped.invoke('poke_member', { userId }), error => error.code !== 'QQ_ACTION_DENIED');
  assert.equal(stopped.calls.length, 0);
});
