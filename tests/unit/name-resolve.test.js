import test from 'node:test';
import assert from 'node:assert/strict';

import { extensionForMime, looksLikeFileName, resolveFileName } from '../../src/bb/files.js';

const REAL_URL =
  'https://bb.example.edu/bbcswebdav/pid-1-dt-content-rid-2_1/courses/ENG1002/APA%20Reference%20List.pdf';
const PLACEHOLDER_URL =
  'https://bb.example.edu/bbcswebdav/pid-633912-dt-content-rid-12071526_1/xid-12071526_1';

test('extensionForMime 命中契约里的固定映射', () => {
  assert.equal(extensionForMime('application/pdf'), '.pdf');
  assert.equal(
    extensionForMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    '.docx'
  );
  assert.equal(
    extensionForMime('application/vnd.openxmlformats-officedocument.presentationml.presentation'),
    '.pptx'
  );
  assert.equal(
    extensionForMime('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    '.xlsx'
  );
  assert.equal(extensionForMime('application/msword'), '.doc');
  assert.equal(extensionForMime('application/vnd.ms-powerpoint'), '.ppt');
  assert.equal(extensionForMime('application/vnd.ms-excel'), '.xls');
  assert.equal(extensionForMime('application/zip'), '.zip');
  assert.equal(extensionForMime('text/plain'), '.txt');
  assert.equal(extensionForMime('text/csv'), '.csv');
  assert.equal(extensionForMime('image/png'), '.png');
  assert.equal(extensionForMime('image/jpeg'), '.jpg');
  assert.equal(extensionForMime('image/gif'), '.gif');
});

test('extensionForMime 对 octet-stream、未知类型与空入参返回空串', () => {
  assert.equal(extensionForMime('application/octet-stream'), '');
  assert.equal(extensionForMime('application/x-whatever'), '');
  assert.equal(extensionForMime(''), '');
  assert.equal(extensionForMime(undefined), '');
});

test('looksLikeFileName 认契约里的四例', () => {
  assert.equal(looksLikeFileName('xid-12071526_1'), false);
  assert.equal(looksLikeFileName('APA Reference List.pdf'), true);
  assert.equal(looksLikeFileName('Week 1/week 2.pdf'), false);
  assert.equal(looksLikeFileName('noext'), false);
});

test('looksLikeFileName 拒绝反斜杠路径、占位名与空串', () => {
  assert.equal(looksLikeFileName('Week 1\\week 2.pdf'), false);
  assert.equal(looksLikeFileName('pid-633912_1.pdf'), false);
  assert.equal(looksLikeFileName('xid-12071526_1.pdf'), false);
  assert.equal(looksLikeFileName(''), false);
  assert.equal(looksLikeFileName('.pdf'), true);
  assert.equal(looksLikeFileName('a.%E4'), false);
});

test('resolveFileName 走 filename* 并真的解码中文（优先于 filename）', () => {
  assert.equal(
    resolveFileName({ disposition: "attachment; filename*=UTF-8''%E8%AF%BE%E4%BB%B6.pdf" }),
    '课件.pdf'
  );
  assert.equal(
    resolveFileName({
      disposition: 'attachment; filename="fallback.pdf"; filename*=UTF-8\'\'%E8%AF%BE%E4%BB%B6.pdf',
      title: '显示标题'
    }),
    '课件.pdf'
  );
});

test('resolveFileName 回退到 filename="…" 与无引号的 filename=…', () => {
  assert.equal(resolveFileName({ disposition: 'attachment; filename="APA Reference List.pdf"' }), 'APA Reference List.pdf');
  assert.equal(resolveFileName({ disposition: 'attachment; filename=APA Reference List.pdf' }), 'APA Reference List.pdf');
  assert.equal(resolveFileName({ disposition: "attachment; filename='single.pdf'" }), "'single.pdf'");
});

test('resolveFileName 用 finalUrl 真名替换显示标题', () => {
  assert.equal(
    resolveFileName({
      finalUrl: REAL_URL,
      href: PLACEHOLDER_URL,
      title: 'APA Reference List',
      mime: 'application/pdf'
    }),
    'APA Reference List.pdf'
  );
});

test('resolveFileName 拒绝 finalUrl 里的 xid 占位名，退回标题并补 mime 后缀', () => {
  assert.equal(
    resolveFileName({ finalUrl: PLACEHOLDER_URL, href: PLACEHOLDER_URL, title: 'APA Reference List', mime: 'application/pdf' }),
    'APA Reference List.pdf'
  );
});

test('resolveFileName finalUrl 末段与 href 末段相同时不算真名', () => {
  assert.equal(
    resolveFileName({
      finalUrl: 'https://bb.example.edu/bbcswebdav/pid-1/download.pdf',
      href: 'https://bb.example.edu/bbcswebdav/pid-1/download.pdf',
      title: 'Week 3 Slides',
      mime: 'application/pdf'
    }),
    'Week 3 Slides.pdf'
  );
});

test('resolveFileName 只剩标题时用标题并补 mime 后缀', () => {
  assert.equal(resolveFileName({ title: '第 1 课讲义', mime: 'application/pdf' }), '第 1 课讲义.pdf');
  assert.equal(resolveFileName({ title: 'Notes', mime: 'text/plain' }), 'Notes.txt');
});

test('resolveFileName 无任何线索时返回空串', () => {
  assert.equal(resolveFileName({}), '');
  assert.equal(resolveFileName(), '');
  assert.equal(resolveFileName({ finalUrl: PLACEHOLDER_URL, href: PLACEHOLDER_URL, title: '   ' }), '');
});

test('resolveFileName mime 给不出后缀时保持原样', () => {
  assert.equal(resolveFileName({ title: 'APA Reference List', mime: 'application/octet-stream' }), 'APA Reference List');
  assert.equal(resolveFileName({ title: 'APA Reference List' }), 'APA Reference List');
  assert.equal(resolveFileName({ disposition: 'attachment; filename="Week 3 slides"' }), 'Week 3 slides');
});

test('resolveFileName 结果已有扩展名时不再追加后缀', () => {
  assert.equal(resolveFileName({ title: 'Slides.pptx', mime: 'application/pdf' }), 'Slides.pptx');
  assert.equal(
    resolveFileName({ finalUrl: REAL_URL, href: PLACEHOLDER_URL, title: 'APA Reference List', mime: 'application/pdf' }),
    'APA Reference List.pdf'
  );
});

test('resolveFileName title 自带扩展名时不再叠一层后缀', () => {
  assert.equal(
    resolveFileName({ disposition: 'attachment; filename="Week 3"', title: 'Notes.pdf', mime: 'application/pdf' }),
    'Notes.pdf'
  );
});

test('resolveFileName title 无后缀时才用 mime 后缀补上', () => {
  assert.equal(
    resolveFileName({ disposition: 'attachment; filename="Week 3"', title: 'Notes', mime: 'application/pdf' }),
    'Notes.pdf'
  );
});

test('resolveFileName 对 filename= 里的百分号编码也解码', () => {
  assert.equal(resolveFileName({ disposition: 'attachment; filename="%E8%AF%BE%E4%BB%B6.pdf"' }), '课件.pdf');
});
