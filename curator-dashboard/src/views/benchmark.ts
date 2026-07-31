import { callService } from "../ipc";

interface BenchmarkConfig {
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

  runBtn.addEventListener("click", async () => {
    runBtn.setAttribute("disabled", "true");
    runBtn.textContent = "Benchmarking...";
    initBenchmarkUI();

    try {
      for (const bench of benchmarks) {
        if (bench.cpuEl) bench.cpuEl.textContent = "Running...";
        if (bench.gpuEl) bench.gpuEl.textContent = "Running...";
        if (bench.speedupEl) bench.speedupEl.textContent = "Calculating...";

        const resp = await bench.run();

        if ("Error" in resp) {
          const existing = errText?.textContent || "";
          if (errText) {
            errText.textContent = existing
              ? `${existing}\n${bench.label}: ${resp.Error.message}`
              : `${bench.label}: ${resp.Error.message}`;
          }
        } else {
          const result = bench.extractResult(resp);
          if (result) {
            displayThroughput(bench.cpuEl, bench.gpuEl, bench.speedupEl, result.cpuMs, result.gpuMs, result.gpuErr);
          }
        }
      }
    } catch (e: any) {
      if (errText) errText.textContent = `Execution error: ${e.message || e}`;
    } finally {
      runBtn.removeAttribute("disabled");
      runBtn.innerHTML = '<i class="bi bi-play-fill"></i> Run Benchmark';
    }
  });
}

export function updateBenchmarkModelHeader(_model: string | null) {}
