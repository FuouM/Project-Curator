import { navigate } from "../state";
import type { Route } from "../state";
import { browseCovers } from "./browse-covers";
import { renderFeed, FEED_TAB_TO_URL, FEED_TAB_TO_KEY } from "./browse-feed";
import { renderDirectory } from "./browse-directory";
import { wireSearchPanel } from "./browse-search";

interface BrowseTab {
  id: string;
  label: string;
}

const TABS: BrowseTab[] = [
  { id: "releases", label: "Recent Releases" },
  { id: "added", label: "Recently Added" },
  { id: "series-dir", label: "Series Directory" },
  { id: "tags-dir", label: "Tags" },
];

export async function renderTabContent(host: HTMLElement, tabId: string, page: number): Promise<void> {
  host.innerHTML = "";
  const loading = document.createElement("div");
  loading.className = "ds-muted";
  loading.textContent = "Loading…";
  host.appendChild(loading);

  try {
    if (tabId === "releases" || tabId === "added") {
      await renderFeed(host, tabId, page, renderTabContent);
    } else if (tabId === "series-dir") {
      await renderDirectory(host, "series", page, renderTabContent);
    } else {
      await renderDirectory(host, "tags", page, renderTabContent);
    }
  } catch (err) {
    host.innerHTML = "";
    const msg = err instanceof Error ? err.message : String(err);
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "win-button";
    retry.innerHTML = '<i class="bi bi-arrow-clockwise"></i> Retry';
    retry.addEventListener("click", () => void renderTabContent(host, tabId, page));
    host.appendChild(retry);
  }
}

export function renderBrowse(container: HTMLElement, route: Route): void {
  container.innerHTML = "";

  // ── Search + Open-by-URL ────────────────────────────────────────────────
  const searchBox = document.createElement("div");
  searchBox.className = "group-box";
  searchBox.style.cssText = "margin-bottom:8px;";
  searchBox.innerHTML =
    '<div class="group-box-title"><i class="bi bi-search"></i> Search &amp; Go</div>' +
    '<div style="display:flex;flex-direction:column;gap:6px;">' +
    '  <div class="ds-row">' +
    '    <div class="ds-search-wrap" style="flex:1;">' +
    '      <input type="text" class="input-field" id="ds-search-input"' +
    '        placeholder="Search dynasty-scans (opens in your browser)..." style="width:100%;" />' +
    '      <div class="ds-typeahead" id="ds-search-suggest" style="display:none;"></div>' +
    "    </div>" +
    '    <button type="button" class="win-button" id="ds-search-btn">' +
    '      <i class="bi bi-box-arrow-up-right"></i> Search' +
    "    </button>" +
    "  </div>" +
    '  <div class="ds-row">' +
    '    <input type="text" class="input-field" id="ds-url-input" style="flex:1;"' +
    '      placeholder="Paste a dynasty-scans.com series or chapter URL..." />' +
    '    <button type="button" class="win-button" id="ds-url-btn">' +
    '      <i class="bi bi-link-45deg"></i> Open Locally' +
    "    </button>" +
    "  </div>" +
    '  <div class="ds-muted" style="margin-top:2px;">' +
    "    Accepted: https://dynasty-scans.com/series/&lt;permalink&gt; or /chapters/&lt;permalink&gt; (or the .json form)." +
    "  </div>" +
    "</div>";
  container.appendChild(searchBox);
  wireSearchPanel(searchBox);

  // ── Sub-tabs ────────────────────────────────────────────────────────────
  const tabsRow = document.createElement("div");
  tabsRow.className = "ds-subtabs";
  container.appendChild(tabsRow);

  const content = document.createElement("div");
  content.id = "ds-browse-content";
  content.style.cssText = "margin-top:8px;";
  container.appendChild(content);

  const currentTab = route.browseTab ?? "releases";
  for (const tab of TABS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `win-button ds-subtab${tab.id === currentTab ? " active" : ""}`;
    btn.dataset.tabId = tab.id;
    btn.textContent = tab.label;
    btn.addEventListener("click", () => {
      route.browseTab = tab.id;
      for (const b of tabsRow.children) b.classList.remove("active");
      btn.classList.add("active");
      void renderTabContent(content, tab.id, 1);
    });
    tabsRow.appendChild(btn);
  }

  // ── Cover toggle (diagnostic) ───────────────────────────────────────────
  const coverToggleBtn = document.createElement("button");
  coverToggleBtn.type = "button";
  coverToggleBtn.id = "ds-cover-toggle";
  coverToggleBtn.className = "win-button ds-cover-toggle-btn";
  coverToggleBtn.title = "Toggle cover image loading (diagnostic)";
  const updateCoverToggleLabel = (): void => {
    coverToggleBtn.innerHTML = browseCovers.coversEnabled
      ? '<i class="bi bi-image"></i> Covers: ON'
      : '<i class="bi bi-image-slash"></i> Covers: OFF';
    coverToggleBtn.style.opacity = browseCovers.coversEnabled ? "1" : "0.5";
  };
  updateCoverToggleLabel();
  coverToggleBtn.addEventListener("click", () => {
    browseCovers.setCoversEnabled(!browseCovers.coversEnabled);
    updateCoverToggleLabel();
    // Re-render the current tab so feedItem picks up the new flag.
    const activeTab = tabsRow.querySelector<HTMLButtonElement>(".ds-subtab.active");
    const activeTabId = activeTab?.dataset.tabId ?? currentTab;
    void renderTabContent(content, activeTabId, 1);
  });
  tabsRow.appendChild(coverToggleBtn);

  void renderTabContent(content, currentTab, 1);
}

// Re-export constants for tooling/tests
export { FEED_TAB_TO_URL, FEED_TAB_TO_KEY };