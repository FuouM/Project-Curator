/**
 * Shared state for the ffmpeg-transcoder plugin.
 */

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
  outputDir: localStorage.getItem("ffmpeg-transcoder-output-dir") || "",
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
  mode: localStorage.getItem("ffmpeg-transcoder-mode") || "guided",
  customArgs: localStorage.getItem("ffmpeg-transcoder-custom-args") || "",
  busy: false,
  verbose: localStorage.getItem("ffmpeg-transcoder-verbose") === "true",
};

export function setVerbose(value: boolean): void {
  state.verbose = !!value;
  localStorage.setItem("ffmpeg-transcoder-verbose", state.verbose ? "true" : "false");
}

export function setOutputDir(value: string): void {
  state.outputDir = value;
  localStorage.setItem("ffmpeg-transcoder-output-dir", value);
}
