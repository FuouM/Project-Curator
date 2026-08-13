/**
 * Shared module-level state for the image-converter plugin.
 *
 * All fields live on a single exported object so that mutations made in one
 * module are immediately visible to all others after bundling. Using a plain
 * object reference avoids the ES module live-binding subtlety that would
 * otherwise require setters for every mutable field.
 */

import { loadPersisted, savePersisted } from "../../lib";

export const TAB_ID = "image-converter" as const;

export const CONVERT_FORMATS = [
  "png", "jpg", "webp", "gif", "bmp", "tiff", "qoi",
  "tga", "pnm", "hdr", "ico", "exr", "avif",
] as const;

export interface ConverterState {
  /** Ordered list of source paths waiting to be converted. */
  queue: string[];
  /** Hash-set mirror of `queue` for O(1) duplicate detection. */
  inQueue: Record<string, boolean>;
  /** Absolute path where output files are written. */
  outputDir: string;
  /** Target image format extension (no leading dot). */
  targetExt: string;
  /** Lossy quality 1–100 (applies to JPG; ignored for lossless formats). */
  quality: number;
  /** True while a conversion batch is in flight — disables the run button. */
  busy: boolean;
}

export const state: ConverterState = {
  queue: [],
  inQueue: {},
  outputDir: loadPersisted("image-converter-output-dir", ""),
  targetExt: "png",
  quality: 90,
  busy: false,
};

export function setOutputDir(value: string): void {
  state.outputDir = value;
  savePersisted("image-converter-output-dir", value);
}
