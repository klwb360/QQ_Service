import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, migrateConfig, validateConfig, isCredentialName } from '../src/config.mjs';
import { createStore } from '../src/store.mjs';
import { mcpToolId, mcpSecretName } from '../src/mcp-config.mjs';

const server = overrides => ({ id: 'weather', label: 'Weather', enabled: false, transport: 'http', url: 'https://mcp.example.com/mcp',
  command: '', args: [], envKeys: [], headerKeys: ['authorization'], timeoutSeconds: 30, tools: [], ...overrides });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-service-mcp-store-'));
  const store = createStore(dir);
  return { dir, store, close() { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('schema4默认无MCP权限，当前schema严格校验MCP并兼容插件和MCP工具标识', () => {
  assert.equal(DEFAULT_CONFIG.schemaVersion, 4);
  assert.deepEqual(validateConfig(DEFAULT_CONFIG).mcp, { servers: [] });
  const config = structuredClone(DEFAULT_CONFIG), tool = mcpToolId('weather', 'forecast');
  config.mcp = { servers: [server()] };
  config.groups = [{ id: '222222', mode: 'social', read: true, social: { readTools: [tool, 'bilibili/search'] } }];
  config.tools.grants = [{ tool, groupIds: ['222222'], userIds: ['333333'], allowWrite: false }];
  const validated = validateConfig(config);
  assert.deepEqual(validated.groups[0].social.readTools, [tool, 'bilibili/search']);
  assert.equal(validated.tools.grants[0].tool, tool);
  assert.equal(validated.permissions.released, false);
  for (const invalid of [null, { servers: 'not-array' }, { servers: [server({ envKeys: { KEY: 'plaintext' } })] }, { servers: [server({ enabled: 'true' })] }]) {
    assert.throws(() => validateConfig({ ...config, mcp: invalid }), error => error.issues.some(issue => issue.path === 'mcp'));
  }
  config.tools.grants[0].tool = 'mcp:weather/not-a-digest';
  assert.throws(() => validateConfig(config), /配置校验/);
});

test('v1/v2/v3迁移保留旧权限和模型退休规则，旧MCP只以禁用导入进入schema4', () => {
  const tool = mcpToolId('weather', 'forecast');
  for (const version of [1, 2, 3]) {
    const config = structuredClone(DEFAULT_CONFIG);
    config.schemaVersion = version;
    config.permissions = { released: true, privateReplies: false };
    config.qq.enabled = true; config.botQQ = '111111'; config.models.deepseek.enabled = true;
    config.tools.grants = [{ tool, groupIds: ['222222'], userIds: [], allowWrite: true }, { tool: 'bilibili/search', groupIds: ['222222'], userIds: [], allowWrite: false }];
    config.groups = [{ id: '222222', mode: 'social', read: true, send: true, social: { readTools: [tool, 'bilibili/search'] } }];
    config.mcp = { servers: [server({ enabled: true, tools: [{ name: 'forecast', enabled: true, effect: 'read', definitionHash: 'a'.repeat(64), connectionHash: 'b'.repeat(64) }] })] };
    const migrated = migrateConfig(config);
    assert.equal(migrated.schemaVersion, 4);
    assert.equal(migrated.permissions.released, true);
    assert.equal(migrated.mcp.servers[0].enabled, false);
    assert.deepEqual(migrated.mcp.servers[0].tools[0], { name: 'forecast', enabled: false, effect: 'write', definitionHash: '', connectionHash: '' });
    assert.deepEqual(migrated.tools.grants.map(grant => grant.tool), ['bilibili/search']);
    assert.deepEqual(migrated.groups[0].social.readTools, ['bilibili/search']);
    assert.deepEqual(migrateConfig(migrated), migrated);
    config.models.codex = { enabled: true };
    config.chat.provider = 'codex'; config.chat.enabled = true;
    const retired = migrateConfig(config);
    assert.equal(retired.permissions.released, false);
    assert.equal(Object.hasOwn(retired.models, 'codex'), false);
  }
});

test('MCP凭据进加密vault，draft读取独立，配置和连接审批HMAC不暴露凭据', () => {
  const f = fixture();
  try {
    const secret = mcpSecretName('weather', 'header', 'authorization');
    assert.equal(isCredentialName(secret), true);
    assert.equal(isCredentialName('mcpSecret:other:env:API_KEY'), true);
    assert.equal(isCredentialName('mcpSecret:weather:header:Authorization'), false);
    f.store.setSecret(secret, 'Bearer applied-private-value');
    f.store.stageSecrets({ [secret]: 'Bearer draft-private-value' });
    assert.equal(f.store.getSecret(secret), 'Bearer applied-private-value');
    assert.equal(f.store.getDraftSecret(secret), 'Bearer draft-private-value');
    assert.equal(f.store.hasDraftSecret(secret), true);
    const active = f.store.mcpConnectionHash(server());
    const draft = f.store.mcpConnectionHash(server(), f.store.getDraftSecret);
    assert.match(active, /^[a-f0-9]{64}$/); assert.notEqual(active, draft);
    f.store.commitSecrets();
    assert.equal(f.store.mcpConnectionHash(server()), draft);
    f.store.saveDraft(validateConfig({ ...structuredClone(DEFAULT_CONFIG), mcp: { servers: [server()] } }));
    assert.equal(JSON.stringify(f.store.getState()).includes('private-value'), false);
    assert.equal(fs.readFileSync(path.join(f.dir, 'config.json'), 'utf8').includes('private-value'), false);
    assert.equal(fs.readFileSync(path.join(f.dir, 'vault.json'), 'utf8').includes('private-value'), false);
  } finally { f.close(); }
});

test('MCP连接HMAC按profile私钥、目标和相关凭据绑定；label、timeout与无关密钥不改变审批', () => {
  const f = fixture(), other = fixture();
  try {
    const credential = mcpSecretName('weather', 'header', 'authorization');
    f.store.setSecret(credential, 'same-password'); other.store.setSecret(credential, 'same-password');
    const hash = f.store.mcpConnectionHash(server());
    assert.notEqual(other.store.mcpConnectionHash(server()), hash);
    assert.equal(f.store.mcpConnectionHash(server({ label: '另一个显示名称', timeoutSeconds: 120, enabled: true })), hash);
    f.store.setSecret('deepseekApiKey', 'irrelevant-model-secret');
    f.store.setSecret(mcpSecretName('other', 'header', 'authorization'), 'irrelevant-other-server');
    assert.equal(f.store.mcpConnectionHash(server()), hash);
    assert.notEqual(f.store.mcpConnectionHash(server({ url: 'https://other.example.com/mcp' })), hash);
    f.store.setSecret(credential, 'new-password');
    assert.notEqual(f.store.mcpConnectionHash(server()), hash);
    assert.throws(() => f.store.mcpConnectionHash(server(), async () => 'secret'), /同步/);
  } finally { f.close(); other.close(); }
});

test('schema3磁盘状态只备份一次升级至4，保留旧权限、API密钥和账号数据', () => {
  const f = fixture();
  let reopened, closed = false;
  try {
    f.store.setSecret('deepseekApiKey', 'retained-before-upgrade');
    f.store.close(); closed = true;
    const config = structuredClone(DEFAULT_CONFIG); config.schemaVersion = 3; delete config.mcp;
    config.botQQ = '111111'; config.permissions.released = true;
    const state = { draft: config, applied: config, previous: null, revision: 9, appliedRevision: 9 };
    const original = `${JSON.stringify(state, null, 2)}\n`;
    fs.writeFileSync(path.join(f.dir, 'config.json'), original);
    reopened = createStore(f.dir);
    assert.equal(reopened.getConfig().schemaVersion, 4);
    assert.equal(reopened.getConfig().permissions.released, true);
    assert.equal(reopened.getSecret('deepseekApiKey'), 'retained-before-upgrade');
    assert.equal(fs.readFileSync(path.join(f.dir, 'config.v3.backup.json'), 'utf8'), original);
    reopened.close(); reopened = createStore(f.dir);
    assert.equal(fs.readFileSync(path.join(f.dir, 'config.v3.backup.json'), 'utf8'), original);
    assert.equal(reopened.getState().revision, 9);
  } finally {
    if (closed) { reopened?.close(); fs.rmSync(f.dir, { recursive: true, force: true }); } else f.close();
  }
});
