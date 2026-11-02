# 本地目录树一键同步 · 前置调研（参考对象：HKUDS/DeepTutor）

调研对象：HKUDS/DeepTutor，浅克隆到仓库外的 `C:\Temp\deeptutor-ref`。
实际版本：tag `v1.7.1`，commit `f7aed0744c36c5afef16a4261c31ebee1208cac2`（commit message: `release: v1.7.1`）。
只做了静态阅读（read / grep），未执行其代码、未安装依赖、未启动服务。

本文只解决一件事：老师后续在 BB 上新增 / 修改 / 删除课件时，如何用最小的网络与代码代价把本地那棵树同步到位。
凡是无法从代码里读到证据的结论，一律放到第 4 节「没查清的问题」，正文不写推测。

---

## 1. DeepTutor 的增量更新机制

DeepTutor 的"知识库"是一棵服务端目录 `<base_dir>/<kb_name>/raw/`，加上 `metadata.json` 与各 RAG provider 的索引目录。
它有三套彼此独立的增量机制，分别服务三种来源：本地/上传文件（按内容哈希）、linked folder 外部目录（按绝对路径 + mtime）、book 与 KB 之间的漂移检查（按路径→哈希映射做集合对账）。
值得警惕的是：**这三套机制的"同一个文件"定义互相不一致**，其中只有第三套能发现删除。

### 1.1 用什么键识别「同一个文件」

三处、三个不同答案：

- **上传/增量添加路径：内容哈希优先，路径是次要键。**
  `deeptutor/knowledge/staging.py:20-26`，`def content_hash(file_path: Path) -> str`，注释写明"SHA-256 of a file, streamed in blocks so large documents stay off memory"，块大小 65536。
  `deeptutor/knowledge/add_documents.py:266-319`，`def add_documents(self, source_files: List[str], allow_duplicates: bool = False, source_root: str | Path | None = None) -> List[Path]`。
  关键判定在 `add_documents.py:293-296`：

  ```
  current_hash = self._get_file_hash(source_path)
  if current_hash in ingested_hashes.values() and not allow_duplicates:
      logger.info(f"Skipped (content already indexed): {source_path.name}")
  ```

  注意 `in ingested_hashes.values()`：它比对的是**哈希值集合**，不是"路径→哈希"。也就是说，任何一份内容相同的文件，无论叫什么名字、放在哪个子目录，都算"我已经有这个文件了"。这是按内容去重，不是按身份去重。

- **linked folder 路径：绝对路径字符串。**
  `deeptutor/knowledge/manager.py:2116-2169`，`def detect_folder_changes(self, kb_name: str, folder_id: str) -> dict`；
  `manager.py:2147` `file_str = str(file_path)`，`manager.py:2150` `if file_str in synced_files:`。键就是 `str(绝对路径)`。

- **book 侧的 KB 快照：`raw/` 下的相对 POSIX 路径。**
  `deeptutor/book/kb_health.py:111-136`，`def fingerprint_kb_documents(kb_name, manager=None) -> dict[str, str]`，产出 `{相对路径: "sha256:..."}`。
  `add_documents.py:109-120`（与 `kb_health.py:111-136` 同一套相对路径规则）`def _raw_hash_key(file_path: Path, raw_dir: Path) -> str` 的 docstring 明确要求"索引与删除必须共用这条规则，否则被删文件留下的哈希记录会导致后续 re-add 被静默跳过"。

### 1.2 用什么判「变了」

- **linked folder：mtime 比较。** `manager.py:2148` `file_mtime = datetime.fromtimestamp(file_path.stat().st_mtime)`；`manager.py:2152-2156` 取回上次记录的 ISO 字符串，`if file_mtime > prev_mtime: modified_files.append(file_str)`；解析失败（`except`，2157-2158）直接算 modified。判据是**严格大于**，时间回拨不算变更。
  写入侧 `manager.py:2171-2236` `def update_folder_sync_state(self, kb_name, folder_id, synced_files: list[str], source_mtimes: dict[str, str] | None = None)`，`manager.py:2218` `file_states[file_path] = source_mtimes[file_path]`。
  它自己写清了一条失败处置原则（`manager.py:2224-2227` 注释）：记录失败就**故意不记录**，"让下一次扫描重新同步它，而不是去相信一个缺失的 mtime"。

- **book 侧漂移：集合对称差 + 同键哈希不等。** `kb_health.py:214-226`：
  ```
  new_kbs = [k for k in current if k not in stored and k in book.knowledge_bases]
  removed_kbs = [k for k in stored if k not in current and k in book.knowledge_bases]
  changed_kbs = [k for k, v in current.items() if k in stored and stored[k] and stored[k] != v]
  ...
  changed_documents[kb_name] = sorted(
      set(before) ^ set(after)
      | {key for key in set(before) & set(after) if before[key] != after[key]}
  )
  ```
  这一个表达式同时给出了"新增、删除、路径同名但内容变了"三类。**这是全仓最接近我们需求的一段代码。**

- **单文件级三态：当前 / 已变 / 已缺失。** `deeptutor/services/rag/source_visuals.py:60-67`：
  ```
  def source_state(kb_dir: Path, record: dict[str, Any]) -> str:
      if not record.get("managed_source"):
          return "unmanaged"
      try:
          source = source_file(kb_dir, str(record.get("source_path") or ""))
          return "current" if _sha256_file(source) == record.get("source_document_id") else "changed"
      except (OSError, ValueError):
          return "missing"
  ```
  它把「记录里存了源文件的哈希」当成身份，重算不一致就是 changed，读不到就是 missing。

- **一个明确的反面判据：改名算变更。** `kb_health.py:80-89` `def digest_documents(documents: dict[str, str]) -> str` 的 docstring：
  "Keyed by path, so a pure rename changes the fingerprint even though the bytes did not — the coarse check exists to answer 'did this KB change'."
  DeepTutor 在这层是**故意**把"纯改名"判成变更的，因为它要回答的是"这本书要不要重编"，宁滥勿缺。

### 1.3 旧条目怎么处理

- **同名但内容不同的新文件：占一个不冲突的兄弟名字，两份都留。** `staging.py:29-43` `def non_colliding(dest_path: Path) -> Path`，逐个试 `f"{stem} ({index}){suffix}"`。
  `staging.py:46-70` `def stage_source(source_path, dest_path, *, source_hash: str | None = None) -> tuple[Path, bool]`：目标名已被**同内容**占用 → 直接复用（返回 `(staged, False)`）；被**不同内容**占用 → 顺延到空闲兄弟名再拷贝（返回 `True`）。
  `staging.py:4-9` 的模块 docstring 记了一次真实事故：create 路径直接覆盖同名文件，导致"只索引了最后一个，其余静默丢失（#2041）"。所以这里的取舍是：**宁可多留几份，也不覆盖**。
- **linked folder 的 `synced_files` 只增不减。** `manager.py:2213-2234`：`file_states = folder.get("synced_files", {})` 后仅做 `file_states[file_path] = ...`，没有任何删除键的代码；`folder["file_count"] = len(file_states)` 因此会包含早已不存在的文件。
- **真正的删除是显式的、独立的、不级联的。** `add_documents.py:131-159` `def remove_raw_document(kb_dir: Path, file_path: Path) -> RawDocumentRemoval`：`target.unlink()`（149）+ `del hashes[hash_key]`（156），返回 `was_indexed` 让调用方自己决定要不要重索引；docstring（131-143）说明"向量不在这里动，provider 索引整库，后续 re-index 会清掉"。
  我在 `deeptutor/knowledge/*.py` 与 `deeptutor/api/routers/knowledge.py` 里找 `unlink(`/`rmtree`/`prune`，文件级删除只有这一处和删除端点（`knowledge.py:530` `os.unlink(file_path)`）；`manager.py:1860` 的 `shutil.rmtree(kb_dir)` 是整库删除。**没有找到针对 `raw/` 的垃圾回收或对账清理。**

### 1.4 删除怎么发现（结论：其中一个入口根本不发现）

- **folder 同步入口：不发现删除。** `deeptutor/api/routers/knowledge.py:4789-4830` `async def sync_folder(kb_name, folder_id, background_tasks)`：
  `knowledge.py:4814-4815` `changes = manager.detect_folder_changes(...)`，`files_to_process = changes["new_files"] + changes["modified_files"]`。
  而 `detect_folder_changes` 只遍历**当前盘上存在的文件**（`manager.py:2146`），`synced_files` 里那些已经不在盘上的键，既不会被报告也不会被清理。所以：老师删了一个文件 → 本地 `raw/` 的副本留在原地，索引里也留着。
- **book 漂移入口：发现删除，但只到"某 KB 少了一个路径"这一粒度，且只把书页标脏。** `kb_health.py:215`（`removed_kbs`）与 `kb_health.py:223-226`（对称差里出现的路径）；下游只产 `stale_page_ids`（`kb_health.py:294-297`），不删除任何 raw 文件。
- **首次基线不误报。** `kb_health.py:199-209`：没有存储指纹、或指纹由旧公式写成（`_scheme_changed`，`kb_health.py:73-77`，公式带 `FINGERPRINT_SCHEME = "sha256-paths-v1"`，`kb_health.py:70`）时，直接把当前状态当基线返回 `has_drift=False`。理由写得很清楚：否则一次升级会把所有页同时标脏，而刷新闸门会拒绝清空。

### 1.5 清单 / 索引结构（三份，各有分工）

- **`metadata.json` 里的 `file_hashes`：`{相对 POSIX 路径: "sha256 十六进制"}`。** 写入在 `add_documents.py:549-554` `def _record_successful_hash(self, file_path: Path) -> None`：`metadata.setdefault("file_hashes", {})[hash_key] = file_hash`；读取在 `add_documents.py:256-264` `def get_ingested_hashes(self) -> dict[str, str]`。这是"条目级"清单。
- **`metadata.json` 里的 `linked_folders[].synced_files`：`{绝对路径: mtime ISO 字符串}`，外加 `last_sync` 与 `file_count`（`manager.py:2205-2235`）。这是"外部来源级"清单，键与前一份不同。
- **`KbManifest` / `KbDocument`：展示用的清单，只有 `name` 与 `size`，没有哈希，且每次现算。** `deeptutor/knowledge/manifest.py:103-110`（`class KbDocument`，字段 `name` = "POSIX path relative to the KB's document root (folders included)"、`size` = "Size in bytes, or 0 when the file could not be stat'ed"）；`manifest.py:193-239` `def build_manifest(*, name, kb_dir, entry=None, limit=MANIFEST_NOTE_LIMIT, pattern="")` 的 docstring 写明"counts ... come from the filesystem"、"a large KB costs one directory walk rather than thousands of syscalls"；枚举规则在 `manifest.py:147-175` `def iter_kb_documents(root: Path) -> Iterator[Path]`（排序 DFS，跳过隐藏文件）。
  这份清单**不承载增量语义** —— 它是"现在有什么"的投影，不是"上次同步了什么"的记录。这一点对我们有用：我们那份 `{id: record}` 清单必须承载增量语义（`status` + `updatedAt` + 未来的 `sha256`），不能退化成每次现算的投影，否则"跳过判定"失去依据。

---

## 2. 逐条判定：可迁移 / 不可迁移 / 需改造

判据（我们的硬约束）：
(a) 只有浏览器里的 `fetch` + File System Access + IndexedDB，没有服务端；
(b) 没有跨会话可信的 mtime —— `getFile().lastModified` 拿得到，但那是**我们写入本地副本的时间**，不是老师端时间，且 BB 列表页不可信；
(c) 读不到"远程删除" —— BB 目录页只告诉你现在有什么，不告诉你上次有什么；
(d) 现有资产：文件条目 id = URL 里的 `dt-content-rid-<N>`（`src/bb/dom.js:7` `RID_RE = /dt-content-rid-(\d+)/i`；`src/bb/dom.js:86` `id: rid ? 'dt-content-rid-' + rid[1] : url`），清单 `{files: {id: {id,path,name,size,status,updatedAt}}}`（`src/store/manifest.js:51-81`），跳过判定 `planSkips`（`src/store/manifest-plan.js:40-124`），磁盘只比大小（`src/sinks/existing.js:38-57`，只取 `file.size`，`lastModified` 全仓未使用）。

### 2.1 可迁移

| 机制 | 出处 | 为什么可迁移 |
| --- | --- | --- |
| 路径→哈希映射作为清单结构 | `kb_health.py:111-136`；`add_documents.py:109-120` | 我们的清单已经是 `{id: record}`，"每条 record 再挂一个 `sha256` 字段"是纯加法，不动索引结构也不动跳过判定 |
| 集合对称差 + 同键不等这三件套 | `kb_health.py:214-226` | 我们已有 `planSkips` 里的 `stale`（`manifest-plan.js:119-124`，"清单里有、本次扫描没有：只报告，绝不删本地文件"），两者语义同构，直接接得上 |
| 无基线 / 公式变更时把当前状态当基线 | `kb_health.py:199-209`、`kb_health.py:70-78` | 我们已经有 `manifest.version`（`src/store/manifest.js:77`）可以充当 scheme 位；否则第一次跑同步会把整门课报成"全新" |
| 失败则不记录，让下一轮重做 | `manager.py:2224-2227`；`add_documents.py:540-554`（`_record_successful_hash` 在成功后才写） | 与我们"partial/failed 一律重下"的红线完全同向，是这条红线的现成依据 |
| "不覆盖，宁可多留" | `staging.py:4-9`、`staging.py:46-70` | 取向可迁移（冲突时不静默覆盖），具体命名方案见 2.2 |

### 2.2 不可迁移

- **按内容全球去重**（`add_documents.py:293-296` 的 `current_hash in ingested_hashes.values()`）。
  它在服务端"源文件就在本机"的前提下工作；而且它会把**不同目录下的同名同内容文件**折叠成一份 —— 一门课里 `Week1/slides.pdf` 与 `Week1/backup/slides.pdf` 同内容是常态，折叠即静默丢文件，正是 DeepTutor 自己 `staging.py:4-9` 记录的那类事故。我们这边路径本身就是交付物的一部分。
- **mtime 作为变更判据**（`manager.py:2146-2160`）。
  它的 mtime 来自被扫描的**源文件本身**；我们的"源"在远端 HTTP 后面，BB 不给可信时间戳，本地副本的 `lastModified` 只反映我们自己的写入时刻。两边都不构成"源变了"的证据。任何照搬都会把"用户昨天手动解压过文件夹"判成变更，或把"老师今天覆盖了文件"判成未变。
- **`non_colliding` 的 `( 2 )` 兄弟命名**（`staging.py:29-43`）。
  它是为"把外部目录拍平进 `raw/`"服务的补丁。我们的落盘路径由目录树 segments 决定并与跳过判定同源（`src/sinks/shared.js:59` `relativePath`），造出 `x (2).pdf` 会让路径与 BB 结构分叉，下一轮同步必然再判一次变更。
- **远程内容哈希**（`kb_health.py:55-64` `_hash_file`）。
  它靠本地读文件算 SHA-256。要算"远程文件的新哈希"我们必须先下载完 —— 那已经不是"同步"而是"重下"。所以哈希在我们这儿**不能**用来判"远程是否变了"。

### 2.3 需改造

- **三态 `current/changed/missing`**（`source_visuals.py:60-67`）。
  机制可用，但主语要换：DeepTutor 的 `missing` 指"本地 `raw/` 里的那份没了"；我们关心的是**远端消失了**。远端缺失只能由"本次扫描没有它"推断，而"本次扫描没有它"在扫描不完整时不成立（`src/bb/scan.js:172-177` 收集 `failures`，`src/sinks/existing.js:41` 有 `truncated` 标记）。改造点：缺失必须降级为**候选**，且扫描不完整时整批降级为"未知"，永不据此删本地。
- **"删除是显式动作"**（`add_documents.py:131-159`）。
  它的形态（删文件 + 删哈希记录 + 用 `was_indexed` 告诉调用方还要做什么）可以照搬成我们的"清理 orphan"原语；但它缺少"用户确认"这一层，而 `knowledge.py:4817-4821`（无变更时也写一次同步时间戳）说明它的同步是无人值守的。我们这边必须加确认。
- **`synced_files` 只增不减**（`manager.py:2213-2234`）。
  这不是要迁移的机制，而是要**反向**设计的警示：如果我们的清单也"只增不减"，改名/搬家一次就在本地留一份永久孤儿，且 `file_count` 会长期说谎。改造点：跑完一次扫描必须做一次反向对账，结论（疑似删除 / 疑似孤儿）要落进清单或 UI，而不是只留在内存里。
- **SSOT 分裂**。
  DeepTutor 三套键各说各话（内容哈希 / 绝对路径 / 相对路径），代价是`synced_files` 与 `raw/` 长期不一致。我们只允许**一个**判定键，其余都是它的属性。

---

## 3. 三条候选同步策略

前置事实（三者共用）：条目 id 来自下载 URL 的 `dt-content-rid-<N>`，天然是一个服务端标识；`size` 当前解析为 `undefined`（`src/bb/dom.js:92` `size: undefined`），所以"按大小判变"目前多数情况下**不成立**，除非补上体积探测。下面三条都把这个事实算进代价。

### 策略 A：以 BB 条目 id 为身份 + 大小/路径差异（最小改动）

- **判定键**：`entry.id`（`manifest-plan.js:17-19` `planId(plan) = plan.entry.id`，即 `dt-content-rid-<N>`）；`path` 只是该记录的一个字段。
- **变更检测**：本次扫描的 `{id → (path, name, size)}` 对清单做四分类：
  id 不在清单 → 新增；id 在、`path` 变 → 改名/搬家；id 与 `path` 都在、`size` 不同 → 内容变；id 在、本次扫描没有 → 疑似远程删除。
  现状代码已经算出了其中两类（`manifest-plan.js:68-78` 的 `added/changed/unchanged`）与第三类（`manifest-plan.js:119-124` 的 `stale`），只是还没接到 UI 上当作同步视图。
- **本地动作**：新增/改名 → 流式写入新路径；内容变 → 下载到临时文件后原子替换（`src/sinks/fs.js:98-99` 已经为"必须重建 `createWritable`"付出过代价，替换路径沿用同一约束）；疑似删除 → 只在报告里列出，不碰磁盘。
- **冲突处理**：目标路径已被占用但清单显示它属于**另一个 id** → 不覆盖，落到 `<name>.dup-<rid>` 并在结果里标 `conflict`；路径属于同一 id 才算替换。
- **代价**：最低。不需要新存储字段、不需要读本地文件哈希、不需要额外网络；主要是 UI 与一份 diff 计划（`planSkips` 已经是它的雏形）。
- **弱点**：`size` 为 null 时无法发现"内容变了但大小不变"；改名后旧文件永久残留（必须靠策略 C 的规则补）。

### 策略 B：id + 下载时顺带算的内容哈希（叠加在 A 上）

- **判定键**：id 为主，`sha256` 为第二身份（`kb_health.py:111-136` 的 `{路径: "sha256:..."}` 结构，键换成 id 或路径皆可）。
- **变更检测**：下载流写盘时对同一份字节流增量算 SHA-256 存进 record —— **零额外下载、零额外读盘**，这与 `staging.py:20-26` 的分块哈希同构但成本更低（那份要重读文件）。同步时可对可疑条目（`size` 缺失、或用户点"深度检查"）用 `getFile()` 流式重算，与 record 比对 → 发现**本地被改过或损坏**。
- **本地动作**：命中 record 哈希 → 跳过；本地哈希与 record 不符（用户自己改过）→ 不覆盖，标 `local-modified`；远程 `size` 变 → 重下。
- **冲突处理**：用户改过的文件默认受保护（这是三条策略里**唯一**真正提升数据安全的收益）；要覆盖必须用户逐条确认。
- **代价**：中。每条 record +~70 字节；下载侧几乎免费；本地重算需要读盘，大目录要限流、要可取消，且必须可选（否则用户点一次同步就要全盘读一遍）。
- **关键局限（必须写清）**：哈希**检测不到远程内容变更** —— 算远程新哈希＝下载完。所以 B 买的是"本地篡改检测 + 冲突保护"，不是"少下载"。

### 策略 C：双侧清单对账（DeepTutor drift 式），删除永远只是候选

- **判定键**：纯 id，完全不用路径（`kb_health.py:214-226` 的结构：`set(before) ^ set(after)` 给新增/删除，交集内比较给变更）。
- **变更检测**：远端集合 `R`（本次完整扫描）× 清单集合 `M`：`R - M` 新增，`M - R` 疑似删除，`R ∩ M` 内比 `size`/哈希判变；再把 `path` 差异单独抽出来区分"改名"与"内容变"。
- **本地动作**：新增 → 写；改名 → 写新路径，旧路径进 orphan 列表（可一键清理，但需确认）；`M - R` → 标 `missing-remotely`，**不删本地**，由用户选择保留或清理。
- **冲突处理**：若本次扫描不完整（`failures.length > 0`，或磁盘枚举 `truncated`），把整批 `M - R` 降级为"未知"，禁止进入可清理状态。**这条守卫 DeepTutor 没有，是我们必须自己加的** —— 它的 folder 入口之所以敢不检测删除（`knowledge.py:4814-4815`），恰恰是因为它不删。
- **代价**：高。必须一次完整扫描才可信；要处理"用户自己把文件挪到别处"；要 orphan 列表 + 确认流 + 清单里多一个状态位；测试面明显变大（空清单、全失败扫描、只扫到一半）。

### 推荐

**以 A 作为这次实现的基线，把 B 的"下载时顺带哈希"作为 A 里的一个字段顺手落地，同时把 C 的两条规则（删除只作候选 + 扫描不完整则整批降级）作为硬约束写进 A 的判定里；C 的完整 orphan/清理 UI 先不做。**

理由：
1. A 的判定键已经存在且已经在用（`planId = entry.id`），四分类里有两类现成（`manifest-plan.js:68-78`）、第三类现成（`manifest-plan.js:119-124` 的 `stale`），真正要新写的只有"把 diff 变成计划 + UI"，不触碰任何数据红线。
2. B 里"下载时增量哈希"的边际成本接近零（字节流反正要过手），却换到两条别处换不到的能力：识别"本地被用户改过"、"改名但内容不变"的确认。它的重读全盘部分必须是可选动作，不能塞进默认路径。
3. C 的价值几乎全部集中在"删除永不自动执行 + 扫描不完整就整批降级"这两条规则上；这两条是**判定层的一行 if**，不需要整套对账 UI 才能生效。整套 UI（orphan 清单、逐条确认、清理入口）在没有真实用户反馈前属于过度设计 —— 而且它依赖一个我们尚未验证的前提（远程 rid 是否在改名/覆盖时稳定，见第 4 节第 1 条）。

反过来说，任何方案若不成立，最可能先断在这里：**`dt-content-rid` 是否真的跨改名/覆盖保持不变**。这一条没验证之前，A/B/C 的"判定键"都只是假设。

---

## 4. 没查清的问题

1. **BB 的 `dt-content-rid-<N>` 在"老师改名"和"老师覆盖更新同一文件"两种情况下的稳定性，完全未验证。**
   这是全部策略的地基。可从代码读到的只有它是从下载 URL 里正则出来的（`src/bb/dom.js:7`、`src/bb/dom.js:85-86`），以及入口 URL 不带 `content_id` 时靠 `listContent.jsp` 的 form action 反推（`src/bb/dom.js:10-11`、`src/bb/dom.js:57-62`）。BB 服务端是否在改名时重建 rid、在覆盖时是否保留 rid，需要真实课程环境做对照实验（同一目录前后各扫一次，中途让老师改名/覆盖，比 rid 与 size）。我没有 BB 环境，不猜。
2. **BB 目录页是否给得出文件大小（或者 `HEAD` 能否拿到 `Content-Length` 而不被重定向到登录页）。**
   当前 `size: undefined`（`src/bb/dom.js:92`）说明没取。没有 size，"内容变了但大小不变"根本无法进候选集，策略 A 的第四类会被整类漏掉。
3. **BB 对"被删除的文件"是否留任何痕迹（占位、`deleted` 标记、或 content_id 彻底消失）。**
   若彻底不留痕，则"远程删除"只能由"本次扫描没有"推断，而我们无法区分"被删"与"老师把它移出了我的可见范围 / 该目录读取失败"，确认流就永远省不掉。未查。
4. **同一门课不同目录下的同名同内容文件，BB 是否给出相同 rid。**
   若相同（服务端按内容去重），策略 A 的"一个 id 一个本地路径"就会在两个路径间打架；目前没有证据。
5. **DeepTutor 的 web 端 / `packages/` 是否另有"删除检测 + 用户确认"的 UI 实现。**
   我只系统读了 `deeptutor/` 下的 Python 后端（`knowledge/`、`book/kb_health.py`、`api/routers/knowledge.py`、`services/rag/linked_kb.py`），`web/`、`packages/`、`deeptutor_web/` 未读。因此"DeepTutor 没有删除确认 UI"这句**我不能确认**，只能说后端同步入口（`knowledge.py:4789-4830`）没有。
6. **`raw/` 是否存在我没找到的 GC。**
   我 grep 的范围是 `deeptutor/knowledge/*.py` 与 `deeptutor/api/routers/knowledge.py` 的 `unlink(|rmtree|shutil.move|prune`，找到的文件级删除只有 `add_documents.py:149` 与 `knowledge.py:530`。整仓是否还有别处（例如 reindex 流程里）清理 `raw/` 的孤儿文件，未查完。
7. **`deeptutor/services/rag/linked_kb.py` 是否参与同步。**
   我读了它的函数清单（237 行，`probe_linked_folder`、`assert_path_allowed` 等），没有读到任何"扫描—比对—写状态"的实现，看起来只负责挂载前的校验（`linked_kb.py:120` `def probe_linked_folder(folder_path: str, provider: str) -> ProbeResult`）。这与"同步状态由 `knowledge/manager.py` 管"是两条路，但我没有逐一读完该文件确认。
