/**
 * aria2 engine tool-status banner + install driver for aria2-downloader.
 *
 * Owns the in-tab setup banner (shown when aria2c is missing), the
 * `refreshToolStatus` availability probe, and `runEngineInstall` which streams
 * `GetToolInstallProgress` into the tab's log dock until the install task
 * reaches a terminal state.
 */

import { appendLogLines } from "../../lib";
import { checkTool, getToolInstallProgress, installTool } from "./ipc";
import { state, ARIA2_TOOL } from "./state";
import { el, log } from "./ui-core";

export function defaultBannerText(): string {
  return state.toolInstalling
    ? "Installing aria2 engine..."
    : "aria2 engine not found. Download & install it to enable multi-connection downloads.";
}

export function setToolBanner(available: boolean, version: string | null, message: string, bannerEl?: HTMLElement): void {
  const banner = bannerEl ?? el("ad-banner");
  const text = banner?.querySelector<HTMLElement>("#ad-banner-text");
  if (!banner || !text) return;
  if (available) {
    banner.style.display = "none";
    return;
  }
  banner.style.display = "flex";
  text.textContent = message + (version ? ` (${version})` : "");
}

export async function refreshToolStatus(bannerEl?: HTMLElement): Promise<void> {
  try {
    const status = await checkTool(ARIA2_TOOL);
    state.toolAvailable = status.installed;
    state.toolVersion = status.version;
  } catch (err) {
    state.toolAvailable = false;
    state.toolVersion = null;
    log(`Tool check failed: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
  setToolBanner(state.toolAvailable, state.toolVersion, defaultBannerText(), bannerEl);
}

interface EngineInstallHooks {
  /** Called on each poll with (status, percent). */
  onStatus?: (status: string, percent: number) => void;
  /** Called once when the install task finishes. */
  onDone?: (ok: boolean, error: string | null) => void;
}

/**
 * aria2 engine install driver. Starts `InstallTool` (or adopts an install that
 * is already running) and streams `GetToolInstallProgress` into the tab's log
 * dock until the task reaches a terminal status. Progress is surfaced in the
 * in-tab prompt banner via the onStatus/onDone hooks.
 */
function runEngineInstall({ onStatus, onDone }: EngineInstallHooks): void {
  let rendered = 0;

  const finish = (ok: boolean, error: string | null): void => {
    state.toolInstalling = false;
    if (onDone) onDone(ok, error);
  };

  const poll = async (): Promise<void> => {
    let p: { status: string; percent: number; logs: string[]; error: string | null };
    try {
      p = await getToolInstallProgress(ARIA2_TOOL);
    } catch (err) {
      p = { status: "error", percent: 0, logs: [String(err)], error: String(err) };
    }
    if (onStatus) onStatus(p.status, p.percent);
    rendered = appendLogLines("ad-log", p.logs, rendered);

    if (p.status === "completed" || p.status === "done") {
      log("Install complete.", "success");
      await refreshToolStatus();
      finish(true, null);
      return;
    }
    if (p.status === "failed" || p.status === "error") {
      log(`Install failed: ${p.error ?? p.status}`, "error");
      finish(false, p.error ?? p.status);
      return;
    }
    setTimeout(() => void poll(), 1000);
  };

  const start = async (): Promise<void> => {
    try {
      const { started, error } = await installTool(ARIA2_TOOL);
      if (!started) {
        if (error) {
          log(`Install could not start: ${error}`, "error");
          finish(false, error);
        } else {
          log("aria2 engine is already installed.", "success");
          await refreshToolStatus();
          finish(true, null);
        }
        return;
      }
    } catch (err) {
      log(`Install start failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      finish(false, err instanceof Error ? err.message : String(err));
      return;
    }
    await poll();
  };

  void start();
}

export async function installAria2(): Promise<void> {
  if (state.toolInstalling) return;
  state.toolInstalling = true;
  const installBtn = el<HTMLButtonElement>("ad-install-btn");
  if (installBtn) installBtn.disabled = true;
  const statusEl = el("ad-banner-status");
  const progressEl = el("ad-banner-progress");
  const fill = el<HTMLElement>("ad-banner-fill");
  if (statusEl) {
    statusEl.style.display = "block";
    statusEl.textContent = "Starting install...";
  }
  if (progressEl) progressEl.style.display = "block";
  if (fill) fill.style.width = "0%";
  log("Installing aria2 engine...", "info");

  runEngineInstall({
    onStatus: (status, percent) => {
      if (statusEl) statusEl.textContent = `${status} ${percent}%`;
      if (fill) fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    },
    onDone: (ok, error) => {
      if (installBtn) installBtn.disabled = false;
      if (ok) {
        if (statusEl) statusEl.textContent = "Installed.";
        if (fill) fill.style.width = "100%";
        log("aria2 installed successfully.", "success");
      } else {
        if (statusEl) statusEl.textContent = error ?? "Install failed.";
        log(`aria2 install failed: ${error}`, "error");
      }
    },
  });
}
