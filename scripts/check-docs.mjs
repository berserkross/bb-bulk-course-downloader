#!/usr/bin/env node
/**
 * 文档事实检查：README 里声明的版本、测试数、路径与命令必须与仓库现状一致。
 *
 * 检查项：
 *   1. 版本三处一致：package.json / package-lock.json / README 标题 / 仓库根 userscript 的 @version。
 *   2. README 的「共 N 项测试」等于 tests/ 下 test(...) 的实际条数。
 *   3. 反引号引用与命令里出现的仓库内路径真实存在（dist/ 产物与上游 core 分支文件除外）。
 *   4. README 里的 npm run <script> 在 package.json 里有对应脚本。
 *
 * 只检查静态可判定的事实；构建产物是否最新由 CI 的 `git diff --exit-code` 步骤负责。
 *
 * 用法：node scripts/check-docs.mjs
 * 失败返回 1，并把每条不一致打印到 stderr；CI 在测试之前执行。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_FILE = 'bb-bulk-course-downloader.user.js';
const DOC = 'README.md';
const PATH_PREFIXES = ['src/', 'tests/', 'docs/', 'scripts/'];
const TOP_FILES = new Set([
  'build.mjs',
  'package.json',
  'package-lock.json',
  ROOT_FILE,
]);
const SKIP_PREFIXES = ['dist/', 'node_modules/', '.preview/'];
// 上游 core 分支的旧脚本，main 分支本来就没有它。
const UPSTREAM_FILES = new Set(['blackboard-download.user.js']);

const problems = [];
const fail = (message) => problems.push(message);
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const exists = (rel) => existsSync(join(ROOT, rel));

function checkVersion() {
  const pkg = JSON.parse(read('package.json'));
  const readme = read(DOC);
  const version = pkg.version;

  const title = readme.match(/^#\s*BB 课件批量下载\s*·\s*v([0-9.]+)/m);
  if (!title) {
    fail('README 缺少「# BB 课件批量下载 · vX.Y.Z」标题');
  } else if (title[1] !== version) {
    fail(`README 标题版本 v${title[1]} != package.json ${version}`);
  }

  const lock = JSON.parse(read('package-lock.json'));
  if (lock.version !== version) {
    fail(`package-lock.json 版本 ${lock.version} != package.json ${version}`);
  }

  const header = read(ROOT_FILE).match(/^\/\/\s*@version\s+([0-9.]+)/m);
  if (!header) {
    fail(`${ROOT_FILE} 缺少 @version 头`);
  } else if (header[1] !== version) {
    fail(`${ROOT_FILE} @version ${header[1]} != package.json ${version}（构建产物过期？）`);
  }
}

function walkTests(dir, acc = []) {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) {
      walkTests(rel, acc);
    } else if (name.endsWith('.test.js')) {
      acc.push(rel);
    }
  }
  return acc;
}

function checkTestCount() {
  const count = walkTests('tests')
    .map((rel) => (read(rel).match(/^\s*test\(/gm) || []).length)
    .reduce((a, b) => a + b, 0);

  const declared = read(DOC).match(/共\s*(\d+)\s*项测试/);
  if (!declared) {
    fail('README 缺少「共 N 项测试」声明');
  } else if (Number(declared[1]) !== count) {
    fail(`README 声明 ${declared[1]} 项测试，tests/ 实际有 ${count} 条 test(...)`);
  }
}

function checkPath(token, where) {
  let path = token.replace(/\\/g, '/').trim();
  path = path.replace(/:\d+$/, '');
  if (SKIP_PREFIXES.some((prefix) => path.startsWith(prefix))) return;
  if (UPSTREAM_FILES.has(path)) return;
  if (/[*<>{}|]/.test(path)) return;

  const inRepo = PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
  if (!inRepo && !TOP_FILES.has(path)) return;
  if (!exists(path)) {
    fail(`${where} 引用了不存在的路径：${token}`);
  }
}

function checkPaths() {
  const readme = read(DOC);
  for (const match of readme.match(/`[^`\n]+`/g) || []) {
    checkPath(match.slice(1, -1), DOC);
  }

  for (const block of readme.match(/```[a-zA-Z0-9]*\n([\s\S]*?)```/g) || []) {
    for (const match of block.match(/[\w./\\-]+\.(?:js|mjs|json|md)/g) || []) {
      checkPath(match, `${DOC} 命令`);
    }
  }
}

function checkCommands() {
  const pkg = JSON.parse(read('package.json'));
  const readme = read(DOC);
  for (const match of readme.matchAll(/npm run ([\w:-]+)/g)) {
    if (!pkg.scripts || !(match[1] in pkg.scripts)) {
      fail(`README 里的 npm run ${match[1]} 在 package.json 中不存在`);
    }
  }
}

function main() {
  checkVersion();
  checkTestCount();
  checkPaths();
  checkCommands();

  if (problems.length) {
    console.error(`文档一致性检查失败（${problems.length} 项）：`);
    for (const item of problems) console.error(`  - ${item}`);
    return 1;
  }

  console.log('文档一致性检查通过。');
  return 0;
}

process.exit(main());
