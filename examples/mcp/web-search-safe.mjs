import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { validateToolInput } from '../../src/tool-schema.mjs';
import { createWebContentClient, publicWebError } from '../../src/web-content.mjs';

export const WEB_SEARCH_SAFE_TOOLS = Object.freeze([
  { name: 'web_search', description: '使用已配置的Brave Search官方API或明确配置的公开HTTPS SearXNG搜索网页，返回真实标题、摘要和引用链接。没有搜索配置会明确needsSetup，不能假装已搜索。不会自动打开搜索结果。',
    inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 300 }, count: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['query'], additionalProperties: false } },
  { name: 'web_fetch', description: '只读公开HTTPS网页的服务器HTML文字或纯文本，提供来源URL、截断及覆盖说明。无需搜索API Key；不执行JavaScript，不加载图片、音视频或其他资源，不带Cookie，不访问本机/私网/保留地址，不绕过登录和验证。',
    inputSchema: { type: 'object', properties: { url: { type: 'string', minLength: 1, maxLength: 2048 } }, required: ['url'], additionalProperties: false } },
].map(tool => Object.freeze({ ...tool, annotations: Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }) })));

/** Construction and imports are inert; trusted tests inject all network I/O. */
export function createWebSearchSafeServer({ client = createWebContentClient() } = {}) {
  const server = new Server({ name: 'qq-service-web-search-safe', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: structuredClone(WEB_SEARCH_SAFE_TOOLS) }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    try {
      const tool = WEB_SEARCH_SAFE_TOOLS.find(item => item.name === params.name);
      if (!tool) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'WEB_UNKNOWN_TOOL', error: '此服务只提供web_search和web_fetch只读工具。' }) }] };
      let args;
      try { args = validateToolInput(tool.inputSchema, params.arguments ?? {}); }
      catch { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'WEB_INPUT_REJECTED', error: '参数不符合此只读网页工具的定义；不能提供额外请求头、Cookie或网络设置。' }) }] }; }
      const options = { signal: extra?.signal };
      const result = params.name === 'web_fetch' ? await client.fetchPage(args.url, options) : await client.search(args, options);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify(publicWebError(error)) }] }; }
  });
  return server;
}
export async function startWebSearchSafeMcp() {
  const server = createWebSearchSafeServer(); let stopping = false;
  const stop = async () => { if (!stopping) { stopping = true; await server.close().catch(() => {}); } };
  server.onclose = () => { void stop(); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop().finally(() => process.exit(0)); });
  process.stdin.once('end', () => { void stop(); });
  await server.connect(new StdioServerTransport()); return server;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  startWebSearchSafeMcp().catch(() => { console.error('只读网页MCP启动失败，请检查本机运行环境。'); process.exitCode = 1; });
}
