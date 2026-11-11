import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDashboard } from '../src/server.mjs';

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-service-persona-api-'));
  const invalidations = [];
  const app = createDashboard({ dataDir: directory,
    installerFactory: () => ({ environment: async () => ({}), status: async () => [], dispose: async () => {} }),
    runtimeFactory: ({ profileId }) => ({ status: () => ({ connected: false, accountId: '' }), reload: async () => {}, stop: async () => {},
      invalidateMemory: scope => invalidations.push({ profileId, ...scope }),
    }),
  });
  const { port } = await app.listen(0), base = `http://127.0.0.1:${port}`;
  const { csrfToken } = await (await fetch(base + '/api/accounts')).json();
  const get = async route => { const response = await fetch(base + route); return { status: response.status, body: await response.json() }; };
  const post = async (route, body, extraHeaders = {}) => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': csrfToken, ...extraHeaders }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const create = async actualQQ => {
    const created = await post('/api/accounts', { name: `QQ ${actualQQ}`, platform: 'qq', qqNumber: actualQQ });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.account.id, route = `/api/accounts/${id}`, service = app.accounts.get(id);
    const config = service.store.getConfig();
    config.chat.enabled = true; config.models.deepseek.enabled = true;
    config.chat.persona = '# 初始角色\n保持简短。'; config.chat.social.name = '小Q';
    config.groups = [{ id: '222222', name: '科普群', mode: 'social', read: true, send: false, social: { enabled: true, style: '尽量简短', interests: '科普' } },
      { id: '333333', name: '另一个群', mode: 'social', read: true, send: false, social: { enabled: true } }];
    service.store.setSecret('deepseekApiKey', 'test-api-key');
    service.store.saveDraft(config); service.store.commitDraft(); service.store.recordPersona();
    return { id, route, actualQQ, service };
  };
  return { app, get, post, create, invalidations, async close() { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('persona preview/history/restore remain scoped and restore only returns an unapplied draft', async () => {
  const f = await fixture();
  try {
    const a = await f.create('111111'), b = await f.create('999999');
    const first = await f.get(a.route + '/persona/history?actualQQ=111111');
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.revisions.length, 1);
    const revision = first.body.revisions[0].revision;
    const config = a.service.store.getConfig();
    config.chat.persona = '# 修改后的角色\n喜欢举例。'; config.chat.social.name = '小Q二号';
    const preview = await f.post(a.route + '/persona/preview', { config, groupId: '222222' });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.ok(preview.body.text.includes('修改后的角色'));
    assert.ok(preview.body.text.includes('尽量简短'));
    assert.equal(a.service.store.getConfig().chat.persona, '# 初始角色\n保持简短。', 'preview must not apply');
    const saved = await f.post(a.route + '/config/save', { config });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const applied = await f.post(a.route + '/config/apply', { revision: saved.body.revision });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    const before = a.service.store.getState();
    const restored = await f.post(a.route + '/persona/restore', { actualQQ: '111111', revision });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.draft, true);
    assert.equal(restored.body.config.chat.persona, '# 初始角色\n保持简短。');
    assert.equal(restored.body.config.chat.social.name, '小Q');
    assert.deepEqual(a.service.store.getState(), before, 'restore must not silently save/apply or alter permissions');
    assert.equal((await f.get(a.route + '/persona/history?actualQQ=111111')).body.revisions.length, 2);
    assert.equal((await f.get(b.route + '/persona/history?actualQQ=111111')).status, 404);
    assert.equal((await f.post(b.route + '/persona/restore', { actualQQ: '111111', revision })).status, 404);
    assert.equal((await f.post(a.route + '/persona/restore', { actualQQ: '111111', revision }, { Origin: 'https://evil.test' })).status, 403);
  } finally { await f.close(); }
});

test('experience HTTP management preserves verified sources, CAS and QQ/group isolation', async () => {
  const f = await fixture();
  try {
    const a = await f.create('111111'), b = await f.create('999999'), store = a.service.store;
    const source = { actualQQ: '111111', groupId: '222222', messageId: 'real-1', userId: '555555', role: 'user', text: '明天再接着聊月球吧', time: Math.floor(Date.now() / 1000) };
    store.conversation.record(source);
    const [note] = store.experiences.suggest({ actualQQ: '111111', groupId: '222222',
      candidates: [{ kind: 'pending_topic', text: '下次接着聊月球', sourceIds: ['real-1'] }], sources: [source] });
    assert.ok(note);
    const scope = '?actualQQ=111111&groupId=222222';
    const read = await f.get(a.route + '/experiences' + scope);
    assert.equal(read.status, 200, JSON.stringify(read.body)); assert.equal(read.body.records[0].id, note.id);
    assert.equal(read.body.records[0].sources[0].text, source.text);
    const fabricated = await f.post(a.route + '/experiences/action', { actualQQ: '111111', groupId: '222222', action: 'create', text: '编造经历', sources: [source], origin: 'ai' });
    assert.equal(fabricated.status, 400, 'HTTP clients cannot forge AI source metadata');
    const update = { actualQQ: '111111', groupId: '222222', id: note.id, version: note.version, action: 'update', text: '下次接着聊月球探测' };
    assert.equal((await f.post(b.route + '/experiences/action', update)).status, 404);
    assert.equal((await f.post(a.route + '/experiences/action', { ...update, groupId: '333333' })).status, 404);
    const changed = await f.post(a.route + '/experiences/action', update);
    assert.equal(changed.status, 200, JSON.stringify(changed.body)); assert.equal(changed.body.record.version, 2);
    assert.equal((await f.post(a.route + '/experiences/action', update)).status, 409);
    const history = await f.get(a.route + '/experiences/history' + scope + '&id=' + note.id);
    assert.equal(history.status, 200); assert.equal(history.body.revisions.length, 2);
    assert.equal((await f.get(a.route + '/experiences/history?actualQQ=111111&groupId=333333&id=' + note.id)).status, 404);
    assert.equal((await f.get(b.route + '/experiences' + scope)).status, 404);
    const paused = await f.post(a.route + '/experiences/group', { actualQQ: '111111', groupId: '222222', paused: true, version: read.body.group.version });
    assert.equal(paused.status, 200); assert.equal(paused.body.group.enabled, false);
    assert.equal(paused.body.records.length, 1, 'pausing does not delete history');
    assert.deepEqual(store.experiences.relevant({ actualQQ: '111111', groupId: '222222', query: '月球' }), []);
    assert.equal((await f.post(a.route + '/experiences/group', { actualQQ: '111111', groupId: '888888', paused: false })).status, 409);
    assert.equal(store.getConfig().permissions.released, false);
    const removed = await f.post(a.route + '/experiences/action', { actualQQ: '111111', groupId: '222222', id: note.id, version: 2, action: 'delete' });
    assert.equal(removed.status, 200); assert.equal(removed.body.record, null);
    assert.equal((await f.get(a.route + '/experiences/history' + scope + '&id=' + note.id)).status, 404);
  } finally { await f.close(); }
});

test('conversation clear is versioned, invalidates pending replies and cannot clear another profile', async () => {
  const f = await fixture();
  try {
    const a = await f.create('111111'), b = await f.create('999999'), store = a.service.store;
    const source = { actualQQ: '111111', groupId: '222222', messageId: 'topic-1', userId: '555555', role: 'user', text: '我们聊月球吧', time: Math.floor(Date.now() / 1000) };
    store.conversation.record(source);
    store.conversationState.observe({ actualQQ: '111111', groupId: '222222', messages: [source], topic: '月球探测' });
    const scope = '?actualQQ=111111&groupId=222222', read = await f.get(a.route + '/conversation/state' + scope);
    assert.equal(read.status, 200); assert.equal(read.body.state.topic, '月球探测');
    const clear = { actualQQ: '111111', groupId: '222222', version: read.body.state.version };
    assert.equal((await f.post(b.route + '/conversation/clear', clear)).status, 404);
    assert.equal((await f.post(a.route + '/conversation/clear', { ...clear, topic: '伪造新状态' })).status, 400);
    const cleared = await f.post(a.route + '/conversation/clear', clear);
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body)); assert.equal(cleared.body.state.topic, '');
    assert.deepEqual(cleared.body.state.participants, []);
    assert.equal((await f.post(a.route + '/conversation/clear', clear)).status, 409);
    store.conversationState.observe({ actualQQ: '111111', groupId: '222222', messages: [source], topic: '旧消息不能复活话题' });
    assert.equal((await f.get(a.route + '/conversation/state' + scope)).body.state.topic, '');
    assert.ok(f.invalidations.some(item => item.profileId === a.id && item.groupId === '222222'));
    assert.equal(store.conversation.list({ actualQQ: '111111', groupId: '222222' }).length, 1, 'clear only removes current state, not chat history');
  } finally { await f.close(); }
});

test('HTTP save cannot activate experimental SnowLuma even when clients forge approval fields', async () => {
  const f = await fixture();
  try {
    const a = await f.create('111111');
    const config = a.service.store.getConfig(); config.qq.backend = 'snowluma'; config.qq.enabled = true;
    config.qq.httpUrl = 'http://127.0.0.1:3000';
    const saved = await f.post(a.route + '/config/save', { config, secretUpdates: { snowlumaWsToken: 'ws-only', snowlumaHttpToken: 'http-only' } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const appliedBefore = a.service.store.getConfig();
    const rejected = await f.post(a.route + '/config/apply', { revision: saved.body.revision, reviewed: true });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.deepEqual(a.service.store.getConfig(), appliedBefore);
    assert.equal((await f.post(a.route + '/connection/switch', { backend: 'snowluma', revision: saved.body.revision, reviewed: true })).status, 409);
    assert.equal(a.service.store.getConfig().qq.backend, 'napcat');
  } finally { await f.close(); }
});
