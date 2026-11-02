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
