import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createDashboard } from '../src/server.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';

test('HTTP 仪表盘有真实配置生命周期、跨站保护、无凭据导出与失败回滚', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbridge-http-'));
  let failReload = false;
  const app = createDashboard({ dataDir,
    installerFactory: () => ({ environment: async () => ({ node: { supported: true } }), status: async () => [], install: async () => { throw new Error('模拟下载失败'); } }),
    runtimeFactory: () => ({ reload: async () => { if (failReload) throw new Error('模拟重载失败'); }, stop: async () => {}, status: () => ({ connected: false }), preview: body => ({ action: 'ignore', ...body }) })
  });
  const address = await app.listen(0); const base = `http://127.0.0.1:${address.port}`;
  const request = async (route, body, token, extra = {}) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Dashboard-Token': token } : {}), ...extra }, body: JSON.stringify(body) });
  try {
    let state = await (await fetch(base + '/api/state')).json();
    assert.equal((await request('/api/config/save', { config: DEFAULT_CONFIG })).status, 403);
    assert.equal((await request('/api/config/save', { config: DEFAULT_CONFIG }, state.csrfToken, { Origin: 'https://evil.test' })).status, 403);
    const config = { ...structuredClone(DEFAULT_CONFIG), ownerQQ: '123456' };
    let response = await request('/api/config/save', { config, secretUpdates: { deepseekApiKey: 'private-key-123' } }, state.csrfToken);
    assert.equal(response.status, 200); state = await response.json();
    assert.equal(state.pendingChanges, true); assert.equal(state.applied.ownerQQ, '');
    assert.equal(JSON.stringify(state).includes('private-key-123'), false);
    assert.equal(app.store.getSecret('deepseekApiKey'), '');
    assert.equal((await request('/api/config/apply', { revision: state.revision - 1 }, state.csrfToken)).status, 409);
    response = await request('/api/config/apply', { revision: state.revision }, state.csrfToken); state = await response.json();
    assert.equal(response.status, 200); assert.equal(state.applied.ownerQQ, '123456'); assert.equal(state.pendingChanges, false);
    assert.equal(app.store.getSecret('deepseekApiKey'), 'private-key-123');
    assert.equal((await (await fetch(base + '/api/config/export')).text()).includes('private-key-123'), false);
    response = await request('/api/config/save', { config: { ...config, ownerQQ: '654321' }, secretUpdates: { deepseekApiKey: 'second-key' } }, state.csrfToken); state = await response.json();
    failReload = true;
    response = await request('/api/config/apply', { revision: state.revision }, state.csrfToken);
    assert.equal(response.status, 502); assert.equal(app.store.getConfig().ownerQQ, '123456'); assert.equal(app.store.getSecret('deepseekApiKey'), 'private-key-123');
    failReload = false;
    response = await request('/api/modules/codex/install', {}, state.csrfToken); assert.equal(response.status, 202);
    await new Promise(resolve => setTimeout(resolve, 10)); state = await (await fetch(base + '/api/state')).json();
    assert.equal(state.jobs.at(-1).status, 'failed'); assert.equal(state.jobs.at(-1).error, '模拟下载失败');
  } finally { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('NapCat 重载失败时恢复原 token 并重新加载原配置', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbridge-restore-'));
  const restarts = [];
  const app = createDashboard({ dataDir,
    installerFactory: ({ getSecret, getConfig }) => ({
      environment: async () => ({}), status: async () => [{ id: 'napcat', state: 'running' }],
      startNapcat: async () => { const token = getSecret('napcatToken'); restarts.push({ token, owner: getConfig().ownerQQ }); if (token === 'new-token') throw new Error('模拟 NapCat 重启失败'); }
    }),
    runtimeFactory: () => ({ reload: async () => {}, stop: async () => {}, status: () => ({ connected: false }) })
  });
  const address = await app.listen(0); const base = `http://127.0.0.1:${address.port}`;
  app.store.setSecret('napcatToken', 'old-token');
  app.store.saveDraft({ ...structuredClone(DEFAULT_CONFIG), ownerQQ: '123456' }); app.store.commitDraft();
  try {
    let state = await (await fetch(base + '/api/state')).json();
    const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': state.csrfToken }, body: JSON.stringify(body) });
    state = await (await post('/api/config/save', { config: { ...structuredClone(DEFAULT_CONFIG), ownerQQ: '654321' }, secretUpdates: { napcatToken: 'new-token' } })).json();
    const response = await post('/api/config/apply', { revision: state.revision });
    assert.equal(response.status, 502);
    assert.deepEqual(restarts, [{ token: 'new-token', owner: '654321' }, { token: 'old-token', owner: '123456' }]);
    assert.equal(app.store.getSecret('napcatToken'), 'old-token'); assert.equal(app.store.getConfig().ownerQQ, '123456');
  } finally { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});
