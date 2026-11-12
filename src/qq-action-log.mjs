import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const statuses = new Set(['checking', 'running', 'succeeded', 'denied', 'cancelled', 'unknown', 'failed']);
const cleanId = value => typeof value === 'string' && /^[A-Za-z0-9_:./-]{1,180}$/u.test(value) ? value : '';
const qq = value => typeof value === 'string' && /^[1-9]\d{3,19}$/u.test(value) ? value : '';
const ids = values => [...new Set((Array.isArray(values) ? values : []).map(cleanId).filter(Boolean))].slice(0, 12);
const valid = input => input && qq(input.actualQQ) && qq(input.groupId) && statuses.has(input.status)
  && typeof input.id === 'string' && input.id.length > 0 && input.id.length <= 200 && /^qq:[a-z_]+$/u.test(input.tool || '');
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/u.test(value) && Number.isFinite(Date.parse(value)) ? value : '';
const facts = input => ({ id: input.id, actualQQ: input.actualQQ, groupId: input.groupId,
  requesterQQ: qq(input.requesterQQ), tool: input.tool, status: input.status,
  executed: input.executed === true ? true : input.executed === false ? false : null,
  userIds: ids(input.userIds).filter(qq), messageIds: ids(input.messageIds), assetId: cleanId(input.assetId),
  code: cleanId(input.code) });

/** Owner-facing action facts, never prompts, paths, media bytes or secrets. */
export function createQqActionLog({ dataDir, now = () => new Date() }) {
  const file = path.join(dataDir, 'qq-actions.json');
  let rows = [];
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error('QQ 动作记录文件无效，请保留文件检查。');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(value) || value.length > 1000 || value.some(row => !valid(row) || !timestamp(row.createdAt) || !timestamp(row.updatedAt))
      || new Set(value.map(row => row.id)).size !== value.length) throw new Error('QQ 动作记录格式损坏，请保留文件检查。');
    rows = value.map(row => ({ ...facts(row), createdAt: row.createdAt, updatedAt: row.updatedAt }));
  }
  const record = input => {
    if (!valid(input)) throw new Error('QQ 动作记录参数无效。');
    const previous = rows.find(row => row.id === input.id);
    if (previous && (previous.actualQQ !== input.actualQQ || previous.groupId !== input.groupId || previous.tool !== input.tool)) throw new Error('QQ 动作记录不能更改原账号、群或工具。');
    const at = now().toISOString();
    const item = { ...facts(input), createdAt: previous?.createdAt || at, updatedAt: at };
    const next = [item, ...rows.filter(row => row.id !== item.id)].slice(0, 1000);
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, `${JSON.stringify(next)}\n`, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); }
    finally { fs.rmSync(temporary, { force: true }); }
    rows = next;
    return structuredClone(item);
  };
  return { record, list({ actualQQ, groupId, limit = 50 } = {}) {
    return rows.filter(row => (!actualQQ || row.actualQQ === actualQQ) && (!groupId || row.groupId === groupId))
      .slice(0, Math.max(1, Math.min(100, Number(limit) || 50))).map(row => structuredClone(row));
  } };
}
