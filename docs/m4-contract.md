# M4 契约（v2.4.0）：自动更新通道 · ZIP 包内续传 · 课程页常驻 · 清单导出与扫描历史

本文件是 M4 四个并行工作流的唯一接口来源。任何与本文件冲突的实现都必须在汇报里点出来，由调度者裁决。

## 0. 全局红线（对所有工作流生效）

1. 既有测试一条都不许改（例外必须先在汇报里说明「哪条断言与新需求互斥」并等裁决）。
2. 只跑自己负责的测试文件（node --test tests/unit/<x>.test.js），不要跑全量 npm test：并行期间别的模块可能正处于写一半的状态。
3. 不碰别人的文件。文件所有权见每节 Boundary。
4. 任何用户可见的错误文案都不许回显 URL / query（redactUrls 之后才能进 DOM）。
5. 不得引入新依赖。

## 1. F1 自动更新通道（自托管 raw 产物）

背景：远端 releases 需要 API 凭据，本机没有；改成「构建产物进仓库 + @updateURL 指向 raw」。

接口（src/meta.js）：

    export function repoUrls(repoName) -> { updateUrl: string, downloadUrl: string } | null
    入参 repoName 形如 "owner/repo"；无法解析返回 null。
    两个 URL 逐字相同，形如：
    https://raw.githubusercontent.com/<owner>/<repo>/main/bb-bulk-course-downloader.user.js

要求：
- 删掉所有 releases/latest/download 相关逻辑，两条 URL 都指向 raw 的 main 分支。
- build.mjs 在写 dist/ 之后，把**同一份字节**再写到仓库根目录的 bb-bulk-course-downloader.user.js（供提交）；环境变量 BB_NO_ROOT_COPY=1 时跳过这次复制。
- 根目录那份产物不能被 .gitignore 命中（用 git check-ignore 验证）。
- README 的发布段落改成：node build.mjs -> git add bb-bulk-course-downloader.user.js -> commit -> push；用户安装地址写 raw URL。
- 没有仓库信息时仍然两行都不写、构建 exit 0。

约束：DIST_NAME 仍是 bb-bulk-course-downloader.user.js；不改 package.json（版本号由调度者统一改）。
Boundary：src/meta.js、build.mjs、README.md、tests/unit/meta.test.js。

## 2. F2 ZIP 包内部分续存（partial seal）

背景：现在一个包里有任何一个文件彻底失败，整包作废，下次重下整包（最坏 200 MiB）。

新行为：一个包内如果有条目彻底失败（withFileRetry 用尽），且该包已至少完整收下一个条目，则**照常封包并交付**这一个包，包里只含已完整收下的条目；失败的与尚未开始的条目全部进 failed。

要求：
- 交付的包必须是合法 zip：中央目录只描述真正写入的条目，CRC 与长度正确，Expand-Archive 能解开。
- 新增字段（普通可枚举属性）：`return { ok, failed, aborted, halted, partialPackages }`，partialPackages 形如 `[{ name: 'Week 1.zip', saved: 3, missing: 2 }]`，没有部分交付时为空数组。
- 已交付条目的逐文件事件语义不变：done 在交付前就已经发过；failed 的条目必须有一条 failed 事件。
- 包内存上界仍是一个包（封包后立刻释放 parts）。
- 会话过期（halted）路径优先级高于 partial seal：停机时照旧交付**已经完整收下**的包（M3 行为，既有用例 zip-sink.test.js:394-418 锁定「停机不该丢掉前面下好的文件」），但绝不产出 partialPackages（missing 恒为 0）。
- 4 GiB 体积闸门拒绝不算「彻底失败」：一个字节都没读，只让该条进 failed，包继续收文件（既有 :430/:622 锁定）。
- 不得改变 200 MiB 切包规则、不得改变 preserveTree 行为。

Boundary：src/sinks/zip.js、src/sinks/zip-core.js、tests/unit/zip-sink.test.js、tests/unit/zip-core.test.js。
验收：新增至少 3 条用例 —— (a) 3 个文件、第 2 个永久失败 -> 交付的包只含第 1 个，failed 含第 2、3 个，partialPackages=[{saved:1,missing:2}]；(b) 第 1 个就失败 -> 不交付包、partialPackages 为空；(c) 全部成功 -> partialPackages 为空且包含全部条目。

## 3. F3 清单扫描历史与导出/导入（store 层）

接口（src/store/manifest.js 新增，全部纯函数）：

    export function appendScanHistory(manifest, snapshot, cap = 10) -> manifest
    snapshot = { at, total, added, changed, moved, unchanged, unknown, stale, changedPaths }
    changedPaths 形如 [{ id, path }]（最多 50 条由调用方截断）；计数一律 Number.isFinite 且 >= 0，否则归 0。
    返回新对象，不改入参；manifest.scans 数组最新在前，长度不超过 cap（默认 10）。

    export function exportManifestPack(input) -> { format, version, exportedAt, courses }
    input = { courseId, manifest, exportedAt? }
    format 固定 'bbdl-manifest'，version 固定 1，courses = [{ courseId, files }]

    export function importManifestPack(pack, now) -> { ok, error?, course }
    校验：pack.format === 'bbdl-manifest' 且 pack.version === 1 且 courses 是数组；
    每个记录都过 normalizeStatus / knownSize / href 字符串化，脏值一律按现有规则降级（status 脏 -> 'failed'）；
    单课程（courses.length === 1）返回 { ok: true, course: { courseId, manifest } }；多课程返回 { ok: true, courses: [...] }。
    任何不合法输入返回 { ok: false, error: '<一句中文原因>' }，绝不抛。

    export function mergeManifests(current, incoming) -> manifest
    逐 id 合并：current 里 status === 'done' 的记录优先保留（磁盘上真有一份），其余用 incoming 覆盖；返回 version 2 清单，scans 保留 current 的。

约束：manifest.scans 与 record 平级，不塞进 files；不写 0 当「未知大小」。
Boundary：src/store/manifest.js、src/store/db.js（如需）、tests/unit/store-export.test.js（新建）、tests/unit/manifest-plan.test.js 之外的既有 store 测试不许改。
验收：新建 store-export.test.js 覆盖 —— cap 截断、脏值降级、import 拒绝坏包、merge 保留 done、export/import 往返一致。

## 4. F4 接线与 UI（课程页常驻 · 历史面板 · 导出导入按钮 · 勾选记忆）

面板（src/ui/panel.js）新增：
- 「扫描历史」折叠块：最多列 5 条，每条形如 `08-21 14:32 · 新增 18 · 变更 1 · 改名 1 · 未变 1 · 未知 1 · 疑似删除 2`；展开可看该次变更文件路径（最多 20 行）。没有历史时整块不渲染。
- 「设置」块里加两个按钮：导出清单（下载 <courseId>-manifest.json）、导入清单（<input type=file> 选 JSON）。导入结果用既有的 notice 行显示，不新增弹窗。
- 面板顶部显示当前课程标识（courseId 或课程名，能拿到就用 name），用于区分「换课程了」。

选择对话框（src/ui/select.js）：
- 勾选状态按 `bbdl:sel:<courseId>:<pageId>` 存 sessionStorage，关闭对话框与切走再回来都能恢复；恢复的 id 中有已不存在的就静默丢弃。
- 恢复不得覆盖「跳过已存在」的默认逻辑。

接线（src/index.js）：
- 每次扫描成功后调用 appendScanHistory（snapshot 里的五分类取自现有 diff，changedPaths 取 added/changed/moved 三类，最多 50 条），再 saveManifest。
- 导出：exportManifestPack({ courseId, manifest }) -> Blob -> a[download]。
- 导入：importManifestPack -> 单课程走 mergeManifests(current, incoming) -> saveManifest -> 面板 notice 显示「已导入 N 条记录（合并 M 条）」；坏包显示 error 且不写库。
- partialPackages 非空时在 notice 行显示「本次有 K 个包只交付了部分文件（共缺 M 个），其余已记为失败可重试。」（F2 的返回字段，未就绪时按空数组兜底）。

Boundary：src/index.js、src/ui/panel.js、src/ui/select.js、src/ui/styles.js、src/bb/dom.js、新建 tests/unit/ui-history.test.js 与 tests/unit/ui-resident.test.js。
约束：DOM 里不许出现 URL / query；不新增弹窗；不改动既有 ui-*.test.js 的断言（若确有互斥，汇报后等裁决）。

## 5. 验收不变量（交给调度者最终核对）

1. build 产物根目录那份与 dist 那份字节完全相同（Get-FileHash 相等）。
2. 产物第 6、7 行是同一个 raw URL，不含 releases/latest。
3. 部分交付的 zip 用 Expand-Archive 能解开，且只含已完成的文件。
4. 导出->导入往返：files 数量与 status 不变；scans 不因导入而丢。
5. 同一课程在两个文件夹间来回切，勾选状态各自保留、不串台。
6. 全部新用例与既有 310 条用例一起跑通（由调度者执行全量）。
