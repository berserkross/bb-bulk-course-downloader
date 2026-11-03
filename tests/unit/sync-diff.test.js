import test from 'node:test';
import assert from 'node:assert/strict';

import { planSkips } from '../../src/store/manifest-plan.js';
import { recordFromPlan, updateRecords } from '../../src/store/manifest.js';

/** 契约见 docs/sync-contract.md §3 / §4 / §9。本文件专门守增量同步的 6 条验收不变量。 */

/** planBatch 形状的计划：落盘相对路径 = segments.concat(fileName).join('/')。 */
function plan(id, segments, fileName, size, href) {
  const entry = { id, name: fileName, folderPath: segments };
  if (size !== undefined) entry.size = size;
  if (href !== undefined) entry.href = href;
  return { entry, segments, fileName };
}

function record(id, path, size, status, href) {
  const rec = { id, path, name: path.split('/').pop(), size, status, updatedAt: 1 };
  if (href !== undefined) rec.href = href;
  return rec;
}

/** existing.js 的 truncated 是非枚举属性，只能这样造出来。 */
function diskMap(entries, truncated) {
  const found = new Map(entries || []);
  if (truncated !== undefined) {
    Object.defineProperty(found, 'truncated', { value: truncated, enumerable: false, writable: true, configurable: true });
  }
  return found;
}

function manifestOf(files) {
  return { courseId: '_101_1', version: 2, updatedAt: 1, files };
}

const HREF_A = '/bbcswebdav/pid-633912-dt-content-rid-12071526_1/xid-12071526_1';
const HREF_B = '/bbcswebdav/pid-633912-dt-content-rid-12071526_1/xid-12071599_1';

function snapshot(value) {
  return JSON.stringify(value);
}

// ---------------------------------------------------------------- 不变量 1：幂等

test('不变量 1 同一份扫描结果连扫两次：第二次 changed / added / moved 全为 0（防：每次「同步」都把全部文件重下一遍，用户流量被烧光）', () => {
  const plans = [
    plan('doc-1', ['Week 1'], 'slides.pdf', 100, HREF_A),
    plan('doc-2', ['Week 1'], 'notes.pdf', 200, HREF_B)
  ];
  const first = planSkips({ plans, manifest: null, existingPaths: diskMap() });
  assert.deepEqual(first.diff, { added: 2, changed: 0, moved: 0, unchanged: 0, stale: 0, unknown: 0, total: 2 });
  assert.equal(first.todo.length, 2);

  // 第二次：清单由第一轮的结果落库而来（version 2，带 href）。
  const files = {};
  for (const p of plans) files[p.entry.id] = recordFromPlan(p, { status: 'done', size: p.entry.size, now: 2 });
  const second = planSkips({ plans, manifest: manifestOf(files), existingPaths: diskMap() });

  assert.equal(second.diff.changed, 0, '第二次不该再有 changed');
  assert.equal(second.diff.added, 0, '第二次不该再有 added');
  assert.equal(second.diff.moved, 0, '第二次不该再有 moved');
  assert.equal(second.diff.unchanged, 2);
  assert.equal(second.todo.length, 0);
  assert.deepEqual(second.skip.map((s) => s.reason), ['manifest-unchanged', 'manifest-unchanged']);
});

test('不变量 1 的磁盘版本：连扫两次且磁盘上有同名同大小的文件，第二次仍然一个都不下（防：FSA 环境反而比无 FSA 更爱重下）', () => {
  const plans = [plan('doc-1', ['Week 1'], 'slides.pdf', 100, HREF_A)];
  const files = { 'doc-1': record('doc-1', 'Week 1/slides.pdf', 100, 'done', HREF_A) };
  const disk = diskMap([['Week 1/slides.pdf', 100]]);
  const first = planSkips({ plans, manifest: manifestOf(files), existingPaths: disk });
  const second = planSkips({ plans, manifest: manifestOf(files), existingPaths: disk });
  for (const result of [first, second]) {
    assert.equal(result.diff.changed, 0);
    assert.equal(result.diff.added, 0);
    assert.equal(result.diff.moved, 0);
    assert.equal(result.todo.length, 0);
    assert.equal(result.skip[0].reason, 'disk');
  }
});

// ---------------------------------------------------------------- 不变量 2：v1 记录不得算「未变」

test('不变量 2 缺失 href 的 v1 记录不得判为 unchanged，也不得当作 manifest-unchanged（防：v1 迁移过来的清单被当成「全部未变」，用户永远拿不到新课件）', () => {
  const plans = [plan('doc-1', ['Week 1'], 'slides.pdf', 100, HREF_A)];
  const v1 = record('doc-1', 'Week 1/slides.pdf', 100, 'done'); // 没有 href 字段
  const result = planSkips({ plans, manifest: manifestOf({ 'doc-1': v1 }), existingPaths: diskMap() });

  assert.equal(result.diff.unchanged, 0, 'v1 记录不许进 unchanged');
  assert.equal(result.diff.unknown, 1, 'v1 记录要计进 unknown');
  assert.ok(result.skip.every((s) => s.reason !== 'manifest-unchanged'), 'v1 记录不许冒充强证据跳过');
  // 裁决 Q2（契约 §4 为准）：「弱证据跳过」已停用——无 FSA 的浏览器上，一份上游改过但字节数
  // 没变的课件会被永久静默跳过且 href 永远写不进去；改成降级未知只多下一次，一轮后自愈。
  // 'manifest' 字符串仍留在 reason 联合类型里，仅为兼容既有 UI 映射，planSkips 不再产生它。
  assert.equal(result.skip.length, 0, 'v1 记录不许再走弱证据跳过');
  assert.equal(result.todo.length, 1);
  assert.equal(result.todo[0], plans[0]);
});

test('不变量 2 的补集：本次 entry.href 与清单 href 都非空且相等才算 manifest-unchanged（防：两侧都缺 href 时被当成相等）', () => {
  const withHref = planSkips({
    plans: [plan('doc-1', [], 'a.pdf', 10, HREF_A)],
    manifest: manifestOf({ 'doc-1': record('doc-1', 'a.pdf', 10, 'done', HREF_A) }),
    existingPaths: diskMap()
  });
  assert.equal(withHref.skip[0].reason, 'manifest-unchanged');

  const bothMissing = planSkips({
    plans: [plan('doc-1', [], 'a.pdf', 10)],
    manifest: manifestOf({ 'doc-1': record('doc-1', 'a.pdf', 10, 'done') }),
    existingPaths: diskMap()
  });
  assert.equal(bothMissing.skip.length, 0, '两侧都没有 href 时不许跳过');
  assert.equal(bothMissing.todo.length, 1);
  assert.equal(bothMissing.diff.unchanged, 0);
  assert.equal(bothMissing.diff.unknown, 1);
});

// ---------------------------------------------------------------- 不变量 3：stale 只提示

test('不变量 3 stale 只出现在返回值里：不进 todo / skip，不改任何入参，返回值里没有任何删除通道（防：一次「同步」把用户本地文件删掉）', () => {
  const plans = [plan('doc-1', [], 'keep.pdf', 10, HREF_A)];
  const manifest = manifestOf({
    'doc-1': record('doc-1', 'keep.pdf', 10, 'done', HREF_A),
    'doc-gone': record('doc-gone', 'Week 9/old.pdf', 20, 'done', HREF_B)
  });
  const disk = diskMap();
  const before = [snapshot(plans), snapshot(manifest), snapshot(Array.from(disk.entries()))];

  const result = planSkips({ plans, manifest, existingPaths: disk });

  assert.deepEqual(result.stale, [{ id: 'doc-gone', path: 'Week 9/old.pdf' }]);
  assert.equal(result.diff.stale, 1);
  const touchedIds = result.todo.concat(result.skip.map((s) => s.plan)).map((p) => p.entry.id);
  assert.ok(!touchedIds.includes('doc-gone'), 'stale 条目不许混进 todo / skip');
  assert.deepEqual(Object.keys(result).sort(), ['changedPaths', 'diff', 'skip', 'stale', 'todo'], '返回值不得带任何删除/清理入口');
  assert.deepEqual(result.stale.map((s) => Object.keys(s).sort()), [['id', 'path']]);
  assert.deepEqual([snapshot(plans), snapshot(manifest), snapshot(Array.from(disk.entries()))], before, 'stale 不许写回入参');
});

// ---------------------------------------------------------------- 不变量 4：truncated / 扫描失败不得算「未变」

test('不变量 4 磁盘比对被截断且该 path 不在磁盘 Map 里 → 降级 manifest-unknown 进 todo，绝不进 unchanged（防：只比对了前 5000 个文件，剩下的全被当成「已同步」）', () => {
  const plans = [plan('doc-1', ['Week 1'], 'slides.pdf', 100, HREF_A)];
  const manifest = manifestOf({ 'doc-1': record('doc-1', 'Week 1/slides.pdf', 100, 'done', HREF_A) });

  const control = planSkips({ plans, manifest, existingPaths: diskMap() });
  assert.equal(control.skip[0].reason, 'manifest-unchanged');
  assert.equal(control.diff.unchanged, 1);

  const truncated = planSkips({ plans, manifest, existingPaths: diskMap([], true) });
  assert.equal(truncated.diff.unchanged, 0, 'truncated 时不许出现 unchanged');
  assert.equal(truncated.diff.unknown, 1);
  assert.equal(truncated.todo.length, 1);
  assert.equal(truncated.skip.length, 0);
});

test('不变量 4 本轮扫描有失败文件夹（scanFailed）→ 受影响条目降级为未知进 todo，绝不进 unchanged（防：扫描失败被当成「文件真的没了」或「文件真的没变」）', () => {
  const plans = [plan('doc-1', ['Week 1'], 'slides.pdf', 100, HREF_A)];
  const manifest = manifestOf({ 'doc-1': record('doc-1', 'Week 1/slides.pdf', 100, 'done', HREF_A) });

  const failed = planSkips({ plans, manifest, existingPaths: diskMap(), scanFailed: true });
  assert.equal(failed.diff.unchanged, 0);
  assert.equal(failed.diff.unknown, 1);
  assert.equal(failed.todo.length, 1);
  assert.equal(failed.skip.length, 0);

  // 磁盘上有这个文件但两边大小都不知道：截断时同样不能凭「同名」宣称未变。
  const unverified = planSkips({
    plans,
    manifest: manifestOf({ 'doc-1': record('doc-1', 'Week 1/slides.pdf', null, 'done', HREF_A) }),
    existingPaths: diskMap([['Week 1/slides.pdf', null]], true)
  });
  assert.equal(unverified.diff.unchanged, 0);
  assert.equal(unverified.todo.length, 1, 'truncated + 大小无法核实 → 重下');
});

// ---------------------------------------------------------------- 不变量 5：partial / failed 一律重下

test('不变量 5 partial / failed 状态的记录必须进 todo，且绝不计入未变（防：下了一半的录屏被当成已完成，用户拿到半截文件还以为成功）', () => {
  for (const status of ['partial', 'failed']) {
    const plans = [plan('doc-1', ['Week 1'], 'slides.pdf', 100, HREF_A)];
    const manifest = manifestOf({ 'doc-1': record('doc-1', 'Week 1/slides.pdf', 100, status, HREF_A) });
    const result = planSkips({ plans, manifest, existingPaths: diskMap() });
    assert.equal(result.todo.length, 1, status + ' 必须重下');
    assert.equal(result.todo[0], plans[0]);
    assert.equal(result.skip.length, 0, status + ' 不许出现在 skip 里');
    assert.equal(result.diff.unchanged, 0, status + ' 不许算未变');
    assert.equal(result.diff.changed, 0, status + ' 不是上游变更，不许计进 changed');
    assert.equal(result.diff.unknown, 1, status + ' 是「我们没把握」，计 unknown');

    // 磁盘上有同名文件但清单说没完成：仍然重下（磁盘分支的既有数据红线）。
    const onDisk = planSkips({ plans, manifest, existingPaths: diskMap([['Week 1/slides.pdf', null]]) });
    assert.equal(onDisk.todo.length, 1, status + ' + 磁盘同名残骸 → 必须重下');
  }
});

// ---------------------------------------------------------------- 不变量 6：URL query 不外泄

test('不变量 6 返回的 diff / stale / skip 原因里不含任何 URL（含 query），entry.href 只进清单（防：带签名的下载地址被写进对话框或日志）', () => {
  const plans = [
    plan('doc-1', ['Week 1'], 'slides.pdf', 100, '/bbcswebdav/pid-1-dt-content-rid-11_1/xid-11_1?token=SECRET'),
    plan('doc-2', ['Week 1'], 'notes.pdf', 200, '/bbcswebdav/pid-2-dt-content-rid-22_1/xid-22_1?token=SECRET')
  ];
  const manifest = manifestOf({
    'doc-1': record('doc-1', 'Week 1/slides.pdf', 100, 'done', '/bbcswebdav/pid-1-dt-content-rid-11_1/xid-11_9?token=OLD'),
    'doc-gone': record('doc-gone', 'Week 9/old.pdf', 20, 'done', '/bbcswebdav/pid-9?token=OLD')
  });
  const result = planSkips({ plans, manifest, existingPaths: diskMap([], true) });

  // 口径（Q3）：planSkips 自己产出的字段——diff 的全部键值、stale 的全部值、每个 skip[].reason——
  // 单独序列化后都不许含 'http' 与 '?'。skip[].plan 是调用方对象的引用（既有用例钉住），不在口径内。
  // 对照组：一次真正产生跳过的扫描，用来覆盖 skip[].reason 这一面。
  const reasonControl = planSkips({
    plans: [plan('doc-3', [], 'c.pdf', 1, HREF_A)],
    manifest: manifestOf({ 'doc-3': record('doc-3', 'c.pdf', 1, 'done', HREF_A) }),
    existingPaths: diskMap()
  });
  assert.deepEqual(reasonControl.skip.map((s) => s.reason), ['manifest-unchanged'], '对照组必须真的跳过一次');

  const surfaces = [
    JSON.stringify(result.diff),
    JSON.stringify(result.stale),
    JSON.stringify(result.skip.map((s) => ({ reason: s.reason, size: s.size }))),
    JSON.stringify(reasonControl.skip.map((s) => s.reason)),
    JSON.stringify(reasonControl.diff)
  ];
  for (const text of surfaces) {
    assert.ok(!text.includes('?'), '返回字段不许带 query：' + text);
    assert.ok(!text.toLowerCase().includes('http'), '返回字段不许带 URL：' + text);
    assert.ok(!text.includes('token='), '返回字段不许带 query 参数：' + text);
  }
  // 版本指纹只允许留在清单记录里（recordFromPlan），不进 diff / stale。
  assert.equal('href' in result.diff, false);
  assert.equal('href' in (result.stale[0] || {}), false);
  // 说明（契约自相矛盾的已知点）：skip[].plan 是调用方自己传进来的对象引用（既有用例
  // 断言 skip[0].plan === plans[0]），所以 skip[].plan.entry.href 天然带着原始 href；
  // planSkips 不新增任何 href / url 字段，也绝不把 href 拷进返回值自己的字段里。
  assert.equal(result.skip.length, 0);
});

// ---------------------------------------------------------------- 五分类本身

test('五分类 changed：href 不等 → 进 todo 覆盖重下，old path 与 new path 相同时也不许跳过（防：上游覆盖上传后用户拿到的还是旧版 PDF）', () => {
  const plans = [plan('doc-1', ['Week 1'], 'slides.pdf', 100, HREF_B)];
  const manifest = manifestOf({ 'doc-1': record('doc-1', 'Week 1/slides.pdf', 100, 'done', HREF_A) });
  const result = planSkips({ plans, manifest, existingPaths: diskMap() });
  assert.equal(result.todo.length, 1);
  assert.equal(result.diff.changed, 1);
  assert.equal(result.diff.unchanged, 0);
  assert.deepEqual(result.stale, []);
});

test('五分类 moved：href 相等但路径不等 → 进 todo 按新路径下载，且不在 stale 里重复记一次（防：改名后既重下又给用户弹一条假的「疑似删除」）', () => {
  const plans = [plan('doc-1', ['Week 2'], 'slides.pdf', 100, HREF_A)];
  const manifest = manifestOf({ 'doc-1': record('doc-1', 'Week 1/slides.pdf', 100, 'done', HREF_A) });
  const result = planSkips({ plans, manifest, existingPaths: diskMap() });
  assert.equal(result.todo.length, 1);
  assert.equal(result.diff.moved, 1);
  assert.equal(result.diff.unchanged, 0);
  assert.equal(result.diff.changed, 0);
  assert.deepEqual(result.stale, [], 'moved 的条目本次扫描里有，不算 stale');
});

test('五分类 added 与 unknown：清单无此 id → added 进 todo；本次 entry.href 为空 → unknown 进 todo（防：拿不到版本指纹却冒充「未变」）', () => {
  const fresh = planSkips({ plans: [plan('doc-new', [], 'a.pdf', 1, HREF_A)], manifest: manifestOf({}), existingPaths: diskMap() });
  assert.equal(fresh.diff.added, 1);
  assert.equal(fresh.todo.length, 1);

  const noHref = planSkips({
    plans: [plan('doc-1', [], 'a.pdf', 1)],
    manifest: manifestOf({ 'doc-1': record('doc-1', 'a.pdf', 1, 'done', HREF_A) }),
    existingPaths: diskMap()
  });
  assert.equal(noHref.diff.unknown, 1);
  assert.equal(noHref.diff.unchanged, 0);
  assert.equal(noHref.todo.length, 1);
  assert.equal(noHref.skip.length, 0);
});

// ---------------------------------------------------------------- Q1：href 是权威证据，优先于磁盘物理证据

test('Q1 href 不等 + 磁盘上恰有同名同大小文件 → 必须 todo/changed，不许 skip/disk（防：上游覆盖上传过、字节数却巧合相同，旧文件被永久当作未变，预览还显示「未变」）', () => {
  const plans = [plan('doc-1', ['Week 1'], 'slides.pdf', 100, HREF_B)];
  const manifest = manifestOf({ 'doc-1': record('doc-1', 'Week 1/slides.pdf', 100, 'done', HREF_A) });
  const result = planSkips({ plans, manifest, existingPaths: diskMap([['Week 1/slides.pdf', 100]]) });

  assert.equal(result.skip.length, 0, 'href 已变，磁盘同大小是巧合，不许据此跳过');
  assert.equal(result.todo.length, 1);
  assert.equal(result.todo[0], plans[0]);
  assert.equal(result.diff.changed, 1);
  assert.equal(result.diff.unchanged, 0);
});

test('Q1 反向：href 相等 + 磁盘大小相等 → 仍然 skip/disk 且计 unchanged（防：守卫把绝大多数正常跳过一起打掉，每次回来全量重下）', () => {
  const plans = [plan('doc-1', ['Week 1'], 'slides.pdf', 100, HREF_A)];
  const manifest = manifestOf({ 'doc-1': record('doc-1', 'Week 1/slides.pdf', 100, 'done', HREF_A) });
  const result = planSkips({ plans, manifest, existingPaths: diskMap([['Week 1/slides.pdf', 100]]) });

  assert.equal(result.todo.length, 0);
  assert.equal(result.skip.length, 1);
  assert.equal(result.skip[0].reason, 'disk');
  assert.equal(result.diff.unchanged, 1);
  assert.equal(result.diff.changed, 0);
});

// ---------------------------------------------------------------- Q2：降级未知靠下一轮写入 href 自愈

test('Q2 v1 记录重下一次即自愈：第一轮 todo/unknown，结果写回清单后第二轮就是 manifest-unchanged（防：降级未知退化成永久重下）', () => {
  const plans = [plan('doc-1', ['Week 1'], 'slides.pdf', 100, HREF_A)];
  const v1 = manifestOf({ 'doc-1': record('doc-1', 'Week 1/slides.pdf', 100, 'done') }); // 没有 href 字段

  const first = planSkips({ plans, manifest: v1, existingPaths: diskMap() });
  assert.equal(first.todo.length, 1);
  assert.equal(first.diff.unknown, 1);
  assert.equal(first.skip.length, 0);

  const healed = updateRecords(v1, plans, [{ id: 'doc-1', status: 'done', size: 100 }], 2);
  const second = planSkips({ plans, manifest: healed, existingPaths: diskMap() });
  assert.equal(second.todo.length, 0, '一轮后必须自愈');
  assert.deepEqual(second.skip.map((s) => s.reason), ['manifest-unchanged']);
  assert.equal(second.diff.unknown, 0);
});

// ---------------------------------------------------------------- Q4：状态桶口径（没下完 ≠ 上游变更）

test('Q4 partial / failed 的重下计进 unknown 而非 changed（防：预览跟用户说「变更 N 个」，真实情况是上次下坏了）', () => {
  for (const status of ['partial', 'failed']) {
    const plans = [plan('doc-1', ['Week 1'], 'slides.pdf', 100, HREF_A)];
    const manifest = manifestOf({ 'doc-1': record('doc-1', 'Week 1/slides.pdf', 100, status, HREF_A) });

    const manifestOnly = planSkips({ plans, manifest, existingPaths: diskMap() });
    assert.equal(manifestOnly.todo.length, 1);
    assert.equal(manifestOnly.diff.changed, 0, status + ' 不许计进 changed');
    assert.equal(manifestOnly.diff.unknown, 1, status + ' 要计进 unknown');

    // 磁盘上有同名文件但大小无法核实：同样不是「变更」。
    const onDisk = planSkips({ plans, manifest, existingPaths: diskMap([['Week 1/slides.pdf', null]]) });
    assert.equal(onDisk.todo.length, 1);
    assert.equal(onDisk.diff.changed, 0);
    assert.equal(onDisk.diff.unknown, 1);

    // 磁盘大小与清单不一致：也不是「上游变更」，是上一轮没下完。
    const mismatched = planSkips({ plans, manifest, existingPaths: diskMap([['Week 1/slides.pdf', 90]]) });
    assert.equal(mismatched.todo.length, 1);
    assert.equal(mismatched.diff.changed, 0);
    assert.equal(mismatched.diff.unknown, 1);
  }
});

test('Q4 五桶恒等式在混合批次上成立：added + changed + moved + unchanged + unknown === total（防：某个文件两头不算，N 个数对不上）', () => {
  const plans = [
    plan('add', [], 'new.pdf', 10, HREF_A),
    plan('same', [], 'same.pdf', 10, HREF_A),
    plan('chg', [], 'chg.pdf', 10, HREF_B),
    plan('mv', ['Week 2'], 'mv.pdf', 10, HREF_A),
    plan('bad', [], 'bad.pdf', 10, HREF_A),
    plan('unk', [], 'unk.pdf', 10)
  ];
  const manifest = manifestOf({
    same: record('same', 'same.pdf', 10, 'done', HREF_A),
    chg: record('chg', 'chg.pdf', 10, 'done', HREF_A),
    mv: record('mv', 'Week 1/mv.pdf', 10, 'done', HREF_A),
    bad: record('bad', 'bad.pdf', 10, 'partial', HREF_A),
    unk: record('unk', 'unk.pdf', 10, 'done', HREF_A)
  });
  const { diff } = planSkips({ plans, manifest, existingPaths: diskMap() });
  assert.deepEqual(diff, { added: 1, changed: 1, moved: 1, unchanged: 1, stale: 0, unknown: 2, total: 6 });
});

// ---------------------------------------------------------------- 清单写入层

test('recordFromPlan 记录形状 = 契约 §5：{ id, href, path, name, size|null, status, updatedAt }，href 取 entry.href 并 trim（防：自己从 url 反推指纹，或者写进 undefined 让下游 JSON 丢字段）', () => {
  const rec = recordFromPlan(plan('doc-1', ['Week 1'], 'slides.pdf', 100, '  ' + HREF_A + '  '), { status: 'done', size: 100, now: 7 });
  assert.deepEqual(rec, {
    id: 'doc-1',
    href: HREF_A,
    path: 'Week 1/slides.pdf',
    name: 'slides.pdf',
    size: 100,
    status: 'done',
    updatedAt: 7
  });
  assert.deepEqual(Object.keys(rec), ['id', 'href', 'path', 'name', 'size', 'status', 'updatedAt']);
  assert.equal(recordFromPlan(plan('doc-1', [], 'a.pdf'), { status: 'done', size: null, now: 1 }).href, '', '缺失 href 必须写空串');
  assert.equal(recordFromPlan(null, { status: 'done', now: 1 }).href, '');
});

test('updateRecords 写 version 2、带上 href，并在 plan 缺席时保留上一版 href（防：进度回调只带 {id,status,size} 时把版本指纹抹掉，下次判定退化成 v1 未知）', () => {
  const plans = [plan('doc-1', ['Week 1'], 'slides.pdf', 100, HREF_B)];
  const v1 = { courseId: 'c', version: 1, updatedAt: 1, files: { 'doc-1': record('doc-1', 'Week 1/slides.pdf', 100, 'partial') } };

  const next = updateRecords(v1, plans, [{ id: 'doc-1', status: 'done', size: 100 }], 900);
  assert.equal(next.version, 2, '读到 v1 也要升级成 2');
  assert.equal(next.files['doc-1'].href, HREF_B);
  assert.equal(next.files['doc-1'].status, 'done');
  assert.equal(v1.version, 1, '不许改入参');
  assert.equal('href' in v1.files['doc-1'], false, '不许改入参里的记录');

  // plan 缺席：保留上一版 href（与保留 path 的做法一致）。
  const keep = updateRecords(
    { courseId: 'c', version: 2, updatedAt: 1, files: { 'doc-9': { id: 'doc-9', href: HREF_A, path: 'old/a.pdf', name: 'a.pdf', size: 5, status: 'partial', updatedAt: 1 } } },
    [],
    [{ id: 'doc-9', status: 'failed', size: null }],
    901
  );
  assert.equal(keep.files['doc-9'].href, HREF_A);
  assert.equal(keep.files['doc-9'].path, 'old/a.pdf');
  assert.equal(keep.files['doc-9'].status, 'failed');
});

test('updateRecords 保留未被本次结果触及的 v1 记录（没有 href 字段也不删、不改状态）（防：一次合并把旧记录清空，或者给旧记录补个假 status）', () => {
  const untouched = record('doc-old', 'Week 9/old.pdf', 20, 'done'); // 无 href 的 v1 记录
  const next = updateRecords(
    { courseId: 'c', version: 1, updatedAt: 1, files: { 'doc-old': untouched } },
    [plan('doc-new', [], 'new.pdf', 1, HREF_A)],
    [{ id: 'doc-new', status: 'done', size: 1 }],
    5
  );
  assert.deepEqual(next.files['doc-old'], untouched, 'v1 记录必须原样保留');
  assert.equal(next.files['doc-new'].href, HREF_A);
  assert.equal(next.version, 2);
});

test('历史变更只列出版本变化或磁盘大小不符的条目', () => {
  const plans = ['version','size','new','old'].map(id => plan(id, [], id, 100, HREF_A));
  const result = planSkips({ plans, manifest: manifestOf({
    version: record('version','version',100,'done',HREF_B),
    size: record('size','size',100,'done',HREF_A),
    old: record('old','old',100,'failed',HREF_A)
  }), existingPaths: diskMap([['size', 12]]) });
  assert.deepEqual(result.changedPaths, [{ id: 'version', path: 'version' }, { id: 'size', path: 'size' }]);
  assert.equal(result.diff.changed, result.changedPaths.length);
});
