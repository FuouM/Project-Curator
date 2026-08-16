/**
 * Entry point for the dynasty-scans plugin.
 *
 * Registers the sidebar tab, injects plugin-scoped styles, initializes the
 * SQLite schema, and wires the top-bar + view router. esbuild bundles this
 * (and its imports) into the root index.js IIFE via:
 *
 *   cd plugins && node build.js --plugin dynasty-scans
 */

import { TAB_ID, back, navigate, registerRenderer, renderCurrent, setBanner } from "./state";
import { initDb } from "./db";
import { renderLibrary } from "./ui-library";
import { renderBrowse } from "./ui-browse";
import { renderSeries } from "./ui-series";
import { renderReader } from "./ui-reader";
import { renderCache } from "./ui-cache";

const PH = window.PluginHost;
if (!PH) {
  console.error("dynasty-scans: PluginHost not available; aborting.");
} else {
  registerRenderer("library", renderLibrary);
  registerRenderer("browse", renderBrowse);
  registerRenderer("series", renderSeries);
  registerRenderer("reader", renderReader);
  registerRenderer("cache", renderCache);

  injectStyles();

  PH.registerTab(TAB_ID, "Dynasty Scans", "bi bi-book", renderTab);

  console.log("dynasty-scans: registered tab and renderers.");
}

function injectStyles(): void {
  if (document.getElementById("ds-style")) return;
  const style = document.createElement("style");
  style.id = "ds-style";
  style.textContent = `
#view-extensions-dynasty-scans.active {
  display: flex !important;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden !important;
  padding: 0 !important;
}
#ds-root {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  height: 100%;
  overflow: hidden;
}
#ds-topbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  background: var(--sys-window-bg, #f5f5f5);
  border-bottom: 1px solid var(--sys-border-light, #ccc);
  flex-shrink: 0;
  z-index: 10;
}
.ds-nav-tab.active {
  font-weight: bold;
  background: var(--sys-hover-bg, #e5e5e5);
  border-color: var(--sys-border-dark, #999);
}
#ds-title {
  font-size: 13px;
  font-weight: 600;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#ds-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
#ds-banner {
  display: none;
  font-size: 11px;
  color: var(--sys-window-text, #333);
  background: var(--sys-control-bg, #ececec);
  border: 1px solid var(--sys-border-light, #bbb);
  border-radius: 3px;
  padding: 1px 8px;
  margin-left: auto;
  margin-right: 4px;
  white-space: nowrap;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
#ds-view {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 8px;
  display: flex;
  flex-direction: column;
}
#ds-view:has(#ds-reader-container) {
  padding: 0 !important;
  overflow: hidden !important;
}
#ds-view:has(#ds-library-container) {
  overflow: hidden !important;
  height: 100%;
}
#ds-library-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  gap: 8px;
  padding-top: 8px;
  box-sizing: border-box;
}
.ds-library-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 8px;
  flex: 1;
  min-height: 0;
  padding-top: 4px;
}
.ds-library-panel {
  display: flex !important;
  flex-direction: column !important;
  flex: 1;
  min-height: 0;
  margin-top: 10px !important;
  margin-bottom: 0 !important;
  padding: 16px 8px 6px 8px !important;
  position: relative;
}
.ds-library-panel-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 2px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ds-library-panel-footer {
  flex-shrink: 0;
  border-top: 1px solid var(--sys-border-light, #e0e0e0);
  padding-top: 4px;
  margin-top: 4px;
}
.ds-library-followed-box {
  flex-shrink: 0;
  max-height: 150px;
  display: flex !important;
  flex-direction: column !important;
  margin-bottom: 0 !important;
}
.ds-library-followed-scroll {
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 6px;
  padding-right: 2px;
}

/* Generic content helpers */
.ds-muted {
  font-size: 11px;
  color: #777;
  font-style: italic;
}
.ds-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ds-subtabs {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.ds-subtab {
  font-size: 11px;
  padding: 2px 8px;
}
.ds-subtab.active {
  font-weight: 600;
}
.ds-tagline {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.ds-meta-rows {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 6px;
}
.ds-meta-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 11px;
}
.ds-meta-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--sys-text-muted, #666);
  min-width: 105px;
  flex-shrink: 0;
  padding-top: 1px;
}
.ds-meta-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  flex: 1;
}
.ds-series-link {
  font-size: 11px;
  font-weight: 600;
  color: var(--sys-highlight-bg, #0284c7);
  cursor: pointer;
  text-decoration: none;
}
.ds-series-link:hover {
  text-decoration: underline;
}
.tag-pill {
  cursor: pointer;
  user-select: none;
  transition: filter 0.15s ease, opacity 0.15s ease;
}
.tag-pill:hover {
  filter: brightness(0.92);
  opacity: 0.9;
}

/* Library & Browse item rows */
.ds-item {
  border: 1px solid var(--sys-border-light, #e0e0e0);
  background: var(--sys-window-bg, #fff);
  padding: 6px 8px;
  margin-bottom: 4px;
  cursor: pointer;
}
.ds-item:hover {
  background: var(--sys-hover-bg, #f5f5f5);
}
.ds-item-read {
  opacity: 0.72;
  background: var(--sys-window-bg, #fafafa);
  border-left: 3px solid var(--sys-highlight-bg, #64748b);
}
.ds-item-title {
  font-size: 12px;
  font-weight: 500;
}
.ds-item-meta {
  font-size: 11px;
  color: #666;
  margin-top: 2px;
}

/* Cache Management Modal */
.ds-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(2px);
}
.ds-cache-dialog {
  width: 720px;
  max-width: 92vw;
  height: 560px;
  max-height: 88vh;
  background: var(--sys-window-bg, #fff);
  border: 1px solid var(--sys-border-light, #ccc);
  border-radius: 4px;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.28);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--sys-text-color, #111);
}
.ds-cache-titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: var(--sys-control-bg, #f3f3f3);
  border-bottom: 1px solid var(--sys-border-light, #ddd);
  font-weight: 600;
  font-size: 12px;
}
.ds-cache-body {
  flex: 1;
  padding: 12px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ds-stats-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-top: 4px;
}
.ds-stat-card {
  padding: 8px 10px;
  background: var(--sys-control-bg, #f8f8f8);
  border: 1px solid var(--sys-border-light, #e0e0e0);
  border-radius: 3px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ds-stat-val {
  font-size: 16px;
  font-weight: 700;
  color: var(--sys-primary, #0078d4);
}
.ds-stat-lbl {
  font-size: 11px;
  color: var(--sys-text-muted, #666);
}
.ds-cache-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.ds-cache-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 8px;
  width: 100%;
  box-sizing: border-box;
  overflow-y: auto;
  border: 1px solid var(--sys-border-light, #e0e0e0);
  padding: 8px;
  background: var(--sys-window-bg, #fff);
  border-radius: 3px;
}
.ds-cache-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
  border: 1px solid var(--sys-border-light, #e4e4e4);
  background: var(--sys-window-bg, #fafafa);
  border-radius: 3px;
  transition: background 0.1s ease, border-color 0.1s ease;
}
.ds-cache-item:hover {
  background: var(--sys-hover-bg, #f3f3f3);
  border-color: var(--sys-border-medium, #ccc);
}

/* Feed item cover thumbnail */
.ds-feed-cover-wrap {
  width: 42px;
  height: 58px;
  flex-shrink: 0;
  overflow: hidden;
  contain: strict;
  border-radius: 2px;
}
.ds-feed-cover {
  width: 42px;
  height: 58px;
  object-fit: cover;
  border: 1px solid var(--sys-border-light, #ccc);
  background: var(--sys-control-bg, #eee);
  border-radius: 2px;
  flex-shrink: 0;
  display: block;
}
.ds-feed-cover-placeholder {
  width: 42px;
  height: 58px;
  border: 1px solid var(--sys-border-light, #ccc);
  background: var(--sys-control-bg, #eee);
  border-radius: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--sys-text-muted, #aaa);
  font-size: 13px;
  flex-shrink: 0;
}
.ds-feed-update-banner {
  display: flex;
  justify-content: center;
  margin-bottom: 8px;
}
.ds-feed-update-btn {
  font-weight: 600;
  font-size: 11px;
  color: var(--sys-highlight-bg, #0284c7);
  border-color: var(--sys-highlight-bg, #0284c7);
  background: var(--sys-window-bg, #fff);
  padding: 3px 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  cursor: pointer;
}
.ds-feed-update-btn:hover {
  background: var(--sys-hover-bg, #f0f8ff);
}

/* Feed bottom status bar */
.ds-feed-status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 10px;
  margin-top: 10px;
  background: var(--sys-control-bg, #f5f5f5);
  border: 1px solid var(--sys-border-light, #e0e0e0);
  border-radius: 3px;
  font-size: 11px;
}
.ds-feed-status-left {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  color: var(--sys-text-muted, #666);
}
.ds-status-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.ds-status-item b {
  color: var(--sys-window-text, #333);
}
.ds-status-pill {
  padding: 1px 6px;
  border-radius: 2px;
  font-size: 10px;
  font-weight: 600;
}
.ds-status-pill.fresh {
  background: #e6f4ea;
  color: #137333;
  border: 1px solid #ceead6;
}
.ds-status-pill.stale {
  background: #fef7e0;
  color: #b06000;
  border: 1px solid #feefc3;
}
.ds-etag-tag {
  font-family: monospace;
  font-size: 10px;
  background: var(--sys-window-bg, #fff);
  border: 1px solid var(--sys-border-light, #ccc);
  padding: 1px 5px;
  border-radius: 2px;
  color: var(--sys-text-muted, #777);
}
.ds-status-refresh-btn {
  font-size: 10px;
  padding: 2px 8px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.ds-feed-status-right {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ds-scroll-top-btn {
  font-size: 10px;
  padding: 2px 8px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.ds-etag-status-label {
  font-weight: 600;
  color: var(--sys-window-text, #333);
}
.ds-spin {
  animation: ds-spin-anim 0.8s linear infinite;
  display: inline-block;
}
@keyframes ds-spin-anim {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* Series page */
.ds-series-head {
  display: flex;
  gap: 12px;
  margin-bottom: 10px;
}
.ds-cover {
  width: 90px;
  height: 126px;
  object-fit: cover;
  border: 1px solid var(--sys-border-light, #ccc);
  background: #eee;
  flex-shrink: 0;
}
.ds-cover-placeholder {
  width: 90px;
  height: 126px;
  border: 1px solid var(--sys-border-light, #ccc);
  background: #eee;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #aaa;
  flex-shrink: 0;
}
.ds-series-desc {
  font-size: 11px;
  color: #555;
  margin: 6px 0;
  white-space: pre-wrap;
}
.ds-vol-header {
  font-size: 11px;
  font-weight: 600;
  color: #555;
  margin: 10px 0 4px;
}
.ds-chapter-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 6px;
  border: 1px solid var(--sys-border-light, #e0e0e0);
  margin-bottom: 3px;
  cursor: pointer;
  font-size: 12px;
}
.ds-chapter-row:hover {
  background: var(--sys-hover-bg, #f0f0f0);
}
.ds-chapter-read {
  opacity: 0.75;
  background: var(--sys-hover-bg, #f9f9f9);
  border-left: 3px solid #10b981;
}
.ds-chapter-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ds-chapter-badge {
  font-size: 10px;
  color: #666;
  flex-shrink: 0;
}

/* Reader View (Light Mode Default) */
#ds-reader-container {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  background: var(--sys-window-bg, #ffffff);
}

/* Fullscreen Mode (Light Mode) */
#ds-reader-container.ds-fullscreen {
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  width: 100vw !important;
  height: 100vh !important;
  z-index: 99999 !important;
  background: #f0f0f0 !important;
}
#ds-reader-container.ds-fullscreen .ds-reader-nav {
  background: var(--sys-window-bg, #fafafa) !important;
  color: var(--sys-window-text, #333) !important;
  border-bottom: 1px solid var(--sys-border-light, #ccc) !important;
  padding: 6px 12px !important;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}
#ds-reader-container.ds-fullscreen #ds-reader-viewport {
  background: #e6e6e6 !important;
}

/* Dark Mode (Windowed + Fullscreen) */
#ds-reader-container.ds-dark {
  background: #181818;
}
#ds-reader-container.ds-dark .ds-reader-nav {
  background: #1e1e1e !important;
  color: #ffffff !important;
  border-bottom: 1px solid #383838 !important;
}
#ds-reader-container.ds-dark .win-button {
  background: #2b2b2b;
  color: #e0e0e0;
  border-color: #444444;
}
#ds-reader-container.ds-dark .win-button:hover {
  background: #3b3b3b;
  color: #ffffff;
  border-color: #666666;
}
#ds-reader-container.ds-dark .win-button.primary {
  background: var(--sys-primary, #0078d4);
  color: #ffffff;
  border-color: #005a9e;
}
#ds-reader-container.ds-dark .win-input,
#ds-reader-container.ds-dark select {
  background: #2b2b2b;
  color: #e0e0e0;
  border-color: #444444;
}
#ds-reader-container.ds-dark .ds-reader-progress-pill {
  background: #282828;
  border-color: #444444;
  color: #e0e0e0;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
}
#ds-reader-container.ds-dark .ds-reader-progress-track {
  background: #333333;
}
#ds-reader-container.ds-dark #ds-reader-viewport {
  background: #1e1e1e !important;
}
#ds-reader-container.ds-fullscreen.ds-dark {
  background: #181818 !important;
}
#ds-reader-container.ds-fullscreen.ds-dark .ds-reader-nav {
  background: #1e1e1e !important;
  color: #ffffff !important;
  border-bottom: 1px solid #383838 !important;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
}
#ds-reader-container.ds-fullscreen.ds-dark #ds-reader-viewport {
  background: #121212 !important;
}

.ds-reader-nav {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: #666;
  width: 100%;
  box-sizing: border-box;
  padding: 4px 8px;
  background: var(--sys-window-bg, #fafafa);
  border-bottom: 1px solid var(--sys-border-light, #ccc);
  position: sticky;
  top: 0;
  z-index: 20;
  flex-shrink: 0;
}
.ds-reader-progress-wrap {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: center;
  flex: 1;
  min-width: 0;
  gap: 3px;
  padding: 0 6px;
  box-sizing: border-box;
}
.ds-reader-progress-pill {
  display: inline-flex;
  align-self: center;
  align-items: center;
  justify-content: center;
  padding: 1px 12px;
  background: var(--sys-control-bg, #ececec);
  border: 1px solid var(--sys-border-light, #bbb);
  border-radius: 3px;
  font-size: 11px;
  font-weight: 500;
  color: var(--sys-window-text, #333);
  white-space: nowrap;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.7);
}
.ds-reader-progress-track {
  width: 100%;
  height: 4px;
  background: var(--sys-border-light, #d8d8d8);
  border-radius: 2px;
  overflow: hidden;
}
.ds-reader-progress-fill {
  height: 100%;
  width: 0%;
  background: var(--sys-primary, #0078d4);
  border-radius: 2px;
  transition: width 0.25s ease;
}
#ds-reader-viewport {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 10px;
  background: #eaeaea;
}
#ds-reader-viewport.horizontal {
  flex-direction: row;
  align-items: center;
  justify-content: center;
  overflow-y: hidden;
  overflow-x: auto;
}
#ds-reader-strip {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  width: 100%;
}
.ds-slot {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  position: relative;
  margin: 0 auto;
}
.ds-slot-page-badge {
  position: absolute;
  top: 6px;
  left: 6px;
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  font-size: 10px;
  font-weight: bold;
  padding: 2px 6px;
  border-radius: 2px;
  pointer-events: none;
  z-index: 5;
}
.ds-page-img {
  display: block;
  box-shadow: 0 2px 6px rgba(0,0,0,0.5);
}
.ds-slot-loading {
  min-height: 200px;
  background: linear-gradient(90deg, #1a1a1a 25%, #2a2a2a 50%, #1a1a1a 75%);
  background-size: 200% 100%;
  animation: ds-shimmer 1.2s ease-in-out infinite;
}
@keyframes ds-shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* Fit modes */
.fit-width #ds-reader-viewport {
  padding: 8px 0;
}
.fit-width #ds-reader-strip {
  width: 100%;
}
.fit-width .ds-slot {
  width: 100%;
  max-width: 100%;
  padding: 0 8px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
}
.fit-width .ds-page-img {
  width: 100%;
  max-width: 100%;
  height: auto;
  object-fit: contain;
}
.fit-height #ds-reader-viewport {
  align-items: center;
  padding: 0 !important;
}
.fit-height #ds-reader-strip {
  align-items: center;
  gap: 0 !important;
  width: 100%;
}
.fit-height .ds-slot {
  width: 100%;
  height: var(--ds-viewport-full, 100vh);
  min-height: var(--ds-viewport-full, 100vh);
  max-height: var(--ds-viewport-full, 100vh);
  box-sizing: border-box;
  padding: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.fit-height .ds-page-img {
  max-height: 100%;
  max-width: 100%;
  height: auto;
  width: auto;
  object-fit: contain;
}
.fit-original .ds-page-img {
  width: auto;
  height: auto;
  max-width: none;
}
.fit-original .ds-slot {
  width: auto;
}

/* Horizontal paged mode — smooth slide */
#ds-reader-viewport.horizontal {
  overflow: hidden !important;
}
#ds-reader-viewport.horizontal #ds-reader-strip {
  display: flex;
  flex-direction: row;
  align-items: stretch;
  gap: 0 !important;
  width: 100%;
  height: 100%;
  /* strip is one full viewport wide per page; translateX drives the slide */
  transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1);
  will-change: transform;
}
#ds-reader-viewport.horizontal .ds-slot {
  flex: 0 0 100%;
  width: 100%;
  height: 100%;
  max-height: 100%;
  display: flex !important;
  align-items: center;
  justify-content: center;
  padding: 12px;
  box-sizing: border-box;
}
#ds-reader-viewport.horizontal .ds-page-img {
  max-height: 100%;
  max-width: 100%;
  width: auto;
  height: auto;
  object-fit: contain;
}

.ds-slot-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  font-size: 11px;
  color: #888;
  padding: 40px 20px;
  min-height: 240px;
  width: 100%;
  max-width: 460px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px dashed rgba(255, 255, 255, 0.1);
  border-radius: 4px;
}
.ds-slot-pulse-wrap {
  width: 180px;
  height: 4px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 2px;
  overflow: hidden;
  position: relative;
}
.ds-slot-pulse-bar {
  width: 60%;
  height: 100%;
  background: var(--sys-primary, #0078d4);
  border-radius: 2px;
  position: absolute;
  left: -60%;
  animation: ds-pulse-anim 1.4s ease-in-out infinite;
}
@keyframes ds-pulse-anim {
  0% { left: -60%; }
  50% { left: 40%; width: 50%; }
  100% { left: 100%; width: 30%; }
}
.ds-slot-error {
  color: #f87171;
  border-color: rgba(248, 113, 113, 0.3);
}
.ds-progress-text {
  font-size: 11px;
  font-weight: 500;
  color: #333;
}

/* Typeahead */
.ds-search-wrap {
  position: relative;
}
.ds-typeahead {
  position: absolute;
  left: 0;
  right: 0;
  top: 100%;
  z-index: 50;
  background: var(--sys-window-bg, #fff);
  border: 1px solid var(--sys-border-light, #ccc);
  max-height: 260px;
  overflow-y: auto;
}
.ds-typeahead-item {
  padding: 4px 8px;
  font-size: 12px;
  cursor: pointer;
  display: flex;
  gap: 8px;
  align-items: center;
}
.ds-typeahead-item:hover {
  background: var(--sys-hover-bg, #f0f0f0);
}
.ds-typeahead-type {
  font-size: 10px;
  color: #888;
}
`;
  document.head.appendChild(style);
}

/**
 * Constructs the plugin tab DOM. Called once on first tab activation by the
 * Plugin Host; the container is detached until the host appends it, so DOM
 * queries inside the deferred bootstrap run via setTimeout(0).
 */
function renderTab(): HTMLElement {
  const container = document.createElement("div");
  container.id = "ds-root";
  container.innerHTML =
    '<div id="ds-topbar">' +
    '  <div id="ds-nav-tabs" style="display:flex;align-items:center;gap:4px;">' +
    '    <button type="button" class="win-button ds-nav-tab" id="ds-tab-browse">' +
    '      <i class="bi bi-compass"></i> Browse &amp; Recent' +
    '    </button>' +
    '    <button type="button" class="win-button ds-nav-tab" id="ds-tab-library">' +
    '      <i class="bi bi-collection"></i> Library' +
    '    </button>' +
    '    <div id="ds-session-tab-wrap" style="display:none;margin-left:4px;"></div>' +
    '  </div>' +
    '  <span id="ds-title" style="margin-left:8px;"></span>' +
    '  <div id="ds-banner"></div>' +
    '  <div id="ds-actions"></div>' +
    '</div>' +
    '<div id="ds-view"></div>';

  const libBtn = container.querySelector<HTMLButtonElement>("#ds-tab-library");
  libBtn?.addEventListener("click", () => {
    navigate({ view: "library" });
  });

  const browseBtn = container.querySelector<HTMLButtonElement>("#ds-tab-browse");
  browseBtn?.addEventListener("click", () => {
    navigate({ view: "browse" });
  });

  setTimeout(() => {
    void boot();
  }, 0);

  return container;
}

async function boot(): Promise<void> {
  try {
    await initDb();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("dynasty-scans: db init failed:", msg);
    setBanner(`Database init failed: ${msg}`);
  }
  renderCurrent();
}