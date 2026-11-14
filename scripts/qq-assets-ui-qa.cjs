'use strict';

// Chromium against a real temporary dashboard and asset/config APIs. No QQ
// login, external MCP process, website, model API or package install is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-assets-ui-'));
const artifacts = process.env.QQ_UI_ARTIFACT_DIR || os.tmpdir();
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
const GROUP = '98765001', QQ = '12345001';
let app, browser;
const passed = [];
const uiIssues = [];
const pass = value => { passed.push(value); console.log('PASS', value); };

(async () => {
  const { createDashboard } = await import(root + '/src/server.mjs');
  app = createDashboard({ dataDir: path.join(temp, 'data'), installerFactory: () => ({
    environment: async () => ({}), status: async () => [], dispose: async () => {},
  }) });
  const address = await app.listen(0), base = 'http://127.0.0.1:' + address.port;
  const directory = await (await fetch(base + '/api/accounts')).json();
  async function post(route, body) {
    const response = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json',
      'x-dashboard-token': directory.csrfToken, origin: base }, body: JSON.stringify(body) });
    const value = await response.json(); assert.ok(response.ok, value.error || response.status); return value;
  }
  const created = await post('/api/accounts', { name: 'QQ 素材 QA', platform: 'qq', qqNumber: QQ });
  const id = created.account.id, service = app.accounts.get(id), state = service.store.getState();
  state.draft.chat.enabled = state.draft.models.deepseek.enabled = true;
  state.draft.tools.enabled = state.draft.tools.builtinQQ = true;
  state.draft.groups = [GROUP, '98765002'].map((groupId, index) => ({ id: groupId, name: index ? '第二个范围群' : '素材 QA 群',
    mode: 'social', read: true, send: true, cooldownSeconds: 5, triggers: ['mention'], social: { enabled: true } }));
  state.applied = structuredClone(state.draft); service.store.restoreState(state); service.store.recordSetupCompleted(QQ);
  const errors = [], unexpectedNetwork = [], mutations = [];
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-background-networking'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST') mutations.push(new URL(request.url()).pathname); });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === base || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    unexpectedNetwork.push(url.origin); return route.abort();
  });
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('#server-label').textContent === '管理服务可访问');
  await page.locator('[data-page="connections"]').click();
  await page.locator(`[data-open-account="${id}"]`).click();
  await page.locator('[data-page="modules"]').click();
  const assets = page.locator('#qq-assets-card');
  await assets.locator(':scope > summary').click();
  assert.notEqual(await assets.locator(':scope > summary').evaluate(node => getComputedStyle(node, '::before').transform), 'none',
    'the asset section arrow must reflect its expanded state');
  await page.waitForFunction(() => document.querySelectorAll('#qq-assets-card [data-asset-group] option').length === 2);
  await assets.getByText('导入图片、表情包或文档', { exact: true }).click();
  await assets.locator('[data-asset-file]').setInputFiles({ name: 'approved-qa.gif', mimeType: 'image/gif', buffer: GIF });
  await assets.locator('[data-asset-tags]').fill('开心，赞同');
  await assets.locator('[data-asset-description]').fill('<img src=x onerror="window.__assetXss=1"> 开心同意');
  const imported = page.waitForResponse(response => response.url().endsWith('/qq/assets/import') && response.request().method() === 'POST');
  await assets.locator('[data-asset-import]').click();
  assert.ok((await imported).ok());
  await assets.locator('[data-asset-id]').waitFor();
  const item = assets.locator('[data-asset-id]').first(), assetId = await item.getAttribute('data-asset-id');
  await page.waitForFunction(() => { const image = document.querySelector('#qq-assets-card .qq-asset-preview'); return image?.complete && image.naturalWidth === 1; });
  assert.equal(await page.evaluate(() => window.__assetXss), undefined);
  assert.equal(await item.locator('img').count(), 1, 'the only image is the actual asset preview');
  const listed = service.assets.list({ actualQQ: QQ, groupId: GROUP });
  assert.equal(listed.assets[0].assetId, assetId);
  assert.equal(service.assets.list({ actualQQ: QQ, groupId: '98765002' }).assets.length, 0);
  pass('真实 GIF 上传、当前群范围、受保护预览与描述 HTML 转义');

  await item.locator('[data-asset-do="edit"]').click();
  const editor = assets.locator('dialog[open]');
  await editor.waitFor();
  await editor.locator('[data-edit-description]').fill('人工补充的轻松语境 <script>window.__assetXss=2</script>');
  await editor.locator('[data-edit-tags]').fill(Array.from({ length: 21 }, (_, index) => '标签' + index).join('，'));
  const invalidUpdate = page.waitForResponse(response => response.url().endsWith('/qq/assets/update') && response.request().method() === 'POST');
  await editor.locator('button[type="submit"]').click();
  const rejected = await invalidUpdate; assert.equal(rejected.status(), 400);
  const rejectedBody = await rejected.json(); assert.match(rejectedBody.error, /20/);
  assert.equal(await editor.evaluate(node => node.open), true, 'a validation failure keeps the edit in place');
  const inlineError = (await editor.locator('[role="alert"], [data-edit-error]').allTextContents()).join(' ');
  if (!inlineError.includes('20')) {
    uiIssues.push('素材编辑 API 错误未显示在模态对话框内');
    fs.mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, 'QQ_Service-assets-edit-error.png'), fullPage: true });
  }
  assert.match(inlineError, /20/, 'server validation errors must remain visible inside the active modal');
  await editor.locator('[data-edit-tags]').fill('仅标签命中_QA，期待');
  await editor.locator('[data-edit-emotion]').fill('开心赞同');
  await editor.locator('[data-edit-usage]').fill('轻松聊天时表达同意');
  await editor.locator('[data-edit-avoid]').fill('严肃工作通知');
  const updated = page.waitForResponse(response => response.url().endsWith('/qq/assets/update') && response.request().method() === 'POST');
  await editor.locator('button[type="submit"]').click(); assert.ok((await updated).ok());
  await page.waitForFunction(() => !document.querySelector('#qq-assets-card dialog').open);
  const editedAsset = service.assets.list({ actualQQ: QQ, groupId: GROUP }).assets[0];
  assert.equal(editedAsset.emotion, '开心赞同'); assert.equal(editedAsset.usage, '轻松聊天时表达同意');
  assert.equal(editedAsset.avoidWhen, '严肃工作通知');
  await assets.locator('[data-asset-query]').fill('仅标签命中_QA'); await assets.locator('[data-asset-query]').press('Enter');
  await page.waitForResponse(response => response.url().includes('/qq/assets?') && response.url().includes('query='));
  assert.equal(await assets.locator('[data-asset-id]').count(), 1, 'tag-only queries must survive every filter');
  await assets.locator('[data-asset-query]').fill('完全没有命中的词_QA'); await assets.locator('[data-asset-query]').press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('#qq-assets-card [data-asset-id]').length === 0);
  await assets.locator('[data-asset-query]').fill(''); await assets.locator('[data-asset-query]').press('Enter');
  await assets.locator('[data-asset-id]').waitFor();
  assert.equal(await page.evaluate(() => window.__assetXss), undefined);
  await assets.locator('[data-asset-do="analyze"]').click();
  await page.waitForFunction(() => document.querySelector('[data-asset-error]').textContent.includes('选择支持图片'));
  assert.equal(mutations.some(route => route.endsWith('/qq/assets/analyze')), false, 'an unselected vision model cannot spend API credits');
  fs.mkdirSync(artifacts, { recursive: true });
  await page.locator('#toast-region').evaluate(node => node.replaceChildren());
  await assets.screenshot({ path: path.join(artifacts, 'QQ_Service-assets-desktop.png') });
  pass('原生 HTML 编辑对话框、标签搜索、无匹配提示和未选视觉模型阻断');

  await page.locator('#mcp-section > summary').click();
  const presets = page.locator('#mcp-presets'); await presets.locator(':scope > summary').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-preset-select] option').length === 8);
  await presets.locator('[data-preset-select]').selectOption('slack-official');
  assert.equal(await presets.locator('[data-preset-prepare]').isDisabled(), true);
  assert.match(await presets.locator('[data-preset-info]').textContent(), /OAuth/);
  await presets.locator('[data-preset-select]').selectOption('discord-bot');
  assert.match(await presets.locator('[data-preset-info]').textContent(), /DISCORD_TOKEN/);
  await presets.locator('[data-preset-select]').selectOption('wechat-windows');
  assert.deepEqual(JSON.parse(await presets.locator('[data-preset-args]').inputValue()), ['-m', 'wechat_mcp']);
  await presets.locator('[data-preset-select]').selectOption('builtin-web-search');
  const prepared = page.waitForResponse(response => response.url().endsWith('/mcp/preset/prepare') && response.request().method() === 'POST');
  await presets.locator('[data-preset-prepare]').click();
  const preparedResponse = await prepared; assert.ok(preparedResponse.ok());
  assert.equal((await preparedResponse.json()).server.enabled, false);
  await page.waitForFunction(() => document.querySelector('#mcp-service-dialog').open);
  assert.equal(await page.locator('#mcp-service-command').inputValue(), 'node');
  assert.deepEqual(JSON.parse(await page.locator('#mcp-service-args').inputValue()), ['{appDir}/examples/mcp/web-search-safe.mjs']);
  assert.equal(service.store.getState().draft.mcp.servers.length, 0, 'preparing a preset opens an editor without saving or executing it');
  assert.equal(mutations.some(route => /\/mcp\/(test|refresh)$/u.test(route)), false);
  await page.locator('#mcp-service-cancel').click();
  pass('八条 MCP 预设、Slack OAuth 不可用、准备仅打开停用配置且不启动');

  await page.locator('[data-page="scenarios"]').click(); await page.locator('[data-scenario-tab="permissions"]').click();
  const social = page.locator('.group-social-settings').first();
  await social.locator(':scope > summary').click(); await social.locator('.group-social-advanced > summary').click();
  const choices = social.locator('[data-group-qq-reply]'); assert.equal(await choices.count(), 5);
  assert.deepEqual((await choices.evaluateAll(nodes => nodes.map(node => node.dataset.groupQqReply))).sort(),
    ['qq:poke_member', 'qq:react_message', 'qq:send_image', 'qq:send_message', 'qq:send_sticker'].sort());
  await social.locator('[data-group-qq-reply="qq:send_sticker"]').check();
  await social.locator('[data-group-qq-reply="qq:react_message"]').check();
  await social.locator('[data-group-social="replyActionCooldownSeconds"]').fill('45');
  await social.locator('[data-group-social="replyActionsPerHour"]').fill('9');
  const saved = page.waitForResponse(response => response.url().endsWith('/config/save') && response.request().method() === 'POST');
  await page.locator('#group-save').click(); assert.ok((await saved).ok());
  const group = service.store.getState().draft.groups[0];
  assert.deepEqual(group.social.replyTools.sort(), ['qq:react_message', 'qq:send_sticker']);
  assert.equal(group.social.replyActionCooldownSeconds, 45); assert.equal(group.social.replyActionsPerHour, 9);
  assert.deepEqual(service.store.getConfig().groups[0].social.replyTools || [], [], 'save alone does not release or apply reply permissions');
  pass('每群五项安全 QQ 回复动作及冷却／次数保存，草稿不暗中应用');

  await page.locator('[data-page="modules"]').click();
  await page.setViewportSize({ width: 650, height: 900 });
  await page.locator('#toast-region').evaluate(node => node.replaceChildren());
  await assets.screenshot({ path: path.join(artifacts, 'QQ_Service-assets-narrow.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'asset card must fit the narrow viewport');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const sync = assets.locator('[data-asset-sync]');
  await sync.click();
  await page.waitForFunction(() => /QQ|连接|登录/u.test(document.querySelector('[data-asset-error]').textContent));
  pass('未连接 QQ 时同步收藏表情给出可见错误');
  page.once('dialog', dialog => dialog.accept());
  await assets.locator('[data-asset-do="remove"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#qq-assets-card [data-asset-id]').length === 0);
  assert.equal(service.assets.list({ actualQQ: QQ, groupId: GROUP }).assets.length, 0);
  assert.deepEqual(errors, []); assert.deepEqual(unexpectedNetwork, []);
  assert.equal(service.runtime.status().metrics.modelCalls, 0);
  assert.deepEqual(service.mcpManager.status(), []);
  pass('窄屏无横向溢出、删除真实素材、全程无外部网络／模型调用／MCP执行');
  console.log(JSON.stringify({ passed: passed.length, uiIssues, screenshots: [path.join(artifacts, 'QQ_Service-assets-desktop.png'), path.join(artifacts, 'QQ_Service-assets-narrow.png')] }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try { await browser?.close(); } finally { try { await app?.close(); } finally { fs.rmSync(temp, { recursive: true, force: true }); } }
});
