/**
 * 有界并发池：同时最多 width 个 worker 存活，worker 从共享游标里逐个取任务。
 * 刻意不用 Promise.all(entries.map(...)) —— 那会一次性排开 N 个任务闭包，
 * 而本项目的目标是「N 千个文件的课程」。
 *
 * control 是「停机闸门」（docs/m3-progress.md §2）：
 * stopped 之后 worker 不再启动新 job，已经在飞的那几个自然跑完 —— 会话过期停机正是这个语义。
 */
export function createControl() {
  const control = {
    stopped: false,
    reason: '',
    stop(reason) {
      if (control.stopped) return;
      control.stopped = true;
      control.reason = reason == null ? '' : String(reason);
    }
  };
  return control;
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
  // 诊断（v2.5.3）：池子收到的东西必须能自证 —— 计划数、实际 job 数、宽度、闸门状态各是两个不同的量
  console.info('[bbdl] pool 入口', {
    itemsType: typeof items,
    itemsLen: items && typeof items.length === 'number' ? items.length : -1,
    isArray: Array.isArray(items),
    jobsLen: jobs.length,
    concurrency,
    concurrencyType: typeof concurrency,
    workerType: typeof worker,
    controlStopped: Boolean(control && control.stopped),
    signalAborted: Boolean(signal && signal.aborted)
  });
  if (!jobs.length) return;
  const width = Math.min(Math.max(1, Math.floor(concurrency) || 1), jobs.length);
  let cursor = 0;
  console.info('[bbdl] pool 起点', { width, jobsLen: jobs.length });

  // 停机判定只发生在「取下一个 job」之前：取号与启动之间没有 await，
  // 所以 stopped 一旦置真，不可能再有一个新 job 溜进来。
  const stopped = () => Boolean(control && control.stopped) || Boolean(signal && signal.aborted);

  async function drain() {
    while (cursor < jobs.length) {
      if (stopped()) return;
      const job = jobs[cursor];
      cursor += 1;
      await worker(job);
    }
  }

  // worker 数组用显式循环：Array.from 在宿主页面里可能已不是原生实现（见上）
  const workers = [];
  for (let i = 0; i < width; i += 1) workers.push(drain());
  await Promise.all(workers);
  console.info('[bbdl] pool 结束', { jobsLen: jobs.length, cursor, width });
}
