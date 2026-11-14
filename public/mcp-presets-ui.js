(() => {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  window.McpPresetsUI = Object.freeze({ mount({ api, request, getAccountId }) {
    const parent = document.querySelector('#mcp-section .mcp-section-content'); if (!parent) return;
    const box = document.createElement('details'); box.className = 'mcp-presets'; box.id = 'mcp-presets';
    box.innerHTML = '<summary>精选 MCP 接入入口</summary><p class="field-note">选择入口准备配置，再测试连接、检查工具并授权。不会自动安装、登录或启动第三方程序。</p><label class="field">服务<select data-preset-select></select></label><div data-preset-info></div><div class="form-grid" data-preset-local><label class="field">已安装程序的绝对路径<input data-preset-command spellcheck="false" placeholder="例如已安装环境中的 python.exe、node.exe 或服务入口"></label><label class="field">程序参数（JSON 数组）<textarea data-preset-args rows="2" spellcheck="false">[]</textarea></label></div><button type="button" class="button button-secondary" data-preset-prepare>填入服务配置</button><p class="memory-error hidden" data-preset-error role="alert"></p>';
    const anchor = parent.querySelector('.mcp-example-links');
    if (anchor) anchor.after(box); else parent.append(box);
    const find = selector => box.querySelector(selector); let entries = [], busy = false;
    const render = () => {
      const item = entries.find(entry => entry.id === find('[data-preset-select]').value); if (!item) return;
      find('[data-preset-info]').innerHTML = `<p>${escape(item.description)}</p><p class="field-note">身份：${escape(item.accountType)}</p><ul>${[...(item.prerequisites || []), ...(item.limitations || [])].map(text => `<li>${escape(text)}</li>`).join('')}</ul>${item.credentials?.length ? `<p class="field-note">凭据：${escape(item.credentials.map(c => c.name + '：' + c.label + (c.required ? '（需要）' : '（可选）')).join('；'))}</p>` : ''}${item.repository ? `<a class="inline-link" target="_blank" rel="noreferrer" href="${escape(item.repository)}">查看上游安装说明 ↗</a>` : ''}${item.blockedReason ? `<p class="field-note">${escape(item.blockedReason)}</p>` : ''}`;
      find('[data-preset-local]').classList.toggle('hidden', item.bundled === true || item.needsOAuth === true);
      find('[data-preset-prepare]').disabled = busy || !item.canPrepare;
    };
    const error = value => { const node = find('[data-preset-error]'); node.textContent = value; node.classList.toggle('hidden', !value); };
    find('[data-preset-select]').addEventListener('change', () => { error(''); const item = entries.find(entry => entry.id === find('[data-preset-select]').value); find('[data-preset-args]').value = JSON.stringify(item?.launch?.module ? ['-m', item.launch.module] : []); render(); });
    find('[data-preset-prepare]').addEventListener('click', async () => {
      if (busy) return; const id = getAccountId(), selected = entries.find(entry => entry.id === find('[data-preset-select]').value);
      if (!id || !selected) { error('请先选择账号和服务。'); return; }
      busy = true; render(); error('');
      try {
        const body = { id: selected.id };
        if (!selected.bundled) {
          body.command = find('[data-preset-command]').value.trim();
          try { body.args = JSON.parse(find('[data-preset-args]').value || '[]'); } catch { throw new Error('参数必须是 JSON 字符串数组。'); }
        }
        const prepared = await request('/mcp/preset/prepare', body, 'POST', id);
        if (id !== getAccountId()) throw new Error('账号已切换，请重新选择服务。');
        const requiredEnv = (selected.credentials || []).filter(field => field.required && field.storage === 'vault-env').map(field => field.name);
        window.dispatchEvent(new CustomEvent('qq-service-mcp-preset', { detail: { accountId: id, server: prepared.server, requiredEnv } }));
      } catch (cause) { error(cause.message || String(cause)); } finally { busy = false; render(); }
    });
    void api('/api/mcp/presets', undefined, 'GET').then(result => {
      entries = result.presets || [];
      find('[data-preset-select]').innerHTML = entries.map(entry => `<option value="${escape(entry.id)}">${escape(entry.label)}${entry.canPrepare ? '' : ' · 尚不可用'}</option>`).join(''); render();
    }).catch(cause => error(cause.message || String(cause)));
    return { refresh: render };
  } });
})();
