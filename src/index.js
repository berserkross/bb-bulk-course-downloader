import { createFetcher as defaultCreateFetcher, SessionExpiredError } from './bb/http.js';
import { createScanner as defaultCreateScanner } from './bb/scan.js';
import {
  createSink as defaultCreateSink,
  listExistingFiles as defaultListExistingFiles,
  pickDirectory as defaultPickDirectory
} from './sinks/index.js';
import { planBatch } from './sinks/shared.js';
import { buildEntryPath, dedupePaths, sanitizeSegment } from './bb/files.js';
import { loadSettings, saveSettings } from './store.js';
import { mountPanel as defaultMountPanel } from './ui/panel.js';
import { openSelectDialog as defaultOpenSelectDialog } from './ui/select.js';

/** files.js 是纯函数模块：注入给 planBatch，不让它自己去 import（与 sinks 的分层保持一致）。 */
const files = { buildEntryPath, sanitizeSegment, dedupePaths };

/** sink 只在这两个状态上代表「一个文件结束了」，清单记录也只在这两处写。 */
const FILE_DONE = 'file-done';
const FILE_FAILED = 'file-failed';

/** 清单落库节流：500ms 内的多条记录合并成一次写库，避免每个文件一次事务。 */
const MANIFEST_FLUSH_MS = 500;

const PERMISSION_TEXT = {
  prompt: '浏览器还需要你再确认一次目录权限',
  denied: '浏览器拒绝了目录权限',
  unsupported: '当前环境拿不到目录句柄'
};

export function currentIds(loc) {
  const href = String((loc && loc.href) || '');
  try {
    const params = new URL(href).searchParams;
    return { courseId: params.get('course_id'), contentId: params.get('content_id') };
  } catch (err) {
    return { courseId: null, contentId: null };
  }
}

function describe(err) {
  if (err instanceof SessionExpiredError) return '会话已失效：请重新登录 Blackboard，然后刷新本页再试。';
  return (err && err.message) || String(err);
}

function permissionText(status) {
  return PERMISSION_TEXT[status] || '目录权限不可用';
}

/** skipInfo 的空形状：UI 在没有清单也没有磁盘对照时也只需要这一份结构。 */
function emptySummary() {
  return {
    total: 0,
    disk: 0,
    manifest: 0,
    unverified: 0,
    byId: new Map(),
    truncated: false,
    diskChecked: false,
    added: 0,
    changed: 0,
    unchanged: 0,
    stale: 0
  };
}

/**
 * 全部依赖从参数进来，模块默认值由文件末尾的默认接线提供。
 *
 * deps 里放的是「契约模块 + 网络/sink 工厂」：planSkips / updateRecords /
 * ensureDirectoryPermission 由 src/store/* 提供，createFetcher / createScanner /
 * createSink 平时用真实实现，单测换成假对象即可脱离网络与文件系统跑。
 */
export function createController(config) {
  const cfg = config || {};
  const loc = cfg.location || (typeof location === 'undefined' ? null : location);
  const doc = cfg.document || (typeof document === 'undefined' ? null : document);
  const store = cfg.store || null;
  const settings = cfg.settings || {};
  const deps = cfg.deps || {};

  const createFetcher = typeof deps.createFetcher === 'function' ? deps.createFetcher : defaultCreateFetcher;
  const createScanner = typeof deps.createScanner === 'function' ? deps.createScanner : defaultCreateScanner;
  const createSink = typeof deps.createSink === 'function' ? deps.createSink : defaultCreateSink;
  const planSkips = typeof deps.planSkips === 'function' ? deps.planSkips : null;
  const updateRecords = typeof deps.updateRecords === 'function' ? deps.updateRecords : null;
  const ensurePermission = typeof deps.ensureDirectoryPermission === 'function' ? deps.ensureDirectoryPermission : null;

  const listExistingFiles = typeof cfg.listExistingFiles === 'function' ? cfg.listExistingFiles : defaultListExistingFiles;
  const pickDirectory = typeof cfg.pickDirectory === 'function' ? cfg.pickDirectory : defaultPickDirectory;
  const openSelectDialog = typeof cfg.openSelectDialog === 'function' ? cfg.openSelectDialog : defaultOpenSelectDialog;
  const mountPanel = typeof cfg.mountPanel === 'function' ? cfg.mountPanel : defaultMountPanel;

  const { courseId, contentId } = currentIds(loc);
  // 与改造前一致：不是内容列表页（拿不到 course_id + content_id）就什么都不挂。
  if (!courseId || !contentId) return null;

  const state = {
    entries: [],
    plans: [],
    entryById: new Map(),
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
    diskChecked: false,
    diskTruncated: false,
    pendingRecords: [],
    flushTimer: 0,
    batchPlans: []
  };

  const panel = mountPanel({
    document: doc,
    settings,
    onSettingsChange(patch) {
      Object.assign(settings, saveSettings(patch));
    },
    onScan: startScan,
    onDownload: startDownload,
    onRetryFailed,
    onResume: resumeLast,
    onCancel() {
      if (state.abort) state.abort.abort();
    }
  });

  /** 上次的目录句柄 + 清单一起恢复；失败一律当「没有」处理，绝不拦住面板。 */
  const ready = hydrate();

  async function safeCall(fn) {
    try {
      return await fn();
    } catch (err) {
      return null;
    }
  }

  async function hydrate() {
    const manifest = await safeCall(() => (store ? store.loadManifest(courseId) : null));
    if (manifest) state.manifest = manifest;

    const handle = await safeCall(() => (store ? store.loadHandle(courseId) : null));
    if (!handle) return;
    state.savedHandle = handle;
    const status = await ensurePermissionStatus(handle, false);
    panel.setResume({ dirName: handle.name || '上次的目录', granted: status === 'granted' });
  }

  /** request=false 只查询，request=true 必须由调用方保证落在用户手势的同步栈里。 */
  async function ensurePermissionStatus(handle, request) {
    if (!handle || !ensurePermission) return 'unsupported';
    const status = await safeCall(() => ensurePermission(handle, { request: request }));
    return status || 'unsupported';
  }

  /**
   * 分母由 UI 提供：sink 报 bytesTotal === 0（总量未知）时，只有当对话框里
   * 每个已选文件体积都探测过，才拿它们的和补上，其余情况一概保持未知。
   */
  function withExpectedTotal(payload) {
    const p = payload || {};
    const total = pickTotal(p);
    if (total > 0 || !(state.expectedBytes > 0)) return p;
    return Object.assign({}, p, { bytesTotal: state.expectedBytes });
  }

  function pickTotal(p) {
    const v = typeof p.bytesTotal === 'number' ? p.bytesTotal : 0;
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

  function buildPlans(entries) {
    return planBatch(entries, { preserveTree: settings.preserveTree !== false, files: files });
  }

  /* ---------------- 跳过集合 ---------------- */

  async function readExistingPaths(dirHandle, signal) {
    const empty = { paths: new Map(), checked: false, truncated: false };
    if (!dirHandle || typeof listExistingFiles !== 'function') return empty;
    const status = await ensurePermissionStatus(dirHandle, false);
    if (status !== 'granted') return empty;
    try {
      const found = await listExistingFiles(dirHandle, { signal: signal });
      if (!(found instanceof Map)) return empty;
      return { paths: found, checked: true, truncated: !!found.truncated };
    } catch (err) {
      return empty;
    }
  }

  async function computeSkips(dirHandle, signal) {
    const plans = buildPlans(state.entries);
    state.plans = plans;

    let manifest = state.manifest;
    if (!manifest) {
      manifest = await safeCall(() => (store ? store.loadManifest(courseId) : null));
      if (manifest) state.manifest = manifest;
    }

    const existing = await readExistingPaths(dirHandle, signal);
    state.diskChecked = existing.checked;
    state.diskTruncated = existing.truncated;
    state.skipDirHandle = dirHandle || null;

    const preserveTree = settings.preserveTree !== false;
    const result = planSkips
      ? planSkips({ plans: plans, manifest: manifest || null, existingPaths: existing.paths, preserveTree: preserveTree })
      : { todo: plans, skip: [], stale: [], diff: { added: plans.length, changed: 0, unchanged: 0, stale: 0, total: plans.length } };

    state.skipResult = result;
    state.skipSummary = summarize(result);
    return result;
  }

  /** planSkips 的结果 → 对话框要的那一份扁平结构（按 entry.id 索引原因，供行内灰标）。 */
  function summarize(result) {
    const summary = emptySummary();
    const skip = Array.isArray(result && result.skip) ? result.skip : [];
    for (const item of skip) {
      const plan = item && item.plan;
      const id = plan && plan.entry ? plan.entry.id : null;
      if (!id) continue;
      summary.byId.set(id, { reason: item.reason, size: item.size == null ? null : item.size });
      if (item.reason === 'disk') summary.disk += 1;
      else if (item.reason === 'disk-unverified') {
        summary.disk += 1;
        summary.unverified += 1;
      } else summary.manifest += 1;
    }
    summary.total = summary.byId.size;
    summary.truncated = !!state.diskTruncated;
    summary.diskChecked = !!state.diskChecked;

    const diff = (result && result.diff) || {};
    summary.added = Number(diff.added) || 0;
    summary.changed = Number(diff.changed) || 0;
    summary.unchanged = Number(diff.unchanged) || 0;
    summary.stale = Number(diff.stale) || 0;
    return summary;
  }

  async function refreshSkips(preferredHandle, signal) {
    const handle = preferredHandle || state.resumeHandle || state.savedHandle || null;
    await computeSkips(handle, signal);
    if (state.diskTruncated) {
      panel.setNotice('目录里的文件太多，本次只比对了前面一部分；「跳过已存在」的判断可能不完整。');
    }
    return state.skipSummary;
  }

  /** 真正提交给 sink 的集合：勾选「跳过已存在」时取「用户选中 ∩ todo」，否则原样放行。 */
  async function resolveBatch(choice, signal) {
    const chosen = choice.entries;
    if (choice.skipExisting === false) return chosen;

    const dirHandle = choice.dirHandle || null;
    let result = state.skipResult;
    // 扫描时用的是「上次的目录」；用户在对话框里换了目录就必须按新目录重算，否则会多下或漏下。
    if (!result || state.skipDirHandle !== (dirHandle || null)) {
      result = await computeSkips(dirHandle, signal);
    }

    const todoIds = new Set();
    const todo = Array.isArray(result.todo) ? result.todo : [];
    for (const plan of todo) {
      if (plan && plan.entry && plan.entry.id) todoIds.add(plan.entry.id);
    }
    return chosen.filter((entry) => todoIds.has(entry.id));
  }

  /* ---------------- 扫描 ---------------- */

  async function startScan() {
    if (state.busy) return null;
    const signal = begin();
    panel.setState('scanning');
    panel.setNotice('');
    try {
      const fetcher = createFetcher({ signal: signal });
      const scanner = createScanner({
        fetcher,
        rootUrl: (loc && loc.href) || '',
        onProgress: (p) => panel.setScanProgress(p)
      });
      const entries = await scanner.scan();
      state.entries = Array.isArray(entries) ? entries : [];
      state.entryById = new Map(state.entries.filter(Boolean).map((entry) => [entry.id, entry]));
      state.skipResult = null;
      state.skipSummary = null;
      if (!state.entries.length) {
        panel.setState('empty');
        return null;
      }
      panel.setState('scanned', { count: state.entries.length });
      // 契约：扫描完成后按「当前 plans + 清单 + 磁盘现状」算一次，结果交给对话框。
      await refreshSkips(null, signal);
      return state.entries;
    } catch (err) {
      panel.fail(signal.aborted ? '已取消' : describe(err));
      return null;
    } finally {
      state.busy = false;
    }
  }

  // 体积靠 Range: bytes=0-0 单独探测，绝不为此下载文件本体。
  // 只在对话框打开时按需触发，且有界并发，避免 300 个文件瞬间打 300 个请求。
  async function probeSizes(list, api) {
    const controller = new AbortController();
    const fetcher = createFetcher({ signal: controller.signal });
    const queue = list.slice();
    const width = Math.max(1, Math.min(settings.probeConcurrency || 6, queue.length));

    async function worker() {
      for (;;) {
        if (controller.signal.aborted) return;
        const entry = queue.shift();
        if (!entry) return;
        const size = await fetcher.probeSize(entry.url);
        if (typeof size === 'number') api.setRowSize(entry.id, size);
      }
    }

    await Promise.all(Array.from({ length: width }, worker));
    return controller;
  }

  /* ---------------- 下载 ---------------- */

  async function startDownload() {
    if (state.busy || !state.entries.length) return null;

    let summary = state.skipSummary;
    if (!summary) summary = await refreshSkips(null, null);

    let choice;
    try {
      choice = await openSelectDialog(state.entries, {
        document: doc,
        settings,
        // 续接上次目录时不再弹选择器：直接把这个已授权的句柄交回去。
        pickDirectory: state.resumeHandle ? function () { return state.resumeHandle; } : pickDirectory,
        skipInfo: summary,
        onProbeSizes: probeSizes,
        onSettingsChange(patch) {
          Object.assign(settings, saveSettings(patch));
        }
      });
    } catch (err) {
      panel.fail(describe(err));
      return null;
    }
    if (!choice || !Array.isArray(choice.entries) || !choice.entries.length) return null;

    const dirHandle = choice.dirHandle || null;
    state.dirHandle = dirHandle;
    state.expectedBytes = typeof choice.expectedBytes === 'number' ? choice.expectedBytes : 0;
    panel.setMode(dirHandle ? 'fs' : 'download');
    panel.setNotice('');

    const signal = begin();
    try {
      const batch = await resolveBatch(choice, signal);
      if (!batch.length) {
        panel.setNotice('选中的 ' + choice.entries.length + ' 个文件都已存在，本次没有需要下载的内容。');
        panel.showSummary({ ok: [], failed: [], aborted: false });
        return { ok: [], failed: [], aborted: false };
      }
      state.batchPlans = buildPlans(batch);
      panel.setState('downloading');
      const result = await runDownload(batch, dirHandle, signal);
      await flushRecords();
      panel.showSummary(result);
      return result;
    } catch (err) {
      panel.fail(signal.aborted ? '已取消' : describe(err));
      return null;
    } finally {
      state.busy = false;
    }
  }

  async function runDownload(entries, dirHandle, signal) {
    const sink = await createSink({ settings, dirHandle, signal, total: entries.length });
    const fetcher = createFetcher({ signal });
    return sink.download(entries, fetcher, { onProgress });
  }

  /** 失败项重试：同一套目录句柄与并发设置，只是一次跑更少的文件。 */
  async function onRetryFailed(entries) {
    if (state.busy || !Array.isArray(entries) || !entries.length) return null;
    state.busy = true;
    state.abort = new AbortController();
    // 重试批次的分母和首轮不同，宁可报「总量未知」也不拿首轮的数字冒充。
    state.expectedBytes = 0;
    state.batchPlans = buildPlans(entries);
    panel.setState('downloading');
    try {
      return await runDownload(entries, state.dirHandle, state.abort.signal);
    } finally {
      await flushRecords();
      state.busy = false;
    }
  }

  /* ---------------- 清单写回 ---------------- */

  function sizeOf(id) {
    const entry = state.entryById.get(id);
    const size = entry && typeof entry.size === 'number' && Number.isFinite(entry.size) && entry.size >= 0 ? entry.size : null;
    // 契约：体积未知写 null，绝不写 0（0 会让 planSkips 误判成「磁盘上是空文件」）。
    return size;
  }

  function noteRecord(p) {
    const id = p.entryId ? String(p.entryId) : '';
    if (!id) return;
    state.pendingRecords.push({ id: id, status: p.state === FILE_DONE ? 'done' : 'failed', size: sizeOf(id) });
    scheduleFlush();
  }

  function scheduleFlush() {
    if (state.flushTimer) return;
    state.flushTimer = setTimeout(function () {
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
    if (!records.length) return state.manifest;
    state.pendingRecords = [];

    const now = Date.now();
    try {
      if (updateRecords) {
        // 纯函数合并只更新内存：下一次算跳过立刻能用到最新状态。
        state.manifest = updateRecords(state.manifest, state.batchPlans, records, now) || state.manifest;
      }
    } catch (err) {
      /* 合并失败也要继续落库：清单持久化走 store.mergeFiles，下一次照样能据此跳过。 */
    }

    if (!store) return state.manifest;
    try {
      if (typeof store.mergeFiles === 'function') await store.mergeFiles(courseId, records);
      else if (typeof store.saveManifest === 'function') await store.saveManifest(courseId, state.manifest);
    } catch (err) {
      /* 清单落库失败不影响下载结果：最多下次多下一次。 */
    }
    return state.manifest;
  }

  /* ---------------- 继续上次 ---------------- */

  /**
   * 「继续上次」的点击处理器。
   * 铁律：ensurePermission(handle, { request: true }) 必须是本函数第一个动作 ——
   * 这一行之前不得出现 await（哪怕已 resolve 的 promise 也会让用户手势过期）。
   */
  function resumeLast() {
    const handle = state.savedHandle;
    if (!handle) {
      panel.setNotice('还没有可续接的目录，请用「选择并下载」重新选一次文件夹。');
      return null;
    }
    if (!ensurePermission) {
      panel.setNotice('当前环境无法校验上次保存的目录权限，请用「选择并下载」重新选一次文件夹。');
      return null;
    }

    let pending;
    try {
      pending = ensurePermission(handle, { request: true });
    } catch (err) {
      pending = Promise.resolve('denied');
    }

    return Promise.resolve(pending).then(
      function (status) {
        if (status === 'granted') return resumeWith(handle);
        panel.setNotice(
          '上次保存的目录「' + (handle.name || '未命名目录') + '」没有拿到写入权限（' + permissionText(status) + '），' +
            '已退回普通流程：在对话框里重新选一次文件夹即可。'
        );
        state.resumeHandle = null;
        return startDownload();
      },
      function () {
        panel.setNotice('上次保存的目录授权失败，已退回普通流程：在对话框里重新选一次文件夹即可。');
        state.resumeHandle = null;
        return startDownload();
      }
    );
  }

  /** 授权成功：直接走「扫描 + 只下缺的」，不再让用户重选目录。 */
  async function resumeWith(handle) {
    state.dirHandle = handle;
    state.resumeHandle = handle;
    if (!state.entries.length) await startScan();
    if (!state.entries.length) return null;
    return startDownload();
  }

  function getState() {
    return {
      courseId: courseId,
      contentId: contentId,
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
      diskTruncated: state.diskTruncated
    };
  }

  return { startScan, startDownload, onRetryFailed, getState, ready, panel, flushRecords };
}

/**
 * 默认接线：真实模块 + 浏览器全局。
 * store 的四个模块用动态 import：契约模块缺失时面板仍能起来（降级成「只能按清单跳过」），
 * 而不是整条 userscript 直接白屏。
 */
async function loadContractModules() {
  const [db, permissions, planning, manifestMod] = await Promise.all([
    import('./store/db.js'),
    import('./store/permissions.js'),
    import('./store/manifest-plan.js'),
    import('./store/manifest.js')
  ]);
  return {
    store: typeof db.makeStore === 'function' ? db.makeStore({ indexedDB: globalThis.indexedDB }) : null,
    deps: {
      planSkips: planning.planSkips,
      updateRecords: manifestMod.updateRecords,
      ensureDirectoryPermission: permissions.ensureDirectoryPermission
    }
  };
}

export async function mount() {
  let extra = { store: null, deps: {} };
  try {
    extra = await loadContractModules();
  } catch (err) {
    extra = { store: null, deps: {} };
  }
  return createController({
    store: extra.store,
    listExistingFiles: defaultListExistingFiles,
    pickDirectory: defaultPickDirectory,
    openSelectDialog: defaultOpenSelectDialog,
    mountPanel: defaultMountPanel,
    settings: loadSettings(),
    location: typeof location === 'undefined' ? null : location,
    document: typeof document === 'undefined' ? null : document,
    deps: extra.deps
  });
}

function startWhenReady() {
  if (typeof document === 'undefined') return;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { void mount(); }, { once: true });
  } else {
    void mount();
  }
}

if (typeof location !== 'undefined' && typeof location.href === 'string' && location.href.includes('listContent.jsp')) {
  startWhenReady();
}
