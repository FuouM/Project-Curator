import { html, SafeHtml, ComponentMeta } from './_shared';

export interface ConceptCardProps {
  id: number;
  name: string;
  category: string;
  threshold: number;
  sampleCount: number;
  createdAt: string;
  updatedAt: string;
}

export function renderConceptCard(props: ConceptCardProps): SafeHtml {
  const catClass = props.category.toLowerCase();

  return html`
    <div class="concept-card group-box" id="concept-card-${props.id}" data-concept-id="${props.id}">
      <div class="group-box-title concept-card-title">
        <i class="bi bi-stars concept-sparkle"></i> ${props.name}
        <span class="concept-badge ${catClass}">${props.category}</span>
      </div>
      <div class="concept-card-body">
        <div class="concept-info-row">
          <span class="concept-info-label"><i class="bi bi-images"></i> Ground-Truth Samples:</span>
          <span class="concept-info-val"><strong>${props.sampleCount}</strong> ${props.sampleCount === 1 ? 'sample' : 'samples'}</span>
        </div>
        <div class="concept-threshold-box">
          <div class="concept-threshold-header">
            <span><i class="bi bi-sliders"></i> Similarity Threshold:</span>
            <span class="concept-threshold-val" id="concept-th-val-${props.id}">${(props.threshold * 100).toFixed(0)}% (${props.threshold.toFixed(2)})</span>
          </div>
          <input type="range" class="concept-threshold-slider" min="0.40" max="0.95" step="0.01" value="${props.threshold.toFixed(2)}" data-concept-id="${props.id}" data-action="update-threshold">
        </div>
        <div class="concept-samples-panel" id="concept-samples-panel-${props.id}" style="display: none; margin-top: 6px; padding: 8px; background-color: var(--sys-window-bg); border: 1px solid var(--sys-border-dark); border-radius: 2px;">
          <div class="flex-row items-center justify-between" style="font-size: 11px; font-weight: 600; color: var(--sys-control-text); margin-bottom: 6px;">
            <span><i class="bi bi-images"></i> Ground-Truth Sample Thumbnails:</span>
            <span data-action="close-samples" data-concept-id="${props.id}" style="cursor: pointer; font-size: 14px; font-weight: bold; color: var(--sys-text-subtle);" title="Close samples"><i class="bi bi-x-lg"></i></span>
          </div>
          <div id="concept-samples-grid-${props.id}" class="image-grid" style="max-height: 400px; overflow-y: auto; padding: 4px;">
          </div>
        </div>
        <div class="concept-meta-date"><i class="bi bi-clock-history"></i> Updated: ${props.updatedAt.split('.')[0]}</div>
      </div>
      <div class="concept-card-actions">
        <button type="button" class="win-button" data-action="view-samples" data-concept-id="${props.id}" data-concept-name="${props.name.replace(/'/g, "\\'")}"><i class="bi bi-images"></i> Samples (${props.sampleCount})</button>
        <button type="button" class="win-button primary" id="concept-rescan-btn-${props.id}" data-action="rescan-concept" data-concept-id="${props.id}"><i class="bi bi-search"></i> Rescan</button>
        <button type="button" class="win-button danger" data-action="delete-concept" data-concept-id="${props.id}"><i class="bi bi-trash"></i> Delete</button>
      </div>
    </div>
  `;
}

/** @deprecated Use renderConceptCard instead */

export const meta: ComponentMeta = {
  name: "Concept Card",
  description: "ONNX ML embedding concept controllers showing confidence settings and active datasets.",
  variants: [
    {
      name: "Active Concept Cards",
      render: () => html`
        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; width: 100%;">
          ${renderConceptCard({
            id: 1,
            name: "Style Concept Alpha",
            category: "general",
            threshold: 0.82,
            sampleCount: 15,
            createdAt: "2026-08-01 12:00:00",
            updatedAt: "2026-08-10 15:30:00"
          })}
        </div>
      `
    }
  ]
};