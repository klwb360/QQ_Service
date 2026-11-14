import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMcpConfig, validateMcpServerConfig, mcpToolId, mcpDefinitionHash,
  mcpSecretName, parseMcpSecretName, importMcpConfig, validateMcpServerUrl, mcpConnectionDescriptor } from '../src/mcp-config.mjs';

const stdio = overrides => ({ id: 'local-tools', label: '本地工具', transport: 'stdio', command: 'node', args: ['server.mjs'], ...overrides });
const http = overrides => ({ id: 'remote-tools', transport: 'http', url: 'https://mcp.example.com/mcp', ...overrides });

test('MCP配置默认关闭且工具效果默认write，启用工具必须有确认的定义hash', () => {
  assert.deepEqual(validateMcpConfig(), { servers: [] });
  const server = validateMcpServerConfig(stdio({ tools: [{ name: 'search' }] }));
  assert.equal(server.enabled, false);
  assert.deepEqual(server.envKeys, []); assert.deepEqual(server.headerKeys, []);
  assert.deepEqual(server.tools[0], { name: 'search', enabled: false, effect: 'write', definitionHash: '', connectionHash: '' });
  assert.equal(server.timeoutSeconds, 30);
  assert.throws(() => validateMcpServerConfig(stdio({ tools: [{ name: 'search', enabled: true, effect: 'read' }] })), /确认工具定义/);
  assert.throws(() => validateMcpServerConfig(stdio({ tools: [{ name: 'search', enabled: true, effect: 'read', definitionHash: 'a'.repeat(64) }] })), /当前连接/);
  const approved = validateMcpServerConfig(stdio({ enabled: true, tools: [{ name: 'search', enabled: true, effect: 'read', definitionHash: 'a'.repeat(64), connectionHash: 'b'.repeat(64) }] }));
  assert.equal(approved.tools[0].enabled, true);
  for (const invalid of [
    stdio({ id: 'Bad_Id' }), stdio({ enabled: 'yes' }), stdio({ command: '' }), stdio({ args: 'shell command' }),
    stdio({ timeoutSeconds: 0 }), stdio({ timeoutSeconds: 301 }), stdio({ url: 'https://example.com' }),
    stdio({ env: { KEY: 'plaintext' } }), stdio({ headerKeys: ['authorization'] }),
    http({ command: 'node' }), http({ envKeys: ['KEY'] }), http({ headerKeys: ['Authorization', 'authorization'] }),
    stdio({ tools: [{ name: 'search' }, { name: 'search' }] }), stdio({ tools: [{ name: 'search', effect: 'unknown' }] }),
  ]) assert.throws(() => validateMcpServerConfig(invalid), error => error.code === 'MCP_CONFIG_INVALID');
  assert.throws(() => validateMcpConfig({ servers: [stdio(), stdio()] }), /不能重复/);
});

test('工具标识稳定且不同服务不混用，定义变化包括输出schema会改变审批hash', () => {
  const tool = { name: 'search with 中文', description: 'description', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } };
  assert.match(mcpToolId('local-tools', tool.name), /^mcp:local-tools\/[a-f0-9]{24}$/);
  assert.equal(mcpToolId('local-tools', tool.name), mcpToolId('local-tools', tool.name));
  assert.notEqual(mcpToolId('other-tools', tool.name), mcpToolId('local-tools', tool.name));
  assert.equal(mcpDefinitionHash(tool), mcpDefinitionHash({ inputSchema: { properties: { query: { type: 'string' } }, type: 'object' }, description: 'description', name: tool.name }));
  assert.notEqual(mcpDefinitionHash(tool), mcpDefinitionHash({ ...tool, outputSchema: { type: 'object' } }));
  assert.notEqual(mcpDefinitionHash(tool), mcpDefinitionHash({ ...tool, annotations: { readOnlyHint: true } }));
});

test('MCP凭据只绑定指定服务与env/header名称，请求头规范小写', () => {
  assert.equal(mcpSecretName('local-tools', 'env', 'API_KEY'), 'mcpSecret:local-tools:env:API_KEY');
  assert.equal(mcpSecretName('remote-tools', 'header', 'Authorization'), 'mcpSecret:remote-tools:header:authorization');
  assert.deepEqual(parseMcpSecretName('mcpSecret:local-tools:env:API_KEY'), { serverId: 'local-tools', kind: 'env', key: 'API_KEY' });
  assert.deepEqual(parseMcpSecretName('mcpSecret:remote-tools:header:authorization'), { serverId: 'remote-tools', kind: 'header', key: 'authorization' });
  for (const name of ['mcpSecret:../escape:env:KEY', 'mcpSecret:local-tools:env:BAD KEY', 'mcpSecret:remote-tools:header:Authorization', 'mcpSecret:x:unknown:key', 'otherSecret:x:env:KEY']) assert.equal(parseMcpSecretName(name), null);
  assert.throws(() => mcpSecretName('local-tools', 'header', 'Bad\r\nHeader'), /无效/);
});

test('常见mcpServers导入拆分密钥且不启用服务、不信任工具提示或旧审批', () => {
  const { servers, secretUpdates } = importMcpConfig({ mcpServers: {
    '本地工具': { command: 'node', args: ['server.mjs'], env: { API_KEY: 'private-model-key' }, enabled: true,
      tools: [{ name: 'dangerous', enabled: true, effect: 'read', definitionHash: 'f'.repeat(64), readOnlyHint: true }] },
    'remote-tools': { url: 'https://mcp.example.com/mcp', type: 'streamable-http', headers: { Authorization: 'Bearer remote-secret' } },
  } });
  assert.equal(servers.length, 2);
  assert.match(servers[0].id, /^[a-z][a-z0-9-]{0,63}$/);
  assert.equal(servers[0].enabled, false);
  assert.deepEqual(servers[0].envKeys, ['API_KEY']);
  assert.deepEqual(servers[0].tools[0], { name: 'dangerous', enabled: false, effect: 'write', definitionHash: '', connectionHash: '' });
  assert.equal(servers[1].transport, 'http');
  assert.deepEqual(servers[1].headerKeys, ['authorization']);
  assert.equal(secretUpdates[mcpSecretName(servers[0].id, 'env', 'API_KEY')], 'private-model-key');
  assert.equal(secretUpdates['mcpSecret:remote-tools:header:authorization'], 'Bearer remote-secret');
  assert.equal(JSON.stringify(servers).includes('private-model-key'), false);
  assert.equal(JSON.stringify(servers).includes('remote-secret'), false);
});

test('本应用descriptor导入同样重新审批，格式错误可见拒绝且原对象不被修改', () => {
  const original = { servers: [validateMcpServerConfig(stdio({ enabled: true, tools: [{ name: 'search', enabled: true, effect: 'read', definitionHash: 'a'.repeat(64), connectionHash: 'b'.repeat(64) }] }))] };
  const imported = importMcpConfig(JSON.stringify(original));
  assert.equal(imported.servers[0].enabled, false);
  assert.equal(imported.servers[0].tools[0].enabled, false);
  assert.equal(original.servers[0].enabled, true);
  assert.equal(importMcpConfig(original.servers).servers[0].id, original.servers[0].id);
  for (const value of [
    '{not json', { mcpServers: [] }, { mcpServers: { bad: { command: 'node', env: { KEY: 1 } } } },
    { mcpServers: { bad: { url: 'https://mcp.example.com', headers: { authorization: 'a\r\nb' } } } },
    { servers: [stdio({ tools: ['bad'] })] }, { servers: [stdio({ tools: 'invalid' })] },
    { servers: [stdio({ transport: 'unknown' })] },
  ]) assert.throws(() => importMcpConfig(value), error => error.code === 'MCP_CONFIG_INVALID');
});

test('连接审批形状排除显示、超时与工具授权，保留程序、地址和凭据名称', () => {
  const descriptor = mcpConnectionDescriptor(stdio({ envKeys: ['Z_KEY', 'A_KEY'] }));
  assert.deepEqual(descriptor.envKeys, ['A_KEY', 'Z_KEY']);
  assert.deepEqual(descriptor, mcpConnectionDescriptor(stdio({ label: '改显示名称', enabled: true, timeoutSeconds: 90, envKeys: ['A_KEY', 'Z_KEY'], tools: [{ name: 'other' }] })));
  assert.notDeepEqual(descriptor, mcpConnectionDescriptor(stdio({ command: 'other-node', envKeys: ['Z_KEY', 'A_KEY'] })));
  assert.equal(Object.hasOwn(descriptor, 'tools'), false);
  assert.equal(Object.hasOwn(descriptor, 'enabled'), false);
  assert.equal(Object.hasOwn(descriptor, 'label'), false);
});

test('初始HTTP仅本机或容器显式sidecar，拒URL凭据而允许HTTPS与普通查询参数', () => {
  const env = { container: process.env.QQ_SERVICE_CONTAINER, hosts: process.env.QQ_SERVICE_MCP_HOSTS };
  try {
    delete process.env.QQ_SERVICE_CONTAINER; process.env.QQ_SERVICE_MCP_HOSTS = 'mcp-sidecar';
    assert.equal(validateMcpServerUrl('http://127.0.0.1:3000/mcp'), 'http://127.0.0.1:3000/mcp');
    assert.equal(validateMcpServerUrl('http://[::1]:3000/sse'), 'http://[::1]:3000/sse');
    assert.equal(validateMcpServerUrl('https://mcp.example.com/mcp?region=cn'), 'https://mcp.example.com/mcp?region=cn');
    assert.throws(() => validateMcpServerUrl('http://mcp.example.com/mcp'), /HTTPS/);
    assert.throws(() => validateMcpServerUrl('http://mcp-sidecar:3000/mcp'), /HTTPS/);
    process.env.QQ_SERVICE_CONTAINER = '1';
    assert.equal(validateMcpServerUrl('http://mcp-sidecar:3000/mcp'), 'http://mcp-sidecar:3000/mcp');
    for (const url of ['file:///tmp/mcp', 'https://user:pass@mcp.example.com/mcp', 'https://mcp.example.com/mcp#key',
      'https://mcp.example.com/mcp?api_key=secret', 'https://mcp.example.com/mcp?sessionId=secret', 'https://mcp.example.com/mcp?myToken=secret']) assert.throws(() => validateMcpServerUrl(url));
  } finally {
    if (env.container === undefined) delete process.env.QQ_SERVICE_CONTAINER; else process.env.QQ_SERVICE_CONTAINER = env.container;
    if (env.hosts === undefined) delete process.env.QQ_SERVICE_MCP_HOSTS; else process.env.QQ_SERVICE_MCP_HOSTS = env.hosts;
  }
});

test('配置解析拒getter、循环、原型污染和过大文件，不执行导入代码', () => {
  let accessed = false;
  const dynamic = Object.defineProperty({}, 'servers', { enumerable: true, get() { accessed = true; throw new Error('must not execute'); } });
  assert.throws(() => validateMcpConfig(dynamic));
  assert.equal(accessed, false);
  const cyclic = {}; cyclic.servers = [cyclic];
  assert.throws(() => validateMcpConfig(cyclic));
  assert.throws(() => importMcpConfig(JSON.parse('{"mcpServers":{"__proto__":{"command":"node"}}}')));
  assert.throws(() => importMcpConfig(' '.repeat(512 * 1024 + 1)));
  assert.throws(() => validateMcpConfig({ servers: Array.from({ length: 21 }, (_, i) => stdio({ id: `server-${i}` })) }));
});
