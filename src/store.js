const KEY = 'bb-bulk-course-downloader:settings:v1';

export const DEFAULTS = {
  preserveTree: true,
  downloadConcurrency: 4,
  probeConcurrency: 6,
  minDelayMs: 150,
  maxDelayMs: 400,
  probeSizes: true
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage disabled: settings stay in-memory for this page */
  }
  return next;
}
