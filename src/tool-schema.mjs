// A deliberately small, deterministic JSON Schema subset for AI tool inputs.
// It describes data only: no references, expressions, regexes or custom code.
const MAX_BYTES = 16 * 1024;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean']);
const fail = message => Object.assign(new Error(message), { statusCode: 400 });
const plain = value => value !== null && typeof value === 'object'
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value, key) => Object.hasOwn(value, key);

function boundedClone(value, maxDepth, label) {
  let bytes = 0, nodes = 0;
  const ancestors = new Set();
  const add = count => { bytes += count; if (bytes > MAX_BYTES) throw fail(`${label}最多 16 KiB。`); };
  const visit = (item, depth) => {
    if (depth > maxDepth || ++nodes > 6000) throw fail(`${label}嵌套过深或项目过多。`);
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) {
      add(Buffer.byteLength(JSON.stringify(item))); return item;
    }
    if (typeof item === 'string') {
      if (item.length > MAX_BYTES) throw fail(`${label}最多 16 KiB。`);
      add(Buffer.byteLength(JSON.stringify(item))); return item;
    }
    if ((!Array.isArray(item) && !plain(item)) || ancestors.has(item)) throw fail(`${label}必须为无循环的纯 JSON 数据。`);
    if (Object.getOwnPropertySymbols(item).length) throw fail(`${label}不能包含 Symbol 字段。`);
    ancestors.add(item);
    const keys = Object.keys(item);
    if (keys.length > 6000) throw fail(`${label}项目过多。`);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    for (const key of keys) {
      if (FORBIDDEN_KEYS.has(key)) throw fail(`${label}不能包含 ${key} 字段。`);
      if (!own(descriptors[key], 'value')) throw fail(`${label}不能包含动态属性。`);
    }
    let result;
    if (Array.isArray(item)) {
      // Sparse arrays and non-index properties have ambiguous JSON semantics.
      if (keys.length !== item.length || keys.some((key, index) => key !== String(index))) throw fail(`${label}数组格式无效。`);
      add(2 + Math.max(0, item.length - 1));
      result = item.map(entry => visit(entry, depth + 1));
    } else {
      add(2 + Math.max(0, keys.length - 1));
      result = {};
      for (const key of keys) {
        if (key.length > MAX_BYTES) throw fail(`${label}字段名过长。`);
        add(Buffer.byteLength(JSON.stringify(key)) + 1);
        result[key] = visit(descriptors[key].value, depth + 1);
      }
    }
    ancestors.delete(item);
    return result;
  };
  return visit(value, 0);
}

function assertKeys(value, allowed, path) {
  if (!plain(value)) throw fail(`${path}必须为对象。`);
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown) throw fail(`${path}不支持关键字 ${unknown}。`);
}

function countBound(value, fallback, max, path) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw fail(`${path}须为 0–${max} 的整数。`);
  return value;
}

function scalarMatches(schema, value) {
  if (schema.type === 'string') {
    if (typeof value !== 'string') return false;
    // JSON Schema counts Unicode code points, including astral characters.
    const length = Array.from(value).length;
    return length >= schema.minLength && length <= schema.maxLength;
  }
  if (schema.type === 'boolean') return typeof value === 'boolean';
  return typeof value === 'number' && Number.isFinite(value)
    && (schema.type !== 'integer' || Number.isInteger(value))
    && (schema.minimum === undefined || value >= schema.minimum)
    && (schema.maximum === undefined || value <= schema.maximum);
}

export function validateToolSchema(schema) {
  const input = boundedClone(schema, 24, '工具参数定义');
  let nodes = 0;
  const visit = (node, depth, path) => {
    if (depth > 6 || ++nodes > 100) throw fail('工具参数定义最多 6 层、100 个类型节点。');
    if (!plain(node) || !TYPES.has(node.type)) throw fail(`${path}须声明支持的 type。`);
    const common = ['type', 'description'];
    let result = { type: node.type };
    if (node.description !== undefined) {
      if (typeof node.description !== 'string' || node.description.length > 1000) throw fail(`${path}.description 最多 1000 字符。`);
      result.description = node.description;
    }
    if (node.type === 'object') {
      assertKeys(node, [...common, 'properties', 'required', 'additionalProperties'], path);
      if (node.additionalProperties !== undefined && node.additionalProperties !== false) throw fail(`${path}.additionalProperties 只能为 false。`);
      const properties = node.properties === undefined ? {} : node.properties;
      if (!plain(properties) || Object.keys(properties).length > 30) throw fail(`${path}.properties 须为最多 30 项的对象。`);
      const required = node.required === undefined ? [] : node.required;
      if (!Array.isArray(required) || required.length > 30
        || required.some(key => typeof key !== 'string' || !own(properties, key))
        || new Set(required).size !== required.length) throw fail(`${path}.required 须为不重复的已定义属性名。`);
      result.properties = {};
      for (const key of Object.keys(properties).sort()) {
        if (!key || key.length > 100) throw fail(`${path}的参数名须为 1–100 字符。`);
        result.properties[key] = visit(properties[key], depth + 1, `${path}.${key}`);
      }
      result.required = [...required].sort();
      result.additionalProperties = false;
    } else if (node.type === 'array') {
      assertKeys(node, [...common, 'items', 'minItems', 'maxItems'], path);
      result.items = visit(node.items, depth + 1, `${path}.items`);
      result.minItems = countBound(node.minItems, 0, 100, `${path}.minItems`);
      result.maxItems = countBound(node.maxItems, 100, 100, `${path}.maxItems`);
      if (result.minItems > result.maxItems) throw fail(`${path}的 minItems 不能大于 maxItems。`);
    } else {
      const constraints = node.type === 'string' ? ['minLength', 'maxLength'] : node.type === 'boolean' ? [] : ['minimum', 'maximum'];
      assertKeys(node, [...common, ...constraints, 'enum'], path);
      if (node.type === 'string') {
        result.minLength = countBound(node.minLength, 0, 6000, `${path}.minLength`);
        result.maxLength = countBound(node.maxLength, 6000, 6000, `${path}.maxLength`);
        if (result.minLength > result.maxLength) throw fail(`${path}的 minLength 不能大于 maxLength。`);
      } else if (node.type !== 'boolean') {
        for (const bound of ['minimum', 'maximum']) if (node[bound] !== undefined) {
          if (typeof node[bound] !== 'number' || !Number.isFinite(node[bound])) throw fail(`${path}.${bound} 须为有限数值。`);
          result[bound] = node[bound];
        }
        if (result.minimum !== undefined && result.maximum !== undefined && result.minimum > result.maximum) throw fail(`${path}的 minimum 不能大于 maximum。`);
      }
      if (node.enum !== undefined) {
        if (!Array.isArray(node.enum) || !node.enum.length || node.enum.length > 100
          || node.enum.some(value => !scalarMatches(result, value))
          || new Set(node.enum).size !== node.enum.length) throw fail(`${path}.enum 须为 1–100 个不重复且符合类型和范围的标量值。`);
        result.enum = [...node.enum];
      }
    }
    return result;
  };
  if (!plain(input) || input.type !== 'object') throw fail('工具参数定义的根类型须为 object。');
  const canonical = visit(input, 0, 'inputSchema');
  // Defaults add explicit bounds; keep the canonical definition bounded too.
  return boundedClone(canonical, 24, '工具参数定义');
}

export function validateToolInput(schema, input) {
  const definition = validateToolSchema(schema);
  const value = boundedClone(input, 8, '工具参数');
  const visit = (node, item, path) => {
    if (node.type === 'object') {
      if (!plain(item)) throw fail(`${path}须为对象。`);
      for (const key of Object.keys(item)) {
        if (!own(node.properties, key)) throw fail(`${path}包含未定义参数 ${key}。`);
        visit(node.properties[key], item[key], `${path}.${key}`);
      }
      for (const key of node.required) if (!own(item, key)) throw fail(`${path}缺少必填参数 ${key}。`);
    } else if (node.type === 'array') {
      if (!Array.isArray(item) || item.length < node.minItems || item.length > node.maxItems) throw fail(`${path}的数组长度无效。`);
      item.forEach((entry, index) => visit(node.items, entry, `${path}[${index}]`));
    } else if (!scalarMatches(node, item) || (node.enum && !node.enum.includes(item))) throw fail(`${path}的类型、范围或枚举值无效。`);
  };
  visit(definition, value, 'arguments');
  return value;
}
