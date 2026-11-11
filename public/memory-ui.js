'use strict';

// Real account-scoped memory data. This view never writes account configuration
// or changes QQ sending permissions.
window.QQMemoryUI = {
  create({ getAccounts, getSelectedAccountId, request, notify }) {
    const $ = selector => document.querySelector(selector);
    const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
    const labels = { pending: '待确认', confirmed: '已确认', rejected: '已拒绝' };
    const dialog = $('#memory-dialog');
    const trees = new Map();
    let profiles = [], scope = null, records = [], selectedId = '', generation = 0;
    let busy = false, editing = null, deleting = null, pendingGroup = null, searchTimer = null;
    let section = 'facts', experienceRecords = [], experienceGroup = null, sessionState = null, experienceFilter = 'active', editingExperience = null;
    const time = value => {
      if (!value) return '时间未提供';
      const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
    };
    const showError = (error, target = '#memory-error') => {
      const element = $(target);
      element.textContent = error?.message || String(error || '操作未完成');
      element.classList.remove('hidden');
    };
    const clearError = (target = '#memory-error') => { $(target).classList.add('hidden'); $(target).textContent = ''; };
    const profile = id => profiles.find(item => item.id === id);
    const identities = id => trees.get(id)?.identities ?? trees.get(id)?.accounts ?? [];
    const identity = () => identities(scope?.profileId).find(item => item.actualQQ === scope?.actualQQ);
    const group = () => identity()?.groups?.find(item => item.groupId === scope?.groupId);
    const memberName = (userId, groupId = scope?.groupId) => identity()?.groups?.find(item => item.groupId === groupId)?.members?.find(item => item.userId === userId)?.name || userId;
    const badge = status => `<span class="memory-badge memory-badge-${escape(status)}">${escape(labels[status] || status)}</span>`;
    const total = counts => Number(counts?.total) || 0;
    const scopeMatches = candidate => scope && ['profileId', 'actualQQ', 'groupId', 'userId'].every(key => (scope[key] || '') === (candidate[key] || ''));
    const scopeAttrs = value => `data-memory-profile="${escape(value.profileId)}" data-memory-qq="${escape(value.actualQQ || '')}" data-memory-group="${escape(value.groupId || '')}" data-memory-user="${escape(value.userId || '')}"`;

    function renderTree() {
      const oldOpen = new Set([...$('#memory-tree').querySelectorAll('details[open]')].map(item => item.dataset.memoryDirectory));
      $('#memory-tree').innerHTML = profiles.length ? profiles.map(account => {
        const qqs = identities(account.id);
        const selected = scope?.profileId === account.id;
        return `<details class="memory-tree-account" data-memory-directory="${escape(account.id)}" ${selected || oldOpen.has(account.id) ? 'open' : ''}><summary>${escape(account.name || 'QQ 账号')}<small>${escape(account.qqNumber || '')}</small></summary>${qqs.length ? qqs.map(qq => {
          const root = { profileId: account.id, actualQQ: qq.actualQQ };
          return `<div class="memory-tree-identity"><button type="button" class="memory-tree-select ${scopeMatches(root) ? 'selected' : ''}" ${scopeAttrs(root)}><span aria-hidden="true">Q</span><span>QQ ${escape(qq.actualQQ)}</span></button>${(qq.groups || []).map(entry => {
            const item = { ...root, groupId: entry.groupId };
            const key = `${account.id}:${qq.actualQQ}:${entry.groupId}`;
            return `<details class="memory-tree-group" data-memory-directory="${escape(key)}" ${scope?.profileId === account.id && scope?.actualQQ === qq.actualQQ && scope?.groupId === entry.groupId || oldOpen.has(key) ? 'open' : ''}><summary><button type="button" class="memory-tree-select ${scopeMatches(item) ? 'selected' : ''}" ${scopeAttrs(item)}><span aria-hidden="true">▱</span><span>${escape(entry.name || entry.groupId)}</span><small>${total(entry.counts)}</small></button></summary><div class="memory-tree-members">${(entry.members || []).map(member => {
              const selection = { ...item, userId: member.userId };
              return `<button type="button" class="memory-tree-select ${scopeMatches(selection) ? 'selected' : ''}" ${scopeAttrs(selection)}><span aria-hidden="true">·</span><span>${escape(member.name || member.userId)}</span><small>${total(member.counts)}</small></button>`;
            }).join('') || '<p class="memory-tree-empty">还没有群友记录</p>'}</div></details>`;
          }).join('') || '<p class="memory-tree-empty">请先在账号权限中选定群</p>'}</div>`;
        }).join('') : '<p class="memory-tree-empty">暂无可用 QQ 身份</p>'}</details>`;
      }).join('') : '<div class="memory-empty"><strong>还没有账号配置</strong>在账号页面创建账号后，记忆目录会显示在这里。</div>';
    }

    function filteredRecords() {
      const query = $('#memory-search').value.trim().toLocaleLowerCase();
      const status = $('#memory-status').value;
      return records.filter(record => (!scope?.userId || record.userId === scope.userId)
        && (status === 'all' || record.status === status)
        && (!query || `${record.text} ${record.userId} ${memberName(record.userId, record.groupId)}`.toLocaleLowerCase().includes(query)))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    }

    function renderScope() {
      const account = profile(scope?.profileId);
      const currentGroup = group();
      const pending = pendingGroup && scope?.profileId === pendingGroup.profileId && scope?.actualQQ === pendingGroup.actualQQ && scope?.groupId === pendingGroup.groupId;
      const enabled = pending ? pendingGroup.enabled : currentGroup?.enabled === true;
      const qq = identity();
      const parts = scope ? [
        `<span>${escape(account?.name || 'QQ 账号')}</span>`,
        `<button type="button" ${scopeAttrs({ profileId: scope.profileId, actualQQ: scope.actualQQ })}>QQ ${escape(scope.actualQQ)}</button>`,
        ...(currentGroup ? [`<button type="button" ${scopeAttrs({ ...scope, userId: '' })}>${escape(currentGroup.name || currentGroup.groupId)}</button>`] : []),
        ...(scope.userId ? [`<span class="memory-breadcrumb-current">${escape(memberName(scope.userId))}</span>`] : [])
      ] : [];
      $('#memory-breadcrumbs').innerHTML = parts.join('<span aria-hidden="true">›</span>');
      $('#memory-scope-title').textContent = scope?.userId ? memberName(scope.userId) : currentGroup ? currentGroup.name || currentGroup.groupId : qq ? `QQ ${qq.actualQQ} 的记忆` : '选择记忆目录';
      $('#memory-scope-note').textContent = scope?.userId ? `QQ ${scope.userId} · 仅在当前群使用已确认记忆` : currentGroup ? `群 ${currentGroup.groupId} · 只使用你确认的事实与偏好` : '从左侧选择群或群友，查看来源并管理记忆。';
      $('#memory-group-control').classList.toggle('hidden', !currentGroup || section !== 'facts');
      $('#memory-group-enabled').checked = enabled;
      $('#memory-group-enabled').disabled = busy;
      $('#memory-group-state').textContent = pending ? enabled ? '正在启用…' : '正在暂停…' : enabled ? '群记忆已启用' : '群记忆已暂停';
      $('#memory-paused').classList.toggle('hidden', !currentGroup || enabled || section !== 'facts');
      $('#memory-add').disabled = busy || !qq?.groups?.length;
      $('#memory-refresh').disabled = busy;
    }

    function renderList() {
      const visible = filteredRecords();
      if (!visible.some(record => record.id === selectedId)) selectedId = visible[0]?.id || '';
      $('#memory-list-count').textContent = `${visible.length} 条记忆`;
      $('#memory-list').innerHTML = visible.length ? visible.map(record => `<button type="button" class="memory-row ${record.id === selectedId ? 'selected' : ''}" data-memory-record="${escape(record.id)}" aria-pressed="${record.id === selectedId}"><span class="memory-row-heading"><span class="memory-member-label"><span class="memory-member-avatar">${escape(String(memberName(record.userId, record.groupId)).slice(0, 1))}</span>${escape(memberName(record.userId, record.groupId))}</span>${badge(record.status)}</span><span class="memory-row-text">${escape(record.text)}</span><span class="memory-row-meta"><span>${record.origin === 'manual' ? '手动新增' : '来自群友原话'} · ${record.kind === 'preference' ? '偏好' : '事实'}</span><span>${escape(time(record.updatedAt))}</span></span></button>`).join('') : `<div class="memory-empty"><span class="memory-empty-icon" aria-hidden="true">▤</span><strong>${$('#memory-search').value || $('#memory-status').value !== 'all' ? '没有符合条件的记忆' : '这里还没有记忆'}</strong><p>${scope?.groupId && !group()?.enabled ? '可先启用这个群的记忆，或手动添加一条。' : 'AI 会随已有回复整理候选，确认后才用于后续聊天。'}</p></div>`;
      renderDetail();
    }

    function renderDetail() {
      const record = records.find(item => item.id === selectedId);
      if (!record) { $('#memory-detail').innerHTML = '<div class="memory-empty"><strong>记忆详情</strong><p>选择一条记忆，查看原文依据。</p></div>'; return; }
      const isPending = record.status === 'pending';
      $('#memory-detail').innerHTML = `<div class="memory-detail-heading"><h3>记忆详情</h3>${badge(record.status)}</div><p class="memory-detail-member">${escape(memberName(record.userId, record.groupId))}<small>QQ ${escape(record.userId)}</small></p><p class="memory-detail-text">${escape(record.text)}</p><p class="memory-detail-meta">${record.kind === 'preference' ? '偏好' : '事实'} · ${record.origin === 'manual' ? '由你手动添加' : '由 AI 提出'}<br>更新于 ${escape(time(record.updatedAt))}</p><div class="memory-detail-actions">${isPending ? '<button type="button" class="button button-primary button-small" data-memory-action="confirm">确认使用</button><button type="button" class="button button-quiet button-small" data-memory-action="reject">拒绝</button>' : record.status === 'rejected' ? '<button type="button" class="button button-secondary button-small" data-memory-action="confirm">确认使用</button>' : ''}<button type="button" class="button button-secondary button-small" data-memory-action="edit">编辑</button><button type="button" class="button button-quiet button-small memory-delete-button" data-memory-action="delete">删除</button></div><section class="memory-evidence"><h4>原文依据</h4>${record.sources?.length ? record.sources.map(source => `<blockquote><p>${escape(source.text)}</p><footer>QQ ${escape(source.userId || record.userId)} · ${escape(time(source.time))}<br>消息 ${escape(source.messageId || '未提供')}</footer></blockquote>`).join('') : '<p class="field-note">这条记忆由你手动添加，没有关联群消息。</p>'}</section><p class="memory-detail-note">${isPending ? '这条记忆尚未确认，不会参与 AI 回答。' : record.status === 'rejected' ? '已拒绝，不会参与 AI 回答。' : '只在这个账号、这个群内使用。'}</p>`;
      $('#memory-detail').querySelectorAll('button').forEach(button => { button.disabled = busy; });
    }

    function renderSections() {
      const facts = section === 'facts';
      document.querySelectorAll('[data-memory-tab]').forEach(button => {
        const active = button.dataset.memoryTab === section;
        button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active));
      });
      $('.memory-toolbar').classList.toggle('hidden', !facts);
      $('.memory-content').classList.toggle('hidden', !facts);
      $('#experience-workspace').classList.toggle('hidden', section !== 'experiences');
      $('#conversation-workspace').classList.toggle('hidden', section !== 'session');
      $('.memory-manager-footer').textContent = facts ? 'AI 随已有回复整理候选，由你确认后使用；只记录明确事实与偏好。' : section === 'experiences' ? '札记随真实互动自动积累；每个群独立保存，可暂停或回退，不改变人格和发送权限。' : '会话状态帮助接续当前话题，会过期；不会自动成为永久事实。';
      if (!facts) {
        $('#memory-scope-title').textContent = group() ? `${group().name || scope.groupId} · ${section === 'experiences' ? '经历札记' : '当前会话'}` : '先选择一个群';
        $('#memory-scope-note').textContent = group() ? `QQ ${scope.actualQQ} · 群 ${scope.groupId}` : '从左侧目录选择群，查看此群独立保存的内容。';
      }
    }
    const experienceKinds = { interaction: '共同经历', expression: '表达习惯', pending_topic: '待续话题' };
    function renderExperiences() {
      const container = $('#experience-workspace');
      if (!scope?.groupId) { container.innerHTML = '<div class="memory-empty"><strong>先选择一个群</strong><p>经历札记只在对应账号和群内使用。</p></div>'; return; }
      const filtered = experienceRecords.filter(record => record.status === experienceFilter);
      container.innerHTML = `<div class="experience-toolbar"><label class="check-field"><input type="checkbox" id="experience-enabled" ${experienceGroup?.paused !== true ? 'checked' : ''} ${busy ? 'disabled' : ''}>自动积累与使用札记</label><select id="experience-status" aria-label="札记状态"><option value="active" ${experienceFilter === 'active' ? 'selected' : ''}>活跃札记</option><option value="archived" ${experienceFilter === 'archived' ? 'selected' : ''}>已归档</option></select></div><p class="field-note experience-scope-note">${experienceGroup?.eligible === false ? '这个群尚未同时开启读取和自由聊天，暂不积累新札记。' : experienceGroup?.paused ? '已暂停此群的积累与使用，已有记录保留。' : '随已有聊天记录简短经历，不增加定时模型调用。'}</p><div class="experience-list">${filtered.length ? filtered.map(record => `<article class="experience-card" data-experience-record="${escape(record.id)}"><div class="experience-card-heading"><span class="memory-badge">${escape(experienceKinds[record.kind] || '经历')}</span><span>${escape(time(record.updatedAt))}</span></div><p class="experience-text">${escape(record.text)}</p><div class="experience-card-actions">${record.status !== 'deleted' ? `<button type="button" class="button button-quiet button-small" data-experience-action="edit">编辑</button><button type="button" class="button button-quiet button-small" data-experience-action="${record.status === 'active' ? 'archive' : 'restore'}">${record.status === 'active' ? '归档' : '恢复使用'}</button><button type="button" class="button button-quiet button-small" data-experience-action="delete">删除</button>` : ''}<button type="button" class="button button-quiet button-small" data-experience-action="history">版本记录</button></div><details class="experience-sources"><summary>互动来源 · ${record.sources?.length || 0} 条</summary>${(record.sources || []).map(source => `<blockquote><p>${escape(source.text)}</p><footer>${source.role === 'assistant' ? 'AI 已发送回复' : `QQ ${escape(source.userId || '')}`} · ${escape(time(source.time))}<br>消息 ${escape(source.messageId || '')}</footer></blockquote>`).join('') || '<p class="field-note">没有关联来源。</p>'}</details><div class="experience-history" data-experience-history></div></article>`).join('') : '<div class="memory-empty"><strong>这里还没有札记</strong><p>开启自由聊天后，AI 可从真实互动中积累简短经历。</p></div>'}</div>`;
    }
    function renderSession() {
      const container = $('#conversation-workspace');
      if (!scope?.groupId) { container.innerHTML = '<div class="memory-empty"><strong>先选择一个群</strong><p>当前话题和参与者按群分别维护。</p></div>'; return; }
      const item = sessionState;
      if (!item) { container.innerHTML = '<div class="memory-empty"><strong>暂无当前会话</strong><p>群里发生互动后，这里会显示正在聊的话题和参与者。</p></div>'; return; }
      container.innerHTML = `<div class="conversation-heading"><span class="memory-badge">${item.expired ? '会话已过期' : '当前会话'}</span><button type="button" class="button button-quiet button-small" data-conversation-clear ${busy ? 'disabled' : ''}>重置会话状态</button></div><section class="conversation-section"><h4>正在聊什么</h4><p>${escape(item.topic || '还没有明确话题')}</p></section><section class="conversation-section"><h4>待续话题</h4>${item.pendingTopics?.length ? `<ul>${item.pendingTopics.map(topic => `<li>${escape(typeof topic === 'string' ? topic : topic.text || '')}</li>`).join('')}</ul>` : '<p class="field-note">暂无待续事项。</p>'}</section><section class="conversation-section"><h4>最近参与者</h4><div class="conversation-participants">${(item.participants || []).map(person => `<span>${escape(person.displayName || person.userId || 'AI')}${person.userId ? `<small>QQ ${escape(person.userId)}</small>` : ''}</span>`).join('') || '<p class="field-note">暂无参与者。</p>'}</div></section><p class="field-note">最近互动：${escape(time(item.lastInteractionAt))}${item.expiresAt ? `<br>状态到期：${escape(time(item.expiresAt))}` : ''}<br>重置只清空当前会话状态，保留历史消息、札记和群友记忆。</p>`;
    }
    function render() { renderTree(); renderScope(); renderSections(); if (section === 'facts') renderList(); else if (section === 'experiences') renderExperiences(); else renderSession(); }
    async function refreshTree(profileId) {
      const data = await request(profileId, '/memory/tree', undefined, 'GET');
      if (!Array.isArray(data.identities) && !Array.isArray(data.accounts)) throw new Error('记忆目录响应不完整，请刷新重试。');
      trees.set(profileId, data);
    }
    async function loadRecords() {
      const token = ++generation;
      if (!scope?.profileId || !scope.actualQQ) { records = []; render(); return; }
      const captured = { ...scope };
      if (section !== 'facts') {
        const capturedSection = section;
        if (!captured.groupId) { experienceRecords = []; experienceGroup = null; sessionState = null; render(); return; }
        const params = new URLSearchParams({ actualQQ: captured.actualQQ, groupId: captured.groupId, ...(section === 'experiences' ? { status: 'all' } : {}) });
        const data = await request(captured.profileId, `/${section === 'experiences' ? 'experiences' : 'conversation/state'}?${params}`, undefined, 'GET');
        if (token !== generation || !scopeMatches(captured) || section !== capturedSection) return;
        if (section === 'experiences') { experienceRecords = Array.isArray(data.records) ? data.records : []; experienceGroup = data.group || null; }
        else sessionState = data.state || null;
        render(); return;
      }
      const params = new URLSearchParams({ actualQQ: captured.actualQQ, ...(captured.groupId ? { groupId: captured.groupId } : {}), ...(captured.userId ? { userId: captured.userId } : {}), status: $('#memory-status').value, query: $('#memory-search').value.trim() });
      const data = await request(captured.profileId, `/memory?${params}`, undefined, 'GET');
      if (token !== generation || !scopeMatches(captured)) return;
      records = Array.isArray(data.records) ? data.records : [];
      for (const item of data.groups || []) {
        const qq = identities(captured.profileId).find(entry => entry.actualQQ === item.actualQQ);
        const found = qq?.groups?.find(entry => entry.groupId === item.groupId);
        if (found) Object.assign(found, item);
      }
      render();
    }
    async function select(value) {
      scope = { profileId: value.profileId, actualQQ: value.actualQQ || '', groupId: value.groupId || '', userId: value.userId || '' };
      selectedId = ''; records = []; experienceRecords = []; experienceGroup = null; sessionState = null; clearError();
      $('#memory-directory').classList.remove('memory-directory-visible');
      $('#memory-directory-toggle').setAttribute('aria-expanded', 'false');
      render();
      await loadRecords();
    }
    async function refresh() {
      clearError();
      const previousScope = JSON.stringify(scope);
      profiles = getAccounts().map(account => ({ ...account }));
      const results = await Promise.allSettled(profiles.map(account => refreshTree(account.id)));
      const failed = results.find(result => result.status === 'rejected');
      if (failed) showError(failed.reason);
      const available = profiles.filter(account => identities(account.id).length);
      if (!scope || !available.some(account => account.id === scope.profileId) || !identity()) {
        const first = available.find(account => account.id === getSelectedAccountId()) || available[0];
        const qq = first && identities(first.id)[0];
        scope = qq ? { profileId: first.id, actualQQ: qq.actualQQ, groupId: qq.groups?.[0]?.groupId || '', userId: '' } : null;
      } else if (scope.groupId && !group()) scope = { ...scope, groupId: '', userId: '' };
      if (JSON.stringify(scope) !== previousScope) { records = []; experienceRecords = []; experienceGroup = null; sessionState = null; }
      render();
      await loadRecords();
    }
    function activityBusy() {
      document.querySelectorAll('[data-memory-tab], #experience-workspace button, #experience-workspace input, #experience-workspace select, #conversation-workspace button').forEach(element => { element.disabled = busy; });
    }
    async function run(operation, target = '#memory-error') {
      if (busy) return;
      busy = true; clearError(target); renderScope(); renderSections(); renderDetail(); activityBusy();
      try { await operation(); }
      catch (error) { showError(error, target); }
      finally { busy = false; renderScope(); renderSections(); renderDetail(); activityBusy(); }
    }
    async function reloadAfterChange(profileId) {
      await refreshTree(profileId);
      await loadRecords();
    }
    function openEditor(record = null) {
      const qq = identity();
      if (!qq?.groups?.length) return;
      editing = record ? { ...record, profileId: scope.profileId } : { profileId: scope.profileId, actualQQ: scope.actualQQ };
      clearError('#memory-edit-error');
      $('#memory-edit-title').textContent = record ? '编辑记忆' : '新增记忆';
      $('#memory-edit-note').textContent = `${profile(scope.profileId)?.name || 'QQ 账号'} · QQ ${scope.actualQQ}${record?.status === 'pending' ? ' · 编辑后仍需确认才能使用' : ''}`;
      $('#memory-edit-group').innerHTML = qq.groups.map(entry => `<option value="${escape(entry.groupId)}">${escape(entry.name || entry.groupId)} · ${escape(entry.groupId)}</option>`).join('');
      $('#memory-edit-group').value = record?.groupId || scope.groupId || qq.groups[0].groupId;
      $('#memory-edit-group').disabled = Boolean(record);
      $('#memory-edit-user').value = record?.userId || scope.userId || '';
      $('#memory-edit-user').readOnly = Boolean(record);
      $('#memory-edit-text').value = record?.text || '';
      $('#memory-edit-kind').value = record?.kind || 'fact';
      $('#memory-edit-save').textContent = record ? '保存' : '保存并确认';
      populateMembers();
      $('#memory-edit-dialog').showModal();
      (record ? $('#memory-edit-text') : $('#memory-edit-user')).focus();
    }
    function populateMembers() {
      const qq = identities(editing?.profileId).find(item => item.actualQQ === editing?.actualQQ);
      const currentGroup = qq?.groups?.find(item => item.groupId === $('#memory-edit-group').value);
      $('#memory-member-options').innerHTML = (currentGroup?.members || []).map(member => `<option value="${escape(member.userId)}">${escape(member.name || member.userId)}</option>`).join('');
    }
    async function act(action, record) {
      if (!scope || !record) return;
      const profileId = scope.profileId;
      await request(profileId, '/memory/action', { action, id: record.id, version: record.version, actualQQ: record.actualQQ, groupId: record.groupId, userId: record.userId });
      await reloadAfterChange(profileId);
      notify?.(action === 'confirm' ? '已确认这条记忆，后续聊天可使用。' : '已拒绝这条记忆。');
    }
    const experienceScope = record => ({ actualQQ: record?.actualQQ || scope.actualQQ, groupId: record?.groupId || scope.groupId });
    async function actExperience(action, record, extra = {}) {
      const profileId = scope.profileId;
      await request(profileId, '/experiences/action', { action, ...experienceScope(record), id: record.id, version: record.version, ...extra });
      await loadRecords();
      notify?.(action === 'delete' ? '札记及其历史已删除。' : action === 'rollback' ? '札记已回退到所选版本。' : '札记已更新。');
    }
    function editExperience(record, action = 'update') {
      editingExperience = { ...record, profileId: scope.profileId, actualQQ: scope.actualQQ, groupId: scope.groupId, action };
      const deleting = action === 'delete';
      $('#experience-edit-title').textContent = deleting ? '删除这条经历札记？' : '编辑经历札记';
      $('#experience-edit-text').value = record.text;
      $('#experience-edit-text').readOnly = deleting;
      $('#experience-edit-save').textContent = deleting ? '确认删除' : '保存';
      $('#experience-edit-save').classList.toggle('button-danger', deleting);
      $('#experience-edit-dialog .field-note').textContent = deleting ? '删除正文、互动来源和历史版本后无法回退；不影响群友记忆或基础人格。' : '这里只修改当前群的经历，不会改变基础人格或群友事实。';
      clearError('#experience-edit-error');
      $('#experience-edit-dialog').showModal();
      if (!deleting) $('#experience-edit-text').focus();
    }
    async function experienceHistory(record) {
      const params = new URLSearchParams({ ...experienceScope(record), id: record.id });
      const data = await request(scope.profileId, `/experiences/history?${params}`, undefined, 'GET');
      const panel = [...document.querySelectorAll('[data-experience-record]')].find(item => item.dataset.experienceRecord === record.id)?.querySelector('[data-experience-history]');
      if (!panel) return;
      const revisions = data.revisions || [];
      panel.innerHTML = revisions.length ? `<label class="field">回退到<select data-experience-version>${revisions.map(revision => `<option value="${escape(revision.version)}">版本 ${escape(revision.version)} · ${escape(time(revision.updatedAt || revision.createdAt))} · ${escape(String(revision.text || '').slice(0, 45))}</option>`).join('')}</select></label><button type="button" class="button button-secondary button-small" data-experience-action="rollback">回退札记</button>` : '<p class="field-note">暂无历史版本。</p>';
    }

    $('#open-memory-manager').addEventListener('click', () => {
      if (!dialog.open) dialog.showModal();
      run(refresh);
    });
    $('#memory-close').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { generation++; });
    $('#memory-refresh').addEventListener('click', () => run(refresh));
    $('#memory-directory-toggle').addEventListener('click', () => {
      const open = $('#memory-directory').classList.toggle('memory-directory-visible');
      $('#memory-directory-toggle').setAttribute('aria-expanded', String(open));
    });
    $('.memory-section-tabs').addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || busy) return;
      const tabs = [...document.querySelectorAll('[data-memory-tab]')];
      const current = tabs.indexOf(document.activeElement);
      if (current < 0) return;
      event.preventDefault();
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[index].focus(); tabs[index].click();
    });
    dialog.addEventListener('click', event => {
      const target = event.target.closest('button');
      if (!target) return;
      if (target.dataset.memoryTab) {
        section = target.dataset.memoryTab;
        if (section !== 'facts' && scope) scope = { ...scope, userId: '' };
        clearError(); render(); run(loadRecords); return;
      }
      if (target.dataset.experienceAction) {
        const card = target.closest('[data-experience-record]');
        const record = experienceRecords.find(item => item.id === card?.dataset.experienceRecord);
        if (!record) return;
        const action = target.dataset.experienceAction;
        if (action === 'edit' || action === 'delete') editExperience(record, action === 'edit' ? 'update' : 'delete');
        else if (action === 'history') run(() => experienceHistory(record));
        else run(() => actExperience(action, record, action === 'rollback' ? { targetVersion: Number(card.querySelector('[data-experience-version]').value) } : {}));
        return;
      }
      if (target.hasAttribute('data-conversation-clear')) {
        if (scope?.groupId && sessionState) run(async () => {
          await request(scope.profileId, '/conversation/clear', { actualQQ: scope.actualQQ, groupId: scope.groupId, version: sessionState.version });
          await loadRecords(); notify?.('已重置当前会话状态，历史记忆和札记保留。');
        });
        return;
      }
      if (target.hasAttribute('data-memory-profile')) {
        event.preventDefault();
        const data = target.dataset;
        select({ profileId: data.memoryProfile, actualQQ: data.memoryQq, groupId: data.memoryGroup, userId: data.memoryUser }).catch(showError);
      } else if (target.hasAttribute('data-memory-record')) {
        selectedId = target.dataset.memoryRecord; renderList();
      } else if (target.dataset.memoryAction) {
        const record = records.find(item => item.id === selectedId);
        if (!record) return;
        if (target.dataset.memoryAction === 'edit') openEditor(record);
        else if (target.dataset.memoryAction === 'delete') {
          deleting = { ...record, profileId: scope.profileId };
          $('#memory-delete-preview').textContent = record.text;
          clearError('#memory-delete-error'); $('#memory-delete-dialog').showModal();
        } else run(() => act(target.dataset.memoryAction, record));
      }
    });
    $('#memory-search').addEventListener('input', () => {
      clearTimeout(searchTimer); generation++; renderList();
      searchTimer = setTimeout(() => loadRecords().catch(showError), 180);
    });
    $('#memory-status').addEventListener('change', () => { renderList(); loadRecords().catch(showError); });
    dialog.addEventListener('change', event => {
      if (event.target.id === 'experience-status') { experienceFilter = event.target.value; renderExperiences(); }
      if (event.target.id === 'experience-enabled' && scope?.groupId) {
        const paused = !event.target.checked;
        run(async () => {
          await request(scope.profileId, '/experiences/group', { actualQQ: scope.actualQQ, groupId: scope.groupId, paused, version: experienceGroup?.version || 0 });
          await loadRecords(); notify?.(paused ? '已暂停此群经历札记的积累与使用。' : '已恢复此群经历札记的积累与使用。');
        });
      }
    });
    ['#experience-edit-close', '#experience-edit-cancel'].forEach(selector => $(selector).addEventListener('click', () => $('#experience-edit-dialog').close()));
    $('#experience-edit-form').addEventListener('submit', event => {
      event.preventDefault();
      if (!editingExperience || !$('#experience-edit-form').reportValidity()) return;
      const item = { ...editingExperience };
      run(async () => {
        $('#experience-edit-save').disabled = true;
        try {
          await request(item.profileId, '/experiences/action', { action: item.action, actualQQ: item.actualQQ, groupId: item.groupId, id: item.id, version: item.version, ...(item.action === 'update' ? { text: $('#experience-edit-text').value.trim() } : {}) });
          $('#experience-edit-dialog').close(); await loadRecords(); notify?.(item.action === 'delete' ? '札记及其历史已删除。' : '札记已保存。');
        } finally { $('#experience-edit-save').disabled = false; }
      }, '#experience-edit-error');
    });
    $('#memory-add').addEventListener('click', () => openEditor());
    $('#memory-group-enabled').addEventListener('change', event => {
      if (!scope?.groupId) return;
      const captured = { ...scope }, enabled = event.target.checked;
      pendingGroup = { ...captured, enabled };
      run(async () => {
        try {
          await request(captured.profileId, '/memory/group', { actualQQ: captured.actualQQ, groupId: captured.groupId, enabled });
          await reloadAfterChange(captured.profileId);
          notify?.(enabled ? '已启用这个群的记忆；AI 候选经确认后使用。' : '已暂停这个群的记忆，已有记录保留。');
        } finally { pendingGroup = null; }
      });
    });
    $('#memory-edit-group').addEventListener('change', populateMembers);
    ['#memory-edit-close', '#memory-edit-cancel'].forEach(selector => $(selector).addEventListener('click', () => $('#memory-edit-dialog').close()));
    $('#memory-edit-form').addEventListener('submit', event => {
      event.preventDefault();
      if (!editing || !$('#memory-edit-form').reportValidity()) return;
      const item = { ...editing }, text = $('#memory-edit-text').value.trim(), groupId = $('#memory-edit-group').value, userId = $('#memory-edit-user').value.trim(), kind = $('#memory-edit-kind').value;
      if (!text) return showError('请填写记忆内容。', '#memory-edit-error');
      run(async () => {
        $('#memory-edit-save').disabled = true;
        try {
          const response = await request(item.profileId, '/memory/action', { action: item.id ? 'update' : 'create', actualQQ: item.actualQQ, groupId, userId, text, kind, ...(item.id ? { id: item.id, version: item.version } : {}) });
          if (!item.id) {
            scope = { profileId: item.profileId, actualQQ: item.actualQQ, groupId, userId: '' };
            selectedId = response.record?.id || '';
            $('#memory-status').value = 'all'; $('#memory-search').value = '';
          }
          $('#memory-edit-dialog').close();
          await reloadAfterChange(item.profileId);
          notify?.(item.id ? '记忆已保存。' : '已新增并确认记忆。');
        } finally { $('#memory-edit-save').disabled = false; }
      }, '#memory-edit-error');
    });
    ['#memory-delete-close', '#memory-delete-cancel'].forEach(selector => $(selector).addEventListener('click', () => $('#memory-delete-dialog').close()));
    $('#memory-delete-confirm').addEventListener('click', () => {
      if (!deleting) return;
      const item = { ...deleting };
      run(async () => {
        $('#memory-delete-confirm').disabled = true;
        try {
          await request(item.profileId, '/memory/action', { action: 'delete', actualQQ: item.actualQQ, groupId: item.groupId, userId: item.userId, id: item.id, version: item.version });
          $('#memory-delete-dialog').close(); await reloadAfterChange(item.profileId); notify?.('记忆已删除。');
        } finally { $('#memory-delete-confirm').disabled = false; }
      }, '#memory-delete-error');
    });
    return { refresh: () => dialog.open ? refresh() : Promise.resolve() };
  }
};
