import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { typedCall } from "../ipc";
import { maskPath, SafeHtml, html } from "../components";
import { renderSearchResults } from "../cards";
import { setupInputClearButtons, escapeHtml } from "../utils";
import { setupSelectionToolbar } from "../selection-toolbar";
import { attachAutocomplete } from "../autocomplete";
import { showErrorAlert } from "../alert";
import { searchMatchFromProto } from "../proto-adapters";
import { SearchRequestSchema, SearchResultSchema } from "../gen/search_pb";
import { TagStatisticsResultSchema } from "../gen/common_pb";

export function findSimilar(imagePath: string) {
  const navItem = document.querySelector(`.nav-item[data-view="search"]`) as HTMLElement | null;
  if (navItem) navItem.click();

  setTimeout(() => {
    const imageInput = document.getElementById("search-image-path-input") as HTMLInputElement;
    if (imageInput) {
      imageInput.value = imagePath;
      imageInput.dispatchEvent(new Event("change"));
    }
    document
      .getElementById("search-form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }, 100);
}

export function switchToSearchWithTag(tagName: string) {
  const navItem = document.querySelector(`.nav-item[data-view="search"]`) as HTMLElement | null;
  if (navItem) navItem.click();

  setTimeout(() => {
    const tagInput = document.getElementById("search-tag-input") as HTMLInputElement;
    if (tagInput) {
      tagInput.value = tagName;
      tagInput.dispatchEvent(new Event("change"));
    }
    document
      .getElementById("search-form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }, 100);
}

export function setupSearch() {
  setupInputClearButtons();
  setupTagAutocomplete();

  // Parse search help modal toggle
  document.getElementById("search-parse-help-btn")?.addEventListener("click", () => {
    const modal = document.getElementById("search-parse-help-modal");
    if (modal) modal.style.display = modal.style.display === "none" ? "block" : "none";
  });
  document.getElementById("search-parse-help-close")?.addEventListener("click", () => {
    const modal = document.getElementById("search-parse-help-modal");
    if (modal) modal.style.display = "none";
  });

  const searchForm = document.getElementById("search-form");
  const queryInput = document.getElementById("search-text-input") as HTMLInputElement;
  const tagInput = document.getElementById("search-tag-input") as HTMLInputElement;
  const imageInput = document.getElementById("search-image-path-input") as HTMLInputElement;
  const parseInput = document.getElementById("search-parse-input") as HTMLInputElement;

  function updateImagePreview() {
    const container = document.getElementById("search-image-preview-container");
    const img = document.getElementById("search-image-preview-img") as HTMLImageElement;
    const video = document.getElementById("search-image-preview-video") as HTMLVideoElement;
    const filenameSpan = document.getElementById("search-image-preview-filename");
    if (!imageInput || !container || !img || !video || !filenameSpan) return;

    const path = imageInput.value.trim();
    const isVideo = /\.(mp4|webm)$/i.test(path);
    if (path) {
      if (isVideo) {
        img.src = "";
        img.style.display = "none";
        video.src = convertFileSrc(path);
        video.style.display = "";
        void video.play().catch(() => {});
      } else {
        video.pause();
        video.removeAttribute("src");
        video.load();
        video.style.display = "none";
        img.src = convertFileSrc(path);
        img.style.display = "";
      }
      filenameSpan.textContent = maskPath(path);
      filenameSpan.title = path;
      container.style.display = "flex";
    } else {
      video.pause();
      video.removeAttribute("src");
      video.load();
      img.src = "";
      filenameSpan.textContent = "";
      filenameSpan.title = "";
      container.style.display = "none";
    }
  }

  imageInput?.addEventListener("input", updateImagePreview);
  imageInput?.addEventListener("change", updateImagePreview);

  document.getElementById("search-browse-image-btn")?.addEventListener("click", async () => {
    try {
      const selected: string | null = await invoke("select_path", { isDirectory: false });
      if (selected && imageInput) {
        imageInput.value = selected;
        imageInput.dispatchEvent(new Event("change", { bubbles: true }));
        updateImagePreview();
      }
    } catch (err) {
      console.error("Browse image dialog error: ", err);
    }
  });

  document.getElementById("search-clear-image-btn")?.addEventListener("click", () => {
    if (imageInput) {
      imageInput.value = "";
      imageInput.dispatchEvent(new Event("change", { bubbles: true }));
      updateImagePreview();
    }
  });

  searchForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!queryInput || !tagInput || !imageInput) return;

    const grid = document.getElementById("search-results-grid");
    const statsMeta = document.getElementById("search-stats-meta");
    if (statsMeta) statsMeta.style.display = "none";

    if (grid) {
      grid.innerHTML = `
        <div class="search-loading-container">
          <i class="bi bi-arrow-clockwise animate-spin" style="font-size: 24px;"></i>
          <span>Searching...</span>
        </div>
      `;
    }

    try {
      const query = queryInput.value.trim() || null;
      const tag = tagInput.value.trim() || null;
      const imagePath = imageInput.value.trim() || null;
      const filenameInput = document.getElementById("search-filename-input") as HTMLInputElement;
      const filenameFilter = filenameInput?.value.trim() || null;
      const parseFilter = parseInput?.value.trim() || null;
      const parseTypeSelect = document.getElementById(
        "search-parse-type-select",
      ) as HTMLSelectElement;
      const parseType = parseTypeSelect?.value.trim() || null;
      const ocrFilterCheckbox = document.getElementById("search-ocr-filter") as HTMLInputElement;
      const ocrFilter = ocrFilterCheckbox?.checked ? true : null;
      const ocrTextInput = document.getElementById("search-ocr-text-input") as HTMLInputElement;
      const ocrTextSearch = ocrTextInput?.value.trim() || null;
      const mediaTypeSelect = document.getElementById(
        "search-media-type-select",
      ) as HTMLSelectElement;
      const mediaType = mediaTypeSelect && mediaTypeSelect.value ? mediaTypeSelect.value : null;

      const startTime = performance.now();
      const resp = await typedCall(
        "SearchService.Search",
        SearchRequestSchema,
        {
          queryText: query ?? undefined,
          queryImagePath: imagePath ?? undefined,
          tagFilter: tag ?? undefined,
          filenameFilter: filenameFilter ?? undefined,
          parseFilter: parseFilter ?? undefined,
          parseType: parseType ?? undefined,
          characterIdentityId: undefined,
          ocrFilter: ocrFilter ?? undefined,
          ocrTextSearch: ocrTextSearch ?? undefined,
          mediaType: mediaType ?? undefined,
          limit: 50,
        },
        SearchResultSchema,
      );

      const elapsedMs = performance.now() - startTime;

      const matches = resp.matches.map(searchMatchFromProto);
      renderSearchResults(matches);

      if (statsMeta) {
        const timeStr =
          elapsedMs < 1000
            ? `${elapsedMs.toFixed(1)} ms`
            : `${(elapsedMs / 1000).toFixed(2)} seconds`;
        const count = matches.length;
        statsMeta.textContent = `About ${count} result${count === 1 ? "" : "s"} (${timeStr})`;
        statsMeta.style.display = "inline";
      }
    } catch (e: any) {
      if (statsMeta) statsMeta.style.display = "none";
      const clean = String(e?.message || e).replace(/^Internal error:\s*/, "");
      if (grid)
        grid.innerHTML = `<p style="color: #ef4444; padding: 10px;">Search failed: ${escapeHtml(clean)}</p>`;
      showErrorAlert(`Search failed: ${clean}`);
    }
  });

  // Search Selection Toolbar Buttons
  setupSelectionToolbar({ prefix: "search", gridSelector: "#search-results-grid" });
}

let allTags: { tag: string; count: number }[] = [];

async function loadAllTags() {
  try {
    const resp = await typedCall(
      "TagsService.GetTagStatistics",
      null,
      null,
      TagStatisticsResultSchema,
    );
    allTags = resp.tags
      .map((t) => ({ tag: t.tag, count: Number(t.count) }))
      .sort((a, b) => b.count - a.count);
  } catch (_) {}
}

function setupTagAutocomplete() {
  loadAllTags();

  const tagInput = document.getElementById("search-tag-input") as HTMLInputElement;
  if (!tagInput) return;

  attachAutocomplete({
    input: tagInput,
    dropdownId: "search-tag-autocomplete",
    onSelect: (selectedTag) => {
      const currentVal = tagInput.value.trim();
      if (currentVal) {
        const tags = currentVal
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t);
        if (tags.length > 0) {
          tags[tags.length - 1] = selectedTag;
        } else {
          tags.push(selectedTag);
        }
        tagInput.value = tags.join(", ");
      } else {
        tagInput.value = selectedTag;
      }
    },
    fetchItems: async (query) => {
      const q = query.toLowerCase();
      const parts = query.split(",").map((t) => t.trim());
      const lastPart = parts[parts.length - 1];
      if (!lastPart) return [];
      const existingTags = new Set(parts.slice(0, -1).map((t) => t.toLowerCase()));
      return allTags
        .filter((t) => t.tag.toLowerCase().includes(q) && !existingTags.has(t.tag.toLowerCase()))
        .map((t) => ({ name: t.tag, count: t.count }));
    },
  });
}

// ---------------------------------------------------------------------------
// HTML Template
// ---------------------------------------------------------------------------

export function renderSearchHtml(): SafeHtml {
  return html`
    <div class="group-box">
      <div class="group-box-title">General Search</div>
      <form id="search-form">
        <div style="display: flex; flex-direction: column; gap: 10px; align-items: stretch;">
          <div class="form-group">
            <label for="search-text-input" style="min-width: 80px;">Query:</label>
            <div class="input-wrapper" style="flex: 2;">
              <input
                class="input-field has-clear"
                id="search-text-input"
                placeholder="Type natural language query (e.g. 'a cute dog sleeping')..."
              />
              <button type="button" class="input-clear-btn" tabindex="-1">
                <i class="bi bi-x-lg"></i>
              </button>
            </div>
            <div class="input-wrapper" style="flex: 0 0 110px;">
              <select
                class="input-field"
                id="search-media-type-select"
                style="width: 100%; height: 24px;"
                title="Filter results by media type"
              >
                <option value="">All Media</option>
                <option value="image">Images</option>
                <option value="video">Videos</option>
              </select>
            </div>
            <div class="input-wrapper" style="flex: 1; position: relative;">
              <input
                class="input-field has-clear"
                id="search-tag-input"
                placeholder="Filter by tag(s), comma-separated..."
                autocomplete="off"
              />
              <button type="button" class="input-clear-btn" tabindex="-1">
                <i class="bi bi-x-lg"></i>
              </button>
              <div
                id="search-tag-autocomplete"
                class="autocomplete-dropdown"
                style="display: none;"
              ></div>
            </div>
          </div>

          <div class="form-group">
            <label for="search-filename-input" style="min-width: 80px;">Filename:</label>
            <div class="input-wrapper" style="flex: 1;">
              <input
                class="input-field has-clear"
                id="search-filename-input"
                placeholder="Search by filename (e.g. 'sample', 'artwork_001')..."
              />
              <button type="button" class="input-clear-btn" tabindex="-1">
                <i class="bi bi-x-lg"></i>
              </button>
            </div>
          </div>
          <div class="form-group">
            <label for="search-parse-input" style="min-width: 80px;">Parsed:</label>
            <div class="input-wrapper" style="flex: 1;">
              <input
                class="input-field has-clear"
                id="search-parse-input"
                placeholder="Search parsed filename (e.g. 'Ichijyoma', '108521179', 'Erai-raws')..."
              />
              <button type="button" class="input-clear-btn" tabindex="-1">
                <i class="bi bi-x-lg"></i>
              </button>
            </div>
            <button
              type="button"
              class="win-button"
              id="search-parse-help-btn"
              style="padding: 2px 6px; font-size: 11px;"
              title="How to search parsed filenames"
            >
              <i class="bi bi-info-circle"></i>
            </button>
            <div class="input-wrapper" style="width: 160px;">
              <select
                class="input-field"
                id="search-parse-type-select"
                style="width: 100%; height: 24px;"
              >
                <option value="">All Parse Types</option>
                <option value="pixiv_id">Pixiv</option>
                <option value="twitter_key">Twitter</option>
                <option value="4chan_timestamp">4chan</option>
                <option value="anime_screenshot">Anime Screenshot</option>
                <option value="danbooru">Danbooru</option>
                <option value="tagged_string">Tagged String</option>
              </select>
            </div>
          </div>
          <div class="form-group">
            <label for="search-ocr-text-input" style="min-width: 80px;">OCR Text:</label>
            <div class="input-wrapper" style="flex: 1;">
              <input
                class="input-field has-clear"
                id="search-ocr-text-input"
                placeholder="Search OCR-extracted text (e.g. 'dialogue', 'sign text')..."
              />
              <button type="button" class="input-clear-btn" tabindex="-1">
                <i class="bi bi-x-lg"></i>
              </button>
            </div>
          </div>
          <div class="form-group">
            <label for="search-image-path-input" style="min-width: 80px;">Image:</label>
            <div class="input-wrapper" style="flex: 1;">
              <input
                class="input-field has-clear"
                id="search-image-path-input"
                placeholder="Or select image path for reverse search..."
              />
              <button type="button" class="input-clear-btn" tabindex="-1">
                <i class="bi bi-x-lg"></i>
              </button>
            </div>
            <button
              type="button"
              class="win-button"
              id="search-browse-image-btn"
              style="white-space: nowrap;"
            >
              <i class="bi bi-file-earmark-image"></i> Browse Image...
            </button>
            <button
              type="button"
              class="win-button"
              id="search-clear-image-btn"
              style="white-space: nowrap;"
            >
              <i class="bi bi-x-lg"></i> Clear Path
            </button>
            <label
              style="display: flex; align-items: center; gap: 4px; font-size: 11px; white-space: nowrap; cursor: pointer;"
            >
              <input type="checkbox" id="search-ocr-filter" />
              <i class="bi bi-file-earmark-text"></i> OCR only
            </label>
            <button type="submit" class="win-button" style="width: 100px; font-weight: bold;">
              Search
            </button>
          </div>
          <div
            id="search-image-preview-container"
            style="display: none; align-items: center; gap: 10px; margin-top: 4px; padding: 6px; border: 1px dashed var(--sys-border-dark); background-color: var(--sys-window-bg); max-width: 350px;"
          >
            <img
              id="search-image-preview-img"
              src=""
              alt="Query Preview"
              style="height: 60px; width: 60px; object-fit: cover; border: 1px solid var(--sys-border-dark); display: none;"
            />
            <video
              id="search-image-preview-video"
              muted
              playsinline
              preload="metadata"
              style="height: 60px; width: 60px; object-fit: cover; border: 1px solid var(--sys-border-dark); display: none;"
            ></video>
            <div
              style="display: flex; flex-direction: column; gap: 2px; overflow: hidden; flex: 1;"
            >
              <span style="font-weight: bold; font-size: 11px;">Input Query Image:</span>
              <span
                id="search-image-preview-filename"
                style="font-size: 10px; color: #555555; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"
                title=""
              ></span>
            </div>
          </div>
        </div>
      </form>
    </div>

    <!-- Parse Search Help Modal -->
    <div
      id="search-parse-help-modal"
      class="group-box"
      style="display: none; margin-top: 0.5rem; padding: 12px;"
    >
      <div
        style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;"
      >
        <span style="font-weight: 600; font-size: 12px;"
          ><i class="bi bi-info-circle"></i> Parsed Filename Search Help</span
        >
        <button
          type="button"
          class="win-button"
          id="search-parse-help-close"
          style="padding: 1px 6px; font-size: 10px;"
        >
          <i class="bi bi-x-lg"></i>
        </button>
      </div>
      <div style="font-size: 11px; color: #444; line-height: 1.6;">
        <p style="margin: 0 0 6px 0;">
          Searches across all parsed metadata fields stored from the
          <strong>Filename Parser</strong>.
        </p>
        <p style="margin: 0 0 8px 0;">
          <strong>Chaining:</strong> Space-separated terms are ANDed. Each term can be
          <code>field:value</code> or plain text.
        </p>
        <div
          style="margin-bottom: 8px; padding: 6px 8px; background: #f8f9fa; border: 1px solid #dee2e6; font-family: monospace; font-size: 11px;"
        >
          <div style="margin-bottom: 4px; font-weight: 600;">Examples:</div>
          <div>
            <code>anime:"Ichijyoma Mankitsu Gurashi" episode:09</code> — exact anime name + episode
          </div>
          <div>
            <code>anime:Gurashi episode:09</code> — partial match (anime contains "Gurashi")
          </div>
          <div><code>Erai-raws anime:Gurashi</code> — group name + anime name</div>
          <div><code>artist:Mineori</code> — Pixiv images by artist</div>
          <div><code>108521179</code> — plain text searches all fields</div>
        </div>
        <div
          style="display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin-bottom: 8px;"
        >
          <strong>Artist name</strong> <span>e.g. <code>artist:Ichijyoma</code></span>
          <strong>Pixiv ID</strong>
          <span>e.g. <code>pixiv_id:108521179</code> or just <code>108521179</code></span>
          <strong>Anime name</strong> <span>e.g. <code>anime:Gurashi</code></span>
          <strong>Episode</strong> <span>e.g. <code>episode:09</code></span>
          <strong>Source group</strong> <span>e.g. <code>group:Erai-raws</code></span>
          <strong>Resolution</strong> <span>e.g. <code>resolution:1080p</code></span>
          <strong>Date</strong> <span>e.g. <code>date:2022-05-14</code></span>
        </div>
        <p style="margin: 0; color: #666;">
          Use the <strong>Type</strong> dropdown to filter by parse type (e.g. only Anime
          Screenshots). Leave it on "All Parse Types" to search everything.
        </p>
      </div>
    </div>

    <div class="group-box" style="margin-top: 1.5rem;">
      <div class="group-box-title">Search Results</div>
      <div
        style="display: flex; justify-content: space-between; align-items: center; margin-top: 6px; margin-bottom: 12px; flex-wrap: wrap; gap: 10px;"
      >
        <div style="display: flex; align-items: center; gap: 8px;">
          <button type="button" class="win-button" id="search-toggle-select-mode-btn">
            <i class="bi bi-check2-square"></i> Select Mode
          </button>
          <span
            id="search-selected-count"
            style="font-size: 11px; color: var(--sys-text-subtle); display: none;"
            >0 selected</span
          >
          <button
            type="button"
            class="win-button"
            id="search-select-all-btn"
            style="display: none; font-size: 11px;"
          >
            Select All
          </button>
          <button
            type="button"
            class="win-button"
            id="search-clear-select-btn"
            style="display: none; font-size: 11px;"
          >
            Clear
          </button>
          <div class="selection-toolbar-actions extensions-toolbar" style="display: none;"></div>
        </div>

        <span
          id="search-stats-meta"
          style="font-size: 11px; color: var(--sys-text-subtle, #71717a); font-style: italic; display: none;"
        ></span>
      </div>
      <div class="image-grid" id="search-results-grid">
        <!-- Results dynamically populated -->
      </div>
    </div>
  `;
}
