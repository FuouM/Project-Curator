import { typedCall } from "../ipc";
import { logJS, safeStringify } from "../utils";
import { maskPath } from "../components";
import { getTagPillHtml, renderCardTagsContainerHtml } from "../components/card-tags";
import { showErrorAlert } from "../alert";
import { EmptySchema } from "@bufbuild/protobuf/wkt";
import { imageDetailsFromProto, tagSummaryFromProto } from "../proto-adapters";
import { GetImageRequestSchema, ImageResultSchema } from "../gen/gallery_pb";
import { AddTagRequestSchema, RemoveTagRequestSchema, UnblacklistTagRequestSchema } from "../gen/tags_pb";
import { TagImageRequestSchema, TagImageResultSchema } from "../gen/tagging_pb";

export async function openTagModal(imgId: number, path: string) {
  const modal = document.getElementById("add-tag-modal");
  const idInput = document.getElementById("tag-image-id") as HTMLInputElement;
  const pathPreview = document.getElementById("tag-image-path-preview");
  const statusArea = document.getElementById("auto-tag-modal-status");
  const autoTagBtn = document.getElementById("auto-tag-modal-btn");

  if (idInput) idInput.value = imgId.toString();
  if (pathPreview) pathPreview.textContent = maskPath(path);
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

export async function refreshCardTags(imgId: number) {
  try {
    const resp = await typedCall("GalleryService.GetImage", GetImageRequestSchema, { imageId: BigInt(imgId) }, ImageResultSchema);
    if (!resp.image) return;
    const img = imageDetailsFromProto(resp.image);
    const containerHtml = renderCardTagsContainerHtml(img);
    document.querySelectorAll(`[data-image-id="${imgId}"] .card-tags-container`).forEach((el) => {
      el.innerHTML = containerHtml;
    });
    const featuredCard = document.querySelector(`#featured-day-content [data-image-id="${imgId}"]`);
    if (featuredCard) {
      const featuredDetailsContainer = document.querySelector("#featured-day-content .featured-details .card-tags-container");
      if (featuredDetailsContainer) {
        featuredDetailsContainer.innerHTML = renderCardTagsContainerHtml(img, true);
      }
    }
  } catch (e) {
    console.error("Failed to refresh card tags:", e);
  }
}

export async function handleModalAutoTag() {
  const idInput = document.getElementById("tag-image-id") as HTMLInputElement;
  const thresholdSelect = document.getElementById("tagger-threshold-select") as HTMLSelectElement;
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

// --- Module-level tag handlers ---

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

// --- Delegation for tag actions ---

export function setupTags() {
  // Tag form submission
  const tagForm = document.getElementById("tag-form");
  const tagImgId = document.getElementById("tag-image-id") as HTMLInputElement;
  const tagNameInput = document.getElementById("tag-name-input") as HTMLInputElement;

  tagForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!tagImgId || !tagNameInput) return;

    const imgId = parseInt(tagImgId.value);
    const tagName = tagNameInput.value.trim();

    try {
      await typedCall("TagsService.AddTag", AddTagRequestSchema, { imageId: BigInt(imgId), tag: tagName, category: "user" }, EmptySchema);
      tagNameInput.value = "";
      tagNameInput.dispatchEvent(new Event('change', { bubbles: true }));
      await refreshModalTags(imgId);
      await refreshCardTags(imgId);
    } catch (e) {
      showErrorAlert("IPC Tag failed:\n" + e);
    }
  });

  // Auto-tag modal button
  document.getElementById("auto-tag-modal-btn")?.addEventListener("click", handleModalAutoTag);

  // Close modal
  document.getElementById("close-modal")?.addEventListener("click", () => {
    document.getElementById("add-tag-modal")?.classList.remove("active");
  });

  // Document-level delegation for tag actions
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
