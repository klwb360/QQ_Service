import { mkdtemp, readFile, writeFile, rename, lstat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const objectSchema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const DEMO_TOOLS = [
  { name: 'calculate', description: '演示：对两个有限数值执行加减乘除，不执行表达式或代码。',
    inputSchema: objectSchema({ operation: { type: 'string', enum: ['add', 'subtract', 'multiply', 'divide'] }, a: { type: 'number' }, b: { type: 'number' } }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: 'list_notes', description: '演示：列出本次服务会话内的临时笔记，不读取用户真实笔记。',
    inputSchema: objectSchema({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: 'add_note', description: '写入演示：将一条笔记添加到本次服务会话的隔离临时目录；重启后重置。',
    inputSchema: objectSchema({ text: { type: 'string', minLength: 1, maxLength: 1000 } }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
];

function argumentsOnly(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error('参数字段无效。');
  }
  return value;
}

/** Each process uses a private disposable directory; tools accept no path. */
export async function createDemoData() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qq-service-mcp-demo-'));
  const file = path.join(directory, 'notes.json');
  await writeFile(file, '[]\n', { mode: 0o600, flag: 'wx' });
  let queue = Promise.resolve();
  let closed = false;
  const read = async () => {
    if (closed) throw new Error('演示会话已结束。');
    const information = await lstat(file);
    if (!information.isFile() || information.isSymbolicLink() || information.size > 512 * 1024) throw new Error('演示笔记文件无效。');
    const notes = JSON.parse(await readFile(file, 'utf8'));
    if (!Array.isArray(notes) || notes.length > 100) throw new Error('演示笔记格式无效。');
    return notes;
  };
  return {
    directory,
    async list() { await queue; return read(); },
    async add(text) {
      if (typeof text !== 'string' || !text.trim() || text.length > 1000 || text.includes('\0')) throw new Error('笔记须为1–1000字符的非空文本。');
      const operation = queue.then(async () => {
        const notes = await read();
        if (notes.length >= 100) throw new Error('演示最多保存100条笔记，请重启示例重置。');
        const note = { id: randomUUID(), text: text.trim(), createdAt: new Date().toISOString() };
        notes.push(note);
        const temporary = path.join(directory, `${randomUUID()}.tmp`);
        try { await writeFile(temporary, JSON.stringify(notes) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temporary, file); }
        finally { await rm(temporary, { force: true }); }
        return note;
      });
      queue = operation.catch(() => {});
      return operation;
    },
    async close() { await queue; closed = true; await rm(directory, { recursive: true, force: true }); },
  };
}

export function createDemoServer({ data }) {
  const server = new Server({ name: 'qq-service-local-notes', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: structuredClone(DEMO_TOOLS) }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      let value;
      const args = params.arguments || {};
      if (params.name === 'calculate') {
        argumentsOnly(args, ['operation', 'a', 'b']);
        if (!Number.isFinite(args.a) || !Number.isFinite(args.b)) throw new Error('只支持有限数值。');
        const operations = { add: () => args.a + args.b, subtract: () => args.a - args.b, multiply: () => args.a * args.b, divide: () => args.a / args.b };
        if (!Object.hasOwn(operations, args.operation)) throw new Error('不支持的计算操作。');
        if (args.operation === 'divide' && args.b === 0) throw new Error('除数不能为0。');
        const result = operations[args.operation]();
        if (!Number.isFinite(result)) throw new Error('计算结果超出有限数值范围。');
        value = { result };
      } else if (params.name === 'list_notes') {
        argumentsOnly(args, []);
        value = { notes: await data.list(), temporary: true };
      } else if (params.name === 'add_note') {
        argumentsOnly(args, ['text']);
        value = { note: await data.add(args.text), temporary: true };
      } else throw new Error('未知的演示工具。');
      return { content: [{ type: 'text', text: JSON.stringify(value) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });
  return server;
}
