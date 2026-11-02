/**
 * IndexedDB 薄封装（用户态持久化层）。
 *
 * 红线：任何一步失败都不得抛，只能退化为「不可用」。这段代码跑在别人的页面上，
 * 隐私模式 / 被企业策略禁用 / 配额耗尽 / 版本被别的标签页占着，都会让 IndexedDB
 * 抛错；一个异常绝不能把整条下载链路带崩。因此每个方法都有 resolve(null | false)
 * 的降级分支，available 也会随首次真实打开的结果翻转（打开失败即永久不可用）。
 *
 * 三个 store（keyPath 统一为 'id'）：
 * - manifests：一门课一条清单，id = courseId
 * - handles：上次选过的目录句柄，id = courseId（FileSystemDirectoryHandle 走结构化克隆）
 * - meta：零散键值预留位，版本 1 先建好，免得以后加字段又要升版本
 */

export const DB_NAME = 'bb-bulk-course-downloader';
export const DB_VERSION = 1;
export const STORE_NAMES = ['manifests', 'handles', 'meta'];

/** 键一律是字符串；空值算「没有键」，直接短路，不往库里写 'undefined' 这种污染键。 */
function toKey(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

/** 显式传入优先（显式 null 表示「明确不要 IDB」）；完全没传才回落到全局对象。 */
function pickFactory(explicit) {
  if (explicit !== undefined) {
    return explicit && typeof explicit.open === 'function' ? explicit : null;
  }
  const scope = typeof globalThis === 'undefined' ? null : globalThis.indexedDB;
  return scope && typeof scope.open === 'function' ? scope : null;
}

/** 打开库并补齐三个 store；任何失败都 resolve(null)，只由这里决定「可用 / 不可用」。 */
function openDatabase(factory) {
  return new Promise((resolve) => {
    let request;
    try {
      request = factory.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    if (!request || typeof request !== 'object') {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db) return;
      for (const name of STORE_NAMES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => resolve(null);
    // onblocked 不接管：只有别的标签页占着更旧的版本才会触发，我们只有版本 1，等它关掉即可。
  });
}

/**
 * 一个操作 = 一个事务，事务内不做任何 await。
 * （在事务里 await 会让事务落回事件循环后被提交，下一次 put 直接 TransactionInactiveError。）
 */
function runTx(db, storeNames, mode, fn) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(storeNames, mode);
    } catch (err) {
      reject(err);
      return;
    }
    const held = {};
    let settled = false;
    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve(held);
    };
    tx.onerror = () => {
      if (settled) return;
      settled = true;
      reject(tx.error || new Error('IndexedDB 事务失败'));
    };
    tx.onabort = () => {
      if (settled) return;
      settled = true;
      reject(tx.error || new Error('IndexedDB 事务中止'));
    };
    try {
      fn(tx, held);
    } catch (err) {
      try {
        tx.abort();
      } catch {
        /* 事务已经死了，abort 再抛也没关系 */
      }
      if (settled) return;
      settled = true;
      reject(err);
    }
  });
}

async function readValue(db, storeName, key) {
  const held = await runTx(db, storeName, 'readonly', (tx, out) => {
    const request = tx.objectStore(storeName).get(key);
    request.onsuccess = () => {
      out.value = request.result;
    };
  });
  return held.value === undefined ? null : held.value;
}

async function putValue(db, storeName, value) {
  await runTx(db, storeName, 'readwrite', (tx) => {
    tx.objectStore(storeName).put(value);
  });
  return true;
}

async function deleteValue(db, storeName, key) {
  await runTx(db, storeName, 'readwrite', (tx) => {
    tx.objectStore(storeName).delete(key);
  });
  return true;
}

/** records 容错三种写法：数组 / Map / 单个对象（调用方漏加 [] 不该崩）。 */
function toRecordList(records) {
  if (!records) return [];
  if (Array.isArray(records)) return records;
  if (records instanceof Map) return Array.from(records.values());
  if (typeof records === 'object') return [records];
  return [];
}

/**
 * @param {{ indexedDB?: IDBFactory | null }} [options]
 * @returns {{
 *   available: boolean,
 *   loadManifest(courseId: string): Promise<object | null>,
 *   saveManifest(courseId: string, manifest: object): Promise<boolean>,
 *   mergeFiles(courseId: string, records: Array<object>): Promise<object | null>,
 *   clearManifest(courseId: string): Promise<boolean>,
 *   loadHandle(courseId: string): Promise<object | null>,
 *   saveHandle(courseId: string, handle: object): Promise<boolean>,
 *   clearHandle(courseId: string): Promise<boolean>
 * }}
 */
export function makeStore({ indexedDB } = {}) {
  const factory = pickFactory(indexedDB);
  const state = { db: null, opening: null, dead: factory === null };

  async function ensureDb() {
    if (state.dead) return null;
    if (state.db) return state.db;
    if (!state.opening) {
      state.opening = openDatabase(factory).then((db) => {
        if (!db) {
          state.dead = true;
          return null;
        }
        state.db = db;
        return db;
      });
    }
    return state.opening;
  }

  async function readRecord(storeName, key) {
    const db = await ensureDb();
    if (!db) return null;
    try {
      return await readValue(db, storeName, key);
    } catch {
      return null;
    }
  }

  async function writeRecord(storeName, value) {
    const db = await ensureDb();
    if (!db) return false;
    try {
      return await putValue(db, storeName, value);
    } catch {
      return false;
    }
  }

  async function dropRecord(storeName, key) {
    const db = await ensureDb();
    if (!db) return false;
    try {
      return await deleteValue(db, storeName, key);
    } catch {
      return false;
    }
  }

  /** 清单记录 = 契约的数据形状 + 两把 id 键；读回时把 id 剥掉，形状与契约完全一致。 */
  async function loadManifest(courseId) {
    const key = toKey(courseId);
    if (!key) return null;
    const record = await readRecord('manifests', key);
    if (!record || typeof record !== 'object') return null;
    const next = { ...record };
    delete next.id;
    if (!next.files || typeof next.files !== 'object') next.files = {};
    return next;
  }

  async function saveManifest(courseId, manifest) {
    const key = toKey(courseId);
    if (!key) return false;
    const source = manifest && typeof manifest === 'object' ? manifest : {};
    return writeRecord('manifests', { ...source, id: key, courseId: source.courseId || key });
  }

  /**
   * 把一次（可含多条）下载结果并进清单。文件级浅合并：进度回调通常只带
   * { id, status, size }，靠合并保住已有记录里的 path / name，下一次才能按路径跳过。
   * 落库失败不阻止返回合并结果 —— 本次页面内还能继续按清单跳过，只是关掉页面会丢。
   */
  async function mergeFiles(courseId, records) {
    const key = toKey(courseId);
    if (!key) return null;
    const db = await ensureDb();
    if (!db) return null;
    const existing = await loadManifest(key);
    const base = existing || { courseId: key, version: 1, updatedAt: 0, files: {} };
    const files = { ...(base.files || {}) };
    for (const record of toRecordList(records)) {
      if (!record || record.id === null || record.id === undefined) continue;
      const id = String(record.id);
      const previous = files[id] && typeof files[id] === 'object' ? files[id] : {};
      files[id] = { ...previous, ...record, id };
    }
    const next = {
      courseId: base.courseId || key,
      version: Number.isFinite(base.version) ? base.version : 1,
      updatedAt: Date.now(),
      files
    };
    // 扫描历史存在同一条清单记录里，并进下载结果时不能顺手丢掉，否则下载中途刷新页面历史就没了。
    if (Array.isArray(base.scans)) next.scans = base.scans;
    await saveManifest(key, next);
    return next;
  }

  async function clearManifest(courseId) {
    const key = toKey(courseId);
    if (!key) return false;
    return dropRecord('manifests', key);
  }

  async function loadHandle(courseId) {
    const key = toKey(courseId);
    if (!key) return null;
    const record = await readRecord('handles', key);
    if (!record || typeof record !== 'object') return null;
    return record.handle || null;
  }

  async function saveHandle(courseId, handle) {
    const key = toKey(courseId);
    if (!key || !handle) return false;
    return writeRecord('handles', { id: key, handle });
  }

  async function clearHandle(courseId) {
    const key = toKey(courseId);
    if (!key) return false;
    return dropRecord('handles', key);
  }

  return {
    get available() {
      return !state.dead;
    },
    loadManifest,
    saveManifest,
    mergeFiles,
    clearManifest,
    loadHandle,
    saveHandle,
    clearHandle
  };
}
