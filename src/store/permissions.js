/**
 * 目录授权状态的查询 / 申请。
 *
 * 只返回四态，调用方（UI）只能据此分支：
 * - 'granted'     已授权，可以直接读写
 * - 'prompt'      还没问过 / 上次的答案没记住 —— 需要在用户手势里再问一次
 * - 'denied'      用户或策略明确拒绝
 * - 'unsupported' 没有 handle，或这个环境没有权限 API —— 只能退化为「按清单跳过」
 *
 * 铁律：requestPermission() 必须落在用户点击的同一个同步调用栈里。
 * 本函数在调用它之前不做任何 await（进入 async 函数到第一个 await 之间是同步执行的），
 * 所以只要调用方在点击处理器里直接调用本函数，用户手势就还在。
 */

const KNOWN = new Set(['granted', 'prompt', 'denied']);

/** 没见过的返回值一律按 prompt 处理：绝不把「不知道」说成 granted，也不误报 denied。 */
function normalize(value) {
  return KNOWN.has(value) ? value : 'prompt';
}

/**
 * @param {object | null | undefined} handle FileSystemDirectoryHandle
 * @param {{ mode?: 'read' | 'readwrite', request?: boolean }} [options]
 * @returns {Promise<'granted' | 'prompt' | 'denied' | 'unsupported'>}
 */
export async function ensureDirectoryPermission(handle, { mode = 'readwrite', request = false } = {}) {
  if (!handle) return 'unsupported';
  const options = { mode };
  try {
    if (request && typeof handle.requestPermission === 'function') {
      return normalize(await handle.requestPermission(options));
    }
    if (typeof handle.queryPermission === 'function') {
      return normalize(await handle.queryPermission(options));
    }
    return 'unsupported';
  } catch {
    // 授权失败绝不上抛：NotAllowedError（手势过期）、SecurityError 都只是一句话的事由，
    // 由 UI 退化到「按清单跳过」，而不是把整条下载流程带崩。
    return 'denied';
  }
}
