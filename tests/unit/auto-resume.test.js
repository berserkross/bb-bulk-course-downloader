import test from 'node:test';
import assert from 'node:assert/strict';

import { autoResumeDelay, shouldAutoResume } from '../../src/index.js';
import { probeAlive } from '../../src/bb/http.js';

const HALT = { reason: 'session-expired', pending: [{ id: 'e2' }], pendingCount: 1 };

/** 只在这一次调用期间替换全局 fetch：probeAlive 走真实全局，不许留痕。 */
async function withFetch(impl, body) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

function headers(type) {
  return {
    get(name) {
      return String(name).toLowerCase() === 'content-type' ? type : null;
    }
  };
}

test('shouldAutoResume：正常停机（会话过期、未取消、还有次数）返回 true', () => {
  assert.equal(shouldAutoResume({ halted: HALT, aborted: false, used: 0, max: 3 }), true);
  assert.equal(shouldAutoResume({ halted: HALT, aborted: false, used: 2, max: 3 }), true);
});

test('shouldAutoResume：用户取消 / 达上限 / 非 session-expired 一律 false', () => {
  assert.equal(shouldAutoResume({ halted: HALT, aborted: true, used: 0, max: 3 }), false);
  assert.equal(shouldAutoResume({ halted: HALT, aborted: false, used: 3, max: 3 }), false);
  assert.equal(shouldAutoResume({ halted: { reason: 'network' }, aborted: false, used: 0, max: 3 }), false);
  assert.equal(shouldAutoResume({ halted: null, aborted: false, used: 0, max: 3 }), false);
});

test('autoResumeDelay：三档 3000/8000/20000，越界取最后一项', () => {
  assert.equal(autoResumeDelay(0), 3000);
  assert.equal(autoResumeDelay(1), 8000);
  assert.equal(autoResumeDelay(2), 20000);
  assert.equal(autoResumeDelay(3), 20000);
  assert.equal(autoResumeDelay(99), 20000);
  assert.equal(autoResumeDelay(-1), 3000);
});

test('probeAlive：206 + application/pdf 判活着，请求带 Range/credentials/no-store', async () => {
  const seen = [];
  const result = await withFetch(
    async function (url, init) {
      seen.push({ url: url, init: init });
      return { status: 206, headers: headers('application/pdf'), body: { cancel() {} } };
    },
    function () {
      return probeAlive({ url: 'https://bb.example.edu/f/1?content_id=_1_1&token=SECRET' });
    }
  );
  assert.equal(result.alive, true);
  assert.equal(result.status, 206);
  assert.equal(result.contentType, 'application/pdf');
  assert.equal(result.htmlKind, undefined, '非 HTML 不做归类');
  assert.equal(seen[0].init.method, 'GET');
  assert.deepEqual(seen[0].init.headers, { Range: 'bytes=0-0' });
  assert.equal(seen[0].init.credentials, 'include');
  assert.equal(seen[0].init.cache, 'no-store');
});

test('probeAlive：200 + text/html 含 Sign in 判死了，htmlKind=login，正文不外传', async () => {
  const body = '<html><body><h1>Sign in to Blackboard</h1><form>password</form></body></html>';
  const result = await withFetch(
    async function () {
      return { status: 200, headers: headers('text/html; charset=utf-8'), body: null, text: async function () { return body; } };
    },
    function () {
      return probeAlive({ url: 'https://bb.example.edu/f/1' });
    }
  );
  assert.equal(result.alive, false);
  assert.equal(result.htmlKind, 'login');
  assert.equal(result.status, 200);
  assert.equal(result.bytes, body.length);
  assert.equal(JSON.stringify(result).includes('Sign in'), false, '正文不许跟着返回值外传');
});

test('probeAlive：text/html 命中限流 / 拦截关键词归 blocked', async () => {
  const result = await withFetch(
    async function () {
      return {
        status: 200,
        headers: headers('text/html'),
        body: null,
        text: async function () { return '<html><body>Access denied — too many requests</body></html>'; }
      };
    },
    function () {
      return probeAlive({ url: 'https://bb.example.edu/f/1' });
    }
  );
  assert.equal(result.alive, false);
  assert.equal(result.htmlKind, 'blocked');
});

test('probeAlive：读不懂的 text/html 归 other，仍然是“死了”', async () => {
  const result = await withFetch(
    async function () {
      return { status: 500, headers: headers('text/html'), body: null, text: async function () { return '<html><body>Server hiccup</body></html>'; } };
    },
    function () {
      return probeAlive({ url: 'https://bb.example.edu/f/1' });
    }
  );
  assert.equal(result.alive, false);
  assert.equal(result.htmlKind, 'other');
  assert.equal(result.status, 500);
});

test('probeAlive：fetch 自己抛错也不抛给调用方，只回 alive:false', async () => {
  const result = await withFetch(
    async function () {
      throw new TypeError('fetch failed');
    },
    function () {
      return probeAlive({ url: 'https://bb.example.edu/f/1' });
    }
  );
  assert.deepEqual(result, { alive: false });
});

/* ---------------- T2：保活心跳地址（keepAliveUrl） ---------------- */

test('keepAliveUrl：去掉 mode / list_display / pageLinks，其余参数与顺序不变，hash 保留', async () => {
  const { keepAliveUrl } = await import('../../src/index.js');
  const href =
    'https://bb.example.edu/webapps/blackboard/content/listContent.jsp?course_id=_16517_1&content_id=_592925_1&mode=reset&list_display=NAME&pageLinks=abc#frag';
  assert.equal(
    keepAliveUrl(href),
    'https://bb.example.edu/webapps/blackboard/content/listContent.jsp?course_id=_16517_1&content_id=_592925_1#frag'
  );
  // 用户实测的那条只带 mode：课程与内容标识一个都不许丢
  assert.equal(
    keepAliveUrl(
      'https://bb.example.edu/webapps/blackboard/content/listContent.jsp?course_id=_16517_1&content_id=_592925_1&mode=reset'
    ),
    'https://bb.example.edu/webapps/blackboard/content/listContent.jsp?course_id=_16517_1&content_id=_592925_1'
  );
});

test('keepAliveUrl：参数名大小写不敏感，其余参数顺序原样，值里出现 mode 字样不算参数名', async () => {
  const { keepAliveUrl } = await import('../../src/index.js');
  assert.equal(
    keepAliveUrl('https://bb.example.edu/x.jsp?Mode=reset&a=1&LIST_DISPLAY=100&b=2&PageLinks=5&c=3'),
    'https://bb.example.edu/x.jsp?a=1&b=2&c=3'
  );
  assert.equal(keepAliveUrl('https://bb.example.edu/x.jsp?t=mode&mode=reset'), 'https://bb.example.edu/x.jsp?t=mode');
});

test('keepAliveUrl：无查询串 / 只有 hash / 全被删光 / 非法输入都不抛', async () => {
  const { keepAliveUrl } = await import('../../src/index.js');
  const bare = 'https://bb.example.edu/webapps/blackboard/content/listContent.jsp';
  assert.equal(keepAliveUrl(bare), bare, '没有查询串原样返回');
  assert.equal(keepAliveUrl(bare + '#top'), bare + '#top', '只有 hash 也原样返回');
  assert.equal(keepAliveUrl('https://bb.example.edu/x.jsp?mode=reset&list_display=1'), 'https://bb.example.edu/x.jsp', '删光了不留孤零零的问号');
  assert.equal(keepAliveUrl('https://bb.example.edu/x.jsp?mode=reset#h'), 'https://bb.example.edu/x.jsp#h');
  assert.equal(keepAliveUrl(''), '');
  assert.equal(keepAliveUrl(null), '');
  assert.equal(keepAliveUrl(undefined), '');
  assert.equal(keepAliveUrl(42), '');
  assert.equal(keepAliveUrl('relative/page.jsp?mode=reset&a=1'), 'relative/page.jsp?a=1', '拼不出绝对地址也不抛');
});

/* ---------------- T3：自动续跑期间的 UI 顺序 ---------------- */

// v2.8.0 文案变更（docs/m7-quiet.md §1）：续跑提示改为「正在自动恢复（第 K 次）…」（面板不许出现「登录」），
// 本用例只跟着换标记串，逻辑与断言不变。
test('自动续跑：撤横幅与 setState(downloading) 先于等待；等待中取消立刻收尾，下一批一次都不跑', async () => {
  const { createController } = await import('../../src/index.js');
  const HREF = 'https://bb.example.edu/webapps/blackboard/content/listContent.jsp?course_id=_101_1&content_id=_202_1';
  const ENTRIES = [
    { id: 'e1', name: 'a.pdf', size: 10, folderPath: [], url: 'https://bb.example.edu/f/1' },
    { id: 'e2', name: 'b.pdf', size: 20, folderPath: [], url: 'https://bb.example.edu/f/2' }
  ];
  const log = [];
  const rounds = [];
  let armed = false;
  let holder = null;

  const panel = { calls: [] };
  const names = [
    'setState', 'setCount', 'setScanProgress', 'setDownloadProgress', 'setMode', 'setNotice',
    'setResume', 'setFiles', 'applyFileEvent', 'setHalted', 'clearHalted', 'showSummary', 'rebind', 'fail', 'destroy'
  ];
  for (const name of names) {
    panel[name] = function (arg) {
      panel.calls.push({ name: name, arg: arg });
      if (name === 'setNotice' && String(arg).includes('正在自动恢复')) log.push('notice');
      // 只关心自动续跑开始之后的那次 setState('downloading')：批次开头的那次不算证据
      if (name === 'setState' && arg === 'downloading' && log.indexOf('notice') >= 0) log.push('setState:downloading');
      if (name === 'showSummary') log.push('showSummaryAt:' + Date.now());
      if (name === 'applyFileEvent' && arg && arg.type === 'halt') {
        // 复刻 panel.js:1190-1199：halt 事件在面板里就等于把停机横幅竖起来
        panel.calls.push({ name: 'setHalted', arg: { reason: arg.reason, pendingCount: arg.pending } });
      }
      if (name === 'clearHalted' && armed) {
        // 撤横幅的这一刻：停机快照必须已经清空（老顺序要等满 3/8/20 秒之后才轮到清）
        log.push('clearHalted:pending=' + holder.getState().haltedPending.length);
        log.push('clearHaltedAt:' + Date.now());
        // 等待期间用户点「取消」：必须立刻收尾，绝不许再跑下一批
        armed = false;
        panel.opts.onCancel();
      }
    };
  }

  const controller = createController({
    store: {
      available: true,
      async loadManifest() { return null; },
      async saveManifest() {},
      async mergeFiles() {},
      async clearManifest() {},
      async loadHandle() { return null; },
      async saveHandle() {},
      async clearHandle() {}
    },
    openSelectDialog: async function (entries) {
      return { entries: entries, dirHandle: null, expectedBytes: 0, skipExisting: false };
    },
    mountPanel: function (options) {
      panel.opts = options;
      return panel;
    },
    settings: { preserveTree: true, downloadConcurrency: 2 },
    location: { href: HREF },
    document: null,
    deps: {
      createScanner: function () {
        return { async scan() { return ENTRIES; } };
      },
      createSink: async function () {
        return {
          kind: 'zip',
          async download(entries, fetcher, api) {
            rounds.push(entries.map(function (entry) { return entry.id; }));
            if (rounds.length > 1) return { ok: entries.slice(), failed: [], aborted: false };
            armed = true;
            // 真实面板是这么竖横幅的（panel.js:1190 halt 事件 → setHalted）：等待期间它必须已经被撤掉
            api.onFileEvent({ type: 'halt', reason: 'session-expired', pending: 1 });
            // halted 在 sink 结果上是不可枚举属性（shared.js:withHalted）：只能这样挂
            const result = { ok: [entries[0]], failed: [], aborted: false };
            Object.defineProperty(result, 'halted', {
              value: { reason: 'session-expired', pending: [entries[1]], pendingCount: 1 },
              enumerable: false, writable: true, configurable: true
            });
            return result;
          }
        };
      },
      createFetcher: function () {
        return { async probeSize() { return undefined; } };
      },
      // 自检注入：这条用例要的是「活着」，绝不真发网络请求
      probeAlive: function () {
        return Promise.resolve({ alive: true });
      }
    }
  });
  holder = controller;

  const started = Date.now();
  await controller.ready;
  await controller.startScan();
  await controller.startDownload();
  const elapsed = Date.now() - started;

  assert.deepEqual(rounds, [['e1', 'e2']], '取消之后不许再跑下一批');
  assert.equal(log.length, 5, 'notice → 撤横幅 → 切 downloading → 收尾，一步都不许多（实际：' + log.join(' | ') + '）');
  assert.equal(log[0], 'notice', '先给「正在自动恢复」提示（used+1 之后）');
  assert.equal(log[1], 'clearHalted:pending=0', '撤横幅之前停机快照已经清空');
  assert.equal(log[2].startsWith('clearHaltedAt:'), true, '撤横幅发生在等待之前');
  assert.equal(log[3], 'setState:downloading', '撤横幅与切回 downloading 都在等待之前');
  assert.equal(log[4].startsWith('showSummaryAt:'), true, '等待期间取消：立刻收尾');

  const clearAt = Number(log[2].slice('clearHaltedAt:'.length));
  const summaryAt = Number(log[4].slice('showSummaryAt:'.length));
  assert.ok(elapsed < 2000, '等待中取消必须立刻返回，不许真等满 3000ms（实测 ' + elapsed + 'ms）');
  assert.ok(summaryAt - clearAt < 1000, '撤横幅到收尾之间不许夹着那 3 秒等待（实测 ' + (summaryAt - clearAt) + 'ms）');
  assert.deepEqual(
    controller.getState().haltedPending.map(function (entry) { return entry.id; }),
    ['e2'],
    '取消后停机快照仍然留着：用户还能点「刷新后继续」'
  );
  const haltAt = panel.calls.findIndex(function (call) { return call.name === 'setHalted'; });
  const noticeAt = panel.calls.findIndex(function (call) { return call.name === 'setNotice' && String(call.arg).includes('正在自动恢复'); });
  const clearAt2 = panel.calls.findIndex(function (call, i) { return call.name === 'clearHalted' && i > haltAt; });
  assert.ok(haltAt >= 0 && haltAt < noticeAt, '前提：横幅先竖起来，新 notice 才可能出现自相矛盾');
  assert.ok(clearAt2 > noticeAt, 'notice 之后立刻撤横幅（旧顺序里这中间夹着 3 秒）');
  assert.equal(
    panel.calls.filter(function (call) { return call.name === 'setHalted'; }).length,
    2,
    '取消之后横幅还给用户：停机 pending 仍然是真的'
  );
});
