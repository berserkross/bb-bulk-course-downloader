import { injectStyles } from './styles.js';

/** 取消看门狗：上层若在 3s 内没有推进状态，按钮自动恢复，绝不把用户永久锁死（B1 缺陷修复）。 */
const CANCEL_WATCHDOG_MS = 3000;

const STATES = ['idle', 'scanning', 'scanned', 'downloading', 'done', 'error', 'empty'];

function formatBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return (value >= 100 ? Math.round(value) : value.toFixed(1)) + ' ' + units[i];
}

/**
 * 抹掉文本里 URL 的 query（content_id / token 等只对服务器有意义的东西），只留路径部分。
 * 失败原因常常是 `HTTP 403 <https://bb/x/y.pdf?content_id=_1_1&token=...>`，
 * 原样贴进面板既泄露订阅凭据也读不清到底哪个文件出错。
 */
const ABSOLUTE_URL = /(https?:\/\/[^\s?#]*)(?:\?[^\s#]*)?(?:#[^\s]*)?/gi;
const RELATIVE_WITH_QUERY = /(\/[^\s?#]*)\?[^\s#]*/g;

export function redactUrlText(value) {
  const text = value == null ? '' : String(value);
  return text.replace(ABSOLUTE_URL, '$1').replace(RELATIVE_WITH_QUERY, '$1');
}

/** 按优先顺序取第一个可用的数字字段：新契约在前，旧字段兜底。 */
function pickNumber(source, keys, fallback) {
  for (const key of keys) {
    if (source && typeof source[key] === 'number' && Number.isFinite(source[key]) && source[key] >= 0) {
      return source[key];
    }
  }
  return fallback;
}

/**
 * 把 sink 的进度 payload 变成一行文本。
 * 契约：{ filesDone, filesTotal, bytesDone, bytesTotal, currentPath }。
 * bytesTotal === 0 表示总量未知：此时只报已下载字节与文件数，明说不显示百分比。
 */
export function progressLine(payload, sample) {
  const p = payload || {};
  const filesDone = pickNumber(p, ['filesDone', 'done'], 0);
  const filesTotal = pickNumber(p, ['filesTotal', 'total'], 0);
  const bytesDone = pickNumber(p, ['bytesDone', 'bytes'], 0);
  const bytesTotal = pickNumber(p, ['bytesTotal'], 0);
  const current = typeof p.currentPath === 'string' && p.currentPath ? p.currentPath : '';

  const files = filesTotal > 0 ? filesDone + '/' + filesTotal + ' 个文件' : '已完成 ' + filesDone + ' 个文件';

  // bytesTotal 已知才敢算百分比；未知就只报已下载字节 + 文件数，绝不出现 NaN / Infinity / 0%。
  let text;
  if (bytesTotal > 0) {
    const percent = Math.max(0, Math.min(100, Math.round((bytesDone / bytesTotal) * 100)));
    text = formatBytes(bytesDone) + ' / ' + formatBytes(bytesTotal) + '（' + percent + '%）· ' + files;
  } else {
    text = '已下载 ' + formatBytes(bytesDone) + ' · ' + files + '（总量未知，不显示百分比）';
  }

  // 速率只用「上一条样本到这一条」的增量算，绝不套 setTimeout 节流（节流在数据层）。
  if (sample && bytesTotal > 0 && Number.isFinite(sample.bytes) && Number.isFinite(sample.at)) {
    const elapsed = Date.now() - sample.at;
    const gained = bytesDone - sample.bytes;
    if (elapsed > 0 && gained > 0) {
      const rate = gained / (elapsed / 1000);
      const remain = (bytesTotal - bytesDone) / rate;
      if (Number.isFinite(remain) && remain > 0) {
        text += remain >= 60 ? ' · 剩约 ' + Math.max(1, Math.round(remain / 60)) + ' 分' : ' · 剩约 ' + Math.max(1, Math.round(remain)) + ' 秒';
      }
    }
  }

  if (current) text += ' · 当前：' + redactUrlText(current);
  return text;
}

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

function button(className, act, text) {
  const el = node('button', className, text);
  el.type = 'button';
  el.dataset.act = act;
  return el;
}

/**
 * 每个状态都显式声明三个按钮与状态文案。
 * 终态（idle / scanned / done / error / empty）里「扫描」永远可用，
 * 有文件时「选择并下载」也可用——这是 B1「禁用了就再也不恢复」的修复。
 */
function viewFor(state, ctx) {
  const hasEntries = ctx.entryCount > 0;
  const message = ctx.message || '';

  switch (state) {
    case 'scanning':
      return {
        status: '正在扫描课程内容…（可随时取消）',
        scan: { label: '扫描中…', disabled: true },
        download: { label: '选择并下载', disabled: true },
        cancel: { hidden: false, label: '取消扫描', disabled: false }
      };
    case 'downloading':
      return {
        status: '正在下载…（可随时取消）',
        scan: { label: '扫描', disabled: true },
        download: { label: '下载中…', disabled: true },
        cancel: { hidden: false, label: '取消下载', disabled: false }
      };
    case 'scanned':
      return {
        status: '扫描完成：共 ' + ctx.entryCount + ' 个文件，勾选后即可下载。',
        scan: { label: '重新扫描', disabled: false },
        download: { label: '选择并下载', disabled: !hasEntries },
        cancel: { hidden: true }
      };
    case 'done':
      return {
        status: '已完成。可以重新扫描，或再选一批文件下载。',
        scan: { label: '重新扫描', disabled: false },
        download: { label: '再下载一次', disabled: !hasEntries, hint: hasEntries ? '' : '先扫描课程' },
        cancel: { hidden: true }
      };
    case 'empty':
      return {
        status: '本课程下没有找到可下载的文件。可换一个内容页或重新扫描。',
        scan: { label: '重新扫描', disabled: false },
        download: { label: '选择并下载', disabled: true, hint: '没有可下载文件' },
        cancel: { hidden: true }
      };
    case 'error':
      return {
        status: message ? '出错了：' + message : '出错了：未知错误。可重试或刷新页面。',
        scan: { label: '重试扫描', disabled: false },
        download: { label: '选择并下载', disabled: !hasEntries, hint: hasEntries ? '' : '先扫描课程' },
        cancel: { hidden: true }
      };
    case 'idle':
    default:
      return {
        status: '就绪：点击「开始扫描」读取本课程的文件列表。',
        scan: { label: '开始扫描', disabled: false },
        download: { label: '选择并下载', disabled: !hasEntries, hint: hasEntries ? '' : '先扫描课程' },
        cancel: { hidden: true }
      };
  }
}

/**
 * 挂载幂等：同一个页面上脚本被注入两次（Tampermonkey 与 @require、SPA 重入、
 * 用户手动再执行一次）时，第二份不许再建一套 DOM —— 先查已有节点，复用它的控制器。
 * 控制器挂在节点上而不是模块变量里：两次注入是两个独立的模块实例，模块级变量看不见对方。
 */
function findMountedPanel() {
  if (typeof document === 'undefined' || !document.querySelector) return null;
  return document.querySelector('.bbdl-panel');
}

function reusePanel(root, opts) {
  const api = root && root.__bbdlApi;
  if (api && typeof api.rebind === 'function') {
    api.rebind(opts);
    return api;
  }
  // 另一份脚本留下的面板没有控制器可复用：接管它的状态显示，绝不再建第二个。
  const statusEl = root ? root.querySelector('.bbdl-status') : null;
  const noop = function () {};
  return {
    setState(state) {
      if (root) root.dataset.state = String(state || 'idle');
    },
    setCount: noop,
    setScanProgress: noop,
    setDownloadProgress: noop,
    setMode: noop,
    showSummary: noop,
    rebind: noop,
    fail(message) {
      if (statusEl) statusEl.textContent = '出错了：' + redactUrlText(message);
      if (root) root.dataset.state = 'error';
    },
    destroy: noop
  };
}

export function mountPanel(options) {
  const opts = options || {};
  const mounted = findMountedPanel();
  if (mounted) return reusePanel(mounted, opts);

  let settings = opts.settings || {};
  let onScan = typeof opts.onScan === 'function' ? opts.onScan : null;
  let onDownload = typeof opts.onDownload === 'function' ? opts.onDownload : null;
  let onCancel = typeof opts.onCancel === 'function' ? opts.onCancel : null;
  let onSettingsChange = typeof opts.onSettingsChange === 'function' ? opts.onSettingsChange : null;
  let onRetryFailed = typeof opts.onRetryFailed === 'function' ? opts.onRetryFailed : null;

  injectStyles();

  const timers = [];
  let current = 'idle';
  let context = { entryCount: 0, message: '' };
  let watchdog = 0;
  let destroyed = false;
  /** 进度样本：只用来估剩余时间，不参与节流（节流在数据层）。 */
  let sample = null;
  /** 失败清单的唯一真相源：重试只改它，再整块重绘。 */
  let summaryState = { ok: 0, failed: [], aborted: false };

  const root = node('div', 'bbdl-panel');
  root.dataset.state = 'idle';
  root.setAttribute('role', 'complementary');
  root.setAttribute('aria-label', 'BB 课件批量下载');

  const card = node('div', 'bbdl-panel__card');

  const head = node('div', 'bbdl-panel__head');
  const title = node('span', 'bbdl-panel__title', 'BB 批量下载');
  const collapseBtn = button('bbdl-btn bbdl-btn--icon', 'collapse', '–');
  collapseBtn.title = '折叠为小圆钮';
  head.appendChild(title);
  head.appendChild(collapseBtn);

  const body = node('div', 'bbdl-panel__body');
  const statusEl = node('p', 'bbdl-status');

  const progressEl = node('div', 'bbdl-progress');
  progressEl.hidden = true;
  const trackEl = node('div', 'bbdl-progress__track');
  const fillEl = node('span', 'bbdl-progress__fill');
  trackEl.appendChild(fillEl);
  const progressTextEl = node('p', 'bbdl-progress__text');
  progressEl.appendChild(trackEl);
  progressEl.appendChild(progressTextEl);

  const actionsEl = node('div', 'bbdl-actions');
  const scanBtn = button('bbdl-btn bbdl-btn--primary', 'scan', '开始扫描');
  const downloadBtn = button('bbdl-btn', 'download', '选择并下载');
  const cancelBtn = button('bbdl-btn bbdl-btn--danger', 'cancel', '取消');
  cancelBtn.hidden = true;
  actionsEl.appendChild(scanBtn);
  actionsEl.appendChild(downloadBtn);
  actionsEl.appendChild(cancelBtn);

  const settingsEl = node('details', 'bbdl-settings');
  settingsEl.appendChild(node('summary', null, '设置'));
  const probeRow = node('label', 'bbdl-settings__row');
  const probeInput = node('input');
  probeInput.type = 'checkbox';
  probeInput.checked = settings.probeSizes !== false;
  probeRow.appendChild(probeInput);
  probeRow.appendChild(node('span', null, '探测文件体积'));
  settingsEl.appendChild(probeRow);
  const concRow = node('label', 'bbdl-settings__row');
  concRow.appendChild(node('span', null, '下载并发'));
  const concInput = node('input');
  concInput.type = 'number';
  concInput.min = '1';
  concInput.max = '8';
  concInput.step = '1';
  concInput.value = String(settings.downloadConcurrency || 4);
  concRow.appendChild(concInput);
  settingsEl.appendChild(concRow);
  settingsEl.appendChild(node('p', 'bbdl-note', '目录结构开关在「选择并下载」对话框里。'));

  const modeEl = node('p', 'bbdl-mode');
  modeEl.hidden = true;

  const summaryEl = node('div', 'bbdl-summary');
  summaryEl.hidden = true;

  body.appendChild(statusEl);
  body.appendChild(progressEl);
  body.appendChild(actionsEl);
  body.appendChild(settingsEl);
  body.appendChild(modeEl);
  body.appendChild(summaryEl);
  card.appendChild(head);
  card.appendChild(body);

  const fab = button('bbdl-fab', 'expand', 'BB\n下载');
  fab.title = '展开面板';
  fab.textContent = 'BB 下载';

  root.appendChild(card);
  root.appendChild(fab);

  const host = document.body || document.documentElement;
  host.appendChild(root);

  function clearWatchdog() {
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = 0;
    }
  }

  function setBar(percent) {
    const value = Math.max(0, Math.min(100, Number(percent) || 0));
    fillEl.style.width = value + '%';
  }

  function applyButton(btn, spec) {
    if (!spec) return;
    btn.textContent = spec.label;
    btn.disabled = !!spec.disabled;
    btn.title = spec.hint || '';
  }

  function render(state, nextContext) {
    if (destroyed) return;
    const next = STATES.indexOf(state) >= 0 ? state : 'error';
    current = next;
    context = {
      entryCount: nextContext && typeof nextContext.entryCount === 'number' ? nextContext.entryCount : context.entryCount,
      // 所有进 DOM 的错误文案都在这里过一遍脱敏，调用方不必记得这件事。
      message: nextContext && nextContext.message ? redactUrlText(nextContext.message) : ''
    };

    root.dataset.state = next;
    const view = viewFor(next, context);

    applyButton(scanBtn, view.scan);
    applyButton(downloadBtn, view.download);

    if (view.cancel.hidden) {
      cancelBtn.hidden = true;
      cancelBtn.disabled = false;
      cancelBtn.textContent = '取消';
    } else {
      cancelBtn.hidden = false;
      cancelBtn.disabled = !!view.cancel.disabled;
      cancelBtn.textContent = view.cancel.label;
    }

    statusEl.textContent = view.status;
    progressEl.hidden = next !== 'scanning' && next !== 'downloading';

    if (next === 'scanning' || next === 'downloading') {
      summaryEl.hidden = true;
      summaryEl.textContent = '';
      setBar(0);
      progressTextEl.textContent = next === 'scanning' ? '准备扫描…' : '准备下载…';
    }
  }

  function emitSettings(patch) {
    if (!onSettingsChange) return;
    try {
      onSettingsChange(patch);
    } catch (err) {
      render('error', { message: (err && err.message) || String(err) });
    }
  }

  probeInput.addEventListener('change', function () {
    emitSettings({ probeSizes: probeInput.checked });
  });

  concInput.addEventListener('change', function () {
    const parsed = Math.round(Number(concInput.value));
    const value = Number.isFinite(parsed) ? Math.max(1, Math.min(8, parsed)) : 4;
    concInput.value = String(value);
    emitSettings({ downloadConcurrency: value });
  });

  function requestCancel() {
    if (!onCancel) return;
    cancelBtn.disabled = true;
    cancelBtn.textContent = '正在取消…';
    clearWatchdog();
    watchdog = setTimeout(function () {
      watchdog = 0;
      render(current, context);
    }, CANCEL_WATCHDOG_MS);
    try {
      onCancel();
    } catch (err) {
      render('error', { message: (err && err.message) || String(err) });
    }
  }

  root.addEventListener('click', function (event) {
    const target = event.target;
    const el = target && target.closest ? target.closest('[data-act]') : null;
    if (!el || !root.contains(el)) return;
    if (el.disabled) return;

    switch (el.dataset.act) {
      case 'collapse':
        root.classList.add('bbdl-panel--collapsed');
        break;
      case 'expand':
        root.classList.remove('bbdl-panel--collapsed');
        break;
      case 'scan':
        if (onScan) onScan();
        break;
      case 'download':
        if (onDownload) onDownload();
        break;
      case 'cancel':
        requestCancel();
        break;
      default:
        break;
    }
  });

  function setState(state, extra) {
    clearWatchdog();
    const nextContext = {};
    if (extra && typeof extra.count === 'number') nextContext.entryCount = extra.count;
    else if (extra && typeof extra.entryCount === 'number') nextContext.entryCount = extra.entryCount;
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
    const files = Number(p.filesFound) || 0;
    progressEl.hidden = false;
    setBar(queued ? (done / queued) * 100 : 12);
    const scope = queued ? done + ' / ' + queued : done + '（已完成）';
    progressTextEl.textContent = '文件夹 ' + scope + ' · 已发现 ' + files + ' 个文件';
  }

  function setDownloadProgress(progress) {
    if (destroyed) return;
    const p = progress || {};
    const filesDone = pickNumber(p, ['filesDone', 'done'], 0);
    const filesTotal = pickNumber(p, ['filesTotal', 'total'], 0);
    const bytesDone = pickNumber(p, ['bytesDone', 'bytes'], 0);
    const bytesTotal = pickNumber(p, ['bytesTotal'], 0);
    const failedCount = pickNumber(p, ['failed'], 0);

    progressEl.hidden = false;
    const ratio = bytesTotal > 0 ? bytesDone / bytesTotal : filesTotal > 0 ? filesDone / filesTotal : 0;
    setBar(ratio * 100);

    let text = progressLine(p, sample);
    if (failedCount) text += ' · 失败 ' + failedCount;
    progressTextEl.textContent = text;
    progressTextEl.title = text;

    // 采样窗口 ≥ 800ms：太密的样本会把速率算成噪声，太稀又会长时间不刷新 ETA。
    const now = Date.now();
    if (!sample || now - sample.at >= 800) sample = { at: now, bytes: bytesDone };
  }

  const MODE_TEXT = {
    fs: '落盘方式：保存到文件夹（Chromium）——直接写入你选的目录，保留原目录结构。代价：每次下载都要重新选一次文件夹，且只有 Chromium 系浏览器支持。',
    download:
      '落盘方式：逐文件下载（进浏览器默认下载目录）——网页拿不到目录写权限，文件名用 folder__ 前缀代替子目录。代价：所有文件都落在默认下载目录里，无法建子目录，文件多时会连续弹出多个下载。'
  };

  function setMode(kind) {
    if (destroyed) return;
    const text = MODE_TEXT[kind];
    modeEl.hidden = !text;
    modeEl.textContent = text || '';
    modeEl.title = text || '';
  }

  function entryPath(entry) {
    return Array.isArray(entry && entry.folderPath) && entry.folderPath.length ? entry.folderPath.join(' / ') : '';
  }

  function failedListText(failed) {
    return failed
      .map(function (item) {
        const entry = (item && item.entry) || {};
        const path = entryPath(entry);
        const name = redactUrlText(entry.name || '(未命名文件)');
        const reason = redactUrlText((item && item.error) || '未知错误');
        return (path ? path + ' / ' + name : name) + '\t' + reason;
      })
      .join('\n');
  }

  function copyFailed(btn, failed) {
    const text = failedListText(failed);
    const existing = summaryEl.querySelector('.bbdl-copybox');

    const fallback = function (reason) {
      const box = existing || node('textarea', 'bbdl-copybox');
      box.readOnly = true;
      box.value = text;
      box.rows = Math.min(8, failed.length + 1);
      if (!existing) summaryEl.appendChild(box);
      box.focus();
      if (typeof box.select === 'function') box.select();
      let copied = false;
      try {
        copied = typeof document.execCommand === 'function' && document.execCommand('copy');
      } catch (err) {
        copied = false;
      }
      btn.textContent = copied ? '已复制 ✓' : '已全选，按 Ctrl+C 复制';
      btn.title = reason || '';
      if (copied) resetCopyLabelLater(btn);
    };

    let clipboard;
    try {
      clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null;
    } catch (err) {
      clipboard = null;
    }

    if (clipboard && typeof clipboard.writeText === 'function') {
      clipboard.writeText(text).then(
        function () {
          btn.textContent = '已复制 ✓';
          if (existing) existing.remove();
          resetCopyLabelLater(btn);
        },
        function (err) {
          fallback('剪贴板不可用：' + ((err && err.message) || String(err)));
        }
      );
      return;
    }
    fallback('当前环境没有剪贴板 API');
  }

  function resetCopyLabelLater(btn) {
    const timer = setTimeout(function () {
      if (!destroyed) btn.textContent = '复制失败清单';
    }, 1800);
    timers.push(timer);
  }

  function renderSummary() {
    if (destroyed) return;
    summaryEl.textContent = '';
    summaryEl.hidden = false;

    const staged = summaryState;
    summaryEl.appendChild(
      node(
        'p',
        'bbdl-summary__head',
        (staged.aborted ? '已取消（部分完成）：' : '下载完成：') +
          '成功 ' +
          staged.ok +
          ' 个，失败 ' +
          staged.failed.length +
          ' 个'
      )
    );

    // 全部成功时清单整体消失，只剩这一行结论。
    if (!staged.failed.length) return;

    const list = node('ol', 'bbdl-failed');
    staged.failed.forEach(function (item) {
      const entry = (item && item.entry) || {};
      const li = node('li', 'bbdl-failed__item');
      const path = entryPath(entry) || '（课程根目录）';
      const nameEl = node('span', 'bbdl-failed__name', entry.name || '(未命名文件)');
      nameEl.title = entry.name || '';
      const pathEl = node('span', 'bbdl-failed__path', path);
      pathEl.title = path;
      const reasonEl = node('span', 'bbdl-failed__reason', redactUrlText((item && item.error) || '未知错误'));
      reasonEl.title = reasonEl.textContent;
      li.appendChild(nameEl);
      li.appendChild(pathEl);
      li.appendChild(reasonEl);
      list.appendChild(li);
    });
    summaryEl.appendChild(list);

    const bar = node('div', 'bbdl-actions');
    const retryBtn = node('button', 'bbdl-btn bbdl-btn--small', '只重试失败的（' + staged.failed.length + '）');
    retryBtn.type = 'button';
    retryBtn.disabled = !onRetryFailed;
    if (!onRetryFailed) retryBtn.title = '当前没有可用的重试入口';
    retryBtn.addEventListener('click', function () {
      retryFailed(retryBtn);
    });

    const copyBtn = node('button', 'bbdl-btn bbdl-btn--small', '复制失败清单');
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', function () {
      copyFailed(copyBtn, summaryState.failed);
    });

    bar.appendChild(retryBtn);
    bar.appendChild(copyBtn);
    summaryEl.appendChild(bar);
  }

  /** 只把失败项再喂给同一个 sink：成功的从清单消失，全部成功则清单整体消失。 */
  function retryFailed(retryBtn) {
    const entries = summaryState.failed
      .map(function (item) {
        return item && item.entry;
      })
      .filter(Boolean);
    if (!entries.length) return;

    retryBtn.disabled = true;
    retryBtn.textContent = '正在重试 ' + entries.length + ' 个…';

    let pending;
    try {
      pending = onRetryFailed(entries);
    } catch (err) {
      render('error', { message: (err && err.message) || String(err) });
      return;
    }

    Promise.resolve(pending).then(
      function (result) {
        if (destroyed) return;
        if (!result) {
          // 上层拒绝了重试（例如正在忙）：恢复按钮，绝不把用户卡在「正在重试」上。
          retryBtn.disabled = false;
          retryBtn.textContent = '只重试失败的（' + summaryState.failed.length + '）';
          return;
        }
        const okList = Array.isArray(result.ok) ? result.ok : [];
        const failed = Array.isArray(result.failed) ? result.failed : [];
        summaryState = { ok: summaryState.ok + okList.length, failed: failed, aborted: !!result.aborted };
        renderSummary();
        render(failed.length ? 'error' : 'done', failed.length ? { message: '重试后仍有 ' + failed.length + ' 个文件失败。' } : {});
      },
      function (err) {
        render('error', { message: (err && err.message) || String(err) });
      }
    );
  }

  function showSummary(result) {
    if (destroyed) return;
    const ok = result && Array.isArray(result.ok) ? result.ok : [];
    const failed = result && Array.isArray(result.failed) ? result.failed : [];
    const aborted = !!(result && result.aborted);
    summaryState = { ok: ok.length, failed: failed, aborted: aborted };
    renderSummary();
    render(aborted ? 'error' : 'done', aborted ? { message: '下载被取消，已完成的文件保留在目标位置。' } : {});
  }

  function fail(message) {
    render('error', { message: message == null ? '未知错误' : String(message) });
  }

  /** 二次注入时把最新闭包接进同一份 DOM：面板继续工作，回调指向最新的调用方。 */
  function rebind(next) {
    const o = next || {};
    if (o.settings) {
      settings = o.settings;
      probeInput.checked = settings.probeSizes !== false;
      concInput.value = String(settings.downloadConcurrency || 4);
    }
    if (typeof o.onScan === 'function') onScan = o.onScan;
    if (typeof o.onDownload === 'function') onDownload = o.onDownload;
    if (typeof o.onCancel === 'function') onCancel = o.onCancel;
    if (typeof o.onSettingsChange === 'function') onSettingsChange = o.onSettingsChange;
    if (typeof o.onRetryFailed === 'function') onRetryFailed = o.onRetryFailed;
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
    setState: setState,
    setCount: setCount,
    setScanProgress: setScanProgress,
    setDownloadProgress: setDownloadProgress,
    setMode: setMode,
    showSummary: showSummary,
    rebind: rebind,
    fail: fail,
    destroy: destroy
  };

  root.__bbdlApi = api;
  render('idle', {});
  return api;
}
