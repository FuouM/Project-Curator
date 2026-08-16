/**
 * Generic URL-compatibility checker for the aria2 engine.
 *
 * aria2c is a pure direct-download engine: it fetches HTTP(S)/FTP resources
 * but does not decrypt containers, log in, solve captchas, or extract stream
 * pages. There is no hoster catalog because aria2 itself has none — links are
 * classified by URL shape alone.
 */

export interface UrlCheckResult {
  url: string;
  status: "verified_direct" | "generic_direct" | "unknown";
  label: string;
  badgeText: string;
  badgeColor: string;
}

export function checkUrlCompatibility(url: string): UrlCheckResult {
  const trimmed = url.trim();
  if (!trimmed) {
    return {
      url: "",
      status: "unknown",
      label: "Invalid URL",
      badgeText: "Invalid",
      badgeColor: "#9ca3af",
    };
  }

  if (trimmed.startsWith("ftp://") || trimmed.startsWith("ftps://")) {
    return {
      url: trimmed,
      status: "verified_direct",
      label: "FTP / FTPS",
      badgeText: "Direct FTP Download",
      badgeColor: "#10b981",
    };
  }

  let hostname = "";
  try {
    hostname = new URL(trimmed).hostname.toLowerCase();
  } catch {
    const match = trimmed.match(/^https?:\/\/([^/?#]+)/i);
    hostname = match ? match[1].toLowerCase() : trimmed.toLowerCase();
  }
  hostname = hostname.replace(/^www\./, "");

  // Direct file URLs.
  if (/\.(zip|rar|7z|tar|gz|xz|iso|img|mp4|mkv|avi|mov|mp3|flac|wav|png|jpg|jpeg|webp|pdf|epub|bin|exe|msi|dmg|deb|rpm)(\?.*)?$/i.test(trimmed)) {
    return {
      url: trimmed,
      status: "generic_direct",
      label: `Direct File (${hostname})`,
      badgeText: "Direct HTTP Download",
      badgeColor: "#3b82f6",
    };
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return {
      url: trimmed,
      status: "unknown",
      label: hostname || "Generic Link",
      badgeText: "Direct HTTP Download",
      badgeColor: "#f59e0b",
    };
  }

  return {
    url: trimmed,
    status: "unknown",
    label: "Unsupported / Invalid",
    badgeText: "Unknown URL format",
    badgeColor: "#ef4444",
  };
}