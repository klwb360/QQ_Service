import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { createWebContentClient, createPinnedHttpsTransport, isPublicWebAddress, parsePublicWebUrl,
  resolvePublicWebTarget, publicWebError } from '../src/web-content.mjs';

const publicIP = '93.184.216.34';
const answer = async () => [{ address: publicIP, family: 4 }];
const response = (text, options = {}) => ({ statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...options.headers },
  body: Readable.from([Buffer.isBuffer(text) ? text : Buffer.from(text)]), ...options,
  ...(options.headers ? { headers: { 'content-type': 'text/html; charset=utf-8', ...options.headers } } : {}) });
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve }; };
const errorCode = code => error => error.code === code;

test('public unicast classifier blocks reserved, translated and scoped IP addresses', () => {
  for (const ip of ['0.0.0.0', '0.3.4.5', '10.2.3.4', '100.64.0.1', '100.127.255.255', '127.0.0.1',
    '169.254.169.254', '172.16.1.1', '172.31.255.255', '192.0.0.9', '192.0.2.1', '192.88.99.1',
    '192.168.0.1', '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:7f00:1', '::ffff:808:808', '::ffff:0:808:808', '64:ff9b::808:808',
    '2001::1', '2001:2::1', '2001:20::1', '2001:db8::1', '2002:808:808::1', '3fff::1',
    'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '2606:4700::1%eth0', 'not-an-ip']) assert.equal(isPublicWebAddress(ip), false, ip);
  for (const ip of [publicIP, '8.8.8.8', '1.1.1.1', '100.128.0.1', '172.32.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicWebAddress(ip), true, ip);
});

test('URL canonicalization rejects numeric localhost tricks, credentials, ports and local names', () => {
  for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://example.com:8443/',
    'https://2130706433', 'https://0177.0.0.1', 'https://0x7f000001', 'https://127.1', 'https://%31%32%37.0.0.1',
    'https://[::ffff:127.0.0.1]', 'https://[64:ff9b::808:808]', 'https://localhost', 'https://router.local',
    'https://service.internal', 'https://printer.home.arpa', 'https://oneword', 'https://example.com./',
    'https://example.com/\nheader', 'https://example.com\\@localhost']) assert.throws(() => parsePublicWebUrl(url), undefined, url);
  assert.equal(parsePublicWebUrl('https://example.com:443/path?q=1#ignore').href, 'https://example.com/path?q=1');
});

test('all DNS answers are validated before transport and helper defaults do not bypass DNS validation', async () => {
  let calls = 0;
  const target = await resolvePublicWebTarget(parsePublicWebUrl('https://example.com'), { lookup: async (host, options) => {
    assert.equal(host, 'example.com'); assert.deepEqual(options, { all: true, verbatim: true }); return answer();
  } });
  assert.deepEqual(target, { address: publicIP, family: 4, hostname: 'example.com' });
  for (const answers of [[{ address: publicIP, family: 4 }, { address: '10.0.0.1', family: 4 }],
    [{ address: '2606:4700::1', family: 6 }, { address: '::ffff:808:808', family: 6 }], [],
    [{ address: publicIP, family: 6 }]]) {
    const client = createWebContentClient({ lookup: async () => answers, transport: async () => { calls++; return response('unexpected'); } });
    await assert.rejects(client.fetchPage('https://example.com'), errorCode('WEB_ADDRESS_REJECTED'));
  }
  assert.equal(calls, 0);
});

test('native HTTPS transport pins lookup and socket while retaining exact Host, SNI and certificate verification', async () => {
  let captured;
  const transport = createPinnedHttpsTransport({ request(options, ready) {
    captured = options;
    const pending = new EventEmitter(); pending.end = () => {
      const body = Readable.from(['fixture']); body.socket = { remoteAddress: publicIP, remotePort: 443 };
      body.headers = { 'content-type': 'text/plain' }; body.statusCode = 200; ready(body);
    }; return pending;
  } });
  const url = parsePublicWebUrl('https://example.com/path?q=1');
  const value = await transport({ url, target: { hostname: 'example.com', address: publicIP, family: 4 },
    signal: new AbortController().signal, headers: { Accept: 'text/plain' } });
  assert.equal(captured.agent, false); assert.equal(captured.rejectUnauthorized, true);
  assert.equal(captured.autoSelectFamily, false); assert.equal(captured.family, 4);
  assert.equal(captured.servername, 'example.com'); assert.equal(captured.headers.Host, 'example.com');
  assert.equal(captured.hostname, 'example.com'); assert.equal(captured.path, '/path?q=1');
  captured.lookup('example.com', { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: publicIP, family: 4 }]); });
  captured.lookup('example.com', {}, (error, ip, family) => { assert.equal(error, null); assert.equal(ip, publicIP); assert.equal(family, 4); });
  captured.lookup('other.example.com', {}, error => assert.equal(error.code, 'WEB_PIN_FAILED'));
  value.body.destroy();
  const rejected = createPinnedHttpsTransport({ request(_options, ready) {
    const pending = new EventEmitter(); pending.end = () => { const body = Readable.from(['bad']); body.socket = { remoteAddress: '10.0.0.1', remotePort: 443 }; ready(body); }; return pending;
  } });
  await assert.rejects(rejected({ url, target: { hostname: 'example.com', address: publicIP, family: 4 }, signal: new AbortController().signal, headers: {} }), errorCode('WEB_PIN_FAILED'));
});

test('redirects re-resolve the same hostname and never reach a newly private answer', async () => {
  let resolves = 0, requests = 0, redirectBody;
  const client = createWebContentClient({ lookup: async () => [{ address: ++resolves === 1 ? publicIP : '127.0.0.1', family: 4 }],
    transport: async () => { requests++; const result = response('', { statusCode: 302, headers: { location: '/next' } }); redirectBody = result.body; return result; } });
  await assert.rejects(client.fetchPage('https://example.com/start'), errorCode('WEB_ADDRESS_REJECTED'));
  assert.equal(resolves, 2); assert.equal(requests, 1); assert.equal(redirectBody.destroyed, true);
  for (const location of ['http://example.com', 'https://127.0.0.1', 'https://example.com:8443', 'https://name:pw@example.com']) {
    const rejected = createWebContentClient({ lookup: answer, transport: async () => response('', { statusCode: 302, headers: { location } }) });
    await assert.rejects(rejected.fetchPage('https://example.com'), errorCode('WEB_REDIRECT_REJECTED'));
  }
  let loops = 0;
  const looping = createWebContentClient({ lookup: answer, transport: async () => { loops++; return response('', { statusCode: 301, headers: { location: '/again' } }); } });
  await assert.rejects(looping.fetchPage('https://example.com'), errorCode('WEB_REDIRECT_REJECTED')); assert.equal(loops, 4);
});

test('HTML and plain text include real sources, explicit limitations and bounded text without loading resources', async () => {
  const calls = [];
  const client = createWebContentClient({ lookup: answer, transport: async input => {
    calls.push(input); return response('<html><head><title>A &amp; B</title><style>HIDDEN_STYLE</style></head><body><h1>标题</h1><script>HIDDEN_SCRIPT</script><p>正文&nbsp;&lt;visible&gt;</p><img src="https://resource.example.com/image.png"><a href="https://link.example.com">链接</a></body></html>');
  } });
  const result = await client.fetchPage('https://example.com/article#section');
  assert.equal(result.title, 'A & B'); assert.equal(result.sourceURL, 'https://example.com/article');
  assert(result.text.includes('标题')); assert(result.text.includes('正文 <visible>')); assert(!result.text.includes('HIDDEN'));
  assert.equal(result.truncated, false); assert.equal(result.coverage.kind, 'server_html_text');
  assert(result.coverage.notice.includes('未执行JavaScript')); assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0].headers).sort(), ['Accept', 'Accept-Encoding', 'User-Agent']);
  const plain = createWebContentClient({ lookup: answer, limits: { textChars: 8, textBytes: 12 },
    transport: async () => response('正文很长需要截断，而且保留原文链接', { headers: { 'content-type': 'text/plain' } }) });
  const shortened = await plain.fetchPage('https://example.com/text');
  assert.equal(shortened.text, '正文很长'); assert.equal(shortened.truncated, true); assert.equal(shortened.coverage.textComplete, false);
});

test('gzip and brotli decode within budget; compressed and inflated limits both stop body consumption', async () => {
  for (const [encoding, compress] of [['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]]) {
    const client = createWebContentClient({ lookup: answer, transport: async () => response(compress(Buffer.from('fixture text')), { headers: { 'content-type': 'text/plain', 'content-encoding': encoding } }) });
    assert.equal((await client.fetchPage('https://example.com')).text, 'fixture text');
  }
  for (const [body, headers, limits] of [
    [Buffer.alloc(129), { 'content-type': 'text/plain' }, { wireBytes: 128 }],
    [gzipSync(Buffer.alloc(10_000, 65)), { 'content-type': 'text/plain', 'content-encoding': 'gzip' }, { decodedBytes: 128 }],
    ['x', { 'content-type': 'text/plain', 'content-length': '9999999' }, {}],
  ]) {
    let stream;
    const client = createWebContentClient({ lookup: answer, limits, transport: async () => { const result = response(body, { headers }); stream = result.body; return result; } });
    await assert.rejects(client.fetchPage('https://example.com'), errorCode('WEB_RESPONSE_TOO_LARGE'));
    assert.equal(stream.destroyed, true);
  }
});

test('nontext media, combined compression and HTTP denials are not treated as page content', async () => {
  for (const [headers, statusCode, code] of [
    [{ 'content-type': 'application/pdf' }, 200, 'WEB_CONTENT_TYPE'],
    [{ 'content-type': 'image/svg+xml' }, 200, 'WEB_CONTENT_TYPE'],
    [{ 'content-type': 'text/plain', 'content-encoding': 'gzip, br' }, 200, 'WEB_CONTENT_ENCODING'],
    [{ 'content-type': 'text/plain; charset=made-up-encoding' }, 200, 'WEB_CHARSET'],
    [{}, 403, 'WEB_HTTP_REJECTED'], [{}, 429, 'WEB_RATE_LIMITED'],
  ]) {
    const client = createWebContentClient({ lookup: answer, transport: async () => response('not content', { headers, statusCode }) });
    await assert.rejects(client.fetchPage('https://example.com'), errorCode(code));
  }
});

test('one deadline covers unresolved DNS, late headers and bodies; cancellation destroys streams', async () => {
  const dnsReply = deferred(); let requests = 0;
  const dnsClient = createWebContentClient({ limits: { deadlineMs: 15 }, lookup: () => dnsReply.promise,
    transport: async () => { requests++; return response('unexpected'); } });
  await assert.rejects(dnsClient.fetchPage('https://example.com'), errorCode('WEB_TIMEOUT'));
  dnsReply.resolve([{ address: publicIP, family: 4 }]); await new Promise(resolve => setImmediate(resolve)); assert.equal(requests, 0);
  const headers = deferred(); let late;
  const headerClient = createWebContentClient({ lookup: answer, limits: { deadlineMs: 15 }, transport: () => headers.promise });
  await assert.rejects(headerClient.fetchPage('https://example.com'), errorCode('WEB_TIMEOUT'));
  late = response('late'); headers.resolve(late); await new Promise(resolve => setImmediate(resolve)); assert.equal(late.body.destroyed, true);
  const started = deferred(), controller = new AbortController(); let stream;
  const bodyClient = createWebContentClient({ lookup: answer, transport: async () => {
    stream = new Readable({ read() {} }); started.resolve(); return { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: stream };
  } });
  const pending = bodyClient.fetchPage('https://example.com', { signal: controller.signal });
  await started.promise; controller.abort(); await assert.rejects(pending, errorCode('WEB_CANCELLED')); assert.equal(stream.destroyed, true);
  const timeoutClient = createWebContentClient({ lookup: answer, limits: { deadlineMs: 15 }, transport: async () => ({ statusCode: 200, headers: { 'content-type': 'text/plain' }, body: new Readable({ read() {} }) }) });
  await assert.rejects(timeoutClient.fetchPage('https://example.com'), errorCode('WEB_TIMEOUT'));
});

test('malformed markup is parsed in one bounded scan and synchronous work cannot bypass the total deadline', async () => {
  for (const html of ['<'.repeat(64 * 1024), '<' + ' '.repeat(64 * 1024) + '>', '<script>' + '<'.repeat(64 * 1024)]) {
    const client = createWebContentClient({ lookup: answer, transport: async () => response(html) });
    const started = performance.now(); const result = await client.fetchPage('https://example.com');
    assert.equal(result.text, ''); assert(performance.now() - started < 1000, 'malformed input cannot trigger quadratic scanning');
  }
  const client = createWebContentClient({ lookup: answer, limits: { deadlineMs: 1 }, transport: async () => {
    const until = performance.now() + 5; while (performance.now() < until) {} return response('late synchronous response');
  } });
  await assert.rejects(client.fetchPage('https://example.com'), errorCode('WEB_TIMEOUT'));
  const script = createWebContentClient({ lookup: answer, transport: async () => response('<head><script>if (1 < 2) console.log("x");</script></head><body><svg/><p>Visible story</p></body>') });
  assert.equal((await script.fetchPage('https://example.com')).text, 'Visible story');
});

test('search without explicit configuration reports setup and performs no DNS or request', async () => {
  const client = createWebContentClient({ getEnvironment: () => ({}), lookup: async () => assert.fail('missing setup resolved DNS'), transport: async () => assert.fail('missing setup sent request') });
  await assert.rejects(client.search({ query: '查天气' }), error => { assert.equal(publicWebError(error).needsSetup, true); return error.code === 'WEB_SEARCH_SETUP'; });
});

test('serialized result budgets remain hard limits even when metadata alone is too large', async () => {
  const client = createWebContentClient({ limits: { resultBytes: 1 }, getEnvironment: () => ({ SEARXNG_BASE_URL: 'https://search.example.com' }),
    lookup: answer, transport: async ({ url }) => url.hostname === 'search.example.com'
      ? response('{"results":[]}', { headers: { 'content-type': 'application/json' } }) : response('😀'.repeat(6000)) });
  await assert.rejects(client.fetchPage('https://example.com'), errorCode('WEB_RESPONSE_TOO_LARGE'));
  await assert.rejects(client.search({ query: 'fixture' }), errorCode('WEB_RESPONSE_TOO_LARGE'));
});

test('Brave search uses only the official API, fixed auth header and real provider links', async () => {
  const calls = [], hosts = [];
  const client = createWebContentClient({ getEnvironment: () => ({ BRAVE_SEARCH_API_KEY: 'fixture-api-key', SEARXNG_BASE_URL: 'https://unused.example.com' }),
    lookup: async host => { hosts.push(host); return answer(); }, transport: async input => {
      calls.push(input); return response(JSON.stringify({ web: { results: [
        { title: '<b>真实结果</b>', url: 'https://article.example.com/post', description: '真实摘要' },
        { title: 'private', url: 'https://127.0.0.1/', description: 'skip' }, { title: 'wrong scheme', url: 'http://example.com/', description: 'skip' },
      ] } }), { headers: { 'content-type': 'application/json' } });
    } });
  const result = await client.search({ query: '查找资料', count: 3 });
  assert.equal(result.provider, 'Brave Search'); assert.deepEqual(hosts, ['api.search.brave.com']);
  assert.equal(calls[0].url.pathname, '/res/v1/web/search'); assert.equal(calls[0].url.searchParams.get('q'), '查找资料');
  assert.equal(calls[0].headers['X-Subscription-Token'], 'fixture-api-key'); assert(!Object.hasOwn(calls[0].headers, 'Cookie'));
  assert.deepEqual(result.results, [{ title: '真实结果', url: 'https://article.example.com/post', snippet: '真实摘要' }]);
  assert(!JSON.stringify(result).includes('fixture-api-key'));
});

test('SearXNG is explicit public HTTPS JSON search and never an automatic Brave failure fallback', async () => {
  const calls = [];
  const client = createWebContentClient({ getEnvironment: () => ({ SEARXNG_BASE_URL: 'https://search.example.com/searx/' }), lookup: answer,
    transport: async input => { calls.push(input); return response(JSON.stringify({ results: [{ title: 'Source', url: 'https://example.com/source', content: 'Evidence' }] }), { headers: { 'content-type': 'application/json' } }); } });
  const result = await client.search({ query: 'source' });
  assert.equal(result.provider, 'SearXNG'); assert.equal(calls[0].url.pathname, '/searx/search'); assert.equal(calls[0].url.searchParams.get('format'), 'json');
  assert(!Object.hasOwn(calls[0].headers, 'X-Subscription-Token'));
  let requests = 0;
  const failing = createWebContentClient({ getEnvironment: () => ({ BRAVE_SEARCH_API_KEY: 'fixture-key', SEARXNG_BASE_URL: 'https://search.example.com' }), lookup: answer,
    transport: async () => { requests++; return response('secret error', { statusCode: 401 }); } });
  await assert.rejects(failing.search({ query: 'source' }), errorCode('WEB_SEARCH_AUTH')); assert.equal(requests, 1);
  const internal = createWebContentClient({ getEnvironment: () => ({ SEARXNG_BASE_URL: 'https://127.0.0.1' }), lookup: answer, transport: async () => assert.fail('private search sent request') });
  await assert.rejects(internal.search({ query: 'source' }), errorCode('WEB_ADDRESS_REJECTED'));
});

test('Brave credentials cannot follow cross-origin redirects or appear in error text', async () => {
  let requests = 0;
  const client = createWebContentClient({ getEnvironment: () => ({ BRAVE_SEARCH_API_KEY: 'fixture-key' }), lookup: answer,
    transport: async () => { requests++; return response('', { statusCode: 302, headers: { location: 'https://other.example.com/collect' } }); } });
  await assert.rejects(client.search({ query: 'source' }), errorCode('WEB_REDIRECT_REJECTED')); assert.equal(requests, 1);
  const unsafe = new Error('private key fixture-key /home/private/path stacktrace');
  assert.deepEqual(publicWebError(unsafe), { code: 'WEB_NETWORK_FAILED', error: '网页连接未完成；请检查目标站点是否可访问。' });
});
