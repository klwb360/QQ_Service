'use strict';

// Optional browser integration check against the real dashboard and runtime.
// Only a local OneBot server and injected model responses are used: this script
// never signs in to QQ, installs modules, or sends requests to paid providers.
// PLAYWRIGHT_MODULE_PATH=/path/to/playwright node scripts/onboarding-qa.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const projectDir = path.resolve(__dirname, '..');
const { WebSocketServer } = require(path.join(projectDir, 'node_modules', 'ws'));
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqservice-onboarding-qa-'));
const errors = [], checks = [], calls = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, browser, page, qq;
function pass(message) { checks.push(message); console.log(`PASS ${message}`); }
async function until(predicate, message, timeout = 10_000) {
  const stop = Date.now() + timeout;
  while (Date.now() < stop) { if (await predicate()) return; await delay(60); }
  throw new Error(message);
}
async function mockQQ(accountId) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const outbound = [], requests = [], peers = new Set();
  server.on('connection', socket => {
    peers.add(socket); socket.once('close', () => peers.delete(socket));
    socket.on('message', raw => {
      const packet = JSON.parse(raw.toString()); requests.push(packet);
      let data = {};
      if (packet.action === 'get_login_info') data = { user_id: Number(accountId), nickname: '本地模拟 QQ' };
      if (packet.action === 'get_group_list') data = [{ group_id: 98765001, group_name: '本地测试工作群' }, { group_id: 98765002, group_name: '未选择的测试群' }];
      if (packet.action.startsWith('send_')) { outbound.push(packet); data = { message_id: outbound.length }; }
      socket.send(JSON.stringify({ echo: packet.echo, status: 'ok', retcode: 0, data }));
    });
  });
  return { outbound, requests, url: `ws://127.0.0.1:${server.address().port}`,
    async event(groupId, messageId, text = '/ai 验证本地模型回复') {
      await until(() => peers.size > 0, '本地 OneBot 没有连接');
      for (const socket of peers) socket.send(JSON.stringify({ post_type: 'message', message_type: 'group', self_id: Number(accountId), user_id: 555555, group_id: Number(groupId), message_id: messageId, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text } }] }));
    },
    async notice(groupId, details) {
      await until(() => peers.size > 0, '本地 OneBot 没有连接');
      for (const socket of peers) socket.send(JSON.stringify({ post_type: 'notice', self_id: Number(accountId), user_id: 555555, group_id: Number(groupId), time: Math.floor(Date.now() / 1000), ...details }));
    },
    async close() { for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); },
  };
}
async function readState(accountId) {
  return page.evaluate(async id => {
    const response = await fetch(`/api/accounts/${encodeURIComponent(id)}/state`);
    if (!response.ok) throw new Error(`读取账号失败：${response.status}`);
    return response.json();
  }, accountId);
}
async function chooseStep(step) {
  await page.locator('[data-page="connections"]').click();
  if (!await page.locator('#account-workspace').isVisible()) {
    const id = await page.locator('#account-selector').inputValue();
    await page.locator(`#account-cards [data-open-account="${id}"]`).click();
  }
  await page.locator(`#account-setup-steps [data-setup-step="${step}"]`).click();
  await page.locator(`[data-setup-panel="${step}"]`).waitFor({ state: 'visible' });
}
async function chooseAccount(accountId) {
  await page.locator('[data-page="connections"]').click();
  await page.locator(`#account-cards [data-open-account="${accountId}"]`).click();
  await until(async () => (await page.locator('#account-selector').inputValue()) === accountId
    && await page.locator('#account-workspace').isVisible(), '未展开指定账号');
}
async function createAccount(name, number, { api = false, codex = false } = {}) {
  await page.locator('[data-page="connections"]').click();
  await page.locator('#create-account-entry').click();
  await page.locator('#new-account-qq').fill(number);
  await page.locator('#new-account-name').fill(name);
  await page.locator('#new-account-api').setChecked(api);
  await page.locator('#new-account-codex').setChecked(codex);
  const creating = page.waitForResponse(response => response.url().endsWith('/api/accounts') && response.request().method() === 'POST');
  await page.locator('#submit-create-account').click();
  const response = await creating;
  assert.equal(response.status(), 201, await response.text());
  const created = await response.json();
  await until(async () => await page.locator('#account-workspace').isVisible()
    && (await page.locator('#account-selector').inputValue()) === created.account.id, '创建后未展开账号');
  return created.account;
}
async function saveDraft(accountId) {
  // The progressive account page has per-step actions instead of the global
  // configuration bar. The full draft save remains on the scenarios page.
  await page.locator('[data-page="scenarios"]').click();
  const saving = page.waitForResponse(response => response.url().endsWith(`/api/accounts/${accountId}/config/save`) && response.request().method() === 'POST');
  await page.locator('#save-draft').click();
  const response = await saving;
  assert.equal(response.status(), 200, await response.text());
  const state = await response.json();
  await chooseStep('models');
  return state;
}
async function checkLegacyUpgrade() {
  await page.close();
  await app.close(); app = null;
  if (qq) await qq.close(); qq = await mockQQ('12345003');
  const { createDashboard } = await import(pathToFileURL(path.join(projectDir, 'src/server.mjs')));
  const { createInstaller } = await import(pathToFileURL(path.join(projectDir, 'src/installer.mjs')));
  const { createRuntime } = await import(pathToFileURL(path.join(projectDir, 'src/runtime.mjs')));
  const { createStore } = await import(pathToFileURL(path.join(projectDir, 'src/store.mjs')));
  const { DEFAULT_CONFIG } = await import(pathToFileURL(path.join(projectDir, 'src/config.mjs')));
  const dataDir = path.join(fixtureDir, 'legacy-data');
  const store = createStore(dataDir);
  store.setSecret('deepseekApiKey', 'qa-legacy-api-key');
  store.setSecret('napcatToken', 'qa-legacy-onebot-key');
  store.close();
  const legacy = structuredClone(DEFAULT_CONFIG);
  delete legacy.models.apis;
  Object.assign(legacy, { botQQ: '12345003', ownerQQ: '76543210' });
  Object.assign(legacy.qq, { enabled: true, wsUrl: qq.url });
  legacy.models.deepseek.enabled = true;
  legacy.chat.enabled = true;
  legacy.permissions = { released: true, privateReplies: false };
  legacy.groups = [
    { id: '7777001', name: '旧版前缀群', mode: 'social', read: true, send: true, trigger: 'prefix', prefix: '/old', probability: 0, cooldownSeconds: 9 },
    { id: '7777002', name: '旧版概率群', mode: 'work', read: true, send: false, trigger: 'casual', prefix: '/ai', probability: 0.19, cooldownSeconds: 37 },
  ];
  const saved = { draft: structuredClone(legacy), applied: structuredClone(legacy), previous: structuredClone(legacy), revision: 17, appliedRevision: 17 };
  const configFile = path.join(dataDir, 'config.json');
  const originalBytes = `${JSON.stringify(saved, null, 2)}\n`;
  fs.writeFileSync(configFile, originalBytes);
  app = createDashboard({ dataDir,
    installerFactory(context) { return { ...createInstaller(context), environment: async () => ({}), status: async () => [] }; },
    runtimeFactory(context) {
      return createRuntime({ ...context, providers: { deepseek: async args => { calls.push({ accountId: 'legacy', provider: 'deepseek', apiKey: args.apiKey }); return { provider: 'deepseek', text: '旧配置本地模拟回复' }; } } });
    },
  });
  const address = await app.listen(0);
  page = await browser.newPage({ viewport: { width: 1380, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.waitForFunction(() => document.querySelector('#server-label')?.textContent === '管理服务可访问');
  await chooseAccount('legacy');
  await chooseStep('models');
  assert.equal(await page.locator('#custom-api-cards [data-api-card]').count(), 0);
  await page.locator('[data-page="scenarios"]').click();
  await page.locator('[data-scenario-tab="permissions"]').click();
  const firstRow = page.locator('#group-rows [data-group-index="0"]');
  const secondRow = page.locator('#group-rows [data-group-index="1"]');
  await firstRow.locator('.group-trigger-picker summary').click();
  assert.equal(await firstRow.locator('[data-group-trigger="prefix"]').isChecked(), true);
  await secondRow.locator('.group-trigger-picker summary').click();
  assert.equal(await secondRow.locator('[data-group-trigger="casual"]').isChecked(), true);
  assert.equal(await firstRow.locator('[data-group-field="prefix"]').inputValue(), '/old');
  assert.equal(await secondRow.locator('[data-group-field="probability"]').inputValue(), '0.19');
  assert.equal(await secondRow.locator('[data-group-field="cooldownSeconds"]').inputValue(), '37');
  assert.equal(await secondRow.locator('[data-group-field="send"]').isChecked(), false);
  await delay(4300);
  let state = await readState('legacy');
  assert.equal(state.revision, 17);
  assert.equal(state.applied.permissions.released, true);
  assert.equal(state.pendingChanges, false);
  assert.equal(await page.locator('#save-draft').isDisabled(), true);
  assert.equal(fs.readFileSync(configFile, 'utf8'), originalBytes);
  pass('旧版无 models.apis / triggers 的配置直接打开和轮询不自动修改、变脏或撤销已授权权限，原前缀及概率参数保持');

  await firstRow.locator('[data-group-triggers-clear="0"]').click();
  assert.equal(await firstRow.locator('[data-group-trigger]:checked').count(), 0);
  await page.locator('#apply-config').click();
  await until(async () => (await readState('legacy')).appliedRevision > 17, '旧账号显式应用未完成');
  state = await readState('legacy');
  assert.equal(state.applied.permissions.released, false);
  assert.deepEqual(state.applied.groups[0].triggers, []);
  assert.deepEqual(state.applied.groups[1].triggers, ['casual']);
  assert.equal(state.applied.groups[1].probability, 0.19);
  assert.equal(state.applied.groups[1].send, false);
  await page.locator('#release-permissions').click();
  await page.locator('#app-dialog').waitFor({ state: 'visible' });
  await page.locator('#dialog-confirm').click();
  await until(async () => (await readState('legacy')).applied.permissions.released, '旧账号重新显式授权未完成');
  const beforeCalls = calls.length, beforeSent = qq.outbound.length;
  await qq.event('7777001', 'qa-cleared-prefix', '/old 清空后不得自动触发');
  await delay(250);
  assert.equal(calls.length, beforeCalls);
  assert.equal(qq.outbound.length, beforeSent);
  pass('只有显式应用撤销旧权限；明确清空触发事件后保留空数组，重新授权也不会回退旧前缀触发');
}

(async () => {
  try {
    const { createDashboard } = await import(pathToFileURL(path.join(projectDir, 'src/server.mjs')));
    const { createInstaller } = await import(pathToFileURL(path.join(projectDir, 'src/installer.mjs')));
    const { createRuntime } = await import(pathToFileURL(path.join(projectDir, 'src/runtime.mjs')));
    app = createDashboard({ dataDir: path.join(fixtureDir, 'data'),
      installerFactory(context) {
        const actual = createInstaller(context);
        const cli = path.join(context.dataDir, 'modules', 'codex', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
        fs.mkdirSync(path.dirname(cli), { recursive: true });
        fs.writeFileSync(cli, '// simulated providers; never executed\n');
        let loggedIn = false;
        return { ...actual, environment: async () => ({ platform: process.platform, node: { supported: true }, npm: { available: true }, docker: { installed: false, running: false, message: '本地验收未安装 Docker；原生路线仍可用' } }),
          status: async () => [{ id: 'napcat', state: 'not_installed', installed: false }, { id: 'codex', state: 'installed', installed: true }],
          codexStatus: async () => ({ loggedIn, message: loggedIn ? '模拟官方订阅已登录' : '模拟官方订阅未登录' }),
          loginCodex: async onLog => { onLog('仅模拟本地订阅授权；没有外部请求'); loggedIn = true; return { loggedIn, message: '模拟官方订阅已登录' }; },
          install: async () => { throw new Error('浏览器验收不允许实际安装模块'); },
        };
      },
      runtimeFactory(context) {
        const model = provider => async args => { calls.push({ accountId: context.accountId, provider, apiKey: args.apiKey, messages: args.messages }); return { provider, text: '本地模拟模型已回复' }; };
        return createRuntime({ ...context, providers: { deepseek: model('deepseek'), compatible: async args => model(args.provider)(args), codex: model('codex') } });
      },
    });
    const address = await app.listen(0);
    browser = await chromium.launch({ executablePath: process.env.QQBRIDGE_TEST_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-gpu'] });
    page = await browser.newPage({ viewport: { width: 1380, height: 1000 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.waitForFunction(() => document.querySelector('#server-label')?.textContent === '管理服务可访问');
    await page.locator('[data-page="connections"]').click();
    assert.equal(await page.locator('#account-cards [data-open-account]').count(), 0);
    assert.equal(await page.locator('#account-workspace').isVisible(), false);
    assert.equal(await page.locator('#new-account-form').isVisible(), false);
    assert.equal(await page.locator('#create-account-entry').isVisible(), true);
    assert.equal(await page.locator('.config-bar').isVisible(), false);
    pass('空账号控制页只有创建入口，未预先展开模型、连接与权限参数');

    // Remaining interactions intentionally use the same visible controls as a
    // user. Keep endpoint calls limited to independent state assertions.
    const first = await createAccount('本地验收账号 A', '12345001', { api: true, codex: true });
    await chooseStep('identity');
    assert.equal(await page.locator('[data-config="models.deepseek.enabled"]').isChecked(), true);
    assert.equal(await page.locator('[data-config="models.codex.enabled"]').isChecked(), true);
    assert.equal((await readState(first.id)).applied.permissions.released, false);
    pass('创建账号可多选 API 与 ChatGPT 订阅，默认不释放权限');

    await chooseStep('models');
    await page.locator('[data-secret="deepseekApiKey"]').fill('qa-local-key-account-a');
    await page.locator('[data-page="scenarios"]').click();
    await page.locator('[data-scenario-tab="tasks"]').click();
    await page.locator('[data-config="chat.persona"]').fill('账号 A 未保存的独立风格');
    const second = await createAccount('本地验收账号 B', '12345002', { api: true });
    await chooseStep('models');
    await page.locator('[data-secret="deepseekApiKey"]').fill('qa-local-key-account-b');
    await page.locator('[data-page="scenarios"]').click();
    await page.locator('[data-scenario-tab="tasks"]').click();
    await page.locator('[data-config="chat.persona"]').fill('账号 B 未保存的独立风格');
    await chooseAccount(first.id);
    await chooseStep('models');
    assert.equal(await page.locator('[data-secret="deepseekApiKey"]').inputValue(), 'qa-local-key-account-a');
    await page.locator('[data-page="scenarios"]').click();
    await page.locator('[data-scenario-tab="tasks"]').click();
    assert.equal(await page.locator('[data-config="chat.persona"]').inputValue(), '账号 A 未保存的独立风格');
    await delay(4300); // Cross the normal state polling interval.
    assert.equal(await page.locator('[data-config="chat.persona"]').inputValue(), '账号 A 未保存的独立风格');
    await chooseAccount(second.id);
    await chooseStep('models');
    assert.equal(await page.locator('[data-secret="deepseekApiKey"]').inputValue(), 'qa-local-key-account-b');
    await page.locator('#collapse-account').click();
    assert.equal(await page.locator('#account-workspace').isVisible(), false);
    await chooseAccount(second.id);
    await chooseStep('models');
    assert.equal(await page.locator('[data-secret="deepseekApiKey"]').inputValue(), 'qa-local-key-account-b');
    pass('展开、收起、账号切换和后台轮询均保留各自尚未保存的参数与密钥');

    for (let i = 0; i < 2; i++) {
      await page.locator('[data-setup-panel="models"] [data-add-api]').click();
      await page.locator('#api-vendor-choice').selectOption('custom');
      await page.locator('#dialog-confirm').click();
      await page.locator(`[data-config="models.apis.${i}.label"]`).fill(`本地模型 ${i + 1}`);
      await page.locator(`[data-config="models.apis.${i}.baseUrl"]`).fill(`https://api${i + 1}.example.com/v1`);
      await page.locator(`[data-config="models.apis.${i}.model"]`).fill(`qa-model-${i + 1}`);
      await page.locator('#custom-api-cards [data-secret^="apiKey:"]').nth(i).fill(`qa-local-custom-key-${i + 1}`);
    }
    let state = await saveDraft(second.id);
    assert.equal(state.draft.models.apis.length, 2);
    const apiId = state.draft.models.apis[0].id;
    for (const item of state.draft.models.apis) assert.equal(state.secrets[`apiKey:${item.id}`], true);
    for (const key of ['qa-local-key-account-a', 'qa-local-key-account-b', 'qa-local-custom-key-1', 'qa-local-custom-key-2']) {
      assert.equal(JSON.stringify(state).includes(key), false);
    }
    pass('同一账号可添加两个兼容 API，密钥只返回存在状态，不进入配置或状态响应');

    await page.locator(`[data-setup-model-test="${apiId}"]`).click();
    await page.locator('#app-dialog').waitFor({ state: 'visible' });
    await page.locator('#dialog-confirm').click();
    await until(async () => (await readState(second.id)).runtime.modelTests?.[apiId]?.tested, '兼容 API 测试未被记录');
    assert.equal(calls.at(-1).apiKey, 'qa-local-custom-key-1');
    assert.equal(calls.at(-1).provider, apiId);
    await page.waitForFunction(() => document.querySelector('#app-dialog').open && document.querySelector('#dialog-title').textContent === '模型实际测试结果');
    await page.locator('#dialog-confirm').click();
    await page.locator('[data-config="models.apis.0.model"]').fill('qa-model-changed');
    assert.equal((await page.locator('#setup-model-status').innerText()).includes('实际测试通过'), false);
    await page.locator('#custom-api-cards [data-secret^="apiKey:"]').first().fill('qa-local-custom-key-1-updated');
    assert.match(await page.locator('#setup-model-status').innerText(), /密钥已修改/);
    state = await saveDraft(second.id);
    assert.equal(state.setup.models.providers.find(item => item.id === apiId).tested, false);
    pass('真实模型测试路径调用指定 API 通道，修改草稿模型后测试状态失效');

    qq = await mockQQ('12345002');
    await chooseStep('connection');
    assert.equal(await page.locator('#connection-native-guide').isVisible(), true);
    assert.equal(await page.locator('#connection-docker-guide').isVisible(), false);
    await page.locator('[data-config="qq.wsUrl"]').fill(qq.url);
    await page.locator('[data-secret="napcatToken"]').fill('qa-local-onebot-key');
    await page.locator('[data-setup-connect]').click();
    await until(async () => (await readState(second.id)).setup.connection.verified, '引导未完成真实 OneBot 身份验证');
    state = await readState(second.id);
    assert.equal(state.applied.botQQ, '12345002');
    assert.equal(state.runtime.accountId, '12345002');
    assert.equal(state.applied.permissions.released, false);
    assert.equal(state.applied.ownerQQ, '');
    assert.equal(qq.outbound.length, 0);
    pass('无需 Docker 和第二个 QQ，原生路线可保存连接信息并验证实际 QQ，连接后仍只读');

    await page.locator('[data-page="scenarios"]').click();
    await page.locator('[data-scenario-tab="tasks"]').click();
    await page.locator('label.switch:has([data-config="chat.enabled"])').click();
    assert.equal(await page.locator('[data-config="chat.enabled"]').isChecked(), true);
    await page.locator('[data-config="chat.provider"]').selectOption(apiId);
    await page.locator('[data-scenario-tab="permissions"]').click();
    await page.locator('[data-action="groups-list"]').click();
    await page.locator('#app-dialog').waitFor({ state: 'visible' });
    await page.locator('[data-joined-group="0"]').check();
    await page.locator('#dialog-confirm').click();
    const read = page.locator('#group-rows [data-group-field="read"]').first();
    const send = page.locator('#group-rows [data-group-field="send"]').first();
    await send.waitFor({ state: 'visible' });
    assert.equal(await read.isChecked(), true);
    assert.equal(await send.isChecked(), false);
    await send.check();
    await read.uncheck();
    assert.equal(await send.isChecked(), false);
    assert.equal(await send.isDisabled(), true);
    await read.check();
    await send.check();
    const triggerPicker = page.locator('#group-rows .group-trigger-picker').first();
    await triggerPicker.locator('summary').click();
    await triggerPicker.locator('[data-group-triggers-all]').click();
    assert.equal(await triggerPicker.locator('[data-group-trigger]:checked').count(), 12);
    await triggerPicker.locator('[data-group-triggers-clear]').click();
    assert.equal(await triggerPicker.locator('[data-group-trigger]:checked').count(), 0);
    for (const trigger of ['mention', 'prefix', 'casual', 'poke', 'group_name']) await triggerPicker.locator(`[data-group-trigger="${trigger}"]`).check();
    assert.equal(await triggerPicker.locator('[data-group-trigger]:checked').count(), 5);
    await page.locator('#group-rows [data-group-field="probability"]').first().fill('0');
    await page.locator('#group-rows [data-group-field="cooldownSeconds"]').first().fill('5');
    await page.locator('[data-config="ownerQQ"]').fill('12345002');
    await page.locator('[data-config="permissions.privateReplies"]').check();
    await page.locator('#apply-config').click();
    await until(() => page.locator('[data-config="ownerQQ"]').getAttribute('aria-invalid').then(value => value === 'true'), '同号私聊错误未定位到可修改字段');
    const readableError = await page.locator('#scenario-validation-errors').innerText();
    assert.match(readableError, /私聊|QQ/);
    assert.equal(readableError.includes('["'), false);
    await page.locator('#scenario-validation-errors [data-repair-private]').click();
    assert.equal(await page.locator('[data-config="permissions.privateReplies"]').isChecked(), false);
    assert.equal(await page.locator('[data-config="summary.sendToOwner"]').isChecked(), false);
    pass('群读取关闭会同时取消发送；同号私聊错误可定位并一键关闭可选投递，不阻碍单 QQ 使用');

    await page.locator('#release-permissions').click();
    await page.locator('#app-dialog').waitFor({ state: 'visible' });
    await page.locator('#dialog-confirm').click();
    await until(async () => (await readState(second.id)).applied.permissions.released, '最终显式授权未完成');
    state = await readState(second.id);
    assert.deepEqual(state.runtime.permissions.writableGroups, ['98765001']);
    assert.equal(state.applied.permissions.privateReplies, false);
    assert.deepEqual(state.applied.groups[0].triggers, ['mention', 'prefix', 'casual', 'poke', 'group_name']);
    assert.equal((await readState(first.id)).applied.permissions.released, false);
    const beforeMessageCalls = calls.length;
    await qq.event('98765002', 'qa-unselected');
    await qq.event('98765001', 'qa-groupname-is-text', '群名称修改为测试新群名');
    await qq.notice('98765001', { notice_type: 'notify', sub_type: 'poke', target_id: 777777 });
    await delay(200);
    assert.equal(calls.length, beforeMessageCalls);
    assert.equal(qq.outbound.length, 0);
    await qq.event('98765001', 'qa-selected');
    await until(() => qq.outbound.length === 1, '已授权群消息没有完成本地模型回复');
    assert.equal(calls.at(-1).provider, apiId);
    assert.equal(calls.at(-1).apiKey, 'qa-local-custom-key-1-updated');
    assert.equal(String(qq.outbound[0].params.group_id), '98765001');
    await delay(5100); // Notice replies use the same explicit group cooldown.
    await qq.notice('98765001', { notice_type: 'notify', sub_type: 'group_name', name_new: '本地测试的新群名', operator_id: 555555 });
    await until(() => qq.outbound.length === 2, '真实群名变更事件没有触发已勾选的模型回复');
    assert.match(JSON.stringify(calls.at(-1).messages), /group_name/);
    pass('事件可同时勾选、全选和清空；@、前缀、概率、戳一戳与群名事件组合保存，普通群名文字不会伪装成真实事件');
    await chooseStep('verification');
    assert.equal(await page.locator('#setup-send-test').isEnabled(), true);
    const beforeFixedTest = calls.length;
    await page.locator('#setup-test-group').selectOption('98765001');
    await page.locator('#setup-send-test').click();
    await page.locator('#app-dialog').waitFor({ state: 'visible' });
    await page.locator('#dialog-confirm').click();
    await until(() => qq.outbound.length === 3, '最终验证没有发送已确认的固定测试消息');
    assert.equal(calls.length, beforeFixedTest);
    assert.match(JSON.stringify(qq.outbound[2].params), /QQ_Service 连接测试/);
    pass('最终验证页显式确认后向已授权群发送固定测试消息，真实走 OneBot，且不调用 AI');
    await page.locator('[data-page="scenarios"]').click();
    await page.locator('[data-scenario-tab="permissions"]').click();
    await page.locator('#revoke-permissions').click();
    await until(async () => !(await readState(second.id)).applied.permissions.released, '恢复只读未生效');
    pass('只有最终授权账号的选定群可触发指定模型并收到回复；其他群与账号不获得权限，支持恢复只读');

    const exported = await page.evaluate(id => fetch(`/api/accounts/${id}/config/export`).then(response => response.text()), second.id);
    for (const key of ['qa-local-key-account-b', 'qa-local-custom-key-1', 'qa-local-custom-key-1-updated', 'qa-local-custom-key-2', 'qa-local-onebot-key']) assert.equal(exported.includes(key), false);
    await chooseStep('verification');
    if (process.env.QQBRIDGE_TEST_SCREENSHOT) await page.screenshot({ path: path.resolve(process.env.QQBRIDGE_TEST_SCREENSHOT), fullPage: false });
    pass('账号配置导出不含任何模型或 OneBot 密钥，最终验证页面可访问');
    await checkLegacyUpgrade();
    assert.deepEqual(errors, []);
    console.log(`浏览器引导验证通过：${checks.length} 项。未使用真实 QQ 或付费模型。`);
  } catch (error) {
    if (page) console.error('当前可见页面：', (await page.locator('body').innerText().catch(() => '')).slice(0, 8000));
    console.error(error.stack || error.message); process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (app) await app.close();
    if (qq) await qq.close();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
})();
