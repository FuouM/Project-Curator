import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import "bootstrap-icons/font/bootstrap-icons.css";

function logJS(msg: string) {
  console.log(msg);
  invoke("log_frontend", { message: msg }).catch(() => {});
}

// Define Request/Response payloads to match curator-core::ipc
type RequestPayload =
  | { Ping: null }
  | { GetStatus: null }
  | { ImportImage: { path: string } }
  | { AddTag: { image_id: number; tag: string; category: string } }
  | { RemoveTag: { image_id: number; tag_id: number } }
  | { Search: { query_text: string | null; tag_filter: string | null; limit: number } }
  | { ListImages: { limit: number; offset: number } }
  | { GetImage: { image_id: number } }
  | { ValidatePlugin: { manifest_path: string } };

interface SearchMatch {
  id: number;
  filepath: string;
  score: number;
  tags: string[];
}

interface ImageDetails {
  id: number;
  sha256: string;
  current_filepath: string;
  mtime: number;
  created_at: string;
  tags: string[];
  vector_state: string;
}

type ResponsePayload =
  | { Pong: null }
  | { Success: null }
  | { Error: { message: string } }
  | { ImportResult: { image_id: number; sha256: string } }
  | { SearchResult: { matches: SearchMatch[] } }
  | { StatusResult: { image_count: number; vector_count: number; pending_jobs: number } }
  | { ImageResult: { image: ImageDetails } }
  | { ListResult: { images: ImageDetails[] } }
  | { ValidationResult: { name: string; version: string; valid: boolean; error: string | null } };

// Helpers for invoking the service through Rust Named Pipe bridge
async function callService(request: RequestPayload): Promise<ResponsePayload> {
  // Translate RequestPayload enum to Rust Serde structure representation
  // Rust expects Request::Ping, Request::ImportImage { path: ... }, etc.
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

    throw new Error("Unknown response format: " + respStr);
  } catch (err: any) {
    logJS("callService exception: " + (err.message || err));
    throw err;
  }
}



function init() {
  setupNavigation();
  setupForms();
  startStatusPolling();
  refreshDashboard();
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
    logs: { title: "System Diagnostic Logs", sub: "View active traces and stderr/stdout logs from the local engine." }
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
        const { image_count, vector_count, pending_jobs } = resp.StatusResult;
        const imgEl = document.getElementById("stat-images");
        const vecEl = document.getElementById("stat-vectors");
        const pendEl = document.getElementById("stat-pending");
        if (imgEl) imgEl.textContent = image_count.toString();
        if (vecEl) vecEl.textContent = vector_count.toString();
        if (pendEl) pendEl.textContent = pending_jobs.toString();
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

  searchForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!queryInput || !tagInput) return;

    try {
      const query = queryInput.value.trim() || null;
      const tag = tagInput.value.trim() || null;
      
      const resp = await callService({
        Search: { query_text: query, tag_filter: tag, limit: 20 }
      });

      if ("SearchResult" in resp) {
        renderSearchResults(resp.SearchResult.matches);
      } else if ("Error" in resp) {
        alert("Search failed: " + resp.Error.message);
      }
    } catch (e) {
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
}

// Refresh Image Grids
async function refreshDashboard() {
  const featuredContainer = document.getElementById("featured-day-content");

  try {
    // 1. Get total image count via status (already polled — lightweight)
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

    // 2. Compute a daily-seeded offset so featured changes each day but is stable within a session
    const today = new Date();
    const daySeed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
    const featuredOffset = daySeed % image_count;

    // 3. Fetch only 6 images starting at the daily offset — tiny response
    const featuredResp = await callService({ ListImages: { limit: 6, offset: featuredOffset } });
    if ("ListResult" in featuredResp && featuredResp.ListResult.images.length > 0) {
      renderFeaturedDay(featuredResp.ListResult.images[0]);
    }

    // 4. Load latest imports separately (small batch)
    const latestResp = await callService({ ListImages: { limit: 8, offset: 0 } });
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
  
  container.innerHTML = `
    <div style="display: flex; gap: 16px; align-items: flex-start; height: 100%;">
      <div class="image-preview" style="width: 110px; height: 110px; flex-shrink: 0; position: relative;">
        <img src="${srcUrl}" alt="Featured Image Preview" style="width: 100%; height: 100%; object-fit: cover;" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';" />
        <span style="display: none;"><i class="bi bi-image"></i></span>
      </div>
      <div style="display: flex; flex-direction: column; gap: 8px; flex: 1;">
        <div>
          <span style="font-weight: bold; color: #0078d7; font-size: 13px;"><i class="bi bi-star-fill"></i> Image Selection of the Day</span>
          <div class="image-path" title="${featured.current_filepath}" style="margin-top: 4px; font-size: 11px; height: auto; -webkit-line-clamp: 3; word-break: break-all;">
            ${featured.current_filepath}
          </div>
        </div>
        <div>
          <span style="color: #666666; font-size: 10px;">Assigned Tags:</span>
          <div class="tag-list" style="margin-top: 2px;">
            ${featured.tags.length > 0 ? featured.tags.map(t => `<span class="tag-pill">${t}</span>`).join("") : '<span style="color: #999999; font-style: italic; font-size: 11px;">None</span>'}
          </div>
        </div>
        <div style="margin-top: 8px; display: flex; gap: 8px;">
          <button class="win-button" style="font-size: 11px;" onclick="window.openTags(${featured.id}, '${featured.current_filepath.replace(/\\/g, '\\\\')}')">
            <i class="bi bi-tag"></i> Manage Tags
          </button>
          <button class="win-button" style="font-size: 11px;" id="featured-search-btn">
            <i class="bi bi-search"></i> Find Similar
          </button>
        </div>
      </div>
    </div>
    <div style="background-color: #fff8e1; border: 1px solid #ffe082; padding: 8px; margin-top: 8px; border-radius: 2px; color: #827717; font-size: 11px;">
      <strong>Tip of the Day:</strong> Double click on tag pills in search tags to filter by them, or click "Find Similar" above to run a semantic vector search based on this image's content!
    </div>
  `;

  // Bind the "Find Similar" button to search using the filepath as search query or similar concept
  document.getElementById("featured-search-btn")?.addEventListener("click", async () => {
    // Navigate to Search view
    const searchNavItem = document.querySelector('.nav-item[data-view="search"]') as HTMLElement;
    if (searchNavItem) {
      searchNavItem.click();
      
      // Let's populate the query text input with the filepath or tags of this image to trigger a search
      const queryInput = document.getElementById("search-text-input") as HTMLInputElement;
      if (queryInput) {
        queryInput.value = featured.tags.length > 0 ? featured.tags[0] : "image matching featured characteristics";
        // Submit the search
        document.getElementById("search-form")?.dispatchEvent(new Event("submit"));
      }
    }
  });
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

// Open tag modal
async function openTagModal(imgId: number, path: string) {
  const modal = document.getElementById("add-tag-modal");
  const idInput = document.getElementById("tag-image-id") as HTMLInputElement;
  const pathPreview = document.getElementById("tag-image-path-preview");

  if (idInput) idInput.value = imgId.toString();
  if (pathPreview) pathPreview.textContent = path;

  await refreshModalTags(imgId);
  modal?.classList.add("active");
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
        const pill = document.createElement("span");
        pill.className = "tag-pill";
        // To simplify, let's query the database tags. For deletion, we need tag_id. 
        // In this MVP front-end we can list tags.
        pill.innerHTML = `
          ${tag}
        `;
        container.appendChild(pill);
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
    
    // We map vector state to badge colors
    const badgeClass = img.vector_state === "ready" ? "badge-ready" : "badge-pending";
    const srcUrl = convertFileSrc(img.current_filepath);
    
    // We render actual image and fallback to placeholder icon if error
    card.innerHTML = `
      <div class="image-preview">
        <img src="${srcUrl}" alt="Image Preview" style="width: 100%; height: 100%; object-fit: cover;" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';" />
        <span style="display: none;"><i class="bi bi-image"></i></span>
        <div class="vector-badge ${badgeClass}">${img.vector_state}</div>
      </div>
      <div class="image-info">
        <div class="image-path" title="${img.current_filepath}">${img.current_filepath}</div>
        <div class="tag-list">
          ${img.tags.map(t => `<span class="tag-pill">${t}</span>`).join("")}
        </div>
        <button class="win-button" style="font-size: 11px; margin-top: auto;" onclick="window.openTags(${img.id}, '${img.current_filepath.replace(/\\/g, '\\\\')}')">
          <i class="bi bi-tag"></i> Manage Tags
        </button>
      </div>
    `;
    grid.appendChild(card);
  });
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
    
    card.innerHTML = `
      <div class="image-preview">
        <img src="${srcUrl}" alt="Image Preview" style="width: 100%; height: 100%; object-fit: cover;" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';" />
        <span style="display: none;"><i class="bi bi-image"></i></span>
        <div class="vector-badge badge-ready" style="background-color: #dff6dd; border: 1px solid #107c41; color: #107c41;">Score: ${m.score.toFixed(4)}</div>
      </div>
      <div class="image-info">
        <div class="image-path" title="${m.filepath}">${m.filepath}</div>
        <div class="tag-list">
          ${m.tags.map(t => `<span class="tag-pill">${t}</span>`).join("")}
        </div>
        <button class="win-button" style="font-size: 11px; margin-top: auto;" onclick="window.openTags(${m.id}, '${m.filepath.replace(/\\/g, '\\\\')}')">
          <i class="bi bi-tag"></i> Manage Tags
        </button>
      </div>
    `;
    grid.appendChild(card);
  });
}

// Expose tag management globally for inline onclick handlers
(window as any).openTags = (imgId: number, path: string) => {
  openTagModal(imgId, path);
};

async function refreshLogs() {
  const textarea = document.getElementById("log-textarea") as HTMLTextAreaElement;
  if (!textarea) return;
  
  try {
    const logs = await invoke("read_logs") as string;
    textarea.value = logs;
    textarea.scrollTop = textarea.scrollHeight;
  } catch (e) {
    textarea.value = "Failed to load logs: " + e;
  }
}

async function clearLogsData() {
  const textarea = document.getElementById("log-textarea") as HTMLTextAreaElement;
  try {
    await invoke("clear_logs");
    if (textarea) textarea.value = "";
  } catch (e) {
    alert("Failed to clear logs: " + e);
  }
}
