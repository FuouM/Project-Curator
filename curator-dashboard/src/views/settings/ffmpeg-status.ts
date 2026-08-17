import { typedCall } from "../../ipc";
import { invoke } from "@tauri-apps/api/core";
import { EmptySchema } from "@bufbuild/protobuf/wkt";
import { setStatusMessage } from "../../utils";
import {
  FFmpegStatusResultSchema,
  SetFFmpegPathRequestSchema,
  DownloadProgressResultSchema,
  DownloadStatusUpdateSchema,
} from "../../gen/models_pb";

let ffmpegStatusRow: HTMLElement | null = null;
let ffmpegPathInput: HTMLInputElement | null = null;
let ffmpegSaveStatus: HTMLElement | null = null;
let ffmpegDlTimer: number | null = null;

export async function refreshFfmpegStatus() {
  if (!ffmpegStatusRow) return;
  try {
    const resp = await typedCall(
      "ModelsService.GetFFmpegStatus",
      null,
      null,
      FFmpegStatusResultSchema,
    );
    const r = resp;
    if (r.available) {
      ffmpegStatusRow.innerHTML =
        `<span style="color: #107c41;"><i class="bi bi-check-circle-fill"></i> Available</span>` +
        `<code style="font-size: 10px; word-break: break-all;">${r.resolvedPath ?? ""}</code>` +
        (r.version ? `<span style="color: #666;">${r.version}</span>` : "");
    } else {
      ffmpegStatusRow.innerHTML =
        `<span style="color: #a4262c;"><i class="bi bi-exclamation-circle-fill"></i> Not found</span>` +
        `<span style="color: #666;">Video import/transcoding requires FFmpeg. Place <code>ffmpeg.exe</code> in the data <code>bin</code> folder or set a path below.</span>`;
    }
    if (ffmpegPathInput) {
      ffmpegPathInput.value = r.resolvedPath ?? "";
    }

    // Show "Use portable build" button if a portable exists but isn't the active path
    const existingPortableBtn = document.getElementById("use-portable-ffmpeg-btn");
    if (existingPortableBtn) existingPortableBtn.remove();

    const portablePath: string | null = r.portablePath ?? null;
    const isAlreadyUsingPortable =
      r.resolvedPath && portablePath && r.resolvedPath.toLowerCase() === portablePath.toLowerCase();

    if (portablePath && !isAlreadyUsingPortable) {
      const portableRow = document.createElement("div");
      portableRow.style.cssText =
        "display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px;";
      portableRow.innerHTML =
        `<span style="font-size:11px;color:#107c41;"><i class="bi bi-box-seam"></i> Portable build available</span>` +
        `<code style="font-size:10px;word-break:break-all;">${portablePath}</code>` +
        `<button class="win-button primary" id="use-portable-ffmpeg-btn"><i class="bi bi-arrow-left-right"></i> Switch to portable</button>`;
      ffmpegStatusRow.appendChild(portableRow);

      document.getElementById("use-portable-ffmpeg-btn")?.addEventListener("click", async () => {
        if (!ffmpegSaveStatus) return;
        setStatusMessage(ffmpegSaveStatus, "Switching to portable build...", "loading");
        try {
          await typedCall(
            "ModelsService.SetFFmpegPath",
            SetFFmpegPathRequestSchema,
            { path: portablePath },
            EmptySchema,
          );
          setStatusMessage(ffmpegSaveStatus, "Switched to portable build.", "success");
          await refreshFfmpegStatus();
        } catch (e: any) {
          setStatusMessage(ffmpegSaveStatus, "Error: " + (e.message || e), "error");
        }
      });
    }
  } catch (e) {}
}

export function ffmpegDlStopPolling() {
  if (ffmpegDlTimer !== null) {
    window.clearInterval(ffmpegDlTimer);
    ffmpegDlTimer = null;
  }
}

function ffmpegDlStartPolling() {
  ffmpegDlStopPolling();
  ffmpegDlTimer = window.setInterval(async () => {
    try {
      const resp = await typedCall(
        "ModelsService.GetDownloadProgress",
        null,
        null,
        DownloadProgressResultSchema,
      );
      const dl = resp.downloads.find((d) => d.modelId === "ffmpeg-portable");
      if (!dl) return;
      const bytesTotal = Number(dl.bytesTotal);
      const bytesDownloaded = Number(dl.bytesDownloaded);
      const pct = bytesTotal > 0 ? Math.round((bytesDownloaded / bytesTotal) * 100) : 0;
      const ffmpegDlBar = document.getElementById("ffmpeg-dl-progress");
      const ffmpegDlFill = document.getElementById("ffmpeg-dl-progress-fill");
      const ffmpegDlStatus = document.getElementById("ffmpeg-dl-status-msg");
      const ffmpegDlBtn = document.getElementById("download-ffmpeg-btn");
      if (ffmpegDlBar) ffmpegDlBar.style.display = "";
      if (dl.status === "extracting") {
        if (ffmpegDlFill) ffmpegDlFill.style.width = "100%";
        if (ffmpegDlStatus)
          setStatusMessage(ffmpegDlStatus, "Extracting... please wait", "loading");
      } else {
        if (ffmpegDlFill) ffmpegDlFill.style.width = pct + "%";
        if (ffmpegDlStatus) {
          setStatusMessage(
            ffmpegDlStatus,
            `Downloading... ${pct}% (${bytesDownloaded} / ${bytesTotal} bytes)`,
            "loading",
          );
        }
      }
      if (dl.status === "completed") {
        ffmpegDlStopPolling();
        if (ffmpegDlBar) ffmpegDlBar.style.display = "none";
        setStatusMessage(ffmpegDlStatus!, "FFmpeg downloaded and verified.", "success");
        if (ffmpegDlBtn) ffmpegDlBtn.removeAttribute("disabled");
        await refreshFfmpegStatus();
      } else if (dl.status === "failed" || dl.status === "cancelled") {
        ffmpegDlStopPolling();
        if (ffmpegDlBar) ffmpegDlBar.style.display = "none";
        setStatusMessage(ffmpegDlStatus!, dl.error || `FFmpeg download ${dl.status}.`, "error");
        if (ffmpegDlBtn) ffmpegDlBtn.removeAttribute("disabled");
      }
    } catch (e) {
      // transient poll errors are ignored; next tick retries
    }
  }, 500);
}

export function setupFfmpegListeners(
  ffmpegStatusRowEl: HTMLElement | null,
  ffmpegPathInputEl: HTMLInputElement | null,
  ffmpegSaveStatusEl: HTMLElement | null,
) {
  ffmpegStatusRow = ffmpegStatusRowEl;
  ffmpegPathInput = ffmpegPathInputEl;
  ffmpegSaveStatus = ffmpegSaveStatusEl;

  document.getElementById("browse-ffmpeg-btn")?.addEventListener("click", async () => {
    try {
      const selected: string | null = await invoke("select_path", { isDirectory: false });
      if (selected && ffmpegPathInput) {
        ffmpegPathInput.value = selected;
      }
    } catch (e) {
      console.error("FFmpeg browse error:", e);
    }
  });

  document.getElementById("save-ffmpeg-path-btn")?.addEventListener("click", async () => {
    if (!ffmpegSaveStatus) return;
    const value = ffmpegPathInput ? ffmpegPathInput.value.trim() : "";
    setStatusMessage(ffmpegSaveStatus, "Saving...", "loading");
    try {
      await typedCall(
        "ModelsService.SetFFmpegPath",
        SetFFmpegPathRequestSchema,
        { path: value || undefined },
        EmptySchema,
      );
      setStatusMessage(ffmpegSaveStatus, "FFmpeg path saved.", "success");
      await refreshFfmpegStatus();
    } catch (e: any) {
      setStatusMessage(ffmpegSaveStatus, "Error: " + (e.message || e), "error");
    }
  });

  document.getElementById("ffmpeg-release-link")?.addEventListener("click", () => {
    window.open("https://www.gyan.dev/ffmpeg/builds/", "_blank", "noopener");
  });

  document.getElementById("download-ffmpeg-btn")?.addEventListener("click", async () => {
    const ffmpegDlStatus = document.getElementById("ffmpeg-dl-status-msg");
    if (!ffmpegDlStatus) return;
    const ffmpegDlBtn = document.getElementById("download-ffmpeg-btn");
    setStatusMessage(ffmpegDlStatus, "Starting download...", "loading");
    ffmpegDlBtn?.setAttribute("disabled", "true");
    try {
      const resp = await typedCall(
        "ModelsService.DownloadFFmpeg",
        null,
        null,
        DownloadStatusUpdateSchema,
      );
      const prog = resp.progress;
      if (prog && prog.status === "downloading" && !resp.complete) {
        setStatusMessage(ffmpegDlStatus, "Download started.", "loading");
        ffmpegDlStartPolling();
      } else {
        const message = prog?.error || `FFmpeg download did not start.`;
        const already = message.includes("already");
        setStatusMessage(ffmpegDlStatus, message, already ? "success" : "error");
        ffmpegDlBtn?.removeAttribute("disabled");
        if (!already) await refreshFfmpegStatus();
      }
    } catch (e: any) {
      setStatusMessage(ffmpegDlStatus, "Error: " + (e.message || e), "error");
      ffmpegDlBtn?.removeAttribute("disabled");
    }
  });
}
