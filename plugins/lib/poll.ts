/**
 * Async IPC progress polling for long-running Rust transcode/compile jobs.
 *
 * Both ffmpeg-transcoder (`pollProgress`) and gif-maker (`pollCompilationProgress`)
 * implemented near-identical `setTimeout`-recursive polling loops against the
 * `GetTranscodeProgress` IPC endpoint. They differed only in their callback
 * signatures and what they logged on each tick.
 *
 * This implementation decouples the polling mechanism from the UI by
 * accepting callbacks, letting each plugin render progress however it needs.
 *
 * Used by: ffmpeg-transcoder, gif-maker
 */

const PH = window.PluginHost;

/** Shape of the data returned per polling tick. */
export interface TranscodeProgress {
  /** Integer completion percentage 0–100. */
  percent: number;
  /** True while the job is still running on the backend. */
  running: boolean;
  /** Set if the job terminated with an error. */
  error?: string;
  /** Current encode frame rate (video jobs only). */
  fps?: number;
  /** Encode speed relative to real-time, e.g. 2.5 = 2.5× (video jobs only). */
  xSpeed?: number;
  /** Raw TranscodeProgressResult payload for plugin-specific fields. */
  raw: Record<string, unknown>;
}

export interface PollOptions {
  /** The job ID returned by the IPC command that started the job. */
  jobId: string;
  /**
   * Called on every tick while the job is running.
   * Use this to update progress bars, log speed info, etc.
   */
  onTick: (progress: TranscodeProgress) => void;
  /**
   * Called once when the job finishes (either success or failure).
   * `success` is true only if percent reached 100 and no error was reported.
   */
  onComplete: (success: boolean) => void;
  /** Polling interval in milliseconds. Defaults to 500ms. */
  intervalMs?: number;
}

/**
 * Begins polling `GetTranscodeProgress` for the given job ID.
 * Stops automatically when the backend reports `running: false`.
 *
 * @example
 * pollTranscodeProgress({
 *   jobId,
 *   onTick: ({ percent }) => updateProgressBar(percent),
 *   onComplete: (ok) => {
 *     if (ok) log("Done!", "success");
 *     else log("Job failed.", "error");
 *     setBusy(false);
 *   },
 * });
 */
export function pollTranscodeProgress({
  jobId,
  onTick,
  onComplete,
  intervalMs = 500,
}: PollOptions): void {
  const tick = async (): Promise<void> => {
    let resp: unknown;
    try {
      resp = await PH.callService("GetTranscodeProgress", { job_id: jobId });
    } catch {
      onComplete(false);
      return;
    }

    const raw = (resp as Record<string, unknown>)?.TranscodeProgressResult as
      | Record<string, unknown>
      | undefined;

    if (!raw) {
      onComplete(false);
      return;
    }

    const progress: TranscodeProgress = {
      percent: Math.round((raw.percent as number) || 0),
      running: !!(raw.running),
      error: raw.error as string | undefined,
      fps: raw.fps as number | undefined,
      xSpeed: raw.x_speed as number | undefined,
      raw,
    };

    onTick(progress);

    if (!progress.running) {
      onComplete(progress.percent >= 100 && !progress.error);
      return;
    }

    setTimeout(tick, intervalMs);
  };

  tick();
}
