import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPluginManager } from '../src/plugins.mjs';
import { validateToolSchema, validateToolInput } from '../src/tool-schema.mjs';

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

const toolInputSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 30, description: '标题' },
    mode: { type: 'string', enum: ['brief', 'full'] },
    details: {
      type: 'object', properties: {
        count: { type: 'integer', minimum: 1, maximum: 5 },
        ratio: { type: 'number', minimum: 0, maximum: 1 },
        include: { type: 'boolean', enum: [true] },
      }, required: ['count'], additionalProperties: false,
    },
    tags: { type: 'array', items: { type: 'string', maxLength: 5 }, minItems: 1, maxItems: 3 },
  },
  required: ['title'], additionalProperties: false,
};
const declaredTool = (override = {}) => ({
  name: 'inspect_text', description: '整理指定文本', effect: 'read', inputSchema: toolInputSchema, ...override,
});

test('AI 工具参数定义采用有界 JSON Schema 子集并返回独立的规范化副本', () => {
  const canonical = validateToolSchema(toolInputSchema);
  assert.deepEqual(canonical.required, ['title']);
  assert.equal(canonical.additionalProperties, false);
  assert.equal(canonical.properties.mode.maxLength, 6000);
  assert.equal(canonical.properties.tags.items.minLength, 0);
  assert.equal(canonical.properties.title.description, '标题');
  canonical.properties.title.maxLength = 2;
  assert.equal(toolInputSchema.properties.title.maxLength, 30);
  assert.deepEqual(validateToolSchema({ type: 'object' }), { type: 'object', properties: {}, required: [], additionalProperties: false });
  assert.deepEqual(validateToolSchema({ type: 'object', properties: { list: { type: 'array', items: { type: 'boolean' } } } }).properties.list,
    { type: 'array', items: { type: 'boolean' }, minItems: 0, maxItems: 100 });
  assert.deepEqual(validateToolInput(toolInputSchema, { title: '通知', mode: 'brief', details: { count: 2, ratio: 0.5, include: true }, tags: ['QQ'] }),
    { title: '通知', mode: 'brief', details: { count: 2, ratio: 0.5, include: true }, tags: ['QQ'] });
  assert.deepEqual(validateToolInput({ type: 'object', properties: { text: { type: 'string', maxLength: 1 } } }, { text: '🙂' }), { text: '🙂' });
});

test('AI 工具参数定义拒绝开放属性、引用、表达式、非法枚举与不支持的关键字', () => {
  const badSchemas = [
    null, {}, { type: 'string' }, { type: ['object', 'null'] },
    { type: 'object', properties: null }, { type: 'object', required: null },
    { type: 'object', additionalProperties: true },
    { type: 'object', additionalProperties: { type: 'string' } },
    { type: 'object', $ref: '#/definitions/x' },
    { type: 'object', pattern: '.*' },
    { type: 'object', anyOf: [] },
    { type: 'object', properties: { x: { type: 'string', default: 'x' } } },
    { type: 'object', properties: { x: { type: 'string', pattern: '[x]' } } },
    { type: 'object', properties: { x: { type: 'number', enum: [1, 1] } } },
    { type: 'object', properties: { x: { type: 'boolean', enum: ['true'] } } },
    { type: 'object', properties: { x: { type: 'integer', enum: [1.5] } } },
    { type: 'object', properties: { x: { type: 'string', maxLength: 2, enum: ['long'] } } },
    { type: 'object', properties: { x: { type: 'array', items: { type: 'string' }, maxItems: 101 } } },
    { type: 'object', properties: { x: { type: 'array', items: [] } } },
    { type: 'object', properties: { x: { type: 'string', minLength: 3, maxLength: 1 } } },
    { type: 'object', properties: { x: { type: 'number', minimum: 10, maximum: 1 } } },
    { type: 'object', properties: { x: { type: 'boolean', maximum: 1 } } },
    { type: 'object', properties: { x: { type: 'null' } } },
    { type: 'object', required: ['missing'] },
    { type: 'object', properties: { x: { type: 'boolean' } }, required: ['x', 'x'] },
    JSON.parse('{"type":"object","properties":{"__proto__":{"type":"boolean"}}}'),
    JSON.parse('{"type":"object","properties":{"constructor":{"type":"boolean"}}}'),
  ];
  for (const schema of badSchemas) assert.throws(() => validateToolSchema(schema), error => error.statusCode === 400, JSON.stringify(schema));
  const properties = Object.fromEntries(Array.from({ length: 31 }, (_, index) => [`x${index}`, { type: 'boolean' }]));
  assert.throws(() => validateToolSchema({ type: 'object', properties }), /30/);
  const manyNodes = { type: 'object', properties: {} };
  for (let index = 0; index < 10; index++) manyNodes.properties[`obj${index}`] = { type: 'object', properties: Object.fromEntries(Array.from({ length: 10 }, (_, n) => [`x${n}`, { type: 'boolean' }])) };
  assert.throws(() => validateToolSchema(manyNodes), /100/);
  let nested = { type: 'boolean' };
  for (let index = 0; index < 7; index++) nested = { type: 'array', items: nested };
  assert.throws(() => validateToolSchema({ type: 'object', properties: { nested } }), /6 层/);
  const tooLarge = { type: 'object', description: '文'.repeat(6000) };
  assert.throws(() => validateToolSchema(tooLarge), /16 KiB/);
});

test('AI 工具参数严格检查必填、类型、范围、枚举、数组与 JSON 安全边界', () => {
  const badInputs = [
    undefined, null, [], {}, { title: '' }, { title: 'x'.repeat(31) },
    { title: '通知', extra: true }, { title: '通知', mode: 'unexpected' },
    { title: '通知', details: { count: 1.5 } },
    { title: '通知', details: { count: 0 } },
    { title: '通知', details: { count: 2, ratio: 2 } },
    { title: '通知', details: { count: 2, include: false } },
    { title: '通知', details: { count: 2, extra: 'x' } },
    { title: '通知', details: { count: NaN } },
    { title: '通知', tags: [] }, { title: '通知', tags: ['a', 'b', 'c', 'd'] },
    { title: '通知', tags: [false] }, { title: '通知', tags: ['too long'] },
    { title: '通知', tags: new Array(1) },
    { title: '通知', details: { count: Infinity } },
    { title: '通知', mode: () => 'brief' },
    JSON.parse('{"title":"通知","__proto__":{}}'),
  ];
  for (const value of badInputs) assert.throws(() => validateToolInput(toolInputSchema, value), error => error.statusCode === 400);
  const circular = { title: '通知' }; circular.self = circular;
  assert.throws(() => validateToolInput(toolInputSchema, circular), /JSON/);
  assert.throws(() => validateToolInput({ type: 'object', properties: { text: { type: 'string' } } }, { text: '文'.repeat(6000) }), /16 KiB/);
  let getterCalled = false;
  const dynamic = { get title() { getterCalled = true; return '通知'; } };
  assert.throws(() => validateToolInput(toolInputSchema, dynamic), /动态属性/);
  assert.equal(getterCalled, false);
  const source = { title: '通知', tags: ['QQ'] };
  const cloned = validateToolInput(toolInputSchema, source); cloned.tags[0] = '修改';
  assert.equal(source.tags[0], 'QQ');
});

test('插件声明 AI 工具无需群事件权限，工具名称、数量、效果和参数定义在安装时校验', async t => {
  const fx = fixture(t);
  const source = fx.packageDir('tool-definitions', undefined, { tools: [declaredTool({ effect: undefined })] });
  const installed = await fx.manager.install(source);
  assert.equal(installed.tools[0].effect, 'write');
  assert.deepEqual(installed.events, []); assert.deepEqual(installed.permissions, []);
  assert.equal(installed.tools[0].inputSchema.properties.mode.maxLength, 6000);
  const visible = fx.manager.get('tool-definitions'); visible.tools[0].name = 'modified';
  assert.equal(fx.manager.list()[0].tools[0].name, 'inspect_text');
  assert.equal(fx.restart().get('tool-definitions').tools[0].name, 'inspect_text');
  const badTools = [
    [declaredTool({ name: 'Uppercase' })], [declaredTool({ name: '../escape' })],
    [declaredTool({ name: 'x'.repeat(49) })], [declaredTool({ name: 'constructor' })],
    [declaredTool(), declaredTool()], [declaredTool({ effect: 'execute' })],
    [declaredTool({ effect: null })],
    [declaredTool({ description: '' })], [declaredTool({ description: 'x'.repeat(1001) })],
    [declaredTool({ extra: true })], [declaredTool({ inputSchema: { type: 'string' } })],
    Array.from({ length: 21 }, (_, i) => declaredTool({ name: `tool_${i}` })),
  ];
  for (const [index, tools] of badTools.entries()) await assert.rejects(fx.manager.install(fx.packageDir(`bad-tools-${index}`, undefined, { tools })), error => error.statusCode === 400);
  await assert.rejects(fx.manager.install(fx.packageDir('null-tools', undefined, { tools: null })), error => error.statusCode === 400);
  await fx.manager.install(fx.packageDir('no-tools'));
  assert.deepEqual(fx.manager.get('no-tools').tools, []);
});

test('callTool 仅调用已声明工具，校验参数后才导入，并传递工具参数与独立上下文', async t => {
  const fx = fixture(t);
  const marker = path.join(fx.root, 'tool-imported.txt');
  const code = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'imported');
    export async function callTool({ name, arguments: args, settings, context }) { return { text: JSON.stringify({ name, args, settings, context }) }; }`;
  await fx.manager.install(fx.packageDir('tool-dispatch', code, {
    tools: [declaredTool()], settingsSchema: [{ key: 'label', label: '名称', type: 'string', default: '演示' }],
  }));
  await assert.rejects(fx.manager.execute('tool-dispatch', { handler: 'callTool', name: 'missing', arguments: {} }), error => error.statusCode === 404);
  await assert.rejects(fx.manager.execute('tool-dispatch', { handler: 'callTool', name: 'inspect_text', arguments: {} }), error => error.statusCode === 400);
  await assert.rejects(fx.manager.execute('tool-dispatch', { handler: 'callTool', name: 'inspect_text', arguments: { title: '通知', leaked: true } }), error => error.statusCode === 400);
  assert.equal(fs.existsSync(marker), false);
  const result = await fx.manager.execute('tool-dispatch', { handler: 'callTool', name: 'inspect_text', arguments: { title: '通知' }, context: { profileId: 'demo' } });
  assert.deepEqual(JSON.parse(result.text), { name: 'inspect_text', args: { title: '通知' }, settings: { label: '演示' }, context: { profileId: 'demo' } });
  assert.equal(fs.readFileSync(marker, 'utf8'), 'imported');
  await fx.manager.install(fx.packageDir('empty-tool', 'export function callTool({ arguments: args }) { return { text: JSON.stringify(args) }; }', { tools: [declaredTool({ inputSchema: { type: 'object' } })] }));
  assert.deepEqual(await fx.manager.execute('empty-tool', { handler: 'callTool', name: 'inspect_text' }), { text: '{}' });
  await assert.rejects(fx.manager.execute('empty-tool', { handler: 'callTool', name: 'inspect_text', arguments: null }), error => error.statusCode === 400);
});

test('callTool 不允许直接回复 QQ，缺失导出和取消仍遵守 Worker 生命周期', async t => {
  const fx = fixture(t);
  const tools = [declaredTool({ inputSchema: { type: 'object' } })];
  await fx.manager.install(fx.packageDir('tool-reply', 'export function callTool() { return { reply: "不能发送" }; }', { ...eventManifest, tools }));
  await assert.rejects(fx.manager.execute('tool-reply', { handler: 'callTool', name: 'inspect_text', arguments: {} }), error => error.statusCode === 403 && /reply/.test(error.message));
  await fx.manager.install(fx.packageDir('tool-missing-export', undefined, { tools }));
  await assert.rejects(fx.manager.execute('tool-missing-export', { handler: 'callTool', name: 'inspect_text', arguments: {} }), /未导出 callTool/);
  await fx.manager.install(fx.packageDir('tool-hang', 'export function callTool() { while (true) {} }', { tools, timeoutSeconds: 1 }));
  const controller = new AbortController();
  const task = fx.manager.execute('tool-hang', { handler: 'callTool', name: 'inspect_text', arguments: {} }, { signal: controller.signal });
  const cancellation = assert.rejects(task, /取消/); controller.abort(); await cancellation;
  await assert.rejects(fx.manager.execute('tool-hang', { handler: 'callTool', name: 'inspect_text', arguments: {} }), error => error.statusCode === 408);
  await fx.manager.uninstall('tool-hang');
});

test('插件独立密钥只暴露清单定义，执行只传入声明过的本插件单行凭据', async t => {
  const fx = fixture(t);
  const tools = [declaredTool({ inputSchema: { type: 'object' } })];
  const code = `export function callTool({ secrets, settings }) { return { text: JSON.stringify({ secrets, settings, env: Object.keys(process.env) }) }; }
    export function run({ secrets }) { return { text: JSON.stringify(secrets) }; }`;
  await fx.manager.install(fx.packageDir('own-secrets', code, {
    tools, secretsSchema: [{ key: 'sessdata', label: '登录凭据', description: '仅供本插件' }, { key: 'csrf', label: 'CSRF' }],
  }));
  const secrets = { sessdata: 'demo-session', csrf: 'demo-csrf' };
  const result = await fx.manager.execute('own-secrets', { handler: 'callTool', name: 'inspect_text', arguments: {}, secrets });
  assert.deepEqual(JSON.parse(result.text), { secrets, settings: {}, env: [] });
  assert.deepEqual(await fx.manager.execute('own-secrets', { handler: 'run', secrets: { csrf: 'only-one' } }), { text: '{"csrf":"only-one"}' });
  assert.deepEqual(await fx.manager.execute('own-secrets', { handler: 'run' }), { text: '{}' });
  assert.equal(fx.manager.get('own-secrets').secretsSchema.length, 2);
  assert.equal(JSON.stringify(fx.manager.list()).includes('demo-session'), false);
  assert.equal(JSON.stringify(fx.restart().get('own-secrets')).includes('demo-csrf'), false);
  for (const bad of [null, [], { csrf: 3 }, { csrf: 'x'.repeat(2001) }, { csrf: 'line\nbreak' }, { csrf: 'line\rbreak' }, { deepseekApiKey: 'core-key' }, { otherPluginKey: 'other-key' }]) {
    await assert.rejects(fx.manager.execute('own-secrets', { handler: 'callTool', name: 'inspect_text', arguments: {}, secrets: bad }), error => error.statusCode === 400);
  }
  const schema = Array.from({ length: 10 }, (_, index) => ({ key: `key${index}`, label: `密钥${index}` }));
  await fx.manager.install(fx.packageDir('large-secrets', code, { tools, secretsSchema: schema }));
  const largeSecrets = Object.fromEntries(schema.map(field => [field.key, 'x'.repeat(2000)]));
  await assert.rejects(fx.manager.execute('large-secrets', { handler: 'run', secrets: largeSecrets }), /16|体积/);
});

test('插件密钥定义拒绝默认值、保留名、重复名和超额项，旧插件默认为无独立密钥', async t => {
  const fx = fixture(t);
  const badSchemas = [
    null, [{ key: 'constructor', label: '保留名' }], [{ key: 'prototype', label: '保留名' }],
    [{ key: '__proto__', label: '保留名' }], [{ key: 'a-b', label: '非法名' }],
    [{ key: 'valid', label: '' }], [{ key: 'valid', label: 'x'.repeat(101) }],
    [{ key: 'valid', label: '密钥', description: 'x'.repeat(501) }],
    [{ key: 'valid', label: '密钥', default: 'must-not-store-in-manifest' }],
    [{ key: 'same', label: '一' }, { key: 'same', label: '二' }],
    Array.from({ length: 11 }, (_, index) => ({ key: `key${index}`, label: '超额' })),
  ];
  for (const [index, secretsSchema] of badSchemas.entries()) await assert.rejects(fx.manager.install(fx.packageDir(`bad-secret-${index}`, undefined, { secretsSchema })), error => error.statusCode === 400);
  await fx.manager.install(fx.packageDir('no-own-keys'));
  assert.deepEqual(fx.manager.get('no-own-keys').secretsSchema, []);
});
