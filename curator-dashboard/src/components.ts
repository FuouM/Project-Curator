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

// 1. Tag Pill Component
export function renderTagPill(t: TagSummary, options?: { isDeletable?: boolean; imageId?: number }): string {
  let styleClass = "tag-rank-3"; // Default general / rank 3 (white)
  
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
    ? ` <span class="tag-remove-btn" title="Remove tag" onclick="window.removeTag(${imageId}, '${t.tag.replace(/'/g, "\\'")}')">&times;</span>`
    : "";

  return `<span class="tag-pill ${styleClass}">${sparkIcon}${t.tag.replace(/_/g, '_\u200B')}${deleteBtn}</span>`;
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

export function renderConceptCardHtml(c: CustomConceptData): string {
  const catClass = c.category.toLowerCase();
  
  return `
    <div class="concept-card group-box" id="concept-card-${c.id}" data-concept-id="${c.id}">
      <div class="group-box-title concept-card-title">
        <i class="bi bi-stars concept-sparkle"></i> ${c.name}
        <span class="concept-badge ${catClass}">${c.category}</span>
      </div>
      <div class="concept-card-body">
        <div class="concept-info-row">
          <span class="concept-info-label"><i class="bi bi-images"></i> Ground-Truth Samples:</span>
          <span class="concept-info-val"><strong>${c.sample_count}</strong> ${c.sample_count === 1 ? 'sample' : 'samples'}</span>
        </div>
        <div class="concept-threshold-box">
          <div class="concept-threshold-header">
            <span><i class="bi bi-sliders"></i> Similarity Threshold:</span>
            <span class="concept-threshold-val" id="concept-th-val-${c.id}">${(c.threshold * 100).toFixed(0)}% (${c.threshold.toFixed(2)})</span>
          </div>
          <input type="range" class="concept-threshold-slider" min="0.40" max="0.95" step="0.01" value="${c.threshold.toFixed(2)}" data-concept-id="${c.id}" oninput="const v = parseFloat(this.value); const el = document.getElementById('concept-th-val-${c.id}'); if (el) el.textContent = Math.round(v * 100) + '% (' + v.toFixed(2) + ')';" onchange="window.updateConceptThreshold(${c.id}, this.value)">
        </div>

        <!-- Inline Collapsible Samples Panel inside GroupBox -->
        <div class="concept-samples-panel" id="concept-samples-panel-${c.id}" style="display: none; margin-top: 6px; padding: 8px; background-color: var(--sys-window-bg); border: 1px solid var(--sys-border-dark); border-radius: 2px;">
          <div style="font-size: 11px; font-weight: 600; color: var(--sys-control-text); margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center;">
            <span><i class="bi bi-images"></i> Ground-Truth Sample Thumbnails:</span>
            <span onclick="window.closeConceptSamples(${c.id})" style="cursor: pointer; font-size: 14px; font-weight: bold; color: var(--sys-text-subtle);" title="Close samples">&times;</span>
          </div>
          <div id="concept-samples-grid-${c.id}" class="image-grid" style="max-height: 400px; overflow-y: auto; padding: 4px;">
            <!-- Rendered inline using standard gallery cards -->
          </div>
        </div>

        <div class="concept-meta-date"><i class="bi bi-clock-history"></i> Updated: ${c.updated_at.split('.')[0]}</div>
      </div>
      <div class="concept-card-actions">
        <button type="button" class="win-button" onclick="window.viewConceptSamples(${c.id}, '${c.name.replace(/'/g, "\\'")}')"><i class="bi bi-images"></i> Samples (${c.sample_count})</button>
        <button type="button" class="win-button primary" id="concept-rescan-btn-${c.id}" onclick="window.rescanConcept(${c.id})"><i class="bi bi-search"></i> Rescan</button>
        <button type="button" class="win-button danger" onclick="window.deleteConcept(${c.id})"><i class="bi bi-trash"></i> Delete</button>
      </div>
    </div>
  `;
}

// 2. Button Component
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

// 3. Input Field Component
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

// 4. Stat Card Component
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

// 5. Image Card Component
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

// 6. Group Box Component
export function renderGroupBox(title: string, contentHtml: string, options?: { style?: string }): string {
  const styleAttr = options?.style ? `style="${options.style}"` : "";
  return `
    <div class="group-box" ${styleAttr}>
      <div class="group-box-title">${title}</div>
      ${contentHtml}
    </div>
  `;
}

// --- Component Registry for Programmatic Showcase Generation ---

export interface ComponentVariant {
  name: string;
  render: () => string;
}

export interface ComponentMetadata {
  name: string;
  description: string;
  variants: ComponentVariant[];
}

export const componentRegistry: ComponentMetadata[] = [
  {
    name: "System Color Palette",
    description: "Complete color reference organized by component. Use this to find and update any color in the stylesheet.",
    variants: [
      {
        name: "Theme Variables (CSS Custom Properties)",
        render: () => `
          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; width: 100%;">
            ${[
              { name: "--sys-control-bg", color: "#ececec", desc: "Main panel background" },
              { name: "--sys-control-text", color: "#000000", desc: "Default text" },
              { name: "--sys-window-bg", color: "#ffffff", desc: "Input/card background" },
              { name: "--sys-window-text", color: "#000000", desc: "Input text" },
              { name: "--sys-border-light", color: "#ffffff", desc: "Light border" },
              { name: "--sys-border-dark", color: "#b0b0b0", desc: "Standard border" },
              { name: "--sys-border-focus", color: "#0078d7", desc: "Focus/active border" },
              { name: "--sys-highlight-bg", color: "#0078d7", desc: "Selection background" },
              { name: "--sys-highlight-text", color: "#ffffff", desc: "Selection text" },
              { name: "--sys-button-bg", color: "#f0f0f0", desc: "Button background" },
              { name: "--sys-button-border", color: "#707070", desc: "Button border" },
              { name: "--sys-button-hover", color: "#e5f1fb", desc: "Button hover" },
              { name: "--sys-button-active", color: "#cce4f7", desc: "Button pressed" },
              { name: "--sys-status-bg", color: "#f3f3f3", desc: "Status bar bg" },
              { name: "--sys-status-text", color: "#333333", desc: "Status bar text" },
              { name: "--sys-menu-bg", color: "#f9f9f9", desc: "Menu background" },
              { name: "--sys-menu-border", color: "#d0d0d0", desc: "Menu border" }
            ].map(c => `
              <div style="display: flex; align-items: center; gap: 8px; padding: 6px; border: 1px solid var(--sys-border-dark); background: var(--sys-window-bg);">
                <div style="width: 28px; height: 28px; border: 1px solid #888; background-color: ${c.color}; flex-shrink: 0;"></div>
                <div style="min-width: 0;">
                  <div style="font-weight: bold; font-size: 10px; word-break: break-all;">${c.name}</div>
                  <div style="font-size: 10px; color: #666;">${c.color}</div>
                  <div style="font-size: 9px; color: #999;">${c.desc}</div>
                </div>
              </div>
            `).join("")}
          </div>
        `
      },
      {
        name: "Button Colors",
        render: () => `
          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; width: 100%;">
            ${[
              { label: "Normal BG", color: "#f0f0f0", css: "--sys-button-bg" },
              { label: "Normal Border", color: "#707070", css: "--sys-button-border" },
              { label: "Hover BG", color: "#e5f1fb", css: "--sys-button-hover" },
              { label: "Hover Border", color: "#3b78d7", css: "win-button:hover" },
              { label: "Active BG", color: "#cce4f7", css: "--sys-button-active" },
              { label: "Active Border", color: "#005499", css: "win-button:active" },
              { label: "Disabled BG", color: "#e1e1e1", css: "win-button:disabled" },
              { label: "Disabled Text", color: "#838383", css: "win-button:disabled" },
              { label: "Primary BG", color: "#0078d7", css: "win-button.primary" },
              { label: "Primary Hover", color: "#1a86d9", css: "win-button.primary:hover" },
              { label: "Primary Active", color: "#005499", css: "win-button.primary:active" },
              { label: "Primary Border", color: "#004578", css: "win-button.primary:hover" },
              { label: "Danger Text", color: "#a80000", css: "win-button.danger" },
              { label: "Danger Hover BG", color: "#fde7e9", css: "win-button.danger:hover" },
              { label: "Danger Hover Border", color: "#a80000", css: "win-button.danger:hover" },
              { label: "Danger Active BG", color: "#f5c6cb", css: "win-button.danger:active" },
              { label: "Danger Active Border", color: "#842029", css: "win-button.danger:active" },
              { label: "Tool Strip Hover", color: "#70adeb", css: "tool-strip-btn:hover" }
            ].map(c => `
              <div style="display: flex; align-items: center; gap: 8px; padding: 6px; border: 1px solid var(--sys-border-dark); background: var(--sys-window-bg);">
                <div style="width: 24px; height: 24px; border: 1px solid #888; background-color: ${c.color}; flex-shrink: 0;"></div>
                <div style="min-width: 0;">
                  <div style="font-weight: 600; font-size: 10px;">${c.label}</div>
                  <div style="font-size: 10px; color: #666;">${c.color}</div>
                  <div style="font-size: 9px; color: #999; word-break: break-all;">${c.css}</div>
                </div>
              </div>
            `).join("")}
          </div>
        `
      },
      {
        name: "Tag Pill Colors",
        render: () => `
          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; width: 100%;">
            ${[
              { label: "User Tag BG", color: "#fff3cd", css: ".tag-user bg" },
              { label: "User Tag Border", color: "#ffeeba", css: ".tag-user border" },
              { label: "User Tag Text", color: "#856404", css: ".tag-user text" },
              { label: "Character BG", color: "#d1ecf1", css: ".tag-character bg" },
              { label: "Character Border", color: "#bee5eb", css: ".tag-character border" },
              { label: "Character Text", color: "#0c5460", css: ".tag-character text" },
              { label: "Copyright BG", color: "#ebdcf9", css: ".tag-copyright bg" },
              { label: "Copyright Border", color: "#dcbdf5", css: ".tag-copyright border" },
              { label: "Copyright Text", color: "#511c74", css: ".tag-copyright text" },
              { label: "Meta BG", color: "#e2e3e5", css: ".tag-meta bg" },
              { label: "Meta Border", color: "#d6d8db", css: ".tag-meta border" },
              { label: "Meta Text", color: "#383d41", css: ".tag-meta text" },
              { label: "Artist BG", color: "#fff0e6", css: ".tag-artist bg" },
              { label: "Artist Border", color: "#ffd9c2", css: ".tag-artist border" },
              { label: "Artist Text", color: "#7c2d12", css: ".tag-artist text" },
              { label: "Rank-3 BG", color: "#ffffff", css: ".tag-rank-3 bg" },
              { label: "Rank-3 Border", color: "#e0e0e0", css: ".tag-rank-3 border" },
              { label: "Rank-3 Text", color: "#4a4a4a", css: ".tag-rank-3 text" },
              { label: "Concept BG", color: "#cce5ff", css: ".custom-concept bg" },
              { label: "Concept Border", color: "#b8daff", css: ".custom-concept border" },
              { label: "Concept Text", color: "#004085", css: ".custom-concept text" },
              { label: "Concept Spark", color: "#005499", css: ".concept-spark" },
              { label: "Remove Btn", color: "#a80000", css: ".tag-remove-btn" },
              { label: "Remove Hover", color: "#e81123", css: ".tag-remove-btn:hover" }
            ].map(c => `
              <div style="display: flex; align-items: center; gap: 8px; padding: 6px; border: 1px solid var(--sys-border-dark); background: var(--sys-window-bg);">
                <div style="width: 24px; height: 24px; border: 1px solid #888; background-color: ${c.color}; flex-shrink: 0;"></div>
                <div style="min-width: 0;">
                  <div style="font-weight: 600; font-size: 10px;">${c.label}</div>
                  <div style="font-size: 10px; color: #666;">${c.color}</div>
                  <div style="font-size: 9px; color: #999;">${c.css}</div>
                </div>
              </div>
            `).join("")}
          </div>
        `
      },
      {
        name: "Concept Badge Colors",
        render: () => `
          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; width: 100%;">
            ${[
              { label: "Character BG", color: "#d1ecf1", css: ".concept-badge.character" },
              { label: "Character Border", color: "#bee5eb", css: ".concept-badge.character" },
              { label: "Character Text", color: "#0c5460", css: ".concept-badge.character" },
              { label: "Copyright BG", color: "#ebdcf9", css: ".concept-badge.copyright" },
              { label: "Copyright Border", color: "#dcbdf5", css: ".concept-badge.copyright" },
              { label: "Copyright Text", color: "#511c74", css: ".concept-badge.copyright" },
              { label: "General BG", color: "#e2e3e5", css: ".concept-badge.general" },
              { label: "General Border", color: "#d6d8db", css: ".concept-badge.general" },
              { label: "General Text", color: "#383d41", css: ".concept-badge.general" },
              { label: "Artist BG", color: "#fff0e6", css: ".concept-badge.artist" },
              { label: "Artist Border", color: "#ffd9c2", css: ".concept-badge.artist" },
              { label: "Artist Text", color: "#7c2d12", css: ".concept-badge.artist" }
            ].map(c => `
              <div style="display: flex; align-items: center; gap: 8px; padding: 6px; border: 1px solid var(--sys-border-dark); background: var(--sys-window-bg);">
                <div style="width: 24px; height: 24px; border: 1px solid #888; background-color: ${c.color}; flex-shrink: 0;"></div>
                <div style="min-width: 0;">
                  <div style="font-weight: 600; font-size: 10px;">${c.label}</div>
                  <div style="font-size: 10px; color: #666;">${c.color}</div>
                  <div style="font-size: 9px; color: #999;">${c.css}</div>
                </div>
              </div>
            `).join("")}
          </div>
        `
      },
      {
        name: "Status & Feedback Colors",
        render: () => `
          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; width: 100%;">
            ${[
              { label: "Success Green", color: "#107c41", css: ".status-dot, .badge-ready" },
              { label: "Success Light", color: "#dff6dd", css: ".badge-ready bg" },
              { label: "Success Alt", color: "#10b981", css: ".copy-btn.copied" },
              { label: "Warning Yellow", color: "#794c00", css: ".badge-pending text" },
              { label: "Warning Light", color: "#fff4ce", css: ".badge-pending bg" },
              { label: "Error Red", color: "#a80000", css: ".status-dot.offline" },
              { label: "Error Bright", color: "#e81123", css: ".modal-close:hover" },
              { label: "Error Active", color: "#bf0f1d", css: ".modal-close:active" },
              { label: "Favorite Gold", color: "#ecc94b", css: ".star-btn.favorite" },
              { label: "Copy Blue", color: "#3b82f6", css: ".copy-btn:hover" },
              { label: "Info Blue", color: "#0078d7", css: "var(--sys-border-focus)" },
              { label: "Spinner Blue", color: "#3b82f6", css: ".spinner-*" }
            ].map(c => `
              <div style="display: flex; align-items: center; gap: 8px; padding: 6px; border: 1px solid var(--sys-border-dark); background: var(--sys-window-bg);">
                <div style="width: 24px; height: 24px; border: 1px solid #888; background-color: ${c.color}; flex-shrink: 0;"></div>
                <div style="min-width: 0;">
                  <div style="font-weight: 600; font-size: 10px;">${c.label}</div>
                  <div style="font-size: 10px; color: #666;">${c.color}</div>
                  <div style="font-size: 9px; color: #999;">${c.css}</div>
                </div>
              </div>
            `).join("")}
          </div>
        `
      },
      {
        name: "Text & Background Colors",
        render: () => `
          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; width: 100%;">
            ${[
              { label: "Black", color: "#000000", css: "Default text" },
              { label: "Dark Gray", color: "#333333", css: "Headings, status" },
              { label: "Medium Gray", color: "#555555", css: "Secondary text" },
              { label: "Subtle Gray", color: "#666666", css: "Labels, hints" },
              { label: "Light Gray", color: "#777777", css: "Muted text" },
              { label: "Muted", color: "#888888", css: "Disabled/hint text" },
              { label: "Faint", color: "#999999", css: "Very muted" },
              { label: "White", color: "#ffffff", css: "Window bg, text on dark" },
              { label: "Off-White", color: "#fafafa", css: "Alt row bg" },
              { label: "Light BG", color: "#f7f7f7", css: "Image preview bg" },
              { label: "Control BG", color: "#ececec", css: "Main panel bg" },
              { label: "Hover BG", color: "#f1f1f1", css: "Nav item hover" },
              { label: "Border Gray", color: "#d0d0d0", css: "Dividers, rules" },
              { label: "Input Border", color: "#7a7a7a", css: "Input fields" },
              { label: "Dark Panel", color: "#1e1e1e", css: "Log viewer, viewer header" },
              { label: "Log Text", color: "#cccccc", css: "Log content text" }
            ].map(c => `
              <div style="display: flex; align-items: center; gap: 8px; padding: 6px; border: 1px solid var(--sys-border-dark); background: var(--sys-window-bg);">
                <div style="width: 24px; height: 24px; border: 1px solid #888; background-color: ${c.color}; flex-shrink: 0;"></div>
                <div style="min-width: 0;">
                  <div style="font-weight: 600; font-size: 10px;">${c.label}</div>
                  <div style="font-size: 10px; color: #666;">${c.color}</div>
                  <div style="font-size: 9px; color: #999;">${c.css}</div>
                </div>
              </div>
            `).join("")}
          </div>
        `
      }
    ]
  },
  {
    name: "Buttons Showcase",
    description: "The classic WinForms style buttons under different states.",
    variants: [
      {
        name: "Standard States & Icons",
        render: () => `
          <div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: center;">
            ${renderButton("Normal Button")}
            ${renderButton("Hover State", { style: "background-color: var(--sys-button-hover); border-color: #3b78d7;" })}
            ${renderButton("Active State", { style: "background-color: var(--sys-button-active); border-color: #005499;" })}
            ${renderButton("Disabled Button", { disabled: true })}
            ${renderButton("Button with Icon", { icon: "bi bi-play-fill" })}
          </div>
        `
      },
      {
        name: "Primary & Danger Variants",
        render: () => `
          <div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: center;">
            ${renderButton("Primary Button", { className: "win-button primary" })}
            ${renderButton("Primary with Icon", { className: "win-button primary", icon: "bi bi-check-lg" })}
            ${renderButton("Danger Button", { className: "win-button danger" })}
            ${renderButton("Danger with Icon", { className: "win-button danger", icon: "bi bi-trash" })}
          </div>
        `
      }
    ]
  },
  {
    name: "Form Inputs Showcase",
    description: "Input fields, clearable fields, and selection dropdown elements.",
    variants: [
      {
        name: "Inputs & Selectors",
        render: () => `
          <div style="display: flex; flex-wrap: wrap; gap: 16px; align-items: center; width: 100%;">
            <div class="form-group">
              <label style="font-weight: 600;">Text Field:</label>
              ${renderInputField({ placeholder: "Enter text..." })}
            </div>
            <div class="form-group">
              <label style="font-weight: 600;">Focused Field:</label>
              ${renderInputField({ style: "border-color: var(--sys-border-focus);", value: "Focused style preview" })}
            </div>
            <div class="form-group">
              <label style="font-weight: 600;">With Clear Button:</label>
              ${renderInputField({ hasClear: true, value: "Clearable value..." })}
            </div>
            <div class="form-group">
              <label style="font-weight: 600;">Dropdown / Select:</label>
              <select class="input-field" style="width: 150px;">
                <option selected>Option 1 (Default)</option>
                <option>Option 2</option>
                <option>Option 3</option>
              </select>
            </div>
          </div>
        `
      }
    ]
  },
  {
    name: "Layout & Display Cards",
    description: "Stat cards grid and dynamic image catalog items.",
    variants: [
      {
        name: "Stats Grid",
        render: () => `
          <div class="stats-grid" style="width: 100%;">
            ${renderStatCard("Stat Label 1", "1,234")}
            ${renderStatCard("Stat Label 2 (Highlighted)", "Active Info", { style: "color: var(--sys-border-focus);" })}
            ${renderStatCard("Interactive Stat Card", "Clickable element", { style: "cursor: pointer;" })}
          </div>
        `
      },
      {
        name: "Image Cards (Ready vs Pending states)",
        render: () => `
          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; width: 100%;">
            ${renderImageCard("", "C:\\Users\\demo\\Pictures\\sample_image.png", {
              badgeClass: "badge-ready",
              badgeText: "Ready",
              tagPillsHtml: [
                renderTagPill({ tag: "user-tag", category: "user" }, { isDeletable: true }),
                renderTagPill({ tag: "character", category: "character" }),
                renderTagPill({ tag: "copyright", category: "copyright" })
              ].join("")
            })}
            ${renderImageCard("", "C:\\Users\\demo\\Pictures\\another_photo.jpg", {
              badgeClass: "badge-pending",
              badgeText: "Pending",
              tagPillsHtml: [
                renderTagPill({ tag: "meta-tag", category: "meta" }),
                renderTagPill({ tag: "rank-3", category: "general" })
              ].join("")
            })}
          </div>
        `
      }
    ]
  },
  {
    name: "Tag Pills Showcase",
    description: "Tag indicators styled uniquely by categories (user, character, series copyright, system meta, etc.).",
    variants: [
      {
        name: "Status Badges",
        render: () => `
          <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center;">
            <span class="vector-badge badge-ready" style="position: static;">badge-ready (Ready)</span>
            <span class="vector-badge badge-pending" style="position: static;">badge-pending (Pending)</span>
          </div>
        `
      },
      {
        name: "Tag Pill Variants",
        render: () => `
          <div style="display: flex; flex-direction: column; gap: 8px;">
            ${[
              { label: "User-added tag (with remove button):", tag: { tag: "user-tag", category: "user" }, opt: { isDeletable: true } },
              { label: "Character identifier:", tag: { tag: "character_name", category: "character" } },
              { label: "Copyright franchise / series:", tag: { tag: "series_title", category: "copyright" } },
              { label: "System/Meta information:", tag: { tag: "meta_info", category: "meta" } },
              { label: "Artist tag:", tag: { tag: "artist_name", category: "artist" } },
              { label: "Generic tag (Rank 3):", tag: { tag: "generic_tag", category: "general" } }
            ].map(item => `
              <div style="display: flex; align-items: center; gap: 12px;">
                <span style="font-size: 11px; color: #555; min-width: 200px;">${item.label}</span>
                ${renderTagPill(item.tag, item.opt)}
              </div>
            `).join("")}
          </div>
        `
      }
    ]
  },
  {
    name: "Concept Badges Showcase",
    description: "Category badges used on concept cards to indicate type (character, copyright, general, artist).",
    variants: [
      {
        name: "All Badge Variants",
        render: () => `
          <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center;">
            <span class="concept-badge character">CHARACTER</span>
            <span class="concept-badge copyright">COPYRIGHT</span>
            <span class="concept-badge general">GENERAL</span>
            <span class="concept-badge artist">ARTIST</span>
          </div>
        `
      }
    ]
  },
  {
    name: "Menu & Strip Containers",
    description: "Layout rows for top-level menus, contextual tool buttons, and bottom status strips.",
    variants: [
      {
        name: "Classic Menu Bar",
        render: () => `
          <nav class="menu-strip" style="position: static; border: 1px solid var(--sys-menu-border); width: 100%;">
            <div class="menu-item"><span>F</span>ile</div>
            <div class="menu-item"><span>E</span>dit</div>
            <div class="menu-item"><span>V</span>iew</div>
            <div class="menu-item"><span>T</span>ools</div>
            <div class="menu-item"><span>H</span>elp</div>
          </nav>
        `
      },
      {
        name: "Tool Buttons Strip",
        render: () => `
          <div class="tool-strip" style="border: 1px solid var(--sys-border-dark); width: 100%;">
            ${renderButton("Open", { className: "tool-strip-btn", icon: "bi bi-folder2-open" })}
            ${renderButton("Save", { className: "tool-strip-btn", icon: "bi bi-save" })}
            <div class="tool-strip-separator"></div>
            ${renderButton("Refresh", { className: "tool-strip-btn", icon: "bi bi-arrow-clockwise" })}
          </div>
        `
      },
      {
        name: "Status Footer Strip",
        render: () => `
          <footer class="status-strip" style="position: static; border: 1px solid var(--sys-border-dark); width: 100%;">
            <div class="status-cell">
              <div class="status-dot"></div>
              <span>Service Connected</span>
            </div>
            <div class="status-cell">
              <div class="status-dot offline"></div>
              <span>Service Disconnected</span>
            </div>
            <div class="status-cell">
              <span>Ready</span>
            </div>
          </footer>
        `
      }
    ]
  },
  {
    name: "Loading & Progress",
    description: "Skeleton placeholders, progress bars, spinners, and indeterminate loaders for async states.",
    variants: [
      {
        name: "Skeleton Placeholders",
        render: () => `
          <div style="display: flex; flex-direction: column; gap: 12px; width: 100%;">
            <div style="font-size: 11px; font-weight: 600; color: #555;">Text Skeleton</div>
            <div style="display: flex; flex-direction: column; gap: 6px;">
              <div class="skeleton-text skeleton-pulse" style="width: 80%; height: 12px;"></div>
              <div class="skeleton-text skeleton-pulse" style="width: 60%; height: 12px;"></div>
              <div class="skeleton-text skeleton-pulse" style="width: 90%; height: 12px;"></div>
            </div>
            <div style="font-size: 11px; font-weight: 600; color: #555; margin-top: 8px;">Card Skeleton</div>
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px;">
              <div class="skeleton-card skeleton-pulse" style="height: 160px; border-radius: 4px;"></div>
              <div class="skeleton-card skeleton-pulse" style="height: 160px; border-radius: 4px;"></div>
              <div class="skeleton-card skeleton-pulse" style="height: 160px; border-radius: 4px;"></div>
            </div>
            <div style="font-size: 11px; font-weight: 600; color: #555; margin-top: 8px;">Circle / Avatar Skeleton</div>
            <div style="display: flex; gap: 10px; align-items: center;">
              <div class="skeleton-pulse" style="width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0;"></div>
              <div style="flex: 1; display: flex; flex-direction: column; gap: 5px;">
                <div class="skeleton-text skeleton-pulse" style="width: 50%; height: 10px;"></div>
                <div class="skeleton-text skeleton-pulse" style="width: 30%; height: 10px;"></div>
              </div>
            </div>
          </div>
        `
      },
      {
        name: "Progress Bars",
        render: () => `
          <div style="display: flex; flex-direction: column; gap: 14px; width: 100%;">
            <div>
              <div style="font-size: 11px; font-weight: 600; color: #555; margin-bottom: 4px;">Determinate — 0%</div>
              <div style="width: 100%; height: 8px; background-color: #e5e7eb; border-radius: 4px; overflow: hidden;">
                <div style="width: 0%; height: 100%; background-color: #3b82f6; transition: width 0.3s ease;"></div>
              </div>
            </div>
            <div>
              <div style="font-size: 11px; font-weight: 600; color: #555; margin-bottom: 4px;">Determinate — 35%</div>
              <div style="width: 100%; height: 8px; background-color: #e5e7eb; border-radius: 4px; overflow: hidden;">
                <div style="width: 35%; height: 100%; background-color: #3b82f6; transition: width 0.3s ease;"></div>
              </div>
            </div>
            <div>
              <div style="font-size: 11px; font-weight: 600; color: #555; margin-bottom: 4px;">Determinate — 72%</div>
              <div style="width: 100%; height: 8px; background-color: #e5e7eb; border-radius: 4px; overflow: hidden;">
                <div style="width: 72%; height: 100%; background-color: #3b82f6; transition: width 0.3s ease;"></div>
              </div>
            </div>
            <div>
              <div style="font-size: 11px; font-weight: 600; color: #555; margin-bottom: 4px;">Determinate — 100% (Complete)</div>
              <div style="width: 100%; height: 8px; background-color: #e5e7eb; border-radius: 4px; overflow: hidden;">
                <div style="width: 100%; height: 100%; background-color: #10b981; transition: width 0.3s ease;"></div>
              </div>
            </div>
            <div>
              <div style="font-size: 11px; font-weight: 600; color: #555; margin-bottom: 4px;">Indeterminate (Animated)</div>
              <div style="width: 100%; height: 8px; background-color: #e5e7eb; border-radius: 4px; overflow: hidden; position: relative;">
                <div class="progress-indeterminate" style="position: absolute; top: 0; left: 0; width: 40%; height: 100%; background-color: #3b82f6; border-radius: 4px;"></div>
              </div>
            </div>
            <div>
              <div style="font-size: 11px; font-weight: 600; color: #555; margin-bottom: 4px;">Large Progress — 60%</div>
              <div style="width: 100%; height: 16px; background-color: #e5e7eb; border-radius: 4px; overflow: hidden; border: 1px solid #d1d5db;">
                <div style="width: 60%; height: 100%; background-color: var(--sys-primary, #0078d4); transition: width 0.3s ease;"></div>
              </div>
            </div>
            <div>
              <div style="font-size: 11px; font-weight: 600; color: #555; margin-bottom: 4px;">Segmented Progress (Preprocessing + Indexing)</div>
              <div style="width: 100%; height: 10px; background-color: #e5e7eb; border-radius: 4px; overflow: hidden; display: flex;">
                <div style="width: 80%; height: 100%; background-color: #3b82f6;"></div>
                <div style="width: 15%; height: 100%; background-color: #10b981;"></div>
              </div>
              <div style="display: flex; justify-content: space-between; font-size: 10px; color: #888; margin-top: 3px;">
                <span>Preprocessing (80%)</span>
                <span>Indexed (15%)</span>
              </div>
            </div>
          </div>
        `
      },
      {
        name: "Spinners & Loaders",
        render: () => `
          <div style="display: flex; flex-wrap: wrap; gap: 24px; align-items: center;">
            <div style="display: flex; flex-direction: column; align-items: center; gap: 6px;">
              <div class="spinner-css-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                  <path d="M21 3v5h-5" />
                </svg>
              </div>
              <span style="font-size: 10px; color: #888;">Icon Spinner</span>
            </div>
            <div style="display: flex; flex-direction: column; align-items: center; gap: 6px;">
              <div class="spinner-ring" style="width: 24px; height: 24px;"></div>
              <span style="font-size: 10px; color: #888;">CSS Ring</span>
            </div>
            <div style="display: flex; flex-direction: column; align-items: center; gap: 6px;">
              <div class="spinner-dots">
                <span></span><span></span><span></span>
              </div>
              <span style="font-size: 10px; color: #888;">Bouncing Dots</span>
            </div>
            <div style="display: flex; flex-direction: column; align-items: center; gap: 6px;">
              <div class="spinner-bar"></div>
              <span style="font-size: 10px; color: #888;">Pulse Bar</span>
            </div>
          </div>
        `
      }
    ]
  }
];
