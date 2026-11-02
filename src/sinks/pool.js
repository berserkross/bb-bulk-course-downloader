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

export async function runPool(items, concurrency, worker, { signal, control } = {}) {
  const jobs = Array.from(items || []);
  if (!jobs.length) return;
  const width = Math.min(Math.max(1, Math.floor(concurrency) || 1), jobs.length);
  let cursor = 0;

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

  await Promise.all(Array.from({ length: width }, drain));
}
