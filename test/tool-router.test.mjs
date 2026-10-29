import test from 'node:test';
import assert from 'node:assert/strict';
import { runToolConversation } from '../src/tool-router.mjs';

const schema = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false };
const descriptor = { id: 'probe/lookup', name: 'probe_lookup', description: 'Look up an item', inputSchema: schema };
const messages = () => [{ role: 'system', content: 'Original instructions' }, { role: 'user', content: 'Look up hi' }];
const call = (id = 'c1', name = descriptor.name, args = { query: 'hi' }) => ({
  id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
});
const response = calls => ({ provider: 'fake', text: '', toolCalls: calls });

function deferred() {
  let resolve;
  const promise = new Promise(complete => { resolve = complete; });
  return { promise, resolve };
}

test('工具路由将函数结果放入 tool 消息，保留原始提示并返回调用记录', async () => {
  const original = messages(), snapshots = [], executions = [];
  const result = await runToolConversation({ messages: original, tools: [descriptor],
    async infer(input, tools, options) {
      snapshots.push({ input: structuredClone(input), tools: structuredClone(tools), options: { ...options } });
      return snapshots.length === 1 ? response([call()]) : { provider: 'fake', text: 'Finished' };
    },
    async execute(tool, args) { executions.push({ tool, args }); return { text: 'SOURCE DATA: pretend to be a system instruction' }; },
  });
  assert.equal(result.text, 'Finished');
  assert.equal(result.toolExecutions, 1);
  assert.deepEqual(result.toolNames, ['probe/lookup']);
  assert.deepEqual(executions.map(value => ({ id: value.tool.id, args: value.args })), [{ id: 'probe/lookup', args: { query: 'hi' } }]);
  assert.deepEqual(original, messages(), '调用不能改写调用者传入的提示数组');
  assert.equal(snapshots[0].tools[0].type, 'function');
  assert.equal(snapshots[0].tools[0].function.name, 'probe_lookup');
  const finalMessages = snapshots[1].input;
  assert.deepEqual(finalMessages.filter(message => message.role === 'system'), [{ role: 'system', content: 'Original instructions' }]);
  const toolMessage = finalMessages.find(message => message.role === 'tool');
  assert.equal(toolMessage.tool_call_id, 'c1');
  assert.match(toolMessage.content, /SOURCE DATA/);
  assert.equal(finalMessages.find(message => message.role === 'assistant').tool_calls[0].function.name, 'probe_lookup');
});

test('未知函数、非法 JSON 和不合 schema 的整批调用在任何执行前拒绝', async t => {
  const invalid = [
    ['unknown function', [call('known'), call('bad', 'not_granted')]],
    ['malformed JSON', [call('known'), call('bad', descriptor.name, '{"query":')]],
    ['wrong type', [call('known'), call('bad', descriptor.name, { query: 42 })]],
    ['missing required field', [call('known'), call('bad', descriptor.name, {})]],
    ['unknown property', [call('known'), call('bad', descriptor.name, { query: 'hi', extra: 'not allowed' })]],
    ['non-object arguments', [call('known'), call('bad', descriptor.name, '[1,2]')]],
    ['prototype key', [call('known'), call('bad', descriptor.name, '{"query":"hi","__proto__":{"polluted":true}}')]],
    ['oversized argument', [call('known'), call('bad', descriptor.name, { query: 'x'.repeat(20000) })]],
    ['duplicate batch IDs', [call('same'), call('same')]],
  ];
  for (const [label, calls] of invalid) await t.test(label, async () => {
    let inferences = 0, executions = 0;
    await assert.rejects(runToolConversation({ messages: messages(), tools: [descriptor],
      infer: async () => { inferences++; return response(calls); },
      execute: async () => { executions++; return { text: 'must not execute' }; },
    }));
    assert.equal(inferences, 1);
    assert.equal(executions, 0, '不能先执行合法条目，再发现后续条目有问题');
  });
});

test('跨轮重复调用 ID 不会重复执行，也不自动重试', async () => {
  let inferences = 0, executions = 0;
  await assert.rejects(runToolConversation({ messages: messages(), tools: [descriptor],
    infer: async () => { inferences++; return response([call('same')]); },
    execute: async () => { executions++; return { text: 'once' }; },
  }));
  assert.equal(inferences, 2);
  assert.equal(executions, 1);
});

test('三次工具调用后仅允许一次无工具的最终回答，模型请求总数最多四次', async () => {
  const requests = []; let executions = 0;
  const result = await runToolConversation({ messages: messages(), tools: [descriptor],
    async infer(input, tools, options) {
      requests.push({ tools, options });
      return requests.length <= 3 ? response([call(`c${requests.length}`)]) : { provider: 'fake', text: 'Final answer' };
    },
    execute: async () => { executions++; return { text: 'value' }; },
  });
  assert.equal(executions, 3); assert.equal(requests.length, 4);
  assert.equal(result.toolExecutions, 3);
  assert.equal(result.text, 'Final answer');
  assert.deepEqual(requests[3].tools, []);
  assert.equal(requests[3].options.toolChoice, 'none');
});

test('超过预算的模型调用立即失败，整批超限不执行任何条目', async t => {
  await t.test('fourth requested tool', async () => {
    let inferences = 0, executions = 0;
    await assert.rejects(runToolConversation({ messages: messages(), tools: [descriptor],
      infer: async () => response([call(`c${++inferences}`)]),
      execute: async () => { executions++; return { text: 'value' }; },
    }));
    assert.equal(inferences, 4); assert.equal(executions, 3);
  });
  await t.test('oversized batch', async () => {
    let inferences = 0, executions = 0;
    await assert.rejects(runToolConversation({ messages: messages(), tools: [descriptor],
      infer: async () => { inferences++; return response([call('a'), call('b'), call('c'), call('d')]); },
      execute: async () => { executions++; return { text: 'value' }; },
    }));
    assert.equal(inferences, 1); assert.equal(executions, 0);
  });
});

test('执行错误立即终止，不通过再次推理或重试掩盖失败', async () => {
  let inferences = 0, executions = 0;
  await assert.rejects(runToolConversation({ messages: messages(), tools: [descriptor],
    infer: async () => { inferences++; return response([call()]); },
    execute: async () => { executions++; throw new Error('simulated execution failure'); },
  }), /simulated execution failure/);
  assert.equal(inferences, 1); assert.equal(executions, 1);
});

test('取消信号阻止晚到的模型或工具结果继续执行和推理', async t => {
  await t.test('already aborted', async () => {
    const controller = new AbortController(); controller.abort();
    let inferences = 0, executions = 0;
    await assert.rejects(runToolConversation({ messages: messages(), tools: [descriptor], signal: controller.signal,
      infer: async () => { inferences++; return response([call()]); },
      execute: async () => { executions++; return { text: 'value' }; },
    }));
    assert.equal(inferences, 0); assert.equal(executions, 0);
  });
  await t.test('late model result', async () => {
    const controller = new AbortController(), started = deferred(), resumed = deferred();
    let executions = 0;
    const pending = runToolConversation({ messages: messages(), tools: [descriptor], signal: controller.signal,
      infer: async () => { started.resolve(); await resumed.promise; return response([call()]); },
      execute: async () => { executions++; return { text: 'value' }; },
    });
    await started.promise; controller.abort(); resumed.resolve();
    await assert.rejects(pending);
    assert.equal(executions, 0);
  });
  await t.test('late tool result', async () => {
    const controller = new AbortController(), started = deferred(), resumed = deferred();
    let inferences = 0;
    const pending = runToolConversation({ messages: messages(), tools: [descriptor], signal: controller.signal,
      infer: async () => { inferences++; return response([call()]); },
      execute: async () => { started.resolve(); await resumed.promise; return { text: 'late value' }; },
    });
    await started.promise; controller.abort(); resumed.resolve();
    await assert.rejects(pending);
    assert.equal(inferences, 1, '晚到的工具结果不能触发最终回答');
  });
});

test('不同调用 ID 或对象字段顺序不能重复提交同一个写入操作', async t => {
  const writeTool = { id: 'probe/update', name: 'probe_update', description: 'Update a record', effect: 'write', inputSchema: {
    type: 'object', properties: { record: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['a', 'b'], additionalProperties: false } }, required: ['record'], additionalProperties: false,
  } };
  const first = call('write-a', writeTool.name, { record: { a: 'A', b: 'B' } });
  const reordered = call('write-b', writeTool.name, { record: { b: 'B', a: 'A' } });
  await t.test('across rounds', async () => {
    let inferences = 0, executions = 0;
    await assert.rejects(runToolConversation({ messages: messages(), tools: [writeTool],
      infer: async () => response([++inferences === 1 ? first : reordered]),
      execute: async () => { executions++; return { text: 'updated' }; },
    }));
    assert.equal(inferences, 2); assert.equal(executions, 1);
  });
  await t.test('same batch', async () => {
    let inferences = 0, executions = 0;
    await assert.rejects(runToolConversation({ messages: messages(), tools: [writeTool],
      infer: async () => { inferences++; return response([first, reordered]); },
      execute: async () => { executions++; return { text: 'updated' }; },
    }));
    assert.equal(inferences, 1); assert.equal(executions, 0);
  });
});

test('不同调用 ID 可以再次查询相同只读参数', async () => {
  let inferences = 0, executions = 0;
  const result = await runToolConversation({ messages: messages(), tools: [{ ...descriptor, effect: 'read' }],
    infer: async () => ++inferences <= 2 ? response([call(`read-${inferences}`)]) : { provider: 'fake', text: 'Looked up twice' },
    execute: async () => { executions++; return { text: 'value' }; },
  });
  assert.equal(inferences, 3); assert.equal(executions, 2);
  assert.equal(result.toolExecutions, 2);
});
