import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMcpToolSchema, compileMcpToolSchema, validateMcpToolInput } from '../src/mcp-schema.mjs';

test('MCP复杂本地定义、组合、可空类型与对象数组完整校验且不修改输入', async () => {
  const schema = { type: 'object', $defs: {
    location: { type: 'object', properties: { city: { type: 'string', minLength: 1 } }, required: ['city'], additionalProperties: false },
  }, properties: {
    target: { $ref: '#/$defs/location' },
    limit: { anyOf: [{ type: 'integer', minimum: 1, maximum: 10 }, { type: 'null' }] },
    mode: { enum: ['short', 'full'] }, tags: { type: 'array', items: { type: 'string', nullable: true }, maxItems: 3 },
    choice: { oneOf: [{ type: 'string' }, { type: 'boolean' }] },
  }, required: ['target', 'limit'], additionalProperties: false };
  const input = { target: { city: '杭州' }, limit: null, mode: 'short', tags: ['天气', null], choice: false };
  const compiled = await compileMcpToolSchema(schema);
  assert.deepEqual(compiled, schema);
  const validated = await validateMcpToolInput(schema, input);
  assert.deepEqual(validated, input);
  assert.notEqual(validated, input);
  await assert.rejects(validateMcpToolInput(schema, { target: { city: '' }, limit: 5 }), error => error.code === 'MCP_INPUT_INVALID');
  await assert.rejects(validateMcpToolInput(schema, { target: { city: '上海' }, limit: '3' }), error => error.code === 'MCP_INPUT_INVALID');
});

test('不强制根声明type，支持根局部引用和布尔子定义', async () => {
  const schema = { $defs: { input: { type: 'object', properties: { allowed: true, denied: false }, additionalProperties: false } }, $ref: '#/$defs/input' };
  assert.deepEqual(await validateMcpToolInput(schema, { allowed: { anything: 'ok' } }), { allowed: { anything: 'ok' } });
  await assert.rejects(validateMcpToolInput(schema, { denied: 'no' }), error => error.code === 'MCP_INPUT_INVALID');
  await assert.rejects(validateMcpToolInput(schema, []), error => error.code === 'MCP_INPUT_INVALID');
  assert.throws(() => validateMcpToolSchema({ type: 'array', items: true }), error => error.code === 'MCP_SCHEMA_INVALID');
});

test('递归本地定义可验证有界嵌套输入，不需要加载外部资源', async () => {
  const schema = { type: 'object', $defs: { node: { type: 'object', properties: {
    label: { type: 'string' }, next: { anyOf: [{ $ref: '#/$defs/node' }, { type: 'null' }] },
  }, required: ['label', 'next'], additionalProperties: false } }, properties: { head: { $ref: '#/$defs/node' } }, required: ['head'] };
  const input = { head: { label: 'first', next: { label: 'second', next: null } } };
  assert.deepEqual(await validateMcpToolInput(schema, input), input);
  await assert.rejects(validateMcpToolInput(schema, { head: { label: 'bad', next: { unexpected: 1 } } }), error => error.code === 'MCP_INPUT_INVALID');
});

test('支持2020-12元定义和未显式声明方言的prefixItems，属性名不会误切换方言', async () => {
  const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: {
    values: { type: 'array', prefixItems: [{ type: 'integer' }, { type: 'string' }], items: false },
  } };
  assert.deepEqual(await validateMcpToolInput(schema, { values: [1, 'x'] }), { values: [1, 'x'] });
  await assert.rejects(validateMcpToolInput(schema, { values: [1, 'x', 3] }), error => error.code === 'MCP_INPUT_INVALID');
  const noDialect = structuredClone(schema); delete noDialect.$schema;
  assert.deepEqual(await validateMcpToolInput(noDialect, { values: [1, 'x'] }), { values: [1, 'x'] });
  const legacyTuple = { type: 'object', properties: { prefixItems: { type: 'string' }, tuple: { type: 'array', items: [{ type: 'integer' }], additionalItems: false } } };
  assert.deepEqual(await validateMcpToolInput(legacyTuple, { prefixItems: 'property name', tuple: [1] }), { prefixItems: 'property name', tuple: [1] });
  assert.deepEqual(await validateMcpToolInput({ ...legacyTuple, $schema: 'https://json-schema.org/draft-07/schema' }, { tuple: [1] }), { tuple: [1] });
  assert.deepEqual(await validateMcpToolInput({ type: 'object', $schema: 'http://json-schema.org/draft/2019-09/schema' }, {}), {});
});

test('外部ref/id/异步扩展禁止加载，enum中的普通字面数据不误识别为Schema', async () => {
  for (const schema of [
    { type: 'object', $ref: 'https://example.com/schema.json' },
    { type: 'object', $id: 'https://example.com/schema.json' },
    { type: 'object', properties: { x: { $dynamicRef: 'file:///secret' } } },
    { type: 'object', $defs: { bad: { $ref: '//example.com/bad' } } },
    { type: 'object', $async: true },
    { type: 'object', $schema: 'https://example.com/custom-dialect' },
  ]) assert.throws(() => validateMcpToolSchema(schema), error => error.code === 'MCP_SCHEMA_INVALID');
  const literal = { type: 'object', properties: { x: { const: { $ref: 'https://example.com/literal' } } } };
  assert.deepEqual(await validateMcpToolInput(literal, { x: { $ref: 'https://example.com/literal' } }), { x: { $ref: 'https://example.com/literal' } });
});

test('同步边界不调用getter，拒绝循环/污染/超量数据，并与异步编译结果区分', async () => {
  let accessed = false;
  const getter = { type: 'object' };
  Object.defineProperty(getter, 'properties', { enumerable: true, get() { accessed = true; throw new Error('should not run'); } });
  assert.throws(() => validateMcpToolSchema(getter), error => error.code === 'MCP_SCHEMA_INVALID');
  assert.equal(accessed, false);
  const cyclic = { type: 'object' }; cyclic.properties = { cyclic };
  for (const definition of [cyclic, { type: 'object', description: 'x'.repeat(65536) }, JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}')]) {
    assert.throws(() => validateMcpToolSchema(definition), error => error.code === 'MCP_SCHEMA_INVALID');
  }
  // Boundary checks deliberately do not claim to compile or understand unknown keywords.
  const unknown = { type: 'object', totallyUnknownValidation: true };
  assert.deepEqual(validateMcpToolSchema(unknown), unknown);
  await assert.rejects(compileMcpToolSchema(unknown), error => error.code === 'MCP_SCHEMA_INVALID' && /totallyUnknownValidation/.test(error.message));
  await assert.rejects(compileMcpToolSchema({ type: 'object', properties: { x: { $ref: '#/$defs/missing' } } }), error => error.code === 'MCP_SCHEMA_INVALID');
});

test('不会注入默认值、移除额外字段或将字符串强制转换成数字；报错不含参数值', async () => {
  const schema = { type: 'object', properties: { value: { type: 'integer', default: 3 } }, additionalProperties: false };
  const empty = {};
  assert.deepEqual(await validateMcpToolInput(schema, empty), {});
  assert.deepEqual(empty, {});
  const secret = 'private-token-value-must-never-appear';
  await assert.rejects(validateMcpToolInput(schema, { value: secret }), error => error.code === 'MCP_INPUT_INVALID' && !error.message.includes(secret));
  await assert.rejects(validateMcpToolInput(schema, { unexpected: secret }), error => error.code === 'MCP_INPUT_INVALID' && !error.message.includes(secret));
});

test('标准format由Ajv-formats验证，不能静默忽略未知format', async () => {
  const schema = { type: 'object', properties: { link: { type: 'string', format: 'uri' } }, required: ['link'] };
  assert.deepEqual(await validateMcpToolInput(schema, { link: 'https://example.com/' }), { link: 'https://example.com/' });
  await assert.rejects(validateMcpToolInput(schema, { link: 'not a uri' }), error => error.code === 'MCP_INPUT_INVALID');
  await assert.rejects(compileMcpToolSchema({ type: 'object', properties: { link: { type: 'string', format: 'unregistered-special-format' } } }), error => error.code === 'MCP_SCHEMA_INVALID');
});

test('已取消和运行中的校验可取消，恶意正则仅在worker内运行并在2秒终止', async () => {
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(compileMcpToolSchema({ type: 'object' }, aborted.signal), error => error.code === 'MCP_SCHEMA_ABORTED');
  const controller = new AbortController();
  const work = validateMcpToolInput({ type: 'object', properties: { value: { type: 'string', pattern: '^(a+)+$' } } }, { value: `${'a'.repeat(64)}!` }, controller.signal);
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(work, error => error.code === 'MCP_SCHEMA_ABORTED');
  let mainThreadResponsive = false;
  const timeout = validateMcpToolInput({ type: 'object', properties: { value: { type: 'string', pattern: '^(a+)+$' } } }, { value: `${'a'.repeat(64)}!` });
  setTimeout(() => { mainThreadResponsive = true; }, 50);
  await assert.rejects(timeout, error => error.code === 'MCP_SCHEMA_TIMEOUT');
  assert.equal(mainThreadResponsive, true);
});
