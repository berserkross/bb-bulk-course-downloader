# BB 课件批量下载 (bb-bulk-course-downloader)

[Tampermonkey](https://www.tampermonkey.net/) 用户脚本：在 Blackboard（Original 版式 / `listContent.jsp`）课程内容页扫描整门课的文件树，树形勾选后**按原始目录结构**批量落盘，并记住「哪些文件、什么版本、下到哪一步」以便断点续传与增量同步。

本项目的原型是同一个仓库里 `core` 分支上的单文件脚本 [berserkross/bb-bulk-course-downloader](https://github.com/berserkross/bb-bulk-course-downloader/tree/core)；`main` 分支（也就是这里）是从零重写的版本。致谢与差异见[文末](#与原仓库的关系致谢)。

## 安装

装好 Tampermonkey 后，直接打开这个地址（也就是脚本里的 `@downloadURL`）：

```text
https://raw.githubusercontent.com/berserkross/bb-bulk-course-downloader/main/bb-bulk-course-downloader.user.js
```

打开任意课程的「课程内容 / Course Content」页（URL 含 `listContent.jsp`），右上角会出现「BB 批量下载」面板。

升级：篡改猴会按 `@updateURL` 自动检查更新；也可在「已安装脚本 → BB 批量下载 → 检查更新」手动触发。

## 现有功能（v2.8.0）

### 扫描与选择

- 递归扫描整门课的文件夹树，用 `content_id` 防环，4 并发 + 150–400 ms 抖动，不吃满 BB 的限流额度。
- 勾选对话框：按扩展名过滤（pdf / ppt / doc / zip / 图片 / 其他）、按文件名搜索、全选/全不选、体积合计。
- 可选 `Range` 探测每个文件的真实体积（未知就显示「—」，绝不拿 0 冒充）。
- 目录结构开关：保留原目录树（默认开）或压平。
- 扫描失败的文件夹会被计数，并让**其中的文件一律降级为未知**（宁可多下一次，也不谎报「未变」）。

### 三种落盘方式

| 方式 | 触发条件 | 目录结构 | 说明 |
| --- | --- | --- | --- |
| 直接写入文件夹（FSA） | Chromium 且授权成功 | 保留 | 逐块流式写入，内存只占一个 chunk |
| 按文件夹打包成 .zip | 没有目录写入权限时的默认降级 | 包内保留层级 | STORE-only、按顶层文件夹分包、单包上限 200 MiB |
| 逐个文件下载 | 手动选择 | 文件名加 `folder__` 前缀 | 兼容 Firefox / Safari |

ZIP 包是手写的合法 ZIP（CRC32、data descriptor、UTF-8 文件名），压完可直接用系统解压工具还原目录；单文件 ≥ 4 GiB 会**明确拒绝**而不是产坏包。

### 断点续传与增量同步

- 文件名 = **服务器真名**：`Content-Disposition` → 重定向后 URL 末段 → 页面标题，缺扩展名时按 MIME 补齐（CUHK/CUHKSZ 的 BB 不给 `Content-Disposition`，所以第 2 条是主力）。
- IndexedDB 记清单（每个 `content_id` 一条记录：路径、大小、状态、版本指纹）+ 记住上次选的目录句柄。
- 下次扫描自动分类：**新增 / 变更 / 改名 / 未变 / 未知 / 疑似删除**，可以「只下载新增与变更」。
- 疑似删除**只提示，永不删除本地文件**。
- 清单可导出为 JSON、也可从 JSON 导入合并（换机器、换浏览器、备份用）。
- 面板保留最近 5 次扫描历史（时间、五分类计数、变更路径）。

### 稳定性

- 会话异常三分：真失效（重定向到登录页）→ 停机；限流/拦截页 → 当可疑重试；其余 HTML → 不判死。
- 可疑重试与普通重试**分开记账**：可疑页面 3 次独立预算（退避 1.5 s / 4 s / 8 s，不抖动），普通失败额外 1 次；HTTP 层对 429/5xx 另有一层最多 3 次的指数退避。
- 连续可疑失败时自动降并发（4 → 2 → 1），降过会明说。
- 停机后**先自动续跑**（有界熔断：连续两轮零进展 / 累计 20 次即停），再失败则**自动重载页面**凭已保存句柄静默续跑（默认 2 次，可关）。
- 下载期间心跳保活；停滞 30 s 判超时；按 `Content-Length` 做截断校验（gzip 响应当作不可比，避免误报）。
- 重试会回退已计字节，进度条不会冲到 100% 再僵住。
- 面板文案**不出现**「登录 / 过期 / 重新登录 / 认证」，只留控制台日志。

### 界面

- 常驻面板：7 态状态机，任何终态都能重新操作；可收成小条（默认收起，可在设置里改）。
- 可折叠文件列表：每行名称 / 状态 / 字节 / 重试次数 / 路径（DOM 上限 500 行，超出折叠成一行提示）。
- 失败清单可复制、可「只重试失败的」。
- 设置项：探测体积、打开页面时展开面板、会话异常时自动重载续跑。
- 全程 `alert` / `confirm` / `prompt` 零使用，提示走页内通知。

## 迭代记录

| 版本 / 里程碑 | 提交 | 主题 |
| --- | --- | --- |
| M1 | `dff675f` | 从零重写：递归扫描 + 勾选对话框 + 流式落盘（FSA / a[download]） |
| M1.1 | `f9383b2` | 修「分组被 flex 压扁后文字堆叠」；补失败清单、真实进度、筛选排序 |
| M2-A | `67afda2` | 断点续传：IndexedDB 清单 + 已保存目录句柄 + 磁盘比对 |
| M2-B | `64c644d` | 大文件加固（流式 / 看门狗 / 截断校验 / 重试回退）+ 增量分类层 |
| M2-C | `c45afdb` | 增量同步接入对话框：预览行、只下载新增与变更、疑似删除只提示 |
| v2.3.0 | `296abf3` | 逐文件状态表、会话过期停机、ZIP 降级落盘（丢掉整个课程进内存的旧做法） |
| v2.3.1 | `97a9adc` | 接入 GitHub 仓库地址，产物带自动更新 |
| v2.4.0 | `cc9365c` | 自动更新改为 raw 自托管；ZIP 部分包交付；扫描历史与清单导入导出 |
| v2.5.0 | `9a1e544` | 面板默认收起；把「零工作量」与体积探测失败显性化 |
| v2.5.1 | `5d9a103` | 落盘层自证：计划数与空批次守卫 |
| v2.5.2 | `66e26b0` | 落盘层内部证据：plans / concurrency / workers / ok / failed 一次说清 |
| v2.5.3 | `0a865ce` | 池层诊断：计划数 vs job 数 vs 闸门状态 |
| v2.5.4 | `af02a6d` | 修上述缺陷的真正根因：宿主 Prototype.js 覆盖了 `Array.from` |
| v2.6.0 | `23a13c1` | 会话掉线三分诊断、保活心跳、有界自动续跑 |
| v2.7.0 | `e4223be` | 服务器真名落盘（带扩展名）、清单记忆、限流降级 |
| v2.7.1 | `3a3449e` | 停机后直接自动续跑：删掉「探活」闸门，改为有界熔断 |
| v2.8.0 | `1391bee` | 会话异常静默自愈（自动重载续跑）+ 折叠设置 |

更细的设计取舍在 `docs/` 下 9 份契约文档里（模块契约、续传、增量同步、逐文件事件、分发、真名解析、会话异常、静默自愈）。

## 与原仓库的关系（致谢）

**本项目源自 [berserkross/bb-bulk-course-downloader](https://github.com/berserkross/bb-bulk-course-downloader)** —— 那份单文件脚本 `blackboard-download.user.js` 至今仍躺在同一仓库的 [`core` 分支](https://github.com/berserkross/bb-bulk-course-downloader/tree/core) 上，是这个项目真正的起点。它用不到 250 行把「递归抓目录 + 并发下载 + 命名去重 + 落盘」跑通，证明了这件事在用户脚本里可行，也是本项目的思路来源——包括

- 文件名要靠**服务器响应**而不是页面标题（本项目的解析顺序 `Content-Disposition` → 重定向 URL 末段 → 标题，正是在它的思路上加的第三档：实测 CUHK/CUHKSZ 的 BB 根本不返回 `Content-Disposition`）；
- 同一文件多处引用只下一次；
- 小并发 + 失败重试，而不是一把全并发。

感谢原作者 **berserkross** 把这份工具开源出来：没有那个能用的最小原型，就没有后面这些迭代。

两者的关系不是「另起炉灶」：`main` 分支是本项目从零重写的实现（独立 git 历史），`core` 分支保留原始脚本，两条线同处一个仓库，方便对照「同一件事的两种做法」。

**主要差异**（本项目在它之上做的事）：

| | 原版单文件脚本 | 本项目 |
| --- | --- | --- |
| 落盘 | 全部进内存打一个 ZIP | FSA 直写 / 分包 ZIP / 逐文件，内存不过一个 chunk 或一个包 |
| 目录 | 文件名前缀 `Week3 - Slides - lecture.pdf` | 保留真实目录层级 |
| 文件名 | `Content-Disposition` → 重定向 URL → 页面标题 | 同上 + MIME 兜底扩展名 + 全套 Windows 非法名/保留名/255 字节处理 |
| 续传 | 无 | 清单 v2 + 目录句柄 + 磁盘比对 + 增量五分类 |
| 错误语义 | 失败只计数 | 会话异常停机（不算文件失败）、可疑限流单独记账、截断校验、逐文件事件 |
| 界面 | 一个按钮 + `alert` | 常驻面板 + 勾选对话框 + 文件列表 + 扫描历史 + 设置，无 `alert` |
| 分发 | 手动复制粘贴 | raw 自托管 + `@updateURL` 自动更新 |

原仓库未附许可证文件；本项目沿用同样的公开精神发布（源码未混淆、无外部请求、不做任何绕过登录的事）。若上游后续补充许可证，以其为准。

## 明确非目标

- **不做后台执行**（关掉浏览器继续跑 / 定时同步）。那需要在脚本外重建学校的 SSO+MFA 登录，是整个项目里最贵、最脆弱、也最容易触碰校方条款的部分。
- **不支持 Blackboard Ultra** 版式（Ultra 没有 `listContent.jsp`）。本项目只服务 CUHK / CUHKSZ 的 Original 课程页。
- **不做内容哈希**做变更检测（`crypto.subtle.digest` 需要整块 buffer，与流式落盘的内存铁律冲突；版本判定用 `href` 里的 `dt-content-rid` 已经够用）。
- **不自动删除**本地文件（清单有、本轮扫描没有 = 疑似删除，只提示）。

## 已知限制

- 直接写入文件夹（FSA）只在 Chromium 系可用；Firefox / Safari 退到 ZIP 或逐文件下载。
- ZIP 包内不能续传：某个包里有文件失败要重下该包（单包上限 200 MiB）。
- ZIP 路径的内存峰值约为包体积的 2 倍。
- 文件列表 DOM 上限 500 行（更大课程请用扩展名过滤缩小范围）。
- 续跑后的摘要只统计最后一轮成功数，整批总数看文件列表。
- 浏览器重启后目录句柄需要重新授权一次（Chrome 的权限模型，不是脚本能绕过的）。

## 开发

```bash
npm install
npm test      # node --test "tests/**/*.test.js"（当前 487 条，约 3.5 秒）
npm run build # → dist/bb-bulk-course-downloader.user.js + 仓库根同名产物
```

源码是 ES module，`build.mjs` 用 esbuild 打成单个 IIFE（`@grant none`、无 `@require`、零运行时依赖）。

### 发布与自动更新（自托管 raw 产物）

自动更新走「构建产物进仓库 + `@updateURL` 指向 raw」，不依赖 GitHub Release，也不需要任何 API 凭据。

脚本头里的 `@updateURL` / `@downloadURL` 不是手写的，由构建时推导：读 `package.json` 的 `repository` 字段（或环境变量 `BB_REPO_URL`），解析出 github 的 `owner/repo` 才写这两行。

- 两行**同时出现或同时不出现**；拿不到仓库信息就不写这两行，构建仍 `exit 0`。宁可没有自动更新，也不写一个每次检查更新都 404 的坏地址。
- 两行指向**同一个 raw 地址**，分支固定 `main`（改默认分支名要同步改 `src/meta.js` 的 `repoUrls`）。
- `dist/` 在 `.gitignore` 里；**仓库根目录那份同名产物**才是被提交、被 raw 托管的文件，由 `build.mjs` 写完 `dist/` 后按同一份字节复制出来。

每次发版：

```bash
# 1. 改 package.json 的 version
npm test && npm run build
git add -A && git commit -m "vX.Y.Z: ..."
git push origin main
```

验证发布成功（两行 URL 相同；根目录产物与 `dist/` 哈希相同）：

```powershell
Select-String -Pattern "@(update|download)URL" dist/*.user.js
Get-FileHash dist/bb-bulk-course-downloader.user.js, bb-bulk-course-downloader.user.js
```

用户端篡改猴只在 raw 上的版本号比本地高时才提示更新，所以**「改了源码但漏提交根目录产物」等于这次发版没发出去**。

## 说明

- 只访问你自己有权限查看的文件，不绕过任何登录或权限。
- 代码无混淆、无外部请求；不向任何第三方上传课程内容或身份信息。