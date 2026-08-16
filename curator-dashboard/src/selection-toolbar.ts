import { isSelectMode, setIsSelectMode, selectedImageIds } from "./state";
import { updateSelectionUI } from "./views/gallery";

interface SelectionToolbarOptions {
  prefix: string;
  gridSelector: string;
}

export function setupSelectionToolbar(options: SelectionToolbarOptions) {
  const { prefix, gridSelector } = options;

  const toggleBtn = document.getElementById(`${prefix}-toggle-select-mode-btn`);
  const selectAllBtn = document.getElementById(`${prefix}-select-all-btn`);
  const clearBtn = document.getElementById(`${prefix}-clear-select-btn`);

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
}

