// ── UI System Foundation ──────────────────────────────────────────────

export type SafeHtml = string & { __html: true };
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  return String.raw(strings, ...values) as SafeHtml;
}

export const TOKENS = {
  space: { xs: '2px', sm: '4px', md: '8px', lg: '12px', xl: '16px', '2xl': '24px' },
  radius: { sm: '2px', md: '4px', lg: '8px' },
  text: { xs: '9px', sm: '11px', md: '13px', lg: '15px' },
  color: {
    accent:   'var(--sys-highlight-bg)',
    danger:   '#a80000',
    subtle:   'var(--sys-text-subtle)',
    border:   'var(--sys-border-dark)',
    surface:  'var(--sys-window-bg)',
    control:  'var(--sys-control-bg)',
  },
} as const;

export interface TagSummary {
  tag: string;
  category: string;
  count?: number;
  source_name?: string;
}

// --- Path Visibility ---
const PATH_VIS_KEY = "curator-path-vis-mode";
const PATH_FOLDERS_KEY = "curator-path-vis-folders";

function getPathVisMode(): string {
  return localStorage.getItem(PATH_VIS_KEY) || "filename";
}

function getPathVisFolders(): number {
  return parseInt(localStorage.getItem(PATH_FOLDERS_KEY) || "1", 10);
}

export function maskPath(fullPath: string): string {
  const mode = getPathVisMode();
  if (mode === "full") return fullPath;

  const sep = fullPath.includes("/") ? "/" : "\\";
  const parts = fullPath.split(/[/\\]/);
  const filename = parts[parts.length - 1];

  if (mode === "filename") return filename;

  const drive = parts[0];
  if (mode === "drive-filename") return `${drive}${sep}...${sep}${filename}`;

  const folders = getPathVisFolders();
  const inner = parts.slice(1);
  const innerFolders = inner.slice(0, -1);
  const showFolders = innerFolders.slice(-folders);
  if (folders >= innerFolders.length) {
    return [drive, ...showFolders, filename].join(sep);
  }
  return `${drive}${sep}...${sep}${showFolders.join(sep)}${sep}${filename}`;
}

// --- Tag Pill Component ---
export function renderTagPill(t: TagSummary, options?: { isDeletable?: boolean; imageId?: number }): SafeHtml {
  let styleClass = "tag-rank-3";
  
  if (t.source_name === "ai:custom-concepts" || t.source_name === "custom-concept") {
    styleClass = "custom-concept";
  } else {
    switch (t.category) {
      case "user":
        styleClass = "tag-user";
        break;
      case "character":
        styleClass = "tag-character";
        break;
      case "copyright":
        styleClass = "tag-copyright";
        break;
      case "meta":
        styleClass = "tag-meta";
        break;
      case "artist":
        styleClass = "tag-artist";
        break;
    }
  }

  const isDeletable = options?.isDeletable ?? false;
  const imageId = options?.imageId ?? 0;

  const sparkIcon = styleClass === "custom-concept" ? `<i class="bi bi-stars concept-spark"></i>` : "";

  const deleteBtn = isDeletable && imageId > 0
    ? ` <span class="tag-remove-btn" data-action="remove-tag" data-image-id="${imageId}" data-tag-name="${t.tag.replace(/'/g, "\\'")}" title="Remove tag"><i class="bi bi-x-lg"></i></span>`
    : "";

  return html`<span class="tag-pill ${styleClass}">${sparkIcon}${t.tag.replace(/_/g, '_\u200B')}${deleteBtn}</span>`;
}

export interface CustomConceptData {
  id: number;
  name: string;
  category: string;
  threshold: number;
  sample_count: number;
  created_at: string;
  updated_at: string;
}

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

/** @deprecated Use renderConceptCard with ConceptCardProps instead */
export function renderConceptCardHtml(c: CustomConceptData): SafeHtml {
  return renderConceptCard({
    id: c.id,
    name: c.name,
    category: c.category,
    threshold: c.threshold,
    sampleCount: c.sample_count,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  });
}

// --- Button Component ---
export interface ButtonOptions {
  icon?: string;
  disabled?: boolean;
  style?: string;
  className?: string;
  id?: string;
  onClick?: string;
}

export function renderButton(text: string, options?: ButtonOptions): string {
  const className = options?.className ?? "win-button";
  const disabledAttr = options?.disabled ? "disabled" : "";
  const styleAttr = options?.style ? `style="${options.style}"` : "";
  const idAttr = options?.id ? `id="${options.id}"` : "";
  const onClickAttr = options?.onClick ? `onclick="${options.onClick}"` : "";
  const iconHtml = options?.icon ? `<i class="${options.icon}"></i> ` : "";

  return `<button class="${className}" ${disabledAttr} ${styleAttr} ${idAttr} ${onClickAttr}>${iconHtml}${text}</button>`;
}

// --- Input Field Component ---
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
        <input class="input-field has-clear" ${idAttr} ${placeholderAttr} ${valueAttr} style="width: 100%;" />
        <button type="button" class="input-clear-btn" tabindex="-1"><i class="bi bi-x-lg"></i></button>
      </div>
    `;
  }

  return `<input class="input-field" ${idAttr} ${placeholderAttr} ${valueAttr} ${styleAttr} />`;
}

// --- Stat Card Component ---
export interface StatCardOptions {
  id?: string;
  style?: string;
  title?: string;
}

export function renderStatCard(label: string, value: string, options?: StatCardOptions): string {
  const idAttr = options?.id ? `id="${options.id}"` : "";
  const styleAttr = options?.style ? `style="${options.style}"` : "";
  const titleAttr = options?.title ? `title="${options.title}"` : "";

  return `
    <div class="stat-card" ${idAttr} ${styleAttr} ${titleAttr}>
      <div class="stat-label">${label}</div>
      <div class="stat-value">${value}</div>
    </div>
  `;
}

// --- Image Card Component ---
export interface ImageCardOptions {
  isMock?: boolean;
  badgeClass?: "badge-ready" | "badge-pending";
  badgeText?: string;
  extraTagCount?: number;
  tagPillsHtml?: string;
}

export function renderImageCard(srcUrl: string, filepath: string, options?: ImageCardOptions): string {
  const badgeClass = options?.badgeClass ?? "badge-ready";
  const badgeText = options?.badgeText ?? "Ready";
  const tagPills = options?.tagPillsHtml ?? "";
  const extraCount = options?.extraTagCount ?? 0;
  
  const extraTagHtml = extraCount > 0 
    ? `<span class="tag-pill" style="background-color: #f0f0f0; color: #555555; font-style: italic;">+${extraCount} more</span>` 
    : "";

  return `
    <div class="image-card">
      <div class="image-preview">
        <img src="${srcUrl}" alt="Image Preview" style="width: 100%; height: 100%; object-fit: cover;" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';" />
        <span style="display: none;"><i class="bi bi-image"></i></span>
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

// --- Group Box Component ---
export function renderGroupBox(title: string, contentHtml: string, options?: { style?: string }): string {
  const styleAttr = options?.style ? `style="${options.style}"` : "";
  return `
    <div class="group-box" ${styleAttr}>
      <div class="group-box-title">${title}</div>
      ${contentHtml}
    </div>
  `;
}

// ── Component Dev View Registry ──────────────────────────────────────
// Only render* functions listed here appear in the component dev view.
// Each key must match an exported function name in this file.

export const SHOWCASE_COMPONENTS: Record<string, { name: string; description: string }> = {
  renderConceptCard: {
    name: "Concept Card",
    description: "Custom concept definition card with threshold slider, sample grid, and action buttons.",
  },
};
