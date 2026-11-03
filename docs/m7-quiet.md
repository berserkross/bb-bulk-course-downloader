# M7 契约：静默恢复（v2.8.0）

用户原话（m01158）：登录过期不要显性地讲出来，隐藏在日志行就可以了；有的时候还是会因为所谓的登录过期而卡住，我要求你这种情况下无论怎么样都得自动强制刷新后重试，千万不要擅自断开；设置里可以手动调下一次打开网页时整个圆钮是折叠还是展开。

## §1 文案红线（S27 负责，S26 只消费）

面板 DOM 内任何可见文本都不得出现：登录 / 过期 / 会话失效 / 重新登录 / 认证。诊断信息只许进 console。

| 时机 | 状态行 | 收起条状态字 | 横幅 | console |
| --- | --- | --- | --- | --- |
| 自动续跑等待中 | 正在自动恢复（第 N 次）… | 恢复中 | 不显示 | 无 |
| 触发强制重载前 | 正在自动恢复（第 N 次）… | 恢复中 | 不显示 | [bbdl] 自动重载续跑 {reloads} |
| 重载次数用尽 / 用户关掉开关 | 已暂停，未下载 N 个文件。 | 已暂停 | 已暂停（N 个未下载）。 + 按钮「继续」 | [bbdl] 自动重载已达上限 {reloads} 或 [bbdl] 自动重载已关闭 |
| 停机发生那一刻 | 不变（交给上面的恢复态） | 恢复中 | 不显示 | [bbdl] 停机 {reason, pending} |

摘要头沿用既有两句：已暂停：成功 X 个，未下载 N 个（有真失败才追加，失败 Y 个）。
按钮文案由「刷新后继续」改为「继续」（data-act 仍是 resume-pending，测试与 wiring 靠 data-act 找它）。

## §2 设置项（S26 定键，S27 做控件）

src/store.js DEFAULTS 追加：

    autoReload: true,      // 停机且自动重试用尽后，强制刷新页面并自动续跑
    autoReloadMax: 2,      // 单门课一次会话最多强制重载几次

既有 panelCollapsed: true 不动。设置面板新增两行：

1. 打开页面时展开面板　checkbox，勾选 = panelCollapsed false（默认不勾 = 保持收起）
2. 会话异常时自动重载续跑　checkbox，勾选 = autoReload true（默认勾选）

两行都走既有 emitSettings(patch)，写回 localStorage。

## §3 强制重载续跑（S26 负责，只改 src/index.js + src/store.js）

### 3.1 续跑意图（sessionStorage）

键 bbdl:resume-intent:v1，值：

    { courseId, contentId, pendingIds: string[], selectedIds: string[], completedIds: string[], dirName: string, createdAt: number, reloads: number }

写：只在即将 location.reload() 之前写一次。读：mount 之后。清：任一批次以非停机状态收尾、用户取消、意图超过 30 分钟、reloads 撞上限。

### 3.2 阶梯（runBatchWithAutoResume 的两个 give-up 点改成同一个 escalate）

零进展熔断（zeroProgress >= 2）与整批续跑撞满 20 次这两处，不再直接 finish，改为：

1. signal.aborted 或用户取消 → 清意图 → finish（取消永远优先）
2. settings.autoReload === false → notify(已暂停提示) + console.info('[bbdl] 自动重载已关闭') → finish
3. 读意图的 reloads；reloads >= settings.autoReloadMax → notify(已暂停提示) + console.info('[bbdl] 自动重载已达上限', {reloads}) → finish
4. 否则：await flushRecords() → 写意图（pendingIds = pending 的 entry.id，reloads + 1）→ console.info('[bbdl] 自动重载续跑', {reloads}) → panel.setRecovering({attempt: reloads}) → location.reload() → 返回一个永不 resolve 的 Promise（真浏览器里页面已经在卸载；测试注入的 reload 是个 spy，靠它断言）

停机发生那一刻（shouldAutoResume 之前的早退分支）额外打一行 console.info('[bbdl] 停机', { reason, pending: pending.length })，不新增 UI。

### 3.3 重载后的自动续跑

mount 完成、panel 起来之后调用一处 consumeIntent()：

1. 无意图 / 课程或内容页 id 不匹配 / createdAt 早于 30 分钟 → 清掉，什么都不做
2. 有意图且 settings.autoReload !== false：console.info('[bbdl] 重载后续跑', { pending: pendingIds.length, reloads })
3. 取已保存句柄 store.loadHandle(courseId) 并 ensureDirectoryPermission(handle, { mode: 'readwrite', request: false })
   - granted → state.dirHandle = handle；若 state.entries 为空先 startScan()；再 startDownload()。全程不弹选择对话框、不调 showDirectoryPicker（重载后没有用户手势，调只会抛）
   - 非 granted / 没句柄 → 不自动跑：panel.setHalted({ reason: 'session-expired', pendingCount: pendingIds.length }) 让横幅出现，用户点「继续」走既有 resumePending（无快照时它本来就会退回重新扫描）
4. 每步都要 try/catch：自动续跑失败只许 console.warn，绝不让页面上的面板起不来

### 3.4 依赖注入（单测不碰真 location / sessionStorage / 时钟）

createController 的 config 增三个可选依赖，缺省取全局：deps.reload（默认 () => location.reload()）、deps.intentStore（默认包 sessionStorage，读写失败静默）、deps.now（默认 Date.now）。

## §4 接线点位（当前 HEAD 3a3449e 实测行号，供 S26 定位）

- src/index.js:995-1042 自动续跑循环；:1013-1018 零进展熔断；:1020-1025 20 次闸门；:1002-1004 早退（停机那一刻在这里打日志）
- src/index.js:1037 await wait(delay, signal)；:1039-1041 下一轮 batch = pending
- src/index.js:1503-1511 resumeWith（授权后直接扫描+下载，可复用其形状）
- src/index.js:1578-1596 mount()（consumeIntent 挂在这里返回的 controller 之上）
- src/index.js:158-230 一带是 createController 的 config 解构与 deps 组装（新依赖加进去）
- src/ui/panel.js:614 状态行；:1183-1190 setHalted；:1178 横幅按钮；:656-661 setCollapsed；:579 挂载时应用 panelCollapsed；:1290-1300 面板导出对象
- tests 里写死旧文案的位置：tests/unit/ui-files.test.js:147,166,250,274；tests/unit/auto-resume-loop.test.js:16,204；tests/unit/wiring-m3.test.js:216,258,271；tests/unit/ui-collapse.test.js:140-146（收起条状态字仍应是「已暂停」，不用改）

## §5 验收不变量（两个 PR 都要跑全量）

1. 面板可见文本（root.textContent）在任何状态下都不含 登录 / 过期 / 会话失效 / 重新登录
2. 停机 → 恢复 → 再停机 → 重载，reloads 严格递增且不超过 autoReloadMax；第三次必须停在「已暂停」并带「继续」按钮
3. 用户点取消后绝不重载（reload spy 调用次数 0）
4. 成功收尾后 sessionStorage 里没有遗留意图
5. 重载后自动续跑全程不调用 showDirectoryPicker、不打开选择对话框
6. 既有 463 条测试除文案断言外一条不许改语义；改动必须在测试里写清原因

## §6 文件所有权（互斥，越界视为失败）

- S26：src/index.js、src/store.js、tests/unit/reload-resume.test.js（新建）；可改 tests/unit/auto-resume-loop.test.js、auto-resume.test.js、wiring-m3.test.js 里的文案断言
- S27：src/ui/panel.js、src/ui/styles.js、tests/unit/ui-quiet.test.js（新建）；可改 tests/unit/ui-files.test.js 里的文案断言
- 任何一方都不许碰：src/bb/**、src/sinks/**、src/store/**（db/manifest/plan/permissions）、build.mjs、package.json、meta.js、其它测试
v2.8.1 在原有 30 分钟意图里只增加文件 ID。重载后先按 selectedIds 限定选择范围，再比对磁盘和清单。completedIds 中本轮确认跳过的条目恢复为完成行。旧版意图缺少选择集合时沿用旧版的全页比对。意图写入失败时留在当前页，可手动继续。同一批次的面板摘要累计唯一成功文件和仍未解决的失败，重新选择批次才清零。
