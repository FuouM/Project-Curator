/**
 * Console-logging installer view for the miniPaint editor runtime.
 *
 * Shown when `plugins/minipaint/editor/` has not been extracted yet. Kicks off
 * the service-side `InstallPluginRuntime` task and polls progress into a
 * color-coded console (same createLogger style as the app diagnostics).
 */

import { createLogger, appendLogLines, pollServiceProgress } from "../../lib";
import { startInstallation, getProgress } from "./ipc";

export function renderInstaller(onComplete: () => void): HTMLElement {
  const container = document.createElement("div");
  container.className = "group-box";
  container.style.cssText = "margin-top:8px;";

  container.innerHTML = `
    <div class="group-box-title"><i class="bi bi-palette"></i> miniPaint Editor Setup</div>
    <div style="font-size:11px;margin-bottom:12px;line-height:1.5;color:#555;">
      miniPaint (v4.14.3) is not installed locally. Click below to download and extract
      the editor runtime — it is served entirely offline from this machine.
    </div>
    <button type="button" class="win-button primary" id="minipaint-install-btn">
      <i class="bi bi-download"></i> Download &amp; Install Editor
    </button>
    <div class="group-box" style="margin-top:12px;">
      <div class="group-box-title"><i class="bi bi-terminal"></i> Install Console</div>
      <div id="minipaint-install-log" style="height:180px;overflow-y:auto;background-color:#1e1e1e;color:#cccccc;border:1px solid #7a7a7a;padding:8px;font-family:'Consolas',monospace;font-size:11px;white-space:pre-wrap;"></div>
    </div>
  `;

  const log = createLogger("minipaint-install-log");
  const btn = container.querySelector<HTMLButtonElement>("#minipaint-install-btn")!;

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    log("Starting install task…", "info");
    let started = false;
    try {
      started = await startInstallation();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`Failed to launch installer: ${msg}`, "error");
      btn.disabled = false;
      return;
    }
    if (!started) {
      log("An install is already running; polling existing task.", "info");
    }
    pollProgress();
  });

  function pollProgress(): void {
    let rendered = 0;
    pollServiceProgress({
      fetch: async () => {
        try {
          return await getProgress();
        } catch {
          return undefined; // transient IPC error; keep polling
        }
      },
      isRunning: (p) => p.status !== "completed" && p.status !== "failed",
      onTick: (p) => {
        rendered = appendLogLines("minipaint-install-log", p.logs, rendered);
      },
      onComplete: (ok, last) => {
        const p = last;
        if (p && p.status === "failed") {
          log(`Install failed: ${p.error || "unknown error"}`, "error");
          btn.disabled = false;
          return;
        }
        log("Install completed.", "success");
        onComplete();
      },
    });
  }

  return container;
}