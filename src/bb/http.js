import { resolveFileName } from './files.js';

// 带会话检测与重试的 fetch 包装。所有请求都带 credentials: 'include' 且共用同一个 signal。

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 400;
const MAX_DELAY_MS = 8000;
function isSessionEndpoint(url) {
  try {
    const target = new URL(url, 'https://localhost/');
    return /^(?:login|sso|relogin)\./i.test(target.hostname) ||
      (!WEBDAV_RE.test(target.pathname) && /\/(?:login|relogin|sso)(?:[/.;]|$)/i.test(target.pathname));
  } catch { return false; }
}
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

/**
 * 可疑响应：文件请求回了 text/html，但正文不像登录页（限流 / WAF 拦截 / 读不懂的异常页）。
 * 这类失败多半是瞬时的，会话还活着 —— 所以既不判会话失效，也不能当场判死。
 * message 固定文案，绝不复显原始 HTML、完整 URL 或 query。
 */
export class SuspectResponseError extends Error {
  constructor(detail) {
    const info = detail || {};
    super('服务器返回了异常页面（疑似限流）');
    this.name = 'SuspectResponseError';
    this.htmlKind = info.htmlKind === 'login' || info.htmlKind === 'blocked' ? info.htmlKind : 'other';
    this.status = Number.isFinite(Number(info.status)) ? Number(info.status) : 0;
    this.path = pathnameOnly(info.path);
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

/** 只认 name：跨模块/跨上下文（userscript 包装层）时 instanceof 不一定成立。 */
export function isSuspectResponse(error) {
  return !!error && error.name === 'SuspectResponseError';
}

/**
 * 失败提示：给一句「用户能做什么」，而不是把 err.message 原样抛到面板上。
 * 这里绝不拼 URL、路径或文件名 —— 面板文案红线（docs/m7-quiet.md §1）同样适用。
 */
export function errorHint(error) {
  if (!error) return '';
  const status = Number(error.status);
  if (Number.isFinite(status)) {
    if (status === 401 || status === 403) return '没有权限读取这个文件，请确认登录状态后重试';
    if (status === 404) return '服务器上找不到这个文件，可能已被移除';
    if (status === 429) return '请求太频繁，已被服务器限流，稍后再试';
    if (status >= 500) return '学校服务器暂时不可用，稍后重试';
    return '请求失败（HTTP ' + status + '）';
  }
  const name = String(error.name || '');
  if (name === 'StallError') return '连接长时间没有新数据，可能是网络中断';
  if (name === 'TruncatedError') return '文件没有下载完整，已重新排队';
  if (name === 'TypeError' || /failed to fetch|networkerror|network error/i.test(String(error.message || ''))) {
    return '网络连接中断，检查网络或校园网后重试';
  }
  return '';
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

/** 只取 pathname：错误里绝不放 query，更不放完整 URL。 */
function pathnameOnly(value) {
  const text = String(value == null ? '' : value);
  if (!text) return '';
  try {
    return new URL(text).pathname || '';
  } catch {
    return text.split('#')[0].split('?')[0];
  }
}

/** 三档归类的唯一出处：登录页 / 被拦 / 读不懂。只回种类，正文一个字都不外传。 */
function htmlKindOf(text) {
  const sample = String(text == null ? '' : text).slice(0, PROBE_HTML_LIMIT);
  if (HTML_LOGIN_RE.test(sample)) return 'login';
  if (HTML_BLOCKED_RE.test(sample)) return 'blocked';
  return 'other';
}

/** 读够 PROBE_HTML_LIMIT 个字符就停：够判类，又不把整页塞进内存。读不动就按已读到的部分判。 */
async function readHtmlSample(response) {
  const body = response && response.body;
  if (!body || typeof body.getReader !== 'function') {
    let text = '';
    try {
      text = await response.text();
    } catch {
      text = '';
    }
    return text.slice(0, PROBE_HTML_LIMIT);
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length < PROBE_HTML_LIMIT) {
      const chunk = await reader.read();
      if (!chunk || chunk.done) break;
      text += decoder.decode(chunk.value.subarray(0, PROBE_HTML_LIMIT - text.length), { stream: true });
    }
  } catch {
    /* 读不动就按已读到的部分判类 */
  } finally {
    try {
      const pending = reader.cancel();
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch {
      /* 丢掉主体失败无需处理 */
    }
  }
  return text.slice(0, PROBE_HTML_LIMIT);
}

/**
 * 三档判定（契约 docs/m6-login.md §1.3）：
 * - 重定向落到登录页 → 会话失效（保持不动）；
 * - 文件请求回 text/html 且是登录页 → 会话失效（保持不动）；
 * - 文件请求回 text/html 且是被拦 / 读不懂的异常页 → 可疑响应，交给上层的可疑预算慢重试；
 * - 非 webdav 的 text/html 按现状不在这里判死（不改）。
 */
async function assertAlive(response, requestedUrl, expectedName) {
  const finalUrl = String((response && response.url) || requestedUrl || '');
  const type = String((response && response.headers && response.headers.get('content-type')) || '').toLowerCase();
  const wantsFile = WEBDAV_RE.test(requestedUrl || '') || WEBDAV_RE.test(finalUrl);
  if (isSessionEndpoint(finalUrl)) {
    throw new SessionExpiredError('请求被重定向到登录页');
  }
  if (!wantsFile || type.indexOf('text/html') === -1) return;
  const disposition = response.headers.get('content-disposition') || '';
  const serverName = resolveFileName({ disposition, finalUrl });
  const isHtmlName = name => /\.html?$/i.test(name || '');
  const candidate = response.ok && WEBDAV_RE.test(pathnameOnly(finalUrl)) &&
    (isHtmlName(serverName) || isHtmlName(expectedName)) && typeof response.clone === 'function';
  const sample = await readHtmlSample(candidate ? response.clone() : response);
  // 课件常内嵌脚本和样式，其中的 password/login 字符串并非页面控件。
  const markup = candidate ? sample.replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '') : sample;
  const htmlKind = htmlKindOf(markup);
  if (candidate && htmlKind === 'other') {
    const title = /<title\b[^>]*>([^<]+)<\/title\s*>/i.exec(markup)?.[1].trim();
    const matchesTitle = title && title.toLowerCase() === String(expectedName || '').replace(/\.html?$/i, '').trim().toLowerCase();
    const errorTitle = /^(?:error\b|(?:401|403|404|429|500|503)\b|not found\b|access denied\b|错误|访问被拒绝)/i.test(title || '');
    if (markup.trim() && !errorTitle && (isHtmlName(serverName) || matchesTitle)) return;
  }
  if (htmlKind === 'login') {
    throw new SessionExpiredError('文件请求返回了登录页');
  }
  throw new SuspectResponseError({
    htmlKind,
    status: Number(response && response.status) || 0,
    path: finalUrl || requestedUrl
  });
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

  async function request(url, init, expectedName) {
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
        await assertAlive(response, requestedUrl, expectedName);
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
  const text = await readHtmlSample(response);
  result.bytes = text.length;
  result.htmlKind = htmlKindOf(text);
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
