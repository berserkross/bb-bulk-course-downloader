import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { createController } from '../../src/index.js';
import { openSelectDialog, syncPreviewText } from '../../src/ui/select.js';

const PAGE = 'https://bb.example.edu/webapps/blackboard/content/listContent.jsp?course_id=_101_1&content_id=_202_1';

const ENTRIES = [
  { id: 'e1', name: '第一周讲义.pdf', size: 100, folderPath: ['第 1 周'], url: 'https://bb.example.edu/f/1?id=_1_1' },
  { id: 'e2', name: '第二周讲义.pdf', size: 200, folderPath: ['第 1 周'], url: 'https://bb.example.edu/f/2?id=_2_1' },
  { id: 'e3', name: '截图.png', size: null, folderPath: [], url: 'https://bb.example.edu/f/3?id=_3_1' }
];

/** 一个带 query 的下载地址：stale 里的 id 拿不到 rid 时就是整串 URL，绝不许漏进 DOM。 */
const STALE_URL_ID = 'https://bb.example.edu/webapps/bbcswebdav/xid-9_1?course_id=_101_1';

async function flush(times) {
  const n = times || 4;
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: PAGE,
    pretendToBeVisual: true
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  return dom;
}

function makePanel() {
  const calls = [];
  const api = { calls: calls, opts: null };
  const names = ['setState', 'setCount', 'setScanProgress', 'setDownloadProgress', 'setMode', 'setNotice', 'setResume', 'showSummary', 'rebind', 'fail', 'destroy'];
  for (const name of names) {
    api[name] = function () {
      calls.push({ name: name, args: Array.prototype.slice.call(arguments) });
    };
  }
  return api;
}

function makeStore() {
  return {
    available: true,
    async loadManifest() {
      return { courseId: '_101_1', version: 1, updatedAt: 1, files: {} };
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

/** 五个桶各给一个互不相同的数：预览行里任一位串了都能立刻看出来。 */
function sixBucketPlanSkips(input) {
  const plans = input.plans || [];
  return {
    todo: plans,
    skip: [
      { plan: plans[0], reason: 'disk', size: 100 },
      { plan: plans[1], reason: 'manifest-unchanged', size: 200 }
    ],
    stale: [{ id: 'e-old', path: '第 2 周/旧讲义.pdf' }],
    diff: { added: 2, changed: 3, moved: 4, unchanged: 5, stale: 6, unknown: 7, total: 8 }
  };
}

function makeHarness(over) {
  const extra = over || {};
  const panel = makePanel();
  const rec = { planCalls: [], scanFailures: extra.scanFailures || [], dialogSkipInfo: null };

  const deps = {
    updateRecords: function (manifest) {
      return manifest;
    },
    ensureDirectoryPermission: async function () {
      return 'granted';
    },
    createScanner: function () {
      return {
        async scan() {
          return ENTRIES;
        },
        get failures() {
          return rec.scanFailures.slice();
        }
      };
    },
    createSink: async function () {
      return {
        kind: 'fs',
        async download(entries) {
          return { ok: entries.slice(), failed: [], aborted: false };
        }
      };
    },
    createFetcher: function () {
      return { probeSize: async () => null };
    }
  };

  if (!extra.noPlanSkips) {
    deps.planSkips = function (input) {
      rec.planCalls.push(input);
      return (extra.planSkips || sixBucketPlanSkips)(input);
    };
  }

  const controller = createController({
    store: extra.noStore ? null : makeStore(),
    listExistingFiles: async function () {
      return new Map();
    },
    pickDirectory: async function () {
      return null;
    },
    openSelectDialog: function (entries, options) {
      rec.dialogSkipInfo = options.skipInfo;
      return Promise.resolve({ entries: entries, skipExisting: true });
    },
    mountPanel: function (options) {
      panel.opts = options;
      return panel;
    },
    settings: { preserveTree: true, probeConcurrency: 2 },
    location: { href: PAGE },
    document: null,
    deps: deps
  });

  return { controller: controller, panel: panel, rec: rec };
}

function openDialog(options) {
  const pending = openSelectDialog(ENTRIES, Object.assign({ settings: {} }, options || {}));
  return { dlg: document.querySelector('.bbdl-dialog'), pending: pending };
}

async function closeDialog(dom, pending) {
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(await pending, null);
  dom.window.close();
}

/* ---------------- 1. 预览行：六个数 == diff 六桶 ---------------- */

test('预览行：一行六个数，数值分别是 diff 的 added/changed/moved/unchanged/unknown/stale', async () => {
  const dom = setupDom();
  const h = makeHarness();
  await h.controller.ready;
  await h.controller.startScan();

  const info = h.controller.getState().skipSummary;
  assert.equal(info.added, 2);
  assert.equal(info.changed, 3);
  assert.equal(info.moved, 4);
  assert.equal(info.unchanged, 5);
  assert.equal(info.unknown, 7);
  assert.equal(info.stale, 6);

  const { dlg, pending } = openDialog({ skipInfo: info });
  const line = dlg.querySelector('.bbdl-sync');
  assert.ok(line, '有版本知识时预览行必须渲染');
  assert.equal(line.textContent, '本次扫描：新增 2 · 变更 3 · 改名 4 · 未变 5 · 未知 7 · 疑似删除 6');
  // 一行短文本：换行会把下面的列表顶下去。
  assert.doesNotMatch(line.textContent, /\n/);

  await closeDialog(dom, pending);
});

/* ---------------- 2. 首次扫描：两个块都不渲染，不留占位 ---------------- */

test('首次扫描（无清单无跳过）：预览行与疑似删除块都不渲染，DOM 里不留空占位', async () => {
  const dom = setupDom();
  const h = makeHarness({
    planSkips: function (input) {
      const plans = input.plans || [];
      // 首次扫描的样子：全部是新增，没有任何版本知识。
      return {
        todo: plans,
        skip: [],
        stale: [],
        diff: { added: plans.length, changed: 0, moved: 0, unchanged: 0, stale: 0, unknown: 0, total: plans.length }
      };
    }
  });
  await h.controller.ready;
  await h.controller.startScan();

  const info = h.controller.getState().skipSummary;
  assert.equal(info.added, ENTRIES.length);
  assert.equal(syncPreviewText(info), '', '没有版本知识时预览文本为空');

  const { dlg, pending } = openDialog({ skipInfo: info });
  assert.equal(dlg.querySelector('.bbdl-sync'), null);
  assert.equal(dlg.querySelector('.bbdl-toolbar__row--sync'), null);
  assert.equal(dlg.querySelector('.bbdl-stale'), null);
  assert.doesNotMatch(dlg.querySelector('.bbdl-dialog__toolbar').textContent, /本次扫描|疑似删除/);

  await closeDialog(dom, pending);
});

/* ---------------- 3. 疑似删除：只列相对路径，没有按钮，没有 URL ---------------- */

test('疑似删除块：展开后逐行是相对路径，整块不含 http 与 ?，也没有任何按钮', async () => {
  const dom = setupDom();
  const info = {
    total: 1,
    disk: 0,
    manifest: 1,
    manifestUnchanged: 1,
    diskChecked: true,
    unchanged: 1,
    unknown: 0,
    stale: 2,
    staleList: [
      { id: STALE_URL_ID, path: '第 2 周/旧讲义.pdf' },
      { id: 'e-gone', path: 'https://bb.example.edu/webapps/bbcswebdav/xid-8_1?course_id=_101_1' }
    ]
  };

  const { dlg, pending } = openDialog({ skipInfo: info });
  const box = dlg.querySelector('.bbdl-stale');
  assert.ok(box, 'stale > 0 时必须渲染疑似删除块');
  assert.equal(box.getAttribute('open'), null, '默认折叠，展开由用户点');
  assert.equal(box.querySelector('.bbdl-stale__head').textContent, '疑似删除 2 个（只提示，不会删除本地文件）');

  const items = Array.from(box.querySelectorAll('.bbdl-stale__item')).map((el) => el.textContent);
  assert.deepEqual(items, ['第 2 周/旧讲义.pdf', 'webapps/bbcswebdav/xid-8_1']);

  assert.doesNotMatch(box.innerHTML, /http/i);
  assert.doesNotMatch(box.textContent, /\?/);
  assert.equal(box.querySelectorAll('button').length, 0);
  assert.equal(box.querySelectorAll('input').length, 0);
  assert.doesNotMatch(box.textContent, /删除本地文件）$\s*\n?[^]*删除\s*\d/, '块里没有任何删除操作');

  await closeDialog(dom, pending);
});

/* ---------------- 4. 控制器层：scanFailed 真的被传下去 ---------------- */

test('控制器：扫描有失败文件夹时 planSkips 收到 scanFailed: true', async () => {
  const ok = makeHarness();
  await ok.controller.ready;
  await ok.controller.startScan();
  assert.equal(ok.rec.planCalls.length, 1);
  assert.equal(ok.rec.planCalls[0].scanFailed, false, '没有失败文件夹时不许乱报 true');
  assert.equal(ok.controller.getState().skipSummary.scanFailures, 0);

  const bad = makeHarness({ scanFailures: [new Error('第 1 周超时'), new Error('第 3 周 500')] });
  await bad.controller.ready;
  await bad.controller.startScan();
  assert.equal(bad.rec.planCalls.length, 1);
  assert.equal(bad.rec.planCalls[0].scanFailed, true);
  const summary = bad.controller.getState().skipSummary;
  assert.equal(summary.scanFailures, 2, '失败数取的是扫描结束那一刻的快照');
});

/* ---------------- 5. manifest-unchanged：进 manifestUnchanged / unchanged，不进 disk ---------------- */

test('manifest-unchanged 计入 manifestUnchanged 与 unchanged，而不是磁盘桶', async () => {
  const dom = setupDom();
  const h = makeHarness({
    planSkips: function (input) {
      const plans = input.plans || [];
      return {
        todo: [plans[1]],
        skip: [{ plan: plans[0], reason: 'manifest-unchanged', size: 100 }],
        stale: [],
        diff: { added: 1, changed: 0, moved: 0, unchanged: 1, stale: 0, unknown: 0, total: 2 }
      };
    }
  });
  await h.controller.ready;
  await h.controller.startScan();

  const info = h.controller.getState().skipSummary;
  assert.equal(info.manifestUnchanged, 1);
  assert.equal(info.unchanged, 1);
  assert.equal(info.manifest, 1);
  assert.equal(info.disk, 0, '清单命中不许被算成磁盘命中');
  assert.equal(info.byId.get('e1').reason, 'manifest-unchanged');

  const { dlg, pending } = openDialog({ skipInfo: info });
  assert.match(dlg.querySelector('.bbdl-note--skip').textContent, /清单里已完成、上游未变的文件本轮不再下载/);
  const row = Array.from(dlg.querySelectorAll('.bbdl-row--file')).find(function (el) {
    return el.querySelector('.bbdl-row__name').textContent === '第一周讲义.pdf';
  });
  assert.ok(row.classList.contains('bbdl-row--skipped'));

  await closeDialog(dom, pending);
});

/* ---------------- 6. 开关文案 + skipTouched ---------------- */

test('开关文案：有版本知识时是同步口径，全 0 时保持旧文案', async () => {
  const dom = setupDom();
  const rows = { e1: { reason: 'disk', size: 100 }, e2: { reason: 'disk', size: 200 }, e3: { reason: 'manifest-unchanged', size: null } };
  const many = openDialog({ skipInfo: { byId: rows, diskChecked: true, unchanged: 5, unknown: 0, stale: 0 } });
  const label = many.dlg.querySelector('.bbdl-switch--skip').textContent;
  assert.equal(label, '只下载新增与变更（跳过未变 5 个）');

  const oldRows = { e1: { reason: 'disk', size: 100 }, e2: { reason: 'disk', size: 200 }, e3: { reason: 'manifest', size: null } };
  const old = openDialog({ skipInfo: { byId: oldRows, diskChecked: true } });
  assert.equal(old.dlg.querySelector('.bbdl-switch--skip').textContent, '跳过已存在的文件（3 个，磁盘 2 / 清单 1）');

  await closeDialog(dom, many.pending);
  await closeDialog(dom, old.pending);
});

test('用户手动取消勾选后再次 applySkipInfo，不许把勾选状态改回来', async () => {
  const dom = setupDom();
  const next = { byId: { e1: { reason: 'disk', size: 100 } }, diskChecked: true };
  const { dlg, pending } = openDialog({
    skipInfo: { byId: { e1: { reason: 'disk', size: 100 } }, diskChecked: true, unchanged: 2, unknown: 0, stale: 0 },
    onPickDirectory: function () {
      return Promise.resolve({ status: 'granted', dirHandle: { name: '课件目录' }, name: '课件目录', skipInfo: next });
    }
  });

  const toggle = dlg.querySelector('.bbdl-switch--skip');
  const input = toggle.querySelector('input.bbdl-check');
  assert.equal(input.checked, true);

  input.checked = false;
  input.dispatchEvent(new dom.window.Event('change'));

  dlg.querySelector('[data-act="pick-dir"]').click();
  await flush();

  assert.equal(dlg.querySelector('.bbdl-switch--skip').querySelector('input.bbdl-check').checked, false, 'skipTouched 之后不许被默认值覆盖');
  assert.equal(dlg.querySelector('.bbdl-switch--skip').textContent, '跳过已存在的文件（1 个，磁盘 1）', '摘要换了文案要跟着换');

  await closeDialog(dom, pending);
});

/* ---------------- 7. 降级分支：diff 形状与正常路径一致 ---------------- */

test('降级分支：没有 planSkips 模块时 diff 也是六桶齐备的形状', async () => {
  const h = makeHarness({ noPlanSkips: true });
  await h.controller.ready;
  await h.controller.startScan();

  const info = h.controller.getState().skipSummary;
  for (const key of ['added', 'changed', 'moved', 'unchanged', 'unknown', 'stale']) {
    assert.equal(typeof info[key], 'number', key + ' 必须是数字');
  }
  assert.equal(info.added, ENTRIES.length);
  assert.equal(info.changed, 0);
  assert.equal(info.moved, 0);
  assert.equal(info.unchanged, 0);
  assert.equal(info.unknown, 0);
  assert.equal(info.stale, 0);
  assert.equal(info.total, 0);
  assert.deepEqual(info.staleList, []);
  assert.equal(info.scanFailures, 0);
});

test('老版本 planSkips 缺 moved/unknown 键时按 0 补齐，UI 不分叉', async () => {
  const h = makeHarness({
    planSkips: function (input) {
      const plans = input.plans || [];
      return {
        todo: plans,
        skip: [],
        stale: [],
        diff: { added: 1, changed: 0, unchanged: 2, stale: 0, total: 3 }
      };
    }
  });
  await h.controller.ready;
  await h.controller.startScan();

  const info = h.controller.getState().skipSummary;
  assert.equal(info.added, 1);
  assert.equal(info.unchanged, 2);
  assert.equal(info.moved, 0);
  assert.equal(info.unknown, 0);
  assert.equal(syncPreviewText(info), '本次扫描：新增 1 · 变更 0 · 改名 0 · 未变 2 · 未知 0');
});

/* ---------------- 8. 扫描失败的文件夹数：并进已有的提示行 ---------------- */

test('scanFailures > 0：提示行以文件夹失败开场，且整行不带 URL', async () => {
  const dom = setupDom();
  const info = {
    byId: { e1: { reason: 'disk', size: 100 } },
    diskChecked: true,
    unchanged: 0,
    unknown: 12,
    stale: 0,
    scanFailures: 3
  };

  const { dlg, pending } = openDialog({ skipInfo: info });
  const note = dlg.querySelector('.bbdl-note--skip');
  assert.ok(note, '扫描失败时提示行必须出现');
  assert.ok(note.textContent.startsWith('本次扫描有 3 个文件夹失败'), '最严重的事实排在最前面，实际：' + note.textContent);
  assert.match(note.textContent, /其中的文件一律按未知处理（会重下）/);
  assert.doesNotMatch(note.textContent, /http/i);
  assert.doesNotMatch(note.textContent, /\?/);
  // 只有一句话：不新增第三个块。
  assert.equal(dlg.querySelectorAll('.bbdl-note--skip').length, 1);
  assert.equal(dlg.querySelector('.bbdl-stale'), null);

  await closeDialog(dom, pending);
});

test('scanFailures 为 0：提示行里不出现「文件夹失败」', async () => {
  const dom = setupDom();
  // 降级路径（磁盘不可核实）本来就会出提示行：扫描没失败时这句不许混进来。
  const info = { byId: { e1: { reason: 'disk', size: 100 } }, diskChecked: false, scanFailures: 0 };

  const { dlg, pending } = openDialog({ skipInfo: info });
  const note = dlg.querySelector('.bbdl-note--skip');
  assert.ok(note, '降级路径的提示行照旧出现');
  assert.doesNotMatch(note.textContent, /文件夹失败/);

  await closeDialog(dom, pending);
});

