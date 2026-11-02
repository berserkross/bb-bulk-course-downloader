import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendScanHistory,
  exportManifestPack,
  importManifestPack,
  mergeManifests
} from '../../src/store/manifest.js';

/** 入参快照：四个函数都是纯函数，任何一个改入参都该在这里露出来。 */
function snapshot(value) {
  return JSON.stringify(value);
}

/** 一次扫描的统计快照（形状来自契约 §3）。 */
function scan(at, extra) {
  return {
    at,
    total: 10,
    added: 2,
    changed: 1,
    moved: 0,
    unchanged: 6,
    unknown: 1,
    stale: 1,
    changedPaths: [{ id: 'a' + at, path: 'Week 1/a' + at + '.pdf' }],
    ...extra
  };
}

function record(id, path, size, status, href) {
  const rec = { id, path, name: path.split('/').pop(), size, status, updatedAt: 1 };
  if (href !== undefined) rec.href = href;
  return rec;
}

/** done / failed / partial 各一条，size 覆盖 0 与 null 两种边界。 */
function sampleManifest() {
  return {
    courseId: 'eng-1002',
    version: 2,
    updatedAt: 900,
    files: {
      f1: record('f1', 'Week 1/slides.pdf', 1024, 'done', '/rid/1/xid-1'),
      f2: record('f2', 'Week 2/lab.pdf', null, 'failed', ''),
      f3: record('f3', 'Week 3/empty.txt', 0, 'partial', '/rid/3/xid-3')
    },
    scans: [{ at: 900, total: 3, added: 0, changed: 0, moved: 0, unchanged: 3, unknown: 0, stale: 0, changedPaths: [] }]
  };
}

/** 空清单底座：appendScanHistory 的其余用例只关心 scans。 */
function emptyManifest() {
  return { courseId: 'c', version: 2, updatedAt: 1, files: {}, scans: [] };
}

// ---------------------------------------------------------------- appendScanHistory

test('scans 默认只留最近 10 次且最新在前（防：历史无上限增长，清单迟早写不进 IndexedDB）', () => {
  let manifest = null;
  for (let i = 1; i <= 12; i += 1) manifest = appendScanHistory(manifest, scan(1000 + i));
  assert.equal(manifest.scans.length, 10);
  assert.deepEqual(
    manifest.scans.map((s) => s.at),
    [1012, 1011, 1010, 1009, 1008, 1007, 1006, 1005, 1004, 1003]
  );
});

test('cap 显式传值时按值截断，cap=0 表示不记历史（防：调用方要短历史却被默认 10 顶回去）', () => {
  const crowded = { ...emptyManifest(), scans: [scan(5), scan(4), scan(3), scan(2)] };
  const three = appendScanHistory(crowded, scan(6), 3);
  assert.deepEqual(three.scans.map((s) => s.at), [6, 5, 4]);
  assert.equal(crowded.scans.length, 4, '入参的 scans 不许被改');
  assert.equal(appendScanHistory(emptyManifest(), scan(7), 0).scans.length, 0);
  assert.equal(appendScanHistory(emptyManifest(), scan(7), 1).scans.length, 1);
});

test('cap 是脏值（NaN / 负数 / 字符串 / null / Infinity）时回落默认 10（防：脏 cap 把 scans 写成负数或撑爆清单）', () => {
  const crowded = { ...emptyManifest(), scans: Array.from({ length: 12 }, (_, i) => scan(i)) };
  for (const cap of [NaN, -3, '3', null, Infinity]) {
    assert.equal(appendScanHistory(crowded, scan(99), cap).scans.length, 10, String(cap));
  }
});

test('计数非有限数 / 负数一律归 0，有限非负值原样保留（防：NaN 一路显示成「新增 NaN 条」）', () => {
  const next = appendScanHistory(emptyManifest(), {
    at: 5,
    total: NaN,
    added: -1,
    changed: '5',
    moved: Infinity,
    unchanged: undefined,
    unknown: null,
    stale: 3.5
  });
  const [entry] = next.scans;
  assert.equal(entry.at, 5);
  assert.deepEqual(
    {
      total: entry.total,
      added: entry.added,
      changed: entry.changed,
      moved: entry.moved,
      unchanged: entry.unchanged,
      unknown: entry.unknown,
      stale: entry.stale
    },
    { total: 0, added: 0, changed: 0, moved: 0, unchanged: 0, unknown: 0, stale: 3.5 }
  );
});

test('manifest / snapshot 缺失或脏值都不抛，返回的仍是可落库的形状（防：扫描收尾时一个 undefined 把整轮保存带崩）', () => {
  for (const [manifest, snap] of [
    [undefined, undefined],
    [null, null],
    ['oops', 42],
    [{}, []],
    [{ files: 'nope' }, { at: 'x' }]
  ]) {
    const next = appendScanHistory(manifest, snap);
    assert.equal(next.scans.length, 1);
    assert.deepEqual(next.files, {});
    assert.equal(next.version, 2);
    assert.deepEqual(next.scans[0].changedPaths, []);
    assert.equal(next.scans[0].added, 0);
    assert.equal(Number.isFinite(next.scans[0].at), true);
  }
});

test('changedPaths 只留 id 可用的条目，脏条目静默丢弃，id/path 一律字符串化（防：一条 null 让历史面板渲染时抛错）', () => {
  const next = appendScanHistory(emptyManifest(), {
    at: 1,
    changedPaths: [
      { id: 'a', path: 'Week 1/a.pdf' },
      null,
      'x',
      { id: '', path: 'no-id.pdf' },
      { path: 'only-path.pdf' },
      { id: 7, path: 9 }
    ]
  });
  assert.deepEqual(next.scans[0].changedPaths, [
    { id: 'a', path: 'Week 1/a.pdf' },
    { id: '7', path: '9' }
  ]);
});

test('appendScanHistory 不向 PDF 记录塞 scans，也不原地改上一版清单（防：每条文件记录被历史撑大，出错时无法回滚）', () => {
  const manifest = sampleManifest();
  const before = snapshot(manifest);
  const next = appendScanHistory(manifest, scan(2000));
  assert.equal(snapshot(manifest), before, '入参不许被改');
  assert.notEqual(next, manifest);
  assert.notEqual(next.scans, manifest.scans);
  assert.equal(next.scans.length, 2);
  assert.equal(next.scans[0].at, 2000);
  assert.equal(next.scans[1].at, 900, '老历史原样留在后面');
  assert.equal(next.files.f1.status, 'done');
  assert.equal('scans' in next.files, false, 'scans 与 files 平级');
  assert.equal(next.files.f1.scans, undefined);
  assert.equal(next.courseId, 'eng-1002');
});

// ---------------------------------------------------------------- exportManifestPack

test('exportManifestPack 固定 format/version，courses 里只有 courseId 与 files（防：缺少标识的包会被导入端一律拒收）', () => {
  const manifest = sampleManifest();
  const before = snapshot(manifest);
  const pack = exportManifestPack({ courseId: 'eng-1002', manifest, exportedAt: 12345 });
  assert.equal(pack.format, 'bbdl-manifest');
  assert.equal(pack.version, 1);
  assert.equal(pack.exportedAt, 12345);
  assert.equal(pack.courses.length, 1);
  assert.equal(pack.courses[0].courseId, 'eng-1002');
  assert.deepEqual(Object.keys(pack.courses[0]).sort(), ['courseId', 'files']);
  assert.equal(Object.keys(pack.courses[0].files).length, 3);
  assert.equal(snapshot(manifest), before, '入参不许被改');
  assert.notEqual(pack.courses[0].files.f1, manifest.files.f1, '导出不许把入参记录对象直接交出去');
  assert.equal('scans' in pack.courses[0].files, false, 'scans 不属于 files');
});

test('exportManifestPack 入参缺失（没有清单 / 没有 courseId）也不抛（防：在没扫过的课程上点导出就报错）', () => {
  const pack = exportManifestPack();
  assert.equal(pack.format, 'bbdl-manifest');
  assert.equal(pack.version, 1);
  assert.deepEqual(pack.courses, [{ courseId: '', files: {} }]);
  assert.equal(Number.isFinite(pack.exportedAt), true);
  assert.equal(exportManifestPack({ manifest: sampleManifest() }).courses[0].courseId, 'eng-1002', '没给 courseId 时用清单里的');
  assert.deepEqual(exportManifestPack({ manifest: { files: 'nope' } }).courses[0].files, {});
});

test('导出的记录字段是清洗后的固定形状（防：脏 status 通过导出被合法化，用户看到「已完成」其实从没下完）', () => {
  const pack = exportManifestPack({
    courseId: 'c',
    manifest: { courseId: 'c', files: { a: { id: 'a', status: 'weird', size: 'x', href: 1, path: null, name: undefined } } },
    exportedAt: 3
  });
  assert.deepEqual(pack.courses[0].files.a, {
    id: 'a',
    href: '1',
    path: '',
    name: '',
    size: null,
    status: 'failed',
    updatedAt: 3
  });
});

// ---------------------------------------------------------------- importManifestPack 拒绝路径

test('importManifestPack 对任何坏包都返回 ok:false + 一句中文原因，且绝不抛（防：用户选错一个 JSON 就把页面搞崩）', () => {
  const bad = [
    undefined,
    null,
    0,
    'x',
    [],
    {},
    { format: 'other', version: 1, courses: [{ courseId: 'c', files: {} }] },
    { format: 'bbdl-manifest', version: 2, courses: [{ courseId: 'c', files: {} }] },
    { format: 'bbdl-manifest', version: '1', courses: [{ courseId: 'c', files: {} }] },
    { format: 'bbdl-manifest', version: 1 },
    { format: 'bbdl-manifest', version: 1, courses: 'nope' },
    { format: 'bbdl-manifest', version: 1, courses: [] },
    { format: 'bbdl-manifest', version: 1, courses: [null] },
    { format: 'bbdl-manifest', version: 1, courses: ['c'] }
  ];
  for (const pack of bad) {
    const result = importManifestPack(pack, 5);
    assert.equal(result.ok, false, String(snapshot(pack)));
    assert.equal(typeof result.error, 'string');
    assert.match(result.error, /[\u4e00-\u9fa5]/, '报错必须是中文：' + result.error);
    assert.equal(/https?:|\?|query/i.test(result.error), false, '用户可见文案不许回显 URL / query：' + result.error);
    assert.equal(result.course, undefined);
    assert.equal(result.courses, undefined);
  }
});

// ---------------------------------------------------------------- importManifestPack 降级路径

test('importManifestPack 逐条清洗：status 脏值降 failed、size 脏值降 null、href 一律字符串（防：手改过的 JSON 把半截文件洗成已完成）', () => {
  const pack = {
    format: 'bbdl-manifest',
    version: 1,
    exportedAt: 1,
    courses: [
      {
        courseId: 'eng-1002',
        files: {
          f1: { id: 'f1', status: 'ok', size: 'abc', href: 42, path: 'Week 1/a.pdf', name: 'a.pdf', updatedAt: 'x' },
          f2: { id: 'f2', status: 'done', size: -5, href: null },
          f3: { id: 'f3', status: 'partial', size: 0 },
          f4: { status: 'DONE', size: NaN },
          f5: null,
          f6: 'nope'
        }
      }
    ]
  };
  const result = importManifestPack(pack, 7000);
  assert.equal(result.ok, true);
  assert.equal(result.course.courseId, 'eng-1002');
  const { manifest } = result.course;
  assert.equal(manifest.version, 2);
  assert.equal(manifest.updatedAt, 7000);
  assert.equal(manifest.courseId, 'eng-1002');
  assert.deepEqual(Object.keys(manifest.files).sort(), ['f1', 'f2', 'f3', 'f4'], '不是记录的条目直接丢');
  assert.equal(manifest.files.f1.status, 'failed');
  assert.equal(manifest.files.f1.size, null);
  assert.equal(manifest.files.f1.href, '42');
  assert.equal(manifest.files.f1.path, 'Week 1/a.pdf');
  assert.equal(manifest.files.f1.name, 'a.pdf');
  assert.equal(manifest.files.f1.updatedAt, 7000, '更新时间脏值用 now 兜底');
  assert.equal(manifest.files.f2.status, 'done');
  assert.equal(manifest.files.f2.size, null);
  assert.equal(manifest.files.f2.href, '');
  assert.equal(manifest.files.f3.size, 0, '0 是合法大小，绝不改写成 null');
  assert.equal(manifest.files.f3.status, 'partial');
  assert.equal(manifest.files.f4.status, 'failed');
  assert.equal(manifest.files.f4.id, 'f4', '记录上没有 id 时用 files 的键兜底');
  assert.deepEqual(manifest.scans, undefined);
});

test('importManifestPack 单课程给 course、多课程给 courses（防：两个课程的文件被混进同一份清单）', () => {
  const pack = exportManifestPack({ courseId: 'a', manifest: sampleManifest() });
  pack.courses.push({ courseId: 'b', files: { z: { id: 'z', status: 'done', size: 1 } } });
  const result = importManifestPack(pack, 1);
  assert.equal(result.ok, true);
  assert.equal(result.course, undefined);
  assert.equal(result.courses.length, 2);
  assert.deepEqual(result.courses.map((c) => c.courseId), ['a', 'b']);
  assert.equal(Object.keys(result.courses[0].manifest.files).length, 3);
  assert.deepEqual(Object.keys(result.courses[1].manifest.files), ['z']);
});

// ---------------------------------------------------------------- 往返一致

test('export -> JSON -> import 往返：files 数量与每条 status/size/href/path/name/updatedAt 都不变（防：导出导入一圈把已下的文件降级成待重下）', () => {
  const manifest = sampleManifest();
  const json = JSON.stringify(exportManifestPack({ courseId: 'eng-1002', manifest }));
  const result = importManifestPack(JSON.parse(json), 4242);
  assert.equal(result.ok, true);
  const back = result.course.manifest;
  assert.equal(back.courseId, 'eng-1002');
  assert.equal(back.version, 2);
  assert.equal(Object.keys(back.files).length, Object.keys(manifest.files).length);
  for (const id of Object.keys(manifest.files)) {
    assert.equal(back.files[id].status, manifest.files[id].status, id + ' 的 status 变了');
    assert.equal(back.files[id].size, manifest.files[id].size, id + ' 的 size 变了');
    assert.equal(back.files[id].href, manifest.files[id].href, id + ' 的 href 变了');
    assert.equal(back.files[id].path, manifest.files[id].path, id + ' 的 path 变了');
    assert.equal(back.files[id].name, manifest.files[id].name, id + ' 的 name 变了');
    assert.equal(back.files[id].updatedAt, manifest.files[id].updatedAt, id + ' 的 updatedAt 变了');
  }
});

test('往返后与空清单合并，已完成的记录仍是 done（防：导入路径把 status 洗成 failed，磁盘上那几 GB 文件被重下一遍）', () => {
  const manifest = sampleManifest();
  const pack = JSON.parse(JSON.stringify(exportManifestPack({ courseId: 'eng-1002', manifest })));
  const imported = importManifestPack(pack, 1);
  assert.equal(imported.ok, true);
  const merged = mergeManifests(null, imported.course.manifest);
  assert.equal(Object.keys(merged.files).length, 3);
  assert.equal(merged.files.f1.status, 'done');
  assert.equal(merged.files.f1.size, 1024);
  assert.equal(merged.files.f3.status, 'partial');
});

// ---------------------------------------------------------------- mergeManifests

test('mergeManifests：current 的 done 记录优先保留，其余用 incoming 覆盖（防：导入旧包把本地已下好的文件改成 failed）', () => {
  const current = {
    courseId: 'eng-1002',
    version: 2,
    updatedAt: 500,
    files: {
      keep: record('keep', 'Week 1/keep.pdf', 111, 'done', '/rid/k/xid-k'),
      retry: record('retry', 'Week 1/retry.pdf', 222, 'failed', '/rid/r/xid-r'),
      localOnly: record('localOnly', 'Week 9/local.pdf', 333, 'partial', '/rid/l/xid-l')
    },
    scans: [scan(400)]
  };
  const incoming = {
    courseId: 'eng-1002',
    version: 2,
    updatedAt: 900,
    files: {
      keep: record('keep', 'Week 1/keep.pdf', 999, 'failed', '/rid/k/xid-new'),
      retry: record('retry', 'Week 1/retry.pdf', 222, 'done', '/rid/r/xid-r'),
      fresh: record('fresh', 'Week 2/fresh.pdf', 444, 'done', '/rid/f/xid-f')
    }
  };
  const before = snapshot([current, incoming]);
  const merged = mergeManifests(current, incoming);
  assert.equal(snapshot([current, incoming]), before, '入参不许被改');
  assert.equal(merged.version, 2);
  assert.equal(merged.courseId, 'eng-1002');
  assert.equal(merged.updatedAt, 900, '取两边较新的时间戳');
  assert.equal(merged.files.keep.status, 'done', 'current 的 done 必须压住 incoming');
  assert.equal(merged.files.keep.size, 111, '保留的是 current 那条记录');
  assert.equal(merged.files.keep.href, '/rid/k/xid-k');
  assert.equal(merged.files.retry.status, 'done', 'current 没完成的用 incoming 覆盖');
  assert.equal(merged.files.fresh.size, 444, 'incoming 独有的记录要进来');
  assert.equal(merged.files.fresh.status, 'done');
  assert.equal(merged.files.localOnly.status, 'partial', 'incoming 里没有的本地记录不许凭空丢');
  assert.equal(merged.files.localOnly.path, 'Week 9/local.pdf');
});

test('mergeManifests 保留 current 的 scans（验收不变量 4：导入不许清空扫描历史）', () => {
  const current = { ...emptyManifest(), scans: [scan(9), scan(8)] };
  const incoming = { courseId: 'c', version: 2, updatedAt: 2, files: {}, scans: [scan(100), scan(101)] };
  const merged = mergeManifests(current, incoming);
  assert.deepEqual(merged.scans.map((s) => s.at), [9, 8]);
  assert.notEqual(merged.scans, current.scans, '返回的是副本');
  assert.deepEqual(current.scans.map((s) => s.at), [9, 8]);
  assert.deepEqual(mergeManifests(null, null).scans, []);
});

test('mergeManifests 入参缺失 / 脏值不抛，返回空 files 的 version 2 清单（防：本地清单还没落库时 null 直接炸掉导入）', () => {
  for (const [cur, inc] of [
    [undefined, undefined],
    [null, { files: { a: null } }],
    ['x', 'y'],
    [{ files: 'nope' }, { files: [] }]
  ]) {
    const merged = mergeManifests(cur, inc);
    assert.deepEqual(merged.files, {});
    assert.equal(merged.version, 2);
    assert.deepEqual(merged.scans, []);
    assert.equal(Number.isFinite(merged.updatedAt), true);
  }
});
