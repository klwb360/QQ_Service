import { randomUUID } from 'node:crypto';
import { createStore } from './store.mjs';
import { DEFAULT_CONFIG, validateConfig, getModelConfig, isCredentialName, apiSecretName, isApiProviderId } from './config.mjs';
import { createInstaller } from './installer.mjs';
import { createRuntime } from './runtime.mjs';

const fail = (message, statusCode = 409, details) => Object.assign(new Error(message), { statusCode, ...(details ? { details } : {}) });

export function createAccountService({ account, dataDir, csrfToken, installerFactory = createInstaller, runtimeFactory = createRuntime, getNapcatSettings = () => ({ mode: 'docker', executablePath: '', revision: 0 }), redactAll = value => String(value), checkConflicts = () => {}, reserveConfig = () => () => {} }) {
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
  const installer = installerFactory({ dataDir, platform: account.platform, profileId: account.id, accountId: account.id, legacy: account.id === 'legacy', getConfig: store.getConfig, getNapcatSettings, getSecret: store.getSecret, setSecret: store.setSecret, log });
  const runtime = runtimeFactory({ platform: account.platform, profileId: account.id, accountId: account.id, getConfig: store.getConfig, getSecret: store.getSecret, store, installer, log });
  const summary = () => {
    const config = store.getState();
    return { ...account, qqNumber: config.draft.botQQ, appliedQQ: config.applied.botQQ, runtime: safeDetails(runtime.status()), permissions: config.applied.permissions, pendingChanges: store.pendingChanges(), enabled: config.applied.qq.enabled };
  };
  const state = async () => {
    let modules;
    try { modules = await installer.status(); } catch (error) { modules = [{ id: 'napcat', name: 'NapCat', state: 'error', description: redact(error.message) }]; }
    const draft = store.getState().draft;
    const secrets = Object.fromEntries(['deepseekApiKey', 'napcatToken', ...(draft.models.apis || []).map(model => apiSecretName(model.id))].map(name => [name, store.hasDraftSecret(name)]));
    return { csrfToken, account: summary(), ...store.getState(), pendingChanges: store.pendingChanges(), secrets, secretsPendingChanges: store.secretsPending(), codexAuth: safeDetails(codexAuth), runtime: safeDetails(runtime.status()), setup: setupStatus(), modules, jobs: safeDetails(jobs.slice(-20)), logs: safeDetails(logs.slice(-100)), summaries: store.getSummaries(), favorites: store.getFavorites(), environment, metrics: store.metrics(), dataDir };
  };
  const setupStatus = () => {
    const { draft, applied } = store.getState();
    const actual = runtime.status();
    const secretSnapshot = store.getSecretSnapshot();
    const napcatTokenPending = Object.hasOwn(secretSnapshot, 'draft:napcatToken') && secretSnapshot['draft:napcatToken'] !== secretSnapshot.napcatToken;
    const verified = Boolean(actual.connected && actual.accountId && String(actual.accountId) === draft.botQQ && draft.qq.enabled && applied.qq.enabled && applied.botQQ === draft.botQQ && draft.qq.wsUrl === applied.qq.wsUrl && !napcatTokenPending);
    const providers = ['deepseek', 'codex', ...(draft.models.apis || []).map(model => model.id)].map(id => {
      const model = getModelConfig(draft, id);
      const credentialReady = id === 'codex' ? codexAuth.loggedIn === true : store.hasDraftSecret(id === 'deepseek' ? 'deepseekApiKey' : apiSecretName(id));
      return { id, label: id === 'deepseek' ? 'DeepSeek' : id === 'codex' ? 'ChatGPT 订阅 / Codex' : model.label, enabled: Boolean(model.enabled), credentialReady, configured: Boolean(credentialReady && (!isApiProviderId(id) || model.model)), tested: Boolean(credentialReady && actual.modelTests?.[id]?.tested && JSON.stringify(model) === JSON.stringify(getModelConfig(applied, id)) && !store.secretsPending()), testedAt: actual.modelTests?.[id]?.testedAt || null, status: actual.modelTests?.[id]?.status || 'untested', message: actual.modelTests?.[id]?.message || '' };
    });
    const selected = providers.filter(provider => provider.enabled);
    const modelsReady = selected.length > 0 && selected.every(provider => provider.configured);
    const scenariosReady = ['chat', 'summary', 'favorites'].some(name => draft[name]?.enabled);
    const hasTargets = draft.groups.some(group => group.read) || draft.permissions.privateReplies;
    const released = applied.permissions.released;
    const groupTestNeeded = actual.permissions?.writableGroups?.length > 0;
    const blockers = [];
    const add = (code, message, field, action, nextStep) => blockers.push({ code, message, field, action, nextStep });
    if (!draft.botQQ) add('QQ_NUMBER_MISSING', '请填写要接入的 QQ 号。', 'botQQ', '这个 QQ 号应与 NapCat 稍后扫码登录的账号一致。', 'identity');
    if (!selected.length) add('MODEL_NOT_SELECTED', '尚未选择 AI 模型。', 'models', '从模型来源下拉栏选择一个 API 厂商或 ChatGPT 订阅。', 'models');
    for (const provider of selected.filter(provider => !provider.credentialReady)) add(provider.id === 'codex' ? 'CODEX_LOGIN_REQUIRED' : 'MODEL_KEY_MISSING', provider.id === 'codex' ? '请登录或检查此账号的 Codex 授权。' : `${provider.label} 尚未配置 API Key。`, provider.id === 'codex' ? 'models.codex' : isApiProviderId(provider.id) ? `models.apis.${provider.id}` : 'models.deepseek', provider.id === 'codex' ? '点击官方设备登录；已有登录时点击检查状态。' : '填写对应服务商的 API Key，然后保存。', 'models');
    for (const provider of selected.filter(provider => isApiProviderId(provider.id) && !getModelConfig(draft, provider.id).model)) add('MODEL_NAME_MISSING', `${provider.label} 尚未填写模型名称。`, `models.apis.${provider.id}.model`, '填写服务商提供的模型 ID；API Key 并不能代替模型名称。', 'models');
    if (!draft.qq.enabled) add('QQ_DISABLED', '尚未启用本账号的 QQ 连接。', 'qq.enabled', '先准备 NapCat 并扫码登录，再保存并应用为只读。', 'connection');
    else if (!store.hasDraftSecret('napcatToken')) add('NAPCAT_TOKEN_MISSING', '尚未配置 OneBot Token。', 'secrets.napcatToken', '复制 NapCat 正向 WebSocket 的 Token，不能使用 WebUI 登录密码。', 'connection');
    else if (!verified) blockers.push(actual.issue || { code: 'QQ_NOT_CONNECTED', message: '尚未验证实际 QQ 登录账号。', field: 'qq.wsUrl', action: '启动 NapCat 并登录此 QQ，然后保存应用并测试连接。', nextStep: 'connection' });
    if (!scenariosReady) add('SCENARIO_NOT_SELECTED', '请选择这个账号需要执行的任务。', 'chat', '开启聊天、通知汇总或收藏整理，并选择使用的模型。', 'scenarios');
    if (!hasTargets) add('PERMISSION_TARGET_MISSING', '尚未选择群或私聊范围。', 'groups', '读取已加入群，勾选读取与发送范围；仅本地汇总时无需私聊接收 QQ。', 'permissions');
    if (draft.ownerQQ && draft.ownerQQ === draft.botQQ && (draft.permissions.privateReplies || (draft.summary.enabled && draft.summary.sendToOwner))) add('PRIVATE_RECIPIENT_SAME', '私聊接收 QQ 不能与接入 QQ 相同。', 'ownerQQ', '仅群聊或本地整理时关闭私聊回复和私聊投递；需要私聊时填写另一个 QQ。', 'permissions');
    const steps = [
      { id: 'identity', title: '创建账号', complete: Boolean(draft.botQQ), description: '填写要接入的 QQ 号，与 NapCat 登录账号保持一致。' },
      { id: 'models', title: '配置 AI', complete: modelsReady, description: modelsReady ? '凭据已配置；可主动测试真实调用，测试可能消耗费用或订阅额度。' : '选择一个模型来源，配置 API Key 或官方订阅登录。' },
      { id: 'connection', title: '连接 QQ', complete: verified, description: verified ? `NapCat 实际登录 QQ ${actual.accountId}，已核对身份。` : '先在 NapCat 登录 QQ，再验证本机 OneBot 连接；AI 登录不能代替 QQ 登录。' },
      { id: 'scenarios', title: '选择任务', complete: scenariosReady, description: '选择当前账号需要执行的聊天、通知汇总或收藏整理任务。' },
      { id: 'permissions', title: '授权并启动', complete: Boolean(released && hasTargets && !store.pendingChanges()), description: released ? '已释放当前已应用参数的权限；修改后应用会恢复只读。' : '选择群和消息范围后，明确点击启动；保存或测试连接不会授权发送。' },
      { id: 'verification', title: '验证效果', complete: Boolean(released && (!groupTestNeeded || actual.qqTest?.tested)), optional: !groupTestNeeded, description: groupTestNeeded ? '可主动向已授权群发送一条固定测试消息，不调用 AI。' : '当前方案无需向群发送测试消息；本地结果可在仪表盘查看。' },
    ];
    const nextStep = steps.find(step => !step.complete)?.id || 'complete';
    return safeDetails({ accountId: account.id, readOnly: actual.permissions?.readOnly ?? !released, released, pendingChanges: store.pendingChanges(), nextStep, steps: steps.map(({ complete, ...step }) => ({ ...step, state: complete ? 'complete' : step.id === nextStep ? 'current' : 'pending' })), blockers, models: { configured: modelsReady, tested: selected.some(provider => provider.tested), providers }, connection: { state: actual.state || (actual.connected ? 'connected' : 'disconnected'), connected: Boolean(actual.connected), verified, expectedQQ: draft.botQQ, actualQQ: String(actual.accountId || ''), lastError: actual.lastError || '', issue: actual.issue || null }, verification: actual.qqTest || { tested: false } });
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
      item.status = 'failed'; item.error = redact(error.message); if (error.code) item.code = error.code; if (error.action) item.action = redact(error.action); if (error.details) item.details = safeDetails(error.details); if (error.issues) item.issues = safeDetails(error.issues); log(`${label}失败：${error.message}`, 'error');
    }).finally(() => { item.finishedAt = new Date().toISOString(); activeJob = null; });
    return { job: item };
  };
  const ensureIdle = () => { ensureOpen(); if (applying || activeJob) throw fail('该账号的配置或模块任务正在执行，请稍后重试。'); };
  const checkEnvironment = async () => {
    const revision = getNapcatSettings().revision;
    const result = await installer.environment();
    if (!closed && revision === getNapcatSettings().revision) environment = result;
  };
  const apply = async (mode = 'apply', revision) => {
    ensureIdle();
    if (mode !== 'rollback' && revision !== store.getState().revision) throw fail('配置版本已变化，请刷新后重试。');
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
      if (mode === 'release' && (!config.qq.enabled || (!config.groups.some(group => group.read) && !config.permissions.privateReplies))) throw Object.assign(fail('请先连接 QQ，并在群权限中选择读取范围或私聊范围。'), { code: 'PERMISSION_TARGET_MISSING', field: 'groups', action: '完成 QQ 连接后读取群列表，勾选允许读取的群，再点击启动此账号。', nextStep: 'permissions' });
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
        if (!actual.connected || String(actual.accountId || '') !== config.botQQ) throw Object.assign(fail('QQ 实际登录身份尚未确认或与接入 QQ 号不一致，权限未释放。'), { code: actual.connected ? 'QQ_IDENTITY_MISMATCH' : 'QQ_NOT_CONNECTED', field: 'botQQ', action: '在 NapCat 中登录本账号填写的 QQ，测试连接通过后再启动。', nextStep: 'connection' });
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
  const validateSecretUpdates = (updates = {}, config) => {
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) throw fail('凭据更新格式无效。', 400);
    for (const [name, value] of Object.entries(updates)) {
      if (!isCredentialName(name) || (name.startsWith('apiKey:') && !(config.models.apis || []).some(model => apiSecretName(model.id) === name)) || typeof value !== 'string' || value.length > 2000 || /[\r\n]/.test(value)) throw fail('凭据字段无效。', 400);
    }
    return updates;
  };
  const save = async body => {
    ensureOpen();
    if (applying) throw fail('配置正在应用，请稍后保存。');
    const config = validateConfig(body.config);
    config.permissions.released = false;
    const updates = validateSecretUpdates(body.secretUpdates || {}, config);
    store.stageSecrets(updates); store.saveDraft(config);
    log('参数已保存；应用后只读，发送需单独释放权限。');
    return state();
  };
  const resetDefaults = async body => {
    ensureIdle();
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Number.isSafeInteger(body.revision) || body.revision < 0) throw fail('请提供当前配置版本后重试。', 400);
    const before = store.getState();
    if (body.revision !== before.revision) throw fail('配置版本已变化，请刷新后再还原默认。');
    // Validate the whole captured form, including fields being reset, before
    // staging credentials. Unsaved identity, connection and model edits remain.
    const config = validateConfig(body.config);
    const updates = validateSecretUpdates(body.secretUpdates, config);
    const selectedProviders = ['deepseek', 'codex', ...config.models.apis.map(model => model.id)]
      .filter(provider => getModelConfig(config, provider).enabled);
    const provider = selectedProviders.length === 1 ? selectedProviders[0] : DEFAULT_CONFIG.chat.provider;
    for (const section of ['chat', 'summary', 'favorites']) config[section] = { ...structuredClone(DEFAULT_CONFIG[section]), provider };
    config.groups = structuredClone(DEFAULT_CONFIG.groups);
    config.permissions = structuredClone(DEFAULT_CONFIG.permissions);
    const oldSecrets = store.getSecretSnapshot();
    try {
      store.stageSecrets(updates);
      store.saveDraft(config);
    } catch (error) {
      // A failed save must not leave newly typed credentials staged by itself.
      // Both underlying files use the store's atomic replacement path.
      try { store.restoreState(before); }
      finally { store.restoreSecrets(oldSecrets); }
      throw error;
    }
    log('当前账号功能参数已还原默认并保存；应用后只读，发送需单独释放权限。');
    return state();
  };
  const invoke = async (route, body) => {
    ensureOpen();
    if (route === '/napcat/open') {
      if (!Number.isSafeInteger(body.revision) || Object.keys(body).some(key => key !== 'revision')) throw fail('请提供当前 NapCat 全局设置版本后重试。', 400);
      if (body.revision !== getNapcatSettings().revision) throw fail('NapCat 接入方式已变化，请刷新后再打开。');
      return { code: 202, value: job('打开 NapCat', installer.startNapcat) };
    }
    if (route === '/config/save') return { value: await save(body) };
    if (route === '/config/reset-defaults') return { value: await resetDefaults(body) };
    if (route === '/config/apply') { await apply('apply', body.revision); return { value: await state() }; }
    if (route === '/config/rollback') { await apply('rollback'); return { value: await state() }; }
    if (route === '/permissions/release') { await apply('release', body.revision); return { value: await state() }; }
    if (route === '/permissions/revoke') return { value: await revoke() };
    if (route === '/environment/check') { await checkEnvironment(); return { value: await state() }; }
    if (route === '/setup/install') {
      const ids = body.modules || ['napcat', 'codex'];
      if (!Array.isArray(ids) || !ids.length || ids.some(id => !['napcat', 'codex'].includes(id))) throw fail('安装模块列表无效。', 400);
      return { code: 202, value: job('安装所选模块', async onLog => {
        for (const id of [...new Set(ids)]) { onLog(`开始安装 ${id}`); await installer.install(id, onLog); if (id === 'napcat') await installer.startNapcat(onLog); }
        await checkEnvironment();
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
    if (route === '/codex/login') return { code: 202, value: job('本账号 GPT 官方设备授权', async onLog => { runtime.invalidateModelTest?.('codex'); codexAuth = await installer.loginCodex(onLog); return codexAuth; }) };
    if (route === '/codex/status') { const result = await installer.codexStatus(); if (!result.loggedIn || codexAuth.loggedIn !== result.loggedIn) runtime.invalidateModelTest?.('codex'); codexAuth = result; return { value: safeDetails(codexAuth) }; }
    if (route === '/runtime/connect') { checkConflicts(store.getConfig(), account.id); await runtime.connect(); return { value: await state() }; }
    if (route === '/test/deepseek') return { value: await runtime.testDeepSeek() };
    if (route === '/test/model') {
      if (typeof body.provider !== 'string' || !getModelConfig(store.getConfig(), body.provider)) throw fail('请选择当前账号已配置的模型。', 400);
      return { value: await runtime.testModel(body.provider) };
    }
    if (route === '/qq/test-message') return { value: await runtime.testGroupMessage(body.groupId) };
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
    account, store, runtime, installer, summary, state, setupStatus, invoke, redact, ensureIdle,
    invalidateEnvironment() { environment = null; },
    async start() {
      if (started) return;
      started = true;
      Promise.resolve().then(checkEnvironment).catch(error => log(`环境检查失败：${error.message}`, 'error'));
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
