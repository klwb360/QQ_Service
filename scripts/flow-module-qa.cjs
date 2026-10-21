'use strict';

// Optional real-Electron integration check. Uses the production dashboard,
// frontend and OneBot runtime with local QQ and installer fixtures only.
// DISPLAY=:98 PLAYWRIGHT_MODULE_PATH=/path/to/playwright \
// ELECTRON_EXECUTABLE=/path/to/electron node scripts/flow-module-qa.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const project = path.resolve(__dirname, '..');
const { WebSocketServer } = require(path.join(project, 'node_modules/ws'));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-service-flow-module-qa-'));
const checks = [], errors = [], posts = [], sent = [], installerCalls = [], contexts = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, qq, electron, page, origin, token, account, second;
function pass(message) { checks.push(message); console.log('PASS', message); }
async function until(predicate, message, timeout = 10000) {
  const stop = Date.now() + timeout;
  do { if (await predicate()) return; await delay(50); } while (Date.now() < stop);
  throw new Error(message);
}
async function post(endpoint, body = {}) {
  const response = await fetch(origin + endpoint, { method:'POST', headers:{ 'Content-Type':'application/json', 'X-Dashboard-Token':token, Origin:origin }, body:JSON.stringify(body) });
  const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
}
async function state(id = account.id) { return (await fetch(`${origin}/api/accounts/${id}/state`)).json(); }
async function navigate(name) { await page.locator(`.nav-link[data-page="${name}"]`).click(); }
async function chooseAccount(id) {
  await navigate('connections');
  const header = page.locator(`[data-open-account="${id}"]`);
  if (await header.getAttribute('aria-expanded') !== 'true') await header.click();
  await until(async () => await page.locator('#account-selector').inputValue() === id && await page.locator('#account-workspace').isVisible(), '账号未展开');
}
async function active(stage) {
  await until(async () => await page.locator('#account-workspace').getAttribute('data-flow-active') === stage, `未到达 ${stage} 阶段`);
  await delay(360);
  const footers = await page.locator('[data-flow-actions]').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden' && !node.inert).map(node => node.dataset.flowActions));
  assert.deepEqual(footers, [stage], '右下角操作按钮没有整体移动到当前阶段');
}
async function clickBack(stage, target) {
  const before = posts.length;
  await page.locator(`[data-flow-actions="${stage}"] [data-setup-back="${target}"]`).click();
  await active(target);
  assert.equal(posts.length, before, '返回上一步不应保存、安装、调用模型或授权');
}
async function clickSkip(stage, target = 'connection') {
  const before = posts.length;
  await page.locator(`[data-flow-actions="${stage}"] [data-setup-skip]`).click();
  await active(target);
  assert.equal(posts.length, before, '稍后准备不应保存、安装、调用模型或授权');
}
async function moduleInstall(module) {
  await page.locator(`#module-cards [data-module-action="install"][data-module="${module}"]`).click();
}
async function seed() {
  qq = new WebSocketServer({ host:'127.0.0.1', port:0 }); await once(qq, 'listening');
  qq.on('connection', socket => socket.on('message', raw => {
    const packet = JSON.parse(raw.toString()); let data = {};
    if (packet.action === 'get_login_info') data = { user_id:12345001, nickname:'本地模拟 QQ' };
    if (packet.action === 'get_group_list') data = [{ group_id:98765001, group_name:'本地测试群' }];
    if (packet.action.startsWith('send_')) { sent.push(packet); data = { message_id:sent.length }; }
    socket.send(JSON.stringify({ echo:packet.echo, status:'ok', retcode:0, data }));
  }));
  const { createDashboard } = await import(pathToFileURL(path.join(project, 'src/server.mjs')));
  app = createDashboard({ dataDir:path.join(fixture, 'data'), installerFactory(context) {
    const id = context.accountId;
    const item = { installed:new Set(), running:false, gate:null, context }; contexts.set(id, item);
    const call = (action, module) => installerCalls.push({ id, action, module });
    return {
      environment:async () => ({ node:{ supported:true }, docker:{ installed:true, running:true, linuxContainers:true } }),
      status:async () => ['napcat','codex','deepseek','summary','favorites'].map(module => ({ id:module, name:module, installed:item.installed.has(module), version:'QA', state:module === 'napcat' && item.running ? 'running' : item.installed.has(module) ? 'installed' : 'missing' })),
      install:async (module, onLog) => { call('install', module); onLog(`本地模拟安装 ${module}`); if (item.gate) await item.gate; item.installed.add(module); return { installed:true }; },
      startNapcat:async onLog => { call('start','napcat'); item.running=true; onLog?.('本地模拟启动'); },
      stopNapcat:async onLog => { call('stop','napcat'); item.running=false; onLog?.('本地模拟停止'); },
      codexStatus:async () => { call('status','codex'); return { loggedIn:true, message:'本地模拟授权' }; },
      loginCodex:async onLog => { call('login','codex'); onLog('本地模拟官方授权'); return { loggedIn:true }; },
      runCodex:async () => { throw new Error('此检查不允许调用模型'); },
      dispose:async () => {},
    };
  } });
  const address = await app.listen(0); origin = `http://127.0.0.1:${address.port}`;
  token = (await (await fetch(origin + '/api/accounts')).json()).csrfToken;
  account = (await post('/api/accounts', { name:'QA 主账号', platform:'qq', qqNumber:'12345001' })).account;
  second = (await post('/api/accounts', { name:'QA 第二账号', platform:'qq', qqNumber:'12345002' })).account;
  const napcatSettings = await (await fetch(origin + '/api/napcat/settings')).json();
  await post('/api/napcat/settings', { ...napcatSettings, mode:'docker' });
}
async function launch() {
  const main = path.join(fixture, 'electron-main.cjs');
  fs.writeFileSync(main, `'use strict';const{app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const win=new BrowserWindow({width:1400,height:1050,show:true,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});win.loadURL(process.env.QA_DASHBOARD_URL);});app.on('window-all-closed',()=>app.quit());`);
  electron = await _electron.launch({ executablePath:process.env.ELECTRON_EXECUTABLE || path.join(project,'node_modules/electron/dist/electron'), args:['--no-sandbox','--disable-gpu',main], env:{ ...process.env, QA_DASHBOARD_URL:origin, XDG_CONFIG_HOME:path.join(fixture,'config'), XDG_CACHE_HOME:path.join(fixture,'cache') }, timeout:30000 });
  page = await electron.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept().catch(() => {}));
  page.on('request', request => { if (request.method() === 'POST' && request.url().startsWith(origin + '/api/')) posts.push({ url:request.url().slice(origin.length), body:request.postDataJSON() }); });
  await page.route('**/*', route => route.request().url().startsWith(origin) || route.request().url().startsWith('data:') ? route.continue() : route.abort());
  await page.waitForFunction(() => document.querySelector('#server-label')?.textContent === '管理服务可访问');
  await page.setViewportSize({ width:1400, height:1050 });
  await page.evaluate(() => {
    const original=Element.prototype.animate; window.qaFlowAnimations=[];
    Element.prototype.animate=function(frames, options){ window.qaFlowAnimations.push({ id:this.id, stage:this.dataset.flowStage, actions:this.dataset.flowActions, classes:this.className, frames, options });return original.call(this,frames,options); };
  });
}
(async () => {
 try {
  await seed(); await launch(); await chooseAccount(account.id); await active('identity');
  assert.equal(await page.locator('[data-flow-stage]').count(),4);
  assert.equal(await page.locator('[data-open-account]').count(),2);
  assert.equal(await page.locator('#account-llm-source').getAttribute('multiple'),null);
  assert.equal(await page.locator('#new-account-llm-source, #new-account-platform, #setup-connection-badge, #setup-model-status').count(),0);
  assert.equal(await page.locator('.config-bar').isVisible(),false);
  assert.equal(await page.locator('#frontend-editor-toggle, #designer-root').count(),0);
  assert.equal(await page.evaluate(()=>Boolean(window.QQServiceDesigner||window.QQServiceBuilder)),false);
  pass('保留每个账号主下拉栏与单选 AI 下拉框，四部分账号流程可用；编辑器不再加载');

  for(const source of ['deepseek','vendor:openai','vendor:dashscope','vendor:zhipu','vendor:kimi','vendor:siliconflow','vendor:custom','codex']) {
    await page.locator('#account-llm-source').selectOption(source);
    const forms=page.locator('#deepseek-model-card:visible, #codex-model-card:visible, [data-api-card]:visible');
    assert.equal(await forms.count(),1);
    if(source.startsWith('vendor:')) {
      await forms.locator('[data-secret]').fill('QA_VENDOR_KEY');
      await forms.locator('[data-config$=".model"]').fill('qa-model');
      assert.equal(await forms.locator('details').getAttribute('open')!==null,source==='vendor:custom');
    }
  }
  await page.locator('#account-llm-source').selectOption('deepseek');
  assert.equal(await page.locator('[data-config="models.deepseek.model"]').isVisible(),false);
  await page.locator('[data-secret="deepseekApiKey"]').fill('QA_UNSAVED_KEY_1');
  await page.locator('#deepseek-model-card summary').click();
  await page.locator('[data-config="models.deepseek.model"]').fill('qa-model');
  await page.locator('#deepseek-model-card summary').click();
  await page.locator('#account-profile-name').fill('QA 简洁主账号');
  await page.locator('#save-account-profile').click();
  await until(async()=>(await state()).account.name==='QA 简洁主账号','名称没有保存');
  await page.locator('[data-flow-actions="identity"] [data-setup-apply]').click();await active('connection');
  assert.ok(posts.some(p=>p.url===`/api/accounts/${account.id}/config/apply`));
  const modelState=await state();assert.equal(modelState.secrets.deepseekApiKey,true);assert.equal(modelState.applied.models.deepseek.model,'qa-model');assert.equal(modelState.applied.permissions.released,false);
  pass('全部八种 AI 来源均显示唯一配置表单；高级项默认折叠，自定义地址可见，名称及模型凭据实际保存到当前账号');

  await clickBack('connection','identity');
  await page.locator('#deepseek-model-card summary').click();
  await page.locator('[data-config="models.deepseek.maxTokens"]').fill('10');
  await page.locator('#deepseek-model-card summary').click();
  await page.locator('[data-flow-actions="identity"] [data-setup-apply]').click();
  await page.locator('[data-config="models.deepseek.maxTokens"][aria-invalid="true"]').waitFor();
  await active('identity');
  assert.equal(await page.locator('#deepseek-model-card details').evaluate(n=>n.open),true);
  await page.locator('[data-config="models.deepseek.maxTokens"]').fill('1024');
  await page.locator('#deepseek-model-card summary').click();
  await page.locator('[data-flow-actions="identity"] [data-setup-apply]').click();await active('connection');
  pass('后端旧模型步骤错误会定位到合并后的账号与 AI，并自动展开含错误字段的高级设置');

  await page.locator('[data-config="qq.wsUrl"]').fill(`ws://127.0.0.1:${qq.address().port}`);
  await page.locator('[data-secret="napcatToken"]').fill('QA_UNSAVED_ONEBOT');
  await page.evaluate(()=>{window.qaFlowAnimations=[];});
  await clickBack('connection','identity');await page.waitForTimeout(4300);await active('identity');
  assert.equal(await page.locator('[data-flow-stage="connection"]').evaluate(n=>n.inert&&n.getBoundingClientRect().height===0),true);
  assert.equal(await page.locator('[data-secret="napcatToken"]').inputValue(),'QA_UNSAVED_ONEBOT');
  assert.ok(await page.evaluate(()=>window.qaFlowAnimations.some(a=>a.stage==='connection'&&a.frames.at(-1).height==='0px')));
  await clickSkip('identity','connection');await clickBack('connection','identity');
  assert.equal(await page.locator('[data-flow-actions="identity"] [data-setup-skip]').isVisible(),false);
  await chooseAccount(second.id);await active('identity');
  assert.equal(await page.locator('[data-secret="napcatToken"]').inputValue(),'');
  assert.equal(await page.locator('[data-flow-actions="identity"] [data-setup-skip]').isVisible(),true);
  await chooseAccount(account.id);await active('identity');
  assert.equal(await page.locator('[data-secret="napcatToken"]').inputValue(),'QA_UNSAVED_ONEBOT');
  pass('返回动画收回后续内容及按钮，轮询不再展开；跳过仅改变界面且按钮消失，账号间草稿与密钥隔离');

  const header=page.locator(`[data-open-account="${account.id}"]`);
  await page.evaluate(()=>{window.qaFlowAnimations=[];});await header.click();
  await until(async()=>await page.locator(`#account-body-${account.id}`).evaluate(n=>n.inert&&n.getBoundingClientRect().height<1),'账号未收起');
  await header.click();await active('identity');
  assert.ok(await page.evaluate(()=>window.qaFlowAnimations.some(a=>a.classes.includes('setup-flow-content'))));
  await page.locator('[data-flow-actions="identity"] [data-setup-apply]').click();await active('connection');
  await page.emulateMedia({reducedMotion:'reduce'});await page.evaluate(()=>{window.qaFlowAnimations=[];});
  await clickBack('connection','identity');assert.deepEqual(await page.evaluate(()=>window.qaFlowAnimations),[]);
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.locator('[data-flow-actions="identity"] [data-setup-apply]').click();await active('connection');
  await page.locator('[data-setup-connect]').click();await active('permissions');
  assert.equal((await state()).setup.connection.verified,true);assert.equal((await state()).applied.permissions.released,false);
  assert.equal(await page.locator('.account-entry [data-account-online="online"]').count(),1);
  pass('账号展开与系统减少动画设置正常；连接按钮验证真实后端的 OneBot 登录身份，成功后到任务与权限且仍只读');

  await clickBack('permissions','connection');
  let releaseConnect;const connectGate=new Promise(r=>{releaseConnect=r;});
  await page.route('**/runtime/connect',async route=>{await connectGate;await route.continue();});
  const priorConnect=posts.filter(p=>p.url.endsWith('/runtime/connect')).length;
  await page.locator('[data-setup-connect]').click();
  await until(()=>posts.filter(p=>p.url.endsWith('/runtime/connect')).length>priorConnect,'连接请求未开始');
  await clickBack('connection','identity');releaseConnect();await page.unroute('**/runtime/connect');
  await page.waitForTimeout(4500);await active('identity');
  await page.locator('[data-flow-actions="identity"] [data-setup-apply]').click();await active('connection');
  await page.locator('[data-setup-connect]').click();await active('permissions');
  pass('连接请求晚返回时不会覆盖用户主动返回的位置，也不会把已收回菜单重新展开');

  await page.locator('.account-setup-link[data-scenario-go="tasks"]').click();
  await page.locator('[data-config="chat.enabled"]').check();
  await page.locator('[data-return-to-setup]').click();await active('permissions');
  assert.ok((await page.locator('#setup-task-summary').innerText()).includes('聊天回复'));
  await page.locator('.account-setup-link[data-scenario-go="permissions"]').click();
  await page.locator('#add-group').click();
  await page.locator('#new-group-id').fill('98765001');
  await page.locator('#new-group-name').fill('QA 授权群');
  await page.locator('#new-group-mode').selectOption('social');
  await page.locator('#dialog-confirm').click();
  await page.locator('[data-group-field="read"]').check();await page.locator('[data-group-field="send"]').check();
  await page.locator('[data-return-to-setup]').click();await active('permissions');
  assert.equal(await page.locator('#setup-permission-summary').innerText(),'1 个可读群 · 1 个可发送群');
  await clickSkip('permissions','verification');await clickBack('verification','permissions');
  assert.equal(await page.locator('[data-flow-actions="permissions"] [data-setup-skip]').isVisible(),false);
  await page.locator('[data-flow-actions="permissions"] [data-setup-apply]').click();await active('verification');
  assert.equal((await state()).applied.permissions.released,false);assert.equal(sent.length,0);
  assert.ok((await page.locator('#setup-verification-checks').innerText()).includes('尚未测试或登录'));
  await page.locator('[data-setup-start]').click();await page.locator('#app-dialog[open]').waitFor();
  assert.ok((await page.locator('#dialog-content').innerText()).includes('98765001'));
  assert.equal((await state()).applied.permissions.released,false);
  await page.locator('#dialog-confirm').click();
  await until(async()=>(await state()).applied.permissions.released===true,'显式确认后权限未释放');
  assert.equal(sent.length,0);
  pass('两个简洁入口回到原有功能与群权限页面；保存不授权，启动先展示实际范围，确认后才释放权限，未伪造 API 测试状态');

  await page.locator('#create-account-entry').click();
  assert.equal(await page.locator('#new-account-form input').count(),2);
  await page.locator('#new-account-qq').fill('12345003');await page.locator('#new-account-name').fill('QA 新建账号');
  await page.locator('#submit-create-account').click();
  await until(async()=>await page.locator('[data-open-account]').count()===3,'创建账号失败');await active('identity');
  assert.equal(await page.locator('#account-llm-source').inputValue(),'');
  assert.equal(await page.locator('.config-bar').isVisible(),false);
  await page.locator('#account-llm-source').selectOption('deepseek');
  assert.equal(await page.locator('#account-save-footer').isVisible(),true);
  assert.equal(await page.locator('#account-workspace > #account-save-footer').count(),1);
  assert.equal(await page.locator('#account-workspace .config-bar').count(),0);
  assert.equal(await page.locator('#account-save-footer').evaluate(n=>getComputedStyle(n).backgroundColor),'rgba(0, 0, 0, 0)');
  await page.locator('#toast-region').evaluate(n=>n.replaceChildren());
  await page.screenshot({path:'/tmp/qq-service-simple-account.png',fullPage:false});
  await page.setViewportSize({width:720,height:1000});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  await page.screenshot({path:'/tmp/qq-service-simple-account-narrow.png',fullPage:false});
  await page.setViewportSize({width:1400,height:1050});
  pass('创建仅填写 QQ 号与可选名称，新账号无默认模型并保持只读；常用宽度无横向溢出');

  await chooseAccount(account.id);
  await post(`/api/accounts/${account.id}/permissions/revoke`);
  await navigate('modules');
  let releaseInstall; const item=contexts.get(account.id); item.gate=new Promise(resolve=>{releaseInstall=resolve;});
  await moduleInstall('napcat');
  await until(()=>installerCalls.some(call=>call.id===account.id&&call.action==='install'&&call.module==='napcat'),'NapCat 卡片未调用账号安装器');
  await chooseAccount(second.id); await navigate('modules'); await moduleInstall('codex');
  await until(async()=>contexts.get(second.id).installed.has('codex'),'第二账号不能独立安装 Codex');
  assert.equal(item.installed.has('napcat'),false);
  releaseInstall(); item.gate=null;
  await until(async()=>{const current=await state();return current.jobs.some(job=>job.label==='安装 napcat'&&job.status==='completed');},'NapCat 安装任务没有完成');
  assert.equal(item.installed.has('napcat'),true); assert.equal(item.running,true);
  await chooseAccount(account.id); await navigate('modules'); await moduleInstall('codex');
  await until(()=>item.installed.has('codex'),'当前账号 Codex 卡片没有安装');
  await until(async()=>(await state()).jobs.filter(job=>job.status==='running').length===0,'Codex 安装任务未结束');
  await page.locator('#module-cards [data-action="codex-login"]').click();
  await until(()=>installerCalls.some(call=>call.id===account.id&&call.action==='login'&&call.module==='codex'),'Codex 授权没有调用账号后端');
  await until(async()=>(await state()).jobs.filter(job=>job.status==='running').length===0,'Codex 授权未完成');
  assert.ok(item.installed.has('napcat')&&item.installed.has('codex'));
  assert.equal(await page.locator('#module-cards > .module-card').count(),5);
  assert.ok(posts.some(post=>post.url===`/api/accounts/${account.id}/modules/napcat/install`));
  assert.ok(posts.some(post=>post.url===`/api/accounts/${second.id}/modules/codex/install`));
  assert.ok(posts.some(post=>post.url===`/api/accounts/${account.id}/codex/login`));
  assert.equal(posts.some(post=>post.url.endsWith('/setup/install')),false);
  assert.equal((await state()).applied.permissions.released,false); assert.equal((await state(second.id)).applied.permissions.released,false);
  pass('保留的模块卡片真实提交独立安装与 Codex 授权任务；账号切换不改任务归属，两个账号可并发安装，同账号 NapCat 与 Codex 可同时保留');

  await post(`/api/accounts/${account.id}/permissions/revoke`);
  assert.deepEqual(errors,[]); assert.equal(sent.length,0);
  assert.equal(installerCalls.some(call=>!['legacy',account.id,second.id].includes(call.id)),false);
  pass('无页面异常、真实 QQ 消息、外部下载或付费模型调用；账号任务归属保持正确');
  console.log(`本次真实 Electron 流程与模块验证通过：${checks.length} 项。`);
 } catch(error) {
  if(page) { console.error('VISIBLE',(await page.locator('body').innerText().catch(()=>'' )).slice(0,14000)); await page.screenshot({path:'/tmp/qq-service-flow-failure.png',fullPage:false}).catch(()=>{}); }
  console.error(error.stack||error.message); process.exitCode=1;
 } finally {
  if(page)await page.evaluate(()=>window.addEventListener('beforeunload',e=>e.stopImmediatePropagation(),{capture:true})).catch(()=>{});
  if(electron)await electron.close().catch(()=>{});
  if(app)await app.close();
  if(qq){for(const peer of qq.clients)peer.terminate();await new Promise(resolve=>qq.close(resolve));}
  fs.rmSync(fixture,{recursive:true,force:true});
 }
})();
