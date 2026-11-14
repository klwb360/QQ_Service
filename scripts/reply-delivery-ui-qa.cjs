'use strict';

// Real local dashboard/config API and Chromium; no QQ login or model request.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-reply-delivery-ui-'));
let app, browser;

(async () => {
  const { createDashboard } = await import(root + '/src/server.mjs');
  app = createDashboard({ dataDir: path.join(temp, 'data'), installerFactory: () => ({
    environment: async () => ({}), status: async () => [], dispose: async () => {},
  }) });
  const address = await app.listen(0), base = 'http://127.0.0.1:' + address.port;
  const directory = await (await fetch(base + '/api/accounts')).json();
  const createdResponse = await fetch(base + '/api/accounts', { method: 'POST', headers: {
    'content-type': 'application/json', 'x-dashboard-token': directory.csrfToken, origin: base,
  }, body: JSON.stringify({ name: '回复节奏 QA', platform: 'qq', qqNumber: '12345001' }) });
  assert.ok(createdResponse.ok);
  const created = await createdResponse.json(), id = created.account.id, service = app.accounts.get(id);
  const state = service.store.getState();
  state.draft.chat.enabled = state.draft.models.deepseek.enabled = true;
  state.draft.groups = ['98765001', '98765002'].map((groupId, index) => ({ id: groupId,
    name: `回复节奏测试群 ${index + 1}`, mode: 'social', read: true, send: false, triggers: ['mention'], social: { enabled: true } }));
  state.applied = structuredClone(state.draft);
  service.store.restoreState(state); service.store.recordSetupCompleted('12345001');
  service.store.setSecret('deepseekApiKey', 'LOCAL_FIXTURE_API_KEY');
  const errors = [], unexpectedNetwork = [];
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || '/usr/bin/chromium',
    headless: true, args: ['--no-sandbox', '--disable-background-networking'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === base || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    unexpectedNetwork.push(url.origin); return route.abort();
  });
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('#server-label').textContent === '管理服务可访问');
  await page.locator('[data-page="connections"]').click();
  await page.locator(`[data-open-account="${id}"]`).click();
  async function openGroups() {
    await page.locator('[data-page="scenarios"]').click();
    await page.locator('[data-scenario-tab="permissions"]').click();
    const social = page.locator('.group-social-settings').first();
    if (!await social.evaluate(node => node.open)) await social.locator(':scope > summary').click();
    const advanced = social.locator('.group-social-advanced');
    if (!await advanced.evaluate(node => node.open)) await advanced.locator(':scope > summary').click();
    return social;
  }
  let social = await openGroups();
  assert.equal(await social.locator('[data-group-delivery="enabled"]').isChecked(), true);
  assert.equal(await social.locator('[data-group-delivery="maxMessages"]').inputValue(), '3');
  assert.equal(await social.locator('[data-group-delivery="pauseMs"]').inputValue(), '800');
  await social.locator('[data-group-delivery="enabled"]').uncheck();
  await social.locator('[data-group-delivery="maxMessages"]').fill('1');
  await social.locator('[data-group-delivery="pauseMs"]').fill('0');
  const saved = page.waitForResponse(response => response.url().endsWith('/config/save') && response.request().method() === 'POST');
  await page.locator('#group-save').click(); assert.ok((await saved).ok());
  const savedGroups = service.store.getState().draft.groups;
  assert.deepEqual(savedGroups[0].social.delivery, { enabled: false, maxMessages: 1, pauseMs: 0 });
  assert.deepEqual(savedGroups[1].social.delivery, { enabled: true, maxMessages: 3, pauseMs: 800 });
  assert.equal(service.store.getConfig().groups[0].social.delivery?.enabled ?? true, true,
    'saving edited pacing must not apply it to a running account');
  console.log('PASS 每群回复节奏渲染默认值、关闭／单条／零停顿保存，其他群与运行参数不受影响');

  await page.reload();
  await page.waitForFunction(() => document.querySelector('#server-label').textContent === '管理服务可访问');
  social = await openGroups();
  assert.equal(await social.locator('[data-group-delivery="enabled"]').isChecked(), false);
  assert.equal(await social.locator('[data-group-delivery="maxMessages"]').inputValue(), '1');
  assert.equal(await social.locator('[data-group-delivery="pauseMs"]').inputValue(), '0');
  assert.match(await social.locator('.group-delivery-options').textContent(), /首条立即发送.*不额外调用模型/u);
  await social.locator('[data-group-delivery="enabled"]').check();
  await social.locator('[data-group-delivery="maxMessages"]').fill('3');
  await social.locator('[data-group-delivery="pauseMs"]').fill('1500');
  const resaved = page.waitForResponse(response => response.url().endsWith('/config/save') && response.request().method() === 'POST');
  await page.locator('#group-save').click(); assert.ok((await resaved).ok());
  assert.deepEqual(service.store.getState().draft.groups[0].social.delivery,
    { enabled: true, maxMessages: 3, pauseMs: 1500 });
  assert.deepEqual(service.store.getState().draft.groups[1].social.delivery,
    { enabled: true, maxMessages: 3, pauseMs: 800 });
  assert.deepEqual(errors, []); assert.deepEqual(unexpectedNetwork, []);
  assert.equal(service.runtime.status().metrics.modelCalls, 0);
  console.log('PASS 刷新后保留设置，可重新启用至上限，全程无页面异常／外部网络／模型调用');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try { await browser?.close(); } finally { try { await app?.close(); }
    finally { fs.rmSync(temp, { recursive: true, force: true }); } }
});
