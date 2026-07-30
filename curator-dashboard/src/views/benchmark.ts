import { callService } from "../ipc";

export function setupBenchmark() {
  const runBtn = document.getElementById("run-benchmark-btn");
  const gpuLoaded = document.getElementById("benchmark-gpu-loaded");
  const errText = document.getElementById("benchmark-error-msg");

  const clipCpu = document.getElementById("benchmark-clip-cpu");
  const clipGpu = document.getElementById("benchmark-clip-gpu");
  const clipSpeedup = document.getElementById("benchmark-clip-speedup");

  const mclipCpu = document.getElementById("benchmark-mclip-cpu");
  const mclipGpu = document.getElementById("benchmark-mclip-gpu");
  const mclipSpeedup = document.getElementById("benchmark-mclip-speedup");

  const taggerCpu = document.getElementById("benchmark-tagger-cpu");
  const taggerGpu = document.getElementById("benchmark-tagger-gpu");
  const taggerSpeedup = document.getElementById("benchmark-tagger-speedup");

  const yoloCpu = document.getElementById("benchmark-yolo-cpu");
  const yoloGpu = document.getElementById("benchmark-yolo-gpu");
  const yoloSpeedup = document.getElementById("benchmark-yolo-speedup");

  const ccipFeatCpu = document.getElementById("benchmark-ccip-feat-cpu");
  const ccipFeatGpu = document.getElementById("benchmark-ccip-feat-gpu");
  const ccipFeatSpeedup = document.getElementById("benchmark-ccip-feat-speedup");

  const ccipMetricsCpu = document.getElementById("benchmark-ccip-metrics-cpu");
  const ccipMetricsGpu = document.getElementById("benchmark-ccip-metrics-gpu");
  const ccipMetricsSpeedup = document.getElementById("benchmark-ccip-metrics-speedup");

  if (!runBtn) return;

  function initBenchmarkUI() {
    // Phase 1 (CLIP ViT-B/32) starts immediately
    if (clipCpu) clipCpu.textContent = "Running...";
    if (clipGpu) clipGpu.textContent = "Running...";
    if (clipSpeedup) clipSpeedup.textContent = "Calculating...";

    // Phase 2 (Camie Tagger) is queued
    if (taggerCpu) taggerCpu.textContent = "Queued...";
    if (taggerGpu) taggerGpu.textContent = "Queued...";
    if (taggerSpeedup) taggerSpeedup.textContent = "Waiting...";

    // Phase 3 (MobileCLIP-S2) is queued
    if (mclipCpu) mclipCpu.textContent = "Queued...";
    if (mclipGpu) mclipGpu.textContent = "Queued...";
    if (mclipSpeedup) mclipSpeedup.textContent = "Waiting...";

    // Phase 4 (YOLO Person) is queued
    if (yoloCpu) yoloCpu.textContent = "Queued...";
    if (yoloGpu) yoloGpu.textContent = "Queued...";
    if (yoloSpeedup) yoloSpeedup.textContent = "Waiting...";

    // Phase 5 (CCIP Feature) is queued
    if (ccipFeatCpu) ccipFeatCpu.textContent = "Queued...";
    if (ccipFeatGpu) ccipFeatGpu.textContent = "Queued...";
    if (ccipFeatSpeedup) ccipFeatSpeedup.textContent = "Waiting...";

    // Phase 6 (CCIP Metrics) is queued
    if (ccipMetricsCpu) ccipMetricsCpu.textContent = "Queued...";
    if (ccipMetricsGpu) ccipMetricsGpu.textContent = "Queued...";
    if (ccipMetricsSpeedup) ccipMetricsSpeedup.textContent = "Waiting...";

    if (gpuLoaded) gpuLoaded.textContent = "...";
    if (errText) errText.textContent = "";
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

  runBtn.addEventListener("click", async () => {
    runBtn.setAttribute("disabled", "true");
    runBtn.textContent = "Benchmarking...";
    initBenchmarkUI();

    try {
      // 1. Run CLIP ViT-B/32 Benchmark
      const clipResp = await callService({ RunBenchmark: { embedding_model: "clip-vit-b-32", run_tagger: false } })
        .catch((e: any) => ({ Error: { message: e.message } }));

      // Handle CLIP ViT-B/32 results
      if ("BenchmarkResult" in clipResp) {
        const { clip_cpu_time_ms, clip_gpu_time_ms, clip_gpu_error, has_gpu } = clipResp.BenchmarkResult;
        displayThroughput(clipCpu, clipGpu, clipSpeedup, clip_cpu_time_ms, clip_gpu_time_ms, clip_gpu_error);

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
      } else if ("Error" in clipResp) {
        if (errText) errText.textContent = `CLIP ViT-B/32: ${clipResp.Error.message}`;
      }

      // 2. Run Camie Tagger
      if (taggerCpu) taggerCpu.textContent = "Running...";
      if (taggerGpu) taggerGpu.textContent = "Running...";
      if (taggerSpeedup) taggerSpeedup.textContent = "Calculating...";

      const taggerResp = await callService({ RunTaggerBenchmark: null })
        .catch((e: any) => ({ Error: { message: e.message } }));

      if ("BenchmarkResult" in taggerResp) {
        const { tagger_cpu_time_ms, tagger_gpu_time_ms, tagger_gpu_error } = taggerResp.BenchmarkResult;
        if (tagger_cpu_time_ms !== null) {
          displayThroughput(taggerCpu, taggerGpu, taggerSpeedup, tagger_cpu_time_ms, tagger_gpu_time_ms, tagger_gpu_error);
        } else {
          if (taggerCpu) taggerCpu.textContent = tagger_gpu_error ? `Error: ${tagger_gpu_error}` : "N/A (Model file not found)";
          if (taggerGpu) taggerGpu.textContent = "N/A";
          if (taggerSpeedup) taggerSpeedup.textContent = "—";
        }
      } else if ("Error" in taggerResp) {
        const existing = errText?.textContent || "";
        if (errText) errText.textContent = existing ? `${existing}\nCamie Tagger: ${taggerResp.Error.message}` : `Camie Tagger: ${taggerResp.Error.message}`;
      }

      // 3. Run MobileCLIP-S2
      if (mclipCpu) mclipCpu.textContent = "Running...";
      if (mclipGpu) mclipGpu.textContent = "Running...";
      if (mclipSpeedup) mclipSpeedup.textContent = "Calculating...";

      const mclipResp = await callService({ RunBenchmark: { embedding_model: "mobileclip-s2", run_tagger: false } })
        .catch((e: any) => ({ Error: { message: e.message } }));

      if ("BenchmarkResult" in mclipResp) {
        const { clip_cpu_time_ms, clip_gpu_time_ms, clip_gpu_error } = mclipResp.BenchmarkResult;
        displayThroughput(mclipCpu, mclipGpu, mclipSpeedup, clip_cpu_time_ms, clip_gpu_time_ms, clip_gpu_error);
      } else if ("Error" in mclipResp) {
        const existing = errText?.textContent || "";
        if (errText) errText.textContent = existing ? `${existing}\nMobileCLIP: ${mclipResp.Error.message}` : `MobileCLIP: ${mclipResp.Error.message}`;
      }

      // 4. Run YOLO Person Detection
      if (yoloCpu) yoloCpu.textContent = "Running...";
      if (yoloGpu) yoloGpu.textContent = "Running...";
      if (yoloSpeedup) yoloSpeedup.textContent = "Calculating...";

      const yoloResp = await callService({ RunYoloBenchmark: null })
        .catch((e: any) => ({ Error: { message: e.message } }));

      if ("DetectionBenchmarkResult" in yoloResp) {
        const { yolo_cpu_time_ms, yolo_gpu_time_ms, yolo_gpu_error } = yoloResp.DetectionBenchmarkResult;
        if (yolo_cpu_time_ms !== null) {
          displayThroughput(yoloCpu, yoloGpu, yoloSpeedup, yolo_cpu_time_ms, yolo_gpu_time_ms, yolo_gpu_error);
        }
      } else if ("Error" in yoloResp) {
        const existing = errText?.textContent || "";
        if (errText) errText.textContent = existing ? `${existing}\nYOLO: ${yoloResp.Error.message}` : `YOLO: ${yoloResp.Error.message}`;
      }

      // 5. Run CCIP Feature Extraction
      if (ccipFeatCpu) ccipFeatCpu.textContent = "Running...";
      if (ccipFeatGpu) ccipFeatGpu.textContent = "Running...";
      if (ccipFeatSpeedup) ccipFeatSpeedup.textContent = "Calculating...";

      const featResp = await callService({ RunCcipFeatBenchmark: null })
        .catch((e: any) => ({ Error: { message: e.message } }));

      if ("DetectionBenchmarkResult" in featResp) {
        const { ccip_feat_cpu_time_ms, ccip_feat_gpu_time_ms, ccip_feat_gpu_error } = featResp.DetectionBenchmarkResult;
        if (ccip_feat_cpu_time_ms !== null) {
          displayThroughput(ccipFeatCpu, ccipFeatGpu, ccipFeatSpeedup, ccip_feat_cpu_time_ms, ccip_feat_gpu_time_ms, ccip_feat_gpu_error);
        }
      } else if ("Error" in featResp) {
        const existing = errText?.textContent || "";
        if (errText) errText.textContent = existing ? `${existing}\nCCIP Feature: ${featResp.Error.message}` : `CCIP Feature: ${featResp.Error.message}`;
      }

      // 6. Run CCIP Metrics
      if (ccipMetricsCpu) ccipMetricsCpu.textContent = "Running...";
      if (ccipMetricsGpu) ccipMetricsGpu.textContent = "Running...";
      if (ccipMetricsSpeedup) ccipMetricsSpeedup.textContent = "Calculating...";

      const metricsResp = await callService({ RunCcipMetricsBenchmark: null })
        .catch((e: any) => ({ Error: { message: e.message } }));

      if ("DetectionBenchmarkResult" in metricsResp) {
        const { ccip_metrics_cpu_time_ms, ccip_metrics_gpu_time_ms, ccip_metrics_gpu_error } = metricsResp.DetectionBenchmarkResult;
        if (ccip_metrics_cpu_time_ms !== null) {
          displayThroughput(ccipMetricsCpu, ccipMetricsGpu, ccipMetricsSpeedup, ccip_metrics_cpu_time_ms, ccip_metrics_gpu_time_ms, ccip_metrics_gpu_error);
        }
      } else if ("Error" in metricsResp) {
        const existing = errText?.textContent || "";
        if (errText) errText.textContent = existing ? `${existing}\nCCIP Metrics: ${metricsResp.Error.message}` : `CCIP Metrics: ${metricsResp.Error.message}`;
      }
    } catch (e: any) {
      if (errText) errText.textContent = `Execution error: ${e.message || e}`;
    } finally {
      runBtn.removeAttribute("disabled");
      runBtn.innerHTML = '<i class="bi bi-play-fill"></i> Run Benchmark';
    }
  });
}

// Kept for signature compatibility if imported elsewhere
export function updateBenchmarkModelHeader(_model: string | null) {}
