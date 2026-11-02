import { runPool } from './pool.js';
import {
  planBatch,
  createReporter,
  createProgressTracker,
  progressPayload,
  relativePath,
  toFailure,
  isAbort
} from './shared.js';

/**
 * FSA 落盘 sink —— 本项目的性能命门。
 * 铁律：Response 的主体流式读取，读完一块立刻 write 一块。
 * 绝不出现 await response.blob() / arrayBuffer()，否则 300MB 的录屏课件会先整个进内存。
 */
export function createFsSink({ settings = {}, dirHandle, signal, total = 0, files } = {}) {
  if (!dirHandle) throw new Error('createFsSink 需要 dirHandle');
  if (!files || typeof files.buildEntryPath !== 'function' || typeof files.sanitizeSegment !== 'function') {
    throw new Error('createFsSink 需要 files 依赖（buildEntryPath / sanitizeSegment）');
  }

  const concurrency = Math.max(1, Math.floor(settings.downloadConcurrency) || 1);
  const preserveTree = settings.preserveTree !== false;
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

  async function writeEntry(fetcher, entry, plan, onChunk) {
    const response = await fetcher.fetchOk(entry.url, { signal });
    const body = response && response.body;
    if (!body || typeof body.getReader !== 'function') {
      throw new Error('响应没有可读主体，拒绝写入空文件');
    }

    const dir = await dirFor(plan.segments);
    const fileHandle = await dir.getFileHandle(plan.fileName, { create: true });
    const writable = await fileHandle.createWritable();
    const reader = body.getReader();
    let written = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || !value.byteLength) continue;
        await writable.write(value); // 边下边写：内存里只有这一个 chunk
        written += value.byteLength;
        onChunk(written, value.byteLength);
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

  async function download(entries, fetcher, { onProgress } = {}) {
    const list = Array.from(entries || []);
    const plans = planBatch(list, { preserveTree, files });
    const totalCount = total || list.length;
    const ok = [];
    const failed = [];
    const report = createReporter({ onProgress });
    const progress = createProgressTracker(totalCount);
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
        const label = relativePath(plan);
        const entryId = entry && entry.id != null ? String(entry.id) : '';
        emit('file-start', label, entryId, true);
        try {
          await writeEntry(fetcher, entry, plan, (_written, delta) => {
            progress.addBytes(delta); // 写完这一块才有资格计入 bytesDone
            emit('progress', label, entryId, false);
          });
          ok.push(entry);
          progress.endFile(false);
          emit('file-done', label, entryId, true);
        } catch (err) {
          if ((signal && signal.aborted) || isAbort(err)) {
            // 半截文件写不出去，既不算成功也不进 failed
            aborted = true;
            emit('aborted', label, entryId, true);
            return;
          }
          failed.push(toFailure(entry, plan, err));
          progress.endFile(true);
          emit('file-failed', label, entryId, true);
        }
      },
      { signal }
    );

    if (signal && signal.aborted) aborted = true;
    emit('done', '', '', true);
    return { ok, failed, aborted };
  }

  return { kind: 'fs', download };
}