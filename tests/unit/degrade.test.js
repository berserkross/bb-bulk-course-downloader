import test from 'node:test';
import assert from 'node:assert/strict';

import * as realFiles from '../../src/bb/files.js';
import { SuspectResponseError } from '../../src/bb/http.js';
import { createControl, runPool, degradeForSuspect, MIN_WIDTH, MAX_DEGRADES } from '../../src/sinks/pool.js';
import { withDegraded, withHalted } from '../../src/sinks/shared.js';
import { createFsSink } from '../../src/sinks/fs.js';
import { createDownloadSink } from '../../src/sinks/download.js';
import { createZipSink } from '../../src/sinks/zip.js';
import { createController } from '../../src/index.js';

const files = { ...realFiles };

function entry(over) {
  return Object.assign({ id: 'i', href: 'h', url: 'http://x/a', name: 'a.pdf', folderPath: [] }, over);
}

function suspect() {
  return new SuspectResponseError({ htmlKind: 'blocked', status: 429 });
}

// ---------- 可注入的 fake FSA handle（与 sinks.test.js 同一形状） ----------

function makeRoot(log) {
  const dir = (path) => ({
    path,
    async getDirectoryHandle(seg, opts) {
      log.dirs.push(path.join('/') + ' -> ' + seg + ' create=' + Boolean(opts && opts.create));
      return dir(path.concat(seg));
    },
    async getFileHandle(name) {
      log.files.push(path.join('/') + ' -> ' + name);
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

function chunkedResponse(sizes) {
  let i = 0;
  return {
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
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

function fakeDoc() {
  return {
    body: { appendChild() {} },
    createElement() {
      const a = { style: {}, download: '', click() {}, remove() {} };
      return a;
    }
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

/** 抓 console.info：降速日志是本功能唯一新增的控制台输出，必须能精确计数。 */
async function captureInfo(fn) {
  const lines = [];
  const saved = console.info;
  console.info = function () {
    lines.push(Array.prototype.slice.call(arguments));
  };
  try {
    const value = await fn();
    return { lines, value };
  } finally {
    console.info = saved;
  }
}

// ==================== 1. control 的降速算术（验收 1） ====================

test('createControl：degrade() 连调三次是 4→2→1→1，返回值等于当前 width', () => {
  const control = createControl({ width: 4 });
  assert.equal(control.width, 4);
  assert.equal(control.degrade(), 2);
  assert.equal(control.width, 2);
  assert.equal(control.degrade(), 1);
  assert.equal(control.width, 1);
  // 第三次：已经到下限、且次数预算用完 —— 空操作，返回值仍是当前宽度
  assert.equal(control.degrade(), 1);
  assert.equal(control.width, 1);
  assert.equal(MIN_WIDTH, 1);
  assert.equal(MAX_DEGRADES, 2);
});

test('createControl：未播种时 width 为 0，degrade() 直接落到下限 1', () => {
  const control = createControl();
  assert.equal(control.width, 0);
  assert.equal(control.degrade(), 1);
  assert.equal(control.width, 1);
});

// ==================== 2. runPool 读宽度（验收 2） ====================

test('runPool：control.width 被播种成收到的 concurrency，而不是计划数', async () => {
  const control = createControl();
  await runPool([1, 2, 3], 4, async () => {}, { control });
  assert.equal(control.width, 4);
  // 真开几个 worker 仍受 jobs.length 约束：3 个任务不会有第 4 个 worker
  const seen = [];
  const again = createControl();
  await runPool([1, 2, 3], 4, async (job) => {
    seen.push(job);
  }, { control: again });
  assert.deepEqual(seen, [1, 2, 3]);
});

test('runPool：运行中降级后同时存活的 worker 峰值不超过新宽度，且在飞的条目全部跑完', async () => {
  async function run(degrade) {
    const control = createControl({ width: 4 });
    const seen = [];
    let live = 0;
    let peak = 0;
    await runPool(
      [1, 2, 3, 4, 5, 6],
      4,
      async (job) => {
        live += 1;
        peak = Math.max(peak, live);
        seen.push(job);
        // 第一个条目刚开工就降级：此刻另外 3 个 worker 还没启动
        if (degrade && job === 1) control.degrade();
        await tick();
        live -= 1;
      },
      { control }
    );
    return { peak, seen, control };
  }

  const off = await run(false);
  assert.equal(off.peak, 4, '对照组：不降级时峰值就是设定的并发');
  const on = await run(true);
  assert.ok(on.peak <= 2, '降级后峰值必须 ≤ 2，实测 ' + on.peak);
  assert.deepEqual(on.seen, [1, 2, 3, 4, 5, 6], '降级不能吞掉任何条目');
  assert.equal(on.control.width, 2);
});

// ==================== 3. degradeForSuspect（验收 3） ====================

test('degradeForSuspect：一次可疑只降一次，第三次可疑之后 width 仍是 1', async () => {
  const calls = [];
  const spy = {
    width: 4,
    degrade() {
      calls.push(this.width);
      this.width = Math.max(1, Math.floor(this.width / 2));
      return this.width;
    }
  };

  const { lines, value } = await captureInfo(async () => {
    const first = degradeForSuspect(spy, null);
    const second = degradeForSuspect(spy, first);
    const third = degradeForSuspect(spy, second);
    return { first, second, third };
  });

  assert.deepEqual(value.first, { from: 4, to: 2 });
  assert.deepEqual(value.second, { from: 4, to: 1 }, 'from 留住第一次的值，to 走到最低那一档');
  assert.deepEqual(value.third, { from: 4, to: 1 });
  assert.equal(spy.width, 1);
  assert.deepEqual(calls, [4, 2], '桩数到的 degrade() 调用次数必须等于真实降级次数');
  assert.equal(lines.length, 2, '只有真的降了才写日志');
  for (const args of lines) {
    assert.equal(args[0], '[bbdl] 降速');
    assert.deepEqual(Object.keys(args[1]), ['from', 'to', 'reason'], '字段白名单固定');
    assert.equal(args[1].reason, 'suspect-response');
  }
});

// ==================== 4. 三个 sink 的调用点（验收 3 / 4） ====================

test('fs sink：一次可疑重试恰好触发一次降速，返回值挂上不可枚举的 degraded', async () => {
  const log = newLog();
  const sink = createFsSink({
    settings: { downloadConcurrency: 4, fileRetries: 1 },
    dirHandle: makeRoot(log),
    files,
    total: 1
  });
  let n = 0;
  const fetcher = {
    async fetchOk() {
      n += 1;
      if (n === 1) throw suspect(); // 第 1 次：可疑响应（疑似限流）
      return chunkedResponse([4]);
    }
  };

  const { lines, value: result } = await captureInfo(() =>
    sink.download([entry({ id: 'a', name: 'a.pdf' })], fetcher, {})
  );

  const drops = lines.filter((args) => args[0] === '[bbdl] 降速');
  assert.equal(drops.length, 1, '一次可疑重试只能降一次');
  assert.deepEqual(drops[0][1], { from: 4, to: 2, reason: 'suspect-response' });
  assert.deepEqual(result.degraded, { from: 4, to: 2 });
  assert.equal('degraded' in result, true, '属性必须在');
  assert.deepEqual(Object.keys(result), ['ok', 'failed', 'aborted'], '但不能是可枚举属性');
  assert.equal(result.ok.length, 1, '重试成功后这条算成功');
  assert.equal(result.failed.length, 0);
});

test('download sink：可疑重试后 degraded 记下 2→1', async () => {
  const sink = createDownloadSink({
    settings: { downloadConcurrency: 2, fileRetries: 1 },
    files,
    doc: fakeDoc(),
    urlApi: fakeUrlApi(),
    schedule: (fn) => {
      fn();
      return 0;
    }
  });
  let n = 0;
  const fetcher = {
    async fetchOk() {
      n += 1;
      if (n === 1) throw suspect();
      return {
        ok: true,
        async blob() {
          return { size: 2048 };
        }
      };
    }
  };

  const { lines, value: result } = await captureInfo(() =>
    sink.download([entry({ id: 'a', name: 'a.pdf', url: 'a' })], fetcher, {})
  );

  assert.equal(lines.filter((args) => args[0] === '[bbdl] 降速').length, 1);
  assert.deepEqual(result.degraded, { from: 2, to: 1 });
  assert.equal('degraded' in result, true);
  assert.equal(Object.keys(result).includes('degraded'), false);
  assert.equal(result.ok.length, 1);
});

test('zip sink：串行包没有并发可降，degraded 仍是不可枚举的 null', async () => {
  const sink = createZipSink({
    settings: { preserveTree: true, fileRetries: 0 },
    files,
    doc: fakeDoc(),
    urlApi: fakeUrlApi(),
    now: () => new Date(2024, 4, 6, 7, 8, 9),
    schedule: (fn) => {
      fn();
      return 0;
    }
  });
  const fetcher = {
    async fetchOk() {
      return new Response(new Uint8Array([1, 2, 3]));
    }
  };

  const result = await sink.download([entry({ id: 'a', name: 'a.pdf' })], fetcher, {});

  assert.equal(result.degraded, null);
  assert.equal('degraded' in result, true);
  assert.equal(Object.keys(result).includes('degraded'), false);
  assert.equal(result.ok.length, 1);
});

test('withDegraded 与 withHalted 同法不可枚举、互不干扰', () => {
  const result = withDegraded(withHalted({ ok: [], failed: [], aborted: false }, { reason: 'session-expired', pending: [] }), {
    from: 4,
    to: 2
  });
  assert.deepEqual(result, { ok: [], failed: [], aborted: false }, '两个扩展属性都必须对 deepEqual 隐身');
  assert.deepEqual(Object.keys(result), ['ok', 'failed', 'aborted']);
  assert.equal(result.halted.reason, 'session-expired');
  assert.deepEqual(result.degraded, { from: 4, to: 2 });

  const none = withDegraded({ ok: [] }, null);
  assert.equal(none.degraded, null);
  assert.deepEqual(Object.keys(none), ['ok']);
});

// ==================== 5. index.js 的提示（验收 5） ====================

const HREF = 'https://bb.example.edu/webapps/blackboard/content/listContent.jsp?course_id=_101_1&content_id=_202_1';
const ENTRIES = [
  { id: 'e1', name: 'a.pdf', size: 100, folderPath: [], url: 'https://bb.example.edu/f/1' },
  { id: 'e2', name: 'b.pdf', size: 200, folderPath: [], url: 'https://bb.example.edu/f/2' }
];

function makePanel() {
  const calls = [];
  const api = { calls };
  const names = [
    'setState', 'setCount', 'setScanProgress', 'setDownloadProgress',
    'setMode', 'setNotice', 'setResume', 'showSummary', 'rebind', 'fail', 'destroy',
    'setFiles', 'applyFileEvent', 'setHalted', 'clearHalted'
  ];
  for (const name of names) {
    api[name] = function () {
      calls.push({ name, args: Array.prototype.slice.call(arguments) });
    };
  }
  api.texts = function (name) {
    return calls
      .filter((call) => call.name === name)
      .map((call) => String(call.args[0] == null ? '' : call.args[0]))
      .filter(Boolean);
  };
  return api;
}

function makeStore() {
  return {
    available: true,
    async loadManifest() {
      return null;
    },
    async saveManifest() {},
    async mergeFiles() {},
    async clearManifest() {},
    async loadHandle() {
      return null;
    },
    async saveHandle() {},
    async clearHandle() {}
  };
}

/** degraded 与 halted 一样是不可枚举属性：这里按同一个手法造 sink 返回值。 */
function withHidden(result, key, value) {
  Object.defineProperty(result, key, { value, enumerable: false, writable: true, configurable: true });
  return result;
}

async function runBatch(degraded) {
  const panel = makePanel();
  const controller = createController({
    store: makeStore(),
    openSelectDialog: async (entries) => ({
      entries,
      dirHandle: null,
      expectedBytes: 0,
      skipExisting: false
    }),
    mountPanel: () => panel,
    settings: { preserveTree: true, downloadConcurrency: 4 },
    location: { href: HREF },
    document: null,
    deps: {
      createScanner: () => ({ async scan() { return ENTRIES; } }),
      createSink: async (options) => ({
        kind: options.dirHandle ? 'fs' : 'zip',
        async download(entries, fetcher, api) {
          for (const item of entries) {
            api.onProgress({ state: 'file-done', entryId: item.id, filesDone: 1, filesTotal: entries.length });
          }
          return withHidden({ ok: entries.slice(), failed: [], aborted: false }, 'degraded', degraded);
        }
      }),
      createFetcher: () => ({ async probeSize() { return undefined; } }),
      probeAlive: () => Promise.resolve({ alive: false })
    }
  });
  await controller.ready;
  await controller.startScan();
  await controller.startDownload();
  return panel;
}

test('index.js：degraded 非空时给一句非阻塞提示，文案只含数字', async () => {
  const panel = await runBatch({ from: 4, to: 2 });
  const hits = panel.texts('setNotice').filter((text) => text.indexOf('限流') !== -1);
  assert.equal(hits.length, 1, '有降速就必须提示，且只提示一次');
  assert.equal(hits[0], '服务器似乎在限流，已把并发从 4 降到 2 继续下载。');
  assert.equal(/http/i.test(hits[0]), false, '文案不得出现 URL');
  assert.equal(hits[0].indexOf('?'), -1, '文案不得出现 query');
  assert.equal(/xid/i.test(hits[0]), false, '文案不得出现 xid');
});

test('index.js：degraded 为 null 时这条提示一个字都不出现', async () => {
  const panel = await runBatch(null);
  const hits = panel.texts('setNotice').filter((text) => text.indexOf('限流') !== -1);
  assert.deepEqual(hits, []);
});

test('200 个请求全被拦截时，三种落盘方式都在固定请求预算内暂停', async t => {
  const realTimer = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) =>
    realTimer(fn, ms === 1500 || ms === 4000 ? 0 : ms, ...args));
  const entries = Array.from({length: 200}, (_, i) => entry({ id: String(i), name: i + '.pdf' }));
  for (const makeSink of [createFsSink, createDownloadSink, createZipSink]) {
    const sink = makeSink({ files, settings: { downloadConcurrency: 4 }, dirHandle: makeRoot(newLog()), doc: fakeDoc(), urlApi: fakeUrlApi() });
    let requests = 0;
    const result = await sink.download(entries, { async fetchOk() { requests++; throw suspect(); } });
    assert.equal(result.halted?.reason, 'server-blocked');
    assert.equal(result.halted.pending.length, 200);
    assert.equal(result.failed.length, 0);
    assert.ok(requests <= 7, String(requests));
  }
});
