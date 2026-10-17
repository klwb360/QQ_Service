'use strict';

const { app, BrowserWindow, Menu, Tray, nativeImage, dialog, shell, session, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {
  backendUrlForPort, parseBackendReady, isDashboardResource,
  isDashboardNavigation, isAllowedExternalUrl, defaultDataDir,
  configExportPath, isAccountProfileId, isDashboardIpcSender,
} = require('./security.cjs');
const { createDesktopSettingsStore } = require('./settings.cjs');
const { createUiDesignStore, validateUiDesign } = require('./ui-design.cjs');

const APP_NAME = 'QQ_Service';
const STARTUP_TIMEOUT = 30_000;
const SHUTDOWN_TIMEOUT = 8_000;
const projectDir = path.resolve(__dirname, '..');
const dataDir = defaultDataDir(process.platform, process.env, os.homedir());
let window = null;
let tray = null;
let backend = null;
let backendOrigin = null;
let dashboardSession = null;
let quitting = false;
let starting = false;
let failureDialog = false;
let closeNoticeShown = false;
let exporting = false;
let desktopSettings = null;
let uiDesign = null;
let exportingUiDesign = false;

// Preserve the old desktop profile and single-instance lock when upgrading
// from 0.2.0, so the renamed EXE cannot run a second backend on the same data.
if (app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')) {
  const legacyProfile = path.join(app.getPath('appData'), '桥接台');
  fs.mkdirSync(legacyProfile, { recursive: true });
  app.setPath('userData', legacyProfile);
}
app.setName(APP_NAME);
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('window-all-closed', () => { if (!tray && !quitting) app.quit(); });
  app.on('before-quit', event => {
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    if (window && !window.isDestroyed()) window.hide();
    void stopBackend().finally(() => {
      tray?.destroy();
      tray = null;
      // A renderer's unsaved-form beforeunload prompt cannot leave a visible
      // window attached to an already stopped backend after an explicit quit.
      app.exit(0);
    });
  });
  app.whenReady().then(async () => {
    desktopSettings = createDesktopSettingsStore(app.getPath('userData'));
    await desktopSettings.load();
    uiDesign = createUiDesignStore(app.getPath('userData'));
    await uiDesign.load();
    dashboardSession = session.fromPartition('qqbridge-dashboard');
    hardenSession(dashboardSession);
    setupMenu();
    setupTray();
    setupExportHandler();
    setupWindowHandlers();
    setupUiDesignHandlers();
    await launch();
  }).catch(() => {
    dialog.showErrorBox(`${APP_NAME}无法启动`, '桌面运行环境初始化失败。请重新安装应用后再试。');
    app.quit();
  });
}

function runtimePaths() {
  if (app.isPackaged) {
    return {
      node: path.join(process.resourcesPath, 'runtime', 'node.exe'),
      npm: path.join(process.resourcesPath, 'runtime', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      backendDir: path.join(process.resourcesPath, 'backend'),
    };
  }
  // Developer-only override. A packaged application always uses its bundled,
  // independently verified Node runtime and ignores this environment variable.
  const runtimeRoot = path.join(projectDir, 'build', 'runtime');
  const node = process.env.QQBRIDGE_NODE_RUNTIME
    ? path.resolve(process.env.QQBRIDGE_NODE_RUNTIME)
    : path.join(runtimeRoot, process.platform === 'win32' ? 'node.exe' : 'node');
  return {
    node,
    npm: process.env.QQ_DASHBOARD_NPM_CLI
      ? path.resolve(process.env.QQ_DASHBOARD_NPM_CLI)
      : path.join(path.dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    backendDir: projectDir,
  };
}

function hardenSession(currentSession) {
  currentSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  currentSession.setPermissionCheckHandler(() => false);
  currentSession.setDevicePermissionHandler(() => false);
  currentSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isDashboardResource(details.url, backendOrigin) });
  });
  currentSession.on('will-download', (event, item) => {
    event.preventDefault();
    item.cancel();
  });
}

function showWindow() {
  if (quitting || !window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function openExternal(value) {
  if (!isAllowedExternalUrl(value, backendOrigin)) return;
  void shell.openExternal(value).catch(() => {
    if (!quitting) dialog.showErrorBox('无法打开浏览器', '请检查系统默认浏览器设置后重试。');
  });
}

function createWindow() {
  if (window && !window.isDestroyed()) return window;
  window = new BrowserWindow({
    title: APP_NAME,
    width: 1360, height: 880, minWidth: 940, minHeight: 660,
    show: false, backgroundColor: '#f5f7fb',
    frame: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      session: dashboardSession,
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false,
      webviewTag: false, navigateOnDragDrop: false,
      devTools: !app.isPackaged,
      additionalArguments: [`--qqbridge-version=${app.getVersion()}`],
    },
  });
  // Keep native menu actions available to the application, without showing the
  // old title/menu bars or revealing a menu bar when Alt is pressed.
  window.setMenu(null);
  const contents = window.webContents;
  contents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  contents.on('will-navigate', (event, url) => {
    if (isDashboardNavigation(url, backendOrigin)) return;
    event.preventDefault();
    openExternal(url);
  });
  contents.on('will-redirect', (event, url) => {
    if (!isDashboardNavigation(url, backendOrigin)) event.preventDefault();
  });
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.on('page-title-updated', event => { event.preventDefault(); window?.setTitle(APP_NAME); });
  contents.on('render-process-gone', () => {
    if (!quitting) void showFailure('仪表盘窗口意外停止。后台可能仍在运行，可重新打开界面或退出应用。', false);
  });
  window.once('ready-to-show', showWindow);
  for (const event of ['maximize', 'unmaximize', 'minimize', 'restore']) {
    window.on(event, publishWindowState);
  }
  contents.on('did-finish-load', publishWindowState);
  window.on('close', event => {
    if (quitting) return;
    if (!tray || desktopSettings.get().closeBehavior === 'quit') {
      event.preventDefault();
      app.quit();
      return;
    }
    event.preventDefault();
    window.hide();
    if (!closeNoticeShown) {
      closeNoticeShown = true;
      if (process.platform === 'win32') {
        tray.displayBalloon({
          title: `${APP_NAME}仍在后台运行`,
          content: '消息收集和定时汇总继续运行。右键托盘图标，选择“完全退出”才会停止。',
          noSound: true,
        });
      }
    }
  });
  window.on('closed', () => { window = null; });
  return window;
}

function setupTray() {
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
    if (icon.isEmpty()) throw new Error('missing-icon');
    tray = new Tray(icon.resize({ width: process.platform === 'win32' ? 24 : 22, height: process.platform === 'win32' ? 24 : 22 }));
    updateTrayTooltip();
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `打开${APP_NAME}`, click: showWindow },
      { label: '打开本地资料目录', click: openDataDir },
      { type: 'separator' },
      { label: '完全退出（停止采集和定时任务）', click: () => app.quit() },
    ]));
    tray.on('double-click', showWindow);
    tray.on('click', showWindow);
  } catch {
    tray?.destroy();
    tray = null;
    // No hidden background state if tray creation failed: closing the visible
    // window follows the normal full shutdown path through before-quit.
  }
}

function updateTrayTooltip() {
  tray?.setToolTip(`${APP_NAME} · ${desktopSettings?.get().closeBehavior === 'quit' ? '关闭窗口后完全退出' : '关闭窗口后继续后台运行'}`);
}

function setupMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '应用', submenu: [
      { label: `打开${APP_NAME}`, click: showWindow },
      { label: '打开本地资料目录', click: openDataDir },
      { label: '导出脱敏配置…', click: () => { void exportSelectedAccountConfig().catch(error => dialog.showErrorBox('配置导出失败', error.code === 'ACCOUNT_SELECTION_REQUIRED' ? error.message : '无法导出当前已保存的配置，请确认后台正在运行并重试。')); } },
      { type: 'separator' },
      { label: '完全退出（停止采集和定时任务）', accelerator: 'CommandOrControl+Q', click: () => app.quit() },
    ] },
    { label: '编辑', submenu: [ { role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' } ] },
    { label: '视图', submenu: [
      { role: 'resetZoom', label: '实际大小' },
      { role: 'zoomIn', label: '放大' },
      { role: 'zoomOut', label: '缩小' },
    ] },
    { label: '帮助', submenu: [
      { label: '后台运行说明', click: () => {
        dialog.showMessageBox(window || undefined, { type: 'info', title: APP_NAME, message: !tray ? '本次未能创建托盘图标，关闭窗口会完全退出' : desktopSettings.get().closeBehavior === 'quit' ? '当前设置：关闭窗口后完全退出' : '当前设置：关闭窗口后继续在托盘后台运行', detail: '可在“设置”中修改关闭方式。消息收集和定时汇总需要应用保持运行。完全退出会停止仪表盘后台；已启动的 NapCat Docker 容器继续运行，可以先在“模块管理”中停止。电脑休眠或关机时不处理新消息。' });
      } },
      { label: `关于${APP_NAME}`, click: () => {
        dialog.showMessageBox(window || undefined, { type: 'info', title: `关于${APP_NAME}`, message: `${APP_NAME} ${app.getVersion()}`, detail: 'QQ / DeepSeek / 本人 GPT 订阅的本地配置应用。账号授权在官方页面完成。' });
      } },
    ] },
  ]));
}

async function openDataDir() {
  try {
    await fsp.mkdir(dataDir, { recursive: true });
    const error = await shell.openPath(dataDir);
    if (error) throw new Error('open-path-failed');
  } catch { dialog.showErrorBox('无法打开资料目录', '请检查当前用户对本地资料目录的访问权限。'); }
}

async function launch() {
  if (starting || quitting) return;
  starting = true;
  try {
    const origin = await startBackend();
    if (quitting) return;
    backendOrigin = origin;
    await createWindow().loadURL(`${origin}/`);
    showWindow();
  } catch (error) {
    if (!quitting) await showFailure(error.publicMessage || '后台未能启动。请确认应用文件完整且当前用户可以写入本地资料目录。', true);
  } finally { starting = false; }
}

function startupError(message) {
  const error = new Error(message);
  error.publicMessage = message;
  return error;
}

function startBackend() {
  const paths = runtimePaths();
  if (!fs.existsSync(paths.node) || !fs.existsSync(paths.npm) || !fs.existsSync(path.join(paths.backendDir, 'src', 'server.mjs'))) {
    return Promise.reject(startupError(app.isPackaged
      ? '应用附带的运行环境不完整。请重新安装 QQ_Service；不需要另外安装 Node.js。'
      : '开发运行环境尚未准备好。请先运行桌面构建的 runtime 准备脚本，或设置 QQBRIDGE_NODE_RUNTIME 指向本机 Node.js 24 的完整路径。'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let pending = '';
    let timer;
    const child = spawn(paths.node, [path.join(paths.backendDir, 'src', 'server.mjs')], {
      cwd: paths.backendDir, shell: false, windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        QQ_DASHBOARD_DATA_DIR: dataDir,
        QQ_DASHBOARD_PORT: '0',
        QQ_DASHBOARD_DESKTOP: '1',
        QQ_DASHBOARD_NPM_CLI: paths.npm,
      },
    });
    const current = { child, closed: false, done: null };
    current.done = new Promise(done => child.once('close', () => { current.closed = true; done(); }));
    backend = current;
    function finish(origin) {
      if (settled || !origin) return;
      settled = true;
      clearTimeout(timer);
      resolve(origin);
    }
    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
    child.on('message', message => {
      if (message && message.type === 'qqbridge:ready') finish(backendUrlForPort(message.port));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        finish(parseBackendReady(line));
      }
      // No account/auth output is copied to desktop logs or failure dialogs.
      if (pending.length > 16_384) pending = '';
    });
    child.stderr.on('data', () => {});
    child.once('error', () => fail(startupError('无法启动附带的后台运行环境。请检查防病毒软件是否隔离了应用文件，并重新安装后重试。')));
    child.once('close', (code) => {
      if (!settled) fail(startupError(`后台在准备界面前退出（退出码 ${Number.isInteger(code) ? code : '未知'}）。请检查应用文件及本地资料目录权限。`));
      else if (!quitting && backend === current) {
        backendOrigin = null;
        void showFailure('后台意外停止，消息收集和定时任务已暂停。可重试启动或完全退出。', true);
      }
    });
    timer = setTimeout(() => fail(startupError('后台启动超过 30 秒。可重试启动；如果持续失败，请检查应用文件和当前用户目录权限。')), STARTUP_TIMEOUT);
  });
}

async function showFailure(message, restartBackend) {
  if (failureDialog || quitting) return;
  failureDialog = true;
  try {
    const { response } = await dialog.showMessageBox(window || undefined, {
      type: 'error', title: `${APP_NAME}运行异常`, message,
      buttons: [restartBackend ? '重试启动' : '重新打开界面', '完全退出'], defaultId: 0, cancelId: 1,
      detail: '只有界面与后台成功启动后才能使用功能。账号凭据不会显示在此对话框中。',
    });
    if (response === 1) { app.quit(); return; }
    if (restartBackend) {
      await stopBackend();
      backendOrigin = null;
      // launch() may still be unwinding its failed startup attempt.
      starting = false;
      setImmediate(() => { void launch(); });
    } else if (backendOrigin) {
      window?.destroy();
      window = null;
      await createWindow().loadURL(`${backendOrigin}/`);
      showWindow();
    }
  } finally { failureDialog = false; }
}

async function waitForExit(current, milliseconds) {
  if (current.closed) return true;
  let timer;
  return Promise.race([
    current.done.then(() => true),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

async function stopBackend() {
  const current = backend;
  if (!current) return;
  backend = null;
  if (current.closed) return;
  if (current.child.connected) {
    try { current.child.send({ type: 'qqbridge:shutdown' }, () => {}); } catch {}
  }
  if (await waitForExit(current, SHUTDOWN_TIMEOUT)) return;
  const pid = current.child.pid;
  if (!Number.isSafeInteger(pid) || pid < 1) return;
  if (process.platform === 'win32') {
    const configuredRoot = process.env.SystemRoot || process.env.SYSTEMROOT || '';
    const root = /^[a-z]:[\\/]/i.test(configuredRoot) ? configuredRoot : 'C:\\Windows';
    await new Promise(resolve => {
      const killer = spawn(path.win32.join(root, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {
        shell: false, windowsHide: true, stdio: 'ignore',
      });
      const timer = setTimeout(() => { killer.kill(); resolve(); }, 5000);
      killer.once('error', () => { clearTimeout(timer); resolve(); });
      killer.once('close', () => { clearTimeout(timer); resolve(); });
    });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') current.child.kill('SIGKILL'); }
  }
  await waitForExit(current, 2000);
}

async function exportSelectedAccountConfig() {
  const currentWindow = window;
  const contents = currentWindow?.webContents;
  const requireSelection = () => {
    const error = new Error('请先在仪表盘创建并选择账号，再导出该账号的脱敏配置。');
    error.code = 'ACCOUNT_SELECTION_REQUIRED';
    return error;
  };
  if (!currentWindow || currentWindow.isDestroyed() || !contents || contents.isDestroyed()
    || !isDashboardNavigation(contents.getURL(), backendOrigin)) throw requireSelection();
  // Read exactly one fixed DOM value from our own dashboard. Account IDs are
  // validated before they reach the same scoped export used by the renderer.
  const accountId = await contents.executeJavaScript("document.querySelector('#account-selector')?.value ?? ''");
  if (window !== currentWindow || currentWindow.isDestroyed() || contents.isDestroyed()
    || !isDashboardNavigation(contents.getURL(), backendOrigin)
    || !isAccountProfileId(accountId)) throw requireSelection();
  return exportConfig(accountId);
}

function setupExportHandler() {
  ipcMain.handle('qqbridge:export-config', async (event, accountId) => {
    if (!isDashboardIpcSender(event, window?.webContents, backendOrigin)) {
      throw new Error('仅允许本机仪表盘导出配置。');
    }
    // A renderer supplies only a stable profile ID, never a URL or file path.
    configExportPath(accountId);
    try { return await exportConfig(accountId); }
    catch (error) { throw new Error(error.code === 'ACCOUNT_SELECTION_REQUIRED' ? error.message : '无法导出已保存的脱敏配置，请确认后台运行后重试。'); }
  });
}

function windowState() {
  return {
    maximized: Boolean(window && !window.isDestroyed() && window.isMaximized()),
    minimized: Boolean(window && !window.isDestroyed() && window.isMinimized()),
  };
}

function publishWindowState() {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()
    || !isDashboardNavigation(window.webContents.getURL(), backendOrigin)) return;
  window.webContents.send('qqbridge:window-state-changed', windowState());
}

function setupWindowHandlers() {
  const trusted = event => {
    if (quitting || !isDashboardIpcSender(event, window?.webContents, backendOrigin)) {
      throw new Error('仅允许本机仪表盘操作应用窗口。');
    }
  };
  ipcMain.handle('qqbridge:window-state', event => {
    trusted(event);
    return windowState();
  });
  ipcMain.handle('qqbridge:window-minimize', event => {
    trusted(event);
    window.minimize();
    return windowState();
  });
  ipcMain.handle('qqbridge:window-toggle-maximize', event => {
    trusted(event);
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return windowState();
  });
  ipcMain.handle('qqbridge:window-quit', event => {
    trusted(event);
    // Resolve this fixed operation before closing the renderer. Explicit exit
    // stops the backend through before-quit, unlike hiding the window to tray.
    setImmediate(() => app.quit());
    return { ok: true };
  });
  ipcMain.handle('qqbridge:window-close', event => {
    trusted(event);
    setImmediate(() => window?.close());
    return { ok: true };
  });
  ipcMain.handle('qqbridge:desktop-settings-get', event => {
    trusted(event);
    return desktopSettings.get();
  });
  ipcMain.handle('qqbridge:desktop-settings-update', async (event, value) => {
    trusted(event);
    try {
      const saved = await desktopSettings.update(value);
      updateTrayTooltip();
      return saved;
    } catch (error) {
      if (error.message.startsWith('关闭方式无效')) throw error;
      throw new Error('无法保存应用设置，请检查本机用户资料目录是否可写后重试。');
    }
  });
}

function setupUiDesignHandlers() {
  const trusted = event => {
    if (quitting || !isDashboardIpcSender(event, window?.webContents, backendOrigin)) {
      throw new Error('仅允许本机仪表盘修改界面。');
    }
  };
  ipcMain.handle('qqbridge:ui-design-get', event => {
    trusted(event);
    return uiDesign.get();
  });
  ipcMain.handle('qqbridge:ui-design-save', async (event, value) => {
    trusted(event);
    const next = validateUiDesign(value);
    try { return await uiDesign.update(next); }
    catch { throw new Error('无法保存界面修改，请检查本机用户资料目录是否可写后重试。'); }
  });
  ipcMain.handle('qqbridge:ui-design-export', async (event, value) => {
    trusted(event);
    const next = validateUiDesign(value);
    if (exportingUiDesign) return { ok: true, canceled: true };
    exportingUiDesign = true;
    try {
      const options = {
        title: '导出界面修改',
        defaultPath: path.join(app.getPath('documents'), 'QQ_Service-ui-design.json'),
        filters: [{ name: '界面修改 JSON', extensions: ['json'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      };
      const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return { ok: true, canceled: true };
      // Only the native dialog chooses a destination. No renderer path, business
      // configuration, account details or credentials enter this export.
      await fsp.writeFile(result.filePath, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
      return { ok: true, canceled: false, file: path.basename(result.filePath) };
    } catch { throw new Error('无法导出界面修改，请检查所选位置是否可写后重试。'); }
    finally { exportingUiDesign = false; }
  });
}

function readExportConfig(accountId) {
  const endpoint = configExportPath(accountId);
  return new Promise((resolve, reject) => {
    if (!backendOrigin) { reject(new Error('backend-not-ready')); return; }
    const request = http.get(`${backendOrigin}${endpoint}`, { timeout: 5000 }, response => {
      if (response.statusCode === 409 && accountId === undefined) {
        response.resume();
        const error = new Error('请先在仪表盘选择账号，再使用该账号的“导出脱敏配置”。');
        error.code = 'ACCOUNT_SELECTION_REQUIRED';
        reject(error); return;
      }
      if (response.statusCode !== 200 || !String(response.headers['content-type']).startsWith('application/json')) {
        response.resume(); reject(new Error('invalid-export-response')); return;
      }
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 128 * 1024) { request.destroy(new Error('export-too-large')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve(`${JSON.stringify(JSON.parse(Buffer.concat(chunks).toString('utf8')), null, 2)}\n`); }
        catch { reject(new Error('invalid-export-json')); }
      });
    });
    request.once('timeout', () => request.destroy(new Error('export-timeout')));
    request.once('error', reject);
  });
}

async function exportConfig(accountId) {
  if (exporting) return { ok: true, canceled: true };
  exporting = true;
  try {
    const content = await readExportConfig(accountId);
    const options = {
      title: '导出脱敏配置',
      defaultPath: path.join(app.getPath('documents'), `QQ_Service-config${accountId ? `-${accountId.slice(0, 8)}` : ''}-${new Date().toISOString().slice(0, 10)}.json`),
      filters: [{ name: 'JSON 配置', extensions: ['json'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    };
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { ok: true, canceled: true };
    await fsp.writeFile(result.filePath, content, { encoding: 'utf8', mode: 0o600 });
    return { ok: true, canceled: false, file: result.filePath };
  } finally { exporting = false; }
}
