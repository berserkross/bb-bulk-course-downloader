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
/** 相对落盘路径：plan.segments + plan.fileName，和 UI 预览的路径同一份来源。 */
export function relativePath(plan) {
  const segments = Array.isArray(plan && plan.segments) ? plan.segments : [];
  const name = String((plan && plan.fileName) || '');
  return segments.concat(name).filter(Boolean).join('/');
}

/** 抹掉 URL 的 query / hash：带签名的地址不进日志和失败文案。 */
export function stripQuery(url) {
  const text = String(url == null ? '' : url);
  const cut = text.search(/[?#]/);
  return cut === -1 ? text : text.slice(0, cut);
}

/** 把文案里出现的每个 URL 都抹掉 query，其余字符原样保留。 */
export function redactUrls(message) {
  return String(message == null ? '' : message).replace(/https?:\/\/[^\s"'<>()\[\]{}，。；）]+/g, (url) => stripQuery(url));
}

/**
 * 进度负载：两个 sink 的全部上报都由这两个函数产出，字段含义只在这里写一次。
 * - filesDone / filesTotal：已结束的文件数（成功 + 失败）/ 本批文件数
 * - bytesDone：已经真正写进磁盘（fs）或已经交给浏览器（download）的字节数，
 *   不是待下载总量；写失败被 abort 掉的那部分也计入，因为计数器只增不减（单调不减）。
 * - bytesTotal：已知总字节数；未知时恒为 0（响应没给长度就是未知，绝不出 NaN）
 * - currentPath：当前文件的相对路径；批次级事件为空串
 * - state / name / done / failed / total / bytes 是旧字段别名，保留给既有 UI
 */
export function createProgressTracker(filesTotal = 0) {
  const tracker = {
    filesTotal: Math.max(0, Math.floor(filesTotal) || 0),
    filesDone: 0,
    bytesDone: 0,
    bytesTotal: 0,
    failed: 0
  };
  tracker.addBytes = (delta) => {
    const n = Number(delta);
    if (Number.isFinite(n) && n > 0) tracker.bytesDone += n;
  };
  tracker.endFile = (isFailed) => {
    tracker.filesDone += 1;
    if (isFailed) tracker.failed += 1;
  };
  return tracker;
}

export function progressPayload(tracker, state, currentPath = '') {
  return {
    state,
    name: currentPath,
    done: tracker.filesDone,
    failed: tracker.failed,
    total: tracker.filesTotal,
    bytes: tracker.bytesDone,
    filesDone: tracker.filesDone,
    filesTotal: tracker.filesTotal,
    bytesDone: tracker.bytesDone,
    bytesTotal: tracker.bytesTotal,
    currentPath
  };
}

/**
 * 失败项契约（UI 直接展示）：name=落盘文件名，path=planBatch 的相对路径，
 * url=原始地址（保留 query，便于重试；脱敏只发生在文案层），error=一句人话且已抹掉 URL 的 query。
 * entry 一并带回，老的失败列表仍在用它取 folderPath。
 */
export function toFailure(entry, plan, err) {
  const path = relativePath(plan);
  const fallbackName = String((entry && entry.name) || '');
  return {
    entry,
    name: (plan && plan.fileName) || fallbackName,
    path,
    url: String((entry && entry.url) || ''),
    error: redactUrls(toMessage(err)) || '下载失败（未提供原因）'
  };
}
