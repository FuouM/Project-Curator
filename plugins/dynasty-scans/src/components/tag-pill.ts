/**
 * Tag pill component: categorized, styled, clickable tag chips with
 * type→URL routing. Replaces the verbatim copies in Browse and Series views.
 */

import { navigate, tagClass, tagStyle } from "../state";
import { el } from "./dom";

export interface TagPillData {
  type: string;
  name: string;
  permalink?: string;
}

export function renderTagPill(t: TagPillData, compact = true): HTMLElement {
  const pill = el("span", {
    class: tagClass(t.type),
    style:
      tagStyle(t.type, t.name) +
      (compact
        ? "font-size:10px;padding:1px 6px;border-radius:2px;"
        : "font-size:10px;padding:2px 6px;border-radius:2px;"),
    title: `${t.type}: ${t.name} (click to open)`,
  });
  pill.textContent = t.name;

  pill.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (t.permalink) {
      navigate({
        view: "series",
        seriesPermalink: t.permalink,
        seriesName: t.name,
      });
      return;
    }

    navigate({
      view: "browse",
      browseTab: "search",
      searchQuery: t.name,
    });
  });

  return pill;
}
