'use strict';

// Optional real Electron checks for the frameless shell. No QQ login, model
// request, or installation is performed. Use the same display/Playwright setup
// described in desktop-qa.cjs. Set QQBRIDGE_TEST_NATIVE_WINDOW_STATE=1 when a
// window manager is available to also require native minimize/maximize states.
if (process.env.NODE_TEST_CONTEXT) {
  require('node:test').test('真实 Electron 无边框窗口验证（单独运行 desktop-window-qa.cjs）', { skip: '需要显示服务和可选 Playwright' }, () => {});
  return;
}

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const projectDir = path.resolve(__dirname, '..');
const electronBinary = process.env.QQBRIDGE_TEST_ELECTRON || require('electron');
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqservice-window-qa-'));
const npmCli = process.env.QQ_DASHBOARD_NPM_CLI || [
  path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
].find(file => fs.existsSync(file));
assert.ok(npmCli && fs.existsSync(npmCli), '请用 QQ_DASHBOARD_NPM_CLI 指定本机 npm-cli.js');
const nativeStates = process.env.QQBRIDGE_TEST_NATIVE_WINDOW_STATE === '1';
const checks = [];
let app;
let backendPid;
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
async function launch(applicationDir = projectDir) {
  app = await _electron.launch({
      executablePath: electronBinary,
      args: [
        ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : []),
        `--user-data-dir=${path.join(fixtureDir, 'electron-profile')}`, applicationDir,
      ],
      env: {
        ...process.env,
        QQBRIDGE_NODE_RUNTIME: process.execPath,
        QQ_DASHBOARD_NPM_CLI: npmCli,
        QQ_DASHBOARD_DATA_DIR: path.join(fixtureDir, 'data'),
        XDG_CONFIG_HOME: path.join(fixtureDir, 'config'),
        XDG_CACHE_HOME: path.join(fixtureDir, 'cache'),
      },
      timeout: 30_000,
  });
  const page = await app.firstWindow({ timeout: 30_000 });
  await page.waitForFunction(() => location.hostname === '127.0.0.1' && window.qqBridgeDesktop?.getWindowState, undefined, { timeout: 15_000 });
  await page.locator('#window-controls').waitFor({ state: 'visible' });
  await page.locator('#desktop-settings-nav').waitFor({ state: 'visible' });
  backendPid = await app.evaluate(() => process._getActiveHandles().find(handle => handle.constructor.name === 'ChildProcess' && handle.spawnargs?.some(arg => arg.endsWith('server.mjs')))?.pid);
  assert.ok(Number.isSafeInteger(backendPid) && alive(backendPid));
  return page;
}
async function requireBackendStopped(origin, action, message) {
  const exited = once(app.process(), 'exit');
  await action();
  await exited;
  app = null;
  await condition(() => !alive(backendPid), message);
  await assert.rejects(fetch(`${origin}/api/accounts`));
  backendPid = undefined;
}

(async () => {
  try {
    const page = await launch();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const origin = new URL(page.url()).origin;
    const shell = await app.evaluate(({ BrowserWindow, Menu }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return {
        menuBarVisible: win.isMenuBarVisible(),
        bounds: win.getBounds(), contentBounds: win.getContentBounds(),
        menuRegistered: Boolean(Menu.getApplicationMenu()),
        preferences: win.webContents.getLastWebPreferences(),
      };
    });
    assert.equal(shell.menuBarVisible, false);
    assert.deepEqual(shell.contentBounds, shell.bounds);
    assert.equal(shell.menuRegistered, true);
    assert.equal(shell.preferences.sandbox, true);
    assert.equal(shell.preferences.contextIsolation, true);
    assert.equal(shell.preferences.nodeIntegration, false);
    assert.equal(await page.evaluate(() => typeof require), 'undefined');
    assert.deepEqual(await page.evaluate(() => Object.keys(qqBridgeDesktop).sort()), [
      'chooseNapcatExecutable', 'choosePluginDirectory', 'close', 'exportConfig', 'getSettings', 'getWindowState', 'isDesktop', 'minimize', 'onWindowState', 'quit', 'toggleMaximize', 'updateSettings', 'version',
    ]);
    pass('无原生边框与菜单栏，保留应用菜单动作；隔离 preload 仅暴露固定操作');

    assert.deepEqual(await page.evaluate(() => qqBridgeDesktop.getWindowState()), { maximized: false, minimized: false });
    await page.evaluate(() => {
      window.__windowQaEvents = [];
      window.__windowQaOff = qqBridgeDesktop.onWindowState(state => window.__windowQaEvents.push(state));
    });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('restore'));
    await condition(() => page.evaluate(() => window.__windowQaEvents.length > 0), '未收到窗口状态事件');
    assert.deepEqual(await page.evaluate(() => window.__windowQaEvents.at(-1)), { maximized: false, minimized: false });
    await page.evaluate(() => { window.__windowQaOff(); window.__windowQaEvents.length = 0; });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('restore'));
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__windowQaEvents.length), 0);
    assert.equal(await page.evaluate(() => {
      try { qqBridgeDesktop.onWindowState(null); return false; } catch { return true; }
    }), true);
    pass('窗口状态查询、事件订阅、取消订阅及非法回调拒绝正常');

    assert.deepEqual(await page.evaluate(() => qqBridgeDesktop.getSettings()), { closeBehavior: 'tray' });
    await page.locator('#desktop-settings-nav').click();
    await page.locator('input[name="closeBehavior"][value="quit"]').check();
    await condition(() => page.evaluate(async () => (await qqBridgeDesktop.getSettings()).closeBehavior === 'quit'), '设置页面没有保存完全退出偏好');
    await condition(() => page.locator('#window-quit').getAttribute('title').then(value => value === '退出应用'), '关闭按钮没有同步完全退出提示');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixtureDir, 'electron-profile', 'desktop-settings.json'), 'utf8')), { closeBehavior: 'quit' });
    assert.equal(await page.evaluate(async () => {
      try { await qqBridgeDesktop.updateSettings({ closeBehavior: 'tray', path: '../elsewhere' }); return false; }
      catch { return true; }
    }), true);
    assert.deepEqual(await page.evaluate(() => qqBridgeDesktop.getSettings()), { closeBehavior: 'quit' });
    await page.locator('input[name="closeBehavior"][value="tray"]').check();
    await condition(() => page.evaluate(async () => (await qqBridgeDesktop.getSettings()).closeBehavior === 'tray'), '设置页面没有保存托盘偏好');
    await condition(() => page.locator('#window-quit').getAttribute('title').then(value => value === '关闭到托盘'), '关闭按钮没有同步托盘提示');
    await page.locator('#window-quit').click();
    await condition(() => app.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isVisible()), '自定义关闭没有按设置隐藏到托盘');
    assert.equal((await fetch(`${origin}/api/accounts`)).status, 200);
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.show(); win.focus(); });
    pass('关闭方式可安全持久化，非法设置被拒绝；默认关闭到托盘且后台继续运行');

    // Observe real native calls as well as their results. On a bare X server
    // without a window manager, Electron sends native requests but states do
    // not change; the explicit flag above requires full native transitions.
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      globalThis.__windowQaCalls = [];
      for (const method of ['minimize', 'maximize', 'unmaximize']) {
        const original = win[method].bind(win);
        win[method] = (...args) => { globalThis.__windowQaCalls.push(method); return original(...args); };
      }
    });
    await page.locator('#window-maximize').click();
    await condition(() => app.evaluate(() => globalThis.__windowQaCalls.includes('maximize')), '最大化未到达原生窗口');
    if (nativeStates) await condition(() => page.evaluate(async () => (await qqBridgeDesktop.getWindowState()).maximized), '原生窗口未最大化');
    const maximized = await page.evaluate(async () => (await qqBridgeDesktop.getWindowState()).maximized);
    if (maximized) await condition(() => page.locator('#window-maximize').getAttribute('title').then(value => value === '还原窗口'), '最大化按钮未显示还原状态');
    await page.locator('#window-maximize').click();
    if (maximized) {
      await condition(() => app.evaluate(() => globalThis.__windowQaCalls.includes('unmaximize')), '还原未到达原生窗口');
      await condition(() => page.evaluate(async () => !(await qqBridgeDesktop.getWindowState()).maximized), '原生窗口未还原');
    }
    await page.locator('#window-minimize').click();
    await condition(() => app.evaluate(() => globalThis.__windowQaCalls.includes('minimize')), '最小化未到达原生窗口');
    if (nativeStates) await condition(() => page.evaluate(async () => (await qqBridgeDesktop.getWindowState()).minimized), '原生窗口未最小化');
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.restore(); win.show(); });
    pass(nativeStates ? '最大化、还原、最小化真实状态及原生调用正确' : '最大化和最小化到达原生窗口（当前未要求窗口管理器状态）');

    // A second same-origin window has the identical preload, but is not the
    // trusted main window. Its attempts must not affect the app or backend.
    const [rogue] = await Promise.all([app.waitForEvent('window'), app.evaluate(async ({ BrowserWindow }, { origin, preload }) => {
      globalThis.__windowQaRogue = new BrowserWindow({
        show: false,
        webPreferences: {
          preload,
          contextIsolation: true, sandbox: true, nodeIntegration: false,
        },
      });
      await globalThis.__windowQaRogue.loadURL(origin);
    }, { origin, preload: path.join(projectDir, 'desktop', 'preload.cjs') })]);
    assert.deepEqual(await rogue.evaluate(async () => {
      const results = [];
      for (const method of ['getWindowState', 'minimize', 'toggleMaximize', 'close', 'quit', 'getSettings', 'updateSettings', 'exportConfig']) {
        try { await qqBridgeDesktop[method](); results.push({ method, rejected: false }); }
        catch { results.push({ method, rejected: true }); }
      }
      return results;
    }), ['getWindowState', 'minimize', 'toggleMaximize', 'close', 'quit', 'getSettings', 'updateSettings', 'exportConfig'].map(method => ({ method, rejected: true })));
    await app.evaluate(() => { globalThis.__windowQaRogue.destroy(); delete globalThis.__windowQaRogue; });
    assert.equal((await fetch(`${origin}/api/accounts`)).status, 200);
    pass('同源第二窗口无法使用原生窗口、退出或导出 IPC，后台保持可用');

    if (process.env.QQBRIDGE_TEST_SCREENSHOT) {
      await page.screenshot({ path: path.resolve(process.env.QQBRIDGE_TEST_SCREENSHOT) });
    }
    assert.deepEqual(pageErrors, []);
    await requireBackendStopped(origin, () => page.locator('#quit-application').click(), '自定义退出后后台仍在运行');
    pass('自定义退出真正关闭应用、停止后台并释放本机端口');

    const restarted = await launch();
    assert.deepEqual(await restarted.evaluate(() => qqBridgeDesktop.getSettings()), { closeBehavior: 'tray' });
    await restarted.locator('#desktop-settings-nav').click();
    await restarted.locator('input[name="closeBehavior"][value="quit"]').check();
    await condition(() => restarted.evaluate(async () => (await qqBridgeDesktop.getSettings()).closeBehavior === 'quit'), '重启后无法修改关闭偏好');
    await requireBackendStopped(new URL(restarted.url()).origin, () => restarted.locator('#window-quit').click(), '完全退出设置下自定义关闭没有停止后台');
    const restartedAgain = await launch();
    assert.deepEqual(await restartedAgain.evaluate(() => qqBridgeDesktop.getSettings()), { closeBehavior: 'quit' });
    await requireBackendStopped(new URL(restartedAgain.url()).origin, () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()), '完全退出设置下原生关闭没有停止后台');
    pass('应用重启保留两种关闭偏好，自定义关闭与原生关闭均遵循完全退出设置');

    // An isolated copy deliberately has no tray icon. Never move or change
    // the real project assets while other build/check processes are running.
    const withoutTray = path.join(fixtureDir, 'without-tray-icon');
    fs.mkdirSync(withoutTray);
    for (const directory of ['src', 'public', 'desktop']) {
      fs.cpSync(path.join(projectDir, directory), path.join(withoutTray, directory), {
        recursive: true,
        filter: source => source !== path.join(projectDir, 'desktop', 'assets'),
      });
    }
    fs.cpSync(path.join(projectDir, 'node_modules', 'ws'), path.join(withoutTray, 'node_modules', 'ws'), { recursive: true });
    fs.writeFileSync(path.join(withoutTray, 'package.json'), JSON.stringify({ name: 'qqservice-window-qa', version: '0.0.0', main: 'desktop/main.cjs', type: 'module' }));
    const noTrayPage = await launch(withoutTray);
    await noTrayPage.evaluate(() => qqBridgeDesktop.updateSettings({ closeBehavior: 'tray' }));
    await requireBackendStopped(new URL(noTrayPage.url()).origin, () => noTrayPage.evaluate(() => qqBridgeDesktop.close()), '未创建托盘时关闭窗口应完全退出');
    pass('托盘不可用时即使选择后台运行，关闭也完全退出，避免不可见进程');
    console.log(`无边框桌面验证通过：${checks.length} 项。`);
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  } finally {
    if (app) await app.close().catch(() => {});
    if (backendPid && alive(backendPid)) process.kill(backendPid, 'SIGTERM');
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
})();
