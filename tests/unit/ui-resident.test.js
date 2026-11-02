import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';

import { mountPanel } from '../../src/ui/panel.js';
import { openSelectDialog, selectionStorageKey, readSelection } from '../../src/ui/select.js';
import { createController } from '../../src/index.js';

const PAGE = 'https://bb.example.edu/webapps/blackboard/content/listContent.jsp?course_id=_101_1&content_id=_202_1';

function setupDom() {
  // VirtualConsole 静默：a[download] 的 click 在 jsdom 里只会打印 "not implemented" 噪声。
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: PAGE,
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole()
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.sessionStorage = dom.window.sessionStorage;
  return dom;
}

/** 每条 entry 的 url 都带 query：只要它漏进 DOM，断言就会抓到。 */
function makeEntries(n) {
  const list = [];
  for (let i = 1; i <= n; i += 1) {
    list.push({
      id: 'e' + i,
      name: '文件 ' + i + '.pdf',
      size: 1024 * i,
      folderPath: ['第 1 周'],
      url: 'https://bb.example.edu/bbcswebdav/xid-' + i + '?content_id=_1_' + i + '&token=SECRET' + i
    });
  }
  return list;
}

function assertNoLeak(root, where) {
  const html = root.innerHTML;
  for (const token of ['?', '#', 'https://', 'http://', 'token=', 'content_id=', 'SECRET']) {
    assert.equal(html.includes(token), false, where + ' 的 DOM 里不该出现 ' + token);
  }
}

/* ---------------- 面板：课程标识 + 导出 / 导入控件 ---------------- */

test('面板顶部常驻课程标识：优先课程名，取不到退回 courseId，都没有就收起', () => {
  setupDom();
  const api = mountPanel({ settings: {}, onScan() {}, onDownload() {} });
  const courseEl = document.querySelector('.bbdl-course');
  assert.ok(courseEl, '面板里应该有课程标识行');
  assert.equal(courseEl.hidden, true, '还没拿到课程时整行收起');

  api.setCourse('_101_1', '高等数学');
  assert.equal(courseEl.hidden, false);
  assert.equal(courseEl.textContent, '当前课程：高等数学（_101_1）');

  api.setCourse('_101_1', '');
  assert.equal(courseEl.textContent, '当前课程：_101_1', '没有课程名时退回 courseId');

  api.setCourse('', '');
  assert.equal(courseEl.hidden, true);
  assert.equal(courseEl.textContent, '');

  // 课程名里混进 query 时同样要被削掉：标识行是常驻的，不能当泄露出入口。
  api.setCourse('_101_1', '高数 listContent.jsp?course_id=_101_1&token=SECRET');
  assert.equal(courseEl.textContent.includes('?'), false);
  assert.equal(courseEl.textContent.includes('SECRET'), false);
});

test('设置块：导出清单按钮只在有处理器时出现，点击交给处理器', () => {
  setupDom();
  const off = mountPanel({ settings: {}, onScan() {}, onDownload() {} });
  assert.ok(off, '没处理器也要能挂起来');
  const offBtn = document.querySelector('.bbdl-settings [data-act="export-manifest"]');
  assert.ok(offBtn, '按钮本身留在 DOM 里');
  assert.equal(offBtn.closest('.bbdl-settings__row').hidden, true, '没有导出能力时整行收起');

  setupDom();
  const calls = [];
  mountPanel({
    settings: {},
    onScan() {},
    onDownload() {},
    onExportManifest() { calls.push('export'); }
  });
  const row = document.querySelector('.bbdl-settings [data-act="export-manifest"]').closest('.bbdl-settings__row');
  assert.equal(row.hidden, false);
  document.querySelector('.bbdl-settings [data-act="export-manifest"]').click();
  assert.deepEqual(calls, ['export']);
});

test('设置块：导入清单用 input[type=file]，选完文件交给处理器并清空自身', async () => {
  setupDom();
  const seen = [];
  mountPanel({
    settings: {},
    onScan() {},
    onDownload() {},
    onImportManifest(file) { seen.push(file); }
  });
  const input = document.querySelector('.bbdl-settings input[type="file"]');
  assert.ok(input, '导入入口必须是 input[type=file]');
  assert.equal(input.hidden, false);
  assert.equal(input.accept.includes('json'), true);

  // jsdom 不能真的选文件：把 files 定义成这次要交出去的那一个。
  const picked = { name: '_101_1-manifest.json', text: async () => '{}' };
  Object.defineProperty(input, 'files', { value: [picked], configurable: true });
  input.dispatchEvent(new window.Event('change'));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(seen, [picked]);
});

/* ---------------- 勾选记忆（select.js） ---------------- */

function fileChecks() {
  return Array.from(document.querySelectorAll('.bbdl-dialog .bbdl-row--file .bbdl-check'));
}

function closeDialog() {
  document.querySelector('.bbdl-dialog button[data-act="cancel"]').click();
}

function openMemoryDialog(entries, over) {
  return openSelectDialog(entries, Object.assign({ settings: {}, pickDirectory: () => null }, over || {}));
}

test('勾选记忆：按 bbdl:sel:<courseId>:<pageId> 存 sessionStorage，关掉再开能恢复', () => {
  setupDom();
  const entries = makeEntries(3);
  const key = 'bbdl:sel:_101_1:_202_1';
  assert.equal(selectionStorageKey('_101_1', '_202_1'), key);
  assert.equal(selectionStorageKey('', '_202_1'), '', '缺一半身份就不记账');

  const first = openMemoryDialog(entries, { courseId: '_101_1', pageId: '_202_1' });
  assert.equal(fileChecks().filter((box) => box.checked).length, 3, '默认全选不变');
  fileChecks()[1].click();
  assert.equal(fileChecks()[1].checked, false);
  closeDialog();
  void first;

  const stored = JSON.parse(window.sessionStorage.getItem(key));
  assert.deepEqual(stored, ['e1', 'e3'], '取消勾选的 id 不该留在记忆里');
  assert.deepEqual(readSelection(key), ['e1', 'e3']);

  void openMemoryDialog(entries, { courseId: '_101_1', pageId: '_202_1' });
  const boxes = fileChecks();
  assert.deepEqual(boxes.map((box) => box.checked), [true, false, true], '重新打开要恢复上次的勾选');
  closeDialog();
});

test('勾选记忆：恢复时已消失的 id 静默丢弃，不报错也不留空行', () => {
  setupDom();
  const entries = makeEntries(3);
  const key = 'bbdl:sel:_101_1:_202_1';
  window.sessionStorage.setItem(key, JSON.stringify(['e1', 'ghost-1', 'ghost-2']));

  void openMemoryDialog(entries, { courseId: '_101_1', pageId: '_202_1' });
  assert.equal(fileChecks().length, 3);
  assert.deepEqual(fileChecks().map((box) => box.checked), [true, false, false], '只恢复还在的 id');
  closeDialog();
});

test('勾选记忆：不同 pageId 各自独立，不串台', () => {
  setupDom();
  const entries = makeEntries(3);
  window.sessionStorage.setItem('bbdl:sel:_101_1:_202_1', JSON.stringify(['e1']));

  void openMemoryDialog(entries, { courseId: '_101_1', pageId: '_303_1' });
  assert.deepEqual(fileChecks().map((box) => box.checked), [true, true, true], '另一页默认全选');
  closeDialog();
  assert.equal(window.sessionStorage.getItem('bbdl:sel:_101_1:_202_1'), JSON.stringify(['e1']), '别的页不能改写这门课的记录');
  assert.deepEqual(JSON.parse(window.sessionStorage.getItem('bbdl:sel:_101_1:_303_1')), ['e1', 'e2', 'e3']);

  void openMemoryDialog(entries, { courseId: '_101_1', pageId: '_202_1' });
  assert.deepEqual(fileChecks().map((box) => box.checked), [true, false, false], '切回来仍然按各自记录恢复');
  closeDialog();
});

test('勾选记忆：不覆盖「跳过已存在」的默认逻辑', () => {
  setupDom();
  const entries = makeEntries(3);
  // 摘要里有可跳过的项（byId 非空 => total > 0）时默认勾上「跳过已存在」，
  // 记忆里存着别的勾选也不该把它改掉。
  window.sessionStorage.setItem('bbdl:sel:_101_1:_202_1', JSON.stringify(['e1']));
  void openMemoryDialog(entries, {
    courseId: '_101_1',
    pageId: '_202_1',
    skipInfo: { byId: new Map([['e3', { reason: 'disk', size: 10 }]]) }
  });

  const skipBox = document.querySelector('.bbdl-dialog .bbdl-switch--skip .bbdl-check');
  assert.ok(skipBox, '对话框里应该有「跳过已存在」的开关');
  assert.equal(skipBox.checked, true, '跳过已存在仍按摘要默认勾上');
  assert.deepEqual(fileChecks().map((box) => box.checked), [true, false, false], '文件勾选按记忆走');
  closeDialog();
});

/* ---------------- index.js 接线 ---------------- */

function boot(over) {
  setupDom();
  const extra = over || {};
  const log = [];
  const downloads = [];
  const entries = makeEntries(3);
  const plans = [
    { entry: entries[0], segments: ['第 1 周'], fileName: '文件 1.pdf' },
    { entry: entries[1], segments: ['第 1 周'], fileName: '文件 2.pdf' }
  ];
  const store = {
    saves: 0,
    async loadManifest() { return null; },
    async loadHandle() { return null; },
    async saveHandle() { return true; },
    async mergeFiles() { log.push('mergeFiles'); return true; },
    async saveManifest(courseId, manifest) {
      this.saves += 1;
      log.push('saveManifest:' + (manifest && manifest.version) + ':' + (manifest && manifest.scans ? manifest.scans.length : 0));
      return true;
    }
  };
  const deps = {
    createFetcher: () => ({}),
    createScanner: () => ({ failures: [], scan: async () => entries }),
    createSink: async () => ({ download: async () => extra.result || { ok: [], failed: [], aborted: false } }),
    planSkips: () => ({
      todo: plans,
      skip: [],
      stale: [],
      diff: { added: 2, changed: 1, moved: 1, unchanged: 4, stale: 1, unknown: 1, total: 3 }
    }),
    updateRecords: (manifest) => {
      log.push('updateRecords');
      return { courseId: '_101_1', version: 2, updatedAt: 1, files: { f1: { id: 'f1', status: 'done' } } };
    },
    appendScanHistory: (manifest, snapshot) => {
      log.push('appendScanHistory');
      return Object.assign({}, manifest, { scans: [snapshot] });
    },
    exportManifestPack: ({ courseId, manifest }) => ({
      format: 'bbdl-manifest',
      version: 1,
      exportedAt: 1,
      courses: [{ courseId: courseId, files: manifest.files }]
    }),
    importManifestPack: extra.importResult || (() => ({
      ok: true,
      course: { courseId: '_101_1', manifest: { courseId: '_101_1', version: 2, files: { a: {}, b: {} } } }
    })),
    mergeManifests: (current, incoming) => {
      log.push('mergeManifests');
      return Object.assign({}, current, { files: Object.assign({}, current.files, incoming.files) });
    },
    ensureDirectoryPermission: async () => 'granted'
  };
  const dialog = [];
  const controller = createController({
    store,
    settings: {},
    courseName: '高等数学',
    location: { href: PAGE },
    document: globalThis.document,
    listExistingFiles: async () => new Map(),
    pickDirectory: async () => null,
    openSelectDialog(passed, options) {
      dialog.push(options);
      return Promise.resolve({ entries: passed, skipExisting: false });
    },
    downloadTextFile(doc, text, fileName) {
      downloads.push({ text: text, fileName: fileName });
      return { click() {} };
    },
    deps
  });
  return { controller, log, store, downloads, dialog, entries };
}

function noticeText() {
  return document.querySelector('.bbdl-notice').textContent;
}

test('接线：扫描后先 updateRecords 再 appendScanHistory 再 saveManifest，历史同时进面板', async () => {
  const ctx = boot();
  await ctx.controller.ready;
  assert.equal(ctx.controller.getState().scans.length, 0);
  assert.equal(document.querySelector('.bbdl-course').textContent, '当前课程：高等数学（_101_1）');

  await ctx.controller.startScan();

  assert.deepEqual(ctx.log, ['updateRecords', 'appendScanHistory', 'saveManifest:2:1'], '落库顺序是契约的一部分');
  const scans = ctx.controller.getState().scans;
  assert.equal(scans.length, 1);
  assert.equal(scans[0].added, 2);
  assert.equal(scans[0].stale, 1);
  assert.equal(scans[0].changedPaths.length, 2, '变更路径取自这轮要下发的计划');
  assert.equal(scans[0].changedPaths[0].path, '第 1 周/文件 1.pdf');

  const rows = Array.from(document.querySelectorAll('.bbdl-history__row'));
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent, /新增 2 · 变更 1 · 改名 1 · 未变 4 · 未知 1 · 疑似删除 1/);
  assertNoLeak(document.querySelector('.bbdl-panel'), '扫描后的面板');
});

test('接线：导出清单走 a[download]，文件名是 <courseId>-manifest.json', async () => {
  const ctx = boot();
  await ctx.controller.ready;
  await ctx.controller.startScan();

  const out = ctx.controller.exportManifest();

  assert.equal(out.fileName, '_101_1-manifest.json');
  assert.equal(ctx.downloads.length, 1);
  assert.equal(ctx.downloads[0].fileName, '_101_1-manifest.json');
  assert.equal(ctx.downloads[0].text, out.text);
  assert.equal(JSON.parse(ctx.downloads[0].text).format, 'bbdl-manifest');
  assert.equal(noticeText(), '已导出 1 条记录到 _101_1-manifest.json');
});

test('接线：导入清单合并后再落库（历史不被清空），坏包只报原因不写库', async () => {
  const ctx = boot();
  await ctx.controller.ready;
  await ctx.controller.startScan();
  const savesAfterScan = ctx.store.saves;

  const file = { text: async () => JSON.stringify({ format: 'bbdl-manifest', version: 1, courses: [] }) };
  await ctx.controller.importManifest(file);

  assert.equal(ctx.store.saves, savesAfterScan + 1, '导入必须落库一次');
  assert.ok(ctx.log.includes('mergeManifests'), '导入必须先合并再存，否则扫描历史被清空');
  assert.equal(noticeText(), '已导入 2 条记录（合并 3 条）');
  assert.equal(ctx.controller.getState().scans.length, 1, '合并保留扫描历史');

  // 坏包：只显示原因，一次库都不写。
  const bad = boot({ importResult: () => ({ ok: false, error: '不支持的清单包版本（只认第 1 版）' }) });
  await bad.controller.ready;
  await bad.controller.startScan();
  const savesBefore = bad.store.saves;
  await bad.controller.importManifest({ text: async () => JSON.stringify({ format: 'x' }) });
  assert.equal(bad.store.saves, savesBefore, '坏包不得写库');
  assert.equal(noticeText(), '导入失败：不支持的清单包版本（只认第 1 版）');

  // 不是 JSON：同样只报原因。
  await bad.controller.importManifest({ text: async () => 'not json' });
  assert.equal(noticeText(), '导入失败：不是合法的 JSON 文件');
});

test('接线：多课程包只合并当前课程，并显示门数', async () => {
  const ctx = boot({
    importResult: () => ({
      ok: true,
      courses: [
        { courseId: '_101_1', manifest: { courseId: '_101_1', version: 2, files: { a: {} } } },
        { courseId: '_999_9', manifest: { courseId: '_999_9', version: 2, files: { z: {} } } }
      ]
    })
  });
  await ctx.controller.ready;
  await ctx.controller.startScan();

  await ctx.controller.importManifest({ text: async () => '{}' });

  assert.equal(noticeText(), '已导入 1 门课（合并 2 条）');
  assert.equal(ctx.log.filter((item) => item === 'mergeManifests').length, 1, '别的课程不并进来');
});

test('接线：partialPackages 非空时给出部分交付提示，字段缺失按 [] 兜底', async () => {
  const ctx = boot({ result: { ok: [], failed: [], aborted: false, partialPackages: [{ missingCount: 2 }, { missing: ['x', 'y', 'z'] }] } });
  await ctx.controller.ready;
  await ctx.controller.startScan();
  await ctx.controller.startDownload();

  assert.equal(noticeText(), '本次有 2 个包只交付了部分文件（共缺 5 个），其余已记为失败可重试。');
  assertNoLeak(document.querySelector('.bbdl-panel'), '部分包提示后的面板');
});

test('接线：zip sink 的 missing 是数字（真实形状）时也要数进「共缺 N 个」', async () => {
  // zip.js 产出的是 { name, saved, missing: 2 }，missing 是条数而不是数组。
  const ctx = boot({ result: { ok: [], failed: [], aborted: false, partialPackages: [{ name: 'Week 1.zip', saved: 3, missing: 2 }] } });
  await ctx.controller.ready;
  await ctx.controller.startScan();
  await ctx.controller.startDownload();

  assert.equal(noticeText(), '本次有 1 个包只交付了部分文件（共缺 2 个），其余已记为失败可重试。');
});

test('接线：对话框拿到 (courseId, pageId)，勾选记忆才有分桶依据', async () => {
  const ctx = boot();
  await ctx.controller.ready;
  await ctx.controller.startScan();
  await ctx.controller.startDownload();

  assert.equal(ctx.dialog.length, 1);
  assert.equal(ctx.dialog[0].courseId, '_101_1');
  assert.equal(ctx.dialog[0].pageId, '_202_1');
});
