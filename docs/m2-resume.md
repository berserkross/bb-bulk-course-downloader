# M2-A 契约：断点续传 / 跳过已存在文件

本文件是三个并行子任务的**唯一接口约定**。任何一方不得单方面改动签名；发现契约不可行，
先回报，不要自行改动后让另外两方编译不过。

## 背景事实（已核实，别再去查）

- `src/index.js:19` 的 `mount()` 在 `course_id` 或 `content_id` 缺失时直接 return。
- `src/index.js:126` `state.dirHandle = choice.dirHandle`：目录句柄由 `src/ui/select.js` 在
  用户点击的同步栈里通过 `src/sinks/picker.js` 的 `pickDirectory()` 取得。
  **铁律：`showDirectoryPicker` 与 `handle.requestPermission()` 必须落在用户手势的同一个同步调用栈里，
  调用之前不要有 await（哪怕已 resolve 的 promise 也会让手势过期）。**
- `src/sinks/shared.js` 的 `planBatch(list, { preserveTree, files })` 产出 `plan = { entry, segments, fileName }`，
  落盘相对路径 = `segments.concat(fileName).join('/')`（已有 `relativePath(plan)` 可直接用）。
- 进度 payload 形如 `{ state, filesDone, filesTotal, bytesDone, bytesTotal, currentPath, ... }`，
  `bytesTotal === 0` 表示总量未知，UI 侧**不得**因此显示 NaN/Infinity/0%。
- 设置存 `localStorage`（`src/store.js`，key `bb-bulk-course-downloader:settings:v1`）。
- 本仓库硬约束：**0 个新增 npm 依赖**；产物必须是单文件 userscript(`@grant none`)；
  UI 文案全中文；测试用 `node --test`，不允许引入 fake-indexeddb 之类的新包。

## 数据形状

```js
// 单个文件的清单记录
{ id: 'dt-content-rid-12071526', path: 'Week 3/slides.pdf', name: 'slides.pdf',
  size: 1234567, status: 'done' | 'failed' | 'partial', updatedAt: 1730000000000 }

// 一份清单
{ courseId: '_16517_1', version: 1, updatedAt: 1730000000000, files: { [entryId]: record } }
```

- `status === 'done'` 才允许据清单跳过；`'partial'`（下了一半）与 `'failed'` 都不跳过。
- `size` 未知时写 `null`，**不要写 0**。

## 模块 A（src/store/）—— 由 S4 交付

```js
// src/store/db.js  —— IndexedDB 薄封装，任何一步失败都不得抛，只能退化为不可用
export function makeStore({ indexedDB } = {})
  // 返回 { available: boolean, loadManifest(courseId), saveManifest(courseId, manifest),
  //        mergeFiles(courseId, records), clearManifest(courseId),
  //        loadHandle(courseId), saveHandle(courseId, handle), clearHandle(courseId) }
  // available === false 时全部方法 resolve null / false（无 IDB、隐私模式、被禁用）
  // 库名 'bb-bulk-course-downloader'，版本 1，三个 store：'manifests'、'handles'、'meta'（keyPath 'id'）
  // handles store 直接存 FileSystemDirectoryHandle（结构化克隆，Chromium 支持）

// src/store/permissions.js
export async function ensureDirectoryPermission(handle, { mode = 'readwrite', request = false } = {})
  // → 'granted' | 'prompt' | 'denied' | 'unsupported'
  // handle 为空 → 'unsupported'。request === true 时调 handle.requestPermission（调用方保证在用户手势里）。
  // 任何抛错都返回 'denied'，不要冒泡。

// src/store/manifest-plan.js —— 纯函数，无 IO，必须能被单测直接覆盖
export function planSkips({ plans, manifest, existingPaths, preserveTree = true })
  // plans: planBatch 的输出
  // manifest: 上面的清单形状，可为 null
  // existingPaths: Map<相对路径, 字节数 | null>（磁盘上已存在的文件）
  // →
  // {
  //   todo: [plan],                                        // 需要下载
  //   skip: [{ plan, reason: 'disk' | 'disk-unverified' | 'manifest', size: number|null }],
  //   stale: [{ id, path }],                               // 清单里有、本次扫描没有（绝不删本地文件，只报告）
  //   diff: { added: number, changed: number, unchanged: number, stale: number, total: number }
  // }
  // 判定顺序（先磁盘后清单）：
  //   1) existingPaths 有该路径且清单 size 与磁盘 size 相等 → skip reason 'disk'
  //   2) existingPaths 有该路径但两边 size 都不知道 → skip reason 'disk-unverified'
  //   3) existingPaths 有该路径但 size 不等 → 进 todo（视为上游更新过，要重下）
  //   4) 清单该 id 的 path 与本次一致且 status === 'done' → skip reason 'manifest'
  //   5) 其余进 todo
  //   diff.changed = 清单里 status 为 done 但本次 size/path 与清单不同的文件数

// src/store/manifest.js
export function updateRecords(manifest, plans, results, now)
  // 纯函数：把一次下载结果合并进清单，返回新清单（不改入参）
  // results: [{ id, status: 'done'|'failed'|'partial', size }]
export function recordFromPlan(plan, { status, size, now })
```

## 模块 B（src/sinks/）—— 由 S5 交付

```js
// src/sinks/existing.js
export async function listExistingFiles(dirHandle, { signal, maxFiles = 5000, maxDepth = 8 } = {})
  // → Map<相对路径（用 '/' 连接）, 字节数 | null>
  // 递归 dirHandle.values()；无 dirHandle / 权限被拒 / 迭代抛错 → 返回已收集到的部分，绝不抛。
  // 达到 maxFiles 或 maxDepth 就停（避免超大目录把页面卡死），并在返回的 Map 上挂一个
  // 非枚举属性 truncated = true|false 以便 UI 提示「目录太大，只比对了前 N 个」。
  // getFile() 取 size 失败时该条目的值写 null。
```

进度 payload 增补：`src/sinks/shared.js` 的 `progressPayload` 与 `createProgressTracker` 增加
`entryId` 字段（取 `plan.entry.id`），`fs.js`/`download.js` 在 `file-start`/`file-done`/`file-failed`
三处都要带上当前文件的 `entryId`；其余字段与语义保持不变（`bytesTotal` 仍恒 0）。
`src/sinks/index.js` 需额外导出 `listExistingFiles`。

## 模块 C（接线与 UI）—— 由 S6 交付

- `src/index.js`：mount 时 `store.loadHandle(courseId)` 与 `store.loadManifest(courseId)`；
  扫描完成后按「当前 plans + 清单 + 磁盘现状」算一次 `planSkips`，把结果交给对话框；
  下载时只把 `todo` 交给 sink；`onProgress` 见到 `file-done`/`file-failed` 时把
  `{ id: entryId, status, size }` 合并进清单（累计 8 条或经过 500 ms 即写入，按先到者触发）。
- `src/ui/select.js`：新增复选框「跳过已存在的文件（N 个，磁盘 M / 清单 K）」默认勾选；
  勾选状态变化只影响真正提交的 todo 集合，不影响行渲染；行内给被跳过的文件一个灰色标记。
- `src/ui/panel.js`：识别到上次的目录句柄时给一句「上次保存到「<目录名>」，可继续」，并提供
  「继续上次」按钮——**该按钮的点击处理器里同步调用 `ensureDirectoryPermission(handle, {request:true})`**，
  授权成功后直接走扫描 + 只下缺的；授权失败退化为普通流程并给出人话。
- 不可用降级：没有 FSA 的浏览器只能按清单跳过，文案必须写明「无法核实磁盘文件」。

## 三方共用的红线

- 不删本地任何文件；`stale` 只做提示。
- 不把 `entry.url` 或它的 query 渲染进 DOM。
- 新增 UI 文案全中文。
- 每个新增纯函数都要有单测，且测试名要写清「防的是哪个回归」。

## 复审裁定（调度者，M2-A 集成前生效）

- **跳过判定必须有状态守卫**：`src/store/manifest-plan.js:96-99` —— 磁盘上有同名文件但大小无法核实
  （两边都 null、或只有一边有值）时，若清单记录 `status !== 'done'`，一律进 `todo` 重下。
  理由：上一轮下到一半的半截文件会在磁盘留下同名残骸，只按「存在」跳过会把它永久当成已完成。
  磁盘大小**正向核实相等**，即使状态是 partial/failed 也照常跳过——那是核实过的证据，不是猜测。
- **`diff.changed` 口径**：定义为「清单说 done，但本次路径或大小变了」，只用于向用户解释
  「上游有更新」；UI 上「将下载 N 个」一律用 `todo.length`（含 partial/failed 的重下项），
  `stale` 只提示、不参与 todo。
- **一边有大小一边没有**：沿用 S4 的补全，跳过并标 `disk-unverified`（让 UI 说实话），
  而不是默认重下——重下几 MB 的成本高于多问一次，但需配上面那条守卫才安全。
- **中止扫描时的 `truncated`**：`listExistingFiles` 因 `signal` 中止而返回部分结果时 `truncated` 保持
  false（「目录太大只比对了前 N 个」不能用来描述中止）；调用方若需区分，自行持有 abort 状态。
- **`request:true` 的调用位置**：必须在用户点击的同一个同步栈里调用 `ensureDirectoryPermission`，
  不得先 `await` 别的异步再调，否则浏览器丢弃用户激活、授权必然失败。


同一下载控制器串行提交写入。收尾、停机、自动续跑前等待已经发起的写入。页面转入后台或触发 pagehide 时尽力提交剩余记录，浏览器进程被强制结束时仍可能丢失尚未提交的事务。记录含版本 href 和实际落盘路径，合并时保留扫描历史。

体积探测与版本 href 绑定。上游文件换版后，旧清单的大小不能用于新版本的截断校验。
