/**
 * Settings modal dialog for DynastyReader:
 * - UI Scale multiplier (75% to 150%, persisted in localStorage)
 * - Navigation shortcut to Cache Management
 * - General preferences
 */

import { decodeEntities, navigate, renderCurrent } from "../state";
import { addBlacklistedTag, getBlacklistedTags, removeBlacklistedTag, getBlacklistMode, setBlacklistMode } from "../db";
import type { BlacklistedTag } from "../db";
import { openExternal, suggest } from "../api";
import { browseCovers } from "../browse/browse-covers";
import { isAutoCacheChapterEnabled, setAutoCacheChapterEnabled, getPrefetchBuffer, setPrefetchBuffer } from "../reader/settings";
import { setupInputClearButtons } from "./input-field";

const STORAGE_KEY_UI_SCALE = "ds-ui-scale";
const SCALE_PRESETS = [0.75, 0.85, 1.0, 1.15, 1.25, 1.5];

export function getSavedUiScale(): number {
  const saved = localStorage.getItem(STORAGE_KEY_UI_SCALE);
  if (saved) {
    const val = parseFloat(saved);
    if (!isNaN(val) && val >= 0.5 && val <= 2.5) {
      return val;
    }
  }
  return 1.0;
}

export function applyUiScale(scale: number): void {
  const clamped = Math.max(0.5, Math.min(2.5, Math.round(scale * 100) / 100));
  localStorage.setItem(STORAGE_KEY_UI_SCALE, String(clamped));
  // Apply zoom only to #ds-root so that position:fixed / position:sticky elements
  // (reader nav bar, global topbar) are not displaced by a zoomed <html> element.
  const root = document.getElementById("ds-root");
  if (root) root.style.setProperty("zoom", String(clamped));
}

export function openSettingsModal(): void {
  const existing = document.getElementById("ds-settings-modal-backdrop");
  if (existing) return;

  const backdrop = document.createElement("div");
  backdrop.id = "ds-settings-modal-backdrop";
  backdrop.className = "ds-modal-backdrop";

  const modal = document.createElement("div");
  modal.className = "ds-modal-window";
  modal.style.cssText = "width: 440px;";

  const currentScale = getSavedUiScale();
  const applyModalZoom = (s: number) => {
    modal.style.setProperty("zoom", String(s));
    modal.style.maxHeight = `calc((100vh - 40px) / ${s})`;
    modal.style.maxWidth = `calc((100vw - 40px) / ${s})`;
  };
  applyModalZoom(currentScale);

  modal.innerHTML =
    '<div class="ds-modal-header">' +
    '  <span class="ds-modal-title"><i class="bi bi-gear-fill"></i> Application Settings</span>' +
    '  <button type="button" class="win-button ds-modal-close" title="Close (Esc)">' +
    '    <i class="bi bi-x-lg"></i>' +
    "  </button>" +
    "</div>" +
    '<div class="ds-modal-body" style="display:flex;flex-direction:column;gap:12px;">' +
    '  <div class="group-box" style="margin-top:4px;">' +
    '    <div class="group-box-title"><i class="bi bi-aspect-ratio"></i> Display &amp; Scaling</div>' +
    '    <div style="display:flex;flex-direction:column;gap:8px;">' +
    '      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">' +
    '        <label for="ds-settings-scale-select" style="font-size:12px;color:#333;">UI Scale Factor:</label>' +
    '        <div style="display:flex;align-items:center;gap:4px;">' +
    '          <button type="button" class="win-button ds-btn-sm" id="ds-settings-scale-dec" title="Decrease Scale (-10%)">' +
    '            <i class="bi bi-dash-lg"></i>' +
    "          </button>" +
    '          <select id="ds-settings-scale-select" class="input-field" style="width:115px;height:24px;font-size:11px;">' +
    SCALE_PRESETS.map(
      (s) =>
        `<option value="${s}" ${Math.abs(s - currentScale) < 0.01 ? "selected" : ""}>${Math.round(s * 100)}%${s === 1.0 ? " (Default)" : ""}</option>`,
    ).join("") +
    "          </select>" +
    '          <button type="button" class="win-button ds-btn-sm" id="ds-settings-scale-inc" title="Increase Scale (+10%)">' +
    '            <i class="bi bi-plus-lg"></i>' +
    "          </button>" +
    '          <button type="button" class="win-button ds-btn-sm" id="ds-settings-scale-reset" title="Reset to 100%">' +
    "            100%" +
    "          </button>" +
    "        </div>" +
    "      </div>" +
    '      <div class="ds-muted" style="font-size:11px;color:#666;">' +
    "        Scales all application typography, panels, buttons, and navigation controls." +
    "      </div>" +
    '      <div style="display:flex;align-items:center;justify-content:space-between;padding-top:6px;border-top:1px solid #eaeaea;gap:8px;">' +
    '        <div>' +
    '          <div style="font-size:12px;color:#333;font-weight:600;">Feed Cover Thumbnails:</div>' +
    '          <div class="ds-muted" style="font-size:11px;color:#666;">Load and display cover thumbnails in browse feeds.</div>' +
    '        </div>' +
    '        <button type="button" class="win-button" id="ds-settings-covers-toggle" style="font-size:11px;padding:2px 10px;min-width:90px;"></button>' +
    '      </div>' +
    "    </div>" +
    "  </div>" +
    '  <div class="group-box">' +
    '    <div class="group-box-title"><i class="bi bi-shield-slash"></i> Tag Blacklist</div>' +
    '    <div style="display:flex;flex-direction:column;gap:8px;">' +
    '      <div class="ds-muted" style="font-size:11px;color:#666;">' +
    "        Hide or show trigger warnings for releases and chapters matching these tags." +
    "      </div>" +
    '      <div style="display:flex;align-items:center;gap:12px;padding:2px 0;background:var(--sys-bg-active,#f8f9fa);border:1px solid var(--sys-border-light,#e2e2e2);border-radius:3px;padding:4px 8px;">' +
    '        <span style="font-size:11px;font-weight:600;color:var(--sys-window-text,#333);">Mode:</span>' +
    '        <label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;">' +
    '          <input type="radio" name="ds-bl-mode" value="hide" id="ds-bl-mode-hide" />' +
    '          <span>Hide releases</span>' +
    '        </label>' +
    '        <label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;">' +
    '          <input type="radio" name="ds-bl-mode" value="warn" id="ds-bl-mode-warn" />' +
    '          <span>Trigger warning on click</span>' +
    '        </label>' +
    '      </div>' +
    '      <div style="display:flex;gap:6px;position:relative;">' +
    '        <div class="input-wrapper" style="flex:1;">' +
    '          <input type="text" id="ds-settings-blacklist-input" class="input-field has-clear"' +
    '            placeholder="Search or enter tag to blacklist (e.g. NSFW, Het)..." style="width:100%;box-sizing:border-box;font-size:11px;height:24px;" />' +
    '          <button type="button" class="input-clear-btn" tabindex="-1" title="Clear">' +
    '            <i class="bi bi-x-lg"></i>' +
    '          </button>' +
    '          <div id="ds-settings-blacklist-suggest" class="ds-typeahead" style="display:none;max-height:160px;"></div>' +
    "        </div>" +
    '        <button type="button" class="win-button" id="ds-settings-blacklist-add" style="font-size:11px;padding:2px 10px;">' +
    '          <i class="bi bi-plus-lg"></i> Add' +
    "        </button>" +
    "      </div>" +
    '      <div id="ds-settings-blacklist-chips" style="display:flex;flex-wrap:wrap;gap:4px;min-height:22px;max-height:120px;overflow-y:auto;padding:2px 0;">' +
    '        <span class="ds-muted" style="font-size:10px;">Loading blacklist…</span>' +
    "      </div>" +
    "    </div>" +
    "  </div>" +
    '  <div class="group-box">' +
    '    <div class="group-box-title"><i class="bi bi-book-half"></i> Reading &amp; Cache</div>' +
    '    <div style="display:flex;flex-direction:column;gap:8px;">' +
    '      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">' +
    '        <div>' +
    '          <div style="font-size:12px;color:var(--sys-window-text,#222);font-weight:600;">Auto-Cache Entire Chapter</div>' +
    '          <div class="ds-muted" style="font-size:11px;color:#666;">' +
    "            When ON, pre-downloads all pages in a chapter. When OFF, only caches pages as you read them." +
    "          </div>" +
    "        </div>" +
    '        <button type="button" class="win-button" id="ds-settings-autocache-toggle" style="font-size:11px;padding:2px 10px;min-width:70px;"></button>' +
    "      </div>" +
    '      <div style="display:flex;align-items:center;justify-content:space-between;padding-top:6px;border-top:1px solid var(--sys-border-light,#eaeaea);gap:8px;">' +
    '        <div>' +
    '          <div style="font-size:12px;color:var(--sys-window-text,#222);font-weight:600;">Page Prefetch Buffer:</div>' +
    '          <div class="ds-muted" style="font-size:11px;color:#666;">' +
    "            Number of upcoming pages to preload ahead when auto-cache is off (default: 0)." +
    "          </div>" +
    "        </div>" +
    '        <div style="display:flex;align-items:center;gap:4px;">' +
    '          <button type="button" class="win-button ds-btn-sm" id="ds-settings-prefetch-dec" style="padding:2px 8px;font-size:11px;">−</button>' +
    '          <span id="ds-settings-prefetch-val" style="font-size:11px;font-weight:600;min-width:54px;text-align:center;">0 (off)</span>' +
    '          <button type="button" class="win-button ds-btn-sm" id="ds-settings-prefetch-inc" style="padding:2px 8px;font-size:11px;">+</button>' +
    "        </div>" +
    "      </div>" +
    "    </div>" +
    "  </div>" +
    '  <div class="group-box">' +
    '    <div class="group-box-title"><i class="bi bi-hdd-stack"></i> Storage &amp; Cache</div>' +
    '    <div style="display:flex;align-items:center;justify-content:space-between;padding:2px 0;">' +
    '      <span style="font-size:12px;color:#333;">Manage disk footprint &amp; scans:</span>' +
    '      <button type="button" class="win-button" id="ds-settings-goto-cache">' +
    '        <i class="bi bi-box-arrow-in-right"></i> Open Cache Manager' +
    '      </button>' +
    "    </div>" +
    "  </div>" +
    '  <div class="group-box">' +
    '    <div class="group-box-title"><i class="bi bi-info-circle"></i> About DynastyReader</div>' +
    '    <div style="display:flex;align-items:center;gap:12px;padding:4px 0;">' +
    '      <i class="bi bi-book" style="font-size:34px;color:var(--sys-highlight-bg,#0078d7);flex-shrink:0;"></i>' +
    '      <div class="ds-fill">' +
    '        <div style="font-size:12px;font-weight:600;color:var(--sys-window-text,#222);display:flex;align-items:center;gap:6px;">' +
    '          DynastyReader <span class="ds-etag-tag" style="font-size:10px;font-weight:normal;padding:1px 6px;">v0.1.0</span>' +
    "        </div>" +
    '        <div class="ds-muted" style="font-size:11px;margin-top:2px;">' +
    "          Local-first desktop reader &amp; offline manga catalog for Dynasty Scans." +
    "        </div>" +
    "      </div>" +
    '      <div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0;">' +
    '        <button type="button" class="win-button" id="ds-about-check-update" title="Check for DynastyReader updates" style="font-size:11px;padding:2px 8px;justify-content:center;">' +
    '          <i class="bi bi-arrow-repeat"></i> Check Updates' +
    '        </button>' +
    '        <button type="button" class="win-button" id="ds-about-open-github" title="Open DynastyReader GitHub repository" style="font-size:11px;padding:2px 8px;justify-content:center;">' +
    '          <i class="bi bi-github"></i> GitHub' +
    '        </button>' +
    '        <button type="button" class="win-button" id="ds-about-open-site" title="Open Dynasty Scans website in browser" style="font-size:11px;padding:2px 8px;justify-content:center;">' +
    '          <i class="bi bi-box-arrow-up-right"></i> dynasty-scans.com' +
    '        </button>' +
    '      </div>' +
    "    </div>" +
    "  </div>" +
    "</div>" +
    '<div class="ds-modal-footer" style="display:flex;justify-content:flex-end;gap:8px;padding-top:4px;">' +
    '  <button type="button" class="win-button primary ds-modal-done" style="min-width:70px;">Done</button>' +
    "</div>";

  backdrop.appendChild(modal);
  setupInputClearButtons(modal);
  // Mount directly to document.body so the full-window overlay is decoupled from
  // #ds-root zoom scaling, and scale the modal dialog itself cleanly.
  document.body.appendChild(backdrop);

  const close = (): void => {
    window.removeEventListener("keydown", onKeyDown);
    backdrop.remove();
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      close();
    }
  };
  window.addEventListener("keydown", onKeyDown);

  backdrop.addEventListener("click", (ev) => {
    if (ev.target === backdrop) close();
  });

  modal.querySelector(".ds-modal-close")?.addEventListener("click", close);
  modal.querySelector(".ds-modal-done")?.addEventListener("click", close);

  const scaleSelect = modal.querySelector<HTMLSelectElement>("#ds-settings-scale-select");
  const scaleDecBtn = modal.querySelector<HTMLButtonElement>("#ds-settings-scale-dec");
  const scaleIncBtn = modal.querySelector<HTMLButtonElement>("#ds-settings-scale-inc");
  const scaleResetBtn = modal.querySelector<HTMLButtonElement>("#ds-settings-scale-reset");

  const syncScaleUI = (scale: number): void => {
    applyUiScale(scale);
    applyModalZoom(scale);
    // Find closest preset or select matching option
    if (scaleSelect) {
      let matched = false;
      for (let i = 0; i < scaleSelect.options.length; i++) {
        if (Math.abs(parseFloat(scaleSelect.options[i].value) - scale) < 0.01) {
          scaleSelect.selectedIndex = i;
          matched = true;
          break;
        }
      }
      if (!matched) {
        // Add or update custom option
        let customOpt = scaleSelect.querySelector<HTMLOptionElement>("option.custom-scale");
        if (!customOpt) {
          customOpt = document.createElement("option");
          customOpt.className = "custom-scale";
          scaleSelect.appendChild(customOpt);
        }
        customOpt.value = String(scale);
        customOpt.textContent = `${Math.round(scale * 100)}% (Custom)`;
        scaleSelect.value = String(scale);
      }
    }
  };

  scaleSelect?.addEventListener("change", () => {
    const val = parseFloat(scaleSelect.value);
    if (!isNaN(val)) {
      applyUiScale(val);
    }
  });

  scaleDecBtn?.addEventListener("click", () => {
    const current = getSavedUiScale();
    const next = Math.max(0.5, Math.round((current - 0.1) * 10) / 10);
    syncScaleUI(next);
  });

  scaleIncBtn?.addEventListener("click", () => {
    const current = getSavedUiScale();
    const next = Math.min(2.0, Math.round((current + 0.1) * 10) / 10);
    syncScaleUI(next);
  });

  scaleResetBtn?.addEventListener("click", () => {
    syncScaleUI(1.0);
  });

  const coversToggleBtn = modal.querySelector<HTMLButtonElement>("#ds-settings-covers-toggle");
  const updateCoversToggleUI = () => {
    if (!coversToggleBtn) return;
    coversToggleBtn.innerHTML = browseCovers.coversEnabled
      ? '<i class="bi bi-image"></i> Covers: ON'
      : '<i class="bi bi-image-slash"></i> Covers: OFF';
    coversToggleBtn.className = `win-button${browseCovers.coversEnabled ? " primary" : ""}`;
  };
  updateCoversToggleUI();
  coversToggleBtn?.addEventListener("click", () => {
    browseCovers.setCoversEnabled(!browseCovers.coversEnabled);
    updateCoversToggleUI();
    renderCurrent();
  });

  const autoCacheToggleBtn = modal.querySelector<HTMLButtonElement>("#ds-settings-autocache-toggle");
  const updateAutoCacheToggleUI = () => {
    if (!autoCacheToggleBtn) return;
    const enabled = isAutoCacheChapterEnabled();
    autoCacheToggleBtn.innerHTML = enabled
      ? '<i class="bi bi-cloud-arrow-down-fill"></i> ON'
      : '<i class="bi bi-cloud-slash"></i> OFF';
    autoCacheToggleBtn.className = `win-button${enabled ? " primary" : ""}`;
    autoCacheToggleBtn.title = enabled
      ? "Pre-downloads full chapters in background (click to cache only as you read)"
      : "Only caches pages as you read (click to auto-download full chapters)";
  };
  updateAutoCacheToggleUI();
  autoCacheToggleBtn?.addEventListener("click", () => {
    setAutoCacheChapterEnabled(!isAutoCacheChapterEnabled());
    updateAutoCacheToggleUI();
  });

  const prefetchValSpan = modal.querySelector<HTMLElement>("#ds-settings-prefetch-val");
  const prefetchDecBtn = modal.querySelector<HTMLButtonElement>("#ds-settings-prefetch-dec");
  const prefetchIncBtn = modal.querySelector<HTMLButtonElement>("#ds-settings-prefetch-inc");

  const syncPrefetchUI = (val: number) => {
    setPrefetchBuffer(val);
    if (prefetchValSpan) {
      prefetchValSpan.textContent = val === 0 ? "0 (off)" : `${val} page${val === 1 ? "" : "s"}`;
    }
  };
  syncPrefetchUI(getPrefetchBuffer());

  prefetchDecBtn?.addEventListener("click", () => {
    const cur = getPrefetchBuffer();
    syncPrefetchUI(Math.max(0, cur - 1));
  });
  prefetchIncBtn?.addEventListener("click", () => {
    const cur = getPrefetchBuffer();
    syncPrefetchUI(Math.min(10, cur + 1));
  });

  const cacheBtn = modal.querySelector<HTMLButtonElement>("#ds-settings-goto-cache");
  cacheBtn?.addEventListener("click", () => {
    close();
    navigate({ view: "cache" });
  });

  const aboutUpdateBtn = modal.querySelector<HTMLButtonElement>("#ds-about-check-update");
  aboutUpdateBtn?.addEventListener("click", () => {
    if (!aboutUpdateBtn) return;
    aboutUpdateBtn.disabled = true;
    aboutUpdateBtn.innerHTML = '<i class="bi bi-arrow-repeat spin"></i> Checking...';
    window.setTimeout(() => {
      if (!aboutUpdateBtn.isConnected) return;
      aboutUpdateBtn.innerHTML = '<i class="bi bi-check-circle"></i> Up to Date (v0.1.0)';
      window.setTimeout(() => {
        if (!aboutUpdateBtn.isConnected) return;
        aboutUpdateBtn.disabled = false;
        aboutUpdateBtn.innerHTML = '<i class="bi bi-arrow-repeat"></i> Check Updates';
      }, 2500);
    }, 800);
  });

  const aboutGithubBtn = modal.querySelector<HTMLButtonElement>("#ds-about-open-github");
  aboutGithubBtn?.addEventListener("click", () => {
    void openExternal("https://github.com/FuouM/DynastyReader");
  });

  const aboutSiteBtn = modal.querySelector<HTMLButtonElement>("#ds-about-open-site");
  aboutSiteBtn?.addEventListener("click", () => {
    void openExternal("https://dynasty-scans.com");
  });

  // ── Blacklist Wiring ──────────────────────────────────────────────────
  const blModeHideRadio = modal.querySelector<HTMLInputElement>("#ds-bl-mode-hide");
  const blModeWarnRadio = modal.querySelector<HTMLInputElement>("#ds-bl-mode-warn");
  const currentBlMode = getBlacklistMode();
  if (currentBlMode === "warn") {
    if (blModeWarnRadio) blModeWarnRadio.checked = true;
  } else {
    if (blModeHideRadio) blModeHideRadio.checked = true;
  }

  blModeHideRadio?.addEventListener("change", () => {
    if (blModeHideRadio.checked) {
      setBlacklistMode("hide");
      renderCurrent();
    }
  });
  blModeWarnRadio?.addEventListener("change", () => {
    if (blModeWarnRadio.checked) {
      setBlacklistMode("warn");
      renderCurrent();
    }
  });

  const blInput = modal.querySelector<HTMLInputElement>("#ds-settings-blacklist-input");
  const blSuggest = modal.querySelector<HTMLElement>("#ds-settings-blacklist-suggest");
  const blAddBtn = modal.querySelector<HTMLButtonElement>("#ds-settings-blacklist-add");
  const blChips = modal.querySelector<HTMLElement>("#ds-settings-blacklist-chips");

  const renderBlacklistChips = async () => {
    if (!blChips) return;
    blChips.innerHTML = "";
    let list: BlacklistedTag[];
    try {
      list = await getBlacklistedTags();
    } catch (err) {
      console.error("dynasty-scans: failed to load tag blacklist:", err);
      blChips.innerHTML =
        '<span class="ds-muted" style="font-size:10px;color:#a80000;padding:2px 0;">Could not load blacklist. Check the application log.</span>';
      return;
    }
    if (list.length === 0) {
      blChips.innerHTML = '<span class="ds-muted" style="font-size:10px;padding:2px 0;">No tags blacklisted.</span>';
      return;
    }
    for (const item of list) {
      const chip = document.createElement("span");
      chip.className = "ds-row";
      chip.style.cssText =
        "background:#fde7e9;color:#a80000;border:1px solid #e81123;border-radius:3px;padding:1px 6px;font-size:10px;align-items:center;gap:4px;";
      chip.innerHTML = `<span>${decodeEntities(item.tag_name)}</span><i class="bi bi-x" style="cursor:pointer;font-size:13px;" title="Remove from blacklist"></i>`;
      chip.querySelector(".bi-x")?.addEventListener("click", async () => {
        await removeBlacklistedTag(item.tag_name);
        void renderBlacklistChips();
        renderCurrent();
      });
      blChips.appendChild(chip);
    }
  };
  void renderBlacklistChips();

  const addTag = async (name: string, permalink?: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    await addBlacklistedTag(trimmed, permalink);
    if (blInput) blInput.value = "";
    if (blSuggest) blSuggest.style.display = "none";
    void renderBlacklistChips();
    renderCurrent();
  };

  blAddBtn?.addEventListener("click", () => {
    if (blInput?.value) void addTag(blInput.value);
  });
  blInput?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && blInput.value) {
      void addTag(blInput.value);
    }
  });

  // Blacklist Autocomplete
  if (blInput && blSuggest) {
    let timer: number | undefined;
    blInput.addEventListener("input", () => {
      window.clearTimeout(timer);
      const val = blInput.value.trim();
      if (!val) {
        blSuggest.style.display = "none";
        return;
      }
      timer = window.setTimeout(async () => {
        try {
          const suggestions = await suggest(val);
          blSuggest.innerHTML = "";
          if (suggestions.length === 0) {
            blSuggest.style.display = "none";
            return;
          }
          for (const s of suggestions.slice(0, 6)) {
            const item = document.createElement("div");
            item.className = "ds-typeahead-item";
            item.innerHTML = `<span style="flex:1;">${decodeEntities(s.name)}</span><span class="ds-typeahead-type">${s.type}</span>`;
            item.addEventListener("mousedown", () => {
              void addTag(s.name);
            });
            blSuggest.appendChild(item);
          }
          blSuggest.style.display = "block";
        } catch {
          blSuggest.style.display = "none";
        }
      }, 200);
    });

    blInput.addEventListener("blur", () => {
      window.setTimeout(() => {
        blSuggest.style.display = "none";
      }, 150);
    });
  }
}
