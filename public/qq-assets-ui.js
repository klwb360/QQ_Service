(() => {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const kinds = { sticker: '表情包', image: '图片', file: '文件' };
  const states = { checking: '核对中', running: '已提交，等待回执', succeeded: '已确认成功', denied: '未执行', cancelled: '已取消', unknown: '结果未确认，请勿直接重试', failed: '未完成' };
  window.QQAssetsUI = Object.freeze({ mount({ request, getAccountId, notify = () => {} }) {
    const parent = document.querySelector('#page-modules');
    if (!parent || typeof request !== 'function') return;
    const card = document.createElement('details'); card.className = 'card qq-assets-card'; card.id = 'qq-assets-card';
    card.innerHTML = `<summary class="mcp-section-heading"><span><strong>QQ 图片、表情与文件素材</strong><small>只发送你批准给所选群的素材；可补标签或用视觉模型识别。</small></span></summary><div class="qq-assets-content"><div class="form-grid"><label class="field">查看群<select data-asset-group></select></label><label class="field">搜索素材<input data-asset-query type="search" maxlength="200" placeholder="名称、情绪、标签…"></label><label class="field">视觉识别模型<select data-asset-vision></select><small>须为支持图片输入的 API 模型；DeepSeek 官方文字通道不能看图。点击识别才调用模型并计费。</small></label></div><div class="card-actions"><button type="button" class="button button-quiet" data-asset-refresh>刷新</button></div><details><summary>导入图片、表情包或文档</summary><div class="form-grid"><label class="field">文件<input data-asset-file type="file" accept=".png,.jpg,.jpeg,.gif,.webp,.txt,.md,.csv,.json,.pdf,.docx,.xlsx,.pptx"></label><label class="field">用途<select data-asset-kind><option value="sticker">表情包</option><option value="image">图片</option><option value="file">文件</option></select></label><label class="field">显示名称<input data-asset-name maxlength="120"></label><label class="field">标签<input data-asset-tags maxlength="800" placeholder="开心，疑惑，赞同"></label><label class="field">图片描述／使用语境<textarea data-asset-description rows="2" maxlength="1200"></textarea></label></div><p class="field-note">允许发送到的群</p><div class="group-social-tool-options" data-asset-groups></div><div class="card-actions"><button type="button" class="button button-quiet" data-asset-sync>从 QQ 收藏表情导入</button></div><p class="field-note">先连接 QQ，再把最多10个收藏表情导入所勾选的群；不自动调用视觉模型。暂不支持导入任意网页图片。</p><p class="field-note">图片／表情最多8MiB，视觉识别最多4MiB，文件最多20MiB。Office文档只作为文件传输，不代表已经读懂正文。GIF等动图分析不保证理解完整动画。</p><button type="button" class="button button-primary" data-asset-import>导入到所选群</button></details><p class="memory-error hidden" role="alert" data-asset-error></p><div class="qq-asset-grid" data-asset-list></div><details><summary>最近 QQ 动作回执</summary><p class="field-note">成功、未执行和结果未知分别记录；未知结果不会提供自动重试。</p><div data-asset-actions></div></details></div>`;
    parent.append(card);
    const find = selector => card.querySelector(selector);
    const group = find('[data-asset-group]'), query = find('[data-asset-query]'), vision = find('[data-asset-vision]');
    const editor = document.createElement('dialog'); editor.className = 'memory-edit-dialog';
    editor.innerHTML = '<form><h2>编辑素材描述</h2><label class="field">描述与使用语境<textarea data-edit-description maxlength="1200" rows="4"></textarea></label><label class="field">标签<input data-edit-tags maxlength="800"></label><label class="field">情绪<input data-edit-emotion maxlength="80"></label><label class="field">适合的语境<input data-edit-usage maxlength="400"></label><label class="field">避免的语境<input data-edit-avoid maxlength="400"></label><p class="memory-error hidden" data-edit-error role="alert"></p><div class="dialog-actions"><button type="button" class="button button-quiet" data-edit-cancel>取消</button><button type="submit" class="button button-primary">保存</button></div></form>';
    card.append(editor);
    let editing = null;
    let current = null, loadedAccount = '', loading = false, epoch = 0;
    const showError = error => { for (const node of [find('[data-asset-error]'), editor.open ? editor.querySelector('[data-edit-error]') : null].filter(Boolean)) { node.textContent = error?.message || String(error || ''); node.classList.toggle('hidden', !node.textContent); } };
    const busy = value => { loading = value; card.setAttribute('aria-busy', String(value)); card.querySelectorAll('button').forEach(button => { button.disabled = value; }); };
    const run = async action => { if (loading) return; busy(true); showError(''); try { await action(); } catch (error) { showError(error); } finally { busy(false); } };
    const render = value => {
      current = value;
      const selected = value.groupId || '', provider = vision.value;
      group.innerHTML = (value.groups || []).map(item => `<option value="${escape(item.id)}" ${item.id === selected ? 'selected' : ''}>${escape(item.name)} · ${escape(item.id)}</option>`).join('') || '<option value="">先应用一个允许读取的群</option>';
      vision.innerHTML = '<option value="">选择支持图片的 API 模型</option>' + (value.visionProviders || []).map(item => `<option value="${escape(item.id)}" ${item.id === provider ? 'selected' : ''}>${escape(item.label || item.id)} · ${escape(item.model)}</option>`).join('');
      find('[data-asset-groups]').innerHTML = (value.groups || []).map(item => `<label><input type="checkbox" data-asset-scope value="${escape(item.id)}" ${item.id === selected ? 'checked' : ''}><span>${escape(item.name)} · ${escape(item.id)}</span></label>`).join('');
      find('[data-asset-list]').innerHTML = (value.assets || []).map(asset => {
        const params = new URLSearchParams({ assetId: asset.assetId, actualQQ: value.actualQQ, groupId: selected });
        const preview = asset.kind !== 'file' ? `<img class="qq-asset-preview" loading="lazy" alt="${escape(asset.name)}" src="/api/accounts/${encodeURIComponent(loadedAccount)}/qq/assets/preview?${params}">` : '<span class="qq-asset-document">▤ 文件</span>';
        return `<article class="qq-asset-item" data-asset-id="${escape(asset.assetId)}">${preview}<strong>${escape(asset.name)}</strong><small>${escape(kinds[asset.kind] || asset.kind)} · ${(asset.byteLength / 1024).toFixed(1)} KiB · ${asset.analysisSource === 'vision' ? '已识别' : '手动标签'}</small><p>${escape(asset.description || '尚无描述，可编辑或使用视觉模型识别。')}</p><p class="field-note">${escape((asset.tags || []).join(' · '))}</p>${asset.emotion ? `<p class="field-note">情绪：${escape(asset.emotion)}</p>` : ''}${asset.usage ? `<p class="field-note">适合：${escape(asset.usage)}</p>` : ''}${asset.avoidWhen ? `<p class="field-note">避免：${escape(asset.avoidWhen)}</p>` : ''}<div class="card-actions">${asset.kind !== 'file' ? '<button type="button" class="button button-quiet button-small" data-asset-do="analyze">AI 识别标签</button>' : ''}<button type="button" class="button button-quiet button-small" data-asset-do="edit">编辑描述</button><button type="button" class="button button-quiet button-small" data-asset-do="remove">删除</button></div></article>`;
      }).join('') || '<p class="field-note">这个群还没有可用素材。导入并明确选择群后，AI 才能查找和发送。</p>';
    };
    const refresh = async () => {
      const id = getAccountId(), token = ++epoch;
      if (!id) { loadedAccount = ''; current = null; find('[data-asset-list]').textContent = '请先选择账号。'; return; }
      const params = new URLSearchParams({ query: query.value.trim() });
      if (loadedAccount === id && group.value) params.set('groupId', group.value);
      const value = await request('/qq/assets?' + params, undefined, 'GET', id);
      if (token !== epoch || id !== getAccountId()) return;
      loadedAccount = id; render(value);
      const result = await request('/qq/actions?limit=30', undefined, 'GET', id);
      if (token !== epoch || id !== getAccountId()) return;
      find('[data-asset-actions]').innerHTML = (result.actions || []).map(row => `<div class="qq-action-row"><strong>${escape(row.tool.replace('qq:', ''))}</strong><span>${escape(states[row.status] || row.status)}</span><small>群 ${escape(row.groupId)} · ${escape(new Date(row.updatedAt).toLocaleString())}${row.code ? ' · ' + escape(row.code) : ''}</small></div>`).join('') || '<p class="field-note">尚无 QQ 动作记录。</p>';
    };
    find('[data-asset-refresh]').addEventListener('click', () => run(refresh));
    group.addEventListener('change', () => run(refresh)); query.addEventListener('search', () => run(refresh));
    find('[data-asset-file]').addEventListener('change', event => {
      const file = event.target.files?.[0]; if (!file) return;
      find('[data-asset-name]').value = file.name;
      if (!/\.(png|jpe?g|gif|webp)$/i.test(file.name)) find('[data-asset-kind]').value = 'file';
      else if (find('[data-asset-kind]').value === 'file') find('[data-asset-kind]').value = 'sticker';
    });
    find('[data-asset-import]').addEventListener('click', () => run(async () => {
      const id = getAccountId(), file = find('[data-asset-file]').files?.[0];
      if (!id || !current?.actualQQ || !file) throw new Error('请先选择已配置账号、群和需要导入的文件。');
      const kind = find('[data-asset-kind]').value, max = (kind === 'file' ? 20 : 8) * 1024 * 1024;
      if (file.size > max) throw new Error('文件超过此素材类型的大小上限。');
      const groupIds = [...card.querySelectorAll('[data-asset-scope]:checked')].map(node => node.value);
      if (!groupIds.length) throw new Error('请选择至少一个允许使用此素材的群。');
      const base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('读取文件失败。')); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(file); });
      if (id !== getAccountId()) throw new Error('账号已切换，请重新选择文件。');
      await request('/qq/assets/import', { actualQQ: current.actualQQ, groupIds, kind,
        name: find('[data-asset-name]').value.trim() || file.name, dataBase64: base64,
        tags: find('[data-asset-tags]').value.split(/[,，]/u).map(tag => tag.trim()).filter(Boolean), description: find('[data-asset-description]').value.trim() }, 'POST', id);
      find('[data-asset-file]').value = ''; notify('素材已导入，可继续补标签或识别。'); await refresh();
    }));
    find('[data-asset-sync]').addEventListener('click', () => run(async () => {
      const id = getAccountId(), actualQQ = current?.actualQQ;
      const groupIds = [...card.querySelectorAll('[data-asset-scope]:checked')].map(node => node.value);
      if (!id || id !== loadedAccount || !actualQQ || !groupIds.length) throw new Error('请先选择已应用的账号及至少一个允许使用表情的群。');
      const result = await request('/qq/assets/sync-stickers', { actualQQ, groupIds, limit: 10 }, 'POST', id);
      if (id !== getAccountId()) return;
      notify(`收藏表情：导入 ${result.importedCount || 0} 个，跳过 ${result.skippedCount || 0} 个，失败 ${result.failedCount || 0} 个。`);
      await refresh();
      if (!['completed'].includes(result.status)) showError(new Error(result.status === 'cancelled' ? '同步已停止；已导入的表情已保留。' : '部分表情未导入，请检查 QQ 连接、图片类型或下载额度；已导入内容已保留。'));
    }));
    card.addEventListener('click', event => {
      const button = event.target.closest('[data-asset-do]'); if (!button) return;
      const asset = current?.assets?.find(item => item.assetId === button.closest('[data-asset-id]')?.dataset.assetId);
      if (!asset) return;
      void run(async () => {
        const id = getAccountId(); if (id !== loadedAccount) throw new Error('账号已切换，请刷新素材。');
        const common = { actualQQ: current.actualQQ, assetId: asset.assetId };
        if (button.dataset.assetDo === 'analyze') {
          if (!vision.value) throw new Error('请先选择支持图片的 API 模型；也可以先手动填写标签。');
          await request('/qq/assets/analyze', { ...common, groupId: current.groupId, provider: vision.value }, 'POST', id);
          notify('图片识别完成，描述和标签已保存。');
        } else if (button.dataset.assetDo === 'edit') {
          editing = { id, common, expectedVersion: asset.version };
          editor.querySelector('[data-edit-description]').value = asset.description || '';
          editor.querySelector('[data-edit-tags]').value = (asset.tags || []).join('，');
          editor.querySelector('[data-edit-emotion]').value = asset.emotion || '';
          editor.querySelector('[data-edit-usage]').value = asset.usage || '';
          editor.querySelector('[data-edit-avoid]').value = asset.avoidWhen || '';
          editor.querySelector('[data-edit-error]').textContent = ''; editor.querySelector('[data-edit-error]').classList.add('hidden');
          editor.showModal(); return;
        } else {
          if (!window.confirm('删除这个素材及其描述？已发出的 QQ 消息不会因此撤回。')) return;
          await request('/qq/assets/remove', { ...common, expectedVersion: asset.version }, 'POST', id);
        }
        await refresh();
      });
    });
    editor.querySelector('[data-edit-cancel]').addEventListener('click', () => editor.close());
    editor.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      void run(async () => {
        const selection = editing;
        if (!selection || selection.id !== getAccountId()) throw new Error('账号已切换，请重新打开素材编辑。');
        await request('/qq/assets/update', { ...selection.common, expectedVersion: selection.expectedVersion,
          description: editor.querySelector('[data-edit-description]').value.trim(),
          tags: editor.querySelector('[data-edit-tags]').value.split(/[,，]/u).map(tag => tag.trim()).filter(Boolean),
          emotion: editor.querySelector('[data-edit-emotion]').value.trim(), usage: editor.querySelector('[data-edit-usage]').value.trim(),
          avoidWhen: editor.querySelector('[data-edit-avoid]').value.trim() }, 'POST', selection.id);
        editor.close(); editing = null; await refresh();
      });
    });
    card.addEventListener('toggle', () => { if (card.open) void run(refresh); });
    document.querySelector('#account-selector')?.addEventListener('change', () => { if (card.open) void run(refresh); });
    window.addEventListener('hashchange', () => { if (location.hash === '#modules' && card.open) void run(refresh); });
    return { refresh: () => run(refresh) };
  } });
})();
