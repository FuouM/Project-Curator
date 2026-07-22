import { renderGroupBox, componentRegistry } from "../components";
import { setupInputClearButtons } from "./concepts";

export function refreshComponentStylesheet() {
  const container = document.getElementById("components-showcase-container");
  if (!container) return;

  container.innerHTML = componentRegistry.map(comp => {
    const variantsHtml = comp.variants.map(v => `
      <div style="margin-bottom: 14px;">
        <div style="font-size: 11px; font-weight: bold; color: #444; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;">${v.name}</div>
        <div style="padding: 10px; border: 1px dashed var(--sys-border-dark); background-color: var(--sys-control-bg); display: block; width: 100%;">
          ${v.render()}
        </div>
      </div>
    `).join("");

    return renderGroupBox(comp.name, `
      <p style="font-size: 11px; color: #555; margin-bottom: 16px; font-style: italic;">${comp.description}</p>
      <div style="display: flex; flex-direction: column; gap: 8px;">
        ${variantsHtml}
      </div>
    `);
  }).join("");

  setupInputClearButtons();
}
