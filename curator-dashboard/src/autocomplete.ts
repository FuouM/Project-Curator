interface AutocompleteItem {
  name: string;
  count: number;
}

export interface AutocompleteOptions {
  input: HTMLInputElement;
  dropdownId: string;
  onSelect: (value: string) => void;
  fetchItems: (query: string) => Promise<AutocompleteItem[]>;
  maxItems?: number;
}

export function attachAutocomplete(options: AutocompleteOptions) {
  const { input, dropdownId, onSelect, fetchItems, maxItems = 15 } = options;

  const dropdown =
    (input.parentElement?.querySelector("#" + dropdownId) as HTMLElement) ||
    document.getElementById(dropdownId);
  if (!dropdown) return;

  let activeIndex = -1;

  function showDropdown(query: string) {
    if (!dropdown || !query) {
      if (dropdown) dropdown.style.display = "none";
      return;
    }

    fetchItems(query).then((matches) => {
      if (!dropdown) return;
      const itemsToRender = matches.slice(0, maxItems);

      if (itemsToRender.length === 0) {
        dropdown.style.display = "none";
        return;
      }

      activeIndex = -1;
      dropdown.innerHTML = itemsToRender
        .map(
          (s, i) =>
            `<div class="autocomplete-item" data-name="${s.name}" data-index="${i}">
          <span class="autocomplete-item-tag">${s.name}</span>
          <span class="autocomplete-item-count">${s.count}</span>
        </div>`
        )
        .join("");
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
    setTimeout(() => {
      if (dropdown) dropdown.style.display = "none";
    }, 150);
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
