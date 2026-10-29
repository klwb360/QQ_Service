import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPluginManager } from '../src/plugins.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-service-plugins-'));
  const dataDir = path.join(root, 'data');
  const manager = createPluginManager({ dataDir });
  const managers = [manager];
  t.after(async () => {
    await Promise.allSettled(managers.map(item => item.close()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const packageDir = (id, code = 'export async function run() { return { text: "ready" }; }', override = {}) => {
    const directory = path.join(root, `source-${id}`);
    fs.mkdirSync(directory);
    const manifest = { apiVersion: 1, id, name: `测试 ${id}`, version: '1.0.0', entry: 'index.mjs', ...override };
    fs.writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(directory, 'index.mjs'), code);
    return directory;
  };
  return {
    root, dataDir, manager, packageDir,
    restart() { const next = createPluginManager({ dataDir }); managers.push(next); return next; },
    installed: id => path.join(dataDir, 'plugins', 'packages', id),
  };
}

const eventManifest = { events: ['group.message'], permissions: ['group.read', 'group.send'] };
const hangingCode = 'export async function run() { while (true) {} }';

test('插件安装、重扫不执行代码，执行使用安装快照并可卸载', async t => {
  const fx = fixture(t);
  const marker = path.join(fx.root, 'executed.txt');
  const source = fx.packageDir('snapshot', `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'executed'); export async function run() { return { text: 'original' }; }`);
  const installed = await fx.manager.install(source);
  assert.equal(installed.id, 'snapshot');
  assert.equal(installed.timeoutSeconds, 5);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(JSON.stringify(installed).includes(source), false);
  assert.equal(fx.manager.get('snapshot').entry, 'index.mjs');
  const listed = fx.manager.list(); listed[0].name = 'changed';
  assert.equal(fx.manager.get('snapshot').name, '测试 snapshot');
  await assert.rejects(fx.manager.install(source), error => error.statusCode === 409);
  fs.writeFileSync(path.join(source, 'index.mjs'), 'throw new Error("changed source must not execute");');
  const restarted = fx.restart();
  assert.equal(fs.existsSync(marker), false);
  assert.equal(restarted.list().length, 1);
  assert.deepEqual(await restarted.execute('snapshot', { handler: 'run' }), { text: 'original' });
  assert.equal(fs.readFileSync(marker, 'utf8'), 'executed');
  assert.deepEqual(await restarted.uninstall('snapshot'), { id: 'snapshot', removed: true });
  assert.equal(restarted.get('snapshot'), undefined);
  assert.equal(fs.existsSync(fx.installed('snapshot')), false);
});

test('坏的已安装清单只报告错误，不阻止插件服务启动', async t => {
  const fx = fixture(t);
  await fx.manager.install(fx.packageDir('valid'));
  const broken = fx.installed('broken'); fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, 'plugin.json'), '{ broken');
  const restarted = fx.restart();
  assert.deepEqual(restarted.list().map(item => item.id), ['valid']);
  assert.equal(restarted.get('broken'), undefined);
  assert.equal(restarted.errors()[0].id, 'broken');
  await restarted.uninstall('broken');
  assert.deepEqual(restarted.errors(), []);
});

test('导入拒绝清单版本、权限、入口跳转、重复字段与未知定义', async t => {
  const fx = fixture(t);
  const invalid = [
    { apiVersion: 2 }, { id: '../escape' }, { id: 'Uppercase' }, { extra: true },
    { entry: '../outside.mjs' }, { entry: '/tmp/outside.mjs' }, { entry: 'C:\\outside.mjs' },
    { entry: 'nested/../../outside.mjs' }, { entry: 'index.js' }, { entry: './index.mjs' },
    { entry: 'missing.mjs' }, { events: ['private.message'] }, { events: ['group.message'] },
    { permissions: ['group.send'] }, { permissions: ['unknown'] },
    { ...eventManifest, events: ['group.message', 'group.message'] },
    { timeoutSeconds: 0 }, { timeoutSeconds: 31 }, { timeoutSeconds: 1.5 },
    { settingsSchema: [{ key: 'constructor', label: '坏参数', type: 'string' }] },
    { settingsSchema: [{ key: 'prototype', label: '坏参数', type: 'string' }] },
    { settingsSchema: [{ key: '__proto__', label: '坏参数', type: 'string' }] },
    { settingsSchema: [{ key: 'x', label: '参数', type: 'object' }] },
    { settingsSchema: [{ key: 'x', label: '参数', type: 'number', default: '3' }] },
    { settingsSchema: [{ key: 'x', label: '参数', type: 'string', min: 4, max: 2 }] },
    { settingsSchema: [{ key: 'x', label: '参数', type: 'boolean', min: 1 }] },
    { settingsSchema: [{ key: 'x', label: '参数', type: 'string' }, { key: 'x', label: '参数', type: 'number' }] },
  ];
  for (const [index, override] of invalid.entries()) {
    await assert.rejects(fx.manager.install(fx.packageDir(`invalid-${index}`, undefined, override)), undefined, JSON.stringify(override));
  }
  assert.deepEqual(fx.manager.list(), []);
  assert.deepEqual(fs.readdirSync(path.join(fx.dataDir, 'plugins', 'packages')), []);
  await assert.rejects(fx.manager.install('relative/path'), /绝对路径/);
  await assert.rejects(fx.manager.uninstall('../outside'), /ID 无效/);
});

test('插件包不接受链接文件、链接目录和外部根链接', async t => {
  const fx = fixture(t);
  const source = fx.packageDir('linked-file');
  const outside = path.join(fx.root, 'outside.txt'); fs.writeFileSync(outside, 'outside');
  try { fs.symlinkSync(outside, path.join(source, 'asset.txt'), 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('当前用户无法创建测试符号链接'); return; } throw error; }
  await assert.rejects(fx.manager.install(source), /符号链接|目录联接/);
  const second = fx.packageDir('linked-directory');
  fs.symlinkSync(source, path.join(second, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(fx.manager.install(second), /符号链接|目录联接/);
  const rootLink = path.join(fx.root, 'root-link');
  fs.symlinkSync(second, rootLink, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(fx.manager.install(rootLink), /符号链接|目录联接/);
});

test('插件包拒绝依赖目录、过多文件及超过体积限制的文件', async t => {
  const fx = fixture(t);
  for (const [id, directory] of [['deps', 'node_modules'], ['git-files', '.git']]) {
    const source = fx.packageDir(id); fs.mkdirSync(path.join(source, directory));
    await assert.rejects(fx.manager.install(source), /node_modules|\.git/);
  }
  const many = fx.packageDir('many-files');
  for (let i = 0; i < 199; i++) fs.writeFileSync(path.join(many, `${i}.txt`), '');
  await assert.rejects(fx.manager.install(many), /200 个文件/);
  const large = fx.packageDir('large');
  const largeFile = path.join(large, 'large.bin'); fs.writeFileSync(largeFile, ''); fs.truncateSync(largeFile, 20 * 1024 * 1024);
  await assert.rejects(fx.manager.install(large), /20 MiB/);
  const largeManifest = fx.packageDir('large-manifest');
  fs.writeFileSync(path.join(largeManifest, 'plugin.json'), JSON.stringify({ apiVersion: 1, id: 'large-manifest', name: '测试', version: '1', entry: 'index.mjs', description: 'x'.repeat(65 * 1024) }));
  await assert.rejects(fx.manager.install(largeManifest), /体积|限制/);
});

test('非普通文件不会被复制进插件安装目录', { skip: process.platform === 'win32' }, async t => {
  const fx = fixture(t); const source = fx.packageDir('fifo');
  const result = spawnSync('mkfifo', [path.join(source, 'pipe')]);
  if (result.status !== 0) { t.skip('没有可用的 mkfifo'); return; }
  await assert.rejects(fx.manager.install(source), /普通文件/);
});

test('参数应用默认值，检查必填、类型、范围和未知字段；缺失包只能保留停用配置', async t => {
  const fx = fixture(t);
  await fx.manager.install(fx.packageDir('settings', undefined, { settingsSchema: [
    { key: 'prefix', label: '前缀', type: 'string', default: '/ping', min: 1, max: 20 },
    { key: 'count', label: '次数', type: 'number', default: 2, min: 1, max: 4 },
    { key: 'active', label: '活动', type: 'boolean', default: true },
    { key: 'owner', label: '主人', type: 'string', required: true },
  ] }));
  assert.deepEqual(fx.manager.validateSettings('settings', { owner: '小林' }), { prefix: '/ping', count: 2, active: true, owner: '小林' });
  for (const value of [{}, { owner: '小林', prefix: '' }, { owner: '小林', count: 5 }, { owner: '小林', count: NaN }, { owner: '小林', active: 1 }, { owner: '小林', unknown: true }]) assert.throws(() => fx.manager.validateSettings('settings', value));
  assert.throws(() => fx.manager.validateSettings('settings', JSON.parse('{"owner":"小林","__proto__":{}}')));
  assert.deepEqual(fx.manager.validateEntries([{ id: 'removed', enabled: false, settings: { note: '保留' } }]), [{ id: 'removed', enabled: false, settings: { note: '保留' } }]);
  assert.throws(() => fx.manager.validateEntries([{ id: 'removed', enabled: true, settings: {} }]), /尚未安装/);
  assert.throws(() => fx.manager.validateEntries([{ id: 'settings', enabled: true, settings: { owner: '小林' } }, { id: 'settings', enabled: false, settings: {} }]), /重复/);
  assert.equal(fx.manager.validateEntries([{ id: 'settings', enabled: true, settings: { owner: '小林' } }])[0].settings.count, 2);
});

test('Worker 执行 run/onMessage，传递 JSON 输入和参数，并使用独立空环境', async t => {
  const fx = fixture(t);
  const code = `export async function run({ input, settings, context }) { return { text: JSON.stringify({ input, settings, context, env: Object.keys(process.env) }) }; }
    export async function onMessage({ event }) { if (event.text !== '/ping') return null; return { reply: 'pong' }; }`;
  await fx.manager.install(fx.packageDir('execute', code, { ...eventManifest, settingsSchema: [{ key: 'greeting', label: '问候', type: 'string', default: '你好' }] }));
  const run = await fx.manager.execute('execute', { handler: 'run', input: { value: '<文本>' }, context: { profileId: 'demo' } });
  assert.deepEqual(JSON.parse(run.text), { input: { value: '<文本>' }, settings: { greeting: '你好' }, context: { profileId: 'demo' }, env: [] });
  assert.deepEqual(await fx.manager.execute('execute', { handler: 'onMessage', event: { text: '/ping' } }), { reply: 'pong' });
  assert.equal(await fx.manager.execute('execute', { handler: 'onMessage', event: { text: 'hello' } }), null);
  const circular = {}; circular.self = circular;
  await assert.rejects(fx.manager.execute('execute', { handler: 'run', input: circular }), /JSON/);
  await assert.rejects(fx.manager.execute('execute', { handler: 'run', input: () => {} }), /JSON/);
  await assert.rejects(fx.manager.execute('execute', { handler: 'run', input: 'x'.repeat(70 * 1024) }), /体积/);
});

test('插件不能通过返回结果增加字段、突破长度限制或隐式取得群发送权限', async t => {
  const fx = fixture(t);
  const code = `export function run({ input }) {
    if (input === 'unknown') return { text: 'ok', action: 'send' };
    if (input === 'array') return [];
    if (input === 'primitive') return 'hello';
    if (input === 'long') return { text: 'x'.repeat(6001) };
    if (input === 'large') return { text: '文'.repeat(6000), reply: '字'.repeat(6000) };
    if (input === 'function') return { text: () => 'no' };
    if (input === 'none') return;
    return { reply: 'pong' };
  }`;
  await fx.manager.install(fx.packageDir('results', code, eventManifest));
  for (const input of ['unknown', 'array', 'primitive', 'long', 'large', 'function']) await assert.rejects(fx.manager.execute('results', { handler: 'run', input }), undefined, input);
  assert.equal(await fx.manager.execute('results', { handler: 'run', input: 'none' }), null);
  await fx.manager.install(fx.packageDir('read-only', 'export function run() { return { reply: "forbidden" }; }'));
  await assert.rejects(fx.manager.execute('read-only', { handler: 'run' }), error => error.statusCode === 403 && /group.send/.test(error.message));
  await assert.rejects(fx.manager.execute('read-only', { handler: 'onMessage', event: {} }), error => error.statusCode === 403);
});

test('导入异常、处理器异常及缺失导出会清楚失败，后续插件任务仍能运行', async t => {
  const fx = fixture(t);
  await fx.manager.install(fx.packageDir('import-error', 'throw new Error("import exploded");'));
  await assert.rejects(fx.manager.execute('import-error', { handler: 'run' }), /import exploded/);
  await fx.manager.install(fx.packageDir('handler-error', 'export async function run() { throw new Error("handler exploded"); }'));
  await assert.rejects(fx.manager.execute('handler-error', { handler: 'run' }), /handler exploded/);
  await fx.manager.install(fx.packageDir('missing-handler', 'export const value = 1;'));
  await assert.rejects(fx.manager.execute('missing-handler', { handler: 'run' }), /未导出 run/);
  await fx.manager.install(fx.packageDir('healthy'));
  assert.deepEqual(await fx.manager.execute('healthy', { handler: 'run' }), { text: 'ready' });
});

test('超时任务被终止，取消或关闭服务会停止旧任务且不能继续执行', async t => {
  const fx = fixture(t);
  await fx.manager.install(fx.packageDir('hang', hangingCode, { timeoutSeconds: 1 }));
  await assert.rejects(fx.manager.execute('hang', { handler: 'run' }), error => error.statusCode === 408 && /超时/.test(error.message));
  const controller = new AbortController();
  const task = fx.manager.execute('hang', { handler: 'run' }, { signal: controller.signal });
  const cancelled = assert.rejects(task, /取消/); controller.abort(); await cancelled;
  await assert.rejects(fx.manager.execute('hang', { handler: 'run' }, { signal: controller.signal }), /取消/);
  const closingTask = fx.manager.execute('hang', { handler: 'run' });
  const closed = assert.rejects(closingTask, /取消/);
  await fx.manager.close(); await closed;
  await assert.rejects(fx.manager.execute('hang', { handler: 'run' }), error => error.statusCode === 503);
  await assert.rejects(fx.manager.install(fx.packageDir('too-late')), error => error.statusCode === 503);
});

test('最多八个并发 Worker，执行中的包不能卸载，取消后可以卸载', async t => {
  const fx = fixture(t);
  await fx.manager.install(fx.packageDir('busy', hangingCode, { timeoutSeconds: 5 }));
  const controller = new AbortController();
  const tasks = Array.from({ length: 8 }, () => fx.manager.execute('busy', { handler: 'run' }, { signal: controller.signal }));
  const settled = Promise.allSettled(tasks);
  await assert.rejects(fx.manager.execute('busy', { handler: 'run' }), error => error.statusCode === 429);
  await assert.rejects(fx.manager.uninstall('busy'), error => error.statusCode === 409 && /正在执行/.test(error.message));
  controller.abort();
  assert.equal((await settled).every(result => result.status === 'rejected' && /取消/.test(result.reason.message)), true);
  await fx.manager.uninstall('busy');
  assert.equal(fx.manager.get('busy'), undefined);
});

test('修改已安装清单不会悄悄改变插件权限或配置契约', async t => {
  const fx = fixture(t);
  await fx.manager.install(fx.packageDir('tampered'));
  const manifestPath = path.join(fx.installed('tampered'), 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.events = eventManifest.events; manifest.permissions = eventManifest.permissions;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  await assert.rejects(fx.manager.execute('tampered', { handler: 'run' }), error => error.statusCode === 409 && /改变/.test(error.message));
  assert.deepEqual(fx.manager.get('tampered').permissions, []);
});
