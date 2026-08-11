import { html, SafeHtml, ComponentMeta } from './_shared';
import { maskPath } from './path-utils';

export interface ImageCardOptions {
  isMock?: boolean;
  badgeClass?: "badge-ready" | "badge-pending";
  badgeText?: string;
  extraTagCount?: number;
  tagPillsHtml?: string;
}

export function renderImageCard(srcUrl: string, filepath: string, options?: ImageCardOptions): SafeHtml {
  const badgeClass = options?.badgeClass ?? "badge-ready";
  const badgeText = options?.badgeText ?? "Ready";
  const tagPills = options?.tagPillsHtml ?? "";
  const extraCount = options?.extraTagCount ?? 0;
  
  const extraTagHtml = extraCount > 0 
    ? `<span class="tag-pill tag-pill-overflow">+${extraCount} more</span>` 
    : "";

  return html`
    <div class="image-card">
      <div class="image-preview">
        <img src="${srcUrl}" alt="Image Preview" style="width: 100%; height: 100%; object-fit: cover;" />
        <div class="vector-badge ${badgeClass}">${badgeText}</div>
      </div>
      <div class="image-info">
        <div class="image-path" title="${filepath}">${maskPath(filepath)}</div>
        <div class="tag-list">
          ${tagPills}${extraTagHtml}
        </div>
      </div>
    </div>
  `;
}

export const meta: ComponentMeta = {
  name: "Image Card (Simple)",
  description: "Visual thumbnail presentation card with inline file paths and tag lists.",
  variants: [
    {
      name: "States Showcase",
      render: () => html`
        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; width: 100%;">
          ${renderImageCard("", "C:\\Users\\demo\\Pictures\\ready_image.png", {
            badgeClass: "badge-ready",
            badgeText: "Ready"
          })}
          ${renderImageCard("", "C:\\Users\\demo\\Pictures\\pending_image.jpg", {
            badgeClass: "badge-pending",
            badgeText: "Pending"
          })}
        </div>
      `
    }
  ]
};