import { callService } from "../ipc";

interface BenchmarkConfig {
  key: string;
  label: string;
  cpuEl: HTMLElement | null;
  gpuEl: HTMLElement | null;
  speedupEl: HTMLElement | null;
  run: () => Promise<any>;
  extractResult: (resp: any) => { cpuMs: number; gpuMs: number | null; gpuErr: string | null } | null;
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
      key: "tagger",
      label: "Camie Tagger",
      cpuEl: getEl("benchmark-tagger-cpu"),
      gpuEl: getEl("benchmark-tagger-gpu"),
      speedupEl: getEl("benchmark-tagger-speedup"),
      run: () => callService({ RunTaggerBenchmark: null }).catch((e: any) => ({ Error: { message: e.message } })),
      extractResult: (resp) => {
        if (!("BenchmarkResult" in resp)) return null;
        const { tagger_cpu_time_ms, tagger_gpu_time_ms, tagger_gpu_error } = resp.BenchmarkResult;
        if (tagger_cpu_time_ms === null) {
          const cpuEl = getEl("benchmark-tagger-cpu");
          const gpuEl = getEl("benchmark-tagger-gpu");
          const speedupEl = getEl("benchmark-tagger-speedup");
          if (cpuEl) cpuEl.textContent = tagger_gpu_error ? `Error: ${tagger_gpu_error}` : "N/A (Model file not found)";
          if (gpuEl) gpuEl.textContent = "N/A";
          if (speedupEl) speedupEl.textContent = "—";
          return null;
        }
        return { cpuMs: tagger_cpu_time_ms, gpuMs: tagger_gpu_time_ms, gpuErr: tagger_gpu_error };
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

        let sumDecode = 0;
        let sumThumb = 0;
        let sumClip = 0;
        let sumTagger = 0;
        let sumYolo = 0;
        let sumCcip = 0;
        const startOverall = performance.now();

        for (let i = 0; i < totalCount; i++) {
          const path = filepaths[i];
          runPipelineBtn.textContent = `Benchmarking (${i + 1}/${totalCount})...`;

          const singleResp = await callService({ BenchmarkSingleImage: { filepath: path } });
          if ("Error" in singleResp) {
            console.error(`Error on image ${path}:`, singleResp.Error.message);
            continue;
          }
          if (!("SingleImageBenchmarkResult" in singleResp)) {
            continue;
          }

          const res = singleResp.SingleImageBenchmarkResult;
          sumDecode += res.decode_time_ms;
          sumThumb += res.thumbnail_time_ms;
          sumClip += res.clip_preprocess_time_ms;
          sumTagger += res.tagger_preprocess_time_ms;
          sumYolo += res.yolo_preprocess_time_ms;
          sumCcip += res.ccip_extract_preprocess_time_ms;

          const currentProcessed = i + 1;
          if (pipelineCountEl) pipelineCountEl.textContent = `${currentProcessed} / ${totalCount}`;

          const formatMs = (sumMs: number) => {
            const avg = sumMs / currentProcessed;
            return `${sumMs.toFixed(1)} ms (avg ${avg.toFixed(1)} ms/img)`;
          };

          if (pipelineDecodeEl) pipelineDecodeEl.textContent = formatMs(sumDecode);
          if (pipelineThumbEl) pipelineThumbEl.textContent = formatMs(sumThumb);
          if (pipelineClipPrepEl) pipelineClipPrepEl.textContent = formatMs(sumClip);
          if (pipelineTaggerPrepEl) pipelineTaggerPrepEl.textContent = formatMs(sumTagger);
          if (pipelineYoloPrepEl) pipelineYoloPrepEl.textContent = formatMs(sumYolo);
          if (pipelineCcipPrepEl) pipelineCcipPrepEl.textContent = formatMs(sumCcip);

          const overallElapsed = performance.now() - startOverall;
          if (pipelineTotalEl) pipelineTotalEl.textContent = `${overallElapsed.toFixed(1)} ms (avg ${(overallElapsed / currentProcessed).toFixed(1)} ms/img)`;
        }
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
