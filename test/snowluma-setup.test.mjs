import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccountService } from '../src/account-service.mjs';

const qq = '12345678';
function fixture(t, backend = 'snowluma') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-snow-setup-'));
  const actions = [], actual = { connected: true, accountId: qq, backend };
  const service = createAccountService({ account: { id: 'snow-setup', name: '外部连接测试', platform: 'qq' }, dataDir: directory,
    installerFactory: () => ({ status: async () => [], environment: async () => ({}), dispose: async () => {},
      install: async id => { actions.push(['install', id]); }, startNapcat: async () => { actions.push(['start']); },
      stopNapcat: async () => { actions.push(['stop']); } }),
    runtimeFactory: () => ({ status: () => ({ ...actual }), reload: async () => {}, connect: async () => {}, stop: async () => {} }),
  });
  const state = service.store.getState();
  state.draft.botQQ = qq; state.draft.qq.enabled = true; state.draft.qq.backend = backend;
  if (backend === 'snowluma') Object.assign(state.draft.qq, state.draft.qq.connections.snowluma);
  state.applied = structuredClone(state.draft); service.store.restoreState(state);
  t.after(async () => { await service.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { service, actual, actions };
}
const connectionBlockers = setup => setup.blockers.filter(row => row.nextStep === 'connection');

test('SnowLuma setup independently requires the WS and HTTP tokens, never the inactive NapCat token', t => {
  const { service } = fixture(t);
  service.store.setSecret('napcatToken', 'inactive-napcat');
  let setup = service.setupStatus();
  assert.equal(setup.connection.backend, 'snowluma'); assert.equal(setup.connection.name, 'SnowLuma');
  assert.equal(setup.connection.externalRuntime, true);
  assert.equal(setup.connection.verified, false, 'a stale connected flag cannot substitute missing credentials');
  assert.deepEqual(connectionBlockers(setup).map(row => [row.code, row.field]), [
    ['SNOWLUMA_WS_TOKEN_MISSING', 'secrets.snowlumaWsToken'], ['SNOWLUMA_HTTP_TOKEN_MISSING', 'secrets.snowlumaHttpToken'],
  ]);
  service.store.setSecret('snowlumaWsToken', 'snow-ws-token');
  setup = service.setupStatus();
  assert.equal(setup.connection.verified, false);
  assert.deepEqual(connectionBlockers(setup).map(row => row.code), ['SNOWLUMA_HTTP_TOKEN_MISSING']);
  service.store.setSecret('snowlumaHttpToken', 'snow-http-token');
  setup = service.setupStatus(); assert.deepEqual(connectionBlockers(setup), []); assert.equal(setup.connection.verified, true);
  assert.match(setup.steps.find(step => step.id === 'connection').description, /SnowLuma 实际登录/);
  assert.doesNotMatch(JSON.stringify(setup), /snow-ws-token|snow-http-token|inactive-napcat/);
});

test('only current-backend pending secrets invalidate connection evidence and a mismatched live backend is never verified', t => {
  const { service, actual } = fixture(t);
  service.store.setSecret('snowlumaWsToken', 'ws-current'); service.store.setSecret('snowlumaHttpToken', 'http-current');
  assert.equal(service.setupStatus().connection.verified, true);
  service.store.stageSecrets({ napcatToken: 'inactive-next' });
  assert.equal(service.setupStatus().connection.verified, true, 'editing inactive NapCat credentials must not erase Snow evidence');
  service.store.stageSecrets({ snowlumaHttpToken: 'http-next' });
  assert.equal(service.setupStatus().connection.verified, false);
  service.store.commitSecrets(); assert.equal(service.setupStatus().connection.verified, true);
  actual.backend = 'napcat'; assert.equal(service.setupStatus().connection.verified, false);
  actual.backend = 'snowluma'; actual.connected = false;
  const setup = service.setupStatus();
  assert.equal(setup.connection.verified, false); assert.match(connectionBlockers(setup)[0].action, /外部启动 SnowLuma/);
  assert.match(setup.steps.find(step => step.id === 'connection').description, /WS／HTTP/);
});

test('NapCat setup remains independent from saved Snow tokens and pending Snow edits', t => {
  const { service } = fixture(t, 'napcat');
  service.store.setSecret('snowlumaWsToken', 'inactive-snow-ws'); service.store.setSecret('snowlumaHttpToken', 'inactive-snow-http');
  assert.deepEqual(connectionBlockers(service.setupStatus()).map(row => row.code), ['NAPCAT_TOKEN_MISSING']);
  service.store.setSecret('napcatToken', 'active-napcat');
  service.store.stageSecrets({ snowlumaWsToken: 'inactive-next' });
  const setup = service.setupStatus(); assert.equal(setup.connection.verified, true);
  assert.equal(setup.connection.backend, 'napcat'); assert.equal(setup.connection.externalRuntime, false);
});

test('an account selecting external Snow cannot accidentally install or start a NapCat process through backend endpoints', async t => {
  const { service, actions } = fixture(t);
  for (const route of ['/napcat/open', '/setup/install', '/modules/napcat/install', '/modules/napcat/start']) {
    await assert.rejects(service.invoke(route, { revision: 0 }), error => error.code === 'QQ_BACKEND_MANAGEMENT_MISMATCH'
      && error.nextStep === 'connection' && /外部 SnowLuma/.test(error.message));
  }
  assert.deepEqual(actions, []); assert.equal((await service.state()).jobs.length, 0);
});
