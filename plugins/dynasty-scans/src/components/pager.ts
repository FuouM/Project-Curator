/**
 * Reusable pagination widget for Browse and Library views.
 * Icon-only First, Previous, Page N of Total with Jump-to-Page input & Go, Next, and Last.
 */

import { el } from "./dom";

export interface PagerOptions {
  cssText?: string;
  ariaLabel?: string;
}

export function renderPager(
  totalPages: number,
  currentPage: number,
  onPage: (p: number) => void,
  opts: PagerOptions = {},
): HTMLElement {
  const row = el("div", {
    class: "ds-row ds-pager-widget",
    style:
      opts.cssText ??
      "align-items:center;justify-content:flex-end;gap:4px;margin-top:8px;flex-wrap:wrap;",
  });

  // First Button (<<)
  const first = el("button", {
    type: "button",
    class: "win-button ds-btn-sm",
    style: "font-size:10px;padding:1px 6px;",
    title: "First page (Page 1)",
  });
  first.innerHTML = '<i class="bi bi-chevron-double-left"></i>';
  first.disabled = currentPage <= 1;
  first.addEventListener("click", () => {
    if (currentPage > 1) onPage(1);
  });

  // Prev Button (<)
  const prev = el("button", {
    type: "button",
    class: "win-button ds-btn-sm",
    style: "font-size:10px;padding:1px 6px;",
    title: "Previous page",
  });
  prev.innerHTML = '<i class="bi bi-chevron-left"></i>';
  prev.disabled = currentPage <= 1;
  prev.addEventListener("click", () => {
    if (currentPage > 1) onPage(currentPage - 1);
  });

  // Page Jump Controls (Page [ input ] of Total [Go])
  const jumpWrap = el("div", {
    class: "ds-row",
    style: "align-items:center;gap:3px;margin:0 2px;",
  });

  const pageLabelBefore = el("span", {
    class: "ds-progress-text",
    style: "font-size:11px;color:var(--sys-text-muted, #666);",
  });
  pageLabelBefore.textContent = "Page";

  const pageInput = el("input", {
    type: "number",
    min: "1",
    max: String(Math.max(1, totalPages)),
    value: String(currentPage),
    class: "input-field",
    style: "width:42px;height:20px;text-align:center;font-size:11px;padding:1px 2px;",
    title: "Enter page number and press Enter",
  }) as HTMLInputElement;

  const pageLabelAfter = el("span", {
    class: "ds-progress-text",
    style: "font-size:11px;color:var(--sys-text-muted, #666);",
  });
  pageLabelAfter.textContent = `of ${totalPages}`;

  const goBtn = el("button", {
    type: "button",
    class: "win-button ds-btn-sm",
    style: "font-size:10px;padding:1px 5px;",
    title: "Jump to page",
  });
  goBtn.textContent = "Go";

  const doJump = () => {
    const target = parseInt(pageInput.value, 10);
    if (!isNaN(target)) {
      const clamped = Math.max(1, Math.min(totalPages, target));
      if (clamped !== currentPage) {
        onPage(clamped);
      }
    }
  };

  goBtn.addEventListener("click", doJump);
  pageInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      doJump();
    }
  });

  jumpWrap.appendChild(pageLabelBefore);
  jumpWrap.appendChild(pageInput);
  jumpWrap.appendChild(pageLabelAfter);
  jumpWrap.appendChild(goBtn);

  // Next Button (>)
  const next = el("button", {
    type: "button",
    class: "win-button ds-btn-sm",
    style: "font-size:10px;padding:1px 6px;",
    title: "Next page",
  });
  next.innerHTML = '<i class="bi bi-chevron-right"></i>';
  next.disabled = currentPage >= totalPages;
  next.addEventListener("click", () => {
    if (currentPage < totalPages) onPage(currentPage + 1);
  });

  // Last Button (>>)
  const last = el("button", {
    type: "button",
    class: "win-button ds-btn-sm",
    style: "font-size:10px;padding:1px 6px;",
    title: `Last page (Page ${totalPages})`,
  });
  last.innerHTML = '<i class="bi bi-chevron-double-right"></i>';
  last.disabled = currentPage >= totalPages;
  last.addEventListener("click", () => {
    if (currentPage < totalPages) onPage(totalPages);
  });

  row.appendChild(first);
  row.appendChild(prev);
  row.appendChild(jumpWrap);
  row.appendChild(next);
  row.appendChild(last);

  return row;
}
