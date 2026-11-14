import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../src/store.mjs';
import { createExperienceStore } from '../src/experience-store.mjs';

const actualQQ = '111111', groupId = '222222', userId = '333333';
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-service-experiences-'));
  const store = createStore(directory), config = store.getConfig();
  config.botQQ = actualQQ;
  config.chat.enabled = true;
  config.groups = [{ id: groupId, name: '测试群', mode: 'social', read: true, send: false, social: { enabled: true } }];
  store.saveDraft(config); store.commitDraft();
  const db = new DatabaseSync(store.memoryPath);
  const experiences = createExperienceStore({ db, getState: store.getState });
  return { db, store, experiences, directory, close() { db.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}
const source = (overrides = {}) => ({ actualQQ, groupId, userId, messageId: 'human-1', role: 'user', text: '下回再聊科幻电影吧。', ...overrides });
const candidate = (overrides = {}) => ({ kind: 'pending_topic', text: '下次接着聊科幻电影。', sourceIds: ['human-1'], ...overrides });

test('经历自动积累只在已应用可读自由聊天群中生效，独立暂停不改变权限', () => {
  const f = fixture();
  try {
    f.store.conversation.record(source());
    assert.equal(f.experiences.getGroup({ actualQQ, groupId }).enabled, true);
    assert.equal(f.experiences.suggest({ actualQQ, groupId, candidates: [candidate()], sources: [source()] }).length, 1);
    assert.equal(f.store.getConfig().permissions.released, false);
    const setting = f.experiences.setGroup({ actualQQ, groupId, paused: true, version: 0 });
    assert.equal(setting.version, 1);
    assert.equal(setting.enabled, false);
    assert.deepEqual(f.experiences.relevant({ actualQQ, groupId }), []);
    assert.deepEqual(f.experiences.suggest({ actualQQ, groupId, candidates: [candidate({ text: '不能在暂停时学习' })], sources: [source()] }), []);
    assert.equal(f.experiences.list({ actualQQ, groupId }).length, 1);
    assert.throws(() => f.experiences.setGroup({ actualQQ, groupId, paused: false, version: 0 }), error => error.statusCode === 409);
    assert.throws(() => f.experiences.setGroup({ actualQQ, groupId: '999999', paused: false }), /允许读取/);
    const config = f.store.getConfig();
    config.groups[0].read = false;
    f.store.saveDraft(config); f.store.commitDraft();
    assert.deepEqual(f.experiences.relevant({ actualQQ, groupId }), []);
  } finally { f.close(); }
});

test('经历来源同时要求真实数据库证据与本轮许可，伪造、跨群和发送失败均丢弃', () => {
  const f = fixture();
  try {
    f.store.conversation.record(source());
    f.store.conversation.record(source({ groupId: '444444', messageId: 'other-group' }));
    const submit = (candidates, sources) => f.experiences.suggest({ actualQQ, groupId, candidates, sources });
    for (const sources of [[], [source({ text: '伪造原话' })], [source({ role: 'assistant' })], [source({ actualQQ: '999999' })], [source({ isNotice: true })]]) {
      assert.deepEqual(submit([candidate()], sources), []);
    }
    for (const c of [candidate({ kind: 'fact' }), candidate({ kind: 'permission' }), candidate({ sourceIds: ['not-saved'] }), candidate({ sourceIds: ['other-group'] }), candidate({ text: '长'.repeat(301) })]) {
      assert.deepEqual(submit([c], [source()]), []);
    }
    const failed = source({ messageId: 'failed-ai', role: 'assistant', userId: actualQQ, delivery: 'failed' });
    assert.equal(f.store.conversation.record(failed), false);
    assert.deepEqual(submit([candidate({ sourceIds: ['failed-ai'] })], [failed]), []);
    const assistant = source({ messageId: 'sent-ai', role: 'assistant', userId: actualQQ, delivery: 'sent', text: '好，下次聊。' });
    f.store.conversation.record(assistant);
    const [record] = submit([candidate({ sourceIds: ['human-1', 'sent-ai'] })], [source(), assistant]);
    assert.equal(record.status, 'active');
    assert.equal(record.origin, 'ai');
    assert.deepEqual(record.sources.map(item => item.role), ['user', 'assistant']);
    assert.equal(f.store.memory.list({ actualQQ }).length, 0);
  } finally { f.close(); }
});

test('候选逐条校验、每轮最多两条，重复或删除过的经历不会再次自动学习', () => {
  const f = fixture();
  try {
    f.store.conversation.record(source());
    const records = f.experiences.suggest({ actualQQ, groupId, sources: [source()], candidates: [
      candidate({ kind: 'unknown' }), candidate(), candidate({ text: '超过本轮数量的第三条' }),
    ] });
    assert.equal(records.length, 1);
    assert.deepEqual(f.experiences.suggest({ actualQQ, groupId, sources: [source()], candidates: [candidate()] }), []);
    let edited = f.experiences.mutate({ actualQQ, groupId, action: 'update', id: records[0].id, version: 1, text: '第一次修改的待续内容' });
    edited = f.experiences.mutate({ actualQQ, groupId, action: 'update', id: edited.id, version: edited.version, text: '最终修改的待续内容' });
    f.experiences.mutate({ actualQQ, groupId, action: 'delete', id: edited.id, version: edited.version });
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM experience_versions WHERE id=?').get(records[0].id).n, 0);
    assert.deepEqual(f.experiences.list({ actualQQ, groupId }), []);
    assert.deepEqual(f.experiences.suggest({ actualQQ, groupId, sources: [source()], candidates: [candidate()] }), []);
    for (const text of ['第一次修改的待续内容', '最终修改的待续内容']) assert.deepEqual(f.experiences.suggest({ actualQQ, groupId, sources: [source()], candidates: [candidate({ text })] }), []);
    assert.throws(() => f.experiences.history({ actualQQ, groupId, id: records[0].id }), error => error.statusCode === 404);
    assert.deepEqual(f.experiences.list({ actualQQ, groupId, status: 'all' }), []);
  } finally { f.close(); }
});

test('模型可见的长消息前缀仍可作为来源，保存完整证据而非伪造摘要', () => {
  const f = fixture();
  try {
    const full = source({ text: '一起讨论电影。'.repeat(700) });
    f.store.conversation.record(full);
    const [record] = f.experiences.suggest({ actualQQ, groupId, candidates: [candidate()], sources: [{ ...full, text: full.text.slice(0, 3000) }] });
    assert.equal(record.sources[0].text, full.text);
    assert.deepEqual(f.experiences.suggest({ actualQQ, groupId, candidates: [candidate({ text: '空白文本不能假冒可见来源' })], sources: [{ ...full, text: '' }] }), []);
  } finally { f.close(); }
});

test('编辑与历史回退使用单调版本，旧版本和其他群不能覆盖经历', () => {
  const f = fixture();
  try {
    let record = f.experiences.mutate({ actualQQ, groupId, action: 'create', text: '原始经历', kind: 'expression' });
    record = f.experiences.mutate({ actualQQ, groupId, action: 'update', id: record.id, version: 1, text: '修改后的经历' });
    assert.throws(() => f.experiences.mutate({ actualQQ, groupId, action: 'update', id: record.id, version: 1, text: '过期覆盖' }), error => error.statusCode === 409);
    assert.throws(() => f.experiences.history({ actualQQ, groupId: '999999', id: record.id }), error => error.statusCode === 404);
    record = f.experiences.mutate({ actualQQ, groupId, action: 'rollback', id: record.id, version: 2, targetVersion: 1 });
    assert.equal(record.version, 3);
    assert.equal(record.text, '原始经历');
    assert.equal(f.experiences.history({ actualQQ, groupId, id: record.id }).length, 3);
    assert.deepEqual(f.experiences.list({ actualQQ: '999999', groupId }), []);
    assert.deepEqual(f.experiences.list({ actualQQ, groupId: '999999' }), []);
  } finally { f.close(); }
});

test('440条活跃经历以外的旧项归档可查，并保留来源和回退历史', () => {
  const f = fixture();
  try {
    const first = f.experiences.mutate({ actualQQ, groupId, action: 'create', text: '最早的经历' });
    for (let i = 0; i < 440; i++) f.experiences.mutate({ actualQQ, groupId, action: 'create', text: `新的经历 ${i}` });
    assert.equal(f.experiences.list({ actualQQ, groupId , limit: 1000 }).length, 440);
    assert.equal(f.experiences.list({ actualQQ, groupId, status: 'all', limit: 1000 }).length, 441);
    const [archived] = f.experiences.list({ actualQQ, groupId, status: 'archived' });
    assert.equal(archived.id, first.id);
    assert.equal(archived.version, 2);
    const restored = f.experiences.mutate({ actualQQ, groupId, action: 'restore', id: archived.id, version: archived.version });
    assert.equal(restored.status, 'active');
    assert.equal(f.experiences.list({ actualQQ, groupId , limit: 1000 }).length, 440);
    assert.equal(f.experiences.history({ actualQQ, groupId, id: first.id }).length, 3);
  } finally { f.close(); }
});

test('更大的经历保存池仍能召回40条候选之外的旧相关项，返回预算不变', () => {
  const f = fixture();
  try {
    const old = f.experiences.mutate({ actualQQ, groupId, action: 'create', text: '一起讨论了天文学和流星雨。' });
    for (let index = 0; index < 60; index++) f.experiences.mutate({ actualQQ, groupId, action: 'create', text: `今天聊了别的话题 ${index}` });
    const matches = f.experiences.relevant({ actualQQ, groupId, query: '我们之前聊过流星雨吗？', limit: 100 });
    assert.equal(matches[0].id, old.id);
    assert.equal(matches.length, 8);
  } finally { f.close(); }
});

test('中文长问句能召回相关经历，最多8条，跨账号和暂停群不能注入', () => {
  const f = fixture(), other = fixture();
  try {
    const relevant = f.experiences.mutate({ actualQQ, groupId, action: 'create', text: '和群友一起聊过科幻电影的结局。' });
    for (let i = 0; i < 12; i++) f.experiences.mutate({ actualQQ, groupId, action: 'create', text: `无关的话题 ${i}` });
    const records = f.experiences.relevant({ actualQQ, groupId, query: '上次我们聊的科幻电影是什么', limit: 100 });
    assert.equal(records[0].id, relevant.id);
    assert.equal(records.length, 8);
    assert.deepEqual(other.experiences.relevant({ actualQQ, groupId }), []);
    assert.deepEqual(f.experiences.relevant({ actualQQ: '999999', groupId }), []);
  } finally { f.close(); other.close(); }
});

test('只存在手动经历的旧QQ目录在切换身份后仍可查看，但不会用于新QQ回答', () => {
  const f = fixture();
  try {
    f.experiences.mutate({ actualQQ, groupId, action: 'create', text: '主人记录的一段经历' });
    const config = f.store.getConfig();
    config.botQQ = '999999'; config.groups = [];
    f.store.saveDraft(config); f.store.commitDraft();
    assert.equal(f.store.memory.identities().includes(actualQQ), true);
    const old = f.store.memory.tree().identities.find(item => item.actualQQ === actualQQ);
    assert.equal(old.groups[0].groupId, groupId);
    assert.equal(f.experiences.list({ actualQQ, groupId }).length, 1);
    assert.deepEqual(f.experiences.relevant({ actualQQ, groupId }), []);
  } finally { f.close(); }
});

test('重启和原会话清理后保留经历的证据、版本与暂停设置，删除会移除版本正文', () => {
  const f = fixture();
  let reopened, closed = false;
  try {
    f.store.conversation.record(source());
    let [record] = f.experiences.suggest({ actualQQ, groupId, candidates: [candidate()], sources: [source()] });
    record = f.experiences.mutate({ actualQQ, groupId, action: 'update', id: record.id, version: record.version, text: '下次继续讨论科幻电影。' });
    f.experiences.setGroup({ actualQQ, groupId, paused: true, version: 0 });
    f.db.prepare('DELETE FROM conversation_messages').run();
    f.db.close(); f.store.close(); closed = true;
    reopened = createStore(f.directory);
    // Reopen through the same profile-local file, independent from the store's
    // public wiring so the persistence contract is exercised directly.
    const db = new DatabaseSync(reopened.memoryPath);
    try {
      const experiences = createExperienceStore({ db, getState: reopened.getState });
      assert.equal(experiences.list({ actualQQ, groupId })[0].sources[0].text, source().text);
      assert.equal(experiences.history({ actualQQ, groupId, id: record.id }).length, 2);
      assert.equal(experiences.getGroup({ actualQQ, groupId }).paused, true);
      assert.deepEqual(experiences.relevant({ actualQQ, groupId }), []);
      experiences.mutate({ actualQQ, groupId, action: 'delete', id: record.id, version: record.version });
      assert.equal(db.prepare('SELECT count(*) AS n FROM experience_versions').get().n, 0);
    } finally { db.close(); }
  } finally {
    if (closed) { reopened?.close(); fs.rmSync(f.directory, { recursive: true, force: true }); }
    else f.close();
  }
});
