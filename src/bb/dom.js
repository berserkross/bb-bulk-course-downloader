// listContent.jsp 解析。纯函数：不发请求，可在 jsdom 下测试。

import { nameFromUrl } from './files.js';

const FILE_SELECTOR = 'a[href*="/bbcswebdav/"]';
const FOLDER_SELECTOR = 'a[href*="listContent.jsp"]';
const RID_RE = /dt-content-rid-(\d+)/i;
// 只影响视图、不改变所指向内容的参数；比较「是否同一页面」时忽略。
const HARMLESS_PARAMS = new Set(['mode', 'list_display']);
// listContent.jsp 用自己的 form action 声明当前文件夹身份：入口 URL 不带 content_id 时，仅此可查。
const SELF_FORM_SELECTOR = 'form[name="contentForm"]';

function resolveUrl(raw, base) {
  if (!raw) return '';
  try {
    return new URL(raw, base || undefined).href;
  } catch {
    return '';
  }
}

function contentIdOf(url) {
  if (!url) return null;
  try {
    return new URL(url, 'http://localhost/').searchParams.get('content_id');
  } catch {
    return null;
  }
}

function normalizedQuery(url) {
  const pairs = [];
  for (const [key, value] of url.searchParams) {
    if (HARMLESS_PARAMS.has(key)) continue;
    pairs.push([key, value]);
  }
  pairs.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return pairs.map(([key, value]) => key + '=' + value).join('&');
}

// 参数顺序、"&mode=reset"、"&list_display=..." 都不改变「指向本页」这一事实。
function sameDocument(a, b) {
  if (!a || !b) return false;
  try {
    const left = new URL(a, 'http://localhost/');
    const right = new URL(b, 'http://localhost/');
    return (
      left.origin === right.origin &&
      left.pathname === right.pathname &&
      normalizedQuery(left) === normalizedQuery(right)
    );
  } catch {
    return false;
  }
}

function pageContentId(doc, base) {
  const fromUrl = contentIdOf(base);
  if (fromUrl) return fromUrl;
  const form = typeof doc.querySelector === 'function' ? doc.querySelector(SELF_FORM_SELECTOR) : null;
  if (!form) return null;
  return contentIdOf(resolveUrl(form.getAttribute('action') || '', base));
}

/**
 * @param {Document} doc
 * @param {string} pageUrl 当前页绝对 URL
 * @returns {{ files: import('./files.js').Entry[], folders: Array<{ url: string, name: string, id: string }> }}
 */
export function parseContentList(doc, pageUrl) {
  const result = { files: [], folders: [] };
  if (!doc || typeof doc.querySelectorAll !== 'function') return result;

  const base = pageUrl || doc.baseURI || undefined;
  const pageId = pageContentId(doc, base);
  const seenFiles = new Set();
  const seenFolders = new Set();

  for (const anchor of doc.querySelectorAll(FILE_SELECTOR)) {
    const href = anchor.getAttribute('href') || '';
    const url = resolveUrl(href, base);
    if (!url || seenFiles.has(url)) continue;
    seenFiles.add(url);
    const text = (anchor.textContent || '').trim();
    const rid = RID_RE.exec(url);
    result.files.push({
      id: rid ? 'dt-content-rid-' + rid[1] : url,
      href,
      url,
      name: text || nameFromUrl(url),
      folderPath: [],
      size: undefined
    });
  }

  for (const anchor of doc.querySelectorAll(FOLDER_SELECTOR)) {
    const href = (anchor.getAttribute('href') || '').trim();
    // "#" / "#content" 这类锚点会被解析成当前页，必须先排除，否则会被误判成子文件夹
    if (!href || href.charAt(0) === '#') continue;
    const url = resolveUrl(href, base);
    if (!url || seenFolders.has(url)) continue;
    if (sameDocument(url, base)) continue;
    const id = contentIdOf(url);
    if (!id) continue;
    if (pageId && id === pageId) continue;
    seenFolders.add(url);
    const text = (anchor.textContent || '').trim();
    result.folders.push({ url, name: text || id, id });
  }

  return result;
}
