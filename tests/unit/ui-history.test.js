import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { mountPanel, historyLineText, MAX_HISTORY_ROWS, MAX_HISTORY_PATHS } from '../../src/ui/panel.js';

const PAGE = 'https://bb.example.edu/webapps/blackboard/content/listContent.jsp?course_id=_1_1&content_id=_2_1';

/** 把 jsdom 挂成全局：panel.js 全程只用 document。 */
function setupDom() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: PAGE, pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  return dom;
}

function mount(over) {
  const extra = over || {};
  return mountPanel({
    settings: {},
    onScan: function () {},
    onDownload: function () {},
    onExportManifest: extra.onExportManifest,
    onImportManifest: extra.onImportManifest
  });
}

/** 一条历史：五分类齐全，paths 里的每条都带 query（漏进 DOM 就会被下面的断言抓到）。 */
function makeScan(index, pathCount) {
  const paths = [];
  for (let i = 0; i < (pathCount == null ? 2 : pathCount); i += 1) {
    paths.push({
      id: 'e' + index + '_' + i,
      path: '第 1 周/文件 ' + index + '-' + i + '.pdf?content_id=_1_' + i + '&token=SECRET' + i
    });
  }
  return {
    at: new Date(2024, 7, 21, 14, 32).getTime() + index * 60000,
    total: 30,
    added: 18,
    changed: 1,
    moved: 1,
    unchanged: 1,
    unknown: 1,
    stale: 2,
    changedPaths: paths
  };
}

function historyEl() {
  return document.querySelector('.bbdl-history');
}

function rows() {
  return Array.from(document.querySelectorAll('.bbdl-history__row'));
}

function items() {
  return Array.from(document.querySelectorAll('.bbdl-history__item'));
}

test('扫描历史：没有历史时整块不渲染，传空数组也收起', () => {
  setupDom();
  const api = mount();
  const block = historyEl();
  assert.ok(block, '面板里应该有「扫描历史」这个折叠块');
  assert.equal(block.hidden, true, '没有历史时折叠块必须 hidden');
  assert.equal(items().length, 0);

  api.setHistory([makeScan(1)]);
  assert.equal(block.hidden, false, '有历史时折叠块要显示');
  assert.equal(items().length, 1);

  api.setHistory([]);
  assert.equal(block.hidden, true, '历史被清空后折叠块要重新收起');
  assert.equal(items().length, 0);
  assert.equal(document.querySelector('.bbdl-history__summary').textContent, '扫描历史');
});

test('扫描历史：最多 ' + MAX_HISTORY_ROWS + ' 条，每条一行五分类计数', () => {
  setupDom();
  const api = mount();
  const scans = [];
  for (let i = 0; i < 7; i += 1) scans.push(makeScan(i));

  api.setHistory(scans);

  assert.equal(items().length, MAX_HISTORY_ROWS, '7 条历史只列前 ' + MAX_HISTORY_ROWS + ' 条');
  const first = rows()[0];
  assert.equal(first.textContent, historyLineText(scans[0]));
  assert.match(first.textContent, /^08-21 14:32 · 新增 18 · 变更 1 · 改名 1 · 未变 1 · 未知 1 · 疑似删除 2$/);
  // 每条历史都是一行摘要：计数缺键时按 0，绝不出现 undefined / NaN。
  const bare = rows()[MAX_HISTORY_ROWS - 1];
  assert.match(bare.textContent, /新增 18/);
  assert.doesNotMatch(document.querySelector('.bbdl-history').textContent, /undefined|NaN/);
});

test('扫描历史：展开能看到该次变更路径，最多 ' + MAX_HISTORY_PATHS + ' 行', () => {
  setupDom();
  const api = mount();
  api.setHistory([makeScan(1, 25)]);

  const item = items()[0];
  assert.ok(item.querySelector('.bbdl-history__row'), '每条历史用 summary 当折叠头');
  const paths = Array.from(item.querySelectorAll('.bbdl-history__path'));
  assert.equal(paths.length, MAX_HISTORY_PATHS, '25 条路径只列 ' + MAX_HISTORY_PATHS + ' 行');
  assert.equal(paths[0].textContent, '第 1 周/文件 1-0.pdf', '路径里的 query 必须被削掉');
  assert.ok(item.querySelector('.bbdl-history__paths'), '展开区必须在同一条历史里');
});

test('扫描历史：路径里的 query / URL 一个字都不进 DOM', () => {
  setupDom();
  const api = mount();
  const scan = makeScan(1, 25);
  scan.changedPaths.push({ id: 'e9', path: 'https://bb.example.edu/bbcswebdav/xid-9?content_id=_1_9&token=SECRET9' });
  api.setHistory([scan]);

  const html = document.querySelector('.bbdl-panel').innerHTML;
  for (const token of ['?', '#', 'https://', 'http://', 'token=', 'content_id=', 'SECRET']) {
    assert.equal(html.includes(token), false, 'DOM 里不该出现 ' + token);
  }
});

test('historyLineText：时间可见、缺键按 0、时间无效时不硬造时间', () => {
  const full = historyLineText({ at: new Date(2024, 7, 21, 14, 32).getTime(), added: 18, changed: 1, moved: 1, unchanged: 1, unknown: 1, stale: 2 });
  assert.equal(full, '08-21 14:32 · 新增 18 · 变更 1 · 改名 1 · 未变 1 · 未知 1 · 疑似删除 2');
  assert.equal(historyLineText({}), '新增 0 · 变更 0 · 改名 0 · 未变 0 · 未知 0 · 疑似删除 0');
  assert.equal(historyLineText({ at: -1, added: 3 }), '新增 3 · 变更 0 · 改名 0 · 未变 0 · 未知 0 · 疑似删除 0');
});
