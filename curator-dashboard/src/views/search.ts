import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { callService } from "../ipc";
import { maskPath } from "../components";
import { renderSearchResults } from "../cards";

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
  const searchForm = document.getElementById("search-form");
  const queryInput = document.getElementById("search-text-input") as HTMLInputElement;
  const tagInput = document.getElementById("search-tag-input") as HTMLInputElement;
  const imageInput = document.getElementById("search-image-path-input") as HTMLInputElement;

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
          <span>Running AI search query...</span>
        </div>
      `;
    }

    try {
      const query = queryInput.value.trim() || null;
      const tag = tagInput.value.trim() || null;
      const imagePath = imageInput.value.trim() || null;
      const conceptSelect = document.getElementById("search-concept-select") as HTMLSelectElement;
      const conceptIdVal = conceptSelect && conceptSelect.value ? parseInt(conceptSelect.value) : null;

      const resp = await callService({
        Search: { query_text: query, query_image_path: imagePath, tag_filter: tag, concept_id: conceptIdVal, limit: 50 }
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
