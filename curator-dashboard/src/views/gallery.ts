import { callService } from "../ipc";
import { galleryPage, favoritesPage, isSelectMode, selectedImageIds } from "../state";
import { getImagesPerPage } from "../state";
import { renderImages } from "../cards";

export function refreshGallery() { return refreshPaginatedImages(galleryPage, "gallery-grid", "gallery", {}); }
export function refreshFavorites() { return refreshPaginatedImages(favoritesPage, "favorites-grid", "favorites", { only_favorites: true }); }

export async function refreshPaginatedImages(
  page: number,
  gridId: string,
  idPrefix: string,
  listOpts: { only_favorites?: boolean }
) {
  const perPage = getImagesPerPage();
  try {
    const resp = await callService({ ListImages: { limit: perPage, offset: page * perPage, ...listOpts } });
    if ("ListResult" in resp) {
      const images = resp.ListResult.images;
      renderImages(images, gridId);

      const indicator = document.getElementById(`${idPrefix}-page-indicator`);
      if (indicator) indicator.textContent = `Page ${page + 1}`;

      const prevBtn = document.getElementById(`${idPrefix}-prev-btn`) as HTMLButtonElement;
      if (prevBtn) prevBtn.disabled = page === 0;

      const nextBtn = document.getElementById(`${idPrefix}-next-btn`) as HTMLButtonElement;
      if (nextBtn) nextBtn.disabled = images.length < perPage;
    }
  } catch (e) {
    console.error(`Failed to refresh ${idPrefix}: `, e);
  }
}

export function setupPaginationButtons(prevId: string, nextId: string, pageRef: { value: number }, refreshFn: () => Promise<void>) {
  document.getElementById(prevId)?.addEventListener("click", () => {
    if (pageRef.value > 0) { pageRef.value--; refreshFn(); }
  });
  document.getElementById(nextId)?.addEventListener("click", () => {
    pageRef.value++;
    refreshFn();
  });
}

export function updateSelectionUI() {
  const countSpan = document.getElementById("gallery-selected-count");
  const searchCountSpan = document.getElementById("search-selected-count");
  const teachCountSpan = document.getElementById("teach-select-count");
  const searchTeachCountSpan = document.getElementById("search-teach-select-count");

  const toggleBtn = document.getElementById("toggle-select-mode-btn");
  const searchToggleBtn = document.getElementById("search-toggle-select-mode-btn");

  const selectAllBtn = document.getElementById("gallery-select-all-btn");
  const searchSelectAllBtn = document.getElementById("search-select-all-btn");

  const clearBtn = document.getElementById("gallery-clear-select-btn");
  const searchClearBtn = document.getElementById("search-clear-select-btn");

  const teachBtn = document.getElementById("gallery-teach-concept-btn");
  const searchTeachBtn = document.getElementById("search-teach-concept-btn");

  const galleryGrid = document.getElementById("gallery-grid");
  const searchGrid = document.getElementById("search-results-grid");

  toggleBtn?.classList.toggle("primary", isSelectMode);
  searchToggleBtn?.classList.toggle("primary", isSelectMode);

  if (isSelectMode) {
    galleryGrid?.classList.add("select-mode-active");
    searchGrid?.classList.add("select-mode-active");
  } else {
    galleryGrid?.classList.remove("select-mode-active");
    searchGrid?.classList.remove("select-mode-active");
  }

  const count = selectedImageIds.size;
  const countText = `${count} selected`;

  if (countSpan) {
    countSpan.textContent = countText;
    countSpan.style.display = isSelectMode ? "inline" : "none";
  }
  if (searchCountSpan) {
    searchCountSpan.textContent = countText;
    searchCountSpan.style.display = isSelectMode ? "inline" : "none";
  }

  if (teachCountSpan) teachCountSpan.textContent = count.toString();
  if (searchTeachCountSpan) searchTeachCountSpan.textContent = count.toString();

  if (selectAllBtn) selectAllBtn.style.display = isSelectMode ? "inline-block" : "none";
  if (searchSelectAllBtn) searchSelectAllBtn.style.display = isSelectMode ? "inline-block" : "none";

  if (clearBtn) clearBtn.style.display = isSelectMode && count > 0 ? "inline-block" : "none";
  if (searchClearBtn) searchClearBtn.style.display = isSelectMode && count > 0 ? "inline-block" : "none";

  if (teachBtn) teachBtn.style.display = count > 0 ? "inline-block" : "none";
  if (searchTeachBtn) searchTeachBtn.style.display = count > 0 ? "inline-block" : "none";
}
