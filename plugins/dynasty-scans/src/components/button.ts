/**
 * Button components: standard push buttons and the two-click confirm-delete
 * pattern shared by the Library and Cache views.
 */

import { setBanner } from "../state";
import { el } from "./dom";

/** Standard WinForms-style push button. */
export function createButton(
  html: string,
  title?: string,
  cssText = "font-size:11px;padding:2px 8px;",
): HTMLButtonElement {
  const btn = el("button", { type: "button", class: "win-button", style: cssText, title });
  btn.innerHTML = html;
  return btn;
}

/**
 * Two-click destructive button: first click arms the "Delete?" confirmation,
 * a second click inside the button confirms. Clicking anywhere else cancels.
 * Used identically in the Library and Cache views (previously duplicated).
 */
export function createConfirmDeleteButton(
  title: string,
  onConfirm: () => Promise<void>,
  initialHtml = '<i class="bi bi-trash3"></i>',
): HTMLElement {
  const btn = el("button", {
    type: "button",
    class: "win-button",
    style: "font-size:11px;padding:2px 8px;flex-shrink:0;",
    title,
  });
  btn.innerHTML = initialHtml;

  let confirming = false;
  let originalHtml = initialHtml;

  const reset = (): void => {
    confirming = false;
    btn.className = "win-button";
    btn.style.color = "";
    btn.style.backgroundColor = "";
    btn.style.borderColor = "";
    btn.innerHTML = originalHtml;
    btn.title = title;
    document.removeEventListener("click", onDocClick);
  };

  const onDocClick = (ev: MouseEvent): void => {
    if (!btn.contains(ev.target as Node)) {
      reset();
    }
  };

  btn.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    if (!confirming) {
      originalHtml = btn.innerHTML;
      confirming = true;
      btn.className = "win-button primary ds-danger";
      btn.innerHTML = '<i class="bi bi-check-lg"></i> Delete?';
      btn.title = "Click again to confirm deletion, or click outside to cancel";
      setTimeout(() => {
        document.addEventListener("click", onDocClick);
      }, 0);
      return;
    }

    document.removeEventListener("click", onDocClick);
    btn.disabled = true;
    btn.innerHTML = '<i class="bi bi-hourglass-split"></i>';
    try {
      await onConfirm();
    } catch (err) {
      btn.disabled = false;
      reset();
      const msg = err instanceof Error ? err.message : String(err);
      setBanner(`Deletion failed: ${msg}`);
    }
  });

  return btn;
}
