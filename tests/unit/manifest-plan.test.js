import test from 'node:test';
import assert from 'node:assert/strict';

import { planSkips } from '../../src/store/manifest-plan.js';
import { updateRecords, recordFromPlan } from '../../src/store/manifest.js';

/**
 * 造一个 planBatch 形状的计划：落盘相对路径 = segments.concat(fileName).join('/')。
 * href 缺省不写字段 —— 用来模拟「本次扫描拿不到版本指纹」的条目。
 */
function plan(id, segments, fileName, size, href) {
  const entry = { id, name: fileName, folderPath: segments };
  if (size !== undefined) entry.size = size;
  if (href !== undefined) entry.href = href;
  return { entry, segments, fileName };
}

/** href 缺省不写字段 —— 用来模拟 v1 旧记录（契约 §5：没有 href → 不得当作「未变」）。 */
function record(id, path, size, status, href) {
  const rec = { id, path, name: path.split('/').pop(), size, status, updatedAt: 1 };
  if (href !== undefined) rec.href = href;
  return rec;
}

function snapshot(value) {
  return JSON.stringify(value);
}

const EMPTY_DIFF = { added: 0, changed: 0, moved: 0, unchanged: 0, stale: 0, unknown: 0, total: 0 };

// ---------------------------------------------------------------- 跳过判定 1) ~ 5)

test('1) 磁盘同路径且两边大小相等 → skip/disk（防：已经下好的文件每次回来重下一遍，白烧流量）', () => {
  const plans = [plan('a', ['Week 3'], 'slides.pdf')];
  const manifest = { courseId: 'c', version: 1, updatedAt: 1, files: { a: record('a', 'Week 3/slides.pdf', 100, 'done') } };
  const result = planSkips({ plans, manifest, existingPaths: new Map([['Week 3/slides.pdf', 100]]) });
  assert.equal(result.todo.length, 0);
  assert.equal(result.skip.length, 1);
  assert.equal(result.skip[0].reason, 'disk');
  assert.equal(result.skip[0].size, 100);
  assert.equal(result.skip[0].plan, plans[0]);
});

test('2) 磁盘有该路径但两边大小都不知道 → skip/disk-unverified（防：无法核实就静默重下，或者反过来误判成已一致）', () => {
  const plans = [plan('a', [], 'a.pdf')];
  const manifest = { courseId: 'c', version: 1, updatedAt: 1, files: { a: record('a', 'a.pdf', null, 'done') } };
  const result = planSkips({ plans, manifest, existingPaths: new Map([['a.pdf', null]]) });
  assert.equal(result.todo.length, 0);
  assert.equal(result.skip.length, 1);
  assert.equal(result.skip[0].reason, 'disk-unverified');
  assert.equal(result.skip[0].size, null);
});

test('3) 磁盘有该路径但大小不等 → 进 todo（防：上游更新过仍按旧文件跳过，用户拿到过期课件）', () => {
  const plans = [plan('a', [], 'a.pdf')];
  const manifest = { courseId: 'c', version: 1, updatedAt: 1, files: { a: record('a', 'a.pdf', 100, 'done') } };
  const result = planSkips({ plans, manifest, existingPaths: new Map([['a.pdf', 90]]) });
  assert.equal(result.skip.length, 0);
  assert.equal(result.todo.length, 1);
  assert.equal(result.todo[0], plans[0]);
});

test('4) 磁盘上没有、但清单同路径且 status=done 且 href 相等 → skip/manifest-unchanged（防：不支持 FSA 的浏览器上跳过功能整体失效）', () => {
  const plans = [plan('a', ['Week 3'], 'slides.pdf', 100, '/rid/1/xid-1')];
  const manifest = {
    courseId: 'c',
    version: 2,
    updatedAt: 1,
    files: { a: record('a', 'Week 3/slides.pdf', 100, 'done', '/rid/1/xid-1') }
  };
  const result = planSkips({ plans, manifest, existingPaths: new Map() });
  assert.equal(result.todo.length, 0);
  assert.equal(result.skip.length, 1);
  assert.equal(result.skip[0].reason, 'manifest-unchanged');
  assert.equal(result.skip[0].size, 100);
});

test('4b) 无 FSA 浏览器上的 v1 记录（没有 href 可比）不再弱证据跳过，而是重下一次自愈（防：上游改过但字节数没变的课件被永久静默跳过）', () => {
  const plans = [plan('a', ['Week 3'], 'slides.pdf', 100, '/rid/1/xid-1')];
  const manifest = { courseId: 'c', version: 1, updatedAt: 1, files: { a: record('a', 'Week 3/slides.pdf', 100, 'done') } };
  const result = planSkips({ plans, manifest, existingPaths: new Map() });
  assert.equal(result.skip.length, 0, 'v1 记录不许再产生 manifest 弱证据跳过');
  assert.equal(result.todo.length, 1);
  assert.equal(result.diff.unknown, 1);
  assert.equal(result.diff.unchanged, 0);
});

test('5) 清单里没有、磁盘上也没有 → 进 todo（防：新文件被误跳过，最后什么都没下）', () => {
  const plans = [plan('a', [], 'a.pdf')];
  const result = planSkips({ plans, manifest: null, existingPaths: new Map() });
  assert.equal(result.skip.length, 0);
  assert.equal(result.todo.length, 1);
});

test('status 不是 done 的记录绝不据清单跳过：partial / failed 都要重下（防：把下了一半的 PDF 当成已完成，用户拿到半截文件还以为成功）', () => {
  for (const status of ['partial', 'failed']) {
    const plans = [plan('a', [], 'a.pdf')];
    const manifest = { courseId: 'c', version: 1, updatedAt: 1, files: { a: record('a', 'a.pdf', 100, status) } };
    const result = planSkips({ plans, manifest, existingPaths: new Map() });
    assert.equal(result.skip.length, 0, status + ' 不该被跳过');
    assert.equal(result.todo.length, 1, status + ' 应该进 todo');
  }
});

test('status=done 但清单里的 path 与本次不同 → 不跳过（防：改了目录结构后，同名旧记录把新路径的文件跳过）', () => {
  const plans = [plan('a', ['Week 3'], 'slides.pdf')];
  const manifest = { courseId: 'c', version: 1, updatedAt: 1, files: { a: record('a', 'Week 2/slides.pdf', 100, 'done') } };
  const result = planSkips({ plans, manifest, existingPaths: new Map() });
  assert.equal(result.skip.length, 0);
  assert.equal(result.todo.length, 1);
});

test('契约未覆盖的补全：只有一边知道大小 → skip/disk-unverified 并带上已知大小（防：默默把几 MB 的文件重下一遍）', () => {
  const known = planSkips({ plans: [plan('a', [], 'a.pdf')], manifest: null, existingPaths: new Map([['a.pdf', 512]]) });
  assert.equal(known.skip.length, 1);
  assert.equal(known.skip[0].reason, 'disk-unverified');
  assert.equal(known.skip[0].size, 512);

  const other = planSkips({
    plans: [plan('a', [], 'b.pdf')],
    manifest: { courseId: 'c', version: 1, updatedAt: 1, files: { a: record('a', 'b.pdf', 777, 'done') } },
    existingPaths: new Map([['b.pdf', null]])
  });
  assert.equal(other.skip[0].reason, 'disk-unverified');
  assert.equal(other.skip[0].size, 777);
});

test('清单缺失时用 entry.size 兜底比大小（防：没跑过体积探测就永远无法按大小跳过）', () => {
  const plans = [plan('a', [], 'a.pdf', 2048)];
  const result = planSkips({ plans, manifest: null, existingPaths: new Map([['a.pdf', 2048]]) });
  assert.equal(result.skip.length, 1);
  assert.equal(result.skip[0].reason, 'disk');
  assert.equal(result.skip[0].size, 2048);
});

test('0 字节是合法大小，不等于「未知」（防：把 size 0 当未知，空文件被反复重下或误判为无法核实）', () => {
  const plans = [plan('a', [], 'empty.txt')];
  const manifest = { courseId: 'c', version: 1, updatedAt: 1, files: { a: record('a', 'empty.txt', 0, 'done') } };
  const result = planSkips({ plans, manifest, existingPaths: new Map([['empty.txt', 0]]) });
  assert.equal(result.skip.length, 1);
  assert.equal(result.skip[0].reason, 'disk');
  assert.equal(result.skip[0].size, 0);
});

test('partial + 两边都不知道大小 → 进 todo，绝不当已完成跳过（防：上一轮下到一半的文件在磁盘上留了同名残骸，本轮又取不到大小，半截文件被永久当成已完成）', () => {
  const plans = [plan('a', [], 'a.pdf')];
  const manifest = { courseId: 'c', version: 1, updatedAt: 1, files: { a: record('a', 'a.pdf', null, 'partial') } };
  const result = planSkips({ plans, manifest, existingPaths: new Map([['a.pdf', null]]) });
  assert.equal(result.skip.length, 0, 'partial 不允许被跳过');
  assert.equal(result.todo.length, 1);
  assert.equal(result.todo[0], plans[0]);
});

test('failed + 一边大小已知（磁盘未知）→ 进 todo（防：只知道期望大小就把磁盘上那份当成完成品，失败的重试被静默丢弃）', () => {
  const plans = [plan('a', [], 'a.pdf')];
  const manifest = { courseId: 'c', version: 1, updatedAt: 1, files: { a: record('a', 'a.pdf', 4096, 'failed') } };
  const result = planSkips({ plans, manifest, existingPaths: new Map([['a.pdf', null]]) });
  assert.equal(result.skip.length, 0);
  assert.equal(result.todo.length, 1);
});

test('partial 和 failed 即使磁盘大小相等也必须重新下载', () => {
  for (const status of ['partial', 'failed']) {
    const plans = [plan('a', [], 'a.pdf')];
    const manifest = { files: { a: record('a', 'a.pdf', 100, status) } };
    const result = planSkips({ plans, manifest, existingPaths: new Map([['a.pdf', 100]]) });
    assert.deepEqual(result.todo, plans);
    assert.deepEqual(result.skip, []);
    assert.equal(result.diff.unknown, 1);
  }
});

// ---------------------------------------------------------------- stale 与 diff

test('stale 只报告「清单里有、本次扫描没有」的条目，且带 id 与 path（防：把用户本地文件删掉，或静默丢弃清单记录）', () => {
  const plans = [plan('a', [], 'a.pdf')];
  const manifest = {
    courseId: 'c',
    version: 1,
    updatedAt: 1,
    files: { a: record('a', 'a.pdf', 10, 'done'), gone: record('gone', 'Week 9/old.pdf', 20, 'done') }
  };
  const result = planSkips({ plans, manifest, existingPaths: new Map([['a.pdf', 10]]) });
  assert.deepEqual(result.stale, [{ id: 'gone', path: 'Week 9/old.pdf' }]);
  assert.equal(result.diff.stale, 1);
});

test('diff 计数：added/changed/unchanged/stale/total 各自口径（防：摘要说「全部完成」，其实少下了文件）', () => {
  const plans = [
    plan('fresh', [], 'new.pdf'), // 清单里没有 → added
    plan('same', [], 'same.pdf', 100, '/rid/2/xid-2'), // done、href 与 path 都相等 → unchanged
    plan('moved', [], 'moved.pdf', 300, '/rid/3/xid-3') // 版本指纹变了 → changed
  ];
  const manifest = {
    courseId: 'c',
    version: 2,
    updatedAt: 1,
    files: {
      same: record('same', 'same.pdf', 100, 'done', '/rid/2/xid-2'),
      moved: record('moved', 'moved.pdf', 200, 'done', '/rid/3/xid-1'),
      gone: record('gone', 'gone.pdf', 10, 'done', '/rid/9/xid-9')
    }
  };
  const result = planSkips({ plans, manifest, existingPaths: new Map() });
  assert.deepEqual(result.diff, { added: 1, changed: 1, moved: 0, unchanged: 1, stale: 1, unknown: 0, total: 3 });
});

test('diff 三个桶必须是本次计划的完整划分：added + changed + unchanged === total（防：某个文件两头不算，N 个数对不上）', () => {
  // 契约 §7 之后口径扩成五桶（moved / unknown），这条用例的意图不变：不允许有文件两头都不算。
  const plans = [plan('a', [], 'a.pdf'), plan('b', [], 'b.pdf', 5), plan('c', ['X'], 'c.pdf', 6)];
  const manifest = {
    courseId: 'c',
    version: 1,
    updatedAt: 1,
    files: { b: record('b', 'b.pdf', 5, 'done'), c: record('c', 'X/c.pdf', 9, 'partial') }
  };
  const { diff } = planSkips({ plans, manifest, existingPaths: new Map([['b.pdf', 5]]) });
  assert.equal(diff.added + diff.changed + diff.moved + diff.unchanged + diff.unknown, diff.total);
  assert.equal(diff.total, 3);
});

// ---------------------------------------------------------------- 健壮性

test('不修改任何入参（防：planSkips 顺手改了清单/结果对象，下一轮判断全错且无从排查）', () => {
  const plans = [plan('a', ['Week 3'], 'slides.pdf', 100)];
  const manifest = { courseId: 'c', version: 1, updatedAt: 1, files: { a: record('a', 'Week 3/slides.pdf', 100, 'done') } };
  const existingPaths = new Map([['Week 3/slides.pdf', 100]]);
  const before = [snapshot(plans), snapshot(manifest), snapshot(Array.from(existingPaths.entries()))];
  planSkips({ plans, manifest, existingPaths });
  const after = [snapshot(plans), snapshot(manifest), snapshot(Array.from(existingPaths.entries()))];
  assert.deepEqual(after, before);
});

test('空入参 / 缺字段不抛，返回空数组和全零 diff（防：扫描失败时把整个选择对话框带崩）', () => {
  for (const input of [undefined, {}, { plans: null, manifest: null, existingPaths: null }]) {
    const result = planSkips(input);
    assert.deepEqual(result.todo, []);
    assert.deepEqual(result.skip, []);
    assert.deepEqual(result.stale, []);
    assert.deepEqual(result.diff, EMPTY_DIFF);
  }
});

// ---------------------------------------------------------------- updateRecords / recordFromPlan

test('updateRecords 不改入参（防：500ms 节流合并把上一版清单原地改掉，出错时无法回滚）', () => {
  const previous = { courseId: 'c', version: 1, updatedAt: 1, files: { a: record('a', 'a.pdf', 10, 'partial') } };
  const plans = [plan('a', [], 'a.pdf')];
  const results = [{ id: 'a', status: 'done', size: 10 }];
  const before = [snapshot(previous), snapshot(plans), snapshot(results)];
  const next = updateRecords(previous, plans, results, 500);
  assert.deepEqual([snapshot(previous), snapshot(plans), snapshot(results)], before);
  assert.notEqual(next.files, previous.files);
  assert.notEqual(next.files.a, previous.files.a);
});

test('updateRecords 按 id 合并并补上 plan 的 path/name（防：进度回调只给 {id,status,size}，清单里没有路径，下次无法按路径跳过）', () => {
  const plans = [plan('a', ['Week 3'], 'slides.pdf')];
  const next = updateRecords(null, plans, [{ id: 'a', status: 'done', size: 1234 }], 900);
  assert.equal(next.files.a.path, 'Week 3/slides.pdf');
  assert.equal(next.files.a.name, 'slides.pdf');
  assert.equal(next.files.a.size, 1234);
  assert.equal(next.files.a.status, 'done');
  assert.equal(next.files.a.updatedAt, 900);
  assert.equal(next.updatedAt, 900);
  // 契约 §5：写回统一 version 2（读到 v1 也升级），v1 记录本体保留。
  assert.equal(next.version, 2);
});

test('大小未知时写 null，绝不写 0（防：用 0 表达未知，「同名同大小」判定会把空文件当成所有文件）', () => {
  const plans = [plan('a', [], 'a.pdf')];
  const next = updateRecords(null, plans, [{ id: 'a', status: 'done', size: undefined }], 1);
  assert.equal(next.files.a.size, null);
  assert.equal(recordFromPlan(plans[0], { status: 'done', size: null, now: 1 }).size, null);
  assert.equal(recordFromPlan(plans[0], { status: 'done', size: NaN, now: 1 }).size, null);
  assert.equal(recordFromPlan(plans[0], { status: 'done', size: 0, now: 1 }).size, 0);
});

test('未知 / 缺失的 status 归为 failed，不会被当成完成跳过（防：脏状态让半截文件混进「已完成」）', () => {
  const plans = [plan('a', [], 'a.pdf')];
  for (const status of [undefined, null, '', 'DONE', 'ok']) {
    const rec = recordFromPlan(plans[0], { status, size: 1, now: 1 });
    assert.equal(rec.status, 'failed', String(status) + ' 不该被保留');
    const result = planSkips({
      plans,
      manifest: { courseId: 'c', version: 1, updatedAt: 1, files: { a: { ...rec, status: rec.status } } },
      existingPaths: new Map()
    });
    assert.equal(result.skip.length, 0);
  }
});
