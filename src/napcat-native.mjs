import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
export const NATIVE_NAPCAT_INSTALL_URL = 'https://napneko.github.io/guide/boot/Shell#windows-onekey';

// This is a user-selected executable, never a command line. Restrict it to a
// drive-absolute Windows file and reject shell expansion in batch filenames.
// The launcher does not guess QQ arguments, edit third-party config or create
// account instances. A NapCat desktop manager can manage those independently.
export function validateNativeExecutablePath(value, { allowEmpty = true } = {}) {
  if (typeof value !== 'string' || value.length > 4096) throw fail('NapCat 启动文件路径无效，请重新选择文件。', 400);
  if (!value && allowEmpty) return '';
  if (!/^[a-z]:[\\/]/i.test(value) || /[\x00-\x1f<>"|?*]/.test(value) || value.slice(2).includes(':')) {
    throw fail('请选择本机磁盘中的 NapCat 启动文件，不支持相对路径、网络共享路径或命令。', 400);
  }
  const normalized = path.win32.normalize(value);
  const extension = path.win32.extname(normalized).toLowerCase();
  if (!['.exe', '.bat', '.cmd'].includes(extension)) throw fail('NapCat 启动文件必须是 .exe、.bat 或 .cmd 文件。', 400);
  if (extension !== '.exe' && normalized.includes('%')) throw fail('批处理启动文件的路径不能包含 %，请将 NapCat 移到其他目录后重新选择。', 400);
  if (normalized.slice(3).split('\\').some(part => !part || /[. ]$/.test(part))) throw fail('启动文件路径中的目录和文件名不能以空格或句点结尾。', 400);
  return normalized;
}

function selectedFile(value, stat) {
  const executablePath = validateNativeExecutablePath(value, { allowEmpty: false });
  try {
    if (!stat(executablePath).isFile()) throw fail('选择的位置不是文件，请重新选择 NapCat 启动文件。');
  } catch (error) {
    if (error.statusCode) throw error;
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw fail('找不到 NapCat 启动文件。文件可能已移动，请在设置中重新选择。');
    throw fail('无法读取 NapCat 启动文件，请检查本机文件权限。');
  }
  return executablePath;
}

export function nativeNapcatStatus(settings, { platform = process.platform, stat = statSync } = {}) {
  const base = { kind: 'native', installed: false, executablePath: settings?.executablePath || '', version: '', managed: false };
  if (!base.executablePath) return { ...base, state: 'not_configured', message: '请先按官方说明安装 NapCat，再在设置中选择启动文件。' };
  if (platform !== 'win32') return { ...base, state: 'error', message: '本地 NapCat 启动仅支持 Windows 桌面应用。' };
  try {
    const executablePath = selectedFile(base.executablePath, stat);
    return { ...base, installed: true, executablePath, state: 'configured', message: '启动文件可用；QQ 登录和实际连接状态需要单独验证。' };
  } catch (error) { return { ...base, state: 'error', message: error.message }; }
}

function nativeEnvironment(env) {
  // Retain OS lookup, networking and CA trust. Model keys, CLI auth, NODE_OPTIONS
  // and arbitrary inherited variables must not reach an external launcher.
  const allowed = new Set([
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'HOME', 'USERPROFILE',
    'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ALLUSERSPROFILE', 'PROGRAMDATA',
    'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'PUBLIC', 'TMP', 'TEMP', 'TMPDIR',
    'USER', 'USERNAME', 'LOGNAME', 'COMPUTERNAME', 'OS', 'PROCESSOR_ARCHITECTURE',
    'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS', 'LANG', 'LC_ALL', 'LC_CTYPE',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE',
  ]);
  return Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key.toUpperCase())));
}

export function nativeNapcatInvocation(value, { platform = process.platform, env = process.env, stat = statSync } = {}) {
  if (platform !== 'win32') throw fail('本地 NapCat 启动仅支持 Windows；请在 Windows 电脑上打开此应用。');
  if (!value) throw fail('请先在设置中选择 NapCat 启动文件。');
  const executablePath = selectedFile(value, stat);
  const childEnv = nativeEnvironment(env);
  const root = Object.entries(env).find(([key]) => key.toUpperCase() === 'SYSTEMROOT')?.[1] || 'C:\\Windows';
  if (!/^[a-z]:[\\/]/i.test(root) || /[\x00-\x1f<>"|?*%]/.test(root) || root.slice(2).includes(':')) throw fail('Windows 系统目录无效，无法安全打开 NapCat。');
  const commandProcessor = path.win32.join(root, 'System32', 'cmd.exe');
  childEnv.ComSpec = commandProcessor;
  const options = { cwd: path.win32.dirname(executablePath), env: childEnv, shell: false, windowsHide: false, detached: true, stdio: 'ignore' };
  if (path.win32.extname(executablePath).toLowerCase() === '.exe') return { command: executablePath, args: [], options };
  // /d disables AutoRun hooks, /v:off disables ! expansion; /s strips only the
  // outer pair of quotes. The remaining pair protects spaces, &, ^ and ().
  // Percent expansion is prohibited by validation above. No user argv exists.
  return { command: commandProcessor, args: ['/d', '/v:off', '/s', '/c', `""${executablePath}""`], options: { ...options, windowsVerbatimArguments: true } };
}

export async function openNativeNapcat(value, { spawnProcess = spawn, settleMilliseconds = 750, ...options } = {}) {
  const invocation = nativeNapcatInvocation(value, options);
  return new Promise((resolve, reject) => {
    let child, timer, finished = false;
    const finish = error => {
      if (finished) return;
      finished = true; clearTimeout(timer); child?.unref();
      if (error) reject(error);
      else resolve({ opened: true, mode: 'native', managed: false, message: '已打开所选 NapCat 程序。请在 NapCat 中登录或选择账号，再验证本账号的连接。' });
    };
    try { child = spawnProcess(invocation.command, invocation.args, invocation.options); }
    catch { return finish(fail('无法打开 NapCat 启动文件，请检查文件是否可执行。', 502)); }
    child.once('error', error => finish(fail(error.code === 'ENOENT' ? '找不到 NapCat 启动文件或 Windows 命令处理器，请重新选择启动文件。' : 'NapCat 启动失败，请检查启动文件及文件权限。', 502)));
    child.once('spawn', () => {
      if (!finished) timer = setTimeout(() => finish(), settleMilliseconds);
    });
    child.once('exit', (code, signal) => finish(code === 0 ? null : fail(`NapCat 启动程序已退出（${code ?? signal ?? '未知原因'}）。请手动运行该启动文件查看提示。`, 502)));
  });
}
