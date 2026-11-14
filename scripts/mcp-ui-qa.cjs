'use strict';

// Real Chromium/dashboard/MCP stdio integration using only a temporary local
// fixture. No QQ login, LLM request, external site, package install or shell.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mcp-ui-'));
const artifacts = process.env.QQ_UI_ARTIFACT_DIR || os.tmpdir();
fs.mkdirSync(artifacts, { recursive: true });
const fixture = path.join(temp, 'mcp-fixture.cjs'), events = path.join(temp, 'events.jsonl'), definition = path.join(temp, 'definition.txt');
fs.writeFileSync(definition, 'v1');
fs.writeFileSync(fixture, `
const fs=require('node:fs'),readline=require('node:readline');
const [events,definition]=process.argv.slice(2);
fs.appendFileSync(events,JSON.stringify({event:'start',pid:process.pid,hasSecret:process.env.SAMPLE_SECRET==='UI_MCP_SECRET'})+'\\n');
const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 let q;try{q=JSON.parse(line)}catch{return}if(q.id===undefined)return;
 fs.appendFileSync(events,JSON.stringify({event:q.method})+'\\n');
 if(q.method==='initialize')return reply(q.id,{protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'local-ui-fixture',version:'1'}});
 if(q.method==='ping')return reply(q.id,{});
 if(q.method==='tools/list')return reply(q.id,{tools:[
  {name:'list_notes',title:'读取笔记',description:'读取本地演示笔记 '+fs.readFileSync(definition,'utf8')+' <img src=x onerror="window.__mcpXss=1">',inputSchema:{type:'object',properties:{query:{type:'string'}},additionalProperties:false},annotations:{readOnlyHint:true}},
  {name:'add_note',title:'增加笔记',description:'修改演示笔记',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']},annotations:{readOnlyHint:false}},
  {name:'unsupported',description:'远程引用不能自动获取',inputSchema:{type:'object',properties:{value:{$ref:'https://example.invalid/schema.json'}}}}
 ]});
 if(q.method==='tools/call')return reply(q.id,{content:[{type:'text',text:'fixture result'}]});
 reply(q.id,{});
});
process.stdin.on('end',()=>process.exit(0));
`);
let app, browser;
const logs=()=>fs.existsSync(events)?fs.readFileSync(events,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
const pass=message=>console.log('PASS',message);
async function until(check,label,timeout=10000){const deadline=Date.now()+timeout;while(!await check()){if(Date.now()>deadline)throw new Error(label);await new Promise(resolve=>setTimeout(resolve,30));}}
(async()=>{
 const {createDashboard}=await import(root+'/src/server.mjs');
 app=createDashboard({dataDir:path.join(temp,'data'),installerFactory:()=>({environment:async()=>({}),status:async()=>[],dispose:async()=>{}}),runtimeFactory:()=>({status:()=>({connected:false,accountId:'',metrics:{}}),reload:async()=>{},stop:async()=>{},invalidateMemory(){},invalidateTools(){}})});
 const address=await app.listen(0),base='http://127.0.0.1:'+address.port;
 const directory=await(await fetch(base+'/api/accounts')).json();
 async function post(url,body){const response=await fetch(base+url,{method:'POST',headers:{'content-type':'application/json','x-dashboard-token':directory.csrfToken,origin:base},body:JSON.stringify(body)});const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result;}
 const a=await post('/api/accounts',{name:'MCP 主账号',platform:'qq',qqNumber:'12345001'}),b=await post('/api/accounts',{name:'MCP 第二账号',platform:'qq',qqNumber:'12345002'});
 for(const entry of [a,b]){const store=app.accounts.get(entry.account.id).store,state=store.getState();state.draft.chat.enabled=true;state.draft.models.deepseek.enabled=true;state.draft.chat.persona='原始人格';state.draft.groups=[{id:'98765001',name:'工具测试群',mode:'social',read:true,send:true,social:{enabled:true}}];state.applied=structuredClone(state.draft);store.restoreState(state);store.recordSetupCompleted(state.draft.botQQ);store.setSecret('deepseekApiKey','LOCAL_FIXTURE_API_KEY');}
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base);await page.waitForFunction(()=>document.querySelector('#server-label').textContent==='管理服务可访问');
 await page.locator('[data-page="connections"]').click();await page.locator('[data-open-account="'+a.account.id+'"]').click();await page.locator('#persona-editor>summary').click();await page.locator('[data-config="chat.persona"]').fill('导入 MCP 时保留的人格输入');
 await page.locator('[data-page="modules"]').click();await page.locator('#mcp-section>summary').click();
 assert.equal(await page.locator('#qq-context-tools-enabled').isChecked(),false);assert.equal(await page.locator('#tool-catalog-mode').inputValue(),'auto');
 await page.locator('#qq-context-tools-enabled').check();await page.locator('#tool-catalog-mode').selectOption('all');
 const qqGrant=page.locator('[data-plugin-tool="qq:current_group_recent"]');await qqGrant.locator('[data-tool-grant-enable]').check();await qqGrant.locator('[data-tool-grant-field="groupIds"]').fill('98765001');
 const {listBuiltinQQTools}=await import(root+'/src/qq-tools.mjs');
 assert.equal(await page.locator('[data-plugin-tool^="qq:"]').count(),listBuiltinQQTools().length,'内置 QQ MCP 展示与后端一致的完整能力目录');
 const qqPoke=page.locator('[data-plugin-tool="qq:poke_member"]');
 await qqPoke.locator('[data-tool-grant-enable]').check();await qqPoke.locator('[data-tool-grant-field="groupIds"]').fill('98765001');await qqPoke.locator('[data-tool-grant-field="userIds"]').fill('333333');await qqPoke.locator('[data-tool-grant-write]').check();
 await page.locator('#mcp-add').click();
 await page.locator('#mcp-service-label').fill('本地 MCP 演示');await page.locator('#mcp-service-command').fill(process.execPath);await page.locator('#mcp-service-args').fill(JSON.stringify([fixture,events,definition]));
 await page.locator('[data-mcp-add-secret="env"]').click();await page.locator('#mcp-env-rows [data-mcp-secret-key]').fill('SAMPLE_SECRET');await page.locator('#mcp-env-rows [data-mcp-secret-value]').fill('UI_MCP_SECRET');await page.locator('#mcp-service-save').click();
 await page.waitForSelector('[data-mcp-server]');assert.equal(logs().length,0,'添加配置不得启动进程');
 const serverId=await page.locator('[data-mcp-server]').first().getAttribute('data-mcp-server');
 const card=page.locator('[data-mcp-server="'+serverId+'"]');assert.equal(await card.locator('[data-mcp-server-enabled]').isChecked(),false);
 let finishImport;
 const importRoute='**/api/accounts/'+a.account.id+'/mcp/import';
 await page.route(importRoute,async route=>{const response=await route.fetch();await new Promise(resolve=>{finishImport=resolve;});await route.fulfill({response});});
 await page.locator('#mcp-import').click();await page.locator('#mcp-import-json').fill(JSON.stringify({mcpServers:{'remote-sample':{url:'http://127.0.0.1:9999/mcp',type:'http',headers:{Authorization:'REMOTE_IMPORT_SECRET'},enabled:true}}}));await page.locator('#mcp-import-submit').click();
 await page.waitForFunction(()=>document.querySelector('#mcp-import-json').readOnly);await until(()=>Boolean(finishImport),'导入路由未返回');
 await page.locator('#mcp-import-json').press('Escape');assert.equal(await page.locator('#mcp-import-dialog').evaluate(e=>e.open),true,'导入尚未完成时不能关闭并覆盖迟到结果');assert.equal(await page.locator('#mcp-import-cancel').isDisabled(),true);finishImport();
 await page.waitForFunction(()=>!document.querySelector('#mcp-import-dialog').open);await page.unroute(importRoute);assert.equal(logs().length,0,'导入配置不得启动服务');
 const firstStore=app.accounts.get(a.account.id).store;assert.equal(firstStore.getState().draft.chat.persona,'导入 MCP 时保留的人格输入');assert.equal(firstStore.getConfig().chat.persona,'原始人格');
 const imported=firstStore.getState().draft.mcp.servers.find(item=>item.id!==serverId);assert.equal(imported.enabled,false);assert.equal(firstStore.getDraftSecret('mcpSecret:'+imported.id+':header:authorization'),'REMOTE_IMPORT_SECRET');
 const publicState=await(await fetch(base+'/api/accounts/'+a.account.id+'/state')).text();assert.ok(!publicState.includes('UI_MCP_SECRET')&&!publicState.includes('REMOTE_IMPORT_SECRET'),'公开状态不得回显密钥');
 assert.equal(await page.locator('#mcp-import-json').inputValue(),'');
 pass('手动与JSON导入均停用、不执行，密钥独立加密且保留其他未保存输入');
 // Another window changes the target while confirmation remains open.
 await card.locator('[data-mcp-action="test"]').click();assert.match(await page.locator('#dialog-content').textContent(),/启动器可能下载并运行第三方代码/);
 const concurrentConfig=firstStore.getState().draft;concurrentConfig.mcp.servers.find(server=>server.id===serverId).args.push('changed-after-confirmation');
 let concurrentSaved=await post('/api/accounts/'+a.account.id+'/config/save',{config:concurrentConfig});await page.evaluate(()=>document.querySelector('#refresh-state').click());
 await page.waitForFunction(revision=>document.querySelector('#config-detail').textContent.includes('已保存版本 '+revision),concurrentSaved.revision);await page.locator('#dialog-confirm').click();
 await page.waitForFunction(()=>document.querySelector('#toast-region').textContent.includes('确认期间'));assert.equal(logs().length,0,'确认旧目标后不能运行后台刚替换的新目标');
 concurrentConfig.mcp.servers.find(server=>server.id===serverId).args.pop();concurrentSaved=await post('/api/accounts/'+a.account.id+'/config/save',{config:concurrentConfig});await page.evaluate(()=>document.querySelector('#refresh-state').click());await page.waitForFunction(revision=>document.querySelector('#config-detail').textContent.includes('已保存版本 '+revision),concurrentSaved.revision);
 await card.locator('[data-mcp-action="test"]').click();assert.match(await page.locator('#dialog-title').textContent(),/启动本地/);assert.equal(logs().length,0,'测试确认前不得启动');await page.locator('#dialog-confirm').click();
 await page.waitForFunction(id=>document.querySelector('[data-mcp-server="'+id+'"] .mcp-tool-definitions')?.textContent.includes('list_notes'),serverId);
 assert.equal(logs().filter(item=>item.event==='start').length,1);assert.equal(logs().find(item=>item.event==='start').hasSecret,true);assert.equal(logs().some(item=>item.event==='tools/call'),false);
 assert.equal(await page.evaluate(()=>window.__mcpXss),undefined);assert.equal(await card.locator('img').count(),0);
 const readTool=card.locator('[data-mcp-tool="list_notes"]'),writeTool=card.locator('[data-mcp-tool="add_note"]'),unsupported=card.locator('[data-mcp-tool="unsupported"]');
 assert.equal(await readTool.locator('[data-mcp-approval-field="enabled"]').isChecked(),false);assert.equal(await readTool.locator('[data-mcp-approval-field="effect"]').inputValue(),'write','只读hint不能默认授予read');assert.equal(await unsupported.locator('[data-mcp-confirm-tool]').isDisabled(),true);assert.match(await unsupported.textContent(),/暂不支持|引用|远程/);
 await readTool.locator('[data-mcp-approval-field="enabled"]').check();await readTool.locator('[data-mcp-approval-field="effect"]').selectOption('read');await readTool.locator('[data-mcp-confirm-tool]').click();
 await writeTool.locator('[data-mcp-approval-field="enabled"]').check();await writeTool.locator('[data-mcp-confirm-tool]').click();await card.locator('[data-mcp-server-enabled]').check();
 const cat=app.accounts.get(a.account.id).mcpManager.catalog(serverId),readId=cat.tools.find(tool=>tool.name==='list_notes').id,writeId=cat.tools.find(tool=>tool.name==='add_note').id;
 const readGrant=card.locator('[data-plugin-tool="'+readId+'"]'),writeGrant=card.locator('[data-plugin-tool="'+writeId+'"]');
 await readGrant.locator('[data-tool-grant-enable]').check();await readGrant.locator('[data-tool-grant-field="groupIds"]').fill('98765001');
 await writeGrant.locator('[data-tool-grant-enable]').check();await writeGrant.locator('[data-tool-grant-field="groupIds"]').fill('98765001');await writeGrant.locator('[data-tool-grant-field="userIds"]').fill('333333');await writeGrant.locator('[data-tool-grant-write]').check();await page.locator('#tool-call-enabled').check();
 await page.locator('[data-page="scenarios"]').click();await page.locator('[data-scenario-tab="permissions"]').click();await page.locator('.group-social-settings>summary').click();await page.locator('.group-social-advanced>summary').click();
 assert.equal(await page.locator('[data-group-social-tool="'+writeId+'"]').count(),0,'写工具不能成为主动素材工具');await page.locator('[data-group-social-tool="'+readId+'"]').check();
 assert.equal(await page.locator('[data-group-social-tool="qq:current_group_recent"]').count(),1);assert.equal(await page.locator('[data-group-social-tool="qq:current_group_search"]').count(),1);await page.locator('[data-group-social-tool="qq:current_group_recent"]').check();
 for(const id of ['poke_member','send_message','react_message'])assert.equal(await page.locator('[data-group-social-tool="qq:'+id+'"]').count(),0,'QQ写动作不能成为后台只读素材工具');
 for(const id of ['current_group_members','current_group_member'])assert.equal(await page.locator('[data-group-social-tool="qq:'+id+'"]').count(),1);
 await page.locator('[data-page="modules"]').click();
 pass('真实stdio发现、schema不支持提示、只读建议不授权、双hash审批与群/调用人授权、主动只读工具');
 // Metadata drift must reset UI approval even while account grants remain.
 fs.writeFileSync(definition,'v2');await card.locator('[data-mcp-action="test"]').click();await page.locator('#dialog-confirm').click();
 await page.waitForFunction(id=>document.querySelector('[data-mcp-server="'+id+'"] [data-mcp-tool="list_notes"]')?.textContent.includes('v2'),serverId);
 assert.equal(await readTool.locator('[data-mcp-approval-field="enabled"]').isChecked(),false);assert.equal(await readTool.locator('[data-mcp-approval-field="effect"]').inputValue(),'write');assert.match(await readTool.textContent(),/需重新确认/);
 await readTool.locator('[data-mcp-approval-field="enabled"]').check();await readTool.locator('[data-mcp-approval-field="effect"]').selectOption('read');await readTool.locator('[data-mcp-confirm-tool]').click();
 // Credential changes invalidate the old endpoint approval before any request.
 await card.locator('[data-mcp-action="edit"]').click();assert.equal(await page.locator('#mcp-env-rows [data-mcp-secret-value]').inputValue(),'','已保存密码不得回显');await page.locator('#mcp-env-rows [data-mcp-secret-value]').fill('CHANGED_MCP_SECRET');await page.locator('#mcp-service-save').click();
 assert.equal(await card.locator('[data-mcp-server-enabled]').isChecked(),false);assert.equal(await readTool.locator('[data-mcp-confirm-tool]').isDisabled(),true);assert.match(await card.textContent(),/重新测试/);
 // Restore the original secret, retest and confirm explicitly; no silent reuse.
 await card.locator('[data-mcp-action="edit"]').click();await page.locator('#mcp-env-rows [data-mcp-secret-value]').fill('UI_MCP_SECRET');await page.locator('#mcp-service-save').click();await card.locator('[data-mcp-action="test"]').click();const restoredTestResponse=page.waitForResponse(response=>response.url().endsWith('/mcp/test')&&response.request().method()==='POST');await page.locator('#dialog-confirm').click();assert.ok((await restoredTestResponse).ok());
 await page.waitForFunction(id=>!document.querySelector('[data-mcp-server="'+id+'"] [data-mcp-action="test"]').disabled&&!document.querySelector('[data-mcp-server="'+id+'"] [data-mcp-tool="list_notes"] [data-mcp-confirm-tool]').disabled,serverId);
 await readTool.locator('[data-mcp-approval-field="enabled"]').check();await readTool.locator('[data-mcp-approval-field="effect"]').selectOption('read');await readTool.locator('[data-mcp-confirm-tool]').click();
 await writeTool.locator('[data-mcp-approval-field="enabled"]').check();await writeTool.locator('[data-mcp-confirm-tool]').click();await card.locator('[data-mcp-server-enabled]').check();
 await page.locator('#save-draft').click();await page.waitForFunction(()=>document.querySelector('#save-draft').disabled&&!document.querySelector('#save-draft').classList.contains('is-loading'));await page.locator('#apply-config').click();await page.waitForFunction(()=>!document.querySelector('#apply-config').classList.contains('is-loading')&&document.querySelector('#apply-config').disabled);await app.accounts.get(a.account.id).mcpManager.ready();await page.locator('#refresh-state').click();
 assert.equal(firstStore.getConfig().mcp.servers.find(server=>server.id===serverId).tools.filter(tool=>tool.enabled).length,2,JSON.stringify(firstStore.getConfig().mcp.servers.find(server=>server.id===serverId).tools.map(({name,enabled,effect})=>({name,enabled,effect}))));assert.equal(firstStore.getConfig().permissions.released,false);assert.equal(logs().some(item=>item.event==='tools/call'),false);
 pass('定义漂移与凭据变化必须重新确认，保存应用真实连接且不执行工具、不释放发送权限');
 await page.screenshot({path:path.join(artifacts,'QQ_Service-mcp-tools-preview.png'),fullPage:true});
 // A real active stdio process exits while its last tested directory is cached.
 const manager=app.accounts.get(a.account.id).mcpManager,originalCatalog=manager.catalog;
 const healthy=await(await fetch(base+'/api/accounts/'+a.account.id+'/state')).json();
 const stale=structuredClone(manager.catalog()).map(record=>(record.serverId||record.id)===serverId?{...record,status:'tested',state:'tested',connected:false}:record);
 manager.catalog=id=>id===undefined?structuredClone(stale):structuredClone(stale.find(record=>(record.serverId||record.id)===id)||null);
 const frozenStateRoute='**/api/accounts/'+a.account.id+'/state';await page.route(frozenStateRoute,route=>route.fulfill({json:healthy}));
 process.kill(logs().filter(item=>item.event==='start').at(-1).pid,'SIGTERM');await until(()=>manager.status().some(status=>(status.serverId||status.id)===serverId&&status.status==='error'),'stdio退出后状态未失效');
 await page.locator('#mcp-refresh').click();await page.waitForFunction(id=>document.querySelector('[data-mcp-server="'+id+'"]>.custom-plugin-heading>.pill')?.textContent==='连接失败',serverId);
 assert.match(await card.locator(':scope>.custom-plugin-heading>.pill').getAttribute('class'),/pill-red/,'旧已测试目录不得盖住当前连接错误');
 assert.match(await card.locator('[data-mcp-issue]').textContent(),/关闭|连接|MCP/);
 await page.unroute(frozenStateRoute);manager.catalog=originalCatalog;await manager.reload();await manager.ready();await page.locator('#refresh-state').click();
 pass('当前stdio真实失联优先显示红色错误，MCP刷新更新live状态，旧tested缓存不会显示绿灯');
 await page.locator('#account-selector').selectOption(b.account.id);await page.waitForFunction(()=>document.querySelector('#mcp-service-cards').textContent.includes('还没有 MCP 服务'));assert.equal(await page.locator('#mcp-service-cards').textContent().then(text=>text.includes('本地 MCP 演示')),false);
 assert.equal(await page.locator('#qq-context-tools-enabled').isChecked(),false);assert.equal(await page.locator('#tool-catalog-mode').inputValue(),'auto');
 await page.locator('#mcp-add').click();await page.locator('#mcp-service-label').fill('第二账号远程');await page.locator('#mcp-service-transport').selectOption('http');await page.locator('#mcp-service-url').fill('https://example.invalid/mcp');await page.locator('[data-mcp-add-secret="header"]').click();await page.locator('#mcp-header-rows [data-mcp-secret-key]').fill('Authorization');await page.locator('#mcp-header-rows [data-mcp-secret-value]').fill('SECOND_ACCOUNT_SECRET');await page.locator('#mcp-service-save').click();
 assert.equal(await page.locator('[data-mcp-server]').count(),1);await page.locator('[data-mcp-action="edit"]').click();await page.locator('#mcp-service-transport').selectOption('sse');await page.locator('#mcp-service-url').fill('https://example.invalid/sse');await page.locator('#mcp-service-save').click();
 await page.locator('#account-selector').selectOption(a.account.id);await page.waitForSelector('[data-mcp-server="'+serverId+'"]');assert.equal(await page.locator('[data-mcp-server]').count(),2,'切换账号不能串入另一账号的远程服务');
 await page.setViewportSize({width:650,height:900});await page.screenshot({path:path.join(artifacts,'QQ_Service-mcp-tools-narrow.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.setViewportSize({width:1440,height:1000});await card.locator('[data-mcp-action="delete"]').click();await page.locator('#dialog-confirm').click();await page.waitForFunction(id=>!document.querySelector('[data-mcp-server="'+id+'"]'),serverId);
 await page.locator('#save-draft').click();await page.waitForFunction(()=>document.querySelector('#save-draft').disabled&&!document.querySelector('#save-draft').classList.contains('is-loading'));
 const finalDraft=firstStore.getState().draft;assert.equal(finalDraft.mcp.servers.length,1);assert.equal(finalDraft.mcp.servers[0].id,imported.id);assert.ok(!finalDraft.tools.grants.some(grant=>grant.tool.startsWith('mcp:'+serverId+'/')));assert.ok(!finalDraft.groups[0].social.readTools.some(tool=>tool.startsWith('mcp:'+serverId+'/')));assert.equal(firstStore.getConfig().mcp.servers.length,2,'移除草稿不应暗中应用运行配置');assert.equal(finalDraft.tools.builtinQQ,true);assert.equal(finalDraft.tools.catalogMode,'all');assert.ok(finalDraft.tools.grants.some(grant=>grant.tool==='qq:current_group_recent'),'移除MCP不能误删QQ工具授权');assert.ok(finalDraft.groups[0].social.readTools.includes('qq:current_group_recent'));
 assert.deepEqual(errors,[]);pass('HTTP/SSE编辑、跨账号隔离、密钥不回显、窄屏与移除仅清该服务引用，QQ上下文工具默认关闭且独立授权');
 const startsBeforeExamples=logs().filter(item=>item.event==='start').length;
 await page.locator('#mcp-example-bilibili').click();assert.equal(await page.locator('#mcp-service-command').inputValue(),'node');assert.deepEqual(JSON.parse(await page.locator('#mcp-service-args').inputValue()),['{appDir}/examples/mcp/bilibili.mjs']);assert.equal(await page.locator('[data-mcp-server]').count(),1,'示例链接只能填表不能自动保存');await page.locator('#mcp-service-cancel').click();
 await page.locator('#mcp-example-notes').click();assert.deepEqual(JSON.parse(await page.locator('#mcp-service-args').inputValue()),['{appDir}/examples/mcp/local-notes.mjs']);await page.locator('#mcp-service-save').click();assert.equal(logs().filter(item=>item.event==='start').length,startsBeforeExamples);
 const notesCard=page.locator('[data-mcp-server]').filter({has:page.locator('h3',{hasText:'计算与临时笔记'})});const notesId=await notesCard.getAttribute('data-mcp-server');assert.equal(await notesCard.locator('[data-mcp-server-enabled]').isChecked(),false);
 await notesCard.locator('[data-mcp-action="test"]').click();const notesResponse=page.waitForResponse(response=>response.url().endsWith('/mcp/test')&&response.request().method()==='POST');await page.locator('#dialog-confirm').click();assert.ok((await notesResponse).ok());await page.waitForFunction(id=>document.querySelector('[data-mcp-server="'+id+'"] [data-mcp-tool="calculate"]'),notesId);
 assert.equal(await notesCard.locator('[data-mcp-tool="list_notes"]').count(),1);assert.equal(await notesCard.locator('[data-mcp-tool="add_note"]').count(),1);
 const calculate=notesCard.locator('[data-mcp-tool="calculate"]');await calculate.locator('[data-mcp-approval-field="enabled"]').check();await calculate.locator('[data-mcp-approval-field="effect"]').selectOption('read');await calculate.locator('[data-mcp-confirm-tool]').click();
 await page.setViewportSize({width:1250,height:900});await page.locator('#toast-region').evaluate(element=>element.replaceChildren());await notesCard.screenshot({path:path.join(artifacts,'QQ_Service-mcp-built-in-example.png'),animations:'disabled'});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);pass('内置笔记和Bilibili入口仅填表，笔记示例真实SDK发现成功，1250px干净界面截图');
 await page.locator('[data-page="settings"]').click();
 const storage=page.locator('#memory-storage-card');await storage.locator('[data-storage-directory]').fill(path.join(temp,'my-memories'));
 const stagedResponse=page.waitForResponse(response=>response.url().endsWith('/api/memory-storage')&&response.request().method()==='POST');await storage.locator('[data-storage-save]').click();assert.ok((await stagedResponse).ok());
 await page.waitForFunction(()=>document.querySelector('#memory-storage-card [data-storage-pending]').textContent.includes('my-memories'));
 assert.equal(app.accounts.get(a.account.id).store.memoryPath.includes('my-memories'),false,'保存目录不能热迁正在使用的记忆库');
 await storage.locator('[data-storage-default]').click();const resetResponse=page.waitForResponse(response=>response.url().endsWith('/api/memory-storage')&&response.request().method()==='POST');await storage.locator('[data-storage-save]').click();assert.ok((await resetResponse).ok());
 await page.waitForFunction(()=>!document.querySelector('#memory-storage-card [data-storage-save]').disabled);
 assert.equal(await storage.locator('[data-storage-directory]').inputValue(),'');assert.deepEqual(errors,[]);
 await page.screenshot({path:path.join(artifacts,'QQ_Service-memory-directory.png'),fullPage:true});
 pass('内置QQ MCP动作独立授权、后台只读清单裁剪、真实设置API保存目录和取消待迁移均通过');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{try{await browser?.close();}finally{try{await app?.close();}finally{fs.rmSync(temp,{recursive:true,force:true});}}});
