import { decodeEntities, navigate, onRouteChange, setBanner, sortTagsByCategory } from "../state";
import { esc } from "../utils/html";
import { parseDynastyUrl, searchDynasty, suggest } from "../api";
import { isItemBlacklisted, getBlacklistMode, getFullyCachedChapterPermalinks } from "../db";
import { renderTagPill } from "../components/tag-pill";
import { renderPager } from "../components/pager";
import { setupInputClearButtons } from "../components/input-field";
import { renderLoading } from "../components/loading";
import { showBlacklistWarningModal } from "../components/trigger-warning";
import { scrollBrowseToTop, updateBrowseTopPager } from "./browse-controller";
import type {
  SearchClass,
  SearchParams,
  SearchResultItem,
  SearchResultPage,
  SearchSort,
  SuggestResult,
} from "../types/api";

const ALL_CLASSES: { id: SearchClass; label: string }[] = [
  { id: "Series", label: "Series" },
  { id: "Chapter", label: "Chapter" },
  { id: "Anthology", label: "Anthology" },
  { id: "Doujin", label: "Doujin" },
  { id: "Issue", label: "Issue" },
  { id: "Author", label: "Author" },
  { id: "Scanlator", label: "Scanlator" },
  { id: "General", label: "Tag" },
  { id: "Pairing", label: "Pairing" },
];

export interface LiveSearchState {
  q: string;
  classes: Set<SearchClass>;
  withTags: string[];
  withoutTags: string[];
  sort: SearchSort;
  page: number;
  lastResults: SearchResultPage | null;
  isLoading: boolean;
}

export const searchState: LiveSearchState = {
  q: "",
  classes: new Set<SearchClass>(),
  withTags: [],
  withoutTags: [],
  sort: "",
  page: 1,
  lastResults: null,
  isLoading: false,
};

/** Resets transient search state when the user navigates away from Browse. */
export function resetSearchState(): void {
  searchState.q = "";
  searchState.classes.clear();
  searchState.withTags = [];
  searchState.withoutTags = [];
  searchState.sort = "";
  searchState.page = 1;
  searchState.lastResults = null;
  searchState.isLoading = false;
}
onRouteChange((view) => {
  if (view !== "browse") resetSearchState();
});

/**
 * Renders the in-app Search tab inside the Browse view.
 *
 * @param routeSearch Transient search directives originating from external
 *   navigation (a search-box submit, a tag-pill click, an in-app search link).
 *   Consumed once here; `renderSearchTab` never reads or mutates `state.route`.
 */
export async function renderSearchTab(
  host: HTMLElement,
  page = 1,
  onNavigateTab?: (h: HTMLElement, tabId: string, page: number) => Promise<void>,
  routeSearch?: { searchQuery?: string; withTag?: string; searchClass?: string },
): Promise<void> {
  if (routeSearch?.searchQuery !== undefined) {
    searchState.q = routeSearch.searchQuery;
  }
  if (routeSearch?.withTag && !searchState.withTags.includes(routeSearch.withTag)) {
    searchState.withTags.push(routeSearch.withTag);
  }
  if (routeSearch?.searchClass !== undefined) {
    searchState.classes.clear();
    if (routeSearch.searchClass) {
      searchState.classes.add(routeSearch.searchClass as SearchClass);
    }
  }

  searchState.page = page;

  // Search Controls Container
  const controlBox = document.createElement("div");
  controlBox.className = "group-box";
  controlBox.style.cssText = "margin-bottom:8px;padding:8px;";

  controlBox.innerHTML = `
    <div class="group-box-title"><i class="bi bi-search"></i> In-App Search &amp; Filter</div>
    <div style="display:flex;flex-direction:column;gap:8px;">
      <!-- Query Row -->
      <div class="ds-row" style="gap:6px;">
        <div class="ds-search-wrap" style="flex:1;position:relative;">
          <div class="input-wrapper">
            <input type="text" class="input-field has-clear" id="ds-tab-search-input"
              placeholder="Search keywords (e.g. Bloom Into You, Nakatani, romance)..."
              value="${esc(searchState.q)}" style="width:100%;" />
            <button type="button" class="input-clear-btn" tabindex="-1" title="Clear">
              <i class="bi bi-x-lg"></i>
            </button>
          </div>
          <div class="ds-typeahead ds-hidden" id="ds-tab-search-suggest"></div>
        </div>
        <button type="button" class="win-button" id="ds-tab-search-submit" style="font-weight:600;">
          <i class="bi bi-search"></i> Search
        </button>
        <button type="button" class="win-button" id="ds-tab-search-reset" title="Reset all search filters">
          <i class="bi bi-x-circle"></i> Clear
        </button>
      </div>

      <!-- Class Filters Row -->
      <div style="display:flex;flex-direction:column;gap:4px;">
        <div style="font-size:11px;font-weight:600;color:var(--sys-text-secondary,#555);">
          Category Filter:
        </div>
        <div id="ds-search-classes-row" style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;"></div>
      </div>

      <!-- Advanced Tag & Sort Row -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));gap:8px;align-items:start;">
        <!-- With Tags -->
        <div style="display:flex;flex-direction:column;gap:4px;">
          <div style="font-size:11px;font-weight:600;color:var(--sys-text-secondary,#555);">
            <i class="bi bi-plus-circle"></i> With Tags:
          </div>
          <div style="position:relative;">
            <input type="text" class="input-field" id="ds-search-with-input"
              placeholder="Add included tag..." style="width:100%;box-sizing:border-box;font-size:11px;" />
            <div class="ds-typeahead ds-hidden" id="ds-search-with-suggest"></div>
          </div>
          <div id="ds-search-with-chips" style="display:flex;flex-wrap:wrap;gap:3px;min-height:18px;"></div>
        </div>

        <!-- Without Tags -->
        <div style="display:flex;flex-direction:column;gap:4px;">
          <div style="font-size:11px;font-weight:600;color:var(--sys-text-secondary,#555);">
            <i class="bi bi-dash-circle"></i> Without Tags (Exclude):
          </div>
          <div style="position:relative;">
            <input type="text" class="input-field" id="ds-search-without-input"
              placeholder="Add excluded tag..." style="width:100%;box-sizing:border-box;font-size:11px;" />
            <div class="ds-typeahead ds-hidden" id="ds-search-without-suggest"></div>
          </div>
          <div id="ds-search-without-chips" style="display:flex;flex-wrap:wrap;gap:3px;min-height:18px;"></div>
        </div>

        <!-- Sort -->
        <div style="display:flex;flex-direction:column;gap:4px;">
          <div style="font-size:11px;font-weight:600;color:var(--sys-text-secondary,#555);">
            <i class="bi bi-sort-down"></i> Sort Order:
          </div>
          <select class="input-field" id="ds-search-sort" style="font-size:11px;padding:3px 6px;">
            <option value="" ${searchState.sort === "" ? "selected" : ""}>Best Match</option>
            <option value="name" ${searchState.sort === "name" ? "selected" : ""}>Alphabetical</option>
            <option value="created_at" ${searchState.sort === "created_at" ? "selected" : ""}>Date Added</option>
            <option value="released_on" ${searchState.sort === "released_on" ? "selected" : ""}>Release Date</option>
          </select>
        </div>
      </div>
    </div>
  `;

  const frag = document.createDocumentFragment();
  frag.appendChild(controlBox);
  setupInputClearButtons(controlBox);

  // Results area container
  const resultsContainer = document.createElement("div");
  resultsContainer.id = "ds-search-results-area";
  resultsContainer.style.cssText = "display:flex;flex-direction:column;gap:6px;";
  frag.appendChild(resultsContainer);
  host.replaceChildren(frag);

  // Wire Classes Row
  const classesRow = controlBox.querySelector<HTMLElement>("#ds-search-classes-row")!;
  const renderClassButtons = () => {
    classesRow.innerHTML = "";
    const allActive = searchState.classes.size === 0;

    const allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.className = `win-button ds-btn-sm${allActive ? " active" : ""}`;
    allBtn.style.cssText = "font-size:10px;padding:1px 6px;";
    allBtn.textContent = "All Categories";
    allBtn.addEventListener("click", () => {
      searchState.classes.clear();
      renderClassButtons();
      void executeSearch(resultsContainer, 1, onNavigateTab);
    });
    classesRow.appendChild(allBtn);

    for (const c of ALL_CLASSES) {
      const active = searchState.classes.has(c.id);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `win-button ds-btn-sm${active ? " active" : ""}`;
      btn.style.cssText = "font-size:10px;padding:1px 6px;";
      btn.textContent = c.label;
      btn.addEventListener("click", () => {
        if (searchState.classes.has(c.id)) {
          searchState.classes.delete(c.id);
        } else {
          searchState.classes.add(c.id);
        }
        renderClassButtons();
        void executeSearch(resultsContainer, 1, onNavigateTab);
      });
      classesRow.appendChild(btn);
    }
  };
  renderClassButtons();

  // Wire Tag Chip Rows
  const withChipsEl = controlBox.querySelector<HTMLElement>("#ds-search-with-chips")!;
  const withoutChipsEl = controlBox.querySelector<HTMLElement>("#ds-search-without-chips")!;

  const renderTagChips = () => {
    withChipsEl.innerHTML = "";
    for (const t of searchState.withTags) {
      const chip = document.createElement("span");
      chip.className = "ds-row";
      chip.style.cssText =
        "background:var(--sys-bg-active,#e8f0fe);color:var(--sys-primary,#0078d4);border:1px solid var(--sys-primary,#0078d4);border-radius:3px;padding:1px 5px;font-size:10px;align-items:center;gap:4px;";
      chip.innerHTML = `<span>+ ${decodeEntities(t)}</span><i class="bi bi-x" style="cursor:pointer;font-size:12px;"></i>`;
      chip.querySelector(".bi-x")?.addEventListener("click", () => {
        searchState.withTags = searchState.withTags.filter((x) => x !== t);
        renderTagChips();
        void executeSearch(resultsContainer, 1, onNavigateTab);
      });
      withChipsEl.appendChild(chip);
    }

    withoutChipsEl.innerHTML = "";
    for (const t of searchState.withoutTags) {
      const chip = document.createElement("span");
      chip.className = "ds-row";
      chip.style.cssText =
        "background:#fde7e9;color:#a80000;border:1px solid #e81123;border-radius:3px;padding:1px 5px;font-size:10px;align-items:center;gap:4px;";
      chip.innerHTML = `<span>- ${decodeEntities(t)}</span><i class="bi bi-x" style="cursor:pointer;font-size:12px;"></i>`;
      chip.querySelector(".bi-x")?.addEventListener("click", () => {
        searchState.withoutTags = searchState.withoutTags.filter((x) => x !== t);
        renderTagChips();
        void executeSearch(resultsContainer, 1, onNavigateTab);
      });
      withoutChipsEl.appendChild(chip);
    }
  };
  renderTagChips();

  // Wire Tag Autocomplete for With/Without
  const setupTagAutocomplete = (
    inputEl: HTMLInputElement | null,
    suggestEl: HTMLElement | null,
    onAdd: (tag: string) => void,
  ) => {
    if (!inputEl || !suggestEl) return;
    let timer: number | undefined;

    inputEl.addEventListener("input", () => {
      window.clearTimeout(timer);
      const val = inputEl.value.trim();
      if (!val) {
        suggestEl.classList.add("ds-hidden");
        return;
      }
      timer = window.setTimeout(async () => {
        try {
          const suggestions = await suggest(val);
          suggestEl.innerHTML = "";
          if (suggestions.length === 0) {
            suggestEl.classList.add("ds-hidden");
            return;
          }
          for (const s of suggestions.slice(0, 6)) {
            const item = document.createElement("div");
            item.className = "ds-typeahead-item";
            item.innerHTML = `<span style="flex:1;">${decodeEntities(s.name)}</span><span class="ds-typeahead-type">${s.type}</span>`;
            item.addEventListener("mousedown", () => {
              onAdd(s.name);
              inputEl.value = "";
              suggestEl.classList.add("ds-hidden");
            });
            suggestEl.appendChild(item);
          }
          suggestEl.classList.remove("ds-hidden");
        } catch {
          suggestEl.classList.add("ds-hidden");
        }
      }, 200);
    });

    inputEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        const val = inputEl.value.trim();
        if (val) {
          onAdd(val);
          inputEl.value = "";
          suggestEl.classList.add("ds-hidden");
        }
      }
    });

    inputEl.addEventListener("blur", () => {
      window.setTimeout(() => {
        suggestEl.classList.add("ds-hidden");
      }, 150);
    });
  };

  setupTagAutocomplete(
    controlBox.querySelector<HTMLInputElement>("#ds-search-with-input"),
    controlBox.querySelector<HTMLElement>("#ds-search-with-suggest"),
    (tag) => {
      if (!searchState.withTags.includes(tag)) {
        searchState.withTags.push(tag);
        renderTagChips();
        void executeSearch(resultsContainer, 1, onNavigateTab);
      }
    },
  );

  setupTagAutocomplete(
    controlBox.querySelector<HTMLInputElement>("#ds-search-without-input"),
    controlBox.querySelector<HTMLElement>("#ds-search-without-suggest"),
    (tag) => {
      if (!searchState.withoutTags.includes(tag)) {
        searchState.withoutTags.push(tag);
        renderTagChips();
        void executeSearch(resultsContainer, 1, onNavigateTab);
      }
    },
  );

  // Wire Sort Selector
  const sortSelect = controlBox.querySelector<HTMLSelectElement>("#ds-search-sort");
  sortSelect?.addEventListener("change", () => {
    searchState.sort = (sortSelect.value ?? "") as SearchSort;
    void executeSearch(resultsContainer, 1, onNavigateTab);
  });

  // Wire Main Query Input
  const queryInput = controlBox.querySelector<HTMLInputElement>("#ds-tab-search-input");
  const submitBtn = controlBox.querySelector<HTMLButtonElement>("#ds-tab-search-submit");
  const resetBtn = controlBox.querySelector<HTMLButtonElement>("#ds-tab-search-reset");
  const suggestEl = controlBox.querySelector<HTMLElement>("#ds-tab-search-suggest");

  const runTabSearch = () => {
    searchState.q = queryInput?.value.trim() ?? "";
    void executeSearch(resultsContainer, 1, onNavigateTab);
  };

  submitBtn?.addEventListener("click", runTabSearch);
  queryInput?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") runTabSearch();
  });

  resetBtn?.addEventListener("click", () => {
    searchState.q = "";
    searchState.classes.clear();
    searchState.withTags = [];
    searchState.withoutTags = [];
    searchState.sort = "";
    if (queryInput) queryInput.value = "";
    renderClassButtons();
    renderTagChips();
    if (sortSelect) sortSelect.value = "";
    void executeSearch(resultsContainer, 1, onNavigateTab);
  });

  // Typeahead for main query input
  if (queryInput && suggestEl) {
    let debounceTimer: number | undefined;
    queryInput.addEventListener("input", () => {
      window.clearTimeout(debounceTimer);
      const q = queryInput.value.trim();
      if (!q) {
        suggestEl.classList.add("ds-hidden");
        return;
      }
      debounceTimer = window.setTimeout(async () => {
        try {
          const suggestions = await suggest(q);
          suggestEl.innerHTML = "";
          if (suggestions.length === 0) {
            suggestEl.classList.add("ds-hidden");
            return;
          }
          for (const s of suggestions.slice(0, 8)) {
            const item = document.createElement("div");
            item.className = "ds-typeahead-item";
            item.innerHTML = `<span style="flex:1;">${decodeEntities(s.name)}</span><span class="ds-typeahead-type">${s.type}</span>`;
            item.addEventListener("mousedown", () => {
              searchState.q = s.name;
              queryInput.value = s.name;
              suggestEl.classList.add("ds-hidden");
              void executeSearch(resultsContainer, 1, onNavigateTab);
            });
            suggestEl.appendChild(item);
          }
          suggestEl.classList.remove("ds-hidden");
        } catch {
          suggestEl.classList.add("ds-hidden");
        }
      }, 250);
    });

    queryInput.addEventListener("blur", () => {
      window.setTimeout(() => {
        suggestEl.classList.add("ds-hidden");
      }, 150);
    });
  }

  // Initial load
  void executeSearch(resultsContainer, searchState.page, onNavigateTab);
}

/**
 * Performs the search query and renders the results inside the container.
 */
async function executeSearch(
  container: HTMLElement,
  page: number,
  onNavigateTab?: (h: HTMLElement, tabId: string, page: number) => Promise<void>,
): Promise<void> {
  scrollBrowseToTop();
  searchState.page = page;
  searchState.isLoading = true;
  container.innerHTML = "";
  container.appendChild(renderLoading());

  const params: SearchParams = {
    q: searchState.q,
    classes: searchState.classes.size > 0 ? Array.from(searchState.classes) : undefined,
    withTags: searchState.withTags.length > 0 ? searchState.withTags : undefined,
    withoutTags: searchState.withoutTags.length > 0 ? searchState.withoutTags : undefined,
    sort: searchState.sort || undefined,
    page: searchState.page,
  };

  let pageData: SearchResultPage;
  try {
    pageData = await searchDynasty(params);
    searchState.lastResults = pageData;
  } catch (err) {
    container.innerHTML = "";
    const msg = err instanceof Error ? err.message : String(err);
    setBanner(`Search failed: ${msg}`);

    const errBox = document.createElement("div");
    errBox.className = "ds-row";
    errBox.style.cssText = "padding:12px;gap:8px;align-items:center;";
    errBox.innerHTML = `<span class="ds-muted">Search request failed: ${esc(msg)}</span>`;

    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "win-button";
    retry.innerHTML = '<i class="bi bi-arrow-clockwise"></i> Retry';
    retry.addEventListener("click", () => void executeSearch(container, page, onNavigateTab));
    errBox.appendChild(retry);
    container.appendChild(errBox);
    return;
  } finally {
    searchState.isLoading = false;
  }

  container.innerHTML = "";
  await renderSearchResultsList(container, pageData, onNavigateTab);
}

/**
 * Renders the parsed search results list and pagination controls.
 */
async function renderSearchResultsList(
  container: HTMLElement,
  data: SearchResultPage,
  onNavigateTab?: (h: HTMLElement, tabId: string, page: number) => Promise<void>,
): Promise<void> {
  // Results summary header
  const header = document.createElement("div");
  header.className = "ds-row";
  header.style.cssText =
    "justify-content:space-between;align-items:center;padding:4px 2px;border-bottom:1px solid var(--sys-border-light,#ddd);margin-bottom:6px;";

  const countInfo = document.createElement("div");
  countInfo.style.cssText = "font-size:12px;font-weight:600;";
  const queryLabel = data.query ? ` for "${esc(data.query)}"` : "";
  countInfo.innerHTML = `<i class="bi bi-list-stars"></i> Search Results${queryLabel} <span class="ds-muted" style="font-weight:normal;font-size:11px;">(${data.items.length} items on page ${data.currentPage} of ${data.totalPages})</span>`;

  header.appendChild(countInfo);
  container.appendChild(header);

  if (data.items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "ds-muted";
    empty.style.cssText = "padding:24px;text-align:center;";
    empty.innerHTML = `
      <div style="font-size:14px;margin-bottom:4px;"><i class="bi bi-search"></i> No matching results found</div>
      <div style="font-size:11px;">Try adjusting keywords, clearing category filters, or removing excluded tags.</div>
    `;
    container.appendChild(empty);
    return;
  }

  let fullyCachedSet = new Set<string>();
  try {
    fullyCachedSet = await getFullyCachedChapterPermalinks();
  } catch {}

  const blMode = getBlacklistMode();
  const normalItems: SearchResultItem[] = [];
  const blacklistedItems: { item: SearchResultItem; matchedTags: string[] }[] = [];

  for (const item of data.items) {
    const check = isItemBlacklisted(item.tags);
    if (check.blacklisted) {
      blacklistedItems.push({ item, matchedTags: check.matchedTags });
    } else {
      normalItems.push(item);
    }
  }

  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-direction:column;gap:6px;";

  if (blMode === "hide") {
    if (blacklistedItems.length > 0) {
      const notice = document.createElement("div");
      notice.className = "ds-row ds-blacklist-notice";
      notice.style.cssText =
        "background:#fdf3f4;border:1px solid #f5c2c7;color:#842029;border-radius:3px;padding:4px 10px;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:11px;";

      let showBlacklisted = false;
      const blList = document.createElement("div");
      blList.className = "ds-hidden";
      blList.style.cssText = "display:flex;flex-direction:column;gap:6px;margin-bottom:8px;";

      for (const { item, matchedTags } of blacklistedItems) {
        blList.appendChild(
          renderSearchResultRow(item, true, matchedTags, fullyCachedSet.has(item.permalink)),
        );
      }

      notice.innerHTML = `
        <div class="ds-flex-row">
          <i class="bi bi-shield-slash-fill" style="color:#dc3545;"></i>
          <span><b>${blacklistedItems.length}</b> result${blacklistedItems.length === 1 ? "" : "s"} hidden by tag blacklist.</span>
        </div>
        <button type="button" class="win-button ds-btn-sm" style="font-size:10px;padding:2px 8px;">
          <i class="bi bi-eye"></i> Show Blacklisted (${blacklistedItems.length})
        </button>
      `;

      const toggleBtn = notice.querySelector<HTMLButtonElement>("button")!;
      toggleBtn.addEventListener("click", () => {
        showBlacklisted = !showBlacklisted;
        blList.classList.toggle("ds-hidden", !showBlacklisted);
        toggleBtn.innerHTML = showBlacklisted
          ? '<i class="bi bi-eye-slash"></i> Hide Blacklisted'
          : `<i class="bi bi-eye"></i> Show Blacklisted (${blacklistedItems.length})`;
      });

      container.appendChild(notice);
      container.appendChild(blList);
    }

    if (normalItems.length === 0 && blacklistedItems.length > 0) {
      const allFiltered = document.createElement("div");
      allFiltered.className = "ds-muted";
      allFiltered.style.cssText = "padding:12px 0;text-align:center;font-size:11px;";
      allFiltered.textContent = "All results on this page were hidden by your tag blacklist.";
      container.appendChild(allFiltered);
    }

    for (const item of normalItems) {
      list.appendChild(
        renderSearchResultRow(item, false, [], fullyCachedSet.has(item.permalink)),
      );
    }
  } else {
    // "warn" mode: Render all items in the main list with warning tags
    for (const item of data.items) {
      const check = isItemBlacklisted(item.tags);
      list.appendChild(
        renderSearchResultRow(
          item,
          check.blacklisted,
          check.matchedTags,
          fullyCachedSet.has(item.permalink),
        ),
      );
    }
  }

  container.appendChild(list);

  updateBrowseTopPager(
    data.totalPages,
    data.currentPage,
    (p) => void executeSearch(container, p, onNavigateTab),
    "search",
  );

  if (data.totalPages > 1) {
    container.appendChild(
      renderPager(
        data.totalPages,
        data.currentPage,
        (p) => void executeSearch(container, p, onNavigateTab),
        { cssText: "margin-top:12px;justify-content:flex-end;" },
      ),
    );
  }
}

/**
 * Renders a single search result card.
 */
function renderSearchResultRow(
  item: SearchResultItem,
  isBlacklisted = false,
  matchedTags: string[] = [],
  isFullyCached = false,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "ds-row";
  row.style.cssText = `background:var(--sys-bg-active,#fff);border:1px solid var(--sys-border-light,#ddd);border-radius:3px;padding:6px 10px;align-items:flex-start;gap:8px;transition:background 0.1s ease;${isBlacklisted ? "opacity:0.8;background:var(--sys-bg-active,#fcf8f8);" : ""}`;

  // Icon based on kind
  const icon = document.createElement("div");
  icon.style.cssText = "font-size:16px;margin-top:2px;min-width:20px;text-align:center;";
  icon.innerHTML = getKindIcon(item.kind);
  row.appendChild(icon);

  // Content body
  const body = document.createElement("div");
  body.className = "ds-fill";
  body.style.cssText = "display:flex;flex-direction:column;gap:3px;";

  // Title Row
  const titleRow = document.createElement("div");
  titleRow.className = "ds-flex-row";
  titleRow.style.cssText = "flex-wrap:wrap;";

  const titleLink = document.createElement("a");
  titleLink.className = "ds-search-title-link";
  titleLink.style.cssText =
    "font-size:12px;font-weight:600;color:var(--sys-text-primary,#000);text-decoration:none;cursor:pointer;display:inline-flex;align-items:center;gap:4px;";
  titleLink.innerHTML = `<span>${esc(item.title)}</span>${
    isFullyCached
      ? '<i class="bi bi-cloud-check-fill ds-offline-icon" style="color:var(--sys-primary,#0078d4);font-size:11px;" title="Available Offline (Fully Cached)"></i>'
      : ""
  }`;
  titleLink.title = `Open ${item.title}`;

  const kindBadge = document.createElement("span");
  kindBadge.className = "ds-muted";
  kindBadge.style.cssText =
    "font-size:10px;background:var(--sys-bg-hover,#eaeaea);padding:1px 5px;border-radius:2px;text-transform:capitalize;";
  kindBadge.textContent = item.kind;

  titleRow.appendChild(titleLink);
  titleRow.appendChild(kindBadge);

  if (isBlacklisted && matchedTags.length > 0) {
    const blBadge = document.createElement("span");
    blBadge.style.cssText =
      "font-size:9px;background:#fde7e9;color:#a80000;padding:1px 5px;border-radius:2px;border:1px solid #e81123;display:inline-flex;align-items:center;gap:3px;font-weight:600;";
    const labelPrefix = getBlacklistMode() === "warn" ? "Content Warning" : "Blacklisted";
    blBadge.innerHTML = `<i class="bi bi-exclamation-triangle-fill"></i> ${labelPrefix}: ${decodeEntities(matchedTags.join(", "))}`;
    titleRow.appendChild(blBadge);
  }
  body.appendChild(titleRow);

  // Subtitle (Author, Doujin, Released date)
  const subParts: HTMLElement[] = [];

  if (item.author) {
    const authorSpan = document.createElement("span");
    authorSpan.className = "ds-muted";
    authorSpan.style.cssText = "font-size:11px;";
    authorSpan.innerHTML = `by <a style="color:var(--sys-primary,#0078d4);cursor:pointer;text-decoration:underline;">${decodeEntities(item.author.name)}</a>`;
    const authorLink = authorSpan.querySelector("a");
    authorLink?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      navigate({
        view: "series",
        seriesPermalink: item.author!.permalink,
        seriesName: item.author!.name,
      });
    });
    subParts.push(authorSpan);
  }

  if (item.doujin) {
    const doujinSpan = document.createElement("span");
    doujinSpan.className = "ds-muted";
    doujinSpan.style.cssText = "font-size:11px;";
    doujinSpan.innerHTML = `<a style="color:var(--sys-primary,#0078d4);cursor:pointer;text-decoration:underline;">${decodeEntities(item.doujin.name)}</a>`;
    const doujinLink = doujinSpan.querySelector("a");
    doujinLink?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      navigate({
        view: "series",
        seriesPermalink: item.doujin!.permalink,
        seriesName: item.doujin!.name,
      });
    });
    subParts.push(doujinSpan);
  }

  if (item.releasedOn) {
    const dateSpan = document.createElement("span");
    dateSpan.className = "ds-muted";
    dateSpan.style.cssText = "font-size:11px;";
    dateSpan.textContent = `released ${item.releasedOn}`;
    subParts.push(dateSpan);
  }

  if (subParts.length > 0) {
    const subRow = document.createElement("div");
    subRow.className = "ds-row";
    subRow.style.cssText = "gap:8px;align-items:center;flex-wrap:wrap;";
    for (const p of subParts) subRow.appendChild(p);
    body.appendChild(subRow);
  }

  // Tags row
  if (item.tags.length > 0) {
    const tagsWrap = document.createElement("div");
    tagsWrap.style.cssText = "display:flex;flex-wrap:wrap;gap:3px;margin-top:2px;";
    for (const t of sortTagsByCategory(item.tags)) {
      tagsWrap.appendChild(renderTagPill(t, true));
    }
    body.appendChild(tagsWrap);
  }

  row.appendChild(body);

  // Quick Action Button
  const actionBtn = document.createElement("button");
  actionBtn.type = "button";
  actionBtn.className = "win-button ds-btn-sm";
  actionBtn.style.cssText = "align-self:center;white-space:nowrap;";

  const onOpenItem = () => {
    const doNavigate = () => {
      if (item.kind === "chapter") {
        navigate({
          view: "reader",
          chapterPermalink: item.permalink,
          chapterTitle: item.title,
        });
      } else {
        navigate({
          view: "series",
          seriesPermalink: item.permalink,
          seriesName: item.title,
        });
      }
    };
    if (isBlacklisted && matchedTags.length > 0) {
      showBlacklistWarningModal(item.title, matchedTags, doNavigate);
    } else {
      doNavigate();
    }
  };

  if (item.kind === "chapter") {
    actionBtn.innerHTML = '<i class="bi bi-book"></i> Read';
  } else if (item.kind === "series" || item.kind === "anthology" || item.kind === "doujin" || item.kind === "issue") {
    actionBtn.innerHTML = '<i class="bi bi-folder2-open"></i> Open';
  } else {
    actionBtn.innerHTML = '<i class="bi bi-arrow-right-circle"></i> View';
  }

  actionBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onOpenItem();
  });
  titleLink.addEventListener("click", (ev) => {
    ev.preventDefault();
    onOpenItem();
  });

  row.appendChild(actionBtn);

  return row;
}

/**
 * Helper to get icon HTML per result kind.
 */
function getKindIcon(kind: SearchResultItem["kind"]): string {
  switch (kind) {
    case "chapter":
      return '<i class="bi bi-file-earmark-text" style="color:var(--sys-primary,#0078d4);"></i>';
    case "series":
      return '<i class="bi bi-collection-play" style="color:#d83b01;"></i>';
    case "anthology":
      return '<i class="bi bi-journal-album" style="color:#107c41;"></i>';
    case "doujin":
      return '<i class="bi bi-book" style="color:#8764b8;"></i>';
    case "issue":
      return '<i class="bi bi-newspaper" style="color:#b146c2;"></i>';
    case "author":
      return '<i class="bi bi-person" style="color:#008272;"></i>';
    case "scanlator":
      return '<i class="bi bi-people" style="color:#5c2d91;"></i>';
    case "pairing":
      return '<i class="bi bi-heart" style="color:#e3008c;"></i>';
    case "tag":
    default:
      return '<i class="bi bi-tag" style="color:#69797e;"></i>';
  }
}


/**
 * Search typeahead + Open-by-URL panel in top Search & Go box.
 */
export async function loadSuggestions(
  q: string,
  host: HTMLElement,
  onSelect?: (result: SuggestResult) => void,
): Promise<void> {
  let results: SuggestResult[];
  try {
    results = await suggest(q);
  } catch (err) {
    host.classList.add("ds-hidden");
    const msg = err instanceof Error ? err.message : String(err);
    setBanner(`Search suggestions failed: ${msg}`);
    return;
  }
  host.innerHTML = "";
  if (results.length === 0) {
    host.classList.add("ds-hidden");
    return;
  }
  for (const r of results.slice(0, 8)) {
    const item = document.createElement("div");
    item.className = "ds-typeahead-item";
    const name = document.createElement("span");
    name.className = "ds-fill ds-truncate";
    name.textContent = decodeEntities(r.name);
    const type = document.createElement("span");
    type.className = "ds-typeahead-type";
    type.textContent = r.type;
    item.appendChild(name);
    item.appendChild(type);
    item.addEventListener("mousedown", () => {
      if (onSelect) {
        onSelect(r);
      } else {
        navigate({
          view: "browse",
          browseTab: "search",
          searchQuery: r.name,
        });
      }
    });
    host.appendChild(item);
  }
  host.classList.remove("ds-hidden");
}

/** Wires the search input, typeahead, and open-by-URL box inside the top search panel. */
export function wireSearchPanel(
  panel: HTMLElement,
  onSearch?: (query: string) => void,
): void {
  const input = panel.querySelector<HTMLInputElement>("#ds-search-input");
  const suggestEl = panel.querySelector<HTMLElement>("#ds-search-suggest");
  const searchBtn = panel.querySelector<HTMLButtonElement>("#ds-search-btn");
  let debounceTimer: number | undefined;

  const runSearch = (): void => {
    const q = (input?.value ?? "").trim();
    if (!q) return;
    if (onSearch) {
      onSearch(q);
    } else {
      navigate({
        view: "browse",
        browseTab: "search",
        searchQuery: q,
      });
    }
  };

  searchBtn?.addEventListener("click", runSearch);
  input?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") runSearch();
  });
  input?.addEventListener("input", () => {
    window.clearTimeout(debounceTimer);
    const q = (input.value ?? "").trim();
    if (!suggestEl) return;
    if (!q) {
      suggestEl.classList.add("ds-hidden");
      return;
    }
    debounceTimer = window.setTimeout(() => {
      void loadSuggestions(q, suggestEl);
    }, 250);
  });
  input?.addEventListener("blur", () => {
    window.setTimeout(() => {
      if (suggestEl) suggestEl.classList.add("ds-hidden");
    }, 150);
  });

  const urlInput = panel.querySelector<HTMLInputElement>("#ds-url-input");
  const urlBtn = panel.querySelector<HTMLButtonElement>("#ds-url-btn");
  const pasteBtn = panel.querySelector<HTMLButtonElement>("#ds-url-paste-btn");

  pasteBtn?.addEventListener("click", async () => {
    try {
      const text = (await navigator.clipboard.readText()) || "";
      if (text && urlInput) {
        urlInput.value = text.trim();
        urlInput.dispatchEvent(new Event("input", { bubbles: true }));
        urlInput.focus();
      }
    } catch (err) {
      console.warn("[ds-browse] clipboard read failed:", err);
    }
  });

  const openByUrl = (): void => {
    const raw = (urlInput?.value ?? "").trim();
    if (!raw) {
      setBanner("Paste a dynasty-scans.com series or chapter URL first.");
      return;
    }
    const parsed = parseDynastyUrl(raw);
    if (!parsed) {
      setBanner(
        "Unrecognized URL. Use https://dynasty-scans.com/series/<permalink> or /chapters/<permalink>.",
      );
      return;
    }
    if (parsed.kind === "chapter") {
      navigate({
        view: "reader",
        chapterPermalink: parsed.permalink,
        chapterTitle: parsed.permalink,
      });
    } else {
      navigate({ view: "series", seriesPermalink: parsed.permalink, seriesName: parsed.permalink });
    }
  };
  urlBtn?.addEventListener("click", openByUrl);
  urlInput?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") openByUrl();
  });
}
