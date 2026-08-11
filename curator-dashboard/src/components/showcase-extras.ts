import type { ComponentMeta } from './_shared';
import { html } from './_shared';
import { renderButton } from './button';
import { renderInputField } from './input-field';
import { renderStatCard } from './stat-card';
import { renderImageCard } from './image-card';
import { renderTagPill } from './tag-pill';

export const metas: ComponentMeta[] = [
  {
    name: "System Color Palette",
    description: "Complete color reference organized by component. Use this to find and update any color in the stylesheet.",
    variants: [
      {
        name: "Theme Variables (CSS Custom Properties)",
        render: () => html`
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
        render: () => html`
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
        render: () => html`
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
        render: () => html`
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
        render: () => html`
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
        render: () => html`
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
        render: () => html`
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
        render: () => html`
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
        render: () => html`
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
        render: () => html`
          <div class="stats-grid" style="width: 100%;">
            ${renderStatCard("Stat Label 1", "1,234")}
            ${renderStatCard("Stat Label 2 (Highlighted)", "Active Info", { style: "color: var(--sys-border-focus);" })}
            ${renderStatCard("Interactive Stat Card", "Clickable element", { style: "cursor: pointer;" })}
          </div>
        `
      },
      {
        name: "Image Cards (Ready vs Pending states)",
        render: () => html`
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
        render: () => html`
          <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center;">
            <span class="vector-badge badge-ready" style="position: static;">badge-ready (Ready)</span>
            <span class="vector-badge badge-pending" style="position: static;">badge-pending (Pending)</span>
          </div>
        `
      },
      {
        name: "Tag Pill Variants",
        render: () => html`
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
        render: () => html`
          <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center;">
            <span class="concept-badge character">CHARACTER</span>
            <span class="concept-badge copyright">COPYRIGHT</span>
            <span class="concept-badge general">GENERAL</span>
            <span class="concept-badge artist">ARTIST</span>
            <span class="concept-badge user">USER</span>
            <span class="concept-badge meta">META</span>
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
        render: () => html`
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
        render: () => html`
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
        render: () => html`
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
        render: () => html`
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
        render: () => html`
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
        render: () => html`
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
  },

  {
    name: "GroupBox Panel",
    description: "Native WinForms fieldset-style containers with optional collapsible body sections.",
    variants: [
      {
        name: "Standard & Collapsible",
        render: () => html`
          <div style="display: flex; flex-direction: column; gap: 16px; width: 100%;">
            <div class="group-box">
              <div class="group-box-title"><i class="bi bi-folder2-open"></i> Standard GroupBox</div>
              <div class="group-box-body">
                <p style="font-size: 11px; color: #555;">This is a standard group-box container with a fixed title bar. Content renders below the title.</p>
                <div style="display: flex; gap: 8px;">
                  ${renderButton("Action A")}
                  ${renderButton("Action B", { className: "win-button primary" })}
                </div>
              </div>
            </div>
            <div class="group-box collapsed">
              <div class="group-box-title">
                <i class="bi bi-gear-wide-connected"></i> Collapsed GroupBox
                <button type="button" class="group-box-collapse-btn"><i class="bi bi-chevron-down"></i></button>
              </div>
              <div class="group-box-body" style="display: none;">
                <p style="font-size: 11px; color: #555;">This content is hidden when collapsed. Click the chevron to toggle.</p>
              </div>
            </div>
          </div>
        `
      }
    ]
  },

  {
    name: "Modal Dialog",
    description: "Standard WinForms-style modal dialog overlay with header, body, and footer action bar.",
    variants: [
      {
        name: "Dialog Structure",
        render: () => html`
          <div style="width: 100%; max-width: 420px; border: 1px solid #7a7a7a; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2); background-color: var(--sys-control-bg);">
            <div class="modal-header">
              <span class="modal-title"><i class="bi bi-info-circle"></i> Sample Dialog</span>
              <div class="modal-close">&times;</div>
            </div>
            <div class="modal-body">
              <p style="font-size: 12px; color: #333;">This is a modal dialog body. It contains the main content area for forms, messages, or details.</p>
              <div class="form-group">
                <label style="font-weight: 600;">Label:</label>
                ${renderInputField({ placeholder: "Enter value..." })}
              </div>
            </div>
            <div class="modal-footer">
              ${renderButton("Cancel")}
              ${renderButton("Confirm", { className: "win-button primary", icon: "bi bi-check-lg" })}
            </div>
          </div>
        `
      },
      {
        name: "Close Button States",
        render: () => html`
          <div style="display: flex; gap: 12px; align-items: center;">
            <div style="background-color: #0078d7; color: #fff; padding: 4px 10px; display: flex; align-items: center; gap: 8px;">
              <span style="font-weight: bold; font-size: 12px;">Title Bar</span>
              <div class="modal-close" style="margin: -4px -10px; padding: 4px 10px; position: static;">&times;</div>
            </div>
            <span style="font-size: 10px; color: #888;">Hover: #e81123 (red)</span>
          </div>
        `
      }
    ]
  },

  {
    name: "Alert Dialog",
    description: "Centered modal alert with a copy button for the full message, used to surface errors and notices.",
    variants: [
      {
        name: "Trigger Buttons",
        render: () => html`
          <div style="display: flex; flex-wrap: wrap; gap: 8px;">
            <button type="button" class="win-button danger" data-action="show-alert-demo" data-alert-kind="error"><i class="bi bi-exclamation-octagon-fill"></i> Trigger Error Alert</button>
            <button type="button" class="win-button" data-action="show-alert-demo" data-alert-kind="warning"><i class="bi bi-exclamation-triangle-fill"></i> Trigger Warning Alert</button>
            <button type="button" class="win-button" data-action="show-alert-demo" data-alert-kind="info"><i class="bi bi-info-circle-fill"></i> Trigger Info Alert</button>
            <button type="button" class="win-button" data-action="show-alert-demo" data-alert-kind="success"><i class="bi bi-check-circle-fill"></i> Trigger Success Alert</button>
          </div>
        `
      }
    ]
  },

  {
    name: "Image Viewer",
    description: "Full-screen lightbox overlay for viewing images at full resolution with navigation controls.",
    variants: [
      {
        name: "Viewer Structure",
        render: () => html`
          <div style="width: 100%; display: flex; flex-direction: column; border: 1px solid #555; background-color: #1e1e1e;">
            <div class="image-viewer-header">
              <span class="image-viewer-title"><i class="bi bi-image"></i> sample_image.png — C:\\Users\\demo\\Pictures\\</span>
              <div class="image-viewer-header-actions">
                <button class="image-viewer-btn"><i class="bi bi-clipboard"></i> Copy</button>
                <button class="image-viewer-btn"><i class="bi bi-info-circle"></i> Info</button>
                <button class="image-viewer-btn"><i class="bi bi-folder2-open"></i> Open Folder</button>
                <div class="image-viewer-close">&times;</div>
              </div>
            </div>
            <div class="image-viewer-content" style="height: 200px;">
              <div class="image-viewer-body" style="background-color: #2d2d2d;">
                <div style="color: #888; font-size: 12px; text-align: center;">
                  <i class="bi bi-image" style="font-size: 48px; display: block; margin-bottom: 8px;"></i>
                  Image preview area
                </div>
              </div>
              <div class="image-viewer-info-panel open" style="height: 200px;">
                <div class="image-viewer-info-header">
                  <span class="image-viewer-title"><i class="bi bi-info-circle"></i> Image Details</span>
                  <span class="image-viewer-close" title="Close">&times;</span>
                </div>
                <div class="image-viewer-info-body">
                  <div style="color: #555; font-size: 12px; font-style: italic;">Docked details panel content</div>
                </div>
              </div>
            </div>
          </div>
        `
      },
      {
        name: "Viewer Buttons",
        render: () => html`
          <div style="display: flex; gap: 8px; align-items: center;">
            <button class="image-viewer-btn"><i class="bi bi-clipboard"></i> Copy Image</button>
            <button class="image-viewer-btn"><i class="bi bi-folder2-open"></i> Open Folder</button>
            <button class="image-viewer-btn"><i class="bi bi-search"></i> Find Similar</button>
            <div style="width: 1px; height: 20px; background-color: #555;"></div>
            <div class="image-viewer-close" style="background-color: #333; border: 1px solid #555; padding: 2px 8px;">&times;</div>
          </div>
        `
      }
    ]
  },

  {
    name: "Featured Card",
    description: "Feature of the Day highlight card with large preview, overlay badge, and action buttons.",
    variants: [
      {
        name: "Featured Layout",
        render: () => html`
          <div class="featured-layout" style="width: 100%;">
            <div class="image-card featured-card">
              <div class="star-btn favorite" style="position: static; opacity: 1;"><i class="bi bi-star-fill"></i></div>
              <div class="image-preview featured-preview" style="height: 200px; background-color: #f7f7f7; position: relative;">
                <div style="color: #888; text-align: center;"><i class="bi bi-image" style="font-size: 32px;"></i></div>
                <div class="vector-badge badge-ready">ready</div>
                <div class="featured-badge-overlay"><i class="bi bi-stars"></i> Feature of the Day</div>
                <div class="copy-btn" style="position: absolute; bottom: 1px; left: 1px; opacity: 0;"><i class="bi bi-clipboard"></i></div>
              </div>
              <div style="padding: 6px 2px; display: flex; gap: 6px;">
                <button class="win-button" style="font-size: 11px; flex: 1;"><i class="bi bi-tag"></i> Tags</button>
                <button class="win-button" style="font-size: 11px; flex: 1;"><i class="bi bi-search"></i> Similar</button>
              </div>
            </div>
            <div class="featured-details">
              <div class="featured-filename" title="sample_image.png">sample_image.png</div>
              <div class="image-path-row">
                <div class="image-path" title="C:\\Users\\demo\\Pictures\\sample_image.png">C:\\...\\sample_image.png</div>
                <button class="win-button image-open-folder-btn" style="font-size: 10px; padding: 1px 6px;"><i class="bi bi-folder2-open"></i></button>
              </div>
              <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px;">
                ${renderTagPill({ tag: "character_name", category: "character" })}
                ${renderTagPill({ tag: "artist_name", category: "artist" })}
                ${renderTagPill({ tag: "series_title", category: "copyright" })}
              </div>
            </div>
          </div>
        `
      }
    ]
  },

  {
    name: "Navigation Sidebar",
    description: "TreeView sidebar with hierarchical navigation items and active state indicators.",
    variants: [
      {
        name: "Sidebar Structure",
        render: () => html`
          <div class="sidebar" style="width: 220px; height: 280px; position: static;">
            <ul class="tree-view">
              <li class="tree-node">
                <div class="tree-node-title"><i class="bi bi-chevron-down"></i> Library</div>
                <ul class="tree-leaf-list">
                  <li class="nav-item active"><i class="bi bi-grid-3x3-gap"></i> Gallery</li>
                  <li class="nav-item"><i class="bi bi-search"></i> Search</li>
                  <li class="nav-item"><i class="bi bi-star"></i> Favorites</li>
                </ul>
              </li>
              <li class="tree-node">
                <div class="tree-node-title"><i class="bi bi-chevron-right"></i> Management</div>
              </li>
              <li class="tree-node">
                <div class="tree-node-title"><i class="bi bi-chevron-right"></i> Tools</div>
              </li>
            </ul>
          </div>
        `
      },
      {
        name: "Nav Item States",
        render: () => html`
          <div style="display: flex; flex-direction: column; gap: 2px; width: 200px;">
            <div class="nav-item"><i class="bi bi-grid-3x3-gap"></i> Default (hover me)</div>
            <div class="nav-item active"><i class="bi bi-grid-3x3-gap"></i> Active / Selected</div>
            <div class="nav-item"><i class="bi bi-search"></i> Search</div>
            <div class="nav-item"><i class="bi bi-star"></i> Favorites</div>
            <div class="nav-item"><i class="bi bi-folder"></i> Folders</div>
          </div>
        `
      }
    ]
  },

  {
    name: "Tag Statistics",
    description: "Tag frequency display with bar charts, pill lists, and category groupings.",
    variants: [
      {
        name: "Bar Chart View",
        render: () => html`
          <div class="tagstats-chart" style="max-height: none; width: 100%;">
            ${[
              { tag: "1girl", count: 1247, pct: 100, color: "#0078d7" },
              { tag: "solo", count: 892, pct: 71.5, color: "#107c41" },
              { tag: "long_hair", count: 634, pct: 50.8, color: "#794c00" },
              { tag: "white_background", count: 421, pct: 33.8, color: "#a80000" }
            ].map(t => `
              <div class="tagstats-bar-row">
                <span class="tagstats-bar-label" title="${t.tag}">${t.tag}</span>
                <div class="tagstats-bar-track">
                  <div class="tagstats-bar-fill" style="width: ${t.pct}%; background: ${t.color};"></div>
                </div>
                <span class="tagstats-bar-count">${t.count}</span>
              </div>
            `).join("")}
          </div>
        `
      },
      {
        name: "Pill List View",
        render: () => html`
          <div class="tagstats-list" style="max-height: none;">
            ${[
              { tag: "1girl", category: "meta", count: 1247 },
              { tag: "solo", category: "meta", count: 892 },
              { tag: "character_name", category: "character", count: 312 },
              { tag: "artist_name", category: "artist", count: 187 },
              { tag: "series_title", category: "copyright", count: 98 },
              { tag: "user_tag", category: "user", count: 45 }
            ].map(t => `
              <span class="tag-pill tagstats-pill tag-${t.category}" data-tag="${t.tag}" title="${t.tag} (${t.count} images)">
                ${t.tag.replace(/_/g, '_\u200B')}
                <span class="tagstats-badge">${t.count}</span>
              </span>
            `).join("")}
          </div>
        `
      },
      {
        name: "Category Header",
        render: () => html`
          <div class="tagstats-category">
            <div class="tagstats-category-header">
              <span class="tagstats-category-title" style="color: #0078d7;">Meta Tags <span class="tagstats-count">(48)</span></span>
              <button class="win-button tagstats-chart-toggle" style="font-size: 10px;"><i class="bi bi-bar-chart"></i> Chart</button>
            </div>
          </div>
        `
      }
    ]
  },

  {
    name: "Image Path Row",
    description: "Image file path display with copy-to-clipboard, open folder, and path masking controls.",
    variants: [
      {
        name: "Path Row with Actions",
        render: () => html`
          <div style="display: flex; flex-direction: column; gap: 12px; width: 100%;">
            <div style="padding: 8px; background: var(--sys-window-bg); border: 1px solid var(--sys-border-dark);">
              <div class="image-path-row">
                <div class="image-path" title="C:\\Users\\demo\\Pictures\\Artists\\sample_image.png" style="cursor: pointer;">C:\\...\\sample_image.png</div>
                <button class="win-button image-open-folder-btn" style="font-size: 10px; padding: 1px 6px; white-space: nowrap;">
                  <i class="bi bi-folder2-open"></i> Open
                </button>
              </div>
            </div>
            <div style="padding: 8px; background: var(--sys-window-bg); border: 1px solid var(--sys-border-dark);">
              <div class="image-path-row">
                <div class="image-path" title="D:\\Gallery\\2026\\vacation_photo.jpg" style="cursor: pointer;">D:\\...\\vacation_photo.jpg</div>
                <button class="win-button image-open-folder-btn" style="font-size: 10px; padding: 1px 6px; white-space: nowrap;">
                  <i class="bi bi-folder2-open"></i> Open
                </button>
              </div>
            </div>
          </div>
        `
      },
      {
        name: "Copy & Favorite Buttons",
        render: () => html`
          <div style="display: flex; gap: 16px; align-items: center;">
            <div style="position: relative; display: inline-flex;">
              <div class="copy-btn" style="position: static; opacity: 1; background: var(--sys-window-bg); border: 1px solid #dcdcdc;">
                <i class="bi bi-clipboard"></i>
              </div>
              <span style="font-size: 10px; color: #888; margin-left: 6px;">Copy to clipboard</span>
            </div>
            <div style="position: relative; display: inline-flex;">
              <div class="star-btn favorite" style="position: static; opacity: 1;">
                <i class="bi bi-star-fill"></i>
              </div>
              <span style="font-size: 10px; color: #888; margin-left: 6px;">Favorite toggle</span>
            </div>
          </div>
        `
      }
    ]
  },

  {
    name: "OCR Text Block",
    description: "Expandable monospace text block for displaying OCR-extracted text from images. Click to toggle between collapsed (5 lines) and expanded state; hover the file-earmark icon to reveal the copy button that copies the OCR text.",
    variants: [
      {
        name: "Collapsed & Expanded States",
        render: () => html`
          <div style="display: flex; flex-direction: column; gap: 12px; width: 100%;">
            <div style="font-size: 11px; font-weight: 600; color: #555;">Collapsed (default)</div>
            <div class="ocr-block" style="position: static;">
              <i class="bi bi-file-earmark-text ocr-icon" title="Copy OCR text"></i>
              <span class="ocr-block-text">This is sample OCR extracted text from an image. It can contain multiple lines of text that were recognized by the optical character recognition engine. The text is displayed in a monospace font and is truncated when collapsed.</span>
            </div>
            <div style="font-size: 11px; font-weight: 600; color: #555;">Expanded state</div>
            <div class="ocr-block expanded" style="position: static;">
              <i class="bi bi-file-earmark-text ocr-icon" title="Copy OCR text"></i>
              <span class="ocr-block-text">This is sample OCR extracted text from an image. It can contain multiple lines of text that were recognized by the optical character recognition engine. The text is displayed in a monospace font and shows all content when expanded. Click the block to toggle between states.</span>
            </div>
          </div>
        `
      }
    ]
  },

  {
    name: "Autocomplete Dropdown",
    description: "Typeahead suggestion dropdown for input fields. Shows matching items with count badges and supports keyboard navigation.",
    variants: [
      {
        name: "Dropdown with Suggestions",
        render: () => html`
          <div style="display: flex; flex-direction: column; gap: 12px; width: 100%; max-width: 300px;">
            <div style="position: relative;">
              <input class="input-field" style="width: 100%;" value="cha" readonly />
              <div class="autocomplete-dropdown" style="position: relative; top: 0; width: 100%; box-shadow: none; border: 1px solid var(--sys-border-dark);">
                <div class="autocomplete-item active">
                  <span class="autocomplete-item-tag">character_name</span>
                  <span class="autocomplete-item-count">312</span>
                </div>
                <div class="autocomplete-item">
                  <span class="autocomplete-item-tag">character_outfit</span>
                  <span class="autocomplete-item-count">89</span>
                </div>
                <div class="autocomplete-item">
                  <span class="autocomplete-item-tag">character_pose</span>
                  <span class="autocomplete-item-count">45</span>
                </div>
              </div>
            </div>
          </div>
        `
      }
    ]
  },

  {
    name: "Range Slider",
    description: "Labeled range slider for numeric settings like similarity thresholds. Displays current value with accent-colored track.",
    variants: [
      {
        name: "Threshold Slider Control",
        render: () => html`
          <div style="width: 100%; max-width: 320px;">
            <div class="concept-threshold-box">
              <div class="concept-threshold-header">
                <span>Similarity Threshold</span>
                <span class="concept-threshold-val">0.75 (75%)</span>
              </div>
              <input type="range" class="concept-threshold-slider" min="0" max="100" value="75" />
            </div>
          </div>
        `
      },
      {
        name: "Slider Variants",
        render: () => html`
          <div style="display: flex; flex-direction: column; gap: 16px; width: 100%; max-width: 320px;">
            <div class="concept-threshold-box">
              <div class="concept-threshold-header">
                <span>Low Threshold</span>
                <span class="concept-threshold-val">0.30 (30%)</span>
              </div>
              <input type="range" class="concept-threshold-slider" min="0" max="100" value="30" />
            </div>
            <div class="concept-threshold-box">
              <div class="concept-threshold-header">
                <span>High Threshold</span>
                <span class="concept-threshold-val">0.92 (92%)</span>
              </div>
              <input type="range" class="concept-threshold-slider" min="0" max="100" value="92" />
            </div>
          </div>
        `
      }
    ]
  },

  {
    name: "Identity Tags",
    description: "Character identity tag pills with reddish-pink styling and person icon, used on image cards to show detected characters.",
    variants: [
      {
        name: "Identity Tag Variants",
        render: () => html`
          <div style="display: flex; flex-direction: column; gap: 10px;">
            <div style="font-size: 11px; font-weight: 600; color: #555;">Identity List (with border separator)</div>
            <div class="identity-list">
              <span class="tag-pill tag-identity"><i class="bi bi-person-fill"></i> Character A</span>
              <span class="tag-pill tag-identity"><i class="bi bi-person-fill"></i> Character B</span>
              <span class="tag-pill tag-identity"><i class="bi bi-person-fill"></i> Character C</span>
            </div>
            <div style="font-size: 11px; font-weight: 600; color: #555;">Single Identity Tag</div>
            <div style="display: flex; gap: 6px;">
              <span class="tag-pill tag-identity"><i class="bi bi-person-fill"></i> Solo Character</span>
            </div>
          </div>
        `
      }
    ]
  },

  {
    name: "Image Card Overlay Buttons",
    description: "Action buttons that appear on hover over image cards: star/favorite, copy to clipboard, and info details.",
    variants: [
      {
        name: "Star / Favorite Button",
        render: () => html`
          <div style="display: flex; gap: 16px; align-items: center;">
            <div style="display: flex; flex-direction: column; align-items: center; gap: 4px;">
              <div class="star-btn" style="position: static; opacity: 1; background: var(--sys-window-bg); border: 1px solid #dcdcdc;"><i class="bi bi-star"></i></div>
              <span style="font-size: 10px; color: #888;">Default</span>
            </div>
            <div style="display: flex; flex-direction: column; align-items: center; gap: 4px;">
              <div class="star-btn favorite" style="position: static; opacity: 1;"><i class="bi bi-star-fill"></i></div>
              <span style="font-size: 10px; color: #888;">Favorited</span>
            </div>
          </div>
        `
      },
      {
        name: "Copy & Info Buttons",
        render: () => html`
          <div style="display: flex; gap: 16px; align-items: center;">
            <div style="display: flex; flex-direction: column; align-items: center; gap: 4px;">
              <div class="copy-btn" style="position: static; opacity: 1; background: var(--sys-window-bg); border: 1px solid #dcdcdc;"><i class="bi bi-clipboard"></i></div>
              <span style="font-size: 10px; color: #888;">Copy</span>
            </div>
            <div style="display: flex; flex-direction: column; align-items: center; gap: 4px;">
              <div class="copy-btn copied" style="position: static; opacity: 1;"><i class="bi bi-check-lg"></i></div>
              <span style="font-size: 10px; color: #888;">Copied</span>
            </div>
            <div style="display: flex; flex-direction: column; align-items: center; gap: 4px;">
              <div class="info-btn" style="position: static; opacity: 1; background: var(--sys-window-bg); border: 1px solid #dcdcdc;"><i class="bi bi-info-circle"></i></div>
              <span style="font-size: 10px; color: #888;">Info</span>
            </div>
          </div>
        `
      }
    ]
  },

  {
    name: "Data Tables",
    description: "Styled data tables for displaying structured information with alternating rows, hover states, and status indicators.",
    variants: [
      {
        name: "Folders Table",
        render: () => html`
          <table class="folders-table" style="width: 100%;">
            <thead>
              <tr>
                <th style="text-align: center;">Status</th>
                <th style="text-align: left;">Folder Name</th>
                <th style="text-align: right;">Images</th>
                <th style="text-align: right;">Vectors</th>
                <th style="text-align: center;">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr class="folders-row">
                <td style="text-align: center;"><i class="bi bi-check-circle" style="color: #2e7d32;"></i></td>
                <td style="font-weight: 600;">My Photos</td>
                <td style="text-align: right;">1,234</td>
                <td style="text-align: right;"><span style="color: #2e7d32;">1,100</span> / 1,234</td>
                <td style="text-align: center;"><button class="win-button folders-open-btn" style="font-size: 11px; padding: 2px 8px;"><i class="bi bi-folder2-open"></i> Open</button></td>
              </tr>
              <tr class="folders-row">
                <td style="text-align: center;"><i class="bi bi-exclamation-circle" style="color: #e8912d;"></i></td>
                <td style="font-weight: 600;">Old Backup</td>
                <td style="text-align: right;">567</td>
                <td style="text-align: right;"><span style="color: #2e7d32;">400</span> / 567</td>
                <td style="text-align: center;"><button class="win-button folders-open-btn" style="font-size: 11px; padding: 2px 8px;"><i class="bi bi-folder2-open"></i> Open</button></td>
              </tr>
              <tr class="folders-row missing">
                <td style="text-align: center;"><i class="bi bi-exclamation-triangle" style="color: #e8912d;"></i></td>
                <td style="font-weight: 600;">Deleted Folder</td>
                <td style="text-align: right;">89</td>
                <td style="text-align: right;">—</td>
                <td style="text-align: center;">
                  <button class="win-button" style="font-size: 11px; padding: 2px 8px; margin-right: 4px;"><i class="bi bi-pencil"></i> Update Path</button>
                  <button class="win-button danger" style="font-size: 11px; padding: 2px 8px;"><i class="bi bi-trash"></i> Remove</button>
                </td>
              </tr>
            </tbody>
          </table>
        `
      },
      {
        name: "Curator Generic Table",
        render: () => html`
          <table class="curator-table" style="width: 100%;">
            <thead>
              <tr>
                <th>ID</th>
                <th>Filename</th>
                <th>Tags</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>1001</td>
                <td style="font-family: monospace; font-size: 11px;">sample_image.png</td>
                <td>5 tags</td>
                <td><span class="vector-badge badge-ready" style="position: static;">ready</span></td>
              </tr>
              <tr>
                <td>1002</td>
                <td style="font-family: monospace; font-size: 11px;">another_photo.jpg</td>
                <td>3 tags</td>
                <td><span class="vector-badge badge-pending" style="position: static;">pending</span></td>
              </tr>
              <tr>
                <td>1003</td>
                <td style="font-family: monospace; font-size: 11px;">vacation_shot.bmp</td>
                <td>0 tags</td>
                <td><span class="vector-badge badge-pending" style="position: static;">pending</span></td>
              </tr>
            </tbody>
          </table>
        `
      }
    ]
  },

  {
    name: "Log Viewer",
    description: "Dark monospace log display with color-coded log levels, timestamps, and collapsible JSON blocks.",
    variants: [
      {
        name: "Log Line Variants",
        render: () => html`
          <div style="background-color: #1e1e1e; padding: 10px; font-family: 'Consolas', 'Courier New', monospace; font-size: 11px; line-height: 1.6; width: 100%; border: 1px solid #333;">
            <div><span style="color: #666;">[2026-08-03 10:15:32]</span> <span style="color: #6a9955;">INFO</span> <span style="color: #cccccc;">Service started successfully</span></div>
            <div><span style="color: #666;">[2026-08-03 10:15:33]</span> <span style="color: #6a9955;">INFO</span> <span style="color: #cccccc;">Loaded CLIP model: ViT-B/32</span></div>
            <div><span style="color: #666;">[2026-08-03 10:15:34]</span> <span style="color: #dcdcaa;">WARN</span> <span style="color: #cccccc;">Thumbnail cache misses: 23</span></div>
            <div><span style="color: #666;">[2026-08-03 10:15:35]</span> <span style="color: #f44747;">ERROR</span> <span style="color: #cccccc;">Failed to index image: disk not accessible</span></div>
            <div><span style="color: #666;">[2026-08-03 10:15:36]</span> <span style="color: #569cd6;">DEBUG</span> <span style="color: #cccccc;">Vector search completed in 12ms</span></div>
          </div>
        `
      },
      {
        name: "Log Tabs",
        render: () => html`
          <div style="display: flex; gap: 0; width: 100%; max-width: 300px;">
            <button class="win-button log-tab active" style="border-radius: 2px 0 0 2px;">Dashboard</button>
            <button class="win-button log-tab" style="border-radius: 0 2px 2px 0;">Service</button>
          </div>
        `
      }
    ]
  },

  {
    name: "Selection Toolbar",
    description: "Bulk action toolbar shown when image card selection mode is active. Provides Select All, Clear, and action buttons.",
    variants: [
      {
        name: "Selection Bar",
        render: () => html`
          <div style="display: flex; align-items: center; gap: 12px; padding: 8px 12px; background-color: var(--sys-highlight-bg); color: var(--sys-highlight-text); width: 100%; border-radius: 2px;">
            <span style="font-size: 12px; font-weight: 600;">12 selected</span>
            <div style="flex: 1;"></div>
            <button class="win-button" style="font-size: 11px; background: rgba(255,255,255,0.15); color: #fff; border-color: rgba(255,255,255,0.3);">Select All</button>
            <button class="win-button" style="font-size: 11px; background: rgba(255,255,255,0.15); color: #fff; border-color: rgba(255,255,255,0.3);">Clear</button>
            <button class="win-button" style="font-size: 11px; background: rgba(255,255,255,0.25); color: #fff; border-color: rgba(255,255,255,0.4);"><i class="bi bi-magic"></i> Teach Concept</button>
          </div>
        `
      }
    ]
  },

  {
    name: "Missing Image Badge",
    description: "Warning badge overlay shown on image cards when the source file is no longer found on disk.",
    variants: [
      {
        name: "Missing Badge",
        render: () => html`
          <div style="position: relative; width: 200px; height: 140px; background: #f7f7f7; border: 1px solid var(--sys-border-dark); display: flex; align-items: center; justify-content: center;">
            <i class="bi bi-image" style="font-size: 32px; color: #ccc;"></i>
            <div class="badge-missing"><i class="bi bi-exclamation-triangle"></i> Missing</div>
          </div>
        `
      }
    ]
  },

  {
    name: "Concept Info Row",
    description: "Labeled key-value row used inside concept cards for displaying metadata like sample counts and dates.",
    variants: [
      {
        name: "Info Row Examples",
        render: () => html`
          <div style="display: flex; flex-direction: column; gap: 8px; width: 100%; max-width: 320px;">
            <div class="concept-info-row">
              <span class="concept-info-label">Sample Count</span>
              <span class="concept-info-val"><strong>12</strong> images</span>
            </div>
            <div class="concept-info-row">
              <span class="concept-info-label">Threshold</span>
              <span class="concept-info-val"><strong>0.75</strong></span>
            </div>
            <div class="concept-info-row">
              <span class="concept-info-label">Last Updated</span>
              <span class="concept-info-val"><strong>2026-07-20</strong></span>
            </div>
          </div>
        `
      }
    ]
  },

  {
    name: "Tag Overflow Pill",
    description: "Overflow indicator pill showing remaining tag count when a tag list is truncated.",
    variants: [
      {
        name: "Overflow Pill",
        render: () => html`
          <div style="display: flex; flex-wrap: wrap; gap: 6px; align-items: center;">
            ${renderTagPill({ tag: "character_name", category: "character" })}
            ${renderTagPill({ tag: "series_title", category: "copyright" })}
            ${renderTagPill({ tag: "user_tag", category: "user" })}
            <span class="tag-pill tag-pill-overflow">+5 more</span>
          </div>
        `
      }
    ]
  },

  {
    name: "Crop Placeholder",
    description: "Skeleton placeholder for face crop thumbnails while images are loading.",
    variants: [
      {
        name: "Crop Placeholder Slots",
        render: () => html`
          <div style="display: flex; gap: 8px; align-items: center;">
            <div class="crop-placeholder-slot" style="width: 64px; height: 64px; border: 1px dashed var(--sys-border-dark); background: var(--sys-window-bg);"></div>
            <div class="crop-placeholder-slot" style="width: 64px; height: 64px; border: 1px dashed var(--sys-border-dark); background: var(--sys-window-bg);"></div>
            <div class="crop-placeholder-slot" style="width: 64px; height: 64px; border: 1px dashed var(--sys-border-dark); background: var(--sys-window-bg);"></div>
          </div>
        `
      }
    ]
  },

  {
    name: "Tag Confirm Button",
    description: "Small green checkmark button for confirming tag additions, scales up on hover.",
    variants: [
      {
        name: "Confirm Button States",
        render: () => html`
          <div style="display: flex; gap: 12px; align-items: center;">
            <button class="tag-confirm-btn" style="position: static; width: 24px; height: 24px; font-size: 12px;"><i class="bi bi-check-lg"></i></button>
            <span style="font-size: 10px; color: #888;">Hover to scale up</span>
          </div>
        `
      }
    ]
  },

  {
    name: "Tool Strip",
    description: "Horizontal toolbar container with compact buttons and vertical separators for action groups.",
    variants: [
      {
        name: "Tool Strip with Separator",
        render: () => html`
          <div class="tool-strip" style="border: 1px solid var(--sys-border-dark); width: 100%;">
            ${renderButton("Open", { className: "tool-strip-btn", icon: "bi bi-folder2-open" })}
            ${renderButton("Save", { className: "tool-strip-btn", icon: "bi bi-save" })}
            <div class="tool-strip-separator"></div>
            ${renderButton("Cut", { className: "tool-strip-btn", icon: "bi bi-scissors" })}
            ${renderButton("Copy", { className: "tool-strip-btn", icon: "bi bi-clipboard" })}
            <div class="tool-strip-separator"></div>
            ${renderButton("Refresh", { className: "tool-strip-btn", icon: "bi bi-arrow-clockwise" })}
          </div>
        `
      }
    ]
  }
];