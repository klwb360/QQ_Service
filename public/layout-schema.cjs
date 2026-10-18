/* Shared finite presentation schema. Loaded unchanged by Electron and the browser. */
(function exposeSchema(root, factory) {
  'use strict';
  const schema = factory();
  if (typeof module === 'object' && module.exports) module.exports = schema;
  else Object.defineProperty(root, 'QQServiceLayoutSchema', { value: schema, enumerable: true });
})(typeof globalThis === 'object' ? globalThis : this, function createSchema() {
  'use strict';

  const MAX_UI_DESIGN_BYTES = 512 * 1024;
  const MAX_UI_DESIGN_EDITS = 400;
  const MAX_LAYOUT_PAGES = 24;
  const MAX_LAYOUT_COMPONENTS = 200;
  const MAX_PARENT_DEPTH = 4;
  const BUILTIN_PAGES = Object.freeze(['overview', 'connections', 'scenarios', 'modules', 'records', 'settings']);
  const COMPONENT_TYPES = Object.freeze(['heading', 'text', 'button', 'select', 'input', 'textarea', 'switch', 'card', 'divider']);
  const STYLE_KEYS = Object.freeze(['fontSize', 'color', 'backgroundColor', 'padding', 'margin', 'borderRadius', 'width', 'maxWidth', 'gap']);
  const EMPTY_UI_DESIGN = Object.freeze({ version: 1, edits: Object.freeze([]) });
  const INVALID = '界面修改格式无效，请仅调整文字、显示状态和支持的样式。';
  const SELECTOR = /^\[data-ui-key="([a-zA-Z][a-zA-Z0-9_.:-]{0,119})"\]$/;
  const PRIVATE_KEY = /(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|\d{5,}|(?:^|[-_.:])(?:secret|token|password|designer|window-controls|window-minimize|window-maximize|window-quit|login-status|runtime-status|runtime-badge|codex-status|server-dot|server-label)(?:$|[-_.:]))/i;
  const PAGE_ID = /^custom-[a-z]{6,24}$/;
  const COMPONENT_ID = /^block-[a-z]{6,24}$/;
  const CHOICE_ID = /^choice-[a-z]{6,24}$/;

  function invalid() { throw new Error(INVALID); }

  // Validate descriptors before reading values, including optional values. A
  // renderer object must not execute getters while native IPC validates it.
  function record(value, allowed, required = []) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    if (Object.getOwnPropertySymbols(value).length) invalid();
    const properties = Object.getOwnPropertyDescriptors(value);
    for (const [key, descriptor] of Object.entries(properties)) {
      if (!allowed.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    }
    if (required.some(key => !Object.hasOwn(properties, key))) invalid();
  }

  function list(value, maximum) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || Object.getOwnPropertySymbols(value).length) invalid();
    const properties = Object.getOwnPropertyDescriptors(value);
    const length = properties.length?.value;
    if (!Number.isSafeInteger(length) || length > maximum || Object.keys(properties).length !== length + 1) invalid();
    for (let index = 0; index < length; index++) {
      const descriptor = properties[index];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    }
  }

  function plainText(value, maximum) {
    if (typeof value !== 'string' || value.length > maximum
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
      || /<\/?[a-z][^>]*>/i.test(value)) invalid();
    return value;
  }

  function lengthValue(value) {
    const match = /^(\d+(?:\.\d+)?|\.\d+)(px|rem|em|%|vh|vw)$/.exec(value);
    if (value === '0') return true;
    if (!match) return false;
    const amount = Number(match[1]);
    return Number.isFinite(amount) && amount <= (match[2] === 'px' ? 1000 : 100);
  }

  function styleValue(key, value) {
    if (typeof value !== 'string' || value.length > 100 || value !== value.trim()) invalid();
    if (key === 'color' || key === 'backgroundColor') {
      if (!/^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) invalid();
      return value;
    }
    if ((key === 'width' || key === 'maxWidth') && value === 'auto') return value;
    const parts = value.split(/ +/);
    const maximum = ['padding', 'margin', 'borderRadius'].includes(key) ? 4 : key === 'gap' ? 2 : 1;
    if (parts.length > maximum || parts.some(part => !lengthValue(part))) invalid();
    return value;
  }

  function styles(value) {
    record(value, STYLE_KEYS);
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, styleValue(key, val)]));
  }

  function boundBytes(value) {
    // TextEncoder exists both in the supported Chromium runtime and Node.
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_UI_DESIGN_BYTES) invalid();
    return value;
  }

  function emptyLayout() {
    return { pages: [], components: [], navigation: [...BUILTIN_PAGES] };
  }

  function validateLayout(value) {
    record(value, ['pages', 'components', 'navigation'], ['pages', 'components', 'navigation']);
    list(value.pages, MAX_LAYOUT_PAGES);
    list(value.components, MAX_LAYOUT_COMPONENTS);
    list(value.navigation, BUILTIN_PAGES.length + MAX_LAYOUT_PAGES);
    const pageIds = new Set(BUILTIN_PAGES);
    const pages = value.pages.map(page => {
      record(page, ['id', 'label', 'title', 'description', 'icon'], ['id', 'label', 'title', 'description', 'icon']);
      if (typeof page.id !== 'string' || !PAGE_ID.test(page.id) || pageIds.has(page.id)) invalid();
      pageIds.add(page.id);
      return {
        id: page.id, label: plainText(page.label, 80), title: plainText(page.title, 120),
        description: plainText(page.description, 500), icon: plainText(page.icon, 4),
      };
    });
    const navigationIds = new Set();
    const navigation = value.navigation.map(id => {
      if (typeof id !== 'string' || !pageIds.has(id) || navigationIds.has(id)) invalid();
      navigationIds.add(id);
      return id;
    });
    if (navigation.length !== pageIds.size) invalid();

    const componentMap = new Map();
    const components = value.components.map(component => {
      record(component, ['id', 'type', 'page', 'parent', 'label', 'text', 'description', 'placeholder', 'options', 'action', 'styles', 'columns'], ['id', 'type', 'page', 'parent', 'label']);
      if (typeof component.id !== 'string' || !COMPONENT_ID.test(component.id) || componentMap.has(component.id)
        || !COMPONENT_TYPES.includes(component.type) || !pageIds.has(component.page)
        || (component.parent !== null && (typeof component.parent !== 'string' || !COMPONENT_ID.test(component.parent)))) invalid();
      const next = { id: component.id, type: component.type, page: component.page, parent: component.parent, label: plainText(component.label, 120) };
      for (const [key, maximum] of [['text', 2000], ['description', 500], ['placeholder', 120]]) {
        if (Object.hasOwn(component, key)) next[key] = plainText(component[key], maximum);
      }
      if (Object.hasOwn(component, 'styles')) next.styles = styles(component.styles);
      if (Object.hasOwn(component, 'columns')) {
        if (component.type !== 'card' || !Number.isInteger(component.columns) || component.columns < 1 || component.columns > 3) invalid();
        next.columns = component.columns;
      }
      if (Object.hasOwn(component, 'options')) {
        if (component.type !== 'select') invalid();
        list(component.options, 30);
        const choices = new Set();
        next.options = component.options.map(option => {
          record(option, ['id', 'label'], ['id', 'label']);
          if (typeof option.id !== 'string' || !CHOICE_ID.test(option.id) || choices.has(option.id)) invalid();
          choices.add(option.id);
          return { id: option.id, label: plainText(option.label, 120) };
        });
      }
      if (Object.hasOwn(component, 'action')) {
        if (component.type !== 'button') invalid();
        record(component.action, ['type', 'target', 'note'], ['type']);
        if (component.action.type === 'none') {
          record(component.action, ['type'], ['type']);
          next.action = { type: 'none' };
        } else if (component.action.type === 'navigate') {
          record(component.action, ['type', 'target'], ['type', 'target']);
          if (typeof component.action.target !== 'string' || !pageIds.has(component.action.target)) invalid();
          next.action = { type: 'navigate', target: component.action.target };
        } else if (component.action.type === 'pending') {
          record(component.action, ['type', 'note'], ['type', 'note']);
          next.action = { type: 'pending', note: plainText(component.action.note, 500) };
        } else invalid();
      }
      componentMap.set(next.id, next);
      return next;
    });

    // Resolve after copying all nodes so forward references are safe. Parent
    // chains may contain cards on the same page only, with a finite depth.
    for (const component of components) {
      const seen = new Set([component.id]);
      let node = component;
      let depth = 0;
      while (node.parent !== null) {
        if (seen.has(node.parent) || ++depth > MAX_PARENT_DEPTH) invalid();
        seen.add(node.parent);
        node = componentMap.get(node.parent);
        if (!node || node.type !== 'card' || node.page !== component.page) invalid();
      }
    }
    return boundBytes({ pages, components, navigation });
  }

  function validateUiDesign(value) {
    record(value, ['version', 'edits', 'layout'], ['version', 'edits']);
    if (value.version !== 1 && value.version !== 2) invalid();
    if (value.version === 1 && Object.hasOwn(value, 'layout')) invalid();
    if (value.version === 2 && !Object.hasOwn(value, 'layout')) invalid();
    list(value.edits, MAX_UI_DESIGN_EDITS);
    const selectors = new Set();
    const edits = value.edits.map(edit => {
      record(edit, ['selector', 'text', 'hidden', 'styles', 'optionLabels'], ['selector']);
      const match = typeof edit.selector === 'string' && SELECTOR.exec(edit.selector);
      if (!match || PRIVATE_KEY.test(match[1]) || selectors.has(edit.selector)) invalid();
      selectors.add(edit.selector);
      const next = { selector: edit.selector };
      if (Object.hasOwn(edit, 'text')) next.text = plainText(edit.text, 500);
      if (Object.hasOwn(edit, 'hidden')) {
        if (typeof edit.hidden !== 'boolean') invalid();
        next.hidden = edit.hidden;
      }
      if (Object.hasOwn(edit, 'styles')) next.styles = styles(edit.styles);
      if (Object.hasOwn(edit, 'optionLabels')) {
        list(edit.optionLabels, 30);
        const values = new Set();
        next.optionLabels = edit.optionLabels.map(option => {
          record(option, ['value', 'label'], ['value', 'label']);
          if (typeof option.value !== 'string' || option.value.length > 100
            || (option.value !== '' && !/^[a-zA-Z][a-zA-Z0-9_.:-]{0,99}$/.test(option.value))
            || PRIVATE_KEY.test(option.value) || values.has(option.value)) invalid();
          values.add(option.value);
          return { value: option.value, label: plainText(option.label, 120) };
        });
      }
      return next;
    });
    const next = { version: value.version, edits };
    if (value.version === 2) next.layout = validateLayout(value.layout);
    return boundBytes(next);
  }

  return Object.freeze({
    MAX_UI_DESIGN_BYTES, MAX_UI_DESIGN_EDITS, MAX_LAYOUT_PAGES, MAX_LAYOUT_COMPONENTS, MAX_PARENT_DEPTH,
    EMPTY_UI_DESIGN, BUILTIN_PAGES, COMPONENT_TYPES, STYLE_KEYS, validateUiDesign, validateLayout, emptyLayout,
  });
});
