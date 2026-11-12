import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { listMcpPresets, prepareMcpPreset } from '../src/mcp-presets.mjs';
import { importMcpConfig } from '../src/mcp-config.mjs';

test('catalog identifies eight integrations, account types, audit scope and platform limits without credentials', () => {
  const presets = listMcpPresets({ platform: 'win32' });
  assert.equal(presets.length, 8); assert.equal(new Set(presets.map(item => item.id)).size, 8);
  for (const preset of presets) {
    assert.ok(preset.description); assert.ok(preset.accountType); assert.ok(preset.prerequisites.length);
    assert.ok(preset.limitations.length); assert.equal(preset.installation.automatic, false);
    assert.equal(preset.source.reviewedAt, '2026-11-12'); assert.equal(preset.source.fullAudit, false);
  }
  assert.equal(presets.find(item => item.id === 'wechat-windows').canPrepare, true);
  for (const environment of [{ platform: 'linux' }, { platform: 'darwin' }, { platform: 'win32', container: true }]) {
    assert.equal(listMcpPresets(environment).find(item => item.id === 'wechat-windows').canPrepare, false);
  }
  assert.match(presets.find(item => item.id === 'telegram-personal').accountType, /非 Bot/);
  assert.match(presets.find(item => item.id === 'playwright-browser').limitations.join(' '), /不能控制桌面 QQ/);
  presets[0].envKeys.push('INJECTED'); assert.ok(!listMcpPresets()[0].envKeys.includes('INJECTED'));
});

test('bundled preparation produces importable disabled servers and declares only environment names', () => {
  for (const id of ['builtin-web-search', 'builtin-bilibili', 'builtin-notes']) {
    const server = prepareMcpPreset(id);
    assert.equal(server.enabled, false); assert.deepEqual(server.tools, []);
    assert.equal(server.command, 'node'); assert.match(server.args[0], /^\{appDir\}\/examples\/mcp\//);
    const imported = importMcpConfig({ servers: [server] });
    assert.deepEqual(imported.secretUpdates, {}); assert.equal(imported.servers[0].id, id);
    assert.equal(Object.hasOwn(server, 'env'), false); assert.equal(Object.hasOwn(server, 'headers'), false);
  }
  assert.deepEqual(prepareMcpPreset('builtin-web-search').envKeys, ['BRAVE_SEARCH_API_KEY', 'SEARXNG_BASE_URL']);
});

test('Slack remains explicitly blocked until OAuth support exists; URL overrides cannot fake readiness', () => {
  const slack = listMcpPresets().find(item => item.id === 'slack-official');
  assert.equal(slack.needsOAuth, true); assert.equal(slack.canPrepare, false);
  for (const input of [{}, { url: 'https://mcp.slack.com/mcp' }, { command: process.execPath }]) {
    assert.throws(() => prepareMcpPreset('slack-official', input), cause => cause.code === 'MCP_PRESET_OAUTH_REQUIRED');
  }
});

test('third-party launch requires absolute installed selections and rejects automatic installation/eval', () => {
  for (const command of ['', 'node', 'npx']) assert.throws(() => prepareMcpPreset('discord-bot', { command }), cause => cause.code === 'MCP_PRESET_LOCAL_PROGRAM_REQUIRED');
  assert.throws(() => prepareMcpPreset('discord-bot', { command: process.execPath }), cause => cause.code === 'MCP_PRESET_ENTRY_REQUIRED');
  assert.throws(() => prepareMcpPreset('discord-bot', { command: path.resolve('/tools/npx'), args: ['-y', '@pasympa/discord-mcp@latest'] }));
  assert.throws(() => prepareMcpPreset('telegram-personal', { command: process.execPath, args: ['-e', 'download()'] }));
  const discord = prepareMcpPreset('discord-bot', { command: process.execPath, args: [path.resolve('/installed/discord/dist/index.js')] });
  assert.equal(discord.enabled, false); assert.ok(discord.envKeys.includes('DISCORD_TOKEN')); assert.equal(discord.args.length, 1);
  const telegram = prepareMcpPreset('telegram-personal', { command: path.resolve('/installed/bin/telegram-mcp') });
  assert.deepEqual(telegram.args, []);
  assert.ok(!telegram.envKeys.includes('api_id')); assert.ok(!telegram.envKeys.includes('api_hash'));
});

test('preparation rejects unknown IDs, extra config/secret fields and dynamic property getters', () => {
  assert.throws(() => prepareMcpPreset('not-found'), cause => cause.code === 'MCP_PRESET_UNKNOWN');
  for (const input of [{ enabled: true }, { env: { DISCORD_TOKEN: 'secret' } }, null, []]) assert.throws(() => prepareMcpPreset('builtin-notes', input));
  let getterCalled = false;
  const input = Object.defineProperty({}, 'command', { enumerable: true, get() { getterCalled = true; return process.execPath; } });
  assert.throws(() => prepareMcpPreset('builtin-notes', input)); assert.equal(getterCalled, false);
  const args = Object.defineProperty([], '0', { enumerable: true, get() { getterCalled = true; return '/unsafe.js'; } });
  assert.throws(() => prepareMcpPreset('discord-bot', { command: process.execPath, args })); assert.equal(getterCalled, false);
  if (process.platform !== 'win32' || process.env.QQ_SERVICE_CONTAINER === '1') {
    assert.throws(() => prepareMcpPreset('wechat-windows', { command: process.execPath }), cause => cause.code === 'MCP_PRESET_UNSUPPORTED_PLATFORM');
  }
});
