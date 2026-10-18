'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
// Optional real Electron check. Requires a running X display on Linux and a
// Playwright installation. All QQ traffic uses a local OneBot fixture; no model
// or external QQ service is contacted. The backend is used without modification.
const { _electron } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const project = path.resolve(__dirname, '..');
const { WebSocketServer } = require(path.join(project, 'node_modules', 'ws'));
const ORIGINAL_DESIGN = { version: 1, edits: [
  { selector: '[data-ui-key="page.overview.title"]', text: '仪表盘' },
  { selector: '[data-ui-key="ui-auto-cuskuxt"]', text: '仪表盘' },
  { selector: '[data-ui-key="ui-auto-imykcuy"]', text: '' },
  { selector: '[data-ui-key="ui-auto-tqmqjw"]', text: '' },
  ...['bgktpde', 'jyinkzv', 'vypugx', 'iithlzi', 'smmcig', 'dxkvefp'].map(key => ({ selector: `[data-ui-key="ui-auto-${key}"]`, hidden: true })),
  { selector: '[data-ui-key="ui-auto-fytwzln"]', text: 'NapCat 的连接信息' },
  { selector: '[data-ui-key="ui-auto-iahquol"]', text: '权限' },
  { selector: '[data-ui-key="ui-auto-jtkjder"]', text: '日志' },
  { selector: '[data-ui-key="page.records.title"]', text: '', hidden: true },
  { selector: '[data-ui-key="page.records.description"]', hidden: true },
  { selector: '[data-ui-key="ui-auto-ihkvxhl"]', text: '设置' },
  { selector: '[data-ui-key="ui-auto-jtmvoze"]', text: '模块' },
  { selector: '[data-ui-key="ui-auto-iahikyy"]', text: '账号' },
] };
const RETIRED = ['imykcuy', 'tqmqjw', 'bgktpde', 'jyinkzv', 'vypugx', 'iithlzi', 'smmcig', 'dxkvefp'].map(key => `ui-auto-${key}`);
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-service-builder-qa-'));
const dataDir = path.join(fixture, 'data');
const profile = path.join(fixture, 'electron-profile');
const checks = [], errors = [], sent = [], peers = new Set();
let electron, app, qq, page, account;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function pass(message) { checks.push(message); console.log('PASS', message); }
async function until(predicate, message, timeout = 10000) {
  const stop = Date.now() + timeout;
  do { if (await predicate()) return; await delay(60); } while (Date.now() < stop);
  throw new Error(message);
}
async function state() { return page.evaluate(id => fetch(`/api/accounts/${id}/state`).then(r => r.json()), account.id); }
async function seed() {
  qq = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(qq, 'listening');
  qq.on('connection', socket => {
    peers.add(socket); socket.once('close', () => peers.delete(socket));
    socket.on('message', raw => {
      const p = JSON.parse(raw.toString());
      let data = {};
      if (p.action === 'get_login_info') data = { user_id: 12345001, nickname: '模拟 QQ' };
      if (p.action === 'get_group_list') data = [{ group_id: 98765001, group_name: 'DESIGNER_PRIVATE_GROUP_NAME' }];
      if (p.action.startsWith('send_')) { sent.push(p); data = { message_id: sent.length }; }
      socket.send(JSON.stringify({ echo: p.echo, status: 'ok', retcode: 0, data }));
    });
  });
  const { createDashboard } = await import(`${project}/src/server.mjs`);
  const { createInstaller } = await import(`${project}/src/installer.mjs`);
  app = createDashboard({ dataDir, installerFactory: context => ({ ...createInstaller(context), environment: async () => ({}), status: async () => [] }) });
  const address = await app.listen(0), origin = `http://127.0.0.1:${address.port}`;
  const token = (await (await fetch(`${origin}/api/accounts`)).json()).csrfToken;
  async function post(endpoint, body) {
    const response = await fetch(`${origin}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': token, Origin: origin }, body: JSON.stringify(body) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  }
  const created = await post('/api/accounts', { name: 'DESIGNER_PRIVATE_ACCOUNT_NAME', platform: 'qq', qqNumber: '12345001' });
  account = created.account;
  const config = created.state.draft;
  config.qq.enabled = true; config.qq.wsUrl = `ws://127.0.0.1:${qq.address().port}`;
  config.models.deepseek.enabled = true; config.chat.enabled = true;
  config.chat.persona = 'DESIGNER_PRIVATE_PERSONA';
  config.groups = [{ id: '98765001', name: 'DESIGNER_PRIVATE_GROUP_NAME', mode: 'social', read: true, send: false, triggers: ['mention'], trigger: 'mention', prefix: '/ai', probability: .03, cooldownSeconds: 30 }];
  const saved = await post(`/api/accounts/${account.id}/config/save`, { config, secretUpdates: { deepseekApiKey: 'DESIGNER_SAVED_API_SECRET', napcatToken: 'DESIGNER_SAVED_ONEBOT_TOKEN' } });
  await post(`/api/accounts/${account.id}/config/apply`, { revision: saved.revision });
  await post(`/api/accounts/${account.id}/runtime/connect`, {});
  await post(`/api/accounts/${account.id}/permissions/release`, { revision: saved.revision });
  await app.close(); app = null;
}
async function launch(hash) {
  const npm = path.join(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
  assert.ok(fs.existsSync(npm));
  electron = await _electron.launch({ executablePath: process.env.ELECTRON_EXECUTABLE || path.join(project, 'node_modules', 'electron', 'dist', 'electron'), args: ['--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`, project], env: {
    ...process.env, QQBRIDGE_NODE_RUNTIME: process.execPath, QQ_DASHBOARD_NPM_CLI: npm,
    QQ_DASHBOARD_DATA_DIR: dataDir, XDG_CONFIG_HOME: path.join(fixture, 'config'), XDG_CACHE_HOME: path.join(fixture, 'cache'),
  }, timeout: 30000 });
  page = await electron.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  if (hash) { await page.waitForURL('http://127.0.0.1:*/**'); const url = new URL(page.url()); url.hash = hash; await page.goto(url.href); }
  await page.waitForFunction(() => document.querySelector('#server-label')?.textContent === '管理服务可访问' && Boolean(window.QQServiceDesigner) && Boolean(window.QQServiceBuilder));
  return page.url();
}
async function selectAccount() {
  await page.locator('[data-page="connections"]').click();
  const header = page.locator(`[data-open-account="${account.id}"]`);
  if (await header.getAttribute('aria-expanded') !== 'true') await header.click();
  await until(async () => await page.locator('#account-workspace').isVisible(), '账号未展开');
}
async function enter() { await page.locator('#frontend-editor-toggle').click(); await page.locator('#designer-root[data-mode="edit"]').waitFor(); }
async function closeEditor() { await page.locator('#designer-close').click(); await until(() => page.evaluate(() => document.body.dataset.uiDesignMode !== 'edit'), '未退出编辑模式'); }
async function documentValue() { return page.evaluate(() => window.QQServiceDesigner.getDocument()); }
async function saved() {
  await until(async () => {
    const value = await documentValue();
    return page.evaluate(async doc => JSON.stringify(await window.qqBridgeDesktop.getUiDesign()) === JSON.stringify(doc), value);
  }, '界面修改没有完成原生保存');
}
async function changeText(selector, text) {
  await page.locator(selector).click(); await page.locator('#designer-text').fill(text); await page.locator('#designer-apply').click();
}
async function rejectImport(value) {
  const before = JSON.stringify(await documentValue());
  const rejected = await page.evaluate(async json => {
    const input = JSON.parse(json);
    try { await window.QQServiceDesigner.importDocument(input); return false; } catch { return true; }
  }, JSON.stringify(value));
  assert.equal(rejected, true, JSON.stringify(value));
  assert.equal(JSON.stringify(await documentValue()), before);
}

async function layoutValue() { return (await documentValue()).layout; }
async function chooseComponent(id) {
  await page.locator(`[data-builder-tree-id="${id}"] > button`).click();
  await until(async () => await page.locator('#builder-component-label').isVisible(), '组件属性面板未打开');
}
async function addComponent(type, pageId, parent = '') {
  const before = new Set((await layoutValue()).components.map(item => item.id));
  await page.locator('#builder-component-type').selectOption(type);
  await page.locator('#builder-target-page').selectOption(pageId);
  await page.locator('#builder-target-parent').selectOption(parent);
  await page.locator('#builder-add-component').click();
  const added = (await layoutValue()).components.find(item => !before.has(item.id));
  assert.ok(added, `${type} 未创建`);
  assert.equal(added.type, type); assert.equal(added.page, pageId);
  assert.equal(added.parent, parent || null);
  return added.id;
}
async function createPage(name) {
  const before = new Set((await layoutValue().catch(() => null))?.pages.map(item => item.id) || []);
  await page.locator('#builder-add-page-name').fill(name);
  await page.locator('#builder-add-page').click();
  const added = (await layoutValue()).pages.find(item => !before.has(item.id));
  assert.ok(added, '新菜单未创建'); assert.equal(added.label, name);
  await until(async () => page.evaluate(id => window.QQServiceNavigation.currentPage() === id, added.id), '新菜单未打开');
  return added.id;
}
async function editComponent(id, fields = {}) {
  await chooseComponent(id);
  for (const [name, value] of Object.entries(fields)) {
    const control = page.locator(`#builder-component-${name}`);
    if (name.startsWith('style-') && !await control.isVisible()) await control.locator('xpath=ancestor::details[1]').locator(':scope > summary').click();
    if (['page', 'parent', 'action', 'action-target', 'columns'].includes(name)) await control.selectOption(String(value));
    else await control.fill(String(value));
  }
  await page.locator('#builder-save-component').click();
}
async function gotoInEditor(id) { await page.locator('#designer-page').selectOption(id); }
async function dragComponent(id, targetId) {
  const source = page.locator(`[data-builder-tree-id="${id}"]`);
  const target = page.locator(`[data-builder-drop="before"][data-builder-drop-id="${targetId}"]`).first();
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent('dragstart', { dataTransfer: transfer });
  await target.dispatchEvent('dragover', { dataTransfer: transfer });
  await target.dispatchEvent('drop', { dataTransfer: transfer });
  await source.dispatchEvent('dragend', { dataTransfer: transfer }).catch(() => {});
  await transfer.dispose();
}
async function rejectNative(value) {
  assert.equal(await page.evaluate(async json => {
    const doc = JSON.parse(json);
    try { await window.qqBridgeDesktop.saveUiDesign(doc); return false; } catch { return true; }
  }, JSON.stringify(value)), true, '原生 IPC 接受了无效布局');
}

(async () => {
 try {
  await seed(); const firstUrl = await launch();
  await enter();
  await page.evaluate(value => window.QQServiceDesigner.importDocument(value), ORIGINAL_DESIGN);
  assert.deepEqual(await documentValue(), { version: 1, edits: [] });
  assert.equal(await page.locator('#designer-root').getAttribute('data-inspector-view'), 'builder');
  assert.equal(await page.locator('#designer-builder-slot').isVisible(), true);
  await page.locator('#page-title').click();
  assert.equal(await page.locator('#designer-root').getAttribute('data-inspector-view'), 'existing');
  assert.equal(await page.locator('#designer-existing-inspector').isVisible(), true);
  assert.equal(await page.locator('#designer-builder-slot').isVisible(), false);
  await page.locator('#designer-view-builder').click();
  assert.equal(await page.locator('#designer-builder-slot').isVisible(), true);
  assert.equal(await page.locator('#designer-existing-inspector').isVisible(), false);
  pass('旧版18条编辑导入仍可消解为已确认基线，未创建布局时保留 v1');

  const posts = [];
  await page.route('**/api/**', route => {
    if (route.request().method() === 'POST') { posts.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const permissionBefore = (await state()).applied.permissions.released;
  const firstPage = await createPage('QA 新菜单');
  assert.equal((await documentValue()).version, 2);
  assert.equal(await page.locator(`.nav-link[data-page="${firstPage}"]`).count(), 1);
  await page.locator(`[data-builder-menu-row="${firstPage}"] [data-builder-menu-action="edit"]`).click();
  await page.locator('#builder-page-label').fill('QA 工作台');
  await page.locator('#builder-page-title').fill('QA 自由配置');
  await page.locator('#builder-page-description').fill('仅用于本地界面验证');
  await page.locator('#builder-save-page').click();
  assert.equal((await layoutValue()).pages.find(item => item.id === firstPage).label, 'QA 工作台');
  assert.equal(await page.locator('#page-title').innerText(), 'QA 自由配置');
  assert.equal(await page.locator('#page-description').innerText(), '仅用于本地界面验证');
  assert.equal(await page.locator(`#page-${firstPage}`).isVisible(), true);
  const secondPage = await createPage('QA 目标菜单');
  const beforeNav = [...(await layoutValue()).navigation];
  await page.locator(`[data-builder-menu-row="${secondPage}"] [data-builder-menu-action="up"]`).click();
  const reorderedNav = (await layoutValue()).navigation;
  assert.equal(reorderedNav.indexOf(secondPage), beforeNav.indexOf(secondPage) - 1);
  assert.deepEqual(await page.locator('.nav-link[data-page]').evaluateAll(elements => elements.map(element => element.dataset.page)), reorderedNav);
  await gotoInEditor(firstPage);
  pass('可实际创建、命名及编辑自定义菜单，菜单排序与侧栏一致，导航进入新页面');

  const ids = {};
  for (const type of ['heading', 'text', 'button', 'select', 'input', 'textarea', 'switch', 'card', 'divider']) ids[type] = await addComponent(type, firstPage);
  assert.equal((await layoutValue()).components.length, 9);
  for (const id of Object.values(ids)) assert.equal(await page.locator(`[data-builder-id="${id}"]`).count(), 1);
  await editComponent(ids.heading, { label: 'QA 标题', text: 'QA 布局标题', parent: ids.card });
  await editComponent(ids.text, { label: 'QA 正文', text: '这是可编辑的正文', parent: ids.card });
  await editComponent(ids.card, { label: 'QA 三列容器', columns: '3' });
  await editComponent(ids.select, { label: 'QA 模型选择', options: 'DeepSeek\nOpenAI\n自定义模型' });
  await editComponent(ids.input, { label: 'QA 输入框', placeholder: '填写你的想法' });
  await editComponent(ids.textarea, { label: 'QA 多行输入', placeholder: '填写完整说明' });
  await editComponent(ids.button, { label: '打开目标菜单', action: 'navigate', 'action-target': secondPage });
  assert.equal((await layoutValue()).components.find(item => item.id === ids.card).columns, 3);
  assert.equal(await page.locator(`[data-builder-id="${ids.card}"] [data-builder-id="${ids.heading}"]`).count(), 1);
  assert.deepEqual((await layoutValue()).components.find(item => item.id === ids.select).options.map(option => option.label), ['DeepSeek', 'OpenAI', '自定义模型']);
  await page.screenshot({ path: '/tmp/qq-service-builder-components.png', fullPage: false });
  pass('九类组件均可创建；文字、提示、下拉选项及三列卡片嵌套可配置并渲染');

  await editComponent(ids.card, { 'style-backgroundColor': '#dceef2', 'style-borderRadius': '27px', 'style-padding': '31px', 'style-gap': '33px' });
  await editComponent(ids.button, { 'style-backgroundColor': '#123456', 'style-borderRadius': '19px', 'style-fontSize': '21px' });
  await editComponent(ids.input, { 'style-backgroundColor': '#f2eedd', 'style-borderRadius': '17px', 'style-fontSize': '18px' });
  const cardSurface = page.locator(`[data-builder-id="${ids.card}"] > .builder-component-surface`);
  assert.deepEqual(await cardSurface.evaluate(node => ({ background: getComputedStyle(node).backgroundColor, radius: getComputedStyle(node).borderRadius, padding: getComputedStyle(node).padding })), { background: 'rgb(220, 238, 242)', radius: '27px', padding: '31px' });
  assert.equal(await cardSurface.locator(':scope > .builder-card-children').evaluate(node => getComputedStyle(node).gap), '33px');
  const visibleButton = page.locator(`[data-builder-id="${ids.button}"] .builder-component-surface > button`);
  assert.deepEqual(await visibleButton.evaluate(node => ({ background: getComputedStyle(node).backgroundColor, radius: getComputedStyle(node).borderRadius, size: getComputedStyle(node).fontSize })), { background: 'rgb(18, 52, 86)', radius: '19px', size: '21px' });
  const visibleInput = page.locator(`[data-builder-id="${ids.input}"] input`);
  assert.deepEqual(await visibleInput.evaluate(node => ({ background: getComputedStyle(node).backgroundColor, radius: getComputedStyle(node).borderRadius, size: getComputedStyle(node).fontSize })), { background: 'rgb(242, 238, 221)', radius: '17px', size: '18px' });
  await editComponent(ids.button, { 'style-backgroundColor': '', 'style-borderRadius': '', 'style-fontSize': '' });
  assert.notEqual(await visibleButton.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(18, 52, 86)');
  assert.notEqual(await visibleButton.evaluate(node => getComputedStyle(node).fontSize), '21px');
  pass('自建卡片背景、圆角、内距及子组件间距真实生效；按钮和输入框样式落到可见控件且清空后恢复默认');

  await chooseComponent(ids.heading); await page.locator('#builder-move-down').click();
  let siblings = (await layoutValue()).components.filter(item => item.parent === ids.card).map(item => item.id);
  assert.deepEqual(siblings, [ids.text, ids.heading]);
  await dragComponent(ids.heading, ids.text);
  siblings = (await layoutValue()).components.filter(item => item.parent === ids.card).map(item => item.id);
  assert.deepEqual(siblings, [ids.heading, ids.text]);
  await chooseComponent(ids.card);
  const beforeCopy = (await layoutValue()).components;
  await page.locator('#builder-duplicate-component').click();
  let components = (await layoutValue()).components;
  const copied = components.filter(item => !beforeCopy.some(previous => previous.id === item.id));
  assert.equal(copied.length, 3, '复制卡片必须复制整个子树');
  const copiedCard = copied.find(item => item.type === 'card');
  assert.ok(copiedCard); assert.equal(copied.filter(item => item.parent === copiedCard.id).length, 2);
  await editComponent(copiedCard.id, { page: secondPage, parent: '' });
  components = (await layoutValue()).components;
  for (const child of copied) assert.equal(components.find(item => item.id === child.id).page, secondPage);
  assert.equal(await page.locator(`[data-builder-page="${secondPage}"] [data-builder-id="${copiedCard.id}"]`).count(), 1);
  await gotoInEditor(firstPage);
  pass('组件上下移动及拖拽改变同级顺序，复制卡片保留子树关系，跨菜单移动更新全部后代');

  const pendingId = await addComponent('button', firstPage);
  await editComponent(pendingId, { label: '未来运行任务', action: 'pending', 'action-note': '后续根据此按钮实现通知整理后端' });
  await page.locator(`[data-builder-id="${ids.button}"] .builder-component-surface > button`).click();
  assert.equal(await page.evaluate(() => window.QQServiceNavigation.currentPage()), firstPage);
  assert.deepEqual(posts, []);
  await page.locator('#designer-preview-mode').click();
  await page.locator(`[data-builder-id="${pendingId}"] .builder-component-surface > button`).click();
  assert.deepEqual(posts, []);
  assert.equal(await page.locator('#builder-action-notice').isVisible(), true);
  await page.locator('#builder-action-notice button').click();
  const input = page.locator(`[data-builder-id="${ids.input}"] input`);
  const textarea = page.locator(`[data-builder-id="${ids.textarea}"] textarea`);
  const select = page.locator(`[data-builder-id="${ids.select}"] select`);
  await input.fill('QA_PRIVATE_PREVIEW_INPUT'); await textarea.fill('QA_PRIVATE_PREVIEW_NOTES');
  const option = await select.locator('option').nth(1).getAttribute('value'); await select.selectOption(option);
  await page.locator(`[data-builder-id="${ids.switch}"] input`).check();
  await delay(4700);
  assert.equal(await page.locator('#runtime-badge').isVisible(), false, '自建页面在运行状态轮询后不应显示账号状态徽章');
  assert.equal(await input.inputValue(), 'QA_PRIVATE_PREVIEW_INPUT');
  assert.equal(await textarea.inputValue(), 'QA_PRIVATE_PREVIEW_NOTES');
  assert.equal(await select.inputValue(), option);
  assert.equal(await page.locator(`[data-builder-id="${ids.switch}"] input`).isChecked(), true);
  const temporaryValues = ['QA_PRIVATE_PREVIEW_INPUT', 'QA_PRIVATE_PREVIEW_NOTES'];
  for (const value of temporaryValues) assert.equal(JSON.stringify(await documentValue()).includes(value), false);
  await page.locator(`[data-builder-id="${ids.button}"] .builder-component-surface > button`).click();
  await until(() => page.evaluate(id => window.QQServiceNavigation.currentPage() === id, secondPage), '预览按钮未跳转');
  await page.locator('#designer-edit-mode').click(); await gotoInEditor(firstPage);
  assert.equal((await state()).applied.permissions.released, permissionBefore);
  assert.deepEqual(posts, []); assert.equal(sent.length, 0);
  pass('编辑点击不会执行按钮，预览仅执行声明式跳转；待实现动作不调用后端，输入与选择在轮询后保留且不写入导出');

  const beforeDelete = await documentValue();
  await page.locator(`[data-builder-menu-row="${secondPage}"] [data-builder-menu-action="delete"]`).click();
  let afterDelete = await documentValue();
  assert.equal(afterDelete.layout.pages.some(item => item.id === secondPage), false);
  assert.equal(afterDelete.layout.components.some(item => item.page === secondPage), false);
  assert.deepEqual(afterDelete.layout.components.find(item => item.id === ids.button).action, { type: 'none' });
  await page.locator('#designer-undo').click(); assert.deepEqual(await documentValue(), beforeDelete);
  await page.locator('#designer-redo').click(); assert.deepEqual(await documentValue(), afterDelete);
  await page.locator('#designer-undo').click(); assert.deepEqual(await documentValue(), beforeDelete);
  await gotoInEditor(firstPage);
  await chooseComponent(ids.divider); await page.locator('#builder-delete-component').click();
  assert.equal((await layoutValue()).components.some(item => item.id === ids.divider), false);
  await page.locator('#designer-undo').click(); assert.deepEqual(await documentValue(), beforeDelete);
  pass('删除菜单同时清理其组件和入站跳转，撤销与重做完整恢复引用；组件删除同样可撤销');

  const exported = await documentValue();
  for (const secret of ['DESIGNER_PRIVATE_ACCOUNT_NAME', '12345001', '98765001', 'DESIGNER_PRIVATE_GROUP_NAME', 'DESIGNER_PRIVATE_PERSONA', 'DESIGNER_SAVED_API_SECRET', 'DESIGNER_SAVED_ONEBOT_TOKEN', account.id]) assert.equal(JSON.stringify(exported).includes(secret), false, secret);
  const invalidDocuments = [];
  const invalid = mutate => { const doc = structuredClone(exported); mutate(doc); invalidDocuments.push(doc); };
  invalid(doc => { doc.layout.pages[0].title = '<img src=x onerror=alert(1)>'; });
  invalid(doc => { doc.layout.components[0].html = '<script>alert(1)</script>'; });
  invalid(doc => { doc.layout.components[0].styles = { backgroundColor: 'url(https://example.com/track)' }; });
  invalid(doc => { doc.layout.components[0].styles = { position: 'fixed' }; });
  invalid(doc => { doc.layout.components[0].action = { type: 'script', code: 'fetch("/api/accounts")' }; });
  invalid(doc => { doc.layout.navigation.push('unknown-page'); });
  invalid(doc => { doc.layout.navigation[1] = doc.layout.navigation[0]; });
  invalid(doc => { doc.layout.components[0].parent = ids.input; });
  invalid(doc => { doc.layout.components.find(item => item.id === ids.card).parent = ids.card; });
  invalid(doc => { doc.layout.components.find(item => item.id === ids.heading).page = secondPage; });
  invalid(doc => { doc.layout.components.find(item => item.id === ids.button).action = { type: 'navigate', target: 'missing-page' }; });
  invalid(doc => { doc.layout.components[0].value = 'should never persist an input value'; });
  invalidDocuments.push(JSON.parse(JSON.stringify(exported).replace('"layout":{', '"layout":{"__proto__":{"polluted":true},')));
  for (const doc of invalidDocuments) { await rejectImport(doc); await rejectNative(doc); }
  assert.equal(await page.evaluate(() => ({}).polluted), undefined);
  assert.deepEqual(await documentValue(), exported);
  pass('导入与原生 IPC 同时拒绝 HTML、脚本、任意CSS、非法动作、未知属性、原型污染及循环或跨页父子图，失败保留原配置');

  await page.evaluate(value => window.QQServiceDesigner.importDocument(value), ORIGINAL_DESIGN);
  assert.deepEqual(await documentValue(), { version: 1, edits: [] });
  assert.equal(await page.locator('.nav-link[data-page^="custom-"]').count(), 0);
  assert.equal(await page.evaluate(() => window.QQServiceNavigation.currentPage()), 'overview');
  assert.equal(await page.locator('#page-overview').isVisible(), true);
  await until(async () => await page.locator('#runtime-badge').isVisible(), '回到总览后应恢复真实运行状态徽章');
  await page.locator('#designer-undo').click(); assert.deepEqual(await documentValue(), exported);
  const exportFile = path.join(fixture, 'builder-export.json');
  await electron.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, exportFile);
  await page.locator('#designer-export').click(); await until(() => fs.existsSync(exportFile), '原生 v2 导出未创建');
  assert.deepEqual(JSON.parse(fs.readFileSync(exportFile, 'utf8')), exported);
  await gotoInEditor(firstPage);
  await page.locator('#designer-reset-all').click();
  assert.deepEqual(await documentValue(), { version: 1, edits: [] });
  assert.equal(await page.evaluate(() => window.QQServiceNavigation.currentPage()), 'overview');
  assert.equal(await page.locator('#page-overview').isVisible(), true);
  await page.locator('#designer-import').setInputFiles({ name: 'builder-layout.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
  await until(async () => JSON.stringify(await documentValue()) === JSON.stringify(exported), 'v2 实际文件导入未恢复');
  await saved(); await gotoInEditor(firstPage);
  if (await page.locator('#designer-view-builder').count()) await page.locator('#designer-view-builder').click();
  await page.locator('#designer-root .designer-scroll').evaluate(node => { node.scrollTop = 0; });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '/tmp/qq-service-builder-editor.png', fullPage: false });
  pass('v1 导入移除 v2 自建页面且支持撤销；原生 v2 JSON 导出及真实文件导入完整往返，不包含业务资料');

  await closeEditor(); await saved();
  const exiting = once(electron.process(), 'exit'); await electron.evaluate(({ app }) => app.quit()); await exiting; electron = null;
  const secondUrl = await launch(firstPage); assert.notEqual(new URL(firstUrl).port, new URL(secondUrl).port);
  assert.deepEqual(await page.evaluate(() => window.qqBridgeDesktop.getUiDesign()), exported);
  await until(() => page.evaluate(id => window.QQServiceNavigation.currentPage() === id, firstPage), '冷启动自建菜单 hash 未恢复');
  assert.equal(new URL(page.url()).hash, `#${firstPage}`);
  assert.equal(await page.locator(`[data-builder-page="${firstPage}"] [data-builder-id="${ids.heading}"]`).innerText(), 'QA 布局标题');
  assert.equal(await page.locator(`[data-builder-id="${ids.input}"] input`).inputValue(), '');
  assert.equal(await page.locator(`[data-builder-id="${ids.textarea}"] textarea`).inputValue(), '');
  assert.equal(await page.locator('#runtime-badge').isVisible(), false, '冷启动自建页面不应显示账号状态徽章');
  await page.screenshot({ path: '/tmp/qq-service-builder-preview.png', fullPage: false });
  pass('完全退出并更换端口后 v2 布局原生持久保存，冷加载自建菜单 hash 正确恢复，临时输入未落盘');
  assert.deepEqual(errors, []); assert.equal(sent.length, 0);
  console.log(`页面搭建设计器真实 Electron 验证通过：${checks.length} 项。未调用真实 QQ 或付费模型。`);
 } catch (error) {
  if (page) console.error('VISIBLE', (await page.locator('body').innerText().catch(() => '')).slice(0, 14000));
  console.error(error.stack || error.message); process.exitCode = 1;
 } finally {
  if (electron) await electron.close().catch(() => {});
  if (app) await app.close();
  if (qq) { for (const peer of peers) peer.terminate(); await new Promise(resolve => qq.close(resolve)); }
  fs.rmSync(fixture, { recursive: true, force: true });
 }
})();

