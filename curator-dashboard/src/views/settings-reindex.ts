import { callService } from "../ipc";

let reindexPollInterval: number | null = null;

export function updateReindexProgress(
  vector_count: number,
  pending_jobs: number,
  preprocessing_jobs: number
) {
  const container = document.getElementById("reindex-progress-container");
  const preBar = document.getElementById("reindex-preprocess-bar");
  const preText = document.getElementById("reindex-preprocess-text");
  const idxBar = document.getElementById("reindex-index-bar");
  const idxText = document.getElementById("reindex-index-text");
  const status = document.getElementById("reindex-progress-status");

  if (!container || !preBar || !preText || !idxBar || !idxText || !status) return;

  const total = vector_count + pending_jobs + preprocessing_jobs;

  if (total > 0 && (pending_jobs > 0 || preprocessing_jobs > 0)) {
    container.style.display = "block";

    const preprocessed = vector_count + preprocessing_jobs;
    const prePercent = Math.round((preprocessed / total) * 100);
    preBar.style.width = prePercent + "%";
    preText.textContent = `Preprocessing progress: ${preprocessed}/${total} (${prePercent}%)`;

    const idxPercent = Math.round((vector_count / total) * 100);
    idxBar.style.width = idxPercent + "%";
    idxText.textContent = `Indexing progress: ${vector_count}/${total} (${idxPercent}%)`;

    status.textContent = "Processing...";
    status.style.color = "#fbbf24";
  } else {
    if (container.style.display === "block" && status.textContent === "Processing...") {
      preBar.style.width = "100%";
      preText.textContent = `Preprocessing progress: ${total}/${total} (100%)`;
      idxBar.style.width = "100%";
      idxText.textContent = `Indexing progress: ${total}/${total} (100%)`;
      status.textContent = "Completed";
      status.style.color = "#10b981";
      setTimeout(() => {
        if (status.textContent === "Completed") {
          container.style.display = "none";
        }
      }, 5000);
    } else {
      container.style.display = "none";
    }
  }
}

export function startReindexPolling() {
  if (reindexPollInterval) return;
  const check = async () => {
    try {
      const resp = await callService({ GetStatus: null });
      if ("StatusResult" in resp) {
        const { vector_count, pending_jobs, preprocessing_jobs } = resp.StatusResult;
        updateReindexProgress(vector_count, pending_jobs, preprocessing_jobs);
        if (pending_jobs === 0 && preprocessing_jobs === 0) {
          if (reindexPollInterval) {
            clearInterval(reindexPollInterval);
            reindexPollInterval = null;
          }
        }
      }
    } catch (e) {
      console.error("Error polling reindex status:", e);
    }
  };
  check();
  reindexPollInterval = setInterval(check, 1000) as unknown as number;
}
