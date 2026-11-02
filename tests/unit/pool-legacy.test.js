import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runPool, createControl } from '../../src/sinks/pool.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Blackboard Original 版式页面会加载 Prototype.js，它用 $A 覆盖 Array.from，
 * 且忽略第二个参数（mapFn）。这个假实现复刻那件事：数组仍然正常拷贝，回调永不执行。
 * 真实的 Array.from(..., fn) 调用会因此静默变成「一个 worker 都不启动」。
 */
function installLegacyArrayFrom() {
  const original = Array.from;
  function legacyFrom(iterable) {
    if (iterable == null) throw new TypeError('Array.from: null is not iterable');
    const out = [];
    const len = typeof iterable.length === 'number' ? iterable.length : 0;
    for (let i = 0; i < len; i += 1) out.push(iterable[i]);
    return out;
  }
  Array.from = legacyFrom;
  return () => {
    Array.from = original;
  };
}

if (typeof Array.from !== 'function') throw new Error('native Array.from missing in this runtime');

test('宿主 Array.from 忽略 mapFn 时 runPool 仍然把每个 job 交给 worker', async () => {
  const restore = installLegacyArrayFrom();
  try {
    const seen = [];
    await runPool([1, 2, 3], 2, async (job) => {
      seen.push(job);
    });
    assert.deepEqual(seen, [1, 2, 3], 'worker 必须逐个拿到 job（不能因为 Array.from 忽略回调就空跑）');
  } finally {
    restore();
  }
});

test('宿主 Array.from 忽略 mapFn 时停机闸门语义不变', async () => {
  const restore = installLegacyArrayFrom();
  try {
    const control = createControl();
    const seen = [];
    await runPool([1, 2, 3], 1, async (job) => {
      seen.push(job);
      control.stop('session-expired');
    }, { control });
    assert.deepEqual(seen, [1], '停机后不再取号');
  } finally {
    restore();
  }
});

test('runPool 接受类数组入口（不依赖 Array.from 的实现）', async () => {
  const seen = [];
  await runPool({ 0: 'a', 1: 'b', length: 2 }, 1, async (job) => {
    seen.push(job);
  });
  assert.deepEqual(seen, ['a', 'b']);
});

test('源码里不许再出现带 mapFn 的 Array.from（宿主会把它变成静默空跑）', () => {
  const offenders = [];
  for (const file of walk(join(here, '../../src'))) {
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const call of mapFnCalls(source)) {
      offenders.push(file.split(/[\\/]/).pop() + ': ' + call.split('\n')[0]);
    }
  }
  assert.deepEqual(offenders, [], '改用显式 for 循环；Array.from(x) 单参数仍然可以用');
});

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// 注释里出现 Array.from(x, fn) 是合理的文档写法，不该被这条护栏打中
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

function mapFnCalls(source) {
  const hits = [];
  const needle = 'Array.from(';
  let start = source.indexOf(needle);
  while (start !== -1) {
    let depth = 1;
    let i = start + needle.length;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      else if (ch === ',' && depth === 1) {
        hits.push(source.slice(start, i + 1));
        break;
      }
      i += 1;
    }
    start = source.indexOf(needle, start + 1);
  }
  return hits;
}
