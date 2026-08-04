// ── Better Alert Modal ────────────────────────────────────────────────
// Centered modal dialog with an icon header, copyable error message,
// and OK / close actions. Replaces raw window.alert() calls.

export type AlertKind = "error" | "warning" | "info" | "success";

export interface AlertOptions {
  title?: string;
  message: string;
  kind?: AlertKind;
}

const KIND_ICONS: Record<AlertKind, string> = {
  error: "bi bi-exclamation-octagon-fill",
  warning: "bi bi-exclamation-triangle-fill",
  info: "bi bi-info-circle-fill",
  success: "bi bi-check-circle-fill",
};

const KIND_DEFAULT_TITLES: Record<AlertKind, string> = {
  error: "Error",
  warning: "Warning",
  info: "Notice",
  success: "Success",
};

let alertEl: HTMLElement | null = null;

function kindIcon(kind: AlertKind): string {
  return KIND_ICONS[kind] ?? KIND_ICONS.info;
}

function buildAlertDom(): HTMLElement {
  const el = document.createElement("div");
  el.className = "alert-modal";
  el.innerHTML = `
    <div class="alert-modal-content">
      <div class="alert-modal-header">
        <span class="alert-modal-title"><i class="${kindIcon("info")}"></i><span class="alert-modal-title-text"></span></span>
        <div class="modal-close" data-alert-close title="Close">&times;</div>
      </div>
      <div class="alert-modal-body">
        <div class="alert-modal-message"></div>
      </div>
      <div class="alert-modal-footer">
        <button type="button" class="win-button" data-alert-copy title="Copy message to clipboard"><i class="bi bi-clipboard"></i> Copy</button>
        <button type="button" class="win-button primary" data-alert-ok><i class="bi bi-check-lg"></i> OK</button>
      </div>
    </div>
  `;
  document.body.appendChild(el);

  el.querySelector("[data-alert-close]")?.addEventListener("click", closeAlert);
  el.querySelector("[data-alert-ok]")?.addEventListener("click", closeAlert);
  el.querySelector("[data-alert-copy]")?.addEventListener("click", copyAlert);
  el.addEventListener("mousedown", (e) => {
    if (e.target === el) closeAlert();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAlert();
  });

  return el;
}

export function showAlert(options: AlertOptions): void {
  const kind = options.kind ?? "info";
  if (!alertEl || !document.body.contains(alertEl)) {
    alertEl = buildAlertDom();
  }

  const titleEl = alertEl.querySelector(".alert-modal-title-text") as HTMLElement | null;
  if (titleEl) titleEl.textContent = options.title || KIND_DEFAULT_TITLES[kind] || "Notice";

  const iconEl = alertEl.querySelector(".alert-modal-title i") as HTMLElement | null;
  if (iconEl) iconEl.className = kindIcon(kind);

  const msgEl = alertEl.querySelector(".alert-modal-message") as HTMLElement | null;
  if (msgEl) msgEl.textContent = options.message;

  alertEl.className = `alert-modal ${kind}`;
  alertEl.classList.add("active");
}

export function closeAlert(): void {
  if (alertEl) alertEl.classList.remove("active");
}

export function showErrorAlert(message: string, title = "Error"): void {
  showAlert({ kind: "error", title, message });
}

export function showWarningAlert(message: string, title = "Warning"): void {
  showAlert({ kind: "warning", title, message });
}

export function showInfoAlert(message: string, title = "Notice"): void {
  showAlert({ kind: "info", title, message });
}

export function showSuccessAlert(message: string, title = "Success"): void {
  showAlert({ kind: "success", title, message });
}

async function copyAlert(): Promise<void> {
  const msgEl = alertEl?.querySelector(".alert-modal-message");
  if (!msgEl || !alertEl) return;

  const text = msgEl.textContent ?? "";
  let copied = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      copied = true;
    }
  } catch {
    copied = false;
  }
  if (!copied) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    ta.remove();
  }

  const btn = alertEl.querySelector("[data-alert-copy]") as HTMLElement | null;
  if (!btn) return;
  const original = btn.innerHTML;
  btn.innerHTML = '<i class="bi bi-check-lg"></i> Copied';
  btn.classList.add("copied");
  window.setTimeout(() => {
    btn.innerHTML = original;
    btn.classList.remove("copied");
  }, 1500);
}
