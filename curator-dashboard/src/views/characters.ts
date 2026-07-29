import { callService } from "../ipc";
import { CharacterIdentity, CharacterDetection } from "../types";

interface SuggestionItem {
  name: string;
  count: number;
  source: "tag" | "identity" | "concept";
}

let cachedSuggestions: SuggestionItem[] | null = null;

async function loadSuggestions(): Promise<SuggestionItem[]> {
  if (cachedSuggestions) return cachedSuggestions;
  const items: SuggestionItem[] = [];
  const seen = new Set<string>();

  // Character tags from tags table
  try {
    const tagResp = await callService({ GetTagStatistics: null });
    if ("TagStatisticsResult" in tagResp) {
      for (const t of tagResp.TagStatisticsResult.tags) {
        if (t.category === "character" && !seen.has(t.tag)) {
          seen.add(t.tag);
          items.push({ name: t.tag, count: t.count, source: "tag" });
        }
      }
    }
  } catch (_) {}

  // Existing identity names
  try {
    const idResp = await callService({ ListCharacterIdentities: null });
    if ("CharacterIdentitiesList" in idResp) {
      for (const i of idResp.CharacterIdentitiesList.identities) {
        if (!seen.has(i.name)) {
          seen.add(i.name);
          items.push({ name: i.name, count: i.detection_count, source: "identity" });
        }
      }
    }
  } catch (_) {}

  // Custom concept names
  try {
    const conceptResp = await callService({ ListConcepts: null });
    if ("ConceptListResult" in conceptResp) {
      for (const c of conceptResp.ConceptListResult.concepts) {
        if (!seen.has(c.name)) {
          seen.add(c.name);
          items.push({ name: c.name, count: c.sample_count, source: "concept" });
        }
      }
    }
  } catch (_) {}

  cachedSuggestions = items.sort((a, b) => b.count - a.count);
  return cachedSuggestions;
}

export function invalidateSuggestions() {
  cachedSuggestions = null;
}

export function attachAutocomplete(
  input: HTMLInputElement,
  dropdownId: string,
  onSelect: (value: string) => void
) {
  const dropdown = document.getElementById(dropdownId);
  if (!dropdown) return;

  let activeIndex = -1;

  function showDropdown(query: string) {
    if (!dropdown || !query) {
      if (dropdown) dropdown.style.display = "none";
      return;
    }

    const q = query.toLowerCase();
    loadSuggestions().then((allItems) => {
      if (!dropdown) return;
      const matches = allItems
        .filter(s => s.name.toLowerCase().includes(q) && s.name !== input.value)
        .slice(0, 15);

      if (matches.length === 0) {
        dropdown.style.display = "none";
        return;
      }

      activeIndex = -1;
      dropdown.innerHTML = matches.map((s, i) =>
        `<div class="autocomplete-item" data-name="${s.name}" data-index="${i}">
          <span class="autocomplete-item-tag">${s.name}</span>
          <span class="autocomplete-item-count">${s.count}</span>
        </div>`
      ).join("");
      dropdown.style.display = "block";

      dropdown.querySelectorAll<HTMLElement>(".autocomplete-item").forEach((item) => {
        item.addEventListener("mousedown", (e) => {
          e.preventDefault();
          const selectedName = item.getAttribute("data-name") || "";
          input.value = selectedName;
          if (dropdown) dropdown.style.display = "none";
          onSelect(selectedName);
        });
      });
    });
  }

  function setActive(index: number) {
    if (!dropdown) return;
    const items = dropdown.querySelectorAll<HTMLElement>(".autocomplete-item");
    items.forEach((el, i) => el.classList.toggle("active", i === index));
  }

  input.addEventListener("input", () => {
    showDropdown(input.value.trim());
  });

  input.addEventListener("focus", () => {
    if (input.value.trim()) showDropdown(input.value.trim());
  });

  input.addEventListener("blur", () => {
    setTimeout(() => { if (dropdown) dropdown.style.display = "none"; }, 150);
  });

  input.addEventListener("keydown", (e) => {
    if (!dropdown) return;
    const items = dropdown.querySelectorAll<HTMLElement>(".autocomplete-item");
    if (dropdown.style.display === "none" || items.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, items.length - 1);
      setActive(activeIndex);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      setActive(activeIndex);
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      const selectedName = items[activeIndex].getAttribute("data-name") || "";
      input.value = selectedName;
      dropdown.style.display = "none";
      onSelect(selectedName);
    } else if (e.key === "Escape") {
      dropdown.style.display = "none";
    }
  });
}

function loadCropForElement(el: HTMLElement, detectionId: number) {
  callService({ GetDetectionCrop: { detection_id: detectionId, max_size: 96 } }).then((cropResp: any) => {
    if ("DetectionCropResult" in cropResp) {
      const bytes = new Uint8Array(cropResp.DetectionCropResult.crop_webp_bytes);
      const blob = new Blob([bytes], { type: "image/webp" });
      const url = URL.createObjectURL(blob);
      el.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover;" />`;
    }
  }).catch(() => {});
}

export function setupCharactersView() {
  document.getElementById("create-identity-btn")?.addEventListener("click", async () => {
    const name = prompt("Character name (leave empty for auto-naming):");
    try {
      await callService({ CreateCharacterIdentity: { name: name || null } });
      invalidateSuggestions();
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
        alert(`Re-identification complete: ${r.matched} matched, ${r.unmatched} unmatched out of ${r.total_detections} total.`);
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

export async function refreshCharacters() {
  const container = document.getElementById("characters-list-container");
  if (!container) return;

  try {
    const [identitiesResp, unassignedResp] = await Promise.all([
      callService({ ListCharacterIdentities: null }),
      callService({ ListUnassignedDetections: null }),
    ]);

    const identities: CharacterIdentity[] =
      "CharacterIdentitiesList" in identitiesResp ? identitiesResp.CharacterIdentitiesList.identities : [];
    const unassigned: CharacterDetection[] =
      "UnassignedDetectionsList" in unassignedResp ? unassignedResp.UnassignedDetectionsList.detections : [];

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
          <div class="identity-sample-crops" style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap;" data-identity-id="${identity.id}"></div>
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

      // Autocomplete rename
      const nameInput = card.querySelector(".identity-name-input") as HTMLInputElement;
      attachAutocomplete(nameInput, dropdownId, async (newName) => {
        if (newName !== identity.name) {
          await callService({ RenameCharacterIdentity: { identity_id: identity.id, name: newName } });
          invalidateSuggestions();
        }
      });
      nameInput.addEventListener("blur", async () => {
        const newName = nameInput.value.trim();
        if (newName && newName !== identity.name) {
          await callService({ RenameCharacterIdentity: { identity_id: identity.id, name: newName } });
          invalidateSuggestions();
        }
      });
      nameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          nameInput.blur();
        }
      });

      // Load sample crop thumbnails
      loadIdentitySampleCrops(card, identity.id);

      // Find All
      card.querySelector(".find-all-btn")?.addEventListener("click", async () => {
        try {
          const searchResp = await callService({ SearchByCharacter: { identity_id: identity.id } });
          if ("CharacterSearchResult" in searchResp) {
            const imageIds = searchResp.CharacterSearchResult.image_ids;
            alert(`Found ${imageIds.length} images containing "${identity.name}".`);
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
          invalidateSuggestions();
          await refreshCharacters();
        } catch (e: any) {
          console.error("Delete identity failed:", e);
        }
      });
    }
  } catch (e) {
    console.error("Failed to load identities:", e);
    container.innerHTML = '<p style="color:#64748b;font-style:italic;">Failed to load identities.</p>';
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

    const detResp = await callService({ GetCharacterDetections: { image_id: imageIds[0] } });
    if (!("CharacterDetectionsResult" in detResp)) return;
    const dets = detResp.CharacterDetectionsResult.detections.filter((d: CharacterDetection) => d.identity_id === identityId);

    for (const det of dets.slice(0, 4)) {
      const thumb = document.createElement("div");
      thumb.style.cssText = "width:80px;height:80px;background:#f0f0f0;border:1px solid #ccc;display:flex;align-items:center;justify-content:center;flex-shrink:0;border-radius:2px;";
      thumb.innerHTML = '<i class="bi bi-image" style="color:#999;font-size:16px;"></i>';
      cropsContainer.appendChild(thumb);
      loadCropForElement(thumb, det.id);
    }
  } catch (_) {}
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

  // Info + identity dropdown
  const infoEl = document.createElement("div");
  infoEl.style.cssText = "flex:1;min-width:0;";
  infoEl.innerHTML = `
    <div style="display:flex;align-items:center;gap:6px;">
      <span style="color:#888;">Image #${det.image_id}</span>
      <span style="color:#888;">(${(det.confidence * 100).toFixed(1)}%)</span>
    </div>
    <div style="display:flex;align-items:center;gap:4px;margin-top:2px;">
      <select class="win-select detection-identity-select" data-detection-id="${det.id}" style="font-size:10px;padding:1px 4px;max-width:180px;">
        <option value="">Unassigned</option>
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

  // Identity assignment handler
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
