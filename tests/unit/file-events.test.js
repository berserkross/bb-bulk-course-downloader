// M3 §1/§2 的落盘层验收：逐文件事件、会话过期停机、取消优先。
// 只碰 sink 的公开接口（download(entries, fetcher, { onProgress, onFileEvent })），不引 UI、不引 src/index.js。
import test from 'node:test';
import assert from 'node:assert/strict';

import * as realFiles from '../../src/bb/files.js';
import { createFsSink } from '../../src/sinks/fs.js';
import { createDownloadSink } from '../../src/sinks/download.js';
import { isRetriableError } from '../../src/sinks/guard.js';
import { HttpError, SessionExpiredError } from '../../src/bb/http.js';

const files = { ...realFiles };

function entry(over) {
  return Object.assign({ id: 'i', href: 'h', url: 'http://x/a', name: 'a.pdf', folderPath: [] }, over);
}

/** 只记录「目录段 / 文件句柄 / 每次 createWritable 的写入」——够断言落盘字节与 abort 了。 */
function makeRoot(log) {
  const dir = (path) => ({
    path,
    async getDirectoryHandle(seg, opts) {
      log.dirs.push(path.join('/') + ' -> ' + seg + ' create=' + Boolean(opts && opts.create));
      return dir(path.concat(seg));
    },
    async getFileHandle(name, opts) {
      log.files.push(path.join('/') + ' -> ' + name + ' create=' + Boolean(opts && opts.create));
      const full = path.concat(name).join('/');
      return {
        name,
        async createWritable() {
          const rec = { file: full, chunks: [], closed: false, aborted: false };
          log.writes.push(rec);
          return {
            async write(chunk) {
              rec.chunks.push(chunk.byteLength);
            },
            async close() {
              rec.closed = true;
            },
            async abort() {
              rec.aborted = true;
            }
          };
        }
      };
    }
  });
  return dir([]);
}

function newLog() {
  return { dirs: [], files: [], writes: [] };
}

/** 按块吐字节的假响应；failAt 指定第几次 read() 抛错（模拟连接中断）。 */
function chunkedResponse(sizes, opts) {
  const options = opts || {};
  let i = 0;
  return {
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            if (options.failAt === i) throw new Error('网络中断');
            if (i >= sizes.length) return { done: true, value: undefined };
            const size = sizes[i];
            i += 1;
            return { done: false, value: new Uint8Array(size) };
          },
          async cancel() {}
        };
      }
    }
  };
}

function fakeDoc() {
  const clicks = [];
  const doc = {
    body: { appendChild() {} },
    createElement() {
      const a = {
        style: {},
        click() {
          clicks.push({ href: a.href, download: a.download });
        },
        remove() {}
      };
      return a;
    }
  };
  return { doc, clicks };
}

function fakeUrlApi() {
  return {
    made: [],
    revoked: [],
    createObjectURL(blob) {
      const url = 'blob:' + (this.made.length + 1);
      this.made.push({ url, size: blob.size });
      return url;
    },
    revokeObjectURL(url) {
      this.revoked.push(url);
    }
  };
}

/** 事件序列的可读形态：type 或 type:attempt（没有 attempt 的事件不带后缀）。 */
const shape = (event) => event.type + (event.attempt == null ? '' : ':' + event.attempt);

// =========================== 验收 1：顺序与互斥 ===========================

test('file events：同一 entryId 的 start 先于 done/failed，且 done 与 failed 互斥、各最多一次', async () => {
  const log = newLog();
  const sink = createFsSink({
    settings: { downloadConcurrency: 1, fileRetries: 2 },
    dirHandle: makeRoot(log),
    files,
    total: 2
  });
  const good = entry({ id: 'good', url: 'good', name: 'good.pdf', folderPath: ['W'] });
  const bad = entry({ id: 'bad', url: 'bad', name: 'bad.pdf', folderPath: ['W'] });
  const signed = 'https://cdn.example.com/bad.pdf?token=deadbeef&exp=1';
  let badCalls = 0;
  const fetcher = {
    async fetchOk(url) {
      if (url === 'bad') {
        badCalls += 1;
        throw new HttpError(404, signed);
      }
      return chunkedResponse([4, 8]);
    }
  };

  const events = [];
  const result = await sink.download([good, bad], fetcher, { onFileEvent: (e) => events.push(e) });

  // ---- 顺序：每个 entryId 的 start 都在它的终结事件之前，且终结事件恰好一个 ----
  for (const id of ['good', 'bad']) {
    const mine = events.filter((e) => e.entryId === id);
    const starts = mine.filter((e) => e.type === 'start');
    const terminal = mine.filter((e) => e.type === 'done' || e.type === 'failed');
    assert.equal(starts.length, 1, id + ' 的 start 必须恰好一次：' + JSON.stringify(mine.map(shape)));
    assert.equal(starts[0].attempt, 1, id + ' 的首次尝试 attempt 必须是 1');
    assert.equal(terminal.length, 1, id + ' 的 done/failed 必须恰好一次');
    assert.ok(mine.indexOf(starts[0]) < mine.indexOf(terminal[0]), id + ' 的 start 必须先于终点事件');
  }

  // ---- 互斥：good 只有 done，bad 只有 failed ----
  assert.deepEqual(events.filter((e) => e.entryId === 'good').map(shape), ['start:1', 'done']);
  assert.deepEqual(events.filter((e) => e.entryId === 'bad').map(shape), ['start:1', 'failed']);
  assert.equal(badCalls, 1, '404 不在重试白名单里，不得重试');

  // ---- 事件字段 ----
  const doneEvent = events.find((e) => e.type === 'done');
  assert.equal(doneEvent.entryId, 'good');
  assert.equal(doneEvent.path, 'W/good.pdf');
  assert.equal(doneEvent.name, 'good.pdf');
  assert.equal(doneEvent.bytes, 12, 'done.bytes 必须等于这个文件落盘字节');

  const failedEvent = events.find((e) => e.type === 'failed');
  assert.equal(failedEvent.entryId, 'bad');
  assert.match(failedEvent.error, /HTTP 404/, 'failed.error 必须是脱敏后的人话');
  assert.equal(failedEvent.error.includes('?'), false, 'failed.error 不得带 URL query');
  assert.equal(failedEvent.error.includes('token='), false, 'failed.error 不得泄露签名参数');

  assert.deepEqual(result.failed.map((f) => f.entry.id), ['bad']);
  assert.equal(result.halted, null, '没有会话过期时 halted 必须为 null');
  assert.deepEqual(events.filter((e) => e.type === 'halt'), []);
  console.log('  [证据] 逐文件事件序列：', JSON.stringify(events.map((e) => e.entryId + '|' + shape(e))));
});

// =========================== 验收 2：并发重试互不污染 ===========================

test('file events：两个文件并发重试时 retry 事件的 attempt 各自独立（互不污染）', async () => {
  const log = newLog();
  const sink = createFsSink({
    settings: { downloadConcurrency: 2, fileRetries: 2 },
    dirHandle: makeRoot(log),
    files,
    total: 2
  });
  const a = entry({ id: 'a', url: 'a', name: 'a.bin' });
  const b = entry({ id: 'b', url: 'b', name: 'b.bin' });
  // a 连失败两次（网络层），b 只失败一次（内容没读完）—— 若共用一个计数器，a 的 attempt 会被 b 带偏
  const tries = new Map();
  const fetcher = {
    async fetchOk(url) {
      const n = (tries.get(url) || 0) + 1;
      tries.set(url, n);
      if (url === 'a' && n <= 2) throw new TypeError('Failed to fetch');
      if (url === 'b' && n === 1) return chunkedResponse([4, 8], { failAt: 1 });
      return chunkedResponse([4, 8]);
    }
  };

  const events = [];
  const result = await sink.download([a, b], fetcher, { onFileEvent: (e) => events.push(e) });

  assert.deepEqual(result.failed, []);
  assert.equal(result.ok.length, 2);
  assert.equal(tries.get('a'), 3, 'a 应该在第 3 次尝试成功');
  assert.equal(tries.get('b'), 2, 'b 应该在第 2 次尝试成功');

  const seqOf = (id) => events.filter((e) => e.entryId === id).map(shape);
  assert.deepEqual(seqOf('a'), ['start:1', 'retry:2', 'start:2', 'retry:3', 'start:3', 'done']);
  assert.deepEqual(seqOf('b'), ['start:1', 'retry:2', 'start:2', 'done']);

  // retry 的 attempt = N+1，且总是在第 N+1 次 start 之前
  const aEvents = events.filter((e) => e.entryId === 'a');
  assert.equal(aEvents[1].attempt, 2);
  assert.equal(aEvents[2].attempt, 2);
  assert.equal(aEvents[3].attempt, 3);
  assert.equal(aEvents[4].attempt, 3);

  // reason 是一句人话，且绝不含 URL
  for (const e of events.filter((x) => x.type === 'retry')) {
    assert.equal(typeof e.reason, 'string');
    assert.ok(e.reason.length > 0);
    assert.equal(/https?:\/\//.test(e.reason), false, 'retry.reason 不得含 URL：' + e.reason);
  }
  assert.equal(aEvents[1].reason, '网络连接中断');
  console.log(
    '  [证据] 并发重试序列 a =',
    JSON.stringify(seqOf('a')),
    '/ b =',
    JSON.stringify(seqOf('b'))
  );
});

// =========================== 验收 3：会话过期停机 ===========================

test('file events：会话过期 → halted{reason,pending}，只试 1 次、无 retry、不进 failed、不再启动新文件', async () => {
  const log = newLog();
  const sink = createFsSink({
    settings: { downloadConcurrency: 1, fileRetries: 2 },
    dirHandle: makeRoot(log),
    files,
    total: 3
  });
  const first = entry({ id: 'first', url: 'first', name: 'first.bin' });
  const boom = entry({ id: 'boom', url: 'boom', name: 'boom.bin' });
  const third = entry({ id: 'third', url: 'third', name: 'third.bin' });
  const calls = { first: 0, boom: 0, third: 0 };
  const fetcher = {
    async fetchOk(url) {
      calls[url] += 1;
      if (url === 'boom') throw new SessionExpiredError();
      return chunkedResponse([4]);
    }
  };

  const events = [];
  const result = await sink.download([first, boom, third], fetcher, { onFileEvent: (e) => events.push(e) });

  // ---- 不变量 3：只尝试 1 次，且不产生 retry 事件 ----
  assert.equal(isRetriableError(new SessionExpiredError()), false, 'isRetriableError 对 SessionExpiredError 必须返回 false');
  assert.equal(calls.boom, 1, '会话过期只允许 1 次尝试（fileRetries=2 也不得再试）');
  assert.deepEqual(events.filter((e) => e.type === 'retry'), [], '会话过期不得产生 retry 事件');
  const boomEvents = events.filter((e) => e.entryId === 'boom');
  assert.deepEqual(boomEvents.map(shape), ['start:1'], '触发停机的文件只有 1 个 start，没有 done/failed');
  assert.equal(boomEvents[0].attempt, 1, 'attempt 不增长');

  // ---- 不进失败清单，进 pending ----
  assert.deepEqual(result.failed, [], '触发停机的文件不进失败清单');
  assert.equal(result.aborted, false, '停机不是用户取消');
  assert.notEqual(result.halted, null);
  assert.equal(result.halted.reason, 'session-expired');
  assert.deepEqual(result.halted.pending.map((e) => e.id), ['boom', 'third'], 'pending = 未下载的文件（含触发者与从未启动者）');
  assert.equal(result.halted.pendingCount, 2);
  assert.equal(result.halted.pending.some((e) => result.failed.some((f) => f.entry === e)), false, '不变量 2：pending 与 failed 不得重叠');

  // ---- 停机后不再启动新文件；halt 只发一次 ----
  assert.equal(calls.third, 0, '停机之后不再启动新文件');
  assert.deepEqual(events.filter((e) => e.type === 'done').map((e) => e.entryId), ['first']);
  const halts = events.filter((e) => e.type === 'halt');
  assert.equal(halts.length, 1, 'halt 必须只发一次');
  assert.equal(halts[0].reason, 'session-expired');
  assert.equal(halts[0].pending, 2, 'halt.pending = 未下载的文件数');
  console.log(
    '  [证据] 停机事件：',
    JSON.stringify({ halted: { reason: result.halted.reason, pending: result.halted.pendingCount }, haltEvent: halts[0], boomEvents: boomEvents.map(shape) })
  );
});

// =========================== 验收 4：取消优先 ===========================

test('file events：用户取消 → aborted，halted 为 null（取消优先于停机）', async () => {
  const log = newLog();
  const controller = new AbortController();
  const sink = createFsSink({
    settings: { downloadConcurrency: 1, fileRetries: 1 },
    dirHandle: makeRoot(log),
    signal: controller.signal,
    files,
    total: 3
  });
  const first = entry({ id: 'first', url: 'a', name: 'a.bin' });
  const second = entry({ id: 'second', url: 'b', name: 'b.bin' });
  const fetcher = {
    async fetchOk(url) {
      if (url !== 'b') return chunkedResponse([4]);
      let step = 0;
      return {
        ok: true,
        body: {
          getReader() {
            return {
              async read() {
                if (step === 0) {
                  step += 1;
                  return { done: false, value: new Uint8Array(6) };
                }
                controller.abort();
                throw new DOMException('aborted', 'AbortError');
              },
              async cancel() {}
            };
          }
        }
      };
    }
  };

  const events = [];
  const result = await sink.download([first, second, entry({ id: 'third', url: 'c', name: 'c.bin' })], fetcher, {
    onFileEvent: (e) => events.push(e)
  });

  assert.equal(result.aborted, true);
  assert.equal(result.halted, null, '用户取消时 halted 必须为 null');
  assert.deepEqual(result.failed, [], '取消不得记成失败');
  assert.deepEqual(events.filter((e) => e.type === 'halt'), [], '取消优先：连 halt 事件也不发');
  assert.equal(events.filter((e) => e.type === 'done').length, 1);
  console.log('  [证据] 取消路径：aborted=', result.aborted, 'halted=', String(result.halted), '事件=', JSON.stringify(events.map(shape)));
});

// =========================== 验收 5：done.bytes 与 bytesDone 一致 ===========================

test('file events：重试后 done.bytes 是最终落盘字节，逐文件 bytes 之和 === bytesDone', async () => {
  const log = newLog();
  const sink = createFsSink({
    settings: { downloadConcurrency: 2, fileRetries: 1 },
    dirHandle: makeRoot(log),
    files,
    total: 2
  });
  const a = entry({ id: 'a', url: 'a', name: 'a.bin' });
  const b = entry({ id: 'b', url: 'b', name: 'b.bin' });
  const tries = new Map();
  const fetcher = {
    async fetchOk(url) {
      const n = (tries.get(url) || 0) + 1;
      tries.set(url, n);
      // a 的第一次只写 4 字节就断了，第二次写满 28 —— done.bytes 必须是 28，不是 32
      if (url === 'a' && n === 1) return chunkedResponse([4], { failAt: 1 });
      return url === 'a' ? chunkedResponse([4, 8, 16]) : chunkedResponse([10]);
    }
  };

  const events = [];
  const payloads = [];
  const result = await sink.download([a, b], fetcher, {
    onProgress: (p) => payloads.push(p),
    onFileEvent: (e) => events.push(e)
  });

  assert.deepEqual(result.failed, []);
  // 第一次尝试的半截文件必须被 abort，重试重新建 writable 重写
  const aWrites = log.writes.filter((w) => w.file === 'a.bin');
  assert.equal(aWrites.length, 2);
  assert.deepEqual(aWrites[0].chunks, [4]);
  assert.equal(aWrites[0].aborted, true);
  assert.deepEqual(aWrites[1].chunks, [4, 8, 16]);
  assert.equal(aWrites[1].closed, true);

  const doneBytes = new Map(events.filter((e) => e.type === 'done').map((e) => [e.entryId, e.bytes]));
  assert.deepEqual([...doneBytes.entries()].sort(), [
    ['a', 28],
    ['b', 10]
  ]);
  const sum = [...doneBytes.values()].reduce((x, y) => x + y, 0);
  const last = payloads[payloads.length - 1];
  assert.equal(last.state, 'done');
  assert.equal(last.bytesDone, sum, '逐文件 done.bytes 之和必须等于 progressPayload.bytesDone');
  assert.equal(last.bytesDone, 38, '28 + 10 = 38（不回退会是 42）');
  assert.deepEqual(payloads.filter((p) => p.bytesDone > 38), [], '任何一次 payload 的 bytesDone 都不得超过最终落盘量');
  console.log('  [证据] done.bytes =', JSON.stringify([...doneBytes.entries()]), '/ 最终 bytesDone =', last.bytesDone);
});

// =========================== 另一个 sink 的停机路径 ===========================

test('download sink：会话过期同样停机（halted + 不再启动新文件 + 不产生 retry）', async () => {
  const { doc, clicks } = fakeDoc();
  const urlApi = fakeUrlApi();
  const sink = createDownloadSink({
    settings: { downloadConcurrency: 1, fileRetries: 2 },
    files,
    doc,
    urlApi,
    schedule: (fn) => {
      fn();
      return 0;
    },
    total: 3
  });
  const first = entry({ id: 'first', url: 'first', name: 'first.pdf' });
  const boom = entry({ id: 'boom', url: 'boom', name: 'boom.pdf' });
  const third = entry({ id: 'third', url: 'third', name: 'third.pdf' });
  const calls = { first: 0, boom: 0, third: 0 };
  const fetcher = {
    async fetchOk(url) {
      calls[url] += 1;
      if (url === 'boom') throw new SessionExpiredError();
      return { ok: true, async blob() { return { size: 8 }; } };
    }
  };

  const events = [];
  const result = await sink.download([first, boom, third], fetcher, { onFileEvent: (e) => events.push(e) });

  assert.equal(calls.boom, 1, '会话过期只尝试 1 次');
  assert.equal(calls.third, 0, '停机后不再启动新文件');
  assert.deepEqual(result.failed, []);
  assert.equal(result.aborted, false);
  assert.equal(result.halted.reason, 'session-expired');
  assert.deepEqual(result.halted.pending.map((e) => e.id), ['boom', 'third']);
  assert.deepEqual(events.filter((e) => e.type === 'retry'), []);
  assert.deepEqual(events.filter((e) => e.type === 'halt').map((e) => e.pending), [2]);
  assert.equal(events.find((e) => e.type === 'done').bytes, 8, 'download sink 的 done.bytes = 交给浏览器的 blob 大小');
  assert.equal(clicks.length, 1);
  console.log('  [证据] download sink 停机：', JSON.stringify({ halted: result.halted.reason, pending: result.halted.pendingCount, calls }));
});
