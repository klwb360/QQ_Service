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
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-service-designer-qa-'));
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
async function launch() {
  const npm = path.join(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
  assert.ok(fs.existsSync(npm));
  electron = await _electron.launch({ executablePath: process.env.ELECTRON_EXECUTABLE || path.join(project, 'node_modules', 'electron', 'dist', 'electron'), args: ['--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`, project], env: {
    ...process.env, QQBRIDGE_NODE_RUNTIME: process.execPath, QQ_DASHBOARD_NPM_CLI: npm,
    QQ_DASHBOARD_DATA_DIR: dataDir, XDG_CONFIG_HOME: path.join(fixture, 'config'), XDG_CACHE_HOME: path.join(fixture, 'cache'),
  }, timeout: 30000 });
  page = await electron.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => document.querySelector('#server-label')?.textContent === '管理服务可访问' && Boolean(window.QQServiceDesigner));
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
  const rejected = await page.evaluate(async input => {
    try { await window.QQServiceDesigner.importDocument(input); return false; } catch { return true; }
  }, value);
  assert.equal(rejected, true, JSON.stringify(value));
  assert.equal(JSON.stringify(await documentValue()), before);
}

async function assertBaseline() {
  for (const key of RETIRED) assert.equal(await page.locator(`[data-ui-key="${key}"]`).count(), 0, `已删除元素仍在 DOM: ${key}`);
  assert.equal(await page.locator('.connection-route-tabs').count(), 0);
  assert.equal((await page.locator('.nav-link[data-page="overview"]').innerText()).replace(/^▦\s*/, '').trim(), '仪表盘');
  for (const [name, label] of Object.entries({ connections: '账号', scenarios: '权限', modules: '模块', records: '日志', settings: '设置' })) assert.equal((await page.locator(`.nav-link[data-page="${name}"]`).innerText()).slice(1).trim(), label);
  assert.equal((await page.locator('.connection-settings h3').innerText()).trim(), 'NapCat 的连接信息');
  assert.equal(await page.locator('#connection-native-guide .connection-instructions li strong').count(), 3);
  for (const selector of ['[data-config="qq.wsUrl"]', '[data-secret="napcatToken"]', '[data-setup-connect]', '#setup-connection-badge']) assert.equal(await page.locator(selector).count(), 1, `业务连接控件消失: ${selector}`);
}

async function selectedElement() {
  return page.evaluate(() => {
    const key = document.querySelector('#designer-target-key')?.textContent;
    const target = [...document.querySelectorAll('[data-ui-key]')].find(el => el.dataset.uiKey === key);
    return target ? { key, tag: target.tagName, classes: target.className } : null;
  });
}

async function selectParentUntil(predicate) {
  for (let count = 0; count < 8; count++) {
    const value = await selectedElement();
    if (value && predicate(value)) return value;
    assert.equal(await page.locator('#designer-select-parent').isEnabled(), true, '父级选择在目标容器之前停止');
    await page.locator('#designer-select-parent').click();
  }
  throw new Error('未能选择预期父级容器');
}
(async () => {
 try {
  await seed(); const firstUrl = await launch();
  await assertBaseline();
  assert.equal((await page.locator('#page-title').innerText()).trim(), '仪表盘');
  await page.screenshot({ path: '/tmp/qq-service-advanced-overview.png', fullPage: false });
  await page.locator('[data-page="records"]').click();
  assert.equal(await page.locator('#page-title').isVisible(), false);
  assert.equal(await page.locator('#page-description').isVisible(), false);
  const recordsGeometry = await page.evaluate(() => {
    const heading = document.querySelector('.page-heading').getBoundingClientRect();
    const panel = document.querySelector('#page-records').getBoundingClientRect();
    const context = document.querySelector('.config-bar').getBoundingClientRect();
    return { headingHeight: heading.height, gap: panel.top - context.bottom };
  });
  assert.ok(recordsGeometry.headingHeight < 70, JSON.stringify(recordsGeometry));
  assert.ok(recordsGeometry.gap < 90, JSON.stringify(recordsGeometry));
  pass('用户删除项已从实际 DOM 移除，侧栏及 NapCat 文案已写入源码，日志页无空标题占位');

  await page.evaluate(value => window.QQServiceDesigner.importDocument(value), ORIGINAL_DESIGN);
  assert.deepEqual(await documentValue(), { version: 1, edits: [] });
  await assertBaseline();
  await page.evaluate(() => window.QQServiceDesigner.reset());
  await assertBaseline();
  pass('原始18条旧编辑可成功导入并消解为新默认界面；全部恢复也不会复活已删内容');

  await selectAccount();
  await page.locator('[data-setup-panel="connection"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/qq-service-advanced-connection.png', fullPage: false });
  await page.locator('[data-secret="deepseekApiKey"]').fill('DESIGNER_UNSAVED_API_SECRET');
  const beforeEditing = await state(); assert.equal(beforeEditing.applied.permissions.released, true);
  const posts = [];
  await page.route('**/api/**', route => {
    if (route.request().method() === 'POST') { posts.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  await enter();
  for (const selector of ['[data-setup-connect]', '[data-setup-model-test="deepseek"]', '[data-setup-start]']) {
    await page.locator(selector).click();
    assert.equal(await page.locator('#app-dialog').evaluate(dialog => dialog.open), false);
  }
  await page.locator('#account-llm-source').click();
  await page.locator('#account-llm-source').focus();
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#account-llm-source').inputValue(), 'deepseek');
  await delay(200); assert.deepEqual(posts, []);
  assert.equal((await state()).applied.permissions.released, true);
  assert.equal(sent.length, 0);
  pass('编辑模式点击连接、付费测试、授权按钮和模型下拉键盘操作均不触发业务或权限改变');

  await page.locator('#designer-page').selectOption('scenarios');
  const paired = page.locator('#scenario-tasks .two-columns');
  const summaryCard = paired.locator(':scope > .card').first();
  const favoriteCard = paired.locator(':scope > .card').nth(1);
  const summaryGrid = summaryCard.locator('.form-grid');
  const retention = summaryGrid.locator('[data-config="summary.retentionDays"]').locator('..');
  const timeField = summaryGrid.locator('[data-config="summary.time"]').locator('..');
  await retention.click({ position: { x: 7, y: 7 } });
  await selectParentUntil(value => value.tag === 'LABEL' && value.classes.split(/\s+/).includes('field'));
  await page.locator('#designer-hidden').check(); await page.locator('#designer-apply').click();
  assert.equal(await retention.isVisible(), false);
  await until(async () => await timeField.evaluate(element => element.getBoundingClientRect().width / element.parentElement.getBoundingClientRect().width) > .97, '表单隐藏一项后末行没有补满空白');
  await page.locator('#designer-undo').click();
  assert.equal(await retention.isVisible(), true);
  assert.ok(await timeField.evaluate(element => element.getBoundingClientRect().width / element.parentElement.getBoundingClientRect().width) < .6);
  await summaryCard.locator('h2').click();
  const selectedCard = await selectParentUntil(value => value.tag === 'SECTION' && value.classes.split(/\s+/).includes('card'));
  assert.ok(selectedCard.key);
  assert.ok(await page.locator('#designer-breadcrumb button').count() >= 2);
  await page.locator('#designer-hidden').check(); await page.locator('#designer-apply').click();
  assert.equal(await summaryCard.isVisible(), false);
  await until(async () => {
    const ratio = await favoriteCard.evaluate(element => element.getBoundingClientRect().width / element.parentElement.getBoundingClientRect().width);
    return ratio > .97;
  }, '隐藏左卡后右卡没有填满双列网格');
  await page.locator('#designer-undo').click();
  assert.equal(await summaryCard.isVisible(), true);
  assert.ok(await favoriteCard.evaluate(element => element.getBoundingClientRect().width / element.parentElement.getBoundingClientRect().width) < .6);
  await page.locator('#designer-redo').click(); assert.equal(await summaryCard.isVisible(), false);
  await page.locator('#designer-undo').click();
  await page.locator('#designer-page').selectOption('connections');
  assert.deepEqual(posts, []);
  pass('逐层选择父级可隐藏表单项或整卡，末行及剩余卡自动填满空白，撤销与重做恢复布局');

  await changeText('#refresh-state', 'QA 自定义刷新');
  assert.equal((await page.locator('#refresh-state').innerText()).trim(), 'QA 自定义刷新');
  await page.locator('#designer-style-color').fill('#123456');
  await page.locator('#designer-style-fontSize').fill('19px');
  await page.locator('#designer-style-padding').fill('8px 12px');
  await page.locator('#designer-apply').click();
  assert.deepEqual(await page.locator('#refresh-state').evaluate(button => ({ color: getComputedStyle(button).color, fontSize: getComputedStyle(button).fontSize })), { color: 'rgb(18, 52, 86)', fontSize: '19px' });
  await page.locator('#designer-hidden').check(); await page.locator('#designer-apply').click();
  assert.equal(await page.locator('#refresh-state').isVisible(), false);
  await page.locator('#designer-undo').click(); assert.equal(await page.locator('#refresh-state').isVisible(), true);
  await page.locator('#designer-redo').click(); assert.equal(await page.locator('#refresh-state').isVisible(), false);
  await page.locator('#designer-undo').click();
  await page.locator('#designer-reset-element').click();
  assert.notEqual((await page.locator('#refresh-state').innerText()).trim(), 'QA 自定义刷新');
  await page.locator('#designer-undo').click();
  await delay(4500); assert.equal((await page.locator('#refresh-state').innerText()).trim(), 'QA 自定义刷新');
  assert.deepEqual(posts, []);
  await page.screenshot({ path: '/tmp/qq-service-advanced-editor-preview.png', fullPage: false });
  pass('按钮文字、颜色、字号和显隐可修改、撤销、重做及恢复，后台轮询保留修改且不触发业务');

  await page.locator('#account-llm-source').click();
  await page.locator('#designer-option-value').selectOption('deepseek');
  await page.locator('#designer-option-label').fill('QA 当前账号模型');
  await page.locator('#designer-apply').click();
  assert.equal(await page.locator('#account-llm-source').inputValue(), 'deepseek');
  await delay(4500);
  await until(async () => await page.locator('#account-llm-source option[value="deepseek"]').innerText() === 'QA 当前账号模型', '账号模型显示名称未在轮询后保留');
  await page.locator('#designer-page').selectOption('overview');
  await changeText('[data-ui-key="overview.statLabel.accounts"]', 'QA 所有账号');
  await page.locator('#designer-style-color').fill('#346712');
  await page.locator('#designer-apply').click();
  await delay(4500);
  await until(async () => await page.locator('[data-ui-key="overview.statLabel.accounts"]').innerText() === 'QA 所有账号', '动态卡片重建后丢失显示修改');
  assert.equal(await page.locator('[data-ui-key="overview.statLabel.accounts"]').evaluate(element => getComputedStyle(element).color), 'rgb(52, 103, 18)');
  assert.equal(await page.locator('#overview-stats .stat-value').first().innerText(), '1');
  await page.locator('#designer-page').selectOption('connections');
  pass('动态模型选项及总览卡片重建后仍保留文字和样式，业务值及真实账号统计不被覆盖');

  await closeEditor();
  await page.locator('#create-account-entry').click();
  await enter();
  const sourceValues = await page.locator('#new-account-llm-source option').evaluateAll(options => options.map(option => option.value));
  await page.locator('#new-account-llm-source').click();
  await page.locator('#designer-option-value').selectOption('deepseek');
  await page.locator('#designer-option-label').fill('QA 自定义模型名称');
  await page.locator('#designer-apply').click();
  assert.equal(await page.locator('#new-account-llm-source option[value="deepseek"]').innerText(), 'QA 自定义模型名称');
  assert.equal(await page.locator('#new-account-llm-source').inputValue(), '');
  assert.deepEqual(await page.locator('#new-account-llm-source option').evaluateAll(options => options.map(option => option.value)), sourceValues);
  await closeEditor();
  await page.locator('#new-account-llm-source').selectOption('deepseek');
  assert.equal(await page.locator('#new-account-llm-source').inputValue(), 'deepseek');
  await enter();
  pass('模型下拉可修改选项显示文字，底层value集合及选中值在编辑时不变，正常预览仍能选用模型');

  const exported = await documentValue();
  for (const secret of ['DESIGNER_PRIVATE_ACCOUNT_NAME','12345001','98765001','DESIGNER_PRIVATE_GROUP_NAME','DESIGNER_PRIVATE_PERSONA','DESIGNER_SAVED_API_SECRET','DESIGNER_SAVED_ONEBOT_TOKEN','DESIGNER_UNSAVED_API_SECRET', account.id]) assert.equal(JSON.stringify(exported).includes(secret), false, secret);
  pass('界面修改文档不包含账号、群、运行参数或已保存及未保存密钥');

  await page.locator('#designer-reset-all').click();
  assert.deepEqual(await documentValue(), { version: 1, edits: [] });
  await page.locator('#designer-import').setInputFiles({ name: 'qa-design.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
  await until(async () => JSON.stringify(await documentValue()) === JSON.stringify(exported), '有效界面JSON导入未恢复修改');
  assert.equal((await page.locator('#refresh-state').innerText()).trim(), 'QA 自定义刷新');
  assert.equal(await page.locator('#new-account-llm-source option[value="deepseek"]').innerText(), 'QA 自定义模型名称');
  await assertBaseline();
  pass('全部恢复保留新默认界面，可通过实际文件导入重新应用后续纯展示修改');

  const target = exported.edits.find(edit => edit.text === 'QA 自定义刷新').selector;
  for (const invalid of [
    {version:1, edits:[{selector:'body',text:'bad'}]},
    {version:1, edits:[{selector:target,text:'<script>alert(1)</script>'}]},
    {version:1, edits:[{selector:target,html:'<img src=x onerror=alert(1)>'}]},
    {version:1, edits:[{selector:target,styles:{backgroundColor:'url(https://example.com/track)'}}]},
    {version:1, edits:[{selector:target,styles:{position:'fixed'}}]},
    {version:1, edits:[{selector:'[data-ui-key="does.not.exist"]',text:'unknown'}]},
    {version:1, edits:[{selector:'[data-ui-key="account.createLlmSource"]',optionLabels:[{value:'injected-model',label:'bad'}]}]},
  ]) await rejectImport(invalid);
  for (const invalid of [
    {version:1, edits:[{selector:'body',text:'bad'}]},
    {version:1, edits:[{selector:target,styles:{backgroundColor:'url(https://example.com/track)'}}]},
    {version:1, edits:[{selector:target,text:'<script>alert(1)</script>'}]},
  ]) assert.equal(await page.evaluate(async doc => {try {await window.qqBridgeDesktop.saveUiDesign(doc);return false;}catch{return true;}}, invalid), true);
  assert.equal(JSON.stringify(await documentValue()), JSON.stringify(exported));
  pass('导入与原生 IPC 拒绝脚本、HTML、URL样式、任意CSS及非法选择器，失败不覆盖已有修改');

  await saved();
  const file = path.join(fixture, 'design-export.json');
  await electron.evaluate(({dialog}, filePath) => {dialog.showSaveDialog=async()=>({canceled:false,filePath});}, file);
  await page.locator('#designer-export').click(); await until(()=>fs.existsSync(file),'原生界面导出未写文件');
  assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')), await documentValue());
  await closeEditor();
  let refreshGets = 0;
  page.on('request', request => {if(request.method()==='GET'&&request.url().endsWith('/api/accounts'))refreshGets++;});
  await page.locator('#refresh-state').click(); await until(()=>refreshGets>0,'正常预览的刷新功能被编辑器阻断');
  pass('原生导出得到纯界面JSON，退出编辑后原有按钮正常执行');

  await saved();
  const exiting = once(electron.process(),'exit'); await electron.evaluate(({app})=>app.quit()); await exiting; electron=null;
  const secondUrl = await launch(); assert.notEqual(new URL(firstUrl).port,new URL(secondUrl).port);
  assert.equal((await page.locator('#refresh-state').innerText()).trim(),'QA 自定义刷新');
  assert.equal(await page.locator('[data-ui-key="overview.statLabel.accounts"]').innerText(),'QA 所有账号');
  assert.equal(await page.locator('#account-llm-source option[value="deepseek"]').innerText(),'QA 当前账号模型');
  assert.deepEqual(await page.evaluate(()=>window.qqBridgeDesktop.getUiDesign()),exported);
  pass('完全退出后换随机端口重新启动，原生界面修改仍保存且自动恢复');
  await assertBaseline();
  assert.deepEqual(errors,[]); console.log(`进阶设计器真实 Electron 验证通过：${checks.length} 项。未调用真实模型或 QQ。`);
 } catch(error) {
  if(page) console.error('VISIBLE', (await page.locator('body').innerText().catch(()=>'' )).slice(0,12000));
  console.error(error.stack||error.message);process.exitCode=1;
 } finally {
  if(electron)await electron.close().catch(()=>{});
  if(app)await app.close();
  if(qq){for(const peer of peers)peer.terminate();await new Promise(resolve=>qq.close(resolve));}
  fs.rmSync(fixture,{recursive:true,force:true});
 }
})();
