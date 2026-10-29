import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, validateConfig } from '../src/config.mjs';

test('旧账号默认没有启用插件，插件配置不能重复或携带未知授权字段', () => {
  const legacy = structuredClone(DEFAULT_CONFIG);
  delete legacy.plugins;
  assert.deepEqual(validateConfig(legacy).plugins, []);
  const entry = { id: 'hello-group', enabled: true, settings: {} };
  assert.throws(() => validateConfig({ ...legacy, plugins: [entry, entry] }), /配置校验/);
  assert.throws(() => validateConfig({ ...legacy, plugins: [{ ...entry, allowSend: true }] }), /配置校验/);
  assert.throws(() => validateConfig({ ...legacy, plugins: [{ ...entry, id: '../escape' }] }), /配置校验/);
});

test('插件参数只接收有界的普通标量，拒绝危险键、对象、非有限数值和过长内容', () => {
  const config = settings => ({ ...structuredClone(DEFAULT_CONFIG), plugins: [{ id: 'hello-group', enabled: false, settings }] });
  for (const settings of [{ nested: {} }, { value: Infinity }, { value: 'a'.repeat(6001) }, JSON.parse('{"__proto__":true}')]) {
    assert.throws(() => validateConfig(config(settings)), /配置校验/);
  }
  const valid = { content: '<img src=x>', count: 0, active: false };
  assert.deepEqual(validateConfig(config(valid)).plugins[0].settings, valid);
});
