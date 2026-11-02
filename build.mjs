import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { build, context } from 'esbuild';
import { buildBanner, DIST_NAME, resolveRepo } from './src/meta.js';

const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));

// 仓库信息优先取环境变量 BB_REPO_URL，其次 package.json 的 repository；都没有就不写分发 URL。
const repo = resolveRepo({ packageJson: pkg, envUrl: process.env.BB_REPO_URL });

// dist/ 那份用于本地安装，仓库根那份（同名，逐字节相同）提交后由 raw URL 自托管给自动更新。
const DIST_FILE = `dist/${DIST_NAME}`;
const ROOT_FILE = DIST_NAME;
const skipRootCopy = process.env.BB_NO_ROOT_COPY === '1';

// 每次成功产出（含 --watch 的每次重建）都把 dist/ 的同一份字节复制到仓库根，避免根目录产物过期。
const rootCopyPlugin = {
  name: 'root-copy',
  setup(pluginBuild) {
    pluginBuild.onEnd(async (result) => {
      if (result.errors.length > 0) return;
      if (skipRootCopy) {
        console.log(`BB_NO_ROOT_COPY=1，已跳过仓库根产物 ${ROOT_FILE}`);
        return;
      }
      await copyFile(DIST_FILE, ROOT_FILE);
      console.log(`已写入仓库根产物 ${ROOT_FILE}（与 ${DIST_FILE} 逐字节相同，发布前记得 git add）`);
    });
  }
};

const options = {
  entryPoints: ['src/index.js'],
  bundle: true,
  format: 'iife',
  target: ['chrome110', 'firefox115'],
  outfile: DIST_FILE,
  banner: { js: buildBanner({ version: pkg.version, repo }) },
  legalComments: 'none',
  logLevel: 'info',
  plugins: [rootCopyPlugin]
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
