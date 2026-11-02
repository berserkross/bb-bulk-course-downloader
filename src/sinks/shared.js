/** 两个 sink 共用的纯辅助函数（不碰任何浏览器 API）。 */

export function toMessage(err) {
  if (!err) return '未知错误';
  return err.message || String(err);
}

export function isAbort(err) {
  if (!err) return false;
  return err.name === 'AbortError' || err.code === 20;
}

/**
 * 把一条 Entry 变成落盘计划。
 * buildEntryPath 决定目录结构（preserveTree=false 时用 folder__ 前缀补偿目录），
 * 之后每一段与文件名都再过一遍 sanitizeSegment —— 契约硬规则 5 在这一层兜底，
 * 不依赖上游是否已经 sanitize（sanitizeSegment 幂等）。
 */
export function planFor(entry, { preserveTree, files }) {
  const raw = files.buildEntryPath(entry, { preserveTree: Boolean(preserveTree) }) || {};
  const segments = (Array.isArray(raw.segments) ? raw.segments : [])
    .map((seg) => files.sanitizeSegment(String(seg)))
    .filter(Boolean);
  const fileName = files.sanitizeSegment(String(raw.fileName || entry.name || 'download')) || 'download';
  return { segments, fileName };
}

/**
 * 整批计划 + 去重。
 * 去重必须在这一层做：同目录两个同名课件如果各自 create:true 写下去，
 * 后写的会把先写的覆盖掉（并发下甚至两个流交错写同一个文件）。
 * 用契约里的 dedupePaths，UI 里预览的路径才和真正落盘的路径一致。
 */
export function planBatch(entries, { preserveTree, files }) {
  const plans = entries.map((entry) => planFor(entry, { preserveTree, files }));
  const unique = typeof files.dedupePaths === 'function' ? files.dedupePaths(plans) : plans;
  return unique.map((plan, i) => ({
    entry: entries[i],
    segments: Array.isArray(plan.segments) ? plan.segments.map(String) : [],
    fileName: String(plan.fileName)
  }));
}

/**
 * 进度上报节流器：文件边界强制上报，块内进度按 throttleMs 节流，
 * 避免 4 并发 × 64KB chunk 把 DOM 刷爆。
 */
export function createReporter({ onProgress, throttleMs = 120 } = {}) {
  let last = 0;
  return function report(payload, force = false) {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - last < throttleMs) return;
    last = now;
    onProgress(payload);
  };
}
