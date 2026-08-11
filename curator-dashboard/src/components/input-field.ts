import { html, SafeHtml, ComponentMeta } from './_shared';

export interface InputOptions {
  id?: string;
  placeholder?: string;
  value?: string;
  style?: string;
  hasClear?: boolean;
}

export function renderInputField(options?: InputOptions): SafeHtml {
  const idAttr = options?.id ? `id="${options.id}"` : "";
  const placeholderAttr = options?.placeholder ? `placeholder="${options.placeholder}"` : "";
  const valueAttr = options?.value ? `value="${options.value}"` : "";
  const styleAttr = options?.style ? `style="${options.style}"` : "";
  const hasClear = options?.hasClear ?? false;

  if (hasClear) {
    const wrapperClass = options?.value ? "input-wrapper has-value" : "input-wrapper";
    return html`
      <div class="${wrapperClass}" ${styleAttr}>
        <input class="input-field has-clear" ${idAttr} ${placeholderAttr} ${valueAttr} style="width: 100%;" />
        <button type="button" class="input-clear-btn" tabindex="-1"><i class="bi bi-x-lg"></i></button>
      </div>
    `;
  }

  return html`<input class="input-field" ${idAttr} ${placeholderAttr} ${valueAttr} ${styleAttr} />`;
}

export const meta: ComponentMeta = {
  name: "Input Field",
  description: "Text input fields with clean borders, focus outlines, and responsive inline clear triggers.",
  variants: [
    {
      name: "Input Options",
      render: () => html`
        <div style="display: flex; flex-wrap: wrap; gap: 16px; align-items: center; width: 100%;">
          <div class="form-group">
            <label style="font-weight: 600;">Default:</label>
            ${renderInputField({ placeholder: "Enter text..." })}
          </div>
          <div class="form-group">
            <label style="font-weight: 600;">With Initial Value:</label>
            ${renderInputField({ value: "Assigned value" })}
          </div>
          <div class="form-group">
            <label style="font-weight: 600;">Clearable Field:</label>
            ${renderInputField({ hasClear: true, value: "Clear me..." })}
          </div>
        </div>
      `
    }
  ]
};