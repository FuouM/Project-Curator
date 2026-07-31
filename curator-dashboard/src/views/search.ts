import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { callService } from "../ipc";
import { maskPath } from "../components";
import { renderSearchResults } from "../cards";
import { setupInputClearButtons } from "./concepts";
import { setupSelectionToolbar } from "../selection-toolbar";
import { attachAutocomplete } from "../autocomplete";

export async function loadSearchConceptsDropdown() {
  const select = document.getElementById("search-concept-select") as HTMLSelectElement;
  if (!select) return;

  try {
    const resp = await callService({ ListConcepts: null });
    if ("ConceptListResult" in resp) {
      const concepts = resp.ConceptListResult.concepts;
      const optionsHtml = `<option value="">-- All Concepts --</option>` + concepts.map((c: any) =>
        `<option value="${c.id}">${c.name} (${c.sample_count} samples)</option>`
      ).join("");
      select.innerHTML = optionsHtml;
    }
  } catch (_) {}
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
    document.getElementById("search-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }, 100);
}

export function setupSearch() {
  setupInputClearButtons();
  loadSearchConceptsDropdown();
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
    const filenameSpan = document.getElementById("search-image-preview-filename");
    if (!imageInput || !container || !img || !filenameSpan) return;

    const path = imageInput.value.trim();
    if (path) {
      img.src = convertFileSrc(path);
      filenameSpan.textContent = maskPath(path);
      filenameSpan.title = path;
      container.style.display = "flex";
    } else {
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
        imageInput.dispatchEvent(new Event('change', { bubbles: true }));
        updateImagePreview();
      }
    } catch (err) {
      console.error("Browse image dialog error: ", err);
    }
  });

  document.getElementById("search-clear-image-btn")?.addEventListener("click", () => {
    if (imageInput) {
      imageInput.value = "";
      imageInput.dispatchEvent(new Event('change', { bubbles: true }));
      updateImagePreview();
    }
  });

  searchForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!queryInput || !tagInput || !imageInput) return;

    const grid = document.getElementById("search-results-grid");
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
      const parseTypeSelect = document.getElementById("search-parse-type-select") as HTMLSelectElement;
      const parseType = parseTypeSelect?.value.trim() || null;
      const conceptSelect = document.getElementById("search-concept-select") as HTMLSelectElement;
      const conceptIdVal = conceptSelect && conceptSelect.value ? parseInt(conceptSelect.value) : null;
      const ocrFilterCheckbox = document.getElementById("search-ocr-filter") as HTMLInputElement;
      const ocrFilter = ocrFilterCheckbox?.checked ? true : null;

      const resp = await callService({
        Search: { query_text: query, query_image_path: imagePath, tag_filter: tag, filename_filter: filenameFilter, parse_filter: parseFilter, parse_type: parseType, concept_id: conceptIdVal, character_identity_id: null, ocr_filter: ocrFilter, limit: 50 }
      });

      if ("SearchResult" in resp) {
        renderSearchResults(resp.SearchResult.matches);
      } else if ("Error" in resp) {
        if (grid) grid.innerHTML = `<p style="color: #ef4444; padding: 10px;">Search failed: ${resp.Error.message}</p>`;
        alert("Search failed: " + resp.Error.message);
      }
    } catch (e: any) {
      if (grid) grid.innerHTML = `<p style="color: #ef4444; padding: 10px;">IPC Search failed: ${e.message || e}</p>`;
      alert("IPC Search failed: " + e);
    }
  });

  // Search Selection Toolbar Buttons
  setupSelectionToolbar({ prefix: "search", gridSelector: "#search-results-grid" });
}

let allTags: { tag: string; count: number }[] = [];

async function loadAllTags() {
  try {
    const resp = await callService({ GetTagStatistics: null });
    if ("TagStatisticsResult" in resp) {
      allTags = resp.TagStatisticsResult.tags
        .map((t: any) => ({ tag: t.tag, count: t.count }))
        .sort((a: any, b: any) => b.count - a.count);
    }
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
        const tags = currentVal.split(",").map((t) => t.trim()).filter((t) => t);
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
