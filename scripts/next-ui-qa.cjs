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
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-service-next-ui-qa-'));
const dataDir = path.join(fixture, 'data');
const profile = path.join(fixture, 'electron-profile');
const checks = [], errors = [], sent = [], peers = new Set();
let electron, app, qq, page, account, secondAccount;
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
      if (p.action === 'get_group_list') data = [{ group_id: 98765001, group_name: 'QA_PRIVATE_GROUP_NAME' }];
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
  const created = await post('/api/accounts', { name: 'QA_PRIVATE_ACCOUNT_NAME', platform: 'qq', qqNumber: '12345001' });
  account = created.account;
  secondAccount = (await post('/api/accounts', { name: 'QA_SECOND_ACCOUNT', platform: 'qq', qqNumber: '12345002' })).account;
  const config = created.state.draft;
  config.qq.enabled = true; config.qq.wsUrl = `ws://127.0.0.1:${qq.address().port}`;
  config.models.deepseek.enabled = true; config.chat.enabled = true; config.summary.enabled = true;
  config.chat.persona = 'QA_PRIVATE_PERSONA';
  config.groups = [{ id: '98765001', name: 'QA_PRIVATE_GROUP_NAME', mode: 'social', read: true, send: false, triggers: ['mention'], trigger: 'mention', prefix: '/ai', probability: .03, cooldownSeconds: 30 }];
  const saved = await post(`/api/accounts/${account.id}/config/save`, { config, secretUpdates: { deepseekApiKey: 'QA_SAVED_API_SECRET', napcatToken: 'QA_SAVED_ONEBOT_TOKEN' } });
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
  await page.waitForFunction(() => document.querySelector('#server-label')?.textContent === '管理服务可访问');
  return page.url();
}
async function selectAccount() {
  await page.locator('[data-page="connections"]').click();
  const header = page.locator(`[data-open-account="${account.id}"]`);
  if (await header.getAttribute('aria-expanded') !== 'true') await header.click();
  await until(async () => await page.locator('#account-workspace').isVisible(), '账号未展开');
}
async function stateOf(id) { return page.evaluate(id => fetch(`/api/accounts/${id}/state`).then(r => r.json()), id); }
async function switchAccount(id) {
  // A modal normally prevents user clicks underneath. This deliberately changes
  // the selection while a confirmation/request is pending to test async scoping.
  await page.evaluate(id => {
    const select = document.querySelector('#account-selector');
    select.value = id; select.dispatchEvent(new Event('change', { bubbles: true }));
  }, id);
  await until(async () => await page.locator('#account-selector').inputValue() === id, '账号切换未完成');
  await delay(180);
}
async function navigate(id) { await page.locator(`.nav-link[data-page="${id}"]`).click(); }
async function rect(selector) { return page.locator(selector).evaluate(node => { const r = node.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom }; }); }
async function screenshot(name) { await page.screenshot({ path: `/tmp/qq-service-next-${name}.png`, fullPage:false }); }
(async () => {
 try {
  await seed(); await launch();
  await page.setViewportSize({ width:1400, height:1050 });
  await switchAccount(account.id);
  assert.equal(await page.locator('#frontend-editor-toggle, #designer-root').count(), 0);
  assert.equal(await page.evaluate(() => Boolean(window.QQServiceDesigner || window.QQServiceBuilder)), false);
  pass('正式界面保留已确定布局，移除编辑器与搭建入口');

  await navigate('records');
  assert.deepEqual(await page.locator('#page-records [data-record-tab]').evaluateAll(nodes => nodes.map(node => node.dataset.recordTab)), ['tasks','logs']);
  assert.equal(await page.locator('.config-bar').isVisible(), false);
  assert.equal(await page.locator('#records-account-notice').count(), 0);
  assert.equal(await page.locator('#records-context-card > .account-context').count(), 1);
  assert.equal(await page.locator('#records-context-card > #record-tasks').count(), 1);
  const logsGeometry = await page.evaluate(() => {
    const card=document.querySelector('#records-context-card'), context=card.querySelector('.account-context'), tasks=card.querySelector('#record-tasks');
    const c=card.getBoundingClientRect(), a=context.getBoundingClientRect(), t=tasks.getBoundingClientRect();
    return { contained:a.left>=c.left&&a.right<=c.right&&t.left>=c.left&&t.right<=c.right&&t.bottom<=c.bottom,
      outerBorder:parseFloat(getComputedStyle(card).borderTopWidth), innerBorder:parseFloat(getComputedStyle(tasks).borderTopWidth),
      contextBorder:parseFloat(getComputedStyle(context).borderLeftWidth), cardCount:card.querySelectorAll('.card').length };
  });
  assert.ok(logsGeometry.contained, JSON.stringify(logsGeometry));
  assert.equal(logsGeometry.outerBorder, 1); assert.equal(logsGeometry.innerBorder, 0); assert.equal(logsGeometry.contextBorder, 0); assert.equal(logsGeometry.cardCount, 0);
  assert.equal((await page.locator('#save-draft').innerText()).trim(), '保存');
  assert.equal((await page.locator('#config-label').textContent()).includes('草稿'), false);
  await screenshot('logs');
  await page.locator('[data-record-tab="logs"]').click(); assert.equal(await page.locator('#record-logs').isVisible(), true);
  await navigate('modules');
  for (const key of ['fyuaton','mxolnpy','ltkdbmq','nmorcsj']) assert.equal(await page.locator(`[data-ui-key="ui-auto-${key}"]`).count(), 0);
  for (const selector of ['#module-jobs','#export-config','#rollback-config']) assert.equal(await page.locator(selector).count(), 0);
  assert.equal(await page.locator('#page-title').isVisible(), false); assert.equal(await page.locator('#page-description').isVisible(), false);
  assert.equal(await page.locator('#reset-account-defaults').isVisible(), true);
  await screenshot('modules');
  await navigate('settings');
  const options = page.locator('.settings-options > label');
  const left=await options.nth(0).boundingBox(), right=await options.nth(1).boundingBox();
  assert.ok(Math.abs(left.y-right.y)<2 && right.x>left.x+left.width, JSON.stringify({left,right}));
  assert.ok((await rect('#window-settings-card')).height < 360, '设置父容器仍有不必要的纵向占位');
  await screenshot('settings');
  await page.setViewportSize({width:600,height:900});
  const mobileTop=await options.nth(0).boundingBox(), mobileBottom=await options.nth(1).boundingBox();
  assert.ok(mobileBottom.y>=mobileTop.y+mobileTop.height, JSON.stringify({mobileTop,mobileBottom}));
  await screenshot('settings-mobile');
  await page.setViewportSize({width:1400,height:1050});
  pass('日志账号选择与任务记录合为单边框容器；冗余容器及模块页旧卡已删除；设置双列紧凑且小屏自动上下排列');

  await navigate('modules'); await switchAccount(account.id);
  const original=await stateOf(account.id), otherBefore=await stateOf(secondAccount.id);
  assert.equal(original.applied.permissions.released, true);
  await page.locator('#reset-account-defaults').click(); await page.locator('#app-dialog[open]').waitFor();
  assert.equal((await page.locator('#dialog-content').textContent()).includes('密钥'), true);
  await switchAccount(secondAccount.id);
  await page.locator('#dialog-confirm').click();
  await until(async () => (await stateOf(account.id)).revision>original.revision, '还原未保存原确认账号');
  const reset=await stateOf(account.id), otherAfter=await stateOf(secondAccount.id);
  for(const key of ['botQQ','ownerQQ','qq','models']) assert.deepEqual(reset.draft[key],original.draft[key],key);
  assert.deepEqual(reset.secrets,original.secrets); assert.deepEqual(reset.applied,original.applied);
  assert.equal(reset.applied.permissions.released,true); assert.equal(reset.draft.permissions.released,false);
  assert.equal(reset.draft.chat.enabled,false); assert.equal(reset.draft.summary.enabled,false); assert.equal(reset.draft.favorites.enabled,false); assert.deepEqual(reset.draft.groups,[]);
  assert.equal(reset.pendingChanges,true); assert.deepEqual(otherAfter.draft,otherBefore.draft); assert.equal(otherAfter.revision,otherBefore.revision);
  assert.equal(await page.locator('#account-selector').inputValue(),secondAccount.id);
  await switchAccount(account.id); assert.equal((await page.locator('#config-label').innerText()).trim(),'此账号已保存，等待应用');
  pass('还原默认只保存当前确认账号的功能配置，保留身份、连接、模型及密钥；确认期间切换账号不会改错账号，已运行权限待应用前保持原状');

  // Hold the second reset response while switching accounts and changing the
  // newly selected account. A late response must never replace those inputs.
  let heldRoute, releaseRoute;
  const arrived = new Promise(resolve => { heldRoute=resolve; });
  const release = new Promise(resolve => { releaseRoute=resolve; });
  await page.route('**/config/reset-defaults',async route => { heldRoute(); await release; await route.continue(); });
  await page.locator('#reset-account-defaults').click(); await page.locator('#dialog-confirm').click(); await arrived;
  await switchAccount(secondAccount.id); await navigate('connections');
  const secondHeader=page.locator(`[data-open-account="${secondAccount.id}"]`);
  if(await secondHeader.getAttribute('aria-expanded')!=='true') await secondHeader.click();
  await page.locator('[data-config="botQQ"]').fill('12345003');
  releaseRoute();
  await until(async () => (await stateOf(account.id)).revision>reset.revision,'延迟还原响应未完成');
  await delay(250);
  assert.equal(await page.locator('[data-config="botQQ"]').inputValue(),'12345003');
  assert.deepEqual((await stateOf(secondAccount.id)).draft,otherBefore.draft);
  await page.unroute('**/config/reset-defaults');
  await navigate('modules'); await switchAccount(account.id);
  await page.locator('#apply-config').click();
  await until(async () => !(await stateOf(account.id)).applied.permissions.released,'应用默认后未恢复只读');
  const appliedReset=await stateOf(account.id); assert.equal(appliedReset.applied.chat.enabled,false); assert.deepEqual(appliedReset.applied.groups,[]);
  pass('延迟还原响应保留另一个账号尚未保存的输入；随后明确应用默认参数才恢复只读并停用功能');

  await navigate('connections'); await switchAccount(secondAccount.id);
  const flowHeader=page.locator(`[data-open-account="${secondAccount.id}"]`);
  if(await flowHeader.getAttribute('aria-expanded')!=='true')await flowHeader.click();
  const oldContinue=page.locator('[data-flow-stage="identity"] .setup-continue-button');
  assert.equal(await oldContinue.getAttribute('data-continue-active'),'true');
  await page.evaluate(()=>{const original=Element.prototype.animate;window.qaAnimationFrames=[];Element.prototype.animate=function(frames,options){window.qaAnimationFrames.push({key:this.dataset.uiKey,actions:this.dataset.flowActions,frames,options});return original.call(this,frames,options);};});
  await oldContinue.click();
  await until(async()=>await page.locator('[data-flow-stage="connection"] .setup-continue-button').getAttribute('data-continue-active')==='true','下一阶段继续按钮未启用');
  assert.equal(await oldContinue.isDisabled(),true);
  await until(async()=>!(await oldContinue.isVisible()),'上一继续按钮未淡出');
  assert.equal(await page.locator('.setup-continue-button[data-continue-active="true"]').count(),1);
  assert.ok(await page.evaluate(()=>window.qaAnimationFrames.some(entry=>entry.actions==='identity'&&entry.frames.at(-1).height==='0px')),'上一阶段整组按钮未执行收回动画');
  await page.locator('[data-config="botQQ"]').fill('12345004');
  assert.equal(await oldContinue.getAttribute('data-continue-active'),'false');
  await page.locator('[data-flow-actions="connection"] [data-setup-back="identity"]').click();
  await until(async()=>await oldContinue.getAttribute('data-continue-active')==='true','返回后上一阶段继续按钮未启用');
  assert.equal(await oldContinue.getAttribute('data-continue-active'),'true');
  assert.equal(await oldContinue.isEnabled(),true);
  await flowHeader.click();
  await until(async()=>await page.locator(`#account-body-${secondAccount.id}`).evaluate(node=>node.getBoundingClientRect().height)<1,'账号收起后仍占位');
  await flowHeader.click();
  await until(async()=>await page.locator('#account-workspace').isVisible(),'账号未重新展开');
  pass('配置逐步展开时整组按钮随旧阶段收回并禁用，下一阶段仅一个可用继续按钮；明确返回后可重新继续，账号收起与展开衔接正常');
  await navigate('modules');await switchAccount(account.id);

  assert.deepEqual(errors,[]);
  assert.equal(sent.length,0);
  console.log(`本版界面真实 Electron 验证通过：${checks.length} 项。全程使用本地 OneBot，无真实 QQ 或付费模型调用。`);
 } catch(error) {
  if(page)console.error('VISIBLE',(await page.locator('body').innerText().catch(()=>'')).slice(0,14000));
  console.error(error.stack||error.message); process.exitCode=1;
 } finally {
  if(page)await page.evaluate(()=>window.addEventListener('beforeunload',event=>event.stopImmediatePropagation(),{capture:true})).catch(()=>{});
  if(electron)await electron.close().catch(()=>{});
  if(app)await app.close();
  if(qq){for(const peer of peers)peer.terminate();await new Promise(resolve=>qq.close(resolve));}
  fs.rmSync(fixture,{recursive:true,force:true});
 }
})();
