import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { createController } from '../../src/index.js';
import { openSelectDialog } from '../../src/ui/select.js';
import { relativePath } from '../../src/sinks/shared.js';

const HREF = 'https://bb.example.edu/webapps/blackboard/content/listContent.jsp?course_id=_101_1&content_id=_202_1';
const PAGE = 'https://bb.example.edu/webapps/blackboard/content/listContent.jsp?course_id=_101_1&content_id=_202_1';

const ENTRIES = [
  { id: 'e1', name: '第一周讲义.pdf', size: 100, folderPath: ['第 1 周'], url: 'https://bb.example.edu/f/1?id=_1_1' },
  { id: 'e2', name: '第二周讲义.pdf', size: 200, folderPath: ['第 1 周'], url: 'https://bb.example.edu/f/2?id=_2_1' },
  { id: 'e3', name: '截图.png', size: null, folderPath: [], url: 'https://bb.example.edu/f/3?id=_3_1' }
];

const PATH_E1 = '第 1 周/第一周讲义.pdf';
const PATH_E2 = '第 1 周/第二周讲义.pdf';

/** 等待微任务/定时器都跑完：对话框里的 Promise 链没有 await 出口，只能推一下事件循环。 */
async function flush(times) {
  const n = times || 4;
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function setupDom(html) {
  const dom = new JSDOM(html || '<!doctype html><html><head></head><body></body></html>', {
    url: PAGE,
    pretendToBeVisual: true
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  return dom;
}

function skipInfo(rows, extra) {
  const byId = new Map();
  let disk = 0;
  let manifest = 0;
  for (const row of rows || []) {
    byId.set(row[0], { reason: row[1], size: row[2] == null ? null : row[2] });
    if (row[1] === 'manifest') manifest += 1;
    else disk += 1;
  }
  return Object.assign({ byId: byId, disk: disk, manifest: manifest, total: byId.size, diskChecked: true }, extra || {});
}

/* ---------------- 控制器级：选目录 → 摘要 / 缓存 / 取消 ---------------- */

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

/** 用真实的相对路径做比对：磁盘命中按 existingPaths 的 key 判断，清单命中按 done 判断。 */
function fakePlanSkips(input) {
  const existing = input.existingPaths || new Map();
  const files = (input.manifest && input.manifest.files) || {};
  const todo = [];
  const skip = [];
  for (const plan of input.plans) {
    const path = relativePath(plan);
    const id = plan.entry.id;
    if (existing.has(path)) {
      const size = existing.get(path);
      skip.push({ plan: plan, reason: size == null ? 'disk-unverified' : 'disk', size: size });
    } else if (files[id] && files[id].status === 'done') {
      skip.push({ plan: plan, reason: 'manifest', size: files[id].size == null ? null : files[id].size });
    } else {
      todo.push(plan);
    }
  }
  return {
    todo: todo,
    skip: skip,
    stale: [],
    diff: { added: todo.length, changed: 0, unchanged: skip.length, stale: 0, total: input.plans.length }
  };
}

function makeHarness(over) {
  const extra = over || {};
  const panel = makePanel();
  const rec = { planCalls: [], listCalls: [], permCalls: [], hints: [], dialogOpts: null, sinkEntries: null };
  const listExistingFiles = extra.listExistingFiles || async function () {
    return new Map();
  };

  const controller = createController({
    store: makeStore(),
    listExistingFiles: function (handle, options) {
      rec.listCalls.push(handle);
      return listExistingFiles(handle, options);
    },
    pickDirectory: extra.pickDirectory || async function () {
      return null;
    },
    openSelectDialog: function (entries, options) {
      rec.dialogOpts = options;
      if (extra.dialog) return extra.dialog(entries, options, rec);
      return Promise.resolve({ entries: entries, skipExisting: true });
    },
    mountPanel: function (options) {
      panel.opts = options;
      return panel;
    },
    settings: Object.assign({ preserveTree: true, probeConcurrency: 6 }, extra.settings || {}),
    location: { href: HREF },
    document: null,
    deps: {
      planSkips: function (input) {
        rec.planCalls.push(input);
        return fakePlanSkips(input);
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

test('对话框里选目录：摘要与灰标更新，开始下载不再重扫磁盘', async () => {
  const handle = { name: '课件目录' };
  const h = makeHarness({
    // 现成句柄：和「续接上次目录」同一条路径，权限请求必须落在同一同步栈里。
    pickDirectory: function () {
      return handle;
    },
    listExistingFiles: async function () {
      return new Map([[PATH_E1, 100]]);
    },
    dialog: async function (entries, options, rec) {
      const pending = options.onPickDirectory({
        setHint: function (text) {
          rec.hints.push(text);
        }
      });
      rec.pick = await pending;
      return { entries: entries, dirHandle: rec.pick.dirHandle, skipExisting: true };
    }
  });

  await h.controller.ready;
  await h.controller.startScan();
  assert.equal(h.rec.listCalls.length, 0, '扫描时还没有目录句柄，不该扫盘');

  await h.controller.startDownload();

  const pick = h.rec.pick;
  assert.equal(pick.status, 'granted');
  assert.equal(pick.name, '课件目录');
  assert.equal(pick.skipInfo.total, 1);
  assert.equal(pick.skipInfo.disk, 1);
  assert.equal(pick.skipInfo.byId.get('e1').reason, 'disk');
  assert.equal(pick.skipInfo.diskChecked, true);
  assert.equal(h.rec.hints[0], '正在比对磁盘…');

  // 契约 c：对话框里已经比对过，点「开始下载」不得再扫一遍磁盘。
  assert.equal(h.rec.listCalls.length, 1);
  assert.deepEqual(h.rec.sinkEntries.map((entry) => entry.id), ['e2', 'e3']);
});

test('选目录的权限请求落在点击的同步栈里（不 await 就已发出）', async () => {
  const h = makeHarness({
    pickDirectory: function () {
      return { name: '已授权目录' };
    },
    listExistingFiles: async function () {
      return new Map([[PATH_E1, 100]]);
    },
    dialog: async function (entries, options, rec) {
      const pending = options.onPickDirectory({ setHint: function () {} });
      const requests = rec.permCalls.filter((call) => call.options && call.options.request === true);
      assert.equal(requests.length, 1, '权限请求必须在 await 之前就发出去');
      rec.pick = await pending;
      return { entries: entries, dirHandle: rec.pick.dirHandle, skipExisting: true };
    }
  });

  await h.controller.ready;
  await h.controller.startScan();
  await h.controller.startDownload();

  assert.equal(h.rec.pick.status, 'granted');
  assert.equal(h.rec.pick.dirHandle.name, '已授权目录');
  assert.deepEqual(h.rec.sinkEntries.map((entry) => entry.id), ['e2', 'e3']);
});

test('换目录后旧命中数作废：重新扫盘，旧路径不再被跳过', async () => {
  const dirA = { name: '目录A' };
  const dirB = { name: '目录B' };
  let round = 0;
  const h = makeHarness({
    pickDirectory: function () {
      return round === 0 ? dirA : dirB;
    },
    listExistingFiles: async function () {
      round += 1;
      return round === 1 ? new Map([[PATH_E1, 100]]) : new Map([[PATH_E2, 200]]);
    },
    dialog: async function (entries, options, rec) {
      const first = await options.onPickDirectory({ setHint: function () {} });
      const second = await options.onPickDirectory({ setHint: function () {} });
      rec.picks = [first, second];
      return { entries: entries, dirHandle: second.dirHandle, skipExisting: true };
    }
  });

  await h.controller.ready;
  await h.controller.startScan();
  await h.controller.startDownload();

  const [first, second] = h.rec.picks;
  assert.equal(first.dirHandle.name, '目录A');
  assert.equal(first.skipInfo.byId.get('e1').reason, 'disk');
  assert.equal(second.dirHandle.name, '目录B');
  // 旧目录的命中不许带过来，新目录的命中必须生效
  assert.equal(second.skipInfo.byId.has('e1'), false);
  assert.equal(second.skipInfo.byId.get('e2').reason, 'disk');

  assert.equal(h.rec.listCalls.length, 2, '换了目录就必须重新扫盘');
  const scanned = h.rec.planCalls.map((call) => Array.from((call.existingPaths || new Map()).keys()).join(','));
  assert.deepEqual(scanned, ['', PATH_E1, PATH_E2]);
  assert.deepEqual(h.rec.sinkEntries.map((entry) => entry.id), ['e1', 'e3']);
});

test('比对被取消：迟到的旧结果不写摘要，也不当 0 命中', async () => {
  const pendingList = [];
  const listOptions = [];
  const h = makeHarness({
    pickDirectory: function () {
      return { name: '目录X' };
    },
    listExistingFiles: function (handle, options) {
      listOptions.push(options);
      return new Promise(function (resolve) {
        pendingList.push(resolve);
      });
    },
    dialog: async function (entries, options, rec) {
      const api = { setHint: function () {} };
      const first = options.onPickDirectory(api);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const beforeCancel = rec.planCalls.length;
      const second = options.onPickDirectory(api);
      await new Promise((resolve) => setTimeout(resolve, 0));
      pendingList[0](new Map([[PATH_E1, 100]]));
      rec.first = await first;
      rec.planCallsAfterCancel = rec.planCalls.length;
      rec.planCallsBeforeCancel = beforeCancel;
      pendingList[1](new Map([[PATH_E2, 200]]));
      rec.second = await second;
      return { entries: entries, dirHandle: rec.second.dirHandle, skipExisting: true };
    }
  });

  await h.controller.ready;
  await h.controller.startScan();
  await h.controller.startDownload();

  assert.equal(h.rec.first.cancelled, true);
  // 换目录确实用 AbortController 取消了上一次枚举（扫盘不是点完就不管了）
  assert.equal(listOptions[0].signal.aborted, true);
  assert.equal(listOptions[1].signal.aborted, false);
  // 被取消的那一次一条 planSkips 都不许跑：否则「没比对成」会变成「一个都不存在」。
  assert.equal(h.rec.planCallsBeforeCancel, 1);
  assert.equal(h.rec.planCallsAfterCancel, 1);
  assert.equal(h.rec.second.status, 'granted');
  assert.equal(h.rec.second.skipInfo.byId.has('e1'), false);
  assert.equal(h.rec.second.skipInfo.byId.get('e2').reason, 'disk');
  assert.deepEqual(h.rec.sinkEntries.map((entry) => entry.id), ['e1', 'e3']);
});

test('取消勾选「跳过已存在」后，选目录算出的 todo 恢复成全部选中项', async () => {
  const h = makeHarness({
    pickDirectory: function () {
      return { name: '课件目录' };
    },
    listExistingFiles: async function () {
      return new Map([[PATH_E1, 100]]);
    },
    dialog: async function (entries, options, rec) {
      const pick = await options.onPickDirectory({ setHint: function () {} });
      return { entries: entries, dirHandle: pick.dirHandle, skipExisting: false };
    }
  });

  await h.controller.ready;
  await h.controller.startScan();
  await h.controller.startDownload();

  assert.deepEqual(h.rec.sinkEntries.map((entry) => entry.id), ['e1', 'e2', 'e3']);
});

/* ---------------- 对话框级：占位 / 零命中不渲染 / 权限被拒 ---------------- */

test('对话框：比对磁盘期间显示占位并禁用按钮，选完更新灰标与目录标注', async () => {
  const dom = setupDom();
  let settle = null;
  const pending = openSelectDialog(ENTRIES, {
    settings: {},
    skipInfo: skipInfo([], { diskChecked: false }),
    onPickDirectory: function () {
      return new Promise(function (resolve) {
        settle = resolve;
      });
    }
  });

  const dlg = document.querySelector('.bbdl-dialog');
  const btn = dlg.querySelector('[data-act="pick-dir"]');
  assert.equal(btn.hidden, false);
  btn.click();
  assert.equal(btn.disabled, true, '比对期间按钮必须禁用，防重复点击');
  assert.match(dlg.querySelector('.bbdl-hint').textContent, /正在比对磁盘/);

  settle({ status: 'granted', dirHandle: { name: '课件目录' }, name: '课件目录', skipInfo: skipInfo([['e1', 'disk', 100]]) });
  await flush();

  assert.equal(btn.disabled, false);
  const row = Array.from(dlg.querySelectorAll('.bbdl-row--file')).find(function (el) {
    return el.querySelector('.bbdl-row__name').textContent === '第一周讲义.pdf';
  });
  assert.ok(row.classList.contains('bbdl-row--skipped'));
  const status = dlg.querySelector('.bbdl-dir__status').textContent;
  assert.match(status, /课件目录/);
  assert.match(status, /磁盘上已有 1 个/);
  const toggle = dlg.querySelector('.bbdl-switch--skip');
  assert.ok(toggle, '有命中时复选框必须出现');
  assert.match(toggle.textContent, /跳过已存在的文件（1 个/);

  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(await pending, null);
  dom.window.close();
});

test('对话框：skipInfo.total 为 0 时不渲染复选框与说明行（不占位）', async () => {
  const dom = setupDom();
  const pending = openSelectDialog(ENTRIES, {
    settings: {},
    skipInfo: skipInfo([], { diskChecked: false }),
    onPickDirectory: function () {
      return new Promise(function () {});
    }
  });
  const dlg = document.querySelector('.bbdl-dialog');
  assert.equal(dlg.querySelector('.bbdl-switch--skip'), null);
  assert.equal(dlg.querySelector('.bbdl-note--skip'), null);
  // 选了目录但一个都没命中：仍然不渲染
  assert.doesNotMatch(dlg.querySelector('.bbdl-dir__status').textContent, /跳过/);

  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(await pending, null);
  dom.window.close();
});

test('对话框：目录权限被拒时给出降级文案且不崩', async () => {
  const dom = setupDom();
  const pending = openSelectDialog(ENTRIES, {
    settings: {},
    skipInfo: skipInfo([], { diskChecked: false }),
    onPickDirectory: function () {
      return Promise.resolve({
        status: 'denied',
        dirHandle: null,
        name: '课件目录',
        skipInfo: skipInfo([], { diskChecked: false })
      });
    }
  });
  const dlg = document.querySelector('.bbdl-dialog');
  const btn = dlg.querySelector('[data-act="pick-dir"]');
  btn.click();
  await flush();

  const errorEl = dlg.querySelector('.bbdl-dialog__error');
  assert.equal(errorEl.hidden, false);
  const text = errorEl.textContent;
  assert.match(text, /权限/);
  assert.match(text, /默认下载目录/);
  assert.doesNotMatch(text, /[?&]/);
  assert.doesNotMatch(text, /https?:\/\//);
  assert.equal(btn.disabled, false);

  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(await pending, null);
  dom.window.close();
});
