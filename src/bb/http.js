// 带会话检测与重试的 fetch 包装。所有请求都带 credentials: 'include' 且共用同一个 signal。

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 400;
const MAX_DELAY_MS = 8000;
const SESSION_URL_RE = /login|relogin|sso/i;
const WEBDAV_RE = /\/bbcswebdav\//i;

export class HttpError extends Error {
  constructor(status, url, message) {
    super(message || 'HTTP ' + status + (url ? ' ' + url : ''));
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

export class SessionExpiredError extends Error {
  constructor(message, detail) {
    super(message || '会话已失效：请重新登录后再试。');
    this.name = 'SessionExpiredError';
    if (detail) Object.assign(this, detail);
  }
}

export class AbortError extends Error {
  constructor(message) {
    super(message || '操作已取消');
    this.name = 'AbortError';
  }
}

export function isAbortError(error) {
  return !!error && (error instanceof AbortError || error.name === 'AbortError');
}

export function isSessionExpired(error) {
  return !!error && (error instanceof SessionExpiredError || error.name === 'SessionExpiredError');
}

function linkSignals() {
  const list = [];
  for (let i = 0; i < arguments.length; i += 1) {
    const signal = arguments[i];
    if (signal) list.push(signal);
  }
  if (!list.length) return undefined;
  if (list.length === 1) return list[0];
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }
  return controller.signal;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new AbortError());
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, ms));
    function onAbort() {
      cleanup();
      reject(new AbortError());
    }
    function cleanup() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function parseRetryAfter(value) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_DELAY_MS, Math.round(seconds * 1000));
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.min(MAX_DELAY_MS, Math.max(0, at - Date.now()));
  return undefined;
}

function backoffDelay(attempt, response) {
  const retryAfter = parseRetryAfter(response && response.headers ? response.headers.get('retry-after') : null);
  if (retryAfter !== undefined) return retryAfter;
  const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(2, attempt - 1));
  return Math.round(base + Math.random() * base * 0.5);
}

function discardBody(response) {
  try {
    const body = response && response.body;
    if (body && typeof body.cancel === 'function') {
      const pending = body.cancel();
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    }
  } catch {
    /* 丢掉主体失败无需处理 */
  }
}

function assertAlive(response, requestedUrl) {
  const finalUrl = String((response && response.url) || requestedUrl || '');
  const type = String((response && response.headers && response.headers.get('content-type')) || '').toLowerCase();
  const wantsFile = WEBDAV_RE.test(requestedUrl || '') || WEBDAV_RE.test(finalUrl);
  if (SESSION_URL_RE.test(finalUrl)) {
    throw new SessionExpiredError('会话已失效：请求被重定向到登录页 ' + finalUrl, { finalUrl });
  }
  if (wantsFile && type.indexOf('text/html') !== -1) {
    throw new SessionExpiredError('会话已失效：文件请求返回了 HTML 页面 ' + finalUrl, { finalUrl, contentType: type });
  }
}

function sizeFromHeaders(response) {
  if (!response || !response.headers) return undefined;
  const range = response.headers.get('content-range');
  if (range) {
    const match = /bytes\s+\d+-\d+\/(\d+)/i.exec(range);
    if (match) {
      const total = Number(match[1]);
      if (Number.isFinite(total)) return total;
    }
  }
  if (response.status === 200) {
    const length = response.headers.get('content-length');
    if (length) {
      const total = Number(length);
      if (Number.isFinite(total) && total >= 0) return total;
    }
  }
  return undefined;
}

/**
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {{ fetchOk: (url: string, init?: RequestInit) => Promise<Response>, probeSize: (url: string) => Promise<number|undefined> }}
 */
export function createFetcher(options) {
  const opts = options || {};
  const outer = opts.signal;

  async function request(url, init) {
    const config = init || {};
    const signal = linkSignals(outer, config.signal);
    const requestedUrl = String(url);
    for (let attempt = 1; ; attempt += 1) {
      if (signal && signal.aborted) throw new AbortError();
      let response;
      try {
        response = await fetch(requestedUrl, Object.assign({}, config, { credentials: 'include', signal }));
      } catch (error) {
        if (isAbortError(error) || (signal && signal.aborted)) throw new AbortError();
        if (attempt < MAX_ATTEMPTS) {
          await sleep(backoffDelay(attempt), signal);
          continue;
        }
        throw error;
      }
      try {
        assertAlive(response, requestedUrl);
        if (!response.ok) throw new HttpError(response.status, response.url || requestedUrl);
      } catch (error) {
        discardBody(response);
        if (error instanceof HttpError && RETRY_STATUS.has(error.status) && attempt < MAX_ATTEMPTS) {
          await sleep(backoffDelay(attempt, response), signal);
          continue;
        }
        throw error;
      }
      return response;
    }
  }

  async function probeSize(url) {
    const signal = linkSignals(outer);
    let response;
    try {
      if (signal && signal.aborted) throw new AbortError();
      response = await fetch(String(url), {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        credentials: 'include',
        signal
      });
      if (!response.ok && response.status !== 206) return undefined;
      return sizeFromHeaders(response);
    } catch (error) {
      if (isAbortError(error) || (signal && signal.aborted)) throw new AbortError();
      return undefined;
    } finally {
      if (response) discardBody(response);
    }
  }

  return { fetchOk: request, probeSize };
}

/* ---------------- 会话自检 / 保活（v2.6.0） ---------------- */

/** HTML 自检最多读这么多字符：够判「登录页 / 被拦 / 其它」，又不把整页塞进内存。 */
const PROBE_HTML_LIMIT = 64 * 1024;
const HTML_LOGIN_RE = /sign in|login|password|统一身份|登录/i;
const HTML_BLOCKED_RE = /blocked|denied|forbidden|rate limit|too many requests|拦截|访问受限/i;

/**
 * 探一次「会话是不是真的死了」。绝不抛：任何异常都当成「探不到」。
 * alive 只看状态码与 content-type —— text/html 一律算死（登录页、WAF 拦截页、偶发错误页都长这样），
 * 顺手把正文归类成 login / blocked / other；只回判据，绝不把正文带回调用方以外的地方。
 * @param {{ url?: string, signal?: AbortSignal }} [options]
 * @returns {Promise<{ alive: boolean, status?: number, contentType?: string, bytes?: number, htmlKind?: 'login'|'blocked'|'other' }>}
 */
export async function probeAlive(options) {
  const opts = options || {};
  const url = String(opts.url || '');
  if (!url) return { alive: false };
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      credentials: 'include',
      cache: 'no-store',
      signal: opts.signal
    });
  } catch {
    return { alive: false };
  }
  const status = Number(response && response.status) || 0;
  const type = String((response && response.headers && response.headers.get('content-type')) || '').toLowerCase();
  const usable = (status >= 200 && status < 300) || status === 206;
  const result = { alive: false, status: status };
  if (type) result.contentType = type;
  if (type.indexOf('text/html') === -1) {
    // 不是 HTML：结论只看状态码，主体一个字都不读，直接丢掉。
    discardBody(response);
    result.alive = usable;
    return result;
  }
  // 拿到 HTML 就归类（哪怕状态码本身就是 5xx）：alive 恒为 false，分类只用于诊断。
  let text = '';
  try {
    text = await response.text();
  } catch {
    text = '';
  }
  text = String(text == null ? '' : text);
  if (text.length > PROBE_HTML_LIMIT) text = text.slice(0, PROBE_HTML_LIMIT);
  result.bytes = text.length;
  if (HTML_LOGIN_RE.test(text)) result.htmlKind = 'login';
  else if (HTML_BLOCKED_RE.test(text)) result.htmlKind = 'blocked';
  else result.htmlKind = 'other';
  return result;
}

/**
 * 保活心跳：下载期间定期回敲门户页，给 /webapps 的会话续命。
 * 它只负责续命与观测 —— 一次失败不许抛、不许停下载、不许改批次结果。
 * @param {{ fetcher?: { fetchOk?: Function }, url?: string, intervalMs?: number, onTick?: Function,
 *   signal?: AbortSignal, setTimeoutFn?: Function, clearTimeoutFn?: Function }} [options]
 * @returns {{ start: () => void, stop: () => void, count: () => number }}
 */
export function createHeartbeat(options) {
  const opts = options || {};
  const fetcher = opts.fetcher || null;
  const url = String(opts.url || '');
  const intervalMs = Number.isFinite(opts.intervalMs) ? Math.max(0, opts.intervalMs) : 0;
  const onTick = typeof opts.onTick === 'function' ? opts.onTick : null;
  const signal = opts.signal;
  const schedule = typeof opts.setTimeoutFn === 'function' ? opts.setTimeoutFn : setTimeout;
  const unschedule = typeof opts.clearTimeoutFn === 'function' ? opts.clearTimeoutFn : clearTimeout;
  let timer = null;
  let ticks = 0;
  let running = false;

  function stop() {
    running = false;
    if (timer !== null) {
      try {
        unschedule(timer);
      } catch {
        /* 清定时器失败不该冒到下载链上 */
      }
      timer = null;
    }
  }

  function arm() {
    if (!running) return;
    timer = schedule(function () {
      timer = null;
      void tick();
    }, intervalMs);
  }

  async function tick() {
    if (!running) return;
    if (signal && signal.aborted) {
      stop();
      return;
    }
    ticks += 1;
    let outcome = { ok: false };
    try {
      const response = await fetcher.fetchOk(url, { method: 'GET', cache: 'no-store' });
      discardBody(response);
      outcome = { ok: true };
    } catch (error) {
      outcome = isSessionExpired(error) ? { ok: false, sessionExpired: true } : { ok: false };
    }
    // stop() 之后一次都不许再回调：批次可能已经收尾，日志与计数都不该再动。
    if (!running) return;
    if (onTick) {
      try {
        onTick(outcome);
      } catch {
        /* 观察者自己出错不许影响心跳，更不许影响下载 */
      }
    }
    arm();
  }

  function start() {
    if (running) return;
    if (!fetcher || typeof fetcher.fetchOk !== 'function') return;
    if (!url || !(intervalMs > 0)) return;
    if (signal && signal.aborted) return;
    running = true;
    arm();
  }

  function count() {
    return ticks;
  }

  return { start: start, stop: stop, count: count };
}
