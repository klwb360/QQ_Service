(() => {
  'use strict';

  const VERSION = 1;
  const STORAGE_KEY = 'qq-service.ui-design.v1';
  const STYLE_KEYS = ['fontSize', 'color', 'backgroundColor', 'padding', 'margin', 'borderRadius', 'width', 'maxWidth', 'gap'];
  const STYLE_NAMES = ['字号', '文字颜色', '背景颜色', '内边距', '外边距', '圆角', '宽度', '最大宽度', '元素间距'];
  const PROTECTED = '#window-controls, #frontend-editor-toggle, #app-dialog, #toast-region, [data-ui-protected], input, textarea, pre, code, [contenteditable], #account-selector, #summary-group, #setup-test-group, #group-rows, #overview-accounts, #recent-jobs, #module-cards, #module-jobs, #all-jobs, #summary-records, #favorite-records, #log-records, #runtime-status, #runtime-details, #environment-checks, #setup-task-summary, #setup-permission-summary, #setup-verification-checks, #setup-live-metrics, #account-login-status, #account-codex-status, #setup-connection-result, #setup-model-status, #setup-selected-models, #setup-codex-jobs, #setup-connection-jobs, #server-label, #runtime-badge, #config-label, #config-detail, #account-permission-badge, #deepseek-secret-state, #napcat-secret-state, #permissions-status, #permissions-applied-summary, #setup-send-test-result, #setup-test-guide, #policy-result, #load-error, #setup-error, #create-account-error, #scenario-validation-errors';
  const BAD_KEY = /(?:window-|designer-|ui-designer|secret|token|login-status|codex-status|runtime-status)|\d{5}|[a-f0-9]{8}-[a-f0-9]{4}/i;
  const registry = new Map();
  const baselines = new WeakMap();
  const optionBaselines = new WeakMap();
  const elementKeys = new WeakMap();
  const STATIC_OPTION_KEYS = ['', 'deepseek', 'openai', 'dashscope', 'zhipu', 'kimi', 'siliconflow', 'custom', 'codex'];
  let documentState = { version: VERSION, edits: [] };
  let undoStack = [];
  let redoStack = [];
  let selectedKey = null;
  let mode = 'closed';
  let ready = false;
  let saveChain = Promise.resolve();
  let saveRevision = 0;
  let internalNavigation = false;
  let observerQueued = false;
  let root;
  let selectionOutline;
  let hoverOutline;
  const $ = id => document.getElementById(id);
  const clone = value => JSON.parse(JSON.stringify(value));
  const selectorFor = key => `[data-ui-key="${key}"]`;
  const camelToCSS = key => key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
  const ownUI = target => target instanceof Element && Boolean(target.closest('#designer-root, .designer-outline, #frontend-editor-toggle, #window-controls'));

  function directText(element) {
    const nodes = [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    return nodes.length === 1 ? nodes[0] : null;
  }

  function editableTextNode(element) {
    const direct = directText(element);
    if (direct) return direct;
    if (!element.matches('button, a')) return null;
    const children = [...element.children].filter(child => !child.matches('[aria-hidden="true"], svg, [data-ui-protected]'));
    return children.length === 1 && children[0].matches('span') && !children[0].children.length ? directText(children[0]) : null;
  }

  function protectedElement(element) {
    return !(element instanceof Element) || Boolean(element.closest(PROTECTED)) || Boolean(element.querySelector('#window-controls, #frontend-editor-toggle'));
  }

  function keyAllowed(key) {
    return /^[a-zA-Z][a-zA-Z0-9_.:-]{0,119}$/.test(key) && !BAD_KEY.test(key);
  }

  function captureBaseline(element, key) {
    let elementBaselines = baselines.get(element);
    if (!elementBaselines) { elementBaselines = new Map(); baselines.set(element, elementBaselines); }
    const previousKey = elementKeys.get(element);
    if (previousKey && previousKey !== key) {
      const previous = elementBaselines.get(previousKey);
      if (previous) {
        for (const property of previous.stylesApplied) { const [value, priority] = previous.styles[property]; if (value) element.style.setProperty(camelToCSS(property), value, priority); else element.style.removeProperty(camelToCSS(property)); }
        previous.stylesApplied.clear();
        if (previous.hiddenApplied) { if (previous.hidden === null) element.removeAttribute('data-ui-hidden'); else element.setAttribute('data-ui-hidden', previous.hidden); previous.hiddenApplied = false; }
        previous.textApplied = false;
      }
    }
    elementKeys.set(element, key);
    if (elementBaselines.has(key)) {
      const baseline = elementBaselines.get(key);
      if (baseline.text !== null && !element.contains(baseline.textNode)) {
        baseline.textNode = editableTextNode(element);
        baseline.text = baseline.textNode?.textContent ?? baseline.text;
      }
      refreshOptions(element, key, baseline); return baseline;
    }
    const textNode = editableTextNode(element);
    const explicitTextLeaf = !key.startsWith('ui-auto-') && !element.matches('button, select, [data-ui-text-protected]');
    const protectedText = element.matches('select, [data-ui-text-protected]') || (!explicitTextLeaf && element.closest('[data-ui-text-protected]'));
    const baseline = {
      textNode, text: textNode && !protectedText ? textNode.textContent : null,
      styles: Object.fromEntries(STYLE_KEYS.map(property => [property, [element.style.getPropertyValue(camelToCSS(property)), element.style.getPropertyPriority(camelToCSS(property))]])),
      options: new Map(), hidden: element.getAttribute('data-ui-hidden'), textApplied: false, stylesApplied: new Set(), hiddenApplied: false,
    };
    elementBaselines.set(key, baseline);
    if (!registry.has(key)) registry.set(key, { text: baseline.text !== null, options: new Set(), name: (baseline.text?.trim() || element.getAttribute('aria-label') || element.tagName.toLowerCase()).slice(0, 65) });
    refreshOptions(element, key, baseline);
    return baseline;
  }

  function currentBaseline(element) { return element && baselines.get(element)?.get(element.getAttribute('data-ui-key')); }

  function optionKey(option, select) {
    if (option.matches('[data-ui-protected]')) return null;
    const value = option.dataset.uiOptionKey ?? (select.id === 'new-account-llm-source' ? option.value : null);
    return value !== null && STATIC_OPTION_KEYS.includes(value) ? value : null;
  }

  function refreshOptions(element, key, baseline) {
    if (!element.matches('select[data-ui-options-editable]')) return;
    for (const option of element.options) {
      const value = optionKey(option, element);
      if (value === null) continue;
      if (!optionBaselines.has(option)) optionBaselines.set(option, { label: option.textContent, applied: false });
      const original = optionBaselines.get(option);
      if (!original.applied) original.label = option.textContent;
      baseline.options.set(value, original.label);
      registry.get(key)?.options.add(value);
    }
  }

  function registerExplicitTargets() {
    for (const element of document.querySelectorAll('[data-ui-key]')) {
      const key = element.getAttribute('data-ui-key');
      if (keyAllowed(key) && !protectedElement(element)) captureBaseline(element, key);
    }
  }

  function annotateStaticDOM() {
    function stableKey(element) {
      let path = '';
      for (let current = element; current && current !== document.body; current = current.parentElement) {
        if (current.id && !/\d{5}|[a-f0-9]{8}-[a-f0-9]{4}/i.test(current.id)) { path = `#${current.id}/${path}`; break; }
        const index = current.parentElement ? [...current.parentElement.children].filter(sibling => sibling.tagName === current.tagName).indexOf(current) : 0;
        path = `${current.tagName.toLowerCase()}:${index}/${path}`;
      }
      let hash = 2166136261;
      for (const letter of path) hash = Math.imul(hash ^ letter.charCodeAt(0), 16777619) >>> 0;
      let encoded = ''; do { encoded = String.fromCharCode(97 + hash % 26) + encoded; hash = Math.floor(hash / 26); } while (hash);
      return `ui-auto-${encoded}`;
    }
    const candidates = document.querySelectorAll('[data-ui-key], h1, h2, h3, h4, p, small, legend, summary, button, a, label, select, span, section.card, .notice, .sidebar-label, .page-footer');
    for (const element of candidates) {
      if (protectedElement(element) || element.closest('#designer-root') || element.tagName === 'OPTION') continue;
      let key = element.getAttribute('data-ui-key');
      if (!key) {
        if (element.closest('#custom-api-cards, #overview-stats') || (element.closest('.account-accordion') && !element.closest('#account-workspace'))) continue;
        key = stableKey(element); element.setAttribute('data-ui-key', key);
      }
      if (keyAllowed(key)) captureBaseline(element, key);
    }
  }

  function safeText(value, max) {
    return typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) && !/<\/?[a-z][^>]*>/i.test(value);
  }

  function safeLength(value, count = 1, allowAuto = false) {
    if (allowAuto && value === 'auto') return true;
    if (typeof value !== 'string' || value !== value.trim()) return false;
    const parts = value.split(/\s+/);
    return parts.length >= 1 && parts.length <= count && parts.every(part => {
      if (part === '0') return true;
      const match = /^(\d+(?:\.\d+)?)(px|rem|em|%|vh|vw)$/.exec(part);
      return Boolean(match && Number(match[1]) <= (match[2] === 'px' ? 1000 : 100));
    });
  }

  function validateDesign(value) {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || value.version !== VERSION || !Array.isArray(value.edits) || value.edits.length > 400 || Object.keys(value).some(key => !['version', 'edits'].includes(key))) throw new Error('请选择有效的 QQ_Service 界面配置 JSON（version: 1）。');
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 512 * 1024) throw new Error('界面配置超过 512 KiB。');
    const seen = new Set();
    const edits = value.edits.map(entry => {
      if (!entry || Object.getPrototypeOf(entry) !== Object.prototype || Object.keys(entry).some(key => !['selector', 'text', 'hidden', 'styles', 'optionLabels'].includes(key))) throw new Error('配置包含不支持的修改字段。');
      const match = /^\[data-ui-key="([a-zA-Z][a-zA-Z0-9_.:-]{0,119})"\]$/.exec(entry.selector);
      const key = match?.[1];
      if (!key || !keyAllowed(key) || seen.has(key) || !registry.has(key)) throw new Error('配置包含重复、受保护或当前版本无法识别的元素。');
      seen.add(key);
      const rule = registry.get(key);
      if ('text' in entry && (!rule.text || !safeText(entry.text, 500))) throw new Error('这个元素的文字不可编辑，或文字包含不支持的内容。');
      if ('hidden' in entry && typeof entry.hidden !== 'boolean') throw new Error('显隐参数必须为布尔值。');
      if ('styles' in entry) {
        if (!entry.styles || Object.getPrototypeOf(entry.styles) !== Object.prototype) throw new Error('样式参数格式不正确。');
        for (const [property, cssValue] of Object.entries(entry.styles)) {
          if (!STYLE_KEYS.includes(property) || typeof cssValue !== 'string') throw new Error('配置包含未开放的样式。');
          const valid = ['color', 'backgroundColor'].includes(property)
            ? /^#(?:[a-f\d]{3}|[a-f\d]{6}|[a-f\d]{8})$/i.test(cssValue)
            : safeLength(cssValue, ['padding', 'margin', 'borderRadius'].includes(property) ? 4 : property === 'gap' ? 2 : 1, ['width', 'maxWidth'].includes(property));
          if (!valid) throw new Error(`${STYLE_NAMES[STYLE_KEYS.indexOf(property)]}格式不正确。请使用非负 px / rem / em / % / vh / vw；颜色使用 #RRGGBB。`);
        }
      }
      if ('optionLabels' in entry) {
        if (!Array.isArray(entry.optionLabels) || entry.optionLabels.length > 30) throw new Error('下拉选项配置格式不正确。');
        const optionValues = new Set();
        for (const option of entry.optionLabels) {
          if (!option || Object.keys(option).some(key => !['value', 'label'].includes(key)) || !rule.options.has(option.value) || optionValues.has(option.value) || !safeText(option.label, 120)) throw new Error('只能修改静态下拉选项的显示名称，不能修改选项值或账号数据。');
          optionValues.add(option.value);
        }
      }
      return clone(entry);
    });
    return { version: VERSION, edits };
  }

  function applyDesign() {
    registerExplicitTargets();
    const byKey = new Map(documentState.edits.map(entry => [entry.selector, entry]));
    for (const element of document.querySelectorAll('[data-ui-key]')) {
      const key = element.getAttribute('data-ui-key');
      if (!keyAllowed(key) || protectedElement(element)) continue;
      if (!registry.has(key)) continue;
      const baseline = captureBaseline(element, key);
      const edit = byKey.get(selectorFor(key));
      if (baseline.text !== null && element.contains(baseline.textNode)) {
        if (edit && 'text' in edit) { if (!baseline.textApplied) baseline.text = baseline.textNode.textContent; if (baseline.textNode.textContent !== edit.text) baseline.textNode.textContent = edit.text; baseline.textApplied = true; }
        else if (baseline.textApplied) { if (baseline.textNode.textContent !== baseline.text) baseline.textNode.textContent = baseline.text; baseline.textApplied = false; }
      }
      for (const property of STYLE_KEYS) {
        const cssProperty = camelToCSS(property);
        const hasEdit = edit?.styles?.[property] !== undefined;
        if (!hasEdit && !baseline.stylesApplied.has(property)) continue;
        if (hasEdit && !baseline.stylesApplied.has(property)) baseline.styles[property] = [element.style.getPropertyValue(cssProperty), element.style.getPropertyPriority(cssProperty)];
        const [original, priority] = baseline.styles[property];
        const value = edit?.styles?.[property] ?? original;
        const nextPriority = edit?.styles?.[property] !== undefined ? 'important' : priority;
        if (element.style.getPropertyValue(cssProperty) !== value || element.style.getPropertyPriority(cssProperty) !== nextPriority) {
          if (value) element.style.setProperty(cssProperty, value, nextPriority); else element.style.removeProperty(cssProperty);
        }
        if (hasEdit) baseline.stylesApplied.add(property); else baseline.stylesApplied.delete(property);
      }
      if (edit?.hidden === true) { if (!baseline.hiddenApplied) baseline.hidden = element.getAttribute('data-ui-hidden'); if (element.getAttribute('data-ui-hidden') !== 'true') element.setAttribute('data-ui-hidden', 'true'); baseline.hiddenApplied = true; }
      else if (baseline.hiddenApplied) { if (baseline.hidden === null) element.removeAttribute('data-ui-hidden'); else element.setAttribute('data-ui-hidden', baseline.hidden); baseline.hiddenApplied = false; }
      if (element instanceof HTMLSelectElement) {
        const labels = new Map((edit?.optionLabels || []).map(option => [option.value, option.label]));
        for (const option of element.options) {
          const value = optionKey(option, element); const original = optionBaselines.get(option);
          if (value === null || !original) continue;
          if (labels.has(value)) { if (option.textContent !== labels.get(value)) option.textContent = labels.get(value); original.applied = true; }
          else if (original.applied) { if (option.textContent !== original.label) option.textContent = original.label; original.applied = false; }
        }
      }
    }
    updateOutline();
  }

  function showError(message = '') { $('designer-error').textContent = message; $('designer-error').hidden = !message; }

  function persist() {
    const revision = ++saveRevision;
    const snapshot = clone(documentState);
    $('designer-save-status').textContent = '正在保存到本机…';
    saveChain = saveChain.catch(() => {}).then(async () => {
      if (window.qqBridgeDesktop?.saveUiDesign) await window.qqBridgeDesktop.saveUiDesign(snapshot);
      else localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      if (revision === saveRevision) $('designer-save-status').textContent = '已保存在本机 · 重启后保留';
    }).catch(error => {
      if (revision === saveRevision) { $('designer-save-status').textContent = '保存失败 · 当前修改尚未持久化'; showError(`保存失败：${error.message || error}`); }
    });
    return saveChain;
  }

  function commit(next) {
    const validated = validateDesign(next);
    if (JSON.stringify(validated) === JSON.stringify(documentState)) { showError(); persist(); return; }
    undoStack.push(clone(documentState));
    if (undoStack.length > 60) undoStack.shift();
    redoStack = [];
    documentState = validated;
    showError(); applyDesign(); refreshInspector(); persist();
  }

  function editSelected(update) {
    if (!selectedKey || !registry.has(selectedKey)) throw new Error('请先点击应用中的一个元素。');
    const next = clone(documentState);
    const selector = selectorFor(selectedKey);
    const index = next.edits.findIndex(edit => edit.selector === selector);
    const edit = index < 0 ? { selector } : next.edits[index];
    update(edit);
    if (index < 0) next.edits.push(edit);
    commit(next);
  }

  function targetElement() { return selectedKey ? [...document.querySelectorAll(selectorFor(selectedKey))].find(element => !protectedElement(element)) : null; }

  function refreshInspector() {
    const element = targetElement();
    const entry = documentState.edits.find(edit => edit.selector === selectorFor(selectedKey));
    const baseline = element ? captureBaseline(element, selectedKey) : null;
    $('designer-target-label').textContent = selectedKey ? registry.get(selectedKey)?.name || '所选元素' : '点击页面中的文字、按钮或下拉栏';
    $('designer-target-key').textContent = selectedKey || '仅修改展示，不改变账号配置';
    $('designer-fields').disabled = !element;
    $('designer-text').disabled = !baseline || baseline.text === null;
    $('designer-text').value = baseline?.text !== null && baseline ? entry?.text ?? baseline.text : '';
    $('designer-text-note').textContent = baseline?.text === null ? '此元素仅支持样式和显隐；业务状态、输入值和账号资料不会作为文字保存。' : '修改可见文字，保留原有按钮动作和子元素。';
    $('designer-hidden').checked = entry?.hidden === true;
    for (const property of STYLE_KEYS) {
      const input = $(`designer-style-${property}`);
      input.value = entry?.styles?.[property] || '';
      input.placeholder = element ? getComputedStyle(element)[property] : '';
    }
    const options = $('designer-option-value');
    options.replaceChildren();
    const allowedOptions = element instanceof HTMLSelectElement && baseline?.options.size ? [...baseline.options] : [];
    for (const [value, originalLabel] of allowedOptions) { const option = document.createElement('option'); option.value = value; option.textContent = entry?.optionLabels?.find(label => label.value === value)?.label ?? originalLabel; options.append(option); }
    $('designer-option-fields').hidden = !allowedOptions.length;
    $('designer-option-note').hidden = !(element instanceof HTMLSelectElement) || Boolean(allowedOptions.length);
    updateOptionField();
    $('designer-undo').disabled = !undoStack.length;
    $('designer-redo').disabled = !redoStack.length;
    const hiddenList = $('designer-hidden-list'); hiddenList.replaceChildren();
    for (const hiddenEntry of documentState.edits.filter(edit => edit.hidden)) {
      const key = /^\[data-ui-key="([^"]+)"\]$/.exec(hiddenEntry.selector)?.[1];
      const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'designer-restore'; restore.textContent = `显示：${registry.get(key)?.name || key}`;
      restore.addEventListener('click', () => { const next = clone(documentState); const edit = next.edits.find(item => item.selector === hiddenEntry.selector); delete edit.hidden; commit(next); }); hiddenList.append(restore);
    }
    $('designer-hidden-count').textContent = `已隐藏元素（${hiddenList.childElementCount}）`;
    updateOutline();
  }

  function updateOptionField() {
    const element = targetElement(); const value = $('designer-option-value').value;
    const baseline = currentBaseline(element);
    const entry = documentState.edits.find(edit => edit.selector === selectorFor(selectedKey));
    $('designer-option-label').value = entry?.optionLabels?.find(option => option.value === value)?.label ?? baseline?.options.get(value) ?? '';
  }

  function outlineAt(outline, element) {
    if (!element || !element.isConnected || !element.getClientRects().length || element.closest('[data-ui-hidden="true"]')) { outline.hidden = true; return; }
    const rect = element.getBoundingClientRect();
    outline.hidden = false;
    for (const [name, value] of Object.entries({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })) outline.style[name] = `${value}px`;
  }

  function updateOutline() { if (selectionOutline) outlineAt(selectionOutline, mode === 'edit' ? targetElement() : null); }

  function resolveTarget(target) {
    const explicitLeaf = target instanceof Element && target.closest('[data-ui-key]');
    if (explicitLeaf) {
      const key = explicitLeaf.getAttribute('data-ui-key');
      if (!key.startsWith('ui-auto-') && registry.get(key)?.text && !protectedElement(explicitLeaf) && captureBaseline(explicitLeaf, key).text !== null) return explicitLeaf;
    }
    const control = target instanceof Element && target.closest('button[data-ui-key], select[data-ui-key]');
    if (control && registry.has(control.getAttribute('data-ui-key')) && !protectedElement(control)) return control;
    for (let element = target instanceof Element ? target : target?.parentElement; element && element !== document.body; element = element.parentElement) {
      const key = element.getAttribute('data-ui-key');
      if (key && registry.has(key) && !protectedElement(element)) return element;
      if (element.matches('[data-ui-protected], #window-controls')) return null;
    }
    return null;
  }

  function setMode(nextMode) {
    if (!['edit', 'preview', 'closed'].includes(nextMode)) return;
    mode = nextMode;
    root.hidden = mode === 'closed'; root.dataset.mode = mode;
    document.body.dataset.uiDesignMode = mode;
    $('frontend-editor-toggle')?.setAttribute('aria-pressed', String(mode !== 'closed'));
    $('designer-edit-mode').setAttribute('aria-pressed', String(mode === 'edit'));
    $('designer-preview-mode').setAttribute('aria-pressed', String(mode === 'preview'));
    syncPageSelection();
    hoverOutline.hidden = true; updateOutline();
    document.dispatchEvent(new CustomEvent('qq-service-ui-design-mode', { detail: { mode } }));
  }

  function syncPageSelection() {
    const page = document.querySelector('.nav-link.active[data-page]')?.dataset.page;
    if (page && $('designer-page').value !== page) $('designer-page').value = page;
  }

  function createUI() {
    root = document.createElement('aside'); root.id = 'designer-root'; root.hidden = true; root.setAttribute('aria-label', '界面可视化编辑器');
    // This is a fixed local template. User text is always assigned with textContent/value.
    root.innerHTML = `<div class="designer-heading"><div><strong>界面编辑</strong><small>仅调整本机展示 · 不修改账号权限</small></div><button type="button" id="designer-close" aria-label="退出界面编辑">×</button></div>
      <div class="designer-mode-switch"><button type="button" id="designer-edit-mode" aria-pressed="true">选择并编辑</button><button type="button" id="designer-preview-mode" aria-pressed="false">预览并操作</button></div>
      <label class="designer-field">切换页面<select id="designer-page"><option value="overview">总览</option><option value="connections">账号控制</option><option value="scenarios">场景与权限</option><option value="modules">模块管理</option><option value="records">任务与记录</option><option value="settings">应用设置</option></select></label>
      <div class="designer-scroll"><div class="designer-selection"><strong id="designer-target-label"></strong><small id="designer-target-key"></small></div><p id="designer-error" class="designer-error" role="alert" hidden></p>
      <fieldset id="designer-fields"><label class="designer-field">显示文字<textarea id="designer-text" rows="2" maxlength="500" placeholder="这个元素不支持修改文字"></textarea></label><p class="designer-note" id="designer-text-note"></p>
      <div id="designer-option-fields" hidden><label class="designer-field">下拉选项<select id="designer-option-value"></select></label><label class="designer-field">选项显示名称<input id="designer-option-label" maxlength="120"></label><p class="designer-note">只改显示名称，不改变选项值和模型行为。</p></div><p id="designer-option-note" class="designer-note" hidden>账号、群及自定义接口的选项包含业务资料，仅开放下拉栏外观。</p>
      <details class="designer-style-panel" open><summary>样式</summary><div id="designer-style-fields" class="designer-style-grid"></div><p class="designer-note">留空恢复原样；颜色用 #RRGGBB；尺寸例：16px、1rem、100%。</p></details><label class="designer-checkbox"><input id="designer-hidden" type="checkbox">隐藏此元素</label><div class="designer-actions"><button type="button" id="designer-apply" class="designer-primary">应用到元素</button><button type="button" id="designer-reset-element">还原此元素</button></div></fieldset>
      <details class="designer-hidden-panel"><summary id="designer-hidden-count">已隐藏元素（0）</summary><div id="designer-hidden-list"></div></details><div class="designer-actions"><button type="button" id="designer-undo">撤销</button><button type="button" id="designer-redo">重做</button><button type="button" id="designer-reset-all">全部恢复</button></div><div class="designer-actions"><button type="button" id="designer-export">导出 JSON</button><button type="button" id="designer-import-button">导入 JSON</button><button type="button" id="designer-dock">面板移到左侧</button></div><input id="designer-import" type="file" accept="application/json,.json" hidden><p class="designer-note">导出仅包含手动设置的文字、样式和显隐，不包含输入值、密钥、QQ 号或消息。Esc 退出；退出后保留展示。</p></div><div class="designer-save-status" id="designer-save-status" role="status">正在读取本机设置…</div>`;
    document.body.append(root);
    const styleFields = $('designer-style-fields');
    STYLE_KEYS.forEach((key, index) => { const label = document.createElement('label'); label.className = 'designer-field'; label.textContent = STYLE_NAMES[index]; const input = document.createElement('input'); input.id = `designer-style-${key}`; input.maxLength = 80; input.autocomplete = 'off'; label.append(input); styleFields.append(label); });
    for (const name of ['selection', 'hover']) { const outline = document.createElement('div'); outline.className = `designer-outline designer-outline-${name}`; outline.hidden = true; document.body.append(outline); if (name === 'selection') selectionOutline = outline; else hoverOutline = outline; }
  }

  function bindEvents() {
    $('frontend-editor-toggle')?.addEventListener('click', () => { if (!ready) { root.hidden = false; return; } setMode(mode === 'closed' ? 'edit' : 'closed'); });
    $('designer-close').addEventListener('click', () => setMode('closed'));
    $('designer-edit-mode').addEventListener('click', () => setMode('edit'));
    $('designer-preview-mode').addEventListener('click', () => setMode('preview'));
    $('designer-page').addEventListener('change', event => { const nav = document.querySelector(`.nav-link[data-page="${event.target.value}"]`); if (!nav || nav.classList.contains('hidden')) { showError('当前运行模式尚未提供这个页面。'); return; } internalNavigation = true; try { nav.click(); } finally { internalNavigation = false; } });
    $('designer-option-value').addEventListener('change', updateOptionField);
    $('designer-apply').addEventListener('click', () => { try { editSelected(edit => { const element = targetElement(); const baseline = currentBaseline(element); if (baseline.text !== null) { const text = $('designer-text').value; if (text !== baseline.text) edit.text = text; else delete edit.text; } const styles = {}; for (const key of STYLE_KEYS) { const value = $(`designer-style-${key}`).value.trim(); if (value) styles[key] = value; } if (Object.keys(styles).length) edit.styles = styles; else delete edit.styles; if ($('designer-hidden').checked) edit.hidden = true; else delete edit.hidden; if (!$('designer-option-fields').hidden) { const value = $('designer-option-value').value; const label = $('designer-option-label').value; const options = (edit.optionLabels || []).filter(option => option.value !== value); if (label !== baseline.options.get(value)) options.push({ value, label }); if (options.length) edit.optionLabels = options; else delete edit.optionLabels; } }); } catch (error) { showError(error.message); } });
    $('designer-reset-element').addEventListener('click', () => commit({ version: VERSION, edits: documentState.edits.filter(edit => edit.selector !== selectorFor(selectedKey)) }));
    $('designer-reset-all').addEventListener('click', () => commit({ version: VERSION, edits: [] }));
    $('designer-undo').addEventListener('click', () => { if (!undoStack.length) return; redoStack.push(clone(documentState)); documentState = undoStack.pop(); showError(); applyDesign(); refreshInspector(); persist(); });
    $('designer-redo').addEventListener('click', () => { if (!redoStack.length) return; undoStack.push(clone(documentState)); documentState = redoStack.pop(); showError(); applyDesign(); refreshInspector(); persist(); });
    $('designer-dock').addEventListener('click', () => { root.classList.toggle('designer-docked-left'); $('designer-dock').textContent = root.classList.contains('designer-docked-left') ? '面板移到右侧' : '面板移到左侧'; });
    $('designer-import-button').addEventListener('click', () => $('designer-import').click());
    $('designer-import').addEventListener('change', async event => { const file = event.target.files[0]; if (!file) return; try { if (file.size > 512 * 1024) throw new Error('配置文件超过 512 KiB。'); commit(JSON.parse(await file.text())); showError(); } catch (error) { showError(`导入失败：${error.message}`); } finally { event.target.value = ''; } });
    $('designer-export').addEventListener('click', async () => { try { const exported = validateDesign(documentState); if (window.qqBridgeDesktop?.exportUiDesign) { const result = await window.qqBridgeDesktop.exportUiDesign(exported); if (result && !result.canceled && result.ok === false) throw new Error('未能导出配置文件。'); if (!result?.canceled) $('designer-save-status').textContent = '界面配置已导出'; } else { const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'QQ_Service-ui-design.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); } showError(); } catch (error) { showError(`导出失败：${error.message}`); } });
    const intercept = event => {
      if (mode !== 'edit' || internalNavigation || ownUI(event.target)) return;
      if (event.type === 'keydown' && ['Escape', 'Tab'].includes(event.key)) return;
      if (event.type === 'keydown' && !['Enter', ' ', 'Spacebar'].includes(event.key) && !event.target.matches?.('input, textarea, select')) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (['pointerdown', 'click', 'keydown'].includes(event.type)) { const target = resolveTarget(event.target); if (target) { selectedKey = target.getAttribute('data-ui-key'); showError(); refreshInspector(); } else showError('这个区域包含账号资料或实际运行状态，不支持展示覆盖。请点击静态文字、按钮或下拉栏。'); }
    };
    for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick', 'input', 'change', 'submit', 'keydown']) document.addEventListener(type, intercept, true);
    document.addEventListener('keydown', event => { if (mode !== 'closed' && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); setMode('closed'); } }, true);
    document.addEventListener('pointermove', event => { if (mode === 'edit' && !ownUI(event.target)) outlineAt(hoverOutline, resolveTarget(event.target)); else hoverOutline.hidden = true; }, true);
    window.addEventListener('resize', updateOutline);
    document.addEventListener('scroll', updateOutline, true);
    const observer = new MutationObserver(mutations => { if (observerQueued || mutations.every(mutation => ownUI(mutation.target))) return; observerQueued = true; requestAnimationFrame(() => { observerQueued = false; applyDesign(); syncPageSelection(); }); });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-ui-key', 'data-ui-option-key'] });
  }

  async function initialize() {
    annotateStaticDOM(); createUI(); bindEvents();
    for (const page of ['overview', 'connections', 'scenarios', 'modules', 'records', 'settings']) for (const field of ['title', 'description', 'eyebrow']) registry.set(`page.${page}.${field}`, { text: true, options: new Set(), name: `${page} · ${field}` });
    for (const [key, text] of [['account.menuCard', false], ['account.menuHeader', false], ['account.apiForm', false], ['account.apiFormNote', true], ['account.testApi', true]]) if (!registry.has(key)) registry.set(key, { text, options: new Set(), name: key });
    for (const destination of ['accounts', 'permissions', 'groups', 'summaries']) for (const [kind, text] of [['stat', false], ['statLabel', true]]) { const key = `overview.${kind}.${destination}`; if (!registry.has(key)) registry.set(key, { text, options: new Set(), name: key }); }
    for (const key of ['account.llmSource', 'account.createLlmSource']) if (registry.has(key)) STATIC_OPTION_KEYS.forEach(value => registry.get(key).options.add(value));
    try {
      const saved = window.qqBridgeDesktop?.getUiDesign ? await window.qqBridgeDesktop.getUiDesign() : JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved) documentState = validateDesign(saved);
      $('designer-save-status').textContent = '已读取本机界面设置';
    } catch (error) { showError(`读取界面设置失败：${error.message}。可用“全部恢复”重新保存。`); $('designer-save-status').textContent = '界面设置未载入'; }
    ready = true; applyDesign(); refreshInspector();
    window.QQServiceDesigner = Object.freeze({
      enter: () => setMode('edit'), exit: () => setMode('closed'), setMode,
      getDocument: () => clone(documentState),
      importDocument: async value => { commit(value); await saveChain; },
      reset: async () => { commit({ version: VERSION, edits: [] }); await saveChain; },
    });
  }
  initialize().catch(error => { console.error('界面编辑器初始化失败', error); });
})();
