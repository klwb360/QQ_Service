import { createHash, randomUUID } from 'node:crypto';

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const identifier = (value, label) => {
  if (typeof value !== 'string' || !/^[1-9]\d{3,19}$/.test(value)) throw fail(`${label}须为 4–20 位数字文本。`);
  return value;
};
const scope = ({ actualQQ, groupId }) => ({ actualQQ: identifier(actualQQ, '实际登录 QQ'), groupId: identifier(groupId, '群号') });
const cleanText = (value, label, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw fail(`${label}须为 1–${max} 字符的文本。`);
  return value.trim();
};
const stamp = () => new Date().toISOString();
const seconds = value => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n > 1e12 ? n / 1000 : n) : Math.floor(Date.now() / 1000);
};
const fingerprint = text => createHash('sha256').update(text.normalize('NFKC').replace(/\s+/gu, '').toLowerCase()).digest('hex');
const counts = () => ({ pending: 0, confirmed: 0, rejected: 0, total: 0 });
const fromRow = row => row ? ({
  id: row.id, actualQQ: row.actual_qq, groupId: row.group_id, userId: row.user_id,
  text: row.text, kind: row.kind, status: row.status, origin: row.origin, version: row.version,
  sources: JSON.parse(row.sources), createdAt: row.created_at, updatedAt: row.updated_at,
}) : null;

// Separate tables keep conversation and confirmed memory independent from the
// notification history's retention policy. The enclosing profile directory is
// the first isolation boundary; every query also pins actual QQ and group.
export function createMemoryStore({ db, getState }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_messages (
      actual_qq TEXT NOT NULL,group_id TEXT NOT NULL,message_id TEXT NOT NULL,user_id TEXT NOT NULL,
      role TEXT NOT NULL,text TEXT NOT NULL,time INTEGER NOT NULL,reply_to TEXT NOT NULL,
      display_name TEXT NOT NULL,delivery TEXT NOT NULL,
      PRIMARY KEY(actual_qq,group_id,message_id));
    CREATE INDEX IF NOT EXISTS conversation_scope_time ON conversation_messages(actual_qq,group_id,time);
    CREATE INDEX IF NOT EXISTS conversation_scope_member ON conversation_messages(actual_qq,group_id,user_id);
    CREATE TABLE IF NOT EXISTS memory_groups (
      actual_qq TEXT NOT NULL,group_id TEXT NOT NULL,enabled INTEGER NOT NULL,
      version INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(actual_qq,group_id));
    CREATE TABLE IF NOT EXISTS member_memories (
      id TEXT PRIMARY KEY,actual_qq TEXT NOT NULL,group_id TEXT NOT NULL,user_id TEXT NOT NULL,
      text TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,origin TEXT NOT NULL,
      version INTEGER NOT NULL,sources TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS member_memories_scope ON member_memories(actual_qq,group_id,user_id,status);
    CREATE TABLE IF NOT EXISTS memory_fingerprints (
      actual_qq TEXT NOT NULL,group_id TEXT NOT NULL,user_id TEXT NOT NULL,fingerprint TEXT NOT NULL,
      PRIMARY KEY(actual_qq,group_id,user_id,fingerprint));
  `);
  const configurations = () => {
    const state = getState();
    return [state.applied, state.draft].filter(Boolean);
  };
  const selected = (actualQQ, groupId, appliedOnly = false) => (appliedOnly ? [getState().applied] : configurations()).some(config => config?.botQQ === actualQQ && config.groups?.some(group => group.id === groupId && group.read === true));
  const identities = () => [...new Set([
    ...configurations().map(config => config.botQQ),
    ...db.prepare('SELECT DISTINCT actual_qq FROM member_memories UNION SELECT DISTINCT actual_qq FROM memory_groups UNION SELECT DISTINCT actual_qq FROM conversation_messages UNION SELECT DISTINCT account_id FROM messages').all().map(row => row.actual_qq),
  ].filter(value => typeof value === 'string' && /^[1-9]\d{3,19}$/.test(value)))];
  const getGroup = input => {
    const { actualQQ, groupId } = scope(input);
    const row = db.prepare('SELECT * FROM memory_groups WHERE actual_qq=? AND group_id=?').get(actualQQ, groupId);
    return { actualQQ, groupId, enabled: row?.enabled === 1, version: row?.version || 0, updatedAt: row?.updated_at || null };
  };
  const groups = () => {
    const entries = new Map(db.prepare('SELECT actual_qq,group_id FROM memory_groups').all().map(row => [`${row.actual_qq}:${row.group_id}`, { actualQQ: row.actual_qq, groupId: row.group_id }]));
    for (const config of configurations()) {
      if (!/^[1-9]\d{3,19}$/.test(config.botQQ || '')) continue;
      for (const group of config.groups || []) entries.set(`${config.botQQ}:${group.id}`, { actualQQ: config.botQQ, groupId: group.id });
    }
    return [...entries.values()].map(getGroup);
  };
  const list = ({ actualQQ, groupId, userId, status, query = '', limit = 500 } = {}) => {
    identifier(actualQQ, '实际登录 QQ');
    const conditions = ['actual_qq=?'], params = [actualQQ];
    if (groupId !== undefined && groupId !== '') { conditions.push('group_id=?'); params.push(identifier(groupId, '群号')); }
    if (userId !== undefined && userId !== '') { conditions.push('user_id=?'); params.push(identifier(userId, '群友 QQ')); }
    if (status && status !== 'all') {
      if (!['pending', 'confirmed', 'rejected'].includes(status)) throw fail('记忆状态无效。');
      conditions.push('status=?'); params.push(status);
    }
    if (typeof query !== 'string' || query.length > 200) throw fail('搜索词最多 200 字符。');
    if (query.trim()) {
      const pattern = `%${query.trim().replace(/[\\%_]/g, '\\$&')}%`;
      conditions.push("(text LIKE ? ESCAPE '\\' OR user_id LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM conversation_messages c WHERE c.actual_qq=member_memories.actual_qq AND c.group_id=member_memories.group_id AND c.user_id=member_memories.user_id AND c.display_name LIKE ? ESCAPE '\\'))");
      params.push(pattern, pattern, pattern);
    }
    params.push(Math.max(1, Math.min(1000, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 500)));
    return db.prepare(`SELECT * FROM member_memories WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC,id DESC LIMIT ?`).all(...params).map(fromRow);
  };
  const transaction = action => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = action(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const insert = ({ actualQQ, groupId, userId, text, kind, status, origin, sources }) => {
    const now = stamp(), recordId = randomUUID();
    return transaction(() => {
      db.prepare('INSERT INTO member_memories VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(recordId, actualQQ, groupId, userId, text, kind, status, origin, 1, JSON.stringify(sources), now, now);
      db.prepare('INSERT OR IGNORE INTO memory_fingerprints VALUES (?,?,?,?)').run(actualQQ, groupId, userId, fingerprint(text));
      return fromRow(db.prepare('SELECT * FROM member_memories WHERE id=?').get(recordId));
    });
  };
  const memory = {
    identities, list, groups, getGroup,
    setGroup(input) {
      const { actualQQ, groupId } = scope(input);
      if (typeof input.enabled !== 'boolean') throw fail('群记忆启用状态必须是开关。');
      if (input.enabled && !selected(actualQQ, groupId)) throw fail('仅能为本账号当前选定、允许读取的群启用记忆。', 409);
      const current = getGroup(input);
      db.prepare('INSERT INTO memory_groups VALUES (?,?,?,?,?) ON CONFLICT(actual_qq,group_id) DO UPDATE SET enabled=excluded.enabled,version=excluded.version,updated_at=excluded.updated_at').run(actualQQ, groupId, Number(input.enabled), current.version + 1, stamp());
      return getGroup(input);
    },
    suggest({ actualQQ, groupId, candidates = [], sources = [] }) {
      scope({ actualQQ, groupId });
      if (!getGroup({ actualQQ, groupId }).enabled || !selected(actualQQ, groupId, true)) return [];
      if (!Array.isArray(candidates) || !Array.isArray(sources)) return [];
      const sourceMap = new Map();
      for (const source of sources.slice(-100)) {
        if (!source || source.role !== 'user' || source.isNotice || source.kind === 'notice' || source.userId === actualQQ
          || (source.actualQQ !== undefined && source.actualQQ !== actualQQ) || (source.groupId !== undefined && source.groupId !== groupId)
          || typeof source.userId !== 'string' || !/^[1-9]\d{3,19}$/.test(source.userId)
          || typeof source.messageId !== 'string' || !source.messageId || source.messageId.length > 300
          || typeof source.text !== 'string' || !source.text.trim() || source.text.length > 12000) continue;
        sourceMap.set(source.messageId, source);
      }
      const added = [];
      for (const candidate of candidates.slice(0, 5)) {
        if (!candidate || !['fact', 'preference'].includes(candidate.kind) || typeof candidate.userId !== 'string'
          || !/^[1-9]\d{3,19}$/.test(candidate.userId) || candidate.userId === actualQQ
          || typeof candidate.text !== 'string' || !candidate.text.trim() || candidate.text.length > 600
          || !Array.isArray(candidate.sourceIds) || !candidate.sourceIds.length || candidate.sourceIds.length > 5) continue;
        const evidence = [...new Set(candidate.sourceIds)].map(id => sourceMap.get(id));
        if (evidence.some(source => !source || source.userId !== candidate.userId)) continue;
        if (candidate.excerpt !== undefined && (typeof candidate.excerpt !== 'string' || !candidate.excerpt.trim() || candidate.excerpt.length > 1200 || !evidence.some(source => source.text.includes(candidate.excerpt)))) continue;
        const text = candidate.text.trim(), hash = fingerprint(text);
        if (db.prepare('SELECT 1 FROM memory_fingerprints WHERE actual_qq=? AND group_id=? AND user_id=? AND fingerprint=?').get(actualQQ, groupId, candidate.userId, hash)) continue;
        const savedSources = evidence.map(source => ({ messageId: source.messageId, userId: source.userId, text: candidate.excerpt && source.text.includes(candidate.excerpt) ? candidate.excerpt : source.text, time: seconds(source.time), ...(source.displayName ? { displayName: String(source.displayName).slice(0, 80) } : {}) }));
        added.push(insert({ actualQQ, groupId, userId: candidate.userId, text, kind: candidate.kind, status: 'pending', origin: 'ai', sources: savedSources }));
      }
      return added;
    },
    relevant({ actualQQ, groupId, userIds = [], query = '', limit = 8 }) {
      scope({ actualQQ, groupId });
      if (!getGroup({ actualQQ, groupId }).enabled || !selected(actualQQ, groupId, true) || !Array.isArray(userIds) || !userIds.length) return [];
      const members = [...new Set(userIds.slice(0, 50).map(String).filter(value => /^[1-9]\d{3,19}$/.test(value) && value !== actualQQ))];
      if (!members.length) return [];
      const terms = typeof query === 'string' ? (query.toLowerCase().match(/[a-z0-9]{2,}|[\p{Script=Han}]{2,}/gu) || []).slice(0, 30) : [];
      const records = db.prepare(`SELECT * FROM member_memories WHERE actual_qq=? AND group_id=? AND status='confirmed' AND user_id IN (${members.map(() => '?').join(',')}) ORDER BY updated_at DESC,id DESC LIMIT 1000`).all(actualQQ, groupId, ...members).map(fromRow);
      return records
        .map((record, index) => ({ record, score: terms.reduce((score, term) => score + Number(record.text.toLowerCase().includes(term)), 0), index }))
        .sort((a, b) => b.score - a.score || a.index - b.index).slice(0, Math.max(1, Math.min(20, Math.floor(Number(limit) || 8)))).map(item => item.record);
    },
    mutate(input) {
      const { actualQQ, groupId } = scope(input);
      if (!['create', 'update', 'confirm', 'reject', 'delete'].includes(input.action)) throw fail('记忆操作无效。');
      if (input.action === 'create') {
        if (!selected(actualQQ, groupId)) throw fail('请先在本账号选择并允许读取这个群。', 409);
        const userId = identifier(input.userId, '群友 QQ');
        if (userId === actualQQ) throw fail('群友记忆不能以 AI 账号自身为对象。');
        const text = cleanText(input.text, '记忆内容', 600), kind = input.kind || 'fact';
        if (!['fact', 'preference'].includes(kind)) throw fail('记忆类别无效。');
        return insert({ actualQQ, groupId, userId, text, kind, status: 'confirmed', origin: 'manual', sources: [] });
      }
      if (typeof input.id !== 'string' || input.id.length > 100 || !Number.isSafeInteger(input.version) || input.version < 1) throw fail('请提供记忆标识与当前版本。');
      const current = fromRow(db.prepare('SELECT * FROM member_memories WHERE id=? AND actual_qq=? AND group_id=?').get(input.id, actualQQ, groupId));
      if (!current) throw fail('记忆不存在或不属于所选账号和群。', 404);
      if (current.version !== input.version) throw fail('记忆已被修改，请刷新后重试。', 409);
      if (input.userId !== undefined && input.userId !== current.userId) throw fail('不能修改记忆所属群友。');
      if (input.action === 'delete') {
        db.prepare('DELETE FROM member_memories WHERE id=? AND version=?').run(current.id, current.version);
        return null;
      }
      const text = input.action === 'update' ? cleanText(input.text, '记忆内容', 600) : current.text;
      const kind = input.action === 'update' ? input.kind || current.kind : current.kind;
      if (!['fact', 'preference'].includes(kind)) throw fail('记忆类别无效。');
      const status = input.action === 'confirm' ? 'confirmed' : input.action === 'reject' ? 'rejected' : current.status;
      return transaction(() => {
        db.prepare('UPDATE member_memories SET text=?,kind=?,status=?,version=version+1,updated_at=? WHERE id=? AND version=?').run(text, kind, status, stamp(), current.id, current.version);
        db.prepare('INSERT OR IGNORE INTO memory_fingerprints VALUES (?,?,?,?)').run(actualQQ, groupId, current.userId, fingerprint(text));
        return fromRow(db.prepare('SELECT * FROM member_memories WHERE id=?').get(current.id));
      });
    },
    tree() {
      const directory = new Map();
      const identity = actualQQ => {
        if (!directory.has(actualQQ)) directory.set(actualQQ, { actualQQ, name: `QQ ${actualQQ}`, groups: new Map() });
        return directory.get(actualQQ);
      };
      const group = (actualQQ, groupId, name = '') => {
        const node = identity(actualQQ);
        if (!node.groups.has(groupId)) node.groups.set(groupId, { groupId, name: name || groupId, ...getGroup({ actualQQ, groupId }), counts: counts(), members: new Map() });
        else if (name) node.groups.get(groupId).name = name;
        return node.groups.get(groupId);
      };
      const member = (node, userId, name = '') => {
        if (!node.members.has(userId)) node.members.set(userId, { userId, name: name || userId, counts: counts() });
        else if (name) node.members.get(userId).name = name;
        return node.members.get(userId);
      };
      for (const actualQQ of identities()) identity(actualQQ);
      for (const config of configurations()) {
        if (!/^[1-9]\d{3,19}$/.test(config.botQQ || '')) continue;
        for (const entry of config.groups || []) group(config.botQQ, entry.id, entry.name);
      }
      for (const entry of groups()) group(entry.actualQQ, entry.groupId);
      for (const row of db.prepare("SELECT actual_qq,group_id,user_id,display_name FROM conversation_messages WHERE role='user' GROUP BY actual_qq,group_id,user_id ORDER BY max(time)").all()) member(group(row.actual_qq, row.group_id), row.user_id, row.display_name);
      for (const row of db.prepare('SELECT actual_qq,group_id,user_id,status,count(*) AS n FROM member_memories GROUP BY actual_qq,group_id,user_id,status').all()) {
        const node = group(row.actual_qq, row.group_id), user = member(node, row.user_id);
        node.counts[row.status] += row.n; node.counts.total += row.n;
        user.counts[row.status] += row.n; user.counts.total += row.n;
      }
      return { identities: [...directory.values()].map(entry => ({ ...entry, groups: [...entry.groups.values()].map(node => ({ ...node, members: [...node.members.values()] })) })) };
    },
  };
  const conversation = {
    record(input) {
      const { actualQQ, groupId } = scope(input), userId = identifier(input.userId, '发言 QQ');
      if (!['user', 'assistant'].includes(input.role)) throw fail('会话角色无效。');
      if ((input.role === 'assistant' && userId !== actualQQ) || (input.role === 'user' && userId === actualQQ)) throw fail('会话发送身份与角色不符。');
      if (input.role === 'assistant' && input.delivery && input.delivery !== 'sent') return false;
      const messageId = cleanText(String(input.messageId || ''), '消息标识', 300), text = cleanText(input.text, '会话文字', 12000);
      const result = db.prepare('INSERT OR IGNORE INTO conversation_messages VALUES (?,?,?,?,?,?,?,?,?,?)').run(actualQQ, groupId, messageId, userId, input.role, text, seconds(input.time), typeof input.replyTo === 'string' ? input.replyTo.slice(0, 300) : '', String(input.displayName || '').slice(0, 80), input.role === 'assistant' ? 'sent' : 'received');
      db.prepare('DELETE FROM conversation_messages WHERE time < ?').run(Math.floor(Date.now() / 1000) - 30 * 86400);
      return result.changes > 0;
    },
    list({ actualQQ, groupId, limit = 24 }) {
      scope({ actualQQ, groupId });
      const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400;
      return db.prepare('SELECT actual_qq AS actualQQ,group_id AS groupId,message_id AS messageId,user_id AS userId,role,text,time,reply_to AS replyTo,display_name AS displayName,delivery FROM conversation_messages WHERE actual_qq=? AND group_id=? AND time>=? ORDER BY time DESC,rowid DESC LIMIT ?').all(actualQQ, groupId, cutoff, Math.max(1, Math.min(100, Math.floor(Number(limit) || 24)))).reverse();
    },
  };
  return { memory, conversation };
}
