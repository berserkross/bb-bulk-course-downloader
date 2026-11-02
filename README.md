# BB 课件批量下载 (bb-bulk-course-downloader)

篡改猴脚本：扫描 Blackboard Learn 课程内容页，树形勾选后按原始目录结构批量下载课件。

## 明确非目标

- **不做后台执行**（关掉浏览器继续跑 / 定时同步）。那需要在脚本外重建学校 SSO+MFA 登录，是项目里最贵、最脆弱、也最容易触碰校方条款的部分。
- **不打包 ZIP**（M1）。目录树直接写入文件系统，不再经过内存 ZIP。
- **不支持 Blackboard Ultra** 课程内容页（Ultra 没有 `listContent.jsp`；本脚本面向 Original）。

## 开发

```bash
npm install
npm run build      # → dist/bb-bulk-course-downloader.user.js
npm test
```

把 `dist/*.user.js` 拖进 Tampermonkey 即可安装。

## 发布到 GitHub 并开启自动更新

脚本头里的 `@updateURL` / `@downloadURL` 不是手写的，由构建时推导：读 `package.json` 的 `repository` 字段（或环境变量 `BB_REPO_URL`），解析出 github 的 `owner/repo` 才写这两行。

- 两行**同时出现或同时不出现**，绝不会只写一个。
- 拿不到仓库信息就不写这两行，构建仍 `exit 0`，并在 stdout 提示如何开启。宁可没有自动更新，也不写一个每次检查更新都报错的坏地址。
- 两行指向**同一个 Release 资产**：所以 `dist/` 继续留在 `.gitignore` 里，构建产物不需要入库；分支名（`main` / `master`）也不参与任何 URL，改默认分支不会让地址失效。

推导出的地址：

```text
@updateURL    https://github.com/<owner>/<repo>/releases/latest/download/bb-bulk-course-downloader.user.js
@downloadURL  https://github.com/<owner>/<repo>/releases/latest/download/bb-bulk-course-downloader.user.js
```

按顺序执行（把 `<owner>`、`<repo>`、`v2.2.0` 换成你自己的）：

① 在 GitHub 建好空仓库后，关联远端并推送（`dist/` 被忽略，不需要也不应该 `git add -f`）：

```bash
git remote add origin https://github.com/<owner>/<repo>.git && git push -u origin main
```

② 构建产物：

```bash
node build.mjs
```

③ 建 Release：tag 用 `v<package.json 里的 version>`，把 `dist/bb-bulk-course-downloader.user.js` 作为附件上传（本机没有 gh CLI，用网页）：

```bash
start https://github.com/<owner>/<repo>/releases/new
```

④ 在 `package.json` 里写上 `"repository": "https://github.com/<owner>/<repo>.git"` 后重跑 build，产物头里就会带上自动更新的那两行：

```bash
npm pkg set repository=https://github.com/<owner>/<repo>.git && node build.mjs
```

⑤ 用户首次安装就用 `@downloadURL` 那份（Release 附件，永远指向 latest，不必等第 ④ 步改完才可用）：

```text
https://github.com/<owner>/<repo>/releases/latest/download/bb-bulk-course-downloader.user.js
```

验证（应看到两行，且两行内容完全相同）：

```powershell
Select-String -Pattern "@(update|download)URL" dist/*.user.js
```

以后每次发版：改 `version` → `node build.mjs` → 建 Release 上传新产物；已安装的用户会自动收到更新（篡改猴读到 `@updateURL` 的版本号比本地高时才提示）。
