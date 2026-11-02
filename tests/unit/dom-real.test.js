import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

import { parseContentList } from '../../src/bb/dom.js';

// 真实 Blackboard listContent.jsp 快照（已脱敏：姓名与头像占位，结构与 URL 原样）
const HTML = readFileSync(new URL('../fixtures/real-eng1002.html', import.meta.url), 'utf8');

const ORIGIN = 'https://bb.cuhk.edu.cn';
const LIST_PATH = '/webapps/blackboard/content/listContent.jsp';
// 课程菜单「Content」入口：真实 URL 不带 content_id，本页身份只写在 contentForm 的 action 上
const ENTRY_URL = ORIGIN + LIST_PATH + '?course_id=_16517_1';
// 本页自身文件夹身份
const SELF_ID = '_592925_1';
// 课程菜单里指向本页自身的链接（多一个 &mode=reset）
const SELF_URL = ENTRY_URL + '&content_id=' + SELF_ID + '&mode=reset';

const FILE_URL_RE = /^https:\/\/bb\.cuhk\.edu\.cn\/bbcswebdav\/pid-\d+-dt-content-rid-\d+_1\/xid-\d+_1$/;

// 落盘文件名依赖 Content-Disposition 或 URL 尾巴：这里名称本身不带扩展名
const EXPECTED_FILES = [
  ['APA Reference List', '/bbcswebdav/pid-633912-dt-content-rid-12071526_1/xid-12071526_1'],
  ['APA Citation Style_PPT', '/bbcswebdav/pid-618219-dt-content-rid-11538914_1/xid-11538914_1'],
  ['Finding Quality Sources_Updated', '/bbcswebdav/pid-621688-dt-content-rid-11669541_1/xid-11669541_1'],
  ['APA In-text Citation Practice', '/bbcswebdav/pid-622670-dt-content-rid-11695353_1/xid-11695353_1'],
  ['Paraphrasing_PPT', '/bbcswebdav/pid-619380-dt-content-rid-11591121_1/xid-11591121_1']
];

// Content 之外的 8 个真实子文件夹（页面顺序）
const EXPECTED_FOLDERS = [
  ['Important Course Documents', '_606910_1'],
  ['Spring 2026 ENG1002 PowerPoint Lessons', '_606922_1'],
  ['Argument Essay Files', '_626293_1'],
  ['Group Discussion Files', '_606955_1'],
  ['Cause-Effect Essay Files', '_613335_1'],
  ['Individual Presentation Files', '_606945_1'],
  ['Course Reading and Listening Materials', '_607837_1'],
  ['Supplemental Course Materials', '_606962_1']
];

function parse(pageUrl) {
  const dom = new JSDOM(HTML, { url: pageUrl });
  dom.window.TextEncoder = TextEncoder;
  dom.window.TextDecoder = TextDecoder;
  return parseContentList(dom.window.document, pageUrl);
}

test('真实页面：5 个文件，文件名与 bbcswebdav URL 形态精确匹配', () => {
  const { files } = parse(ENTRY_URL);
  assert.equal(files.length, 5);
  assert.deepEqual(
    files.map((file) => file.name),
    EXPECTED_FILES.map(([name]) => name)
  );
  assert.deepEqual(
    files.map((file) => file.url),
    EXPECTED_FILES.map(([, href]) => ORIGIN + href)
  );
  for (const file of files) assert.match(file.url, FILE_URL_RE);
  assert.equal(new Set(files.map((file) => file.id)).size, 5);
  assert.deepEqual(
    files.map((file) => file.id),
    EXPECTED_FILES.map(([, href]) => 'dt-content-rid-' + /dt-content-rid-(\d+)/.exec(href)[1])
  );
  assert.deepEqual(files.map((file) => file.folderPath), [[], [], [], [], []]);
});

test('真实页面：5 个文件 / 9 个文件夹链接，名称与 content_id 一一对应', () => {
  // 换一个内容页的 URL 解析同一份 DOM：此时 Content 这条自链接确实指向「另一个」文件夹，
  // 因此 9 条 listContent 链接全部是真实目标 —— 这条断言同时证明修复没有过度跳过。
  const otherPageUrl = ENTRY_URL + '&content_id=_123539_1';
  const { files, folders } = parse(otherPageUrl);
  assert.equal(files.length, 5);
  assert.equal(folders.length, 9);
  assert.deepEqual(
    folders.map((folder) => [folder.name, folder.id]),
    [['Content', SELF_ID]].concat(EXPECTED_FOLDERS)
  );
  assert.equal(new Set(folders.map((folder) => folder.id)).size, 9);
  assert.equal(new Set(folders.map((folder) => folder.url)).size, 9);
  for (const folder of folders) {
    const expected = ORIGIN + LIST_PATH + '?course_id=_16517_1&content_id=' + folder.id;
    // Content 这条由课程菜单渲染，多一个 &mode=reset
    assert.ok(folder.url === expected || folder.url === expected + '&mode=reset', folder.url);
  }
});

test('真实页面：指向本页自身的 Content 链接被跳过，其余 8 个子文件夹保留', () => {
  // 入口 URL 不带 content_id，页面自身身份只能来自 contentForm 的 action
  const { files, folders } = parse(ENTRY_URL);
  assert.equal(files.length, 5);
  assert.equal(folders.length, 8);
  assert.equal(folders.some((folder) => folder.id === SELF_ID), false);
  assert.equal(folders.some((folder) => folder.name === 'Content'), false);
  assert.deepEqual(
    folders.map((folder) => [folder.name, folder.id]),
    EXPECTED_FOLDERS
  );
});

test('真实页面：本页 URL 自带 content_id 与 &mode=reset 时同样不把自己当子文件夹', () => {
  const { folders } = parse(SELF_URL);
  assert.equal(folders.length, 8);
  assert.equal(folders.some((folder) => folder.id === SELF_ID), false);
  assert.deepEqual(
    folders.map((folder) => folder.id),
    EXPECTED_FOLDERS.map(([, id]) => id)
  );
});

test('真实页面：本页是子文件夹时，其它文件夹不因修复被误伤', () => {
  const subUrl = ENTRY_URL + '&content_id=_606910_1';
  const { folders } = parse(subUrl);
  assert.equal(folders.length, 8);
  assert.equal(folders.some((folder) => folder.id === '_606910_1'), false);
  assert.equal(folders.some((folder) => folder.id === SELF_ID), true);
});

test('无害参数推导用例：query 只差 mode / list_display 即视为本页', () => {
  const pageUrl = ORIGIN + LIST_PATH + '?course_id=_1_1&content_id=_2_1';
  const html =
    '<a href="listContent.jsp?course_id=_1_1&content_id=_2_1&mode=reset">self by mode</a>' +
    '<a href="listContent.jsp?list_display=1&course_id=_1_1&content_id=_2_1">self by list_display</a>' +
    '<a href="listContent.jsp?content_id=_2_1&course_id=_1_1&mode=reset">self reordered</a>' +
    '<a href="listContent.jsp?course_id=_1_1&content_id=_3_1&mode=reset">child</a>';
  const dom = new JSDOM('<!doctype html><html><body>' + html + '</body></html>', { url: pageUrl });
  const { folders } = parseContentList(dom.window.document, pageUrl);
  assert.equal(folders.length, 1);
  assert.equal(folders[0].id, '_3_1');
  assert.equal(folders[0].name, 'child');
});
