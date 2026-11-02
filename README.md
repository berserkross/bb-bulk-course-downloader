# BB 课件批量下载 (bb-bulk-course-downloader)

篡改猴脚本：扫描 Blackboard Learn 课程内容页，树形勾选后按原始目录结构批量下载课件。

## 明确非目标

- **不做后台执行**（关掉浏览器继续跑 / 定时同步）。那需要在脚本外重建学校 SSO+MFA 登录，是项目里最贵、最脆弱、也最容易触碰校方条款的部分。
- **不打包 ZIP**（M1）。目录树直接写入文件系统，不再经过内存 ZIP。
- **不支持 Blackboard Ultra** 课程内容页（Ultra 没有 `listContent.jsp`；本脚本面向 Original）。

## 开发

```bash
npm install
npm run build      # → dist/bb-bulk-course-downloader.user.js + 仓库根 bb-bulk-course-downloader.user.js
npm test
```

把 `dist/*.user.js` 拖进 Tampermonkey 即可安装。

## 发布与自动更新（自托管 raw 产物）

自动更新走「构建产物进仓库 + `@updateURL` 指向 raw」，不依赖 GitHub Release（远端不需要 Release，也不需要任何 API 凭据）。

脚本头里的 `@updateURL` / `@downloadURL` 不是手写的，由构建时推导：读 `package.json` 的 `repository` 字段（或环境变量 `BB_REPO_URL`），解析出 github 的 `owner/repo` 才写这两行。

- 两行**同时出现或同时不出现**，绝不会只写一个；拿不到仓库信息就不写这两行，构建仍 `exit 0`，并在 stdout 提示如何开启。宁可没有自动更新，也不写一个每次检查更新都报错（或 404）的坏地址。
- 两行指向**同一个 raw 地址**，分支固定 `main`：改默认分支名会改变地址，需要同步改 `src/meta.js` 的 `repoUrls`。
- `dist/` 仍留在 `.gitignore` 里；**仓库根目录的那份产物**（同名 `bb-bulk-course-downloader.user.js`）才是被提交、被 raw 托管的文件，它由 `build.mjs` 在写完 `dist/` 后按**同一份字节**复制出来。
- 复制不能被跳过的东西：根目录那份如果落后于源码，用户装到的就是旧版本。设置 `BB_NO_ROOT_COPY=1` 时构建会跳过这次复制（仅用于只想产出 `dist/`、不想动仓库文件的场合）。

推导出的地址：

```text
@updateURL    https://raw.githubusercontent.com/<owner>/<repo>/main/bb-bulk-course-downloader.user.js
@downloadURL  https://raw.githubusercontent.com/<owner>/<repo>/main/bb-bulk-course-downloader.user.js
```

按顺序执行（把 `<owner>`、`<repo>` 换成你自己的）：

① 在 GitHub 建好空仓库后，关联远端并推送（`dist/` 被忽略；根目录产物要正常提交，不要也不需要 `git add -f`）：

```bash
git remote add origin https://github.com/<owner>/<repo>.git && git push -u origin main
```

② 在 `package.json` 里写上仓库地址（只需一次），然后构建：

```bash
npm pkg set repository=https://github.com/<owner>/<repo>.git && node build.mjs
```

③ 提交根目录那份产物并推送 —— 这一步才是「发布」：

```bash
git add bb-bulk-course-downloader.user.js
git commit -m "chore: rebuild userscript artifact"
git push
```

④ 用户安装地址就是 raw URL（也是 `@downloadURL` 那份）：

```text
https://raw.githubusercontent.com/<owner>/<repo>/main/bb-bulk-course-downloader.user.js
```

（如果用的主分支叫 `master`，把地址里的 `main` 换掉，并同步改 `src/meta.js` 的 `repoUrls`。）

验证（应看到两行，且两行内容完全相同；根目录那份与 `dist/` 那份哈希相同）：

```powershell
Select-String -Pattern "@(update|download)URL" dist/*.user.js
Get-FileHash dist/bb-bulk-course-downloader.user.js, bb-bulk-course-downloader.user.js
git check-ignore -v bb-bulk-course-downloader.user.js   # 应当没有输出
```

以后每次发版：改 `version` → `node build.mjs` → **重新提交根目录那份产物** → push。用户端篡改猴只在 raw 上的版本号比本地高时才提示更新，所以「改了源码但漏提交根目录产物」等于这次发版没发出去。
