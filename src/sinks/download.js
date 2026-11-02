import { runPool } from './pool.js';
import { planBatch, createReporter, isAbort, toMessage } from './shared.js';

/** 点击后延迟回收 blob URL：立刻 revoke 会在部分 Chrome 版本上打断下载。 */
const REVOKE_DELAY_MS = 60000;

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
 */
export function createDownloadSink({
  settings = {},
  signal,
  total = 0,
  files,
  doc = globalThis.document,
  urlApi = globalThis.URL,
  schedule = (fn, ms) => setTimeout(fn, ms)
} = {}) {
  if (!files || typeof files.buildEntryPath !== 'function' || typeof files.sanitizeSegment !== 'function') {
    throw new Error('createDownloadSink 需要 files 依赖（buildEntryPath / sanitizeSegment）');
  }
  const concurrency = Math.max(1, Math.floor(settings.downloadConcurrency) || 1);

  async function download(entries, fetcher, { onProgress } = {}) {
    const list = Array.from(entries || []);
    const totalCount = total || list.length;
    const ok = [];
    const failed = [];
    const plans = planBatch(list, { preserveTree: false, files });
    const report = createReporter({ onProgress });
    let aborted = false;
    let bytes = 0;

    const snapshot = (state, name) => ({
      state,
      name,
      done: ok.length + failed.length,
      failed: failed.length,
      total: totalCount,
      bytes
    });

    report(snapshot('start', ''), true);

    await runPool(
      plans,
      concurrency,
      async (plan) => {
        const entry = plan.entry;
        if (signal && signal.aborted) {
          aborted = true;
          return;
        }
        // 无目录写权限：目录信息只能由 buildEntryPath 用 folder__ 前缀编码进文件名
        const name = plan.fileName;
        let objectUrl = null;
        try {
          const response = await fetcher.fetchOk(entry.url, { signal });
          const blob = await response.blob();
          bytes += blob.size || 0;
          objectUrl = urlApi.createObjectURL(blob);
          triggerDownload(doc, objectUrl, name);

          const pending = objectUrl;
          objectUrl = null; // 交由延时回收，finally 不再立即 revoke
          schedule(() => {
            try {
              urlApi.revokeObjectURL(pending);
            } catch {
              /* 已经被回收 */
            }
          }, REVOKE_DELAY_MS);

          ok.push(entry);
          report(snapshot('file-done', name), true);
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
            report(snapshot('aborted', name), true);
            return;
          }
          failed.push({ entry, error: toMessage(err) });
          report(snapshot('file-failed', name), true);
        }
      },
      { signal }
    );

    if (signal && signal.aborted) aborted = true;
    report(snapshot('done', ''), true);
    return { ok, failed, aborted };
  }

  return { kind: 'download', download };
}