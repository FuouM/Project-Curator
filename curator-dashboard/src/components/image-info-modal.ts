import { typedCall } from "../ipc";
import { html } from "./_shared";
import { renderTagPill } from "./tag-pill";
import { formatDuration } from "./gallery-card";
import { ImageDetails, CharacterDetection, CharacterIdentity } from "../types";
import { isClassified, nsfwScore } from "../proto-adapters";
import { loadNsfwPrefs } from "../nsfw";
import { showErrorAlert } from "../alert";
import { attachAutocomplete } from "../autocomplete";
import { refreshCharacters } from "../views/characters";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { EmptySchema } from "@bufbuild/protobuf/wkt";
import {
  GetImageRequestSchema,
  ImageResultSchema,
  SetNoteRequestSchema,
} from "../gen/gallery_pb";
import {
  AssignCharacterIdentityRequestSchema,
  CharacterDetectionsResultSchema,
  CharacterIdentitiesListSchema,
  CreateCharacterIdentityRequestSchema,
  DeleteDetectionRequestSchema,
  DetectionCropResultSchema,
  DetectionCropsResultSchema,
  GetDetectionCropRequestSchema,
  GetDetectionCropsRequestSchema,
  IdentifyDetectionRequestSchema,
  IdentifyDetectionResultSchema,
  ImageIdRequestSchema,
} from "../gen/characters_pb";
import {
  CharacterIdentity as PCharacterIdentity,
  DetectionResultSchema,
  StoredDetection as PStoredDetection,
} from "../gen/common_pb";
import {
  hasCachedCrop,
  getCropRevision,
  getCachedCrop,
  setCachedCrop,
  invalidateCropCache,
} from "../crop-cache";

function compareIdentitiesPlaceholderLast(a: { name: string }, b: { name: string }): number {
  const aIsPlaceholder = /^Character \d+$/i.test(a.name.trim());
  const bIsPlaceholder = /^Character \d+$/i.test(b.name.trim());
  if (aIsPlaceholder && !bIsPlaceholder) return 1;
  if (!aIsPlaceholder && bIsPlaceholder) return -1;
  if (aIsPlaceholder && bIsPlaceholder) {
    const an = parseInt(a.name.replace(/\D/g, ""), 10) || 0;
    const bn = parseInt(b.name.replace(/\D/g, ""), 10) || 0;
    return an - bn;
  }
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

export function renderImageInfo(img: ImageDetails, body: HTMLElement) {
  if (!body) return;

  const sha256Short = img.sha256 ? img.sha256.slice(0, 16) + "..." : "—";
  const sha256Full = img.sha256 || "";
  const mtime = img.mtime ? new Date(img.mtime * 1000).toLocaleString() : "—";
  const createdAt = img.created_at || "—";
  const tagsCount = img.tags?.length ?? 0;
  const tagCategories = img.tags?.reduce((acc: Record<string, number>, t) => {
    acc[t.category] = (acc[t.category] || 0) + 1;
    return acc;
  }, {}) ?? {};

  let parsedHtml = "";
  if (img.parsed_metadata) {
    const pm = img.parsed_metadata;
    const fields: [string, string][] = [];
    fields.push(["Match Type", pm.match_type]);
    if (pm.artist) fields.push(["Artist", pm.artist]);
    if (pm.pixiv_id) fields.push(["Pixiv ID", pm.pixiv_id]);
    if (pm.twitter_id) fields.push(["Twitter ID", pm.twitter_id]);
    if (pm.datetime_iso) fields.push(["DateTime", pm.datetime_iso]);
    if (pm.raw_matched) fields.push(["Raw Matched", pm.raw_matched]);
    if (pm.extracted_tags.length > 0) fields.push(["Extracted Tags", pm.extracted_tags.join(", ")]);
    if (pm.partial !== undefined) fields.push(["Partial", pm.partial ? "Yes" : "No"]);
    const rows = fields.map(([k, v]) => `<tr><td style="font-weight:600;width:120px;">${k}</td><td style="word-break:break-all;">${v}</td></tr>`).join("");
    parsedHtml = '<div class="group-box" style="margin-top:8px;"><div class="group-box-title"><i class="bi bi-file-earmark-code"></i> Parsed Metadata</div><table class="curator-table" style="font-size:11px;"><tbody>' + rows + '</tbody></table></div>';
  }

  const mediaRows: [string, string][] = [];
  if (img.width && img.height) {
    mediaRows.push(["Dimensions", `${img.width} × ${img.height}`]);
  }
  if (img.animation) {
    mediaRows.push(["Frames", String(img.animation.frame_count)]);
    mediaRows.push(["Duration", formatDuration(img.animation.duration_ms)]);
    const loopText = img.animation.loop_count === 0 ? "Infinite" : img.animation.loop_count ? `${img.animation.loop_count} time(s)` : "Once";
    mediaRows.push(["Loop", loopText]);
  }
  if (img.video) {
    mediaRows.push(["Format", img.video.format.toUpperCase()]);
    mediaRows.push(["Duration", formatDuration(img.video.duration_ms)]);
    if (img.video.fps > 0) mediaRows.push(["FPS", String(img.video.fps)]);
    mediaRows.push(["Video Codec", img.video.video_codec]);
    if (img.video.audio_codec) mediaRows.push(["Audio Codec", img.video.audio_codec]);
    if (img.video.bitrate) mediaRows.push(["Bitrate", `${(img.video.bitrate / 1000).toFixed(0)} kb/s`]);
  }
  const mediaHtml = mediaRows.length
    ? '<div class="group-box" style="margin-top:8px;"><div class="group-box-title"><i class="bi bi-film"></i> Media Info</div><table class="curator-table" style="font-size:11px;"><tbody>' +
      mediaRows.map(([k, v]) => `<tr><td style="font-weight:600;width:120px;">${k}</td><td>${v}</td></tr>`).join("") +
      '</tbody></table></div>'
    : "";

  const safetyHtml = isClassified(img)
    ? (() => {
        const threshold = loadNsfwPrefs().threshold;
        const ns = nsfwScore(img);
        const sf = (img.safe_score ?? 0) + (img.drawing_score ?? 0);
        const rows: { label: string; icon: string; value: number }[] = [
          { label: "Safe", icon: "bi-shield-check", value: img.safe_score ?? 0 },
          { label: "Hentai", icon: "bi-exclamation-triangle", value: img.hentai_score ?? 0 },
          { label: "Porn", icon: "bi-exclamation-triangle", value: img.porn_score ?? 0 },
          { label: "Sexy", icon: "bi-emoji-sunglasses", value: img.sexy_score ?? 0 },
          { label: "Drawing", icon: "bi-palette", value: img.drawing_score ?? 0 },
        ];
        const rowHtml = rows.map((r) => {
          const pct = Math.round(r.value * 1000) / 10;
          const danger = r.label !== "Safe" && r.label !== "Drawing" && r.value >= threshold;
          return '<div style="display:flex;align-items:center;gap:6px;font-size:11px;' + (danger ? 'background:#f8d7da;padding:3px 6px;border-radius:2px;' : '') + '">' +
            '<i class="bi ' + r.icon + '" style="color:#666;width:14px;"></i>' +
            '<span style="width:64px;font-weight:600;">' + r.label + '</span>' +
            '<div class="prob-bar" style="flex:1;"><div style="height:100%;width:' + pct + '%;background:var(--sys-accent,#0078d7);"></div></div>' +
            '<span style="width:48px;text-align:right;color:#333;">' + pct + '%</span>' +
            '</div>';
        }).join("");
        const nsPct = (ns * 1000 / 10).toFixed(1);
        const sfPct = (sf * 1000 / 10).toFixed(1);
        return '<div class="group-box" style="margin-top:8px;"><div class="group-box-title"><i class="bi bi-shield-check"></i> Safety Classification</div>' +
          '<div style="display:flex;gap:16px;font-size:11px;font-weight:600;margin-bottom:6px;">' +
          '<span style="color:#842029;">NSFW ' + nsPct + '%</span>' +
          '<span style="color:#2e7d32;">SFW ' + sfPct + '%</span>' +
          '</div>' +
          '<div style="display:flex;flex-direction:column;gap:4px;">' + rowHtml + '</div>' +
          '</div>';
      })()
    : "";

  const catBreakdown = Object.entries(tagCategories).map(([cat, count]) => `${cat}: ${count}`).join(", ");
  const tagsHtml = img.tags?.length
    ? img.tags.map(t => renderTagPill(t)).join(" ")
    : '<span style="color:#999;font-style:italic;">No tags</span>';

  const detectionsHtml = `<div class="group-box" style="margin-top:8px;" id="detections-section">
    <div class="group-box-title"><i class="bi bi-bounding-box"></i> Character Detections</div>
    <div class="group-box-body" id="detections-body">
      <div id="detections-loading" style="display:none;color:#666;font-size:11px;"><i class="bi bi-hourglass-split"></i> Loading detections...</div>
      <div id="detections-empty" style="display:none;color:#999;font-size:11px;font-style:italic;">No detections yet.</div>
      <div id="detections-list" style="display:flex;flex-direction:column;gap:6px;"></div>
      <div style="display:flex;gap:4px;margin-top:4px;">
        <button class="win-button primary" id="detect-characters-btn" style="font-size:11px;">
          <i class="bi bi-bounding-box"></i> Detect Characters
        </button>
        <button class="win-button" id="add-detection-btn" style="font-size:11px;">
          <i class="bi bi-plus-lg"></i> Add Box
        </button>
        <button class="win-button" id="refresh-detections-btn" style="font-size:11px;">
          <i class="bi bi-arrow-clockwise"></i> Refresh
        </button>
      </div>
    </div>
  </div>`;

  const notesHtml = `
  <div class="group-box" style="margin-top:8px;">
    <div class="group-box-title" style="display:flex;justify-content:space-between;align-items:center;width:100%;box-sizing:border-box;">
      <span><i class="bi bi-pencil-square"></i> Note</span>
      <div style="display:flex;gap:4px;">
        <span class="note-tab active" id="note-tab-preview" style="user-select:none;">Preview</span>
        <span class="note-tab" id="note-tab-edit" style="user-select:none;">Edit</span>
      </div>
    </div>
    <div class="group-box-body" style="padding:6px;">
      <div id="note-preview-content" class="note-preview" style="min-height:50px;"></div>
      <textarea id="note-edit-textarea" class="input-field" style="width:100%;height:80px;box-sizing:border-box;display:none;" placeholder="Write a note here... (Markdown supported)"></textarea>
      <div id="note-save-status" style="font-size:10px;color:#888;margin-top:4px;text-align:right;height:12px;line-height:12px;"></div>
    </div>
  </div>`;

  body.innerHTML =
    '<table class="curator-table" style="font-size:11px;"><tbody>' +
    '<tr><td style="font-weight:600;width:120px;">Image ID</td><td>' + img.id + '</td></tr>' +
    '<tr><td style="font-weight:600;">Filepath</td><td style="word-break:break-all;">' + img.current_filepath + '</td></tr>' +
    '<tr><td style="font-weight:600;">SHA-256</td><td style="font-family:monospace;display:flex;align-items:center;gap:6px;"><span id="info-sha256-text">' + sha256Short + '</span><button class="win-button" id="info-copy-sha256" title="Copy full SHA-256" style="font-size:10px;padding:2px 6px;"><i class="bi bi-clipboard"></i></button></td></tr>' +
    '<tr><td style="font-weight:600;">Modified</td><td>' + mtime + '</td></tr>' +
    '<tr><td style="font-weight:600;">Imported</td><td>' + createdAt + '</td></tr>' +
    '<tr><td style="font-weight:600;">Vector State</td><td>' + img.vector_state + '</td></tr>' +
    '<tr><td style="font-weight:600;">Favorite</td><td>' + (img.favorite ? "Yes" : "No") + '</td></tr>' +
    '<tr><td style="font-weight:600;">Tags (' + tagsCount + ')</td><td>' + (catBreakdown || "—") + '</td></tr>' +
    '</tbody></table>' +
    '<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px;">' + tagsHtml + '</div>' +
    notesHtml +
    parsedHtml +
    mediaHtml +
    safetyHtml +
    detectionsHtml;

  // --- Notes Handling ---
  const previewTab = body.querySelector("#note-tab-preview") as HTMLElement;
  const editTab = body.querySelector("#note-tab-edit") as HTMLElement;
  const previewDiv = body.querySelector("#note-preview-content") as HTMLElement;
  const editArea = body.querySelector("#note-edit-textarea") as HTMLTextAreaElement;
  const statusDiv = body.querySelector("#note-save-status") as HTMLElement;

  let currentNoteVal = img.note || "";

  const renderNoteHtml = (text: string) => {
    if (!text.trim()) {
      previewDiv.innerHTML = '<span style="color:#999;font-style:italic;">No notes yet. Click to add a note...</span>';
    } else {
      try {
        const rawHtml = marked.parse(text) as string;
        previewDiv.innerHTML = DOMPurify.sanitize(rawHtml);
      } catch (err) {
        console.error("Markdown parse error:", err);
        previewDiv.textContent = text;
      }
    }
  };

  renderNoteHtml(currentNoteVal);
  editArea.value = currentNoteVal;

  let saveTimeout: number | null = null;

  const saveNote = async () => {
    const newVal = editArea.value;
    if (newVal === currentNoteVal && statusDiv.textContent !== "Saving...") return;
    currentNoteVal = newVal;
    if (saveTimeout) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }

    statusDiv.textContent = "Saving...";
    statusDiv.style.color = "#0078d7";

    try {
      await typedCall("GalleryService.SetNote", SetNoteRequestSchema, {
        imageId: BigInt(img.id),
        note: newVal.trim() ? newVal : undefined,
      }, EmptySchema);
      statusDiv.textContent = "Saved";
      statusDiv.style.color = "#28a745";
      img.note = newVal;
      renderNoteHtml(newVal);
      // Optional: refresh gallery elements if note status changes
      import("../views/gallery").then(m => m.refreshGallery());
    } catch (err: any) {
      console.error("Save note failed:", err);
      statusDiv.textContent = "Save failed";
      statusDiv.style.color = "#dc3545";
    }
  };

  const showEdit = () => {
    previewTab.classList.remove("active");
    editTab.classList.add("active");
    previewDiv.style.display = "none";
    editArea.style.display = "block";
    editArea.focus();
  };

  const showPreview = async () => {
    previewTab.classList.add("active");
    editTab.classList.remove("active");
    editArea.style.display = "none";
    previewDiv.style.display = "block";
    if (editArea.value !== currentNoteVal) {
      await saveNote();
    }
  };

  previewTab.addEventListener("click", showPreview);
  editTab.addEventListener("click", showEdit);
  previewDiv.addEventListener("click", showEdit);

  editArea.addEventListener("blur", () => {
    saveNote();
  });

  editArea.addEventListener("input", () => {
    statusDiv.textContent = "Unsaved changes...";
    statusDiv.style.color = "#e0a800";
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = window.setTimeout(() => {
      saveNote();
    }, 1000);
  });

  // Plugin metadata renderers (design doc 8.2) — appended below core content.
  try {
    const asset = window.PluginHost?.getAssetContext(img);
    if (asset) {
      window.PluginHost.renderMetadataSections(asset).forEach((el) => body.appendChild(el));
    }
  } catch (e) {
    console.error("Plugin metadata renderer failed:", e);
  }

  // --- Copy SHA-256 ---
  const copySha = body.querySelector("#info-copy-sha256");
  if (copySha && sha256Full) {
    copySha.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(sha256Full);
        copySha.innerHTML = '<i class="bi bi-check-lg"></i>';
        setTimeout(() => { copySha.innerHTML = '<i class="bi bi-clipboard"></i>'; }, 1200);
      } catch (_) {}
    });
  }

  // --- Character Detections ---
  loadDetectionsForImage(img.id, body);

  const detectBtn = body.querySelector("#detect-characters-btn") as HTMLButtonElement;
  if (detectBtn) {
    detectBtn.addEventListener("click", async () => {
      detectBtn.disabled = true;
      detectBtn.innerHTML = '<i class="bi bi-hourglass-split"></i> Detecting...';
      const loading = body.querySelector("#detections-loading") as HTMLElement;
      if (loading) loading.style.display = "block";
      try {
        await typedCall("CharactersService.DetectCharacters", ImageIdRequestSchema, { imageId: BigInt(img.id) }, DetectionResultSchema);
        await loadDetectionsForImage(img.id, body);
        await refreshCharacters();
        import("../views/gallery").then(m => m.refreshGallery());
        import("../views/dashboard").then(m => m.refreshDashboard());
      } catch (e: any) {
        console.error("Detection failed:", e);
      } finally {
        detectBtn.disabled = false;
        detectBtn.innerHTML = '<i class="bi bi-bounding-box"></i> Detect Characters';
        if (loading) loading.style.display = "none";
      }
    });
  }

  const addDetBtn = body.querySelector("#add-detection-btn") as HTMLButtonElement;
  if (addDetBtn) {
    addDetBtn.addEventListener("click", () => {
      import("../bbox-editor").then(m => {
        m.openBBoxEditor(null, img.id, img.current_filepath, 0, 0, 0, 0, () => {
          loadDetectionsForImage(img.id, body);
          refreshCharacters();
          import("../views/gallery").then(m => m.refreshGallery());
          import("../views/dashboard").then(m => m.refreshDashboard());
        });
      });
    });
  }

  const refreshDetBtn = body.querySelector("#refresh-detections-btn") as HTMLButtonElement;
  if (refreshDetBtn) {
    refreshDetBtn.addEventListener("click", async () => {
      await loadDetectionsForImage(img.id, body);
    });
  }
}

export function openImageInfoModal(img: ImageDetails) {
  const modal = document.getElementById("image-info-modal");
  const body = document.getElementById("image-info-modal-body");
  if (!modal || !body) return;

  renderImageInfo(img, body);
  modal.classList.add("active");

  const closeBtn = modal.querySelector(".modal-close");
  const onBackdropClick = (e: MouseEvent) => {
    if (e.target === modal) onClose();
  };
  const onClose = () => {
    modal.classList.remove("active");
    closeBtn?.removeEventListener("click", onClose);
    modal.removeEventListener("click", onBackdropClick);
  };
  closeBtn?.addEventListener("click", onClose);
  modal.addEventListener("click", onBackdropClick);
}

function storedDetectionFromProto(p: PStoredDetection): CharacterDetection {
  return {
    id: Number(p.id),
    image_id: Number(p.imageId),
    x0: p.x0,
    y0: p.y0,
    x1: p.x1,
    y1: p.y1,
    confidence: p.confidence,
    has_embedding: p.hasEmbedding,
    identity_id: p.identityId === undefined ? null : Number(p.identityId),
  };
}

function characterIdentityFromProto(p: PCharacterIdentity): CharacterIdentity {
  return {
    id: Number(p.id),
    name: p.name,
    detection_count: Number(p.detectionCount),
    created_at: p.createdAt,
  };
}

async function loadDetectionsForImage(imageId: number, scopeEl: HTMLElement | Document = document) {
  const loading = scopeEl.querySelector("#detections-loading") as HTMLElement | null;
  const empty = scopeEl.querySelector("#detections-empty") as HTMLElement | null;
  const list = scopeEl.querySelector("#detections-list") as HTMLElement | null;
  if (!list) return;

  if (loading) loading.style.display = "block";
  if (empty) empty.style.display = "none";
  list.innerHTML = "";

  try {
    const resp = await typedCall("CharactersService.GetCharacterDetections", ImageIdRequestSchema, { imageId: BigInt(imageId) }, CharacterDetectionsResultSchema);
    const detections = resp.detections.map(storedDetectionFromProto);
    if (loading) loading.style.display = "none";

    if (detections.length === 0) {
      if (empty) empty.style.display = "block";
      return;
    }

    const idResp = await typedCall("CharactersService.ListCharacterIdentities", null, null, CharacterIdentitiesListSchema);
    const identities: CharacterIdentity[] = idResp.identities.map(characterIdentityFromProto);
    identities.sort(compareIdentitiesPlaceholderLast);

    await preloadDetectionCrops(detections);

    for (const det of detections) {
      const detEl = renderDetectionRow(det, identities, imageId, scopeEl);
      list.appendChild(detEl);
    }
  } catch (e) {
    console.error("Failed to load detections:", e);
    if (loading) loading.style.display = "none";
    if (empty) {
      empty.style.display = "block";
      empty.textContent = "Failed to load detections.";
    }
  }
}

async function preloadDetectionCrops(detections: CharacterDetection[]) {
  const uncached = detections.filter((d) => !hasCachedCrop(d.id));
  if (uncached.length === 0) return;
  const ids = uncached.map((d) => d.id);
  const revs = new Map<number, number>(uncached.map((d) => [d.id, getCropRevision(d.id)]));
  try {
    const resp = await typedCall("CharactersService.GetDetectionCrops", GetDetectionCropsRequestSchema, { detectionIds: ids.map((id) => BigInt(id)), maxSize: 96 }, DetectionCropsResultSchema);
    for (const entry of resp.crops) {
      const detectionId = Number(entry.detectionId);
      if (getCropRevision(detectionId) !== revs.get(detectionId)) continue;
      const blob = new Blob([entry.cropWebpBytes], { type: "image/webp" });
      setCachedCrop(detectionId, URL.createObjectURL(blob));
    }
  } catch {
    // individual rows fall back to their own lazy load
  }
}

function renderDetectionRow(det: CharacterDetection, identities: CharacterIdentity[], imageId: number, scopeEl: HTMLElement | Document = document): HTMLElement {
  const detEl = document.createElement("div");
  detEl.style.cssText = "display:flex;align-items:center;gap:8px;padding:4px 6px;border:1px solid var(--sys-border-light,#d0d0d0);border-radius:2px;background:var(--sys-window-bg,#fff);font-size:11px;";

  const cropThumb = document.createElement("div");
  cropThumb.className = "skeleton-pulse";
  cropThumb.style.cssText = "width:48px;height:48px;border:1px solid #ccc;display:flex;align-items:center;justify-content:center;flex-shrink:0;";
  cropThumb.innerHTML = '<i class="bi bi-image" style="color:#999;"></i>';

  const cachedCropUrl = getCachedCrop(det.id);
  if (cachedCropUrl) {
    cropThumb.classList.remove("skeleton-pulse");
    cropThumb.innerHTML = `<img src="${cachedCropUrl}" style="width:100%;height:100%;object-fit:cover;" />`;
  } else {
    const revAtStart = getCropRevision(det.id);
    typedCall("CharactersService.GetDetectionCrop", GetDetectionCropRequestSchema, { detectionId: BigInt(det.id), maxSize: 96 }, DetectionCropResultSchema).then((cropResp) => {
      if (getCropRevision(det.id) !== revAtStart) return;
      const blob = new Blob([cropResp.cropWebpBytes], { type: "image/webp" });
      const url = URL.createObjectURL(blob);
      setCachedCrop(det.id, url);
      cropThumb.classList.remove("skeleton-pulse");
      cropThumb.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover;" />`;
    }).catch(() => {
      cropThumb.classList.remove("skeleton-pulse");
    });
  }

  const infoEl = document.createElement("div");
  infoEl.style.cssText = "flex:1;min-width:0;";

  const assignedIdentity = det.identity_id !== null ? identities.find((i: any) => i.id === det.identity_id) : null;
  const dropdownId = `det-ac-${det.id}`;

  const currentName = assignedIdentity ? assignedIdentity.name : "";

  infoEl.innerHTML = `
    <div style="display:flex;align-items:center;gap:6px;">
      <div style="position:relative;display:inline-block;">
        <input class="det-name-input" value="${currentName}" placeholder="Type character name..." style="font-weight:600;font-size:11px;padding:1px 4px;border:1px solid transparent;border-radius:2px;background:transparent;width:140px;" autocomplete="off" />
        <div id="${dropdownId}" class="autocomplete-dropdown" style="display:none;z-index:10;"></div>
      </div>
      <span style="color:#888;">(${(det.confidence * 100).toFixed(1)}%)</span>
    </div>
    <div style="display:flex;align-items:center;gap:4px;margin-top:2px;">
      <select class="win-select detection-identity-select" data-detection-id="${det.id}" style="font-size:10px;padding:1px 4px;max-width:150px;">
        <option value="">Unassigned</option>
        ${identities.map((i: any) => `<option value="${i.id}" ${det.identity_id === i.id ? "selected" : ""}>${i.name}</option>`).join("")}
      </select>
    </div>
  `;

  const nameInput = infoEl.querySelector(".det-name-input") as HTMLInputElement;

  const handleAssign = async (targetName: string) => {
    const name = targetName.trim();
    if (!name) {
      if (det.identity_id !== null) {
        await typedCall("CharactersService.AssignCharacterIdentity", AssignCharacterIdentityRequestSchema, { detectionId: BigInt(det.id), identityId: undefined }, EmptySchema);
        await loadDetectionsForImage(imageId, scopeEl);
        await refreshCharacters();
        import("../views/gallery").then(m => m.refreshGallery());
        import("../views/dashboard").then(m => m.refreshDashboard());
      }
      return;
    }

    if (assignedIdentity && name.toLowerCase() === assignedIdentity.name.toLowerCase()) {
      return;
    }

    const existing = identities.find(i => i.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      await typedCall("CharactersService.AssignCharacterIdentity", AssignCharacterIdentityRequestSchema, { detectionId: BigInt(det.id), identityId: BigInt(existing.id) }, EmptySchema);
    } else {
      const createResp = await typedCall("CharactersService.CreateCharacterIdentity", CreateCharacterIdentityRequestSchema, { name }, CharacterIdentitiesListSchema);
      const newId = createResp.identities[0]?.id;
      if (newId !== undefined) {
        await typedCall("CharactersService.AssignCharacterIdentity", AssignCharacterIdentityRequestSchema, { detectionId: BigInt(det.id), identityId: newId }, EmptySchema);
      }
    }
    await loadDetectionsForImage(imageId, scopeEl);
    await refreshCharacters();
    import("../views/gallery").then(m => m.refreshGallery());
    import("../views/dashboard").then(m => m.refreshDashboard());
  };

  attachAutocomplete({
    input: nameInput,
    dropdownId,
    onSelect: async (selectedName) => {
      await handleAssign(selectedName);
    },
    fetchItems: async (query) => {
      const { getSuggestions } = await import("../views/characters");
      const suggestions = await getSuggestions(query);
      return suggestions.map((s) => ({ name: s.name, count: s.count }));
    },
  });

  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      nameInput.blur();
    }
  });

  let blurTimeout: any = null;
  nameInput.addEventListener("focus", () => {
    if (blurTimeout) clearTimeout(blurTimeout);
  });

  nameInput.addEventListener("blur", () => {
    blurTimeout = setTimeout(async () => {
      await handleAssign(nameInput.value);
    }, 250);
  });

  detEl.appendChild(cropThumb);
  detEl.appendChild(infoEl);

  const actionsEl = document.createElement("div");
  actionsEl.style.cssText = "display:flex;gap:4px;margin-left:auto;align-items:center;";
  actionsEl.innerHTML = `
    <button class="win-button match-det-btn" style="font-size:10px;padding:2px 6px;" title="Auto-match identity">
      <i class="bi bi-person-check"></i>
    </button>
    <button class="win-button edit-bbox-btn" style="font-size:10px;padding:2px 6px;" title="Edit bounding box">
      <i class="bi bi-bounding-box"></i>
    </button>
    <button class="win-button danger delete-det-btn" style="font-size:10px;padding:2px 6px;" title="Delete detection">
      <i class="bi bi-trash"></i>
    </button>
  `;
  detEl.appendChild(actionsEl);

  actionsEl.querySelector(".match-det-btn")?.addEventListener("click", async () => {
    const matchBtn = actionsEl.querySelector(".match-det-btn") as HTMLButtonElement;
    matchBtn.disabled = true;
    matchBtn.innerHTML = '<i class="bi bi-hourglass-split"></i>';
    try {
      await typedCall("CharactersService.IdentifyDetection", IdentifyDetectionRequestSchema, { detectionId: BigInt(det.id) }, IdentifyDetectionResultSchema);
      loadDetectionsForImage(imageId, scopeEl);
      refreshCharacters();
      import("../views/gallery").then(m => m.refreshGallery());
      import("../views/dashboard").then(m => m.refreshDashboard());
    } catch (e: any) {
      showErrorAlert("Error trying to match identity:\n" + (e.message || e));
    } finally {
      matchBtn.disabled = false;
      matchBtn.innerHTML = '<i class="bi bi-person-check"></i>';
    }
  });

  actionsEl.querySelector(".edit-bbox-btn")?.addEventListener("click", () => {
    typedCall("GalleryService.GetImage", GetImageRequestSchema, { imageId: BigInt(imageId) }, ImageResultSchema).then((imgResp) => {
      if (imgResp.image) {
        const fp = imgResp.image.currentFilepath;
        import("../bbox-editor").then(m => {
          m.openBBoxEditor(det.id, imageId, fp, det.x0, det.y0, det.x1, det.y1, async () => {
            invalidateCropCache(det.id);
            await loadDetectionsForImage(imageId, scopeEl);
            refreshCharacters();
            import("../views/gallery").then(m => m.refreshGallery());
            import("../views/dashboard").then(m => m.refreshDashboard());
          });
        });
      }
    });
  });

  actionsEl.querySelector(".delete-det-btn")?.addEventListener("click", async () => {
    if (!confirm("Are you sure you want to delete this detection? This will remove it from the system.")) return;
    await typedCall("CharactersService.DeleteDetection", DeleteDetectionRequestSchema, { detectionId: BigInt(det.id) }, EmptySchema);
    loadDetectionsForImage(imageId, scopeEl);
    refreshCharacters();
    import("../views/gallery").then(m => m.refreshGallery());
    import("../views/dashboard").then(m => m.refreshDashboard());
  });

  const select = detEl.querySelector(".detection-identity-select") as HTMLSelectElement;
  select?.addEventListener("change", async () => {
    const val = select.value;
    const identityId = val ? parseInt(val, 10) : null;
    await typedCall("CharactersService.AssignCharacterIdentity", AssignCharacterIdentityRequestSchema, { detectionId: BigInt(det.id), identityId: identityId !== null ? BigInt(identityId) : undefined }, EmptySchema);
    await loadDetectionsForImage(imageId, scopeEl);
    await refreshCharacters();
    import("../views/gallery").then(m => m.refreshGallery());
    import("../views/dashboard").then(m => m.refreshDashboard());
  });

  return detEl;
}

export const meta = {
  name: "Image Info Modal",
  description: "Image details overlay with metadata grids, media info, markdown notes, and character detection panel.",
  variants: [
    {
      name: "Metadata grid & notes",
      render: () => html`
        <div class="group-box">
          <div class="group-box-title">Image Info Modal</div>
          <div class="group-box-body" style="color:var(--sys-text-subtle);font-size:11px;">
            Renders the image details table, parsed metadata, media info, markdown note editor, and the character detection panel into #image-info-modal-body.
          </div>
        </div>
      `
    }
  ]
};