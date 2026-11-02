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

/** 无 FSA 的体积闸值：超过就提醒「只能逐个交给浏览器」。只按「全部已知」判断，绝不拿未知凑合计。 */
const NO_FSA_HINT_BYTES = 500 * 1024 * 1024;

/** 落盘层参数只补默认值（不新增 UI 控件）：用户在面板里能看到的两项不在此列。 */
const SINK_DEFAULTS = { idleTimeoutMs: 30000, fileRetries: 1, serializeOverBytes: 48 * 1024 * 1024 };

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

/** diff 的计数一律归一化成非负整数：老版本 planSkips 缺键时按 0 算，绝不让 undefined 漏进 UI。 */
function nonNegCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * stale 只做展示：契约里它是 { id, path }，这里逐条浅拷贝一份 ——
 * 对话框不该拿着 planSkips 的活引用，也不该顺手把 entry.href 之类的指纹带进 DOM。
 */
function staleListOf(result) {
  const stale = Array.isArray(result && result.stale) ? result.stale : [];
  const out = [];
  for (const item of stale) {
    if (!item) continue;
    out.push({
      id: item.id === null || item.id === undefined ? '' : String(item.id),
      path: item.path === null || item.path === undefined ? '' : String(item.path)
    });
  }
  return out;
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

/** 只补缺失/非有限数字的键：用户既有设置（含面板可改的）一个都不覆盖。 */
function applySinkDefaults(target) {
  for (const key of Object.keys(SINK_DEFAULTS)) {
    const value = target[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) target[key] = SINK_DEFAULTS[key];
  }
  return target;
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
  const settings = applySinkDefaults(cfg.settings || {});
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
    probedSizes: new Map(),
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
   * 记住这次选定的目录：面板立刻变成「可续接」，句柄异步落 IndexedDB。
   * - 只吞掉写失败：记不住最多下次重选，绝不能拦住下载（fire-and-forget，不占同步栈）。
   * - 权限没拿到（denied / prompt / unsupported）时既不清也不写：Chrome 的授权是会话级的，
   *   句柄本身仍然有效，下一次「继续上次」正是重新授权的入口，clear 掉才是真的把路堵死。
   */
  function rememberHandle(handle) {
    if (!handle) return;
    state.savedHandle = handle;
    try {
      panel.setResume({ dirName: handle.name || '上次的目录', granted: true });
    } catch (err) {
      /* 面板不在也不影响「这次选过哪个目录」这件事 */
    }
    if (!store || typeof store.saveHandle !== 'function') return;
    void safeCall(() => store.saveHandle(courseId, handle));
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

  /**
   * 目录枚举带缓存：同一个句柄只扫一次盘（对话框里判一次、下载前判一次是同一份结果）。
   * 取消中的结果一律不写回 —— 把「没比对成」记成「磁盘上一个都没有」会让用户白下整批。
   */
  async function existingSnapshot(dirHandle, signal, force) {
    const empty = { paths: new Map(), checked: false, truncated: false };
    const handle = dirHandle || null;
    if (!force && state.existingHas && state.existingHandle === handle) {
      return { paths: state.existingPaths, checked: state.existingChecked, truncated: state.existingTruncated };
    }
    const remember = function (paths, checked, truncated) {
      state.existingPaths = paths;
      state.existingHandle = handle;
      state.existingHas = true;
      state.existingChecked = checked;
      state.existingTruncated = truncated;
    };

    if (!handle || typeof listExistingFiles !== 'function') {
      if (!(signal && signal.aborted)) remember(empty.paths, false, false);
      return empty;
    }
    const status = await ensurePermissionStatus(handle, false);
    if (status !== 'granted' || (signal && signal.aborted)) return empty;
    try {
      const found = await listExistingFiles(handle, { signal: signal });
      if (!(found instanceof Map) || (signal && signal.aborted)) return empty;
      const truncated = !!found.truncated;
      remember(found, true, truncated);
      return { paths: found, checked: true, truncated: truncated };
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
      manifest = await safeCall(() => (store ? store.loadManifest(courseId) : null));
      if (manifest) state.manifest = manifest;
    }

    const existing = await existingSnapshot(dirHandle, signal, opts.force === true);
    // 取消 / 换目录之后的比对：一个字段都不写。调用方拿到 null 就知道「这份摘要不成立」。
    if (signal && signal.aborted) return null;
    state.diskChecked = existing.checked;
    state.diskTruncated = existing.truncated;
    state.skipDirHandle = dirHandle || null;

    const preserveTree = settings.preserveTree !== false;
    state.skipPreserveTree = preserveTree;
    const result = planSkips
      ? planSkips({
          plans: plans,
          manifest: manifest || null,
          existingPaths: existing.paths,
          preserveTree: preserveTree,
          // 契约 §4：本轮有文件夹扫失败 → 清单证据一律降级 unknown，绝不拿「可能变了」的东西冒充未变。
          scanFailed: nonNegCount(state.scanFailures) > 0
        })
      : {
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
      } else {
        // 清单命中：'manifest-unchanged' 再单独记一笔，否则「上游未变」和「磁盘已经有」在 UI 上分不开。
        summary.manifest += 1;
        if (item.reason === 'manifest-unchanged') summary.manifestUnchanged += 1;
      }
    }
    summary.total = summary.byId.size;
    summary.truncated = !!state.diskTruncated;
    summary.diskChecked = !!state.diskChecked;

    const diff = (result && result.diff) || {};
    summary.added = nonNegCount(diff.added);
    summary.changed = nonNegCount(diff.changed);
    summary.moved = nonNegCount(diff.moved);
    summary.unchanged = nonNegCount(diff.unchanged);
    summary.unknown = nonNegCount(diff.unknown);
    summary.stale = nonNegCount(diff.stale);
    summary.staleList = staleListOf(result);
    summary.scanFailures = nonNegCount(state.scanFailures);
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
    // 扫描时用的是「上次的目录」；用户在对话框里换了目录（或改了目录结构）就必须重算，
    // 否则会多下或漏下。句柄没变时 computeSkips 命中快照缓存，不会重复扫盘。
    const preserveTree = settings.preserveTree !== false;
    if (!result || state.skipDirHandle !== (dirHandle || null) || state.skipPreserveTree !== preserveTree) {
      result = await computeSkips(dirHandle, signal);
    }
    // 比对被取消：按用户选中放行，且绝不假装「一个都不存在」。
    if (!result) return chosen;

    const todoIds = new Set();
    const todo = Array.isArray(result.todo) ? result.todo : [];
    for (const plan of todo) {
      if (plan && plan.entry && plan.entry.id) todoIds.add(plan.entry.id);
    }
    return chosen.filter((entry) => todoIds.has(entry.id));
  }

  /* ---------------- 对话框里选目录 ---------------- */

  function abortPick() {
    const controller = state.pickAbort;
    state.pickAbort = null;
    if (!controller) return;
    try {
      controller.abort();
    } catch (err) {
      // 取消只是「别再扫了」，失败没有后果
    }
  }

  async function afterPick(handle, permission, signal, report) {
    const name = (handle && handle.name) || '所选目录';
    report.setHint('正在比对磁盘…');

    let status = 'unsupported';
    if (permission) status = (await permission) || 'unsupported';
    else status = await ensurePermissionStatus(handle, false);
    if (signal.aborted) return { cancelled: true };

    if (status !== 'granted') {
      // 拿不到写入权限：先退回「只按清单跳过」的口径，让摘要与最终交给 sink 的判断一致。
      state.pickHandle = null;
      const fallback = await computeSkips(null, signal, { force: true });
      if (signal.aborted || !fallback) return { cancelled: true };
      return { status: status, dirHandle: null, name: name, skipInfo: state.skipSummary };
    }

    state.pickHandle = handle;
    const result = await computeSkips(handle, signal, { force: true });
    if (signal.aborted || !result) return { cancelled: true };
    // 授权拿到手才算「这个目录真的能用」：到这里才记住它，「继续上次」下次才有入口。
    rememberHandle(handle);
    return { status: 'granted', dirHandle: handle, name: name, skipInfo: state.skipSummary };
  }

  /**
   * 对话框「选择保存位置…」的全部流程。
   * 铁律：pickDirectory 与 ensureDirectoryPermission({ request: true }) 都必须留在用户点击的
   * 同一个同步栈里 —— 函数体在第一个 await 之前就把这两件事发出去了。
   */
  function pickDirectoryForDialog(api) {
    const report = api && typeof api.setHint === 'function' ? api : { setHint: function () {} };
    abortPick();
    const controller = new AbortController();
    state.pickAbort = controller;
    const signal = controller.signal;

    let picked;
    try {
      // 这一行直接跑在 click 事件处理里，前面不许有 await
      picked = pickDirectory({ signal: signal });
    } catch (err) {
      state.pickAbort = null;
      return Promise.resolve({ failed: describe(err) });
    }

    // 续接上次目录时给的是现成句柄（不是 Promise）：权限请求同样留在这一栈里发出去。
    if (picked && typeof picked.then !== 'function') {
      return afterPick(picked, ensurePermissionStatus(picked, true), signal, report);
    }

    return Promise.resolve(picked).then(
      function (handle) {
        if (!handle) return { cancelled: true };
        return afterPick(handle, null, signal, report);
      },
      function (err) {
        // 用户在系统选择器里按了取消、或浏览器拒绝：都不算失败。
        if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) return { cancelled: true };
        return { failed: describe(err) };
      }
    );
  }

  /** 对话框里改了「保留原始目录结构」：路径全变，摘要要重算；同一句柄走快照缓存，不重扫盘。 */
  async function refreshDialogSkips() {
    const handle = state.pickHandle || state.dirHandle || state.resumeHandle || null;
    const signal = state.pickAbort ? state.pickAbort.signal : null;
    const result = await computeSkips(handle, signal, { force: false });
    return result ? state.skipSummary : null;
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
      // 先取失败文件夹数的快照：扫描器的 failures 是 getter，留着活引用等于留下一个会自己变的数字。
      state.scanFailures = scanner && Array.isArray(scanner.failures) ? scanner.failures.length : 0;
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
        if (typeof size === 'number') {
          // 探测结果先落进控制器自己的索引：对话框关闭后它才是落盘层的体积来源。
          if (isKnownSize(size) && entry.id !== null && entry.id !== undefined && entry.id !== '') {
            state.probedSizes.set(String(entry.id), size);
          }
          api.setRowSize(entry.id, size);
        }
      }
    }

    await Promise.all(Array.from({ length: width }, worker));
    return controller;
  }

  /* ---------------- 下载 ---------------- */

  async function startDownload() {
    if (state.busy || !state.entries.length) return null;
    // 上一轮对话框里选过的目录不能带进来：这次以用户新选的为准。
    state.pickHandle = null;
    abortPick();

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
    if (!choice || !Array.isArray(choice.entries) || !choice.entries.length) return null;

    const dirHandle = choice.dirHandle || null;
    state.dirHandle = dirHandle;
    state.expectedBytes = typeof choice.expectedBytes === 'number' ? choice.expectedBytes : 0;
    panel.setMode(dirHandle ? 'fs' : 'download');
    panel.setNotice('');
    // 没有目录句柄时浏览器给每个文件单独弹一次下载：体积大就先把话说清楚，别让用户以为是卡住了。
    // 体积未知（含有一个未知）一律不提示 —— 猜出来的合计比不说更糟。
    if (!dirHandle) {
      const pickedBytes = selectedBytes(choice.entries);
      if (typeof pickedBytes === 'number' && pickedBytes > NO_FSA_HINT_BYTES) {
        panel.setNotice(
          '这批文件合计超过 500 MB：没有文件夹写入权限时会逐个交给浏览器下载（会连续弹窗），建议改用 Chrome/Edge 获得流式落盘。'
        );
      }
    }

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
    const sink = await createSink({ settings, dirHandle, signal, total: entries.length, sizeOf: sizeOf });
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

  /* ---------------- 体积索引 ---------------- */

  /** 体积只认「有限正数」：0 与负数都不算已知（0 会被下游当成「空文件」）。 */
  function isKnownSize(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
  }

  /**
   * 落盘层要的体积：先看对话框「获取体积」（Range: bytes=0-0）的结果，再看清单里
   * 上一次写回的 record.size。entry.id 可能缺失（无清单时），此时无法索引 → undefined。
   */
  function sizeOf(entry) {
    const id = entry && entry.id !== null && entry.id !== undefined ? String(entry.id) : '';
    if (!id) return undefined;

    const probed = state.probedSizes.get(id);
    if (isKnownSize(probed)) return probed;

    const files = state.manifest && typeof state.manifest.files === 'object' ? state.manifest.files : null;
    const record = files && Object.prototype.hasOwnProperty.call(files, id) ? files[id] : null;
    const size = record ? record.size : null;
    return isKnownSize(size) ? size : undefined;
  }

  /** 选中项体积合计：只要有一个未知就整批返回 null，绝不拿已知部分冒充「总计」。 */
  function selectedBytes(entries) {
    const list = Array.isArray(entries) ? entries : [];
    if (!list.length) return null;
    let sum = 0;
    for (const entry of list) {
      const size = sizeOf(entry);
      if (typeof size !== 'number') return null;
      sum += size;
    }
    return sum;
  }

  /* ---------------- 清单写回 ---------------- */

  /** 清单写回用的体积：来自本条扫描结果里的 entry.size（旧口径，保持不变）。 */
  function recordSizeOf(id) {
    const entry = state.entryById.get(id);
    const size = entry && typeof entry.size === 'number' && Number.isFinite(entry.size) && entry.size >= 0 ? entry.size : null;
    // 契约：体积未知写 null，绝不写 0（0 会让 planSkips 误判成「磁盘上是空文件」）。
    return size;
  }

  function noteRecord(p) {
    const id = p.entryId ? String(p.entryId) : '';
    if (!id) return;
    state.pendingRecords.push({ id: id, status: p.state === FILE_DONE ? 'done' : 'failed', size: recordSizeOf(id) });
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
    // 续接成功再写一次：updatedAt 保持新鲜，浏览器清掉句柄时也能被更早发现。
    rememberHandle(handle);
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
