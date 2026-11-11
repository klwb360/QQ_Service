import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { connectorCatalog, assertBackendAvailable, SNOWLUMA_REVIEW, resolveConnector,
  getBackendCapabilities, normalizeConnectorPacket, validateConnectorUrl, createSnowLumaHttpClient } from '../src/onebot-connector.mjs';

async function serverFixture(handler) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, authorization: request.headers.authorization, method: request.method, body: JSON.parse(body || '{}') });
    handler(request, response, requests);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { requests, url: `http://127.0.0.1:${server.address().port}`, async close() {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  } };
}

test('SnowLuma review gate cannot be enabled by mutating catalog copies', () => {
  const catalog = connectorCatalog();
  catalog[1].available = true; catalog[1].review.available = true;
  assert.equal(assertBackendAvailable('napcat'), 'napcat');
  assert.throws(() => assertBackendAvailable('snowluma'), { code: 'SNOWLUMA_REVIEW_REQUIRED', status: 409 });
  assert.equal(SNOWLUMA_REVIEW.state, 'static_review_only');
  assert.equal(getBackendCapabilities('snowluma').available, false);
  assert.equal(getBackendCapabilities('snowluma').favorites, 'unverified');
  assert.throws(() => assertBackendAvailable('unknown'), { code: 'QQ_BACKEND_INVALID' });
});

test('resolve preserves legacy active fields and uses independent backend credentials', () => {
  assert.equal(resolveConnector({ qq: { wsUrl: 'ws://127.0.0.1:7777' } }).wsTokenName, 'napcatToken');
  const value = resolveConnector({ qq: { backend: 'snowluma', wsUrl: 'ws://127.0.0.1:7001', httpUrl: 'http://127.0.0.1:7000',
    connections: { snowluma: { wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000' } } } });
  assert.equal(value.wsUrl, 'ws://127.0.0.1:7001'); assert.equal(value.httpUrl, 'http://127.0.0.1:7000');
  assert.equal(value.wsTokenName, 'snowlumaWsToken'); assert.equal(value.httpTokenName, 'snowlumaHttpToken');
  assert.equal(resolveConnector({ qq: { backend: 'snowluma', connections: { snowluma: { webUiUrl: 'http://127.0.0.1:6000' } } } }).webUiUrl, 'http://127.0.0.1:6000');
});

test('HTTP endpoints reject embedded credentials, redirects paths and non-allowlisted hosts', () => {
  for (const value of ['http://example.com', 'http://localhost@evil.test', 'http://127.0.0.1:3000/?token=secret', 'http://127.0.0.1/a', 'file:///etc/passwd', 'http://127.0.0.1/#token']) {
    assert.throws(() => validateConnectorUrl(value), { code: 'ONEBOT_WRONG_ENDPOINT' });
  }
  assert.equal(validateConnectorUrl('http://snowluma:3000', { allowedHosts: ['snowluma'] }).hostname, 'snowluma');
  assert.throws(() => validateConnectorUrl('http://snowluma.evil:3000', { allowedHosts: ['snowluma'] }));
  assert.equal(validateConnectorUrl('ws://127.0.0.1:3001', { kind: 'ws' }).protocol, 'ws:');
});

test('SnowLuma poke aliases normalize while wrong or missing stream identity is rejected', () => {
  const packet = { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', self_id: '999999', group_id: 222222,
    sender_id: 555555, targetId: '999999' };
  const result = normalizeConnectorPacket(packet, { backend: 'snowluma', expectedQQ: '999999' });
  assert.equal(result.user_id, '555555'); assert.equal(result.target_id, '999999');
  assert.equal(packet.user_id, undefined, 'normalization must not mutate caller data');
  assert.equal(normalizeConnectorPacket(packet, { backend: 'snowluma', expectedQQ: '888888' }), null);
  assert.equal(normalizeConnectorPacket({ ...packet, self_id: undefined }, { backend: 'snowluma', expectedQQ: '999999' }), null);
  assert.equal(normalizeConnectorPacket({ ...packet, self_id: 9007199254740992 }, { backend: 'snowluma' }), null);
  assert.deepEqual(normalizeConnectorPacket({ echo: 'rpc', retcode: 0 }, { expectedQQ: '999999' }), { echo: 'rpc', retcode: 0 });
});

test('SnowLuma HTTP sends only its HTTP token and returns normal OneBot data', async () => {
  const fixture = await serverFixture((request, response) => response.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 999999 } })));
  try {
    const client = createSnowLumaHttpClient({ baseUrl: fixture.url, token: 'http-only-secret' });
    assert.deepEqual(await client.getIdentity(), { user_id: 999999 });
    assert.deepEqual(fixture.requests, [{ path: '/get_login_info', authorization: 'Bearer http-only-secret', method: 'POST', body: {} }]);
    client.close();
    await assert.rejects(client.request('get_status'), { code: 'ONEBOT_CONNECTION_CLOSED' });
  } finally { await fixture.close(); }
});

test('HTTP authentication and explicit action rejection are definitive failures', async () => {
  for (const mode of ['auth', 'action']) {
    const fixture = await serverFixture((request, response) => {
      if (mode === 'auth') { response.writeHead(401); response.end('denied'); }
      else response.end(JSON.stringify({ status: 'failed', retcode: 1400, message: 'rejected private-token' }));
    });
    try {
      const client = createSnowLumaHttpClient({ baseUrl: fixture.url, token: 'private-token' });
      await assert.rejects(client.request('send_group_msg', { group_id: 222222, message: 'hello' }), error => {
        assert.equal(error.deliveryUncertain, undefined);
        assert.ok(!error.message.includes('private-token'));
        return error.code === (mode === 'auth' ? 'ONEBOT_AUTH_FAILED' : 'ONEBOT_ACTION_FAILED');
      });
      assert.equal(fixture.requests.length, 1); client.close();
    } finally { await fixture.close(); }
  }
});

test('lost write response is uncertain and never automatically retried', async () => {
  const fixture = await serverFixture((request, response) => { /* The action may have executed, but no response arrives. */ });
  try {
    const client = createSnowLumaHttpClient({ baseUrl: fixture.url, token: 'secret', timeoutMs: 100 });
    await assert.rejects(client.request('send_group_msg', { message: 'only once' }), error => error.code === 'ONEBOT_TIMEOUT' && error.deliveryUncertain === true);
    assert.equal(fixture.requests.length, 1);
    client.close();
  } finally { await fixture.close(); }
});

test('pre-aborted requests never start and are not marked as sent', async () => {
  let calls = 0;
  const controller = new AbortController(); controller.abort();
  const client = createSnowLumaHttpClient({ baseUrl: 'http://127.0.0.1:3000', token: 'secret', fetchImpl: async () => { calls++; } });
  await assert.rejects(client.request('send_group_msg', {}, { signal: controller.signal }), error => error.code === 'ONEBOT_CANCELLED' && !error.deliveryUncertain);
  assert.equal(calls, 0); client.close();
});

test('response limits cover streamed bodies without Content-Length', async () => {
  const fixture = await serverFixture((request, response) => { response.write('x'.repeat(40)); response.end('x'.repeat(40)); });
  try {
    const client = createSnowLumaHttpClient({ baseUrl: fixture.url, token: 'secret', maxResponseBytes: 64 });
    await assert.rejects(client.getIdentity(), { code: 'ONEBOT_RESPONSE_TOO_LARGE' });
    client.close();
  } finally { await fixture.close(); }
});

test('redirects do not forward credentials to a second endpoint', async () => {
  const fixture = await serverFixture((request, response) => { response.writeHead(302, { location: '/other' }); response.end(); });
  try {
    const client = createSnowLumaHttpClient({ baseUrl: fixture.url, token: 'secret' });
    await assert.rejects(client.getIdentity(), { code: 'ONEBOT_HTTP_FAILED' });
    assert.equal(fixture.requests.length, 1); client.close();
  } finally { await fixture.close(); }
});

test('closing cancels an outstanding action and future requests', async () => {
  const started = Promise.withResolvers();
  const fixture = await serverFixture(() => started.resolve());
  try {
    const client = createSnowLumaHttpClient({ baseUrl: fixture.url, token: 'secret' });
    const pending = client.request('send_group_msg', { message: 'maybe delivered' });
    await started.promise; client.close();
    await assert.rejects(pending, error => error.code === 'ONEBOT_CANCELLED' && error.deliveryUncertain === true);
    await assert.rejects(client.request('get_status'), { code: 'ONEBOT_CONNECTION_CLOSED' });
  } finally { await fixture.close(); }
});
