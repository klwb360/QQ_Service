import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createDemoData, createDemoServer } from './demo-server.mjs';

const host = process.env.MCP_DEMO_HOST || '127.0.0.1';
const port = Number(process.env.MCP_DEMO_PORT || 8789);
const token = process.env.MCP_DEMO_TOKEN || '';
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('MCP_DEMO_PORT must be a valid port.');
if (!['127.0.0.1', 'localhost', '0.0.0.0'].includes(host)) throw new Error('MCP_DEMO_HOST must be loopback or explicitly 0.0.0.0 for an isolated container.');
if (host === '0.0.0.0' && token.length < 16) throw new Error('A token of at least 16 characters is required for a non-loopback demo.');
if (/[\r\n]/.test(token)) throw new Error('MCP_DEMO_TOKEN contains invalid characters.');
const allowedHosts = new Set(['127.0.0.1', 'localhost', ...(process.env.MCP_DEMO_ALLOWED_HOSTS || '').split(',').map(value => value.trim()).filter(Boolean)]);
for (const value of allowedHosts) if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(value)) throw new Error('MCP_DEMO_ALLOWED_HOSTS must contain explicit hostnames.');
const data = await createDemoData();
const active = new Set();
const json = (res, status, message) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: message })); };
const listener = http.createServer(async (req, res) => {
  try {
    const requestHost = new URL(`http://${req.headers.host || ''}`);
    if (!allowedHosts.has(requestHost.hostname) || Number(requestHost.port || 80) !== port || req.headers.origin) return json(res, 403, 'Untrusted Host or Origin.');
    if (req.url !== '/mcp') return json(res, 404, 'Use /mcp.');
    if (token) {
      const expected = Buffer.from(`Bearer ${token}`);
      const supplied = Buffer.from(req.headers.authorization || '');
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return json(res, 401, 'Authentication required.');
    }
    if (req.method !== 'POST') return json(res, 405, 'This stateless demo accepts POST only.');
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 64 * 1024) return json(res, 413, 'Request too large.');
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return json(res, 400, 'Invalid JSON.'); }
    const server = createDemoServer({ data });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    active.add(server);
    res.once('close', () => { active.delete(server); void server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    console.error(`MCP HTTP demo request failed: ${error.message}`);
    if (!res.headersSent) json(res, 500, 'Demo request failed.'); else res.end();
  }
});
await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(port, host, resolve); });
console.error(`QQ_Service MCP HTTP demo ready on ${host}:${port}/mcp; notes reset on restart.`);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const closed = new Promise(resolve => listener.close(resolve));
  listener.closeAllConnections();
  await Promise.allSettled([...active].map(server => server.close()));
  await closed;
  await data.close();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop().finally(() => process.exit(0)); });
