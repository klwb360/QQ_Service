'use strict';

// Chromium integration against a temporary real dashboard/store. QQ and model
// runtimes are fixtures; this check never logs in or calls a paid API.
// CHROMIUM_EXECUTABLE=/path/to/chromium QQ_UI_ARTIFACT_DIR=/tmp node scripts/persona-memory-ui-qa.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const artifacts = process.env.QQ_UI_ARTIFACT_DIR || os.tmpdir();
fs.mkdirSync(artifacts, { recursive:true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-persona-ui-'));
let app, browser;
(async () => {
  const { createDashboard } = await import(root + '/src/server.mjs');
  app = createDashboard({ dataDir:temp,
    installerFactory: () => ({ environment:async()=>({}),status:async()=>[],dispose:async()=>{} }),
    runtimeFactory: () => ({status:()=>({connected:false,accountId:'',metrics:{}}),reload:async()=>{},stop:async()=>{},invalidateMemory:()=>{} })
  });
  const address=await app.listen(0), base=`http://127.0.0.1:${address.port}`;
  const directory=await (await fetch(base+'/api/accounts')).json();
  async function post(url,body) {const r=await fetch(base+url,{method:'POST',headers:{'content-type':'application/json','x-dashboard-token':directory.csrfToken,origin:base},body:JSON.stringify(body)});const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return data;}
  const first=await post('/api/accounts',{name:'人格测试账号',platform:'qq',qqNumber:'12345001'});
  const second=await post('/api/accounts',{name:'第二测试账号',platform:'qq',qqNumber:'12345002'});
  for (const [index,account] of [first,second].entries()) {
    const service=app.accounts.get(account.account.id), store=service.store;
    const state=store.getState();
    const c=state.draft;c.botQQ=index?'12345002':'12345001';c.chat.enabled=true;c.chat.persona=index?'第二账号独立人格':'自然简短，喜欢聊游戏';c.chat.social.name=index?'小二':'小Q';c.models.deepseek.enabled=true;
    c.groups=[{id:'98765001',name:'测试群一',mode:'social',read:true,send:false,social:{enabled:true}},{id:'98765002',name:'测试群二',mode:'social',read:true,send:false,social:{enabled:true}}];
    state.applied=structuredClone(c);state.revision=2;state.appliedRevision=2;store.restoreState(state);
    store.personas.save({actualQQ:c.botQQ,persona:{body:'旧版人格正文',name:'旧名字',aliases:[],interests:''},expectedRevision:0});store.recordPersona();
    store.memory.setGroup({actualQQ:c.botQQ,groupId:'98765001',enabled:true});
    const source={actualQQ:c.botQQ,groupId:'98765001',messageId:'source-1',userId:'333333',role:'user',text:index?'第二账号独立互动':'今晚接着聊游戏，不要忘了上次的关卡',time:Math.floor(Date.now()/1000),displayName:'群友甲'};
    store.conversation.record(source);
    store.experiences.suggest({actualQQ:c.botQQ,groupId:'98765001',sources:[source],candidates:[{kind:'pending_topic',text:index?'第二账号独立札记':'下次接着聊上次的游戏关卡',sourceIds:['source-1']}]});
    store.conversationState.observe({actualQQ:c.botQQ,groupId:'98765001',topic:'游戏关卡',sources:[source]});
    store.conversationState.setPending({actualQQ:c.botQQ,groupId:'98765001',items:['接着讨论上次关卡']});
  }
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}), errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.waitForFunction(()=>document.querySelector('#server-label').textContent==='管理服务可访问');
  await page.locator('[data-page="connections"]').click();await page.locator(`[data-open-account="${first.account.id}"]`).click();
  await page.locator('#persona-editor>summary').click();
  await page.locator('[data-config="chat.persona"]').fill('尚未保存的人格修改');
  await page.locator('#persona-preview').click();await page.waitForFunction(()=>!document.querySelector('#persona-preview-content').classList.contains('hidden'));
  assert.match(await page.locator('#persona-preview-content').textContent(),/尚未保存的人格修改/);
  assert.equal(app.accounts.get(first.account.id).store.getConfig().chat.persona,'自然简短，喜欢聊游戏');
  await page.locator('#refresh-state').click();await page.waitForTimeout(350);
  assert.equal(await page.locator('[data-config="chat.persona"]').inputValue(),'尚未保存的人格修改');
  assert.equal(await page.locator('#qq-backend option[value="snowluma"]').evaluate(e=>e.disabled),true);
  await page.screenshot({path:path.join(artifacts,'QQ_Service-v0.8-persona-preview.png'),fullPage:true});
  await page.locator('#persona-history').click();await page.locator('#persona-history-selection').selectOption('1');await page.locator('#dialog-confirm').click();
  await page.waitForFunction(()=>document.querySelector('[data-config="chat.persona"]').value==='旧版人格正文');
  assert.equal(app.accounts.get(first.account.id).store.getConfig().chat.persona,'自然简短，喜欢聊游戏');
  await page.locator('[data-page="settings"]').click();await page.locator('#open-memory-manager').click();
  await page.locator('[data-memory-tab="experiences"]').click();await page.waitForFunction(()=>document.querySelector('#experience-workspace').textContent.includes('下次接着聊'));
  const card=page.locator('.experience-card').first();await card.locator('[data-experience-action="edit"]').click();await page.locator('#experience-edit-text').fill('下次讨论游戏关卡和隐藏路线');await page.locator('#experience-edit-save').click();
  await page.waitForFunction(()=>document.querySelector('#experience-workspace').textContent.includes('隐藏路线'));
  await page.locator('#experience-enabled').uncheck();await page.waitForFunction(()=>document.querySelector('#experience-workspace').textContent.includes('已暂停'));
  await page.locator('#experience-enabled').check();
  await card.locator('[data-experience-action="history"]').click();await page.waitForSelector('[data-experience-version]');await page.locator('[data-experience-version]').selectOption('1');await card.locator('[data-experience-action="rollback"]').click();
  await page.waitForFunction(()=>document.querySelector('#experience-workspace').textContent.includes('下次接着聊上次的游戏关卡'));
  await card.locator('[data-experience-action="archive"]').click();await page.locator('#experience-status').selectOption('archived');await page.waitForSelector('[data-experience-action="restore"]');await page.locator('[data-experience-action="restore"]').click();await page.locator('#experience-status').selectOption('active');
  await page.locator('[data-memory-tab="session"]').click();await page.waitForFunction(()=>document.querySelector('#conversation-workspace').textContent.includes('游戏关卡'));
  assert.match(await page.locator('#conversation-workspace').textContent(),/群友甲/);
  await page.locator('[data-conversation-clear]').click();await page.waitForFunction(()=>!document.querySelector('#conversation-workspace').textContent.includes('接着讨论上次关卡'));
  await page.locator('[data-memory-tab="experiences"]').click();await page.waitForSelector('.experience-card');
  await page.locator('[data-memory-directory="'+second.account.id+'"]>summary').click(); await page.locator('[data-memory-profile="'+second.account.id+'"][data-memory-group="98765001"]').first().click();await page.waitForFunction(()=>document.querySelector('#experience-workspace').textContent.includes('第二账号独立札记'));
  assert.doesNotMatch(await page.locator('#experience-workspace').textContent(),/下次接着聊/);
  await page.screenshot({path:path.join(artifacts,'QQ_Service-v0.8-memory-preview.png'),fullPage:true});
  await page.setViewportSize({width:650,height:900});await page.screenshot({path:path.join(artifacts,'QQ_Service-v0.8-memory-narrow.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  await page.locator('.experience-card [data-experience-action="delete"]').click();assert.match(await page.locator('#experience-edit-dialog .field-note').textContent(),/无法回退/);await page.locator('#experience-edit-save').click();await page.waitForFunction(()=>document.querySelector('#experience-workspace').textContent.includes('这里还没有札记'));
  await page.locator('#memory-close').click();
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('[data-page="connections"]').click();
  await page.locator('#chat-social-aliases').fill('阿Q,小鲸');
  await page.locator(`[data-open-account="${second.account.id}"]`).click();
  await page.waitForFunction(id=>document.querySelector('#account-selector').value===id,second.account.id);
  await page.locator(`[data-open-account="${first.account.id}"]`).click();
  await page.waitForFunction(id=>document.querySelector('#account-selector').value===id,first.account.id);
  assert.equal(await page.locator('[data-config="chat.persona"]').inputValue(),'旧版人格正文');
  assert.equal(await page.locator('#chat-social-aliases').inputValue(),'阿Q, 小鲸');
  await page.locator('#persona-file').setInputFiles({name:'role.md',mimeType:'text/markdown',buffer:Buffer.from('# 测试角色卡\n保持简洁自然')});
  await page.waitForFunction(()=>document.querySelector('[data-config="chat.persona"]').value.includes('测试角色卡'));
  await page.route('**/api/accounts/*/state',async route=>{const response=await route.fetch();await route.fulfill({response,json:{...await response.json(),container:true}});});
  await page.locator('#refresh-state').click();
  await page.waitForFunction(()=>document.querySelector('#connection-napcat-hint').textContent.includes('容器内连接外部'));
  assert.equal(await page.locator('#napcat-connect-toolbar [data-open-napcat-program]').isVisible(),false);
  await page.locator('[data-page="modules"]').click();
  assert.equal(await page.locator('#module-cards [data-module-action="install"][data-module="napcat"]').count(),0);
  assert.deepEqual(errors,[]);
  console.log('PASS Chromium real dashboard: persona draft preview/history, preserved unsaved form, SnowLuma gate, experience edit/pause/history/archive/delete, session reset, profile isolation, narrow layout');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{try { await browser?.close(); } finally { try { await app?.close(); } finally { fs.rmSync(temp,{recursive:true,force:true}); } }});
