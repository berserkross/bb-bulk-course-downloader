import test from 'node:test';
import assert from 'node:assert/strict';

import { createController } from '../../src/index.js';

const HREF = 'https://bb.example.edu/webapps/blackboard/content/listContent.jsp?course_id=_101_1&content_id=_202_1';

const ENTRIES = [
  { id: 'e1', name: 'a.pdf', size: 100, folderPath: [], url: 'https://bb.example.edu/f/1' },
  { id: 'e2', name: 'b.pdf', size: 200, folderPath: [], url: 'https://bb.example.edu/f/2' },
  { id: 'e3', name: 'c.pdf', size: 300, folderPath: [], url: 'https://bb.example.edu/f/3' }
];

/**
 * 假面板：除了 ui-*.test.js 记录的那批老方法，这里额外提供 M3 的四个新方法
 * （setFiles / applyFileEvent / setHalted / clearHalted）—— index.js 对它们逐个 typeof 守卫，
 * 这里不补上就测不到接线，补上了才等于模拟「新面板」。
 */
function makePanel() {
  const calls = [];
  const api = { calls: calls, opts: null };
  const names = [
    'setState', 'setCount', 'setScanProgress', 'setDownloadProgress',
    'setMode', 'setNotice', 'setResume', 'showSummary', 'rebind', 'fail', 'destroy',
    'setFiles', 'applyFileEvent', 'setHalted', 'clearHalted'
  ];
  for (const name of names) {
    api[name] = function () {
      calls.push({ name: name, args: Array.prototype.slice.call(arguments) });
    };
  }
  api.countOf = function (name) {
    return calls.filter(function (call) { return call.name === name; }).length;
  };
  api.callsOf = function (name) {
    return calls.filter(function (call) { return call.name === name; });
  };
  api.texts = function (name) {
    return api.callsOf(name)
      .map(function (call) { return String(call.args[0] == null ? '' : call.args[0]); })
      .filter(Boolean);
  };
  return api;
}

function makeStore() {
  const writes = [];
  return {
    available: true,
    writes: writes,
    async loadManifest() { return null; },
    async saveManifest() {},
    async mergeFiles(courseId, records) { writes.push({ courseId: courseId, records: records.slice() }); },
    async clearManifest() {},
    async loadHandle() { return null; },
    async saveHandle() {},
    async clearHandle() {}
  };
}

/** sink 结果里 halted 的形状跟 shared.js:withHalted 一致：不可枚举，只能直接读 result.halted。 */
function withHiddenHalted(result, halted) {
  Object.defineProperty(result, 'halted', {
    value: halted, enumerable: false, writable: true, configurable: true
  });
  return result;
}

function harness(over) {
  const extra = over || {};
  const panel = makePanel();
  const store = makeStore();
  const rec = { sinkOpts: [], sinkEntries: [], downloadOpts: [], scans: 0, order: [], store: store };

  const controller = createController({
    store: store,
    openSelectDialog: async function (entries) {
      return { entries: entries, dirHandle: extra.dirHandle || null, expectedBytes: 0, skipExisting: false };
    },
    mountPanel: function (options) {
      panel.opts = options;
      return panel;
    },
    settings: extra.settings || { preserveTree: true, downloadConcurrency: 2 },
    location: { href: HREF },
    document: null,
    deps: {
      createScanner: function () {
        rec.scans += 1;
        return { async scan() { return extra.entries || ENTRIES; } };
      },
      createSink: async function (options) {
        rec.sinkOpts.push(options);
        return {
          kind: options.dirHandle ? 'fs' : 'zip',
          async download(entries, fetcher, api) {
            rec.sinkEntries.push(entries.slice());
            rec.downloadOpts.push(api);
            rec.order.push('download');
            return extra.behave(entries, api, rec);
          }
        };
      },
      createFetcher: function () {
        return { async probeSize() { return undefined; } };
      },
      // 会话自检注入：这个文件里的 halted 用例会走自动续跑，真自检要发一次 fetch（DNS 失败约 300ms）
      probeAlive: function () {
        return Promise.resolve({ alive: false });
      }
    }
  });

  return { controller: controller, panel: panel, rec: rec, store: store };
}

/** 默认行为：每个文件都成功。 */
async function succeed(entries, api) {
  for (const entry of entries) {
    api.onProgress({ state: 'file-done', entryId: entry.id, filesDone: 1, filesTotal: entries.length });
  }
  return { ok: entries.slice(), failed: [], aborted: false };
}

async function runFirstBatch(h) {
  await h.controller.ready;
  await h.controller.startScan();
  return h.controller.startDownload();
}

test('AC2/B：setFiles 在 download 之前恰好种一次，onFileEvent 的事件对象原样交给 applyFileEvent', async () => {
  const event = Object.freeze({ type: 'start', entryId: 'e1', path: 'a.pdf', name: 'a.pdf', attempt: 1 });
  let handed = null;
  const h = harness({
    behave: async function (entries, api, rec) {
      // 种行必须发生在 sink.download 之前 —— 面板不为陌生 entryId 造行，晚一步事件全落空
      rec.order.push('emit');
      handed = event;
      api.onFileEvent(event);
      return succeed(entries, api);
    }
  });
  await runFirstBatch(h);

  const seeded = h.panel.callsOf('setFiles');
  assert.equal(seeded.length, 1, 'setFiles 只能被调用一次');
  assert.equal(seeded[0].args[0].length, ENTRIES.length, '种的行数必须等于本批 entries 数量');
  assert.deepEqual(h.rec.order, ['download', 'emit'], 'sink.download 起始时种子行已经种好');

  const applied = h.panel.callsOf('applyFileEvent');
  assert.equal(applied.length, 1);
  assert.equal(applied[0].args[0], handed, '事件对象必须是同一个引用（不许重包装）');
  assert.deepEqual(applied[0].args[0], event, '字段一个都不许被裁剪或改造');
  assert.equal(Object.isFrozen(applied[0].args[0]), true, '原样转发连不可写都保持不变');
});

test('AC3/C：halted 时 setHalted 恰好一次、pendingCount 正确，摘要的失败清单不含停机 pending', async () => {
  let real = null;
  const h = harness({
    behave: async function (entries, api) {
      // 复刻 download sink：pending 里的 e2 既不在 ok 也不在 failed，e3 却被塞进了 failed
      // （真实场景里前置 fetch 已判失败），接线层必须自己把 pending 摘掉。
      real = withHiddenHalted({
        ok: [entries[0]],
        failed: [
          { entry: entries[1], name: 'b.pdf', path: 'b.pdf', url: entries[1].url, error: '登录已过期' },
          { entry: entries[2], name: 'c.pdf', path: 'c.pdf', url: entries[2].url, error: '404' }
        ],
        aborted: false
      }, { reason: 'session-expired', pending: [entries[1]], pendingCount: 1 });
      // {...result} 看不见 halted —— 接线层只有直接读 result.halted 才可能发现停了机
      assert.equal(Object.keys(real).includes('halted'), false);
      return real;
    }
  });
  await runFirstBatch(h);

  const halted = h.panel.callsOf('setHalted');
  assert.equal(halted.length, 1, '停机横幅只竖一次');
  assert.deepEqual(halted[0].args[0], { reason: 'session-expired', pendingCount: 1 });

  const summary = h.panel.callsOf('showSummary');
  assert.equal(summary.length, 1);
  const shown = summary[0].args[0];
  assert.deepEqual(shown.failed.map(function (item) { return item.entry.id; }), ['e3'], 'pending 的 e2 不许出现在失败清单');
  assert.equal(shown.ok.length, 1);

  // 面板拿到的只是副本：调用方手里的真实结果一个字都没改
  assert.equal(real.failed.length, 2);
  assert.deepEqual(h.controller.getState().haltedPending.map(function (entry) { return entry.id; }), ['e2']);
});

test('AC3/C：halted 缺 pendingCount（zip sink 的形状）时按 pending 长度兜底，不把 undefined 递给面板', async () => {
  const h = harness({
    behave: async function (entries) {
      // zip.js:344-348 只造 { reason, pending }，没有 pendingCount —— 兜底算在这里
      return { ok: [entries[0]], failed: [], aborted: false, halted: { reason: 'session-expired', pending: [entries[1], entries[2]] } };
    }
  });
  await runFirstBatch(h);

  const halted = h.panel.callsOf('setHalted');
  assert.equal(halted.length, 1);
  assert.deepEqual(halted[0].args[0], { reason: 'session-expired', pendingCount: 2 });
});

test('AC4/D：点「刷新后继续」只用 halted.pending 再跑一轮，不重扫、不重种行', async () => {
  let round = 0;
  const h = harness({
    behave: async function (entries, api) {
      round += 1;
      if (round > 1) return succeed(entries, api);
      return withHiddenHalted(
        { ok: [entries[0]], failed: [], aborted: false },
        { reason: 'session-expired', pending: [entries[1], entries[2]], pendingCount: 2 }
      );
    }
  });
  await runFirstBatch(h);
  assert.equal(h.rec.scans, 1);
  const clearedBefore = h.panel.countOf('clearHalted');

  const resume = h.panel.opts.onResumePending;
  assert.equal(typeof resume, 'function', 'mountPanel 必须拿到 onResumePending（否则面板不渲染「刷新后继续」）');
  await resume();

  assert.equal(h.rec.scans, 1, '续跑不许重新扫描');
  assert.equal(h.rec.sinkEntries.length, 2, '只该再跑一轮');
  assert.deepEqual(h.rec.sinkEntries[1].map(function (entry) { return entry.id; }), ['e2', 'e3'], '下游收到的 entries 必须恰好是 pending 那几条');
  assert.equal(h.panel.countOf('setFiles'), 1, '续跑不清清单、不重种行');
  // 续跑前主动撤一次；这一轮跑完没停机，收尾时再撤一次（幂等）
  assert.ok(h.panel.countOf('clearHalted') > clearedBefore, '续跑必须先撤横幅');
  assert.equal(h.panel.countOf('setHalted'), 1, '第二轮没停机就不再竖横幅');
  assert.deepEqual(h.controller.getState().haltedPending, [], '快照用完即弃');
});

test('AC4/D：state.busy 时点「刷新后继续」直接返回；没有快照时退回重新扫描', async () => {
  let round = 0;
  const h = harness({
    behave: async function (entries, api) {
      round += 1;
      if (round > 1) return succeed(entries, api);
      return withHiddenHalted(
        { ok: [], failed: [], aborted: false },
        { reason: 'session-expired', pending: [entries[1], entries[2]], pendingCount: 2 }
      );
    }
  });
  await runFirstBatch(h);

  const first = h.panel.opts.onResumePending();
  const second = h.panel.opts.onResumePending();
  assert.equal(second, null, '防重入：busy 为真时第二次点击必须被挡回');
  await first;
  assert.equal(h.rec.sinkEntries.length, 2, '被挡回的那次不许起第二轮');

  // 快照已经用完，此刻没有 pending → 退回 startScan（也证明它不硬造空跑）
  const scansBefore = h.rec.scans;
  await h.panel.opts.onResumePending();
  assert.equal(h.rec.scans, scansBefore + 1, '没有 pending 快照时退回 startScan');
});

test('F：停机那批文件绝不会被写成 done / failed（halt 进度项与未完成项都不落库）', async () => {
  const h = harness({
    behave: async function (entries, api) {
      // e1 真下完了；e2 撞会话过期 —— zip sink 在这条路上走的是 onProgress 的 'halt'（不是 file-failed）
      api.onProgress({ state: 'file-done', entryId: 'e1', filesDone: 1, filesTotal: 3 });
      api.onProgress({ state: 'halt', entryId: 'e2', filesDone: 1, filesTotal: 3 });
      return withHiddenHalted(
        { ok: [entries[0]], failed: [], aborted: false },
        { reason: 'session-expired', pending: [entries[1], entries[2]], pendingCount: 2 }
      );
    }
  });
  await runFirstBatch(h);

  const records = h.store.writes.flatMap(function (write) { return write.records; });
  assert.deepEqual(records.map(function (record) { return record.id + ':' + record.status; }), ['e1:done'], '只有真下完的 e1 落库，停机 pending 一条都不写');
});
