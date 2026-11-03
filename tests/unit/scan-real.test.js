import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

import { createScanner } from '../../src/bb/scan.js';

// scan.js 用全局 DOMParser 解析响应
const { window } = new JSDOM('');
window.TextEncoder = TextEncoder;
window.TextDecoder = TextDecoder;
globalThis.DOMParser = window.DOMParser;

const HTML = readFileSync(new URL('../fixtures/real-eng1002.html', import.meta.url), 'utf8');
const ENTRY_URL =
  'https://bb.cuhk.edu.cn/webapps/blackboard/content/listContent.jsp?course_id=_16517_1';

// 子文件夹页给一个空页面：真实课程里每层内容不同，只有根页是这份快照
const EMPTY_FOLDER_HTML = '<!doctype html><html><body><p>empty</p></body></html>';

function recordingFetcher() {
  const requested = [];
  return {
    requested,
    fetcher: {
      async fetchOk(url) {
        requested.push(String(url));
        const html = String(url) === ENTRY_URL ? HTML : EMPTY_FOLDER_HTML;
        return { url: String(url), async text() { return html; } };
      }
    }
  };
}

test('扫描真实入口页：根页只被抓取一次，Content 自链接不再入队', async () => {
  const { requested, fetcher } = recordingFetcher();
  const scanner = createScanner({ fetcher, rootUrl: ENTRY_URL, minDelayMs: 0, maxDelayMs: 0 });
  const files = await scanner.scan();
  // 根页只抓一次
  assert.equal(requested.filter((url) => url === ENTRY_URL).length, 1);
  assert.equal(requested[0], ENTRY_URL);
  // 只多抓 8 个真实子文件夹；指向本页自身的 Content 链接（多 &mode=reset）一次都不抓
  assert.equal(requested.length, 9);
  assert.equal(requested.some((url) => url.includes('content_id=_592925_1')), false);
  assert.equal(files.length, 5);
  assert.deepEqual(files.map((file) => file.folderPath), [[], [], [], [], []]);
  assert.deepEqual(scanner.failures, []);
});

test('多个目录指向同一文件时，目录响应先后不能改变落盘位置', async () => {
  const rootUrl = ENTRY_URL + '&content_id=root';
  const root = ['A','B'].map(id => '<a href="' + ENTRY_URL + '&content_id=' + id + '">' + id + '</a>').join('');
  const file = '<a href="/bbcswebdav/pid-1-dt-content-rid-11_1/xid-11_1">slides.pdf</a>';
  let releaseA;
  const gate = new Promise(resolve => { releaseA = resolve; });
  const fetcher = { async fetchOk(url) {
    const id = new URL(url).searchParams.get('content_id');
    if (id === 'A') await gate;
    if (id === 'B') setImmediate(releaseA);
    return { url, async text() { return id === 'root' ? root : file; } };
  } };
  const entries = await createScanner({ rootUrl, fetcher, minDelayMs: 0, maxDelayMs: 0 }).scan();
  assert.deepEqual(entries.map(entry => entry.folderPath), [['A']]);
});
