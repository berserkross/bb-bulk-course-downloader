import { readFile, mkdir } from 'node:fs/promises';
import { build, context } from 'esbuild';
import { meta } from './src/meta.js';

const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));

function banner() {
  return [
    '// ==UserScript==',
    `// @name         ${meta.name}`,
    `// @namespace    ${meta.namespace}`,
    `// @version      ${pkg.version}`,
    `// @description  ${meta.description}`,
    ...meta.matches.map((m) => `// @match        ${m}`),
    `// @grant        ${meta.grant}`,
    `// @run-at       ${meta.runAt}`,
    '// @license      MIT',
    '// ==/UserScript==',
    ''
  ].join('\n');
}

const options = {
  entryPoints: ['src/index.js'],
  bundle: true,
  format: 'iife',
  target: ['chrome110', 'firefox115'],
  outfile: 'dist/bb-bulk-course-downloader.user.js',
  banner: { js: banner() },
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
