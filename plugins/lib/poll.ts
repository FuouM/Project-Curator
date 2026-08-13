/**
 * Async IPC progress polling for long-running Rust jobs.
 *
 * The original `pollTranscodeProgress` was written for ffmpeg-transcoder and
 * gif-maker against the `GetTranscodeProgress` endpoint. The minipaint plugin
 * needs the exact same poll-loop shape against a different progress endpoint
 * (`GetPluginRuntimeInstallProgress`), so the mechanism is factored into the
 * generic `pollServiceProgress` core: it accepts a `fetch` function and an
 * `isRunning` predicate, and each plugin supplies the endpoint-specific bits.
 *
 * `pollTranscodeProgress` remains as a thin typed wrapper over the generic core
 * so its existing consumers keep working unchanged.
 */

const PH = window.PluginHost;

export interface PollServiceOptions<T> {
  /**
   * Fetch the current progress payload from the service.
   * Returning `undefined` (e.g. a transient IPC failure) is treated as a
   * non-terminal tick so the loop keeps retrying.
   */
  fetch: () => Promise<T | undefined>;
  /** True while the job is still running on the backend. */
  isRunning: (value: T) => boolean;
  /** Called on every successful tick. Use this to update progress bars, log lines, etc. */
  onTick: (value: T) => void;
  /**
   * Called once when the job finishes (either success or failure).
   * `success` is true only if the last tick was terminal *and* not running.
   * `lastValue` contains the final status.
   */
  onComplete: (success: boolean, lastValue?: T) => void;
  /** Polling interval in milliseconds. Defaults to 500ms. */
  intervalMs?: number;
}

/**
 * Poll a progress endpoint until the job reports not-running or the fetch
 * fails permanently. Generic over the payload shape so any plugin can reuse it.
 *
 * @example
 * pollServiceProgress({
 *   fetch: () => getProgress().catch(() => undefined),
 *   isRunning: (p) => p.status === "downloading" || p.status === "extracting",
 *   onTick: (p) => appendLogLines(logId, p.logs, renderedRef),
 *   onComplete: (ok) => log(ok ? "Done." : "Failed.", ok ? "success" : "error"),
 * });
 */
export function pollServiceProgress<T>({
  fetch,
  isRunning,
  onTick,
  onComplete,
  intervalMs = 500,
}: PollServiceOptions<T>): void {
  const tick = async (): Promise<void> => {
    let value: T | undefined;
    try {
      value = await fetch();
    } catch {
      onComplete(false);
      return;
    }

    if (value === undefined) {
      setTimeout(tick, intervalMs);
      return;
    }

    onTick(value);

    if (!isRunning(value)) {
      onComplete(true, value);
      return;
    }

    setTimeout(tick, intervalMs);
  };

  tick();
}

/** Shape of the data returned per polling tick by the transcode endpoint. */
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
   * `lastProgress` contains the final status, including backend-resolved output paths.
   */
  onComplete: (success: boolean, lastProgress?: TranscodeProgress) => void;
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
  pollServiceProgress<TranscodeProgress>({
    intervalMs,
    fetch: async (): Promise<TranscodeProgress | undefined> => {
      const resp = await PH.callService("GetTranscodeProgress", { job_id: jobId });
      const raw = (resp as Record<string, unknown> | undefined)?.TranscodeProgressResult as
        | Record<string, unknown>
        | undefined;
      if (!raw) return undefined;
      return {
        percent: Math.round((raw.percent as number) || 0),
        running: !!(raw.running),
        error: raw.error as string | undefined,
        fps: raw.fps as number | undefined,
        xSpeed: raw.x_speed as number | undefined,
        raw,
      };
    },
    isRunning: (p) => p.running,
    onTick,
    onComplete: (success, last) => onComplete(success, last),
  });
}
