import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelLimiter, createSocialRuntime } from '../src/social-runtime.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(complete => { resolve = complete; });
  return { promise, resolve };
}

test('账号模型槽按优先级选择等待请求，同优先级保持提交顺序', async () => {
  const limiter = createModelLimiter();
  const blocked = deferred(), entered = deferred();
  const order = [];
  const first = limiter.run(undefined, 2, async () => {
    order.push('already-running'); entered.resolve(); await blocked.promise; return 'first';
  });
  await entered.promise;
  const background = limiter.run(undefined, 2, () => { order.push('background'); return 'background'; });
  const directOne = limiter.run(undefined, 0, () => { order.push('direct-1'); return 'direct-1'; });
  const directTwo = limiter.run(undefined, 0, () => { order.push('direct-2'); return 'direct-2'; });
  blocked.resolve();
  assert.deepEqual(await Promise.all([first, background, directOne, directTwo]), ['first', 'background', 'direct-1', 'direct-2']);
  assert.deepEqual(order, ['already-running', 'direct-1', 'direct-2', 'background']);
});

test('多个群同时请求时全账号最多一个模型回调执行', async () => {
  const limiter = createModelLimiter();
  const blocked = deferred(), entered = deferred();
  let active = 0, maximum = 0, finished = 0;
  const requests = Array.from({ length: 8 }, (_, index) => limiter.run(undefined, index % 3, async () => {
    active++; maximum = Math.max(maximum, active); entered.resolve();
    try { await blocked.promise; return index; }
    finally { active--; finished++; }
  }));
  await entered.promise;
  assert.equal(active, 1);
  assert.equal(finished, 0);
  blocked.resolve();
  assert.deepEqual(await Promise.all(requests), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(maximum, 1);
  assert.equal(active, 0);
  assert.equal(finished, 8);
});

test('已取消或等待中取消的请求不会执行，也不会阻塞后续模型请求', async () => {
  const limiter = createModelLimiter();
  const alreadyAborted = new AbortController(); alreadyAborted.abort();
  let canceledExecutions = 0;
  await assert.rejects(limiter.run(alreadyAborted.signal, 0, () => { canceledExecutions++; }), /已取消/);
  const blocked = deferred(), entered = deferred();
  const first = limiter.run(undefined, 1, async () => { entered.resolve(); await blocked.promise; });
  await entered.promise;
  const waitingAbort = new AbortController();
  const waiting = limiter.run(waitingAbort.signal, 0, () => { canceledExecutions++; });
  const rejection = assert.rejects(waiting, /已取消/);
  const after = limiter.run(undefined, 2, () => 'next group');
  waitingAbort.abort();
  await rejection;
  assert.equal(canceledExecutions, 0);
  blocked.resolve();
  await first;
  assert.equal(await after, 'next group');
  assert.equal(canceledExecutions, 0);
});

test('异步失败和同步异常均释放模型槽并保留错误', async () => {
  const limiter = createModelLimiter();
  const firstFailure = new Error('provider failed');
  const secondFailure = new Error('synchronous provider failed');
  const requests = [
    limiter.run(undefined, 0, async () => { throw firstFailure; }),
    limiter.run(undefined, 0, () => { throw secondFailure; }),
    limiter.run(undefined, 0, () => 42),
  ];
  const result = await Promise.allSettled(requests);
  assert.equal(result[0].status, 'rejected'); assert.equal(result[0].reason, firstFailure);
  assert.equal(result[1].status, 'rejected'); assert.equal(result[1].reason, secondFailure);
  assert.deepEqual(result[2], { status: 'fulfilled', value: 42 });
});

test('等待队列有界，取消等待请求后可接纳新请求', async () => {
  const limiter = createModelLimiter(1);
  const blocked = deferred(), entered = deferred();
  const first = limiter.run(undefined, 1, async () => { entered.resolve(); await blocked.promise; });
  await entered.promise;
  const waitingAbort = new AbortController();
  const waiting = limiter.run(waitingAbort.signal, 2, () => 'canceled');
  const rejection = assert.rejects(waiting, /已取消/);
  await assert.rejects(limiter.run(undefined, 0, () => 'overflow'), /队列已满/);
  waitingAbort.abort(); await rejection;
  const accepted = limiter.run(undefined, 0, () => 'accepted after cancel');
  blocked.resolve(); await first;
  assert.equal(await accepted, 'accepted after cancel');
});

async function memoryLookup(context, inputs, { autonomous = false } = {}) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.chat.enabled = config.models.deepseek.enabled = true;
  config.chat.contextMessages = 50;
  config.chat.social.batchMs = 0;
  config.groups = [{ id: '222222', read: true, send: true, triggers: ['mention', 'poke'],
    social: { enabled: true, proactive: autonomous, activeStart: '00:00', activeEnd: '00:00' } }];
  const completed = deferred(), queries = [], requests = [], scopes = [];
  const runtime = createSocialRuntime({ getConfig: () => config, getIdentity: () => '999999', getEpoch: () => 1,
    store: {
      getTask: async key => key.startsWith('social-state:') ? { lastCheck: Date.now() - 11 * 60_000 } : undefined,
      conversation: { async list(scope) { scopes.push(scope); return context; } },
      memory: {
        getGroup: () => ({ enabled: true }),
        async relevant(query) {
          queries.push(query);
          return query.userIds.includes('555555')
            ? [{ userId: '555555', status: 'confirmed', kind: 'preference', text: '喜欢科幻动画' }] : [];
        },
      },
    },
    gate() {}, listTools: () => [], grantedTools: () => [],
    infer: async (provider, messages, signal, options) => {
      await options.beforeCall();
      requests.push(messages);
      return { text: JSON.stringify({ action: 'silent', reason: 'test', memoryCandidates: [] }) };
    },
    send: async () => { throw new Error('选择沉默时不能发送消息'); },
    report: (level, message) => { if (message.includes('选择沉默')) completed.resolve(); },
  });
  let deadline;
  try {
    if (autonomous) await runtime.tick();
    else for (const [index, input] of inputs.entries()) await runtime.handle({ messageType: 'group', groupId: '222222',
      messageId: `request-${index}`, mentioned: true, text: '聊聊动画', ...input }, { action: 'chat' });
    await Promise.race([completed.promise, new Promise((resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('记忆查询测试等待超时')), 5000);
    })]);
    assert.equal(queries.length, 1);
    assert.equal(requests.length, 1);
    assert.deepEqual(scopes, [{ actualQQ: '999999', groupId: '222222', limit: 50 }]);
    assert.equal(queries[0].actualQQ, '999999');
    assert.equal(queries[0].groupId, '222222');
    assert.equal(queries[0].limit, 8);
    return { query: queries[0], messages: requests[0] };
  } finally { clearTimeout(deadline); runtime.stop(); }
}

const historyMember = userId => ({ role: 'user', userId, messageId: `history-${userId}`, text: '先前的聊天', time: Math.floor(Date.now() / 1000) });

test('超过20位历史成员时仍查询本轮请求者的记忆并注入提示', async () => {
  const historyIds = Array.from({ length: 24 }, (_, index) => String(600000 + index));
  const { query, messages } = await memoryLookup(['555555', ...historyIds].map(historyMember), [{ userId: '555555' }]);
  assert.ok(query.userIds.includes('555555'), '最早出现过的当前请求者不能被历史成员挤出');
  assert.equal(query.userIds.length, 20);
  assert.deepEqual(query.userIds, ['555555', ...historyIds.slice(-19).reverse()]);
  assert.match(messages[0].content, /喜欢科幻动画/);
});

test('本轮多位参与者先去重保留，剩余名额按最近发言填充且排除通知和AI', async () => {
  const historyIds = Array.from({ length: 24 }, (_, index) => String(600000 + index));
  const context = ['555555', '555556', ...historyIds].map(historyMember);
  context.push(historyMember(historyIds[0]), { role: 'assistant', userId: '999999', messageId: 'bot', text: 'AI回答' });
  const { query } = await memoryLookup(context, [
    { userId: '555555' }, { userId: '555556' }, { userId: '555555' },
    { userId: '555557', isNotice: true, kind: 'poke', mentionsBot: true },
  ]);
  assert.deepEqual(query.userIds, ['555555', '555556', historyIds[0], ...historyIds.slice(-17).reverse()]);
  assert.equal(new Set(query.userIds).size, 20);
  assert.equal(query.userIds.includes('555557'), false);
  assert.equal(query.userIds.includes('999999'), false);
});

test('没有本轮成员的主动检查仍只查询最近20位历史成员', async () => {
  const historyIds = Array.from({ length: 24 }, (_, index) => String(600000 + index));
  const context = [...historyIds, historyIds[0]].map(historyMember);
  const { query } = await memoryLookup(context, [], { autonomous: true });
  assert.deepEqual(query.userIds, [historyIds[0], ...historyIds.slice(-19).reverse()]);
});

test('两小时会话过期会清内存话题和跟进状态，旧短历史不参与模型与检索', async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.botQQ = '999999';
  config.chat.enabled = config.models.deepseek.enabled = true;
  config.chat.contextMessages = 50;
  config.chat.social.batchMs = 0;
  config.groups = [{ id: '222222', read: true, send: true, triggers: ['mention'],
    social: { enabled: true, proactive: false, activeStart: '00:00', activeEnd: '00:00' } }];
  const scope = { actualQQ: '999999', groupId: '222222' }, now = Math.floor(Date.now() / 1000);
  let session = { ...scope, topic: '', pendingTopics: [], participants: [], version: 0, expired: false, expiresAt: null };
  const firstDone = deferred(), secondDone = deferred(), queries = [], requests = [];
  const runtime = createSocialRuntime({ getConfig: () => config, getIdentity: () => scope.actualQQ, getEpoch: () => 1,
    store: {
      conversation: { list: async () => [
        { ...historyMember('555555'), messageId: 'old', text: '三小时前的旧短上下文', time: now - 3 * 3600 },
        { ...historyMember('555555'), messageId: 'fresh', text: '当前的新鲜短上下文', time: now },
      ] },
      conversationState: { get: () => session },
      memory: { getGroup: () => ({ enabled: true }), relevant: async input => { queries.push(input); return []; } },
    }, gate() {}, listTools: () => [], grantedTools: () => [],
    infer: async (provider, messages, signal, options) => {
      await options.beforeCall(); requests.push(messages);
      return { text: JSON.stringify(requests.length === 1
        ? { action: 'reply', text: '第一轮已回复', topic: '缓存旧话题' }
        : { action: 'silent', reason: 'TTL test' }) };
    }, send: async () => {}, report: (level, message) => {
      if (message.endsWith('已回复')) firstDone.resolve();
      if (message.includes('TTL test')) secondDone.resolve();
    },
  });
  let deadline;
  try {
    const timeout = new Promise((resolve, reject) => { deadline = setTimeout(() => reject(new Error('过期状态回归等待超时')), 5000); });
    await runtime.handle({ messageType: 'group', groupId: scope.groupId, userId: '555555', messageId: 'first', text: '先聊这个', mentioned: true, time: now }, { action: 'chat' });
    await Promise.race([firstDone.promise, timeout]);
    assert.equal(runtime.status().groups[0].topic, '缓存旧话题');
    assert.ok(runtime.status().groups[0].lastReplyAt > 0);
    session = { ...scope, topic: '过期快照旧话题', pendingTopics: [], participants: [], version: 1, expired: true, expiresAt: null };
    await runtime.handle({ messageType: 'group', groupId: scope.groupId, userId: '555555', messageId: 'second', text: '', mentioned: true, time: now }, { action: 'chat' });
    await Promise.race([secondDone.promise, timeout]);
    assert.equal(runtime.status().groups[0].topic, '');
    assert.equal(runtime.status().groups[0].lastReplyAt, 0);
    assert.equal(queries[1].query, '', '不能拿过期的内存话题当检索fallback');
    for (const messages of requests) {
      const packet = JSON.parse(messages.find(message => message.role === 'user').content);
      assert.ok(packet.context.every(message => message.messageId !== 'old'));
      assert.ok(packet.context.some(message => message.messageId === 'fresh'));
      assert.ok(!messages[0].content.includes('过期快照旧话题'));
    }
    const secondPacket = JSON.parse(requests[1].find(message => message.role === 'user').content);
    assert.ok(secondPacket.request.every(request => request.followUp === false));
  } finally { clearTimeout(deadline); runtime.stop(); }
});
