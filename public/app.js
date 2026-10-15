'use strict';

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const clone = (value) => structuredClone(value);
  const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const pageInfo = {
    overview: ['总览', 'WORKSPACE OVERVIEW', '你的账号控制工作台', '多个账号独立运行；先配置模型与任务，再明确释放消息权限。'],
    connections: ['账号控制', 'ACCOUNT CONTROL', '创建和连接你的账号', 'QQ 连接、DeepSeek API 与 Codex 授权均按账号独立管理。'],
    scenarios: ['场景与权限', 'SCENARIOS & PERMISSIONS', '为这个账号设置任务与范围', '功能参数决定做什么，群与消息权限决定能读取和发送到哪里。'],
    modules: ['模块管理', 'MODULE MANAGEMENT', '管理这个账号的运行模块', '可连接原生 NapCat；自动安装 NapCat 使用 Docker 方式。'],
    records: ['任务与记录', 'ACTIVITY & EVIDENCE', '查看这个账号的任务与依据', '每个账号的安装、授权、通知和收藏记录彼此独立。']
  };
  let accounts = [];
  let platforms = [];
  let directoryToken = '';
  let selectedAccountId = '';
  // Unsaved fields and credentials stay in memory and belong to a stable profile ID.
  const editors = new Map();
  let state = null;
  let draft = null;
  let dirty = false;
  let editVersion = 0;
  let secretUpdates = {};
  let refreshPromise = null;
  let currentPage = 'overview';
  let currentScenarioTab = 'tasks';
  let dialogResolve = null;
  let consecutiveFailures = 0;
  let codexLoginStatus = null;

  function getPath(object, path) { return path.split('.').reduce((value, key) => value?.[key], object); }
  function setPath(object, path, value) {
    const keys = path.split('.');
    let parent = object;
    for (const key of keys.slice(0, -1)) {
      if (!parent[key] || typeof parent[key] !== 'object') parent[key] = {};
      parent = parent[key];
    }
    parent[keys.at(-1)] = value;
  }
  function currentAccount() { return accounts.find((account) => account.id === selectedAccountId) ?? state?.account; }
  function accountName(id = selectedAccountId) { return accounts.find((account) => account.id === id)?.name ?? editors.get(id)?.state?.account?.name ?? '当前账号'; }
  function rememberEditor() {
    if (!selectedAccountId) return;
    const previous = editors.get(selectedAccountId) ?? {};
    editors.set(selectedAccountId, { ...previous, state, draft, dirty, editVersion, secretUpdates, codexLoginStatus, summaryGroup: $('#summary-group').value });
  }
  function adoptEditor(id, { populate = true } = {}) {
    const editor = editors.get(id) ?? {};
    state = editor.state ?? null;
    draft = editor.draft ?? null;
    dirty = editor.dirty ?? false;
    editVersion = editor.editVersion ?? 0;
    secretUpdates = editor.secretUpdates ?? {};
    codexLoginStatus = editor.codexLoginStatus ?? null;
    if (populate) populateForm();
  }
  function markDirty() {
    dirty = true;
    editVersion += 1;
    rememberEditor();
    renderConfigBar();
  }
  function toast(message, kind = 'success') {
    const item = document.createElement('div');
    item.className = `toast ${kind}`;
    item.textContent = message;
    $('#toast-region').append(item);
    while ($('#toast-region').children.length > 3) $('#toast-region').firstElementChild.remove();
    setTimeout(() => item.remove(), kind === 'error' ? 11000 : 6000);
  }
  function errorMessage(error) { return error?.message || String(error); }
  async function api(path, body, method = 'POST', token = directoryToken) {
    const options = { method, credentials: 'same-origin', headers: {} };
    if (method !== 'GET') {
      if (!token) throw new Error('尚未连接管理服务，请先刷新状态。');
      options.headers['X-Dashboard-Token'] = token;
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body ?? {});
    }
    const response = await fetch(path, options);
    const text = await response.text();
    let result;
    try { result = text ? JSON.parse(text) : {}; } catch { throw new Error(`后台返回了无法读取的响应（HTTP ${response.status}）。`); }
    if (!response.ok) {
      const details = result.details ? (typeof result.details === 'string' ? result.details : JSON.stringify(result.details)) : '';
      throw new Error(`${result.error || `操作失败（HTTP ${response.status}）`}${details ? `：${details}` : ''}`);
    }
    return result;
  }
  function requireAccount(id = selectedAccountId) {
    if (!id || !editors.get(id)?.state) throw new Error('请先创建并选择一个账号，等待其配置加载。');
    return id;
  }
  function accountApi(path, body, method = 'POST', id = selectedAccountId) {
    requireAccount(id);
    return api(`/api/accounts/${encodeURIComponent(id)}${path}`, body, method, editors.get(id)?.state?.csrfToken ?? directoryToken);
  }
  function setOnline(online) {
    $('#server-dot').className = `status-dot ${online ? 'online' : 'offline'}`;
    $('#server-label').textContent = online ? '管理服务可访问' : '管理服务无法访问';
  }
  function acceptState(next, { replaceDraft = false, accountId = selectedAccountId, expectedEditVersion } = {}) {
    if (!next?.draft || !accountId) return;
    if (accountId === selectedAccountId) rememberEditor();
    const editor = editors.get(accountId) ?? { editVersion: 0, dirty: false, secretUpdates: {} };
    // A late save response must not erase edits made after that save was submitted.
    const mayReplace = expectedEditVersion === undefined || (editor.editVersion ?? 0) === expectedEditVersion;
    editor.state = next;
    if (!editor.draft || (!editor.dirty && !Object.keys(editor.secretUpdates ?? {}).length) || (replaceDraft && mayReplace)) {
      editor.draft = clone(next.draft);
      editor.dirty = false;
      editor.secretUpdates = {};
    }
    editors.set(accountId, editor);
    const entry = accounts.find((account) => account.id === accountId);
    if (entry) {
      Object.assign(entry, next.account ?? {}, { runtime: next.runtime, permissions: next.applied?.permissions, pendingChanges: next.pendingChanges || next.secretsPendingChanges });
      if (next.draft.botQQ !== undefined) entry.qqNumber = next.draft.botQQ;
    }
    if (accountId === selectedAccountId) {
      adoptEditor(accountId, { populate: !dirty || (replaceDraft && mayReplace) });
      setOnline(true);
      $('#load-error').classList.add('hidden');
      renderLiveState();
    } else renderAccountDirectory();
  }
  async function refreshAccount(id) {
    if (!id) return null;
    const next = await api(`/api/accounts/${encodeURIComponent(id)}/state`, undefined, 'GET');
    if (!next.draft || !next.csrfToken) throw new Error('后台账号状态不完整，无法加载配置。');
    acceptState(next, { accountId: id });
    return next;
  }
  async function refreshDirectory() {
    const directory = await api('/api/accounts', undefined, 'GET');
    if (!Array.isArray(directory.accounts) || !directory.csrfToken) throw new Error('后台账号目录不完整。');
    accounts = directory.accounts;
    platforms = directory.platforms ?? [];
    directoryToken = directory.csrfToken;
    renderAccountDirectory();
    return directory;
  }
  async function selectAccount(id) {
    if (id === selectedAccountId && state) return;
    rememberEditor();
    selectedAccountId = id;
    adoptEditor(id);
    $('#policy-result').classList.add('hidden');
    $('#policy-result').textContent = '';
    renderLiveState();
    if (id) await refreshAccount(id);
  }
  async function refreshState({ notify = false } = {}) {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      try {
        await refreshDirectory();
        if (!accounts.some((account) => account.id === selectedAccountId)) await selectAccount(accounts[0]?.id ?? '');
        else await refreshAccount(selectedAccountId);
        setOnline(true);
        consecutiveFailures = 0;
        if (notify) toast('已刷新各账号实际状态；未保存输入已保留。');
        return state;
      } catch (error) {
        consecutiveFailures += 1;
        setOnline(false);
        if (!state || consecutiveFailures >= 2) {
          $('#load-error').textContent = `无法读取管理服务：${errorMessage(error)} 你的各账号输入仍保留在当前页面。`;
          $('#load-error').classList.remove('hidden');
        }
        if (notify) toast(errorMessage(error), 'error');
        return null;
      } finally { refreshPromise = null; }
    })();
    return refreshPromise;
  }
  function navigate(page) {
    if (!pageInfo[page]) page = 'overview';
    currentPage = page;
    const [caption, eyebrow, title, description] = pageInfo[page];
    $('#page-caption').textContent = caption;
    $('#page-eyebrow').textContent = eyebrow;
    $('#page-title').textContent = title;
    $('#page-description').textContent = description;
    $$('.page-panel').forEach((panel) => panel.classList.toggle('hidden', panel.id !== `page-${page}`));
    $$('.nav-link').forEach((link) => {
      link.classList.toggle('active', link.dataset.page === page);
      if (link.dataset.page === page) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    if (location.hash !== `#${page}`) history.replaceState(null, '', `#${page}`);
    window.scrollTo({ top: 0, behavior: 'auto' });
  }
  function selectScenarioTab(tab) {
    currentScenarioTab = tab === 'permissions' ? 'permissions' : 'tasks';
    $$('.scenario-tab').forEach((button) => {
      const selected = button.dataset.scenarioTab === currentScenarioTab;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', String(selected));
    });
    $$('.scenario-content').forEach((panel) => panel.classList.toggle('hidden', panel.id !== `scenario-${currentScenarioTab}`));
  }
  function populateForm() {
    $$('[data-config]').forEach((input) => {
      const value = getPath(draft, input.dataset.config);
      if (input.type === 'checkbox') input.checked = Boolean(value);
      else input.value = value ?? '';
      input.disabled = !draft;
    });
    $$('[data-secret]').forEach((input) => {
      input.value = secretUpdates[input.dataset.secret] ?? '';
      input.disabled = !draft;
    });
    renderGroups();
  }
  function renderAccountDirectory() {
    const selector = $('#account-selector');
    const previous = selector.value;
    const options = accounts.length ? accounts.map((account) => `<option value="${escapeHTML(account.id)}">${escapeHTML(account.name || account.qqNumber || 'QQ 账号')} · ${escapeHTML(account.qqNumber || '待填写 QQ')}</option>`).join('') : '<option value="">尚无账号</option>';
    if (selector.innerHTML !== options) selector.innerHTML = options;
    selector.value = accounts.some((account) => account.id === selectedAccountId) ? selectedAccountId : previous;
    selector.disabled = accounts.length === 0;
    const empty = '<div class="empty-state"><strong>创建第一个账号</strong>输入 QQ 号并配置模型，新账号默认只读。</div>';
    const html = accounts.length ? accounts.map((account) => {
      const runtime = account.runtime ?? {};
      const connected = runtime.connected === true || ['connected', 'running'].includes(runtime.connectionState ?? runtime.status);
      const released = account.permissions?.released === true;
      const editor = editors.get(account.id);
      return `<button class="account-card ${account.id === selectedAccountId ? 'selected' : ''}" data-select-account="${escapeHTML(account.id)}"><span class="account-avatar">Q</span><span class="account-card-main"><strong>${escapeHTML(account.name || 'QQ 账号')}</strong><small>QQ ${escapeHTML(account.qqNumber || '待填写')} · ${connected ? '已连接' : '未确认连接'}${editor?.dirty ? ' · 有未保存修改' : account.pendingChanges ? ' · 参数待应用' : ''}</small></span><span class="pill ${released ? 'pill-green' : 'pill-neutral'}">${released ? '已释放范围权限' : '只读'}</span></button>`;
    }).join('') : empty;
    updateRecordHTML($('#account-cards'), html);
    updateRecordHTML($('#overview-accounts'), html);
    $('#no-accounts').classList.toggle('hidden', accounts.length !== 0);
    $('#account-workspace').classList.toggle('hidden', !selectedAccountId);
    const appliedReleased = state?.applied?.permissions?.released === true;
    $('#account-permission-badge').textContent = selectedAccountId ? appliedReleased ? '已释放范围权限' : '只读 · 未释放发送' : '未选择账号';
    $('#account-permission-badge').className = `pill ${appliedReleased ? 'pill-green' : 'pill-neutral'}`;
    $('#records-account-note').textContent = selectedAccountId ? `这里只展示「${accountName()}」的任务、汇总与收藏；切换账号不会改变正在执行任务的归属。` : '请先创建并选择账号。';
  }
  function renderConfigBar() {
    const pending = Boolean(state?.pendingChanges || state?.secretsPendingChanges);
    $('#config-indicator').className = `config-indicator ${dirty || pending ? 'pending' : state ? 'clean' : ''}`;
    $('#config-label').textContent = !state ? '请先创建或选择账号' : dirty ? '此账号有尚未保存的修改' : pending ? '此账号草稿已保存，等待应用' : '此账号参数已同步';
    $('#config-detail').textContent = !state ? '每个账号有独立草稿和运行配置' : `${accountName()} · 草稿 ${state.revision ?? '—'} / 已应用 ${state.appliedRevision ?? '—'}${dirty ? ' · 输入仅在此页面' : state.secretsPendingChanges ? ' · 凭据待应用' : ''} · 应用参数后恢复只读`;
    $('#discard-draft').disabled = !dirty;
    $('#save-draft').disabled = !state || !dirty;
    $('#apply-config').disabled = !state || (!dirty && !pending);
    $('#release-permissions').disabled = !state;
    $('#revoke-permissions').disabled = !state || state.applied?.permissions?.released !== true;
    $$('[data-action], [data-module-action], #setup-install, #add-group, #open-napcat, #export-config, #rollback-config, #preview-policy').forEach((button) => { button.disabled = !state; });
  }
  function renderSecrets() {
    [['deepseekApiKey', '#deepseek-secret-state'], ['napcatToken', '#napcat-secret-state']].forEach(([name, selector]) => {
      const saved = Boolean(state?.secrets?.[name]);
      $(selector).textContent = saved ? '此账号已有凭据 · 留空保留' : '此账号尚未配置';
      $(selector).classList.toggle('missing', !saved);
    });
  }
  function getModules() { return Array.isArray(state?.modules) ? state.modules : Object.entries(state?.modules ?? {}).map(([id, value]) => ({ id, ...value })); }
  function statusInfo(value) {
    if (value === true) return ['可用', 'green'];
    if (value === false) return ['不可用', 'red'];
    const raw = String(value ?? 'unknown').toLowerCase();
    const table = {
      connected: ['已连接', 'green'], running: ['运行中', 'green'], ready: ['就绪', 'green'], available: ['内置可用', 'green'],
      installed: ['已安装', 'green'], success: ['已完成', 'green'], succeeded: ['已完成', 'green'], completed: ['已完成', 'green'],
      ok: ['通过', 'green'], passed: ['通过', 'green'], done: ['已完成', 'green'], logged_in: ['已登录', 'green'],
      queued: ['排队中', 'orange'], pending: ['等待中', 'orange'], installing: ['安装中', 'orange'],
      starting: ['启动中', 'orange'], connecting: ['连接中', 'orange'], reconnecting: ['重连中', 'orange'],
      waiting_login: ['等待登录', 'orange'], warning: ['需检查', 'orange'], check: ['需检查', 'orange'], busy: ['操作中', 'orange'],
      error: ['失败', 'red'], failed: ['失败', 'red'], missing: ['未安装', 'orange'], not_installed: ['未安装', 'orange'],
      disconnected: ['未连接', 'neutral'], stopped: ['已停止', 'neutral'], disabled: ['未启用', 'neutral'],
      unknown: ['待检查', 'neutral'], idle: ['待运行', 'neutral'], cancelled: ['已取消', 'neutral']
    };
    return table[raw] ?? [String(value ?? '待检查'), 'neutral'];
  }
  function pill(value) {
    const [label, color] = statusInfo(value);
    return `<span class="pill pill-${color}">${escapeHTML(label)}</span>`;
  }
  function formatTime(value) {
    if (!value) return '时间未提供';
    const date = new Date(typeof value === 'number' && value < 100000000000 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
  }
  function checkRow(name, description, status) {
    const [label, color] = statusInfo(status);
    const iconClass = color === 'green' ? 'good' : color === 'red' ? 'bad' : color === 'orange' ? 'warning' : '';
    return `<div class="check-row"><span class="check-icon ${iconClass}">${color === 'green' ? '✓' : color === 'red' ? '×' : '·'}</span><div class="check-text"><strong>${escapeHTML(name)}</strong><small>${escapeHTML(description)}</small></div><span class="pill pill-${color}">${escapeHTML(label)}</span></div>`;
  }
  function qqRuntimeStatus() {
    const runtime = state?.runtime ?? {};
    if (typeof runtime.qq === 'object') return runtime.qq.status ?? (runtime.qq.connected === true ? 'connected' : runtime.qq.connected === false ? 'disconnected' : 'unknown');
    if (runtime.connected === true) return 'connected';
    return runtime.connectionState ?? runtime.state ?? runtime.status ?? (runtime.connected === false ? 'disconnected' : 'unknown');
  }
  function renderEnvironment() {
    const environment = state?.environment;
    let checks = [];
    if (Array.isArray(environment)) checks = environment;
    else if (Array.isArray(environment?.checks)) checks = environment.checks;
    else if (environment && typeof environment === 'object') {
      checks = Object.entries(environment).filter(([key, value]) => !['checkedAt', 'platform', 'arch', 'message', 'setupGuide', 'dockerInstallUrl'].includes(key) && value !== null).map(([key, value]) => typeof value === 'object' ? { name: key, ...value } : { name: key, detail: String(value), status: typeof value === 'boolean' ? value : 'unknown' });
    }
    const names = { node: 'Node.js', docker: 'Docker Desktop', codex: '官方 Codex CLI', platform: '操作系统', npm: 'npm', wsl: 'WSL 2' };
    $('#environment-checks').innerHTML = checks.length ? checks.map((check) => {
      const name = check.name ?? names[check.id] ?? check.id ?? check.label ?? '环境检查';
      const status = check.status ?? (check.name === 'docker' ? (check.running && check.linuxContainers ? 'ready' : check.installed ? 'warning' : 'missing') : check.supported !== undefined ? check.supported : check.ok !== undefined ? check.ok : check.available !== undefined ? check.available : check.installed !== undefined ? (check.installed ? 'installed' : 'missing') : 'unknown');
      const detail = check.message ?? check.detail ?? check.description ?? check.version ?? '';
      return checkRow(names[name] ?? name, detail, status);
    }).join('') : '<div class="empty-state">尚无检查结果。点击「重新检查」获取实际环境。</div>';
    if (environment?.setupGuide) $('#environment-checks').insertAdjacentHTML('beforeend', `<p class="field-note">${escapeHTML(environment.setupGuide)}</p>`);
    if (environment?.dockerInstallUrl === 'https://docs.docker.com/desktop/setup/install/windows-install/') $('#environment-checks').insertAdjacentHTML('beforeend', '<p class="field-note"><a href="https://docs.docker.com/desktop/setup/install/windows-install/" target="_blank" rel="noopener noreferrer">Docker Desktop 官方安装说明 ↗</a></p>');
  }
  function renderRuntime() {
    const runtime = state?.runtime ?? {};
    const qqStatus = qqRuntimeStatus();
    const [label, color] = statusInfo(qqStatus);
    const actualAccount = runtime.accountId ?? runtime.qq?.accountId;
    const configuredAccount = draft?.botQQ || currentAccount()?.qqNumber;
    const groups = state?.applied?.groups ?? [];
    const readable = groups.filter((group) => group.read === true).length;
    const sendTargets = groups.filter((group) => group.send === true).length;
    const writable = Array.isArray(runtime.permissions?.writableGroups) ? runtime.permissions.writableGroups.length : 0;
    const released = state?.applied?.permissions?.released === true;
    const auth = state?.codexAuth?.loggedIn !== null && state?.codexAuth?.loggedIn !== undefined ? state.codexAuth : codexLoginStatus;
    $('#runtime-badge').textContent = selectedAccountId ? `${accountName()} · ${label}` : '尚无账号';
    $('#runtime-badge').className = `heading-status ${color === 'green' ? 'connected' : color === 'red' ? 'error' : ''}`;
    $('#account-login-status').textContent = actualAccount ? `后台确认 QQ ${actualAccount} · ${label}` : `${label} · 尚未确认登录 QQ`;
    $('#account-codex-status').textContent = auth?.message || (auth?.loggedIn === true ? '此账号的官方 Codex 已授权' : auth?.loggedIn === false ? '此账号尚未登录 Codex' : '此账号授权状态等待检查');
    $('#runtime-status').innerHTML = checkRow('QQ 实际连接', actualAccount ? `后台确认 QQ ${actualAccount}` : `尚未确认实际登录 QQ${configuredAccount ? `；配置 QQ ${configuredAccount}` : ''}`, qqStatus)
      + checkRow('消息发送权限', released ? `已释放 · ${writable} 个满足任务条件的发送群 · 私聊${state?.applied?.permissions?.privateReplies ? '已授权指定接收 QQ' : '未授权'}` : '只读：不会因连接 QQ 或登录模型而发送消息', released ? 'ready' : 'disabled')
      + checkRow('Codex 订阅授权', auth?.message ?? '请在账号控制中检查此账号的官方 CLI 授权', auth?.loggedIn === true ? 'logged_in' : auth?.loggedIn === false ? 'waiting_login' : 'unknown');
    $('#runtime-details').textContent = JSON.stringify(runtime, null, 2);
    const connectedAccounts = accounts.filter((account) => account.runtime?.connected === true || account.runtime?.connectionState === 'connected').length;
    const stats = [
      ['账号总数', accounts.length, `${connectedAccounts} 个账号已连接 · 可同时运行`, '⇄'],
      ['当前账号权限', released ? '已释放' : '只读', released ? '仅在明确授权的范围内发送' : '保存和登录均不自动授权', '◎'],
      ['当前账号可读群', readable, `${sendTargets} 个群已选择发送权限`, '▤'],
      ['当前账号整理记录', Array.isArray(state?.summaries) ? state.summaries.length : 0, '通知与收藏均可核对原文依据', '≡']
    ];
    $('#overview-stats').innerHTML = stats.map(([name, value, note, icon]) => `<div class="stat-card"><div><div class="stat-label">${escapeHTML(name)}</div><div class="stat-value">${escapeHTML(value)}</div><div class="stat-note">${escapeHTML(note)}</div></div><span class="stat-icon">${icon}</span></div>`).join('');
  }
  function renderPermissions() {
    const applied = state?.applied;
    const released = applied?.permissions?.released === true;
    const read = applied?.groups?.filter((group) => group.read === true) ?? [];
    const send = applied?.groups?.filter((group) => group.send === true) ?? [];
    $('#permissions-status').textContent = !state ? '未选择账号' : released ? '后台已释放范围权限' : '后台只读 · 未释放发送';
    $('#permissions-status').className = `pill ${released ? 'pill-green' : 'pill-neutral'}`;
    $('#permissions-applied-summary').textContent = !state ? '请先创建并选择账号。' : `${accountName()}：已应用 ${read.length} 个可读群，${send.length} 个待发送目标；${released ? '账号发送权限已释放' : '账号发送总开关关闭'}。私聊${applied?.permissions?.privateReplies && applied?.ownerQQ ? `仅指定 QQ ${applied.ownerQQ}` : '未授权'}。${state?.pendingChanges || dirty ? '下方还有草稿修改，尚未成为运行权限。' : ''}`;
  }
  function renderGroups() {
    const groups = draft?.groups ?? [];
    $('#group-rows').innerHTML = groups.length ? groups.map((group, index) => `<tr data-group-index="${index}"><td><input data-group-field="name" value="${escapeHTML(group.name)}" aria-label="群名称"><input class="group-id" data-group-field="id" value="${escapeHTML(group.id)}" inputmode="numeric" aria-label="QQ群号"></td><td><select data-group-field="mode" aria-label="群用途"><option value="social" ${group.mode !== 'work' ? 'selected' : ''}>社交群</option><option value="work" ${group.mode === 'work' ? 'selected' : ''}>工作通知群</option></select><small class="field-note">${group.mode === 'work' ? '可用于通知汇总' : '按社交功能参数处理'}</small></td><td><select data-group-field="trigger" aria-label="触发条件"><option value="mention" ${group.trigger === 'mention' ? 'selected' : ''}>@ 接入账号</option><option value="prefix" ${group.trigger === 'prefix' ? 'selected' : ''}>命令前缀</option><option value="casual" ${group.trigger === 'casual' ? 'selected' : ''}>概率参与聊天</option></select></td><td><div class="group-parameter">${group.trigger === 'prefix' ? `<label>前缀 <input data-group-field="prefix" value="${escapeHTML(group.prefix ?? '/ai')}" aria-label="命令前缀"></label>` : group.trigger === 'casual' ? `<label>概率 <input type="number" data-group-field="probability" min="0" max="0.25" step="0.01" value="${escapeHTML(group.probability ?? 0.03)}" aria-label="插话概率"></label>` : ''}<label>冷却秒 <input type="number" data-group-field="cooldownSeconds" min="5" max="3600" value="${escapeHTML(group.cooldownSeconds ?? 30)}" aria-label="冷却秒数"></label></div></td><td><label class="group-permission-check"><input type="checkbox" data-group-field="read" ${group.read === true ? 'checked' : ''}>允许读取</label><label class="group-permission-check"><input type="checkbox" data-group-field="send" ${group.send === true ? 'checked' : ''} ${group.read === true ? '' : 'disabled title="先允许读取，才能授权回复"'}>允许发送</label><small class="field-note">仍需释放账号权限</small></td><td><button class="remove-group" data-remove-group="${index}" aria-label="移除 ${escapeHTML(group.name || group.id)}">×</button></td></tr>`).join('') : '<tr><td colspan="6"><div class="empty-state"><strong>添加这个账号允许处理的 QQ 群</strong>新群默认允许读取、禁止发送；保存不会自动释放发送权限。</div></td></tr>';
  }
  function renderSummaryGroupSelect() {
    const select = $('#summary-group');
    const previous = editors.get(selectedAccountId)?.summaryGroup || select.value;
    const groups = state?.applied?.groups?.filter((group) => group.mode === 'work' && group.read === true) ?? [];
    const options = '<option value="">选择此账号已应用的可读工作群</option>' + groups.map((group) => `<option value="${escapeHTML(group.id)}">${escapeHTML(group.name || group.id)}</option>`).join('');
    if (select.innerHTML !== options) select.innerHTML = options;
    select.value = groups.some((group) => group.id === previous) ? previous : '';
    select.disabled = !state;
  }
  function renderModules() {
    const modules = getModules();
    const known = [
      { id: 'napcat', name: 'NapCat · QQ 连接组件', kind: 'external', description: '自动安装使用 Docker。也可自行运行 Windows 原生 NapCat，再在账号控制填写独立连接地址与 Token。', icon: '⇄' },
      { id: 'codex', name: '官方 Codex CLI', kind: 'external', description: '在此账号独立保存 ChatGPT / Codex 授权，用于本人指令与授权的整理任务。', icon: '✧' },
      { id: 'deepseek', name: 'DeepSeek 接入', kind: 'builtin', description: '此账号独立 API Key。配置模型不等于启用社交回复或释放消息权限。', path: 'models.deepseek.enabled', icon: '◈' },
      { id: 'summary', name: '通知汇总', kind: 'builtin', description: '此账号独立通知参数和任务模型；默认保存在本地，可另外授权指定私聊目标。', path: 'summary.enabled', icon: '▤' },
      { id: 'favorites', name: 'QQ 收藏读取', kind: 'builtin', description: '读取此账号的收藏列表与摘要，使用独立收藏模型进行本地整理。', path: 'favorites.enabled', icon: '☆' }
    ];
    $('#module-cards').innerHTML = known.map((definition) => {
      const module = modules.find((item) => item.id === definition.id);
      const builtin = definition.kind === 'builtin';
      const enabled = builtin && Boolean(getPath(draft, definition.path));
      const actualStatus = module ? module.state ?? module.status ?? (module.installed ? 'installed' : 'missing') : 'unknown';
      let actions;
      if (builtin) actions = `<button class="button button-secondary button-small" data-go="${definition.id === 'deepseek' ? 'connections' : 'scenarios'}">${enabled ? '查看当前账号参数' : '为当前账号配置'} →</button>`;
      else if (definition.id === 'napcat') actions = '<button class="button button-secondary button-small" data-module-action="install" data-module="napcat">Docker 安装 / 检查</button><button class="button button-quiet button-small" data-module-action="start" data-module="napcat">启动</button><button class="button button-quiet button-small" data-module-action="stop" data-module="napcat">停止</button>';
      else actions = '<button class="button button-secondary button-small" data-module-action="install" data-module="codex">安装 / 检查</button><button class="button button-quiet button-small" data-action="codex-login">当前账号授权 →</button>';
      return `<article class="module-card ${builtin ? 'builtin' : 'external'}"><div class="module-main"><div class="module-top"><span class="module-icon">${definition.icon}</span>${builtin ? `<span class="pill ${enabled ? 'pill-green' : 'pill-neutral'}">${enabled ? '此账号草稿已启用' : '内置 · 尚未启用'}</span>` : pill(actualStatus)}</div><h2>${escapeHTML(definition.name)}</h2><p>${escapeHTML(definition.description)}</p><div class="module-version">${builtin ? '启用功能仍受账号与消息权限约束' : module ? `版本 ${escapeHTML(module.version || '未提供')} · ${module.installed ? '已安装' : '未确认安装'}` : '等待此账号的模块检查结果'}</div></div><div class="module-actions">${actions}</div></article>`;
    }).join('');
  }
  function getJobs() {
    const jobs = Array.isArray(state?.jobs) ? state.jobs : Object.values(state?.jobs ?? {});
    return [...jobs].sort((left, right) => new Date(right.createdAt ?? right.startedAt ?? 0) - new Date(left.createdAt ?? left.startedAt ?? 0));
  }
  function jobOutput(job) {
    const output = job.logs ?? job.lines ?? job.output ?? job.message ?? '';
    const text = Array.isArray(output) ? output.map((line) => typeof line === 'string' ? line : line.message ?? line.text ?? JSON.stringify(line)).join('\n') : typeof output === 'object' ? JSON.stringify(output, null, 2) : String(output);
    return [text, job.error ? `失败：${job.error}` : '', job.details ? (typeof job.details === 'string' ? job.details : JSON.stringify(job.details, null, 2)) : ''].filter(Boolean).join('\n');
  }
  function jobsHTML(jobs, showOutput = true) {
    if (!jobs.length) return '<div class="empty-state"><strong>尚无任务记录</strong>安装、授权和操作后，实际执行结果会显示在这里。</div>';
    const titles = { 'install-napcat': '安装 NapCat', 'install-codex': '安装 Codex CLI', 'codex-login': 'GPT 官方设备码授权', 'setup-install': '安装所选模块' };
    return jobs.map((job) => {
      const status = job.status ?? job.state ?? 'unknown';
      const output = jobOutput(job);
      const login = /login|授权|设备码/i.test(String(job.type ?? job.name ?? job.label ?? job.id));
      const running = ['running', 'pending', 'queued', 'installing'].includes(status);
      return `<article class="job-row"><div class="job-header"><div><div class="job-title">${escapeHTML(job.title ?? job.name ?? job.label ?? titles[job.type] ?? job.type ?? '后台任务')}</div><div class="job-meta">${escapeHTML(formatTime(job.createdAt ?? job.startedAt))}${job.id ? ` · ${escapeHTML(job.id)}` : ''}</div></div>${pill(status)}</div>${showOutput && output ? `<details data-record-id="${escapeHTML(job.id || job.startedAt)}" ${login && running ? 'open' : ''}><summary>查看执行输出${login ? ' / 授权信息' : ''}</summary><pre class="job-output">${escapeHTML(output)}</pre></details>` : ''}</article>`;
    }).join('');
  }
  function renderJobs() {
    const jobs = getJobs();
    updateRecordHTML($('#recent-jobs'), jobsHTML(jobs.slice(0, 3), false));
    updateRecordHTML($('#module-jobs'), jobsHTML(jobs.slice(0, 5)));
    updateRecordHTML($('#all-jobs'), jobsHTML(jobs));
  }
  function updateRecordHTML(element, html) {
    if (element.dataset.renderedHTML === html) return;
    const open = $$('details[open][data-record-id]', element).map((details) => details.dataset.recordId);
    element.innerHTML = html;
    element.dataset.renderedHTML = html;
    $$('details[data-record-id]', element).forEach((details) => { if (open.includes(details.dataset.recordId)) details.open = true; });
  }
  function renderSummaries() {
    const summaries = Array.isArray(state?.summaries) ? state.summaries : [];
    updateRecordHTML($('#summary-records'), summaries.length ? summaries.map((summary) => {
      const evidence = Array.isArray(summary.evidence) ? summary.evidence : summary.evidence ? [summary.evidence] : [];
      const group = state?.applied?.groups?.find((item) => item.id === String(summary.groupId));
      const delivery = typeof summary.delivery === 'object' ? summary.delivery.state ?? summary.delivery.status : summary.delivery;
      const deliveryLabels = { sent: '已发送本人', unknown: '发送结果不确定，请核对私聊', partially_sent: '部分已发送，请核对私聊', local_only: '仅保存在本地', saved: '仅保存在本地', not_requested: '仅保存在本地', pending: '等待发送', not_sent: '未发送', failed: '发送失败', skipped: '未发送' };
      return `<article class="summary-item"><div class="summary-header"><div><strong>${escapeHTML(summary.groupName || group?.name || summary.groupId || '通知汇总')}</strong><div class="job-meta">${escapeHTML(formatTime(summary.createdAt))} · ${escapeHTML(summary.provider === 'codex' ? 'GPT 个人订阅' : summary.provider === 'deepseek' ? 'DeepSeek' : summary.provider ?? '模型未提供')}</div></div>${delivery ? `<span class="pill ${['unknown', 'partially_sent', 'failed'].includes(delivery) ? 'pill-orange' : 'pill-neutral'}">${escapeHTML(deliveryLabels[delivery] || delivery)}</span>` : ''}</div><div class="summary-body">${escapeHTML(summary.text)}</div>${String(summary.groupId ?? '').startsWith('favorites:') ? '<p class="field-note">此整理仅引用当前账号收藏的列表摘要，不包含已验证的全文、图片或附件。</p>' : ''}<details data-record-id="${escapeHTML(summary.id || summary.createdAt)}"><summary>查看 ${evidence.length} 条原文依据</summary><div class="evidence-list">${evidence.length ? evidence.map((item) => typeof item === 'string' ? `<div class="evidence-item">${escapeHTML(item)}</div>` : `<div class="evidence-item"><div class="evidence-meta">${item.cid !== undefined ? '收藏' : '消息'} ${escapeHTML(item.messageId ?? item.cid ?? item.id ?? '未提供')} · ${item.cid !== undefined ? '所属账号' : '发送者'} ${escapeHTML(item.accountId && item.cid !== undefined ? item.accountId : item.userId ?? item.source ?? '未提供')} · ${escapeHTML(formatTime(item.time ?? item.collectTime ?? item.createdAt))}</div>${escapeHTML(item.text ?? item.content ?? item.summary ?? JSON.stringify(item))}</div>`).join('') : '未返回依据。请核对原始通知。'}</div></details></article>`;
    }).join('') : '<div class="empty-state"><strong>还没有通知汇总</strong>启用汇总并应用配置，然后在「场景与权限」中运行。</div>');
  }
  function renderFavorites() {
    const raw = state?.favorites;
    const favorites = Array.isArray(raw) ? raw : raw?.items ?? raw?.list ?? [];
    $('#favorite-records').innerHTML = favorites.length ? favorites.map((favorite) => `<article class="favorite-item"><div class="favorite-title">${escapeHTML(favorite.title ?? favorite.summary ?? favorite.name ?? `收藏 ${favorite.cid ?? favorite.id ?? ''}`)}</div><div class="favorite-body">${escapeHTML(favorite.text ?? favorite.content ?? favorite.summary ?? '')}</div><div class="job-meta">${escapeHTML(favorite.author ?? favorite.userId ?? '')} · 收藏时间 ${escapeHTML(formatTime(favorite.time ?? favorite.collectTime ?? favorite.createdAt))}${favorite.type !== undefined ? ` · 类型 ${escapeHTML(favorite.type)}` : ''} · 当前账号 ${escapeHTML(favorite.accountId ?? '未提供')} · 读取于 ${escapeHTML(formatTime(favorite.syncedAt))}</div></article>`).join('') : '<div class="empty-state"><strong>尚未读取收藏</strong>登录 QQ、启用收藏读取并应用配置后，点击「刷新收藏」。</div>';
  }
  function renderLogs() {
    const logs = Array.isArray(state?.logs) ? state.logs : [];
    const element = $('#log-records');
    const atBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 30;
    element.textContent = logs.length ? logs.map((entry) => typeof entry === 'string' ? entry : `${formatTime(entry.time ?? entry.timestamp ?? entry.createdAt)}  [${entry.level ?? 'info'}] ${entry.message ?? entry.text ?? JSON.stringify(entry)}`).join('\n') : '尚无后台运行日志。';
    if (atBottom) element.scrollTop = element.scrollHeight;
  }
  function renderLiveState() {
    renderAccountDirectory();
    renderSecrets();
    renderEnvironment();
    renderRuntime();
    renderPermissions();
    renderModules();
    renderJobs();
    renderSummaryGroupSelect();
    renderSummaries();
    renderFavorites();
    renderLogs();
    renderConfigBar();
  }
  function openDialog(title, content, confirmLabel = '确认') {
    if (dialogResolve) return Promise.resolve(false);
    $('#dialog-title').textContent = title;
    $('#dialog-content').innerHTML = content;
    $('#dialog-confirm').textContent = confirmLabel;
    $('#app-dialog').returnValue = '';
    $('#app-dialog').showModal();
    return new Promise((resolve) => { dialogResolve = resolve; });
  }
  $('#app-dialog').addEventListener('close', () => {
    const resolve = dialogResolve;
    dialogResolve = null;
    if (resolve) resolve($('#app-dialog').returnValue === 'confirm');
  });
  async function withButton(button, action) {
    if (button?.classList.contains('is-loading')) return;
    button?.classList.add('is-loading');
    try { await action(); } catch (error) { toast(errorMessage(error), 'error'); }
    finally { button?.classList.remove('is-loading'); }
  }
  async function mutate(path, body, message, id = selectedAccountId) {
    requireAccount(id);
    const result = await accountApi(path, body, 'POST', id);
    const next = result.draft ? result : result.state?.draft ? result.state : null;
    if (next) acceptState(next, { accountId: id });
    else await refreshAccount(id);
    if (message) toast(`「${accountName(id)}」${message}`, 'info');
    return result;
  }
  async function saveDraft({ forApply = false, accountId = selectedAccountId } = {}) {
    const id = requireAccount(accountId);
    if (id === selectedAccountId) rememberEditor();
    const editor = editors.get(id);
    const sentVersion = editor.editVersion;
    const config = clone(editor.draft);
    const submittedSecrets = clone(editor.secretUpdates);
    const result = await accountApi('/config/save', { config, ...(Object.keys(submittedSecrets).length ? { secretUpdates: submittedSecrets } : {}) }, 'POST', id);
    if (!result.draft) throw new Error('后台未返回保存后的账号配置，请刷新确认。');
    acceptState(result, { accountId: id, replaceDraft: true, expectedEditVersion: sentVersion });
    if (!forApply) toast(`「${accountName(id)}」${editors.get(id).editVersion === sentVersion ? '草稿已保存；运行参数与发送权限尚未改变。' : '已保存提交时的草稿，新增输入仍未保存。'}`);
    return id;
  }
  async function applyConfig(id = selectedAccountId) {
    requireAccount(id);
    if (id === selectedAccountId) rememberEditor();
    if (editors.get(id).dirty) await saveDraft({ forApply: true, accountId: id });
    if (editors.get(id).dirty) throw new Error('保存过程中有新增编辑，尚未应用。请再次点击应用参数。');
    const revision = editors.get(id).state.revision;
    const result = await accountApi('/config/apply', { revision }, 'POST', id);
    acceptState(result, { accountId: id });
    toast(`「${accountName(id)}」参数已应用，发送权限恢复只读。需要发送时，请到「选定群与消息权限」检查并释放。`, 'info');
  }
  async function releasePermissions() {
    const id = requireAccount();
    rememberEditor();
    const snapshot = clone(editors.get(id).draft);
    const reads = snapshot.groups?.filter((group) => group.read === true) ?? [];
    const sends = snapshot.groups?.filter((group) => group.send === true) ?? [];
    const targets = sends.length ? sends.map((group) => `<li>${escapeHTML(group.name || group.id)}（${escapeHTML(group.id)}）</li>`).join('') : '<li>不向任何群发送</li>';
    const privateTarget = snapshot.permissions?.privateReplies && snapshot.ownerQQ ? `指定 QQ ${escapeHTML(snapshot.ownerQQ)}` : '未允许私聊发送';
    if (!await openDialog(`释放「${accountName(id)}」的范围权限`, `<p>将保存并应用这个账号当前的任务和权限配置，并校验实际登录 QQ ${escapeHTML(snapshot.botQQ || '尚未填写')}。</p><div class="apply-preview"><p>允许读取：${reads.length} 个群</p><p>允许群发送：</p><ul>${targets}</ul><p>私聊：${privateTarget}</p><p>聊天与回复：${snapshot.chat?.enabled ? (snapshot.chat?.provider === 'codex' ? '已启用 · Codex 仅本人私聊' : '已启用 · DeepSeek') : '未启用'}；通知汇总：${snapshot.summary?.enabled ? '已启用' : '未启用'}；收藏：${snapshot.favorites?.enabled ? '已启用' : '未启用'}。</p></div><p>仅释放本次列出的范围。其他账号的配置和权限不受影响。</p>`, '保存并释放此账号权限')) return;
    if (editors.get(id).dirty) await saveDraft({ forApply: true, accountId: id });
    if (editors.get(id).dirty) throw new Error('此账号仍有新编辑，请重新检查权限后再释放。');
    const revision = editors.get(id).state.revision;
    const result = await accountApi('/permissions/release', { revision }, 'POST', id);
    acceptState(result, { accountId: id });
    toast(`「${accountName(id)}」后台已返回权限释放结果，请核对实际登录身份和已应用范围。`, 'info');
  }
  async function createAccount() {
    if (!directoryToken) throw new Error('请先等待管理服务加载。');
    const supported = Array.isArray(platforms) ? platforms.find((platform) => (platform.id ?? platform.platform) === 'qq') : platforms.qq;
    const qqLabel = supported?.name ?? supported?.label ?? 'QQ';
    if (!await openDialog('创建账号控制配置', `<label class="field">账号名称<input id="new-account-name" placeholder="例如：工作通知号" maxlength="80" required></label><label class="field">接入平台<select id="new-account-platform"><option value="qq">${escapeHTML(qqLabel)} · 已支持</option><option value="wechat" disabled>微信 · 规划中</option><option value="telegram" disabled>Telegram · 规划中</option></select></label><label class="field">接入 QQ 号<input id="new-account-qq" inputmode="numeric" pattern="[1-9][0-9]{3,19}" placeholder="希望接入和管理的 QQ 号" required></label><div class="notice notice-info">这一步创建配置，不会登录 QQ 或释放发送权限。之后可配置 DeepSeek / Codex，并通过 NapCat 扫码确认 QQ 身份。</div>`, '创建只读账号')) return;
    const name = $('#new-account-name').value.trim();
    const qqNumber = $('#new-account-qq').value.trim();
    if (!name) throw new Error('请输入方便识别的账号名称。');
    if (!/^[1-9]\d{3,19}$/.test(qqNumber)) throw new Error('QQ 号应为 4–20 位数字。');
    const result = await api('/api/accounts', { name, platform: 'qq', qqNumber });
    if (!result.account?.id || !result.state?.draft) throw new Error('后台未返回创建后的账号配置，请刷新账号目录确认。');
    rememberEditor();
    const existing = accounts.find((account) => account.id === result.account.id);
    if (existing) Object.assign(existing, result.account);
    else accounts.push(result.account);
    acceptState(result.state, { accountId: result.account.id, replaceDraft: true });
    await selectAccount(result.account.id);
    navigate('connections');
    await refreshDirectory();
    toast(`「${name}」已创建，默认只读。请连接 QQ 并配置模型。`);
  }
  async function openNapcatGuide() {
    const id = requireAccount();
    const guide = await accountApi('/napcat/guide', undefined, 'GET', id);
    let url;
    try { url = new URL(guide.url || editors.get(id).state?.applied?.qq?.webUiUrl); } catch { throw new Error('此账号的 NapCat 登录地址无效。'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('NapCat 登录地址必须使用 HTTP 或 HTTPS。');
    await openDialog(`「${accountName(id)}」QQ 扫码登录`, `<p>NapCat 负责连接 QQ。先登录其管理页面，再扫码登录你在本账号配置中填写的 QQ；输入 QQ 号或完成模型授权不代表 QQ 已登录。</p>${guide.message ? `<p>${escapeHTML(guide.message)}</p>` : ''}${guide.initialWebUiToken ? `<div class="notice notice-info"><strong>初始 WebUI 登录 Token</strong><p><code>${escapeHTML(guide.initialWebUiToken)}</code></p><p>仅用于此账号 NapCat 管理页面，请勿公开分享。</p></div>` : '<p>若已自行安装 Windows 原生 NapCat，可直接使用这个账号配置的管理页面，无需 Docker。</p>'}<p><a href="${escapeHTML(url.href)}" target="_blank" rel="noopener noreferrer">打开此账号 NapCat 页面 ↗</a></p>`, '知道了');
    $('#dialog-content').replaceChildren();
  }
  function addDraftGroups(id, entries) {
    const editor = editors.get(id);
    if (!editor?.draft) throw new Error('此账号的草稿尚未加载。');
    editor.draft.groups ??= [];
    for (const entry of entries) {
      if (editor.draft.groups.some((group) => group.id === String(entry.id))) continue;
      editor.draft.groups.push({ id: String(entry.id), name: entry.name ?? '', mode: entry.mode ?? 'work', read: true, send: false, trigger: 'mention', prefix: '/ai', probability: 0.03, cooldownSeconds: 30 });
    }
    editor.dirty = true;
    editor.editVersion = (editor.editVersion ?? 0) + 1;
    if (id === selectedAccountId) {
      adoptEditor(id);
      renderLiveState();
    }
  }
  const actions = {
    'environment-check': () => mutate('/environment/check', {}, '环境检查已返回。'),
    'runtime-connect': () => mutate('/runtime/connect', {}, '连接请求已提交，请查看后台确认的 QQ 身份。'),
    'codex-login': async () => {
      const id = requireAccount();
      await mutate('/codex/login', {}, '官方设备码授权任务已启动，请查看此账号任务输出中的地址与设备码。', id);
      if (selectedAccountId === id) navigate('modules');
    },
    'codex-status': async () => {
      const id = requireAccount();
      const result = await mutate('/codex/status', undefined, undefined, id);
      const status = result.loggedIn !== undefined ? result : result.status ?? result.codexAuth;
      if (status && typeof status === 'object') {
        const editor = editors.get(id);
        editor.codexLoginStatus = status;
        if (selectedAccountId === id) { codexLoginStatus = status; renderRuntime(); }
        toast(`「${accountName(id)}」${status.message || (status.loggedIn ? '官方 CLI 报告已授权。' : '尚未确认授权。')}`, status.loggedIn ? 'success' : 'info');
      }
    },
    'test-deepseek': async () => {
      const id = requireAccount();
      if (!await openDialog(`测试「${accountName(id)}」DeepSeek`, '<p>使用这个账号已应用的 API Key 与模型发送一次小型请求，可能产生 API 费用。</p><p>此测试不发送 QQ 消息；不会释放发送权限。</p>', '测试此账号 API')) return;
      const result = await mutate('/test/deepseek', undefined, undefined, id);
      await openDialog(`「${accountName(id)}」DeepSeek 测试结果`, `<p>模型测试不代表 QQ 已登录。</p><pre class="result-box">${escapeHTML(JSON.stringify(result, null, 2))}</pre>`, '知道了');
    },
    'summary-run': async () => {
      const id = requireAccount();
      const groupId = $('#summary-group').value;
      if (!groupId) throw new Error('请选择此账号已应用的可读工作群。');
      if (!await openDialog(`运行「${accountName(id)}」通知汇总`, `<p>读取此账号工作群 ${escapeHTML(groupId)} 的已保存消息，使用已应用的通知模型，可能消耗模型额度。</p><p>结果先保存在本地，发送需要对应功能、目标和账号权限均已授权。</p>`, '立即汇总')) return;
      await mutate('/summary/run', { groupId }, '通知汇总已返回，请核对原文依据和发送状态。', id);
      if (selectedAccountId === id) { navigate('records'); selectRecordTab('summaries'); }
    },
    'favorites-sync': async () => {
      const id = requireAccount();
      await mutate('/favorites/sync', {}, '收藏读取已返回，仅属于此账号实际登录的 QQ。', id);
      if (selectedAccountId === id) { navigate('records'); selectRecordTab('favorites'); }
    },
    'favorites-summarize': async () => {
      const id = requireAccount();
      await mutate('/favorites/summarize', {}, '收藏已使用独立收藏模型在本地整理，请核对依据。', id);
      if (selectedAccountId === id) { navigate('records'); selectRecordTab('summaries'); }
    },
    'groups-list': async () => {
      const id = requireAccount();
      const result = await accountApi('/qq/groups', undefined, 'GET', id);
      const groups = Array.isArray(result.groups) ? result.groups : [];
      const configured = new Set(editors.get(id).draft?.groups?.map((group) => group.id));
      const choices = groups.filter((group) => !configured.has(String(group.id)));
      if (!choices.length) return toast(groups.length ? '此账号已加入的群都已在配置中。' : '此账号未返回已加入群，请确认 QQ 已登录并已加入群。', 'info');
      const html = choices.map((group, index) => `<label class="check-field"><input type="checkbox" data-joined-group="${index}"><span>${escapeHTML(group.name || group.id)} · ${escapeHTML(group.id)}</span></label>`).join('');
      if (!await openDialog(`「${accountName(id)}」已加入的群`, `<p>选择要允许读取的群。添加默认禁止发送；群用途和发送权限仍可在表格中修改。</p><div class="joined-group-list">${html}</div>`, '将选中群加入只读草稿')) return;
      const selected = $$('[data-joined-group]:checked', $('#dialog-content')).map((input) => choices[Number(input.dataset.joinedGroup)]);
      if (!selected.length) return;
      addDraftGroups(id, selected);
      toast(`「${accountName(id)}」已将 ${selected.length} 个群加入只读草稿，保存应用后开始采集。`, 'info');
    }
  };
  function selectRecordTab(tab) {
    $$('.record-tab').forEach((button) => {
      const selected = button.dataset.recordTab === tab;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', String(selected));
    });
    $$('.record-content').forEach((panel) => panel.classList.toggle('hidden', panel.id !== `record-${tab}`));
  }
  document.addEventListener('input', (event) => {
    const input = event.target;
    if (input.dataset.config && draft) {
      const value = input.type === 'checkbox' ? input.checked : input.type === 'number' ? (input.value === '' ? null : Number(input.value)) : input.value;
      setPath(draft, input.dataset.config, value);
      markDirty();
      renderPermissions();
    } else if (input.dataset.secret && draft) {
      if (input.value.trim()) secretUpdates[input.dataset.secret] = input.value.trim();
      else delete secretUpdates[input.dataset.secret];
      markDirty();
    } else if (input.dataset.groupField && draft) {
      const index = Number(input.closest('[data-group-index]').dataset.groupIndex);
      draft.groups[index][input.dataset.groupField] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? (input.value === '' ? null : Number(input.value)) : input.value;
      if (input.dataset.groupField === 'read' && !input.checked) draft.groups[index].send = false;
      markDirty();
      if (input.dataset.groupField === 'read') renderGroups();
      renderPermissions();
    }
  });
  document.addEventListener('change', (event) => {
    if (['mode', 'trigger'].includes(event.target.dataset.groupField)) renderGroups();
    if (event.target.dataset.config) renderModules();
    if (event.target.id === 'summary-group') rememberEditor();
  });
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.selectAccount) return withButton(button, () => selectAccount(button.dataset.selectAccount));
    if (button.dataset.page) return navigate(button.dataset.page);
    if (button.dataset.go) {
      if (button.dataset.scenarioGo) selectScenarioTab(button.dataset.scenarioGo);
      return navigate(button.dataset.go);
    }
    if (button.dataset.scenarioTab) return selectScenarioTab(button.dataset.scenarioTab);
    if (button.dataset.recordTab) return selectRecordTab(button.dataset.recordTab);
    if (button.dataset.action && actions[button.dataset.action]) return withButton(button, actions[button.dataset.action]);
    if (button.dataset.moduleAction) return withButton(button, async () => {
      const id = requireAccount();
      const moduleId = button.dataset.module;
      const action = button.dataset.moduleAction;
      if (action === 'stop' && !await openDialog(`停止「${accountName(id)}」QQ 连接组件`, '<p>仅停止这个账号的 NapCat 模块，暂停其收发与采集；配置和记录会保留，其他账号继续运行。</p>', '停止此账号 NapCat')) return;
      await mutate(`/modules/${encodeURIComponent(moduleId)}/${encodeURIComponent(action)}`, {}, '模块任务已提交，请查看此账号执行输出。', id);
    });
    if (button.dataset.removeGroup !== undefined && draft) {
      draft.groups.splice(Number(button.dataset.removeGroup), 1);
      markDirty();
      renderGroups();
      renderPermissions();
    }
  });
  $('#account-selector').addEventListener('change', (event) => withButton(null, () => selectAccount(event.target.value)));
  $('#create-account').addEventListener('click', (event) => withButton(event.currentTarget, createAccount));
  $('#refresh-state').addEventListener('click', (event) => withButton(event.currentTarget, () => refreshState({ notify: true })));
  $('#save-draft').addEventListener('click', (event) => withButton(event.currentTarget, () => saveDraft()));
  $('#apply-config').addEventListener('click', (event) => withButton(event.currentTarget, () => applyConfig()));
  $('#release-permissions').addEventListener('click', (event) => withButton(event.currentTarget, releasePermissions));
  $('#revoke-permissions').addEventListener('click', (event) => withButton(event.currentTarget, async () => {
    const id = requireAccount();
    await mutate('/permissions/revoke', {}, '已恢复只读，后续发送已被后台阻止。其他账号不受影响。', id);
  }));
  $('#discard-draft').addEventListener('click', (event) => withButton(event.currentTarget, async () => {
    const id = requireAccount();
    if (!await openDialog(`丢弃「${accountName(id)}」未保存修改`, '<p>仅恢复这个账号后台已保存的草稿，不改变运行权限，其他账号的输入会保留。</p>', '丢弃此账号未保存输入')) return;
    const next = await accountApi('/state', undefined, 'GET', id);
    acceptState(next, { replaceDraft: true, accountId: id });
    toast(`「${accountName(id)}」已恢复已保存草稿。`);
  }));
  $('#add-group').addEventListener('click', (event) => withButton(event.currentTarget, async () => {
    const id = requireAccount();
    if (!await openDialog(`为「${accountName(id)}」添加选定群`, '<label class="field">群号<input id="new-group-id" inputmode="numeric" pattern="[1-9][0-9]{3,19}" placeholder="请输入数字群号" required></label><label class="field">群名称<input id="new-group-name" placeholder="方便识别的名称"></label><label class="field">群用途<select id="new-group-mode"><option value="work">工作通知群</option><option value="social">社交群</option></select></label><p>接入账号必须已加入该群。默认允许读取、禁止发送；添加群本身不会释放权限。</p>', '加入只读草稿')) return;
    const groupId = $('#new-group-id').value.trim();
    if (!/^[1-9]\d{3,19}$/.test(groupId)) throw new Error('群号应为 4–20 位数字。');
    if ((editors.get(id).draft.groups ?? []).some((group) => group.id === groupId)) throw new Error('这个群已在该账号的草稿中。');
    addDraftGroups(id, [{ id: groupId, name: $('#new-group-name').value.trim(), mode: $('#new-group-mode').value }]);
    toast(`「${accountName(id)}」已加入只读草稿；保存应用后开始采集。`, 'info');
  }));
  $('#setup-install').addEventListener('click', (event) => withButton(event.currentTarget, async () => {
    const id = requireAccount();
    const modules = ['napcat', 'codex'].filter((moduleId) => $(`#setup-${moduleId}`).checked);
    if (!modules.length) throw new Error('请至少选择一个模块。已有原生 NapCat 时无需勾选 NapCat。');
    await mutate('/setup/install', { modules }, '安装任务已提交。NapCat 选项使用 Docker；安装不会自动登录或释放权限。', id);
    if (selectedAccountId === id) navigate('modules');
  }));
  $('#open-napcat').addEventListener('click', (event) => withButton(event.currentTarget, openNapcatGuide));
  $('#export-config').addEventListener('click', (event) => withButton(event.currentTarget, async () => {
    const id = requireAccount();
    if (window.qqBridgeDesktop?.exportConfig) {
      const result = await window.qqBridgeDesktop.exportConfig(id);
      if (result?.canceled) return;
      if (result?.ok !== true) throw new Error(result?.error || '此账号配置导出未完成。');
      return toast(`「${accountName(id)}」已导出脱敏配置，不含密钥和未保存输入。`);
    }
    const config = await accountApi('/config/export', undefined, 'GET', id);
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `QQ_Service-${id}-config-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`「${accountName(id)}」已导出脱敏配置，不含密钥和未保存输入。`);
  }));
  $('#rollback-config').addEventListener('click', (event) => withButton(event.currentTarget, async () => {
    const id = requireAccount();
    if (!await openDialog(`回滚「${accountName(id)}」已应用参数`, '<p>只回滚此账号的运行配置，并恢复只读。当前账号未保存的输入会丢弃，其他账号不受影响。</p><p>已发送消息、历史记录及密钥不随普通配置回滚。</p>', '回滚此账号配置')) return;
    const result = await accountApi('/config/rollback', {}, 'POST', id);
    acceptState(result, { replaceDraft: true, accountId: id });
    toast(`「${accountName(id)}」已返回回滚结果，请检查运行状态和权限。`);
  }));
  $('#preview-policy').addEventListener('click', (event) => withButton(event.currentTarget, async () => {
    const id = requireAccount();
    const messageType = $('#preview-type').value;
    const result = await accountApi('/policy/preview', { userId: $('#preview-user').value.trim(), ...(messageType === 'group' ? { groupId: $('#preview-group').value.trim() } : {}), message: $('#preview-message').value, messageType }, 'POST', id);
    if (id !== selectedAccountId) return toast(`「${accountName(id)}」权限预览完成；请切回该账号重新查看。`, 'info');
    $('#policy-result').textContent = JSON.stringify(result, null, 2);
    $('#policy-result').classList.remove('hidden');
  }));
  $('#preview-type').addEventListener('change', () => { $('#preview-group').disabled = $('#preview-type').value === 'private'; });
  window.addEventListener('beforeunload', (event) => {
    rememberEditor();
    if (![...editors.values()].some((editor) => editor.dirty)) return;
    event.preventDefault();
    event.returnValue = '';
  });
  window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));
  if (window.qqBridgeDesktop?.isDesktop) {
    $('.sidebar-version span').textContent = window.qqBridgeDesktop.version || '0.3.0';
    $('.sidebar-note small').textContent = '各账号独立运行；关闭窗口后留在托盘，退出停止所有后台。';
    $('.page-footer span').textContent = 'QQ_Service · Windows 桌面应用';
    $('.page-footer span:last-child').textContent = '模型授权 ≠ 发送授权 · 关闭窗口留在托盘';
  }
  navigate(location.hash.slice(1));
  renderLiveState();
  refreshState();
  setInterval(() => { if (document.visibilityState === 'visible') refreshState(); }, 4000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshState(); });
})();
