import { randomUUID } from 'node:crypto';
import { createStore } from './store.mjs';
import { validateConfig } from './config.mjs';
import { createInstaller } from './installer.mjs';
import { createRuntime } from './runtime.mjs';

const fail = (message, statusCode = 409, details) => Object.assign(new Error(message), { statusCode, ...(details ? { details } : {}) });

export function createAccountService({ account, dataDir, csrfToken, installerFactory = createInstaller, runtimeFactory = createRuntime, redactAll = value => String(value), checkConflicts = () => {}, reserveConfig = () => () => {} }) {
  const store = createStore(dataDir);
  const logs = [], jobs = [];
  let environment = null, activeJob = null, applying = false, started = false, closed = false;
  let codexAuth = { loggedIn: null, message: '尚未检查该账号的官方 CLI 登录状态' };
  let applyFinished = Promise.resolve();
  const ensureOpen = () => { if (closed) throw fail('账号后台正在退出，操作已取消。'); };
  const redact = value => {
    let text = String(value ?? '').replace(/\x1b\[[0-9;]*m/g, '');
    for (const secret of Object.values(store.getSecretSnapshot())) if (secret) text = text.split(secret).join('[已隐藏]');
    return redactAll(text).replace(/(Bearer\s+)[^\s"']+/gi, '$1[已隐藏]')
      .replace(/((?:access_token|refresh_token|api_key|apiKey|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',}\]]+/gi, '$1[已隐藏]')
      .replace(/\bsk-[\w-]{10,}\b/g, '[已隐藏]').slice(0, 4000);
  };
  const log = (message, level = 'info') => {
    logs.push({ id: randomUUID(), accountId: account.id, time: new Date().toISOString(), level, message: redact(message) });
    if (logs.length > 200) logs.shift();
  };
  const safeDetails = value => typeof value === 'string' ? redact(value) : Array.isArray(value) ? value.map(safeDetails) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeDetails(item)])) : value;
  const installer = installerFactory({ dataDir, platform: account.platform, profileId: account.id, accountId: account.id, legacy: account.id === 'legacy', getConfig: store.getConfig, getSecret: store.getSecret, setSecret: store.setSecret, log });
  const runtime = runtimeFactory({ platform: account.platform, profileId: account.id, accountId: account.id, getConfig: store.getConfig, getSecret: store.getSecret, store, installer, log });
  const summary = () => {
    const config = store.getState();
    return { ...account, qqNumber: config.draft.botQQ, runtime: runtime.status(), permissions: config.applied.permissions, pendingChanges: store.pendingChanges(), enabled: config.applied.qq.enabled };
  };
  const state = async () => {
    let modules;
    try { modules = await installer.status(); } catch (error) { modules = [{ id: 'napcat', name: 'NapCat', state: 'error', description: redact(error.message) }]; }
    return { csrfToken, account: summary(), ...store.getState(), pendingChanges: store.pendingChanges(), secrets: { deepseekApiKey: store.hasDraftSecret('deepseekApiKey'), napcatToken: store.hasDraftSecret('napcatToken') }, secretsPendingChanges: store.secretsPending(), codexAuth: safeDetails(codexAuth), runtime: runtime.status(), modules, jobs: safeDetails(jobs.slice(-20)), logs: safeDetails(logs.slice(-100)), summaries: store.getSummaries(), favorites: store.getFavorites(), environment, metrics: store.metrics(), dataDir };
  };
  const job = (label, action) => {
    ensureOpen();
    if (applying || activeJob) throw fail('该账号已有配置、安装或授权任务正在执行，请等待它结束。');
    const item = { id: randomUUID(), accountId: account.id, label, status: 'running', startedAt: new Date().toISOString(), logs: [] };
    jobs.push(item); if (jobs.length > 30) jobs.shift(); activeJob = item;
    const onLog = line => { item.logs.push(redact(line)); if (item.logs.length > 150) item.logs.shift(); };
    Promise.resolve().then(() => action(onLog)).then(result => {
      item.status = 'completed'; item.result = safeDetails(result ?? null); log(`${label}完成`);
    }).catch(error => {
      item.status = 'failed'; item.error = redact(error.message); if (error.details) item.details = safeDetails(error.details); log(`${label}失败：${error.message}`, 'error');
    }).finally(() => { item.finishedAt = new Date().toISOString(); activeJob = null; });
    return { job: item };
  };
  const ensureIdle = () => { ensureOpen(); if (applying || activeJob) throw fail('该账号的配置或模块任务正在执行，请稍后重试。'); };
  const apply = async (mode = 'apply', revision) => {
    ensureIdle();
    if (mode !== 'rollback' && revision !== store.getState().revision) throw fail('草稿版本已变化，请刷新后重试。');
    applying = true;
    let finishApply;
    applyFinished = new Promise(resolve => { finishApply = resolve; });
    const before = store.getState(), oldSecrets = store.getSecretSnapshot();
    let touchedNapcat = false;
    let releaseReservation = () => {};
    try {
      if (mode === 'rollback') store.rollback();
      const current = store.getState();
      const candidate = structuredClone(current.draft);
      candidate.permissions ||= { released: false, privateReplies: false };
      candidate.permissions.released = mode === 'release';
      const config = validateConfig(candidate, { applying: true, hasSecret: store.hasDraftSecret });
      checkConflicts(config, account.id);
      if (mode === 'release' && (!config.qq.enabled || (!config.groups.some(group => group.read) && !config.permissions.privateReplies))) throw fail('请先启用 QQ 连接，并在群权限中选择读取范围或本人私聊权限。');
      releaseReservation = reserveConfig(config, before.applied, account.id);
      // Ordinary application and rollback always return to read-only. Only this
      // explicit account-bound release transaction can authorize sending.
      store.restoreState({ ...current, draft: config });
      store.commitSecrets(); store.commitDraft();
      if (oldSecrets.napcatToken !== store.getSecret('napcatToken') || before.applied.qq.wsUrl !== config.qq.wsUrl || before.applied.qq.webUiUrl !== config.qq.webUiUrl || before.applied.botQQ !== config.botQQ) {
        const modules = await installer.status();
        ensureOpen();
        if (modules.some(module => module.id === 'napcat' && module.state === 'running')) { touchedNapcat = true; await installer.startNapcat(line => log(line)); }
      }
      ensureOpen();
      await runtime.reload();
      ensureOpen();
      if (mode === 'release') {
        if (typeof runtime.connect === 'function') await runtime.connect();
        ensureOpen();
        const actual = runtime.status();
        if (!actual.connected || String(actual.accountId || '') !== config.botQQ) throw fail('QQ 实际登录身份尚未确认或与接入 QQ 号不一致，权限未释放。');
      }
      log(mode === 'release' ? '已核对账号并释放本账号选定范围的权限。' : mode === 'rollback' ? '已恢复上一份参数，账号保持只读；发送需重新授权。' : `配置版本 ${store.getState().appliedRevision} 已应用，账号保持只读；请在群权限中显式授权。`);
    } catch (error) {
      store.restoreState(before); store.restoreSecrets(oldSecrets);
      if (touchedNapcat && !closed) {
        try { await installer.startNapcat(line => log(line)); } catch (restoreError) { log(`NapCat 配置恢复失败：${restoreError.message}`, 'error'); }
      }
      if (!closed) {
        try { await runtime.reload(); } catch (restoreError) { log(`账号运行时恢复失败：${restoreError.message}`, 'error'); }
      }
      throw error;
    } finally { applying = false; releaseReservation(); finishApply(); }
  };
  const revoke = async () => {
    ensureOpen();
    if (applying) throw fail('配置正在应用，请稍后撤销权限。');
    const current = store.getState();
    for (const field of ['draft', 'applied', 'previous']) if (current[field]) current[field].permissions = { ...current[field].permissions, released: false };
    current.revision += 1; current.appliedRevision = current.revision;
    store.restoreState(current);
    await runtime.reload(); log('已立即撤销该账号发送权限，旧任务已取消。');
    return state();
  };
  const save = async body => {
    ensureOpen();
    if (applying) throw fail('配置正在应用，请稍后保存。');
    const config = validateConfig(body.config);
    config.permissions.released = false;
    const updates = body.secretUpdates || {};
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) throw fail('凭据更新格式无效。', 400);
    for (const [name, value] of Object.entries(updates)) {
      if (!['deepseekApiKey', 'napcatToken'].includes(name) || typeof value !== 'string' || value.length > 2000 || /[\r\n]/.test(value)) throw fail('凭据字段无效。', 400);
    }
    store.stageSecrets(updates); store.saveDraft(config);
    log('参数草稿已保存；应用后只读，发送需单独释放权限。');
    return state();
  };
  const invoke = async (route, body) => {
    ensureOpen();
    if (route === '/config/save') return { value: await save(body) };
    if (route === '/config/apply') { await apply('apply', body.revision); return { value: await state() }; }
    if (route === '/config/rollback') { await apply('rollback'); return { value: await state() }; }
    if (route === '/permissions/release') { await apply('release', body.revision); return { value: await state() }; }
    if (route === '/permissions/revoke') return { value: await revoke() };
    if (route === '/environment/check') { environment = await installer.environment(); return { value: await state() }; }
    if (route === '/setup/install') {
      const ids = body.modules || ['napcat', 'codex'];
      if (!Array.isArray(ids) || !ids.length || ids.some(id => !['napcat', 'codex'].includes(id))) throw fail('安装模块列表无效。', 400);
      return { code: 202, value: job('安装所选模块', async onLog => {
        for (const id of [...new Set(ids)]) { onLog(`开始安装 ${id}`); await installer.install(id, onLog); if (id === 'napcat') await installer.startNapcat(onLog); }
        environment = await installer.environment();
      }) };
    }
    const installMatch = route.match(/^\/modules\/(napcat|codex|deepseek|summary|favorites)\/install$/);
    if (installMatch) return { code: 202, value: job(`安装 ${installMatch[1]}`, async onLog => {
      const result = await installer.install(installMatch[1], onLog);
      if (installMatch[1] === 'napcat') await installer.startNapcat(onLog);
      return result;
    }) };
    if (route === '/modules/napcat/start') return { code: 202, value: job('启动 NapCat', installer.startNapcat) };
    if (route === '/modules/napcat/stop') return { code: 202, value: job('停止 NapCat', installer.stopNapcat) };
    if (route === '/codex/login') return { code: 202, value: job('本账号 GPT 官方设备授权', async onLog => { codexAuth = await installer.loginCodex(onLog); return codexAuth; }) };
    if (route === '/codex/status') { codexAuth = await installer.codexStatus(); return { value: safeDetails(codexAuth) }; }
    if (route === '/runtime/connect') { checkConflicts(store.getConfig(), account.id); await runtime.connect(); return { value: await state() }; }
    if (route === '/test/deepseek') return { value: await runtime.testDeepSeek() };
    if (route === '/summary/run') {
      if (typeof body.groupId !== 'string') throw fail('请指定工作群号。', 400);
      return { value: await runtime.runSummary(body.groupId, { source: 'dashboard' }) };
    }
    if (route === '/favorites/sync') return { value: await runtime.syncFavorites() };
    if (route === '/favorites/summarize') return { value: await runtime.runFavoritesSummary({ source: 'dashboard' }) };
    if (route === '/policy/preview') return { value: runtime.preview(body) };
    throw fail('接口不存在。', 404);
  };
  return {
    account, store, runtime, installer, summary, state, invoke, redact,
    async start() {
      if (started) return;
      started = true;
      Promise.resolve().then(() => installer.environment()).then(result => { environment = result; }).catch(error => log(`环境检查失败：${error.message}`, 'error'));
      await runtime.reload();
    },
    async close() {
      if (closed) return;
      closed = true;
      const results = await Promise.allSettled([runtime.stop(), installer.dispose?.()]);
      await applyFinished;
      store.close();
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    },
  };
}
