import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviders } from '../src/providers.mjs';

const config = { enabled: true, baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', maxTokens: 128, temperature: 0 };
const messages = [{ role: 'user', content: '解释这条通知。' }];

test('模型提供者只暴露 DeepSeek 与兼容 API，不再提供订阅 CLI 执行器', () => {
  const providers = createProviders();
  assert.deepEqual(Object.keys(providers).sort(), ['compatible', 'deepseek']);
  assert.equal(providers.codex, undefined);
});

test('取消 API 请求会终止本次调用，不重试也不换模型通道', async () => {
  const controller = new AbortController();
  let begin;
  const started = new Promise(resolve => { begin = resolve; });
  let requests = 0, aborted = false;
  const providers = createProviders({ fetchImpl: async (_url, options) => {
    requests++;
    begin();
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => {
      aborted = true;
      reject(Object.assign(new Error('fixture cancelled'), { name: 'AbortError' }));
    }, { once: true }));
  } });
  const pending = providers.deepseek({ messages, config, apiKey: 'fixture-key', signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending, error => error.status === 409 && /已取消/.test(error.message));
  assert.equal(aborted, true);
  assert.equal(requests, 1);
});

test('API 超时、额度错误和无效输出均不重试或静默换计费通道', async t => {
  const cases = [
    ['超时', async () => { throw Object.assign(new Error('fixture timeout'), { name: 'TimeoutError' }); }, /请求超时/],
    ['额度不足', async () => new Response(JSON.stringify({ error: { message: 'fixture-key 额度不足' } }), { status: 429 }), /429/],
    ['无效 JSON', async () => new Response('not-json', { status: 200 }), /无法解析/],
    ['超大响应', async () => new Response('x'.repeat(256 * 1024 + 1), { status: 200 }), /无法解析/],
    ['没有文字', async () => Response.json({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }), /没有返回可用的文字/],
  ];
  for (const [label, respond, expected] of cases) await t.test(label, async () => {
    const urls = [];
    const providers = createProviders({ fetchImpl: async (url, options) => {
      urls.push(String(url));
      return respond(url, options);
    } });
    await assert.rejects(providers.deepseek({ messages, config, apiKey: 'fixture-key' }), error => {
      assert.match(error.message, expected);
      assert.equal(error.message.includes('fixture-key'), false);
      return true;
    });
    assert.deepEqual(urls, ['https://api.deepseek.com/chat/completions']);
  });
});
