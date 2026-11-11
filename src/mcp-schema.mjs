import { Worker } from 'node:worker_threads';

const SCHEMA_BYTES = 64 * 1024;
const INPUT_BYTES = 128 * 1024;
const TIMEOUT_MS = 2000;
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);
const dialects = new Set([
  'http://json-schema.org/draft-07/schema', 'https://json-schema.org/draft-07/schema',
  'https://json-schema.org/draft/2019-09/schema', 'http://json-schema.org/draft/2019-09/schema',
  'https://json-schema.org/draft/2020-12/schema', 'http://json-schema.org/draft/2020-12/schema',
]);
const fail = (message, code = 'MCP_SCHEMA_INVALID', statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** Clone bounded JSON without invoking getters or applying a server's regexes.
 * Compilation and all JSON Schema evaluation happen only in a cancellable worker. */
function cloneJson(value, { limit, depth, label, code }) {
  let bytes = 0, nodes = 0;
  const ancestors = new Set();
  const add = n => { if ((bytes += n) > limit) throw fail(`${label}超过 ${limit / 1024} KiB 限制。`, code); };
  const visit = (item, level) => {
    if (level > depth || ++nodes > 12000) throw fail(`${label}嵌套过深或项目过多。`, code);
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) {
      add(Buffer.byteLength(JSON.stringify(item))); return item;
    }
    if (typeof item === 'string') {
      if (item.length > limit) throw fail(`${label}超过大小限制。`, code);
      add(Buffer.byteLength(JSON.stringify(item))); return item;
    }
    if ((!Array.isArray(item) && !plain(item)) || ancestors.has(item)) throw fail(`${label}须为无循环的纯 JSON 数据。`, code);
    if (Object.getOwnPropertySymbols(item).length) throw fail(`${label}不能包含 Symbol 字段。`, code);
    const keys = Object.keys(item);
    if (keys.length > 12000) throw fail(`${label}项目过多。`, code);
    const names = Object.getOwnPropertyNames(item);
    if (names.length !== keys.length + Number(Array.isArray(item))) throw fail(`${label}不能包含隐藏属性。`, code);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    for (const key of keys) {
      if (forbiddenKeys.has(key)) throw fail(`${label}包含不支持的属性名。`, code);
      if (!Object.hasOwn(descriptors[key], 'value')) throw fail(`${label}不能包含动态属性。`, code);
    }
    ancestors.add(item);
    add(2 + Math.max(0, keys.length - 1));
    let result;
    if (Array.isArray(item)) {
      if (keys.length !== item.length || keys.some((key, index) => key !== String(index))) throw fail(`${label}数组格式无效。`, code);
      result = keys.map(key => visit(descriptors[key].value, level + 1));
    } else {
      result = {};
      for (const key of keys) {
        if (key.length > limit) throw fail(`${label}字段名过长。`, code);
        add(Buffer.byteLength(JSON.stringify(key)) + 1);
        result[key] = visit(descriptors[key].value, level + 1);
      }
    }
    ancestors.delete(item);
    return result;
  };
  return visit(value, 0);
}

export function validateMcpToolSchema(schema) {
  const definition = cloneJson(schema, { limit: SCHEMA_BYTES, depth: 48, label: 'MCP 工具参数定义', code: 'MCP_SCHEMA_INVALID' });
  if (!plain(definition) || (definition.type !== undefined && definition.type !== 'object')) throw fail('MCP 工具参数定义的根须为对象类型。');
  const singles = ['additionalProperties', 'unevaluatedProperties', 'propertyNames', 'contains', 'not', 'if', 'then', 'else', 'additionalItems', 'unevaluatedItems', 'contentSchema'];
  const maps = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'];
  const arrays = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
  const visit = node => {
    if (typeof node === 'boolean') return;
    if (!plain(node)) throw fail('MCP 工具参数定义包含无效的子定义。');
    for (const key of ['$ref', '$recursiveRef', '$dynamicRef']) {
      if (node[key] !== undefined && (typeof node[key] !== 'string' || !node[key].startsWith('#'))) throw fail('MCP 工具定义仅支持本地 # 引用，不能加载外部定义。');
    }
    if (node.$id !== undefined && (typeof node.$id !== 'string' || (node.$id !== '' && !node.$id.startsWith('#')))) throw fail('MCP 工具定义不能声明外部 $id。');
    if (node.$schema !== undefined && (typeof node.$schema !== 'string' || !dialects.has(node.$schema.replace(/#$/, '')))) throw fail('MCP 工具定义使用了不支持的 JSON Schema 版本。');
    if (Object.hasOwn(node, '$async') || Object.hasOwn(node, '$data')) throw fail('MCP 工具定义不支持异步或动态数据扩展。');
    for (const key of singles) if (node[key] !== undefined) visit(node[key]);
    if (node.items !== undefined) {
      if (Array.isArray(node.items)) node.items.forEach(visit); else visit(node.items);
    }
    for (const key of maps) if (node[key] !== undefined) {
      if (!plain(node[key])) throw fail(`MCP 工具定义的 ${key} 须为对象。`);
      Object.values(node[key]).forEach(visit);
    }
    for (const key of arrays) if (node[key] !== undefined) {
      if (!Array.isArray(node[key])) throw fail(`MCP 工具定义的 ${key} 须为数组。`);
      node[key].forEach(visit);
    }
    if (node.dependencies !== undefined) {
      if (!plain(node.dependencies)) throw fail('MCP 工具定义的 dependencies 须为对象。');
      for (const dependency of Object.values(node.dependencies)) if (!Array.isArray(dependency)) visit(dependency);
    }
  };
  visit(definition);
  return definition;
}

function isolatedCheck(schema, input, signal, compileOnly) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(fail('MCP 参数校验已取消。', 'MCP_SCHEMA_ABORTED', 409)); return; }
    let worker, timer, settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (worker) { worker.removeAllListeners(); worker.on('error', () => {}); worker.terminate().catch(() => {}); }
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(fail('MCP 参数校验已取消。', 'MCP_SCHEMA_ABORTED', 409));
    try {
      worker = new Worker(new URL('./mcp-schema-worker.mjs', import.meta.url), {
        workerData: { schema, ...(compileOnly ? {} : { input }), compileOnly },
        resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 4, stackSizeMb: 2 },
        execArgv: [],
      });
      timer = setTimeout(() => finish(fail('MCP 参数定义编译或校验超时，该工具暂不可用。', 'MCP_SCHEMA_TIMEOUT', 408)), TIMEOUT_MS);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      worker.once('message', message => {
        if (message?.ok === true) finish(null, compileOnly ? schema : input);
        else finish(fail(typeof message?.message === 'string' ? message.message.slice(0, 400) : 'MCP 参数校验失败。',
          message?.code === 'MCP_INPUT_INVALID' ? 'MCP_INPUT_INVALID' : 'MCP_SCHEMA_INVALID'));
      });
      worker.once('error', () => finish(fail('MCP 参数校验工作线程失败或超出内存限制。', 'MCP_SCHEMA_WORKER_FAILED', 502)));
      worker.once('exit', () => finish(fail('MCP 参数校验工作线程提前退出。', 'MCP_SCHEMA_WORKER_FAILED', 502)));
    } catch { finish(fail('无法启动 MCP 参数校验工作线程。', 'MCP_SCHEMA_WORKER_FAILED', 502)); }
  });
}

export async function compileMcpToolSchema(schema, signal) {
  const definition = validateMcpToolSchema(schema);
  return isolatedCheck(definition, undefined, signal, true);
}

export async function validateMcpToolInput(schema, input, signal) {
  const definition = validateMcpToolSchema(schema);
  const value = cloneJson(input, { limit: INPUT_BYTES, depth: 32, label: 'MCP 工具参数', code: 'MCP_INPUT_INVALID' });
  if (!plain(value)) throw fail('MCP 工具参数须为 JSON 对象。', 'MCP_INPUT_INVALID');
  return isolatedCheck(definition, value, signal, false);
}
