/** @deprecated These components have zero callers and are retained only for reference. */

export interface SelectModeBarOptions {
  teachCountId?: string;
  extraButtonsHtml?: string;
}

/** @deprecated No callers. */
export function renderPaginationBar(prefix: string): string {
  return `
    <label style="font-size: 11px; color: #555555; display: flex; align-items: center; gap: 4px;">
      Show:
      <select class="input-field" id="${prefix}-per-page-select" style="width: 60px; height: 22px; font-size: 11px; padding: 1px 4px;">
        <option value="12">12</option>
        <option value="24">24</option>
        <option value="48">48</option>
        <option value="96">96</option>
      </select>
    </label>
    <span id="${prefix}-page-indicator" style="font-size: 11px; color: #555555;">Page 1</span>
    <input type="number" id="${prefix}-page-jump" min="1" style="width: 50px; font-size: 11px; padding: 2px 4px;" placeholder="#" />
    <button class="win-button" id="${prefix}-jump-btn" style="font-size: 11px; padding: 2px 6px;">Go</button>
    <button class="win-button" id="${prefix}-prev-btn" disabled><i class="bi bi-caret-left-fill"></i> Prev</button>
    <button class="win-button" id="${prefix}-next-btn">Next <i class="bi bi-caret-right-fill"></i></button>
  `;
}

/** @deprecated No callers. */
export function renderSelectModeBar(prefix: string, options?: SelectModeBarOptions): string {
  const teachCountId = options?.teachCountId ?? `${prefix}-teach-count`;
  const extra = options?.extraButtonsHtml ?? "";
  return `
    <button type="button" class="win-button" id="${prefix}-toggle-select-mode-btn">
      <i class="bi bi-check2-square"></i> Select Mode
    </button>
    <span id="${prefix}-selected-count" style="font-size: 11px; color: var(--sys-text-subtle); display: none;">0 selected</span>
    <button type="button" class="win-button" id="${prefix}-select-all-btn" style="display: none; font-size: 11px;">Select All</button>
    <button type="button" class="win-button" id="${prefix}-clear-select-btn" style="display: none; font-size: 11px;">Clear</button>
    <button type="button" class="win-button primary" id="${prefix}-teach-concept-btn" style="display: none; font-size: 11px;">
      <i class="bi bi-magic"></i> Teach Concept (<span id="${teachCountId}">0</span>)
    </button>
    ${extra}
  `;
}

/** @deprecated No callers. */
export function renderBenchmarkCard(key: string, label: string, size: string): string {
  return `
    <div class="group-box" style="padding: 10px; margin: 0;">
      <button class="win-button" data-benchmark-key="${key}" title="Run ${label} benchmark" style="position: absolute; top: -9px; right: 4px; height: 18px; padding: 0 7px; font-size: 11px; border-radius: 4px; display: flex; align-items: center; justify-content: center;">
        <i class="bi bi-play-fill" style="font-size: 12px;"></i>
      </button>
      <div class="group-box-title">${label} <span style="font-weight: normal; font-size: 10px; color: #666;">(${size})</span></div>
      <div style="display: flex; flex-direction: column; gap: 6px; font-size: 11px;">
        <div style="display: flex; justify-content: space-between; align-items: baseline; gap: 8px;">
          <span>CPU Throughput</span>
          <span id="benchmark-${key}-cpu" style="text-align: right;">—</span>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: baseline; gap: 8px;">
          <span>GPU Throughput</span>
          <span id="benchmark-${key}-gpu" style="text-align: right;">—</span>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: baseline; gap: 8px; border-top: 1px solid #eee; padding-top: 4px;">
          <span>Throughput Factor</span>
          <span id="benchmark-${key}-speedup" style="text-align: right; font-weight: bold;">—</span>
        </div>
      </div>
    </div>
  `;
}

/** @deprecated No callers. */
export function renderDeviceSelect(id: string, defaultVal: string = "auto"): string {
  return `
    <select class="input-field" id="${id}" style="width: 180px;">
      <option value="auto"${defaultVal === "auto" ? " selected" : ""}>Auto (GPU if available)</option>
      <option value="cpu"${defaultVal === "cpu" ? " selected" : ""}>CPU Only</option>
      <option value="gpu"${defaultVal === "gpu" ? " selected" : ""}>GPU Only</option>
    </select>
  `;
}
