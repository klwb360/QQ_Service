import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createStore } from './store.mjs';
import { validateConfig } from './config.mjs';
import { createInstaller } from './installer.mjs';
import { createRuntime } from './runtime.mjs';

const projectDir = fileURLToPath(new URL('../', import.meta.url));
export function defaultDataDir() {
  return process.env.QQ_DASHBOARD_DATA_DIR || (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'QQBridgeDashboard')
    : path.join(os.homedir(), '.local', 'share', 'qq-bridge-dashboard'));
}

export function createDashboard({ dataDir = defaultDataDir(), installerFactory = createInstaller, runtimeFactory = createRuntime } = {}) {
  const store = createStore(dataDir);
  const csrfToken = randomBytes(32).toString('hex');
  const logs = []; const jobs = [];
  let environment = null; let activeJob = null; let applying = false;
  let codexAuth = { loggedIn: null, message: '尚未检查官方 CLI 登录状态' };
  const redact = (value) => {
    let text = String(value ?? '').replace(/\x1b\[[0-9;]*m/g, '');
    for (const secret of Object.values(store.getSecretSnapshot())) if (secret) text = text.split(secret).join('[已隐藏]');
    return text.replace(/(Bearer\s+)[^\s"']+/gi, '$1[已隐藏]')
      .replace(/((?:access_token|refresh_token|api_key|apiKey|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',}\]]+/gi, '$1[已隐藏]')
      .replace(/\bsk-[\w-]{10,}\b/g, '[已隐藏]').slice(0, 4000);
  };
  const log = (message, level = 'info') => {
    logs.push({ id: randomUUID(), time: new Date().toISOString(), level, message: redact(message) });
    if (logs.length > 200) logs.shift();
  };
  const safeDetails = value => typeof value === 'string' ? redact(value) : Array.isArray(value) ? value.map(safeDetails) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeDetails(item)])) : value;
  const installer = installerFactory({ dataDir, getConfig: store.getConfig, getSecret: store.getSecret, setSecret: store.setSecret, log });
  const runtime = runtimeFactory({ getConfig: store.getConfig, getSecret: store.getSecret, store, installer, log });
  const state = async () => {
    const config = store.getState();
    let modules = [];
    try { modules = await installer.status(); } catch (e) { modules = [{ id: 'napcat', name: 'NapCat', state: 'error', description: redact(e.message) }]; }
    return { csrfToken, ...config, pendingChanges: store.pendingChanges(), secrets: { deepseekApiKey: store.hasDraftSecret('deepseekApiKey'), napcatToken: store.hasDraftSecret('napcatToken') }, secretsPendingChanges: store.secretsPending(), codexAuth, runtime: runtime.status(), modules, jobs: jobs.slice(-20), logs: logs.slice(-100), summaries: store.getSummaries(), favorites: store.getFavorites(), environment, metrics: store.metrics(), dataDir };
  };
  const job = (label, action) => {
    if (activeJob) throw Object.assign(new Error('已有安装或授权任务正在执行，请等待它结束'), { statusCode: 409 });
    const item = { id: randomUUID(), label, status: 'running', startedAt: new Date().toISOString(), logs: [] };
    jobs.push(item); if (jobs.length > 30) jobs.shift(); activeJob = item;
    const onLog = (line) => { item.logs.push(redact(line)); if (item.logs.length > 150) item.logs.shift(); };
    Promise.resolve().then(() => action(onLog)).then(result => {
      item.status = 'completed'; item.result = result ?? null; log(`${label}完成`);
    }).catch(e => { item.status = 'failed'; item.error = redact(e.message); if (e.details) item.details = safeDetails(e.details); log(`${label}失败：${e.message}`, 'error'); })
      .finally(() => { item.finishedAt = new Date().toISOString(); activeJob = null; });
    return { job: item };
  };
  const readBody = async (request) => {
    if (!(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw Object.assign(new Error('请求须为 application/json'), { statusCode: 415 });
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 128 * 1024) throw Object.assign(new Error('配置体积过大'), { statusCode: 413 }); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('JSON 格式无效'), { statusCode: 400 }); }
  };
  const json = (response, value, code = 200) => { response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
  const checkLocal = (request) => {
    const port = server.address()?.port;
    const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!allowed.has(request.headers.host)) throw Object.assign(new Error('拒绝非本机 Host'), { statusCode: 403 });
    if (request.headers.origin && ![...allowed].map(h => `http://${h}`).includes(request.headers.origin)) throw Object.assign(new Error('拒绝跨站请求'), { statusCode: 403 });
    if (request.headers['sec-fetch-site'] === 'cross-site') throw Object.assign(new Error('拒绝跨站请求'), { statusCode: 403 });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const received = Buffer.from(request.headers['x-dashboard-token'] || ''); const expected = Buffer.from(csrfToken);
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw Object.assign(new Error('页面会话已失效，请刷新后重试'), { statusCode: 403 });
    }
  };
  const apply = async (rollback = false) => {
    if (applying || activeJob) throw Object.assign(new Error('配置或模块任务正在执行，请稍后应用'), { statusCode: 409 });
    applying = true; const before = store.getState(); const oldSecrets = store.getSecretSnapshot();
    let touchedNapcat = false;
    try {
      if (rollback) store.rollback();
      else { validateConfig(before.draft, { applying: true, hasSecret: store.hasDraftSecret }); store.commitSecrets(); store.commitDraft(); }
      const currentConfig = store.getConfig();
      if (oldSecrets.napcatToken !== store.getSecret('napcatToken') || before.applied.qq.wsUrl !== currentConfig.qq.wsUrl || before.applied.qq.webUiUrl !== currentConfig.qq.webUiUrl || before.applied.botQQ !== currentConfig.botQQ) {
        const modules = await installer.status();
        if (modules.some(m => m.id === 'napcat' && m.state === 'running')) { touchedNapcat = true; await installer.startNapcat(line => log(line)); }
      }
      await runtime.reload();
      log(rollback ? '已恢复上一份应用配置' : `配置版本 ${store.getState().appliedRevision} 已应用；连接和授权状态单独显示`);
    } catch (e) {
      store.restoreState(before); store.restoreSecrets(oldSecrets);
      if (touchedNapcat) {
        try { await installer.startNapcat(line => log(line)); }
        catch (restoreError) { log(`NapCat 配置恢复失败，需要修复：${restoreError.message}`, 'error'); }
      }
      try { await runtime.reload(); } catch (restoreError) { log(`运行时恢复失败：${restoreError.message}`, 'error'); }
      throw e;
    } finally { applying = false; }
  };
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      checkLocal(request);
      const url = new URL(request.url, `http://${request.headers.host}`); const route = url.pathname;
      if (request.method === 'GET' && route === '/api/state') return json(response, await state());
      if (request.method === 'GET' && route === '/api/config/export') {
        response.setHeader('Content-Disposition', 'attachment; filename="qq-bridge-config.json"');
        return json(response, store.getState().draft);
      }
      if (request.method === 'GET' && route === '/api/napcat/guide') {
        if (typeof installer.napcatGuide !== 'function') return json(response, { url: store.getState().draft.qq.webUiUrl });
        return json(response, await installer.napcatGuide());
      }
      if (request.method === 'POST' && route.startsWith('/api/')) {
        const body = await readBody(request);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('请求必须为对象'), { statusCode: 400 });
        if (route === '/api/config/save') {
          if (applying) throw Object.assign(new Error('配置正在应用，请稍后保存'), { statusCode: 409 });
          const config = validateConfig(body.config);
          const updates = body.secretUpdates || {};
          if (typeof updates !== 'object' || Array.isArray(updates)) throw Object.assign(new Error('凭据更新格式无效'), { statusCode: 400 });
          for (const [name, value] of Object.entries(updates)) {
            if (!['deepseekApiKey', 'napcatToken'].includes(name) || typeof value !== 'string' || value.length > 2000 || /[\r\n]/.test(value)) throw Object.assign(new Error('凭据字段无效'), { statusCode: 400 });
          }
          store.stageSecrets(updates);
          store.saveDraft(config); log('草稿已保存，应用后运行时才使用新配置'); return json(response, await state());
        }
        if (route === '/api/config/apply') {
          if (body.revision !== store.getState().revision) throw Object.assign(new Error('草稿版本已变化，请刷新后应用'), { statusCode: 409 });
          await apply(); return json(response, await state());
        }
        if (route === '/api/config/rollback') { await apply(true); return json(response, await state()); }
        if (route === '/api/environment/check') { environment = await installer.environment(); return json(response, await state()); }
        if (route === '/api/setup/install') {
          const ids = body.modules || ['napcat', 'codex'];
          if (!Array.isArray(ids) || !ids.length || ids.some(id => !['napcat', 'codex'].includes(id))) throw Object.assign(new Error('安装模块列表无效'), { statusCode: 400 });
          return json(response, job('安装所选模块', async onLog => {
            for (const id of [...new Set(ids)]) { onLog(`开始安装 ${id}`); await installer.install(id, onLog); if (id === 'napcat') await installer.startNapcat(onLog); }
            environment = await installer.environment();
          }), 202);
        }
        const installMatch = route.match(/^\/api\/modules\/(napcat|codex|deepseek|summary|favorites)\/install$/);
        if (installMatch) return json(response, job(`安装 ${installMatch[1]}`, async onLog => {
          const result = await installer.install(installMatch[1], onLog);
          if (installMatch[1] === 'napcat') await installer.startNapcat(onLog);
          return result;
        }), 202);
        if (route === '/api/modules/napcat/start') return json(response, job('启动 NapCat', installer.startNapcat), 202);
        if (route === '/api/modules/napcat/stop') return json(response, job('停止 NapCat', installer.stopNapcat), 202);
        if (route === '/api/codex/login') return json(response, job('GPT 官方设备授权', async onLog => { codexAuth = await installer.loginCodex(onLog); return codexAuth; }), 202);
        if (route === '/api/codex/status') { codexAuth = await installer.codexStatus(); return json(response, codexAuth); }
        if (route === '/api/runtime/connect') { await runtime.connect(); return json(response, await state()); }
        if (route === '/api/test/deepseek') return json(response, await runtime.testDeepSeek());
        if (route === '/api/summary/run') {
          if (typeof body.groupId !== 'string') throw Object.assign(new Error('请指定工作群号'), { statusCode: 400 });
          return json(response, await runtime.runSummary(body.groupId, { source: 'dashboard' }));
        }
        if (route === '/api/favorites/sync') return json(response, await runtime.syncFavorites());
        if (route === '/api/favorites/summarize') return json(response, await runtime.runFavoritesSummary({ source: 'dashboard' }));
        if (route === '/api/policy/preview') return json(response, runtime.preview(body));
        throw Object.assign(new Error('接口不存在'), { statusCode: 404 });
      }
      const files = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/styles.css': ['styles.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'] };
      if (request.method === 'GET' && files[route]) {
        const [file, type] = files[route]; const content = fs.readFileSync(path.join(projectDir, 'public', file));
        response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' }); return response.end(content);
      }
      json(response, { error: '未找到页面或接口' }, 404);
    } catch (e) {
      const status = e.statusCode || e.status || (e.details ? 400 : 502);
      if (status >= 500) log(e.message, 'error');
      if (!response.headersSent) json(response, { error: redact(e.message), ...(e.details ? { details: safeDetails(e.details) } : {}) }, status);
      else response.end();
    }
  });
  return {
    server, store, runtime, installer, state,
    async listen(port = 3210) {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      Promise.resolve().then(() => installer.environment()).then(result => { environment = result; }).catch(e => log(`环境检查失败：${e.message}`, 'error'));
      await runtime.reload(); return server.address();
    },
    async close() { await runtime.stop(); await installer.dispose?.(); await new Promise(resolve => server.close(resolve)); store.close(); }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) throw new Error('请使用 Node.js 24 或双击 start.cmd 自动准备运行环境');
  const port = Number(process.env.QQ_DASHBOARD_PORT || 3210);
  const app = createDashboard();
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try { await app.close(); process.exit(0); }
    catch (error) { console.error(`Backend shutdown failed: ${error.message}`); process.exit(1); }
  };
  app.listen(port).then(address => {
    console.log(`QQ Bridge dashboard: http://127.0.0.1:${address.port}\nLocal data: ${defaultDataDir()}\nPress Ctrl+C to stop.`);
    if (process.connected) process.send({ type: 'qqbridge:ready', port: address.port });
  }).catch(error => { console.error(error.message); process.exit(1); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
  if (process.send) {
    process.on('message', message => { if (message?.type === 'qqbridge:shutdown') shutdown(); });
    process.on('disconnect', shutdown);
  }
}
