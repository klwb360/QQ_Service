import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { requiredBackendResources, verifyBackendResources } = require('../scripts/backend-resources.cjs');

test('staging refuses signing private-key containers before any application resource is loaded', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-signing-resource-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const relative of requiredBackendResources) {
    const file = path.join(directory, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '');
  }
  for (const name of ['publisher.pfx', 'publisher.PFX', 'publisher.p12', 'publisher.pem', 'publisher.key']) {
    const file = path.join(directory, 'src', name);
    await fs.writeFile(file, 'PRIVATE FIXTURE THAT MUST NEVER SHIP');
    try {
      await assert.rejects(verifyBackendResources(directory), /Backend includes private account data/u, name);
    } finally { await fs.rm(file); }
  }
});
