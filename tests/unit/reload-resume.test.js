import test from 'node:test';
import assert from 'node:assert/strict';

import { createController } from '../../src/index.js';
import { planSkips } from '../../src/store/manifest-plan.js';

const HREF = 'https://bb.example.edu/webapps/blackboard/content/listContent.jsp?course_id=_101_1&content_id=_202_1';
const COURSE = '_101_1';
const CONTENT = '_202_1';
/** 契约里的 sessionStorage 键（docs/m7-quiet.md §3.1）。 */
const INTENT_KEY = 'bbdl:resume-intent:v1';
/** 注入时钟：意图的 createdAt / 30 分钟过期判定都读它，测试不真等。 */
const NOW = 1700000000000;
const TTL_MS = 30 * 60 * 1000;

const ENTRIES = [
  { id: 'e1', name: 'a.pdf', size: 10, folderPath: [], url: 'https://bb.example.edu/f/1' },
  { id: 'e2', name: 'b.pdf', size: 20, folderPath: [], url: 'https://bb.example.edu/f/2' },
  { id: 'e3', name: 'c.pdf', size: 30, folderPath: [], url: 'https://bb.example.edu/f/3' },
  { id: 'e4', name: 'd.pdf', size: 40, folderPath: [], url: 'https://bb.example.edu/f/4' },
  { id: 'e5', name: 'e.pdf', size: 50, folderPath: [], url: 'https://bb.example.edu/f/5' }
];

function byIds(ids) {
  return ENTRIES.filter(function (entry) { return ids.includes(entry.id); });
}

function makePanel(withoutRecovering) {
  const calls = [];
  const api = { calls: calls, opts: null };
  const names = [
    'setState', 'setCount', 'setScanProgress', 'setDownloadProgress', 'setMode', 'setNotice',
    'setResume', 'setFiles', 'applyFileEvent', 'setHalted', 'clearHalted', 'showSummary',
    'rebind', 'fail', 'destroy'
  ];
  // 恢复态那两个方法是 S27 并行加的：故意有一组用例不给，验控制器是防御式调用。
  if (!withoutRecovering) names.push('setRecovering', 'clearRecovering');
  for (const name of names) {
    api[name] = function () {
      calls.push({ name: name, args: Array.prototype.slice.call(arguments) });
    };
  }
  api.countOf = function (name) {
    return calls.filter(function (call) { return call.name === name; }).length;
  };
  api.callsOf = function (name) {
    return calls.filter(function (call) { return call.name === name; });
  };
  api.texts = function (name) {
    return api.callsOf(name)
      .map(function (call) { return String(call.args[0] == null ? '' : call.args[0]); })
      .filter(Boolean);
  };
  return api;
}

/** sink 结果上的 halted 是不可枚举属性（shared.js:withHalted）：只能这样挂。 */
function withHiddenHalted(result, halted) {
  Object.defineProperty(result, 'halted', {
    value: halted, enumerable: false, writable: true, configurable: true
  });
  return result;
}

function haltedResult(ok, pending) {
  return withHiddenHalted(
    { ok: ok, failed: pending.slice(), aborted: false },
    { reason: 'session-expired', pending: pending, pendingCount: pending.length }
  );
}

function makeStore(handle) {
  return {
    available: true,
    async loadManifest() { return null; },
    async saveManifest() {},
    async mergeFiles() {},
    async clearManifest() {},
    async loadHandle() { return handle || null; },
    async saveHandle() {},
    async clearHandle() {}
  };
}

/** sessionStorage 的替身：意图读写必须走真实的键，不许只测注入的假对象。 */
function memoryIntent(seed) {
  let value = seed || null;
  const api = { writes: [], clears: 0 };
  api.read = function () { return value; };
  api.write = function (next) { api.writes.push(next); value = next; };
  api.clear = function () { api.clears += 1; value = null; };
  api.peek = function () { return value; };
  return api;
}

function installSessionStorage(seed) {
  const map = new Map();
  if (seed) map.set(INTENT_KEY, JSON.stringify(seed));
  globalThis.sessionStorage = {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
    get length() { return map.size; },
    key(index) { return Array.from(map.keys())[index] === undefined ? null : Array.from(map.keys())[index]; },
    clear() { map.clear(); }
  };
  return {
    raw(key) {
      const value = map.get(key === undefined ? INTENT_KEY : key);
      return value === undefined ? null : JSON.parse(value);
    },
    restore() { delete globalThis.sessionStorage; }
  };
}

function tick(times) {
  let chain = Promise.resolve();
  for (let i = 0; i < (times || 40); i += 1) {
    chain = chain.then(function () { return new Promise(function (resolve) { setImmediate(resolve); }); });
  }
  return chain;
}

/** 截获 [bbdl] 诊断：首参是字符串就留整行，其余原样不打印。 */
function captureInfo() {
  const original = console.info;
  const lines = [];
  console.info = function () {
    const args = Array.prototype.slice.call(arguments);
    if (typeof args[0] === 'string' && args[0].slice(0, 6) === '[bbdl]') lines.push(args);
  };
  return {
    lines: lines,
    tagged(tag) {
      return lines.filter(function (line) { return line[0] === tag; });
    },
    restore() { console.info = original; }
  };
}

/**
 * 控制器 + 全套可注入依赖。默认 settings 里 autoReload 不写（= 契约默认开），
 * 需要关掉的用例自己传 settings.autoReload = false。
 */
function setup(over) {
  const extra = over || {};
  const panel = makePanel(extra.withoutRecovering);
  const rounds = [];
  const delays = [];
  const reloads = [];
  const dialogs = [];
  const picks = [];
  const scans = [];
  const permRequests = [];
  // useSessionStorage：不给注入 —— 让控制器走它自己的 sessionStorage 实现（AC1 验的就是真键）。
  const intentStore = extra.useSessionStorage
    ? undefined
    : (extra.intentStore || memoryIntent(extra.intent));
  const controller = createController({
    store: makeStore(extra.handle),
    // 盘上已有的文件由用例决定：AC13 用它证明重载续跑不会把已经下完的再下一遍。
    listExistingFiles: async function () {
      return extra.existing instanceof Map ? new Map(extra.existing) : [];
    },
    pickDirectory: async function () { picks.push('pickDirectory'); return null; },
    openSelectDialog: async function (entries) {
      dialogs.push(entries.length);
      return { entries: extra.selected || entries, dirHandle: extra.handle || null, expectedBytes: 0, skipExisting: false };
    },
    mountPanel: function (options) {
      panel.opts = options;
      return panel;
    },
    settings: Object.assign({ preserveTree: true, downloadConcurrency: 2, autoResumeMax: 3 }, extra.settings || {}),
    location: { href: HREF },
    document: null,
    deps: {
      // 生产路径由 mount() 注入；不注入时 index.js 走降级分支（全部重下），AC13 要的是真判定。
      planSkips: extra.planSkips,
      createScanner: function () {
        return { async scan() { scans.push('scan'); return extra.entries || ENTRIES; } };
      },
      createSink: async function () {
        return {
          kind: 'zip',
          async download(entries, fetcher, api) {
            rounds.push(entries.map(function (entry) { return entry.id; }));
            return extra.behave(entries, api, rounds.length);
          }
        };
      },
      createFetcher: function () { return { async probeSize() { return undefined; } }; },
      wait: function (ms, signal) {
        delays.push(ms);
        if (typeof extra.duringWait === 'function') extra.duringWait(signal);
        return Promise.resolve();
      },
      reload: function () { reloads.push('reload'); },
      now: function () { return NOW; },
      intentStore: intentStore,
      ensureDirectoryPermission: async function (handle, options) {
        permRequests.push(options ? options.request : 'none');
        return extra.permission || 'granted';
      }
    }
  });
  return {
    controller: controller, panel: panel, rounds: rounds, delays: delays, reloads: reloads,
    dialogs: dialogs, picks: picks, scans: scans, permRequests: permRequests,
    intentStore: intentStore || memoryIntent()
  };
}

/**
 * 走完一批。escalate 之后控制器返回的是永不 resolve 的 Promise（页面正在重载），
 * 所以这里绝不 await 它，只等微任务跑完再断言。
 */
async function runBatch(h, seedIntent) {
  await h.controller.ready;
  await h.controller.resumeIntent;
  // 意图必须在 ready/consumeIntent 之后才种：否则这一批会被「重载后续跑」抢先跑掉。
  if (seedIntent) h.intentStore.write(seedIntent);
  await h.controller.startScan();
  const done = h.controller.startDownload();
  let settled = false;
  done.then(function () { settled = true; }, function () { settled = true; });
  await tick(40);
  return { done: done, settled: function () { return settled; } };
}

function assertNoLoginWording(panel) {
  const texts = panel.texts('setNotice').concat(panel.texts('setHalted'));
  for (const text of texts) {
    for (const word of ['登录', '过期', '会话失效', '重新登录', '认证']) {
      assert.equal(text.includes(word), false, '面板文案里不许出现「' + word + '」：' + text);
    }
  }
}

/** 连续两轮零进展：每一轮都零进展地停机，pending 固定是这两条。 */
function alwaysHalt(entries, api, round) {
  return haltedResult([], byIds(['e2', 'e3']));
}

test('AC1：连续零进展 → 强制重载 1 次，意图 reloads 0→1、pendingIds 是 pending 的 id，停机诊断带 reason+pending', async () => {
  const ss = installSessionStorage();
  const info = captureInfo();
  try {
    const h = setup({ behave: alwaysHalt, useSessionStorage: true });
    const run = await runBatch(h);
    assert.equal(h.reloads.length, 1, '停机且自动重试用尽 → reload 只调 1 次');
    assert.equal(run.settled(), false, '重载之后绝不 resolve（页面已经在卸载）');
    const intent = ss.raw();
    assert.deepEqual(
      intent && { courseId: intent.courseId, contentId: intent.contentId, pendingIds: intent.pendingIds, createdAt: intent.createdAt, reloads: intent.reloads, dirName: intent.dirName },
      { courseId: COURSE, contentId: CONTENT, pendingIds: ['e2', 'e3'], createdAt: NOW, reloads: 1, dirName: '' },
      'sessionStorage 意图：reloads 从 0 变 1，pendingIds 是 pending 的 entry.id 列表'
    );
    // 恢复态：续跑前报第 1 次、触发重载时报 attempt 1（重载次数 = 上一次 0 + 1）。
    const recovering = h.panel.callsOf('setRecovering').map(function (c) { return c.args[0]; });
    assert.ok(recovering.length >= 1, '触发重载前必须把恢复态交给面板');
    assert.deepEqual(recovering[recovering.length - 1], { attempt: 1 }, '触发重载那次报的 attempt 就是 reloads 0→1');
    // 每次停机各打一行（这条路径停机两轮 → 两行，同一份 payload）；AC9 单独验「一次停机只有一行」。
    const halt = info.tagged('[bbdl] 停机');
    assert.deepEqual(halt[0][1], { reason: 'session-expired', pending: 2 }, '停机那一刻打 { reason, pending }');
    assert.equal(halt.length, 2, '两次停机各一行，绝不多刷');
    assert.deepEqual(info.tagged('[bbdl] 自动重载续跑').map(function (line) { return line[1]; }), [{ reloads: 1 }]);
    assertNoLoginWording(h.panel);
  } finally {
    info.restore();
    ss.restore();
  }
});

test('AC2：settings.autoReload=false → 不重载，面板收到「已暂停」提示并打一条诊断', async () => {
  const info = captureInfo();
  try {
    const h = setup({ behave: alwaysHalt, settings: { autoReload: false } });
    const run = await runBatch(h);
    assert.equal(h.reloads.length, 0, '开关关掉就不许重载');
    assert.equal(run.settled(), true, '这条路径必须正常收尾');
    assert.equal(h.intentStore.peek(), null, '没有意图要留给下一次');
    assert.deepEqual(
      h.panel.texts('setNotice').filter(function (t) { return t.includes('已暂停'); }),
      ['已暂停，未下载 2 个文件。']
    );
    assert.equal(info.tagged('[bbdl] 自动重载已关闭').length, 1, 'console.info 必须说清为什么没重载');
    assert.equal(h.panel.countOf('showSummary'), 1);
    assertNoLoginWording(h.panel);
  } finally {
    info.restore();
  }
});

test('AC3：意图里 reloads 已等于 autoReloadMax → 不重载，打「自动重载已达上限」并把意图清掉', async () => {
  const info = captureInfo();
  try {
    const h = setup({ behave: alwaysHalt });
    await runBatch(h, { courseId: COURSE, contentId: CONTENT, pendingIds: ['e2', 'e3'], dirName: '', createdAt: NOW, reloads: 2 });
    assert.equal(h.reloads.length, 0, '撞满上限就绝不再重载');
    assert.deepEqual(info.tagged('[bbdl] 自动重载已达上限').map(function (line) { return line[1]; }), [{ reloads: 2 }]);
    assert.equal(h.intentStore.peek(), null, '用尽的意图必须清掉，绝不让下一次开页自己跑');
    assert.deepEqual(
      h.panel.texts('setNotice').filter(function (t) { return t.includes('已暂停'); }),
      ['已暂停，未下载 2 个文件。']
    );
  } finally {
    info.restore();
  }
});

test('AC4：用户取消 → 不重载，已有的意图被清掉', async () => {
  const h = setup({
    behave: alwaysHalt,
    duringWait: function () { h.panel.opts.onCancel(); }
  });
  await runBatch(h, { courseId: COURSE, contentId: CONTENT, pendingIds: ['e2'], dirName: '', createdAt: NOW, reloads: 1 });
  assert.equal(h.reloads.length, 0, '取消之后不许重载');
  assert.equal(h.intentStore.peek(), null, '取消要把意图清掉（下次开页不许自己跑）');
});

test('AC5：批次以非停机状态收尾 → 意图被清掉', async () => {
  const h = setup({
    behave: function (entries) { return { ok: entries.slice(), failed: [], aborted: false }; }
  });
  await h.controller.ready;
  await h.controller.resumeIntent;
  h.intentStore.write({ courseId: COURSE, contentId: CONTENT, pendingIds: ['e2'], dirName: '', createdAt: NOW, reloads: 1 });
  await h.controller.startScan();
  await h.controller.startDownload();
  assert.equal(h.intentStore.peek(), null, '正常收尾之后意图不许留到下一次开页');
  assert.equal(h.reloads.length, 0);
});

test('AC6：重载后续跑 —— 意图匹配且权限 granted → 自动扫描 + 自动下载，0 次 openSelectDialog / pickDirectory', async () => {
  const handle = { name: 'courses' };
  const intent = { courseId: COURSE, contentId: CONTENT, pendingIds: ['e2', 'e3'], dirName: 'courses', createdAt: NOW, reloads: 1 };
  const h = setup({
    handle: handle,
    intent: intent,
    entries: ENTRIES,
    behave: function (entries) { return { ok: entries.slice(), failed: [], aborted: false }; }
  });
  await h.controller.ready;
  await h.controller.resumeIntent;
  await tick(40);
  assert.equal(h.scans.length, 1, 'entries 为空时续跑先自动扫一次');
  assert.equal(h.rounds.length, 1, '授权到位就必须真的把这一批跑起来');
  assert.deepEqual(h.rounds[0], ['e1', 'e2', 'e3', 'e4', 'e5']);
  assert.equal(h.dialogs.length, 0, '重载之后不许再弹选择框（没有人能点）');
  assert.equal(h.picks.length, 0, '绝不再调 pickDirectory / showDirectoryPicker（没有用户手势，调必抛）');
  assert.equal(h.permRequests.includes(true), false, '权限只做 request:false 查询（请求权限必须有用户手势）');
  assert.equal(h.reloads.length, 0);
});

test('AC7：重载后续跑 —— 权限非 granted → 不自动下载，横幅收到 pendingCount', async () => {
  const intent = { courseId: COURSE, contentId: CONTENT, pendingIds: ['e2', 'e3'], dirName: 'courses', createdAt: NOW, reloads: 1 };
  const h = setup({
    handle: { name: 'courses' },
    intent: intent,
    permission: 'denied',
    behave: function (entries) { return { ok: entries.slice(), failed: [], aborted: false }; }
  });
  await h.controller.ready;
  await h.controller.resumeIntent;
  await tick(40);
  assert.equal(h.rounds.length, 0, '权限没了绝不自动跑');
  assert.equal(h.dialogs.length, 0);
  assert.equal(h.picks.length, 0, '更不许为了重拿权限去调目录选择器');
  assert.deepEqual(
    h.panel.callsOf('setHalted').map(function (c) { return c.args[0]; }),
    [{ reason: 'session-expired', pendingCount: 2 }]
  );
  assert.equal(h.scans.length, 0, '没权限连扫描都不做');
});

test('AC8：陈旧意图（createdAt 早于 30 分钟）→ 不续跑且被清掉', async () => {
  const h = setup({
    handle: { name: 'courses' },
    intent: { courseId: COURSE, contentId: CONTENT, pendingIds: ['e2'], dirName: '', createdAt: NOW - TTL_MS - 60000, reloads: 1 },
    behave: function (entries) { return { ok: entries.slice(), failed: [], aborted: false }; }
  });
  await h.controller.ready;
  await h.controller.resumeIntent;
  await tick(40);
  assert.equal(h.intentStore.peek(), null, '过期意图要清掉');
  assert.equal(h.scans.length, 0, '过期意图不许触发扫描');
  assert.equal(h.rounds.length, 0, '过期意图不许触发下载');
  assert.equal(h.panel.countOf('setHalted'), 0, '过期是静默丢弃，不是停机');
});

test('AC9：停机那一刻只打一行 console.info 停机诊断，且不出现「登录」字样', async () => {
  const info = captureInfo();
  try {
    const h = setup({
      behave: function (entries) { return haltedResult(entries.slice(0, 1), byIds(['e4', 'e5'])); },
      duringWait: function () { h.panel.opts.onCancel(); }
    });
    await runBatch(h);
    assert.deepEqual(
      info.tagged('[bbdl] 停机').map(function (line) { return line[1]; }),
      [{ reason: 'session-expired', pending: 2 }],
      '有进展的一次停机也照打一行'
    );
    assertNoLoginWording(h.panel);
  } finally {
    info.restore();
  }
});

test('intentStore 三个方法全抛 → 静默吞掉，保留当前页等待手动继续', async () => {
  const boom = {
    read() { throw new Error('sessionStorage 被禁'); },
    write() { throw new Error('sessionStorage 被禁'); },
    clear() { throw new Error('sessionStorage 被禁'); }
  };
  const h = setup({ behave: alwaysHalt, intentStore: boom });
  await runBatch(h);
  assert.equal(h.reloads.length, 0, '保存不了勾选范围时留在当前页');
  assert.ok(h.controller.getState().haltedPending.length > 0);
  assert.equal(h.panel.countOf('fail'), 0, '存储异常绝不许冒到面板');
});

test('面板没有 setRecovering / clearRecovering（S27 未落地）→ 跳过调用，重载阶梯照常走完', async () => {
  const h = setup({ behave: alwaysHalt, withoutRecovering: true });
  await runBatch(h);
  assert.equal(h.reloads.length, 1, '面板缺方法不许拦住重载');
  assert.equal(h.panel.countOf('fail'), 0);
});

test('AC13：重载后续跑按清单 + 磁盘比对取待办 —— 盘上已有的不重下，绝不产生 (2) 副本', async () => {
  // 盘上已有 a.pdf(10) / b.pdf(20)，与 e1 / e2 同名同大小：这两个必须跳过。
  const existing = new Map([['a.pdf', 10], ['b.pdf', 20]]);
  const h = setup({
    handle: { name: 'courses' },
    existing: existing,
    planSkips: planSkips,
    intent: { courseId: COURSE, contentId: CONTENT, pendingIds: ['e1', 'e2', 'e3', 'e4', 'e5'], dirName: 'courses', createdAt: NOW, reloads: 1 },
    behave: function (entries) { return { ok: entries.slice(), failed: [], aborted: false }; }
  });
  await h.controller.ready;
  await h.controller.resumeIntent;
  await tick(40);
  assert.deepEqual(h.rounds[0], ['e3', 'e4', 'e5'], '盘上已有的两个文件不许重下（重下一遍会被加上 (2) 后缀）');
  assert.equal(h.dialogs.length, 0, '仍然不许弹选择框');
});


test('重载恢复只下载原先勾选的文件，清除已消费的意图', async () => {
  const h = setup({
    handle: { name: 'courses' },
    intent: { courseId: COURSE, contentId: CONTENT, selectedIds: ['e2','e4','e5'], pendingIds: ['e4'], createdAt: NOW, reloads: 1 },
    behave(entries) { return { ok: entries, failed: [], aborted: false }; }
  });
  await h.controller.resumeIntent;
  assert.deepEqual(h.rounds, [['e2','e4','e5']]);
  assert.equal(h.intentStore.peek(), null);
});

test('用户选三项，首轮成功一项，重载后只请求剩余两项且摘要成功三项', async () => {
  const selected = byIds(['e1','e3','e5']);
  const handle = { name: 'courses' };
  const first = setup({ selected, handle, behave(batch, api, round) {
    return round === 1 ? haltedResult(batch.slice(0, 1), batch.slice(1)) : haltedResult([], batch);
  } });
  await runBatch(first);
  const intent = first.intentStore.peek();
  assert.deepEqual(intent.selectedIds, selected.map(e => e.id));
  const second = setup({ handle, intent, planSkips, existing: new Map([['a.pdf', 10]]),
    behave(batch) { return { ok: batch, failed: [], aborted: false }; }
  });
  await second.controller.resumeIntent;
  assert.deepEqual(second.rounds, [['e3','e5']]);
  assert.equal(second.panel.callsOf('showSummary')[0].args[0].ok.length, 3);
  const rows = second.panel.callsOf('setFiles')[0].args[0];
  assert.deepEqual(rows.map(e => e.id), ['e1','e3','e5']);
  assert.equal(rows[0].status, 'done');
});
