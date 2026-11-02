import { createFetcher, SessionExpiredError } from './bb/http.js';
import { createScanner } from './bb/scan.js';
import { pickDirectory, createSink } from './sinks/index.js';
import { mountPanel } from './ui/panel.js';
import { openSelectDialog } from './ui/select.js';
import { loadSettings, saveSettings } from './store.js';

function currentIds() {
  const p = new URL(location.href).searchParams;
  return { courseId: p.get('course_id'), contentId: p.get('content_id') };
}

function describe(err) {
  if (err instanceof SessionExpiredError) return '会话已失效：请重新登录 Blackboard，然后刷新本页再试。';
  return (err && err.message) || String(err);
}

function mount() {
  const { courseId, contentId } = currentIds();
  if (!courseId || !contentId) return;

  const settings = loadSettings();
  const state = { entries: [], busy: false, abort: null, dirHandle: null, expectedBytes: 0 };

  const panel = mountPanel({
    settings,
    onSettingsChange(patch) {
      Object.assign(settings, saveSettings(patch));
    },
    onScan: startScan,
    onDownload: startDownload,
    onRetryFailed,
    onCancel() {
      if (state.abort) state.abort.abort();
    }
  });

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

  function onProgress(p) {
    panel.setDownloadProgress(withExpectedTotal(p));
  }

  function begin() {
    state.busy = true;
    state.abort = new AbortController();
    return state.abort.signal;
  }

  async function startScan() {
    if (state.busy) return;
    const signal = begin();
    panel.setState('scanning');
    try {
      const fetcher = createFetcher({ signal });
      const scanner = createScanner({
        fetcher,
        rootUrl: location.href,
        onProgress: (p) => panel.setScanProgress(p)
      });
      state.entries = await scanner.scan();
      if (!state.entries.length) panel.setState('empty');
      else panel.setState('scanned', { count: state.entries.length });
    } catch (err) {
      panel.fail(signal.aborted ? '已取消' : describe(err));
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

  async function startDownload() {
    if (state.busy || !state.entries.length) return;

    let choice;
    try {
      choice = await openSelectDialog(state.entries, {
        settings,
        pickDirectory,
        onProbeSizes: probeSizes,
        onSettingsChange(patch) {
          Object.assign(settings, saveSettings(patch));
        }
      });
    } catch (err) {
      panel.fail(describe(err));
      return;
    }
    if (!choice || !choice.entries.length) return;

    state.dirHandle = choice.dirHandle || null;
    state.expectedBytes = typeof choice.expectedBytes === 'number' ? choice.expectedBytes : 0;
    panel.setMode(state.dirHandle ? 'fs' : 'download');

    const signal = begin();
    panel.setState('downloading');
    try {
      panel.showSummary(await runDownload(choice.entries, state.dirHandle, signal));
    } catch (err) {
      panel.fail(signal.aborted ? '已取消' : describe(err));
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
    if (state.busy || !entries || !entries.length) return null;
    state.busy = true;
    state.abort = new AbortController();
    // 重试批次的分母和首轮不同，宁可报「总量未知」也不拿首轮的数字冒充。
    state.expectedBytes = 0;
    panel.setState('downloading');
    try {
      return await runDownload(entries, state.dirHandle, state.abort.signal);
    } finally {
      state.busy = false;
    }
  }
}

if (location.href.includes('listContent.jsp')) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
}
