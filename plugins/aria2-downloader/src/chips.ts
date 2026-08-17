/**
 * URL-inspector chips for the aria2-downloader Add Downloads toolbar.
 *
 * Parses the pasted URL block into tokens and renders a per-URL compatibility
 * chip row via the site-compatibility classifier in `sites.ts`.
 */

import { el } from "./ui-core";
import { checkUrlCompatibility } from "./sites";
import { state } from "./state";

export function updateChips(): void {
  const input = el<HTMLTextAreaElement>("ad-url-input");
  const chips = el("ad-chips");
  if (!input || !chips) return;
  const urls = splitUrls(input.value);
  const visible = urls.slice(0, 12);
  chips.innerHTML = "";
  if (visible.length === 0) return;

  const queuedUrls = new Set<string>();
  for (const item of state.queue.values()) queuedUrls.add(item.url);
  const historyUrls = new Set<string>(state.history.map((h) => h.url));

  for (const u of visible) {
    const r = checkUrlCompatibility(u);
    const inQueue = queuedUrls.has(u);
    const inHistory = !state.settings.autoRename && historyUrls.has(u);

    let statusText = r.badgeText;
    let chipClass = r.status === "verified_direct" ? "ok" : r.status === "generic_direct" ? "warn" : "bad";
    if (inQueue) {
      statusText += " (In Queue)";
      chipClass = "warn";
    } else if (inHistory) {
      statusText += " (Downloaded)";
      chipClass = "warn";
    }

    const chip = document.createElement("span");
    chip.className = `ad-chip ${chipClass}`;
    chip.title = `${u}\n${r.label} — ${statusText}`;
    chip.textContent = statusText;
    chips.appendChild(chip);
  }
  if (urls.length > visible.length) {
    const more = document.createElement("span");
    more.className = "ad-chip";
    more.textContent = `+${urls.length - visible.length} more`;
    chips.appendChild(more);
  }
}

/** Split a pasted block or array into individual URL tokens (whitespace separated). */
export function splitUrls(raw: string | string[]): string[] {
  if (Array.isArray(raw)) {
    return raw.flatMap((s) => (typeof s === "string" ? splitUrls(s) : [])).filter(Boolean);
  }
  if (typeof raw !== "string") return [];
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
