import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { createStore } from '../src/store.mjs';
import { createRuntime } from '../src/runtime.mjs';
import { createPluginManager } from '../src/plugins.mjs';

async function waitFor(predicate, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('插件集成测试等待超时');
}

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-service-plugin-runtime-'));
  const marker = path.join(directory, 'invocations.jsonl');
  const pluginManager = createPluginManager({ dataDir: path.join(directory, 'managed') });
  const source = path.join(directory, 'source');
  fs.mkdirSync(source);
  const manifest = {
    apiVersion: 1, id: 'runtime-probe', name: 'Runtime probe', version: '1.0.0', entry: 'index.mjs',
    events: ['group.message'], permissions: ['group.read', 'group.send'], timeoutSeconds: 5,
    settingsSchema: [
      { key: 'response', label: 'Reply', type: 'string', default: 'plugin reply' },
      { key: 'delay', label: 'Delay', type: 'number', default: 0, min: 0, max: 1000 },
    ],
  };
  const code = `import fs from 'node:fs';
export async function run({input, settings, context}) {
  if (input?.returnReply) return {reply: 'manual must not send'};
  return {text: JSON.stringify({input, settings, context})};
}
export async function onMessage({event, settings, context}) {
  fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({event, settings, context}) + '\\n');
  if (settings.delay) await new Promise(resolve => setTimeout(resolve, settings.delay));
  return event.text.startsWith('/plugin') ? {reply: settings.response} : null;
}`;
  fs.writeFileSync(path.join(source, 'plugin.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(source, 'index.mjs'), code);
  await pluginManager.install(source);
  const readOnlySource = path.join(directory, 'read-only-source');
  fs.mkdirSync(readOnlySource);
  fs.writeFileSync(path.join(readOnlySource, 'plugin.json'), JSON.stringify({ ...manifest, id: 'read-only-probe', permissions: ['group.read'] }));
  fs.writeFileSync(path.join(readOnlySource, 'index.mjs'), code);
  await pluginManager.install(readOnlySource);
  const store = createStore(path.join(directory, 'profile'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  const config = structuredClone(DEFAULT_CONFIG);
  config.botQQ = '999999'; config.qq.enabled = true;
  config.qq.wsUrl = `ws://127.0.0.1:${server.address().port}`;
  config.permissions.released = true;
  config.chat.enabled = false;
  config.groups = [{ id: '222222', name: 'selected', mode: 'social', read: true, send: true,
    trigger: 'prefix', triggers: ['prefix'], prefix: '/ai', cooldownSeconds: 0, probability: 0 }];
  config.plugins = [{ id: 'runtime-probe', enabled: false, settings: { response: 'first-profile', delay: 0 } }];
  const outbound = [], logs = []; let peer, sequence = 0, delivered = 0;
  server.on('connection', socket => {
    peer = socket;
    socket.on('message', raw => {
      const packet = JSON.parse(raw.toString());
      if (packet.action.startsWith('send_')) outbound.push(packet);
      socket.send(JSON.stringify({ echo: packet.echo, status: 'ok', retcode: 0,
        data: packet.action === 'get_login_info' ? { user_id: 999999 } : {} }));
    });
  });
  const runtime = createRuntime({ profileId: 'first-profile', platform: 'qq', getConfig: () => config,
    getSecret: () => 'never-pass-this-onebot-secret', store, installer: {}, pluginManager,
    log: (...args) => logs.push(args), providers: {
      deepseek: async () => { throw new Error('插件任务不应调用 AI'); },
      codex: async () => { throw new Error('插件任务不应调用订阅'); },
    } });
  await runtime.connect();
  const calls = () => fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return { directory, marker, pluginManager, store, runtime, config, outbound, logs, calls,
    emit(overrides = {}) {
      delivered++;
      peer.send(JSON.stringify({ post_type: 'message', message_type: 'group', self_id: 999999,
        group_id: 222222, user_id: 555555, message_id: `plugin-${++sequence}`, time: Math.floor(Date.now() / 1000),
        message: [{ type: 'text', data: { text: '/plugin hello' } }], ...overrides }));
    },
    async idle() {
      await waitFor(() => runtime.status().metrics.received >= delivered);
      await new Promise(resolve => setTimeout(resolve, 15));
      await waitFor(() => !runtime.status().queue.running && !runtime.status().queue.pending);
    },
    async close() {
      await runtime.stop(); await pluginManager.close();
      for (const socket of server.clients) socket.terminate();
      await new Promise(resolve => server.close(resolve));
      store.close(); fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('插件未命中的消息不占用回复冷却，命中后阻止重复回复', async () => {
  const f = await fixture();
  try {
    f.config.plugins[0].enabled = true;
    f.config.groups[0].cooldownSeconds = 5;
    f.emit({ message: [{ type: 'text', data: { text: '普通聊天' } }] });
    await f.idle();
    assert.equal(f.calls().length, 1);
    assert.equal(f.outbound.length, 0);
    f.emit(); await f.idle();
    assert.equal(f.outbound.length, 1);
    f.emit(); await f.idle();
    assert.equal(f.outbound.length, 1);
    assert.equal(f.calls().length, 2);
  } finally { await f.close(); }
});

test('插件手动执行使用已应用参数，仅返回本地结果，不授予 QQ 发送权限', async () => {
  const f = await fixture();
  try {
    assert.equal(fs.existsSync(f.marker), false, '安装和连接不会执行插件');
    await assert.rejects(f.runtime.runPlugin('runtime-probe', {}), /启用|未启用|enabled/);
    f.config.plugins[0].enabled = true;
    f.config.permissions.released = false;
    const result = await f.runtime.runPlugin('runtime-probe', { command: 'inspect' });
    const value = JSON.parse(result.text);
    assert.deepEqual(value.input, { command: 'inspect' });
    assert.equal(value.settings.response, 'first-profile');
    assert.equal(value.context.profileId, 'first-profile');
    assert.equal(value.context.actualQQ, '999999');
    assert.equal(JSON.stringify(value).includes('never-pass-this-onebot-secret'), false);
    assert.equal(JSON.stringify(value).includes('models'), false);
    await assert.rejects(f.runtime.runPlugin('runtime-probe', { returnReply: true }), /本地|手动|reply|发送/);
    assert.equal(f.outbound.length, 0);
    assert.equal(f.calls().length, 0, '手动运行不会伪造群事件');
  } finally { await f.close(); }
});

test('插件群事件沿用账号、读取、发送与声明权限，独立于 AI 聊天开关', async () => {
  const f = await fixture();
  try {
    const entry = f.config.plugins[0], group = f.config.groups[0];
    f.emit(); await f.idle();
    assert.equal(f.calls().length, 0, '默认禁用插件不会执行');
    entry.enabled = true; f.config.permissions.released = false;
    f.emit(); await f.idle();
    assert.equal(f.calls().length, 0, '未启动账号不会自动执行插件');
    f.config.permissions.released = true; group.read = false;
    f.emit(); await f.idle();
    assert.equal(f.calls().length, 0, '无读取权限不能把群消息交给插件');
    group.read = true;
    f.emit({ group_id: 777777 });
    f.emit({ user_id: 999999, post_type: 'message_sent' });
    f.emit({ message_type: 'private', group_id: undefined });
    f.emit({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', target_id: 999999, message: undefined });
    await f.idle();
    assert.equal(f.calls().length, 0, '其他群、自身消息、私聊和群通知不进入 group.message');
    group.send = false;
    f.emit(); await f.idle();
    assert.equal(f.calls().length, 1, '已授权读取的群可以交给插件');
    assert.equal(f.outbound.length, 0, '群发送权限未授予时不能回复');
    group.send = true;
    f.emit(); await f.idle();
    assert.equal(f.outbound.length, 1, '关闭 AI 聊天不影响已授权插件回复');
    assert.equal(f.outbound[0].params.group_id, '222222');
    assert.deepEqual(f.outbound[0].params.message, [{ type: 'text', data: { text: 'first-profile' } }]);
    const invoked = f.calls().at(-1);
    assert.equal(invoked.event.groupId, '222222');
    assert.equal(invoked.event.userId, '555555');
    assert.equal(invoked.event.text, '/plugin hello');
    assert.equal(invoked.context.actualQQ, '999999');
    assert.equal(JSON.stringify(invoked).includes('never-pass-this-onebot-secret'), false);
    f.config.plugins = [{ id: 'read-only-probe', enabled: true, settings: { response: 'not-authorized', delay: 0 } }];
    f.emit(); await f.idle();
    assert.equal(f.calls().length, 3);
    assert.equal(f.outbound.length, 1, '插件未声明 group.send 时不能借用账号权限发送');
    assert.equal(f.runtime.status().metrics.modelCalls, 0);
  } finally { await f.close(); }
});

test('撤销权限并重载时取消正在运行的插件，旧结果不能发送', async () => {
  const f = await fixture();
  try {
    f.config.plugins[0].enabled = true;
    f.config.plugins[0].settings.delay = 500;
    f.emit();
    await waitFor(() => f.calls().length === 1);
    f.config.permissions.released = false;
    await f.runtime.reload();
    await waitFor(() => !f.runtime.status().queue.running && !f.runtime.status().queue.pending);
    await new Promise(resolve => setTimeout(resolve, 550));
    assert.equal(f.outbound.length, 0);
    assert.equal(f.config.permissions.released, false);
  } finally { await f.close(); }
});

test('同一插件在不同账号使用独立参数和身份上下文', async () => {
  const f = await fixture();
  const secondStore = createStore(path.join(f.directory, 'second-profile'));
  const secondConfig = structuredClone(DEFAULT_CONFIG);
  secondConfig.botQQ = '888888';
  secondConfig.plugins = [{ id: 'runtime-probe', enabled: true, settings: { response: 'second-profile', delay: 0 } }];
  const secondRuntime = createRuntime({ profileId: 'second-profile', platform: 'qq', getConfig: () => secondConfig,
    getSecret: () => 'second-account-private-key', store: secondStore, installer: {}, pluginManager: f.pluginManager });
  try {
    f.config.plugins[0].enabled = true;
    const first = JSON.parse((await f.runtime.runPlugin('runtime-probe', {})).text);
    const second = JSON.parse((await secondRuntime.runPlugin('runtime-probe', {})).text);
    assert.equal(first.settings.response, 'first-profile');
    assert.equal(second.settings.response, 'second-profile');
    assert.equal(first.context.profileId, 'first-profile');
    assert.equal(second.context.profileId, 'second-profile');
    assert.equal(second.context.expectedQQ, '888888');
    assert.ok(!second.context.actualQQ, '本地执行不能假装未登录账号已经登录');
    assert.equal(JSON.stringify(second).includes('second-account-private-key'), false);
    assert.equal(f.outbound.length, 0);
  } finally { await secondRuntime.stop(); secondStore.close(); await f.close(); }
});
