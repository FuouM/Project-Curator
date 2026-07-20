export interface TagSummary {
  tag: string;
  category: string;
  count?: number;
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
  }

  const isDeletable = options?.isDeletable ?? false;
  const imageId = options?.imageId ?? 0;

  const deleteBtn = isDeletable && t.category === "user"
    ? ` <span class="tag-remove-btn" title="Remove user tag" onclick="window.removeTag(${imageId}, '${t.tag}')">&times;</span>`
    : "";

  return `<span class="tag-pill ${styleClass}">${t.tag.replace(/_/g, '_\u200B')}${deleteBtn}</span>`;
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
    description: "Active theme palette based on the Windows Classic Control Panel style CSS variables.",
    variants: [
      {
        name: "Standard Palette (CSS variables mapped to values)",
        render: () => `
          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; width: 100%;">
            ${[
              { name: "--sys-control-bg", color: "#ececec" },
              { name: "--sys-control-text", color: "#000000" },
              { name: "--sys-window-bg", color: "#ffffff" },
              { name: "--sys-border-dark", color: "#b0b0b0" },
              { name: "--sys-border-focus", color: "#0078d7" },
              { name: "--sys-button-bg", color: "#f0f0f0" },
              { name: "--sys-button-hover", color: "#e5f1fb" },
              { name: "--sys-button-active", color: "#cce4f7" }
            ].map(c => `
              <div style="display: flex; align-items: center; gap: 8px; padding: 6px; border: 1px solid var(--sys-border-dark); background: var(--sys-window-bg);">
                <div style="width: 24px; height: 24px; border: 1px solid #000; background-color: var(${c.name});"></div>
                <div>
                  <div style="font-weight: bold; font-size: 11px;">${c.name}</div>
                  <div style="font-size: 10px; color: #666;">${c.color}</div>
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
  }
];
