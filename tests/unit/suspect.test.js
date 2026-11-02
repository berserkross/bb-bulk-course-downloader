import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HttpError,
  SessionExpiredError,
  SuspectResponseError,
  createFetcher,
  isSuspectResponse
} from '../../src/bb/http.js';
import {
  RETRY_SUSPECT_TEXT,
  SUSPECT_ATTEMPTS,
  SUSPECT_DELAYS,
  isRetriableError,
  withFileRetry
} from '../../src/sinks/guard.js';

/** 带 query 的真实形状：任何泄漏检查都靠它，path 里出现 ? 或 xid 就是失败。 */
const WEBDAV_URL =
  'https://bb.cuhk.edu.cn/bbcswebdav/pid-617600-dt-content-rid-11524503_1/courses/ENG1002/notes.pdf?xid=987654&t=1';
const WEBDAV_PATHNAME = '/bbcswebdav/pid-617600-dt-content-rid-11524503_1/courses/ENG1002/notes.pdf';

/** 假 Response：只实现 assertAlive 真正会碰的那几个面（headers.get / status / url / text）。 */
function htmlResponse({ url, status = 200, body = '' }) {
  return {
    url,
    status,
    ok: status >= 200 && status < 300,
    body: null,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
    text: async () => body
  };
}

/** 计数桩：把 globalThis.fetch 换成「记一次数、回一个固定响应」，跑完必然还原。 */
async function fetchOnce(stub, url = WEBDAV_URL) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (target) => {
    calls.push(String(target));
    return stub(String(target), calls.length);
  };
  try {
    const fetcher = createFetcher({});
    let error = null;
    let response = null;
    try {
      response = await fetcher.fetchOk(url);
    } catch (err) {
      error = err;
    }
    return { error, response, calls };
  } finally {
    globalThis.fetch = real;
  }
}

function isLeakFree(text) {
  const value = String(text == null ? '' : text);
  if (/http/i.test(value)) return false;
  if (value.indexOf('?') !== -1) return false;
  if (value.toLowerCase().indexOf('xid') !== -1) return false;
  return true;
}

// =========================== 错误类型 ===========================

test('SuspectResponseError：固定文案，只带 htmlKind / status / pathname，绝不复显 URL 或 query', () => {
  const plain = new SuspectResponseError();
  assert.equal(plain.message, '服务器返回了异常页面（疑似限流）');
  assert.equal(plain.name, 'SuspectResponseError');
  assert.equal(plain.htmlKind, 'other', '缺省归类必须是 other');
  assert.equal(plain.status, 0, '缺省 status 必须是 0（数字），不是 undefined');
  assert.equal(plain.path, '', '没有 URL 时 path 是空串');

  const blocked = new SuspectResponseError({
    htmlKind: 'blocked',
    status: 503,
    path: 'https://bb.cuhk.edu.cn/bbcswebdav/pid-1/x.pdf?xid=42&t=1'
  });
  assert.equal(blocked.htmlKind, 'blocked');
  assert.equal(blocked.status, 503);
  assert.equal(blocked.path, '/bbcswebdav/pid-1/x.pdf', 'path 只留 pathname，query 必须消失');
  assert.ok(isLeakFree(blocked.message), 'message 不许带 http / ? / xid：' + blocked.message);
  assert.ok(isLeakFree(blocked.path), 'path 不许带 http / ? / xid：' + blocked.path);
  console.log('  [证据] 可疑错误可见面：', JSON.stringify({ message: blocked.message, path: blocked.path, status: blocked.status, htmlKind: blocked.htmlKind }));
});

test('isSuspectResponse 只认 name；isRetriableError 对可疑为 true，对会话失效仍为 false', () => {
  assert.equal(isSuspectResponse(new SuspectResponseError()), true);
  assert.equal(
    isSuspectResponse(Object.assign(new Error('跨上下文'), { name: 'SuspectResponseError' })),
    true,
    '只认 name：同名字对象也算可疑'
  );
  assert.equal(isSuspectResponse(new SessionExpiredError()), false, '会话失效绝不能被当成可疑');
  assert.equal(isSuspectResponse(null), false);

  assert.equal(isRetriableError(new SuspectResponseError()), true);
  assert.equal(isRetriableError(new SuspectResponseError({ htmlKind: 'blocked', status: 429 })), true);
  assert.equal(isRetriableError(new SessionExpiredError()), false, '会话失效必须仍然不可重试');
  console.log('  [证据] 判定：isSuspectResponse(SessionExpiredError)=false | isRetriableError(SuspectResponseError)=true');
});

// =========================== assertAlive 三档 ===========================

test('webdav + htmlKind=login：仍抛 SessionExpiredError，且只 fetch 1 次（不进入任何重试）', async () => {
  const { error, response, calls } = await fetchOnce(() =>
    htmlResponse({ url: WEBDAV_URL, body: '<html><body>Sign in to continue</body></html>' })
  );
  assert.equal(calls.length, 1, '登录页必须一次就停，绝不重试，实测 fetch 次数 ' + calls.length);
  assert.equal(response, null);
  assert.equal(error && error.name, 'SessionExpiredError');
  assert.ok(error instanceof SessionExpiredError);
  assert.equal(isSuspectResponse(error), false, '登录页绝不能被升级成可疑错误');
  assert.equal(isRetriableError(error), false);
  console.log('  [证据] 登录页：fetch=' + calls.length + ' 次，错误=' + error.name);
});

test('webdav + htmlKind=blocked / other：抛 SuspectResponseError，isSuspectResponse 与 isRetriableError 都为 true', async () => {
  const blocked = await fetchOnce(() =>
    htmlResponse({ url: WEBDAV_URL, status: 429, body: '<html><body>Too many requests, rate limit</body></html>' })
  );
  assert.equal(blocked.calls.length, 1, 'http 层自己不重试可疑：预算只记在 guard 里，绝不许两边各扣一次');
  assert.equal(blocked.error && blocked.error.name, 'SuspectResponseError');
  assert.ok(blocked.error instanceof SuspectResponseError);
  assert.equal(blocked.error.htmlKind, 'blocked');
  assert.equal(blocked.error.status, 429);
  assert.equal(blocked.error.path, WEBDAV_PATHNAME, 'path 只留 pathname');
  assert.equal(isSuspectResponse(blocked.error), true);
  assert.equal(isRetriableError(blocked.error), true);

  const other = await fetchOnce(() =>
    htmlResponse({ url: WEBDAV_URL, status: 503, body: '<html><body>Server hiccup</body></html>' })
  );
  assert.equal(other.calls.length, 1);
  assert.equal(other.error && other.error.name, 'SuspectResponseError');
  assert.equal(other.error.htmlKind, 'other', '读不懂的 HTML 归 other，同样算可疑');
  assert.equal(other.error.status, 503);
  assert.equal(isLeakFree(other.error.message), true);
  assert.equal(isLeakFree(other.error.path), true);
  console.log('  [证据] 可疑响应：', JSON.stringify({ blockedKind: blocked.error.htmlKind, otherKind: other.error.htmlKind, path: blocked.error.path }));
});

test('非 webdav 的 text/html 不判死（现状不改）；重定向到登录页仍是 SessionExpiredError', async () => {
  const plainPage = await fetchOnce(
    () => htmlResponse({ url: 'https://bb.cuhk.edu.cn/webapps/portal/frameset.jsp', body: '<html>portal</html>' }),
    'https://bb.cuhk.edu.cn/webapps/portal/frameset.jsp'
  );
  assert.equal(plainPage.error, null, '非 webdav 的 HTML 与改动前一样，不在这里判死');
  assert.ok(plainPage.response, '必须把响应原样交回去');
  assert.equal(plainPage.calls.length, 1);

  const redirected = await fetchOnce(() =>
    htmlResponse({ url: 'https://bb.cuhk.edu.cn/webapps/login?action=relogin&xid=1', body: '<html>idp</html>' })
  );
  assert.equal(redirected.calls.length, 1, '登录重定向一次就停');
  assert.equal(redirected.error && redirected.error.name, 'SessionExpiredError');
  assert.equal(isSuspectResponse(redirected.error), false);
  console.log('  [证据] 非 webdav HTML 放行；重定向登录页=' + redirected.error.name);
});

// =========================== 可疑预算 ===========================

test('可疑预算：连续可疑总尝试恰好 SUSPECT_ATTEMPTS 次，抛最后一个错误，普通预算一次都没被扣', async () => {
  const thrown = [];
  const retries = [];
  const delays = [];
  let calls = 0;
  await assert.rejects(
    () =>
      withFileRetry(
        async (attempt) => {
          calls += 1;
          assert.equal(attempt, calls, 'attempt 必须是单调的尝试序号');
          const err = new SuspectResponseError({ htmlKind: 'blocked', status: 429, path: WEBDAV_URL });
          thrown.push(err);
          throw err;
        },
        // 普通预算只有 1 次：能跑满 3 次本身就等于「可疑没吃普通额度」
        { attempts: 1, onRetry: (info) => retries.push(info), sleep: async (ms) => delays.push(ms) }
      ),
    (err) => {
      assert.ok(err instanceof SuspectResponseError);
      assert.equal(err, thrown[thrown.length - 1], '必须把最后一次错误原样抛出');
      return true;
    }
  );
  assert.equal(calls, SUSPECT_ATTEMPTS, '总尝试次数必须恰好等于 SUSPECT_ATTEMPTS');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1500, 4000], '可疑退避必须逐字是 1500 / 4000');
  assert.equal(retries.length, 2);
  assert.ok(retries.every((info) => info.suspect === true), '可疑重试必须在 onRetry 里标记 suspect');
  assert.ok(retries.every((info) => info.error.name === 'SuspectResponseError'));
  console.log('  [证据] 连续可疑：尝试=' + calls + ' 次，退避=' + JSON.stringify(delays) + '，onRetry=' + retries.length + ' 次');
});

test('两类预算各自计数：普通 5xx 与可疑交替时没人吃谁的额度，各自按自己的上限停', async () => {
  const counts = { normal: 0, suspect: 0 };
  const run = (plan) => {
    counts.normal = 0;
    counts.suspect = 0;
    let index = 0;
    return withFileRetry(
      async () => {
        const kind = plan[index];
        index += 1;
        if (kind === 'suspect') {
          counts.suspect += 1;
          throw new SuspectResponseError({ htmlKind: 'blocked', status: 429, path: WEBDAV_URL });
        }
        counts.normal += 1;
        throw new HttpError(500, WEBDAV_URL);
      },
      { attempts: 3, sleep: async () => {} }
    );
  };

  await assert.rejects(
    () => run(['normal', 'suspect', 'normal', 'suspect', 'normal']),
    (err) => {
      assert.equal(err.name, 'HttpError');
      assert.equal(err.status, 500);
      return true;
    }
  );
  assert.deepEqual(counts, { normal: 3, suspect: 2 }, '普通预算按自己的上限 3 停，可疑只记了 2 次');
  console.log('  [证据] 普通起始：', JSON.stringify(counts));

  await assert.rejects(
    () => run(['suspect', 'normal', 'suspect', 'normal', 'suspect']),
    (err) => {
      assert.ok(err instanceof SuspectResponseError);
      return true;
    }
  );
  assert.deepEqual(counts, { normal: 2, suspect: 3 }, '可疑预算按自己的上限 3 停，普通只记了 2 次');
  console.log('  [证据] 可疑起始：', JSON.stringify(counts));
});

test('可疑重试的 onRetry：reason 恒为契约固定文案、退避恒定，错误可见面不含 http / ? / xid', async () => {
  const retries = [];
  const errors = [];
  await assert.rejects(
    () =>
      withFileRetry(
        async () => {
          const err = new SuspectResponseError({ htmlKind: 'other', status: 200, path: WEBDAV_URL });
          errors.push(err);
          throw err;
        },
        { attempts: 1, onRetry: (info) => retries.push(info), sleep: async () => {} }
      ),
    (err) => isSuspectResponse(err)
  );
  assert.equal(retries.length, 2, '两次可疑重试都必须回调 onRetry（面板要显示第 N 次）');
  for (const info of retries) {
    assert.equal(info.reason, RETRY_SUSPECT_TEXT);
    assert.equal(info.reason, '服务器返回异常页面，稍后重试', 'reason 必须逐字等于契约固定文案');
    assert.ok(isLeakFree(info.reason), 'reason 不许带 http / ? / xid');
    assert.equal(info.error.name, 'SuspectResponseError');
  }
  assert.deepEqual(retries.map((info) => info.delayMs), [1500, 4000], '可疑退避不做抖动');
  for (const err of errors) {
    assert.ok(isLeakFree(err.message), 'message 不许带 http / ? / xid：' + err.message);
    assert.ok(isLeakFree(err.path), 'path 不许带 http / ? / xid：' + err.path);
    assert.equal(err.path, WEBDAV_PATHNAME);
  }
  console.log('  [证据] onRetry：', JSON.stringify(retries.map((info) => ({ reason: info.reason, delayMs: info.delayMs }))));
});

test('契约常量逐字对齐：SUSPECT_ATTEMPTS / SUSPECT_DELAYS / RETRY_SUSPECT_TEXT', () => {
  assert.equal(SUSPECT_ATTEMPTS, 3);
  assert.deepEqual(SUSPECT_DELAYS, [1500, 4000, 8000]);
  assert.equal(RETRY_SUSPECT_TEXT, '服务器返回异常页面，稍后重试');
});

test('可疑重试尊重调用方传入的 isRetriable：返回 false 时一次都不重试', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withFileRetry(
        async () => {
          calls += 1;
          throw new SuspectResponseError({ htmlKind: 'blocked', status: 429 });
        },
        { attempts: 3, isRetriable: () => false, sleep: async () => {} }
      ),
    (err) => isSuspectResponse(err)
  );
  assert.equal(calls, 1, '调用方显式关掉可重试时，可疑也必须一次就停');

  let defaultCalls = 0;
  await assert.rejects(
    () =>
      withFileRetry(
        async () => {
          defaultCalls += 1;
          throw new SuspectResponseError({ htmlKind: 'blocked', status: 429 });
        },
        { attempts: 3, sleep: async () => {} }
      ),
    (err) => isSuspectResponse(err)
  );
  assert.equal(defaultCalls, 3, '默认判定（isRetriableError）下可疑必须重试到 SUSPECT_ATTEMPTS');
  console.log('  [证据] isRetriable 覆盖：自定义=' + calls + ' 次，默认=' + defaultCalls + ' 次');
});
