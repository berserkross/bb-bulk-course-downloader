import test from 'node:test';
import assert from 'node:assert/strict';

import { createController } from '../../src/index.js';

const HREF = 'https://bb.example.edu/webapps/blackboard/content/listContent.jsp?course_id=_101_1&content_id=_202_1';

/** 与 ui-memory.test.js 同一套假面板：只记录调用，不建 DOM。 */
function makePanel() {
  const calls = [];
  const api = { calls: calls };
  const names = [
    'setState', 'setCount', 'setScanProgress', 'setDownloadProgress',
    'setMode', 'setNotice', 'setResume', 'setFiles', 'applyFileEvent',
    'setHalted', 'clearHalted', 'showSummary', 'rebind', 'fail', 'destroy'
  ];
  for (const name of names) {
    api[name] = function () {
      calls.push({ name: name, args: Array.prototype.slice.call(arguments) });
    };
  }
  api.texts = function (name) {
    return calls
      .filter(function (call) { return call.name === name; })
      .map(function (call) { return String(call.args[0] == null ? '' : call.args[0]); })
      .filter(Boolean);
  };
  return api;
}

function makeStore() {
  return {
    available: true,
    async loadManifest() { return null; },
    async saveManifest() {},
    async mergeFiles() {},
    async clearManifest() {},
    async loadHandle() { return null; },
    async saveHandle() {},
    async clearHandle() {}
  };
}

const ENTRIES = [
  { id: 'e1', name: 'a.pdf', size: 10, folderPath: [], url: 'https://bb.example.edu/f/1?content_id=_1_1&token=SECRET1' },
  { id: 'e2', name: 'b.pdf', size: 20, folderPath: [], url: 'https://bb.example.edu/f/2?content_id=_1_2&token=SECRET2' }
];

function harness(over) {
  const extra = over || {};
  const panel = makePanel();
  const rec = { sinkOpts: null, dialogOpts: null };

  const controller = createController({
    store: makeStore(),
    openSelectDialog: async function (entries, options) {
      rec.dialogOpts = options;
      return { entries: entries, dirHandle: extra.dirHandle || null, expectedBytes: 0, skipExisting: false };
    },
    mountPanel: function () { return panel; },
    settings: extra.settings || { preserveTree: true, downloadConcurrency: 4 },
    location: { href: HREF },
    document: null,
    deps: {
      createScanner: function () {
        return { async scan() { return extra.entries || ENTRIES; } };
      },
      createSink: async function (options) {
        rec.sinkOpts = options;
        return {
          kind: extra.sinkKind || 'zip',
          async download(entries) {
            if (extra.download) return extra.download(entries);
            return { ok: entries.slice(), failed: [], aborted: false };
          }
        };
      },
      createFetcher: function () {
        return {
          async probeSize(url) {
            if (extra.probeThrows) throw extra.probeThrows;
            return (extra.probe || {})[url];
          }
        };
      },
      // 会话自检注入：halted 用例一旦带上 pending 就走进自动续跑的真实 fetch；这里彻底离线，永不触网
      probeAlive: function () {
        return Promise.resolve({ alive: false });
      }
    }
  });

  return { controller: controller, panel: panel, rec: rec };
}

/** 临时接管控制台：诊断日志是本次改动的可验收产物，必须能被断言。 */
function capture() {
  const logs = { info: [], warn: [], error: [], log: [] };
  const original = { info: console.info, warn: console.warn, error: console.error, log: console.log };
  for (const level of ['info', 'warn', 'error', 'log']) {
    console[level] = function () { logs[level].push(Array.prototype.slice.call(arguments)); };
  }
  return {
    logs: logs,
    texts: function (level) { return logs[level].map(function (args) { return String(args[0]); }); },
    restore: function () {
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
      console.log = original.log;
    }
  };
}

async function download(h) {
  await h.controller.ready;
  await h.controller.startScan();
  return h.controller.startDownload();
}

test('批次诊断：每次下载各一条「开始下载」「批次结束」，只有结构化对象、没有 URL', async () => {
  const cap = capture();
  try {
    const h = harness();
    await download(h);

    assert.equal(cap.logs.info.length, 3, '每批次一条开始 + 一条批次开始 + 一条结束');
    assert.equal(cap.logs.info[0][0], '[bbdl] 开始下载');
    assert.deepEqual(cap.logs.info[0][1], { sink: 'zip', entries: 2 });
    assert.equal(cap.logs.info[1][0], '[bbdl] 批次开始');
    assert.equal(cap.logs.info[2][0], '[bbdl] 批次结束');
    assert.deepEqual(cap.logs.info[2][1], { sink: 'zip', ok: 2, failed: 0, aborted: false, halted: false });

    const all = JSON.stringify(cap.logs.info);
    assert.equal(all.includes('http'), false, '诊断日志里不许出现 URL');
    assert.equal(all.includes('token='), false, '诊断日志里不许出现 query');
  } finally {
    cap.restore();
  }
});

test('零工作量：panel.fail 含「没有开始任何文件」，showSummary 不再说「下载完成 成功 0」，并打一条 zero-work', async () => {
  const cap = capture();
  try {
    const h = harness({ download: async () => ({ ok: [], failed: [], aborted: false }) });
    await download(h);

    const fails = h.panel.texts('fail');
    assert.equal(fails.length, 1, '零工作量必须走错误态');
    assert.match(fails[0], /没有开始任何文件/);
    assert.match(fails[0], /提交 2 个文件/);
    assert.match(fails[0], /成功 0、失败 0/);
    assert.match(fails[0], /\[bbdl\]/, '文案必须告诉用户把 [bbdl] 日志发给开发者');
    assert.deepEqual(h.panel.texts('showSummary'), [], '零工作量不许再写「成功 0 个，失败 0 个」摘要');

    const errors = cap.logs.error.filter(function (args) { return args[0] === '[bbdl] zero-work'; });
    assert.equal(errors.length, 1, 'zero-work 只打一次');
    assert.deepEqual(errors[0][1], { sink: 'zip', entries: 2, total: 2, ok: 0, failed: 0, aborted: false, halted: null });
  } finally {
    cap.restore();
  }
});

test('零工作量不误伤正常完成：全成功仍走 showSummary，且没有 zero-work 日志', async () => {
  const cap = capture();
  try {
    const h = harness();
    await download(h);
    assert.deepEqual(h.panel.texts('fail'), []);
    assert.equal(h.panel.texts('showSummary').length, 1);
    assert.equal(cap.logs.error.length, 0);
  } finally {
    cap.restore();
  }
});

test('零工作量不误伤部分失败：ok 非空就照旧走摘要', async () => {
  const cap = capture();
  try {
    const h = harness({
      download: async (entries) => ({ ok: [entries[0]], failed: [{ id: 'e2', error: '下载失败' }], aborted: false })
    });
    await download(h);
    assert.deepEqual(h.panel.texts('fail'), []);
    assert.equal(h.panel.texts('showSummary').length, 1);
    assert.equal(cap.logs.error.length, 0);
  } finally {
    cap.restore();
  }
});

test('零工作量不误伤取消：aborted 时不进错误分支', async () => {
  const cap = capture();
  try {
    const h = harness({ download: async () => ({ ok: [], failed: [], aborted: true }) });
    await download(h);
    assert.deepEqual(h.panel.texts('fail'), []);
    assert.equal(h.panel.texts('showSummary').length, 1);
    assert.equal(cap.logs.error.length, 0);
  } finally {
    cap.restore();
  }
});

test('零工作量不误伤停机：halted 时不进错误分支', async () => {
  const cap = capture();
  try {
    const h = harness({
      download: async () => ({ ok: [], failed: [], aborted: false, halted: { reason: 'session-expired', pendingCount: 2 } })
    });
    await download(h);
    assert.deepEqual(h.panel.texts('fail'), []);
    assert.equal(h.panel.texts('showSummary').length, 1);
    assert.equal(cap.logs.error.length, 0);
    // 批次结束那条按含 halted 字段认领（v2.5.3 起批次开头多了一条 [bbdl] 批次开始）
    const ended = cap.logs.info.map((call) => call[1]).find((o) => o && Object.prototype.hasOwnProperty.call(o, 'halted'));
    assert.deepEqual(ended, { sink: 'zip', ok: 0, failed: 0, aborted: false, halted: true });
  } finally {
    cap.restore();
  }
});

test('零工作量：entries 为空的老结果不算零工作量（没有提交就没有该干没干）', async () => {
  const cap = capture();
  try {
    const h = harness({ entries: [], download: async () => ({ ok: [], failed: [], aborted: false }) });
    await h.controller.ready;
    await h.controller.startScan();
    assert.equal(cap.logs.info.length, 0, '没有条目就不该开批次');
    assert.deepEqual(h.panel.texts('fail'), []);
  } finally {
    cap.restore();
  }
});

test('体积探测全部失败：报告带 ok/fail/firstError，且只 warn 一次', async () => {
  const cap = capture();
  try {
    const h = harness();
    await download(h);
    const report = await h.rec.dialogOpts.onProbeSizes(ENTRIES, { setRowSize() {} });

    assert.equal(report.ok, 0);
    assert.equal(report.fail, 2);
    assert.ok(report.firstError, '失败必须有原因，不能又是一个沉默的未知');
    const warns = cap.logs.warn.filter(function (args) { return args[0] === '[bbdl] 体积探测失败'; });
    assert.equal(warns.length, 1, '整批只 warn 一次，绝不逐文件刷屏');
    assert.deepEqual(warns[0][1], { fail: 2, reason: report.firstError });
  } finally {
    cap.restore();
  }
});

test('体积探测失败原因先抹 query：URL 进日志 / 对话框前只剩路径', async () => {
  const cap = capture();
  try {
    const h = harness({ probeThrows: new Error('探测失败 https://bb.example.edu/f/1?content_id=_1_1&token=SECRET1') });
    await download(h);
    const report = await h.rec.dialogOpts.onProbeSizes([ENTRIES[0]], { setRowSize() {} });

    assert.equal(report.fail, 1);
    assert.equal(report.firstError.includes('token='), false, 'query 必须被抹掉');
    assert.equal(report.firstError.includes('?'), false, 'query 必须被抹掉');
    assert.equal(report.firstError.includes('https://bb.example.edu/f/1'), true, '路径本身保留，便于定位');
    const warned = JSON.stringify(cap.logs.warn);
    assert.equal(warned.includes('SECRET1'), false);
  } finally {
    cap.restore();
  }
});

test('体积探测全部成功：fail 为 0、不打 warn、每次命中的体积照样落进索引', async () => {
  const cap = capture();
  try {
    const h = harness({ probe: { 'https://bb.example.edu/f/1?content_id=_1_1&token=SECRET1': 4096 } });
    await download(h);
    const report = await h.rec.dialogOpts.onProbeSizes(ENTRIES, { setRowSize() {} });

    assert.equal(report.ok, 1);
    assert.equal(report.fail, 1, '第二条没有体积，仍要算失败');
    assert.equal(typeof h.rec.sinkOpts.sizeOf, 'function');

    const again = await h.rec.dialogOpts.onProbeSizes([ENTRIES[0]], { setRowSize() {} });
    assert.deepEqual({ ok: again.ok, fail: again.fail }, { ok: 1, fail: 0 });
    const warns = cap.logs.warn.filter(function (args) { return args[0] === '[bbdl] 体积探测失败'; });
    assert.equal(warns.length, 1, '只有那一批有失败，全成功的这一批不许再 warn');
  } finally {
    cap.restore();
  }
});

test('对话框体积提示：全部成功保持原样，有失败时追加「N 个体积探测失败」', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: HREF });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const { openSelectDialog } = await import('../../src/ui/select.js');

  /** 打开真实对话框、点一次「获取体积」，取回提示行文字。 */
  // 条目必须不带已知体积：带了 size 的条目会被对话框当作「体积已知」，根本不会走探测。
  const unsized = ENTRIES.map(function (entry) {
    return { id: entry.id, name: entry.name, folderPath: [], url: entry.url };
  });

  async function probeHint(report) {
    const pending = openSelectDialog(unsized.slice(), {
      settings: { preserveTree: true, probeSizes: true },
      courseId: '_101_1',
      pageId: '_202_1',
      onProbeSizes: async function () { return report; }
    });
    pending.then(function () {}, function () {});

    const hintEl = document.querySelector('.bbdl-hint');
    assert.ok(hintEl, '对话框里找得到提示行');
    const probeBtn = Array.prototype.find.call(
      document.querySelectorAll('.bbdl-dialog button'),
      function (el) { return el.textContent.indexOf('获取体积') >= 0; }
    );
    assert.ok(probeBtn, '对话框里找得到「获取体积」按钮');

    probeBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise(function (resolve) { setTimeout(resolve, 0); });
    const text = hintEl.textContent;
    const overlay = document.querySelector('.bbdl-overlay');
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    return text;
  }

  assert.equal(await probeHint({ ok: 2, fail: 0, firstError: '' }), '体积已更新。');

  const withFailures = await probeHint({
    ok: 0,
    fail: 2,
    firstError: '探测请求没有返回体积 https://bb.example.edu/f/1?content_id=_1_1&token=SECRET'
  });
  assert.match(withFailures, /体积已更新（2 个体积探测失败）/);
  assert.equal(withFailures.includes('token='), false, '原因里的 URL 必须先抹 query 再进对话框');
  assert.equal(withFailures.includes('?'), false, '原因里不许留下问号之后的任何东西');
});
