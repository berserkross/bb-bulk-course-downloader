/**
 * ZIP 落盘的字节层：全是纯函数、零依赖，不 import 任何浏览器 API，可以在 node 里直接测。
 *
 * 结构固定，只有一种写法：
 * - method = 0（STORE）：课件是视频与 PPT，deflate 换不来体积，只换来 CPU 和内存；
 * - 通用位 3（data descriptor）：CRC 与长度必须边下边算，落完最后一个字节才知道，
 *   所以 local header 里 crc / csize / usize 写 0，真值放进紧随数据之后的 data descriptor；
 * - 通用位 11（UTF-8 文件名）：中文课件名不必再带 info-zip 的 unicode path 扩展字段。
 *
 * ZIP32 是硬边界：单文件 < 4 GiB、条目数 <= 65535、偏移 < 4 GiB。
 * 越过任何一条就抛 UnsupportedZip64Error —— 宁可这个包失败，也不产一个解压工具会吐坏数据的包。
 */

export class UnsupportedZip64Error extends Error {
  constructor(message) {
    super(message || '超出 ZIP32 上限：单文件必须 < 4 GiB 且条目数 <= 65535');
    this.name = 'UnsupportedZip64Error';
  }
}

export const SIG_LOCAL = 0x04034b50;
export const SIG_CENTRAL = 0x02014b50;
export const SIG_EOCD = 0x06054b50;
export const SIG_DESCRIPTOR = 0x08074b50;

/** 通用位 3（data descriptor）+ 通用位 11（UTF-8 文件名）。 */
export const FLAGS = 0x0808;
export const METHOD_STORE = 0;
/** 版本 2.0：STORE + data descriptor 能成立的最低版本。 */
export const VERSION = 20;

export const LOCAL_HEADER_SIZE = 30;
export const DESCRIPTOR_SIZE = 16;
export const CENTRAL_HEADER_SIZE = 46;
export const EOCD_SIZE = 22;
export const MAX_ENTRIES = 65535;

const MAX_UINT32 = 0xffffffff;
const ZIP32_LIMIT = 0x100000000;
const encoder = new TextEncoder();

/**
 * 统一的「字节输入」入口：字符串按 UTF-8 编码，ArrayBuffer / 各种 TypedArray 视图直接取用
 * （切片视图必须按 byteOffset/byteLength 取，直接用 .buffer 会把相邻数据一起算进 CRC）。
 */
export function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return encoder.encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value == null) return new Uint8Array(0);
  return encoder.encode(String(value));
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * 增量 CRC32：state 是上一轮返回值（初值 0），所以 crc32(x) === crc32Update(0, x)，
 * 分块喂与整块喂结果相同。返回值是无符号 32 位（JS 的位运算会给有符号数）。
 */
export function crc32Update(state, bytes) {
  const input = toBytes(bytes);
  let c = (Number(state) ^ MAX_UINT32) >>> 0;
  for (let i = 0; i < input.length; i += 1) c = (CRC_TABLE[(c ^ input[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ MAX_UINT32) >>> 0;
}

export function crc32(bytes) {
  return crc32Update(0, bytes);
}

/**
 * JS Date -> DOS 时间戳（MS-DOS 格式，2 秒精度）。
 * 结果按 ZIP 的边界钳制：1980 之前一律当 1980-01-01 00:00:00，2107 之后当 2107-12-31 23:59:58。
 * 不钳制的话年份会溢出到别的字段里，解压工具会显示 1900 年或直接报错。
 */
export function dosDateTime(date) {
  const d = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
  const year = d.getFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  if (year > 2107) return { time: (23 << 11) | (59 << 5) | 29, date: (127 << 9) | (12 << 5) | 31 };
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

/** 单文件体积（未压缩 = 压缩后，STORE）：>= 4 GiB 就没有 ZIP32 的写法了。 */
export function assertEntrySize(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n < 0) throw new TypeError('体积不合法：' + size);
  if (n >= ZIP32_LIMIT) throw new UnsupportedZip64Error('单文件 ' + n + ' 字节 >= 4 GiB，ZIP32 写不下');
  return n;
}

/** 条目数上限：EOCD 里两个 count 字段都是 16 位。 */
export function assertEntryCount(count) {
  const n = Number(count);
  if (!Number.isFinite(n) || n < 0) throw new TypeError('条目数不合法：' + count);
  if (n > MAX_ENTRIES) throw new UnsupportedZip64Error('条目数 ' + n + ' 超过 ZIP32 上限 ' + MAX_ENTRIES);
  return n;
}

/** 偏移（local header 起点、中央目录起点）同样是 32 位字段。 */
export function assertOffset(offset) {
  const n = Number(offset);
  if (!Number.isFinite(n) || n < 0) throw new TypeError('偏移不合法：' + offset);
  if (n >= ZIP32_LIMIT) throw new UnsupportedZip64Error('偏移 ' + n + ' 超过 4 GiB，ZIP32 写不下');
  return n;
}

function nameBytesOf(name) {
  const bytes = toBytes(name);
  if (bytes.length > 0xffff) throw new UnsupportedZip64Error('文件名 ' + bytes.length + ' 字节，超过 65535');
  return bytes;
}

/**
 * Local file header（30 + 文件名长度）。
 * crc / csize / usize 一律写 0：真值在数据之后的 data descriptor 里（通用位 3 已置位）。
 */
export function localHeader({ name, time = 0, date = 0 } = {}) {
  const nameBytes = nameBytesOf(name);
  const out = new Uint8Array(LOCAL_HEADER_SIZE + nameBytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, SIG_LOCAL, true);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, FLAGS, true);
  view.setUint16(8, METHOD_STORE, true);
  view.setUint16(10, time & 0xffff, true);
  view.setUint16(12, date & 0xffff, true);
  // 14 / 18 / 22 保持 0：crc32、压缩后长度、原始长度
  view.setUint16(26, nameBytes.length, true);
  view.setUint16(28, 0, true); // extra field 长度
  out.set(nameBytes, LOCAL_HEADER_SIZE);
  return out;
}

/**
 * Data descriptor（16 字节，带签名）。
 * STORE 下压缩后长度 === 原始长度，所以两个 size 字段写同一个值。
 */
export function dataDescriptor({ crc = 0, size = 0 } = {}) {
  assertEntrySize(size);
  const out = new Uint8Array(DESCRIPTOR_SIZE);
  const view = new DataView(out.buffer);
  view.setUint32(0, SIG_DESCRIPTOR, true);
  view.setUint32(4, Number(crc) >>> 0, true);
  view.setUint32(8, Number(size), true);
  view.setUint32(12, Number(size), true);
  return out;
}

/**
 * Central directory header（46 + 文件名长度）。
 * 这里是 CRC 与长度唯一的「正式账目」：解压工具按它校验 data descriptor 之后的数据，
 * 两边一致才能解出正确的文件。
 */
export function centralHeader({ name, crc = 0, size = 0, offset = 0, time = 0, date = 0 } = {}) {
  const nameBytes = nameBytesOf(name);
  assertEntrySize(size);
  assertOffset(offset);
  const out = new Uint8Array(CENTRAL_HEADER_SIZE + nameBytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, SIG_CENTRAL, true);
  view.setUint16(4, VERSION, true); // version made by（MS-DOS 上写宿主最低版本即可）
  view.setUint16(6, VERSION, true); // version needed to extract
  view.setUint16(8, FLAGS, true);
  view.setUint16(10, METHOD_STORE, true);
  view.setUint16(12, time & 0xffff, true);
  view.setUint16(14, date & 0xffff, true);
  view.setUint32(16, Number(crc) >>> 0, true);
  view.setUint32(20, Number(size), true); // 压缩后长度
  view.setUint32(24, Number(size), true); // 原始长度
  view.setUint16(28, nameBytes.length, true);
  view.setUint16(30, 0, true); // extra field 长度
  view.setUint16(32, 0, true); // 注释长度
  view.setUint16(34, 0, true); // 起始磁盘号
  view.setUint16(36, 0, true); // 内部属性
  view.setUint32(38, 0, true); // 外部属性
  view.setUint32(42, Number(offset), true); // 对应 local header 的偏移
  out.set(nameBytes, CENTRAL_HEADER_SIZE);
  return out;
}

/** End of central directory（22 字节，无注释）。 */
export function endOfCentralDirectory({ count = 0, size = 0, offset = 0 } = {}) {
  assertEntryCount(count);
  assertEntrySize(size);
  assertOffset(offset);
  const out = new Uint8Array(EOCD_SIZE);
  const view = new DataView(out.buffer);
  view.setUint32(0, SIG_EOCD, true);
  view.setUint16(4, 0, true); // 本磁盘号
  view.setUint16(6, 0, true); // 中央目录起始磁盘号
  view.setUint16(8, Number(count), true); // 本磁盘条目数
  view.setUint16(10, Number(count), true); // 总条目数
  view.setUint32(12, Number(size), true); // 中央目录字节数
  view.setUint32(16, Number(offset), true); // 中央目录起点
  view.setUint16(20, 0, true); // 注释长度
  return out;
}
