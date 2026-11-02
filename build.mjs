import { readFile, mkdir } from 'node:fs/promises';
import { build, context } from 'esbuild';
import { buildBanner, resolveRepo } from './src/meta.js';

const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));

// 仓库信息优先取环境变量 BB_REPO_URL，其次 package.json 的 repository；都没有就不写分发 URL。
const repo = resolveRepo({ packageJson: pkg, envUrl: process.env.BB_REPO_URL });

const options = {
  entryPoints: ['src/index.js'],
  bundle: true,
  format: 'iife',
  target: ['chrome110', 'firefox115'],
  outfile: 'dist/bb-bulk-course-downloader.user.js',
  banner: { js: buildBanner({ version: pkg.version, repo }) },
  legalComments: 'none',
  logLevel: 'info'
};

await mkdir('dist', { recursive: true });
if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('watching...');
} else {
  await build(options);
}

if (repo) {
  console.log(`自动更新已开启：${repo.owner}/${repo.repo}（@updateURL/@downloadURL 已写入）`);
} else {
  console.log(
    '未检测到 GitHub 仓库信息，已跳过 @updateURL/@downloadURL（篡改猴不会自动更新）。' +
      '要开启：在 package.json 加 "repository": "https://github.com/<owner>/<repo>.git"，或设置环境变量 BB_REPO_URL 后重新构建。'
  );
}
