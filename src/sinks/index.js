import { buildEntryPath, sanitizeSegment, dedupePaths } from '../bb/files.js';
import { pickDirectory } from './picker.js';
import { createFsSink } from './fs.js';
import { createDownloadSink } from './download.js';
import { listExistingFiles } from './existing.js';

export { pickDirectory, listExistingFiles };

/** files.js 是纯函数模块，注入给 sink 而不是让 sink 自己 import，便于单测脱离 FSA 运行。 */
const files = { buildEntryPath, sanitizeSegment, dedupePaths };

/**
 * @param {{ settings?: object, dirHandle?: FileSystemDirectoryHandle|null,
 *           signal?: AbortSignal, total?: number,
 *           sizeOf?: (entry: any) => number|undefined }} [options]
 *   sizeOf 必须原样透传给两个 sink：截断校验与大文件串行都靠它，
 *   在工厂这一层把它吃掉，下游的加固会在真实运行路径上静默失效（单测直连 sink 时看不出来）。
 * @returns {{ kind: 'fs'|'download',
 *            download: (entries: any[], fetcher: any, opts?: { onProgress?: Function })
 *              => Promise<{ ok: any[],
 *                           failed: { entry: any, name: string, path: string, url: string, error: string }[],
 *                           aborted: boolean }> }}
 */
export function createSink({ settings = {}, dirHandle, signal, total = 0, sizeOf } = {}) {
  const deps = { settings, signal, total, files, sizeOf };
  return dirHandle ? createFsSink({ ...deps, dirHandle }) : createDownloadSink(deps);
}
