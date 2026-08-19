export interface InputOptions {
  id?: string;
  placeholder?: string;
  value?: string;
  style?: string;
  hasClear?: boolean;
}

export function renderInputField(options?: InputOptions): string {
  const idAttr = options?.id ? `id="${options.id}"` : "";
  const placeholderAttr = options?.placeholder ? `placeholder="${options.placeholder}"` : "";
  const valueAttr = options?.value ? `value="${options.value}"` : "";
  const styleAttr = options?.style ? `style="${options.style}"` : "";
  const hasClear = options?.hasClear ?? false;

  if (hasClear) {
    const wrapperClass = options?.value ? "input-wrapper has-value" : "input-wrapper";
    return `
      <div class="${wrapperClass}" ${styleAttr}>
        <input
          class="input-field has-clear"
          ${idAttr}
          ${placeholderAttr}
          ${valueAttr}
          style="width: 100%;"
        />
        <button type="button" class="input-clear-btn" tabindex="-1" title="Clear">
          <i class="bi bi-x-lg"></i>
        </button>
      </div>
    `;
  }

  return `<input class="input-field" ${idAttr} ${placeholderAttr} ${valueAttr} ${styleAttr} />`;
}

export function setupInputClearButtons(root: ParentNode = document): void {
  const inputs = root.querySelectorAll<HTMLInputElement>(".input-field.has-clear");

  inputs.forEach((input) => {
    const wrapper = input.closest(".input-wrapper");
    if (!wrapper) return;

    const clearBtn = wrapper.querySelector<HTMLButtonElement>(".input-clear-btn");
    if (!clearBtn) return;

    function updateClearVisibility() {
      if (input.value.length > 0) {
        wrapper!.classList.add("has-value");
      } else {
        wrapper!.classList.remove("has-value");
      }
    }

    input.addEventListener("input", updateClearVisibility);
    input.addEventListener("change", updateClearVisibility);
    updateClearVisibility();

    clearBtn.addEventListener("click", () => {
      input.value = "";
      updateClearVisibility();
      input.focus();
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });
}
