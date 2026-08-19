/**
 * Shared module-level state + active-view router for the dynasty-scans plugin.
 *
 * Holds the active route, a small back-stack, and the reader's live progress
 * so view modules can coordinate through one mutable object. The router lives
 * here too so view modules can call `navigate` / `back` / `setBanner` /
 * `setActions` without importing `index.ts` (which would create an import
 * cycle). `index.ts` registers the per-view renderers before first mount.
 */

export const TAB_ID = "dynasty-scans" as const;
export const SITE_ROOT = "https://dynasty-scans.com";
export const DB_NAME = "dynasty_reader.db";

/** Relative path prefix (backend-side convention) under the portable data root. */
export const PAGES_PREFIX = ".curator/plugin_data/dynasty-scans/pages";

export const COVERS_PREFIX = ".curator/plugin_data/dynasty-scans/covers";
import type { Route, ViewName, ChapterRef, SessionMangaTab } from "./types/routes";
export type { Route, ViewName, ChapterRef, SessionMangaTab };

export interface PluginState {
  route: Route;
  /** Ephemeral session tab for the last manga opened in this session (does not persist across restarts). */
  lastMangaTab: SessionMangaTab | null;
  /** Cleanup hook installed by the active view (listeners, observers). */
  dispose: (() => void) | null;
  dbInitialized: boolean;
}

export const state: PluginState = {
  route: { view: "browse" },
  lastMangaTab: null,
  dispose: null,
  dbInitialized: false,
};

export async function loadPluginView(customRoute?: Route): Promise<void> {
  if (customRoute) {
    state.route = customRoute;
  }
  if (!state.dbInitialized) {
    try {
      const { initDb } = await import("./db");
      await initDb();
      state.dbInitialized = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("dynasty-scans: db init failed:", msg);
      setBanner(`Database init failed: ${msg}`);
    }
  }
  renderCurrent();
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export type Renderer = (container: HTMLElement, route: Route) => (() => void) | void;

const renderers: Partial<Record<ViewName, Renderer>> = {};

/** Registers the render function for a view. Called once by index.ts. */
export function registerRenderer(view: ViewName, fn: Renderer): void {
  renderers[view] = fn;
}

const persistentPanes = new Map<string, HTMLElement>();

type RouteChangeHook = (view: ViewName) => void;
const routeChangeHooks: RouteChangeHook[] = [];

/**
 * Registers a hook invoked on every top-level route change, before the new
 * view renders. Views use this to reset their module-scope transient state when
 * the user navigates away (e.g. the browse search/downloaded filter state).
 */
export function onRouteChange(fn: RouteChangeHook): void {
  routeChangeHooks.push(fn);
}

/** Re-renders the current route into #ds-view. Also used for the first paint. */
export function renderCurrent(): void {
  const view = document.getElementById("ds-view");
  if (!view) return;

  clearBanner();
  clearActions();
  const r = state.route;
  setTitle(routeTitle(r));

  const libTab = document.getElementById("ds-tab-library");
  const browseTab = document.getElementById("ds-tab-browse");
  if (libTab) {
    if (r.view === "library") libTab.classList.add("active");
    else libTab.classList.remove("active");
  }
  if (browseTab) {
    if (r.view === "browse") browseTab.classList.add("active");
    else browseTab.classList.remove("active");
  }

  updateSessionMangaTabUI();

  // Handle persistent views (Browse and Library) without tearing down DOM
  if (r.view === "browse" || r.view === "library") {
    state.dispose?.();
    state.dispose = null;

    // Remove any dynamic sub-view (reader / series / cache) from #ds-view
    const dynamicNodes = Array.from(view.children).filter(
      (el) => el.id !== "ds-pane-browse" && el.id !== "ds-pane-library"
    );
    for (const node of dynamicNodes) {
      node.remove();
    }

    // Toggle persistent panes
    for (const [vName, pane] of persistentPanes.entries()) {
      pane.style.display = vName === r.view ? "flex" : "none";
    }

    let targetPane = persistentPanes.get(r.view);
    if (!targetPane) {
      targetPane = document.createElement("div");
      targetPane.id = `ds-pane-${r.view}`;
      targetPane.className = "ds-persistent-view-pane";
      targetPane.style.display = "flex";
      view.appendChild(targetPane);
      persistentPanes.set(r.view, targetPane);

      const renderer = renderers[r.view];
      if (renderer) renderer(targetPane, r);
    } else if (r.view === "library") {
      // Refresh library database lists in-place
      const renderer = renderers.library;
      if (renderer) renderer(targetPane, r);
    }
    return;
  }

  // Dynamic non-persisted routes (reader, series, cache)
  for (const pane of persistentPanes.values()) {
    pane.style.display = "none";
  }

  state.dispose?.();
  state.dispose = null;

  // Remove any previous dynamic nodes
  const dynamicNodes = Array.from(view.children).filter(
    (el) => el.id !== "ds-pane-browse" && el.id !== "ds-pane-library"
  );
  for (const node of dynamicNodes) {
    node.remove();
  }

  const dynamicContainer = document.createElement("div");
  dynamicContainer.id = "ds-pane-dynamic";
  view.appendChild(dynamicContainer);

  const renderer = renderers[r.view];
  const cleanup = renderer ? renderer(dynamicContainer, r) : undefined;
  if (typeof cleanup === "function") state.dispose = cleanup;
}

/** Navigates to a new route and updates the ephemeral session manga tab if entering a manga/chapter. */
export function navigate(r: Route): void {
  if (r.view === "reader" || r.view === "series") {
    const title = r.seriesName || r.chapterTitle || (r.view === "series" ? "Series" : "Reader");
    state.lastMangaTab = {
      title,
      route: { ...r },
    };
  }
  state.route = r;
  for (const hook of routeChangeHooks) hook(r.view);
  renderCurrent();
}

/** Closes the ephemeral session manga tab. */
export function closeSessionMangaTab(): void {
  state.lastMangaTab = null;
  updateSessionMangaTabUI();
  if (state.route.view === "reader" || state.route.view === "series") {
    navigate({ view: "browse" });
  }
}

/** Updates the session manga tab element in the top bar. */
export function updateSessionMangaTabUI(): void {
  const container = document.getElementById("ds-session-tab-wrap");
  if (!container) return;
  container.innerHTML = "";

  if (!state.lastMangaTab) {
    container.style.display = "none";
    return;
  }

  container.style.display = "inline-flex";

  const tab = document.createElement("button");
  tab.type = "button";
  const isActive = state.route.view === "reader" || state.route.view === "series";
  tab.className = `win-button ds-nav-tab ds-session-tab${isActive ? " active" : ""}`;
  tab.style.cssText =
    "display:inline-flex;align-items:center;gap:6px;max-width:220px;padding:2px 8px;font-size:11px;";

  const icon = document.createElement("i");
  icon.className = "bi bi-book-half";
  tab.appendChild(icon);

  const titleSpan = document.createElement("span");
  titleSpan.className = "ds-truncate";
  titleSpan.textContent = decodeEntities(state.lastMangaTab.title);
  tab.appendChild(titleSpan);

  const closeBtn = document.createElement("i");
  closeBtn.className = "bi bi-x";
  closeBtn.title = "Close tab";
  closeBtn.style.cssText = "cursor:pointer;font-size:13px;opacity:0.75;padding:0 2px;";
  closeBtn.addEventListener("mouseover", () => {
    closeBtn.style.opacity = "1";
  });
  closeBtn.addEventListener("mouseout", () => {
    closeBtn.style.opacity = "0.75";
  });
  closeBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    closeSessionMangaTab();
  });
  tab.appendChild(closeBtn);

  tab.addEventListener("click", () => {
    if (state.lastMangaTab) {
      state.route = { ...state.lastMangaTab.route };
      renderCurrent();
    }
  });

  container.appendChild(tab);
}

// ---------------------------------------------------------------------------
// Top-bar / banner controls
// ---------------------------------------------------------------------------

/** Sets the plugin top-bar title. */
export function setTitle(text: string): void {
  const el = document.getElementById("ds-title");
  if (el) el.textContent = text;
}

let bannerTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Shows a transient error/info banner in the top navigation bar. Pass `null` to hide.
 */
export function setBanner(message: string | null): void {
  const el = document.getElementById("ds-banner");
  if (!el) return;
  if (bannerTimer !== null) {
    clearTimeout(bannerTimer);
    bannerTimer = null;
  }
  if (!message) {
    el.style.display = "none";
    el.textContent = "";
    return;
  }
  el.textContent = message;
  el.style.display = "inline-flex";
  bannerTimer = setTimeout(() => {
    el.style.display = "none";
    el.textContent = "";
    bannerTimer = null;
  }, 4000);
}

function clearBanner(): void {
  setBanner(null);
}

/** Replaces the top-bar action buttons (follow, bookmark, cache, …). */
export function setActions(build: (host: HTMLElement) => void): void {
  const host = document.getElementById("ds-actions");
  if (!host) return;
  host.innerHTML = "";
  build(host);
}

function clearActions(): void {
  const host = document.getElementById("ds-actions");
  if (host) host.innerHTML = "";
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Site title shown in the plugin top bar. */
export function routeTitle(r: Route): string {
  switch (r.view) {
    case "browse":
      return "Browse";
    case "series":
      return r.seriesName ?? "Series";
    case "reader":
      return r.chapterTitle ?? "Reader";
    case "cache":
      return "Cache Management";
    default:
      return "Library";
  }
}

/** Formats a byte count into a clean human-readable string (e.g. "45.2 MB"). */
export { formatBytes } from "../../lib";

/** Returns true when the webview believes it has a network connection. */
export function isOnline(): boolean {
  return typeof navigator !== "undefined" ? navigator.onLine : true;
}

/** Absolute URL from a possibly-relative site path (e.g. `/system/.../01.webp`). */
export function absUrl(u: string): string {
  if (/^https?:\/\//i.test(u)) return u;
  return SITE_ROOT + u;
}

import { decodeEntities } from "./utils/html";
export { decodeEntities, esc } from "./utils/html";
export { formatDate, formatDateTime } from "./utils/formatting";

/**
 * Stable category ordering for browse tag pills: Author, Scanlator, Pairing,
 * Doujin, Series, Anthology, Issue, then everything else (General) last.
 */
const TAG_CATEGORY_ORDER = [
  "author",
  "scanlator",
  "pairing",
  "doujin",
  "series",
  "anthology",
  "issue",
  "general",
];

function tagCategoryRank(type: string): number {
  const t = (type ?? "").toLowerCase();
  const idx = TAG_CATEGORY_ORDER.indexOf(t);
  return idx === -1 ? TAG_CATEGORY_ORDER.length : idx;
}

/** Sorts tags by browse category order (author first), stable within a category. */
export function sortTagsByCategory<T extends { type: string }>(tags: T[]): T[] {
  return tags
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      const rankDiff = tagCategoryRank(a.t.type) - tagCategoryRank(b.t.type);
      if (rankDiff !== 0) return rankDiff;
      return a.i - b.i;
    })
    .map((x) => x.t);
}

/**
 * Maps a Dynasty Scans tag type or name to a styled tag-pill class or inline style. */
export function tagClass(type: string): string {
  const t = (type ?? "").toLowerCase();
  switch (t) {
    case "author":
    case "artist":
      return "tag-pill tag-artist";
    case "character":
      return "tag-pill tag-character";
    case "pairing":
      return "tag-pill tag-character";
    case "series":
    case "anthology":
    case "issue":
    case "doujin":
    case "doujinshi":
    case "copyright":
    case "parody":
      return "tag-pill tag-copyright";
    case "scanlator":
    case "group":
    case "meta":
      return "tag-pill tag-meta";
    case "status":
      return "tag-pill tag-user";
    case "general":
    default:
      return "tag-pill tag-rank-3";
  }
}

/** Generates deterministic pastel background and border for General tags */
export function tagStyle(type: string, name: string): string {
  const t = (type ?? "").toLowerCase();
  const n = (name ?? "").toLowerCase();
  if (t === "author" || t === "artist") {
    return "background-color: #fff0e6; border: 1px solid #ffd9c2; color: #7c2d12;";
  }
  if (t === "pairing") {
    return "background-color: #fce7f3; border: 1px solid #fbcfe8; color: #9d174d;";
  }
  if (t === "character") {
    return "background-color: #d1ecf1; border: 1px solid #bee5eb; color: #0c5460;";
  }
  if (
    t === "series" ||
    t === "anthology" ||
    t === "issue" ||
    t === "doujin" ||
    t === "doujinshi" ||
    t === "copyright" ||
    t === "parody"
  ) {
    return "background-color: #ebdcf9; border: 1px solid #dcbdf5; color: #511c74;";
  }
  if (t === "scanlator" || t === "group" || t === "meta") {
    return "background-color: #e2e3e5; border: 1px solid #d6d8db; color: #383d41;";
  }
  if (
    t === "status" ||
    n === "oneshot" ||
    n === "one-shot" ||
    n === "anthology" ||
    n === "completed" ||
    n === "ongoing" ||
    n === "licensed" ||
    n === "hiatus" ||
    n === "discontinued"
  ) {
    return "background-color: #e6f4ea; border: 1px solid #ceead6; color: #0e6b38;";
  }

  // General tags get one fixed color so the type reads consistently across results.
  return "background-color: #e7f0f7; border: 1px solid #cfe1ee; color: #33515f; font-weight: 500;";
}
