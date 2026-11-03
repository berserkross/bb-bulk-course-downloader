// 课程内容树扫描：content_id 防环 + 有界并发 + 抖动。

import { parseContentList } from './dom.js';
import { AbortError, isAbortError, isSessionExpired } from './http.js';

const MAX_FOLDER_CONCURRENCY = 4;
const DEFAULT_MIN_DELAY_MS = 150;
const DEFAULT_MAX_DELAY_MS = 400;

function clampConcurrency(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return MAX_FOLDER_CONCURRENCY;
  return Math.min(Math.floor(n), MAX_FOLDER_CONCURRENCY);
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function createLimiter(max) {
  let active = 0;
  const waiters = [];
  return async function run(task) {
    if (active >= max) await new Promise((resolve) => waiters.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      const next = waiters.shift();
      if (next) next();
    }
  };
}

function randomDelay(min, max) {
  const lo = Math.max(0, min);
  const hi = Math.max(lo, max);
  return Math.round(lo + Math.random() * (hi - lo));
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new AbortError());
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
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

function contentIdOfUrl(url) {
  try {
    return new URL(String(url), 'http://localhost/').searchParams.get('content_id');
  } catch {
    return null;
  }
}

function parseHtml(html) {
  return new DOMParser().parseFromString(String(html), 'text/html');
}

/**
 * @param {{ fetcher: { fetchOk: Function }, rootUrl: string, onProgress?: Function, concurrency?: number, minDelayMs?: number, maxDelayMs?: number }} options
 * @returns {{ scan: () => Promise<import('./files.js').Entry[]>, cancel: () => void, failures: Array<{ url: string, folderPath: string[], error: string }> }}
 */
export function createScanner(options) {
  const opts = options || {};
  const { fetcher, rootUrl, onProgress } = opts;
  if (!fetcher || typeof fetcher.fetchOk !== 'function') throw new TypeError('createScanner: 缺少 fetcher.fetchOk');
  if (!rootUrl) throw new TypeError('createScanner: 缺少 rootUrl');

  const concurrency = clampConcurrency(opts.concurrency);
  const minDelayMs = positiveNumber(opts.minDelayMs, DEFAULT_MIN_DELAY_MS);
  const maxDelayMs = positiveNumber(opts.maxDelayMs, DEFAULT_MAX_DELAY_MS);
  const controller = new AbortController();
  const signal = controller.signal;
  const limit = createLimiter(concurrency);

  let failures = [];
  let started = null;

  async function loadFolder(job) {
    const response = await fetcher.fetchOk(job.url, {
      headers: { Accept: 'text/html,application/xhtml+xml' },
      signal
    });
    const html = await response.text();
    return parseContentList(parseHtml(html), response.url || job.url);
  }

  async function run() {
    const pages = new Map();
    const visited = new Set();
    const seenFileUrls = new Set();
    failures = [];
    let foldersDone = 0;
    let pending = 0;
    let fatal = null;
    let finished = false;
    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });

    function report() {
      if (typeof onProgress !== 'function') return;
      try {
        onProgress({ foldersDone, foldersQueued: pending, filesFound: seenFileUrls.size });
      } catch {
        /* 进度回调用自己的异常不能影响扫描 */
      }
    }

    function settleOne() {
      pending -= 1;
      report();
      if (pending === 0 && !finished) {
        finished = true;
        resolveDone();
      }
    }

    function accept(job, parsed) {
      pages.set(job.id, parsed);
      for (const file of parsed.files) seenFileUrls.add(file.url);
      for (const folder of parsed.folders) {
        if (!folder.id || visited.has(folder.id)) continue;
        visited.add(folder.id);
        enqueue({
          url: folder.url,
          id: folder.id,
          folderPath: job.folderPath.concat([String(folder.name || folder.id)])
        });
      }
    }

    function enqueue(job) {
      pending += 1;
      limit(async () => {
        try {
          await abortableDelay(randomDelay(minDelayMs, maxDelayMs), signal);
          if (signal.aborted) throw new AbortError();
          const parsed = await loadFolder(job);
          accept(job, parsed);
          foldersDone += 1;
        } catch (error) {
          if (isAbortError(error) || signal.aborted) {
            fatal = fatal || new AbortError();
            controller.abort();
          } else if (isSessionExpired(error)) {
            fatal = fatal || error;
            controller.abort();
          } else {
            failures.push({
              url: job.url,
              folderPath: job.folderPath.slice(),
              error: (error && error.message) || String(error)
            });
          }
        } finally {
          settleOne();
        }
      });
    }

    const rootJob = { url: rootUrl, id: contentIdOfUrl(rootUrl) || rootUrl, folderPath: [] };
    visited.add(rootJob.id);
    try {
      const parsed = await loadFolder(rootJob);
      accept(rootJob, parsed);
      foldersDone = 1;
      report();
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw new AbortError();
      if (isSessionExpired(error)) throw error;
      failures.push({ url: rootUrl, folderPath: [], error: (error && error.message) || String(error) });
    }

    if (pending > 0) await done;
    if (fatal) throw fatal;
    // 网络完成顺序只影响进度。按课程页的链接顺序逐层选路径，重复引用优先用最浅的一处。
    const files = [];
    const queue = [rootJob];
    visited.clear();
    visited.add(rootJob.id);
    seenFileUrls.clear();
    for (let i = 0; i < queue.length; i++) {
      const { id, folderPath } = queue[i];
      const page = pages.get(id);
      if (!page) continue;
      for (const file of page.files) {
        if (seenFileUrls.has(file.url)) continue;
        seenFileUrls.add(file.url);
        files.push({ ...file, folderPath: folderPath.slice() });
      }
      for (const folder of page.folders) {
        if (!folder.id || visited.has(folder.id)) continue;
        visited.add(folder.id);
        queue.push({ id: folder.id, folderPath: folderPath.concat(String(folder.name || folder.id)) });
      }
    }
    return files;
  }

  return {
    scan() {
      if (!started) started = run();
      return started;
    },
    cancel() {
      if (!signal.aborted) controller.abort();
    },
    get failures() {
      return failures.slice();
    }
  };
}
