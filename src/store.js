const KEY = 'bb-bulk-course-downloader:settings:v1';

export const DEFAULTS = {
  preserveTree: true,
  downloadConcurrency: 4,
  probeConcurrency: 6,
  minDelayMs: 150,
  maxDelayMs: 400,
  probeSizes: true,
  // 往年卷单独归类（默认关）：命中关键词的文件会额外复制一份到课程根目录的 _exams/，原路径与清单都不动
  separateExams: false,
  // 面板默认收起：首次安装只留左下角一条，不把第三方页面挡住。
  panelCollapsed: true,
  // ZIP 降级落盘的单包上限（200 MiB）：一个包装满就封口交给浏览器，内存上界就是一个包
  zipChunkBytes: 200 * 1024 * 1024,
  // 保活心跳间隔：门户会话闲置太久必死，下载期间定期回敲一次最省事的续命手段
  keepAliveMs: 90 * 1000,
  // 自动续跑的连续零进展熔断阈值（次）：有进展即归零，撞满就交回用户，不再自己转圈
  autoResumeMax: 3,
  // 自动续跑也救不回来时，强制重载页面再续跑（docs/m7-quiet.md §2）：默认开，用户可在面板关掉
  autoReload: true,
  // 同一次停机里最多重载几次（含当前这次）：撞满就暂停，交给用户点「继续」
  autoReloadMax: 2
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
