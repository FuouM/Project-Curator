/**
 * CSS injection for the aria2-downloader WinForms workspace.
 */

import { TAB_ID } from "./state";

export function injectStyles(): void {
  if (document.getElementById("ad-styles")) return;
  const style = document.createElement("style");
  style.id = "ad-styles";
  style.textContent = `
    #view-extensions-${TAB_ID}.active {
      display: flex !important;
      flex-direction: column;
      height: calc(100vh - 140px);
      max-height: calc(100vh - 140px);
      overflow: hidden !important;
    }
    .ad-workspace {
      display: flex;
      flex-direction: column;
      gap: 8px;
      height: 100%;
      max-height: 100%;
      overflow: hidden;
      padding: 8px;
      box-sizing: border-box;
      font-family: var(--sys-font-family, "Segoe UI", sans-serif);
      color: var(--sys-window-text, #000);
      background: var(--sys-window-bg, #f0f0f0);
    }
    .ad-toolbar { flex-shrink: 0; }
    .ad-banner {
      display: none;
      flex-shrink: 0;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      margin-bottom: 4px;
      font-size: 11px;
      border: 1px solid var(--sys-border-dark, #b0b0b0);
      border-radius: 3px;
      background-color: var(--sys-status-bg, #f3f3f3);
      color: var(--sys-window-text, #000);
    }
    .ad-banner > i { color: #b45309; flex-shrink: 0; }
    .ad-banner-inner { flex: 1; min-width: 0; }
    .ad-banner-status {
      margin-top: 3px;
      font-size: 10px;
      color: var(--sys-text-subtle, #555);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ad-banner-progress {
      margin-top: 4px;
      height: 8px;
      background: #dcdcdc;
      border: 1px solid #c0c0c0;
      border-radius: 2px;
      overflow: hidden;
    }
    .ad-banner-fill { height: 100%; background: var(--sys-highlight-bg, #0078d7); width: 0%; }
    .ad-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 6px;
      max-height: 54px;
      overflow-y: auto;
    }
    .ad-chip {
      font-size: 10px;
      padding: 2px 8px;
      border: 1px solid var(--sys-border-light, #c0c0c0);
      background: var(--sys-window-bg, #fff);
      color: var(--sys-window-text, #333);
      border-radius: 2px;
      white-space: nowrap;
    }
    .ad-chip.ok { border-color: #10b981; color: #047857; }
    .ad-chip.warn { border-color: #f59e0b; color: #b45309; }
    .ad-chip.bad { border-color: #ef4444; color: #b91c1c; }
    .ad-middle {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: row;
      gap: 8px;
    }
    .ad-column {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-height: 0;
    }
    .ad-queue-box { flex: 3; }
    .ad-history-box { flex: 2; }
    .ad-scroll {
      flex: 1;
      min-height: 0;
      overflow: auto;
      border: 1px solid var(--sys-border-light, #d0d0d0);
      background: var(--sys-window-bg, #fff);
    }
    .ad-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 6px;
      font-size: 11px;
      border-bottom: 1px solid #ececec;
    }
    .ad-row:hover { background: #f4f6f8; }
    .ad-row-mono {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: 'Consolas', monospace;
      color: #1a1a2e;
    }
    .ad-error {
      width: 100%;
      color: #b91c1c;
      font-size: 10px;
      font-family: 'Consolas', monospace;
      word-break: break-all;
      white-space: pre-wrap;
    }
    .ad-badge {
      font-size: 10px;
      padding: 1px 7px;
      border-radius: 2px;
      border: 1px solid #c0c0c0;
      background: #f0f0f0;
      color: #444;
      flex-shrink: 0;
    }
    .ad-badge.running { border-color: #3b82f6; background: #dbeafe; color: #1d4ed8; }
    .ad-badge.completed { border-color: #10b981; background: #d1fae5; color: #047857; }
    .ad-badge.cancelled { border-color: #f59e0b; background: #fef3c7; color: #b45309; }
    .ad-badge.failed { border-color: #ef4444; background: #fee2e2; color: #b91c1c; }
    .ad-badge.queued { border-color: #9ca3af; background: #f3f4f6; color: #4b5563; }
    .ad-filter-btn {
      font-size: 10px;
      padding: 1px 8px;
    }
    .ad-filter-btn.active {
      border-color: #1d4ed8;
      background: #dbeafe;
      color: #1d4ed8;
    }
    .ad-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    .ad-table thead th {
      text-align: left;
      font-size: 10px;
      font-weight: 600;
      color: #555;
      padding: 4px 6px;
      border-bottom: 1px solid #d0d0d0;
      background: #f4f6f8;
      position: relative;
      user-select: none;
    }
    .ad-table thead th::after {
      content: "";
      position: absolute;
      top: 3px;
      right: 0;
      bottom: 3px;
      width: 2px;
      background: #c8ccd0;
      cursor: col-resize;
    }
    .ad-table thead th:hover::after { background: #0078d7; }
    .ad-table td {
      padding: 4px 6px;
      font-size: 11px;
      border-bottom: 1px solid #ececec;
      vertical-align: middle;
    }
    .ad-table tbody tr:hover { background: #f4f6f8; }
    .ad-table .col-status { width: 74px; }
    .ad-table .col-hoster { width: 88px; }
    .ad-table .col-progress { width: 150px; }
    .ad-table .col-size { width: 96px; }
    .ad-table .col-speed { width: 84px; }
    .ad-table .col-eta { width: 62px; }
    .ad-table .col-hdate { width: 122px; }
    .ad-table .col-actions { width: 150px; text-align: right; }
    .ad-progress-wrap {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
    }
    .ad-progress {
      flex: 1;
      height: 8px;
      background: #e5e7eb;
      border: 1px solid #c0c0c0;
      border-radius: 2px;
      overflow: hidden;
    }
    .ad-progress-fill { height: 100%; background: #0078d7; width: 0%; }
    .ad-meta {
      color: #555;
      font-size: 10px;
      flex-shrink: 0;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ad-log-dock {
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    .ad-log-box {
      height: 110px;
      max-height: 140px;
      overflow-y: auto;
      background-color: #1e1e1e;
      color: #cccccc;
      border: 1px solid var(--sys-border-dark, #7a7a7a);
      padding: 6px 8px;
      font-family: 'Consolas', monospace;
      font-size: 11px;
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-all;
      box-sizing: border-box;
    }
    /* The app's global universal font rule beats inheritance on child divs,
       so pin every dock line to Consolas explicitly. */
    .ad-log-box div {
      font-family: 'Consolas', monospace;
      font-size: 11px;
      line-height: 1.4;
      color: #cccccc;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .ad-empty { padding: 12px; color: #9ca3af; font-size: 11px; text-align: center; }
    .ad-summary-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 6px;
    }
    .ad-summary-row input[type="number"] { width: 84px; font-size: 11px; }
    .ad-summary-row label { font-size: 10px; color: #555; flex-shrink: 0; }
    .ad-toggle {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      color: #444;
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
    }
    .ad-toggle input[type="checkbox"] { margin: 0; accent-color: var(--sys-highlight-bg, #0078d7); }
    .ad-toolbar-row { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
    .ad-url-input {
      flex: 1;
      min-height: 46px;
      resize: vertical;
      font-family: 'Consolas', monospace;
      font-size: 11px;
    }
  `;
  document.head.appendChild(style);
}
