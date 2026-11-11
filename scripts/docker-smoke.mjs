import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const image = process.argv[2] || 'qq-service:local';
const suffix = randomUUID().slice(0, 12);
const container = `qq-service-smoke-${suffix}`;
const volume = `${container}-data`;
const network = `${container}-net`;
const fixture = `${container}-onebot`;
let fixtureCreated = false;
let networkCreated = false;
let created = false;

// Exercise container DNS and the actual OneBot transport without logging in to
// QQ. This fixture accepts only the dedicated test token and cannot send QQ.
const onebotFixture = `
import { WebSocketServer } from 'ws';
const wss = new WebSocketServer({port:3001,host:'0.0.0.0',verifyClient:({req})=>req.headers.authorization==='Bearer docker-smoke-onebot-token'});
wss.on('connection', socket=>socket.on('message', raw=>{
  const packet=JSON.parse(raw.toString());
  const data=packet.action==='get_login_info'?{user_id:12345678,nickname:'Docker fixture'}:
    packet.action==='get_group_list'?[]:packet.action==='get_status'?{online:true,good:true}:{};
  socket.send(JSON.stringify({status:'ok',retcode:0,data,echo:packet.echo}));
}));
`;

function docker(args, { optional = false } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !optional) throw new Error(`docker ${args[0]} failed: ${(result.stderr || result.stdout).slice(-2000)}`);
  return (args[0] === 'logs' ? result.stdout + result.stderr : result.stdout).trim();
}

const probe = net.createServer();
await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;

function request(path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path, method, timeout: 4000,
      headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; if (text.length > 2 * 1024 * 1024) res.destroy(new Error('Response too large.')); });
      res.on('error', reject);
      res.on('end', () => {
        let data; try { data = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, data, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('HTTP timeout.')));
    req.on('error', reject);
    req.end(payload);
  });
}

async function ready() {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try { const result = await request('/api/accounts'); if (result.status === 200 && Array.isArray(result.data?.accounts)) return result.data; } catch {}
    if (docker(['inspect', '--format', '{{.State.Running}}', container]) !== 'true') throw new Error('Container exited before readiness.');
    await delay(400);
  }
  throw new Error('Container did not become ready within 45 seconds.');
}

try {
  docker(['network', 'create', network]);
  networkCreated = true;
  docker(['volume', 'create', volume]);
  docker(['run', '--detach', '--name', fixture, '--network', network, '--network-alias', 'onebot-fixture',
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', image,
    'node', '--input-type=module', '-e', onebotFixture]);
  fixtureCreated = true;
  docker(['run', '--detach', '--name', container, '--init', '--read-only', '--tmpfs', '/tmp:size=64m,mode=1777',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--publish', `127.0.0.1:${port}:3210`,
    '--network', network, '--mount', `type=volume,src=${volume},dst=/data`,
    '-e', `QQ_SERVICE_PUBLIC_ORIGIN=${origin}`, '-e', 'QQ_SERVICE_ONEBOT_HOSTS=onebot-fixture', image]);
  created = true;
  assert.equal(docker(['inspect', '--format', '{{.Config.User}}', container]), 'node', 'image must run as node');
  assert.equal(docker(['exec', container, 'id', '-u']), '1000', 'process must not run as root');
  const initial = await ready();
  assert.equal((await request('/')).status, 200, 'dashboard must be available through published port');
  assert.equal((await request('/api/accounts', { headers: { Host: 'evil.example' } })).status, 403, 'untrusted Host must fail');
  assert.equal((await request('/api/accounts', { headers: { Origin: 'https://evil.example' } })).status, 403, 'cross-site Origin must fail');
  assert.equal((await request('/api/accounts', { method: 'POST', body: { name: 'blocked' } })).status, 403, 'mutation without CSRF token must fail');
  const createdAccount = await request('/api/accounts', { method: 'POST', body: { name: 'Docker smoke', platform: 'qq', qqNumber: '12345678' },
    headers: { 'X-Dashboard-Token': initial.csrfToken, Origin: origin } });
  assert.equal(createdAccount.status, 201, `account creation failed: ${createdAccount.text}`);
  const id = createdAccount.data.account.id;
  assert.equal(createdAccount.data.state.draft.permissions.released, false, 'new account must remain read-only');
  const config = structuredClone(createdAccount.data.state.draft);
  config.qq.enabled = true;
  config.qq.wsUrl = 'ws://onebot-fixture:3001';
  if (config.qq.connections?.napcat) config.qq.connections.napcat.wsUrl = config.qq.wsUrl;
  const saved = await request(`/api/accounts/${id}/config/save`, { method: 'POST',
    body: { config, secretUpdates: { deepseekApiKey: 'docker-smoke-not-a-real-api-key', napcatToken: 'docker-smoke-onebot-token' } },
    headers: { 'X-Dashboard-Token': initial.csrfToken, Origin: origin } });
  assert.equal(saved.status, 200, `credential save failed: ${saved.text}`);
  assert.equal(saved.data.secrets.deepseekApiKey, true, 'encrypted credential must be staged');
  const applied = await request(`/api/accounts/${id}/config/apply`, { method: 'POST', body: { revision: saved.data.revision },
    headers: { 'X-Dashboard-Token': initial.csrfToken, Origin: origin } });
  assert.equal(applied.status, 200, `config application failed: ${applied.text}`);
  const connection = await request(`/api/accounts/${id}/runtime/connect`, { method: 'POST', body: {},
    headers: { 'X-Dashboard-Token': initial.csrfToken, Origin: origin } });
  assert.equal(connection.status, 200, `OneBot fixture connection failed: ${connection.text}`);
  assert.equal(connection.data.runtime.accountId, '12345678', 'container must verify the expected QQ through the external fixture');
  assert.equal(connection.data.runtime.connected, true);
  const managedStart = await request(`/api/accounts/${id}/modules/napcat/start`, { method: 'POST', body: {},
    headers: { 'X-Dashboard-Token': initial.csrfToken, Origin: origin } });
  assert.equal(managedStart.status, 409, 'container must reject managed host module launch');
  docker(['exec', container, 'node', 'scripts/docker-healthcheck.mjs']);
  docker(['stop', '--time', '20', container]);
  assert.equal(docker(['inspect', '--format', '{{.State.ExitCode}}', container]), '0', 'SIGTERM must shut down cleanly');
  docker(['start', container]);
  const restarted = await ready();
  assert(restarted.accounts.some(account => account.id === id && account.name === 'Docker smoke'), 'profile must survive container restart');
  const state = await request(`/api/accounts/${id}/state`);
  assert.equal(state.status, 200);
  assert.equal(state.data.draft.botQQ, '12345678', 'stored QQ identity must survive restart');
  assert.equal(state.data.secrets.deepseekApiKey, true, 'encrypted credential and key must survive restart together');
  assert.equal(state.data.secrets.napcatToken, true, 'OneBot credential must survive restart');
  const reconnected = await request(`/api/accounts/${id}/runtime/connect`, { method: 'POST', body: {},
    headers: { 'X-Dashboard-Token': restarted.csrfToken, Origin: origin } });
  assert.equal(reconnected.status, 200, `OneBot reconnect failed: ${reconnected.text}`);
  assert.equal(reconnected.data.runtime.accountId, '12345678');
  console.log('Docker smoke passed: non-root, dashboard/API, Host/Origin/CSRF, external OneBot identity, host-launch denial, profile/vault persistence, healthcheck, graceful shutdown.');
} catch (error) {
  if (created) {
    const logs = docker(['logs', '--tail', '35', container], { optional: true });
    if (logs) console.error(logs);
  }
  throw error;
} finally {
  if (created) docker(['rm', '--force', container], { optional: true });
  if (fixtureCreated) docker(['rm', '--force', fixture], { optional: true });
  docker(['volume', 'rm', volume], { optional: true });
  if (networkCreated) docker(['network', 'rm', network], { optional: true });
}
