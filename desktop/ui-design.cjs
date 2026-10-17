'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_UI_DESIGN_BYTES = 512 * 1024;
const MAX_UI_DESIGN_EDITS = 400;
const EMPTY_UI_DESIGN = Object.freeze({ version: 1, edits: Object.freeze([]) });
const INVALID = '界面修改格式无效，请仅调整文字、显示状态和支持的样式。';
const STYLE_KEYS = new Set(['fontSize', 'color', 'backgroundColor', 'padding', 'margin', 'borderRadius', 'width', 'maxWidth', 'gap']);
const SELECTOR = /^\[data-ui-key="([a-zA-Z][a-zA-Z0-9_.:-]{0,119})"\]$/;
const PRIVATE_KEY = /(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|\d{5,}|(?:^|[-_.:])(?:secret|token|password|designer|window-controls|window-minimize|window-maximize|window-quit|login-status|runtime-status|runtime-badge|codex-status|server-dot|server-label)(?:$|[-_.:]))/i;

function invalid() { throw new Error(INVALID); }

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
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Object.getOwnPropertySymbols(value).length) invalid();
  const properties = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(properties).length !== value.length + 1) invalid();
  for (let index = 0; index < value.length; index++) {
    const descriptor = properties[index];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
  }
}

function plainText(value, maximum, { empty = true } = {}) {
  if (typeof value !== 'string' || value.length > maximum || (!empty && value.length === 0)
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

function validateUiDesign(value) {
  record(value, ['version', 'edits'], ['version', 'edits']);
  if (value.version !== 1) invalid();
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
    if (Object.hasOwn(edit, 'styles')) {
      record(edit.styles, [...STYLE_KEYS]);
      next.styles = Object.fromEntries(Object.entries(edit.styles).map(([key, val]) => [key, styleValue(key, val)]));
    }
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
  const next = { version: 1, edits };
  if (Buffer.byteLength(JSON.stringify(next), 'utf8') > MAX_UI_DESIGN_BYTES) invalid();
  return next;
}

function createUiDesignStore(directory) {
  const file = path.join(directory, 'ui-design.json');
  let design = { version: 1, edits: [] };
  let updating = Promise.resolve();
  const snapshot = () => structuredClone(design);
  return {
    get: snapshot,
    async load() {
      // Bound reads as well as IPC writes. A broken preview customization must
      // not stop the application from opening with its original interface.
      try {
        const handle = await fs.open(file, 'r');
        try {
          if ((await handle.stat()).size > MAX_UI_DESIGN_BYTES) invalid();
          const content = await handle.readFile('utf8');
          if (Buffer.byteLength(content, 'utf8') > MAX_UI_DESIGN_BYTES) invalid();
          design = validateUiDesign(JSON.parse(content));
        } finally { await handle.close(); }
      } catch { design = { version: 1, edits: [] }; }
      return snapshot();
    },
    update(value) {
      // Copy only the finite presentation schema before queueing. The renderer
      // cannot choose a destination, set CSS declarations, or supply HTML.
      const next = validateUiDesign(value);
      const operation = updating.then(async () => {
        await fs.mkdir(directory, { recursive: true });
        const temporary = path.join(directory, `.ui-design-${randomUUID()}.tmp`);
        try {
          await fs.writeFile(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
          await fs.rename(temporary, file);
          design = next;
          return snapshot();
        } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      });
      updating = operation.catch(() => {});
      return operation;
    },
  };
}

module.exports = { MAX_UI_DESIGN_BYTES, MAX_UI_DESIGN_EDITS, EMPTY_UI_DESIGN, validateUiDesign, createUiDesignStore };
