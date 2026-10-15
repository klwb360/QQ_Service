'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULT_DESKTOP_SETTINGS = Object.freeze({ closeBehavior: 'tray' });

function validateDesktopSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 1
    || !Object.hasOwn(value, 'closeBehavior')
    || !['tray', 'quit'].includes(value.closeBehavior)) {
    throw new Error('关闭方式无效，请选择“最小化到托盘”或“完全退出”。');
  }
  return { closeBehavior: value.closeBehavior };
}

function createDesktopSettingsStore(directory) {
  const file = path.join(directory, 'desktop-settings.json');
  let settings = { ...DEFAULT_DESKTOP_SETTINGS };
  let updating = Promise.resolve();
  return {
    get: () => ({ ...settings }),
    async load() {
      try { settings = validateDesktopSettings(JSON.parse(await fs.readFile(file, 'utf8'))); }
      catch { settings = { ...DEFAULT_DESKTOP_SETTINGS }; }
      return { ...settings };
    },
    update(value) {
      // Snapshot and validate before queueing. No renderer-provided path or
      // arbitrary preference name reaches the filesystem.
      const next = validateDesktopSettings(value);
      const operation = updating.then(async () => {
        await fs.mkdir(directory, { recursive: true });
        const temporary = path.join(directory, `.desktop-settings-${randomUUID()}.tmp`);
        try {
          await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
          await fs.rename(temporary, file);
          settings = next;
          return { ...settings };
        } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      });
      updating = operation.catch(() => {});
      return operation;
    },
  };
}

module.exports = { DEFAULT_DESKTOP_SETTINGS, validateDesktopSettings, createDesktopSettingsStore };
