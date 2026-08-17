import { html, SafeHtml, ComponentMeta } from "./_shared";
import { maskPath } from "./path-utils";
import { TagSummary } from "./tag-pill";
import {
  renderCardTagsContainerHtml,
  renderParsedMetadataHtml,
  renderIdentityListHtml,
  ParsedMetadata,
} from "./card-tags";
import { SafetyScores } from "../types";

export interface GalleryCardViewData {
  id: number;
  filepath: string;
  tags: TagSummary[];
  isSelected: boolean;
  isFavorite: boolean;
  isMissing: boolean;
  isLucky: boolean;
  cachedThumbSrc?: string;
  ocrText?: string;
  parsedMetadata?: ParsedMetadata;
  characterIdentities?: { name: string }[];
  video?: { format: string; durationMs: number; codec: string };
  badgeHtml?: string;
  width?: number;
  height?: number;
  mtime?: number;
  safety?: SafetyScores;
  keepLoaded?: boolean;
}

export function formatDuration(ms: number): string {
  if (ms >= 60000) {
    const total = Math.round(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`;
  return `${ms} ms`;
}

function ocrTextAttr(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return value.replace(/\\/g, "\\\\");
}

export function renderOcrBlockHtml(ocrText: string): SafeHtml {
  return html`
    <div class="ocr-block" data-action="toggle-ocr">
      <i
        class="bi bi-file-earmark-text ocr-icon"
        data-action="copy-ocr"
        data-ocr-copy="${ocrTextAttr(ocrText)}"
        title="Copy OCR text"
      ></i>
      <span class="ocr-block-text"
        >${ocrText.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")}</span
      >
    </div>
  `;
}

export function refreshCardOcr(imageId: number, ocrText: string) {
  const cards = document.querySelectorAll(`[data-image-id="${imageId}"]`);
  cards.forEach((card) => {
    const info = card.querySelector<HTMLElement>(".image-info, .featured-details");
    if (!info) return;

    const existing = info.querySelector(".ocr-block");
    if (ocrText) {
      const blockHtml = renderOcrBlockHtml(ocrText);
      if (existing) {
        existing.outerHTML = blockHtml.toString();
      } else {
        const anchor =
          info.querySelector(".identity-list") ?? info.querySelector(".card-tags-container");
        if (anchor) {
          anchor.insertAdjacentHTML("beforebegin", blockHtml.toString());
        } else {
          info.insertAdjacentHTML("beforeend", blockHtml.toString());
        }
      }
    } else if (existing) {
      existing.remove();
    }
  });
}

export function renderGalleryCardHtml(img: GalleryCardViewData): SafeHtml {
  let sizeClass = "";
  if (img.width) {
    if (img.width < 500) {
      sizeClass = "card-sz-small";
    } else if (img.width < 1000) {
      sizeClass = "card-sz-medium";
    } else {
      sizeClass = "card-sz-large";
    }
  }

  const aspect = img.width && img.height ? img.width / img.height : 1.5;

  let S = 2; // base scale
  if (img.width) {
    if (img.width < 500) {
      S = 1;
    } else if (img.width > 1200) {
      S = 3;
    }
  }
  let C = S;
  let R = S;
  if (aspect > 1) {
    C = Math.round(S * aspect);
    if (C > 4) {
      C = 4;
      R = Math.round(C / aspect) || 1;
    }
  } else {
    R = Math.round(S / aspect);
    if (R > 4) {
      R = 4;
      C = Math.round(R * aspect) || 1;
    }
  }

  const parsedHtml = img.parsedMetadata ? renderParsedMetadataHtml(img.parsedMetadata) : "";

  const identityHtml = renderIdentityListHtml(img.characterIdentities);

  const ocrHtml = img.ocrText ? renderOcrBlockHtml(img.ocrText) : "";

  const missingBadge = img.isMissing
    ? '<div class="badge-missing"><i class="bi bi-exclamation-triangle"></i> Missing</div>'
    : "";

  const videoBadge = img.video
    ? `<div class="badge-video" title="${img.video.format.toUpperCase()} · ${img.video.codec}"><i class="bi bi-play-btn-fill"></i> ${formatDuration(img.video.durationMs)}</div>`
    : "";

  const isPending = !img.cachedThumbSrc;
  const imgClass = img.cachedThumbSrc ? "loaded" : "";
  const previewClass = img.cachedThumbSrc ? "image-preview" : "image-preview thumb-loading";
  const srcAttr = img.cachedThumbSrc ? `src="${img.cachedThumbSrc}"` : "";

  const styleAttributes = `
    --aspect: ${aspect}; 
    --span-c: ${C}; 
    --span-r: ${R};
  `.replace(/\s+/g, " ");

  return html`
    <div
      class="image-card ${img.isSelected ? "selected" : ""} ${img.isLucky ? "lucky-highlight" : ""} ${sizeClass}"
      style="${styleAttributes}"
      data-image-id="${img.id}"
      data-filepath="${img.filepath}"
    >
      <input
        type="checkbox"
        class="card-select-checkbox"
        data-id="${img.id}"
        ${img.isSelected ? "checked" : ""}
      />
      <div class="star-btn ${img.isFavorite ? "favorite" : ""}" data-id="${img.id}">
        <i class="bi ${img.isFavorite ? "bi-star-fill" : "bi-star"}"></i>
      </div>
      <div
        class="${previewClass}"
        ${img.width && img.height ? `style="aspect-ratio: ${img.width} / ${img.height};"` : ""}
      >
        <img
          data-thumb-id="${img.id}"
          data-mtime="${img.mtime || 0}"
          data-filepath="${img.filepath}"
          data-is-video="${img.video ? "1" : "0"}"
          data-pending="${isPending ? "1" : "0"}"
          ${img.keepLoaded ? 'data-keep-loaded="1"' : ""}
          ${srcAttr}
          alt="Image Preview"
          style="width: 100%; height: 100%; object-fit: cover;"
          class="${imgClass}"
        />
        <span style="display: none;"><i class="bi bi-image"></i></span>
        ${missingBadge} ${videoBadge} ${img.badgeHtml || ""}
        <div class="copy-btn" title="Copy image to clipboard"><i class="bi bi-clipboard"></i></div>
        <div class="info-btn" title="View image details" data-id="${img.id}">
          <i class="bi bi-info-circle"></i>
        </div>
        <div class="nsfw-blackout" aria-hidden="true"></div>
      </div>
      <div class="image-info">
        <div class="image-path-row">
          <div class="image-path" title="${img.filepath}">${maskPath(img.filepath)}</div>
          <button
            class="win-button image-open-folder-btn"
            style="display: none; font-size: 10px; padding: 1px 6px; white-space: nowrap;"
            title="Open containing folder"
          >
            <i class="bi bi-folder2-open"></i>
          </button>
        </div>
        ${parsedHtml ? `<div class="parsed-metadata-list" style="border-bottom: 1px solid var(--sys-border-light, #d0d0d0); padding-bottom: 6px; margin-bottom: 6px;">${parsedHtml}</div>` : ""}
        ${ocrHtml} ${identityHtml}
        <div class="card-tags-container" style="width: 100%;">
          ${renderCardTagsContainerHtml({ tags: img.tags })}
        </div>
        <div style="display: flex; gap: 4px; margin-top: auto; width: 100%;">
          <button
            class="win-button"
            style="font-size: 11px; flex: 1;"
            data-action="open-tags"
            data-id="${img.id}"
            data-filepath="${escapeAttr(img.filepath)}"
          >
            <i class="bi bi-tag"></i> Tags
          </button>
          <button
            class="win-button"
            style="font-size: 11px; flex: 1;"
            data-action="find-similar"
            data-filepath="${escapeAttr(img.filepath)}"
          >
            <i class="bi bi-search"></i> Similar
          </button>
        </div>
      </div>
    </div>
  `;
}

export const meta: ComponentMeta = {
  name: "Gallery Card",
  description:
    "Grid visual cards optimized for lazy loaded assets and fast aspect-ratio layout grids.",
  variants: [
    {
      name: "Ready & Active States",
      render: () =>
        renderGalleryCardHtml({
          id: 10,
          filepath: "C:\\Gallery\\sample_art.webp",
          tags: [
            { tag: "1girl", category: "general", source_name: "ai:camie-tagger-v2" },
            { tag: "solo", category: "general", source_name: "ai:camie-tagger-v2" },
          ],
          isSelected: false,
          isFavorite: true,
          isMissing: false,
          isLucky: false,
          cachedThumbSrc:
            "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'><rect width='100' height='100' fill='%23ccc'/></svg>",
          width: 800,
          height: 600,
          parsedMetadata: {
            match_type: "danbooru",
            extracted_tags: ["artist:illustrator", "character:heroine"],
          },
        }),
    },
    {
      name: "Video and Metadata Badges",
      render: () =>
        renderGalleryCardHtml({
          id: 11,
          filepath: "D:\\Videos\\recording.mp4",
          tags: [],
          isSelected: true,
          isFavorite: false,
          isMissing: false,
          isLucky: true,
          cachedThumbSrc:
            "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'><rect width='100' height='100' fill='%23666'/></svg>",
          width: 1920,
          height: 1080,
          video: { format: "MP4", durationMs: 124000, codec: "h264" },
        }),
    },
  ],
};
