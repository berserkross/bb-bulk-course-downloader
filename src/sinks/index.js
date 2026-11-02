import { buildEntryPath, sanitizeSegment, dedupePaths } from '../bb/files.js';
import { pickDirectory } from './picker.js';
import { createFsSink } from './fs.js';
import { createDownloadSink } from './download.js';
import { createZipSink } from './zip.js';
import { listExistingFiles } from './existing.js';

export { pickDirectory, listExistingFiles };

/** files.js 是纯函数模块，注入给 sink 而不是让 sink 自己 import，便于单测脱离 FSA 运行。 */
const files = { buildEntryPath, sanitizeSegment, dedupePaths };

/**
 * 没有目录句柄时的默认落盘方式：STORE-only ZIP 分包。
 * 口径是「读取时兜底」而不是往 store 的 DEFAULTS 里塞一个新键：settings.fallbackSink 缺失
 * （老用户的库、单测里的裸对象）一律当 'zip'；只有显式写了 'files' 才回落到逐文件 <a download>。
 */
const DEFAULT_FALLBACK_SINK = 'zip';

function fallbackKindOf(settings) {
  const raw = settings ? settings.fallbackSink : null;
  return raw === 'files' ? 'files' : DEFAULT_FALLBACK_SINK;
}

/**
 * @param {{ settings?: object, dirHandle?: FileSystemDirectoryHandle|null,
 *           signal?: AbortSignal, total?: number,
 *           sizeOf?: (entry: any) => number|undefined }} [options]
 *   sizeOf 必须原样透传给每个 sink：截断校验与大文件串行都靠它，
 *   在工厂这一层把它吃掉，下游的加固会在真实运行路径上静默失效（单测直连 sink 时看不出来）。
 * @returns {{ kind: 'fs'|'zip'|'download',
 *            download: (entries: any[], fetcher: any,
 *                       opts?: { onProgress?: Function, onFileEvent?: (event: object) => void })
 *              => Promise<{ ok: any[],
 *                           failed: { entry: any, name: string, path: string, url: string, error: string }[],
 *                           aborted: boolean,
 *                           halted: { reason: string, pending: any[], pendingCount?: number } | null }> }}
 *   选择顺序：有目录句柄 → fs（唯一真正写盘的路径）；
 *             没有目录句柄且 settings.fallbackSink !== 'files' → zip（缺省）；
 *             没有目录句柄且 settings.fallbackSink === 'files' → download（逐文件 <a download> 逃生口）。
 *   注意 zip sink 不发逐文件事件（它的 download 只收 onProgress），所以那条路的清单靠扫描种子行 +
 *   progressPayload 撑着；halted 也只在 download sink 上是不可枚举属性。
 */
export function createSink({ settings = {}, dirHandle, signal, total = 0, sizeOf } = {}) {
  const deps = { settings, signal, total, files, sizeOf };
  if (dirHandle) return createFsSink({ ...deps, dirHandle });
  return fallbackKindOf(settings) === 'files' ? createDownloadSink(deps) : createZipSink(deps);
}
