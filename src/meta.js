export const meta = {
  name: 'BB 课件批量下载',
  namespace: 'bb-bulk-course-downloader',
  description: '扫描 Blackboard 课程内容，勾选后按原始目录结构批量下载课件',
  matches: [
    'https://*/webapps/blackboard/content/listContent.jsp*',
    'http://*/webapps/blackboard/content/listContent.jsp*'
  ],
  grant: 'none',
  runAt: 'document-idle'
};

/** 产物文件名：banner 里的两个分发 URL 和 esbuild 的 outfile 必须指同一个文件。 */
export const DIST_NAME = 'bb-bulk-course-downloader.user.js';

// 可选的 scheme 前缀 + 可选的 userinfo + host + 分隔符(`:` 或 `/`) + 剩余路径。
const REPO_URL = /^(?:(?:git\+|git)?(?:https?|ssh|git):\/\/)?(?:[^@/\s]+@)?([^/:\s]+)[:/](.+)$/i;

/**
 * 从 package.json 的 repository 或任意 git 远端地址里取出 github 的 owner/repo。
 * 解析不出干净的两段路径就返回 null —— 宁可不出 URL，也不能把坏地址写进脚本头。
 */
export function parseGithubRepo(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;

  let path;
  const shorthand = /^github:([\s\S]+)$/i.exec(raw);
  if (shorthand) {
    path = shorthand[1];
  } else {
    const matched = REPO_URL.exec(raw);
    if (!matched) return null;
    const host = matched[1].toLowerCase();
    if (host !== 'github.com' && host !== 'www.github.com') return null;
    path = matched[2];
  }

  const cleaned = path
    .replace(/[?#][\s\S]*$/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');

  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  return { owner, repo };
}

/**
 * 依次尝试 envUrl（BB_REPO_URL）与 package.json 的 repository，返回第一个能解析出
 * github owner/repo 的候选。全都不行就返回 null：此时不输出 @updateURL/@downloadURL。
 */
export function resolveRepo({ packageJson = {}, envUrl } = {}) {
  const candidates = [];
  if (typeof envUrl === 'string' && envUrl.trim()) candidates.push(envUrl.trim());

  const repository = packageJson.repository;
  if (typeof repository === 'string') candidates.push(repository);
  else if (repository && typeof repository === 'object' && typeof repository.url === 'string') {
    candidates.push(repository.url);
  }

  for (const candidate of candidates) {
    const slug = parseGithubRepo(candidate);
    if (slug) return slug;
  }
  return null;
}

/**
 * @updateURL 与 @downloadURL 指向同一个 Release 资产：构建产物不进仓库（dist/ 继续被 gitignore），
 * 分支名也就不再参与任何 URL。两者同生同灭。
 */
export function repoUrls(slug) {
  const owner = slug && slug.owner;
  const repo = slug && slug.repo;
  if (!owner || !repo) return null;
  const asset = `https://github.com/${owner}/${repo}/releases/latest/download/${DIST_NAME}`;
  return { updateUrl: asset, downloadUrl: asset };
}

/** 生成 ==UserScript== 头。repo 为 null 时整段 URL 行为空，其余行与历史产物逐字一致。 */
export function buildBanner({ version, repo = null } = {}) {
  const urls = repo ? repoUrls(repo) : null;
  const lines = [
    '// ==UserScript==',
    `// @name         ${meta.name}`,
    `// @namespace    ${meta.namespace}`,
    `// @version      ${version}`,
    `// @description  ${meta.description}`
  ];
  if (urls) {
    lines.push(`// @updateURL    ${urls.updateUrl}`, `// @downloadURL  ${urls.downloadUrl}`);
  }
  lines.push(
    ...meta.matches.map((m) => `// @match        ${m}`),
    `// @grant        ${meta.grant}`,
    `// @run-at       ${meta.runAt}`,
    '// @license      MIT',
    '// ==/UserScript==',
    ''
  );
  return lines.join('\n');
}
