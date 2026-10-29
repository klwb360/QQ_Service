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
      $('#memory-group-control').classList.toggle('hidden', !currentGroup);
      $('#memory-group-enabled').checked = enabled;
      $('#memory-group-enabled').disabled = busy;
      $('#memory-group-state').textContent = pending ? enabled ? '正在启用…' : '正在暂停…' : enabled ? '群记忆已启用' : '群记忆已暂停';
      $('#memory-paused').classList.toggle('hidden', !currentGroup || enabled);
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

    function render() { renderTree(); renderScope(); renderList(); }
    async function refreshTree(profileId) {
      const data = await request(profileId, '/memory/tree', undefined, 'GET');
      if (!Array.isArray(data.identities) && !Array.isArray(data.accounts)) throw new Error('记忆目录响应不完整，请刷新重试。');
      trees.set(profileId, data);
    }
    async function loadRecords() {
      const token = ++generation;
      if (!scope?.profileId || !scope.actualQQ) { records = []; render(); return; }
      const captured = { ...scope };
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
      selectedId = ''; records = []; clearError();
      $('#memory-directory').classList.remove('memory-directory-visible');
      $('#memory-directory-toggle').setAttribute('aria-expanded', 'false');
      render();
      await loadRecords();
    }
    async function refresh() {
      clearError();
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
      render();
      await loadRecords();
    }
    async function run(operation, target = '#memory-error') {
      if (busy) return;
      busy = true; clearError(target); renderScope(); renderDetail();
      try { await operation(); }
      catch (error) { showError(error, target); }
      finally { busy = false; renderScope(); renderDetail(); }
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
    dialog.addEventListener('click', event => {
      const target = event.target.closest('button');
      if (!target) return;
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
