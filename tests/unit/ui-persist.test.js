import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { createController } from '../../src/index.js';
import { mountPanel } from '../../src/ui/panel.js';

const HREF = 'https://bb.example.edu/webapps/blackboard/content/listContent.jsp?course_id=_101_1&content_id=_202_1';
const PAGE = 'https://bb.example.edu/webapps/blackboard/content/listContent.jsp?course_id=_101_1&content_id=_202_1';

const ENTRIES = [
  { id: 'e1', name: '第一周讲义.pdf', size: 100, folderPath: ['第 1 周'], url: 'https://bb.example.edu/f/1?id=_1_1' },
  { id: 'e2', name: '第二周讲义.pdf', size: 200, folderPath: ['第 1 周'], url: 'https://bb.example.edu/f/2?id=_2_1' }
];

const PATH_E1 = '第 1 周/第一周讲义.pdf';

async function flush(times) {
  const n = times || 4;
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: PAGE, pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  return dom;
}

function makePanel() {
  const api = { calls: [], opts: null };
  const names = ['setState', 'setCount', 'setScanProgress', 'setDownloadProgress', 'setMode', 'setNotice', 'setResume', 'showSummary', 'rebind', 'fail', 'destroy'];
  for (const name of names) {
    api[name] = function () {
      api.calls.push({ name: name, args: Array.prototype.slice.call(arguments) });
    };
  }
  return api;
}

function callsOf(panel, name) {
  return panel.calls.filter((call) => call.name === name);
}

function makeStore(extra) {
  const rec = { saveCalls: [], clearCalls: 0, loadCalls: 0 };
  const store = {
    available: true,
    async loadManifest() {
      return { courseId: '_101_1', version: 1, updatedAt: 1, files: {} };
    },
    async saveManifest() {},
    async mergeFiles() {},
    async clearManifest() {},
    async loadHandle() {
      rec.loadCalls += 1;
      return null;
    },
    async saveHandle(courseId, handle) {
      rec.saveCalls.push({ courseId: courseId, handle: handle });
      if (extra && extra.saveThrows) throw new Error('IndexedDB 写入失败');
    },
    async clearHandle() {
      rec.clearCalls += 1;
    }
  };
  return { store: store, rec: rec };
}

function makeHarness(over) {
  const extra = over || {};
  const panel = makePanel();
  const made = makeStore(extra);
  const rec = { listCalls: [], permCalls: [], sinkEntries: null, dialogs: 0, store: made.rec };

  const controller = createController({
    store: made.store,
    listExistingFiles: function (handle, options) {
      rec.listCalls.push(handle);
      const impl = extra.listExistingFiles;
      return impl ? impl(handle, options) : Promise.resolve(new Map());
    },
    pickDirectory: extra.pickDirectory || async function () {
      return null;
    },
    openSelectDialog: function (entries, options) {
      rec.dialogs += 1;
      rec.dialogOpts = options;
      if (extra.dialog) return extra.dialog(entries, options, rec);
      return Promise.resolve({ entries: entries, skipExisting: true });
    },
    mountPanel: function (options) {
      panel.opts = options;
      return panel;
    },
    settings: { preserveTree: true, probeConcurrency: 6 },
    location: { href: HREF },
    document: null,
    deps: {
      planSkips: function (input) {
        const existing = input.existingPaths || new Map();
        const todo = [];
        const skip = [];
        for (const plan of input.plans) {
          if (existing.has(PATH_E1) && plan.entry.id === 'e1') skip.push({ plan: plan, reason: 'disk', size: existing.get(PATH_E1) });
          else todo.push(plan);
        }
        return { todo: todo, skip: skip, stale: [], diff: { added: todo.length, changed: 0, unchanged: skip.length, stale: 0, total: input.plans.length } };
      },
      updateRecords: function (manifest) {
        return manifest;
      },
      ensureDirectoryPermission: extra.ensureDirectoryPermission || async function (handle, options) {
        rec.permCalls.push({ handle: handle, options: options });
        return 'granted';
      },
      createScanner: function () {
        return {
          async scan() {
            return ENTRIES;
          }
        };
      },
      createSink: async function () {
        return {
          kind: 'fs',
          async download(entries) {
            rec.sinkEntries = entries.slice();
            return { ok: entries.slice(), failed: [], aborted: false };
          }
        };
      },
      createFetcher: function () {
        return { probeSize: async () => null };
      }
    }
  });

  return { controller: controller, panel: panel, rec: rec };
}

/** 在对话框里点一次「选择保存位置…」，返回对话框最终交回的选择。 */
function pickInDialog(entries, options, rec) {
  const report = { setHint: function () {} };
  return Promise.resolve(options.onPickDirectory(report)).then(function (pick) {
    rec.pick = pick;
    return { entries: entries, dirHandle: pick && pick.dirHandle, skipExisting: true };
  });
}

test('选目录且授权成功：句柄写进 IndexedDB 一次，参数是同一个 handle', async () => {
  const handle = { name: '课件目录' };
  const h = makeHarness({
    pickDirectory: function () {
      return handle;
    },
    listExistingFiles: async function () {
      return new Map([[PATH_E1, 100]]);
    },
    dialog: function (entries, options, rec) {
      return pickInDialog(entries, options, rec);
    }
  });

  await h.controller.ready;
  await h.controller.startScan();
  await h.controller.startDownload();
  await flush(2);

  assert.equal(h.rec.pick.status, 'granted');
  assert.equal(h.rec.store.saveCalls.length, 1, '授权成功后必须写一次句柄');
  assert.equal(h.rec.store.saveCalls[0].courseId, h.controller.getState().courseId);
  assert.equal(h.rec.store.saveCalls[0].handle, handle, '写的必须是用户选的那个句柄对象，不是副本');
});

test('授权被拒：一次都不写句柄，也不清掉已有的句柄', async () => {
  const h = makeHarness({
    pickDirectory: function () {
      return { name: '无权限目录' };
    },
    ensureDirectoryPermission: async function () {
      return 'denied';
    },
    dialog: function (entries, options, rec) {
      return pickInDialog(entries, options, rec);
    }
  });

  await h.controller.ready;
  await h.controller.startScan();
  await h.controller.startDownload();
  await flush(2);

  assert.equal(h.rec.pick.status, 'denied');
  assert.equal(h.rec.store.saveCalls.length, 0, '没拿到权限就不该写');
  assert.equal(h.rec.store.clearCalls, 0, '没拿到权限也不许清：句柄本身仍然有效');
});

test('saveHandle 抛错：下载照常，用户看到正常进度而不是异常', async () => {
  const handle = { name: '写库会失败的目录' };
  const h = makeHarness({
    saveThrows: true,
    pickDirectory: function () {
      return handle;
    },
    listExistingFiles: async function () {
      return new Map([[PATH_E1, 100]]);
    },
    dialog: function (entries, options, rec) {
      return pickInDialog(entries, options, rec);
    }
  });

  await h.controller.ready;
  await h.controller.startScan();
  await h.controller.startDownload();
  await flush(4);

  assert.equal(h.rec.store.saveCalls.length, 1, '写失败也说明确实尝试过');
  assert.deepEqual(h.rec.sinkEntries.map((entry) => entry.id), ['e2'], '清单命中的跳过，其余照下');
  assert.equal(callsOf(h.panel, 'fail').length, 0, '写句柄失败不许把面板打成错误态');
});

test('无 FSA（选择器返回 null）：不写也不清句柄', async () => {
  const h = makeHarness({
    pickDirectory: async function () {
      return null;
    },
    dialog: function (entries, options, rec) {
      return pickInDialog(entries, options, rec);
    }
  });

  await h.controller.ready;
  await h.controller.startScan();
  await h.controller.startDownload();
  await flush(2);

  assert.equal(h.rec.pick.cancelled, true);
  assert.equal(h.rec.store.saveCalls.length, 0);
  assert.equal(h.rec.store.clearCalls, 0);
});

test('记住句柄后「继续上次」立刻可用：面板收到 granted，且不再提示没有可续接目录', async () => {
  const handle = { name: '课件目录' };
  const h = makeHarness({
    pickDirectory: function () {
      return handle;
    },
    // 只有第一次对话框里选目录；续接触发的第二次直接走「按清单跳过」。
    dialog: function (entries, options, rec) {
      if (rec.dialogs > 1) return Promise.resolve({ entries: entries, skipExisting: true });
      return pickInDialog(entries, options, rec);
    }
  });

  await h.controller.ready;
  await h.controller.startScan();
  await h.controller.startDownload();
  await flush(2);

  assert.equal(h.rec.store.saveCalls.length, 1);
  const resumes = callsOf(h.panel, 'setResume');
  assert.ok(resumes.length >= 1);
  assert.deepEqual(resumes[resumes.length - 1].args[0], { dirName: '课件目录', granted: true });
  assert.equal(h.controller.getState().savedHandle, handle, '同一次会话里必须马上记得住');

  // 走面板上的「继续上次」：权限桩返回 granted，应当直接续接而不是提示没目录。
  await h.panel.opts.onResume();
  await flush(2);

  const notices = callsOf(h.panel, 'setNotice').map((call) => String(call.args[0] || ''));
  assert.equal(notices.some((text) => text.indexOf('还没有可续接的目录') !== -1), false, '存过句柄就绝不能再报没有目录');
  assert.equal(h.rec.store.saveCalls.length, 2, '续接成功顺手刷新一次 updatedAt');
  assert.equal(h.rec.store.saveCalls[1].handle, handle);
});

test('panel：同一文件连续两次重试报「第 2 次」，文件结束后计数归零', () => {
  setupDom();
  const api = mountPanel({ settings: {}, onScan() {}, onDownload() {}, onRetryFailed: function () { return null; }, onResume() {} });
  const line = function () {
    return document.querySelector('.bbdl-progress__text').textContent;
  };
  const tick = { filesDone: 0, filesTotal: 2, bytesDone: 10, bytesTotal: 100 };

  api.setDownloadProgress(Object.assign({ state: 'file-retry', currentPath: '第 1 周/第一周讲义.pdf' }, tick));
  assert.match(line(), /重试中（第 1 次）/);

  api.setDownloadProgress(Object.assign({ state: 'file-retry', currentPath: '第 1 周/第一周讲义.pdf' }, tick));
  assert.match(line(), /重试中（第 2 次）/);
  assert.match(line(), /第一周讲义\.pdf/, '状态行必须带上那个文件名');

  api.setDownloadProgress(Object.assign({ state: 'file-done', currentPath: '第 1 周/第一周讲义.pdf' }, { filesDone: 1, filesTotal: 2, bytesDone: 100, bytesTotal: 100 }));
  assert.doesNotMatch(line(), /重试中/, '文件结束后不许残留上一次的重试计数');

  api.setDownloadProgress(Object.assign({ state: 'file-retry', currentPath: '第 1 周/第二周讲义.pdf?token=SECRET' }, tick));
  assert.match(line(), /重试中（第 1 次）/);
  assert.doesNotMatch(line(), /token=SECRET/, 'URL query 绝不进 DOM');
  api.destroy();
});

test('并发重试按文件计数，ZIP 模式显示实际并发', () => {
  setupDom();
  const api = mountPanel({ settings: { downloadConcurrency: 4 } });
  for (const entryId of ['a', 'b', 'a']) {
    api.setDownloadProgress({ state: 'file-retry', entryId, currentPath: entryId + '/slides.pdf' });
    if (entryId === 'b') assert.match(document.querySelector('.bbdl-progress__text').textContent, /第 1 次/);
  }
  assert.match(document.querySelector('.bbdl-progress__text').textContent, /第 2 次/);
  api.setMode('zip');
  assert.match(document.body.textContent, /ZIP 并发为 1/);
  api.destroy();
});
