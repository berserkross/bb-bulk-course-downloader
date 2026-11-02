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
