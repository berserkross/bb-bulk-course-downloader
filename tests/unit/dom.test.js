import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { parseContentList } from '../../src/bb/dom.js';

const PAGE_URL = 'https://bb.example/webapps/blackboard/content/listContent.jsp?course_id=_100_1&content_id=_200_1';

function parse(html) {
  const dom = new JSDOM('<!doctype html><html><body>' + html + '</body></html>', { url: PAGE_URL });
  return parseContentList(dom.window.document, PAGE_URL);
}

test('文件：a[href*="/bbcswebdav/"] 被识别，name 取 textContent', () => {
  const { files } = parse(
    '<a href="/bbcswebdav/pid-660334-dt-content-rid-12444275_1/xid-12444275_1">' +
      '课件一.pdf</a>'
  );
  assert.equal(files.length, 1);
  assert.equal(files[0].name, '课件一.pdf');
  assert.equal(files[0].id, 'dt-content-rid-12444275');
  assert.equal(
    files[0].href,
    '/bbcswebdav/pid-660334-dt-content-rid-12444275_1/xid-12444275_1'
  );
  assert.equal(files[0].url, 'https://bb.example/bbcswebdav/pid-660334-dt-content-rid-12444275_1/xid-12444275_1');
  assert.deepEqual(files[0].folderPath, []);
  assert.equal(files[0].size, undefined);
});

test('文件：textContent 为空时回退到 URL basename（并解码）', () => {
  const { files } = parse('<a href="/bbcswebdav/pid-1/xid-1_1"></a>');
  assert.equal(files[0].name, 'xid-1_1');
  assert.equal(files[0].id, 'https://bb.example/bbcswebdav/pid-1/xid-1_1');
});

test('文件：同一绝对 URL 只产出一条', () => {
  const { files } = parse(
    '<a href="/bbcswebdav/pid-1/xid-1_1">A</a>' +
      '<a href="/bbcswebdav/pid-1/xid-1_1">A again</a>' +
      '<a href="https://bb.example/bbcswebdav/pid-1/xid-1_1">A abs</a>'
  );
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'A');
});

test('文件：非 bbcswebdav 链接不产出', () => {
  const { files } = parse('<a href="/webapps/blackboard/content/listContent.jsp?content_id=_999_1">x</a>');
  assert.equal(files.length, 0);
});

test('文件夹：content_id 不同于当前页的子文件夹被识别', () => {
  const { folders, files } = parse(
    '<a href="listContent.jsp?course_id=_100_1&content_id=_300_1">Week 1</a>'
  );
  assert.equal(files.length, 0);
  assert.equal(folders.length, 1);
  assert.equal(folders[0].id, '_300_1');
  assert.equal(folders[0].name, 'Week 1');
  assert.equal(
    folders[0].url,
    'https://bb.example/webapps/blackboard/content/listContent.jsp?course_id=_100_1&content_id=_300_1'
  );
});

test('文件夹：href="#" 与 "#content" 锚点必须排除（会被解析成当前页）', () => {
  const { folders } = parse(
    '<a href="#">top</a>' +
      '<a href="#content">content</a>' +
      '<a href="#content_id=_400_1">hash query</a>'
  );
  assert.equal(folders.length, 0);
});

test('文件夹：content_id 与当前页相同时排除', () => {
  const { folders } = parse(
    '<a href="listContent.jsp?course_id=_100_1&content_id=_200_1">self</a>'
  );
  assert.equal(folders.length, 0);
});

test('文件夹：绝对 URL 指向当前页（同 path+query）时排除', () => {
  const { folders } = parse('<a href="' + PAGE_URL + '">self abs</a>');
  assert.equal(folders.length, 0);
});

test('文件夹：缺少 content_id 参数时排除', () => {
  const { folders } = parse('<a href="listContent.jsp?course_id=_100_1">no content id</a>');
  assert.equal(folders.length, 0);
});

test('文件夹：相对与绝对形式的同一子文件夹只产出一条', () => {
  const { folders } = parse(
    '<a href="listContent.jsp?course_id=_100_1&content_id=_300_1">Week 1</a>' +
      '<a href="https://bb.example/webapps/blackboard/content/listContent.jsp?course_id=_100_1&content_id=_300_1">' +
      'Week 1 dup</a>'
  );
  assert.equal(folders.length, 1);
  assert.equal(folders[0].name, 'Week 1');
});

test('混合页面：文件与子文件夹同时解析且互不污染', () => {
  const { files, folders } = parse(
    '<a href="/bbcswebdav/pid-1-dt-content-rid-9_1/xid-9_1">syllabus.pdf</a>' +
      '<a href="listContent.jsp?course_id=_100_1&content_id=_300_1">Week 1</a>' +
      '<a href="#">back to top</a>' +
      '<a href="/bbcswebdav/pid-2-dt-content-rid-10_1/xid-10_1">notes.txt</a>'
  );
  assert.equal(files.length, 2);
  assert.equal(folders.length, 1);
  assert.deepEqual(files.map((f) => f.id), ['dt-content-rid-9', 'dt-content-rid-10']);
});

test('空文档与非法入参安全返回空结果', () => {
  assert.deepEqual(parseContentList(null, PAGE_URL), { files: [], folders: [] });
  assert.deepEqual(parse(''), { files: [], folders: [] });
});

test('parseContentList 是纯函数：不改动 DOM', () => {
  const dom = new JSDOM('<body><a href="/bbcswebdav/pid-1/xid-1_1">A</a></body>', { url: PAGE_URL });
  const doc = dom.window.document;
  const before = doc.body.innerHTML;
  parseContentList(doc, PAGE_URL);
  parseContentList(doc, PAGE_URL);
  assert.equal(doc.body.innerHTML, before);
});
