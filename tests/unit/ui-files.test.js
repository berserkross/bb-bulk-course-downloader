import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { mountPanel, MAX_FILE_ROWS } from '../../src/ui/panel.js';

const PAGE = 'https://bb.example.edu/webapps/blackboard/content/listContent.jsp?course_id=_1_1&content_id=_2_1';

/** 把 jsdom 挂成全局：panel.js 全程只用 document。 */
function setupDom() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: PAGE, pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  return dom;
}

/** 每条 entry 的 url 都带 query：只要它漏进 DOM，下面的断言就会抓到。 */
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

function mount(over) {
  const extra = over || {};
  return mountPanel({
    settings: {},
    onScan: function () {},
    onDownload: function () {},
    onResumePending: extra.onResumePending
  });
}

function rows() {
  return Array.from(document.querySelectorAll('.bbdl-files__row'));
}

function rowOf(id) {
  return document.querySelector('.bbdl-files__row[data-entry-id="' + id + '"]');
}

function cellOf(id, cls) {
  const row = rowOf(id);
  assert.ok(row, '找不到 entryId=' + id + ' 的行');
  const cell = row.querySelector('.' + cls);
  assert.ok(cell, '行里缺少 .' + cls);
  return cell.textContent;
}

test('文件列表：默认折叠，300 条时展开后行数 ≤500，且 query 一个字都不进 DOM', () => {
  setupDom();
  const api = mount();
  api.setFiles(makeEntries(300));

  const list = document.querySelector('.bbdl-files');
  assert.ok(list, '必须出现「文件列表」容器');
  assert.equal(list.tagName.toLowerCase(), 'details', '折叠靠 <details> 原生折叠');
  assert.equal(list.open, false, '默认必须折叠');
  assert.equal(list.querySelector('.bbdl-files__summary').textContent, '文件列表（300）');

  list.open = true;
  const all = rows();
  assert.ok(all.length <= MAX_FILE_ROWS, '展开后行数不得超过 ' + MAX_FILE_ROWS + '，实际 ' + all.length);
  assert.equal(all.length, 300);

  // 每行：名称 + 状态 + 字节 + 重试次数，路径单独一行灰字。
  const first = all[0];
  assert.equal(first.querySelector('.bbdl-files__name').textContent, '文件 1.pdf');
  assert.equal(first.querySelector('.bbdl-files__status').textContent, '等待');
  assert.equal(first.querySelector('.bbdl-files__bytes').textContent, '1.0 KB');
  assert.equal(first.querySelector('.bbdl-files__retry').textContent, '—');
  assert.equal(first.querySelector('.bbdl-files__path').textContent, '第 1 周');
  assert.equal(all[299].querySelector('.bbdl-files__name').textContent, '文件 300.pdf', '行序与 setFiles 一致');

  const html = document.querySelector('.bbdl-panel').innerHTML;
  for (const bad of ['SECRET', 'content_id=', 'token=', '?', '#', 'https://']) {
    assert.equal(html.indexOf(bad), -1, 'DOM 里不许出现「' + bad + '」');
  }
  api.destroy();
});

test('文件列表：600 条时只画 500 行，剩下用一行「其余 100 个文件未展开」收口', () => {
  setupDom();
  const api = mount();
  api.setFiles(makeEntries(600));

  assert.equal(rows().length, MAX_FILE_ROWS, 'DOM 行数上限 ' + MAX_FILE_ROWS);
  const more = document.querySelector('.bbdl-files__more');
  assert.equal(more.hidden, false);
  assert.equal(more.textContent, '其余 100 个文件未展开');
  // 超出上限的条目一个节点都不许建。
  assert.equal(rowOf('e501'), null, '第 501 条不许有行');
  assert.ok(rowOf('e500'), '第 500 条必须有行');
  api.destroy();
});

test('按 entryId 计重试：同一行连发 attempt 2/3 显示 3，另一行的 attempt 2 不受影响', () => {
  setupDom();
  const api = mount();
  api.setFiles([
    { id: 'e1', name: '甲.pdf', size: 10, folderPath: ['第 1 周'], url: 'https://bb.example.edu/f/1?token=SECRET' },
    { id: 'e2', name: '乙.pdf', size: 20, folderPath: ['第 1 周'], url: 'https://bb.example.edu/f/2?token=SECRET' }
  ]);

  api.applyFileEvent({ type: 'start', entryId: 'e1', attempt: 1 });
  api.applyFileEvent({ type: 'retry', entryId: 'e1', attempt: 2, reason: '连接超时' });
  api.applyFileEvent({ type: 'retry', entryId: 'e2', attempt: 2, reason: '连接超时' });
  api.applyFileEvent({ type: 'retry', entryId: 'e1', attempt: 3, reason: '连接超时' });

  assert.equal(cellOf('e1', 'bbdl-files__retry'), '3 次', '同一 entryId 的计数必须走到 3');
  assert.equal(cellOf('e2', 'bbdl-files__retry'), '2 次', '另一个 entryId 的计数不许被串台');
  assert.equal(cellOf('e1', 'bbdl-files__status'), '下载中');
  assert.equal(rowOf('e1').querySelector('.bbdl-files__retry').title, '第 3 次尝试');
  api.destroy();
});

test('done 事件写回状态与字节；halt 事件出横幅且 pending 数字正确', () => {
  setupDom();
  const api = mount();
  api.setFiles([
    { id: 'e1', name: '甲.pdf', size: 10, folderPath: ['第 1 周'], url: 'https://bb.example.edu/f/1' },
    { id: 'e2', name: '乙.pdf', size: 20, folderPath: ['第 2 周'], url: 'https://bb.example.edu/f/2' },
    { id: 'e3', name: '丙.pdf', size: 30, folderPath: [], url: 'https://bb.example.edu/f/3' }
  ]);

  api.applyFileEvent({ type: 'start', entryId: 'e1', attempt: 1 });
  api.applyFileEvent({ type: 'done', entryId: 'e1', bytes: 2048 });
  assert.equal(cellOf('e1', 'bbdl-files__status'), '完成');
  assert.equal(cellOf('e1', 'bbdl-files__bytes'), '2.0 KB', '字节必须取自 done 事件的 bytes');

  api.applyFileEvent({ type: 'start', entryId: 'e2', attempt: 1 });
  assert.equal(cellOf('e2', 'bbdl-files__status'), '下载中');

  api.applyFileEvent({ type: 'halt', entryId: 'e3', reason: 'session-expired', pending: 2 });
  const halt = document.querySelector('.bbdl-halt');
  assert.equal(halt.hidden, false, 'halt 事件后必须出现停机横幅');
  // v2.8.0 文案（docs/m7-quiet.md §1）：横幅只描述状态，原因只进 console。
  assert.equal(halt.querySelector('.bbdl-halt__text').textContent, '已暂停（2 个未下载）。');
  assert.equal(cellOf('e2', 'bbdl-files__status'), '等待', '停机后在飞的文件不许一直停在「下载中」');
  api.destroy();
});

test('setHalted → 点横幅按钮只调 1 次 onResumePending；clearHalted 后横幅消失', () => {
  setupDom();
  const calls = [];
  const api = mount({
    onResumePending: function () {
      calls.push('resume');
    }
  });
  api.setFiles([{ id: 'e1', name: '甲.pdf', size: 10, folderPath: ['第 1 周'], url: 'https://bb.example.edu/f/1' }]);

  api.setHalted({ reason: 'session-expired', pendingCount: 3 });
  const halt = document.querySelector('.bbdl-halt');
  assert.equal(halt.hidden, false);
  assert.match(halt.textContent, /已暂停（3 个未下载）。/);

  const btn = halt.querySelector('[data-act="resume-pending"]');
  assert.ok(btn, '给了 onResumePending 就必须渲染按钮');
  btn.click();
  assert.equal(calls.length, 1, '一次点击只能调一次 onResumePending');
  btn.click();
  assert.equal(calls.length, 2, '第二次点击 = 第二次调用（不是一次点击调两次）');

  api.clearHalted();
  assert.equal(document.querySelector('.bbdl-halt').hidden, true, 'clearHalted 后横幅必须消失');
  assert.equal(document.querySelector('.bbdl-halt [data-act="resume-pending"]'), null);
  api.destroy();
});

test('没给 onResumePending：横幅只有文案，一个按钮都不渲染', () => {
  setupDom();
  const api = mount();
  api.setFiles([{ id: 'e1', name: '甲.pdf', size: 10, folderPath: [], url: 'https://bb.example.edu/f/1' }]);
  api.setHalted({ reason: 'session-expired', pendingCount: 1 });

  const halt = document.querySelector('.bbdl-halt');
  assert.equal(halt.hidden, false);
  assert.equal(halt.querySelector('button'), null, '缺省不渲染按钮');
  assert.match(halt.textContent, /（1 个未下载）/);
  // 没有 pendingCount 时退回数未下载行，绝不出 NaN。
  api.setHalted({ reason: 'session-expired' });
  assert.match(halt.textContent, /（1 个未下载）/);
  api.destroy();
});

test('既有单行摘要不受影响：setFiles/applyFileEvent 不碰 .bbdl-progress__text', () => {
  setupDom();
  const api = mount();
  api.setDownloadProgress({ filesDone: 0, filesTotal: 2, bytesDone: 10, bytesTotal: 100 });
  const before = document.querySelector('.bbdl-progress__text').textContent;
  api.setFiles(makeEntries(2));
  api.applyFileEvent({ type: 'start', entryId: 'e1', attempt: 1 });
  assert.equal(document.querySelector('.bbdl-progress__text').textContent, before);
  api.destroy();
});

/* ---------------- 停机收尾的文案口径 ----------------
 * pending 既不是成功也不是失败：停机时状态行与摘要头都必须让位给「已暂停」，
 * 否则同一屏上「登录已过期，已暂停」和「已完成」互相打脸。
 */

function statusLine() {
  return document.querySelector('.bbdl-status').textContent;
}

function summaryHead() {
  return document.querySelector('.bbdl-summary__head').textContent;
}

/** 只数长度：摘要头的「成功 X 个」取自 ok.length，不读条目内容。 */
function okList(n) {
  return Array.from({ length: n }, (_, i) => ({ entry: { id: 'ok' + i } }));
}

function failList(n) {
  return Array.from({ length: n }, (_, i) => ({
    entry: {
      id: 'f' + (i + 1),
      name: '坏 ' + (i + 1) + '.pdf',
      folderPath: ['第 1 周'],
      url: 'https://bb.example.edu/f/' + (i + 1) + '?content_id=_1_1&token=SECRET' + (i + 1)
    },
    error: 'HTTP 500'
  }));
}

test('停机收尾：状态行与摘要头都让位给「已暂停」，同屏不再出现「已完成」', () => {
  setupDom();
  const api = mount();
  api.setFiles(makeEntries(21));
  api.setHalted({ reason: 'session-expired', pendingCount: 16 });
  api.showSummary({ ok: okList(5), failed: [], aborted: false });

  const status = statusLine();
  assert.match(status, /已暂停/);
  assert.doesNotMatch(status, /已完成/, '停机后状态行不许再说「已完成」');
  assert.match(status, /未下载 16 个/, 'N 必须取自 setHalted 给的 pendingCount');

  assert.equal(summaryHead(), '已暂停：成功 5 个，未下载 16 个');
  assert.doesNotMatch(summaryHead(), /失败/, 'pending 不是失败：真失败为 0 时摘要头一个「失败」都不能有');
  assert.match(document.querySelector('.bbdl-halt').textContent, /（16 个未下载）/, '横幅数字与摘要头必须是同一个数');
  api.destroy();
});

test('没停机时同一路径一个字都不变：状态行仍是原句，摘要头仍带「失败 0 个」', () => {
  setupDom();
  const api = mount();
  api.setFiles(makeEntries(5));
  api.showSummary({ ok: okList(5), failed: [], aborted: false });

  assert.equal(statusLine(), '已完成。可以重新扫描，或再选一批文件下载。');
  assert.equal(summaryHead(), '下载完成：成功 5 个，失败 0 个');
  api.destroy();
});

test('停机 + 真失败：摘要头在「未下载 N 个」之后才追加「失败 Y 个」', () => {
  setupDom();
  const api = mount();
  api.setFiles(makeEntries(8));
  api.setHalted({ reason: 'session-expired', pendingCount: 16 });
  api.showSummary({ ok: okList(5), failed: failList(2), aborted: false });

  assert.equal(summaryHead(), '已暂停：成功 5 个，未下载 16 个，失败 2 个');
  assert.doesNotMatch(statusLine(), /已完成/);
  api.destroy();
});

test('停机数字不泄漏到下一批：clearHalted 与 setFiles（新种子行）都把它清零', () => {
  setupDom();
  const api = mount();
  api.setFiles(makeEntries(3));
  api.setHalted({ reason: 'session-expired', pendingCount: 2 });
  api.clearHalted();
  api.showSummary({ ok: okList(3), failed: [], aborted: false });
  assert.equal(statusLine(), '已完成。可以重新扫描，或再选一批文件下载。');
  assert.equal(summaryHead(), '下载完成：成功 3 个，失败 0 个');
  api.destroy();

  // 不依赖 clearHalted 被调到：新一批种子行自己就该作废旧账本。
  setupDom();
  const next = mount();
  next.setHalted({ reason: 'session-expired', pendingCount: 4 });
  next.setFiles(makeEntries(2));
  next.showSummary({ ok: okList(2), failed: [], aborted: false });
  assert.equal(statusLine(), '已完成。可以重新扫描，或再选一批文件下载。');
  assert.equal(summaryHead(), '下载完成：成功 2 个，失败 0 个');
  next.destroy();
});
