'use strict';

// The default Node test discovery also visits .cjs files under test/. This
// optional graphical check has its own explicit command and dependencies.
if (process.env.NODE_TEST_CONTEXT) {
  require('node:test').test('真实 Electron 窗口验证（单独运行 desktop-qa.cjs）', { skip: '需要显示服务和可选 Playwright；常规套件不启动 GUI' }, () => {});
  return;
}

// Optional real-window smoke check. Run after installing Electron:
//   PLAYWRIGHT_MODULE_PATH=/path/to/playwright DISPLAY=:97 node test/desktop-qa.cjs
// No QQ login, model request, or module installation is performed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const { _electron } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const projectDir = path.resolve(__dirname, '..');
const electronBinary = process.env.QQBRIDGE_TEST_ELECTRON || require('electron');
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbridge-desktop-qa-'));
const dataDir = path.join(fixtureDir, 'data');
const exportFile = path.join(fixtureDir, 'export.json');
const npmCli = process.env.QQ_DASHBOARD_NPM_CLI || [
  path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
].find(file => fs.existsSync(file));
assert.ok(npmCli && fs.existsSync(npmCli), '请用 QQ_DASHBOARD_NPM_CLI 指定本机 npm-cli.js');
const env = {
  ...process.env,
  QQBRIDGE_NODE_RUNTIME: process.execPath,
  QQ_DASHBOARD_NPM_CLI: npmCli,
  QQ_DASHBOARD_DATA_DIR: dataDir,
  XDG_CONFIG_HOME: path.join(fixtureDir, 'config'),
  XDG_CACHE_HOME: path.join(fixtureDir, 'cache'),
};
const flags = process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [];
const launchArgs = [...flags, `--user-data-dir=${path.join(fixtureDir, 'electron-profile')}`, projectDir];
let app;
let second;
let backendPid;
const checks = [];
function pass(message) { checks.push(message); console.log(`PASS ${message}`); }
async function condition(action, message, timeout = 8000) {
  const until = Date.now() + timeout;
  do {
    if (await action()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < until);
  throw new Error(message);
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function launch() {
  const instance = await _electron.launch({ executablePath: electronBinary, args: launchArgs, env, timeout: 30_000 });
  app = instance;
  const window = await instance.firstWindow();
  await window.waitForFunction(() => location.hostname === '127.0.0.1' && window.qqBridgeDesktop?.isDesktop);
  await window.waitForFunction(() => !document.querySelector('#config-label').textContent.includes('正在读取'));
  return window;
}
async function readState(window) { return window.evaluate(() => fetch('/api/state').then(response => response.json())); }

(async () => {
  try {
    let window = await launch();
    const origin = new URL(window.url()).origin;
    assert.match(origin, /^http:\/\/127\.0\.0\.1:[1-9]\d*$/);
    const prefs = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
    assert.equal(prefs.nodeIntegration, false);
    assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.sandbox, true);
    assert.equal(prefs.webviewTag, false);
    assert.equal(await window.evaluate(() => typeof require), 'undefined');
    assert.deepEqual(await window.evaluate(() => Object.keys(window.qqBridgeDesktop).sort()), ['exportConfig', 'isDesktop', 'version']);
    backendPid = await app.evaluate(() => process._getActiveHandles().find(handle => handle.constructor.name === 'ChildProcess' && handle.spawnargs?.some(arg => arg.endsWith('server.mjs')))?.pid);
    assert.ok(Number.isInteger(backendPid) && alive(backendPid));
    pass('真实 Electron 独立窗口、本机随机端口、隔离 preload 与禁止 NodeIntegration');

    await window.locator('[data-page="connections"]').click();
    await window.locator('[data-config="ownerQQ"]').fill('123456');
    await window.locator('[data-secret="deepseekApiKey"]').fill('qa-dummy-no-real-credential');
    const applying = window.waitForResponse(response => response.url().endsWith('/api/config/apply') && response.request().method() === 'POST');
    await window.locator('#apply-config').click();
    assert.equal((await applying).status(), 200);
    await condition(async () => (await readState(window)).applied.ownerQQ === '123456', 'UI 应用后后台配置未更新');
    assert.equal((await readState(window)).pendingChanges, false);
    pass('UI 保存并应用真实后台配置，模型及 QQ 接入保持关闭');

    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, exportFile);
    await window.locator('[data-page="modules"]').click();
    await window.locator('#export-config').click();
    await condition(() => fs.existsSync(exportFile), '原生导出未写文件');
    const exported = fs.readFileSync(exportFile, 'utf8');
    assert.equal(JSON.parse(exported).ownerQQ, '123456');
    assert.equal(exported.includes('qa-dummy-no-real-credential'), false);
    pass('renderer 通过受限 IPC 调用原生保存对话框（QA 替换选址），导出不含密钥');

    await window.locator('[data-page="overview"]').click();
    if (process.env.QQBRIDGE_TEST_SCREENSHOT) {
      await window.screenshot({ path: path.resolve(process.env.QQBRIDGE_TEST_SCREENSHOT), fullPage: false });
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
    assert.equal((await fetch(`${origin}/api/state`)).status, 200);
    assert.ok(alive(backendPid));
    pass('关闭窗口隐藏到托盘，后台和配置接口继续运行');

    second = spawn(electronBinary, launchArgs, { env, stdio: 'ignore' });
    const secondExit = once(second, 'exit');
    await condition(() => second.exitCode !== null || second.signalCode !== null, '第二实例没有及时退出', 15_000);
    const [code] = await secondExit;
    assert.equal(code, 0);
    await condition(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), '第二次启动未显示已有窗口');
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    pass('第二次启动退出第二进程并唤起已有窗口，保持单实例');

    const closing = once(app.process(), 'exit');
    await app.evaluate(({ app: electronApp }) => { electronApp.quit(); });
    await closing;
    app = null;
    await condition(() => !alive(backendPid), '完全退出后后台仍在运行');
    await assert.rejects(fetch(`${origin}/api/state`));
    backendPid = undefined;
    pass('完全退出通过 IPC 停止后台并释放服务端口');

    window = await launch();
    assert.equal((await readState(window)).applied.ownerQQ, '123456');
    assert.equal((await readState(window)).secrets.deepseekApiKey, true);
    pass('应用重启后保留本地配置与凭据状态');
    console.log(`桌面交互验证通过：${checks.length} 项。Windows 托盘、taskkill 和 exe 启动需要 Windows 实机验证。`);
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  } finally {
    if (second && second.exitCode === null && second.signalCode === null) second.kill('SIGKILL');
    if (app) await app.close().catch(() => {});
    if (backendPid && alive(backendPid)) process.kill(backendPid, 'SIGTERM');
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
})();
