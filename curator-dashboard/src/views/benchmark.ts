import { typedCall } from "../ipc";
import { SafeHtml, html } from "../components";
import {
  RunBenchmarkRequestSchema,
  RunTaggerBenchmarkRequestSchema,
  BenchmarkResultSchema,
  DetectionBenchmarkResultSchema,
} from "../gen/benchmarks_pb";
import { EmbeddingModel, TaggerModel } from "../gen/common_pb";
import {
  GetBenchmarkImagesRequestSchema,
  BenchmarkImagesResultSchema,
  RunImageProcessingBenchmarkRequestSchema,
  ImageProcessingBenchmarkProgressSchema,
} from "../gen/tools_pb";
import { StatusResultSchema } from "../gen/system_pb";

interface BenchmarkConfig {
  key: string;
  label: string;
  cpuEl: HTMLElement | null;
  gpuEl: HTMLElement | null;
  speedupEl: HTMLElement | null;
  run: () => Promise<any>;
  extractResult: (
    resp: any,
  ) => { cpuMs: number; gpuMs: number | null; gpuErr: string | null } | null;
}

// Extract the benchmark numbers for one specific tagger (identified by its
// model key). Prefers the per-tagger `taggers` array returned by newer
// services, falling back to the legacy single-tagger fields.
function extractTaggerResult(
  resp: any,
  key: string,
  cpuId: string,
  gpuId: string,
  speedupId: string,
): { cpuMs: number; gpuMs: number | null; gpuErr: string | null } | null {
  const br = resp;
  let cpuMs: number | null = null;
  let gpuMs: number | null = null;
  let gpuErr: string | null = null;
  let found = false;

  const taggers = br.taggers;
  if (Array.isArray(taggers) && taggers.length > 0) {
    const t = taggers.find((x: any) => x.key === key);
    if (t) {
      cpuMs = t.cpuTimeMs ?? null;
      gpuMs = t.gpuTimeMs ?? null;
      gpuErr = t.gpuError ?? null;
      found = true;
    }
  }
  if (!found && key === "camie-tagger-v2") {
    cpuMs = br.taggerCpuTimeMs ?? null;
    gpuMs = br.taggerGpuTimeMs ?? null;
    gpuErr = br.taggerGpuError ?? null;
    found = true;
  }

  if (!found || cpuMs === null) {
    const cpuEl = document.getElementById(cpuId);
    const gpuEl = document.getElementById(gpuId);
    const speedupEl = document.getElementById(speedupId);
    if (cpuEl)
      cpuEl.textContent = gpuErr
        ? `Error: ${gpuErr}`
        : key === "camie-tagger-v2"
          ? "N/A (Model file not found)"
          : "N/A";
    if (gpuEl) gpuEl.textContent = "N/A";
    if (speedupEl) speedupEl.textContent = "—";
    return null;
  }
  return { cpuMs, gpuMs, gpuErr };
}

export function setupBenchmark() {
  const runBtn = document.getElementById("run-benchmark-btn");
  const gpuLoaded = document.getElementById("benchmark-gpu-loaded");
  const errText = document.getElementById("benchmark-error-msg");

  if (!runBtn) return;

  function getEl(id: string) {
    return document.getElementById(id);
  }

  function displayThroughput(
    cpuEl: HTMLElement | null,
    gpuEl: HTMLElement | null,
    speedupEl: HTMLElement | null,
    cpuMs: number,
    gpuMs: number | null,
    gpuErr: string | null,
  ) {
    if (cpuEl) {
      cpuEl.textContent = `${cpuMs.toFixed(2)} ms / image (${(1000 / cpuMs).toFixed(1)} items/sec)`;
    }
    if (gpuMs !== null) {
      if (gpuEl) {
        gpuEl.textContent = `${gpuMs.toFixed(2)} ms / image (${(1000 / gpuMs).toFixed(1)} items/sec)`;
      }
      if (speedupEl) {
        const factor = cpuMs / gpuMs;
        speedupEl.textContent = `${factor.toFixed(2)}x Speedup`;
        speedupEl.style.color = factor > 1 ? "#008000" : "#d00000";
        speedupEl.style.fontWeight = "bold";
      }
    } else {
      if (gpuEl) {
        gpuEl.textContent = gpuErr ? `Error: ${gpuErr}` : "N/A (Disabled or Failed)";
      }
      if (speedupEl) speedupEl.textContent = "—";
    }
  }

  const benchmarks: BenchmarkConfig[] = [
    {
      key: "clip",
      label: "CLIP ViT-B/32",
      cpuEl: getEl("benchmark-clip-cpu"),
      gpuEl: getEl("benchmark-clip-gpu"),
      speedupEl: getEl("benchmark-clip-speedup"),
      run: () =>
        typedCall(
          "BenchmarksService.RunBenchmark",
          RunBenchmarkRequestSchema,
          { embeddingModel: EmbeddingModel.CLIP_VIT_B_32, runTagger: false },
          BenchmarkResultSchema,
        ).catch((e: any) => ({
          Error: { message: typeof e === "string" ? e : e?.message || String(e) },
        })),
      extractResult: (resp) => {
        if (resp == null) return null;
        const { clipCpuTimeMs, clipGpuTimeMs, clipGpuError, hasGpu } = resp;
        if (gpuLoaded) {
          if (hasGpu) {
            gpuLoaded.textContent = "Yes";
            gpuLoaded.style.color = "#008000";
            gpuLoaded.style.fontWeight = "bold";
          } else {
            gpuLoaded.textContent = "No (CPU only build)";
            gpuLoaded.style.color = "#555555";
          }
        }
        return { cpuMs: clipCpuTimeMs, gpuMs: clipGpuTimeMs ?? null, gpuErr: clipGpuError ?? null };
      },
    },
    {
      key: "mclip",
      label: "MobileCLIP-S2",
      cpuEl: getEl("benchmark-mclip-cpu"),
      gpuEl: getEl("benchmark-mclip-gpu"),
      speedupEl: getEl("benchmark-mclip-speedup"),
      run: () =>
        typedCall(
          "BenchmarksService.RunBenchmark",
          RunBenchmarkRequestSchema,
          { embeddingModel: EmbeddingModel.MOBILECLIP_S2, runTagger: false },
          BenchmarkResultSchema,
        ).catch((e: any) => ({
          Error: { message: typeof e === "string" ? e : e?.message || String(e) },
        })),
      extractResult: (resp) => {
        if (resp == null) return null;
        const { clipCpuTimeMs, clipGpuTimeMs, clipGpuError } = resp;
        return { cpuMs: clipCpuTimeMs, gpuMs: clipGpuTimeMs ?? null, gpuErr: clipGpuError ?? null };
      },
    },
    {
      key: "tagger",
      label: "Camie Tagger",
      cpuEl: getEl("benchmark-tagger-cpu"),
      gpuEl: getEl("benchmark-tagger-gpu"),
      speedupEl: getEl("benchmark-tagger-speedup"),
      run: () =>
        typedCall(
          "BenchmarksService.RunTaggerBenchmark",
          RunTaggerBenchmarkRequestSchema,
          { tagger: TaggerModel.CAMIE },
          BenchmarkResultSchema,
        ).catch((e: any) => ({
          Error: { message: typeof e === "string" ? e : e?.message || String(e) },
        })),
      extractResult: (resp) =>
        extractTaggerResult(
          resp,
          "camie-tagger-v2",
          "benchmark-tagger-cpu",
          "benchmark-tagger-gpu",
          "benchmark-tagger-speedup",
        ),
    },
    {
      key: "tagger-wd",
      label: "WD EVA02 Tagger",
      cpuEl: getEl("benchmark-tagger-wd-cpu"),
      gpuEl: getEl("benchmark-tagger-wd-gpu"),
      speedupEl: getEl("benchmark-tagger-wd-speedup"),
      run: () =>
        typedCall(
          "BenchmarksService.RunTaggerBenchmark",
          RunTaggerBenchmarkRequestSchema,
          { tagger: TaggerModel.WD_EVA02 },
          BenchmarkResultSchema,
        ).catch((e: any) => ({
          Error: { message: typeof e === "string" ? e : e?.message || String(e) },
        })),
      extractResult: (resp) =>
        extractTaggerResult(
          resp,
          "wd-eva02-tagger-2026-canary",
          "benchmark-tagger-wd-cpu",
          "benchmark-tagger-wd-gpu",
          "benchmark-tagger-wd-speedup",
        ),
    },
    {
      key: "yolo",
      label: "YOLO Person Detection",
      cpuEl: getEl("benchmark-yolo-cpu"),
      gpuEl: getEl("benchmark-yolo-gpu"),
      speedupEl: getEl("benchmark-yolo-speedup"),
      run: () =>
        typedCall(
          "BenchmarksService.RunYoloBenchmark",
          null,
          null,
          DetectionBenchmarkResultSchema,
        ).catch((e: any) => ({
          Error: { message: typeof e === "string" ? e : e?.message || String(e) },
        })),
      extractResult: (resp) => {
        if (resp == null || resp.yoloCpuTimeMs == null) return null;
        return {
          cpuMs: resp.yoloCpuTimeMs,
          gpuMs: resp.yoloGpuTimeMs ?? null,
          gpuErr: resp.yoloGpuError ?? null,
        };
      },
    },
    {
      key: "safety",
      label: "NSFW Safety Classifier",
      cpuEl: getEl("benchmark-safety-cpu"),
      gpuEl: getEl("benchmark-safety-gpu"),
      speedupEl: getEl("benchmark-safety-speedup"),
      run: () =>
        typedCall(
          "BenchmarksService.RunSafetyBenchmark",
          null,
          null,
          DetectionBenchmarkResultSchema,
        ).catch((e: any) => ({
          Error: { message: typeof e === "string" ? e : e?.message || String(e) },
        })),
      extractResult: (resp) => {
        if (resp == null || resp.safetyCpuTimeMs == null) return null;
        return {
          cpuMs: resp.safetyCpuTimeMs,
          gpuMs: resp.safetyGpuTimeMs ?? null,
          gpuErr: resp.safetyGpuError ?? null,
        };
      },
    },
    {
      key: "ccip-feat",
      label: "CCIP Feature Extraction",
      cpuEl: getEl("benchmark-ccip-feat-cpu"),
      gpuEl: getEl("benchmark-ccip-feat-gpu"),
      speedupEl: getEl("benchmark-ccip-feat-speedup"),
      run: () =>
        typedCall(
          "BenchmarksService.RunCcipFeatBenchmark",
          null,
          null,
          DetectionBenchmarkResultSchema,
        ).catch((e: any) => ({
          Error: { message: typeof e === "string" ? e : e?.message || String(e) },
        })),
      extractResult: (resp) => {
        if (resp == null || resp.ccipFeatCpuTimeMs == null) return null;
        return {
          cpuMs: resp.ccipFeatCpuTimeMs,
          gpuMs: resp.ccipFeatGpuTimeMs ?? null,
          gpuErr: resp.ccipFeatGpuError ?? null,
        };
      },
    },
    {
      key: "ccip-metrics",
      label: "CCIP Metrics",
      cpuEl: getEl("benchmark-ccip-metrics-cpu"),
      gpuEl: getEl("benchmark-ccip-metrics-gpu"),
      speedupEl: getEl("benchmark-ccip-metrics-speedup"),
      run: () =>
        typedCall(
          "BenchmarksService.RunCcipMetricsBenchmark",
          null,
          null,
          DetectionBenchmarkResultSchema,
        ).catch((e: any) => ({
          Error: { message: typeof e === "string" ? e : e?.message || String(e) },
        })),
      extractResult: (resp) => {
        if (resp == null || resp.ccipMetricsCpuTimeMs == null) return null;
        return {
          cpuMs: resp.ccipMetricsCpuTimeMs,
          gpuMs: resp.ccipMetricsGpuTimeMs ?? null,
          gpuErr: resp.ccipMetricsGpuError ?? null,
        };
      },
    },
    {
      key: "ocr-det",
      label: "OCR Text Detection",
      cpuEl: getEl("benchmark-ocr-det-cpu"),
      gpuEl: getEl("benchmark-ocr-det-gpu"),
      speedupEl: getEl("benchmark-ocr-det-speedup"),
      run: () =>
        typedCall(
          "BenchmarksService.RunOcrDetBenchmark",
          null,
          null,
          DetectionBenchmarkResultSchema,
        ).catch((e: any) => ({
          Error: { message: typeof e === "string" ? e : e?.message || String(e) },
        })),
      extractResult: (resp) => {
        if (resp == null || resp.ocrDetCpuTimeMs == null) return null;
        return {
          cpuMs: resp.ocrDetCpuTimeMs,
          gpuMs: resp.ocrDetGpuTimeMs ?? null,
          gpuErr: resp.ocrDetGpuError ?? null,
        };
      },
    },
    {
      key: "ocr-rec",
      label: "OCR Text Recognition",
      cpuEl: getEl("benchmark-ocr-rec-cpu"),
      gpuEl: getEl("benchmark-ocr-rec-gpu"),
      speedupEl: getEl("benchmark-ocr-rec-speedup"),
      run: () =>
        typedCall(
          "BenchmarksService.RunOcrRecBenchmark",
          null,
          null,
          DetectionBenchmarkResultSchema,
        ).catch((e: any) => ({
          Error: { message: typeof e === "string" ? e : e?.message || String(e) },
        })),
      extractResult: (resp) => {
        if (resp == null || resp.ocrRecCpuTimeMs == null) return null;
        return {
          cpuMs: resp.ocrRecCpuTimeMs,
          gpuMs: resp.ocrRecGpuTimeMs ?? null,
          gpuErr: resp.ocrRecGpuError ?? null,
        };
      },
    },
    {
      key: "ocr-cls",
      label: "OCR Text Line Classification",
      cpuEl: getEl("benchmark-ocr-cls-cpu"),
      gpuEl: getEl("benchmark-ocr-cls-gpu"),
      speedupEl: getEl("benchmark-ocr-cls-speedup"),
      run: () =>
        typedCall(
          "BenchmarksService.RunOcrClsBenchmark",
          null,
          null,
          DetectionBenchmarkResultSchema,
        ).catch((e: any) => ({
          Error: { message: typeof e === "string" ? e : e?.message || String(e) },
        })),
      extractResult: (resp) => {
        if (resp == null || resp.ocrClsCpuTimeMs == null) return null;
        return {
          cpuMs: resp.ocrClsCpuTimeMs,
          gpuMs: resp.ocrClsGpuTimeMs ?? null,
          gpuErr: resp.ocrClsGpuError ?? null,
        };
      },
    },
    {
      key: "manga-bubble",
      label: "Manga Bubble YOLO",
      cpuEl: getEl("benchmark-manga-bubble-cpu"),
      gpuEl: getEl("benchmark-manga-bubble-gpu"),
      speedupEl: getEl("benchmark-manga-bubble-speedup"),
      run: () =>
        typedCall(
          "BenchmarksService.RunMangaBubbleBenchmark",
          null,
          null,
          DetectionBenchmarkResultSchema,
        ).catch((e: any) => ({
          Error: { message: typeof e === "string" ? e : e?.message || String(e) },
        })),
      extractResult: (resp) => {
        if (resp == null || resp.mangaBubbleCpuTimeMs == null) return null;
        return {
          cpuMs: resp.mangaBubbleCpuTimeMs,
          gpuMs: resp.mangaBubbleGpuTimeMs ?? null,
          gpuErr: resp.mangaBubbleGpuError ?? null,
        };
      },
    },
  ];

  function initBenchmarkUI() {
    benchmarks.forEach((b, i) => {
      markCard(b, "ok");
      if (b.cpuEl) b.cpuEl.textContent = i === 0 ? "Running..." : "Queued...";
      if (b.gpuEl) b.gpuEl.textContent = i === 0 ? "Running..." : "Queued...";
      if (b.speedupEl) b.speedupEl.textContent = i === 0 ? "Calculating..." : "Waiting...";
    });
    if (gpuLoaded) gpuLoaded.textContent = "...";
    if (errText) errText.textContent = "";
  }

  function appendBenchError(msg: string) {
    if (!errText) return;
    const existing = errText.textContent || "";
    errText.textContent = existing ? `${existing}\n${msg}` : msg;
  }

  let runningTick: ReturnType<typeof setInterval> | null = null;

  function setRunningText(bench: BenchmarkConfig, text: string) {
    if (bench.cpuEl) bench.cpuEl.textContent = text;
    if (bench.gpuEl) bench.gpuEl.textContent = text;
    if (bench.speedupEl) bench.speedupEl.textContent = text;
  }

  // Cycles a braille spinner after "Running " on the active card. Braille
  // glyphs are single-width, so the status text never shifts horizontally.
  function startRunningAnimation(bench: BenchmarkConfig) {
    const braille = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let idx = 0;
    setRunningText(bench, `Running ${braille[0]}`);
    stopRunningAnimation();
    runningTick = setInterval(() => {
      idx = (idx + 1) % braille.length;
      setRunningText(bench, `Running ${braille[idx]}`);
    }, 120);
  }

  function stopRunningAnimation() {
    if (runningTick !== null) {
      clearInterval(runningTick);
      runningTick = null;
    }
  }

  function markCard(bench: BenchmarkConfig, state: "ok" | "error") {
    const btn = document.querySelector<HTMLButtonElement>(`[data-benchmark-key="${bench.key}"]`);
    const card = btn?.closest(".group-box") as HTMLElement | null;
    if (!card) return;
    if (state === "error") {
      card.style.border = "2px solid #d00000";
      card.style.backgroundColor = "#fdecea";
    } else {
      card.style.border = "";
      card.style.backgroundColor = "";
    }
  }

  async function runSingleBenchmark(bench: BenchmarkConfig) {
    startRunningAnimation(bench);
    try {
      const resp = await bench.run();
      if ("Error" in resp) {
        markCard(bench, "error");
        const msg = typeof resp.Error?.message === "string" ? resp.Error.message : "Unknown error";
        appendBenchError(`${bench.label}: ${msg}`);
        if (bench.cpuEl) bench.cpuEl.textContent = "Failed";
        if (bench.gpuEl) bench.gpuEl.textContent = "";
        if (bench.speedupEl) bench.speedupEl.textContent = "—";
        return;
      }
      const result = bench.extractResult(resp);
      if (result) {
        markCard(bench, "ok");
        displayThroughput(
          bench.cpuEl,
          bench.gpuEl,
          bench.speedupEl,
          result.cpuMs,
          result.gpuMs,
          result.gpuErr,
        );
      } else {
        markCard(bench, "error");
        if (bench.cpuEl) bench.cpuEl.textContent = "N/A";
        if (bench.gpuEl) bench.gpuEl.textContent = "N/A";
        if (bench.speedupEl) bench.speedupEl.textContent = "—";
      }
    } finally {
      stopRunningAnimation();
    }
  }

  const allRunButtons = document.querySelectorAll<HTMLButtonElement>("[data-benchmark-key]");
  function setAllRunButtonsDisabled(disabled: boolean) {
    allRunButtons.forEach((b) => {
      b.disabled = disabled;
    });
  }

  // Per-card "Run" buttons for single benchmarks
  allRunButtons.forEach((btn) => {
    const key = btn.dataset.benchmarkKey;
    const bench = benchmarks.find((b) => b.key === key);
    if (!bench) return;
    btn.addEventListener("click", async () => {
      if (errText) errText.textContent = "";
      try {
        await runSingleBenchmark(bench);
      } catch (e: any) {
        appendBenchError(`${bench.label}: ${e.message || e}`);
      }
    });
  });

  runBtn.addEventListener("click", async () => {
    runBtn.setAttribute("disabled", "true");
    runBtn.textContent = "Benchmarking...";
    initBenchmarkUI();
    setAllRunButtonsDisabled(true);

    try {
      const total = benchmarks.length;
      for (let i = 0; i < total; i++) {
        runBtn.textContent = `Benchmarking ${i + 1}/${total}: ${benchmarks[i].label}...`;
        await runSingleBenchmark(benchmarks[i]);
      }
    } catch (e: any) {
      appendBenchError(`Execution error: ${e.message || e}`);
    } finally {
      stopRunningAnimation();
      runBtn.removeAttribute("disabled");
      runBtn.innerHTML = '<i class="bi bi-play-fill"></i> Run Benchmark';
      setAllRunButtonsDisabled(false);
    }
  });

  const runPipelineBtn = document.getElementById("run-image-proc-benchmark-btn");
  const pipelineCountEl = getEl("benchmark-pipeline-count");
  const pipelineReadEl = getEl("benchmark-pipeline-read");
  const pipelineDecodeEl = getEl("benchmark-pipeline-decode");
  const pipelineThumbEl = getEl("benchmark-pipeline-thumbnail");
  const pipelineClipPrepEl = getEl("benchmark-pipeline-clip-prep");
  const pipelineTaggerPrepEl = getEl("benchmark-pipeline-tagger-prep");
  const pipelineYoloPrepEl = getEl("benchmark-pipeline-yolo-prep");
  const pipelineCcipPrepEl = getEl("benchmark-pipeline-ccip-prep");
  const pipelineTotalEl = getEl("benchmark-pipeline-total");
  const pipelineErrText = getEl("benchmark-pipeline-error-msg");

  if (runPipelineBtn) {
    runPipelineBtn.addEventListener("click", async () => {
      runPipelineBtn.setAttribute("disabled", "true");
      runPipelineBtn.textContent = "Benchmarking...";
      if (pipelineErrText) pipelineErrText.textContent = "";

      [
        pipelineCountEl,
        pipelineReadEl,
        pipelineDecodeEl,
        pipelineThumbEl,
        pipelineClipPrepEl,
        pipelineTaggerPrepEl,
        pipelineYoloPrepEl,
        pipelineCcipPrepEl,
        pipelineTotalEl,
      ].forEach((el) => {
        if (el) el.textContent = "...";
      });

      try {
        const inputN = document.getElementById("benchmark-pipeline-n") as HTMLInputElement | null;
        const requestedN = inputN ? parseInt(inputN.value, 10) : 100;
        const finalN = isNaN(requestedN) || requestedN <= 0 ? 100 : requestedN;

        const listResp = await typedCall(
          "ToolsService.GetBenchmarkImages",
          GetBenchmarkImagesRequestSchema,
          { limit: finalN },
          BenchmarkImagesResultSchema,
        );
        const filepaths = listResp.filepaths;
        const totalCount = filepaths.length;
        if (totalCount === 0) {
          throw new Error("No benchmark images found in the database.");
        }

        // Kick off the background benchmark across all fetched images at once,
        // then poll per-image progress until it finishes. The streaming RPC
        // resolves with the first progress item; the unary poll below drives
        // the rest of the run.
        await typedCall(
          "ToolsService.RunImageProcessingBenchmark",
          RunImageProcessingBenchmarkRequestSchema,
          { filepaths },
          ImageProcessingBenchmarkProgressSchema,
        );

        let running = true;
        let currentProcessed = 0;

        const applyProgress = (res: {
          processed: number;
          readTimeMs: number;
          decodeTimeMs: number;
          thumbnailTimeMs: number;
          clipPreprocessTimeMs: number;
          taggerPreprocessTimeMs: number;
          yoloPreprocessTimeMs: number;
          ccipExtractPreprocessTimeMs: number;
        }) => {
          currentProcessed = res.processed || 0;
          if (pipelineCountEl) pipelineCountEl.textContent = `${currentProcessed} / ${totalCount}`;

          const formatMs = (sumMs: number) => {
            const avg = currentProcessed > 0 ? sumMs / currentProcessed : 0;
            return `${sumMs.toFixed(1)} ms (avg ${avg.toFixed(1)} ms/img)`;
          };

          if (pipelineReadEl) pipelineReadEl.textContent = formatMs(res.readTimeMs);
          if (pipelineDecodeEl) pipelineDecodeEl.textContent = formatMs(res.decodeTimeMs);
          if (pipelineThumbEl) pipelineThumbEl.textContent = formatMs(res.thumbnailTimeMs);
          if (pipelineClipPrepEl)
            pipelineClipPrepEl.textContent = formatMs(res.clipPreprocessTimeMs);
          if (pipelineTaggerPrepEl)
            pipelineTaggerPrepEl.textContent = formatMs(res.taggerPreprocessTimeMs);
          if (pipelineYoloPrepEl)
            pipelineYoloPrepEl.textContent = formatMs(res.yoloPreprocessTimeMs);
          if (pipelineCcipPrepEl)
            pipelineCcipPrepEl.textContent = formatMs(res.ccipExtractPreprocessTimeMs);

          // Total = sum of the actual per-step measurements (same source and
          // denominator as the rows above), so it stays consistent rather than
          // reflecting wall-clock/polling overhead.
          const sumTotal =
            res.readTimeMs +
            res.decodeTimeMs +
            res.thumbnailTimeMs +
            res.clipPreprocessTimeMs +
            res.taggerPreprocessTimeMs +
            res.yoloPreprocessTimeMs +
            res.ccipExtractPreprocessTimeMs;
          if (pipelineTotalEl) pipelineTotalEl.textContent = formatMs(sumTotal);
        };

        while (running) {
          const prog = await typedCall(
            "ToolsService.GetImageProcessingBenchmarkProgress",
            null,
            null,
            ImageProcessingBenchmarkProgressSchema,
          );
          running = prog.running;
          applyProgress(prog);
          if (running) {
            runPipelineBtn.textContent = `Benchmarking (${prog.processed}/${totalCount})...`;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
        runPipelineBtn.textContent = `Benchmarking (${totalCount}/${totalCount})...`;
      } catch (e: unknown) {
        const errMsg = e instanceof Error ? e.message : String(e);
        if (pipelineErrText) pipelineErrText.textContent = `Execution error: ${errMsg}`;
        [
          pipelineCountEl,
          pipelineReadEl,
          pipelineDecodeEl,
          pipelineThumbEl,
          pipelineClipPrepEl,
          pipelineTaggerPrepEl,
          pipelineYoloPrepEl,
          pipelineCcipPrepEl,
          pipelineTotalEl,
        ].forEach((el) => {
          if (el) el.textContent = "—";
        });
      } finally {
        runPipelineBtn.removeAttribute("disabled");
        runPipelineBtn.innerHTML = '<i class="bi bi-play-fill"></i> Run Pipeline Benchmark';
      }
    });
    // Load initial maximum images hint on startup
    refreshBenchmarkMaxImages();
  }
}

export async function refreshBenchmarkMaxImages() {
  try {
    const statusResp = await typedCall("SystemService.GetStatus", null, null, StatusResultSchema);
    const maxImages = Number(statusResp.imageCount);
    const inputN = document.getElementById("benchmark-pipeline-n") as HTMLInputElement | null;
    const maxHint = document.getElementById("benchmark-pipeline-max-hint");
    if (inputN) {
      inputN.max = maxImages.toString();
      const currVal = parseInt(inputN.value, 10);
      if (isNaN(currVal) || currVal > maxImages || currVal === 100) {
        inputN.value = Math.min(100, maxImages).toString();
      }
    }
    if (maxHint) {
      maxHint.textContent = `(max ${maxImages})`;
    }
  } catch (e) {
    console.error("Failed to load max images for benchmark", e);
  }
}

export function updateBenchmarkModelHeader(_model: string | null) {}

// ---------------------------------------------------------------------------
// HTML Template
// ---------------------------------------------------------------------------

interface BenchmarkCardDef {
  key: string;
  label: string;
  size: string;
}

const BENCHMARK_CARDS: BenchmarkCardDef[] = [
  { key: "clip", label: "CLIP ViT-B/32", size: "224x224" },
  { key: "mclip", label: "MobileCLIP-S2", size: "256x256" },
  { key: "tagger", label: "Camie Tagger v2", size: "512x512" },
  { key: "tagger-wd", label: "WD EVA02 Tagger", size: "448x448" },
  { key: "yolo", label: "YOLO Person Detection", size: "640x640" },
  { key: "safety", label: "NSFW Safety Classifier", size: "380x380" },
  { key: "ccip-feat", label: "CCIP Feature Extraction", size: "384x384" },
  { key: "ccip-metrics", label: "CCIP Metrics", size: "16x768" },
  { key: "ocr-det", label: "OCR Text Detection", size: "960x960" },
  { key: "ocr-rec", label: "OCR Text Recognition", size: "48x320" },
  { key: "ocr-cls", label: "OCR Line Classification", size: "80x160" },
  { key: "manga-bubble", label: "Manga Bubble YOLO", size: "1280x1280" },
];

function benchmarkCardHtml(card: BenchmarkCardDef): SafeHtml {
  return html`
    <div class="group-box" style="padding: 10px; margin: 0;">
      <button
        class="win-button"
        data-benchmark-key="${card.key}"
        title="Run ${card.label} benchmark"
        style="position: absolute; top: -9px; right: 4px; height: 18px; padding: 0 7px; font-size: 11px; border-radius: 4px; display: flex; align-items: center; justify-content: center;"
      >
        <i class="bi bi-play-fill" style="font-size: 12px;"></i>
      </button>
      <div class="group-box-title">
        ${card.label}
        <span style="font-weight: normal; font-size: 10px; color: #666;">(${card.size})</span>
      </div>
      <div style="display: flex; flex-direction: column; gap: 6px; font-size: 11px;">
        <div
          style="display: flex; justify-content: space-between; align-items: baseline; gap: 8px;"
        >
          <span>CPU Throughput</span>
          <span id="benchmark-${card.key}-cpu" style="text-align: right;">—</span>
        </div>
        <div
          style="display: flex; justify-content: space-between; align-items: baseline; gap: 8px;"
        >
          <span>GPU Throughput</span>
          <span id="benchmark-${card.key}-gpu" style="text-align: right;">—</span>
        </div>
        <div
          style="display: flex; justify-content: space-between; align-items: baseline; gap: 8px; border-top: 1px solid #eee; padding-top: 4px;"
        >
          <span>Throughput Factor</span>
          <span id="benchmark-${card.key}-speedup" style="text-align: right; font-weight: bold;"
            >—</span
          >
        </div>
      </div>
    </div>
  `;
}

export function renderBenchmarkHtml(): SafeHtml {
  return html`
    <div class="group-box" style="display: flex; flex-direction: column; gap: 16px;">
      <div class="group-box-title">Hardware Throughput Benchmark</div>
      <p style="font-size: 11px; color: #333333; margin-bottom: 8px;">
        Measure inference latency on CPU vs GPU. Runs all available models (CLIP, Tagger, YOLO,
        CCIP) and reports average speed and throughput factor.
      </p>
      <div style="display: flex; gap: 16px; align-items: center;">
        <button class="win-button" id="run-benchmark-btn">
          <i class="bi bi-play-fill"></i> Run Benchmark
        </button>
      </div>

      <div class="group-box" style="padding: 12px; margin-top: 10px; background-color: #f6f6f6;">
        <div class="group-box-title">Results</div>
        <div
          style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px dashed #ccc; padding-bottom: 6px; margin-bottom: 10px;"
        >
          <span style="font-weight: bold; font-size: 11px;">GPU Provider Support:</span>
          <span id="benchmark-gpu-loaded" style="font-size: 11px;">—</span>
        </div>
        <div
          style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px;"
        >
          ${BENCHMARK_CARDS.map(benchmarkCardHtml).join("")}
        </div>
      </div>
      <p style="font-size: 11px; color: red;" id="benchmark-error-msg"></p>
    </div>

    <div
      class="group-box"
      style="display: flex; flex-direction: column; gap: 16px; margin-top: 16px;"
    >
      <div class="group-box-title">Image Processing &amp; Preprocessing Benchmark (N = 100)</div>
      <p style="font-size: 11px; color: #333333; margin-bottom: 8px;">
        Runs CPU image processing and input preprocessing stages (Disk I/O read, RGB decoding,
        thumbnailing, CLIP tensor prep, Tagger fast-image-resize tensor prep, YOLO letterbox tensor
        prep, and CCIP tensor prep) on up to 100 database images.
      </p>
      <div style="display: flex; gap: 16px; align-items: center; flex-wrap: wrap;">
        <div style="display: flex; align-items: center; gap: 8px; font-size: 11px;">
          <label for="benchmark-pipeline-n">Number of images (N):</label>
          <input
            type="number"
            id="benchmark-pipeline-n"
            class="win-input"
            value="100"
            min="1"
            style="width: 80px;"
          />
          <span id="benchmark-pipeline-max-hint" style="color: #666;">(max ...)</span>
        </div>
        <button class="win-button" id="run-image-proc-benchmark-btn">
          <i class="bi bi-play-fill"></i> Run Pipeline Benchmark
        </button>
      </div>

      <div class="group-box" style="padding: 12px; margin-top: 10px; background-color: #f6f6f6;">
        <div class="group-box-title">Pipeline Results</div>
        <div style="display: flex; flex-direction: column; gap: 12px; font-size: 11px;">
          <div
            style="display: flex; justify-content: space-between; border-bottom: 1px dashed #ccc; padding-bottom: 4px;"
          >
            <span style="font-weight: bold;">Images Processed:</span>
            <span id="benchmark-pipeline-count">—</span>
          </div>
          <div style="margin-top: 4px;">
            <div
              style="display: flex; justify-content: space-between; border-bottom: 1px dashed #eee; padding-bottom: 2px;"
            >
              <span>Disk I/O Read:</span><span id="benchmark-pipeline-read">—</span>
            </div>
            <div
              style="display: flex; justify-content: space-between; border-bottom: 1px dashed #eee; padding-bottom: 2px;"
            >
              <span>Image Decode:</span><span id="benchmark-pipeline-decode">—</span>
            </div>
            <div
              style="display: flex; justify-content: space-between; border-bottom: 1px dashed #eee; padding-bottom: 2px;"
            >
              <span>Thumbnail Generation:</span><span id="benchmark-pipeline-thumbnail">—</span>
            </div>
            <div
              style="display: flex; justify-content: space-between; border-bottom: 1px dashed #eee; padding-bottom: 2px;"
            >
              <span>CLIP Preprocessing:</span><span id="benchmark-pipeline-clip-prep">—</span>
            </div>
            <div
              style="display: flex; justify-content: space-between; border-bottom: 1px dashed #eee; padding-bottom: 2px;"
            >
              <span>Camie Tagger Preprocessing:</span
              ><span id="benchmark-pipeline-tagger-prep">—</span>
            </div>
            <div
              style="display: flex; justify-content: space-between; border-bottom: 1px dashed #eee; padding-bottom: 2px;"
            >
              <span>YOLO Preprocessing:</span><span id="benchmark-pipeline-yolo-prep">—</span>
            </div>
            <div
              style="display: flex; justify-content: space-between; border-bottom: 1px dashed #eee; padding-bottom: 2px;"
            >
              <span>CCIP Preprocessing:</span><span id="benchmark-pipeline-ccip-prep">—</span>
            </div>
            <div
              style="display: flex; justify-content: space-between; padding-top: 4px; border-top: 1px solid #777; font-weight: bold;"
            >
              <span>Total Pipeline Time:</span><span id="benchmark-pipeline-total">—</span>
            </div>
          </div>
        </div>
      </div>
      <p style="font-size: 11px; color: red;" id="benchmark-pipeline-error-msg"></p>
    </div>
  `;
}
