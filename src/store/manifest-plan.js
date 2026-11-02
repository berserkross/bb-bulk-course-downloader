import { relativePath } from '../sinks/shared.js';

/**
 * 跳过判定与清单比对（纯函数，无 IO）。契约见 docs/m2-resume.md 模块 A。
 *
 * 判定顺序「先磁盘后清单」，只有 status === 'done' 才允许据清单跳过；
 * partial（下了一半）与 failed 一律重下 —— 这条是数据红线，不是实现细节。
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

/**
 * @param {{
 *   plans?: Array<{ entry: object, segments: string[], fileName: string }>,
 *   manifest?: { files?: Record<string, object> } | null,
 *   existingPaths?: Map<string, number | null>,
 *   preserveTree?: boolean
 * }} [input]
 * @returns {{
 *   todo: Array<object>,
 *   skip: Array<{ plan: object, reason: 'disk' | 'disk-unverified' | 'manifest', size: number | null }>,
 *   stale: Array<{ id: string, path: string }>,
 *   diff: { added: number, changed: number, unchanged: number, stale: number, total: number }
 * }}
 */
export function planSkips({ plans, manifest, existingPaths, preserveTree = true } = {}) {
  // preserveTree 只是接口占位：路径早就由 planBatch 按它固化进 segments / fileName 了，
  // 这里再按它重算一遍只会和真实落盘路径分叉。
  void preserveTree;
  const list = Array.isArray(plans) ? plans : [];
  const disk = existingPaths && typeof existingPaths.has === 'function' ? existingPaths : new Map();
  const files = manifest && manifest.files && typeof manifest.files === 'object' ? manifest.files : {};

  const todo = [];
  const skip = [];
  const matched = new Set();
  let added = 0;
  let changed = 0;
  let unchanged = 0;

  for (const plan of list) {
    const path = relativePath(plan);
    const id = planId(plan);
    const record = id && Object.prototype.hasOwnProperty.call(files, id) ? files[id] : null;
    const entrySize = knownSize(plan && plan.entry ? plan.entry.size : undefined);
    const recordSize = knownSize(record ? record.size : null);
    // 期望大小：有清单就按契约用清单的 size；清单缺失时用本次 entry.size 兜底，
    // 否则「没跑过体积探测」这一常见情况下永远无法按大小跳过。
    const expected = recordSize !== null ? recordSize : entrySize;

    if (id) matched.add(id);

    // diff 与跳过判定同源但口径独立：added + changed + unchanged === 本次文件数。
    if (!record) {
      added += 1;
    } else if (
      record.status === 'done' &&
      (recordPath(record) !== path ||
        (entrySize !== null && recordSize !== null && entrySize !== recordSize))
    ) {
      changed += 1;
    } else {
      unchanged += 1;
    }

    // ---- 判定顺序：先磁盘后清单（契约 1) ~ 5)） ----
    if (disk.has(path)) {
      const diskSize = knownSize(disk.get(path));
      if (diskSize !== null && expected !== null) {
        if (diskSize === expected) {
          // 1) 磁盘上有，且大小对得上 —— 这就是「同名同大小跳过」。
          skip.push({ plan, reason: 'disk', size: diskSize });
          continue;
        }
        // 3) 大小不等：上游更新过，必须重下。
        todo.push(plan);
        continue;
      }
      // 无法核实的两个分支共享这条守卫：清单已经不认为这份文件完成时，
      // 「磁盘上有个同名文件」不足以证明它就是完成品——否则上一轮下到一半的半截文件
      // 会被当成已完成永久跳过（数据红线：partial / failed 一律重下）。
      if (record && record.status !== 'done') {
        todo.push(plan);
        continue;
      }
      if (diskSize === null && expected === null) {
        // 2) 两边都不知道大小：按「已存在」跳过，但打上 unverified 标记让 UI 说实话。
        skip.push({ plan, reason: 'disk-unverified', size: null });
        continue;
      }
      // 契约没写的补全：一边知道一边不知道 → 无法核实，跳过但同样标记 unverified，
      // 而不是默默把几 MB 的文件重下一遍。
      skip.push({ plan, reason: 'disk-unverified', size: diskSize !== null ? diskSize : expected });
      continue;
    }
    if (record && record.status === 'done' && recordPath(record) === path) {
      // 4) 磁盘没法核对（无 FSA / 路径不在），但清单说这份同路径的文件已经完成了。
      skip.push({ plan, reason: 'manifest', size: recordSize });
      continue;
    }
    // 5) 其余都要下：新文件、状态不是 done、路径变过。
    todo.push(plan);
  }

  // 清单里有、本次扫描没有：只报告，绝不删本地文件。
  const stale = [];
  for (const id of Object.keys(files)) {
    if (matched.has(id)) continue;
    stale.push({ id, path: recordPath(files[id]) });
  }

  return {
    todo,
    skip,
    stale,
    diff: { added, changed, unchanged, stale: stale.length, total: list.length }
  };
}
