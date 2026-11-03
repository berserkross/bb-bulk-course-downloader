import test from 'node:test';
import assert from 'node:assert/strict';

import { createController } from '../../src/index.js';

const HREF = 'https://bb.example.edu/webapps/blackboard/content/listContent.jsp?course_id=_101_1&content_id=_202_1';

const ENTRIES = [
  { id: 'e1', name: 'a.pdf', size: 10, folderPath: [], url: 'https://bb.example.edu/f/1' },
  { id: 'e2', name: 'b.pdf', size: 20, folderPath: [], url: 'https://bb.example.edu/f/2' },
  { id: 'e3', name: 'c.pdf', size: 30, folderPath: [], url: 'https://bb.example.edu/f/3' },
  { id: 'e4', name: 'd.pdf', size: 40, folderPath: [], url: 'https://bb.example.edu/f/4' },
  { id: 'e5', name: 'e.pdf', size: 50, folderPath: [], url: 'https://bb.example.edu/f/5' }
];

// v2.8.0 文案变更（docs/m7-quiet.md §1）：熔断不再谈「重试 / 登录」，改成「已暂停，未下载 N 个文件。」
// —— 本文件所有用例都注入 autoReload:false，验的是「就地暂停」这条分支，不含强制重载。
const STOP_NOTICE = '已暂停，未下载 5 个文件。';

function makePanel() {
  const calls = [];
  const api = { calls: calls, opts: null };
  const names = [
    'setState', 'setCount', 'setScanProgress', 'setDownloadProgress', 'setMode', 'setNotice',
    'setResume', 'setFiles', 'applyFileEvent', 'setHalted', 'clearHalted', 'showSummary', 'rebind', 'fail', 'destroy'
  ];
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

function haltedResult(ok, failed, pending) {
  return withHiddenHalted(
    { ok: ok, failed: failed, aborted: false },
    { reason: 'session-expired', pending: pending, pendingCount: pending.length }
  );
}

function makeStore() {
  return {
    available: true,
    async loadManifest() { return null; },
    async saveManifest() {},
    async mergeFiles() {},
    async clearManifest() {},
    async loadHandle() { return null; },
    async saveHandle() {},
    async clearHandle() {}
  };
}

/**
 * 续跑循环的假环境。时间一律走注入的 wait（默认要等 3 秒 —— 单测绝不真睡），
 * 探活（probeAlive）作为「一旦被调用就炸」的哨兵注入：v2.7.1 起续跑判据不再看它。
 */
function setup(over) {
  const extra = over || {};
  const panel = makePanel();
  const rounds = [];
  const delays = [];
  const probeCalls = [];
  const controller = createController({
    store: makeStore(),
    openSelectDialog: async function (entries) {
      return { entries: entries, dirHandle: null, expectedBytes: 0, skipExisting: false };
    },
    mountPanel: function (options) {
      panel.opts = options;
      return panel;
    },
    // autoReload:false 是注入而非断言：本文件验的是「熔断后就地暂停」（重载与续跑在 reload-resume.test.js），
    // 不关掉的话这些用例会走真实重载分支、永远不返回。
    settings: Object.assign({ preserveTree: true, downloadConcurrency: 2, autoReload: false }, extra.settings || {}),
    location: { href: HREF },
    document: null,
    deps: {
      createScanner: function () {
        return { async scan() { return extra.entries || ENTRIES; } };
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
      createFetcher: function () {
        return { async probeSize() { return undefined; } };
      },
      wait: function (ms, signal) {
        delays.push(ms);
        if (typeof extra.duringWait === 'function') extra.duringWait(signal);
        return Promise.resolve();
      },
      probeAlive: function () {
        probeCalls.push('probeAlive');
        throw new Error('v2.7.1 起续跑判据不再调用 probeAlive');
      }
    }
  });
  return { controller: controller, panel: panel, rounds: rounds, delays: delays, probeCalls: probeCalls };
}

async function runFirstBatch(h) {
  await h.controller.ready;
  await h.controller.startScan();
  return h.controller.startDownload();
}

/** 截获 [bbdl] 熔断日志：只留 console.info 的首参 + 次参，其余原样放行。 */
function captureInfo() {
  const original = console.info;
  const lines = [];
  console.info = function () {
    const args = Array.prototype.slice.call(arguments);
    if (args[0] === '[bbdl] 自动重试熔断') lines.push(args[1]);
    return original.apply(console, arguments);
  };
  return {
    lines: lines,
    restore: function () { console.info = original; }
  };
}

test('AC1/AC4：死会话（每轮零 ok）只自动续跑 1 轮就熔断，attempts <= 3，熔断文案逐字且不含 URL 痕迹', async () => {
  const capture = captureInfo();
  const h = setup({
    settings: { autoResumeMax: 3 },
    behave: async function (entries) {
      // 每个请求都回登录页 HTML：一个文件都没下成，pending 就是整批
      const failed = entries.map(function (entry) {
        return { entry: entry, name: entry.name, path: entry.name, url: entry.url, error: '登录已过期' };
      });
      return haltedResult([], failed, entries.slice());
    }
  });
  let result;
  try {
    result = await runFirstBatch(h);
  } finally {
    capture.restore();
  }

  assert.ok(h.rounds.length <= 3, '必须收口：实测跑了 ' + h.rounds.length + ' 轮');
  assert.deepEqual(h.delays, [3000], '零进展的第一轮只等第一档 3 秒，第二轮就熔断');
  assert.equal(h.probeCalls.length, 0, '探活一次都不许调用');

  const stop = h.panel.texts('setNotice').filter(function (text) { return text.includes('已暂停，未下载'); });
  assert.equal(stop.length, 1, '暂停提示只出现一次');
  assert.equal(stop[0], STOP_NOTICE, '暂停文案逐字照抄');
  assert.equal(/http|\?|\//.test(stop[0]), false, '熔断文案里不许出现协议、查询串或路径');

  assert.equal(h.panel.countOf('showSummary'), 1, 'finish 只收尾一次');
  const halted = h.panel.callsOf('setHalted');
  assert.equal(halted.length, 1);
  assert.deepEqual(halted[0].args[0], { reason: 'session-expired', pendingCount: ENTRIES.length });
  assert.equal(result.halted.reason, 'session-expired', '停机状态如实交回调用方');

  assert.equal(capture.lines.length, 1, '熔断日志只打一次');
  assert.deepEqual(capture.lines[0], { zeroProgress: 2, pending: ENTRIES.length }, '日志字段只有 zeroProgress 与 pending 数');
});

test('AC2：假死 —— 第 1 轮 3 done 后停机、第 2 轮全成功：续跑后 pending 清空、notice 出现「正在自动恢复」', async () => {
  const h = setup({
    settings: { autoResumeMax: 3 },
    behave: async function (entries, api, round) {
      if (round > 1) {
        for (const entry of entries) {
          api.onProgress({ state: 'file-done', entryId: entry.id, filesDone: 1, filesTotal: entries.length });
        }
        return { ok: entries.slice(), failed: [], aborted: false };
      }
      api.onFileEvent({ type: 'halt', reason: 'session-expired', pending: 2 });
      return haltedResult(entries.slice(0, 3), [], entries.slice(3));
    }
  });
  const result = await runFirstBatch(h);

  assert.deepEqual(h.rounds, [['e1', 'e2', 'e3', 'e4', 'e5'], ['e4', 'e5']], '续跑只重跑 pending 那两条');
  assert.deepEqual(h.delays, [3000]);
  assert.equal(h.probeCalls.length, 0, '探活一次都不许调用');

  const notices = h.panel.texts('setNotice');
  assert.equal(notices.some(function (text) { return text.includes('正在自动恢复'); }), true, '续跑前必须给出「正在自动恢复」提示（面板上一律不许出现「登录」）');
  assert.equal(notices.some(function (text) { return text.includes('已暂停，未下载'); }), false, '这一批没有暂停');
  assert.equal(h.panel.countOf('showSummary'), 1, 'finish 只收尾一次');
  assert.equal(h.panel.countOf('setHalted'), 0, '两轮跑完都没停机，横幅不许竖起来');
  assert.deepEqual(h.controller.getState().haltedPending, [], 'pending 已清空');
  assert.equal(result.halted == null, true, '交回的结果没有停机标记');
});

test('AC3：有进展就重置预算 —— 第 2 轮 2 done 后再次停机、第 3 轮成功，全程无熔断提示', async () => {
  const h = setup({
    settings: { autoResumeMax: 3 },
    behave: async function (entries, api, round) {
      if (round === 1) return haltedResult([entries[0]], [], entries.slice(1));
      if (round === 2) return haltedResult([entries[0]], [], entries.slice(1));
      return { ok: entries.slice(), failed: [], aborted: false };
    }
  });
  const result = await runFirstBatch(h);

  assert.equal(h.rounds.length, 3, '两轮有进展都没用完 autoResumeMax=3');
  // 每轮都有进展 → 预算被归零 → 下一次仍然从第一档 3 秒开始
  assert.deepEqual(h.delays, [3000, 3000], '有进展就重置预算：退避阶梯重新从第一档开始');
  assert.equal(h.probeCalls.length, 0, '探活一次都不许调用');

  const notices = h.panel.texts('setNotice');
  assert.equal(notices.some(function (text) { return text.includes('已暂停，未下载'); }), false, '有进展就不许暂停');
  assert.equal(notices.filter(function (text) { return text.includes('正在自动恢复'); }).length, 2);
  assert.equal(h.panel.countOf('showSummary'), 1, 'finish 只收尾一次');
  assert.deepEqual(h.controller.getState().haltedPending, []);
  assert.equal(result.halted == null, true);
});

test('AC1 补充：退避阶梯 —— 有进展一轮后连续两轮零进展，注入的等待是 3000 → 8000，第三轮即熔断', async () => {
  const h = setup({
    settings: { autoResumeMax: 3 },
    behave: async function (entries, api, round) {
      if (round === 1) return haltedResult([entries[0]], [], entries.slice(1));
      // 之后两次都一个没下成：预算不再归零，阶梯升到第二档
      return haltedResult([], [], entries.slice());
    }
  });
  await runFirstBatch(h);

  assert.equal(h.rounds.length, 3, '连续两轮零进展就停手，绝不许无限续跑');
  assert.deepEqual(h.delays, [3000, 8000], '等待时间由 autoResumeDelay 算出：3 秒 → 8 秒');
  assert.equal(h.probeCalls.length, 0, '探活一次都不许调用');
  assert.equal(h.panel.texts('setNotice').filter(function (text) { return text.includes('已暂停，未下载'); }).length, 1);
});

test('AC5：取消优先 —— 已 abort / 等待中 abort 都不续跑，探活从未调用、finish 只一次、无续跑提示', async () => {
  // (1) 停机结果回来之前用户已经点了取消
  const early = setup({
    settings: { autoResumeMax: 3 },
    behave: async function (entries, api) {
      early.panel.opts.onCancel();
      return haltedResult([entries[0]], [], entries.slice(1));
    }
  });
  const earlyResult = await runFirstBatch(early);

  assert.equal(early.rounds.length, 1, '已取消：一轮都不许再跑');
  assert.deepEqual(early.delays, [], '连等待都不许发生');
  assert.equal(early.probeCalls.length, 0, '探活一次都不许调用');
  assert.equal(early.panel.countOf('showSummary'), 1, 'finish 只收尾一次');
  assert.equal(early.panel.texts('setNotice').some(function (text) { return text.includes('正在自动恢复'); }), false, '取消后不许再给续跑提示');
  assert.equal(earlyResult.halted.reason, 'session-expired', '取消不动停机结果：照样交回');

  // (2) 等待期间用户点了取消：立刻收尾，下一批一次都不跑
  const during = setup({
    settings: { autoResumeMax: 3 },
    behave: async function (entries) {
      return haltedResult([entries[0]], [], entries.slice(1));
    },
    duringWait: function () {
      during.panel.opts.onCancel();
    }
  });
  const duringResult = await runFirstBatch(during);

  assert.equal(during.rounds.length, 1, '等待中取消：下一批一次都不跑');
  assert.deepEqual(during.delays, [3000], '等待确实开始了（被取消立刻打断）');
  assert.equal(during.probeCalls.length, 0, '探活一次都不许调用');
  assert.equal(during.panel.countOf('showSummary'), 1, 'finish 只收尾一次');
  assert.equal(duringResult.halted.reason, 'session-expired', '交回的结果照样带停机标记');
  assert.deepEqual(during.controller.getState().haltedPending.map(function (entry) { return entry.id; }), ['e2', 'e3', 'e4', 'e5'], '取消后停机快照留着，用户还能手动续跑');
});

// 可见文案报「当轮还没下到的文件数」（halted.pending.length），轮数只在 console 里：
// 各轮 pending 会重复出现同一个文件，相加等于把一个人数很多遍。
test('全局闸门：整批累计续跑撞满 20 次就熔断（每次都有进展也不许无限乒乓）', async () => {
  const many = [];
  for (let i = 1; i <= 25; i += 1) {
    many.push({ id: 'm' + i, name: 'f' + i + '.pdf', size: i, folderPath: [], url: 'https://bb.example.edu/m/' + i });
  }
  const capture = captureInfo();
  const h = setup({
    entries: many,
    settings: { autoResumeMax: 40 },
    behave: async function (entries) {
      // 每轮都下成 1 个、又立刻停机：有进展所以预算一直被归零，只能靠整批闸门收口
      return haltedResult([entries[0]], [], entries.slice(1));
    }
  });
  try {
    await runFirstBatch(h);
  } finally {
    capture.restore();
  }

  assert.equal(h.delays.length, 20, '整批续跑次数上限 20');
  assert.equal(h.rounds.length, 21, '20 次续跑 + 熔断那一轮');
  assert.deepEqual(new Set(h.delays), new Set([3000]), '每轮都有进展，阶梯一直在第一档');
  assert.equal(h.probeCalls.length, 0, '探活一次都不许调用');
  const stop = h.panel.texts('setNotice').filter(function (text) { return text.includes('已暂停，未下载'); });
  assert.equal(stop.length, 1);
  // 第 21 轮 batch 只剩 5 条、pending 4 条：报 24 会把早下掉的 20 个再数一遍。
  assert.equal(stop[0], '已暂停，未下载 4 个文件。', '同一个暂停文案：撞满闸门那当轮还剩几个就报几个');
  assert.equal(h.panel.countOf('showSummary'), 1, 'finish 只收尾一次');
  assert.deepEqual(capture.lines, [{ resumes: 20, pending: 4 }], '诊断带轮数与当轮剩几个：20 轮、还剩 4 个');
});

test('面板摘要：停机 pending 从失败清单里摘掉，其余真实失败照旧保留（闸门关闭时不自动续跑）', async () => {
  // 这一条守住 wiring-m3 里原先由「探活说死」间接验到的 resultForPanel 行为：
  // pending 的 e2 不许出现在失败清单，同轮真失败的 e3 必须留着。
  const h = setup({
    settings: { autoResumeMax: 0 },
    behave: async function (entries) {
      return haltedResult(
        [entries[0]],
        [
          { entry: entries[1], name: 'b.pdf', path: 'b.pdf', url: entries[1].url, error: '登录已过期' },
          { entry: entries[2], name: 'c.pdf', path: 'c.pdf', url: entries[2].url, error: '404' }
        ],
        [entries[1]]
      );
    }
  });
  await runFirstBatch(h);

  assert.equal(h.rounds.length, 1, 'autoResumeMax=0：一次都不自动续跑');
  assert.deepEqual(h.delays, []);
  const shown = h.panel.callsOf('showSummary')[0].args[0];
  assert.deepEqual(shown.failed.map(function (item) { return item.entry.id; }), ['e3'], 'pending 的 e2 摘掉，e3 的 404 留着');
  assert.equal(shown.ok.length, 1);
  assert.equal(h.panel.texts('setNotice').some(function (text) { return text.includes('已暂停'); }), false, '关掉续跑不等于熔断');
});
