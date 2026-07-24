import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { callService } from "../ipc";
import { maskPath } from "../components";
import { renderSearchResults } from "../cards";
import { setupInputClearButtons } from "./concepts";

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

      const resp = await callService({
        Search: { query_text: query, query_image_path: imagePath, tag_filter: tag, filename_filter: filenameFilter, parse_filter: parseFilter, parse_type: parseType, concept_id: conceptIdVal, limit: 50 }
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
  const searchToggleBtn = document.getElementById("search-toggle-select-mode-btn");
  const searchSelectAllBtn = document.getElementById("search-select-all-btn");
  const searchClearBtn = document.getElementById("search-clear-select-btn");
  const searchTeachBtn = document.getElementById("search-teach-concept-btn");

  searchToggleBtn?.addEventListener("click", async () => {
    const { isSelectMode, setIsSelectMode, selectedImageIds } = await import("../state");
    setIsSelectMode(!isSelectMode);
    if (!isSelectMode) {
      selectedImageIds.clear();
      document.querySelectorAll(".image-card.selected").forEach((c) => c.classList.remove("selected"));
      document.querySelectorAll(".card-select-checkbox").forEach((cb: any) => (cb.checked = false));
    }
    const { updateSelectionUI } = await import("./gallery");
    updateSelectionUI();
  });

  searchSelectAllBtn?.addEventListener("click", async () => {
    const { selectedImageIds } = await import("../state");
    const cards = document.querySelectorAll("#search-results-grid .image-card");
    cards.forEach((card: any) => {
      const id = parseInt(card.dataset.imageId || "0");
      if (id > 0) {
        selectedImageIds.add(id);
        card.classList.add("selected");
        const cb = card.querySelector(".card-select-checkbox");
        if (cb) cb.checked = true;
      }
    });
    const { updateSelectionUI } = await import("./gallery");
    updateSelectionUI();
  });

  searchClearBtn?.addEventListener("click", async () => {
    const { selectedImageIds } = await import("../state");
    selectedImageIds.clear();
    document.querySelectorAll(".image-card.selected").forEach((c) => c.classList.remove("selected"));
    document.querySelectorAll(".card-select-checkbox").forEach((cb: any) => (cb.checked = false));
    const { updateSelectionUI } = await import("./gallery");
    updateSelectionUI();
  });

  searchTeachBtn?.addEventListener("click", async () => {
    const { selectedImageIds } = await import("../state");
    if (selectedImageIds.size === 0) return;
    const { openTeachConceptModal } = await import("./concepts");
    openTeachConceptModal();
  });
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
  const dropdownEl = document.getElementById("search-tag-autocomplete");
  if (!tagInput || !dropdownEl) return;
  const dropdown = dropdownEl;

  let activeIndex = -1;

  function showDropdown(query: string) {
    if (!query || allTags.length === 0) {
      dropdown.style.display = "none";
      return;
    }

    const parts = query.split(',').map(t => t.trim());
    const lastPart = parts[parts.length - 1];
    if (!lastPart) {
      dropdown.style.display = "none";
      return;
    }

    const q = lastPart.toLowerCase();
    const existingTags = new Set(parts.slice(0, -1).map(t => t.toLowerCase()));
    const matches = allTags
      .filter(t => t.tag.toLowerCase().includes(q) && !existingTags.has(t.tag.toLowerCase()))
      .slice(0, 15);

    if (matches.length === 0) {
      dropdown.style.display = "none";
      return;
    }

    activeIndex = -1;
    dropdown.innerHTML = matches.map((t, i) =>
      `<div class="autocomplete-item" data-tag="${t.tag}" data-index="${i}">
        <span class="autocomplete-item-tag">${t.tag.replace(/_/g, '_\u200B')}</span>
        <span class="autocomplete-item-count">${t.count}</span>
      </div>`
    ).join("");
    dropdown.style.display = "block";

    dropdown.querySelectorAll<HTMLElement>(".autocomplete-item").forEach((item) => {
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const selectedTag = item.getAttribute("data-tag") || "";
        const currentVal = tagInput.value.trim();
        if (currentVal) {
          const tags = currentVal.split(',').map(t => t.trim()).filter(t => t);
          if (tags.length > 0) {
            tags[tags.length - 1] = selectedTag;
          } else {
            tags.push(selectedTag);
          }
          tagInput.value = tags.join(', ');
        } else {
          tagInput.value = selectedTag;
        }
        dropdown.style.display = "none";
        tagInput.focus();
      });
    });
  }

  function setActive(index: number) {
    const items = dropdown.querySelectorAll<HTMLElement>(".autocomplete-item");
    items.forEach((el, i) => el.classList.toggle("active", i === index));
  }

  tagInput.addEventListener("input", () => {
    showDropdown(tagInput.value.trim());
  });

  tagInput.addEventListener("focus", () => {
    if (tagInput.value.trim()) showDropdown(tagInput.value.trim());
  });

  tagInput.addEventListener("blur", () => {
    setTimeout(() => { dropdown.style.display = "none"; }, 150);
  });

  tagInput.addEventListener("keydown", (e) => {
    const items = dropdown.querySelectorAll<HTMLElement>(".autocomplete-item");
    if (dropdown.style.display === "none" || items.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, items.length - 1);
      setActive(activeIndex);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      setActive(activeIndex);
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      const selectedTag = items[activeIndex].getAttribute("data-tag") || "";
      const currentVal = tagInput.value.trim();
      if (currentVal) {
        const tags = currentVal.split(',').map(t => t.trim()).filter(t => t);
        if (tags.length > 0) {
          tags[tags.length - 1] = selectedTag;
        } else {
          tags.push(selectedTag);
        }
        tagInput.value = tags.join(', ');
      } else {
        tagInput.value = selectedTag;
      }
      dropdown.style.display = "none";
    } else if (e.key === "Escape") {
      dropdown.style.display = "none";
    }
  });
}
