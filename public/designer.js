(() => {
  'use strict';

  const VERSION = 1;
  const STORAGE_KEY = 'qq-service.ui-design.v1';
  const STYLE_KEYS = window.QQServiceLayoutSchema.STYLE_KEYS;
  const STYLE_NAMES = { fontSize: '字号', color: '文字颜色', backgroundColor: '背景颜色', padding: '内边距', margin: '外边距', borderRadius: '圆角', width: '宽度', maxWidth: '最大宽度', gap: '元素间距', height: '高度', minWidth: '最小宽度', minHeight: '最小高度', fontWeight: '字重', lineHeight: '行高', textAlign: '文字对齐' };
  const ALIGN_OPTIONS = [['left', '左对齐'], ['center', '居中'], ['right', '右对齐'], ['start', '跟随文字起始'], ['end', '跟随文字末尾']];
  const PROTECTED = '#window-controls, #frontend-editor-toggle, #app-dialog, #toast-region, [data-ui-protected], input, textarea, pre, code, [contenteditable], #account-selector, #summary-group, #setup-test-group, #group-rows, #overview-accounts, #recent-jobs, #module-cards, #module-jobs, #all-jobs, #summary-records, #favorite-records, #log-records, #runtime-status, #runtime-details, #environment-checks, #setup-task-summary, #setup-permission-summary, #setup-verification-checks, #setup-live-metrics, #account-login-status, #account-codex-status, #setup-connection-result, #setup-model-status, #setup-selected-models, #setup-codex-jobs, #setup-connection-jobs, #server-label, #runtime-badge, #config-label, #config-detail, #account-permission-badge, #deepseek-secret-state, #napcat-secret-state, #permissions-status, #permissions-applied-summary, #setup-send-test-result, #setup-test-guide, #policy-result, #load-error, #setup-error, #create-account-error, #scenario-validation-errors';
  const BAD_KEY = /(?:window-|designer-|ui-designer|secret|token|login-status|codex-status|runtime-status)|\d{5}|[a-f0-9]{8}-[a-f0-9]{4}/i;
  const registry = new Map();
  const retiredKeys = new Set();
  const bakedEdits = new Map();
  const baselines = new WeakMap();
  const optionBaselines = new WeakMap();
  const elementKeys = new WeakMap();
  const STATIC_OPTION_KEYS = ['', 'deepseek', 'openai', 'dashscope', 'zhipu', 'kimi', 'siliconflow', 'custom', 'codex'];
  const CONTAINER_SELECTOR = '.field, .form-grid, .two-columns, .stats-grid, .section-heading, .section-heading > div, .card-actions, .setup-stage-actions, .connection-settings, .connection-route, .connection-route-tabs, .connection-instructions, .connection-instructions > li, .settings-options, .profile-name-controls, .setup-send-test, .account-directory-heading, .scenario-tabs, .record-tabs, .page-heading, .page-heading > div';
  const EMPTY_WRAPPER_SELECTOR = `${CONTAINER_SELECTOR}, section.card, .notice, .sidebar-note, .page-footer`;
  const REFLOW_GRID_SELECTOR = '.form-grid, .two-columns, .stats-grid, .module-grid, .account-list';
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
  let builder;
  let panelGeometry = null;
  let panelGesture = null;
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
    return !(element instanceof Element) || Boolean(element.closest(`${PROTECTED}, [data-builder-owned]`)) || Boolean(element.querySelector('#window-controls, #frontend-editor-toggle'));
  }

  function keyAllowed(key) {
    return typeof key === 'string' && /^[a-zA-Z][a-zA-Z0-9_.:-]{0,119}$/.test(key) && !BAD_KEY.test(key);
  }

  function stableKey(element, prefix = 'ui-auto-') {
    let path = '';
    for (let current = element; current && current !== document.body; current = current.parentElement) {
      if (current.id && !/\d{5}|[a-f0-9]{8}-[a-f0-9]{4}/i.test(current.id)) { path = `#${current.id}/${path}`; break; }
      const index = current.parentElement ? [...current.parentElement.children].filter(sibling => sibling.tagName === current.tagName).indexOf(current) : 0;
      path = `${current.tagName.toLowerCase()}:${index}/${path}`;
    }
    let hash = 2166136261;
    for (const letter of path) hash = Math.imul(hash ^ letter.charCodeAt(0), 16777619) >>> 0;
    let encoded = ''; do { encoded = String.fromCharCode(97 + hash % 26) + encoded; hash = Math.floor(hash / 26); } while (hash);
    return `${prefix}${encoded}`;
  }

  function loadBaselineManifest() {
    const manifest = document.getElementById('ui-design-baseline');
    if (!manifest) return;
    const value = JSON.parse(manifest.textContent);
    if (value.version !== VERSION || !Array.isArray(value.retiredKeys) || !Array.isArray(value.bakedEdits) || value.retiredKeys.length > 400 || value.bakedEdits.length > 400) throw new Error('内置界面基线格式不正确。');
    for (const key of value.retiredKeys) {
      if (!keyAllowed(key)) throw new Error('内置界面基线包含不支持的标识。');
      retiredKeys.add(key);
      registry.set(key, { text: true, options: new Set(), name: '已从本版移除的元素', retired: true });
    }
    for (const entry of value.bakedEdits) {
      const key = /^\[data-ui-key="([a-zA-Z][a-zA-Z0-9_.:-]{0,119})"\]$/.exec(entry?.selector)?.[1];
      if (keyAllowed(key)) bakedEdits.set(entry.selector, clone(entry));
    }
  }

  function normalizeBaselineEdits(edits) {
    return edits.flatMap(original => {
      const key = /^\[data-ui-key="([^"]+)"\]$/.exec(original.selector)?.[1];
      if (retiredKeys.has(key)) return [];
      const entry = clone(original);
      const baked = bakedEdits.get(entry.selector);
      if (baked) {
        for (const property of ['text', 'hidden']) if (property in entry && property in baked && entry[property] === baked[property]) delete entry[property];
        if (entry.styles && baked.styles) {
          for (const property of Object.keys(entry.styles)) if (entry.styles[property] === baked.styles[property]) delete entry.styles[property];
          if (!Object.keys(entry.styles).length) delete entry.styles;
        }
        if (entry.optionLabels && baked.optionLabels) {
          entry.optionLabels = entry.optionLabels.filter(option => !baked.optionLabels.some(previous => previous.value === option.value && previous.label === option.label));
          if (!entry.optionLabels.length) delete entry.optionLabels;
        }
      }
      return Object.keys(entry).length > 1 ? [entry] : [];
    });
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
    annotateContainers();
  }

  function annotateContainers() {
    for (const element of document.querySelectorAll(CONTAINER_SELECTOR)) {
      if (element.hasAttribute('data-ui-key') || protectedElement(element) || ownUI(element)) continue;
      if (element.closest('#custom-api-cards, #overview-stats') || (element.closest('.account-accordion') && !element.closest('#account-workspace'))) continue;
      const key = stableKey(element, 'ui-container-');
      if (!keyAllowed(key)) continue;
      element.setAttribute('data-ui-key', key);
      captureBaseline(element, key);
      const names = [['field', '表单项'], ['form-grid', '表单布局'], ['two-columns', '双栏布局'], ['section-heading', '区块标题'], ['card-actions', '按钮组'], ['setup-stage-actions', '步骤按钮组']];
      const name = names.find(([className]) => element.classList.contains(className))?.[1] || '内容容器';
      registry.get(key).name = name;
    }
  }

  function safeText(value, max) {
    return typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) && !/<\/?[a-z][^>]*>/i.test(value);
  }

  function validateDesign(value) {
    const checked = window.QQServiceLayoutSchema.validateUiDesign(value);
    for (const page of checked.layout?.pages || []) for (const field of ['title', 'description', 'eyebrow']) {
      const key = `page.${page.id}.${field}`;
      if (!registry.has(key)) registry.set(key, { text: true, options: new Set(), name: `${page.label} · ${field}` });
    }
    const seen = new Set();
    const edits = checked.edits.map(entry => {
      if (!entry || Object.getPrototypeOf(entry) !== Object.prototype || Object.keys(entry).some(key => !['selector', 'text', 'hidden', 'styles', 'optionLabels'].includes(key))) throw new Error('配置包含不支持的修改字段。');
      const match = /^\[data-ui-key="([a-zA-Z][a-zA-Z0-9_.:-]{0,119})"\]$/.exec(entry.selector);
      const key = match?.[1];
      if (!key || !keyAllowed(key) || seen.has(key) || !registry.has(key)) throw new Error('配置包含重复、受保护或当前版本无法识别的元素。');
      seen.add(key);
      const rule = registry.get(key);
      if ('text' in entry && (!rule.text || !safeText(entry.text, 500))) throw new Error('这个元素的文字不可编辑，或文字包含不支持的内容。');
      if ('hidden' in entry && typeof entry.hidden !== 'boolean') throw new Error('显隐参数必须为布尔值。');
      // The shared native/browser schema has already checked every finite style.
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
    return { ...checked, edits: normalizeBaselineEdits(edits) };
  }

  function applyDesign() {
    builder?.render(documentState);
    annotateContainers();
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
    compactLayout();
    syncPageSelection();
    updateOutline();
  }

  function hasRemainingContent(node) {
    if (node.nodeType === Node.TEXT_NODE) return Boolean(node.textContent.trim());
    if (!(node instanceof Element)) return false;
    if (node.matches('[data-ui-hidden="true"], [data-ui-collapsed="true"]')) return false;
    // A business-controlled placeholder remains meaningful even before data arrives.
    // It must not disappear merely because the current runtime/page hides it.
    if (node.matches(PROTECTED) || node.matches('.hidden, [hidden], input, select, textarea, button, a, img, svg, canvas, video, iframe, hr, progress, meter, [role="status"], [aria-live]')) return true;
    return [...node.childNodes].some(hasRemainingContent);
  }

  function compactLayout() {
    for (const element of document.querySelectorAll('[data-ui-collapsed]')) element.removeAttribute('data-ui-collapsed');
    for (const element of document.querySelectorAll('[data-ui-reflow-tail]')) { element.removeAttribute('data-ui-reflow-tail'); element.style.removeProperty('--ui-reflow-span'); }
    for (const entry of documentState.edits) {
      if (entry.text !== '') continue;
      for (const element of document.querySelectorAll(entry.selector)) {
        if (protectedElement(element) || element.matches('button, a, select, input, textarea') || hasRemainingContent(element)) continue;
        element.setAttribute('data-ui-collapsed', 'true');
      }
    }
    for (const element of [...document.querySelectorAll(EMPTY_WRAPPER_SELECTOR)].reverse()) {
      if (protectedElement(element) || ownUI(element) || !element.querySelector('[data-ui-hidden="true"], [data-ui-collapsed="true"]')) continue;
      if (![...element.childNodes].some(hasRemainingContent)) element.setAttribute('data-ui-collapsed', 'true');
    }
    for (const grid of document.querySelectorAll(REFLOW_GRID_SELECTOR)) {
      grid.removeAttribute('data-ui-reflow-cols'); grid.style.removeProperty('--ui-reflow-cols');
      if (protectedElement(grid) || ownUI(grid)) continue;
      const children = [...grid.children].filter(child => !child.matches('script, style, template'));
      if (!children.some(child => child.matches('[data-ui-hidden="true"], [data-ui-collapsed="true"]'))) continue;
      const visible = children.filter(child => !child.matches('[data-ui-hidden="true"], [data-ui-collapsed="true"], .hidden, [hidden]'));
      if (!visible.length || !grid.getClientRects().length) continue;
      const computed = getComputedStyle(grid);
      if (computed.display !== 'grid') continue;
      const tracks = computed.gridTemplateColumns.trim().split(/\s+/);
      // Resolved grid tracks are pixels. Read the original responsive layout on
      // every pass rather than overriding its mobile breakpoints permanently.
      if (!tracks.length || !tracks.every(track => /^\d+(?:\.\d+)?px$/.test(track))) continue;
      const columns = Math.max(1, Math.min(tracks.length, visible.length));
      if (columns < tracks.length) {
        grid.setAttribute('data-ui-reflow-cols', String(columns));
        grid.style.setProperty('--ui-reflow-cols', String(columns));
      }
      if (grid.matches('.form-grid') && columns > 1) {
        let occupied = 0; let last = null;
        const finishRow = () => {
          if (last && occupied && occupied < columns) {
            last.setAttribute('data-ui-reflow-tail', 'true');
            last.style.setProperty('--ui-reflow-span', String(columns - occupied + 1));
          }
          occupied = 0; last = null;
        };
        for (const child of visible) {
          const style = getComputedStyle(child);
          if (child.matches('.field-wide') || (style.gridColumnStart === '1' && style.gridColumnEnd === '-1')) { finishRow(); continue; }
          occupied++; last = child;
          if (occupied === columns) { occupied = 0; last = null; }
        }
        finishRow();
      }
    }
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

  function selectionAncestors() {
    const ancestors = [];
    for (let element = targetElement(); element && element !== document.body; element = element.parentElement) {
      const key = element.getAttribute('data-ui-key');
      if (key && registry.has(key) && !protectedElement(element)) ancestors.push({ element, key });
    }
    return ancestors;
  }

  function selectKey(key) {
    if (!keyAllowed(key) || !registry.has(key) || retiredKeys.has(key)) return;
    setInspectorView('existing');
    selectedKey = key; showError(); refreshInspector();
  }

  function setInspectorView(view) {
    const existing = view === 'existing';
    root.dataset.inspectorView = existing ? 'existing' : 'builder';
    $('designer-view-existing').setAttribute('aria-selected', String(existing));
    $('designer-view-builder').setAttribute('aria-selected', String(!existing));
    if (existing) {
      builder?.clearSelection();
      $('designer-existing-inspector').hidden = false;
    } else {
      selectedKey = null;
      refreshInspector();
    }
  }

  function refreshSelectionPath() {
    const ancestors = selectionAncestors();
    $('designer-select-parent').disabled = ancestors.length < 2;
    const breadcrumb = $('designer-breadcrumb'); breadcrumb.replaceChildren();
    for (const { key } of ancestors.slice(0, 6).reverse()) {
      const button = document.createElement('button'); button.type = 'button';
      button.textContent = registry.get(key)?.name || '内容容器';
      button.title = key;
      button.setAttribute('aria-current', key === selectedKey ? 'true' : 'false');
      button.addEventListener('click', () => selectKey(key)); breadcrumb.append(button);
    }
    breadcrumb.hidden = !ancestors.length;
  }

  function refreshInspector() {
    const element = targetElement();
    const entry = documentState.edits.find(edit => edit.selector === selectorFor(selectedKey));
    const baseline = element ? captureBaseline(element, selectedKey) : null;
    $('designer-target-label').textContent = selectedKey ? registry.get(selectedKey)?.name || '所选元素' : '点击页面中的文字、按钮或下拉栏';
    $('designer-target-key').textContent = selectedKey || '仅修改展示，不改变账号配置';
    refreshSelectionPath();
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
    if (!element || !element.isConnected || !element.getClientRects().length || element.closest('[data-ui-hidden="true"], [data-ui-collapsed="true"]')) { outline.hidden = true; return; }
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
    endPanelGesture();
    root.hidden = mode === 'closed'; root.dataset.mode = mode;
    if (mode !== 'closed') positionPanel(panelGeometry || defaultPanelGeometry());
    document.body.dataset.uiDesignMode = mode;
    builder?.setMode(mode);
    $('frontend-editor-toggle')?.setAttribute('aria-pressed', String(mode !== 'closed'));
    $('designer-edit-mode').setAttribute('aria-pressed', String(mode === 'edit'));
    $('designer-preview-mode').setAttribute('aria-pressed', String(mode === 'preview'));
    syncPageSelection();
    hoverOutline.hidden = true; updateOutline();
    document.dispatchEvent(new CustomEvent('qq-service-ui-design-mode', { detail: { mode } }));
  }

  function syncPageSelection() {
    const select = $('designer-page');
    if (!select) return;
    const navigation = documentState.layout?.navigation || window.QQServiceLayoutSchema.BUILTIN_PAGES;
    const options = navigation.map(id => {
      const link = document.querySelector(`.nav-link[data-page="${id}"]`);
      const custom = documentState.layout?.pages.find(page => page.id === id);
      const label = custom?.label || [...(link?.childNodes || [])].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim() || id;
      return { id, label, disabled: !link || link.classList.contains('hidden') };
    });
    const fingerprint = JSON.stringify(options);
    if (select.dataset.pages !== fingerprint) {
      select.replaceChildren(...options.map(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = item.label; option.disabled = item.disabled; return option; }));
      select.dataset.pages = fingerprint;
    }
    const page = window.QQServiceNavigation?.currentPage() || document.querySelector('.nav-link.active[data-page]')?.dataset.page;
    if (page && select.value !== page) select.value = page;
  }

  // Window geometry is an editor-only preference, separate from exported UI
  // documents and account configuration. A closed/reopened panel keeps its size.
  function panelBounds() {
    const width = Math.max(1, window.innerWidth); const height = Math.max(1, window.innerHeight);
    const margin = Math.min(8, width / 4, height / 4);
    const toolbarBottom = document.querySelector('.topbar')?.getBoundingClientRect().bottom || 0;
    const top = Math.min(Math.max(margin, toolbarBottom + margin), Math.max(margin, height - 200));
    const availableWidth = Math.max(1, width - margin * 2); const availableHeight = Math.max(1, height - margin - top);
    return { left: margin, top, right: width - margin, bottom: height - margin, minWidth: Math.min(304, availableWidth), minHeight: Math.min(360, availableHeight) };
  }

  function defaultPanelGeometry() {
    const bounds = panelBounds();
    const width = Math.min(354, bounds.right - bounds.left);
    const top = Math.max(bounds.top, Math.min(76, bounds.bottom - bounds.minHeight));
    return { left: bounds.right - width, top, width, height: bounds.bottom - top };
  }

  function positionPanel(value) {
    const bounds = panelBounds(); const fallback = defaultPanelGeometry();
    const finite = (key, defaultValue) => Number.isFinite(value?.[key]) ? value[key] : defaultValue;
    const clamp = (number, low, high) => Math.max(low, Math.min(number, high));
    const width = clamp(finite('width', fallback.width), bounds.minWidth, bounds.right - bounds.left);
    const height = clamp(finite('height', fallback.height), bounds.minHeight, bounds.bottom - bounds.top);
    panelGeometry = { width, height, left: clamp(finite('left', fallback.left), bounds.left, bounds.right - width), top: clamp(finite('top', fallback.top), bounds.top, bounds.bottom - height) };
    for (const [key, number] of Object.entries(panelGeometry)) root.style[key] = `${number}px`;
    root.style.right = 'auto'; root.style.bottom = 'auto'; root.style.maxWidth = 'none';
    for (const handle of root.querySelectorAll('[data-resize-direction]')) handle.setAttribute('aria-description', `当前宽 ${Math.round(width)}，高 ${Math.round(height)} 像素`);
  }

  function adjustedPanel(initial, direction, dx, dy) {
    if (direction === 'move') return { ...initial, left: initial.left + dx, top: initial.top + dy };
    const bounds = panelBounds(); const next = { ...initial };
    if (direction.includes('e')) next.width = Math.max(bounds.minWidth, Math.min(initial.width + dx, bounds.right - initial.left));
    if (direction.includes('w')) {
      const right = initial.left + initial.width;
      next.width = Math.max(bounds.minWidth, Math.min(initial.width - dx, right - bounds.left)); next.left = right - next.width;
    }
    if (direction.includes('s')) next.height = Math.max(bounds.minHeight, Math.min(initial.height + dy, bounds.bottom - initial.top));
    return next;
  }

  function endPanelGesture() {
    const gesture = panelGesture; panelGesture = null;
    root?.classList.remove('designer-adjusting'); document.documentElement.classList.remove('designer-changing-geometry');
    if (gesture?.handle.hasPointerCapture?.(gesture.pointerId)) gesture.handle.releasePointerCapture(gesture.pointerId);
  }

  function bindPanelGeometry() {
    const handles = [[$('designer-drag-handle'), 'move'], ...[...root.querySelectorAll('[data-resize-direction]')].map(handle => [handle, handle.dataset.resizeDirection])];
    for (const [handle, direction] of handles) {
      handle.addEventListener('pointerdown', event => {
        if (event.button !== 0 || event.isPrimary === false || event.target.closest('button, input, select, textarea, a')) return;
        event.preventDefault(); event.stopPropagation(); endPanelGesture();
        positionPanel(panelGeometry || defaultPanelGeometry());
        panelGesture = { handle, direction, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, initial: { ...panelGeometry } };
        handle.setPointerCapture(event.pointerId); handle.focus({ preventScroll: true });
        root.classList.add('designer-adjusting'); document.documentElement.classList.add('designer-changing-geometry');
      });
      handle.addEventListener('pointermove', event => {
        if (panelGesture?.handle !== handle || panelGesture.pointerId !== event.pointerId) return;
        event.preventDefault(); event.stopPropagation();
        positionPanel(adjustedPanel(panelGesture.initial, direction, event.clientX - panelGesture.startX, event.clientY - panelGesture.startY));
      });
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(type, event => {
        if (panelGesture?.handle === handle && panelGesture.pointerId === event.pointerId) { event.preventDefault(); event.stopPropagation(); endPanelGesture(); }
      });
      handle.addEventListener('keydown', event => {
        if (event.target !== handle || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation(); endPanelGesture();
        const amount = event.shiftKey ? 30 : 10;
        const dx = event.key === 'ArrowRight' ? amount : event.key === 'ArrowLeft' ? -amount : 0;
        const dy = event.key === 'ArrowDown' ? amount : event.key === 'ArrowUp' ? -amount : 0;
        positionPanel(adjustedPanel(panelGeometry || defaultPanelGeometry(), direction, dx, dy));
      });
    }
    window.addEventListener('resize', () => { endPanelGesture(); if (panelGeometry) positionPanel(panelGeometry); });
    window.addEventListener('blur', endPanelGesture);
  }

  function createUI() {
    root = document.createElement('aside'); root.id = 'designer-root'; root.hidden = true; root.setAttribute('aria-label', '界面可视化编辑器');
    root.dataset.inspectorView = 'builder';
    // This is a fixed local template. User text is always assigned with textContent/value.
    root.innerHTML = `<div class="designer-heading" id="designer-drag-handle" tabindex="0" role="group" aria-label="拖动编辑窗口；方向键移动，Shift 加速" title="拖动标题移动窗口；方向键移动，Shift 加速"><div><strong>界面搭建版</strong><small>拖动标题移动 · 拖动边缘缩放</small></div><button type="button" id="designer-close" aria-label="退出界面编辑">×</button></div>
      <div class="designer-mode-switch"><button type="button" id="designer-edit-mode" aria-pressed="true">选择并编辑</button><button type="button" id="designer-preview-mode" aria-pressed="false">预览并操作</button></div>
      <div class="designer-inspector-switch" role="tablist" aria-label="编辑内容"><button type="button" id="designer-view-builder" role="tab" aria-selected="true">搭建菜单与组件</button><button type="button" id="designer-view-existing" role="tab" aria-selected="false">编辑已有元素</button></div>
      <label class="designer-field">切换页面<select id="designer-page"><option value="overview">仪表盘</option><option value="connections">账号</option><option value="scenarios">权限</option><option value="modules">模块</option><option value="records">日志</option><option value="settings">设置</option></select></label>
      <div class="designer-scroll"><p id="designer-error" class="designer-error" role="alert" hidden></p><div id="designer-builder-slot"></div><div id="designer-existing-inspector"><div class="designer-selection"><strong id="designer-target-label"></strong><small id="designer-target-key"></small><button type="button" id="designer-select-parent" disabled>选择父级容器 ↑</button><nav id="designer-breadcrumb" aria-label="所选元素层级" hidden></nav></div><p class="designer-note">点击文字、按钮或下拉栏；选择父级可调整整张卡片、表单项或按钮组。隐藏或清空内容后，空容器自动收起，网格自动补位。</p>
      <fieldset id="designer-fields"><label class="designer-field">显示文字<textarea id="designer-text" rows="2" maxlength="500" placeholder="这个元素不支持修改文字"></textarea></label><p class="designer-note" id="designer-text-note"></p>
      <div id="designer-option-fields" hidden><label class="designer-field">下拉选项<select id="designer-option-value"></select></label><label class="designer-field">选项显示名称<input id="designer-option-label" maxlength="120"></label><p class="designer-note">只改显示名称，不改变选项值和模型行为。</p></div><p id="designer-option-note" class="designer-note" hidden>账号、群及自定义接口的选项包含业务资料，仅开放下拉栏外观。</p>
      <details class="designer-style-panel" open><summary>样式</summary><div id="designer-style-fields" class="designer-style-grid"></div><p class="designer-note">留空恢复本版默认；颜色用 #RRGGBB；尺寸例：16px、1rem、100%；行高可用 1.5 或 24px。</p></details><label class="designer-checkbox"><input id="designer-hidden" type="checkbox">隐藏此元素并让布局补位</label><div class="designer-actions"><button type="button" id="designer-apply" class="designer-primary">应用到元素</button><button type="button" id="designer-reset-element">还原此元素</button></div></fieldset></div>
      <details class="designer-hidden-panel"><summary id="designer-hidden-count">已隐藏元素（0）</summary><div id="designer-hidden-list"></div></details><div class="designer-actions"><button type="button" id="designer-undo">撤销</button><button type="button" id="designer-redo">重做</button><button type="button" id="designer-reset-all">恢复本版默认</button></div><div class="designer-actions"><button type="button" id="designer-export">导出 JSON</button><button type="button" id="designer-import-button">导入 JSON</button><button type="button" id="designer-dock">面板移到左侧</button><button type="button" id="designer-reset-window">还原窗口大小</button></div><input id="designer-import" type="file" accept="application/json,.json" hidden><p class="designer-note">本版默认已包含你确认的界面调整。下一轮完成后，导出 JSON 发给开发者，方便继续实现相关功能。导出包含菜单、组件、展示修改和待接入动作说明，不包含输入值、密钥、QQ 号或消息。Esc 退出编辑并保留展示。</p></div><div class="designer-save-status" id="designer-save-status" role="status">正在读取本机设置…</div>`;
    document.body.append(root);
    const styleFields = $('designer-style-fields');
    STYLE_KEYS.forEach(key => {
      const label = document.createElement('label'); label.className = 'designer-field'; label.textContent = STYLE_NAMES[key];
      const input = document.createElement(['fontWeight', 'textAlign'].includes(key) ? 'select' : 'input'); input.id = `designer-style-${key}`;
      if (input.tagName === 'SELECT') {
        const choices = key === 'fontWeight' ? Array.from({ length: 9 }, (_, index) => [String((index + 1) * 100), String((index + 1) * 100)]) : ALIGN_OPTIONS;
        for (const [value, text] of [['', '本版默认'], ...choices]) { const option = document.createElement('option'); option.value = value; option.textContent = text; input.append(option); }
      } else { input.maxLength = 80; input.autocomplete = 'off'; }
      label.append(input); styleFields.append(label);
    });
    for (const [direction, label] of [['e', '右边缘'], ['w', '左边缘'], ['s', '下边缘'], ['se', '右下角'], ['sw', '左下角']]) {
      const handle = document.createElement('div'); handle.id = `designer-resize-${direction}`; handle.className = `designer-resize-handle designer-resize-${direction}`;
      handle.dataset.resizeDirection = direction; handle.tabIndex = 0; handle.setAttribute('role', 'button');
      handle.setAttribute('aria-label', `缩放编辑窗口${label}；方向键调整，Shift 加速`); handle.title = '拖动缩放；方向键调整，Shift 加速'; root.append(handle);
    }
    for (const name of ['selection', 'hover']) { const outline = document.createElement('div'); outline.className = `designer-outline designer-outline-${name}`; outline.hidden = true; document.body.append(outline); if (name === 'selection') selectionOutline = outline; else hoverOutline = outline; }
  }

  function bindEvents() {
    bindPanelGeometry();
    $('designer-view-builder').addEventListener('click', () => setInspectorView('builder'));
    $('designer-view-existing').addEventListener('click', () => setInspectorView('existing'));
    $('frontend-editor-toggle')?.addEventListener('click', () => { if (!ready) { root.hidden = false; return; } setMode(mode === 'closed' ? 'edit' : 'closed'); });
    $('designer-close').addEventListener('click', () => setMode('closed'));
    $('designer-edit-mode').addEventListener('click', () => setMode('edit'));
    $('designer-preview-mode').addEventListener('click', () => setMode('preview'));
    $('designer-select-parent').addEventListener('click', () => { const parent = selectionAncestors()[1]; if (parent) selectKey(parent.key); });
    $('designer-page').addEventListener('change', event => { const nav = document.querySelector(`.nav-link[data-page="${event.target.value}"]`); if (!nav || nav.classList.contains('hidden')) { showError('当前运行模式尚未提供这个页面。'); return; } internalNavigation = true; try { nav.click(); } finally { internalNavigation = false; } });
    $('designer-option-value').addEventListener('change', updateOptionField);
    $('designer-apply').addEventListener('click', () => { try { editSelected(edit => { const element = targetElement(); const baseline = currentBaseline(element); if (baseline.text !== null) { const text = $('designer-text').value; if (text !== baseline.text) edit.text = text; else delete edit.text; } const styles = {}; for (const key of STYLE_KEYS) { const value = $(`designer-style-${key}`).value.trim(); if (value) styles[key] = value; } if (Object.keys(styles).length) edit.styles = styles; else delete edit.styles; if ($('designer-hidden').checked) edit.hidden = true; else delete edit.hidden; if (!$('designer-option-fields').hidden) { const value = $('designer-option-value').value; const label = $('designer-option-label').value; const options = (edit.optionLabels || []).filter(option => option.value !== value); if (label !== baseline.options.get(value)) options.push({ value, label }); if (options.length) edit.optionLabels = options; else delete edit.optionLabels; } }); } catch (error) { showError(error.message); } });
    $('designer-reset-element').addEventListener('click', () => commit({ ...clone(documentState), edits: documentState.edits.filter(edit => edit.selector !== selectorFor(selectedKey)) }));
    $('designer-reset-all').addEventListener('click', () => commit({ version: VERSION, edits: [] }));
    $('designer-undo').addEventListener('click', () => { if (!undoStack.length) return; redoStack.push(clone(documentState)); documentState = undoStack.pop(); showError(); applyDesign(); refreshInspector(); persist(); });
    $('designer-redo').addEventListener('click', () => { if (!redoStack.length) return; undoStack.push(clone(documentState)); documentState = redoStack.pop(); showError(); applyDesign(); refreshInspector(); persist(); });
    $('designer-dock').addEventListener('click', () => {
      endPanelGesture(); root.classList.toggle('designer-docked-left');
      const bounds = panelBounds(); const geometry = panelGeometry || defaultPanelGeometry();
      positionPanel({ ...geometry, left: root.classList.contains('designer-docked-left') ? bounds.left : bounds.right - geometry.width });
      $('designer-dock').textContent = root.classList.contains('designer-docked-left') ? '面板移到右侧' : '面板移到左侧';
    });
    $('designer-reset-window').addEventListener('click', () => { endPanelGesture(); root.classList.remove('designer-docked-left'); $('designer-dock').textContent = '面板移到左侧'; positionPanel(defaultPanelGeometry()); });
    $('designer-import-button').addEventListener('click', () => $('designer-import').click());
    $('designer-import').addEventListener('change', async event => { const file = event.target.files[0]; if (!file) return; try { if (file.size > 512 * 1024) throw new Error('配置文件超过 512 KiB。'); commit(JSON.parse(await file.text())); showError(); } catch (error) { showError(`导入失败：${error.message}`); } finally { event.target.value = ''; } });
    $('designer-export').addEventListener('click', async () => { try { const exported = validateDesign(documentState); if (window.qqBridgeDesktop?.exportUiDesign) { const result = await window.qqBridgeDesktop.exportUiDesign(exported); if (result && !result.canceled && result.ok === false) throw new Error('未能导出配置文件。'); if (!result?.canceled) $('designer-save-status').textContent = '界面配置已导出'; } else { const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'QQ_Service-ui-design.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); } showError(); } catch (error) { showError(`导出失败：${error.message}`); } });
    const intercept = event => {
      if (mode !== 'edit' || internalNavigation || ownUI(event.target)) return;
      if (builder?.handleEditEvent(event)) return;
      if (event.type === 'keydown' && ['Escape', 'Tab'].includes(event.key)) return;
      if (event.type === 'keydown' && !['Enter', ' ', 'Spacebar'].includes(event.key) && !event.target.matches?.('input, textarea, select')) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (['pointerdown', 'click', 'keydown'].includes(event.type)) { const target = resolveTarget(event.target); if (target) selectKey(target.getAttribute('data-ui-key')); else showError('这个区域包含账号资料或实际运行状态，不支持展示覆盖。请点击静态文字、按钮或下拉栏。'); }
    };
    for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick', 'input', 'change', 'submit', 'keydown']) document.addEventListener(type, intercept, true);
    document.addEventListener('keydown', event => { if (mode !== 'closed' && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); setMode('closed'); } }, true);
    document.addEventListener('pointermove', event => { if (mode === 'edit' && !ownUI(event.target)) outlineAt(hoverOutline, resolveTarget(event.target)); else hoverOutline.hidden = true; }, true);
    const scheduleRefresh = () => { if (observerQueued) return; observerQueued = true; requestAnimationFrame(() => { observerQueued = false; applyDesign(); syncPageSelection(); }); };
    window.addEventListener('resize', scheduleRefresh);
    document.addEventListener('qq-service-page-change', syncPageSelection);
    document.addEventListener('scroll', updateOutline, true);
    const observer = new MutationObserver(mutations => { if (!mutations.every(mutation => ownUI(mutation.target))) scheduleRefresh(); });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-ui-key', 'data-ui-option-key', 'class', 'hidden'] });
  }

  async function initialize() {
    loadBaselineManifest(); annotateStaticDOM(); createUI(); bindEvents();
    for (const page of ['overview', 'connections', 'scenarios', 'modules', 'records', 'settings']) for (const field of ['title', 'description', 'eyebrow']) registry.set(`page.${page}.${field}`, { text: true, options: new Set(), name: `${page} · ${field}` });
    for (const [key, text] of [['account.menuCard', false], ['account.menuHeader', false], ['account.apiForm', false], ['account.apiFormNote', true], ['account.testApi', true]]) if (!registry.has(key)) registry.set(key, { text, options: new Set(), name: key });
    for (const destination of ['accounts', 'permissions', 'groups', 'summaries']) for (const [kind, text] of [['stat', false], ['statLabel', true]]) { const key = `overview.${kind}.${destination}`; if (!registry.has(key)) registry.set(key, { text, options: new Set(), name: key }); }
    for (const key of ['account.llmSource', 'account.createLlmSource']) if (registry.has(key)) STATIC_OPTION_KEYS.forEach(value => registry.get(key).options.add(value));
    try {
      const saved = window.qqBridgeDesktop?.getUiDesign ? await window.qqBridgeDesktop.getUiDesign() : JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved) documentState = validateDesign(saved);
      $('designer-save-status').textContent = '已读取本机界面设置';
    } catch (error) { showError(`读取界面设置失败：${error.message}。可用“恢复本版默认”重新保存。`); $('designer-save-status').textContent = '界面设置未载入'; }
    builder = window.QQServiceBuilder.create({
      mount: $('designer-builder-slot'),
      getDocument: () => clone(documentState),
      commitDocument: commit,
      getMode: () => mode,
      navigate: page => window.QQServiceNavigation.go(page),
      getCurrentPage: () => window.QQServiceNavigation.currentPage(),
      clearNativeSelection: () => setInspectorView('builder'),
      showError,
    });
    ready = true; applyDesign(); refreshInspector();
    window.QQServiceDesigner = Object.freeze({
      enter: () => setMode('edit'), exit: () => setMode('closed'), setMode,
      getDocument: () => clone(documentState),
      importDocument: async value => { commit(value); await saveChain; },
      reset: async () => { commit({ version: VERSION, edits: [] }); await saveChain; },
    });
    const pending = window.QQServiceNavigation.pendingPage();
    if (pending) window.QQServiceNavigation.go(window.QQServiceBuilder.getPage(pending) ? pending : 'overview');
  }
  initialize().catch(error => { console.error('界面编辑器初始化失败', error); });
})();
