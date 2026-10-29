import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { validateToolSchema, validateToolInput } from './tool-schema.mjs';

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_FILES = 200;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 32 * 1024;
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const plain = value => value !== null && typeof value === 'object'
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const copy = value => structuredClone(value);

function exactKeys(value, allowed, label) {
  if (!plain(value)) throw fail(`${label}必须为对象。`);
  if (Object.keys(value).some(key => !allowed.includes(key) || FORBIDDEN_KEYS.has(key))) throw fail(`${label}包含未知字段。`);
}

function jsonValue(value, maxBytes, label) {
  const ancestors = new Set();
  const visit = (item, depth = 0) => {
    if (depth > 12) throw fail(`${label}嵌套过深。`);
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if ((!Array.isArray(item) && !plain(item)) || ancestors.has(item)) throw fail(`${label}必须为有限、无循环的 JSON 数据。`);
    ancestors.add(item);
    if (Object.keys(item).length > 1000) throw fail(`${label}字段过多。`);
    for (const key of Object.keys(item)) {
      if (FORBIDDEN_KEYS.has(key)) throw fail(`${label}包含不支持的字段。`);
      visit(item[key], depth + 1);
    }
    ancestors.delete(item);
  };
  visit(value);
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized) > maxBytes) throw fail(`${label}体积过大。`);
  return JSON.parse(serialized);
}

function text(value, label, max, { optional = false, fallback = '' } = {}) {
  if (optional && (value === undefined || value === '')) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail(`${label}须为 1–${max} 字符的文本。`);
  return value.trim();
}

function validateSettingValue(field, value) {
  if (field.type === 'string') {
    if (typeof value !== 'string' || value.length > 6000
      || (field.min !== undefined && value.length < field.min)
      || (field.max !== undefined && value.length > field.max)) throw fail(`插件参数“${field.label}”的文本长度无效。`);
  } else if (field.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)
      || (field.min !== undefined && value < field.min)
      || (field.max !== undefined && value > field.max)) throw fail(`插件参数“${field.label}”的数值无效。`);
  } else if (typeof value !== 'boolean') throw fail(`插件参数“${field.label}”必须是开关。`);
  return value;
}

function validateManifest(value) {
  exactKeys(value, ['apiVersion', 'id', 'name', 'version', 'description', 'entry', 'events', 'permissions', 'settingsSchema', 'timeoutSeconds', 'tools', 'secretsSchema'], '插件清单');
  if (value.apiVersion !== 1) throw fail('插件 apiVersion 必须为 1。');
  if (typeof value.id !== 'string' || !ID.test(value.id)) throw fail('插件 ID 须为小写字母开头的 1–64 位字母、数字或连字符。');
  const entry = text(value.entry, '插件入口', 240);
  if (entry.includes('\\') || entry.includes(':') || path.posix.isAbsolute(entry)
    || entry.split('/').some(part => !part || part === '.' || part === '..') || !entry.endsWith('.mjs')) throw fail('插件入口须为包内相对 .mjs 文件，不能包含路径跳转。');
  const events = value.events ?? [];
  const permissions = value.permissions ?? [];
  if (!Array.isArray(events) || events.some(event => event !== 'group.message') || new Set(events).size !== events.length) throw fail('插件仅支持 group.message 事件且不可重复。');
  if (!Array.isArray(permissions) || permissions.some(permission => !['group.read', 'group.send'].includes(permission))
    || new Set(permissions).size !== permissions.length) throw fail('插件权限只能包含 group.read 和 group.send，且不可重复。');
  if ((events.includes('group.message') && !permissions.includes('group.read'))
    || (permissions.includes('group.send') && (!permissions.includes('group.read') || !events.includes('group.message')))) throw fail('插件群事件需要 group.read，群回复还需要 group.send。');
  const timeoutSeconds = value.timeoutSeconds ?? 5;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 30) throw fail('插件超时须为 1–30 秒整数。');
  const fields = value.settingsSchema ?? [];
  if (!Array.isArray(fields) || fields.length > 50) throw fail('插件参数定义最多 50 项。');
  const keys = new Set();
  const settingsSchema = fields.map(field => {
    exactKeys(field, ['key', 'label', 'type', 'default', 'required', 'min', 'max', 'description'], '插件参数定义');
    if (typeof field.key !== 'string' || !KEY.test(field.key) || FORBIDDEN_KEYS.has(field.key) || keys.has(field.key)) throw fail('插件参数名无效或重复。');
    keys.add(field.key);
    if (!['string', 'number', 'boolean'].includes(field.type)) throw fail('插件参数仅支持 string、number、boolean。');
    if (field.required !== undefined && typeof field.required !== 'boolean') throw fail('插件参数 required 须为开关。');
    const result = { key: field.key, label: text(field.label, '插件参数名称', 100), type: field.type };
    if (field.required !== undefined) result.required = field.required;
    if (field.description !== undefined) result.description = text(field.description, '插件参数说明', 500, { optional: true });
    for (const bound of ['min', 'max']) if (field[bound] !== undefined) {
      if (field.type === 'boolean' || typeof field[bound] !== 'number' || !Number.isFinite(field[bound])
        || (field.type === 'string' && (!Number.isInteger(field[bound]) || field[bound] < 0 || field[bound] > 6000))) throw fail('插件参数上下限无效。');
      result[bound] = field[bound];
    }
    if (result.min !== undefined && result.max !== undefined && result.min > result.max) throw fail('插件参数下限不能大于上限。');
    if (Object.hasOwn(field, 'default')) result.default = validateSettingValue(result, field.default);
    return result;
  });
  const declaredTools = value.tools === undefined ? [] : value.tools;
  if (!Array.isArray(declaredTools) || declaredTools.length > 20) throw fail('每个插件最多声明 20 个 AI 工具。');
  const toolNames = new Set();
  const tools = declaredTools.map(tool => {
    exactKeys(tool, ['name', 'description', 'effect', 'inputSchema'], '插件工具定义');
    if (typeof tool.name !== 'string' || !/^[a-z][a-z0-9_]{0,47}$/.test(tool.name)
      || FORBIDDEN_KEYS.has(tool.name) || toolNames.has(tool.name)) throw fail('插件工具名无效或重复。');
    toolNames.add(tool.name);
    const effect = tool.effect === undefined ? 'write' : tool.effect;
    if (!['read', 'write'].includes(effect)) throw fail('插件工具 effect 只能为 read 或 write。');
    return { name: tool.name, description: text(tool.description, '插件工具说明', 1000), effect, inputSchema: validateToolSchema(tool.inputSchema) };
  });
  const declaredSecrets = value.secretsSchema === undefined ? [] : value.secretsSchema;
  if (!Array.isArray(declaredSecrets) || declaredSecrets.length > 10) throw fail('每个插件最多声明 10 个独立密钥。');
  const secretKeys = new Set();
  const secretsSchema = declaredSecrets.map(field => {
    exactKeys(field, ['key', 'label', 'description'], '插件密钥定义');
    if (typeof field.key !== 'string' || !KEY.test(field.key) || FORBIDDEN_KEYS.has(field.key) || secretKeys.has(field.key)) throw fail('插件密钥名无效或重复。');
    secretKeys.add(field.key);
    const descriptor = { key: field.key, label: text(field.label, '插件密钥名称', 100) };
    if (field.description !== undefined) descriptor.description = text(field.description, '插件密钥说明', 500, { optional: true });
    return descriptor;
  });
  return {
    apiVersion: 1, id: value.id,
    name: text(value.name, '插件名称', 100), version: text(value.version, '插件版本', 64),
    description: text(value.description, '插件说明', 1000, { optional: true }),
    entry, events: [...events], permissions: [...permissions], settingsSchema, timeoutSeconds, tools, secretsSchema,
  };
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function regularDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('插件必须来自普通文件夹，不能使用符号链接或目录联接。');
}

// Never import a package while inspecting/installing it. File descriptors avoid
// following a file that was replaced with a symlink between inspection and copy.
function readBounded(file, limit) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw fail('插件文件类型无效或体积超出限制。');
    const chunks = []; let size = 0;
    const buffer = Buffer.alloc(Math.min(limit + 1, 64 * 1024));
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, limit - size + 1), null);
      if (!count) break;
      size += count;
      if (size > limit) throw fail('插件体积超出限制。');
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    return Buffer.concat(chunks, size);
  } finally { fs.closeSync(fd); }
}

function inspectPackage(directory) {
  regularDirectory(directory);
  const files = [], directories = []; let bytes = 0, entries = 0;
  const visit = (folder, relative = '', depth = 0) => {
    if (depth > 12) throw fail('插件目录嵌套过深。');
    for (const name of fs.readdirSync(folder)) {
      if (++entries > 400) throw fail('插件包最多包含 400 个文件或文件夹目录项。');
      if (['node_modules', '.git'].includes(name.toLowerCase())) throw fail('插件包不能包含 node_modules 或 .git。');
      if (name.includes('\\') || name.includes(':')) throw fail('插件文件名包含不支持的字符。');
      const file = path.join(folder, name);
      const item = relative ? `${relative}/${name}` : name;
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw fail('插件包不能包含符号链接或目录联接。');
      if (stat.isDirectory()) { directories.push(item); visit(file, item, depth + 1); }
      else if (stat.isFile()) {
        files.push({ relative: item, file, size: stat.size }); bytes += stat.size;
        if (files.length > MAX_FILES || bytes > MAX_BYTES) throw fail('插件包最多 200 个文件、20 MiB。');
      } else throw fail('插件包只能包含普通文件和文件夹。');
    }
  };
  visit(directory);
  const manifestFile = files.find(file => file.relative === 'plugin.json');
  if (!manifestFile) throw fail('插件文件夹缺少 plugin.json。');
  let manifest;
  try { manifest = validateManifest(JSON.parse(readBounded(manifestFile.file, MAX_MANIFEST_BYTES).toString('utf8'))); }
  catch (error) { if (error.statusCode) throw error; throw fail('plugin.json 不是有效的 JSON 清单。'); }
  if (!files.some(file => file.relative === manifest.entry)) throw fail('插件入口文件不存在。');
  return { manifest, files, directories };
}

function validateResult(value, manifest, handler) {
  if (value === null || value === undefined) return null;
  exactKeys(value, ['text', 'reply'], '插件返回结果');
  for (const field of ['text', 'reply']) if (Object.hasOwn(value, field)
    && (typeof value[field] !== 'string' || value[field].length > 6000)) throw fail(`插件返回的 ${field} 须为最多 6000 字符的文本。`);
  if (handler === 'callTool' && Object.hasOwn(value, 'reply')) throw fail('AI 工具只能返回本地 text 结果，不能直接返回 reply。', 403);
  if (Object.hasOwn(value, 'reply') && !manifest.permissions.includes('group.send')) throw fail('插件未声明 group.send，不能返回群回复。', 403);
  return jsonValue(value, MAX_RESULT_BYTES, '插件返回结果');
}

export function createPluginManager({ dataDir }) {
  const packages = path.resolve(dataDir, 'plugins', 'packages');
  fs.mkdirSync(packages, { recursive: true, mode: 0o700 });
  regularDirectory(packages);
  const installed = new Map(), invalid = new Map(), active = new Map();
  let closed = false;
  const ensureOpen = () => { if (closed) throw fail('插件服务正在退出。', 503); };
  const requireId = id => { if (typeof id !== 'string' || !ID.test(id)) throw fail('插件 ID 无效。'); };
  const requirePackage = id => {
    requireId(id);
    const descriptor = installed.get(id);
    if (!descriptor) throw fail('插件尚未安装或其文件无效。', 404);
    return descriptor;
  };
  for (const name of fs.readdirSync(packages)) {
    if (!ID.test(name)) continue;
    try {
      const { manifest } = inspectPackage(path.join(packages, name));
      if (manifest.id !== name) throw fail('已安装插件的 ID 与目录不一致。');
      installed.set(name, manifest);
    } catch (error) { invalid.set(name, String(error.message).slice(0, 500)); }
  }
  const validateSettings = (id, value = {}) => {
    const manifest = requirePackage(id);
    if (!plain(value)) throw fail('插件参数必须为对象。');
    jsonValue(value, MAX_INPUT_BYTES, '插件参数');
    const allowed = new Set(manifest.settingsSchema.map(field => field.key));
    if (Object.keys(value).some(key => !allowed.has(key))) throw fail('插件参数包含未定义字段。');
    const settings = {};
    for (const field of manifest.settingsSchema) {
      if (Object.hasOwn(value, field.key)) settings[field.key] = validateSettingValue(field, value[field.key]);
      else if (Object.hasOwn(field, 'default')) settings[field.key] = field.default;
      else if (field.required) throw fail(`请填写插件参数“${field.label}”。`);
    }
    return settings;
  };
  return {
    list: () => [...installed.values()].sort((a, b) => a.id.localeCompare(b.id)).map(copy),
    get: id => installed.has(id) ? copy(installed.get(id)) : undefined,
    errors: () => [...invalid].map(([id, error]) => ({ id, error })),
    validateSettings,
    validateEntries(entries = []) {
      if (!Array.isArray(entries) || entries.length > 50) throw fail('每个账号最多配置 50 个插件。');
      const ids = new Set();
      return entries.map(entry => {
        exactKeys(entry, ['id', 'enabled', 'settings'], '账号插件配置');
        requireId(entry.id);
        if (ids.has(entry.id) || typeof entry.enabled !== 'boolean') throw fail('账号插件 ID 重复或启用状态无效。');
        ids.add(entry.id);
        if (!installed.has(entry.id)) {
          if (entry.enabled) throw fail(`插件 ${entry.id} 尚未安装，不能启用。`, 409);
          const settings = entry.settings ?? {};
          if (!plain(settings)) throw fail('插件参数必须为对象。');
          return { id: entry.id, enabled: false, settings: jsonValue(settings, MAX_INPUT_BYTES, '插件参数') };
        }
        return { id: entry.id, enabled: entry.enabled, settings: validateSettings(entry.id, entry.settings ?? {}) };
      });
    },
    async install(sourcePath) {
      ensureOpen();
      if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath) || sourcePath.includes('\0')) throw fail('请选择插件文件夹的绝对路径。');
      const source = path.resolve(sourcePath);
      regularDirectory(source);
      if (inside(packages, source) || inside(source, packages)) throw fail('请从插件安装目录以外的独立文件夹导入。');
      const { manifest, files, directories } = inspectPackage(source);
      const destination = path.join(packages, manifest.id);
      if (fs.existsSync(destination)) throw fail('同 ID 插件已安装，请先停用并卸载后再导入新版本。', 409);
      if (installed.size + invalid.size >= 128) throw fail('最多安装 128 个自定义插件，请先卸载不用的插件。', 409);
      const staging = path.join(packages, `.install-${randomUUID()}`);
      try {
        fs.mkdirSync(staging, { mode: 0o700 });
        for (const directory of directories) fs.mkdirSync(path.join(staging, ...directory.split('/')), { recursive: true, mode: 0o700 });
        let copiedBytes = 0;
        for (const file of files) {
          const stat = fs.lstatSync(file.file);
          if (!stat.isFile() || stat.isSymbolicLink()) throw fail('导入期间插件文件发生了变化，请重试。');
          const content = readBounded(file.file, MAX_BYTES - copiedBytes);
          copiedBytes += content.length;
          const target = path.join(staging, ...file.relative.split('/'));
          fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
          fs.writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
        }
        const copied = inspectPackage(staging).manifest;
        if (JSON.stringify(copied) !== JSON.stringify(manifest)) throw fail('导入期间插件清单发生变化，请重试。');
        fs.renameSync(staging, destination);
        installed.set(manifest.id, manifest); invalid.delete(manifest.id);
        return copy(manifest);
      } finally { fs.rmSync(staging, { recursive: true, force: true }); }
    },
    async uninstall(id) {
      ensureOpen(); requireId(id);
      if ([...active.values()].some(item => item.id === id)) throw fail('插件仍有任务正在执行，请等待完成或先取消。', 409);
      const directory = path.join(packages, id);
      if (!fs.existsSync(directory)) throw fail('插件尚未安装。', 404);
      const stat = fs.lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail('插件目录类型异常，请检查本地文件。');
      fs.rmSync(directory, { recursive: true });
      installed.delete(id); invalid.delete(id);
      return { id, removed: true };
    },
    async execute(id, invocation, { signal } = {}) {
      ensureOpen();
      const manifest = requirePackage(id);
      if (!plain(invocation) || !['run', 'onMessage', 'callTool'].includes(invocation.handler)) throw fail('插件执行方式无效。');
      if (invocation.handler === 'onMessage' && !manifest.events.includes('group.message')) throw fail('插件没有声明 group.message 事件。', 403);
      if (signal?.aborted) throw fail('插件任务已取消。', 409);
      if (active.size >= 8) throw fail('插件执行队列已满，请稍后重试。', 429);
      const directory = path.join(packages, id);
      const inspected = inspectPackage(directory).manifest;
      if (JSON.stringify(inspected) !== JSON.stringify(manifest)) throw fail('插件清单已在安装目录中改变，请重新导入插件。', 409);
      const payload = { settings: validateSettings(id, invocation.settings ?? {}), context: invocation.context ?? {} };
      const suppliedSecrets = invocation.secrets === undefined ? {} : invocation.secrets;
      if (!plain(suppliedSecrets)) throw fail('插件独立密钥必须为对象。');
      const declaredSecretKeys = new Set(manifest.secretsSchema.map(field => field.key));
      for (const key of Object.keys(suppliedSecrets)) {
        if (!declaredSecretKeys.has(key)) throw fail('插件独立密钥包含未声明字段。');
        const secret = suppliedSecrets[key];
        if (typeof secret !== 'string' || secret.length > 2000 || /[\r\n]/.test(secret)) throw fail('插件独立密钥须为最多 2000 字符的单行文本。');
      }
      payload.secrets = jsonValue(suppliedSecrets, 16 * 1024, '插件独立密钥');
      if (invocation.handler === 'callTool') {
        const tool = manifest.tools.find(item => item.name === invocation.name);
        if (!tool) throw fail('插件未声明这个 AI 工具。', 404);
        payload.name = tool.name;
        payload.arguments = validateToolInput(tool.inputSchema, Object.hasOwn(invocation, 'arguments') ? invocation.arguments : {});
      }
      if (invocation.handler !== 'callTool') {
        if (invocation.input !== undefined) payload.input = invocation.input;
        if (invocation.event !== undefined) payload.event = invocation.event;
      }
      const safePayload = jsonValue(payload, MAX_INPUT_BYTES, '插件输入');
      return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./plugin-worker.mjs', import.meta.url), {
          workerData: { entry: pathToFileURL(path.join(directory, ...manifest.entry.split('/'))).href, handler: invocation.handler, payload: safePayload },
          env: {}, execArgv: [], stdout: true, stderr: true,
          resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
        });
        // Console output can contain group data. The worker protocol returns
        // bounded results/errors; unstructured third-party output is discarded.
        worker.stdout.resume(); worker.stderr.resume();
        let settled = false, timer;
        const finish = async (error, result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer); signal?.removeEventListener('abort', abort);
          try { await worker.terminate(); } catch {}
          active.delete(worker);
          if (error) reject(error); else resolve(result);
        };
        const abort = () => { void finish(fail('插件任务已取消。', 409)); };
        active.set(worker, { id, cancel: () => finish(fail('插件任务已取消。', 409)), worker });
        timer = setTimeout(() => { void finish(fail(`插件执行超时（${manifest.timeoutSeconds} 秒）。`, 408)); }, manifest.timeoutSeconds * 1000);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        worker.on('message', packet => {
          if (settled) return;
          try {
            if (!plain(packet)) throw fail('插件执行协议无效。');
            if (packet.type === 'error' && typeof packet.message === 'string') void finish(fail(`插件执行失败：${packet.message.slice(0, 1000)}`, 502));
            else if (packet.type === 'result') void finish(null, validateResult(packet.value, manifest, invocation.handler));
            else throw fail('插件执行协议无效。');
          } catch (error) { void finish(error); }
        });
        worker.on('error', error => { void finish(fail(`插件进程异常：${String(error.message).slice(0, 1000)}`, 502)); });
        worker.on('exit', code => { if (!settled) void finish(fail(`插件执行意外退出（${code}）。`, 502)); });
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      const tasks = [...active.values()];
      await Promise.allSettled(tasks.map(task => task.cancel()));
    },
  };
}
