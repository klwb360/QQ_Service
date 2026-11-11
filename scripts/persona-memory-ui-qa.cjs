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
  const partial=await post('/api/accounts',{name:'尚未完成配置的账号',platform:'qq',qqNumber:'12345003'});
  for (const [index,account] of [first,second].entries()) {
    const service=app.accounts.get(account.account.id), store=service.store;
    const state=store.getState();
    const c=state.draft;c.botQQ=index?'12345002':'12345001';c.chat.enabled=true;c.chat.persona=index?'第二账号独立人格':'自然简短，喜欢聊游戏';c.chat.social.name=index?'小二':'小Q';c.models.deepseek.enabled=true;
    c.groups=[{id:'98765001',name:'测试群一',mode:'social',read:true,send:false,social:{enabled:true}},{id:'98765002',name:'测试群二',mode:'social',read:true,send:false,social:{enabled:true}}];
    state.applied=structuredClone(c);state.revision=2;state.appliedRevision=2;store.restoreState(state);store.recordSetupCompleted(c.botQQ);store.setSecret('deepseekApiKey','LOCAL_UI_FIXTURE_KEY');
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
  async function assertAccountActions(completed, released=false) {
    await page.waitForFunction(({completed,released})=>{
      const visible=e=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
      const footer=document.querySelector('#account-save-footer');
      const rows=[...document.querySelectorAll('[data-flow-actions]')].filter(visible);
      const start=document.querySelector('[data-setup-start]');
      return visible(footer)===completed&&rows.length===(completed?0:1)
        &&document.querySelectorAll('[data-setup-start]').length===1
        &&(!completed||visible(start)===!released);
    },{completed,released});
    if (completed) {
      assert.equal(await page.locator('#account-save-footer').evaluate(e=>e.closest('[data-setup-panel]')?.dataset.setupPanel),'verification');
      assert.equal(await page.locator('[data-flow-stage]:visible').count(),4);
      assert.equal(await page.locator('#account-save-footer .config-actions [data-setup-start]').count(),1);
      assert.equal(await page.locator('[data-setup-apply]:visible,[data-setup-skip]:visible').count(),0,'完整账号不应保留保存继续/稍后按钮');
    }
  }
  await assertAccountActions(true);
  await page.locator(`[data-open-account="${partial.account.id}"]`).click();
  await assertAccountActions(false);
  await page.locator('#account-llm-source').selectOption('deepseek');
  await page.locator('[data-secret="deepseekApiKey"]').fill('PARTIAL_LOCAL_FIXTURE_KEY');
  await page.locator('[data-config="models.deepseek.model"]').fill('partial-custom-model');
  await page.locator('[data-config="botQQ"]').fill('12345003');
  await assertAccountActions(false);
  await page.locator('[data-flow-actions="identity"] [data-setup-skip]').click();
  await assertAccountActions(false);
  await page.locator('[data-flow-actions="connection"] [data-setup-back="identity"]').click();
  await assertAccountActions(false);
  await page.locator('#refresh-state').click();
  assert.equal(await page.locator('[data-config="models.deepseek.model"]').inputValue(),'partial-custom-model');
  await assertAccountActions(false);
  await page.locator(`[data-open-account="${first.account.id}"]`).click();
  await assertAccountActions(true);
  // Model selection is editable and stays local: no discovery/test request.
  const modelInput=page.locator('[data-config="models.deepseek.model"]');
  const modelBox=modelInput.locator('..');
  await modelInput.fill('private-deepseek-custom-model');
  const beforePickerHeight=await page.locator('#account-workspace').evaluate(e=>e.getBoundingClientRect().height);
  await modelBox.locator('[data-model-toggle]').click();
  let menu=page.locator('.model-picker-panel:popover-open');
  assert.deepEqual(await menu.locator('[data-model-option]').allTextContents(),['deepseek-flash','deepseek-v4-pro']);
  assert.equal(await modelInput.inputValue(),'private-deepseek-custom-model');
  assert.ok(Math.abs(await page.locator('#account-workspace').evaluate(e=>e.getBoundingClientRect().height)-beforePickerHeight)<1,'模型菜单不应撑高账号容器');
  assert.equal(await menu.evaluate(e=>{const r=e.getBoundingClientRect();return !!document.elementFromPoint(r.left+20,r.top+20)?.closest('.model-picker-panel')}),true,'模型菜单应显示在顶层');
  await menu.locator('[data-model-option="deepseek-flash"]').click();
  assert.equal(await modelInput.inputValue(),'deepseek-flash');
  await modelBox.locator('[data-model-toggle]').click();
  assert.equal(await menu.locator('[data-model-option]').count(),2,'已有完整值仍应列出其他预设');
  await modelInput.press('ArrowDown');await modelInput.press('Enter');
  assert.equal(await modelInput.inputValue(),'deepseek-v4-pro');
  await modelInput.fill('private-deepseek-custom-model');
  await modelInput.press('ArrowDown');await modelInput.press('Escape');
  assert.equal(await menu.count(),0);assert.equal(await modelInput.inputValue(),'private-deepseek-custom-model');
  await modelBox.locator('[data-model-toggle]').click();
  await page.locator('#page-caption').click();assert.equal(await menu.count(),0,'外点应关闭模型菜单');
  await modelBox.locator('[data-model-toggle]').click();
  await page.screenshot({path:path.join(artifacts,'QQ_Service-model-presets-preview.png'),fullPage:false});
  await page.locator('#account-llm-source').selectOption({label:'OpenAI API'});
  assert.equal(await menu.count(),0,'厂商切换应关闭旧预设');
  const vendors=[
    ['OpenAI API',['gpt-4.1','gpt-4.1-mini','gpt-4o','gpt-4o-mini']],
    ['阿里云百炼 / 通义',['qwen-plus','qwen-turbo','qwen-max']],
    ['智谱 GLM',['glm-5.3','glm-5.3-flash','glm-4.7']],
    ['Kimi / Moonshot',['kimi-k3.1-pro','kimi-k3.1-pro-highspeed','kimi-k3']],
    ['硅基流动',['deepseek-ai/DeepSeek-V3.2','Pro/deepseek-ai/DeepSeek-V3.2','Qwen/Qwen3.6-27B']],
    ['自定义兼容 API',[]]
  ];
  for (const [vendor,expected] of vendors) {
    await page.locator('#account-llm-source').selectOption({label:vendor});
    const card=page.locator('[data-api-card]:not(.hidden)');
    const input=card.locator('input[role="combobox"]');
    await input.fill('private/'+expected[0]);
    await card.locator('[data-model-toggle]').click();
    menu=page.locator('.model-picker-panel:popover-open');
    assert.deepEqual(await menu.locator('[data-model-option]').allTextContents(),expected);
    assert.equal(await input.inputValue(),'private/'+expected[0],'展开不得覆盖自定义模型');
    if (expected.length) {
      await menu.locator('[data-model-option]').first().click();assert.equal(await input.inputValue(),expected[0]);
      if (vendor==='Kimi / Moonshot') assert.match(await card.locator('.model-presets-note').textContent(),/温度由服务固定/);
    } else {assert.match(await menu.textContent(),/直接在输入框填写/);await input.fill('private-custom-model');await input.press('Enter');assert.equal(await menu.count(),0,'自定义输入按Enter应收起浮层');}
    await input.fill(expected[0] ? 'private-'+expected[0] : 'private-custom-model');
    assert.match(await card.locator('[data-config$=".temperature"]').locator('..').textContent(),/回答随机性（温度）/);
  }
  await page.locator('#account-llm-source').selectOption({label:'OpenAI API'});
  assert.equal(await page.locator('[data-api-card]:not(.hidden) input[role="combobox"]').inputValue(),'private-gpt-4.1');
  await page.locator('#account-llm-source').selectOption('deepseek');
  assert.equal(await modelInput.inputValue(),'private-deepseek-custom-model');
  assert.match(await page.locator('[data-config="models.deepseek.temperature"]').locator('..').textContent(),/回答随机性（温度）/);
  await modelBox.locator('[data-model-toggle]').click();
  await page.locator(`[data-open-account="${second.account.id}"]`).click();
  assert.equal(await page.locator('.model-picker-panel:popover-open').count(),0,'账号切换应关闭模型浮层');
  await page.locator(`[data-open-account="${first.account.id}"]`).click();
  assert.equal(await modelInput.inputValue(),'private-deepseek-custom-model','账号切换应保留未保存模型');
  await assertAccountActions(true);
  await page.locator(`[data-open-account="${partial.account.id}"]`).click();
  await assertAccountActions(false);
  assert.equal(await page.locator('[data-config="models.deepseek.model"]').inputValue(),'partial-custom-model');
  await page.locator(`[data-open-account="${first.account.id}"]`).click();
  await assertAccountActions(true);
  assert.equal(await modelInput.inputValue(),'private-deepseek-custom-model');
  const completedStore=app.accounts.get(first.account.id).store;
  const releasedState=completedStore.getState();releasedState.applied.permissions.released=true;completedStore.restoreState(releasedState);
  await page.locator('#refresh-state').click();
  await assertAccountActions(true,true);
  await page.locator('#save-draft').click();
  await page.waitForFunction(()=>document.querySelector('#save-draft').disabled&&!document.querySelector('#save-draft').classList.contains('is-loading'));
  assert.equal(completedStore.getState().draft.models.deepseek.model,'private-deepseek-custom-model');
  await assertAccountActions(true,true);
  await page.locator('#apply-config').click();
  await page.waitForFunction(()=>!document.querySelector('#apply-config').classList.contains('is-loading')&&document.querySelector('#config-label').textContent==='已保存');
  assert.equal(completedStore.getConfig().permissions.released,false);
  assert.equal(completedStore.isSetupCompleted('12345001'),true);
  await assertAccountActions(true);
  await page.locator('#refresh-state').click();await assertAccountActions(true);
  await page.locator('[data-config="botQQ"]').fill('12345999');await assertAccountActions(false);
  await page.locator('[data-config="botQQ"]').fill('12345001');await assertAccountActions(true);
  await page.locator('#persona-editor>summary').click();
  await page.locator('[data-config="chat.persona"]').fill('尚未保存的人格修改');
  await page.locator('#persona-preview').click();await page.waitForFunction(()=>!document.querySelector('#persona-preview-content').classList.contains('hidden'));
  assert.match(await page.locator('#persona-preview-content').textContent(),/尚未保存的人格修改/);
  assert.equal(app.accounts.get(first.account.id).store.getConfig().chat.persona,'自然简短，喜欢聊游戏');
  await page.locator('#refresh-state').click();await page.waitForTimeout(350);
  assert.equal(await page.locator('[data-config="chat.persona"]').inputValue(),'尚未保存的人格修改');
  assert.equal(await modelInput.inputValue(),'private-deepseek-custom-model','状态刷新应保留自定义模型');
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
  console.log('PASS Chromium real dashboard: partial/completed account footer/save/apply/read-only/identity switch, editable model presets/vendor/profile isolation/popover/keyboard, Chinese temperature help, persona draft preview/history, preserved unsaved form, SnowLuma gate, experience edit/pause/history/archive/delete, session reset, profile isolation, narrow layout');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{try { await browser?.close(); } finally { try { await app?.close(); } finally { fs.rmSync(temp,{recursive:true,force:true}); } }});
