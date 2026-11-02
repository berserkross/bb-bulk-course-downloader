import { resolveFileName } from '../bb/files.js';
import {
  planBatch,
  createReporter,
  createProgressTracker,
  progressPayload,
  relativePath,
  toFailure,
  isAbort,
  createFileEmitter,
  createEntryNamer,
  retryReason,
  withHalted,
  withDegraded
} from './shared.js';
import { createControl, degradeForSuspect } from './pool.js';
import { createIdleReader, withFileRetry, createMutex, isRetriableError, TruncatedError, DEFAULT_IDLE_MS } from './guard.js';
import {
  crc32Update,
  dosDateTime,
  localHeader,
  dataDescriptor,
  centralHeader,
  endOfCentralDirectory,
  toBytes,
  assertEntrySize,
  LOCAL_HEADER_SIZE,
  DESCRIPTOR_SIZE,
  CENTRAL_HEADER_SIZE,
  EOCD_SIZE,
  MAX_ENTRIES
} from './zip-core.js';

/** 点击后延迟回收 blob URL：立刻 revoke 会在部分 Chrome 版本上打断下载。 */
const REVOKE_DELAY_MS = 60000;
/** settings 里没给 zipChunkBytes 时的默认上限（与 src/store.js 的 DEFAULTS 保持一致）。 */
const DEFAULT_ZIP_CHUNK_BYTES = 200 * 1024 * 1024;
/** 没有顶层文件夹可分组的文件（不保留目录结构时就是整批）落在这一组。 */
const FALLBACK_GROUP_NAME = 'course';
/**
 * partial seal：包内出现「重试用尽」的条目之后，剩下的条目不再开始下载。
 * 这条文案就是它们的失败原因（已脱敏，不含 URL / query），下次只重下这几条。
 */
const SKIPPED_AFTER_FAILURE = '同一个压缩包里已经有文件彻底失败，本次未下载；可以稍后重试';

function pickIdleMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_IDLE_MS;
}

function pickFileRetries(value) {
  if (value == null) return 1;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1;
}

function pickChunkBytes(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_ZIP_CHUNK_BYTES;
}

/** sizeOf 只认「有限正数」：undefined / 0 / NaN 都是「未知体积」，绝不拿 0 当体积去比。 */
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
 * 只有 content-encoding 为空或 identity 时才允许做「字节数是否等于体积」的校验：
 * gzip/br 的 Content-Length 是压缩后长度，而传输层已解压，两者天然不等。
 */
function isIdentityEncoding(response) {
  const headers = response && response.headers;
  const raw = headers && typeof headers.get === 'function' ? headers.get('content-encoding') : '';
  const encoding = String(raw == null ? '' : raw).trim().toLowerCase();
  return encoding === '' || encoding === 'identity';
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

/** 包内路径：与 plan 完全同一份来源（segments + fileName），层级不做任何额外改写。 */
function zipPath(plan) {
  const segments = Array.isArray(plan && plan.segments) ? plan.segments : [];
  return segments.concat(String((plan && plan.fileName) || '')).filter(Boolean).join('/');
}

/**
 * ZIP 降级落盘 sink（没有 FSA 的浏览器）。
 *
 * 内存上界 = 一个包，靠三件事守住：
 * 1. 包是串行的：组串行、包串行、包内文件也串行 —— 装下一个包的第一个字节之前，
 *    上一个包的 Blob 已经交给浏览器，并且 pkg.parts / pkg.entries 已经清空；
 * 2. 单个文件先拼进「本次尝试」自己的 parts，成功才并入包；失败/重试的那一份直接丢掉，
 *    半截数据既不会进包，也不会留在包缓冲里；
 * 3. 封包在 createMutex 的临界区里完成（建中央目录 → new Blob → <a download> → 清空包），
 *    所以任意时刻最多只有一个包的字节在被搬运。
 *
 * 代价：ZIP 这条路没有并发。字节必须按顺序追加，并发只会让多个包同时在内存里排队。
 */
export function createZipSink({
  settings = {},
  signal,
  total = 0,
  files,
  sizeOf,
  doc = globalThis.document,
  urlApi = globalThis.URL,
  schedule = (fn, ms) => setTimeout(fn, ms),
  now = () => new Date()
} = {}) {
  if (!files || typeof files.buildEntryPath !== 'function' || typeof files.sanitizeSegment !== 'function') {
    throw new Error('createZipSink 需要 files 依赖（buildEntryPath / sanitizeSegment）');
  }
  const preserveTree = settings.preserveTree !== false;
  const idleMs = pickIdleMs(settings.idleTimeoutMs);
  const fileRetries = pickFileRetries(settings.fileRetries);
  const chunkBytes = pickChunkBytes(settings.zipChunkBytes);
  const lookupSize = makeSizeLookup(sizeOf);
  const deliverMutex = createMutex();

  /** 按顶层文件夹分组；不保留目录结构时整批一包。组内顺序 = plan 顺序。 */
  function groupPlans(plans) {
    if (!preserveTree) return [{ name: FALLBACK_GROUP_NAME, plans }];
    const groups = [];
    const index = new Map();
    for (const plan of plans) {
      const key = plan.segments.length ? String(plan.segments[0]) : FALLBACK_GROUP_NAME;
      let group = index.get(key);
      if (!group) {
        group = { name: key, plans: [] };
        index.set(key, group);
        groups.push(group);
      }
      group.plans.push(plan);
    }
    return groups;
  }

  function newPackage(name) {
    // parts: 已经落好的字节片（顺序即文件顺序）；entries: 中央目录的账目；bytes/cdBytes 都精确累计
    return { name, parts: [], entries: [], bytes: 0, cdBytes: 0 };
  }

  /**
   * 当前包「现在封口」的精确字节数 = 已有的 local header + 数据 + data descriptor
   *   + 中央目录（每条 46 + 文件名长度）+ EOCD。
   * 全部可算：这就是「每包不超过 zipChunkBytes」在已知体积下能精确成立的原因。
   */
  function sealedSize(pkg) {
    return pkg.bytes + pkg.cdBytes + EOCD_SIZE;
  }

  function projectedGrowth(nameLength, estimated) {
    return LOCAL_HEADER_SIZE + nameLength + DESCRIPTOR_SIZE + estimated + CENTRAL_HEADER_SIZE + nameLength;
  }

  /**
   * 该在放这个文件之前先封口吗？
   * - 空包一律放行：单个文件超过上限时它也得有自己的包，否则永远开始不了；
   * - 条目数到顶必须封口（EOCD 的 count 只有 16 位）；
   * - 连头部开销一起算，保证封出来的包 <= zipChunkBytes；
   * - 体积未知（探测不到）时按 0 估：包内已落盘的部分本身就该收口了，不再往里塞。
   */
  function shouldCut(pkg, nameLength, estimated) {
    if (!pkg.entries.length) return false;
    if (pkg.entries.length >= MAX_ENTRIES) return true;
    const expected = estimated === undefined ? 0 : estimated;
    return sealedSize(pkg) + projectedGrowth(nameLength, expected) > chunkBytes;
  }

  /** 一次完整的读文件：CRC 边读边算，字节攒在本次尝试自己的 parts 里（失败即整体丢弃）。 */
  async function readEntry(fetcher, entry, onBytes, onName) {
    const response = await fetcher.fetchOk(entry.url, { signal });
    const body = response && response.body;
    if (!body || typeof body.getReader !== 'function') {
      throw new Error('响应没有可读主体，拒绝写入空文件');
    }
    // 契约 §2.1：响应已经到手、包里还一个字节都没写 —— 真名恰好在这一点落地
    if (typeof onName === 'function') onName(response);
    const reader = createIdleReader(body.getReader(), { idleMs });
    const parts = [];
    let size = 0;
    let crc = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); // 停滞超过 idleMs 会 reject StallError
        if (done) break;
        if (!value || !value.byteLength) continue;
        const chunk = toBytes(value);
        crc = crc32Update(crc, chunk);
        parts.push(chunk);
        size += chunk.byteLength;
        onBytes(chunk.byteLength);
      }
      const expected = lookupSize(entry);
      if (expected !== undefined && isIdentityEncoding(response) && size !== expected) {
        throw new TruncatedError(expected, size);
      }
      // 落完才知道体积：>= 4 GiB 在这里就必须拒绝，绝不让它进包
      assertEntrySize(size);
    } catch (err) {
      // parts 在栈上，throw 之后没有任何引用 —— 半截字节随 GC 一起走，不进包
      try {
        await reader.cancel(err);
      } catch {
        /* 已经断了 */
      }
      throw err;
    }
    return { parts, crc, size };
  }

  /** 封包 + 交给浏览器 + 释放缓冲：整段在互斥闸门里，任意时刻只有一个包在内存里搬。 */
  function flushPackage(pkg) {
    if (!pkg.entries.length) return Promise.resolve(null);
    return deliverMutex.run(async () => {
      const cdOffset = pkg.bytes;
      const cdParts = [];
      for (const item of pkg.entries) {
        const header = centralHeader({
          name: item.name,
          crc: item.crc,
          size: item.size,
          offset: item.offset,
          time: item.time,
          date: item.date
        });
        cdParts.push(header);
        pkg.bytes += header.length;
      }
      const cdSize = pkg.bytes - cdOffset;
      const eocd = endOfCentralDirectory({ count: pkg.entries.length, size: cdSize, offset: cdOffset });
      const blob = new Blob([...pkg.parts, ...cdParts, eocd], { type: 'application/zip' });
      const fileName = pkg.name + '.zip';

      // 先把包缓冲清干净再交出 href：Blob 已经持有字节的副本，
      // 这几行之后本函数栈上只剩一个 Blob，pkg 整体可回收（「内存上界一个包」的释放点）。
      pkg.parts.length = 0;
      pkg.entries.length = 0;
      pkg.bytes = 0;
      pkg.cdBytes = 0;

      const href = urlApi.createObjectURL(blob);
      triggerDownload(doc, href, fileName);
      schedule(() => {
        try {
          urlApi.revokeObjectURL(href);
        } catch {
          /* 已经被回收 */
        }
      }, REVOKE_DELAY_MS);
      return { name: fileName, bytes: blob.size };
    });
  }

  async function download(entries, fetcher, { onProgress, onFileEvent } = {}) {
    const list = Array.from(entries || []);
    const plans = planBatch(list, { preserveTree, files });
    // 契约 §2.3：解析出来的真名要重新做一次冲突登记（planBatch 的 dedupe 在解析之前就跑完了）
    const namer = createEntryNamer({ files, resolveFileName });
    for (const plan of plans) namer.reserve(plan);
    const groups = groupPlans(plans);
    // 原始文件顺序的副本：停机时要按「还没开始的那些」数一下 pending
    const ordered = groups.reduce((acc, group) => acc.concat(group.plans), []);
    const totalCount = total || list.length;
    const ok = [];
    const failed = [];
    // 契约 §2：普通可枚举字段，形如 [{ name: 'Week 1.zip', saved: 3, missing: 2 }]，没有部分交付时为 []
    const partialPackages = [];
    const report = createReporter({ onProgress });
    const progress = createProgressTracker(totalCount);
    // 逐文件事件出口（契约 §1）：createFileEmitter(undefined) 本身就是 noop，
    // 不传 onFileEvent 时行为与改动前逐字节相同。
    const emitFile = createFileEmitter(onFileEvent);
    // zip 天生串行（包必须一个字节一个字节写完）：宽度恒为 1，degrade() 因此必然是空操作，
    // 但仍然接上同一个控制面 —— 契约 §3.2 要求三个 sink 都只有这一个降速入口。
    const control = createControl({ width: 1 });
    let aborted = false;
    let halted = null;
    let degraded = null;
    let cursor = 0;

    const emit = (state, path, entryId = '', force = false) =>
      report(progressPayload(progress, state, path, entryId), force);
    const stopNow = () => aborted || halted !== null;

    emit('start', '', '', true);

    for (const group of groups) {
      let pkg = newPackage(group.name);
      // partial seal 的包内账目：missing = 这个包里因为「彻底失败」而没能进包的条目数
      // （失败那一条 + 之后没机会开始的那几条）；saved 直接用 pkg.entries.length。
      let missing = 0;
      // 一个包内一旦有条目把重试用尽，这个包就到此为止：后面的条目不再开始（契约 §2 partial seal）
      let broken = false;
      for (const plan of group.plans) {
        if (stopNow() || (signal && signal.aborted)) break;
        const entry = plan.entry;
        const entryId = entry && entry.id != null ? String(entry.id) : '';
        // 契约 §2.2：包内路径、事件里的 name、进度里的 path 末段必须同源，两者都读可变绑定；
        // 解析发生在响应到达之后，所以这里先按计划名算一遍（封包闸门要用），解析后再重算。
        let label = relativePath(plan);
        let name = zipPath(plan);
        const plannedNameLength = toBytes(name).length;
        const known = lookupSize(entry);

        if (broken) {
          // 失败的与尚未开始的条目全部进 failed：下次只重下这几条，已经交付的那个包不再重下
          const failure = toFailure(entry, plan, new Error(SKIPPED_AFTER_FAILURE));
          failed.push(failure);
          missing += 1;
          progress.endFile(true);
          // 顺序契约（§1）无例外：没读过字节也算第 1 次尝试，start 先于 failed
          emit('file-start', label, entryId, true);
          emitFile({ type: 'start', entryId, path: label, name, attempt: 1 });
          emitFile({ type: 'failed', entryId, path: label, name, error: failure.error });
          emit('file-failed', label, entryId, true);
          cursor += 1;
          continue;
        }

        if (shouldCut(pkg, plannedNameLength, known)) {
          await flushPackage(pkg);
          pkg = newPackage(group.name);
          missing = 0;
        }

        emit('file-start', label, entryId, true);
        // 第 1 次尝试的 start 发在这里而不是 withFileRetry 内部：下面「已知体积先过 ZIP32 闸门」
        // 那条路一个字节都没读就直接进 failed，而契约 §1 要求任何 entryId 的 start 都先于其终态。
        emitFile({ type: 'start', entryId, path: label, name, attempt: 1 });
        let attemptBytes = 0;
        // 闸门（体积预检）与真正的下载分开记账：闸门一个字节都没读过，算不上「withFileRetry 用尽」，
        // 所以它只让这一条进 failed，包照旧继续往里收文件 —— 既有行为一条都没改。
        let readAttempted = false;
        try {
          // 已知体积先过一遍 ZIP32 闸门：4 GiB 的文件根本不值得下载一遍再拒绝
          if (known !== undefined) assertEntrySize(known);
          readAttempted = true;
          const { parts, crc, size } = await withFileRetry(
            // withFileRetry 把「本次是第几次」交回来：attempt 按文件各一份，重试后从 1 长到 2
            (attempt) => {
              attemptBytes = 0;
              // 第 1 次的 start 已经发过（要盖住上面那条体积闸门），这里补的是每次重试的 start
              if (attempt > 1) emitFile({ type: 'start', entryId, path: label, name, attempt });
              return readEntry(
                fetcher,
                entry,
                (delta) => {
                  attemptBytes += delta;
                  progress.addBytes(delta); // 边读边算 CRC 边统计，内存里只有当前这一块
                  emit('progress', label, entryId, false);
                },
                (response) => {
                  // 解析出真名之后立即重算包内路径：local header、中央目录、事件、进度全用这一份
                  namer.resolve(plan, entry, response);
                  name = zipPath(plan);
                  label = relativePath(plan);
                }
              );
            },
            {
              attempts: 1 + fileRetries,
              // 会话过期永不重试：isRetriableError 对它返回 false（§2），这里显式传一遍让契约可见
              isRetriable: isRetriableError,
              onRetry: (info) => {
                progress.rollbackBytes(attemptBytes); // 上一次尝试的字节没有进包，计数必须回退
                attemptBytes = 0;
                // 可疑响应 = 疑似限流：串行包没有并发可降，这里如实走同一条入口（永远是空操作）
                if (info && info.suspect) degraded = degradeForSuspect(control, degraded);
                // retry 先发：此刻第 N 次已经失败、第 N+1 次的 start 还没发（契约 §1 的时机）
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

          const stamp = dosDateTime(now());
          const nameLength = toBytes(name).length; // 解析后的真名长度：offset 与中央目录都按它记账
          const header = localHeader({ name, time: stamp.time, date: stamp.date });
          const offset = pkg.bytes;
          pkg.parts.push(header);
          pkg.bytes += header.length;
          for (const part of parts) {
            pkg.parts.push(part);
            pkg.bytes += part.byteLength;
          }
          pkg.parts.push(dataDescriptor({ crc, size }));
          pkg.bytes += DESCRIPTOR_SIZE;
          pkg.cdBytes += CENTRAL_HEADER_SIZE + nameLength;
          pkg.entries.push({ name, crc, size, offset, time: stamp.time, date: stamp.date });

          ok.push(entry);
          progress.endFile(false);
          // 重试是把同一个文件重下一遍：size 是最后一次尝试真正落进包里的字节，不是各次累加
          emitFile({ type: 'done', entryId, path: label, name, bytes: size });
          emit('file-done', label, entryId, true);
        } catch (err) {
          if ((signal && signal.aborted) || isAbort(err)) {
            aborted = true;
            emit('aborted', label, entryId, true);
            break;
          }
          if (err && err.name === 'SessionExpiredError') {
            // §2：触发它的这个文件进 pending，不进 failed；此后不再启动任何新文件
            halted = { reason: 'session-expired', pending: ordered.slice(cursor).map((item) => item.entry) };
            emit('halt', label, entryId, true); // 不是 file-failed：filesDone/filesFailed 都不该动
            break;
          }
          const failure = toFailure(entry, plan, err);
          failed.push(failure);
          missing += 1;
          progress.endFile(true);
          // 与失败清单同一句文案：已经过 redactUrls，不带 URL query
          emitFile({ type: 'failed', entryId, path: label, name, error: failure.error });
          emit('file-failed', label, entryId, true);
          // 重试用尽 = 这个包收口（partial seal）：往里写了一半的字节早就丢了，包本身是合法的
          if (readAttempted) broken = true;
        }
        cursor += 1;
      }
      // 封口：包里已经完整收下的条目照旧交出去（停机也不该丢掉前面下好的文件）。
      // 只有「包内有条目彻底失败」才算 partial seal —— 停机/取消时 missing 恒为 0，绝不产出条目。
      const savedCount = pkg.entries.length;
      const delivered = await flushPackage(pkg); // 包里没有条目时返回 null，绝不交空包
      if (delivered && savedCount > 0 && missing > 0) {
        partialPackages.push({ name: delivered.name, saved: savedCount, missing });
      }
    }

    if ((signal && signal.aborted) || aborted) {
      aborted = true;
      halted = null; // 用户取消优先于停机，两者互斥
    }
    // halt 只在这里发一次（循环里那句是既有 onProgress 的 'halt'，语义不动）：
    // halted.pending 是在停机那一刻按原始顺序切出来的，包含触发停机的那一个文件
    if (halted) {
      emitFile({
        type: 'halt',
        entryId: '',
        path: '',
        name: '',
        reason: halted.reason,
        pending: halted.pending.length
      });
    }
    emit('done', '', '', true);
    // halted 与 fs/download 一致做成不可枚举：既有整对象断言靠这一点，也避免日志/展开时把 pending 里的 href 带出去
    return withDegraded(withHalted({ ok, failed, aborted, partialPackages }, halted), degraded);
  }

  return { kind: 'zip', download };
}
