import { callService } from "../ipc";
import { SafeHtml, html } from "../components";
import { TokenBlock, ParsedMetadata, BatchPreviewItem } from "../types";
import { escapeHtml } from "../utils";
import { showWarningAlert } from "../alert";

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

  // Token builder: Export (fill text field with block sequence JSON)
  document.getElementById("fn-token-export-btn")?.addEventListener("click", () => {
    if (currentTokenBlocks.length === 0) return;
    const input = document.getElementById("fn-token-seq-input") as HTMLInputElement;
    if (input) {
      input.value = JSON.stringify(currentTokenBlocks);
      input.select();
    }
  });

  // Token builder: Import (parse block sequence from text field)
  document.getElementById("fn-token-import-btn")?.addEventListener("click", () => {
    const input = document.getElementById("fn-token-seq-input") as HTMLInputElement;
    const text = input?.value.trim() || "";
    if (!text) return;
    try {
      const parsed = JSON.parse(text);
      const blocks: TokenBlock[] = Array.isArray(parsed) ? parsed : (parsed.blocks || parsed);
      if (!Array.isArray(blocks) || blocks.length === 0) {
        showWarningAlert("Invalid block sequence: expected a non-empty JSON array.");
        return;
      }
      for (const b of blocks) {
        if (!b.token_type) {
          showWarningAlert("Invalid block: missing 'token_type' field.");
          return;
        }
      }
      currentTokenBlocks = blocks;
      renderTokenBlocks();
      runSandboxTest();
      refreshBatchPreview();
    } catch {
      showWarningAlert("Invalid JSON. Expected a JSON array of token blocks.");
    }
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
    const val = matchTypeSelect.value;
    const warnings: Record<string, string> = {
      anime_screenshot: 'Requires "anime" and "episode" labels',
      danbooru: 'Requires "slimtags", "artist", and "hash" labels',
    };
    if (animeWarning) {
      const msg = warnings[val];
      if (msg) {
        const textEl = document.getElementById("fn-token-warning-text");
        if (textEl) textEl.textContent = msg;
        animeWarning.style.display = "inline";
      } else {
        animeWarning.style.display = "none";
      }
    }
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
        <input type="text" value="${block.optional_prefix || ''}" placeholder="opt. prefix" class="token-prefix-input input-field" style="width: 70px; padding: 1px 4px; font-size: 10px; font-family: monospace; ${block.optional_prefix ? 'color: #856404; background: #fff3cd;' : ''}" data-idx="${idx}" title="Optional prefix to strip (e.g. sample-)" ${!isEnabled ? 'disabled' : ''} />
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

  // Attach optional prefix input handlers
  container.querySelectorAll(".token-prefix-input").forEach((inp) => {
    inp.addEventListener("input", (e) => {
      const inputEl = e.currentTarget as HTMLInputElement;
      const idx = parseInt(inputEl.getAttribute("data-idx") || "0", 10);
      if (currentTokenBlocks[idx]) {
        currentTokenBlocks[idx].optional_prefix = inputEl.value || undefined;
      }
      // Update compiled regex preview without re-rendering
      const regexPreview = document.getElementById("fn-compiled-regex-preview");
      if (regexPreview && currentTokenBlocks.length > 0) {
        callService({ CompileTokenBlocks: { token_config: currentTokenBlocks } }).then(res => {
          if ("CompileTokenBlocksResult" in res && regexPreview) {
            regexPreview.textContent = res.CompileTokenBlocksResult.regex;
          }
        }).catch(() => {});
      }
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
      const match: ParsedMetadata | null = res.TestFilenamePatternResult.result;
      renderSandboxResult(match, filename);
    } else {
      resultContainer.innerHTML = `<div style="color: #721c24; font-size: 11px;">Error executing test.</div>`;
    }
  } catch (err) {
    resultContainer.innerHTML = `<div style="color: #721c24; font-size: 11px;">Test failed: ${err}</div>`;
  }
}

function renderSandboxResult(match: ParsedMetadata | null, filename: string) {
  const container = document.getElementById("fn-sandbox-result");
  if (!container) return;

  if (!match) {
    container.innerHTML = `
      <div style="padding: 10px 12px; background-color: var(--sys-window-bg); border: 1px solid var(--sys-border-light); display: flex; align-items: center; justify-content: space-between;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span class="tag-pill tag-meta" style="font-weight: 600;"><i class="bi bi-x-circle"></i> No Match</span>
          <span style="font-family: monospace; font-size: 11px; font-weight: 600; color: #333;">${escapeHtml(filename)}</span>
        </div>
        <span style="font-size: 11px; color: #666;">Default: Unparsed / Random</span>
      </div>
    `;
    return;
  }

  const tagsHtml = match.extracted_tags
    .map(
      (t) =>
        `<span class="tag-pill tag-rank-3" style="font-family: monospace;">${escapeHtml(t)}</span>`
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
        : `<span class="tag-pill tag-meta" style="font-size: 10px; font-weight: 600;">No Match</span>`;

      const tagsHtml = isMatch && item.match_result!.extracted_tags.length > 0
        ? item.match_result!.extracted_tags.map(t => `<span class="tag-pill tag-rank-3" style="font-size: 10px; font-family: monospace;">${escapeHtml(t)}</span>`).join(" ")
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

// ---------------------------------------------------------------------------
// HTML Template
// ---------------------------------------------------------------------------

export function renderFilenameParserHtml(): SafeHtml {
  return html`
    <div style="display: flex; flex-direction: column; gap: 16px;">
      <!-- Mode Selection & Rule Config Header -->
      <div class="group-box">
        <div class="group-box-title"><i class="bi bi-gear-wide-connected"></i> Rule Engine Configuration</div>
        <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px;">
          <button type="button" class="win-button active btn-primary" id="fn-mode-presets-btn">
            <i class="bi bi-lightning-charge-fill"></i> Presets Engine
          </button>
          <button type="button" class="win-button" id="fn-mode-token-btn">
            <i class="bi bi-puzzle-fill"></i> No-Code Token Builder
          </button>
          <button type="button" class="win-button" id="fn-mode-regex-btn">
            <i class="bi bi-code-slash"></i> Custom Regex Pattern
          </button>
        </div>

        <!-- Preset Panel -->
        <div id="fn-panel-presets" style="display: flex; flex-direction: column; gap: 6px;">
          <label style="font-size: 11px; font-weight: 600; color: var(--sys-text-subtle);">Select Active Preset Extractor Pattern:</label>
          <select class="input-field" id="fn-preset-select" style="width: 100%; max-width: 480px; font-size: 11px;">
            <option value="4chan_timestamp" selected>4chan Unix Timestamps (10, 13, 16 digit dates)</option>
            <option value="pixiv_id">Pixiv Artwork ID &amp; Page (illust_123456, artist_p0)</option>
            <option value="twitter_key">Twitter Snowflake &amp; Media Keys (media_..., status ID)</option>
            <option value="danbooru">Danbooru (SlimTags + Artist + Hash)</option>
            <option value="tagged_string">Bracketed Tagged String ([artist] title (tags))</option>
            <option value="anime_screenshot">Anime Screenshot (name + episode)</option>
          </select>
        </div>

        <!-- Token Builder Panel -->
        <div id="fn-panel-token" style="display: none; flex-direction: column; gap: 8px;">
          <label style="font-size: 11px; font-weight: 600; color: var(--sys-text-subtle);">Click building blocks to assemble custom pattern:</label>
          <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px;">
            <button type="button" class="win-button fn-add-token-btn" data-token-type="artist">+ {Artist}</button>
            <button type="button" class="win-button fn-add-token-btn" data-token-type="timestamp_4chan">+ {4chan Timestamp}</button>
            <button type="button" class="win-button fn-add-token-btn" data-token-type="pixiv_id">+ {Pixiv ID}</button>
            <button type="button" class="win-button fn-add-token-btn" data-token-type="twitter_id">+ {Twitter ID}</button>
            <button type="button" class="win-button fn-add-token-btn" data-token-type="number">+ {Number}</button>
            <button type="button" class="win-button fn-add-token-btn" data-token-type="md5_hash">+ {MD5 Hash}</button>
            <button type="button" class="win-button fn-add-token-btn" data-token-type="delimiter">+ Delimiter (_)</button>
            <button type="button" class="win-button fn-add-token-btn" data-token-type="wildcard">+ {Wildcard}</button>
            <button type="button" class="win-button fn-add-token-btn" data-token-type="bracketed">+ [Bracketed]</button>
            <button type="button" class="win-button fn-add-token-btn" data-token-type="whitespace">+ Space</button>
            <button type="button" class="win-button fn-add-token-btn" data-token-type="tag">+ {Tag}</button>
          </div>
          <div style="padding: 8px 10px; background-color: var(--sys-window-bg); border: 1px solid var(--sys-border-light);">
            <div style="font-size: 11px; font-weight: 600; color: #555; margin-bottom: 6px;">Active Blocks Sequence:</div>
            <div id="fn-token-blocks-container" style="display: flex; flex-wrap: wrap; gap: 6px; min-height: 28px; align-items: center;"></div>
          </div>
          <div style="display: flex; flex-direction: column; gap: 4px;">
            <div style="font-size: 11px; color: #555;">
              Compiled Regex: <code id="fn-compiled-regex-preview" style="font-family: monospace; font-weight: 600; color: #004085; background: #e2e3e5; padding: 2px 6px; border-radius: 2px;"></code>
            </div>
            <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap;">
              <div style="display: flex; align-items: center; gap: 4px;">
                <label style="font-size: 10px; color: #555;">Type:</label>
                <select class="input-field" id="fn-token-match-type-select" style="font-size: 10px; height: 22px; padding: 1px 4px; width: 110px;">
                  <option value="custom_regex">Custom Regex</option>
                  <option value="anime_screenshot">Anime Screenshot</option>
                  <option value="danbooru">Danbooru</option>
                </select>
                <span id="fn-token-anime-warning" style="font-size: 9px; color: #856404; display: none;"><i class="bi bi-exclamation-triangle"></i> <span id="fn-token-warning-text"></span></span>
              </div>
              <div style="display: flex; align-items: center; gap: 4px; flex-wrap: wrap;">
                <button type="button" class="win-button" id="fn-token-clear-btn" style="font-size: 10px; padding: 2px 8px;" title="Clear all blocks"><i class="bi bi-trash"></i> Clear</button>
                <button type="button" class="win-button" id="fn-token-save-btn" style="font-size: 10px; padding: 2px 8px;" title="Save current pattern"><i class="bi bi-save"></i> Save</button>
                <select class="input-field" id="fn-token-load-select" style="font-size: 10px; height: 22px; padding: 1px 4px; width: 120px;" title="Load saved pattern">
                  <option value="">Load...</option>
                </select>
                <select class="input-field" id="fn-token-preset-select" style="font-size: 10px; height: 22px; padding: 1px 4px; width: 140px;">
                  <option value="">Load Preset...</option>
                  <option value="pixiv_artist_page">Pixiv: artist_p0</option>
                  <option value="pixiv_illust">Pixiv: illust_ID</option>
                  <option value="booru_source">Booru: source_ID_tags</option>
                  <option value="bracketed_title">Bracketed: [source] title</option>
                </select>
                <button type="button" class="win-button" id="fn-token-export-btn" style="font-size: 10px; padding: 2px 8px;" title="Export block sequence to text field"><i class="bi bi-arrow-up-right"></i> Export</button>
                <input type="text" id="fn-token-seq-input" class="input-field" style="font-size: 10px; font-family: monospace; height: 22px; padding: 1px 4px; width: 220px;" placeholder="Block sequence JSON..." title="Paste a block sequence here, then click Import" />
                <button type="button" class="win-button" id="fn-token-import-btn" style="font-size: 10px; padding: 2px 8px;" title="Import block sequence from text field"><i class="bi bi-arrow-down-left"></i> Import</button>
              </div>
            </div>
          </div>
        </div>

        <!-- Custom Regex Panel -->
        <div id="fn-panel-regex" style="display: none; flex-direction: column; gap: 6px;">
          <label style="font-size: 11px; font-weight: 600; color: var(--sys-text-subtle);">Enter Regular Expression with Named Capture Groups:</label>
          <input class="input-field" id="fn-regex-input" value="^(?P&lt;artist&gt;[A-Za-z0-9_-]+)_(?P&lt;pixiv_id&gt;\\d{7,10})_p(?P&lt;page&gt;\\d+)$" placeholder="e.g. ^(?P<artist>\\w+)_(?P<timestamp>\\d+)$" style="width: 100%; font-family: monospace; font-size: 11px;" />
          <p style="font-size: 11px; color: #666; margin: 2px 0 0 0;">Supported group names: <code>artist</code>, <code>pixiv_id</code>, <code>twitter_id</code>, <code>timestamp</code>, <code>tag</code>.</p>
        </div>
      </div>

      <!-- Live Test Sandbox -->
      <div class="group-box">
        <div class="group-box-title"><i class="bi bi-sliders"></i> Live Test Sandbox</div>
        <div style="display: flex; flex-direction: column; gap: 12px;">
          <div style="display: flex; flex-wrap: wrap; gap: 12px;">
            <div style="flex: 1; min-width: 280px;">
              <label style="font-size: 11px; font-weight: 600; color: var(--sys-text-subtle);">Test Filename (or pick sample):</label>
              <input class="input-field" id="fn-sandbox-input" value="1652448237000.jpg" placeholder="Type filename to test pattern..." style="width: 100%; font-family: monospace; font-size: 11px; margin-top: 4px;" />
            </div>
            <div style="min-width: 280px;">
              <label style="font-size: 11px; font-weight: 600; color: var(--sys-text-subtle);">Preset Test Samples:</label>
              <select class="input-field" id="fn-sandbox-sample-select" style="width: 100%; font-size: 11px; margin-top: 4px;">
                <option value="1652448237000.png" selected>4chan Unix Timestamp (1652448237000)</option>
                <option value="illust_108521179_20230513_212357.jpg">Pixiv Illust (illust_108521179_...)</option>
                <option value="gwitch_suletta_Mineori_108521179_p0.png">Pixiv Page (gwitch_..._p0)</option>
                <option value="media_FR49d0XWUAImXfA.jpg_large">Twitter Key (media_FR4...)</option>
                <option value="__hiroi_kikuri_and_rupa_bocchi_the_rock_and_1_more_drawn_by_poop_frog__eda85cef4365c0b4f25c1cedb9abbe31.jpg">Danbooru (__...__hash)</option>
                <option value="[Mineori] Witch from Mercury (Suletta Miorine).jpg">Bracketed Tagged ([Mineori] ...)</option>
              </select>
            </div>
          </div>

          <!-- Sandbox Live Result -->
          <div id="fn-sandbox-result"></div>
        </div>
      </div>

      <!-- Database Batch Preview & Batch Runner -->
      <div class="group-box">
        <div class="group-box-title" style="display: flex; align-items: center; justify-content: space-between;">
          <span><i class="bi bi-table"></i> Database Batch Preview &amp; Execution</span>
        </div>

        <!-- Button Bar & Info -->
        <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; margin-top: 8px; margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid var(--sys-border-light, #d0d0d0);">
          <span style="font-size: 11px; color: #555;">Preview match results across database files before applying.</span>
          <div style="display: flex; align-items: center; gap: 8px;">
            <label style="font-size: 11px; color: #555; white-space: nowrap;">Samples:</label>
            <input type="number" class="input-field" id="fn-batch-sample-count" value="50" max="5000" style="width: 60px; height: 22px; font-size: 11px; padding: 1px 4px; text-align: center;" />
            <span style="font-size: 10px; color: #888;">-1 = unlimited</span>
            <label style="font-size: 11px; color: #555; white-space: nowrap;">Sort:</label>
            <select class="input-field" id="fn-batch-sort-order" style="width: 100px; height: 22px; font-size: 11px; padding: 1px 4px;">
              <option value="match_first">Match First</option>
              <option value="id_desc">Newest First</option>
              <option value="id_asc">Oldest First</option>
              <option value="filename">Filename A-Z</option>
            </select>
            <button type="button" class="win-button" id="fn-batch-preview-btn" style="padding: 4px 12px;">
              <i class="bi bi-arrow-clockwise"></i> Preview DB Files
            </button>
            <button type="button" class="win-button primary" id="fn-batch-run-btn" style="padding: 4px 12px;">
              <i class="bi bi-play-fill"></i> Apply Rules to Entire DB
            </button>
          </div>
        </div>

        <div id="fn-batch-run-status" style="margin-bottom: 8px;"></div>
        <div id="fn-batch-preview-container"></div>
      </div>
    </div>
  `;
}

