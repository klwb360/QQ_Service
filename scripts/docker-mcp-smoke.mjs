import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const image = process.argv[2] || 'qq-service:local';
if (!image || image.startsWith('-')) throw new Error('Provide a local image name.');
const suffix = randomUUID().slice(0, 12);
const network = `qq-service-mcp-smoke-${suffix}`;
const fixture = `${network}-server`;
const token = randomUUID();
let networkCreated = false, fixtureCreated = false;
function docker(args, { optional = false } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !optional) throw new Error(`docker ${args[0]} failed: ${(result.stderr || result.stdout).slice(-2000)}`);
  return (args[0] === 'logs' ? result.stdout + result.stderr : result.stdout).trim();
}
const descriptor = { id: 'fixture', label: 'MCP Docker fixture', enabled: true, transport: 'http', url: 'http://mcp-demo:8789/mcp',
  command: '', args: [], envKeys: [], headerKeys: ['authorization'], timeoutSeconds: 10, tools: [] };
const clientCode = `
import assert from 'node:assert/strict';
import {createMcpClient} from './src/mcp-client.mjs';
const descriptor=${JSON.stringify(descriptor)};
const token=process.env.MCP_FIXTURE_TOKEN;
const keys=[];
const client=createMcpClient(descriptor,{getSecret:key=>{keys.push(key);assert.equal(key,'mcpSecret:fixture:header:authorization');return 'Bearer '+token;}});
const body=result=>JSON.parse(result.content.find(item=>item.type==='text').text);
try{
  await client.connect();assert.equal(client.status().connected,true);
  const tools=await client.listTools();assert.deepEqual(tools.map(tool=>tool.name),['calculate','list_notes','add_note']);
  assert.equal(body(await client.callTool('calculate',{operation:'multiply',a:6,b:7})).result,42);
  await client.callTool('add_note',{text:'cross-container fixture note'});
  assert.deepEqual(body(await client.callTool('list_notes',{})).notes.map(note=>note.text),['cross-container fixture note']);
  assert(keys.length>0);
}finally{await client.close();}
const denied=createMcpClient(descriptor,{getSecret:()=> 'Bearer intentionally-wrong-fixture-token'});
try{await assert.rejects(denied.connect());}finally{await denied.close();}
const local=createMcpClient({...descriptor,id:'local',transport:'stdio',url:'',headerKeys:[],command:'node',args:['{appDir}/examples/mcp/local-notes.mjs']},{getSecret:()=>{throw new Error('stdio demo must not request credentials');}});
try{await local.connect();assert.equal((await local.listTools()).length,3);assert.equal(body(await local.callTool('calculate',{operation:'add',a:20,b:22})).result,42);}finally{await local.close();}
const bili=createMcpClient({...descriptor,id:'bili',transport:'stdio',url:'',headerKeys:[],command:'node',args:['{appDir}/examples/mcp/bilibili.mjs']},{getSecret:()=>{throw new Error('public Bilibili catalog must not request credentials');}});
try{
  await bili.connect();const tools=await bili.listTools();
  assert.deepEqual(tools.map(tool=>tool.name).sort(),['popular_videos','search_videos','video_details','list_favorite_folders','list_favorite_items','list_watch_later','list_favorite_articles','read_video_content','read_article_content','queue_library_digest','library_digest_status','cancel_library_digest'].sort());
  assert(tools.every(tool=>tool.annotations?.readOnlyHint===!['queue_library_digest','cancel_library_digest'].includes(tool.name)));
  const standalone=await bili.callTool('queue_library_digest',{sources:{watchLater:true}});
  assert.equal(standalone.isError,true);assert.equal(body(standalone).requiresHost,true);
}finally{await bili.close();}
await import('./src/bilibili-library.mjs');await import('./src/bilibili-digest-tools.mjs');await import('./src/bilibili-digest-sources.mjs');await import('./src/bilibili-digests.mjs');await import('./src/bilibili-digest-service.mjs');
console.log('Docker MCP smoke passed: bundled SDK, stdio Node placeholder, Bilibili library/task catalog and standalone-host refusal, authenticated cross-container HTTP tools, read/write round trip, credential isolation, bad-token refusal.');
`;

try {
  docker(['network', 'create', network]); networkCreated = true;
  docker(['run', '--detach', '--name', fixture, '--network', network, '--network-alias', 'mcp-demo',
    '--init', '--read-only', '--tmpfs', '/tmp:size=64m,mode=1777', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '-e', 'MCP_DEMO_HOST=0.0.0.0', '-e', 'MCP_DEMO_ALLOWED_HOSTS=mcp-demo', '-e', `MCP_DEMO_TOKEN=${token}`,
    image, 'node', 'examples/mcp/http-notes.mjs']); fixtureCreated = true;
  docker(['exec', fixture, 'node', '--input-type=module', '-e',
    "const end=Date.now()+20000;while(true){try{const r=await fetch('http://127.0.0.1:8789/mcp',{signal:AbortSignal.timeout(1000)});if(r.status===401)break;}catch{}if(Date.now()>end)throw new Error('MCP fixture startup timeout');await new Promise(r=>setTimeout(r,200));}"]);
  console.log(docker(['run', '--rm', '--network', network, '--init', '--read-only', '--tmpfs', '/tmp:size=64m,mode=1777',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '-e', 'QQ_SERVICE_MCP_HOSTS=mcp-demo',
    '-e', `MCP_FIXTURE_TOKEN=${token}`, image, 'node', '--input-type=module', '-e', clientCode]));
} catch (error) {
  if (fixtureCreated) { const logs = docker(['logs', '--tail', '30', fixture], { optional: true }); if (logs) console.error(logs); }
  throw error;
} finally {
  if (fixtureCreated) docker(['rm', '--force', fixture], { optional: true });
  if (networkCreated) docker(['network', 'rm', network], { optional: true });
}
