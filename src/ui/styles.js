const STYLE_ID = 'bbdl-styles';

export const CSS = `
.bbdl-panel,
.bbdl-overlay {
  --bbdl-fg: #e9ecf1;
  --bbdl-bg: #1e2128;
  --bbdl-bg-soft: #262a33;
  --bbdl-line: #39404b;
  --bbdl-muted: #9aa3af;
  --bbdl-accent: #4c8dff;
  --bbdl-danger: #e5534b;
  --bbdl-ok: #3fb950;
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 13px;
  line-height: 1.5;
  color: var(--bbdl-fg);
  box-sizing: border-box;
}

.bbdl-panel *,
.bbdl-overlay * {
  box-sizing: border-box;
  font-family: inherit;
}

.bbdl-panel [hidden],
.bbdl-overlay [hidden] {
  display: none !important;
}

/* ---------- 浮动面板 ---------- */
.bbdl-panel {
  position: fixed;
  left: 16px;
  bottom: 16px;
  width: 324px;
  max-width: calc(100vw - 32px);
  z-index: 2147483000;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}

.bbdl-panel__card {
  width: 100%;
  background: var(--bbdl-bg);
  border: 1px solid var(--bbdl-line);
  border-radius: 12px;
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}

.bbdl-panel--collapsed .bbdl-panel__card {
  display: none;
}

.bbdl-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  background: var(--bbdl-bg-soft);
  border-bottom: 1px solid var(--bbdl-line);
}

.bbdl-panel__title {
  font-weight: 600;
  font-size: 13px;
  letter-spacing: 0.2px;
}

.bbdl-panel__body {
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.bbdl-status {
  margin: 0;
  color: var(--bbdl-fg);
  word-break: break-word;
}

.bbdl-panel[data-state="error"] .bbdl-status {
  color: #ff9a92;
}

.bbdl-panel[data-state="done"] .bbdl-status {
  color: #8ce49a;
}

/* ---------- 按钮 ---------- */
.bbdl-btn {
  appearance: none;
  border: 1px solid var(--bbdl-line);
  background: #2f3540;
  color: var(--bbdl-fg);
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.4;
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease, opacity 0.12s ease;
}

.bbdl-btn:hover:not(:disabled) {
  background: #3a4150;
}

.bbdl-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.bbdl-btn--primary {
  background: var(--bbdl-accent);
  border-color: #3a7ae8;
  color: #fff;
}

.bbdl-btn--primary:hover:not(:disabled) {
  background: #3f7ff0;
}

.bbdl-btn--danger {
  background: #4a2523;
  border-color: #6d3330;
  color: #ffb3ad;
}

.bbdl-btn--danger:hover:not(:disabled) {
  background: #5b2c29;
}

.bbdl-btn--small {
  padding: 4px 9px;
  font-size: 12px;
}

.bbdl-btn--icon {
  padding: 2px 8px;
  font-size: 14px;
  line-height: 1.3;
  border-radius: 6px;
}

.bbdl-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* ---------- 进度 ---------- */
.bbdl-progress {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.bbdl-progress__track {
  height: 6px;
  border-radius: 999px;
  background: #333a45;
  overflow: hidden;
}

.bbdl-progress__fill {
  display: block;
  height: 100%;
  width: 0;
  background: linear-gradient(90deg, #4c8dff, #58c4ff);
  transition: width 0.2s ease;
}

.bbdl-progress__text {
  margin: 0;
  color: var(--bbdl-muted);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---------- 设置 ---------- */
.bbdl-settings {
  border-top: 1px solid var(--bbdl-line);
  padding-top: 6px;
  color: var(--bbdl-muted);
  font-size: 12px;
}

.bbdl-settings > summary {
  cursor: pointer;
  user-select: none;
  color: var(--bbdl-muted);
}

.bbdl-settings__row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}

.bbdl-settings__row input[type="number"] {
  width: 56px;
  background: #2f3540;
  border: 1px solid var(--bbdl-line);
  color: var(--bbdl-fg);
  border-radius: 6px;
  padding: 2px 6px;
  font-size: 12px;
}

.bbdl-note {
  margin: 0;
  color: var(--bbdl-muted);
  font-size: 12px;
}

/* ---------- 结果摘要 ---------- */
.bbdl-summary {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-top: 1px solid var(--bbdl-line);
  padding-top: 8px;
}

.bbdl-summary__head {
  margin: 0;
  font-weight: 600;
}

.bbdl-failed {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 168px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.bbdl-failed__item {
  background: #2b2326;
  border: 1px solid #4a3033;
  border-radius: 8px;
  padding: 5px 8px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.bbdl-failed__name {
  color: #ffd7d3;
  word-break: break-all;
}

.bbdl-failed__path {
  color: var(--bbdl-muted);
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bbdl-failed__reason {
  color: #ff9a92;
  font-size: 12px;
  word-break: break-word;
}

.bbdl-copybox {
  width: 100%;
  resize: vertical;
  background: #12151a;
  color: var(--bbdl-fg);
  border: 1px solid var(--bbdl-line);
  border-radius: 8px;
  padding: 6px;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}

/* ---------- 折叠小圆钮 ---------- */
.bbdl-fab {
  display: none;
  width: 52px;
  height: 52px;
  border-radius: 50%;
  border: 1px solid var(--bbdl-line);
  background: var(--bbdl-bg);
  color: var(--bbdl-fg);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.45);
  cursor: pointer;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.15;
  padding: 0;
}

.bbdl-panel--collapsed .bbdl-fab {
  display: block;
}

/* ---------- 选择对话框 ---------- */
.bbdl-overlay {
  position: fixed;
  inset: 0;
  z-index: 2147483600;
  background: rgba(9, 11, 15, 0.62);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

/* 纵向 flex 容器：头部/工具栏/底部固定，只有 .bbdl-tree 承载滚动。
   刻意不写 overflow: hidden —— 那会把超出 82vh 的内容直接吃掉，连滚动条都不给。 */
.bbdl-dialog {
  width: min(880px, 100%);
  max-height: min(82vh, 860px);
  min-height: 0;
  background: var(--bbdl-bg);
  border: 1px solid var(--bbdl-line);
  border-radius: 14px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
  display: flex;
  flex-direction: column;
  overflow: visible;
}

.bbdl-dialog__head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  padding: 12px 14px;
  background: var(--bbdl-bg-soft);
  border-bottom: 1px solid var(--bbdl-line);
  border-radius: 13px 13px 0 0;
}

.bbdl-dialog__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.bbdl-dialog__toolbar {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--bbdl-line);
}

.bbdl-toolbar__row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  width: 100%;
}

.bbdl-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
}

/* 不变量：每个 .bbdl-group 的实际高度 ≥ 内部所有 .bbdl-row 高度之和，且后一组的头行 top
   必须 ≥ 前一组最后一行的 bottom —— 组与组永不重叠。
   所以这里是块流：column flex 下，溢出非 visible 的 flex 项自动最小尺寸为 0，
   .bbdl-group 会被 flex-shrink 压成十几像素，再由 overflow: hidden 把行裁掉，
   下一组的头就压在被压扁的行上（用户截图里「文字糊成一片」的根因）。
   纵横两轴滚动都交给 .bbdl-tree 的 overflow: auto。 */
.bbdl-tree {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 8px 10px 12px;
  display: block;
}

/* 圆角不靠 overflow: hidden 裁（那会连需要横向滚动的长路径一起裁掉），
   改由文件夹头补上圆角，见 .bbdl-row--folder。 */
.bbdl-group {
  border: 1px solid var(--bbdl-line);
  border-radius: 10px;
  margin: 0 0 10px;
}

/* 行高必须由内容决定：宿主 BB 页面自己的 line-height 一旦被继承过来，
   13px 的中文就会画到行盒之外，被相邻行的底色盖掉半截（用户截图里就是这个现象）。
   所以这里显式钉死 line-height，紧凑度只用 padding / font-size 调，绝不写 height 或 overflow: hidden 去裁。 */
.bbdl-row {
  display: grid;
  /* 体积列定宽 92px：让它别再按内容抢 name 列的宽度。
     width: max-content 让过长的路径把整行撑宽，横向滚动条才有东西可滚。 */
  grid-template-columns: 18px minmax(0, 1fr) 92px;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  width: max-content;
  min-width: 100%;
  min-height: 30px;
  height: auto;
  max-height: none;
  line-height: 1.45;
  cursor: pointer;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
}

.bbdl-row:first-child {
  border-top: 0;
}

/* 组内最后一行补下圆角：组的圆角不再靠 overflow: hidden 裁。 */
.bbdl-group > .bbdl-row:last-child {
  border-radius: 0 0 9px 9px;
}

/* 刻意不用 position: sticky：吸顶行一旦叠在正常行上方，任何一点行盒溢出都会变成
   「上半个字被压掉」。132 行的列表里，吸顶的收益抵不上这个风险。 */
.bbdl-row--folder {
  background: #2a303a;
  font-weight: 600;
  line-height: 1.45;
  border-radius: 9px 9px 0 0;
}

.bbdl-row--file:hover {
  background: #262b34;
}

.bbdl-check {
  margin: 0;
  width: 15px;
  height: 15px;
  accent-color: var(--bbdl-accent);
  cursor: pointer;
}

.bbdl-row__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.45;
}

.bbdl-row__size {
  color: var(--bbdl-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  font-size: 12px;
  line-height: 1.45;
}

/* 路径单行显示：word-break: break-all 会在任意字符处折断，把扩展名和目录段撕开、
   行高被撑成一堆「堆叠」，这正是用户抱怨的观感。改成 nowrap 后整行宽度按 min-content
   撑开，.bbdl-tree 的 overflow: auto 才有横向滚动条可给（配合 select.js 的 title 属性兜底阅读）。*/
/* 路径单行显示：word-break: break-all 会在任意字符处折断，把目录段和扩展名撕开、
   行高跟着堆叠。改成 nowrap 后整行按 min-content 撑开，.bbdl-tree 的 overflow: auto
   才有横向滚动条可给（配合 select.js 里 pathEl.title 兜底阅读）。 */
.bbdl-row__path {
  grid-column: 2 / -1;
  color: #7d868f;
  font-size: 11.5px;
  line-height: 1.45;
  white-space: nowrap;
}

.bbdl-dialog__foot {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  background: var(--bbdl-bg-soft);
  border-top: 1px solid var(--bbdl-line);
  border-radius: 0 0 13px 13px;
  flex-wrap: wrap;
}

.bbdl-dialog__totals {
  font-variant-numeric: tabular-nums;
}

.bbdl-dialog__actions {
  display: flex;
  gap: 8px;
}

.bbdl-dialog__error {
  flex: 0 0 auto;
  margin: 0;
  padding: 8px 14px;
  background: #4a2523;
  border-top: 1px solid #6d3330;
  color: #ffb3ad;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.bbdl-hint {
  color: var(--bbdl-muted);
  font-size: 12px;
}

/* ---------- 筛选 / 搜索 / 排序 ---------- */
.bbdl-search {
  flex: 1 1 160px;
  min-width: 120px;
  background: #12151a;
  color: var(--bbdl-fg);
  border: 1px solid var(--bbdl-line);
  border-radius: 8px;
  padding: 4px 8px;
  font-size: 12px;
}

.bbdl-search::placeholder {
  color: #6d7783;
}

.bbdl-types {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 10px;
}

.bbdl-types__item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  user-select: none;
  font-size: 12px;
  color: var(--bbdl-muted);
}

.bbdl-sort {
  background: #2f3540;
  color: var(--bbdl-fg);
  border: 1px solid var(--bbdl-line);
  border-radius: 8px;
  padding: 4px 6px;
  font-size: 12px;
}

/* ---------- 落盘方式标注 ---------- */
.bbdl-mode {
  margin: 0;
  padding: 6px 14px;
  background: #171b21;
  border-top: 1px solid var(--bbdl-line);
  color: var(--bbdl-muted);
  font-size: 12px;
  word-break: break-word;
}

.bbdl-panel__body .bbdl-mode {
  padding: 6px 8px;
  border: 1px solid var(--bbdl-line);
  border-radius: 8px;
}

@media (prefers-color-scheme: light) {
  .bbdl-panel,
  .bbdl-overlay {
    color-scheme: dark;
  }
}
`;

export function injectStyles(doc) {
  const target = doc || (typeof document === 'undefined' ? null : document);
  if (!target || target.getElementById(STYLE_ID)) return;
  const style = target.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (target.head || target.documentElement).appendChild(style);
}
