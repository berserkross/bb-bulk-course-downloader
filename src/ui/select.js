import { injectStyles } from './styles.js';
import { redactUrlText } from './panel.js';

/**
 * 扩展名归并成 6 个类型：勾选「pdf」比让用户面对 20 种后缀要省事，
 * ext 列表之外的一切都落进「其他」，所以任何文件永远属于且只属于一个类型。
 */
export const TYPE_GROUPS = [
  { id: 'pdf', label: 'pdf', exts: ['pdf'] },
  { id: 'ppt', label: 'ppt', exts: ['ppt', 'pptx', 'pps', 'ppsx', 'pot', 'potx'] },
  { id: 'doc', label: 'doc', exts: ['doc', 'docx', 'rtf', 'txt', 'odt'] },
  { id: 'zip', label: 'zip', exts: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2'] },
  { id: 'image', label: '图片', exts: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'tif', 'tiff'] },
  { id: 'other', label: '其他', exts: [] }
];

export function typeOf(entry) {
  const match = /\.([a-z0-9]+)$/i.exec(String((entry && entry.name) || '').trim());
  const ext = match ? match[1].toLowerCase() : '';
  for (const group of TYPE_GROUPS) {
    if (group.exts.indexOf(ext) >= 0) return group.id;
  }
  return 'other';
}

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
    let query = '';
    let sortMode = 'none';
    const activeTypes = new Set(
      TYPE_GROUPS.map(function (group) {
        return group.id;
      })
    );
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
    const toolRow = node('div', 'bbdl-toolbar__row');
    const filterRow = node('div', 'bbdl-toolbar__row');
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

    const sortSelect = node('select', 'bbdl-sort');
    sortSelect.setAttribute('aria-label', '排序方式');
    [
      ['none', '目录顺序'],
      ['name', '按名称'],
      ['size', '按体积']
    ].forEach(function (pair) {
      const opt = node('option', null, pair[1]);
      opt.value = pair[0];
      sortSelect.appendChild(opt);
    });
    sortSelect.value = sortMode;

    const hintEl = node('span', 'bbdl-hint');

    toolRow.appendChild(allBtn);
    toolRow.appendChild(noneBtn);
    toolRow.appendChild(probeBtn);
    toolRow.appendChild(sortSelect);
    toolRow.appendChild(treeSwitch);
    toolRow.appendChild(hintEl);

    const searchInput = node('input', 'bbdl-search');
    searchInput.type = 'search';
    searchInput.placeholder = '搜索文件名…';
    searchInput.setAttribute('aria-label', '搜索文件名');

    const typesEl = node('div', 'bbdl-types');
    TYPE_GROUPS.forEach(function (group) {
      const item = node('label', 'bbdl-types__item');
      const box = node('input');
      box.type = 'checkbox';
      box.className = 'bbdl-check';
      box.checked = activeTypes.has(group.id);
      box.setAttribute('data-type', group.id);
      box.addEventListener('change', function () {
        if (box.checked) activeTypes.add(group.id);
        else activeTypes.delete(group.id);
        applyView();
      });
      item.appendChild(box);
      item.appendChild(node('span', null, group.label));
      typesEl.appendChild(item);
    });

    filterRow.appendChild(searchInput);
    filterRow.appendChild(typesEl);

    toolbar.appendChild(toolRow);
    toolbar.appendChild(filterRow);

    const treeEl = node('div', 'bbdl-tree');
    const modeEl = node('p', 'bbdl-mode');

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
    dialog.appendChild(modeEl);
    dialog.appendChild(errorEl);
    dialog.appendChild(foot);
    overlay.appendChild(dialog);

    const inst = {
      setRowSize: setRowSizeInternal,
      close: close
    };

    function showError(text, offerFallback) {
      errorText.textContent = redactUrlText(String(text));
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
        // 层级用缩进表达：132 个文件时「a / b / c」这种扁平全路径根本没法扫读。
        // 完整路径退到 title 里，缩进只负责一眼看出谁在谁下面。
        folderRow.style.paddingLeft = 10 + Math.max(0, group.path.length - 1) * 12 + 'px';
        const leaf = group.path.length ? group.path[group.path.length - 1] : '课程根目录';
        const folderLabel = (group.path.length ? group.path.join(' / ') : '课程根目录') + '（' + group.items.length + ' 个文件）';
        const folderName = node('span', 'bbdl-row__name', leaf + '（' + group.items.length + ' 个文件）');
        folderName.title = folderLabel;
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

        folders.set(key, { input: folderBox, sizeEl: folderSize, items: group.items, el: groupEl });

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

          rows.set(entry.id, { input: input, sizeEl: sizeEl, pathEl: pathEl, entry: entry, el: rowEl });
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
        const text = previewPath(row.entry);
        row.pathEl.textContent = text;
        // 路径单行不折行，被截断的部分靠 title 兜底（见 styles.js 里 .bbdl-row__path 的说明）。
        row.pathEl.title = text;
      });
    }

    /** 视图过滤的唯一判定：类型勾选 + 文件名搜索。 */
    function visibleEntry(entry) {
      if (!entry) return false;
      if (!activeTypes.has(typeOf(entry))) return false;
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return String(entry.name || '').toLowerCase().indexOf(q) >= 0;
    }

    function sortedRows(group) {
      const items = group.items
        .map(function (entry) {
          return rows.get(entry.id);
        })
        .filter(Boolean);
      if (sortMode === 'name') {
        items.sort(function (a, b) {
          return String(a.entry.name || '').localeCompare(String(b.entry.name || ''), 'zh-Hans-CN', { numeric: true });
        });
      } else if (sortMode === 'size') {
        // 「稳定置底」用分组实现而不是比较函数：未探测项之间的相对顺序因此原封不动。
        const known = items.filter(function (row) {
          return sizes.has(row.entry.id);
        });
        const unknown = items.filter(function (row) {
          return !sizes.has(row.entry.id);
        });
        known.sort(function (a, b) {
          return sizes.get(b.entry.id) - sizes.get(a.entry.id);
        });
        return known.concat(unknown);
      }
      return items;
    }

    let viewHint = '';
    function applyView() {
      let visible = 0;
      let pendingSize = 0;
      groups.forEach(function (group, key) {
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
        if (sortMode === 'none' || !shown || !folder.el) return;
        // 文件夹标题行永远是组内第一格，这里只重排文件行。
        for (const row of sortedRows(group)) {
          if (row.el.parentNode === folder.el) folder.el.appendChild(row.el);
        }
      });

      let next = '';
      if (!visible) next = '没有匹配的文件：换个关键词，或把类型勾回来。';
      else if (sortMode === 'size' && pendingSize) {
        next = '按体积排序：' + pendingSize + ' 个体积未探测，已稳定排在最后，可先点「获取体积」。';
      }
      // hintEl 也被「正在获取体积…」这类临时消息借用，只在还显示视图自己的提示时才改写它。
      if (hintEl.textContent === viewHint) hintEl.textContent = next;
      viewHint = next;
    }

    const MODE_TEXT = {
      fs: '落盘方式：保存到文件夹（Chromium）——可以选一个目录，文件按原目录结构直接写进去。代价：每次下载都要重新选一次文件夹，且只有 Chromium 系浏览器支持。',
      download: '落盘方式：逐文件下载（进浏览器默认下载目录）——当前浏览器无法让网页选目录，文件名用目录前缀保留层级。代价：所有文件都进默认下载目录，建不了子目录，文件多时会连续弹下载。'
    };

    function renderMode() {
      modeEl.textContent = MODE_TEXT[fsaAvailable ? 'fs' : 'download'] + (preserveTree ? '' : '（已关闭「保留原始目录结构」）');
      modeEl.title = modeEl.textContent;
    }

    /** 分母由 UI 自己算：只有当每个已选文件体积都已知，才敢报百分比，否则一律按未知处理。 */
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
      applyView();
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
        close({
          entries: chosen,
          dirHandle: dirHandle,
          sizeRefresher: setRowSizeInternal,
          expectedBytes: expectedTotalBytes(chosen)
        });
        return;
      }
      // pickDirectory() 的 null 是二义的：FSA 可用时为「用户取消选目录」，不可用时为「无 FSA」。
      if (fsaAvailable) {
        showError('已取消选择文件夹，未开始下载。可再次点击「开始下载」，或改用默认下载。', true);
        return;
      }
      close({ entries: chosen, sizeRefresher: setRowSizeInternal, expectedBytes: expectedTotalBytes(chosen) });
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
      close({ entries: chosen, sizeRefresher: setRowSizeInternal, expectedBytes: expectedTotalBytes(chosen) });
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

    // 全选 / 全不选只作用于当前可见项：否则「筛出 pdf → 全选」会把隐藏的 100 个文件一起选上，
    // 用户看到的勾选状态和实际提交的清单就对不上了。
    allBtn.addEventListener('click', function () {
      for (const entry of list) {
        if (!entry || !visibleEntry(entry)) continue;
        selected.add(entry.id);
        const row = rows.get(entry.id);
        if (row) row.input.checked = true;
      }
      syncFolders();
      renderTotals();
    });

    noneBtn.addEventListener('click', function () {
      for (const entry of list) {
        if (!entry || !visibleEntry(entry)) continue;
        selected.delete(entry.id);
        const row = rows.get(entry.id);
        if (row) row.input.checked = false;
      }
      syncFolders();
      renderTotals();
    });

    searchInput.addEventListener('input', function () {
      query = searchInput.value || '';
      applyView();
    });

    sortSelect.addEventListener('change', function () {
      sortMode = sortSelect.value || 'none';
      applyView();
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
        setHint('体积获取失败：' + redactUrlText(String((err && err.message) || err)));
        return;
      }
      Promise.resolve(pending).then(
        function () {
          probeBtn.disabled = false;
          setHint('体积已更新。');
        },
        function (err) {
          probeBtn.disabled = false;
          setHint('体积获取失败：' + redactUrlText(String((err && err.message) || err)));
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
      renderMode();
      renderTotals();
    });

    buildTree();
    renderPaths();
    renderMode();
    syncFolders();
    renderTotals();
    applyView();

    document.addEventListener('keydown', onKeyDown, true);
    (document.body || document.documentElement).appendChild(overlay);
    activeInstance = inst;

    if (!list.length) showError('没有可下载的文件。');
    confirmBtn.focus();
  });
}
