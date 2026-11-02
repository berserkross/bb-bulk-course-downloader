import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBanner, parseGithubRepo, repoUrls, resolveRepo } from '../../src/meta.js';

// 这份期望值是「历史产物」的逐字快照，故意不引用 src/meta.js 里的常量：
// 只有写死才能真正证明 @name/@match/@grant 没被分发管道顺手改掉。
const BANNER_WITHOUT_REPO = [
  '// ==UserScript==',
  '// @name         BB 课件批量下载',
  '// @namespace    bb-bulk-course-downloader',
  '// @version      2.2.0',
  '// @description  扫描 Blackboard 课程内容，勾选后按原始目录结构批量下载课件',
  '// @match        https://*/webapps/blackboard/content/listContent.jsp*',
  '// @match        http://*/webapps/blackboard/content/listContent.jsp*',
  '// @grant        none',
  '// @run-at       document-idle',
  '// @license      MIT',
  '// ==/UserScript==',
  ''
].join('\n');

test('parseGithubRepo：https / .git / 尾斜杠 / www 都归一到同一对 owner-repo', () => {
  for (const input of [
    'https://github.com/alice/bb-dl',
    'https://github.com/alice/bb-dl.git',
    'https://github.com/alice/bb-dl/',
    'https://www.github.com/alice/bb-dl',
    'http://github.com/alice/bb-dl.git'
  ]) {
    assert.deepEqual(parseGithubRepo(input), { owner: 'alice', repo: 'bb-dl' }, input);
  }
});

test('parseGithubRepo：ssh scp 写法与 git+ 前缀都能解析', () => {
  assert.deepEqual(parseGithubRepo('git@github.com:alice/bb-dl.git'), { owner: 'alice', repo: 'bb-dl' });
  assert.deepEqual(parseGithubRepo('git+https://github.com/alice/bb-dl.git'), { owner: 'alice', repo: 'bb-dl' });
  assert.deepEqual(parseGithubRepo('ssh://git@github.com/alice/bb-dl.git'), { owner: 'alice', repo: 'bb-dl' });
  assert.deepEqual(parseGithubRepo('github:alice/bb-dl'), { owner: 'alice', repo: 'bb-dl' });
});

test('parseGithubRepo：带 token 的远端地址不会把凭据带进产物 URL', () => {
  assert.deepEqual(parseGithubRepo('https://ghp_secret123@github.com/alice/bb-dl.git'), {
    owner: 'alice',
    repo: 'bb-dl'
  });
});

test('parseGithubRepo：非 github、路径不干净、空值一律 null（宁可不出 URL）', () => {
  for (const input of [
    'https://gitlab.com/alice/bb-dl',
    'https://github.com/alice',
    'https://github.com/alice/bb-dl/tree/main',
    'https://github.com/',
    'alice/bb-dl',
    '',
    '   ',
    null,
    undefined,
    42
  ]) {
    assert.equal(parseGithubRepo(input), null, String(input));
  }
});

test('resolveRepo：三种输入——空仓库信息 / BB_REPO_URL / package.json repository（字符串与对象）', () => {
  assert.equal(resolveRepo({ packageJson: {} }), null);
  assert.equal(resolveRepo({}), null);

  assert.deepEqual(resolveRepo({ packageJson: {}, envUrl: 'https://github.com/bob/proj.git' }), {
    owner: 'bob',
    repo: 'proj'
  });

  assert.deepEqual(resolveRepo({ packageJson: { repository: 'https://github.com/alice/bb-dl.git' } }), {
    owner: 'alice',
    repo: 'bb-dl'
  });

  assert.deepEqual(
    resolveRepo({ packageJson: { repository: { type: 'git', url: 'git@github.com:alice/bb-dl.git' } } }),
    { owner: 'alice', repo: 'bb-dl' }
  );
});

test('resolveRepo：环境变量优先，但坏掉的候选会回落到 package.json', () => {
  assert.deepEqual(
    resolveRepo({
      packageJson: { repository: 'https://github.com/alice/bb-dl.git' },
      envUrl: 'https://github.com/bob/proj.git'
    }),
    { owner: 'bob', repo: 'proj' }
  );

  assert.deepEqual(
    resolveRepo({
      packageJson: { repository: 'https://github.com/alice/bb-dl.git' },
      envUrl: 'https://gitlab.com/bob/proj.git'
    }),
    { owner: 'alice', repo: 'bb-dl' }
  );
});

test('repoUrls：两个 URL 逐字相同，都指向 raw 的 main 分支（产物入库自托管，不再走 Release）', () => {
  const raw = 'https://raw.githubusercontent.com/alice/bb-dl/main/bb-bulk-course-downloader.user.js';
  const urls = repoUrls({ owner: 'alice', repo: 'bb-dl' });

  assert.deepEqual(urls, { updateUrl: raw, downloadUrl: raw });
  // 逐字相同：篡改猴同时用这两行取更新，任何差异都会让两路指向不同内容。
  assert.equal(urls.updateUrl, urls.downloadUrl);
  assert.match(urls.updateUrl, /\/main\//);
  assert.doesNotMatch(urls.updateUrl, /releases\/latest/);
  assert.doesNotMatch(urls.downloadUrl, /releases\/latest/);
});

test('repoUrls：仓库信息不全或解析不出时返回 null（调用方据此两行都不写）', () => {
  for (const slug of [null, undefined, {}, { owner: 'alice' }, { repo: 'bb-dl' }, { owner: '', repo: 'bb-dl' }]) {
    assert.equal(repoUrls(slug), null, JSON.stringify(slug));
  }
});

test('buildBanner：没有仓库信息时逐字等于历史产物（无 @updateURL/@downloadURL）', () => {
  const banner = buildBanner({ version: '2.2.0', repo: null });
  assert.equal(banner, BANNER_WITHOUT_REPO);
  assert.doesNotMatch(banner, /@(update|download)URL/);
  assert.equal(buildBanner({ version: '2.2.0' }), BANNER_WITHOUT_REPO);
});

test('buildBanner：有 github 仓库时两行同时出现，且其余行一个字符都没变', () => {
  const banner = buildBanner({ version: '2.2.0', repo: { owner: 'alice', repo: 'bb-dl' } });
  const lines = banner.split('\n');

  assert.ok(
    lines.includes(
      '// @updateURL    https://raw.githubusercontent.com/alice/bb-dl/main/bb-bulk-course-downloader.user.js'
    ),
    banner
  );
  assert.ok(
    lines.includes(
      '// @downloadURL  https://raw.githubusercontent.com/alice/bb-dl/main/bb-bulk-course-downloader.user.js'
    ),
    banner
  );
  assert.equal(lines.filter((l) => /@(update|download)URL/.test(l)).length, 2);
  assert.doesNotMatch(banner, /releases\/latest/);

  // 去掉这两行必须精确还原无仓库版本。
  const stripped = lines.filter((l) => !/@(update|download)URL/.test(l)).join('\n');
  assert.equal(stripped, BANNER_WITHOUT_REPO);

  // 版本号来自 package.json 的 version，不是仓库名或其他常量。
  assert.match(banner, /^\/\/ @version {6}2\.2\.0$/m);
});
