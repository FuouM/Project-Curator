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

  if (!runBtn) return;

  runBtn.addEventListener("click", async () => {
    const modelSelect = document.getElementById("benchmark-embedding-model") as HTMLSelectElement;
    const selectedModel = modelSelect ? (modelSelect.value as "clip-vit-b-32" | "mobileclip-s2") : "clip-vit-b-32";

    updateBenchmarkModelHeader(selectedModel);

    runBtn.setAttribute("disabled", "true");
    runBtn.textContent = "Benchmarking...";

    if (clipCpu) clipCpu.textContent = "Running...";
    if (clipGpu) clipGpu.textContent = "Running...";
    if (clipSpeedup) clipSpeedup.textContent = "Calculating...";

    if (taggerCpu) taggerCpu.textContent = "Running...";
    if (taggerGpu) taggerGpu.textContent = "Running...";
    if (taggerSpeedup) taggerSpeedup.textContent = "Calculating...";

    if (gpuLoaded) gpuLoaded.textContent = "...";
    if (errText) errText.textContent = "";

    try {
      const resp = await callService({ RunBenchmark: { embedding_model: selectedModel } });
      if ("BenchmarkResult" in resp) {
        const {
          clip_cpu_time_ms,
          clip_gpu_time_ms,
          clip_gpu_error,
          tagger_cpu_time_ms,
          tagger_gpu_time_ms,
          tagger_gpu_error,
          has_gpu
        } = resp.BenchmarkResult;

        if (clipCpu) {
          clipCpu.textContent = `${clip_cpu_time_ms.toFixed(2)} ms / image (${(1000 / clip_cpu_time_ms).toFixed(1)} items/sec)`;
        }
        if (clip_gpu_time_ms !== null) {
          if (clipGpu) {
            clipGpu.textContent = `${clip_gpu_time_ms.toFixed(2)} ms / image (${(1000 / clip_gpu_time_ms).toFixed(1)} items/sec)`;
          }
          if (clipSpeedup) {
            const factor = clip_cpu_time_ms / clip_gpu_time_ms;
            clipSpeedup.textContent = `${factor.toFixed(2)}x Speedup`;
            clipSpeedup.style.color = factor > 1 ? "#008000" : "#d00000";
            clipSpeedup.style.fontWeight = "bold";
          }
        } else {
          if (clipGpu) {
            clipGpu.textContent = clip_gpu_error ? `Error: ${clip_gpu_error}` : "N/A (Disabled or Failed)";
          }
          if (clipSpeedup) clipSpeedup.textContent = "—";
        }

        if (tagger_cpu_time_ms !== null) {
          if (taggerCpu) {
            taggerCpu.textContent = `${tagger_cpu_time_ms.toFixed(2)} ms / image (${(1000 / tagger_cpu_time_ms).toFixed(1)} items/sec)`;
          }
          if (tagger_gpu_time_ms !== null) {
            if (taggerGpu) {
              taggerGpu.textContent = `${tagger_gpu_time_ms.toFixed(2)} ms / image (${(1000 / tagger_gpu_time_ms).toFixed(1)} items/sec)`;
            }
            if (taggerSpeedup) {
              const factor = tagger_cpu_time_ms / tagger_gpu_time_ms;
              taggerSpeedup.textContent = `${factor.toFixed(2)}x Speedup`;
              taggerSpeedup.style.color = factor > 1 ? "#008000" : "#d00000";
              taggerSpeedup.style.fontWeight = "bold";
            }
          } else {
            if (taggerGpu) {
              taggerGpu.textContent = tagger_gpu_error ? `Error: ${tagger_gpu_error}` : "N/A";
            }
            if (taggerSpeedup) taggerSpeedup.textContent = "—";
          }
        } else {
          if (taggerCpu) {
            taggerCpu.textContent = tagger_gpu_error ? `Error: ${tagger_gpu_error}` : "N/A (Model file not found)";
          }
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
      } else if ("Error" in resp) {
        if (errText) errText.textContent = resp.Error.message;
      }
    } catch (e: any) {
      if (errText) errText.textContent = e.message || "Request failed";
    } finally {
      runBtn.removeAttribute("disabled");
      runBtn.innerHTML = '<i class="bi bi-play-fill"></i> Run Benchmark';
    }
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
