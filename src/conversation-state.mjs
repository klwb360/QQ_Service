const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const validId = value => typeof value === 'string' && /^[1-9]\d{3,19}$/.test(value);
const HISTORY_MS = 30 * 24 * 60 * 60 * 1000;
const scope = ({ actualQQ, groupId } = {}) => {
  if (!validId(actualQQ) || !validId(groupId)) throw fail('请提供实际登录 QQ 和群号。');
  return { actualQQ, groupId };
};
const shortText = (value, label, max = 240) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw fail(`${label}须为 1–${max} 字符的文本。`);
  return value.trim();
};
const empty = ({ actualQQ, groupId }, version = 0, expired = false) => ({
  actualQQ, groupId, topic: '', pendingTopics: [], pendingExperienceIds: [], participants: [], lastInteractionAt: null,
  version, expiresAt: null, expired,
});

/** Short-lived dialogue state, separate from confirmed facts and experience notes.
 * The enclosing profile database and the actual QQ/group keys are both required.
 * Topic text remains untrusted context; this store never changes permissions.
 */
export function createConversationStateStore({ db, getState, now = () => Date.now(), ttlMs = 2 * 60 * 60 * 1000 }) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 24 * 60 * 60 * 1000) throw new TypeError('会话状态有效期无效。');
  db.exec(`CREATE TABLE IF NOT EXISTS dialogue_states (
    actual_qq TEXT NOT NULL,group_id TEXT NOT NULL,topic TEXT NOT NULL,pending_topics TEXT NOT NULL,
    participants TEXT NOT NULL,last_interaction_at TEXT,version INTEGER NOT NULL,expires_at TEXT NOT NULL,
    cleared_rowid INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(actual_qq,group_id));`);
  if (!db.prepare('PRAGMA table_info(dialogue_states)').all().some(column => column.name === 'cleared_rowid')) {
    db.exec('ALTER TABLE dialogue_states ADD COLUMN cleared_rowid INTEGER NOT NULL DEFAULT 0');
  }
  // Message IDs, rather than SQLite rowids, survive retention/VACUUM rowid reuse.
  // Keep this independent from conversation rows so a replay cannot undo clear.
  db.exec(`CREATE TABLE IF NOT EXISTS dialogue_cleared_sources (
    actual_qq TEXT NOT NULL,group_id TEXT NOT NULL,message_id TEXT NOT NULL,expires_at INTEGER NOT NULL,
    PRIMARY KEY(actual_qq,group_id,message_id));`);
  if (!db.prepare('PRAGMA table_info(dialogue_cleared_sources)').all().some(column => column.name === 'expires_at')) {
    db.exec('ALTER TABLE dialogue_cleared_sources ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0');
    db.prepare('UPDATE dialogue_cleared_sources SET expires_at=? WHERE expires_at=0').run(now() + ttlMs);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS dialogue_pending_experiences (
    actual_qq TEXT NOT NULL,group_id TEXT NOT NULL,experience_id TEXT NOT NULL,position INTEGER NOT NULL,
    PRIMARY KEY(actual_qq,group_id,experience_id));`);
  const raw = ({ actualQQ, groupId }) => db.prepare('SELECT * FROM dialogue_states WHERE actual_qq=? AND group_id=?').get(actualQQ, groupId);
  const selected = ({ actualQQ, groupId }) => {
    const config = getState().applied;
    return config?.botQQ === actualQQ && config.groups?.some(group => group.id === groupId && group.read === true);
  };
  const hasTable = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const experienceEligible = ({ actualQQ, groupId }) => {
    const config = getState().applied;
    return config?.botQQ === actualQQ && config.chat?.enabled === true
      && config.groups?.some(group => group.id === groupId && group.read === true && group.social?.enabled === true);
  };
  const pendingExperiences = key => {
    if (!experienceEligible(key) || !hasTable('experiences')) return [];
    const paused = hasTable('experience_groups') && db.prepare('SELECT paused FROM experience_groups WHERE actual_qq=? AND group_id=?').get(key.actualQQ, key.groupId)?.paused === 1;
    if (paused) return [];
    return db.prepare(`SELECT e.id,e.text FROM dialogue_pending_experiences AS r
      JOIN experiences AS e ON e.id=r.experience_id AND e.actual_qq=r.actual_qq AND e.group_id=r.group_id
      WHERE r.actual_qq=? AND r.group_id=? AND e.status='active' AND e.kind='pending_topic' ORDER BY r.position LIMIT 5`).all(key.actualQQ, key.groupId);
  };
  const clearExperienceRefs = key => db.prepare('DELETE FROM dialogue_pending_experiences WHERE actual_qq=? AND group_id=?').run(key.actualQQ, key.groupId);
  const manualTopics = (key, current) => current.expired ? [] : JSON.parse(raw(key)?.pending_topics || '[]');
  const decode = (row, key) => {
    if (!row) return empty(key);
    if (Date.parse(row.expires_at) <= now()) return empty(key, row.version, true);
    const refs = pendingExperiences(key);
    return { ...key, topic: row.topic,
      pendingTopics: [...new Set([...JSON.parse(row.pending_topics), ...refs.map(ref => ref.text.slice(0, 240))])].slice(0, 5),
      pendingExperienceIds: refs.map(ref => ref.id),
      participants: JSON.parse(row.participants), lastInteractionAt: row.last_interaction_at,
      version: row.version, expiresAt: row.expires_at, expired: false };
  };
  const get = input => { const key = scope(input); return decode(raw(key), key); };
  const checkVersion = (input, current) => {
    if (input.version !== undefined && (!Number.isSafeInteger(input.version) || input.version < 0 || input.version !== current.version)) {
      throw fail('当前会话状态已变化，请刷新后重试。', 409);
    }
  };
  const save = (key, current, next, expiresAt, clearedRowid = raw(key)?.cleared_rowid || 0) => {
    db.prepare(`INSERT INTO dialogue_states VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(actual_qq,group_id) DO UPDATE SET topic=excluded.topic,pending_topics=excluded.pending_topics,
      participants=excluded.participants,last_interaction_at=excluded.last_interaction_at,
      version=excluded.version,expires_at=excluded.expires_at,cleared_rowid=excluded.cleared_rowid`).run(key.actualQQ, key.groupId,
      next.topic, JSON.stringify(next.pendingTopics), JSON.stringify(next.participants),
      next.lastInteractionAt, current.version + 1, expiresAt, clearedRowid);
    return get(key);
  };
  const readRecent = key => {
    db.prepare('DELETE FROM dialogue_cleared_sources WHERE expires_at<=?').run(now());
    return db.prepare(`SELECT actual_qq AS actualQQ,group_id AS groupId,message_id AS messageId,
    user_id AS userId,role,text,time,display_name AS displayName,delivery
    FROM conversation_messages AS m WHERE actual_qq=? AND group_id=? AND time>=? AND time<=?
    AND NOT EXISTS (SELECT 1 FROM dialogue_cleared_sources AS c WHERE c.actual_qq=m.actual_qq
      AND c.group_id=m.group_id AND c.message_id=m.message_id)
    AND (role='user' OR (role='assistant' AND delivery='sent'))
    ORDER BY time DESC,rowid DESC LIMIT 100`).all(key.actualQQ, key.groupId, Math.floor((now() - ttlMs) / 1000), Math.floor(now() / 1000) + 60);
  };
  const matchesText = (provided, stored) => provided === undefined
    || (typeof provided === 'string' && Boolean(provided.trim()) && stored.startsWith(provided));
  // Upgraded profiles may only have the original, incoming-only messages table.
  // Do not trust a supplied legacy object without matching its stored account,
  // group, sender and mode. A read never migrates it into confirmed memory.
  const hasLegacyMessages = () => hasTable('messages');
  const filterHistory = ({ actualQQ, groupId, messages } = {}) => {
    const key = scope({ actualQQ, groupId });
    if (!Array.isArray(messages)) return [];
    db.prepare('DELETE FROM dialogue_cleared_sources WHERE expires_at<=?').run(now());
    const canonical = db.prepare(`SELECT actual_qq AS actualQQ,group_id AS groupId,message_id AS messageId,
      user_id AS userId,role,text,time,display_name AS displayName,delivery FROM conversation_messages AS m
      WHERE actual_qq=? AND group_id=? AND message_id=? AND time>? AND time<=?
      AND (role='user' OR (role='assistant' AND delivery='sent'))
      AND NOT EXISTS (SELECT 1 FROM dialogue_cleared_sources AS c WHERE c.actual_qq=m.actual_qq
        AND c.group_id=m.group_id AND c.message_id=m.message_id)`);
    const legacy = hasLegacyMessages() ? db.prepare(`SELECT account_id AS actualQQ,group_id AS groupId,message_id AS messageId,
      user_id AS userId,'user' AS role,text,time,mode FROM messages AS m
      WHERE account_id=? AND group_id=? AND message_id=? AND mode=? AND time>? AND time<=?
      AND NOT EXISTS (SELECT 1 FROM dialogue_cleared_sources AS c WHERE c.actual_qq=m.account_id
        AND c.group_id=m.group_id AND c.message_id=m.message_id)`) : null;
    return messages.filter(source => {
      if (!source || typeof source !== 'object' || typeof source.messageId !== 'string'
        || source.isNotice || source.kind === 'notice'
        || (source.actualQQ !== undefined && source.actualQQ !== key.actualQQ)
        || (source.accountId !== undefined && source.accountId !== key.actualQQ)
        || (source.groupId !== undefined && source.groupId !== key.groupId)) return false;
      const cutoff = Math.floor((now() - HISTORY_MS) / 1000), upper = Math.floor(now() / 1000) + 60;
      const row = canonical.get(key.actualQQ, key.groupId, source.messageId, cutoff, upper)
        || (legacy && ['social', 'work'].includes(source.mode) && (source.role === undefined || source.role === 'user')
          ? legacy.get(key.actualQQ, key.groupId, source.messageId, source.mode, cutoff, upper) : null);
      return Boolean(row && validId(row.userId)
        && (row.role === 'assistant' ? row.userId === key.actualQQ : row.userId !== key.actualQQ)
        && (source.role === undefined || source.role === row.role)
        && (source.userId === undefined || source.userId === row.userId) && matchesText(source.text, row.text));
    });
  };
  const verifiedSources = (input, rows, key) => {
    const canonical = new Map(rows.map(row => [row.messageId, row]));
    const candidates = Array.isArray(input.messages) ? input.messages : Array.isArray(input.sources) ? input.sources : [];
    const matches = new Set();
    for (const source of candidates.slice(-100)) {
      if (!source || typeof source !== 'object' || source.isNotice || source.kind === 'notice') continue;
      if ((source.actualQQ !== undefined && source.actualQQ !== key.actualQQ) || (source.groupId !== undefined && source.groupId !== key.groupId)) continue;
      const record = canonical.get(source.messageId);
      if (!record || (source.userId !== undefined && source.userId !== record.userId)
        || (source.role !== undefined && source.role !== record.role) || !matchesText(source.text, record.text)) continue;
      matches.add(record.messageId);
    }
    // Runtime events can provide their persisted message id without repeating text.
    if (input.event && typeof input.event === 'object') {
      const event = input.event, record = canonical.get(event.messageId);
      if (record && !event.isNotice && event.kind !== 'notice'
        && (event.actualQQ === undefined || event.actualQQ === key.actualQQ)
        && (event.groupId === undefined || event.groupId === key.groupId)
        && (event.userId === undefined || event.userId === record.userId)
        && (event.role === undefined || event.role === record.role)
        && (event.selfId === undefined || event.selfId === key.actualQQ)
        && matchesText(event.text, record.text)) matches.add(record.messageId);
    }
    return matches;
  };
  return {
    get, filterHistory,
    groups({ actualQQ } = {}) {
      if (!validId(actualQQ)) throw fail('请提供实际登录 QQ。');
      return db.prepare('SELECT group_id AS groupId FROM dialogue_states WHERE actual_qq=? ORDER BY last_interaction_at DESC').all(actualQQ).map(row => get({ actualQQ, groupId: row.groupId }));
    },
    observe(input) {
      const key = scope(input), current = get(key);
      if (!selected(key)) return current;
      const rows = readRecent(key);
      if (!rows.length) return current;
      const evidence = verifiedSources(input, rows, key);
      const participants = [];
      for (const row of rows) {
        if (!validId(row.userId) || (row.role === 'assistant' && row.userId !== key.actualQQ)
          || (row.role === 'user' && row.userId === key.actualQQ) || participants.some(item => item.userId === row.userId)) continue;
        participants.push({ userId: row.userId, displayName: String(row.displayName || '').slice(0, 80),
          role: row.role, lastSeenAt: new Date(row.time * 1000).toISOString() });
        if (participants.length >= 20) break;
      }
      const lastInteractionAt = new Date(rows[0].time * 1000).toISOString();
      const topic = evidence.size && typeof input.topic === 'string' && input.topic.trim()
        && input.topic.length <= 240 && !input.topic.includes('\0') ? input.topic.trim() : current.topic;
      const pendingTopics = manualTopics(key, current);
      const next = { topic, pendingTopics, participants, lastInteractionAt };
      const expiresAt = new Date(rows[0].time * 1000 + ttlMs).toISOString();
      if (JSON.stringify(next) === JSON.stringify({ topic: current.topic, pendingTopics,
        participants: current.participants, lastInteractionAt: current.lastInteractionAt })) return current;
      if (current.expired) clearExperienceRefs(key);
      return save(key, current, next, expiresAt);
    },
    setPending(input) {
      const key = scope(input), current = get(key);
      checkVersion(input, current);
      if (!selected(key)) throw fail('仅能为当前账号允许读取的群设置会话待续事项。', 409);
      if (input.items === undefined && input.experienceIds === undefined) throw fail('请提供待续事项或经历引用。');
      if (input.items !== undefined && (!Array.isArray(input.items) || input.items.length > 5)) throw fail('待续事项最多 5 条。');
      const pendingTopics = input.items === undefined ? manualTopics(key, current)
        : [...new Set(input.items.map(item => shortText(item, '待续事项')))];
      let refs;
      if (input.experienceIds !== undefined) {
        if (!Array.isArray(input.experienceIds) || input.experienceIds.length > 5
          || input.experienceIds.some(id => typeof id !== 'string' || !id || id.length > 100)) throw fail('经历待续引用最多 5 条，且须为有效标识。');
        refs = [...new Set(input.experienceIds)];
        if (refs.length && (!experienceEligible(key) || !hasTable('experiences'))) throw fail('当前群未启用可用的经历积累。', 409);
        if (refs.length && hasTable('experience_groups') && db.prepare('SELECT paused FROM experience_groups WHERE actual_qq=? AND group_id=?').get(key.actualQQ, key.groupId)?.paused === 1) throw fail('当前群的经历积累已暂停。', 409);
        for (const id of refs) {
          if (!db.prepare("SELECT 1 FROM experiences WHERE id=? AND actual_qq=? AND group_id=? AND status='active' AND kind='pending_topic'").get(id, key.actualQQ, key.groupId)) throw fail('待续引用必须属于当前账号、当前群的活跃待续经历。', 409);
        }
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        if (refs !== undefined || current.expired) clearExperienceRefs(key);
        for (const [position, id] of (refs || []).entries()) db.prepare('INSERT INTO dialogue_pending_experiences VALUES (?,?,?,?)').run(key.actualQQ, key.groupId, id, position);
        const result = save(key, current, { ...current, pendingTopics }, new Date(now() + ttlMs).toISOString());
        db.exec('COMMIT'); return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    clear(input) {
      const key = scope(input), current = get(key);
      checkVersion(input, current);
      const clearedRowid = db.prepare('SELECT max(rowid) AS n FROM conversation_messages WHERE actual_qq=? AND group_id=?').get(key.actualQQ, key.groupId).n || 0;
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM dialogue_cleared_sources WHERE expires_at<=?').run(now());
        db.prepare(`INSERT OR IGNORE INTO dialogue_cleared_sources
          SELECT actual_qq,group_id,message_id,max(?,min(time*1000+?,?)) FROM conversation_messages
          WHERE actual_qq=? AND group_id=? AND time>=? AND time<=?`).run(now() + ttlMs, HISTORY_MS,
          now() + HISTORY_MS, key.actualQQ, key.groupId, Math.floor((now() - HISTORY_MS) / 1000), Math.floor(now() / 1000) + 60);
        if (hasLegacyMessages()) {
          db.prepare(`INSERT OR IGNORE INTO dialogue_cleared_sources
            SELECT account_id,group_id,message_id,max(?,min(time*1000+?,?)) FROM messages
            WHERE account_id=? AND group_id=? AND mode IN ('social','work') AND time>=? AND time<=?`)
            .run(now() + ttlMs, HISTORY_MS, now() + HISTORY_MS, key.actualQQ, key.groupId,
              Math.floor((now() - HISTORY_MS) / 1000), Math.floor(now() / 1000) + 60);
        }
        clearExperienceRefs(key);
        const result = save(key, current, empty(key), new Date(now() + ttlMs).toISOString(), clearedRowid);
        db.exec('COMMIT');
        return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
}
