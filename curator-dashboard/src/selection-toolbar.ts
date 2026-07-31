import { isSelectMode, setIsSelectMode, selectedImageIds } from "./state";
import { updateSelectionUI } from "./views/gallery";
import { openTeachConceptModal } from "./views/concepts";

interface SelectionToolbarOptions {
  prefix: string;
  gridSelector: string;
  onTeachConcept?: () => void;
}

export function setupSelectionToolbar(options: SelectionToolbarOptions) {
  const { prefix, gridSelector, onTeachConcept } = options;

  const toggleBtn = document.getElementById(`${prefix}-toggle-select-mode-btn`);
  const selectAllBtn = document.getElementById(`${prefix}-select-all-btn`);
  const clearBtn = document.getElementById(`${prefix}-clear-select-btn`);
  const teachBtn = document.getElementById(`${prefix}-teach-concept-btn`);

  toggleBtn?.addEventListener("click", () => {
    setIsSelectMode(!isSelectMode);
    toggleBtn.classList.toggle("primary", isSelectMode);
    if (!isSelectMode) {
      selectedImageIds.clear();
      document.querySelectorAll(".image-card.selected").forEach((c) => c.classList.remove("selected"));
      document.querySelectorAll(".card-select-checkbox").forEach((cb: any) => (cb.checked = false));
    }
    updateSelectionUI();
  });

  selectAllBtn?.addEventListener("click", () => {
    const cards = document.querySelectorAll(`${gridSelector} .image-card`);
    cards.forEach((card: any) => {
      const id = parseInt(card.dataset.imageId || "0");
      if (id > 0) {
        selectedImageIds.add(id);
        card.classList.add("selected");
        const cb = card.querySelector(".card-select-checkbox");
        if (cb) cb.checked = true;
      }
    });
    updateSelectionUI();
  });

  clearBtn?.addEventListener("click", () => {
    selectedImageIds.clear();
    document.querySelectorAll(".image-card.selected").forEach((c) => c.classList.remove("selected"));
    document.querySelectorAll(".card-select-checkbox").forEach((cb: any) => (cb.checked = false));
    updateSelectionUI();
  });

  teachBtn?.addEventListener("click", () => {
    if (selectedImageIds.size === 0) return;
    if (onTeachConcept) {
      onTeachConcept();
    } else {
      openTeachConceptModal();
    }
  });
}
