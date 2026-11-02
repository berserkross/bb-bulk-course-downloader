import test from 'node:test';
import assert from 'node:assert/strict';

import * as realFiles from '../../src/bb/files.js';
import { listExistingFiles } from '../../src/sinks/existing.js';
import { listExistingFiles as viaIndex } from '../../src/sinks/index.js';
import { planBatch, relativePath } from '../../src/sinks/shared.js';

const files = { ...realFiles };

// ---------- 假的 FSA 目录句柄：只实现 values() ----------

function fileHandle(name, { size = 0, fail = false, noKind = false } = {}) {
  const handle = {
    name,
    async getFile() {
      if (fail) throw new Error('NotReadableError: 取不到文件');
      if (size === undefined) return { name };
      return { name, size };
    }
  };
  if (!noKind) handle.kind = 'file';
  return handle;
}

function dirHandle(name, entries) {
  return {
    kind: 'directory',
    name,
    values() {
      return (async function* () {
        for (const entry of entries) yield entry;
      })();
    }
  };
}

/** 目录遍历到第 n 个条目时抛错的句柄（模拟权限被中途收回）。 */
function throwingDir(name, entries, failAt) {
  return {
    kind: 'directory',
    name,
    values() {
      let i = 0;
      return {
        async next() {
          if (i >= failAt) throw new DOMException('permission denied', 'NotAllowedError');
          const value = entries[i];
          i += 1;
          return { done: false, value };
        }
      };
    }
  };
}

/** 只给 Symbol.asyncIterator、不给 next() 的实现。 */
function iterableOnlyDir(name, entries) {
  return {
    kind: 'directory',
    name,
    values() {
      return {
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            async next() {
              if (i >= entries.length) return { done: true, value: undefined };
              const value = entries[i];
              i += 1;
              return { done: false, value };
            }
          };
        }
      };
    }
  };
}

// =========================== 正常嵌套 ===========================

test('listExistingFiles：递归 values() 扫出嵌套文件，路径用 / 连接且深一层不漏', async () => {
  const root = dirHandle('course', [
    fileHandle('a.pdf', { size: 10 }),
    dirHandle('Week 1', [
      fileHandle('b.mp4', { size: 20 }),
      dirHandle('Slides', [fileHandle('c.bin', { size: 5 })])
    ])
  ]);
  const found = await listExistingFiles(root);
  assert.deepEqual([...found.keys()].sort(), ['Week 1/Slides/c.bin', 'Week 1/b.mp4', 'a.pdf']);
  assert.equal(found.get('a.pdf'), 10);
  assert.equal(found.get('Week 1/b.mp4'), 20);
  assert.equal(found.get('Week 1/Slides/c.bin'), 5);
  assert.equal(found.truncated, false);
  console.log('  [证据] 扫描结果：', JSON.stringify([...found.entries()]));
});

test('listExistingFiles：路径与 relativePath(planBatch(...)) 同形（防两套拼接各写一份）', async () => {
  const entries = [{ id: 'dt-content-rid-1', url: 'http://x/a', name: '讲义.pdf', folderPath: ['Week 1', 'Slides'] }];
  const plans = planBatch(entries, { preserveTree: true, files });
  const plan = plans[0];
  const root = dirHandle('course', [dirHandle(plan.segments[0], [dirHandle(plan.segments[1], [fileHandle(plan.fileName, { size: 7 })])])]);
  const found = await listExistingFiles(root);
  assert.deepEqual([...found.keys()], [relativePath(plan)]);
  assert.equal(found.get(relativePath(plan)), 7);
});

test('listExistingFiles：getFile() 抛错时该条目照记、值为 null（不是 0、不是跳过）', async () => {
  const root = dirHandle('course', [fileHandle('坏.pdf', { fail: true }), fileHandle('好.pdf', { size: 0 })]);
  const found = await listExistingFiles(root);
  assert.equal(found.has('坏.pdf'), true);
  assert.equal(found.get('坏.pdf'), null);
  assert.equal(found.get('好.pdf'), 0, '真实的 0 字节文件必须写成 0，不能变成 null');
});

test('listExistingFiles：size 不是有限数时写 null', async () => {
  const root = dirHandle('course', [{ kind: 'file', name: 'x.bin', async getFile() { return { name: 'x.bin' }; } }]);
  const found = await listExistingFiles(root);
  assert.equal(found.get('x.bin'), null);
});

// =========================== maxFiles / maxDepth 截断 ===========================

test('listExistingFiles：达到 maxFiles 立即停并置 truncated=true（防超大目录卡死页面）', async () => {
  const root = dirHandle('course', [0, 1, 2, 3, 4].map((i) => fileHandle('f' + i + '.bin', { size: i })));
  const found = await listExistingFiles(root, { maxFiles: 2 });
  assert.equal(found.size, 2);
  assert.deepEqual([...found.keys()], ['f0.bin', 'f1.bin']);
  assert.equal(found.truncated, true);
});

test('listExistingFiles：条目数恰等于 maxFiles 时不算截断', async () => {
  const root = dirHandle('course', [fileHandle('a.bin', { size: 1 }), fileHandle('b.bin', { size: 2 })]);
  const found = await listExistingFiles(root, { maxFiles: 2 });
  assert.equal(found.size, 2);
  assert.equal(found.truncated, false);
});

test('listExistingFiles：maxDepth=0 只扫根目录，最深一层不进去并置 truncated=true', async () => {
  const root = dirHandle('course', [fileHandle('a.bin', { size: 1 }), dirHandle('sub', [fileHandle('b.bin', { size: 2 })])]);
  const found = await listExistingFiles(root, { maxDepth: 0 });
  assert.deepEqual([...found.keys()], ['a.bin']);
  assert.equal(found.truncated, true);
});

test('listExistingFiles：maxDepth 按目录层数计数，第 N 层仍能看到文件', async () => {
  const root = dirHandle('course', [dirHandle('L1', [dirHandle('L2', [fileHandle('deep.bin', { size: 9 })])])]);
  assert.deepEqual([...(await listExistingFiles(root, { maxDepth: 2 })).keys()], ['L1/L2/deep.bin']);
  assert.deepEqual([...(await listExistingFiles(root, { maxDepth: 1 })).keys()], []);
});

test('listExistingFiles：truncated 是非枚举属性，遍历/序列化 Map 时不会冒出来', async () => {
  const root = dirHandle('course', [fileHandle('a.bin', { size: 1 })]);
  const found = await listExistingFiles(root);
  assert.equal(Object.keys(found).includes('truncated'), false);
  assert.equal(JSON.stringify(found), '{}');
  assert.equal(found instanceof Map, true);
  assert.equal('truncated' in found, true, '非枚举但必须可读');
});

// =========================== 中断与异常 ===========================

test('listExistingFiles：signal 已中止时一个条目都不读，也不抛错', async () => {
  const controller = new AbortController();
  controller.abort();
  const root = dirHandle('course', [fileHandle('a.bin', { size: 1 })]);
  const found = await listExistingFiles(root, { signal: controller.signal });
  assert.equal(found.size, 0);
});

test('listExistingFiles：运行中中止立即停手，保留已收集部分（不冒泡 AbortError）', async () => {
  const controller = new AbortController();
  const root = {
    kind: 'directory',
    name: 'course',
    values() {
      let i = 0;
      return {
        async next() {
          if (i === 0) {
            i += 1;
            return { done: false, value: fileHandle('first.bin', { size: 3 }) };
          }
          if (i === 1) {
            controller.abort();
            i += 1;
            return { done: false, value: fileHandle('second.bin', { size: 4 }) };
          }
          return { done: true, value: undefined };
        }
      };
    }
  };
  const found = await listExistingFiles(root, { signal: controller.signal });
  assert.deepEqual([...found.keys()], ['first.bin']);
});

test('listExistingFiles：迭代抛错时返回已收集部分而不是抛给调用方', async () => {
  const root = throwingDir('course', [fileHandle('ok.bin', { size: 2 }), fileHandle('never.bin', { size: 3 })], 1);
  const found = await listExistingFiles(root);
  assert.deepEqual([...found.keys()], ['ok.bin']);
  assert.equal(found.get('ok.bin'), 2);
});

test('listExistingFiles：values() 本身抛错（权限被拒）返回空 Map，不抛错', async () => {
  const root = {
    kind: 'directory',
    name: 'course',
    values() {
      throw new DOMException('denied', 'NotAllowedError');
    }
  };
  const found = await listExistingFiles(root);
  assert.equal(found.size, 0);
  assert.equal(found.truncated, false);
});

// =========================== 空与降级输入 ===========================

test('listExistingFiles：空目录返回空 Map', async () => {
  const found = await listExistingFiles(dirHandle('course', []));
  assert.equal(found.size, 0);
  assert.equal(found.truncated, false);
});

test('listExistingFiles：无 dirHandle / 无 values() 时返回空 Map（无 FSA 的浏览器不得崩）', async () => {
  for (const bad of [undefined, null, {}, { values: 1 }]) {
    const found = await listExistingFiles(bad);
    assert.ok(found instanceof Map, '必须仍然是 Map：' + String(bad));
    assert.equal(found.size, 0);
    assert.equal(found.truncated, false);
  }
});

test('listExistingFiles：只给 Symbol.asyncIterator 的 values() 也能迭代', async () => {
  const found = await listExistingFiles(iterableOnlyDir('course', [fileHandle('a.bin', { size: 1 })]));
  assert.deepEqual([...found.keys()], ['a.bin']);
});

test('listExistingFiles：没有 kind 的句柄按有没有 getFile 判断文件/目录', async () => {
  const root = dirHandle('course', [
    fileHandle('nokind.bin', { size: 6, noKind: true }),
    (() => {
      const dir = dirHandle('sub', [fileHandle('inner.bin', { size: 7 })]);
      delete dir.kind;
      return dir;
    })()
  ]);
  const found = await listExistingFiles(root);
  assert.deepEqual([...found.keys()].sort(), ['nokind.bin', 'sub/inner.bin']);
});

test('listExistingFiles：src/sinks/index.js 也导出同一个函数', () => {
  assert.equal(typeof viaIndex, 'function');
  assert.equal(viaIndex, listExistingFiles);
});
