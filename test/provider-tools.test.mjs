import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviders } from '../src/providers.mjs';

const tools = [{ type: 'function', function: { name: 'lookup', description: 'Look up a fact',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } } }];
const call = { id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"query":"hi"}' } };
const config = { enabled: true, baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', maxTokens: 128, temperature: 0 };
const messages = [{ role: 'user', content: 'Look up hi' }];
const payload = (message, finish_reason = 'stop') => ({ choices: [{ message, finish_reason }], usage: { total_tokens: 10 } });

function fixture(body) {
  const requests = [];
  const providers = createProviders({ fetchImpl: async (url, options) => {
    requests.push({ url: String(url), options, body: JSON.parse(options.body) });
    return new Response(JSON.stringify(body), { status: 200 });
  }, spawnImpl: () => { throw new Error('工具 API 调用不能切换到 Codex'); } });
  return { providers, requests };
}

test('API 模型转发 tools 与 tool_choice，接受只有函数调用而没有文字的响应', async () => {
  const f = fixture(payload({ content: null, tool_calls: [call] }, 'tool_calls'));
  const result = await f.providers.deepseek({ messages, config, apiKey: 'test-only-key', tools, toolChoice: 'auto' });
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, 'https://api.deepseek.com/chat/completions');
  assert.deepEqual(f.requests[0].body.tools, tools);
  assert.equal(f.requests[0].body.tool_choice, 'auto');
  assert.equal(f.requests[0].body.parallel_tool_calls, false);
  assert.equal(f.requests[0].body.stream, false);
  assert.equal(result.text, '');
  assert.deepEqual(result.toolCalls, [call]);
  assert.equal(result.provider, 'deepseek');
});

test('兼容 API 同样支持函数调用，最终回答可以明确禁止继续调用工具', async () => {
  const f = fixture(payload({ content: ' done ', tool_calls: [] }));
  const result = await f.providers.compatible({ messages, config: { ...config, id: 'api_probe', label: 'Probe', baseUrl: 'https://models.example.test/v1' },
    apiKey: 'test-only-key', tools: [], toolChoice: 'none' });
  assert.equal(result.text, 'done');
  assert.equal(result.toolCalls, undefined);
  assert.equal(f.requests[0].url, 'https://models.example.test/v1/chat/completions');
  assert.deepEqual(f.requests[0].body.tools, []);
  assert.equal(f.requests[0].body.tool_choice, 'none');
});

test('普通文字响应接受缺省、null 或空数组的 tool_calls，不影响原有聊天', async t => {
  for (const [label, extra] of [['omitted', {}], ['null', { tool_calls: null }], ['empty', { tool_calls: [] }]]) {
    await t.test(label, async () => {
      const f = fixture(payload({ content: ' Normal text ', ...extra }));
      const result = await f.providers.deepseek({ messages, config, apiKey: 'test-only-key' });
      assert.equal(result.text, 'Normal text');
      assert.equal(result.toolCalls, undefined);
      assert.equal(f.requests[0].body.tools, undefined);
      assert.equal(f.requests[0].body.tool_choice, undefined);
    });
  }
});

test('未请求、格式错误、超量或截断的函数响应不能交给执行器', async t => {
  const cases = [
    ['unsolicited calls', { content: null, tool_calls: [call] }, 'tool_calls', {}],
    ['tool choice none', { content: null, tool_calls: [call] }, 'tool_calls', { tools: [], toolChoice: 'none' }],
    ['not array', { content: 'text', tool_calls: { bad: true } }, 'stop', { tools }],
    ['too many calls', { content: null, tool_calls: Array.from({ length: 4 }, (_, i) => ({ ...call, id: `c${i}` })) }, 'tool_calls', { tools }],
    ['truncated tool arguments', { content: null, tool_calls: [call] }, 'length', { tools }],
  ];
  for (const [label, message, finish, args] of cases) await t.test(label, async () => {
    const f = fixture(payload(message, finish));
    await assert.rejects(f.providers.deepseek({ messages, config, apiKey: 'test-only-key', ...args }));
    assert.equal(f.requests.length, 1, '错误不能触发静默重试');
  });
});
