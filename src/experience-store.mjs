import { createHash, randomUUID } from 'node:crypto';
import { memorySearchTerms } from './memory-store.mjs';

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const validId = value => typeof value === 'string' && /^[1-9]\d{3,19}$/.test(value);
const kinds = new Set(['interaction', 'expression', 'pending_topic']);
const statuses = new Set(['active', 'archived']);
const normalize = text => String(text).normalize('NFKC').toLowerCase();
const fingerprint = (kind, text) => createHash('sha256').update(`${kind}\0${normalize(text).replace(/\s+/gu, '')}`).digest('hex');
const stamp = () => new Date().toISOString();
const scope = input => {
  if (!input || !validId(input.actualQQ) || !validId(input.groupId)) throw fail('请提供有效的实际 QQ 和群号。');
  return { actualQQ: input.actualQQ, groupId: input.groupId };
};
const cleanText = text => {
  if (typeof text !== 'string' || !text.trim() || text.length > 300 || text.includes('\0')) throw fail('经历内容须为 1–300 字符。');
  return text.trim();
};
const fromRow = row => row ? ({ id: row.id, actualQQ: row.actual_qq, groupId: row.group_id,
  kind: row.kind, text: row.text, status: row.status, origin: row.origin, version: row.version,
  sources: JSON.parse(row.sources), createdAt: row.created_at, updatedAt: row.updated_at }) : null;

/** Profile-local, sourced experiences. These are untrusted conversation data,
 * never account configuration, permissions, or confirmed member facts. */
export function createExperienceStore({ db, getState }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS experience_groups (
      actual_qq TEXT NOT NULL,group_id TEXT NOT NULL,paused INTEGER NOT NULL,
      version INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(actual_qq,group_id));
    CREATE TABLE IF NOT EXISTS experiences (
      id TEXT PRIMARY KEY,actual_qq TEXT NOT NULL,group_id TEXT NOT NULL,kind TEXT NOT NULL,
      text TEXT NOT NULL,status TEXT NOT NULL,origin TEXT NOT NULL,version INTEGER NOT NULL,
      sources TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS experiences_scope ON experiences(actual_qq,group_id,status,updated_at);
    CREATE TABLE IF NOT EXISTS experience_versions (
      id TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(id,version));
    CREATE TABLE IF NOT EXISTS experience_fingerprints (
      actual_qq TEXT NOT NULL,group_id TEXT NOT NULL,fingerprint TEXT NOT NULL,
      PRIMARY KEY(actual_qq,group_id,fingerprint));
  `);
  const configuration = () => getState().applied;
  const selected = (actualQQ, groupId) => {
    const config = configuration();
    return config?.botQQ === actualQQ && config.groups?.some(group => group.id === groupId && group.read === true);
  };
  const eligible = (actualQQ, groupId) => {
    const config = configuration();
    return config?.botQQ === actualQQ && config.chat?.enabled === true
      && config.groups?.some(group => group.id === groupId && group.read === true && group.social?.enabled === true);
  };
  const getGroup = input => {
    const { actualQQ, groupId } = scope(input);
    const row = db.prepare('SELECT * FROM experience_groups WHERE actual_qq=? AND group_id=?').get(actualQQ, groupId);
    const available = eligible(actualQQ, groupId);
    return { actualQQ, groupId, paused: row?.paused === 1, enabled: available && row?.paused !== 1,
      eligible: available, version: row?.version || 0, updatedAt: row?.updated_at || null };
  };
  const transaction = action => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = action(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const load = (actualQQ, groupId, id) => fromRow(db.prepare('SELECT * FROM experiences WHERE id=? AND actual_qq=? AND group_id=?').get(id, actualQQ, groupId));
  const saveVersion = record => db.prepare('INSERT INTO experience_versions VALUES (?,?,?)').run(record.id, record.version, JSON.stringify(record));
  const update = (record, changes) => {
    const next = { ...record, ...changes, version: record.version + 1, updatedAt: stamp() };
    db.prepare('UPDATE experiences SET kind=?,text=?,status=?,version=?,sources=?,updated_at=? WHERE id=? AND version=?')
      .run(next.kind, next.text, next.status, next.version, JSON.stringify(next.sources), next.updatedAt, record.id, record.version);
    saveVersion(next);
    db.prepare('INSERT OR IGNORE INTO experience_fingerprints VALUES (?,?,?)').run(next.actualQQ, next.groupId, fingerprint(next.kind, next.text));
    return next;
  };
  const capActive = (actualQQ, groupId) => {
    const stale = db.prepare("SELECT * FROM experiences WHERE actual_qq=? AND group_id=? AND status='active' ORDER BY updated_at DESC,rowid DESC LIMIT -1 OFFSET 40").all(actualQQ, groupId);
    for (const row of stale) update(fromRow(row), { status: 'archived' });
  };
  const insert = ({ actualQQ, groupId, kind, text, origin, sources }) => {
    const now = stamp(), record = { id: randomUUID(), actualQQ, groupId, kind, text, status: 'active', origin, version: 1, sources, createdAt: now, updatedAt: now };
    db.prepare('INSERT INTO experiences VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(record.id, actualQQ, groupId, kind, text, 'active', origin, 1, JSON.stringify(sources), now, now);
    saveVersion(record);
    db.prepare('INSERT OR IGNORE INTO experience_fingerprints VALUES (?,?,?)').run(actualQQ, groupId, fingerprint(kind, text));
    capActive(actualQQ, groupId);
    return record;
  };
  const list = ({ actualQQ, groupId, status = 'active', query = '', limit = 200 } = {}) => {
    scope({ actualQQ, groupId });
    if (status !== 'all' && !statuses.has(status)) throw fail('经历状态无效。');
    if (typeof query !== 'string' || query.length > 200) throw fail('经历搜索词最多 200 字符。');
    const args = [actualQQ, groupId], filters = ['actual_qq=?', 'group_id=?'];
    if (status !== 'all') { filters.push('status=?'); args.push(status); }
    if (query.trim()) { filters.push("text LIKE ? ESCAPE '\\'"); args.push(`%${query.trim().replace(/[\\%_]/g, '\\$&')}%`); }
    args.push(Math.max(1, Math.min(1000, Math.floor(Number(limit) || 200))));
    return db.prepare(`SELECT * FROM experiences WHERE ${filters.join(' AND ')} ORDER BY updated_at DESC,rowid DESC LIMIT ?`).all(...args).map(fromRow);
  };
  return {
    getGroup, list,
    groups({ actualQQ } = {}) {
      if (actualQQ !== undefined && !validId(actualQQ)) throw fail('实际 QQ 无效。');
      const entries = new Map();
      const add = (qq, groupId) => { if (!actualQQ || qq === actualQQ) entries.set(`${qq}:${groupId}`, { actualQQ: qq, groupId }); };
      const config = configuration();
      if (validId(config?.botQQ)) for (const group of config.groups || []) if (validId(group.id)) add(config.botQQ, group.id);
      for (const row of db.prepare('SELECT actual_qq,group_id FROM experience_groups UNION SELECT actual_qq,group_id FROM experiences').all()) add(row.actual_qq, row.group_id);
      return [...entries.values()].map(getGroup);
    },
    setGroup(input) {
      const { actualQQ, groupId } = scope(input), current = getGroup(input);
      if (typeof input.paused !== 'boolean') throw fail('请提供经历积累暂停开关。');
      if (!selected(actualQQ, groupId)) throw fail('仅能设置本账号已应用、允许读取的群。', 409);
      if (input.version !== undefined && input.version !== current.version) throw fail('经历设置已变化，请刷新后重试。', 409);
      db.prepare('INSERT INTO experience_groups VALUES (?,?,?,?,?) ON CONFLICT(actual_qq,group_id) DO UPDATE SET paused=excluded.paused,version=excluded.version,updated_at=excluded.updated_at')
        .run(actualQQ, groupId, Number(input.paused), current.version + 1, stamp());
      return getGroup(input);
    },
    suggest({ actualQQ, groupId, candidates = [], sources = [] } = {}) {
      scope({ actualQQ, groupId });
      if (!getGroup({ actualQQ, groupId }).enabled || !Array.isArray(candidates) || !Array.isArray(sources)) return [];
      const evidence = new Map();
      for (const source of sources.slice(-100)) {
        if (!source || typeof source.messageId !== 'string' || !source.messageId || source.messageId.length > 300
          || source.isNotice || source.kind === 'notice' || (source.actualQQ !== undefined && source.actualQQ !== actualQQ)
          || (source.groupId !== undefined && source.groupId !== groupId)) continue;
        const row = db.prepare('SELECT * FROM conversation_messages WHERE actual_qq=? AND group_id=? AND message_id=?').get(actualQQ, groupId, source.messageId);
        if (!row || !['user', 'assistant'].includes(row.role) || (row.role === 'assistant' && (row.delivery !== 'sent' || row.user_id !== actualQQ))
          || (row.role === 'user' && row.user_id === actualQQ) || (source.role !== undefined && source.role !== row.role)
          || (source.userId !== undefined && source.userId !== row.user_id)
          || (source.text !== undefined && (typeof source.text !== 'string' || !source.text || !row.text.startsWith(source.text)))) continue;
        evidence.set(source.messageId, { messageId: row.message_id, userId: row.user_id, role: row.role,
          text: row.text, time: row.time, ...(row.display_name ? { displayName: row.display_name } : {}) });
      }
      const added = [];
      transaction(() => {
        for (const candidate of candidates.slice(0, 2)) {
          if (!candidate || !kinds.has(candidate.kind) || typeof candidate.text !== 'string' || !candidate.text.trim()
            || candidate.text.length > 300 || candidate.text.includes('\0') || !Array.isArray(candidate.sourceIds)
            || !candidate.sourceIds.length || candidate.sourceIds.length > 5 || candidate.sourceIds.some(id => typeof id !== 'string' || !evidence.has(id))) continue;
          const text = candidate.text.trim();
          if (db.prepare('SELECT 1 FROM experience_fingerprints WHERE actual_qq=? AND group_id=? AND fingerprint=?').get(actualQQ, groupId, fingerprint(candidate.kind, text))) continue;
          added.push(insert({ actualQQ, groupId, kind: candidate.kind, text, origin: 'ai', sources: [...new Set(candidate.sourceIds)].map(id => evidence.get(id)) }));
        }
      });
      return added;
    },
    relevant({ actualQQ, groupId, query = '', limit = 8 } = {}) {
      scope({ actualQQ, groupId });
      if (!getGroup({ actualQQ, groupId }).enabled) return [];
      const terms = memorySearchTerms(query);
      return list({ actualQQ, groupId, limit: 40 }).map((record, index) => ({ record, index,
        score: terms.reduce((score, term) => score + Number(normalize(record.text).includes(term)), 0) + Number(record.kind === 'pending_topic') * 0.1 }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, Math.max(1, Math.min(8, Math.floor(Number(limit) || 8)))).map(item => item.record);
    },
    history(input) {
      const { actualQQ, groupId } = scope(input);
      if (typeof input.id !== 'string' || !load(actualQQ, groupId, input.id)) throw fail('经历不存在或不属于当前账号和群。', 404);
      return db.prepare('SELECT payload FROM experience_versions WHERE id=? ORDER BY version DESC').all(input.id).map(row => JSON.parse(row.payload));
    },
    mutate(input) {
      const { actualQQ, groupId } = scope(input);
      if (!['create', 'update', 'archive', 'restore', 'delete', 'rollback'].includes(input.action)) throw fail('经历操作无效。');
      if (input.action === 'create') {
        if (!selected(actualQQ, groupId)) throw fail('请先应用本账号的群读取权限。', 409);
        const kind = input.kind || 'interaction', text = cleanText(input.text);
        if (!kinds.has(kind)) throw fail('经历类别无效。');
        return transaction(() => insert({ actualQQ, groupId, kind, text, origin: 'manual', sources: [] }));
      }
      if (typeof input.id !== 'string' || input.id.length > 100 || !Number.isSafeInteger(input.version) || input.version < 1) throw fail('请提供经历标识和当前版本。');
      const current = load(actualQQ, groupId, input.id);
      if (!current) throw fail('经历不存在或不属于当前账号和群。', 404);
      if (current.version !== input.version) throw fail('经历已被修改，请刷新后重试。', 409);
      if (input.action === 'delete') {
        // Forget means remove the text and every historical/source snapshot.
        // Only a one-way fingerprint remains to avoid relearning the same note.
        return transaction(() => {
          const versions = db.prepare('SELECT payload FROM experience_versions WHERE id=?').all(current.id).map(row => JSON.parse(row.payload));
          const remember = db.prepare('INSERT OR IGNORE INTO experience_fingerprints VALUES (?,?,?)');
          for (const record of [...versions, current]) remember.run(actualQQ, groupId, fingerprint(record.kind, record.text));
          db.prepare('DELETE FROM experience_versions WHERE id=?').run(current.id);
          db.prepare('DELETE FROM experiences WHERE id=? AND version=?').run(current.id, current.version);
          return null;
        });
      }
      let changes;
      if (input.action === 'update') {
        const kind = input.kind || current.kind;
        if (!kinds.has(kind)) throw fail('经历类别无效。');
        changes = { text: cleanText(input.text), kind };
      } else if (input.action === 'rollback') {
        if (!Number.isSafeInteger(input.targetVersion) || input.targetVersion < 1) throw fail('请提供需要回退的版本。');
        const row = db.prepare('SELECT payload FROM experience_versions WHERE id=? AND version=?').get(current.id, input.targetVersion);
        if (!row) throw fail('经历历史版本不存在。', 404);
        const previous = JSON.parse(row.payload);
        changes = { kind: previous.kind, text: previous.text, status: previous.status, sources: previous.sources };
      } else changes = { status: input.action === 'archive' ? 'archived' : 'active' };
      return transaction(() => {
        const next = update(current, changes);
        capActive(actualQQ, groupId);
        return load(actualQQ, groupId, next.id);
      });
    },
  };
}
