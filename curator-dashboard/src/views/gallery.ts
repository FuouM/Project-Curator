import { typedCall } from "../ipc";
import { SafeHtml, html } from "../components";
import { isSelectMode, selectedImageIds, galleryInfiniteScroll, galleryZenMode, galleryFullImages, getGalleryInfiniteScroll, getGalleryZenMode, getGalleryPage, getFavoritesPage, getGalleryTotalCount, getFavoritesTotalCount, setGalleryPage } from "../state";
import { getImagesPerPage, setGalleryTotalCount, setFavoritesTotalCount } from "../state";
import { renderImages } from "../cards";
import { imageDetailsFromProto } from "../proto-adapters";
import { ListImagesRequestSchema, ListResultSchema } from "../gen/gallery_pb";

export let isGalleryLoading = false;

export function refreshGallery() {
  if (getGalleryZenMode()) {
    return refreshPaginatedImages(0, "gallery", "gallery", {}, false).then(() => {
      const perPage = getImagesPerPage();
      const totalPages = Math.ceil(getGalleryTotalCount() / perPage);
      if (totalPages > 1) {
        setGalleryPage(1);
        return loadMoreGallery(1).then(() => {
          const totalPages2 = Math.ceil(getGalleryTotalCount() / perPage);
          if (totalPages2 > 2) {
            setGalleryPage(2);
            return loadMoreGallery(2);
          }
        });
      }
    });
  } else {
    return refreshPaginatedImages(getGalleryPage(), "gallery", "gallery", {}, false);
  }
}
export function loadMoreGallery(page: number) { return refreshPaginatedImages(page, "gallery", "gallery", {}, true); }
export function refreshFavorites() { return refreshPaginatedImages(getFavoritesPage(), "favorites", "favorites", { only_favorites: true }); }

export async function refreshPaginatedImages(
  page: number,
  idPrefix: string,
  _unused: string,
  listOpts: { only_favorites?: boolean },
  append = false
) {
  if (isGalleryLoading) return;
  isGalleryLoading = true;
  const perPage = getImagesPerPage();
  try {
    const resp = await typedCall(
      "GalleryService.ListImages",
      ListImagesRequestSchema,
      { limit: perPage, offset: page * perPage, onlyFavorites: listOpts.only_favorites },
      ListResultSchema
    );
    const { images, totalCount } = resp;
    const gridId = idPrefix + "-grid";
    renderImages(images.map(imageDetailsFromProto), gridId, append);

    if (listOpts.only_favorites) {
      setFavoritesTotalCount(Number(totalCount));
    } else {
      setGalleryTotalCount(Number(totalCount));
    }

    const totalCountNum = listOpts.only_favorites ? getFavoritesTotalCount() : getGalleryTotalCount();
    const totalPages = Math.max(1, Math.ceil(totalCountNum / perPage));

    const isInfinite = getGalleryInfiniteScroll();
    const indicator = document.getElementById(`${idPrefix}-page-indicator`);
    if (indicator) {
      if (idPrefix === "gallery" && isInfinite) {
        const loadedCount = Math.min(totalCountNum, (page + 1) * perPage);
        indicator.textContent = `Showing ${loadedCount} of ${totalCountNum} images`;
      } else {
        indicator.textContent = `Page ${page + 1} of ${totalPages} (${totalCountNum} images)`;
      }
    }

    const controls = document.getElementById(`${idPrefix}-pagination-controls`);
    if (controls) {
      controls.style.display = (idPrefix === "gallery" && isInfinite) ? "none" : "flex";
    }

    if (idPrefix === "gallery") {
      const headerRight = document.getElementById("gallery-header-right");
      if (headerRight) {
        headerRight.style.display = getGalleryZenMode() ? "none" : "flex";
      }
    }

    const prevBtn = document.getElementById(`${idPrefix}-prev-btn`) as HTMLButtonElement;
    if (prevBtn) prevBtn.disabled = page === 0;

    const nextBtn = document.getElementById(`${idPrefix}-next-btn`) as HTMLButtonElement;
    if (nextBtn) nextBtn.disabled = page >= totalPages - 1;

    const jumpInput = document.getElementById(`${idPrefix}-page-jump`) as HTMLInputElement;
    if (jumpInput) {
      jumpInput.max = totalPages.toString();
      jumpInput.placeholder = `1-${totalPages}`;
    }
  } catch (e) {
    console.error(`Failed to refresh ${idPrefix}: `, e);
  } finally {
    isGalleryLoading = false;
  }
}

// ---------------------------------------------------------------------------
// HTML Templates
// ---------------------------------------------------------------------------

export function renderGalleryHtml(): SafeHtml {
  return html`
    <div class="group-box">
      <div class="group-box-title">All Images</div>
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; flex-wrap: wrap; gap: 10px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <button type="button" class="win-button" id="gallery-toggle-select-mode-btn">
            <i class="bi bi-check2-square"></i> Select Mode
          </button>
          <span id="gallery-selected-count" style="font-size: 11px; color: var(--sys-text-subtle); display: none;">0 selected</span>
          <button type="button" class="win-button" id="gallery-select-all-btn" style="display: none; font-size: 11px;">Select All</button>
          <button type="button" class="win-button" id="gallery-clear-select-btn" style="display: none; font-size: 11px;">Clear</button>
          <button type="button" class="win-button primary" id="gallery-teach-concept-btn" style="display: none; font-size: 11px;">
            <i class="bi bi-magic"></i> Teach Concept (<span id="teach-select-count">0</span>)
          </button>
          <div class="selection-toolbar-actions extensions-toolbar" style="display: none;"></div>
          <button type="button" class="win-button" id="gallery-lucky-btn">
            <i class="bi bi-shuffle"></i> I'm Feeling Lucky
          </button>
          <button type="button" class="win-button ${galleryInfiniteScroll ? 'primary' : ''}" id="gallery-toggle-infinite-scroll-btn">
            <i class="bi bi-body-text"></i> Infinite Scroll
          </button>
          <button type="button" class="win-button ${galleryZenMode ? 'primary' : ''}" id="gallery-toggle-zen-mode-btn">
            <i class="bi bi-fullscreen"></i> Zen Mode
          </button>
          <button type="button" class="win-button ${galleryFullImages ? 'primary' : ''}" id="gallery-toggle-full-images-btn" title="Load full resolution images (non-video) smoothly after thumbnail">
            <i class="bi bi-aspect-ratio"></i> Full Images
          </button>
        </div>
        <div id="gallery-header-right" style="display: ${galleryZenMode ? 'none' : 'flex'}; align-items: center; gap: 10px;">
          <label style="font-size: 11px; color: #555555; display: flex; align-items: center; gap: 4px;">
            Show:
            <select class="input-field" id="gallery-per-page-select" style="width: 60px; height: 22px; font-size: 11px; padding: 1px 4px;">
              <option value="12">12</option>
              <option value="24">24</option>
              <option value="48">48</option>
              <option value="96">96</option>
            </select>
          </label>
          <span id="gallery-page-indicator" style="font-size: 11px; color: #555555;">Page 1</span>
          <span id="gallery-pagination-controls" style="display: ${galleryInfiniteScroll ? 'none' : 'flex'}; align-items: center; gap: 10px;">
            <input type="number" id="gallery-page-jump" min="1" style="width: 50px; font-size: 11px; padding: 2px 4px;" placeholder="#" />
            <button class="win-button" id="gallery-jump-btn" style="font-size: 11px; padding: 2px 6px;">Go</button>
            <button class="win-button" id="gallery-prev-btn" disabled><i class="bi bi-caret-left-fill"></i> Prev</button>
            <button class="win-button" id="gallery-next-btn">Next <i class="bi bi-caret-right-fill"></i></button>
          </span>
        </div>
      </div>
      <div class="image-grid ${galleryZenMode ? 'zen-mode-active' : ''}" id="gallery-grid">
        <!-- Dynamically populated -->
      </div>
    </div>
  `;
}

export function renderFavoritesHtml(): SafeHtml {
  return html`
    <div class="group-box">
      <div class="group-box-title">Favorite Images</div>
      <div style="display: flex; justify-content: flex-end; align-items: center; margin-bottom: 1rem; gap: 10px;">
        <label style="font-size: 11px; color: #555555; display: flex; align-items: center; gap: 4px;">
          Show:
          <select class="input-field" id="favorites-per-page-select" style="width: 60px; height: 22px; font-size: 11px; padding: 1px 4px;">
            <option value="12">12</option>
            <option value="24">24</option>
            <option value="48">48</option>
            <option value="96">96</option>
          </select>
        </label>
        <span id="favorites-page-indicator" style="font-size: 11px; color: #555555;">Page 1</span>
        <input type="number" id="favorites-page-jump" min="1" style="width: 50px; font-size: 11px; padding: 2px 4px;" placeholder="#" />
        <button class="win-button" id="favorites-jump-btn" style="font-size: 11px; padding: 2px 6px;">Go</button>
        <button class="win-button" id="favorites-prev-btn" disabled><i class="bi bi-caret-left-fill"></i> Prev</button>
        <button class="win-button" id="favorites-next-btn">Next <i class="bi bi-caret-right-fill"></i></button>
      </div>
      <div class="image-grid" id="favorites-grid">
        <!-- Dynamically populated -->
      </div>
    </div>
  `;
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

export function setupPageJump(jumpBtnId: string, jumpInputId: string, pageRef: { value: number }, refreshFn: () => Promise<void>) {
  const jumpBtn = document.getElementById(jumpBtnId);
  const jumpInput = document.getElementById(jumpInputId) as HTMLInputElement | null;
  if (!jumpBtn || !jumpInput) return;

  const doJump = () => {
    const page = parseInt(jumpInput.value, 10) - 1;
    if (!isNaN(page) && page >= 0) {
      pageRef.value = page;
      refreshFn();
      jumpInput.value = "";
    }
  };

  jumpBtn.addEventListener("click", doJump);
  jumpInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doJump();
  });
}

export function updateSelectionUI() {
  const countSpan = document.getElementById("gallery-selected-count");
  const searchCountSpan = document.getElementById("search-selected-count");
  const teachCountSpan = document.getElementById("teach-select-count");
  const searchTeachCountSpan = document.getElementById("search-teach-select-count");

  const toggleBtn = document.getElementById("gallery-toggle-select-mode-btn");
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

  const extSlots = document.querySelectorAll<HTMLElement>("#extensions-toolbar, .extensions-toolbar");
  extSlots.forEach((el) => {
    el.style.display = isSelectMode && count > 0 ? "inline-flex" : "none";
  });
}
