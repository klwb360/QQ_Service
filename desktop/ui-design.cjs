'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MAX_UI_DESIGN_BYTES, MAX_UI_DESIGN_EDITS, EMPTY_UI_DESIGN, validateUiDesign } = require('../public/layout-schema.cjs');

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
          if ((await handle.stat()).size > MAX_UI_DESIGN_BYTES) throw new Error('界面文件过大。');
          const content = await handle.readFile('utf8');
          if (Buffer.byteLength(content, 'utf8') > MAX_UI_DESIGN_BYTES) throw new Error('界面文件过大。');
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
