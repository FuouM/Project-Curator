import { callService } from "../ipc";
import { SafeHtml, html } from "../components";
import { CharacterIdentity, CharacterDetection } from "../types";
import { getCachedCrop, setCachedCrop } from "../cards";
import { openImageViewer } from "../image-viewer";
import { attachAutocomplete } from "../autocomplete";
import { showErrorAlert, showInfoAlert } from "../alert";

interface SuggestionItem {
  name: string;
  count: number;
  source: "tag" | "identity" | "concept";
}



function isPlaceholderName(name: string): boolean {
  return /^Character \d+$/i.test(name.trim());
}

function compareIdentities(a: { name: string }, b: { name: string }): number {
  const aIsPlaceholder = isPlaceholderName(a.name);
  const bIsPlaceholder = isPlaceholderName(b.name);

  if (aIsPlaceholder && !bIsPlaceholder) {
    return 1;
  }
  if (!aIsPlaceholder && bIsPlaceholder) {
    return -1;
  }

  if (aIsPlaceholder && bIsPlaceholder) {
    const aNum = parseInt(a.name.replace(/\D/g, ""), 10) || 0;
    const bNum = parseInt(b.name.replace(/\D/g, ""), 10) || 0;
    return aNum - bNum;
  }

  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

// Fetch suggestions matching the query text dynamically from the database
const IDENTITY_CONCEPT_CACHE_TTL = 30000;
let identityConceptCache: {
  identities: CharacterIdentity[];
  concepts: any[];
  ts: number;
} | null = null;

export async function getSuggestions(query: string): Promise<SuggestionItem[]> {
  const items: SuggestionItem[] = [];
  const seen = new Set<string>();
  const q = query.toLowerCase();

  try {
    const tagResp = await callService({ GetCharacterSuggestions: { query: query } }).catch(
      () => null
    );

    let identities: CharacterIdentity[] = [];
    let concepts: any[] = [];
    if (identityConceptCache && Date.now() - identityConceptCache.ts < IDENTITY_CONCEPT_CACHE_TTL) {
      identities = identityConceptCache.identities;
      concepts = identityConceptCache.concepts;
    } else {
      const [idResp, conceptResp] = await Promise.all([
        callService({ ListCharacterIdentities: null }).catch(() => null),
        callService({ ListConcepts: null }).catch(() => null)
      ]);
      identities = (idResp && "CharacterIdentitiesList" in idResp)
        ? idResp.CharacterIdentitiesList.identities
        : [];
      concepts = (conceptResp && "ConceptListResult" in conceptResp)
        ? conceptResp.ConceptListResult.concepts
        : [];
      identityConceptCache = { identities, concepts, ts: Date.now() };
    }

    if (tagResp && "TagStatisticsResult" in tagResp) {
      const tags = tagResp.TagStatisticsResult.tags;
      const len = tags.length;
      for (let i = 0; i < len; i++) {
        const t = tags[i];
        if (!seen.has(t.tag)) {
          seen.add(t.tag);
          items.push({ name: t.tag, count: t.count, source: "tag" });
        }
      }
    }

    const idLen = identities.length;
    for (let i = 0; i < idLen; i++) {
      const identity = identities[i];
      if (identity.name.toLowerCase().includes(q) && !seen.has(identity.name)) {
        seen.add(identity.name);
        items.push({ name: identity.name, count: identity.detection_count, source: "identity" });
      }
    }

    const conceptLen = concepts.length;
    for (let i = 0; i < conceptLen; i++) {
      const concept = concepts[i];
      if (concept.name.toLowerCase().includes(q) && !seen.has(concept.name)) {
        seen.add(concept.name);
        items.push({ name: concept.name, count: concept.sample_count, source: "concept" });
      }
    }
  } catch (_) {}

  return items.sort((a, b) => {
    const aIsPlaceholder = isPlaceholderName(a.name);
    const bIsPlaceholder = isPlaceholderName(b.name);

    if (aIsPlaceholder && !bIsPlaceholder) return 1;
    if (!aIsPlaceholder && bIsPlaceholder) return -1;

    return b.count - a.count;
  });
}

export function attachIdentityAutocomplete(
  input: HTMLInputElement,
  dropdownId: string,
  onSelect: (value: string) => void
) {
  attachAutocomplete({
    input,
    dropdownId,
    onSelect,
    fetchItems: async (query) => {
      const suggestions = await getSuggestions(query);
      return suggestions.map((s) => ({ name: s.name, count: s.count }));
    },
  });
}

// Coalesces per-thumbnail GetDetectionCrop calls into a single batch IPC
// round-trip. Elements needing the same detection id share one fetch result.
const pendingCropElements = new Map<number, HTMLElement[]>();
let cropFlushTimer: number | null = null;

function setCropImage(el: HTMLElement, url: string) {
  el.classList.remove("skeleton-pulse");
  const existingImg = el.querySelector("img");
  if (existingImg) {
    existingImg.src = url;
  } else {
    const icon = el.querySelector(".bi-image");
    if (icon) icon.remove();

    const img = document.createElement("img");
    img.src = url;
    img.style.cssText = "width:100%;height:100%;object-fit:cover;border-radius:2px;";
    el.prepend(img);
  }
}

function enqueueCropLoad(el: HTMLElement, detectionId: number) {
  let els = pendingCropElements.get(detectionId);
  if (!els) {
    els = [];
    pendingCropElements.set(detectionId, els);
  }
  els.push(el);
  if (cropFlushTimer === null) {
    cropFlushTimer = window.setTimeout(() => { flushCropQueue(); }, 0);
  }
}

async function flushCropQueue() {
  cropFlushTimer = null;
  if (pendingCropElements.size === 0) return;

  const batch = Array.from(pendingCropElements.entries());
  pendingCropElements.clear();
  const ids = batch.map(([id]) => id);

  try {
    const resp = await callService({ GetDetectionCrops: { detection_ids: ids, max_size: 96 } });
    if ("DetectionCropsResult" in resp) {
      const byId = new Map<number, number[]>(resp.DetectionCropsResult.crops.map((c: any) => [c.detection_id, c.crop_webp_bytes]));
      for (const [id, els] of batch) {
        const bytes = byId.get(id);
        if (!bytes) {
          for (const el of els) el.classList.remove("skeleton-pulse");
          continue;
        }
        const blob = new Blob([new Uint8Array(bytes)], { type: "image/webp" });
        const url = URL.createObjectURL(blob);
        setCachedCrop(id, url);
        for (const el of els) setCropImage(el, url);
      }
    } else {
      for (const [, els] of batch) for (const el of els) el.classList.remove("skeleton-pulse");
    }
  } catch {
    for (const [, els] of batch) for (const el of els) el.classList.remove("skeleton-pulse");
  }
}

function loadCropForElement(el: HTMLElement, detectionId: number) {
  el.classList.add("skeleton-pulse");
  const cachedUrl = getCachedCrop(detectionId);
  if (cachedUrl) {
    setCropImage(el, cachedUrl);
    return;
  }
  enqueueCropLoad(el, detectionId);
}

export function setupCharactersView() {
  document.getElementById("create-identity-btn")?.addEventListener("click", async () => {
    const name = prompt("Character name (leave empty for auto-naming):");
    try {
      await callService({ CreateCharacterIdentity: { name: name || null } });
      await refreshCharacters();
    } catch (e: any) {
      console.error("Failed to create identity:", e);
    }
  });

  document.getElementById("refresh-identities-btn")?.addEventListener("click", async () => {
    await refreshCharacters();
  });

  document.getElementById("reidentify-all-btn")?.addEventListener("click", async () => {
    const btn = document.getElementById("reidentify-all-btn") as HTMLButtonElement;
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Reidentifying...';
    }
    try {
      const resp = await callService({ ReidentifyAllDetections: null });
      if ("ReidentifyResult" in resp) {
        const r = resp.ReidentifyResult;
        showInfoAlert(`Re-identification complete: ${r.matched} matched, ${r.unmatched} unmatched out of ${r.total_detections} total.`);
      }
      await refreshCharacters();
    } catch (e: any) {
      console.error("Re-identification failed:", e);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-arrow-clockwise"></i> Reidentify All';
      }
    }
  });
}

export async function refreshCharacters(focusedIdentityId?: number) {
  const container = document.getElementById("characters-list-container");
  if (!container) return;

  const mainPanel = document.querySelector(".main-panel");
  const savedScrollTop = mainPanel ? mainPanel.scrollTop : 0;

  // Render initial card layout skeletons/placeholders to keep the tab immediate and responsive
  container.innerHTML = `
    <div class="concept-card group-box skeleton-loader" style="opacity: 0.6; pointer-events: none;">
      <div class="concept-card-title"><i class="bi bi-hourglass-split"></i> Loading identities...</div>
      <div class="concept-card-body">
        <div class="identity-sample-crops" style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; margin-top: 6px;">
          <div style="aspect-ratio: 1/1; width: 100%; background:#f8f9fa; border:1px dashed #ced4da; border-radius:2px;"></div>
          <div style="aspect-ratio: 1/1; width: 100%; background:#f8f9fa; border:1px dashed #ced4da; border-radius:2px;"></div>
        </div>
      </div>
    </div>
  `;

  try {
    const [identitiesResp, unassignedResp] = await Promise.all([
      callService({ ListCharacterIdentities: null }),
      callService({ ListUnassignedDetections: null }),
    ]);

    const identities: CharacterIdentity[] =
      "CharacterIdentitiesList" in identitiesResp ? identitiesResp.CharacterIdentitiesList.identities : [];
    const unassigned: CharacterDetection[] =
      "UnassignedDetectionsList" in unassignedResp ? unassignedResp.UnassignedDetectionsList.detections : [];

    // Sort identities alphabetically, keeping placeholders at the bottom
    identities.sort(compareIdentities);

    container.innerHTML = "";

    // Unassigned detections section
    if (unassigned.length > 0) {
      const section = document.createElement("div");
      section.className = "group-box";
      section.style.borderLeft = "3px solid #ffc107";
      section.innerHTML = `
        <div class="group-box-title">
          <i class="bi bi-exclamation-triangle" style="color:#856404;"></i>
          Unassigned Detections
          <span class="concept-badge" style="background:#fff3cd;color:#856404;border:1px solid #ffc107;margin-left:8px;">${unassigned.length}</span>
        </div>
        <div class="group-box-body" id="unassigned-detections-list" style="display:flex;flex-direction:column;gap:6px;"></div>
      `;
      container.appendChild(section);

      const listEl = section.querySelector("#unassigned-detections-list") as HTMLElement;
      for (const det of unassigned) {
        renderUnassignedDetection(listEl, det, identities);
      }
    }

    // Identity cards
    if (identities.length === 0 && unassigned.length === 0) {
      container.innerHTML = '<p style="color:#64748b;font-style:italic;">No character identities yet. Use "Detect Characters" on an image to start.</p>';
      return;
    }

    for (const identity of identities) {
      const card = document.createElement("div");
      card.className = "concept-card group-box";
      card.setAttribute("data-card-id", String(identity.id));
      const dropdownId = `identity-ac-${identity.id}`;
      card.innerHTML = `
        <div class="concept-card-title">
          <i class="bi bi-bounding-box"></i>
          <div style="position:relative;display:inline-block;">
            <input class="identity-name-input" data-id="${identity.id}" value="${identity.name}" style="cursor:text;padding:1px 4px;border:1px solid transparent;border-radius:2px;font-size:inherit;font-weight:inherit;font-family:inherit;color:inherit;background:transparent;width:150px;" autocomplete="off" />
            <div id="${dropdownId}" class="autocomplete-dropdown" style="display:none;"></div>
          </div>
          <span class="concept-badge tag-character">${identity.detection_count} detections</span>
        </div>
        <div class="concept-card-body">
          <div class="concept-info-row" style="font-size:11px;color:#666;">
            Created: ${identity.created_at || "—"}
          </div>
          <div class="identity-sample-crops" style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; max-height: 180px; overflow-y: auto; margin-top: 6px; padding-right: 4px;" data-identity-id="${identity.id}">
            <!-- Instantly display placeholder thumbnail boxes to prevent layout shift and show outlines -->
            ${Array.from({ length: Math.min(10, identity.detection_count) }).map(() => `
              <div class="crop-placeholder-slot" style="aspect-ratio: 1/1; width: 100%; background:#f8f9fa; border:1px dashed #ced4da; display:flex; align-items:center; justify-content:center; border-radius:2px;">
                <i class="bi bi-image" style="color:#adb5bd;font-size:16px;"></i>
              </div>
            `).join("")}
          </div>
          <div class="concept-card-actions" style="margin-top:8px;display:flex;gap:6px;">
            <button class="win-button find-all-btn" data-id="${identity.id}" style="font-size:11px;">
              <i class="bi bi-search"></i> Find All
            </button>
            <button class="win-button danger delete-identity-btn" data-id="${identity.id}" data-name="${identity.name}" style="font-size:11px;">
              <i class="bi bi-trash"></i> Delete
            </button>
          </div>
        </div>
      `;
      container.appendChild(card);

      const nameInput = card.querySelector(".identity-name-input") as HTMLInputElement;
      attachIdentityAutocomplete(nameInput, dropdownId, async (newName) => {
        if (newName !== identity.name) {
          await callService({ RenameCharacterIdentity: { identity_id: identity.id, name: newName } });
          await refreshCharacters(identity.id);
        }
      });
      nameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          nameInput.blur();
        }
      });

      // Load sample crop thumbnails dynamically after cards are rendered
      const idVal = identity.id;
      setTimeout(() => {
        loadIdentitySampleCrops(card, idVal);
      }, 50);

      // Find All
      card.querySelector(".find-all-btn")?.addEventListener("click", async () => {
        try {
          const searchResp = await callService({ SearchByCharacter: { identity_id: identity.id } });
          if ("CharacterSearchResult" in searchResp) {
            const imageIds = searchResp.CharacterSearchResult.image_ids;
            showInfoAlert(`Found ${imageIds.length} images containing "${identity.name}".`);
          }
        } catch (e: any) {
          console.error("Search by character failed:", e);
        }
      });

      // Delete
      card.querySelector(".delete-identity-btn")?.addEventListener("click", async () => {
        if (!confirm(`Delete identity "${identity.name}"? Detections will become unassigned.`)) return;
        try {
          await callService({ DeleteCharacterIdentity: { identity_id: identity.id } });
          await refreshCharacters();
        } catch (e: any) {
          console.error("Delete identity failed:", e);
        }
      });
    }
  } catch (e) {
    console.error("Failed to load identities:", e);
    container.innerHTML = '<p style="color:#64748b;font-style:italic;">Failed to load identities.</p>';
  } finally {
    // Restore scroll position or scroll focused card into view
    if (focusedIdentityId !== undefined) {
      const targetCard = container.querySelector(`[data-card-id="${focusedIdentityId}"]`);
      if (targetCard) {
        targetCard.scrollIntoView({ block: "center", behavior: "smooth" });
      } else if (mainPanel) {
        mainPanel.scrollTop = savedScrollTop;
      }
    } else if (mainPanel) {
      mainPanel.scrollTop = savedScrollTop;
    }
  }
}

async function loadIdentitySampleCrops(card: HTMLElement, identityId: number) {
  const cropsContainer = card.querySelector(".identity-sample-crops") as HTMLElement;
  if (!cropsContainer) return;

  try {
    const resp = await callService({ SearchByCharacter: { identity_id: identityId } });
    if (!("CharacterSearchResult" in resp)) return;
    const imageIds = resp.CharacterSearchResult.image_ids;
    if (imageIds.length === 0) return;

    // Execute fetches in parallel to keep database operations real-time
    const candidateImageIds = imageIds.slice(0, 100);
    const results = await Promise.all(
      candidateImageIds.map((imgId: number) => 
        callService({ GetCharacterDetections: { image_id: imgId } })
          .then(detResp => {
            if ("CharacterDetectionsResult" in detResp) {
              return detResp.CharacterDetectionsResult.detections.filter(
                (d: CharacterDetection) => d.identity_id === identityId
              );
            }
            return [];
          })
          .catch(() => [])
      )
    );

    const matchingDets: CharacterDetection[] = [];
    for (const dets of results) {
      for (const d of dets) {
        matchingDets.push(d);
      }
    }

    if (matchingDets.length > 0) {
      cropsContainer.innerHTML = "";
      for (const det of matchingDets) {
        const thumb = document.createElement("div");
        thumb.style.cssText = "position:relative;aspect-ratio:1/1;width:100%;background:#f0f0f0;border:1px solid #ccc;display:flex;align-items:center;justify-content:center;border-radius:2px;";
        thumb.innerHTML = '<i class="bi bi-image" style="color:#999;font-size:16px;"></i>';

        // Unassign button (top-left) with a minus symbol
        const unassignBtn = document.createElement("span");
        unassignBtn.className = "unassign-crop-btn";
        unassignBtn.style.cssText = "position:absolute;top:2px;left:2px;width:16px;height:16px;background:rgba(231,76,60,0.85);color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;cursor:pointer;z-index:5;";
        unassignBtn.innerHTML = '<i class="bi bi-dash"></i>';
        unassignBtn.title = "Unassign detection";
        unassignBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const isLastSample = imageIds.length === 1;
          const confirmMsg = isLastSample
            ? "This is the last sample of this character identity. Unassigning it will automatically delete the identity. Do you want to proceed?"
            : "Are you sure you want to unassign this sample from this character identity?";
          if (!confirm(confirmMsg)) return;
          try {
            await callService({ AssignCharacterIdentity: { detection_id: det.id, identity_id: null } });
            await refreshCharacters();
          } catch (err: any) {
            showErrorAlert("Failed to unassign sample:\n" + err.message);
          }
        });
        thumb.appendChild(unassignBtn);

        // Open original image button (bottom-left)
        const openImgBtn = document.createElement("span");
        openImgBtn.className = "open-image-btn";
        openImgBtn.style.cssText = "position:absolute;bottom:2px;left:2px;width:16px;height:16px;background:rgba(52,152,219,0.85);color:#fff;border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:9px;cursor:pointer;z-index:5;";
        openImgBtn.innerHTML = '<i class="bi bi-image"></i>';
        openImgBtn.title = "Open original image";
        openImgBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          try {
            const imgResp = await callService({ GetImage: { image_id: det.image_id } });
            if ("ImageResult" in imgResp) {
              const fp = imgResp.ImageResult.image.current_filepath;
              openImageViewer(fp, det.image_id);
            }
          } catch (err: any) {
            showErrorAlert("Failed to open image:\n" + err.message);
          }
        });
        thumb.appendChild(openImgBtn);

        // Edit bounding box button (bottom-right)
        const editBtn = document.createElement("span");
        editBtn.className = "edit-crop-btn";
        editBtn.style.cssText = "position:absolute;bottom:2px;right:2px;width:16px;height:16px;background:rgba(0,0,0,0.65);color:#fff;border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:9px;cursor:pointer;z-index:5;";
        editBtn.innerHTML = '<i class="bi bi-bounding-box"></i>';
        editBtn.title = "Edit bounding box";
        editBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          try {
            const imgResp = await callService({ GetImage: { image_id: det.image_id } });
            if ("ImageResult" in imgResp) {
              const fp = imgResp.ImageResult.image.current_filepath;
              import("../bbox-editor").then(m => {
                m.openBBoxEditor(det.id, det.image_id, fp, det.x0, det.y0, det.x1, det.y1, () => {
                  import("../cards").then(cards => cards.invalidateCropCache(det.id));
                  refreshCharacters();
                });
              });
            }
          } catch (err: any) {
            showErrorAlert("Failed to open bounding box editor:\n" + err.message);
          }
        });
        thumb.appendChild(editBtn);

        cropsContainer.appendChild(thumb);
        loadCropForElement(thumb, det.id);
      }
    } else {
      cropsContainer.innerHTML = "";
    }
  } catch (_) {
    cropsContainer.innerHTML = "";
  }
}

function renderUnassignedDetection(
  container: HTMLElement,
  det: CharacterDetection,
  identities: CharacterIdentity[]
) {
  const row = document.createElement("div");
  row.style.cssText = "display:flex;align-items:center;gap:8px;padding:4px 6px;border:1px solid var(--sys-border-light,#d0d0d0);border-radius:2px;background:var(--sys-window-bg,#fff);font-size:11px;";

  // Crop thumbnail
  const cropThumb = document.createElement("div");
  cropThumb.style.cssText = "width:48px;height:48px;background:#f0f0f0;border:1px solid #ccc;display:flex;align-items:center;justify-content:center;flex-shrink:0;";
  cropThumb.innerHTML = '<i class="bi bi-image" style="color:#999;"></i>';
  loadCropForElement(cropThumb, det.id);

  // Info + identity inputs
  const infoEl = document.createElement("div");
  infoEl.style.cssText = "flex:1;min-width:0;";
  const dropdownId = `assign-ac-${det.id}`;
  infoEl.innerHTML = `
    <div style="display:flex;align-items:center;gap:6px;">
      <span style="color:#888;">Image #${det.image_id}</span>
      <span style="color:#888;">(${(det.confidence * 100).toFixed(1)}%)</span>
    </div>
    <div style="display:flex;align-items:center;gap:4px;margin-top:2px;position:relative;">
      <input class="assign-identity-input" placeholder="Type character name..." style="font-size:10px;padding:2px 6px;width:150px;border:1px solid var(--sys-border-light,#d0d0d0);border-radius:2px;" autocomplete="off" />
      <div id="${dropdownId}" class="autocomplete-dropdown" style="display:none;z-index:10;"></div>
      <span style="font-size:10px;color:#999;margin:0 4px;">or</span>
      <select class="win-select detection-identity-select" data-detection-id="${det.id}" style="font-size:10px;padding:1px 4px;max-width:150px;">
        <option value="">Choose existing...</option>
        ${identities.map((i) => `<option value="${i.id}">${i.name}</option>`).join("")}
      </select>
    </div>
  `;

  // Delete button
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "win-button danger";
  deleteBtn.style.cssText = "font-size:10px;padding:2px 6px;";
  deleteBtn.innerHTML = '<i class="bi bi-trash"></i>';
  deleteBtn.addEventListener("click", async () => {
    await callService({ DeleteDetection: { detection_id: det.id } });
    await refreshCharacters();
  });

  // Autocomplete assignment handler
  const assignInput = infoEl.querySelector(".assign-identity-input") as HTMLInputElement;
  
  const handleAssign = async (targetName: string) => {
    const name = targetName.trim();
    if (!name) return;
    const existing = identities.find(i => i.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      await callService({ AssignCharacterIdentity: { detection_id: det.id, identity_id: existing.id } });
    } else {
      const createResp = await callService({ CreateCharacterIdentity: { name } });
      if (createResp && "CharacterIdentitiesList" in createResp) {
        const newId = createResp.CharacterIdentitiesList.identities[0].id;
        await callService({ AssignCharacterIdentity: { detection_id: det.id, identity_id: newId } });
      }
    }
    await refreshCharacters();
  };

  attachAutocomplete({
    input: assignInput,
    dropdownId,
    onSelect: async (selectedName) => {
      await handleAssign(selectedName);
    },
    fetchItems: async (query) => {
      const suggestions = await getSuggestions(query);
      return suggestions.map((s) => ({ name: s.name, count: s.count }));
    }
  });

  assignInput.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      assignInput.blur();
    }
  });

  let blurTimeout: any = null;
  assignInput.addEventListener("focus", () => {
    if (blurTimeout) clearTimeout(blurTimeout);
  });

  assignInput.addEventListener("blur", () => {
    // Timeout to allow dropdown items to be clicked first
    blurTimeout = setTimeout(async () => {
      await handleAssign(assignInput.value);
    }, 250);
  });

  // Select dropdown assignment handler
  const select = infoEl.querySelector(".detection-identity-select") as HTMLSelectElement;
  select?.addEventListener("change", async () => {
    const val = select.value;
    const identityId = val ? parseInt(val, 10) : null;
    await callService({ AssignCharacterIdentity: { detection_id: det.id, identity_id: identityId } });
    await refreshCharacters();
  });

  row.appendChild(cropThumb);
  row.appendChild(infoEl);
  row.appendChild(deleteBtn);
  container.appendChild(row);
}

// ---------------------------------------------------------------------------
// HTML Template
// ---------------------------------------------------------------------------

export function renderCharactersHtml(): SafeHtml {
  return html`
    <div class="group-box">
      <div class="group-box-title"><i class="bi bi-bounding-box"></i> Character Identities</div>
      <div style="margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center;">
        <p style="margin: 0; font-size: 12px; color: var(--sys-text-subtle);">
          Manage auto-discovered character identities from YOLO + CCIP detection.
        </p>
        <div style="display: flex; gap: 8px;">
          <button type="button" class="win-button" id="refresh-identities-btn" title="Refresh identities list">
            <i class="bi bi-arrow-clockwise"></i> Refresh
          </button>
          <button type="button" class="win-button" id="reidentify-all-btn" title="Re-identify all detections against current identities">
            <i class="bi bi-arrow-clockwise"></i> Reidentify All
          </button>
          <button type="button" class="win-button primary" id="create-identity-btn">
            <i class="bi bi-plus-lg"></i> New Identity
          </button>
        </div>
      </div>
      <div id="characters-list-container" class="concepts-grid"></div>
    </div>
  `;
}
