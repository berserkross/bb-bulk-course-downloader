import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { mountPanel, QUIET_NOTICE_TEXT, QUIET_REASON_TEXT } from '../../src/ui/panel.js';

const PAGE = 'https://bb.example.edu/webapps/blackboard/content/listContent.jsp?course_id=_1_1&content_id=_2_1';

/** 红线（docs/m7-quiet.md §1）：这些字样只许出现在 console，一个字都不许进面板 DOM。 */
const QUIET_RED_LINE = /登录|过期|会话失效|重新登录|认证/;

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: PAGE, pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  return dom;
}

function makeEntries(n) {
  const list = [];
  for (let i = 1; i <= n; i += 1) {
    list.push({
      id: 'e' + i,
      name: '文件 ' + i + '.pdf',
      size: 1024 * i,
      folderPath: ['第 1 周'],
      url: 'https://bb.example.edu/bbcswebdav/xid-' + i + '?token=SECRET' + i
    });
  }
  return list;
}

function okList(n) {
  const list = [];
  for (let i = 1; i <= n; i += 1) list.push({ id: 'ok' + i, entry: { id: 'ok' + i, name: '成功 ' + i + '.pdf' }, bytes: 100 * i });
  return list;
}

function failList(n) {
  const list = [];
  for (let i = 1; i <= n; i += 1) list.push({ entry: { id: 'bad' + i, name: '失败 ' + i + '.pdf' }, error: 'unknown' });
  return list;
}

function mount(over) {
  const extra = over || {};
  const patches = [];
  const api = mountPanel({
    settings: extra.settings || {},
    onScan: function () {},
    onDownload: function () {},
    onResumePending: extra.onResumePending,
    onSettingsChange: function (patch) {
      patches.push(patch);
    }
  });
  return { api: api, patches: patches };
}

function panelRoot() {
  const el = document.querySelector('.bbdl-panel');
  assert.ok(el, '必须挂载出面板');
  return el;
}

function haltEl() {
  return document.querySelector('.bbdl-halt');
}

function statusLine() {
  return document.querySelector('.bbdl-status').textContent;
}

function fabStatus() {
  return document.querySelector('.bbdl-fab__status').textContent;
}

function summaryHead() {
  return document.querySelector('.bbdl-summary__head').textContent;
}

/** 按可见文案找设置行里的 checkbox：文案是唯一稳定的锚点。 */
function settingsInput(text) {
  const row = Array.from(document.querySelectorAll('.bbdl-settings__row')).find(function (el) {
    return el.textContent.indexOf(text) !== -1;
  });
  assert.ok(row, '设置面板里找不到「' + text + '」这一行');
  const input = row.querySelector('input[type="checkbox"]');
  assert.ok(input, '「' + text + '」这一行必须是 checkbox');
  return input;
}

test('AC1：停机 + 摘要同屏后面板可见文本整体不含 登录 / 过期 / 会话失效 / 重新登录 / 认证', () => {
  setupDom();
  const h = mount();
  h.api.setFiles(makeEntries(3));
  h.api.setState('done');
  h.api.setHalted({ reason: 'session-expired', pendingCount: 2 });
  h.api.showSummary({ ok: okList(1), failed: failList(1), aborted: false });

  const text = panelRoot().textContent;
  assert.doesNotMatch(text, QUIET_RED_LINE, '诊断只许进 console，面板实际文本：' + text);
  h.api.destroy();
});

test('AC2：横幅文案逐字「已暂停（N 个未下载）。」，按钮「继续」且 data-act 仍是 resume-pending', () => {
  setupDom();
  const h = mount({ onResumePending: function () {} });
  h.api.setFiles(makeEntries(3));
  h.api.setState('done');
  h.api.setHalted({ reason: 'session-expired', pendingCount: 2 });

  assert.equal(haltEl().hidden, false, '停机时横幅必须出现');
  assert.equal(haltEl().querySelector('.bbdl-halt__text').textContent, '已暂停（2 个未下载）。');
  const btn = haltEl().querySelector('[data-act="resume-pending"]');
  assert.ok(btn, '既有 wiring 测试靠 data-act 找按钮');
  assert.equal(btn.textContent, '继续', '按钮文案由「刷新后继续」改为「继续」');

  h.api.showSummary({ ok: okList(1), failed: [], aborted: false });
  assert.equal(statusLine(), '已暂停，未下载 2 个文件。');
  h.api.destroy();
});

test('AC3：setRecovering({ attempt: 1 }) → 状态行「正在自动恢复（第 1 次）…」、收起条「恢复中」、横幅收起', () => {
  setupDom();
  const h = mount({ onResumePending: function () {} });
  h.api.setFiles(makeEntries(3));
  h.api.setState('done');
  h.api.setHalted({ reason: 'session-expired', pendingCount: 2 });

  h.api.setRecovering({ attempt: 1 });
  assert.equal(statusLine(), '正在自动恢复（第 1 次）…');
  assert.equal(fabStatus(), '恢复中');
  assert.equal(haltEl().hidden, true, '恢复中不许播报停机');

  h.api.setRecovering({ attempt: 2 });
  assert.equal(statusLine(), '正在自动恢复（第 2 次）…', '尝试次数要跟着涨');
  h.api.destroy();
});

test('AC3：clearRecovering 后回到已暂停态（状态行、横幅、收起条三处都回来）', () => {
  setupDom();
  const h = mount({ onResumePending: function () {} });
  h.api.setFiles(makeEntries(3));
  h.api.setState('done');
  h.api.setHalted({ reason: 'session-expired', pendingCount: 2 });
  h.api.setRecovering({ attempt: 1 });
  h.api.clearRecovering();

  assert.equal(statusLine(), '已暂停，未下载 2 个文件。');
  assert.equal(fabStatus(), '已暂停');
  assert.equal(haltEl().hidden, false);
  assert.equal(haltEl().querySelector('.bbdl-halt__text').textContent, '已暂停（2 个未下载）。');
  h.api.destroy();
});

test('恢复态优先于停机态（先恢复后停机也一样），新一轮开始才作废', () => {
  setupDom();
  const h = mount({ onResumePending: function () {} });
  h.api.setRecovering({ attempt: 2 });
  h.api.setHalted({ reason: 'session-expired', pendingCount: 4 });

  assert.equal(statusLine(), '正在自动恢复（第 2 次）…', '恢复中收到停机不许盖掉恢复态');
  assert.equal(fabStatus(), '恢复中');
  assert.equal(haltEl().hidden, true, '恢复中收到停机也不许弹横幅');

  h.api.setState('downloading');
  assert.equal(statusLine(), '正在下载…（可随时取消）', '新一轮开始后恢复态必须作废');
  // 条状态字仍是「已暂停」：停机排在下载之前是既有优先级，这里只认恢复态确实没了。
  assert.notEqual(fabStatus(), '恢复中');
  h.api.destroy();
});

test('AC4：摘要头仍是「已暂停：成功 X 个，未下载 N 个」，有真失败才追加「失败 Y 个」', () => {
  setupDom();
  const h = mount();
  h.api.setFiles(makeEntries(8));
  h.api.setHalted({ reason: 'session-expired', pendingCount: 16 });
  h.api.showSummary({ ok: okList(5), failed: [], aborted: false });
  assert.equal(summaryHead(), '已暂停：成功 5 个，未下载 16 个');

  h.api.showSummary({ ok: okList(5), failed: failList(2), aborted: false });
  assert.equal(summaryHead(), '已暂停：成功 5 个，未下载 16 个，失败 2 个');
  h.api.destroy();
});

test('AC5：两个新 checkbox 的初始值分别等于 !panelCollapsed 与 autoReload', () => {
  setupDom();
  mount({ settings: { panelCollapsed: true, autoReload: false } });
  assert.equal(settingsInput('打开页面时展开面板').checked, false);
  assert.equal(settingsInput('会话异常时自动重载续跑').checked, false);

  setupDom();
  mount({ settings: { panelCollapsed: false, autoReload: true } });
  assert.equal(settingsInput('打开页面时展开面板').checked, true);
  assert.equal(settingsInput('会话异常时自动重载续跑').checked, true);

  setupDom();
  mount({ settings: {} });
  assert.equal(settingsInput('打开页面时展开面板').checked, false, '未给设置时按 panelCollapsed 默认折叠算');
  assert.equal(settingsInput('会话异常时自动重载续跑').checked, true, '未给设置时按 autoReload 默认开算');
});

test('AC5：点两个新 checkbox 只走 emitSettings，patch 是 { panelCollapsed: false } 与 { autoReload: false }', () => {
  setupDom();
  const h = mount({ settings: { panelCollapsed: true, autoReload: true } });
  const root = panelRoot();

  settingsInput('打开页面时展开面板').click();
  assert.deepEqual(h.patches, [{ panelCollapsed: false }], '只写设置，不许顺手展开当前面板');
  assert.equal(root.classList.contains('bbdl-panel--collapsed'), true, '当前折叠态由 setCollapsed 管，不归这行 checkbox');

  settingsInput('会话异常时自动重载续跑').click();
  assert.deepEqual(h.patches, [{ panelCollapsed: false }, { autoReload: false }]);
  h.api.destroy();
});

test('AC6：挂载只读设置，一个 patch 都不发（persist: false 语义保持）', () => {
  setupDom();
  const h = mount({ settings: { panelCollapsed: false, autoReload: false } });
  assert.deepEqual(h.patches, [], '挂载时读设置绝不反写');
  h.api.destroy();
});

test('红线延伸到上层文案：命中敏感词的 notice 换成中性句，面板照样有话说', () => {
  setupDom();
  const h = mount();
  h.api.setNotice('疑似登录过期，3 秒后自动重试（第 1 次）…');
  const notice = document.querySelector('.bbdl-notice');
  assert.equal(notice.hidden, false, '过滤不是没内容：面板不许留白');
  assert.equal(notice.textContent, QUIET_NOTICE_TEXT);
  assert.equal(panelRoot().textContent.indexOf('登录'), -1, '面板 DOM 里查不到「登录」');

  h.api.setNotice('   ');
  assert.equal(notice.hidden, true, '本来就空 —— 不是被过滤，照旧不进 DOM');

  h.api.fail('会话已失效：请重新登录 Blackboard，然后刷新本页再试。');
  assert.equal(statusLine(), '出错了：' + QUIET_NOTICE_TEXT);
  assert.doesNotMatch(panelRoot().textContent, QUIET_RED_LINE);
  h.api.destroy();
});

test('摘要里失败行的 reason 走短句映射：登录已过期 → QUIET_REASON_TEXT', () => {
  setupDom();
  const h = mount();
  h.api.showSummary({
    ok: [],
    failed: [{ entry: { id: 'bad1', name: '失败 1.pdf' }, error: '登录已过期' }],
    aborted: false
  });
  const reasons = Array.from(document.querySelectorAll('.bbdl-failed__reason')).map(function (el) {
    return el.textContent;
  });
  assert.deepEqual(reasons, [QUIET_REASON_TEXT]);
  assert.doesNotMatch(panelRoot().textContent, QUIET_RED_LINE);
  h.api.destroy();
});

test('既有面板没有控制器可复用时：noop 表里也有 setRecovering / clearRecovering', () => {
  setupDom();
  document.body.innerHTML = '<div class="bbdl-panel"><p class="bbdl-status"></p></div>';
  const api = mountPanel({ settings: {}, onScan: function () {}, onDownload: function () {} });
  assert.equal(typeof api.setRecovering, 'function');
  assert.equal(typeof api.clearRecovering, 'function');
  api.setRecovering({ attempt: 1 });
  api.clearRecovering();
  assert.equal(document.querySelectorAll('.bbdl-panel').length, 1, '复用时绝不再建第二个面板');
});

test('批次续跑保留已交付计数，等待和下一轮启动不重置进度', () => {
  setupDom();
  const {api} = mount();
  api.setFiles([{id:'a'}, {id:'b'}, {id:'c'}]);
  api.setState('downloading');
  api.setDownloadProgress({state:'file-done', entryId:'a'});
  api.continueBatch();
  api.setState('downloading');
  api.setDownloadProgress({state:'start', filesDone:0, filesTotal:2});
  const line = document.querySelector('.bbdl-progress__text');
  assert.match(line.textContent, /1 \/ 3/);
  api.setDownloadProgress({state:'file-done', entryId:'b'});
  assert.match(line.textContent, /2 \/ 3/);
  api.setHalted({reason:'session-expired', pendingCount:1});
  api.showSummary({ok:[{},{}],failed:[]});
  assert.match(statusLine(), /已暂停/);
  api.destroy();
});
