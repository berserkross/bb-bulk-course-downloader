# M2-C 契约：本地目录树增量同步（一键同步）

本文件是派发前的硬契约。实现方可以自由决定内部结构，但下列名字、判定顺序与红线不得改动。
背景调研见 `docs/sync-research.md`（DeepTutor v1.7.1，结论：删除永不自动执行；信息不全时整批降级为未知）。

## 1. 目标 / 非目标

做：扫描后判断每个条目相对「上次」是新增、内容变更、改名或搬家、疑似删除、未变，并在对话框里给出预览与「只更新」动作。
不做：自动删除任何本地文件；服务端；内容级 SHA-256 哈希（原因见 §6）。

## 2. 判定键

- 身份键：`entry.id`（Blackboard 的 `content_id`，如 `_633912_1`）。同一课件改名或覆盖上传后，content_id 不变。
- 版本指纹：条目在扫描时拿到的**原始 href**（形如 `/bbcswebdav/pid-633912-dt-content-rid-12071526_1/xid-12071526_1`），整串原样保存为 `href`。
  它本身就是 Blackboard 的版本指针：pid=内容行、dt-content-rid=资源、xid 尾段=版本。任何一段变化都代表 BB 认为这一版变了。
- 辅助键：`name`、`path`（相对落盘路径）、`size`。

## 3. 五分类判定（严格按此顺序，先命中先返回）

| 条件 | 分类 | 动作 |
|---|---|---|
| 清单无该 content_id | `added` | 下载 |
| 有，且 `href` 相等、`path` 相等 | `unchanged` | 跳过（可被用户勾选覆盖） |
| 有，且 `href` 相等、`path` 不等 | `moved` | 按新路径下载；旧路径文件**不删**，只记为疑似残留 |
| 有，且 `href` 不等 | `changed` | 下载并覆盖 |
| 清单有、本次扫描结果里没有该 content_id | `stale` | 只提示，永不删除 |

## 4. 降级规则（信息不全时的唯一合法出口）

出现下列任一情况时，对应条目的分类一律降级为 `unknown`，并且 UI 只允许「下载」或「跳过」两个选项，不允许显示「未变」：

- 清单里的记录**没有 href**（v1 旧记录迁移而来）；
- 本次扫描该条目没有 href；
- 磁盘比对结果 `truncated === true`；
- 本次扫描有失败项（`failed.length > 0`）且该条目所在的文件夹扫描失败。

红线保持：`status !== 'done'`（partial / failed）一律进 todo 重下，绝不因为「磁盘有同名文件」而跳过。

## 5. 数据形状（manifest version 2）

```
record = { id, href, path, name, size|null, status:'done'|'failed'|'partial', updatedAt }
manifest = { courseId, version: 2, updatedAt, files: { [id]: record } }
```

- 读到 `version === 1` 的记录：保留，但 `href` 视为缺失 → 按 §4 降级 `unknown`。**不得**把缺失 href 当成「未变」。
- 写回时统一写 version 2。旧字段一个都不删。

## 6. 为什么不做内容哈希

`crypto.subtle.digest` 需要整块 buffer，与「边下边写、内存恒为一个 chunk」的铁律直接冲突：为了算哈希把 300MB 录屏读进内存，等于把这一轮加固全部作废。
只有当有人实现**增量 sha256**（逐 chunk update，约 100 行）时才重新讨论。当前用 href 指纹 + 本地文件大小兜底。

## 7. planSkips 扩展

`planSkips({ plans, manifest, existingPaths, preserveTree })` 返回新增字段：

```
diff = { added, changed, moved, unchanged, stale:[{id,path}], unknown, total }
skip[].reason 新增取值：'manifest-unchanged' | 'manifest-unknown'
```

既有 reason（`disk` / `disk-unverified` / `manifest`）语义不变。

## 8. UI 契约

对话框顶部一行预览：`新增 N · 变更 N · 改名 N · 未变 N · 疑似删除 N · 未知 N`，配一个「只更新新增与变更」开关（默认勾选）。
「疑似删除」只在一处可展开列表里显示并提供「复制清单」，**不提供删除按钮**。
下载中若 sink 上报 `state === 'file-retry'`，状态行显示「重试中（第 N 次）」，不新增按钮。

## 9. 验收不变量（缺一条打回）

1. 同一份扫描结果连扫两次，第二次 `changed === 0 && added === 0 && moved === 0`（幂等）。
2. 缺失 href 的 v1 记录不得被判为 `unchanged`。
3. `stale` 只能出现在预览里；任何代码路径都不得删除本地文件。
4. `truncated` 或扫描失败时，受影响的条目不得出现在 `unchanged` 里。
5. `partial` / `failed` 状态的记录必须进 todo。
6. UI 文案里不得出现 URL query；失败项 url 仅供重试，永不进 DOM。

## 10. 未决（不阻塞实现）

`dt-content-rid` / xid 尾段在「改名」与「覆盖」时各自的稳定性未做真实课程对照实验。它只影响我们能否把 `changed` 进一步细分（改内容 vs 改版本号），不影响本契约的判定正确性。
