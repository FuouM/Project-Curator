import { callService } from "../ipc";
import { SafeHtml, html } from "../components";

interface BenchmarkConfig {
  key: string;
  label: string;
  cpuEl: HTMLElement | null;
  gpuEl: HTMLElement | null;
  speedupEl: HTMLElement | null;
  run: () => Promise<any>;
  extractResult: (resp: any) => { cpuMs: number; gpuMs: number | null; gpuErr: string | null } | null;
}

// Extract the benchmark numbers for one specific tagger (identified by its
// model key). Prefers the per-tagger `taggers` array returned by newer
// services, falling back to the legacy single-tagger fields.
function extractTaggerResult(
  resp: any,
  key: string,
  cpuId: string,
  gpuId: string,
  speedupId: string
): { cpuMs: number; gpuMs: number | null; gpuErr: string | null } | null {
  if (!("BenchmarkResult" in resp)) return null;
  const br = resp.BenchmarkResult;
  let cpuMs: number | null = null;
  let gpuMs: number | null = null;
  let gpuErr: string | null = null;
  let found = false;

  const taggers = br.taggers;
  if (Array.isArray(taggers) && taggers.length > 0) {
    const t = taggers.find((x: any) => x.key === key);
    if (t) {
      cpuMs = t.cpu_time_ms ?? null;
      gpuMs = t.gpu_time_ms ?? null;
      gpuErr = t.gpu_error ?? null;
      found = true;
    }
  }
  if (!found && key === "camie-tagger-v2") {
    cpuMs = br.tagger_cpu_time_ms ?? null;
    gpuMs = br.tagger_gpu_time_ms ?? null;
    gpuErr = br.tagger_gpu_error ?? null;
    found = true;
  }

  if (!found || cpuMs === null) {
    const cpuEl = document.getElementById(cpuId);
    const gpuEl = document.getElementById(gpuId);
    const speedupEl = document.getElementById(speedupId);
    if (cpuEl) cpuEl.textContent = gpuErr ? `Error: ${gpuErr}` : key === "camie-tagger-v2" ? "N/A (Model file not found)" : "N/A";
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

  function displayThroughput(cpuEl: HTMLElement | null, gpuEl: HTMLElement | null, speedupEl: HTMLElement | null, cpuMs: number, gpuMs: number | null, gpuErr: string | null) {
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
      run: () => callService({ RunBenchmark: { embedding_model: "clip-vit-b-32", run_tagger: false } }).catch((e: any) => ({ Error: { message: e.message } })),
      extractResult: (resp) => {
        if (!("BenchmarkResult" in resp)) return null;
        const { clip_cpu_time_ms, clip_gpu_time_ms, clip_gpu_error, has_gpu } = resp.BenchmarkResult;
        if (gpuLoaded) {
          if (has_gpu) {
            gpuLoaded.textContent = "Yes";
            gpuLoaded.style.color = "#008000";
            gpuLoaded.style.fontWeight = "bold";
          } else {
            gpuLoaded.textContent = "No (CPU only build)";
            gpuLoaded.style.color = "#555555";
          }
        }
        return { cpuMs: clip_cpu_time_ms, gpuMs: clip_gpu_time_ms, gpuErr: clip_gpu_error };
      },
    },
    {
      key: "mclip",
      label: "MobileCLIP-S2",
      cpuEl: getEl("benchmark-mclip-cpu"),
      gpuEl: getEl("benchmark-mclip-gpu"),
      speedupEl: getEl("benchmark-mclip-speedup"),
      run: () => callService({ RunBenchmark: { embedding_model: "mobileclip-s2", run_tagger: false } }).catch((e: any) => ({ Error: { message: e.message } })),
      extractResult: (resp) => {
        if (!("BenchmarkResult" in resp)) return null;
        const { clip_cpu_time_ms, clip_gpu_time_ms, clip_gpu_error } = resp.BenchmarkResult;
        return { cpuMs: clip_cpu_time_ms, gpuMs: clip_gpu_time_ms, gpuErr: clip_gpu_error };
      },
    },
    {
      key: "tagger",
      label: "Camie Tagger",
      cpuEl: getEl("benchmark-tagger-cpu"),
      gpuEl: getEl("benchmark-tagger-gpu"),
      speedupEl: getEl("benchmark-tagger-speedup"),
      run: () => callService({ RunTaggerBenchmark: { tagger: "camie" } }).catch((e: any) => ({ Error: { message: e.message } })),
      extractResult: (resp) => extractTaggerResult(resp, "camie-tagger-v2", "benchmark-tagger-cpu", "benchmark-tagger-gpu", "benchmark-tagger-speedup"),
    },
    {
      key: "tagger-wd",
      label: "WD EVA02 Tagger",
      cpuEl: getEl("benchmark-tagger-wd-cpu"),
      gpuEl: getEl("benchmark-tagger-wd-gpu"),
      speedupEl: getEl("benchmark-tagger-wd-speedup"),
      run: () => callService({ RunTaggerBenchmark: { tagger: "wd-eva02" } }).catch((e: any) => ({ Error: { message: e.message } })),
      extractResult: (resp) => extractTaggerResult(resp, "wd-eva02-tagger-2026-canary", "benchmark-tagger-wd-cpu", "benchmark-tagger-wd-gpu", "benchmark-tagger-wd-speedup"),
    },
    {
      key: "yolo",
      label: "YOLO Person Detection",
      cpuEl: getEl("benchmark-yolo-cpu"),
      gpuEl: getEl("benchmark-yolo-gpu"),
      speedupEl: getEl("benchmark-yolo-speedup"),
      run: () => callService({ RunYoloBenchmark: null }).catch((e: any) => ({ Error: { message: e.message } })),
      extractResult: (resp) => {
        if (!("DetectionBenchmarkResult" in resp)) return null;
        const { yolo_cpu_time_ms, yolo_gpu_time_ms, yolo_gpu_error } = resp.DetectionBenchmarkResult;
        if (yolo_cpu_time_ms === null) return null;
        return { cpuMs: yolo_cpu_time_ms, gpuMs: yolo_gpu_time_ms, gpuErr: yolo_gpu_error };
      },
    },
    {
      key: "ccip-feat",
      label: "CCIP Feature Extraction",
      cpuEl: getEl("benchmark-ccip-feat-cpu"),
      gpuEl: getEl("benchmark-ccip-feat-gpu"),
      speedupEl: getEl("benchmark-ccip-feat-speedup"),
      run: () => callService({ RunCcipFeatBenchmark: null }).catch((e: any) => ({ Error: { message: e.message } })),
      extractResult: (resp) => {
        if (!("DetectionBenchmarkResult" in resp)) return null;
        const { ccip_feat_cpu_time_ms, ccip_feat_gpu_time_ms, ccip_feat_gpu_error } = resp.DetectionBenchmarkResult;
        if (ccip_feat_cpu_time_ms === null) return null;
        return { cpuMs: ccip_feat_cpu_time_ms, gpuMs: ccip_feat_gpu_time_ms, gpuErr: ccip_feat_gpu_error };
      },
    },
    {
      key: "ccip-metrics",
      label: "CCIP Metrics",
      cpuEl: getEl("benchmark-ccip-metrics-cpu"),
      gpuEl: getEl("benchmark-ccip-metrics-gpu"),
      speedupEl: getEl("benchmark-ccip-metrics-speedup"),
      run: () => callService({ RunCcipMetricsBenchmark: null }).catch((e: any) => ({ Error: { message: e.message } })),
      extractResult: (resp) => {
        if (!("DetectionBenchmarkResult" in resp)) return null;
        const { ccip_metrics_cpu_time_ms, ccip_metrics_gpu_time_ms, ccip_metrics_gpu_error } = resp.DetectionBenchmarkResult;
        if (ccip_metrics_cpu_time_ms === null) return null;
        return { cpuMs: ccip_metrics_cpu_time_ms, gpuMs: ccip_metrics_gpu_time_ms, gpuErr: ccip_metrics_gpu_error };
      },
    },
    {
      key: "ocr-det",
      label: "OCR Text Detection",
      cpuEl: getEl("benchmark-ocr-det-cpu"),
      gpuEl: getEl("benchmark-ocr-det-gpu"),
      speedupEl: getEl("benchmark-ocr-det-speedup"),
      run: () => callService({ RunOcrDetBenchmark: null }).catch((e: any) => ({ Error: { message: e.message } })),
      extractResult: (resp) => {
        if (!("DetectionBenchmarkResult" in resp)) return null;
        const { ocr_det_cpu_time_ms, ocr_det_gpu_time_ms, ocr_det_gpu_error } = resp.DetectionBenchmarkResult;
        if (ocr_det_cpu_time_ms === null) return null;
        return { cpuMs: ocr_det_cpu_time_ms, gpuMs: ocr_det_gpu_time_ms, gpuErr: ocr_det_gpu_error };
      },
    },
    {
      key: "ocr-rec",
      label: "OCR Text Recognition",
      cpuEl: getEl("benchmark-ocr-rec-cpu"),
      gpuEl: getEl("benchmark-ocr-rec-gpu"),
      speedupEl: getEl("benchmark-ocr-rec-speedup"),
      run: () => callService({ RunOcrRecBenchmark: null }).catch((e: any) => ({ Error: { message: e.message } })),
      extractResult: (resp) => {
        if (!("DetectionBenchmarkResult" in resp)) return null;
        const { ocr_rec_cpu_time_ms, ocr_rec_gpu_time_ms, ocr_rec_gpu_error } = resp.DetectionBenchmarkResult;
        if (ocr_rec_cpu_time_ms === null) return null;
        return { cpuMs: ocr_rec_cpu_time_ms, gpuMs: ocr_rec_gpu_time_ms, gpuErr: ocr_rec_gpu_error };
      },
    },
    {
      key: "ocr-cls",
      label: "OCR Text Line Classification",
      cpuEl: getEl("benchmark-ocr-cls-cpu"),
      gpuEl: getEl("benchmark-ocr-cls-gpu"),
      speedupEl: getEl("benchmark-ocr-cls-speedup"),
      run: () => callService({ RunOcrClsBenchmark: null }).catch((e: any) => ({ Error: { message: e.message } })),
      extractResult: (resp) => {
        if (!("DetectionBenchmarkResult" in resp)) return null;
        const { ocr_cls_cpu_time_ms, ocr_cls_gpu_time_ms, ocr_cls_gpu_error } = resp.DetectionBenchmarkResult;
        if (ocr_cls_cpu_time_ms === null) return null;
        return { cpuMs: ocr_cls_cpu_time_ms, gpuMs: ocr_cls_gpu_time_ms, gpuErr: ocr_cls_gpu_error };
      },
    },
    {
      key: "manga-bubble",
      label: "Manga Bubble YOLO",
      cpuEl: getEl("benchmark-manga-bubble-cpu"),
      gpuEl: getEl("benchmark-manga-bubble-gpu"),
      speedupEl: getEl("benchmark-manga-bubble-speedup"),
      run: () => callService({ RunMangaBubbleBenchmark: null }).catch((e: any) => ({ Error: { message: e.message } })),
      extractResult: (resp) => {
        if (!("DetectionBenchmarkResult" in resp)) return null;
        const { manga_bubble_cpu_time_ms, manga_bubble_gpu_time_ms, manga_bubble_gpu_error } = resp.DetectionBenchmarkResult;
        if (manga_bubble_cpu_time_ms === null) return null;
        return { cpuMs: manga_bubble_cpu_time_ms, gpuMs: manga_bubble_gpu_time_ms, gpuErr: manga_bubble_gpu_error };
      },
    },
  ];

  function initBenchmarkUI() {
    benchmarks.forEach((b, i) => {
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

  async function runSingleBenchmark(bench: BenchmarkConfig) {
    startRunningAnimation(bench);
    try {
      const resp = await bench.run();
      if ("Error" in resp) {
        appendBenchError(`${bench.label}: ${resp.Error.message}`);
        return;
      }
      const result = bench.extractResult(resp);
      if (result) {
        displayThroughput(bench.cpuEl, bench.gpuEl, bench.speedupEl, result.cpuMs, result.gpuMs, result.gpuErr);
      } else {
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
    allRunButtons.forEach((b) => { b.disabled = disabled; });
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

        const listResp = await callService({ GetBenchmarkImages: { limit: finalN } });
        if ("Error" in listResp) {
          throw new Error(listResp.Error.message);
        }
        if (!("BenchmarkImagesResult" in listResp)) {
          throw new Error("Invalid response format when fetching images.");
        }

        const filepaths = listResp.BenchmarkImagesResult.filepaths;
        const totalCount = filepaths.length;
        if (totalCount === 0) {
          throw new Error("No benchmark images found in the database.");
        }

        // Kick off the background benchmark across all fetched images at once,
        // then poll per-image progress until it finishes.
        const startResp = await callService({ RunImageProcessingBenchmark: { filepaths } });
        if ("Error" in startResp) {
          throw new Error(startResp.Error.message);
        }

        let running = true;
        let currentProcessed = 0;

        const applyProgress = (res: {
          processed: number;
          decode_time_ms: number;
          thumbnail_time_ms: number;
          clip_preprocess_time_ms: number;
          tagger_preprocess_time_ms: number;
          yolo_preprocess_time_ms: number;
          ccip_extract_preprocess_time_ms: number;
        }) => {
          currentProcessed = res.processed || 0;
          if (pipelineCountEl) pipelineCountEl.textContent = `${currentProcessed} / ${totalCount}`;

          const formatMs = (sumMs: number) => {
            const avg = currentProcessed > 0 ? sumMs / currentProcessed : 0;
            return `${sumMs.toFixed(1)} ms (avg ${avg.toFixed(1)} ms/img)`;
          };

          if (pipelineDecodeEl) pipelineDecodeEl.textContent = formatMs(res.decode_time_ms);
          if (pipelineThumbEl) pipelineThumbEl.textContent = formatMs(res.thumbnail_time_ms);
          if (pipelineClipPrepEl) pipelineClipPrepEl.textContent = formatMs(res.clip_preprocess_time_ms);
          if (pipelineTaggerPrepEl) pipelineTaggerPrepEl.textContent = formatMs(res.tagger_preprocess_time_ms);
          if (pipelineYoloPrepEl) pipelineYoloPrepEl.textContent = formatMs(res.yolo_preprocess_time_ms);
          if (pipelineCcipPrepEl) pipelineCcipPrepEl.textContent = formatMs(res.ccip_extract_preprocess_time_ms);

          // Total = sum of the actual per-step measurements (same source and
          // denominator as the rows above), so it stays consistent rather than
          // reflecting wall-clock/polling overhead.
          const sumTotal =
            res.decode_time_ms +
            res.thumbnail_time_ms +
            res.clip_preprocess_time_ms +
            res.tagger_preprocess_time_ms +
            res.yolo_preprocess_time_ms +
            res.ccip_extract_preprocess_time_ms;
          if (pipelineTotalEl) pipelineTotalEl.textContent = formatMs(sumTotal);
        };

        while (running) {
          const progResp = await callService({ GetImageProcessingBenchmarkProgress: null });
          if ("Error" in progResp) {
            throw new Error(progResp.Error.message);
          }
          if (!("ImageProcessingBenchmarkProgress" in progResp)) {
            throw new Error("Invalid progress response format.");
          }
          const prog = progResp.ImageProcessingBenchmarkProgress;
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
    const statusResp = await callService({ GetStatus: null });
    if ("StatusResult" in statusResp) {
      const maxImages = statusResp.StatusResult.image_count;
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
  { key: "clip",         label: "CLIP ViT-B/32",               size: "224x224"   },
  { key: "mclip",        label: "MobileCLIP-S2",               size: "256x256"   },
  { key: "tagger",       label: "Camie Tagger v2",             size: "512x512"   },
  { key: "tagger-wd",    label: "WD EVA02 Tagger",             size: "448x448"   },
  { key: "yolo",         label: "YOLO Person Detection",       size: "640x640"   },
  { key: "ccip-feat",    label: "CCIP Feature Extraction",     size: "384x384"   },
  { key: "ccip-metrics", label: "CCIP Metrics",                size: "16x768"    },
  { key: "ocr-det",      label: "OCR Text Detection",          size: "960x960"   },
  { key: "ocr-rec",      label: "OCR Text Recognition",        size: "48x320"    },
  { key: "ocr-cls",      label: "OCR Line Classification",     size: "80x160"    },
  { key: "manga-bubble", label: "Manga Bubble YOLO",           size: "1280x1280" },
];

function benchmarkCardHtml(card: BenchmarkCardDef): SafeHtml {
  return html`
    <div class="group-box" style="padding: 10px; margin: 0;">
      <button class="win-button" data-benchmark-key="${card.key}" title="Run ${card.label} benchmark"
        style="position: absolute; top: -9px; right: 4px; height: 18px; padding: 0 7px; font-size: 11px; border-radius: 4px; display: flex; align-items: center; justify-content: center;">
        <i class="bi bi-play-fill" style="font-size: 12px;"></i>
      </button>
      <div class="group-box-title">${card.label} <span style="font-weight: normal; font-size: 10px; color: #666;">(${card.size})</span></div>
      <div style="display: flex; flex-direction: column; gap: 6px; font-size: 11px;">
        <div style="display: flex; justify-content: space-between; align-items: baseline; gap: 8px;">
          <span>CPU Throughput</span>
          <span id="benchmark-${card.key}-cpu" style="text-align: right;">—</span>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: baseline; gap: 8px;">
          <span>GPU Throughput</span>
          <span id="benchmark-${card.key}-gpu" style="text-align: right;">—</span>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: baseline; gap: 8px; border-top: 1px solid #eee; padding-top: 4px;">
          <span>Throughput Factor</span>
          <span id="benchmark-${card.key}-speedup" style="text-align: right; font-weight: bold;">—</span>
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
        Measure inference latency on CPU vs GPU. Runs all available models (CLIP, Tagger, YOLO, CCIP) and reports average speed and throughput factor.
      </p>
      <div style="display: flex; gap: 16px; align-items: center;">
        <button class="win-button" id="run-benchmark-btn">
          <i class="bi bi-play-fill"></i> Run Benchmark
        </button>
      </div>

      <div class="group-box" style="padding: 12px; margin-top: 10px; background-color: #f6f6f6;">
        <div class="group-box-title">Results</div>
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px dashed #ccc; padding-bottom: 6px; margin-bottom: 10px;">
          <span style="font-weight: bold; font-size: 11px;">GPU Provider Support:</span>
          <span id="benchmark-gpu-loaded" style="font-size: 11px;">—</span>
        </div>
        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px;">
          ${BENCHMARK_CARDS.map(benchmarkCardHtml).join("")}
        </div>
      </div>
      <p style="font-size: 11px; color: red;" id="benchmark-error-msg"></p>
    </div>

    <div class="group-box" style="display: flex; flex-direction: column; gap: 16px; margin-top: 16px;">
      <div class="group-box-title">Image Processing &amp; Preprocessing Benchmark (N = 100)</div>
      <p style="font-size: 11px; color: #333333; margin-bottom: 8px;">
        Runs CPU image processing and input preprocessing stages (RGB decoding, thumbnailing, CLIP tensor prep, Tagger fast-image-resize tensor prep, YOLO letterbox tensor prep, and CCIP tensor prep) on up to 100 database images.
      </p>
      <div style="display: flex; gap: 16px; align-items: center; flex-wrap: wrap;">
        <div style="display: flex; align-items: center; gap: 8px; font-size: 11px;">
          <label for="benchmark-pipeline-n">Number of images (N):</label>
          <input type="number" id="benchmark-pipeline-n" class="win-input" value="100" min="1" style="width: 80px;" />
          <span id="benchmark-pipeline-max-hint" style="color: #666;">(max ...)</span>
        </div>
        <button class="win-button" id="run-image-proc-benchmark-btn">
          <i class="bi bi-play-fill"></i> Run Pipeline Benchmark
        </button>
      </div>

      <div class="group-box" style="padding: 12px; margin-top: 10px; background-color: #f6f6f6;">
        <div class="group-box-title">Pipeline Results</div>
        <div style="display: flex; flex-direction: column; gap: 12px; font-size: 11px;">
          <div style="display: flex; justify-content: space-between; border-bottom: 1px dashed #ccc; padding-bottom: 4px;">
            <span style="font-weight: bold;">Images Processed:</span>
            <span id="benchmark-pipeline-count">—</span>
          </div>
          <div style="margin-top: 4px;">
            <div style="display: flex; justify-content: space-between; border-bottom: 1px dashed #eee; padding-bottom: 2px;">
              <span>Image Decode:</span><span id="benchmark-pipeline-decode">—</span>
            </div>
            <div style="display: flex; justify-content: space-between; border-bottom: 1px dashed #eee; padding-bottom: 2px;">
              <span>Thumbnail Generation:</span><span id="benchmark-pipeline-thumbnail">—</span>
            </div>
            <div style="display: flex; justify-content: space-between; border-bottom: 1px dashed #eee; padding-bottom: 2px;">
              <span>CLIP Preprocessing:</span><span id="benchmark-pipeline-clip-prep">—</span>
            </div>
            <div style="display: flex; justify-content: space-between; border-bottom: 1px dashed #eee; padding-bottom: 2px;">
              <span>Camie Tagger Preprocessing:</span><span id="benchmark-pipeline-tagger-prep">—</span>
            </div>
            <div style="display: flex; justify-content: space-between; border-bottom: 1px dashed #eee; padding-bottom: 2px;">
              <span>YOLO Preprocessing:</span><span id="benchmark-pipeline-yolo-prep">—</span>
            </div>
            <div style="display: flex; justify-content: space-between; border-bottom: 1px dashed #eee; padding-bottom: 2px;">
              <span>CCIP Preprocessing:</span><span id="benchmark-pipeline-ccip-prep">—</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding-top: 4px; border-top: 1px solid #777; font-weight: bold;">
              <span>Total Pipeline Time:</span><span id="benchmark-pipeline-total">—</span>
            </div>
          </div>
        </div>
      </div>
      <p style="font-size: 11px; color: red;" id="benchmark-pipeline-error-msg"></p>
    </div>
  `;
}
