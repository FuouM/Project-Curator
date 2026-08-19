import { SITE_ROOT } from "../state";
import { cachedJson, httpGetText } from "./client";
import { FEED_TTL_MS } from "./feed";
import type { Directory, DirectoryGroup, SuggestResult } from "../types/api";

/** Series / tag directories, cached for one hour. */
export function fetchDirectory(urlPath: string, key: string): Promise<Directory> {
  return cachedJson<Directory>(key, SITE_ROOT + urlPath, FEED_TTL_MS);
}

/** Normalized, ordered letter → entries groups from a directory payload. */
export function directoryGroups(d: Directory | any): DirectoryGroup[] {
  if (!d) return [];
  const rawList = d.tags ?? (Array.isArray(d) ? d : []);
  if (!Array.isArray(rawList)) return [];
  return rawList
    .map((obj) => {
      if (obj && typeof obj === "object") {
        const letter = Object.keys(obj)[0] ?? "?";
        const entries = Array.isArray(obj[letter]) ? obj[letter] : [];
        return { letter, entries };
      }
      return { letter: "?", entries: [] };
    })
    .filter((g) => g.entries.length > 0);
}

/** Search typeahead suggestions. */
export async function suggest(query: string): Promise<SuggestResult[]> {
  const { status, body } = await httpGetText(`${SITE_ROOT}/tags/suggest`, {
    method: "POST",
    body: `query=${encodeURIComponent(query)}`,
  });
  if (status !== 200) throw new Error(`HTTP ${status} for /tags/suggest`);
  return JSON.parse(body) as SuggestResult[];
}
