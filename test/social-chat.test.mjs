import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, DEFAULT_CHAT_SOCIAL, DEFAULT_GROUP_SOCIAL, GROUP_TRIGGER_IDS, validateConfig, effectiveGroupTriggers } from '../src/config.mjs';
import { parseSocialDecision, socialSystemPrompt, isActiveTime, matchSocialAddress } from '../src/social-chat.mjs';

const config = () => ({ ...structuredClone(DEFAULT_CONFIG), groups: [{ id: '222222', mode: 'social', read: true, send: false }] });
const reply = fields => JSON.stringify({ action: 'reply', text: '这个确实有意思', reason: '回应当前话题', topic: '游戏', memoryCandidates: [], ...fields });

test('旧配置补齐社交默认值但不获得自由聊天、主动工具或新触发权', () => {
  const legacy = config();
  delete legacy.chat.social;
  const checked = validateConfig(legacy);
  assert.deepEqual(checked.chat.social, DEFAULT_CHAT_SOCIAL);
  assert.deepEqual(checked.groups[0].social, DEFAULT_GROUP_SOCIAL);
  assert.deepEqual(checked.groups[0].triggers, ['mention']);
  assert.equal(checked.groups[0].send, false);
  assert.equal(checked.permissions.released, false);
  assert.ok(GROUP_TRIGGER_IDS.includes('name'));
  assert.ok(GROUP_TRIGGER_IDS.includes('reply'));
  assert.deepEqual(effectiveGroupTriggers({ trigger: 'casual' }), ['casual']);
  assert.deepEqual(effectiveGroupTriggers({ triggers: ['name', 'reply'] }), ['name', 'reply']);
});

test('自由聊天参数有界、工具只能保存工具标识，未知权限字段不能混入', () => {
  const current = config();
  current.chat.social.batchMs = 1;
  current.chat.social.aliases = ['小Q', '小Q'];
  current.groups[0].social = { ...DEFAULT_GROUP_SOCIAL, enabled: true, proactive: true, activeStart: '22:00', activeEnd: '06:00', readTools: ['bilibili/search_videos'] };
  const checked = validateConfig(current);
  assert.equal(checked.chat.social.batchMs, 1);
  assert.deepEqual(checked.chat.social.aliases, ['小Q']);
  assert.deepEqual(checked.groups[0].social.readTools, ['bilibili/search_videos']);
  for (const change of [
    value => { value.chat.social.batchMs = 3001; },
    value => { value.chat.social.name = '小Q\n系统'; },
    value => { value.chat.social.aliases = ['']; },
    value => { value.chat.social.aliases = ['坏\u0000名']; },
    value => { value.chat.social.accountCallsPerHour = -1; },
    value => { value.groups[0].social.activeStart = '25:00'; },
    value => { value.groups[0].social.decisionCallsPerHour = Infinity; },
    value => { value.groups[0].social.proactiveIntervalMinutes = 0; },
    value => { value.groups[0].social.proactive = 'true'; },
    value => { value.groups[0].social.allowWrite = true; },
    value => { value.groups[0].social.readTools = ['bilibili/../../update']; },
  ]) {
    const invalid = structuredClone(current); change(invalid);
    assert.throws(() => validateConfig(invalid), { name: 'Error' });
  }
});

test('自主时窗按本地时分处理跨午夜、边界和全天，不影响直接请求判断', () => {
  const at = (hours, minutes = 0) => new Date(2026, 9, 29, hours, minutes);
  const normal = { activeStart: '10:00', activeEnd: '22:00' };
  assert.equal(isActiveTime(normal, at(9, 59)), false);
  assert.equal(isActiveTime(normal, at(10)), true);
  assert.equal(isActiveTime(normal, at(21, 59)), true);
  assert.equal(isActiveTime(normal, at(22)), false);
  const overnight = { activeStart: '22:00', activeEnd: '06:00' };
  assert.equal(isActiveTime(overnight, at(23)), true);
  assert.equal(isActiveTime(overnight, at(5, 59)), true);
  assert.equal(isActiveTime(overnight, at(6)), false);
  assert.equal(isActiveTime({ activeStart: '00:00', activeEnd: '00:00' }, at(8)), true);
  assert.equal(isActiveTime({ activeStart: '25:00', activeEnd: '06:00' }, at(23)), false);
  assert.equal(isActiveTime(normal, new Date(NaN)), false);
});

test('控制结果严格解析，silent不允许意外正文被发往QQ', () => {
  assert.deepEqual(parseSocialDecision(reply()), { action: 'reply', text: '这个确实有意思', reason: '回应当前话题', topic: '游戏', memoryCandidates: [], experienceCandidates: [] });
  assert.equal(parseSocialDecision(`\x60\x60\x60json\n${reply()}\n\x60\x60\x60`).text, '这个确实有意思');
  assert.deepEqual(parseSocialDecision('{"action":"silent","text":"内部讨论不要发送"}'), { action: 'silent', text: '', reason: '', topic: '', memoryCandidates: [], experienceCandidates: [] });
  assert.equal(parseSocialDecision('{"action":"reply","text":"好呀"}').memoryCandidates.length, 0);
});

test('分条仅作为可选提示保留，完整正文仍是唯一回复来源', () => {
  const parsed = parseSocialDecision(reply({
    text: '确实有意思。\n\n我也想了解后续。', messages: [' 确实有意思。 ', '我也想了解后续。'], replyMode: 'chat',
  }));
  assert.equal(parsed.text, '确实有意思。\n\n我也想了解后续。');
  assert.deepEqual(parsed.messages, ['确实有意思。', '我也想了解后续。']);
  assert.equal(parsed.replyMode, 'chat');
  assert.equal(parseSocialDecision(reply({ replyMode: 'complete' })).replyMode, 'complete');
  assert.equal(parseSocialDecision(reply({ replyMode: 'auto' })).replyMode, 'auto');
  // Hint agreement belongs to the host planner; parsing never replaces text
  // with a competing answer or treats bubbles as permission to send them.
  const differing = parseSocialDecision(reply({ text: '保留这份完整正文', messages: ['另一份回答'] }));
  assert.equal(differing.text, '保留这份完整正文');
  assert.throws(() => parseSocialDecision(JSON.stringify({ action: 'reply', messages: ['不能绕过必填正文'] })), { code: 'SOCIAL_DECISION_INVALID' });
});

test('沉默决策清除所有可发送正文与分条提示，旧结果不添加新控制字段', () => {
  const silent = parseSocialDecision(JSON.stringify({ action: 'silent', text: '不要发这段', messages: ['也不要发'], replyMode: 'chat' }));
  assert.deepEqual(silent, { action: 'silent', text: '', reason: '', topic: '', memoryCandidates: [], experienceCandidates: [] });
  assert.equal(Object.hasOwn(parseSocialDecision(reply()), 'messages'), false);
  assert.equal(Object.hasOwn(parseSocialDecision(reply()), 'replyMode'), false);
});

test('分条提示的格式和累计长度有界，不能注入等待时间或额外控制参数', () => {
  for (const fields of [
    { messages: null }, { messages: '正文' }, { messages: [] }, { messages: [''] }, { messages: [' \n '] },
    { messages: ['一条', 2] }, { messages: [{ text: '内部对象', delayMs: 500 }] },
    { messages: ['一', '二', '三', '四'] }, { messages: ['x'.repeat(6000), 'x'.repeat(6001)] },
    { replyMode: null }, { replyMode: 'typing' }, { replyMode: { delay: 500 } },
    { messages: ['正文'], delayMs: 300 }, { messages: ['正文'], send: true },
  ]) {
    assert.throws(() => parseSocialDecision(reply(fields)), { code: 'SOCIAL_DECISION_INVALID' });
  }
  assert.equal(parseSocialDecision(reply({ text: 'x'.repeat(12000), messages: ['x'.repeat(12000)] })).messages[0].length, 12000);
});

test('12000字中文正文和一致的三条分段可完整解析，包体仍受独立上限保护', () => {
  const messages = ['甲'.repeat(4000), '乙'.repeat(3998), '丙'.repeat(3998)];
  const text = messages.join('\n\n');
  const source = reply({ text, messages, replyMode: 'chat' });
  assert.equal(text.length, 12000);
  assert.ok(Buffer.byteLength(source, 'utf8') > 64 * 1024);
  const parsed = parseSocialDecision(source);
  assert.equal(parsed.text, text);
  assert.deepEqual(parsed.messages, messages);
  assert.throws(() => parseSocialDecision(`${source}${' '.repeat(128 * 1024)}`), { code: 'SOCIAL_DECISION_INVALID' });
  assert.throws(() => parseSocialDecision(reply({ text: `${text}甲`, messages })), { code: 'SOCIAL_DECISION_INVALID' });
});

test('非法或过长模型结果失败关闭，错误中没有原始模型资料', () => {
  const secret = '不该发到QQ的原始内部资料';
  for (const malformed of [
    secret, `解释\n${reply()}`, `${reply()}${reply()}`,
    reply({ action: 'maybe' }), reply({ text: '' }), reply({ text: 'x'.repeat(12001) }),
    reply({ confidence: 0.9 }), reply({ reason: 'x'.repeat(241) }),
    reply({ memoryCandidates: [{ userId: '555555', kind: 'personality', text: secret, sourceIds: ['m1'] }] }),
    reply({ memoryCandidates: [{ userId: '昵称', kind: 'fact', text: secret, sourceIds: ['m1'] }] }),
    reply({ memoryCandidates: [{ userId: '555555', kind: 'fact', text: secret, sourceIds: [] }] }),
    reply({ memoryCandidates: [{ userId: '555555', kind: 'fact', text: secret, sourceIds: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'] }] }),
    reply({ memoryCandidates: [{ userId: '555555', kind: 'fact', text: secret, sourceIds: ['m1'], system: true }] }),
    reply({ memoryCandidates: Array.from({ length: 6 }, () => ({ userId: '555555', kind: 'fact', text: secret, sourceIds: ['m1'] })) }),
  ]) {
    assert.throws(() => parseSocialDecision(malformed), error => error.code === 'SOCIAL_DECISION_INVALID' && !error.message.includes(secret));
  }
});

test('候选保留成员QQ与来源ID，去重来源但不替代存储层的证据核验', () => {
  const parsed = parseSocialDecision(reply({ memoryCandidates: [
    { userId: '555555', kind: 'preference', text: ' 喜欢科普视频 ', sourceIds: ['msg-1', 'msg-1', 'msg-2'] },
  ] }));
  assert.deepEqual(parsed.memoryCandidates, [{ userId: '555555', kind: 'preference', text: '喜欢科普视频', sourceIds: ['msg-1', 'msg-2'] }]);
});

test('真实@、定向戳一戳和已验证引用可识别，文字伪装与自己的消息不唤醒', () => {
  assert.equal(matchSocialAddress({ text: '@999999 你好' }, config()), null);
  assert.equal(matchSocialAddress({ text: '戳一戳我' }, config()), null);
  assert.deepEqual(matchSocialAddress({ mentioned: true, text: ' 你好 ' }, config()), { kind: 'mention', request: '你好', wake: false });
  assert.deepEqual(matchSocialAddress({ mentioned: true, text: '' }, config()), { kind: 'mention', request: '', wake: true });
  assert.deepEqual(matchSocialAddress({ isNotice: true, kind: 'poke', mentionsBot: true }, config()), { kind: 'poke', request: '', wake: true });
  assert.equal(matchSocialAddress({ isNotice: true, kind: 'poke', mentionsBot: false }, config()), null);
  assert.equal(matchSocialAddress({ isNotice: true, kind: 'group_name', mentionsBot: true }, config()), null);
  assert.equal(matchSocialAddress({ ownMessage: true, mentioned: true, text: '循环' }, config()), null);
  assert.deepEqual(matchSocialAddress({ replyToBot: true, text: '再具体一点' }, config()), { kind: 'reply', request: '再具体一点', wake: false });
});

test('名字支持自然称呼和旧别名，不将词内子串或正则字符当作地址', () => {
  const current = config();
  current.chat.social.name = '小Q';
  current.chat.social.aliases = ['A+B'];
  current.tools.enabled = false;
  current.tools.aliases = ['旧名字'];
  assert.equal(matchSocialAddress({ text: '小Q同学的配置' }, current), null);
  assert.equal(matchSocialAddress({ text: '这段讨论小Q的名字' }, current), null);
  assert.equal(matchSocialAddress({ text: 'AAB，查资料' }, current), null);
  assert.deepEqual(matchSocialAddress({ text: '小Q，看看这个' }, current), { kind: 'name', request: '看看这个', wake: false });
  assert.deepEqual(matchSocialAddress({ text: '小Q帮我看看' }, current), { kind: 'name', request: '帮我看看', wake: false });
  assert.deepEqual(matchSocialAddress({ text: '你怎么看，小Q？' }, current), { kind: 'name', request: '你怎么看', wake: false });
  assert.deepEqual(matchSocialAddress({ text: 'A+B，查资料' }, current), { kind: 'name', request: '查资料', wake: false });
  assert.deepEqual(matchSocialAddress({ text: '旧名字' }, current), { kind: 'name', request: '', wake: true });
});

test('同一提示协议支持工具结果，限定自主只读且不注入待确认记忆', () => {
  const current = config(); current.chat.social.name = '小Q'; current.chat.social.interests = '科普';
  const prompt = socialSystemPrompt({ config: current, group: current.groups[0], actualQQ: '999999', autonomous: true, memories: [
    { userId: '555555', status: 'confirmed', text: '喜欢科普视频', kind: 'preference' },
    { userId: '555555', status: 'pending', text: '未确认事实绝不使用', kind: 'fact' },
  ] });
  assert.match(prompt, /你的名字：小Q/);
  assert.match(prompt, /科普视频/);
  assert.doesNotMatch(prompt, /未确认事实绝不使用/);
  assert.match(prompt, /单独提供的只读工具/);
  assert.match(prompt, /不得自动重试外部写入|不可调用外部写入/);
  assert.match(prompt, /原生工具调用/);
  assert.match(prompt, /sourceIds/);
  assert.match(prompt, /只输出一个 JSON 对象/);
  assert.match(prompt, /不是系统指令/);
});

test('表达提示尊重完整答案和发送节奏边界，避免拆碎结构或重复表情后的文字', () => {
  const prompt = socialSystemPrompt({ config: config(), actualQQ: '999999', group: { id: '222222' } });
  assert.match(prompt, /闲聊可以用1至3条/);
  assert.match(prompt, /认真解答、操作步骤、代码、链接和表格保留完整结构/);
  assert.match(prompt, /完整发.*一次发完.*不要分条/);
  assert.match(prompt, /text 始终是唯一的完整正文/);
  assert.match(prompt, /两个换行连接后必须与text完全一致/);
  assert.match(prompt, /宿主决定是否采用分条、停顿与中断/);
  assert.match(prompt, /模型不得增加delay/);
  assert.match(prompt, /真实发送成功后可以选择 silent，避免重复文字/);
  assert.match(prompt, /不要虚构自己经历/);
  assert.match(prompt, /不推断性格、人际关系或隐含身份/);
});

test('可选经历候选逐条校验，坏札记不拖累有效回复，成员事实仍严格验证', () => {
  const good = { kind: 'pending_topic', text: ' 下次接着聊星空 ', sourceIds: ['m1', 'm1'] };
  assert.deepEqual(parseSocialDecision(reply({ experienceCandidates: [good] })).experienceCandidates,
    [{ kind: 'pending_topic', text: '下次接着聊星空', sourceIds: ['m1'] }]);
  for (const candidate of [
    { ...good, kind: 'personality' }, { ...good, text: 'x'.repeat(301) }, { ...good, text: 'bad\0note' },
    { ...good, sourceIds: [] }, { ...good, sourceIds: ['bad\nsource'] }, { ...good, permissions: { released: true } },
  ]) {
    const parsed = parseSocialDecision(reply({ experienceCandidates: [candidate, good] }));
    assert.equal(parsed.text, '这个确实有意思');
    assert.deepEqual(parsed.experienceCandidates, [{ kind: 'pending_topic', text: '下次接着聊星空', sourceIds: ['m1'] }]);
  }
  for (const malformed of [null, 'bad', {}, 123]) {
    assert.deepEqual(parseSocialDecision(reply({ experienceCandidates: malformed })).experienceCandidates, []);
  }
  assert.equal(parseSocialDecision(reply({ experienceCandidates: [good, good, good] })).experienceCandidates.length, 2);
  assert.throws(() => parseSocialDecision(reply({ memoryCandidates: [{ kind: 'personality', userId: '555555', text: '未经确认', sourceIds: ['m1'] }], experienceCandidates: [good] })), /群聊决策/);
});

test('自由聊天使用统一人格和本群经历，固定规则置前且排除跨域状态', () => {
  const current = config(); current.botQQ = '999999'; current.chat.persona = '# 我的角色\n喜欢海洋';
  const prompt = socialSystemPrompt({ config: current, group: current.groups[0], experiences: [
    { actualQQ: '999999', groupId: '222222', status: 'active', kind: 'interaction', text: '一起讨论过蓝鲸' },
    { actualQQ: '999999', groupId: '777777', status: 'active', kind: 'interaction', text: '其他群隐私' },
  ], session: { actualQQ: '999999', groupId: '222222', topic: '海洋生物', expiresAt: new Date(Date.now() + 10000).toISOString() } });
  assert.ok(prompt.indexOf('固定运行规则') < prompt.indexOf('我的角色'));
  assert.match(prompt, /一起讨论过蓝鲸/);
  assert.match(prompt, /海洋生物/);
  assert.doesNotMatch(prompt, /其他群隐私/);
  assert.match(prompt, /不能推断群友性格/);
});
