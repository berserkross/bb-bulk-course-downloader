# M6 契约（第一段）：把「webdav 回了 HTML」分成真过期与可疑限流两类

## 触发这条契约的实测事实

用户给的探针输出（真实 CUHK 课程页，2026-xx）：

    fetch(第一个 bbcswebdav 锚点)
    → final: https://bb.cuhk.edu.cn/bbcswebdav/pid-617600-dt-content-rid-11524503_1/courses/...
    → cd (content-disposition): null
    → ct (content-type): application/pdf

用户描述的现象：下载到一半面板说「登录已过期，已暂停」，点「刷新后继续」立刻就继续下载，过一会又停。

推论：点击后能立刻续下 → 会话没死 → 那次 text/html 响应不是登录页。今天 assertAlive 把
「webdav 返回 text/html」一律当成 SessionExpiredError，于是把限流/WAF 的瞬时错误记成了登录过期。

## 1. src/bb/http.js：新增可疑错误类型

1.1 export class SuspectResponseError extends Error
- message 固定 '服务器返回了异常页面（疑似限流）'，绝不复显原始 HTML 或 URL。
- 字段：name='SuspectResponseError'、htmlKind（'login'|'blocked'|'other'）、status（数字或 0）、
  path（只放 pathname，不含 query）。

1.2 export function isSuspectResponse(err) → boolean（只认 name）

1.3 assertAlive 的判定改为三档（判定依据仍是已有的 htmlKind 分类，HTML_LOGIN_RE / HTML_BLOCKED_RE）
- 重定向落到登录页（现逻辑）→ SessionExpiredError（保持不动）
- webdav 返回 text/html 且 htmlKind==='login' → SessionExpiredError（保持不动）
- webdav 返回 text/html 且 htmlKind 为 'blocked' 或 'other' → SuspectResponseError（新行为）
- 非 webdav 的 text/html 仍按现状**不判死**（S22 核实：现有实现只在 wantsFile 时才判；契约原来那句「当作会话失效」是我写错，以代码现状为准）

## 2. src/sinks/guard.js：可疑重试预算与普通重试分开计

2.1 isRetriableError(err)：SuspectResponseError → true（会被重试，而不是直接判失败）。
2.2 withFileRetry 内新增可疑预算 SUSPECT_ATTEMPTS = 3（即最多 3 次尝试，累计 2 次重试），
    与调用方传入的 attempts（普通重试，默认 1 + settings.fileRetries）互不占用：
    - 一次尝试若以 SuspectResponseError 失败，只扣可疑预算，不扣普通预算；
    - 普通失败只扣普通预算；
    - 两者任一耗尽即结束，并把最后一次错误原样抛出。
2.3 可疑重试的退避独立：SUSPECT_DELAYS = [1500, 4000, 8000] 毫秒，不做随机抖动（限流下要的是慢下来，不是打散）。
    普通重试沿用既有退避与抖动，一个字不改。
2.4 onRetry 回调对可疑重试也必须被调用（面板据此显示「重试中（第 N 次）」），
    且 reason 用固定文案 RETRY_SUSPECT_TEXT = '服务器返回异常页面，稍后重试'，绝不带 URL。

## 4. 验收不变量
1. webdav + text/html + htmlKind='login' 仍抛 SessionExpiredError，且不会产生重试。
2. webdav + text/html + htmlKind='blocked' 抛 SuspectResponseError，isRetriableError 为 true。
3. 同一个文件连续可疑 3 次后停止重试，总尝试次数恰好 3，且不消耗普通预算。
4. 普通 5xx 与可疑错误混合时，两类预算各自独立计数（可用计数桩断言）。
5. 任何 SuspectResponseError 的 message / reason / path 里都不出现 http、bbcswebdav 查询串或 xid。
6. 全量 npm test 0 fail；既有 414 条断言不许改。
## 3. 第二段（S23）：池内降速，避免整站被限流时把每个文件都烧满预算

3.1 src/sinks/pool.js：createControl() 增两项能力
- 读得到当前有效并发：control.width（数字）。初始值 = runPool 收到的 concurrency。
- control.degrade()：width 减半向下取整（4→2→1），最低 1；最多降 2 次，之后是空操作；返回降级后的 width。
- runPool 的取号循环每轮都读 control.width（不是开始时算一次），降级对尚未开始的条目立即生效；在飞的 worker 不中断。

3.2 三个 sink 在遇到可疑重试时降速
- fs.js / download.js / zip.js 的可疑重试回调（guard 的 onRetry 带 suspect:true）里调用一次 control.degrade()。
- 同批次降级总次数 ≤ 2（由 control 自己封顶，sink 不另记账）。
- 降级后写一行 console.info('[bbdl] 降速', { from, to, reason: 'suspect-response' })，字段白名单固定。

3.3 结果增 degraded（不可枚举，与 halted 同法）
- degraded = { from, to } | null；Object.defineProperty 挂上，enumerable:false —— 既有整对象 deepEqual 断言不许改。

3.4 src/index.js：降级后给一句非阻塞提示
- finishDownload 里 result.degraded 存在时 setNotice('服务器似乎在限流，已把并发从 X 降到 Y 继续下载。')；
  不弹窗、不阻断、不改变终态分支；X/Y 只能是数字。

3.5 验收不变量
1. control.degrade() 连调三次后 width === 1（4→2→1→1），返回值等于当前 width。
2. 运行中降级后，未开始的条目用新 width 取号（用 worker 峰值数与桩计数断言）。
3. 一次可疑重试触发恰好一次 degrade；同批次两次可疑后 width=1，第三次不再变化。
4. degraded 不可枚举：既有 sinks/zip-sink 的 deepEqual 断言一字不改且全绿。
5. index.js 的 notice 只在 result.degraded 非空时出现，且不含 URL。
6. 全量 npm test 0 fail。
