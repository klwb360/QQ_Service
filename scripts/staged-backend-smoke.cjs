const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function within(value, milliseconds, message) {
  let timer;
  return Promise.race([value, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

/** Run the staged server with a new empty profile and the host Node. Windows
 * PE execution remains a Windows build check. No QQ login or tool is invoked. */
async function smokeStagedBackend(directory = 'build/backend') {
  const backend = path.resolve(directory);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-staged-backend-'));
  const child = spawn(process.execPath, [path.join(backend, 'src', 'server.mjs')], {
    cwd: backend, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, shell: false,
    env: { ...process.env, QQ_DASHBOARD_PORT: '0', QQ_DASHBOARD_DATA_DIR: dataDir,
      QQ_DASHBOARD_DESKTOP: '1', QQ_SERVICE_HOST: '127.0.0.1' },
  });
  let diagnostics = '';
  child.stdout.resume();
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-4000); });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => reject(new Error(`Staged server stopped before readiness (${code ?? signal}): ${diagnostics}`)));
    child.on('message', message => { if (message?.type === 'qqbridge:ready') resolve(message); });
  });
  try {
    const address = await within(ready, 15_000, 'Staged backend did not become ready');
    assert(Number.isSafeInteger(address.port) && address.port > 0);
    const base = `http://127.0.0.1:${address.port}`;
    const routes = ['/', '/styles.css', '/app.js', '/memory-ui.js', '/memory-storage-ui.js', '/qq-assets-ui.js', '/mcp-presets-ui.js'];
    for (const route of routes) {
      const response = await fetch(base + route, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200, `Staged UI resource unavailable: ${route}`);
      assert((await response.arrayBuffer()).byteLength > 0, `Staged UI resource empty: ${route}`);
    }
    const accounts = await (await fetch(base + '/api/accounts', { signal: AbortSignal.timeout(5000) })).json();
    assert.deepEqual(accounts.accounts, [], 'Smoke test must use a blank profile and no real account');
    assert.equal(typeof accounts.csrfToken, 'string');
    const presets = await (await fetch(base + '/api/mcp/presets', { signal: AbortSignal.timeout(5000) })).json();
    assert.equal(presets.presets.length, 8);
    assert.equal(presets.presets.find(preset => preset.id === 'slack-official').canPrepare, false);
    child.send({ type: 'qqbridge:shutdown' });
    assert.deepEqual(await within(exited, 10_000, 'Staged backend did not stop after desktop shutdown'), { code: 0, signal: null });
    const result = { routes: routes.length, accounts: 0, mcpPresets: presets.presets.length, cleanShutdown: true };
    console.log(`Staged backend HTTP/desktop IPC smoke passed: ${JSON.stringify(result)}`);
    return result;
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await within(exited, 3000, 'Backend cleanup timeout').catch(() => { child.kill('SIGKILL'); });
      await exited;
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

module.exports = { smokeStagedBackend };
if (require.main === module) smokeStagedBackend(process.argv[2]).catch(error => {
  console.error(`Staged backend smoke failed: ${error.message}`);
  process.exitCode = 1;
});
