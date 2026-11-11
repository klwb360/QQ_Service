import test from 'node:test';
import assert from 'node:assert/strict';
import { runToolConversation } from '../src/tool-router.mjs';

const schema = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false };
const tool = (index, extra = {}) => ({ id: `fixture/tool-${index}`, name: `fixture_tool_${index}`, description: `Authorized lookup ${index}`,
  effect: 'read', inputSchema: structuredClone(schema), ...extra });
const directory = () => Array.from({ length: 8 }, (_, index) => tool(index));
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const response = (...calls) => ({ provider: 'fixture', text: '', toolCalls: calls });
const search = (id, query, limit) => call(id, 'search_available_tools', { query, ...(limit === undefined ? {} : { limit }) });
const messages = [{ role: 'system', content: 'Original owner rules' }, { role: 'user', content: 'Find the appropriate authorized tool.' }];

test('small authorized catalogs keep their existing real definitions and no discovery step', async () => {
  const tools = directory().slice(0, 6); let inferences = 0;
  const result = await runToolConversation({ messages, tools, infer: async (_, definitions) => {
    inferences++; assert.equal(definitions.length, 6);
    assert.deepEqual(definitions.map(item => item.function.name), tools.map(item => item.name));
    return { text: 'No tool is needed.' };
  }, execute: async () => assert.fail('should not execute') });
  assert.equal(inferences, 1); assert.equal(result.toolExecutions, 0);
});

test('large catalogs initially disclose one small search schema and later execute the true discovered MCP tool', async () => {
  const tools = directory();
  tools[4] = tool(4, { source: 'mcp', remoteName: 'weather_forecast', description: '查询全国天气预报和温度',
    inputSchema: { ...structuredClone(schema), allOf: [{ properties: { query: { minLength: 2 } } }] } });
  const snapshots = [], executions = [];
  const result = await runToolConversation({ messages, tools,
    infer: async (conversation, definitions) => {
      snapshots.push({ conversation: structuredClone(conversation), definitions: structuredClone(definitions) });
      if (snapshots.length === 1) {
        assert.deepEqual(definitions.map(item => item.function.name), ['search_available_tools']);
        return response(search('discover', '帮我查一下天气'));
      }
      if (snapshots.length === 2) {
        const actual = definitions.find(item => item.function.name === tools[4].name);
        assert.ok(actual); assert.deepEqual(actual.function.parameters, tools[4].inputSchema);
        const found = JSON.parse(conversation.at(-1).content);
        assert.equal(found.matches[0].name, tools[4].name);
        return response(call('real-call', tools[4].name, { query: '北京' }));
      }
      return { text: 'Forecast retrieved.' };
    },
    execute: async (selected, input) => { executions.push({ selected, input }); return { text: 'actual weather result' }; },
  });
  const allBytes = Buffer.byteLength(JSON.stringify(tools.map(item => ({ type: 'function', function: { name: item.name, description: item.description, parameters: item.inputSchema } }))));
  assert.ok(Buffer.byteLength(JSON.stringify(snapshots[0].definitions)) < allBytes);
  assert.equal(executions.length, 1); assert.equal(executions[0].selected.id, tools[4].id);
  assert.deepEqual(executions[0].input, { query: '北京' });
  assert.equal(result.catalogSearches, 1); assert.equal(result.toolExecutions, 2);
  assert.deepEqual(result.toolNames, [tools[4].id]);
  assert.deepEqual(snapshots.at(-1).conversation.filter(item => item.role === 'system'), [messages[0]], 'discovery text must not become a system instruction');
});

test('natural Chinese aliases discover an English notes tool and honor compact result limits', async () => {
  const tools = directory(); tools[3] = tool(3, { remoteName: 'list_notes', description: 'Read saved notes' });
  let round = 0;
  await runToolConversation({ messages, tools, infer: async (conversation, definitions) => {
    if (++round === 1) return response(search('notes-search', '帮我记一下', 1));
    const found = JSON.parse(conversation.at(-1).content);
    assert.equal(found.matches.length, 1); assert.equal(found.matches[0].id, tools[3].id);
    assert.deepEqual(definitions.map(item => item.function.name), ['search_available_tools', tools[3].name]);
    return { text: 'The relevant notes tool was found.' };
  }, execute: async () => assert.fail('discovery cannot execute tools') });
});

test('tools outside the authorized snapshot never appear in search results or real definitions', async () => {
  const tools = directory(); let round = 0;
  await runToolConversation({ messages, tools, infer: async (conversation, definitions) => {
    if (++round === 1) return response(search('unauthorized-search', 'private_vault_secret_reader'));
    const found = JSON.parse(conversation.at(-1).content);
    assert.deepEqual(found.matches, []); assert.match(found.note, /澄清/);
    assert.deepEqual(definitions.map(item => item.function.name), ['search_available_tools']);
    return { text: 'No matching authorized tool is available.' };
  }, execute: async () => assert.fail('unavailable tools cannot execute') });
});

test('natural references to earlier conversation find an authorized current-group context tool', async () => {
  const tools = directory();
  tools[2] = tool(2, { id: 'qq:current_group_recent', remoteName: 'current_group_recent', description: 'Read the current group received cache' });
  let round = 0;
  await runToolConversation({ messages, tools, infer: async conversation => {
    if (++round === 1) return response(search('recall-current-group', '回忆一下之前聊过的内容', 1));
    assert.equal(JSON.parse(conversation.at(-1).content).matches[0].id, 'qq:current_group_recent');
    return { text: 'Current-group tool found.' };
  }, execute: async () => assert.fail('discovery must not read messages') });
});

test('guessing a real function before discovery fails, including search plus guessed call in one batch', async t => {
  for (const batched of [false, true]) await t.test(String(batched), async () => {
    const tools = directory(); let executions = 0, inferences = 0;
    await assert.rejects(runToolConversation({ messages, tools,
      infer: async () => { inferences++; return response(...(batched ? [search('search-first', 'lookup')] : []), call('guessed', tools[0].name, { query: 'hello' })); },
      execute: async () => { executions++; },
    }), /未授权|不存在/);
    assert.equal(executions, 0); assert.equal(inferences, 1);
  });
});

test('search schema cannot change server settings, grant permissions, or request unlimited results', async t => {
  for (const args of [{ query: 'lookup', serverId: 'other', grants: ['all'] }, { query: 'lookup', limit: 7 }, { query: '   ' }]) await t.test(JSON.stringify(args), async () => {
    let executions = 0;
    await assert.rejects(runToolConversation({ messages, tools: directory(), infer: async () => response(call('invalid-search', 'search_available_tools', args)),
      execute: async () => { executions++; } }));
    assert.equal(executions, 0);
  });
});

test('all search calls consume the original three-call/four-inference budget', async () => {
  const requests = []; let executions = 0;
  const result = await runToolConversation({ messages, tools: directory(), infer: async (_, definitions, options) => {
    requests.push({ definitions, options });
    return requests.length <= 3 ? response(search(`search-${requests.length}`, 'lookup')) : { text: 'Please clarify the request.' };
  }, execute: async () => { executions++; } });
  assert.equal(requests.length, 4); assert.equal(executions, 0);
  assert.deepEqual(requests[3].definitions, []); assert.equal(requests[3].options.toolChoice, 'none');
  assert.equal(result.catalogSearches, 3); assert.equal(result.toolExecutions, 3); assert.deepEqual(result.toolNames, []);
});

test('discovery plus an over-budget real batch is rejected before any external operation', async () => {
  const tools = directory(); let round = 0, executions = 0;
  await assert.rejects(runToolConversation({ messages, tools, infer: async () => ++round === 1 ? response(search('find', 'lookup'))
    : response(call('a', tools[0].name, { query: 'a' }), call('b', tools[0].name, { query: 'b' }), call('c', tools[0].name, { query: 'c' })),
  execute: async () => { executions++; } }), /上限/);
  assert.equal(round, 2); assert.equal(executions, 0);
});

test('discovered definitions obey both six-function and 96 KiB limits without rewriting schemas', async () => {
  const tools = directory().map((entry, index) => ({ ...entry, source: 'mcp', description: 'Large authorized search tool',
    inputSchema: { ...structuredClone(schema), description: String(index) + 'x'.repeat(60 * 1024) } }));
  let round = 0;
  await runToolConversation({ messages, tools, infer: async (conversation, definitions) => {
    if (++round === 1) return response(search('large-schema', 'Large authorized', 6));
    assert.ok(definitions.length <= 6); assert.ok(Buffer.byteLength(JSON.stringify(definitions)) <= 96 * 1024);
    assert.equal(definitions.length, 2, 'at least one large schema still fits alongside the host search definition');
    const found = JSON.parse(conversation.at(-1).content);
    assert.equal(found.matches.length, 1);
    assert.deepEqual(definitions[1].function.parameters, tools[0].inputSchema);
    assert.ok(Buffer.byteLength(conversation.at(-1).content) < 3000, 'search results contain summaries rather than full schemas');
    return { text: 'One schema was loaded.' };
  }, execute: async () => assert.fail('not requested') });
});

test('schema size triggers discovery even for few tools, while owner all mode preserves the original catalog', async () => {
  const tools = directory().slice(0, 2).map(entry => ({ ...entry, inputSchema: { ...structuredClone(schema), description: 'x'.repeat(10 * 1024) } }));
  for (const catalogMode of ['auto', 'all']) await runToolConversation({ messages, tools, catalogMode, infer: async (_, definitions) => {
    assert.deepEqual(definitions.map(item => item.function.name), catalogMode === 'all' ? tools.map(item => item.name) : ['search_available_tools']);
    return { text: 'No call.' };
  }, execute: async () => assert.fail('not requested') });
});

test('cancellation after discovery prevents a late real tool proposal from executing', async () => {
  const tools = directory(), controller = new AbortController(); let round = 0, executions = 0;
  await assert.rejects(runToolConversation({ messages, tools, signal: controller.signal, infer: async () => {
    if (++round === 1) return response(search('find', 'lookup'));
    controller.abort(); return response(call('late', tools[0].name, { query: 'hello' }));
  }, execute: async () => { executions++; } }), /取消/);
  assert.equal(round, 2); assert.equal(executions, 0);
});

test('caller mutations cannot add tools or alter descriptor schemas after the request snapshot is made', async () => {
  const tools = directory(), originalName = tools[0].name, originalId = tools[0].id;
  let round = 0, executions = 0;
  const result = await runToolConversation({ messages, tools, infer: async (_, definitions) => {
    if (++round === 1) {
      tools.push(tool(99, { name: 'new_unapproved_tool', description: 'Authorized lookup 0 private replacement' }));
      tools[0].name = 'mutated_function'; tools[0].description = 'Replaced description';
      tools[0].inputSchema.properties.query.type = 'number';
      return response(search('snapshot-search', 'Authorized lookup 0', 1));
    }
    if (round === 2) {
      assert.deepEqual(definitions.map(item => item.function.name), ['search_available_tools', originalName]);
      assert.equal(definitions[1].function.parameters.properties.query.type, 'string');
      assert.equal(JSON.stringify(definitions).includes('new_unapproved_tool'), false);
      return response(call('snapshot-call', originalName, { query: 'hello' }));
    }
    return { text: 'The original authorized snapshot was used.' };
  }, execute: async (selected, input) => {
    executions++; assert.equal(selected.id, originalId); assert.deepEqual(input, { query: 'hello' }); return { text: 'done' };
  } });
  assert.equal(executions, 1); assert.deepEqual(result.toolNames, [originalId]);
});
