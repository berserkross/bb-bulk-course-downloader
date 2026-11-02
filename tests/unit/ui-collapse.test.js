import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { mountPanel } from '../../src/ui/panel.js';
import { CSS } from '../../src/ui/styles.js';
import { DEFAULTS, loadSettings } from '../../src/store.js';

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
  const patches = [];
  const api = mountPanel({
    settings: extra.settings || {},
    onScan: function () {},
    onDownload: function () {},
    onSettingsChange: function (patch) { patches.push(patch); return Object.assign({}, extra.settings, patch); }
  });
  return { api: api, patches: patches };
}

function root() {
  return document.querySelector('.bbdl-panel');
}

function fab() {
  const el = document.querySelector('.bbdl-fab');
  assert.ok(el, '收起态必须有 .bbdl-fab 条');
  return el;
}

function statusText() {
  const el = document.querySelector('.bbdl-fab__status');
  assert.ok(el, '收起条里必须有 .bbdl-fab__status');
  return el.textContent;
}

function click(el) {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}

/** 从 styles.js 的 CSS 文本里取出某条规则的大括号内容。 */
function rule(selector) {
  const at = CSS.indexOf(selector + ' {');
  assert.ok(at >= 0, 'CSS 里找不到规则 ' + selector);
  const end = CSS.indexOf('}', at);
  return CSS.slice(at + selector.length, end);
}

test('默认收起：settings 为空时挂载就带 bbdl-panel--collapsed，条上有标题与展开提示', () => {
  setupDom();
  mount();
  assert.equal(root().classList.contains('bbdl-panel--collapsed'), true, '默认必须是收起态');
  assert.equal(document.querySelector('.bbdl-fab__title').textContent, 'BB 批量下载');
  assert.equal(document.querySelector('.bbdl-fab__hint').textContent, '点击展开');
  assert.equal(fab().getAttribute('data-act'), 'expand', '条本身就是展开入口');
});

test('默认收起：DEFAULTS 与 loadSettings 都把 panelCollapsed 定为 true', () => {
  assert.equal(DEFAULTS.panelCollapsed, true);
  assert.equal(loadSettings().panelCollapsed, true, '首次安装（无 settings）读出来就是收起');
});

test('收起条尺寸与定位：position:fixed、left/bottom 16px、≤240×44、z-index 低于完整面板', () => {
  const bar = rule('.bbdl-fab');
  assert.match(bar, /position:\s*fixed/);
  assert.match(bar, /left:\s*16px/);
  assert.match(bar, /bottom:\s*16px/);
  const maxWidth = Number((bar.match(/max-width:\s*(\d+)px/) || [])[1]);
  assert.ok(maxWidth > 0 && maxWidth <= 240, '条宽必须 ≤240px，实际 ' + maxWidth);
  const height = Number((bar.match(/height:\s*(\d+)px/) || [])[1]);
  assert.ok(height > 0 && height <= 44, '条高必须 ≤44px，实际 ' + height);

  const barZ = Number((bar.match(/z-index:\s*(\d+)/) || [])[1]);
  const panelZ = Number((rule('.bbdl-panel').match(/z-index:\s*(\d+)/) || [])[1]);
  assert.ok(barZ > 0 && panelZ > barZ, '条 z-index(' + barZ + ') 必须低于完整面板(' + panelZ + ')');
});

test('点收起条 → 展开完整面板，并把 panelCollapsed:false 写回 settings', () => {
  setupDom();
  const h = mount();
  click(fab());
  assert.equal(root().classList.contains('bbdl-panel--collapsed'), false, '点条必须展开');
  assert.equal(fab().getAttribute('aria-expanded'), 'true');
  assert.deepEqual(h.patches, [{ panelCollapsed: false }]);
});

test('展开态点右上角「—」→ 回到收起条，并把 panelCollapsed:true 写回 settings', () => {
  setupDom();
  const h = mount({ settings: { panelCollapsed: false } });
  click(document.querySelector('[data-act="collapse"]'));
  assert.equal(root().classList.contains('bbdl-panel--collapsed'), true, '点「—」必须收起');
  assert.equal(fab().getAttribute('aria-expanded'), 'false');
  assert.deepEqual(h.patches, [{ panelCollapsed: true }]);
});

test('刷新后保持上次状态：settings.panelCollapsed=false 挂载即展开，且挂载时不反写设置', () => {
  setupDom();
  const h = mount({ settings: { panelCollapsed: false } });
  assert.equal(root().classList.contains('bbdl-panel--collapsed'), false);
  assert.deepEqual(h.patches, [], '挂载只应用已存设置，绝不写回');
});

test('收起/展开不重建 DOM：同一个 root 与同一个条节点', () => {
  setupDom();
  mount();
  const rootEl = root();
  const fabEl = fab();
  click(fabEl);
  assert.equal(root(), rootEl, 'root 必须还是同一个节点');
  assert.equal(fab(), fabEl, '条必须还是同一个节点');
  click(document.querySelector('[data-act="collapse"]'));
  assert.equal(fab(), fabEl);
});

test('收起条状态字：扫描中说「扫描中」', () => {
  setupDom();
  const h = mount();
  h.api.setState('scanning');
  assert.equal(statusText(), '扫描中');
});

test('收起条状态字：下载中显示「下载 12/132」', () => {
  setupDom();
  const h = mount();
  h.api.setState('downloading');
  h.api.setDownloadProgress({ filesDone: 12, filesTotal: 132, bytesDone: 12 * 100, bytesTotal: 132 * 100 });
  assert.equal(statusText(), '下载 12/132');
});

test('收起条状态字：停机时显示「已暂停」', () => {
  setupDom();
  const h = mount();
  h.api.setState('downloading');
  h.api.setDownloadProgress({ filesDone: 3, filesTotal: 9 });
  h.api.setHalted({ reason: 'session-expired', pendingCount: 6 });
  assert.equal(statusText(), '已暂停', '停机时必须压过下载进度');
  h.api.clearHalted();
  assert.equal(statusText(), '下载 3/9', '清除停机后回落到下载进度');
});

test('收起条状态字：错误态显示「出错」', () => {
  setupDom();
  const h = mount();
  h.api.fail('没有开始任何文件：提交 2 个文件');
  assert.equal(root().dataset.state, 'error');
  assert.equal(statusText(), '出错');
});

test('收起条状态字：空闲时留空（不占位、不显示假状态）', () => {
  setupDom();
  mount();
  assert.equal(statusText(), '', '空闲态不该编一个状态出来');
});
