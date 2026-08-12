import { typedCall } from "../ipc";
import { logJS, safeStringify } from "../utils";
import { showErrorAlert } from "../alert";
import { EmptySchema } from "@bufbuild/protobuf/wkt";
import { tagSummaryFromProto } from "../proto-adapters";
import { GetImageRequestSchema, ImageResultSchema } from "../gen/gallery_pb";
import { AddTagRequestSchema, RemoveTagRequestSchema, UnblacklistTagRequestSchema } from "../gen/tags_pb";
import { TagImageRequestSchema, TagImageResultSchema } from "../gen/tagging_pb";
import { html, SafeHtml, ComponentMeta } from "./_shared";
import { maskPath } from "./path-utils";
import { getTagPillHtml } from "./card-tags";
import { refreshCardTags } from "../views/tags";

let isModalWired = false;

export function renderTagEditorModalHtml(imageId: number, filepath: string): SafeHtml {
  return html`
    <div class="modal-header">
      <span class="modal-title">Manage Image Tags</span>
      <span class="modal-close" id="close-modal"><i class="bi bi-x-lg"></i></span>
    </div>
    <form id="tag-form">
      <div class="modal-body">
        <input type="hidden" id="tag-image-id" value="${imageId}" />
        <p style="font-size: 11px; color: #555555; word-break: break-all;" id="tag-image-path-preview">${maskPath(filepath)}</p>

        <div class="group-box" style="margin: 4px 0; padding: 12px 6px 6px 6px;">
          <div class="group-box-title">Active Tags</div>
          <div id="modal-tag-list">
            <!-- Active tags list -->
          </div>
        </div>

        <div class="group-box" id="modal-blacklisted-group" style="margin: 8px 0 4px 0; padding: 12px 6px 6px 6px; display: none;">
          <div class="group-box-title" style="color: #ef4444;"><i class="bi bi-slash-circle"></i> Blacklisted Tags (AI Exclusions)</div>
          <div id="modal-blacklisted-tag-list" style="display: flex; flex-wrap: wrap; gap: 4px; padding: 4px;">
            <!-- Blacklisted tags list -->
          </div>
        </div>

        <div class="form-group" style="margin-top: 8px;">
          <div class="input-wrapper" style="flex: 1;">
            <input class="input-field has-clear" id="tag-name-input" placeholder="Enter tag name (e.g. meme)..." required />
            <button type="button" class="input-clear-btn" tabindex="-1"><i class="bi bi-x-lg"></i></button>
          </div>
          <button type="submit" class="win-button">Add Tag</button>
        </div>

        <!-- AI Auto-Tagging Section -->
        <div style="border-top: 1px solid #d0d0d0; margin-top: 12px; padding-top: 10px;">
          <div style="font-size: 10px; font-weight: bold; color: #444; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;">
            <i class="bi bi-stars"></i> AUTO TAG
          </div>
          <div class="form-group">
            <select class="input-field" id="tagger-threshold-select" style="width: 155px; font-size: 11px;">
              <option value="0.5" selected>Balanced (0.50)</option>
              <option value="0.65">High Precision (0.65)</option>
              <option value="0.35">High Recall (0.35)</option>
            </select>
            <button type="button" class="win-button" id="auto-tag-modal-btn" style="font-size: 11px;">
              <i class="bi bi-stars"></i> AUTO TAG
            </button>
            <button type="button" class="win-button primary" id="teach-concept-from-modal-btn" style="font-size: 11px;">
              <i class="bi bi-magic"></i> Teach Concept
            </button>
          </div>
          <p id="auto-tag-modal-status" style="font-size: 11px; margin-top: 4px; color: #555555; min-height: 16px;"></p>
        </div>
      </div>
    </form>
  `;
}

function wireModalClearButton() {
  const input = document.getElementById("tag-name-input") as HTMLInputElement | null;
  if (!input || !input.classList.contains("has-clear")) return;
  const wrapper = input.closest(".input-wrapper");
  if (!wrapper) return;
  const clearBtn = wrapper.querySelector(".input-clear-btn") as HTMLButtonElement | null;
  if (!clearBtn) return;

  const updateClearVisibility = () => {
    if (input.value.length > 0) {
      wrapper.classList.add("has-value");
    } else {
      wrapper.classList.remove("has-value");
    }
  };

  input.addEventListener("input", updateClearVisibility);
  input.addEventListener("change", updateClearVisibility);
  clearBtn.addEventListener("click", () => {
    input.value = "";
    updateClearVisibility();
    input.focus();
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  updateClearVisibility();
}

function wireModalControls() {
  const tagForm = document.getElementById("tag-form");
  const tagImgId = document.getElementById("tag-image-id") as HTMLInputElement | null;
  const tagNameInput = document.getElementById("tag-name-input") as HTMLInputElement | null;

  tagForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!tagImgId || !tagNameInput) return;

    const imgId = parseInt(tagImgId.value);
    const tagName = tagNameInput.value.trim();

    try {
      await typedCall("TagsService.AddTag", AddTagRequestSchema, { imageId: BigInt(imgId), tag: tagName, category: "user" }, EmptySchema);
      tagNameInput.value = "";
      tagNameInput.dispatchEvent(new Event("change", { bubbles: true }));
      await refreshModalTags(imgId);
      await refreshCardTags(imgId);
    } catch (e) {
      showErrorAlert("IPC Tag failed:\n" + e);
    }
  });

  document.getElementById("auto-tag-modal-btn")?.addEventListener("click", handleModalAutoTag);

  document.getElementById("teach-concept-from-modal-btn")?.addEventListener("click", async () => {
    const idInput = document.getElementById("tag-image-id") as HTMLInputElement | null;
    if (idInput && idInput.value) {
      const { openTeachConceptModal } = await import("../views/concepts");
      openTeachConceptModal();
    }
  });

  document.getElementById("close-modal")?.addEventListener("click", () => {
    document.getElementById("add-tag-modal")?.classList.remove("active");
  });

  wireModalClearButton();
  isModalWired = true;
}

export async function openTagModal(imgId: number, path: string) {
  const modal = document.getElementById("add-tag-modal");
  const container = document.getElementById("add-tag-modal-container");

  if (container && !isModalWired) {
    container.innerHTML = String(renderTagEditorModalHtml(imgId, path));
    wireModalControls();
  } else if (container) {
    const idInput = document.getElementById("tag-image-id") as HTMLInputElement | null;
    const pathPreview = document.getElementById("tag-image-path-preview");
    if (idInput) idInput.value = imgId.toString();
    if (pathPreview) pathPreview.textContent = maskPath(path);
  }

  const statusArea = document.getElementById("auto-tag-modal-status");
  const autoTagBtn = document.getElementById("auto-tag-modal-btn");
  if (statusArea) statusArea.textContent = "";
  if (autoTagBtn) {
    autoTagBtn.innerHTML = '<i class="bi bi-stars"></i> AUTO TAG';
    autoTagBtn.style.backgroundColor = "";
  }

  await refreshModalTags(imgId);
  modal?.classList.add("active");
}

export async function refreshModalTags(imgId: number) {
  const container = document.getElementById("modal-tag-list");
  if (!container) {
    logJS("refreshModalTags error: #modal-tag-list element not found in DOM!");
    return;
  }

  try {
    logJS(`refreshModalTags calling GetImage for image_id=${imgId}...`);
    const resp = await typedCall("GalleryService.GetImage", GetImageRequestSchema, { imageId: BigInt(imgId) }, ImageResultSchema);
    logJS(`refreshModalTags GetImage response for image ${imgId}: ` + safeStringify(resp));

    const img = resp.image;
    if (!img || img.tags.length === 0) {
      container.innerHTML = '<span style="color: #999; font-style: italic; font-size: 11px;">No tags assigned yet</span>';
    } else {
      container.innerHTML = img.tags
        .map((tag) => getTagPillHtml(tagSummaryFromProto(tag), true, imgId))
        .join("");
    }

    const blacklistGroup = document.getElementById("modal-blacklisted-group");
    const blacklistContainer = document.getElementById("modal-blacklisted-tag-list");
    if (blacklistGroup && blacklistContainer) {
      if (img && img.blacklistedTags.length > 0) {
        blacklistGroup.style.display = "block";
        blacklistContainer.innerHTML = img.blacklistedTags
          .map((t) => `<span class="tag-pill tag-meta" style="background-color: rgba(239,68,68,0.15); border: 1px solid #ef4444; color: #ef4444;" title="Blacklisted negative sample — AI auto-tagging will skip this tag"><i class="bi bi-slash-circle"></i> ${t.tag.replace(/_/g, '_\u200B')} <i class="bi bi-arrow-counterclockwise" style="cursor: pointer; margin-left: 4px;" title="Restore (Un-blacklist)" data-action="unblacklist-tag" data-image-id="${imgId}" data-tag-name="${t.tag.replace(/'/g, "\\'")}"></i></span>`)
            .join("");
      } else {
        blacklistGroup.style.display = "none";
        blacklistContainer.innerHTML = "";
      }
    }

    logJS(`refreshModalTags rendered ${img ? img.tags.length : 0} active tags and ${img ? img.blacklistedTags.length : 0} blacklisted tags`);
  } catch (e: any) {
    logJS("refreshModalTags exception: " + (e.message || e));
    container.innerHTML = `<span style="color: #ef4444; font-size: 11px;">IPC Error: ${e.message || e}</span>`;
  }
}

export async function handleModalAutoTag() {
  const idInput = document.getElementById("tag-image-id") as HTMLInputElement | null;
  const thresholdSelect = document.getElementById("tagger-threshold-select") as HTMLSelectElement | null;
  const statusArea = document.getElementById("auto-tag-modal-status");
  const autoTagBtn = document.getElementById("auto-tag-modal-btn");

  if (!idInput || !statusArea || !thresholdSelect || !autoTagBtn) {
    logJS("handleModalAutoTag error: missing modal DOM elements!");
    return;
  }

  const imageId = parseInt(idInput.value);
  const threshold = parseFloat(thresholdSelect.value);

  if (isNaN(imageId) || imageId <= 0) {
    statusArea.textContent = "Error: Invalid Image ID";
    statusArea.style.color = "#ef4444";
    return;
  }

  statusArea.textContent = "AI Running inference (lazy loading model if first run)...";
  statusArea.style.color = "#fbbf24";

  try {
    logJS(`handleModalAutoTag calling TagImage for imageId=${imageId}, threshold=${threshold}`);
    const resp = await typedCall(
      "TaggingService.TagImage",
      TagImageRequestSchema,
      { imageId: BigInt(imageId), threshold, force: true },
      TagImageResultSchema
    );
    logJS(`handleModalAutoTag TagImage response: ` + safeStringify(resp));

    const { tagsApplied } = resp;
    statusArea.textContent = `Applied ${tagsApplied} tags successfully!`;
    statusArea.style.color = "#10b981";
    autoTagBtn.innerHTML = '<i class="bi bi-stars"></i> AUTO TAG';
    autoTagBtn.style.backgroundColor = "";

    await refreshModalTags(imageId);
    await refreshCardTags(imageId);
  } catch (e: any) {
    statusArea.textContent = `Error: ${e.message || e}`;
    statusArea.style.color = "#ef4444";
    autoTagBtn.innerHTML = '<i class="bi bi-stars"></i> AUTO TAG';
    autoTagBtn.style.backgroundColor = "";
  }
}

async function removeTag(imgId: number, tagName: string) {
  if (!confirm(`Are you sure you want to remove the tag "${tagName}"?`)) return;
  try {
    await typedCall("TagsService.RemoveTag", RemoveTagRequestSchema, { imageId: BigInt(imgId), tag: tagName }, EmptySchema);
    await refreshModalTags(imgId);
    await refreshCardTags(imgId);
  } catch (e: any) {
    showErrorAlert("Error calling tag removal:\n" + (e.message || e));
  }
}

export function setupTagEditorModal() {
  document.addEventListener("click", async (e) => {
    const target = e.target as HTMLElement;
    const actionEl = target.closest("[data-action]") as HTMLElement;
    if (!actionEl) return;

    const action = actionEl.dataset.action;
    if (action === "remove-tag") {
      const imgId = parseInt(actionEl.dataset.imageId || "");
      const tagName = actionEl.dataset.tagName || "";
      if (imgId && tagName) removeTag(imgId, tagName);
    } else if (action === "open-tags") {
      const imgId = parseInt(actionEl.dataset.imageId || "0");
      const fp = actionEl.dataset.filepath || "";
      if (imgId) openTagModal(imgId, fp);
    } else if (action === "unblacklist-tag") {
      const imgId = parseInt(actionEl.dataset.imageId || "0");
      const tagName = actionEl.dataset.tagName || "";
      if (imgId && tagName) {
        try {
          await typedCall("TagsService.UnblacklistTag", UnblacklistTagRequestSchema, { imageId: BigInt(imgId), tag: tagName }, EmptySchema);
          await refreshModalTags(imgId);
          await refreshCardTags(imgId);
        } catch (e: any) {
          showErrorAlert("Error un-blacklisting tag:\n" + (e.message || e));
        }
      }
    }
  });
}

export const meta: ComponentMeta = {
  name: "Tag Editor Modal",
  description: "Manage Image Tags overlay with active tag pills, blacklisted AI exclusions, custom tag input, and AI auto-tagging controls.",
  variants: [
    {
      name: "Active Tags",
      render: () =>
        html`<div style="display:flex;flex-direction:column;gap:8px;">
          <div class="group-box" style="margin: 4px 0; padding: 12px 6px 6px 6px;">
            <div class="group-box-title">Active Tags</div>
            <div id="modal-tag-list">
              ${getTagPillHtml({ tag: "sample_user_tag", category: "user" }, true, 1)}
              ${getTagPillHtml({ tag: "character_name", category: "character" }, true, 1)}
              ${getTagPillHtml({ tag: "series_copyright", category: "copyright" }, true, 1)}
            </div>
          </div>
        </div>`
    },
    {
      name: "Blacklisted Tags",
      render: () =>
        html`<div class="group-box" style="margin: 8px 0 4px 0; padding: 12px 6px 6px 6px;">
          <div class="group-box-title" style="color: #ef4444;"><i class="bi bi-slash-circle"></i> Blacklisted Tags (AI Exclusions)</div>
          <div style="display: flex; flex-wrap: wrap; gap: 4px; padding: 4px;">
            <span class="tag-pill tag-meta" style="background-color: rgba(239,68,68,0.15); border: 1px solid #ef4444; color: #ef4444;" title="Blacklisted negative sample — AI auto-tagging will skip this tag"><i class="bi bi-slash-circle"></i> lowres <i class="bi bi-arrow-counterclockwise" style="cursor: pointer; margin-left: 4px;" title="Restore (Un-blacklist)"></i></span>
            <span class="tag-pill tag-meta" style="background-color: rgba(239,68,68,0.15); border: 1px solid #ef4444; color: #ef4444;" title="Blacklisted negative sample — AI auto-tagging will skip this tag"><i class="bi bi-slash-circle"></i> blurry <i class="bi bi-arrow-counterclockwise" style="cursor: pointer; margin-left: 4px;" title="Restore (Un-blacklist)"></i></span>
          </div>
        </div>`
    },
    {
      name: "AI Auto-Tagged Controls",
      render: () =>
        html`<div class="form-group">
          <select class="input-field" id="tagger-threshold-select" style="width: 155px; font-size: 11px;">
            <option value="0.5" selected>Balanced (0.50)</option>
            <option value="0.65">High Precision (0.65)</option>
            <option value="0.35">High Recall (0.35)</option>
          </select>
          <button type="button" class="win-button" id="auto-tag-modal-btn" style="font-size: 11px;">
            <i class="bi bi-stars"></i> AUTO TAG
          </button>
          <button type="button" class="win-button primary" id="teach-concept-from-modal-btn" style="font-size: 11px;">
            <i class="bi bi-magic"></i> Teach Concept
          </button>
        </div>`
    }
  ]
};