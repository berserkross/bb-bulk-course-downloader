const KEY = 'bb-bulk-course-downloader:settings:v1';

export const DEFAULTS = {
  preserveTree: true,
  downloadConcurrency: 4,
  probeConcurrency: 6,
  minDelayMs: 150,
  maxDelayMs: 400,
  probeSizes: true,
  // 面板默认收起：首次安装只留左下角一条，不把第三方页面挡住。
  panelCollapsed: true,
  // ZIP 降级落盘的单包上限（200 MiB）：一个包装满就封口交给浏览器，内存上界就是一个包
  zipChunkBytes: 200 * 1024 * 1024
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
