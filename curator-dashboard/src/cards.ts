import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { renderTagPill, maskPath } from "./components";
import { CardImageData, ImageDetails, SearchMatch, TagSummary } from "./types";
import { imageBytesToPngBlob } from "./utils";
import { getImageClickAction, isSelectMode, selectedImageIds } from "./state";
import { openImageViewer } from "./image-viewer";
import { callService } from "./ipc";

// --- Tag Pill Helpers ---

export function getTagPillHtml(t: TagSummary, isDeletable = false, imageId = 0): string {
  return renderTagPill(t, { isDeletable, imageId });
}

export function renderTagListHtml(tags: TagSummary[], maxVisible = 10): string {
  const display = tags.slice(0, maxVisible);
  const extraCount = tags.length - maxVisible;
  return display.map(t => getTagPillHtml(t)).join("") +
    (extraCount > 0 ? `<span class="tag-pill" style="background-color: #f0f0f0; color: #555555; font-style: italic;">+${extraCount} more</span>` : "");
}

// --- Card Event Handlers ---

function attachStarButtonHandler(parentEl: Element, imageId: number, favState: { favorite: boolean }, syncCrossCards = false) {
  const starBtn = parentEl.querySelector(".star-btn");
  if (!starBtn) return;
  starBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const newFav = !starBtn.classList.contains("favorite");
    try {
      const resp = await callService({ SetFavorite: { image_id: imageId, favorite: newFav } });
      if ("Success" in resp) {
        favState.favorite = newFav;
        if (newFav) {
          starBtn.classList.add("favorite");
          starBtn.querySelector("i")?.setAttribute("class", "bi bi-star-fill");
        } else {
          starBtn.classList.remove("favorite");
          starBtn.querySelector("i")?.setAttribute("class", "bi bi-star");
        }
        if (syncCrossCards) {
          document.querySelectorAll(`[data-image-id="${imageId}"] .star-btn`).forEach(btn => {
            if (newFav) {
              btn.classList.add("favorite");
              btn.querySelector("i")?.setAttribute("class", "bi bi-star-fill");
            } else {
              btn.classList.remove("favorite");
              btn.querySelector("i")?.setAttribute("class", "bi bi-star");
            }
          });
        }
        const activeNav = document.querySelector(".nav-item.active");
        if (activeNav && activeNav.getAttribute("data-view") === "favorites" && !newFav) {
          // Lazy import to avoid circular - will be resolved at runtime
          import("./views/gallery").then(m => m.refreshFavorites());
        }
      }
    } catch (err) {
      console.error("Failed to update favorite status:", err);
    }
  });
}

function attachOpenFolderHandler(parentEl: Element, filepath: string) {
  const pathEl = parentEl.querySelector(".image-path");
  const openFolderBtn = parentEl.querySelector(".image-open-folder-btn") as HTMLButtonElement | null;
  if (!pathEl || !openFolderBtn) return;
  pathEl.addEventListener("click", (e) => {
    e.stopPropagation();
    openFolderBtn.style.display = openFolderBtn.style.display === "none" ? "inline-flex" : "none";
  });
  openFolderBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const dir = filepath.replace(/[\\/][^\\/]+$/, "");
    invoke("open_file_externally", { path: dir }).catch((err) => {
      console.error("Failed to open folder:", err);
    });
  });
}

function attachCopyToClipboardHandler(parentEl: Element, filepath: string) {
  const copyBtn = parentEl.querySelector(".copy-btn");
  if (!copyBtn) return;
  copyBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      const bytes: number[] = await invoke("read_image_bytes", { path: filepath });
      const uint8 = new Uint8Array(bytes);
      const blob = await imageBytesToPngBlob(uint8);
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob })
      ]);
      copyBtn.classList.add("copied");
      copyBtn.querySelector("i")?.setAttribute("class", "bi bi-check-lg");
      setTimeout(() => {
        copyBtn.classList.remove("copied");
        copyBtn.querySelector("i")?.setAttribute("class", "bi bi-clipboard");
      }, 1500);
    } catch (err) {
      console.error("Failed to copy image to clipboard:", err);
    }
  });
}

function attachPreviewClickHandler(previewEl: Element, filepath: string) {
  previewEl.addEventListener("click", () => {
    if (getImageClickAction() === "external") {
      invoke("open_file_externally", { path: filepath }).catch((err) => {
        console.error("Failed to open file externally:", err);
      });
    } else {
      openImageViewer(filepath);
    }
  });
}

export function attachCardEventHandlers(parentEl: Element, imageId: number, filepath: string, favState: { favorite: boolean }, previewSelector = ".image-preview", syncCrossCards = false) {
  attachStarButtonHandler(parentEl, imageId, favState, syncCrossCards);
  attachOpenFolderHandler(parentEl, filepath);
  attachCopyToClipboardHandler(parentEl, filepath);
  const previewDiv = parentEl.querySelector(previewSelector);
  if (previewDiv) attachPreviewClickHandler(previewDiv, filepath);
}

// --- Browse Button Helper ---

export function setupBrowseButton(btnId: string, targetInput: HTMLInputElement, isDirectory: boolean) {
  document.getElementById(btnId)?.addEventListener("click", async () => {
    try {
      const selected: string | null = await invoke("select_path", { isDirectory });
      if (selected) {
        targetInput.value = selected;
        targetInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
    } catch (err) {
      console.error(`${isDirectory ? "Folder" : "File"} dialog error: `, err);
    }
  });
}

// --- Card Rendering ---

export function renderCards(cards: CardImageData[], grid: HTMLElement) {
  cards.forEach((img) => {
    const card = document.createElement("div");
    card.className = `image-card ${selectedImageIds.has(img.id) ? 'selected' : ''}`;
    card.dataset.imageId = img.id.toString();

    const srcUrl = convertFileSrc(img.filepath);
    const tagHtml = renderTagListHtml(img.tags);

    card.innerHTML = `
      <input type="checkbox" class="card-select-checkbox" data-id="${img.id}" ${selectedImageIds.has(img.id) ? 'checked' : ''} />
      <div class="star-btn ${img.favorite ? 'favorite' : ''}" data-id="${img.id}">
        <i class="bi ${img.favorite ? 'bi-star-fill' : 'bi-star'}"></i>
      </div>
      <div class="image-preview">
        <img src="${srcUrl}" alt="Image Preview" style="width: 100%; height: 100%; object-fit: cover;" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';" />
        <span style="display: none;"><i class="bi bi-image"></i></span>
        ${img.badgeHtml || ""}
        <div class="copy-btn" title="Copy image to clipboard"><i class="bi bi-clipboard"></i></div>
      </div>
      <div class="image-info">
        <div class="image-path-row">
          <div class="image-path" title="${img.filepath}">${maskPath(img.filepath)}</div>
          <button class="win-button image-open-folder-btn" style="display: none; font-size: 10px; padding: 1px 6px; white-space: nowrap;" title="Open containing folder">
            <i class="bi bi-folder2-open"></i>
          </button>
        </div>
        <div class="tag-list">
          ${tagHtml}
        </div>
        <div style="display: flex; gap: 4px; margin-top: auto; width: 100%;">
          <button class="win-button" style="font-size: 11px; flex: 1;" onclick="window.openTags(${img.id}, '${img.filepath.replace(/\\/g, '\\\\')}')">
            <i class="bi bi-tag"></i> Tags
          </button>
          <button class="win-button" style="font-size: 11px; flex: 1;" onclick="window.findSimilar('${img.filepath.replace(/\\/g, '\\\\')}')">
            <i class="bi bi-search"></i> Similar
          </button>
        </div>
      </div>
    `;

    const checkbox = card.querySelector(".card-select-checkbox") as HTMLInputElement;
    checkbox?.addEventListener("change", (e) => {
      e.stopPropagation();
      if (checkbox.checked) {
        selectedImageIds.add(img.id);
        card.classList.add("selected");
      } else {
        selectedImageIds.delete(img.id);
        card.classList.remove("selected");
      }
      import("./views/gallery").then(m => m.updateSelectionUI());
    });

    card.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest(".win-button") || target.closest(".star-btn") || target.closest(".copy-btn")) return;
      if (isSelectMode) {
        if (selectedImageIds.has(img.id)) {
          selectedImageIds.delete(img.id);
          card.classList.remove("selected");
          if (checkbox) checkbox.checked = false;
        } else {
          selectedImageIds.add(img.id);
          card.classList.add("selected");
          if (checkbox) checkbox.checked = true;
        }
        import("./views/gallery").then(m => m.updateSelectionUI());
      }
    });

    attachCardEventHandlers(card, img.id, img.filepath, { favorite: img.favorite ?? false });

    grid.appendChild(card);
  });
}

export function renderImages(images: ImageDetails[], gridId: string) {
  const grid = document.getElementById(gridId);
  if (!grid) return;
  grid.innerHTML = "";

  if (images.length === 0) {
    grid.innerHTML = "<p style='color: #64748b; font-style: italic;'>No images imported yet.</p>";
    return;
  }

  const cards: CardImageData[] = images.map(img => ({
    id: img.id,
    filepath: img.current_filepath,
    tags: img.tags,
    favorite: img.favorite,
    badgeHtml: `<div class="vector-badge ${img.vector_state === "ready" ? "badge-ready" : "badge-pending"}">${img.vector_state}</div>`,
  }));

  renderCards(cards, grid);
}

export function renderSearchResults(matches: SearchMatch[]) {
  const grid = document.getElementById("search-results-grid");
  if (!grid) return;
  grid.innerHTML = "";

  if (matches.length === 0) {
    grid.innerHTML = "<p style='color: #64748b; font-style: italic;'>No matching results found.</p>";
    return;
  }

  const cards: CardImageData[] = matches.map(m => {
    const badgeBg = m.match_type === "exact" ? "#dff6dd" : m.match_type === "perceptual" ? "#deecf9" : "#f3f2f1";
    const badgeColor = m.match_type === "exact" ? "#107c41" : m.match_type === "perceptual" ? "#005a9e" : "#323130";
    const badgeBorder = m.match_type === "exact" ? "#107c41" : m.match_type === "perceptual" ? "#005a9e" : "#8a8886";
    const scoreBadgeText = m.match_type === "exact" ? "Exact Match" : m.match_type === "perceptual" ? `Perceptual (d=${m.hamming_distance})` : `Score: ${m.score.toFixed(4)}`;
    return {
      id: m.id,
      filepath: m.filepath,
      tags: m.tags,
      badgeHtml: `<div class="vector-badge" style="background-color: ${badgeBg}; border: 1px solid ${badgeBorder}; color: ${badgeColor};">${scoreBadgeText}</div>`,
      emptyMessage: "No matching results found.",
    };
  });

  renderCards(cards, grid);
}
