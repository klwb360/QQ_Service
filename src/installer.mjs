import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const NAPCAT_IMAGE = 'mlikiowa/napcat-docker:v4.18.37';
const NAPCAT_VERSION = '4.18.37';
const CODEX_VERSION = '0.149.1';
const CONTAINER_NAME = 'qqbridge-napcat';
const MANAGED_LABEL = 'io.qqbridge.managed';
const PROJECT_LABEL = 'io.qqbridge.project';
const LOG_LIMIT = 128 * 1024;
const CAPTURE_LIMIT = 64 * 1024;
const MODULES = [
  { id: 'napcat', name: 'QQ / NapCat', kind: 'docker', description: '官方 NapCat 镜像；安装后仍需在本机 WebUI 扫码登录 QQ。' },
  { id: 'codex', name: 'GPT 订阅 / Codex', kind: 'npm', description: '官方 Codex CLI；使用独立登录目录，仅供本人请求及已授权的后台汇总。' },
  { id: 'deepseek', name: 'DeepSeek', kind: 'builtin', description: '内置 API 接入；填写 API Key 后在功能配置中启用。' },
  { id: 'summary', name: '通知汇总', kind: 'builtin', description: '内置工作群消息收集与汇总；工作群只读。' },
  { id: 'favorites', name: 'QQ 我的收藏', kind: 'builtin', description: '内置当前登录账号的收藏列表读取；完整正文和附件取决于 QQ 接口。' },
];

function problem(message, statusCode = 502, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (details) error.details = details;
  return error;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw problem(`无法读取配置文件 ${path.basename(file)}：${error.message}`);
  }
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

function waitForExit(info, milliseconds) {
  let timer;
  return Promise.race([
    info.done.then(() => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

// The PID/group is always captured from our own spawn, never supplied by a request.
function terminateOwnedProcess(info) {
  if (info.closed || !Number.isSafeInteger(info.child.pid) || info.child.pid <= 0) return Promise.resolve();
  info.termination ||= (async () => {
    if (process.platform === 'win32') {
      const configuredRoot = process.env.SystemRoot || process.env.SYSTEMROOT || '';
      const windowsRoot = /^[a-z]:[\\/]/i.test(configuredRoot) ? configuredRoot : 'C:\\Windows';
      const executable = path.win32.join(windowsRoot, 'System32', 'taskkill.exe');
      await new Promise((resolve, reject) => {
        const killer = spawn(executable, ['/PID', String(info.child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        const timer = setTimeout(() => { killer.kill('SIGKILL'); reject(problem('结束本项目子进程树超时。')); }, 5000);
        killer.once('error', (error) => { clearTimeout(timer); reject(problem(`无法结束本项目子进程树：${error.message}`)); });
        killer.once('close', (code) => {
          clearTimeout(timer);
          if (code === 0 || info.closed) resolve();
          else reject(problem(`结束本项目子进程树失败（taskkill ${code}）。`));
        });
      });
    } else {
      const signalGroup = (signal) => {
        try { process.kill(-info.child.pid, signal); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      };
      signalGroup('SIGTERM');
      if (!(await waitForExit(info, 1500))) signalGroup('SIGKILL');
    }
    if (!(await waitForExit(info, 5000))) throw problem('本项目子进程树未及时退出。');
  })();
  return info.termination;
}

// Fixed, trusted argv only. Output is bounded here; the server additionally redacts it.
function runProcess(command, args, { cwd, env, onLog, timeout = 60_000, allowFailure = false, children } = {}) {
  let argv = args;
  let childEnv = env || process.env;
  if (command === 'docker') {
    const localHost = process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock';
    argv = ['--host', localHost, ...args];
    childEnv = Object.fromEntries(Object.entries(childEnv).filter(([key]) => !/^DOCKER_(HOST|CONTEXT|TLS|TLS_VERIFY|CERT_PATH)$/i.test(key)));
  }
  return new Promise((resolve, reject) => {
    let output = '';
    let emitted = 0;
    let finished = false;
    let timedOut = false;
    const pending = { stdout: '', stderr: '' };
    const child = spawn(command, argv, {
      cwd, env: childEnv, shell: false, windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let markDone;
    const info = { child, closed: false, disposed: false, done: new Promise((resolve) => { markDone = resolve; }) };
    children?.add(info);
    const cleanup = () => { info.closed = true; children?.delete(info); markDone(); };
    const emit = (line) => {
      if (!onLog || emitted >= LOG_LIMIT) return;
      const safeLine = line.slice(0, 4096);
      emitted += Buffer.byteLength(safeLine);
      onLog(safeLine);
    };
    const collect = (source, chunk) => {
      const text = chunk.toString('utf8');
      output = (output + text).slice(-CAPTURE_LIMIT);
      pending[source] += text;
      let index;
      while ((index = pending[source].search(/[\r\n]/)) !== -1) {
        const line = pending[source].slice(0, index);
        pending[source] = pending[source].slice(index + 1);
        if (line) emit(line);
      }
      if (pending[source].length > 8192) {
        emit(pending[source].slice(0, 4096));
        pending[source] = pending[source].slice(-4096);
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => collect('stdout', chunk));
    child.stderr.on('data', (chunk) => collect('stderr', chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      terminateOwnedProcess(info).catch((error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        reject(problem(`${path.basename(command)} 操作超时，且进程清理失败：${error.message}`));
      });
    }, timeout);
    child.once('error', (error) => {
      cleanup();
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const message = error.code === 'ENOENT' ? `找不到可执行程序 ${path.basename(command)}` : error.message;
      reject(problem(message));
    });
    child.once('close', (code, signal) => {
      cleanup();
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const tail of Object.values(pending)) if (tail) emit(tail);
      if (timedOut) return reject(problem(`${path.basename(command)} 操作超时，请检查网络或登录状态。`));
      if (info.disposed) return reject(problem('操作已因仪表盘关闭取消。', 409));
      if (code !== 0 && !allowFailure) {
        return reject(problem(`${path.basename(command)} 执行失败（退出码 ${code ?? signal}）。`, 502, output.trim().slice(-8000)));
      }
      resolve({ code, signal, output: output.trim() });
    });
  });
}

async function ensurePortFree(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error) => reject(problem(`本机端口 ${port} 不可用：${error.code}。请修改端口或关闭占用服务。`, 409)));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(resolve));
  });
}

export function createInstaller({ dataDir, getConfig, getSecret, setSecret, log = () => {} }) {
  const root = path.resolve(dataDir);
  const recordFile = path.join(root, 'module-state.json');
  const napcatDir = path.join(root, 'modules', 'napcat');
  const napcatConfig = path.join(napcatDir, 'config');
  const codexDir = path.join(root, 'modules', 'codex');
  const codexHome = path.join(root, 'codex-home');
  const codexWorkspace = path.join(root, 'codex-workspace');
  const codexCli = path.join(codexDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const projectId = createHash('sha256').update(root).digest('hex').slice(0, 24);
  let recordPromise;
  let saveQueue = Promise.resolve();
  const operations = new Set();
  const children = new Set();
  let disposed = false;
  let lastDocker;

  function run(command, args, options = {}) {
    if (disposed) return Promise.reject(problem('安装器已经关闭。', 409));
    return runProcess(command, args, { ...options, children });
  }

  async function dispose() {
    disposed = true;
    const current = [...children];
    for (const info of current) info.disposed = true;
    const results = await Promise.allSettled(current.map(terminateOwnedProcess));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
    await saveQueue;
  }

  function records() {
    recordPromise ||= readJson(recordFile, { schemaVersion: 1, modules: {} }).then((value) => {
      if (value.schemaVersion !== 1 || !value.modules || typeof value.modules !== 'object') {
        throw problem('模块安装记录格式不正确，请保留文件并检查。');
      }
      return value;
    });
    return recordPromise;
  }

  async function saveModule(id, value) {
    const state = await records();
    state.modules[id] = value;
    const snapshot = JSON.parse(JSON.stringify(state));
    const save = saveQueue.catch(() => {}).then(() => atomicJson(recordFile, snapshot));
    saveQueue = save;
    await save;
  }

  async function exclusive(id, work) {
    if (disposed) throw problem('安装器已经关闭。', 409);
    if (operations.has(id)) throw problem('该模块已有操作正在执行，请等待当前任务结束。', 409);
    operations.add(id);
    try { return await work(); }
    finally { operations.delete(id); }
  }

  function emit(onLog, line) { (onLog || log)(line); }

  function npmInvocation() {
    const configured = process.env.QQ_DASHBOARD_NPM_CLI;
    if (configured) {
      const cli = path.resolve(configured);
      if (!existsSync(cli)) throw problem('QQ_DASHBOARD_NPM_CLI 指定的 npm-cli.js 不存在。', 409);
      return { command: process.execPath, args: [cli] };
    }
    const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (existsSync(cli)) return { command: process.execPath, args: [cli] };
    if (process.platform === 'win32') {
      throw problem('未找到 npm-cli.js，请使用项目 Windows 启动器，或设置 QQ_DASHBOARD_NPM_CLI。', 409);
    }
    return { command: 'npm', args: [] };
  }

  async function dockerCheck() {
    try {
      const result = await run('docker', ['version', '--format', '{{json .Server}}'], { timeout: 15_000, allowFailure: true });
      if (result.code !== 0) {
        lastDocker = { installed: true, running: false, linuxContainers: false, message: 'Docker 服务未就绪。Windows 请启动 Docker Desktop 并等待引擎启动。', details: result.output.slice(-1500) };
      } else {
        let server;
        try { server = JSON.parse(result.output); }
        catch { throw problem('Docker 返回了无法解析的版本信息。'); }
        lastDocker = {
          installed: true, running: true, linuxContainers: server.Os === 'linux', version: server.Version || '',
          message: server.Os === 'linux' ? 'Docker Linux 容器引擎已就绪。' : 'NapCat 需要 Linux 容器；请在 Docker Desktop 切换到 Linux containers。',
        };
      }
    } catch (error) {
      lastDocker = { installed: false, running: false, linuxContainers: false, message: error.message };
    }
    return lastDocker;
  }

  async function requireDocker() {
    const result = await dockerCheck();
    if (!result.running || !result.linuxContainers) throw problem(result.message, 409, result.details);
  }

  async function environment() {
    const checks = { platform: process.platform, arch: process.arch, node: { version: process.version, supported: Number(process.versions.node.split('.')[0]) >= 24 }, docker: await dockerCheck() };
    try {
      const npm = npmInvocation();
      const result = await run(npm.command, [...npm.args, '--version'], { timeout: 15_000 });
      checks.npm = { available: true, version: result.output };
    } catch (error) { checks.npm = { available: false, message: error.message }; }
    if (process.platform === 'win32') {
      try {
        const result = await run('wsl.exe', ['--version'], { timeout: 15_000, allowFailure: true });
        checks.wsl = { available: result.code === 0, message: result.output.slice(0, 1200) };
      } catch (error) { checks.wsl = { available: false, message: error.message }; }
      checks.setupGuide = '请安装并启动 Docker Desktop，使用 Linux 容器。首次启用 WSL 2 可能需要管理员操作及重启；BIOS 硬件虚拟化需在电脑设置中开启。';
    }
    checks.dockerInstallUrl = 'https://docs.docker.com/desktop/setup/install/windows-install/';
    return checks;
  }

  async function inspectContainer() {
    const result = await run('docker', ['container', 'inspect', CONTAINER_NAME], { timeout: 15_000, allowFailure: true });
    if (result.code !== 0) {
      if (/No such (object|container)/i.test(result.output)) return null;
      throw problem('无法检查 NapCat 容器。', 502, result.output.slice(-1500));
    }
    const container = JSON.parse(result.output)[0];
    const labels = container.Config?.Labels || {};
    if (labels[MANAGED_LABEL] !== 'true' || labels[PROJECT_LABEL] !== projectId) {
      throw problem(`已存在名为 ${CONTAINER_NAME} 的非本项目容器，已停止操作。请先自行更名。`, 409);
    }
    return container;
  }

  function localPorts() {
    const config = getConfig();
    let ws, web;
    try {
      ws = new URL(config.qq?.wsUrl || 'ws://127.0.0.1:3001');
      web = new URL(config.qq?.webUiUrl || 'http://127.0.0.1:6099');
    } catch { throw problem('QQ 本机连接地址格式不正确。', 400); }
    const loopback = (url) => ['127.0.0.1', 'localhost'].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash;
    if (!loopback(ws) || !loopback(web) || ws.protocol !== 'ws:' || web.protocol !== 'http:' || !['', '/'].includes(ws.pathname) || !['', '/', '/webui', '/webui/'].includes(web.pathname)) {
      throw problem('托管 NapCat 仅支持本机 ws://127.0.0.1:端口 和 http://127.0.0.1:端口。远程连接可直接使用运行时，不通过本机安装器启动。', 400);
    }
    const wsPort = Number(ws.port || 80);
    const webPort = Number(web.port || 80);
    if (wsPort === webPort) throw problem('OneBot 与 WebUI 端口不能相同。', 400);
    return { wsPort, webPort };
  }

  async function configureNapcat() {
    await Promise.all(['config', 'qq', 'plugins'].map((name) => mkdir(path.join(napcatDir, name), { recursive: true })));
    let token = await getSecret('napcatToken');
    const needsSecret = !token;
    if (!token) {
      token = randomBytes(32).toString('hex');
    }
    const websocket = { name: 'qqbridge-ws', enable: true, host: '0.0.0.0', port: 3001, reportSelfMessage: false, enableForcePushEvent: true, messagePostFormat: 'array', token, debug: false, heartInterval: 30_000 };
    const names = (await readdir(napcatConfig)).filter((name) => /^onebot11_[0-9]+\.json$/.test(name));
    if (getConfig().botQQ && /^[0-9]+$/.test(getConfig().botQQ)) names.push(`onebot11_${getConfig().botQQ}.json`);
    names.push('onebot11.json');
    const writes = [];
    for (const name of new Set(names)) {
      const file = path.join(napcatConfig, name);
      const config = await readJson(file, {});
      const network = { httpServers: [], httpSseServers: [], httpClients: [], websocketServers: [], websocketClients: [], plugins: [], ...config.network };
      const servers = Array.isArray(network.websocketServers) ? network.websocketServers : [];
      const conflict = servers.find((item) => item.name !== 'qqbridge-ws' && item.enable && Number(item.port) === 3001);
      if (conflict) throw problem(`${name} 内已有使用 3001 的其他 WS 服务，请在 NapCat WebUI 调整后重试。`, 409);
      network.websocketServers = [...servers.filter((item) => item.name !== 'qqbridge-ws'), websocket];
      writes.push([file, { musicSignUrl: '', enableLocalFile2Url: false, parseMultMsg: false, ...config, network }]);
    }
    const webFile = path.join(napcatConfig, 'webui.json');
    const existingWeb = await readJson(webFile, {});
    const webToken = existingWeb.token && existingWeb.token !== 'napcat' ? existingWeb.token : randomBytes(24).toString('hex');
    writes.push([webFile, { ...existingWeb, host: '0.0.0.0', port: 6099, token: webToken, loginRate: existingWeb.loginRate || 3 }]);
    // Validate every existing account/config first. A malformed file or port
    // conflict must not leave earlier account files partly reconfigured.
    if (needsSecret) await setSecret('napcatToken', token);
    for (const [file, value] of writes) await atomicJson(file, value);
  }

  async function installNapcat(onLog) {
    await requireDocker();
    await inspectContainer();
    const state = await records();
    if (state.modules.napcat?.imageDigest) {
      const result = await run('docker', ['image', 'inspect', state.modules.napcat.imageDigest], { timeout: 15_000, allowFailure: true });
      if (result.code === 0) {
        emit(onLog, '已安装的 NapCat 镜像摘要保持锁定。');
        await configureNapcat();
        return { installed: true, imageDigest: state.modules.napcat.imageDigest };
      }
      emit(onLog, '正在重新获取之前锁定的 NapCat 镜像。');
      await run('docker', ['pull', state.modules.napcat.imageDigest], { onLog, timeout: 20 * 60_000 });
      await configureNapcat();
      return { installed: true, imageDigest: state.modules.napcat.imageDigest };
    }
    emit(onLog, `正在拉取官方 NapCat ${NAPCAT_VERSION} 镜像，安装不会登录 QQ。`);
    await run('docker', ['pull', NAPCAT_IMAGE], { onLog, timeout: 20 * 60_000 });
    const inspected = await run('docker', ['image', 'inspect', NAPCAT_IMAGE, '--format', '{{json .RepoDigests}}'], { timeout: 15_000 });
    const digests = JSON.parse(inspected.output);
    const digest = Array.isArray(digests) && digests.find((item) => /^mlikiowa\/napcat-docker@sha256:[a-f0-9]{64}$/.test(item));
    if (!digest) throw problem('官方镜像未返回可验证的仓库摘要，安装未标记完成。');
    await configureNapcat();
    await saveModule('napcat', { installed: true, version: NAPCAT_VERSION, imageDigest: digest, installedAt: new Date().toISOString() });
    emit(onLog, 'NapCat 已准备完成并锁定镜像。请启动后在官方 WebUI 扫码。');
    return { installed: true, imageDigest: digest };
  }

  async function installCodex(onLog) {
    const state = await records();
    if (state.modules.codex?.installed && existsSync(codexCli)) {
      const result = await run(process.execPath, [codexCli, '--version'], { env: codexInvocation().env });
      emit(onLog, `已安装：${result.output}。保持固定版本。`);
      return { installed: true, version: state.modules.codex.version };
    }
    await mkdir(codexDir, { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await mkdir(codexWorkspace, { recursive: true });
    const npm = npmInvocation();
    emit(onLog, `正在安装官方 @openai/codex@${CODEX_VERSION} 到本项目目录。`);
    await run(npm.command, [...npm.args, 'install', '--prefix', codexDir, '--include=optional', '--ignore-scripts', '--no-audit', '--no-fund', `@openai/codex@${CODEX_VERSION}`], { onLog, cwd: root, timeout: 20 * 60_000 });
    if (!existsSync(codexCli)) throw problem('npm 返回成功，但官方 Codex CLI 入口不存在。');
    const invocation = codexInvocation();
    const result = await run(invocation.command, [...invocation.args, '--version'], { env: invocation.env, cwd: invocation.cwd, timeout: 30_000 });
    if (!new RegExp(`\\b${CODEX_VERSION.replaceAll('.', '\\.')}\\b`).test(result.output)) throw problem('安装的 Codex 版本与锁定版本不匹配。', 502, result.output);
    await saveModule('codex', { installed: true, version: CODEX_VERSION, installedAt: new Date().toISOString() });
    emit(onLog, '官方 Codex CLI 已安装；需要另外完成 ChatGPT 设备码登录。');
    return { installed: true, version: CODEX_VERSION };
  }

  function codexInvocation() {
    if (!existsSync(codexCli)) throw problem('请先安装官方 Codex CLI 模块。', 409);
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(codexWorkspace, { recursive: true });
    // Keep only OS/runtime and network trust settings. Do not expose model API
    // credentials, custom OpenAI endpoints, or arbitrary inherited secrets.
    const allowed = new Set([
      'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'HOME', 'USERPROFILE',
      'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP',
      'TMPDIR', 'USER', 'USERNAME', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE',
      'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
      'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    ]);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
    env.CODEX_HOME = codexHome;
    env.NO_COLOR = '1';
    env.TERM = 'dumb';
    return { command: process.execPath, args: [codexCli], env, cwd: codexWorkspace };
  }

  async function install(id, onLog) {
    if (!MODULES.some((item) => item.id === id)) throw problem('未知模块。', 400);
    return exclusive(id, async () => {
      if (id === 'napcat') return installNapcat(onLog);
      if (id === 'codex') return installCodex(onLog);
      await saveModule(id, { installed: true, version: 'builtin', installedAt: new Date().toISOString() });
      emit(onLog, '该功能已经内置，可在功能配置中启用。');
      return { installed: true, version: 'builtin' };
    });
  }

  async function startNapcat(onLog) {
    return exclusive('napcat', async () => {
      await requireDocker();
      const state = await records();
      const module = state.modules.napcat;
      if (!module?.installed || !module.imageDigest) throw problem('请先安装 NapCat 模块。', 409);
      const ports = localPorts();
      let container = await inspectContainer();
      await configureNapcat();
      const desiredBindings = (item, containerPort, hostPort) => {
        const bindings = item.HostConfig?.PortBindings?.[`${containerPort}/tcp`];
        return bindings?.length === 1 && bindings[0].HostIp === '127.0.0.1' && bindings[0].HostPort === String(hostPort);
      };
      if (container && (container.Config.Image !== module.imageDigest || !desiredBindings(container, 3001, ports.wsPort) || !desiredBindings(container, 6099, ports.webPort))) {
        emit(onLog, '正在重新创建本项目的 NapCat 容器，持久数据会保留。');
        await run('docker', ['container', 'rm', '-f', CONTAINER_NAME], { timeout: 60_000, onLog });
        container = null;
      }
      if (!container?.State?.Running) {
        await ensurePortFree(ports.wsPort);
        await ensurePortFree(ports.webPort);
      }
      if (container) {
        await run('docker', ['container', container.State?.Running ? 'restart' : 'start', CONTAINER_NAME], { timeout: 90_000, onLog });
      } else {
        const mount = (directory, destination) => {
          const source = path.join(napcatDir, directory);
          if (source.includes(',')) throw problem('数据目录不能包含逗号，请将项目移动到其他路径。', 400);
          return `type=bind,source=${source},target=${destination}`;
        };
        await run('docker', ['run', '-d', '--name', CONTAINER_NAME, '--label', `${MANAGED_LABEL}=true`, '--label', `${PROJECT_LABEL}=${projectId}`, '--restart', 'unless-stopped',
          '-p', `127.0.0.1:${ports.wsPort}:3001`, '-p', `127.0.0.1:${ports.webPort}:6099`,
          '--mount', mount('qq', '/app/.config/QQ'), '--mount', mount('config', '/app/napcat/config'), '--mount', mount('plugins', '/app/napcat/plugins'), module.imageDigest], { timeout: 90_000, onLog });
      }
      const started = await inspectContainer();
      if (!started?.State?.Running) throw problem('NapCat 容器未进入运行状态。请查看 Docker Desktop 中的该容器日志。');
      emit(onLog, 'NapCat 容器已启动；QQ 登录及 OneBot 就绪状态需要在连接测试中确认。');
      return { running: true, message: '容器已启动，请在本机官方 WebUI 扫码登录 QQ。' };
    });
  }

  async function stopNapcat(onLog) {
    return exclusive('napcat', async () => {
      await requireDocker();
      const container = await inspectContainer();
      if (!container) return { running: false, message: '本项目 NapCat 容器尚未创建。' };
      if (container.State?.Running) await run('docker', ['container', 'stop', CONTAINER_NAME], { timeout: 90_000, onLog });
      emit(onLog, '本项目 NapCat 容器已停止，登录和配置数据保留。');
      return { running: false };
    });
  }

  async function loginCodex(onLog) {
    return exclusive('codex', async () => {
      await mkdir(codexHome, { recursive: true });
      await mkdir(codexWorkspace, { recursive: true });
      const invocation = codexInvocation();
      emit(onLog, '请按官方 CLI 输出在 OpenAI 授权页面输入设备码并登录；不要粘贴账号 token。');
      await run(invocation.command, [...invocation.args, 'login', '--device-auth'], { env: invocation.env, cwd: invocation.cwd, onLog, timeout: 15 * 60_000 });
      const result = await codexStatus();
      if (!result.loggedIn) throw problem('官方 CLI 登录没有完成 ChatGPT 订阅认证。', 502, result.message);
      return result;
    });
  }

  async function codexStatus() {
    if (!existsSync(codexCli)) return { loggedIn: false, message: '官方 Codex CLI 尚未安装。' };
    const invocation = codexInvocation();
    const result = await run(invocation.command, [...invocation.args, 'login', 'status'], { env: invocation.env, cwd: invocation.cwd, timeout: 30_000, allowFailure: true });
    if (result.code === 0) {
      if (/api key/i.test(result.output)) return { loggedIn: false, message: '当前 CLI 使用 API Key，请执行 ChatGPT 设备码登录。' };
      return { loggedIn: true, message: result.output || '官方 CLI 已确认登录。' };
    }
    if (/not logged in|not authenticated|please (log|sign) in/i.test(result.output)) return { loggedIn: false, message: '尚未登录 ChatGPT，请启动设备码登录。' };
    throw problem('无法检查官方 Codex 登录状态。', 502, result.output.slice(-1500));
  }

  // Called only by the local authenticated dashboard state/guide endpoint.
  // Never include this credential in ordinary module status, exports, or logs.
  async function napcatGuide() {
    const file = path.join(napcatConfig, 'webui.json');
    if (!existsSync(file)) return { url: '', initialWebUiToken: '', message: '请先安装 NapCat。' };
    const config = await readJson(file);
    const { webPort } = localPorts();
    return { url: `http://127.0.0.1:${webPort}/webui/`, initialWebUiToken: config.token || '', message: '在本机 WebUI 输入此登录密钥，再用 QQ 手机客户端扫码。若官方 WebUI 要求修改密钥，请按其提示完成。' };
  }

  async function status() {
    const state = await records();
    let container;
    let containerError;
    if (state.modules.napcat?.installed) {
      try {
        const docker = await dockerCheck();
        if (docker.running && docker.linuxContainers) container = await inspectContainer();
        else containerError = docker.message;
      } catch (error) { containerError = error.message; }
    }
    const config = getConfig();
    return MODULES.map((item) => {
      const saved = state.modules[item.id];
      const builtin = item.kind === 'builtin';
      const installed = builtin || Boolean(saved?.installed && (item.id !== 'codex' || existsSync(codexCli)));
      const enabled = item.id === 'deepseek' ? config.models?.deepseek?.enabled : item.id === 'codex' ? config.models?.codex?.enabled : item.id === 'napcat' ? config.qq?.enabled : config[item.id]?.enabled;
      const moduleState = operations.has(item.id) ? 'busy' : item.id === 'napcat' && containerError ? 'error' : item.id === 'napcat' && container?.State?.Running ? 'running' : installed ? (builtin ? 'available' : 'installed') : 'not_installed';
      return { ...item, installed, enabled: Boolean(enabled), state: moduleState, version: saved?.version || (builtin ? 'builtin' : ''), ...(item.id === 'napcat' ? { imageDigest: saved?.imageDigest || '', containerName: CONTAINER_NAME, ...(containerError ? { message: containerError } : {}) } : {}) };
    });
  }

  return { environment, status, install, startNapcat, stopNapcat, loginCodex, codexStatus, codexInvocation, napcatGuide, dispose };
}
