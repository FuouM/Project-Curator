import { callService } from "../ipc";
import { logJS } from "../utils";
import { maskPath } from "../components";
import { renderTagListHtml, getTagPillHtml } from "../cards";

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
    autoTagBtn.innerHTML = '<i class="bi bi-stars"></i> Auto-Tag';
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
    const resp = await callService({ GetImage: { image_id: imgId } });
    logJS(`refreshModalTags GetImage response for image ${imgId}: ` + JSON.stringify(resp));

    if ("ImageResult" in resp) {
      const img = resp.ImageResult.image;
      if (!img.tags || img.tags.length === 0) {
        container.innerHTML = '<span style="color: #999; font-style: italic; font-size: 11px;">No tags assigned yet</span>';
      } else {
        container.innerHTML = img.tags
          .map((tag: any) => getTagPillHtml(tag, true, imgId))
          .join("");
      }

      const blacklistGroup = document.getElementById("modal-blacklisted-group");
      const blacklistContainer = document.getElementById("modal-blacklisted-tag-list");
      if (blacklistGroup && blacklistContainer) {
        if (img.blacklisted_tags && img.blacklisted_tags.length > 0) {
          blacklistGroup.style.display = "block";
          blacklistContainer.innerHTML = img.blacklisted_tags
            .map((t: any) => `<span class="tag-pill tag-meta" style="background-color: rgba(239,68,68,0.15); border: 1px solid #ef4444; color: #ef4444;" title="Blacklisted negative sample — AI auto-tagging will skip this tag"><i class="bi bi-slash-circle"></i> ${t.tag.replace(/_/g, '_\u200B')} <i class="bi bi-arrow-counterclockwise" style="cursor: pointer; margin-left: 4px;" title="Restore (Un-blacklist)" data-action="unblacklist-tag" data-image-id="${imgId}" data-tag-name="${t.tag.replace(/'/g, "\\'")}"></i></span>`)
            .join("");
        } else {
          blacklistGroup.style.display = "none";
          blacklistContainer.innerHTML = "";
        }
      }

      logJS(`refreshModalTags rendered ${img.tags ? img.tags.length : 0} active tags and ${img.blacklisted_tags ? img.blacklisted_tags.length : 0} blacklisted tags`);
    } else if ("Error" in resp) {
      container.innerHTML = `<span style="color: #ef4444; font-size: 11px;">Error: ${resp.Error.message}</span>`;
    }
  } catch (e: any) {
    logJS("refreshModalTags exception: " + (e.message || e));
    container.innerHTML = `<span style="color: #ef4444; font-size: 11px;">IPC Error: ${e.message || e}</span>`;
  }
}

export async function refreshCardTags(imgId: number) {
  try {
    const resp = await callService({ GetImage: { image_id: imgId } });
    if (!("ImageResult" in resp)) return;
    const tags = resp.ImageResult.image.tags;
    const tagHtml = renderTagListHtml(tags);
    document.querySelectorAll(`[data-image-id="${imgId}"] .tag-list`).forEach((el) => {
      el.innerHTML = tagHtml;
    });
    const featuredCard = document.querySelector(`#featured-day-content [data-image-id="${imgId}"]`);
    if (featuredCard) {
      const featuredTagList = document.querySelector("#featured-day-content .featured-details .tag-list");
      if (featuredTagList) {
        featuredTagList.innerHTML = tags.map((t: any) => getTagPillHtml(t)).join("");
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
    const resp = await callService({ TagImage: { image_id: imageId, threshold, force: true } });
    logJS(`handleModalAutoTag TagImage response: ` + JSON.stringify(resp));

    if ("TagImageResult" in resp) {
      const { tags_applied } = resp.TagImageResult;
      statusArea.textContent = `Applied ${tags_applied} tags successfully!`;
      statusArea.style.color = "#10b981";
      autoTagBtn.innerHTML = '<i class="bi bi-stars"></i> Auto-Tag';
      autoTagBtn.style.backgroundColor = "";

      await refreshModalTags(imageId);
      await refreshCardTags(imageId);
    } else if ("Error" in resp) {
      statusArea.textContent = `Failed: ${resp.Error.message}`;
      statusArea.style.color = "#ef4444";
      autoTagBtn.innerHTML = '<i class="bi bi-stars"></i> Auto-Tag';
      autoTagBtn.style.backgroundColor = "";
    }
  } catch (e: any) {
    statusArea.textContent = `Error: ${e.message || e}`;
    statusArea.style.color = "#ef4444";
    autoTagBtn.innerHTML = '<i class="bi bi-stars"></i> Auto-Tag';
    autoTagBtn.style.backgroundColor = "";
  }
}

// --- Module-level tag handlers ---

async function removeTag(imgId: number, tagName: string) {
  if (!confirm(`Are you sure you want to remove the tag "${tagName}"?`)) return;
  try {
    const resp = await callService({ RemoveTag: { image_id: imgId, tag: tagName } });
    if ("Success" in resp) {
      await refreshModalTags(imgId);
      await refreshCardTags(imgId);
    } else if ("Error" in resp) {
      alert("Failed to remove tag: " + resp.Error.message);
    }
  } catch (e: any) {
    alert("Error calling tag removal: " + e.message);
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
      const resp = await callService({
        AddTag: { image_id: imgId, tag: tagName, category: "user" }
      });

      if ("Success" in resp) {
        tagNameInput.value = "";
        tagNameInput.dispatchEvent(new Event('change', { bubbles: true }));
        await refreshModalTags(imgId);
        await refreshCardTags(imgId);
      } else if ("Error" in resp) {
        alert("Failed to add tag: " + resp.Error.message);
      }
    } catch (e) {
      alert("IPC Tag failed: " + e);
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
          const resp = await callService({ UnblacklistTag: { image_id: imgId, tag: tagName } });
          if ("Success" in resp) {
            await refreshModalTags(imgId);
            await refreshCardTags(imgId);
          } else if ("Error" in resp) {
            alert("Failed to un-blacklist tag: " + resp.Error.message);
          }
        } catch (e: any) {
          alert("Error un-blacklisting tag: " + e.message);
        }
      }
    }
  });
}
