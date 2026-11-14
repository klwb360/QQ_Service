import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createDemoData, createDemoServer } from './demo-server.mjs';

const data = await createDemoData();
const server = createDemoServer({ data });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await server.close().catch(() => {});
  await data.close();
}
server.onclose = () => { void stop(); };
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop().finally(() => process.exit(0)); });
process.stdin.once('end', () => { void stop(); });
process.once('uncaughtException', error => { console.error(`MCP demo failed: ${error.message}`); void stop().finally(() => process.exit(1)); });
await server.connect(new StdioServerTransport());
// stdout belongs exclusively to MCP JSON-RPC. Diagnostics belong on stderr.
console.error('QQ_Service MCP demo ready; notes are temporary and reset on restart.');
