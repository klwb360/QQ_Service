import { createHash, randomUUID } from 'node:crypto';
import { normalizeBilibiliDigestRequest } from './bilibili-digest-tools.mjs';

const STORE_KEY = 'bilibili-digests:v1';
const MAX_JOBS = 50, MAX_ACTIVE = 20, MAX_SEEN = 1000;
const RUN_TIMEOUT_MS = 5 * 60_000, RETRY_MS = 30_000;
const MAX_PUBLIC_BYTES = 24 * 1024, MAX_DIGEST_CHARS = 10_000;
const activeStates = new Set(['queued', 'scheduled', 'running', 'paused']);
const validQQ = value => typeof value === 'string' && /^[1-9]\d{3,19}$/u.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = value => structuredClone(value);
const fail = (message, code = 'BILIBILI_DIGEST_INVALID', statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const stamp = time => new Date(time).toISOString();
const clip = (value, length) => String(value ?? '').replace(/\u0000/gu, '').slice(0, length);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function interruptible(action, signal) {
  if (signal?.aborted) throw fail('后台任务已取消。', 'BILIBILI_DIGEST_CANCELLED', 409);
  if (!signal) return action();
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(fail('后台任务已取消。', 'BILIBILI_DIGEST_CANCELLED', 409));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      if (signal.aborted) throw fail('后台任务已取消。', 'BILIBILI_DIGEST_CANCELLED', 409);
      return action();
    }), cancelled]);
  } finally { signal.removeEventListener('abort', onAbort); }
}

function originOf(input) {
  if (!object(input) || typeof input.profileId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/u.test(input.profileId)
    || !validQQ(input.actualQQ) || !validQQ(input.userId) || !['group', 'private'].includes(input.messageType)
    || input.messageType === 'group' && !validQQ(input.groupId)
    || input.messageType === 'private' && input.groupId !== undefined
    || input.invocation === 'autonomous') throw fail('后台任务必须来自当前已验证账号的明确聊天请求。');
  const value = { profileId: input.profileId, actualQQ: input.actualQQ, messageType: input.messageType,
    ...(input.messageType === 'group' ? { groupId: input.groupId } : {}), userId: input.userId };
  if (input.messageId !== undefined) {
    if (typeof input.messageId !== 'string' || !input.messageId || input.messageId.length > 300) throw fail('后台任务来源消息标识无效。');
    value.messageId = input.messageId;
  }
  return value;
}
function sameOrigin(left, right) {
  return ['profileId', 'actualQQ', 'messageType', 'groupId', 'userId'].every(key => left[key] === right[key]);
}
function bindingOf(input) {
  const keys = ['serverId', 'connectionHash', 'definitionHash', 'toolId', 'provider', 'modelFingerprint'];
  if (!object(input) || Object.keys(input).some(key => !keys.includes(key))
    || typeof input.serverId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(input.serverId)
    || !['connectionHash', 'definitionHash', 'modelFingerprint'].every(key => typeof input[key] === 'string' && /^[a-f0-9]{64}$/u.test(input[key]))
    || typeof input.toolId !== 'string' || !/^mcp:[a-z][a-z0-9-]{0,63}\/[a-f0-9]{24}$/u.test(input.toolId)
    || !input.toolId.startsWith(`mcp:${input.serverId}/`)
    || typeof input.provider !== 'string' || !/^(?:deepseek|api_[A-Za-z0-9_-]{1,64})$/u.test(input.provider)) {
    throw fail('后台任务缺少当前连接、工具审批或模型绑定。');
  }
  return Object.fromEntries(keys.map(key => [key, input[key]]));
}
const dateKey = parts => `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
function localWindow(time, schedule) {
  const fields = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: schedule.timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(time)
    .filter(part => ['year', 'month', 'day', 'hour', 'minute'].includes(part.type)).map(part => [part.type, Number(part.value)]));
  const minutes = fields.hour * 60 + fields.minute;
  const asMinutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const start = asMinutes(schedule.activeStart), end = asMinutes(schedule.activeEnd);
  const allowed = start === end || (start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end);
  // An overnight window belongs to its starting local date, not to both sides
  // of midnight. Calendar arithmetic deliberately avoids DST-length assumptions.
  if (start > end && minutes < end) {
    const previous = new Date(Date.UTC(fields.year, fields.month - 1, fields.day - 1));
    return { allowed, key: previous.toISOString().slice(0, 10) };
  }
  return { allowed, key: dateKey(fields) };
}
export { localWindow as bilibiliDigestWindow };

function sourceUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['bilibili.com', 'www.bilibili.com', 'api.bilibili.com'].includes(url.hostname)
      || url.username || url.password || url.port) return '';
    url.search = ''; url.hash = '';
    return url.href.slice(0, 1000);
  } catch { return ''; }
}
function evidenceOf(input, summarized) {
  const item = input?.item, content = input?.content;
  if (!object(item) || !object(content) || typeof item.id !== 'string'
    || !/^(?:video:BV[0-9A-Za-z]{10}|article:[1-9]\d{0,19})$/u.test(item.id)
    || !['video', 'article'].includes(item.kind) || !item.id.startsWith(`${item.kind}:`)
    || !['subtitles', 'article_text', 'metadata_only'].includes(content.kind)
    || typeof content.text !== 'string' || !sourceUrl(item.url)) throw fail('内容来源没有可核对的 Bilibili 身份或正文依据。', 'BILIBILI_DIGEST_SOURCE_INVALID');
  const summary = typeof summarized === 'string' ? summarized : summarized?.text;
  if (typeof summary !== 'string' || !summary.trim()) throw fail('模型没有返回有效总结。', 'BILIBILI_DIGEST_SUMMARY_INVALID');
  const quotes = [];
  if (object(summarized) && summarized.evidence !== undefined) {
    if (!Array.isArray(summarized.evidence) || summarized.evidence.length > 5) throw fail('模型引用数量或格式无效。', 'BILIBILI_DIGEST_SUMMARY_INVALID');
    for (const citation of summarized.evidence) {
      if (!object(citation) || typeof citation.text !== 'string' || !citation.text.trim()
        || citation.text.length > 300 || !content.text.includes(citation.text)) throw fail('模型引用未能在本次读取的正文中核对。', 'BILIBILI_DIGEST_SUMMARY_INVALID');
      if (!quotes.some(item => item.text === citation.text)) quotes.push({ text: citation.text });
    }
  }
  const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  return { id: item.id, kind: item.kind, title: clip(item.title, 160), url: sourceUrl(item.url), uploader: clip(item.uploader, 80),
    publishedAt: date(item.publishedAt), addedAt: date(item.addedAt), sourceKind: content.kind, complete: content.complete === true,
    coverage: clip(content.coverage, 300), reason: clip(content.reason, 300),
    sourceUrls: [...new Set([sourceUrl(item.url), ...(Array.isArray(input.sourceUrls) ? input.sourceUrls.map(sourceUrl).filter(Boolean) : [])])].slice(0, 4),
    summary: clip(summary.trim(), 2500), evidence: quotes, ...(summary.trim().length > 2500 ? { truncated: true } : {}) };
}
function scanOf(input) {
  if (!object(input)) return {};
  return Object.fromEntries(Object.entries(input).filter(([key, value]) => ['scanned', 'filtered', 'duplicates', 'alreadyProcessed', 'upstreamSkipped',
    'sourceCount', 'sourcesScanned', 'eligible', 'contentReads', 'pages', 'truncated', 'selected', 'processed'].includes(key)
    && (typeof value === 'boolean' || Number.isSafeInteger(value) && value >= 0)).map(([key, value]) => [key, value]));
}
function skippedOf(input) {
  return (Array.isArray(input) ? input : []).slice(0, 20).map(item => ({
    id: typeof item?.id === 'string' && /^(?:video:BV[0-9A-Za-z]{10}|article:[1-9]\d{0,19})$/u.test(item.id) ? item.id : '',
    reason: clip(item?.reason || '内容未能读取。', 200),
  }));
}
function digestText(job, result) {
  const label = { subtitles: '字幕资料', article_text: '专栏正文', metadata_only: '仅标题与简介' };
  const header = job.request.schedule.mode === 'daily' ? 'Bilibili 定时浏览总结' : 'Bilibili 浏览总结';
  const sections = result.items.map((item, index) => `${index + 1}. ${item.title || item.id}\n依据：${label[item.sourceKind]}${item.complete ? '' : '（覆盖不完整）'}${item.coverage ? `；${item.coverage}` : ''}\n${item.summary}${item.evidence?.length ? `\n原文：「${item.evidence[0].text}」` : ''}\n${item.url}`);
  let text = `${header}\n${sections.length ? sections.join('\n\n') : '本次没有新的、符合时间范围且可读取的内容。'}`;
  if (result.skipped.length) text += `\n\n另有 ${result.skipped.length} 项未读取：${result.skipped.slice(0, 3).map(item => item.reason).join('；')}`;
  if (result.scan.truncated) text += '\n本次扫描达到数量或分页上限，未覆盖来源中的全部内容。';
  if (text.length > MAX_DIGEST_CHARS) text = text.slice(0, MAX_DIGEST_CHARS - 38) + '\n[总结已截断；可查询任务状态查看来源。]';
  return text;
}

/** Profile-local background work. The host binds authorization, source reads,
 * inference and the destination; model arguments never supply those callbacks. */
export function createBilibiliDigestService({ store, getConfig = () => ({}), authorize, readLibrary, summarize, deliver,
  log = () => {}, now = () => Date.now(), intervalMs = 15_000, runTimeoutMs = RUN_TIMEOUT_MS } = {}) {
  if (!store?.getTask || !store?.setTask || [authorize, readLibrary, summarize, deliver].some(value => typeof value !== 'function')) {
    throw new TypeError('Bilibili 后台任务需要账号存储和宿主授权／读取／模型／投递适配器。');
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10 || !Number.isSafeInteger(runTimeoutMs) || runTimeoutMs < 10 || runTimeoutMs > RUN_TIMEOUT_MS) throw new TypeError('后台任务时限无效。');
  let records = [], started = false, closed = false, generation = 0, timer, kick, active, draining;
  const initial = store.getTask(STORE_KEY);
  if (initial !== null && initial !== undefined) {
    if (!object(initial) || initial.version !== 1 || !Array.isArray(initial.jobs) || initial.jobs.length > MAX_JOBS) throw fail('后台任务记录格式损坏，请恢复账号备份。', 'BILIBILI_DIGEST_STORE_INVALID', 500);
    records = copy(initial.jobs);
    // Validate persisted destinations and bindings before permitting recovery.
    for (const job of records) {
      if (!object(job) || typeof job.id !== 'string' || !/^[a-f0-9-]{36}$/u.test(job.id)) throw fail('后台任务身份无效。', 'BILIBILI_DIGEST_STORE_INVALID', 500);
      job.request = normalizeBilibiliDigestRequest(job.request); job.origin = originOf(job.origin); job.binding = bindingOf(job.binding);
      job.completedItemIds = Array.isArray(job.completedItemIds) ? job.completedItemIds.filter(id => typeof id === 'string').slice(-MAX_SEEN) : [];
      if (job.failureNotification?.state === 'attempted') job.failureNotification.state = 'unknown';
      if (job.state === 'running') {
        if (job.result?.items?.length && !job.result.text) job.result.text = digestText(job, job.result);
        if (['attempted', 'unknown'].includes(job.result?.delivery?.state)) {
          job.result.delivery.state = 'unknown'; job.state = job.request.schedule.mode === 'daily' ? 'scheduled' : 'delivery_unknown';
          job.reason = '上次投递结果无法确认，不会自动重发；请查询已保存总结。';
        } else {
          job.state = job.request.schedule.mode === 'daily' ? 'scheduled' : 'queued';
          job.reason = '正在按原运行窗口恢复未完成任务。';
        }
      }
    }
  }
  const current = id => records.find(job => job.id === id);
  const write = next => { store.setTask(STORE_KEY, { version: 1, jobs: next }); records = next; };
  const update = (id, action) => {
    const next = copy(records), job = next.find(item => item.id === id);
    if (!job) return undefined;
    action(job); job.updatedAt = stamp(now()); write(next); return copy(job);
  };
  if (initial && JSON.stringify(initial.jobs) !== JSON.stringify(records)) write(copy(records));
  const ensureOpen = () => { if (closed) throw fail('后台任务服务正在退出。', 'BILIBILI_DIGEST_CLOSED', 409); };
  const logIssue = (job, cause) => {
    try { log(`Bilibili 任务 ${job.id} 未完成：${cause?.message || '未知错误'}`, 'warn'); } catch {}
  };
  const check = async (job, run, phase) => {
    if (closed || generation !== run.generation || run.controller.signal.aborted || current(job.id)?.state !== 'running') throw fail('后台任务已取消或配置已变化。', 'BILIBILI_DIGEST_CANCELLED', 409);
    if (!localWindow(now(), job.request.schedule).allowed) {
      run.reason = 'window_end'; run.controller.abort();
      throw fail('本次运行时段已结束。', 'BILIBILI_DIGEST_WINDOW_ENDED', 409);
    }
    const allowed = await interruptible(() => authorize(copy(current(job.id)), { phase, signal: run.controller.signal, config: getConfig() }), run.controller.signal);
    if (allowed === false || allowed?.allowed === false) throw fail('后台任务的账号或范围授权已失效。', 'BILIBILI_DIGEST_NOT_AUTHORIZED', 409);
    if (!localWindow(now(), job.request.schedule).allowed) {
      run.reason = 'window_end'; run.controller.abort();
      throw fail('本次运行时段已结束。', 'BILIBILI_DIGEST_WINDOW_ENDED', 409);
    }
    if (closed || generation !== run.generation || run.controller.signal.aborted || current(job.id)?.state !== 'running') throw fail('后台任务已取消或配置已变化。', 'BILIBILI_DIGEST_CANCELLED', 409);
  };
  const wake = () => {
    if (!started || closed || kick) return;
    kick = setImmediate(() => { kick = undefined; void service.tick().catch(() => {}); });
    kick.unref?.();
  };

  async function notifyFailure(job, run, cause) {
    const value = current(job.id);
    if (!value || !['failed', 'blocked'].includes(value.state) || value.failureNotification
      || cause?.retryable === true || run.reason || closed || generation !== run.generation || run.controller.signal.aborted
      || ['attempted', 'sent', 'unknown', 'failed'].includes(value.result?.delivery?.state)
      || !localWindow(now(), value.request.schedule).allowed) return;
    try {
      const allowed = await interruptible(() => authorize(copy(current(job.id)), {
        phase: 'before_failure_notification', signal: run.controller.signal, config: getConfig(),
      }), run.controller.signal);
      if (allowed === false || allowed?.allowed === false || closed || generation !== run.generation || run.controller.signal.aborted
        || !['failed', 'blocked'].includes(current(job.id)?.state) || !localWindow(now(), value.request.schedule).allowed) return;
      update(job.id, item => { item.failureNotification = { state: 'attempted', attemptedAt: stamp(now()) }; });
      const text = `Bilibili 后台任务未能完成，已停止后续调用。请核对 Bilibili 登录、内容访问权限和模型配置，再通过聊天查询或重新发起。\n任务编号：${job.id}${value.result?.items?.length ? '\n已完成的部分摘要已保存在本地，可通过任务状态查询。' : ''}`;
      await interruptible(() => deliver(copy(current(job.id)), { signal: run.controller.signal, text }), run.controller.signal);
      update(job.id, item => { item.failureNotification = { ...item.failureNotification, state: 'sent', sentAt: stamp(now()) }; });
    } catch (notificationError) {
      if (current(job.id)?.failureNotification?.state === 'attempted') update(job.id, item => { item.failureNotification.state = 'unknown'; });
      try { log(`Bilibili 任务 ${job.id} 的固定失败回执未能确认送达。`, 'warn'); } catch {}
    }
  }

  async function execute(job, windowKey) {
    const controller = new AbortController(), run = { id: job.id, controller, generation, reason: '', modelAttempted: false,
      claimed: false, previousWindowKey: job.lastWindowKey || null };
    active = run;
    const timeout = setTimeout(() => { run.reason = 'timeout'; controller.abort(); }, runTimeoutMs); timeout.unref?.();
    const windowWatch = setInterval(() => {
      if (!localWindow(now(), job.request.schedule).allowed && !controller.signal.aborted) { run.reason = 'window_end'; controller.abort(); }
    }, 1000); windowWatch.unref?.();
    try {
      // The connection may still be coming up after app startup. Authorize
      // before claiming this day's receipt, so a transient wait loses no day.
      const allowed = await interruptible(() => authorize(copy(job), { phase: 'before_start', signal: controller.signal, config: getConfig() }), controller.signal);
      if (allowed === false || allowed?.allowed === false) throw fail('后台任务授权已失效。', 'BILIBILI_DIGEST_NOT_AUTHORIZED', 409);
      if (closed || controller.signal.aborted || generation !== run.generation || current(job.id)?.state === 'cancelled') throw fail('后台任务已取消。', 'BILIBILI_DIGEST_CANCELLED', 409);
      if (!localWindow(now(), job.request.schedule).allowed) { run.reason = 'window_end'; throw fail('本次运行时段已结束。', 'BILIBILI_DIGEST_WINDOW_ENDED', 409); }
      const previous = current(job.id);
      const carry = job.request.schedule.mode === 'once' && previous.result?.delivery?.state === 'not_attempted' ? previous.result.items || [] : [];
      update(job.id, value => {
        value.state = 'running'; value.reason = ''; value.retryAt = null; value.error = null; value.lastWindowKey = windowKey;
        value.lastRunAt = stamp(now()); value.runsStarted = (value.runsStarted || 0) + 1;
        value.effectiveTimeFilter = value.request.timeFilter.lookbackDays
          ? { basis: value.request.timeFilter.basis, from: stamp(now() - value.request.timeFilter.lookbackDays * 86_400_000), until: stamp(now()) }
          : { ...value.request.timeFilter };
        value.result = { completedAt: null, text: '', items: carry.slice(0, job.request.maxItems), skipped: [], scan: {}, delivery: { state: 'not_attempted' } };
      });
      run.claimed = true;
      await check(job, run, 'before_read');
      const library = await interruptible(() => readLibrary(copy(current(job.id)), { signal: controller.signal,
        processedItemIds: [...current(job.id).completedItemIds], authorize: () => check(job, run, 'reading') }), controller.signal);
      await check(job, run, 'after_read');
      if (!object(library) || !Array.isArray(library.items) || library.items.length > 100) throw fail('内容读取返回格式无效或超出上限。', 'BILIBILI_DIGEST_SOURCE_INVALID');
      update(job.id, value => { value.result.skipped = skippedOf(library.skipped); value.result.scan = scanOf(library.scan); });
      const seen = new Set(current(job.id).completedItemIds), candidates = [];
      for (const item of library.items) {
        const id = item?.item?.id;
        if (typeof id !== 'string' || seen.has(id)) continue;
        // Validate source identity before paying for inference, without keeping
        // its full text in persistent jobs or exposing it in status output.
        evidenceOf(item, '来源校验'); seen.add(id); candidates.push(item);
        if (candidates.length >= job.request.maxItems - current(job.id).result.items.length) break;
      }
      for (const item of candidates) {
        if (current(job.id).result.items.length >= job.request.maxItems) break;
        await check(job, run, 'before_summary');
        run.modelAttempted = true;
        const summarized = await interruptible(() => summarize(copy(item), { job: copy(current(job.id)), signal: controller.signal }), controller.signal);
        await check(job, run, 'after_summary');
        const evidence = evidenceOf(item, summarized);
        update(job.id, value => {
          value.result.items.push(evidence);
          value.completedItemIds = [...new Set([...value.completedItemIds, evidence.id])].slice(-MAX_SEEN);
        });
      }
      await check(job, run, 'before_result');
      update(job.id, value => {
        value.result.completedAt = stamp(now()); value.result.text = digestText(value, value.result);
      });
      if (job.request.schedule.mode === 'daily' && !current(job.id).result.items.length) {
        update(job.id, value => { value.result.delivery = { state: 'skipped', reason: '本次没有新增内容，不重复推送。' }; });
      } else {
        await check(job, run, 'before_delivery');
        // Commit before the send. A process crash or missing acknowledgement
        // must not replay an already accepted QQ message after restart.
        update(job.id, value => { value.result.delivery = { state: 'attempted', attemptedAt: stamp(now()) }; });
        try {
          const result = await interruptible(() => deliver(copy(current(job.id)), { signal: controller.signal }), controller.signal);
          await check(job, run, 'after_delivery');
          update(job.id, value => { value.result.delivery = { ...value.result.delivery, state: 'sent', sentAt: stamp(now()),
            ...(typeof result?.messageId === 'string' ? { messageId: clip(result.messageId, 300) } : {}) }; });
        } catch (cause) {
          const delivered = current(job.id)?.result?.delivery;
          if (delivered?.state === 'attempted') update(job.id, value => { value.result.delivery.state = cause?.deliveryUncertain === false ? 'failed' : 'unknown'; });
          throw cause;
        }
      }
      update(job.id, value => {
        value.state = value.request.schedule.mode === 'daily' ? 'scheduled' : 'completed';
        value.reason = value.result.delivery.state === 'sent' ? '总结已返回原聊天。' : '本次任务已完成，结果保存在本地。';
      });
    } catch (cause) {
      const value = current(job.id);
      if (value && value.state !== 'cancelled') update(job.id, record => {
        if (record.result?.delivery?.state === 'attempted') record.result.delivery.state = 'unknown';
        const sentUncertain = ['unknown', 'failed'].includes(record.result?.delivery?.state);
        if (sentUncertain) {
          record.state = record.request.schedule.mode === 'daily' ? 'scheduled' : 'delivery_unknown';
          record.reason = '总结已保存，但投递结果无法确认；不会自动重发，请查询任务状态。';
        } else if (run.reason === 'close') {
          record.state = record.request.schedule.mode === 'daily' ? 'scheduled' : 'queued';
          record.reason = '应用已退出；下次启动后按原窗口继续，不重复投递。';
        } else if (run.reason === 'window_end' || cause?.code === 'BILIBILI_JOB_WINDOW_CLOSED') {
          record.state = record.request.schedule.mode === 'daily' ? 'scheduled' : 'queued';
          record.reason = '运行时段已结束，后续读取、模型调用和投递已暂停；下一运行窗口继续。';
          if (!run.claimed || !run.modelAttempted) record.lastWindowKey = run.previousWindowKey;
        } else if (run.reason === 'reload') {
          record.state = 'blocked'; record.reason = '配置或权限已变化，已停止旧任务；请在聊天中重新发起。';
        } else if (cause?.retryable === true && (!run.claimed || !run.modelAttempted)) {
          record.state = 'paused'; record.reason = '连接尚未准备好，等待连接恢复。'; record.retryAt = stamp(now() + RETRY_MS);
          record.lastWindowKey = run.previousWindowKey;
        } else {
          record.state = cause?.code === 'BILIBILI_DIGEST_SUMMARY_INVALID' || run.reason === 'timeout' ? 'failed' : 'blocked';
          record.reason = run.reason === 'timeout' ? '后台任务达到运行时限，已停止后续读取、模型调用与投递。'
            : run.modelAttempted ? '模型总结或运行授权未能确认，已停止后续调用；请查询已保存结果并重新发起。' : '后台任务的连接、来源或授权不可用；请核对后重新发起。';
        }
        record.error = { code: typeof cause?.code === 'string' && /^[A-Z0-9_]{1,80}$/u.test(cause.code) ? cause.code : 'BILIBILI_DIGEST_FAILED', message: record.reason };
        if (record.result && !record.result.text && record.result.items.length) record.result.text = digestText(record, record.result);
      });
      await notifyFailure(job, run, cause);
      logIssue(job, cause);
    } finally {
      clearTimeout(timeout); clearInterval(windowWatch); if (active === run) active = undefined;
    }
  }

  function publicJob(job, detailed = false) {
    const value = { jobId: job.id, status: job.state, createdAt: job.createdAt, updatedAt: job.updatedAt,
      schedule: copy(job.request.schedule), focus: clip(job.request.focus, detailed ? 1000 : 160), completedItems: job.completedItemIds.length,
      runsStarted: job.runsStarted || 0, lastRunAt: job.lastRunAt || null, retryAt: job.retryAt || null, reason: clip(job.reason, 400),
      ...(job.error ? { error: copy(job.error) } : {}) };
    if (job.failureNotification) value.failureNotification = copy(job.failureNotification);
    if (detailed) {
      value.request = copy(job.request);
      if (job.effectiveTimeFilter) value.effectiveTimeFilter = copy(job.effectiveTimeFilter);
      if (job.result) value.result = { completedAt: job.result.completedAt, text: clip(job.result.text, 6000),
        delivery: copy(job.result.delivery), scan: copy(job.result.scan), skipped: copy(job.result.skipped),
        evidence: job.result.items.map(item => ({ id: item.id, title: clip(item.title, 80), url: item.url,
          sourceKind: item.sourceKind, complete: item.complete, coverage: clip(item.coverage, 100),
          evidence: copy((item.evidence || []).slice(0, 2)) })) };
      while (Buffer.byteLength(JSON.stringify(value)) > MAX_PUBLIC_BYTES - 32 && value.result?.text) {
        value.result.text = value.result.text.slice(0, Math.max(0, value.result.text.length - 500)); value.truncated = true;
      }
      while (Buffer.byteLength(JSON.stringify(value)) > MAX_PUBLIC_BYTES - 32 && value.result?.evidence.length) {
        value.result.evidence.pop(); value.truncated = true;
      }
      if (job.result?.text.length > (value.result?.text?.length || 0)) value.truncated = true;
    }
    return value;
  }
  const service = {
    async queue(input, { origin, binding, signal } = {}) {
      ensureOpen();
      const queueGeneration = generation;
      if (signal?.aborted) throw fail('聊天请求已取消，未创建后台任务。', 'BILIBILI_DIGEST_CANCELLED', 409);
      const request = normalizeBilibiliDigestRequest(input), owner = originOf(origin), bound = bindingOf(binding);
      const requestKey = owner.messageId ? hash({ owner, request, binding: bound }) : '';
      const duplicate = requestKey && records.find(job => job.requestKey === requestKey);
      if (duplicate) return { jobId: duplicate.id, status: duplicate.state, duplicate: true, ...copy(duplicate.request), message: '这条聊天请求已创建任务，不会重复排队。' };
      if (records.filter(job => activeStates.has(job.state)).length >= MAX_ACTIVE) throw fail('此账号已有20个未结束任务，请先取消或完成部分任务。', 'BILIBILI_DIGEST_LIMIT', 409);
      const time = now(), job = { id: randomUUID(), request, origin: owner, binding: bound, requestKey,
        state: request.schedule.mode === 'daily' ? 'scheduled' : 'queued', createdAt: stamp(time), updatedAt: stamp(time),
        completedItemIds: [], lastWindowKey: null, runsStarted: 0, result: null, reason: '', retryAt: null, error: null };
      const allowed = await authorize(copy(job), { phase: 'queue', signal, config: getConfig() });
      ensureOpen();
      if (signal?.aborted || generation !== queueGeneration || allowed === false || allowed?.allowed === false) throw fail('请求已取消或后台任务范围没有获得授权。', 'BILIBILI_DIGEST_NOT_AUTHORIZED', 409);
      const racedDuplicate = requestKey && records.find(item => item.requestKey === requestKey);
      if (racedDuplicate) return { jobId: racedDuplicate.id, status: racedDuplicate.state, duplicate: true,
        ...copy(racedDuplicate.request), message: '这条聊天请求已创建任务，不会重复排队。' };
      if (records.filter(item => activeStates.has(item.state)).length >= MAX_ACTIVE) throw fail('此账号已有20个未结束任务，请先取消或完成部分任务。', 'BILIBILI_DIGEST_LIMIT', 409);
      const next = [...copy(records), job];
      while (next.length > MAX_JOBS) {
        const index = next.findIndex(item => !activeStates.has(item.state));
        if (index < 0) throw fail('后台任务记录达到上限。', 'BILIBILI_DIGEST_LIMIT', 409);
        next.splice(index, 1);
      }
      write(next); wake();
      return { jobId: job.id, status: job.state, ...copy(request),
        message: `已创建${request.schedule.mode === 'daily' ? '每日' : '一次性'}后台浏览总结任务，每次最多处理${request.maxItems}项；结果返回当前聊天。` };
    },
    status({ jobId, origin } = {}) {
      ensureOpen(); const owner = originOf(origin);
      if (jobId !== undefined) {
        const job = current(jobId);
        if (!job || !sameOrigin(job.origin, owner)) throw fail('此聊天中没有你创建的该任务。', 'BILIBILI_DIGEST_NOT_FOUND', 404);
        return { job: publicJob(job, true) };
      }
      const visible = records.filter(job => sameOrigin(job.origin, owner));
      const output = { jobs: visible.slice(-10).reverse().map(job => publicJob(job)), total: visible.length };
      while (Buffer.byteLength(JSON.stringify(output)) > MAX_PUBLIC_BYTES && output.jobs.length) { output.jobs.pop(); output.truncated = true; }
      return output;
    },
    cancel({ jobId, origin } = {}) {
      ensureOpen(); const owner = originOf(origin), job = current(jobId);
      if (!job || !sameOrigin(job.origin, owner)) throw fail('此聊天中没有你创建的该任务。', 'BILIBILI_DIGEST_NOT_FOUND', 404);
      if (active?.id === jobId) { active.reason = 'cancel'; active.controller.abort(); }
      update(jobId, value => { value.state = 'cancelled'; value.reason = '任务已由创建人取消，后续读取、模型调用和投递已停止。';
        if (value.result?.delivery?.state === 'attempted') value.result.delivery.state = 'unknown'; });
      return { jobId, status: 'cancelled', message: '已取消后台任务。已经提交的消息不能撤销，不会自动重发。' };
    },
    jobs: () => copy(records),
    async tick(time = now()) {
      if (!started || closed) return;
      if (draining) return draining;
      const work = (async () => {
        // One pass chooses one run, preventing a burst of accumulated daily jobs.
        const due = records.find(job => {
          if (!['queued', 'scheduled', 'paused'].includes(job.state) || job.retryAt && Date.parse(job.retryAt) > time) return false;
          const window = localWindow(time, job.request.schedule);
          return window.allowed && (job.request.schedule.mode !== 'daily' || job.lastWindowKey !== window.key);
        });
        if (due) await execute(copy(due), localWindow(time, due.request.schedule).key);
      })();
      draining = work;
      try { await work; } finally { if (draining === work) draining = undefined; }
    },
    start() {
      ensureOpen(); if (started) return;
      started = true; timer = setInterval(() => { void service.tick().catch(() => {}); }, intervalMs); timer.unref?.(); wake();
    },
    async reload() {
      ensureOpen(); generation++;
      if (active) { active.reason = 'reload'; active.controller.abort(); }
      if (draining) await draining;
      wake();
    },
    async ready() { if (draining) await draining; },
    async close() {
      if (closed) return;
      closed = true; started = false; generation++; clearInterval(timer); clearImmediate(kick); kick = undefined;
      if (active) { active.reason = 'close'; active.controller.abort(); }
      if (draining) await draining;
    },
  };
  return service;
}
