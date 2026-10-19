'use strict';

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const clone = (value) => structuredClone(value);
  const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const pageInfo = {
    overview: ['仪表盘', 'WORKSPACE OVERVIEW', '仪表盘', '多个账号独立运行；先配置模型与任务，再明确释放消息权限。'],
    connections: ['账号', 'ACCOUNT CONTROL', '你的账号，由你配置', '从一份账号配置开始，按步骤连接 QQ、准备模型并明确授权。'],
    scenarios: ['权限', 'SCENARIOS & PERMISSIONS', '为这个账号设置任务与范围', '功能参数决定做什么，群与消息权限决定能读取和发送到哪里。'],
    modules: ['模块', 'MODULE MANAGEMENT', '', ''],
    settings: ['设置', 'APPLICATION SETTINGS', '让应用按你的习惯运行', '关闭窗口的行为可随时修改，所有账号配置保持独立。'],
    records: ['日志', 'ACTIVITY & EVIDENCE', '', '']
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
  let pendingBuilderPage = /^custom-[a-z]{6,24}$/.test(location.hash.slice(1)) ? location.hash.slice(1) : '';
  let currentScenarioTab = 'tasks';
  let dialogResolve = null;
  let consecutiveFailures = 0;
  let codexLoginStatus = null;
  let expandedAccountId = '';
  const setupSteps = [
    ['identity', '账号与来源'], ['models', '模型准备'], ['connection', 'QQ 连接'],
    ['scenarios', '账号任务'], ['permissions', '范围与授权'], ['verification', '验证效果']
  ];
  const groupTriggerOptions = [
    ['mention', '@ 接入账号'], ['prefix', '命令前缀'], ['casual', '低频主动插话'],
    ['poke', '戳一戳'], ['group_name', '修改群名'], ['member_join', '群成员加入'],
    ['member_leave', '群成员退出'], ['admin_change', '管理员变更'], ['mute', '禁言 / 解禁'], ['recall', '撤回消息'], ['group_card', '群名片变化'], ['emoji_like', '消息表情回应']
  ];
  const llmVendors = [
    { id: 'openai', label: 'OpenAI API', url: 'https://api.openai.com/v1', hosts: ['api.openai.com'] },
    { id: 'dashscope', label: '阿里云百炼 / 通义', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', hosts: ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'] },
    { id: 'zhipu', label: '智谱 GLM', url: 'https://open.bigmodel.cn/api/paas/v4', hosts: ['open.bigmodel.cn'] },
    { id: 'kimi', label: 'Kimi / Moonshot', url: 'https://api.moonshot.cn/v1', hosts: ['api.moonshot.cn', 'api.moonshot.ai'] },
    { id: 'siliconflow', label: '硅基流动', url: 'https://api.siliconflow.cn/v1', hosts: ['api.siliconflow.cn'] },
    { id: 'custom', label: '自定义兼容 API', url: 'https://api.example.com/v1', hosts: [] }
  ];
  const accountSetupSteps = new Map();
  const accountFlowVersions = new Map();
  const accountSkippedStages = new Map();
  const layoutAnimations = new WeakMap();
  let renderedFlowAccount = '';
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let customApiStructure = '';
  let activeGroupTriggerPicker = null;
  let groupTriggerPointerState = null;

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
    editors.set(selectedAccountId, { ...previous, state, draft, dirty, editVersion, secretUpdates, codexLoginStatus, profileName: $('#account-profile-name').value, summaryGroup: $('#summary-group').value });
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
  function markDirty(editedElement = document.activeElement) {
    dirty = true;
    editVersion += 1;
    rememberEditor();
    renderConfigBar();
    renderSetupGuide();
    renderAccountDirectory();
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
      const details = Array.isArray(result.details) ? result.details : result.details ? [String(result.details)] : [];
      const error = new Error(result.error || details[0] || `操作失败（HTTP ${response.status}）`);
      const issues = Array.isArray(result.issues) && result.issues.length ? result.issues : result.field ? [{ path: result.field, message: result.error || details[0], action: result.action }] : [];
      Object.assign(error, { code: result.code, details, issues, field: result.field, nextStep: result.nextStep, action: result.action });
      throw error;
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
    closeGroupTriggerPicker();
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
    const requested = page;
    const custom = window.QQServiceBuilder?.getPage(page);
    if (!Object.hasOwn(pageInfo, page) && !custom) page = 'overview';
    if (custom || Object.hasOwn(pageInfo, requested)) pendingBuilderPage = '';
    closeGroupTriggerPicker();
    currentPage = page;
    const [caption, eyebrow, title, description] = custom
      ? [custom.label, 'CUSTOM PAGE', custom.title, custom.description]
      : pageInfo[page];
    $('#page-caption').textContent = caption;
    $('#page-eyebrow').textContent = eyebrow;
    $('#page-title').textContent = title;
    $('#page-description').textContent = description;
    // The records page intentionally has no title or description in this
    // design baseline. Keep shared heading hooks for the other pages.
    $('#page-title').classList.toggle('hidden', !title);
    $('#page-description').classList.toggle('hidden', !description);
    for (const [selector, field] of [['#page-title', 'title'], ['#page-description', 'description'], ['#page-eyebrow', 'eyebrow']]) $(selector).dataset.uiKey = `page.${page}.${field}`;
    $$('.page-panel').forEach((panel) => panel.classList.toggle('hidden', panel.id !== `page-${page}`));
    $$('.nav-link').forEach((link) => {
      link.classList.toggle('active', link.dataset.page === page);
      if (link.dataset.page === page) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    if (location.hash !== `#${page}`) history.replaceState(null, '', `#${page}`);
    renderPageContext();
    renderRuntime();
    window.scrollTo({ top: 0, behavior: 'auto' });
    document.dispatchEvent(new CustomEvent('qq-service-page-change', { detail: { page } }));
  }
  function selectScenarioTab(tab) {
    closeGroupTriggerPicker();
    currentScenarioTab = tab === 'permissions' ? 'permissions' : 'tasks';
    $$('.scenario-tab').forEach((button) => {
      const selected = button.dataset.scenarioTab === currentScenarioTab;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', String(selected));
    });
    $$('.scenario-content').forEach((panel) => panel.classList.toggle('hidden', panel.id !== `scenario-${currentScenarioTab}`));
  }
  function populateForm() {
    $('#account-profile-name').value = editors.get(selectedAccountId)?.profileName ?? accountName();
    renderLlmSelector();
    renderCustomApis();
    renderProviderOptions();
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
    renderProviderOptions();
    renderGroups();
  }
  function accountOnlineState(account) {
    const editor = editors.get(account.id);
    const runtime = account.id === selectedAccountId ? state?.runtime ?? account.runtime ?? {} : account.runtime ?? editor?.state?.runtime ?? {};
    const applied = editor?.state?.applied;
    const actual = String(runtime.accountId ?? runtime.qq?.accountId ?? '');
    const expected = String(account.appliedQQ ?? applied?.botQQ ?? '');
    const configured = String(editor?.draft?.botQQ ?? account.qqNumber ?? '');
    if (runtime.issue?.code === 'QQ_IDENTITY_MISMATCH' || runtime.connected === true && actual && expected && actual !== expected) return { status: 'mismatch', label: '身份不匹配' };
    if (runtime.connected !== true) return { status: 'offline', label: '离线' };
    const localConnectionChanged = editor && (String(editor.draft?.botQQ ?? '') !== expected || ['enabled', 'wsUrl'].some((key) => editor.draft?.qq?.[key] !== applied?.qq?.[key]) || Boolean(editor.secretUpdates?.napcatToken));
    return actual && expected && actual === expected && configured === expected && !localConnectionChanged ? { status: 'online', label: '在线' } : { status: 'unverified', label: '待验证' };
  }
  function accountOnlineBadge(online) {
    return `<span class="account-online-badge account-online-${online.status}" data-account-online="${online.status}" data-ui-protected><span aria-hidden="true"></span>${online.label}</span>`;
  }
  function renderAccountDirectory() {
    const selector = $('#account-selector');
    const previous = selector.value;
    const options = accounts.length ? accounts.map((account) => `<option value="${escapeHTML(account.id)}">${escapeHTML(account.name || account.qqNumber || 'QQ 账号')} · ${escapeHTML(account.qqNumber || '待填写 QQ')}</option>`).join('') : '<option value="">尚无账号</option>';
    if (selector.innerHTML !== options) selector.innerHTML = options;
    selector.value = accounts.some((account) => account.id === selectedAccountId) ? selectedAccountId : previous;
    selector.disabled = accounts.length === 0;
    const empty = '<div class="empty-state"><strong>尚无账号配置</strong>在账号控制中完成接入后，这里会显示各账号的状态。</div>';
    const cards = accounts.map((account) => {
      const runtime = account.runtime ?? {};
      const online = accountOnlineState(account);
      const connected = online.status === 'online';
      const released = account.permissions?.released === true;
      const editor = editors.get(account.id);
      return { account, online, connected, released, note: editor?.dirty ? ' · 有未保存修改' : account.pendingChanges ? ' · 参数待应用' : '' };
    });
    const overviewHTML = cards.length ? cards.map(({ account, online, connected, released, note }) => `<button class="account-card ${account.id === selectedAccountId ? 'selected' : ''}" data-select-account="${escapeHTML(account.id)}" data-ui-text-protected><span class="account-avatar">Q</span><span class="account-card-main"><strong class="account-name-line"><span data-ui-protected>${escapeHTML(account.name || 'QQ 账号')}</span>${accountOnlineBadge(online)}</strong><small data-ui-protected>QQ ${escapeHTML(account.qqNumber || '待填写')} · ${connected ? '身份已验证' : '未确认连接'}${note}</small></span><span data-ui-protected class="pill ${released ? 'pill-green' : 'pill-neutral'}">${released ? '已释放范围权限' : '只读'}</span></button>`).join('') : empty;
    renderAccountAccordions(cards);
    updateRecordHTML($('#overview-accounts'), overviewHTML);
    $('#page-connections').classList.toggle('directory-empty', accounts.length === 0);

    renderPageContext();
    const appliedReleased = state?.applied?.permissions?.released === true;
    $('#account-permission-badge').textContent = selectedAccountId ? appliedReleased ? '已释放范围权限' : '只读 · 未释放发送' : '未选择账号';
    $('#account-permission-badge').className = `pill ${appliedReleased ? 'pill-green' : 'pill-neutral'}`;
  }
  // Keep each header and the editor DOM stable while status polling updates its text.
  // The single editor moves between account bodies; drafts and secrets remain profile-scoped.
  function animateLayout(element, from, to, { onFinish, duration = 260 } = {}) {
    layoutAnimations.get(element)?.cancel();
    layoutAnimations.delete(element); element.classList.remove('layout-animating');
    if (reducedMotion() || currentPage !== 'connections' || Math.abs(to - from) < 1) {
      onFinish?.(); return;
    }
    const animation = element.animate([{ height: `${from}px`, opacity: from === 0 ? 0 : 1 }, { height: `${to}px`, opacity: to === 0 ? 0 : 1 }], { duration, easing: 'cubic-bezier(.2,.7,.2,1)' });
    layoutAnimations.set(element, animation);
    element.classList.add('layout-animating');
    animation.finished.then(() => {
      if (layoutAnimations.get(element) !== animation) return;
      layoutAnimations.delete(element); element.classList.remove('layout-animating'); onFinish?.();
    }).catch(() => {});
  }
  function setAccordionOpen(body, open, previousHeight) {
    if (body.dataset.open === String(open)) return;
    const before = previousHeight ?? body.getBoundingClientRect().height;
    body.dataset.open = String(open);
    body.inert = !open;
    body.setAttribute('aria-hidden', String(!open));
    body.style.height = open ? 'auto' : '0px';
    const after = open ? body.scrollHeight : 0;
    animateLayout(body, before, after);
    // Reopening an account also reveals its existing child menu, rather than
    // snapping already configured sections back into view.
    $$('.setup-flow-content', body).forEach((content, index) => {
      layoutAnimations.get(content)?.cancel(); layoutAnimations.delete(content);
      if (!open || content.parentElement.inert || reducedMotion() || currentPage !== 'connections') return;
      const animation = content.animate([{ opacity: 0, transform: 'translateY(-5px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 240, delay: Math.min(index, 5) * 22, easing: 'ease-out', fill: 'backwards' });
      layoutAnimations.set(content, animation);
      animation.finished.then(() => { if (layoutAnimations.get(content) === animation) layoutAnimations.delete(content); }).catch(() => {});
    });
  }
  function renderAccountAccordions(cards) {
    const directory = $('#account-cards');
    const workspace = $('#account-workspace');
    const targetId = expandedAccountId === selectedAccountId && state ? expandedAccountId : '';
    const liveIds = new Set(cards.map(({ account }) => account.id));
    for (const old of [...directory.children]) {
      if (liveIds.has(old.dataset.accountId)) continue;
      if (old.contains(workspace)) $('#account-workspace-parking').append(workspace);
      old.remove();
    }
    const previousBody = workspace.closest('.account-accordion-body');
    const previousHeight = previousBody?.getBoundingClientRect().height;
    for (const { account, online, connected, released, note } of cards) {
      let entry = [...directory.children].find((element) => element.dataset.accountId === account.id);
      if (!entry) {
        entry = document.createElement('article');
        entry.className = 'account-accordion'; entry.dataset.accountId = account.id; entry.dataset.uiKey = 'account.menuCard';
        const header = document.createElement('button'); header.type = 'button';
        header.className = 'account-card account-entry'; header.dataset.openAccount = account.id;
        header.dataset.uiKey = 'account.menuHeader'; header.setAttribute('data-ui-text-protected', '');
        header.id = `account-header-${account.id}`; header.setAttribute('aria-controls', `account-body-${account.id}`);
        const body = document.createElement('div'); body.className = 'account-accordion-body';
        body.id = `account-body-${account.id}`; body.setAttribute('role', 'region');
        body.setAttribute('aria-labelledby', header.id); body.dataset.open = 'false'; body.inert = true;
        body.setAttribute('aria-hidden', 'true'); body.style.height = '0px';
        entry.append(header, body); directory.append(entry);
      }
      const open = account.id === targetId;
      const header = entry.firstElementChild;
      const headerHTML = `<span class="account-avatar">Q</span><span class="account-card-main"><strong class="account-name-line"><span data-ui-protected>${escapeHTML(account.name || 'QQ 账号')}</span>${accountOnlineBadge(online)}</strong><small data-ui-protected>QQ ${escapeHTML(account.qqNumber || '待填写')} · ${connected ? '登录身份已验证' : '接入尚未完成'}${note}</small></span><span data-ui-protected class="pill ${released ? 'pill-green' : 'pill-neutral'}">${released ? '已授权指定范围' : '默认只读'}</span><span class="account-entry-chevron" aria-hidden="true">⌄</span>`;
      if (header.innerHTML !== headerHTML) header.innerHTML = headerHTML;
      header.classList.toggle('expanded', open); header.setAttribute('aria-expanded', String(open));
      entry.classList.toggle('expanded', open);
      const body = entry.lastElementChild;
      if (open && workspace.parentElement !== body) {
        body.append(workspace);
      }
      if (open) workspace.classList.remove('hidden');
      setAccordionOpen(body, open, body === previousBody ? previousHeight : undefined);
    }
    if (!targetId && !previousBody) workspace.classList.add('hidden');
  }
  function renderConfigBar() {
    const pending = Boolean(state?.pendingChanges || state?.secretsPendingChanges);
    $('#config-indicator').className = `config-indicator ${dirty || pending ? 'pending' : state ? 'clean' : ''}`;
    $('#config-label').textContent = !state ? '请先创建或选择账号' : dirty ? '此账号有尚未保存的修改' : pending ? '此账号已保存，等待应用' : '此账号参数已同步';
    $('#config-detail').textContent = !state ? '每个账号分别管理已保存配置和运行参数' : `${accountName()} · 已保存版本 ${state.revision ?? '—'} / 已应用 ${state.appliedRevision ?? '—'}${dirty ? ' · 输入仅在此页面' : state.secretsPendingChanges ? ' · 凭据待应用' : ''} · 应用参数后恢复只读`;
    $('#discard-draft').disabled = !dirty;
    $('#save-draft').disabled = !state || !dirty;
    $('#apply-config').disabled = !state || (!dirty && !pending);
    $('#release-permissions').disabled = !state;
    $('#reset-account-defaults').disabled = !state;
    $('#revoke-permissions').disabled = !state || state.applied?.permissions?.released !== true;
    $$('[data-action], [data-module-action], #add-group, #open-napcat, #export-config, #rollback-config, #preview-policy').forEach((button) => { button.disabled = !state; });
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
    $('#runtime-badge').textContent = currentPage === 'overview' ? `${accounts.length} 个账号 · ${accounts.filter((account) => account.runtime?.connected === true || account.runtime?.connectionState === 'connected').length} 个已连接` : selectedAccountId ? `${accountName()} · ${label}` : '尚无账号';
    $('#runtime-badge').className = `heading-status ${color === 'green' ? 'connected' : color === 'red' ? 'error' : ''}`;
    $('#runtime-badge').classList.toggle('hidden', currentPage === 'settings' || Boolean(window.QQServiceBuilder?.getPage(currentPage)));
    $('#account-codex-status').textContent = auth?.message || (auth?.loggedIn === true ? '此账号的官方 Codex 已授权' : auth?.loggedIn === false ? '此账号尚未登录 Codex' : '此账号授权状态等待检查');
    $('#runtime-status').innerHTML = checkRow('QQ 实际连接', actualAccount ? `后台确认 QQ ${actualAccount}` : `尚未确认实际登录 QQ${configuredAccount ? `；配置 QQ ${configuredAccount}` : ''}`, qqStatus)
      + checkRow('消息发送权限', released ? `已释放 · ${writable} 个满足任务条件的发送群 · 私聊${state?.applied?.permissions?.privateReplies ? '已授权指定接收 QQ' : '未授权'}` : '只读：不会因连接 QQ 或登录模型而发送消息', released ? 'ready' : 'disabled')
      + checkRow('Codex 订阅授权', auth?.message ?? '请在账号控制中检查此账号的官方 CLI 授权', auth?.loggedIn === true ? 'logged_in' : auth?.loggedIn === false ? 'waiting_login' : 'unknown');
    $('#runtime-details').textContent = JSON.stringify(runtime, null, 2);
    const connectedAccounts = accounts.filter((account) => account.runtime?.connected === true || account.runtime?.connectionState === 'connected').length;
    const stats = [
      ['账号总数', accounts.length, `${connectedAccounts} 个账号已连接 · 可同时运行`, '⇄', 'accounts'],
      ['当前账号权限', released ? '已释放' : '只读', selectedAccountId ? `${accountName()} · ${released ? '已授权指定范围' : '未释放发送权限'}` : '尚未选择账号', '◎', 'permissions'],
      ['当前账号可读群', readable, `${sendTargets} 个群已选择发送权限`, '▤', 'groups'],
      ['当前账号整理记录', Array.isArray(state?.summaries) ? state.summaries.length : 0, '通知与收藏均可核对原文依据', '≡', 'summaries']
    ];
    const statsHTML = stats.map(([name, value, note, icon, destination]) => `<button type="button" class="stat-card" data-ui-key="overview.stat.${destination}" data-overview-go="${destination}" ${destination !== 'accounts' && !state ? 'disabled' : ''}><span><span class="stat-label" data-ui-key="overview.statLabel.${destination}">${escapeHTML(name)}</span><span class="stat-value" data-ui-protected>${escapeHTML(value)}</span><span class="stat-note" data-ui-protected>${escapeHTML(note)}</span></span><span class="stat-icon" aria-hidden="true">${icon}</span></button>`).join('');
    updateRecordHTML($('#overview-stats'), statsHTML);
  }
  function renderPermissions() {
    const applied = state?.applied;
    const released = applied?.permissions?.released === true;
    const read = applied?.groups?.filter((group) => group.read === true) ?? [];
    const send = applied?.groups?.filter((group) => group.send === true) ?? [];
    $('#permissions-status').textContent = !state ? '未选择账号' : released ? '后台已释放范围权限' : '后台只读 · 未释放发送';
    $('#permissions-status').className = `pill ${released ? 'pill-green' : 'pill-neutral'}`;
    $('#permissions-applied-summary').textContent = !state ? '请先创建并选择账号。' : `${accountName()}：已应用 ${read.length} 个可读群，${send.length} 个待发送目标；${released ? '账号发送权限已释放' : '账号发送总开关关闭'}。私聊${applied?.permissions?.privateReplies && applied?.ownerQQ ? `仅指定 QQ ${applied.ownerQQ}` : '未授权'}。${state?.pendingChanges || dirty ? '下方还有配置修改，尚未成为运行权限。' : ''}`;
  }
  function effectiveTriggers(group) {
    return Array.isArray(group.triggers) ? group.triggers : [group.trigger || 'mention'];
  }
  function renderGroups() {
    const groups = draft?.groups ?? [];
    const html = groups.length ? groups.map((group, index) => {
      const triggers = effectiveTriggers(group);
      return `<tr data-group-index="${index}"><td><input data-group-field="name" value="${escapeHTML(group.name)}" aria-label="群名称"><input class="group-id" data-group-field="id" value="${escapeHTML(group.id)}" inputmode="numeric" aria-label="QQ群号"></td><td><select data-group-field="mode" aria-label="群用途"><option value="social" ${group.mode !== 'work' ? 'selected' : ''}>社交群</option><option value="work" ${group.mode === 'work' ? 'selected' : ''}>工作通知群</option></select><small class="field-note">${group.mode === 'work' ? '可用于通知汇总' : '按聊天功能参数处理'}</small></td><td><details class="group-trigger-picker" data-record-id="triggers:${escapeHTML(group.id || index)}"><summary aria-haspopup="dialog" aria-controls="group-trigger-panel-${index}" aria-expanded="false">${triggers.length ? `已选择 ${triggers.length} 项触发事件` : '尚未选择触发事件'}</summary><div id="group-trigger-panel-${index}" class="group-trigger-panel" popover="auto" role="dialog" aria-label="${escapeHTML(group.name || group.id || `第 ${index + 1} 个群`)}的触发事件"><div class="group-trigger-tools"><button type="button" data-group-triggers-all="${index}">全选</button><button type="button" data-group-triggers-clear="${index}">全部取消</button></div><div class="group-trigger-options" role="group" aria-label="选择触发事件">${groupTriggerOptions.map(([id,label]) => `<label><input type="checkbox" data-group-trigger="${id}" ${triggers.includes(id) ? 'checked' : ''}><span>${label}</span></label>`).join('')}</div><p>只处理当前群实际收到的事件；全选也需发送授权，概率及冷却仍生效。群名变更取决于 NapCat 是否上报。</p></div></details></td><td><div class="group-parameter">${triggers.includes('prefix') ? `<label>前缀 <input data-group-field="prefix" value="${escapeHTML(group.prefix ?? '/ai')}" aria-label="命令前缀"></label>` : ''}${triggers.includes('casual') ? `<label>插话概率 <input type="number" data-group-field="probability" min="0" max="0.25" step="0.01" value="${escapeHTML(group.probability ?? 0.03)}" aria-label="插话概率"></label>` : ''}<label>冷却秒 <input type="number" data-group-field="cooldownSeconds" min="5" max="3600" value="${escapeHTML(group.cooldownSeconds ?? 30)}" aria-label="冷却秒数"></label></div></td><td><label class="group-permission-check"><input type="checkbox" data-group-field="read" ${group.read === true ? 'checked' : ''}>允许读取</label><label class="group-permission-check"><input type="checkbox" data-group-field="send" ${group.send === true ? 'checked' : ''} ${group.read === true ? '' : 'disabled title="先允许读取，才能授权回复"'}>允许发送</label><small class="field-note">仍需启动并确认授权范围</small></td><td><button class="remove-group" data-remove-group="${index}" aria-label="移除 ${escapeHTML(group.name || group.id)}">×</button></td></tr>`;
    }).join('') : '<tr><td colspan="6"><div class="empty-state"><strong>添加这个账号允许处理的 QQ 群</strong>新群默认允许读取、禁止发送；选择触发事件后，最后确认启动。</div></td></tr>';
    const rows = $('#group-rows');
    if (rows.dataset.renderedHTML === html) return;
    const previous = activeGroupTriggerPicker;
    const focused = document.activeElement;
    let focusSelector = previous?.summary === focused ? 'summary' : null;
    if (previous?.panel.contains(focused)) {
      if (focused.dataset.groupTrigger) focusSelector = `[data-group-trigger="${focused.dataset.groupTrigger}"]`;
      else if (focused.hasAttribute('data-group-triggers-all')) focusSelector = '[data-group-triggers-all]';
      else if (focused.hasAttribute('data-group-triggers-clear')) focusSelector = '[data-group-triggers-clear]';
    }
    const scrollTop = previous?.panel.scrollTop ?? 0;
    closeGroupTriggerPicker();
    updateRecordHTML(rows, html);
    // A checkbox changes both its summary and optional parameter fields. Keep the
    // same account/group's open panel usable instead of losing keyboard focus.
    if (previous?.accountId === selectedAccountId && groups[previous.index] && String(groups[previous.index].id ?? '') === previous.groupId) {
      const picker = $(`[data-group-index="${previous.index}"] .group-trigger-picker`, rows);
      if (picker) openGroupTriggerPicker(picker, { focusSelector, scrollTop });
    }
  }
  function closeGroupTriggerPicker({ restoreFocus = false } = {}) {
    const previous = activeGroupTriggerPicker;
    if (!previous) return;
    activeGroupTriggerPicker = null;
    if (previous.panel.matches(':popover-open')) previous.panel.hidePopover();
    previous.picker.open = false;
    previous.summary.setAttribute('aria-expanded', 'false');
    if (restoreFocus && previous.summary.isConnected) previous.summary.focus({ preventScroll: true });
  }
  function positionGroupTriggerPicker() {
    const active = activeGroupTriggerPicker;
    if (!active) return;
    const anchor = active.summary.getBoundingClientRect();
    const margin = 10;
    const gap = 6;
    const width = document.documentElement.clientWidth;
    const height = window.innerHeight;
    if (!active.summary.isConnected || !anchor.width || !anchor.height || anchor.bottom <= 0 || anchor.top >= height || anchor.right <= 0 || anchor.left >= width) return closeGroupTriggerPicker();
    active.panel.style.width = `${Math.max(0, Math.min(Math.max(anchor.width, 270), 340, width - margin * 2))}px`;
    active.panel.style.maxHeight = `${Math.max(0, Math.min(420, height - margin * 2))}px`;
    const below = height - anchor.bottom - gap - margin;
    const above = anchor.top - gap - margin;
    const down = below >= active.panel.offsetHeight || below >= above;
    active.panel.style.maxHeight = `${Math.max(0, Math.min(420, down ? below : above))}px`;
    const left = Math.max(margin, Math.min(anchor.left, width - active.panel.offsetWidth - margin));
    const top = down ? anchor.bottom + gap : anchor.top - gap - active.panel.offsetHeight;
    active.panel.style.left = `${left}px`;
    active.panel.style.top = `${Math.max(margin, Math.min(top, height - active.panel.offsetHeight - margin))}px`;
    active.anchorPosition = { left: anchor.left, top: anchor.top };
  }
  function openGroupTriggerPicker(picker, { focusSelector = null, scrollTop = 0 } = {}) {
    closeGroupTriggerPicker();
    const summary = $('summary', picker);
    const panel = $('.group-trigger-panel', picker);
    const index = Number(picker.closest('[data-group-index]').dataset.groupIndex);
    picker.open = true;
    summary.setAttribute('aria-expanded', 'true');
    activeGroupTriggerPicker = { picker, summary, panel, index, accountId: selectedAccountId, groupId: String(draft?.groups[index]?.id ?? '') };
    // Native top-layer rendering escapes the table's horizontal overflow clip.
    // Auto popovers also dismiss on outside clicks and allow only one at a time.
    panel.showPopover({ source: summary });
    positionGroupTriggerPicker();
    const focused = focusSelector === 'summary' ? summary : focusSelector ? $(focusSelector, panel) : null;
    if (focused) focused.focus({ preventScroll: true });
    panel.scrollTop = scrollTop;
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
      return `<article class="module-card ${builtin ? 'builtin' : 'external'}"><div class="module-main"><div class="module-top"><span class="module-icon">${definition.icon}</span>${builtin ? `<span class="pill ${enabled ? 'pill-green' : 'pill-neutral'}">${enabled ? '此账号配置已启用' : '内置 · 尚未启用'}</span>` : pill(actualStatus)}</div><h2>${escapeHTML(definition.name)}</h2><p>${escapeHTML(definition.description)}</p><div class="module-version">${builtin ? '启用功能仍受账号与消息权限约束' : module ? `版本 ${escapeHTML(module.version || '未提供')} · ${module.installed ? '已安装' : '未确认安装'}` : '等待此账号的模块检查结果'}</div></div><div class="module-actions">${actions}</div></article>`;
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
    updateRecordHTML($('#setup-codex-jobs'), jobsHTML(jobs.filter((job) => /codex|GPT|授权|设备|login/i.test([job.type, job.name, job.label, job.title].filter(Boolean).join(' '))).slice(0, 3)));
    updateRecordHTML($('#setup-connection-jobs'), jobsHTML(jobs.filter((job) => /napcat|setup-install|安装所选模块/i.test([job.type, job.name, job.label, job.title].filter(Boolean).join(' '))).slice(0, 3)));
    updateRecordHTML($('#all-jobs'), jobsHTML(jobs));
  }
  function updateRecordHTML(element, html) {
    if (!element) return;
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
    if (!$('#favorite-records')) return;
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
  function renderPageContext() {
    const isCustomPage = Boolean(window.QQServiceBuilder?.getPage(currentPage));
    const isAccountPage = currentPage === 'connections' || currentPage === 'settings';
    const context = $('.account-context');
    if (currentPage === 'records') {
      if (context.parentElement !== $('#records-context-card')) $('#records-context-slot').after(context);
    } else if (context.previousElementSibling !== $('#global-account-slot')) $('#global-account-slot').after(context);
    $('.page-heading').classList.toggle('hidden', isAccountPage);
    $('.account-context').classList.toggle('hidden', isAccountPage || isCustomPage || currentPage === 'overview');
    const configBar = $('.config-bar');
    if (currentPage === 'connections') {
      if (configBar.parentElement !== $('#account-workspace')) $('#account-workspace').append(configBar);
    } else if (configBar.previousElementSibling !== $('#global-config-slot')) {
      $('#global-config-slot').after(configBar);
    }
    $('#reset-account-defaults').classList.toggle('hidden', currentPage !== 'modules');
    configBar.classList.toggle('hidden', isCustomPage || currentPage === 'records' || currentPage === 'overview' || currentPage === 'settings' || (currentPage === 'connections' && (!expandedAccountId || !state)));
    $('#no-accounts').classList.toggle('hidden', accounts.length !== 0 || isAccountPage || isCustomPage);
    $('#runtime-badge').classList.toggle('hidden', currentPage === 'settings' || isCustomPage);
  }
  function scrollToFlowStage(step) {
    if (currentPage !== 'connections' || expandedAccountId !== selectedAccountId) return;
    const accountId = selectedAccountId;
    const section = $(`[data-flow-stage="${step}"]`);
    if (!section || section.classList.contains('hidden')) return;
    requestAnimationFrame(() => {
      if (currentPage !== 'connections' || selectedAccountId !== accountId || expandedAccountId !== accountId) return;
      const bounds = section.getBoundingClientRect();
      const topInset = $('.topbar').getBoundingClientRect().height + 18;
      if (bounds.top < topInset || bounds.top > window.innerHeight * .72) window.scrollBy({ top: bounds.top - topInset, behavior: reducedMotion() ? 'auto' : 'smooth' });
    });
  }
  function flowVersion(accountId = selectedAccountId) { return accountFlowVersions.get(accountId) ?? 0; }
  function setSetupStep(step, { scroll = true, accountId = selectedAccountId, expectedFlowVersion, focus = false } = {}) {
    const index = setupSteps.findIndex(([id]) => id === step);
    if (index < 0 || !accountId) return;
    // Navigation is deliberately independent of readiness. A status refresh or
    // late save/connect result must not reopen sections the user just closed.
    if (expectedFlowVersion !== undefined && flowVersion(accountId) !== expectedFlowVersion) return;
    accountSetupSteps.set(accountId, step);
    accountFlowVersions.set(accountId, flowVersion(accountId) + 1);
    if (accountId !== selectedAccountId) return;
    renderSetupGuide({ animate: true });
    if (scroll) scrollToFlowStage(step);
    if (focus) requestAnimationFrame(() => {
      if (selectedAccountId !== accountId || accountSetupSteps.get(accountId) !== step) return;
      $(`[data-flow-stage="${step}"] .setup-stage-actions > button:not(.hidden):not(:disabled)`)?.focus({ preventScroll: true });
    });
  }
  function apiVendorGuide(baseUrl) {
    const links = {
      'api.deepseek.com': ['DeepSeek', 'https://api-docs.deepseek.com/zh-cn/'],
      'api.openai.com': ['OpenAI', 'https://developers.openai.com/api/docs/'],
      'dashscope.aliyuncs.com': ['阿里云百炼', 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope'],
      'dashscope-intl.aliyuncs.com': ['阿里云百炼', 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope'],
      'open.bigmodel.cn': ['智谱', 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction'],
      'api.moonshot.cn': ['Kimi / Moonshot', 'https://platform.moonshot.cn/docs/guide/start-using-kimi-api'],
      'api.siliconflow.cn': ['硅基流动', 'https://docs.siliconflow.cn/cn/userguide/quickstart']
    };
    try { return links[new URL(baseUrl).hostname] ?? null; } catch { return null; }
  }
  function configuredProviders(config = draft) {
    if (!config) return [];
    return [
      ...(config.models?.deepseek?.enabled ? [{ id: 'deepseek', label: 'DeepSeek', config: config.models.deepseek, secret: 'deepseekApiKey' }] : []),
      ...(config.models?.apis ?? []).filter((item) => item.enabled).map((item) => ({ id: item.id, label: item.label || '自定义 API', config: item, secret: `apiKey:${item.id}` })),
      ...(config.models?.codex?.enabled ? [{ id: 'codex', label: 'ChatGPT / Codex', config: config.models.codex }] : [])
    ];
  }
  function vendorForApi(entry) {
    try { const host = new URL(entry.baseUrl).hostname; return llmVendors.find((vendor) => vendor.hosts.includes(host))?.id ?? 'custom'; } catch { return 'custom'; }
  }
  function chooseSingleLlm(config, selection) {
    config.models.apis ??= [];
    let provider = selection;
    if (selection.startsWith('vendor:')) {
      const vendorId = selection.slice(7);
      const vendor = llmVendors.find((entry) => entry.id === vendorId);
      if (!vendor) throw new Error('请选择列表中的模型来源。');
      let entry = config.models.apis.find((item) => vendorForApi(item) === vendorId);
      if (!entry) {
        if (config.models.apis.length >= 20) throw new Error('此账号已保存 20 个兼容接口，请选择一个已保存配置。');
        entry = { id: `api_${crypto.randomUUID()}`, label: vendor.label, enabled: false, baseUrl: vendor.url, model: '', maxTokens: 1024, temperature: .7 };
        config.models.apis.push(entry);
      }
      provider = entry.id;
    }
    if (provider && !['deepseek', 'codex'].includes(provider) && !config.models.apis.some((item) => item.id === provider)) throw new Error('所选模型配置已不存在，请重新选择。');
    config.models.deepseek.enabled = provider === 'deepseek';
    config.models.codex.enabled = provider === 'codex';
    config.models.apis.forEach((entry) => { entry.enabled = entry.id === provider; });
    if (provider) for (const task of ['chat', 'summary', 'favorites']) config[task].provider = provider;
    return provider;
  }
  function assertLlmChoice(config) {
    const providers = configuredProviders(config);
    if (providers.length > 1) throw Object.assign(new Error('这份旧配置启用了多个模型。请在账号控制明确选择一个模型，再保存或应用。'), { nextStep: 'identity' });
    if (!providers.length && ['chat', 'summary', 'favorites'].some((task) => config[task]?.enabled)) throw Object.assign(new Error('请先选择一个模型来源，或关闭已启用的账号任务后再应用。'), { nextStep: 'identity' });
    return providers[0];
  }
  function taskModelNeedsSync(config) {
    const provider = assertLlmChoice(config);
    return provider && ['chat', 'summary', 'favorites'].some((task) => config[task]?.provider !== provider.id);
  }
  function renderLlmSelector() {
    const select = $('#account-llm-source');
    const providers = configuredProviders();
    const entries = draft?.models?.apis ?? [];
    const options = [{ value: '', label: providers.length > 1 ? '旧配置启用了多个模型，请明确选择一个' : '请选择一个模型来源' }, { value: 'deepseek', label: 'DeepSeek API', key: 'deepseek' }];
    const used = new Set();
    for (const vendor of llmVendors) {
      const matching = entries.filter((entry) => vendorForApi(entry) === vendor.id);
      const first = matching[0];
      options.push({ value: first?.id ?? `vendor:${vendor.id}`, label: first ? `${vendor.label} · ${first.label}` : vendor.label, key: vendor.id });
      if (first) used.add(first.id);
    }
    for (const entry of entries) if (!used.has(entry.id)) options.push({ value: entry.id, label: `已保存 · ${entry.label}` });
    options.push({ value: 'codex', label: 'ChatGPT 订阅 / Codex', key: 'codex' });
    const html = options.map((option) => `<option value="${escapeHTML(option.value)}" ${option.key ? `data-ui-option-key="${option.key}"` : 'data-ui-protected'} ${option.value === '' ? 'disabled' : ''}>${escapeHTML(option.label)}</option>`).join('');
    if (select.innerHTML !== html) select.innerHTML = html;
    select.value = providers.length === 1 ? providers[0].id : '';
    select.disabled = !draft;
    $('#legacy-model-warning').classList.toggle('hidden', providers.length <= 1);
  }
  function renderProviderOptions() {
    const providers = configuredProviders();
    const chosen = providers.length === 1 ? providers[0] : null;
    $$('select[data-config$=".provider"]').forEach((select) => {
      const current = getPath(draft, select.dataset.config) ?? select.value;
      const available = chosen ? [chosen, ...(current && current !== chosen.id ? [{ id: current, label: `原配置：${providerLabel(current)}（保存后统一）` }] : [])] : [{ id: current || '', label: providers.length > 1 ? '请先在账号控制选择一个模型' : '尚未选择模型' }];
      const html = available.map((entry) => `<option value="${escapeHTML(entry.id)}">${escapeHTML(entry.label)}</option>`).join('');
      if (select.innerHTML !== html) select.innerHTML = html;
      select.value = current;
      select.disabled = true;
      select.setAttribute('aria-description', '任务统一使用账号控制中选择的模型。');
    });
  }
  function renderCustomApis() {
    const entries = draft?.models?.apis ?? [];
    const active = configuredProviders().length === 1 ? configuredProviders()[0].id : '';
    const structure = `${selectedAccountId}:${entries.map((entry) => entry.id).join(',')}`;
    if (customApiStructure !== structure) {
      customApiStructure = structure;
      $('#custom-api-cards').innerHTML = entries.map((entry, index) => `<section class="card custom-api-card hidden" data-api-card="${escapeHTML(entry.id)}" data-api-id="${escapeHTML(entry.id)}" data-ui-key="account.apiForm"><div class="section-heading"><div><h2 data-ui-protected>${escapeHTML(entry.label || '兼容 API')}</h2><p data-ui-key="account.apiFormNote">密钥属于当前账号。切换来源会保留此配置，留空会保留已保存密钥。</p></div></div><div class="form-grid"><label class="field">接口名称<input data-ui-protected data-config="models.apis.${index}.label" value="${escapeHTML(entry.label)}" maxlength="80" placeholder="例如：OpenAI 工作助手"></label><label class="field">模型名称<input data-ui-protected data-config="models.apis.${index}.model" value="${escapeHTML(entry.model)}" spellcheck="false" placeholder="以服务商文档中的模型 ID 为准"></label><label class="field field-wide">API 地址<input data-ui-protected data-config="models.apis.${index}.baseUrl" value="${escapeHTML(entry.baseUrl)}" placeholder="https://api.example.com/v1" spellcheck="false"><small>需要兼容 OpenAI Chat Completions 的 HTTPS 接口；不是服务商聊天网页。</small></label><label class="field field-wide">API Key <small class="api-secret-note" data-ui-protected></small><input data-ui-protected type="password" data-secret="apiKey:${escapeHTML(entry.id)}" autocomplete="new-password" value="${escapeHTML(secretUpdates[`apiKey:${entry.id}`] || '')}" placeholder="粘贴此服务商 API Key"></label><label class="field">最大输出 Token<input data-ui-protected type="number" min="128" max="131072" data-config="models.apis.${index}.maxTokens" value="${escapeHTML(entry.maxTokens ?? 1024)}"></label><label class="field">Temperature<input data-ui-protected type="number" min="0" max="2" step="0.1" data-config="models.apis.${index}.temperature" value="${escapeHTML(entry.temperature ?? 0.7)}"></label></div><div class="api-vendor-guide" data-api-guide></div><div class="card-actions"><button class="button button-secondary" data-setup-model-test="${escapeHTML(entry.id)}" data-ui-key="account.testApi"><span>保存并测试此 API · 可能产生费用</span></button></div></section>`).join('');
    }
    $$('[data-api-card]').forEach((card) => card.classList.toggle('hidden', card.dataset.apiCard !== active));
  }
  async function saveAccountProfile() {
    const id = requireAccount();
    const name = $('#account-profile-name').value.trim();
    if (!name || name.length > 80) throw new Error('配置名称需要填写 1–80 个字符。');
    const editor = editors.get(id);
    editor.profileName = $('#account-profile-name').value;
    const sentName = editor.profileName;
    const result = await accountApi('/profile', { name }, 'POST', id);
    if (editors.get(id)?.profileName === sentName) editors.get(id).profileName = name;
    acceptState(result, { accountId: id });
    toast(`「${name}」名称已保存；运行模型与权限保持原状。`);
  }
  function authStatus() {
    return state?.codexAuth?.loggedIn !== undefined && state?.codexAuth?.loggedIn !== null ? state.codexAuth : codexLoginStatus;
  }
  function modelEvidence(provider) {
    if (provider.id === 'codex') return JSON.stringify(provider.config) !== JSON.stringify(state?.applied?.models?.codex) ? ['订阅模型参数尚未应用，授权状态仍可在下方检查', 'pending'] : authStatus()?.loggedIn === true ? ['官方 CLI 已确认授权', 'logged_in'] : ['尚未确认官方订阅授权', 'waiting_login'];
    if (secretUpdates[provider.secret]) return ['密钥已修改，需要保存并重新测试', 'pending'];
    const appliedProvider = provider.id === 'deepseek' ? state?.applied?.models?.deepseek : state?.applied?.models?.apis?.find((entry) => entry.id === provider.id);
    if (JSON.stringify(provider.config) !== JSON.stringify(appliedProvider)) return ['模型参数尚未应用，需要保存并实际测试', 'pending'];
    const evidence = state?.setup?.models?.providers?.find((entry) => entry.id === provider.id);
    if (evidence?.tested === true) return [`实际测试通过${evidence.testedAt ? ` · ${formatTime(evidence.testedAt)}` : ''}`, 'passed'];
    const tests = state?.runtime?.modelTests ?? {};
    const test = Array.isArray(tests) ? tests.find((entry) => entry.provider === provider.id) : tests[provider.id];
    if (evidence?.tested !== false && (test?.tested === true || test?.success === true || test?.status === 'success' || test?.ok === true)) return [`实际测试通过${test.testedAt || test.at ? ` · ${formatTime(test.testedAt || test.at)}` : ''}`, 'passed'];
    if (test?.success === false || test?.ok === false || test?.status === 'failed') return [test.message || test.error || '最近一次实际测试失败，请查看输出', 'failed'];
    if (secretUpdates[provider.secret]) return ['密钥已输入，尚未保存与测试', 'pending'];
    return state?.secrets?.[provider.secret] ? ['密钥已保存，尚未通过实际模型测试', 'unknown'] : ['尚未填写 API Key', 'missing'];
  }
  function setFlowDisclosure(element, open, { animate = false, force = false, duration = 280 } = {}) {
    if (!force && element.dataset.flowOpen === String(open)) return;
    const before = element.classList.contains('hidden') ? 0 : element.getBoundingClientRect().height;
    layoutAnimations.get(element)?.cancel(); layoutAnimations.delete(element);
    element.classList.remove('layout-animating');
    element.dataset.flowOpen = String(open);
    element.inert = !open;
    element.setAttribute('aria-hidden', String(!open));
    if (open) element.classList.remove('hidden');
    const finish = () => { if (element.dataset.flowOpen === String(open)) element.classList.toggle('hidden', !open); };
    if (!animate || reducedMotion() || currentPage !== 'connections') { finish(); return; }
    animateLayout(element, before, open ? element.scrollHeight : 0, { onFinish: finish, duration });
  }
  function renderContinueButtons(highest, animate, force = false) {
    const activeStage = setupSteps[highest]?.[0];
    const skipped = accountSkippedStages.get(selectedAccountId);
    $$('[data-flow-stage]').forEach((section) => {
      const stage = section.dataset.flowStage;
      const row = $('.setup-stage-actions', section);
      if (!row) return;
      row.dataset.flowActions = stage;
      for (const button of $$(':scope > button', row)) {
        const consumed = button.hasAttribute('data-setup-skip') && skipped?.has(stage);
        const show = stage === activeStage && !consumed;
        const primary = button.matches('[data-setup-save], [data-setup-apply], [data-setup-step]:not(.button-quiet)');
        button.classList.toggle('setup-continue-button', primary);
        button.dataset.continueActive = String(show);
        button.disabled = !show;
        button.inert = !show;
        button.setAttribute('aria-hidden', String(!show));
        // The whole footer fades with its stage. A consumed skip control stays
        // removed even when the user returns to this stage later in the session.
        button.classList.toggle('hidden', Boolean(consumed));
      }
      setFlowDisclosure(row, stage === activeStage, { animate, force, duration: 230 });
    });
  }
  function renderSetupGuide({ animate = false } = {}) {
    if (!state || !draft) return;
    const runtime = state.runtime ?? {};
    const connection = state.setup?.connection;
    const actualQQ = String(connection?.actualQQ ?? runtime.accountId ?? '');
    const expectedQQ = String(draft.botQQ ?? '');
    const connectionUnchanged = ['enabled', 'wsUrl'].every((key) => draft.qq?.[key] === state.applied?.qq?.[key]) && !secretUpdates.napcatToken;
    const verified = connectionUnchanged && Boolean(actualQQ) && actualQQ === expectedQQ && state.applied?.botQQ === expectedQQ && (connection ? connection.verified === true : runtime.connected === true);
    renderLlmSelector();
    renderCustomApis();
    const providers = configuredProviders();
    const selectedProvider = providers.length === 1 ? providers[0] : null;
    const modelsReady = Boolean(selectedProvider && ['passed', 'logged_in'].includes(modelEvidence(selectedProvider)[1]));
    const applied = state.applied ?? {};
    const hasTask = ['chat', 'summary', 'favorites'].some((name) => applied[name]?.enabled);
    const released = applied.permissions?.released === true;
    const readTargets = (applied.groups ?? []).filter((group) => group.read);
    if (!accountSetupSteps.has(selectedAccountId)) {
      // Reopened profiles reveal their actual configured sections; no test or permission is inferred.
      const last = released ? 'verification' : hasTask || (draft.groups ?? []).length ? 'permissions' : verified ? 'scenarios' : draft.qq?.enabled || applied.qq?.enabled ? 'connection' : providers.length ? 'models' : 'identity';
      accountSetupSteps.set(selectedAccountId, last);
    }
    const highest = setupSteps.findIndex(([id]) => id === accountSetupSteps.get(selectedAccountId));
    const sameAccount = renderedFlowAccount === selectedAccountId;
    $('#account-workspace').dataset.flowActive = setupSteps[highest][0];
    // Reveal the next action before measuring its expanding section.
    renderContinueButtons(highest, animate && sameAccount, !sameAccount);
    $$('[data-flow-stage]').forEach((wrapper, index) => {
      setFlowDisclosure(wrapper, index <= highest, { animate: sameAccount && animate, force: !sameAccount, duration: 300 });
    });
    renderedFlowAccount = selectedAccountId;
    for (const entry of draft.models.apis ?? []) {
      const card = $(`[data-api-card="${CSS.escape(entry.id)}"]`);
      if (!card) continue;
      $('h2', card).textContent = `兼容 API · ${entry.label || '自定义模型'}`;
      const guide = apiVendorGuide(entry.baseUrl);
      $('[data-api-guide]', card).innerHTML = guide ? `<a href="${guide[1]}" target="_blank" rel="noopener noreferrer">查看 ${guide[0]} 密钥与模型说明 ↗</a><small>具体模型、可用地区与额度以服务商后台为准。</small>` : '<small>请按服务商官方文档填写兼容接口地址和模型 ID。</small>';
      $('.api-secret-note', card).textContent = secretUpdates[`apiKey:${entry.id}`] ? '密钥已输入，尚未保存' : state.secrets?.[`apiKey:${entry.id}`] ? '此账号已保存密钥，留空保留' : '尚未配置密钥';
    }
    $('#setup-selected-models').textContent = providers.length > 1 ? '旧配置尚未归一：请选择一个模型后明确保存，原有运行模型不会自动更改。' : selectedProvider ? `当前选择：${selectedProvider.label}。账号任务统一使用此模型；其他已保存接口与密钥会保留。` : '尚未选择模型；可先连接 QQ，稍后再配置。';
    $('#setup-model-empty').classList.toggle('hidden', providers.length !== 0);
    $('#deepseek-model-card').classList.toggle('hidden', selectedProvider?.id !== 'deepseek');
    $('#codex-model-card').classList.toggle('hidden', selectedProvider?.id !== 'codex');
    $('#setup-model-status').innerHTML = (selectedProvider ? [selectedProvider] : []).map((provider) => { const [description, status] = modelEvidence(provider); return checkRow(provider.label, description, status); }).join('');
    $('#setup-connection-badge').textContent = verified ? `QQ ${actualQQ} · 身份已验证` : '尚未验证 QQ 身份';
    $('#setup-connection-badge').className = `pill ${verified ? 'pill-green' : 'pill-neutral'}`;
    const issue = connection?.issue ?? runtime.issue;
    $('#setup-connection-result').innerHTML = verified ? checkRow('实际连接已建立', `NapCat 返回的 QQ ${actualQQ} 与配置一致。`, 'connected') : checkRow('QQ 连接尚未确认', issue?.message ?? runtime.lastError ?? '完成扫码后，保存并连接以确认身份。', runtime.lastError ? 'error' : 'disconnected');
    if (issue?.action && !verified) $('#setup-connection-result').insertAdjacentHTML('beforeend', `<p class="connection-fix">下一步：${escapeHTML(issue.action)}</p>`);
    $('#setup-task-summary').innerHTML = [['chat','聊天与回复'],['summary','通知汇总'],['favorites','QQ 收藏整理']].map(([id,label]) => checkRow(label, applied[id]?.enabled ? `已应用 · ${providerLabel(applied[id].provider)}` : draft[id]?.enabled ? '配置已启用，尚未应用' : '尚未启用，点击下方设置任务', applied[id]?.enabled ? 'ready' : 'disabled')).join('');
    const permissionSummary = `${readTargets.length} 个已应用可读群，${(applied.groups ?? []).filter((group) => group.send).length} 个群选择发送。${released ? '账号已释放指定范围权限。' : '账号仍只读；选择范围并确认后，自动任务才会开始。'}${dirty || state.pendingChanges ? ' 仍有修改尚未应用。' : ''}`;
    $('#setup-permission-summary').textContent = permissionSummary;
    $('#setup-verification-checks').innerHTML = checkRow('QQ 登录与实际身份', verified ? `实际 QQ ${actualQQ} 与配置一致` : '尚未连接或身份未通过验证', verified ? 'passed' : 'pending') + checkRow('模型实际检查', modelsReady ? '至少一个所选模型已通过 API 测试或官方授权检查' : '尚无已通过实际检查的模型；请返回模型准备完成检查', modelsReady ? 'passed' : 'pending') + checkRow('任务参数', hasTask ? '至少一个功能已启用并应用' : '尚未应用启用的功能，请到账号功能参数选择', hasTask ? 'passed' : 'pending') + checkRow('选定范围与启动状态', permissionSummary, released ? 'passed' : 'pending');
    const writable = (applied.groups ?? []).find((group) => group.read && group.send);
    const testText = !verified ? '当前应先完成 QQ 连接：确认 NapCat 已扫码并启用正向 WebSocket 服务，再验证实际 QQ 身份。' : !hasTask ? 'QQ 已连接。请先启用一个功能：聊天、通知汇总或收藏整理，并保存应用。' : !released ? '任务已配置。下一步在“选定群与消息权限”选择群、设定读取 / 发送，再确认“启动此账号”。' : applied.chat?.enabled && writable ? `现在可在群 ${writable.name || writable.id} 中，用其他群成员账号${effectiveTriggers(writable).includes('prefix') ? `发送“${writable.prefix || '/ai'} 你好”` : effectiveTriggers(writable).includes('casual') && !effectiveTriggers(writable).includes('mention') ? '发一条普通消息（概率参与可能不会立即回复，首次验证推荐改为 @ 触发）' : `@ QQ ${actualQQ} 并发送“你好”`}。查看下方接收、模型和发送计数，再核对群中回复。` : applied.summary?.enabled ? '现在可在“账号功能参数”中，选择已应用的可读工作群并运行一次通知汇总。需先在群中产生可读消息。未授权私聊发送时，结果在任务与记录中查看。' : applied.favorites?.enabled ? '现在可在“账号功能参数”中点击“读取此账号收藏”，然后整理已读取收藏。结果可在任务与记录中核对。' : '此账号已启动。请按已授权的触发条件发送测试消息，并查看任务与记录。';
    $('#setup-test-guide').textContent = testText;
    const metrics = runtime.metrics ?? {};
    $('#setup-live-metrics').innerHTML = [['received','已接收消息'],['selected','命中处理规则'],['modelCalls','模型调用'],['sent','已发送消息']].map(([key,label]) => `<div><strong>${Number(metrics[key] || 0)}</strong><span>${label}</span></div>`).join('');
    const testGroups = (applied.groups ?? []).filter((group) => group.read && group.send);
    const groupSelect = $('#setup-test-group'); const previousGroup = groupSelect.value;
    const testOptions = '<option value="">选择已应用且允许发送的群</option>' + testGroups.map((group) => `<option value="${escapeHTML(group.id)}">${escapeHTML(group.name || group.id)}</option>`).join('');
    if (groupSelect.innerHTML !== testOptions) groupSelect.innerHTML = testOptions;
    groupSelect.value = testGroups.some((group) => group.id === previousGroup) ? previousGroup : testGroups[0]?.id || '';
    $('#setup-send-test').disabled = !released || !verified || !testGroups.length || !applied.chat?.enabled || applied.chat?.provider === 'codex';
    const qqTest = state.setup?.verification ?? runtime.qqTest;
    if (qqTest?.tested || qqTest?.sent) $('#setup-send-test-result').textContent = `已实际发送连接测试到群 ${qqTest.groupId} · ${formatTime(qqTest.testedAt)}，请在 QQ 群中核对。`;
    else $('#setup-send-test-result').textContent = '';
    $('#scenario-account-guidance').textContent = `当前配置：${accountName()} · ${released ? '已启动指定范围' : '默认只读，最后确认后启动'}`;
  }
  function providerLabel(id) {
    return id === 'deepseek' ? 'DeepSeek API' : id === 'codex' ? 'ChatGPT / Codex' : (draft?.models?.apis ?? []).find((entry) => entry.id === id)?.label || id || '未选择模型';
  }
  function selectConnectionRoute(route) {
    const native = route !== 'docker';
    $$('[data-connection-route]').forEach((button) => { const selected = button.dataset.connectionRoute === (native ? 'native' : 'docker'); button.classList.toggle('active', selected); button.setAttribute('aria-selected', String(selected)); });
    $('#connection-native-guide').classList.toggle('hidden', !native);
    $('#connection-docker-guide').classList.toggle('hidden', native);
  }
  async function testSetupModel(provider) {
    const id = requireAccount();
    if (!await openDialog(`测试 ${providerLabel(provider)}`, '<p>将保存并应用这个账号当前参数，再向所选模型发送一次小型请求。可能消耗 API 费用或订阅额度。</p><p>应用后账号恢复只读，测试不向 QQ 发送消息。</p>', '保存并测试')) return;
    await applyConfig(id, { advanceSetup: false });
    const result = await mutate('/test/model', { provider }, undefined, id);
    await openDialog('模型实际测试结果', `<pre class="result-box">${escapeHTML(JSON.stringify(result, null, 2))}</pre><p>模型测试成功仍需单独完成 QQ 连接及群权限设置。</p>`, '知道了');
    renderSetupGuide();
  }
  function clearValidationErrors() {
    $$('.field-error').forEach((element) => element.remove());
    $$('[aria-invalid="true"]').forEach((element) => element.removeAttribute('aria-invalid'));
    ['#setup-error','#scenario-validation-errors','#create-account-error'].forEach((selector) => $(selector).classList.add('hidden'));
  }
  function renderValidationErrors(error) {
    const issues = Array.isArray(error?.issues) ? error.issues : [];
    const details = Array.isArray(error?.details) && error.details.length ? error.details : [errorMessage(error)];
    const messages = [...new Set(details)];
    const sameRecipient = error.code === 'PRIVATE_RECIPIENT_SAME' || issues.some((issue) => issue.path === 'ownerQQ') && String(draft?.ownerQQ ?? '') === String(draft?.botQQ ?? '');
    const nextStep = error.nextStep || (issues.find((issue) => issue.path?.startsWith('qq') || issue.path === 'botQQ' || issue.path === 'napcatToken' || issue.path === 'secrets.napcatToken') ? 'connection' : issues.find((issue) => issue.path?.startsWith('models') || issue.path?.startsWith('apiKey')) ? 'models' : sameRecipient ? 'permissions' : null);
    const html = `<strong>${escapeHTML(errorMessage(error))}</strong><ul>${messages.map((message) => `<li>${escapeHTML(message)}</li>`).join('')}</ul>${[...new Set([error.action,...issues.map((issue) => issue.action)].filter(Boolean))].map((action) => `<p>下一步：${escapeHTML(action)}</p>`).join('')}${sameRecipient ? '<p>只想处理群消息或在仪表盘看结果，无需填写另一个 QQ。</p><button class="button button-secondary button-small" data-repair-private>关闭可选私聊投递，仅使用群与本地结果</button>' : ''}${nextStep ? `<button class="button button-quiet button-small" data-error-step="${nextStep}">前往对应配置 →</button>` : ''}`;
    for (const selector of currentPage === 'connections' && !$('#new-account-form').classList.contains('hidden') ? ['#create-account-error'] : ['#setup-error','#scenario-validation-errors']) { $(selector).innerHTML = html; $(selector).classList.remove('hidden'); }
    if (currentPage === 'connections' && $('#new-account-form').classList.contains('hidden') && setupSteps.some(([id]) => id === nextStep)) setSetupStep(nextStep);
    for (const issue of issues) {
      let secretPath = issue.path === 'secrets.napcatToken' ? 'napcatToken' : issue.path === 'models.deepseek.apiKey' ? 'deepseekApiKey' : issue.path;
      const customSecret = /^models\.apis\.(\d+)\.apiKey$/.exec(issue.path || '');
      if (customSecret) secretPath = `apiKey:${draft?.models?.apis?.[Number(customSecret[1])]?.id}`;
      const input = $(`[data-config="${CSS.escape(issue.path || '')}"], [data-secret="${CSS.escape(secretPath || '')}"]`);
      if (!input) continue;
      input.setAttribute('aria-invalid','true');
      const message = document.createElement('small'); message.className = 'field-error'; message.textContent = issue.message;
      input.closest('.field')?.append(message);
    }
  }
  function repairPrivateDelivery() {
    if (!draft) return;
    draft.permissions.privateReplies = false;
    draft.summary.sendToOwner = false;
    markDirty(); populateForm(); clearValidationErrors(); renderLiveState();
    toast('已关闭此账号配置中的私聊回复和私聊汇总投递。保存应用后，结果可在本地查看；群权限独立设置。', 'info');
  }
  async function initializeDesktopSettings() {
    const desktop = window.qqBridgeDesktop;
    if (!desktop?.getSettings || !desktop?.updateSettings) return;
    $('#desktop-settings-nav').classList.remove('hidden');
    function renderSettings(settings) {
      const closeBehavior = settings?.closeBehavior === 'quit' ? 'quit' : 'tray';
      $$('input[name="closeBehavior"]').forEach((input) => { input.checked = input.value === closeBehavior; });
      const title = closeBehavior === 'quit' ? '退出应用' : '关闭到托盘';
      $('#window-quit').title = title; $('#window-quit').setAttribute('aria-label',title);
      if (desktop.isDesktop) {
        $('.page-footer span:last-child').textContent = closeBehavior === 'quit' ? '模型授权 ≠ 发送授权 · 关闭窗口即退出' : '模型授权 ≠ 发送授权 · 关闭窗口留在托盘';
        $('.sidebar-note small').textContent = closeBehavior === 'quit' ? '各账号独立运行；关闭窗口后退出应用，停止所有后台。' : '各账号独立运行；关闭窗口后留在托盘，退出停止所有后台。';
      }
    }
    renderSettings(await desktop.getSettings());
    $$('input[name="closeBehavior"]').forEach((input) => input.addEventListener('change', () => withButton(null, async () => { renderSettings(await desktop.updateSettings({ closeBehavior: input.value })); toast('关闭窗口的行为已保存。'); })));
    $('#quit-application').addEventListener('click', () => withButton(null, () => desktop.quit()));
  }
  async function initializeWindowControls() {
    const desktop = window.qqBridgeDesktop;
    if (!desktop?.isDesktop || typeof desktop.minimize !== 'function') return;
    document.body.classList.add('desktop-window');
    $('#window-controls').classList.remove('hidden');
    function updateWindowState(value) {
      const maximized = value?.maximized === true;
      $('#window-maximize').setAttribute('aria-label', maximized ? '还原窗口' : '最大化');
      $('#window-maximize').title = maximized ? '还原窗口' : '最大化';
      $('#window-maximize').innerHTML = maximized ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5h6.5V10M3.5 6h6.5v6.5H3.5z"/></svg>' : '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1"/></svg>';
    }
    $('#window-minimize').addEventListener('click', () => withButton(null, () => desktop.minimize()));
    $('#window-maximize').addEventListener('click', () => withButton(null, () => desktop.toggleMaximize()));
    $('#window-quit').addEventListener('click', () => withButton(null, () => desktop.close ? desktop.close() : desktop.quit()));
    $('.window-drag-zone').addEventListener('dblclick', () => desktop.toggleMaximize());
    if (desktop.onWindowState) desktop.onWindowState(updateWindowState);
    if (desktop.getWindowState) updateWindowState(await desktop.getWindowState());
    await initializeDesktopSettings();
  }

  function renderLiveState() {
    renderSetupGuide();
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
    renderSetupGuide();
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
    const flowContext = button?.closest('[data-flow-stage]') ? { accountId: selectedAccountId, version: flowVersion() } : null;
    button?.classList.add('is-loading');
    try { clearValidationErrors(); await action(); } catch (error) {
      // A request still reports its failure, but never redirects or annotates a
      // different account/stage after the user has moved elsewhere.
      const currentFlow = !flowContext || selectedAccountId === flowContext.accountId && flowVersion() === flowContext.version;
      if (currentFlow) renderValidationErrors(error);
      toast(`${!currentFlow ? `「${accountName(flowContext.accountId)}」` : ''}${errorMessage(error)}`, 'error');
    }
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
    const choice = assertLlmChoice(config);
    if (choice) chooseSingleLlm(config, choice.id);
    const submittedSecrets = clone(editor.secretUpdates);
    const result = await accountApi('/config/save', { config, ...(Object.keys(submittedSecrets).length ? { secretUpdates: submittedSecrets } : {}) }, 'POST', id);
    if (!result.draft) throw new Error('后台未返回保存后的账号配置，请刷新确认。');
    acceptState(result, { accountId: id, replaceDraft: true, expectedEditVersion: sentVersion });
    if (!forApply) toast(`「${accountName(id)}」${editors.get(id).editVersion === sentVersion ? '配置已保存；运行参数与发送权限尚未改变。' : '已保存提交时的配置，新增输入仍未保存。'}`);
    return id;
  }
  async function resetAccountDefaults() {
    const id = requireAccount();
    rememberEditor();
    const editor = editors.get(id);
    const sentVersion = editor.editVersion;
    const revision = editor.state.revision;
    const config = clone(editor.draft);
    const submittedSecrets = clone(editor.secretUpdates);
    const confirmed = await openDialog(`还原「${accountName(id)}」功能参数`, '<p>将当前账号的聊天、通知汇总、收藏整理、群列表和消息权限设置还原为默认值，并保存为待应用配置。</p><p>账号身份、QQ 连接、模型参数和密钥会保留，包括本次尚未保存的修改。其他账号不受影响。</p><p>此次操作仅保存；当前运行参数与权限保持不变，需要你再点击“应用参数”后才生效。</p>', '还原并保存');
    if (!confirmed) return;
    if (!editors.has(id) || editors.get(id).editVersion !== sentVersion || editors.get(id).state.revision !== revision) throw new Error('确认期间此账号的配置发生了变化，请重新检查后再还原。');
    const result = await accountApi('/config/reset-defaults', { revision, config, ...(Object.keys(submittedSecrets).length ? { secretUpdates: submittedSecrets } : {}) }, 'POST', id);
    if (!result.draft) throw new Error('后台未返回还原后的配置，请刷新确认。');
    acceptState(result, { accountId: id, replaceDraft: true, expectedEditVersion: sentVersion });
    toast(`「${accountName(id)}」功能参数已还原并保存，等待应用；身份、连接和模型凭据已保留。`, 'info');
  }
  async function applyConfig(id = selectedAccountId, { advanceSetup = true } = {}) {
    requireAccount(id);
    const startedFlowVersion = flowVersion(id);
    if (id === selectedAccountId) rememberEditor();
    const needsModelSync = taskModelNeedsSync(editors.get(id).draft);
    if (editors.get(id).dirty || needsModelSync) await saveDraft({ forApply: true, accountId: id });
    if (editors.get(id).dirty) throw new Error('保存过程中有新增编辑，尚未应用。请再次点击应用参数。');
    const revision = editors.get(id).state.revision;
    const result = await accountApi('/config/apply', { revision }, 'POST', id);
    acceptState(result, { accountId: id });
    if (advanceSetup && ['chat', 'summary', 'favorites'].some((name) => result.applied?.[name]?.enabled)) setSetupStep('permissions', { accountId: id, scroll: false, expectedFlowVersion: startedFlowVersion });
    toast(`「${accountName(id)}」参数已应用，发送权限恢复只读。需要发送时，请到「选定群与消息权限」检查并释放。`, 'info');
  }
  async function releasePermissions(accountId = selectedAccountId) {
    const id = requireAccount(accountId);
    const startedFlowVersion = flowVersion(id);
    if (id === selectedAccountId) rememberEditor();
    const snapshot = clone(editors.get(id).draft);
    const confirmedModel = assertLlmChoice(snapshot);
    if (confirmedModel) chooseSingleLlm(snapshot, confirmedModel.id);
    const reads = snapshot.groups?.filter((group) => group.read === true) ?? [];
    const sends = snapshot.groups?.filter((group) => group.send === true) ?? [];
    const targets = sends.length ? sends.map((group) => `<li>${escapeHTML(group.name || group.id)}（${escapeHTML(group.id)}）</li>`).join('') : '<li>不向任何群发送</li>';
    const privateTarget = snapshot.permissions?.privateReplies && snapshot.ownerQQ ? `指定 QQ ${escapeHTML(snapshot.ownerQQ)}` : '未允许私聊发送';
    if (!await openDialog(`释放「${accountName(id)}」的范围权限`, `<p>将保存并应用这个账号当前的任务和权限配置，并校验实际登录 QQ ${escapeHTML(snapshot.botQQ || '尚未填写')}。</p><div class="apply-preview"><p>允许读取：${reads.length} 个群</p><p>允许群发送：</p><ul>${targets}</ul><p>私聊：${privateTarget}</p><p>聊天与回复：${snapshot.chat?.enabled ? (snapshot.chat?.provider === 'codex' ? '已启用 · Codex 仅本人私聊' : `已启用 · ${escapeHTML(providerLabel(snapshot.chat?.provider))}`) : '未启用'}；通知汇总：${snapshot.summary?.enabled ? '已启用' : '未启用'}；收藏：${snapshot.favorites?.enabled ? '已启用' : '未启用'}。</p></div><p>仅释放本次列出的范围。其他账号的配置和权限不受影响。</p>`, '保存并释放此账号权限')) return;
    if (editors.get(id).dirty || taskModelNeedsSync(editors.get(id).draft)) await saveDraft({ forApply: true, accountId: id });
    if (editors.get(id).dirty) throw new Error('此账号仍有新编辑，请重新检查权限后再释放。');
    const revision = editors.get(id).state.revision;
    const result = await accountApi('/permissions/release', { revision }, 'POST', id);
    acceptState(result, { accountId: id });
    setSetupStep('verification', { accountId: id, scroll: false, expectedFlowVersion: startedFlowVersion });
    toast(`「${accountName(id)}」账号已启动，后台仅按已授权范围执行。请进入验证效果，核对真实结果。`, 'info');
    return true;
  }
  function showCreateAccount() {
    navigate('connections');
    $('#new-account-form').classList.remove('hidden');
    $('#new-account-qq').focus();
  }
  async function createAccount() {
    if (!directoryToken) throw new Error('请先等待管理服务加载。');
    const form = $('#new-account-form');
    if (!form.reportValidity()) return;
    const qqNumber = $('#new-account-qq').value.trim();
    const name = $('#new-account-name').value.trim() || `QQ ${qqNumber}`;
    if (!/^[1-9]\d{3,19}$/.test(qqNumber)) throw new Error('QQ 号应为 4–20 位数字。');
    const source = $('#new-account-llm-source').value;
    const result = await api('/api/accounts', { name, platform: 'qq', qqNumber });
    if (!result.account?.id || !result.state?.draft) throw new Error('后台未返回创建后的账号配置，请刷新账号目录确认。');
    rememberEditor();
    const existing = accounts.find((account) => account.id === result.account.id);
    if (existing) Object.assign(existing, result.account);
    else accounts.push(result.account);
    accountSetupSteps.set(result.account.id, 'identity');
    acceptState(result.state, { accountId: result.account.id, replaceDraft: true });
    const id = result.account.id;
    const editor = editors.get(id);
    chooseSingleLlm(editor.draft, ['deepseek', 'codex', ''].includes(source) ? source : `vendor:${source}`);
    editor.dirty = true; editor.editVersion = (editor.editVersion ?? 0) + 1;
    expandedAccountId = id;
    await selectAccount(id);
    await saveDraft({ forApply: true, accountId: id });
    if ($('#new-account-qq').value.trim() === qqNumber && ($('#new-account-name').value.trim() || `QQ ${qqNumber}`) === name) {
      form.reset(); form.classList.add('hidden');
    }
    setSetupStep('identity', { accountId: id, scroll: false });
    await refreshDirectory();
    renderLiveState();
    toast(`「${name}」已创建。展开账号，按引导完成接入；当前只读。`);
  }
  async function openNapcatGuide() {
    const id = requireAccount();
    const guide = await accountApi('/napcat/guide', undefined, 'GET', id);
    let url;
    try { url = new URL(editors.get(id).draft?.qq?.webUiUrl || guide.url || editors.get(id).state?.applied?.qq?.webUiUrl); } catch { throw new Error('此账号的 NapCat 登录地址无效。'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('NapCat 登录地址必须使用 HTTP 或 HTTPS。');
    await openDialog(`「${accountName(id)}」QQ 扫码登录`, `<p>NapCat 负责连接 QQ。先登录其管理页面，再扫码登录你在本账号配置中填写的 QQ；输入 QQ 号或完成模型授权不代表 QQ 已登录。</p>${guide.initialWebUiToken && guide.message ? `<p>${escapeHTML(guide.message)}</p>` : '<p>原生 / 外部 NapCat：请打开你配置的管理页面。此应用不管理它的安装状态；已在 NapCat 登录的账号无需重新安装。</p>'}${guide.initialWebUiToken ? `<div class="notice notice-info"><strong>初始 WebUI 登录 Token</strong><p><code>${escapeHTML(guide.initialWebUiToken)}</code></p><p>仅用于此账号 NapCat 管理页面，请勿公开分享。</p></div>` : '<p>若已自行安装 Windows 原生 NapCat，可直接使用这个账号配置的管理页面，无需 Docker。</p>'}<p><a href="${escapeHTML(url.href)}" target="_blank" rel="noopener noreferrer">打开此账号 NapCat 页面 ↗</a></p>`, '知道了');
    $('#dialog-content').replaceChildren();
  }
  function addDraftGroups(id, entries) {
    const editor = editors.get(id);
    if (!editor?.draft) throw new Error('此账号的配置尚未加载。');
    editor.draft.groups ??= [];
    for (const entry of entries) {
      if (editor.draft.groups.some((group) => group.id === String(entry.id))) continue;
      editor.draft.groups.push({ id: String(entry.id), name: entry.name ?? '', mode: entry.mode ?? 'work', read: true, send: false, trigger: 'mention', triggers: ['mention'], prefix: '/ai', probability: 0.03, cooldownSeconds: 30 });
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
      if (selectedAccountId === id && currentPage !== 'connections') navigate('modules');
    },
    'codex-status': async () => {
      const id = requireAccount();
      const result = await mutate('/codex/status', undefined, undefined, id);
      const status = result.loggedIn !== undefined ? result : result.status ?? result.codexAuth;
      if (status && typeof status === 'object') {
        const editor = editors.get(id);
        editor.codexLoginStatus = status;
        if (selectedAccountId === id) { codexLoginStatus = status; renderRuntime(); renderSetupGuide(); }
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
      if (!await openDialog(`「${accountName(id)}」已加入的群`, `<p>选择要允许读取的群。添加默认禁止发送；群用途和发送权限仍可在表格中修改。</p><div class="joined-group-list">${html}</div>`, '将选中群加入只读配置')) return;
      const selected = $$('[data-joined-group]:checked', $('#dialog-content')).map((input) => choices[Number(input.dataset.joinedGroup)]);
      if (!selected.length) return;
      addDraftGroups(id, selected);
      toast(`「${accountName(id)}」已将 ${selected.length} 个群加入只读配置，保存应用后开始采集。`, 'info');
    }
  };
  function selectRecordTab(tab) {
    if (!$('.record-tab[data-record-tab="' + CSS.escape(String(tab)) + '"]')) tab = 'tasks';
    $$('.record-tab').forEach((button) => {
      const selected = button.dataset.recordTab === tab;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', String(selected));
    });
    $$('.record-content').forEach((panel) => panel.classList.toggle('hidden', panel.id !== `record-${tab}`));
  }
  document.addEventListener('pointerdown', (event) => {
    const summary = event.target.closest('.group-trigger-picker > summary');
    // A summary is not a native popover invoker button: light-dismiss may run
    // before click, so remember whether this pointer was toggling an open one.
    groupTriggerPointerState = summary ? { summary, wasOpen: activeGroupTriggerPicker?.summary === summary } : null;
  }, true);
  document.addEventListener('pointercancel', () => { groupTriggerPointerState = null; });
  document.addEventListener('beforetoggle', (event) => {
    if (event.newState !== 'closed' || event.target !== activeGroupTriggerPicker?.panel) return;
    const previous = activeGroupTriggerPicker;
    activeGroupTriggerPicker = null;
    previous.picker.open = false;
    previous.summary.setAttribute('aria-expanded', 'false');
  }, true);
  document.addEventListener('keydown', (event) => {
    const summary = event.target.closest('.group-trigger-picker > summary');
    if (summary && event.key === 'ArrowDown') {
      event.preventDefault();
      openGroupTriggerPicker(summary.parentElement, { focusSelector: '[data-group-trigger]' });
    } else if (event.key === 'Escape' && activeGroupTriggerPicker) {
      event.preventDefault();
      closeGroupTriggerPicker({ restoreFocus: true });
    }
  });
  document.addEventListener('focusin', (event) => {
    if (activeGroupTriggerPicker && !activeGroupTriggerPicker.picker.contains(event.target)) closeGroupTriggerPicker();
  });
  document.addEventListener('scroll', (event) => {
    const active = activeGroupTriggerPicker;
    if (!active || active.panel.contains(event.target)) return;
    // Scroll events queued before a click or resize must not dismiss the newly
    // positioned panel. Only close when its anchor actually moves afterwards.
    requestAnimationFrame(() => {
      if (active !== activeGroupTriggerPicker) return;
      const anchor = active.summary.getBoundingClientRect();
      if (Math.abs(anchor.left - active.anchorPosition.left) > 0.5 || Math.abs(anchor.top - active.anchorPosition.top) > 0.5) closeGroupTriggerPicker();
    });
  }, true);
  window.addEventListener('resize', positionGroupTriggerPicker);
  document.addEventListener('input', (event) => {
    if (event.target.closest('[data-builder-owned], #designer-builder-slot')) return;
    const input = event.target;
    if (input.id === 'account-profile-name') { if (selectedAccountId) { const editor = editors.get(selectedAccountId); if (editor) editor.profileName = input.value; } return; }
    if (input.dataset.config && draft) {
      const value = input.type === 'checkbox' ? input.checked : input.type === 'number' ? (input.value === '' ? null : Number(input.value)) : input.value;
      setPath(draft, input.dataset.config, value);
      markDirty(input);
      renderPermissions();
      if (input.dataset.config.includes('.provider') || input.dataset.config.startsWith('models.')) { renderProviderOptions(); renderSetupGuide(); }
    } else if (input.dataset.secret && draft) {
      if (input.value.trim()) secretUpdates[input.dataset.secret] = input.value.trim();
      else delete secretUpdates[input.dataset.secret];
      markDirty(input);
    } else if (input.dataset.groupTrigger && draft) {
      const index = Number(input.closest('[data-group-index]').dataset.groupIndex);
      const group = draft.groups[index];
      const selected = new Set(effectiveTriggers(group));
      if (input.checked) selected.add(input.dataset.groupTrigger); else selected.delete(input.dataset.groupTrigger);
      group.triggers = groupTriggerOptions.map(([id]) => id).filter((id) => selected.has(id));
      markDirty(); renderGroups(); renderPermissions();
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
    if (event.target.closest('[data-builder-owned], #designer-builder-slot')) return;
    if (event.target.id === 'account-llm-source' && draft) {
      chooseSingleLlm(draft, event.target.value); markDirty(event.target); populateForm(); renderLiveState(); return;
    }
    if (['mode', 'trigger'].includes(event.target.dataset.groupField)) renderGroups();
    if (event.target.dataset.config) { renderModules(); renderSetupGuide(); }
    if (event.target.id === 'summary-group') rememberEditor();
  });
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-builder-owned], #designer-builder-slot, [data-builder-nav]')) return;
    const summary = event.target.closest('.group-trigger-picker > summary');
    if (summary) {
      event.preventDefault();
      const wasOpen = activeGroupTriggerPicker?.summary === summary || (event.detail > 0 && groupTriggerPointerState?.summary === summary && groupTriggerPointerState.wasOpen);
      groupTriggerPointerState = null;
      if (wasOpen) closeGroupTriggerPicker();
      else openGroupTriggerPicker(summary.parentElement);
      return;
    }
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.openAccount) return withButton(button, async () => {
      const id = button.dataset.openAccount;
      expandedAccountId = expandedAccountId === id ? '' : id;
      if (expandedAccountId) await selectAccount(id);
      renderLiveState();
    });
    if (button.dataset.selectAccount) return withButton(button, async () => { expandedAccountId = button.dataset.selectAccount; await selectAccount(button.dataset.selectAccount); navigate('connections'); renderLiveState(); });
    if (button.dataset.overviewGo) {
      const destination = button.dataset.overviewGo;
      if (destination === 'accounts') return navigate('connections');
      if (destination === 'summaries') { selectRecordTab('summaries'); return navigate('records'); }
      selectScenarioTab('permissions'); navigate('scenarios');
      if (destination === 'groups') requestAnimationFrame(() => { const card = $('.group-table').closest('.card'); card.tabIndex = -1; card.focus({ preventScroll: true }); card.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' }); });
      return;
    }
    if (button.dataset.setupBack) return setSetupStep(button.dataset.setupBack, { focus: true });
    if (button.dataset.setupSkip) {
      const stage = button.closest('[data-flow-stage]')?.dataset.flowStage;
      if (!selectedAccountId || !stage) return;
      const skipped = accountSkippedStages.get(selectedAccountId) ?? new Set();
      skipped.add(stage); accountSkippedStages.set(selectedAccountId, skipped);
      return setSetupStep(button.dataset.setupSkip, { focus: true });
    }
    if (button.dataset.setupStep) return setSetupStep(button.dataset.setupStep);
    if (button.dataset.setupSave) return withButton(button, async () => {
      const id = requireAccount(); const startedFlowVersion = flowVersion(id);
      await saveDraft({ accountId: id });
      setSetupStep(button.dataset.setupSave, { accountId: id, expectedFlowVersion: startedFlowVersion });
    });
    if (button.dataset.setupApply) return withButton(button, async () => {
      const id = requireAccount(); const startedFlowVersion = flowVersion(id);
      await applyConfig(id, { advanceSetup: false });
      setSetupStep(button.dataset.setupApply, { accountId: id, expectedFlowVersion: startedFlowVersion });
    });
    if (button.hasAttribute('data-setup-connect')) return withButton(button, async () => {
      const id = requireAccount(); const startedFlowVersion = flowVersion(id);
      setPath(draft, 'qq.enabled', true); markDirty(); populateForm();
      await applyConfig(id, { advanceSetup: false }); await mutate('/runtime/connect', {}, '连接检查已返回，请核对下方实际 QQ 身份。', id);
      if (editors.get(id)?.state?.setup?.connection?.verified) setSetupStep('scenarios', { accountId: id, expectedFlowVersion: startedFlowVersion });
    });
    if (button.hasAttribute('data-setup-start')) return withButton(button, async () => { const id = requireAccount(); await releasePermissions(id); });
    if (button.hasAttribute('data-setup-refresh')) return withButton(button, () => refreshState({ notify: true }));
    if (button.dataset.setupModelTest) return withButton(button, () => testSetupModel(button.dataset.setupModelTest));
    if (button.dataset.connectionRoute) return selectConnectionRoute(button.dataset.connectionRoute);
    if (button.hasAttribute('data-return-to-setup')) { expandedAccountId = selectedAccountId; navigate('connections'); renderLiveState(); setSetupStep(currentScenarioTab === 'permissions' ? 'permissions' : 'scenarios'); return; }
    if (button.hasAttribute('data-repair-private')) return repairPrivateDelivery();
    if (button.dataset.errorStep) { if (button.dataset.errorStep === 'permissions') { selectScenarioTab('permissions'); navigate('scenarios'); } else { expandedAccountId = selectedAccountId; navigate('connections'); renderLiveState(); setSetupStep(button.dataset.errorStep); } return; }

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
    if (button.dataset.groupTriggersAll !== undefined || button.dataset.groupTriggersClear !== undefined) {
      const index = Number(button.dataset.groupTriggersAll ?? button.dataset.groupTriggersClear);
      if (!draft?.groups[index]) return;
      draft.groups[index].triggers = button.dataset.groupTriggersAll !== undefined ? groupTriggerOptions.map(([id]) => id) : [];
      markDirty(); renderGroups(); return;
    }
    if (button.dataset.removeGroup !== undefined && draft) {
      closeGroupTriggerPicker();
      draft.groups.splice(Number(button.dataset.removeGroup), 1);
      markDirty();
      renderGroups();
      renderPermissions();
    }
  });
  $('#account-selector').addEventListener('change', (event) => withButton(null, () => selectAccount(event.target.value)));
  $('#save-account-profile').addEventListener('click', (event) => withButton(event.currentTarget, saveAccountProfile));
  $('#create-account-entry').addEventListener('click', showCreateAccount);
  $('#cancel-create-account').addEventListener('click', () => $('#new-account-form').classList.add('hidden'));
  $('#new-account-form').addEventListener('submit', (event) => { event.preventDefault(); withButton($('#submit-create-account'), createAccount); });
  $('#refresh-state').addEventListener('click', (event) => withButton(event.currentTarget, () => refreshState({ notify: true })));
  $('#save-draft').addEventListener('click', (event) => withButton(event.currentTarget, () => saveDraft()));
  $('#reset-account-defaults').addEventListener('click', (event) => withButton(event.currentTarget, resetAccountDefaults));
  $('#apply-config').addEventListener('click', (event) => withButton(event.currentTarget, () => applyConfig()));
  $('#release-permissions').addEventListener('click', (event) => withButton(event.currentTarget, () => releasePermissions()));
  $('#revoke-permissions').addEventListener('click', (event) => withButton(event.currentTarget, async () => {
    const id = requireAccount();
    await mutate('/permissions/revoke', {}, '已恢复只读，后续发送已被后台阻止。其他账号不受影响。', id);
  }));
  $('#discard-draft').addEventListener('click', (event) => withButton(event.currentTarget, async () => {
    const id = requireAccount();
    if (!await openDialog(`丢弃「${accountName(id)}」未保存修改`, '<p>仅恢复这个账号后台已保存的配置，不改变运行权限，其他账号的输入会保留。</p>', '丢弃此账号未保存输入')) return;
    const next = await accountApi('/state', undefined, 'GET', id);
    acceptState(next, { replaceDraft: true, accountId: id });
    toast(`「${accountName(id)}」已恢复已保存配置。`);
  }));
  $('#add-group').addEventListener('click', (event) => withButton(event.currentTarget, async () => {
    const id = requireAccount();
    if (!await openDialog(`为「${accountName(id)}」添加选定群`, '<label class="field">群号<input id="new-group-id" inputmode="numeric" pattern="[1-9][0-9]{3,19}" placeholder="请输入数字群号" required></label><label class="field">群名称<input id="new-group-name" placeholder="方便识别的名称"></label><label class="field">群用途<select id="new-group-mode"><option value="work">工作通知群</option><option value="social">社交群</option></select></label><p>接入账号必须已加入该群。默认允许读取、禁止发送；添加群本身不会释放权限。</p>', '加入只读配置')) return;
    const groupId = $('#new-group-id').value.trim();
    if (!/^[1-9]\d{3,19}$/.test(groupId)) throw new Error('群号应为 4–20 位数字。');
    if ((editors.get(id).draft.groups ?? []).some((group) => group.id === groupId)) throw new Error('这个群已在该账号的配置中。');
    addDraftGroups(id, [{ id: groupId, name: $('#new-group-name').value.trim(), mode: $('#new-group-mode').value }]);
    toast(`「${accountName(id)}」已加入只读配置；保存应用后开始采集。`, 'info');
  }));
  $('#open-napcat').addEventListener('click', (event) => withButton(event.currentTarget, openNapcatGuide));
  $('#export-config')?.addEventListener('click', (event) => withButton(event.currentTarget, async () => {
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
  $('#rollback-config')?.addEventListener('click', (event) => withButton(event.currentTarget, async () => {
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
  $('#setup-send-test').addEventListener('click', (event) => withButton(event.currentTarget, async () => {
    const id = requireAccount(); const groupId = $('#setup-test-group').value;
    if (!groupId) throw new Error('请先选定群、允许该群发送，并启动此账号。');
    if (!await openDialog('向 QQ 群发送连接测试', `<p>将通过当前 QQ 向群 ${escapeHTML(groupId)} 发送一条固定的 QQ_Service 连接测试消息。群成员可以看到这条消息。</p><p>不调用 AI，不消耗模型额度；需要已释放此群发送权限。</p>`, '发送一条测试消息')) return;
    const result = await mutate('/qq/test-message', { groupId }, undefined, id);
    if (id === selectedAccountId) $('#setup-send-test-result').textContent = result.message || '测试消息已发送，请在 QQ 群中核对。';
  }));
  $('#preview-type').addEventListener('change', () => { $('#preview-group').disabled = $('#preview-type').value === 'private'; });
  window.addEventListener('beforeunload', (event) => {
    rememberEditor();
    if (![...editors.values()].some((editor) => editor.dirty)) return;
    event.preventDefault();
    event.returnValue = '';
  });
  window.QQServiceNavigation = Object.freeze({
    go: navigate,
    currentPage: () => currentPage,
    pendingPage: () => pendingBuilderPage,
  });
  window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));
  if (window.qqBridgeDesktop?.isDesktop) {
    $('.sidebar-version span').textContent = window.qqBridgeDesktop.version || '0.4.0';
    $('.sidebar-note small').textContent = '各账号独立运行；关闭窗口后留在托盘，退出停止所有后台。';
    $('.page-footer span').textContent = 'QQ_Service · Windows 桌面应用';
    $('.page-footer span:last-child').textContent = '模型授权 ≠ 发送授权 · 关闭窗口留在托盘';
  }
  initializeWindowControls().catch((error) => toast(errorMessage(error), 'error'));
  navigate(location.hash.slice(1));
  renderLiveState();
  refreshState();
  setInterval(() => { if (document.visibilityState === 'visible') refreshState(); }, 4000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshState(); });
})();
