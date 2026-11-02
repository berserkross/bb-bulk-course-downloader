import { injectStyles } from './styles.js';

/**
 * 当前打开的对话框实例。模块级 setRowSize(id, size) 转发给它，
 * 供外部体积探测回调在对话框打开期间逐行回填（面板本身不发任何请求）。
 */
let activeInstance = null;

export function setRowSize(id, size) {
  if (!activeInstance) return false;
  return activeInstance.setRowSize(id, size);
}

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

/** 探测 FSA 可用性：用来区分 pickDirectory() 的 null 到底是「用户取消」还是「环境不支持」。 */
function directoryPickerAvailable() {
  try {
    return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
  } catch (err) {
    return false;
  }
}

function button(act, text, className) {
  const el = node('button', className || 'bbdl-btn', text);
  el.type = 'button';
  el.dataset.act = act;
  return el;
}

export function openSelectDialog(entries, options) {
  const opts = options || {};
  const settings = opts.settings || {};
  const onSettingsChange = typeof opts.onSettingsChange === 'function' ? opts.onSettingsChange : null;
  const onProbeSizes = typeof opts.onProbeSizes === 'function' ? opts.onProbeSizes : null;
  const pickDirectory = typeof opts.pickDirectory === 'function' ? opts.pickDirectory : function () {
    return null;
  };

  if (activeInstance) activeInstance.close(null);
  injectStyles();

  return new Promise(function (resolve) {
    const list = Array.isArray(entries) ? entries.slice() : [];
    const sizes = new Map();
    const selected = new Set();

    for (const entry of list) {
      if (!entry) continue;
      selected.add(entry.id);
      if (typeof entry.size === 'number' && Number.isFinite(entry.size)) sizes.set(entry.id, entry.size);
    }

    let preserveTree = settings.preserveTree !== false;
    let closed = false;
    const fsaAvailable = directoryPickerAvailable();

    const rows = new Map();
    const folders = new Map();

    const groups = new Map();
    for (const entry of list) {
      if (!entry) continue;
      const path = Array.isArray(entry.folderPath) ? entry.folderPath : [];
      const key = path.join('/');
      if (!groups.has(key)) groups.set(key, { path: path, items: [] });
      groups.get(key).items.push(entry);
    }

    const overlay = node('div', 'bbdl-overlay');
    const dialog = node('div', 'bbdl-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', '选择要下载的文件');

    const head = node('div', 'bbdl-dialog__head');
    head.appendChild(node('h2', 'bbdl-dialog__title', '选择要下载的文件'));
    const closeBtn = button('close', '关闭', 'bbdl-btn bbdl-btn--small');
    head.appendChild(closeBtn);

    const toolbar = node('div', 'bbdl-dialog__toolbar');
    const allBtn = button('all', '全选', 'bbdl-btn bbdl-btn--small');
    const noneBtn = button('none', '全不选', 'bbdl-btn bbdl-btn--small');
    const probeBtn = button('probe', '获取体积', 'bbdl-btn bbdl-btn--small');
    probeBtn.hidden = !(onProbeSizes && settings.probeSizes !== false);

    const treeSwitch = node('label', 'bbdl-switch');
    const treeInput = node('input');
    treeInput.type = 'checkbox';
    treeInput.className = 'bbdl-check';
    treeInput.checked = preserveTree;
    treeSwitch.appendChild(treeInput);
    treeSwitch.appendChild(node('span', null, '保留原始目录结构'));

    const hintEl = node('span', 'bbdl-hint');

    toolbar.appendChild(allBtn);
    toolbar.appendChild(noneBtn);
    toolbar.appendChild(probeBtn);
    toolbar.appendChild(treeSwitch);
    toolbar.appendChild(hintEl);

    const treeEl = node('div', 'bbdl-tree');

    const foot = node('div', 'bbdl-dialog__foot');
    const totalsEl = node('span', 'bbdl-dialog__totals');
    const footActions = node('div', 'bbdl-dialog__actions');
    const cancelBtn = button('cancel', '取消', 'bbdl-btn');
    const confirmBtn = button('confirm', '开始下载', 'bbdl-btn bbdl-btn--primary');
    footActions.appendChild(cancelBtn);
    footActions.appendChild(confirmBtn);
    foot.appendChild(totalsEl);
    foot.appendChild(footActions);

    const errorEl = node('div', 'bbdl-dialog__error');
    const errorText = node('span', null, '');
    const fallbackBtn = button('fallback', '改用默认下载（不选文件夹）', 'bbdl-btn bbdl-btn--small');
    fallbackBtn.hidden = true;
    errorEl.appendChild(errorText);
    errorEl.appendChild(fallbackBtn);
    errorEl.hidden = true;

    dialog.appendChild(head);
    dialog.appendChild(toolbar);
    dialog.appendChild(treeEl);
    dialog.appendChild(errorEl);
    dialog.appendChild(foot);
    overlay.appendChild(dialog);

    const inst = {
      setRowSize: setRowSizeInternal,
      close: close
    };

    function showError(text, offerFallback) {
      errorText.textContent = String(text);
      errorEl.hidden = false;
      fallbackBtn.hidden = !offerFallback;
    }

    function clearError() {
      errorEl.hidden = true;
      errorText.textContent = '';
      fallbackBtn.hidden = true;
    }

    function setHint(text) {
      hintEl.textContent = text || '';
    }

    function buildTree() {
      treeEl.textContent = '';
      rows.clear();
      folders.clear();

      const keys = Array.from(groups.keys()).sort(function (a, b) {
        if (a === b) return 0;
        if (a === '') return -1;
        if (b === '') return 1;
        return a.localeCompare(b, 'zh-Hans-CN');
      });

      const frag = document.createDocumentFragment();

      keys.forEach(function (key) {
        const group = groups.get(key);
        const groupEl = node('div', 'bbdl-group');

        const folderRow = node('label', 'bbdl-row bbdl-row--folder');
        const folderBox = node('input');
        folderBox.type = 'checkbox';
        folderBox.className = 'bbdl-check';
        folderBox.checked = true;
        const folderName = node(
          'span',
          'bbdl-row__name',
          (group.path.length ? group.path.join(' / ') : '课程根目录') + '（' + group.items.length + ' 个文件）'
        );
        const folderSize = node('span', 'bbdl-row__size', '');
        folderRow.appendChild(folderBox);
        folderRow.appendChild(folderName);
        folderRow.appendChild(folderSize);
        groupEl.appendChild(folderRow);

        folderBox.addEventListener('change', function () {
          for (const entry of group.items) {
            if (folderBox.checked) selected.add(entry.id);
            else selected.delete(entry.id);
            const row = rows.get(entry.id);
            if (row) row.input.checked = folderBox.checked;
          }
          syncFolders();
          renderTotals();
        });

        folders.set(key, { input: folderBox, sizeEl: folderSize, items: group.items });

        for (const entry of group.items) {
          const rowEl = node('label', 'bbdl-row bbdl-row--file');
          const input = node('input');
          input.type = 'checkbox';
          input.className = 'bbdl-check';
          input.checked = selected.has(entry.id);
          input.addEventListener('change', function () {
            if (input.checked) selected.add(entry.id);
            else selected.delete(entry.id);
            syncFolders();
            renderTotals();
          });

          const nameEl = node('span', 'bbdl-row__name', entry.name || '(未命名文件)');
          nameEl.title = entry.name || '';
          const sizeEl = node('span', 'bbdl-row__size', sizes.has(entry.id) ? formatBytes(sizes.get(entry.id)) : '—');
          const pathEl = node('span', 'bbdl-row__path');

          rowEl.appendChild(input);
          rowEl.appendChild(nameEl);
          rowEl.appendChild(sizeEl);
          rowEl.appendChild(pathEl);
          groupEl.appendChild(rowEl);

          rows.set(entry.id, { input: input, sizeEl: sizeEl, pathEl: pathEl, entry: entry });
        }

        frag.appendChild(groupEl);
      });

      treeEl.appendChild(frag);
    }

    function previewPath(entry) {
      const path = Array.isArray(entry.folderPath) ? entry.folderPath : [];
      const name = entry.name || '(未命名文件)';
      if (preserveTree) return path.length ? path.join(' / ') + ' / ' + name : name;
      return '（平铺）' + (path.length ? path.join('__') + '__' : '') + name;
    }

    function renderPaths() {
      rows.forEach(function (row) {
        row.pathEl.textContent = previewPath(row.entry);
      });
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
      return { chosen: chosen, bytes: bytes, known: known };
    }

    function syncFolders() {
      folders.forEach(function (folder) {
        const stat = folderTotals(folder);
        folder.input.indeterminate = stat.chosen > 0 && stat.chosen < folder.items.length;
        folder.input.checked = stat.chosen > 0 && stat.chosen === folder.items.length;
        folder.sizeEl.textContent = stat.known ? formatBytes(stat.bytes) : '—';
      });
    }

    function collectSelected() {
      return list.filter(function (entry) {
        return entry && selected.has(entry.id);
      });
    }

    function renderTotals() {
      const chosen = collectSelected();
      let bytes = 0;
      let known = 0;
      for (const entry of chosen) {
        if (sizes.has(entry.id)) {
          bytes += sizes.get(entry.id);
          known += 1;
        }
      }
      const unknown = chosen.length - known;
      const amount = known ? formatBytes(bytes) : '—';
      totalsEl.textContent =
        '已选 ' + chosen.length + ' / 共 ' + list.length + '，合计 ' + amount + (unknown ? '（' + unknown + ' 个体积未知）' : '');
      confirmBtn.disabled = chosen.length === 0;
      confirmBtn.title = chosen.length === 0 ? '至少选择一个文件' : '';
    }

    function setRowSizeInternal(id, size) {
      const row = rows.get(id);
      if (!row) return false;
      if (typeof size === 'number' && Number.isFinite(size) && size >= 0) {
        sizes.set(id, size);
        row.sizeEl.textContent = formatBytes(size);
        row.sizeEl.title = size + ' 字节';
      } else {
        sizes.delete(id);
        row.sizeEl.textContent = '—';
        row.sizeEl.title = '';
      }
      syncFolders();
      renderTotals();
      return true;
    }

    function close(value) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKeyDown, true);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (activeInstance === inst) activeInstance = null;
      resolve(value);
    }

    function onKeyDown(event) {
      if (event.key === 'Escape' || event.key === 'Esc') {
        event.stopPropagation();
        close(null);
      }
    }

    function onDirectoryPicked(dirHandle) {
      if (closed) return;
      const chosen = collectSelected();
      if (!chosen.length) {
        showError('请至少选择一个文件。');
        return;
      }
      if (dirHandle) {
        close({ entries: chosen, dirHandle: dirHandle, sizeRefresher: setRowSizeInternal });
        return;
      }
      // pickDirectory() 的 null 是二义的：FSA 可用时为「用户取消选目录」，不可用时为「无 FSA」。
      if (fsaAvailable) {
        showError('已取消选择文件夹，未开始下载。可再次点击「开始下载」，或改用默认下载。', true);
        return;
      }
      close({ entries: chosen, sizeRefresher: setRowSizeInternal });
    }

    function onDirectoryFailed(err) {
      if (closed) return;
      const name = String((err && err.name) || '');
      if (/abort/i.test(name)) {
        showError('已取消选择文件夹，未开始下载。', true);
        return;
      }
      showError('无法打开文件夹选择器：' + ((err && err.message) || String(err)) + '。可重试。', true);
    }

    fallbackBtn.addEventListener('click', function () {
      const chosen = collectSelected();
      if (!chosen.length) {
        showError('请至少选择一个文件。');
        return;
      }
      close({ entries: chosen, sizeRefresher: setRowSizeInternal });
    });

    function handleConfirm() {
      // —— 同步第一句：借本次点击的用户手势调用 pickDirectory()，前面不得有 await ——
      const picked = pickDirectory();

      if (picked && typeof picked.then === 'function') {
        clearError();
        confirmBtn.disabled = true;
        picked.then(
          function (dirHandle) {
            confirmBtn.disabled = false;
            onDirectoryPicked(dirHandle);
          },
          function (err) {
            confirmBtn.disabled = false;
            onDirectoryFailed(err);
          }
        );
        return;
      }
      onDirectoryPicked(picked);
    }

    confirmBtn.addEventListener('click', function () {
      try {
        handleConfirm();
      } catch (err) {
        onDirectoryFailed(err);
      }
    });

    cancelBtn.addEventListener('click', function () {
      close(null);
    });

    closeBtn.addEventListener('click', function () {
      close(null);
    });

    allBtn.addEventListener('click', function () {
      for (const entry of list) {
        if (!entry) continue;
        selected.add(entry.id);
        const row = rows.get(entry.id);
        if (row) row.input.checked = true;
      }
      syncFolders();
      renderTotals();
    });

    noneBtn.addEventListener('click', function () {
      selected.clear();
      rows.forEach(function (row) {
        row.input.checked = false;
      });
      syncFolders();
      renderTotals();
    });

    probeBtn.addEventListener('click', function () {
      if (!onProbeSizes) return;
      const unknown = collectSelected().filter(function (entry) {
        return !sizes.has(entry.id);
      });
      if (!unknown.length) {
        setHint('已选文件的体积都已知。');
        return;
      }
      probeBtn.disabled = true;
      setHint('正在获取 ' + unknown.length + ' 个体积…');
      let pending;
      try {
        pending = onProbeSizes(unknown, { setRowSize: setRowSizeInternal });
      } catch (err) {
        probeBtn.disabled = false;
        setHint('体积获取失败：' + ((err && err.message) || String(err)));
        return;
      }
      Promise.resolve(pending).then(
        function () {
          probeBtn.disabled = false;
          setHint('体积已更新。');
        },
        function (err) {
          probeBtn.disabled = false;
          setHint('体积获取失败：' + ((err && err.message) || String(err)));
        }
      );
    });

    treeInput.addEventListener('change', function () {
      preserveTree = treeInput.checked;
      if (onSettingsChange) {
        try {
          onSettingsChange({ preserveTree: preserveTree });
        } catch (err) {
          showError('保存设置失败：' + ((err && err.message) || String(err)));
        }
      }
      renderPaths();
      renderTotals();
    });

    buildTree();
    renderPaths();
    syncFolders();
    renderTotals();

    document.addEventListener('keydown', onKeyDown, true);
    (document.body || document.documentElement).appendChild(overlay);
    activeInstance = inst;

    if (!list.length) showError('没有可下载的文件。');
    confirmBtn.focus();
  });
}
