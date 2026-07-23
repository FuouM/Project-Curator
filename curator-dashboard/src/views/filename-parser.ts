import { callService } from "../ipc";
import { TokenBlock, ParsedMetadataResult, BatchPreviewItem } from "../types";

let currentTokenBlocks: TokenBlock[] = [
  { token_type: "artist" },
  { token_type: "delimiter", value: "_" },
  { token_type: "number" }
];

export function setupFilenameParserView() {
  const modePresetsBtn = document.getElementById("fn-mode-presets-btn");
  const modeRegexBtn = document.getElementById("fn-mode-regex-btn");
  const modeTokenBtn = document.getElementById("fn-mode-token-btn");

  const panelPresets = document.getElementById("fn-panel-presets");
  const panelRegex = document.getElementById("fn-panel-regex");
  const panelToken = document.getElementById("fn-panel-token");

  // Tab switching
  modePresetsBtn?.addEventListener("click", () => {
    setActiveMode("presets", [modePresetsBtn, modeRegexBtn, modeTokenBtn], [panelPresets, panelRegex, panelToken]);
    runSandboxTest();
    refreshBatchPreview();
  });

  modeRegexBtn?.addEventListener("click", () => {
    setActiveMode("regex", [modePresetsBtn, modeRegexBtn, modeTokenBtn], [panelPresets, panelRegex, panelToken]);
    runSandboxTest();
    refreshBatchPreview();
  });

  modeTokenBtn?.addEventListener("click", () => {
    setActiveMode("token", [modePresetsBtn, modeRegexBtn, modeTokenBtn], [panelPresets, panelRegex, panelToken]);
    renderTokenBlocks();
    runSandboxTest();
    refreshBatchPreview();
  });

  // Sandbox inputs
  const sandboxInput = document.getElementById("fn-sandbox-input") as HTMLInputElement;
  sandboxInput?.addEventListener("input", () => runSandboxTest());

  const presetSelect = document.getElementById("fn-preset-select") as HTMLSelectElement;
  presetSelect?.addEventListener("change", () => {
    runSandboxTest();
    refreshBatchPreview();
  });

  const regexInput = document.getElementById("fn-regex-input") as HTMLInputElement;
  regexInput?.addEventListener("input", () => {
    runSandboxTest();
    refreshBatchPreview();
  });

  // Token builder add block buttons
  document.querySelectorAll(".fn-add-token-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const type = (e.currentTarget as HTMLElement).getAttribute("data-token-type");
      if (type) {
        if (type === "delimiter") {
          currentTokenBlocks.push({ token_type: "delimiter", value: "_", enabled: true });
        } else if (type === "whitespace") {
          currentTokenBlocks.push({ token_type: "whitespace", enabled: true });
        } else {
          currentTokenBlocks.push({ token_type: type, enabled: true });
        }
        renderTokenBlocks();
        runSandboxTest();
        refreshBatchPreview();
      }
    });
  });

  // Batch preview & run buttons
  const previewBtn = document.getElementById("fn-batch-preview-btn");
  previewBtn?.addEventListener("click", () => refreshBatchPreview());

  const runBatchBtn = document.getElementById("fn-batch-run-btn");
  runBatchBtn?.addEventListener("click", () => runBatchParsing());

  // Sample filenames dropdown
  const sampleSelect = document.getElementById("fn-sandbox-sample-select") as HTMLSelectElement;
  sampleSelect?.addEventListener("change", () => {
    if (sampleSelect.value) {
      sandboxInput.value = sampleSelect.value;
      runSandboxTest();
    }
  });

  // Batch sample count & sort controls
  const batchSampleCount = document.getElementById("fn-batch-sample-count") as HTMLInputElement;
  let sampleCountTimer: ReturnType<typeof setTimeout> | null = null;
  batchSampleCount?.addEventListener("input", () => {
    if (sampleCountTimer) clearTimeout(sampleCountTimer);
    sampleCountTimer = setTimeout(() => {
      const val = parseInt(batchSampleCount.value, 10);
      if (!isNaN(val) && val !== 0) refreshBatchPreview();
    }, 400);
  });
  const batchSortOrder = document.getElementById("fn-batch-sort-order") as HTMLSelectElement;
  batchSortOrder?.addEventListener("change", () => refreshBatchPreview());

  // Token builder: Clear All
  document.getElementById("fn-token-clear-btn")?.addEventListener("click", () => {
    currentTokenBlocks = [];
    renderTokenBlocks();
    runSandboxTest();
    refreshBatchPreview();
  });

  // Token builder: Save
  document.getElementById("fn-token-save-btn")?.addEventListener("click", () => {
    if (currentTokenBlocks.length === 0) return;
    const name = prompt("Name this pattern:", "");
    if (!name) return;
    const matchTypeSelect = document.getElementById("fn-token-match-type-select") as HTMLSelectElement;
    const matchType = matchTypeSelect?.value || "custom_regex";
    const saved = JSON.parse(localStorage.getItem("fn_token_patterns") || "{}");
    saved[name] = { blocks: currentTokenBlocks, matchType };
    localStorage.setItem("fn_token_patterns", JSON.stringify(saved));
    refreshTokenLoadDropdown();
  });

  // Token builder: Load from dropdown
  const tokenLoadSelect = document.getElementById("fn-token-load-select") as HTMLSelectElement;
  tokenLoadSelect?.addEventListener("change", () => {
    const name = tokenLoadSelect.value;
    if (!name) return;
    const saved = JSON.parse(localStorage.getItem("fn_token_patterns") || "{}");
    const entry = saved[name];
    if (!entry) return;
    currentTokenBlocks = entry.blocks || entry; // Support old format (just blocks array)
    const matchTypeSelect = document.getElementById("fn-token-match-type-select") as HTMLSelectElement;
    if (entry.matchType && matchTypeSelect) matchTypeSelect.value = entry.matchType;
    renderTokenBlocks();
    runSandboxTest();
    refreshBatchPreview();
    tokenLoadSelect.value = "";
  });

  // Populate load dropdown on init
  refreshTokenLoadDropdown();

  // Anime screenshot warning
  const matchTypeSelect = document.getElementById("fn-token-match-type-select") as HTMLSelectElement;
  const animeWarning = document.getElementById("fn-token-anime-warning");
  matchTypeSelect?.addEventListener("change", () => {
    if (animeWarning) animeWarning.style.display = matchTypeSelect.value === "anime_screenshot" ? "inline" : "none";
  });

  // Token builder: Load Preset
  const tokenPresetSelect = document.getElementById("fn-token-preset-select") as HTMLSelectElement;
  tokenPresetSelect?.addEventListener("change", () => {
    const val = tokenPresetSelect.value;
    if (!val) return;
    const presets: Record<string, TokenBlock[]> = {
      pixiv_artist_page: [
        { token_type: "artist", enabled: true },
        { token_type: "delimiter", value: "_", enabled: true },
        { token_type: "pixiv_id", enabled: true },
        { token_type: "delimiter", value: "_p", enabled: true },
        { token_type: "number", enabled: true },
      ],
      pixiv_illust: [
        { token_type: "delimiter", value: "illust_", enabled: true },
        { token_type: "pixiv_id", enabled: true },
      ],
      booru_source: [
        { token_type: "bracketed", label: "source", enabled: true },
        { token_type: "wildcard", label: "title", enabled: true },
        { token_type: "bracketed", label: "tags", enabled: true },
      ],
      bracketed_title: [
        { token_type: "bracketed", label: "source", enabled: true },
        { token_type: "wildcard", label: "title", enabled: true },
        { token_type: "bracketed", label: "quality", enabled: true },
      ],
    };
    if (presets[val]) {
      currentTokenBlocks = presets[val].map(b => ({ ...b }));
      renderTokenBlocks();
      runSandboxTest();
      refreshBatchPreview();
    }
    tokenPresetSelect.value = "";
  });

  // Initial setup
  renderTokenBlocks();
  runSandboxTest();
}

function refreshTokenLoadDropdown() {
  const select = document.getElementById("fn-token-load-select") as HTMLSelectElement;
  if (!select) return;
  const saved = JSON.parse(localStorage.getItem("fn_token_patterns") || "{}");
  const names = Object.keys(saved);
  select.innerHTML = `<option value="">Load...</option>` +
    names.map(n => `<option value="${n}">${n}</option>`).join("");
}

export function getActiveRuleConfig(): { ruleType: string; patternOrType: string; tokenConfig: TokenBlock[] | null } {
  let ruleType = "preset";
  let patternOrType = "4chan_timestamp";
  let tokenConfig: TokenBlock[] | null = null;

  const presetsPanel = document.getElementById("fn-panel-presets");
  const regexPanel = document.getElementById("fn-panel-regex");

  if (presetsPanel && presetsPanel.style.display !== "none") {
    ruleType = "preset";
    const presetSelect = document.getElementById("fn-preset-select") as HTMLSelectElement;
    patternOrType = presetSelect?.value || "4chan_timestamp";
  } else if (regexPanel && regexPanel.style.display !== "none") {
    ruleType = "custom_regex";
    const regexInput = document.getElementById("fn-regex-input") as HTMLInputElement;
    const val = regexInput?.value.trim() || "";
    if (!val) {
      return { ruleType: "none", patternOrType: "", tokenConfig: null };
    }
    patternOrType = val;
  } else {
    ruleType = "token_builder";
    patternOrType = "";
    tokenConfig = currentTokenBlocks;
  }

  return { ruleType, patternOrType, tokenConfig };
}

function setActiveMode(mode: string, buttons: (HTMLElement | null)[], panels: (HTMLElement | null)[]) {
  buttons.forEach((b) => b?.classList.remove("active", "btn-primary"));
  panels.forEach((p) => {
    if (p) p.style.display = "none";
  });

  if (mode === "presets") {
    buttons[0]?.classList.add("active", "btn-primary");
    if (panels[0]) panels[0].style.display = "flex";
  } else if (mode === "regex") {
    buttons[1]?.classList.add("active", "btn-primary");
    if (panels[1]) panels[1].style.display = "flex";
  } else if (mode === "token") {
    buttons[2]?.classList.add("active", "btn-primary");
    if (panels[2]) panels[2].style.display = "flex";
  }
}

function renderTokenBlocks() {
  const container = document.getElementById("fn-token-blocks-container");
  const regexPreview = document.getElementById("fn-compiled-regex-preview");
  if (!container) return;

  container.innerHTML = "";
  currentTokenBlocks.forEach((block, idx) => {
    const chip = document.createElement("div");
    const isEnabled = block.enabled !== false;
    chip.style.cssText = `display: flex; align-items: center; gap: 6px; background-color: var(--sys-window-bg); border: 1px solid var(--sys-border-light); padding: 3px 8px; border-radius: 2px; font-size: 11px; opacity: ${isEnabled ? "1" : "0.45"};`;

    if (block.token_type === "delimiter") {
      chip.innerHTML = `
        <button type="button" class="token-toggle-btn win-button" style="padding: 1px 4px; font-size: 9px; ${isEnabled ? 'color: #155724;' : 'color: #999;'}" data-idx="${idx}" title="${isEnabled ? 'Disable' : 'Enable'}"><i class="bi bi-${isEnabled ? 'check-circle-fill' : 'circle'}"></i></button>
        <span style="color: #155724; font-family: monospace; font-weight: 600;">Delimiter:</span>
        <input type="text" value="${block.value || '_'}" class="token-delim-val input-field" style="width: 28px; text-align: center; padding: 1px 2px; font-size: 11px; font-family: monospace;" data-idx="${idx}" ${!isEnabled ? 'disabled' : ''} />
        <button type="button" class="token-remove-btn win-button" style="padding: 1px 4px; font-size: 10px;" data-idx="${idx}"><i class="bi bi-x-lg"></i></button>
      `;
    } else if (block.token_type === "whitespace") {
      chip.innerHTML = `
        <button type="button" class="token-toggle-btn win-button" style="padding: 1px 4px; font-size: 9px; ${isEnabled ? 'color: #155724;' : 'color: #999;'}" data-idx="${idx}" title="${isEnabled ? 'Disable' : 'Enable'}"><i class="bi bi-${isEnabled ? 'check-circle-fill' : 'circle'}"></i></button>
        <span style="color: #666; font-family: monospace; font-weight: 600; font-style: italic;">Space</span>
        <button type="button" class="token-remove-btn win-button" style="padding: 1px 4px; font-size: 10px;" data-idx="${idx}"><i class="bi bi-x-lg"></i></button>
      `;
    } else {
      const bracket = block.token_type === "bracketed" ? "[]" : "{}";
      chip.innerHTML = `
        <button type="button" class="token-toggle-btn win-button" style="padding: 1px 4px; font-size: 9px; ${isEnabled ? 'color: #155724;' : 'color: #999;'}" data-idx="${idx}" title="${isEnabled ? 'Disable' : 'Enable'}"><i class="bi bi-${isEnabled ? 'check-circle-fill' : 'circle'}"></i></button>
        <span style="color: #004085; font-family: monospace; font-weight: 600;">${bracket[0]}${block.token_type}${bracket[1]}</span>
        <input type="text" value="${block.label || ''}" placeholder="label" class="token-label-input input-field" style="width: 90px; padding: 1px 4px; font-size: 10px; font-family: monospace;" data-idx="${idx}" ${!isEnabled ? 'disabled' : ''} />
        <button type="button" class="token-remove-btn win-button" style="padding: 1px 4px; font-size: 10px;" data-idx="${idx}"><i class="bi bi-x-lg"></i></button>
      `;
    }

    container.appendChild(chip);
  });

  // Attach delete handlers
  container.querySelectorAll(".token-remove-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const idx = parseInt((e.currentTarget as HTMLElement).getAttribute("data-idx") || "0", 10);
      currentTokenBlocks.splice(idx, 1);
      renderTokenBlocks();
      runSandboxTest();
      refreshBatchPreview();
    });
  });

  // Attach toggle (enable/disable) handlers
  container.querySelectorAll(".token-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const idx = parseInt((e.currentTarget as HTMLElement).getAttribute("data-idx") || "0", 10);
      if (currentTokenBlocks[idx]) {
        currentTokenBlocks[idx].enabled = currentTokenBlocks[idx].enabled === false ? true : false;
      }
      renderTokenBlocks();
      runSandboxTest();
      refreshBatchPreview();
    });
  });

  // Attach delim input handlers
  container.querySelectorAll(".token-delim-val").forEach((inp) => {
    inp.addEventListener("input", (e) => {
      const inputEl = e.currentTarget as HTMLInputElement;
      const idx = parseInt(inputEl.getAttribute("data-idx") || "0", 10);
      if (currentTokenBlocks[idx]) {
        currentTokenBlocks[idx].value = inputEl.value;
      }
      runSandboxTest();
      refreshBatchPreview();
    });
  });

  // Attach label input handlers
  container.querySelectorAll(".token-label-input").forEach((inp) => {
    inp.addEventListener("input", (e) => {
      const inputEl = e.currentTarget as HTMLInputElement;
      const idx = parseInt(inputEl.getAttribute("data-idx") || "0", 10);
      if (currentTokenBlocks[idx]) {
        currentTokenBlocks[idx].label = inputEl.value || undefined;
      }
      runSandboxTest();
      refreshBatchPreview();
    });
  });

  // Update compiled regex preview from backend
  if (regexPreview) {
    if (currentTokenBlocks.length === 0) {
      regexPreview.textContent = "";
    } else {
      callService({ CompileTokenBlocks: { token_config: currentTokenBlocks } }).then(res => {
        if ("CompileTokenBlocksResult" in res && regexPreview) {
          regexPreview.textContent = res.CompileTokenBlocksResult.regex;
        }
      }).catch(() => {
        if (regexPreview) regexPreview.textContent = "compile error";
      });
    }
  }
}

export async function runSandboxTest() {
  const sandboxInput = document.getElementById("fn-sandbox-input") as HTMLInputElement;
  const resultContainer = document.getElementById("fn-sandbox-result");
  if (!sandboxInput || !resultContainer) return;

  const filename = sandboxInput.value.trim();
  if (!filename) {
    resultContainer.innerHTML = `<div style="color: #666; font-size: 11px;">Enter or select a filename above to test parsing.</div>`;
    return;
  }

  const { ruleType, patternOrType, tokenConfig } = getActiveRuleConfig();

  if (ruleType === "none") {
    resultContainer.innerHTML = `<div style="color: #666; font-size: 11px;">Enter a regex pattern or select a preset to test.</div>`;
    return;
  }

  try {
    const res = await callService({
      TestFilenamePattern: {
        filename,
        pattern_or_type: patternOrType,
        rule_type: ruleType,
        token_config: tokenConfig,
      },
    });

    if (res && "TestFilenamePatternResult" in res) {
      const match: ParsedMetadataResult | null = res.TestFilenamePatternResult.result;
      renderSandboxResult(match, filename);
    } else {
      resultContainer.innerHTML = `<div style="color: #721c24; font-size: 11px;">Error executing test.</div>`;
    }
  } catch (err) {
    resultContainer.innerHTML = `<div style="color: #721c24; font-size: 11px;">Test failed: ${err}</div>`;
  }
}

function renderSandboxResult(match: ParsedMetadataResult | null, filename: string) {
  const container = document.getElementById("fn-sandbox-result");
  if (!container) return;

  if (!match) {
    container.innerHTML = `
      <div style="padding: 10px 12px; background-color: var(--sys-window-bg); border: 1px solid var(--sys-border-light); display: flex; align-items: center; justify-content: space-between;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span class="tag-pill meta" style="font-weight: 600;"><i class="bi bi-x-circle"></i> No Match</span>
          <span style="font-family: monospace; font-size: 11px; font-weight: 600; color: #333;">${escapeHtml(filename)}</span>
        </div>
        <span style="font-size: 11px; color: #666;">Default fallback: Unparsed / Random</span>
      </div>
    `;
    return;
  }

  const tagsHtml = match.extracted_tags
    .map(
      (t) =>
        `<span class="tag-pill general" style="font-family: monospace;">${escapeHtml(t)}</span>`
    )
    .join(" ");

  container.innerHTML = `
    <div style="padding: 10px 12px; background-color: var(--sys-window-bg); border: 1px solid var(--sys-border-focus); display: flex; flex-direction: column; gap: 10px;">
      <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--sys-border-light); padding-bottom: 6px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span class="tag-pill custom-concept" style="font-weight: 600;">
            <i class="bi bi-check-circle-fill"></i> Match: ${escapeHtml(match.match_type)}
          </span>
          <span style="font-family: monospace; font-size: 11px; font-weight: 600; color: #111;">${escapeHtml(match.raw_matched)}</span>
        </div>
      </div>

      <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; font-size: 11px;">
        ${match.artist ? `<div><span style="color: #666; display: block;">Artist:</span><span style="font-weight: 600; font-family: monospace; color: #004085;">${escapeHtml(match.artist)}</span></div>` : ""}
        ${match.pixiv_id ? `<div><span style="color: #666; display: block;">Pixiv ID:</span><a href="https://www.pixiv.net/en/artworks/${escapeHtml(match.pixiv_id)}" target="_blank" rel="noopener" style="font-weight: 600; font-family: monospace; color: #383d41; text-decoration: none;" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">${escapeHtml(match.pixiv_id)}</a></div>` : ""}
        ${match.twitter_id ? `<div><span style="color: #666; display: block;">Twitter ID:</span><span style="font-weight: 600; font-family: monospace; color: #004085;">${escapeHtml(match.twitter_id)}</span></div>` : ""}
        ${match.timestamp_4chan ? `<div><span style="color: #666; display: block;">4chan Timestamp:</span><span style="font-weight: 600; font-family: monospace; color: #856404;">${escapeHtml(match.timestamp_4chan)}</span></div>` : ""}
        ${match.datetime_iso ? `<div><span style="color: #666; display: block;">Formatted DateTime:</span><span style="font-weight: 600; font-family: monospace; color: #155724;">${escapeHtml(match.datetime_iso)}</span></div>` : ""}
      </div>

      <div>
        <span style="font-size: 11px; color: #666; display: block; margin-bottom: 4px;">Extracted DB Tags:</span>
        <div style="display: flex; flex-wrap: wrap; gap: 4px;">${tagsHtml || '<span style="color: #888; font-size: 11px; font-style: italic;">No tags generated</span>'}</div>
      </div>
    </div>
  `;
}

export async function refreshBatchPreview() {
  const container = document.getElementById("fn-batch-preview-container");
  if (!container) return;

  const batchSampleCount = document.getElementById("fn-batch-sample-count") as HTMLInputElement;
  const rawVal = parseInt(batchSampleCount?.value || "50", 10);
  const limit = rawVal === -1 ? 9999999 : Math.max(1, rawVal || 50);

  container.innerHTML = `<div style="padding: 16px; text-align: center; color: #666; font-size: 11px;"><i class="bi bi-arrow-clockwise animate-spin"></i> Running filename parser test on database images...</div>`;

  const { ruleType, patternOrType, tokenConfig } = getActiveRuleConfig();

  if (ruleType === "none") {
    container.innerHTML = `<div style="padding: 16px; text-align: center; color: #666; font-size: 11px;">Enter a regex pattern or select a preset to preview.</div>`;
    return;
  }

  // Get output match type override for token builder
  let outputMatchType: string | null = null;
  if (ruleType === "token_builder") {
    const matchTypeSelect = document.getElementById("fn-token-match-type-select") as HTMLSelectElement;
    const val = matchTypeSelect?.value;
    if (val && val !== "custom_regex") outputMatchType = val;
  }

  try {
    const res = await callService({
      PreviewBatchFilenameParsing: {
        limit,
        pattern_or_type: patternOrType,
        rule_type: ruleType,
        token_config: tokenConfig,
        output_match_type: outputMatchType,
      },
    });
    if (res && "PreviewBatchFilenameParsingResult" in res) {
      const items: BatchPreviewItem[] = res.PreviewBatchFilenameParsingResult.items;
      renderBatchTable(items);
    } else {
      container.innerHTML = `<div style="padding: 16px; text-align: center; color: #721c24; font-size: 11px;">Failed to load batch preview.</div>`;
    }
  } catch (err) {
    container.innerHTML = `<div style="padding: 16px; text-align: center; color: #721c24; font-size: 11px;">Error: ${err}</div>`;
  }
}

function renderBatchTable(items: BatchPreviewItem[]) {
  const container = document.getElementById("fn-batch-preview-container");
  if (!container) return;

  if (items.length === 0) {
    container.innerHTML = `<div style="padding: 16px; text-align: center; color: #666; font-size: 11px;">No images found in database. Import some images first!</div>`;
    return;
  }

  const batchSortOrder = document.getElementById("fn-batch-sort-order") as HTMLSelectElement;
  const sortMode = batchSortOrder?.value || "match_first";

  const sorted = [...items];
  if (sortMode === "match_first") {
    const matchPriority: Record<string, number> = { preset: 0, token_builder: 1, custom_regex: 2 };
    sorted.sort((a, b) => {
      const aMatch = !!a.match_result;
      const bMatch = !!b.match_result;
      if (aMatch !== bMatch) return aMatch ? -1 : 1;
      if (aMatch && bMatch) {
        const aPri = matchPriority[a.match_result!.match_type] ?? 99;
        const bPri = matchPriority[b.match_result!.match_type] ?? 99;
        return aPri - bPri;
      }
      return a.image_id - b.image_id;
    });
  } else if (sortMode === "id_desc") {
    sorted.sort((a, b) => b.image_id - a.image_id);
  } else if (sortMode === "id_asc") {
    sorted.sort((a, b) => a.image_id - b.image_id);
  } else if (sortMode === "filename") {
    sorted.sort((a, b) => a.filename.localeCompare(b.filename));
  }

  let matchedCount = 0;
  let rowsHtml = sorted
    .map((item) => {
      const isMatch = !!item.match_result;
      if (isMatch) matchedCount++;

      const statusBadge = isMatch
        ? `<span class="tag-pill custom-concept" style="font-size: 10px; font-weight: 600;"><i class="bi bi-check-lg"></i> ${escapeHtml(item.match_result!.match_type)}</span>`
        : `<span class="tag-pill meta" style="font-size: 10px; font-weight: 600;">No Match</span>`;

      const tagsHtml = isMatch && item.match_result!.extracted_tags.length > 0
        ? item.match_result!.extracted_tags.map(t => `<span class="tag-pill general" style="font-size: 10px; font-family: monospace;">${escapeHtml(t)}</span>`).join(" ")
        : `<span style="color: #888; font-size: 11px;">-</span>`;

      return `
        <tr>
          <td style="font-family: monospace; font-weight: 600; width: 60px; text-align: center;">${item.image_id}</td>
          <td style="font-family: monospace; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(item.filename)}">${escapeHtml(item.filename)}</td>
          <td style="width: 140px;">${statusBadge}</td>
          <td><div style="display: flex; flex-wrap: wrap; gap: 3px;">${tagsHtml}</div></td>
        </tr>
      `;
    })
    .join("");

  container.innerHTML = `
    <div style="margin-bottom: 8px; font-size: 11px; color: #555;">
      Previewing <strong>${items.length}</strong> database files with active pattern (<code style="font-family: monospace; color: #004085;">${escapeHtml(getActiveRuleConfig().patternOrType)}</code>). Matched: <strong style="color: #155724;">${matchedCount}</strong> / ${items.length} (${Math.round((matchedCount / items.length) * 100)}%)
    </div>
    <div style="overflow-x: auto;">
      <table class="curator-table">
        <thead>
          <tr>
            <th style="width: 60px; text-align: center;">ID</th>
            <th style="width: 260px;">Filename</th>
            <th style="width: 140px;">Pattern Match</th>
            <th>Extracted Tags</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>
  `;
}

export async function runBatchParsing() {
  const statusEl = document.getElementById("fn-batch-run-status");
  if (statusEl) {
    statusEl.innerHTML = `<span style="color: #004085; font-size: 11px; font-weight: 600;"><i class="bi bi-arrow-clockwise animate-spin"></i> Processing library filenames with active rule & writing tags to DB...</span>`;
  }

  const { ruleType, patternOrType, tokenConfig } = getActiveRuleConfig();

  let outputMatchType: string | null = null;
  if (ruleType === "token_builder") {
    const matchTypeSelect = document.getElementById("fn-token-match-type-select") as HTMLSelectElement;
    const val = matchTypeSelect?.value;
    if (val && val !== "custom_regex") outputMatchType = val;
  }

  try {
    const res = await callService({
      RunBatchFilenameParsing: {
        pattern_or_type: patternOrType,
        rule_type: ruleType,
        token_config: tokenConfig,
        output_match_type: outputMatchType,
      },
    });

    if (res && "RunBatchFilenameParsingResult" in res) {
      const data = res.RunBatchFilenameParsingResult;
      if (statusEl) {
        statusEl.innerHTML = `
          <span style="color: #155724; font-size: 11px; font-weight: 600; background-color: #d4edda; border: 1px solid #c3e6cb; padding: 4px 8px; display: inline-block;">
            <i class="bi bi-check-circle-fill"></i> Complete! Processed: ${data.total_processed} files | Matched: ${data.matched_count} | Tags Created: ${data.tags_created}
          </span>
        `;
      }
      refreshBatchPreview();
    } else {
      if (statusEl) statusEl.innerHTML = `<span style="color: #721c24; font-size: 11px;">Error running batch parsing.</span>`;
    }
  } catch (err) {
    if (statusEl) statusEl.innerHTML = `<span style="color: #721c24; font-size: 11px;">Error: ${err}</span>`;
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

