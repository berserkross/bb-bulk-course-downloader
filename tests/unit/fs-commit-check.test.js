import test from 'node:test';
import assert from 'node:assert/strict';

import * as realFiles from '../../src/bb/files.js';
import { createFsSink } from '../../src/sinks/fs.js';

const files = { ...realFiles };

function bodyResponse(bytes) {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    }
  });
  return {
    ok: true,
    status: 200,
    url: 'https://bb.example.edu/bbcswebdav/a.pdf',
    headers: new Headers({ 'content-type': 'application/pdf' }),
    body
  };
}

/** 目录桩：getFile() 报出「提交后磁盘上的真实大小」，removeEntry 记录被删掉的文件。 */
function makeDir(committedSize) {
  const removed = [];
  const dir = {
    async getDirectoryHandle() {
      return dir;
    },
    async getFileHandle(name) {
      return {
        name,
        async createWritable() {
          return { async write() {}, async close() {}, async abort() {} };
        },
        async getFile() {
          return { size: committedSize };
        }
      };
    },
    async removeEntry(name) {
      removed.push(name);
    }
  };
  return { dir, removed };
}

const entry = { id: 'e1', href: 'h1', url: 'https://bb.example.edu/bbcswebdav/a.pdf', name: 'a.pdf', folderPath: [] };

test('fs sink：close 之后磁盘字节数与写入量不符 → 判失败并删掉坏文件', async () => {
  const { dir, removed } = makeDir(3); // 实际写了 5 字节，磁盘上只有 3 字节
  const sink = createFsSink({ settings: { downloadConcurrency: 1, fileRetries: 0 }, dirHandle: dir, files });
  const result = await sink.download([entry], { async fetchOk() { return bodyResponse(5); } }, {});
  assert.equal(result.failed.length, 1, '提交后大小不符必须判失败');
  assert.equal(result.ok.length, 0);
  assert.deepEqual(removed, ['a.pdf'], '坏文件必须从磁盘删掉，不能留着冒充课件');
});

test('fs sink：close 之后大小一致 → 正常完成', async () => {
  const { dir, removed } = makeDir(5);
  const sink = createFsSink({ settings: { downloadConcurrency: 1, fileRetries: 0 }, dirHandle: dir, files });
  const result = await sink.download([entry], { async fetchOk() { return bodyResponse(5); } }, {});
  assert.equal(result.ok.length, 1);
  assert.equal(result.failed.length, 0);
  assert.deepEqual(removed, []);
});
