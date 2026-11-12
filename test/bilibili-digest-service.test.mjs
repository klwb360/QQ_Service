import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.mjs';
import { createBilibiliDigestIntegration } from '../src/bilibili-digest-service.mjs';
import { mcpToolId, mcpSecretName } from '../src/mcp-config.mjs';

const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve }; };
const waitFor = async predicate => {
  const until = Date.now() + 4000;
  while (!await predicate()) { if (Date.now() > until) throw new Error('Bilibili integration fixture timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
};
const item = { item: { id: 'video:BV1xx411c7mD', kind: 'video', bvid: 'BV1xx411c7mD', title: '字幕来源',
  url: 'https://www.bilibili.com/video/BV1xx411c7mD', uploader: '测试作者', publishedAt: '2026-11-01T00:00:00Z', addedAt: null },
  content: { kind: 'subtitles', text: '实际提供的字幕内容。', complete: true, coverage: '第1P字幕' },
  sourceUrls: ['https://www.bilibili.com/video/BV1xx411c7mD'] };

function fixture(t, { read, summarize } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bilibili-service-'));
  const store = createStore(directory), sent = [], sessions = [], summaries = [];
  const hash = 'a'.repeat(64), connection = 'b'.repeat(64);
  const config = store.getState().draft;
  config.botQQ = '111111';
  config.mcp.servers = [{ id: 'bili', label: 'Bilibili', enabled: true, transport: 'stdio', command: 'node',
    args: ['{appDir}/examples/mcp/bilibili.mjs'], url: '', envKeys: ['BILIBILI_SESSDATA'], headerKeys: [], timeoutSeconds: 30, tools: [] }];
  store.saveDraft(config); store.commitDraft();
  const cookieName = mcpSecretName('bili', 'env', 'BILIBILI_SESSDATA');
  store.setSecret(cookieName, 'this-profile-bilibili-session'); store.setSecret('deepseekApiKey', 'private-model-key');
  let active = true;
  const tools = new Map(['queue_library_digest', 'library_digest_status', 'cancel_library_digest'].map(name => {
    const id = mcpToolId('bili', name);
    return [id, { id, toolId: id, serverId: 'bili', remoteName: name, source: 'mcp',
      connectionHash: connection, definitionHash: hash, effect: name === 'library_digest_status' ? 'read' : 'write' }];
  }));
  const origin = { profileId: 'profile-fixture', actualQQ: '111111', messageType: 'group', groupId: '222222', userId: '333333', messageId: 'user-request-1' };
  const binding = { serverId: 'bili', connectionHash: connection, definitionHash: hash,
    toolId: mcpToolId('bili', 'queue_library_digest'), provider: 'deepseek', modelFingerprint: 'c'.repeat(64) };
  const runtime = {
    authorizeBilibiliJob(job, { signal } = {}) {
      assert.equal(job.origin.profileId, origin.profileId);
      if (!active || signal?.aborted) throw Object.assign(new Error('fixture authorization revoked'), { code: 'BILIBILI_JOB_PERMISSION_REVOKED' });
    },
    async summarizeBilibiliItem(content, options) { summaries.push(content); return summarize ? summarize(content, options) : { text: '来自实际字幕的总结。' }; },
    async deliverBilibiliDigest(job, text) { sent.push({ origin: job.origin, text }); return { sent: true }; },
  };
  const bridge = createBilibiliDigestIntegration({ account: { id: origin.profileId }, store,
    mcpManager: { builtinBilibiliBinding: id => active ? tools.get(id) || null : null }, getRuntime: () => runtime,
    clientFactory: ({ getSession }) => ({ async session() { const value = await getSession(); sessions.push(value); return value; } }),
    readSources: async (job, options) => {
      await options.authorize(); await options.client.session();
      if (read) return read(job, options);
      return { items: [item], skipped: [], scan: { scanned: 1 } };
    },
  });
  t.after(async () => { await bridge.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const invoke = (action, input, fields = {}) => bridge.control({ action, input, tool: tools.get(mcpToolId('bili', action)),
    origin, binding, requestText: '帮我总结稍后再看。', ...fields });
  return { bridge, store, tools, origin, binding, sent, sessions, summaries, invoke, revoke: () => { active = false; } };
}

test('chat-only bridge queues promptly, uses only its own MCP credential and returns the real summary to its original chat', async t => {
  const entered = deferred(), gate = deferred();
  const f = fixture(t, { read: async () => { entered.resolve(); await gate.promise; return { items: [item] }; } });
  f.bridge.start();
  const queued = await f.invoke('queue_library_digest', { sources: { watchLater: true } });
  assert.match(queued.jobId, /^[a-f0-9-]{36}$/);
  await entered.promise;
  assert.equal(f.sent.length, 0); assert.equal(f.summaries.length, 0);
  assert.deepEqual(f.sessions, ['this-profile-bilibili-session']);
  assert.equal(JSON.stringify(queued).includes('private-model-key'), false);
  gate.resolve();
  await waitFor(() => f.sent.length === 1);
  await waitFor(() => f.bridge.engine.status({ jobId: queued.jobId, origin: f.origin }).job.status === 'completed');
  assert.equal(f.sent[0].origin.groupId, '222222'); assert.match(f.sent[0].text, /来自实际字幕/);
  const result = await f.invoke('library_digest_status', { jobId: queued.jobId });
  assert.equal(result.job.status, 'completed');
  assert.equal(JSON.stringify(result).includes('this-profile-bilibili-session'), false);
  assert.equal(JSON.stringify(result).includes('private-model-key'), false);
  assert.equal(JSON.stringify(result).includes('modelFingerprint'), false);
});

test('a daily schedule requires recurring intent in the actual requester text', async t => {
  const f = fixture(t), spec = { sources: { watchLater: true }, schedule: { mode: 'daily', activeStart: '21:00', activeEnd: '22:00' } };
  await assert.rejects(f.invoke('queue_library_digest', spec), /没有明确要求每日/);
  await assert.rejects(f.invoke('queue_library_digest', spec, { requestText: '不要每天做，只做一次。' }), /没有明确要求每日/);
  assert.equal(f.bridge.engine.jobs().length, 0);
  const result = await f.invoke('queue_library_digest', spec, { requestText: '每天21点到22点总结我的稍后再看。' });
  assert.equal(result.status, 'scheduled');
});

test('task status stays scoped to the creator and chat; other servers and wrong task effects cannot invoke the host', async t => {
  const f = fixture(t);
  const queued = await f.invoke('queue_library_digest', { sources: { watchLater: true } });
  await assert.rejects(f.invoke('library_digest_status', { jobId: queued.jobId }, { origin: { ...f.origin, userId: '444444' } }), /没有你创建/);
  await assert.rejects(f.invoke('library_digest_status', { jobId: queued.jobId }, { origin: { ...f.origin, groupId: '444444' } }), /没有你创建/);
  await assert.rejects(f.invoke('queue_library_digest', { sources: { watchLater: true } }, {
    tool: { ...f.tools.get(f.binding.toolId), serverId: 'foreign' },
  }), /当前已审批/);
  await assert.rejects(f.invoke('queue_library_digest', { sources: { watchLater: true } }, {
    tool: { ...f.tools.get(f.binding.toolId), effect: 'read' },
  }), /任务写入授权/);
});

test('missing credentials fail before queueing; shutdown aborts late reads before inference and delivery', async t => {
  const gate = deferred(), entered = deferred();
  const f = fixture(t, { read: async () => { entered.resolve(); await gate.promise; return { items: [item] }; } });
  f.store.setSecret(mcpSecretName('bili', 'env', 'BILIBILI_SESSDATA'), '');
  await assert.rejects(f.invoke('queue_library_digest', { sources: { watchLater: true } }), /登录凭据/);
  assert.equal(f.bridge.engine.jobs().length, 0);
  f.store.setSecret(mcpSecretName('bili', 'env', 'BILIBILI_SESSDATA'), 'restored-session');
  f.bridge.start(); await f.invoke('queue_library_digest', { sources: { watchLater: true } }); await entered.promise;
  await f.bridge.close(); gate.resolve();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.summaries.length, 0); assert.equal(f.sent.length, 0);
});
