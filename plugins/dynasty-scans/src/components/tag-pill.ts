/**
 * Tag pill component: categorized, styled, clickable tag chips with
 * type→URL routing. Replaces the verbatim copies in Browse and Series views.
 */

import { navigate, tagClass, tagStyle } from "../state";
import { openExternal } from "../api";
import { el } from "./dom";

export interface TagPillData {
  type: string;
  name: string;
  permalink?: string;
}

export function renderTagPill(t: TagPillData, compact = true): HTMLElement {
  const pill = el("span", {
    class: tagClass(t.type, t.name),
    style: tagStyle(t.type, t.name) + (compact
      ? "font-size:10px;padding:1px 6px;border-radius:2px;"
      : "font-size:10px;padding:2px 6px;border-radius:2px;"),
    title: `${t.type}: ${t.name} (click to open)`,
  });
  pill.textContent = t.name;

  pill.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const type = (t.type ?? "").toLowerCase();
    if (type === "series" || type === "anthology" || type === "issue") {
      navigate({
        view: "series",
        seriesPermalink: t.permalink || t.name,
        seriesName: t.name,
      });
      return;
    }

    let url = "";
    if (type === "author" || type === "artist") {
      url = t.permalink
        ? `https://dynasty-scans.com/authors/${t.permalink}`
        : `https://dynasty-scans.com/search?q=${encodeURIComponent(t.name)}`;
    } else if (type === "scanlator" || type === "group") {
      url = t.permalink
        ? `https://dynasty-scans.com/scanlators/${t.permalink}`
        : `https://dynasty-scans.com/search?q=${encodeURIComponent(t.name)}`;
    } else if (type === "doujin" || type === "doujinshi" || type === "copyright" || type === "parody") {
      url = t.permalink
        ? `https://dynasty-scans.com/doujins/${t.permalink}`
        : `https://dynasty-scans.com/search?q=${encodeURIComponent(t.name)}`;
    } else if (type === "pairing") {
      url = t.permalink
        ? `https://dynasty-scans.com/pairings/${t.permalink}`
        : `https://dynasty-scans.com/search?q=${encodeURIComponent(t.name)}`;
    } else {
      url = t.permalink
        ? `https://dynasty-scans.com/tags/${t.permalink}`
        : `https://dynasty-scans.com/search?q=${encodeURIComponent(t.name)}`;
    }
    void openExternal(url);
  });

  return pill;
}