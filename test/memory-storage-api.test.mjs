import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDashboard } from '../src/server.mjs';

test('global memory directory API stages all profiles, rejects forged settings and migrates only after restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-directory-api-'));
  const dataDir = path.join(root, 'data'), target = path.join(root, 'memory');
  let app;
  const open = async () => {
    app = createDashboard({ dataDir,
      installerFactory: () => ({ environment: async () => ({}), status: async () => [], dispose: async () => {} }),
      runtimeFactory: () => ({ status: () => ({ connected: false, accountId: '' }), reload: async () => {}, stop: async () => {}, invalidateMemory() {} }),
    });
    const address = await app.listen(0), base = `http://127.0.0.1:${address.port}`;
    const { csrfToken } = await (await fetch(`${base}/api/accounts`)).json();
    return {
      async get(route) { const response = await fetch(base + route); return { status: response.status, body: await response.json() }; },
      async post(route, body, headers = {}) {
        const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': csrfToken, ...headers }, body: JSON.stringify(body) });
        return { status: response.status, body: await response.json() };
      },
      base,
    };
  };
  try {
    let api = await open();
    const created = await api.post('/api/accounts', { name: '记忆测试号', platform: 'qq', qqNumber: '111111' });
    assert.equal(created.status, 201);
    const id = created.body.account.id, accountRoute = `/api/accounts/${id}`;
    const config = created.body.state.draft; config.groups = [{ id: '222222', read: true, mode: 'social', send: false }];
    assert.equal((await api.post(accountRoute + '/config/save', { config })).status, 200);
    assert.equal((await api.post(accountRoute + '/memory/action', { actualQQ: '111111', groupId: '222222', userId: '333333', action: 'create', text: '我喜欢科幻。' })).status, 200);
    const second = await api.post('/api/accounts', { name: '第二个记忆账号', platform: 'qq', qqNumber: '999999' });
    assert.equal(second.status, 201);
    const secondId = second.body.account.id, secondRoute = `/api/accounts/${secondId}`, secondConfig = second.body.state.draft;
    secondConfig.groups = [{ id: '222222', read: true, mode: 'social', send: false }];
    assert.equal((await api.post(secondRoute + '/config/save', { config: secondConfig })).status, 200);
    assert.equal((await api.post(secondRoute + '/memory/action', { actualQQ: '999999', groupId: '222222', userId: '333333', action: 'create', text: '另一个账号的独立记忆' })).status, 200);
    assert.equal((await api.get('/api/memory-storage')).body.limits.conversationRetentionDays, 330);
    assert.equal((await api.post('/api/memory-storage', { directory: target }, { 'X-Dashboard-Token': '' })).status, 403);
    assert.equal((await api.post('/api/memory-storage', { directory: target }, { Origin: 'https://invalid.example' })).status, 403);
    assert.equal((await api.post('/api/memory-storage', { directory: target, activeRoot: target })).status, 400);
    assert.equal((await api.post('/api/memory-storage', { directory: '../relative' })).status, 400);
    for (const body of [{ directory: null }, { directory: 123 }, {}]) assert.equal((await api.post('/api/memory-storage', body)).status, 400);
    const staged = await api.post('/api/memory-storage', { directory: target });
    assert.equal(staged.status, 200); assert.equal(staged.body.activeRoot, ''); assert.equal(staged.body.restartRequired, true);
    assert.equal(fs.existsSync(path.join(target, 'profiles', id, 'memory.sqlite')), false);
    assert.equal((await api.post(accountRoute + '/memory/action', { actualQQ: '111111', groupId: '222222', userId: '333333', action: 'create', text: '选择目录后仍正常保存的记忆' })).status, 200);
    await app.close(); app = null;
    api = await open();
    const active = await api.get('/api/memory-storage');
    assert.equal(active.body.activeRoot, fs.realpathSync(target)); assert.equal(active.body.restartRequired, false);
    const memory = await api.get(accountRoute + '/memory?actualQQ=111111&groupId=222222');
    assert.equal(memory.body.records.length, 2);
    assert.ok(memory.body.records.some(record => record.text === '我喜欢科幻。'));
    assert.ok(memory.body.records.some(record => record.text === '选择目录后仍正常保存的记忆'));
    const other = await api.get(secondRoute + '/memory?actualQQ=999999&groupId=222222');
    assert.deepEqual(other.body.records.map(record => record.text), ['另一个账号的独立记忆']);
    assert.ok(fs.existsSync(path.join(target, 'profiles', id, 'memory.sqlite')));
    for (const profileId of [id, secondId]) {
      const original = app.catalog.directory(profileId);
      assert.ok(fs.existsSync(path.join(original, 'memory.sqlite')), '原库仍保留，方便恢复');
      const db = new DatabaseSync(path.join(target, 'profiles', profileId, 'memory.sqlite'), { readOnly: true });
      try {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
        assert.ok(!tables.some(name => ['messages', 'tasks', 'summaries', 'favorites'].includes(name)), '只迁移记忆，不搬运任务和其他资料');
      } finally { db.close(); }
      assert.equal((await api.get(`/api/accounts/${profileId}/state`)).body.applied.permissions.released, false);
    }
    const script = await fetch(api.base + '/memory-storage-ui.js'); assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);
    assert.match(await script.text(), /QQMemoryStorageUI/);
    const html = await (await fetch(api.base)).text();
    assert.ok(html.indexOf('/memory-storage-ui.js') < html.indexOf('/app.js'));
    const restore = await api.post('/api/memory-storage', { directory: '' });
    assert.equal(restore.body.pendingRoot, ''); assert.equal(restore.body.restartRequired, true);
    await app.close(); app = null;
    api = await open();
    assert.equal((await api.get('/api/memory-storage')).body.activeRoot, '');
    assert.equal((await api.get(accountRoute + '/memory?actualQQ=111111')).body.records.length, 2);
    assert.equal((await api.get(secondRoute + '/memory?actualQQ=999999')).body.records.length, 1);
  } finally { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
