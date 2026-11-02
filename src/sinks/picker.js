/**
 * 目录选择器。
 *
 * 铁律：showDirectoryPicker 必须落在用户手势的同一个同步调用栈里。
 * 因此本文件不 import 任何东西、函数体内调用之前没有任何 await —— 只要多一个
 * await（哪怕只是 await 一个已 resolve 的 promise），Chrome 就会判定手势过期并
 * 抛 SecurityError，整个 FSA 落盘路径直接不可用。
 */

async function settle(pending, signal) {
  try {
    const handle = await pending;
    return signal && signal.aborted ? null : handle;
  } catch (err) {
    if (isAbort(err)) return null; // 用户点了取消
    throw err; // SecurityError 之类必须上抛：掩盖它等于把这个 bug 埋起来
  }
}

function isAbort(err) {
  return Boolean(err) && (err.name === 'AbortError' || err.code === 20);
}

/**
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<FileSystemDirectoryHandle|null>} 无 FSA 环境 / 用户取消 → null
 */
export function pickDirectory(options) {
  const signal = options && options.signal;
  // 同步守卫：不是 await，不会让用户手势过期。
  if (typeof window === 'undefined' || typeof window.showDirectoryPicker !== 'function') {
    return Promise.resolve(null);
  }
  return settle(window.showDirectoryPicker({ mode: 'readwrite' }), signal);
}
