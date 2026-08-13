/**
 * Shared state for the ffmpeg-transcoder plugin.
 */

import { loadPersisted, savePersisted } from "../../lib";

export const TAB_ID = "ffmpeg-transcoder" as const;
export const VIDEO_RE = /\.(mp4|webm)$/i;

export interface TranscoderState {
  queue: string[];
  inQueue: Record<string, boolean>;
  outputDir: string;
  targetFormat: string;
  vcodec: string;
  acodec: string;
  qualityMode: string;
  crf: number;
  bitrateKbps: number;
  preset: string;
  targetSizeMb: number;
  audioBitrateKbps: number;
  mixdown: string;
  sampleRate: number;
  mode: string;
  customArgs: string;
  busy: boolean;
  verbose: boolean;
}

export const state: TranscoderState = {
  queue: [],
  inQueue: {},
  outputDir: loadPersisted("ffmpeg-transcoder-output-dir", ""),
  targetFormat: "mp4",
  vcodec: "",
  acodec: "",
  qualityMode: "crf",
  crf: 23,
  bitrateKbps: 6000,
  preset: "",
  targetSizeMb: 25,
  audioBitrateKbps: 0,
  mixdown: "",
  sampleRate: 0,
  mode: loadPersisted("ffmpeg-transcoder-mode", "guided"),
  customArgs: loadPersisted("ffmpeg-transcoder-custom-args", ""),
  busy: false,
  verbose: loadPersisted("ffmpeg-transcoder-verbose", "false") === "true",
};

export function setVerbose(value: boolean): void {
  state.verbose = !!value;
  savePersisted("ffmpeg-transcoder-verbose", state.verbose ? "true" : "false");
}

export function setOutputDir(value: string): void {
  state.outputDir = value;
  savePersisted("ffmpeg-transcoder-output-dir", value);
}
