import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UnsupportedZip64Error,
  crc32,
  crc32Update,
  dosDateTime,
  localHeader,
  dataDescriptor,
  centralHeader,
  endOfCentralDirectory,
  assertEntrySize,
  assertEntryCount,
  toBytes,
  SIG_LOCAL,
  SIG_CENTRAL,
  SIG_EOCD,
  SIG_DESCRIPTOR,
  FLAGS,
  METHOD_STORE,
  VERSION,
  LOCAL_HEADER_SIZE,
  DESCRIPTOR_SIZE,
  CENTRAL_HEADER_SIZE,
  EOCD_SIZE,
  MAX_ENTRIES
} from '../../src/sinks/zip-core.js';

const utf8 = new TextEncoder();

function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// ================================ CRC32 ================================

test('crc32：标准检验值 123456789 -> 0xCBF43926', () => {
  assert.equal(crc32('123456789'), 0xcbf43926);
  assert.equal(crc32(utf8.encode('123456789')), 0xcbf43926);
  assert.equal(crc32(utf8.encode('123456789').buffer), 0xcbf43926); // ArrayBuffer 也认
});

test('crc32：空输入是 0，返回值是无符号 32 位（不是位运算出来的负数）', () => {
  assert.equal(crc32(''), 0);
  assert.equal(crc32(new Uint8Array(0)), 0);
  assert.ok(crc32('\u0000') >= 0);
  assert.equal(crc32('\u0000'), 0xd202ef8d);
});

test('crc32Update：分块喂与整块喂等价，初值 0', () => {
  const whole = utf8.encode('123456789');
  const state = crc32Update(crc32Update(0, whole.subarray(0, 4)), whole.subarray(4));
  assert.equal(state, 0xcbf43926);
  // 切片视图必须按 byteOffset/byteLength 取，不能把邻居也算进去
  const padded = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
  assert.equal(crc32Update(0, padded.subarray(2, 5)), crc32(new Uint8Array([1, 2, 3])));
});

test('toBytes：字符串按 UTF-8 编码，中文一个字 3 字节', () => {
  assert.equal(toBytes('课件').length, 6);
  assert.deepEqual(Array.from(toBytes('ab')), [0x61, 0x62]);
});

// ============================== DOS 时间 ==============================

test('dosDateTime：位域取值与 2 秒精度（9 秒截成 4）', () => {
  const stamp = dosDateTime(new Date(2024, 4, 6, 7, 8, 9));
  // time = hour << 11 | minute << 5 | second/2
  assert.equal(stamp.time, (7 << 11) | (8 << 5) | 4);
  assert.equal(stamp.time, 14596);
  // date = (year - 1980) << 9 | month << 5 | day
  assert.equal(stamp.date, (44 << 9) | (5 << 5) | 6);
  assert.equal(stamp.date, 22694);
});

test('dosDateTime：1980 之前钳到 1980-01-01 00:00:00', () => {
  assert.deepEqual(dosDateTime(new Date(1979, 11, 31, 23, 59, 58)), { time: 0, date: 33 });
  assert.deepEqual(dosDateTime(new Date(1970, 0, 1)), { time: 0, date: 33 });
});

test('dosDateTime：2108 之后钳到 2107-12-31 23:59:58，且年份不溢出到月份位', () => {
  const stamp = dosDateTime(new Date(2108, 0, 1));
  assert.equal(stamp.date >> 9, 127);
  assert.equal((stamp.date >> 5) & 0x0f, 12);
  assert.equal(stamp.date & 0x1f, 31);
  assert.equal(stamp.time, (23 << 11) | (59 << 5) | 29);
  assert.deepEqual(dosDateTime(new Date(2107, 11, 31, 23, 59, 58)), stamp);
});

test('dosDateTime：非法日期不炸，落回当前时间', () => {
  const stamp = dosDateTime(new Date('nope'));
  assert.ok(Number.isInteger(stamp.time) && Number.isInteger(stamp.date));
  const now = dosDateTime();
  assert.ok(Number.isInteger(now.date));
});

// ========================== local file header ==========================

test('localHeader：签名 / 版本 / 通用位 3+11 / method 0 / 时间 / 名字长度 / 名字位置', () => {
  const name = 'Week 1/a.pdf';
  const bytes = localHeader({ name, time: 14596, date: 22694 });
  assert.equal(bytes.length, LOCAL_HEADER_SIZE + utf8.encode(name).length);
  const view = viewOf(bytes);
  assert.equal(view.getUint32(0, true), SIG_LOCAL);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint16(4, true), VERSION);
  assert.equal(view.getUint16(6, true), FLAGS);
  assert.equal(view.getUint16(6, true), 0x0808); // 位 3 + 位 11
  assert.equal(view.getUint16(8, true), METHOD_STORE); // 绝不 deflate
  assert.equal(view.getUint16(10, true), 14596);
  assert.equal(view.getUint16(12, true), 22694);
  assert.equal(view.getUint16(26, true), name.length);
  assert.equal(view.getUint16(28, true), 0); // extra field 长度
  assert.equal(new TextDecoder().decode(bytes.subarray(30)), name);
});

test('localHeader：crc 与两个长度字段全为 0（真值在 data descriptor 里）', () => {
  const view = viewOf(localHeader({ name: 'a', time: 0, date: 0 }));
  assert.equal(view.getUint32(14, true), 0); // crc32
  assert.equal(view.getUint32(18, true), 0); // 压缩后长度
  assert.equal(view.getUint32(22, true), 0); // 原始长度
});

test('localHeader：中文文件名按 UTF-8 写，长度字段是字节数不是字符数', () => {
  const bytes = localHeader({ name: '课件/第一讲.pdf' });
  const view = viewOf(bytes);
  const nameLen = view.getUint16(26, true);
  assert.equal(nameLen, utf8.encode('课件/第一讲.pdf').length);
  assert.equal(nameLen, 20);
  assert.equal(new TextDecoder().decode(bytes.subarray(30, 30 + nameLen)), '课件/第一讲.pdf');
});

// ============================ data descriptor ==========================

test('dataDescriptor：16 字节、带签名、crc 与两个 size 同值（STORE）', () => {
  const bytes = dataDescriptor({ crc: 0xcbf43926, size: 1234 });
  assert.equal(bytes.length, DESCRIPTOR_SIZE);
  assert.equal(bytes.length, 16);
  const view = viewOf(bytes);
  assert.equal(view.getUint32(0, true), SIG_DESCRIPTOR);
  assert.equal(view.getUint32(0, true), 0x08074b50);
  assert.equal(view.getUint32(4, true), 0xcbf43926);
  assert.equal(view.getUint32(8, true), 1234);
  assert.equal(view.getUint32(12, true), 1234);
});

test('dataDescriptor：crc 高位置位也不会被读成负数', () => {
  const view = viewOf(dataDescriptor({ crc: 0xffffffff, size: 0 }));
  assert.equal(view.getUint32(4, true), 0xffffffff);
});

// ========================= central directory ==========================

test('centralHeader：46 字节头 + 名字，每个字段落在契约偏移上', () => {
  const name = 'Week 1/a.pdf';
  const bytes = centralHeader({ name, crc: 0xcbf43926, size: 4321, offset: 7, time: 14596, date: 22694 });
  assert.equal(bytes.length, CENTRAL_HEADER_SIZE + utf8.encode(name).length);
  assert.equal(bytes.length, 46 + 12);
  const view = viewOf(bytes);
  assert.equal(view.getUint32(0, true), SIG_CENTRAL);
  assert.equal(view.getUint32(0, true), 0x02014b50);
  assert.equal(view.getUint16(4, true), VERSION); // version made by
  assert.equal(view.getUint16(6, true), VERSION); // version needed
  assert.equal(view.getUint16(8, true), FLAGS);
  assert.equal(view.getUint16(10, true), METHOD_STORE);
  assert.equal(view.getUint16(12, true), 14596);
  assert.equal(view.getUint16(14, true), 22694);
  assert.equal(view.getUint32(16, true), 0xcbf43926);
  assert.equal(view.getUint32(20, true), 4321);
  assert.equal(view.getUint32(24, true), 4321);
  assert.equal(view.getUint16(28, true), name.length);
  assert.equal(view.getUint16(30, true), 0); // extra
  assert.equal(view.getUint16(32, true), 0); // comment
  assert.equal(view.getUint16(34, true), 0); // 起始磁盘号
  assert.equal(view.getUint16(36, true), 0); // 内部属性
  assert.equal(view.getUint32(38, true), 0); // 外部属性
  assert.equal(view.getUint32(42, true), 7); // local header 偏移
  assert.equal(new TextDecoder().decode(bytes.subarray(46)), name);
});

test('endOfCentralDirectory：22 字节、签名、两个 count 同值、目录大小与偏移', () => {
  const bytes = endOfCentralDirectory({ count: 3, size: 200, offset: 1000 });
  assert.equal(bytes.length, EOCD_SIZE);
  assert.equal(bytes.length, 22);
  const view = viewOf(bytes);
  assert.equal(view.getUint32(0, true), SIG_EOCD);
  assert.equal(view.getUint32(0, true), 0x06054b50);
  assert.equal(view.getUint16(4, true), 0);
  assert.equal(view.getUint16(6, true), 0);
  assert.equal(view.getUint16(8, true), 3);
  assert.equal(view.getUint16(10, true), 3);
  assert.equal(view.getUint32(12, true), 200);
  assert.equal(view.getUint32(16, true), 1000);
  assert.equal(view.getUint16(20, true), 0);
});

// ========================== Zip64 拒绝路径 ==========================

test('Zip64：单文件 >= 4 GiB 抛 UnsupportedZip64Error（data descriptor 与中央目录各一次）', () => {
  const fourGiB = 0x100000000;
  assert.equal(assertEntrySize(fourGiB - 1), fourGiB - 1);
  assert.throws(() => assertEntrySize(fourGiB), UnsupportedZip64Error);
  assert.throws(() => assertEntrySize(fourGiB), (err) => err.name === 'UnsupportedZip64Error');
  assert.throws(() => dataDescriptor({ crc: 0, size: fourGiB }), UnsupportedZip64Error);
  assert.throws(() => centralHeader({ name: 'a', crc: 0, size: fourGiB, offset: 0 }), UnsupportedZip64Error);
});

test('Zip64：条目数 > 65535 抛 UnsupportedZip64Error', () => {
  assert.equal(assertEntryCount(MAX_ENTRIES), 65535);
  assert.throws(() => assertEntryCount(MAX_ENTRIES + 1), UnsupportedZip64Error);
  assert.throws(() => endOfCentralDirectory({ count: 65536, size: 0, offset: 0 }), UnsupportedZip64Error);
});

test('Zip64：偏移 >= 4 GiB 抛 UnsupportedZip64Error（中央目录指不回 local header）', () => {
  assert.throws(
    () => centralHeader({ name: 'a', crc: 0, size: 1, offset: 0x100000000 }),
    UnsupportedZip64Error
  );
  assert.throws(() => endOfCentralDirectory({ count: 1, size: 1, offset: 0x100000000 }), UnsupportedZip64Error);
});

test('Zip64：拒绝时错误可被 instanceof 与 name 两种方式识别', () => {
  try {
    assertEntrySize(5 * 1024 * 1024 * 1024);
    assert.fail('应当抛错');
  } catch (err) {
    assert.ok(err instanceof UnsupportedZip64Error);
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'UnsupportedZip64Error');
    assert.ok(!/https?:/.test(err.message));
  }
});
