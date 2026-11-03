import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { createController } from '../../src/index.js';
import { mountPanel } from '../../src/ui/panel.js';

const HREF = 'https://bb.example.edu/webapps/blackboard/content/listContent.jsp?course_id=_101_1&content_id=_202_1';
const PAGE = 'https://bb.example.edu/webapps/blackboard/content/listContent.jsp?course_id=_1_1&content_id=_2_1';
const MB = 1024 * 1024;

/** 把 jsdom 挂成全局：panel.js 全程只用 document。 */
function setupDom() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: PAGE, pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  return dom;
}

/** 与 ui-resume.test.js 同一套假面板：只记录调用，不建 DOM。 */
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
  api.texts = function (name) {
    return calls
      .filter(function (call) { return call.name === name; })
      .map(function (call) { return String(call.args[0] == null ? '' : call.args[0]); })
      .filter(Boolean);
  };
  return api;
}

function makeStore(manifest) {
  return {
    available: true,
    async loadManifest() { return manifest || null; },
    async saveManifest() {},
    async mergeFiles() {},
    async clearManifest() {},
    async loadHandle() { return null; },
    async saveHandle() {},
    async clearHandle() {}
  };
}

function harness(over) {
  const extra = over || {};
  const panel = makePanel();
  const rec = { sinkOpts: null, dialogOpts: null, sinkEntries: null, probeCalls: [] };
  const settings = extra.settings || { preserveTree: true, downloadConcurrency: 4 };

  const controller = createController({
    store: makeStore(extra.manifest || null),
    openSelectDialog: async function (entries, options) {
      rec.dialogOpts = options;
      return {
        entries: entries,
        dirHandle: extra.dirHandle || null,
        expectedBytes: 0,
        skipExisting: false
      };
    },
    mountPanel: function (options) {
      panel.opts = options;
      return panel;
    },
    settings: settings,
    location: { href: HREF },
    document: null,
    deps: {
      createScanner: function () {
        return { async scan() { return extra.entries || []; } };
      },
      createSink: async function (options) {
        rec.sinkOpts = options;
        return {
          kind: options.dirHandle ? 'fs' : 'download',
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
        return {
          async probeSize(url) {
            rec.probeCalls.push(url);
            return (extra.probe || {})[url];
          }
        };
      }
    }
  });

  return { controller: controller, panel: panel, rec: rec, settings: settings };
}

const ENTRIES = [
  { id: 'e1', name: 'a.pdf', size: 999, folderPath: [], url: 'https://bb.example.edu/f/1' },
  { id: 'e2', name: 'b.pdf', folderPath: [], url: 'https://bb.example.edu/f/2' },
  { id: 'e3', name: 'c.pdf', folderPath: [], url: 'https://bb.example.edu/f/3' },
  { id: 'e4', name: 'd.pdf', folderPath: [], url: 'https://bb.example.edu/f/4' }
];

/** 清单：e1 有旧体积、e2 是 null、e3 是 0（0 不是「已知」）、e4 没有记录。 */
const MANIFEST = {
  courseId: '_101_1',
  version: 1,
  updatedAt: 1,
  files: {
    e1: { id: 'e1', path: 'a.pdf', name: 'a.pdf', size: 777, status: 'done', updatedAt: 1 },
    e2: { id: 'e2', path: 'b.pdf', name: 'b.pdf', size: null, status: 'done', updatedAt: 1 },
    e3: { id: 'e3', path: 'c.pdf', name: 'c.pdf', size: 0, status: 'done', updatedAt: 1 }
  }
};

test('体积索引：「获取体积」优先于清单，清单 null/0 一律 undefined（绝不返回 0）', async () => {
  const h = harness({ entries: ENTRIES, manifest: MANIFEST, probe: { 'https://bb.example.edu/f/1': 4242 } });
  await h.controller.ready;
  await h.controller.startScan();
  await h.controller.startDownload();

  const sizeOf = h.rec.sinkOpts.sizeOf;
  assert.equal(typeof sizeOf, 'function', 'createSink 必须拿到 sizeOf');
  assert.equal(sizeOf(ENTRIES[0]), 777, '还没探测时退回清单里的旧体积');
  assert.equal(sizeOf(ENTRIES[1]), undefined, '清单 size=null → undefined');
  assert.equal(sizeOf(ENTRIES[2]), undefined, '清单 size=0 → undefined，绝不返回 0');
  assert.equal(sizeOf(ENTRIES[3]), undefined, '清单没有这条记录 → undefined');
  assert.equal(sizeOf({ name: '没有 id 的项.pdf', url: 'https://bb.example.edu/f/9' }), undefined, 'entry.id 缺失 → undefined');
  assert.equal(sizeOf(null), undefined);

  // 对话框里点「获取体积」→ 探测结果必须盖过清单
  await h.rec.dialogOpts.onProbeSizes([ENTRIES[0]], { setRowSize() {} });
  assert.deepEqual(h.rec.probeCalls, ['https://bb.example.edu/f/1']);
  assert.equal(sizeOf(ENTRIES[0]), 4242, '探测结果优先于清单');
  assert.notEqual(sizeOf(ENTRIES[1]), 0);
});

test('探测器报 0 / NaN 不算已知：索引里绝不出现 0', async () => {
  const h = harness({
    entries: ENTRIES,
    manifest: MANIFEST,
    probe: { 'https://bb.example.edu/f/3': 0, 'https://bb.example.edu/f/2': NaN }
  });
  await h.controller.ready;
  await h.controller.startScan();
  await h.controller.startDownload();

  const sizeOf = h.rec.sinkOpts.sizeOf;
  await h.rec.dialogOpts.onProbeSizes([ENTRIES[1], ENTRIES[2]], { setRowSize() {} });

  // 探测结果只认有限正数：0 与 NaN 都不许落进索引，也不许变成「已知 0 字节」
  assert.equal(sizeOf(ENTRIES[2]), undefined);
  assert.equal(sizeOf(ENTRIES[1]), undefined);
});

test('无 FSA：不再喊「逐个交给浏览器下载」，改成「按文件夹打包成 .zip」的一句实话，且不含 URL', async () => {
  const big = [
    { id: 'b1', name: 'v1.mp4', folderPath: [], url: 'https://bb.example.edu/f/b1?content_id=_9_1&token=secret' },
    { id: 'b2', name: 'v2.mp4', folderPath: [], url: 'https://bb.example.edu/f/b2?content_id=_9_2&token=secret' }
  ];
  const manifest = {
    courseId: '_101_1',
    version: 1,
    files: {
      b1: { id: 'b1', path: 'v1.mp4', name: 'v1.mp4', size: 300 * MB, status: 'done', updatedAt: 1 },
      b2: { id: 'b2', path: 'v2.mp4', name: 'v2.mp4', size: 300 * MB, status: 'done', updatedAt: 1 }
    }
  };
  const h = harness({ entries: big, manifest: manifest });
  await h.controller.ready;
  await h.controller.startScan();
  await h.controller.startDownload();

  const all = h.panel.texts('setNotice').filter(Boolean);
  // zip 流式路径下「没有目录就逐个弹窗」已经不成立，那句 500MB 警告必须彻底撤掉
  assert.equal(all.filter(function (text) { return /Chrome\/Edge|逐个交给浏览器|500 MB/.test(text); }).length, 0);
  const notices = all.filter(function (text) { return /打包成 \.zip/.test(text); });
  assert.equal(notices.length, 1, '提示必须只有一次');
  assert.match(notices[0], /没有目录写入权限/);
  assert.doesNotMatch(notices[0], /content_id|token|secret|https?:\/\//);
  assert.ok(h.rec.sinkEntries.length > 0, '提示之后照常开始下载');
});

test('有 FSA（拿到目录句柄）时不提示，走流式落盘', async () => {
  const big = [{ id: 'b1', name: 'v1.mp4', folderPath: [], url: 'https://bb.example.edu/f/b1' }];
  const manifest = {
    courseId: '_101_1',
    version: 1,
    files: { b1: { id: 'b1', path: 'v1.mp4', name: 'v1.mp4', size: 900 * MB, status: 'done', updatedAt: 1 } }
  };
  const h = harness({ entries: big, manifest: manifest, dirHandle: { name: '课件目录' } });
  await h.controller.ready;
  await h.controller.startScan();
  await h.controller.startDownload();

  assert.equal(h.panel.texts('setNotice').filter(function (text) { return /Chrome\/Edge/.test(text); }).length, 0);
  assert.equal(h.rec.sinkOpts.dirHandle.name, '课件目录');
});

test('体积有未知项时不提示：绝不拿已知部分当合计', async () => {
  const mixed = [
    { id: 'b1', name: 'v1.mp4', folderPath: [], url: 'https://bb.example.edu/f/b1' },
    { id: 'b2', name: 'v2.mp4', folderPath: [], url: 'https://bb.example.edu/f/b2' }
  ];
  const manifest = {
    courseId: '_101_1',
    version: 1,
    files: { b1: { id: 'b1', path: 'v1.mp4', name: 'v1.mp4', size: 900 * MB, status: 'done', updatedAt: 1 } }
  };
  const h = harness({ entries: mixed, manifest: manifest });
  await h.controller.ready;
  await h.controller.startScan();
  await h.controller.startDownload();

  assert.equal(h.panel.texts('setNotice').filter(function (text) { return /Chrome\/Edge/.test(text); }).length, 0);
});

test('落盘参数只补默认值：三项默认合并且不覆盖用户既有设置', async () => {
  const h = harness({ entries: [], settings: { preserveTree: false, downloadConcurrency: 2 } });
  assert.equal(h.settings.idleTimeoutMs, 30000);
  assert.equal(h.settings.fileRetries, 1);
  assert.equal(h.settings.serializeOverBytes, 48 * 1024 * 1024);
  assert.equal(h.settings.downloadConcurrency, 2, '面板可改的既有值不许被动');
  assert.equal(h.settings.preserveTree, false);
});

test('失败项建议：只出现在「重试后仍失败」类错误旁，且不含 URL query', () => {
  const dom = setupDom();
  const api = mountPanel({ settings: {}, onScan() {}, onDownload() {}, onRetryFailed() { return null; } });

  api.showSummary({
    ok: [],
    failed: [
      {
        entry: {
          id: 'f1',
          name: 'week1.pdf',
          folderPath: ['Week 1'],
          url: 'https://bb.example.edu/bbcswebdav/pid-1/xid-1_1?content_id=_2_1&token=secret'
        },
        error: '下载停滞 30 秒后重试仍失败 https://bb.example.edu/bbcswebdav/pid-1/xid-1_1?content_id=_2_1&token=secret'
      },
      {
        entry: { id: 'f2', name: 'week2.pdf', folderPath: ['Week 2'], url: 'https://bb.example.edu/x?content_id=_3_1&token=secret' },
        error: '网络中断'
      }
    ]
  });

  const items = document.querySelectorAll('.bbdl-failed__item');
  assert.equal(items.length, 2);

  const hints = document.querySelectorAll('.bbdl-failed__hint');
  assert.equal(hints.length, 1, '只有对应错误才带建议');
  assert.equal(items[0].querySelectorAll('.bbdl-failed__hint').length, 1);
  assert.equal(items[1].querySelectorAll('.bbdl-failed__hint').length, 0);
  assert.match(hints[0].textContent, /只重试失败的/);
  assert.doesNotMatch(hints[0].textContent, /content_id|token|secret|https?:\/\/|\?/);

  const text = document.querySelector('.bbdl-summary').textContent;
  assert.doesNotMatch(text, /content_id|token|secret/);
  assert.match(items[0].querySelector('.bbdl-failed__reason').textContent, /停滞/);
  assert.equal(items[1].querySelector('.bbdl-failed__reason').textContent, '网络中断');
  api.destroy();
  dom.window.close();
});

test('落盘方式三档都有文案：fs / zip / download 各自可见且不为空', () => {
  const dom = setupDom();
  const api = mountPanel({ settings: {}, onScan() {}, onDownload() {}, onRetryFailed() { return null; } });
  const modeEl = document.querySelector('.bbdl-mode');

  const cases = [
    { kind: 'fs', must: /保存到文件夹/ },
    { kind: 'zip', must: /打包成 \.zip/ },
    { kind: 'download', must: /逐文件/ }
  ];
  for (const item of cases) {
    api.setMode(item.kind);
    assert.equal(modeEl.hidden, false, item.kind + ' 不许把整块藏起来');
    assert.ok(modeEl.textContent.length > 0, item.kind + ' 必须有文案');
    assert.match(modeEl.textContent, item.must);
    assert.doesNotMatch(modeEl.textContent, /content_id|token|secret|https?:\/\//);
  }

  api.destroy();
  dom.window.close();
});

test('面板档位跟着真实 sink 走：缺省 zip，fallbackSink=files 才 download，有目录句柄仍是 fs', async () => {
  const plain = harness({ entries: ENTRIES });
  await plain.controller.ready;
  await plain.controller.startScan();
  await plain.controller.startDownload();
  assert.deepEqual(plain.panel.texts('setMode'), ['zip'], '没有目录句柄且未设置 fallbackSink → zip');
  assert.match(plain.panel.texts('setNotice')[0], /打包成 \.zip/);

  const files = harness({ entries: ENTRIES, settings: { fallbackSink: 'files' } });
  await files.controller.ready;
  await files.controller.startScan();
  await files.controller.startDownload();
  assert.deepEqual(files.panel.texts('setMode'), ['download'], 'fallbackSink=files 才是逐文件');
  assert.match(files.panel.texts('setNotice')[0], /逐文件下载/);
  assert.doesNotMatch(files.panel.texts('setNotice')[0], /打包成 \.zip/);

  const fsa = harness({ entries: ENTRIES, dirHandle: { name: '课件目录' } });
  await fsa.controller.ready;
  await fsa.controller.startScan();
  await fsa.controller.startDownload();
  assert.deepEqual(fsa.panel.texts('setMode'), ['fs'], '有目录句柄不变');
  assert.deepEqual(fsa.panel.texts('setNotice').filter(Boolean), []);
});

test('文件换版后不使用旧版本的字节数做截断校验', async () => {
  const entry = { ...ENTRIES[0], href: '/version2' };
  const manifest = { files: { e1: { ...MANIFEST.files.e1, href: '/version1' } } };
  const h = harness({ entries: [entry], manifest });
  await h.controller.ready;
  await h.controller.startScan();
  await h.controller.startDownload();
  assert.equal(h.rec.sinkOpts.sizeOf(entry), undefined);
});
