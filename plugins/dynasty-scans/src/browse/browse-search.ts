import { decodeEntities, navigate, setBanner } from "../state";
import { openExternal, parseDynastyUrl, suggest } from "../api";
import type { SuggestResult } from "../types/api";

/**
 * Search typeahead + Open-by-URL panel. The typeahead delegates to the user's
 * browser (suggestions carry {id, name, type} only — no permalinks to trust).
 */
export async function loadSuggestions(q: string, host: HTMLElement): Promise<void> {
  let results: SuggestResult[];
  try {
    results = await suggest(q);
  } catch (err) {
    host.style.display = "none";
    const msg = err instanceof Error ? err.message : String(err);
    setBanner(`Search suggestions failed: ${msg}`);
    return;
  }
  host.innerHTML = "";
  if (results.length === 0) {
    host.style.display = "none";
    return;
  }
  for (const r of results.slice(0, 8)) {
    const item = document.createElement("div");
    item.className = "ds-typeahead-item";
    const name = document.createElement("span");
    name.style.cssText =
      "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    name.textContent = decodeEntities(r.name);
    const type = document.createElement("span");
    type.className = "ds-typeahead-type";
    type.textContent = r.type;
    item.appendChild(name);
    item.appendChild(type);
    item.addEventListener("mousedown", () => {
      void openExternal(`https://dynasty-scans.com/search?q=${encodeURIComponent(r.name)}`);
    });
    host.appendChild(item);
  }
  host.style.display = "block";
}

/** Wires the search input, typeahead, and open-by-URL box inside the search panel. */
export function wireSearchPanel(panel: HTMLElement): void {
  const input = panel.querySelector<HTMLInputElement>("#ds-search-input");
  const suggestEl = panel.querySelector<HTMLElement>("#ds-search-suggest");
  const searchBtn = panel.querySelector<HTMLButtonElement>("#ds-search-btn");
  let debounceTimer: number | undefined;

  const runSearch = (): void => {
    const q = (input?.value ?? "").trim();
    if (!q) return;
    void openExternal(`https://dynasty-scans.com/search?q=${encodeURIComponent(q)}`);
  };

  searchBtn?.addEventListener("click", runSearch);
  input?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") runSearch();
  });
  input?.addEventListener("input", () => {
    window.clearTimeout(debounceTimer);
    const q = (input.value ?? "").trim();
    if (!suggestEl) return;
    if (!q) {
      suggestEl.style.display = "none";
      return;
    }
    debounceTimer = window.setTimeout(() => {
      void loadSuggestions(q, suggestEl);
    }, 250);
  });
  input?.addEventListener("blur", () => {
    window.setTimeout(() => {
      if (suggestEl) suggestEl.style.display = "none";
    }, 150);
  });

  const urlInput = panel.querySelector<HTMLInputElement>("#ds-url-input");
  const urlBtn = panel.querySelector<HTMLButtonElement>("#ds-url-btn");
  const openByUrl = (): void => {
    const raw = (urlInput?.value ?? "").trim();
    if (!raw) {
      setBanner("Paste a dynasty-scans.com series or chapter URL first.");
      return;
    }
    const parsed = parseDynastyUrl(raw);
    if (!parsed) {
      setBanner(
        "Unrecognized URL. Use https://dynasty-scans.com/series/<permalink> or /chapters/<permalink>.",
      );
      return;
    }
    if (parsed.kind === "chapter") {
      navigate({
        view: "reader",
        chapterPermalink: parsed.permalink,
        chapterTitle: parsed.permalink,
      });
    } else {
      navigate({ view: "series", seriesPermalink: parsed.permalink, seriesName: parsed.permalink });
    }
  };
  urlBtn?.addEventListener("click", openByUrl);
  urlInput?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") openByUrl();
  });
}
