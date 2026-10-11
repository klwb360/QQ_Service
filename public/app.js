'use strict';

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const clone = (value) => structuredClone(value);
  const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const pageInfo = {
    overview: ['总览', 'WORKSPACE OVERVIEW', '你的 QQ 助手工作台', '连接账号，选定群聊，让助手按你的规则工作。'],
    connections: ['账号与模型', 'CONNECTIONS & MODELS', '连接你的账号与模型', 'QQ、DeepSeek 与个人 GPT 各自授权，分别管理。'],
    scenarios: ['场景与权限', 'SCENARIOS & PERMISSIONS', '按场景设置助手', '社交群聊天，工作群只读，私人资料只用于本人任务。'],
    modules: ['模块管理', 'MODULE MANAGEMENT', '安装与管理运行模块', '查看真实安装状态，完成登录与授权。'],
    records: ['任务与记录', 'ACTIVITY & EVIDENCE', '任务、汇总与原文依据', '了解每次执行的结果，回到原始通知核对信息。']
  };
  const builtinConfig = { deepseek: 'models.deepseek.enabled', summary: 'summary.enabled', favorites: 'favorites.enabled' };
  let state = null;
  let draft = null;
  let dirty = false;
  let editVersion = 0;
  let secretUpdates = {};
  let refreshPromise = null;
  let currentPage = 'overview';
  let dialogResolve = null;
  let consecutiveFailures = 0;
  let codexLoginStatus = null;

  function getPath(object, path) {
    return path.split('.').reduce((value, key) => value?.[key], object);
  }
  function setPath(object, path, value) {
    const keys = path.split('.');
    let parent = object;
    for (const key of keys.slice(0, -1)) {
      if (!parent[key] || typeof parent[key] !== 'object') parent[key] = {};
      parent = parent[key];
    }
    parent[keys.at(-1)] = value;
  }
  function markDirty() {
    dirty = true;
    editVersion += 1;
    renderConfigBar();
  }
  function toast(message, kind = 'success') {
    const item = document.createElement('div');
    item.className = `toast ${kind}`;
    item.textContent = message;
    $('#toast-region').append(item);
    setTimeout(() => item.remove(), kind === 'error' ? 11000 : 6000);
  }
  function errorMessage(error) {
    return error?.message || String(error);
  }
  async function api(path, body, method = 'POST') {
    const options = { method, credentials: 'same-origin', headers: {} };
    if (method !== 'GET') {
      if (!state?.csrfToken) throw new Error('尚未连接管理服务，请先刷新状态。');
      options.headers['X-Dashboard-Token'] = state.csrfToken;
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
  function setOnline(online) {
    $('#server-dot').className = `status-dot ${online ? 'online' : 'offline'}`;
    $('#server-label').textContent = online ? '管理服务可访问' : '管理服务无法访问';
  }
  function acceptState(next, { replaceDraft = false } = {}) {
    state = next;
    if (!draft || replaceDraft) {
      draft = clone(next.draft);
      dirty = false;
      secretUpdates = {};
      $$('[data-secret]').forEach((input) => { input.value = ''; });
      populateForm();
    }
    setOnline(true);
    $('#load-error').classList.add('hidden');
    renderLiveState();
  }
  async function refreshState({ notify = false } = {}) {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      try {
        const next = await api('/api/state', undefined, 'GET');
        if (!next.draft || !next.csrfToken) throw new Error('后台状态不完整，无法加载配置。');
        acceptState(next);
        consecutiveFailures = 0;
        if (notify) toast('已刷新后台实际状态。');
        return next;
      } catch (error) {
        consecutiveFailures += 1;
        setOnline(false);
        if (!state || consecutiveFailures >= 2) {
          $('#load-error').textContent = `无法读取管理服务：${errorMessage(error)} 请确认本机启动窗口仍在运行。你的输入保留在当前页面。`;
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
  function populateForm() {
    if (!draft) return;
    $$('[data-config]').forEach((input) => {
      const value = getPath(draft, input.dataset.config);
      if (input.type === 'checkbox') input.checked = Boolean(value);
      else input.value = value ?? '';
    });
    renderGroups();
  }
  function renderConfigBar() {
    const pending = Boolean(state?.pendingChanges || state?.secretsPendingChanges);
    const indicator = $('#config-indicator');
    indicator.className = `config-indicator ${dirty || pending ? 'pending' : state ? 'clean' : ''}`;
    $('#config-label').textContent = !state ? '正在读取配置' : dirty ? '有尚未保存的修改' : pending ? '草稿已保存，等待应用' : '配置已同步';
    $('#config-detail').textContent = !state ? '草稿保存与运行配置分别管理' : `草稿版本 ${state.revision ?? '—'} · 已应用版本 ${state.appliedRevision ?? '—'}${dirty ? ' · 当前修改只在此页面' : state.secretsPendingChanges ? ' · 凭据待应用' : ''}`;
    $('#discard-draft').disabled = !dirty;
    $('#save-draft').disabled = !state || !dirty;
    $('#apply-config').disabled = !state || (!dirty && !pending);
  }
  function renderSecrets() {
    [['deepseekApiKey', '#deepseek-secret-state'], ['napcatToken', '#napcat-secret-state']].forEach(([name, selector]) => {
      const saved = Boolean(state?.secrets?.[name]);
      $(selector).textContent = saved ? '已有凭据 · 留空保留' : '尚未配置';
      $(selector).classList.toggle('missing', !saved);
    });
  }
  function getModules() {
    return Array.isArray(state?.modules) ? state.modules : Object.entries(state?.modules ?? {}).map(([id, value]) => ({ id, ...value }));
  }
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
    $('#runtime-badge').textContent = `QQ · ${label}`;
    $('#runtime-badge').className = `heading-status ${color === 'green' ? 'connected' : color === 'red' ? 'error' : ''}`;
    const applied = state?.applied;
    const account = runtime.accountId ?? runtime.qq?.accountId ?? applied?.botQQ;
    const groups = applied?.groups ?? [];
    const work = groups.filter((group) => group.mode === 'work').length;
    const social = groups.filter((group) => group.mode === 'social').length;
    const codex = getModules().find((module) => module.id === 'codex');
    const auth = state?.codexAuth?.loggedIn !== null && state?.codexAuth?.loggedIn !== undefined ? state.codexAuth : codexLoginStatus;
    $('#runtime-status').innerHTML = checkRow('QQ 消息连接', account ? `当前账号 ${account} · 使用已应用配置` : '尚未确认登录账号', qqStatus)
      + checkRow('群与发送范围', `${social} 个社交群 · ${work} 个只读工作群 · 私聊仅本人`, applied ? 'ready' : 'unknown')
      + checkRow('GPT 登录状态', auth?.message ?? state?.codexAuth?.message ?? codex?.authMessage ?? '登录状态需通过官方 CLI 检查；安装状态与登录状态分别管理', (auth?.loggedIn ?? codex?.loggedIn) === true ? 'logged_in' : (auth?.loggedIn ?? codex?.loggedIn) === false ? 'waiting_login' : 'unknown');
    $('#runtime-details').textContent = JSON.stringify(runtime, null, 2);
    const stats = [
      ['QQ 消息连接', label, account ? `登录账号 ${account}` : '需要完成扫码及连接', '⇄'],
      ['已应用社交群', social, 'DeepSeek · 按规则回复', '◎'],
      ['只读工作群', work, '采集通知 · 仅本人接收', '▤'],
      ['本地汇总记录', Array.isArray(state?.summaries) ? state.summaries.length : 0, '每份汇总附原文依据', '≡']
    ];
    $('#overview-stats').innerHTML = stats.map(([name, value, note, icon]) => `<div class="stat-card"><div><div class="stat-label">${escapeHTML(name)}</div><div class="stat-value">${escapeHTML(value)}</div><div class="stat-note">${escapeHTML(note)}</div></div><span class="stat-icon">${icon}</span></div>`).join('');
  }
  function renderGroups() {
    const groups = draft?.groups ?? [];
    $('#group-rows').innerHTML = groups.length ? groups.map((group, index) => {
      const work = group.mode === 'work';
      return `<tr data-group-index="${index}"><td><input data-group-field="name" value="${escapeHTML(group.name)}" aria-label="群名称"><input class="group-id" data-group-field="id" value="${escapeHTML(group.id)}" inputmode="numeric" aria-label="QQ群号"></td><td><select data-group-field="mode" aria-label="群模式"><option value="social" ${!work ? 'selected' : ''}>社交群 · 可回复</option><option value="work" ${work ? 'selected' : ''}>工作群 · 只读</option></select></td><td>${work ? '<div class="group-readonly">只记录消息<br>由本人手动或定时汇总</div>' : `<select data-group-field="trigger" aria-label="触发条件"><option value="mention" ${group.trigger === 'mention' ? 'selected' : ''}>@ 机器人</option><option value="prefix" ${group.trigger === 'prefix' ? 'selected' : ''}>命令前缀</option><option value="casual" ${group.trigger === 'casual' ? 'selected' : ''}>概率参与聊天</option></select>`}</td><td>${work ? '<span class="pill pill-neutral">禁止向此群发送</span>' : `<div class="group-parameter">${group.trigger === 'prefix' ? `<label>前缀 <input data-group-field="prefix" value="${escapeHTML(group.prefix ?? '/ai')}" aria-label="命令前缀"></label>` : group.trigger === 'casual' ? `<label>概率 <input type="number" data-group-field="probability" min="0" max="0.25" step="0.01" value="${escapeHTML(group.probability ?? 0.03)}" aria-label="插话概率"></label>` : ''}<label>冷却秒 <input type="number" data-group-field="cooldownSeconds" min="5" max="3600" value="${escapeHTML(group.cooldownSeconds ?? 30)}" aria-label="冷却秒数"></label></div>`}</td><td><button class="remove-group" data-remove-group="${index}" aria-label="移除 ${escapeHTML(group.name || group.id)}">×</button></td></tr>`;
    }).join('') : '<tr><td colspan="5"><div class="empty-state"><strong>先选定一个 QQ 群</strong>添加群号并选择社交或工作模式，应用后才会开始处理。</div></td></tr>';
  }
  function renderSummaryGroupSelect() {
    const select = $('#summary-group');
    const previous = select.value;
    const groups = state?.applied?.groups?.filter((group) => group.mode === 'work') ?? [];
    select.innerHTML = '<option value="">选择已应用的工作群</option>' + groups.map((group) => `<option value="${escapeHTML(group.id)}">${escapeHTML(group.name || group.id)}</option>`).join('');
    if (groups.some((group) => group.id === previous)) select.value = previous;
  }
  function renderModules() {
    const modules = getModules();
    const known = [
      { id: 'napcat', name: 'NapCat QQ', kind: 'external', description: '通过 QQ 扫码登录账号，提供 OneBot 消息接口。需要 Docker Desktop。', icon: '⇄' },
      { id: 'codex', name: '官方 Codex CLI', kind: 'external', description: '由本人完成 ChatGPT 设备码授权，使用当前账号可用的模型额度。', icon: '✧' },
      { id: 'deepseek', name: 'DeepSeek 接入', kind: 'builtin', description: '社交群聊天与个人通知处理，通过你的 DeepSeek API Key 调用。', icon: '◈' },
      { id: 'summary', name: '通知汇总', kind: 'builtin', description: '读取选定工作群，解释通知与行动项，保存原文依据并私聊本人。', icon: '▤' },
      { id: 'favorites', name: 'QQ 收藏读取', kind: 'builtin', description: '读取当前登录账号的收藏列表与返回摘要，完整内容尚未验证。', icon: '☆' }
    ];
    $('#module-cards').innerHTML = known.map((definition) => {
      const module = modules.find((item) => item.id === definition.id);
      const builtin = definition.kind === 'builtin';
      const enabled = builtin && Boolean(getPath(draft, builtinConfig[definition.id]));
      const actualStatus = module ? module.state ?? module.status ?? (module.installed ? 'installed' : 'missing') : 'unknown';
      let actions;
      if (builtin) actions = `<button class="button button-secondary button-small" data-toggle-builtin="${definition.id}">${enabled ? '在草稿中停用' : '在草稿中启用'}</button><button class="button button-quiet button-small" data-go="${definition.id === 'deepseek' ? 'connections' : 'scenarios'}">参数配置 →</button>`;
      else if (definition.id === 'napcat') actions = '<button class="button button-secondary button-small" data-module-action="install" data-module="napcat">安装 / 检查</button><button class="button button-quiet button-small" data-module-action="start" data-module="napcat">启动</button><button class="button button-quiet button-small" data-module-action="stop" data-module="napcat">停止</button>';
      else actions = '<button class="button button-secondary button-small" data-module-action="install" data-module="codex">安装 / 检查</button><button class="button button-quiet button-small" data-action="codex-login">设备码授权 →</button>';
      return `<article class="module-card ${builtin ? 'builtin' : 'external'}"><div class="module-main"><div class="module-top"><span class="module-icon">${definition.icon}</span>${builtin ? `<span class="pill ${enabled ? 'pill-green' : 'pill-neutral'}">${enabled ? '草稿已启用' : '内置 · 草稿未启用'}</span>` : pill(actualStatus)}</div><h2>${escapeHTML(definition.name)}</h2><p>${escapeHTML(module?.description || definition.description)}</p><div class="module-version">${builtin ? '随本项目提供 · 通过配置启用' : module ? `版本 ${escapeHTML(module.version || '未提供')} · ${module.installed ? '已安装' : '未确认安装'}` : '等待后台返回模块检查结果'}</div></div><div class="module-actions">${actions}</div></article>`;
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
    renderConfigBar();
    renderSecrets();
    renderEnvironment();
    renderRuntime();
    renderModules();
    renderJobs();
    renderSummaryGroupSelect();
    renderSummaries();
    renderFavorites();
    renderLogs();
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
  async function mutate(path, body, message) {
    const result = await api(path, body);
    if (result.csrfToken && result.draft) acceptState(result);
    else await refreshState();
    if (message) toast(message, 'info');
    return result;
  }
  async function saveDraft({ forApply = false } = {}) {
    const sentVersion = editVersion;
    const config = clone(draft);
    const submittedSecrets = clone(secretUpdates);
    const result = await api('/api/config/save', { config, ...(Object.keys(submittedSecrets).length ? { secretUpdates: submittedSecrets } : {}) });
    if (!result.draft) throw new Error('后台未返回保存后的配置，请刷新确认保存状态。');
    acceptState(result, { replaceDraft: editVersion === sentVersion });
    if (!forApply) toast(editVersion === sentVersion ? '草稿已保存。点击「保存并应用」使其生效。' : '已保存提交时的草稿；你后续的修改仍未保存。');
  }
  async function applyConfig() {
    if (dirty) await saveDraft({ forApply: true });
    if (dirty) throw new Error('保存过程中有新增编辑，尚未应用。请再次点击「保存并应用」。');
    const appliedRevision = state.revision;
    const result = await api('/api/config/apply', { revision: appliedRevision });
    acceptState(result);
    toast(dirty ? '已应用提交时的配置；你之后的编辑仍未保存。' : '已保存并应用配置，请查看运行状态。');
  }
  async function openNapcatGuide() {
    const guide = await api('/api/napcat/guide', undefined, 'GET');
    let url;
    try { url = new URL(guide.url || draft?.qq?.webUiUrl); } catch { throw new Error('NapCat 登录地址无效。'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('NapCat 地址必须使用 HTTP 或 HTTPS。');
    await openDialog('打开 NapCat 登录页面', `<p>先完成 WebUI 登录，再扫码登录 QQ。扫码账号应与机器人 QQ 设置一致。</p>${guide.message ? `<p>${escapeHTML(guide.message)}</p>` : ''}${guide.initialWebUiToken ? `<div class="notice notice-info"><strong>初始 WebUI 登录 Token</strong><p><code>${escapeHTML(guide.initialWebUiToken)}</code></p><p>此 Token 只在本机显示，用于 NapCat 页面登录，请勿公开分享。</p></div>` : '<p>如你已经另外安装 NapCat，可使用所配置的 WebUI 地址；这里不会读取 QQ 登录会话。</p>'}<p><a href="${escapeHTML(url.href)}" target="_blank" rel="noopener noreferrer">打开 NapCat WebUI ↗</a></p>`, '知道了');
    $('#dialog-content').replaceChildren();
  }
  const actions = {
    'environment-check': () => mutate('/api/environment/check', {}, '环境检查已返回，请查看检查结果。'),
    'runtime-connect': () => mutate('/api/runtime/connect', {}, '连接请求已提交，请查看实际 QQ 连接状态。'),
    'codex-login': async () => {
      await mutate('/api/codex/login', {}, '官方设备码授权任务已启动。请在任务输出中查看授权地址与设备码。');
      navigate('modules');
    },
    'codex-status': async () => {
      const result = await mutate('/api/codex/status');
      const status = result.loggedIn !== undefined ? result : result.status;
      if (status && typeof status === 'object') {
        codexLoginStatus = status;
        renderRuntime();
        toast(status.message || (status.loggedIn ? '官方 CLI 报告已登录。' : '官方 CLI 尚未确认登录。'), status.loggedIn ? 'success' : 'info');
      }
      else toast('登录检查已返回，请查看模块状态或任务日志。', 'info');
    },
    'test-deepseek': async () => {
      if (!await openDialog('测试 DeepSeek 连接', '<p>将使用已应用的 API Key 与模型发送一次小型请求，可能产生 API 费用。</p><p>此测试不发送 QQ 消息；ChatGPT 订阅不承担这笔 API 费用。</p>', '运行付费 API 测试')) return;
      const result = await mutate('/api/test/deepseek');
      await openDialog('DeepSeek 测试返回', `<p>后台已返回以下结果，请核对；不代表 QQ 连接已成功。</p><pre class="result-box">${escapeHTML(JSON.stringify(result, null, 2))}</pre>`, '知道了');
    },
    'summary-run': async () => {
      const groupId = $('#summary-group').value;
      if (!groupId) throw new Error('请选择一个已应用的工作群。');
      if (!await openDialog('运行本人通知汇总', `<p>读取工作群 ${escapeHTML(groupId)} 的已保存消息，调用已应用的汇总模型。</p><p>此任务用于本人，可能消耗模型额度；根据设置只发本人私聊或保存在本地。</p>`, '立即汇总')) return;
      await mutate('/api/summary/run', { groupId }, '汇总请求已返回，请在「汇总与依据」及任务日志中核对结果。');
      navigate('records');
      selectRecordTab('summaries');
    },
    'favorites-sync': async () => {
      await mutate('/api/favorites/sync', {}, '收藏读取已返回，内容以实际列表为准。');
      navigate('records');
      selectRecordTab('favorites');
    },
    'favorites-summarize': async () => {
      await mutate('/api/favorites/summarize', {}, '收藏整理请求已返回。仅处理已读取的列表摘要，请在汇总记录中核对依据。');
      navigate('records');
      selectRecordTab('summaries');
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
    } else if (input.dataset.secret) {
      if (input.value.trim()) secretUpdates[input.dataset.secret] = input.value.trim();
      else delete secretUpdates[input.dataset.secret];
      markDirty();
    } else if (input.dataset.groupField && draft) {
      const index = Number(input.closest('[data-group-index]').dataset.groupIndex);
      draft.groups[index][input.dataset.groupField] = input.type === 'number' ? (input.value === '' ? null : Number(input.value)) : input.value;
      markDirty();
    }
  });
  document.addEventListener('change', (event) => {
    if (['mode', 'trigger'].includes(event.target.dataset.groupField)) renderGroups();
    if (event.target.dataset.config) renderModules();
  });
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.page) return navigate(button.dataset.page);
    if (button.dataset.go) return navigate(button.dataset.go);
    if (button.dataset.recordTab) return selectRecordTab(button.dataset.recordTab);
    if (button.dataset.action && actions[button.dataset.action]) return withButton(button, actions[button.dataset.action]);
    if (button.dataset.moduleAction) return withButton(button, async () => {
      const id = button.dataset.module;
      const action = button.dataset.moduleAction;
      if (action === 'stop' && !await openDialog('停止 QQ 接入模块', '<p>停止后将暂停 QQ 收发与通知采集。配置与本地记录会保留。</p>', '停止 NapCat')) return;
      await mutate(`/api/modules/${encodeURIComponent(id)}/${encodeURIComponent(action)}`, {}, '任务已提交，请查看实际执行输出。');
    });
    if (button.dataset.toggleBuiltin && draft) {
      const path = builtinConfig[button.dataset.toggleBuiltin];
      setPath(draft, path, !getPath(draft, path));
      markDirty();
      populateForm();
      renderModules();
      return toast('已修改草稿开关；保存并应用后生效。', 'info');
    }
    if (button.dataset.preset && draft) {
      setPath(draft, 'qq.enabled', true);
      if (button.dataset.preset === 'social') setPath(draft, 'models.deepseek.enabled', true);
      if (button.dataset.preset === 'summary') {
        setPath(draft, 'summary.enabled', true);
        setPath(draft, `models.${draft.summary.provider}.enabled`, true);
      }
      if (button.dataset.preset === 'favorites') setPath(draft, 'favorites.enabled', true);
      markDirty();
      populateForm();
      renderModules();
      return toast('已在草稿中启用这个场景的必要开关。请补齐账号、密钥及群选择后保存并应用。', 'info');
    }
    if (button.dataset.removeGroup !== undefined && draft) {
      draft.groups.splice(Number(button.dataset.removeGroup), 1);
      markDirty();
      renderGroups();
    }
  });
  $('#refresh-state').addEventListener('click', (event) => withButton(event.currentTarget, () => refreshState({ notify: true })));
  $('#save-draft').addEventListener('click', (event) => withButton(event.currentTarget, saveDraft));
  $('#apply-config').addEventListener('click', (event) => withButton(event.currentTarget, applyConfig));
  $('#discard-draft').addEventListener('click', (event) => withButton(event.currentTarget, async () => {
    if (!await openDialog('丢弃本次未保存修改', '<p>恢复到后台已经保存的草稿，当前尚未保存的输入将丢弃。不会修改正在运行的配置。</p>', '丢弃修改')) return;
    const next = await api('/api/state', undefined, 'GET');
    acceptState(next, { replaceDraft: true });
    toast('已恢复后台保存的草稿。');
  }));
  $('#add-group').addEventListener('click', (event) => withButton(event.currentTarget, async () => {
    if (!draft) throw new Error('请先连接管理服务。');
    if (!await openDialog('添加选定 QQ 群', '<label class="field">群号<input id="new-group-id" inputmode="numeric" pattern="[1-9][0-9]{3,19}" placeholder="请输入数字群号" required></label><label class="field">群名称<input id="new-group-name" placeholder="方便你识别的名称"></label><label class="field">使用方式<select id="new-group-mode"><option value="social">社交群 · DeepSeek 聊天</option><option value="work">工作群 · 只读通知汇总</option></select></label><p>机器人账号必须已加入该群。添加后需保存并应用。</p>', '加入草稿')) return;
    const id = $('#new-group-id').value.trim();
    if (!/^[1-9]\d{3,19}$/.test(id)) throw new Error('群号应为 4–20 位数字，请重新添加。');
    if ((draft.groups ?? []).some((group) => group.id === id)) throw new Error('这个群已在草稿中。');
    draft.groups ??= [];
    draft.groups.push({ id, name: $('#new-group-name').value.trim(), mode: $('#new-group-mode').value, trigger: 'mention', prefix: '/ai', probability: 0.03, cooldownSeconds: 30 });
    markDirty();
    renderGroups();
    toast('已加入草稿；保存并应用后开始处理。', 'info');
  }));
  $('#setup-install').addEventListener('click', (event) => withButton(event.currentTarget, async () => {
    const modules = ['napcat', 'codex'].filter((id) => $(`#setup-${id}`).checked);
    if (!modules.length) throw new Error('请至少选择一个外部模块。');
    await mutate('/api/setup/install', { modules }, '一键安装任务已提交。NapCat 安装后会尝试启动，真实结果见任务输出。');
    navigate('modules');
  }));
  $('#open-napcat').addEventListener('click', (event) => withButton(event.currentTarget, openNapcatGuide));
  $('#export-config').addEventListener('click', (event) => withButton(event.currentTarget, async () => {
    if (window.qqBridgeDesktop?.exportConfig) {
      const result = await window.qqBridgeDesktop.exportConfig();
      if (result?.canceled) return;
      if (result?.ok !== true) throw new Error(result?.error || '桌面配置导出未完成。');
      toast('已保存脱敏配置，不含密钥和当前未保存的修改。');
      return;
    }
    const config = await api('/api/config/export', undefined, 'GET');
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `QQ_Service-config-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('已导出后台保存的脱敏配置，不含当前未保存修改。');
  }));
  $('#rollback-config').addEventListener('click', (event) => withButton(event.currentTarget, async () => {
    if (!await openDialog('回滚到上一份已应用配置', `<p>后台将恢复上一份已应用配置并重新加载运行设置。</p><p>已发送的消息、历史记录和密钥变更不会随普通配置回滚。</p>${dirty ? '<p><strong>当前页面未保存的修改也将丢弃。</strong></p>' : ''}`, '回滚配置')) return;
    const result = await api('/api/config/rollback', {});
    acceptState(result, { replaceDraft: true });
    toast('后台已返回回滚后的配置，请核对运行状态。');
  }));
  $('#preview-policy').addEventListener('click', (event) => withButton(event.currentTarget, async () => {
    const messageType = $('#preview-type').value;
    const result = await api('/api/policy/preview', { userId: $('#preview-user').value.trim(), ...(messageType === 'group' ? { groupId: $('#preview-group').value.trim() } : {}), message: $('#preview-message').value, messageType });
    $('#policy-result').textContent = JSON.stringify(result, null, 2);
    $('#policy-result').classList.remove('hidden');
  }));
  $('#preview-type').addEventListener('change', () => { $('#preview-group').disabled = $('#preview-type').value === 'private'; });
  window.addEventListener('beforeunload', (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
  window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));
  if (window.qqBridgeDesktop?.isDesktop) {
    $('.sidebar-version span').textContent = window.qqBridgeDesktop.version || '0.2.1';
    $('.sidebar-note small').textContent = '关闭窗口后继续在托盘运行；菜单“退出”停止后台。';
    $('.page-footer span').textContent = 'QQ_Service · Windows 桌面应用';
    $('.page-footer span:last-child').textContent = '关闭窗口留在托盘 · 菜单退出停止后台';
  }
  navigate(location.hash.slice(1));
  refreshState();
  setInterval(() => {
    if (document.visibilityState === 'visible') refreshState();
  }, 4000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshState(); });
})();
