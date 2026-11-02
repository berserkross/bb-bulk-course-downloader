import { relativePath } from './shared.js';

/** 契约默认值：超大目录可能几万个条目，页面不能被扫描卡死。 */
const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_DEPTH = 8;

/** 非负整数上限；非法值退回默认值（调用方传 undefined/NaN 时不得变成「不限」）。 */
function toLimit(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** kind 缺失时按能力判断：有 getFile 才是文件，能列条目才是目录。 */
function isDirectoryHandle(handle) {
  if (handle.kind === 'directory') return true;
  if (handle.kind === 'file') return false;
  if (typeof handle.getFile === 'function') return false;
  return typeof handle.values === 'function' || typeof handle.getDirectoryHandle === 'function';
}

/** values() 在实现之间可能只有 Symbol.asyncIterator；统一成带 next() 的迭代器。 */
function toIterator(source) {
  if (source && typeof source.next === 'function') return source;
  if (source && typeof source[Symbol.asyncIterator] === 'function') return source[Symbol.asyncIterator]();
  if (source && typeof source[Symbol.iterator] === 'function') return source[Symbol.iterator]();
  return null;
}

/**
 * 扫出磁盘上已有的文件，供 planSkips 比对（契约模块 B）。
 *
 * 返回值是 Map<相对路径, 字节数 | null>：
 * - 相对路径一律用 '/' 连接，且直接复用 relativePath(plan)，与落盘路径同一份来源；
 * - 值为 null 表示条目存在但取不到 size（getFile 抛错 / size 不是有限数）；
 * - 非枚举属性 truncated 为 true 表示因 maxFiles / maxDepth 提前停止，UI 据此提示「只比对了前 N 个」。
 * 无 dirHandle、权限被拒、迭代抛错、getFile 抛错一律不抛，只返回已收集到的部分。
 */
export async function listExistingFiles(dirHandle, { signal, maxFiles = DEFAULT_MAX_FILES, maxDepth = DEFAULT_MAX_DEPTH } = {}) {
  const found = new Map();
  // 挂在 Map 上而不是包一层对象：上层可以直接当 Map 用，UI 仍能读到 truncated。
  Object.defineProperty(found, 'truncated', { value: false, enumerable: false, writable: true, configurable: true });
  if (!dirHandle || typeof dirHandle.values !== 'function') return found;

  const fileLimit = toLimit(maxFiles, DEFAULT_MAX_FILES);
  const depthLimit = toLimit(maxDepth, DEFAULT_MAX_DEPTH);
  let stopped = false;
  const aborted = () => Boolean(signal && signal.aborted);

  async function readSize(handle) {
    try {
      const file = await handle.getFile();
      const size = file ? Number(file.size) : NaN;
      return Number.isFinite(size) && size >= 0 ? size : null;
    } catch {
      return null; // 取不到大小不是错误，该条目照记，值写 null
    }
  }

  async function walk(dir, segments, depth) {
    if (stopped || aborted()) return;
    if (depth > depthLimit) {
      found.truncated = true; // 这一层之下的目录没进去比对
      return;
    }
    let iterator = null;
    try {
      iterator = toIterator(dir.values());
    } catch {
      return; // 目录不可读：当作空目录，保留已收集的部分
    }
    if (!iterator) return;

    for (;;) {
      let step = null;
      try {
        step = await iterator.next();
      } catch {
        return; // 迭代中途抛错：绝不冒泡，保留已收集的部分
      }
      if (stopped || aborted()) return;
      if (!step || step.done) return;
      const handle = step.value;
      if (!handle) continue;
      const name = String(handle.name == null ? '' : handle.name);
      if (!name) continue;

      if (isDirectoryHandle(handle)) {
        await walk(handle, segments.concat(name), depth + 1);
        if (stopped) return;
        continue;
      }

      if (found.size >= fileLimit) {
        stopped = true;
        found.truncated = true;
        return;
      }
      found.set(relativePath({ segments, fileName: name }), await readSize(handle));
      if (aborted()) return;
    }
  }

  try {
    await walk(dirHandle, [], 0);
  } catch {
    /* walk 内部已经吞掉所有异常；这里只兜最后一道 */
  }
  return found;
}
