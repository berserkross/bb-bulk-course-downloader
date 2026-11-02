/**
 * 有界并发池：同时最多 width 个 worker 存活，worker 从共享游标里逐个取任务。
 * 刻意不用 Promise.all(entries.map(...)) —— 那会一次性排开 N 个任务闭包，
 * 而本项目的目标是「N 千个文件的课程」。
 *
 * control 同时是两件事的状态（唯一一套，别再造第二套）：
 * - 停机闸门（docs/m3-progress.md §2）：stopped 之后 worker 不再启动新 job，
 *   已经在飞的那几个自然跑完 —— 会话过期停机正是这个语义。
 * - 降速旋钮（docs/m6-login.md §3.1）：width 每次取号都重新读，degrade() 把它减半（下限 1）；
 *   同样只影响「还没开始的 job」，在飞的 worker 不会被掐断。
 */
/** 降速下限：并发永远不低于 1（docs/m6-login.md §3.1）。 */
export const MIN_WIDTH = 1;
/** 单批次最多降 2 次，之后 degrade() 是空操作 —— 「同批次降级总次数 ≤ 2」由 control 自己封顶。 */
export const MAX_DEGRADES = 2;

/** 只有有限的、>= 1 的数才算「已播种的宽度」；0 表示还没播种（由 runPool 填 concurrency）。 */
function normalizeWidth(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= MIN_WIDTH ? n : 0;
}

export function createControl({ width } = {}) {
  let steps = 0;
  const control = {
    // 0 = 还没播种：runPool 一进来就用它收到的 concurrency 填上（契约 §3.1「初始值 = concurrency」）
    width: normalizeWidth(width),
    stopped: false,
    reason: '',
    /**
     * 疑似限流时降一档：宽度减半向下取整（4→2→1），最低 1，单批次最多 2 次，之后是空操作。
     * 返回降级后的 width（本次没降也返回当前 width），调用方据此判断「这次真的降了吗」。
     */
    degrade() {
      if (control.width < MIN_WIDTH) control.width = MIN_WIDTH;
      const from = control.width;
      if (steps >= MAX_DEGRADES) return from;
      const to = Math.max(MIN_WIDTH, Math.floor(from / 2));
      if (to >= from) return from;
      steps += 1;
      control.width = to;
      return to;
    },
    stop(reason) {
      if (control.stopped) return;
      control.stopped = true;
      control.reason = reason == null ? '' : String(reason);
    }
  };
  return control;
}

/**
 * 一次可疑重试触发的降速（docs/m6-login.md §3.2）：三个 sink 的降速入口都走这里。
 * - 次数由 control 自己封顶，sink 不另记账；
 * - 只有真的降了才写一行日志，字段白名单固定（绝不出现 URL / 参数 / 文件名）；
 * - previous 是本批次已记下的 { from, to }：from 留住第一次的值，to 跟着走到最低那一档。
 */
export function degradeForSuspect(control, previous) {
  const last = previous && typeof previous === 'object' ? previous : null;
  if (!control || typeof control.degrade !== 'function') return last;
  const from = Math.floor(Number(control.width));
  // 已经在下限（或宽度还没播种）就别再碰 degrade()：调它也是空操作，
  // 但「同一批次到底降了几次」要能被桩直接数出来，所以这里提前返回。
  if (!(from > MIN_WIDTH)) return last;
  const to = control.degrade();
  if (!(Number.isFinite(from) && Number.isFinite(to)) || to >= from) return last;
  console.info('[bbdl] 降速', { from, to, reason: 'suspect-response' });
  const kept = last && Number.isFinite(Number(last.from)) ? last.from : from;
  return { from: kept, to };
}

/**
 * 别用 Array.from(x, mapFn)：Blackboard 的 Original 版式页面会加载 Prototype.js，
 * 它用 $A 覆盖了 Array.from 且**忽略第二个参数** —— mapFn 永不执行，池子静默空跑。
 * v2.5.4 修的就是这条：真实课程页 plans=5 / cursor=0 / workers=0，体积探测永远未知。
 */
function toList(items) {
  if (!items) return [];
  const out = [];
  for (let i = 0; i < items.length; i += 1) out.push(items[i]);
  return out;
}

export async function runPool(items, concurrency, worker, { signal, control } = {}) {
  const jobs = toList(items);
  if (!jobs.length) return;
  // 契约 §3.1：control.width 的初始值就是 runPool 收到的 concurrency（只有还没播种时才填）。
  // 真开几个 worker 另算：有效宽度还要受 jobs.length 约束（3 个文件配并发 4 只开 3 个 worker）。
  const requested = Math.max(1, Math.floor(concurrency) || 1);
  const initial = Math.min(requested, jobs.length);
  if (control && !(control.width >= 1)) control.width = requested;
  let cursor = 0;

  // 停机判定只发生在「取下一个 job」之前：取号与启动之间没有 await，
  // 所以 stopped 一旦置真，不可能再有一个新 job 溜进来。
  const stopped = () => Boolean(control && control.stopped) || Boolean(signal && signal.aborted);

  // 每轮取号都重新读宽度：降级对「还没开始的条目」立即生效。
  function widthNow() {
    const raw = control ? Number(control.width) : NaN;
    const w = Number.isFinite(raw) ? Math.floor(raw) : 0;
    return Math.min(w >= 1 ? w : initial, jobs.length);
  }

  async function drain(index) {
    while (cursor < jobs.length) {
      if (stopped()) return;
      // 降级后编号 >= 新宽度的 worker 自然退出：它手里那个 job 已经跑完，
      // 所以这一条只会少开新的，绝不会掐断任何在飞的下载。
      if (index >= widthNow()) return;
      const job = jobs[cursor];
      cursor += 1;
      await worker(job);
    }
  }

  // worker 数组用显式循环：Array.from 在宿主页面里可能已不是原生实现（见上）
  const workers = [];
  for (let i = 0; i < initial; i += 1) workers.push(drain(i));
  await Promise.all(workers);
}
