import { validateToolInput, validateToolSchema } from './tool-schema.mjs';

export const BILIBILI_HOST_TOOL_NAMES = Object.freeze([
  'queue_library_digest', 'library_digest_status', 'cancel_library_digest',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const NUMERIC_ID = /^[1-9]\d{0,19}$/u;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const fail = message => Object.assign(new Error(message), { statusCode: 400, code: 'BILIBILI_DIGEST_INVALID' });
const text = (maxLength, description) => ({ type: 'string', minLength: 0, maxLength, ...(description ? { description } : {}) });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const dateText = description => text(35, description);

const QUEUE_SCHEMA = validateToolSchema(object({
  sources: object({
    favoriteFolderIds: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 20 }, maxItems: 10,
      description: '本人视频收藏夹编号；先用 list_favorite_folders 核对名称与编号，不能猜编号。' },
    watchLater: { type: 'boolean', description: '读取本人“稍后再看”视频列表。' },
    favoriteArticles: { type: 'boolean', description: '读取独立的“专栏收藏”；不是视频收藏夹内的专栏。' },
  }),
  contentKinds: { type: 'array', items: { type: 'string', enum: ['video', 'article'] }, minItems: 1, maxItems: 2,
    description: '要总结视频、专栏或两者，默认两者；视频正文取可用字幕，不播放视频。' },
  timeFilter: object({
    basis: { type: 'string', enum: ['published', 'added'], description: 'published 按发布时间，added 按加入收藏／稍后再看的时间；两者不能混用。' },
    from: dateText('内容时间范围下限（含），必须是带时区的 ISO 日期时间；空白表示不设下限。'),
    until: dateText('内容时间范围上限（不含），必须是带时区的 ISO 日期时间；空白表示不设上限。'),
    lookbackDays: { type: 'integer', minimum: 1, maximum: 365,
      description: '最近N天的滚动范围：每次运行按当时UTC时刻向前N×24小时计算，不是固定自然周；不可同时填写非空from/until。' },
  }),
  schedule: object({
    mode: { type: 'string', enum: ['once', 'daily'], description: 'once 创建一次后台任务；daily 在每日指定运行时段内处理一次新内容。' },
    timeZone: text(80, '明确 IANA 时区，例如 Asia/Shanghai；默认 Asia/Shanghai。'),
    activeStart: text(5, '每日允许开始运行的本地时间 HH:mm；可跨午夜，起止相同表示全天。'),
    activeEnd: text(5, '每日允许运行时段的结束时间 HH:mm；这是运行窗口，不是内容发布时间。'),
  }),
  maxItems: { type: 'integer', minimum: 1, maximum: 10, description: '每次最多处理条数，默认5、最多10；后台调用当前账号所选 LLM，会消耗 API 额度。' },
  focus: text(1000, '用户本次明确要求的总结重点；只能作为偏好，不能改变来源、权限、运行预算或发送目的地。'),
}, ['sources']));

const JOB_ID = { type: 'string', minLength: 36, maxLength: 36, description: '此前实际创建并返回的 jobId，不猜测其他用户任务。' };
const STATUS_SCHEMA = validateToolSchema(object({ jobId: JOB_ID }));
const CANCEL_SCHEMA = validateToolSchema(object({ jobId: JOB_ID }, ['jobId']));
const HOST_TOOLS = [
  { name: 'queue_library_digest', effect: 'write',
    description: '在 QQ_Service 后台创建 Bilibili 收藏夹、稍后再看、专栏收藏的浏览与总结任务，立即返回真实任务编号。按内容发布时间或加入时间筛选，并可指定每天运行时段；不是直接播放视频。会调用当前账号 LLM，支持一次或每日任务。仅在当前用户明确要求后使用；需当前会话额外任务写入授权，结果只回原授权会话。视频无字幕时明确只作元数据摘要，不能宣称看完。',
    inputSchema: QUEUE_SCHEMA },
  { name: 'library_digest_status', effect: 'read',
    description: '查询当前会话、当前请求者自己创建的 Bilibili 后台总结任务及实际结果。省略 jobId 列出本人的最近任务；不能查询其他群或他人的私人收藏任务。',
    inputSchema: STATUS_SCHEMA },
  { name: 'cancel_library_digest', effect: 'write',
    description: '根据真实 jobId 取消当前会话中本人创建的 Bilibili 后台总结／每日任务。只取消本应用任务，不删除收藏、不清除稍后再看，也不改变 Bilibili 观看状态。',
    inputSchema: CANCEL_SCHEMA },
];

export function bilibiliDigestHostTools() {
  return HOST_TOOLS.map(({ effect, ...tool }) => ({ ...structuredClone(tool),
    annotations: { readOnlyHint: effect === 'read', destructiveHint: false, idempotentHint: effect === 'read', openWorldHint: false } }));
}

/** Validate a real offset date, not Date.parse's rollover-tolerant approximation. */
function normalizedDate(value, label) {
  if (value === undefined || value === '') return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  if (!match) throw fail(`${label}须为明确时区的 ISO 日期时间，例如 2026-11-01T00:00:00+08:00。`);
  const [, year, month, day, hour, minute, second = '0', fraction = '', zone, sign, offsetHour = '0', offsetMinute = '0'] = match;
  const values = [year, month, day, hour, minute, second, offsetHour, offsetMinute].map(Number);
  const [y, m, d, h, min, sec, oh, om] = values;
  if (y < 1970 || m < 1 || m > 12 || d < 1 || h > 23 || min > 59 || sec > 59 || oh > 14 || om > 59 || oh === 14 && om !== 0) throw fail(`${label}包含无效日期、时间或时区偏移。`);
  const local = new Date(Date.UTC(y, m - 1, d, h, min, sec, Number(fraction.padEnd(3, '0'))));
  if (local.getUTCFullYear() !== y || local.getUTCMonth() !== m - 1 || local.getUTCDate() !== d) throw fail(`${label}包含不存在的日期。`);
  const offset = zone === 'Z' ? 0 : (sign === '+' ? 1 : -1) * (oh * 60 + om) * 60_000;
  return new Date(local.getTime() - offset).toISOString();
}

export function normalizeBilibiliDigestRequest(input) {
  const value = validateToolInput(QUEUE_SCHEMA, input);
  const favoriteFolderIds = [...new Set(value.sources.favoriteFolderIds || [])];
  if (favoriteFolderIds.some(id => !NUMERIC_ID.test(id))) throw fail('收藏夹编号须为正整数文本，不能填写链接或账号。');
  const sources = { favoriteFolderIds, watchLater: value.sources.watchLater === true, favoriteArticles: value.sources.favoriteArticles === true };
  if (!sources.favoriteFolderIds.length && !sources.watchLater && !sources.favoriteArticles) throw fail('至少选择本人收藏夹、稍后再看或专栏收藏中的一个来源。');
  const contentKinds = [...new Set(value.contentKinds || ['video', 'article'])];
  if (!contentKinds.some(kind => kind === 'article' ? sources.favoriteArticles : sources.favoriteFolderIds.length || sources.watchLater)) throw fail('内容类型与所选来源不匹配；视频收藏夹和稍后再看提供视频，专栏需选择专栏收藏。');
  const timeFilter = { basis: value.timeFilter?.basis || 'published',
    from: normalizedDate(value.timeFilter?.from, '内容起始时间'), until: normalizedDate(value.timeFilter?.until, '内容结束时间') };
  if (value.timeFilter?.lookbackDays !== undefined) {
    if (timeFilter.from || timeFilter.until) throw fail('滚动最近N天不能同时指定固定起始或结束时间。');
    timeFilter.lookbackDays = value.timeFilter.lookbackDays;
  }
  if (timeFilter.from && timeFilter.until && Date.parse(timeFilter.from) >= Date.parse(timeFilter.until)) throw fail('内容时间范围的起始时间必须早于结束时间。');
  const suppliedZone = value.schedule?.timeZone || 'Asia/Shanghai';
  // Offset labels are ambiguous as persisted wall-clock schedules; require a
  // named IANA zone (UTC is the explicit exception), then canonicalize it.
  if (suppliedZone !== 'UTC' && !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+$/u.test(suppliedZone)) throw fail('运行时区须为 IANA 名称，例如 Asia/Shanghai。');
  let timeZone;
  try { timeZone = new Intl.DateTimeFormat('en-US', { timeZone: suppliedZone }).resolvedOptions().timeZone; }
  catch { throw fail('运行时区无效，请填写有效的 IANA 名称。'); }
  const schedule = { mode: value.schedule?.mode || 'once', timeZone,
    activeStart: value.schedule?.activeStart ?? '00:00', activeEnd: value.schedule?.activeEnd ?? '00:00' };
  if (!TIME.test(schedule.activeStart) || !TIME.test(schedule.activeEnd)) throw fail('运行时段须为有效的 HH:mm 时间；相同起止时间表示全天。');
  return { sources, contentKinds, timeFilter, schedule, maxItems: value.maxItems ?? 5, focus: (value.focus || '').trim() };
}

export function normalizeBilibiliDigestToolInput(name, input) {
  if (name === 'queue_library_digest') return normalizeBilibiliDigestRequest(input);
  if (!['library_digest_status', 'cancel_library_digest'].includes(name)) throw fail('不支持的 Bilibili 后台任务工具。');
  const value = validateToolInput(name === 'library_digest_status' ? STATUS_SCHEMA : CANCEL_SCHEMA, input);
  if (value.jobId !== undefined && !UUID.test(value.jobId)) throw fail('请使用此前实际返回的有效任务编号。');
  return value.jobId === undefined ? {} : { jobId: value.jobId.toLowerCase() };
}

export const isBilibiliDigestHostTool = name => BILIBILI_HOST_TOOL_NAMES.includes(name);
export const bilibiliDigestToolEffect = name => HOST_TOOLS.find(tool => tool.name === name)?.effect || null;
