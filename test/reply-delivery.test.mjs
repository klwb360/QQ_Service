import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplyDeliveryPlan, DEFAULT_REPLY_DELIVERY_SETTINGS } from '../src/reply-delivery.mjs';

const modelPlan = (messages, fields = {}) => createReplyDeliveryPlan({ text: messages.join('\n\n'), messages, ...fields });
const texts = plan => plan.segments.map(segment => segment.text);
const compact = value => value.replace(/\s/gu, '');

test('语义分条只采纳与权威正文完全一致的1–3条文字，首条立即发送', () => {
  const messages = ['这个梗我见过，第一次看到的时候也没绷住。', '刚才那个视频里的停顿才是精髓，越想越好笑。', '你们还有同款吗？'];
  const result = modelPlan(messages);
  assert.equal(result.source, 'model');
  assert.deepEqual(texts(result), messages);
  assert.deepEqual(result.segments.map(part => part.delayMs), [0, 800, 800]);
  assert.deepEqual(DEFAULT_REPLY_DELIVERY_SETTINGS, { enabled: true, maxMessages: 3, pauseMs: 800 });
  assert.equal(Object.isFrozen(DEFAULT_REPLY_DELIVERY_SETTINGS), true);
});

test('不一致的模型分条不能替换、添加或泄露非正文资料', () => {
  const text = '只发送这一段已验证正文。';
  for (const messages of [['隐藏的记忆候选'], ['只发送这一段', '已验证正文。'], ['这个未授权的补充不会被发送。']]) {
    const result = createReplyDeliveryPlan({ text, messages });
    assert.deepEqual(result.segments, [{ text, delayMs: 0 }]);
    assert.equal(result.source, 'single');
  }
  assert.deepEqual(createReplyDeliveryPlan({ text: '', messages: ['内部资料'] }).segments, []);
});

test('无正文不会从分条或对象转换得到待发送文字', () => {
  assert.deepEqual(createReplyDeliveryPlan().segments, []);
  assert.deepEqual(createReplyDeliveryPlan({ text: ' \n\t ' }).segments, []);
  assert.throws(() => createReplyDeliveryPlan({ text: { text: '不要转换对象' } }), { code: 'REPLY_DELIVERY_INVALID' });
  assert.throws(() => createReplyDeliveryPlan({ text: null }), { code: 'REPLY_DELIVERY_INVALID' });
});

test('模型分条不能选择延时、混入对象、超项或突破正文预算', () => {
  const invalidMessages = [null, '正文', [null], [{}], [{ text: '正文', delayMs: 999999 }], [''], ['a', 'b', 'c', 'd'], ['x'.repeat(12001)]];
  for (const messages of invalidMessages) assert.throws(() => createReplyDeliveryPlan({ text: '正文', messages }), { code: 'REPLY_DELIVERY_INVALID' });
  assert.throws(() => createReplyDeliveryPlan({ text: 'x'.repeat(12001) }), { code: 'REPLY_DELIVERY_INVALID' });
  assert.throws(() => createReplyDeliveryPlan({ text: '正文', mode: 'admin' }), { code: 'REPLY_DELIVERY_INVALID' });
  assert.throws(() => createReplyDeliveryPlan({ text: '正文', messages: ['私密资料'.repeat(3001)] }), error => {
    assert.equal(error.code, 'REPLY_DELIVERY_INVALID');
    assert.equal(error.message.includes('私密资料'), false);
    return true;
  });
  assert.equal(createReplyDeliveryPlan({ text: 'x'.repeat(12000) }).segments[0].text.length, 12000);
});

test('关闭自然分条、单条上限和完整模式仍保留全部正文', () => {
  const messages = ['先说这部分。', '还有下一部分。', '最后补充这一点。'];
  for (const fields of [{ mode: 'complete' }, { settings: { enabled: false } }, { settings: { maxMessages: 1 } }]) {
    const result = modelPlan(messages, fields);
    assert.deepEqual(result.segments, [{ text: messages.join('\n\n'), delayMs: 0 }]);
    assert.equal(result.mode, 'complete');
  }
  const two = modelPlan(messages, { settings: { maxMessages: 2 } });
  assert.deepEqual(texts(two), [messages[0], messages.slice(1).join('\n\n')]);
});

test('当前用户明确要求完整或一次发送时覆盖模型的聊天分条', () => {
  const messages = ['这是一段内容。', '这里还有内容。'];
  for (const requestText of ['完整一次发', '不要分条', '别拆分', '不用分开发', '一次性完整输出给我', '一条消息发完', 'Please send it all at once.', 'Reply in one message.', "Don't split it up."]) {
    const result = modelPlan(messages, { mode: 'chat', requestText });
    assert.equal(result.segments.length, 1, requestText);
    assert.equal(result.segments[0].text, messages.join('\n\n'));
  }
  assert.equal(modelPlan(messages, { requestText: '不要一次发完，可以慢慢聊' }).segments.length, 2);
});

test('代码、链接、表格、清单、编号步骤及通知说明不会被拆成聊天气泡', () => {
  const protectedParts = [
    ['可以这样做：', '```js\nconst value = 1;\nconsole.log(value);\n```'],
    ['这个参数是 `maxMessages`。', '默认值是三。'],
    ['这个视频很有意思。', 'https://www.bilibili.com/video/BV123456/?from=chat'],
    ['推荐看看这个。', '[视频](https://example.com/watch?a=1&b=2)'],
    ['配置建议如下：', '| 参数 | 值 |\n| --- | --- |\n| count | 3 |'],
    ['请依次完成这些步骤。', '1. 先保存\n2. 再应用'],
    ['有几点建议。', '- 保存设置\n- 启动账号'],
    ['请看这两步。', '一、保存参数\n二、释放权限'],
    ['这是原话。', '> 请先保存'],
    ['接下来有一份清单。', '## 今日安排'],
    ['通知：明天上午十点开会。', '请在今晚之前填写回执。'],
    ['总结：连接正常。', '请继续检查群权限。'],
    ['这是结构化结果。', '{"status":"ok"}'],
  ];
  for (const messages of protectedParts) {
    const result = modelPlan(messages);
    assert.equal(result.segments.length, 1, messages.join('\n\n'));
    assert.equal(result.segments[0].text, messages.join('\n\n'));
  }
  assert.equal(modelPlan(['第一部分。', '第二部分。'], { requestText: '帮我汇总一下通知' }).segments.length, 1);
});

test('旧模型的简短自然段可保守分条，超过上限的剩余内容合并保留', () => {
  const paragraphs = ['这段讨论还挺有意思的，我刚刚翻完前面的聊天记录。', '大家说的其实是两个不同的问题，可以分别聊聊。', '我更想听听你们觉得哪一点最有趣。', '或者先从刚刚那条视频开始也行。'];
  const text = paragraphs.join('\n\n');
  const result = createReplyDeliveryPlan({ text });
  assert.equal(result.source, 'paragraphs');
  assert.equal(result.segments.length, 3);
  assert.equal(result.segments.map(part => part.text).join('\n\n'), text);
  assert.equal(result.segments[2].text, paragraphs.slice(2).join('\n\n'));
  assert.equal(createReplyDeliveryPlan({ text, settings: { maxMessages: 2 } }).segments.length, 2);
  assert.equal(createReplyDeliveryPlan({ text: '两行内容。\n这两行不是两个自然段。' }).segments.length, 1);
});

test('旧模型的短闲聊按自然句子组合，不截断引用、括号、标点与emoji', () => {
  const text = '这个点子确实挺有意思的，我刚才也想到类似的做法。要是让大家分别试试看，应该能发现不少新的玩法。然后我们挑一个最顺手的方案继续聊下去就行。';
  const result = createReplyDeliveryPlan({ text });
  assert.equal(result.source, 'sentences');
  assert.ok(result.segments.length >= 2 && result.segments.length <= 3);
  assert.equal(compact(texts(result).join('')), compact(text));
  const quoted = '刚才他说“这句还没结束！后面的话也属于同一个引用”，听起来确实有意思。我们最好把整句话看完之后再继续接话🙂。最后这部分才是我最想听的内容。';
  const quotedResult = createReplyDeliveryPlan({ text: quoted });
  assert.equal(compact(texts(quotedResult).join('')), compact(quoted));
  assert.ok(texts(quotedResult).some(part => part.includes('“这句还没结束！后面的话也属于同一个引用”')));
  assert.ok(texts(quotedResult).every(part => !/^[\udc00-\udfff]|[\ud800-\udbff]$/u.test(part)));
  const straightQuotes = '他说"wait! this is still part of one quote!"，这个意思我也大概理解了。接下来我们可以看看还有没有更加有趣的解释。最后再决定如何接话就好。';
  const straightResult = createReplyDeliveryPlan({ text: straightQuotes });
  assert.ok(texts(straightResult).some(part => part.includes('"wait! this is still part of one quote!"')));
  assert.equal(compact(texts(straightResult).join('')), compact(straightQuotes));
  assert.equal(createReplyDeliveryPlan({ text: '不错！太有意思了！' }).segments.length, 1);
  const repeated = '刚才这个思路我觉得确实可以继续试试看！！！我们再问问大家有没有一些更容易上手的办法？？最后也可以一起挑一个最合适的方案。';
  const repeatedResult = createReplyDeliveryPlan({ text: repeated });
  assert.equal(compact(texts(repeatedResult).join('')), compact(repeated));
  assert.ok(texts(repeatedResult).every(part => !/^[！？!?]/u.test(part)));
});

test('长解释和复杂多行旧模型答案保持一条，1800字技术分段由发送器处理', () => {
  const text = '这是同一份需要保留结构的较长说明。'.repeat(120);
  const result = createReplyDeliveryPlan({ text });
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].text, text);
  const longModel = ['前半段'.repeat(300), '后半段'.repeat(300)];
  assert.equal(modelPlan(longModel).segments.length, 1);
  assert.equal(createReplyDeliveryPlan({ text: '第一行仍属于同一说明。\n第二行保留在一起。\n\n这是另一段解释。' }).segments.length, 1);
});

test('停顿由宿主参数确定且有界，模型推理较慢时缩短所有后续停顿', () => {
  const messages = ['第一段内容。', '下一段'.repeat(75), '最后一段'.repeat(50)];
  const immediate = modelPlan(messages);
  const slower = modelPlan(messages, { inferenceMs: 3000 });
  assert.equal(immediate.segments[0].delayMs, 0);
  for (let index = 1; index < immediate.segments.length; index += 1) {
    assert.ok(immediate.segments[index].delayMs >= 800 && immediate.segments[index].delayMs <= 1500);
    assert.ok(slower.segments[index].delayMs < immediate.segments[index].delayMs);
  }
  for (const inferenceMs of [5000, 9000, 60000]) assert.deepEqual(modelPlan(messages, { inferenceMs }).segments.map(part => part.delayMs), [0, 0, 0]);
  assert.deepEqual(modelPlan(messages, { settings: { pauseMs: 0 } }).segments.map(part => part.delayMs), [0, 0, 0]);
  const bounded = modelPlan(messages, { settings: { maxMessages: 999, pauseMs: 999999 } });
  assert.ok(bounded.segments.length <= 3);
  assert.ok(bounded.segments.every(part => part.delayMs >= 0 && part.delayMs <= 1500));
  assert.ok(bounded.segments.reduce((sum, part) => sum + part.delayMs, 0) <= 4000);
  assert.deepEqual(immediate, modelPlan(messages));
});

test('输入不被修改；无效宿主数值采用安全默认或约束值', () => {
  const messages = ['先看看前面的聊天内容。', '然后再继续接着聊这个话题。'];
  const settings = Object.freeze({ maxMessages: NaN, pauseMs: Infinity });
  const input = Object.freeze({ text: messages.join('\n\n'), messages: Object.freeze(messages), settings, inferenceMs: NaN });
  assert.deepEqual(createReplyDeliveryPlan(input).segments.map(part => part.delayMs), [0, 800]);
  assert.equal(createReplyDeliveryPlan({ ...input, settings: { maxMessages: -5 } }).segments.length, 1);
  assert.equal(createReplyDeliveryPlan({ ...input, settings: null }).segments.length, 2);
  assert.equal(input.text, messages.join('\n\n'));
});
