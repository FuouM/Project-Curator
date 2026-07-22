import { renderGroupBox, componentRegistry } from "../components";
import { setupInputClearButtons } from "./concepts";

const COLLAPSE_STATE_KEY = "curator-component-collapse-states";

function getCollapsedStates(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_STATE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveCollapsedStates(states: Record<string, boolean>) {
  localStorage.setItem(COLLAPSE_STATE_KEY, JSON.stringify(states));
}

function toggleCollapse(name: string, groupBox: HTMLElement) {
  const states = getCollapsedStates();
  const isCollapsed = states[name] ?? false;
  states[name] = !isCollapsed;
  saveCollapsedStates(states);
  
  if (states[name]) {
    groupBox.classList.add("collapsed");
  } else {
    groupBox.classList.remove("collapsed");
  }
}

export function refreshComponentStylesheet() {
  const container = document.getElementById("components-showcase-container");
  if (!container) return;

  const collapsedStates = getCollapsedStates();

  container.innerHTML = componentRegistry.map(comp => {
    const variantsHtml = comp.variants.map(v => `
      <div style="margin-bottom: 14px;">
        <div style="font-size: 11px; font-weight: bold; color: #444; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;">${v.name}</div>
        <div style="padding: 10px; border: 1px dashed var(--sys-border-dark); background-color: var(--sys-control-bg); display: block; width: 100%;">
          ${v.render()}
        </div>
      </div>
    `).join("");

    const groupBoxHtml = renderGroupBox(comp.name, `
      <div class="group-box-body">
        <p style="font-size: 11px; color: #555; margin-bottom: 16px; font-style: italic;">${comp.description}</p>
        <div style="display: flex; flex-direction: column; gap: 8px;">
          ${variantsHtml}
        </div>
      </div>
    `);

    return groupBoxHtml;
  }).join("");

  // Add collapse buttons and restore states
  const groupBoxes = container.querySelectorAll(".group-box");
  groupBoxes.forEach((groupBox, index) => {
    if (index >= componentRegistry.length) return;
    
    const comp = componentRegistry[index];
    const title = groupBox.querySelector(".group-box-title");
    if (!title) return;

    // Add collapse button to title
    const collapseBtn = document.createElement("button");
    collapseBtn.className = "group-box-collapse-btn";
    collapseBtn.innerHTML = '<i class="bi bi-chevron-down"></i>';
    collapseBtn.title = "Toggle collapse";
    collapseBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleCollapse(comp.name, groupBox as HTMLElement);
    });
    title.appendChild(collapseBtn);

    // Restore collapsed state
    if (collapsedStates[comp.name]) {
      groupBox.classList.add("collapsed");
    }
  });

  setupInputClearButtons();
}
