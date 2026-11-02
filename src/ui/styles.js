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

.bbdl-dialog {
  width: min(880px, 100%);
  max-height: min(82vh, 860px);
  background: var(--bbdl-bg);
  border: 1px solid var(--bbdl-line);
  border-radius: 14px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.bbdl-dialog__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  background: var(--bbdl-bg-soft);
  border-bottom: 1px solid var(--bbdl-line);
}

.bbdl-dialog__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.bbdl-dialog__toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--bbdl-line);
}

.bbdl-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
}

.bbdl-tree {
  flex: 1 1 auto;
  min-height: 120px;
  max-height: 58vh;
  overflow: auto;
  padding: 8px 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.bbdl-group {
  border: 1px solid var(--bbdl-line);
  border-radius: 10px;
  overflow: hidden;
}

.bbdl-row {
  display: grid;
  grid-template-columns: 18px 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  cursor: pointer;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
}

.bbdl-row:first-child {
  border-top: 0;
}

.bbdl-row--folder {
  background: #2a303a;
  font-weight: 600;
  position: sticky;
  top: 0;
  z-index: 1;
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
  word-break: break-all;
}

.bbdl-row__size {
  color: var(--bbdl-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  font-size: 12px;
}

.bbdl-row__path {
  grid-column: 2 / -1;
  color: #7d868f;
  font-size: 11.5px;
  word-break: break-all;
}

.bbdl-dialog__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  background: var(--bbdl-bg-soft);
  border-top: 1px solid var(--bbdl-line);
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
