import { callService } from "../ipc";
import { renderConceptCard, SafeHtml, html } from "../components";
import { selectedImageIds } from "../state";
import { renderImages } from "../cards";
import { refreshDashboard } from "./dashboard";
import { loadSearchConceptsDropdown } from "./search";
import { setupSelectionToolbar } from "../selection-toolbar";

export function setupInputClearButtons() {
  const inputs = document.querySelectorAll<HTMLInputElement>('.input-field.has-clear');

  inputs.forEach((input) => {
    const wrapper = input.closest('.input-wrapper');
    if (!wrapper) return;

    const clearBtn = wrapper.querySelector('.input-clear-btn') as HTMLButtonElement;
    if (!clearBtn) return;

    function updateClearVisibility() {
      if (input.value.length > 0) {
        wrapper!.classList.add('has-value');
      } else {
        wrapper!.classList.remove('has-value');
      }
    }

    input.addEventListener('input', updateClearVisibility);
    input.addEventListener('change', updateClearVisibility);
    updateClearVisibility();

    clearBtn.addEventListener('click', () => {
      input.value = '';
      updateClearVisibility();
      input.focus();
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });
}

let fetchedConceptsCache: any[] = [];

function syncSelectedConceptUI() {
  const existingRadio = document.getElementById("target-type-existing") as HTMLInputElement;
  const existingSelect = document.getElementById("teach-concept-existing-select") as HTMLSelectElement;
  const catSelect = document.getElementById("teach-concept-category") as HTMLSelectElement;
  const thRange = document.getElementById("teach-concept-threshold") as HTMLInputElement;
  const thVal = document.getElementById("teach-th-val");
  if (!existingRadio?.checked || !existingSelect) return;
  const selectedName = existingSelect.value;
  const concept = fetchedConceptsCache.find((c: any) => c.name === selectedName);
  if (concept) {
    if (catSelect && concept.category) catSelect.value = concept.category;
    if (thRange && concept.threshold) {
      thRange.value = concept.threshold.toString();
      if (thVal) thVal.textContent = parseFloat(concept.threshold).toFixed(2);
    }
  }
}

function updateModeUI() {
  const existingRadio = document.getElementById("target-type-existing") as HTMLInputElement;
  const existingGroup = document.getElementById("teach-existing-concept-group");
  const newGroup = document.getElementById("teach-new-concept-group");
  const nameInput = document.getElementById("teach-concept-name") as HTMLInputElement;
  const existingSelect = document.getElementById("teach-concept-existing-select") as HTMLSelectElement;
  const submitBtn = document.getElementById("teach-concept-submit-btn");

  const isExisting = existingRadio?.checked ?? true;
  if (existingGroup) existingGroup.style.display = isExisting ? "block" : "none";
  if (newGroup) newGroup.style.display = isExisting ? "none" : "block";
  if (nameInput) nameInput.required = !isExisting;
  if (existingSelect) existingSelect.required = isExisting;
  if (submitBtn) {
    submitBtn.innerHTML = isExisting
      ? `<i class="bi bi-plus-lg"></i> Add Samples to Concept`
      : `<i class="bi bi-check-lg"></i> Create New Concept`;
  }
  if (isExisting) {
    syncSelectedConceptUI();
  }
}

let teachModalListenersBound = false;
function bindTeachModalListeners() {
  if (teachModalListenersBound) return;
  teachModalListenersBound = true;
  const existingRadio = document.getElementById("target-type-existing") as HTMLInputElement;
  const newRadio = document.getElementById("target-type-new") as HTMLInputElement;
  const existingSelect = document.getElementById("teach-concept-existing-select") as HTMLSelectElement;
  const thRange = document.getElementById("teach-concept-threshold") as HTMLInputElement;
  const thVal = document.getElementById("teach-th-val");

  existingRadio?.addEventListener("change", updateModeUI);
  newRadio?.addEventListener("change", updateModeUI);
  existingSelect?.addEventListener("change", syncSelectedConceptUI);

  if (thRange) {
    thRange.addEventListener("input", () => {
      if (thVal) thVal.textContent = thRange.value;
    });
  }
}

export async function openTeachConceptModal() {
  bindTeachModalListeners();
  const teachModal = document.getElementById("teach-concept-modal");
  const existingSelect = document.getElementById("teach-concept-existing-select") as HTMLSelectElement;
  const existingRadio = document.getElementById("target-type-existing") as HTMLInputElement;
  const newRadio = document.getElementById("target-type-new") as HTMLInputElement;

  if (existingSelect) {
    try {
      const resp = await callService({ ListConcepts: null });
      if ("ConceptListResult" in resp) {
        fetchedConceptsCache = resp.ConceptListResult.concepts;
        if (fetchedConceptsCache.length > 0) {
          existingSelect.innerHTML = fetchedConceptsCache
            .map((c: any) => `<option value="${c.name}">${c.name} [${c.category.toUpperCase()}] (${c.sample_count} samples)</option>`)
            .join("");
          if (existingRadio) existingRadio.checked = true;
          syncSelectedConceptUI();
        } else {
          existingSelect.innerHTML = `<option value="">No existing concepts found</option>`;
          if (newRadio) newRadio.checked = true;
        }
      }
    } catch (_) {
      existingSelect.innerHTML = `<option value="">Failed to load concepts</option>`;
    }
  }

  updateModeUI();
  if (teachModal) teachModal.classList.add("active");
}

export async function loadConceptsView() {
  const container = document.getElementById("concepts-list-container");
  if (!container) return;
  container.innerHTML = `<div style="padding: 20px; text-align: center; opacity: 0.7;"><i class="bi bi-hourglass-split"></i> Loading custom concepts...</div>`;

  try {
    const resp = await callService({ ListConcepts: null });
    if ("ConceptListResult" in resp) {
      const concepts = resp.ConceptListResult.concepts;
      if (concepts.length === 0) {
        container.innerHTML = `
          <div style="grid-column: 1 / -1; padding: 40px 20px; text-align: center; background: var(--sys-menu-bg); border: 1px dashed var(--sys-menu-border); border-radius: 6px;">
            <i class="bi bi-magic" style="font-size: 32px; color: var(--sys-text-subtle); display: block; margin-bottom: 12px;"></i>
            <h4 style="margin: 0 0 6px 0;">No Custom Concepts Yet</h4>
            <p style="margin: 0; font-size: 12px; color: var(--sys-text-subtle);">
              Select images in the Gallery or open an image's Tags modal and click <strong>"Teach Concept"</strong> to create your first concept!
            </p>
          </div>
        `;
        return;
      }

      container.innerHTML = concepts.map((c: any) => renderConceptCard({
        id: c.id,
        name: c.name,
        category: c.category,
        threshold: c.threshold,
        sampleCount: c.sample_count,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
      })).join("");
    } else if ("Error" in resp) {
      container.innerHTML = `<div style="color: #e81123;">Error loading concepts: ${resp.Error.message}</div>`;
    }
  } catch (e: any) {
    container.innerHTML = `<div style="color: #e81123;">Error: ${e.message || e}</div>`;
  }
}

// ── Module-level concept handlers ────────────────────────────────────

async function updateConceptThreshold(conceptId: number, val: number) {
  const display = document.getElementById(`concept-th-val-${conceptId}`);
  if (display) display.textContent = `${(val * 100).toFixed(0)}% (${val.toFixed(2)})`;
  try {
    await callService({ UpdateConcept: { id: conceptId, threshold: val, category: null } });
  } catch (e: any) {
    console.error("Failed to update concept threshold", e);
  }
}

async function rescanConcept(conceptId: number) {
  const btn = document.getElementById(`concept-rescan-btn-${conceptId}`) as HTMLButtonElement;
  const originalHtml = btn ? btn.innerHTML : "";
  if (!confirm("Rescan all library images against this concept prototype now?")) return;

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i class="bi bi-cpu animate-spin"></i> Step 1/2: Rescanning...`;
  }

  try {
    if (btn) btn.innerHTML = `<i class="bi bi-cpu animate-spin"></i> Step 2/2: Scoring vectors & tagging...`;
    const resp = await callService({ RescanConcept: { concept_id: conceptId } });
    if ("ConceptRescannedResult" in resp) {
      if (btn) btn.innerHTML = `<i class="bi bi-check-lg"></i> Done (${resp.ConceptRescannedResult.tagged_count})`;
      setTimeout(() => {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = originalHtml;
        }
      }, 1200);
      alert(`Rescan complete! Tagged ${resp.ConceptRescannedResult.tagged_count} matching image(s).`);
      refreshDashboard();
      if (document.getElementById("view-gallery")?.classList.contains("active")) {
        const { refreshGallery } = await import("./gallery");
        refreshGallery();
      }
    } else if ("Error" in resp) {
      alert("Rescan failed: " + resp.Error.message);
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
      }
    }
  } catch (e: any) {
    alert("Error rescanning concept: " + e.message);
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  }
}

async function deleteConcept(conceptId: number) {
  if (!confirm("Are you sure you want to delete this custom concept?")) return;
  try {
    const resp = await callService({ DeleteConcept: { id: conceptId } });
    if ("Success" in resp) {
      loadConceptsView();
    } else if ("Error" in resp) {
      alert("Delete failed: " + resp.Error.message);
    }
  } catch (e: any) {
    alert("Error deleting concept: " + e.message);
  }
}

function closeConceptSamples(conceptId: number) {
  const panel = document.getElementById(`concept-samples-panel-${conceptId}`);
  const card = document.getElementById(`concept-card-${conceptId}`);
  if (panel) panel.style.display = "none";
  if (card) card.classList.remove("expanded");
}

async function removeConceptSample(conceptId: number, imageId: number) {
  if (!confirm("Remove this sample image from the concept ground-truth set?")) return;

  // 1. Instant Optimistic DOM Removal
  const grid = document.getElementById(`concept-samples-grid-${conceptId}`);
  if (grid) {
    const cards = grid.querySelectorAll(".image-card");
    cards.forEach((c) => {
      const idAttr = c.getAttribute("data-image-id") || c.getAttribute("data-id") || (c.querySelector("[data-id]") as HTMLElement)?.dataset.id;
      if (idAttr && parseInt(idAttr) === imageId) {
        c.remove();
      }
    });
    if (grid.querySelectorAll(".image-card").length === 0) {
      grid.innerHTML = `<div style="grid-column: 1 / -1; padding: 8px; text-align: center; color: #888; font-size: 11px;">No sample images found.</div>`;
    }
  }

  // 2. Instant Optimistic Sample Count Update
  const cardEl = document.getElementById(`concept-card-${conceptId}`);
  if (cardEl) {
    const countValEl = cardEl.querySelector(".concept-info-val");
    const sampleBtnEl = cardEl.querySelector(".concept-card-actions button");
    const strongEl = countValEl?.querySelector("strong");

    let updatedCount = 0;
    if (strongEl) {
      updatedCount = Math.max(0, parseInt(strongEl.textContent || "1") - 1);
      countValEl!.innerHTML = `<strong>${updatedCount}</strong> ${updatedCount === 1 ? 'sample' : 'samples'}`;
    }
    if (sampleBtnEl) {
      sampleBtnEl.innerHTML = `<i class="bi bi-images"></i> Samples (${updatedCount})`;
    }
  }

  try {
    const resp = await callService({ RemoveConceptSample: { concept_id: conceptId, image_id: imageId } });
    if ("ConceptResult" in resp) {
      const concept = resp.ConceptResult.concept;

      const countValElFinal = document.querySelector(`#concept-card-${conceptId} .concept-info-val`);
      if (countValElFinal) {
        countValElFinal.innerHTML = `<strong>${concept.sample_count}</strong> ${concept.sample_count === 1 ? 'sample' : 'samples'}`;
      }

      const sampleBtnElFinal = document.querySelector(`#concept-card-${conceptId} .concept-card-actions button`);
      if (sampleBtnElFinal) {
        sampleBtnElFinal.innerHTML = `<i class="bi bi-images"></i> Samples (${concept.sample_count})`;
      }

      await viewConceptSamples(conceptId, "", true);

      const { refreshModalTags } = await import("./tags");
      refreshModalTags(imageId).catch(() => {});

      refreshDashboard();
      loadSearchConceptsDropdown();
    } else if ("Error" in resp) {
      alert("Failed to remove sample: " + resp.Error.message);
      await viewConceptSamples(conceptId, "", true);
    }
  } catch (e: any) {
    alert("Error removing sample: " + (e.message || e));
    await viewConceptSamples(conceptId, "", true);
  }
}

async function viewConceptSamples(conceptId: number, _conceptName: string, forceReload: boolean = false) {
  const panel = document.getElementById(`concept-samples-panel-${conceptId}`);
  const grid = document.getElementById(`concept-samples-grid-${conceptId}`);
  const card = document.getElementById(`concept-card-${conceptId}`);

  if (!panel || !grid) return;

  if (!forceReload && panel.style.display !== "none" && grid.children.length > 0 && !grid.innerHTML.includes("Loading")) {
    panel.style.display = "none";
    if (card) card.classList.remove("expanded");
    return;
  }

  panel.style.display = "block";
  if (card) card.classList.add("expanded");
  grid.innerHTML = `<div style="grid-column: 1 / -1; padding: 10px; text-align: center; opacity: 0.7; font-size: 11px;"><i class="bi bi-hourglass-split"></i> Loading samples...</div>`;

  try {
    const resp = await callService({ GetConceptSamples: { concept_id: conceptId } });
    if ("ConceptSamplesResult" in resp) {
      const samples = resp.ConceptSamplesResult.samples;
      if (samples.length === 0) {
        grid.innerHTML = `<div style="grid-column: 1 / -1; padding: 8px; text-align: center; color: #888; font-size: 11px;">No sample images found.</div>`;
        return;
      }

      renderImages(samples, `concept-samples-grid-${conceptId}`);

      requestAnimationFrame(() => {
        const sampleCards = grid.querySelectorAll(".image-card");
        sampleCards.forEach((cardEl) => {
          const imgId = cardEl.getAttribute("data-image-id") || cardEl.getAttribute("data-id");
          if (imgId) {
            const infoEl = cardEl.querySelector(".image-info");
            if (infoEl) {
              const btn = document.createElement("button");
              btn.type = "button";
              btn.className = "win-button danger";
              btn.style.cssText = "padding: 2px 6px; font-size: 10px; margin-top: 4px; width: 100%;";
              btn.innerHTML = `<i class="bi bi-trash"></i> Remove Sample`;
              btn.setAttribute("data-action", "remove-sample");
              btn.setAttribute("data-image-id", imgId);
              infoEl.appendChild(btn);
            }
          }
        });
      });
    }
  } catch (e: any) {
    grid.innerHTML = `<div style="grid-column: 1 / -1; color: #ef4444; padding: 6px; font-size: 11px;">Error: ${e.message || e}</div>`;
  }
}

// ── Delegation handler for concept card actions ──────────────────────

function setupConceptDelegation(container: HTMLElement) {
  container.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const actionEl = target.closest<HTMLElement>("[data-action]");
    if (!actionEl) return;

    const action = actionEl.dataset.action;
    const conceptId = parseInt(actionEl.dataset.conceptId || "");

    switch (action) {
      case "view-samples":
        viewConceptSamples(conceptId, actionEl.dataset.conceptName || "");
        break;
      case "close-samples":
        closeConceptSamples(conceptId);
        break;
      case "rescan-concept":
        rescanConcept(conceptId);
        break;
      case "delete-concept":
        deleteConcept(conceptId);
        break;
      case "remove-sample": {
        const imageId = parseInt(actionEl.dataset.imageId || "");
        const cardEl = actionEl.closest<HTMLElement>("[data-concept-id]");
        const ctxConceptId = cardEl ? parseInt(cardEl.dataset.conceptId || "") : conceptId;
        if (ctxConceptId && imageId) {
          removeConceptSample(ctxConceptId, imageId);
        }
        break;
      }
    }
  });

  container.addEventListener("input", (e) => {
    const target = e.target as HTMLElement;
    if (target.dataset.action !== "update-threshold") return;
    const conceptId = parseInt(target.dataset.conceptId || "");
    const val = parseFloat((target as HTMLInputElement).value);
    if (conceptId && !isNaN(val)) {
      const display = document.getElementById(`concept-th-val-${conceptId}`);
      if (display) display.textContent = `${Math.round(val * 100)}% (${val.toFixed(2)})`;
    }
  });

  container.addEventListener("change", (e) => {
    const target = e.target as HTMLElement;
    if (target.dataset.action !== "update-threshold") return;
    const conceptId = parseInt(target.dataset.conceptId || "");
    const val = parseFloat((target as HTMLInputElement).value);
    if (conceptId && !isNaN(val)) {
      updateConceptThreshold(conceptId, val);
    }
  });
}

// ── Setup ────────────────────────────────────────────────────────────

export function setupConcepts() {
  // Teach Concept Modal Trigger from Tag Modal
  const teachModalBtn = document.getElementById("teach-concept-from-modal-btn");
  const teachModal = document.getElementById("teach-concept-modal");
  const closeTeachModal = document.getElementById("close-teach-modal");
  const cancelTeachModal = document.getElementById("cancel-teach-modal");

  teachModalBtn?.addEventListener("click", () => {
    const idInput = document.getElementById("tag-image-id") as HTMLInputElement;
    if (idInput && idInput.value) {
      openTeachConceptModal();
    }
  });

  closeTeachModal?.addEventListener("click", () => teachModal?.classList.remove("active"));
  cancelTeachModal?.addEventListener("click", () => teachModal?.classList.remove("active"));

  // Gallery Selection Toolbar Buttons
  setupSelectionToolbar({ prefix: "gallery", gridSelector: "#gallery-grid" });

  // Teach Concept Form Submit
  const teachForm = document.getElementById("teach-concept-form") as HTMLFormElement;
  teachForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const idInput = document.getElementById("tag-image-id") as HTMLInputElement;
    const existingRadio = document.getElementById("target-type-existing") as HTMLInputElement;
    const existingSelect = document.getElementById("teach-concept-existing-select") as HTMLSelectElement;
    const nameInput = document.getElementById("teach-concept-name") as HTMLInputElement;
    const catSelect = document.getElementById("teach-concept-category") as HTMLSelectElement;
    const thRange = document.getElementById("teach-concept-threshold") as HTMLInputElement;

    const sampleIds = selectedImageIds.size > 0
      ? Array.from(selectedImageIds)
      : (idInput && idInput.value ? [parseInt(idInput.value)] : []);

    if (sampleIds.length === 0) {
      alert("Please select at least 1 image to teach a concept.");
      return;
    }

    const isExisting = existingRadio?.checked ?? true;
    const name = (isExisting ? existingSelect.value : nameInput.value).trim();
    if (!name) {
      alert("Please select an existing concept or enter a new concept name.");
      return;
    }

    const category = catSelect.value;
    const threshold = parseFloat(thRange.value);

    const submitBtn = document.getElementById("teach-concept-submit-btn") as HTMLButtonElement;
    const cancelBtn = document.getElementById("cancel-teach-modal") as HTMLButtonElement;
    const statusPanel = document.getElementById("teach-concept-status");
    const statusStep = document.getElementById("teach-concept-status-step");
    const statusPct = document.getElementById("teach-concept-status-pct");
    const statusFill = document.getElementById("teach-concept-progress-fill");
    const statusDesc = document.getElementById("teach-concept-status-desc");

    const setTeachProgress = (pct: number, stepText: string, descText: string) => {
      if (statusPanel) statusPanel.style.display = "flex";
      if (statusStep) statusStep.innerHTML = `<i class="bi bi-cpu animate-spin" style="margin-right: 6px; color: var(--sys-border-focus);"></i> ${stepText}`;
      if (statusPct) statusPct.textContent = `${pct}%`;
      if (statusFill) statusFill.style.width = `${pct}%`;
      if (statusDesc) statusDesc.textContent = descText;
    };

    setTeachProgress(15, "Step 1/3: Extracting Multimodal Embeddings...", "Processing CLIP vision & AI tagger feature vectors for sample images...");
    if (submitBtn) submitBtn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = true;

    try {
      setTeachProgress(45, "Step 2/3: Solving Dual Ridge Decision Boundary...", "Sampling negative background context & fitting regularized hyper-plane in Rust...");

      const resp = await callService({
        CreateConcept: {
          name,
          category,
          threshold,
          sample_image_ids: sampleIds,
        },
      });

      if ("ConceptResult" in resp) {
        setTeachProgress(85, "Step 3/3: Applying Concept Tags & Weight BLOB...", "Persisting decision vector and updating ground-truth sample tags...");
        
        setTimeout(async () => {
          setTeachProgress(100, "Complete!", "Concept trained and saved successfully.");
          setTimeout(() => {
            teachModal?.classList.remove("active");
            if (statusPanel) statusPanel.style.display = "none";
          }, 400);
          const { refreshModalTags } = await import("./tags");
          if (sampleIds.length > 0) await refreshModalTags(sampleIds[0]);
          loadConceptsView();
          refreshDashboard();
          loadSearchConceptsDropdown();
        }, 300);
      } else if ("Error" in resp) {
        alert("Failed to teach concept: " + resp.Error.message);
        if (statusPanel) statusPanel.style.display = "none";
      }
    } catch (err: any) {
      alert("Error teaching concept: " + (err.message || err));
      if (statusPanel) statusPanel.style.display = "none";
    } finally {
      if (submitBtn) submitBtn.disabled = false;
      if (cancelBtn) cancelBtn.disabled = false;
    }
  });

  // Custom Concepts Navigation View & Refresh
  const conceptsNav = document.querySelector('.nav-item[data-view="concepts"]');
  conceptsNav?.addEventListener("click", () => {
    loadConceptsView();
  });

  document.getElementById("refresh-concepts-btn")?.addEventListener("click", () => {
    loadConceptsView();
  });

  document.getElementById("clean-auto-concept-tags-btn")?.addEventListener("click", async () => {
    if (!confirm("Remove all automatically generated concept tags from non-sample images in your library? Ground-truth sample images will keep their concept tags.")) return;

    const btn = document.getElementById("clean-auto-concept-tags-btn") as HTMLButtonElement;
    const originalHtml = btn ? btn.innerHTML : "";
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<i class="bi bi-cpu animate-spin"></i> Cleaning...`;
    }

    try {
      const resp = await callService({ CleanAutoConceptTags: { concept_id: null } });
      if ("AutoConceptTagsCleanedResult" in resp) {
        alert(`Cleaned ${resp.AutoConceptTagsCleanedResult.cleaned_count} auto-generated concept tag(s) from non-sample images!`);
        refreshDashboard();
        loadConceptsView();
      } else if ("Error" in resp) {
        alert("Clean failed: " + resp.Error.message);
      }
    } catch (e: any) {
      alert("Error cleaning concept tags: " + (e.message || e));
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
      }
    }
  });

  // Delegation setup for concept cards
  const conceptsContainer = document.getElementById("concepts-list-container");
  if (conceptsContainer) {
    setupConceptDelegation(conceptsContainer);
  }
}

export async function findSimilar(path: string): Promise<void> {
  const searchNavItem = document.querySelector('.nav-item[data-view="search"]') as HTMLElement;
  if (searchNavItem) {
    searchNavItem.click();

    const queryInput = document.getElementById("search-text-input") as HTMLInputElement;
    const tagInput = document.getElementById("search-tag-input") as HTMLInputElement;
    const imageInput = document.getElementById("search-image-path-input") as HTMLInputElement;

    if (queryInput) { queryInput.value = ""; queryInput.dispatchEvent(new Event('change')); }
    if (tagInput) { tagInput.value = ""; tagInput.dispatchEvent(new Event('change')); }
    if (imageInput) {
      imageInput.value = path;
      imageInput.dispatchEvent(new Event("change"));
      setTimeout(() => {
        document.getElementById("search-form")?.dispatchEvent(new Event("submit"));
      }, 50);
    }
  }
}

// ---------------------------------------------------------------------------
// HTML Template
// ---------------------------------------------------------------------------

export function renderConceptsHtml(): SafeHtml {
  return html`
    <div class="group-box">
      <div class="group-box-title"><i class="bi bi-magic"></i> Custom Concept Learning (Few-Shot Prototype Tagging)</div>
      <div style="margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center;">
        <p style="margin: 0; font-size: 12px; color: var(--sys-text-subtle);">
          Teach Curator new characters, copyrights, or series from sample images without model retraining.
        </p>
        <div style="display: flex; gap: 8px;">
          <button type="button" class="win-button danger" id="clean-auto-concept-tags-btn" title="Remove automatically applied concept tags from non-sample images">
            <i class="bi bi-eraser"></i> Clean Auto-Tags
          </button>
          <button type="button" class="win-button primary" id="refresh-concepts-btn">
            <i class="bi bi-arrow-clockwise"></i> Refresh Concepts
          </button>
        </div>
      </div>
      <div id="concepts-list-container" class="concepts-grid"></div>
    </div>
  `;
}
