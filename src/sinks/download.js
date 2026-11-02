import { runPool, createControl, degradeForSuspect } from './pool.js';
import {
  planBatch,
  createReporter,
  createProgressTracker,
  progressPayload,
  relativePath,
  toFailure,
  isAbort,
  retryReason,
  createFileEmitter,
  withHalted,
  withDegraded,
  listPending
} from './shared.js';
import { StallError, withFileRetry, createMutex, DEFAULT_IDLE_MS, isSessionExpiredError } from './guard.js';

/** 点击后延迟回收 blob URL：立刻 revoke 会在部分 Chrome 版本上打断下载。 */
const REVOKE_DELAY_MS = 60000;
/** 超过这个体积的单个文件，同一时刻只允许一个驻留内存（settings.serializeOverBytes 的默认值）。 */
const DEFAULT_SERIALIZE_OVER_BYTES = 48 * 1024 * 1024;

function pickIdleMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_IDLE_MS;
}

function pickFileRetries(value) {
  if (value == null) return 1;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1;
}

function pickSerializeOver(value) {
  if (value == null) return DEFAULT_SERIALIZE_OVER_BYTES;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SERIALIZE_OVER_BYTES;
}

/** sizeOf 只认「有限正数」：undefined / 0 / NaN 都是「未知体积」，绝不拿 0 去判断大小。 */
function makeSizeLookup(sizeOf) {
  if (typeof sizeOf !== 'function') return () => undefined;
  return (entry) => {
    try {
      const value = Number(sizeOf(entry));
      return Number.isFinite(value) && value > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  };
}

function headerSize(response) {
  const headers = response && response.headers;
  if (!headers || typeof headers.get !== 'function') return undefined;
  const raw = headers.get('content-length');
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * 用户中断 + 本文件停滞看门狗：任一 abort 都要掐断底层 fetch。
 * 返回 dispose，用来在本次尝试结束时摘掉监听 —— 一次下载几千个文件，
 * 挂在同一个外层 signal 上的监听必须跟着尝试一起消失。
 */
function linkSignals(outer, local) {
  if (!outer) return { signal: local, dispose() {} };
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  let attached = false;
  if (outer.aborted || local.aborted) {
    controller.abort();
  } else {
    outer.addEventListener('abort', onAbort, { once: true });
    local.addEventListener('abort', onAbort, { once: true });
    attached = true;
  }
  return {
    signal: controller.signal,
    dispose() {
      if (!attached) return;
      try {
        outer.removeEventListener('abort', onAbort);
        local.removeEventListener('abort', onAbort);
      } catch {
        /* 已经没了 */
      }
    }
  };
}

/**
 * blob() 的停滞看门狗：readable 那条路有 chunk 级超时，blob() 这条路一次也不回调，
 * 只能拿一个整体计时器兜住 —— idleMs 内没有结果就 abort 本地 controller 并判为停滞。
 */
async function readBlobWithWatchdog(response, { idleMs, onTimeout }) {
  let timer = null;
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timer = null;
      reject(onTimeout());
    }, idleMs);
  });
  try {
    return await Promise.race([Promise.resolve(response.blob()), watchdog]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }
}

function triggerDownload(doc, href, name) {
  const a = doc.createElement('a');
  a.href = href;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  if (doc.body && typeof doc.body.appendChild === 'function') doc.body.appendChild(a);
  a.click();
  if (typeof a.remove === 'function') a.remove();
}

/**
 * 无 FSA 环境的兜底 sink：<a download> + blob URL。
 * 浏览器不允许网页写目录，所以目录结构只能靠 folder__ 前缀补偿
 * （buildEntryPath({ preserveTree: false }) 的产物），重名再加 (2)、(3)。
 * 这条路的代价是整份文件进内存，所以超过 serializeOverBytes 时用互斥闸门串行化，
 * 保证同一时刻只有一份大文件驻留。
 */
export function createDownloadSink({
  settings = {},
  signal,
  total = 0,
  files,
  sizeOf,
  doc = globalThis.document,
  urlApi = globalThis.URL,
  schedule = (fn, ms) => setTimeout(fn, ms)
} = {}) {
  if (!files || typeof files.buildEntryPath !== 'function' || typeof files.sanitizeSegment !== 'function') {
    throw new Error('createDownloadSink 需要 files 依赖（buildEntryPath / sanitizeSegment）');
  }
  const concurrency = Math.max(1, Math.floor(settings.downloadConcurrency) || 1);
  const idleMs = pickIdleMs(settings.idleTimeoutMs);
  const fileRetries = pickFileRetries(settings.fileRetries);
  const serializeOverBytes = pickSerializeOver(settings.serializeOverBytes);
  const lookupSize = makeSizeLookup(sizeOf);
  const serializeMutex = createMutex();

  async function download(entries, fetcher, { onProgress, onFileEvent } = {}) {
    const list = Array.from(entries || []);
    const totalCount = total || list.length;
    const ok = [];
    const failed = [];
    const plans = planBatch(list, { preserveTree: false, files });
    const report = createReporter({ onProgress });
    const progress = createProgressTracker(totalCount);
    // 停机闸门无条件开启：会话过期是「停机」而不是「文件下载失败」，这个记录语义绝不能取决于
    // 调用方有没有传 onFileEvent（createFileEmitter(undefined) 本身就是 noop）。
    const emitFile = createFileEmitter(onFileEvent);
    const control = createControl();
    let aborted = false;
    // 疑似限流引发的降速记录（契约 §3.3）：{ from, to } | null，最终挂成不可枚举属性
    let degraded = null;

    // entryId 显式传参：并发文件共用一个 tracker，不能让 payload 取到别的文件的 id
    const emit = (state, path, entryId = '', force = false) =>
      report(progressPayload(progress, state, path, entryId), force);

    emit('start', '', '', true);

    /**
     * 一次完整的尝试：fetch → blob（带停滞看门狗）→ 交给浏览器。
     * 已知体积超过阈值时，整段「读 blob + 交给浏览器」进互斥临界区。
     */
    async function attemptOnce(entry, deliver) {
      const local = new AbortController();
      const linked = linkSignals(signal, local.signal);
      try {
        const response = await fetcher.fetchOk(entry.url, { signal: linked.signal });
        const sizes = [headerSize(response), lookupSize(entry)].filter((n) => n !== undefined);
        const known = sizes.length ? Math.max.apply(null, sizes) : undefined;

        const readAndHand = async () => {
          const blob = await readBlobWithWatchdog(response, {
            idleMs,
            onTimeout: () => {
              try {
                local.abort(); // 掐断本地请求，别让一份停住的文件把连接和内存一起锁死
              } catch {
                /* 已经断了 */
              }
              return new StallError();
            }
          });
          deliver(blob);
          return blob;
        };

        // 大文件串行驻留：其余文件排队等前一个交出去，内存里始终只有一份
        return known !== undefined && known > serializeOverBytes
          ? serializeMutex.run(readAndHand)
          : readAndHand();
      } finally {
        linked.dispose();
      }
    }

    await runPool(
      plans,
      concurrency,
      async (plan) => {
        const entry = plan.entry;
        if (signal && signal.aborted) {
          aborted = true;
          return;
        }
        // 会话过期停机之后不再启动新文件（在飞的那几个自然结束）
        if (control.stopped) return;
        // 无目录写权限：目录信息只能由 buildEntryPath 用 folder__ 前缀编码进文件名
        const name = plan.fileName;
        const label = relativePath(plan);
        let objectUrl = null;
        const entryId = entry && entry.id != null ? String(entry.id) : '';
        emit('file-start', label, entryId, true);
        try {
          const deliver = (blob) => {
            progress.addBytes(blob.size || 0); // 整份 blob 已交给浏览器，没有更细的粒度
            objectUrl = urlApi.createObjectURL(blob);
            triggerDownload(doc, objectUrl, name);

            const pending = objectUrl;
            objectUrl = null; // 交由延时回收，失败路径不再立即 revoke
            schedule(() => {
              try {
                urlApi.revokeObjectURL(pending);
              } catch {
                /* 已经被回收 */
              }
            }, REVOKE_DELAY_MS);
          };

          const blob = await withFileRetry(
            // withFileRetry 把「本次是第几次」交回来：attempt 计数按文件各一份，并发下互不污染
            (attempt) => {
              emitFile({ type: 'start', entryId, path: label, name, attempt });
              return attemptOnce(entry, deliver);
            },
            {
              attempts: 1 + fileRetries,
              // 只报状态，不改旧字段：'file-retry' 是新增字符串，UI 认识就显示、不认识就忽略
              onRetry: (info) => {
                // 可疑响应 = 疑似限流：这里只转达一次降速（次数由 control 自己封顶）
                if (info && info.suspect) degraded = degradeForSuspect(control, degraded);
                // 此刻第 N 次已失败、第 N+1 次还没开始（契约 §1 的 retry 时机）
                emitFile({
                  type: 'retry',
                  entryId,
                  path: label,
                  name,
                  attempt: info.attempt + 1,
                  reason: retryReason(info.error)
                });
                emit('file-retry', label, entryId, true);
              }
            }
          );

          ok.push(entry);
          progress.endFile(false);
          // 整份 blob 只交一次给浏览器：bytes 是这一份的大小，重试不累加
          emitFile({ type: 'done', entryId, path: label, name, bytes: (blob && blob.size) || 0 });
          emit('file-done', label, entryId, true);
        } catch (err) {
          if (objectUrl) {
            try {
              urlApi.revokeObjectURL(objectUrl);
            } catch {
              /* 已经被回收 */
            }
          }
          if ((signal && signal.aborted) || isAbort(err)) {
            aborted = true;
            emit('aborted', label, entryId, true);
            return;
          }
          if (isSessionExpiredError(err)) {
            // 会话已失效：停机，这个文件既不算成功也不进失败清单，交给 pending 接管
            control.stop('session-expired');
            return;
          }
          const failure = toFailure(entry, plan, err);
          failed.push(failure);
          progress.endFile(true);
          emitFile({ type: 'failed', entryId, path: label, name, error: failure.error });
          emit('file-failed', label, entryId, true);
        }
      },
      { signal, control }
    );

    if (signal && signal.aborted) aborted = true;
    // 用户取消优先：aborted 与 halted 互斥，取消时连 halt 事件也不发
    const halted = control.stopped && !aborted ? control.reason || 'session-expired' : null;
    const pending = halted ? listPending(list, ok, failed) : [];
    if (halted) emitFile({ type: 'halt', entryId: '', path: '', name: '', reason: halted, pending: pending.length });
    emit('done', '', '', true);
    // degraded 与 halted 同法不可枚举：result.degraded 可读，既有整对象断言一字不改
    return withDegraded(
      withHalted({ ok, failed, aborted }, halted ? { reason: halted, pending, pendingCount: pending.length } : null),
      degraded
    );
  }

  return { kind: 'download', download };
}
