# M3 契约：逐文件状态 · 会话过期停机 · ZIP 降级落盘

三个模块并行开发，本文件是唯一的接口来源。任何改动先改这里，再改代码。

## 1 逐文件事件（sink → UI）

`sink.download(entries, fetcher, { onProgress, onFileEvent })`，`onFileEvent` 可选；
缺省时 sink 行为必须与现状完全一致（既有 236 条测试一条不许删）。

事件形状：

```js
{ type: 'start'|'retry'|'done'|'failed'|'halt',
  entryId: string, path: string, name: string,
  bytes?: number, attempt?: number, reason?: string, error?: string, pending?: number }
```

- `start`：每次尝试开始都发，`attempt` 从 1 起。
- `retry`：第 N 次尝试失败、即将开始第 N+1 次之前发，`attempt = N+1`，`reason` 是一句人话（如「连接超时」），不含 URL。
- `done`：`bytes` 必须是这个文件**最终落盘**的字节数（重试覆盖后仍然是它自己那一份，不是累加）。
- `failed`：`error` 已脱敏（复用 `redactUrls`），不带 URL query。
- `halt`：会话过期停机时发一次，`reason = 'session-expired'`，`pending` = 未下载的文件数。
- 顺序保证：同一 `entryId` 的 `start` 先于其 `done`/`failed`；`done` 与 `failed` 互斥且各最多一次。
- 事件不进入 `progressPayload`，既有字段（state/name/done/failed/total/bytes/filesDone/filesTotal/bytesDone/bytesTotal/currentPath/entryId）一个都不许删改语义。

## 2 会话过期停机

- 判定：fetch 抛出的错误 `name === 'SessionExpiredError'`（见 src/bb/http.js 的 assertAlive）。
- 该错误**永不重试**：`isRetriableError` 对它必须返回 false（现在会白重试一次）。
- 触发后：在飞文件自然结束；**不再启动新文件**；触发它的那个文件进 `pending`，**不进 failed**。
- `download()` 返回值增 `halted: { reason: string, pending: any[] } | null`；
  `aborted`（用户取消）与 `halted` 互斥，用户取消优先。
- `pool.js`：`runPool(items, concurrency, worker, { signal, control })`，
  `control = { stop(reason), stopped: boolean, reason: string }`；`stopped` 后 worker 不再启动新 job。

## 3 ZIP 降级落盘（非 FSA 浏览器）

- 新增 `src/sinks/zip-core.js`（纯函数、零依赖、可在 node 里直接测）：
  `crc32(bytes)`、`crc32Update(state, bytes)`、`dosDateTime(date)`、`localHeader(...)`、`dataDescriptor(...)`、`centralHeader(...)`、`endOfCentralDirectory(...)`。
  结构固定：STORE（method = 0，不压缩）+ data descriptor（通用位 3）+ UTF-8 文件名（通用位 11）。
  CRC32 必须通过标准检验值：`crc32('123456789') === 0xCBF43926`。
  单文件 ≥ 4 GiB 或条目数 > 65535 时抛 `UnsupportedZip64Error`——明确拒绝，绝不静默产出坏包。
- 新增 `src/sinks/zip.js`：`createZipSink({ settings, signal, total, files, sizeOf })` →
  `{ kind: 'zip', download(entries, fetcher, opts) }`，返回值形状与 `download`/`fs` sink 一致（含 `halted`）。
  分包：保留目录结构时按 `plan.segments[0]` 分组，组内累计超过 `settings.zipChunkBytes`（默认 200 MiB）再切包；
  不保留目录结构时整批一包。每包 = 边下边算 CRC 边拼字节 → 一个 Blob → `<a download download="<组名>.zip">`。
  内存上界是「一个包」，绝不整课进内存。失败重试沿用 `withFileRetry`（attempts = 1 + settings.fileRetries）。
  会话过期同样按 §2 停机。

## 4 UI（面板）

- `mountPanel` 返回的 api 增：`setFiles(entries)`（种子行）、`applyFileEvent(event)`、`setHalted({ reason, pendingCount })`、`clearHalted()`。
- 面板新增可折叠「文件列表」：每行 名称 / 状态（等待·下载中·完成·失败·跳过）/ 字节 / 重试次数；路径以灰字显示。
- 顶部保留现有单行摘要不动。
- 停机横幅：`登录已过期，已暂停。刷新页面重新登录后再继续（N 个未下载）。` + 一个按钮，回调由 `mountPanel` 的 `onResumePending` 提供。
- 重试计数改为按 `entryId` 存（现为单一 `retryState`，并发下串台）。
- DOM 行数上限 500，超出用一行「其余 N 个文件未展开」收口。
- 任何事件字段里的 URL / query 都不许进 DOM。

## 5 验收不变量

1. 同一 entryId 的 done / failed 各最多一次。
2. halt 之后，pending 里没有任何一条同时出现在 failed 里。
3. 会话过期只尝试 1 次（attempt 不增长），且不触发 retry 事件。
4. 批次结束时，逐文件 bytes 之和 = `progressPayload.bytesDone`。
5. 两个文件并发重试时，各自的重试计数互不污染。
6. 事件里、失败清单里、DOM 里都不出现 URL 的 query。
7. ZIP 包能被系统 unzip 正确解开（CRC 正确、目录层级与 plan 一致）。
8. 单包字节数不超过 `zipChunkBytes`（用缩小版 chunk 在测试里验，不做真实内存测量）。
