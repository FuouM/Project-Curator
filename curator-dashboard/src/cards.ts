import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { renderTagPill, maskPath } from "./components";
import { CardImageData, ImageDetails, SearchMatch, TagSummary, ParsedMetadata } from "./types";
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

function renderParsedMetadataHtml(meta: ParsedMetadata): string {
  const parts: string[] = [];

  // Anime Screenshot: special merged pill
  if (meta.match_type === "anime_screenshot") {
    const animeTag = meta.extracted_tags.find(t => t.toLowerCase().startsWith("anime:"));
    const epTag = meta.extracted_tags.find(t => t.toLowerCase().startsWith("episode:"));
    const animeName = animeTag ? animeTag.split(":").slice(1).join(":") : "Unknown";
    const epNum = epTag ? epTag.split(":").slice(1).join(":") : "?";
    const partialBadge = meta.partial ? ' <span style="font-size: 9px; color: #856404;">(partial)</span>' : "";
    parts.push(`<span class="tag-pill tag-copyright" style="font-size: 10px; font-weight: 600;"><i class="bi bi-film"></i> Anime Screenshot: ${animeName} - ${epNum}${partialBadge}</span>`);
  } else if (meta.match_type === "danbooru") {
    const hashTag = meta.extracted_tags.find(t => t.toLowerCase().startsWith("hash:"));
    const artistTag = meta.extracted_tags.find(t => t.toLowerCase().startsWith("artist:"));
    const hash = hashTag ? hashTag.split(":").slice(1).join(":") : "";
    const artist = artistTag ? artistTag.split(":").slice(1).join(":") : "?";
    const hashDisplay = hash.length > 8 ? `${hash.slice(0, 4)}...${hash.slice(-4)}` : hash;
    const hashLink = hash ? `<a href="https://danbooru.donmai.us/posts?tags=md5%3A${hash}" target="_blank" rel="noopener" style="color: inherit; text-decoration: underline; font-size: inherit;" onmouseover="this.style.textDecoration='none'" onmouseout="this.style.textDecoration='underline'" title="${hash}">${hashDisplay}</a>` : "?";
    parts.push(`<span class="tag-pill tag-copyright" style="font-size: 10px; font-weight: 600;"><i class="bi bi-grid-3x3-gap"></i> ${artist} - ${hashLink}</span>`);
  } else {
    // Build a single pill per type: "type: value"
    if (meta.datetime_iso) {
      parts.push(`<span class="tag-pill tag-meta" style="font-size: 10px;"><i class="bi bi-clock"></i> 4chan: ${meta.datetime_iso}</span>`);
    } else if (meta.artist) {
      parts.push(`<span class="tag-pill tag-artist" style="font-size: 10px;"><i class="bi bi-person"></i> artist: ${meta.artist}</span>`);
    }
  }

  if (meta.pixiv_id) {
    const pageTag = meta.extracted_tags.find(t => t.startsWith("page:"));
    const pageStr = pageTag ? ` ${pageTag}` : "";
    parts.push(`<span class="tag-pill tag-copyright" style="font-size: 10px;"><i class="bi bi-image"></i> pixiv: <a href="https://www.pixiv.net/en/artworks/${meta.pixiv_id}" target="_blank" rel="noopener" style="color: inherit; text-decoration: underline; font-size: inherit;" onmouseover="this.style.textDecoration='none'" onmouseout="this.style.textDecoration='underline'">${meta.pixiv_id}</a>${pageStr}</span>`);
  }
  if (meta.twitter_id) parts.push(`<span class="tag-pill tag-character" style="font-size: 10px;"><i class="bi bi-twitter"></i> twitter: ${meta.twitter_id}</span>`);

  // Show remaining extracted tags not already represented
  const fieldTags = new Set<string>();
  if (meta.artist) fieldTags.add(`artist:${meta.artist}`);
  if (meta.pixiv_id) fieldTags.add(`pixiv:${meta.pixiv_id}`);
  if (meta.twitter_id) fieldTags.add(`twitter:${meta.twitter_id}`);
  if (meta.datetime_iso) fieldTags.add(`date:${meta.datetime_iso.split(' ')[0]}`);
  if (meta.match_type === "anime_screenshot") {
    const a = meta.extracted_tags.find(t => t.toLowerCase().startsWith("anime:"));
    const e = meta.extracted_tags.find(t => t.toLowerCase().startsWith("episode:"));
    if (a) fieldTags.add(a);
    if (e) fieldTags.add(e);
  }

  for (const tag of meta.extracted_tags) {
    if (fieldTags.has(tag)) continue;
    if (tag.startsWith('artist:') || tag.startsWith('pixiv:') || tag.startsWith('twitter:')) continue;
    if (tag.startsWith('page:')) continue;
    const tl = tag.toLowerCase();
    if (tl.startsWith('anime:') || tl.startsWith('episode:')) continue;

    let tagClass = "tag-rank-3";
    if (tag.startsWith("date:")) tagClass = "tag-meta";
    else if (tag.startsWith("source:") || tag.startsWith("site:")) tagClass = "tag-meta";
    else if (tag.startsWith("group:")) tagClass = "tag-character";
    else if (tag.startsWith("resolution:")) tagClass = "tag-meta";
    parts.push(`<span class="tag-pill ${tagClass}" style="font-size: 10px; font-family: monospace;">${tag}</span>`);
  }

  return parts.join(" ");
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
    const parsedHtml = img.parsedMetadata ? renderParsedMetadataHtml(img.parsedMetadata) : "";

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
        ${parsedHtml ? `<div class="parsed-metadata-list" style="border-bottom: 1px solid var(--sys-border-light, #d0d0d0); padding-bottom: 6px; margin-bottom: 6px;">${parsedHtml}</div>` : ""}
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
    parsedMetadata: img.parsed_metadata,
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
      parsedMetadata: m.parsed_metadata,
    };
  });

  renderCards(cards, grid);
}
