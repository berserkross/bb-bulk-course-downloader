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

export function mountPanel(options) {
  const opts = options || {};
  const settings = opts.settings || {};
  const onScan = typeof opts.onScan === 'function' ? opts.onScan : null;
  const onDownload = typeof opts.onDownload === 'function' ? opts.onDownload : null;
  const onCancel = typeof opts.onCancel === 'function' ? opts.onCancel : null;
  const onSettingsChange = typeof opts.onSettingsChange === 'function' ? opts.onSettingsChange : null;

  injectStyles();

  const timers = [];
  let current = 'idle';
  let context = { entryCount: 0, message: '' };
  let watchdog = 0;
  let destroyed = false;

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

  const summaryEl = node('div', 'bbdl-summary');
  summaryEl.hidden = true;

  body.appendChild(statusEl);
  body.appendChild(progressEl);
  body.appendChild(actionsEl);
  body.appendChild(settingsEl);
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
      message: nextContext && nextContext.message ? String(nextContext.message) : ''
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
    const done = Number(p.done) || 0;
    const total = Number(p.total) || 0;
    const failed = Number(p.failed) || 0;
    const bytes = typeof p.bytes === 'number' ? p.bytes : undefined;
    progressEl.hidden = false;
    setBar(total ? (done / total) * 100 : 0);

    let text = done + ' / ' + total + ' · ' + formatBytes(bytes);
    if (p.name) text += ' · 当前：' + String(p.name);
    if (failed) text += ' · 失败 ' + failed;
    progressTextEl.textContent = text;
  }

  function failedListText(failed) {
    return failed
      .map(function (item) {
        const entry = (item && item.entry) || {};
        const path = Array.isArray(entry.folderPath) && entry.folderPath.length ? entry.folderPath.join('/') + '/' : '';
        return path + (entry.name || '(未命名文件)') + '\t' + String((item && item.error) || '未知错误');
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

  function showSummary(result) {
    if (destroyed) return;
    const ok = result && Array.isArray(result.ok) ? result.ok : [];
    const failed = result && Array.isArray(result.failed) ? result.failed : [];
    const aborted = !!(result && result.aborted);

    summaryEl.textContent = '';
    summaryEl.hidden = false;

    summaryEl.appendChild(
      node(
        'p',
        'bbdl-summary__head',
        (aborted ? '已取消（部分完成）：' : '下载完成：') + '成功 ' + ok.length + ' 个，失败 ' + failed.length + ' 个'
      )
    );

    if (failed.length) {
      const list = node('ol', 'bbdl-failed');
      failed.forEach(function (item) {
        const entry = (item && item.entry) || {};
        const li = node('li', 'bbdl-failed__item');
        li.appendChild(node('span', 'bbdl-failed__name', entry.name || '(未命名文件)'));
        const folder = Array.isArray(entry.folderPath) && entry.folderPath.length ? entry.folderPath.join(' / ') + ' / ' : '';
        li.appendChild(node('span', 'bbdl-failed__reason', folder + String((item && item.error) || '未知错误')));
        list.appendChild(li);
      });
      summaryEl.appendChild(list);

      const copyBtn = node('button', 'bbdl-btn bbdl-btn--small', '复制失败清单');
      copyBtn.type = 'button';
      copyBtn.addEventListener('click', function () {
        copyFailed(copyBtn, failed);
      });
      summaryEl.appendChild(copyBtn);
    }

    render(aborted ? 'error' : 'done', aborted ? { message: '下载被取消，已完成的文件保留在目标位置。' } : {});
  }

  function fail(message) {
    render('error', { message: message == null ? '未知错误' : String(message) });
  }

  function destroy() {
    destroyed = true;
    clearWatchdog();
    for (const timer of timers) clearTimeout(timer);
    timers.length = 0;
    if (root.parentNode) root.parentNode.removeChild(root);
  }

  render('idle', {});

  return {
    setState: setState,
    setCount: setCount,
    setScanProgress: setScanProgress,
    setDownloadProgress: setDownloadProgress,
    showSummary: showSummary,
    fail: fail,
    destroy: destroy
  };
}
