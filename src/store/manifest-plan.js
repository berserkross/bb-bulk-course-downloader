import { relativePath } from '../sinks/shared.js';

/**
 * 跳过判定与清单比对（纯函数，无 IO）。契约见 docs/sync-contract.md §3 / §4 / §7。
 *
 * 判定顺序分两段：
 *   ① 先只看清单，算出每个条目的五分类 verdict（added / changed / moved / unchanged / unknown）；
 *   ② href 是权威证据：上游覆盖上传过（href 不等）就一律重下并覆盖，磁盘同大小只是巧合，
 *      不能据此认为未变；其余情况下磁盘的物理证据（同名同大小）才参与，可以确认跳过。
 *
 * partial（下了一半）与 failed 一律重下 —— 这条是数据红线，不是实现细节。
 *
 * 清单分支只剩两档：'manifest-unchanged'（href 与 path 都相等，强证据，跳过）与
 * 'manifest-unknown'（没有可比的 href 指纹 → 降级未知 → 重下，靠下一轮写入 href 自愈）。
 * 'manifest' 是 v1 遗留值，仅为兼容保留在联合类型里，planSkips 不再产生它。
 */

/** 只认有限非负数字。契约禁止用 0 表达「未知」，所以 0 是合法大小（空文件）。 */
function knownSize(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function planId(plan) {
  const id = plan && plan.entry ? plan.entry.id : null;
  return id === null || id === undefined ? '' : String(id);
}

function recordPath(record) {
  return record && record.path !== null && record.path !== undefined ? String(record.path) : '';
}

/** 条目的版本指纹：扫描时拿到的原始 href（契约 §2），缺失一律空串。 */
function planHref(plan) {
  const raw = plan && plan.entry ? plan.entry.href : null;
  return raw === null || raw === undefined ? '' : String(raw).trim();
}

/** 清单记录的版本指纹；v1 记录没有这个字段 → 空串 → 按契约 §4 降级为未知。 */
function recordHref(record) {
  const raw = record ? record.href : null;
  return raw === null || raw === undefined ? '' : String(raw).trim();
}

/**
 * 只看清单能得出的五分类结论（不参考磁盘，磁盘证据后面才参与）。
 * @returns {'added' | 'changed' | 'moved' | 'unchanged' | 'unknown'}
 */
function verdictOf({ record, statusDone, pathEqual, uncertain, prevHref, href }) {
  if (!record) return 'added';
  // partial / failed 一律重下（数据红线）；但这不算「上游变更」，是「我们没把握」→ 计 unknown。
  if (!statusDone) return 'unknown';
  if (uncertain) return 'unknown'; // 扫描信息不全，清单证据不成立
  if (!prevHref || !href) return 'unknown'; // v1 记录 / 本次拿不到指纹 → 没有可比的证据
  if (prevHref !== href) return 'changed'; // BB 认为这一版变了
  return pathEqual ? 'unchanged' : 'moved';
}

/**
 * @param {{
 *   plans?: Array<{ entry: object, segments: string[], fileName: string }>,
 *   manifest?: { files?: Record<string, object> } | null,
 *   existingPaths?: Map<string, number | null>,
 *   preserveTree?: boolean,
 *   scanFailed?: boolean
 * }} [input]
 * @returns {{
 *   todo: Array<object>,
 *   skip: Array<{
 *     plan: object,
 *     reason: 'disk' | 'disk-unverified' | 'manifest-unchanged' | 'manifest-unknown' | 'manifest',
 *     size: number | null
 *   }>,
 *   stale: Array<{ id: string, path: string }>,
 *   diff: {
 *     added: number, changed: number, moved: number, unchanged: number,
 *     stale: number, unknown: number, total: number
 *   }
 * }}
 */
export function planSkips({ plans, manifest, existingPaths, preserveTree = true, scanFailed = false } = {}) {
  // preserveTree 只是接口占位：路径早就由 planBatch 按它固化进 segments / fileName 了，
  // 这里再按它重算一遍只会和真实落盘路径分叉。
  void preserveTree;
  const list = Array.isArray(plans) ? plans : [];
  const disk = existingPaths && typeof existingPaths.has === 'function' ? existingPaths : new Map();
  const files = manifest && manifest.files && typeof manifest.files === 'object' ? manifest.files : {};
  // 磁盘清单被截断（truncated 是非枚举属性）或本轮有扫描失败：信息不全 → 未命中磁盘的条目一律降级为未知。
  const uncertain = disk.truncated === true || scanFailed === true;

  const todo = [];
  const skip = [];
  const matched = new Set();
  // 五个桶必须是本次计划的完整划分：added + changed + moved + unchanged + unknown === total。
  const diff = { added: 0, changed: 0, moved: 0, unchanged: 0, stale: 0, unknown: 0, total: list.length };

  for (const plan of list) {
    const path = relativePath(plan);
    const id = planId(plan);
    const record = id && Object.prototype.hasOwnProperty.call(files, id) ? files[id] : null;
    const entrySize = knownSize(plan && plan.entry ? plan.entry.size : undefined);
    const recordSize = knownSize(record ? record.size : null);
    // 期望大小：有清单就按契约用清单的 size；清单缺失时用本次 entry.size 兜底，
    // 否则「没跑过体积探测」这一常见情况下永远无法按大小跳过。
    const expected = recordSize !== null ? recordSize : entrySize;
    const statusDone = Boolean(record) && record.status === 'done';
    const pathEqual = recordPath(record) === path;
    const prevHref = recordHref(record);
    const href = planHref(plan);

    if (id) matched.add(id);

    // ---- ① 先算 verdict（磁盘证据尚未参与） ----
    const verdict = verdictOf({ record, statusDone, pathEqual, uncertain, prevHref, href });
    // href 不等且清单认为已完成 = 上游覆盖上传过的权威证据。
    const hrefOverwritten = statusDone && prevHref !== '' && href !== '' && prevHref !== href;

    // ---- ② 权威证据优先于物理证据 ----
    if (hrefOverwritten) {
      todo.push(plan);
      diff.changed += 1;
      continue;
    }

    // ---- ③ 磁盘分支（后置：只在 href 没给出「上游改过」结论时参与） ----
    if (disk.has(path)) {
      const diskSize = knownSize(disk.get(path));
      if (diskSize !== null && expected !== null) {
        if (diskSize === expected) {
          // 正向物理核实：同名同大小 → 跳过（partial / failed 也照跳，这是既有正向行为）。
          skip.push({ plan, reason: 'disk', size: diskSize });
          if (record) diff.unchanged += 1;
          else diff.added += 1;
          continue;
        }
        // 大小不等：本地那份和期望不是同一个东西，必须重下。
        // 清单说没完成的，这不是「上游变更」，是上一轮没下完 → 计 unknown。
        todo.push(plan);
        if (statusDone) diff.changed += 1;
        else diff.unknown += 1;
        continue;
      }
      // 无法核实的两个分支共享这条守卫：清单已经不认为这份文件完成时，
      // 「磁盘上有个同名文件」不足以证明它就是完成品——否则上一轮下到一半的半截文件
      // 会被当成已完成永久跳过（数据红线：partial / failed 一律重下）。
      if (record && record.status !== 'done') {
        todo.push(plan);
        diff.unknown += 1; // 不是上游变更，是上一轮没下完
        continue;
      }
      if (uncertain) {
        // 磁盘清单本身不完整：这条「同名文件」无法核实，按契约 §4 降级为未知 → 重下。
        todo.push(plan);
        diff.unknown += 1;
        continue;
      }
      // 无法核实大小 → 跳过但打上 unverified 标记让 UI 说实话（一边知道一边不知道同理，
      // 契约没写这条补全，但默默把几 MB 的文件重下一遍同样是错的）。
      skip.push({ plan, reason: 'disk-unverified', size: diskSize !== null ? diskSize : expected });
      diff.unknown += 1;
      continue;
    }

    // ---- ④ 没有磁盘证据：按 verdict 落袋 ----
    if (verdict === 'added') {
      todo.push(plan);
      diff.added += 1;
      continue;
    }
    if (verdict === 'changed') {
      todo.push(plan);
      diff.changed += 1;
      continue;
    }
    if (verdict === 'moved') {
      // 内容没变、位置变了 → 按新路径下载；旧路径文件不删（不重复记进 stale，只作残留提示）。
      todo.push(plan);
      diff.moved += 1;
      continue;
    }
    if (verdict === 'unchanged') {
      skip.push({ plan, reason: 'manifest-unchanged', size: recordSize });
      diff.unchanged += 1;
      continue;
    }
    // 'unknown'：没有任何可比的版本指纹（v1 旧记录 / 本次 entry.href 空 / truncated / scanFailed）。
    // 降级为未知 → 默认重下：宁可多下一次，也不拿「可能变了」的东西冒充未变。
    todo.push(plan);
    diff.unknown += 1;
  }

  // 清单里有、本次扫描没有：只报告，绝不删本地文件（也不进 diff 的五个桶，单独计 stale）。
  const stale = [];
  for (const id of Object.keys(files)) {
    if (matched.has(id)) continue;
    stale.push({ id, path: recordPath(files[id]) });
  }
  diff.stale = stale.length;

  return { todo, skip, stale, diff };
}