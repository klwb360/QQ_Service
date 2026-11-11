import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDashboard } from '../src/server.mjs';
import { DEFAULT_CONFIG, validateConfig } from '../src/config.mjs';
import { onebotHosts, publicOrigins } from '../src/network-policy.mjs';

function environment(values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) value === undefined ? delete process.env[key] : process.env[key] = value;
  return () => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; };
}

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-service-container-test-'));
  const calls = [];
  const app = createDashboard({ dataDir: directory,
    installerFactory: () => ({ environment: async () => ({}), status: async () => [], dispose: async () => {},
      install: async () => calls.push('install'), startNapcat: async () => calls.push('start'), stopNapcat: async () => calls.push('stop') }),
    runtimeFactory: () => ({ status: () => ({ connected: false, accountId: '' }), reload: async () => {}, stop: async () => {}, connect: async () => calls.push('connect') }),
  });
  const { port } = await app.listen(0);
  const request = ({ route = '/api/accounts', method = 'GET', host = `127.0.0.1:${port}`, origin, token, body, fetchSite } = {}) => new Promise((resolve, reject) => {
    const headers = { Host: host, ...(origin ? { Origin: origin } : {}), ...(token ? { 'X-Dashboard-Token': token } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}), ...(fetchSite ? { 'Sec-Fetch-Site': fetchSite } : {}) };
    const outgoing = http.request({ hostname: '127.0.0.1', port, path: route, method, headers }, response => {
      let text = ''; response.on('data', chunk => text += chunk); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
    });
    outgoing.on('error', reject); outgoing.end(body ? JSON.stringify(body) : undefined);
  });
  const { body: { csrfToken } } = await request();
  return { app, request, csrfToken, calls, async close() { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('container mapping explicitly adds the public Host/Origin while retaining CSRF and rebinding checks', async () => {
  const restore = environment({ QQ_SERVICE_CONTAINER: '1', QQ_SERVICE_HOST: '0.0.0.0', QQ_SERVICE_PUBLIC_ORIGIN: 'http://localhost:48222' });
  const f = await fixture();
  try {
    assert.equal((await f.request({ host: 'localhost:48222', origin: 'http://localhost:48222' })).status, 200);
    assert.equal((await f.request({ host: 'evil.test:48222', origin: 'http://localhost:48222' })).status, 403);
    assert.equal((await f.request({ host: 'localhost:48222', origin: 'https://evil.test' })).status, 403);
    assert.equal((await f.request({ host: 'localhost:48222', origin: 'http://localhost:48222', fetchSite: 'cross-site' })).status, 403);
    const create = { route: '/api/accounts', method: 'POST', host: 'localhost:48222', origin: 'http://localhost:48222', body: { name: '容器账号', platform: 'qq', qqNumber: '111111' } };
    assert.equal((await f.request(create)).status, 403, 'mapped-origin writes still require the session token');
    assert.equal((await f.request({ ...create, token: f.csrfToken })).status, 201);
  } finally { await f.close(); restore(); }
});

test('ONEBOT_HOSTS is exact, deployment-controlled and ignored on desktop', () => {
  const restore = environment({ QQ_SERVICE_CONTAINER: '1', QQ_SERVICE_ONEBOT_HOSTS: 'napcat,host.docker.internal' });
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.qq.wsUrl = 'ws://napcat:3001'; config.qq.webUiUrl = 'http://host.docker.internal:6099';
    assert.ok(onebotHosts().includes('napcat'));
    assert.doesNotThrow(() => validateConfig(config));
    for (const host of ['napcat.evil.test', 'unlisted', 'example.com']) {
      assert.throws(() => validateConfig({ ...config, qq: { ...config.qq, wsUrl: `ws://${host}:3001` } }));
    }
    process.env.QQ_SERVICE_CONTAINER = '0';
    assert.ok(!onebotHosts().includes('napcat'));
    assert.throws(() => validateConfig(config));
  } finally { restore(); }
});

test('container mode rejects every native install/start/stop route but allows external runtime connection', async () => {
  const restore = environment({ QQ_SERVICE_CONTAINER: '1', QQ_SERVICE_PUBLIC_ORIGIN: undefined, QQ_SERVICE_HOST: undefined });
  const f = await fixture();
  try {
    const created = await f.request({ route: '/api/accounts', method: 'POST', token: f.csrfToken, body: { name: '外部 QQ', platform: 'qq', qqNumber: '111111' } });
    const route = `/api/accounts/${created.body.account.id}`;
    for (const suffix of ['/napcat/open', '/setup/install', '/modules/napcat/install', '/modules/napcat/start', '/modules/napcat/stop', '/modules/deepseek/install']) {
      const result = await f.request({ route: route + suffix, method: 'POST', token: f.csrfToken, body: { revision: 0 } });
      assert.equal(result.status, 409, `${suffix}: ${JSON.stringify(result.body)}`);
    }
    assert.equal((await f.request({ route: route + '/runtime/connect', method: 'POST', token: f.csrfToken, body: {} })).status, 200);
    assert.deepEqual(f.calls, ['connect']);
  } finally { await f.close(); restore(); }
});

test('invalid public origins fail before opening a dashboard listener', () => {
  const restore = environment({ QQ_SERVICE_CONTAINER: '1' });
  try {
    for (const origin of ['http://user:password@localhost:3210', 'http://localhost:3210/path', 'https://localhost:3210/?token=x']) {
      process.env.QQ_SERVICE_PUBLIC_ORIGIN = origin;
      assert.throws(() => publicOrigins());
    }
  } finally { restore(); }
});

test('different OneBot services may reuse ports, while identical host/port resources stay exclusive', async () => {
  const restore = environment({ QQ_SERVICE_CONTAINER: '1', QQ_SERVICE_ONEBOT_HOSTS: 'qq-a,qq-b', QQ_SERVICE_PUBLIC_ORIGIN: undefined, QQ_SERVICE_HOST: undefined });
  const f = await fixture();
  try {
    const accounts = [];
    for (const [qqNumber, host] of [['111111', 'qq-a'], ['999999', 'qq-b']]) {
      const created = await f.request({ route: '/api/accounts', method: 'POST', token: f.csrfToken, body: { name: qqNumber, platform: 'qq', qqNumber } });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const route = `/api/accounts/${created.body.account.id}`, config = created.body.state.draft;
      config.qq.enabled = true; config.qq.wsUrl = `ws://${host}:3001`; config.qq.webUiUrl = `http://${host}:6099`;
      const saved = await f.request({ route: route + '/config/save', method: 'POST', token: f.csrfToken, body: { config, secretUpdates: { napcatToken: 'fixture-token' } } });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      const applied = await f.request({ route: route + '/config/apply', method: 'POST', token: f.csrfToken, body: { revision: saved.body.revision } });
      assert.equal(applied.status, 200, `${host} should have an independent network namespace: ${JSON.stringify(applied.body)}`);
      accounts.push({ route, config: applied.body.draft });
    }
    const second = accounts[1];
    second.config.qq.wsUrl = 'ws://qq-a:3001';
    const saved = await f.request({ route: second.route + '/config/save', method: 'POST', token: f.csrfToken, body: { config: second.config } });
    const duplicate = await f.request({ route: second.route + '/config/apply', method: 'POST', token: f.csrfToken, body: { revision: saved.body.revision } });
    assert.equal(duplicate.status, 409, 'the same host/port must remain reserved by the first account');
  } finally { await f.close(); restore(); }
});
