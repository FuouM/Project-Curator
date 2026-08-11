import { html, SafeHtml, ComponentMeta } from './_shared';

export function renderGroupBox(title: string, contentHtml: string, options?: { style?: string }): SafeHtml {
  const styleAttr = options?.style ? `style="${options.style}"` : "";
  return html`
    <div class="group-box" ${styleAttr}>
      <div class="group-box-title">${title}</div>
      ${contentHtml}
    </div>
  `;
}

export const meta: ComponentMeta = {
  name: "Group Box",
  description: "Traditional desktop container mapping directly to standard WinForms GroupBox panels.",
  variants: [
    {
      name: "Standard Usage",
      render: () => html`
        ${renderGroupBox("Section Container", `
          <div class="group-box-body">
            <p style="color: var(--sys-text-subtle); margin-bottom: 8px;">Inner section text goes here.</p>
          </div>
        `)}
      `
    }
  ]
};