import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import "bootstrap-icons/font/bootstrap-icons.css";
import {
  renderTagPill,
  renderGroupBox,
  componentRegistry
} from "./components";

function logJS(msg: string) {
  console.log(msg);
  invoke("log_frontend", { message: msg }).catch(() => {});
}

// --- Image Click Setting ---
const IMAGE_CLICK_KEY = "curator-image-click-action";

function getImageClickAction(): string {
  return localStorage.getItem(IMAGE_CLICK_KEY) || "in-app";
}

function setImageClickAction(action: string) {
  localStorage.setItem(IMAGE_CLICK_KEY, action);
}

// --- Image Viewer ---
let currentViewerPath: string | null = null;

function openImageViewer(filepath: string) {
  const modal = document.getElementById("image-viewer-modal");
  const img = document.getElementById("image-viewer-img") as HTMLImageElement;
  const title = document.getElementById("image-viewer-filename");

  if (!modal || !img || !title) return;

  currentViewerPath = filepath;
  title.textContent = filepath;
  img.src = convertFileSrc(filepath);
  modal.classList.add("active");
}

function closeImageViewer() {
  const modal = document.getElementById("image-viewer-modal");
  if (modal) modal.classList.remove("active");
  currentViewerPath = null;
}

function setupImageViewer() {
  document.getElementById("image-viewer-close")?.addEventListener("click", closeImageViewer);

  document.getElementById("image-viewer-modal")?.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    // Close unless clicking on an interactive element or the image
    if (!target.closest("button") && !target.closest(".image-viewer-close") && target.tagName !== "IMG") {
      closeImageViewer();
    }
  });

  document.getElementById("image-viewer-open-external")?.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (currentViewerPath) {
      logJS("Open external clicked for: " + currentViewerPath);
      try {
        await invoke("open_file_externally", { path: currentViewerPath });
      } catch (err: any) {
        logJS("open_file_externally error: " + (err?.message || String(err)));
        alert("Failed to open file: " + (err?.message || err));
      }
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeImageViewer();
  });
}

// Define Request/Response payloads to match curator-core::ipc
type RequestPayload =
  | { Ping: null }
  | { GetStatus: null }
  | { ImportImage: { path: string } }
  | { AddTag: { image_id: number; tag: string; category: string } }
  | { RemoveTag: { image_id: number; tag: string } }
  | { Search: { query_text: string | null; query_image_path: string | null; tag_filter: string | null; limit: number } }
  | { ListImages: { limit: number; offset: number } }
  | { GetImage: { image_id: number } }
  | { ValidatePlugin: { manifest_path: string } }
  | { TagImage: { image_id: number; threshold: number | null; force: boolean | null } }
  | { TagImageBatch: { image_ids: number[]; threshold: number | null; force: boolean | null } }
  | { GetTaggerStatus: null }
  | { RunBenchmark: null }
  | { GetSettings: null }
  | { UpdateSettings: { clip_device: string | null; tagger_device: string | null; idle_timeout_secs: number | null; embedding_model: string | null } }
  | { ReindexVectors: null }
  | { GetTagStatistics: null };

interface SearchMatch {
  id: number;
  filepath: string;
  score: number;
  tags: TagSummary[];
  match_type: string;
  hamming_distance?: number;
}

interface ImageDetails {
  id: number;
  sha256: string;
  current_filepath: string;
  mtime: number;
  created_at: string;
  tags: TagSummary[];
  vector_state: string;
}

interface TagSummary {
  tag: string;
  category: string;
  confidence: number;
}

interface TagStat {
  tag: string;
  category: string;
  count: number;
}

type ResponsePayload =
  | { Pong: null }
  | { Success: null }
  | { Error: { message: string } }
  | { ImportResult: { image_id: number; sha256: string } }
  | { SearchResult: { matches: SearchMatch[] } }
  | { StatusResult: { image_count: number; vector_count: number; pending_jobs: number; preprocessing_jobs: number } }
  | { ImageResult: { image: ImageDetails } }
  | { ListResult: { images: ImageDetails[] } }
  | { ValidationResult: { name: string; version: string; valid: boolean; error: string | null } }
  | { TagImageResult: { image_id: number; tags_applied: number; skipped: boolean; tags: TagSummary[] } }
  | { BatchTagResult: { processed: number; failed: number; skipped: number } }
  | { TaggerStatusResult: { loaded: boolean; model_path: string; total_tags: number } }
  | { BenchmarkResult: { clip_cpu_time_ms: number; clip_gpu_time_ms: number | null; clip_gpu_error: string | null; tagger_cpu_time_ms: number | null; tagger_gpu_time_ms: number | null; tagger_gpu_error: string | null; has_gpu: boolean } }
  | { SettingsResult: { clip_device: string; tagger_device: string; idle_timeout_secs: number; embedding_model: string } }
  | { TagStatisticsResult: { tags: TagStat[] } };

// Helpers for invoking the service through Rust Named Pipe bridge
async function callService(request: RequestPayload): Promise<ResponsePayload> {
  let formattedReq: any;
  if ("Ping" in request) {
    formattedReq = "Ping";
  } else if ("GetStatus" in request) {
    formattedReq = "GetStatus";
  } else if ("ImportImage" in request) {
    formattedReq = { ImportImage: request.ImportImage };
  } else if ("AddTag" in request) {
    formattedReq = { AddTag: request.AddTag };
  } else if ("RemoveTag" in request) {
    formattedReq = { RemoveTag: request.RemoveTag };
  } else if ("Search" in request) {
    formattedReq = { Search: request.Search };
  } else if ("ListImages" in request) {
    formattedReq = { ListImages: request.ListImages };
  } else if ("GetImage" in request) {
    formattedReq = { GetImage: request.GetImage };
  } else if ("ValidatePlugin" in request) {
    formattedReq = { ValidatePlugin: request.ValidatePlugin };
  } else if ("TagImage" in request) {
    formattedReq = { TagImage: request.TagImage };
  } else if ("TagImageBatch" in request) {
    formattedReq = { TagImageBatch: request.TagImageBatch };
  } else if ("GetTaggerStatus" in request) {
    formattedReq = "GetTaggerStatus";
  } else if ("RunBenchmark" in request) {
    formattedReq = "RunBenchmark";
  } else if ("GetSettings" in request) {
    formattedReq = "GetSettings";
  } else if ("UpdateSettings" in request) {
    formattedReq = { UpdateSettings: request.UpdateSettings };
  } else if ("ReindexVectors" in request) {
    formattedReq = "ReindexVectors";
  } else if ("GetTagStatistics" in request) {
    formattedReq = "GetTagStatistics";
  }

  try {
    const jsonStr = JSON.stringify(formattedReq);
    const respStr: string = await invoke("send_to_service", { requestJson: jsonStr });
    
    // Parse response
    const parsed = JSON.parse(respStr);
    
    // Normalize Serde enum structure
    if (typeof parsed === "string") {
      if (parsed === "Pong") return { Pong: null };
      if (parsed === "Success") return { Success: null };
    }
    
    if (parsed.Error) return { Error: parsed.Error };
    if (parsed.ImportResult) return { ImportResult: parsed.ImportResult };
    if (parsed.SearchResult) return { SearchResult: parsed.SearchResult };
    if (parsed.StatusResult) return { StatusResult: parsed.StatusResult };
    if (parsed.ImageResult) return { ImageResult: parsed.ImageResult };
    if (parsed.ListResult) return { ListResult: parsed.ListResult };
    if (parsed.ValidationResult) return { ValidationResult: parsed.ValidationResult };
    if (parsed.TagImageResult) return { TagImageResult: parsed.TagImageResult };
    if (parsed.BatchTagResult) return { BatchTagResult: parsed.BatchTagResult };
    if (parsed.TaggerStatusResult) return { TaggerStatusResult: parsed.TaggerStatusResult };
    if (parsed.BenchmarkResult) return { BenchmarkResult: parsed.BenchmarkResult };
    if (parsed.SettingsResult) return { SettingsResult: parsed.SettingsResult };
    if (parsed.TagStatisticsResult) return { TagStatisticsResult: parsed.TagStatisticsResult };

    throw new Error("Unknown response format: " + respStr);
  } catch (err: any) {
    logJS("callService exception: " + (err.message || err));
    throw err;
  }
}

// Inline Clear Button (x) for Input Fields
function setupInputClearButtons() {
  const inputs = document.querySelectorAll<HTMLInputElement>('.input-field.has-clear');

  inputs.forEach((input) => {
    const wrapper = input.closest('.input-wrapper');
    if (!wrapper) return;

    const clearBtn = wrapper.querySelector('.input-clear-btn') as HTMLButtonElement;
    if (!clearBtn) return;

    function updateClearVisibility() {
      if (input.value.length > 0) {
        wrapper!.classList.add('has-value');
      } else {
        wrapper!.classList.remove('has-value');
      }
    }

    input.addEventListener('input', updateClearVisibility);
    input.addEventListener('change', updateClearVisibility);
    updateClearVisibility();

    clearBtn.addEventListener('click', () => {
      input.value = '';
      updateClearVisibility();
      input.focus();
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });
}

function init() {
  setupNavigation();
  setupForms();
  startStatusPolling();
  refreshDashboard();
  setupTaggerCard();
  setupBenchmark();
  setupSettings();
  setupImageViewer();
  setupLogTabs();
  setupInputClearButtons();
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// Sidebar View Navigation
function setupNavigation() {
  const navItems = document.querySelectorAll(".nav-item");
  const sections = document.querySelectorAll(".view-section");
  const viewTitle = document.getElementById("view-title");
  const viewSubtitle = document.getElementById("view-subtitle");

  const subtitles: Record<string, { title: string; sub: string }> = {
    dashboard: { title: "Dashboard", sub: "Overview of your local vector store and image library." },
    gallery: { title: "Gallery", sub: "Browse all your imported digital images." },
    import: { title: "Import Images", sub: "Register and index new images locally." },
    search: { title: "Semantic Search", sub: "Perform neural and tag-based image retrieval." },
    plugins: { title: "Plugins", sub: "Verify and manage sandboxed plugin modules." },
    logs: { title: "System Diagnostic Logs", sub: "View active traces and stderr/stdout logs from the local engine." },
    benchmark: { title: "Hardware Performance Benchmark", sub: "Run latency and throughput comparisons on CPU vs GPU." },
    settings: { title: "Settings", sub: "Configure model device preferences (GPU / CPU)." },
    tagstats: { title: "Tag Statistics", sub: "View tag distribution and filter images by tag." },
    components: { title: "Component Stylesheet", sub: "A showcase and reference of the application's UI components and styles." }
  };

  navItems.forEach((item) => {
    item.addEventListener("click", () => {
      navItems.forEach((i) => i.classList.remove("active"));
      item.classList.add("active");

      const view = item.getAttribute("data-view") || "dashboard";

      sections.forEach((sec) => {
        sec.classList.remove("active");
        if (sec.id === `view-${view}`) {
          sec.classList.add("active");
        }
      });

      // Toggle main panel overflow for views that manage their own scrolling
      const mainPanel = document.querySelector(".main-panel") as HTMLElement;
      if (mainPanel) {
        mainPanel.style.overflowY = (view === "logs") ? "hidden" : "auto";
      }

      if (viewTitle && viewSubtitle) {
        viewTitle.textContent = subtitles[view].title;
        viewSubtitle.textContent = subtitles[view].sub;
      }

      if (view === "dashboard") {
        refreshDashboard();
      } else if (view === "gallery") {
        refreshGallery();
      } else if (view === "logs") {
        refreshLogs();
      } else if (view === "tagstats") {
        refreshTagStats();
      } else if (view === "components") {
        refreshComponentStylesheet();
      }
    });
  });

  // Gallery Pagination Setup
  document.getElementById("gallery-prev-btn")?.addEventListener("click", () => {
    if (galleryPage > 0) {
      galleryPage--;
      refreshGallery();
    }
  });

  document.getElementById("gallery-next-btn")?.addEventListener("click", () => {
    galleryPage++;
    refreshGallery();
  });

  // Logs buttons setup
  document.getElementById("refresh-logs-btn")?.addEventListener("click", refreshLogs);
  document.getElementById("clear-logs-btn")?.addEventListener("click", clearLogsData);

  // Modal setup
  document.getElementById("close-modal")?.addEventListener("click", () => {
    document.getElementById("add-tag-modal")?.classList.remove("active");
  });
}

// Poll service status and update UI indicators
function startStatusPolling() {
  const dot = document.getElementById("service-dot");
  const text = document.getElementById("service-status-text");

  async function check() {
    try {
      const resp = await callService({ GetStatus: null });
      if ("StatusResult" in resp) {
        if (dot && text) {
          dot.classList.remove("offline");
          text.textContent = "Service Online";
        }
        
        // Update stats
        const { image_count, vector_count, pending_jobs, preprocessing_jobs } = resp.StatusResult;
        const imgEl = document.getElementById("stat-images");
        const vecEl = document.getElementById("stat-vectors");
        const pendEl = document.getElementById("stat-pending");
        if (imgEl) imgEl.textContent = image_count.toString();
        if (vecEl) vecEl.textContent = vector_count.toString();
        if (pendEl) pendEl.textContent = (pending_jobs + preprocessing_jobs).toString();

        // Also refresh tagger status card value
        try {
          const tStatus = await callService({ GetTaggerStatus: null });
          const taggerEl = document.getElementById("stat-tagger");
          if (taggerEl && "TaggerStatusResult" in tStatus) {
            taggerEl.textContent = tStatus.TaggerStatusResult.loaded ? "Loaded" : "Ready";
          }
        } catch (te) {}

      } else if ("Error" in resp) {
        logJS("startStatusPolling returned Error response: " + resp.Error.message);
        if (dot && text) {
          dot.classList.add("offline");
          text.textContent = "Service Error";
        }
      } else {
        logJS("startStatusPolling unexpected response: " + JSON.stringify(resp));
      }
    } catch (e: any) {
      logJS("startStatusPolling exception: " + (e.message || e));
      if (dot && text) {
        dot.classList.add("offline");
        text.textContent = "Service Offline";
      }
    }
  }

  check();
  setInterval(check, 5000);
}

// Forms and Actions
function setupForms() {
  // Import Image Form
  const importForm = document.getElementById("import-form");
  const importInput = document.getElementById("import-path-input") as HTMLInputElement;
  const importMsg = document.getElementById("import-status-msg");

  // File & Folder Picker Browse buttons
  document.getElementById("browse-file-btn")?.addEventListener("click", async () => {
    try {
      const selected: string | null = await invoke("select_path", { isDirectory: false });
      if (selected && importInput) {
        importInput.value = selected;
        importInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } catch (err) {
      console.error("File dialog error: ", err);
    }
  });

  document.getElementById("browse-folder-btn")?.addEventListener("click", async () => {
    try {
      const selected: string | null = await invoke("select_path", { isDirectory: true });
      if (selected && importInput) {
        importInput.value = selected;
        importInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } catch (err) {
      console.error("Folder dialog error: ", err);
    }
  });

  importForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!importInput || !importMsg) return;

    importMsg.textContent = "Importing image...";
    importMsg.style.color = "#fbbf24";

    try {
      const resp = await callService({ ImportImage: { path: importInput.value } });
      if ("ImportResult" in resp) {
        importMsg.textContent = `Success! Image imported with ID ${resp.ImportResult.image_id}. SHA256: ${resp.ImportResult.sha256}`;
        importMsg.style.color = "#10b981";
        importInput.value = "";
        importInput.dispatchEvent(new Event('change', { bubbles: true }));
        refreshDashboard();
      } else if ("Error" in resp) {
        importMsg.textContent = `Error: ${resp.Error.message}`;
        importMsg.style.color = "#ef4444";
      }
    } catch (e) {
      importMsg.textContent = `IPC Error: ${e}`;
      importMsg.style.color = "#ef4444";
    }
  });

  // Search Form
  const searchForm = document.getElementById("search-form");
  const queryInput = document.getElementById("search-text-input") as HTMLInputElement;
  const tagInput = document.getElementById("search-tag-input") as HTMLInputElement;
  const imageInput = document.getElementById("search-image-path-input") as HTMLInputElement;

  function updateImagePreview() {
    const container = document.getElementById("search-image-preview-container");
    const img = document.getElementById("search-image-preview-img") as HTMLImageElement;
    const filenameSpan = document.getElementById("search-image-preview-filename");
    if (!imageInput || !container || !img || !filenameSpan) return;

    const path = imageInput.value.trim();
    if (path) {
      img.src = convertFileSrc(path);
      filenameSpan.textContent = path;
      filenameSpan.title = path;
      container.style.display = "flex";
    } else {
      img.src = "";
      filenameSpan.textContent = "";
      filenameSpan.title = "";
      container.style.display = "none";
    }
  }

  imageInput?.addEventListener("input", updateImagePreview);
  imageInput?.addEventListener("change", updateImagePreview);

  document.getElementById("search-browse-image-btn")?.addEventListener("click", async () => {
    try {
      const selected: string | null = await invoke("select_path", { isDirectory: false });
      if (selected && imageInput) {
        imageInput.value = selected;
        imageInput.dispatchEvent(new Event('change', { bubbles: true }));
        updateImagePreview();
      }
    } catch (err) {
      console.error("Browse image dialog error: ", err);
    }
  });

  document.getElementById("search-clear-image-btn")?.addEventListener("click", () => {
    if (imageInput) {
      imageInput.value = "";
      imageInput.dispatchEvent(new Event('change', { bubbles: true }));
      updateImagePreview();
    }
  });

  searchForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!queryInput || !tagInput || !imageInput) return;

    const grid = document.getElementById("search-results-grid");
    if (grid) {
      grid.innerHTML = `
        <div class="search-loading-container">
          <i class="bi bi-arrow-clockwise animate-spin" style="font-size: 24px;"></i>
          <span>Running AI search query...</span>
        </div>
      `;
    }

    try {
      const query = queryInput.value.trim() || null;
      const tag = tagInput.value.trim() || null;
      const imagePath = imageInput.value.trim() || null;
      
      const resp = await callService({
        Search: { query_text: query, query_image_path: imagePath, tag_filter: tag, limit: 20 }
      });

      if ("SearchResult" in resp) {
        renderSearchResults(resp.SearchResult.matches);
      } else if ("Error" in resp) {
        if (grid) grid.innerHTML = `<p style="color: #ef4444; padding: 10px;">Search failed: ${resp.Error.message}</p>`;
        alert("Search failed: " + resp.Error.message);
      }
    } catch (e: any) {
      if (grid) grid.innerHTML = `<p style="color: #ef4444; padding: 10px;">IPC Search failed: ${e.message || e}</p>`;
      alert("IPC Search failed: " + e);
    }
  });

  // Manage tags form submission
  const tagForm = document.getElementById("tag-form");
  const tagImgId = document.getElementById("tag-image-id") as HTMLInputElement;
  const tagNameInput = document.getElementById("tag-name-input") as HTMLInputElement;

  tagForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!tagImgId || !tagNameInput) return;

    const imgId = parseInt(tagImgId.value);
    const tagName = tagNameInput.value.trim();

    try {
      const resp = await callService({
        AddTag: { image_id: imgId, tag: tagName, category: "user" }
      });

      if ("Success" in resp) {
        tagNameInput.value = "";
        tagNameInput.dispatchEvent(new Event('change', { bubbles: true }));
        // Refresh tags in modal
        await refreshModalTags(imgId);
        refreshDashboard();
      } else if ("Error" in resp) {
        alert("Failed to add tag: " + resp.Error.message);
      }
    } catch (e) {
      alert("IPC Tag failed: " + e);
    }
  });

  // Plugin Form
  const pluginForm = document.getElementById("plugin-form");
  const pluginPath = document.getElementById("plugin-path-input") as HTMLInputElement;
  const pluginResult = document.getElementById("plugin-validation-result");

  pluginForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!pluginPath || !pluginResult) return;

    pluginResult.innerHTML = "<p style='color: #fbbf24;'>Validating plugin signatures...</p>";

    try {
      const resp = await callService({
        ValidatePlugin: { manifest_path: pluginPath.value }
      });

      if ("ValidationResult" in resp) {
        const { name, version, valid, error } = resp.ValidationResult;
        if (valid) {
          pluginResult.innerHTML = `
            <div style="background-color: #dff6dd; border: 1px solid #107c41; padding: 8px; margin-top: 8px;">
               <h3 style="color: #107c41; margin-bottom: 4px; font-weight: bold;">Validation Success!</h3>
              <p><strong>Name:</strong> ${name}</p>
              <p><strong>Version:</strong> ${version}</p>
              <p style="color: #555555; font-size: 11px; margin-top: 4px;">Signature validated locally with master key.</p>
            </div>
          `;
        } else {
          pluginResult.innerHTML = `
            <div style="background-color: #fde7e9; border: 1px solid #a80000; padding: 8px; margin-top: 8px;">
              <h3 style="color: #a80000; margin-bottom: 4px; font-weight: bold;">Validation Failed</h3>
              <p style="color: #a80000;">${error}</p>
            </div>
          `;
        }
      }
    } catch (e) {
      pluginResult.innerHTML = `<p style="color: #f87171;">IPC error: ${e}</p>`;
    }
  });

  // Auto-tag modal button
  document.getElementById("auto-tag-modal-btn")?.addEventListener("click", handleModalAutoTag);
}

// Refresh Image Grids
async function refreshDashboard() {
  const featuredContainer = document.getElementById("featured-day-content");

  try {
    // 1. Get total image count via status
    const statusResp = await callService({ GetStatus: null });
    if (!("StatusResult" in statusResp)) {
      throw new Error("Could not reach service");
    }
    const { image_count } = statusResp.StatusResult;

    if (image_count === 0) {
      if (featuredContainer) {
        featuredContainer.innerHTML = `
          <div style="text-align: center; color: #777; padding: 20px;">
            <p style="font-size: 13px;">No images imported yet.</p>
            <p style="margin-top: 4px; font-size: 11px;">Use <strong>Import</strong> to add images to your library.</p>
          </div>`;
      }
      renderImages([], "latest-imports-grid");
      return;
    }

    // 2. Compute stable daily-seeded offset
    const today = new Date();
    const daySeed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
    const featuredOffset = daySeed % image_count;

    // 3. Fetch featured and latest in parallel
    const [featuredResp, latestResp] = await Promise.all([
      callService({ ListImages: { limit: 6, offset: featuredOffset } }),
      callService({ ListImages: { limit: 8, offset: 0 } }),
    ]);

    if ("ListResult" in featuredResp && featuredResp.ListResult.images.length > 0) {
      renderFeaturedDay(featuredResp.ListResult.images[0]);
    }
    if ("ListResult" in latestResp) {
      renderImages(latestResp.ListResult.images, "latest-imports-grid");
    }

  } catch (e: any) {
    console.error("Failed to refresh dashboard: ", e);
    if (featuredContainer) {
      featuredContainer.innerHTML = `
        <div style="text-align: center; color: #555555; padding: 20px;">
          <p style="font-weight: bold; color: #a80000; font-size: 13px;">Service Offline</p>
          <p style="margin-top: 6px;">Start the backend service to load featured content.</p>
        </div>
      `;
    }
  }
}

function renderFeaturedDay(featured: ImageDetails) {
  const container = document.getElementById("featured-day-content");
  if (!container) return;

  const srcUrl = convertFileSrc(featured.current_filepath);
  const badgeClass = featured.vector_state === "ready" ? "badge-ready" : "badge-pending";

  container.innerHTML = `
    <div class="featured-layout">
      <div class="image-card featured-card">
        <div class="image-preview featured-preview">
          <img src="${srcUrl}" alt="Featured Image" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';" />
          <span style="display: none;"><i class="bi bi-image"></i></span>
          <div class="vector-badge ${badgeClass}">${featured.vector_state}</div>
          <div class="featured-badge-overlay"><i class="bi bi-stars"></i> Feature of the Day</div>
        </div>
        <div style="display: flex; gap: 4px; margin-top: 4px;">
          <button class="win-button" style="font-size: 11px; flex: 1;" onclick="window.openTags(${featured.id}, '${featured.current_filepath.replace(/\\/g, '\\\\')}')">
            <i class="bi bi-tag"></i> Tags
          </button>
          <button class="win-button" style="font-size: 11px; flex: 1;" id="featured-search-btn">
            <i class="bi bi-search"></i> Similar
          </button>
        </div>
      </div>
      <div class="featured-details">
        <div class="featured-filename" title="${featured.current_filepath}">${featured.current_filepath.split(/[\\/]/).pop()}</div>
        <div class="image-path" title="${featured.current_filepath}">${featured.current_filepath}</div>
        <div class="tag-list" style="margin-top: 6px;">
          ${featured.tags.length > 0 ? featured.tags.map(t => getTagPillHtml(t)).join("") : '<span style="color: #999; font-style: italic; font-size: 11px;">No tags</span>'}
        </div>
      </div>
    </div>
  `;

  const previewDiv = container.querySelector(".featured-preview");
  if (previewDiv) {
    previewDiv.addEventListener("click", () => {
      if ((window as any).getImageClickAction?.() === "external") {
        (window as any).__TAURI__.core.invoke("open_file_externally", { path: featured.current_filepath }).catch((err: any) => {
          console.error("Failed to open file externally:", err);
        });
      } else {
        openImageViewer(featured.current_filepath);
      }
    });
  }

  // Constrain tag-list height to match the image card
  const tagList = container.querySelector(".featured-details .tag-list") as HTMLElement;
  const card = container.querySelector(".featured-card") as HTMLElement;
  if (tagList && card) {
    const applyTagListHeight = () => {
      const filename = container.querySelector(".featured-filename") as HTMLElement;
      const path = container.querySelector(".image-path") as HTMLElement;
      const fixedHeight = (filename?.offsetHeight || 0) + (path?.offsetHeight || 0) + 6; // margins/gaps
      tagList.style.maxHeight = Math.max(0, card.offsetHeight - fixedHeight) + "px";
      tagList.style.overflowY = "auto";
    };
    // After the image loads, recalculate
    if (previewDiv) {
      const img = previewDiv.querySelector("img");
      if (img && !img.complete) {
        img.addEventListener("load", applyTagListHeight, { once: true });
      }
    }
    applyTagListHeight();
  }

  document.getElementById("featured-search-btn")?.addEventListener("click", async () => {
    (window as any).findSimilar(featured.current_filepath);
  });
}

async function refreshTagStats() {
  const container = document.getElementById("tagstats-content");
  if (!container) return;
  container.innerHTML = '<p style="color: #666; font-style: italic;">Loading tag statistics...</p>';

  try {
    const resp = await callService({ GetTagStatistics: null });
    if (!("TagStatisticsResult" in resp)) {
      container.innerHTML = '<p style="color: #a80000;">Failed to load tag statistics.</p>';
      return;
    }

    const tags = resp.TagStatisticsResult.tags;
    if (tags.length === 0) {
      container.innerHTML = '<p style="color: #999; font-style: italic;">No tags found.</p>';
      return;
    }

    const categories = ["character", "copyright", "meta", "user"];
    const grouped: Record<string, TagStat[]> = {};
    for (const cat of categories) grouped[cat] = [];
    grouped["other"] = [];

    for (const t of tags) {
      const key = categories.includes(t.category) ? t.category : "other";
      grouped[key].push(t);
    }

    const categoryLabels: Record<string, { label: string; color: string }> = {
      character: { label: "Character", color: "#0c5460" },
      copyright: { label: "Copyright", color: "#511c74" },
      meta: { label: "Meta", color: "#383d41" },
      user: { label: "User", color: "#856404" },
      other: { label: "Other", color: "#4a4a4a" },
    };

    let html = "";
    let catIdx = 0;
    for (const [cat, catTags] of Object.entries(grouped)) {
      if (catTags.length === 0) continue;
      const info = categoryLabels[cat] || categoryLabels.other;
      const maxCount = Math.max(...catTags.map(t => t.count));
      html += `<div class="tagstats-category">
        <div class="tagstats-category-header">
          <div class="tagstats-category-title" style="color: ${info.color};">${info.label} <span class="tagstats-count">(${catTags.length})</span></div>
          <button class="win-button tagstats-chart-toggle" data-chart="chart-${catIdx}" style="font-size: 10px;"><i class="bi bi-bar-chart"></i> Chart</button>
        </div>
        <div class="tagstats-chart" id="chart-${catIdx}" style="display: none;">`;
      for (const t of catTags) {
        const pct = maxCount > 0 ? (t.count / maxCount * 100) : 0;
        html += `<div class="tagstats-bar-row" data-tag="${t.tag}">
          <span class="tagstats-bar-label" title="${t.tag}">${t.tag.replace(/_/g, '_\u200B')}</span>
          <div class="tagstats-bar-track">
            <div class="tagstats-bar-fill" style="width: ${pct}%; background: ${info.color};"></div>
          </div>
          <span class="tagstats-bar-count">${t.count}</span>
        </div>`;
      }
      html += `</div><div class="tagstats-list">`;
      for (const t of catTags) {
        html += `<span class="tag-pill tagstats-pill tag-${cat || 'tag-rank-3'}" data-tag="${t.tag}" title="${t.tag} (${t.count} images)">${t.tag.replace(/_/g, '_\u200B')} <span class="tagstats-badge">${t.count}</span></span>`;
      }
      html += `</div></div>`;
      catIdx++;
    }
    container.innerHTML = html;

    // Toggle chart visibility
    container.querySelectorAll<HTMLElement>(".tagstats-chart-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const chartId = btn.getAttribute("data-chart");
        const chart = document.getElementById(chartId || "");
        if (chart) {
          const visible = chart.style.display !== "none";
          chart.style.display = visible ? "none" : "block";
          btn.innerHTML = visible
            ? '<i class="bi bi-bar-chart"></i> Chart'
            : '<i class="bi bi-list"></i> Pills';
        }
      });
    });

    // Click a bar row → search for images with that tag
    container.querySelectorAll<HTMLElement>(".tagstats-bar-row").forEach((row) => {
      row.addEventListener("click", () => {
        const tagName = row.getAttribute("data-tag");
        if (tagName) switchToSearchWithTag(tagName);
      });
    });

    // Click a tag pill → search for images with that tag
    container.querySelectorAll<HTMLElement>(".tagstats-pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        const tagName = pill.getAttribute("data-tag");
        if (tagName) switchToSearchWithTag(tagName);
      });
    });
  } catch (e: any) {
    container.innerHTML = `<p style="color: #a80000;">Error: ${e.message || e}</p>`;
  }
}

function switchToSearchWithTag(tagName: string) {
  // Switch to search view, pre-fill the tag filter, and trigger search
  const navItem = document.querySelector(`.nav-item[data-view="search"]`) as HTMLElement | null;
  if (navItem) navItem.click();

  setTimeout(() => {
    const tagInput = document.getElementById("search-tag-input") as HTMLInputElement;
    if (tagInput) {
      tagInput.value = tagName;
      tagInput.dispatchEvent(new Event("change"));
    }
    // Trigger search immediately
    document.getElementById("search-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }, 100);
}

let galleryPage = 0;
const IMAGES_PER_PAGE = 12;

async function refreshGallery() {
  try {
    const resp = await callService({ ListImages: { limit: IMAGES_PER_PAGE, offset: galleryPage * IMAGES_PER_PAGE } });
    if ("ListResult" in resp) {
      const images = resp.ListResult.images;
      renderImages(images, "gallery-grid");
      
      const indicator = document.getElementById("gallery-page-indicator");
      if (indicator) {
        indicator.textContent = `Page ${galleryPage + 1}`;
      }
      
      const prevBtn = document.getElementById("gallery-prev-btn") as HTMLButtonElement;
      if (prevBtn) {
        prevBtn.disabled = galleryPage === 0;
      }
      
      const nextBtn = document.getElementById("gallery-next-btn") as HTMLButtonElement;
      if (nextBtn) {
        nextBtn.disabled = images.length < IMAGES_PER_PAGE;
      }
    }
  } catch (e) {
    console.error("Failed to refresh gallery: ", e);
  }
}

// Track double-click confirmation states for auto-tag overwrite
let overwriteTargetId: number | null = null;

// Open tag modal
async function openTagModal(imgId: number, path: string) {
  const modal = document.getElementById("add-tag-modal");
  const idInput = document.getElementById("tag-image-id") as HTMLInputElement;
  const pathPreview = document.getElementById("tag-image-path-preview");
  const statusArea = document.getElementById("auto-tag-modal-status");
  const autoTagBtn = document.getElementById("auto-tag-modal-btn");

  if (idInput) idInput.value = imgId.toString();
  if (pathPreview) pathPreview.textContent = path;
  if (statusArea) statusArea.textContent = ""; 
  if (autoTagBtn) {
    autoTagBtn.innerHTML = '<i class="bi bi-stars"></i> Auto-Tag';
    autoTagBtn.style.backgroundColor = "";
  }
  overwriteTargetId = null; // Reset overwrite state

  await refreshModalTags(imgId);
  modal?.classList.add("active");
}

// Helper to generate a styled tag pill HTML based on category
function getTagPillHtml(t: TagSummary, isDeletable = false, imageId = 0): string {
  return renderTagPill(t, { isDeletable, imageId });
}

async function refreshModalTags(imgId: number) {
  const container = document.getElementById("modal-tag-list");
  if (!container) return;
  container.innerHTML = "";

  try {
    const resp = await callService({ GetImage: { image_id: imgId } });
    if ("ImageResult" in resp) {
      const img = resp.ImageResult.image;
      img.tags.forEach((tag) => {
        const pillHtml = getTagPillHtml(tag, true, imgId);
        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = pillHtml;
        const pillNode = tempDiv.firstChild;
        if (pillNode) {
          container.appendChild(pillNode);
        }
      });
    }
  } catch (e) {
    console.error("Failed to load modal tags: ", e);
  }
}

// Renderers
function renderImages(images: ImageDetails[], gridId: string) {
  const grid = document.getElementById(gridId);
  if (!grid) return;
  grid.innerHTML = "";

  if (images.length === 0) {
    grid.innerHTML = "<p style='color: #64748b; font-style: italic;'>No images imported yet.</p>";
    return;
  }

  images.forEach((img) => {
    const card = document.createElement("div");
    card.className = "image-card";

    const badgeClass = img.vector_state === "ready" ? "badge-ready" : "badge-pending";
    const srcUrl = convertFileSrc(img.current_filepath);

    const displayTags = img.tags.slice(0, 10);
    const extraCount = img.tags.length - 10;
    const tagHtml = displayTags.map(t => getTagPillHtml(t)).join("") +
                    (extraCount > 0 ? `<span class="tag-pill" style="background-color: #f0f0f0; color: #555555; font-style: italic;">+${extraCount} more</span>` : "");

    card.innerHTML = `
      <div class="image-preview">
        <img src="${srcUrl}" alt="Image Preview" style="width: 100%; height: 100%; object-fit: cover;" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';" />
        <span style="display: none;"><i class="bi bi-image"></i></span>
        <div class="vector-badge ${badgeClass}">${img.vector_state}</div>
      </div>
      <div class="image-info">
        <div class="image-path" title="${img.current_filepath}">${img.current_filepath}</div>
        <div class="tag-list">
          ${tagHtml}
        </div>
        <div style="display: flex; gap: 4px; margin-top: auto; width: 100%;">
          <button class="win-button" style="font-size: 11px; flex: 1;" onclick="window.openTags(${img.id}, '${img.current_filepath.replace(/\\/g, '\\\\')}')">
            <i class="bi bi-tag"></i> Tags
          </button>
          <button class="win-button" style="font-size: 11px; flex: 1;" onclick="window.findSimilar('${img.current_filepath.replace(/\\/g, '\\\\')}')">
            <i class="bi bi-search"></i> Similar
          </button>
        </div>
      </div>
    `;

    const previewDiv = card.querySelector(".image-preview");
    if (previewDiv) {
      previewDiv.addEventListener("click", () => {
        if (getImageClickAction() === "external") {
          invoke("open_file_externally", { path: img.current_filepath }).catch((err) => {
            console.error("Failed to open file externally:", err);
          });
        } else {
          openImageViewer(img.current_filepath);
        }
      });
    }

    grid.appendChild(card);
  });
}

// Click listener to trigger info details alert from card
function setupTaggerCard() {
  document.getElementById("tagger-stat-card")?.addEventListener("click", async () => {
    try {
      const resp = await callService({ GetTaggerStatus: null });
      if ("TaggerStatusResult" in resp) {
        const { loaded, model_path, total_tags } = resp.TaggerStatusResult;
        alert(
          `Camie Tagger v2 Status:\n\n` +
          `- Model Loaded: ${loaded ? "Yes (active in RAM)" : "No (ready to load)"}\n` +
          `- Model File: ${model_path}\n` +
          `- Supported Tags: ${total_tags > 0 ? total_tags : "N/A"}`
        );
      }
    } catch (e: any) {
      alert("Failed to query tagger status: " + e.message);
    }
  });
}

// Action for Modal Auto-Tag
async function handleModalAutoTag() {
  const idInput = document.getElementById("tag-image-id") as HTMLInputElement;
  const thresholdSelect = document.getElementById("tagger-threshold-select") as HTMLSelectElement;
  const statusArea = document.getElementById("auto-tag-modal-status");
  const autoTagBtn = document.getElementById("auto-tag-modal-btn");

  if (!idInput || !statusArea || !thresholdSelect || !autoTagBtn) return;

  const imageId = parseInt(idInput.value);
  const threshold = parseFloat(thresholdSelect.value);

  // Check if we are in confirm overwrite phase for this specific image
  const force = (overwriteTargetId === imageId);

  statusArea.textContent = "AI Running inference (lazy loading model if first run)...";
  statusArea.style.color = "#fbbf24";

  try {
    const resp = await callService({ TagImage: { image_id: imageId, threshold, force } });
    if ("TagImageResult" in resp) {
      const { tags_applied, skipped } = resp.TagImageResult;
      if (skipped) {
        // AI tags already exist, trigger overwrite confirmation flow
        overwriteTargetId = imageId;
        statusArea.textContent = "Tags already exist. Click Auto-Tag again to overwrite.";
        statusArea.style.color = "#b7791f";
        autoTagBtn.innerHTML = '<i class="bi bi-exclamation-triangle"></i> Confirm Overwrite?';
        autoTagBtn.style.backgroundColor = "#ffeb3b";
      } else {
        // Success
        statusArea.textContent = `Applied ${tags_applied} tags successfully!`;
        statusArea.style.color = "#10b981";
        autoTagBtn.innerHTML = '<i class="bi bi-stars"></i> Auto-Tag';
        autoTagBtn.style.backgroundColor = "";
        overwriteTargetId = null; // Reset

        // Refresh active list in modal
        await refreshModalTags(imageId);
        // Refresh grids in background
        refreshDashboard();
        if (document.getElementById("view-gallery")?.classList.contains("active")) {
          refreshGallery();
        }
      }
    } else if ("Error" in resp) {
      statusArea.textContent = `Failed: ${resp.Error.message}`;
      statusArea.style.color = "#ef4444";
      autoTagBtn.innerHTML = '<i class="bi bi-stars"></i> Auto-Tag';
      autoTagBtn.style.backgroundColor = "";
      overwriteTargetId = null;
    }
  } catch (e: any) {
    statusArea.textContent = `Error: ${e.message || e}`;
    statusArea.style.color = "#ef4444";
    autoTagBtn.innerHTML = '<i class="bi bi-stars"></i> Auto-Tag';
    autoTagBtn.style.backgroundColor = "";
    overwriteTargetId = null;
  }
}

function renderSearchResults(matches: SearchMatch[]) {
  const grid = document.getElementById("search-results-grid");
  if (!grid) return;
  grid.innerHTML = "";

  if (matches.length === 0) {
    grid.innerHTML = "<p style='color: #64748b; font-style: italic;'>No matching results found.</p>";
    return;
  }

  matches.forEach((m) => {
    const card = document.createElement("div");
    card.className = "image-card";
    const srcUrl = convertFileSrc(m.filepath);

    const displayTags = m.tags.slice(0, 10);
    const extraCount = m.tags.length - 10;
    const tagHtml = displayTags.map(t => getTagPillHtml(t)).join("") +
                    (extraCount > 0 ? `<span class="tag-pill" style="background-color: #f0f0f0; color: #555555; font-style: italic;">+${extraCount} more</span>` : "");

    const badgeBg = m.match_type === "exact"
      ? "#dff6dd" // Green
      : m.match_type === "perceptual"
      ? "#deecf9" // Light Blue
      : "#f3f2f1"; // Gray
    const badgeColor = m.match_type === "exact"
      ? "#107c41"
      : m.match_type === "perceptual"
      ? "#005a9e"
      : "#323130";
    const badgeBorder = m.match_type === "exact"
      ? "#107c41"
      : m.match_type === "perceptual"
      ? "#005a9e"
      : "#8a8886";

    const scoreBadgeText = m.match_type === "exact"
      ? "Exact Match"
      : m.match_type === "perceptual"
      ? `Perceptual (d=${m.hamming_distance})`
      : `Score: ${m.score.toFixed(4)}`;

    card.innerHTML = `
      <div class="image-preview">
        <img src="${srcUrl}" alt="Image Preview" style="width: 100%; height: 100%; object-fit: cover;" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';" />
        <span style="display: none;"><i class="bi bi-image"></i></span>
        <div class="vector-badge" style="background-color: ${badgeBg}; border: 1px solid ${badgeBorder}; color: ${badgeColor};">${scoreBadgeText}</div>
      </div>
      <div class="image-info">
        <div class="image-path" title="${m.filepath}">${m.filepath}</div>
        <div class="tag-list">
          ${tagHtml}
        </div>
        <div style="display: flex; gap: 4px; margin-top: auto; width: 100%;">
          <button class="win-button" style="font-size: 11px; flex: 1;" onclick="window.openTags(${m.id}, '${m.filepath.replace(/\\/g, '\\\\')}')">
            <i class="bi bi-tag"></i> Tags
          </button>
          <button class="win-button" style="font-size: 11px; flex: 1;" onclick="window.findSimilar('${m.filepath.replace(/\\/g, '\\\\')}')">
            <i class="bi bi-search"></i> Similar
          </button>
        </div>
      </div>
    `;

    const previewDiv = card.querySelector(".image-preview");
    if (previewDiv) {
      previewDiv.addEventListener("click", () => {
        if (getImageClickAction() === "external") {
          invoke("open_file_externally", { path: m.filepath }).catch((err) => {
            console.error("Failed to open file externally:", err);
          });
        } else {
          openImageViewer(m.filepath);
        }
      });
    }

    grid.appendChild(card);
  });
}

// Expose tag management globally for inline onclick handlers
(window as any).openTags = (imgId: number, path: string) => {
  openTagModal(imgId, path);
};

(window as any).findSimilar = (path: string) => {
  const searchNavItem = document.querySelector('.nav-item[data-view="search"]') as HTMLElement;
  if (searchNavItem) {
    searchNavItem.click();
    
    const queryInput = document.getElementById("search-text-input") as HTMLInputElement;
    const tagInput = document.getElementById("search-tag-input") as HTMLInputElement;
    const imageInput = document.getElementById("search-image-path-input") as HTMLInputElement;
    
    if (queryInput) { queryInput.value = ""; queryInput.dispatchEvent(new Event('change')); }
    if (tagInput) { tagInput.value = ""; tagInput.dispatchEvent(new Event('change')); }
    if (imageInput) {
      imageInput.value = path;
      imageInput.dispatchEvent(new Event("change"));
      // Wait for DOM updates/view switch, then submit form
      setTimeout(() => {
        document.getElementById("search-form")?.dispatchEvent(new Event("submit"));
      }, 50);
    }
  }
};

(window as any).removeTag = async (imgId: number, tagName: string) => {
  if (!confirm(`Are you sure you want to remove the tag "${tagName}"?`)) return;
  try {
    const resp = await callService({ RemoveTag: { image_id: imgId, tag: tagName } });
    if ("Success" in resp) {
      await refreshModalTags(imgId);
      refreshDashboard();
      if (document.getElementById("view-gallery")?.classList.contains("active")) {
        refreshGallery();
      }
    } else if ("Error" in resp) {
      alert("Failed to remove tag: " + resp.Error.message);
    }
  } catch (e: any) {
    alert("Error calling tag removal: " + e.message);
  }
};

// --- ANSI to HTML renderer ---
const ANSI_COLORS: Record<number, string> = {
  30: "#000000", 31: "#cd3131", 32: "#0dbc79", 33: "#e5e510",
  34: "#2472c8", 35: "#bc3fbc", 36: "#11a8cd", 37: "#e5e5e5",
  90: "#666666", 91: "#f14c4c", 92: "#23d18b", 93: "#f5f543",
  94: "#3b8eea", 95: "#d670d6", 96: "#29b8db", 97: "#ffffff",
};

function ansiToHtml(text: string): string {
  // Escape HTML special chars first
  let result = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Parse ANSI escape sequences: ESC[ ... m
  result = result.replace(/\x1b\[([0-9;]*)m/g, (_match, codes) => {
    if (!codes) return "</span>";
    const parts = codes.split(";");
    let out = "";
    for (const p of parts) {
      const code = parseInt(p, 10);
      if (code === 0) {
        out += "</span>";
      } else if (code === 1) {
        out += '<span style="font-weight:bold">';
      } else if (code === 2) {
        out += '<span style="opacity:0.6">';
      } else if (code === 3) {
        out += '<span style="font-style:italic">';
      } else if (code === 4) {
        out += '<span style="text-decoration:underline">';
      } else if (ANSI_COLORS[code]) {
        out += `<span style="color:${ANSI_COLORS[code]}">`;
      }
    }
    return out;
  });

  // Also handle raw escape bytes that may appear in log files
  result = result.replace(/\u001b\[([0-9;]*)m/g, (_match, codes) => {
    if (!codes) return "</span>";
    const parts = codes.split(";");
    let out = "";
    for (const p of parts) {
      const code = parseInt(p, 10);
      if (code === 0) {
        out += "</span>";
      } else if (code === 1) {
        out += '<span style="font-weight:bold">';
      } else if (code === 2) {
        out += '<span style="opacity:0.6">';
      } else if (code === 3) {
        out += '<span style="font-style:italic">';
      } else if (code === 4) {
        out += '<span style="text-decoration:underline">';
      } else if (ANSI_COLORS[code]) {
        out += `<span style="color:${ANSI_COLORS[code]}">`;
      }
    }
    return out;
  });

  // Close any unclosed spans
  const openCount = (result.match(/<span/g) || []).length;
  const closeCount = (result.match(/<\/span>/g) || []).length;
  for (let i = 0; i < openCount - closeCount; i++) {
    result += "</span>";
  }

  return result;
}

// --- Log Tab State ---
let currentLogTab: "dashboard" | "service" = "dashboard";

function setupLogTabs() {
  const dashTab = document.getElementById("log-tab-dashboard");
  const svcTab = document.getElementById("log-tab-service");

  dashTab?.addEventListener("click", () => {
    currentLogTab = "dashboard";
    dashTab.classList.add("active");
    svcTab?.classList.remove("active");
    refreshLogs();
  });

  svcTab?.addEventListener("click", () => {
    currentLogTab = "service";
    svcTab.classList.add("active");
    dashTab?.classList.remove("active");
    refreshLogs();
  });
}

async function refreshLogs() {
  const logDiv = document.getElementById("log-content");
  if (!logDiv) return;

  try {
    const cmd = currentLogTab === "service" ? "read_service_logs" : "read_logs";
    const logs = await invoke(cmd) as string;
    logDiv.innerHTML = ansiToHtml(logs);
    logDiv.scrollTop = logDiv.scrollHeight;
  } catch (e) {
    logDiv.textContent = "Failed to load logs: " + e;
  }
}

async function clearLogsData() {
  const logDiv = document.getElementById("log-content");
  try {
    const cmd = currentLogTab === "service" ? "clear_service_logs" : "clear_logs";
    await invoke(cmd);
    if (logDiv) logDiv.innerHTML = "";
  } catch (e) {
    alert("Failed to clear logs: " + e);
  }
}

function setupBenchmark() {
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
      const resp = await callService({ RunBenchmark: null });
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

        // Render CLIP Results
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

        // Render Tagger Results
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

        // Render GPU provider support status
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

function setupSettings() {
  const clipSelect = document.getElementById("settings-clip-device") as HTMLSelectElement;
  const taggerSelect = document.getElementById("settings-tagger-device") as HTMLSelectElement;
  const idleSelect = document.getElementById("settings-idle-timeout") as HTMLSelectElement;
  const embeddingSelect = document.getElementById("settings-embedding-model") as HTMLSelectElement;
  const saveBtn = document.getElementById("save-settings-btn");
  const reindexBtn = document.getElementById("reindex-vectors-btn");
  const statusMsg = document.getElementById("settings-status-msg");

  let reindexPollInterval: number | null = null;

  function updateReindexProgress(
    _image_count: number,
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
      
      // Preprocessing Progress (anything already indexed or currently in preprocessing counts as preprocessed)
      const preprocessed = vector_count + preprocessing_jobs;
      const prePercent = Math.round((preprocessed / total) * 100);
      preBar.style.width = prePercent + "%";
      preText.textContent = `Preprocessing progress: ${preprocessed}/${total} (${prePercent}%)`;

      // Indexing Progress
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

  function startReindexPolling() {
    if (reindexPollInterval) return;
    const check = async () => {
      try {
        const resp = await callService({ GetStatus: null });
        if ("StatusResult" in resp) {
          const { image_count, vector_count, pending_jobs, preprocessing_jobs } = resp.StatusResult;
          updateReindexProgress(image_count, vector_count, pending_jobs, preprocessing_jobs);
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

  function updateBenchmarkModelHeader(model: string | null) {
    const titleEl = document.getElementById("benchmark-clip-title");
    if (!titleEl) return;
    if (model === "mobileclip-s2") {
      titleEl.textContent = "MobileCLIP-S2 Model (256x256)";
    } else {
      titleEl.textContent = "CLIP ViT-B/32 Model (224x224)";
    }
  }

  // Image click action setting (localStorage)
  const imageClickSelect = document.getElementById("settings-image-click-action") as HTMLSelectElement;
  if (imageClickSelect) {
    imageClickSelect.value = getImageClickAction();
    imageClickSelect.addEventListener("change", () => {
      setImageClickAction(imageClickSelect.value);
    });
  }

  // Load current settings
  async function loadSettings() {
    try {
      const resp = await callService({ GetSettings: null });
      if ("SettingsResult" in resp) {
        if (clipSelect) clipSelect.value = resp.SettingsResult.clip_device;
        if (taggerSelect) taggerSelect.value = resp.SettingsResult.tagger_device;
        if (idleSelect) idleSelect.value = resp.SettingsResult.idle_timeout_secs.toString();
        if (embeddingSelect) {
          embeddingSelect.value = resp.SettingsResult.embedding_model;
          updateBenchmarkModelHeader(resp.SettingsResult.embedding_model);
        }
      }

      // Check status to see if reindexing is active
      const statusResp = await callService({ GetStatus: null });
      if ("StatusResult" in statusResp) {
        const { image_count, vector_count, pending_jobs, preprocessing_jobs } = statusResp.StatusResult;
        updateReindexProgress(image_count, vector_count, pending_jobs, preprocessing_jobs);
        if (pending_jobs > 0 || preprocessing_jobs > 0) {
          startReindexPolling();
        }
      }
    } catch (e: any) {
      if (statusMsg) {
        statusMsg.textContent = "Failed to load settings: " + (e.message || e);
        statusMsg.style.color = "#ef4444";
      }
    }
  }

  // Save settings
  saveBtn?.addEventListener("click", async () => {
    if (!clipSelect || !taggerSelect || !idleSelect || !statusMsg) return;

    statusMsg.textContent = "Saving...";
    statusMsg.style.color = "#fbbf24";

    try {
      const resp = await callService({
        UpdateSettings: {
          clip_device: clipSelect.value,
          tagger_device: taggerSelect.value,
          idle_timeout_secs: parseInt(idleSelect.value, 10),
          embedding_model: embeddingSelect ? embeddingSelect.value : null,
        }
      });

      if ("SettingsResult" in resp) {
        statusMsg.textContent = "Settings saved and applied successfully. If model was changed, reindexing has started.";
        statusMsg.style.color = "#10b981";
        if (embeddingSelect) {
          updateBenchmarkModelHeader(embeddingSelect.value);
        }
        startReindexPolling();
      } else if ("Error" in resp) {
        statusMsg.textContent = "Failed: " + resp.Error.message;
        statusMsg.style.color = "#ef4444";
      }
    } catch (e: any) {
      statusMsg.textContent = "Error: " + (e.message || e);
      statusMsg.style.color = "#ef4444";
    }
  });

  // Reindex vectors
  reindexBtn?.addEventListener("click", async () => {
    if (!statusMsg) return;
    if (!confirm("Are you sure you want to reindex all vectors? This will rebuild the vector search index from scratch.")) {
      return;
    }
    statusMsg.textContent = "Reindexing all images...";
    statusMsg.style.color = "#fbbf24";
    try {
      const resp = await callService({ ReindexVectors: null });
      if ("Success" in resp) {
        statusMsg.textContent = "Reindexing triggered successfully. The background worker is rebuilding the index.";
        statusMsg.style.color = "#10b981";
        startReindexPolling();
      } else if ("Error" in resp) {
        statusMsg.textContent = "Reindex failed: " + resp.Error.message;
        statusMsg.style.color = "#ef4444";
      }
    } catch (e: any) {
      statusMsg.textContent = "Error: " + (e.message || e);
      statusMsg.style.color = "#ef4444";
    }
  });

  // Also load settings when the settings view becomes visible
  const settingsNav = document.querySelector('.nav-item[data-view="settings"]');
  settingsNav?.addEventListener("click", () => {
    loadSettings();
  });

  // Initial load
  loadSettings();
}

function refreshComponentStylesheet() {
  const container = document.getElementById("components-showcase-container");
  if (!container) return;

  container.innerHTML = componentRegistry.map(comp => {
    const variantsHtml = comp.variants.map(v => `
      <div style="margin-bottom: 14px;">
        <div style="font-size: 11px; font-weight: bold; color: #444; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;">${v.name}</div>
        <div style="padding: 10px; border: 1px dashed var(--sys-border-dark); background-color: var(--sys-control-bg); display: block; width: 100%;">
          ${v.render()}
        </div>
      </div>
    `).join("");

    return renderGroupBox(comp.name, `
      <p style="font-size: 11px; color: #555; margin-bottom: 16px; font-style: italic;">${comp.description}</p>
      <div style="display: flex; flex-direction: column; gap: 8px;">
        ${variantsHtml}
      </div>
    `);
  }).join("");

  // Setup clear buttons for the dynamically rendered showcase inputs
  setupInputClearButtons();
}
