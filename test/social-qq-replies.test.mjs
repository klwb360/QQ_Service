import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { createSocialRuntime } from '../src/social-runtime.mjs';
import { createQqMcpSession } from '../src/qq-mcp-server.mjs';
import { toolFunctionName } from '../src/tool-router.mjs';

const QQ = '999999', GROUP = '222222', USER = '555555';
const STICKER = 'qq:send_sticker';
const sticker = { id: STICKER, source: 'qq', remoteName: 'send_sticker', name: toolFunctionName(STICKER),
  effect: 'write', description: 'Send an approved QQ sticker', inputSchema: { type: 'object', properties: {
    assetId: { type: 'string' },
  }, required: ['assetId'], additionalProperties: false } };
const externalWrite = { id: 'mcp:external:write', source: 'mcp', remoteName: 'write', name: 'external_write',
  effect: 'write', description: 'Write to a separate application', inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
const decision = (action = 'silent', fields = {}) => ({ text: JSON.stringify({ action, text: '', reason: 'test decision',
  topic: '群聊', memoryCandidates: [], experienceCandidates: [], ...fields }) });
const callSticker = () => ({ text: '', toolCalls: [{ id: 'reply-sticker', type: 'function',
  function: { name: sticker.name, arguments: JSON.stringify({ assetId: 'approved-sticker' }) } }] });
const deferred = () => Promise.withResolvers();
const waitFor = async predicate => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('social QQ reply test timed out');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
};

function fixture({ owner = true, autonomous = false, infer, execute, grantExternal = false } = {}) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.botQQ = QQ; config.chat.enabled = config.models.deepseek.enabled = true;
  config.chat.contextMessages = 0; config.chat.social.batchMs = 5;
  config.tools.enabled = grantExternal; config.tools.catalogMode = 'all';
  config.groups = [{ id: GROUP, read: true, send: true, triggers: ['mention'],
    social: { enabled: true, proactive: autonomous, activeStart: '00:00', activeEnd: '00:00', proactiveIntervalMinutes: 1 } }];
  const tasks = new Map([[`social-state:${QQ}:${GROUP}`, { lastCheck: Date.now() - 120000 }]]);
  const requests = [], executions = [], actions = [], sends = [], memorySuggestions = [], experienceSuggestions = [];
  let revision = 0, sequence = 0, behavior = infer, session = { actualQQ: QQ, groupId: GROUP,
    topic: '', participants: [], pendingTopics: [], version: 0, expired: false };
  const store = { getTask: key => tasks.get(key), setTask: (key, value) => tasks.set(key, structuredClone(value)),
    conversation: { list: async () => [] },
    conversationState: { get: () => session, observe: input => {
      // No synthetic assistant row: a sticker/poke is not human evidence.
      session = { ...session, topic: input.topic || '', version: session.version + 1,
        participants: [{ userId: USER, role: 'user', displayName: '群友', lastSeenAt: new Date().toISOString() }] };
      return session;
    } },
    memory: { getGroup: () => ({ enabled: false }), relevant: async () => [], suggest: async value => { memorySuggestions.push(value); } },
    experiences: { getGroup: () => ({ enabled: true }), relevant: async () => [], suggest: async value => { experienceSuggestions.push(value); return []; } },
  };
  const authorize = (signal, scope) => {
    if (signal.aborted || !config.groups[0].send || scope.memoryRevision !== revision) throw Object.assign(new Error('reply scope revoked'), { status: 409 });
  };
  const runtime = createSocialRuntime({ getConfig: () => config, getIdentity: () => QQ, getEpoch: () => 1, getContextRevision: () => revision,
    store, gate: () => { if (!config.groups[0].send) throw new Error('group permission revoked'); },
    listTools: () => grantExternal ? [externalWrite] : [], grantedTools: () => grantExternal ? [externalWrite] : [],
    ...(owner ? { replyTools: () => [sticker] } : {}),
    infer: async (provider, messages, signal, options) => {
      await options.beforeCall();
      const request = { messages: structuredClone(messages), tools: structuredClone(options.tools || []) };
      requests.push(request);
      return behavior ? behavior(request, requests.length) : messages.some(message => message.role === 'tool') ? decision() : callSticker();
    },
    executeTool: async (id, args, signal, epoch, scope) => {
      executions.push({ id, args, scope });
      assert.equal(id, STICKER, 'the owner QQ reply scope cannot execute an external write');
      const connection = await createQqMcpSession({ tools: [sticker], signal,
        authorize: () => authorize(signal, scope), execute: async () => {
          if (execute) await execute({ signal, scope });
          authorize(signal, scope); scope.onWriteDispatch?.();
          actions.push({ id, args });
          return { executed: true, status: 'sent', action: 'send_sticker', messageId: '30001' };
        } });
      try { return await connection.callTool(id, args); }
      finally { await connection.close(); }
    },
    send: async (...args) => { sends.push(args); },
  });
  return { runtime, config, requests, executions, actions, sends, memorySuggestions, experienceSuggestions, tasks,
    setInfer(value) { behavior = value; },
    async emit(input = {}) {
      return runtime.handle({ messageType: 'group', groupId: GROUP, userId: USER, messageId: `request-${++sequence}`,
        text: '今天聊得挺开心', mentioned: true, time: Math.floor(Date.now() / 1000), ...input }, { action: 'social' });
    },
    clear() { revision++; session = { ...session, participants: [], topic: '', version: session.version + 1 }; runtime.invalidateMemory({ actualQQ: QQ, groupId: GROUP, clearConversation: true }); },
    async idle() { await waitFor(() => !runtime.status().running && !runtime.status().pending); },
    close() { runtime.stop(); },
  };
}

test('owner-approved QQ sticker plus silent maintains follow-ups without fabricating human memory or experiences', async () => {
  const f = fixture({ infer: request => request.messages.some(message => message.role === 'tool') ? decision('silent', {
    memoryCandidates: [{ userId: USER, kind: 'fact', text: '工具输出不能成为人类事实', sourceIds: ['request-1'] }],
    experienceCandidates: [{ kind: 'interaction', text: '未确认的工具经历', sourceIds: ['request-1'] }],
  }) : callSticker() });
  try {
    await f.emit({ text: '' }); await f.idle();
    assert.equal(f.actions.length, 1); assert.equal(f.sends.length, 0);
    assert.equal(f.executions[0].scope.replyInvocation, true);
    assert.equal(f.executions[0].scope.explicitRequested, false);
    assert.ok(f.runtime.status().groups[0].lastReplyAt > 0);
    assert.equal(f.memorySuggestions.length, 0); assert.equal(f.experienceSuggestions.length, 0);
    f.setInfer(() => decision());
    await f.emit({ mentioned: false, text: '那你接着说呢' }); await f.idle();
    const packet = JSON.parse(f.requests.at(-1).messages.find(message => message.role === 'user').content);
    assert.equal(packet.request[0].followUp, true, 'a non-text QQ reply still opens the same member follow-up window');
    await f.emit({ mentioned: false, text: '刚才那个话题再聊一下' }); await f.idle();
    const third = JSON.parse(f.requests.at(-1).messages.find(message => message.role === 'user').content);
    assert.equal(third.request[0].followUp, true, 'a silent continuation must not erase a real action’s still-valid follow-up window');
  } finally { f.close(); }
});

test('without the new callback free chat keeps its former text-only tool authorization behavior', async () => {
  const f = fixture({ owner: false, infer: request => { assert.deepEqual(request.tools, []); return decision(); } });
  try {
    await f.emit(); await f.idle();
    assert.equal(f.executions.length, 0); assert.equal(f.sends.length, 0);
    assert.equal(f.runtime.status().groups[0].lastReplyAt, 0);
  } finally { f.close(); }
});

test('multi-author batches may use the owner QQ reply but cannot borrow one author’s external write authorization', async () => {
  const f = fixture({ grantExternal: true, infer: request => {
    assert.ok(request.tools.every(tool => tool.function.name !== externalWrite.name));
    return request.messages.some(message => message.role === 'tool') ? decision() : callSticker();
  } });
  try {
    f.config.chat.social.batchMs = 20;
    await f.emit({ mentionedUserIds: ['777777'], replyTarget: { messageId: '111', userId: '777777', displayName: '成员甲' } });
    await f.emit({ userId: '666666', mentionedUserIds: ['888888'] });
    await f.idle();
    assert.equal(f.actions.length, 1);
    assert.equal(f.executions[0].scope.replyInvocation, true); assert.equal(f.executions[0].scope.explicitRequested, false);
    const packet = JSON.parse(f.requests[0].messages.find(message => message.role === 'user').content);
    assert.deepEqual(packet.request.map(request => request.verifiedTargets.mentionedUserIds), [['777777'], ['888888']]);
    assert.equal(packet.request[0].verifiedTargets.replyTarget.userId, '777777');
    assert.equal(packet.request[1].verifiedTargets.replyTarget, null);
  } finally { f.close(); }
});

test('autonomous QQ replies use a host turn identity with no forged user and count once toward proactive replies', async () => {
  const f = fixture({ autonomous: true, grantExternal: true });
  try {
    await f.runtime.tick();
    assert.equal(f.actions.length, 1);
    const scope = f.executions[0].scope;
    assert.equal(scope.invocation, 'autonomous'); assert.equal(scope.replyInvocation, true);
    assert.equal(scope.userId, undefined); assert.equal(scope.explicitRequested, false);
    assert.match(scope.messageId, /^social-reply:[a-f0-9-]{36}$/u);
    assert.equal(f.tasks.get(`social-state:${QQ}:${GROUP}`).replies.length, 1);
    assert.equal(f.sends.length, 0); assert.ok(f.runtime.status().groups[0].lastReplyAt > 0);
  } finally { f.close(); }
});

test('a denied owner reply does not invent delivery, completed writes or a follow-up window', async () => {
  const f = fixture({ execute: () => { throw Object.assign(new Error('no approved sticker available'), { code: 'QQ_ACTION_DENIED', statusCode: 403 }); } });
  try {
    await f.emit(); await f.idle();
    assert.equal(f.actions.length, 0); assert.equal(f.sends.length, 0);
    assert.equal(f.runtime.status().groups[0].lastReplyAt, 0);
    const outcome = JSON.parse(f.requests[1].messages.find(message => message.role === 'tool').content);
    assert.equal(outcome.executed, false); assert.equal(outcome.status, 'denied');
    f.setInfer(() => decision());
    await f.emit({ mentioned: false }); await f.idle();
    const packet = JSON.parse(f.requests.at(-1).messages.find(message => message.role === 'user').content);
    assert.equal(packet.request[0].followUp, false);
  } finally { f.close(); }
});

test('clearing a reply while its preflight waits prevents dispatch, continuation and fixed write receipts', async () => {
  const entered = deferred(), resumed = deferred();
  const f = fixture({ execute: async () => { entered.resolve(); await resumed.promise; } });
  try {
    await f.emit(); await entered.promise;
    f.clear(); resumed.resolve(); await f.idle();
    assert.equal(f.actions.length, 0); assert.equal(f.requests.length, 1); assert.equal(f.sends.length, 0);
    assert.equal(f.runtime.status().groups[0].lastReplyAt, 0);
  } finally { resumed.resolve(); f.close(); }
});
