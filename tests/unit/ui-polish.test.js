import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

import { CSS } from '../../src/ui/styles.js';
import { mountPanel, progressLine, redactUrlText } from '../../src/ui/panel.js';
import { openSelectDialog } from '../../src/ui/select.js';

const DIST = new URL('../../dist/bb-bulk-course-downloader.user.js', import.meta.url);
const PAGE = 'https://bb.example.edu/webapps/blackboard/content/listContent.jsp?course_id=_1_1&content_id=_2_1';

/** 把 jsdom 挂成全局：panel.js / select.js 全程只用 document，不 import 任何浏览器 API。 */
function setupDom(html) {
  const dom = new JSDOM(html || '<!doctype html><html><head></head><body></body></html>', {
    url: PAGE,
    pretendToBeVisual: true
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  return dom;
}

/** 取 CSS 里某个选择器的规则体：直接读样式文本，不假设 jsdom 会算层叠样式。 */
function cssBlock(selector) {
  const start = CSS.indexOf(selector + ' {');
  assert.notEqual(start, -1, 'CSS 里找不到 ' + selector);
  const open = CSS.indexOf('{', start);
  const close = CSS.indexOf('}', open);
  return CSS.slice(open + 1, close);
}

test('挂载幂等：同一页面连续 mountPanel 两次只留 1 个 .bbdl-panel', () => {
  setupDom();
  const opts = { settings: {}, onScan() {}, onDownload() {} };
  const first = mountPanel(opts);
  const second = mountPanel(opts);
  assert.equal(document.querySelectorAll('.bbdl-panel').length, 1);
  // 第二份控制器复用了第一份的 DOM：状态推进仍然作用在同一个节点上。
  second.setState('scanned', { count: 3 });
  assert.equal(document.querySelector('.bbdl-panel').dataset.state, 'scanned');
  first.destroy();
  assert.equal(document.querySelectorAll('.bbdl-panel').length, 0);
});

test('挂载幂等（原始复现）：把 dist 产物 eval 两次仍然只有 1 个 .bbdl-panel', { skip: !existsSync(DIST) && 'dist 未构建' }, async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: PAGE, runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  window.TextEncoder = TextEncoder;
  window.TextDecoder = TextDecoder;
  const code = readFileSync(DIST, 'utf8');

  window.eval(code);
  await new Promise((resolve) => {
    if (window.document.readyState === 'complete') resolve();
    else window.addEventListener('load', () => resolve(), { once: true });
  });
  window.eval(code);

  assert.equal(window.document.querySelectorAll('.bbdl-panel').length, 1);
  dom.window.close();
});

test('滚动：dialog 不再 overflow: hidden，列表体自身 overflow: auto 且没有写死 max-height', () => {
  const dialog = cssBlock('.bbdl-dialog');
  assert.match(dialog, /overflow:\s*visible/);
  assert.doesNotMatch(dialog, /overflow:\s*hidden/);
  assert.match(dialog, /min-height:\s*0/);

  const tree = cssBlock('.bbdl-tree');
  assert.match(tree, /overflow:\s*auto/);
  assert.doesNotMatch(tree, /max-height/);
  assert.match(tree, /overscroll-behavior:\s*contain/);
});

test('行高：.bbdl-row 系列显式 line-height、不用 height/overflow 裁字，且组是块流不被压扁', () => {
  const row = cssBlock('.bbdl-row');
  assert.match(row, /line-height:\s*1\.45/);
  assert.match(row, /min-height:\s*30px/);
  // 注意不能用 \bheight：min-height 的连字符也算词边界，会把 min-height: 30px 误判成固定高度。
  assert.doesNotMatch(row, /(?:^|[;\s])height:\s*\d+px/m);
  assert.doesNotMatch(row, /overflow:\s*hidden/);
  assert.match(cssBlock('.bbdl-row__name'), /line-height:\s*1\.45/);
  assert.match(cssBlock('.bbdl-row__path'), /line-height:\s*1\.45/);

  // 回归：column flex + 组 overflow: hidden 会把 .bbdl-group 压成十几像素，组头压住上一组的行。
  const tree = cssBlock('.bbdl-tree');
  assert.match(tree, /display:\s*block/);
  assert.doesNotMatch(tree, /flex-direction:\s*column/);
  assert.doesNotMatch(cssBlock('.bbdl-group'), /overflow:\s*hidden/);
  assert.doesNotMatch(cssBlock('.bbdl-row--folder'), /position:\s*sticky/);
});

test('进度：bytesTotal 已知报百分比、未知只报已下载字节，两种都不出 NaN/Infinity', () => {
  const known = progressLine({ filesDone: 3, filesTotal: 20, bytesDone: 12300000, bytesTotal: 45600000 });
  assert.match(known, /11\.7 MB \/ 43\.5 MB（27%）/);
  assert.match(known, /3\/20 个文件/);
  assert.doesNotMatch(known, /NaN|Infinity/);

  const unknown = progressLine({ filesDone: 3, filesTotal: 20, bytesDone: 12300000, bytesTotal: 0 });
  assert.match(unknown, /已下载 11\.7 MB/);
  assert.match(unknown, /3\/20 个文件/);
  assert.match(unknown, /总量未知，不显示百分比/);
  assert.doesNotMatch(unknown, /%/);
  assert.doesNotMatch(unknown, /NaN|Infinity/);

  // 旧 payload 字段兜底：改造期的 sink 还在报 done/bytes。
  const legacy = progressLine({ done: 2, total: 5, bytes: 2048 });
  assert.match(legacy, /2\.0 KB/);
  assert.doesNotMatch(legacy, /NaN|Infinity/);

  assert.doesNotMatch(progressLine(null), /NaN|Infinity/);
});

test('脱敏：错误文本里的 URL query（content_id / token）被抹掉，路径保留', () => {
  const text = redactUrlText('HTTP 403 <https://bb.example.edu/bbcswebdav/pid-1/xid-1_1?content_id=_2_1&token=secret> 失败');
  assert.doesNotMatch(text, /content_id|token|secret/);
  assert.match(text, /xid-1_1/);
});

test('失败清单：逐条渲染名称+路径+原因，且不把 URL query 渲进 DOM', async () => {
  setupDom();
  const api = mountPanel({ settings: {}, onScan() {}, onDownload() {}, onRetryFailed: () => null });
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
        error: 'HTTP 403 https://bb.example.edu/bbcswebdav/pid-1/xid-1_1?content_id=_2_1&token=secret'
      },
      { entry: { id: 'f2', name: 'week2.pdf', folderPath: ['Week 2'], url: 'https://bb.example.edu/x?content_id=_3_1' }, error: '网络中断' }
    ]
  });

  const items = document.querySelectorAll('.bbdl-failed__item');
  assert.equal(items.length, 2);
  assert.equal(items[0].querySelector('.bbdl-failed__name').textContent, 'week1.pdf');
  assert.equal(items[0].querySelector('.bbdl-failed__path').textContent, 'Week 1');
  const reasonText = items[0].querySelector('.bbdl-failed__reason').textContent;
  assert.match(reasonText, /HTTP 403/);
  // 失败原因里文件名和相对路径都单独显示了，绝对 URL 不该再刷屏（同一条理由也写进了 M4 §4 红线）。
  assert.doesNotMatch(reasonText, /https?:|bbcswebdav|content_id|token/);

  const summaryText = document.querySelector('.bbdl-summary').textContent;
  assert.doesNotMatch(summaryText, /content_id|token|secret/);
  api.destroy();
});

test('只重试失败的：只把失败项交回上层，全部成功后清单消失', async () => {
  setupDom();
  const calls = [];
  const api = mountPanel({
    settings: {},
    onScan() {},
    onDownload() {},
    onRetryFailed(entries) {
      calls.push(entries);
      return Promise.resolve({ ok: entries, failed: [] });
    }
  });

  api.showSummary({
    ok: [],
    failed: [
      { entry: { id: 'f1', name: 'a.pdf', folderPath: ['A'], url: 'https://bb.example.edu/x?id=_1_1' }, error: '超时' },
      { entry: { id: 'f2', name: 'b.pdf', folderPath: ['B'], url: 'https://bb.example.edu/y?id=_2_1' }, error: '超时' }
    ]
  });

  const retry = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.indexOf('只重试失败的') === 0);
  assert.ok(retry, '找不到「只重试失败的」按钮');
  retry.click();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].map((entry) => entry.id), ['f1', 'f2']);
  // 重试要用原始 URL（query 完整），只是不许渲染出来。
  assert.match(calls[0][0].url, /content_id|\?id=_1_1/);
  assert.equal(document.querySelectorAll('.bbdl-failed').length, 0);
  api.destroy();
});

test('对话框：类型勾选 + 文件名搜索过滤行，按体积排序把未探测项稳定置底', async () => {
  const dom = setupDom();
  const entries = [
    { id: 'e1', name: 'zulu.pdf', folderPath: ['A'], url: 'https://bb.example.edu/1', size: 300 },
    { id: 'e2', name: 'alpha.pdf', folderPath: ['A'], url: 'https://bb.example.edu/2', size: 100 },
    { id: 'e3', name: 'mike.pptx', folderPath: ['B'], url: 'https://bb.example.edu/3' }
  ];
  const pending = openSelectDialog(entries, { settings: {}, pickDirectory: () => null });
  const dlg = document.querySelector('.bbdl-dialog');
  assert.ok(dlg, '对话框没挂上');

  const visibleNames = () =>
    Array.from(dlg.querySelectorAll('.bbdl-row--file'))
      .filter((row) => !row.hasAttribute('hidden'))
      .map((row) => row.querySelector('.bbdl-row__name').textContent);

  assert.deepEqual(visibleNames(), ['zulu.pdf', 'alpha.pdf', 'mike.pptx']);

  const search = dlg.querySelector('.bbdl-search');
  search.value = 'mike';
  search.dispatchEvent(new dom.window.Event('input'));
  assert.deepEqual(visibleNames(), ['mike.pptx']);

  search.value = '';
  search.dispatchEvent(new dom.window.Event('input'));
  assert.equal(visibleNames().length, 3);

  const pptBox = dlg.querySelector('.bbdl-types input[data-type="ppt"]');
  pptBox.click();
  assert.deepEqual(visibleNames(), ['zulu.pdf', 'alpha.pdf']);
  pptBox.click();
  assert.equal(visibleNames().length, 3);

  const sort = dlg.querySelector('.bbdl-sort');
  sort.value = 'size';
  sort.dispatchEvent(new dom.window.Event('change'));
  assert.deepEqual(visibleNames(), ['zulu.pdf', 'alpha.pdf', 'mike.pptx']);
  assert.match(dlg.querySelector('.bbdl-hint').textContent, /体积未探测/);

  sort.value = 'name';
  sort.dispatchEvent(new dom.window.Event('change'));
  assert.deepEqual(visibleNames(), ['alpha.pdf', 'zulu.pdf', 'mike.pptx']);

  // 落盘方式必须写明是哪一种，并附代价说明：没选目录、也没把 fallbackSink 设成 files，缺省就是 zip。
  const mode = dlg.querySelector('.bbdl-mode').textContent;
  assert.match(mode, /打包成 \.zip/);
  assert.match(mode, /代价/);
  assert.doesNotMatch(mode, /逐文件下载|content_id|token|secret|https?:\/\//);

  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(await pending, null);
  dom.window.close();
});

test('对话框落盘方式跟真实 sink 走：缺省 zip / fallbackSink=files 逐文件 / 选到目录 fs', async () => {
  const entries = [{ id: 'e1', name: 'a.pdf', folderPath: ['Week 1'], url: 'https://bb.example.edu/1' }];
  const modeText = () => document.querySelector('.bbdl-mode').textContent;

  // ① 没有目录句柄、settings 里没有 fallbackSink → zip（落盘层缺省按文件夹打包）
  const domZip = setupDom();
  const zipPending = openSelectDialog(entries, { settings: {}, pickDirectory: () => null });
  assert.match(modeText(), /打包成 \.zip/);
  assert.doesNotMatch(modeText(), /逐文件下载|content_id|token|secret|https?:\/\//);
  document.querySelector('.bbdl-dialog button[data-act="cancel"]').click();
  assert.equal(await zipPending, null);
  domZip.window.close();

  // ② 显式选了逐文件逃生口 → download
  const domDl = setupDom();
  const dlPending = openSelectDialog(entries, { settings: { fallbackSink: 'files' }, pickDirectory: () => null });
  assert.match(modeText(), /逐文件下载/);
  assert.doesNotMatch(modeText(), /打包成 \.zip/);
  document.querySelector('.bbdl-dialog button[data-act="cancel"]').click();
  assert.equal(await dlPending, null);
  domDl.window.close();

  // ③ 用户在对话框里选到了目录 → 同一会话内立刻变 fs，不靠重开对话框
  const domFs = setupDom();
  const fsPending = openSelectDialog(entries, {
    settings: {},
    pickDirectory: () => null,
    onPickDirectory: async () => ({ dirHandle: { name: 'd1' }, name: 'd1' })
  });
  assert.match(modeText(), /打包成 \.zip/, '还没选目录时仍是 zip');
  document.querySelector('.bbdl-dialog button[data-act="pick-dir"]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(modeText(), /保存到文件夹/, '选到目录后文案必须当场变成 fs');
  assert.doesNotMatch(modeText(), /打包成 \.zip|逐文件下载/);
  document.querySelector('.bbdl-dialog button[data-act="cancel"]').click();
  assert.equal(await fsPending, null);
  domFs.window.close();
});

