import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDesktopSettingsStore, validateDesktopSettings } = require('../desktop/settings.cjs');

test('桌面关闭方式独立持久化，按顺序原子写入并保留最后一次设置', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qqservice-settings-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createDesktopSettingsStore(directory);
  assert.deepEqual(await store.load(), { closeBehavior: 'tray' });
  const returned = store.get();
  returned.closeBehavior = 'quit';
  assert.deepEqual(store.get(), { closeBehavior: 'tray' });
  assert.deepEqual(await Promise.all([
    store.update({ closeBehavior: 'quit' }), store.update({ closeBehavior: 'tray' }), store.update({ closeBehavior: 'quit' }),
  ]), [{ closeBehavior: 'quit' }, { closeBehavior: 'tray' }, { closeBehavior: 'quit' }]);
  const restarted = createDesktopSettingsStore(directory);
  assert.deepEqual(await restarted.load(), { closeBehavior: 'quit' });
  assert.deepEqual(await fs.readdir(directory), ['desktop-settings.json']);
  assert.equal((await fs.readFile(path.join(directory, 'desktop-settings.json'), 'utf8')).endsWith('\n'), true);
});

test('损坏或不支持的桌面设置恢复为托盘默认，不阻止应用启动', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qqservice-settings-invalid-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'desktop-settings.json');
  for (const value of ['{broken', '{}', 'null', '{"closeBehavior":"arbitrary"}', '{"closeBehavior":"quit","path":"elsewhere"}']) {
    await fs.writeFile(file, value);
    assert.deepEqual(await createDesktopSettingsStore(directory).load(), { closeBehavior: 'tray' });
  }
});

test('桌面设置拒绝任意字段和无效关闭方式，不改变已经保存的偏好', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qqservice-settings-schema-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createDesktopSettingsStore(directory);
  await store.update({ closeBehavior: 'quit' });
  for (const value of [null, [], 'quit', {}, { closeBehavior: 'hide' }, { closeBehavior: true }, { closeBehavior: 'tray', file: '../settings.json' }]) {
    assert.throws(() => validateDesktopSettings(value), /关闭方式无效/);
    assert.throws(() => store.update(value), /关闭方式无效/);
  }
  assert.deepEqual(store.get(), { closeBehavior: 'quit' });
  assert.deepEqual(await createDesktopSettingsStore(directory).load(), { closeBehavior: 'quit' });
});

test('桌面设置写入失败不会改变当前偏好，清除临时文件后仍能重试', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qqservice-settings-retry-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'desktop-settings.json');
  await fs.mkdir(file);
  const store = createDesktopSettingsStore(directory);
  await assert.rejects(store.update({ closeBehavior: 'quit' }));
  assert.deepEqual(store.get(), { closeBehavior: 'tray' });
  assert.deepEqual(await fs.readdir(directory), ['desktop-settings.json']);
  await fs.rm(file, { recursive: true });
  assert.deepEqual(await store.update({ closeBehavior: 'quit' }), { closeBehavior: 'quit' });
  assert.deepEqual(await createDesktopSettingsStore(directory).load(), { closeBehavior: 'quit' });
});
