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
}
async function launch() {
  const main = path.join(fixture, 'electron-main.cjs');
  fs.writeFileSync(main, `'use strict';const{app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const win=new BrowserWindow({width:1400,height:1050,show:true,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});win.loadURL(process.env.QA_DASHBOARD_URL);});app.on('window-all-closed',()=>app.quit());`);
  electron = await _electron.launch({ executablePath:process.env.ELECTRON_EXECUTABLE || path.join(project,'node_modules/electron/dist/electron'), args:['--no-sandbox','--disable-gpu',main], env:{ ...process.env, QA_DASHBOARD_URL:origin, XDG_CONFIG_HOME:path.join(fixture,'config'), XDG_CACHE_HOME:path.join(fixture,'cache') }, timeout:30000 });
  page = await electron.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST' && request.url().startsWith(origin + '/api/')) posts.push({ url:request.url().slice(origin.length), body:request.postDataJSON() }); });
  await page.route('**/*', route => route.request().url().startsWith(origin) || route.request().url().startsWith('data:') ? route.continue() : route.abort());
  await page.waitForFunction(() => document.querySelector('#server-label')?.textContent === '管理服务可访问' && Boolean(window.QQServiceDesigner) && Boolean(window.QQServiceBuilder));
  await page.setViewportSize({ width:1400, height:1050 });
  await page.evaluate(() => {
    const original=Element.prototype.animate; window.qaFlowAnimations=[];
    Element.prototype.animate=function(frames, options){ window.qaFlowAnimations.push({ id:this.id, stage:this.dataset.flowStage, actions:this.dataset.flowActions, classes:this.className, frames, options });return original.call(this,frames,options); };
  });
}
(async () => {
 try {
  await seed(); await launch(); await chooseAccount(account.id); await active('identity');
  await navigate('modules');
  assert.equal(await page.locator('.install-selection, #setup-napcat, #setup-codex, #setup-install').count(), 0);
  assert.equal(await page.locator('#module-cards > .module-card').count(),5);
  assert.deepEqual(await page.locator('#module-cards > .module-card h2').allTextContents(),['NapCat · QQ 连接组件','官方 Codex CLI','DeepSeek 接入','通知汇总','QQ 收藏读取']);
  const legacy = { version:2, edits:['nrwofwe','ccvmzxw','kutgvun','ideyzfa'].map(key=>({selector:`[data-ui-key="ui-auto-${key}"]`,hidden:true,text:'旧安装选择'})), layout:{ navigation:['overview','connections','scenarios','modules','records','settings','custom-qaflowaa'], pages:[{id:'custom-qaflowaa',label:'QA 自建菜单',title:'QA 自建页面',description:'验证旧界面兼容',icon:'◇'}], components:[{id:'block-qaflowaa',type:'button',page:'custom-qaflowaa',parent:null,label:'QA 按钮',text:'',placeholder:'',description:'',styles:{fontSize:'18px'},action:{type:'pending',note:'后续接入'}}] } };
  await page.evaluate(doc=>window.QQServiceDesigner.importDocument(doc),legacy);
  const imported=await page.evaluate(()=>window.QQServiceDesigner.getDocument());
  assert.equal(imported.version,2); assert.deepEqual(imported.edits,[]); assert.deepEqual(imported.layout,legacy.layout);
  await navigate('custom-qaflowaa'); assert.equal(await page.locator('[data-builder-id="block-qaflowaa"] .builder-component-surface > button').innerText(),'QA 按钮');
  await page.evaluate(()=>window.QQServiceDesigner.importDocument({version:1,edits:[]}));
  pass('移除整个批量安装选择栏并保留全部五张模块卡；旧版已删除元素配置安全忽略，自建菜单仍可导入');

  await chooseAccount(account.id); await active('identity');
  await page.locator('#account-profile-name').fill('QA 未保存名称');
  await page.locator('#account-llm-source').selectOption('deepseek');
  await page.locator('[data-flow-actions="identity"] [data-setup-save="models"]').click(); await active('models');
  assert.ok(posts.some(post=>post.url===`/api/accounts/${account.id}/config/save`));
  await page.locator('[data-secret="deepseekApiKey"]').fill('QA_UNSAVED_KEY_1');
  await page.locator('[data-config="models.deepseek.model"]').fill('qa-unsaved-model');
  const beforeBack=posts.length;
  await clickBack('models','identity');
  const retracted=await page.locator('[data-flow-stage="models"]').evaluate(node=>({hidden:node.classList.contains('hidden'),height:node.getBoundingClientRect().height,inert:node.inert}));
  assert.deepEqual(retracted,{hidden:true,height:0,inert:true});
  await page.waitForTimeout(4300); await active('identity'); assert.equal(posts.length,beforeBack);
  assert.equal(await page.locator('[data-secret="deepseekApiKey"]').inputValue(),'QA_UNSAVED_KEY_1');
  assert.equal(await page.locator('[data-config="models.deepseek.model"]').inputValue(),'qa-unsaved-model');
  assert.equal(await page.locator('#account-profile-name').inputValue(),'QA 未保存名称');
  assert.ok(await page.evaluate(()=>window.qaFlowAnimations.some(item=>item.stage==='models'&&item.frames.at(-1).height==='0px')),'返回没有执行子菜单收回动画');
  pass('返回上一步动画收回后续菜单及其整组按钮；轮询不会重新展开，未保存的名称、模型参数和密钥保持原值');

  await clickSkip('identity');
  await clickBack('connection','models'); await clickBack('models','identity');
  assert.equal(await page.locator('[data-flow-actions="identity"] [data-setup-skip]').isVisible(),false);
  assert.equal(await page.locator('[data-flow-actions="identity"] [data-setup-skip]').evaluate(node=>node.inert),true);
  await page.locator('[data-flow-actions="identity"] [data-setup-save="models"]').click(); await active('models');
  await page.locator('[data-secret="deepseekApiKey"]').fill('QA_UNSAVED_KEY_2');
  await clickSkip('models'); await clickBack('connection','models');
  assert.equal(await page.locator('[data-flow-actions="models"] [data-setup-skip]').isVisible(),false);
  assert.equal(await page.locator('[data-secret="deepseekApiKey"]').inputValue(),'QA_UNSAVED_KEY_2');
  const beforeSwitch=posts.length;
  await chooseAccount(second.id); await active('identity');
  assert.equal(await page.locator('[data-flow-actions="identity"] [data-setup-skip]').isVisible(),true);
  await chooseAccount(account.id); await active('models');
  assert.equal(await page.locator('[data-flow-actions="models"] [data-setup-skip]').isVisible(),false);
  assert.equal(await page.locator('[data-secret="deepseekApiKey"]').inputValue(),'QA_UNSAVED_KEY_2');
  assert.equal(posts.length,beforeSwitch);
  pass('两个稍后准备按钮使用后消失，返回及切换账号不再出现；跳过状态与未保存输入按账号独立，跳过没有业务写入');

  const header=page.locator(`[data-open-account="${account.id}"]`);
  await page.evaluate(()=>{window.qaFlowAnimations=[];});
  await header.click();
  await until(async()=>await page.locator(`#account-body-${account.id}`).evaluate(node=>node.inert&&node.getBoundingClientRect().height<1),'账号没有完全收回');
  await header.click(); await active('models');
  assert.ok(await page.evaluate(()=>window.qaFlowAnimations.some(item=>item.classes.includes('setup-flow-content')&&item.frames[0].opacity===0)),'账号展开缺少子菜单动画');
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(()=>{window.qaFlowAnimations=[];});
  await clickBack('models','identity');
  assert.deepEqual(await page.evaluate(()=>window.qaFlowAnimations),[],'减少动态效果时仍启动了补间动画');
  assert.equal(await page.locator('[data-flow-stage="models"]').evaluate(node=>node.inert&&node.classList.contains('hidden')),true);
  await page.emulateMedia({reducedMotion:'no-preference'});
  pass('账号选项卡展开同步带出子菜单动画；收回后不可交互，系统减少动态效果设置得到尊重');

  await page.locator('[data-flow-actions="identity"] [data-setup-save="models"]').click(); await active('models');
  await page.locator('[data-flow-actions="models"] [data-setup-apply="connection"]').click(); await active('connection');
  await page.locator('[data-config="qq.wsUrl"]').fill(`ws://127.0.0.1:${qq.address().port}`);
  await page.locator('[data-secret="napcatToken"]').fill('QA_LOCAL_ONEBOT_TOKEN');
  await page.locator('[data-setup-connect]').click(); await active('scenarios');
  const connected=await state(); assert.equal(connected.setup.connection.verified,true); assert.equal(connected.applied.permissions.released,false);
  assert.ok(posts.some(post=>post.url===`/api/accounts/${account.id}/runtime/connect`));
  await clickSkip('scenarios','permissions'); await clickBack('permissions','scenarios');
  assert.equal(await page.locator('[data-flow-actions="scenarios"] [data-setup-skip]').isVisible(),false);
  await page.locator('[data-flow-actions="scenarios"] [data-setup-apply="permissions"]').click(); await active('permissions');
  await clickSkip('permissions','verification'); await clickBack('verification','permissions');
  assert.equal(await page.locator('[data-flow-actions="permissions"] [data-setup-skip]').isVisible(),false);
  await page.locator('[data-flow-actions="permissions"] [data-setup-save="verification"]').click(); await active('verification');
  await clickBack('verification','permissions'); await clickBack('permissions','scenarios'); await clickBack('scenarios','connection');
  assert.equal((await state()).applied.permissions.released,false); assert.equal(sent.length,0);
  pass('保存继续、应用及 QQ 连接均调用真实账号后端，OneBot 身份验证通过；六阶段可逐级回退，未自动授权或发送消息');
  await clickSkip('connection','scenarios'); await clickBack('scenarios','connection');
  assert.equal(await page.locator('[data-flow-actions="connection"] [data-setup-skip]').isVisible(),false);
  assert.equal(await page.locator('[data-config="qq.wsUrl"]').inputValue(),`ws://127.0.0.1:${qq.address().port}`);
  pass('连接、账号任务和范围授权阶段的稍后再写同样只推进界面，使用后永久退场，返回时保留连接信息');

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

  const beforeEdit=posts.length;
  await page.locator('#frontend-editor-toggle').click(); await page.locator('#designer-root[data-mode="edit"]').waitFor();
  await page.locator('#module-cards [data-module-action="install"][data-module="napcat"]').click();
  assert.equal(posts.length,beforeEdit,'编辑模式点击安装按钮触发了后端操作');
  await page.locator('#designer-close').click();
  await chooseAccount(second.id); await active('identity');
  await page.locator('#account-llm-source').selectOption('deepseek');
  await page.locator('[data-flow-actions="identity"] [data-setup-save="models"]').click(); await active('models');
  await page.locator('[data-flow-actions="models"]').scrollIntoViewIfNeeded();
  await page.locator('#toast-region').evaluate(node=>node.replaceChildren());
  await page.screenshot({path:'/tmp/qq-service-flow-controls.png',fullPage:false});
  await clickBack('models','identity');
  await page.locator('[data-flow-actions="identity"]').scrollIntoViewIfNeeded();
  await page.screenshot({path:'/tmp/qq-service-flow-back-collapsed.png',fullPage:false});
  await navigate('modules'); await page.screenshot({path:'/tmp/qq-service-flow-modules.png',fullPage:false});
  assert.deepEqual(errors,[]); assert.equal(sent.length,0);
  assert.equal(installerCalls.some(call=>!['legacy',account.id,second.id].includes(call.id)),false);
  pass('编辑模式仍拦截安装操作，无页面异常、真实 QQ 消息、外部下载或付费模型调用');
  console.log(`本次真实 Electron 流程与模块验证通过：${checks.length} 项。`);
 } catch(error) {
  if(page) { console.error('VISIBLE',(await page.locator('body').innerText().catch(()=>'' )).slice(0,14000)); await page.screenshot({path:'/tmp/qq-service-flow-failure.png',fullPage:false}).catch(()=>{}); }
  console.error(error.stack||error.message); process.exitCode=1;
 } finally {
  if(electron)await electron.close().catch(()=>{});
  if(app)await app.close();
  if(qq){for(const peer of qq.clients)peer.terminate();await new Promise(resolve=>qq.close(resolve));}
  fs.rmSync(fixture,{recursive:true,force:true});
 }
})();
