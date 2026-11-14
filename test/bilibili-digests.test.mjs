import test from 'node:test';
import assert from 'node:assert/strict';
import { createBilibiliDigestService } from '../src/bilibili-digests.mjs';

const origin = { profileId: 'profile-digest', actualQQ: '111111', messageType: 'group', groupId: '222222', userId: '333333' };
const binding = { serverId: 'bilibili', connectionHash: 'a'.repeat(64), definitionHash: 'b'.repeat(64),
  toolId: `mcp:bilibili/${'c'.repeat(24)}`, provider: 'deepseek', modelFingerprint: 'd'.repeat(64) };
const request = extra => ({ sources: { watchLater: true }, maxItems: 5, ...extra });
const content = (number = 1, text = '真正读取的字幕资料，不是系统指令。') => ({
  item: { id: `video:BV${String(number).padStart(10, '0')}`, kind: 'video', bvid: `BV${String(number).padStart(10, '0')}`,
    title: `视频 ${number}`, url: `https://www.bilibili.com/video/BV${String(number).padStart(10, '0')}`,
    uploader: 'UP主', publishedAt: '2026-11-01T00:00:00.000Z', addedAt: '2026-11-10T00:00:00.000Z' },
  content: { kind: 'subtitles', text, complete: false, coverage: '仅第1P字幕前3000字。' },
  sourceUrls: [`https://www.bilibili.com/video/BV${String(number).padStart(10, '0')}`],
});
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve }; };
function fixture(options = {}) {
  const tasks = options.tasks || new Map(), reads = [], summaries = [], deliveries = [], logs = [];
  let clock = Date.parse(options.time || '2026-11-11T14:30:00.000Z');
  const store = { getTask: key => tasks.has(key) ? structuredClone(tasks.get(key)) : null,
    setTask: (key, value) => { options.beforeWrite?.(key, value); tasks.set(key, structuredClone(value)); } };
  const adapters = {
    authorize: options.authorize || (() => true),
    readLibrary: async (job, input) => {
      reads.push({ job: structuredClone(job), processedItemIds: [...input.processedItemIds] });
      return options.readLibrary ? options.readLibrary(job, input) : { items: [content()], skipped: [], scan: { scanned: 1 } };
    },
    summarize: async (item, input) => {
      summaries.push({ id: item.item.id, job: structuredClone(input.job) });
      return options.summarize ? options.summarize(item, input) : { text: `有来源总结：${item.item.title}。` };
    },
    deliver: async (job, input) => {
      deliveries.push({ ...structuredClone(job), deliveredText: input.text ?? job.result?.text ?? '' });
      return options.deliver ? options.deliver(job, input) : { messageId: 'digest-message-1' };
    },
  };
  const service = createBilibiliDigestService({ store, getConfig: () => ({ test: true }), ...adapters,
    now: () => clock, intervalMs: 60_000, runTimeoutMs: options.runTimeoutMs || 30_000,
    log: (...entry) => logs.push(entry) });
  return { service, tasks, reads, summaries, deliveries, logs,
    setTime: value => { clock = typeof value === 'number' ? value : Date.parse(value); },
    queue: (input = request(), extra = {}) => service.queue(input, { origin, binding, ...extra }),
    status: id => service.status({ jobId: id, origin }).job,
    async run() { service.start(); await service.tick(); },
  };
}

test('chat queue persists immediately, performs no work until started and returns source-backed results only to its origin', async t => {
  const f = fixture(); t.after(() => f.service.close());
  const queued = await f.queue(request({ focus: '梳理行动项' }), { origin: { ...origin, messageId: 'qq-message-1' } });
  assert.match(queued.jobId, /^[a-f0-9-]{36}$/);
  assert.equal(queued.status, 'queued'); assert.equal(f.reads.length, 0); assert.equal(f.summaries.length, 0);
  const same = await f.queue(request({ focus: '梳理行动项' }), { origin: { ...origin, messageId: 'qq-message-1' } });
  assert.equal(same.jobId, queued.jobId); assert.equal(same.duplicate, true);
  await f.run();
  const state = f.status(queued.jobId);
  assert.equal(state.status, 'completed'); assert.equal(state.completedItems, 1);
  assert.equal(f.deliveries.length, 1); assert.deepEqual(f.deliveries[0].origin, { ...origin, messageId: 'qq-message-1' });
  assert.equal(f.deliveries[0].result.delivery.state, 'attempted', 'delivery receipt must persist before sending');
  assert.equal(state.result.delivery.state, 'sent'); assert.match(state.result.text, /字幕资料.*覆盖不完整/u);
  assert.match(state.result.text, /https:\/\/www\.bilibili\.com\/video\/BV0000000001/u);
  assert.equal(JSON.stringify([...f.tasks.values()]).includes('真正读取的字幕资料'), false, 'raw source content must not enter job storage');
  assert.equal(JSON.stringify(state).includes(binding.connectionHash), false);
  assert.equal(JSON.stringify(state).includes(binding.modelFingerprint), false);
});

test('task status and cancellation stay private to the exact profile, verified QQ, chat and creator', async t => {
  const f = fixture(); t.after(() => f.service.close()); const queued = await f.queue();
  for (const different of [
    { profileId: 'another-profile' }, { actualQQ: '777777' }, { groupId: '888888' }, { userId: '999999' },
    { messageType: 'private', groupId: undefined },
  ]) {
    const caller = { ...origin, ...different }; if (caller.messageType === 'private') delete caller.groupId;
    assert.deepEqual(f.service.status({ origin: caller }).jobs, []);
    assert.throws(() => f.service.status({ jobId: queued.jobId, origin: caller }), error => error.statusCode === 404);
    assert.throws(() => f.service.cancel({ jobId: queued.jobId, origin: caller }), error => error.statusCode === 404);
  }
  assert.equal(f.service.cancel({ jobId: queued.jobId, origin }).status, 'cancelled');
  await f.run(); assert.equal(f.reads.length, 0);
});

test('daily windows use the requested timezone and overnight window date, deduplicating completed content across days', async t => {
  const f = fixture({ readLibrary: async (_job, { processedItemIds }) => ({ items: [content(1), content(1), content(2)], skipped: [],
    scan: { scanned: 3, processed: processedItemIds.length } }) });
  t.after(() => f.service.close());
  const queued = await f.queue(request({ schedule: { mode: 'daily', timeZone: 'Asia/Shanghai', activeStart: '22:00', activeEnd: '02:00' } }));
  await f.run(); assert.equal(f.summaries.length, 2); assert.equal(f.deliveries.length, 1);
  f.setTime('2026-11-11T17:00:00.000Z'); await f.service.tick();
  assert.equal(f.reads.length, 1, '01:00 belongs to the previous overnight window');
  f.setTime('2026-11-12T13:59:00.000Z'); await f.service.tick(); assert.equal(f.reads.length, 1);
  f.setTime('2026-11-12T14:00:00.000Z'); await f.service.tick();
  assert.equal(f.reads.length, 2); assert.deepEqual(f.reads[1].processedItemIds.sort(), [content(1).item.id, content(2).item.id]);
  assert.equal(f.summaries.length, 2, 'completed source IDs must not trigger another model call');
  assert.equal(f.deliveries.length, 1, 'an empty daily update must not repeatedly send the old summary');
  assert.equal(f.status(queued.jobId).status, 'scheduled');
});

test('one-off jobs honor their run window and rolling content time ranges are evaluated at each run', async t => {
  const f = fixture({ time: '2026-11-11T10:00:00.000Z' }); t.after(() => f.service.close());
  const queued = await f.queue(request({ timeFilter: { basis: 'published', lookbackDays: 7 },
    schedule: { mode: 'daily', timeZone: 'UTC', activeStart: '11:00', activeEnd: '12:00' } }));
  await f.run(); assert.equal(f.reads.length, 0);
  f.setTime('2026-11-11T11:00:00.000Z'); await f.service.tick();
  assert.deepEqual(f.reads[0].job.effectiveTimeFilter, { basis: 'published', from: '2026-11-04T11:00:00.000Z', until: '2026-11-11T11:00:00.000Z' });
  assert.equal(f.reads[0].job.request.timeFilter.lookbackDays, 7);
  f.setTime('2026-11-12T11:00:00.000Z'); await f.service.tick();
  assert.equal(f.reads[1].job.effectiveTimeFilter.from, '2026-11-05T11:00:00.000Z');
  assert.equal(f.status(queued.jobId).runsStarted, 2);
});

test('startup authorization waits do not consume the daily receipt or permanently block a ready-later task', async t => {
  let ready = false;
  const f = fixture({ authorize: (_job, { phase }) => {
    if (phase === 'before_start' && !ready) throw Object.assign(new Error('MCP still connecting'), { retryable: true });
    return true;
  } }); t.after(() => f.service.close());
  const queued = await f.queue(request({ schedule: { mode: 'daily', timeZone: 'UTC' } }));
  await f.run();
  assert.equal(f.status(queued.jobId).status, 'paused'); assert.equal(f.service.jobs()[0].lastWindowKey, null);
  ready = true; await f.service.tick(); assert.equal(f.reads.length, 0, 'short backoff is respected');
  f.setTime(Date.parse('2026-11-11T14:30:00.000Z') + 30_001); await f.service.tick();
  assert.equal(f.reads.length, 1); assert.equal(f.status(queued.jobId).status, 'scheduled');
});

test('one-off empty selections return one clear completion while daily filtered-only runs remain silent', async t => {
  const once = fixture({ readLibrary: async () => ({ items: [], skipped: [], scan: { scanned: 0 } }) });
  const daily = fixture({ readLibrary: async () => ({ items: [], skipped: [
    { id: content().item.id, code: 'ALREADY_PROCESSED', reason: '已经总结，无需重复。' },
    { id: content(2).item.id, code: 'OUTSIDE_TIME_RANGE', reason: '不在选定时间范围。' },
  ], scan: { scanned: 2, filtered: 2 } }) });
  t.after(async () => { await once.service.close(); await daily.service.close(); });
  const one = await once.queue();
  assert.deepEqual(one.sources, { favoriteFolderIds: [], watchLater: true, favoriteArticles: false });
  assert.deepEqual(one.contentKinds, ['video', 'article']); assert.equal(one.maxItems, 5); assert.equal(one.timeFilter.basis, 'published');
  await once.run(); assert.equal(once.deliveries.length, 1); assert.match(once.deliveries[0].deliveredText, /没有新的.*符合时间范围/u);
  assert.equal(once.status(one.jobId).status, 'completed');
  const recurring = await daily.queue(request({ schedule: { mode: 'daily', timeZone: 'UTC' } }));
  await daily.run();
  assert.equal(daily.deliveries.length, 0); assert.equal(daily.summaries.length, 0);
  assert.equal(daily.status(recurring.jobId).result.delivery.state, 'skipped');
  assert.equal(daily.status(recurring.jobId).status, 'scheduled');
});

test('real failures return one fixed host receipt without invoking another model or exposing raw errors', async () => {
  const leaked = 'fake-session-secret-that-must-not-appear';
  const f = fixture({ readLibrary: async () => { throw new Error(`login ${leaked} denied`); } });
  const queued = await f.queue(); await f.run();
  assert.equal(f.summaries.length, 0); assert.equal(f.deliveries.length, 1);
  assert.match(f.deliveries[0].deliveredText, /Bilibili 后台任务未能完成/u);
  assert.match(f.deliveries[0].deliveredText, new RegExp(queued.jobId));
  assert.equal(f.deliveries[0].deliveredText.includes(leaked), false);
  assert.equal(JSON.stringify(f.status(queued.jobId)).includes(leaked), false);
  assert.equal(f.status(queued.jobId).failureNotification.state, 'sent');
  await f.service.tick(); assert.equal(f.deliveries.length, 1);
  await f.service.close();
  const restarted = fixture({ tasks: f.tasks });
  try { await restarted.run(); assert.equal(restarted.deliveries.length, 0); }
  finally { await restarted.service.close(); }
});

test('fixed failure receipts also obey fresh authorization and uncertain failure receipts never replay', async t => {
  let authorized = true;
  const revoked = fixture({ authorize: () => authorized, readLibrary: async () => { authorized = false; throw new Error('login unavailable'); } });
  t.after(() => revoked.service.close()); await revoked.queue(); await revoked.run(); assert.equal(revoked.deliveries.length, 0);
  const uncertain = fixture({ readLibrary: async () => { throw new Error('invalid source'); },
    deliver: async () => { throw Object.assign(new Error('receipt may already have arrived'), { deliveryUncertain: true }); } });
  const queued = await uncertain.queue(); await uncertain.run();
  assert.equal(uncertain.deliveries.length, 1); assert.equal(uncertain.status(queued.jobId).failureNotification.state, 'unknown');
  await uncertain.service.close();
  const restarted = fixture({ tasks: uncertain.tasks });
  try { await restarted.run(); assert.equal(restarted.deliveries.length, 0); }
  finally { await restarted.service.close(); }
});

test('a transient connection loss after source scanning can recover within the same daily window before any model attempt', async t => {
  let disconnected = false, firstRead = true;
  const f = fixture({ authorize: (_job, { phase }) => {
    if (disconnected && phase !== 'queue') throw Object.assign(new Error('QQ temporarily reconnecting'), { retryable: true });
    return true;
  }, readLibrary: async () => {
    if (firstRead) { firstRead = false; disconnected = true; }
    return { items: [content()] };
  } }); t.after(() => f.service.close());
  const queued = await f.queue(request({ schedule: { mode: 'daily', timeZone: 'UTC' } }));
  await f.run();
  assert.equal(f.summaries.length, 0); assert.equal(f.status(queued.jobId).status, 'paused');
  assert.equal(f.service.jobs()[0].lastWindowKey, null, 'no model/send means the claimed window can be safely returned');
  disconnected = false; f.setTime(Date.parse('2026-11-11T14:30:00.000Z') + 30_001); await f.service.tick();
  assert.equal(f.reads.length, 2); assert.equal(f.summaries.length, 1); assert.equal(f.deliveries.length, 1);
  await f.service.tick(); assert.equal(f.summaries.length, 1, 'the successful recovery still consumes this window once');
});

test('only short verbatim source excerpts survive as evidence and invented citations stop the task', async t => {
  const f = fixture({ summarize: async () => ({ text: '字幕中介绍了资料核对。', evidence: [{ text: '真正读取的字幕资料' }] }) });
  t.after(() => f.service.close()); const queued = await f.queue(); await f.run();
  assert.deepEqual(f.service.jobs()[0].result.items[0].evidence, [{ text: '真正读取的字幕资料' }]);
  assert.match(f.status(queued.jobId).result.text, /原文：「真正读取的字幕资料」/u);
  assert.deepEqual(f.status(queued.jobId).result.evidence[0].evidence, [{ text: '真正读取的字幕资料' }]);
  const forged = fixture({ summarize: async () => ({ text: '伪造正文总结', evidence: [{ text: '本次源文本不存在的引用' }] }) });
  try {
    const job = await forged.queue(); await forged.run();
    assert.equal(forged.deliveries.length, 1); assert.match(forged.deliveries[0].deliveredText, /后台任务未能完成/u);
    assert.equal(forged.deliveries[0].deliveredText.includes('本次源文本不存在的引用'), false); assert.equal(forged.status(job.jobId).completedItems, 0);
    assert.equal(forged.status(job.jobId).status, 'failed');
  } finally { await forged.service.close(); }
});

test('cancellation interrupts even an uncooperative model callback and late completion never saves or sends', async t => {
  const entered = deferred(), delayed = deferred();
  const f = fixture({ summarize: async () => { entered.resolve(); return delayed.promise; } }); t.after(() => f.service.close());
  const queued = await f.queue(); f.service.start(); const running = f.service.tick(); await entered.promise;
  f.service.cancel({ jobId: queued.jobId, origin }); await running;
  assert.equal(f.status(queued.jobId).status, 'cancelled'); assert.equal(f.status(queued.jobId).completedItems, 0);
  delayed.resolve({ text: '晚到的总结，不应保存或发送' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.deliveries.length, 0); assert.equal(JSON.stringify([...f.tasks.values()]).includes('晚到的总结'), false);
});

test('revoking authorization during inference blocks later summaries and delivery without marking the item complete', async t => {
  const entered = deferred(), delayed = deferred(); let allowed = true;
  const f = fixture({ authorize: () => allowed,
    readLibrary: async () => ({ items: [content(1), content(2)], scan: {} }),
    summarize: async () => { entered.resolve(); return delayed.promise; } }); t.after(() => f.service.close());
  const queued = await f.queue(); f.service.start(); const running = f.service.tick(); await entered.promise;
  allowed = false; delayed.resolve({ text: '撤权后的结果' }); await running;
  assert.equal(f.summaries.length, 1); assert.equal(f.deliveries.length, 0); assert.equal(f.status(queued.jobId).completedItems, 0);
  assert.equal(f.status(queued.jobId).status, 'blocked'); await f.service.tick(); assert.equal(f.summaries.length, 1);
});

test('a run window closing during source reads prevents any subsequent model call until the next window', async t => {
  let first = true, f;
  f = fixture({ time: '2026-11-11T14:30:00.000Z', readLibrary: async () => {
    if (first) { first = false; f.setTime('2026-11-11T14:31:00.000Z'); }
    return { items: [content()] };
  } }); t.after(() => f.service.close());
  const queued = await f.queue(request({ schedule: { mode: 'once', timeZone: 'UTC', activeStart: '14:30', activeEnd: '14:31' } }));
  await f.run(); assert.equal(f.summaries.length, 0); assert.equal(f.status(queued.jobId).status, 'queued');
  assert.match(f.status(queued.jobId).reason, /运行时段已结束/u);
  f.setTime('2026-11-12T14:30:00.000Z'); await f.service.tick();
  assert.equal(f.summaries.length, 1); assert.equal(f.deliveries.length, 1);
});

test('a window closing during inference discards its late result and never sends outside the selected hours', async t => {
  const entered = deferred(), delayed = deferred();
  const f = fixture({ summarize: async () => { entered.resolve(); return delayed.promise; } }); t.after(() => f.service.close());
  const queued = await f.queue(request({ schedule: { mode: 'daily', timeZone: 'UTC', activeStart: '14:00', activeEnd: '15:00' } }));
  f.service.start(); const running = f.service.tick(); await entered.promise;
  f.setTime('2026-11-11T15:00:00.000Z'); delayed.resolve({ text: '越过时段的晚到总结' }); await running;
  assert.equal(f.status(queued.jobId).status, 'scheduled'); assert.equal(f.status(queued.jobId).completedItems, 0);
  assert.equal(f.deliveries.length, 0); assert.equal(JSON.stringify([...f.tasks.values()]).includes('越过时段的晚到总结'), false);
});

test('configuration reload cancels in-flight source reads and does not let late source work resume the old task', async t => {
  const entered = deferred(), delayed = deferred();
  const f = fixture({ readLibrary: async () => { entered.resolve(); return delayed.promise; } }); t.after(() => f.service.close());
  const queued = await f.queue(); f.service.start(); const running = f.service.tick(); await entered.promise;
  await f.service.reload(); await running;
  assert.equal(f.status(queued.jobId).status, 'blocked');
  delayed.resolve({ items: [content()] }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.summaries.length, 0); assert.equal(f.deliveries.length, 0);
});

test('closing pauses an unfinished one-off job, and restart resumes without re-summarizing persisted completed items', async () => {
  const entered = deferred(), delayed = deferred();
  const first = fixture({ readLibrary: async () => ({ items: [content(1), content(2)] }),
    summarize: async item => { if (item.item.id === content(2).item.id) { entered.resolve(); return delayed.promise; } return { text: '第一条已核对总结' }; } });
  const queued = await first.queue(); first.service.start(); const running = first.service.tick(); await entered.promise;
  await first.service.close(); await running;
  assert.equal(first.service.jobs()[0].state, 'queued');
  assert.deepEqual(first.service.jobs()[0].completedItemIds, [content(1).item.id]);
  delayed.resolve({ text: '已退出的第二条旧结果' });
  const second = fixture({ tasks: first.tasks, readLibrary: async (_job, input) => {
    assert.deepEqual(input.processedItemIds, [content(1).item.id]); return { items: [content(1), content(2)] };
  } });
  try {
    await second.run();
    assert.equal(second.summaries.length, 1); assert.equal(second.summaries[0].id, content(2).item.id);
    assert.equal(second.deliveries.length, 1); assert.match(second.deliveries[0].result.text, /第一条已核对总结/u);
    assert.equal(second.status(queued.jobId).status, 'completed');
  } finally { await second.service.close(); }
});

test('uncertain delivery persists the result and never automatically repeats a send, including crash recovery', async () => {
  const first = fixture({ deliver: async () => { throw Object.assign(new Error('ACK connection lost'), { deliveryUncertain: true }); } });
  const queued = await first.queue(); await first.run();
  assert.equal(first.status(queued.jobId).status, 'delivery_unknown'); assert.equal(first.status(queued.jobId).result.delivery.state, 'unknown');
  await first.service.tick(); assert.equal(first.deliveries.length, 1);
  await first.service.close();
  // Model the exact persisted state of a crash after the attempted marker.
  const [key, state] = [...first.tasks][0]; state.jobs[0].state = 'running'; state.jobs[0].result.delivery.state = 'attempted'; first.tasks.set(key, state);
  const second = fixture({ tasks: first.tasks });
  try {
    await second.run(); assert.equal(second.deliveries.length, 0); assert.equal(second.summaries.length, 0);
    assert.equal(second.status(queued.jobId).status, 'delivery_unknown'); assert.match(second.status(queued.jobId).result.text, /有来源总结/u);
  } finally { await second.service.close(); }
});

test('crash recovery rebuilds already-paid partial summaries for status without directly delivering or losing the daily receipt', async t => {
  for (const mode of ['once', 'daily']) await t.test(mode, async () => {
    const entered = deferred(), delayed = deferred();
    const first = fixture({ readLibrary: async () => ({ items: [content(1), content(2)] }),
      summarize: async item => {
        if (item.item.id === content(2).item.id) { entered.resolve(); return delayed.promise; }
        return { text: '崩溃前已完成的真实摘要', evidence: [{ text: '真正读取的字幕资料' }] };
      } });
    const queued = await first.queue(request({ schedule: { mode, timeZone: 'UTC' } }));
    first.service.start(); const running = first.service.tick(); await entered.promise;
    const crashSnapshot = new Map([...first.tasks].map(([key, value]) => [key, structuredClone(value)]));
    assert.equal([...crashSnapshot.values()][0].jobs[0].result.text, '');
    await first.service.close(); await running; delayed.resolve({ text: '退出后旧模型结果' });
    const restored = fixture({ tasks: crashSnapshot });
    try {
      const status = restored.status(queued.jobId);
      assert.match(status.result.text, /崩溃前已完成的真实摘要/u);
      assert.match(status.result.text, /原文：「真正读取的字幕资料」/u);
      assert.equal(status.completedItems, 1); assert.equal(restored.deliveries.length, 0);
      assert.equal(restored.summaries.length, 0, 'reconstruction itself must never call an LLM');
      if (mode === 'daily') {
        await restored.run();
        assert.equal(restored.reads.length, 0, 'today already has a persisted run receipt');
        assert.equal(restored.deliveries.length, 0); assert.equal(restored.summaries.length, 0);
        assert.match(restored.status(queued.jobId).result.text, /崩溃前已完成/u);
      }
    } finally { await restored.service.close(); }
  });
});

test('concurrent queue requests respect both the active-task limit and same-message deduplication', async t => {
  const gate = deferred(); let holding = false;
  const f = fixture({ authorize: async (_job, { phase }) => { if (holding && phase === 'queue') await gate.promise; return true; } }); t.after(() => f.service.close());
  holding = true;
  const duplicateOne = f.queue(request(), { origin: { ...origin, messageId: 'same-message' } });
  const duplicateTwo = f.queue(request(), { origin: { ...origin, messageId: 'same-message' } });
  gate.resolve(); const duplicates = await Promise.all([duplicateOne, duplicateTwo]);
  assert.equal(duplicates[0].jobId, duplicates[1].jobId);
  const attempts = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => f.queue(request({ focus: `task-${i}` }))));
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 19);
  assert.equal(attempts.filter(item => item.status === 'rejected').length, 1);
  assert.equal(f.service.jobs().length, 20);
});

test('source evidence, item count, output bytes and public status stay bounded without exposing content or credentials', async t => {
  const f = fixture({ readLibrary: async () => ({ items: Array.from({ length: 20 }, (_, i) => content(i + 1)), scan: { scanned: 20, token: 'must-not-store', truncated: true } }),
    summarize: async () => ({ text: '中文总结'.repeat(2000) }) }); t.after(() => f.service.close());
  const queued = await f.queue(request({ maxItems: 10, focus: '重点'.repeat(500) })); await f.run();
  assert.equal(f.summaries.length, 10); assert.ok(f.deliveries[0].result.text.length <= 10_000);
  const result = f.service.status({ jobId: queued.jobId, origin });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 24 * 1024);
  assert.equal(JSON.stringify([...f.tasks.values()]).includes('must-not-store'), false);
  assert.equal(JSON.stringify(result).includes('真正读取的字幕资料'), false);
  const invalid = fixture({ readLibrary: async () => ({ items: [{ ...content(), item: { ...content().item, url: 'https://attacker.invalid/file' } }] }) });
  try { await invalid.queue(); await invalid.run(); assert.equal(invalid.summaries.length, 0); assert.equal(invalid.deliveries.length, 1);
    assert.match(invalid.deliveries[0].deliveredText, /后台任务未能完成/u); assert.equal(invalid.deliveries[0].deliveredText.includes('attacker.invalid'), false); }
  finally { await invalid.service.close(); }
});

test('the total run deadline cancels an ignored signal without leaving close or the profile queue hung', async t => {
  const entered = deferred();
  const f = fixture({ runTimeoutMs: 20, readLibrary: async () => { entered.resolve(); return new Promise(() => {}); } });
  t.after(() => f.service.close());
  const queued = await f.queue(); f.service.start(); const running = f.service.tick(); await entered.promise;
  const keeper = setTimeout(() => {}, 2000);
  try { await running; }
  finally { clearTimeout(keeper); }
  assert.equal(f.status(queued.jobId).status, 'failed'); assert.equal(f.summaries.length, 0); await f.service.close();
});
