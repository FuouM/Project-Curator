import { SITE_ROOT } from "../state";
import { cachedJson } from "./client";
import type { Chapter } from "../types/api";

/** Chapter detail (pages + tags). Cached forever; refreshed manually if needed. */
export function fetchChapter(permalink: string): Promise<Chapter> {
  return cachedJson<Chapter>(`chapter:${permalink}`, `${SITE_ROOT}/chapters/${permalink}.json`);
}
