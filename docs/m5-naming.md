# M5 命名契约：文件名以服务器响应为准（对齐 fork 原实现）

背景（实测事实）：真实课程页 tests/fixtures/real-eng1002.html 里，文件条目形如

    <li><img class=item_icon alt=File><div class=item><h3>
      <a href=/bbcswebdav/pid-633912-dt-content-rid-12071526_1/xid-12071526_1
         onClick=this.href=/webapps/blackboard/execute/content/file?cmd=view&content_id=_633912_1>
        <span>APA Reference List</span></a>
    </h3></div></li>

锚点文本是 BB 的显示标题（APA Reference List），不含扩展名；href 里也没有文件名（xid-12071526_1）。
所以今天落盘的文件名 = 标题 = 无后缀，且不是文件本名。fork 原实现 blackboard-download.user.js:130-143 的
顺序是：Content-Disposition → 重定向后的 response.url 末段 → 显示标题。本契约把这条顺序搬过来。

## 1. 纯函数（src/bb/files.js 追加导出，既有导出语义一个字不许改）

1.1 export function extensionForMime(mime) → string
- 入参是 content-type 去掉 charset 之后的 MIME（小写）；命中固定映射返回带点的后缀，否则返回空串。
- 必须覆盖：application/pdf→.pdf、wordprocessingml.document→.docx、presentationml.presentation→.pptx、
  spreadsheetml.sheet→.xlsx、application/msword→.doc、vnd.ms-powerpoint→.ppt、vnd.ms-excel→.xls、
  application/zip→.zip、text/plain→.txt、text/csv→.csv、image/png→.png、image/jpeg→.jpg、
  image/gif→.gif、application/octet-stream→空串。

1.2 export function looksLikeFileName(name) → boolean
- true 当且仅当：非空字符串、不含 / 与 反斜杠、以 .加1到8位字母数字 结尾、且不是 xid-* 或 pid-* 形状的占位名。

1.3 export function resolveFileName(input) → string
- input = { disposition, finalUrl, href, title, mime }，全部可选。
- 依次尝试取第一个非空结果：
  1) disposition 里的 filename*=UTF-8''… （先过 decodeName），再 filename="…" 或 filename=…；
  2) finalUrl 的 basename（nameFromUrl 的结果），且 looksLikeFileName 为 true，且它不等于 href 的 basename；
  3) title。
- 收尾：结果没有扩展名（最后一段里没有点）而 title 非空时，用 title 加 extensionForMime(mime) 拼出来的后缀；
  mime 给不出后缀就保持原样。本函数只产名字，sanitizeSegment 由调用方负责。

## 2. 落盘层采纳（src/sinks/fs.js 与 src/sinks/zip.js）

2.1 解析时机：fetch 返回响应之后、创建 writable 与写 ZIP local header 之前。
2.2 解析结果就地替换 plan.fileName，后续 fs 的 getFileHandle(name)、zip 的 pathOf(plan)、事件里的 name、
    进度里的 path 末段全部用新名字 —— 不允许盘上是真名、事件里是标题的分裂。
2.3 重名：同一目录（fs）或同一包（zip）内与新名字冲突时，按既有 dedupePaths 的 (2)/(3) 规则追加，
    冲突判定以解析后的名字为准。
2.4 既有行为一条不许变：流式写入、停滞看门狗、截断校验、重试回退、停机 halted（不可枚举）、4GiB 闸门、partialPackages。
2.5 解析不出名字（无 url、无 disposition、无 title）时保持 plan.fileName 原值，绝不产出空文件名。

## 3. 清单记忆（下一轮做，本轮只约定字段名）
- manifest 的 record 增 fileName 字段；下次扫描对同 id 且同 href 的条目用 record.fileName 覆盖 entry.name，
  零额外请求，从而让「跳过已存在」「体积」这些既有判定继续成立。

## 4. 验收不变量
1. resolveFileName 六条分支各有单测：filename*、filename、finalUrl 真名、finalUrl 占位名（xid-）被拒、title 兜底、
   无扩展名时补 mime 后缀。
2. 盘上落地的文件名必须与 done 事件里的 name 逐字相同。
3. 同一目录两个文件解析出同名时，第二个是 name (2).ext，且两个都成功。
4. looksLikeFileName('xid-12071526_1') 为 false，looksLikeFileName('APA Reference List.pdf') 为 true。
5. zip 包内第一条目的路径末段等于解析后的名字。
6. 全量 npm test 0 fail；既有 401 条断言不许改。