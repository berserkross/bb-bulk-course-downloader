/**
 * 落盘层的「大文件与内存加固」核心件：停滞看门狗、完整性判定、互斥闸门、文件级重试。
 * 刻意不碰任何浏览器 API（不引用 window / Response / AbortSignal 实例），
 * 于是这一层可以脱离 jsdom、用 node:test 直接跑纯时序逻辑。
 */

export const DEFAULT_IDLE_MS = 30000;

/** HTTP 状态里值得「整份文件再来一次」的那几个：限流与网关/服务端瞬时故障。 */
const RETRIABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** 下载停滞：reader.read() 挂了太久没有新数据。 */
export class StallError extends Error {
  constructor(message) {
    super(message || '下载停滞：太久没有收到新数据');
    this.name = 'StallError';
  }
}

/**
 * 文件不完整：连接被掐断后浏览器常常「干净地」结束流，
 * 只有拿期望字节数去比，才知道这份文件只有半截。
 */
export class TruncatedError extends Error {
  constructor(expected, actual, message) {
    const text =
      message ||
      (Number.isFinite(expected) && Number.isFinite(actual)
        ? '文件不完整：期望 ' + expected + ' 字节，实际收到 ' + actual + ' 字节'
        : '文件不完整：收到的字节数与服务器声明的不一致');
    super(text);
    this.name = 'TruncatedError';
    this.expected = expected;
    this.actual = actual;
  }
}

function isAbortLike(err) {
  if (!err) return false;
  return err.name === 'AbortError' || err.code === 20;
}

function isSessionExpiredLike(err) {
  return !!err && err.name === 'SessionExpiredError';
}

/**
 * 值得重试吗？
 * - AbortError / SessionExpiredError：重试没有意义（用户取消、会话已失效），立即放弃；
 * - StallError / TruncatedError / TypeError（网络层）：典型的内容没到手，重试有效；
 * - 没有 status 的错误：分不清是网络层还是别的，按「值得再试一次」处理；
 * - HttpError：只有 429 与 5xx 网关类状态值得重试，其余 4xx 一定是权限/路径问题。
 */
export function isRetriableError(err) {
  if (!err) return false;
  if (isAbortLike(err)) return false;
  if (isSessionExpiredLike(err)) return false;
  if (err instanceof StallError || err.name === 'StallError') return true;
  if (err instanceof TruncatedError || err.name === 'TruncatedError') return true;
  if (err instanceof TypeError) return true;
  const status = Number(err.status);
  if (err.status == null || !Number.isFinite(status)) return true;
  return RETRIABLE_STATUS.has(status);
}

/**
 * 给 reader 套一个停滞看门狗：每次 read() 重新起算，idleMs 内没有 chunk 就 reject StallError。
 * 成功和失败都必须清掉计时器 —— 否则一份文件读完还会在后台留一个半小时的定时器，
 * 几千个文件就是几千个残留 timer。
 */
export function createIdleReader(reader, { idleMs = DEFAULT_IDLE_MS } = {}) {
  if (!reader || typeof reader.read !== 'function') {
    throw new Error('createIdleReader 需要可读流 reader');
  }
  const ms = Number(idleMs) > 0 && Number.isFinite(Number(idleMs)) ? Number(idleMs) : DEFAULT_IDLE_MS;
  let timer = null;
  let cancelled = false;

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function read() {
    if (cancelled) return Promise.resolve({ done: true, value: undefined });
    clearTimer();

    let pending;
    try {
      pending = Promise.resolve(reader.read());
    } catch (err) {
      return Promise.reject(err);
    }

    // 底层那次 read 可能永远不落地；Promise.race 已经把 then 挂上去了，
    // 所以即便它以后才 reject 也不会变成 unhandledRejection。
    const stall = new Promise((_, reject) => {
      timer = setTimeout(() => {
        // 先显式清一次再判停滞：让「每个起过的计时器都有对应的 clearTimeout」
        // 成为一条可在测试里直接断言的不变量，而不是靠 null 掉引用装作没起过。
        clearTimer();
        reject(new StallError());
      }, ms);
    });

    return Promise.race([pending, stall]).then(
      (chunk) => {
        clearTimer();
        return chunk;
      },
      (err) => {
        clearTimer();
        throw err;
      }
    );
  }

  function cancel(reason) {
    cancelled = true;
    clearTimer();
    if (typeof reader.cancel !== 'function') return Promise.resolve();
    try {
      const pending = reader.cancel(reason);
      return pending && typeof pending.catch === 'function' ? pending.catch(() => {}) : Promise.resolve(pending);
    } catch {
      return Promise.resolve();
    }
  }

  return { read, cancel };
}

/**
 * 文件级互斥闸门：FIFO，一次只放一个进去。
 * download sink 用它保证「同一时刻只有一份大文件驻留内存」。
 */
export function createMutex() {
  let tail = Promise.resolve();
  return {
    run(fn) {
      const result = tail.then(() => fn());
      // 闸门自己不能被失败带塌：前一个任务炸了，后一个照常排队进入。
      tail = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    }
  };
}

/**
 * 整份文件级的重试：attempts 是总次数（1 = 不重试）。
 * AbortError 立即透传（用户取消不该被重试掩盖）；每次重试前先回调 onRetry。
 */
export async function withFileRetry(fn, { attempts = 2, isRetriable = isRetriableError, onRetry } = {}) {
  const total = Number.isFinite(Number(attempts)) && Number(attempts) >= 1 ? Math.floor(Number(attempts)) : 1;
  let last = 0;
  for (let attempt = 1; attempt <= total; attempt += 1) {
    last = attempt;
    try {
      return await fn(attempt);
    } catch (err) {
      if (isAbortLike(err)) throw err;
      if (attempt >= total || !isRetriable(err)) throw err;
      if (typeof onRetry === 'function') {
        try {
          onRetry({ attempt, error: err });
        } catch {
          /* 上报失败不该打断重试 */
        }
      }
    }
  }
  throw new Error('withFileRetry：未进入任何一次尝试（attempts=' + last + '）');
}
