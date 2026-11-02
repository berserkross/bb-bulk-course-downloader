import test from 'node:test';
import assert from 'node:assert/strict';

import { createController } from '../../src/index.js';
import { updateRecords } from '../../src/store/manifest.js';
import { planSkips } from '../../src/store/manifest-plan.js';
import { relativePath } from '../../src/sinks/shared.js';

/**
 * M7 名字记忆：清单记住「服务器真名」，下一次扫描用记住的名字盖掉页面标题。
 * 两条链路各测一半：写回侧（updateRecords 认 results.path/name）与召回侧（buildPlans 覆盖 entry.name）。
 */

const HREF_PAGE = 'https://bb.example.edu/webapps/blackboard/content/listContent.jsp?course_id=_101_1&content_id=_202_1';
const TITLE = '第一讲';
const REAL = '第一讲（正式版）.pdf';

function planOf(entry) {
  return { entry: entry, segments: [], fileName: String(entry.name) };
}

// ---------------------------------------------------------------- 写回侧（src/store/manifest.js）

test('写回：done 且带 path/name 时，记录里的 path 与 name 就是落盘真名', () => {
  const entry = { id: 'a', href: 'https://bb.example.edu/f/1?v=1', name: TITLE };
  const next = updateRecords(
    null,
    [planOf(entry)],
    [{ id: 'a', status: 'done', size: 100, path: 'A/B 真名.pdf', name: 'B 真名.pdf' }],
    900
  );
  const record = next.files.a;
  assert.equal(record.path, 'A/B 真名.pdf');
  assert.equal(record.name, 'B 真名.pdf');
  // 其余口径一个字不改
  assert.equal(record.href, 'https://bb.example.edu/f/1?v=1');
  assert.equal(record.size, 100);
  assert.equal(record.status, 'done');
  assert.equal(record.updatedAt, 900);
});

test('写回：done 只带 path 时，name 取 path 末段', () => {
  const entry = { id: 'a', href: '', name: TITLE };
  const next = updateRecords(null, [planOf(entry)], [{ id: 'a', status: 'done', size: null, path: 'A/B 真名.pdf' }], 1);
  assert.equal(next.files.a.path, 'A/B 真名.pdf');
  assert.equal(next.files.a.name, 'B 真名.pdf');
});

test('写回：failed / partial 即使带了 path 也沿用 plan 的原值（既有行为不变）', () => {
  const entries = [
    { id: 'a', href: 'https://bb.example.edu/f/1?v=1', name: TITLE },
    { id: 'b', href: 'https://bb.example.edu/f/2?v=1', name: TITLE }
  ];
  const next = updateRecords(
    null,
    entries.map(planOf),
    [
      { id: 'a', status: 'failed', size: 100, path: 'A/B 真名.pdf', name: 'B 真名.pdf' },
      { id: 'b', status: 'partial', size: 100, path: 'A/B 真名.pdf', name: 'B 真名.pdf' }
    ],
    5
  );
  assert.deepEqual(next.files.a, {
    id: 'a', href: 'https://bb.example.edu/f/1?v=1', path: TITLE, name: TITLE, size: 100, status: 'failed', updatedAt: 5
  });
  assert.deepEqual(next.files.b, {
    id: 'b', href: 'https://bb.example.edu/f/2?v=1', path: TITLE, name: TITLE, size: 100, status: 'partial', updatedAt: 5
  });
});

test('写回：done 但没带 path 时与改动前逐字一致（老调用方不受影响）', () => {
  const entry = { id: 'a', href: '', name: TITLE };
  const next = updateRecords(null, [planOf(entry)], [{ id: 'a', status: 'done', size: 100 }], 900);
  assert.deepEqual(next.files.a, {
    id: 'a', href: '', path: TITLE, name: TITLE, size: 100, status: 'done', updatedAt: 900
  });
});

// ---------------------------------------------------------------- 召回侧（src/index.js buildPlans）

function makePanel() {
  const api = { calls: [] };
  const names = [
    'setState', 'setCourse', 'setResume', 'setDownloadProgress', 'setScanProgress', 'setNotice',
    'fail', 'setMode', 'showSummary', 'setFiles', 'applyFileEvent', 'setHalted', 'clearHalted', 'setHistory'
  ];
  for (const name of names) {
    api[name] = function () { api.calls.push({ name: name, args: Array.prototype.slice.call(arguments) }); };
  }
  return api;
}

/** 假清单库：只实现 index.js 用到的四个方法，mergeFiles 复刻 db.js 的浅合并。 */
function makeStore(initial) {
  const writes = [];
  let persisted = initial || null;
  return {
    available: true,
    writes: writes,
    async loadManifest() { return persisted; },
    async saveManifest(courseId, manifest) { persisted = manifest; },
    async clearManifest() {},
    async loadHandle() { return null; },
    async saveHandle() {},
    async clearHandle() {},
    async mergeFiles(courseId, records) {
      writes.push(records.map((r) => ({ ...r })));
      const files = { ...((persisted && persisted.files) || {}) };
      for (const record of records) {
        const id = String(record.id);
        files[id] = { ...(files[id] || {}), ...record, id };
      }
      persisted = { courseId: 'c1', version: 2, updatedAt: 1, files };
      return persisted;
    },
    peek() { return persisted; }
  };
}

function harness(over) {
  const extra = over || {};
  const panel = makePanel();
  const store = makeStore(extra.manifest || null);
  const entries = extra.entries || [{ id: 'e1', name: TITLE, size: 100, folderPath: [], url: 'https://bb.example.edu/f/1', href: 'https://bb.example.edu/f/1?v=1' }];
  const rec = { sinkEntries: [] };

  const controller = createController({
    store,
    openSelectDialog: async function (list) {
      return { entries: list, dirHandle: null, expectedBytes: 0, skipExisting: false };
    },
    mountPanel: function () { return panel; },
    settings: { preserveTree: true, downloadConcurrency: 2 },
    location: { href: HREF_PAGE },
    document: null,
    deps: {
      planSkips,
      updateRecords,
      probeAlive: function () { return Promise.resolve({ alive: false }); },
      createScanner: function () { return { async scan() { return entries; } }; },
      createFetcher: function () { return { async probeSize() { return undefined; } }; },
      createSink: async function () {
        return {
          kind: 'zip',
          async download(list, fetcher, api) {
            rec.sinkEntries = list.slice();
            for (const entry of list) {
              // sink 契约：emit file-done 之前 plan.fileName 已经是真名，所以 currentPath 就是落盘相对路径
              api.onProgress({ state: 'file-done', entryId: entry.id, currentPath: REAL, name: REAL });
            }
            return { ok: list.slice(), failed: [], aborted: false };
          }
        };
      }
    }
  });

  return { controller: controller, panel: panel, store: store, rec: rec, entries: entries };
}

test('端到端：第一轮把真名写进清单，第二轮扫描的 plan 用的就是真名', async () => {
  const h = harness();
  await h.controller.ready;

  // 第一轮：没有清单，落盘层按页面标题建计划
  await h.controller.startScan();
  assert.equal(h.controller.getState().plans[0].fileName, TITLE);
  await h.controller.startDownload();
  await h.controller.flushRecords();

  // 真名同时进了内存清单与落库记录
  const record = h.controller.getState().manifest.files.e1;
  assert.equal(record.path, REAL);
  assert.equal(record.name, REAL);
  assert.equal(h.store.writes.length, 1);
  assert.equal(h.store.writes[0][0].path, REAL);
  assert.equal(h.store.writes[0][0].name, REAL);

  // 第二轮：同一份清单、同一次扫描结果（entry 还是页面标题）
  await h.controller.startScan();
  const plan = h.controller.getState().plans[0];
  assert.equal(plan.fileName, REAL);
  assert.equal(relativePath(plan), REAL);
  // 就地覆盖：对话框拿到的 entry 也已经是真名
  assert.equal(h.entries[0].name, REAL);
});

test('召回：entry.href 变了（版本指纹变化）就不用旧真名，退回页面标题', async () => {
  const entries = [{ id: 'e1', name: TITLE, size: 100, folderPath: [], url: 'https://bb.example.edu/f/1', href: 'https://bb.example.edu/f/1?v=2' }];
  const manifest = {
    courseId: 'c1', version: 2, updatedAt: 1,
    files: { e1: { id: 'e1', href: 'https://bb.example.edu/f/1?v=1', path: REAL, name: REAL, size: 100, status: 'done', updatedAt: 1 } }
  };
  const h = harness({ entries: entries, manifest: manifest });
  await h.controller.ready;
  await h.controller.startScan();

  assert.equal(h.controller.getState().plans[0].fileName, TITLE);
  assert.equal(relativePath(h.controller.getState().plans[0]), TITLE);
  assert.equal(h.entries[0].name, TITLE);
});

test('四个不满足条件的入口行为与改动前一致：没清单 / 清单里没这个 id', async () => {
  const none = harness();
  await none.controller.ready;
  await none.controller.startScan();
  assert.equal(none.controller.getState().plans[0].fileName, TITLE);
  assert.equal(none.entries[0].name, TITLE);

  const missing = harness({
    manifest: {
      courseId: 'c1', version: 2, updatedAt: 1,
      files: { other: { id: 'other', href: 'https://bb.example.edu/f/9?v=1', path: REAL, name: REAL, size: 100, status: 'done', updatedAt: 1 } }
    }
  });
  await missing.controller.ready;
  await missing.controller.startScan();
  assert.equal(missing.controller.getState().plans[0].fileName, TITLE);
  assert.equal(missing.entries[0].name, TITLE);
});

test('四个不满足条件的入口行为与改动前一致：status 不是 done / name 不是非空字符串', async () => {
  const cases = [
    { id: 'e1', href: 'https://bb.example.edu/f/1?v=1', path: REAL, name: REAL, size: 100, status: 'partial', updatedAt: 1 },
    { id: 'e1', href: 'https://bb.example.edu/f/1?v=1', path: REAL, name: '', size: 100, status: 'done', updatedAt: 1 },
    { id: 'e1', href: 'https://bb.example.edu/f/1?v=1', path: REAL, name: 123, size: 100, status: 'done', updatedAt: 1 }
  ];
  for (const record of cases) {
    const h = harness({
      manifest: { courseId: 'c1', version: 2, updatedAt: 1, files: { e1: record } }
    });
    await h.controller.ready;
    await h.controller.startScan();
    assert.equal(h.controller.getState().plans[0].fileName, TITLE, JSON.stringify(record));
    assert.equal(h.entries[0].name, TITLE, JSON.stringify(record));
  }
});
