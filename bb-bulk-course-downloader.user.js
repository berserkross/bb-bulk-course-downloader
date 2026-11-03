// ==UserScript==
// @name         BB 课件批量下载
// @namespace    bb-bulk-course-downloader
// @version      2.8.1
// @description  扫描 Blackboard 课程内容，勾选后按原始目录结构批量下载课件
// @updateURL    https://raw.githubusercontent.com/berserkross/bb-bulk-course-downloader/main/bb-bulk-course-downloader.user.js
// @downloadURL  https://raw.githubusercontent.com/berserkross/bb-bulk-course-downloader/main/bb-bulk-course-downloader.user.js
// @match        https://*/webapps/blackboard/content/listContent.jsp*
// @match        http://*/webapps/blackboard/content/listContent.jsp*
// @grant        none
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __esm = (fn, res) => function __init() {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  };
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // src/sinks/shared.js
  function toMessage(err) {
    if (!err) return "\u672A\u77E5\u9519\u8BEF";
    return err.message || String(err);
  }
  function isAbort2(err) {
    if (!err) return false;
    return err.name === "AbortError" || err.code === 20;
  }
  function planFor(entry, { preserveTree, files: files3 }) {
    const raw = files3.buildEntryPath(entry, { preserveTree: Boolean(preserveTree) }) || {};
    const segments = (Array.isArray(raw.segments) ? raw.segments : []).map((seg) => files3.sanitizeSegment(String(seg))).filter(Boolean);
    const fileName = files3.sanitizeSegment(String(raw.fileName || entry.name || "download")) || "download";
    return { segments, fileName };
  }
  function planBatch(entries, { preserveTree, files: files3 }) {
    const plans = entries.map((entry) => planFor(entry, { preserveTree, files: files3 }));
    const unique = typeof files3.dedupePaths === "function" ? files3.dedupePaths(plans) : plans;
    return unique.map((plan, i) => ({
      entry: entries[i],
      segments: Array.isArray(plan.segments) ? plan.segments.map(String) : [],
      fileName: String(plan.fileName)
    }));
  }
  function createReporter({ onProgress, throttleMs = 120 } = {}) {
    let last = 0;
    return function report(payload, force = false) {
      if (!onProgress) return;
      const now = Date.now();
      if (!force && now - last < throttleMs) return;
      last = now;
      onProgress(payload);
    };
  }
  function relativePath(plan) {
    const segments = Array.isArray(plan && plan.segments) ? plan.segments : [];
    const name = String(plan && plan.fileName || "");
    return segments.concat(name).filter(Boolean).join("/");
  }
  function stripQuery(url) {
    const text = String(url == null ? "" : url);
    const cut = text.search(/[?#]/);
    return cut === -1 ? text : text.slice(0, cut);
  }
  function redactUrls(message) {
    return String(message == null ? "" : message).replace(/https?:\/\/[^\s"'<>()\[\]{}，。；）]+/g, (url) => stripQuery(url));
  }
  function createProgressTracker(filesTotal = 0) {
    const tracker = {
      filesTotal: Math.max(0, Math.floor(filesTotal) || 0),
      filesDone: 0,
      bytesDone: 0,
      bytesTotal: 0,
      failed: 0,
      // 并发下真正的 entryId 由 progressPayload 的第四个参数显式传入：
      // tracker 上的这个值只是「没有显式传参时」的默认值，避免共享 tracker 张冠李戴。
      entryId: ""
    };
    tracker.addBytes = (delta) => {
      const n = Number(delta);
      if (Number.isFinite(n) && n > 0) tracker.bytesDone += n;
    };
    tracker.rollbackBytes = (delta) => {
      const n = Number(delta);
      if (!Number.isFinite(n) || n <= 0) return;
      tracker.bytesDone = Math.max(0, tracker.bytesDone - n);
    };
    tracker.endFile = (isFailed) => {
      tracker.filesDone += 1;
      if (isFailed) tracker.failed += 1;
    };
    return tracker;
  }
  function progressPayload(tracker, state, currentPath = "", entryId) {
    const id = entryId == null ? tracker.entryId : entryId;
    return {
      state,
      name: currentPath,
      done: tracker.filesDone,
      failed: tracker.failed,
      total: tracker.filesTotal,
      bytes: tracker.bytesDone,
      entryId: id == null ? "" : String(id),
      filesDone: tracker.filesDone,
      filesTotal: tracker.filesTotal,
      bytesDone: tracker.bytesDone,
      bytesTotal: tracker.bytesTotal,
      currentPath
    };
  }
  function toFailure(entry, plan, err) {
    const path = relativePath(plan);
    const fallbackName = String(entry && entry.name || "");
    return {
      entry,
      name: plan && plan.fileName || fallbackName,
      path,
      url: String(entry && entry.url || ""),
      error: redactUrls(toMessage(err)) || "\u4E0B\u8F7D\u5931\u8D25\uFF08\u672A\u63D0\u4F9B\u539F\u56E0\uFF09"
    };
  }
  function retryReason(err) {
    if (!err) return "\u4E0B\u8F7D\u4E2D\u65AD\uFF0C\u91CD\u8BD5\u4E00\u6B21";
    const name = String(err.name || "");
    if (name === "StallError") return "\u8FDE\u63A5\u505C\u6EDE\uFF0C\u592A\u4E45\u6CA1\u6709\u6536\u5230\u65B0\u6570\u636E";
    if (name === "TruncatedError") return "\u6587\u4EF6\u6CA1\u6709\u4E0B\u8F7D\u5B8C\u6574";
    if (name === "TypeError") return "\u7F51\u7EDC\u8FDE\u63A5\u4E2D\u65AD";
    const status = Number(err.status);
    if (Number.isFinite(status)) {
      if (status === 429) return "\u8BF7\u6C42\u88AB\u9650\u6D41";
      if (status >= 500) return "\u670D\u52A1\u5668\u6682\u65F6\u4E0D\u53EF\u7528";
      return "\u8BF7\u6C42\u5931\u8D25\uFF08HTTP " + status + "\uFF09";
    }
    return "\u4E0B\u8F7D\u4E2D\u65AD\uFF0C\u91CD\u8BD5\u4E00\u6B21";
  }
  function listPending(list, ok, failed) {
    const landed = new Set(ok || []);
    const failedEntries = new Set((failed || []).map((item) => item && item.entry));
    return Array.from(list || []).filter((entry) => !landed.has(entry) && !failedEntries.has(entry));
  }
  function createFileEmitter(onFileEvent) {
    if (typeof onFileEvent !== "function") return () => {
    };
    return function emitFile(event) {
      try {
        onFileEvent(event);
      } catch {
      }
    };
  }
  function createEntryNamer({ files: files3, resolveFileName: resolveFileName2 } = {}) {
    const resolve = typeof resolveFileName2 === "function" ? resolveFileName2 : null;
    const dedupe = files3 && typeof files3.dedupePaths === "function" ? files3.dedupePaths : null;
    const sanitize = files3 && typeof files3.sanitizeSegment === "function" ? files3.sanitizeSegment : null;
    const dirs = /* @__PURE__ */ new Map();
    const resolvedNames = /* @__PURE__ */ new Map();
    function dirOf(plan) {
      const segments = Array.isArray(plan && plan.segments) ? plan.segments : [];
      const key = segments.join("\0");
      let bucket = dirs.get(key);
      if (!bucket) {
        bucket = /* @__PURE__ */ new Map();
        dirs.set(key, bucket);
      }
      return bucket;
    }
    function claim(plan, name) {
      const bucket = dirOf(plan);
      const taken = [];
      for (const [owner, used] of bucket) if (owner !== plan) taken.push(String(used));
      let chosen = name;
      if (dedupe && taken.length) {
        const seeded = taken.map((used) => ({ segments: [], fileName: used }));
        seeded.push({ segments: [], fileName: name });
        chosen = String(dedupe(seeded)[seeded.length - 1].fileName);
      }
      bucket.set(plan, chosen);
      return chosen;
    }
    return {
      /** 批次开始就把计划名登记上：还没开始的那些名字同样要挡住「后解析出来的真名」。 */
      reserve(plan) {
        if (!plan) return "";
        if (plan.fileName) claim(plan, String(plan.fileName));
        return String(plan.fileName);
      },
      /**
       * 响应到达之后按契约 §1.3 解析真名，成功就就地替换 plan.fileName。
       * 既无 disposition 又无 url 时一概不动：只有 title 兜底时，preserveTree=false 的
       * 「folder__name」计划名会被改回裸名，那是既有行为的倒退。
       */
      resolve(plan, entry, response) {
        if (!plan) return "";
        const current = String(plan.fileName);
        if (!resolve) return current;
        const headers = response && response.headers;
        const header = (field) => {
          const raw2 = headers && typeof headers.get === "function" ? headers.get(field) : "";
          return raw2 == null ? "" : String(raw2);
        };
        const disposition = header("content-disposition");
        const finalUrl = response && typeof response.url === "string" ? response.url : "";
        if (!disposition && !finalUrl) return current;
        let raw = "";
        try {
          raw = resolve({
            disposition,
            finalUrl,
            href: entry && entry.href != null ? String(entry.href) : "",
            title: entry && entry.name != null ? String(entry.name) : "",
            mime: header("content-type").split(";")[0].trim().toLowerCase()
          });
        } catch {
          return current;
        }
        const name = raw == null ? "" : String(raw);
        if (!name) return current;
        if (resolvedNames.get(plan) === name) return current;
        const clean = sanitize ? sanitize(name) : name;
        if (!clean || clean === current) return current;
        resolvedNames.set(plan, name);
        plan.fileName = claim(plan, clean);
        return String(plan.fileName);
      }
    };
  }
  function withHalted(result, halted) {
    Object.defineProperty(result, "halted", {
      value: halted == null ? null : halted,
      enumerable: false,
      writable: true,
      configurable: true
    });
    return result;
  }
  function withDegraded(result, degraded) {
    Object.defineProperty(result, "degraded", {
      value: degraded == null ? null : degraded,
      enumerable: false,
      writable: true,
      configurable: true
    });
    return result;
  }
  var init_shared = __esm({
    "src/sinks/shared.js"() {
    }
  });

  // src/store/db.js
  var db_exports = {};
  __export(db_exports, {
    DB_NAME: () => DB_NAME,
    DB_VERSION: () => DB_VERSION,
    STORE_NAMES: () => STORE_NAMES,
    makeStore: () => makeStore
  });
  function toKey(value) {
    if (value === null || value === void 0) return "";
    return String(value);
  }
  function pickFactory(explicit) {
    if (explicit !== void 0) {
      return explicit && typeof explicit.open === "function" ? explicit : null;
    }
    const scope = typeof globalThis === "undefined" ? null : globalThis.indexedDB;
    return scope && typeof scope.open === "function" ? scope : null;
  }
  function openDatabase(factory) {
    return new Promise((resolve) => {
      let request;
      try {
        request = factory.open(DB_NAME, DB_VERSION);
      } catch {
        resolve(null);
        return;
      }
      if (!request || typeof request !== "object") {
        resolve(null);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db) return;
        for (const name of STORE_NAMES) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    });
  }
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
        reject(tx.error || new Error("IndexedDB \u4E8B\u52A1\u5931\u8D25"));
      };
      tx.onabort = () => {
        if (settled) return;
        settled = true;
        reject(tx.error || new Error("IndexedDB \u4E8B\u52A1\u4E2D\u6B62"));
      };
      try {
        fn(tx, held);
      } catch (err) {
        try {
          tx.abort();
        } catch {
        }
        if (settled) return;
        settled = true;
        reject(err);
      }
    });
  }
  async function readValue(db, storeName, key) {
    const held = await runTx(db, storeName, "readonly", (tx, out) => {
      const request = tx.objectStore(storeName).get(key);
      request.onsuccess = () => {
        out.value = request.result;
      };
    });
    return held.value === void 0 ? null : held.value;
  }
  async function putValue(db, storeName, value) {
    await runTx(db, storeName, "readwrite", (tx) => {
      tx.objectStore(storeName).put(value);
    });
    return true;
  }
  async function deleteValue(db, storeName, key) {
    await runTx(db, storeName, "readwrite", (tx) => {
      tx.objectStore(storeName).delete(key);
    });
    return true;
  }
  function toRecordList(records) {
    if (!records) return [];
    if (Array.isArray(records)) return records;
    if (records instanceof Map) return Array.from(records.values());
    if (typeof records === "object") return [records];
    return [];
  }
  function makeStore({ indexedDB } = {}) {
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
    async function loadManifest(courseId) {
      const key = toKey(courseId);
      if (!key) return null;
      const record = await readRecord("manifests", key);
      if (!record || typeof record !== "object") return null;
      const next = { ...record };
      delete next.id;
      if (!next.files || typeof next.files !== "object") next.files = {};
      return next;
    }
    async function saveManifest(courseId, manifest) {
      const key = toKey(courseId);
      if (!key) return false;
      const source = manifest && typeof manifest === "object" ? manifest : {};
      return writeRecord("manifests", { ...source, id: key, courseId: source.courseId || key });
    }
    async function mergeFiles(courseId, records) {
      const key = toKey(courseId);
      if (!key) return null;
      const db = await ensureDb();
      if (!db) return null;
      const existing = await loadManifest(key);
      const base = existing || { courseId: key, version: 1, updatedAt: 0, files: {} };
      const files3 = { ...base.files || {} };
      for (const record of toRecordList(records)) {
        if (!record || record.id === null || record.id === void 0) continue;
        const id = String(record.id);
        const previous = files3[id] && typeof files3[id] === "object" ? files3[id] : {};
        files3[id] = { ...previous, ...record, id };
      }
      const next = {
        courseId: base.courseId || key,
        version: Number.isFinite(base.version) ? base.version : 1,
        updatedAt: Date.now(),
        files: files3
      };
      if (Array.isArray(base.scans)) next.scans = base.scans;
      await saveManifest(key, next);
      return next;
    }
    async function clearManifest(courseId) {
      const key = toKey(courseId);
      if (!key) return false;
      return dropRecord("manifests", key);
    }
    async function loadHandle(courseId) {
      const key = toKey(courseId);
      if (!key) return null;
      const record = await readRecord("handles", key);
      if (!record || typeof record !== "object") return null;
      return record.handle || null;
    }
    async function saveHandle(courseId, handle) {
      const key = toKey(courseId);
      if (!key || !handle) return false;
      return writeRecord("handles", { id: key, handle });
    }
    async function clearHandle(courseId) {
      const key = toKey(courseId);
      if (!key) return false;
      return dropRecord("handles", key);
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
  var DB_NAME, DB_VERSION, STORE_NAMES;
  var init_db = __esm({
    "src/store/db.js"() {
      DB_NAME = "bb-bulk-course-downloader";
      DB_VERSION = 1;
      STORE_NAMES = ["manifests", "handles", "meta"];
    }
  });

  // src/store/permissions.js
  var permissions_exports = {};
  __export(permissions_exports, {
    ensureDirectoryPermission: () => ensureDirectoryPermission
  });
  function normalize(value) {
    return KNOWN.has(value) ? value : "prompt";
  }
  async function ensureDirectoryPermission(handle, { mode = "readwrite", request = false } = {}) {
    if (!handle) return "unsupported";
    const options = { mode };
    try {
      if (request && typeof handle.requestPermission === "function") {
        return normalize(await handle.requestPermission(options));
      }
      if (typeof handle.queryPermission === "function") {
        return normalize(await handle.queryPermission(options));
      }
      return "unsupported";
    } catch {
      return "denied";
    }
  }
  var KNOWN;
  var init_permissions = __esm({
    "src/store/permissions.js"() {
      KNOWN = /* @__PURE__ */ new Set(["granted", "prompt", "denied"]);
    }
  });

  // src/store/manifest-plan.js
  var manifest_plan_exports = {};
  __export(manifest_plan_exports, {
    planSkips: () => planSkips
  });
  function knownSize(value) {
    if (value === null || value === void 0 || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  function planId(plan) {
    const id = plan && plan.entry ? plan.entry.id : null;
    return id === null || id === void 0 ? "" : String(id);
  }
  function recordPath(record) {
    return record && record.path !== null && record.path !== void 0 ? String(record.path) : "";
  }
  function planHref(plan) {
    const raw = plan && plan.entry ? plan.entry.href : null;
    return raw === null || raw === void 0 ? "" : String(raw).trim();
  }
  function recordHref(record) {
    const raw = record ? record.href : null;
    return raw === null || raw === void 0 ? "" : String(raw).trim();
  }
  function verdictOf({ record, statusDone, pathEqual, uncertain, prevHref, href }) {
    if (!record) return "added";
    if (!statusDone) return "unknown";
    if (uncertain) return "unknown";
    if (!prevHref || !href) return "unknown";
    if (prevHref !== href) return "changed";
    return pathEqual ? "unchanged" : "moved";
  }
  function planSkips({ plans, manifest, existingPaths, preserveTree = true, scanFailed = false } = {}) {
    const list = Array.isArray(plans) ? plans : [];
    const disk = existingPaths && typeof existingPaths.has === "function" ? existingPaths : /* @__PURE__ */ new Map();
    const files3 = manifest && manifest.files && typeof manifest.files === "object" ? manifest.files : {};
    const uncertain = disk.truncated === true || scanFailed === true;
    const todo = [];
    const changedPaths = [];
    const skip = [];
    const matched = /* @__PURE__ */ new Set();
    const diff = { added: 0, changed: 0, moved: 0, unchanged: 0, stale: 0, unknown: 0, total: list.length };
    for (const plan of list) {
      const path = relativePath(plan);
      const id = planId(plan);
      const record = id && Object.prototype.hasOwnProperty.call(files3, id) ? files3[id] : null;
      const entrySize = knownSize(plan && plan.entry ? plan.entry.size : void 0);
      const recordSize = knownSize(record ? record.size : null);
      const expected = recordSize !== null ? recordSize : entrySize;
      const statusDone = Boolean(record) && record.status === "done";
      const pathEqual = recordPath(record) === path;
      const prevHref = recordHref(record);
      const href = planHref(plan);
      if (id) matched.add(id);
      const verdict = verdictOf({ record, statusDone, pathEqual, uncertain, prevHref, href });
      const hrefOverwritten = statusDone && prevHref !== "" && href !== "" && prevHref !== href;
      if (hrefOverwritten) {
        todo.push(plan);
        changedPaths.push({ id, path });
        diff.changed += 1;
        continue;
      }
      if (record && !statusDone) {
        todo.push(plan);
        diff.unknown += 1;
        continue;
      }
      if (disk.has(path)) {
        const diskSize = knownSize(disk.get(path));
        if (diskSize !== null && expected !== null) {
          if (diskSize === expected) {
            skip.push({ plan, reason: "disk", size: diskSize });
            if (record) diff.unchanged += 1;
            else diff.added += 1;
            continue;
          }
          todo.push(plan);
          if (statusDone) {
            changedPaths.push({ id, path });
            diff.changed += 1;
          } else diff.unknown += 1;
          continue;
        }
        if (uncertain) {
          todo.push(plan);
          diff.unknown += 1;
          continue;
        }
        skip.push({ plan, reason: "disk-unverified", size: diskSize !== null ? diskSize : expected });
        diff.unknown += 1;
        continue;
      }
      if (verdict === "added") {
        todo.push(plan);
        diff.added += 1;
        continue;
      }
      if (verdict === "moved") {
        todo.push(plan);
        diff.moved += 1;
        continue;
      }
      if (verdict === "unchanged") {
        skip.push({ plan, reason: "manifest-unchanged", size: recordSize });
        diff.unchanged += 1;
        continue;
      }
      todo.push(plan);
      diff.unknown += 1;
    }
    const stale = [];
    for (const id of Object.keys(files3)) {
      if (matched.has(id)) continue;
      stale.push({ id, path: recordPath(files3[id]) });
    }
    diff.stale = stale.length;
    return { todo, skip, stale, diff, changedPaths };
  }
  var init_manifest_plan = __esm({
    "src/store/manifest-plan.js"() {
      init_shared();
    }
  });

  // src/store/manifest.js
  var manifest_exports = {};
  __export(manifest_exports, {
    appendScanHistory: () => appendScanHistory,
    exportManifestPack: () => exportManifestPack,
    importManifestPack: () => importManifestPack,
    mergeManifests: () => mergeManifests,
    recordFromPlan: () => recordFromPlan,
    updateRecords: () => updateRecords
  });
  function knownSize2(value) {
    if (value === null || value === void 0 || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  function planId2(plan) {
    const id = plan && plan.entry ? plan.entry.id : null;
    return id === null || id === void 0 ? "" : String(id);
  }
  function normalizeStatus(value) {
    return STATUSES.has(value) ? value : "failed";
  }
  function stamp(now) {
    return Number.isFinite(now) ? now : Date.now();
  }
  function planHref2(plan) {
    const raw = plan && plan.entry ? plan.entry.href : null;
    return raw === null || raw === void 0 ? "" : String(raw).trim();
  }
  function recordHrefOf(record) {
    const raw = record ? record.href : null;
    return raw === null || raw === void 0 ? "" : String(raw).trim();
  }
  function recordPathOf(record) {
    return record && record.path !== null && record.path !== void 0 ? String(record.path) : "";
  }
  function lastSegmentOf(path) {
    const text = String(path);
    const at = text.lastIndexOf("/");
    return at < 0 ? text : text.slice(at + 1);
  }
  function recordFromPlan(plan, { status, size, now } = {}) {
    return {
      id: planId2(plan),
      href: planHref2(plan),
      path: relativePath(plan),
      name: plan && plan.fileName !== null && plan.fileName !== void 0 ? String(plan.fileName) : "",
      size: knownSize2(size),
      status: normalizeStatus(status),
      updatedAt: stamp(now)
    };
  }
  function updateRecords(manifest, plans, results, now) {
    const source = manifest && typeof manifest === "object" ? manifest : null;
    const files3 = { ...source && source.files || {} };
    const byId = /* @__PURE__ */ new Map();
    for (const plan of Array.isArray(plans) ? plans : []) {
      const id = planId2(plan);
      if (id) byId.set(id, plan);
    }
    for (const result of Array.isArray(results) ? results : []) {
      if (!result || result.id === null || result.id === void 0) continue;
      const id = String(result.id);
      const plan = byId.get(id) || null;
      const fresh = recordFromPlan(plan, { status: result.status, size: result.size, now });
      const previous = files3[id] && typeof files3[id] === "object" ? files3[id] : {};
      const donePath = result.status === "done" && typeof result.path === "string" && result.path ? result.path : "";
      const keptPath = plan ? fresh.path : recordPathOf(previous);
      const keptName = plan ? fresh.name : String(previous.name === void 0 || previous.name === null ? "" : previous.name);
      files3[id] = {
        id,
        // plan 缺席（理论上不该发生）时保留上一版的 href / path，不能让清单丢字段变成死记录。
        href: plan ? fresh.href : recordHrefOf(previous),
        path: donePath || keptPath,
        name: donePath ? textOf(result.name) || lastSegmentOf(donePath) || keptName : keptName,
        size: fresh.size,
        status: fresh.status,
        updatedAt: fresh.updatedAt
      };
    }
    return {
      courseId: source && source.courseId ? String(source.courseId) : "",
      version: MANIFEST_VERSION,
      updatedAt: stamp(now),
      ...Array.isArray(source?.scans) ? { scans: source.scans } : {},
      files: files3
    };
  }
  function countOr0(value) {
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }
  function capOf(cap) {
    return Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : SCAN_HISTORY_CAP;
  }
  function textOf(value) {
    return value === null || value === void 0 ? "" : String(value);
  }
  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }
  function changedPathsOf(list) {
    const out = [];
    for (const item of Array.isArray(list) ? list : []) {
      if (!isPlainObject(item)) continue;
      const id = textOf(item.id);
      if (!id) continue;
      out.push({ id, path: textOf(item.path) });
    }
    return out;
  }
  function appendScanHistory(manifest, snapshot, cap = SCAN_HISTORY_CAP) {
    const source = isPlainObject(manifest) ? manifest : {};
    const snap = isPlainObject(snapshot) ? snapshot : {};
    const previous = Array.isArray(source.scans) ? source.scans : [];
    const entry = {
      at: stamp(snap.at),
      total: countOr0(snap.total),
      added: countOr0(snap.added),
      changed: countOr0(snap.changed),
      moved: countOr0(snap.moved),
      unchanged: countOr0(snap.unchanged),
      unknown: countOr0(snap.unknown),
      stale: countOr0(snap.stale),
      changedPaths: changedPathsOf(snap.changedPaths)
    };
    return {
      ...source,
      // 落库是整条覆盖：files 必须是对象，否则一次拼错字段的调用就能把清单的 files 抹掉。
      files: isPlainObject(source.files) ? source.files : {},
      version: Number.isFinite(source.version) ? source.version : MANIFEST_VERSION,
      // 老条目原样保留、只在尾部截断：历史是既成事实，不再「重新解释」一遍。
      scans: [entry, ...previous].slice(0, capOf(cap))
    };
  }
  function packRecord(record, fallbackId, now) {
    const src = isPlainObject(record) ? record : {};
    return {
      id: textOf(src.id) || fallbackId,
      href: recordHrefOf(src),
      path: recordPathOf(src),
      name: textOf(src.name),
      size: knownSize2(src.size),
      status: normalizeStatus(src.status),
      updatedAt: Number.isFinite(src.updatedAt) ? src.updatedAt : now
    };
  }
  function packFiles(container, now) {
    const files3 = {};
    const raw = isPlainObject(container) && isPlainObject(container.files) ? container.files : {};
    for (const [key, record] of Object.entries(raw)) {
      const id = textOf(key);
      if (!id || !isPlainObject(record)) continue;
      files3[id] = packRecord(record, id, now);
    }
    return files3;
  }
  function exportManifestPack(input) {
    const source = isPlainObject(input) ? input : {};
    const manifest = isPlainObject(source.manifest) ? source.manifest : {};
    const exportedAt = stamp(source.exportedAt);
    return {
      format: PACK_FORMAT,
      version: PACK_VERSION,
      exportedAt,
      courses: [
        { courseId: textOf(source.courseId) || textOf(manifest.courseId), files: packFiles(manifest, exportedAt) }
      ]
    };
  }
  function importManifestPack(pack, now) {
    if (!isPlainObject(pack)) return { ok: false, error: "\u6E05\u5355\u6587\u4EF6\u5185\u5BB9\u65E0\u6CD5\u8BC6\u522B" };
    if (pack.format !== PACK_FORMAT) return { ok: false, error: "\u4E0D\u662F\u672C\u5DE5\u5177\u5BFC\u51FA\u7684\u6E05\u5355\u6587\u4EF6\uFF08\u683C\u5F0F\u6807\u8BC6\u4E0D\u7B26\uFF09" };
    if (pack.version !== PACK_VERSION) return { ok: false, error: "\u4E0D\u652F\u6301\u7684\u6E05\u5355\u5305\u7248\u672C\uFF08\u53EA\u8BA4\u7B2C 1 \u7248\uFF09" };
    if (!Array.isArray(pack.courses)) return { ok: false, error: "\u6E05\u5355\u6587\u4EF6\u7F3A\u5C11\u8BFE\u7A0B\u5217\u8868" };
    if (pack.courses.length === 0) return { ok: false, error: "\u6E05\u5355\u6587\u4EF6\u91CC\u6CA1\u6709\u4EFB\u4F55\u8BFE\u7A0B" };
    const at = stamp(now);
    const courses = [];
    for (const item of pack.courses) {
      if (!isPlainObject(item)) return { ok: false, error: "\u6E05\u5355\u6587\u4EF6\u91CC\u7684\u8BFE\u7A0B\u8BB0\u5F55\u4E0D\u5408\u6CD5" };
      const courseId = textOf(item.courseId);
      courses.push({
        courseId,
        manifest: { courseId, version: MANIFEST_VERSION, updatedAt: at, files: packFiles(item, at) }
      });
    }
    return courses.length === 1 ? { ok: true, course: courses[0] } : { ok: true, courses };
  }
  function latestStamp(first, second) {
    const a = Number.isFinite(first) ? first : 0;
    const b = Number.isFinite(second) ? second : 0;
    return Math.max(a, b) || Date.now();
  }
  function mergeManifests(current, incoming) {
    const prev = isPlainObject(current) ? current : {};
    const next = isPlainObject(incoming) ? incoming : {};
    const at = latestStamp(prev.updatedAt, next.updatedAt);
    const files3 = packFiles(next, at);
    for (const [key, record] of Object.entries(isPlainObject(prev.files) ? prev.files : {})) {
      const id = textOf(key);
      if (!id || !isPlainObject(record)) continue;
      if (record.status !== "done" && files3[id]) continue;
      files3[id] = packRecord(record, id, at);
    }
    return {
      courseId: textOf(prev.courseId) || textOf(next.courseId),
      version: MANIFEST_VERSION,
      updatedAt: at,
      files: files3,
      scans: Array.isArray(prev.scans) ? prev.scans.slice() : []
    };
  }
  var STATUSES, MANIFEST_VERSION, PACK_FORMAT, PACK_VERSION, SCAN_HISTORY_CAP;
  var init_manifest = __esm({
    "src/store/manifest.js"() {
      init_shared();
      STATUSES = /* @__PURE__ */ new Set(["done", "failed", "partial"]);
      MANIFEST_VERSION = 2;
      PACK_FORMAT = "bbdl-manifest";
      PACK_VERSION = 1;
      SCAN_HISTORY_CAP = 10;
    }
  });

  // src/bb/http.js
  var RETRY_STATUS = /* @__PURE__ */ new Set([429, 500, 502, 503, 504]);
  var MAX_ATTEMPTS = 3;
  var BASE_DELAY_MS = 400;
  var MAX_DELAY_MS = 8e3;
  var SESSION_URL_RE = /login|relogin|sso/i;
  var WEBDAV_RE = /\/bbcswebdav\//i;
  var HttpError = class extends Error {
    constructor(status, url, message) {
      super(message || "HTTP " + status + (url ? " " + url : ""));
      this.name = "HttpError";
      this.status = status;
      this.url = url;
    }
  };
  var SessionExpiredError = class extends Error {
    constructor(message, detail) {
      super(message || "\u4F1A\u8BDD\u5DF2\u5931\u6548\uFF1A\u8BF7\u91CD\u65B0\u767B\u5F55\u540E\u518D\u8BD5\u3002");
      this.name = "SessionExpiredError";
      if (detail) Object.assign(this, detail);
    }
  };
  var SuspectResponseError = class extends Error {
    constructor(detail) {
      const info = detail || {};
      super("\u670D\u52A1\u5668\u8FD4\u56DE\u4E86\u5F02\u5E38\u9875\u9762\uFF08\u7591\u4F3C\u9650\u6D41\uFF09");
      this.name = "SuspectResponseError";
      this.htmlKind = info.htmlKind === "login" || info.htmlKind === "blocked" ? info.htmlKind : "other";
      this.status = Number.isFinite(Number(info.status)) ? Number(info.status) : 0;
      this.path = pathnameOnly(info.path);
    }
  };
  var AbortError = class extends Error {
    constructor(message) {
      super(message || "\u64CD\u4F5C\u5DF2\u53D6\u6D88");
      this.name = "AbortError";
    }
  };
  function isAbortError(error) {
    return !!error && (error instanceof AbortError || error.name === "AbortError");
  }
  function isSessionExpired(error) {
    return !!error && (error instanceof SessionExpiredError || error.name === "SessionExpiredError");
  }
  function isSuspectResponse(error) {
    return !!error && error.name === "SuspectResponseError";
  }
  function linkSignals() {
    const list = [];
    for (let i = 0; i < arguments.length; i += 1) {
      const signal = arguments[i];
      if (signal) list.push(signal);
    }
    if (!list.length) return void 0;
    if (list.length === 1) return list[0];
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    for (const signal of list) {
      if (signal.aborted) {
        controller.abort();
        break;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    return controller.signal;
  }
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(new AbortError());
        return;
      }
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, Math.max(0, ms));
      function onAbort() {
        cleanup();
        reject(new AbortError());
      }
      function cleanup() {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      }
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  function parseRetryAfter(value) {
    if (!value) return void 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_DELAY_MS, Math.round(seconds * 1e3));
    const at = Date.parse(value);
    if (Number.isFinite(at)) return Math.min(MAX_DELAY_MS, Math.max(0, at - Date.now()));
    return void 0;
  }
  function backoffDelay(attempt, response) {
    const retryAfter = parseRetryAfter(response && response.headers ? response.headers.get("retry-after") : null);
    if (retryAfter !== void 0) return retryAfter;
    const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(2, attempt - 1));
    return Math.round(base + Math.random() * base * 0.5);
  }
  function discardBody(response) {
    try {
      const body = response && response.body;
      if (body && typeof body.cancel === "function") {
        const pending = body.cancel();
        if (pending && typeof pending.catch === "function") pending.catch(() => {
        });
      }
    } catch {
    }
  }
  function pathnameOnly(value) {
    const text = String(value == null ? "" : value);
    if (!text) return "";
    try {
      return new URL(text).pathname || "";
    } catch {
      return text.split("#")[0].split("?")[0];
    }
  }
  function htmlKindOf(text) {
    const sample = String(text == null ? "" : text).slice(0, PROBE_HTML_LIMIT);
    if (HTML_LOGIN_RE.test(sample)) return "login";
    if (HTML_BLOCKED_RE.test(sample)) return "blocked";
    return "other";
  }
  async function classifyHtmlKind(response) {
    const body = response && response.body;
    if (!body || typeof body.getReader !== "function") {
      let text2 = "";
      try {
        text2 = await response.text();
      } catch {
        text2 = "";
      }
      return htmlKindOf(text2);
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
      while (text.length < PROBE_HTML_LIMIT) {
        const chunk = await reader.read();
        if (!chunk || chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
    } catch {
    } finally {
      try {
        const pending = reader.cancel();
        if (pending && typeof pending.catch === "function") pending.catch(() => {
        });
      } catch {
      }
    }
    return htmlKindOf(text);
  }
  async function assertAlive(response, requestedUrl) {
    const finalUrl = String(response && response.url || requestedUrl || "");
    const type = String(response && response.headers && response.headers.get("content-type") || "").toLowerCase();
    const wantsFile = WEBDAV_RE.test(requestedUrl || "") || WEBDAV_RE.test(finalUrl);
    if (SESSION_URL_RE.test(finalUrl)) {
      throw new SessionExpiredError("\u4F1A\u8BDD\u5DF2\u5931\u6548\uFF1A\u8BF7\u6C42\u88AB\u91CD\u5B9A\u5411\u5230\u767B\u5F55\u9875 " + finalUrl, { finalUrl });
    }
    if (!wantsFile || type.indexOf("text/html") === -1) return;
    const htmlKind = await classifyHtmlKind(response);
    if (htmlKind === "login") {
      throw new SessionExpiredError("\u4F1A\u8BDD\u5DF2\u5931\u6548\uFF1A\u6587\u4EF6\u8BF7\u6C42\u8FD4\u56DE\u4E86 HTML \u9875\u9762 " + finalUrl, { finalUrl, contentType: type });
    }
    throw new SuspectResponseError({
      htmlKind,
      status: Number(response && response.status) || 0,
      path: finalUrl || requestedUrl
    });
  }
  function sizeFromHeaders(response) {
    if (!response || !response.headers) return void 0;
    const range = response.headers.get("content-range");
    if (range) {
      const match = /bytes\s+\d+-\d+\/(\d+)/i.exec(range);
      if (match) {
        const total = Number(match[1]);
        if (Number.isFinite(total)) return total;
      }
    }
    if (response.status === 200) {
      const length = response.headers.get("content-length");
      if (length) {
        const total = Number(length);
        if (Number.isFinite(total) && total >= 0) return total;
      }
    }
    return void 0;
  }
  function createFetcher(options) {
    const opts = options || {};
    const outer = opts.signal;
    async function request(url, init) {
      const config = init || {};
      const signal = linkSignals(outer, config.signal);
      const requestedUrl = String(url);
      for (let attempt = 1; ; attempt += 1) {
        if (signal && signal.aborted) throw new AbortError();
        let response;
        try {
          response = await fetch(requestedUrl, Object.assign({}, config, { credentials: "include", signal }));
        } catch (error) {
          if (isAbortError(error) || signal && signal.aborted) throw new AbortError();
          if (attempt < MAX_ATTEMPTS) {
            await sleep(backoffDelay(attempt), signal);
            continue;
          }
          throw error;
        }
        try {
          await assertAlive(response, requestedUrl);
          if (!response.ok) throw new HttpError(response.status, response.url || requestedUrl);
        } catch (error) {
          discardBody(response);
          if (error instanceof HttpError && RETRY_STATUS.has(error.status) && attempt < MAX_ATTEMPTS) {
            await sleep(backoffDelay(attempt, response), signal);
            continue;
          }
          throw error;
        }
        return response;
      }
    }
    async function probeSize(url) {
      const signal = linkSignals(outer);
      let response;
      try {
        if (signal && signal.aborted) throw new AbortError();
        response = await fetch(String(url), {
          method: "GET",
          headers: { Range: "bytes=0-0" },
          credentials: "include",
          signal
        });
        if (!response.ok && response.status !== 206) return void 0;
        return sizeFromHeaders(response);
      } catch (error) {
        if (isAbortError(error) || signal && signal.aborted) throw new AbortError();
        return void 0;
      } finally {
        if (response) discardBody(response);
      }
    }
    return { fetchOk: request, probeSize };
  }
  var PROBE_HTML_LIMIT = 64 * 1024;
  var HTML_LOGIN_RE = /sign in|login|password|统一身份|登录/i;
  var HTML_BLOCKED_RE = /blocked|denied|forbidden|rate limit|too many requests|拦截|访问受限/i;
  function createHeartbeat(options) {
    const opts = options || {};
    const fetcher = opts.fetcher || null;
    const url = String(opts.url || "");
    const intervalMs = Number.isFinite(opts.intervalMs) ? Math.max(0, opts.intervalMs) : 0;
    const onTick = typeof opts.onTick === "function" ? opts.onTick : null;
    const signal = opts.signal;
    const schedule = typeof opts.setTimeoutFn === "function" ? opts.setTimeoutFn : setTimeout;
    const unschedule = typeof opts.clearTimeoutFn === "function" ? opts.clearTimeoutFn : clearTimeout;
    let timer = null;
    let ticks = 0;
    let running = false;
    function stop() {
      running = false;
      if (timer !== null) {
        try {
          unschedule(timer);
        } catch {
        }
        timer = null;
      }
    }
    function arm() {
      if (!running) return;
      timer = schedule(function() {
        timer = null;
        void tick();
      }, intervalMs);
    }
    async function tick() {
      if (!running) return;
      if (signal && signal.aborted) {
        stop();
        return;
      }
      ticks += 1;
      let outcome = { ok: false };
      try {
        const response = await fetcher.fetchOk(url, { method: "GET", cache: "no-store" });
        discardBody(response);
        outcome = { ok: true };
      } catch (error) {
        outcome = isSessionExpired(error) ? { ok: false, sessionExpired: true } : { ok: false };
      }
      if (!running) return;
      if (onTick) {
        try {
          onTick(outcome);
        } catch {
        }
      }
      arm();
    }
    function start() {
      if (running) return;
      if (!fetcher || typeof fetcher.fetchOk !== "function") return;
      if (!url || !(intervalMs > 0)) return;
      if (signal && signal.aborted) return;
      running = true;
      arm();
    }
    function count() {
      return ticks;
    }
    return { start, stop, count };
  }

  // src/bb/files.js
  var ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
  var TRAILING_JUNK = /[\s.]+$/u;
  var LEADING_BLANKS = /^[ ]+/u;
  var MAX_BYTES = 255;
  var encoder = new TextEncoder();
  var RESERVED_NAMES = /* @__PURE__ */ new Set(["con", "prn", "aux", "nul"]);
  for (let i = 1; i <= 9; i += 1) {
    RESERVED_NAMES.add("com" + i);
    RESERVED_NAMES.add("lpt" + i);
  }
  function byteLength(text) {
    return encoder.encode(String(text)).length;
  }
  function splitExt(name) {
    const text = String(name);
    const dot = text.lastIndexOf(".");
    if (dot <= 0) return { stem: text, ext: "" };
    return { stem: text.slice(0, dot), ext: text.slice(dot) };
  }
  function cutUtf8(text, maxBytes) {
    if (maxBytes <= 0) return "";
    let out = "";
    let used = 0;
    for (const ch of String(text)) {
      const size = encoder.encode(ch).length;
      if (used + size > maxBytes) break;
      out += ch;
      used += size;
    }
    return out;
  }
  function stripTrailing(text) {
    return String(text).replace(TRAILING_JUNK, "");
  }
  function decodeName(raw) {
    if (typeof raw !== "string") return "";
    if (!/%[0-9a-fA-F]{2}/.test(raw)) return raw;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  function nameFromUrl(url) {
    if (!url) return "";
    let pathname;
    try {
      pathname = new URL(String(url), "http://localhost/").pathname;
    } catch {
      pathname = String(url).split("#")[0].split("?")[0];
    }
    const parts = pathname.split("/").filter(Boolean);
    const last = parts.length ? parts[parts.length - 1] : "";
    return decodeName(last);
  }
  function escapeReserved(name) {
    const dot = name.indexOf(".");
    const base = dot === -1 ? name : name.slice(0, dot);
    if (!RESERVED_NAMES.has(base.trim().toLowerCase())) return name;
    return base + "_" + (dot === -1 ? "" : name.slice(dot));
  }
  function truncateName(name) {
    if (byteLength(name) <= MAX_BYTES) return name;
    const { stem, ext } = splitExt(name);
    const extBytes = byteLength(ext);
    const keepExt = extBytes > 0 && extBytes < MAX_BYTES / 2;
    const budget = keepExt ? MAX_BYTES - extBytes : MAX_BYTES;
    const head = stripTrailing(cutUtf8(stem, budget));
    const out = head + (keepExt ? ext : "");
    return out || "_";
  }
  function sanitizeSegment(name) {
    let text = decodeName(typeof name === "string" ? name : name == null ? "" : String(name));
    text = text.replace(ILLEGAL_CHARS, "_");
    text = text.replace(LEADING_BLANKS, "");
    text = stripTrailing(text);
    if (!text || text === "." || text === "..") text = "_";
    return truncateName(escapeReserved(text));
  }
  function buildEntryPath(entry, options) {
    const opts = options || {};
    const preserveTree = opts.preserveTree !== false;
    const source = entry || {};
    const rawPath = Array.isArray(source.folderPath) ? source.folderPath : [];
    const segments = rawPath.map((segment) => sanitizeSegment(segment == null ? "" : String(segment))).filter((segment) => segment !== "");
    const fileName = sanitizeSegment(source.name == null ? "" : String(source.name));
    if (preserveTree) return { segments, fileName };
    if (!segments.length) return { segments: [], fileName };
    return { segments: [], fileName: truncateName(segments.concat(fileName).join("__")) };
  }
  function pathKey(segments, fileName) {
    return segments.concat([fileName]).join("/").toLowerCase();
  }
  function dedupePaths(list) {
    const used = /* @__PURE__ */ new Set();
    const out = [];
    if (!Array.isArray(list)) return out;
    for (const item of list) {
      const source = item || {};
      const segments = Array.isArray(source.segments) ? source.segments.map(String) : Array.isArray(source.folderPath) ? source.folderPath.map(String) : [];
      const original = String(source.fileName != null ? source.fileName : source.name != null ? source.name : "");
      const { stem, ext } = splitExt(original);
      let candidate = original;
      let n = 1;
      while (used.has(pathKey(segments, candidate))) {
        n += 1;
        candidate = stem + " (" + n + ")" + ext;
      }
      used.add(pathKey(segments, candidate));
      out.push(Object.assign({}, source, { segments, fileName: candidate }));
    }
    return out;
  }
  var MIME_EXTENSIONS = /* @__PURE__ */ new Map([
    ["application/pdf", ".pdf"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
    ["application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
    ["application/msword", ".doc"],
    ["application/vnd.ms-powerpoint", ".ppt"],
    ["application/vnd.ms-excel", ".xls"],
    ["application/zip", ".zip"],
    ["text/plain", ".txt"],
    ["text/csv", ".csv"],
    ["image/png", ".png"],
    ["image/jpeg", ".jpg"],
    ["image/gif", ".gif"],
    ["application/octet-stream", ""]
  ]);
  function extensionForMime(mime) {
    if (typeof mime !== "string") return "";
    const key = mime.trim().toLowerCase();
    const ext = MIME_EXTENSIONS.get(key);
    return ext == null ? "" : ext;
  }
  var EXT_TAIL = /\.([A-Za-z0-9]{1,8})$/;
  var PLACEHOLDER_STEM = /^(?:xid|pid)-/i;
  function looksLikeFileName(name) {
    if (typeof name !== "string" || name === "") return false;
    if (/[\\/]/.test(name)) return false;
    if (!EXT_TAIL.test(name)) return false;
    return !PLACEHOLDER_STEM.test(name);
  }
  var RFC5987_VALUE = /^[^']*'[^']*'(.*)$/;
  var STAR_FILENAME = /filename\*\s*=\s*(?:"([^"]*)"|([^;]*))/i;
  var PLAIN_FILENAME = /filename\s*=\s*(?:"([^"]*)"|([^;]*))/i;
  function headerValue(match) {
    if (!match) return "";
    const raw = match[1] != null ? match[1] : match[2];
    return raw == null ? "" : raw.trim();
  }
  function starFileName(disposition) {
    const value = headerValue(STAR_FILENAME.exec(disposition));
    if (!value) return "";
    const encoded = RFC5987_VALUE.exec(value);
    return decodeName((encoded ? encoded[1] : value).trim());
  }
  function plainFileName(disposition) {
    return decodeName(headerValue(PLAIN_FILENAME.exec(disposition)));
  }
  function lastSegmentHasDot(name) {
    const parts = String(name).split(/[\\/]/);
    const last = parts[parts.length - 1];
    return last.includes(".");
  }
  function resolveFileName(input) {
    const source = input || {};
    const disposition = typeof source.disposition === "string" ? source.disposition : "";
    const title = typeof source.title === "string" ? source.title.trim() : "";
    const mime = typeof source.mime === "string" ? source.mime : "";
    let name = disposition ? starFileName(disposition) || plainFileName(disposition) : "";
    if (!name) {
      const fromUrl = nameFromUrl(source.finalUrl);
      if (fromUrl && looksLikeFileName(fromUrl) && fromUrl !== nameFromUrl(source.href)) name = fromUrl;
    }
    if (!name) name = title;
    if (!name) return "";
    if (title && !lastSegmentHasDot(name)) {
      if (lastSegmentHasDot(title)) {
        name = title;
      } else {
        const ext = extensionForMime(mime);
        if (ext) name = title + ext;
      }
    }
    return name;
  }

  // src/bb/dom.js
  var FILE_SELECTOR = 'a[href*="/bbcswebdav/"]';
  var FOLDER_SELECTOR = 'a[href*="listContent.jsp"]';
  var RID_RE = /dt-content-rid-(\d+)/i;
  var HARMLESS_PARAMS = /* @__PURE__ */ new Set(["mode", "list_display"]);
  var SELF_FORM_SELECTOR = 'form[name="contentForm"]';
  function resolveUrl(raw, base) {
    if (!raw) return "";
    try {
      return new URL(raw, base || void 0).href;
    } catch {
      return "";
    }
  }
  function contentIdOf(url) {
    if (!url) return null;
    try {
      return new URL(url, "http://localhost/").searchParams.get("content_id");
    } catch {
      return null;
    }
  }
  function normalizedQuery(url) {
    const pairs = [];
    for (const [key, value] of url.searchParams) {
      if (HARMLESS_PARAMS.has(key)) continue;
      pairs.push([key, value]);
    }
    pairs.sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
    return pairs.map(([key, value]) => key + "=" + value).join("&");
  }
  function sameDocument(a, b) {
    if (!a || !b) return false;
    try {
      const left = new URL(a, "http://localhost/");
      const right = new URL(b, "http://localhost/");
      return left.origin === right.origin && left.pathname === right.pathname && normalizedQuery(left) === normalizedQuery(right);
    } catch {
      return false;
    }
  }
  function pageContentId(doc, base) {
    const fromUrl = contentIdOf(base);
    if (fromUrl) return fromUrl;
    const form = typeof doc.querySelector === "function" ? doc.querySelector(SELF_FORM_SELECTOR) : null;
    if (!form) return null;
    return contentIdOf(resolveUrl(form.getAttribute("action") || "", base));
  }
  function parseContentList(doc, pageUrl) {
    const result = { files: [], folders: [] };
    if (!doc || typeof doc.querySelectorAll !== "function") return result;
    const base = pageUrl || doc.baseURI || void 0;
    const pageId = pageContentId(doc, base);
    const seenFiles = /* @__PURE__ */ new Set();
    const seenFolders = /* @__PURE__ */ new Set();
    for (const anchor of doc.querySelectorAll(FILE_SELECTOR)) {
      const href = anchor.getAttribute("href") || "";
      const url = resolveUrl(href, base);
      if (!url || seenFiles.has(url)) continue;
      seenFiles.add(url);
      const text = (anchor.textContent || "").trim();
      const rid = RID_RE.exec(url);
      result.files.push({
        id: rid ? "dt-content-rid-" + rid[1] : url,
        href,
        url,
        name: text || nameFromUrl(url),
        folderPath: [],
        size: void 0
      });
    }
    for (const anchor of doc.querySelectorAll(FOLDER_SELECTOR)) {
      const href = (anchor.getAttribute("href") || "").trim();
      if (!href || href.charAt(0) === "#") continue;
      const url = resolveUrl(href, base);
      if (!url || seenFolders.has(url)) continue;
      if (sameDocument(url, base)) continue;
      const id = contentIdOf(url);
      if (!id) continue;
      if (pageId && id === pageId) continue;
      seenFolders.add(url);
      const text = (anchor.textContent || "").trim();
      result.folders.push({ url, name: text || id, id });
    }
    return result;
  }
  var REVOKE_DELAY_MS = 60 * 1e3;
  function manifestFileName(courseId) {
    const raw = courseId == null ? "" : String(courseId).trim();
    const safe = raw.replace(/[^\w.-]+/g, "_");
    return (safe || "course") + "-manifest.json";
  }
  function downloadTextFile(doc, text, fileName, mime) {
    const target = doc || (typeof document === "undefined" ? null : document);
    if (!target || typeof target.createElement !== "function") return null;
    const body = String(text == null ? "" : text);
    const type = mime || "application/json";
    let href = "";
    let blobUrl = null;
    const BlobCtor = typeof Blob === "function" ? Blob : null;
    const canBlob = Boolean(BlobCtor) && typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
    if (canBlob) {
      blobUrl = URL.createObjectURL(new BlobCtor([body], { type }));
      href = blobUrl;
    } else {
      href = "data:" + type + ";charset=utf-8," + encodeURIComponent(body);
    }
    const anchor = target.createElement("a");
    anchor.href = href;
    anchor.download = fileName || "download.json";
    anchor.rel = "noopener";
    anchor.style.display = "none";
    const host = target.body || target.documentElement;
    if (host) host.appendChild(anchor);
    try {
      if (typeof anchor.click === "function") anchor.click();
    } finally {
      if (anchor.parentNode) anchor.parentNode.removeChild(anchor);
      if (blobUrl) {
        setTimeout(function() {
          try {
            URL.revokeObjectURL(blobUrl);
          } catch (err) {
          }
        }, REVOKE_DELAY_MS);
      }
    }
    return anchor;
  }

  // src/bb/scan.js
  var MAX_FOLDER_CONCURRENCY = 4;
  var DEFAULT_MIN_DELAY_MS = 150;
  var DEFAULT_MAX_DELAY_MS = 400;
  function clampConcurrency(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 1) return MAX_FOLDER_CONCURRENCY;
    return Math.min(Math.floor(n), MAX_FOLDER_CONCURRENCY);
  }
  function positiveNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }
  function createLimiter(max) {
    let active = 0;
    const waiters = [];
    return async function run(task) {
      if (active >= max) await new Promise((resolve) => waiters.push(resolve));
      active += 1;
      try {
        return await task();
      } finally {
        active -= 1;
        const next = waiters.shift();
        if (next) next();
      }
    };
  }
  function randomDelay(min, max) {
    const lo = Math.max(0, min);
    const hi = Math.max(lo, max);
    return Math.round(lo + Math.random() * (hi - lo));
  }
  function abortableDelay(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(new AbortError());
        return;
      }
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      function onAbort() {
        cleanup();
        reject(new AbortError());
      }
      function cleanup() {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      }
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  function contentIdOfUrl(url) {
    try {
      return new URL(String(url), "http://localhost/").searchParams.get("content_id");
    } catch {
      return null;
    }
  }
  function parseHtml(html) {
    return new DOMParser().parseFromString(String(html), "text/html");
  }
  function createScanner(options) {
    const opts = options || {};
    const { fetcher, rootUrl, onProgress } = opts;
    if (!fetcher || typeof fetcher.fetchOk !== "function") throw new TypeError("createScanner: \u7F3A\u5C11 fetcher.fetchOk");
    if (!rootUrl) throw new TypeError("createScanner: \u7F3A\u5C11 rootUrl");
    const concurrency = clampConcurrency(opts.concurrency);
    const minDelayMs = positiveNumber(opts.minDelayMs, DEFAULT_MIN_DELAY_MS);
    const maxDelayMs = positiveNumber(opts.maxDelayMs, DEFAULT_MAX_DELAY_MS);
    const controller = new AbortController();
    const signal = controller.signal;
    const limit = createLimiter(concurrency);
    let failures = [];
    let started = null;
    async function loadFolder(job) {
      const response = await fetcher.fetchOk(job.url, {
        headers: { Accept: "text/html,application/xhtml+xml" },
        signal
      });
      const html = await response.text();
      return parseContentList(parseHtml(html), response.url || job.url);
    }
    async function run() {
      const pages = /* @__PURE__ */ new Map();
      const visited = /* @__PURE__ */ new Set();
      const seenFileUrls = /* @__PURE__ */ new Set();
      failures = [];
      let foldersDone = 0;
      let pending = 0;
      let fatal = null;
      let finished = false;
      let resolveDone;
      const done = new Promise((resolve) => {
        resolveDone = resolve;
      });
      function report() {
        if (typeof onProgress !== "function") return;
        try {
          onProgress({ foldersDone, foldersQueued: pending, filesFound: seenFileUrls.size });
        } catch {
        }
      }
      function settleOne() {
        pending -= 1;
        report();
        if (pending === 0 && !finished) {
          finished = true;
          resolveDone();
        }
      }
      function accept(job, parsed) {
        pages.set(job.id, parsed);
        for (const file of parsed.files) seenFileUrls.add(file.url);
        for (const folder of parsed.folders) {
          if (!folder.id || visited.has(folder.id)) continue;
          visited.add(folder.id);
          enqueue({
            url: folder.url,
            id: folder.id,
            folderPath: job.folderPath.concat([String(folder.name || folder.id)])
          });
        }
      }
      function enqueue(job) {
        pending += 1;
        limit(async () => {
          try {
            await abortableDelay(randomDelay(minDelayMs, maxDelayMs), signal);
            if (signal.aborted) throw new AbortError();
            const parsed = await loadFolder(job);
            accept(job, parsed);
            foldersDone += 1;
          } catch (error) {
            if (isAbortError(error) || signal.aborted) {
              fatal = fatal || new AbortError();
              controller.abort();
            } else if (isSessionExpired(error)) {
              fatal = fatal || error;
              controller.abort();
            } else {
              failures.push({
                url: job.url,
                folderPath: job.folderPath.slice(),
                error: error && error.message || String(error)
              });
            }
          } finally {
            settleOne();
          }
        });
      }
      const rootJob = { url: rootUrl, id: contentIdOfUrl(rootUrl) || rootUrl, folderPath: [] };
      visited.add(rootJob.id);
      try {
        const parsed = await loadFolder(rootJob);
        accept(rootJob, parsed);
        foldersDone = 1;
        report();
      } catch (error) {
        if (isAbortError(error) || signal.aborted) throw new AbortError();
        if (isSessionExpired(error)) throw error;
        failures.push({ url: rootUrl, folderPath: [], error: error && error.message || String(error) });
      }
      if (pending > 0) await done;
      if (fatal) throw fatal;
      const files3 = [];
      const queue = [rootJob];
      visited.clear();
      visited.add(rootJob.id);
      seenFileUrls.clear();
      for (let i = 0; i < queue.length; i++) {
        const { id, folderPath } = queue[i];
        const page = pages.get(id);
        if (!page) continue;
        for (const file of page.files) {
          if (seenFileUrls.has(file.url)) continue;
          seenFileUrls.add(file.url);
          files3.push({ ...file, folderPath: folderPath.slice() });
        }
        for (const folder of page.folders) {
          if (!folder.id || visited.has(folder.id)) continue;
          visited.add(folder.id);
          queue.push({ id: folder.id, folderPath: folderPath.concat(String(folder.name || folder.id)) });
        }
      }
      return files3;
    }
    return {
      scan() {
        if (!started) started = run();
        return started;
      },
      cancel() {
        if (!signal.aborted) controller.abort();
      },
      get failures() {
        return failures.slice();
      }
    };
  }

  // src/sinks/picker.js
  async function settle(pending, signal) {
    try {
      const handle = await pending;
      return signal && signal.aborted ? null : handle;
    } catch (err) {
      if (isAbort(err)) return null;
      throw err;
    }
  }
  function isAbort(err) {
    return Boolean(err) && (err.name === "AbortError" || err.code === 20);
  }
  function pickDirectory(options) {
    const signal = options && options.signal;
    if (typeof window === "undefined" || typeof window.showDirectoryPicker !== "function") {
      return Promise.resolve(null);
    }
    return settle(window.showDirectoryPicker({ mode: "readwrite" }), signal);
  }

  // src/sinks/pool.js
  var MIN_WIDTH = 1;
  var MAX_DEGRADES = 2;
  function normalizeWidth(value) {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n >= MIN_WIDTH ? n : 0;
  }
  function createControl({ width } = {}) {
    let steps = 0;
    const control = {
      // 0 = 还没播种：runPool 一进来就用它收到的 concurrency 填上（契约 §3.1「初始值 = concurrency」）
      width: normalizeWidth(width),
      stopped: false,
      reason: "",
      /**
       * 疑似限流时降一档：宽度减半向下取整（4→2→1），最低 1，单批次最多 2 次，之后是空操作。
       * 返回降级后的 width（本次没降也返回当前 width），调用方据此判断「这次真的降了吗」。
       */
      degrade() {
        if (control.width < MIN_WIDTH) control.width = MIN_WIDTH;
        const from = control.width;
        if (steps >= MAX_DEGRADES) return from;
        const to = Math.max(MIN_WIDTH, Math.floor(from / 2));
        if (to >= from) return from;
        steps += 1;
        control.width = to;
        return to;
      },
      stop(reason) {
        if (control.stopped) return;
        control.stopped = true;
        control.reason = reason == null ? "" : String(reason);
      }
    };
    return control;
  }
  function degradeForSuspect(control, previous) {
    const last = previous && typeof previous === "object" ? previous : null;
    if (!control || typeof control.degrade !== "function") return last;
    const from = Math.floor(Number(control.width));
    if (!(from > MIN_WIDTH)) return last;
    const to = control.degrade();
    if (!(Number.isFinite(from) && Number.isFinite(to)) || to >= from) return last;
    console.info("[bbdl] \u964D\u901F", { from, to, reason: "suspect-response" });
    const kept = last && Number.isFinite(Number(last.from)) ? last.from : from;
    return { from: kept, to };
  }
  function toList(items) {
    if (!items) return [];
    const out = [];
    for (let i = 0; i < items.length; i += 1) out.push(items[i]);
    return out;
  }
  async function runPool(items, concurrency, worker, { signal, control } = {}) {
    const jobs = toList(items);
    if (!jobs.length) return;
    const requested = Math.max(1, Math.floor(concurrency) || 1);
    const initial = Math.min(requested, jobs.length);
    if (control && !(control.width >= 1)) control.width = requested;
    let cursor = 0;
    const stopped = () => Boolean(control && control.stopped) || Boolean(signal && signal.aborted);
    function widthNow() {
      const raw = control ? Number(control.width) : NaN;
      const w = Number.isFinite(raw) ? Math.floor(raw) : 0;
      return Math.min(w >= 1 ? w : initial, jobs.length);
    }
    async function drain(index) {
      while (cursor < jobs.length) {
        if (stopped()) return;
        if (index >= widthNow()) return;
        const job = jobs[cursor];
        cursor += 1;
        await worker(job);
      }
    }
    const workers = [];
    for (let i = 0; i < initial; i += 1) workers.push(drain(i));
    await Promise.all(workers);
  }

  // src/sinks/fs.js
  init_shared();

  // src/sinks/guard.js
  var DEFAULT_IDLE_MS = 3e4;
  var SUSPECT_ATTEMPTS = 3;
  var ServerBlockedError = class extends Error {
  };
  function createSuspectBudget() {
    let consecutive = 0;
    let blocked = false;
    return {
      check() {
        if (blocked) throw new ServerBlockedError();
      },
      suspect() {
        if (++consecutive >= 3) blocked = true;
      },
      success() {
        consecutive = 0;
      }
    };
  }
  var SUSPECT_DELAYS = [1500, 4e3, 8e3];
  var RETRY_SUSPECT_TEXT = "\u670D\u52A1\u5668\u8FD4\u56DE\u5F02\u5E38\u9875\u9762\uFF0C\u7A0D\u540E\u91CD\u8BD5";
  var RETRIABLE_STATUS = /* @__PURE__ */ new Set([429, 500, 502, 503, 504]);
  var StallError = class extends Error {
    constructor(message) {
      super(message || "\u4E0B\u8F7D\u505C\u6EDE\uFF1A\u592A\u4E45\u6CA1\u6709\u6536\u5230\u65B0\u6570\u636E");
      this.name = "StallError";
    }
  };
  var TruncatedError = class extends Error {
    constructor(expected, actual, message) {
      const text = message || (Number.isFinite(expected) && Number.isFinite(actual) ? "\u6587\u4EF6\u4E0D\u5B8C\u6574\uFF1A\u671F\u671B " + expected + " \u5B57\u8282\uFF0C\u5B9E\u9645\u6536\u5230 " + actual + " \u5B57\u8282" : "\u6587\u4EF6\u4E0D\u5B8C\u6574\uFF1A\u6536\u5230\u7684\u5B57\u8282\u6570\u4E0E\u670D\u52A1\u5668\u58F0\u660E\u7684\u4E0D\u4E00\u81F4");
      super(text);
      this.name = "TruncatedError";
      this.expected = expected;
      this.actual = actual;
    }
  };
  function isAbortLike(err) {
    if (!err) return false;
    return err.name === "AbortError" || err.code === 20;
  }
  function isSessionExpiredError(err) {
    return !!err && err.name === "SessionExpiredError";
  }
  function isRetriableError(err) {
    if (!err) return false;
    if (isAbortLike(err)) return false;
    if (isSessionExpiredError(err)) return false;
    if (isSuspectResponse(err)) return true;
    if (err instanceof StallError || err.name === "StallError") return true;
    if (err instanceof TruncatedError || err.name === "TruncatedError") return true;
    if (err instanceof TypeError) return true;
    const status = Number(err.status);
    if (err.status == null || !Number.isFinite(status)) return true;
    return RETRIABLE_STATUS.has(status);
  }
  function createIdleReader(reader, { idleMs = DEFAULT_IDLE_MS } = {}) {
    if (!reader || typeof reader.read !== "function") {
      throw new Error("createIdleReader \u9700\u8981\u53EF\u8BFB\u6D41 reader");
    }
    const ms = Number(idleMs) > 0 && Number.isFinite(Number(idleMs)) ? Number(idleMs) : DEFAULT_IDLE_MS;
    let timer = null;
    let cancelled = false;
    function clearTimer() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    }
    function read() {
      if (cancelled) return Promise.resolve({ done: true, value: void 0 });
      clearTimer();
      let pending;
      try {
        pending = Promise.resolve(reader.read());
      } catch (err) {
        return Promise.reject(err);
      }
      const stall = new Promise((_, reject) => {
        timer = setTimeout(() => {
          clearTimer();
          reject(new StallError());
        }, ms);
      });
      return Promise.race([pending, stall]).then(
        (chunk) => {
          clearTimer();
          return chunk;
        },
        (err) => {
          clearTimer();
          throw err;
        }
      );
    }
    function cancel(reason) {
      cancelled = true;
      clearTimer();
      if (typeof reader.cancel !== "function") return Promise.resolve();
      try {
        const pending = reader.cancel(reason);
        return pending && typeof pending.catch === "function" ? pending.catch(() => {
        }) : Promise.resolve(pending);
      } catch {
        return Promise.resolve();
      }
    }
    return { read, cancel };
  }
  function createMutex() {
    let tail = Promise.resolve();
    return {
      run(fn) {
        const result = tail.then(() => fn());
        tail = result.then(
          () => void 0,
          () => void 0
        );
        return result;
      }
    };
  }
  function waitMs(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
  function countOf(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
  }
  function notify(onRetry, info) {
    if (typeof onRetry !== "function") return;
    try {
      onRetry(info);
    } catch {
    }
  }
  async function withFileRetry(fn, { attempts = 2, isRetriable = isRetriableError, onRetry, budget, sleep: sleep2 = waitMs } = {}) {
    const total = countOf(attempts, 1);
    const suspectTotal = SUSPECT_ATTEMPTS;
    let attempt = 0;
    let normal = 0;
    let suspect = 0;
    for (; ; ) {
      attempt += 1;
      try {
        budget?.check();
        const result = await fn(attempt);
        budget?.success();
        return result;
      } catch (err) {
        if (isAbortLike(err) || err instanceof ServerBlockedError) throw err;
        if (isSuspectResponse(err)) {
          budget?.suspect();
          budget?.check();
          if (!isRetriable(err)) throw err;
          suspect += 1;
          if (suspect >= suspectTotal) throw err;
          const delayMs = SUSPECT_DELAYS[Math.min(suspect - 1, SUSPECT_DELAYS.length - 1)];
          notify(onRetry, { attempt, error: err, reason: RETRY_SUSPECT_TEXT, suspect: true, delayMs });
          await sleep2(delayMs);
          continue;
        }
        if (!isRetriable(err)) throw err;
        normal += 1;
        if (normal >= total) throw err;
        notify(onRetry, { attempt, error: err });
      }
    }
  }

  // src/sinks/fs.js
  function pickIdleMs(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_IDLE_MS;
  }
  function pickFileRetries(value) {
    if (value == null) return 1;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1;
  }
  function makeSizeLookup(sizeOf) {
    if (typeof sizeOf !== "function") return () => void 0;
    return (entry) => {
      try {
        const value = Number(sizeOf(entry));
        return Number.isFinite(value) && value > 0 ? value : void 0;
      } catch {
        return void 0;
      }
    };
  }
  function isIdentityEncoding(response) {
    const headers = response && response.headers;
    const raw = headers && typeof headers.get === "function" ? headers.get("content-encoding") : "";
    const encoding = String(raw == null ? "" : raw).trim().toLowerCase();
    return encoding === "" || encoding === "identity";
  }
  function createFsSink({ settings = {}, dirHandle, signal, total = 0, files: files3, sizeOf } = {}) {
    if (!dirHandle) throw new Error("createFsSink \u9700\u8981 dirHandle");
    if (!files3 || typeof files3.buildEntryPath !== "function" || typeof files3.sanitizeSegment !== "function") {
      throw new Error("createFsSink \u9700\u8981 files \u4F9D\u8D56\uFF08buildEntryPath / sanitizeSegment\uFF09");
    }
    const concurrency = Math.max(1, Math.floor(settings.downloadConcurrency) || 1);
    const preserveTree = settings.preserveTree !== false;
    const idleMs = pickIdleMs(settings.idleTimeoutMs);
    const fileRetries = pickFileRetries(settings.fileRetries);
    const lookupSize = makeSizeLookup(sizeOf);
    const dirCache = /* @__PURE__ */ new Map();
    function dirFor(segments) {
      const key = segments.join("\0");
      let pending = dirCache.get(key);
      if (!pending) {
        pending = openDir(segments);
        dirCache.set(key, pending);
      }
      return pending;
    }
    async function openDir(segments) {
      let dir = dirHandle;
      for (const seg of segments) dir = await dir.getDirectoryHandle(seg, { create: true });
      return dir;
    }
    async function writeAttempt(fetcher, entry, plan, onChunk, onName) {
      const response = await fetcher.fetchOk(entry.url, { signal });
      const body = response && response.body;
      if (!body || typeof body.getReader !== "function") {
        throw new Error("\u54CD\u5E94\u6CA1\u6709\u53EF\u8BFB\u4E3B\u4F53\uFF0C\u62D2\u7EDD\u5199\u5165\u7A7A\u6587\u4EF6");
      }
      if (typeof onName === "function") onName(response);
      const dir = await dirFor(plan.segments);
      const fileHandle = await dir.getFileHandle(plan.fileName, { create: true });
      const writable = await fileHandle.createWritable();
      const reader = createIdleReader(body.getReader(), { idleMs });
      let written = 0;
      try {
        for (; ; ) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || !value.byteLength) continue;
          await writable.write(value);
          written += value.byteLength;
          onChunk(written, value.byteLength);
        }
        const expected = lookupSize(entry);
        if (expected !== void 0 && isIdentityEncoding(response) && written !== expected) {
          throw new TruncatedError(expected, written);
        }
        await writable.close();
      } catch (err) {
        try {
          await reader.cancel(err);
        } catch {
        }
        try {
          await writable.abort();
        } catch {
        }
        throw err;
      }
      return written;
    }
    function writeEntry(fetcher, entry, plan, onChunk, { budget, onRetry, onAttempt, onFileRetry, rollback, onName } = {}) {
      let attemptBytes = 0;
      return withFileRetry(
        // withFileRetry 把「本次是第几次」交回来：attempt 计数天然按文件各一份，并发下互不污染
        (attempt) => {
          attemptBytes = 0;
          if (typeof onAttempt === "function") onAttempt(attempt);
          return writeAttempt(
            fetcher,
            entry,
            plan,
            (written, delta) => {
              attemptBytes += delta;
              onChunk(written, delta);
            },
            onName
          );
        },
        {
          budget,
          attempts: 1 + fileRetries,
          onRetry: (info) => {
            if (typeof rollback === "function") rollback(attemptBytes);
            attemptBytes = 0;
            if (typeof onFileRetry === "function") onFileRetry(info);
            if (typeof onRetry === "function") onRetry(info);
          }
        }
      );
    }
    async function download(entries, fetcher, { onProgress, onFileEvent } = {}) {
      const list = Array.from(entries || []);
      const plans = planBatch(list, { preserveTree, files: files3 });
      if (plans.length !== list.length) {
        console.warn("[bbdl] \u8BA1\u5212\u6570\u4E0E\u63D0\u4EA4\u6570\u4E0D\u4E00\u81F4", { entries: list.length, plans: plans.length, concurrency });
      }
      const totalCount = total || list.length;
      const ok = [];
      const failed = [];
      const namer = createEntryNamer({ files: files3, resolveFileName });
      for (const plan of plans) namer.reserve(plan);
      const report = createReporter({ onProgress });
      const progress = createProgressTracker(totalCount);
      const emitFile = createFileEmitter(onFileEvent);
      const control = createControl();
      let aborted = false;
      let degraded = null;
      const budget = createSuspectBudget();
      let workerStarted = 0;
      const emit = (state, path, entryId = "", force = false) => report(progressPayload(progress, state, path, entryId), force);
      emit("start", "", "", true);
      await runPool(
        plans,
        concurrency,
        async (plan) => {
          const entry = plan.entry;
          if (signal && signal.aborted) {
            aborted = true;
            return;
          }
          if (control.stopped) return;
          let label = relativePath(plan);
          let fileName = plan.fileName;
          workerStarted += 1;
          const entryId = entry && entry.id != null ? String(entry.id) : "";
          const onName = (response) => {
            const resolved = namer.resolve(plan, entry, response);
            if (resolved === fileName) return;
            fileName = resolved;
            label = relativePath(plan);
          };
          emit("file-start", label, entryId, true);
          try {
            const written = await writeEntry(
              fetcher,
              entry,
              plan,
              (_written, delta) => {
                progress.addBytes(delta);
                emit("progress", label, entryId, false);
              },
              {
                budget,
                onName,
                // 重试会把上一次 abort 掉的字节扣回去，bytesDone 才等于最终落盘量
                rollback: (n) => progress.rollbackBytes(n),
                // 只报状态，不改旧字段：'file-retry' 是新增字符串，UI 认识就显示、不认识就忽略
                // 可疑响应 = 疑似限流：这里只转达一次降速（次数由 control 自己封顶）
                onRetry: (info) => {
                  if (info && info.suspect) degraded = degradeForSuspect(control, degraded);
                  emit("file-retry", label, entryId, true);
                },
                onAttempt: (attempt) => emitFile({ type: "start", entryId, path: label, name: fileName, attempt }),
                onFileRetry: (info) => emitFile({
                  type: "retry",
                  entryId,
                  path: label,
                  name: fileName,
                  attempt: info.attempt + 1,
                  reason: retryReason(info.error)
                })
              }
            );
            ok.push(entry);
            progress.endFile(false);
            emitFile({ type: "done", entryId, path: label, name: fileName, bytes: written });
            emit("file-done", label, entryId, true);
          } catch (err) {
            if (signal && signal.aborted || isAbort2(err)) {
              aborted = true;
              emit("aborted", label, entryId, true);
              return;
            }
            if (err instanceof ServerBlockedError) {
              control.stop("server-blocked");
              return;
            }
            if (isSessionExpiredError(err)) {
              control.stop("session-expired");
              return;
            }
            const failure = toFailure(entry, plan, err);
            failed.push(failure);
            progress.endFile(true);
            emitFile({ type: "failed", entryId, path: label, name: fileName, error: failure.error });
            emit("file-failed", label, entryId, true);
          }
        },
        { signal, control }
      );
      if (signal && signal.aborted) aborted = true;
      const halted = control.stopped && !aborted ? control.reason || "session-expired" : null;
      const pending = halted ? listPending(list, ok, failed) : [];
      if (halted) emitFile({ type: "halt", entryId: "", path: "", name: "", reason: halted, pending: pending.length });
      emit("done", "", "", true);
      if (list.length && !ok.length && !failed.length && !halted && !aborted) {
        throw new Error(
          "\u843D\u76D8\u5C42\u6CA1\u6709\u5904\u7406\u4EFB\u4F55\u6587\u4EF6\uFF1A\u63D0\u4EA4 " + list.length + " \u4E2A\u3001\u8BA1\u5212 " + plans.length + " \u4E2A\u3001\u5E76\u53D1 " + concurrency + "\u3002"
        );
      }
      return withDegraded(
        withHalted({ ok, failed, aborted }, halted ? { reason: halted, pending, pendingCount: pending.length } : null),
        degraded
      );
    }
    return { kind: "fs", download };
  }

  // src/sinks/download.js
  init_shared();
  var REVOKE_DELAY_MS2 = 6e4;
  var DEFAULT_SERIALIZE_OVER_BYTES = 48 * 1024 * 1024;
  function pickIdleMs2(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_IDLE_MS;
  }
  function pickFileRetries2(value) {
    if (value == null) return 1;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1;
  }
  function pickSerializeOver(value) {
    if (value == null) return DEFAULT_SERIALIZE_OVER_BYTES;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SERIALIZE_OVER_BYTES;
  }
  function makeSizeLookup2(sizeOf) {
    if (typeof sizeOf !== "function") return () => void 0;
    return (entry) => {
      try {
        const value = Number(sizeOf(entry));
        return Number.isFinite(value) && value > 0 ? value : void 0;
      } catch {
        return void 0;
      }
    };
  }
  function headerSize(response) {
    const headers = response && response.headers;
    if (!headers || typeof headers.get !== "function") return void 0;
    const raw = headers.get("content-length");
    if (raw == null || raw === "") return void 0;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : void 0;
  }
  function linkSignals2(outer, local) {
    if (!outer) return { signal: local, dispose() {
    } };
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    let attached = false;
    if (outer.aborted || local.aborted) {
      controller.abort();
    } else {
      outer.addEventListener("abort", onAbort, { once: true });
      local.addEventListener("abort", onAbort, { once: true });
      attached = true;
    }
    return {
      signal: controller.signal,
      dispose() {
        if (!attached) return;
        try {
          outer.removeEventListener("abort", onAbort);
          local.removeEventListener("abort", onAbort);
        } catch {
        }
      }
    };
  }
  async function readBlobWithWatchdog(response, { idleMs, onTimeout }) {
    let timer = null;
    const watchdog = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timer = null;
        reject(onTimeout());
      }, idleMs);
    });
    try {
      return await Promise.race([Promise.resolve(response.blob()), watchdog]);
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    }
  }
  function triggerDownload(doc, href, name) {
    const a = doc.createElement("a");
    a.href = href;
    a.download = name;
    a.rel = "noopener";
    a.style.display = "none";
    if (doc.body && typeof doc.body.appendChild === "function") doc.body.appendChild(a);
    a.click();
    if (typeof a.remove === "function") a.remove();
  }
  function createDownloadSink({
    settings = {},
    signal,
    total = 0,
    files: files3,
    sizeOf,
    doc = globalThis.document,
    urlApi = globalThis.URL,
    schedule = (fn, ms) => setTimeout(fn, ms)
  } = {}) {
    if (!files3 || typeof files3.buildEntryPath !== "function" || typeof files3.sanitizeSegment !== "function") {
      throw new Error("createDownloadSink \u9700\u8981 files \u4F9D\u8D56\uFF08buildEntryPath / sanitizeSegment\uFF09");
    }
    const concurrency = Math.max(1, Math.floor(settings.downloadConcurrency) || 1);
    const idleMs = pickIdleMs2(settings.idleTimeoutMs);
    const fileRetries = pickFileRetries2(settings.fileRetries);
    const serializeOverBytes = pickSerializeOver(settings.serializeOverBytes);
    const lookupSize = makeSizeLookup2(sizeOf);
    const serializeMutex = createMutex();
    async function download(entries, fetcher, { onProgress, onFileEvent } = {}) {
      const list = Array.from(entries || []);
      const totalCount = total || list.length;
      const ok = [];
      const failed = [];
      const plans = planBatch(list, { preserveTree: false, files: files3 });
      const report = createReporter({ onProgress });
      const progress = createProgressTracker(totalCount);
      const emitFile = createFileEmitter(onFileEvent);
      const control = createControl();
      let aborted = false;
      let degraded = null;
      const budget = createSuspectBudget();
      const emit = (state, path, entryId = "", force = false) => report(progressPayload(progress, state, path, entryId), force);
      emit("start", "", "", true);
      async function attemptOnce(entry, deliver) {
        const local = new AbortController();
        const linked = linkSignals2(signal, local.signal);
        try {
          const response = await fetcher.fetchOk(entry.url, { signal: linked.signal });
          const sizes = [headerSize(response), lookupSize(entry)].filter((n) => n !== void 0);
          const known = sizes.length ? Math.max.apply(null, sizes) : void 0;
          const readAndHand = async () => {
            const blob = await readBlobWithWatchdog(response, {
              idleMs,
              onTimeout: () => {
                try {
                  local.abort();
                } catch {
                }
                return new StallError();
              }
            });
            deliver(blob);
            return blob;
          };
          return known !== void 0 && known > serializeOverBytes ? serializeMutex.run(readAndHand) : readAndHand();
        } finally {
          linked.dispose();
        }
      }
      await runPool(
        plans,
        concurrency,
        async (plan) => {
          const entry = plan.entry;
          if (signal && signal.aborted) {
            aborted = true;
            return;
          }
          if (control.stopped) return;
          const name = plan.fileName;
          const label = relativePath(plan);
          let objectUrl = null;
          const entryId = entry && entry.id != null ? String(entry.id) : "";
          emit("file-start", label, entryId, true);
          try {
            const deliver = (blob2) => {
              progress.addBytes(blob2.size || 0);
              objectUrl = urlApi.createObjectURL(blob2);
              triggerDownload(doc, objectUrl, name);
              const pending2 = objectUrl;
              objectUrl = null;
              schedule(() => {
                try {
                  urlApi.revokeObjectURL(pending2);
                } catch {
                }
              }, REVOKE_DELAY_MS2);
            };
            const blob = await withFileRetry(
              // withFileRetry 把「本次是第几次」交回来：attempt 计数按文件各一份，并发下互不污染
              (attempt) => {
                emitFile({ type: "start", entryId, path: label, name, attempt });
                return attemptOnce(entry, deliver);
              },
              {
                budget,
                attempts: 1 + fileRetries,
                // 只报状态，不改旧字段：'file-retry' 是新增字符串，UI 认识就显示、不认识就忽略
                onRetry: (info) => {
                  if (info && info.suspect) degraded = degradeForSuspect(control, degraded);
                  emitFile({
                    type: "retry",
                    entryId,
                    path: label,
                    name,
                    attempt: info.attempt + 1,
                    reason: retryReason(info.error)
                  });
                  emit("file-retry", label, entryId, true);
                }
              }
            );
            ok.push(entry);
            progress.endFile(false);
            emitFile({ type: "done", entryId, path: label, name, bytes: blob && blob.size || 0 });
            emit("file-done", label, entryId, true);
          } catch (err) {
            if (objectUrl) {
              try {
                urlApi.revokeObjectURL(objectUrl);
              } catch {
              }
            }
            if (signal && signal.aborted || isAbort2(err)) {
              aborted = true;
              emit("aborted", label, entryId, true);
              return;
            }
            if (err instanceof ServerBlockedError) {
              control.stop("server-blocked");
              return;
            }
            if (isSessionExpiredError(err)) {
              control.stop("session-expired");
              return;
            }
            const failure = toFailure(entry, plan, err);
            failed.push(failure);
            progress.endFile(true);
            emitFile({ type: "failed", entryId, path: label, name, error: failure.error });
            emit("file-failed", label, entryId, true);
          }
        },
        { signal, control }
      );
      if (signal && signal.aborted) aborted = true;
      const halted = control.stopped && !aborted ? control.reason || "session-expired" : null;
      const pending = halted ? listPending(list, ok, failed) : [];
      if (halted) emitFile({ type: "halt", entryId: "", path: "", name: "", reason: halted, pending: pending.length });
      emit("done", "", "", true);
      return withDegraded(
        withHalted({ ok, failed, aborted }, halted ? { reason: halted, pending, pendingCount: pending.length } : null),
        degraded
      );
    }
    return { kind: "download", download };
  }

  // src/sinks/zip.js
  init_shared();

  // src/sinks/zip-core.js
  var UnsupportedZip64Error = class extends Error {
    constructor(message) {
      super(message || "\u8D85\u51FA ZIP32 \u4E0A\u9650\uFF1A\u5355\u6587\u4EF6\u5FC5\u987B < 4 GiB \u4E14\u6761\u76EE\u6570 <= 65535");
      this.name = "UnsupportedZip64Error";
    }
  };
  var SIG_LOCAL = 67324752;
  var SIG_CENTRAL = 33639248;
  var SIG_EOCD = 101010256;
  var SIG_DESCRIPTOR = 134695760;
  var FLAGS = 2056;
  var METHOD_STORE = 0;
  var VERSION = 20;
  var LOCAL_HEADER_SIZE = 30;
  var DESCRIPTOR_SIZE = 16;
  var CENTRAL_HEADER_SIZE = 46;
  var EOCD_SIZE = 22;
  var MAX_ENTRIES = 65535;
  var MAX_UINT32 = 4294967295;
  var ZIP32_LIMIT = 4294967296;
  var encoder2 = new TextEncoder();
  function toBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (typeof value === "string") return encoder2.encode(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (value == null) return new Uint8Array(0);
    return encoder2.encode(String(value));
  }
  var CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? (3988292384 ^ c >>> 1) >>> 0 : c >>> 1;
      table[i] = c >>> 0;
    }
    return table;
  })();
  function crc32Update(state, bytes) {
    const input = toBytes(bytes);
    let c = (Number(state) ^ MAX_UINT32) >>> 0;
    for (let i = 0; i < input.length; i += 1) c = (CRC_TABLE[(c ^ input[i]) & 255] ^ c >>> 8) >>> 0;
    return (c ^ MAX_UINT32) >>> 0;
  }
  function dosDateTime(date) {
    const d = date instanceof Date && Number.isFinite(date.getTime()) ? date : /* @__PURE__ */ new Date();
    const year = d.getFullYear();
    if (year < 1980) return { time: 0, date: 1 << 5 | 1 };
    if (year > 2107) return { time: 23 << 11 | 59 << 5 | 29, date: 127 << 9 | 12 << 5 | 31 };
    return {
      time: d.getHours() << 11 | d.getMinutes() << 5 | Math.floor(d.getSeconds() / 2),
      date: year - 1980 << 9 | d.getMonth() + 1 << 5 | d.getDate()
    };
  }
  function assertEntrySize(size) {
    const n = Number(size);
    if (!Number.isFinite(n) || n < 0) throw new TypeError("\u4F53\u79EF\u4E0D\u5408\u6CD5\uFF1A" + size);
    if (n >= ZIP32_LIMIT) throw new UnsupportedZip64Error("\u5355\u6587\u4EF6 " + n + " \u5B57\u8282 >= 4 GiB\uFF0CZIP32 \u5199\u4E0D\u4E0B");
    return n;
  }
  function assertEntryCount(count) {
    const n = Number(count);
    if (!Number.isFinite(n) || n < 0) throw new TypeError("\u6761\u76EE\u6570\u4E0D\u5408\u6CD5\uFF1A" + count);
    if (n > MAX_ENTRIES) throw new UnsupportedZip64Error("\u6761\u76EE\u6570 " + n + " \u8D85\u8FC7 ZIP32 \u4E0A\u9650 " + MAX_ENTRIES);
    return n;
  }
  function assertOffset(offset) {
    const n = Number(offset);
    if (!Number.isFinite(n) || n < 0) throw new TypeError("\u504F\u79FB\u4E0D\u5408\u6CD5\uFF1A" + offset);
    if (n >= ZIP32_LIMIT) throw new UnsupportedZip64Error("\u504F\u79FB " + n + " \u8D85\u8FC7 4 GiB\uFF0CZIP32 \u5199\u4E0D\u4E0B");
    return n;
  }
  function nameBytesOf(name) {
    const bytes = toBytes(name);
    if (bytes.length > 65535) throw new UnsupportedZip64Error("\u6587\u4EF6\u540D " + bytes.length + " \u5B57\u8282\uFF0C\u8D85\u8FC7 65535");
    return bytes;
  }
  function localHeader({ name, time = 0, date = 0 } = {}) {
    const nameBytes = nameBytesOf(name);
    const out = new Uint8Array(LOCAL_HEADER_SIZE + nameBytes.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, SIG_LOCAL, true);
    view.setUint16(4, VERSION, true);
    view.setUint16(6, FLAGS, true);
    view.setUint16(8, METHOD_STORE, true);
    view.setUint16(10, time & 65535, true);
    view.setUint16(12, date & 65535, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true);
    out.set(nameBytes, LOCAL_HEADER_SIZE);
    return out;
  }
  function dataDescriptor({ crc = 0, size = 0 } = {}) {
    assertEntrySize(size);
    const out = new Uint8Array(DESCRIPTOR_SIZE);
    const view = new DataView(out.buffer);
    view.setUint32(0, SIG_DESCRIPTOR, true);
    view.setUint32(4, Number(crc) >>> 0, true);
    view.setUint32(8, Number(size), true);
    view.setUint32(12, Number(size), true);
    return out;
  }
  function centralHeader({ name, crc = 0, size = 0, offset = 0, time = 0, date = 0 } = {}) {
    const nameBytes = nameBytesOf(name);
    assertEntrySize(size);
    assertOffset(offset);
    const out = new Uint8Array(CENTRAL_HEADER_SIZE + nameBytes.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, SIG_CENTRAL, true);
    view.setUint16(4, VERSION, true);
    view.setUint16(6, VERSION, true);
    view.setUint16(8, FLAGS, true);
    view.setUint16(10, METHOD_STORE, true);
    view.setUint16(12, time & 65535, true);
    view.setUint16(14, date & 65535, true);
    view.setUint32(16, Number(crc) >>> 0, true);
    view.setUint32(20, Number(size), true);
    view.setUint32(24, Number(size), true);
    view.setUint16(28, nameBytes.length, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, Number(offset), true);
    out.set(nameBytes, CENTRAL_HEADER_SIZE);
    return out;
  }
  function endOfCentralDirectory({ count = 0, size = 0, offset = 0 } = {}) {
    assertEntryCount(count);
    assertEntrySize(size);
    assertOffset(offset);
    const out = new Uint8Array(EOCD_SIZE);
    const view = new DataView(out.buffer);
    view.setUint32(0, SIG_EOCD, true);
    view.setUint16(4, 0, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, Number(count), true);
    view.setUint16(10, Number(count), true);
    view.setUint32(12, Number(size), true);
    view.setUint32(16, Number(offset), true);
    view.setUint16(20, 0, true);
    return out;
  }

  // src/sinks/zip.js
  var REVOKE_DELAY_MS3 = 6e4;
  var DEFAULT_ZIP_CHUNK_BYTES = 200 * 1024 * 1024;
  var FALLBACK_GROUP_NAME = "course";
  var SKIPPED_AFTER_FAILURE = "\u540C\u4E00\u4E2A\u538B\u7F29\u5305\u91CC\u5DF2\u7ECF\u6709\u6587\u4EF6\u5F7B\u5E95\u5931\u8D25\uFF0C\u672C\u6B21\u672A\u4E0B\u8F7D\uFF1B\u53EF\u4EE5\u7A0D\u540E\u91CD\u8BD5";
  function pickIdleMs3(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_IDLE_MS;
  }
  function pickFileRetries3(value) {
    if (value == null) return 1;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1;
  }
  function pickChunkBytes(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_ZIP_CHUNK_BYTES;
  }
  function makeSizeLookup3(sizeOf) {
    if (typeof sizeOf !== "function") return () => void 0;
    return (entry) => {
      try {
        const value = Number(sizeOf(entry));
        return Number.isFinite(value) && value > 0 ? value : void 0;
      } catch {
        return void 0;
      }
    };
  }
  function isIdentityEncoding2(response) {
    const headers = response && response.headers;
    const raw = headers && typeof headers.get === "function" ? headers.get("content-encoding") : "";
    const encoding = String(raw == null ? "" : raw).trim().toLowerCase();
    return encoding === "" || encoding === "identity";
  }
  function triggerDownload2(doc, href, name) {
    const a = doc.createElement("a");
    a.href = href;
    a.download = name;
    a.rel = "noopener";
    a.style.display = "none";
    if (doc.body && typeof doc.body.appendChild === "function") doc.body.appendChild(a);
    a.click();
    if (typeof a.remove === "function") a.remove();
  }
  function zipPath(plan) {
    const segments = Array.isArray(plan && plan.segments) ? plan.segments : [];
    return segments.concat(String(plan && plan.fileName || "")).filter(Boolean).join("/");
  }
  function createZipSink({
    settings = {},
    signal,
    total = 0,
    files: files3,
    sizeOf,
    doc = globalThis.document,
    urlApi = globalThis.URL,
    schedule = (fn, ms) => setTimeout(fn, ms),
    now = () => /* @__PURE__ */ new Date()
  } = {}) {
    if (!files3 || typeof files3.buildEntryPath !== "function" || typeof files3.sanitizeSegment !== "function") {
      throw new Error("createZipSink \u9700\u8981 files \u4F9D\u8D56\uFF08buildEntryPath / sanitizeSegment\uFF09");
    }
    const preserveTree = settings.preserveTree !== false;
    const idleMs = pickIdleMs3(settings.idleTimeoutMs);
    const fileRetries = pickFileRetries3(settings.fileRetries);
    const chunkBytes = pickChunkBytes(settings.zipChunkBytes);
    const lookupSize = makeSizeLookup3(sizeOf);
    const deliverMutex = createMutex();
    function groupPlans(plans) {
      if (!preserveTree) return [{ name: FALLBACK_GROUP_NAME, plans }];
      const groups = [];
      const index = /* @__PURE__ */ new Map();
      for (const plan of plans) {
        const key = plan.segments.length ? String(plan.segments[0]) : FALLBACK_GROUP_NAME;
        let group = index.get(key);
        if (!group) {
          group = { name: key, plans: [] };
          index.set(key, group);
          groups.push(group);
        }
        group.plans.push(plan);
      }
      return groups;
    }
    function newPackage(name) {
      return { name, parts: [], entries: [], bytes: 0, cdBytes: 0 };
    }
    function sealedSize(pkg) {
      return pkg.bytes + pkg.cdBytes + EOCD_SIZE;
    }
    function projectedGrowth(nameLength, estimated) {
      return LOCAL_HEADER_SIZE + nameLength + DESCRIPTOR_SIZE + estimated + CENTRAL_HEADER_SIZE + nameLength;
    }
    function shouldCut(pkg, nameLength, estimated) {
      if (!pkg.entries.length) return false;
      if (pkg.entries.length >= MAX_ENTRIES) return true;
      const expected = estimated === void 0 ? 0 : estimated;
      return sealedSize(pkg) + projectedGrowth(nameLength, expected) > chunkBytes;
    }
    async function readEntry(fetcher, entry, onBytes, onName) {
      const response = await fetcher.fetchOk(entry.url, { signal });
      const body = response && response.body;
      if (!body || typeof body.getReader !== "function") {
        throw new Error("\u54CD\u5E94\u6CA1\u6709\u53EF\u8BFB\u4E3B\u4F53\uFF0C\u62D2\u7EDD\u5199\u5165\u7A7A\u6587\u4EF6");
      }
      if (typeof onName === "function") onName(response);
      const reader = createIdleReader(body.getReader(), { idleMs });
      const parts = [];
      let size = 0;
      let crc = 0;
      try {
        for (; ; ) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || !value.byteLength) continue;
          const chunk = toBytes(value);
          crc = crc32Update(crc, chunk);
          parts.push(chunk);
          size += chunk.byteLength;
          onBytes(chunk.byteLength);
        }
        const expected = lookupSize(entry);
        if (expected !== void 0 && isIdentityEncoding2(response) && size !== expected) {
          throw new TruncatedError(expected, size);
        }
        assertEntrySize(size);
      } catch (err) {
        try {
          await reader.cancel(err);
        } catch {
        }
        throw err;
      }
      return { parts, crc, size };
    }
    function flushPackage(pkg) {
      if (!pkg.entries.length) return Promise.resolve(null);
      return deliverMutex.run(async () => {
        const cdOffset = pkg.bytes;
        const cdParts = [];
        for (const item of pkg.entries) {
          const header = centralHeader({
            name: item.name,
            crc: item.crc,
            size: item.size,
            offset: item.offset,
            time: item.time,
            date: item.date
          });
          cdParts.push(header);
          pkg.bytes += header.length;
        }
        const cdSize = pkg.bytes - cdOffset;
        const eocd = endOfCentralDirectory({ count: pkg.entries.length, size: cdSize, offset: cdOffset });
        const blob = new Blob([...pkg.parts, ...cdParts, eocd], { type: "application/zip" });
        const fileName = pkg.name + ".zip";
        pkg.parts.length = 0;
        pkg.entries.length = 0;
        pkg.bytes = 0;
        pkg.cdBytes = 0;
        const href = urlApi.createObjectURL(blob);
        triggerDownload2(doc, href, fileName);
        schedule(() => {
          try {
            urlApi.revokeObjectURL(href);
          } catch {
          }
        }, REVOKE_DELAY_MS3);
        return { name: fileName, bytes: blob.size };
      });
    }
    async function download(entries, fetcher, { onProgress, onFileEvent } = {}) {
      const list = Array.from(entries || []);
      const plans = planBatch(list, { preserveTree, files: files3 });
      const namer = createEntryNamer({ files: files3, resolveFileName });
      for (const plan of plans) namer.reserve(plan);
      const groups = groupPlans(plans);
      const ordered = groups.reduce((acc, group) => acc.concat(group.plans), []);
      const totalCount = total || list.length;
      const ok = [];
      const failed = [];
      const partialPackages = [];
      const report = createReporter({ onProgress });
      const progress = createProgressTracker(totalCount);
      const emitFile = createFileEmitter(onFileEvent);
      const control = createControl({ width: 1 });
      let aborted = false;
      let halted = null;
      let degraded = null;
      const budget = createSuspectBudget();
      let cursor = 0;
      const emit = (state, path, entryId = "", force = false) => report(progressPayload(progress, state, path, entryId), force);
      const buffered = [];
      async function deliver(pkg) {
        const delivered = await flushPackage(pkg);
        for (const { entry, label, entryId } of buffered) {
          ok.push(entry);
          progress.endFile(false);
          emit("file-done", label, entryId, true);
        }
        buffered.length = 0;
        return delivered;
      }
      const stopNow = () => aborted || halted !== null;
      emit("start", "", "", true);
      for (const group of groups) {
        let pkg = newPackage(group.name);
        let missing = 0;
        let broken = false;
        for (const plan of group.plans) {
          if (stopNow() || signal && signal.aborted) break;
          const entry = plan.entry;
          const entryId = entry && entry.id != null ? String(entry.id) : "";
          let label = relativePath(plan);
          let name = zipPath(plan);
          const plannedNameLength = toBytes(name).length;
          const known = lookupSize(entry);
          if (broken) {
            const failure = toFailure(entry, plan, new Error(SKIPPED_AFTER_FAILURE));
            failed.push(failure);
            missing += 1;
            progress.endFile(true);
            emit("file-start", label, entryId, true);
            emitFile({ type: "start", entryId, path: label, name, attempt: 1 });
            emitFile({ type: "failed", entryId, path: label, name, error: failure.error });
            emit("file-failed", label, entryId, true);
            cursor += 1;
            continue;
          }
          if (shouldCut(pkg, plannedNameLength, known)) {
            await deliver(pkg);
            pkg = newPackage(group.name);
            missing = 0;
          }
          emit("file-start", label, entryId, true);
          emitFile({ type: "start", entryId, path: label, name, attempt: 1 });
          let attemptBytes = 0;
          let readAttempted = false;
          try {
            if (known !== void 0) assertEntrySize(known);
            readAttempted = true;
            const { parts, crc, size } = await withFileRetry(
              // withFileRetry 把「本次是第几次」交回来：attempt 按文件各一份，重试后从 1 长到 2
              (attempt) => {
                attemptBytes = 0;
                if (attempt > 1) emitFile({ type: "start", entryId, path: label, name, attempt });
                return readEntry(
                  fetcher,
                  entry,
                  (delta) => {
                    attemptBytes += delta;
                    progress.addBytes(delta);
                    emit("progress", label, entryId, false);
                  },
                  (response) => {
                    namer.resolve(plan, entry, response);
                    name = zipPath(plan);
                    label = relativePath(plan);
                  }
                );
              },
              {
                budget,
                attempts: 1 + fileRetries,
                // 会话过期永不重试：isRetriableError 对它返回 false（§2），这里显式传一遍让契约可见
                isRetriable: isRetriableError,
                onRetry: (info) => {
                  progress.rollbackBytes(attemptBytes);
                  attemptBytes = 0;
                  if (info && info.suspect) degraded = degradeForSuspect(control, degraded);
                  emitFile({
                    type: "retry",
                    entryId,
                    path: label,
                    name,
                    attempt: info.attempt + 1,
                    reason: retryReason(info.error)
                  });
                  emit("file-retry", label, entryId, true);
                }
              }
            );
            const stamp2 = dosDateTime(now());
            const nameLength = toBytes(name).length;
            const header = localHeader({ name, time: stamp2.time, date: stamp2.date });
            const offset = pkg.bytes;
            pkg.parts.push(header);
            pkg.bytes += header.length;
            for (const part of parts) {
              pkg.parts.push(part);
              pkg.bytes += part.byteLength;
            }
            pkg.parts.push(dataDescriptor({ crc, size }));
            pkg.bytes += DESCRIPTOR_SIZE;
            pkg.cdBytes += CENTRAL_HEADER_SIZE + nameLength;
            pkg.entries.push({ name, crc, size, offset, time: stamp2.time, date: stamp2.date });
            buffered.push({ entry, label, entryId });
            emitFile({ type: "done", entryId, path: label, name, bytes: size });
          } catch (err) {
            if (signal && signal.aborted || isAbort2(err)) {
              aborted = true;
              emit("aborted", label, entryId, true);
              break;
            }
            if (err instanceof ServerBlockedError || err?.name === "SessionExpiredError") {
              halted = { reason: err instanceof ServerBlockedError ? "server-blocked" : "session-expired", pending: ordered.slice(cursor).map((item) => item.entry) };
              emit("halt", label, entryId, true);
              break;
            }
            const failure = toFailure(entry, plan, err);
            failed.push(failure);
            missing += 1;
            progress.endFile(true);
            emitFile({ type: "failed", entryId, path: label, name, error: failure.error });
            emit("file-failed", label, entryId, true);
            if (readAttempted) broken = true;
          }
          cursor += 1;
        }
        const savedCount = pkg.entries.length;
        const delivered = await deliver(pkg);
        if (delivered && savedCount > 0 && missing > 0) {
          partialPackages.push({ name: delivered.name, saved: savedCount, missing });
        }
      }
      if (signal && signal.aborted || aborted) {
        aborted = true;
        halted = null;
      }
      if (halted) {
        emitFile({
          type: "halt",
          entryId: "",
          path: "",
          name: "",
          reason: halted.reason,
          pending: halted.pending.length
        });
      }
      emit("done", "", "", true);
      return withDegraded(withHalted({ ok, failed, aborted, partialPackages }, halted), degraded);
    }
    return { kind: "zip", download };
  }

  // src/sinks/existing.js
  init_shared();
  var DEFAULT_MAX_FILES = 5e3;
  var DEFAULT_MAX_DEPTH = 8;
  function toLimit(value, fallback) {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }
  function isDirectoryHandle(handle) {
    if (handle.kind === "directory") return true;
    if (handle.kind === "file") return false;
    if (typeof handle.getFile === "function") return false;
    return typeof handle.values === "function" || typeof handle.getDirectoryHandle === "function";
  }
  function toIterator(source) {
    if (source && typeof source.next === "function") return source;
    if (source && typeof source[Symbol.asyncIterator] === "function") return source[Symbol.asyncIterator]();
    if (source && typeof source[Symbol.iterator] === "function") return source[Symbol.iterator]();
    return null;
  }
  async function listExistingFiles(dirHandle, { signal, maxFiles = DEFAULT_MAX_FILES, maxDepth = DEFAULT_MAX_DEPTH } = {}) {
    const found = /* @__PURE__ */ new Map();
    Object.defineProperty(found, "truncated", { value: false, enumerable: false, writable: true, configurable: true });
    if (!dirHandle || typeof dirHandle.values !== "function") return found;
    const fileLimit = toLimit(maxFiles, DEFAULT_MAX_FILES);
    const depthLimit = toLimit(maxDepth, DEFAULT_MAX_DEPTH);
    let stopped = false;
    const aborted = () => Boolean(signal && signal.aborted);
    async function readSize(handle) {
      try {
        const file = await handle.getFile();
        const size = file ? Number(file.size) : NaN;
        return Number.isFinite(size) && size >= 0 ? size : null;
      } catch {
        return null;
      }
    }
    async function walk(dir, segments, depth) {
      if (stopped || aborted()) return;
      if (depth > depthLimit) {
        found.truncated = true;
        return;
      }
      let iterator = null;
      try {
        iterator = toIterator(dir.values());
      } catch {
        return;
      }
      if (!iterator) return;
      for (; ; ) {
        let step = null;
        try {
          step = await iterator.next();
        } catch {
          return;
        }
        if (stopped || aborted()) return;
        if (!step || step.done) return;
        const handle = step.value;
        if (!handle) continue;
        const name = String(handle.name == null ? "" : handle.name);
        if (!name) continue;
        if (isDirectoryHandle(handle)) {
          await walk(handle, segments.concat(name), depth + 1);
          if (stopped) return;
          continue;
        }
        if (found.size >= fileLimit) {
          stopped = true;
          found.truncated = true;
          return;
        }
        found.set(relativePath({ segments, fileName: name }), await readSize(handle));
        if (aborted()) return;
      }
    }
    try {
      await walk(dirHandle, [], 0);
    } catch {
    }
    return found;
  }

  // src/sinks/index.js
  var files = { buildEntryPath, sanitizeSegment, dedupePaths };
  var DEFAULT_FALLBACK_SINK = "zip";
  function fallbackKindOf(settings) {
    const raw = settings ? settings.fallbackSink : null;
    return raw === "files" ? "files" : DEFAULT_FALLBACK_SINK;
  }
  function createSink({ settings = {}, dirHandle, signal, total = 0, sizeOf } = {}) {
    const deps = { settings, signal, total, files, sizeOf };
    if (dirHandle) return createFsSink({ ...deps, dirHandle });
    return fallbackKindOf(settings) === "files" ? createDownloadSink(deps) : createZipSink(deps);
  }

  // src/index.js
  init_shared();

  // src/store.js
  var KEY = "bb-bulk-course-downloader:settings:v1";
  var DEFAULTS = {
    preserveTree: true,
    downloadConcurrency: 4,
    probeConcurrency: 6,
    minDelayMs: 150,
    maxDelayMs: 400,
    probeSizes: true,
    // 面板默认收起：首次安装只留左下角一条，不把第三方页面挡住。
    panelCollapsed: true,
    // ZIP 降级落盘的单包上限（200 MiB）：一个包装满就封口交给浏览器，内存上界就是一个包
    zipChunkBytes: 200 * 1024 * 1024,
    // 保活心跳间隔：门户会话闲置太久必死，下载期间定期回敲一次最省事的续命手段
    keepAliveMs: 90 * 1e3,
    // 自动续跑的连续零进展熔断阈值（次）：有进展即归零，撞满就交回用户，不再自己转圈
    autoResumeMax: 3,
    // 自动续跑也救不回来时，强制重载页面再续跑（docs/m7-quiet.md §2）：默认开，用户可在面板关掉
    autoReload: true,
    // 同一次停机里最多重载几次（含当前这次）：撞满就暂停，交给用户点「继续」
    autoReloadMax: 2
  };
  function loadSettings() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return { ...DEFAULTS };
      return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULTS };
    }
  }
  function saveSettings(patch) {
    const next = { ...loadSettings(), ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
    }
    return next;
  }

  // src/ui/styles.js
  var STYLE_ID = "bbdl-styles";
  var CSS = `
.bbdl-panel,
.bbdl-overlay {
  --bbdl-fg: #e9ecf1;
  --bbdl-bg: #1e2128;
  --bbdl-bg-soft: #262a33;
  --bbdl-line: #39404b;
  --bbdl-muted: #9aa3af;
  --bbdl-accent: #4c8dff;
  --bbdl-danger: #e5534b;
  --bbdl-ok: #3fb950;
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 13px;
  line-height: 1.5;
  color: var(--bbdl-fg);
  box-sizing: border-box;
}

.bbdl-panel *,
.bbdl-overlay * {
  box-sizing: border-box;
  font-family: inherit;
}

.bbdl-panel [hidden],
.bbdl-overlay [hidden] {
  display: none !important;
}

/* ---------- \u6D6E\u52A8\u9762\u677F ---------- */
.bbdl-panel {
  position: fixed;
  left: 16px;
  bottom: 16px;
  width: 324px;
  max-width: calc(100vw - 32px);
  z-index: 2147483000;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}

.bbdl-panel__card {
  width: 100%;
  background: var(--bbdl-bg);
  border: 1px solid var(--bbdl-line);
  border-radius: 12px;
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}

.bbdl-panel--collapsed .bbdl-panel__card {
  display: none;
}

.bbdl-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  background: var(--bbdl-bg-soft);
  border-bottom: 1px solid var(--bbdl-line);
}

.bbdl-panel__title {
  font-weight: 600;
  font-size: 13px;
  letter-spacing: 0.2px;
}

.bbdl-panel__body {
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.bbdl-status {
  margin: 0;
  color: var(--bbdl-fg);
  word-break: break-word;
}

.bbdl-panel[data-state="error"] .bbdl-status {
  color: #ff9a92;
}

.bbdl-panel[data-state="done"] .bbdl-status {
  color: #8ce49a;
}

/* ---------- \u6309\u94AE ---------- */
.bbdl-btn {
  appearance: none;
  border: 1px solid var(--bbdl-line);
  background: #2f3540;
  color: var(--bbdl-fg);
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.4;
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease, opacity 0.12s ease;
}

.bbdl-btn:hover:not(:disabled) {
  background: #3a4150;
}

.bbdl-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.bbdl-btn--primary {
  background: var(--bbdl-accent);
  border-color: #3a7ae8;
  color: #fff;
}

.bbdl-btn--primary:hover:not(:disabled) {
  background: #3f7ff0;
}

.bbdl-btn--danger {
  background: #4a2523;
  border-color: #6d3330;
  color: #ffb3ad;
}

.bbdl-btn--danger:hover:not(:disabled) {
  background: #5b2c29;
}

.bbdl-btn--small {
  padding: 4px 9px;
  font-size: 12px;
}

.bbdl-btn--icon {
  padding: 2px 8px;
  font-size: 14px;
  line-height: 1.3;
  border-radius: 6px;
}

.bbdl-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* ---------- \u8FDB\u5EA6 ---------- */
.bbdl-progress {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.bbdl-progress__track {
  height: 6px;
  border-radius: 999px;
  background: #333a45;
  overflow: hidden;
}

.bbdl-progress__fill {
  display: block;
  height: 100%;
  width: 0;
  background: linear-gradient(90deg, #4c8dff, #58c4ff);
  transition: width 0.2s ease;
}

.bbdl-progress__text {
  margin: 0;
  color: var(--bbdl-muted);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---------- \u8BBE\u7F6E ---------- */
.bbdl-settings {
  border-top: 1px solid var(--bbdl-line);
  padding-top: 6px;
  color: var(--bbdl-muted);
  font-size: 12px;
}

.bbdl-settings > summary {
  cursor: pointer;
  user-select: none;
  color: var(--bbdl-muted);
}

.bbdl-settings__row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}

.bbdl-settings__row input[type="number"] {
  width: 56px;
  background: #2f3540;
  border: 1px solid var(--bbdl-line);
  color: var(--bbdl-fg);
  border-radius: 6px;
  padding: 2px 6px;
  font-size: 12px;
}

.bbdl-note {
  margin: 0;
  color: var(--bbdl-muted);
  font-size: 12px;
}

/* ---------- \u7ED3\u679C\u6458\u8981 ---------- */
.bbdl-summary {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-top: 1px solid var(--bbdl-line);
  padding-top: 8px;
}

.bbdl-summary__head {
  margin: 0;
  font-weight: 600;
}

.bbdl-failed {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 168px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.bbdl-failed__item {
  background: #2b2326;
  border: 1px solid #4a3033;
  border-radius: 8px;
  padding: 5px 8px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.bbdl-failed__name {
  color: #ffd7d3;
  word-break: break-all;
}

.bbdl-failed__path {
  color: var(--bbdl-muted);
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bbdl-failed__reason {
  color: #ff9a92;
  font-size: 12px;
  word-break: break-word;
}

.bbdl-failed__hint {
  color: var(--bbdl-accent);
  font-size: 11.5px;
}

.bbdl-copybox {
  width: 100%;
  resize: vertical;
  background: #12151a;
  color: var(--bbdl-fg);
  border: 1px solid var(--bbdl-line);
  border-radius: 8px;
  padding: 6px;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}

/* ---------- \u6536\u8D77\u72B6\u6001\u6761\uFF08\u9ED8\u8BA4\u5F62\u6001\uFF09\uFF1A\u2264240\xD744\uFF0C\u56FA\u5B9A\u5728\u5DE6\u4E0B\u89D2 ---------- */
.bbdl-fab {
  display: none;
  position: fixed;
  left: 16px;
  bottom: 16px;
  box-sizing: border-box;
  max-width: 240px;
  height: 44px;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border: 1px solid var(--bbdl-line);
  border-radius: 10px;
  background: var(--bbdl-bg);
  color: var(--bbdl-fg);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.45);
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.15;
  text-align: left;
  /* \u6BD4 .bbdl-panel \u4F4E\u4E00\u6863\uFF082147483000\uFF09\uFF1A\u6761\u6C38\u8FDC\u538B\u4E0D\u4F4F\u5B8C\u6574\u9762\u677F */
  z-index: 2147482999;
}

.bbdl-panel--collapsed .bbdl-fab {
  display: flex;
}

.bbdl-fab__title {
  white-space: nowrap;
}

/* \u72B6\u6001\u5B57\uFF1A\u6CA1\u5185\u5BB9\u5C31\u6574\u5757\u4E0D\u5360\u4F4D\uFF08:empty\uFF09\uFF0C\u6709\u5185\u5BB9\u6700\u591A 96px \u540E\u7701\u7565\u3002 */
.bbdl-fab__status {
  display: none;
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--bbdl-muted);
  font-weight: 500;
}

.bbdl-fab__status:not(:empty) {
  display: inline-block;
}

.bbdl-fab__hint {
  white-space: nowrap;
  color: var(--bbdl-accent);
  font-weight: 500;
}

/* ---------- \u9009\u62E9\u5BF9\u8BDD\u6846 ---------- */
.bbdl-overlay {
  position: fixed;
  inset: 0;
  z-index: 2147483600;
  background: rgba(9, 11, 15, 0.62);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

/* \u7EB5\u5411 flex \u5BB9\u5668\uFF1A\u5934\u90E8/\u5DE5\u5177\u680F/\u5E95\u90E8\u56FA\u5B9A\uFF0C\u53EA\u6709 .bbdl-tree \u627F\u8F7D\u6EDA\u52A8\u3002
   \u523B\u610F\u4E0D\u5199 overflow: hidden \u2014\u2014 \u90A3\u4F1A\u628A\u8D85\u51FA 82vh \u7684\u5185\u5BB9\u76F4\u63A5\u5403\u6389\uFF0C\u8FDE\u6EDA\u52A8\u6761\u90FD\u4E0D\u7ED9\u3002 */
.bbdl-dialog {
  width: min(880px, 100%);
  max-height: min(82vh, 860px);
  min-height: 0;
  background: var(--bbdl-bg);
  border: 1px solid var(--bbdl-line);
  border-radius: 14px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
  display: flex;
  flex-direction: column;
  overflow: visible;
}

.bbdl-dialog__head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  padding: 12px 14px;
  background: var(--bbdl-bg-soft);
  border-bottom: 1px solid var(--bbdl-line);
  border-radius: 13px 13px 0 0;
}

.bbdl-dialog__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.bbdl-dialog__toolbar {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--bbdl-line);
}

.bbdl-toolbar__row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  width: 100%;
}

.bbdl-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
}

/* \u4E0D\u53D8\u91CF\uFF1A\u6BCF\u4E2A .bbdl-group \u7684\u5B9E\u9645\u9AD8\u5EA6 \u2265 \u5185\u90E8\u6240\u6709 .bbdl-row \u9AD8\u5EA6\u4E4B\u548C\uFF0C\u4E14\u540E\u4E00\u7EC4\u7684\u5934\u884C top
   \u5FC5\u987B \u2265 \u524D\u4E00\u7EC4\u6700\u540E\u4E00\u884C\u7684 bottom \u2014\u2014 \u7EC4\u4E0E\u7EC4\u6C38\u4E0D\u91CD\u53E0\u3002
   \u6240\u4EE5\u8FD9\u91CC\u662F\u5757\u6D41\uFF1Acolumn flex \u4E0B\uFF0C\u6EA2\u51FA\u975E visible \u7684 flex \u9879\u81EA\u52A8\u6700\u5C0F\u5C3A\u5BF8\u4E3A 0\uFF0C
   .bbdl-group \u4F1A\u88AB flex-shrink \u538B\u6210\u5341\u51E0\u50CF\u7D20\uFF0C\u518D\u7531 overflow: hidden \u628A\u884C\u88C1\u6389\uFF0C
   \u4E0B\u4E00\u7EC4\u7684\u5934\u5C31\u538B\u5728\u88AB\u538B\u6241\u7684\u884C\u4E0A\uFF08\u7528\u6237\u622A\u56FE\u91CC\u300C\u6587\u5B57\u7CCA\u6210\u4E00\u7247\u300D\u7684\u6839\u56E0\uFF09\u3002
   \u7EB5\u6A2A\u4E24\u8F74\u6EDA\u52A8\u90FD\u4EA4\u7ED9 .bbdl-tree \u7684 overflow: auto\u3002 */
.bbdl-tree {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 8px 10px 12px;
  display: block;
}

/* \u5706\u89D2\u4E0D\u9760 overflow: hidden \u88C1\uFF08\u90A3\u4F1A\u8FDE\u9700\u8981\u6A2A\u5411\u6EDA\u52A8\u7684\u957F\u8DEF\u5F84\u4E00\u8D77\u88C1\u6389\uFF09\uFF0C
   \u6539\u7531\u6587\u4EF6\u5939\u5934\u8865\u4E0A\u5706\u89D2\uFF0C\u89C1 .bbdl-row--folder\u3002 */
.bbdl-group {
  border: 1px solid var(--bbdl-line);
  border-radius: 10px;
  margin: 0 0 10px;
}

/* \u884C\u9AD8\u5FC5\u987B\u7531\u5185\u5BB9\u51B3\u5B9A\uFF1A\u5BBF\u4E3B BB \u9875\u9762\u81EA\u5DF1\u7684 line-height \u4E00\u65E6\u88AB\u7EE7\u627F\u8FC7\u6765\uFF0C
   13px \u7684\u4E2D\u6587\u5C31\u4F1A\u753B\u5230\u884C\u76D2\u4E4B\u5916\uFF0C\u88AB\u76F8\u90BB\u884C\u7684\u5E95\u8272\u76D6\u6389\u534A\u622A\uFF08\u7528\u6237\u622A\u56FE\u91CC\u5C31\u662F\u8FD9\u4E2A\u73B0\u8C61\uFF09\u3002
   \u6240\u4EE5\u8FD9\u91CC\u663E\u5F0F\u9489\u6B7B line-height\uFF0C\u7D27\u51D1\u5EA6\u53EA\u7528 padding / font-size \u8C03\uFF0C\u7EDD\u4E0D\u5199 height \u6216 overflow: hidden \u53BB\u88C1\u3002 */
.bbdl-row {
  display: grid;
  /* \u4F53\u79EF\u5217\u5B9A\u5BBD 92px\uFF1A\u8BA9\u5B83\u522B\u518D\u6309\u5185\u5BB9\u62A2 name \u5217\u7684\u5BBD\u5EA6\u3002
     width: max-content \u8BA9\u8FC7\u957F\u7684\u8DEF\u5F84\u628A\u6574\u884C\u6491\u5BBD\uFF0C\u6A2A\u5411\u6EDA\u52A8\u6761\u624D\u6709\u4E1C\u897F\u53EF\u6EDA\u3002 */
  grid-template-columns: 18px minmax(0, 1fr) 92px;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  width: max-content;
  min-width: 100%;
  min-height: 30px;
  height: auto;
  max-height: none;
  line-height: 1.45;
  cursor: pointer;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
}

.bbdl-row:first-child {
  border-top: 0;
}

/* \u7EC4\u5185\u6700\u540E\u4E00\u884C\u8865\u4E0B\u5706\u89D2\uFF1A\u7EC4\u7684\u5706\u89D2\u4E0D\u518D\u9760 overflow: hidden \u88C1\u3002 */
.bbdl-group > .bbdl-row:last-child {
  border-radius: 0 0 9px 9px;
}

/* \u523B\u610F\u4E0D\u7528 position: sticky\uFF1A\u5438\u9876\u884C\u4E00\u65E6\u53E0\u5728\u6B63\u5E38\u884C\u4E0A\u65B9\uFF0C\u4EFB\u4F55\u4E00\u70B9\u884C\u76D2\u6EA2\u51FA\u90FD\u4F1A\u53D8\u6210
   \u300C\u4E0A\u534A\u4E2A\u5B57\u88AB\u538B\u6389\u300D\u3002132 \u884C\u7684\u5217\u8868\u91CC\uFF0C\u5438\u9876\u7684\u6536\u76CA\u62B5\u4E0D\u4E0A\u8FD9\u4E2A\u98CE\u9669\u3002 */
.bbdl-row--folder {
  background: #2a303a;
  font-weight: 600;
  line-height: 1.45;
  border-radius: 9px 9px 0 0;
}

.bbdl-row--file:hover {
  background: #262b34;
}

.bbdl-check {
  margin: 0;
  width: 15px;
  height: 15px;
  accent-color: var(--bbdl-accent);
  cursor: pointer;
}

.bbdl-row__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.45;
}

.bbdl-row__size {
  color: var(--bbdl-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  font-size: 12px;
  line-height: 1.45;
}

/* \u8DEF\u5F84\u5355\u884C\u663E\u793A\uFF1Aword-break: break-all \u4F1A\u5728\u4EFB\u610F\u5B57\u7B26\u5904\u6298\u65AD\uFF0C\u628A\u6269\u5C55\u540D\u548C\u76EE\u5F55\u6BB5\u6495\u5F00\u3001
   \u884C\u9AD8\u88AB\u6491\u6210\u4E00\u5806\u300C\u5806\u53E0\u300D\uFF0C\u8FD9\u6B63\u662F\u7528\u6237\u62B1\u6028\u7684\u89C2\u611F\u3002\u6539\u6210 nowrap \u540E\u6574\u884C\u5BBD\u5EA6\u6309 min-content
   \u6491\u5F00\uFF0C.bbdl-tree \u7684 overflow: auto \u624D\u6709\u6A2A\u5411\u6EDA\u52A8\u6761\u53EF\u7ED9\uFF08\u914D\u5408 select.js \u7684 title \u5C5E\u6027\u515C\u5E95\u9605\u8BFB\uFF09\u3002*/
/* \u8DEF\u5F84\u5355\u884C\u663E\u793A\uFF1Aword-break: break-all \u4F1A\u5728\u4EFB\u610F\u5B57\u7B26\u5904\u6298\u65AD\uFF0C\u628A\u76EE\u5F55\u6BB5\u548C\u6269\u5C55\u540D\u6495\u5F00\u3001
   \u884C\u9AD8\u8DDF\u7740\u5806\u53E0\u3002\u6539\u6210 nowrap \u540E\u6574\u884C\u6309 min-content \u6491\u5F00\uFF0C.bbdl-tree \u7684 overflow: auto
   \u624D\u6709\u6A2A\u5411\u6EDA\u52A8\u6761\u53EF\u7ED9\uFF08\u914D\u5408 select.js \u91CC pathEl.title \u515C\u5E95\u9605\u8BFB\uFF09\u3002 */
.bbdl-row__path {
  grid-column: 2 / -1;
  color: #7d868f;
  font-size: 11.5px;
  line-height: 1.45;
  white-space: nowrap;
}

.bbdl-dialog__foot {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  background: var(--bbdl-bg-soft);
  border-top: 1px solid var(--bbdl-line);
  border-radius: 0 0 13px 13px;
  flex-wrap: wrap;
}

.bbdl-dialog__totals {
  font-variant-numeric: tabular-nums;
}

.bbdl-dialog__actions {
  display: flex;
  gap: 8px;
}

.bbdl-dialog__error {
  flex: 0 0 auto;
  margin: 0;
  padding: 8px 14px;
  background: #4a2523;
  border-top: 1px solid #6d3330;
  color: #ffb3ad;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.bbdl-hint {
  color: var(--bbdl-muted);
  font-size: 12px;
}

/* ---------- \u7B5B\u9009 / \u641C\u7D22 / \u6392\u5E8F ---------- */
.bbdl-search {
  flex: 1 1 160px;
  min-width: 120px;
  background: #12151a;
  color: var(--bbdl-fg);
  border: 1px solid var(--bbdl-line);
  border-radius: 8px;
  padding: 4px 8px;
  font-size: 12px;
}

.bbdl-search::placeholder {
  color: #6d7783;
}

.bbdl-types {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 10px;
}

.bbdl-types__item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  user-select: none;
  font-size: 12px;
  color: var(--bbdl-muted);
}

.bbdl-sort {
  background: #2f3540;
  color: var(--bbdl-fg);
  border: 1px solid var(--bbdl-line);
  border-radius: 8px;
  padding: 4px 6px;
  font-size: 12px;
}

/* ---------- \u843D\u76D8\u65B9\u5F0F\u6807\u6CE8 ---------- */
.bbdl-mode {
  margin: 0;
  padding: 6px 14px;
  background: #171b21;
  border-top: 1px solid var(--bbdl-line);
  color: var(--bbdl-muted);
  font-size: 12px;
  word-break: break-word;
}

.bbdl-panel__body .bbdl-mode {
  padding: 6px 8px;
  border: 1px solid var(--bbdl-line);
  border-radius: 8px;
}

/* ---------- \u65AD\u70B9\u7EED\u4F20\uFF1A\u8DF3\u8FC7\u5DF2\u5B58\u5728 / \u7EE7\u7EED\u4E0A\u6B21 / \u4E34\u65F6\u63D0\u793A ---------- */
.bbdl-notice {
  margin: 0;
  padding: 6px 8px;
  border: 1px solid #6b4a12;
  border-radius: 8px;
  background: #241d10;
  color: #f0c674;
  font-size: 12px;
  word-break: break-word;
}

.bbdl-resume {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--bbdl-line);
  border-radius: 8px;
  background: #171b21;
}

.bbdl-resume__text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--bbdl-muted);
}

.bbdl-switch--skip {
  color: var(--bbdl-muted);
}

.bbdl-note--skip {
  margin: 0;
  padding: 0 14px 6px;
  color: #f0c674;
  font-size: 12px;
  word-break: break-word;
}

/* \u5DF2\u5B58\u5728\u7684\u6587\u4EF6\uFF1A\u6574\u884C\u538B\u6697\u4F46\u4E0D\u7981\u7528\u52FE\u9009\u2014\u2014\u7528\u6237\u4ECD\u7136\u53EF\u4EE5\u5F3A\u884C\u91CD\u4E0B\u4E00\u6B21\u3002 */
.bbdl-row--skipped .bbdl-row__name,
.bbdl-row--skipped .bbdl-row__path,
.bbdl-row--skipped .bbdl-row__size {
  color: #6b7280;
}

.bbdl-row--skipped .bbdl-row__name {
  text-decoration: line-through;
}

/* \u9876\u90E8\u9884\u89C8\u884C\uFF1A\u4E00\u884C\u516D\u4E2A\u8BA1\u6570\uFF0C\u8D85\u51FA\u5C31\u7701\u7565\uFF0C\u4E0D\u8BB8\u6362\u884C\u628A\u5DE5\u5177\u680F\u6491\u9AD8\uFF08\u6362\u884C\u4F1A\u8BA9\u4E0B\u9762\u7684\u5217\u8868\u8DF3\u52A8\uFF09\u3002 */
.bbdl-toolbar__row--sync {
  padding-bottom: 4px;
}

.bbdl-sync {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--bbdl-muted);
}

/* \u7591\u4F3C\u5220\u9664\uFF1A\u6298\u53E0\u6761\u76EE\uFF0C\u53EA\u8BFB\u63D0\u793A\uFF0C\u5757\u5185\u6CA1\u6709\u4EFB\u4F55\u64CD\u4F5C\u6309\u94AE\u3002 */
.bbdl-stale {
  margin: 0 14px 6px;
  color: var(--bbdl-muted);
  font-size: 12px;
}

.bbdl-stale__head {
  cursor: pointer;
  color: #f0c674;
  word-break: break-word;
}

.bbdl-stale__list {
  margin: 4px 0 0;
  padding: 0 0 0 18px;
  max-height: 180px;
  overflow-y: auto;
}

.bbdl-stale__item {
  padding: 1px 0;
  word-break: break-all;
  color: #9aa4b2;
}

/* ---------- \u505C\u673A\u6A2A\u5E45 ---------- */
.bbdl-halt {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid #6d3330;
  border-radius: 8px;
  background: #4a2523;
  color: #ffb3ad;
  font-size: 12px;
}

.bbdl-halt__text {
  flex: 1 1 auto;
  min-width: 0;
  word-break: break-word;
}

/* ---------- \u9010\u6587\u4EF6\u5217\u8868\uFF08\u53EF\u6298\u53E0\uFF09 ---------- */
.bbdl-files {
  border-top: 1px solid var(--bbdl-line);
  padding-top: 6px;
  font-size: 12px;
}

.bbdl-files > .bbdl-files__summary {
  cursor: pointer;
  user-select: none;
  color: var(--bbdl-muted);
}

/* \u884C\u9AD8\u7531\u5185\u5BB9\u51B3\u5B9A\uFF1A\u53EA\u9650\u9AD8\u5EA6\u4E0D\u88C1\u884C\uFF0C\u6EDA\u52A8\u4EA4\u7ED9\u8FD9\u4E00\u5C42\u3002 */
.bbdl-files__body {
  margin-top: 4px;
  max-height: 220px;
  overflow: auto;
  overscroll-behavior: contain;
}

.bbdl-files__row {
  display: grid;
  /* \u540D\u79F0\u5403\u6389\u5269\u4F59\u5BBD\u5EA6\uFF0C\u72B6\u6001/\u5B57\u8282/\u91CD\u8BD5\u9760\u53F3\u5B9A\u5BBD \u2014\u2014 \u957F\u6587\u4EF6\u540D\u6C38\u8FDC\u8D70\u7701\u7565\u53F7\uFF0C\u4E0D\u6324\u8D70\u6570\u5B57\u5217\u3002 */
  grid-template-columns: minmax(0, 1fr) 46px 56px 40px;
  align-items: center;
  gap: 6px;
  padding: 3px 4px;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
  line-height: 1.45;
}

.bbdl-files__row:first-child {
  border-top: 0;
}

.bbdl-files__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.45;
}

.bbdl-files__status {
  font-size: 11.5px;
  white-space: nowrap;
  color: var(--bbdl-muted);
  text-align: right;
}

.bbdl-files__status--running {
  color: var(--bbdl-accent);
}

.bbdl-files__status--done {
  color: var(--bbdl-ok);
}

.bbdl-files__status--failed {
  color: var(--bbdl-danger);
}

.bbdl-files__status--skipped {
  color: #7d868f;
}

.bbdl-files__bytes,
.bbdl-files__retry {
  color: var(--bbdl-muted);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  text-align: right;
}

/* \u8DEF\u5F84\u53E6\u8D77\u4E00\u884C\u3001\u7070\u5B57\uFF1A\u7EDD\u4E0D\u6362\u884C\u6491\u9AD8\uFF0C\u8D85\u957F\u9760\u7701\u7565\u53F7 + title \u515C\u5E95\u3002 */
.bbdl-files__path {
  grid-column: 1 / -1;
  color: #7d868f;
  font-size: 11px;
  line-height: 1.45;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bbdl-files__more {
  margin: 2px 0 0;
  color: var(--bbdl-muted);
  font-size: 11.5px;
}

.bbdl-course {
  margin: 0 0 2px;
  color: var(--bbdl-muted);
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bbdl-history__summary,
.bbdl-history__row {
  cursor: pointer;
  font-size: 12px;
}

.bbdl-history__body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 4px;
}

.bbdl-history__item {
  border-left: 2px solid var(--bbdl-border, #3a3a3a);
  padding-left: 6px;
}

.bbdl-history__row {
  color: var(--bbdl-text);
  font-variant-numeric: tabular-nums;
}

.bbdl-history__paths {
  margin: 3px 0 0;
  padding-left: 16px;
  max-height: 180px;
  overflow: auto;
}

.bbdl-history__path {
  color: var(--bbdl-muted);
  font-size: 11px;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bbdl-settings__file {
  max-width: 150px;
  font-size: 11px;
  color: var(--bbdl-muted);
}

@media (prefers-color-scheme: light) {
  .bbdl-panel,
  .bbdl-overlay {
    color-scheme: dark;
  }
}
`;
  function injectStyles(doc) {
    const target = doc || (typeof document === "undefined" ? null : document);
    if (!target || target.getElementById(STYLE_ID)) return;
    const style = target.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    (target.head || target.documentElement).appendChild(style);
  }

  // src/ui/panel.js
  var CANCEL_WATCHDOG_MS = 3e3;
  var STATES = ["idle", "scanning", "scanned", "downloading", "done", "error", "empty"];
  function formatBytes(n) {
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "\u2014";
    if (n < 1024) return n + " B";
    const units = ["KB", "MB", "GB", "TB"];
    let value = n / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i += 1;
    }
    return (value >= 100 ? Math.round(value) : value.toFixed(1)) + " " + units[i];
  }
  var ABSOLUTE_URL = /(https?:\/\/[^\s?#]*)(?:\?[^\s#]*)?(?:#[^\s]*)?/gi;
  var RELATIVE_WITH_QUERY = /(\/[^\s?#]*)\?[^\s#]*/g;
  function redactUrlText(value) {
    const text = value == null ? "" : String(value);
    return text.replace(ABSOLUTE_URL, "$1").replace(RELATIVE_WITH_QUERY, "$1");
  }
  var ABSOLUTE_URL_LOOSE = /(?:https?:)?\/\/[^\s?#]*(?:\?[^\s#]*)?(?:#[^\s]*)?/gi;
  var QUIET_TEXT = /登录|过期|会话失效|重新登录|认证/;
  var QUIET_NOTICE_TEXT = "\u8BF7\u6C42\u88AB\u62D2\u7EDD\uFF0C\u7A0D\u540E\u4F1A\u81EA\u52A8\u91CD\u8BD5\u3002";
  var QUIET_REASON_TEXT = "\u8BF7\u6C42\u88AB\u62D2\u7EDD";
  function quietText(value) {
    const text = String(value == null ? "" : value);
    if (!text.trim()) return "";
    return QUIET_TEXT.test(text) ? QUIET_NOTICE_TEXT : text;
  }
  function quietReasonText(value) {
    const text = String(value == null ? "" : value);
    return QUIET_TEXT.test(text) ? QUIET_REASON_TEXT : text;
  }
  function stripUrlText(value) {
    const text = value == null ? "" : String(value);
    return text.replace(ABSOLUTE_URL_LOOSE, "").replace(/\s{2,}/g, " ").trim();
  }
  var RETRY_CLASS_ERROR = /停滞|文件不完整|重试/;
  function retryHintText(reason) {
    return RETRY_CLASS_ERROR.test(reason == null ? "" : String(reason)) ? "\u53EF\u7A0D\u540E\u70B9\u300C\u53EA\u91CD\u8BD5\u5931\u8D25\u7684\u300D\u518D\u8BD5\u4E00\u6B21" : "";
  }
  function pickNumber(source, keys, fallback) {
    for (const key of keys) {
      if (source && typeof source[key] === "number" && Number.isFinite(source[key]) && source[key] >= 0) {
        return source[key];
      }
    }
    return fallback;
  }
  function progressLine(payload, sample) {
    const p = payload || {};
    const filesDone = pickNumber(p, ["filesDone", "done"], 0);
    const filesTotal = pickNumber(p, ["filesTotal", "total"], 0);
    const bytesDone = pickNumber(p, ["bytesDone", "bytes"], 0);
    const bytesTotal = pickNumber(p, ["bytesTotal"], 0);
    const current = typeof p.currentPath === "string" && p.currentPath ? p.currentPath : "";
    const files3 = filesTotal > 0 ? filesDone + "/" + filesTotal + " \u4E2A\u6587\u4EF6" : "\u5DF2\u5B8C\u6210 " + filesDone + " \u4E2A\u6587\u4EF6";
    let text;
    if (bytesTotal > 0) {
      const percent = Math.max(0, Math.min(100, Math.round(bytesDone / bytesTotal * 100)));
      text = formatBytes(bytesDone) + " / " + formatBytes(bytesTotal) + "\uFF08" + percent + "%\uFF09\xB7 " + files3;
    } else {
      text = "\u5DF2\u4E0B\u8F7D " + formatBytes(bytesDone) + " \xB7 " + files3 + "\uFF08\u603B\u91CF\u672A\u77E5\uFF0C\u4E0D\u663E\u793A\u767E\u5206\u6BD4\uFF09";
    }
    if (sample && bytesTotal > 0 && Number.isFinite(sample.bytes) && Number.isFinite(sample.at)) {
      const elapsed = Date.now() - sample.at;
      const gained = bytesDone - sample.bytes;
      if (elapsed > 0 && gained > 0) {
        const rate = gained / (elapsed / 1e3);
        const remain = (bytesTotal - bytesDone) / rate;
        if (Number.isFinite(remain) && remain > 0) {
          text += remain >= 60 ? " \xB7 \u5269\u7EA6 " + Math.max(1, Math.round(remain / 60)) + " \u5206" : " \xB7 \u5269\u7EA6 " + Math.max(1, Math.round(remain)) + " \u79D2";
        }
      }
    }
    if (current) text += " \xB7 \u5F53\u524D\uFF1A" + redactUrlText(current);
    return text;
  }
  var RETRY_RESET_STATES = /* @__PURE__ */ new Set(["start", "file-start", "file-done", "file-failed", "aborted", "done"]);
  function retryFileName(value) {
    const raw = String(value == null ? "" : value);
    const cut = raw.search(/[?#]/);
    return redactUrlText(cut === -1 ? raw : raw.slice(0, cut));
  }
  function trackRetry(prev, payload) {
    const p = payload || {};
    const state = typeof p.state === "string" ? p.state : "";
    const current = prev && prev.count > 0 ? prev : { path: "", count: 0 };
    if (state === "file-retry") {
      const path = retryFileName(p.currentPath || p.path || "");
      return { path, count: current.path === path ? current.count + 1 : 1 };
    }
    if (RETRY_RESET_STATES.has(state)) return { path: "", count: 0 };
    return current;
  }
  function retryLine(retry, existing) {
    if (!retry || !(retry.count > 0)) return "";
    const text = " \xB7 \u91CD\u8BD5\u4E2D\uFF08\u7B2C " + retry.count + " \u6B21\uFF09";
    if (!retry.path || existing && existing.indexOf(retry.path) !== -1) return text;
    return text + "\uFF1A" + retry.path;
  }
  var MAX_FILE_ROWS = 500;
  var FILE_STATUS_TEXT = {
    waiting: "\u7B49\u5F85",
    running: "\u4E0B\u8F7D\u4E2D",
    done: "\u5B8C\u6210",
    failed: "\u5931\u8D25",
    skipped: "\u8DF3\u8FC7"
  };
  function stripQuery2(value) {
    const raw = String(value == null ? "" : value);
    const cut = raw.search(/[?#]/);
    return cut === -1 ? raw : raw.slice(0, cut);
  }
  function safeNameText(value) {
    return redactUrlText(stripQuery2(value));
  }
  function safePathText(value) {
    const raw = String(value == null ? "" : value).replace(/^\s*[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "");
    return redactUrlText(stripQuery2(raw));
  }
  function finiteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  var MAX_HISTORY_ROWS = 5;
  var MAX_HISTORY_PATHS = 20;
  function formatScanTime(at) {
    const n = finiteNumber(at);
    if (n == null || n <= 0) return "";
    const date = new Date(Math.floor(n));
    if (Number.isNaN(date.getTime())) return "";
    const pad = (value) => value < 10 ? "0" + value : String(value);
    return pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
  }
  function countText(value) {
    const n = finiteNumber(value);
    return String(n == null || n < 0 ? 0 : Math.floor(n));
  }
  function historyLineText(scan) {
    const s = scan || {};
    const time = formatScanTime(s.at);
    const counts = "\u65B0\u589E " + countText(s.added) + " \xB7 \u53D8\u66F4 " + countText(s.changed) + " \xB7 \u6539\u540D " + countText(s.moved) + " \xB7 \u672A\u53D8 " + countText(s.unchanged) + " \xB7 \u672A\u77E5 " + countText(s.unknown) + " \xB7 \u7591\u4F3C\u5220\u9664 " + countText(s.stale);
    return time ? time + " \xB7 " + counts : counts;
  }
  function entryIdOf(entry) {
    const raw = entry && entry.id != null ? entry.id : entry && entry.entryId;
    if (raw == null || raw === "") return "";
    return String(raw);
  }
  function seedFileStatus(entry) {
    const raw = entry && typeof entry.status === "string" ? entry.status : "";
    return Object.prototype.hasOwnProperty.call(FILE_STATUS_TEXT, raw) ? raw : "waiting";
  }
  function adoptResolvedName(record, event) {
    const e = event || {};
    const absolute = function(value) {
      return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(value == null ? "" : value).trim());
    };
    const name = absolute(e.name) ? "" : safeNameText(e.name);
    if (name) record.name = name;
    if (absolute(e.path)) return;
    const dir = safePathText(e.path).replace(/^\/+|\/+$/g, "").replace(/\/[^/]*$/, "");
    if (dir) record.path = dir;
  }
  function entryPathText(entry) {
    const e = entry || {};
    const segments = Array.isArray(e.folderPath) ? e.folderPath : [];
    if (segments.length) {
      return segments.map(function(part) {
        return safePathText(part);
      }).join(" / ");
    }
    return safePathText(e.path || "");
  }
  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }
  function button(className, act, text) {
    const el = node("button", className, text);
    el.type = "button";
    el.dataset.act = act;
    return el;
  }
  function viewFor(state, ctx) {
    const hasEntries = ctx.entryCount > 0;
    const message = ctx.message || "";
    switch (state) {
      case "scanning":
        return {
          status: "\u6B63\u5728\u626B\u63CF\u8BFE\u7A0B\u5185\u5BB9\u2026\uFF08\u53EF\u968F\u65F6\u53D6\u6D88\uFF09",
          scan: { label: "\u626B\u63CF\u4E2D\u2026", disabled: true },
          download: { label: "\u9009\u62E9\u5E76\u4E0B\u8F7D", disabled: true },
          cancel: { hidden: false, label: "\u53D6\u6D88\u626B\u63CF", disabled: false }
        };
      case "downloading":
        return {
          status: "\u6B63\u5728\u4E0B\u8F7D\u2026\uFF08\u53EF\u968F\u65F6\u53D6\u6D88\uFF09",
          scan: { label: "\u626B\u63CF", disabled: true },
          download: { label: "\u4E0B\u8F7D\u4E2D\u2026", disabled: true },
          cancel: { hidden: false, label: "\u53D6\u6D88\u4E0B\u8F7D", disabled: false }
        };
      case "scanned":
        return {
          status: "\u626B\u63CF\u5B8C\u6210\uFF1A\u5171 " + ctx.entryCount + " \u4E2A\u6587\u4EF6\uFF0C\u52FE\u9009\u540E\u5373\u53EF\u4E0B\u8F7D\u3002",
          scan: { label: "\u91CD\u65B0\u626B\u63CF", disabled: false },
          download: { label: "\u9009\u62E9\u5E76\u4E0B\u8F7D", disabled: !hasEntries },
          cancel: { hidden: true }
        };
      case "done":
        return {
          status: "\u5DF2\u5B8C\u6210\u3002\u53EF\u4EE5\u91CD\u65B0\u626B\u63CF\uFF0C\u6216\u518D\u9009\u4E00\u6279\u6587\u4EF6\u4E0B\u8F7D\u3002",
          scan: { label: "\u91CD\u65B0\u626B\u63CF", disabled: false },
          download: { label: "\u518D\u4E0B\u8F7D\u4E00\u6B21", disabled: !hasEntries, hint: hasEntries ? "" : "\u5148\u626B\u63CF\u8BFE\u7A0B" },
          cancel: { hidden: true }
        };
      case "empty":
        return {
          status: "\u672C\u8BFE\u7A0B\u4E0B\u6CA1\u6709\u627E\u5230\u53EF\u4E0B\u8F7D\u7684\u6587\u4EF6\u3002\u53EF\u6362\u4E00\u4E2A\u5185\u5BB9\u9875\u6216\u91CD\u65B0\u626B\u63CF\u3002",
          scan: { label: "\u91CD\u65B0\u626B\u63CF", disabled: false },
          download: { label: "\u9009\u62E9\u5E76\u4E0B\u8F7D", disabled: true, hint: "\u6CA1\u6709\u53EF\u4E0B\u8F7D\u6587\u4EF6" },
          cancel: { hidden: true }
        };
      case "error":
        return {
          status: message ? "\u51FA\u9519\u4E86\uFF1A" + message : "\u51FA\u9519\u4E86\uFF1A\u672A\u77E5\u9519\u8BEF\u3002\u53EF\u91CD\u8BD5\u6216\u5237\u65B0\u9875\u9762\u3002",
          scan: { label: "\u91CD\u8BD5\u626B\u63CF", disabled: false },
          download: { label: "\u9009\u62E9\u5E76\u4E0B\u8F7D", disabled: !hasEntries, hint: hasEntries ? "" : "\u5148\u626B\u63CF\u8BFE\u7A0B" },
          cancel: { hidden: true }
        };
      case "idle":
      default:
        return {
          status: "\u5C31\u7EEA\uFF1A\u70B9\u51FB\u300C\u5F00\u59CB\u626B\u63CF\u300D\u8BFB\u53D6\u672C\u8BFE\u7A0B\u7684\u6587\u4EF6\u5217\u8868\u3002",
          scan: { label: "\u5F00\u59CB\u626B\u63CF", disabled: false },
          download: { label: "\u9009\u62E9\u5E76\u4E0B\u8F7D", disabled: !hasEntries, hint: hasEntries ? "" : "\u5148\u626B\u63CF\u8BFE\u7A0B" },
          cancel: { hidden: true }
        };
    }
  }
  function findMountedPanel() {
    if (typeof document === "undefined" || !document.querySelector) return null;
    return document.querySelector(".bbdl-panel");
  }
  function reusePanel(root, opts) {
    const api = root && root.__bbdlApi;
    if (api && typeof api.rebind === "function") {
      api.rebind(opts);
      return api;
    }
    const statusEl = root ? root.querySelector(".bbdl-status") : null;
    const noop = function() {
    };
    return {
      setState(state) {
        if (root) root.dataset.state = String(state || "idle");
      },
      setCount: noop,
      setScanProgress: noop,
      setDownloadProgress: noop,
      setMode: noop,
      setNotice: noop,
      setResume: noop,
      setFiles: noop,
      applyFileEvent: noop,
      setHalted: noop,
      clearHalted: noop,
      setRecovering: noop,
      clearRecovering: noop,
      showSummary: noop,
      setCourse: noop,
      setHistory: noop,
      rebind: noop,
      fail(message) {
        if (statusEl) statusEl.textContent = "\u51FA\u9519\u4E86\uFF1A" + quietText(redactUrlText(message));
        if (root) root.dataset.state = "error";
      },
      destroy: noop
    };
  }
  function mountPanel(options) {
    const opts = options || {};
    const mounted = findMountedPanel();
    if (mounted) return reusePanel(mounted, opts);
    let settings = opts.settings || {};
    let onScan = typeof opts.onScan === "function" ? opts.onScan : null;
    let onDownload = typeof opts.onDownload === "function" ? opts.onDownload : null;
    let onCancel = typeof opts.onCancel === "function" ? opts.onCancel : null;
    let onSettingsChange = typeof opts.onSettingsChange === "function" ? opts.onSettingsChange : null;
    let onRetryFailed = typeof opts.onRetryFailed === "function" ? opts.onRetryFailed : null;
    let onResume = typeof opts.onResume === "function" ? opts.onResume : null;
    let onResumePending = typeof opts.onResumePending === "function" ? opts.onResumePending : null;
    let onExportManifest = typeof opts.onExportManifest === "function" ? opts.onExportManifest : null;
    let onImportManifest = typeof opts.onImportManifest === "function" ? opts.onImportManifest : null;
    injectStyles();
    const timers = [];
    let current = "idle";
    let context = { entryCount: 0, message: "" };
    let watchdog = 0;
    let destroyed = false;
    let sample = null;
    const retries = /* @__PURE__ */ new Map();
    let summaryState = { ok: 0, failed: [], aborted: false };
    let fileOrder = [];
    let fileMap = /* @__PURE__ */ new Map();
    let haltText = "";
    let haltPendingCount = 0;
    let recoveringAttempt = 0;
    let downloadNote = "";
    const root = node("div", "bbdl-panel");
    root.dataset.state = "idle";
    root.setAttribute("role", "complementary");
    root.setAttribute("aria-label", "BB \u8BFE\u4EF6\u6279\u91CF\u4E0B\u8F7D");
    const card = node("div", "bbdl-panel__card");
    const head = node("div", "bbdl-panel__head");
    const title = node("span", "bbdl-panel__title", "BB \u6279\u91CF\u4E0B\u8F7D");
    const collapseBtn = button("bbdl-btn bbdl-btn--icon", "collapse", "\u2013");
    collapseBtn.title = "\u6298\u53E0\u4E3A\u5C0F\u5706\u94AE";
    head.appendChild(title);
    head.appendChild(collapseBtn);
    const body = node("div", "bbdl-panel__body");
    const courseEl = node("p", "bbdl-course");
    courseEl.hidden = true;
    const statusEl = node("p", "bbdl-status");
    const progressEl = node("div", "bbdl-progress");
    progressEl.hidden = true;
    const trackEl = node("div", "bbdl-progress__track");
    const fillEl = node("span", "bbdl-progress__fill");
    trackEl.appendChild(fillEl);
    const progressTextEl = node("p", "bbdl-progress__text");
    progressEl.appendChild(trackEl);
    progressEl.appendChild(progressTextEl);
    const actionsEl = node("div", "bbdl-actions");
    const scanBtn = button("bbdl-btn bbdl-btn--primary", "scan", "\u5F00\u59CB\u626B\u63CF");
    const downloadBtn = button("bbdl-btn", "download", "\u9009\u62E9\u5E76\u4E0B\u8F7D");
    const cancelBtn = button("bbdl-btn bbdl-btn--danger", "cancel", "\u53D6\u6D88");
    cancelBtn.hidden = true;
    actionsEl.appendChild(scanBtn);
    actionsEl.appendChild(downloadBtn);
    actionsEl.appendChild(cancelBtn);
    const noticeEl = node("p", "bbdl-notice");
    noticeEl.hidden = true;
    const haltEl = node("div", "bbdl-halt");
    haltEl.setAttribute("role", "alert");
    haltEl.hidden = true;
    const filesEl = node("details", "bbdl-files");
    filesEl.hidden = true;
    const filesSummaryEl = node("summary", "bbdl-files__summary", "\u6587\u4EF6\u5217\u8868");
    const filesBodyEl = node("div", "bbdl-files__body");
    const filesMoreEl = node("p", "bbdl-files__more");
    filesMoreEl.hidden = true;
    filesEl.appendChild(filesSummaryEl);
    filesEl.appendChild(filesBodyEl);
    filesEl.appendChild(filesMoreEl);
    const historyEl = node("details", "bbdl-history");
    historyEl.hidden = true;
    historyEl.appendChild(node("summary", "bbdl-history__summary", "\u626B\u63CF\u5386\u53F2"));
    const historyBodyEl = node("div", "bbdl-history__body");
    historyEl.appendChild(historyBodyEl);
    const resumeEl = node("div", "bbdl-resume");
    resumeEl.hidden = true;
    const resumeTextEl = node("span", "bbdl-resume__text");
    const resumeBtn = button("bbdl-btn bbdl-btn--small", "resume", "\u7EE7\u7EED\u4E0A\u6B21");
    resumeEl.appendChild(resumeTextEl);
    resumeEl.appendChild(resumeBtn);
    const settingsEl = node("details", "bbdl-settings");
    settingsEl.appendChild(node("summary", null, "\u8BBE\u7F6E"));
    const probeRow = node("label", "bbdl-settings__row");
    const probeInput = node("input");
    probeInput.type = "checkbox";
    probeInput.checked = settings.probeSizes !== false;
    probeRow.appendChild(probeInput);
    probeRow.appendChild(node("span", null, "\u63A2\u6D4B\u6587\u4EF6\u4F53\u79EF"));
    settingsEl.appendChild(probeRow);
    const concRow = node("label", "bbdl-settings__row");
    concRow.appendChild(node("span", null, "\u4E0B\u8F7D\u5E76\u53D1"));
    const concInput = node("input");
    concInput.type = "number";
    concInput.min = "1";
    concInput.max = "8";
    concInput.step = "1";
    concInput.value = String(settings.downloadConcurrency || 4);
    concRow.appendChild(concInput);
    settingsEl.appendChild(concRow);
    const expandRow = node("label", "bbdl-settings__row");
    const expandInput = node("input");
    expandInput.type = "checkbox";
    expandInput.checked = settings.panelCollapsed === false;
    expandRow.appendChild(expandInput);
    expandRow.appendChild(node("span", null, "\u6253\u5F00\u9875\u9762\u65F6\u5C55\u5F00\u9762\u677F"));
    settingsEl.appendChild(expandRow);
    const autoReloadRow = node("label", "bbdl-settings__row");
    const autoReloadInput = node("input");
    autoReloadInput.type = "checkbox";
    autoReloadInput.checked = settings.autoReload !== false;
    autoReloadRow.appendChild(autoReloadInput);
    autoReloadRow.appendChild(node("span", null, "\u4F1A\u8BDD\u5F02\u5E38\u65F6\u81EA\u52A8\u91CD\u8F7D\u7EED\u8DD1"));
    settingsEl.appendChild(autoReloadRow);
    settingsEl.appendChild(node("p", "bbdl-note", "\u76EE\u5F55\u7ED3\u6784\u5F00\u5173\u5728\u300C\u9009\u62E9\u5E76\u4E0B\u8F7D\u300D\u5BF9\u8BDD\u6846\u91CC\u3002"));
    const exportRow = node("div", "bbdl-settings__row");
    const exportBtn = button("bbdl-btn bbdl-btn--small", "export-manifest", "\u5BFC\u51FA\u6E05\u5355");
    exportBtn.title = "\u628A\u672C\u8BFE\u7A0B\u7684\u4E0B\u8F7D\u6E05\u5355\u5B58\u6210 JSON \u6587\u4EF6\uFF08\u4E0D\u542B\u4EFB\u4F55\u94FE\u63A5\uFF09";
    exportRow.appendChild(exportBtn);
    exportRow.hidden = !onExportManifest;
    settingsEl.appendChild(exportRow);
    const importRow = node("label", "bbdl-settings__row");
    importRow.appendChild(node("span", null, "\u5BFC\u5165\u6E05\u5355"));
    const importInput = node("input", "bbdl-settings__file");
    importInput.type = "file";
    importInput.accept = ".json,application/json";
    importRow.appendChild(importInput);
    importRow.hidden = !onImportManifest;
    settingsEl.appendChild(importRow);
    importInput.addEventListener("change", function() {
      const picked = importInput.files && importInput.files.length ? importInput.files[0] : null;
      importInput.value = "";
      if (!picked || !onImportManifest) return;
      try {
        const pending = onImportManifest(picked);
        if (pending && typeof pending.catch === "function") pending.catch(function() {
        });
      } catch (err) {
        render("error", { message: err && err.message || String(err) });
      }
    });
    const modeEl = node("p", "bbdl-mode");
    modeEl.hidden = true;
    const summaryEl = node("div", "bbdl-summary");
    summaryEl.hidden = true;
    body.appendChild(courseEl);
    body.appendChild(statusEl);
    body.appendChild(noticeEl);
    body.appendChild(haltEl);
    body.appendChild(progressEl);
    body.appendChild(resumeEl);
    body.appendChild(actionsEl);
    body.appendChild(filesEl);
    body.appendChild(historyEl);
    body.appendChild(settingsEl);
    body.appendChild(modeEl);
    body.appendChild(summaryEl);
    card.appendChild(head);
    card.appendChild(body);
    const fab = button("bbdl-fab", "expand", "");
    fab.title = "\u5C55\u5F00\u9762\u677F";
    fab.setAttribute("aria-expanded", "false");
    const fabTitleEl = node("span", "bbdl-fab__title", "BB \u6279\u91CF\u4E0B\u8F7D");
    const fabStatusEl = node("span", "bbdl-fab__status");
    const fabHintEl = node("span", "bbdl-fab__hint", "\u70B9\u51FB\u5C55\u5F00");
    fab.appendChild(fabTitleEl);
    fab.appendChild(fabStatusEl);
    fab.appendChild(fabHintEl);
    root.appendChild(card);
    root.appendChild(fab);
    const host = document.body || document.documentElement;
    host.appendChild(root);
    setCollapsed(settings.panelCollapsed !== false, { persist: false });
    function clearWatchdog() {
      if (watchdog) {
        clearTimeout(watchdog);
        watchdog = 0;
      }
    }
    function setBar(percent) {
      const value = Math.max(0, Math.min(100, Number(percent) || 0));
      fillEl.style.width = value + "%";
    }
    function applyButton(btn, spec) {
      if (!spec) return;
      btn.textContent = spec.label;
      btn.disabled = !!spec.disabled;
      btn.title = spec.hint || "";
    }
    function render(state, nextContext) {
      if (destroyed) return;
      const next = STATES.indexOf(state) >= 0 ? state : "error";
      current = next;
      context = {
        entryCount: nextContext && typeof nextContext.entryCount === "number" ? nextContext.entryCount : context.entryCount,
        // 所有进 DOM 的错误文案都在这里过一遍脱敏，调用方不必记得这件事；命中红线的整句不上屏。
        message: nextContext && nextContext.message ? quietText(redactUrlText(nextContext.message)) : ""
      };
      root.dataset.state = next;
      const view = viewFor(next, context);
      if (recoveringAttempt > 0) {
        view.status = "\u6B63\u5728\u81EA\u52A8\u6062\u590D\uFF08\u7B2C " + recoveringAttempt + " \u6B21\uFF09\u2026";
      } else if (next === "done" && haltPendingCount > 0) {
        view.status = "\u5DF2\u6682\u505C\uFF0C\u672A\u4E0B\u8F7D " + haltPendingCount + " \u4E2A\u6587\u4EF6\u3002";
      }
      applyButton(scanBtn, view.scan);
      applyButton(downloadBtn, view.download);
      if (view.cancel.hidden) {
        cancelBtn.hidden = true;
        cancelBtn.disabled = false;
        cancelBtn.textContent = "\u53D6\u6D88";
      } else {
        cancelBtn.hidden = false;
        cancelBtn.disabled = !!view.cancel.disabled;
        cancelBtn.textContent = view.cancel.label;
      }
      statusEl.textContent = view.status;
      progressEl.hidden = next !== "scanning" && next !== "downloading";
      refreshFabStatus();
      if (next === "scanning" || next === "downloading") {
        summaryEl.hidden = true;
        summaryEl.textContent = "";
        setBar(0);
        progressTextEl.textContent = next === "scanning" ? "\u51C6\u5907\u626B\u63CF\u2026" : "\u51C6\u5907\u4E0B\u8F7D\u2026";
      }
    }
    function emitSettings(patch) {
      if (!onSettingsChange) return;
      try {
        onSettingsChange(patch);
      } catch (err) {
        render("error", { message: err && err.message || String(err) });
      }
    }
    function setCollapsed(collapsed, options2) {
      const next = !!collapsed;
      root.classList.toggle("bbdl-panel--collapsed", next);
      fab.setAttribute("aria-expanded", next ? "false" : "true");
      if (!options2 || options2.persist !== false) emitSettings({ panelCollapsed: next });
    }
    function refreshFabStatus() {
      if (destroyed) return;
      let text = "";
      if (recoveringAttempt > 0) text = "\u6062\u590D\u4E2D";
      else if (haltText) text = "\u5DF2\u6682\u505C";
      else if (current === "error") text = "\u51FA\u9519";
      else if (current === "downloading") text = downloadNote || "\u4E0B\u8F7D\u4E2D";
      else if (current === "scanning") text = "\u626B\u63CF\u4E2D";
      fabStatusEl.textContent = text;
      fabStatusEl.title = text;
    }
    probeInput.addEventListener("change", function() {
      emitSettings({ probeSizes: probeInput.checked });
    });
    concInput.addEventListener("change", function() {
      const parsed = Math.round(Number(concInput.value));
      const value = Number.isFinite(parsed) ? Math.max(1, Math.min(8, parsed)) : 4;
      concInput.value = String(value);
      emitSettings({ downloadConcurrency: value });
    });
    expandInput.addEventListener("change", function() {
      emitSettings({ panelCollapsed: !expandInput.checked });
    });
    autoReloadInput.addEventListener("change", function() {
      emitSettings({ autoReload: autoReloadInput.checked });
    });
    function requestCancel() {
      if (!onCancel) return;
      cancelBtn.disabled = true;
      cancelBtn.textContent = "\u6B63\u5728\u53D6\u6D88\u2026";
      clearWatchdog();
      watchdog = setTimeout(function() {
        watchdog = 0;
        render(current, context);
      }, CANCEL_WATCHDOG_MS);
      try {
        onCancel();
      } catch (err) {
        render("error", { message: err && err.message || String(err) });
      }
    }
    root.addEventListener("click", function(event) {
      const target = event.target;
      const el = target && target.closest ? target.closest("[data-act]") : null;
      if (!el || !root.contains(el)) return;
      if (el.disabled) return;
      switch (el.dataset.act) {
        case "collapse":
          setCollapsed(true);
          break;
        case "expand":
          setCollapsed(false);
          break;
        case "scan":
          if (onScan) onScan();
          break;
        case "download":
          if (onDownload) onDownload();
          break;
        case "resume":
          if (onResume) onResume();
          break;
        case "resume-pending":
          if (onResumePending) onResumePending();
          break;
        case "export-manifest":
          if (onExportManifest) onExportManifest();
          break;
        case "cancel":
          requestCancel();
          break;
        default:
          break;
      }
    });
    function setState(state, extra) {
      clearWatchdog();
      if (state === "scanning" || state === "downloading") {
        haltPendingCount = 0;
        recoveringAttempt = 0;
        downloadNote = "";
      }
      const nextContext = {};
      if (extra && typeof extra.count === "number") nextContext.entryCount = extra.count;
      else if (extra && typeof extra.entryCount === "number") nextContext.entryCount = extra.entryCount;
      if (extra && extra.message) nextContext.message = extra.message;
      render(state, nextContext);
    }
    function setCount(count) {
      context.entryCount = Number(count) || 0;
    }
    function setScanProgress(progress) {
      if (destroyed) return;
      const p = progress || {};
      const done = Number(p.foldersDone) || 0;
      const queued = Number(p.foldersQueued) || 0;
      const files3 = Number(p.filesFound) || 0;
      progressEl.hidden = false;
      setBar(queued ? done / queued * 100 : 12);
      const scope = queued ? done + " / " + queued : done + "\uFF08\u5DF2\u5B8C\u6210\uFF09";
      progressTextEl.textContent = "\u6587\u4EF6\u5939 " + scope + " \xB7 \u5DF2\u53D1\u73B0 " + files3 + " \u4E2A\u6587\u4EF6";
    }
    function setDownloadProgress(progress) {
      if (destroyed) return;
      const p = progress || {};
      const filesDone = pickNumber(p, ["filesDone", "done"], 0);
      const filesTotal = pickNumber(p, ["filesTotal", "total"], 0);
      const bytesDone = pickNumber(p, ["bytesDone", "bytes"], 0);
      const bytesTotal = pickNumber(p, ["bytesTotal"], 0);
      const failedCount = pickNumber(p, ["failed"], 0);
      progressEl.hidden = false;
      const ratio = bytesTotal > 0 ? bytesDone / bytesTotal : filesTotal > 0 ? filesDone / filesTotal : 0;
      setBar(ratio * 100);
      let text = progressLine(p, sample);
      if (p.state === "start") retries.clear();
      const key = p.entryId || p.currentPath || p.path || "";
      const retryState = trackRetry(retries.get(key), p);
      if (retryState.count) retries.set(key, retryState);
      else retries.delete(key);
      text += retryLine(retryState, text);
      if (failedCount) text += " \xB7 \u5931\u8D25 " + failedCount;
      progressTextEl.textContent = text;
      progressTextEl.title = text;
      downloadNote = filesTotal > 0 ? "\u4E0B\u8F7D " + filesDone + "/" + filesTotal : "\u4E0B\u8F7D\u4E2D";
      refreshFabStatus();
      const now = Date.now();
      if (!sample || now - sample.at >= 800) sample = { at: now, bytes: bytesDone };
    }
    function setNotice(text) {
      if (destroyed) return;
      const value = text == null ? "" : quietText(redactUrlText(String(text)));
      noticeEl.textContent = value;
      noticeEl.hidden = !value;
      noticeEl.title = value;
    }
    function setCourse(courseId, courseName) {
      if (destroyed) return;
      const id = safePathText(courseId);
      const name = safeNameText(courseName);
      const text = name ? "\u5F53\u524D\u8BFE\u7A0B\uFF1A" + name + (id && name !== id ? "\uFF08" + id + "\uFF09" : "") : id ? "\u5F53\u524D\u8BFE\u7A0B\uFF1A" + id : "";
      courseEl.textContent = text;
      courseEl.title = text;
      courseEl.hidden = !text;
    }
    function setHistory(scans) {
      if (destroyed) return;
      historyBodyEl.textContent = "";
      const list = Array.isArray(scans) ? scans.slice(0, MAX_HISTORY_ROWS) : [];
      let rows = 0;
      for (const scan of list) {
        if (!scan || typeof scan !== "object") continue;
        const item = node("details", "bbdl-history__item");
        const rowText = historyLineText(scan);
        const rowEl = node("summary", "bbdl-history__row", rowText);
        rowEl.title = rowText;
        item.appendChild(rowEl);
        const paths = Array.isArray(scan.changedPaths) ? scan.changedPaths.slice(0, MAX_HISTORY_PATHS) : [];
        const ul = node("ul", "bbdl-history__paths");
        for (const pathItem of paths) {
          const raw = pathItem && typeof pathItem === "object" ? pathItem.path : pathItem;
          const text = safePathText(raw);
          if (!text) continue;
          const li = node("li", "bbdl-history__path", text);
          li.title = text;
          ul.appendChild(li);
        }
        if (ul.childNodes.length) item.appendChild(ul);
        historyBodyEl.appendChild(item);
        rows += 1;
      }
      historyEl.hidden = rows === 0;
    }
    function setResume(info) {
      if (destroyed) return;
      const visible = !!(info && info.dirName);
      resumeEl.hidden = !visible;
      if (!visible) {
        resumeTextEl.textContent = "";
        return;
      }
      const granted = info.granted !== false;
      resumeTextEl.textContent = "\u4E0A\u6B21\u4FDD\u5B58\u5230\u300C" + info.dirName + "\u300D\uFF0C\u53EF\u7EE7\u7EED" + (granted ? "" : "\uFF08\u9700\u8981\u518D\u786E\u8BA4\u4E00\u6B21\u76EE\u5F55\u6743\u9650\uFF09");
      resumeTextEl.title = resumeTextEl.textContent;
    }
    const MODE_TEXT = {
      fs: "\u843D\u76D8\u65B9\u5F0F\uFF1A\u4FDD\u5B58\u5230\u6587\u4EF6\u5939\uFF08Chromium\uFF09\u2014\u2014\u76F4\u63A5\u5199\u5165\u4F60\u9009\u7684\u76EE\u5F55\uFF0C\u4FDD\u7559\u539F\u76EE\u5F55\u7ED3\u6784\u3002\u4EE3\u4EF7\uFF1A\u6BCF\u6B21\u4E0B\u8F7D\u90FD\u8981\u91CD\u65B0\u9009\u4E00\u6B21\u6587\u4EF6\u5939\uFF0C\u4E14\u53EA\u6709 Chromium \u7CFB\u6D4F\u89C8\u5668\u652F\u6301\u3002",
      zip: "\u843D\u76D8\u65B9\u5F0F\uFF1A\u6309\u6587\u4EF6\u5939\u6253\u5305\u6210 .zip\uFF08\u5B58\u5230\u6D4F\u89C8\u5668\u9ED8\u8BA4\u4E0B\u8F7D\u76EE\u5F55\uFF09\u2014\u2014\u6CA1\u6709\u76EE\u5F55\u5199\u5165\u6743\u9650\u65F6\u81EA\u52A8\u9000\u5230\u8FD9\u79CD\u65B9\u5F0F\uFF0C\u89E3\u538B\u540E\u5373\u53EF\u8FD8\u539F\u539F\u76EE\u5F55\u7ED3\u6784\u3002ZIP \u5E76\u53D1\u4E3A 1\uFF0C\u9010\u4E2A\u8BFB\u53D6\u5E76\u5C01\u5305\u3002\u5305\u5185\u90E8\u5206\u6587\u4EF6\u5931\u8D25\u65F6\uFF0C\u53EF\u4EE5\u5355\u72EC\u91CD\u8BD5\u7F3A\u5C11\u7684\u6587\u4EF6\u3002",
      download: "\u843D\u76D8\u65B9\u5F0F\uFF1A\u9010\u6587\u4EF6\u4E0B\u8F7D\uFF08\u8FDB\u6D4F\u89C8\u5668\u9ED8\u8BA4\u4E0B\u8F7D\u76EE\u5F55\uFF09\u2014\u2014\u7F51\u9875\u62FF\u4E0D\u5230\u76EE\u5F55\u5199\u6743\u9650\uFF0C\u6587\u4EF6\u540D\u7528 folder__ \u524D\u7F00\u4EE3\u66FF\u5B50\u76EE\u5F55\u3002\u4EE3\u4EF7\uFF1A\u6240\u6709\u6587\u4EF6\u90FD\u843D\u5728\u9ED8\u8BA4\u4E0B\u8F7D\u76EE\u5F55\u91CC\uFF0C\u65E0\u6CD5\u5EFA\u5B50\u76EE\u5F55\uFF0C\u6587\u4EF6\u591A\u65F6\u4F1A\u8FDE\u7EED\u5F39\u51FA\u591A\u4E2A\u4E0B\u8F7D\u3002\u53E6\u5916\u8FD9\u91CC\u53EA\u80FD\u6309\u4E0B\u8F7D\u6E05\u5355\u8DF3\u8FC7\u5DF2\u4E0B\u8FC7\u7684\u6587\u4EF6\uFF0C\u65E0\u6CD5\u6838\u5B9E\u78C1\u76D8\u6587\u4EF6\u3002"
    };
    function setMode(kind) {
      if (destroyed) return;
      const text = MODE_TEXT[kind];
      modeEl.hidden = !text;
      modeEl.textContent = text || "";
      modeEl.title = text || "";
    }
    function entryPath(entry) {
      return Array.isArray(entry && entry.folderPath) && entry.folderPath.length ? entry.folderPath.join(" / ") : "";
    }
    function failedListText(failed) {
      return failed.map(function(item) {
        const entry = item && item.entry || {};
        const path = entryPath(entry);
        const name = redactUrlText(entry.name || "(\u672A\u547D\u540D\u6587\u4EF6)");
        const reason = stripUrlText(item && item.error || "\u672A\u77E5\u9519\u8BEF");
        return (path ? path + " / " + name : name) + "	" + reason;
      }).join("\n");
    }
    function copyFailed(btn, failed) {
      const text = failedListText(failed);
      const existing = summaryEl.querySelector(".bbdl-copybox");
      const fallback = function(reason) {
        const box = existing || node("textarea", "bbdl-copybox");
        box.readOnly = true;
        box.value = text;
        box.rows = Math.min(8, failed.length + 1);
        if (!existing) summaryEl.appendChild(box);
        box.focus();
        if (typeof box.select === "function") box.select();
        let copied = false;
        try {
          copied = typeof document.execCommand === "function" && document.execCommand("copy");
        } catch (err) {
          copied = false;
        }
        btn.textContent = copied ? "\u5DF2\u590D\u5236 \u2713" : "\u5DF2\u5168\u9009\uFF0C\u6309 Ctrl+C \u590D\u5236";
        btn.title = reason || "";
        if (copied) resetCopyLabelLater(btn);
      };
      let clipboard;
      try {
        clipboard = typeof navigator !== "undefined" ? navigator.clipboard : null;
      } catch (err) {
        clipboard = null;
      }
      if (clipboard && typeof clipboard.writeText === "function") {
        clipboard.writeText(text).then(
          function() {
            btn.textContent = "\u5DF2\u590D\u5236 \u2713";
            if (existing) existing.remove();
            resetCopyLabelLater(btn);
          },
          function(err) {
            fallback("\u526A\u8D34\u677F\u4E0D\u53EF\u7528\uFF1A" + (err && err.message || String(err)));
          }
        );
        return;
      }
      fallback("\u5F53\u524D\u73AF\u5883\u6CA1\u6709\u526A\u8D34\u677F API");
    }
    function resetCopyLabelLater(btn) {
      const timer = setTimeout(function() {
        if (!destroyed) btn.textContent = "\u590D\u5236\u5931\u8D25\u6E05\u5355";
      }, 1800);
      timers.push(timer);
    }
    function summaryHeadText(staged) {
      const prefix = staged.aborted ? "\u5DF2\u53D6\u6D88\uFF08\u90E8\u5206\u5B8C\u6210\uFF09\uFF1A" : "\u4E0B\u8F7D\u5B8C\u6210\uFF1A";
      if (haltPendingCount <= 0) return prefix + "\u6210\u529F " + staged.ok + " \u4E2A\uFF0C\u5931\u8D25 " + staged.failed.length + " \u4E2A";
      const head2 = (staged.aborted ? "\u5DF2\u53D6\u6D88\uFF08\u90E8\u5206\u5B8C\u6210\uFF09\uFF1A" : "\u5DF2\u6682\u505C\uFF1A") + "\u6210\u529F " + staged.ok + " \u4E2A\uFF0C\u672A\u4E0B\u8F7D " + haltPendingCount + " \u4E2A";
      return staged.failed.length ? head2 + "\uFF0C\u5931\u8D25 " + staged.failed.length + " \u4E2A" : head2;
    }
    function renderSummary() {
      if (destroyed) return;
      summaryEl.textContent = "";
      summaryEl.hidden = false;
      const staged = summaryState;
      summaryEl.appendChild(node("p", "bbdl-summary__head", summaryHeadText(staged)));
      if (!staged.failed.length) return;
      const list = node("ol", "bbdl-failed");
      staged.failed.forEach(function(item) {
        const entry = item && item.entry || {};
        const li = node("li", "bbdl-failed__item");
        const path = entryPath(entry) || "\uFF08\u8BFE\u7A0B\u6839\u76EE\u5F55\uFF09";
        const nameEl = node("span", "bbdl-failed__name", entry.name || "(\u672A\u547D\u540D\u6587\u4EF6)");
        nameEl.title = entry.name || "";
        const pathEl = node("span", "bbdl-failed__path", path);
        pathEl.title = path;
        const reasonEl = node("span", "bbdl-failed__reason", quietReasonText(stripUrlText(item && item.error || "\u672A\u77E5\u9519\u8BEF")));
        reasonEl.title = reasonEl.textContent;
        li.appendChild(nameEl);
        li.appendChild(pathEl);
        li.appendChild(reasonEl);
        const hint = retryHintText(item && item.error);
        if (hint) {
          const hintEl = node("span", "bbdl-failed__hint", hint);
          hintEl.title = hint;
          li.appendChild(hintEl);
        }
        list.appendChild(li);
      });
      summaryEl.appendChild(list);
      const bar = node("div", "bbdl-actions");
      const retryBtn = node("button", "bbdl-btn bbdl-btn--small", "\u53EA\u91CD\u8BD5\u5931\u8D25\u7684\uFF08" + staged.failed.length + "\uFF09");
      retryBtn.type = "button";
      retryBtn.disabled = !onRetryFailed;
      if (!onRetryFailed) retryBtn.title = "\u5F53\u524D\u6CA1\u6709\u53EF\u7528\u7684\u91CD\u8BD5\u5165\u53E3";
      retryBtn.addEventListener("click", function() {
        retryFailed(retryBtn);
      });
      const copyBtn = node("button", "bbdl-btn bbdl-btn--small", "\u590D\u5236\u5931\u8D25\u6E05\u5355");
      copyBtn.type = "button";
      copyBtn.addEventListener("click", function() {
        copyFailed(copyBtn, summaryState.failed);
      });
      bar.appendChild(retryBtn);
      bar.appendChild(copyBtn);
      summaryEl.appendChild(bar);
    }
    function retryFailed(retryBtn) {
      const entries = summaryState.failed.map(function(item) {
        return item && item.entry;
      }).filter(Boolean);
      if (!entries.length) return;
      retryBtn.disabled = true;
      retryBtn.textContent = "\u6B63\u5728\u91CD\u8BD5 " + entries.length + " \u4E2A\u2026";
      let pending;
      try {
        pending = onRetryFailed(entries);
      } catch (err) {
        render("error", { message: err && err.message || String(err) });
        return;
      }
      Promise.resolve(pending).then(
        function(result) {
          if (destroyed) return;
          if (!result) {
            retryBtn.disabled = false;
            retryBtn.textContent = "\u53EA\u91CD\u8BD5\u5931\u8D25\u7684\uFF08" + summaryState.failed.length + "\uFF09";
            return;
          }
          const okList = Array.isArray(result.ok) ? result.ok : [];
          const failed = Array.isArray(result.failed) ? result.failed : [];
          summaryState = { ok: result.batchOkCount ?? summaryState.ok + okList.length, failed, aborted: !!result.aborted };
          renderSummary();
          render(failed.length ? "error" : "done", failed.length ? { message: "\u91CD\u8BD5\u540E\u4ECD\u6709 " + failed.length + " \u4E2A\u6587\u4EF6\u5931\u8D25\u3002" } : {});
        },
        function(err) {
          render("error", { message: err && err.message || String(err) });
        }
      );
    }
    function showSummary(result) {
      if (destroyed) return;
      const ok = result && Array.isArray(result.ok) ? result.ok : [];
      const failed = result && Array.isArray(result.failed) ? result.failed : [];
      const aborted = !!(result && result.aborted);
      summaryState = { ok: ok.length, failed, aborted };
      renderSummary();
      render(aborted ? "error" : "done", aborted ? { message: "\u4E0B\u8F7D\u88AB\u53D6\u6D88\uFF0C\u5DF2\u5B8C\u6210\u7684\u6587\u4EF6\u4FDD\u7559\u5728\u76EE\u6807\u4F4D\u7F6E\u3002" } : {});
    }
    function fail(message) {
      render("error", { message: message == null ? "\u672A\u77E5\u9519\u8BEF" : String(message) });
    }
    function makeFileRow(record) {
      const row = node("div", "bbdl-files__row");
      row.dataset.entryId = safeNameText(record.id);
      const els = {
        row,
        name: node("span", "bbdl-files__name"),
        status: node("span", "bbdl-files__status"),
        bytes: node("span", "bbdl-files__bytes"),
        retry: node("span", "bbdl-files__retry"),
        path: node("span", "bbdl-files__path")
      };
      row.appendChild(els.name);
      row.appendChild(els.status);
      row.appendChild(els.bytes);
      row.appendChild(els.retry);
      row.appendChild(els.path);
      return els;
    }
    function paintFileRow(record) {
      const els = record.els;
      if (!els) return;
      const key = FILE_STATUS_TEXT[record.status] ? record.status : "waiting";
      els.name.textContent = record.name || "(\u672A\u547D\u540D\u6587\u4EF6)";
      els.name.title = record.name || "";
      els.status.textContent = FILE_STATUS_TEXT[key];
      els.status.className = "bbdl-files__status bbdl-files__status--" + key;
      els.bytes.textContent = record.bytes == null ? "\u2014" : formatBytes(record.bytes);
      els.retry.textContent = record.attempt >= 2 ? record.attempt + " \u6B21" : "\u2014";
      els.retry.title = record.attempt >= 2 ? "\u7B2C " + record.attempt + " \u6B21\u5C1D\u8BD5" : "\u672A\u91CD\u8BD5";
      els.path.textContent = record.path || "";
      els.path.title = record.path || "";
      els.path.hidden = !record.path;
      els.row.dataset.status = record.status;
    }
    function renderFiles() {
      if (destroyed) return;
      filesBodyEl.textContent = "";
      const shown = Math.min(fileOrder.length, MAX_FILE_ROWS);
      const frag = document.createDocumentFragment();
      for (let i = 0; i < shown; i += 1) {
        const record = fileMap.get(fileOrder[i]);
        if (!record) continue;
        record.els = makeFileRow(record);
        paintFileRow(record);
        frag.appendChild(record.els.row);
      }
      filesBodyEl.appendChild(frag);
      for (let i = shown; i < fileOrder.length; i += 1) {
        const extra = fileMap.get(fileOrder[i]);
        if (extra) extra.els = null;
      }
      const rest = fileOrder.length - shown;
      filesMoreEl.hidden = rest <= 0;
      filesMoreEl.textContent = rest > 0 ? "\u5176\u4F59 " + rest + " \u4E2A\u6587\u4EF6\u672A\u5C55\u5F00" : "";
      filesEl.hidden = fileOrder.length === 0;
      filesSummaryEl.textContent = "\u6587\u4EF6\u5217\u8868\uFF08" + fileOrder.length + "\uFF09";
    }
    function setFiles(entries) {
      if (destroyed) return;
      haltPendingCount = 0;
      const list = Array.isArray(entries) ? entries : [];
      const nextOrder = [];
      const nextMap = /* @__PURE__ */ new Map();
      for (const entry of list) {
        const id = entryIdOf(entry);
        if (!id || nextMap.has(id)) continue;
        const size = finiteNumber(entry && entry.size);
        nextMap.set(id, {
          id,
          name: safeNameText(entry && entry.name),
          path: entryPathText(entry),
          status: seedFileStatus(entry),
          bytes: size != null && size >= 0 ? size : null,
          attempt: 0,
          els: null
        });
        nextOrder.push(id);
      }
      fileOrder = nextOrder;
      fileMap = nextMap;
      renderFiles();
    }
    function countPendingRows() {
      let pending = 0;
      for (const record of fileMap.values()) {
        if (record.status === "waiting" || record.status === "running") pending += 1;
      }
      return pending;
    }
    function paintHalt() {
      haltEl.textContent = "";
      if (!haltText || recoveringAttempt > 0) {
        haltEl.hidden = true;
        return;
      }
      const textEl = node("span", "bbdl-halt__text", haltText);
      textEl.title = haltText;
      haltEl.appendChild(textEl);
      if (onResumePending) haltEl.appendChild(button("bbdl-btn bbdl-btn--small", "resume-pending", "\u7EE7\u7EED"));
      haltEl.hidden = false;
    }
    function setHalted(info) {
      if (destroyed) return;
      const i = info || {};
      const given = finiteNumber(i.pendingCount);
      const pending = given != null && given >= 0 ? Math.floor(given) : countPendingRows();
      haltPendingCount = pending;
      haltText = "\u5DF2\u6682\u505C\uFF08" + pending + " \u4E2A\u672A\u4E0B\u8F7D\uFF09\u3002";
      paintHalt();
      refreshFabStatus();
    }
    function clearHalted() {
      if (destroyed) return;
      haltPendingCount = 0;
      haltText = "";
      haltEl.textContent = "";
      haltEl.hidden = true;
      refreshFabStatus();
    }
    function setRecovering(info) {
      if (destroyed) return;
      const i = info || {};
      const given = finiteNumber(i.attempt);
      recoveringAttempt = given != null && given >= 1 ? Math.floor(given) : 1;
      paintHalt();
      render(current, context);
    }
    function clearRecovering() {
      if (destroyed) return;
      recoveringAttempt = 0;
      paintHalt();
      render(current, context);
    }
    function applyFileEvent(event) {
      if (destroyed) return;
      const e = event || {};
      const type = typeof e.type === "string" ? e.type : "";
      if (type === "halt") {
        for (const record2 of fileMap.values()) {
          if (record2.status === "running") {
            record2.status = "waiting";
            paintFileRow(record2);
          }
        }
        setHalted({ reason: e.reason, pendingCount: e.pending });
        return;
      }
      if (type !== "start" && type !== "retry" && type !== "done" && type !== "failed") return;
      const record = fileMap.get(e.entryId == null ? "" : String(e.entryId));
      if (!record) return;
      const attempt = finiteNumber(e.attempt);
      if (type === "retry") {
        record.status = "running";
        record.attempt = attempt != null && attempt >= 1 ? Math.floor(attempt) : record.attempt + 1;
      } else if (type === "start") {
        record.status = "running";
        if (attempt === 1) record.attempt = 1;
        else if (attempt != null && attempt > 1) record.attempt = Math.floor(attempt);
      } else if (type === "done") {
        record.status = "done";
        const bytes = finiteNumber(e.bytes);
        if (bytes != null && bytes >= 0) record.bytes = bytes;
        adoptResolvedName(record, e);
      } else {
        record.status = "failed";
        adoptResolvedName(record, e);
      }
      paintFileRow(record);
    }
    function rebind(next) {
      const o = next || {};
      if (o.settings) {
        settings = o.settings;
        probeInput.checked = settings.probeSizes !== false;
        concInput.value = String(settings.downloadConcurrency || 4);
        expandInput.checked = settings.panelCollapsed === false;
        autoReloadInput.checked = settings.autoReload !== false;
      }
      if (typeof o.onScan === "function") onScan = o.onScan;
      if (typeof o.onDownload === "function") onDownload = o.onDownload;
      if (typeof o.onCancel === "function") onCancel = o.onCancel;
      if (typeof o.onSettingsChange === "function") onSettingsChange = o.onSettingsChange;
      if (typeof o.onRetryFailed === "function") onRetryFailed = o.onRetryFailed;
      if (typeof o.onResume === "function") onResume = o.onResume;
      if (typeof o.onResumePending === "function") onResumePending = o.onResumePending;
      if (typeof o.onExportManifest === "function") onExportManifest = o.onExportManifest;
      if (typeof o.onImportManifest === "function") onImportManifest = o.onImportManifest;
      exportRow.hidden = !onExportManifest;
      importRow.hidden = !onImportManifest;
      if (haltText) paintHalt();
      if (!summaryEl.hidden) renderSummary();
    }
    function destroy() {
      destroyed = true;
      clearWatchdog();
      for (const timer of timers) clearTimeout(timer);
      timers.length = 0;
      if (root.__bbdlApi === api) root.__bbdlApi = null;
      if (root.parentNode) root.parentNode.removeChild(root);
    }
    const api = {
      setState,
      setCount,
      setScanProgress,
      setDownloadProgress,
      setMode,
      setNotice,
      setResume,
      setFiles,
      applyFileEvent,
      setHalted,
      clearHalted,
      setRecovering,
      clearRecovering,
      showSummary,
      setCourse,
      setHistory,
      rebind,
      fail,
      destroy
    };
    root.__bbdlApi = api;
    render("idle", {});
    return api;
  }

  // src/ui/select.js
  var SELECTION_KEY_PREFIX = "bbdl:sel:";
  function selectionStorageKey(courseId, pageId) {
    const course = courseId == null ? "" : String(courseId).trim();
    const page = pageId == null ? "" : String(pageId).trim();
    if (!course || !page) return "";
    return SELECTION_KEY_PREFIX + course + ":" + page;
  }
  function selectionStore() {
    try {
      const store = typeof globalThis !== "undefined" ? globalThis.sessionStorage : null;
      return store && typeof store.getItem === "function" && typeof store.setItem === "function" ? store : null;
    } catch (err) {
      return null;
    }
  }
  function readSelection(key) {
    if (!key) return null;
    const store = selectionStore();
    if (!store) return null;
    let raw = null;
    try {
      raw = store.getItem(key);
    } catch (err) {
      return null;
    }
    if (typeof raw !== "string" || !raw) return null;
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return null;
    }
    if (!Array.isArray(parsed)) return null;
    const ids = [];
    for (const item of parsed) {
      const id = typeof item === "string" ? item : typeof item === "number" ? String(item) : "";
      if (id) ids.push(id);
    }
    return ids;
  }
  function writeSelection(key, ids) {
    if (!key) return;
    const store = selectionStore();
    if (!store) return;
    try {
      store.setItem(key, JSON.stringify(ids));
    } catch (err) {
    }
  }
  var TYPE_GROUPS = [
    { id: "pdf", label: "pdf", exts: ["pdf"] },
    { id: "ppt", label: "ppt", exts: ["ppt", "pptx", "pps", "ppsx", "pot", "potx"] },
    { id: "doc", label: "doc", exts: ["doc", "docx", "rtf", "txt", "odt"] },
    { id: "zip", label: "zip", exts: ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2"] },
    { id: "image", label: "\u56FE\u7247", exts: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "tif", "tiff"] },
    { id: "other", label: "\u5176\u4ED6", exts: [] }
  ];
  function typeOf(entry) {
    const match = /\.([a-z0-9]+)$/i.exec(String(entry && entry.name || "").trim());
    const ext = match ? match[1].toLowerCase() : "";
    for (const group of TYPE_GROUPS) {
      if (group.exts.indexOf(ext) >= 0) return group.id;
    }
    return "other";
  }
  var activeInstance = null;
  function formatBytes2(n) {
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "\u2014";
    if (n < 1024) return n + " B";
    const units = ["KB", "MB", "GB", "TB"];
    let value = n / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i += 1;
    }
    return (value >= 100 ? Math.round(value) : value.toFixed(1)) + " " + units[i];
  }
  function node2(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }
  function directoryPickerAvailable() {
    try {
      return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
    } catch (err) {
      return false;
    }
  }
  function button2(act, text, className) {
    const el = node2("button", className || "bbdl-btn", text);
    el.type = "button";
    el.dataset.act = act;
    return el;
  }
  var SKIP_REASONS = ["disk", "disk-unverified", "manifest", "manifest-unchanged", "manifest-unknown"];
  function nonNegCount(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  function stalePathText(value) {
    let text = value == null ? "" : String(value).trim();
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
      try {
        text = new URL(text, "http://localhost/").pathname;
      } catch (err) {
        text = "";
      }
    }
    text = redactUrlText(text);
    const cut = text.search(/[?#]/);
    if (cut >= 0) text = text.slice(0, cut);
    text = text.replace(/^\/+/, "").trim();
    return text || "\uFF08\u8DEF\u5F84\u672A\u8BB0\u5F55\uFF09";
  }
  function normalizeStaleList(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const out = [];
    for (const item of list) {
      const path = item && typeof item === "object" ? item.path : item;
      out.push(stalePathText(path));
    }
    return out;
  }
  function normalizeSkipInfo(raw) {
    const info = raw || {};
    const byId = /* @__PURE__ */ new Map();
    const source = info.byId instanceof Map ? Array.from(info.byId.entries()) : info.byId && typeof info.byId === "object" ? Object.entries(info.byId) : [];
    for (const pair of source) {
      const id = pair[0];
      const hit = pair[1];
      if (!id || !hit) continue;
      const reason = SKIP_REASONS.indexOf(hit.reason) >= 0 ? hit.reason : "manifest";
      const size = typeof hit.size === "number" && Number.isFinite(hit.size) && hit.size >= 0 ? hit.size : null;
      byId.set(String(id), { reason, size });
    }
    let disk = 0;
    let manifest = 0;
    let unverified = 0;
    let manifestUnchanged = 0;
    byId.forEach(function(hit) {
      if (hit.reason === "disk" || hit.reason === "disk-unverified") {
        disk += 1;
        if (hit.reason === "disk-unverified") unverified += 1;
        return;
      }
      manifest += 1;
      if (hit.reason === "manifest-unchanged") manifestUnchanged += 1;
    });
    return {
      byId,
      disk,
      manifest,
      unverified,
      manifestUnchanged,
      total: byId.size,
      truncated: !!info.truncated,
      diskChecked: !!info.diskChecked,
      // diff 六桶：只读过就给 0，UI 不按「新老摘要」分两套渲染。
      added: nonNegCount(info.added),
      changed: nonNegCount(info.changed),
      moved: nonNegCount(info.moved),
      unchanged: nonNegCount(info.unchanged),
      unknown: nonNegCount(info.unknown),
      stale: nonNegCount(info.stale),
      scanFailures: nonNegCount(info.scanFailures),
      staleList: normalizeStaleList(info.staleList)
    };
  }
  function noVersionKnowledge(data) {
    return data.changed === 0 && data.moved === 0 && data.unchanged === 0 && data.unknown === 0 && data.stale === 0;
  }
  function syncPreviewText(info) {
    const data = normalizeSkipInfo(info);
    if (noVersionKnowledge(data)) return "";
    const text = "\u672C\u6B21\u626B\u63CF\uFF1A\u65B0\u589E " + data.added + " \xB7 \u53D8\u66F4 " + data.changed + " \xB7 \u6539\u540D " + data.moved + " \xB7 \u672A\u53D8 " + data.unchanged + " \xB7 \u672A\u77E5 " + data.unknown;
    return data.stale > 0 ? text + " \xB7 \u7591\u4F3C\u5220\u9664 " + data.stale : text;
  }
  function skipLabelText(info) {
    const data = normalizeSkipInfo(info);
    if (data.unchanged > 0 || data.unknown > 0 || data.stale > 0) {
      return "\u53EA\u4E0B\u8F7D\u65B0\u589E\u4E0E\u53D8\u66F4\uFF08\u8DF3\u8FC7\u672A\u53D8 " + data.unchanged + " \u4E2A\uFF09";
    }
    const parts = [];
    if (data.disk) parts.push("\u78C1\u76D8 " + data.disk);
    if (data.manifest) parts.push("\u6E05\u5355 " + data.manifest);
    return "\u8DF3\u8FC7\u5DF2\u5B58\u5728\u7684\u6587\u4EF6\uFF08" + data.total + " \u4E2A" + (parts.length ? "\uFF0C" + parts.join(" / ") : "") + "\uFF09";
  }
  function skipReasonText(hit) {
    const reason = hit && hit.reason;
    if (reason === "disk") return "\u78C1\u76D8\u4E0A\u5DF2\u6709\u540C\u540D\u540C\u4F53\u79EF\u7684\u6587\u4EF6\uFF0C\u52FE\u9009\u300C\u8DF3\u8FC7\u5DF2\u5B58\u5728\u7684\u6587\u4EF6\u300D\u65F6\u4E0D\u4E0B\u8FD9\u4E2A\u3002";
    if (reason === "disk-unverified") return "\u78C1\u76D8\u4E0A\u5DF2\u6709\u540C\u540D\u6587\u4EF6\uFF0C\u4F46\u4F53\u79EF\u65E0\u6CD5\u6838\u5B9E\uFF0C\u6309\u5DF2\u5B58\u5728\u5904\u7406\u3002";
    if (reason === "manifest-unchanged") return "\u4E0B\u8F7D\u6E05\u5355\u91CC\u8FD9\u6761\u662F done\uFF0C\u4E14\u4E0A\u6E38\u7684\u7248\u672C\u6307\u7EB9\u6CA1\u53D8\uFF0C\u52FE\u9009\u300C\u53EA\u4E0B\u8F7D\u65B0\u589E\u4E0E\u53D8\u66F4\u300D\u65F6\u4E0D\u4E0B\u8FD9\u4E2A\u3002";
    if (reason === "manifest-unknown") return "\u4E0B\u8F7D\u6E05\u5355\u91CC\u8FD9\u6761\u662F done\uFF0C\u4F46\u7F3A\u5C11\u53EF\u6BD4\u7684\u7248\u672C\u6307\u7EB9\uFF0C\u6309\u672A\u77E5\u5904\u7406\uFF1A\u672C\u8F6E\u4F1A\u91CD\u4E0B\uFF0C\u4E0B\u4E00\u8F6E\u624D\u80FD\u786E\u8BA4\u672A\u53D8\u3002";
    return "\u4E0B\u8F7D\u6E05\u5355\u91CC\u8FD9\u6761\u5DF2\u7ECF\u662F done\uFF0C\u52FE\u9009\u300C\u8DF3\u8FC7\u5DF2\u5B58\u5728\u7684\u6587\u4EF6\u300D\u65F6\u4E0D\u4E0B\u8FD9\u4E2A\u3002";
  }
  function skipNoteText(info) {
    const data = normalizeSkipInfo(info);
    if (!data.total && !data.scanFailures) return "";
    const bits = [];
    if (data.scanFailures > 0) {
      bits.push("\u672C\u6B21\u626B\u63CF\u6709 " + data.scanFailures + " \u4E2A\u6587\u4EF6\u5939\u5931\u8D25\uFF0C\u5176\u4E2D\u7684\u6587\u4EF6\u4E00\u5F8B\u6309\u672A\u77E5\u5904\u7406\uFF08\u4F1A\u91CD\u4E0B\uFF09\u3002");
    }
    if (data.truncated) bits.push("\u76EE\u5F55\u91CC\u6587\u4EF6\u592A\u591A\uFF0C\u672C\u6B21\u53EA\u6BD4\u5BF9\u4E86\u524D\u9762\u4E00\u90E8\u5206\uFF0C\u53EF\u80FD\u6F0F\u5224\u5DF2\u5B58\u5728\u7684\u6587\u4EF6\u3002");
    if (!data.diskChecked) bits.push("\u8FD8\u6CA1\u6709\u53EF\u6838\u5B9E\u7684\u76EE\u5F55\uFF08\u6216\u5F53\u524D\u6D4F\u89C8\u5668\u65E0\u6CD5\u6838\u5B9E\u78C1\u76D8\u6587\u4EF6\uFF09\uFF0C\u53EA\u80FD\u6309\u4E0B\u8F7D\u6E05\u5355\u5224\u65AD\uFF1A\u6E05\u5355\u91CC\u6807\u7740\u5B8C\u6210\u7684\u624D\u8DF3\u8FC7\u3002");
    else if (data.unverified) bits.push("\u5176\u4E2D " + data.unverified + " \u4E2A\u6587\u4EF6\u5728\u78C1\u76D8\u4E0A\u7684\u4F53\u79EF\u65E0\u6CD5\u6838\u5B9E\uFF0C\u53EA\u80FD\u6309\u6587\u4EF6\u540D\u5224\u65AD\u3002");
    if (data.unchanged > 0) bits.push("\u6E05\u5355\u91CC\u5DF2\u5B8C\u6210\u3001\u4E0A\u6E38\u672A\u53D8\u7684\u6587\u4EF6\u672C\u8F6E\u4E0D\u518D\u4E0B\u8F7D\u3002");
    return bits.join(" ");
  }
  function openSelectDialog(entries, options) {
    const opts = options || {};
    const settings = opts.settings || {};
    const onSettingsChange = typeof opts.onSettingsChange === "function" ? opts.onSettingsChange : null;
    const onProbeSizes = typeof opts.onProbeSizes === "function" ? opts.onProbeSizes : null;
    const onPickDirectory = typeof opts.onPickDirectory === "function" ? opts.onPickDirectory : null;
    const onRefreshSkips = typeof opts.onRefreshSkips === "function" ? opts.onRefreshSkips : null;
    const onDialogClose = typeof opts.onClose === "function" ? opts.onClose : null;
    const pickDirectory2 = typeof opts.pickDirectory === "function" ? opts.pickDirectory : function() {
      return null;
    };
    const selectionKey = selectionStorageKey(opts.courseId, opts.pageId);
    let skipInfo = normalizeSkipInfo(opts.skipInfo);
    let skipExisting = skipInfo.total > 0;
    let skipTouched = false;
    let pickedHandle = null;
    let pickedName = "";
    let pickBusy = false;
    let pickGeneration = 0;
    if (activeInstance) activeInstance.close(null);
    injectStyles();
    return new Promise(function(resolve) {
      const list = Array.isArray(entries) ? entries.slice() : [];
      const sizes = /* @__PURE__ */ new Map();
      const selected = /* @__PURE__ */ new Set();
      const remembered = readSelection(selectionKey);
      let restored = null;
      if (remembered && remembered.length) {
        const alive = /* @__PURE__ */ new Set();
        for (const entry of list) {
          if (entry && remembered.indexOf(entry.id) >= 0) alive.add(entry.id);
        }
        if (alive.size) restored = alive;
      }
      for (const entry of list) {
        if (!entry) continue;
        if (!restored || restored.has(entry.id)) selected.add(entry.id);
        if (typeof entry.size === "number" && Number.isFinite(entry.size)) sizes.set(entry.id, entry.size);
      }
      let preserveTree = settings.preserveTree !== false;
      let closed = false;
      let query = "";
      let sortMode = "none";
      const activeTypes = new Set(
        TYPE_GROUPS.map(function(group) {
          return group.id;
        })
      );
      const fsaAvailable = directoryPickerAvailable();
      const rows = /* @__PURE__ */ new Map();
      const folders = /* @__PURE__ */ new Map();
      const groups = /* @__PURE__ */ new Map();
      for (const entry of list) {
        if (!entry) continue;
        const path = Array.isArray(entry.folderPath) ? entry.folderPath : [];
        const key = path.join("/");
        if (!groups.has(key)) groups.set(key, { path, items: [] });
        groups.get(key).items.push(entry);
      }
      const overlay = node2("div", "bbdl-overlay");
      const dialog = node2("div", "bbdl-dialog");
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-label", "\u9009\u62E9\u8981\u4E0B\u8F7D\u7684\u6587\u4EF6");
      const head = node2("div", "bbdl-dialog__head");
      head.appendChild(node2("h2", "bbdl-dialog__title", "\u9009\u62E9\u8981\u4E0B\u8F7D\u7684\u6587\u4EF6"));
      const closeBtn = button2("close", "\u5173\u95ED", "bbdl-btn bbdl-btn--small");
      head.appendChild(closeBtn);
      const toolbar = node2("div", "bbdl-dialog__toolbar");
      const toolRow = node2("div", "bbdl-toolbar__row");
      const filterRow = node2("div", "bbdl-toolbar__row");
      const allBtn = button2("all", "\u5168\u9009", "bbdl-btn bbdl-btn--small");
      const noneBtn = button2("none", "\u5168\u4E0D\u9009", "bbdl-btn bbdl-btn--small");
      const probeBtn = button2("probe", "\u83B7\u53D6\u4F53\u79EF", "bbdl-btn bbdl-btn--small");
      probeBtn.hidden = !(onProbeSizes && settings.probeSizes !== false);
      const treeSwitch = node2("label", "bbdl-switch");
      const treeInput = node2("input");
      treeInput.type = "checkbox";
      treeInput.className = "bbdl-check";
      treeInput.checked = preserveTree;
      treeSwitch.appendChild(treeInput);
      treeSwitch.appendChild(node2("span", null, "\u4FDD\u7559\u539F\u59CB\u76EE\u5F55\u7ED3\u6784"));
      const skipSwitch = node2("label", "bbdl-switch bbdl-switch--skip");
      const skipInput = node2("input");
      skipInput.type = "checkbox";
      skipInput.className = "bbdl-check";
      skipInput.checked = skipExisting;
      const skipLabelEl = node2("span", null, skipLabelText(skipInfo));
      skipSwitch.appendChild(skipInput);
      skipSwitch.appendChild(skipLabelEl);
      skipSwitch.title = skipNoteText(skipInfo) || "\u5DF2\u5B58\u5728\uFF08\u78C1\u76D8\u6216\u6E05\u5355\u91CC\u6709\u8BB0\u5F55\uFF09\u7684\u6587\u4EF6\u4E0D\u518D\u91CD\u65B0\u4E0B\u8F7D";
      const sortSelect = node2("select", "bbdl-sort");
      sortSelect.setAttribute("aria-label", "\u6392\u5E8F\u65B9\u5F0F");
      [
        ["none", "\u76EE\u5F55\u987A\u5E8F"],
        ["name", "\u6309\u540D\u79F0"],
        ["size", "\u6309\u4F53\u79EF"]
      ].forEach(function(pair) {
        const opt = node2("option", null, pair[1]);
        opt.value = pair[0];
        sortSelect.appendChild(opt);
      });
      sortSelect.value = sortMode;
      const hintEl = node2("span", "bbdl-hint");
      const dirRow = node2("div", "bbdl-toolbar__row bbdl-toolbar__row--dir");
      const dirBtn = button2("pick-dir", "\u9009\u62E9\u4FDD\u5B58\u4F4D\u7F6E\u2026", "bbdl-btn bbdl-btn--small");
      dirBtn.hidden = !onPickDirectory;
      const dirStatusEl = node2("span", "bbdl-dir__status");
      dirRow.appendChild(dirBtn);
      dirRow.appendChild(dirStatusEl);
      toolRow.appendChild(allBtn);
      toolRow.appendChild(noneBtn);
      toolRow.appendChild(probeBtn);
      toolRow.appendChild(sortSelect);
      toolRow.appendChild(treeSwitch);
      toolRow.appendChild(hintEl);
      const searchInput = node2("input", "bbdl-search");
      searchInput.type = "search";
      searchInput.placeholder = "\u641C\u7D22\u6587\u4EF6\u540D\u2026";
      searchInput.setAttribute("aria-label", "\u641C\u7D22\u6587\u4EF6\u540D");
      const typesEl = node2("div", "bbdl-types");
      TYPE_GROUPS.forEach(function(group) {
        const item = node2("label", "bbdl-types__item");
        const box = node2("input");
        box.type = "checkbox";
        box.className = "bbdl-check";
        box.checked = activeTypes.has(group.id);
        box.setAttribute("data-type", group.id);
        box.addEventListener("change", function() {
          if (box.checked) activeTypes.add(group.id);
          else activeTypes.delete(group.id);
          applyView();
        });
        item.appendChild(box);
        item.appendChild(node2("span", null, group.label));
        typesEl.appendChild(item);
      });
      filterRow.appendChild(searchInput);
      filterRow.appendChild(typesEl);
      const skipNoteEl = node2("p", "bbdl-note bbdl-note--skip", skipNoteText(skipInfo));
      skipNoteEl.hidden = true;
      const syncRow = node2("div", "bbdl-toolbar__row bbdl-toolbar__row--sync");
      const syncEl = node2("span", "bbdl-sync");
      syncRow.appendChild(syncEl);
      const staleBox = node2("details", "bbdl-stale");
      const staleHead = node2("summary", "bbdl-stale__head");
      const staleListEl = node2("ul", "bbdl-stale__list");
      staleBox.appendChild(staleHead);
      staleBox.appendChild(staleListEl);
      toolbar.appendChild(dirRow);
      toolbar.appendChild(toolRow);
      toolbar.appendChild(filterRow);
      const treeEl = node2("div", "bbdl-tree");
      const modeEl = node2("p", "bbdl-mode");
      const foot = node2("div", "bbdl-dialog__foot");
      const totalsEl = node2("span", "bbdl-dialog__totals");
      const footActions = node2("div", "bbdl-dialog__actions");
      const cancelBtn = button2("cancel", "\u53D6\u6D88", "bbdl-btn");
      const confirmBtn = button2("confirm", "\u5F00\u59CB\u4E0B\u8F7D", "bbdl-btn bbdl-btn--primary");
      footActions.appendChild(cancelBtn);
      footActions.appendChild(confirmBtn);
      foot.appendChild(totalsEl);
      foot.appendChild(footActions);
      const errorEl = node2("div", "bbdl-dialog__error");
      const errorText = node2("span", null, "");
      const fallbackBtn = button2("fallback", "\u6539\u7528\u9ED8\u8BA4\u4E0B\u8F7D\uFF08\u4E0D\u9009\u6587\u4EF6\u5939\uFF09", "bbdl-btn bbdl-btn--small");
      fallbackBtn.hidden = true;
      errorEl.appendChild(errorText);
      errorEl.appendChild(fallbackBtn);
      errorEl.hidden = true;
      dialog.appendChild(head);
      dialog.appendChild(toolbar);
      dialog.appendChild(treeEl);
      dialog.appendChild(modeEl);
      dialog.appendChild(errorEl);
      dialog.appendChild(foot);
      overlay.appendChild(dialog);
      const inst = {
        setRowSize: setRowSizeInternal,
        close
      };
      function showError(text, offerFallback) {
        errorText.textContent = redactUrlText(String(text));
        errorEl.hidden = false;
        fallbackBtn.hidden = !offerFallback;
      }
      function clearError() {
        errorEl.hidden = true;
        errorText.textContent = "";
        fallbackBtn.hidden = true;
      }
      function setHint(text) {
        hintEl.textContent = text || "";
      }
      function renderSkip() {
        skipInput.checked = skipExisting;
        skipLabelEl.textContent = skipLabelText(skipInfo);
        skipSwitch.title = skipNoteText(skipInfo) || "\u5DF2\u5B58\u5728\uFF08\u78C1\u76D8\u6216\u6E05\u5355\u91CC\u6709\u8BB0\u5F55\uFF09\u7684\u6587\u4EF6\u4E0D\u518D\u91CD\u65B0\u4E0B\u8F7D";
        if (skipInfo.total) {
          if (skipSwitch.parentNode !== toolRow) toolRow.insertBefore(skipSwitch, hintEl);
        } else if (skipSwitch.parentNode) {
          skipSwitch.parentNode.removeChild(skipSwitch);
        }
        skipNoteEl.textContent = skipNoteText(skipInfo);
        skipNoteEl.hidden = !skipNoteEl.textContent;
        if (skipNoteEl.hidden) {
          if (skipNoteEl.parentNode) skipNoteEl.parentNode.removeChild(skipNoteEl);
        } else if (skipNoteEl.parentNode !== toolbar) {
          toolbar.insertBefore(skipNoteEl, filterRow);
        }
        renderSyncPreview();
      }
      function renderSyncPreview() {
        const text = syncPreviewText(skipInfo);
        syncEl.textContent = text;
        if (text) toolbar.appendChild(syncRow);
        else if (syncRow.parentNode) syncRow.parentNode.removeChild(syncRow);
        renderStaleList(Boolean(text) && skipInfo.stale > 0);
      }
      function renderStaleList(show) {
        if (!show) {
          if (staleBox.parentNode) staleBox.parentNode.removeChild(staleBox);
          return;
        }
        staleHead.textContent = "\u7591\u4F3C\u5220\u9664 " + skipInfo.stale + " \u4E2A\uFF08\u53EA\u63D0\u793A\uFF0C\u4E0D\u4F1A\u5220\u9664\u672C\u5730\u6587\u4EF6\uFF09";
        staleListEl.textContent = "";
        const paths = skipInfo.staleList.length ? skipInfo.staleList : ["\uFF08\u8DEF\u5F84\u672A\u8BB0\u5F55\uFF09"];
        for (const path of paths) staleListEl.appendChild(node2("li", "bbdl-stale__item", path));
        toolbar.appendChild(staleBox);
      }
      function renderDirRow() {
        dirBtn.disabled = pickBusy;
        let text;
        if (pickedHandle) {
          const parts = [];
          if (skipInfo.diskChecked) parts.push("\u78C1\u76D8\u4E0A\u5DF2\u6709 " + skipInfo.disk + " \u4E2A");
          if (skipInfo.manifest) parts.push("\u6E05\u5355\u5DF2\u5B8C\u6210 " + skipInfo.manifest + " \u4E2A");
          text = "\u4FDD\u5B58\u4F4D\u7F6E\uFF1A" + pickedName + "\uFF08\u5199\u5165\u6587\u4EF6\u5939\uFF09" + (parts.length ? "\uFF0C" + parts.join("\uFF0C") : "\uFF0C\u6CA1\u6709\u540C\u540D\u6587\u4EF6");
        } else if (!fsaAvailable) {
          text = "\u5F53\u524D\u6D4F\u89C8\u5668\u4E0D\u80FD\u9009\u6587\u4EF6\u5939\uFF1A\u6587\u4EF6\u4F1A\u9010\u4E2A\u4E0B\u8F7D\u5230\u9ED8\u8BA4\u4E0B\u8F7D\u76EE\u5F55\u3002";
        } else if (onPickDirectory) {
          text = "\u672A\u9009\u62E9\u4FDD\u5B58\u4F4D\u7F6E\uFF1A\u5148\u9009\u4E00\u4E2A\u76EE\u5F55\uFF0C\u300C\u8DF3\u8FC7\u5DF2\u5B58\u5728\u300D\u624D\u7B97\u5F97\u51C6\u3002";
        } else {
          text = "\u672A\u9009\u62E9\u4FDD\u5B58\u4F4D\u7F6E\uFF1A\u70B9\u300C\u5F00\u59CB\u4E0B\u8F7D\u300D\u65F6\u4F1A\u518D\u95EE\u4F60\u4E00\u6B21\u3002";
        }
        dirStatusEl.textContent = text;
        dirStatusEl.title = text;
      }
      function applySkipInfo(next) {
        skipInfo = normalizeSkipInfo(next);
        if (!skipTouched) skipExisting = skipInfo.total > 0;
        renderSkip();
        buildTree();
        renderPaths();
        applyView();
        syncFolders();
        renderTotals();
        renderDirRow();
        renderMode();
      }
      function setPickBusy(busy) {
        pickBusy = busy;
        renderDirRow();
      }
      function handlePickDirectory() {
        if (!onPickDirectory || closed || pickBusy) return;
        const generation = ++pickGeneration;
        setPickBusy(true);
        setHint("\u6B63\u5728\u6BD4\u5BF9\u78C1\u76D8\u2026");
        let pending;
        try {
          pending = onPickDirectory({
            setHint: function(text) {
              if (closed || generation !== pickGeneration) return;
              setHint(text);
            }
          });
        } catch (err) {
          onPickSettled(generation, { failed: String(err && err.message || err) });
          return;
        }
        Promise.resolve(pending).then(
          function(result) {
            onPickSettled(generation, result);
          },
          function(err) {
            onPickSettled(generation, { failed: String(err && err.message || err) });
          }
        );
      }
      function onPickSettled(generation, result) {
        if (closed || generation !== pickGeneration) return;
        setPickBusy(false);
        const res = result || {};
        if (res.cancelled) {
          setHint("\u6CA1\u6709\u9009\u4FDD\u5B58\u4F4D\u7F6E\uFF0C\u4ECD\u53EF\u4EE5\u6309\u4E0B\u8F7D\u6E05\u5355\u8DF3\u8FC7\u5DF2\u5B8C\u6210\u7684\u6587\u4EF6\u3002");
          return;
        }
        if (res.failed) {
          showError("\u65E0\u6CD5\u9009\u62E9\u4FDD\u5B58\u4F4D\u7F6E\uFF1A" + redactUrlText(String(res.failed)) + "\u3002\u53EF\u91CD\u8BD5\u3002", false);
          return;
        }
        if (res.status === "denied" || !res.dirHandle) {
          pickedHandle = null;
          pickedName = "";
          applySkipInfo(res.skipInfo);
          showError(
            "\u6CA1\u6709\u62FF\u5230\u300C" + (res.name || "\u6240\u9009\u76EE\u5F55") + "\u300D\u7684\u5199\u5165\u6743\u9650\uFF08\u6D4F\u89C8\u5668\u62D2\u7EDD\u6216\u6388\u6743\u5DF2\u8FC7\u671F\uFF09\uFF0C\u672C\u6B21\u4F1A\u9010\u4E2A\u4E0B\u8F7D\u5230\u9ED8\u8BA4\u4E0B\u8F7D\u76EE\u5F55\uFF0C\u8DF3\u8FC7\u5224\u65AD\u53EA\u80FD\u6309\u4E0B\u8F7D\u6E05\u5355\u3002",
            true
          );
          return;
        }
        pickedHandle = res.dirHandle;
        pickedName = res.name || "\u672A\u547D\u540D\u76EE\u5F55";
        clearError();
        applySkipInfo(res.skipInfo);
        setHint(
          skipInfo.total ? "\u5DF2\u9009\u4FDD\u5B58\u4F4D\u7F6E\uFF0C\u5176\u4E2D " + skipInfo.total + " \u4E2A\u6587\u4EF6\u5DF2\u5B58\u5728\uFF08\u52FE\u9009\u300C\u8DF3\u8FC7\u5DF2\u5B58\u5728\u7684\u6587\u4EF6\u300D\u65F6\u4E0D\u4E0B\uFF09\u3002" : "\u5DF2\u9009\u4FDD\u5B58\u4F4D\u7F6E\uFF1A\u8FD9\u4E2A\u76EE\u5F55\u548C\u6E05\u5355\u91CC\u90FD\u6CA1\u6709\u5DF2\u5B58\u5728\u7684\u6587\u4EF6\u3002"
        );
      }
      function refreshSkipsAfterTreeChange() {
        if (!pickedHandle || !onRefreshSkips) return;
        const generation = pickGeneration;
        let pending;
        try {
          pending = onRefreshSkips();
        } catch (err) {
          return;
        }
        Promise.resolve(pending).then(
          function(next) {
            if (closed || generation !== pickGeneration || !next) return;
            applySkipInfo(next);
          },
          function() {
          }
        );
      }
      function buildTree() {
        treeEl.textContent = "";
        rows.clear();
        folders.clear();
        const keys = Array.from(groups.keys()).sort(function(a, b) {
          if (a === b) return 0;
          if (a === "") return -1;
          if (b === "") return 1;
          return a.localeCompare(b, "zh-Hans-CN");
        });
        const frag = document.createDocumentFragment();
        keys.forEach(function(key) {
          const group = groups.get(key);
          const groupEl = node2("div", "bbdl-group");
          const folderRow = node2("label", "bbdl-row bbdl-row--folder");
          const folderBox = node2("input");
          folderBox.type = "checkbox";
          folderBox.className = "bbdl-check";
          folderBox.checked = true;
          folderRow.style.paddingLeft = 10 + Math.max(0, group.path.length - 1) * 12 + "px";
          const leaf = group.path.length ? group.path[group.path.length - 1] : "\u8BFE\u7A0B\u6839\u76EE\u5F55";
          const folderLabel = (group.path.length ? group.path.join(" / ") : "\u8BFE\u7A0B\u6839\u76EE\u5F55") + "\uFF08" + group.items.length + " \u4E2A\u6587\u4EF6\uFF09";
          const folderName = node2("span", "bbdl-row__name", leaf + "\uFF08" + group.items.length + " \u4E2A\u6587\u4EF6\uFF09");
          folderName.title = folderLabel;
          const folderSize = node2("span", "bbdl-row__size", "");
          folderRow.appendChild(folderBox);
          folderRow.appendChild(folderName);
          folderRow.appendChild(folderSize);
          groupEl.appendChild(folderRow);
          folderBox.addEventListener("change", function() {
            for (const entry of group.items) {
              if (folderBox.checked) selected.add(entry.id);
              else selected.delete(entry.id);
              const row = rows.get(entry.id);
              if (row) row.input.checked = folderBox.checked;
            }
            syncFolders();
            renderTotals();
          });
          folders.set(key, { input: folderBox, sizeEl: folderSize, items: group.items, el: groupEl });
          for (const entry of group.items) {
            const rowEl = node2("label", "bbdl-row bbdl-row--file");
            const skipHit = skipInfo.byId.get(entry.id);
            if (skipHit) {
              rowEl.classList.add("bbdl-row--skipped");
              rowEl.dataset.skip = skipHit.reason;
              rowEl.title = skipReasonText(skipHit);
            }
            const input = node2("input");
            input.type = "checkbox";
            input.className = "bbdl-check";
            input.checked = selected.has(entry.id);
            input.addEventListener("change", function() {
              if (input.checked) selected.add(entry.id);
              else selected.delete(entry.id);
              syncFolders();
              renderTotals();
            });
            const nameEl = node2("span", "bbdl-row__name", entry.name || "(\u672A\u547D\u540D\u6587\u4EF6)");
            nameEl.title = entry.name || "";
            const sizeEl = node2("span", "bbdl-row__size", sizes.has(entry.id) ? formatBytes2(sizes.get(entry.id)) : "\u2014");
            const pathEl = node2("span", "bbdl-row__path");
            rowEl.appendChild(input);
            rowEl.appendChild(nameEl);
            rowEl.appendChild(sizeEl);
            rowEl.appendChild(pathEl);
            groupEl.appendChild(rowEl);
            rows.set(entry.id, { input, sizeEl, pathEl, entry, el: rowEl });
          }
          frag.appendChild(groupEl);
        });
        treeEl.appendChild(frag);
      }
      function previewPath(entry) {
        const path = Array.isArray(entry.folderPath) ? entry.folderPath : [];
        const name = entry.name || "(\u672A\u547D\u540D\u6587\u4EF6)";
        if (preserveTree) return path.length ? path.join(" / ") + " / " + name : name;
        return "\uFF08\u5E73\u94FA\uFF09" + (path.length ? path.join("__") + "__" : "") + name;
      }
      function renderPaths() {
        rows.forEach(function(row) {
          const text = previewPath(row.entry);
          row.pathEl.textContent = text;
          row.pathEl.title = text;
        });
      }
      function visibleEntry(entry) {
        if (!entry) return false;
        if (!activeTypes.has(typeOf(entry))) return false;
        const q = query.trim().toLowerCase();
        if (!q) return true;
        return String(entry.name || "").toLowerCase().indexOf(q) >= 0;
      }
      function sortedRows(group) {
        const items = group.items.map(function(entry) {
          return rows.get(entry.id);
        }).filter(Boolean);
        if (sortMode === "name") {
          items.sort(function(a, b) {
            return String(a.entry.name || "").localeCompare(String(b.entry.name || ""), "zh-Hans-CN", { numeric: true });
          });
        } else if (sortMode === "size") {
          const known = items.filter(function(row) {
            return sizes.has(row.entry.id);
          });
          const unknown = items.filter(function(row) {
            return !sizes.has(row.entry.id);
          });
          known.sort(function(a, b) {
            return sizes.get(b.entry.id) - sizes.get(a.entry.id);
          });
          return known.concat(unknown);
        }
        return items;
      }
      let viewHint = "";
      function applyView() {
        let visible = 0;
        let pendingSize = 0;
        groups.forEach(function(group, key) {
          const folder = folders.get(key);
          let shown = 0;
          for (const entry of group.items) {
            const row = rows.get(entry.id);
            if (!row) continue;
            const ok = visibleEntry(entry);
            row.el.hidden = !ok;
            if (!ok) continue;
            shown += 1;
            if (!sizes.has(entry.id)) pendingSize += 1;
          }
          visible += shown;
          if (!folder) return;
          if (folder.el) folder.el.hidden = shown === 0;
          if (sortMode === "none" || !shown || !folder.el) return;
          for (const row of sortedRows(group)) {
            if (row.el.parentNode === folder.el) folder.el.appendChild(row.el);
          }
        });
        let next = "";
        if (!visible) next = "\u6CA1\u6709\u5339\u914D\u7684\u6587\u4EF6\uFF1A\u6362\u4E2A\u5173\u952E\u8BCD\uFF0C\u6216\u628A\u7C7B\u578B\u52FE\u56DE\u6765\u3002";
        else if (sortMode === "size" && pendingSize) {
          next = "\u6309\u4F53\u79EF\u6392\u5E8F\uFF1A" + pendingSize + " \u4E2A\u4F53\u79EF\u672A\u63A2\u6D4B\uFF0C\u5DF2\u7A33\u5B9A\u6392\u5728\u6700\u540E\uFF0C\u53EF\u5148\u70B9\u300C\u83B7\u53D6\u4F53\u79EF\u300D\u3002";
        }
        if (hintEl.textContent === viewHint) hintEl.textContent = next;
        viewHint = next;
      }
      const MODE_TEXT = {
        fs: "\u843D\u76D8\u65B9\u5F0F\uFF1A\u4FDD\u5B58\u5230\u6587\u4EF6\u5939\uFF08Chromium\uFF09\u2014\u2014\u53EF\u4EE5\u9009\u4E00\u4E2A\u76EE\u5F55\uFF0C\u6587\u4EF6\u6309\u539F\u76EE\u5F55\u7ED3\u6784\u76F4\u63A5\u5199\u8FDB\u53BB\u3002\u4EE3\u4EF7\uFF1A\u6BCF\u6B21\u4E0B\u8F7D\u90FD\u8981\u91CD\u65B0\u9009\u4E00\u6B21\u6587\u4EF6\u5939\uFF0C\u4E14\u53EA\u6709 Chromium \u7CFB\u6D4F\u89C8\u5668\u652F\u6301\u3002",
        zip: "\u843D\u76D8\u65B9\u5F0F\uFF1A\u6309\u6587\u4EF6\u5939\u6253\u5305\u6210 .zip\uFF08\u5B58\u5230\u6D4F\u89C8\u5668\u9ED8\u8BA4\u4E0B\u8F7D\u76EE\u5F55\uFF09\u2014\u2014\u6CA1\u6709\u76EE\u5F55\u5199\u5165\u6743\u9650\u65F6\u81EA\u52A8\u9000\u5230\u8FD9\u79CD\u65B9\u5F0F\uFF0C\u89E3\u538B\u540E\u8FD8\u539F\u539F\u76EE\u5F55\u7ED3\u6784\u3002\u4EE3\u4EF7\uFF1A\u6309\u9876\u5C42\u6587\u4EF6\u5939\u5206\u5305\uFF0C\u5355\u5305\u4E0A\u9650\u7EA6 200 MB\u3002",
        download: "\u843D\u76D8\u65B9\u5F0F\uFF1A\u9010\u6587\u4EF6\u4E0B\u8F7D\uFF08\u8FDB\u6D4F\u89C8\u5668\u9ED8\u8BA4\u4E0B\u8F7D\u76EE\u5F55\uFF09\u2014\u2014\u5F53\u524D\u6D4F\u89C8\u5668\u65E0\u6CD5\u8BA9\u7F51\u9875\u9009\u76EE\u5F55\uFF0C\u6587\u4EF6\u540D\u7528\u76EE\u5F55\u524D\u7F00\u4FDD\u7559\u5C42\u7EA7\u3002\u4EE3\u4EF7\uFF1A\u6240\u6709\u6587\u4EF6\u90FD\u8FDB\u9ED8\u8BA4\u4E0B\u8F7D\u76EE\u5F55\uFF0C\u5EFA\u4E0D\u4E86\u5B50\u76EE\u5F55\uFF0C\u6587\u4EF6\u591A\u65F6\u4F1A\u8FDE\u7EED\u5F39\u4E0B\u8F7D\u3002"
      };
      function modeKind() {
        if (pickedHandle) return "fs";
        return settings && settings.fallbackSink === "files" ? "download" : "zip";
      }
      function renderMode() {
        const text = MODE_TEXT[modeKind()];
        modeEl.textContent = text + (preserveTree ? "" : "\uFF08\u5DF2\u5173\u95ED\u300C\u4FDD\u7559\u539F\u59CB\u76EE\u5F55\u7ED3\u6784\u300D\uFF09");
        modeEl.title = modeEl.textContent;
      }
      function expectedTotalBytes(chosen) {
        let sum = 0;
        for (const entry of chosen) {
          if (!sizes.has(entry.id)) return 0;
          sum += sizes.get(entry.id);
        }
        return sum;
      }
      function folderTotals(folder) {
        let chosen = 0;
        let bytes = 0;
        let known = 0;
        for (const entry of folder.items) {
          if (!selected.has(entry.id)) continue;
          chosen += 1;
          if (sizes.has(entry.id)) {
            bytes += sizes.get(entry.id);
            known += 1;
          }
        }
        return { chosen, bytes, known };
      }
      function syncFolders() {
        folders.forEach(function(folder) {
          const stat = folderTotals(folder);
          folder.input.indeterminate = stat.chosen > 0 && stat.chosen < folder.items.length;
          folder.input.checked = stat.chosen > 0 && stat.chosen === folder.items.length;
          folder.sizeEl.textContent = stat.known ? formatBytes2(stat.bytes) : "\u2014";
        });
      }
      function collectSelected() {
        return list.filter(function(entry) {
          return entry && selected.has(entry.id);
        });
      }
      function persistSelection() {
        writeSelection(
          selectionKey,
          collectSelected().map(function(entry) {
            return entry.id;
          })
        );
      }
      function renderTotals() {
        const chosen = collectSelected();
        persistSelection();
        let bytes = 0;
        let known = 0;
        for (const entry of chosen) {
          if (sizes.has(entry.id)) {
            bytes += sizes.get(entry.id);
            known += 1;
          }
        }
        const unknown = chosen.length - known;
        const amount = known ? formatBytes2(bytes) : "\u2014";
        let skipped = 0;
        if (skipExisting) {
          for (const entry of chosen) if (skipInfo.byId.has(entry.id)) skipped += 1;
        }
        const skipText = skipped ? "\uFF0C\u5176\u4E2D " + skipped + " \u4E2A\u5DF2\u5B58\u5728\u4F1A\u8DF3\u8FC7" : "";
        totalsEl.textContent = "\u5DF2\u9009 " + chosen.length + " / \u5171 " + list.length + "\uFF0C\u5408\u8BA1 " + amount + (unknown ? "\uFF08" + unknown + " \u4E2A\u4F53\u79EF\u672A\u77E5\uFF09" : "") + skipText;
        confirmBtn.disabled = chosen.length === 0;
        confirmBtn.title = chosen.length === 0 ? "\u81F3\u5C11\u9009\u62E9\u4E00\u4E2A\u6587\u4EF6" : "";
      }
      function setRowSizeInternal(id, size) {
        const row = rows.get(id);
        if (!row) return false;
        if (typeof size === "number" && Number.isFinite(size) && size >= 0) {
          sizes.set(id, size);
          row.sizeEl.textContent = formatBytes2(size);
          row.sizeEl.title = size + " \u5B57\u8282";
        } else {
          sizes.delete(id);
          row.sizeEl.textContent = "\u2014";
          row.sizeEl.title = "";
        }
        applyView();
        syncFolders();
        renderTotals();
        return true;
      }
      function close(value) {
        if (closed) return;
        closed = true;
        persistSelection();
        pickGeneration += 1;
        if (onDialogClose) {
          try {
            onDialogClose();
          } catch (err) {
          }
        }
        document.removeEventListener("keydown", onKeyDown, true);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        if (activeInstance === inst) activeInstance = null;
        resolve(value);
      }
      function onKeyDown(event) {
        if (event.key === "Escape" || event.key === "Esc") {
          event.stopPropagation();
          close(null);
        }
      }
      function onDirectoryPicked(dirHandle) {
        if (closed) return;
        const chosen = collectSelected();
        if (!chosen.length) {
          showError("\u8BF7\u81F3\u5C11\u9009\u62E9\u4E00\u4E2A\u6587\u4EF6\u3002");
          return;
        }
        if (dirHandle) {
          close({
            entries: chosen,
            dirHandle,
            sizeRefresher: setRowSizeInternal,
            expectedBytes: expectedTotalBytes(chosen),
            skipExisting
          });
          return;
        }
        if (fsaAvailable) {
          showError("\u5DF2\u53D6\u6D88\u9009\u62E9\u6587\u4EF6\u5939\uFF0C\u672A\u5F00\u59CB\u4E0B\u8F7D\u3002\u53EF\u518D\u6B21\u70B9\u51FB\u300C\u5F00\u59CB\u4E0B\u8F7D\u300D\uFF0C\u6216\u6539\u7528\u9ED8\u8BA4\u4E0B\u8F7D\u3002", true);
          return;
        }
        close({
          entries: chosen,
          sizeRefresher: setRowSizeInternal,
          expectedBytes: expectedTotalBytes(chosen),
          skipExisting
        });
      }
      function onDirectoryFailed(err) {
        if (closed) return;
        const name = String(err && err.name || "");
        if (/abort/i.test(name)) {
          showError("\u5DF2\u53D6\u6D88\u9009\u62E9\u6587\u4EF6\u5939\uFF0C\u672A\u5F00\u59CB\u4E0B\u8F7D\u3002", true);
          return;
        }
        showError("\u65E0\u6CD5\u6253\u5F00\u6587\u4EF6\u5939\u9009\u62E9\u5668\uFF1A" + (err && err.message || String(err)) + "\u3002\u53EF\u91CD\u8BD5\u3002", true);
      }
      fallbackBtn.addEventListener("click", function() {
        const chosen = collectSelected();
        if (!chosen.length) {
          showError("\u8BF7\u81F3\u5C11\u9009\u62E9\u4E00\u4E2A\u6587\u4EF6\u3002");
          return;
        }
        close({
          entries: chosen,
          sizeRefresher: setRowSizeInternal,
          expectedBytes: expectedTotalBytes(chosen),
          skipExisting
        });
      });
      function handleConfirm() {
        if (pickedHandle) {
          onDirectoryPicked(pickedHandle);
          return;
        }
        const picked = pickDirectory2();
        if (picked && typeof picked.then === "function") {
          clearError();
          confirmBtn.disabled = true;
          picked.then(
            function(dirHandle) {
              confirmBtn.disabled = false;
              onDirectoryPicked(dirHandle);
            },
            function(err) {
              confirmBtn.disabled = false;
              onDirectoryFailed(err);
            }
          );
          return;
        }
        onDirectoryPicked(picked);
      }
      confirmBtn.addEventListener("click", function() {
        try {
          handleConfirm();
        } catch (err) {
          onDirectoryFailed(err);
        }
      });
      cancelBtn.addEventListener("click", function() {
        close(null);
      });
      closeBtn.addEventListener("click", function() {
        close(null);
      });
      allBtn.addEventListener("click", function() {
        for (const entry of list) {
          if (!entry || !visibleEntry(entry)) continue;
          selected.add(entry.id);
          const row = rows.get(entry.id);
          if (row) row.input.checked = true;
        }
        syncFolders();
        renderTotals();
      });
      noneBtn.addEventListener("click", function() {
        for (const entry of list) {
          if (!entry || !visibleEntry(entry)) continue;
          selected.delete(entry.id);
          const row = rows.get(entry.id);
          if (row) row.input.checked = false;
        }
        syncFolders();
        renderTotals();
      });
      searchInput.addEventListener("input", function() {
        query = searchInput.value || "";
        applyView();
      });
      sortSelect.addEventListener("change", function() {
        sortMode = sortSelect.value || "none";
        applyView();
      });
      dirBtn.addEventListener("click", function() {
        handlePickDirectory();
      });
      probeBtn.addEventListener("click", function() {
        if (!onProbeSizes) return;
        const unknown = collectSelected().filter(function(entry) {
          return !sizes.has(entry.id);
        });
        if (!unknown.length) {
          setHint("\u5DF2\u9009\u6587\u4EF6\u7684\u4F53\u79EF\u90FD\u5DF2\u77E5\u3002");
          return;
        }
        probeBtn.disabled = true;
        setHint("\u6B63\u5728\u83B7\u53D6 " + unknown.length + " \u4E2A\u4F53\u79EF\u2026");
        let pending;
        try {
          pending = onProbeSizes(unknown, { setRowSize: setRowSizeInternal });
        } catch (err) {
          probeBtn.disabled = false;
          setHint("\u4F53\u79EF\u83B7\u53D6\u5931\u8D25\uFF1A" + redactUrlText(String(err && err.message || err)));
          return;
        }
        Promise.resolve(pending).then(
          function(report) {
            probeBtn.disabled = false;
            const failed = report && Number.isFinite(report.fail) ? report.fail : 0;
            if (!failed) {
              setHint("\u4F53\u79EF\u5DF2\u66F4\u65B0\u3002");
              return;
            }
            const reason = report && report.firstError ? "\uFF1A" + redactUrlText(String(report.firstError)) : "";
            setHint("\u4F53\u79EF\u5DF2\u66F4\u65B0\uFF08" + failed + " \u4E2A\u4F53\u79EF\u63A2\u6D4B\u5931\u8D25\uFF09" + reason);
          },
          function(err) {
            probeBtn.disabled = false;
            setHint("\u4F53\u79EF\u83B7\u53D6\u5931\u8D25\uFF1A" + redactUrlText(String(err && err.message || err)));
          }
        );
      });
      treeInput.addEventListener("change", function() {
        preserveTree = treeInput.checked;
        if (onSettingsChange) {
          try {
            onSettingsChange({ preserveTree });
          } catch (err) {
            showError("\u4FDD\u5B58\u8BBE\u7F6E\u5931\u8D25\uFF1A" + (err && err.message || String(err)));
          }
        }
        renderPaths();
        renderMode();
        renderTotals();
        refreshSkipsAfterTreeChange();
      });
      skipInput.addEventListener("change", function() {
        skipTouched = true;
        skipExisting = skipInput.checked;
        setHint(skipExisting ? "\u5DF2\u5B58\u5728\u7684\u6587\u4EF6\u4F1A\u8DF3\u8FC7\uFF0C\u53EA\u4E0B\u8F7D\u7F3A\u7684\u3002" : "\u5DF2\u53D6\u6D88\u8DF3\u8FC7\uFF1A\u9009\u4E2D\u7684\u6587\u4EF6\u4F1A\u5168\u90E8\u91CD\u65B0\u4E0B\u8F7D\u3002");
        renderTotals();
      });
      renderSkip();
      renderDirRow();
      buildTree();
      renderPaths();
      renderMode();
      syncFolders();
      renderTotals();
      applyView();
      document.addEventListener("keydown", onKeyDown, true);
      (document.body || document.documentElement).appendChild(overlay);
      activeInstance = inst;
      if (!list.length) showError("\u6CA1\u6709\u53EF\u4E0B\u8F7D\u7684\u6587\u4EF6\u3002");
      confirmBtn.focus();
    });
  }

  // src/index.js
  var files2 = { buildEntryPath, sanitizeSegment, dedupePaths };
  var FILE_DONE = "file-done";
  var FILE_FAILED = "file-failed";
  var MANIFEST_FLUSH_MS = 500;
  var MAX_SCAN_HISTORY = 10;
  var MAX_CHANGED_PATHS = 50;
  var SINK_DEFAULTS = { idleTimeoutMs: 3e4, fileRetries: 1, serializeOverBytes: 48 * 1024 * 1024 };
  var SINK_LABELS = { fs: "\u4FDD\u5B58\u5230\u6587\u4EF6\u5939", zip: "\u6253\u5305\u6210 ZIP", download: "\u6D4F\u89C8\u5668\u4E0B\u8F7D" };
  function sinkLabel(kind) {
    return SINK_LABELS[kind] || String(kind || "\u672A\u77E5");
  }
  var PERMISSION_TEXT = {
    prompt: "\u6D4F\u89C8\u5668\u8FD8\u9700\u8981\u4F60\u518D\u786E\u8BA4\u4E00\u6B21\u76EE\u5F55\u6743\u9650",
    denied: "\u6D4F\u89C8\u5668\u62D2\u7EDD\u4E86\u76EE\u5F55\u6743\u9650",
    unsupported: "\u5F53\u524D\u73AF\u5883\u62FF\u4E0D\u5230\u76EE\u5F55\u53E5\u67C4"
  };
  function currentIds(loc) {
    const href = String(loc && loc.href || "");
    try {
      const params = new URL(href).searchParams;
      return { courseId: params.get("course_id"), contentId: params.get("content_id") };
    } catch (err) {
      return { courseId: null, contentId: null };
    }
  }
  function describe(err) {
    if (err instanceof SessionExpiredError) return "\u4F1A\u8BDD\u5DF2\u5931\u6548\uFF1A\u8BF7\u91CD\u65B0\u767B\u5F55 Blackboard\uFF0C\u7136\u540E\u5237\u65B0\u672C\u9875\u518D\u8BD5\u3002";
    return err && err.message || String(err);
  }
  var AUTO_RESUME_DELAYS = [3e3, 8e3, 2e4];
  var DEFAULT_KEEP_ALIVE_MS = 90 * 1e3;
  var DEFAULT_AUTO_RESUME_MAX = 3;
  var AUTO_RESUME_MAX_TOTAL = 20;
  var DEFAULT_AUTO_RELOAD_MAX = 2;
  var INTENT_KEY = "bbdl:resume-intent:v1";
  var INTENT_TTL_MS = 30 * 60 * 1e3;
  var PAUSED_NOTICE_PREFIX = "\u5DF2\u6682\u505C\uFF0C\u672A\u4E0B\u8F7D ";
  function shouldAutoResume(input) {
    const opts = input || {};
    const halted = opts.halted || null;
    if (!halted || halted.reason !== "session-expired") return false;
    if (opts.aborted) return false;
    const used = Number.isFinite(opts.used) ? Math.max(0, Math.floor(opts.used)) : 0;
    const max = Number.isFinite(opts.max) ? Math.max(0, Math.floor(opts.max)) : DEFAULT_AUTO_RESUME_MAX;
    return used < max;
  }
  function autoResumeDelay(used) {
    const index = Number.isFinite(used) && used > 0 ? Math.floor(used) : 0;
    if (index >= AUTO_RESUME_DELAYS.length) return AUTO_RESUME_DELAYS[AUTO_RESUME_DELAYS.length - 1];
    return AUTO_RESUME_DELAYS[index];
  }
  function sessionIntentStore() {
    function bucket() {
      try {
        return typeof sessionStorage === "undefined" ? null : sessionStorage;
      } catch (err) {
        return null;
      }
    }
    return {
      read() {
        try {
          const store = bucket();
          const raw = store ? store.getItem(INTENT_KEY) : null;
          return raw ? JSON.parse(raw) : null;
        } catch (err) {
          return null;
        }
      },
      write(value) {
        try {
          const store = bucket();
          if (!store) return false;
          store.setItem(INTENT_KEY, JSON.stringify(value));
          return true;
        } catch (err) {
          return false;
        }
      },
      clear() {
        try {
          const store = bucket();
          if (store) store.removeItem(INTENT_KEY);
        } catch (err) {
        }
      }
    };
  }
  var KEEP_ALIVE_DROP_PARAMS = ["mode", "list_display", "pagelinks"];
  function keepAliveUrl(href) {
    if (typeof href !== "string" || !href) return "";
    const hashAt = href.indexOf("#");
    const hash = hashAt < 0 ? "" : href.slice(hashAt);
    const before = hashAt < 0 ? href : href.slice(0, hashAt);
    const queryAt = before.indexOf("?");
    if (queryAt < 0) return href;
    const query = before.slice(queryAt + 1);
    if (!query) return href;
    const kept = [];
    for (const pair of query.split("&")) {
      if (!pair) continue;
      const eq = pair.indexOf("=");
      const name = (eq < 0 ? pair : pair.slice(0, eq)).toLowerCase();
      if (KEEP_ALIVE_DROP_PARAMS.indexOf(name) >= 0) continue;
      kept.push(pair);
    }
    const base = before.slice(0, queryAt);
    return kept.length ? base + "?" + kept.join("&") + hash : base + hash;
  }
  function permissionText(status) {
    return PERMISSION_TEXT[status] || "\u76EE\u5F55\u6743\u9650\u4E0D\u53EF\u7528";
  }
  function nonNegCount2(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  function entryIdOf2(entry) {
    const id = entry && entry.id;
    return id === null || id === void 0 || id === "" ? "" : String(id);
  }
  function staleListOf(result) {
    const stale = Array.isArray(result && result.stale) ? result.stale : [];
    const out = [];
    for (const item of stale) {
      if (!item) continue;
      out.push({
        id: item.id === null || item.id === void 0 ? "" : String(item.id),
        path: item.path === null || item.path === void 0 ? "" : String(item.path)
      });
    }
    return out;
  }
  function emptySummary() {
    return {
      total: 0,
      disk: 0,
      manifest: 0,
      unverified: 0,
      byId: /* @__PURE__ */ new Map(),
      truncated: false,
      diskChecked: false,
      added: 0,
      changed: 0,
      moved: 0,
      unchanged: 0,
      unknown: 0,
      stale: 0,
      /** 清单命中里「上游未变」的那一档：和磁盘命中分开记，UI 才说得清凭什么是「未变」。 */
      manifestUnchanged: 0,
      /** 本轮扫描失败的文件夹数（快照，不是活引用）。 */
      scanFailures: 0,
      /** 疑似删除：{ id, path } 原样，只在 UI 里提示，永不触发删除。 */
      staleList: []
    };
  }
  function applySinkDefaults(target) {
    for (const key of Object.keys(SINK_DEFAULTS)) {
      const value = target[key];
      if (typeof value !== "number" || !Number.isFinite(value)) target[key] = SINK_DEFAULTS[key];
    }
    return target;
  }
  function createController(config) {
    const cfg = config || {};
    const loc = cfg.location || (typeof location === "undefined" ? null : location);
    const doc = cfg.document || (typeof document === "undefined" ? null : document);
    const store = cfg.store || null;
    const settings = applySinkDefaults(cfg.settings || {});
    const deps = cfg.deps || {};
    const createFetcher2 = typeof deps.createFetcher === "function" ? deps.createFetcher : createFetcher;
    const createScanner2 = typeof deps.createScanner === "function" ? deps.createScanner : createScanner;
    const createSink2 = typeof deps.createSink === "function" ? deps.createSink : createSink;
    const planSkips2 = typeof deps.planSkips === "function" ? deps.planSkips : null;
    const updateRecords2 = typeof deps.updateRecords === "function" ? deps.updateRecords : null;
    const ensurePermission = typeof deps.ensureDirectoryPermission === "function" ? deps.ensureDirectoryPermission : null;
    const appendScanHistory2 = typeof deps.appendScanHistory === "function" ? deps.appendScanHistory : null;
    const exportManifestPack2 = typeof deps.exportManifestPack === "function" ? deps.exportManifestPack : null;
    const importManifestPack2 = typeof deps.importManifestPack === "function" ? deps.importManifestPack : null;
    const mergeManifests2 = typeof deps.mergeManifests === "function" ? deps.mergeManifests : null;
    const wait = typeof deps.wait === "function" ? deps.wait : waitAbortable;
    const reload = typeof deps.reload === "function" ? deps.reload : function() {
      if (loc && typeof loc.reload === "function") loc.reload();
    };
    const now = typeof deps.now === "function" ? deps.now : Date.now;
    const intentStore = deps.intentStore && typeof deps.intentStore === "object" ? deps.intentStore : sessionIntentStore();
    const writeDownload = typeof cfg.downloadTextFile === "function" ? cfg.downloadTextFile : null;
    const listExistingFiles2 = typeof cfg.listExistingFiles === "function" ? cfg.listExistingFiles : listExistingFiles;
    const pickDirectory2 = typeof cfg.pickDirectory === "function" ? cfg.pickDirectory : pickDirectory;
    const openSelectDialog2 = typeof cfg.openSelectDialog === "function" ? cfg.openSelectDialog : openSelectDialog;
    const mountPanel2 = typeof cfg.mountPanel === "function" ? cfg.mountPanel : mountPanel;
    const { courseId, contentId } = currentIds(loc);
    if (!courseId || !contentId) return null;
    const state = {
      entries: [],
      plans: [],
      entryById: /* @__PURE__ */ new Map(),
      busy: false,
      abort: null,
      dirHandle: null,
      resumeHandle: null,
      savedHandle: null,
      expectedBytes: 0,
      manifest: null,
      skipResult: null,
      skipSummary: null,
      skipDirHandle: null,
      /** 摘要算的时候用的是哪种目录结构：它一变，summary 就不能再用。 */
      skipPreserveTree: null,
      diskChecked: false,
      diskTruncated: false,
      /** 上一轮扫描失败的文件夹数：取的是扫描结束那一刻的快照，扫描器下次跑会重置自己的数组。 */
      scanFailures: 0,
      /** 目录枚举缓存：同一个句柄只扫一次盘，摘要与最终交给 sink 的判断共用这一份。 */
      existingPaths: null,
      existingHandle: null,
      existingHas: false,
      existingChecked: false,
      existingTruncated: false,
      /** 对话框里选定的目录；关掉对话框后由 startDownload 清掉。 */
      pickHandle: null,
      pickAbort: null,
      pendingRecords: [],
      /** 「获取体积」的结果：对话框只拿它刷行，落盘层的体积索引必须自己留一份。 */
      probedSizes: /* @__PURE__ */ new Map(),
      flushTimer: 0,
      batchPlans: [],
      batchOk: /* @__PURE__ */ new Map(),
      batchFailed: /* @__PURE__ */ new Map(),
      selectedIds: [],
      /** 上一轮停机时没能下载的 entry 快照：只给「刷新后继续」用，不清清单、不重扫。 */
      haltedPending: [],
      /** 自动续跑已经用掉几次：用户新发起一批归零，续跑 / 重试继承当前计数。 */
      autoResumeUsed: 0,
      /** 自动续跑上限（settings.autoResumeMax，缺省 3）：撞满就交回用户。 */
      autoResumeMax: autoResumeLimit()
    };
    const panel = mountPanel2({
      document: doc,
      settings,
      onSettingsChange(patch) {
        Object.assign(settings, saveSettings(patch));
      },
      onScan: startScan,
      onDownload: startDownload,
      onRetryFailed,
      // 依赖缺失（或降级加载失败）时把行整个藏掉：面板不摆一个按了没反应的按钮。
      onExportManifest: exportManifestPack2 ? exportManifest : null,
      onImportManifest: importManifestPack2 ? importManifest : null,
      onResume: resumeLast,
      onResumePending: resumePending,
      onCancel() {
        if (state.abort) state.abort.abort();
      }
    });
    if (typeof panel.setCourse === "function") panel.setCourse(courseId, cfg.courseName || pageTitle(doc));
    const ready = hydrate().then(function(value) {
      pushHistory();
      return value;
    });
    const resumeIntent = ready.then(function() {
      return consumeIntent();
    });
    async function safeCall(fn) {
      try {
        return await fn();
      } catch (err) {
        return null;
      }
    }
    async function hydrate() {
      const manifest = await safeCall(() => store ? store.loadManifest(courseId) : null);
      if (manifest) state.manifest = manifest;
      const handle = await safeCall(() => store ? store.loadHandle(courseId) : null);
      if (!handle) return;
      state.savedHandle = handle;
      const status = await ensurePermissionStatus(handle, false);
      panel.setResume({ dirName: handle.name || "\u4E0A\u6B21\u7684\u76EE\u5F55", granted: status === "granted" });
    }
    async function ensurePermissionStatus(handle, request) {
      if (!handle || !ensurePermission) return "unsupported";
      const status = await safeCall(() => ensurePermission(handle, { request }));
      return status || "unsupported";
    }
    function rememberHandle(handle) {
      if (!handle) return;
      state.savedHandle = handle;
      try {
        panel.setResume({ dirName: handle.name || "\u4E0A\u6B21\u7684\u76EE\u5F55", granted: true });
      } catch (err) {
      }
      if (!store || typeof store.saveHandle !== "function") return;
      void safeCall(() => store.saveHandle(courseId, handle));
    }
    function withExpectedTotal(payload) {
      const p = payload || {};
      const total = pickTotal(p);
      if (total > 0 || !(state.expectedBytes > 0)) return p;
      return Object.assign({}, p, { bytesTotal: state.expectedBytes });
    }
    function pickTotal(p) {
      const v = typeof p.bytesTotal === "number" ? p.bytesTotal : 0;
      return Number.isFinite(v) && v > 0 ? v : 0;
    }
    function onProgress(payload) {
      const p = payload || {};
      panel.setDownloadProgress(withExpectedTotal(p));
      if (p.state === FILE_DONE || p.state === FILE_FAILED) noteRecord(p);
    }
    function begin() {
      state.busy = true;
      state.abort = new AbortController();
      return state.abort.signal;
    }
    function rememberedName(entry) {
      const id = entry && entry.id !== null && entry.id !== void 0 ? String(entry.id) : "";
      if (!id) return "";
      const recordedFiles = state.manifest && typeof state.manifest.files === "object" ? state.manifest.files : null;
      const record = recordedFiles && Object.prototype.hasOwnProperty.call(recordedFiles, id) ? recordedFiles[id] : null;
      if (!record || record.status !== "done") return "";
      const name = typeof record.name === "string" ? record.name : "";
      if (!name) return "";
      const recordedHref = record.href === null || record.href === void 0 ? "" : String(record.href).trim();
      const href = entry.href === null || entry.href === void 0 ? "" : String(entry.href).trim();
      return recordedHref === href ? name : "";
    }
    function buildPlans(entries) {
      for (const entry of Array.isArray(entries) ? entries : []) {
        const name = rememberedName(entry);
        if (name) entry.name = name;
      }
      return planBatch(entries, { preserveTree: settings.preserveTree !== false, files: files2 });
    }
    async function existingSnapshot(dirHandle, signal, force) {
      const empty = { paths: /* @__PURE__ */ new Map(), checked: false, truncated: false };
      const handle = dirHandle || null;
      if (!force && state.existingHas && state.existingHandle === handle) {
        return { paths: state.existingPaths, checked: state.existingChecked, truncated: state.existingTruncated };
      }
      const remember = function(paths, checked, truncated) {
        state.existingPaths = paths;
        state.existingHandle = handle;
        state.existingHas = true;
        state.existingChecked = checked;
        state.existingTruncated = truncated;
      };
      if (!handle || typeof listExistingFiles2 !== "function") {
        if (!(signal && signal.aborted)) remember(empty.paths, false, false);
        return empty;
      }
      const status = await ensurePermissionStatus(handle, false);
      if (status !== "granted" || signal && signal.aborted) return empty;
      try {
        const found = await listExistingFiles2(handle, { signal });
        if (!(found instanceof Map) || signal && signal.aborted) return empty;
        const truncated = !!found.truncated;
        remember(found, true, truncated);
        return { paths: found, checked: true, truncated };
      } catch (err) {
        return empty;
      }
    }
    async function computeSkips(dirHandle, signal, options) {
      const opts = options || {};
      const plans = buildPlans(state.entries);
      state.plans = plans;
      let manifest = state.manifest;
      if (!manifest) {
        manifest = await safeCall(() => store ? store.loadManifest(courseId) : null);
        if (manifest) state.manifest = manifest;
      }
      const existing = await existingSnapshot(dirHandle, signal, opts.force === true);
      if (signal && signal.aborted) return null;
      state.diskChecked = existing.checked;
      state.diskTruncated = existing.truncated;
      state.skipDirHandle = dirHandle || null;
      const preserveTree = settings.preserveTree !== false;
      state.skipPreserveTree = preserveTree;
      const result = planSkips2 ? planSkips2({
        plans,
        manifest: manifest || null,
        existingPaths: existing.paths,
        preserveTree,
        // 契约 §4：本轮有文件夹扫失败 → 清单证据一律降级 unknown，绝不拿「可能变了」的东西冒充未变。
        scanFailed: nonNegCount2(state.scanFailures) > 0
      }) : {
        todo: plans,
        skip: [],
        stale: [],
        // 降级分支（没有 planSkips 模块）也吐完整六桶：UI 只认一套 diff 形状，不按环境分叉。
        diff: { added: plans.length, changed: 0, moved: 0, unchanged: 0, stale: 0, unknown: 0, total: plans.length }
      };
      state.skipResult = result;
      state.skipSummary = summarize(result);
      return result;
    }
    function summarize(result) {
      const summary = emptySummary();
      const skip = Array.isArray(result && result.skip) ? result.skip : [];
      for (const item of skip) {
        const plan = item && item.plan;
        const id = plan && plan.entry ? plan.entry.id : null;
        if (!id) continue;
        summary.byId.set(id, { reason: item.reason, size: item.size == null ? null : item.size });
        if (item.reason === "disk") summary.disk += 1;
        else if (item.reason === "disk-unverified") {
          summary.disk += 1;
          summary.unverified += 1;
        } else {
          summary.manifest += 1;
          if (item.reason === "manifest-unchanged") summary.manifestUnchanged += 1;
        }
      }
      summary.total = summary.byId.size;
      summary.truncated = !!state.diskTruncated;
      summary.diskChecked = !!state.diskChecked;
      const diff = result && result.diff || {};
      summary.added = nonNegCount2(diff.added);
      summary.changed = nonNegCount2(diff.changed);
      summary.moved = nonNegCount2(diff.moved);
      summary.unchanged = nonNegCount2(diff.unchanged);
      summary.unknown = nonNegCount2(diff.unknown);
      summary.stale = nonNegCount2(diff.stale);
      summary.staleList = staleListOf(result);
      summary.scanFailures = nonNegCount2(state.scanFailures);
      return summary;
    }
    async function refreshSkips(preferredHandle, signal) {
      const handle = preferredHandle || state.resumeHandle || state.savedHandle || null;
      await computeSkips(handle, signal);
      if (state.diskTruncated) {
        panel.setNotice("\u76EE\u5F55\u91CC\u7684\u6587\u4EF6\u592A\u591A\uFF0C\u672C\u6B21\u53EA\u6BD4\u5BF9\u4E86\u524D\u9762\u4E00\u90E8\u5206\uFF1B\u300C\u8DF3\u8FC7\u5DF2\u5B58\u5728\u300D\u7684\u5224\u65AD\u53EF\u80FD\u4E0D\u5B8C\u6574\u3002");
      }
      return state.skipSummary;
    }
    async function resolveBatch(choice, signal) {
      const chosen = choice.entries;
      if (choice.skipExisting === false) return chosen;
      const dirHandle = choice.dirHandle || null;
      let result = state.skipResult;
      const preserveTree = settings.preserveTree !== false;
      if (!result || state.skipDirHandle !== (dirHandle || null) || state.skipPreserveTree !== preserveTree) {
        result = await computeSkips(dirHandle, signal);
      }
      if (!result) return chosen;
      const todoIds = /* @__PURE__ */ new Set();
      const todo = Array.isArray(result.todo) ? result.todo : [];
      for (const plan of todo) {
        if (plan && plan.entry && plan.entry.id) todoIds.add(plan.entry.id);
      }
      return chosen.filter((entry) => todoIds.has(entry.id));
    }
    function abortPick() {
      const controller = state.pickAbort;
      state.pickAbort = null;
      if (!controller) return;
      try {
        controller.abort();
      } catch (err) {
      }
    }
    async function afterPick(handle, permission, signal, report) {
      const name = handle && handle.name || "\u6240\u9009\u76EE\u5F55";
      report.setHint("\u6B63\u5728\u6BD4\u5BF9\u78C1\u76D8\u2026");
      let status = "unsupported";
      if (permission) status = await permission || "unsupported";
      else status = await ensurePermissionStatus(handle, false);
      if (signal.aborted) return { cancelled: true };
      if (status !== "granted") {
        state.pickHandle = null;
        const fallback = await computeSkips(null, signal, { force: true });
        if (signal.aborted || !fallback) return { cancelled: true };
        return { status, dirHandle: null, name, skipInfo: state.skipSummary };
      }
      state.pickHandle = handle;
      const result = await computeSkips(handle, signal, { force: true });
      if (signal.aborted || !result) return { cancelled: true };
      rememberHandle(handle);
      return { status: "granted", dirHandle: handle, name, skipInfo: state.skipSummary };
    }
    function pickDirectoryForDialog(api) {
      const report = api && typeof api.setHint === "function" ? api : { setHint: function() {
      } };
      abortPick();
      const controller = new AbortController();
      state.pickAbort = controller;
      const signal = controller.signal;
      let picked;
      try {
        picked = pickDirectory2({ signal });
      } catch (err) {
        state.pickAbort = null;
        return Promise.resolve({ failed: describe(err) });
      }
      if (picked && typeof picked.then !== "function") {
        return afterPick(picked, ensurePermissionStatus(picked, true), signal, report);
      }
      return Promise.resolve(picked).then(
        function(handle) {
          if (!handle) return { cancelled: true };
          return afterPick(handle, null, signal, report);
        },
        function(err) {
          if (err && (err.name === "AbortError" || err.name === "NotAllowedError")) return { cancelled: true };
          return { failed: describe(err) };
        }
      );
    }
    async function refreshDialogSkips() {
      const handle = state.pickHandle || state.dirHandle || state.resumeHandle || null;
      const signal = state.pickAbort ? state.pickAbort.signal : null;
      const result = await computeSkips(handle, signal, { force: false });
      return result ? state.skipSummary : null;
    }
    async function startScan() {
      if (state.busy) return null;
      const signal = begin();
      panel.setState("scanning");
      panel.setNotice("");
      try {
        const fetcher = createFetcher2({ signal });
        const scanner = createScanner2({
          fetcher,
          rootUrl: loc && loc.href || "",
          onProgress: (p) => panel.setScanProgress(p)
        });
        const entries = await scanner.scan();
        state.scanFailures = scanner && Array.isArray(scanner.failures) ? scanner.failures.length : 0;
        state.entries = Array.isArray(entries) ? entries : [];
        state.entryById = new Map(state.entries.filter(Boolean).map((entry) => [entry.id, entry]));
        state.skipResult = null;
        state.skipSummary = null;
        if (!state.entries.length) {
          panel.setState("empty");
          return null;
        }
        panel.setState("scanned", { count: state.entries.length });
        await refreshSkips(null, signal);
        await recordScan();
        return state.entries;
      } catch (err) {
        panel.fail(signal.aborted ? "\u5DF2\u53D6\u6D88" : describe(err));
        return null;
      } finally {
        state.busy = false;
      }
    }
    async function probeSizes(list, api) {
      const controller = new AbortController();
      const fetcher = createFetcher2({ signal: controller.signal });
      const queue = list.slice();
      const width = Math.max(1, Math.min(settings.probeConcurrency || 6, queue.length));
      const report = { ok: 0, fail: 0, firstError: "" };
      function noteFailure(err) {
        report.fail += 1;
        if (report.firstError) return;
        const raw = err && err.message ? err.message : err ? String(err) : "";
        report.firstError = raw ? redactUrls(raw) : "\u63A2\u6D4B\u8BF7\u6C42\u6CA1\u6709\u8FD4\u56DE\u4F53\u79EF\uFF08\u54CD\u5E94\u7F3A\u5C11\u957F\u5EA6\uFF0C\u6216 Range \u88AB\u62D2\u7EDD\uFF09";
      }
      async function worker() {
        for (; ; ) {
          if (controller.signal.aborted) return;
          const entry = queue.shift();
          if (!entry) return;
          let size;
          try {
            size = await fetcher.probeSize(entry.url);
          } catch (err) {
            if (controller.signal.aborted) return;
            noteFailure(err);
            continue;
          }
          if (typeof size === "number") {
            report.ok += 1;
            if (isKnownSize(size) && entry.id !== null && entry.id !== void 0 && entry.id !== "") {
              state.probedSizes.set(String(entry.id), { href: entry.href, size });
            }
            api.setRowSize(entry.id, size);
          } else {
            noteFailure(null);
          }
        }
      }
      const workers = [];
      for (let i = 0; i < width; i += 1) workers.push(worker());
      await Promise.all(workers);
      if (report.fail > 0) console.warn("[bbdl] \u4F53\u79EF\u63A2\u6D4B\u5931\u8D25", { fail: report.fail, reason: report.firstError });
      return report;
    }
    async function startDownload() {
      if (state.busy || !state.entries.length) return null;
      state.autoResumeUsed = 0;
      state.autoResumeMax = autoResumeLimit();
      state.pickHandle = null;
      abortPick();
      let summary = state.skipSummary;
      if (!summary) summary = await refreshSkips(null, null);
      let choice;
      const restoration = silentResume;
      if (restoration) {
        const selected = Array.isArray(restoration.selectedIds) ? new Set(restoration.selectedIds) : null;
        silentResume = false;
        choice = {
          entries: selected ? state.entries.filter((entry) => selected.has(entryIdOf2(entry))) : state.entries,
          dirHandle: state.resumeHandle || null,
          expectedBytes: 0,
          skipExisting: true
        };
      } else {
        try {
          choice = await openSelectDialog2(state.entries, {
            document: doc,
            settings,
            // 勾选记忆按 (courseId, pageId) 分桶：换课程不串台，同一门课来回切各自保留。
            courseId,
            pageId: contentId,
            // 续接上次目录时不再弹选择器：直接把这个已授权的句柄交回去。
            pickDirectory: state.resumeHandle ? function() {
              return state.resumeHandle;
            } : pickDirectory2,
            skipInfo: summary,
            onProbeSizes: probeSizes,
            // 选目录走回调：对话框只负责把点击原样转过来，用户手势不能跨 await。
            onPickDirectory: pickDirectoryForDialog,
            onRefreshSkips: refreshDialogSkips,
            onClose: abortPick,
            onSettingsChange(patch) {
              Object.assign(settings, saveSettings(patch));
            }
          });
        } catch (err) {
          panel.fail(describe(err));
          return null;
        }
      }
      if (!choice || !Array.isArray(choice.entries)) return null;
      if (!choice.entries.length) {
        clearIntent();
        return null;
      }
      state.batchOk.clear();
      state.batchFailed.clear();
      state.selectedIds = choice.entries.map(entryIdOf2).filter(Boolean);
      const dirHandle = choice.dirHandle || null;
      state.dirHandle = dirHandle;
      state.expectedBytes = typeof choice.expectedBytes === "number" ? choice.expectedBytes : 0;
      const sinkKind = dirHandle ? "fs" : settings && settings.fallbackSink === "files" ? "download" : "zip";
      panel.setMode(sinkKind);
      panel.setNotice("");
      if (!dirHandle) {
        panel.setNotice(
          sinkKind === "download" ? "\u6CA1\u6709\u76EE\u5F55\u5199\u5165\u6743\u9650\uFF0C\u672C\u6B21\u9010\u6587\u4EF6\u4E0B\u8F7D\uFF08\u4E0D\u4FDD\u7559\u76EE\u5F55\u7ED3\u6784\uFF09\u3002" : "\u6CA1\u6709\u76EE\u5F55\u5199\u5165\u6743\u9650\uFF0C\u672C\u6B21\u6309\u6587\u4EF6\u5939\u6253\u5305\u6210 .zip \u4E0B\u8F7D\u3002"
        );
      }
      state.haltedPending = [];
      clearHaltedBanner();
      const signal = begin();
      try {
        const batch = await resolveBatch(choice, signal);
        const previousDone = new Set(restoration?.completedIds || []);
        const todo = new Set(batch);
        const rows = [];
        for (const entry of choice.entries) {
          if (todo.has(entry)) rows.push(entry);
          else if (previousDone.has(entryIdOf2(entry))) {
            state.batchOk.set(entryIdOf2(entry), entry);
            rows.push({ ...entry, status: "done" });
          }
        }
        callPanel("setFiles", rows);
        if (!batch.length) {
          clearIntent();
          panel.setNotice("\u9009\u4E2D\u7684 " + choice.entries.length + " \u4E2A\u6587\u4EF6\u90FD\u5DF2\u5B58\u5728\uFF0C\u672C\u6B21\u6CA1\u6709\u9700\u8981\u4E0B\u8F7D\u7684\u5185\u5BB9\u3002");
          panel.showSummary(resultForPanel({ aborted: false }));
          return { ok: [], failed: [], aborted: false };
        }
        state.batchPlans = buildPlans(batch);
        panel.setState("downloading");
        return await runBatchWithAutoResume(batch, dirHandle, signal);
      } catch (err) {
        panel.fail(signal.aborted ? "\u5DF2\u53D6\u6D88" : describe(err));
        return null;
      } finally {
        state.busy = false;
      }
    }
    let zeroWork = null;
    async function runDownload(entries, dirHandle, signal) {
      const sink = await createSink2({ settings, dirHandle, signal, total: entries.length, sizeOf });
      const fetcher = createFetcher2({ signal });
      console.info("[bbdl] \u5F00\u59CB\u4E0B\u8F7D", { sink: sink.kind, entries: entries.length });
      console.info("[bbdl] \u6279\u6B21\u5F00\u59CB", {
        sink: sink.kind,
        entries: entries.length,
        dirHandle: Boolean(dirHandle),
        signalAborted: Boolean(signal && signal.aborted),
        downloadConcurrency: settings && settings.downloadConcurrency
      });
      const heartbeat = startKeepAlive(fetcher, signal);
      let result;
      try {
        result = await sink.download(entries, fetcher, {
          onProgress,
          // 原样转发：事件字段由 panel 解释，这里既不裁剪也不改形状。
          onFileEvent(event) {
            if (typeof panel.applyFileEvent === "function") panel.applyFileEvent(event);
          }
        });
      } finally {
        heartbeat.stop();
      }
      console.info("[bbdl] \u6279\u6B21\u7ED3\u675F", {
        sink: sink.kind,
        ok: result && Array.isArray(result.ok) ? result.ok.length : 0,
        failed: result && Array.isArray(result.failed) ? result.failed.length : 0,
        aborted: !!(result && result.aborted),
        halted: !!(result && result.halted)
      });
      zeroWork = describeZeroWork(result, entries.length, sink.kind);
      return result;
    }
    function describeZeroWork(result, total, sinkKind) {
      if (!result || !total) return null;
      const ok = Array.isArray(result.ok) ? result.ok.length : 0;
      const failed = Array.isArray(result.failed) ? result.failed.length : 0;
      if (ok || failed || result.aborted || result.halted) return null;
      return { sink: String(sinkKind || "\u672A\u77E5"), entries: total, total };
    }
    async function finishDownload(result) {
      await flushRecords();
      const halted = result ? result.halted : null;
      state.haltedPending = rememberHalted(halted);
      const zero = zeroWork;
      zeroWork = null;
      if (zero) {
        console.error("[bbdl] zero-work", {
          sink: zero.sink,
          entries: zero.entries,
          total: zero.total,
          ok: 0,
          failed: 0,
          aborted: false,
          halted: null
        });
        panel.fail(
          "\u6CA1\u6709\u5F00\u59CB\u4EFB\u4F55\u6587\u4EF6\uFF1A\u63D0\u4EA4 " + zero.entries + " \u4E2A\u6587\u4EF6\uFF0C\u843D\u76D8\u65B9\u5F0F\uFF1A" + sinkLabel(zero.sink) + "\uFF0C\u6210\u529F 0\u3001\u5931\u8D25 0\u3002\u8BF7\u628A\u63A7\u5236\u53F0\u91CC [bbdl] \u5F00\u5934\u7684\u65E5\u5FD7\u53D1\u7ED9\u5F00\u53D1\u8005\u3002"
        );
      } else {
        panel.showSummary(resultForPanel(result));
      }
      noticePartialPackages(result);
      noticeDegraded(result);
      return result;
    }
    function waitAbortable(ms, signal) {
      return new Promise(function(resolve) {
        if (signal && signal.aborted) {
          resolve();
          return;
        }
        let timer = 0;
        let settled = false;
        function done() {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (signal && typeof signal.removeEventListener === "function") signal.removeEventListener("abort", done);
          resolve();
        }
        timer = setTimeout(done, ms);
        if (signal && typeof signal.addEventListener === "function") signal.addEventListener("abort", done, { once: true });
      });
    }
    function pendingUrl(entry) {
      if (!entry) return "";
      const raw = entry.url || entry.href || "";
      return typeof raw === "string" ? raw : "";
    }
    function startKeepAlive(fetcher, signal) {
      const idle = { start() {
      }, stop() {
      }, count() {
        return 0;
      } };
      const url = keepAliveUrl(loc && typeof loc.href === "string" ? loc.href : "");
      if (!url) return idle;
      const configured = settings ? settings.keepAliveMs : void 0;
      const intervalMs = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_KEEP_ALIVE_MS;
      const beat = createHeartbeat({
        fetcher,
        url,
        intervalMs,
        signal,
        onTick(outcome) {
          const line = { ok: Boolean(outcome && outcome.ok), at: beat.count() };
          if (outcome && outcome.sessionExpired) line.sessionExpired = true;
          console.info("[bbdl] \u4FDD\u6D3B", line);
        }
      });
      beat.start();
      return beat;
    }
    function autoResumeLimit() {
      const configured = settings ? settings.autoResumeMax : void 0;
      if (!Number.isFinite(configured) || configured < 0) return DEFAULT_AUTO_RESUME_MAX;
      return Math.floor(configured);
    }
    function autoReloadLimit() {
      const configured = settings ? settings.autoReloadMax : void 0;
      if (!Number.isFinite(configured) || configured < 0) return DEFAULT_AUTO_RELOAD_MAX;
      return Math.floor(configured);
    }
    function callPanel(name, arg) {
      try {
        if (typeof panel[name] === "function") panel[name](arg);
      } catch (err) {
      }
    }
    function pausedNotice(count) {
      return PAUSED_NOTICE_PREFIX + nonNegCount2(count) + " \u4E2A\u6587\u4EF6\u3002";
    }
    function readIntent() {
      try {
        const value = typeof intentStore.read === "function" ? intentStore.read() : null;
        return value && typeof value === "object" ? value : null;
      } catch (err) {
        return null;
      }
    }
    function writeIntent(value) {
      try {
        return typeof intentStore.write === "function" && intentStore.write(value) !== false;
      } catch (err) {
        return false;
      }
    }
    function clearIntent() {
      try {
        if (typeof intentStore.clear === "function") intentStore.clear();
      } catch (err) {
      }
    }
    let silentResume = false;
    function intentReloads(intent) {
      const n = intent ? intent.reloads : 0;
      return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    }
    async function runBatchWithAutoResume(entries, dirHandle, signal, options) {
      const opts = options || {};
      const finish = typeof opts.finish === "function" ? opts.finish : finishDownload;
      let batch = entries;
      let resumes = 0;
      let zeroProgress = 0;
      function notify2(text) {
        if (typeof panel.setNotice === "function") panel.setNotice(text);
      }
      async function settle2(result) {
        callPanel("clearRecovering");
        return await finish(result);
      }
      async function escalate(gate, pendingList, result) {
        console.info("[bbdl] \u81EA\u52A8\u91CD\u8BD5\u7194\u65AD", gate);
        if (signal && signal.aborted) {
          clearIntent();
          return await settle2(result);
        }
        if (settings.autoReload === false) {
          notify2(pausedNotice(pendingList.length));
          console.info("[bbdl] \u81EA\u52A8\u91CD\u8F7D\u5DF2\u5173\u95ED");
          return await settle2(result);
        }
        const reloads = intentReloads(readIntent());
        if (reloads >= autoReloadLimit()) {
          notify2(pausedNotice(pendingList.length));
          console.info("[bbdl] \u81EA\u52A8\u91CD\u8F7D\u5DF2\u8FBE\u4E0A\u9650", { reloads });
          clearIntent();
          return await settle2(result);
        }
        await flushRecords();
        const attempt = reloads + 1;
        const stored = writeIntent({
          courseId,
          contentId,
          selectedIds: state.selectedIds,
          completedIds: [...state.batchOk.keys()],
          pendingIds: pendingList.map(entryIdOf2).filter(function(id) {
            return Boolean(id);
          }),
          dirName: dirHandle && dirHandle.name ? String(dirHandle.name) : "",
          createdAt: now(),
          reloads: attempt
        });
        if (!stored) {
          clearIntent();
          notify2(pausedNotice(pendingList.length));
          return await settle2(result);
        }
        console.info("[bbdl] \u81EA\u52A8\u91CD\u8F7D\u7EED\u8DD1", { reloads: attempt });
        callPanel("setRecovering", { attempt });
        reload();
        return new Promise(function() {
        });
      }
      for (; ; ) {
        const result = await runDownload(batch, dirHandle, signal);
        const halted = result ? result.halted : null;
        const pendingIds = new Set((halted?.pending || []).map(entryIdOf2));
        for (const id of pendingIds) state.batchFailed.delete(id);
        for (const failure of result?.failed || []) {
          const key = entryIdOf2(failure.entry || failure) || failure;
          if (!pendingIds.has(key)) state.batchFailed.set(key, failure);
        }
        for (const entry of result?.ok || []) {
          const key = entryIdOf2(entry) || entry;
          state.batchOk.set(key, entry);
          state.batchFailed.delete(key);
        }
        const aborted = Boolean(signal && signal.aborted || result && result.aborted);
        const pending = halted && Array.isArray(halted.pending) ? halted.pending : [];
        const target = pending.length ? pendingUrl(pending[0]) : "";
        if (halted?.reason === "server-blocked") {
          clearIntent();
          notify2("\u670D\u52A1\u5668\u8FDE\u7EED\u8FD4\u56DE\u5F02\u5E38\u54CD\u5E94\uFF0C\u5DF2\u6682\u505C\uFF0C\u8BF7\u7A0D\u540E\u7EE7\u7EED\u3002");
          return await settle2(result);
        }
        if (halted) console.info("[bbdl] \u505C\u673A", { reason: halted.reason, pending: pending.length });
        if (!target || !shouldAutoResume({ halted, aborted, used: state.autoResumeUsed, max: state.autoResumeMax })) {
          if (aborted || !halted) clearIntent();
          return await settle2(result);
        }
        if (signal && signal.aborted) {
          clearIntent();
          return await settle2(result);
        }
        const ok = result && Array.isArray(result.ok) ? result.ok : [];
        if (ok.length > 0) {
          state.autoResumeUsed = 0;
          zeroProgress = 0;
        } else {
          zeroProgress += 1;
          if (zeroProgress >= 2) return await escalate({ zeroProgress, pending: pending.length }, pending, result);
        }
        if (resumes >= AUTO_RESUME_MAX_TOTAL) {
          return await escalate({ resumes, pending: pending.length }, pending, result);
        }
        await flushRecords();
        state.autoResumeUsed += 1;
        resumes += 1;
        const delay = autoResumeDelay(state.autoResumeUsed - 1);
        notify2("\u6B63\u5728\u81EA\u52A8\u6062\u590D\uFF08\u7B2C " + resumes + " \u6B21\uFF09\u2026");
        callPanel("setRecovering", { attempt: resumes });
        state.haltedPending = [];
        clearHaltedBanner();
        panel.setState("downloading");
        await wait(delay, signal);
        if (signal && signal.aborted) {
          clearIntent();
          return await settle2(result);
        }
        batch = pending;
      }
    }
    function noticePartialPackages(result) {
      const list = result && Array.isArray(result.partialPackages) ? result.partialPackages : [];
      if (!list.length || typeof panel.setNotice !== "function") return;
      let missing = 0;
      for (const pkg of list) {
        const counts = Number.isFinite(pkg && pkg.missingCount) ? Math.max(0, Math.floor(pkg.missingCount)) : null;
        const raw = pkg ? pkg.missing : null;
        const files3 = Array.isArray(raw) ? raw.length : Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
        missing += counts === null ? files3 : counts;
      }
      panel.setNotice(
        "\u672C\u6B21\u6709 " + list.length + " \u4E2A\u5305\u53EA\u4EA4\u4ED8\u4E86\u90E8\u5206\u6587\u4EF6\uFF08\u5171\u7F3A " + missing + " \u4E2A\uFF09\uFF0C\u5176\u4F59\u5DF2\u8BB0\u4E3A\u5931\u8D25\u53EF\u91CD\u8BD5\u3002"
      );
    }
    function noticeDegraded(result) {
      const degraded = result && result.degraded ? result.degraded : null;
      if (!degraded || typeof panel.setNotice !== "function") return;
      const from = Math.floor(Number(degraded.from));
      const to = Math.floor(Number(degraded.to));
      if (!Number.isFinite(from) || !Number.isFinite(to)) return;
      if (result.halted || to >= from) return;
      panel.setNotice("\u670D\u52A1\u5668\u4F3C\u4E4E\u5728\u9650\u6D41\uFF0C\u5DF2\u628A\u5E76\u53D1\u4ECE " + from + " \u964D\u5230 " + to + " \u7EE7\u7EED\u4E0B\u8F7D\u3002");
    }
    function rememberHalted(halted) {
      if (!halted) {
        clearHaltedBanner();
        return [];
      }
      const pending = Array.isArray(halted.pending) ? halted.pending.slice() : [];
      const pendingCount = Number.isFinite(halted.pendingCount) ? halted.pendingCount : pending.length;
      if (typeof panel.setHalted === "function") panel.setHalted({ reason: halted.reason, pendingCount });
      return pending;
    }
    function resultForPanel(result) {
      return { ...result, ok: [...state.batchOk.values()], failed: [...state.batchFailed.values()] };
    }
    function clearHaltedBanner() {
      if (typeof panel.clearHalted === "function") panel.clearHalted();
    }
    function resumePending() {
      if (state.busy) return null;
      const pending = state.haltedPending.slice();
      if (!pending.length) return startScan();
      state.busy = true;
      state.abort = new AbortController();
      const signal = state.abort.signal;
      state.haltedPending = [];
      clearHaltedBanner();
      state.expectedBytes = 0;
      state.batchPlans = buildPlans(pending);
      panel.setState("downloading");
      return async function() {
        try {
          return await runBatchWithAutoResume(pending, state.dirHandle, signal);
        } catch (err) {
          panel.fail(signal.aborted ? "\u5DF2\u53D6\u6D88" : describe(err));
          return null;
        } finally {
          state.busy = false;
        }
      }();
    }
    async function onRetryFailed(entries) {
      if (state.busy || !Array.isArray(entries) || !entries.length) return null;
      state.busy = true;
      state.abort = new AbortController();
      state.expectedBytes = 0;
      state.batchPlans = buildPlans(entries);
      panel.setState("downloading");
      try {
        return await runBatchWithAutoResume(entries, state.dirHandle, state.abort.signal, {
          finish(result) {
            const halted = result ? result.halted : null;
            state.haltedPending = rememberHalted(halted);
            return { ...resultForPanel(result), batchOkCount: state.batchOk.size };
          }
        });
      } finally {
        await flushRecords();
        state.busy = false;
      }
    }
    function isKnownSize(value) {
      return typeof value === "number" && Number.isFinite(value) && value > 0;
    }
    function sizeOf(entry) {
      const id = entry && entry.id !== null && entry.id !== void 0 ? String(entry.id) : "";
      if (!id) return void 0;
      const probed = state.probedSizes.get(id);
      if (probed && probed.href === entry.href) return probed.size;
      const files3 = state.manifest && typeof state.manifest.files === "object" ? state.manifest.files : null;
      const record = files3 && Object.prototype.hasOwnProperty.call(files3, id) ? files3[id] : null;
      if (record?.href && entry.href && record.href !== entry.href) return void 0;
      const size = record ? record.size : null;
      return isKnownSize(size) ? size : void 0;
    }
    function recordSizeOf(id) {
      const entry = state.entryById.get(id);
      const size = entry && typeof entry.size === "number" && Number.isFinite(entry.size) && entry.size >= 0 ? entry.size : null;
      return size;
    }
    function noteRecord(p) {
      const id = p.entryId ? String(p.entryId) : "";
      if (!id) return;
      const done = p.state === FILE_DONE;
      const record = { id, status: done ? "done" : "failed", size: recordSizeOf(id) };
      const path = done && typeof p.currentPath === "string" ? p.currentPath : "";
      if (path) {
        const at = path.lastIndexOf("/");
        record.path = path;
        record.name = at < 0 ? path : path.slice(at + 1);
      }
      state.pendingRecords.push(record);
      scheduleFlush();
    }
    let writing = Promise.resolve();
    doc?.defaultView?.addEventListener("pagehide", flushRecords);
    doc?.addEventListener?.("visibilitychange", () => {
      if (doc.visibilityState === "hidden") void flushRecords();
    });
    function scheduleFlush() {
      if (state.pendingRecords.length >= 8) {
        void flushRecords();
        return;
      }
      if (state.flushTimer) return;
      state.flushTimer = setTimeout(function() {
        state.flushTimer = 0;
        void flushRecords();
      }, MANIFEST_FLUSH_MS);
    }
    async function flushRecords() {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = 0;
      }
      const records = state.pendingRecords;
      if (!records.length) {
        await writing;
        return state.manifest;
      }
      state.pendingRecords = [];
      const now2 = Date.now();
      let updated;
      try {
        if (updateRecords2) {
          updated = updateRecords2(state.manifest, state.batchPlans, records, now2);
          if (updated) state.manifest = updated;
        }
      } catch (err) {
      }
      if (!store) return state.manifest;
      const snapshot = state.manifest;
      const completed = records.map((record) => updated?.files?.[record.id] || record);
      writing = writing.then(() => safeCall(() => {
        if (typeof store.mergeFiles === "function") return store.mergeFiles(courseId, completed);
        return store.saveManifest?.(courseId, snapshot);
      }));
      await writing;
      return state.manifest;
    }
    function pageTitle(doc2) {
      const raw = doc2 && typeof doc2.title === "string" ? doc2.title.trim() : "";
      return raw || "";
    }
    function scans() {
      return state.manifest && Array.isArray(state.manifest.scans) ? state.manifest.scans : [];
    }
    function pushHistory() {
      if (typeof panel.setHistory !== "function") return;
      panel.setHistory(scans());
    }
    function scanSnapshot() {
      const summary = state.skipSummary || {};
      return {
        at: Date.now(),
        total: state.entries.length,
        added: nonNegCount2(summary.added),
        changed: nonNegCount2(summary.changed),
        moved: nonNegCount2(summary.moved),
        unchanged: nonNegCount2(summary.unchanged),
        unknown: nonNegCount2(summary.unknown),
        stale: nonNegCount2(summary.stale),
        changedPaths: (state.skipResult?.changedPaths || []).slice(0, MAX_CHANGED_PATHS)
      };
    }
    async function recordScan() {
      if (!appendScanHistory2) return state.manifest;
      try {
        const now2 = Date.now();
        let manifest = state.manifest;
        if (updateRecords2) manifest = updateRecords2(manifest, [], [], now2) || manifest;
        state.manifest = appendScanHistory2(manifest, scanSnapshot(), MAX_SCAN_HISTORY) || manifest;
      } catch (err) {
        return state.manifest;
      }
      await saveManifestNow();
      pushHistory();
      return state.manifest;
    }
    async function saveManifestNow() {
      if (!store || typeof store.saveManifest !== "function") return state.manifest;
      try {
        await store.saveManifest(courseId, state.manifest);
      } catch (err) {
      }
      return state.manifest;
    }
    function exportManifest() {
      if (!exportManifestPack2) {
        panel.setNotice("\u5F53\u524D\u73AF\u5883\u4E0D\u652F\u6301\u5BFC\u51FA\u6E05\u5355\u3002");
        return null;
      }
      let pack = null;
      try {
        pack = exportManifestPack2({ courseId, manifest: state.manifest });
      } catch (err) {
        panel.setNotice("\u5BFC\u51FA\u5931\u8D25\uFF1A\u6E05\u5355\u6CA1\u80FD\u751F\u6210\u3002");
        return null;
      }
      const text = JSON.stringify(pack, null, 2);
      const fileName = manifestFileName(courseId);
      let anchor = null;
      try {
        const write = writeDownload || downloadTextFile;
        anchor = write(doc, text, fileName);
      } catch (err) {
        anchor = null;
      }
      const count = packFileCount(pack);
      panel.setNotice(
        anchor ? "\u5DF2\u5BFC\u51FA " + count + " \u6761\u8BB0\u5F55\u5230 " + fileName : "\u5BFC\u51FA\u6CA1\u6210\u529F\uFF1A\u5F53\u524D\u73AF\u5883\u65E0\u6CD5\u4E0B\u8F7D\u6587\u4EF6\u3002"
      );
      return { pack, text, fileName, count };
    }
    async function importManifest(file) {
      if (!importManifestPack2 || !mergeManifests2) {
        panel.setNotice("\u5F53\u524D\u73AF\u5883\u4E0D\u652F\u6301\u5BFC\u5165\u6E05\u5355\u3002");
        return null;
      }
      const fail = function(reason) {
        panel.setNotice("\u5BFC\u5165\u5931\u8D25\uFF1A" + reason);
        return null;
      };
      let text = "";
      try {
        text = file && typeof file.text === "function" ? await file.text() : "";
      } catch (err) {
        return fail("\u8BFB\u4E0D\u51FA\u8FD9\u4E2A\u6587\u4EF6");
      }
      let pack = null;
      try {
        pack = JSON.parse(text);
      } catch (err) {
        return fail("\u4E0D\u662F\u5408\u6CD5\u7684 JSON \u6587\u4EF6");
      }
      let result = null;
      try {
        result = importManifestPack2(pack, Date.now());
      } catch (err) {
        return fail("\u6E05\u5355\u6587\u4EF6\u65E0\u6CD5\u8BC6\u522B");
      }
      if (!result || result.ok !== true) return fail(result && result.error || "\u6E05\u5355\u6587\u4EF6\u65E0\u6CD5\u8BC6\u522B");
      const incoming = incomingCourses(result);
      if (!incoming.length) return fail("\u6E05\u5355\u6587\u4EF6\u91CC\u6CA1\u6709\u4EFB\u4F55\u8BFE\u7A0B");
      const picked = incoming.length === 1 ? incoming : incoming.filter((item) => String(item.courseId) === String(courseId));
      if (!picked.length) return fail("\u8FD9\u4EFD\u6E05\u5355\u91CC\u6CA1\u6709\u5F53\u524D\u8BFE\u7A0B\u7684\u8BB0\u5F55");
      let merged = state.manifest;
      let imported = 0;
      try {
        for (const item of picked) {
          imported += recordCount(item && item.manifest);
          merged = mergeManifests2(merged, item && item.manifest) || merged;
        }
      } catch (err) {
        return fail("\u6E05\u5355\u6587\u4EF6\u65E0\u6CD5\u5408\u5E76");
      }
      state.manifest = merged;
      await saveManifestNow();
      pushHistory();
      const total = recordCount(merged);
      if (incoming.length === 1) panel.setNotice("\u5DF2\u5BFC\u5165 " + imported + " \u6761\u8BB0\u5F55\uFF08\u5408\u5E76 " + total + " \u6761\uFF09");
      else panel.setNotice("\u5DF2\u5BFC\u5165 " + picked.length + " \u95E8\u8BFE\uFF08\u5408\u5E76 " + total + " \u6761\uFF09");
      return state.manifest;
    }
    function incomingCourses(result) {
      const r = result || {};
      if (Array.isArray(r.courses)) return r.courses.filter((item) => item && typeof item === "object");
      if (r.course && typeof r.course === "object") return [r.course];
      return [];
    }
    function recordCount(manifest) {
      const files3 = manifest && manifest.files && typeof manifest.files === "object" ? manifest.files : null;
      return files3 ? Object.keys(files3).length : 0;
    }
    function packFileCount(pack) {
      const courses = pack && Array.isArray(pack.courses) ? pack.courses : [];
      let total = 0;
      for (const item of courses) {
        const files3 = item && item.files && typeof item.files === "object" ? item.files : null;
        if (files3) total += Object.keys(files3).length;
      }
      return total;
    }
    function resumeLast() {
      const handle = state.savedHandle;
      if (!handle) {
        panel.setNotice("\u8FD8\u6CA1\u6709\u53EF\u7EED\u63A5\u7684\u76EE\u5F55\uFF0C\u8BF7\u7528\u300C\u9009\u62E9\u5E76\u4E0B\u8F7D\u300D\u91CD\u65B0\u9009\u4E00\u6B21\u6587\u4EF6\u5939\u3002");
        return null;
      }
      if (!ensurePermission) {
        panel.setNotice("\u5F53\u524D\u73AF\u5883\u65E0\u6CD5\u6821\u9A8C\u4E0A\u6B21\u4FDD\u5B58\u7684\u76EE\u5F55\u6743\u9650\uFF0C\u8BF7\u7528\u300C\u9009\u62E9\u5E76\u4E0B\u8F7D\u300D\u91CD\u65B0\u9009\u4E00\u6B21\u6587\u4EF6\u5939\u3002");
        return null;
      }
      let pending;
      try {
        pending = ensurePermission(handle, { request: true });
      } catch (err) {
        pending = Promise.resolve("denied");
      }
      return Promise.resolve(pending).then(
        function(status) {
          if (status === "granted") return resumeWith(handle);
          panel.setNotice(
            "\u4E0A\u6B21\u4FDD\u5B58\u7684\u76EE\u5F55\u300C" + (handle.name || "\u672A\u547D\u540D\u76EE\u5F55") + "\u300D\u6CA1\u6709\u62FF\u5230\u5199\u5165\u6743\u9650\uFF08" + permissionText(status) + "\uFF09\uFF0C\u5DF2\u9000\u56DE\u666E\u901A\u6D41\u7A0B\uFF1A\u5728\u5BF9\u8BDD\u6846\u91CC\u91CD\u65B0\u9009\u4E00\u6B21\u6587\u4EF6\u5939\u5373\u53EF\u3002"
          );
          state.resumeHandle = null;
          return startDownload();
        },
        function() {
          panel.setNotice("\u4E0A\u6B21\u4FDD\u5B58\u7684\u76EE\u5F55\u6388\u6743\u5931\u8D25\uFF0C\u5DF2\u9000\u56DE\u666E\u901A\u6D41\u7A0B\uFF1A\u5728\u5BF9\u8BDD\u6846\u91CC\u91CD\u65B0\u9009\u4E00\u6B21\u6587\u4EF6\u5939\u5373\u53EF\u3002");
          state.resumeHandle = null;
          return startDownload();
        }
      );
    }
    async function resumeWith(handle) {
      state.dirHandle = handle;
      state.resumeHandle = handle;
      rememberHandle(handle);
      if (!state.entries.length) await startScan();
      if (!state.entries.length) return null;
      return startDownload();
    }
    async function consumeIntent() {
      const intent = readIntent();
      if (!intent) return null;
      try {
        const createdAt = Number.isFinite(intent.createdAt) ? intent.createdAt : 0;
        const stale = !createdAt || now() - createdAt > INTENT_TTL_MS;
        const pendingIds = Array.isArray(intent.pendingIds) ? intent.pendingIds : [];
        const recorded = intent.courseId === null || intent.courseId === void 0 ? "" : String(intent.courseId);
        if (stale || recorded !== String(courseId) || String(intent.contentId) !== String(contentId)) {
          clearIntent();
          return null;
        }
        if (settings.autoReload === false) return null;
        const reloads = intentReloads(intent);
        console.info("[bbdl] \u91CD\u8F7D\u540E\u7EED\u8DD1", { pending: pendingIds.length, reloads });
        const handle = await safeCall(() => store ? store.loadHandle(courseId) : null);
        const status = await ensurePermissionStatus(handle, false);
        if (!handle || status !== "granted") {
          callPanel("setHalted", { reason: "session-expired", pendingCount: pendingIds.length });
          return null;
        }
        state.dirHandle = handle;
        state.resumeHandle = handle;
        if (!state.entries.length) await startScan();
        if (!state.entries.length) return null;
        silentResume = intent;
        try {
          return await startDownload();
        } finally {
          silentResume = false;
        }
      } catch (err) {
        console.warn("[bbdl] \u81EA\u52A8\u7EED\u8DD1\u5931\u8D25", { reason: err && err.message ? err.message : String(err) });
        return null;
      }
    }
    function getState() {
      return {
        courseId,
        contentId,
        entries: state.entries,
        plans: state.plans,
        entryById: state.entryById,
        busy: state.busy,
        dirHandle: state.dirHandle,
        savedHandle: state.savedHandle,
        resumeHandle: state.resumeHandle,
        expectedBytes: state.expectedBytes,
        manifest: state.manifest,
        skip: state.skipResult,
        skipSummary: state.skipSummary,
        pendingRecords: state.pendingRecords,
        diskChecked: state.diskChecked,
        diskTruncated: state.diskTruncated,
        /** 停机快照（给「刷新后继续」用）；非停机状态一律空数组。 */
        haltedPending: state.haltedPending,
        /** 扫描历史（newest first）：面板与验收都只看这一份。 */
        scans: scans()
      };
    }
    return {
      startScan,
      startDownload,
      onRetryFailed,
      resumePending,
      getState,
      ready,
      /** 重载后自动续跑的那一跳：ready 之后才 resolve，永不 reject。 */
      resumeIntent,
      panel,
      flushRecords,
      exportManifest,
      importManifest
    };
  }
  async function loadContractModules() {
    const [db, permissions, planning, manifestMod] = await Promise.all([
      Promise.resolve().then(() => (init_db(), db_exports)),
      Promise.resolve().then(() => (init_permissions(), permissions_exports)),
      Promise.resolve().then(() => (init_manifest_plan(), manifest_plan_exports)),
      Promise.resolve().then(() => (init_manifest(), manifest_exports))
    ]);
    return {
      store: typeof db.makeStore === "function" ? db.makeStore({ indexedDB: globalThis.indexedDB }) : null,
      deps: {
        planSkips: planning.planSkips,
        updateRecords: manifestMod.updateRecords,
        appendScanHistory: manifestMod.appendScanHistory,
        exportManifestPack: manifestMod.exportManifestPack,
        importManifestPack: manifestMod.importManifestPack,
        mergeManifests: manifestMod.mergeManifests,
        ensureDirectoryPermission: permissions.ensureDirectoryPermission
      }
    };
  }
  async function mount() {
    let extra = { store: null, deps: {} };
    try {
      extra = await loadContractModules();
    } catch (err) {
      extra = { store: null, deps: {} };
    }
    return createController({
      store: extra.store,
      listExistingFiles,
      pickDirectory,
      openSelectDialog,
      mountPanel,
      settings: loadSettings(),
      location: typeof location === "undefined" ? null : location,
      document: typeof document === "undefined" ? null : document,
      deps: extra.deps
    });
  }
  function startWhenReady() {
    if (typeof document === "undefined") return;
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function() {
        void mount();
      }, { once: true });
    } else {
      void mount();
    }
  }
  if (typeof location !== "undefined" && typeof location.href === "string" && location.href.includes("listContent.jsp")) {
    startWhenReady();
  }
})();
