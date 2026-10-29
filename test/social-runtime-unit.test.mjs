import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelLimiter } from '../src/social-runtime.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(complete => { resolve = complete; });
  return { promise, resolve };
}

test('账号模型槽按优先级选择等待请求，同优先级保持提交顺序', async () => {
  const limiter = createModelLimiter();
  const blocked = deferred(), entered = deferred();
  const order = [];
  const first = limiter.run(undefined, 2, async () => {
    order.push('already-running'); entered.resolve(); await blocked.promise; return 'first';
  });
  await entered.promise;
  const background = limiter.run(undefined, 2, () => { order.push('background'); return 'background'; });
  const directOne = limiter.run(undefined, 0, () => { order.push('direct-1'); return 'direct-1'; });
  const directTwo = limiter.run(undefined, 0, () => { order.push('direct-2'); return 'direct-2'; });
  blocked.resolve();
  assert.deepEqual(await Promise.all([first, background, directOne, directTwo]), ['first', 'background', 'direct-1', 'direct-2']);
  assert.deepEqual(order, ['already-running', 'direct-1', 'direct-2', 'background']);
});

test('多个群同时请求时全账号最多一个模型回调执行', async () => {
  const limiter = createModelLimiter();
  const blocked = deferred(), entered = deferred();
  let active = 0, maximum = 0, finished = 0;
  const requests = Array.from({ length: 8 }, (_, index) => limiter.run(undefined, index % 3, async () => {
    active++; maximum = Math.max(maximum, active); entered.resolve();
    try { await blocked.promise; return index; }
    finally { active--; finished++; }
  }));
  await entered.promise;
  assert.equal(active, 1);
  assert.equal(finished, 0);
  blocked.resolve();
  assert.deepEqual(await Promise.all(requests), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(maximum, 1);
  assert.equal(active, 0);
  assert.equal(finished, 8);
});

test('已取消或等待中取消的请求不会执行，也不会阻塞后续模型请求', async () => {
  const limiter = createModelLimiter();
  const alreadyAborted = new AbortController(); alreadyAborted.abort();
  let canceledExecutions = 0;
  await assert.rejects(limiter.run(alreadyAborted.signal, 0, () => { canceledExecutions++; }), /已取消/);
  const blocked = deferred(), entered = deferred();
  const first = limiter.run(undefined, 1, async () => { entered.resolve(); await blocked.promise; });
  await entered.promise;
  const waitingAbort = new AbortController();
  const waiting = limiter.run(waitingAbort.signal, 0, () => { canceledExecutions++; });
  const rejection = assert.rejects(waiting, /已取消/);
  const after = limiter.run(undefined, 2, () => 'next group');
  waitingAbort.abort();
  await rejection;
  assert.equal(canceledExecutions, 0);
  blocked.resolve();
  await first;
  assert.equal(await after, 'next group');
  assert.equal(canceledExecutions, 0);
});

test('异步失败和同步异常均释放模型槽并保留错误', async () => {
  const limiter = createModelLimiter();
  const firstFailure = new Error('provider failed');
  const secondFailure = new Error('synchronous provider failed');
  const requests = [
    limiter.run(undefined, 0, async () => { throw firstFailure; }),
    limiter.run(undefined, 0, () => { throw secondFailure; }),
    limiter.run(undefined, 0, () => 42),
  ];
  const result = await Promise.allSettled(requests);
  assert.equal(result[0].status, 'rejected'); assert.equal(result[0].reason, firstFailure);
  assert.equal(result[1].status, 'rejected'); assert.equal(result[1].reason, secondFailure);
  assert.deepEqual(result[2], { status: 'fulfilled', value: 42 });
});

test('等待队列有界，取消等待请求后可接纳新请求', async () => {
  const limiter = createModelLimiter(1);
  const blocked = deferred(), entered = deferred();
  const first = limiter.run(undefined, 1, async () => { entered.resolve(); await blocked.promise; });
  await entered.promise;
  const waitingAbort = new AbortController();
  const waiting = limiter.run(waitingAbort.signal, 2, () => 'canceled');
  const rejection = assert.rejects(waiting, /已取消/);
  await assert.rejects(limiter.run(undefined, 0, () => 'overflow'), /队列已满/);
  waitingAbort.abort(); await rejection;
  const accepted = limiter.run(undefined, 0, () => 'accepted after cancel');
  blocked.resolve(); await first;
  assert.equal(await accepted, 'accepted after cancel');
});
