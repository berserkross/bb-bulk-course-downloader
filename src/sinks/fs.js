import { runPool, createControl } from './pool.js';
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
  listPending
} from './shared.js';
import { createIdleReader, withFileRetry, TruncatedError, DEFAULT_IDLE_MS, isSessionExpiredError } from './guard.js';

/** settings 由接线层注入；读不到就落回契约默认值（fileRetries=1 表示首次失败后额外重试 1 次）。 */
function pickIdleMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_IDLE_MS;
}

function pickFileRetries(value) {
  if (value == null) return 1;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1;
}

/** sizeOf 的返回值只有「有限正数」才算已知体积；undefined / 0 / NaN 一律当未知，绝不用 0 去比。 */
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

/**
 * 只有 content-encoding 为空或 identity 时才允许做「字节数是否等于体积」的校验。
 * 原因：gzip/br 响应里的 Content-Length（以及 Range 探测到的体积）是压缩后的长度，
 * 而传输层已经解压过，我们 write 进磁盘的是解压后的字节 —— 两者天然不等。
 * 拿压缩后的长度去比解压后的字节，会把每一份正常文件都误判成截断，所以必须跳过。
 */
function isIdentityEncoding(response) {
  const headers = response && response.headers;
  const raw = headers && typeof headers.get === 'function' ? headers.get('content-encoding') : '';
  const encoding = String(raw == null ? '' : raw).trim().toLowerCase();
  return encoding === '' || encoding === 'identity';
}

/**
 * FSA 落盘 sink —— 本项目的性能命门。
 * 铁律：Response 的主体流式读取，读完一块立刻 write 一块。
 * 绝不出现 await response.blob() / arrayBuffer()，否则 300MB 的录屏课件会先整个进内存。
 */
export function createFsSink({ settings = {}, dirHandle, signal, total = 0, files, sizeOf } = {}) {
  if (!dirHandle) throw new Error('createFsSink 需要 dirHandle');
  if (!files || typeof files.buildEntryPath !== 'function' || typeof files.sanitizeSegment !== 'function') {
    throw new Error('createFsSink 需要 files 依赖（buildEntryPath / sanitizeSegment）');
  }

  const concurrency = Math.max(1, Math.floor(settings.downloadConcurrency) || 1);
  const preserveTree = settings.preserveTree !== false;
  const idleMs = pickIdleMs(settings.idleTimeoutMs);
  const fileRetries = pickFileRetries(settings.fileRetries);
  const lookupSize = makeSizeLookup(sizeOf);
  const dirCache = new Map();

  function dirFor(segments) {
    const key = segments.join('\u0000');
    let pending = dirCache.get(key);
    if (!pending) {
      pending = openDir(segments);
      dirCache.set(key, pending);
    }
    return pending;
  }

  async function openDir(segments) {
    let dir = dirHandle;
    for (const seg of segments) dir = await dir.getDirectoryHandle(seg, { create: true });
    return dir;
  }

  /**
   * 一次完整的落盘尝试：建 writable → 读流 → 完整性校验 → close。
   * 任何一步失败都会 cancel reader + abort writable，半截文件绝不留在磁盘上被当成成功。
   */
  async function writeAttempt(fetcher, entry, plan, onChunk) {
    const response = await fetcher.fetchOk(entry.url, { signal });
    const body = response && response.body;
    if (!body || typeof body.getReader !== 'function') {
      throw new Error('响应没有可读主体，拒绝写入空文件');
    }

    const dir = await dirFor(plan.segments);
    const fileHandle = await dir.getFileHandle(plan.fileName, { create: true });
    // 重试必须重新 createWritable：不能接着上一次的半截文件往下写
    const writable = await fileHandle.createWritable();
    const reader = createIdleReader(body.getReader(), { idleMs });
    let written = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read(); // 停滞超过 idleMs 会 reject StallError
        if (done) break;
        if (!value || !value.byteLength) continue;
        await writable.write(value); // 边下边写：内存里只有这一个 chunk
        written += value.byteLength;
        onChunk(written, value.byteLength);
      }

      // 连接被掐断时浏览器常常「干净地」结束流 —— 只有拿期望体积比一次才看得出是半截文件
      const expected = lookupSize(entry);
      if (expected !== undefined && isIdentityEncoding(response) && written !== expected) {
        throw new TruncatedError(expected, written);
      }

      await writable.close();
    } catch (err) {
      try {
        await reader.cancel(err);
      } catch {
        /* 已经关了 */
      }
      try {
        await writable.abort(); // 丢弃半截文件，而不是 close 出一个损坏的课件
      } catch {
        /* 已经关了 */
      }
      throw err;
    }

    return written;
  }

  /**
   * 整份文件级的重试：停滞/截断/网络层错误各给一次机会，重试前重新建 writable。
   * attemptBytes 是「本次尝试已经计入 tracker 的字节数」：被 abort 的那一份没有落地，
   * 重试前必须按它回退，否则 bytesDone 会大于真实落盘量（一个文件重试成功却显示 32/28）。
   */
  function writeEntry(fetcher, entry, plan, onChunk, { onRetry, onAttempt, onFileRetry, rollback } = {}) {
    let attemptBytes = 0;
    return withFileRetry(
      // withFileRetry 把「本次是第几次」交回来：attempt 计数天然按文件各一份，并发下互不污染
      (attempt) => {
        attemptBytes = 0;
        if (typeof onAttempt === 'function') onAttempt(attempt);
        return writeAttempt(fetcher, entry, plan, (written, delta) => {
          attemptBytes += delta;
          onChunk(written, delta);
        });
      },
      {
        attempts: 1 + fileRetries,
        onRetry: (info) => {
          if (typeof rollback === 'function') rollback(attemptBytes);
          attemptBytes = 0;
          // onFileRetry 先发：此刻第 N 次已经失败、第 N+1 次还没开始（契约 §1 的 retry 时机）
          if (typeof onFileRetry === 'function') onFileRetry(info);
          if (typeof onRetry === 'function') onRetry(info);
        }
      }
    );
  }

  async function download(entries, fetcher, { onProgress, onFileEvent } = {}) {
    const list = Array.from(entries || []);
    const plans = planBatch(list, { preserveTree, files });
    // 计划数是「到底有没有活干」的第一现场：提交 132 个却计划 0 个，是数据/接线问题，不是下载问题。
    if (plans.length !== list.length) {
      console.warn('[bbdl] 计划数与提交数不一致', { entries: list.length, plans: plans.length, concurrency });
    }
    const totalCount = total || list.length;
    const ok = [];
    const failed = [];
    const report = createReporter({ onProgress });
    const progress = createProgressTracker(totalCount);
    // 停机闸门无条件开启：会话过期是「停机」而不是「文件下载失败」，这个记录语义绝不能取决于
    // 调用方有没有传 onFileEvent（createFileEmitter(undefined) 本身就是 noop）。
    const emitFile = createFileEmitter(onFileEvent);
    const control = createControl();
    let aborted = false;

    // entryId 显式传参：4 个并发文件共用一个 tracker，不能让 payload 取到别的文件的 id
    const emit = (state, path, entryId = '', force = false) =>
      report(progressPayload(progress, state, path, entryId), force);

    emit('start', '', '', true);

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
        const label = relativePath(plan);
        const entryId = entry && entry.id != null ? String(entry.id) : '';
        const fileName = plan.fileName;
        emit('file-start', label, entryId, true);
        try {
          const written = await writeEntry(
            fetcher,
            entry,
            plan,
            (_written, delta) => {
              progress.addBytes(delta); // 写完这一块才有资格计入 bytesDone
              emit('progress', label, entryId, false);
            },
            {
              // 重试会把上一次 abort 掉的字节扣回去，bytesDone 才等于最终落盘量
              rollback: (n) => progress.rollbackBytes(n),
              // 只报状态，不改旧字段：'file-retry' 是新增字符串，UI 认识就显示、不认识就忽略
              onRetry: () => emit('file-retry', label, entryId, true),
              onAttempt: (attempt) => emitFile({ type: 'start', entryId, path: label, name: fileName, attempt }),
              onFileRetry: (info) =>
                emitFile({
                  type: 'retry',
                  entryId,
                  path: label,
                  name: fileName,
                  attempt: info.attempt + 1,
                  reason: retryReason(info.error)
                })
            }
          );
          ok.push(entry);
          progress.endFile(false);
          // 重试是把同一个文件重写一遍：written 是最后一次尝试的落盘字节，不是各次累加
          emitFile({ type: 'done', entryId, path: label, name: fileName, bytes: written });
          emit('file-done', label, entryId, true);
        } catch (err) {
          if ((signal && signal.aborted) || isAbort(err)) {
            // 半截文件写不出去，既不算成功也不进 failed
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
          emitFile({ type: 'failed', entryId, path: label, name: fileName, error: failure.error });
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
    // 提交了文件却一条记录都没产生：这属于落盘层的自相矛盾，宁可报错也不要当成「完成」交上去。
    // 只有 list 为空时才是合法的空批次（续跑/空选择会走到这里）。
    if (list.length && !ok.length && !failed.length && !halted && !aborted) {
      throw new Error(
        '落盘层没有处理任何文件：提交 ' + list.length + ' 个、计划 ' + plans.length + ' 个、并发 ' + concurrency + '。'
      );
    }
    return withHalted(
      { ok, failed, aborted },
      halted ? { reason: halted, pending, pendingCount: pending.length } : null
    );
  }

  return { kind: 'fs', download };
}
