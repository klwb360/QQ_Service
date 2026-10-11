import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createProviders } from '../src/providers.mjs';

function mockSpawner(events, inspect = () => {}) {
  return (command, args, options) => {
    inspect(command, args, options);
    const child = new EventEmitter(); child.exitCode = null; child.killed = false;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; child.exitCode = 1; return true; };
    child.stdin.on('finish', () => {
      setImmediate(() => {
        for (const event of events) child.stdout.write(JSON.stringify(event) + '\n');
        child.exitCode = 0; child.emit('close', 0);
      });
    });
    return child;
  };
}
const invocation = { command: 'official-codex-mock', args: ['codex.js'], cwd: '/isolated', env: { CODEX_HOME: '/isolated-auth', OPENAI_API_KEY: 'must-not-pass', OPENAI_BASE_URL: 'must-not-pass' } };

test('Codex 只接受完成的文字流，命令固定 argv、不继承付费 API 凭据', async () => {
  let checked = false;
  const providers = createProviders({ spawnImpl: mockSpawner([
    { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: '已解释' } },
    { type: 'turn.completed', usage: {} }
  ], (_, args, options) => {
    checked = true; assert.equal(options.shell, false); assert.equal(options.env.OPENAI_API_KEY, undefined);
    assert.equal(options.env.OPENAI_BASE_URL, undefined); assert.equal(args.includes('--ignore-user-config'), true);
    assert.equal(args.includes('--ignore-rules'), true); assert.equal(args.includes('read-only'), true);
  }) });
  const result = await providers.codex({ prompt: '只解释文字，不执行 $(example)', config: { enabled: true, timeoutSeconds: 30 }, invocation });
  assert.equal(checked, true); assert.equal(result.text, '已解释');
});

test('Codex 工具事件或缺少完成事件时不能伪装成成功答案', async () => {
  const unsafe = createProviders({ spawnImpl: mockSpawner([{ type: 'item.started', item: { id: 'tool', type: 'command_execution', command: 'bad' } }]) });
  await assert.rejects(unsafe.codex({ prompt: 'x', config: { enabled: true }, invocation }), /尝试调用工具/);
  const incomplete = createProviders({ spawnImpl: mockSpawner([{ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: '未完成' } }]) });
  await assert.rejects(incomplete.codex({ prompt: 'x', config: { enabled: true }, invocation }), /未返回完成/);
});

test('DeepSeek 错误不会启动 GPT 或静默换计费通道', async () => {
  let spawned = 0;
  const providers = createProviders({ spawnImpl: () => { spawned++; throw new Error('不可调用'); }, fetchImpl: async () => new Response(JSON.stringify({ error: { message: '额度不足' } }), { status: 429 }) });
  await assert.rejects(providers.deepseek({ messages: [], config: { enabled: true, baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', maxTokens: 128, temperature: 0 }, apiKey: 'test-only' }), /429/);
  assert.equal(spawned, 0);
});
