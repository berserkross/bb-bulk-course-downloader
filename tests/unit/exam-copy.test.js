import test from 'node:test';
import assert from 'node:assert/strict';

import * as realFiles from '../../src/bb/files.js';
import { createFsSink } from '../../src/sinks/fs.js';

const files = { ...realFiles };

test('isExamLike：只认往年卷/试题类命名', () => {
  assert.equal(realFiles.isExamLike('Final Exam 2023.pdf'), true);
  assert.equal(realFiles.isExamLike('midterm-solutions.pdf'), true);
  assert.equal(realFiles.isExamLike('2022 真题.pdf'), true);
  assert.equal(realFiles.isExamLike('期中试卷.docx'), true);
  assert.equal(realFiles.isExamLike('Lecture 3 Notes.pdf'), false);
  assert.equal(realFiles.isExamLike('examining-code.zip'), false);
  assert.equal(realFiles.isExamLike(''), false);
  assert.equal(realFiles.isExamLike(null), false);
});

function bodyResponse(bytes) {
  const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); } });
  return { ok: true, status: 200, url: 'https://bb.example.edu/bbcswebdav/x', headers: new Headers({ 'content-type': 'application/pdf' }), body };
}

function makeDir(committedSize) {
  const dirs = [];
  const writes = [];
  const make = (label) => ({
    label,
    async getDirectoryHandle(name) { dirs.push(label + '/' + name); return make(label + '/' + name); },
    async getFileHandle(name, opts) {
      if (!opts || !opts.create) throw new Error('NotFoundError');
      return {
        name,
        async createWritable() {
          const rec = { name, label }; writes.push(rec);
          return { async write() {}, async close() {}, async abort() {} };
        },
        async getFile() { return { size: committedSize }; }
      };
    },
    async removeEntry() {}
  });
  return { dir: make('root'), dirs, writes };
}

const entry = { id: 'e1', href: 'h1', url: 'https://bb.example.edu/bbcswebdav/x', name: 'Final Exam 2023.pdf', folderPath: ['Week 1'] };

test('separateExams 关闭时不会写 _exams/', async () => {
  const { dir, dirs } = makeDir(5);
  const sink = createFsSink({ settings: { downloadConcurrency: 1, fileRetries: 0, separateExams: false }, dirHandle: dir, files });
  const result = await sink.download([entry], { async fetchOk() { return bodyResponse(5); } }, {});
  assert.equal(result.ok.length, 1);
  assert.equal(dirs.includes('root/_exams'), false);
});

test('separateExams 打开时把往年卷额外复制一份到 _exams/，原件照常落盘', async () => {
  const { dir, dirs, writes } = makeDir(5);
  const sink = createFsSink({ settings: { downloadConcurrency: 1, fileRetries: 0, separateExams: true }, dirHandle: dir, files });
  const result = await sink.download([entry], { async fetchOk() { return bodyResponse(5); } }, {});
  assert.equal(result.ok.length, 1);
  assert.equal(dirs.includes('root/_exams'), true, '命中关键词时应创建 _exams/');
  assert.equal(writes.length, 2, '原文件 + _exams 副本 = 两次写入');
});

test('separateExams 打开但文件名不命中时不多写副本', async () => {
  const { dir, dirs } = makeDir(5);
  const plain = Object.assign({}, entry, { name: 'Lecture 3 Notes.pdf' });
  const sink = createFsSink({ settings: { downloadConcurrency: 1, fileRetries: 0, separateExams: true }, dirHandle: dir, files });
  const result = await sink.download([plain], { async fetchOk() { return bodyResponse(5); } }, {});
  assert.equal(result.ok.length, 1);
  assert.equal(dirs.includes('root/_exams'), false);
});
