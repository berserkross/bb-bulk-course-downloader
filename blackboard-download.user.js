// ==UserScript==
// @name         BB 一键下载所有课件 (ZIP版)
// @namespace    https://github.com/berserkross/bb-bulk-course-downloader
// @version      1.0
// @description  在 Blackboard 课程内容页一键批量下载课件，打包为 ZIP 保留文件夹结构。需先进入某个课程的文件目录（URL 含 listContent.jsp）才会出现下载按钮。（基于 JesperroO 原版修改，使用 ZIP 打包保留文件夹结构）
// @author       berserkross (modified by AI)
// @match        https://*/webapps/blackboard/content/listContent.jsp*
// @grant        none
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// ==/UserScript==

(function() {
    'use strict';

    if (!window.location.href.includes('listContent.jsp')) return;

    const urlParams = new URLSearchParams(window.location.search);
    const courseId = urlParams.get('course_id');
    const contentId = urlParams.get('content_id');

    if (!courseId || !contentId) return;

    const btn = document.createElement('button');
    btn.textContent = '📥 一键下载';
    btn.style.cssText = `
        position: fixed;
        top: 100px;
        right: 20px;
        z-index: 99999;
        padding: 12px 20px;
        background: #28a745;
        color: white;
        border: none;
        border-radius: 5px;
        cursor: pointer;
        font-size: 14px;
        font-weight: bold;
        box-shadow: 0 4px 6px rgba(0,0,0,0.3);
    `;

    btn.onclick = async () => {
        btn.textContent = '⏳ 验证登录...';
        btn.disabled = true;

        try {
            const testResp = await fetch(window.location.href, { credentials: 'include' });
            if (testResp.url.includes('login') || testResp.url.includes('relogin')) {
                alert('请先登录 Blackboard！');
                btn.textContent = '📥 一键下载';
                btn.disabled = false;
                return;
            }
        } catch (e) {}

        btn.textContent = '🔍 扫描中...';

        const baseUrl = window.location.origin;
        const filesByUrl = new Map(); // url -> { url, displayName, folderPath }
        const visited = new Set();
        let folderCount = 0;

        function updateScanStatus() {
            btn.textContent = `🔍 ${folderCount} 个文件夹 / ${filesByUrl.size} 个文件`;
        }

        async function fetchFolder(cid, folderPath) {
            if (visited.has(cid)) return;
            visited.add(cid);
            folderCount++;
            updateScanStatus();

            const url = `${baseUrl}/webapps/blackboard/content/listContent.jsp?course_id=${courseId}&content_id=${cid}`;
            const response = await fetch(url, { credentials: 'include' });
            const html = await response.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');

            // 提取文件链接及 BB 显示名，以 URL 为 key 去重
            doc.querySelectorAll('a[href*="/bbcswebdav/"]').forEach(a => {
                const href = a.getAttribute('href');
                if (filesByUrl.has(href)) return;
                const li = a.closest('li');
                const displayName = (
                    li?.querySelector('.item-name')?.textContent?.trim() ||
                    a.textContent.trim() ||
                    href.split('/').pop()
                );
                filesByUrl.set(href, { url: href, displayName, folderPath });
                updateScanStatus();
            });

            // 并行递归子文件夹
            const subTasks = [];
            doc.querySelectorAll('a[href*="listContent.jsp"]').forEach(a => {
                try {
                    const params = new URLSearchParams(new URL(a.href).search);
                    const fid = params.get('content_id');
                    if (!fid || fid === cid || visited.has(fid)) return;
                    const folderName = (
                        a.closest('li')?.querySelector('.item-name')?.textContent?.trim() ||
                        a.textContent.trim() ||
                        fid
                    );
                    const newPath = folderPath ? `${folderPath}/${folderName}` : folderName;
                    subTasks.push(fetchFolder(fid, newPath));
                } catch (e) {}
            });
            await Promise.all(subTasks);
        }

        await fetchFolder(contentId, '');
        const fileList = [...filesByUrl.values()];

        if (fileList.length === 0) {
            alert('未找到任何文件');
            btn.textContent = '📥 一键下载';
            btn.disabled = false;
            return;
        }

        // ---------- 打包 ZIP ----------
        btn.textContent = `📦 打包中 0/${fileList.length}`;
        const zip = new JSZip();

        // 工具函数：安全解码
        function safeDecode(s) {
            try { return decodeURIComponent(s); } catch (e) { return s; }
        }

        // 从 Content-Disposition 或最终 URL 解析真实文件名
        function resolveFilename(item, response) {
            const disposition = response.headers.get('Content-Disposition');
            if (disposition) {
                let m = disposition.match(/filename\*=UTF-8''([^;\n]+)/i);
                if (m) return safeDecode(m[1].trim());
                m = disposition.match(/filename="?([^";\n]+)"?/i);
                if (m) return safeDecode(m[1].trim());
            }
            if (response.url && response.url !== `${baseUrl}${item.url}`) {
                const urlName = safeDecode(response.url.split('/').pop().split('?')[0]);
                if (urlName && urlName !== 'xid') return urlName;
            }
            return item.displayName;
        }

        // 清理文件名（保留字母数字、汉字、下划线、点、横线，其余替换为下划线）
        function sanitize(name) {
            // 替换 Windows 非法字符（不包括斜杠）
            return name.replace(/[:*?"<>|]/g, '_').trim();
        }

        // 清理文件夹名（同样规则，但保留斜杠？这里不保留，因为我们会逐层处理）
        function sanitizeFolder(name) {
            return name.replace(/[:*?"<>|]/g, '_').trim();
        }

        // 构建 ZIP 内路径
        function buildZipPath(item, fileName) {
            const parts = [];
            if (item.folderPath) {
                // 分割文件夹路径，每层清理
                const folders = item.folderPath.split('/').filter(Boolean);
                for (const f of folders) {
                    parts.push(sanitizeFolder(f));
                }
            }
            parts.push(sanitize(fileName));
            return parts.join('/');
        }

        // 下载单个文件并加入 ZIP
        async function downloadAndAddToZip(item) {
            const fileUrl = `${baseUrl}${item.url}`;
            const response = await fetch(fileUrl, { credentials: 'include' });
            const serverName = resolveFilename(item, response);
            const blob = await response.blob();
            const zipPath = buildZipPath(item, serverName);
            zip.file(zipPath, blob);
        }

        // 带重试的下载（最多重试一次）
        async function safeDownload(item) {
            try {
                await downloadAndAddToZip(item);
            } catch (e) {
                // 重试一次
                try {
                    await new Promise(r => setTimeout(r, 1000));
                    await downloadAndAddToZip(item);
                } catch (e2) {
                    console.error(`Failed: ${item.url}`, e2);
                    throw e2; // 向上抛出以便统计失败次数
                }
            }
        }

        // 并发执行下载（最多 3 个同时）
        let done = 0, failed = 0;
        async function runConcurrent(tasks, concurrency) {
            const queue = [...tasks];
            const workers = Array(concurrency).fill(null).map(async () => {
                while (queue.length) {
                    const task = queue.shift();
                    try {
                        await task();
                        done++;
                    } catch {
                        failed++;
                    }
                    btn.textContent = `📦 打包中 ${done + failed}/${fileList.length}`;
                    // 小延迟避免请求过快
                    await new Promise(r => setTimeout(r, 200));
                }
            });
            await Promise.all(workers);
        }

        const downloadTasks = fileList.map(item => () => safeDownload(item));
        await runConcurrent(downloadTasks, 3);

        btn.textContent = '📦 生成 ZIP...';
        // 生成 ZIP 并下载
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        const downloadLink = document.createElement('a');
        downloadLink.href = URL.createObjectURL(zipBlob);
        downloadLink.download = 'course_files.zip';
        document.body.appendChild(downloadLink);
        downloadLink.click();
        document.body.removeChild(downloadLink);
        URL.revokeObjectURL(downloadLink.href);

        btn.textContent = '✅ 完成!';
        setTimeout(() => {
            btn.textContent = '📥 一键下载';
            btn.disabled = false;
        }, 5000);

        const summary = `下载完成！\n成功: ${done}\n失败: ${failed}\nZIP 文件已下载。`;
        alert(summary);
    };

    document.body.appendChild(btn);
})();
