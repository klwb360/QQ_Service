const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const modules = Object.freeze([
  'account-service', 'accounts', 'asset-vision', 'bilibili-digest-service', 'bilibili-digest-sources',
  'bilibili-digest-tools', 'bilibili-digests', 'bilibili-library', 'config', 'conversation-state',
  'experience-store', 'group-events', 'installer', 'mcp-client', 'mcp-config', 'mcp-manager',
  'mcp-presets', 'mcp-schema', 'mcp-schema-worker', 'memory-storage', 'memory-store', 'napcat-native',
  'napcat-settings', 'network-policy', 'onebot-connector', 'persona', 'plugin-worker', 'plugins',
  'providers', 'qq-action-log', 'qq-assets', 'qq-mcp-server', 'qq-media-delivery', 'qq-message-origin', 'qq-sticker-sync',
  'qq-tools', 'runtime', 'server', 'social-chat', 'social-runtime', 'store', 'tool-router', 'tool-schema', 'web-content',
]);
const uiScripts = Object.freeze(['app.js', 'memory-ui.js', 'memory-storage-ui.js', 'qq-assets-ui.js', 'mcp-presets-ui.js']);
const requiredBackendResources = Object.freeze([
  'package.json', 'production-packages.json', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md',
  ...modules.map(name => `src/${name}.mjs`),
  'public/index.html', 'public/styles.css', ...uiScripts.map(name => `public/${name}`),
  ...['bilibili', 'demo-server', 'http-notes', 'local-notes', 'web-search-safe'].map(name => `examples/mcp/${name}.mjs`),
  'examples/plugins/bilibili-assistant/index.mjs', 'examples/plugins/bilibili-assistant/http.mjs',
  'examples/plugins/bilibili-assistant/plugin.json',
  ...['MCP', 'MCP_PRESETS', 'QQ_ASSETS', 'TOOL_ROADMAP', 'USAGE', 'NATIVE_NAPCAT_WINDOWS', 'PERSONA_MEMORY', 'SOCIAL_CHAT', 'PLUGIN_DEVELOPMENT', 'SNOWLUMA_SECURITY_REVIEW', 'SNOWLUMA_BUILD'].map(name => `docs/${name}.md`),
  'docs/assets/mcp-services.png',
]);

/** The same presence/import checks run before staging is promoted and after
 * electron-builder copies resources. No QQ login, website or paid API is used. */
async function verifyBackendResources(directory) {
  const backend = path.resolve(directory);
  for (const relative of requiredBackendResources) {
    const info = await fs.lstat(path.join(backend, ...relative.split('/'))).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    assert(info?.isFile() && !info.isSymbolicLink(), `Required backend resource is missing or linked: ${relative}`);
  }
  const privateFile = /(?:^|\/)(?:auth\.json|config(?:\.(?:v\d+|pre-api-only)\.backup)?\.json|secrets\.json|vault\.(?:json|key)|accounts\.json|module-state\.json|napcat-settings\.json|memory-storage-(?:settings|owner)\.json|qq-actions\.json|ui-design\.json|\.env(?:\.[^/]*)?|[^/]+\.sqlite(?:-wal|-shm)?|qq-assets|codex-home|accounts|data)(?:\/|$)/iu;
  async function scan(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      // Locked third-party packages may contain fixtures named data/config.json.
      if (current === backend && entry.name === 'node_modules') continue;
      const file = path.join(current, entry.name);
      const relative = path.relative(backend, file).split(path.sep).join('/');
      assert(!privateFile.test(relative), `Backend includes private account data: ${relative}`);
      assert(!entry.isSymbolicLink(), `Backend application resource is linked: ${relative}`);
      if (entry.isDirectory()) await scan(file);
    }
  }
  await scan(backend);
  const index = await fs.readFile(path.join(backend, 'public', 'index.html'), 'utf8');
  const referenced = [...index.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)=["'](\/[^"']+)["']/giu)].map(match => match[1]);
  for (const reference of referenced) {
    assert(/^\/[A-Za-z0-9_.-]+\.(?:js|css)$/u.test(reference), `Unexpected local UI resource: ${reference}`);
    const info = await fs.lstat(path.join(backend, 'public', reference.slice(1))).catch(() => null);
    assert(info?.isFile() && !info.isSymbolicLink(), `UI references an unavailable packaged resource: ${reference}`);
  }
  for (const file of uiScripts) assert(referenced.includes(`/${file}`), `Packaged UI does not load required script ${file}`);
  for (const file of uiScripts) await run(process.execPath, ['--check', path.join(backend, 'public', file)], { timeout: 15_000, windowsHide: true });
  const loadable = modules.filter(name => !['mcp-schema-worker', 'plugin-worker'].includes(name));
  const runtimeProbe = [
    "import assert from 'node:assert/strict'",
    `for(const name of ${JSON.stringify(loadable)})await import('./src/'+name+'.mjs')`,
    "await import('@modelcontextprotocol/sdk/server/stdio.js');await import('@modelcontextprotocol/sdk/server/streamableHttp.js')",
    "await import('ajv');await import('ajv-formats')",
    "const {listBuiltinQQTools}=await import('./src/qq-tools.mjs')",
    "const qq=listBuiltinQQTools();const qqIds=qq.map(tool=>tool.id)",
    "const {createQqMessageOrigin,qqMessageReference,parseQqMessageReference}=await import('./src/qq-message-origin.mjs');const messageOrigin=createQqMessageOrigin('snowluma');const reference=qqMessageReference({origin:messageOrigin,nativeMessageId:'123'});assert.equal(parseQqMessageReference(reference).nativeMessageId,'123')",
    "const {connectorCatalog}=await import('./src/onebot-connector.mjs');const snow=connectorCatalog().find(item=>item.id==='snowluma');assert(snow.available&&snow.externalRuntime&&!snow.runtimeManaged);assert.equal(snow.review.verified,false)",
    "for(const id of ['qq:list_assets','qq:send_image','qq:send_file','qq:forward_messages','qq:recall_own_message','qq:group_notices','qq:group_files','qq:send_sticker','qq:describe_asset'])assert(qqIds.includes(id),'Missing packaged QQ tool '+id)",
    "const {bilibiliMcpTools}=await import('./examples/mcp/bilibili.mjs')",
    "const bili=bilibiliMcpTools();const biliNames=['popular_videos','search_videos','video_details','list_favorite_folders','list_favorite_items','list_watch_later','list_favorite_articles','read_video_content','read_article_content','queue_library_digest','library_digest_status','cancel_library_digest']",
    "assert.deepEqual(bili.map(tool=>tool.name),biliNames);assert(bili.every(tool=>tool.annotations?.readOnlyHint===!['queue_library_digest','cancel_library_digest'].includes(tool.name)))",
    "const {listMcpPresets,prepareMcpPreset}=await import('./src/mcp-presets.mjs')",
    "const presets=listMcpPresets();for(const id of ['builtin-web-search','builtin-bilibili','builtin-notes','telegram-personal','wechat-windows','discord-bot','slack-official','playwright-browser'])assert(presets.some(preset=>preset.id===id),'Missing MCP preset '+id)",
    "for(const id of ['builtin-web-search','builtin-bilibili','builtin-notes']){const preset=prepareMcpPreset(id);assert.equal(preset.enabled,false);assert.deepEqual(preset.tools,[])}",
    "assert.equal(presets.find(preset=>preset.id==='slack-official').canPrepare,false)",
    "const {createWebSearchSafeServer,WEB_SEARCH_SAFE_TOOLS}=await import('./examples/mcp/web-search-safe.mjs')",
    "assert.deepEqual(WEB_SEARCH_SAFE_TOOLS.map(tool=>tool.name),['web_search','web_fetch']);assert(WEB_SEARCH_SAFE_TOOLS.every(tool=>tool.annotations.readOnlyHint===true))",
    "const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');const {InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js')",
    "const web=createWebSearchSafeServer({client:{search:async()=>({results:[],fixture:true}),fetchPage:async()=>({text:'local fixture',fixture:true})}})",
    "const client=new Client({name:'qq-service-packaging-probe',version:'1.0.0'});const [ct,st]=InMemoryTransport.createLinkedPair()",
    "try{await web.connect(st);await client.connect(ct);assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name),['web_search','web_fetch']);const called=await client.callTool({name:'web_fetch',arguments:{url:'https://fixture.invalid/'}});assert.equal(JSON.parse(called.content[0].text).fixture,true)}finally{await client.close();await web.close()}",
    "const {compileMcpToolSchema,validateMcpToolInput}=await import('./src/mcp-schema.mjs')",
    "const schema={type:'object',properties:{count:{type:'integer'}},required:['count'],additionalProperties:false};await compileMcpToolSchema(schema);await validateMcpToolInput(schema,{count:1})",
    "console.log(JSON.stringify({sourceModules:" + loadable.length + ",uiScripts:" + uiScripts.length + ",qqTools:qq.length,bilibiliTools:bili.length,webTools:WEB_SEARCH_SAFE_TOOLS.length,mcpPresets:presets.length}))",
  ].join(';');
  const probe = await run(process.execPath, ['--input-type=module', '-e', runtimeProbe], {
    cwd: backend, timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024,
  });
  assert(probe.stdout.trim(), `Backend runtime probe returned no summary: ${probe.stderr.trim() || 'empty output'}`);
  return { requiredFiles: requiredBackendResources.length, ...JSON.parse(probe.stdout.trim()) };
}

module.exports = { requiredBackendResources, verifyBackendResources };
