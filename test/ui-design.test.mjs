import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateUiDesign, createUiDesignStore, MAX_UI_DESIGN_BYTES, MAX_UI_DESIGN_EDITS } = require('../desktop/ui-design.cjs');

const patch = (text = '开始配置') => ({ version: 1, edits: [{ selector: '[data-ui-key="ui-start-button"]', text }] });
const withEdit = edit => ({ version: 1, edits: [{ selector: '[data-ui-key="ui-demo"]', ...edit }] });
const invalid = value => assert.throws(() => validateUiDesign(value), /界面修改格式无效/);

test('界面修改保留文字、按钮样式与下拉项标签，不保留调用方对象引用', () => {
  const value = withEdit({
    text: '选择模型\n并保存', hidden: false,
    styles: { fontSize: '18px', color: '#123456', backgroundColor: '#12345678', padding: '1rem 2rem', margin: '0', borderRadius: '8px', width: '80%', maxWidth: 'auto', gap: '1em 2em' },
    optionLabels: [{ value: '', label: '请选择' }, { value: 'deepseek', label: 'DeepSeek API' }],
  });
  const next = validateUiDesign(value);
  assert.deepEqual(next, value);
  value.edits[0].styles.fontSize = '99px';
  value.edits[0].optionLabels[0].label = 'changed';
  assert.equal(next.edits[0].styles.fontSize, '18px');
  assert.equal(next.edits[0].optionLabels[0].label, '请选择');
});

test('原有元素可保存尺寸和文字排版参数，边界值保持有限且返回独立样式', () => {
  const styles = {
    height: 'auto', minWidth: '0', minHeight: '1000px', fontWeight: '600', lineHeight: '1.5', textAlign: 'center',
  };
  const next = validateUiDesign(withEdit({ styles }));
  assert.deepEqual(next.edits[0].styles, styles);
  styles.fontWeight = '900';
  assert.equal(next.edits[0].styles.fontWeight, '600');
  for (const value of ['100', '200', '300', '400', '500', '600', '700', '800', '900']) {
    assert.equal(validateUiDesign(withEdit({ styles: { fontWeight: value } })).edits[0].styles.fontWeight, value);
  }
  for (const value of ['0', '.5', '1', '5', '0px', '200px', '.5rem', '10rem', '10em']) {
    assert.equal(validateUiDesign(withEdit({ styles: { lineHeight: value } })).edits[0].styles.lineHeight, value);
  }
  for (const value of ['left', 'center', 'right', 'start', 'end']) {
    assert.equal(validateUiDesign(withEdit({ styles: { textAlign: value } })).edits[0].styles.textAlign, value);
  }
  for (const key of ['height', 'minWidth', 'minHeight']) {
    for (const value of ['0', '1000px', '100%', '100vh', '100vw', '100rem', '100em']) {
      assert.equal(validateUiDesign(withEdit({ styles: { [key]: value } })).edits[0].styles[key], value);
    }
  }
});

test('新增尺寸和排版仅接受有限CSS值，不允许表达式、额外指令或隐式类型转换', () => {
  for (const styles of [
    { height: '1001px' }, { height: '101vh' }, { height: 'calc(100% - 1px)' }, { minWidth: '-1px' },
    { minWidth: 'auto' }, { minHeight: 'auto' }, { minHeight: 'fit-content' }, { height: '0;display:none' },
    { fontWeight: 'normal' }, { fontWeight: 'bold' }, { fontWeight: '0500' }, { fontWeight: '550' },
    { fontWeight: '1000' }, { fontWeight: 600 }, { lineHeight: '-1' }, { lineHeight: '5.001' },
    { lineHeight: '200.1px' }, { lineHeight: '10.01em' }, { lineHeight: '11rem' }, { lineHeight: '100%' },
    { lineHeight: '1e0' }, { lineHeight: 'Infinity' }, { lineHeight: 'NaN' }, { lineHeight: 'normal' },
    { lineHeight: 'url(file:///private)' }, { lineHeight: 'var(--private)' }, { lineHeight: '1 2' },
    { lineHeight: ' 1.5' }, { lineHeight: '1.5 ' }, { lineHeight: '1.5!important' }, { lineHeight: 1.5 },
    { textAlign: 'justify' }, { textAlign: 'CENTER' }, { textAlign: 'left;position:fixed' },
    { textAlign: new String('left') }, { fontWeight: { toString() { throw new Error('must not execute'); } } },
  ]) invalid(withEdit({ styles }));
});

test('界面修改拒绝任意路径、任意选择器、账号标识与原生或实时状态目标', () => {
  for (const value of [null, [], {}, { version: 2, edits: [] }, { ...patch(), path: '../elsewhere.json' }, { ...patch(), apiKey: 'private' }]) invalid(value);
  for (const selector of [
    'body', '#account-selector', '[data-secret="deepseekApiKey"]', '[data-ui-key="ui-demo"] button',
    '[data-ui-key="ui-demo"][hidden]', '[data-ui-key="3522317989"]',
    '[data-ui-key="ui-account-3522317989"]',
    '[data-ui-key="ui-account-285fb128-7b6e-4d26-8858-c7e43f76407c"]',
    '[data-ui-key="window-controls"]', '[data-ui-key="ui-window-minimize"]',
    '[data-ui-key="ui-designer-panel"]', '[data-ui-key="ui-account-login-status"]',
    '[data-ui-key="ui-runtime-badge"]', '[data-ui-key="ui-secret"]',
  ]) invalid({ version: 1, edits: [{ selector, text: 'changed' }] });
  invalid({ version: 1, edits: [...patch().edits, ...patch().edits] });
});

test('界面修改仅接受有限CSS值、纯文本和静态下拉选项标签', () => {
  for (const styles of [
    { position: 'fixed' }, { cssText: 'color:red' }, { color: 'red' }, { color: 'url(https://example.test/)' },
    { backgroundColor: '#1234' }, { width: 'calc(100% - 2px)' }, { width: '1001px' },
    { width: '101%' }, { fontSize: '-1px' }, { fontSize: '1e2px' }, { padding: '1px 2px 3px 4px 5px' },
    { margin: 'auto' }, { width: 20 }, { color: '#123456;display:none' },
  ]) invalid(withEdit({ styles }));
  for (const text of ['<script>alert(1)</script>', '<b>标题</b>', 'bad\u0000text', 'x'.repeat(501)]) invalid(withEdit({ text }));
  for (const optionLabels of [
    [{ value: 'https://example.test/', label: 'URL' }],
    [{ value: '285fb128-7b6e-4d26-8858-c7e43f76407c', label: 'account' }],
    [{ value: 'deepseek', label: 'x'.repeat(121) }],
    [{ value: 'deepseek', label: 'one' }, { value: 'deepseek', label: 'two' }],
    [{ value: 'deepseek', label: 'label', selected: true }],
  ]) invalid(withEdit({ optionLabels }));
  invalid(withEdit({ hidden: 'false' }));
});

test('界面修改拒绝原型污染、访问器以及稀疏数组，验证不执行访问器', () => {
  for (const value of [
    JSON.parse('{"version":1,"edits":[],"__proto__":{"polluted":true}}'),
    withEdit({ styles: JSON.parse('{"__proto__":{"color":"#fff"}}') }),
    withEdit({ optionLabels: [JSON.parse('{"value":"deepseek","label":"demo","constructor":{"prototype":{"polluted":true}}}')] }),
    Object.assign(Object.create({ arbitrary: true }), patch()),
    { version: 1, edits: new Array(1) },
  ]) invalid(value);
  let accessed = false;
  const edit = { selector: '[data-ui-key="ui-demo"]' };
  Object.defineProperty(edit, 'text', { enumerable: true, get() { accessed = true; return 'bad'; } });
  invalid({ version: 1, edits: [edit] });
  const styles = {};
  Object.defineProperty(styles, 'fontWeight', { enumerable: true, get() { accessed = true; return '600'; } });
  invalid(withEdit({ styles }));
  invalid(withEdit({ styles: JSON.parse('{"constructor":{"prototype":{"polluted":true}},"height":"10px"}') }));
  invalid(withEdit({ styles: JSON.parse('{"height":"10px","__proto__":{"fontWeight":"600"}}') }));
  assert.equal(accessed, false);
  assert.equal({}.polluted, undefined);
});

test('界面修改限制条目与整体UTF-8体积', () => {
  const key = index => `ui-node-${index.toString(36).replaceAll(/[0-9]/g, digit => String.fromCharCode(97 + Number(digit)))}`;
  const many = Array.from({ length: MAX_UI_DESIGN_EDITS + 1 }, (_, index) => ({ selector: `[data-ui-key="${key(index)}"]` }));
  invalid({ version: 1, edits: many });
  // Alphabetic keys keep this case about byte limits, rather than identifiers.
  const large = Array.from({ length: 150 }, (_, index) => ({
    selector: `[data-ui-key="ui-large-${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}"]`,
    optionLabels: Array.from({ length: 30 }, (_, option) => ({ value: `option-${String.fromCharCode(97 + Math.floor(option / 26))}${String.fromCharCode(97 + option % 26)}`, label: '中'.repeat(120) })),
  }));
  assert.ok(Buffer.byteLength(JSON.stringify({ version: 1, edits: large })) > MAX_UI_DESIGN_BYTES);
  invalid({ version: 1, edits: large });
});

test('界面修改在固定文件中串行原子保存，重启后仍可读取且不共享快照引用', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qqservice-ui-design-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createUiDesignStore(directory);
  assert.deepEqual(await store.load(), { version: 1, edits: [] });
  const input = patch('first');
  const pending = store.update(input);
  input.edits[0].text = 'mutated';
  assert.deepEqual(await pending, patch('first'));
  assert.deepEqual(await Promise.all([store.update(patch('second')), store.update(patch('last'))]), [patch('second'), patch('last')]);
  const snapshot = store.get();
  snapshot.edits[0].text = 'changed';
  assert.deepEqual(store.get(), patch('last'));
  assert.deepEqual(await createUiDesignStore(directory).load(), patch('last'));
  assert.deepEqual(await fs.readdir(directory), ['ui-design.json']);
});

test('损坏、超大或旧schema界面修改恢复原始界面，重启不会被阻止', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qqservice-ui-design-invalid-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const content of ['{broken', 'null', '{"version":2,"edits":[]}', 'x'.repeat(MAX_UI_DESIGN_BYTES + 1), JSON.stringify(withEdit({ styles: { position: 'fixed' } }))]) {
    await fs.writeFile(path.join(directory, 'ui-design.json'), content);
    assert.deepEqual(await createUiDesignStore(directory).load(), { version: 1, edits: [] });
  }
});

test('写入失败或验证失败保留最后界面，清理临时文件后可继续保存', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qqservice-ui-design-retry-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createUiDesignStore(directory);
  await store.update(patch('saved'));
  assert.throws(() => store.update(withEdit({ styles: { color: 'url(file:///private)' } })), /界面修改格式无效/);
  assert.deepEqual(store.get(), patch('saved'));
  await fs.rm(path.join(directory, 'ui-design.json'));
  await fs.mkdir(path.join(directory, 'ui-design.json'));
  await assert.rejects(store.update(patch('failed')));
  assert.deepEqual(store.get(), patch('saved'));
  assert.deepEqual(await fs.readdir(directory), ['ui-design.json']);
  await fs.rm(path.join(directory, 'ui-design.json'), { recursive: true });
  assert.deepEqual(await store.update(patch('retried')), patch('retried'));
});
