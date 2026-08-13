/**
 * Host side of the postMessage bridge to the embedded miniPaint iframe.
 *
 * The iframe is served from the Tauri asset protocol (`http://asset.localhost/…`)
 * and is cross-origin to the dashboard, so the editor's save/load traffic is
 * relayed over `postMessage`. Only messages whose `event.source` is our own
 * iframe are trusted. Exported blobs arrive as a transferred `ArrayBuffer`
 * (zero-copy) and are written to disk via the dashboard `save_edited_image`
 * command — the payload never crosses the gRPC Named Pipe.
 *
 * The settings row (Load/Unload toggle, output dir, Browse, Load Selected) is
 * owned by `index.ts` and is ALWAYS visible; `mountEditor` mounts only the
 * iframe into the caller-provided host element and returns a teardown fn.
 */

import { state, setOutputDir } from "./state";
import { saveEditedImage } from "./ipc";

const PH = window.PluginHost;

// The window "message" listener is registered ONCE at module scope. It resolves
// the active editor iframe through `currentFrame` so load/unload cycles do not
// accumulate listeners. After an unload, the detached iframe's contentWindow is
// null, so stale messages from the old editor are rejected.
let currentFrame: HTMLIFrameElement | null = null;
let editorWorkspaceRoot = "";

async function onMessage(ev: MessageEvent): Promise<void> {
  if (ev.source !== currentFrame?.contentWindow) return; // only trust our own editor
  const d = ev.data;
  if (!d || typeof d !== "object") return;

  if (d.type === "minipaint:console-error") {
    console.error(
      `[minipaint iframe] ${d.message || "unknown error"}${d.detail ? "\n" + d.detail : ""}`
    );
    return;
  }

  if (d.type === "minipaint:save") {
    // The transferred ArrayBuffer arrives on the message; zero-copy into this
    // frame, no base64. Only the buffer is sent to Rust — the returned path
    // (a tiny string) is all that comes back over IPC.
    const bytes: ArrayBuffer | undefined = d.buffer ?? d;
    if (!(bytes instanceof ArrayBuffer)) {
      currentFrame?.contentWindow?.postMessage(
        { type: "minipaint:save-result", ok: false, error: "no buffer in save message" },
        "*"
      );
      return;
    }

    const outFolder = state.outputDir || `${editorWorkspaceRoot}\\edited`;
    const name = String(d.name || "edited");

    try {
      const res = await saveEditedImage({
        outputDir: outFolder,
        format: String(d.format || "png"),
        name,
        bytes,
      });
      currentFrame?.contentWindow?.postMessage(
        { type: "minipaint:save-result", ok: res.ok, path: res.path, error: res.error },
        "*"
      );
    } catch (e) {
      currentFrame?.contentWindow?.postMessage(
        { type: "minipaint:save-result", ok: false, error: String(e) },
        "*"
      );
    }
  }
}

window.addEventListener("message", onMessage);

/**
 * Build an asset-protocol URL that keeps real path separators.
 *
 * `convertFileSrc` percent-encodes a Windows absolute path into a single URL
 * segment (`K%3A%5C…`), so the browser resolves relative `src`/`href` inside a
 * served document against the protocol root and every sub-resource 404s. Tauri's
 * asset handler percent-decodes the request path and opens it as a file, and
 * Windows accepts `/` separators — so we split on `\`, encode each segment, and
 * join with `/` to give the document a real directory hierarchy.
 */
function assetDirUrl(absPath: string): string {
  const origin = PH.convertFileSrc(""); // "http://asset.localhost/"
  const encoded = absPath
    .split("\\")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${origin}${encoded}`;
}

/**
 * Mount the editor iframe into `host`. Returns a teardown function that removes
 * the frame and detaches the module-level reference so the browser can reclaim
 * the editor's heap (bundle.js, gif.js workers, layer canvases).
 */
export function mountEditor(
  pluginDir: string,
  workspaceRoot: string,
  host: HTMLElement,
  initialPath?: string
): () => void {
  editorWorkspaceRoot = workspaceRoot;

  const iframe = document.createElement("iframe");
  iframe.style.cssText = "flex:1;width:100%;border:1px solid #ddd;background:#fff;";
  iframe.setAttribute("allow", "clipboard-write; web-share");

  // The editor reads assets via postMessage, not a ?image= query param:
  // miniPaint never URL-decodes query values, and encoding a full asset URL
  // into one would make it resolve relative to the document. The bridge
  // attaches its listener before the iframe's load event fires, so posting
  // on load is race-free.
  function loadInitialAsset(): void {
    iframe.src = assetDirUrl(`${pluginDir}\\editor\\index.html`);
    if (initialPath) {
      iframe.addEventListener(
        "load",
        () => {
          iframe.contentWindow?.postMessage(
            { type: "minipaint:load-image", url: PH.convertFileSrc(initialPath) },
            "*"
          );
        },
        { once: true }
      );
    }
  }

  host.appendChild(iframe);
  currentFrame = iframe;
  loadInitialAsset();

  return () => {
    iframe.remove();
    currentFrame = null;
  };
}

/** Post a specific asset path into the live editor (no-op when unloaded). */
export function loadAssetIntoEditor(path: string): void {
  if (!currentFrame || !path) return;
  currentFrame.contentWindow?.postMessage(
    { type: "minipaint:load-image", url: PH.convertFileSrc(path) },
    "*"
  );
}

/** Pick a new output directory (shared by the always-visible settings row). */
export async function browseOutputDir(onSelected: (dir: string) => void): Promise<void> {
  try {
    const selected = await window.__TAURI__?.core?.invoke("select_path", { isDirectory: true });
    if (selected) {
      setOutputDir(selected);
      onSelected(selected);
    }
  } catch (e) {
    console.error("minipaint: folder picker failed", e);
  }
}

export { state };
