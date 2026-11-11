import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { createStore } from '../src/store.mjs';
import { createRuntime } from '../src/runtime.mjs';

const deferred = () => Promise.withResolvers();
async function waitFor(predicate) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('context invalidation fixture timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const called = name => ({ provider: 'deepseek', text: '', toolCalls: [{ id: 'call_one', type: 'function', function: { name, arguments: '{"query":"one change"}' } }] });

async function fixture({ tools = false, write = false, social = false, infer, execute, beforeSendAck } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-service-context-cancel-'));
  const store = createStore(directory), server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  const config = structuredClone(DEFAULT_CONFIG);
  config.botQQ = '999999'; config.qq.enabled = true; config.qq.wsUrl = `ws://127.0.0.1:${server.address().port}`;
  config.chat.enabled = true; config.models.deepseek.enabled = true; config.permissions.released = true;
  config.chat.social.batchMs = 0;
  config.groups = ['222222', '333333'].map(id => ({ id, name: id, mode: 'social', read: true, send: true, triggers: ['mention'], cooldownSeconds: 0, probability: 0,
    ...(social ? { social: { enabled: true, proactive: false } } : {}) }));
  const name = write ? 'update' : 'lookup', calls = [], requests = [], outbound = [];
  const plugin = { id: 'context-probe', events: [], permissions: [], secretsSchema: [], tools: [{ name,
    description: 'Context invalidation fixture', effect: write ? 'write' : 'read',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } }] };
  const pluginManager = {
    get: id => id === plugin.id ? plugin : null,
    execute: async (id, payload, options) => { calls.push({ id, payload }); return execute ? execute(payload, options) : { text: 'actual result' }; },
  };
  config.plugins = tools ? [{ id: plugin.id, enabled: true, settings: {} }] : [];
  config.tools = { enabled: tools, triggers: ['command'], aliases: [], prefix: '/工具', skill: '',
    grants: tools ? [{ tool: `${plugin.id}/${name}`, groupIds: ['222222'], userIds: write ? ['555555'] : [], allowWrite: write }] : [] };
  store.saveDraft(config); store.commitDraft();
  let peer, emitted = 0;
  server.on('connection', socket => {
    peer = socket;
    socket.on('message', raw => {
      const packet = JSON.parse(raw.toString());
      if (packet.action.startsWith('send_')) outbound.push(packet);
      const acknowledge = () => {
        if (socket.readyState !== socket.OPEN) return;
        socket.send(JSON.stringify({ echo: packet.echo, status: 'ok', retcode: 0,
          data: packet.action === 'get_login_info' ? { user_id: 999999 } : { message_id: `sent-${outbound.length}` } }));
      };
      if (beforeSendAck && packet.action.startsWith('send_')) Promise.resolve(beforeSendAck(packet)).then(acknowledge);
      else acknowledge();
    });
  });
  const runtime = createRuntime({ profileId: 'context-profile', getConfig: () => config, getSecret: () => 'fixture-key', store,
    installer: {}, pluginManager, providers: { deepseek: async args => {
      requests.push(args);
      return infer ? infer(args, requests.length) : { provider: 'deepseek', text: 'answer' };
    } } });
  await runtime.connect();
  return { store, runtime, config, calls, requests, outbound,
    emit({ messageId = `incoming-${emitted + 1}`, groupId = '222222' } = {}) {
      emitted++;
      peer.send(JSON.stringify({ post_type: 'message', message_type: 'group', self_id: '999999', group_id: groupId,
        user_id: '555555', message_id: messageId, time: Math.floor(Date.now() / 1000),
        message: tools ? [{ type: 'text', data: { text: '/工具 请完成当前操作' } }]
          : [{ type: 'at', data: { qq: '999999' } }, { type: 'text', data: { text: '继续解释刚才的话题' } }] }));
    },
    clear(groupId = '222222', options = {}) {
      const scope = { actualQQ: '999999', groupId };
      store.conversationState.clear(scope); runtime.invalidateMemory({ ...scope, ...options });
    },
    async idle() {
      await waitFor(() => runtime.status().metrics.received >= emitted);
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

test('clearing current group state cancels an ordinary model reply even when the provider ignores AbortSignal', async () => {
  const started = deferred(), resumed = deferred();
  const f = await fixture({ infer: async () => { started.resolve(); await resumed.promise; return { provider: 'deepseek', text: 'stale private context' }; } });
  try {
    f.emit(); await started.promise;
    f.clear(); resumed.resolve(); await f.idle();
    assert.equal(f.requests.length, 1); assert.equal(f.outbound.length, 0);
    assert.equal(f.config.permissions.released, true, 'clearing context does not revoke or expand account permissions');
  } finally { resumed.resolve(); await f.close(); }
});

test('clearing group memory before a late tool proposal prevents execution and fallback replies', async () => {
  const started = deferred(), resumed = deferred();
  const f = await fixture({ tools: true, infer: async args => { started.resolve(); await resumed.promise; return called(args.tools[0].function.name); } });
  try {
    f.emit(); await started.promise;
    f.clear(); resumed.resolve(); await f.idle();
    assert.equal(f.requests.length, 1); assert.equal(f.calls.length, 0); assert.equal(f.outbound.length, 0);
  } finally { resumed.resolve(); await f.close(); }
});

test('clearing after a write starts suppresses late results and replay never repeats the external write', async () => {
  const written = deferred(), resumed = deferred();
  const f = await fixture({ tools: true, write: true,
    infer: async args => args.messages.some(item => item.role === 'tool') ? { provider: 'deepseek', text: 'write finished' } : called(args.tools[0].function.name),
    execute: async () => { written.resolve(); await resumed.promise; return { text: 'external write already happened' }; },
  });
  try {
    f.emit({ messageId: 'same-write' }); await written.promise;
    assert.equal(f.calls.length, 1);
    f.clear(); resumed.resolve(); await f.idle();
    assert.equal(f.requests.length, 1, 'stale tool completion must not trigger another model round');
    assert.equal(f.outbound.length, 0);
    await f.runtime.reload(); await f.runtime.connect();
    f.emit({ messageId: 'same-write' }); await f.idle();
    assert.equal(f.calls.length, 1, 'the same persisted request cannot perform the write twice');
  } finally { resumed.resolve(); await f.close(); }
});

test('clearing a different group does not cancel the current group answer', async () => {
  const started = deferred(), resumed = deferred();
  const f = await fixture({ infer: async () => { started.resolve(); await resumed.promise; return { provider: 'deepseek', text: 'current group answer' }; } });
  try {
    f.emit(); await started.promise;
    f.clear('333333'); resumed.resolve(); await f.idle();
    assert.equal(f.outbound.length, 1);
    assert.equal(f.outbound[0].params.group_id, '222222');
  } finally { resumed.resolve(); await f.close(); }
});

test('clearing a social conversation while its first part awaits OneBot acknowledgement blocks remaining parts and fallback', async () => {
  const firstSent = deferred(), acknowledged = deferred();
  const text = '需要分三段发送的旧话题。'.repeat(200);
  assert.ok(text.length > 1800);
  let parts = 0;
  const f = await fixture({ social: true,
    infer: async () => ({ provider: 'deepseek', text: JSON.stringify({ action: 'reply', text, reason: '当前群友明确提问', topic: '旧话题', memoryCandidates: [], experienceCandidates: [] }) }),
    beforeSendAck: () => { parts++; if (parts === 1) { firstSent.resolve(); return acknowledged.promise; } },
  });
  try {
    f.emit(); await firstSent.promise;
    assert.equal(f.outbound.length, 1);
    assert.equal(f.outbound[0].params.message[0].data.text, text.slice(0, 1800));
    f.clear('222222', { clearConversation: true });
    acknowledged.resolve(); await f.idle();
    assert.equal(f.requests.length, 1);
    assert.equal(f.outbound.length, 1, `no second part or fallback may be sent: ${JSON.stringify(f.outbound.map(packet => packet.params.message[0].data.text.slice(0, 100)))}`);
    assert.equal(f.runtime.status().connected, true, 'clearing the conversation must not disconnect QQ');
    assert.equal(f.store.conversationState.get({ actualQQ: '999999', groupId: '222222' }).topic, '');
  } finally { acknowledged.resolve(); await f.close(); }
});
