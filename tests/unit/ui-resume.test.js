import test from 'node:test';
import assert from 'node:assert/strict';

import { createController } from '../../src/index.js';
import { normalizeSkipInfo, skipLabelText, skipNoteText, skipReasonText } from '../../src/ui/select.js';

const HREF = 'https://bb.example.edu/webapps/blackboard/content/listContent.jsp?course_id=_101_1&content_id=_202_1';

const ENTRIES = [
  { id: 'e1', name: '第一周讲义.pdf', size: 100, folderPath: ['第 1 周'], url: 'https://bb.example.edu/f/1' },
  { id: 'e2', name: '第二周讲义.pdf', size: 200, folderPath: ['第 1 周'], url: 'https://bb.example.edu/f/2' },
  { id: 'e3', name: '截图.png', size: null, folderPath: [], url: 'https://bb.example.edu/f/3' }
];

function makePanel() {
  const calls = [];
  const api = { calls: calls, opts: null };
  const names = [
    'setState', 'setCount', 'setScanProgress', 'setDownloadProgress',
    'setMode', 'setNotice', 'setResume', 'showSummary', 'rebind', 'fail', 'destroy'
  ];
  for (const name of names) {
    api[name] = function () {
      calls.push({ name: name, args: Array.prototype.slice.call(arguments) });
    };
  }
  api.last = function (name) {
    const hits = calls.filter(function (call) {
      return call.name === name;
    });
    return hits.length ? hits[hits.length - 1].args : null;
  };
  return api;
}

function makeStore(handle) {
  const rec = { merged: [], saved: [] };
  return {
    available: true,
    rec: rec,
    async loadManifest() {
      return { courseId: '_101_1', version: 1, updatedAt: 1, files: {} };
    },
    async saveManifest(courseId, manifest) {
      rec.saved.push({ courseId: courseId, manifest: manifest });
    },
    async mergeFiles(courseId, records) {
      rec.merged.push({ courseId: courseId, records: records.slice() });
    },
    async clearManifest() {},
    async loadHandle() {
      return handle || null;
    },
    async saveHandle() {},
    async clearHandle() {}
  };
}

function harness(over) {
  const extra = over || {};
  const panel = makePanel();
  const store = extra.store || makeStore(null);
  const handle = extra.handle || null;
  const rec = { planCalls: [], listCalls: [], dialogOpts: null, dialogEntries: null, sinkEntries: null, updateCalls: [], permCalls: [] };

  const controller = createController({
    store: store,
    listExistingFiles: extra.listExistingFiles || async function (dirHandle) {
      rec.listCalls.push(dirHandle);
      const found = new Map();
      found.set('第 1 周/第一周讲义.pdf', 100);
      return found;
    },
    pickDirectory: async function () {
      return handle;
    },
    openSelectDialog: async function (entries, options) {
      rec.dialogOpts = options;
      rec.dialogEntries = entries;
      return {
        entries: entries,
        dirHandle: handle,
        expectedBytes: 300,
        skipExisting: extra.skipExisting === false ? false : true
      };
    },
    mountPanel: function (options) {
      panel.opts = options;
      return panel;
    },
    settings: extra.settings || { preserveTree: true, probeConcurrency: 6 },
    location: { href: HREF },
    document: null,
    deps: {
      planSkips: extra.planSkips || function (input) {
        rec.planCalls.push(input);
        const plans = input.plans;
        return {
          todo: plans.filter(function (plan) {
            return plan.entry.id !== 'e1';
          }),
          skip: [{ plan: plans[0], reason: 'disk', size: 100 }],
          stale: [],
          diff: { added: 1, changed: 0, unchanged: 1, stale: 0, total: plans.length }
        };
      },
      updateRecords: function (manifest, plans, results, now) {
        rec.updateCalls.push({ plans: plans, results: results.slice(), now: now });
        return manifest;
      },
      ensureDirectoryPermission: extra.ensureDirectoryPermission || async function (h, options) {
        rec.permCalls.push({ handle: h, options: options });
        return 'granted';
      },
      createScanner: function () {
        return {
          async scan() {
            return extra.entries || ENTRIES;
          }
        };
      },
      createSink: async function () {
        return {
          kind: 'fs',
          async download(entries, fetcher, api) {
            rec.sinkEntries = entries.slice();
            for (const entry of entries) {
              api.onProgress({ state: 'file-done', entryId: entry.id, filesDone: 1, filesTotal: entries.length });
            }
            return { ok: entries.slice(), failed: [], aborted: false };
          }
        };
      },
      createFetcher: function () {
        return { probeSize: async () => null };
      }
    }
  });

  return { controller: controller, panel: panel, store: store, rec: rec, handle: handle };
}

test('扫描后算出跳过集合，并把摘要交给对话框', async () => {
  const h = harness();
  await h.controller.ready;
  await h.controller.startScan();

  assert.equal(h.panel.last('setState')[0], 'scanned');
  assert.equal(h.rec.planCalls.length, 1);
  // 扫描时还没选目录 → 磁盘现状为空，只能按清单判断
  assert.equal(h.rec.planCalls[0].existingPaths.size, 0);

  const summary = h.controller.getState().skipSummary;
  assert.equal(summary.total, 1);
  assert.equal(summary.disk, 1);
  assert.equal(summary.byId.get('e1').reason, 'disk');

  await h.controller.startDownload();
  const skipInfo = h.rec.dialogOpts.skipInfo;
  assert.equal(skipInfo.total, 1);
  assert.equal(skipInfo.disk, 1);
  assert.equal(skipInfo.manifest, 0);
  assert.equal(skipInfo.diskChecked, false);
});

test('只把 todo 交给 sink，跳过项一个都不下', async () => {
  // 用户在对话框里选了一个目录（扫描时还没有句柄）→ 必须按新目录重算一次
  const h = harness({ handle: { name: '课件目录' } });
  await h.controller.ready;
  await h.controller.startScan();
  await h.controller.startDownload();

  // 对话框返回目录后按新目录重算了一次（扫描时用的不是这个目录）
  assert.equal(h.rec.planCalls.length, 2);
  assert.equal(h.rec.listCalls.length, 1);
  assert.equal(h.rec.planCalls[1].existingPaths.size, 1);
  assert.deepEqual(h.rec.sinkEntries.map((entry) => entry.id), ['e2', 'e3']);
});

test('取消勾选「跳过已存在」后，todo 恢复成全部选中项', async () => {
  const h = harness({ skipExisting: false });
  await h.controller.ready;
  await h.controller.startScan();
  await h.controller.startDownload();

  assert.deepEqual(h.rec.sinkEntries.map((entry) => entry.id), ['e1', 'e2', 'e3']);
});

test('file-done 后清单被合并并落库，体积未知写 null 不写 0', async () => {
  const h = harness();
  await h.controller.ready;
  await h.controller.startScan();
  await h.controller.startDownload();

  assert.equal(h.store.rec.merged.length, 1);
  assert.equal(h.store.rec.merged[0].courseId, '_101_1');
  assert.deepEqual(h.store.rec.merged[0].records, [
    { id: 'e2', status: 'done', size: 200 },
    { id: 'e3', status: 'done', size: null }
  ]);
  // 内存里的那一份也走了契约的 updateRecords
  assert.equal(h.rec.updateCalls.length, 1);
  assert.equal(h.rec.updateCalls[0].results.length, 2);
});

test('「继续上次」权限被拒：同步发出权限请求，并给出降级文案', async () => {
  const handle = { name: '上学期课件' };
  const permCalls = [];
  const h = harness({
    handle: handle,
    store: makeStore(handle),
    ensureDirectoryPermission: function (h2, options) {
      permCalls.push({ handle: h2, options: options });
      return Promise.resolve('denied');
    }
  });

  await h.controller.ready;
  assert.deepEqual(h.panel.last('setResume')[0], { dirName: '上学期课件', granted: false });
  const hydrateCalls = permCalls.length;

  const pending = h.panel.opts.onResume();
  // 同步栈断言：这行之前没有 await，权限请求已经发出去了
  assert.equal(permCalls.length, hydrateCalls + 1);
  assert.deepEqual(permCalls[hydrateCalls].options, { request: true });

  await pending;
  const notice = h.panel.last('setNotice')[0];
  assert.match(notice, /上学期课件/);
  assert.match(notice, /没有拿到写入权限/);
});

test('「继续上次」授权成功后直接续下，不再让用户重选目录', async () => {
  const handle = { name: '上学期课件' };
  const h = harness({ handle: handle, store: makeStore(handle) });

  await h.controller.ready;
  await h.panel.opts.onResume();

  assert.equal(h.panel.last('setResume')[0].granted, true);
  // 对话框拿到的是已授权的句柄本身，而不是再弹一次选择器
  assert.equal(typeof h.rec.dialogOpts.pickDirectory, 'function');
  assert.equal(h.rec.dialogOpts.pickDirectory(), handle);
  assert.ok(h.rec.sinkEntries.length > 0);
  assert.equal(h.panel.last('setState')[0], 'downloading');
});

test('跳过摘要纯函数：计数、文案、无 FSA 降级说明', () => {
  const info = normalizeSkipInfo({
    byId: {
      a: { reason: 'disk', size: 10 },
      b: { reason: 'manifest' },
      c: { reason: 'disk-unverified' }
    },
    truncated: true,
    diskChecked: false
  });

  assert.equal(info.total, 3);
  assert.equal(info.disk, 2);
  assert.equal(info.manifest, 1);
  assert.equal(info.unverified, 1);
  assert.equal(skipLabelText(info), '跳过已存在的文件（3 个，磁盘 2 / 清单 1）');

  const note = skipNoteText(info);
  assert.match(note, /只比对了前面一部分/);
  assert.match(note, /无法核实磁盘文件/);
  assert.match(skipReasonText({ reason: 'disk-unverified' }), /体积无法核实/);

  assert.equal(normalizeSkipInfo(null).total, 0);
  assert.equal(skipLabelText(null), '跳过已存在的文件（0 个）');
  assert.equal(skipNoteText(null), '');
});

test('不是内容列表页时什么都不挂', () => {
  assert.equal(createController({ location: { href: 'https://bb.example.edu/webapps/portal/frameset.jsp' } }), null);
});
