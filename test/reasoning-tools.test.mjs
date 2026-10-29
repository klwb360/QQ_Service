import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviders } from '../src/providers.mjs';
import { runToolConversation } from '../src/tool-router.mjs';

const schema = { type: 'object', properties: {}, additionalProperties: false };
const tool = { id: 'probe/lookup', name: 'lookup', description: 'Read data', inputSchema: schema };
const config = { enabled: true, baseUrl: 'https://api.deepseek.com', model: 'deepseek-reasoner', maxTokens: 1024, temperature: 0 };

test('思考模型工具续传保留在协议内，不成为 QQ 最终文字或对外结果', async () => {
  let requests = 0, executions = 0;
  const continuation = 'opaque-provider-continuation';
  const providers = createProviders({ fetchImpl: async (_url, options) => {
    requests++;
    if (requests === 1) return Response.json({ choices: [{ finish_reason: 'tool_calls', message: {
      content: null, reasoning_content: continuation,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
    } }] });
    const body = JSON.parse(options.body);
    const previous = body.messages.find(message => message.role === 'assistant');
    assert.equal(previous.reasoning_content, continuation);
    assert.equal(body.messages.at(-1).role, 'tool');
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '已核对结果。', reasoning_content: 'opaque-final-continuation' } }] });
  } });
  const result = await runToolConversation({ messages: [{ role: 'user', content: '请查资料' }], tools: [tool],
    infer: (messages, tools, options) => providers.deepseek({ messages, tools, toolChoice: options.toolChoice, config, apiKey: 'fixture-key' }),
    execute: async () => { executions++; return { text: 'verified data' }; },
  });
  assert.equal(executions, 1); assert.equal(requests, 2);
  assert.equal(result.text, '已核对结果。');
  assert.equal(Object.hasOwn(result, 'reasoningContent'), false);
  assert.equal(JSON.stringify(result).includes(continuation), false);
});

test('工具续传字段超过边界时，在执行工具前拒绝', async () => {
  let executions = 0;
  const providers = createProviders({ fetchImpl: async () => Response.json({ choices: [{ finish_reason: 'tool_calls', message: {
    content: null, reasoning_content: 'x'.repeat(128 * 1024 + 1),
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
  } }] }) });
  await assert.rejects(runToolConversation({ messages: [], tools: [tool],
    infer: (messages, tools, options) => providers.deepseek({ messages, tools, toolChoice: options.toolChoice, config, apiKey: 'fixture-key' }),
    execute: async () => { executions++; return null; },
  }), /续传/);
  assert.equal(executions, 0);
});
