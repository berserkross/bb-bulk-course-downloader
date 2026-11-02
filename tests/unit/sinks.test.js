import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import * as realFiles from '../../src/bb/files.js';
import { pickDirectory } from '../../src/sinks/picker.js';
import { createFsSink } from '../../src/sinks/fs.js';
import { createDownloadSink } from '../../src/sinks/download.js';
import { planFor, planBatch } from '../../src/sinks/shared.js';
import { createSink } from '../../src/sinks/index.js';

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
