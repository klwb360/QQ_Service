import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDashboard } from '../src/server.mjs';

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-service-memory-api-'));
  const invalidations = [];
  const app = createDashboard({ dataDir: directory,
    installerFactory: () => ({ environment: async () => ({}), status: async () => [], dispose: async () => {} }),
    runtimeFactory: ({ profileId }) => ({
      status: () => ({ connected: false, accountId: '' }), reload: async () => {}, stop: async () => {},
      invalidateMemory: value => invalidations.push({ profileId, ...value }),
    }),
  });
  const address = await app.listen(0), base = `http://127.0.0.1:${address.port}`;
  const { csrfToken } = await (await fetch(base + '/api/accounts')).json();
  const get = async route => {
    const response = await fetch(base + route);
    return { status: response.status, body: await response.json() };
  };
  const post = async (route, body, headers = {}) => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': csrfToken, ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const create = async qqNumber => {
    const created = await post('/api/accounts', { name: `QQ ${qqNumber}`, platform: 'qq', qqNumber });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.account.id, route = `/api/accounts/${id}`;
    const config = created.body.state.draft;
    config.groups = [{ id: '222222', name: '已选群', mode: 'social', read: true, send: false }];
    const saved = await post(route + '/config/save', { config });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    return { id, route, qqNumber, state: saved.body };
  };
  return { app, directory, invalidations, get, post, create, async close() { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('记忆HTTP目录、手动编辑和逐群暂停真实落库，且不改变账号发送授权', async () => {
  const f = await fixture();
  try {
    const a = await f.create('111111');
    const tree = await f.get(a.route + '/memory/tree');
    assert.equal(tree.status, 200, JSON.stringify(tree.body));
    assert.equal(tree.body.identities[0].actualQQ, a.qqNumber);
    assert.equal(tree.body.identities[0].groups[0].name, '已选群');
    const enabled = await f.post(a.route + '/memory/group', { actualQQ: a.qqNumber, groupId: '222222', enabled: true });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
    assert.equal(enabled.body.group.enabled, true);
    const created = await f.post(a.route + '/memory/action', { action: 'create', actualQQ: a.qqNumber, groupId: '222222', userId: '333333', text: '喜欢纪录片', kind: 'preference' });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.record.status, 'confirmed');
    const record = created.body.record;
    const updated = await f.post(a.route + '/memory/action', { action: 'update', id: record.id, version: record.version, actualQQ: a.qqNumber, groupId: '222222', text: '喜欢科普纪录片', kind: 'preference' });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.record.version, 2);
    const conflict = await f.post(a.route + '/memory/action', { action: 'delete', id: record.id, version: 1, actualQQ: a.qqNumber, groupId: '222222' });
    assert.equal(conflict.status, 409);
    const found = await f.get(a.route + '/memory?actualQQ=111111&groupId=222222&userId=333333&status=confirmed&query=' + encodeURIComponent('科普'));
    assert.equal(found.body.records.length, 1);
    const paused = await f.post(a.route + '/memory/group', { actualQQ: a.qqNumber, groupId: '222222', enabled: false });
    assert.equal(paused.body.group.enabled, false);
    assert.equal(paused.body.records.length, 1);
    assert.equal((await f.get(a.route + '/state')).body.applied.permissions.released, false);
    assert.equal(f.invalidations.length, 4);
  } finally { await f.close(); }
});

test('记忆接口执行本机CSRF、来源和profile身份校验，不能伪造记录或启用未授权群', async () => {
  const f = await fixture();
  try {
    const a = await f.create('111111'), b = await f.create('999999');
    const create = { action: 'create', actualQQ: '111111', groupId: '222222', userId: '333333', text: '喜欢科幻', kind: 'preference' };
    const created = await f.post(a.route + '/memory/action', create);
    assert.equal(created.status, 200);
    assert.equal((await f.post(a.route + '/memory/action', create, { 'X-Dashboard-Token': '' })).status, 403);
    assert.equal((await f.post(a.route + '/memory/action', create, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await f.post(b.route + '/memory/action', create)).status, 404);
    assert.equal((await f.get(b.route + '/memory?actualQQ=111111')).status, 404);
    assert.equal((await f.get(b.route + '/memory')).body.records.length, 0);
    assert.equal((await f.post(a.route + '/memory/group', { actualQQ: '111111', groupId: '888888', enabled: true })).status, 409);
    assert.equal((await f.post(a.route + '/memory/action', { ...create, status: 'confirmed', sources: [{ text: '伪造原文' }] })).status, 400);
    assert.equal((await f.post(a.route + '/memory/action', { ...create, action: 'suggest' })).status, 400);
    const removed = await f.post(a.route + '/memory/action', { action: 'delete', actualQQ: '111111', groupId: '222222', id: created.body.record.id, version: 1 });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(removed.body.record, null);
  } finally { await f.close(); }
});
