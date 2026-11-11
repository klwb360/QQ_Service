import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, migrateConfig, validateConfig, pluginSecretName, isCredentialName } from '../src/config.mjs';

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

test('工具授权拒绝伪造开关、重复工具、非号码调用者和未知授权字段', () => {
  const grant = { tool: 'hello-group/lookup', groupIds: ['222222'], userIds: ['555555'], allowWrite: false };
  const settings = { ...structuredClone(DEFAULT_CONFIG.tools), enabled: true, grants: [grant] };
  const invalid = [
    { ...settings, enabled: 'true' }, { ...settings, grants: [grant, grant] },
    { ...settings, grants: [{ ...grant, userIds: ['everyone'] }] },
    { ...settings, grants: [{ ...grant, allowWrite: 'yes' }] },
    { ...settings, grants: [{ ...grant, allGroups: true }] },
    { ...settings, aliases: ['x'.repeat(21)] },
  ];
  for (const tools of invalid) assert.throws(() => validateConfig({ ...structuredClone(DEFAULT_CONFIG), tools }), /配置校验/);
  assert.equal(validateConfig({ ...structuredClone(DEFAULT_CONFIG), tools: settings }).tools.grants[0].allowWrite, false);
});

test('插件凭据名称独立于模型密钥，不能携带原型或路径字段', () => {
  assert.equal(pluginSecretName('bilibili-assistant', 'sessdata'), 'pluginSecret:bilibili-assistant:sessdata');
  assert.equal(isCredentialName('pluginSecret:bilibili-assistant:sessdata'), true);
  for (const name of ['pluginSecret:../other:key', 'pluginSecret:valid:__proto__', 'pluginSecret:valid:constructor', 'pluginSecret:valid:key:extra']) assert.equal(isCredentialName(name), false);
});

test('旧配置缺省关闭QQ上下文工具并使用自动目录，新增开关和发现模式严格校验', () => {
  assert.equal(DEFAULT_CONFIG.tools.builtinQQ, false);
  assert.equal(DEFAULT_CONFIG.tools.catalogMode, 'auto');
  for (const schemaVersion of [1, 2, 3, 4]) {
    const old = structuredClone(DEFAULT_CONFIG);
    old.schemaVersion = schemaVersion;
    delete old.tools.builtinQQ; delete old.tools.catalogMode;
    const migrated = validateConfig(old);
    assert.equal(migrated.schemaVersion, 4);
    assert.equal(migrated.tools.builtinQQ, false);
    assert.equal(migrated.tools.catalogMode, 'auto');
    assert.equal(migrated.permissions.released, false);
  }
  for (const value of ['true', 1, null, {}]) assert.throws(() => validateConfig({ ...structuredClone(DEFAULT_CONFIG),
    tools: { ...structuredClone(DEFAULT_CONFIG.tools), builtinQQ: value } }), error => error.issues.some(issue => issue.path === 'tools.builtinQQ'));
  for (const value of ['automatic', 'AUTO', '', 1, null]) assert.throws(() => validateConfig({ ...structuredClone(DEFAULT_CONFIG),
    tools: { ...structuredClone(DEFAULT_CONFIG.tools), catalogMode: value } }), error => error.issues.some(issue => issue.path === 'tools.catalogMode'));
  const explicit = validateConfig({ ...structuredClone(DEFAULT_CONFIG), tools: {
    ...structuredClone(DEFAULT_CONFIG.tools), builtinQQ: true, catalogMode: 'all', skill: '保留工具偏好', aliases: ['小Q'],
  } });
  assert.equal(explicit.tools.builtinQQ, true);
  assert.equal(explicit.tools.catalogMode, 'all');
  assert.equal(explicit.tools.skill, '保留工具偏好');
  assert.deepEqual(explicit.tools.aliases, ['小Q']);
});

test('仅两个内置QQ上下文标识可进入群工具授权及主动只读工具配置', () => {
  const ids = ['qq:current_group_recent', 'qq:current_group_search'];
  const config = structuredClone(DEFAULT_CONFIG);
  config.tools.builtinQQ = true;
  config.tools.grants = ids.map(tool => ({ tool, groupIds: ['222222'], userIds: ['333333'], allowWrite: false }));
  config.groups = [{ id: '222222', mode: 'social', read: true, send: false, social: { readTools: [...ids, 'hello-group/lookup'] } }];
  const validated = validateConfig(config);
  assert.deepEqual(validated.tools.grants.map(grant => grant.tool), ids);
  assert.deepEqual(validated.groups[0].social.readTools, [...ids, 'hello-group/lookup']);
  assert.equal(validated.permissions.released, false);
  for (const bad of ['qq:send_message', 'qq:other_group_search', 'qq:current_group_recent/extra', 'qq:current_group_\nsearch', 'qq:CURRENT_GROUP_SEARCH']) {
    const invalidGrant = structuredClone(config); invalidGrant.tools.grants[0].tool = bad;
    assert.throws(() => validateConfig(invalidGrant), error => error.issues.some(issue => issue.path === 'tools.grants.0.tool'));
    const invalidRead = structuredClone(config); invalidRead.groups[0].social.readTools = [bad];
    assert.throws(() => validateConfig(invalidRead), error => error.issues.some(issue => issue.path === 'groups.0.social.readTools'));
  }
});

test('伪旧schema不能继承新QQ上下文授权，保留合法旧插件和QQ发送权；当前schema显式设置不变', () => {
  const ids = ['qq:current_group_recent', 'qq:current_group_search'];
  const pluginGrant = { tool: 'hello-group/lookup', groupIds: ['222222'], userIds: ['333333'], allowWrite: true };
  const make = schemaVersion => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.schemaVersion = schemaVersion; config.botQQ = '111111'; config.qq.enabled = true;
    config.permissions = { released: true, privateReplies: false };
    config.models.deepseek.enabled = true;
    config.tools = { ...config.tools, enabled: true, builtinQQ: true, catalogMode: 'all',
      grants: [...ids.map(tool => ({ ...pluginGrant, tool })), pluginGrant] };
    config.groups = [{ id: '222222', mode: 'social', read: true, send: true, social: { readTools: [...ids, pluginGrant.tool] } }];
    return config;
  };
  for (const version of [1, 2, 3]) {
    const original = make(version), snapshot = structuredClone(original), migrated = migrateConfig(original);
    assert.deepEqual(original, snapshot);
    assert.equal(migrated.tools.builtinQQ, false);
    assert.equal(migrated.tools.catalogMode, 'all');
    assert.deepEqual(migrated.tools.grants, [pluginGrant]);
    assert.deepEqual(migrated.groups[0].social.readTools, [pluginGrant.tool]);
    assert.equal(migrated.permissions.released, true);
    assert.equal(migrated.groups[0].send, true);
    assert.deepEqual(migrateConfig(migrated), migrated);
    assert.equal(validateConfig(original).tools.builtinQQ, false);
    const padded = make(version);
    padded.tools.grants[0].tool = `  ${ids[0]}\n`;
    padded.groups[0].social.readTools[0] = `  ${ids[0]}\n`;
    assert.deepEqual(validateConfig(padded).tools.grants, [pluginGrant]);
    assert.deepEqual(validateConfig(padded).groups[0].social.readTools, [pluginGrant.tool]);
  }
  const current = validateConfig(make(4));
  assert.equal(current.tools.builtinQQ, true);
  assert.equal(current.tools.catalogMode, 'all');
  assert.deepEqual(current.tools.grants.map(grant => grant.tool), [...ids, pluginGrant.tool]);
  assert.deepEqual(current.groups[0].social.readTools, [...ids, pluginGrant.tool]);
  assert.equal(current.permissions.released, true);
});
