import test from 'node:test';
import assert from 'node:assert/strict';
import { createFsSink } from '../../src/sinks/fs.js';

// 落盘层的自相矛盾守卫：提交了文件却一条记录都没产生时，必须抛错而不是当成「完成」。
// 用 dedupePaths 返回空数组这个真实接缝来复现「计划为 0」的状态，不碰任何私有实现。
function makeSink(dedupe) {
  const files = {
    buildEntryPath: () => ({ segments: [], fileName: 'a.pdf' }),
    sanitizeSegment: (name) => String(name),
    dedupePaths: dedupe
  };
  return createFsSink({ settings: {}, dirHandle: {}, signal: undefined, total: 1, files: files, sizeOf: () => undefined });
}

test('落盘层：提交了 1 个文件却计划 0 个时抛错，而不是返回空结果当成功', async () => {
  const sink = makeSink(() => []);
  await assert.rejects(
    () => sink.download([{ id: 'e1', url: '/x', name: 'a.pdf' }], { fetchOk: async () => ({}) }),
    /落盘层没有处理任何文件：提交 1 个、计划 0 个、并发/
  );
});

test('落盘层：空批次仍然正常返回（守卫不能误伤续跑与空选择）', async () => {
  const sink = makeSink(() => []);
  const result = await sink.download([], { fetchOk: async () => ({}) });
  assert.deepEqual(result.ok, []);
  assert.deepEqual(result.failed, []);
  assert.equal(result.aborted, false);
});