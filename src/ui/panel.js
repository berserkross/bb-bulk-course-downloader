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

/**
 * 比 redactUrlText 更狠：整个 URL 拿掉，只留人话（HTTP 500 https://.../xid-1_1 -> HTTP 500）。
 * 失败清单里文件名和相对路径都已经单独显示了，再贴一条绝对 URL 只会在面板里刷屏。
 */
const ABSOLUTE_URL_LOOSE = /(?:https?:)?\/\/[^\s?#]*(?:\?[^\s#]*)?(?:#[^\s]*)?/gi;

/**
 * §1 红线：面板 DOM 内的可见文本不许出现 登录 / 过期 / 会话失效 / 重新登录 / 认证。
 * 命中敏感句时面板照旧有话说，只是换成中性句 —— 原因只留给 console。
 */
const QUIET_TEXT = /登录|过期|会话失效|重新登录|认证/;

/** 长句场景（notice / 错误行 / 状态行）：整句换掉。 */
export const QUIET_NOTICE_TEXT = '请求被拒绝，稍后会自动重试。';
/** 短句场景（摘要里失败行的 reason）：一行位置塞不下长句。 */
export const QUIET_REASON_TEXT = '请求被拒绝';

function quietText(value) {
  const text = String(value == null ? '' : value);
  if (!text.trim()) return '';
  return QUIET_TEXT.test(text) ? QUIET_NOTICE_TEXT : text;
}

function quietReasonText(value) {
  const text = String(value == null ? '' : value);
  return QUIET_TEXT.test(text) ? QUIET_REASON_TEXT : text;
}

export function stripUrlText(value) {
  const text = value == null ? '' : String(value);
  return text.replace(ABSOLUTE_URL_LOOSE, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * 「重试后仍失败」类的错误：给一句下一步建议，其余失败项一个字都不加。
 * 只认这三类文案（停滞 / 文件不完整 / 重试），别的错误照原样展示。
 */
const RETRY_CLASS_ERROR = /停滞|文件不完整|重试/;

export function retryHintText(reason) {
  return RETRY_CLASS_ERROR.test(reason == null ? '' : String(reason)) ? '可稍后点「只重试失败的」再试一次' : '';
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

/** 文件边界事件：收到这些就说明换文件了，重试计数必须归零。 */
const RETRY_RESET_STATES = new Set(['start', 'file-start', 'file-done', 'file-failed', 'aborted', 'done']);

/** 重试文案只带相对路径：万一带了 query 也砍掉，绝不让签名参数进 DOM。 */
function retryFileName(value) {
  const raw = String(value == null ? '' : value);
  const cut = raw.search(/[?#]/);
  return redactUrlText(cut === -1 ? raw : raw.slice(0, cut));
}

/**
 * 文件级重试计数：sink 的 'file-retry' 只报路径、没有 attempt 字段，次数只能 UI 自己数。
 * 同一个 path 连续重试才累加；换文件（file-start / file-done / file-failed）一律归零。
 */
export function trackRetry(prev, payload) {
  const p = payload || {};
  const state = typeof p.state === 'string' ? p.state : '';
  const current = prev && prev.count > 0 ? prev : { path: '', count: 0 };
  if (state === 'file-retry') {
    const path = retryFileName(p.currentPath || p.path || '');
    return { path: path, count: current.path === path ? current.count + 1 : 1 };
  }
  if (RETRY_RESET_STATES.has(state)) return { path: '', count: 0 };
  return current;
}

/** 状态行尾部的重试说明；文件名已经出现在进度行里就不再重复贴一遍。 */
export function retryLine(retry, existing) {
  if (!retry || !(retry.count > 0)) return '';
  const text = ' · 重试中（第 ' + retry.count + ' 次）';
  if (!retry.path || (existing && existing.indexOf(retry.path) !== -1)) return text;
  return text + '：' + retry.path;
}

/** 文件列表行数上限：超出只画前 500 行，剩下的用一行收口，绝不让 DOM 被上千行拖死。 */
export const MAX_FILE_ROWS = 500;

/** 五种状态文案是唯一允许进 DOM 的状态词；其它状态键一律落回「等待」。 */
const FILE_STATUS_TEXT = {
  waiting: '等待',
  running: '下载中',
  done: '完成',
  failed: '失败',
  skipped: '跳过'
};

/** 砍掉 query 与 hash：`?content_id=...&token=...` 这类签名参数绝不许进 DOM。 */
function stripQuery(value) {
  const raw = String(value == null ? '' : value);
  const cut = raw.search(/[?#]/);
  return cut === -1 ? raw : raw.slice(0, cut);
}

/** 文件名只留可读部分：先砍 query/hash，再走一次 URL 脱敏。 */
function safeNameText(value) {
  return redactUrlText(stripQuery(value));
}

/** 路径只留相对路径：绝对 URL 砍掉协议与主机，再砍 query/hash。 */
function safePathText(value) {
  const raw = String(value == null ? '' : value).replace(/^\s*[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '');
  return redactUrlText(stripQuery(raw));
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 扫描历史只列最近 5 条：面板是常驻浮层，历史一长就把下载按钮挤出屏幕。 */
export const MAX_HISTORY_ROWS = 5;
/** 每条历史展开后最多 20 行变更路径。 */
export const MAX_HISTORY_PATHS = 20;

/** 历史行的时间戳：MM-DD HH:mm（本地时区），拿不到时间就返回空串。 */
function formatScanTime(at) {
  const n = finiteNumber(at);
  if (n == null || n <= 0) return '';
  const date = new Date(Math.floor(n));
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value) => (value < 10 ? '0' + value : String(value));
  return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

/** 计数一律落地成非负整数：缺键 / NaN / 负数都按 0，绝不把 undefined 写进 DOM。 */
function countText(value) {
  const n = finiteNumber(value);
  return String(n == null || n < 0 ? 0 : Math.floor(n));
}

/** 一条历史的摘要行：「08-21 14:32 · 新增 18 · 变更 1 · 改名 1 · 未变 1 · 未知 1 · 疑似删除 2」。 */
export function historyLineText(scan) {
  const s = scan || {};
  const time = formatScanTime(s.at);
  const counts =
    '新增 ' + countText(s.added) +
    ' · 变更 ' + countText(s.changed) +
    ' · 改名 ' + countText(s.moved) +
    ' · 未变 ' + countText(s.unchanged) +
    ' · 未知 ' + countText(s.unknown) +
    ' · 疑似删除 ' + countText(s.stale);
  return time ? time + ' · ' + counts : counts;
}

/** 行身份只看 id / entryId：两者都没有的条目没法按 entryId 更新，直接不种行。 */
function entryIdOf(entry) {
  const raw = entry && entry.id != null ? entry.id : entry && entry.entryId;
  if (raw == null || raw === '') return '';
  return String(raw);
}

/** 种子行的初始状态：只认五种状态键，其余一律「等待」。 */
function seedFileStatus(entry) {
  const raw = entry && typeof entry.status === 'string' ? entry.status : '';
  return Object.prototype.hasOwnProperty.call(FILE_STATUS_TEXT, raw) ? raw : 'waiting';
}

/**
 * M5：落盘层在响应到达后才解析出服务器真名，完成/失败事件带的就是它。
 * 行上的名字必须跟着改，否则「文件列表」显示页面标题、磁盘上却是真名，两边对不上。
 * 事件字段先过 safeNameText / safePathText —— URL 与 query 因此仍然没有入口。
 */
function adoptResolvedName(record, event) {
  const e = event || {};
  // 绝对 URL 一律不采纳：落盘层给的真名里不可能有「协议://」，有就说明这字段不是名字。
  const absolute = function (value) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(value == null ? '' : value).trim());
  };
  const name = absolute(e.name) ? '' : safeNameText(e.name);
  if (name) record.name = name;
  if (absolute(e.path)) return;
  const dir = safePathText(e.path).replace(/^\/+|\/+$/g, '').replace(/\/[^/]*$/, '');
  if (dir) record.path = dir;
}

/** 相对路径：目录段 + 文件名；绝对 URL 只留 pathname。 */
function entryPathText(entry) {
  const e = entry || {};
  const segments = Array.isArray(e.folderPath) ? e.folderPath : [];
  if (segments.length) {
    return segments
      .map(function (part) {
        return safePathText(part);
      })
      .join(' / ');
  }
  return safePathText(e.path || '');
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
      if (statusEl) statusEl.textContent = '出错了：' + quietText(redactUrlText(message));
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
  let onResume = typeof opts.onResume === 'function' ? opts.onResume : null;
  /** 停机横幅上海一个按钮的回调；缺省时不渲染那个按钮。 */
  let onResumePending = typeof opts.onResumePending === 'function' ? opts.onResumePending : null;
  /** 导出 / 导入清单：缺省时这两个控件一个都不渲染（不是禁用，是不存在）。 */
  let onExportManifest = typeof opts.onExportManifest === 'function' ? opts.onExportManifest : null;
  let onImportManifest = typeof opts.onImportManifest === 'function' ? opts.onImportManifest : null;

  injectStyles();

  const timers = [];
  let current = 'idle';
  let context = { entryCount: 0, message: '' };
  let watchdog = 0;
  let destroyed = false;
  /** 进度样本：只用来估剩余时间，不参与节流（节流在数据层）。 */
  let sample = null;
  /** 文件级重试计数（同一文件连续 retry 累加，换文件归零）：setDownloadProgress 维护。 */
  const retries = new Map();
  /** 失败清单的唯一真相源：重试只改它，再整块重绘。 */
  let summaryState = { ok: 0, failed: [], aborted: false };
  /** 文件列表：fileOrder 决定行序，fileMap 存逐 entryId 的状态（重试计数也在这里，绝不跨行串台）。 */
  let fileOrder = [];
  let fileMap = new Map();
  const deliveredIds = new Set();
  let batchProgress = false;
  /** 停机横幅的当前文案；空串 = 没有停机。 */
  let haltText = '';
  /** 停机时没下载到的文件数（0 = 没停机）：顶部状态行与摘要头都靠它让位给「已暂停」。 */
  let haltPendingCount = 0;
  /** 自动恢复的轮次（0 = 没在恢复）：压过停机态，只报「正在自动恢复（第 N 次）」。 */
  let recoveringAttempt = 0;
  /** 收起条上的下载进度短串（如「下载 12/132」）：setDownloadProgress 维护，render 不重算。 */
  let downloadNote = '';

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
  // 课程标识常驻第一行：换课程时它是唯一能一眼看出来的东西。
  const courseEl = node('p', 'bbdl-course');
  courseEl.hidden = true;
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

  const noticeEl = node('p', 'bbdl-notice');
  noticeEl.hidden = true;

  // 停机横幅：文案固定，数字是未下载文件数；按钮只在调用方给了 onResumePending 时才存在。
  const haltEl = node('div', 'bbdl-halt');
  haltEl.setAttribute('role', 'alert');
  haltEl.hidden = true;

  // 可折叠「文件列表」：默认折叠（<details> 不带 open），行数上限 MAX_FILE_ROWS。
  const filesEl = node('details', 'bbdl-files');
  filesEl.hidden = true;
  const filesSummaryEl = node('summary', 'bbdl-files__summary', '文件列表');
  const filesBodyEl = node('div', 'bbdl-files__body');
  const filesMoreEl = node('p', 'bbdl-files__more');
  filesMoreEl.hidden = true;
  filesEl.appendChild(filesSummaryEl);
  filesEl.appendChild(filesBodyEl);
  filesEl.appendChild(filesMoreEl);

  // 可折叠「扫描历史」：没有历史时整块 hidden（见 setHistory），最多 MAX_HISTORY_ROWS 条。
  const historyEl = node('details', 'bbdl-history');
  historyEl.hidden = true;
  historyEl.appendChild(node('summary', 'bbdl-history__summary', '扫描历史'));
  const historyBodyEl = node('div', 'bbdl-history__body');
  historyEl.appendChild(historyBodyEl);

  // 上次的目录是「继续上次」的唯一入口：只有 hydrate 拿到句柄才会显示。
  const resumeEl = node('div', 'bbdl-resume');
  resumeEl.hidden = true;
  const resumeTextEl = node('span', 'bbdl-resume__text');
  const resumeBtn = button('bbdl-btn bbdl-btn--small', 'resume', '继续上次');
  resumeEl.appendChild(resumeTextEl);
  resumeEl.appendChild(resumeBtn);

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
  // 两行都只走既有 emitSettings(patch)；挂载时只读设置，绝不反写。
  const expandRow = node('label', 'bbdl-settings__row');
  const expandInput = node('input');
  expandInput.type = 'checkbox';
  expandInput.checked = settings.panelCollapsed === false;
  expandRow.appendChild(expandInput);
  expandRow.appendChild(node('span', null, '打开页面时展开面板'));
  settingsEl.appendChild(expandRow);

  const autoReloadRow = node('label', 'bbdl-settings__row');
  const autoReloadInput = node('input');
  autoReloadInput.type = 'checkbox';
  autoReloadInput.checked = settings.autoReload !== false;
  autoReloadRow.appendChild(autoReloadInput);
  autoReloadRow.appendChild(node('span', null, '会话异常时自动重载续跑'));
  settingsEl.appendChild(autoReloadRow);

  settingsEl.appendChild(node('p', 'bbdl-note', '目录结构开关在「选择并下载」对话框里。'));

  // 导出清单：纯本地动作（生成 Blob 下载），结果只走 notice 行，不弹窗。
  const exportRow = node('div', 'bbdl-settings__row');
  const exportBtn = button('bbdl-btn bbdl-btn--small', 'export-manifest', '导出清单');
  exportBtn.title = '把本课程的下载清单存成 JSON 文件（不含任何链接）';
  exportRow.appendChild(exportBtn);
  exportRow.hidden = !onExportManifest;
  settingsEl.appendChild(exportRow);

  // 导入清单：选一个 JSON 文件交给上层合并，结果同样只走 notice 行。
  const importRow = node('label', 'bbdl-settings__row');
  importRow.appendChild(node('span', null, '导入清单'));
  const importInput = node('input', 'bbdl-settings__file');
  importInput.type = 'file';
  importInput.accept = '.json,application/json';
  importRow.appendChild(importInput);
  importRow.hidden = !onImportManifest;
  settingsEl.appendChild(importRow);

  importInput.addEventListener('change', function () {
    const picked = importInput.files && importInput.files.length ? importInput.files[0] : null;
    // 立刻清空 value：同一个文件连着选两次也要能再触发一次 change。
    importInput.value = '';
    if (!picked || !onImportManifest) return;
    try {
      const pending = onImportManifest(picked);
      if (pending && typeof pending.catch === 'function') pending.catch(function () {});
    } catch (err) {
      render('error', { message: (err && err.message) || String(err) });
    }
  });

  const modeEl = node('p', 'bbdl-mode');
  modeEl.hidden = true;

  const summaryEl = node('div', 'bbdl-summary');
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

  // 收起态不是圆钮而是一条 ≤240×44 的条：标题 + 一行极短状态字 + 展开提示。
  const fab = button('bbdl-fab', 'expand', '');
  fab.title = '展开面板';
  fab.setAttribute('aria-expanded', 'false');
  const fabTitleEl = node('span', 'bbdl-fab__title', 'BB 批量下载');
  const fabStatusEl = node('span', 'bbdl-fab__status');
  const fabHintEl = node('span', 'bbdl-fab__hint', '点击展开');
  fab.appendChild(fabTitleEl);
  fab.appendChild(fabStatusEl);
  fab.appendChild(fabHintEl);

  root.appendChild(card);
  root.appendChild(fab);

  const host = document.body || document.documentElement;
  host.appendChild(root);
  // 挂载时只按已存设置应用形态，绝不反写 settings（刷新后保持上次状态）。
  setCollapsed(settings.panelCollapsed !== false, { persist: false });

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
      // 所有进 DOM 的错误文案都在这里过一遍脱敏，调用方不必记得这件事；命中红线的整句不上屏。
      message: nextContext && nextContext.message ? quietText(redactUrlText(nextContext.message)) : ''
    };

    root.dataset.state = next;
    const view = viewFor(next, context);
    // 恢复态压过一切：状态行只说「正在自动恢复（第 N 次）」，原因一个字都不提。
    if (recoveringAttempt > 0) {
      view.status = '正在自动恢复（第 ' + recoveringAttempt + ' 次）…';
    } else if (next === 'done' && haltPendingCount > 0) {
      // 停机收尾时 viewFor 给的是「已完成」，与正上方的停机横幅打脸：这里把状态行换成暂停口径。
      view.status = '已暂停，未下载 ' + haltPendingCount + ' 个文件。';
    }

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
    // 收起态只剩一条：状态字必须跟着状态机走，否则条上永远看不出在干什么。
    refreshFabStatus();

    if (next === 'scanning' || next === 'downloading') {
      summaryEl.hidden = true;
      summaryEl.textContent = '';
      if (next === 'downloading' && batchProgress) {
        paintBatchProgress();
        return;
      }
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

  /**
   * 收起 / 展开：只改类名与 aria，不重建 DOM。
   * persist:false 用于挂载时应用已存设置——那次不该写回。
   */
  function setCollapsed(collapsed, options) {
    const next = !!collapsed;
    root.classList.toggle('bbdl-panel--collapsed', next);
    fab.setAttribute('aria-expanded', next ? 'false' : 'true');
    if (!options || options.persist !== false) emitSettings({ panelCollapsed: next });
  }

  /** 收起条那一行极短状态字：停机 > 出错 > 下载 x/y > 扫描中；都没有就整块不占位。 */
  function refreshFabStatus() {
    if (destroyed) return;
    let text = '';
    if (recoveringAttempt > 0) text = '恢复中';
    else if (haltText) text = '已暂停';
    else if (current === 'error') text = '出错';
    else if (current === 'downloading') text = downloadNote || '下载中';
    else if (current === 'scanning') text = '扫描中';
    fabStatusEl.textContent = text;
    fabStatusEl.title = text;
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

  expandInput.addEventListener('change', function () {
    emitSettings({ panelCollapsed: !expandInput.checked });
  });

  autoReloadInput.addEventListener('change', function () {
    emitSettings({ autoReload: autoReloadInput.checked });
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
        setCollapsed(true);
        break;
      case 'expand':
        setCollapsed(false);
        break;
      case 'scan':
        if (onScan) onScan();
        break;
      case 'download':
        if (onDownload) onDownload();
        break;
      case 'resume':
        // 铁律：这一层不许 await —— 处理器必须同步把 ensureDirectoryPermission 发出去。
        if (onResume) onResume();
        break;
      case 'resume-pending':
        // 唯一调用点：一次点击只进一次这里，绝不另挂第二个监听器（否则会调两次）。
        if (onResumePending) onResumePending();
        break;
      case 'export-manifest':
        if (onExportManifest) onExportManifest();
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
    // 新一轮开始（扫描 / 下载）：上一批的停机数字与进度短串都不许泄漏进来。
    if (state === 'scanning' || state === 'downloading') {
      haltPendingCount = 0;
      recoveringAttempt = 0;
      downloadNote = '';
    }
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

  function paintBatchProgress() {
    const total = fileOrder.length;
    const done = deliveredIds.size;
    setBar(total ? done / total * 100 : 0);
    downloadNote = '已完成 ' + done + ' / ' + total;
    progressTextEl.textContent = downloadNote + ' 个文件';
    progressTextEl.title = progressTextEl.textContent;
    refreshFabStatus();
  }

  function continueBatch() {
    batchProgress = true;
    clearHalted();
    setNotice('');
    paintBatchProgress();
  }

  function setDownloadProgress(progress) {
    if (destroyed) return;
    const p = progress || {};
    if (p.state === 'file-done' && fileMap.has(String(p.entryId))) deliveredIds.add(String(p.entryId));
    if (batchProgress) {
      paintBatchProgress();
      return;
    }
    const filesDone = pickNumber(p, ['filesDone', 'done'], 0);
    const filesTotal = pickNumber(p, ['filesTotal', 'total'], 0);
    const bytesDone = pickNumber(p, ['bytesDone', 'bytes'], 0);
    const bytesTotal = pickNumber(p, ['bytesTotal'], 0);
    const failedCount = pickNumber(p, ['failed'], 0);

    progressEl.hidden = false;
    const ratio = bytesTotal > 0 ? bytesDone / bytesTotal : filesTotal > 0 ? filesDone / filesTotal : 0;
    setBar(ratio * 100);

    let text = progressLine(p, sample);
    if (p.state === 'start') retries.clear();
    const key = p.entryId || p.currentPath || p.path || '';
    const retryState = trackRetry(retries.get(key), p);
    if (retryState.count) retries.set(key, retryState);
    else retries.delete(key);
    text += retryLine(retryState, text);
    if (failedCount) text += ' · 失败 ' + failedCount;
    progressTextEl.textContent = text;
    progressTextEl.title = text;
    downloadNote = filesTotal > 0 ? '下载 ' + filesDone + '/' + filesTotal : '下载中';
    refreshFabStatus();

    // 采样窗口 ≥ 800ms：太密的样本会把速率算成噪声，太稀又会长时间不刷新 ETA。
    const now = Date.now();
    if (!sample || now - sample.at >= 800) sample = { at: now, bytes: bytesDone };
  }

  /** 临时提示（降级说明、跳过结果）。与状态行分开：render() 会重写状态行，不该把提示冲掉。 */
  function setNotice(text) {
    if (destroyed) return;
    const value = text == null ? '' : quietText(redactUrlText(String(text)));
    noticeEl.textContent = value;
    noticeEl.hidden = !value;
    noticeEl.title = value;
  }

  /** 当前课程标识：优先课程名，取不到就用 courseId；两个都拿不到就整行收起。 */
  function setCourse(courseId, courseName) {
    if (destroyed) return;
    const id = safePathText(courseId);
    const name = safeNameText(courseName);
    const text = name ? '当前课程：' + name + (id && name !== id ? '（' + id + '）' : '') : id ? '当前课程：' + id : '';
    courseEl.textContent = text;
    courseEl.title = text;
    courseEl.hidden = !text;
  }

  /** 扫描历史：最多 MAX_HISTORY_ROWS 条，每条可展开看最多 MAX_HISTORY_PATHS 行变更路径。 */
  function setHistory(scans) {
    if (destroyed) return;
    historyBodyEl.textContent = '';
    const list = Array.isArray(scans) ? scans.slice(0, MAX_HISTORY_ROWS) : [];
    let rows = 0;
    for (const scan of list) {
      if (!scan || typeof scan !== 'object') continue;
      const item = node('details', 'bbdl-history__item');
      const rowText = historyLineText(scan);
      const rowEl = node('summary', 'bbdl-history__row', rowText);
      rowEl.title = rowText;
      item.appendChild(rowEl);
      const paths = Array.isArray(scan.changedPaths) ? scan.changedPaths.slice(0, MAX_HISTORY_PATHS) : [];
      const ul = node('ul', 'bbdl-history__paths');
      for (const pathItem of paths) {
        const raw = pathItem && typeof pathItem === 'object' ? pathItem.path : pathItem;
        const text = safePathText(raw);
        if (!text) continue;
        const li = node('li', 'bbdl-history__path', text);
        li.title = text;
        ul.appendChild(li);
      }
      if (ul.childNodes.length) item.appendChild(ul);
      historyBodyEl.appendChild(item);
      rows += 1;
    }
    historyEl.hidden = rows === 0;
  }

  /** info = { dirName, granted }；没有上次目录时传 null 收起整块。 */
  function setResume(info) {
    if (destroyed) return;
    const visible = !!(info && info.dirName);
    resumeEl.hidden = !visible;
    if (!visible) {
      resumeTextEl.textContent = '';
      return;
    }
    const granted = info.granted !== false;
    resumeTextEl.textContent = '上次保存到「' + info.dirName + '」，可继续' + (granted ? '' : '（需要再确认一次目录权限）');
    resumeTextEl.title = resumeTextEl.textContent;
  }

  const MODE_TEXT = {
    fs: '落盘方式：保存到文件夹（Chromium）——直接写入你选的目录，保留原目录结构。代价：每次下载都要重新选一次文件夹，且只有 Chromium 系浏览器支持。',
    zip: '落盘方式：按文件夹打包成 .zip（存到浏览器默认下载目录）——没有目录写入权限时自动退到这种方式，解压后即可还原原目录结构。ZIP 并发为 1，逐个读取并封包。包内部分文件失败时，可以单独重试缺少的文件。',
    download:
      '落盘方式：逐文件下载（进浏览器默认下载目录）——网页拿不到目录写权限，文件名用 folder__ 前缀代替子目录。代价：所有文件都落在默认下载目录里，无法建子目录，文件多时会连续弹出多个下载。另外这里只能按下载清单跳过已下过的文件，无法核实磁盘文件。'
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
        const reason = stripUrlText((item && item.error) || '未知错误');
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

  /**
   * 摘要头这一行的唯一出口。停机时 pending 不是失败：不出现「失败」二字，
   * 只有真的 failed 非空才追加「，失败 Y 个」；没停机就逐字走原来的句式。
   */
  function summaryHeadText(staged) {
    const prefix = staged.aborted ? '已取消（部分完成）：' : '下载完成：';
    if (haltPendingCount <= 0) return prefix + '成功 ' + staged.ok + ' 个，失败 ' + staged.failed.length + ' 个';
    const head = (staged.aborted ? '已取消（部分完成）：' : '已暂停：') + '成功 ' + staged.ok + ' 个，未下载 ' + haltPendingCount + ' 个';
    return staged.failed.length ? head + '，失败 ' + staged.failed.length + ' 个' : head;
  }

  function renderSummary() {
    if (destroyed) return;
    summaryEl.textContent = '';
    summaryEl.hidden = false;

    const staged = summaryState;
    summaryEl.appendChild(node('p', 'bbdl-summary__head', summaryHeadText(staged)));

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
      const reasonEl = node('span', 'bbdl-failed__reason', quietReasonText(stripUrlText((item && item.error) || '未知错误')));
      reasonEl.title = reasonEl.textContent;
      li.appendChild(nameEl);
      li.appendChild(pathEl);
      li.appendChild(reasonEl);
      // 建议是固定文案，不掺任何来自网络的内容：失败项的 URL 只活在 item.url 里，永远不进 DOM。
      const hint = retryHintText(item && item.error);
      if (hint) {
        const hintEl = node('span', 'bbdl-failed__hint', hint);
        hintEl.title = hint;
        li.appendChild(hintEl);
      }
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
        summaryState = { ok: result.batchOkCount ?? (summaryState.ok + okList.length), failed: failed, aborted: !!result.aborted };
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

  /** 画一行：名称 / 状态 / 字节 / 重试次数，路径单独一行灰字。 */
  function makeFileRow(record) {
    const row = node('div', 'bbdl-files__row');
    row.dataset.entryId = safeNameText(record.id);
    const els = {
      row: row,
      name: node('span', 'bbdl-files__name'),
      status: node('span', 'bbdl-files__status'),
      bytes: node('span', 'bbdl-files__bytes'),
      retry: node('span', 'bbdl-files__retry'),
      path: node('span', 'bbdl-files__path')
    };
    row.appendChild(els.name);
    row.appendChild(els.status);
    row.appendChild(els.bytes);
    row.appendChild(els.retry);
    row.appendChild(els.path);
    return els;
  }

  /** 行内容只从 record 读：事件字段不直接进 DOM，URL query 因此没有入口。 */
  function paintFileRow(record) {
    const els = record.els;
    if (!els) return;
    const key = FILE_STATUS_TEXT[record.status] ? record.status : 'waiting';
    els.name.textContent = record.name || '(未命名文件)';
    els.name.title = record.name || '';
    els.status.textContent = FILE_STATUS_TEXT[key];
    els.status.className = 'bbdl-files__status bbdl-files__status--' + key;
    els.bytes.textContent = record.bytes == null ? '—' : formatBytes(record.bytes);
    // 重试次数 = 事件给的「第几次尝试」；只有真重试过（≥ 第 2 次）才显示数字。
    els.retry.textContent = record.attempt >= 2 ? record.attempt + ' 次' : '—';
    els.retry.title = record.attempt >= 2 ? '第 ' + record.attempt + ' 次尝试' : '未重试';
    els.path.textContent = record.path || '';
    els.path.title = record.path || '';
    els.path.hidden = !record.path;
    els.row.dataset.status = record.status;
  }

  /** 整块重画文件列表：只在 setFiles 时走这条路，事件走 paintFileRow 的原地更新。 */
  function renderFiles() {
    if (destroyed) return;
    filesBodyEl.textContent = '';
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
    // 超出行数上限的条目一个节点都不建，els 置空后事件只改状态、不碰 DOM。
    for (let i = shown; i < fileOrder.length; i += 1) {
      const extra = fileMap.get(fileOrder[i]);
      if (extra) extra.els = null;
    }
    const rest = fileOrder.length - shown;
    filesMoreEl.hidden = rest <= 0;
    filesMoreEl.textContent = rest > 0 ? '其余 ' + rest + ' 个文件未展开' : '';
    filesEl.hidden = fileOrder.length === 0;
    filesSummaryEl.textContent = '文件列表（' + fileOrder.length + '）';
  }

  /** 种子行：只种数据不猜状态；同名 entryId 只留第一行。 */
  function setFiles(entries) {
    if (destroyed) return;
    // 新一批种子行 = 新账本：上一批的停机数字作废。
    haltPendingCount = 0;
    const list = Array.isArray(entries) ? entries : [];
    const nextOrder = [];
    const nextMap = new Map();
    for (const entry of list) {
      const id = entryIdOf(entry);
      if (!id || nextMap.has(id)) continue;
      const size = finiteNumber(entry && entry.size);
      nextMap.set(id, {
        id: id,
        name: safeNameText(entry && entry.name),
        path: entryPathText(entry),
        status: seedFileStatus(entry),
        bytes: size != null && size >= 0 ? size : null,
        attempt: 0,
        els: null
      });
      nextOrder.push(id);
    }
    deliveredIds.clear();
    for (const record of nextMap.values()) {
      if (record.status === 'done') deliveredIds.add(record.id);
    }
    batchProgress = deliveredIds.size > 0;
    fileOrder = nextOrder;
    fileMap = nextMap;
    renderFiles();
  }

  function countPendingRows() {
    let pending = 0;
    for (const record of fileMap.values()) {
      if (record.status === 'waiting' || record.status === 'running') pending += 1;
    }
    return pending;
  }

  function paintHalt() {
    haltEl.textContent = '';
    // 恢复中不播报停机：横幅整个收起（haltText 留着，clearRecovering 时原样回来）。
    if (!haltText || recoveringAttempt > 0) {
      haltEl.hidden = true;
      return;
    }
    const textEl = node('span', 'bbdl-halt__text', haltText);
    textEl.title = haltText;
    haltEl.appendChild(textEl);
    // 没有 onResumePending 就一个按钮都不渲染（不是禁用，是不存在）。
    if (onResumePending) haltEl.appendChild(button('bbdl-btn bbdl-btn--small', 'resume-pending', '继续'));
    haltEl.hidden = false;
  }

  /** 停机横幅：只说状态，只有「N 个未下载」随 pendingCount 变；原因一个字都不上屏。 */
  function setHalted(info) {
    if (destroyed) return;
    const i = info || {};
    const given = finiteNumber(i.pendingCount);
    const pending = given != null && given >= 0 ? Math.floor(given) : countPendingRows();
    haltPendingCount = pending;
    haltText = '已暂停（' + pending + ' 个未下载）。';
    paintHalt();
    refreshFabStatus();
  }

  function clearHalted() {
    if (destroyed) return;
    haltPendingCount = 0;
    haltText = '';
    haltEl.textContent = '';
    haltEl.hidden = true;
    refreshFabStatus();
  }

  /** 自动恢复中：状态行报「第 N 次」、收起条报「恢复中」、横幅收起；与停机态并存，恢复态优先。 */
  function setRecovering(info) {
    if (destroyed) return;
    const i = info || {};
    const given = finiteNumber(i.attempt);
    recoveringAttempt = given != null && given >= 1 ? Math.floor(given) : 1;
    paintHalt();
    render(current, context);
  }

  /** 恢复结束：回到调用前的状态（停机的话横幅与暂停口径的状态行原样回来）。 */
  function clearRecovering() {
    if (destroyed) return;
    recoveringAttempt = 0;
    paintHalt();
    render(current, context);
  }

  /** 逐文件事件：只按 entryId 更新自己那一行，重试计数天然互不污染。 */
  function applyFileEvent(event) {
    if (destroyed) return;
    const e = event || {};
    const type = typeof e.type === 'string' ? e.type : '';
    if (type === 'halt') {
      // 停机后在飞的文件不会再继续：状态退回「等待」，横幅数字用事件给的 pending。
      for (const record of fileMap.values()) {
        if (record.status === 'running') {
          record.status = 'waiting';
          paintFileRow(record);
        }
      }
      setHalted({ reason: e.reason, pendingCount: e.pending });
      return;
    }
    if (type !== 'start' && type !== 'retry' && type !== 'done' && type !== 'failed') return;
    const record = fileMap.get(e.entryId == null ? '' : String(e.entryId));
    // setFiles 没种下这一行就忽略：绝不为陌生 entryId 凭空造行。
    if (!record) return;
    const attempt = finiteNumber(e.attempt);
    if (type === 'retry') {
      record.status = 'running';
      record.attempt = attempt != null && attempt >= 1 ? Math.floor(attempt) : record.attempt + 1;
    } else if (type === 'start') {
      record.status = 'running';
      if (attempt === 1) record.attempt = 1;
      else if (attempt != null && attempt > 1) record.attempt = Math.floor(attempt);
    } else if (type === 'done') {
      record.status = 'done';
      const bytes = finiteNumber(e.bytes);
      if (bytes != null && bytes >= 0) record.bytes = bytes;
      adoptResolvedName(record, e);
    } else {
      record.status = 'failed';
      adoptResolvedName(record, e);
    }
    paintFileRow(record);
  }


  /** 二次注入时把最新闭包接进同一份 DOM：面板继续工作，回调指向最新的调用方。 */
  function rebind(next) {
    const o = next || {};
    if (o.settings) {
      settings = o.settings;
      probeInput.checked = settings.probeSizes !== false;
      concInput.value = String(settings.downloadConcurrency || 4);
      expandInput.checked = settings.panelCollapsed === false;
      autoReloadInput.checked = settings.autoReload !== false;
    }
    if (typeof o.onScan === 'function') onScan = o.onScan;
    if (typeof o.onDownload === 'function') onDownload = o.onDownload;
    if (typeof o.onCancel === 'function') onCancel = o.onCancel;
    if (typeof o.onSettingsChange === 'function') onSettingsChange = o.onSettingsChange;
    if (typeof o.onRetryFailed === 'function') onRetryFailed = o.onRetryFailed;
    if (typeof o.onResume === 'function') onResume = o.onResume;
    if (typeof o.onResumePending === 'function') onResumePending = o.onResumePending;
    if (typeof o.onExportManifest === 'function') onExportManifest = o.onExportManifest;
    if (typeof o.onImportManifest === 'function') onImportManifest = o.onImportManifest;
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
    setState: setState,
    setCount: setCount,
    setScanProgress: setScanProgress,
    setDownloadProgress: setDownloadProgress,
    setMode: setMode,
    setNotice: setNotice,
    setResume: setResume,
    setFiles: setFiles,
    applyFileEvent: applyFileEvent,
    setHalted: setHalted,
    clearHalted: clearHalted,
    continueBatch,
    setRecovering: setRecovering,
    clearRecovering: clearRecovering,
    showSummary: showSummary,
    setCourse: setCourse,
    setHistory: setHistory,
    rebind: rebind,
    fail: fail,
    destroy: destroy
  };

  root.__bbdlApi = api;
  render('idle', {});
  return api;
}
