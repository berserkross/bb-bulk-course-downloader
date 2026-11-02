import { injectStyles } from './styles.js';
import { redactUrlText } from './panel.js';

/** 勾选记忆的 key 前缀：按 (courseId, pageId) 分桶，换课程 / 换内容页各记各的。 */
const SELECTION_KEY_PREFIX = 'bbdl:sel:';

/** 记忆 key；两段 id 缺一就不记忆——宁可不记，也不能把两门课的勾选串到一起。 */
export function selectionStorageKey(courseId, pageId) {
  const course = courseId == null ? '' : String(courseId).trim();
  const page = pageId == null ? '' : String(pageId).trim();
  if (!course || !page) return '';
  return SELECTION_KEY_PREFIX + course + ':' + page;
}

/** sessionStorage 在这里只能被「尝试」：隐私模式 / 被策略禁用时连访问属性都会抛。 */
function selectionStore() {
  try {
    const store = typeof globalThis !== 'undefined' ? globalThis.sessionStorage : null;
    return store && typeof store.getItem === 'function' && typeof store.setItem === 'function' ? store : null;
  } catch (err) {
    return null;
  }
}

/** 读记忆：只认非空 id 的数组；解析失败、类型不对一律当「没有记忆」。 */
export function readSelection(key) {
  if (!key) return null;
  const store = selectionStore();
  if (!store) return null;
  let raw = null;
  try {
    raw = store.getItem(key);
  } catch (err) {
    return null;
  }
  if (typeof raw !== 'string' || !raw) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const ids = [];
  for (const item of parsed) {
    const id = typeof item === 'string' ? item : typeof item === 'number' ? String(item) : '';
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
    // 配额 / 禁用：记忆只是便利，写不进去也不该影响勾选本身。
  }
}

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

/** 契约 §7 允许的 skip reason：其余值（含 v1 遗留的 'manifest'）一律归到清单命中。 */
const SKIP_REASONS = ['disk', 'disk-unverified', 'manifest', 'manifest-unchanged', 'manifest-unknown'];

function nonNegCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 清单里的相对路径 → 一行可显示的文本。
 * 契约 §8 / §9.6：对话框里永不出现 URL query，所以先按 URL 剥掉 scheme/host，再砍掉 ? 与 #。
 * 正常情况拿到的就是 '第 1 周/讲义.pdf' 这样的相对路径，这一段是兜底而不是主路径。
 */
function stalePathText(value) {
  let text = value == null ? '' : String(value).trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      text = new URL(text, 'http://localhost/').pathname;
    } catch (err) {
      text = '';
    }
  }
  text = redactUrlText(text);
  const cut = text.search(/[?#]/);
  if (cut >= 0) text = text.slice(0, cut);
  text = text.replace(/^\/+/, '').trim();
  return text || '（路径未记录）';
}

/** 疑似删除列表只保留可显示的相对路径；id 可能是 URL（拿不到 rid 时就是整串下载地址），永不进 DOM。 */
function normalizeStaleList(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    const path = item && typeof item === 'object' ? item.path : item;
    out.push(stalePathText(path));
  }
  return out;
}

/** 把 index.js 算好的跳过摘要归一化；缺字段一律当「没有可跳过的」处理。 */
export function normalizeSkipInfo(raw) {
  const info = raw || {};
  const byId = new Map();
  const source = info.byId instanceof Map ? Array.from(info.byId.entries()) : info.byId && typeof info.byId === 'object' ? Object.entries(info.byId) : [];
  for (const pair of source) {
    const id = pair[0];
    const hit = pair[1];
    if (!id || !hit) continue;
    const reason = SKIP_REASONS.indexOf(hit.reason) >= 0 ? hit.reason : 'manifest';
    const size = typeof hit.size === 'number' && Number.isFinite(hit.size) && hit.size >= 0 ? hit.size : null;
    byId.set(String(id), { reason: reason, size: size });
  }
  let disk = 0;
  let manifest = 0;
  let unverified = 0;
  let manifestUnchanged = 0;
  byId.forEach(function (hit) {
    if (hit.reason === 'disk' || hit.reason === 'disk-unverified') {
      disk += 1;
      if (hit.reason === 'disk-unverified') unverified += 1;
      return;
    }
    manifest += 1;
    if (hit.reason === 'manifest-unchanged') manifestUnchanged += 1;
  });
  return {
    byId: byId,
    disk: disk,
    manifest: manifest,
    unverified: unverified,
    manifestUnchanged: manifestUnchanged,
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

/** 首次扫描：清单还是空的，五个桶全 0 —— 没有任何版本知识，预览行整行不渲染（也就没有「未变 0」这种噪音）。 */
function noVersionKnowledge(data) {
  return data.changed === 0 && data.moved === 0 && data.unchanged === 0 && data.unknown === 0 && data.stale === 0;
}

/** 顶部预览行：一行六个数。stale 为 0 时不写「疑似删除 0」，其余五个永远是六桶里的原值。 */
export function syncPreviewText(info) {
  const data = normalizeSkipInfo(info);
  if (noVersionKnowledge(data)) return '';
  const text =
    '本次扫描：新增 ' + data.added +
    ' · 变更 ' + data.changed +
    ' · 改名 ' + data.moved +
    ' · 未变 ' + data.unchanged +
    ' · 未知 ' + data.unknown;
  return data.stale > 0 ? text + ' · 疑似删除 ' + data.stale : text;
}

/** 复选框文案：数量与「磁盘/清单」两个来源分开写，用户才知道凭什么跳过。 */
export function skipLabelText(info) {
  const data = normalizeSkipInfo(info);
  // 本轮确实有版本知识（未变 / 未知 / 疑似删除任一非 0）：改写成同步口径，让用户一眼看出「未变」是多少。
  // 只改文案，skipExisting 的判定语义与唯一一个开关都不动。
  if (data.unchanged > 0 || data.unknown > 0 || data.stale > 0) {
    return '只下载新增与变更（跳过未变 ' + data.unchanged + ' 个）';
  }
  const parts = [];
  if (data.disk) parts.push('磁盘 ' + data.disk);
  if (data.manifest) parts.push('清单 ' + data.manifest);
  return '跳过已存在的文件（' + data.total + ' 个' + (parts.length ? '，' + parts.join(' / ') : '') + '）';
}

/** 行内灰标的 title：说清这一行为什么会被跳过。 */
export function skipReasonText(hit) {
  const reason = hit && hit.reason;
  if (reason === 'disk') return '磁盘上已有同名同体积的文件，勾选「跳过已存在的文件」时不下这个。';
  if (reason === 'disk-unverified') return '磁盘上已有同名文件，但体积无法核实，按已存在处理。';
  if (reason === 'manifest-unchanged') return '下载清单里这条是 done，且上游的版本指纹没变，勾选「只下载新增与变更」时不下这个。';
  if (reason === 'manifest-unknown') return '下载清单里这条是 done，但缺少可比的版本指纹，按未知处理：本轮会重下，下一轮才能确认未变。';
  return '下载清单里这条已经是 done，勾选「跳过已存在的文件」时不下这个。';
}

/** 说明行：truncated / 无 FSA 两个降级路径必须显式说清楚，否则用户会以为「跳过」判断得很准。 */
export function skipNoteText(info) {
  const data = normalizeSkipInfo(info);
  // 扫描失败自己也值得单独说一句：它会把整批文件顶成「未知」，所以一个都没跳过时也要提示。
  if (!data.total && !data.scanFailures) return '';
  const bits = [];
  if (data.scanFailures > 0) {
    // 排在最前面：它比「磁盘不可核实」更严重 —— 用户先要知道这次的比对结果是残缺的。
    bits.push('本次扫描有 ' + data.scanFailures + ' 个文件夹失败，其中的文件一律按未知处理（会重下）。');
  }
  if (data.truncated) bits.push('目录里文件太多，本次只比对了前面一部分，可能漏判已存在的文件。');
  if (!data.diskChecked) bits.push('还没有可核实的目录（或当前浏览器无法核实磁盘文件），只能按下载清单判断：清单里标着完成的才跳过。');
  else if (data.unverified) bits.push('其中 ' + data.unverified + ' 个文件在磁盘上的体积无法核实，只能按文件名判断。');
  if (data.unchanged > 0) bits.push('清单里已完成、上游未变的文件本轮不再下载。');
  return bits.join(' ');
}

export function openSelectDialog(entries, options) {
  const opts = options || {};
  const settings = opts.settings || {};
  const onSettingsChange = typeof opts.onSettingsChange === 'function' ? opts.onSettingsChange : null;
  const onProbeSizes = typeof opts.onProbeSizes === 'function' ? opts.onProbeSizes : null;
  // 「选择保存位置」由 index.js 提供：对话框只负责把点击原样转过去 —— 用户手势必须在点击栈里用掉。
  const onPickDirectory = typeof opts.onPickDirectory === 'function' ? opts.onPickDirectory : null;
  // 改了「保留原始目录结构」后路径全变，摘要要重算；index.js 会复用上一次的磁盘快照，不再扫盘。
  const onRefreshSkips = typeof opts.onRefreshSkips === 'function' ? opts.onRefreshSkips : null;
  const onDialogClose = typeof opts.onClose === 'function' ? opts.onClose : null;
  const pickDirectory = typeof opts.pickDirectory === 'function' ? opts.pickDirectory : function () {
    return null;
  };
  // 跳过摘要由 index.js 用 planSkips 算好传进来；对话框自己不做磁盘或清单判断。
  // 选完目录后整份摘要会换掉，所以这里是 let 而不是 const。
  const selectionKey = selectionStorageKey(opts.courseId, opts.pageId);
  let skipInfo = normalizeSkipInfo(opts.skipInfo);
  let skipExisting = skipInfo.total > 0;
  /** 用户亲手动过复选框就不再替他改回来；没人动过时默认值跟随比对结果。 */
  let skipTouched = false;
  /** 工具栏里选定的目录：有它就不弹第二次选择器，也不重复比对磁盘。 */
  let pickedHandle = null;
  let pickedName = '';
  let pickBusy = false;
  /** 每次比对一个编号：换目录 / 关对话框都让旧结果作废，迟到的结果一律丢弃。 */
  let pickGeneration = 0;

  if (activeInstance) activeInstance.close(null);
  injectStyles();

  return new Promise(function (resolve) {
    const list = Array.isArray(entries) ? entries.slice() : [];
    const sizes = new Map();
    const selected = new Set();

    // 记忆里一条都对不上（换版后文件全变了）就当没有记忆，回落「默认全选」。
    // 只有在 list 里还活着的 id 会被恢复，已消失的 id 因此是静默丢弃。
    const remembered = readSelection(selectionKey);
    let restored = null;
    if (remembered && remembered.length) {
      const alive = new Set();
      for (const entry of list) {
        if (entry && remembered.indexOf(entry.id) >= 0) alive.add(entry.id);
      }
      if (alive.size) restored = alive;
    }

    for (const entry of list) {
      if (!entry) continue;
      if (!restored || restored.has(entry.id)) selected.add(entry.id);
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

    const skipSwitch = node('label', 'bbdl-switch bbdl-switch--skip');
    const skipInput = node('input');
    skipInput.type = 'checkbox';
    skipInput.className = 'bbdl-check';
    skipInput.checked = skipExisting;
    // 文案随比对结果变，所以这一段留引用，renderSkip() 负责改写。
    const skipLabelEl = node('span', null, skipLabelText(skipInfo));
    skipSwitch.appendChild(skipInput);
    skipSwitch.appendChild(skipLabelEl);
    skipSwitch.title = skipNoteText(skipInfo) || '已存在（磁盘或清单里有记录）的文件不再重新下载';

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

    // 保存位置得能在对话框里先定下来：否则「跳过已存在」只能按下载清单判断。
    const dirRow = node('div', 'bbdl-toolbar__row bbdl-toolbar__row--dir');
    const dirBtn = button('pick-dir', '选择保存位置…', 'bbdl-btn bbdl-btn--small');
    dirBtn.hidden = !onPickDirectory;
    const dirStatusEl = node('span', 'bbdl-dir__status');
    dirRow.appendChild(dirBtn);
    dirRow.appendChild(dirStatusEl);

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

    const skipNoteEl = node('p', 'bbdl-note bbdl-note--skip', skipNoteText(skipInfo));
    skipNoteEl.hidden = true; // 真正挂不挂由 renderSkip() 决定：比对结果随时会变

    // 顶部预览行：一行六个数，挂在列表体正上方。没有版本知识时整行从 DOM 摘掉，不留空占位。
    const syncRow = node('div', 'bbdl-toolbar__row bbdl-toolbar__row--sync');
    const syncEl = node('span', 'bbdl-sync');
    syncRow.appendChild(syncEl);

    // 疑似删除：只提示、只列相对路径，这一块里永远没有按钮（契约 §8 / §9.3：删除永不自动执行）。
    const staleBox = node('details', 'bbdl-stale');
    const staleHead = node('summary', 'bbdl-stale__head');
    const staleListEl = node('ul', 'bbdl-stale__list');
    staleBox.appendChild(staleHead);
    staleBox.appendChild(staleListEl);

    toolbar.appendChild(dirRow);
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

    /* ---------------- 保存位置与跳过摘要 ---------------- */

    /** 复选框与说明行只跟着当前摘要走：total === 0 时整块不挂进 DOM（不占位、不留空行）。 */
    function renderSkip() {
      skipInput.checked = skipExisting;
      skipLabelEl.textContent = skipLabelText(skipInfo);
      skipSwitch.title = skipNoteText(skipInfo) || '已存在（磁盘或清单里有记录）的文件不再重新下载';
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

    /** 预览行与疑似删除块都排在工具栏末尾：预览行在前，块在后，顺序每轮重排一次保证不串位。 */
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
      staleHead.textContent = '疑似删除 ' + skipInfo.stale + ' 个（只提示，不会删除本地文件）';
      staleListEl.textContent = '';
      // 一份可显的都没有时也要说清楚：宁可写「路径未记录」，也不让标题上的数字落空。
      const paths = skipInfo.staleList.length ? skipInfo.staleList : ['（路径未记录）'];
      for (const path of paths) staleListEl.appendChild(node('li', 'bbdl-stale__item', path));
      toolbar.appendChild(staleBox);
    }

    /** 已选的保存位置 + 来源标注：用户得一眼看出这次到底写哪儿、凭什么说「已存在」。 */
    function renderDirRow() {
      dirBtn.disabled = pickBusy;
      let text;
      if (pickedHandle) {
        const parts = [];
        if (skipInfo.diskChecked) parts.push('磁盘上已有 ' + skipInfo.disk + ' 个');
        if (skipInfo.manifest) parts.push('清单已完成 ' + skipInfo.manifest + ' 个');
        text = '保存位置：' + pickedName + '（写入文件夹）' + (parts.length ? '，' + parts.join('，') : '，没有同名文件');
      } else if (!fsaAvailable) {
        text = '当前浏览器不能选文件夹：文件会逐个下载到默认下载目录。';
      } else if (onPickDirectory) {
        text = '未选择保存位置：先选一个目录，「跳过已存在」才算得准。';
      } else {
        text = '未选择保存位置：点「开始下载」时会再问你一次。';
      }
      dirStatusEl.textContent = text;
      dirStatusEl.title = text;
    }

    /** 摘要整份换掉：勾选状态、行内灰标、合计行一起重画。 */
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
      // 选到目录 / 失去权限都会改 pickedHandle，档位文案必须同一帧跟着换。
      renderMode();
    }

    function setPickBusy(busy) {
      pickBusy = busy;
      renderDirRow();
    }

    /**
     * 「选择保存位置…」的点击处理。
     * 铁律：onPickDirectory() 必须在点击的同一个同步栈里直接调用 —— 它内部先发
     * showDirectoryPicker / requestPermission，中间夹一次 await 用户激活就作废了。
     */
    function handlePickDirectory() {
      if (!onPickDirectory || closed || pickBusy) return;
      const generation = ++pickGeneration;
      setPickBusy(true);
      setHint('正在比对磁盘…');
      let pending;
      try {
        pending = onPickDirectory({
          setHint: function (text) {
            if (closed || generation !== pickGeneration) return;
            setHint(text);
          }
        });
      } catch (err) {
        onPickSettled(generation, { failed: String((err && err.message) || err) });
        return;
      }
      Promise.resolve(pending).then(
        function (result) {
          onPickSettled(generation, result);
        },
        function (err) {
          onPickSettled(generation, { failed: String((err && err.message) || err) });
        }
      );
    }

    function onPickSettled(generation, result) {
      // 换目录 / 关对话框之后的迟到结果一律丢弃：绝不拿过期的命中数改摘要。
      if (closed || generation !== pickGeneration) return;
      setPickBusy(false);
      const res = result || {};
      if (res.cancelled) {
        setHint('没有选保存位置，仍可以按下载清单跳过已完成的文件。');
        return;
      }
      if (res.failed) {
        showError('无法选择保存位置：' + redactUrlText(String(res.failed)) + '。可重试。', false);
        return;
      }
      if (res.status === 'denied' || !res.dirHandle) {
        // 降级不是崩溃：退回默认下载目录，跳过判断只剩清单可用。
        pickedHandle = null;
        pickedName = '';
        applySkipInfo(res.skipInfo);
        showError(
          '没有拿到「' + (res.name || '所选目录') + '」的写入权限（浏览器拒绝或授权已过期），' +
            '本次会逐个下载到默认下载目录，跳过判断只能按下载清单。',
          true
        );
        return;
      }
      pickedHandle = res.dirHandle;
      pickedName = res.name || '未命名目录';
      clearError();
      applySkipInfo(res.skipInfo);
      setHint(
        skipInfo.total
          ? '已选保存位置，其中 ' + skipInfo.total + ' 个文件已存在（勾选「跳过已存在的文件」时不下）。'
          : '已选保存位置：这个目录和清单里都没有已存在的文件。'
      );
    }

    /** 「保留原始目录结构」一变，磁盘路径就全变了，摘要必须重算；index.js 侧复用缓存，不扫盘。 */
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
        function (next) {
          if (closed || generation !== pickGeneration || !next) return;
          applySkipInfo(next);
        },
        function () {}
      );
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
          const skipHit = skipInfo.byId.get(entry.id);
          if (skipHit) {
            // 灰标只是提示：这些行照样能勾选，「要不要跳过」由上面的复选框决定。
            rowEl.classList.add('bbdl-row--skipped');
            rowEl.dataset.skip = skipHit.reason;
            rowEl.title = skipReasonText(skipHit);
          }
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
      zip: '落盘方式：按文件夹打包成 .zip（存到浏览器默认下载目录）——没有目录写入权限时自动退到这种方式，解压后还原原目录结构。代价：按顶层文件夹分包，单包上限约 200 MB。',
      download: '落盘方式：逐文件下载（进浏览器默认下载目录）——当前浏览器无法让网页选目录，文件名用目录前缀保留层级。代价：所有文件都进默认下载目录，建不了子目录，文件多时会连续弹下载。'
    };

    /**
     * 档位必须跟真实 sink 一致（src/index.js 的 sinkKind 是同一口径）：选到目录 → fs；
     * 没选到目录时按 settings.fallbackSink 走 zip（缺省）/ download。
     * fsaAvailable 只说浏览器「能」选目录，不代表这次真写盘（用户可能取消、也可能拿不到权限），
     * 所以它不再参与档位判定。
     */
    function modeKind() {
      if (pickedHandle) return 'fs';
      return settings && settings.fallbackSink === 'files' ? 'download' : 'zip';
    }

    function renderMode() {
      // zip 的包内路径同样受「保留原始目录结构」影响（src/sinks/zip.js:120 读开关、:129 不保留时整批一包、
      // :262 把开关透传给 planBatch 生成 segments），所以三档一律带这个后缀。
      const text = MODE_TEXT[modeKind()];
      modeEl.textContent = text + (preserveTree ? '' : '（已关闭「保留原始目录结构」）');
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

    /** 勾选一变就落 sessionStorage：关对话框、切走再回来都能恢复。 */
    function persistSelection() {
      writeSelection(
        selectionKey,
        collectSelected().map(function (entry) {
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
      const amount = known ? formatBytes(bytes) : '—';
      let skipped = 0;
      if (skipExisting) {
        for (const entry of chosen) if (skipInfo.byId.has(entry.id)) skipped += 1;
      }
      const skipText = skipped ? '，其中 ' + skipped + ' 个已存在会跳过' : '';
      totalsEl.textContent =
        '已选 ' + chosen.length + ' / 共 ' + list.length + '，合计 ' + amount + (unknown ? '（' + unknown + ' 个体积未知）' : '') + skipText;
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
      // 关闭这一刻的勾选才是「这次的选择」：确认与取消都要记，取消也不能丢。
      persistSelection();
      // 关掉对话框等于放弃这次比对：让还在跑的目录枚举立刻中止，别在后台继续扫盘。
      pickGeneration += 1;
      if (onDialogClose) {
        try {
          onDialogClose();
        } catch (err) {
          // 取消回调只是「收拾后台任务」，失败不该拦住关闭
        }
      }
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
          expectedBytes: expectedTotalBytes(chosen),
          skipExisting: skipExisting
        });
        return;
      }
      // pickDirectory() 的 null 是二义的：FSA 可用时为「用户取消选目录」，不可用时为「无 FSA」。
      if (fsaAvailable) {
        showError('已取消选择文件夹，未开始下载。可再次点击「开始下载」，或改用默认下载。', true);
        return;
      }
      close({
        entries: chosen,
        sizeRefresher: setRowSizeInternal,
        expectedBytes: expectedTotalBytes(chosen),
        skipExisting: skipExisting
      });
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
      close({
        entries: chosen,
        sizeRefresher: setRowSizeInternal,
        expectedBytes: expectedTotalBytes(chosen),
        skipExisting: skipExisting
      });
    });

    function handleConfirm() {
      // 工具栏里已经选好目录：直接用它，不再弹第二次选择器，也不再重跑磁盘比对。
      if (pickedHandle) {
        onDirectoryPicked(pickedHandle);
        return;
      }
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

    dirBtn.addEventListener('click', function () {
      // 直接转交：这里不许 await，手势要在这一栈里送到 showDirectoryPicker。
      handlePickDirectory();
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
        function (report) {
          probeBtn.disabled = false;
          const failed = report && Number.isFinite(report.fail) ? report.fail : 0;
          if (!failed) {
            setHint('体积已更新。');
            return;
          }
          // 有失败时必须说出来：只显示「已更新」会让「永远未知」看起来像正常结果。
          const reason = report && report.firstError ? '：' + redactUrlText(String(report.firstError)) : '';
          setHint('体积已更新（' + failed + ' 个体积探测失败）' + reason);
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
      refreshSkipsAfterTreeChange();
    });

    skipInput.addEventListener('change', function () {
      skipTouched = true;
      skipExisting = skipInput.checked;
      // 只影响「提交哪些 todo」，行渲染不动：勾选状态由 index.js 在下载前过滤。
      setHint(skipExisting ? '已存在的文件会跳过，只下载缺的。' : '已取消跳过：选中的文件会全部重新下载。');
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

    document.addEventListener('keydown', onKeyDown, true);
    (document.body || document.documentElement).appendChild(overlay);
    activeInstance = inst;

    if (!list.length) showError('没有可下载的文件。');
    confirmBtn.focus();
  });
}
