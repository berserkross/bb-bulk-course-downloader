import test from 'node:test';
import assert from 'node:assert/strict';

import { createHeartbeat, SessionExpiredError } from '../../src/bb/http.js';

/** 注入式定时器：不真实等待，「到点」由测试自己拨。 */
function fakeClock() {
  let nextId = 1;
  const queue = new Map();
  return {
    schedule(fn, ms) {
      const id = nextId;
      nextId += 1;
      queue.set(id, { fn: fn, ms: ms });
      return id;
    },
    cancel(id) {
      queue.delete(id);
    },
    pending() {
      return queue.size;
    },
    delays() {
      const out = [];
      for (const item of queue.values()) out.push(item.ms);
      return out;
    },
    async fire() {
      const first = queue.entries().next();
      if (first.done) return false;
      queue.delete(first.value[0]);
      first.value[1].fn();
      await flush();
      return true;
    }
  };
}

/** 让 tick 的 await 尾巴跑完：只用 setImmediate，不靠定时器等待。 */
function flush() {
  return new Promise(function (resolve) {
    setImmediate(resolve);
  });
}

function makeFetcher(behave) {
  const calls = [];
  return {
    calls: calls,
    async fetchOk(url, init) {
      calls.push({ url: url, init: init });
      return behave(calls.length, url, init);
    }
  };
}

function response() {
  return { body: { cancel() {} } };
}

function beatWith(over) {
  const clock = fakeClock();
  const ticks = [];
  const beat = createHeartbeat({
    fetcher: over.fetcher,
    url: 'https://bb.example.edu/webapps/portal/execute/tabs/tabAction',
    intervalMs: over.intervalMs || 90000,
    setTimeoutFn: clock.schedule,
    clearTimeoutFn: clock.cancel,
    onTick(result) {
      ticks.push(result);
    }
  });
  return { clock: clock, beat: beat, ticks: ticks };
}

test('保活心跳：到点才触发，onTick 收到 ok:true，at 是第几次，踢完自动排下一次', async () => {
  const fetcher = makeFetcher(async function () { return response(); });
  const h = beatWith({ fetcher: fetcher });

  h.beat.start();
  assert.deepEqual(h.clock.delays(), [90000], 'start 只排定时器，不许立刻发请求');
  assert.equal(fetcher.calls.length, 0);

  await h.clock.fire();
  assert.deepEqual(h.ticks, [{ ok: true }]);
  assert.equal(h.beat.count(), 1);
  assert.equal(fetcher.calls.length, 1);
  assert.deepEqual(fetcher.calls[0].init, { method: 'GET', cache: 'no-store' });
  assert.deepEqual(h.clock.delays(), [90000], '踢完一次必须排下一次');

  await h.clock.fire();
  assert.equal(h.beat.count(), 2);
  assert.deepEqual(h.ticks, [{ ok: true }, { ok: true }]);
  h.beat.stop();
});

test('保活心跳：stop 之后不再触发、不留定时器，且可以重复 stop', async () => {
  const fetcher = makeFetcher(async function () { return response(); });
  const h = beatWith({ fetcher: fetcher });
  h.beat.start();
  assert.equal(h.clock.pending(), 1);

  h.beat.stop();
  assert.equal(h.clock.pending(), 0, 'stop 必须清掉定时器');
  h.beat.stop();
  assert.equal(h.clock.pending(), 0, 'stop 幂等');

  assert.equal(await h.clock.fire(), false, '没有定时器就不可能再触发');
  assert.deepEqual(h.ticks, []);
  assert.equal(h.beat.count(), 0);
});

test('保活心跳：start 幂等 —— 连按两次只排一个定时器，不会补一排', async () => {
  const fetcher = makeFetcher(async function () { return response(); });
  const h = beatWith({ fetcher: fetcher });
  h.beat.start();
  const scheduled = h.clock.delays().length;
  h.beat.start();
  assert.equal(h.clock.pending(), scheduled, '第二次 start 不许再排一个');

  await h.clock.fire();
  assert.equal(fetcher.calls.length, 1, '重复 start 不许导致重复请求');
  assert.equal(h.clock.pending(), 1);
  h.beat.stop();
});

test('保活心跳：一次请求抛异常既不上抛也不停心跳，下一次照常触发', async () => {
  const fetcher = makeFetcher(async function (n) {
    if (n === 1) throw new Error('boom');
    return response();
  });
  const h = beatWith({ fetcher: fetcher });
  h.beat.start();

  await h.clock.fire();
  assert.deepEqual(h.ticks, [{ ok: false }], '非会话错误只报 ok:false');
  assert.equal(h.clock.pending(), 1, '炸了也必须排下一次');

  await h.clock.fire();
  assert.deepEqual(h.ticks, [{ ok: false }, { ok: true }]);
  assert.equal(h.beat.count(), 2);
  h.beat.stop();
});

test('保活心跳：isSessionExpired 命中时 onTick 收到 sessionExpired:true', async () => {
  const expired = new SessionExpiredError('会话已失效', { finalUrl: 'https://bb.example.edu/login' });
  const fetcher = makeFetcher(async function () {
    throw expired;
  });
  const h = beatWith({ fetcher: fetcher });
  h.beat.start();

  await h.clock.fire();
  assert.deepEqual(h.ticks, [{ ok: false, sessionExpired: true }]);
  assert.equal(h.clock.pending(), 1, '会话过期也要继续保活：停机判定不归心跳管');
  h.beat.stop();
});

test('保活心跳：拿不到 fetchOk 或间隔非正时一个定时器都不排，也不抛', async () => {
  const clock = fakeClock();
  const noFetch = createHeartbeat({
    fetcher: {},
    url: 'https://bb.example.edu/webapps/portal/execute/tabs/tabAction',
    intervalMs: 90000,
    setTimeoutFn: clock.schedule,
    clearTimeoutFn: clock.cancel
  });
  noFetch.start();
  assert.equal(clock.pending(), 0);

  const zero = createHeartbeat({
    fetcher: makeFetcher(async function () { return response(); }),
    url: 'https://bb.example.edu/webapps/portal/execute/tabs/tabAction',
    intervalMs: 0,
    setTimeoutFn: clock.schedule,
    clearTimeoutFn: clock.cancel
  });
  zero.start();
  assert.equal(clock.pending(), 0);
  assert.equal(zero.count(), 0);
  zero.stop();
  noFetch.stop();
});
