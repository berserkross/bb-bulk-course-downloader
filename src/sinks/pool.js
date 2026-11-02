/**
 * 有界并发池：同时最多 width 个 worker 存活，worker 从共享游标里逐个取任务。
 * 刻意不用 Promise.all(entries.map(...)) —— 那会一次性排开 N 个任务闭包，
 * 而本项目的目标是「N 千个文件的课程」。
 */
export async function runPool(items, concurrency, worker, { signal } = {}) {
  const jobs = Array.from(items || []);
  if (!jobs.length) return;
  const width = Math.min(Math.max(1, Math.floor(concurrency) || 1), jobs.length);
  let cursor = 0;

  async function drain() {
    while (cursor < jobs.length) {
      if (signal && signal.aborted) return;
      const job = jobs[cursor];
      cursor += 1;
      await worker(job);
    }
  }

  await Promise.all(Array.from({ length: width }, drain));
}
