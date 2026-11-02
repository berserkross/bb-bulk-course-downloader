import test from 'node:test';
import assert from 'node:assert/strict';

import * as realFiles from '../../src/bb/files.js';
import { createZipSink } from '../../src/sinks/zip.js';
import { crc32, SIG_DESCRIPTOR, SIG_LOCAL, SIG_CENTRAL } from '../../src/sinks/zip-core.js';
import { SessionExpiredError } from '../../src/bb/http.js';

const files = { ...realFiles };
const utf8 = new TextEncoder();
const utf8d = new TextDecoder();

function entry(over) {
  return Object.assign({ id: 'i', href: 'h', url: 'http://x/a', name: 'a.pdf', folderPath: [] }, over);
}

function fakeDoc(log) {
  const clicks = [];
  const doc = {
    body: { appendChild() {} },
    createElement() {
      const a = {
        style: {},
        click() {
          clicks.push({ href: a.href, download: a.download });
          if (log) log.push('click');
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
      this.made.push({ url, size: blob.size, blob });
      return url;
    },
    revokeObjectURL(url) {
      this.revoked.push(url);
    }
  };
}

/** 按块吐字节的假响应（绝不一次性给完），块边界故意切在中间。 */
function chunkedResponse(content, log, url) {
  const chunks = [];
  if (content && content.length) {
    chunks.push(content.subarray(0, 1));
    if (content.length > 1) chunks.push(content.subarray(1));
  }
  let i = 0;
  let cancelled = false;
  return {
    ok: true,
    headers: { get: () => '' }, // identity：允许做「字节数 = 体积」校验
    get cancelled() {
      return cancelled;
    },
    body: {
      getReader() {
        return {
          async read() {
            if (log) log.push('chunk:' + url);
            if (i >= chunks.length) return { done: true, value: undefined };
            const value = chunks[i];
            i += 1;
            return { done: false, value };
          },
          async cancel() {
            cancelled = true;
          }
        };
      }
    }
  };
}

function makeFetcher(contents, { log, fail } = {}) {
  const attempts = new Map();
  const fetcher = {
    attempts,
    async fetchOk(url) {
      const n = (attempts.get(url) || 0) + 1;
      attempts.set(url, n);
      if (log) log.push('fetch:' + url);
      if (typeof fail === 'function') {
        const err = fail(url, n);
        if (err) throw err;
      }
      return chunkedResponse(contents[url], log, url);
    }
  };
  return fetcher;
}

/**
 * 最小的 ZIP 解析器：只按 EOCD → 中央目录 → local header 的顺序读，
 * 顺手校验 data descriptor，这样「CRC 与长度写在两处且一致」是被真的读出来验的。
 */
function parseZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.ok(eocd >= 0, '找不到 EOCD');
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  assert.equal(cdOffset + cdSize, eocd, '中央目录必须紧贴 EOCD');

  const out = [];
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    assert.equal(view.getUint32(p, true), SIG_CENTRAL);
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const csize = view.getUint32(p + 20, true);
    const usize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const name = utf8d.decode(bytes.subarray(p + 46, p + 46 + nameLen));

    assert.equal(view.getUint32(offset, true), SIG_LOCAL);
    const localNameLen = view.getUint16(offset + 26, true);
    const localExtraLen = view.getUint16(offset + 28, true);
    const dataStart = offset + 30 + localNameLen + localExtraLen;
    const data = bytes.subarray(dataStart, dataStart + usize);
    // local header 里的 crc / 长度必须是 0：真值只在 data descriptor 与中央目录里
    assert.equal(view.getUint32(offset + 14, true), 0);
    assert.equal(view.getUint32(offset + 18, true), 0);
    assert.equal(view.getUint32(offset + 22, true), 0);
    // data descriptor 紧跟在数据之后，且与中央目录同值
    assert.equal(view.getUint32(dataStart + usize, true), SIG_DESCRIPTOR);
    assert.equal(view.getUint32(dataStart + usize + 4, true), crc);
    assert.equal(view.getUint32(dataStart + usize + 8, true), usize);

    out.push({ name, flags, method, crc, csize, usize, offset, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function bytesOf(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

function sinkWith(over) {
  const { doc, clicks } = fakeDoc(over && over.log);
  const urlApi = fakeUrlApi();
  const sink = createZipSink(
    Object.assign(
      {
        settings: { preserveTree: true, fileRetries: 0 },
        files,
        doc,
        urlApi,
        now: () => new Date(2024, 4, 6, 7, 8, 9),
        schedule: (fn) => {
          fn();
          return 0;
        }
      },
      over || {}
    )
  );
  return { sink, clicks, doc, urlApi };
}

// ============================ 单包 / 结构 ============================

test('zip sink：3 个文件合成 1 个包，Blob 可被最小解析器读出中央目录且 CRC 全匹配', async () => {
  const contents = {
    a: utf8.encode('alpha'),
    b: utf8.encode('bravo'),
    c: utf8.encode('charlie')
  };
  const { sink, clicks, urlApi } = sinkWith();
  assert.equal(sink.kind, 'zip');

  const list = [
    entry({ id: '1', url: 'a', name: 'a.txt', folderPath: ['Week 1'] }),
    entry({ id: '2', url: 'b', name: 'b.txt', folderPath: ['Week 1'] }),
    entry({ id: '3', url: 'c', name: 'c.txt', folderPath: ['Week 1'] })
  ];
  const progress = [];
  const events = [];
  const result = await sink.download(list, makeFetcher(contents), {
    onProgress: (payload) => progress.push(payload),
    onFileEvent: (ev) => events.push(ev) // 事件语义归另一个模块，这里只要求不炸
  });

  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].download, 'Week 1.zip');
  assert.deepEqual(urlApi.revoked, ['blob:1']);

  const entries = parseZip(await bytesOf(urlApi.made[0].blob));
  assert.deepEqual(
    entries.map((e) => e.name),
    ['Week 1/a.txt', 'Week 1/b.txt', 'Week 1/c.txt']
  );
  for (const item of entries) {
    const source = contents[item.name.slice('Week 1/'.length, -4)];
    assert.equal(item.method, 0, 'STORE：绝不 deflate');
    assert.equal(item.flags, 0x0808, '通用位 3（data descriptor）+ 位 11（UTF-8 文件名）');
    assert.equal(item.usize, source.length);
    assert.equal(item.csize, source.length);
    assert.equal(item.crc, crc32(source));
    assert.deepEqual(Array.from(item.data), Array.from(source));
  }

  assert.equal(result.ok.length, 3);
  assert.equal(result.failed.length, 0);
  assert.equal(result.aborted, false);
  assert.equal(result.halted, null);
  assert.equal(progress.at(-1).state, 'done');
  assert.equal(progress.at(-1).bytesDone, 5 + 5 + 7);
  assert.equal(progress.at(-1).filesDone, 3);
  // 事件与进度并列新增（契约 §1）：三个文件各自 start(attempt 1) → done(bytes = 各自落盘字节)
  assert.deepEqual(
    events.map((e) => [e.type, e.entryId, e.attempt, e.bytes]),
    [
      ['start', '1', 1, undefined],
      ['done', '1', undefined, 5],
      ['start', '2', 1, undefined],
      ['done', '2', undefined, 5],
      ['start', '3', 1, undefined],
      ['done', '3', undefined, 7]
    ]
  );
});

test('zip sink：包内路径与 plan 一致（保留目录层级 + 同名去重）', async () => {
  const contents = { a: utf8.encode('A'), b: utf8.encode('B'), c: utf8.encode('C') };
  const { sink, urlApi } = sinkWith();
  const list = [
    entry({ id: '1', url: 'a', name: 'x.pdf', folderPath: ['Week 1', 'Slides'] }),
    entry({ id: '2', url: 'b', name: 'y.pdf', folderPath: ['Week 1'] }),
    entry({ id: '3', url: 'c', name: 'x.pdf', folderPath: ['Week 1', 'Slides'] })
  ];
  await sink.download(list, makeFetcher(contents));

  const entries = parseZip(await bytesOf(urlApi.made[0].blob));
  assert.deepEqual(
    entries.map((e) => e.name),
    ['Week 1/Slides/x.pdf', 'Week 1/y.pdf', 'Week 1/Slides/x (2).pdf']
  );
});

test('zip sink：按顶层文件夹分包，包名就是组名', async () => {
  const contents = { a: utf8.encode('A'), b: utf8.encode('B') };
  const { sink, clicks, urlApi } = sinkWith();
  const list = [
    entry({ id: '1', url: 'a', name: 'a.pdf', folderPath: ['Week 1'] }),
    entry({ id: '2', url: 'b', name: 'b.pdf', folderPath: ['Week 2', 'Slides'] })
  ];
  const result = await sink.download(list, makeFetcher(contents));

  assert.deepEqual(clicks.map((c) => c.download), ['Week 1.zip', 'Week 2.zip']);
  const first = parseZip(await bytesOf(urlApi.made[0].blob));
  const second = parseZip(await bytesOf(urlApi.made[1].blob));
  assert.deepEqual(first.map((e) => e.name), ['Week 1/a.pdf']);
  assert.deepEqual(second.map((e) => e.name), ['Week 2/Slides/b.pdf']);
  assert.equal(result.ok.length, 2);
});

test('zip sink：没有顶层文件夹的文件归到 course.zip，不丢文件', async () => {
  const { sink, clicks, urlApi } = sinkWith();
  await sink.download([entry({ id: '1', url: 'a', name: 'a.pdf', folderPath: [] })], makeFetcher({ a: utf8.encode('A') }));
  assert.deepEqual(clicks.map((c) => c.download), ['course.zip']);
  const entries = parseZip(await bytesOf(urlApi.made[0].blob));
  assert.deepEqual(entries.map((e) => e.name), ['a.pdf']);
});

test('zip sink：preserveTree=false 时整批一包，目录用 folder__ 前缀补偿', async () => {
  const contents = { a: utf8.encode('A'), b: utf8.encode('B') };
  const { sink, clicks, urlApi } = sinkWith({ settings: { preserveTree: false, fileRetries: 0 } });
  const list = [
    entry({ id: '1', url: 'a', name: 'a.pdf', folderPath: ['Week 1'] }),
    entry({ id: '2', url: 'b', name: 'b.pdf', folderPath: ['Week 2'] })
  ];
  await sink.download(list, makeFetcher(contents));

  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].download, 'course.zip');
  const entries = parseZip(await bytesOf(urlApi.made[0].blob));
  assert.deepEqual(entries.map((e) => e.name), ['Week 1__a.pdf', 'Week 2__b.pdf']);
});

// ============================ 分包 / 内存上界 ============================

test('zip sink：缩小 zipChunkBytes 切出多包，每包 <= 上限，且上一包交付后才开始下一包', async () => {
  const log = [];
  const blob = new Uint8Array(100).fill(7);
  const contents = { f1: blob, f2: blob, f3: blob };
  const { sink, clicks, urlApi } = sinkWith({
    log,
    settings: { preserveTree: true, fileRetries: 0, zipChunkBytes: 500 },
    sizeOf: () => 100 // 体积已知：分包边界才能精确到字节
  });
  const list = ['f1', 'f2', 'f3'].map((url, i) => entry({ id: String(i), url, name: url + '.bin', folderPath: ['Week 1'] }));
  await sink.download(list, makeFetcher(contents, { log }));

  assert.equal(clicks.length, 2, '一个包装不下 3 个文件（每个 ~320 字节含头部开销）');
  for (const made of urlApi.made) assert.ok(made.size <= 500, '单包 ' + made.size + ' 字节超过上限 500');
  assert.ok(urlApi.made[0].size > urlApi.made[1].size);

  // 关键顺序：第二包的第一个 chunk 必须在第一包的 click 之后才出现 —— 否则两个包会同时在内存里
  const firstClick = log.indexOf('click');
  const secondFetch = log.lastIndexOf('fetch:f3');
  assert.ok(firstClick >= 0 && secondFetch > firstClick, '上一包必须先交付再下下一包：' + log.join(','));
  assert.deepEqual(
    log.filter((x) => x === 'click' || x.startsWith('fetch:')),
    ['fetch:f1', 'fetch:f2', 'click', 'fetch:f3', 'click']
  );

  const first = parseZip(await bytesOf(urlApi.made[0].blob));
  const second = parseZip(await bytesOf(urlApi.made[1].blob));
  assert.deepEqual(first.map((e) => e.name), ['Week 1/f1.bin', 'Week 1/f2.bin']);
  assert.deepEqual(second.map((e) => e.name), ['Week 1/f3.bin']);
});

test('zip sink：体积未知时按已落盘字节收口，仍能切出多个包（不会无限攒）', async () => {
  const blob = new Uint8Array(400).fill(1);
  const contents = { f1: blob, f2: blob };
  const { sink, clicks } = sinkWith({
    settings: { preserveTree: true, fileRetries: 0, zipChunkBytes: 500 }
  });
  const list = ['f1', 'f2'].map((url, i) => entry({ id: String(i), url, name: url + '.bin', folderPath: ['Week 1'] }));
  await sink.download(list, makeFetcher(contents));
  // 第一个文件落进去就已经 >= 500 字节（含头部开销），第二个必须另起一包
  assert.equal(clicks.length, 2);
});

test('zip sink：单个文件超过 zipChunkBytes 时独占一个包（否则永远开始不了）', async () => {
  const blob = new Uint8Array(900).fill(3);
  const { sink, urlApi } = sinkWith({
    settings: { preserveTree: true, fileRetries: 0, zipChunkBytes: 100 },
    sizeOf: () => 900
  });
  await sink.download(
    [entry({ id: '1', url: 'f1', name: 'f1.bin', folderPath: ['W'] })],
    makeFetcher({ f1: blob })
  );
  const entries = parseZip(await bytesOf(urlApi.made[0].blob));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].usize, 900);
});

// ============================ 重试 / 停机 / Zip64 ============================

test('zip sink：文件级重试沿用 withFileRetry，重试成功后包里只有一条记录、字节只算一次', async () => {
  const content = utf8.encode('alpha');
  const progress = [];
  const { sink, urlApi, clicks } = sinkWith({ settings: { preserveTree: true, fileRetries: 1 } });
  const fetcher = makeFetcher(
    { a: content },
    {
      fail: (url, attempt) => (url === 'a' && attempt === 1 ? new TypeError('网络中断') : null)
    }
  );
  const result = await sink.download(
    [entry({ id: '1', url: 'a', name: 'a.txt', folderPath: ['W'] })],
    fetcher,
    { onProgress: (payload) => progress.push(payload) }
  );

  assert.equal(fetcher.attempts.get('a'), 2);
  assert.equal(result.ok.length, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(clicks.length, 1);
  const entries = parseZip(await bytesOf(urlApi.made[0].blob));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].crc, crc32(content));
  assert.equal(entries[0].usize, content.length);
  // 第一次尝试的字节已经回退，bytesDone 等于真实落进包里的字节数
  assert.equal(progress.at(-1).bytesDone, content.length);
  assert.ok(progress.some((p) => p.state === 'file-retry'));
});

test('zip sink：会话过期立即停机 —— 触发者进 pending 不进 failed，且只尝试一次', async () => {
  const contents = { a: utf8.encode('A'), b: utf8.encode('B'), c: utf8.encode('C') };
  const { sink, urlApi } = sinkWith({ settings: { preserveTree: true, fileRetries: 2 } });
  const fetcher = makeFetcher(contents, {
    fail: (url) => (url === 'b' ? new SessionExpiredError('会话已失效') : null)
  });
  const list = [
    entry({ id: '1', url: 'a', name: 'a.txt', folderPath: ['W'] }),
    entry({ id: '2', url: 'b', name: 'b.txt', folderPath: ['W'] }),
    entry({ id: '3', url: 'c', name: 'c.txt', folderPath: ['W'] })
  ];
  const result = await sink.download(list, fetcher);

  assert.equal(fetcher.attempts.get('a'), 1);
  assert.equal(fetcher.attempts.get('b'), 1, '会话过期绝不重试');
  assert.equal(fetcher.attempts.get('c'), undefined, '停机后不再启动新文件');
  assert.equal(result.halted.reason, 'session-expired');
  assert.deepEqual(result.halted.pending.map((e) => e.id), ['2', '3']);
  assert.equal(result.failed.length, 0, 'pending 里没有一条同时出现在 failed 里');
  assert.equal(result.aborted, false);
  assert.deepEqual(result.ok.map((e) => e.id), ['1']);
  // 已经拿到手的文件照旧交出去：停机不该丢掉前面下好的
  const entries = parseZip(await bytesOf(urlApi.made[0].blob));
  assert.deepEqual(entries.map((e) => e.name), ['W/a.txt']);
});

test('zip sink：用户取消优先于停机，halted 为 null', async () => {
  const controller = new AbortController();
  const { sink } = sinkWith({ signal: controller.signal, settings: { preserveTree: true, fileRetries: 0 } });
  const fetcher = makeFetcher({ a: utf8.encode('A') }, { fail: () => null });
  controller.abort();
  const result = await sink.download([entry({ id: '1', url: 'a', name: 'a.txt', folderPath: ['W'] })], fetcher);
  assert.equal(result.aborted, true);
  assert.equal(result.halted, null);
});

test('zip sink：已知体积 >= 4 GiB 的条目被明确拒绝（不下载、不产坏包）', async () => {
  const contents = { ok: utf8.encode('ok') };
  const { sink, urlApi, clicks } = sinkWith({
    settings: { preserveTree: true, fileRetries: 0 },
    sizeOf: (e) => (e.url === 'huge' ? 4 * 1024 * 1024 * 1024 : undefined)
  });
  const fetcher = makeFetcher(contents);
  const result = await sink.download(
    [
      entry({ id: '1', url: 'huge', name: 'huge.mp4', folderPath: ['W'] }),
      entry({ id: '2', url: 'ok', name: 'ok.txt', folderPath: ['W'] })
    ],
    fetcher
  );

  assert.equal(fetcher.attempts.get('huge'), undefined, '4 GiB 的文件不值得下载一遍再拒绝');
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].name, 'huge.mp4');
  assert.match(result.failed[0].error, /4 GiB|ZIP32/);
  assert.ok(!/https?:/.test(result.failed[0].error), '失败文案里不许出现 URL');
  assert.equal(result.ok.length, 1);
  assert.equal(clicks.length, 1);
  const entries = parseZip(await bytesOf(urlApi.made[0].blob));
  assert.deepEqual(entries.map((e) => e.name), ['W/ok.txt']);
});

test('zip sink：截断（收到的字节少于声明体积）判失败，半截数据不进包', async () => {
  const { sink, urlApi, clicks } = sinkWith({
    settings: { preserveTree: true, fileRetries: 0 },
    sizeOf: () => 10
  });
  const result = await sink.download(
    [entry({ id: '1', url: 'a', name: 'a.bin', folderPath: ['W'] })],
    makeFetcher({ a: utf8.encode('abc') })
  );
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /不完整/);
  assert.equal(clicks.length, 0, '没有完整文件就不该交出一个空包');
  assert.equal(urlApi.made.length, 0);
});

// ============================ 逐文件事件（契约 §1） ============================

/** path / name 只许来自 entry 的 folderPath / name：不许出现 URL，也不许出现 query / hash。 */
function assertCleanPathName(events) {
  for (const ev of events) {
    for (const field of ['path', 'name']) {
      const text = String(ev[field] == null ? '' : ev[field]);
      assert.ok(!/https?:/.test(text), field + ' 里出现了 URL：' + text);
      assert.ok(!/[?#]/.test(text), field + ' 里出现了 query / hash：' + text);
    }
  }
}

test('zip sink：onFileEvent 发 start(attempt 1) → done，done.bytes 是该文件的最终落盘字节', async () => {
  const contents = { a: utf8.encode('alpha'), b: utf8.encode('bravo') };
  const { sink } = sinkWith();
  const list = [
    entry({ id: '1', url: 'a', name: 'a.txt', folderPath: ['Week 1'] }),
    entry({ id: '2', url: 'b', name: 'b.txt', folderPath: ['Week 1'] })
  ];
  const events = [];
  await sink.download(list, makeFetcher(contents), { onFileEvent: (ev) => events.push(ev) });

  assert.deepEqual(
    events.map((e) => [e.type, e.entryId, e.attempt, e.bytes]),
    [
      ['start', '1', 1, undefined],
      ['done', '1', undefined, 5],
      ['start', '2', 1, undefined],
      ['done', '2', undefined, 5]
    ]
  );
  // path / name 与 plan 同一份来源（folderPath + name），不含 URL
  assert.equal(events[0].path, 'Week 1/a.txt');
  assert.equal(events[0].name, 'Week 1/a.txt');
  assert.equal(events[1].path, 'Week 1/a.txt');
  assertCleanPathName(events);
});

test('zip sink：重试时 retry(attempt 2) 在第二次 start 之前，done 只发一次且 bytes 不累加', async () => {
  const content = utf8.encode('alpha');
  const { sink } = sinkWith({ settings: { preserveTree: true, fileRetries: 1 } });
  const fetcher = makeFetcher(
    { a: content },
    { fail: (url, attempt) => (url === 'a' && attempt === 1 ? new TypeError('网络中断') : null) }
  );
  const events = [];
  await sink.download(
    [entry({ id: '1', url: 'a', name: 'a.txt', folderPath: ['W'] })],
    fetcher,
    { onFileEvent: (ev) => events.push(ev) }
  );

  assert.equal(fetcher.attempts.get('a'), 2);
  assert.deepEqual(
    events.map((e) => [e.type, e.entryId, e.attempt]),
    [
      ['start', '1', 1],
      ['retry', '1', 2],
      ['start', '1', 2],
      ['done', '1', undefined]
    ]
  );
  const retry = events.filter((e) => e.type === 'retry');
  assert.equal(retry.length, 1);
  assert.equal(typeof retry[0].reason, 'string');
  assert.ok(retry[0].reason.length > 0, 'retry 必须带一句人话');
  assert.ok(!/https?:|a\.txt|\?/.test(retry[0].reason), 'reason 不含 URL：' + retry[0].reason);
  // 重试是把同一个文件重下一遍：done.bytes 是最后那一份，不是两次累加
  const done = events.filter((e) => e.type === 'done');
  assert.equal(done.length, 1);
  assert.equal(done[0].bytes, content.length);
});

test('zip sink：失败时发 failed（error 已过 redactUrls，不带 URL query），且不发 done', async () => {
  const { sink } = sinkWith({ settings: { preserveTree: true, fileRetries: 0 } });
  const fetcher = makeFetcher(
    { a: utf8.encode('A') },
    { fail: () => new Error('GET http://cdn.example.com/a.pdf?token=secret123 返回 403') }
  );
  const events = [];
  const result = await sink.download(
    [entry({ id: '1', url: 'a', name: 'a.pdf', folderPath: ['W'] })],
    fetcher,
    { onFileEvent: (ev) => events.push(ev) }
  );

  const failed = events.filter((e) => e.type === 'failed');
  assert.equal(failed.length, 1);
  assert.match(failed[0].error, /403/);
  assert.ok(!failed[0].error.includes('secret123'), 'query 必须被抹掉：' + failed[0].error);
  assert.equal(failed[0].error, result.failed[0].error, '与失败清单同一句脱敏过的文案');
  assert.equal(events.filter((e) => e.type === 'done').length, 0, 'done 与 failed 互斥');
  assert.equal(events.filter((e) => e.type === 'start').length, 1);
  assertCleanPathName(events);
});

test('zip sink：停机时 halt 恰好一次，pending 是未下载文件数（数字）', async () => {
  const contents = { a: utf8.encode('A'), b: utf8.encode('B'), c: utf8.encode('C') };
  const { sink } = sinkWith({ settings: { preserveTree: true, fileRetries: 2 } });
  const fetcher = makeFetcher(contents, {
    fail: (url) => (url === 'b' ? new SessionExpiredError('会话已失效') : null)
  });
  const list = [
    entry({ id: '1', url: 'a', name: 'a.txt', folderPath: ['W'] }),
    entry({ id: '2', url: 'b', name: 'b.txt', folderPath: ['W'] }),
    entry({ id: '3', url: 'c', name: 'c.txt', folderPath: ['W'] })
  ];
  const events = [];
  const result = await sink.download(list, fetcher, { onFileEvent: (ev) => events.push(ev) });

  const halts = events.filter((e) => e.type === 'halt');
  assert.equal(halts.length, 1, 'halt 只发一次');
  assert.equal(halts[0].reason, 'session-expired');
  assert.equal(typeof halts[0].pending, 'number', 'halt.pending 必须是数字');
  assert.equal(halts[0].pending, 2, '未下载的是 b 和 c');
  assert.equal(events.filter((e) => e.type === 'retry').length, 0, '会话过期不触发 retry');
  assert.equal(events.filter((e) => e.type === 'failed').length, 0, 'pending 里的文件不进 failed');
  assert.equal(events.filter((e) => e.type === 'start').length, 2, 'a 与 b 各尝试一次，c 从没开始');
  assert.deepEqual(result.halted.pending.map((e) => e.id), ['2', '3']);
});

test('zip sink：同一 entryId 的 start 先于终态，done / failed 各最多一次', async () => {
  const contents = { good: utf8.encode('ok'), bad: utf8.encode('nope') };
  const { sink } = sinkWith({ settings: { preserveTree: true, fileRetries: 2 } });
  const fetcher = makeFetcher(contents, {
    fail: (url) => (url === 'bad' ? new Error('一直失败') : null)
  });
  const list = [
    entry({ id: '1', url: 'good', name: 'good.txt', folderPath: ['W'] }),
    entry({ id: '2', url: 'bad', name: 'bad.txt', folderPath: ['W'] })
  ];
  const events = [];
  const result = await sink.download(list, fetcher, { onFileEvent: (ev) => events.push(ev) });

  assert.equal(fetcher.attempts.get('bad'), 3, 'fileRetries=2 → 一共 3 次尝试');
  for (const id of ['1', '2']) {
    const mine = events.filter((e) => e.entryId === id);
    const starts = mine.filter((e) => e.type === 'start');
    const terminal = mine.filter((e) => e.type === 'done' || e.type === 'failed');
    assert.ok(starts.length >= 1, id + ' 至少有一次 start');
    assert.equal(terminal.length, 1, id + ' 只能有一次终态');
    assert.ok(mine.indexOf(terminal[0]) > mine.indexOf(starts[0]), id + ' 的 start 必须先于终态');
  }
  assert.equal(events.filter((e) => e.type === 'done').length, 1);
  assert.equal(events.filter((e) => e.type === 'failed').length, 1);
  assert.equal(events.filter((e) => e.type === 'start').length, 1 + 3);
  assert.equal(result.ok.length, 1);
  assert.equal(result.failed.length, 1);
});

test('zip sink：被体积闸门直接拒绝的条目也先发 start 再发 failed（顺序契约无例外）', async () => {
  const { sink } = sinkWith({
    settings: { preserveTree: true, fileRetries: 1 },
    sizeOf: (e) => (e.url === 'huge' ? 4 * 1024 * 1024 * 1024 : undefined)
  });
  const fetcher = makeFetcher({ ok: utf8.encode('ok') });
  const events = [];
  const result = await sink.download(
    [
      entry({ id: '1', url: 'huge', name: 'huge.mp4', folderPath: ['W'] }),
      entry({ id: '2', url: 'ok', name: 'ok.txt', folderPath: ['W'] })
    ],
    fetcher,
    { onFileEvent: (ev) => events.push(ev) }
  );

  assert.equal(fetcher.attempts.get('huge'), undefined, '闸门拦下就不该发请求');
  assert.deepEqual(
    events.filter((e) => e.entryId === '1').map((e) => e.type),
    ['start', 'failed'],
    '一个字节都没读也算第 1 次尝试：start 先于 failed'
  );
  assert.equal(result.failed.length, 1);
  assert.equal(result.ok.length, 1);
});

test('zip sink：progressPayload 字段一个不少（事件是并列新增，不是替换）', async () => {
  const progress = [];
  const events = [];
  const { sink } = sinkWith();
  await sink.download(
    [entry({ id: '1', url: 'a', name: 'a.txt', folderPath: ['W'] })],
    makeFetcher({ a: utf8.encode('A') }),
    { onProgress: (payload) => progress.push(payload), onFileEvent: (ev) => events.push(ev) }
  );

  assert.deepEqual(Object.keys(progress[0]).sort(), [
    'bytes',
    'bytesDone',
    'bytesTotal',
    'currentPath',
    'done',
    'entryId',
    'failed',
    'filesDone',
    'filesTotal',
    'name',
    'state',
    'total'
  ]);
  assert.equal(progress.at(-1).state, 'done');
  assert.equal(progress.at(-1).bytesDone, 1);
  // 两套并存且互不污染：事件里没有 progress 的字段
  assert.ok(events.length > 0);
  for (const ev of events) {
    assert.ok(!('state' in ev) && !('filesDone' in ev) && !('currentPath' in ev));
  }
});

