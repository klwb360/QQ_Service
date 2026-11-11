import { parentPort, workerData } from 'node:worker_threads';

// Only data validation runs here. No external schema loader, custom executable
// keyword, coercion, inserted default or removal of caller data is registered.
const send = value => parentPort.postMessage(value);
const schemaFailure = error => {
  const detail = String(error?.message || '');
  const unknown = /unknown keyword:\s*"([A-Za-z0-9_$-]{1,60})"/.exec(detail)?.[1];
  const reason = unknown ? `不支持关键字 ${unknown}` : /unknown format/i.test(detail) ? '不支持该 format'
    : /resolve reference|MissingRef/i.test(detail) ? '本地引用无法解析'
      : /regular expression|Invalid.*pattern/i.test(detail) ? '正则表达式无效' : '定义无效或不受支持';
  send({ ok: false, code: 'MCP_SCHEMA_INVALID', message: `MCP 工具参数定义无法编译：${reason}。` });
};
const usesModernKeyword = schema => {
  const pending = [schema];
  const modern = new Set(['prefixItems', 'unevaluatedProperties', 'unevaluatedItems', 'dependentSchemas', 'dependentRequired', '$dynamicRef', '$dynamicAnchor']);
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    if (Object.keys(node).some(key => modern.has(key))) return true;
    for (const key of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']) {
      if (node[key] && typeof node[key] === 'object' && !Array.isArray(node[key])) pending.push(...Object.values(node[key]));
    }
    for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) if (Array.isArray(node[key])) pending.push(...node[key]);
    for (const key of ['additionalProperties', 'unevaluatedProperties', 'propertyNames', 'contains', 'not', 'if', 'then', 'else', 'additionalItems', 'unevaluatedItems', 'contentSchema', 'items']) {
      if (Array.isArray(node[key])) pending.push(...node[key]); else if (node[key] && typeof node[key] === 'object') pending.push(node[key]);
    }
    if (node.dependencies && typeof node.dependencies === 'object') pending.push(...Object.values(node.dependencies).filter(value => !Array.isArray(value)));
  }
  return false;
};
try {
  const schema = workerData.schema;
  const dialect = String(schema.$schema || '');
  // Official HTTP/HTTPS aliases select the same bundled meta-schema. This is
  // worker-local metadata normalization, never a remote schema download.
  if (dialect.includes('draft-07')) schema.$schema = 'http://json-schema.org/draft-07/schema#';
  else if (dialect.includes('2019-09')) schema.$schema = 'https://json-schema.org/draft/2019-09/schema';
  else if (dialect.includes('2020-12')) schema.$schema = 'https://json-schema.org/draft/2020-12/schema';
  const modern = dialect.includes('2020-12') || (!dialect && usesModernKeyword(schema));
  const { default: Ajv } = await import(dialect.includes('2019-09') ? 'ajv/dist/2019.js' : modern ? 'ajv/dist/2020.js' : 'ajv');
  const ajv = new Ajv({ strictSchema: true, strictTypes: false, strictTuples: false, strictRequired: false,
    strictNumbers: true, allowUnionTypes: true, allErrors: false, validateFormats: true,
    coerceTypes: false, useDefaults: false, removeAdditional: false, ownProperties: true,
    inlineRefs: false, code: { optimize: false }, messages: false, logger: false });
  // ajv-formats is a production dependency. Keep an explicit unsupported error
  // if a damaged installation omits it rather than silently ignoring formats.
  try {
    const { default: addFormats } = await import('ajv-formats');
    addFormats(ajv);
  } catch {}
  const validate = ajv.compile(schema);
  if (workerData.compileOnly) send({ ok: true });
  else {
    const valid = validate(workerData.input);
    if (valid === true) send({ ok: true });
    else {
      const keywords = [...new Set((validate.errors || []).slice(0, 3).map(error => error.keyword))]
        .filter(keyword => /^[A-Za-z0-9_$-]{1,60}$/.test(keyword));
      send({ ok: false, code: 'MCP_INPUT_INVALID', message: `MCP 工具参数不符合定义${keywords.length ? `（${keywords.join('、')}）` : ''}。` });
    }
  }
} catch (error) { schemaFailure(error); }
