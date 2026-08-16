import { invoke } from "@tauri-apps/api/core";

export function logJS(msg: string) {
  invoke("log_frontend", { message: msg }).catch(() => {});
}

export function safeStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
}

export function setStatusMessage(el: HTMLElement | null, message: string, state: "loading" | "success" | "error") {
  if (!el) return;
  el.textContent = message;
  el.style.color = state === "loading" ? "#fbbf24" : state === "success" ? "#10b981" : "#ef4444";
}

export function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

export function formatDate(dateStr: string): string {
  try {
    const normalized = dateStr.endsWith("Z") || dateStr.includes("+") || dateStr.includes("T")
      ? dateStr
      : dateStr.replace(" ", "T") + "Z";
    const d = new Date(normalized);
    return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return dateStr;
  }
}

export function imageBytesToPngBlob(bytes: Uint8Array): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([bytes]);
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) { URL.revokeObjectURL(url); reject(new Error("No canvas context")); return; }
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob((pngBlob) => {
        if (pngBlob) resolve(pngBlob);
        else reject(new Error("Canvas toBlob failed"));
      }, "image/png");
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Failed to load image")); };
    img.src = url;
  });
}

export function setupInputClearButtons() {

  const inputs = document.querySelectorAll<HTMLInputElement>('.input-field.has-clear');

  inputs.forEach((input) => {
    const wrapper = input.closest('.input-wrapper');
    if (!wrapper) return;

    const clearBtn = wrapper.querySelector('.input-clear-btn') as HTMLButtonElement;
    if (!clearBtn) return;

    function updateClearVisibility() {
      if (input.value.length > 0) {
        wrapper!.classList.add('has-value');
      } else {
        wrapper!.classList.remove('has-value');
      }
    }

    input.addEventListener('input', updateClearVisibility);
    input.addEventListener('change', updateClearVisibility);
    updateClearVisibility();

    clearBtn.addEventListener('click', () => {
      input.value = '';
      updateClearVisibility();
      input.focus();
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });
}

