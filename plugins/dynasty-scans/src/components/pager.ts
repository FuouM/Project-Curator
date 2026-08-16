/**
 * Reusable pagination widget. Replaces the near-identical pager copies in the
 * Browse and Library views.
 */

import { el } from "./dom";

export function renderPager(
  totalPages: number,
  currentPage: number,
  onPage: (p: number) => void,
  opts: { cssText?: string; showLabels?: boolean; ariaLabel?: string } = {}
): HTMLElement {
  const showLabels = opts.showLabels ?? false;
  const row = el("div", {
    class: "ds-row",
    style: opts.cssText ?? (showLabels
      ? "align-items:center;justify-content:space-between;"
      : "margin-top:8px;"),
  });

  const prev = el("button", {
    type: "button",
    class: "win-button",
    style: "font-size:10px;padding:1px 8px;",
    title: opts.ariaLabel ? `${opts.ariaLabel} — previous page` : "Previous page",
  });
  prev.innerHTML = showLabels
    ? '<i class="bi bi-chevron-left"></i> Prev'
    : '<i class="bi bi-chevron-left"></i>';
  prev.disabled = currentPage <= 1;
  prev.addEventListener("click", () => onPage(currentPage - 1));

  const label = el("span", {
    class: "ds-progress-text",
    style: "font-size:11px;color:var(--sys-text-muted, #666);",
  });
  label.textContent = `Page ${currentPage} of ${totalPages}`;

  const next = el("button", {
    type: "button",
    class: "win-button",
    style: "font-size:10px;padding:1px 8px;",
    title: opts.ariaLabel ? `${opts.ariaLabel} — next page` : "Next page",
  });
  next.innerHTML = showLabels
    ? 'Next <i class="bi bi-chevron-right"></i>'
    : '<i class="bi bi-chevron-right"></i>';
  next.disabled = currentPage >= totalPages;
  next.addEventListener("click", () => onPage(currentPage + 1));

  row.appendChild(prev);
  row.appendChild(label);
  row.appendChild(next);
  return row;
}