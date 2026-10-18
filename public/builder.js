/* Local declarative interface builder. No business requests or executable actions. */
(() => {
  'use strict';

  const schema = window.QQServiceLayoutSchema;
  const TYPE_NAMES = { heading: '标题', text: '文本', button: '按钮', select: '下拉栏', input: '输入框', textarea: '多行输入', switch: '开关', card: '卡片容器', divider: '分隔线' };
  const PAGE_NAMES = { overview: '仪表盘', connections: '账号', scenarios: '权限', modules: '模块', records: '日志', settings: '设置' };
  const STYLE_NAMES = { fontSize: '字号', color: '文字颜色', backgroundColor: '背景颜色', padding: '内边距', margin: '外边距', borderRadius: '圆角', width: '宽度', maxWidth: '最大宽度', gap: '元素间距', height: '高度', minWidth: '最小宽度', minHeight: '最小高度', fontWeight: '字重', lineHeight: '行高', textAlign: '文字对齐' };
  const MIME = 'application/x-qq-service-builder';
  const clone = value => JSON.parse(JSON.stringify(value));
  let activeInstance = null;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function setText(node, text) { if (node.textContent !== String(text ?? '')) node.textContent = String(text ?? ''); }
  function field(labelText, id, tag = 'input', maximum = 120) {
    const label = element('label', 'designer-field', labelText);
    const control = element(tag); control.id = id;
    if (tag !== 'select') { control.maxLength = maximum; control.autocomplete = 'off'; }
    if (tag === 'textarea') control.rows = 3;
    label.append(control); return { label, control };
  }
  function button(text, id, callback, className = '') {
    const node = element('button', className, text); node.type = 'button';
    if (id) node.id = id;
    if (callback) node.addEventListener('click', callback);
    return node;
  }
  function create(config) {
    if (!schema || !config.mount) throw new Error('界面搭建器缺少初始化配置。');
    const $ = id => document.getElementById(id);
    let documentState = config.getDocument();
    let layout = documentState.layout || schema.emptyLayout();
    let signature = null;
    let selected = null;
    let editingPage = null;
    let selectedFingerprint = null;
    let pageFingerprint = null;
    let mode = config.getMode();
    let dragState = null;
    let renderInProgress = false;
    const componentNodes = new Map();
    const customPages = new Map();
    const customNavigation = new Map();
    const pageRoots = new Map();
    const nativeNavigation = new Map(schema.BUILTIN_PAGES.map(id => [id, document.querySelector(`.sidebar .nav-link[data-page="${id}"]`)]));
    const nav = document.querySelector('.sidebar nav');
    const sectionHost = document.querySelector('main');
    const shell = element('section', 'builder-panel'); shell.dataset.builderOwned = '';
    config.mount.append(shell);

    function failure(error) { config.showError?.(error instanceof Error ? error.message : String(error)); }
    function mutate(callback) {
      try {
        const next = clone(config.getDocument());
        next.version = 2; next.layout = next.layout || schema.emptyLayout();
        callback(next.layout, next);
        next.layout = schema.validateLayout(next.layout);
        const pageIds = new Set(next.layout.pages.map(page => page.id));
        next.edits = next.edits.filter(edit => {
          const customPage = /^\[data-ui-key="page\.(custom-[a-z]{6,24})\./.exec(edit.selector)?.[1];
          return !customPage || pageIds.has(customPage);
        });
        const result = config.commitDocument(next);
        if (result?.catch) result.catch(failure);
        return true;
      } catch (error) { failure(error); return false; }
    }
    function freshId(prefix, used = []) {
      const taken = new Set(used);
      let result;
      do {
        const bytes = new Uint8Array(12); crypto.getRandomValues(bytes);
        result = `${prefix}-${[...bytes].map(number => String.fromCharCode(97 + number % 26)).join('')}`;
      } while (taken.has(result));
      return result;
    }
    function pageName(id) { return layout.pages.find(page => page.id === id)?.label || PAGE_NAMES[id] || id; }
    function currentPage() { const id = config.getCurrentPage(); return layout.navigation.includes(id) ? id : 'overview'; }
    function component(id) { return layout.components.find(item => item.id === id); }
    function descendants(items, id) {
      const found = new Set([id]);
      let changed = true;
      while (changed) { changed = false; for (const item of items) if (found.has(item.parent) && !found.has(item.id)) { found.add(item.id); changed = true; } }
      return found;
    }
    function siblingOrder(items, item) { return items.filter(node => node.page === item.page && node.parent === item.parent); }
    function moveSubtree(next, id, page, parent, before = null) {
      const source = next.components.find(item => item.id === id);
      if (!source) throw new Error('这个组件已被删除。');
      const subtreeIds = descendants(next.components, id);
      if (subtreeIds.has(parent) || subtreeIds.has(before)) throw new Error('不能把容器移动到它自己或其子级中。');
      const targetParent = parent ? next.components.find(item => item.id === parent) : null;
      if (parent && (!targetParent || targetParent.type !== 'card' || targetParent.page !== page)) throw new Error('请选择目标页面上的卡片容器。');
      const moving = next.components.filter(item => subtreeIds.has(item.id));
      next.components = next.components.filter(item => !subtreeIds.has(item.id));
      for (const item of moving) item.page = page;
      source.parent = parent;
      let insertion = before ? next.components.findIndex(item => item.id === before && item.page === page && item.parent === parent) : -1;
      if (insertion < 0) insertion = next.components.length;
      next.components.splice(insertion, 0, ...moving);
    }
    function populate(select, options, preferred) {
      const target = preferred ?? select.value;
      const nextSignature = JSON.stringify(options);
      if (select.dataset.builderOptions !== nextSignature) {
        select.replaceChildren(...options.map(([value, label]) => { const option = element('option', '', label); option.value = value; return option; }));
        select.dataset.builderOptions = nextSignature;
      }
      if ([...select.options].some(option => option.value === target)) select.value = target;
      else if (select.options.length) select.selectedIndex = 0;
    }
    function pageOptions() { return layout.navigation.map(id => [id, pageName(id)]); }
    function cardOptions(page, except = null) {
      const omitted = except ? descendants(layout.components, except) : new Set();
      return [['', '页面顶层'], ...layout.components.filter(item => item.page === page && item.type === 'card' && !omitted.has(item.id)).map(item => [item.id, item.label || '未命名卡片'])];
    }
    function setNativeInspectorVisibility() {
      const inspector = $('designer-existing-inspector');
      if (inspector) inspector.hidden = Boolean(selected || editingPage);
    }
    function clearSelection() {
      selected = null; editingPage = null; selectedFingerprint = null; pageFingerprint = null;
      componentEditor.hidden = true; pageEditor.hidden = true;
      setNativeInspectorVisibility(); refreshSelection();
    }
    function select(id) {
      if (!component(id)) return;
      config.clearNativeSelection?.();
      selected = id; editingPage = null; selectedFingerprint = null;
      pageEditor.hidden = true; componentEditor.hidden = false;
      setNativeInspectorVisibility(); refreshComponentEditor(true); refreshSelection();
      componentEditor.open = true;
    }
    function editPage(id) {
      if (!layout.pages.some(page => page.id === id)) return;
      config.clearNativeSelection?.();
      editingPage = id; selected = null; pageFingerprint = null;
      componentEditor.hidden = true; pageEditor.hidden = false;
      setNativeInspectorVisibility(); refreshPageEditor(true); refreshSelection();
      pageEditor.open = true;
    }
    function refreshSelection() {
      for (const [id, entry] of componentNodes) entry.wrapper.classList.toggle('builder-selected', id === selected && mode === 'edit');
      for (const row of treeList.querySelectorAll('[data-builder-tree-id]')) row.classList.toggle('builder-tree-selected', row.dataset.builderTreeId === selected);
    }

    // This editor is created once. Layout/polling updates never replace draft fields.
    const menuPanel = element('details', 'builder-group'); menuPanel.open = true;
    menuPanel.append(element('summary', '', '菜单与页面'));
    const nameField = field('新菜单名称', 'builder-add-page-name', 'input', 80);
    nameField.control.placeholder = '例如：我的工作台'; menuPanel.append(nameField.label);
    menuPanel.append(button('＋ 创建菜单和页面', 'builder-add-page', () => {
      const label = nameField.control.value.trim();
      if (!label) { failure('先填写一个菜单名称。'); nameField.control.focus(); return; }
      let id;
      if (mutate(next => {
        if (next.pages.length >= schema.MAX_LAYOUT_PAGES) throw new Error(`最多可以创建 ${schema.MAX_LAYOUT_PAGES} 个页面。`);
        id = freshId('custom', next.navigation);
        next.pages.push({ id, label, title: label, description: '', icon: '□' }); next.navigation.push(id);
      })) { nameField.control.value = ''; config.navigate(id); editPage(id); }
    }, 'designer-primary'));
    menuPanel.append(element('p', 'designer-note', '拖动菜单或用 ↑ ↓ 调整顺序。自建菜单可改名和删除；原有页面仍保留原来的功能。'));
    const menuList = element('div', 'builder-menu-list'); menuList.id = 'builder-page-list'; menuPanel.append(menuList); shell.append(menuPanel);
    const pageEditor = element('details', 'builder-group builder-page-editor'); pageEditor.hidden = true; pageEditor.open = true;
    pageEditor.append(element('summary', '', '编辑自建页面'));
    for (const [label, id, tag, maximum] of [['菜单名称', 'builder-page-label', 'input', 80], ['页面标题', 'builder-page-title', 'input', 120], ['页面说明', 'builder-page-description', 'textarea', 500], ['菜单图标（最多 4 个字符）', 'builder-page-icon', 'input', 4]]) pageEditor.append(field(label, id, tag, maximum).label);
    pageEditor.append(button('保存页面', 'builder-save-page', () => {
      if (!editingPage) return;
      const id = editingPage;
      if (!$('builder-page-label').value.trim()) { failure('菜单名称不能为空。'); return; }
      mutate((next, nextDocument) => {
        const page = next.pages.find(item => item.id === id); if (!page) throw new Error('页面已被删除。');
        const changedText = new Set(['title', 'description'].filter(key => page[key] !== $(`builder-page-${key}`).value).map(key => `[data-ui-key="page.${id}.${key}"]`));
        Object.assign(page, { label: $('builder-page-label').value, title: $('builder-page-title').value, description: $('builder-page-description').value, icon: $('builder-page-icon').value });
        nextDocument.edits = nextDocument.edits.flatMap(edit => {
          if (!changedText.has(edit.selector) || !Object.hasOwn(edit, 'text')) return [edit];
          const updated = { ...edit }; delete updated.text; return Object.keys(updated).length > 1 ? [updated] : [];
        });
      });
    }, 'designer-primary'));
    pageEditor.append(button('返回元素编辑', 'builder-close-page-editor', clearSelection)); shell.append(pageEditor);

    const library = element('details', 'builder-group'); library.open = true; library.append(element('summary', '', '添加组件'));
    const libraryGrid = element('div', 'builder-library');
    for (const [type, label] of Object.entries(TYPE_NAMES)) {
      const entry = button(label, null, () => addComponent(type));
      entry.dataset.builderLibraryType = type; entry.draggable = true;
      entry.title = `点击添加${label}，也可拖入页面或卡片`; libraryGrid.append(entry);
    }
    library.append(libraryGrid);
    const typeField = field('组件类型', 'builder-component-type', 'select');
    populate(typeField.control, Object.entries(TYPE_NAMES)); library.append(typeField.label);
    library.append(field('添加到页面', 'builder-target-page', 'select').label, field('放入容器', 'builder-target-parent', 'select').label);
    library.append(button('＋ 添加组件', 'builder-add-component', () => addComponent($('builder-component-type').value), 'designer-primary'));
    library.append(element('p', 'designer-note', '新组件可自由移动。输入框和开关只用于界面预览，输入值不会保存或导出。'));
    shell.append(library);

    const treePanel = element('details', 'builder-group'); treePanel.open = true; treePanel.append(element('summary', '', '当前页面的自建组件'));
    const treeList = element('div', 'builder-tree'); treeList.id = 'builder-component-list'; treePanel.append(treeList); shell.append(treePanel);
    const componentEditor = element('details', 'builder-group builder-component-editor'); componentEditor.open = true; componentEditor.hidden = true;
    const editorHeading = element('summary', '', '组件属性'); componentEditor.append(editorHeading);
    for (const [label, id, tag, maximum] of [['组件名称 / 显示标签', 'builder-component-label', 'input', 120], ['正文', 'builder-component-text', 'textarea', 2000], ['辅助说明', 'builder-component-description', 'textarea', 500], ['占位提示', 'builder-component-placeholder', 'input', 120], ['下拉选项（每行一项，最多 30 项）', 'builder-component-options', 'textarea', 3630]]) componentEditor.append(field(label, id, tag, maximum).label);
    componentEditor.append(field('所在页面', 'builder-component-page', 'select').label, field('父级容器', 'builder-component-parent', 'select').label);
    const columns = field('卡片列数', 'builder-component-columns', 'select'); populate(columns.control, [['1', '1 列'], ['2', '2 列'], ['3', '3 列']]); componentEditor.append(columns.label);
    const action = field('按钮点击动作', 'builder-component-action', 'select'); populate(action.control, [['none', '无动作'], ['navigate', '跳转到页面'], ['pending', '待实现功能（显示说明）']]); componentEditor.append(action.label);
    componentEditor.append(field('跳转页面', 'builder-component-action-target', 'select').label, field('待实现功能说明', 'builder-component-action-note', 'textarea', 500).label);
    const stylePanel = element('details'); stylePanel.append(element('summary', '', '样式'));
    const styleGrid = element('div', 'designer-style-grid');
    for (const key of schema.STYLE_KEYS) {
      const select = ['fontWeight', 'textAlign'].includes(key);
      const item = field(STYLE_NAMES[key], `builder-component-style-${key}`, select ? 'select' : 'input', 100);
      if (select) populate(item.control, [['', '本版默认'], ...(key === 'fontWeight' ? Array.from({ length: 9 }, (_, index) => [String((index + 1) * 100), String((index + 1) * 100)]) : [['left', '左对齐'], ['center', '居中'], ['right', '右对齐'], ['start', '跟随文字起始'], ['end', '跟随文字末尾']])]);
      styleGrid.append(item.label);
    }
    stylePanel.append(styleGrid, element('p', 'designer-note', '尺寸示例：16px、1rem、100%；行高可用 1.5 或 24px；颜色使用 #RRGGBB。留空恢复默认。')); componentEditor.append(stylePanel);
    componentEditor.append(button('应用组件设置', 'builder-save-component', saveComponent, 'designer-primary'));
    const componentActions = element('div', 'designer-actions');
    componentActions.append(button('复制', 'builder-duplicate-component', duplicateComponent), button('删除', 'builder-delete-component', deleteComponent), button('上移 ↑', 'builder-move-up', () => reorderComponent(-1)), button('下移 ↓', 'builder-move-down', () => reorderComponent(1)));
    componentEditor.append(componentActions, button('取消选择', 'builder-clear-selection', clearSelection)); shell.append(componentEditor);
    const note = element('p', 'designer-note', '此处只搭建前端。按钮可跳转页面或标注待实现功能；账号接管、模型调用和权限仍由原有功能处理。'); shell.append(note);

    function refreshPageEditor(force = false) {
      const page = layout.pages.find(item => item.id === editingPage);
      if (!page) { if (editingPage) clearSelection(); return; }
      const nextFingerprint = JSON.stringify(page);
      if (!force && nextFingerprint === pageFingerprint) return;
      pageFingerprint = nextFingerprint;
      for (const key of ['label', 'title', 'description', 'icon']) $(`builder-page-${key}`).value = page[key];
    }
    function showField(id, visible) { $(id).closest('.designer-field').hidden = !visible; }
    function refreshActionFields() {
      const type = $('builder-component-action').value;
      showField('builder-component-action-target', type === 'navigate');
      showField('builder-component-action-note', type === 'pending');
    }
    function refreshComponentEditor(force = false) {
      const item = component(selected);
      if (!item) { if (selected) clearSelection(); return; }
      const nextFingerprint = JSON.stringify(item);
      if (!force && nextFingerprint === selectedFingerprint) {
        populate($('builder-component-page'), pageOptions());
        populate($('builder-component-parent'), cardOptions($('builder-component-page').value, item.id));
        populate($('builder-component-action-target'), pageOptions()); return;
      }
      selectedFingerprint = nextFingerprint;
      setText(editorHeading, `${TYPE_NAMES[item.type]}属性`);
      $('builder-component-label').value = item.label;
      for (const key of ['text', 'description', 'placeholder']) $(`builder-component-${key}`).value = item[key] || '';
      $('builder-component-options').value = (item.options || []).map(option => option.label).join('\n');
      populate($('builder-component-page'), pageOptions(), item.page);
      populate($('builder-component-parent'), cardOptions(item.page, item.id), item.parent || '');
      $('builder-component-columns').value = String(item.columns || 1);
      $('builder-component-action').value = item.action?.type || 'none';
      populate($('builder-component-action-target'), pageOptions(), item.action?.target || item.page);
      $('builder-component-action-note').value = item.action?.note || '';
      for (const key of schema.STYLE_KEYS) $(`builder-component-style-${key}`).value = item.styles?.[key] || '';
      showField('builder-component-text', ['heading', 'text', 'card'].includes(item.type));
      showField('builder-component-description', item.type !== 'divider');
      showField('builder-component-placeholder', ['input', 'textarea'].includes(item.type));
      showField('builder-component-options', item.type === 'select');
      showField('builder-component-columns', item.type === 'card');
      showField('builder-component-action', item.type === 'button');
      refreshActionFields();
      if (item.type !== 'button') { showField('builder-component-action-target', false); showField('builder-component-action-note', false); }
    }
    function refreshCreationTargets() {
      const pageSelect = $('builder-target-page');
      populate(pageSelect, pageOptions(), pageSelect.dataset.userChosen ? pageSelect.value : currentPage());
      populate($('builder-target-parent'), cardOptions(pageSelect.value));
    }
    $('builder-target-page').addEventListener('change', () => { $('builder-target-page').dataset.userChosen = 'true'; populate($('builder-target-parent'), cardOptions($('builder-target-page').value), ''); });
    $('builder-component-page').addEventListener('change', () => populate($('builder-component-parent'), cardOptions($('builder-component-page').value, selected), ''));
    $('builder-component-action').addEventListener('change', refreshActionFields);

    function makeComponent(next, type, page, parent, before = null) {
      if (!schema.COMPONENT_TYPES.includes(type)) throw new Error('请选择支持的组件类型。');
      if (next.components.length >= schema.MAX_LAYOUT_COMPONENTS) throw new Error(`最多可以创建 ${schema.MAX_LAYOUT_COMPONENTS} 个组件。`);
      const id = freshId('block', next.components.map(item => item.id));
      const item = { id, type, page, parent, label: TYPE_NAMES[type] };
      if (['heading', 'text'].includes(type)) item.text = type === 'heading' ? '新的标题' : '在这里填写你的内容。';
      if (['input', 'textarea'].includes(type)) item.placeholder = '仅用于界面预览';
      if (type === 'select') item.options = ['选项一', '选项二'].map(label => ({ id: freshId('choice'), label }));
      if (type === 'card') item.columns = 1;
      if (type === 'button') item.action = { type: 'none' };
      const index = before ? next.components.findIndex(node => node.id === before) : -1;
      if (index >= 0) next.components.splice(index, 0, item); else next.components.push(item);
      return id;
    }
    function addComponent(type, destination = null) {
      const page = destination?.page || $('builder-target-page').value || currentPage();
      const parent = destination ? destination.parent : $('builder-target-parent').value || null;
      let id;
      if (mutate(next => { id = makeComponent(next, type, page, parent, destination?.before); })) {
        config.navigate(page); select(id);
      }
    }
    function saveComponent() {
      const previous = component(selected); if (!previous) return;
      const id = previous.id;
      mutate(next => {
        const item = next.components.find(node => node.id === id);
        const page = $('builder-component-page').value;
        const parent = $('builder-component-parent').value || null;
        if (page !== item.page || parent !== item.parent) moveSubtree(next, id, page, parent);
        item.label = $('builder-component-label').value;
        for (const key of ['text', 'description', 'placeholder']) {
          if (!$(`builder-component-${key}`).closest('.designer-field').hidden) {
            const value = $(`builder-component-${key}`).value;
            if (value) item[key] = value; else delete item[key];
          }
        }
        if (item.type === 'select') {
          const lines = $('builder-component-options').value.split(/\r?\n/);
          const labels = lines.length === 1 && lines[0] === '' ? [] : lines;
          if (labels.length > 30) throw new Error('下拉选项最多 30 项。');
          // Keep choice identity through label edits. Values entered in preview
          // are deliberately absent from the document and this property editor.
          item.options = labels.map((label, index) => ({ id: item.options?.[index]?.id || freshId('choice'), label }));
        }
        if (item.type === 'card') item.columns = Number($('builder-component-columns').value);
        if (item.type === 'button') {
          const type = $('builder-component-action').value;
          item.action = type === 'navigate' ? { type, target: $('builder-component-action-target').value } : type === 'pending' ? { type, note: $('builder-component-action-note').value } : { type: 'none' };
        }
        const styles = {};
        for (const key of schema.STYLE_KEYS) { const value = $(`builder-component-style-${key}`).value.trim(); if (value) styles[key] = value; }
        if (Object.keys(styles).length) item.styles = styles; else delete item.styles;
      });
      if (component(id)) config.navigate(component(id).page);
    }
    function deleteComponent() {
      const id = selected; if (!id) return;
      if (mutate(next => { const subtree = descendants(next.components, id); next.components = next.components.filter(item => !subtree.has(item.id)); })) clearSelection();
    }
    function duplicateComponent() {
      const original = component(selected); if (!original) return;
      let rootId;
      if (mutate(next => {
        const subtree = descendants(next.components, original.id);
        const originals = next.components.filter(item => subtree.has(item.id));
        if (next.components.length + originals.length > schema.MAX_LAYOUT_COMPONENTS) throw new Error('复制后会超过组件数量上限。');
        const taken = next.components.map(item => item.id);
        const mapping = new Map(originals.map(item => { const id = freshId('block', taken); taken.push(id); return [item.id, id]; }));
        const copies = originals.map(item => {
          const copied = clone(item); copied.id = mapping.get(item.id); copied.parent = mapping.get(item.parent) || item.parent;
          if (item.id === original.id) copied.label = `${item.label.slice(0, 116)} 副本`;
          if (copied.options) copied.options = copied.options.map(option => ({ ...option, id: freshId('choice') }));
          return copied;
        });
        rootId = mapping.get(original.id);
        const last = Math.max(...originals.map(item => next.components.indexOf(item))); next.components.splice(last + 1, 0, ...copies);
      })) select(rootId);
    }
    function reorderComponent(direction) {
      const item = component(selected); if (!item) return;
      const siblings = siblingOrder(layout.components, item);
      const at = siblings.findIndex(node => node.id === item.id);
      if (at + direction < 0 || at + direction >= siblings.length) return;
      const before = direction < 0 ? siblings[at - 1].id : siblings[at + 2]?.id || null;
      mutate(next => moveSubtree(next, item.id, item.page, item.parent, before));
    }
    function reorderPage(id, direction) {
      mutate(next => { const at = next.navigation.indexOf(id); const target = at + direction; if (target >= 0 && target < next.navigation.length) [next.navigation[at], next.navigation[target]] = [next.navigation[target], next.navigation[at]]; });
    }
    function deletePage(id) {
      const page = layout.pages.find(item => item.id === id); if (!page) return;
      const wasCurrent = currentPage() === id;
      if (mutate(next => {
        next.pages = next.pages.filter(item => item.id !== id); next.navigation = next.navigation.filter(item => item !== id);
        next.components = next.components.filter(item => item.page !== id);
        for (const item of next.components) if (item.action?.type === 'navigate' && item.action.target === id) item.action = { type: 'none' };
      })) { clearSelection(); if (wasCurrent) config.navigate('overview'); }
    }

    function refreshMenuList() {
      menuList.replaceChildren();
      layout.navigation.forEach((id, index) => {
        const page = layout.pages.find(item => item.id === id);
        const row = element('div', 'builder-menu-row'); row.dataset.builderMenuRow = id; row.draggable = true;
        row.dataset.builderDrop = 'menu'; row.dataset.builderDropId = id;
        const visit = button(pageName(id), null, () => config.navigate(id), 'builder-menu-name'); visit.dataset.builderMenuAction = 'navigate'; visit.title = '打开页面';
        row.append(element('span', 'builder-drag-marker', '⠿'), visit);
        const up = button('↑', null, () => reorderPage(id, -1)); up.dataset.builderMenuAction = 'up'; up.disabled = index === 0; up.title = '菜单上移';
        const down = button('↓', null, () => reorderPage(id, 1)); down.dataset.builderMenuAction = 'down'; down.disabled = index === layout.navigation.length - 1; down.title = '菜单下移';
        row.append(up, down);
        if (page) {
          const edit = button('改', null, () => editPage(id)); edit.dataset.builderMenuAction = 'edit'; edit.title = '编辑菜单和页面';
          const remove = button('×', null, () => deletePage(id)); remove.dataset.builderMenuAction = 'delete'; remove.title = '删除自建页面'; row.append(edit, remove);
        } else row.append(element('small', 'builder-builtin-label', '原有'));
        menuList.append(row);
      });
    }
    function refreshTree() {
      treeList.replaceChildren();
      const items = layout.components.filter(item => item.page === currentPage());
      if (!items.length) { treeList.append(element('p', 'designer-note', '当前页面还没有自建组件。可从上方添加，也可拖入页面。')); return; }
      function appendLevel(parent, depth) {
        for (const item of items.filter(node => node.parent === parent)) {
          const row = element('div', 'builder-tree-row'); row.dataset.builderTreeId = item.id; row.draggable = true;
          row.dataset.builderDrop = 'before'; row.dataset.builderDropId = item.id; row.style.setProperty('--builder-depth', String(depth));
          const selectButton = button(`${TYPE_NAMES[item.type]} · ${item.label || '未命名'}`, null, () => select(item.id));
          selectButton.title = '选择组件；拖动可调整顺序'; row.append(element('span', 'builder-drag-marker', '⠿'), selectButton); treeList.append(row);
          if (item.type === 'card') appendLevel(item.id, depth + 1);
        }
      }
      appendLevel(null, 0); refreshSelection();
    }
    function createComponentNode(item) {
      const wrapper = element('div', `builder-block builder-block-${item.type}`);
      wrapper.dataset.builderId = item.id; wrapper.dataset.builderOwned = ''; wrapper.dataset.builderDrop = 'before'; wrapper.dataset.builderDropId = item.id;
      const handle = button(`⠿ ${TYPE_NAMES[item.type]}`, null, () => select(item.id), 'builder-block-handle'); handle.draggable = true;
      handle.dataset.builderDragHandle = item.id; handle.setAttribute('aria-label', `拖动或选择${TYPE_NAMES[item.type]}`);
      wrapper.append(handle);
      const surface = element('div', 'builder-component-surface'); wrapper.append(surface);
      const entry = { wrapper, handle, surface, type: item.type, fingerprint: null, appliedStyles: [] };
      if (item.type === 'heading') { entry.text = element('h2', 'builder-heading'); surface.append(entry.text); }
      if (item.type === 'text') { entry.text = element('p', 'builder-text'); surface.append(entry.text); }
      if (item.type === 'button') {
        entry.control = button('', null, () => {
          if (mode === 'edit') { select(item.id); return; }
          const action = component(item.id)?.action;
          if (action?.type === 'navigate') config.navigate(action.target);
          else if (action?.type === 'pending') showPending(action.note);
        }, 'button button-primary'); surface.append(entry.control);
      }
      if (['input', 'textarea', 'select', 'switch'].includes(item.type)) {
        const label = element('label', `builder-control-label${item.type === 'switch' ? ' builder-switch' : ''}`);
        entry.label = element('span');
        entry.control = element(item.type === 'textarea' ? 'textarea' : item.type === 'select' ? 'select' : 'input');
        entry.control.id = `builder-control-${item.id}`; entry.control.autocomplete = 'off';
        if (item.type === 'switch') { entry.control.type = 'checkbox'; label.append(entry.control, entry.label); }
        else { if (item.type === 'input') entry.control.type = 'text'; label.append(entry.label, entry.control); }
        surface.append(label);
      }
      if (item.type === 'card') {
        surface.classList.add('builder-card'); entry.label = element('h3', 'builder-card-title'); entry.text = element('p', 'builder-text');
        surface.append(entry.label, entry.text);
      }
      if (item.type === 'divider') surface.append(element('hr', 'builder-divider'));
      entry.description = element('p', 'builder-description'); surface.append(entry.description);
      if (item.type === 'card') {
        entry.children = element('div', 'builder-card-children'); entry.children.dataset.builderDrop = 'inside'; entry.children.dataset.builderDropId = item.id;
        entry.empty = element('div', 'builder-card-empty', '将组件拖入这张卡片，或在“放入容器”中选择此卡片后添加'); entry.empty.dataset.builderDrop = 'inside'; entry.empty.dataset.builderDropId = item.id;
        entry.children.append(entry.empty); surface.append(entry.children);
      }
      return entry;
    }
    function showPending(noteText) {
      const previous = document.getElementById('builder-action-notice'); if (previous) previous.remove();
      const notice = element('div', 'builder-action-notice'); notice.id = 'builder-action-notice'; notice.dataset.builderOwned = ''; notice.setAttribute('role', 'status');
      notice.append(element('strong', '', '待实现功能'), element('p', '', noteText || '这个按钮的后端功能尚未接入。'));
      notice.append(button('关闭', null, () => notice.remove())); document.body.append(notice);
    }
    function updateComponentNode(entry, item) {
      const nextFingerprint = JSON.stringify(item);
      if (entry.fingerprint === nextFingerprint) return;
      entry.fingerprint = nextFingerprint;
      if (entry.label) setText(entry.label, item.label);
      if (entry.text) { setText(entry.text, item.text || (item.type === 'heading' ? item.label : '')); entry.text.hidden = !entry.text.textContent; }
      setText(entry.description, item.description || ''); entry.description.hidden = !item.description || item.type === 'divider';
      if (item.type === 'button') setText(entry.control, item.label);
      if (['input', 'textarea'].includes(item.type)) entry.control.placeholder = item.placeholder || '';
      if (item.type === 'select') {
        const value = entry.control.value; const options = item.options || [];
        const optionsSignature = JSON.stringify(options);
        if (entry.optionsSignature !== optionsSignature) {
          entry.control.replaceChildren(...options.map(option => { const node = element('option', '', option.label); node.value = option.id; return node; }));
          if (options.some(option => option.id === value)) entry.control.value = value;
          entry.optionsSignature = optionsSignature;
        }
      }
      if (item.type === 'card') entry.children.style.setProperty('--builder-columns', String(item.columns || 1));
      for (const [node, key] of entry.appliedStyles) node.style[key] = '';
      entry.appliedStyles = [];
      const assignStyle = (node, key, value) => { node.style[key] = value; entry.appliedStyles.push([node, key]); };
      const typography = ['fontSize', 'fontWeight', 'lineHeight', 'textAlign'];
      const visualControl = ['button', 'input', 'textarea', 'select'].includes(item.type);
      for (const [key, value] of Object.entries(item.styles || {})) {
        let target = entry.wrapper;
        if (key === 'gap') target = entry.children || entry.surface;
        else if (typography.includes(key)) target = entry.surface;
        else if (['height', 'minHeight'].includes(key)) target = visualControl ? entry.control : entry.surface;
        else if (key === 'minWidth' && item.type === 'button') target = entry.control;
        else if (['backgroundColor', 'padding', 'borderRadius'].includes(key)) {
          target = visualControl ? entry.control : ['card', 'switch'].includes(item.type) ? entry.surface : entry.wrapper;
        }
        assignStyle(target, key, value);
      }
      if (item.type === 'button' && (item.styles?.width || item.styles?.maxWidth)) assignStyle(entry.control, 'width', '100%');
      // Default component typography must not swallow author-selected size,
      // weight, alignment or line spacing on the actual visible control/text.
      for (const property of typography) if (item.styles?.[property]) {
        for (const node of [entry.text, entry.label, entry.control].filter(Boolean)) assignStyle(node, property, 'inherit');
        if (entry.control && ['input', 'textarea', 'select', 'switch'].includes(item.type)) assignStyle(entry.control.parentElement, property, 'inherit');
      }
      if (entry.control && item.styles?.color) assignStyle(entry.control, 'color', 'inherit');
    }
    function ensurePageRoot(id) {
      if (pageRoots.has(id)) return pageRoots.get(id);
      const section = document.getElementById(`page-${id}`); if (!section) return null;
      const root = element('div', 'builder-page-content'); root.dataset.builderPage = id; root.dataset.builderOwned = ''; root.dataset.builderDrop = 'page'; root.dataset.builderDropId = id;
      const empty = element('div', 'builder-page-empty');
      empty.append(element('strong', '', id.startsWith('custom-') ? '这个页面由你设计' : '在这里添加自建组件'), element('p', '', '从编辑面板添加标题、按钮、下拉栏或卡片，也可以直接拖入组件。'));
      const add = button('＋ 添加组件', null, () => {
        $('builder-target-page').dataset.userChosen = 'true'; populate($('builder-target-page'), pageOptions(), id); populate($('builder-target-parent'), cardOptions(id), '');
        library.open = true; $('builder-component-type').focus(); library.scrollIntoView({ block: 'nearest' });
      }, 'button button-secondary'); add.dataset.builderAddHere = id; empty.append(add);
      root.append(empty); section.append(root);
      const entry = { root, empty }; pageRoots.set(id, entry); return entry;
    }
    function reconcilePages() {
      const wanted = new Set(layout.pages.map(page => page.id));
      for (const [id, entry] of customPages) if (!wanted.has(id)) { entry.remove(); customPages.delete(id); pageRoots.delete(id); }
      for (const [id, entry] of customNavigation) if (!wanted.has(id)) { entry.remove(); customNavigation.delete(id); }
      for (const page of layout.pages) {
        let section = customPages.get(page.id);
        if (!section) {
          section = element('section', 'page-panel hidden'); section.id = `page-${page.id}`; section.dataset.builderOwned = ''; section.dataset.builderCustomPage = page.id;
          sectionHost.insertBefore(section, sectionHost.querySelector(':scope > .page-footer')); customPages.set(page.id, section);
        }
        section.classList.toggle('hidden', currentPage() !== page.id);
        let link = customNavigation.get(page.id);
        if (!link) {
          link = button('', null, () => config.navigate(page.id), 'nav-link'); link.dataset.page = page.id; link.dataset.builderNav = ''; link.dataset.builderOwned = '';
          const icon = element('span'); icon.setAttribute('aria-hidden', 'true'); link.append(icon, document.createTextNode(''));
          customNavigation.set(page.id, link);
        }
        setText(link.firstChild, page.icon || '□');
        if (link.lastChild.textContent !== page.label) link.lastChild.textContent = page.label;
        link.classList.toggle('active', currentPage() === page.id);
      }
      if (nav) {
        const links = layout.navigation.map(id => customNavigation.get(id) || nativeNavigation.get(id)).filter(Boolean);
        // Avoid re-appending nodes that are already in the correct order: it
        // would otherwise wake the original editor's MutationObserver forever.
        links.forEach((link, index) => { if (nav.children[index] !== link) nav.insertBefore(link, nav.children[index] || null); });
      }
      for (const id of layout.navigation) ensurePageRoot(id);
    }
    function reconcileComponents() {
      const wanted = new Set(layout.components.map(item => item.id));
      for (const [id, entry] of componentNodes) if (!wanted.has(id)) { entry.wrapper.remove(); componentNodes.delete(id); }
      for (const item of layout.components) {
        let entry = componentNodes.get(item.id);
        if (!entry || entry.type !== item.type) { entry?.wrapper.remove(); entry = createComponentNode(item); componentNodes.set(item.id, entry); }
        updateComponentNode(entry, item);
      }
      function placeChildren(parentNode, page, parent, empty) {
        const children = layout.components.filter(item => item.page === page && item.parent === parent);
        if (empty) empty.hidden = Boolean(children.length);
        // Nodes are reused even when parents/pages change; preview input,
        // select and checkbox states remain local to their DOM controls.
        children.forEach((item, index) => {
          const entry = componentNodes.get(item.id);
          const currentChildren = [...parentNode.children].filter(node => node.hasAttribute('data-builder-id'));
          if (currentChildren[index] !== entry.wrapper) parentNode.insertBefore(entry.wrapper, currentChildren[index] || null);
          if (item.type === 'card') placeChildren(entry.children, page, item.id, entry.empty);
        });
      }
      for (const id of layout.navigation) {
        const page = pageRoots.get(id); if (!page) continue;
        placeChildren(page.root, id, null, page.empty);
        page.root.classList.toggle('builder-page-has-content', layout.components.some(item => item.page === id && item.parent === null));
      }
    }
    function render(nextDocument) {
      const nextLayout = nextDocument.layout || schema.emptyLayout();
      const nextSignature = JSON.stringify(nextLayout);
      documentState = nextDocument;
      if (nextSignature === signature || renderInProgress) return;
      renderInProgress = true;
      try {
        const routedPage = config.getCurrentPage();
        const previousMetadata = layout.pages.find(page => page.id === routedPage);
        layout = nextLayout; signature = nextSignature;
        reconcilePages(); reconcileComponents(); refreshMenuList(); refreshCreationTargets(); refreshTree(); refreshPageEditor(); refreshComponentEditor(); refreshSelection();
        const nextMetadata = layout.pages.find(page => page.id === routedPage);
        if (!layout.navigation.includes(routedPage)) config.navigate('overview');
        else if (nextMetadata && JSON.stringify(previousMetadata) !== JSON.stringify(nextMetadata)) config.navigate(routedPage);
      } finally { renderInProgress = false; }
    }
    function setMode(nextMode) {
      mode = nextMode; shell.dataset.builderMode = mode;
      document.body.dataset.builderMode = mode;
      refreshSelection();
      if (mode !== 'edit') { dragState = null; clearDropMarkers(); }
    }
    function owns(target) { return target instanceof Element && Boolean(target.closest('[data-builder-owned], #designer-builder-slot')); }
    function handleEditEvent(event) {
      if (mode !== 'edit' || !(event.target instanceof Element)) return false;
      const target = event.target;
      if (target.closest('#designer-builder-slot')) return true;
      const menu = target.closest('[data-builder-nav]');
      if (menu) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.type === 'click' || (event.type === 'keydown' && ['Enter', ' '].includes(event.key))) { config.navigate(menu.dataset.page); editPage(menu.dataset.page); }
        return true;
      }
      const add = target.closest('[data-builder-add-here]');
      if (add) return true;
      const block = target.closest('[data-builder-id]');
      if (block) {
        if (event.type === 'keydown' && ['Escape', 'Tab'].includes(event.key)) return true;
        if (target.closest('[data-builder-drag-handle]') && ['pointerdown', 'mousedown'].includes(event.type)) { select(block.dataset.builderId); return true; }
        event.preventDefault(); event.stopImmediatePropagation();
        if (['pointerdown', 'click'].includes(event.type) || event.type === 'keydown' && ['Enter', ' '].includes(event.key)) select(block.dataset.builderId);
        return true;
      }
      // Empty drop regions belong to the builder too, never to an account
      // action underneath them. Their own click/drag handlers remain usable.
      if (target.closest('[data-builder-page]')) return true;
      return false;
    }
    function payload(event) {
      if (dragState) return dragState;
      try {
        const raw = event.dataTransfer?.getData(MIME); if (!raw) return null;
        const value = JSON.parse(raw);
        if (value?.kind === 'page' && layout.navigation.includes(value.id)) return { kind: 'page', id: value.id };
        if (value?.kind === 'component' && component(value.id)) return { kind: 'component', id: value.id };
        if (value?.kind === 'new' && schema.COMPONENT_TYPES.includes(value.type)) return { kind: 'new', type: value.type };
      } catch { /* Other applications' drag payloads are never interpreted. */ }
      return null;
    }
    function clearDropMarkers() { for (const target of document.querySelectorAll('.builder-drop-over')) target.classList.remove('builder-drop-over'); }
    document.addEventListener('dragstart', event => {
      if (mode !== 'edit' || !(event.target instanceof Element)) return;
      const libraryType = event.target.closest('[data-builder-library-type]')?.dataset.builderLibraryType;
      const menuId = event.target.closest('[data-builder-menu-row]')?.dataset.builderMenuRow;
      const componentId = event.target.closest('[data-builder-drag-handle]')?.dataset.builderDragHandle || event.target.closest('[data-builder-tree-id]')?.dataset.builderTreeId;
      const value = libraryType ? { kind: 'new', type: libraryType } : menuId ? { kind: 'page', id: menuId } : componentId ? { kind: 'component', id: componentId } : null;
      if (!value) return;
      dragState = value;
      event.dataTransfer.setData(MIME, JSON.stringify(value)); event.dataTransfer.effectAllowed = value.kind === 'new' ? 'copy' : 'move';
      event.stopPropagation();
    }, true);
    document.addEventListener('dragover', event => {
      if (mode !== 'edit' || !(event.target instanceof Element)) return;
      const destination = event.target.closest('[data-builder-drop]'); const source = payload(event);
      if (!destination || !source || (destination.dataset.builderDrop === 'menu') !== (source.kind === 'page')) return;
      event.preventDefault(); event.stopPropagation(); clearDropMarkers(); destination.classList.add('builder-drop-over');
      event.dataTransfer.dropEffect = source.kind === 'new' ? 'copy' : 'move';
    }, true);
    document.addEventListener('drop', event => {
      if (mode !== 'edit' || !(event.target instanceof Element)) return;
      const target = event.target.closest('[data-builder-drop]'); const source = payload(event);
      clearDropMarkers(); dragState = null;
      if (!target || !source || (target.dataset.builderDrop === 'menu') !== (source.kind === 'page')) return;
      event.preventDefault(); event.stopPropagation();
      const kind = target.dataset.builderDrop; const id = target.dataset.builderDropId;
      if (source.kind === 'page') {
        if (id === source.id) return;
        mutate(next => { next.navigation = next.navigation.filter(page => page !== source.id); next.navigation.splice(next.navigation.indexOf(id), 0, source.id); }); return;
      }
      const targetComponent = component(id);
      const destination = kind === 'page' ? { page: id, parent: null } : targetComponent ? { page: targetComponent.page, parent: kind === 'inside' ? targetComponent.id : targetComponent.parent, before: kind === 'before' ? id : null } : null;
      if (!destination) return;
      if (source.kind === 'new') { addComponent(source.type, destination); return; }
      if (source.id === id && kind === 'before') return;
      if (mutate(next => moveSubtree(next, source.id, destination.page, destination.parent, destination.before))) { config.navigate(destination.page); select(source.id); }
    }, true);
    document.addEventListener('dragend', () => { dragState = null; clearDropMarkers(); }, true);
    document.addEventListener('qq-service-page-change', () => {
      delete $('builder-target-page').dataset.userChosen;
      refreshCreationTargets(); refreshTree();
    });

    const instance = { render, setMode, select, clearSelection, owns, handleEditEvent, getPage: id => { const page = layout.pages.find(item => item.id === id); return page ? { ...page } : null; } };
    activeInstance = instance; render(documentState); setMode(mode);
    return instance;
  }
  Object.defineProperty(window, 'QQServiceBuilder', { value: Object.freeze({ create, getPage: id => activeInstance?.getPage(id) || null }), enumerable: true });
})();
