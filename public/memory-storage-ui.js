'use strict';

(() => {
  const instances = new WeakMap();

  // The application supplies its existing same-origin, CSRF-protected API
  // helper. This module never receives credentials or accesses the filesystem.
  window.QQMemoryStorageUI = Object.freeze({
    mount({ api, container = document.querySelector('#page-settings') } = {}) {
      if (typeof api !== 'function' || !container) return null;
      if (instances.has(container)) return instances.get(container);
      const card = document.createElement('section');
      card.id = 'memory-storage-card';
      card.className = 'card memory-storage-card';
      card.setAttribute('aria-labelledby', 'memory-storage-title');
      card.innerHTML = `
        <div class="section-heading"><div><h2 id="memory-storage-title">记忆保存位置</h2><p>统一用于所有账号，按账号和群分别保存。</p></div><span class="settings-save-state" data-storage-state role="status"></span></div>
        <p class="field-note">保存容量已扩大为原来的 11 倍；每轮检索数量与模型上下文预算保持不变。</p>
        <label class="field">当前保存目录<input type="text" data-storage-active readonly aria-label="当前记忆保存目录"></label>
        <label class="field">重启后使用的目录<input type="text" data-storage-directory placeholder="使用默认目录" spellcheck="false" autocomplete="off"><small data-storage-help>选择文件夹后保存，完全退出并重新打开应用后生效。</small></label>
        <div class="card-actions"><button type="button" class="button button-secondary" data-storage-choose>选择文件夹</button><button type="button" class="button button-quiet" data-storage-default>恢复默认目录</button><button type="button" class="button button-primary" data-storage-save>保存目录</button></div>
        <p class="field-note hidden" data-storage-pending role="status"></p>
        <p class="field-note hidden" data-storage-message role="status"></p>
        <p class="napcat-settings-error hidden" data-storage-error role="alert"></p>`;
      const memoryCard = container.querySelector('.memory-settings-card');
      if (memoryCard) memoryCard.after(card);
      else container.append(card);
      const find = selector => card.querySelector(selector);
      const active = find('[data-storage-active]');
      const directory = find('[data-storage-directory]');
      const choose = find('[data-storage-choose]');
      const reset = find('[data-storage-default]');
      const save = find('[data-storage-save]');
      const pending = find('[data-storage-pending]');
      const message = find('[data-storage-message]');
      const failure = find('[data-storage-error]');
      const stateLabel = find('[data-storage-state]');
      const desktop = window.qqBridgeDesktop;
      const nativePicker = typeof desktop?.chooseMemoryDirectory === 'function';
      choose.classList.toggle('hidden', !nativePicker);
      directory.readOnly = nativePicker;
      if (!nativePicker) find('[data-storage-help]').textContent = '填写运行 QQ_Service 的电脑或容器可访问的绝对目录；留空使用默认目录。保存后重启生效。';
      let status = null, busy = false, dirty = false, disposed = false;

      const show = (element, text) => {
        element.textContent = text;
        element.classList.toggle('hidden', !text);
      };
      const setBusy = value => {
        busy = value;
        for (const button of [choose, reset, save]) button.disabled = value;
        directory.disabled = value;
        card.setAttribute('aria-busy', String(value));
        stateLabel.textContent = value ? '处理中…' : dirty ? '未保存' : !status ? '尚未加载' : status.restartRequired ? '重启后生效' : '已保存';
      };
      const render = (value, { replaceDraft = false } = {}) => {
        status = value || {};
        const activeRoot = typeof status.activeRoot === 'string' ? status.activeRoot : '';
        const pendingRoot = typeof status.pendingRoot === 'string' ? status.pendingRoot : '';
        const displayRoot = root => root || status.defaultRoot || '默认目录';
        active.value = displayRoot(activeRoot);
        active.title = active.value;
        directory.placeholder = status.defaultRoot || '使用默认目录';
        if (replaceDraft || !dirty) {
          // An empty pending root explicitly restores the default directory;
          // only restartRequired distinguishes it from no pending change.
          directory.value = status.restartRequired ? pendingRoot : activeRoot;
          directory.title = displayRoot(directory.value);
          dirty = false;
        }
        show(pending, status.restartRequired
          ? `已安排切换到：${displayRoot(pendingRoot)}。请完全退出并重新打开应用；关闭到托盘不会重启。迁移验证通过前继续使用原目录。`
          : '');
        show(failure, typeof status.migrationError === 'string' ? status.migrationError : '');
      };
      const change = () => {
        dirty = true;
        directory.title = directory.value;
        show(message, '');
        show(failure, '');
        setBusy(false);
      };
      const run = async task => {
        if (busy || disposed) return;
        setBusy(true);
        show(failure, '');
        try { await task(); }
        catch (error) { if (!disposed) show(failure, error?.message || '记忆目录操作未完成，请重试。'); }
        finally { if (!disposed) setBusy(false); }
      };
      const refresh = () => run(async () => {
        const value = await api('/api/memory-storage', undefined, 'GET');
        if (!disposed) render(value);
      });
      directory.addEventListener('input', change);
      choose.addEventListener('click', () => run(async () => {
        const selection = await desktop.chooseMemoryDirectory();
        if (disposed || selection?.canceled || typeof selection?.path !== 'string') return;
        directory.value = selection.path;
        dirty = true;
        directory.title = selection.path;
        show(message, '目录尚未保存。保存后重启应用以迁移记忆。');
      }));
      reset.addEventListener('click', () => {
        if (busy) return;
        directory.value = '';
        change();
        show(message, '已选择默认目录。点击“保存目录”后重启生效。');
      });
      save.addEventListener('click', () => run(async () => {
        const value = await api('/api/memory-storage', { directory: directory.value.trim() });
        if (disposed) return;
        render(value, { replaceDraft: true });
        show(message, status.restartRequired ? '目录选择已保存，请完全退出并重新打开应用。' : '记忆保存目录已保存。');
      }));
      const onNavigation = () => { if (window.location.hash === '#settings') void refresh(); };
      window.addEventListener('hashchange', onNavigation);
      const instance = Object.freeze({
        refresh,
        dispose() {
          disposed = true;
          window.removeEventListener('hashchange', onNavigation);
          card.remove();
          instances.delete(container);
        },
      });
      instances.set(container, instance);
      void refresh();
      return instance;
    },
  });
})();
