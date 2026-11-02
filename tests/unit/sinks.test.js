import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import * as realFiles from '../../src/bb/files.js';
import { pickDirectory } from '../../src/sinks/picker.js';
import { createFsSink } from '../../src/sinks/fs.js';
import { createDownloadSink } from '../../src/sinks/download.js';
import { planFor, planBatch } from '../../src/sinks/shared.js';
import { createSink } from '../../src/sinks/index.js';
import { HttpError, SessionExpiredError } from '../../src/bb/http.js';

/** 契约里 src/bb/files.js 的真实实现；sink 通过注入拿它，因此这里也注入同一个东西。 */
const files = { ...realFiles };

function entry(over) {
  return Object.assign({ id: 'i', href: 'h', url: 'http://x/a', name: 'a.pdf', folderPath: [] }, over);
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ---------- 可注入的 fake FSA handle：记录目录段顺序、文件句柄、写入块大小 ----------

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

// ---------- 可注入的 fake 响应：真正按块吐字节，绝不一次性给完 ----------

function chunkedResponse(sizes, opts) {
  const options = opts || {};
  let i = 0;
  let cancelled = false;
  return {
    ok: true,
    get cancelled() {
      return cancelled;
    },
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
          async cancel() {
            cancelled = true;
          }
        };
      }
    }
  };
}

function realStreamResponse(sizes) {
  const stream = new ReadableStream({
    start(controller) {
      for (const size of sizes) controller.enqueue(new Uint8Array(size));
      controller.close();
    }
  });
  return new Response(stream);
}

// =========================== pickDirectory ===========================

test('pickDirectory：环境没有 showDirectoryPicker 时返回 null，不抛错', async () => {
  const saved = globalThis.window;
  globalThis.window = {};
  try {
    assert.equal(await pickDirectory({}), null);
    delete globalThis.window;
    assert.equal(await pickDirectory(), null);
  } finally {
    if (saved === undefined) delete globalThis.window;
    else globalThis.window = saved;
  }
});

test('pickDirectory：以 { mode: readwrite } 调用 showDirectoryPicker 并返回 handle', async () => {
  const saved = globalThis.window;
  const seen = [];
  const handle = { name: 'course' };
  globalThis.window = {
    showDirectoryPicker(options) {
      seen.push(options);
      return Promise.resolve(handle);
    }
  };
  try {
    assert.equal(await pickDirectory({}), handle);
    assert.deepEqual(seen, [{ mode: 'readwrite' }]);
  } finally {
    globalThis.window = saved;
  }
});

test('pickDirectory：用户取消(AbortError)返回 null，SecurityError 必须上抛', async () => {
  const saved = globalThis.window;
  try {
    globalThis.window = {
      showDirectoryPicker() {
        return Promise.reject(new DOMException('cancelled', 'AbortError'));
      }
    };
    assert.equal(await pickDirectory({}), null);

    globalThis.window = {
      showDirectoryPicker() {
        return Promise.reject(new DOMException('needs gesture', 'SecurityError'));
      }
    };
    await assert.rejects(() => pickDirectory({}), (err) => err.name === 'SecurityError');
  } finally {
    globalThis.window = saved;
  }
});

function stripLineComments(src) {
  return src
    .split('\n')
    .map((line) => {
      const at = line.indexOf('//');
      return at === -1 ? line : line.slice(0, at);
    })
    .join('\n');
}

test('pickDirectory 源码：showDirectoryPicker({ mode: readwrite }) 之前不得出现 await', async () => {
  const src = await readFile(new URL('../../src/sinks/picker.js', import.meta.url), 'utf8');
  const bodyStart = src.indexOf('export function pickDirectory');
  assert.ok(bodyStart > 0, '找不到 pickDirectory 定义');
  const body = stripLineComments(src.slice(bodyStart));
  const callIdx = body.indexOf("window.showDirectoryPicker({ mode: 'readwrite' })");
  assert.ok(callIdx > 0, '必须以 { mode: readwrite } 直接调用 window.showDirectoryPicker');
  const before = body.slice(0, callIdx);
  assert.equal(before.includes('await'), false, 'showDirectoryPicker 调用之前不得有 await：' + before);
  console.log('  [证据] showDirectoryPicker 之前只有这些可执行语句：', JSON.stringify(before.trim()));
});

// =========================== fs sink ===========================

test('fs sink：沿 folderPath 逐层 create:true 建目录，文件上分块写入并 close', async () => {
  const log = newLog();
  const events = [];
  const sink = createFsSink({ settings: { downloadConcurrency: 2 }, dirHandle: makeRoot(log), files, total: 1 });
  assert.equal(sink.kind, 'fs');

  const fetcher = {
    async fetchOk() {
      return chunkedResponse([4, 8, 16]);
    }
  };
  const target = entry({ url: 'http://x/f', name: '讲义.pdf', folderPath: ['Week 1', 'Slides'] });
  const result = await sink.download([target], fetcher, {
    onProgress: (p) => {
      events.push(p);
    }
  });

  assert.deepEqual(log.dirs, [' -> Week 1 create=true', 'Week 1 -> Slides create=true']);
  assert.deepEqual(log.files, ['Week 1/Slides -> 讲义.pdf create=true']);
  const write = log.writes[0];
  assert.equal(write.file, 'Week 1/Slides/讲义.pdf');
  assert.deepEqual(write.chunks, [4, 8, 16]);
  assert.equal(write.closed, true);
  assert.equal(write.aborted, false);

  // 块内进度按 120ms 节流可能被吞，但字节数必须在文件边界准确累积
  const done = events.find((p) => p.state === 'file-done');
  assert.equal(done.bytes, 28);
  assert.equal(done.done, 1);
  assert.equal(done.total, 1);
  assert.equal(done.name, 'Week 1/Slides/讲义.pdf');
  assert.deepEqual(events.map((p) => p.state).filter((s) => s !== 'progress'), ['start', 'file-start', 'file-done', 'done']);
  assert.deepEqual(result, { ok: [target], failed: [], aborted: false });
});

test('fs sink：大文件被分成 N 次 write，内存里不攒整份文件', async () => {
  const log = newLog();
  const sizes = new Array(100).fill(1024);
  const totalBytes = sizes.reduce((a, b) => a + b, 0);
  const sink = createFsSink({ settings: { downloadConcurrency: 1 }, dirHandle: makeRoot(log), files });
  const fetcher = {
    async fetchOk() {
      return chunkedResponse(sizes);
    }
  };

  const result = await sink.download([entry({ name: 'big.mp4' })], fetcher, {});
  const write = log.writes[0];
  console.log('  [证据] 100 块写入的 chunk 字节数：', JSON.stringify(write.chunks.slice(0, 5)), '... 共', write.chunks.length, '次');
  console.log('  [证据] 单次最大 write =', Math.max(...write.chunks), 'bytes / 文件总字节 =', totalBytes);

  assert.equal(write.chunks.length, 100, '必须写 100 次，而不是 1 次');
  assert.equal(Math.max(...write.chunks), 1024, '任何一次 write 都不应拿到整份文件');
  assert.equal(write.chunks.reduce((a, b) => a + b, 0), totalBytes);
  assert.equal(result.ok.length, 1);
});

test('fs sink：真实 Response（ReadableStream 主体）同样被分块写出', async () => {
  const log = newLog();
  const sink = createFsSink({ settings: { downloadConcurrency: 1 }, dirHandle: makeRoot(log), files });
  const fetcher = {
    async fetchOk() {
      return realStreamResponse([10, 20, 30, 40]);
    }
  };
  const result = await sink.download([entry({ name: 'r.bin' })], fetcher, {});
  const write = log.writes[0];
  console.log('  [证据] 真实 Response 的 write chunk 字节数：', JSON.stringify(write.chunks));
  assert.ok(write.chunks.length >= 2, '真实 Response 也必须被分块写出');
  assert.equal(write.chunks.reduce((a, b) => a + b, 0), 100);
  assert.equal(write.closed, true);
  assert.equal(result.failed.length, 0);
});

test('fs sink：并发受 downloadConcurrency 有界池约束', async () => {
  const log = newLog();
  let inFlight = 0;
  let maxInFlight = 0;
  let started = 0;
  const gate = deferred();
  const fetcher = {
    async fetchOk() {
      started += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (started === 2) gate.resolve();
      await gate.promise;
      inFlight -= 1;
      return chunkedResponse([4]);
    }
  };
  const sink = createFsSink({ settings: { downloadConcurrency: 2 }, dirHandle: makeRoot(log), files });
  const list = [0, 1, 2, 3, 4, 5].map((i) => entry({ url: 'u' + i, name: 'f' + i + '.pdf' }));
  const result = await sink.download(list, fetcher, {});

  assert.equal(maxInFlight, 2, '同时在飞的请求数必须恰为 downloadConcurrency，实测 ' + maxInFlight);
  assert.equal(result.ok.length, 6);
});

test('fs sink：单文件失败写入 failed[] 并继续其它文件', async () => {
  const log = newLog();
  const good = entry({ url: 'good', name: 'good.pdf' });
  const bad = entry({ url: 'bad', name: 'bad.pdf' });
  const sink = createFsSink({ settings: { downloadConcurrency: 2 }, dirHandle: makeRoot(log), files });
  const fetcher = {
    async fetchOk(url) {
      if (url === 'bad') throw new Error('HttpError 500');
      return chunkedResponse([4]);
    }
  };
  const result = await sink.download([bad, good], fetcher, {});

  assert.deepEqual(result.ok, [good]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].entry, bad);
  assert.equal(result.failed[0].error, 'HttpError 500');
  assert.equal(result.aborted, false);
});

test('fs sink：写到一半失败时 abort() 而不是 close()，不留下半截文件', async () => {
  const log = newLog();
  const sink = createFsSink({ settings: { downloadConcurrency: 1 }, dirHandle: makeRoot(log), files });
  const fetcher = {
    async fetchOk() {
      return chunkedResponse([4, 8, 16], { failAt: 2 });
    }
  };
  const result = await sink.download([entry({ name: 'cut.pdf' })], fetcher, {});

  const write = log.writes[0];
  assert.deepEqual(write.chunks, [4, 8]);
  assert.equal(write.closed, false);
  assert.equal(write.aborted, true);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /网络中断/);
});

test('fs sink：signal 已中断时不发起任何请求，aborted 为 true', async () => {
  const log = newLog();
  const controller = new AbortController();
  controller.abort();
  const sink = createFsSink({
    settings: { downloadConcurrency: 2 },
    dirHandle: makeRoot(log),
    signal: controller.signal,
    files
  });
  let calls = 0;
  const fetcher = {
    async fetchOk() {
      calls += 1;
      return chunkedResponse([4]);
    }
  };
  const result = await sink.download([entry(), entry()], fetcher, {});

  assert.equal(calls, 0);
  assert.deepEqual(result, { ok: [], failed: [], aborted: true });
  assert.deepEqual(log.dirs, []);
});

test('fs sink：运行中中断导致 AbortError 时记 aborted，不计入 failed', async () => {
  const log = newLog();
  const controller = new AbortController();
  const sink = createFsSink({
    settings: { downloadConcurrency: 1 },
    dirHandle: makeRoot(log),
    signal: controller.signal,
    files
  });
  const good = entry({ url: 'a', name: 'a.pdf' });
  const fetcher = {
    async fetchOk(url) {
      if (url === 'b') {
        controller.abort();
        throw new DOMException('aborted', 'AbortError');
      }
      return chunkedResponse([4]);
    }
  };
  const result = await sink.download([good, entry({ url: 'b', name: 'b.pdf' }), entry({ url: 'c', name: 'c.pdf' })], fetcher, {});

  assert.deepEqual(result.ok, [good]);
  assert.deepEqual(result.failed, []);
  assert.equal(result.aborted, true);
});

test('fs sink：preserveTree=false 时目录段为空、文件名带 folder__ 前缀', async () => {
  const log = newLog();
  const sink = createFsSink({
    settings: { downloadConcurrency: 1, preserveTree: false },
    dirHandle: makeRoot(log),
    files
  });
  const fetcher = {
    async fetchOk() {
      return chunkedResponse([4]);
    }
  };
  const target = entry({ name: 'a.pdf', folderPath: ['Week 1'] });
  await sink.download([target], fetcher, {});

  assert.deepEqual(log.dirs, []);
  assert.deepEqual(log.files, [' -> Week 1__a.pdf create=true']);
});

test('fs sink：同目录同名两个文件被去重，不会互相覆盖', async () => {
  const log = newLog();
  const sink = createFsSink({ settings: { downloadConcurrency: 2 }, dirHandle: makeRoot(log), files });
  const fetcher = {
    async fetchOk() {
      return chunkedResponse([4]);
    }
  };
  const a = entry({ url: 'a', name: 'same.pdf', folderPath: ['W'] });
  const b = entry({ url: 'b', name: 'same.pdf', folderPath: ['W'] });
  await sink.download([a, b], fetcher, {});

  assert.deepEqual(log.files, ['W -> same.pdf create=true', 'W -> same (2).pdf create=true']);
  assert.equal(new Set(log.writes.map((w) => w.file)).size, 2);
});

test('planFor：每个目录段与文件名都过一遍 sanitizeSegment', () => {
  const calls = [];
  const spyFiles = {
    ...realFiles,
    sanitizeSegment(name) {
      calls.push(name);
      return realFiles.sanitizeSegment(name);
    }
  };
  const plan = planFor(entry({ name: 'a:b?.pdf', folderPath: ['W1/x', 'y '] }), { preserveTree: true, files: spyFiles });
  assert.deepEqual(plan, { segments: ['W1_x', 'y'], fileName: 'a_b_.pdf' });
  // buildEntryPath 自己已经 sanitize 过一次，所以 spy 收到的是已经干净的值（幂等，二次无害）；
  // 关键是「3 次调用」= 两个目录段 + 一个文件名，一段都没漏。
  assert.deepEqual(calls, ['W1_x', 'y', 'a_b_.pdf']);
});

test('planBatch：整批去重后文件名稳定（(2)/(3) 来自契约的 dedupePaths）', () => {
  const list = [entry({ name: 'a.pdf', folderPath: ['W'] }), entry({ name: 'a.pdf', folderPath: ['W'] }), entry({ name: 'a.pdf', folderPath: ['W'] })];
  const plans = planBatch(list, { preserveTree: true, files });
  assert.deepEqual(plans.map((p) => p.segments.concat(p.fileName).join('/')), ['W/a.pdf', 'W/a (2).pdf', 'W/a (3).pdf']);
  assert.equal(plans[1].entry, list[1]);
});

// =========================== download sink ===========================

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

test('download sink：<a download> + blob URL，目录用前缀补偿，并 revokeObjectURL', async () => {
  const { doc, clicks } = fakeDoc();
  const urlApi = fakeUrlApi();
  const sink = createDownloadSink({
    settings: { downloadConcurrency: 2 },
    files,
    doc,
    urlApi,
    schedule: (fn) => {
      fn();
      return 0;
    }
  });
  assert.equal(sink.kind, 'download');

  const fetcher = {
    async fetchOk() {
      return {
        ok: true,
        async blob() {
          return { size: 2048 };
        }
      };
    }
  };
  const a = entry({ url: 'a', name: 'a.pdf', folderPath: ['Week 1'] });
  const b = entry({ url: 'b', name: 'a.pdf', folderPath: ['Week 1'] });
  const result = await sink.download([a, b], fetcher, {});

  assert.deepEqual(clicks, [
    { href: 'blob:1', download: 'Week 1__a.pdf' },
    { href: 'blob:2', download: 'Week 1__a (2).pdf' }
  ]);
  assert.deepEqual(urlApi.revoked, ['blob:1', 'blob:2']);
  assert.equal(result.ok.length, 2);
  assert.equal(result.failed.length, 0);
  assert.equal(result.aborted, false);
});

test('download sink：单文件失败不产生空 URL 且继续其它文件', async () => {
  const { doc, clicks } = fakeDoc();
  const urlApi = fakeUrlApi();
  const sink = createDownloadSink({
    settings: { downloadConcurrency: 2 },
    files,
    doc,
    urlApi,
    schedule: (fn) => {
      fn();
      return 0;
    }
  });
  const fetcher = {
    async fetchOk(url) {
      if (url === 'bad') throw new Error('HttpError 404');
      return {
        ok: true,
        async blob() {
          return { size: 8 };
        }
      };
    }
  };
  const result = await sink.download([entry({ url: 'bad', name: 'bad.pdf' }), entry({ url: 'good', name: 'good.pdf' })], fetcher, {});

  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].download, 'good.pdf');
  assert.deepEqual(urlApi.revoked, ['blob:1']);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].error, 'HttpError 404');
  assert.equal(result.ok.length, 1);
  assert.equal(result.ok[0].url, 'good');
});

// =========================== createSink 工厂 ===========================

test('createSink：dirHandle 存在 → fs sink；否则 → download sink', () => {
  assert.equal(typeof pickDirectory, 'function');
  const withDir = createSink({ settings: {}, dirHandle: makeRoot(newLog()), total: 1 });
  assert.equal(withDir.kind, 'fs');
  assert.equal(typeof withDir.download, 'function');
  const withoutDir = createSink({ settings: {}, dirHandle: null, total: 1 });
  assert.equal(withoutDir.kind, 'download');
  assert.equal(typeof withoutDir.download, 'function');
});
// =========================== 进度负载与失败契约 ===========================

test('fs sink：进度负载 bytesDone 单调不减，最终等于真实写入总字节', async () => {
  const log = newLog();
  const sink = createFsSink({ settings: { downloadConcurrency: 1 }, dirHandle: makeRoot(log), files, total: 3 });
  const sizes = [[4], [8, 16], [2]];
  let call = 0;
  const fetcher = {
    async fetchOk() {
      const chunks = sizes[call];
      call += 1;
      return chunkedResponse(chunks);
    }
  };
  const list = ['a', 'b', 'c'].map((n, k) => entry({ url: 'u' + k, name: n + '.bin' }));
  const events = [];
  const result = await sink.download(list, fetcher, { onProgress: (p) => events.push(p) });

  const realBytes = log.writes.reduce((sum, w) => sum + w.chunks.reduce((a, b) => a + b, 0), 0);
  assert.equal(realBytes, 30);

  for (const p of events) {
    for (const key of ['filesDone', 'filesTotal', 'bytesDone', 'bytesTotal', 'currentPath']) {
      assert.ok(key in p, '进度负载缺字段 ' + key + '：' + JSON.stringify(p));
    }
    assert.equal(Number.isNaN(p.bytesDone), false, 'bytesDone 不得是 NaN');
    assert.equal(Number.isNaN(p.bytesTotal), false, 'bytesTotal 不得是 NaN');
  }

  const seen = events.map((p) => p.bytesDone);
  for (let k = 1; k < seen.length; k += 1) {
    assert.ok(seen[k] >= seen[k - 1], 'bytesDone 必须单调不减，实测 ' + JSON.stringify(seen));
  }

  const done = events[events.length - 1];
  assert.equal(done.state, 'done');
  assert.equal(done.bytesDone, realBytes, '最终 bytesDone 必须等于真实写入字节');
  assert.equal(done.filesDone, 3);
  assert.equal(done.filesTotal, 3);
  assert.equal(done.currentPath, '');
  assert.equal(result.ok.length, 3);
  console.log('  [证据] 进度负载真实样例：', JSON.stringify(events.find((p) => p.state === 'file-done')));
});

test('fs sink：字节总量未知时 bytesTotal 恒为 0（响应不带长度也一样）', async () => {
  const log = newLog();
  const sink = createFsSink({ settings: { downloadConcurrency: 2 }, dirHandle: makeRoot(log), files });
  let call = 0;
  const fetcher = {
    async fetchOk() {
      call += 1;
      if (call === 1) throw new Error('HttpError 500');
      return chunkedResponse([4, 4]);
    }
  };
  const events = [];
  await sink.download([entry({ url: 'x', name: 'x.bin' }), entry({ url: 'y', name: 'y.bin' })], fetcher, {
    onProgress: (p) => events.push(p)
  });

  assert.ok(events.length > 0);
  for (const p of events) {
    assert.equal(p.bytesTotal, 0, '未知总量必须是 0，实测 ' + JSON.stringify(p));
    assert.equal(typeof p.bytesTotal, 'number');
  }
});

test('fs sink：failed 项四字段齐全，error 已抹掉 URL 的 query', async () => {
  const log = newLog();
  const sink = createFsSink({ settings: { downloadConcurrency: 1 }, dirHandle: makeRoot(log), files });
  const signed = 'https://cdn.example.com/v/a.mp4?token=deadbeef&exp=1';
  const bad = entry({ url: signed, name: '坏文件.pdf', folderPath: ['Week 1'] });
  const fetcher = {
    async fetchOk() {
      throw new Error('下载失败：GET ' + signed + ' 返回 HttpError 500');
    }
  };
  const result = await sink.download([bad], fetcher, {});

  assert.equal(result.failed.length, 1);
  const failure = result.failed[0];
  assert.equal(failure.name, '坏文件.pdf');
  assert.equal(failure.path, 'Week 1/坏文件.pdf');
  assert.equal(failure.url, signed, 'url 字段保留原始地址，便于重试');
  assert.match(failure.error, /HttpError 500/);
  assert.match(failure.error, /下载失败/);
  assert.equal(failure.error.includes('?'), false, 'error 不得包含带 query 的完整 URL');
  assert.equal(failure.error.includes('token='), false, 'error 不得泄露 query 参数');
  assert.ok(failure.error.includes('https://cdn.example.com/v/a.mp4'));
  console.log(
    '  [证据] failed 项真实样例：',
    JSON.stringify({ name: failure.name, path: failure.path, url: failure.url, error: failure.error })
  );
});

test('fs sink：中断时未完成的文件不得进 ok，也不能伪装成 failed', async () => {
  const log = newLog();
  const controller = new AbortController();
  const sink = createFsSink({
    settings: { downloadConcurrency: 1 },
    dirHandle: makeRoot(log),
    signal: controller.signal,
    files,
    total: 3
  });
  const first = entry({ url: 'a', name: 'a.bin' });
  const second = entry({ url: 'b', name: 'b.bin' });
  const third = entry({ url: 'c', name: 'c.bin' });
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
  const result = await sink.download([first, second, third], fetcher, { onProgress: (p) => events.push(p) });

  assert.deepEqual(result.ok, [first], '半截文件不得进 ok');
  assert.deepEqual(result.failed, [], '中断不得记成失败');
  assert.equal(result.aborted, true);
  assert.deepEqual(log.writes.map((w) => w.file), ['a.bin', 'b.bin'], '中断后不再发起下一个文件');
  assert.deepEqual(log.writes[1].chunks, [6]);
  assert.equal(log.writes[1].closed, false);
  assert.equal(log.writes[1].aborted, true);

  const done = events[events.length - 1];
  assert.equal(done.filesDone, 1, '未完成的文件不计入 filesDone');
  const seen = events.map((p) => p.bytesDone);
  for (let k = 1; k < seen.length; k += 1) {
    assert.ok(seen[k] >= seen[k - 1], '中断路径下 bytesDone 也不得回退，实测 ' + JSON.stringify(seen));
  }
});

test('download sink：bytesDone 按已交给浏览器的 blob 累加，failed 项四字段齐全', async () => {
  const { doc } = fakeDoc();
  const urlApi = fakeUrlApi();
  const sink = createDownloadSink({
    settings: { downloadConcurrency: 1 },
    files,
    doc,
    urlApi,
    schedule: (fn) => {
      fn();
      return 0;
    },
    total: 2
  });
  const good = entry({ url: 'https://cdn.example.com/g.mp4?sig=abc', name: 'good.mp4', folderPath: ['Week 1'] });
  const badUrl = 'https://cdn.example.com/b.mp4?sig=deadbeef';
  const bad = entry({ url: badUrl, name: 'bad.pdf', folderPath: ['Week 1'] });
  const fetcher = {
    async fetchOk(url) {
      if (url === badUrl) throw new Error('下载失败：GET ' + badUrl + ' 返回 404');
      return {
        ok: true,
        async blob() {
          return { size: 2048 };
        }
      };
    }
  };
  const events = [];
  const result = await sink.download([good, bad], fetcher, { onProgress: (p) => events.push(p) });

  for (const p of events) {
    for (const key of ['filesDone', 'filesTotal', 'bytesDone', 'bytesTotal', 'currentPath']) {
      assert.ok(key in p, '进度负载缺字段 ' + key);
    }
  }
  const done = events[events.length - 1];
  assert.equal(done.bytesDone, 2048);
  assert.equal(done.bytesTotal, 0);
  assert.equal(done.filesDone, 2);
  assert.equal(done.failed, 1);

  const failure = result.failed[0];
  assert.equal(failure.name, 'Week 1__bad.pdf');
  assert.equal(failure.path, 'Week 1__bad.pdf');
  assert.equal(failure.url, badUrl);
  assert.match(failure.error, /返回 404/);
  assert.equal(failure.error.includes('?'), false, 'error 不得包含带 query 的完整 URL');
  assert.equal(failure.error.includes('sig='), false);
  assert.equal(result.ok.length, 1);
});
// =========================== entryId（契约模块 B 的清单回写入口）===========================

test('fs sink：file-start/file-done/file-failed 都带当前文件的 entryId，批次事件为空串', async () => {
  const log = newLog();
  const sink = createFsSink({ settings: { downloadConcurrency: 1 }, dirHandle: makeRoot(log), files, total: 2 });
  const good = entry({ id: 'dt-content-rid-1', url: 'good', name: 'good.pdf' });
  const bad = entry({ id: 'dt-content-rid-2', url: 'bad', name: 'bad.pdf' });
  const fetcher = {
    async fetchOk(url) {
      if (url === 'bad') throw new Error('HttpError 500');
      return chunkedResponse([4]);
    }
  };
  const events = [];
  const result = await sink.download([good, bad], fetcher, { onProgress: (p) => events.push(p) });

  assert.deepEqual(result.failed.length, 1);
  for (const p of events) {
    assert.ok('entryId' in p, '进度负载缺 entryId 字段：' + JSON.stringify(p));
  }
  const byState = (s) => events.filter((p) => p.state === s);
  assert.equal(byState('start')[0].entryId, '', '批次开始事件没有「当前文件」，entryId 必须是空串');
  assert.equal(byState('done')[0].entryId, '', '批次结束事件 entryId 必须是空串');
  assert.equal(byState('file-start')[0].entryId, 'dt-content-rid-1');
  assert.equal(byState('file-done')[0].entryId, 'dt-content-rid-1');
  assert.equal(byState('file-start')[1].entryId, 'dt-content-rid-2');
  assert.equal(byState('file-failed')[0].entryId, 'dt-content-rid-2');
  console.log('  [证据] file-done 事件：', JSON.stringify(byState('file-done')[0]));
});

test('fs sink：并发两个文件的 entryId 不串号（共用 tracker 也不能张冠李戴）', async () => {
  const log = newLog();
  const sink = createFsSink({ settings: { downloadConcurrency: 2 }, dirHandle: makeRoot(log), files, total: 2 });
  const a = entry({ id: 'id-a', url: 'a', name: 'a.pdf' });
  const b = entry({ id: 'id-b', url: 'b', name: 'b.pdf' });
  const fetcher = {
    async fetchOk() {
      return chunkedResponse([4]);
    }
  };
  const events = [];
  await sink.download([a, b], fetcher, { onProgress: (p) => events.push(p) });

  const done = events.filter((p) => p.state === 'file-done');
  const map = new Map(done.map((p) => [p.currentPath, p.entryId]));
  assert.deepEqual([...map.entries()].sort(), [
    ['a.pdf', 'id-a'],
    ['b.pdf', 'id-b']
  ]);
});

test('download sink：file-start/file-failed 也带 entryId', async () => {
  const { doc } = fakeDoc();
  const urlApi = fakeUrlApi();
  const sink = createDownloadSink({
    settings: { downloadConcurrency: 1 },
    files,
    doc,
    urlApi,
    schedule: (fn) => {
      fn();
      return 0;
    },
    total: 2
  });
  const good = entry({ id: 'g-1', url: 'good', name: 'good.pdf' });
  const bad = entry({ id: 'b-1', url: 'bad', name: 'bad.pdf' });
  const fetcher = {
    async fetchOk(url) {
      if (url === 'bad') throw new Error('HttpError 404');
      return {
        ok: true,
        async blob() {
          return { size: 4 };
        }
      };
    }
  };
  const events = [];
  await sink.download([good, bad], fetcher, { onProgress: (p) => events.push(p) });

  const byState = (s) => events.filter((p) => p.state === s);
  assert.equal(byState('file-start')[0].entryId, 'g-1');
  assert.equal(byState('file-done')[0].entryId, 'g-1');
  assert.equal(byState('file-start')[1].entryId, 'b-1');
  assert.equal(byState('file-failed')[0].entryId, 'b-1');
  assert.equal(byState('done')[0].entryId, '');
});

test('progressPayload：entryId 新增但旧字段别名 state/name/done/failed/total/bytes 原样保留', async () => {
  const shared = await import('../../src/sinks/shared.js');
  const tracker = shared.createProgressTracker(3);
  assert.equal(tracker.entryId, '', 'createProgressTracker 必须带 entryId 字段，默认空串');
  tracker.addBytes(10);
  tracker.addBytes(5);
  tracker.endFile(false);
  tracker.endFile(true);

  const p = shared.progressPayload(tracker, 'file-done', 'Week 1/a.pdf', 'id-x');
  assert.deepEqual(p, {
    state: 'file-done',
    name: 'Week 1/a.pdf',
    done: 2,
    failed: 1,
    total: 3,
    bytes: 15,
    entryId: 'id-x',
    filesDone: 2,
    filesTotal: 3,
    bytesDone: 15,
    bytesTotal: 0,
    currentPath: 'Week 1/a.pdf'
  });

  // 不传 entryId 时退回 tracker 上的默认值（旧调用点仍然可用）
  assert.equal(shared.progressPayload(tracker, 'done', '').entryId, '');
  // 老的三参调用点不需要改签名也能跑
  const legacy = shared.progressPayload(tracker, 'start');
  assert.equal(legacy.currentPath, '');
  assert.equal(legacy.entryId, '');
});

// =========================== 大文件与内存加固（guard 接线）===========================

/** 给假响应装上 headers：content-length / content-encoding 是截断校验的两个开关。 */
function headerResponse(res, { encoding = null, contentLength = null } = {}) {
  res.headers = {
    get(key) {
      const k = String(key).toLowerCase();
      if (k === 'content-encoding') return encoding;
      if (k === 'content-length') return contentLength == null ? null : String(contentLength);
      return null;
    }
  };
  return res;
}

/** 先正常吐 sizes 这些块，之后 read() 永不落地 —— 停滞看门狗的唯一触发条件。 */
function stallingBody(sizes) {
  let i = 0;
  return {
    getReader() {
      return {
        async read() {
          if (i < sizes.length) {
            const size = sizes[i];
            i += 1;
            return { done: false, value: new Uint8Array(size) };
          }
          return new Promise(() => {});
        },
        async cancel() {}
      };
    }
  };
}

const statesOf = (events) => events.map((p) => p.state).filter((s) => s !== 'progress');

test('fs sink：reader 停滞超过 idleTimeoutMs → StallError，ok 里没有它', async () => {
  const log = newLog();
  const sink = createFsSink({
    settings: { downloadConcurrency: 1, idleTimeoutMs: 10, fileRetries: 0 },
    dirHandle: makeRoot(log),
    files
  });
  const bad = entry({ name: 'hang.mp4' });
  const fetcher = {
    async fetchOk() {
      return { ok: true, body: stallingBody([8]) };
    }
  };
  const events = [];
  const result = await sink.download([bad], fetcher, { onProgress: (p) => events.push(p) });

  assert.deepEqual(result.ok, [], '停滞的文件绝不允许进 ok');
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /停滞/);
  assert.equal(events.some((p) => p.state === 'file-done'), false, '停滞不得 emit file-done');
  assert.equal(events.some((p) => p.state === 'file-failed'), true);
  assert.equal(result.aborted, false, '停滞是失败，不是中断');
  const write = log.writes[0];
  assert.deepEqual(write.chunks, [8]);
  assert.equal(write.closed, false);
  assert.equal(write.aborted, true);
  console.log('  [证据] 停滞失败文案：', result.failed[0].error);
});

test('fs sink：写入字节少于 sizeOf 声称的体积 → TruncatedError，半截文件被 abort 且不进 ok', async () => {
  const log = newLog();
  const target = entry({ name: 'half.mp4' });
  const sink = createFsSink({
    settings: { downloadConcurrency: 1, fileRetries: 0 },
    dirHandle: makeRoot(log),
    files,
    sizeOf: (e) => (e === target ? 100 : undefined)
  });
  let calls = 0;
  const fetcher = {
    async fetchOk() {
      calls += 1;
      return chunkedResponse([4, 8, 16]); // 只有 28 字节
    }
  };
  const events = [];
  const result = await sink.download([target], fetcher, { onProgress: (p) => events.push(p) });

  assert.equal(calls, 1, 'fileRetries=0 时不得重试');
  assert.deepEqual(result.ok, [], '截断的文件绝不能进 ok');
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /期望 100/);
  assert.match(result.failed[0].error, /实际收到 28/);
  assert.deepEqual(statesOf(events), ['start', 'file-start', 'file-failed', 'done']);
  assert.equal(log.writes[0].closed, false, '截断不得 close 出半截课件');
  assert.equal(log.writes[0].aborted, true);
  console.log('  [证据] 截断失败文案：', result.failed[0].error);
});

test('fs sink：写入字节恰好等于 sizeOf 声称的体积时不误报', async () => {
  const log = newLog();
  const target = entry({ name: 'exact.bin' });
  const sink = createFsSink({
    settings: { downloadConcurrency: 1 },
    dirHandle: makeRoot(log),
    files,
    sizeOf: () => 28
  });
  const result = await sink.download([target], {
    async fetchOk() {
      return chunkedResponse([4, 8, 16]);
    }
  });

  assert.deepEqual(result.ok, [target]);
  assert.deepEqual(result.failed, []);
  assert.equal(log.writes[0].closed, true);
});

test('fs sink：content-encoding=gzip 时不做截断校验（压缩长度 ≠ 解压字节）', async () => {
  const log = newLog();
  const target = entry({ name: 'notes.pdf' });
  const sink = createFsSink({
    settings: { downloadConcurrency: 1 },
    dirHandle: makeRoot(log),
    files,
    // 7 是压缩后的长度；解压后写进磁盘是 28 字节 —— 拿 7 去比必然误报，所以必须跳过
    sizeOf: () => 7
  });
  const fetcher = {
    async fetchOk() {
      return headerResponse(chunkedResponse([4, 8, 16]), { encoding: 'gzip', contentLength: 7 });
    }
  };
  const result = await sink.download([target], fetcher, {});

  assert.deepEqual(result.ok, [target]);
  assert.deepEqual(result.failed, []);
  assert.equal(log.writes.length, 1);
  assert.equal(log.writes[0].closed, true);
  assert.equal(log.writes[0].aborted, false);
  console.log('  [证据] gzip 响应写出 28 字节 / 声称 7 字节，仍判成功：', JSON.stringify(result.ok.length === 1));
});

test('fs sink：sizeOf 返回 undefined（或非正数 / 未注入）时不做截断校验', async () => {
  const variants = [
    ['返回 undefined', () => undefined],
    ['返回 0', () => 0],
    ['返回 NaN', () => Number.NaN],
    ['根本没注入', undefined]
  ];
  for (const [label, sizeOf] of variants) {
    const log = newLog();
    const sink = createFsSink({ settings: { downloadConcurrency: 1 }, dirHandle: makeRoot(log), files, sizeOf });
    const result = await sink.download([entry({ name: 'u.bin' })], {
      async fetchOk() {
        return chunkedResponse([4, 8]);
      }
    });
    assert.deepEqual(result.ok.length, 1, label + ' 时不应判失败');
    assert.deepEqual(result.failed, [], label);
    assert.equal(log.writes[0].closed, true, label);
  }
});

test('fs sink：首次尝试半途失败 → file-retry 后重试成功，第一次的半截文件被 abort', async () => {
  const log = newLog();
  let calls = 0;
  const fetcher = {
    async fetchOk() {
      calls += 1;
      if (calls === 1) return chunkedResponse([4, 8, 16], { failAt: 1 });
      return chunkedResponse([4, 8, 16]);
    }
  };
  const sink = createFsSink({ settings: { downloadConcurrency: 1, fileRetries: 1 }, dirHandle: makeRoot(log), files });
  const target = entry({ id: 'r-1', name: 'retry.bin' });
  const events = [];
  const result = await sink.download([target], fetcher, { onProgress: (p) => events.push(p) });

  assert.equal(calls, 2, '必须真的重新请求一次');
  assert.equal(log.writes.length, 2, '重试必须重新 createWritable，不能接着写');
  assert.deepEqual(log.writes[0].chunks, [4]);
  assert.equal(log.writes[0].aborted, true, '第一次的半截文件必须被 abort');
  assert.equal(log.writes[0].closed, false);
  assert.equal(log.writes[1].closed, true);
  assert.equal(log.writes[1].aborted, false);
  assert.deepEqual(result.ok, [target]);
  assert.deepEqual(result.failed, []);

  const retries = events.filter((p) => p.state === 'file-retry');
  assert.equal(retries.length, 1, '重试前必须上报一次 file-retry');
  assert.equal(retries[0].entryId, 'r-1');
  assert.equal(retries[0].currentPath, 'retry.bin');
  assert.equal(retries[0].bytesTotal, 0, '旧字段别名一字不动');
  assert.deepEqual(statesOf(events), ['start', 'file-start', 'file-retry', 'file-done', 'done']);
});

test('fs sink：HttpError 404 不重试（只请求一次），会话失效也不重试', async () => {
  const log = newLog();
  const sink = createFsSink({ settings: { downloadConcurrency: 1, fileRetries: 2 }, dirHandle: makeRoot(log), files });
  const signed = 'https://cdn.example.com/a.mp4?token=deadbeef&exp=1';
  let calls = 0;
  const result = await sink.download(
    [entry({ url: signed, name: 'a.mp4' })],
    {
      async fetchOk() {
        calls += 1;
        throw new HttpError(404, signed);
      }
    },
    {}
  );

  assert.equal(calls, 1, '404 属于权限/路径问题，重试没有意义');
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].url, signed, '失败项 url 保留 query 供重试');
  assert.equal(result.failed[0].error.includes('?'), false, 'error 文案不得带 query');
  assert.equal(result.failed[0].error.includes('token='), false);

  const log2 = newLog();
  const sink2 = createFsSink({ settings: { downloadConcurrency: 1, fileRetries: 2 }, dirHandle: makeRoot(log2), files });
  let sessionCalls = 0;
  const result2 = await sink2.download(
    [entry({ name: 'b.mp4' })],
    {
      async fetchOk() {
        sessionCalls += 1;
        throw new SessionExpiredError();
      }
    },
    {}
  );
  assert.equal(sessionCalls, 1, '会话失效重试也不会自己好');
  assert.equal(result2.failed.length, 1);
  assert.match(result2.failed[0].error, /会话已失效/);
});

test('fs sink：HttpError 429 可重试，预算用尽后记 failed 并带上最后一次的错误', async () => {
  const log = newLog();
  const sink = createFsSink({ settings: { downloadConcurrency: 1, fileRetries: 2 }, dirHandle: makeRoot(log), files });
  let calls = 0;
  const events = [];
  const result = await sink.download(
    [entry({ name: 'limited.bin' })],
    {
      async fetchOk() {
        calls += 1;
        throw new HttpError(429, 'https://cdn.example.com/x?sig=1');
      }
    },
    { onProgress: (p) => events.push(p) }
  );

  assert.equal(calls, 3, '1 + fileRetries(2) 次都该试过');
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /429/);
  assert.equal(events.filter((p) => p.state === 'file-retry').length, 2);
  assert.equal(events.filter((p) => p.state === 'file-failed').length, 1);
});

test('fs sink：中途 abort → aborted，既不算 ok 也不算 failed，且不重试', async () => {
  const log = newLog();
  const controller = new AbortController();
  const sink = createFsSink({
    settings: { downloadConcurrency: 1, fileRetries: 2 },
    dirHandle: makeRoot(log),
    signal: controller.signal,
    files
  });
  let calls = 0;
  const fetcher = {
    async fetchOk() {
      calls += 1;
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
  const result = await sink.download([entry({ name: 'c.bin' })], fetcher, { onProgress: (p) => events.push(p) });

  assert.equal(calls, 1, '用户中断不得被重试掩盖');
  assert.deepEqual(result.ok, []);
  assert.deepEqual(result.failed, [], '中断不得记成失败');
  assert.equal(result.aborted, true);
  assert.equal(log.writes.length, 1);
  assert.equal(log.writes[0].aborted, true);
  assert.deepEqual(statesOf(events), ['start', 'file-start', 'aborted', 'done']);
  assert.equal(events.some((p) => p.state === 'file-retry'), false);
});

test('download sink：超过 serializeOverBytes 的大文件同一时刻只有 1 个驻留内存', async () => {
  const { doc } = fakeDoc();
  const urlApi = fakeUrlApi();
  let live = 0;
  let maxLive = 0;
  let log = [];

  const makeSink = (serializeOverBytes) =>
    createDownloadSink({
      settings: { downloadConcurrency: 2, serializeOverBytes, idleTimeoutMs: 5000 },
      files,
      doc,
      urlApi,
      schedule: (fn) => {
        fn();
        return 0;
      }
    });

  const makeFetcher = () => ({
    async fetchOk(url) {
      return {
        ok: true,
        headers: { get: (k) => (String(k).toLowerCase() === 'content-length' ? '1048576' : null) },
        async blob() {
          live += 1;
          maxLive = Math.max(maxLive, live);
          log.push('enter:' + url);
          await new Promise((r) => setTimeout(r, 8));
          log.push('exit:' + url);
          live -= 1;
          return { size: 1048576 };
        }
      };
    }
  });

  const list = [entry({ url: 'u1', name: 'big.bin' }), entry({ url: 'u2', name: 'big.bin' })];

  // 阈值 1MB < 已知体积 1MB？不 —— 用「>」判定，所以 1MB 恰好不超；用 1KB 阈值让两个都进临界区
  const guarded = makeSink(1024);
  const result = await guarded.download(list, makeFetcher(), {});
  assert.equal(result.ok.length, 2);
  assert.equal(maxLive, 1, '临界区里只能有一个 blob 驻留内存，实测 ' + maxLive);
  assert.deepEqual(log.map((s) => s.split(':')[0]), ['enter', 'exit', 'enter', 'exit'], '必须成对串行进出');
  console.log('  [证据] 临界区进出序号：', JSON.stringify(log), 'maxLive=', maxLive);

  // 反证：阈值抬到远超已知体积，同样的两个文件就会并行驻留 —— 串行只属于大文件
  live = 0;
  maxLive = 0;
  log = [];
  const unguarded = makeSink(64 * 1024 * 1024);
  const result2 = await unguarded.download(list, makeFetcher(), {});
  assert.equal(result2.ok.length, 2);
  assert.equal(maxLive, 2, '未超阈值时应当并行，实测 ' + maxLive);
});

test('download sink：blob() 停滞 → StallError + abort 本地 controller，不产生空 URL', async () => {
  const { doc, clicks } = fakeDoc();
  const urlApi = fakeUrlApi();
  const sink = createDownloadSink({
    settings: { downloadConcurrency: 1, idleTimeoutMs: 10, fileRetries: 0 },
    files,
    doc,
    urlApi,
    schedule: (fn) => {
      fn();
      return 0;
    }
  });
  const signals = [];
  const fetcher = {
    async fetchOk(url, init) {
      signals.push(init && init.signal);
      return { ok: true, blob: () => new Promise(() => {}) };
    }
  };
  const result = await sink.download([entry({ url: 'hang', name: 'hang.bin' })], fetcher, {});

  assert.deepEqual(result.ok, []);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /停滞/);
  assert.equal(clicks.length, 0, '停滞的文件不得交给浏览器');
  assert.equal(urlApi.made.length, 0, '不得产生空 blob URL');
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, true, '必须 abort 掉本地 controller');
  console.log('  [证据] download sink 停滞失败文案：', result.failed[0].error);
});

test('download sink：网络层 TypeError 后重试成功，只交给浏览器一次', async () => {
  const { doc, clicks } = fakeDoc();
  const urlApi = fakeUrlApi();
  const sink = createDownloadSink({
    settings: { downloadConcurrency: 1, fileRetries: 1 },
    files,
    doc,
    urlApi,
    schedule: (fn) => {
      fn();
      return 0;
    }
  });
  let calls = 0;
  const fetcher = {
    async fetchOk() {
      calls += 1;
      if (calls === 1) throw new TypeError('Failed to fetch');
      return {
        ok: true,
        async blob() {
          return { size: 16 };
        }
      };
    }
  };
  const events = [];
  const target = entry({ url: 'net', name: 'net.bin' });
  const result = await sink.download([target], fetcher, { onProgress: (p) => events.push(p) });

  assert.equal(calls, 2);
  assert.deepEqual(result.ok, [target]);
  assert.deepEqual(result.failed, []);
  assert.equal(clicks.length, 1, '重试成功只能触发一次下载');
  assert.equal(urlApi.made.length, 1);
  assert.equal(events.filter((p) => p.state === 'file-retry').length, 1);
  assert.equal(events.filter((p) => p.state === 'file-done').length, 1);
});

test('createSink 接线：sizeOf 必须原样透传到 fs sink（否则截断校验在生产路径静默失效）', async () => {
  const log = newLog();
  const target = entry({ name: 'wired.mp4' });
  // 关键：完全走 createSink，不直接构造 createFsSink
  const sink = createSink({
    settings: { downloadConcurrency: 1, fileRetries: 0 },
    dirHandle: makeRoot(log),
    total: 1,
    sizeOf: (e) => (e === target ? 100 : undefined)
  });
  assert.equal(sink.kind, 'fs');
  const result = await sink.download(
    [target],
    {
      async fetchOk() {
        return chunkedResponse([4, 8, 16]); // 只有 28 字节
      }
    },
    {}
  );

  assert.deepEqual(result.ok, [], 'sizeOf 被工厂吃掉时这里会假绿成 ok');
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /期望 100/);
  assert.equal(log.writes[0].aborted, true);
  console.log('  [证据] 经 createSink 的截断失败文案：', result.failed[0].error);
});

test('createSink 接线：sizeOf 也必须透传到 download sink（大文件临界区靠它判体积）', async () => {
  const { doc, clicks } = fakeDoc();
  const urlApi = fakeUrlApi();
  let live = 0;
  let maxLive = 0;
  // 响应故意不带 content-length：体积只能来自 sizeOf，才能证明它真的透传到了 download sink
  const fetcher = () => ({
    async fetchOk() {
      return {
        ok: true,
        async blob() {
          live += 1;
          maxLive = Math.max(maxLive, live);
          await new Promise((r) => setTimeout(r, 8));
          live -= 1;
          return { size: 4096 };
        }
      };
    }
  });
  // createSink 不暴露 doc/urlApi 注入口（这是既有设计），所以走真实工厂只能替换全局
  const realDoc = globalThis.document;
  const realUrl = globalThis.URL;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.document = doc;
  globalThis.URL = urlApi;
  // createSink 也不转发 schedule，所以 60s 的 revoke 延时只能靠替换全局计时器压平，
  // 否则这个测试文件会为了一个 revoke 空等一整分钟。
  globalThis.setTimeout = (fn, ms, ...rest) => (ms >= 60000 ? (fn(), 0) : realSetTimeout(fn, ms, ...rest));
  try {
    const sink = createSink({
      settings: { downloadConcurrency: 2, serializeOverBytes: 1024, idleTimeoutMs: 5000 },
      total: 2,
      sizeOf: () => 4096
    });
    assert.equal(sink.kind, 'download');
    const list = [entry({ url: 'w1', name: 'w.bin' }), entry({ url: 'w2', name: 'w.bin' })];
    const result = await sink.download(list, fetcher(), {});

    assert.equal(result.ok.length, 2);
    assert.equal(clicks.length, 2);
    assert.equal(maxLive, 1, 'sizeOf 透传后两个大文件必须串行，实测 ' + maxLive);
    assert.deepEqual(urlApi.revoked.sort(), ['blob:1', 'blob:2'], 'blob URL 仍要按时回收');
    console.log('  [证据] 经 createSink 的 download sink 并发驻留峰值：', maxLive);
  } finally {
    globalThis.document = realDoc;
    globalThis.URL = realUrl;
    globalThis.setTimeout = realSetTimeout;
  }
});

test('fs sink：重试成功时回退上一次 abort 的字节，bytesDone 恒等于最终落盘量', async () => {
  const log = newLog();
  const target = entry({ id: 'rb-1', name: 'rollback.bin' });
  const sink = createFsSink({
    settings: { downloadConcurrency: 1, fileRetries: 1 },
    dirHandle: makeRoot(log),
    files
  });
  let calls = 0;
  const fetcher = {
    async fetchOk() {
      calls += 1;
      // attempt 1：写 4 字节后网络层报错（可重试）；attempt 2：写满 28 字节
      return calls === 1 ? chunkedResponse([4, 8, 16], { failAt: 1 }) : chunkedResponse([4, 8, 16]);
    }
  };
  const events = [];
  const result = await sink.download([target], fetcher, { onProgress: (p) => events.push(p) });

  assert.equal(calls, 2);
  assert.deepEqual(result.ok, [target]);
  const last = events[events.length - 1];
  assert.equal(last.state, 'done');
  assert.equal(last.bytesDone, 28, 'bytesDone 必须等于真实落盘字节数（不回退会是 32）');
  assert.deepEqual(events.filter((p) => p.bytesDone > 28), [], '任何一次 payload 的 bytesDone 都不得超过 28');
  assert.equal(events.some((p) => p.state === 'file-retry'), true);
  console.log(
    '  [证据] 重试后 bytesDone =',
    last.bytesDone,
    '（不回退会是 32）；payload 序列 =',
    JSON.stringify(events.map((p) => p.state + ':' + p.bytesDone))
  );
});

test('fs sink：并发里一个文件重试成功，bytesDone 等于各文件真实字节数之和', async () => {
  const log = newLog();
  const sink = createFsSink({ settings: { downloadConcurrency: 3, fileRetries: 1 }, dirHandle: makeRoot(log), files });
  // 10 + 28 + 6 = 44 字节；b 的第一次尝试先写 4 字节再报错
  const sizes = { a: [4, 6], b: [4, 8, 16], c: [6] };
  const attempts = new Map();
  const fetcher = {
    async fetchOk(url) {
      const key = String(url);
      const n = (attempts.get(key) || 0) + 1;
      attempts.set(key, n);
      if (key === 'b' && n === 1) return chunkedResponse(sizes.b, { failAt: 1 });
      return chunkedResponse(sizes[key]);
    }
  };
  const list = [
    entry({ id: 'a', url: 'a', name: 'a.bin' }),
    entry({ id: 'b', url: 'b', name: 'b.bin' }),
    entry({ id: 'c', url: 'c', name: 'c.bin' })
  ];
  const events = [];
  const result = await sink.download(list, fetcher, { onProgress: (p) => events.push(p) });

  assert.deepEqual(result.failed, []);
  assert.equal(result.ok.length, 3);
  assert.equal(attempts.get('a'), 1);
  assert.equal(attempts.get('b'), 2, 'b 应该重试一次');
  assert.equal(attempts.get('c'), 1);
  const last = events[events.length - 1];
  assert.equal(last.bytesDone, 44, '10 + 28 + 6 应为 44（不回退会是 48）');
  assert.deepEqual(events.filter((p) => p.bytesDone > 44), []);
  console.log('  [证据] 三文件并发（b 重试一次）最终 bytesDone =', last.bytesDone, '/ 真实合计 44');
});
