import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.mjs';

const actualQQ = '111111', groupId = '222222', userId = '333333';
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-service-memory-'));
  const store = createStore(directory), config = store.getConfig();
  config.botQQ = actualQQ;
  config.groups = [{ id: groupId, name: '测试群', mode: 'social', read: true, send: false }];
  store.saveDraft(config); store.commitDraft();
  return { directory, store, close() { store.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}
const source = (overrides = {}) => ({ role: 'user', actualQQ, groupId, messageId: 'm1', userId, text: '我最喜欢看科幻电影。', time: Math.floor(Date.now() / 1000), ...overrides });
const candidate = (overrides = {}) => ({ userId, text: '喜欢科幻电影', kind: 'preference', sourceIds: ['m1'], excerpt: '我最喜欢看科幻电影。', ...overrides });

test('群记忆默认关闭，必须显式启用当前选定的可读群', () => {
  const f = fixture();
  try {
    assert.equal(f.store.memory.getGroup({ actualQQ, groupId }).enabled, false);
    assert.deepEqual(f.store.memory.suggest({ actualQQ, groupId, candidates: [candidate()], sources: [source()] }), []);
    assert.throws(() => f.store.memory.setGroup({ actualQQ, groupId: '444444', enabled: true }), /允许读取/);
    f.store.memory.setGroup({ actualQQ, groupId, enabled: true });
    assert.equal(f.store.memory.getGroup({ actualQQ, groupId }).enabled, true);
    assert.equal(f.store.getConfig().permissions.released, false);
  } finally { f.close(); }
});

test('候选需本轮同一成员的真实原话，AI、通知、工具和跨域来源均不能形成记忆', () => {
  const f = fixture();
  try {
    f.store.memory.setGroup({ actualQQ, groupId, enabled: true });
    for (const overrides of [
      { role: 'assistant' }, { role: 'tool' }, { role: undefined }, { isNotice: true },
      { actualQQ: '999999' }, { groupId: '999999' }, { userId: actualQQ }, { userId: '444444' },
    ]) assert.deepEqual(f.store.memory.suggest({ actualQQ, groupId, candidates: [candidate()], sources: [source(overrides)] }), []);
    for (const overrides of [{ sourceIds: ['missing'] }, { excerpt: '从未说过的原文' }, { kind: 'personality' }, { userId: actualQQ }]) {
      assert.deepEqual(f.store.memory.suggest({ actualQQ, groupId, candidates: [candidate(overrides)], sources: [source()] }), []);
    }
    const added = f.store.memory.suggest({ actualQQ, groupId, candidates: [candidate()], sources: [source()] });
    assert.equal(added.length, 1);
    assert.equal(added[0].status, 'pending');
    assert.equal(added[0].sources[0].text, source().text);
    assert.deepEqual(f.store.memory.relevant({ actualQQ, groupId, userIds: [userId] }), []);
  } finally { f.close(); }
});

test('只有确认记忆参与回答，版本冲突不会覆盖修改，拒绝或删除后不重复提出同一候选', () => {
  const f = fixture();
  try {
    f.store.memory.setGroup({ actualQQ, groupId, enabled: true });
    let [record] = f.store.memory.suggest({ actualQQ, groupId, candidates: [candidate()], sources: [source()] });
    record = f.store.memory.mutate({ action: 'confirm', id: record.id, version: 1, actualQQ, groupId });
    assert.equal(record.version, 2);
    assert.equal(f.store.memory.relevant({ actualQQ, groupId, userIds: [userId] }).length, 1);
    assert.deepEqual(f.store.memory.relevant({ actualQQ, groupId, userIds: ['888888'] }), []);
    assert.throws(() => f.store.memory.mutate({ action: 'update', id: record.id, version: 1, actualQQ, groupId, text: '新内容' }), error => error.statusCode === 409);
    assert.throws(() => f.store.memory.mutate({ action: 'confirm', id: record.id, version: 2, actualQQ, groupId: '888888' }), error => error.statusCode === 404);
    record = f.store.memory.mutate({ action: 'reject', id: record.id, version: 2, actualQQ, groupId });
    assert.deepEqual(f.store.memory.relevant({ actualQQ, groupId, userIds: [userId] }), []);
    assert.deepEqual(f.store.memory.suggest({ actualQQ, groupId, candidates: [candidate()], sources: [source()] }), []);
    f.store.memory.mutate({ action: 'delete', id: record.id, version: record.version, actualQQ, groupId });
    assert.deepEqual(f.store.memory.suggest({ actualQQ, groupId, candidates: [candidate()], sources: [source()] }), []);
  } finally { f.close(); }
});

test('暂停保留记录但停止使用和学习，通知清理及应用重启保留已确认记忆与证据', () => {
  const f = fixture();
  let reopened;
  try {
    f.store.memory.setGroup({ actualQQ, groupId, enabled: true });
    let [record] = f.store.memory.suggest({ actualQQ, groupId, candidates: [candidate()], sources: [source({ time: 1000 })] });
    record = f.store.memory.mutate({ action: 'confirm', id: record.id, version: 1, actualQQ, groupId });
    f.store.memory.setGroup({ actualQQ, groupId, enabled: false });
    assert.equal(f.store.memory.list({ actualQQ }).length, 1);
    assert.deepEqual(f.store.memory.relevant({ actualQQ, groupId, userIds: [userId] }), []);
    f.store.recordMessage({ accountId: actualQQ, groupId, userId, messageId: 'old', text: '过期通知', time: 1000, mode: 'work' });
    f.store.getSummaries();
    f.store.close();
    reopened = createStore(f.directory);
    const persisted = reopened.memory.list({ actualQQ });
    assert.equal(persisted[0].status, 'confirmed');
    assert.equal(persisted[0].sources[0].text, source().text);
    assert.equal(reopened.memory.getGroup({ actualQQ, groupId }).enabled, false);
    reopened.memory.setGroup({ actualQQ, groupId, enabled: true });
    assert.equal(reopened.memory.relevant({ actualQQ, groupId, userIds: [userId] }).length, 1);
  } finally { reopened?.close(); fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('目录可从空记忆构建，按实际 QQ、群、成员隔离，手动记忆可直接确认', () => {
  const f = fixture(), other = fixture();
  try {
    let tree = f.store.memory.tree();
    assert.equal(tree.identities[0].actualQQ, actualQQ);
    assert.equal(tree.identities[0].groups[0].name, '测试群');
    assert.deepEqual(tree.identities[0].groups[0].members, []);
    const record = f.store.memory.mutate({ action: 'create', actualQQ, groupId, userId, text: '主人手动填写的偏好', kind: 'preference' });
    assert.equal(record.status, 'confirmed');
    assert.equal(record.origin, 'manual');
    assert.deepEqual(record.sources, []);
    tree = f.store.memory.tree();
    assert.equal(tree.identities[0].groups[0].members[0].userId, userId);
    assert.equal(tree.identities[0].groups[0].counts.confirmed, 1);
    assert.deepEqual(f.store.memory.list({ actualQQ: '999999' }), []);
    assert.deepEqual(f.store.memory.list({ actualQQ, groupId: '999999' }), []);
    assert.deepEqual(other.store.memory.list({ actualQQ }), []);
  } finally { f.close(); other.close(); }
});

test('双向会话按身份和群保存、去重，失败回复不进入上下文，且独立于通知保留期', () => {
  const f = fixture();
  try {
    const human = { actualQQ, groupId, userId, role: 'user', text: '大家在聊什么', messageId: 'in-1', displayName: '群友', time: Math.floor(Date.now() / 1000) - 10 * 86400 };
    assert.equal(f.store.conversation.record(human), true);
    assert.equal(f.store.conversation.record(human), false);
    f.store.conversation.record({ ...human, messageId: 'out-1', userId: actualQQ, role: 'assistant', text: '在聊电影', replyTo: 'in-1', delivery: 'sent' });
    assert.equal(f.store.conversation.record({ ...human, messageId: 'out-failed', userId: actualQQ, role: 'assistant', delivery: 'unknown' }), false);
    f.store.getSummaries();
    const messages = f.store.conversation.list({ actualQQ, groupId });
    assert.equal(messages.length, 2);
    assert.deepEqual(messages.map(message => message.role), ['user', 'assistant']);
    assert.equal(messages[1].replyTo, 'in-1');
    assert.deepEqual(f.store.conversation.list({ actualQQ: '999999', groupId }), []);
    assert.deepEqual(f.store.conversation.list({ actualQQ, groupId: '999999' }), []);
    assert.throws(() => f.store.conversation.record({ ...human, userId: actualQQ }), /身份/);
    assert.equal(f.store.memory.tree().identities[0].groups[0].members[0].name, '群友');
  } finally { f.close(); }
});

test('长消息末尾的候选保留可审核证据，未应用的读取选择不进入模型记忆', () => {
  const f = fixture();
  try {
    f.store.memory.setGroup({ actualQQ, groupId, enabled: true });
    const text = '前文。'.repeat(600) + '我最喜欢看科幻电影。';
    const withoutExcerpt = candidate(); delete withoutExcerpt.excerpt;
    const [record] = f.store.memory.suggest({ actualQQ, groupId, candidates: [withoutExcerpt], sources: [source({ text })] });
    assert.equal(record.sources[0].text, text);
    const config = f.store.getConfig();
    config.groups.push({ id: '444444', mode: 'social', read: true, send: false });
    f.store.saveDraft(config);
    f.store.memory.setGroup({ actualQQ, groupId: '444444', enabled: true });
    f.store.memory.mutate({ action: 'create', actualQQ, groupId: '444444', userId, text: '尚未应用的群记忆' });
    assert.deepEqual(f.store.memory.relevant({ actualQQ, groupId: '444444', userIds: [userId] }), []);
    assert.deepEqual(f.store.memory.suggest({ actualQQ, groupId: '444444', candidates: [candidate()], sources: [source({ groupId: '444444' })] }), []);
  } finally { f.close(); }
});

test('按相关成员先筛选再限额，大群超过1000条新记忆不挤掉老成员事实', () => {
  const f = fixture();
  try {
    f.store.memory.setGroup({ actualQQ, groupId, enabled: true });
    const old = f.store.memory.mutate({ action: 'create', actualQQ, groupId, userId, text: '喜欢天文纪录片', kind: 'preference' });
    for (let index = 0; index < 1001; index++) f.store.memory.mutate({ action: 'create', actualQQ, groupId, userId: '444444', text: `其他成员的新事实 ${index}` });
    assert.equal(f.store.memory.list({ actualQQ, groupId }).length, 500);
    assert.equal(f.store.memory.list({ actualQQ, groupId, userId }).length, 1);
    const recalled = f.store.memory.relevant({ actualQQ, groupId, userIds: [userId], query: '天文' });
    assert.equal(recalled.length, 1);
    assert.equal(recalled[0].id, old.id);
    const directory = f.store.memory.tree().identities[0].groups[0];
    assert.equal(directory.members.find(member => member.userId === userId).counts.confirmed, 1);
    assert.equal(directory.members.find(member => member.userId === '444444').counts.confirmed, 1001);
  } finally { f.close(); }
});

test('服务端可用群友现有昵称搜索，百分号和下划线按普通文本匹配', () => {
  const f = fixture();
  try {
    f.store.conversation.record({ actualQQ, groupId, userId, messageId: 'named', role: 'user', text: '在聊电影', displayName: '星空群友' });
    const record = f.store.memory.mutate({ action: 'create', actualQQ, groupId, userId, text: '喜欢电影，进度 50%_完成' });
    assert.equal(f.store.memory.list({ actualQQ, groupId, query: '星空' })[0].id, record.id);
    assert.equal(f.store.memory.list({ actualQQ, query: '%_' })[0].id, record.id);
    assert.deepEqual(f.store.memory.list({ actualQQ, query: '不存在_' }), []);
    assert.deepEqual(f.store.memory.list({ actualQQ, groupId: '888888', query: '星空' }), []);
  } finally { f.close(); }
});
