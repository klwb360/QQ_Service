import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { createStore } from '../src/store.mjs';
import { createRuntime } from '../src/runtime.mjs';
import { toolCallFingerprint, toolFunctionName } from '../src/tool-router.mjs';

const SEND = 'qq:send_message', POKE = 'qq:poke_member', REACT = 'qq:react_message';
const MEMBERS = 'qq:current_group_members', MEMBER = 'qq:current_group_member';
const scope = { actualQQ: '999999', groupId: '222222' };
const caller = '555555', target = '666666';
const deferred = () => Promise.withResolvers();
const waitFor = async (predicate, immediate = false) => {
  const deadline = Date.now() + 6000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('QQ action runtime fixture timed out');
    await new Promise(resolve => immediate ? setImmediate(resolve) : setTimeout(resolve, 5));
  }
};
const propose = (id, args) => ({ provider: 'deepseek', text: '', toolCalls: [{ id: 'qq-action-call', type: 'function',
  function: { name: toolFunctionName(id), arguments: JSON.stringify(args) } }] });

async function fixture({ id = POKE, args = { userId: target }, respond, infer } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-service-qq-actions-'));
  const store = createStore(directory), server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  const config = structuredClone(DEFAULT_CONFIG);
  config.botQQ = scope.actualQQ; config.qq.enabled = true; config.qq.wsUrl = `ws://127.0.0.1:${server.address().port}`;
  config.permissions.released = true; config.chat.enabled = true; config.models.deepseek.enabled = true;
  config.groups = [{ id: scope.groupId, name: '当前授权群', mode: 'social', read: true, send: true,
    triggers: [], cooldownSeconds: 0, probability: 0, social: { enabled: false, proactive: false, readTools: [] } }];
  config.tools = { ...config.tools, enabled: true, builtinQQ: true, catalogMode: 'all', triggers: ['command'], prefix: '/工具',
    grants: [SEND, POKE, REACT, MEMBERS, MEMBER].map(tool => ({ tool, groupIds: [scope.groupId],
      userIds: [caller], allowWrite: [SEND, POKE, REACT].includes(tool) })) };
  store.saveDraft(config); store.commitDraft();
  const actions = [], requests = [], logs = [];
  const knownMembers = new Map([caller, target, scope.actualQQ].map(userId => [userId,
    { user_id: Number(userId), group_id: Number(scope.groupId), nickname: `群友${userId}`, card: '', role: 'member' }]));
  let peer, sequence = 0, received = 0, sent = 0;
  server.on('connection', socket => {
    peer = socket;
    socket.on('message', async raw => {
      const packet = JSON.parse(raw.toString()); actions.push(packet);
      let result;
      try { result = await respond?.(packet, socket); }
      catch (error) { logs.push(['mock-response-failure', error.message]); return; }
      if (result === false || socket.readyState !== socket.OPEN) return;
      if (result === undefined) {
        let data = null;
        if (packet.action === 'get_login_info') data = { user_id: Number(scope.actualQQ) };
        else if (packet.action === 'get_group_member_list') data = [...knownMembers.values()];
        else if (packet.action === 'get_group_member_info') {
          data = knownMembers.get(String(packet.params.user_id));
          if (!data) result = { status: 'failed', retcode: 1200, message: 'member not found', data: null };
        } else if (packet.action === 'send_group_msg') data = { message_id: String(90000 + ++sent) };
        result ||= { status: 'ok', retcode: 0, data };
      }
      socket.send(JSON.stringify({ echo: packet.echo, ...result }));
    });
  });
  const runtime = createRuntime({ profileId: 'qq-actions-fixture', getConfig: () => config, getSecret: () => 'fixture-key',
    store, installer: {}, log: (...entry) => logs.push(entry), providers: { deepseek: async input => {
      requests.push(structuredClone({ messages: input.messages, tools: input.tools }));
      return infer ? infer(input, requests.length) : input.messages.some(message => message.role === 'tool')
        ? { provider: 'deepseek', text: '这次操作的结果我已经确认了。' } : propose(id, args);
    } } });
  await runtime.connect();
  return { config, runtime, store, actions, requests, logs,
    seed(text, fields = {}) {
      const message = { ...scope, messageId: String(10000 + ++sequence), userId: caller, role: 'user', text,
        time: Math.floor(Date.now() / 1000), displayName: '真实群友', ...fields };
      store.conversation.record(message); return message;
    },
    emit(fields = {}) {
      received++;
      peer.send(JSON.stringify({ post_type: 'message', message_type: 'group', self_id: Number(scope.actualQQ),
        group_id: Number(scope.groupId), user_id: Number(caller), message_id: String(20000 + ++sequence),
        time: Math.floor(Date.now() / 1000), message: '/工具 请完成这次明确操作', ...fields }));
    },
    async idle() {
      await waitFor(() => runtime.status().metrics.received >= received);
      await new Promise(resolve => setImmediate(resolve));
      await waitFor(() => !runtime.status().queue.running && !runtime.status().queue.pending);
      await new Promise(resolve => setImmediate(resolve));
    },
    async close() {
      runtime.stop(); for (const socket of server.clients) socket.terminate();
      await new Promise(resolve => server.close(resolve)); store.close(); fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

const writes = f => f.actions.filter(packet => ['send_group_msg', 'group_poke', 'set_msg_emoji_like'].includes(packet.action));
const resultOf = f => {
  const request = f.requests.find(request => request.messages.some(message => message.role === 'tool'));
  assert.ok(request, 'the model receives a structured tool result before giving its own final reply');
  return JSON.parse(request.messages.find(message => message.role === 'tool').content);
};
const socialDecision = (action, text = '') => ({ provider: 'deepseek', text: JSON.stringify({
  action, text, reason: '根据本轮真实工具结果决定如何接话', topic: '当前群互动', memoryCandidates: [], experienceCandidates: [],
}) });
const enableSocial = f => {
  f.config.groups[0].social = { ...f.config.groups[0].social, enabled: true, activeStart: '00:00', activeEnd: '00:00' };
  f.config.chat.social.batchMs = 5;
};

test('QQ send builds real at/reply segments while model CQ text remains literal and the destination stays bound', async () => {
  const text = '给你看看 [CQ:at,qq=all] 和 [CQ:image,file=file:///private]';
  const f = await fixture({ id: SEND, args: { text, mentionUserIds: [target], replyToMessageId: '10001' } });
  try {
    f.seed('可以引用的本群原话', { messageId: '10001' });
    f.emit(); await f.idle();
    const sends = writes(f).filter(packet => packet.action === 'send_group_msg');
    assert.equal(sends.length, 2, 'the requested send and model final reply each deliver once');
    const segments = sends[0].params.message;
    assert.equal(String(sends[0].params.group_id), scope.groupId);
    assert.deepEqual(segments.filter(segment => segment.type === 'at').map(segment => String(segment.data.qq)), [target]);
    assert.deepEqual(segments.filter(segment => segment.type === 'reply').map(segment => String(segment.data.id)), ['10001']);
    assert.ok(segments.filter(segment => segment.type === 'text').map(segment => segment.data.text).join('').includes(text));
    assert.ok(segments.every(segment => ['text', 'at', 'reply'].includes(segment.type)));
    assert.ok(f.actions.some(packet => packet.action === 'get_group_member_info'
      && String(packet.params.group_id) === scope.groupId && String(packet.params.user_id) === target));
    assert.equal(resultOf(f).executed, true);
  } finally { await f.close(); }
});

test('a non-member mention is refused before sending and the model can explain the refusal naturally', async () => {
  const f = await fixture({ id: SEND, args: { text: '不能投递的正文', mentionUserIds: ['777777'] } });
  try {
    f.emit(); await f.idle();
    const result = resultOf(f);
    assert.notEqual(result.executed, true);
    assert.equal(writes(f).length, 1, 'only the model final reply is sent');
    assert.ok(!JSON.stringify(writes(f)).includes('不能投递的正文'));
    assert.equal(f.requests.length, 2);
  } finally { await f.close(); }
});

test('a message ID cached only in another group cannot authorize a reaction but remains conversationally recoverable', async () => {
  const f = await fixture({ id: REACT, args: { messageId: '30001', emojiId: '66', set: true } });
  try {
    f.seed('其他群的原文', { groupId: '333333', messageId: '30001' });
    f.emit(); await f.idle();
    assert.notEqual(resultOf(f).executed, true);
    assert.equal(f.actions.filter(packet => packet.action === 'set_msg_emoji_like').length, 0);
    assert.equal(f.requests.length, 2);
    assert.ok(!JSON.stringify(f.requests).includes('其他群的原文'));
    assert.ok(writes(f).every(packet => String(packet.params.group_id) === scope.groupId));
  } finally { await f.close(); }
});

test('QQ reaction preserves set:false and a verified current-group message ID', async () => {
  const f = await fixture({ id: REACT, args: { messageId: '30002', emojiId: '66', set: false } });
  try {
    f.seed('需要取消表情回应的消息', { messageId: '30002' });
    f.emit(); await f.idle();
    const reactions = f.actions.filter(packet => packet.action === 'set_msg_emoji_like');
    assert.equal(reactions.length, 1);
    assert.deepEqual(reactions[0].params, { message_id: '30002', emoji_id: '66', set: false });
    assert.equal(resultOf(f).executed, true);
  } finally { await f.close(); }
});

test('a timed-out poke remains unknown, never retries and cannot change the bound group or target', async t => {
  const f = await fixture({ respond: packet => {
    if (packet.action === 'group_poke') return false;
  } });
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    f.emit({ message_id: '40009' }); await waitFor(() => f.actions.some(packet => packet.action === 'group_poke'), true);
    t.mock.timers.tick(15_001);
    t.mock.timers.reset();
    await f.idle();
    const pokes = f.actions.filter(packet => packet.action === 'group_poke');
    assert.equal(pokes.length, 1);
    assert.equal(String(pokes[0].params.group_id), scope.groupId);
    assert.equal(String(pokes[0].params.user_id), target);
    assert.equal(f.requests.length, 1, 'an uncertain external write cannot become another model action');
    const identity = createHash('sha256').update(JSON.stringify([scope.actualQQ, scope.groupId, '40009'])).digest('hex');
    const receipt = await f.store.getTask(`tool-write:${identity}:${toolCallFingerprint(POKE, { userId: target })}`);
    assert.equal(receipt.state, 'attempted', 'a missing acknowledgement must never be marked returned');
  } finally { t.mock.timers.reset(); await f.close(); }
});

test('clearing the current session during member preflight stops the write and excludes its late result from the model', async () => {
  const resumed = deferred();
  const f = await fixture({ respond: async packet => {
    if (packet.action === 'get_group_member_info') await resumed.promise;
  } });
  try {
    f.emit(); await waitFor(() => f.actions.some(packet => packet.action === 'get_group_member_info'));
    f.store.conversationState.clear(scope);
    f.runtime.invalidateMemory({ ...scope, clearConversation: true });
    resumed.resolve(); await f.idle();
    assert.equal(f.actions.filter(packet => packet.action === 'group_poke').length, 0);
    assert.equal(f.requests.length, 1);
    assert.equal(writes(f).length, 0);
  } finally { resumed.resolve(); await f.close(); }
});

test('revoking account send permission while a poke is in flight blocks late reasoning and QQ replies', async () => {
  const resumed = deferred();
  const f = await fixture({ respond: async packet => {
    if (packet.action === 'group_poke') await resumed.promise;
  } });
  try {
    f.emit(); await waitFor(() => f.actions.some(packet => packet.action === 'group_poke'));
    f.config.permissions.released = false;
    resumed.resolve(); await f.idle();
    assert.equal(f.actions.filter(packet => packet.action === 'group_poke').length, 1);
    assert.equal(f.requests.length, 1);
    assert.equal(f.actions.filter(packet => packet.action === 'send_group_msg').length, 0);
  } finally { resumed.resolve(); await f.close(); }
});

test('the same QQ request cannot repeat a successful write after runtime reload', async () => {
  const f = await fixture();
  try {
    f.emit({ message_id: '40001' }); await f.idle();
    assert.equal(f.actions.filter(packet => packet.action === 'group_poke').length, 1);
    await f.runtime.reload(); await f.runtime.connect();
    f.emit({ message_id: '40001' }); await f.idle();
    assert.equal(f.actions.filter(packet => packet.action === 'group_poke').length, 1);
  } finally { await f.close(); }
});

test('free-chat QQ business denials remain data and the model may naturally reply or stay silent', async t => {
  for (const action of ['reply', 'silent']) await t.test(action, async () => {
    const finalText = action === 'reply' ? '这个成员不在当前群里，我先不戳啦。' : '';
    const f = await fixture({ id: POKE, args: { userId: '777777' }, infer: input =>
      input.messages.some(message => message.role === 'tool') ? socialDecision(action, finalText) : propose(POKE, { userId: '777777' }) });
    try {
      enableSocial(f);
      f.emit(); await f.idle();
      const result = resultOf(f);
      assert.equal(result.status, 'denied'); assert.equal(result.executed, false);
      assert.equal(f.requests.length, 2);
      assert.equal(f.actions.filter(packet => packet.action === 'group_poke').length, 0);
      const sent = f.actions.filter(packet => packet.action === 'send_group_msg');
      assert.equal(sent.length, action === 'reply' ? 1 : 0);
      if (sent.length) assert.equal(sent[0].params.message.map(segment => segment.data.text || '').join(''), finalText);
      assert.ok(!JSON.stringify(sent).includes('可能已生效'));
      assert.ok(!JSON.stringify(sent).includes('操作已执行'));
    } finally { await f.close(); }
  });
});

test('free-chat session clear during preflight or after a denial cancels quietly without inventing a completed write', async t => {
  for (const phase of ['member-lookup', 'denied-continuation']) await t.test(phase, async () => {
    const resumed = deferred();
    const f = await fixture({ id: POKE, args: { userId: '777777' },
      respond: async packet => { if (phase === 'member-lookup' && packet.action === 'get_group_member_info') await resumed.promise; },
      infer: async input => {
        if (!input.messages.some(message => message.role === 'tool')) return propose(POKE, { userId: '777777' });
        await resumed.promise;
        return socialDecision('reply', '不应在清空旧会话后发送的解释');
      } });
    try {
      enableSocial(f);
      f.emit();
      await waitFor(() => phase === 'member-lookup'
        ? f.actions.some(packet => packet.action === 'get_group_member_info')
        : f.requests.some(request => request.messages.some(message => message.role === 'tool')));
      if (phase === 'denied-continuation') assert.equal(resultOf(f).status, 'denied');
      f.store.conversationState.clear(scope);
      f.runtime.invalidateMemory({ ...scope, clearConversation: true });
      resumed.resolve(); await f.idle();
      assert.equal(f.actions.filter(packet => packet.action === 'group_poke').length, 0);
      assert.equal(f.actions.filter(packet => packet.action === 'send_group_msg').length, 0,
        'a preflight refusal must not produce an executed/possibly-effective fixed receipt');
      assert.equal(f.requests.length, phase === 'member-lookup' ? 1 : 2);
    } finally { resumed.resolve(); await f.close(); }
  });
});

test('an expired MCP call cancels late member preflight before it can send a queued QQ message', async t => {
  const pendingMembers = [deferred(), deferred(), deferred()];
  const text = 'MCP调用已过期，这段正文绝不能晚到发送';
  let memberLookups = 0;
  const f = await fixture({ id: SEND, args: { text, mentionUserIds: [caller, target, scope.actualQQ] }, respond: async packet => {
    if (packet.action === 'get_group_member_info') {
      const index = memberLookups++;
      assert.ok(index < pendingMembers.length, 'member preflight must not be retried');
      await pendingMembers[index].promise;
    }
  } });
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    f.emit();
    await waitFor(() => memberLookups === 1, true);
    t.mock.timers.tick(14_000); pendingMembers[0].resolve();
    await waitFor(() => memberLookups === 2, true);
    t.mock.timers.tick(14_000); pendingMembers[1].resolve();
    await waitFor(() => memberLookups === 3, true);
    // The MCP operation expires at 30s; the third OneBot lookup is still well
    // inside its own 15s timeout. Its later reply cannot revive that operation.
    t.mock.timers.tick(2500);
    await waitFor(() => f.logs.some(entry => String(entry[0]).includes('工具调用失败')), true);
    pendingMembers[2].resolve();
    t.mock.timers.reset();
    await f.idle();
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(memberLookups, 3);
    assert.equal(f.requests.length, 1, 'an expired MCP operation must not resume the model');
    const sent = f.actions.filter(packet => packet.action === 'send_group_msg');
    assert.ok(!JSON.stringify(sent).includes(text));
    assert.ok(sent.every(packet => packet.params.message.every(segment => segment.type === 'text')),
      'a fixed failure receipt may be sent, but no late tool message or its mentions may dispatch');
    assert.equal(f.actions.filter(packet => ['group_poke', 'set_msg_emoji_like'].includes(packet.action)).length, 0);
  } finally {
    t.mock.timers.reset(); pendingMembers.forEach(item => item.resolve()); await f.close();
  }
});
