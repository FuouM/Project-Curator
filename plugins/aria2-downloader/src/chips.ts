/**
 * URL-inspector chips for the aria2-downloader Add Downloads toolbar.
 *
 * Parses the pasted URL block into tokens and renders a per-URL compatibility
 * chip row via the site-compatibility classifier in `sites.ts`.
 */

import { el } from "./ui-core";
import { checkUrlCompatibility } from "./sites";

export function updateChips(): void {
  const input = el<HTMLTextAreaElement>("ad-url-input");
  const chips = el("ad-chips");
  if (!input || !chips) return;
  const urls = splitUrls(input.value);
  const visible = urls.slice(0, 12);
  chips.innerHTML = "";
  if (visible.length === 0) return;
  for (const u of visible) {
    const r = checkUrlCompatibility(u);
    const chip = document.createElement("span");
    chip.className = `ad-chip ${r.status === "verified_direct" ? "ok" : r.status === "generic_direct" ? "warn" : "bad"}`;
    chip.title = `${u}\n${r.label} — ${r.badgeText}`;
    chip.textContent = r.badgeText;
    chips.appendChild(chip);
  }
  if (urls.length > visible.length) {
    const more = document.createElement("span");
    more.className = "ad-chip";
    more.textContent = `+${urls.length - visible.length} more`;
    chips.appendChild(more);
  }
}

/** Split a pasted block into individual URL tokens (whitespace separated). */
export function splitUrls(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
