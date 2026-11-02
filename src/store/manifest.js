import { relativePath } from '../sinks/shared.js';

/** 清单合并（纯函数，绝不改入参）。契约见 docs/sync-contract.md §5。 */

const STATUSES = new Set(['done', 'failed', 'partial']);

/** 写回统一写 version 2；读到 v1 清单也在这里升级（v1 记录本体原样保留）。 */
const MANIFEST_VERSION = 2;

/** 只认有限非负数字；未知一律 null，绝不写 0（0 会让「同名同大小」判定直接失效）。 */
function knownSize(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function planId(plan) {
  const id = plan && plan.entry ? plan.entry.id : null;
  return id === null || id === undefined ? '' : String(id);
}

/** 缺失或脏值一律归为 failed：状态写错也绝不能让半截文件被当成「已完成」跳过。 */
function normalizeStatus(value) {
  return STATUSES.has(value) ? value : 'failed';
}

function stamp(now) {
  return Number.isFinite(now) ? now : Date.now();
}

/** 版本指纹取扫描时的原始 href（契约 §2）。缺失一律空串，绝不写 undefined / null。 */
function planHref(plan) {
  const raw = plan && plan.entry ? plan.entry.href : null;
  return raw === null || raw === undefined ? '' : String(raw).trim();
}

function recordHrefOf(record) {
  const raw = record ? record.href : null;
  return raw === null || raw === undefined ? '' : String(raw).trim();
}

function recordPathOf(record) {
  return record && record.path !== null && record.path !== undefined ? String(record.path) : '';
}

/**
 * @param {{ entry: object, segments: string[], fileName: string }} plan
 * @param {{ status?: string, size?: number | null, now?: number }} [input]
 * @returns {{ id: string, href: string, path: string, name: string, size: number | null, status: string, updatedAt: number }}
 */
export function recordFromPlan(plan, { status, size, now } = {}) {
  return {
    id: planId(plan),
    href: planHref(plan),
    path: relativePath(plan),
    name: plan && plan.fileName !== null && plan.fileName !== undefined ? String(plan.fileName) : '',
    size: knownSize(size),
    status: normalizeStatus(status),
    updatedAt: stamp(now)
  };
}

/**
 * @param {object | null} manifest 上一版清单（不改它）
 * @param {Array<object>} plans 本次的落盘计划，用来补 path / name / href
 * @param {Array<{ id: string, status: string, size?: number | null }>} results 下载结果
 * @param {number} [now]
 * @returns {{ courseId: string, version: number, updatedAt: number, files: Record<string, object> }}
 */
export function updateRecords(manifest, plans, results, now) {
  const source = manifest && typeof manifest === 'object' ? manifest : null;
  const files = { ...((source && source.files) || {}) };
  const byId = new Map();
  for (const plan of Array.isArray(plans) ? plans : []) {
    const id = planId(plan);
    if (id) byId.set(id, plan);
  }
  for (const result of Array.isArray(results) ? results : []) {
    if (!result || result.id === null || result.id === undefined) continue;
    const id = String(result.id);
    const plan = byId.get(id) || null;
    const fresh = recordFromPlan(plan, { status: result.status, size: result.size, now });
    const previous = files[id] && typeof files[id] === 'object' ? files[id] : {};
    files[id] = {
      id,
      // plan 缺席（理论上不该发生）时保留上一版的 href / path，不能让清单丢字段变成死记录。
      href: plan ? fresh.href : recordHrefOf(previous),
      path: plan ? fresh.path : recordPathOf(previous),
      name: plan ? fresh.name : String(previous.name === undefined || previous.name === null ? '' : previous.name),
      size: fresh.size,
      status: fresh.status,
      updatedAt: fresh.updatedAt
    };
  }
  return {
    courseId: source && source.courseId ? String(source.courseId) : '',
    version: MANIFEST_VERSION,
    updatedAt: stamp(now),
    files
  };
}

// ---------------------------------------------------------------- 扫描历史与导出/导入（M4 契约 §3）

/** 导出包标识与版本：固定值，导入端逐字校验。 */
const PACK_FORMAT = 'bbdl-manifest';
const PACK_VERSION = 1;

/** 扫描历史默认上限：一份清单只留最近 10 次扫描。 */
const SCAN_HISTORY_CAP = 10;

/** 计数一律有限非负，否则归 0（NaN / Infinity / -1 / '5' 都不许进历史）。 */
function countOr0(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/** 只认有限非负整数；脏 cap 回落默认值，绝不让脏入参把历史撑爆或写成负数。 */
function capOf(cap) {
  return Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : SCAN_HISTORY_CAP;
}

function textOf(value) {
  return value === null || value === undefined ? '' : String(value);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** changedPaths 只留形状对得上的条目：没有 id 的条目无法定位文件，直接丢。 */
function changedPathsOf(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!isPlainObject(item)) continue;
    const id = textOf(item.id);
    if (!id) continue;
    out.push({ id, path: textOf(item.path) });
  }
  return out;
}

/**
 * 追加一条扫描历史：scans 与 record 平级（不进 files），最新在前，长度不超过 cap。
 * @param {object | null} manifest 上一版清单（不改它）
 * @param {{ at?: number, total?: number, added?: number, changed?: number, moved?: number,
 *   unchanged?: number, unknown?: number, stale?: number,
 *   changedPaths?: Array<{ id: string, path: string }> }} [snapshot]
 * @param {number} [cap]
 * @returns {object} 新清单，scans[0] 是本次
 */
export function appendScanHistory(manifest, snapshot, cap = SCAN_HISTORY_CAP) {
  const source = isPlainObject(manifest) ? manifest : {};
  const snap = isPlainObject(snapshot) ? snapshot : {};
  const previous = Array.isArray(source.scans) ? source.scans : [];
  const entry = {
    at: stamp(snap.at),
    total: countOr0(snap.total),
    added: countOr0(snap.added),
    changed: countOr0(snap.changed),
    moved: countOr0(snap.moved),
    unchanged: countOr0(snap.unchanged),
    unknown: countOr0(snap.unknown),
    stale: countOr0(snap.stale),
    changedPaths: changedPathsOf(snap.changedPaths)
  };
  return {
    ...source,
    // 落库是整条覆盖：files 必须是对象，否则一次拼错字段的调用就能把清单的 files 抹掉。
    files: isPlainObject(source.files) ? source.files : {},
    version: Number.isFinite(source.version) ? source.version : MANIFEST_VERSION,
    // 老条目原样保留、只在尾部截断：历史是既成事实，不再「重新解释」一遍。
    scans: [entry, ...previous].slice(0, capOf(cap))
  };
}

/** 单条记录统一清洗成固定字段；export / import / merge 共用一个口径，往返才幂等。 */
function packRecord(record, fallbackId, now) {
  const src = isPlainObject(record) ? record : {};
  return {
    id: textOf(src.id) || fallbackId,
    href: recordHrefOf(src),
    path: recordPathOf(src),
    name: textOf(src.name),
    size: knownSize(src.size),
    status: normalizeStatus(src.status),
    updatedAt: Number.isFinite(src.updatedAt) ? src.updatedAt : now
  };
}

/** 把 container.files 清洗成 { id: record }；非对象条目直接丢（它连「一条记录」都算不上）。 */
function packFiles(container, now) {
  const files = {};
  const raw = isPlainObject(container) && isPlainObject(container.files) ? container.files : {};
  for (const [key, record] of Object.entries(raw)) {
    const id = textOf(key);
    if (!id || !isPlainObject(record)) continue;
    files[id] = packRecord(record, id, now);
  }
  return files;
}

/**
 * 导出清单包（纯函数）。
 * @param {{ courseId?: string, manifest?: object, exportedAt?: number }} [input]
 * @returns {{ format: string, version: number, exportedAt: number,
 *   courses: Array<{ courseId: string, files: Record<string, object> }> }}
 */
export function exportManifestPack(input) {
  const source = isPlainObject(input) ? input : {};
  const manifest = isPlainObject(source.manifest) ? source.manifest : {};
  const exportedAt = stamp(source.exportedAt);
  return {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    exportedAt,
    courses: [
      { courseId: textOf(source.courseId) || textOf(manifest.courseId), files: packFiles(manifest, exportedAt) }
    ]
  };
}

/**
 * 解析清单包（纯函数，绝不抛）。任何不合法输入都只回一句中文原因，不回显 URL / query。
 * @param {object} pack exportManifestPack 的产物（或等价的 JSON.parse 结果）
 * @param {number} [now]
 * @returns {{ ok: true, course: { courseId: string, manifest: object } }
 *   | { ok: true, courses: Array<{ courseId: string, manifest: object }> }
 *   | { ok: false, error: string }}
 */
export function importManifestPack(pack, now) {
  if (!isPlainObject(pack)) return { ok: false, error: '清单文件内容无法识别' };
  if (pack.format !== PACK_FORMAT) return { ok: false, error: '不是本工具导出的清单文件（格式标识不符）' };
  if (pack.version !== PACK_VERSION) return { ok: false, error: '不支持的清单包版本（只认第 1 版）' };
  if (!Array.isArray(pack.courses)) return { ok: false, error: '清单文件缺少课程列表' };
  if (pack.courses.length === 0) return { ok: false, error: '清单文件里没有任何课程' };
  const at = stamp(now);
  const courses = [];
  for (const item of pack.courses) {
    if (!isPlainObject(item)) return { ok: false, error: '清单文件里的课程记录不合法' };
    const courseId = textOf(item.courseId);
    courses.push({
      courseId,
      manifest: { courseId, version: MANIFEST_VERSION, updatedAt: at, files: packFiles(item, at) }
    });
  }
  // 单课程给 course（调用方直接 merge），多课程给 courses（调用方自己决定导哪一个）。
  return courses.length === 1 ? { ok: true, course: courses[0] } : { ok: true, courses };
}

/** 两边都认的最新时间戳；两边都缺（老清单）才回落到当前时钟。 */
function latestStamp(first, second) {
  const a = Number.isFinite(first) ? first : 0;
  const b = Number.isFinite(second) ? second : 0;
  return Math.max(a, b) || Date.now();
}

/**
 * 导入合并（纯函数）：current 里 status === 'done' 的记录优先保留（磁盘上真有一份，
 * 导入不得把它降级成待重下），其余按 id 用 incoming 覆盖；scans 是本地历史，导入不碰。
 * @param {object | null} current 本地清单
 * @param {object | null} incoming importManifestPack 得到的 manifest
 * @returns {object} version 2 清单
 */
export function mergeManifests(current, incoming) {
  const prev = isPlainObject(current) ? current : {};
  const next = isPlainObject(incoming) ? incoming : {};
  const at = latestStamp(prev.updatedAt, next.updatedAt);
  const files = packFiles(next, at);
  for (const [key, record] of Object.entries(isPlainObject(prev.files) ? prev.files : {})) {
    const id = textOf(key);
    if (!id || !isPlainObject(record)) continue;
    // done 一票否决；incoming 里没有这个 id 时也只能留本地记录，否则导入会凭空丢掉文件。
    if (record.status !== 'done' && files[id]) continue;
    files[id] = packRecord(record, id, at);
  }
  return {
    courseId: textOf(prev.courseId) || textOf(next.courseId),
    version: MANIFEST_VERSION,
    updatedAt: at,
    files,
    scans: Array.isArray(prev.scans) ? prev.scans.slice() : []
  };
}

