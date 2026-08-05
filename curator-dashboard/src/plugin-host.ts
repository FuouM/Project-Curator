import { callService } from "./ipc";
import { getPluginViewKeys, registerPluginView, removePluginView } from "./views/navigation";
import { AssetContext, ImageDetails, PluginInfo, TagContext } from "./types";
import { selectedImageIds } from "./state";

// ---------------------------------------------------------------------------
// Plugin Registry State
// ---------------------------------------------------------------------------

const registeredTabs: Array<{ id: string; label: string; iconClass: string; render: () => HTMLElement }> = [];
const registeredRenderers: Array<{ id: string; fn: (asset: AssetContext) => HTMLElement | null }> = [];
const registeredToolbarButtons: Array<{ id: string; label: string; iconClass: string; fn: (selection: AssetContext[]) => void }> = [];
const registeredContextMenuItems: Array<{ id: string; label: string; fn: (asset: AssetContext) => void }> = [];
const mountedTabs = new Set<string>();

let pluginInfos: PluginInfo[] = [];
export function getPluginInfos(): PluginInfo[] {
  return pluginInfos;
}

// ---------------------------------------------------------------------------
// AssetContext Adapter
// ---------------------------------------------------------------------------

/** Map a core `ImageDetails` record into the plugin `AssetContext` shape. */
export function getAssetContext(image: ImageDetails): AssetContext {
  const tags: TagContext[] = (image.tags || []).map((t) => ({
    name: t.tag,
    category: t.category,
    source_id: t.source_name || "user",
    confidence: typeof t.confidence === "number" ? t.confidence : null,
  }));
  return {
    asset_id: image.id,
    path: image.current_filepath,
    hash: image.sha256 || "",
    tags,
  };
}

/** Minimal `AssetContext` derived from a rendered card (path + id only). */
export function getAssetContextFromCard(card: HTMLElement): AssetContext {
  const id = parseInt(card.dataset.imageId || "0", 10);
  const path = card.dataset.filepath || "";
  return { asset_id: id, path, hash: "", tags: [] };
}

/** Fetch the full `AssetContext` for an asset id (hydrates hash + tags). */
export async function fetchAssetContext(imageId: number): Promise<AssetContext> {
  const resp = await callService({ GetImage: { image_id: imageId } });
  if ("ImageResult" in resp) {
    return getAssetContext(resp.ImageResult.image);
  }
  return { asset_id: imageId, path: "", hash: "", tags: [] };
}

/** Build `AssetContext[]` for the current multi-select set (in parallel). */
export async function getSelectionAssetContexts(): Promise<AssetContext[]> {
  const ids = Array.from(selectedImageIds);
  const results = await Promise.all(ids.map((id) => fetchAssetContext(id)));
  return results.filter((a) => a.asset_id > 0);
}

// ---------------------------------------------------------------------------
// PluginHost Global API (design doc Section 8.1/8.2)
// ---------------------------------------------------------------------------

export interface PluginHostApi {
  registerTab(id: string, label: string, iconClass: string, render: () => HTMLElement): void;
  registerMetadataRenderer(id: string, fn: (asset: AssetContext) => HTMLElement | null): void;
  registerToolbarButton(id: string, label: string, iconClass: string, fn: (selection: AssetContext[]) => void): void;
  registerContextMenuItem(id: string, label: string, fn: (asset: AssetContext) => void): void;
  callService(method: string, params: object): Promise<any>;
  getAssetContext(image: ImageDetails): AssetContext;
  getAssetContextFromCard(card: HTMLElement): AssetContext;
  fetchAssetContext(imageId: number): Promise<AssetContext>;
  getSelectionAssetContexts(): Promise<AssetContext[]>;
  renderMetadataSections(asset: AssetContext): HTMLElement[];
  getContextMenuItems(): Array<{ id: string; label: string; fn: (asset: AssetContext) => void }>;
}

const pluginHost: PluginHostApi = {
  registerTab(id, label, iconClass, render) {
    registeredTabs.push({ id, label, iconClass, render });
  },
  registerMetadataRenderer(id, fn) {
    registeredRenderers.push({ id, fn });
  },
  registerToolbarButton(id, label, iconClass, fn) {
    registeredToolbarButtons.push({ id, label, iconClass, fn });
  },
  registerContextMenuItem(id, label, fn) {
    registeredContextMenuItems.push({ id, label, fn });
  },
  callService(method, params) {
    return callService({ [method]: params });
  },
  getAssetContext,
  getAssetContextFromCard,
  fetchAssetContext,
  getSelectionAssetContexts,
  renderMetadataSections(asset) {
    return registeredRenderers.map((r) => r.fn(asset)).filter((el): el is HTMLElement => el !== null);
  },
  getContextMenuItems() {
    return registeredContextMenuItems.slice();
  },
};

declare global {
  interface Window {
    PluginHost: PluginHostApi;
  }
}

window.PluginHost = pluginHost;

// ---------------------------------------------------------------------------
// Bundle Loading
// ---------------------------------------------------------------------------

/** Execute a plugin JS bundle in global scope. Throws propagate to the caller's
 *  try/catch (inline script execution is synchronous). */
function executePluginBundle(code: string, pluginName: string): void {
  const script = document.createElement("script");
  script.textContent = code;
  script.setAttribute("data-plugin", pluginName);
  document.head.appendChild(script);
  document.head.removeChild(script);
}

function clearRegistry() {
  registeredTabs.length = 0;
  registeredRenderers.length = 0;
  registeredToolbarButtons.length = 0;
  registeredContextMenuItems.length = 0;
  mountedTabs.clear();
}

/**
 * Load all enabled, UI-injecting plugins and mount their registered
 * capabilities. Safe to re-run (live re-init after enable/disable toggles).
 */
export async function initPlugins() {
  clearRegistry();
  refreshExtensionsToolbar();

  let resp: any;
  try {
    resp = await callService({ ListPlugins: null });
  } catch (e) {
    console.error("initPlugins: ListPlugins failed:", e);
    return;
  }
  if (!("PluginsListResult" in resp)) {
    console.error("initPlugins: unexpected ListPlugins response:", resp);
    return;
  }

  pluginInfos = resp.PluginsListResult.plugins;

  const loadable = pluginInfos.filter(
    (p) => p.enabled && !!p.ui && p.permissions.includes("ui:inject")
  );

  for (const p of loadable) {
    try {
      const fileResp = await callService({ ReadPluginFile: { plugin_name: p.name, relative_path: p.ui! } });
      if (!("PluginFileResult" in fileResp)) {
        console.error(`Plugin "${p.name}": failed to read bundle "${p.ui}":`, fileResp);
        continue;
      }
      executePluginBundle(fileResp.PluginFileResult.content, p.name);
      console.log(`Plugin "${p.name}" bundle loaded and executed.`);
    } catch (e) {
      console.error(`Plugin "${p.name}": bundle load failed, skipping (core UI untouched):`, e);
    }
  }

  mountPluginTabs();
  refreshExtensionsToolbar();

  // Remove nav items / sections for plugins that were loaded in a previous
  // cycle but are no longer registered (e.g. disabled via the hub).
  const currentTabKeys = new Set(registeredTabs.map((t) => `extensions-${t.id}`));
  for (const key of getPluginViewKeys()) {
    if (!currentTabKeys.has(key)) removePluginView(key);
  }
}

/** Create sidebar nav item + view section for each registered plugin tab. */
function mountPluginTabs() {
  // Clear previously-rendered plugin tab content so re-init renders fresh
  // closures on next activation (live re-init after enable/disable toggles).
  document.querySelectorAll<HTMLElement>("[id^='view-extensions-']").forEach((s) => {
    s.innerHTML = "";
  });

  for (const tab of registeredTabs) {
    if (mountedTabs.has(tab.id)) continue;
    mountedTabs.add(tab.id);
    registerPluginView(tab.id, tab.label, tab.iconClass, `Plugin: ${tab.label}`, () => {
      const section = document.getElementById(`view-extensions-${tab.id}`);
      if (section && section.childElementCount === 0) {
        const el = tab.render();
        if (el) section.appendChild(el);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Toolbar Buttons (D3)
// ---------------------------------------------------------------------------

export function refreshExtensionsToolbar() {
  const containers = document.querySelectorAll<HTMLElement>(".extensions-toolbar");
  containers.forEach((c) => { c.innerHTML = ""; });

  for (const btn of registeredToolbarButtons) {
    containers.forEach((container) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "win-button";
      b.style.cssText = "font-size: 11px;";
      b.title = btn.label;
      b.innerHTML = `<i class="${btn.iconClass}"></i> ${btn.label}`;
      b.addEventListener("click", () => {
        getSelectionAssetContexts().then((selection) => btn.fn(selection));
      });
      container.appendChild(b);
    });
  }
}
