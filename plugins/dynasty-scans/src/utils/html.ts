/**
 * HTML escaping / entity decoding helpers shared across views.
 */

/** Escapes a string for safe use inside an HTML attribute value. */
export function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Decodes HTML entities into clean human-readable unicode text for safe DOM textContent rendering.
 */
export function decodeEntities(str: string | null | undefined): string {
  if (!str) return "";
  let s = String(str);
  // Iteratively unescape entities (handles double-escaped &amp;quot; -> &quot; -> ")
  for (let i = 0; i < 2; i++) {
    if (!s.includes("&")) break;
    s = s
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&#039;|&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&ndash;/g, "–")
      .replace(/&mdash;/g, "—")
      .replace(/&hellip;/g, "…")
      .replace(/&nbsp;/g, " ")
      .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
  return s;
}
