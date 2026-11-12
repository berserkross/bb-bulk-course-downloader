// Windows 安全的路径段处理。纯函数：不得 import 任何浏览器 API。

const ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
const TRAILING_JUNK = /[\s.]+$/u;
const LEADING_BLANKS = /^[ ]+/u;
const MAX_BYTES = 255;
const encoder = new TextEncoder();

const RESERVED_NAMES = new Set(['con', 'prn', 'aux', 'nul']);
for (let i = 1; i <= 9; i += 1) {
  RESERVED_NAMES.add('com' + i);
  RESERVED_NAMES.add('lpt' + i);
}

function byteLength(text) {
  return encoder.encode(String(text)).length;
}

function splitExt(name) {
  const text = String(name);
  const dot = text.lastIndexOf('.');
  if (dot <= 0) return { stem: text, ext: '' };
  return { stem: text.slice(0, dot), ext: text.slice(dot) };
}

function cutUtf8(text, maxBytes) {
  if (maxBytes <= 0) return '';
  let out = '';
  let used = 0;
  for (const ch of String(text)) {
    const size = encoder.encode(ch).length;
    if (used + size > maxBytes) break;
    out += ch;
    used += size;
  }
  return out;
}

function stripTrailing(text) {
  return String(text).replace(TRAILING_JUNK, '');
}

/**
 * 百分号解码；不是合法编码时原样返回。
 * @param {string} raw
 * @returns {string}
 */
export function decodeName(raw) {
  if (typeof raw !== 'string') return '';
  if (!/%[0-9a-fA-F]{2}/.test(raw)) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * 从最终 URL 取 basename 并解码（无 Content-Disposition 时的兜底文件名）。
 * @param {string} url
 * @returns {string}
 */
export function nameFromUrl(url) {
  if (!url) return '';
  let pathname;
  try {
    pathname = new URL(String(url), 'http://localhost/').pathname;
  } catch {
    pathname = String(url).split('#')[0].split('?')[0];
  }
  const parts = pathname.split('/').filter(Boolean);
  const last = parts.length ? parts[parts.length - 1] : '';
  return decodeName(last);
}

function escapeReserved(name) {
  const dot = name.indexOf('.');
  const base = dot === -1 ? name : name.slice(0, dot);
  if (!RESERVED_NAMES.has(base.trim().toLowerCase())) return name;
  return base + '_' + (dot === -1 ? '' : name.slice(dot));
}

function truncateName(name) {
  if (byteLength(name) <= MAX_BYTES) return name;
  const { stem, ext } = splitExt(name);
  const extBytes = byteLength(ext);
  const keepExt = extBytes > 0 && extBytes < MAX_BYTES / 2;
  const budget = keepExt ? MAX_BYTES - extBytes : MAX_BYTES;
  const head = stripTrailing(cutUtf8(stem, budget));
  const out = head + (keepExt ? ext : '');
  return out || '_';
}

/**
 * Windows 安全化一个路径段（文件夹名或文件名）。
 * @param {string} name
 * @returns {string}
 */
export function sanitizeSegment(name) {
  let text = decodeName(typeof name === 'string' ? name : name == null ? '' : String(name));
  text = text.replace(ILLEGAL_CHARS, '_');
  text = text.replace(LEADING_BLANKS, '');
  text = stripTrailing(text);
  if (!text || text === '.' || text === '..') text = '_';
  return truncateName(escapeReserved(text));
}

/**
 * @param {{ name?: string, folderPath?: string[] }} entry
 * @param {{ preserveTree?: boolean }} [options]
 * @returns {{ segments: string[], fileName: string }}
 */
export function buildEntryPath(entry, options) {
  const opts = options || {};
  const preserveTree = opts.preserveTree !== false;
  const source = entry || {};
  const rawPath = Array.isArray(source.folderPath) ? source.folderPath : [];
  const segments = rawPath
    .map((segment) => sanitizeSegment(segment == null ? '' : String(segment)))
    .filter((segment) => segment !== '');
  const fileName = sanitizeSegment(source.name == null ? '' : String(source.name));
  if (preserveTree) return { segments, fileName };
  if (!segments.length) return { segments: [], fileName };
  return { segments: [], fileName: truncateName(segments.concat(fileName).join('__')) };
}

function pathKey(segments, fileName) {
  return segments.concat([fileName]).join('/').toLowerCase();
}

/**
 * 同目录同名冲突时追加 " (2)"、" (3)"。
 * 兼容 buildEntryPath 的 { segments, fileName } 与 Entry 的 { folderPath, name }。
 * @param {Array<{ segments?: string[], fileName?: string, name?: string }>} list
 * @returns {Array<{ segments: string[], fileName: string }>}
 */
export function dedupePaths(list) {
  const used = new Set();
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    const source = item || {};
    const segments = Array.isArray(source.segments)
      ? source.segments.map(String)
      : Array.isArray(source.folderPath)
        ? source.folderPath.map(String)
        : [];
    const original = String(source.fileName != null ? source.fileName : source.name != null ? source.name : '');
    const { stem, ext } = splitExt(original);
    let candidate = original;
    let n = 1;
    while (used.has(pathKey(segments, candidate))) {
      n += 1;
      candidate = stem + ' (' + n + ')' + ext;
    }
    used.add(pathKey(segments, candidate));
    out.push(Object.assign({}, source, { segments, fileName: candidate }));
  }
  return out;
}

const MIME_EXTENSIONS = new Map([
  ['application/pdf', '.pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  ['application/msword', '.doc'],
  ['application/vnd.ms-powerpoint', '.ppt'],
  ['application/vnd.ms-excel', '.xls'],
  ['application/zip', '.zip'],
  ['text/plain', '.txt'],
  ['text/csv', '.csv'],
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/gif', '.gif'],
  ['application/octet-stream', '']
]);

/**
 * MIME → 带点后缀。未知类型返回空串，调用方据此决定是否补后缀。
 * @param {string} mime content-type 去掉 charset 之后的小写 MIME
 * @returns {string}
 */
/** 往年卷关键词：只在「文件名或所在文件夹」命中时才算，宁可漏判也不误判。 */
const EXAM_RE = /(^|[^a-z])(exam|midterm|final)([^a-z]|$)|真题|试卷|期末|期中|往年|考试/i;

/** 是否为「往年卷/试题」类文件：判定只看名字，不读内容（内容哈希不在本项目的取舍之内）。 */
export function isExamLike(name) {
  const text = String(name == null ? '' : name).trim();
  if (!text) return false;
  return EXAM_RE.test(text);
}

export function extensionForMime(mime) {
  if (typeof mime !== 'string') return '';
  const key = mime.trim().toLowerCase();
  const ext = MIME_EXTENSIONS.get(key);
  return ext == null ? '' : ext;
}

const EXT_TAIL = /\.([A-Za-z0-9]{1,8})$/;
const PLACEHOLDER_STEM = /^(?:xid|pid)-/i;

/**
 * 判断一个 URL 末段/字符串是否像真文件名（BB 的 xid-/pid- 末段是资源 id，不是名字）。
 * @param {string} name
 * @returns {boolean}
 */
export function looksLikeFileName(name) {
  if (typeof name !== 'string' || name === '') return false;
  if (/[\\/]/.test(name)) return false;
  if (!EXT_TAIL.test(name)) return false;
  return !PLACEHOLDER_STEM.test(name);
}

const RFC5987_VALUE = /^[^']*'[^']*'(.*)$/;
const STAR_FILENAME = /filename\*\s*=\s*(?:"([^"]*)"|([^;]*))/i;
const PLAIN_FILENAME = /filename\s*=\s*(?:"([^"]*)"|([^;]*))/i;

function headerValue(match) {
  if (!match) return '';
  const raw = match[1] != null ? match[1] : match[2];
  return raw == null ? '' : raw.trim();
}

function starFileName(disposition) {
  const value = headerValue(STAR_FILENAME.exec(disposition));
  if (!value) return '';
  const encoded = RFC5987_VALUE.exec(value);
  return decodeName((encoded ? encoded[1] : value).trim());
}

function plainFileName(disposition) {
  return decodeName(headerValue(PLAIN_FILENAME.exec(disposition)));
}

function lastSegmentHasDot(name) {
  const parts = String(name).split(/[\\/]/);
  const last = parts[parts.length - 1];
  return last.includes('.');
}

/**
 * 按 fork 原实现的顺序定名：Content-Disposition → 重定向后的 URL 末段 → 显示标题。
 * 只产名字，不负责 sanitizeSegment；拿不到任何线索返回空串，由调用方保留原文件名。
 * @param {{ disposition?: string, finalUrl?: string, href?: string, title?: string, mime?: string }} [input]
 * @returns {string}
 */
export function resolveFileName(input) {
  const source = input || {};
  const disposition = typeof source.disposition === 'string' ? source.disposition : '';
  const title = typeof source.title === 'string' ? source.title.trim() : '';
  const mime = typeof source.mime === 'string' ? source.mime : '';

  let name = disposition ? starFileName(disposition) || plainFileName(disposition) : '';
  if (!name) {
    const fromUrl = nameFromUrl(source.finalUrl);
    if (fromUrl && looksLikeFileName(fromUrl) && fromUrl !== nameFromUrl(source.href)) name = fromUrl;
  }
  if (!name) name = title;
  if (!name) return '';

  if (title && !lastSegmentHasDot(name)) {
    if (lastSegmentHasDot(title)) {
      name = title;
    } else {
      const ext = extensionForMime(mime);
      if (ext) name = title + ext;
    }
  }
  return name;
}
