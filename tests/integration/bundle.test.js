// 集成取证：把 dist 里的真实产物丢进 jsdom，跑「挂载面板 → 递归扫描 → 打开选择对话框」。
// 只验证模块接线，不验证真实 Blackboard 页面结构（那需要一份脱敏 HTML 快照）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const DIST = new URL('../../dist/bb-bulk-course-downloader.user.js', import.meta.url);
const BASE = 'https://bb.example.edu';
const ROOT_PAGE = BASE + '/webapps/blackboard/content/listContent.jsp?course_id=_1_1&content_id=_2_1';
const FOLDER_PAGE = BASE + '/webapps/blackboard/content/listContent.jsp?course_id=_1_1&content_id=_9_1';

const ROOT_HTML =
  '<!doctype html><html><body>' +
  '<a href="/bbcswebdav/pid-1-dt-content-rid-11_1/xid-11_1">HW1 Solution.pdf</a>' +
  '<a href="/bbcswebdav/pid-2-dt-content-rid-22_1/xid-22_1">week2.pdf</a>' +
  '<a href="' + FOLDER_PAGE + '">Week 3</a>' +
  '</body></html>';

const FOLDER_HTML =
  '<!doctype html><html><body><a href="/bbcswebdav/pid-3-dt-content-rid-33_1/xid-33_1">slides.pdf</a></body></html>';

const skip = existsSync(DIST) ? false : 'dist 未构建，先跑 npm run build';

function fakeResponse(url, body) {
  return {
    ok: true,
    status: 200,
    url: String(url),
    redirected: false,
    headers: { get: () => null },
    text: async () => body,
    blob: async () => new Blob([body], { type: 'text/html' }),
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    body: null
  };
}

async function boot() {
  const dom = new JSDOM(ROOT_HTML, { url: ROOT_PAGE, runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  // jsdom 的 window 不提供 TextEncoder，浏览器有。
  window.TextEncoder = TextEncoder;
  window.TextDecoder = TextDecoder;

  const requested = [];
  window.fetch = async (url) => {
    requested.push(String(url));
    return fakeResponse(url, String(url).includes('content_id=_9_1') ? FOLDER_HTML : ROOT_HTML);
  };

  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));

  window.eval(readFileSync(DIST, 'utf8'));
  await new Promise((resolve) => {
    if (window.document.readyState === 'complete') resolve();
    else window.addEventListener('load', () => resolve(), { once: true });
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  const doc = window.document;
  const button = (label) => [...doc.querySelectorAll('.bbdl-panel button')].find((b) => (b.textContent || '').includes(label));
  return { window, doc, button, requested, errors };
}

test('产物能在 listContent.jsp 上挂载面板', { skip }, async () => {
  const { doc, button, errors } = await boot();
  assert.ok(doc.querySelector('.bbdl-panel'), '面板未挂载');
  assert.ok(button('扫描'), '缺少扫描按钮');
  assert.deepEqual(errors, []);
});

test('扫描会递归进子文件夹，并把路径带进选择对话框', { skip }, async () => {
  const { doc, button, requested, errors } = await boot();

  button('扫描').click();
  await new Promise((resolve) => setTimeout(resolve, 1200));

  assert.equal(requested.length, 2, '应请求根页 + 1 个子文件夹');
  assert.ok(requested.some((u) => u.includes('content_id=_9_1')), '未递归进子文件夹');

  const download = button('选择并下载');
  assert.ok(download && !download.disabled, '扫描完成后下载按钮应可用');

  download.click();
  await new Promise((resolve) => setTimeout(resolve, 200));

  const overlay = doc.querySelector('.bbdl-overlay');
  assert.ok(overlay, '选择对话框未打开');
  const text = overlay.textContent.replace(/\s+/g, ' ');
  assert.ok(text.includes('Week 3 / slides.pdf'), '子文件夹内的文件路径不对：' + text);
  assert.ok(text.includes('HW1 Solution.pdf'));
  assert.deepEqual(errors, []);
});
