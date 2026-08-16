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
import { renderBrowse } from "./browse";
import { renderSeries } from "./ui-series";
import { renderReader } from "./reader/reader-controller";
import { renderCache } from "./ui-cache";

import indexCss from "./styles/index.css";
import libraryCss from "./styles/library.css";
import browseCss from "./styles/browse.css";
import cacheCss from "./styles/cache.css";
import readerCss from "./styles/reader.css";

const PLUGIN_STYLES = [indexCss, libraryCss, browseCss, cacheCss, readerCss];

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
  style.textContent = PLUGIN_STYLES.join("\n");
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