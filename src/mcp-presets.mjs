import path from 'node:path';
import { validateMcpServerConfig } from './mcp-config.mjs';

const REVIEWED_AT = '2026-11-12';
const fail = (message, code = 'MCP_PRESET_INVALID', statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const thirdPartyReview = '仅核对上游说明、安装入口和凭据约定；未完成全部源码审计、第三方安装或实号验收。';
const repository = (name, commit) => ({ repository: `https://github.com/${name}`, source: {
  url: `https://github.com/${name}/blob/${commit}/README.md`, commit, reviewedAt: REVIEWED_AT,
  scope: thirdPartyReview, fullAudit: false } });
const definitions = [
  { id: 'builtin-web-search', label: '网页搜索与正文读取', category: 'builtin', bundled: true,
    description: '用 Brave 或自设 SearXNG 搜索网页，并读取公开网页正文。', accountType: '无需聊天账号',
    entry: 'web-search-safe', envKeys: ['BRAVE_SEARCH_API_KEY', 'SEARXNG_BASE_URL'],
    credentials: [{ name: 'BRAVE_SEARCH_API_KEY', label: 'Brave Search API Key', storage: 'vault-env', required: false },
      { name: 'SEARXNG_BASE_URL', label: '自设 SearXNG 公开 HTTPS 地址', storage: 'vault-env', required: false }],
    prerequisites: ['网页读取无需密钥；联网搜索需配置 Brave Key 或可用的 SearXNG。'],
    limitations: ['只读取公开网页，不执行网页脚本；不能登录网站或操作桌面软件。', '没有搜索后端时应返回需要配置，不能伪造搜索结果。'] },
  { id: 'builtin-bilibili', label: 'Bilibili 浏览与后台整理', category: 'builtin', bundled: true,
    description: '查询视频、收藏夹、稍后再看与专栏，并创建会话范围内的后台整理任务。', accountType: '可选本人 Bilibili 登录态',
    entry: 'bilibili', envKeys: ['BILIBILI_SESSDATA'],
    credentials: [{ name: 'BILIBILI_SESSDATA', label: '本人 SESSDATA', storage: 'vault-env', required: false }],
    prerequisites: ['访问私有收藏夹或稍后再看需要本人有效登录态。'],
    limitations: ['不会自动登录或导出浏览器 Cookie。', '排入后台队列不等于完成浏览；内容范围取决于接口与原文可用性。'] },
  { id: 'builtin-notes', label: '计算与临时笔记', category: 'builtin', bundled: true,
    description: '用于验证 MCP 连接、计算及进程内临时笔记。', accountType: '无需账号', entry: 'local-notes', envKeys: [], credentials: [],
    prerequisites: ['使用本应用随附的示例服务。'], limitations: ['临时笔记不是群友长期记忆，退出服务后不保证保留。'] },
  { id: 'telegram-personal', label: 'Telegram 本人账号', category: 'messaging', bundled: false,
    ...repository('DmitryKhali/telegram-mcp', '890827e903d50cb06b49a8fcab029caa3bebdb39'),
    description: '通过 MTProto 查询本人会话、历史、搜索、回应和发送。', accountType: '本人 Telegram 用户账号，非 Bot Token',
    launchKind: 'installed-console', envKeys: ['TELEGRAM_MCP_KEYRING_SERVICE', 'SOCKS5_PROXY'],
    credentials: [{ name: 'api_id', label: 'Telegram API ID', storage: 'external-keyring', required: true },
      { name: 'api_hash', label: 'Telegram API Hash', storage: 'external-keyring', required: true },
      { name: 'session', label: '本人登录会话', storage: 'external-keyring', required: true }],
    prerequisites: ['先自行安装固定源码版本及 Python 3.10+ 依赖。', '在上游工具的系统钥匙串内配置 API ID/Hash，并自行完成 telegram-mcp-login。', '选择已安装的 telegram-mcp 绝对程序路径；各账号使用独立钥匙串命名空间。'],
    limitations: ['此预设不登录账号，不自动读取系统钥匙串，也不把 API ID/Hash 当作环境变量传入。', '连接工具不等于 QQ_Service 已接入 Telegram 实时消息监听。', '上游 confirm=true 只是参数，不能代替本应用的调用人、目标和写权限检查。', '容器需自行准备可用的私有钥匙串；不会复用宿主机登录态。'] },
  { id: 'wechat-windows', label: 'Windows 微信桌面', category: 'messaging', bundled: false,
    ...repository('RungePei/wechat-mcp', 'dfd5fac7a5f9d9e0ac4ffaa9cc52355828dfafa4'),
    description: '通过 Windows UI Automation 读取微信会话、通讯录并操作消息。', accountType: '已登录的 Windows 桌面微信',
    launchKind: 'python-module', module: 'wechat_mcp', windowsOnly: true, envKeys: [], credentials: [],
    prerequisites: ['Windows 10/11，微信桌面版 4.1.6+ 已启动并登录。', '自行安装上游及其 Python 3.10+ / pyweixin 依赖，再选择该环境的 python.exe。'],
    limitations: ['依赖可交互的 Windows 桌面，不支持 Linux/macOS 或容器自动化。', '操作窗口时不要同时手动操作微信；微信界面更新可能使定位失效。', '界面可列出工具不代表后台消息监听已经接通。', '第三方依赖的许可需单独核对；本应用不附带微信或 UIA 依赖。'] },
  { id: 'discord-bot', label: 'Discord Bot', category: 'messaging', bundled: false,
    ...repository('PaSympa/discord-mcp', '755073f49493258b593ea5e98f0046753dbe0a75'),
    description: '使用自己创建的 Bot 查询频道、发送消息与受限服务器管理。', accountType: 'Discord Bot，非本人用户账号',
    launchKind: 'node-entry', envKeys: ['DISCORD_TOKEN', 'DISCORD_ALLOWED_GUILDS', 'DISCORD_MCP_TOOLSETS', 'DISCORD_MCP_READ_ONLY'],
    credentials: [{ name: 'DISCORD_TOKEN', label: 'Discord Bot Token', storage: 'vault-env', required: true }],
    prerequisites: ['自行安装并构建固定源码版本，准备 Node.js 22+ 及其 dist/index.js。', '先在 Developer Portal 创建 Bot、邀请进服务器，并按需配置消息正文/成员 intents。', '为 DISCORD_ALLOWED_GUILDS 设置所需服务器；建议初次只开启 discovery,messages 并使用只读模式。'],
    limitations: ['上游默认暴露大量管理工具，导入预设不会替你授予这些工具。', '服务端的工具集与目标服务器限制需要独立配置，不能仅靠 QQ 群授权限制 Discord 目标。', '不能替代 Discord 用户账号，也不自动把频道消息送进 QQ_Service。'] },
  { id: 'slack-official', label: 'Slack 官方 MCP', category: 'messaging', bundled: false, needsOAuth: true,
    repository: null, source: { url: 'https://docs.slack.dev/ai/slack-mcp-server/', commit: null, reviewedAt: REVIEWED_AT,
      scope: '核对 Slack 官方 OAuth 接入说明。', fullAudit: false },
    description: '官方远程 MCP，搜索、读取或发布工作区内容。', accountType: '经 OAuth 授权的 Slack 用户',
    remoteUrl: 'https://mcp.slack.com/mcp', envKeys: [], credentials: [{ name: 'OAuth', label: 'Slack OAuth 授权', storage: 'unsupported-oauth', required: true }],
    prerequisites: ['需要 Slack 工作区批准及 OAuth 客户端授权流程。'],
    limitations: ['QQ_Service 当前 MCP 客户端未实现所需 OAuth 流程，本预设只展示说明。', '不能把静态 Bearer 输入框或普通 HTTP 服务草案冒充已支持官方 Slack 登录。'] },
  { id: 'playwright-browser', label: 'Playwright 浏览器', category: 'browser', bundled: false,
    ...repository('microsoft/playwright-mcp', '78eca85361efb545a4c0f59b6140aef0721c5412'),
    description: '通过网页可访问性结构浏览网页、填写表单与操作网站。', accountType: '独立浏览器会话，可自行登录网站',
    launchKind: 'node-entry', envKeys: [], credentials: [],
    prerequisites: ['自行安装固定版本的官方 Playwright MCP 与适用浏览器，再选择 Node.js 和已安装入口文件。'],
    limitations: ['这是浏览器自动化，不能控制桌面 QQ、Windows 微信或任意桌面程序。', '网页操作可能真实发布、提交或修改资料，需逐工具确认效果和目标范围。', '使用独立浏览器资料目录，不默认复用日常浏览器会话。', '预设不自动下载浏览器，不运行 npx latest，不声明完整站点隔离已完成。'] },
];

function availability(preset, { platform, container }) {
  if (preset.needsOAuth) return { available: false, canPrepare: false, blockedReason: '当前 MCP 客户端尚不支持所需 OAuth 登录流程。', status: 'needs-oauth' };
  if (preset.windowsOnly && (platform !== 'win32' || container)) return { available: false, canPrepare: false,
    blockedReason: '需要 Windows 10/11 可交互桌面；当前系统或容器不支持。', status: 'unsupported-platform' };
  return { available: true, canPrepare: true, blockedReason: '', status: preset.bundled ? 'bundled' : 'requires-local-installation' };
}

/** Public catalog only: it neither probes credentials nor runs installers. */
export function listMcpPresets({ platform = process.platform, container = false } = {}) {
  return definitions.map(preset => {
    const { entry, module, windowsOnly, launchKind, ...publicFields } = preset;
    return structuredClone({ ...publicFields, ...availability(preset, { platform, container }),
      needsOAuth: preset.needsOAuth === true, transport: preset.needsOAuth ? 'http' : 'stdio',
      transports: [preset.needsOAuth ? 'http' : 'stdio'], requiresLocalProgram: !preset.bundled && !preset.needsOAuth,
      installation: { automatic: false, method: preset.bundled ? 'bundled' : preset.needsOAuth ? 'oauth-required' : 'existing-local',
        note: preset.bundled ? '准备未启用的配置；不自动连接或授权。' : '先自行安装并核对固定版本，再选择本机已安装入口；本应用不下载或执行安装命令。' },
      launch: { kind: launchKind || (preset.bundled ? 'bundled-node' : 'remote-oauth'), module: module || '',
        args: module ? ['-m', module] : [], entry: entry ? `{appDir}/examples/mcp/${entry}.mjs` : '' },
      ...(!preset.source ? { source: { url: null, path: `examples/mcp/${entry}.mjs`, reviewedAt: REVIEWED_AT, scope: '应用随附服务；工具仍需逐项发现和授权。', fullAudit: false } } : {}) });
  });
}

/** Produces an ordinary disabled descriptor. Only an already-installed launch
 * selection is accepted for third parties. No spawn, fetch or filesystem read. */
export function prepareMcpPreset(id, input = {}) {
  const preset = definitions.find(item => item.id === id);
  if (!preset) throw fail('MCP 预设不存在。', 'MCP_PRESET_UNKNOWN', 404);
  const descriptors = input && typeof input === 'object' && !Array.isArray(input) ? Object.getOwnPropertyDescriptors(input) : null;
  if (!descriptors || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    || Object.getOwnPropertySymbols(input).length || Object.entries(descriptors).some(([key, value]) => !['command', 'args', 'url'].includes(key) || !Object.hasOwn(value, 'value'))) throw fail('预设只接受程序、参数和服务地址字段。');
  const state = availability(preset, { platform: process.platform, container: process.env.QQ_SERVICE_CONTAINER === '1' });
  if (!state.canPrepare) throw fail(state.blockedReason, preset.needsOAuth ? 'MCP_PRESET_OAUTH_REQUIRED' : 'MCP_PRESET_UNSUPPORTED_PLATFORM', 409);
  if (input.url) throw fail('此预设使用本机 stdio 入口；远程服务请通过普通 MCP 导入单独配置。');
  const command = input.command ?? (preset.bundled ? 'node' : '');
  const args = input.args ?? (preset.bundled ? [`{appDir}/examples/mcp/${preset.entry}.mjs`] : preset.module ? ['-m', preset.module] : []);
  if (!preset.bundled && (typeof command !== 'string' || !path.isAbsolute(command))) throw fail('请选择已安装程序的本机绝对路径；预设不会下载安装。', 'MCP_PRESET_LOCAL_PROGRAM_REQUIRED', 409);
  // Normalize nested arguments through the import validator before examining
  // them, so a direct JS caller cannot execute an array getter during prepare.
  const server = validateMcpServerConfig({ id: preset.id, label: preset.label, enabled: false, transport: 'stdio',
    command, args, url: '', envKeys: preset.envKeys, headerKeys: [], timeoutSeconds: 60, tools: [] });
  if (!preset.bundled) {
    const basename = path.basename(command).toLowerCase().replace(/\.(exe|cmd|bat)$/u, '');
    if (['npx', 'npm', 'pnpm', 'pnpx', 'yarn', 'uv', 'uvx', 'pip', 'pip3', 'pipx', 'curl', 'wget', 'powershell', 'pwsh', 'cmd', 'sh', 'bash'].includes(basename)
      || /\.(cmd|bat|ps1)$/iu.test(command)) throw fail('请选择已经安装的服务程序或 Node/Python 入口，不使用安装器、包下载命令或命令解释器。');
    if (preset.launchKind === 'node-entry' && (!server.args.length || !path.isAbsolute(server.args[0]) || !/\.(?:c?js|mjs)$/iu.test(server.args[0]))) {
      throw fail('请提供已经安装的 MCP JavaScript 入口文件绝对路径，作为启动参数第一项。', 'MCP_PRESET_ENTRY_REQUIRED', 409);
    }
    if (server.args.some(arg => /(?:@latest|^--?eval$|^-c$|^-e$)/iu.test(arg))) throw fail('预设不接受 latest 下载或内联代码执行参数。');
  }
  return server;
}
