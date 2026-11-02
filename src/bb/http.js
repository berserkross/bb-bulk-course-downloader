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
