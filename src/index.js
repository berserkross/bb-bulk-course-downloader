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
  const state = { entries: [], busy: false, abort: null };

  const panel = mountPanel({
    settings,
    onSettingsChange(patch) {
      Object.assign(settings, saveSettings(patch));
    },
    onScan: startScan,
    onDownload: startDownload,
    onCancel() {
      if (state.abort) state.abort.abort();
    }
  });

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

    const signal = begin();
    panel.setState('downloading');
    try {
      const sink = await createSink({
        settings,
        dirHandle: choice.dirHandle,
        signal,
        total: choice.entries.length
      });
      const fetcher = createFetcher({ signal });
      const result = await sink.download(choice.entries, fetcher, {
        onProgress: (p) => panel.setDownloadProgress(p)
      });
      panel.showSummary(result);
    } catch (err) {
      panel.fail(signal.aborted ? '已取消' : describe(err));
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
