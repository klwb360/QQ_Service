import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createAssetVisionService, ASSET_VISION_LIMITS } from '../src/asset-vision.mjs';
import { createQqAssetStore } from '../src/qq-assets.mjs';

const assetId = 'asset_' + 'a'.repeat(32), actualQQ = '111111', groupId = '222222', provider = 'api_visual';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const annotation = { description: '一只蓝色的小动物在招手。', tags: ['问候', '开心'], emotion: '轻松', usage: '熟人打招呼', avoidWhen: '严肃通知' };
const reply = value => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }), { headers: { 'Content-Type': 'application/json' } });
function fixture(overrides = {}) {
  const config = { botQQ: actualQQ, permissions: { released: false }, groups: [{ id: groupId, read: true }],
    models: { apis: [{ id: provider, enabled: true, baseUrl: 'https://vision.example/v1', model: 'vision-fixture' }] } };
  const state = { config, key: 'fixture-key-keep-private', version: 1, deleted: false, kind: 'image', bytes: png,
    requests: [], annotations: [], calls: [] };
  const assets = {
    async resolve(input) {
      await input.authorize();
      if (state.deleted) throw Object.assign(new Error('素材已删除。'), { code: 'QQ_ASSET_NOT_FOUND', statusCode: 404 });
      return { assetId, actualQQ, groupId, kind: state.kind, bytes: Buffer.from(state.bytes), byteLength: state.bytes.length,
        version: state.version, sha256: digest(state.bytes), mimeType: 'text/plain', frames: state.frames || 1 };
    },
    annotate(input) { state.annotations.push(input); return { ...input, version: input.expectedVersion + 1, groupIds: [groupId] }; },
  };
  const service = createAssetVisionService({ getConfig: () => state.config, getSecret: name => name === 'apiKey:' + provider ? state.key : '', assets,
    onCall: info => state.calls.push(info), fetchImpl: async (url, options) => {
      state.requests.push({ url: String(url), options });
      return overrides.fetch ? overrides.fetch(state, options) : reply(annotation);
    } });
  return { state, service, assets, analyze: fields => service.analyze({ assetId, actualQQ, groupId, provider, ...fields }) };
}

test('explicit dashboard analysis uses only the selected enabled API, bounded vision payload and approved asset metadata', async () => {
  const f = fixture();
  try {
    assert.equal(f.state.requests.length, 0, 'construction never triggers analysis');
    const result = await f.analyze();
    assert.equal(result.analyzed, true); assert.equal(result.provider, provider);
    const request = f.state.requests[0];
    assert.equal(request.url, 'https://vision.example/v1/chat/completions');
    assert.equal(request.options.redirect, 'error');
    assert.equal(request.options.headers.Authorization, 'Bearer ' + f.state.key);
    const body = JSON.parse(request.options.body);
    assert.equal(body.max_tokens, 768); assert.equal(body.temperature, 0.2); assert.equal(body.stream, false);
    assert.match(body.messages[1].content[1].image_url.url, /^data:image\/png;base64,/);
    assert.match(body.messages[0].content, /不可信/);
    assert.deepEqual(f.state.annotations[0].tags, annotation.tags);
    assert.equal(f.state.annotations[0].source, 'vision'); assert.equal(f.state.annotations[0].expectedVersion, 1);
    assert.match(f.state.annotations[0].modelFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(Object.hasOwn(f.state.annotations[0], 'groupIds'), false);
    assert.equal(JSON.stringify(result).includes(f.state.key), false);
    assert.equal(JSON.stringify(f.state.calls).includes('base64'), false);
    assert.equal(f.state.config.permissions.released, false, 'vision does not release QQ sending permissions');
  } finally { f.service.close(); }
});

test('DeepSeek text, disabled/missing compatible channels and missing secrets fail without alternate billing', async () => {
  for (const [input, change] of [[{ provider: 'deepseek' }, f => {}], [{}, f => { f.state.config.models.apis[0].enabled = false; }], [{}, f => { f.state.key = ''; }],
    [{}, f => { f.state.config.models.apis[0].baseUrl = 'http://internal.example'; }]]) {
    const f = fixture(); change(f);
    try {
      await assert.rejects(f.analyze(input), cause => ['ASSET_VISION_NEEDS_MODEL', 'ASSET_VISION_NEEDS_SETUP'].includes(cause.code));
      assert.equal(f.state.requests.length, 0); assert.equal(f.state.annotations.length, 0);
    } finally { f.service.close(); }
  }
});

test('scope, non-image asset, spoofed magic and larger images are rejected before any paid call', async () => {
  for (const [change, code] of [
    [f => { f.state.config.groups[0].read = false; }, 'ASSET_VISION_SCOPE_DENIED'],
    [f => { f.state.kind = 'file'; }, 'ASSET_VISION_UNSUPPORTED_IMAGE'],
    [f => { f.state.bytes = Buffer.from('<svg>unsafe</svg>'); }, 'ASSET_VISION_UNSUPPORTED_IMAGE'],
    [f => { f.state.bytes = Buffer.alloc(ASSET_VISION_LIMITS.imageBytes + 1); png.copy(f.state.bytes); }, 'ASSET_VISION_TOO_LARGE'],
  ]) {
    const f = fixture(); change(f);
    try { await assert.rejects(f.analyze(), cause => cause.code === code); assert.equal(f.state.requests.length, 0); }
    finally { f.service.close(); }
  }
});

test('GIF recognition is explicitly static-only and never claims the full animation was understood', async () => {
  const f = fixture(); f.state.bytes = Buffer.from('GIF89a123456'); f.state.frames = 5;
  try {
    const result = await f.analyze();
    assert.match(result.note, /静态/); assert.match(result.asset.description, /未分析完整动画/);
    const body = JSON.parse(f.state.requests[0].options.body);
    assert.match(body.messages[1].content[0].text, /不要编造动作过程/);
    assert.match(body.messages[1].content[1].image_url.url, /^data:image\/gif;/);
  } finally { f.service.close(); }
});

test('late asset deletion/version changes and channel/key changes never save visual annotations', async () => {
  for (const mutate of [s => { s.deleted = true; }, s => { s.version++; }, s => { s.key = 'rotated-key'; },
    s => { s.config.models.apis[0].model = 'other-model'; }, s => { s.config.groups[0].read = false; }]) {
    const f = fixture({ fetch: async state => { mutate(state); return reply(annotation); } });
    try { await assert.rejects(f.analyze(), cause => cause.code === 'ASSET_VISION_STALE'); assert.equal(f.state.annotations.length, 0); }
    finally { f.service.close(); }
  }
});

test('caller cancellation, service invalidation and shutdown end in-flight work even if fetch ignores abort', async () => {
  for (const action of ['abort', 'invalidate', 'close']) {
    const started = Promise.withResolvers(), finish = Promise.withResolvers();
    const f = fixture({ fetch: async () => { started.resolve(); await finish.promise; return reply(annotation); } });
    const caller = new AbortController();
    try {
      const work = f.analyze({ signal: caller.signal }); await started.promise;
      if (action === 'abort') caller.abort(); else f.service[action]();
      await assert.rejects(work, cause => cause.code === 'ASSET_VISION_CANCELLED');
      finish.resolve(); await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.state.annotations.length, 0);
      if (action === 'close') await assert.rejects(f.analyze(), cause => cause.code === 'ASSET_VISION_CLOSED');
    } finally { finish.resolve(); f.service.close(); }
  }
});

test('the 45-second total deadline also bounds a fetch implementation that ignores AbortSignal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = Promise.withResolvers(), finish = Promise.withResolvers();
  const f = fixture({ fetch: async () => { started.resolve(); await finish.promise; return reply(annotation); } });
  try {
    const work = f.analyze(); await started.promise;
    t.mock.timers.tick(ASSET_VISION_LIMITS.timeoutMs);
    await assert.rejects(work, cause => cause.code === 'ASSET_VISION_TIMEOUT');
    assert.equal(f.state.annotations.length, 0);
  } finally { finish.resolve(); f.service.close(); t.mock.timers.reset(); }
});

test('malformed, oversized, secret-echoing or injected model JSON is never committed', async () => {
  for (const output of [{ ...annotation, tags: Array(13).fill('tag') }, { ...annotation, description: 'a'.repeat(1201) },
    { ...annotation, groupIds: ['999999'] }, { ...annotation, description: 'fixture-key-keep-private' },
    { ...annotation, usage: 'data:image/png;base64,1234' }, { ...annotation, avoidWhen: [] }]) {
    const f = fixture({ fetch: async () => reply(output) });
    try { await assert.rejects(f.analyze(), cause => cause.code === 'ASSET_VISION_INVALID_RESULT'); assert.equal(f.state.annotations.length, 0); }
    finally { f.service.close(); }
  }
});

test('API rejection is sanitized and response streams have a real byte limit', async () => {
  const denied = fixture({ fetch: async () => new Response('fixture-key-keep-private data:image/png;base64,secret', { status: 400 }) });
  try {
    await assert.rejects(denied.analyze(), cause => cause.code === 'ASSET_VISION_NEEDS_SETUP'
      && !cause.message.includes('fixture-key') && !cause.message.includes('base64'));
  } finally { denied.service.close(); }
  const oversized = fixture({ fetch: async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(600000)); controller.enqueue(new Uint8Array(600000)); controller.close();
  } })) });
  try { await assert.rejects(oversized.analyze(), cause => cause.code === 'ASSET_VISION_RESPONSE_LIMIT'); assert.equal(oversized.state.annotations.length, 0); }
  finally { oversized.service.close(); }
});

test('real managed asset resolve and annotate preserve approval groups and require CAS', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-asset-vision-'));
  const config = { botQQ: actualQQ, groups: [{ id: groupId, read: true }], models: { apis: [{ id: provider, enabled: true, baseUrl: 'https://vision.example/v1', model: 'vision-fixture' }] } };
  const assets = createQqAssetStore({ dataDir, getConfig: () => config });
  const service = createAssetVisionService({ getConfig: () => config, getSecret: () => 'integration-key-private', assets, fetchImpl: async () => reply(annotation) });
  try {
    const row = assets.import({ actualQQ, groupIds: [groupId], kind: 'sticker', name: 'hello.gif', dataBase64: 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==' });
    const result = await service.analyze({ assetId: row.assetId, actualQQ, groupId, provider });
    assert.equal(result.asset.analysisSource, 'vision'); assert.equal(result.asset.version, row.version + 1);
    assert.deepEqual(result.asset.groupIds, [groupId]); assert.deepEqual(result.asset.tags, annotation.tags);
  } finally { service.close(); assets.dispose(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});
