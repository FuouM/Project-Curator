/**
 * Bottom log dock rendering for the aria2-downloader tab.
 *
 * Provides delta rendering (`appendLogDelta`) that appends only the newly
 * arrived console lines for a queue item, plus a full clear action.
 */

import { el } from "./ui-core";
import type { QueueItem } from "./state";

/** Append new log lines for `item` to the bottom dock. Returns the new index. */
export function appendLogDelta(item: QueueItem): void {
  const dock = el("ad-log");
  if (!dock || item.logIndex >= item.logs.length) return;
  const frag = document.createDocumentFragment();
  for (let i = item.logIndex; i < item.logs.length; i++) {
    const line = document.createElement("div");
    line.textContent = item.logs[i];
    frag.appendChild(line);
  }
  dock.appendChild(frag);
  dock.scrollTop = dock.scrollHeight;
  item.logIndex = item.logs.length;
}

export function clearLogDock(): void {
  const dock = el("ad-log");
  if (dock) dock.innerHTML = "";
}
