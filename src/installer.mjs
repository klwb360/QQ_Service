import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { nativeNapcatStatus, openNativeNapcat, NATIVE_NAPCAT_INSTALL_URL } from './napcat-native.mjs';
import { isContainer } from './network-policy.mjs';

const NAPCAT_IMAGE = 'mlikiowa/napcat-docker:v4.18.37';
const NAPCAT_VERSION = '4.18.37';
const MANAGED_LABEL = 'io.qqbridge.managed';
const PROJECT_LABEL = 'io.qqbridge.project';
const LOG_LIMIT = 128 * 1024;
const CAPTURE_LIMIT = 64 * 1024;
const MODULES = [
  { id: 'napcat', name: 'QQ / NapCat', kind: 'docker', description: '官方 NapCat 镜像；安装后仍需在本机 WebUI 扫码登录 QQ。' },
  { id: 'deepseek', name: 'DeepSeek', kind: 'builtin', description: '内置 API 接入；填写 API Key 后在功能配置中启用。' },
  { id: 'summary', name: '通知汇总', kind: 'builtin', description: '内置选定群消息收集与汇总；向 QQ 发送需在该账号的消息权限中单独授权。' },
  { id: 'favorites', name: 'QQ 我的收藏', kind: 'builtin', description: '内置当前登录账号的收藏列表读取；完整正文和附件取决于 QQ 接口。' },
];

function problem(message, statusCode = 502, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (details) error.details = details;
  return error;
}

// Locate Docker Desktop without modifying PATH. The injected filesystem check
// keeps Windows path discovery testable on other development platforms.
export function resolveDockerExecutable({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  if (platform !== 'win32') return 'docker';
  const value = (name) => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1] || '';
  const candidates = [];
  for (const directory of (value('PATH') || '').split(';').filter(Boolean)) {
    candidates.push(path.win32.join(directory.replace(/^"|"$/g, ''), 'docker.exe'));
  }
  const programFiles = value('PROGRAMFILES');
  const programW6432 = value('PROGRAMW6432');
  for (const directory of new Set([programFiles, programW6432, 'C:\\Program Files'].filter(Boolean))) {
    candidates.push(path.win32.join(directory, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'));
  }
  const localAppData = value('LOCALAPPDATA');
  if (localAppData) {
    for (const directory of [
      ['Programs', 'DockerDesktop'], ['Programs', 'Docker', 'Docker'],
      ['Programs', 'Docker'], ['Docker', 'Docker'],
    ]) candidates.push(path.win32.join(localAppData, ...directory, 'resources', 'bin', 'docker.exe'));
  }
  return [...new Set(candidates)].find((candidate) => exists(candidate)) || 'docker';
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
function runProcess(command, args, { cwd, env, onLog, timeout = 60_000, allowFailure = false, children, docker = false } = {}) {
  let argv = args;
  let childEnv = env || process.env;
  if (docker) {
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
      const message = error.code === 'ENOENT'
        ? docker
          ? '未找到 Docker Desktop。Docker 仅用于应用内安装和管理 NapCat；若已安装 Windows 原生 NapCat，可直接配置 OneBot 连接，无需安装 Docker。'
          : `找不到可执行程序 ${path.basename(command)}`
        : error.message;
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

export function createInstaller({ dataDir, profileId, legacy = false, getConfig, getNapcatSettings = () => ({ mode: 'docker', executablePath: '', revision: 0 }), getSecret, setSecret, log = () => {} }) {
  const root = path.resolve(dataDir);
  const recordFile = path.join(root, 'module-state.json');
  const napcatDir = path.join(root, 'modules', 'napcat');
  const napcatConfig = path.join(napcatDir, 'config');
  const projectId = createHash('sha256').update(root).digest('hex').slice(0, 24);
  // Root-derived names cannot be supplied by requests. Preserve the existing
  // installation name for migrated profiles and older single-account callers.
  const containerName = legacy || profileId === undefined ? 'qqbridge-napcat' : `qqbridge-napcat-${projectId}`;
  let recordPromise;
  let saveQueue = Promise.resolve();
  const operations = new Set();
  const children = new Set();
  let disposed = false;
  let lastDocker;

  function run(command, args, options = {}) {
    if (disposed) return Promise.reject(problem('安装器已经关闭。', 409));
    const docker = command === 'docker';
    return runProcess(docker ? resolveDockerExecutable() : command, args, { ...options, children, docker });
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
    const settings = getNapcatSettings();
    const native = settings.mode === 'native';
    const checks = { platform: process.platform, arch: process.arch, node: { version: process.version, supported: Number(process.versions.node.split('.')[0]) >= 24 } };
    if (isContainer()) return { ...checks, container: true,
      napcat: { available: true, status: 'external', message: '容器使用外部 OneBot 连接；实际 QQ 在线状态在账号连接中验证。' },
      setupGuide: '在宿主机或其他容器启动 NapCat，使用显式允许的主机名、端口和 Token 连接。本容器不安装或启动宿主机模块。' };
    if (native) {
      const status = nativeNapcatStatus(settings);
      checks.napcat = { available: status.installed, status: status.state, message: status.message };
      checks.setupGuide = '按官方说明安装 Windows 版 NapCat，在全局设置中选择启动文件。多个 QQ 需在 NapCat 中分别登录，并配置各自的连接端口。';
    } else checks.docker = await dockerCheck();
    try {
      const npm = npmInvocation();
      const result = await run(npm.command, [...npm.args, '--version'], { timeout: 15_000 });
      checks.npm = { available: true, version: result.output };
    } catch (error) { checks.npm = { available: false, message: error.message }; }
    if (!native && process.platform === 'win32') {
      try {
        const result = await run('wsl.exe', ['--version'], { timeout: 15_000, allowFailure: true });
        checks.wsl = { available: result.code === 0, message: result.output.slice(0, 1200) };
      } catch (error) { checks.wsl = { available: false, message: error.message }; }
      checks.setupGuide = '仅使用应用内安装和管理 NapCat 时需要 Docker Desktop（Linux 容器）；Windows 原生 NapCat 可直接通过 OneBot 连接，无需 Docker。首次启用 WSL 2 可能需要管理员操作及重启；BIOS 硬件虚拟化需在电脑设置中开启。';
    }
    if (!native) checks.dockerInstallUrl = 'https://docs.docker.com/desktop/setup/install/windows-install/';
    return checks;
  }

  async function inspectContainer() {
    const result = await run('docker', ['container', 'inspect', containerName], { timeout: 15_000, allowFailure: true });
    if (result.code !== 0) {
      if (/No such (object|container)/i.test(result.output)) return null;
      throw problem('无法检查 NapCat 容器。', 502, result.output.slice(-1500));
    }
    const container = JSON.parse(result.output)[0];
    const labels = container.Config?.Labels || {};
    if (labels[MANAGED_LABEL] !== 'true' || labels[PROJECT_LABEL] !== projectId) {
      throw problem(`已存在名为 ${containerName} 的非本项目容器，已停止操作。请先自行更名。`, 409);
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

  async function install(id, onLog) {
    if (isContainer()) throw problem('容器模式连接外部 QQ 端，不管理宿主机模块。', 409);
    if (!MODULES.some((item) => item.id === id)) throw problem('未知模块。', 400);
    return exclusive(id, async () => {
      if (id === 'napcat') {
        if (getNapcatSettings().mode === 'native') throw problem(`当前选择本地安装。请按官方说明安装 NapCat，并在全局设置中选择启动文件：${NATIVE_NAPCAT_INSTALL_URL}`, 409);
        return installNapcat(onLog);
      }
      await saveModule(id, { installed: true, version: 'builtin', installedAt: new Date().toISOString() });
      emit(onLog, '该功能已经内置，可在功能配置中启用。');
      return { installed: true, version: 'builtin' };
    });
  }

  async function startNapcat(onLog) {
    if (isContainer()) throw problem('请在宿主机或外部容器启动 NapCat。', 409);
    return exclusive('napcat', async () => {
      const settings = getNapcatSettings();
      if (settings.mode === 'native') {
        const result = await openNativeNapcat(settings.executablePath);
        emit(onLog, result.message);
        return result;
      }
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
        await run('docker', ['container', 'rm', '-f', containerName], { timeout: 60_000, onLog });
        container = null;
      }
      if (!container?.State?.Running) {
        await ensurePortFree(ports.wsPort);
        await ensurePortFree(ports.webPort);
      }
      if (container) {
        await run('docker', ['container', container.State?.Running ? 'restart' : 'start', containerName], { timeout: 90_000, onLog });
      } else {
        const mount = (directory, destination) => {
          const source = path.join(napcatDir, directory);
          if (source.includes(',')) throw problem('数据目录不能包含逗号，请将项目移动到其他路径。', 400);
          return `type=bind,source=${source},target=${destination}`;
        };
        await run('docker', ['run', '-d', '--name', containerName, '--label', `${MANAGED_LABEL}=true`, '--label', `${PROJECT_LABEL}=${projectId}`, '--restart', 'unless-stopped',
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
    if (isContainer()) throw problem('请在外部连接端停止对应 QQ。', 409);
    return exclusive('napcat', async () => {
      if (getNapcatSettings().mode === 'native') throw problem('本地 NapCat 由其窗口或管理工具控制，请在那里停止对应账号。', 409);
      await requireDocker();
      const container = await inspectContainer();
      if (!container) return { running: false, message: '本项目 NapCat 容器尚未创建。' };
      if (container.State?.Running) await run('docker', ['container', 'stop', containerName], { timeout: 90_000, onLog });
      emit(onLog, '本项目 NapCat 容器已停止，登录和配置数据保留。');
      return { running: false };
    });
  }

  // Called only by the local authenticated dashboard state/guide endpoint.
  // Never include this credential in ordinary module status, exports, or logs.
  async function napcatGuide() {
    if (getNapcatSettings().mode === 'native') return { url: getConfig().qq?.webUiUrl || '', initialWebUiToken: '', message: '打开所选 NapCat 程序，在其管理页面登录或选择对应 QQ。多个账号需使用各自的连接端口。' };
    const file = path.join(napcatConfig, 'webui.json');
    if (!existsSync(file)) return { url: '', initialWebUiToken: '', message: '请先安装 NapCat。' };
    const config = await readJson(file);
    const { webPort } = localPorts();
    return { url: `http://127.0.0.1:${webPort}/webui/`, initialWebUiToken: config.token || '', message: '在本机 WebUI 输入此登录密钥，再用 QQ 手机客户端扫码。若官方 WebUI 要求修改密钥，请按其提示完成。' };
  }

  async function status() {
    if (isContainer()) return MODULES.map(item => ({ ...item, kind: item.id === 'napcat' ? 'external' : item.kind,
      installed: true, state: 'available', version: item.id === 'napcat' ? '' : 'builtin',
      description: item.id === 'napcat' ? '在宿主机或其他容器独立运行；请在账号连接中验证 QQ 身份，不需要在本容器安装 Docker。' : item.description,
      enabled: Boolean(item.id === 'napcat' ? getConfig().qq?.enabled : item.id === 'deepseek' ? getConfig().models?.deepseek?.enabled : getConfig()[item.id]?.enabled) }));
    const settings = getNapcatSettings();
    const native = settings.mode === 'native';
    const state = await records();
    let container;
    let containerError;
    if (!native && state.modules.napcat?.installed) {
      try {
        const docker = await dockerCheck();
        if (docker.running && docker.linuxContainers) container = await inspectContainer();
        else containerError = docker.message;
      } catch (error) { containerError = error.message; }
    }
    const config = getConfig();
    return MODULES.map((item) => {
      if (item.id === 'napcat' && native) {
        const status = nativeNapcatStatus(settings);
        return { ...item, ...status, description: '打开全局设置中选择的本地 NapCat 程序；账号实例与登录由 NapCat 管理。', enabled: Boolean(config.qq?.enabled), ...(operations.has('napcat') ? { state: 'busy' } : {}) };
      }
      const saved = state.modules[item.id];
      const builtin = item.kind === 'builtin';
      const installed = builtin || Boolean(saved?.installed);
      const enabled = item.id === 'deepseek' ? config.models?.deepseek?.enabled : item.id === 'napcat' ? config.qq?.enabled : config[item.id]?.enabled;
      const moduleState = operations.has(item.id) ? 'busy' : item.id === 'napcat' && containerError ? 'error' : item.id === 'napcat' && container?.State?.Running ? 'running' : installed ? (builtin ? 'available' : 'installed') : 'not_installed';
      return { ...item, installed, enabled: Boolean(enabled), state: moduleState, version: saved?.version || (builtin ? 'builtin' : ''), ...(item.id === 'napcat' ? { imageDigest: saved?.imageDigest || '', containerName: containerName, ...(containerError ? { message: containerError } : {}) } : {}) };
    });
  }

  return { environment, status, install, startNapcat, stopNapcat, napcatGuide, dispose };
}
