import { callService } from "../ipc";
import { renderConceptCardHtml } from "../components";
import { selectedImageIds } from "../state";
import { renderImages } from "../cards";
import { refreshDashboard } from "./dashboard";
import { loadSearchConceptsDropdown } from "./search";

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

export async function openTeachConceptModal() {
  const teachModal = document.getElementById("teach-concept-modal");
  const existingSelect = document.getElementById("teach-concept-existing-select") as HTMLSelectElement;
  const existingRadio = document.getElementById("target-type-existing") as HTMLInputElement;
  const newRadio = document.getElementById("target-type-new") as HTMLInputElement;
  const existingGroup = document.getElementById("teach-existing-concept-group");
  const newGroup = document.getElementById("teach-new-concept-group");
  const nameInput = document.getElementById("teach-concept-name") as HTMLInputElement;
  const catSelect = document.getElementById("teach-concept-category") as HTMLSelectElement;
  const thRange = document.getElementById("teach-concept-threshold") as HTMLInputElement;
  const thVal = document.getElementById("teach-th-val");
  const submitBtn = document.getElementById("teach-concept-submit-btn");

  let fetchedConcepts: any[] = [];

  const syncSelectedConceptUI = () => {
    if (!existingRadio?.checked || !existingSelect) return;
    const selectedName = existingSelect.value;
    const concept = fetchedConcepts.find((c: any) => c.name === selectedName);
    if (concept) {
      if (catSelect && concept.category) catSelect.value = concept.category;
      if (thRange && concept.threshold) {
        thRange.value = concept.threshold.toString();
        if (thVal) thVal.textContent = parseFloat(concept.threshold).toFixed(2);
      }
    }
  };

  const updateModeUI = () => {
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
  };

  existingRadio?.addEventListener("change", updateModeUI);
  newRadio?.addEventListener("change", updateModeUI);
  existingSelect?.addEventListener("change", syncSelectedConceptUI);

  if (existingSelect) {
    try {
      const resp = await callService({ ListConcepts: null });
      if ("ConceptListResult" in resp) {
        fetchedConcepts = resp.ConceptListResult.concepts;
        if (fetchedConcepts.length > 0) {
          existingSelect.innerHTML = fetchedConcepts
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

      container.innerHTML = concepts.map((c: any) => renderConceptCardHtml(c)).join("");
    } else if ("Error" in resp) {
      container.innerHTML = `<div style="color: #e81123;">Error loading concepts: ${resp.Error.message}</div>`;
    }
  } catch (e: any) {
    container.innerHTML = `<div style="color: #e81123;">Error: ${e.message || e}</div>`;
  }
}

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
  const toggleSelectBtn = document.getElementById("toggle-select-mode-btn");
  const selectAllBtn = document.getElementById("gallery-select-all-btn");
  const clearSelectBtn = document.getElementById("gallery-clear-select-btn");
  const teachConceptBtn = document.getElementById("gallery-teach-concept-btn");

  toggleSelectBtn?.addEventListener("click", async () => {
    const { isSelectMode, setIsSelectMode, selectedImageIds } = await import("../state");
    setIsSelectMode(!isSelectMode);
    toggleSelectBtn.classList.toggle("primary", isSelectMode);
    if (!isSelectMode) {
      selectedImageIds.clear();
      document.querySelectorAll(".image-card.selected").forEach((c) => c.classList.remove("selected"));
      document.querySelectorAll(".card-select-checkbox").forEach((cb: any) => (cb.checked = false));
    }
    const { updateSelectionUI } = await import("./gallery");
    updateSelectionUI();
  });

  selectAllBtn?.addEventListener("click", async () => {
    const { selectedImageIds } = await import("../state");
    const cards = document.querySelectorAll("#gallery-grid .image-card");
    cards.forEach((card: any) => {
      const id = parseInt(card.dataset.imageId || "0");
      if (id > 0) {
        selectedImageIds.add(id);
        card.classList.add("selected");
        const cb = card.querySelector(".card-select-checkbox");
        if (cb) cb.checked = true;
      }
    });
    const { updateSelectionUI } = await import("./gallery");
    updateSelectionUI();
  });

  clearSelectBtn?.addEventListener("click", async () => {
    const { selectedImageIds } = await import("../state");
    selectedImageIds.clear();
    document.querySelectorAll(".image-card.selected").forEach((c) => c.classList.remove("selected"));
    document.querySelectorAll(".card-select-checkbox").forEach((cb: any) => (cb.checked = false));
    const { updateSelectionUI } = await import("./gallery");
    updateSelectionUI();
  });

  teachConceptBtn?.addEventListener("click", () => {
    if (selectedImageIds.size === 0) return;
    openTeachConceptModal();
  });

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
    const statusText = document.getElementById("teach-concept-status-text");

    if (statusPanel) statusPanel.style.display = "flex";
    if (statusText) statusText.textContent = `Computing vector prototype & rescanning library...`;
    if (submitBtn) submitBtn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = true;

    try {
      const resp = await callService({
        CreateConcept: {
          name,
          category,
          threshold,
          sample_image_ids: sampleIds,
        },
      });

      if ("ConceptResult" in resp) {
        if (statusText) statusText.textContent = `Concept updated successfully!`;
        setTimeout(() => {
          teachModal?.classList.remove("active");
          if (statusPanel) statusPanel.style.display = "none";
        }, 500);
        const { refreshModalTags } = await import("./tags");
        if (sampleIds.length > 0) await refreshModalTags(sampleIds[0]);
        refreshDashboard();
        loadSearchConceptsDropdown();
      } else if ("Error" in resp) {
        alert("Failed to teach concept: " + resp.Error.message);
      }
    } catch (err: any) {
      alert("Error teaching concept: " + (err.message || err));
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

  // Expose window globals for concept actions
  (window as any).findSimilar = (path: string) => {
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
  };

  (window as any).confirmConceptTag = async (imgId: number, tagName: string) => {
    try {
      const listResp = await callService({ ListConcepts: null });
      if ("ConceptListResult" in listResp) {
        const concept = listResp.ConceptListResult.concepts.find((c: any) => c.name === tagName);
        if (concept) {
          const addResp = await callService({ AddConceptSamples: { concept_id: concept.id, image_ids: [imgId] } });
          if ("ConceptResult" in addResp) {
            alert(`Confirmed! Image added as ground-truth sample for concept "${tagName}".`);
            const { refreshModalTags } = await import("./tags");
            await refreshModalTags(imgId);
            refreshDashboard();
          } else if ("Error" in addResp) {
            alert("Failed to confirm tag: " + addResp.Error.message);
          }
        } else {
          alert(`Concept "${tagName}" not found in database.`);
        }
      }
    } catch (e: any) {
      alert("Error confirming concept tag: " + e.message);
    }
  };

  (window as any).updateConceptThreshold = async (conceptId: number, valStr: string) => {
    const val = parseFloat(valStr);
    const display = document.getElementById(`concept-th-val-${conceptId}`);
    if (display) display.textContent = `${(val * 100).toFixed(0)}% (${val.toFixed(2)})`;
    try {
      await callService({ UpdateConcept: { id: conceptId, threshold: val, category: null } });
    } catch (e: any) {
      console.error("Failed to update concept threshold", e);
    }
  };

  (window as any).rescanConcept = async (conceptId: number) => {
    const btn = document.getElementById(`concept-rescan-btn-${conceptId}`) as HTMLButtonElement;
    const originalHtml = btn ? btn.innerHTML : "";
    if (!confirm("Rescan all library images against this concept prototype now?")) return;

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<i class="bi bi-arrow-clockwise animate-spin"></i> Rescanning...`;
    }

    try {
      const resp = await callService({ RescanConcept: { concept_id: conceptId } });
      if ("ConceptRescannedResult" in resp) {
        alert(`Rescan complete! Tagged ${resp.ConceptRescannedResult.tagged_count} matching image(s).`);
        refreshDashboard();
        if (document.getElementById("view-gallery")?.classList.contains("active")) {
          const { refreshGallery } = await import("./gallery");
          refreshGallery();
        }
      } else if ("Error" in resp) {
        alert("Rescan failed: " + resp.Error.message);
      }
    } catch (e: any) {
      alert("Error rescanning concept: " + e.message);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
      }
    }
  };

  (window as any).deleteConcept = async (conceptId: number) => {
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
  };

  (window as any).closeConceptSamples = (conceptId: number) => {
    const panel = document.getElementById(`concept-samples-panel-${conceptId}`);
    const card = document.getElementById(`concept-card-${conceptId}`);
    if (panel) panel.style.display = "none";
    if (card) card.classList.remove("expanded");
  };

  (window as any).removeConceptSample = async (conceptId: number, imageId: number) => {
    if (!confirm("Remove this sample image from the concept ground-truth set?")) return;

    try {
      const resp = await callService({ RemoveConceptSample: { concept_id: conceptId, image_id: imageId } });
      if ("ConceptResult" in resp) {
        await (window as any).viewConceptSamples(conceptId, "", true);
        loadConceptsView();
      } else if ("Error" in resp) {
        alert("Failed to remove sample: " + resp.Error.message);
      }
    } catch (e: any) {
      alert("Error removing sample: " + (e.message || e));
    }
  };

  (window as any).viewConceptSamples = async (conceptId: number, _conceptName: string, forceReload: boolean = false) => {
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
              btn.onclick = (e) => {
                e.stopPropagation();
                (window as any).removeConceptSample(conceptId, parseInt(imgId));
              };
              infoEl.appendChild(btn);
            }
          }
        });
      } else if ("Error" in resp) {
        grid.innerHTML = `<div style="grid-column: 1 / -1; color: #ef4444; padding: 6px; font-size: 11px;">Error: ${resp.Error.message}</div>`;
      }
    } catch (e: any) {
      grid.innerHTML = `<div style="grid-column: 1 / -1; color: #ef4444; padding: 6px; font-size: 11px;">Error: ${e.message || e}</div>`;
    }
  };
}
