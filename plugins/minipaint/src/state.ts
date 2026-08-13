/**
 * Shared module-level state for the minipaint plugin.
 *
 * All fields live on a single exported object so that mutations made in one
 * module are immediately visible to all others after bundling. Using a plain
 * object reference avoids the ES module live-binding subtlety that would
 * otherwise require setters for every mutable field.
 */

export const TAB_ID = "minipaint" as const;

export interface MiniPaintState {
  /** Absolute path where edited exports are written. */
  outputDir: string;
  /** True while an install/export flow is in flight. */
  busy: boolean;
}

export const state: MiniPaintState = {
  outputDir: localStorage.getItem("minipaint-output-dir") || "",
  busy: false,
};

export function setOutputDir(value: string): void {
  state.outputDir = value;
  localStorage.setItem("minipaint-output-dir", value);
}
