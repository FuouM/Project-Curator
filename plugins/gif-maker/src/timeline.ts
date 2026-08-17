/**
 * Frame-pool timeline management for gif-maker.
 *
 * Owns the dropped-frames list rendering, the inline reorder/remove handlers
 * wired through `window.GifMaker_*` (called from compiled frame-list markup),
 * and the temporary output-path generator used by the FFmpeg export pipeline.
 */

import { state } from "./state";
import { PH, el } from "./ui-core";

// Global event registers for click handlers inside compiled frame-list HTML
(window as any).GifMaker_moveFrame = (idx: number, dir: number) => {
  const target = idx + dir;
  if (target < 0 || target >= state.droppedFrames.length) return;
  const temp = state.droppedFrames[idx];
  state.droppedFrames[idx] = state.droppedFrames[target];
  state.droppedFrames[target] = temp;
  renderDroppedFrames();
};

(window as any).GifMaker_removeFrame = (idx: number) => {
  state.droppedFrames.splice(idx, 1);
  renderDroppedFrames();
};

/** Renders the GIF Maker frame pool (reorder / remove controls). */
export function renderDroppedFrames(): void {
  const container = el("gm-maker-frame-list");
  if (!container) return;

  if (state.droppedFrames.length === 0) {
    container.innerHTML = `<div style="text-align:center; padding:12px; color:#808080;">No frames loaded. Drop files to begin.</div>`;
    return;
  }

  container.innerHTML = "";
  state.droppedFrames.forEach((path, idx) => {
    const card = document.createElement("div");
    card.className = "gm-frame-item";
    card.innerHTML = `
      <img class="gm-frame-img" src="${PH.convertFileSrc(path)}" />
      <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${path}">Frame ${
        idx + 1
      }: ${path.split(/[\\/]/).pop()}</span>
      <div style="display:flex; gap:2px;">
        <button type="button" class="win-button" style="padding:0px 4px; font-size:9px;" onclick="window.GifMaker_moveFrame(${idx}, -1)"><i class="bi bi-arrow-up"></i></button>
        <button type="button" class="win-button" style="padding:0px 4px; font-size:9px;" onclick="window.GifMaker_moveFrame(${idx}, 1)"><i class="bi bi-arrow-down"></i></button>
        <button type="button" class="win-button danger" style="padding:0px 4px; font-size:9px;" onclick="window.GifMaker_removeFrame(${idx})"><i class="bi bi-trash"></i></button>
      </div>
    `;
    container.appendChild(card);
  });
}

/** Builds a collision-free `.curator/temp_gif/` output path for the given extension. */
export async function getTempOutputPath(targetExt: string): Promise<string> {
  const rand = Math.floor(Math.random() * 1e7).toString(36);
  return `.curator\\temp_gif\\temp_gif_${rand}.${targetExt}`;
}
