import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const schema = require('../public/layout-schema.cjs');
const native = require('../desktop/ui-design.cjs');
const { BUILTIN_PAGES, COMPONENT_TYPES, MAX_UI_DESIGN_BYTES, validateUiDesign, validateLayout, emptyLayout } = schema;
const page = (id = 'custom-samplepage') => ({ id, label: '自建菜单', title: '工作台', description: '先编辑布局，再安排后台实现。', icon: '◇' });
const block = (id = 'block-sampleblock', overrides = {}) => ({ id, type: 'text', page: 'overview', parent: null, label: '文字块', ...overrides });
const document = (layout = emptyLayout()) => ({ version: 2, edits: [], layout });
const layoutWith = (components = [], pages = []) => ({ pages, components, navigation: [...BUILTIN_PAGES, ...pages.map(item => item.id)] });
const invalid = value => assert.throws(() => validateLayout(value), /界面修改格式无效/);
const invalidDocument = value => assert.throws(() => validateUiDesign(value), /界面修改格式无效/);
const letters = index => `${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}`;

test('同一份schema在原生和浏览器运行，内置菜单及空布局不共享调用方引用', async () => {
  assert.equal(native.validateUiDesign, validateUiDesign);
  assert.deepEqual(BUILTIN_PAGES, ['overview', 'connections', 'scenarios', 'modules', 'records', 'settings']);
  assert.deepEqual(COMPONENT_TYPES, ['heading', 'text', 'button', 'select', 'input', 'textarea', 'switch', 'card', 'divider']);
  assert.ok(Object.isFrozen(BUILTIN_PAGES));
  assert.ok(Object.isFrozen(COMPONENT_TYPES));
  const empty = emptyLayout();
  empty.navigation.reverse();
  assert.deepEqual(emptyLayout().navigation, BUILTIN_PAGES);
  const context = vm.createContext({ TextEncoder });
  vm.runInContext(await fs.readFile(new URL('../public/layout-schema.cjs', import.meta.url), 'utf8'), context);
  const browser = JSON.parse(vm.runInContext('JSON.stringify(QQServiceLayoutSchema.validateUiDesign({version:2,edits:[],layout:QQServiceLayoutSchema.emptyLayout()}))', context));
  assert.deepEqual(browser, document());
  assert.equal(vm.runInContext('Object.isFrozen(QQServiceLayoutSchema)', context), true);
});

test('v1保持原样兼容，v2必须包含布局，旧编辑可显式迁移并独立复制', () => {
  const old = { version: 1, edits: [{ selector: '[data-ui-key="ui-demo"]', text: '', hidden: false, styles: {}, optionLabels: [] }] };
  assert.deepEqual(validateUiDesign(old), old);
  const upgraded = { version: 2, edits: old.edits, layout: emptyLayout() };
  assert.deepEqual(validateUiDesign(upgraded), upgraded);
  invalidDocument({ version: 2, edits: [] });
  invalidDocument({ ...old, layout: emptyLayout() });
  invalidDocument({ ...upgraded, version: 3 });
  const next = validateUiDesign(upgraded);
  old.edits[0].text = 'changed';
  upgraded.layout.navigation.reverse();
  assert.equal(next.edits[0].text, '');
  assert.deepEqual(next.layout.navigation, BUILTIN_PAGES);
});

test('声明式组件保留类型、嵌套卡片、静态选项和有限动作，支持前向父级引用', () => {
  const customPage = page();
  const components = [
    block('block-headingdemo', { type: 'heading', page: customPage.id, parent: 'block-cardsecond', text: '标题\n第二行', styles: { color: '#abc', fontSize: '2rem', gap: '0' } }),
    block('block-cardsecond', { type: 'card', page: customPage.id, parent: 'block-cardparent', columns: 2 }),
    block('block-cardparent', { type: 'card', page: customPage.id, columns: 3 }),
    block('block-selectdemo', { type: 'select', options: [{ id: 'choice-firstoption', label: '第一个' }, { id: 'choice-secondoption', label: '' }], placeholder: '' }),
    block('block-buttondemo', { type: 'button', action: { type: 'navigate', target: customPage.id } }),
    block('block-buttonnone', { type: 'button', action: { type: 'none' } }),
    block('block-buttonnote', { type: 'button', action: { type: 'pending', note: '' } }),
    ...['text', 'input', 'textarea', 'switch', 'divider'].map((type, index) => block(`block-extrademo${letters(index)}`, { type, label: '', text: '', description: '', styles: {} })),
  ];
  const input = layoutWith(components, [customPage]);
  const copy = validateLayout(input);
  assert.deepEqual(copy, input);
  input.pages[0].title = 'changed';
  components[0].styles.color = '#fff';
  components[3].options[0].label = 'changed';
  components[4].action.target = 'settings';
  assert.equal(copy.pages[0].title, '工作台');
  assert.equal(copy.components[0].styles.color, '#abc');
  assert.equal(copy.components[3].options[0].label, '第一个');
  assert.equal(copy.components[4].action.target, customPage.id);
  assert.deepEqual(validateLayout(layoutWith([block('block-emptyselect', { type: 'select', options: [] })])).components[0].options, []);
});

test('菜单导航必须精确覆盖内置与自建菜单，组件和跳转引用真实菜单', () => {
  const custom = page();
  const input = layoutWith([block('block-referenced', { page: custom.id })], [custom]);
  assert.deepEqual(validateLayout({ ...input, navigation: [...input.navigation].reverse() }).navigation, [...input.navigation].reverse());
  for (const navigation of [[], BUILTIN_PAGES, [...input.navigation, 'settings'], [...input.navigation, 'custom-unknownpage'], [...input.navigation.slice(1), 'custom-missingpage']]) invalid({ ...input, navigation });
  invalid(layoutWith([], [custom, custom]));
  invalid(layoutWith([block('block-referenced', { page: 'custom-missingpage' })]));
  invalid(layoutWith([block('block-referenced', { type: 'button', action: { type: 'navigate', target: 'custom-missingpage' } })]));
  for (const id of ['overview', 'custom-short', 'custom-Uppercase', 'custom-name123', `custom-${'a'.repeat(25)}`]) invalid(layoutWith([], [page(id)]));
  for (const id of ['block-short', 'block-Uppercase', 'block-name123', `block-${'a'.repeat(25)}`]) invalid(layoutWith([block(id)]));
  invalid(layoutWith([block(), block()]));
});

test('父级必须同页卡片，图拒绝悬空、自引用、循环和过深嵌套', () => {
  const card = id => block(id, { type: 'card' });
  invalid(layoutWith([block('block-childdemo', { parent: 'block-missingnode' })]));
  invalid(layoutWith([block('block-parentdemo'), block('block-childdemo', { parent: 'block-parentdemo' })]));
  invalid(layoutWith([{ ...card('block-selfparent'), parent: 'block-selfparent' }]));
  invalid(layoutWith([
    { ...card('block-firstcycle'), parent: 'block-secondcycle' },
    { ...card('block-secondcycle'), parent: 'block-firstcycle' },
  ]));
  invalid(layoutWith([{ ...card('block-parentdemo'), page: 'settings' }, block('block-childdemo', { parent: 'block-parentdemo' })]));
  const nested = Array.from({ length: 6 }, (_, index) => block(`block-nested${letters(index)}`, { type: 'card', parent: index ? `block-nested${letters(index - 1)}` : null }));
  assert.equal(validateLayout(layoutWith(nested.slice(0, 5))).components.length, 5);
  invalid(layoutWith(nested));
});

test('类型专属参数以及纯文本和样式遵循有限schema，不接受后端、值或代码字段', () => {
  for (const extra of [
    { value: 'do-not-export' }, { checked: true }, { apiKey: 'secret' }, { endpoint: 'https://example.test/' },
    { html: '<h1>demo</h1>' }, { onClick: 'alert(1)' }, { href: 'https://example.test/' },
    { options: [] }, { action: { type: 'none' } }, { columns: 2 },
  ]) invalid(layoutWith([block('block-unsafedemo', extra)]));
  for (const action of [
    { type: 'script', text: 'alert(1)' }, { type: 'navigate', target: 'https://example.test/' },
    { type: 'navigate', target: 'settings', href: 'file:///private' }, { type: 'none', note: '' },
    { type: 'pending', note: 'todo', endpoint: '/api/accounts' }, { type: 'pending' },
  ]) invalid(layoutWith([block('block-unsafedemo', { type: 'button', action })]));
  for (const text of ['<script>alert(1)</script>', '<img src=x>', 'x\u0000y', '中'.repeat(2001)]) invalid(layoutWith([block('block-unsafedemo', { text })]));
  for (const styles of [{ position: 'absolute' }, { color: 'red' }, { gap: 'calc(2px)' }, { width: '1001px' }, { margin: '-1px' }, { color: '#fff;display:none' }]) invalid(layoutWith([block('block-unsafedemo', { styles })]));
  for (const columns of [0, 4, 1.5, '2', true]) invalid(layoutWith([block('block-unsafedemo', { type: 'card', columns })]));
  for (const options of [
    [{ id: 'choice-optiondemo', label: '', value: 'private' }],
    [{ id: 'choice-optiondemo', label: '' }, { id: 'choice-optiondemo', label: 'duplicate' }],
    [{ id: 'choice-short', label: 'bad id' }],
    [{ id: 'choice-optiondemo', label: 'x'.repeat(121) }],
  ]) invalid(layoutWith([block('block-unsafedemo', { type: 'select', options })]));
  for (const changed of [{ label: 'x'.repeat(81) }, { title: 'x'.repeat(121) }, { description: 'x'.repeat(501) }, { icon: '12345' }]) invalid(layoutWith([], [{ ...page(), ...changed }]));
  for (const changed of [{ label: 'x'.repeat(121) }, { description: 'x'.repeat(501) }, { placeholder: 'x'.repeat(121) }]) invalid(layoutWith([block('block-unsafedemo', changed)]));
});

test('验证访问器前先检查描述符，拒绝原型、符号、稀疏数组和额外属性', () => {
  let accessed = 0;
  const getter = target => {
    Object.defineProperty(target, 'label', { enumerable: true, get() { accessed++; return 'bad'; } });
    return target;
  };
  invalid(layoutWith([getter(block())]));
  invalid(layoutWith([], [getter(page())]));
  const action = { type: 'pending' };
  Object.defineProperty(action, 'note', { enumerable: true, get() { accessed++; return 'bad'; } });
  invalid(layoutWith([block('block-getterdemo', { type: 'button', action })]));
  const options = [getter({ id: 'choice-getterdemo' })];
  invalid(layoutWith([block('block-getterdemo', { type: 'select', options })]));
  const sparse = new Array(1);
  const indexedGetter = [];
  Object.defineProperty(indexedGetter, '0', { enumerable: true, get() { accessed++; return block(); } });
  for (const components of [sparse, indexedGetter, Object.assign([], { extra: 'bad' })]) invalid({ ...emptyLayout(), components });
  assert.equal(accessed, 0);
  invalid({ ...emptyLayout(), [Symbol('hidden')]: true });
  invalid(Object.assign(Object.create({ inherited: true }), emptyLayout()));
  invalid(layoutWith([Object.assign(Object.create({ inherited: true }), block())]));
  invalid(layoutWith([JSON.parse('{"id":"block-protodemo","type":"text","page":"overview","parent":null,"label":"ok","__proto__":{"polluted":true}}')]));
  invalid(layoutWith([block('block-styledemo', { styles: JSON.parse('{"constructor":{"prototype":{"polluted":true}}}') })]));
  assert.equal({}.polluted, undefined);
});

test('布局数量和整个设计的UTF-8体积均有上限，不能拆分字段绕过总量', () => {
  const pages = Array.from({ length: 25 }, (_, index) => page(`custom-page${letters(index)}`));
  assert.equal(validateLayout(layoutWith([], pages.slice(0, 24))).pages.length, 24);
  invalid(layoutWith([], pages));
  const components = Array.from({ length: 201 }, (_, index) => block(`block-demoblock${letters(index)}`));
  assert.equal(validateLayout(layoutWith(components.slice(0, 200))).components.length, 200);
  invalid(layoutWith(components));
  const options = Array.from({ length: 31 }, (_, index) => ({ id: `choice-demolabel${letters(index)}`, label: '' }));
  invalid(layoutWith([block('block-selectdemo', { type: 'select', options })]));
  const layout = layoutWith(components.slice(0, 50).map(component => ({ ...component, text: '中'.repeat(2000) })));
  const edits = Array.from({ length: 200 }, (_, index) => ({ selector: `[data-ui-key="ui-long-${letters(index)}"]`, text: '中'.repeat(500) }));
  assert.ok(Buffer.byteLength(JSON.stringify(layout)) < MAX_UI_DESIGN_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify({ version: 1, edits })) < MAX_UI_DESIGN_BYTES);
  validateLayout(layout);
  validateUiDesign({ version: 1, edits });
  invalidDocument({ version: 2, edits, layout });
  invalid(layoutWith(components.slice(0, 100).map(component => ({ ...component, text: '中'.repeat(2000) }))));
});

test('原生固定文件保存v2并可重启恢复，v1读取无需迁移且返回隔离快照', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qqservice-ui-layout-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = native.createUiDesignStore(directory);
  const old = { version: 1, edits: [{ selector: '[data-ui-key="ui-demo"]', text: '旧编辑' }] };
  await store.update(old);
  assert.deepEqual(await native.createUiDesignStore(directory).load(), old);
  const next = document(layoutWith([block('block-persistdemo', { type: 'button', action: { type: 'navigate', target: 'settings' } })], [page()]));
  next.edits = old.edits;
  const expected = structuredClone(next);
  const pending = store.update(next);
  next.layout.pages[0].label = 'changed after queue';
  assert.deepEqual(await pending, expected);
  const loaded = await native.createUiDesignStore(directory).load();
  assert.deepEqual(loaded, expected);
  loaded.layout.components[0].action.target = 'overview';
  assert.deepEqual(store.get(), expected);
  assert.deepEqual(await fs.readdir(directory), ['ui-design.json']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'ui-design.json'), 'utf8')), expected);
});
