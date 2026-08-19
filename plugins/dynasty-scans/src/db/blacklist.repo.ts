import { execute, query } from "./client";

export interface BlacklistedTag {
  tag_name: string;
  tag_permalink?: string;
  created_at: number;
}

export interface BlacklistCheckResult {
  blacklisted: boolean;
  matchedTags: string[];
}

export type BlacklistMode = "hide" | "warn";

export function getBlacklistMode(): BlacklistMode {
  return (localStorage.getItem("ds-blacklist-mode") as BlacklistMode) || "hide";
}

export function setBlacklistMode(mode: BlacklistMode): void {
  localStorage.setItem("ds-blacklist-mode", mode);
}

let cachedBlacklistNames = new Set<string>();

/**
 * Loads the active tag blacklist into memory for ultra-fast synchronous checks.
 */
export async function initBlacklistCache(): Promise<void> {
  const rows = await getBlacklistedTags();
  cachedBlacklistNames = new Set(
    rows.flatMap((r) => [
      r.tag_name.toLowerCase().trim(),
      ...(r.tag_permalink ? [r.tag_permalink.toLowerCase().trim()] : []),
    ]),
  );
}

/**
 * Returns all blacklisted tags sorted by creation time.
 * Errors propagate so the UI can surface a broken blacklist instead of
 * silently rendering "no blacklist" (AGENTS §7.11).
 */
export async function getBlacklistedTags(): Promise<BlacklistedTag[]> {
  return query<BlacklistedTag>(
    "SELECT tag_name, tag_permalink, created_at FROM tag_blacklist ORDER BY created_at DESC",
    [],
  );
}

/**
 * Adds a tag to the SQLite blacklist and updates the in-memory cache.
 */
export async function addBlacklistedTag(name: string, permalink?: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  const now = Date.now();

  await execute(
    "INSERT OR REPLACE INTO tag_blacklist (tag_name, tag_permalink, created_at) VALUES (?, ?, ?)",
    [trimmed, permalink ? permalink.trim() : null, now],
  );

  cachedBlacklistNames.add(trimmed.toLowerCase());
  if (permalink) {
    cachedBlacklistNames.add(permalink.trim().toLowerCase());
  }
}

/**
 * Removes a tag from the SQLite blacklist and updates the in-memory cache.
 */
export async function removeBlacklistedTag(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;

  await execute("DELETE FROM tag_blacklist WHERE tag_name = ?", [trimmed]);
  cachedBlacklistNames.delete(trimmed.toLowerCase());
  // Refresh cache to ensure permalink aliases are cleaned properly
  void initBlacklistCache();
}

/**
 * Synchronously checks if any of the given tags match the active blacklist.
 */
export function isItemBlacklisted(
  tags: { name: string; permalink?: string }[] | undefined,
): BlacklistCheckResult {
  if (!tags || tags.length === 0 || cachedBlacklistNames.size === 0) {
    return { blacklisted: false, matchedTags: [] };
  }

  const matched: string[] = [];
  for (const t of tags) {
    const nameLower = (t.name || "").toLowerCase().trim();
    const permLower = (t.permalink || "").toLowerCase().trim();

    if (
      (nameLower && cachedBlacklistNames.has(nameLower)) ||
      (permLower && cachedBlacklistNames.has(permLower))
    ) {
      matched.push(t.name || t.permalink || "Unknown");
    }
  }

  return {
    blacklisted: matched.length > 0,
    matchedTags: matched,
  };
}
