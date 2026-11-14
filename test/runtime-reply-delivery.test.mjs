import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { createRuntime } from '../src/runtime.mjs';
import { createStore } from '../src/store.mjs';

const scope = { actualQQ: '999999', groupId: '222222' };
const bubbles = ['这个发现挺有意思。', '我尤其喜欢其中的转折。', '你最喜欢哪一段？'];
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitFor(predicate, timeout = 12000) {
  const expires = Date.now() + timeout;
  while (Date.now() < expires) {
    if (await predicate()) return;
    await delay(5);
  }
  throw new Error('等待分条回复运行时超时');
}

const reply = (messages = bubbles, extra = {}) => ({ provider: 'deepseek', text: JSON.stringify({
  action: 'reply', text: messages.join('\n\n'), messages, replyMode: 'chat',
  reason: '当前明确互动', topic: '电影', memoryCandidates: [], experienceCandidates: [], ...extra,
}) });
const silent = () => ({ provider: 'deepseek', text: JSON.stringify({ action: 'silent', reason: '无需重复发言' }) });
const requestPacket = args => JSON.parse(args.messages.find(message => message.role === 'user').content);
const sentText = packet => packet.params.message.filter(segment => segment.type === 'text').map(segment => segment.data.text).join('');

/** A real OneBot socket exercises final authorization, ACK persistence and the
 * account-wide model limiter. The provider is local and no QQ account is used. */
async function fixture({ infer = async () => reply(), pauseMs = 250, failSend = () => false,
  holdAck = () => false, secondGroup = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-service-reply-delivery-'));
  const store = createStore(directory);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  const config = structuredClone(DEFAULT_CONFIG);
  config.botQQ = scope.actualQQ;
  config.qq.enabled = true;
  config.qq.wsUrl = `ws://127.0.0.1:${server.address().port}`;
  config.permissions.released = true;
  config.chat.enabled = config.models.deepseek.enabled = true;
  config.chat.social = { ...config.chat.social, name: '小服', batchMs: 1 };
  const group = { id: scope.groupId, name: '朋友群', mode: 'social', read: true, send: true,
    trigger: 'mention', triggers: ['mention', 'name', 'reply', 'poke', 'casual'], prefix: '/ai',
    probability: 0, cooldownSeconds: 0, social: { enabled: true, proactive: false,
      activeStart: '00:00', activeEnd: '00:00', decisionCallsPerHour: 12, repliesPerHour: 6,
      proactiveIntervalMinutes: 10, readTools: [], delivery: { enabled: true, maxMessages: 3, pauseMs } } };
  config.groups = [group, ...(secondGroup ? [{ ...structuredClone(group), id: '333333', name: '另一群' }] : [])];
  store.saveDraft(config); store.commitDraft();
  const outbound = [], requests = [], logs = [], held = [];
  let peer, sequence = 0, received = 0, behavior = infer;
  server.on('connection', socket => {
    peer = socket;
    socket.on('message', raw => {
      const packet = JSON.parse(raw.toString());
      const sending = packet.action.startsWith('send_');
      if (sending) outbound.push({ ...packet, observedAt: Date.now() });
      const number = outbound.length;
      const respond = () => {
        if (socket.readyState !== socket.OPEN) return;
        const failed = sending && failSend(packet, number);
        socket.send(JSON.stringify({ echo: packet.echo, status: failed ? 'failed' : 'ok', retcode: failed ? 1 : 0,
          data: packet.action === 'get_login_info' ? { user_id: Number(scope.actualQQ) }
            : sending ? { message_id: String(900000 + number) } : {} }));
      };
      if (sending && holdAck(packet, number)) held.push(respond);
      else respond();
    });
  });
  const runtime = createRuntime({ profileId: 'reply-delivery', platform: 'qq', getConfig: () => config,
    getSecret: () => 'mock-key', store, installer: {}, log: (...args) => logs.push(args), providers: {
      deepseek: async args => {
        requests.push({ messages: structuredClone(args.messages), startedAt: Date.now() });
        return behavior(args, requests.length);
      },
    } });
  await runtime.connect();
  return { config, runtime, store, outbound, requests, logs,
    setInfer(next) { behavior = next; },
    emit({ text = '聊聊这部电影', userId = '555555', groupId = scope.groupId, addressed = true } = {}) {
      received++;
      const messageId = String(100000 + ++sequence);
      peer.send(JSON.stringify({ post_type: 'message', message_type: 'group', self_id: Number(scope.actualQQ),
        group_id: Number(groupId), user_id: Number(userId), message_id: messageId, time: Math.floor(Date.now() / 1000),
        sender: { user_id: Number(userId), nickname: `群友${userId}` },
        message: [...(addressed ? [{ type: 'at', data: { qq: scope.actualQQ } }] : []), { type: 'text', data: { text } }] }));
    },
    releaseAck() { assert.ok(held.length, '应有等待中的 OneBot 回执'); held.shift()(); },
    rows(groupId = scope.groupId) { return store.conversation.list({ actualQQ: scope.actualQQ, groupId, limit: 50 }).filter(row => row.role === 'assistant'); },
    texts(groupId = scope.groupId) { return outbound.filter(packet => String(packet.params.group_id) === groupId).map(sentText); },
    async firstAck() { await waitFor(() => this.rows().length >= 1); },
    async received() { await waitFor(() => runtime.status().metrics.received >= received); },
    async idle() {
      await this.received();
      await delay(25);
      await waitFor(() => !runtime.status().queue.running && !runtime.status().queue.pending);
      await delay(10);
    },
    async close() {
      runtime.stop();
      for (const socket of server.clients) socket.terminate();
      await new Promise(resolve => server.close(resolve));
      store.close(); fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('自然分条立即发送首条，按顺序持久化真实回执且只调用一次模型', async () => {
  const f = await fixture({ pauseMs: 500 });
  try {
    f.emit();
    await f.firstAck();
    assert.deepEqual(f.texts(), [bubbles[0]], '首条不应等待后续气泡一起发送');
    await f.idle();
    assert.deepEqual(f.texts(), bubbles);
    assert.deepEqual(f.rows().map(row => row.text), bubbles);
    assert.ok(f.rows().every(row => row.delivery === 'sent' && row.nativeMessageId && row.origin));
    assert.equal(f.requests.length, 1);
    assert.equal(f.runtime.status().metrics.sent, 3);
    assert.ok(f.outbound[1].observedAt - f.outbound[0].observedAt >= 100, '气泡间有受控停顿');
  } finally { await f.close(); }
});

test('当前群友要求不要分条时，宿主覆盖模型的闲聊分条提示', async () => {
  const f = await fixture();
  try {
    f.emit({ text: '请完整发，不要分条' }); await f.idle();
    assert.deepEqual(f.texts(), [bubbles.join('\n\n')]);
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

test('长请求开头的不要分条要求不会因截取末尾上下文而丢失', async () => {
  const f = await fixture();
  try {
    f.emit({ text: `不要分条，请完整发。\n${'背景说明。'.repeat(1400)}` }); await f.idle();
    assert.deepEqual(f.texts(), [bubbles.join('\n\n')]);
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

test('关闭群分条开关后保持单条完整回复，不改变其他群设置', async () => {
  const f = await fixture({ secondGroup: true });
  try {
    f.config.groups[0].social.delivery.enabled = false;
    f.emit(); await f.idle();
    assert.deepEqual(f.texts(), [bubbles.join('\n\n')]);
    assert.equal(f.config.groups[1].social.delivery.enabled, true);
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

test('同一发起者补充消息会取消未发气泡，已确认的第一条不重发', async () => {
  const f = await fixture({ infer: async (args, number) => number === 1 ? reply() : silent() });
  try {
    f.emit(); await f.firstAck();
    f.emit({ text: '补充一下，我指的是导演剪辑版', addressed: false });
    await f.idle();
    assert.deepEqual(f.texts(), [bubbles[0]]);
    assert.deepEqual(f.rows().map(row => row.text), [bubbles[0]]);
    assert.equal(f.requests.length, 2);
    const packet = requestPacket(f.requests[1]);
    assert.ok(packet.context.some(row => row.text === bubbles[0]), '新轮次只见已送达正文');
    assert.ok(packet.context.every(row => row.text !== bubbles[1] && row.text !== bubbles[2]));
    assert.ok(packet.request.some(request => request.text.includes('导演剪辑版')));
  } finally { await f.close(); }
});

test('另一位成员的新直接提问中断旧尾部，随后回答新问题', async () => {
  const newReply = '你问的这点，我再解释一下。';
  const f = await fixture({ infer: async (args, number) => number === 1 ? reply() : reply([newReply]) });
  try {
    f.emit(); await f.firstAck();
    f.emit({ text: '我有另一个问题', userId: '666666' });
    await f.idle();
    assert.deepEqual(f.texts(), [bubbles[0], newReply]);
    assert.equal(f.requests.length, 2);
    assert.equal(requestPacket(f.requests[1]).authorizingRequest.userId, '666666', '新轮不能借用旧发起者身份');
  } finally { await f.close(); }
});

test('不相关的普通群消息不会让正在回答的尾部不断被打断', async () => {
  const f = await fixture({ infer: async (args, number) => number === 1 ? reply() : silent() });
  try {
    f.emit(); await f.firstAck();
    f.emit({ text: '今晚有人打游戏吗', userId: '666666', addressed: false });
    await f.idle();
    assert.deepEqual(f.texts(), bubbles);
    assert.deepEqual(f.rows().map(row => row.text), bubbles);
    assert.equal(f.requests.length, 2, '普通群消息仍可在当前回答结束后独立判断');
  } finally { await f.close(); }
});

test('起始合并批次内的无关闲聊者不会因此获得打断直接回答的身份', async () => {
  const f = await fixture({ infer: async (args, number) => number === 1 ? reply() : silent() });
  try {
    f.config.chat.social.batchMs = 50;
    f.emit();
    f.emit({ text: '我先去吃饭', userId: '666666', addressed: false });
    await f.firstAck();
    assert.equal(requestPacket(f.requests[0]).request.length, 2, '确认两个作者确实进入同一个合并批次');
    f.emit({ text: '今天外卖挺好吃', userId: '666666', addressed: false });
    await f.idle();
    assert.deepEqual(f.texts(), bubbles);
    assert.equal(f.requests.length, 2);
  } finally { await f.close(); }
});

test('发起者说等一下别发了会撤销剩余气泡，不生成固定报错或新回复', async () => {
  const f = await fixture();
  try {
    f.emit(); await f.firstAck();
    f.emit({ text: '等一下，别发了', addressed: false });
    await f.idle();
    assert.deepEqual(f.texts(), [bubbles[0]]);
    assert.equal(f.requests.length, 1, '停止本轮不应额外请求模型接话');
    const delivery = f.runtime.status().social.groups[0].delivery;
    assert.equal(delivery.state, 'interrupted');
    assert.equal(delivery.sentMessages, 1);
    assert.equal(delivery.totalMessages, 3);
    assert.ok(f.logs.some(args => args.some(value => typeof value === 'string' && /停止|打断|中断|取消/.test(value))));
  } finally { await f.close(); }
});

test('未点名的其他成员停止用语不会冒充原发起者打断当前回答', async () => {
  const f = await fixture({ infer: async (args, number) => number === 1 ? reply() : silent() });
  try {
    f.emit(); await f.firstAck();
    f.emit({ text: '等一下，别发了', userId: '666666', addressed: false });
    await f.idle();
    assert.deepEqual(f.texts(), bubbles);
  } finally { await f.close(); }
});

test('包含等一下的后续问题仍作为新请求处理，不被停止短语误吞', async () => {
  const followUpReply = '可以，再讲讲剪辑的部分。';
  const f = await fixture({ infer: async (args, number) => number === 1 ? reply() : reply([followUpReply]) });
  try {
    f.emit(); await f.firstAck();
    f.emit({ text: '等一下告诉我剪辑上有什么区别', addressed: false });
    await f.idle();
    assert.deepEqual(f.texts(), [bubbles[0], followUpReply]);
    assert.equal(f.requests.length, 2);
    assert.ok(requestPacket(f.requests[1]).request.some(request => request.text.includes('剪辑')));
  } finally { await f.close(); }
});

test('已经派发的消息等待真实 ACK 后才结束，停止不会丢失该条发送记录', async () => {
  const f = await fixture({ holdAck: (packet, number) => number === 1 });
  try {
    f.emit(); await waitFor(() => f.outbound.length === 1);
    assert.equal(f.rows().length, 0, '未回执的写入不能提前存成已送达');
    f.emit({ text: '等一下，别发了', addressed: false });
    await f.received(); await delay(20);
    f.releaseAck();
    await f.idle();
    assert.deepEqual(f.texts(), [bubbles[0]]);
    assert.deepEqual(f.rows().map(row => row.text), [bubbles[0]]);
    assert.equal(f.runtime.status().metrics.sent, 1);
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

test('同一发起者先补充再停止时撤销其等待消息，不在旧 ACK 到达后重新生成回答', async () => {
  const f = await fixture({ holdAck: (packet, number) => number === 1 });
  try {
    f.emit(); await waitFor(() => f.outbound.length === 1);
    f.emit({ text: '再补充一下，讲讲剪辑', addressed: false });
    f.emit({ text: '等一下，别发了', addressed: false });
    await f.received(); await delay(20);
    f.releaseAck(); await f.idle();
    assert.deepEqual(f.texts(), [bubbles[0]]);
    assert.deepEqual(f.rows().map(row => row.text), [bubbles[0]]);
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

test('停止只撤销该发起者自己的等待消息，其他成员的新明确请求仍保留', async () => {
  const otherReply = '回答另一位群友的问题。';
  const f = await fixture({ holdAck: (packet, number) => number === 1,
    infer: async (args, number) => number === 1 ? reply() : reply([otherReply]) });
  try {
    f.emit(); await waitFor(() => f.outbound.length === 1);
    f.emit({ text: '再补充一下，讲讲剪辑', addressed: false });
    f.emit({ text: '我问的是另一个问题', userId: '666666' });
    f.emit({ text: '等一下，别发了', addressed: false });
    await f.received(); await delay(20);
    f.releaseAck(); await f.idle();
    assert.deepEqual(f.texts(), [bubbles[0], otherReply]);
    assert.equal(f.requests.length, 2);
    const packet = requestPacket(f.requests[1]);
    assert.equal(packet.authorizingRequest.userId, '666666');
    assert.ok(packet.request.every(request => request.userId === '666666'));
  } finally { await f.close(); }
});

test('新成员提问打断旧回复后可用无点名停止撤销自己的排队请求', async () => {
  const f = await fixture({ holdAck: (packet, number) => number === 1 });
  try {
    f.emit(); await waitFor(() => f.outbound.length === 1);
    f.emit({ text: '我有一个新问题', userId: '666666' });
    await waitFor(() => f.runtime.status().queue.pending === 1);
    f.emit({ text: '等一下，别发了', userId: '666666', addressed: false });
    await f.received(); await delay(20);
    f.releaseAck(); await f.idle();
    assert.deepEqual(f.texts(), [bubbles[0]], '旧尾部与已撤销的新问题都不应继续发送');
    assert.deepEqual(f.rows().map(row => row.text), [bubbles[0]]);
    assert.equal(f.requests.length, 1, '撤销排队的新请求不额外调用模型');
    assert.equal(f.runtime.status().queue.pending, 0);
  } finally { await f.close(); }
});

test('旧发送已经结束而补充仍在合并队列时，停止清理自身排队与定时器', async () => {
  const f = await fixture();
  try {
    f.emit(); await f.firstAck();
    f.config.chat.social.batchMs = 300;
    f.emit({ text: '补充一下，讲讲电影剪辑', addressed: false });
    await waitFor(() => !f.runtime.status().queue.running && f.runtime.status().queue.pending === 1);
    f.emit({ text: '等一下，别发了', addressed: false });
    await f.idle();
    await delay(350);
    assert.deepEqual(f.texts(), [bubbles[0]]);
    assert.equal(f.requests.length, 1, '停止后原合并定时器不能再启动旧请求');
    assert.equal(f.runtime.status().queue.pending, 0);
  } finally { await f.close(); }
});

test('仅剩合并队列时停止仍只清自己的补充，保留另一成员排队中的请求', async () => {
  const otherReply = '继续回答另一位群友。';
  const f = await fixture({ infer: async (args, number) => number === 1 ? reply() : reply([otherReply]) });
  try {
    f.emit(); await f.firstAck();
    f.config.chat.social.batchMs = 300;
    f.emit({ text: '补充一下，讲讲电影剪辑', addressed: false });
    await waitFor(() => !f.runtime.status().queue.running && f.runtime.status().queue.pending === 1);
    f.emit({ text: '我有另一个问题', userId: '666666' });
    await waitFor(() => f.runtime.status().queue.pending === 2);
    f.emit({ text: '等一下，别发了', addressed: false });
    await f.idle();
    assert.deepEqual(f.texts(), [bubbles[0], otherReply]);
    assert.equal(f.requests.length, 2);
    const packet = requestPacket(f.requests[1]);
    assert.equal(packet.authorizingRequest.userId, '666666');
    assert.ok(packet.request.every(request => request.userId === '666666'));
  } finally { await f.close(); }
});

test('完整长回答的1800字传输分段同样逐次检查停止，不派发未发送的尾段', async () => {
  const body = '甲'.repeat(1900);
  const f = await fixture({ holdAck: (packet, number) => number === 1,
    infer: async () => reply([body], { replyMode: 'complete' }) });
  try {
    f.emit(); await waitFor(() => f.outbound.length === 1);
    assert.equal(f.texts()[0].length, 1800);
    f.emit({ text: '先别发了', addressed: false });
    await f.received(); await delay(20);
    f.releaseAck(); await f.idle();
    assert.deepEqual(f.texts(), [body.slice(0, 1800)]);
    assert.deepEqual(f.rows().map(row => row.text), [body.slice(0, 1800)]);
    assert.equal(f.runtime.status().metrics.sent, 1);
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

test('第二条发送失败后停止尾部，不重放第一条或把完整回答写成已完成经历', async () => {
  const f = await fixture({ failSend: (packet, number) => number === 2,
    infer: async args => reply(bubbles, { memoryCandidates: [{ userId: '555555', kind: 'preference', text: '喜欢电影',
      sourceIds: [requestPacket(args).request.at(-1).messageId] }], experienceCandidates: [{ kind: 'interaction',
      text: '已完整介绍电影的三个部分', sourceIds: [requestPacket(args).request.at(-1).messageId] }] }) });
  try {
    f.store.memory.setGroup({ ...scope, enabled: true });
    f.emit({ text: '我喜欢电影，聊聊吧' }); await f.idle();
    assert.deepEqual(f.texts(), bubbles.slice(0, 2), '失败即停止，不额外发通用失败文字');
    assert.deepEqual(f.rows().map(row => row.text), [bubbles[0]]);
    assert.equal(f.requests.length, 1);
    assert.equal(f.runtime.status().metrics.sent, 1);
    assert.deepEqual(f.store.memory.list(scope), []);
    assert.deepEqual(f.store.experiences.list(scope), []);
  } finally { await f.close(); }
});

test('全部回复已经送达后记忆候选保存失败，仅记录日志而不再声称回复未完成', async () => {
  const f = await fixture({ infer: async args => reply(bubbles, { memoryCandidates: [{ userId: '555555', kind: 'preference',
    text: '喜欢电影', sourceIds: [requestPacket(args).request.at(-1).messageId] }] }) });
  try {
    f.store.memory.setGroup({ ...scope, enabled: true });
    f.store.memory.suggest = async () => { throw new Error('fixture memory write failed'); };
    f.emit({ text: '我喜欢电影，聊聊吧' }); await f.idle();
    assert.deepEqual(f.texts(), bubbles);
    assert.deepEqual(f.rows().map(row => row.text), bubbles);
    assert.equal(f.requests.length, 1);
    assert.equal(f.runtime.status().metrics.failed, 0, '本地候选保存问题不应计为回复失败');
    assert.ok(f.logs.some(args => args.some(value => typeof value === 'string' && value.includes('fixture memory write failed'))));
  } finally { await f.close(); }
});

test('首条后撤销群发送权限，剩余气泡逐次核验后取消', async () => {
  const f = await fixture();
  try {
    f.emit(); await f.firstAck();
    f.config.groups[0].send = false;
    await f.idle();
    assert.deepEqual(f.texts(), [bubbles[0]]);
    assert.deepEqual(f.rows().map(row => row.text), [bubbles[0]]);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.store.experiences.list(scope), []);
  } finally { await f.close(); }
});

test('一个群的发送停顿不占用模型槽或阻塞另一群的即时回答', async () => {
  const otherReply = '另一群的问题先回答。';
  const f = await fixture({ secondGroup: true, pauseMs: 1500,
    infer: async (args, number) => number === 1 ? reply() : reply([otherReply]) });
  try {
    f.emit(); await f.firstAck();
    f.emit({ groupId: '333333', text: '另一群有个问题' });
    await waitFor(() => f.rows('333333').length === 1);
    assert.deepEqual(f.texts(), [bubbles[0]], '另一群应在第一群停顿结束前完成自己的回复');
    assert.deepEqual(f.texts('333333'), [otherReply]);
    assert.equal(f.requests.length, 2);
    await f.idle();
    assert.deepEqual(f.texts(), bubbles);
  } finally { await f.close(); }
});

test('模型已经等待较久时抵扣分条停顿，不再叠加完整的模拟输入等待', async () => {
  const f = await fixture({ pauseMs: 1000, infer: async () => { await delay(5200); return reply(); } });
  try {
    f.emit(); await f.idle();
    assert.deepEqual(f.texts(), bubbles);
    assert.equal(f.requests.length, 1);
    assert.ok(f.outbound.at(-1).observedAt - f.outbound[0].observedAt < 900,
      '长模型耗时应抵扣后续停顿，而不是再等待两次完整间隔');
  } finally { await f.close(); }
});
