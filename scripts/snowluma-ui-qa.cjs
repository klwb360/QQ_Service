'use strict';

// Real Chromium/dashboard/config APIs with a disconnected fixture runtime.
// Does not install, launch or connect to a third-party QQ component.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-snow-ui-'));
const qq = '12345678', passed = [], starts = [], network = [], errors = [];
let app, browser;
const pass = value => { passed.push(value); console.log('PASS', value); };

(async () => {
  const { createDashboard } = await import(root + '/src/server.mjs');
  app = createDashboard({ dataDir: path.join(directory, 'data'),
    installerFactory: () => ({ environment: async () => ({ docker: { installed: false, message: '未找到 Docker Desktop' },
      setupGuide: '旧 NapCat 环境安装说明', dockerInstallUrl: 'https://docs.docker.com/desktop/setup/install/windows-install/' }), status: async () => [], dispose: async () => {},
      startNapcat: async () => { starts.push('start'); }, install: async () => { starts.push('install'); } }),
    runtimeFactory: ({ getConfig }) => ({ status: () => ({ connected: false, accountId: '', backend: getConfig().qq.backend, metrics: {} }),
      reload: async () => {}, stop: async () => {}, invalidateTools() {}, invalidateMemory() {} }),
  });
  const address = await app.listen(0), base = 'http://127.0.0.1:' + address.port;
  const initial = await (await fetch(base + '/api/accounts')).json();
  const post = async (route, body) => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json',
      'x-dashboard-token': initial.csrfToken, origin: base }, body: JSON.stringify(body) });
    const value = await response.json(); assert.ok(response.ok, value.error || String(response.status)); return value;
  };
  const created = await post('/api/accounts', { name: 'Snow 外部连接 QA', platform: 'qq', qqNumber: qq });
  const id = created.account.id, service = app.accounts.get(id), state = service.store.getState();
  Object.assign(state.draft.qq.connections.napcat, { wsUrl: 'ws://127.0.0.1:13001', webUiUrl: 'http://127.0.0.1:16099' });
  Object.assign(state.draft.qq.connections.snowluma, { wsUrl: 'ws://127.0.0.1:23001', httpUrl: 'http://127.0.0.1:23000', webUiUrl: 'http://127.0.0.1:25099' });
  Object.assign(state.draft.qq, state.draft.qq.connections.snowluma, { enabled: true, backend: 'snowluma' });
  state.draft.models.deepseek.enabled = true;
  state.applied = structuredClone(state.draft); service.store.restoreState(state); service.store.recordSetupCompleted(qq);
  await service.invoke('/environment/check', {});
  assert.equal((await service.state()).environment.docker.installed, false, 'the fixture retains a real missing-Docker diagnostic');
  service.store.setSecret('napcatToken', 'fixture-napcat-private');
  service.store.setSecret('deepseekApiKey', 'fixture-deepseek-private');

  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-background-networking'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === base || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    network.push(url.origin); return route.abort();
  });
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('#server-label').textContent === '管理服务可访问');
  await page.locator('[data-page="connections"]').click();
  await page.locator(`[data-open-account="${id}"]`).click();
  const backend = page.locator('#qq-backend');
  await backend.waitFor({ state: 'visible' });
  assert.equal(await backend.inputValue(), 'snowluma');
  assert.equal(await backend.locator('option[value="snowluma"]').isDisabled(), false);
  assert.equal(await page.locator('#snowluma-ws-token-field').isVisible(), true);
  assert.equal(await page.locator('#snowluma-http-fields').isVisible(), true);
  assert.equal(await page.locator('#napcat-token-field').isVisible(), false);
  assert.equal(await page.locator('#napcat-connect-toolbar [data-open-napcat-program]').isVisible(), false);
  assert.equal(await page.locator('[data-connector-napcat-links]').isVisible(), false);
  assert.equal(await page.locator('#napcat-login-token').isVisible(), false);
  assert.equal(await page.locator('#snowluma-release-link').getAttribute('href'), 'https://github.com/TomyJan/SnowLuma/releases/tag/v2.4.2');
  assert.match(await page.locator('#snowluma-security-note').textContent(), /真实 QQ|Windows/);
  assert.match(await page.locator('#connector-help-text').textContent(), /WS、HTTP|WS／HTTP/);
  assert.match(await page.locator('#setup-test-guide').textContent(), /SnowLuma/);
  pass('Snow 外部连接显示独立 HTTP／WS 字段、固定版本说明，隐藏全部 NapCat 启动与登录 Token 入口');

  await page.locator('.connection-diagnostics > summary').click();
  const diagnostics = page.locator('#environment-checks');
  assert.match(await diagnostics.textContent(), /24\.22\.1/);
  assert.match(await diagnostics.textContent(), /26\.12\.1/);
  assert.match(await diagnostics.textContent(), /2\.4\.2-node.*OneBot v11/);
  assert.match(await diagnostics.textContent(), /WS.*HTTP/);
  assert.doesNotMatch(await diagnostics.textContent(), /Docker|NapCat|旧.*安装说明/);
  assert.equal(await diagnostics.locator('a, .check-row').count(), 0, 'host installer diagnostics must not masquerade as external Snow prerequisites');
  assert.deepEqual(starts, []);
  pass('缺Docker的真实环境快照不会变成Snow诊断阻断或下载引导，只展示外部Node和固定协议要求');

  await backend.selectOption('napcat');
  assert.equal(await page.locator('[data-config="qq.wsUrl"]').inputValue(), 'ws://127.0.0.1:13001');
  assert.equal(await page.locator('[data-config="qq.webUiUrl"]').inputValue(), 'http://127.0.0.1:16099');
  assert.equal(await page.locator('#snowluma-http-fields').isVisible(), false);
  assert.equal(await page.locator('#napcat-token-field').isVisible(), true);
  assert.equal(await page.locator('#snowluma-release-link').isVisible(), false);
  await backend.selectOption('snowluma');
  assert.equal(await page.locator('[data-config="qq.wsUrl"]').inputValue(), 'ws://127.0.0.1:23001');
  assert.equal(await page.locator('[data-config="qq.httpUrl"]').inputValue(), 'http://127.0.0.1:23000');
  assert.equal(await page.locator('[data-config="qq.webUiUrl"]').inputValue(), 'http://127.0.0.1:25099');
  assert.equal(service.store.getConfig().permissions.released, false);
  assert.equal(service.store.getSecret('napcatToken'), 'fixture-napcat-private');
  pass('切换仅更改编辑对象的后端参数，保留每端地址与原凭据，不释放权限');

  await page.locator('[data-secret="snowlumaWsToken"]').fill('fixture-snow-ws');
  const invalidApply = page.waitForResponse(response => response.url().endsWith('/config/apply') && response.request().method() === 'POST');
  await page.locator('#apply-config').click();
  assert.equal((await invalidApply).status(), 400);
  await page.waitForFunction(() => document.querySelector('[data-secret="snowlumaHttpToken"]').getAttribute('aria-invalid') === 'true');
  assert.equal(await page.locator('[data-secret="napcatToken"]').getAttribute('aria-invalid'), null);
  assert.match(await page.locator('#setup-error').textContent(), /HTTP Token/);
  await page.locator('[data-secret="snowlumaHttpToken"]').fill('fixture-snow-http');
  const applied = page.waitForResponse(response => response.url().endsWith('/config/apply') && response.request().method() === 'POST');
  await page.locator('#apply-config').click(); assert.ok((await applied).ok());
  await page.waitForFunction(() => !document.querySelector('[data-secret="snowlumaHttpToken"]').hasAttribute('aria-invalid'));
  assert.equal(service.store.getSecret('snowlumaWsToken'), 'fixture-snow-ws');
  assert.equal(service.store.getSecret('snowlumaHttpToken'), 'fixture-snow-http');
  assert.equal(service.store.getConfig().permissions.released, false);
  assert.equal(service.setupStatus().connection.verified, false, 'saving credentials is not evidence of QQ login');
  pass('HTTP Token 缺失错误定位到正确字段；补齐后真实保存应用仍保持只读且不伪造连接');

  await page.evaluate(() => { window.__snowOpens = []; window.open = (...args) => { window.__snowOpens.push(args); return null; }; });
  await page.locator('#open-napcat').click();
  assert.equal((await page.evaluate(() => window.__snowOpens))[0][0], 'http://127.0.0.1:25099/');
  await page.locator('[data-page="modules"]').click();
  const card = page.locator('[data-module-card="snowluma"]'); await card.waitFor();
  assert.equal(await page.locator('[data-module-card="napcat"]').count(), 0);
  assert.match(await page.locator('#module-connector-note').textContent(), /SnowLuma 外部实例/);
  assert.equal(await card.locator('[data-module-action], [data-open-napcat-program]').count(), 0);
  assert.match(await card.locator('.pill').textContent(), /外部运行.*未连接/);
  assert.doesNotMatch(await card.locator('.module-version').textContent(), /已安装/);
  assert.doesNotMatch(await card.locator('.module-version').textContent(), /已连接协议版本/);
  await card.locator('[data-open-connector-login]').click();
  assert.equal((await page.evaluate(() => window.__snowOpens)).length, 2);
  assert.deepEqual(starts, []);
  pass('Snow 模块卡只提供外部说明／本地管理页／连接配置，没有 Docker 或自动启动操作');
  service.runtime.status = () => ({ connected: true, accountId: qq, backend: 'snowluma', metrics: {},
    connectorVersion: { appName: 'SnowLuma', appVersion: '2.4.2-node', protocol: 'v11' } });
  await page.locator('#refresh-state').click();
  await page.waitForFunction(() => document.querySelector('[data-module-card="snowluma"] .module-version').textContent.includes('已连接协议版本 2.4.2-node'));
  assert.match(await card.locator('.pill').textContent(), /已连接/);
  pass('只在后台给出已连接版本证据时显示实际协议版本，保留固定参考版本与外部运行语义');

  await page.setViewportSize({ width: 650, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false);
  fs.mkdirSync(process.env.QQ_UI_ARTIFACT_DIR || os.tmpdir(), { recursive: true });
  await page.evaluate(() => document.querySelector('#toast-region')?.replaceChildren());
  await page.screenshot({ path: path.join(process.env.QQ_UI_ARTIFACT_DIR || os.tmpdir(), 'QQ_Service-snowluma-modules.png'), fullPage: true });
  assert.deepEqual(errors, []); assert.deepEqual(network, []); assert.deepEqual(starts, []);
  pass('650px 窄屏无横向溢出，零页面错误、外网请求或第三方程序启动');
  console.log(JSON.stringify({ groups: passed.length, errors, unexpectedNetwork: network, componentStarts: starts }));
})().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; })
  .finally(async () => { await browser?.close(); await app?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
