import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createConversationStateStore } from '../src/conversation-state.mjs';
import { createExperienceStore } from '../src/experience-store.mjs';

const actualQQ = '111111', groupId = '222222', otherGroup = '444444', userId = '333333';
const key = { actualQQ, groupId };
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE conversation_messages (actual_qq TEXT,group_id TEXT,message_id TEXT,user_id TEXT,
    role TEXT,text TEXT,time INTEGER,display_name TEXT,delivery TEXT);`);
  let clock = Date.now();
  const config = { botQQ: actualQQ, permissions: { released: false }, groups: [{ id: groupId, read: true }, { id: otherGroup, read: true }] };
  const store = createConversationStateStore({ db, getState: () => ({ applied: config }), now: () => clock });
  const add = (overrides = {}) => {
    const row = { ...key, messageId: 'm1', userId, role: 'user', text: '继续聊星空', time: Math.floor(clock / 1000), displayName: '星星', delivery: 'received', ...overrides };
    db.prepare('INSERT INTO conversation_messages VALUES (?,?,?,?,?,?,?,?,?)').run(row.actualQQ, row.groupId, row.messageId, row.userId, row.role, row.text, row.time, row.displayName, row.delivery);
    return row;
  };
  return { db, config, store, add, advance(ms) { clock += ms; }, close() { db.close(); } };
}

test('当前会话从真实已保存消息导出参与者、话题和最后互动，按QQ及群隔离', () => {
  const f = fixture();
  try {
    const source = f.add();
    f.add({ groupId: otherGroup, messageId: 'foreign', displayName: '其他群友' });
    f.add({ actualQQ: '999999', messageId: 'other-account', userId: '555555' });
    f.add({ messageId: 'failed', role: 'assistant', userId: actualQQ, delivery: 'unknown' });
    const current = f.store.observe({ ...key, messages: [source], topic: '星空话题' });
    assert.equal(current.topic, '星空话题');
    assert.equal(current.version, 1);
    assert.equal(current.participants.length, 1);
    assert.equal(current.participants[0].displayName, '星星');
    assert.equal(current.participants[0].userId, userId);
    assert.equal(current.lastInteractionAt, new Date(source.time * 1000).toISOString());
    assert.deepEqual(f.store.get({ actualQQ: '999999', groupId }).participants, []);
    assert.equal(f.config.permissions.released, false);
  } finally { f.close(); }
});

test('伪造或跨群来源不能更新话题，未选定群不会学习会话状态', () => {
  const f = fixture();
  try {
    const source = f.add();
    let state = f.store.observe({ ...key, messages: [{ ...source, text: '伪造文字' }], topic: '伪造主题' });
    assert.equal(state.topic, '');
    state = f.store.observe({ ...key, messages: [{ ...source, groupId: otherGroup }], topic: '跨群主题' });
    assert.equal(state.topic, '');
    state = f.store.observe({ ...key, sources: [{ messageId: 'missing' }], topic: '不存在的来源' });
    assert.equal(state.topic, '');
    const unselected = '777777';
    const foreign = f.add({ groupId: unselected });
    assert.equal(f.store.observe({ actualQQ, groupId: unselected, messages: [foreign], topic: '不能学习' }).version, 0);
    assert.throws(() => f.store.setPending({ actualQQ, groupId: unselected, items: ['未授权群'] }), error => error.statusCode === 409);
    assert.throws(() => f.store.get({ actualQQ, groupId: '__proto__' }), /群号/);
  } finally { f.close(); }
});

test('临时会话两小时过期，重复观察旧消息不会无限延长，保留单调版本', () => {
  const f = fixture();
  try {
    const source = f.add();
    const first = f.store.observe({ ...key, messages: [source], topic: '旧主题' });
    f.advance(60 * 60 * 1000);
    assert.equal(f.store.observe({ ...key, messages: [source], topic: '旧主题' }).expiresAt, first.expiresAt);
    f.advance(60 * 60 * 1000 + 1000);
    const expired = f.store.get(key);
    assert.equal(expired.expired, true);
    assert.equal(expired.version, first.version);
    assert.equal(expired.topic, '');
    assert.deepEqual(expired.participants, []);
    assert.equal(f.store.observe({ ...key, messages: [source], topic: '不能续命' }).expired, true);
    const fresh = f.add({ messageId: 'new' });
    const renewed = f.store.observe({ ...key, event: fresh, topic: '新主题' });
    assert.equal(renewed.topic, '新主题');
    assert.equal(renewed.version, first.version + 1);
  } finally { f.close(); }
});

test('待续事项与清空支持CAS，清空不删除原会话或确认式记忆', () => {
  const f = fixture();
  try {
    const source = f.add();
    let state = f.store.observe({ ...key, event: source, topic: '继续讨论' });
    state = f.store.setPending({ ...key, version: state.version, items: ['明天接着聊', '明天接着聊'] });
    assert.deepEqual(state.pendingTopics, ['明天接着聊']);
    assert.throws(() => f.store.setPending({ ...key, version: 0, items: [] }), error => error.statusCode === 409);
    assert.throws(() => f.store.clear({ ...key, version: 0 }), error => error.statusCode === 409);
    state = f.store.clear({ ...key, version: state.version });
    assert.equal(state.topic, '');
    assert.deepEqual(state.pendingTopics, []);
    assert.deepEqual(state.participants, []);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM conversation_messages').get().n, 1);
    assert.equal(f.store.groups({ actualQQ })[0].version, state.version);
    assert.equal(f.store.observe({ ...key, messages: [source], topic: '旧消息不能复活' }).version, state.version);
    const fresh = f.add({ messageId: 'after-clear', text: '新的消息' });
    assert.equal(f.store.observe({ ...key, messages: [fresh], topic: '新话题' }).topic, '新话题');
  } finally { f.close(); }
});

test('清空后会话保留期删除全表、rowid重用不会挡住新消息，旧ID回放仍不会复活', () => {
  const f = fixture();
  try {
    const source = f.add({ messageId: 'cleared-original' });
    for (let index = 0; index < 10; index++) f.add({ messageId: `old-${index}` });
    const observed = f.store.observe({ ...key, messages: [source], topic: '已清空话题' });
    const cleared = f.store.clear({ ...key, version: observed.version });
    f.db.exec('DELETE FROM conversation_messages');
    const fresh = f.add({ messageId: 'new-after-retention', text: '保留期后新话题' });
    assert.equal(f.db.prepare('SELECT max(rowid) AS n FROM conversation_messages').get().n, 1);
    const renewed = f.store.observe({ ...key, messages: [fresh], topic: '新的对话' });
    assert.equal(renewed.version, cleared.version + 1);
    assert.equal(renewed.topic, '新的对话');
    f.add(source);
    assert.equal(f.store.observe({ ...key, messages: [source], topic: '旧ID不能复活' }).topic, '新的对话');
  } finally { f.close(); }
});

test('清空覆盖仍保留的330天原文，标记随原文保留期清理且过期历史不会重新入模', () => {
  const f = fixture();
  try {
    const source = f.add();
    const yesterday = f.add({ messageId: 'yesterday', time: source.time - 86400 });
    f.add({ messageId: 'beyond-retention', time: source.time - 331 * 86400 });
    f.store.clear(key);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM dialogue_cleared_sources').get().n, 2);
    assert.deepEqual(f.store.filterHistory({ ...key, messages: [yesterday, source] }), []);
    f.advance(2 * 60 * 60 * 1000 + 1000);
    f.store.observe(key);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM dialogue_cleared_sources').get().n, 2);
    f.advance(331 * 86400 * 1000);
    assert.deepEqual(f.store.filterHistory({ ...key, messages: [source, yesterday] }), []);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM dialogue_cleared_sources').get().n, 0);
  } finally { f.close(); }
});

test('精确满330天时清空标记到期也不会出现一秒的旧上下文复活窗口', () => {
  const f = fixture();
  try {
    const source = f.add();
    f.store.clear(key);
    f.advance(330 * 86400 * 1000);
    assert.deepEqual(f.store.filterHistory({ ...key, messages: [source] }), []);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM dialogue_cleared_sources').get().n, 0);
  } finally { f.close(); }
});

test('filterHistory保持输入顺序、过滤清空前上下文，允许同秒新消息并拒伪造身份和跨群来源', () => {
  const f = fixture();
  try {
    const old = f.add({ messageId: 'old' });
    const prior = f.add({ messageId: 'yesterday', time: old.time - 86400 });
    assert.deepEqual(f.store.filterHistory({ ...key, messages: [prior, old] }), [prior, old]);
    f.store.clear(key);
    const fresh = f.add({ messageId: 'fresh', text: '同秒新消息' });
    const answer = f.add({ messageId: 'reply', role: 'assistant', userId: actualQQ, delivery: 'sent', text: '这是新回复' });
    assert.equal(old.time, fresh.time);
    assert.deepEqual(f.store.filterHistory({ ...key, messages: [old, answer, prior, fresh] }), [answer, fresh]);
    assert.deepEqual(f.store.filterHistory({ ...key, messages: [
      { ...fresh, groupId: otherGroup }, { ...fresh, actualQQ: '999999' }, { ...fresh, userId: '999999' },
      { ...fresh, role: 'assistant' }, { ...fresh, text: '伪造' }, { ...fresh, text: '' }, { messageId: 'missing' },
    ] }), []);
    f.db.exec('DELETE FROM conversation_messages');
    const reused = f.add({ messageId: 'rowid-reused', text: '新行号真实消息' });
    assert.deepEqual(f.store.filterHistory({ ...key, messages: [old, reused] }), [reused]);
  } finally { f.close(); }
});

test('真实长原文的模型可见前缀可以支持话题，空串、伪前缀和身份不符继续拒绝', () => {
  const f = fixture();
  try {
    const source = f.add({ text: '星空话题。'.repeat(1800) });
    const prefix = source.text.slice(0, 3000);
    let state = f.store.observe({ ...key, messages: [{ ...source, text: prefix }], topic: '真实长文话题' });
    assert.equal(state.topic, '真实长文话题');
    for (const override of [{ text: '' }, { text: ' ' }, { text: '伪前缀' }, { userId: '999999' }, { role: 'assistant' }, { actualQQ: '999999' }, { groupId: otherGroup }]) {
      state = f.store.observe({ ...key, messages: [{ ...source, text: prefix, ...override }], topic: '不能覆盖' });
      assert.equal(state.topic, '真实长文话题');
    }
    assert.equal(f.store.observe({ ...key, event: { ...source, text: '' }, topic: '空event不可覆盖' }).topic, '真实长文话题');
    assert.equal(f.store.observe({ ...key, event: { ...source, text: prefix }, topic: '真实event前缀' }).topic, '真实event前缀');
    assert.equal(f.store.observe({ ...key, messages: [{ messageId: source.messageId }], topic: '只传已保存消息引用' }).topic, '只传已保存消息引用');
  } finally { f.close(); }
});

test('升级前仅保存在messages的真实群聊上下文可读，清空后过滤且允许同秒新legacy消息', () => {
  const f = fixture();
  try {
    f.db.exec(`CREATE TABLE messages (account_id TEXT,group_id TEXT,message_id TEXT,user_id TEXT,time INTEGER,text TEXT,mode TEXT);`);
    const time = Math.floor(Date.now() / 1000);
    const addLegacy = (overrides = {}) => {
      const row = { accountId: actualQQ, groupId, messageId: 'legacy-1', userId, time, text: '旧版本真实群内上下文', mode: 'social', role: 'user', ...overrides };
      f.db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run(row.accountId, row.groupId, row.messageId, row.userId, row.time, row.text, row.mode);
      return row;
    };
    const prior = addLegacy(), older = addLegacy({ messageId: 'yesterday-legacy', time: time - 86400 });
    const otherQQ = addLegacy({ accountId: '999999', messageId: 'other-qq' });
    const other = addLegacy({ groupId: otherGroup, messageId: 'other-group' });
    const own = addLegacy({ userId: actualQQ, messageId: 'own-legacy' });
    assert.deepEqual(f.store.filterHistory({ ...key, messages: [older, prior, otherQQ, other, own] }), [older, prior]);
    assert.deepEqual(f.store.filterHistory({ ...key, messages: [
      { ...prior, mode: 'work' }, { ...prior, accountId: '999999' }, { ...prior, role: 'assistant' },
      { ...prior, userId: '777777' }, { ...prior, text: '伪造旧上下文' }, { ...prior, messageId: 'not-in-db' },
    ] }), []);
    f.store.clear(key);
    assert.deepEqual(f.store.filterHistory({ ...key, messages: [older, prior] }), []);
    const fresh = addLegacy({ messageId: 'fresh-legacy', text: '同秒的新消息' });
    assert.equal(fresh.time, prior.time);
    assert.deepEqual(f.store.filterHistory({ ...key, messages: [prior, fresh, older] }), [fresh]);
    f.advance(2 * 60 * 60 * 1000 + 1000);
    assert.deepEqual(f.store.filterHistory({ ...key, messages: [prior, fresh, older] }), [fresh]);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM messages').get().n, 6);
  } finally { f.close(); }
});

test('自动待续仅保存经历ID，编辑、归档、暂停、删除立即反映，观察消息不会复制正文', () => {
  const f = fixture();
  try {
    f.config.chat = { enabled: true };
    f.config.groups[0].social = { enabled: true };
    const experiences = createExperienceStore({ db: f.db, getState: () => ({ applied: f.config }) });
    let note = experiences.mutate({ ...key, action: 'create', kind: 'pending_topic', text: '原先待续事项正文' });
    let current = f.store.setPending({ ...key, experienceIds: [note.id], version: 0 });
    assert.deepEqual(current.pendingExperienceIds, [note.id]);
    assert.deepEqual(current.pendingTopics, ['原先待续事项正文']);
    assert.equal(f.db.prepare('SELECT pending_topics FROM dialogue_states').get().pending_topics, '[]');
    const source = f.add();
    f.store.observe({ ...key, messages: [source], topic: '新的会话主题' });
    assert.equal(f.db.prepare('SELECT pending_topics FROM dialogue_states').get().pending_topics, '[]');
    note = experiences.mutate({ ...key, action: 'update', id: note.id, version: note.version, text: '编辑后立刻生效的事项' });
    assert.deepEqual(f.store.get(key).pendingTopics, ['编辑后立刻生效的事项']);
    note = experiences.mutate({ ...key, action: 'archive', id: note.id, version: note.version });
    assert.deepEqual(f.store.get(key).pendingTopics, []);
    note = experiences.mutate({ ...key, action: 'restore', id: note.id, version: note.version });
    assert.deepEqual(f.store.get(key).pendingTopics, ['编辑后立刻生效的事项']);
    experiences.setGroup({ ...key, paused: true });
    assert.deepEqual(f.store.get(key).pendingTopics, []);
    experiences.setGroup({ ...key, paused: false });
    assert.deepEqual(f.store.get(key).pendingTopics, ['编辑后立刻生效的事项']);
    experiences.mutate({ ...key, action: 'delete', id: note.id, version: note.version });
    assert.deepEqual(f.store.get(key).pendingTopics, []);
    assert.deepEqual(f.store.get(key).pendingExperienceIds, []);
    assert.equal(f.db.prepare('SELECT pending_topics FROM dialogue_states').get().pending_topics, '[]');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM experience_versions').get().n, 0);
  } finally { f.close(); }
});

test('会话待续引用不能跨群或引用非待续经历，自动归档和清空后不保留正文副本', () => {
  const f = fixture();
  try {
    f.config.chat = { enabled: true };
    for (const group of f.config.groups) group.social = { enabled: true };
    const experiences = createExperienceStore({ db: f.db, getState: () => ({ applied: f.config }) });
    const note = experiences.mutate({ ...key, action: 'create', kind: 'pending_topic', text: '会被归档的待续事项' });
    const other = experiences.mutate({ actualQQ, groupId: otherGroup, action: 'create', kind: 'pending_topic', text: '其他群事项' });
    const expression = experiences.mutate({ ...key, action: 'create', kind: 'expression', text: '表达经历' });
    assert.throws(() => f.store.setPending({ ...key, experienceIds: [other.id] }), error => error.statusCode === 409);
    assert.throws(() => f.store.setPending({ ...key, experienceIds: [expression.id] }), error => error.statusCode === 409);
    f.store.setPending({ ...key, experienceIds: [note.id], items: ['主人手动保留的事项'] });
    for (let index = 0; index < 440; index++) experiences.mutate({ ...key, action: 'create', kind: 'interaction', text: `后来的经历 ${index}` });
    assert.deepEqual(f.store.get(key).pendingTopics, ['主人手动保留的事项']);
    let archived = experiences.list({ ...key, status: 'archived' }).find(record => record.id === note.id);
    archived = experiences.mutate({ ...key, action: 'restore', id: archived.id, version: archived.version });
    assert.equal(f.store.get(key).pendingTopics.includes(note.text), true);
    f.store.clear(key);
    assert.deepEqual(f.store.get(key).pendingExperienceIds, []);
    assert.deepEqual(f.store.get(key).pendingTopics, []);
    const fresh = f.add({ messageId: 'after-clear-refs' });
    f.store.observe({ ...key, messages: [fresh], topic: '新的话题' });
    assert.deepEqual(f.store.get(key).pendingTopics, []);
    assert.equal(experiences.list({ ...key }).some(record => record.id === archived.id), true);
  } finally { f.close(); }
});

test('会话过期后新的真实互动不会复活旧经历引用', () => {
  const f = fixture();
  try {
    f.config.chat = { enabled: true };
    f.config.groups[0].social = { enabled: true };
    const experiences = createExperienceStore({ db: f.db, getState: () => ({ applied: f.config }) });
    const note = experiences.mutate({ ...key, action: 'create', kind: 'pending_topic', text: '旧会话中的待续话题' });
    f.store.setPending({ ...key, experienceIds: [note.id] });
    f.advance(2 * 60 * 60 * 1000 + 1000);
    assert.deepEqual(f.store.get(key).pendingExperienceIds, []);
    const fresh = f.add({ messageId: 'new-session-after-expiry' });
    f.store.observe({ ...key, messages: [fresh], topic: '新会话' });
    assert.deepEqual(f.store.get(key).pendingExperienceIds, []);
    assert.deepEqual(f.store.get(key).pendingTopics, []);
    assert.equal(experiences.list({ ...key }).length, 1);
  } finally { f.close(); }
});
