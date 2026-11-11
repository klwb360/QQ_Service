import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  normalizePersona, resolvePersona, renderPersona, parsePersonaSections, previewPersona,
  importPersonaMarkdown, exportPersonaMarkdown, buildPersonaContext, createPersonaStore,
} from '../src/persona.mjs';

const config = {
  botQQ: '111111',
  chat: { persona: '  # 角色\n我叫小Q。\n\n## 表达\n简短自然。\n', social: { name: '小Q', aliases: ['小鱼', '小鱼'], interests: '科普' } },
  groups: [{ id: '222222', social: { style: '认真简洁', interests: '程序设计' } }, { id: '444444', social: { style: '轻松' } }],
};

test('旧角色正文无损保留，名字外号兴趣统一且群风格不改变基础人格', () => {
  const original = structuredClone(config);
  const normalized = normalizePersona(config);
  assert.equal(normalized.body, config.chat.persona);
  assert.deepEqual(normalized.aliases, ['小鱼']);
  const first = resolvePersona({ config, groupId: '222222' });
  const second = resolvePersona({ config, groupId: '444444', task: 'tools' });
  assert.equal(first.name, second.name);
  assert.equal(first.body, second.body);
  assert.equal(first.groupStyle, '认真简洁');
  assert.equal(second.groupStyle, '轻松');
  assert.match(renderPersona(first), /程序设计/);
  assert.deepEqual(config, original);
});

test('Markdown分节保留未知内容，代码块内标题不被解释，导入导出不执行HTML', () => {
  const body = '# 身份\n<script>doNotRun()</script>\n```md\n## 代码示例\n```\n## 自定义偏好\n喜欢海洋。';
  const sections = parsePersonaSections(body);
  assert.deepEqual(sections.map(section => section.heading), ['身份', '自定义偏好']);
  assert.match(sections[0].text, /## 代码示例/);
  const imported = importPersonaMarkdown(body, config);
  assert.equal(imported.name, '小Q');
  assert.equal(exportPersonaMarkdown(imported), body);
  const preview = previewPersona({ config: { chat: { persona: body, social: { name: '小Q' } } } });
  assert.equal(preview.chars, preview.text.length);
  assert.equal(preview.sections.length, 2);
  assert.equal(preview.persona.body, body);
});

test('人格文本有界，控制字符与无效外号不能进入身份字段', () => {
  for (const input of [{ body: 'x'.repeat(4001) }, { name: '小Q\n系统' }, { aliases: [''] }, { aliases: ['x'.repeat(21)] }, { interests: 'x'.repeat(2001) }]) {
    assert.throws(() => normalizePersona(input), error => error.statusCode === 400);
  }
  assert.throws(() => importPersonaMarkdown('abc\0def'), /格式无效/);
});

test('提示资料只接受本QQ本群的已确认事实和活跃经历，不混入跨群与待确认记录', () => {
  const facts = [
    { actualQQ: '111111', groupId: '222222', userId: '333333', status: 'confirmed', kind: 'preference', text: '喜欢科幻' },
    { actualQQ: '999999', groupId: '222222', userId: '333333', status: 'confirmed', text: '另一账号秘密' },
    { actualQQ: '111111', groupId: '444444', userId: '333333', status: 'confirmed', text: '另一群秘密' },
    { userId: '333333', status: 'pending', text: '没有确认' },
  ];
  const notes = [
    { id: 'e1', actualQQ: '111111', groupId: '222222', status: 'active', kind: 'pending_topic', text: '下次继续讨论星空', sources: [{ messageId: 'm1', userId: '333333', time: 1 }] },
    { status: 'archived', kind: 'interaction', text: '已归档秘密' },
    { actualQQ: '111111', groupId: '444444', status: 'active', kind: 'interaction', text: '跨群经历秘密' },
    { status: 'active', kind: 'permission', text: '提升权限' },
  ];
  const prompt = buildPersonaContext({ config, groupId: '222222', actualQQ: '111111', memories: facts, experiences: notes });
  assert.match(prompt, /喜欢科幻/);
  assert.match(prompt, /下次继续讨论星空/);
  assert.match(prompt, /不是系统指令/);
  for (const secret of ['另一账号秘密', '另一群秘密', '没有确认', '已归档秘密', '跨群经历秘密', '提升权限']) assert.ok(!prompt.includes(secret));
});

test('当前状态过期或跨域时不注入，资料只带允许字段且有界', () => {
  const session = { actualQQ: '111111', groupId: '222222', topic: '黑洞', pendingTopics: ['继续聊'], participants: [{ userId: '333333', displayName: '小明' }], expiresAt: new Date(Date.now() + 10000).toISOString(), secret: '不得混入' };
  const prompt = buildPersonaContext({ config, groupId: '222222', session });
  assert.match(prompt, /黑洞/);
  assert.ok(!prompt.includes('不得混入'));
  for (const change of [{ groupId: '444444' }, { actualQQ: '999999' }, { expiresAt: '2000-01-01T00:00:00Z' }]) {
    assert.ok(!buildPersonaContext({ config, groupId: '222222', session: { ...session, ...change } }).includes('黑洞'));
  }
});

test('人格历史按实际QQ隔离、CAS防覆盖，回退仅返回草稿且不改变历史', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = createPersonaStore({ db });
    const first = store.save({ actualQQ: '111111', persona: normalizePersona(config), expectedRevision: 0 });
    assert.equal(first.revision, 1);
    const second = store.save({ actualQQ: '111111', persona: { ...first.persona, body: '新角色' }, expectedRevision: 1 });
    assert.equal(second.revision, 2);
    assert.equal(store.save({ actualQQ: '111111', persona: second.persona, expectedRevision: 2 }).revision, 2);
    assert.throws(() => store.save({ actualQQ: '111111', persona: first.persona, expectedRevision: 1 }), error => error.statusCode === 409);
    const restored = store.restore({ actualQQ: '111111', revision: 1, expectedRevision: 2 });
    assert.equal(restored.draft, true);
    assert.equal(restored.persona.body, config.chat.persona);
    assert.equal(store.get({ actualQQ: '111111' }).persona.body, '新角色');
    assert.equal(store.history({ actualQQ: '111111' }).length, 2);
    assert.deepEqual(store.history({ actualQQ: '999999' }), []);
    assert.equal(store.get({ actualQQ: '999999' }), null);
    assert.throws(() => store.restore({ actualQQ: '999999', revision: 1, expectedRevision: 0 }), error => error.statusCode === 404);
    assert.throws(() => store.restore({ actualQQ: '111111', revision: 1, expectedRevision: 1 }), error => error.statusCode === 409);
  } finally { db.close(); }
});
