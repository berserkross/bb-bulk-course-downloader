import test from 'node:test';
import assert from 'node:assert/strict';

import {
  StallError,
  TruncatedError,
  createIdleReader,
  isRetriableError,
  createMutex,
  withFileRetry,
  DEFAULT_IDLE_MS
} from '../../src/sinks/guard.js';
import { HttpError, SessionExpiredError } from '../../src/bb/http.js';

/**
 * 计时器探针：只记录「延迟恰好等于 delayMs」的 setTimeout，
 * 这样 node:test 自己的内部定时器不会被误算进来；uncleared 就是残留 timer。
 */
function timerProbe(delayMs) {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const created = new Set();
  const cleared = new Set();
  globalThis.setTimeout = function patchedSetTimeout(fn, ms) {
    const rest = Array.prototype.slice.call(arguments, 2);
    const id = realSet(fn, ms, ...rest);
    if (ms === delayMs) created.add(id);
    return id;
  };
  globalThis.clearTimeout = function patchedClearTimeout(id) {
    if (created.has(id)) cleared.add(id);
    return realClear(id);
  };
  return {
    get created() {
      return created.size;
    },
    get uncleared() {
      return Array.from(created).filter((id) => !cleared.has(id));
    },
    restore() {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    }
  };
}

function arrayReader(chunks) {
  let i = 0;
  const state = { cancels: [] };
  return Object.assign(state, {
    async read() {
      if (i >= chunks.length) return { done: true, value: undefined };
      const value = chunks[i];
      i += 1;
      return { done: false, value };
    },
    async cancel(reason) {
      state.cancels.push(reason);
    }
  });
}

function hangingReader() {
  const state = { cancels: [] };
  return Object.assign(state, {
    read() {
      return new Promise(() => {});
    },
    async cancel(reason) {
      state.cancels.push(reason);
    }
  });
}

// =========================== 错误类型 ===========================

test('StallError：name 与中文默认文案', () => {
  const err = new StallError();
  assert.equal(err.name, 'StallError');
  assert.equal(err.message, '下载停滞：太久没有收到新数据');
  assert.ok(err instanceof Error);
  assert.equal(new StallError('自定义文案').message, '自定义文案');
});

test('TruncatedError：文案里带期望/实际字节数', () => {
  const err = new TruncatedError(1234, 999);
  assert.equal(err.name, 'TruncatedError');
  assert.ok(err instanceof Error);
  assert.equal(err.expected, 1234);
  assert.equal(err.actual, 999);
  assert.match(err.message, /1234/);
  assert.match(err.message, /999/);
  console.log('  [证据] TruncatedError 文案：', err.message);
});

// =========================== createIdleReader ===========================

test('createIdleReader：正常读完每个 chunk，且不残留计时器', async () => {
  const reader = arrayReader([new Uint8Array(2), new Uint8Array(3)]);
  const probe = timerProbe(37);
  try {
    const idle = createIdleReader(reader, { idleMs: 37 });
    const first = await idle.read();
    const second = await idle.read();
    const third = await idle.read();
    assert.equal(first.done, false);
    assert.equal(first.value.byteLength, 2);
    assert.equal(second.value.byteLength, 3);
    assert.equal(third.done, true);
    // 每次 read() 起一个计时器 → 3 次 read 应该建了 3 个，且全部被清掉
    assert.equal(probe.created, 3, '每次 read() 都应起一次计时');
    assert.deepEqual(probe.uncleared, [], '读完不得残留 timer');
    console.log('  [证据] 3 次 read 建了', probe.created, '个计时器，残留 0 个');
  } finally {
    probe.restore();
  }
});

test('createIdleReader：idleMs 内没有 chunk → reject StallError，且计时器被清掉', async () => {
  const probe = timerProbe(37);
  try {
    const idle = createIdleReader(hangingReader(), { idleMs: 37 });
    const started = Date.now();
    await assert.rejects(() => idle.read(), (err) => {
      assert.equal(err.name, 'StallError');
      assert.equal(err instanceof StallError, true);
      assert.match(err.message, /停滞/);
      return true;
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 30, '必须真的等够 idleMs 才判停滞，实测 ' + elapsed + 'ms');
    assert.equal(probe.created, 1);
    assert.deepEqual(probe.uncleared, [], '停滞路径也必须清掉计时器');
    console.log('  [证据] 停滞判定耗时', elapsed, 'ms（idleMs=37），残留 timer 0 个');
  } finally {
    probe.restore();
  }
});

test('createIdleReader：cancel() 清计时器并把 cancel 透传给底层 reader', async () => {
  const reader = hangingReader();
  const probe = timerProbe(41);
  try {
    const idle = createIdleReader(reader, { idleMs: 41 });
    idle.read().catch(() => {});
    await idle.cancel('用户中断');
    assert.equal(reader.cancels.length, 1);
    assert.equal(reader.cancels[0], '用户中断');
    assert.deepEqual(probe.uncleared, [], 'cancel 之后不得残留 timer');
    // cancel 之后再 read 不再起计时器，直接 done
    const probeLen = probe.created;
    assert.deepEqual(await idle.read(), { done: true, value: undefined });
    assert.equal(probe.created, probeLen, 'cancel 之后不应再起计时器');
  } finally {
    probe.restore();
  }
});

test('createIdleReader：缺省 idleMs 取契约默认 30000；没有 read 可用的 reader 直接抛', () => {
  assert.equal(DEFAULT_IDLE_MS, 30000);
  assert.throws(() => createIdleReader(null), /createIdleReader 需要可读流 reader/);
  assert.throws(() => createIdleReader({}), /createIdleReader 需要可读流 reader/);
  const idle = createIdleReader(arrayReader([]), {});
  return idle.read().then((r) => assert.equal(r.done, true));
});

// =========================== isRetriableError ===========================

test('isRetriableError：停滞/截断/网络层/无 status/429+5xx 可重试，Abort/会话失效/其余 4xx 不可重试', () => {
  const cases = [
    [new StallError(), true, 'StallError'],
    [new TruncatedError(10, 5), true, 'TruncatedError'],
    [new TypeError('Failed to fetch'), true, 'TypeError（网络层）'],
    [new Error('没有 status 的未知错误'), true, '无 status'],
    [new HttpError(429, 'u'), true, 'HttpError 429'],
    [new HttpError(500, 'u'), true, 'HttpError 500'],
    [new HttpError(502, 'u'), true, 'HttpError 502'],
    [new HttpError(503, 'u'), true, 'HttpError 503'],
    [new HttpError(504, 'u'), true, 'HttpError 504'],
    [new HttpError(404, 'u'), false, 'HttpError 404'],
    [new HttpError(403, 'u'), false, 'HttpError 403'],
    [new HttpError(400, 'u'), false, 'HttpError 400'],
    [new SessionExpiredError(), false, 'SessionExpiredError'],
    [new DOMException('aborted', 'AbortError'), false, 'AbortError'],
    [Object.assign(new Error('取消'), { code: 20 }), false, 'DOMException code 20'],
    [null, false, 'null']
  ];
  const table = [];
  for (const [err, expected, label] of cases) {
    const actual = isRetriableError(err);
    table.push(label + '=' + actual);
    assert.equal(actual, expected, label + ' 应为 ' + expected + '，实测 ' + actual);
  }
  console.log('  [证据] 可重试判定表：', table.join(' | '));
});

// =========================== createMutex ===========================

test('createMutex：FIFO 且同一时刻只放一个进去', async () => {
  const mutex = createMutex();
  const log = [];
  let live = 0;
  let maxLive = 0;
  const job = (id, delay) =>
    mutex.run(async () => {
      live += 1;
      maxLive = Math.max(maxLive, live);
      log.push('enter' + id);
      await new Promise((resolve) => setTimeout(resolve, delay));
      log.push('exit' + id);
      live -= 1;
      return id;
    });

  const results = await Promise.all([job(1, 15), job(2, 1), job(3, 5)]);
  assert.deepEqual(results, [1, 2, 3], '返回值必须原样透传且按提交顺序');
  assert.equal(maxLive, 1, '同一时刻只允许一个任务在临界区，实测 ' + maxLive);
  assert.deepEqual(log, ['enter1', 'exit1', 'enter2', 'exit2', 'enter3', 'exit3'], '必须是 FIFO 且不交错');
  console.log('  [证据] 临界区进入/退出序号：', JSON.stringify(log));
});

test('createMutex：前一个任务抛错不会把闸门带塌', async () => {
  const mutex = createMutex();
  const order = [];
  const bad = mutex.run(async () => {
    order.push('bad-enter');
    throw new Error('炸了');
  });
  const good = mutex.run(async () => {
    order.push('good-enter');
    return 'ok';
  });
  await assert.rejects(() => bad, /炸了/);
  assert.equal(await good, 'ok');
  assert.deepEqual(order, ['bad-enter', 'good-enter']);
});

// =========================== withFileRetry ===========================

test('withFileRetry：首次失败后重试成功，重试前 onRetry({ attempt, error })', async () => {
  const seen = [];
  let calls = 0;
  const value = await withFileRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('Failed to fetch');
      return 'ok';
    },
    { attempts: 2, onRetry: (info) => seen.push(info) }
  );

  assert.equal(value, 'ok');
  assert.equal(calls, 2);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].attempt, 1, 'onRetry 报的是「刚刚失败的那次」');
  assert.ok(seen[0].error instanceof TypeError);
  console.log('  [证据] onRetry 收到：', JSON.stringify({ attempt: seen[0].attempt, error: seen[0].error.message }));
});

test('withFileRetry：attempts=1 表示不重试；缺省 attempts=2', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withFileRetry(
        async () => {
          calls += 1;
          throw new TypeError('Failed to fetch');
        },
        { attempts: 1 }
      ),
    /Failed to fetch/
  );
  assert.equal(calls, 1, 'attempts=1 必须只跑一次');

  let defaultCalls = 0;
  await assert.rejects(
    () =>
      withFileRetry(async () => {
        defaultCalls += 1;
        throw new TypeError('Failed to fetch');
      }),
    /Failed to fetch/
  );
  assert.equal(defaultCalls, 2, '缺省 attempts 必须是 2（总计两次）');
});

test('withFileRetry：AbortError 立即透传，即使还有重试预算', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withFileRetry(
        async () => {
          calls += 1;
          throw new DOMException('aborted', 'AbortError');
        },
        { attempts: 5, onRetry: () => assert.fail('AbortError 不该触发 onRetry') }
      ),
    (err) => err.name === 'AbortError'
  );
  assert.equal(calls, 1);
});

test('withFileRetry：不可重试的错误不重试；重试预算用尽后抛出最后一次的错误', async () => {
  let notRetriable = 0;
  await assert.rejects(
    () =>
      withFileRetry(
        async () => {
          notRetriable += 1;
          throw new HttpError(404, 'https://cdn/x');
        },
        { attempts: 3 }
      ),
    (err) => err.status === 404
  );
  assert.equal(notRetriable, 1, '404 不该重试');

  let used = 0;
  await assert.rejects(
    () =>
      withFileRetry(
        async () => {
          used += 1;
          throw new StallError();
        },
        { attempts: 3 }
      ),
    (err) => err.name === 'StallError'
  );
  assert.equal(used, 3, '可重试错误必须把预算用满（总计 3 次）');
});
