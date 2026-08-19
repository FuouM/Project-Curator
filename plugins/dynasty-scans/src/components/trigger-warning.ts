import { decodeEntities } from "../state";
import { getSavedUiScale } from "./settings-modal";

/**
 * Renders an accessible, WinForms-style Content/Trigger Warning confirmation modal
 * for items containing blacklisted tags in "Trigger Warning" mode.
 */
export function showBlacklistWarningModal(
  title: string,
  matchedTags: string[],
  onProceed: () => void,
): void {
  const backdrop = document.createElement("div");
  backdrop.className = "ds-modal-backdrop";

  const scale = getSavedUiScale();
  const modal = document.createElement("div");
  modal.className = "ds-modal-window";
  modal.style.cssText = `width:380px;zoom:${scale};max-height:calc((100vh - 40px) / ${scale});max-width:calc((100vw - 40px) / ${scale});`;

  const tagsListHtml = matchedTags
    .map(
      (t) =>
        `<span class="tag-pill" style="background:#fdf3f4;border:1px solid #f5c2c7;color:#842029;font-weight:600;font-size:11px;padding:2px 7px;"><i class="bi bi-shield-slash-fill"></i> ${decodeEntities(t)}</span>`,
    )
    .join("");

  modal.innerHTML = `
    <div class="ds-modal-header">
      <span class="ds-modal-title" style="color:#d9534f;">
        <i class="bi bi-exclamation-triangle-fill"></i> Content Warning
      </span>
      <button type="button" class="win-button ds-modal-close" id="ds-tw-close" title="Close">
        <i class="bi bi-x-lg"></i>
      </button>
    </div>
    <div class="ds-modal-body" style="display:flex;flex-direction:column;gap:8px;">
      <div style="font-size:12px;font-weight:600;color:var(--sys-window-text,#111);word-break:break-word;">
        ${decodeEntities(title)}
      </div>
      <div style="font-size:11px;color:var(--sys-text-muted,#555);line-height:1.4;">
        This release contains content tagged with tags on your blacklist:
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:4px;max-height:90px;overflow-y:auto;padding:2px 0;">
        ${tagsListHtml}
      </div>
      <div class="ds-muted" style="font-size:11px;color:#777;margin-top:2px;">
        Do you still want to proceed and open this release?
      </div>
    </div>
    <div class="ds-modal-footer" style="display:flex;justify-content:flex-end;gap:8px;padding-top:8px;border-top:1px solid var(--sys-border-light,#ccc);flex-shrink:0;">
      <button type="button" class="win-button" id="ds-tw-cancel" style="min-width:70px;">Cancel</button>
      <button type="button" class="win-button primary" id="ds-tw-proceed" style="min-width:85px;background:#dc3545;border-color:#b02a37;color:#fff;">
        <i class="bi bi-box-arrow-in-right"></i> Proceed
      </button>
    </div>
  `;

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const close = (): void => {
    window.removeEventListener("keydown", onKeyDown);
    backdrop.remove();
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      close();
    }
  };
  window.addEventListener("keydown", onKeyDown);

  modal.querySelector("#ds-tw-close")?.addEventListener("click", close);
  modal.querySelector("#ds-tw-cancel")?.addEventListener("click", close);
  modal.querySelector("#ds-tw-proceed")?.addEventListener("click", () => {
    close();
    onProceed();
  });
  backdrop.addEventListener("click", (ev) => {
    if (ev.target === backdrop) close();
  });
}
