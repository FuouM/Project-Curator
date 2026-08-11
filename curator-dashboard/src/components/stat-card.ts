import { html, SafeHtml, ComponentMeta } from './_shared';

export interface StatCardOptions {
  id?: string;
  style?: string;
  title?: string;
}

export function renderStatCard(label: string, value: string, options?: StatCardOptions): SafeHtml {
  const idAttr = options?.id ? `id="${options.id}"` : "";
  const styleAttr = options?.style ? `style="${options.style}"` : "";
  const titleAttr = options?.title ? `title="${options.title}"` : "";

  return html`
    <div class="stat-card" ${idAttr} ${styleAttr} ${titleAttr}>
      <div class="stat-label">${label}</div>
      <div class="stat-value">${value}</div>
    </div>
  `;
}

export const meta: ComponentMeta = {
  name: "Stat Card",
  description: "Large metrics readouts for dashboard panels.",
  variants: [
    {
      name: "Stat Examples",
      render: () => html`
        <div class="stats-grid" style="width: 100%;">
          ${renderStatCard("Indexed Images", "12,840")}
          ${renderStatCard("Custom Concepts", "6", { style: "color: var(--sys-border-focus);" })}
          ${renderStatCard("Queue Size", "0")}
        </div>
      `
    }
  ]
};