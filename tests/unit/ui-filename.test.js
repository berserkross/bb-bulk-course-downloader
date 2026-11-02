import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { mountPanel } from '../../src/ui/panel.js';

const PAGE = 'https://bb.example.edu/webapps/blackboard/content/listContent.jsp?course_id=_1_1&content_id=_2_1';

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: PAGE, pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  return dom;
}

function mount() {
  return mountPanel({ settings: {}, onScan: function () {}, onDownload: function () {} });
}

function cellOf(id, cls) {
  const row = document.querySelector('.bbdl-files__row[data-entry-id="' + id + '"]');
  assert.ok(row, '找不到 entryId=' + id + ' 的行');
  return row.querySelector('.' + cls).textContent;
}

function seed() {
  return [
    { id: 'e1', name: 'APA Reference List', folderPath: ['Week 1'], size: 100 },
    { id: 'e2', name: 'Notes', folderPath: ['Week 2'], size: 200 }
  ];
}

test('M5：done 事件带的真名落到行上，路径列只保留目录段', () => {
  setupDom();
  const api = mount();
  api.setFiles(seed());
  assert.equal(cellOf('e1', 'bbdl-files__name'), 'APA Reference List');
  api.applyFileEvent({ type: 'start', entryId: 'e1', attempt: 1, name: 'APA Reference List', path: 'Week 1/APA Reference List' });
  api.applyFileEvent({ type: 'done', entryId: 'e1', attempt: 1, bytes: 100, name: 'APA Reference List.pdf', path: 'Week 1/APA Reference List.pdf' });
  assert.equal(cellOf('e1', 'bbdl-files__name'), 'APA Reference List.pdf', '行上的名字必须是服务器真名');
  assert.equal(cellOf('e1', 'bbdl-files__path'), 'Week 1', '路径列只放目录，不与名字重复');
  assert.equal(cellOf('e2', 'bbdl-files__name'), 'Notes', '别的行不许被串改');
});

test('M5：failed 事件也带解析后的名字', () => {
  setupDom();
  const api = mount();
  api.setFiles(seed());
  api.applyFileEvent({ type: 'start', entryId: 'e2', attempt: 1 });
  api.applyFileEvent({ type: 'failed', entryId: 'e2', attempt: 1, name: 'Notes.docx', path: 'Week 2/Notes.docx', error: '连接超时' });
  assert.equal(cellOf('e2', 'bbdl-files__name'), 'Notes.docx');
});

test('M5：事件里的 URL 与 query 仍然进不了 DOM', () => {
  setupDom();
  const api = mount();
  api.setFiles(seed());
  api.applyFileEvent({
    type: 'done',
    entryId: 'e1',
    bytes: 100,
    name: 'https://bb.example.edu/bbcswebdav/xid-1_1/secret.pdf?token=SECRET1',
    path: 'https://bb.example.edu/bbcswebdav/xid-1_1?content_id=_1_1'
  });
  const name = cellOf('e1', 'bbdl-files__name');
  const path = cellOf('e1', 'bbdl-files__path');
  assert.doesNotMatch(name, /https?:|\?|SECRET/);
  assert.doesNotMatch(path, /https?:|\?|SECRET/);
  assert.equal(name, 'APA Reference List', '危险值一律不采纳，保留种子里已有的名字');
  assert.equal(path, 'Week 1');
});