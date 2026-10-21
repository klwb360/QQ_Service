'use strict';

// The default Node test discovery also visits .cjs files under test/. This
// optional graphical check has its own explicit command and dependencies.
if (process.env.NODE_TEST_CONTEXT) {
  require('node:test').test('真实 Electron 窗口验证（单独运行 desktop-qa.cjs）', { skip: '需要显示服务和可选 Playwright；常规套件不启动 GUI' }, () => {});
  return;
}

// Optional real-window smoke check. Run after installing Electron:
//   PLAYWRIGHT_MODULE_PATH=/path/to/playwright DISPLAY=:97 node test/desktop-qa.cjs
// QQBRIDGE_TEST_ELECTRON may point to an existing Electron executable; keep
// optional Playwright tooling outside this repository. On a headless Linux
// machine, start Xorg with its dummy driver and use that display (for example
// Xorg :97 -config /tmp/qq-service-desktop-xorg.conf -noreset -ac -nolisten tcp).
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
const pageErrors = [];
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
  window.on('pageerror', error => pageErrors.push(error.message));
  await window.waitForFunction(() => location.hostname === '127.0.0.1' && window.qqBridgeDesktop?.isDesktop);
  await window.waitForFunction(() => document.querySelector('#server-label')?.textContent === '管理服务可访问'
    && !document.querySelector('#config-label').textContent.includes('正在读取'));
  return window;
}
async function readState(window, accountId) {
  return window.evaluate(async id => {
    const response = await fetch(`/api/accounts/${encodeURIComponent(id)}/state`);
    if (!response.ok) throw new Error(`账号状态读取失败：${response.status}`);
    return response.json();
  }, accountId);
}
async function clickNativeExportMenu() {
  await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu()?.items.find(item => item.label === '应用');
    const item = menu?.submenu?.items.find(entry => entry.label === '导出脱敏配置…');
    if (!item) throw new Error('原生导出菜单不存在');
    item.click();
  });
}
async function selectAccount(window, accountId) {
  await window.locator('[data-page="connections"]').click();
  const entry = window.locator(`#account-cards [data-open-account="${accountId}"]`);
  if (await entry.getAttribute('aria-expanded') !== 'true') await entry.click();
  await window.waitForFunction(id => document.querySelector('#account-selector').value === id, accountId);
  await condition(async () => (await readState(window, accountId)).account.id === accountId, '未选中指定账号');
}
async function createAccount(window, name, qqNumber) {
  await window.locator('[data-page="connections"]').click();
  await window.locator('#create-account-entry').click();
  await window.locator('#new-account-name').fill(name);
  await window.locator('#new-account-qq').fill(qqNumber);
  const created = window.waitForResponse(response => response.url().endsWith('/api/accounts') && response.request().method() === 'POST');
  await window.locator('#submit-create-account').click();
  const response = await created;
  assert.ok(response.ok(), `创建账号失败：${response.status()}`);
  const { account } = await response.json();
  assert.ok(account?.id);
  await window.waitForFunction(id => document.querySelector('#new-account-form').classList.contains('hidden')
    && document.querySelector('#account-selector').value === id
    && !document.querySelector('#account-workspace').classList.contains('hidden'), account.id);
  await window.waitForFunction(qq => document.querySelector('[data-config="botQQ"]').value === qq, qqNumber);
  return account;
}
async function configureAccount(window, account, { ownerQQ, secret, persona }) {
  await selectAccount(window, account.id);
  await window.locator('[data-page="connections"]').click();
  if (!await window.locator('#account-workspace').isVisible()) {
    await window.locator(`#account-cards [data-open-account="${account.id}"]`).click();
  }
  await window.locator('#account-llm-source').selectOption('deepseek');
  await window.locator('[data-secret="deepseekApiKey"]').fill(secret);
  await window.locator('[data-page="scenarios"]').click();
  await window.locator('[data-scenario-tab="tasks"]').click();
  await window.locator('[data-config="chat.persona"]').fill(persona);
  await window.locator('[data-scenario-tab="permissions"]').click();
  await window.locator('[data-config="ownerQQ"]').fill(ownerQQ);
  const applying = window.waitForResponse(response => response.url().endsWith(`/api/accounts/${account.id}/config/apply`) && response.request().method() === 'POST');
  await window.locator('#apply-config').click();
  assert.equal((await applying).status(), 200);
  await condition(async () => (await readState(window, account.id)).applied.ownerQQ === ownerQQ, 'UI 应用后账号配置未更新');
  const state = await readState(window, account.id);
  assert.equal(state.pendingChanges, false);
  assert.equal(state.applied.chat.persona, persona);
  assert.equal(state.applied.permissions.released, false);
  assert.equal(state.applied.permissions.privateReplies, false);
  assert.equal(state.applied.qq.enabled, false);
  assert.equal(state.applied.models.deepseek.enabled, true);
  assert.equal(state.applied.models.codex.enabled, false);
  assert.equal(state.secrets.deepseekApiKey, true);
}

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
    assert.deepEqual(await window.evaluate(() => Object.keys(window.qqBridgeDesktop).sort()), ['chooseNapcatExecutable', 'close', 'exportConfig', 'getSettings', 'getWindowState', 'isDesktop', 'minimize', 'onWindowState', 'quit', 'toggleMaximize', 'updateSettings', 'version']);
    backendPid = await app.evaluate(() => process._getActiveHandles().find(handle => handle.constructor.name === 'ChildProcess' && handle.spawnargs?.some(arg => arg.endsWith('server.mjs')))?.pid);
    assert.ok(Number.isInteger(backendPid) && alive(backendPid));
    pass('真实 Electron 独立窗口、本机随机端口、隔离 preload 与禁止 NodeIntegration');

    assert.equal(await window.locator('#account-selector option').count(), 1);
    assert.equal(await window.locator('#account-selector').inputValue(), '');
    const emptyExportFile = path.join(fixtureDir, 'export-without-account.json');
    await app.evaluate(({ dialog }, filePath) => {
      globalThis.__qqServiceQaExportErrors = [];
      dialog.showErrorBox = (title, message) => globalThis.__qqServiceQaExportErrors.push({ title, message });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, emptyExportFile);
    await clickNativeExportMenu();
    await condition(() => app.evaluate(() => globalThis.__qqServiceQaExportErrors.length === 1), '未选择账号时原生菜单没有明确提示');
    assert.match(await app.evaluate(() => globalThis.__qqServiceQaExportErrors[0].message), /创建并选择账号/);
    assert.equal(fs.existsSync(emptyExportFile), false);
    assert.equal((await window.evaluate(() => fetch('/api/accounts').then(response => response.json()))).accounts.length, 0);
    pass('空账号目录点击原生导出只提示创建并选择账号，不导出或懒建 legacy');
    await window.locator('[data-page="settings"]').click();
    assert.equal(await window.locator('#napcat-settings-account').count(), 0);
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ['C:\\NapCat\\NapCatQQ-Desktop.exe'] });
    });
    await window.locator('#choose-napcat-executable').click();
    await condition(async () => (await window.evaluate(() => fetch('/api/napcat/settings').then(response => response.json()))).executablePath === 'C:\\NapCat\\NapCatQQ-Desktop.exe', '原生文件选择没有保存全局启动入口');
    assert.equal((await window.evaluate(() => fetch('/api/accounts').then(response => response.json()))).accounts.length, 0);
    pass('真实受限文件选择 IPC 在零账号时保存全局启动文件，设置页无账号选择框');
    const first = await createAccount(window, '桌面验收账号 A', '12345001');
    assert.equal((await readState(window, first.id)).applied.permissions.released, false);
    assert.equal(await window.locator('#account-permission-badge').textContent(), '只读 · 未释放发送');
    await configureAccount(window, first, { ownerQQ: '123456', secret: 'qa-dummy-account-a-no-real-credential', persona: '账号 A 的独立风格' });
    const secondAccount = await createAccount(window, '桌面验收账号 B', '12345002');
    await configureAccount(window, secondAccount, { ownerQQ: '654321', secret: 'qa-dummy-account-b-no-real-credential', persona: '账号 B 的独立风格' });
    assert.notEqual(first.id, secondAccount.id);
    assert.equal((await readState(window, first.id)).applied.ownerQQ, '123456');
    assert.equal((await fetch(`${origin}/api/accounts`)).status, 200);
    assert.equal((await fetch(`${origin}/api/config/export`)).status, 409);
    pass('通过逐步引导新建并配置两个账号，各自保存模型；QQ 接入关闭且权限保持只读');

    for (const [account, ownerQQ, persona] of [
      [first, '123456', '账号 A 的独立风格'],
      [secondAccount, '654321', '账号 B 的独立风格'],
    ]) {
      await selectAccount(window, account.id);
      const exportFile = path.join(fixtureDir, `export-${account.id}.json`);
      await app.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath });
      }, exportFile);
      await window.locator('[data-page="modules"]').click();
      await window.evaluate(id => window.qqBridgeDesktop.exportConfig(id), account.id);
      await condition(() => fs.existsSync(exportFile), '账号原生导出未写文件');
      const exported = fs.readFileSync(exportFile, 'utf8');
      const config = JSON.parse(exported);
      assert.equal(config.ownerQQ, ownerQQ);
      assert.equal(config.botQQ, account.qqNumber);
      assert.equal(config.chat.persona, persona);
      assert.equal(exported.includes('qa-dummy-account-'), false);
    }
    assert.equal(await window.evaluate(async () => {
      try { await window.qqBridgeDesktop.exportConfig(); return false; }
      catch { return true; }
    }), true);
    assert.equal(await window.evaluate(async () => {
      try { await window.qqBridgeDesktop.exportConfig('../config/export'); return false; }
      catch { return true; }
    }), true);
    pass('原生保存 IPC 按账号导出且无密钥，多个账号不串配置；缺省账号和非法路径均被拒绝');

    await selectAccount(window, secondAccount.id);
    const menuExportFile = path.join(fixtureDir, 'export-native-menu-selected-b.json');
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, menuExportFile);
    await clickNativeExportMenu();
    await condition(() => fs.existsSync(menuExportFile), '原生菜单未导出选中的账号 B');
    const menuExportText = fs.readFileSync(menuExportFile, 'utf8');
    const menuExport = JSON.parse(menuExportText);
    assert.equal(menuExport.botQQ, secondAccount.qqNumber);
    assert.equal(menuExport.ownerQQ, '654321');
    assert.equal(menuExport.chat.persona, '账号 B 的独立风格');
    assert.notEqual(menuExport.botQQ, first.qqNumber);
    assert.equal(menuExportText.includes('qa-dummy-account-'), false);
    const afterMenu = await window.evaluate(() => fetch('/api/accounts').then(response => response.json()));
    assert.deepEqual(afterMenu.accounts.map(account => account.id).sort(), [first.id, secondAccount.id].sort());
    assert.equal(await app.evaluate(() => globalThis.__qqServiceQaExportErrors.length), 1);
    pass('原生菜单读取当前选中账号 B 并导出其脱敏配置，不导出 A 或创建 legacy');

    await window.locator('[data-page="overview"]').click();
    if (process.env.QQBRIDGE_TEST_SCREENSHOT) {
      await window.screenshot({ path: path.resolve(process.env.QQBRIDGE_TEST_SCREENSHOT), fullPage: false });
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
    assert.equal((await fetch(`${origin}/api/accounts`)).status, 200);
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
    await assert.rejects(fetch(`${origin}/api/accounts`));
    backendPid = undefined;
    pass('完全退出通过 IPC 停止后台并释放服务端口');

    window = await launch();
    const directory = await window.evaluate(() => fetch('/api/accounts').then(response => response.json()));
    assert.equal(directory.accounts.length, 2);
    for (const [account, ownerQQ, persona] of [
      [first, '123456', '账号 A 的独立风格'],
      [secondAccount, '654321', '账号 B 的独立风格'],
    ]) {
      await selectAccount(window, account.id);
      const state = await readState(window, account.id);
      assert.equal(state.applied.ownerQQ, ownerQQ);
      assert.equal(state.applied.chat.persona, persona);
      assert.equal(state.secrets.deepseekApiKey, true);
      assert.equal(state.applied.permissions.released, false);
    }
    assert.deepEqual(pageErrors, []);
    pass('应用重启后两个账号均保留独立配置、凭据和只读权限；页面无未捕获异常');
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
