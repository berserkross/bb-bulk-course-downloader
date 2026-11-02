import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeName, nameFromUrl, sanitizeSegment, buildEntryPath, dedupePaths } from '../../src/bb/files.js';

const encoder = new TextEncoder();
const bytes = (text) => encoder.encode(text).length;

test('decodeName 解码中文百分号编码', () => {
  assert.equal(decodeName('%E8%AF%BE%E4%BB%B6%E4%B8%80.pdf'), '课件一.pdf');
});

test('decodeName 遇到非法百分号转义原样返回', () => {
  assert.equal(decodeName('100%.pdf'), '100%.pdf');
  assert.equal(decodeName('%E4%B8'), '%E4%B8');
  assert.equal(decodeName('%ZZ.pdf'), '%ZZ.pdf');
});

test('decodeName 解码 %20 空格名', () => {
  assert.equal(decodeName('week%201%20notes.txt'), 'week 1 notes.txt');
});

test('nameFromUrl 取 basename 并解码，忽略 query 与 hash', () => {
  assert.equal(
    nameFromUrl('https://bb.example/bbcswebdav/pid-1-dt-content-rid-2_1/xid-2_1?download=true#frag'),
    'xid-2_1'
  );
  assert.equal(nameFromUrl('https://bb.example/bbcswebdav/pid-1/%E8%AF%BE%E4%BB%B6.pdf'), '课件.pdf');
  assert.equal(nameFromUrl(''), '');
});

test('sanitizeSegment 保留中文与中间空格', () => {
  assert.equal(sanitizeSegment('第 1 课讲义'), '第 1 课讲义');
});

test('sanitizeSegment 替换 Windows 非法字符', () => {
  assert.equal(sanitizeSegment('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
});

test('sanitizeSegment 替换控制字符', () => {
  assert.equal(sanitizeSegment('abcd'), 'a_b_c_d');
});

test('sanitizeSegment 去掉尾部点与空格', () => {
  assert.equal(sanitizeSegment('report.pdf...  '), 'report.pdf');
  assert.equal(sanitizeSegment('trailing '), 'trailing');
});

test('sanitizeSegment 拒绝 CON/PRN/AUX/NUL/COM1-9/LPT1-9', () => {
  assert.equal(sanitizeSegment('CON'), 'CON_');
  assert.equal(sanitizeSegment('PRN'), 'PRN_');
  assert.equal(sanitizeSegment('aux'), 'aux_');
  assert.equal(sanitizeSegment('nul'), 'nul_');
  assert.equal(sanitizeSegment('COM1'), 'COM1_');
  assert.equal(sanitizeSegment('lpt9'), 'lpt9_');
});

test('sanitizeSegment 带扩展名的保留名也拒绝（CON.txt）', () => {
  assert.equal(sanitizeSegment('CON.txt'), 'CON_.txt');
  assert.equal(sanitizeSegment('nul.tar.gz'), 'nul_.tar.gz');
});

test('sanitizeSegment 普通名不受保留名规则影响', () => {
  assert.equal(sanitizeSegment('console.txt'), 'console.txt');
  assert.equal(sanitizeSegment('COM10.txt'), 'COM10.txt');
});

test('sanitizeSegment 空名与点目录退化为下划线', () => {
  assert.equal(sanitizeSegment(''), '_');
  assert.equal(sanitizeSegment('   '), '_');
  assert.equal(sanitizeSegment('.'), '_');
  assert.equal(sanitizeSegment('..'), '_');
});

test('sanitizeSegment 超长 UTF-8 名截断到 255 字节且保留扩展名', () => {
  const long = '中'.repeat(100) + '.pdf';
  assert.ok(bytes(long) > 255);
  const safe = sanitizeSegment(long);
  assert.ok(bytes(safe) <= 255, '截断后 ' + bytes(safe) + ' 字节');
  assert.ok(safe.endsWith('.pdf'));
  assert.ok(safe.length > 80);
});

test('sanitizeSegment 恰好 255 字节不改动', () => {
  const exact = 'a'.repeat(251) + '.pdf';
  assert.equal(bytes(exact), 255);
  assert.equal(sanitizeSegment(exact), exact);
});

test('sanitizeSegment 截断不劈开多字节字符', () => {
  const safe = sanitizeSegment('中'.repeat(200) + '.docx');
  assert.ok(bytes(safe) <= 255);
  assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(encoder.encode(safe)), safe);
});

test('buildEntryPath preserveTree=true 逐段 sanitize', () => {
  const path = buildEntryPath({ name: '%E8%AF%BE%E4%BB%B6.pdf', folderPath: ['Week 1', 'a/b'] }, { preserveTree: true });
  assert.deepEqual(path, { segments: ['Week 1', 'a_b'], fileName: '课件.pdf' });
});

test('buildEntryPath preserveTree=false 清空 segments 并加 folder__ 前缀', () => {
  const path = buildEntryPath({ name: 'notes.pdf', folderPath: ['Week 1', 'Slides'] }, { preserveTree: false });
  assert.deepEqual(path, { segments: [], fileName: 'Week 1__Slides__notes.pdf' });
});

test('buildEntryPath preserveTree=false 且无文件夹时保持原名', () => {
  const path = buildEntryPath({ name: 'notes.pdf', folderPath: [] }, { preserveTree: false });
  assert.deepEqual(path, { segments: [], fileName: 'notes.pdf' });
});

test('buildEntryPath 默认 preserveTree=true 且容忍缺失字段', () => {
  assert.deepEqual(buildEntryPath({ name: 'a.txt' }), { segments: [], fileName: 'a.txt' });
  assert.deepEqual(buildEntryPath({}), { segments: [], fileName: '_' });
});

test('dedupePaths 同目录重名追加 (2)/(3)', () => {
  const list = [
    { segments: [], fileName: 'a.pdf' },
    { segments: [], fileName: 'a.pdf' },
    { segments: [], fileName: 'a.pdf' }
  ];
  assert.deepEqual(
    dedupePaths(list).map((item) => item.fileName),
    ['a.pdf', 'a (2).pdf', 'a (3).pdf']
  );
});

test('dedupePaths 与已存在的 (2) 名冲突时继续递增', () => {
  const list = [
    { segments: [], fileName: 'a.pdf' },
    { segments: [], fileName: 'a (2).pdf' },
    { segments: [], fileName: 'a.pdf' }
  ];
  assert.deepEqual(
    dedupePaths(list).map((item) => item.fileName),
    ['a.pdf', 'a (2).pdf', 'a (3).pdf']
  );
});

test('dedupePaths 不同目录的同名文件互不冲突', () => {
  const list = [
    { segments: ['Week 1'], fileName: 'a.pdf' },
    { segments: ['Week 2'], fileName: 'a.pdf' }
  ];
  assert.deepEqual(
    dedupePaths(list).map((item) => item.fileName),
    ['a.pdf', 'a.pdf']
  );
});

test('dedupePaths 大小写不同的重名在同一目录算冲突（Windows 不区分大小写）', () => {
  const list = [
    { segments: [], fileName: 'Notes.PDF' },
    { segments: [], fileName: 'notes.pdf' }
  ];
  assert.deepEqual(
    dedupePaths(list).map((item) => item.fileName),
    ['Notes.PDF', 'notes (2).pdf']
  );
});
