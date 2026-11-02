import test from 'node:test';
import assert from 'node:assert/strict';

import { makeStore, DB_NAME, DB_VERSION, STORE_NAMES } from '../../src/store/db.js';
import { ensureDirectoryPermission } from '../../src/store/permissions.js';

// ---------------------------------------------------------------------------
// 内存版 IndexedDB 假实现：只覆盖 db.js 真正用到的那一小片 API
// （open / onupgradeneeded / createObjectStore / objectStoreNames.contains /
//   transaction / objectStore / get / put / delete / onsuccess / onerror / oncomplete）。
// 契约禁止引入 fake-indexeddb，所以这就是它的替身；每个操作都异步回调用微任务模拟。
// ---------------------------------------------------------------------------
function makeFakeIdb(options = {}) {
  const meta = {
    opened: [],
    storeKeyPaths: new Map(),
    failOpen: Boolean(options.failOpen),
    throwOnOpen: Boolean(options.throwOnOpen)
  };
  const databases = new Map();

  const later = (fn) => queueMicrotask(fn);
  const clone = (value) => {
    if (value === null || typeof value !== 'object') return value;
    try {
      return structuredClone(value);
    } catch {
      return value; // 句柄这类不可克隆的值按引用存，够测了
    }
  };

  function makeRequest() {
    return { result: undefined, error: null, onsuccess: null, onerror: null };
  }

  function run(tx, thunk) {
    const request = makeRequest();
    tx.inflight += 1;
    later(() => {
      let failure = null;
      try {
        request.result = thunk();
      } catch (err) {
        failure = err;
      }
      tx.inflight -= 1;
      if (failure) {
        tx.dead = true;
        tx.error = failure;
        request.error = failure;
        if (typeof request.onerror === 'function') request.onerror({ target: request });
        if (typeof tx.onerror === 'function') tx.onerror({ target: tx });
        return;
      }
      if (typeof request.onsuccess === 'function') request.onsuccess({ target: request });
      if (tx.inflight === 0) {
        later(() => {
          if (tx.dead) return;
          if (typeof tx.oncomplete === 'function') tx.oncomplete({ target: tx });
        });
      }
    });
    return request;
  }

  function storeOps(tx, rows, keyPath) {
    return {
      keyPath,
      get(key) {
        return run(tx, () => (rows.has(String(key)) ? clone(rows.get(String(key))) : undefined));
      },
      put(value) {
        return run(tx, () => {
          if (!value || typeof value !== 'object') throw new Error('DataError: put 只接受对象');
          const key = keyPath ? value[keyPath] : undefined;
          if (key === undefined || key === null) throw new Error('DataError: 缺少 keyPath ' + keyPath);
          rows.set(String(key), clone(value));
          return key;
        });
      },
      delete(key) {
        return run(tx, () => {
          rows.delete(String(key));
          return undefined;
        });
      }
    };
  }

  function openTransaction(db, names, mode) {
    const tx = { mode: mode || 'readonly', error: null, dead: false, inflight: 0, oncomplete: null, onerror: null, onabort: null };
    tx.objectStore = (name) => {
      if (!names.includes(name)) throw new Error('NotFoundError: 事务没带上 store ' + name);
      const entry = db.stores.get(name);
      if (!entry) throw new Error('NotFoundError: 没有 store ' + name);
      return storeOps(tx, entry.rows, entry.keyPath);
    };
    return tx;
  }

  const indexedDB = {
    open(name, version) {
      meta.opened.push({ name, version });
      if (meta.throwOnOpen) throw new Error('SecurityError: IndexedDB 被策略禁用');
      const request = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      later(() => {
        if (meta.failOpen) {
          request.error = new Error('InvalidStateError: 隐私模式下打不开');
          if (typeof request.onerror === 'function') request.onerror({ target: request });
          return;
        }
        let db = databases.get(name);
        const oldVersion = db ? db.version : 0;
        if (!db) {
          db = { name, version: version || 1, stores: new Map() };
          databases.set(name, db);
        }
        request.result = {
          name: db.name,
          version: db.version,
          objectStoreNames: { contains: (n) => db.stores.has(n) },
          createObjectStore(storeName, storeOptions) {
            if (db.stores.has(storeName)) throw new Error('ConstraintError: store 已存在 ' + storeName);
            const keyPath = storeOptions && storeOptions.keyPath ? String(storeOptions.keyPath) : null;
            db.stores.set(storeName, { keyPath, rows: new Map() });
            meta.storeKeyPaths.set(storeName, keyPath);
            return { name: storeName, keyPath };
          },
          transaction(names, mode) {
            return openTransaction(db, Array.isArray(names) ? names : [names], mode);
          },
          close() {}
        };
        const wanted = version || 1;
        if (oldVersion < wanted && typeof request.onupgradeneeded === 'function') {
          request.onupgradeneeded({ target: request, oldVersion, newVersion: wanted });
        }
        if (typeof request.onsuccess === 'function') request.onsuccess({ target: request });
      });
      return request;
    }
  };

  return { indexedDB, meta };
}

// ---------------------------------------------------------------- 不可用降级

test('没有 IndexedDB 时 available=false，七个方法全部 resolve null/false 且绝不抛（防：隐私模式下一个异常把整条下载链路带崩）', async () => {
  const store = makeStore({ indexedDB: null });
  assert.equal(store.available, false);
  assert.equal(await store.loadManifest('c'), null);
  assert.equal(await store.saveManifest('c', { files: {} }), false);
  assert.equal(await store.mergeFiles('c', [{ id: 'a', status: 'done', size: 1 }]), null);
  assert.equal(await store.clearManifest('c'), false);
  assert.equal(await store.loadHandle('c'), null);
  assert.equal(await store.saveHandle('c', { kind: 'directory', name: 'x' }), false);
  assert.equal(await store.clearHandle('c'), false);
});

test('makeStore() 不传参数也不炸（防：真实浏览器里解构 undefined 就抛，脚本根本没跑起来）', async () => {
  const store = makeStore();
  assert.equal(typeof store.loadManifest, 'function');
  assert.equal(await store.loadManifest('c'), null);
  assert.equal(await store.loadHandle('c'), null);
});

test('open 触发 error 后退化为不可用，后续调用一律 null/false（防：available 说 true，UI 一直等一份永远不会来的清单）', async () => {
  const fake = makeFakeIdb({ failOpen: true });
  const store = makeStore({ indexedDB: fake.indexedDB });
  assert.equal(await store.loadManifest('c'), null);
  assert.equal(store.available, false);
  assert.equal(await store.saveManifest('c', {}), false);
  assert.equal(await store.loadHandle('c'), null);
  assert.equal(await store.saveHandle('c', { name: 'x' }), false);
});

test('open 同步抛错也不能冒泡（防：加固浏览器在 indexedDB.open 上直接抛 SecurityError）', async () => {
  const fake = makeFakeIdb({ throwOnOpen: true });
  const store = makeStore({ indexedDB: fake.indexedDB });
  assert.equal(await store.loadManifest('c'), null);
  assert.equal(store.available, false);
});

// ---------------------------------------------------------------- 库结构

test('库名 / 版本 / 三个 store 的 keyPath 全部按契约建（防：改版本号或改 keyPath，让老用户已经存下的清单读不出来）', async () => {
  const fake = makeFakeIdb();
  const store = makeStore({ indexedDB: fake.indexedDB });
  assert.equal(store.available, true);
  await store.saveManifest('_16517_1', { courseId: '_16517_1', version: 1, updatedAt: 1, files: {} });
  assert.deepEqual(fake.meta.opened, [{ name: DB_NAME, version: DB_VERSION }]);
  assert.deepEqual([...fake.meta.storeKeyPaths.keys()].sort(), [...STORE_NAMES].sort());
  for (const keyPath of fake.meta.storeKeyPaths.values()) assert.equal(keyPath, 'id');
});

test('只打开一次库（防：每个方法都 open 一遍，把连接数吃光并让事务互相打断）', async () => {
  const fake = makeFakeIdb();
  const store = makeStore({ indexedDB: fake.indexedDB });
  await store.loadManifest('c');
  await store.saveManifest('c', { files: {} });
  await store.loadHandle('c');
  assert.equal(fake.meta.opened.length, 1);
});

// ---------------------------------------------------------------- 清单持久化

test('清单落库再读回，形状与契约完全一致（防：内部 id 键外泄，下游做 deepEqual / 序列化判断时全挂）', async () => {
  const fake = makeFakeIdb();
  const store = makeStore({ indexedDB: fake.indexedDB });
  const saved = {
    courseId: 'c1',
    version: 1,
    updatedAt: 123,
    files: { a: { id: 'a', path: 'Week 3/slides.pdf', name: 'slides.pdf', size: 10, status: 'done', updatedAt: 123 } }
  };
  assert.equal(await store.saveManifest('c1', saved), true);
  assert.deepEqual(await store.loadManifest('c1'), saved);
});

test('没存过的课程读回 null（防：把 undefined 当清单，planSkips 里 files 变成 undefined）', async () => {
  const fake = makeFakeIdb();
  const store = makeStore({ indexedDB: fake.indexedDB });
  assert.equal(await store.loadManifest('nope'), null);
  assert.equal(await store.loadHandle('nope'), null);
});

test('两个 store 实例共享同一个库，关掉页面再回来仍能读回清单（防：所谓持久化其实只存在内存里，「继续上次」是假的）', async () => {
  const fake = makeFakeIdb();
  const first = makeStore({ indexedDB: fake.indexedDB });
  await first.saveManifest('c', { courseId: 'c', version: 1, updatedAt: 1, files: { a: { id: 'a', path: 'a.pdf', size: 1, status: 'done' } } });
  const second = makeStore({ indexedDB: fake.indexedDB });
  const loaded = await second.loadManifest('c');
  assert.equal(loaded.courseId, 'c');
  assert.equal(loaded.files.a.status, 'done');
});

test('saveManifest 补全 courseId，调用方漏传也不会存出一条没有主人的清单（防：清单读回来后 courseId 缺失，无法和课程对上）', async () => {
  const fake = makeFakeIdb();
  const store = makeStore({ indexedDB: fake.indexedDB });
  await store.saveManifest('c2', { files: {} });
  const loaded = await store.loadManifest('c2');
  assert.equal(loaded.courseId, 'c2');
  assert.deepEqual(loaded.files, {});
});

test('mergeFiles 没有旧清单时新建一份并按 id 合并（防：下载进度永远落不了库，续传每次都从头开始）', async () => {
  const fake = makeFakeIdb();
  const store = makeStore({ indexedDB: fake.indexedDB });
  const merged = await store.mergeFiles('c', [{ id: 'a', status: 'done', size: 100 }]);
  assert.equal(merged.courseId, 'c');
  assert.equal(merged.version, 1);
  assert.equal(merged.files.a.status, 'done');
  assert.equal(merged.files.a.size, 100);
  assert.equal(typeof merged.updatedAt, 'number');
  const loaded = await store.loadManifest('c');
  assert.deepEqual(loaded.files.a, merged.files.a);
});

test('mergeFiles 保留记录里已有的 path/name，只更新本次带来的字段（防：进度回调只带 {id,status,size}，路径被覆盖后下次无法按路径跳过）', async () => {
  const fake = makeFakeIdb();
  const store = makeStore({ indexedDB: fake.indexedDB });
  await store.saveManifest('c', {
    courseId: 'c',
    version: 1,
    updatedAt: 1,
    files: { a: { id: 'a', path: 'Week 3/slides.pdf', name: 'slides.pdf', size: null, status: 'partial', updatedAt: 1 } }
  });
  const merged = await store.mergeFiles('c', [{ id: 'a', status: 'done', size: 1234 }]);
  assert.equal(merged.files.a.path, 'Week 3/slides.pdf');
  assert.equal(merged.files.a.name, 'slides.pdf');
  assert.equal(merged.files.a.status, 'done');
  assert.equal(merged.files.a.size, 1234);
});

test('mergeFiles 并下载结果时保留清单里的扫描历史（防：下载进度一落库，IndexedDB 里的扫描历史被清空）', async () => {
  const fake = makeFakeIdb();
  const store = makeStore({ indexedDB: fake.indexedDB });
  const scans = [{ at: 1234, diff: { added: 2, changed: 1, moved: 0, unchanged: 5, unknown: 0, stale: 1, total: 9 }, changedPaths: ['Week 1/a.pdf'] }];
  await store.saveManifest('c', { courseId: 'c', version: 2, updatedAt: 1, files: {}, scans });
  const merged = await store.mergeFiles('c', [{ id: 'a', status: 'done', size: 100 }]);
  assert.deepEqual(merged.scans, scans);
  const loaded = await store.loadManifest('c');
  assert.deepEqual(loaded.scans, scans);
  assert.equal(loaded.files.a.status, 'done');
});

test('mergeFiles 跳过没有 id 的脏记录，不写进清单（防：一条残缺的进度事件把清单变成不可用）', async () => {
  const fake = makeFakeIdb();
  const store = makeStore({ indexedDB: fake.indexedDB });
  const merged = await store.mergeFiles('c', [{ status: 'done', size: 1 }, null, { id: 'b', status: 'failed', size: null }]);
  assert.deepEqual(Object.keys(merged.files), ['b']);
});

test('clearManifest 之后读回 null（防：换了目录或想重下时旧清单还在，把所有文件判成「已完成」而全跳过）', async () => {
  const fake = makeFakeIdb();
  const store = makeStore({ indexedDB: fake.indexedDB });
  await store.saveManifest('c', { courseId: 'c', version: 1, updatedAt: 1, files: {} });
  assert.equal(await store.clearManifest('c'), true);
  assert.equal(await store.loadManifest('c'), null);
});

// ---------------------------------------------------------------- 目录句柄

test('目录句柄能存能取能删（防：每次回来都要重新选目录，「继续上次」按钮形同虚设）', async () => {
  const fake = makeFakeIdb();
  const store = makeStore({ indexedDB: fake.indexedDB });
  const handle = { kind: 'directory', name: '课件' };
  assert.equal(await store.loadHandle('c'), null);
  assert.equal(await store.saveHandle('c', handle), true);
  assert.deepEqual(await store.loadHandle('c'), handle);
  assert.equal(await store.clearHandle('c'), true);
  assert.equal(await store.loadHandle('c'), null);
});

test('句柄为空的 saveHandle 直接返回 false，不写脏数据（防：用户取消选择后存了个空值，下次启动读出来当成有效目录）', async () => {
  const fake = makeFakeIdb();
  const store = makeStore({ indexedDB: fake.indexedDB });
  assert.equal(await store.saveHandle('c', null), false);
  assert.equal(await store.saveHandle('c', undefined), false);
  assert.equal(await store.loadHandle('c'), null);
});

// ---------------------------------------------------------------- 键守卫

test('空 courseId 一律短路（防：mount 早退时 courseId 是 undefined，键变成字符串 "undefined" 污染清单）', async () => {
  const fake = makeFakeIdb();
  const store = makeStore({ indexedDB: fake.indexedDB });
  assert.equal(await store.loadManifest(''), null);
  assert.equal(await store.loadManifest(null), null);
  assert.equal(await store.saveManifest(undefined, { files: {} }), false);
  assert.equal(await store.mergeFiles('', [{ id: 'a' }]), null);
  assert.equal(await store.clearHandle(null), false);
  assert.deepEqual(fake.meta.opened, []);
});

// ---------------------------------------------------------------- permissions

test('没有 handle 就是 unsupported（防：把「用户压根没选目录」说成「被拒绝」，UI 讲错话）', async () => {
  assert.equal(await ensureDirectoryPermission(null), 'unsupported');
  assert.equal(await ensureDirectoryPermission(undefined, { request: true }), 'unsupported');
});

test('默认只查询、不弹授权框（防：没有用户手势时调 requestPermission，Chrome 直接抛 SecurityError）', async () => {
  const calls = [];
  const handle = {
    async queryPermission(options) {
      calls.push(['query', options.mode]);
      return 'granted';
    },
    async requestPermission(options) {
      calls.push(['request', options.mode]);
      return 'granted';
    }
  };
  assert.equal(await ensureDirectoryPermission(handle), 'granted');
  assert.deepEqual(calls, [['query', 'readwrite']]);
});

test('request:true 时 requestPermission 在返回 promise 之前就被同步调用（防：函数体里先 await 一下，用户手势就过期了）', () => {
  const calls = [];
  const handle = {
    async requestPermission(options) {
      calls.push(options.mode);
      return 'granted';
    }
  };
  const pending = ensureDirectoryPermission(handle, { request: true, mode: 'read' });
  assert.deepEqual(calls, ['read'], '调用必须发生在同一个同步栈里');
  return pending;
});

test('granted / prompt / denied 原样透传（防：把 prompt 当 granted，写盘时才失败；把 denied 当 granted，用户被反复重试）', async () => {
  for (const state of ['granted', 'prompt', 'denied']) {
    assert.equal(await ensureDirectoryPermission({ async queryPermission() { return state; } }), state);
    assert.equal(await ensureDirectoryPermission({ async requestPermission() { return state; } }, { request: true }), state);
  }
});

test('任何抛错都返回 denied、不冒泡（防：授权失败把整个下载流程带崩，用户只看到控制台报错）', async () => {
  const throwing = async () => {
    throw new Error('NotAllowedError: 需要用户手势');
  };
  assert.equal(await ensureDirectoryPermission({ queryPermission: throwing }), 'denied');
  assert.equal(await ensureDirectoryPermission({ requestPermission: throwing }, { request: true }), 'denied');
});

test('没有权限 API 的 handle → unsupported（防：无 FSA 环境被当成已授权，真正写盘时才发现不行）', async () => {
  assert.equal(await ensureDirectoryPermission({ kind: 'directory', name: 'x' }), 'unsupported');
  assert.equal(await ensureDirectoryPermission({ requestPermission: null }), 'unsupported');
});

test('没见过的返回值退化为 prompt，绝不误报 granted（防：浏览器给了个未知状态就被当成已授权）', async () => {
  assert.equal(await ensureDirectoryPermission({ async queryPermission() { return undefined; } }), 'prompt');
  assert.equal(await ensureDirectoryPermission({ async queryPermission() { return 'maybe'; } }), 'prompt');
});
