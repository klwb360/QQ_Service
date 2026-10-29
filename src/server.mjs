import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createAccountCatalog, PLATFORMS } from './accounts.mjs';
import { createAccountService } from './account-service.mjs';
import { createNapcatSettings } from './napcat-settings.mjs';
import { createPluginManager } from './plugins.mjs';

const projectDir = fileURLToPath(new URL('../', import.meta.url));
const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
export function defaultDataDir() {
  return process.env.QQ_DASHBOARD_DATA_DIR || (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'QQBridgeDashboard')
    : path.join(os.homedir(), '.local', 'share', 'qq-bridge-dashboard'));
}

export function createDashboard({ dataDir = defaultDataDir(), installerFactory, runtimeFactory } = {}) {
  const csrfToken = randomBytes(32).toString('hex');
  const catalog = createAccountCatalog(dataDir);
  const plugins = createPluginManager({ dataDir });
  const napcatSettings = createNapcatSettings({ dataDir, accountDirectories: catalog.list().map(account => catalog.directory(account.id)) });
  const services = new Map();
  const reservations = new Map();
  let started = false, closing = false;
  let pluginMutation = false;
  const ensurePluginReady = () => { if (pluginMutation) throw fail('插件正在安装或卸载，请稍后修改账号配置。'); };
  const redactAll = value => {
    let text = String(value ?? '');
    for (const service of services.values()) for (const secret of Object.values(service.store.getSecretSnapshot())) if (secret) text = text.split(secret).join('[已隐藏]');
    return text;
  };
  const safeErrorValue = value => typeof value === 'string' ? redactAll(value) : Array.isArray(value) ? value.map(safeErrorValue) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeErrorValue(item)])) : value;
  const checkConflicts = (config, id) => {
    if (!config.qq.enabled) return;
    const port = url => { const parsed = new URL(url); return Number(parsed.port || 80); };
    const ports = [port(config.qq.wsUrl), port(config.qq.webUiUrl)];
    if (ports[0] === ports[1]) throw fail('同一账号的 OneBot 和 WebUI 端口不能相同。');
    for (const [otherId, service] of services) {
      if (id === otherId) continue;
      for (const other of [service.store.getConfig(), ...(reservations.get(otherId) || [])]) {
        if (!other.qq.enabled) continue;
        if (config.botQQ && config.botQQ === other.botQQ) throw fail('这个 QQ 号已在另一个账号配置中启用或正在变更；请先停用原配置。');
        if ([port(other.qq.wsUrl), port(other.qq.webUiUrl)].some(value => ports.includes(value))) throw fail('该 OneBot 或 WebUI 端口已用于另一个启用账号或配置事务，请为每个账号设置独立端口。');
      }
    }
  };
  const reserveConfig = (candidate, previous, id) => {
    if (closing) throw fail('应用正在退出，请重新启动后修改参数。');
    checkConflicts(candidate, id);
    // Retain the old identity and ports while external operations can still
    // fail. Another profile must not acquire resources needed for rollback.
    reservations.set(id, [structuredClone(previous), structuredClone(candidate)]);
    return () => reservations.delete(id);
  };
  const buildService = account => {
    if (services.has(account.id)) return services.get(account.id);
    const service = createAccountService({ account, dataDir: catalog.directory(account.id), csrfToken, installerFactory, runtimeFactory, pluginManager: plugins, ensurePluginReady, getNapcatSettings: napcatSettings.get, redactAll, checkConflicts, reserveConfig });
    services.set(account.id, service);
    return service;
  };
  for (const account of catalog.list()) buildService(account);
  // The blank compatibility service is not listed as a configured account.
  // It preserves old local clients and backend lifecycle checks. The new UI
  // starts with an empty account directory and creates explicit profiles.
  if (!services.has('legacy')) buildService({ id: 'legacy', name: 'QQ 账号', platform: 'qq' });
  const resolve = id => {
    const account = catalog.get(id);
    return services.get(id) || buildService(account);
  };
  const single = () => {
    const accounts = catalog.list();
    if (accounts.length > 1) throw fail('存在多个账号，请先选择账号后操作。');
    if (accounts.length === 1) return resolve(accounts[0].id);
    const account = catalog.ensureLegacy();
    Object.assign(services.get('legacy').account, account);
    return services.get('legacy');
  };
  const directory = () => ({ csrfToken, accounts: catalog.list().map(account => resolve(account.id).summary()), platforms: PLATFORMS, napcatSettings: napcatSettings.get(), plugins: plugins.list() });
  const json = (response, value, code = 200) => {
    response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
  };
  const readBody = async request => {
    if (!(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw fail('请求须为 application/json。', 415);
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 128 * 1024) throw fail('配置体积过大。', 413); chunks.push(chunk); }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw fail('JSON 格式无效。', 400); }
    // Reading a request body yields to shutdown. Recheck before any catalog,
    // profile, or service mutation so a late body cannot create a new runtime.
    if (closing) throw fail('应用正在退出，请重新启动后操作。', 503);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('请求必须为对象。', 400);
    return body;
  };
  const checkLocal = request => {
    const port = server.address()?.port;
    const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!allowed.has(request.headers.host)) throw fail('拒绝非本机 Host。', 403);
    if (request.headers.origin && ![...allowed].map(host => `http://${host}`).includes(request.headers.origin)) throw fail('拒绝跨站请求。', 403);
    if (request.headers['sec-fetch-site'] === 'cross-site') throw fail('拒绝跨站请求。', 403);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const received = Buffer.from(request.headers['x-dashboard-token'] || ''), expected = Buffer.from(csrfToken);
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw fail('页面会话已失效，请刷新后重试。', 403);
    }
  };
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      checkLocal(request);
      if (closing && request.method !== 'GET' && request.method !== 'HEAD') throw fail('应用正在退出，请重新启动后操作。', 503);
      const url = new URL(request.url, `http://${request.headers.host}`), route = url.pathname;
      if (request.method === 'GET' && route === '/api/accounts') return json(response, directory());
      if (request.method === 'GET' && route === '/api/plugins') return json(response, { plugins: plugins.list() });
      const pluginUninstall = route.match(/^\/api\/plugins\/([a-z][a-z0-9-]{0,63})\/uninstall$/);
      if (request.method === 'POST' && (route === '/api/plugins/install' || pluginUninstall)) {
        const body = await readBody(request);
        ensurePluginReady();
        for (const service of services.values()) service.ensureIdle();
        if (pluginUninstall) {
          if (Object.keys(body).length) throw fail('卸载插件无需其他参数。', 400);
          const pluginId = pluginUninstall[1];
          for (const service of services.values()) {
            const current = service.store.getState();
            if ([current.draft, current.applied].some(config => config.plugins?.some(plugin => plugin.id === pluginId && plugin.enabled))) {
              throw fail('此插件仍在账号配置中启用，请先在相关账号中关闭、保存并应用后再卸载。');
            }
          }
        } else if (typeof body.sourcePath !== 'string' || Object.keys(body).some(key => key !== 'sourcePath')) throw fail('请提供本地插件文件夹 sourcePath。', 400);
        pluginMutation = true;
        try {
          if (pluginUninstall) await plugins.uninstall(pluginUninstall[1]);
          else await plugins.install(body.sourcePath);
          return json(response, { plugins: plugins.list() }, pluginUninstall ? 200 : 201);
        } finally { pluginMutation = false; }
      }
      if (request.method === 'GET' && route === '/api/napcat/settings') return json(response, napcatSettings.get());
      if (request.method === 'POST' && route === '/api/napcat/settings') {
        const body = await readBody(request);
        // The synchronous idle check + atomic save prevents changing the shared
        // launch method underneath any account's in-flight install/apply job.
        for (const service of services.values()) service.ensureIdle();
        const saved = napcatSettings.update(body);
        for (const service of services.values()) service.invalidateEnvironment();
        return json(response, saved);
      }
      if (request.method === 'POST' && route === '/api/accounts') {
        const body = await readBody(request);
        const ordinal = catalog.list().length;
        const account = catalog.create(body);
        const service = buildService(catalog.get(account.id));
        const draft = service.store.getConfig();
        draft.botQQ = account.qqNumber;
        draft.qq.wsUrl = `ws://127.0.0.1:${3001 + ordinal * 2}`;
        draft.qq.webUiUrl = `http://127.0.0.1:${6099 + ordinal * 2}`;
        service.store.saveDraft(draft);
        // Establish only the new profile's disabled, read-only identity/ports.
        // The installer reads applied endpoints before the first QQ connection;
        // without this baseline every fresh account would start on port 3001.
        service.store.commitDraft();
        if (started) await service.start();
        return json(response, { account: service.summary(), state: await service.state() }, 201);
      }
      const scoped = route.match(/^\/api\/accounts\/([^/]+)(\/.*)$/);
      if (route.startsWith('/api/')) {
        const service = scoped ? resolve(scoped[1]) : single();
        const action = scoped ? scoped[2] : route.slice('/api'.length);
        if (request.method === 'GET') {
          if (action === '/state') return json(response, await service.state());
          if (action === '/setup/status') return json(response, service.setupStatus());
          if (action === '/tools') {
            const settings = service.store.getConfig().tools || {};
            return json(response, { tools: service.runtime.listTools?.() || [], enabled: settings.enabled === true, triggers: settings.triggers || ['mention', 'poke', 'name'], prefix: settings.prefix || '/工具' });
          }
          if (action === '/config/export') {
            response.setHeader('Content-Disposition', 'attachment; filename="qq-service-config.json"');
            return json(response, service.store.getState().draft);
          }
          if (action === '/napcat/guide') return json(response, typeof service.installer.napcatGuide === 'function' ? await service.installer.napcatGuide() : { url: service.store.getState().draft.qq.webUiUrl });
          if (action === '/qq/groups') return json(response, { groups: await service.runtime.listGroups() });
        }
        if (request.method === 'POST') {
          const body = await readBody(request);
          if (action === '/profile') {
            const account = catalog.rename(service.account.id, body.name);
            Object.assign(service.account, account);
            return json(response, await service.state());
          }
          const result = await service.invoke(action, body);
          return json(response, result.value, result.code || 200);
        }
        throw fail('接口不存在。', 404);
      }
      const files = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/styles.css': ['styles.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'] };
      if (request.method === 'GET' && files[route]) {
        const [file, type] = files[route];
        response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
        return response.end(fs.readFileSync(path.join(projectDir, 'public', file)));
      }
      throw fail('未找到页面或接口。', 404);
    } catch (error) {
      if (!response.headersSent) json(response, safeErrorValue({ error: error.message, ...(typeof error.code === 'string' ? { code: error.code } : {}), ...(error.details ? { details: error.details } : {}), ...(error.issues ? { issues: error.issues } : {}), ...(error.field ? { field: error.field } : {}), ...(error.action ? { action: error.action } : {}), ...(error.nextStep ? { nextStep: error.nextStep } : {}) }), error.statusCode || error.status || (error.details ? 400 : 502));
      else response.end();
    }
  });
  return {
    server, accounts: services, catalog, plugins,
    get store() { return single().store; },
    get runtime() { return single().runtime; },
    get installer() { return single().installer; },
    state: () => single().state(),
    async listen(port = 3210) {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      started = true;
      for (const service of services.values()) { checkConflicts(service.store.getConfig(), service.account.id); await service.start(); }
      return server.address();
    },
    async close() {
      if (closing) return;
      closing = true;
      // Stop accepting new mutations before dismantling the profile runtimes.
      const stopped = server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
      const results = await Promise.allSettled([...services.values()].map(service => service.close()));
      await plugins.close();
      await stopped;
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('请使用 Node.js 24 或双击 start.cmd 自动准备运行环境。');
  const app = createDashboard();
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try { await app.close(); process.exit(0); }
    catch (error) { console.error(`Backend shutdown failed: ${error.message}`); process.exit(1); }
  };
  app.listen(Number(process.env.QQ_DASHBOARD_PORT || 3210)).then(address => {
    console.log(`QQ Bridge dashboard: http://127.0.0.1:${address.port}\nLocal data: ${defaultDataDir()}`);
    if (process.connected) process.send({ type: 'qqbridge:ready', port: address.port });
  }).catch(error => { console.error(error.message); process.exit(1); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
  if (process.send) {
    process.on('message', message => { if (message?.type === 'qqbridge:shutdown') shutdown(); });
    process.on('disconnect', shutdown);
  }
}
