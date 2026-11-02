# M1 模块契约

本文件是并行开发的唯一接口真相。改动本文件必须由调度方发起。

## 页面事实（已实测，来自 bb.cuhk.edu.cn）

- 文件链接：`a[href*="/bbcswebdav/"]`，例 `/bbcswebdav/pid-660334-dt-content-rid-12444275_1/xid-12444275_1`
  - **路径尾部是 `xid-*`，不含文件名、不含扩展名。**
  - 中文名/空格名在跳转后的 URL 里是百分号编码，**必须 decodeURIComponent**。
  - 响应头 **没有 Content-Disposition**，文件名只能来自 (a) 锚点 textContent，(b) decodeURIComponent(finalUrl 尾部 basename)。
- 服务器 **支持 Range**：`Range: bytes=0-0` → `206` + `Content-Range: bytes 0-0/<总字节>`。
  - 探测体积必须只读响应头然后 `response.body.cancel()`，禁止把主体读进来。
- 页面类型：Blackboard Learn **Original**（非 Ultra）。`listContent.jsp?course_id=_X_1&content_id=_Y_1`
- 运行环境：Chrome 桌面版，脚本在顶层 frame，`grant none`（页面上下文，可直用 showDirectoryPicker）。

## 类型

```js
/** @typedef {{
 *   id: string,             // 稳定身份：优先 dt-content-rid-*，退化用 url
 *   href: string,           // DOM 上的原始 href 属性
 *   url: string,            // 解析后的绝对 URL
 *   name: string,           // 已 decode、未 sanitize 的显示文件名
 *   folderPath: string[],   // 相对课程根的文件夹层级，根目录为 []
 *   size?: number,          // 字节，未探测时为 undefined
 * }} Entry */

/** @typedef {{ ok: Entry[], failed: { entry: Entry, error: string }[], aborted: boolean }} DownloadResult */
```

## 模块归属与导出

### src/bb/http.js — createFetcher({ signal }) → Fetcher
- `fetchOk(url, init?)` → 返回得手（`response.ok`）的 Response；非 2xx 抛 `HttpError(status)`。
- 会话失效检测：响应 `url` 含 `login`/`relogin`/`sso`，或 `content-type` 是 `text/html` 而请求的是 `/bbcswebdav/` → 抛 `SessionExpiredError`。**绝不允许把 HTML 当文件交出去。**
- `probeSize(url)` → `Promise<number|undefined>`，用 `Range: bytes=0-0` 读 `Content-Range` 尾部；读完立即 `body.cancel()`；失败返回 undefined，不抛。
- 重试：幂等 GET，仅对 `429 / 500 / 502 / 503 / 504` 与网络错误重试；指数退避 + 抖动 + 尊重 `Retry-After`；`403 / 404` 立即失败不重试；最多 3 次。
- 导出 `HttpError`、`SessionExpiredError`、`AbortError`（可直接复用 DOM AbortError）。

### src/bb/dom.js — parseContentList(doc, pageUrl) → { files: Entry[], folders: {url,name,id}[] }
- 纯函数，**不发起网络请求**，可在 jsdom 下测试。
- 文件：`a[href*="/bbcswebdav/"]`；name 取 `a.textContent.trim()`；folderPath 由调用方注入（本函数返回 `folderPath: []`）。
- 子文件夹：`a[href*="listContent.jsp"]` 且该 href 的 `content_id` 参数存在且 **不等于 pageUrl 的 content_id**。必须排除 `href="#"` / `#content` 这类解析成自身页面的锚点。
- 同一 href 只产出一条（去重键 = 绝对 url）。

### src/bb/files.js — 纯函数，可在 node 下测试
- `decodeName(raw)` → 对 `%xx` 做 decodeURIComponent，失败原样返回。
- `nameFromUrl(url)` → finalUrl 的 basename 并 decode。
- `sanitizeSegment(name)` → Windows 安全：替换 `\\/:*?"<>|` 与控制字符、去尾部点与空格、拒绝 CON/PRN/AUX/NUL/COM1-9/LPT1-9（追加 `_`）、UTF-8 字节数 >255 时截断但保留扩展名。
- `buildEntryPath(entry, { preserveTree })` → `{ segments: string[], fileName: string }`；`preserveTree` 为 false 时 segments 为空且 fileName 加 `folder__` 前缀。
- `dedupePaths(list)` → 冲突时加 ` (2)`、` (3)`。

### src/bb/scan.js — createScanner({ fetcher, rootUrl, onProgress }) → { scan(), cancel() }
- 从 `rootUrl` 出发广度/深度递归，`visited: Set<contentId>` 防环。
- **有界并发**：文件夹并发 ≤ 4，带 150–400ms 抖动，禁止无上限 `Promise.all` 扫全树。
- 每处理完一个文件夹回调 `onProgress({ foldersDone, foldersQueued, filesFound })`。
- 所有异常（除 Abort / SessionExpired）记为该文件夹失败并继续，不中断整次扫描。

### src/sinks/index.js — pickDirectory() / createSink({ settings, dirHandle, signal, total })
- `pickDirectory()` → `showDirectoryPicker({ mode: 'readwrite' })`；**必须在用户手势的同一个同步调用栈里被调用**（内部第一句就调，前面不得有 await）。
- `createSink` 返回 `{ kind: 'fs' | 'download', download(entries, fetcher, { onProgress }) → DownloadResult }`。
  - `dirHandle` 存在 → fs sink；否则 → download sink（`<a download>`，文件名加前缀做目录补偿）。
  - fs sink：逐文件 `getDirectoryHandle(seg,{create:true})` → `getFileHandle(file,{create:true})` → `createWritable()` → 分块 `write()`，**禁止把整个文件攒进内存**。
  - 并发由 `settings.downloadConcurrency` 控制；失败重试交给 fetcher；单文件失败不中断其他文件。

### src/ui/panel.js — mountPanel({ settings, onScan, onDownload, onCancel, onSettingsChange }) → Panel
- `setState(state, extra?)`：`idle | scanning | scanned | downloading | done | error | empty`。
- `setScanProgress(p)` / `setDownloadProgress(p)` / `showSummary(result)` / `fail(message)`。
- **任何状态下按钮都必须有恢复路径**（原脚本 `btn.disabled = true` 后永不恢复是 B1 缺陷，不得重犯）。
- 禁止使用 `alert` / `confirm` / `prompt`。

### src/ui/select.js — openSelectDialog(entries, { settings, pickDirectory, onSettingsChange }) → Promise<{ entries, dirHandle? } | null>
- 展示树形勾选（文件夹可整选/半选），每行显示文件名与体积（体积未探测时显示 "—" 并可懒加载）。
- 底部显示「已选 N / 共 M，合计 X MB」。
- 「保留原始目录结构」开关放在这里，改变即时反映到合计与预览路径。
- **确认按钮的同步第一句调用 `pickDirectory()`**（借用户手势），成功后 resolve `{ entries, dirHandle }`；用户取消则 resolve null。
- 环境无 `showDirectoryPicker` 时退回 `{ entries }`（download sink）。

## 硬规则（违反即打回）

1. 不得出现 `alert`/`confirm`/`prompt`。
2. 不得把非 2xx / text·html 响应写进结果。
3. 不得在内存里累积待下载文件内容。
4. 所有网络请求必须传 `credentials: 'include'` 并接受同一个 `signal`。
5. 路径段一律经 `sanitizeSegment`，文件名一律经 `decodeName`。
6. 纯逻辑（files.js、dom.js）不得 import 任何浏览器 API（localStorage 除外）。
