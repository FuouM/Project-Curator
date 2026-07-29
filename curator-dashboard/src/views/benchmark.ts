import { callService } from "../ipc";

export function setupBenchmark() {
  const runBtn = document.getElementById("run-benchmark-btn");
  const gpuLoaded = document.getElementById("benchmark-gpu-loaded");
  const errText = document.getElementById("benchmark-error-msg");

  const clipCpu = document.getElementById("benchmark-clip-cpu");
  const clipGpu = document.getElementById("benchmark-clip-gpu");
  const clipSpeedup = document.getElementById("benchmark-clip-speedup");

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

  function setRunning() {
    if (clipCpu) clipCpu.textContent = "Running...";
    if (clipGpu) clipGpu.textContent = "Running...";
    if (clipSpeedup) clipSpeedup.textContent = "Calculating...";
    if (taggerCpu) taggerCpu.textContent = "Running...";
    if (taggerGpu) taggerGpu.textContent = "Running...";
    if (taggerSpeedup) taggerSpeedup.textContent = "Calculating...";
    if (yoloCpu) yoloCpu.textContent = "Running...";
    if (yoloGpu) yoloGpu.textContent = "Running...";
    if (yoloSpeedup) yoloSpeedup.textContent = "Calculating...";
    if (ccipFeatCpu) ccipFeatCpu.textContent = "Running...";
    if (ccipFeatGpu) ccipFeatGpu.textContent = "Running...";
    if (ccipFeatSpeedup) ccipFeatSpeedup.textContent = "Calculating...";
    if (ccipMetricsCpu) ccipMetricsCpu.textContent = "Running...";
    if (ccipMetricsGpu) ccipMetricsGpu.textContent = "Running...";
    if (ccipMetricsSpeedup) ccipMetricsSpeedup.textContent = "Calculating...";
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
    const modelSelect = document.getElementById("benchmark-embedding-model") as HTMLSelectElement;
    const selectedModel = modelSelect ? (modelSelect.value as "clip-vit-b-32" | "mobileclip-s2") : "clip-vit-b-32";

    updateBenchmarkModelHeader(selectedModel);

    runBtn.setAttribute("disabled", "true");
    runBtn.textContent = "Benchmarking...";
    setRunning();

    // Run both benchmarks in parallel
    const [clipResp, detResp] = await Promise.all([
      callService({ RunBenchmark: { embedding_model: selectedModel } }).catch((e: any) => ({ Error: { message: e.message } })),
      callService({ RunDetectionBenchmark: null }).catch((e: any) => ({ Error: { message: e.message } })),
    ]);

    // Handle CLIP/Tagger results
    if ("BenchmarkResult" in clipResp) {
      const {
        clip_cpu_time_ms, clip_gpu_time_ms, clip_gpu_error,
        tagger_cpu_time_ms, tagger_gpu_time_ms, tagger_gpu_error,
        has_gpu
      } = clipResp.BenchmarkResult;

      displayThroughput(clipCpu, clipGpu, clipSpeedup, clip_cpu_time_ms, clip_gpu_time_ms, clip_gpu_error);

      if (tagger_cpu_time_ms !== null) {
        displayThroughput(taggerCpu, taggerGpu, taggerSpeedup, tagger_cpu_time_ms, tagger_gpu_time_ms, tagger_gpu_error);
      } else {
        if (taggerCpu) taggerCpu.textContent = tagger_gpu_error ? `Error: ${tagger_gpu_error}` : "N/A (Model file not found)";
        if (taggerGpu) taggerGpu.textContent = "N/A";
        if (taggerSpeedup) taggerSpeedup.textContent = "—";
      }

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
      if (errText) errText.textContent = clipResp.Error.message;
    }

    // Handle Detection results
    if ("DetectionBenchmarkResult" in detResp) {
      const {
        yolo_cpu_time_ms, yolo_gpu_time_ms, yolo_gpu_error,
        ccip_feat_cpu_time_ms, ccip_feat_gpu_time_ms, ccip_feat_gpu_error,
        ccip_metrics_cpu_time_ms, ccip_metrics_gpu_time_ms, ccip_metrics_gpu_error,
      } = detResp.DetectionBenchmarkResult;

      displayThroughput(yoloCpu, yoloGpu, yoloSpeedup, yolo_cpu_time_ms, yolo_gpu_time_ms, yolo_gpu_error);
      displayThroughput(ccipFeatCpu, ccipFeatGpu, ccipFeatSpeedup, ccip_feat_cpu_time_ms, ccip_feat_gpu_time_ms, ccip_feat_gpu_error);
      displayThroughput(ccipMetricsCpu, ccipMetricsGpu, ccipMetricsSpeedup, ccip_metrics_cpu_time_ms, ccip_metrics_gpu_time_ms, ccip_metrics_gpu_error);
    } else if ("Error" in detResp) {
      const existing = errText?.textContent || "";
      if (errText) errText.textContent = existing ? `${existing}\nDetection: ${detResp.Error.message}` : `Detection: ${detResp.Error.message}`;
    }

    runBtn.removeAttribute("disabled");
    runBtn.innerHTML = '<i class="bi bi-play-fill"></i> Run Benchmark';
  });
}

export function updateBenchmarkModelHeader(model: string | null) {
  const titleEl = document.getElementById("benchmark-clip-title");
  if (!titleEl) return;
  if (model === "mobileclip-s2") {
    titleEl.textContent = "MobileCLIP-S2 Model (256x256)";
  } else {
    titleEl.textContent = "CLIP ViT-B/32 Model (224x224)";
  }
}
