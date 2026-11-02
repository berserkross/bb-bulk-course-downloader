import test from 'node:test';
import assert from 'node:assert/strict';

import * as realFiles from '../../src/bb/files.js';
import { createFsSink } from '../../src/sinks/fs.js';
import { createZipSink } from '../../src/sinks/zip.js';

// 契约 docs/m5-naming.md §1.3 的解析器来自 src/bb/files.js 的真实导出；
// 这里整份注入给 sink，测试才能同时看见「解析器」和「落盘」两步。
const files = { ...realFiles };

test('契约前置：src/bb/files.js 导出 resolveFileName（fs/zip sink 直接 import 它）', () => {
  assert.equal(typeof realFiles.resolveFileName, 'function');
  assert.equal(
    realFiles.resolveFileName({ finalUrl: 'https://x/courses/ENG1002/APA%20Reference%20List.pdf' }),
    'APA Reference List.pdf'
  );
});

// ---------- fake FSA handle（记录目录段与文件句柄名） ----------

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

/** 按块吐字节的假响应；url / headers 就是「服务器告诉我们文件名」的两个出口。 */
function fakeResponse({ chunks = [4], url = '', headers = {} } = {}) {
  let i = 0;
  const lower = {};
  for (const key of Object.keys(headers)) lower[String(key).toLowerCase()] = headers[key];
  return {
    ok: true,
    url,
    headers: {
      get: (field) => {
        const key = String(field || '').toLowerCase();
        return Object.prototype.hasOwnProperty.call(lower, key) ? lower[key] : null;
      }
    },
    body: {
      getReader() {
        return {
          async read() {
            if (i >= chunks.length) return { done: true, value: undefined };
            const size = chunks[i];
            i += 1;
            return { done: false, value: new Uint8Array(size) };
          },
          async cancel() {}
        };
      }
    }
  };
}

/** 真实 BB 课程页里的一条文件条目：锚点文本是显示标题（无扩展名），href 是 xid 占位名。 */
function bbEntry(over) {
  return Object.assign(
    {
      id: 'dt-content-rid-12071526_1',
      href: '/bbcswebdav/pid-633912-dt-content-rid-12071526_1/xid-12071526_1',
      url: 'https://bb.example.com/webapps/blackboard/execute/content/file?cmd=view&content_id=_633912_1',
      name: 'APA Reference List',
      folderPath: []
    },
    over
  );
}

const REAL_URL = 'https://bb.example.com/courses/ENG1002/APA%20Reference%20List.pdf';

// =========================== fs sink ===========================

test('fs sink 命名：响应 url 里的真名替换 plan.fileName —— 盘上、done 事件、进度路径三者一字不差', async () => {
  const log = newLog();
  const events = [];
  const fileEvents = [];
  const sink = createFsSink({ settings: { downloadConcurrency: 1 }, dirHandle: makeRoot(log), files, total: 1 });
  const fetcher = {
    async fetchOk() {
      return fakeResponse({ chunks: [4, 8], url: REAL_URL, headers: { 'content-type': 'application/pdf' } });
    }
  };

  const target = bbEntry({ folderPath: ['Week 1'] });
  const result = await sink.download([target], fetcher, {
    onProgress: (p) => events.push(p),
    onFileEvent: (e) => fileEvents.push(e)
  });

  console.log('  [证据] 写入句柄记录：', JSON.stringify(log.files));
  const done = fileEvents.find((e) => e.type === 'done');
  const fileDone = events.find((p) => p.state === 'file-done');

  assert.deepEqual(log.files, ['Week 1 -> APA Reference List.pdf create=true']);
  assert.equal(done.name, 'APA Reference List.pdf', 'done 事件的 name 必须与盘上文件名一字不差');
  assert.equal(fileDone.currentPath, 'Week 1/APA Reference List.pdf', '进度里的 path 末段也必须是新名字');
  assert.equal(result.ok.length, 1);
  assert.equal(result.failed.length, 0);
});

test('fs sink 命名：Content-Disposition 的 filename* 优先于 url 末段', async () => {
  const log = newLog();
  const fileEvents = [];
  const sink = createFsSink({ settings: { downloadConcurrency: 1 }, dirHandle: makeRoot(log), files, total: 1 });
  const fetcher = {
    async fetchOk() {
      return fakeResponse({
        chunks: [3],
        url: 'https://bb.example.com/bbcswebdav/xid-12071526_1',
        headers: {
          'content-type': 'application/pdf; charset=utf-8',
          'content-disposition': "attachment; filename*=UTF-8''%E8%AE%B2%E4%B9%89.pdf"
        }
      });
    }
  };

  const result = await sink.download([bbEntry({})], fetcher, { onFileEvent: (e) => fileEvents.push(e) });

  console.log('  [证据] 写入句柄记录：', JSON.stringify(log.files));
  assert.deepEqual(log.files, [' -> 讲义.pdf create=true']);
  assert.equal(fileEvents.find((e) => e.type === 'done').name, '讲义.pdf');
  assert.equal(result.ok.length, 1);
});

test('fs sink 命名：两条解析出同名 → 第二个是 name (2).ext，两个都成功', async () => {
  const log = newLog();
  const fileEvents = [];
  const sink = createFsSink({ settings: { downloadConcurrency: 1 }, dirHandle: makeRoot(log), files, total: 2 });
  const fetcher = {
    async fetchOk() {
      return fakeResponse({ chunks: [2], url: REAL_URL, headers: { 'content-type': 'application/pdf' } });
    }
  };

  const list = [bbEntry({ id: 'a' }), bbEntry({ id: 'b' })];
  const result = await sink.download(list, fetcher, { onFileEvent: (e) => fileEvents.push(e) });

  console.log('  [证据] 两次写入的句柄名：', JSON.stringify(log.writes.map((w) => w.file)));
  assert.deepEqual(log.files, [
    ' -> APA Reference List.pdf create=true',
    ' -> APA Reference List (2).pdf create=true'
  ]);
  assert.deepEqual(
    fileEvents.filter((e) => e.type === 'done').map((e) => e.name),
    ['APA Reference List.pdf', 'APA Reference List (2).pdf']
  );
  assert.equal(result.ok.length, 2, '两个都必须成功');
  assert.equal(result.failed.length, 0);
});

test('fs sink 命名：解析不出名字时保持 plan.fileName 原值，绝不产出空名', async () => {
  const log = newLog();
  const fileEvents = [];
  const sink = createFsSink({ settings: { downloadConcurrency: 1 }, dirHandle: makeRoot(log), files, total: 2 });
  const fetcher = {
    async fetchOk(url) {
      if (url === 'no-url') return fakeResponse({ chunks: [5] }); // 没有 url、没有 disposition
      // 有 url，但末段是 BB 的 file 端点而不是文件名 → 也解析不出名字
      return fakeResponse({ chunks: [5], url: 'https://bb.example.com/webapps/blackboard/execute/content/file?content_id=_1' });
    }
  };

  const list = [
    bbEntry({ id: 'no-url', url: 'no-url' }),
    bbEntry({ id: 'placeholder-url', url: 'placeholder-url', name: 'Course Notes' })
  ];
  const result = await sink.download(list, fetcher, { onFileEvent: (e) => fileEvents.push(e) });

  const names = fileEvents.filter((e) => e.type === 'done').map((e) => e.name);
  console.log('  [证据] 解析失败时的落盘名：', JSON.stringify(names));
  assert.deepEqual(log.files, [' -> APA Reference List create=true', ' -> Course Notes create=true']);
  assert.deepEqual(names, ['APA Reference List', 'Course Notes']);
  for (const name of names) assert.ok(name.length > 0, '绝不产出空文件名');
  assert.equal(result.ok.length, 2);
});

// =========================== zip sink ===========================

function fakeDoc() {
  const clicks = [];
  return {
    doc: {
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
    },
    clicks
  };
}

function fakeUrlApi() {
  return {
    made: [],
    createObjectURL(blob) {
      const url = 'blob:' + (this.made.length + 1);
      this.made.push({ url, size: blob.size, blob });
      return url;
    },
    revokeObjectURL() {}
  };
}

/** 只读中央目录里的条目名：46 + nameLen 定长步进，extra/comment 恒为 0。 */
function zipNames(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50, '找不到 EOCD');
  const count = view.getUint16(eocd + 10, true);
  let pointer = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const out = [];
  for (let i = 0; i < count; i += 1) {
    assert.equal(view.getUint32(pointer, true), 0x02014b50, '中央目录签名不对');
    const nameLength = view.getUint16(pointer + 28, true);
    out.push(decoder.decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength)));
    pointer += 46 + nameLength;
  }
  return out;
}

function zipSink() {
  const { doc } = fakeDoc();
  const urlApi = fakeUrlApi();
  const sink = createZipSink({
    settings: { fileRetries: 0 },
    files,
    doc,
    urlApi,
    schedule: () => {},
    now: () => new Date('2024-01-01T00:00:00Z')
  });
  return { sink, urlApi };
}

test('zip sink 命名：包内路径末段是响应里的真名', async () => {
  const { sink, urlApi } = zipSink();
  const fileEvents = [];
  const fetcher = {
    async fetchOk() {
      return fakeResponse({ chunks: [3, 5], url: REAL_URL, headers: { 'content-type': 'application/pdf' } });
    }
  };

  const result = await sink.download([bbEntry({ id: '1', folderPath: ['Week 1'] })], fetcher, {
    onFileEvent: (e) => fileEvents.push(e)
  });

  const bytes = new Uint8Array(await urlApi.made[0].blob.arrayBuffer());
  const names = zipNames(bytes);
  const doneName = fileEvents.find((e) => e.type === 'done').name;
  console.log('  [证据] 包内条目：', JSON.stringify(names), '/ done 事件 name：', JSON.stringify(doneName));
  assert.deepEqual(names, ['Week 1/APA Reference List.pdf']);
  assert.equal(names[0].split('/').pop(), 'APA Reference List.pdf', '包内路径末段就是解析后的名字');
  assert.equal(doneName, 'Week 1/APA Reference List.pdf');
  assert.equal(result.ok.length, 1);
});

test('zip sink 命名：包内两条解析出同名 → 第二个是 name (2).ext，两条都在包里', async () => {
  const { sink, urlApi } = zipSink();
  const fileEvents = [];
  const fetcher = {
    async fetchOk() {
      return fakeResponse({ chunks: [2], url: REAL_URL, headers: { 'content-type': 'application/pdf' } });
    }
  };

  const list = [bbEntry({ id: '1', folderPath: ['Week 1'] }), bbEntry({ id: '2', folderPath: ['Week 1'] })];
  const result = await sink.download(list, fetcher, { onFileEvent: (e) => fileEvents.push(e) });

  const bytes = new Uint8Array(await urlApi.made[0].blob.arrayBuffer());
  const names = zipNames(bytes);
  console.log('  [证据] 包内条目：', JSON.stringify(names));
  assert.deepEqual(names, ['Week 1/APA Reference List.pdf', 'Week 1/APA Reference List (2).pdf']);
  assert.equal(result.ok.length, 2);
  assert.equal(result.failed.length, 0);
});
