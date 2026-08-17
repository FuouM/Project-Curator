import { html, SafeHtml, ComponentMeta } from "./_shared";

export interface ButtonOptions {
  icon?: string;
  disabled?: boolean;
  style?: string;
  className?: string;
  id?: string;
}

export function renderButton(text: string, options?: ButtonOptions): SafeHtml {
  const className = options?.className ?? "win-button";
  const disabledAttr = options?.disabled ? "disabled" : "";
  const styleAttr = options?.style ? `style="${options.style}"` : "";
  const idAttr = options?.id ? `id="${options.id}"` : "";
  const iconHtml = options?.icon ? `<i class="${options.icon}"></i> ` : "";

  return html`<button class="${className}" ${disabledAttr} ${styleAttr} ${idAttr}>
    ${iconHtml}${text}
  </button>`;
}

export const meta: ComponentMeta = {
  name: "Button",
  description: "Standard WinForms desktop-style button with icon, disabled, and colored styles.",
  variants: [
    {
      name: "Standard States & Icons",
      render: () => html`
        <div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: center;">
          ${renderButton("Normal Button")}
          ${renderButton("Hover State", { style: "background-color: var(--sys-button-hover); border-color: #3b78d7;" })}
          ${renderButton("Active State", { style: "background-color: var(--sys-button-active); border-color: #005499;" })}
          ${renderButton("Disabled Button", { disabled: true })}
          ${renderButton("Button with Icon", { icon: "bi bi-play-fill" })}
        </div>
      `,
    },
    {
      name: "Primary & Danger Actions",
      render: () => html`
        <div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: center;">
          ${renderButton("Primary Button", { className: "win-button primary" })}
          ${renderButton("Primary with Icon", { className: "win-button primary", icon: "bi bi-check-lg" })}
          ${renderButton("Danger Button", { className: "win-button danger" })}
          ${renderButton("Danger with Icon", { className: "win-button danger", icon: "bi bi-trash" })}
        </div>
      `,
    },
  ],
};
