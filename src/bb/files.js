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
