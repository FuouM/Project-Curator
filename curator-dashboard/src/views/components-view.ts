import { renderGroupBox, SHOWCASE_COMPONENTS } from "../components";
import { showAlert } from "../alert";
import { setupInputClearButtons } from "../utils";

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
  const entries = Object.entries(SHOWCASE_COMPONENTS);

  container.innerHTML = entries
    .map(([, comp]) => {
      const variantsHtml = (comp.variants ?? [])
        .map(
          (v) => `
      <div style="margin-bottom: 14px;">
        <div style="font-size: 11px; font-weight: bold; color: #444; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;">${v.name}</div>
        <div style="padding: 10px; border: 1px dashed var(--sys-border-dark); background-color: var(--sys-control-bg); display: block; width: 100%;">
          ${v.render()}
        </div>
      </div>
    `,
        )
        .join("");

      const groupBoxHtml = renderGroupBox(
        comp.name,
        `
      <div class="group-box-body">
        <p style="font-size: 11px; color: #555; margin-bottom: 16px; font-style: italic;">${comp.description}</p>
        <div style="display: flex; flex-direction: column; gap: 8px;">
          ${variantsHtml}
        </div>
      </div>
    `,
      );

      return groupBoxHtml;
    })
    .join("");

  const groupBoxes = container.querySelectorAll(".group-box");
  groupBoxes.forEach((groupBox, index) => {
    if (index >= entries.length) return;

    const [, comp] = entries[index];
    const title = groupBox.querySelector(".group-box-title");
    if (!title) return;

    const collapseBtn = document.createElement("button");
    collapseBtn.className = "group-box-collapse-btn";
    collapseBtn.innerHTML = '<i class="bi bi-chevron-down"></i>';
    collapseBtn.title = "Toggle collapse";
    collapseBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleCollapse(comp.name, groupBox as HTMLElement);
    });
    title.appendChild(collapseBtn);

    if (collapsedStates[comp.name]) {
      groupBox.classList.add("collapsed");
    }
  });

  const allCollapsed = entries.every(([, comp]) => collapsedStates[comp.name] ?? false);
  const toggleAllBtn = document.getElementById("toggle-all-groups-btn");
  if (toggleAllBtn) {
    toggleAllBtn.innerHTML = allCollapsed
      ? '<i class="bi bi-chevron-double-up"></i> Uncollapse All'
      : '<i class="bi bi-chevron-double-down"></i> Collapse All';
    toggleAllBtn.onclick = () => {
      const states = getCollapsedStates();
      const newState = !allCollapsed;
      entries.forEach(([, comp]) => {
        states[comp.name] = newState;
      });
      saveCollapsedStates(states);
      refreshComponentStylesheet();
    };
  }

  setupInputClearButtons();
  setupAlertDemoTriggers();
}

function setupAlertDemoTriggers() {
  const container = document.getElementById("components-showcase-container");
  if (!container) return;

  container
    .querySelectorAll<HTMLButtonElement>('[data-action="show-alert-demo"]')
    .forEach((btn) => {
      if (btn.getAttribute("data-alert-bound")) return;
      btn.setAttribute("data-alert-bound", "true");
      btn.addEventListener("click", () => {
        const kind = (btn.dataset.alertKind ?? "info") as "error" | "warning" | "info" | "success";
        const previews: Record<string, string> = {
          error:
            "Failed to index image 'vacation_photo.jpg'\n  Caused by: disk not accessible (error code 0x80070005)\n  ONNX Runtime: DirectML 1.24.4\n  File: D:\\Gallery\\2026\\vacation_photo.jpg",
          warning:
            "Thumbnail cache misses are higher than expected (23 misses in the last scan).\n\nThis may slow down the gallery while images are re-cached.",
          info: "A background service task has completed. 2 images were newly indexed.",
          success: "Vector index rebuilt successfully. 1,234 images are now searchable.",
        };
        showAlert({
          kind,
          title: kind.charAt(0).toUpperCase() + kind.slice(1),
          message: previews[kind] ?? previews.info,
        });
      });
    });
}

// ---------------------------------------------------------------------------
// HTML Template
// ---------------------------------------------------------------------------

export function renderComponentsHtml(): string {
  return `
    <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
      <button id="toggle-all-groups-btn" class="btn btn-sm" style="display: inline-flex; align-items: center; gap: 6px;">
        <i class="bi bi-chevron-double-down"></i> Collapse All
      </button>
    </div>
    <div id="components-showcase-container" style="display: flex; flex-direction: column; gap: 16px;"></div>
  `;
}

// HMR: re-render the live component showcase without a full page reload
// whenever a component module or its meta footprint changes.
if (import.meta.hot) {
  import.meta.hot.accept(["../components", "./components-view"], () => {
    refreshComponentStylesheet();
  });
}
