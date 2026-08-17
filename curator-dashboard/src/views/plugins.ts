import { typedCall } from "../ipc";
import { initPlugins, isPluginAutoloadEnabled, setPluginAutoloadEnabled } from "../plugin-host";
import { PluginInfo } from "../types";
import { SafeHtml, html } from "../components";
import { showErrorAlert } from "../alert";
import { pluginInfoFromProto } from "../proto-adapters";
import { EmptySchema } from "@bufbuild/protobuf/wkt";
import {
  PluginsListResultSchema,
  SetPluginEnabledRequestSchema,
  ValidatePluginRequestSchema,
  ValidationResultSchema,
} from "../gen/plugins_pb";

export function renderPluginsHubHtml(): SafeHtml {
  return html`
    <div class="group-box">
      <div class="group-box-title">Installed Plugins</div>
      <div
        style="display: flex; justify-content: flex-end; gap: 6px; margin-bottom: 10px; flex-wrap: wrap;"
      >
        <button type="button" class="win-button" id="plugins-enable-all-btn">
          <i class="bi bi-check2-all"></i> Enable All
        </button>
        <button type="button" class="win-button" id="plugins-disable-all-btn">
          <i class="bi bi-x-lg"></i> Disable All
        </button>
        <button
          type="button"
          class="win-button"
          id="plugins-autoload-all-btn"
          style="margin-left: 8px;"
        >
          <i class="bi bi-play-circle"></i> Autoload All
        </button>
        <button type="button" class="win-button" id="plugins-autoload-none-btn">
          <i class="bi bi-stop-circle"></i> Autoload None
        </button>
      </div>
      <div id="plugins-hub-list">
        <div class="skeleton-loader"></div>
        <div class="skeleton-loader"></div>
      </div>
    </div>
  `;
}

function permissionBadge(perm: string): string {
  const classes: Record<string, string> = {
    "ui:inject": "custom-concept",
    "filesystem:read": "tag-user",
    "filesystem:write": "tag-user",
    "database:read": "tag-character",
    sidecar_db: "tag-meta",
  };
  const cls = classes[perm] || "tag-meta";
  return `<span class="tag-pill ${cls}" style="font-size: 9px; font-family: monospace;">${perm}</span>`;
}

function pluginRowHtml(p: PluginInfo): string {
  const statusBadge = p.loaded
    ? '<span class="tag-pill custom-concept" style="font-size: 9px;"><i class="bi bi-check-lg"></i> valid manifest</span>'
    : '<span class="tag-pill tag-meta" style="font-size: 9px;"><i class="bi bi-exclamation-triangle"></i> missing / invalid manifest</span>';

  const permsHtml =
    p.permissions.length > 0
      ? p.permissions.map(permissionBadge).join(" ")
      : '<span style="color:#999;font-size:10px;">none</span>';

  const hooksText = p.hooks.length > 0 ? `${p.hooks.length} hooks` : "no hooks";
  const autoloadChecked = isPluginAutoloadEnabled(p.name);

  return `
    <div class="group-box plugin-row ${p.enabled ? "" : "plugin-row-disabled"}" data-plugin-name="${p.name}" style="padding: 10px;">
      <div style="display: flex; align-items: flex-start; gap: 10px;">
        <div style="flex: 1; min-width: 0;">
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <span style="font-weight: 600; font-size: 12px;">${p.name}</span>
            <span class="tag-pill tag-meta" style="font-size: 9px; font-family: monospace;">v${p.version || "?"}</span>
            ${statusBadge}
          </div>
          <div style="font-size: 11px; color: #555; margin-top: 4px;">${p.description || "<i>No description</i>"}</div>
          <div style="display: flex; align-items: center; gap: 6px; margin-top: 6px; flex-wrap: wrap;">
            <span style="font-size: 10px; color: #777;">Permissions:</span>
            ${permsHtml}
            <span style="font-size: 10px; color: #777; margin-left: 8px;">${hooksText}</span>
            ${p.ui ? `<span style="font-size: 10px; color: #777;">ui: ${p.ui}</span>` : ""}
          </div>
        </div>
        <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 6px;">
          <label style="display: flex; align-items: center; gap: 6px; font-size: 11px; cursor: pointer;" title="Enable or disable this plugin completely">
            <input type="checkbox" class="plugin-enabled-toggle" ${p.enabled ? "checked" : ""} />
            <span class="${p.enabled ? "" : "plugin-disabled-label"}">${p.enabled ? "Enabled" : "Disabled"}</span>
          </label>
          <label style="display: flex; align-items: center; gap: 6px; font-size: 11px; cursor: pointer;" title="Automatically load UI on startup (uncheck to start unloaded)">
            <input type="checkbox" class="plugin-autoload-toggle" ${autoloadChecked ? "checked" : ""} ${p.enabled ? "" : "disabled"} />
            <span style="color: ${p.enabled ? "var(--sys-window-text, #333)" : "var(--sys-text-subtle, #888)"};">Autoload UI</span>
          </label>
          <button type="button" class="win-button plugin-validate-btn" style="font-size: 10px; padding: 2px 8px;">
            <i class="bi bi-shield-check"></i> Validate
          </button>
        </div>
      </div>
      <div class="plugin-validate-result" style="margin-top: 8px; font-size: 11px; display: none;"></div>
    </div>
  `;
}

export async function setupPluginsHub() {
  const section = document.getElementById("view-plugins");
  if (!section) return;
  const existing = document.getElementById("plugins-hub-skeleton");
  if (existing) existing.remove();
  if (!document.getElementById("plugins-hub-list")) {
    section.innerHTML = renderPluginsHubHtml();
  }

  const listEl = document.getElementById("plugins-hub-list");
  if (!listEl) return;

  let plugins: PluginInfo[] = [];
  try {
    const resp = await typedCall("PluginsService.ListPlugins", null, null, PluginsListResultSchema);
    plugins = resp.plugins.map(pluginInfoFromProto);
  } catch (e: any) {
    listEl.innerHTML = `<p style="color:#ef4444;font-size:11px;">Failed to list plugins: ${e.message || e}</p>`;
    return;
  }

  if (plugins.length === 0) {
    listEl.innerHTML = `
      <div style="font-size: 11px; color: #555; padding: 8px 0; line-height: 1.6;">
        No plugins discovered.<br />
        Drop a plugin folder at <code style="font-family:monospace;">plugins/&lt;name&gt;/manifest.json</code> in the
        workspace root, then return here. (Custom <code style="font-family:monospace;">CURATOR_DATA_DIR</code> / <code style="font-family:monospace;">--data-dir</code>
        configurations are not scanned for plugins.)
      </div>`;
    return;
  }

  listEl.innerHTML = plugins.map(pluginRowHtml).join("");

  const rerenderHub = () => setupPluginsHub();

  listEl.querySelectorAll<HTMLInputElement>(".plugin-enabled-toggle").forEach((cb) => {
    cb.addEventListener("change", async () => {
      const row = cb.closest<HTMLElement>(".plugin-row");
      const name = row?.dataset.pluginName || "";
      if (!name) return;
      try {
        await typedCall(
          "PluginsService.SetPluginEnabled",
          SetPluginEnabledRequestSchema,
          { pluginName: name, enabled: cb.checked },
          EmptySchema,
        );
        await initPlugins();
        rerenderHub();
      } catch (e: any) {
        showErrorAlert("Failed to update plugin state:\n" + (e.message || e));
        cb.checked = !cb.checked;
      }
    });
  });

  listEl.querySelectorAll<HTMLInputElement>(".plugin-autoload-toggle").forEach((cb) => {
    cb.addEventListener("change", () => {
      const row = cb.closest<HTMLElement>(".plugin-row");
      const name = row?.dataset.pluginName || "";
      if (!name) return;
      setPluginAutoloadEnabled(name, cb.checked);
    });
  });

  listEl.querySelectorAll<HTMLButtonElement>(".plugin-validate-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest<HTMLElement>(".plugin-row");
      const name = row?.dataset.pluginName || "";
      const plugin = plugins.find((p) => p.name === name);
      const resultEl = row?.querySelector<HTMLElement>(".plugin-validate-result");
      if (!plugin || !resultEl) return;

      btn.disabled = true;
      btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Validating...';
      resultEl.style.display = "block";
      resultEl.textContent = "Validating...";

      try {
        const r = await typedCall(
          "PluginsService.ValidatePlugin",
          ValidatePluginRequestSchema,
          { manifestPath: plugin.manifest_path },
          ValidationResultSchema,
        );
        resultEl.style.color = r.valid ? "#107c41" : "#a80000";
        resultEl.innerHTML = r.valid
          ? `<i class="bi bi-check-circle"></i> Valid: ${r.name} v${r.version}`
          : `<i class="bi bi-x-circle"></i> Invalid: ${r.error || "unknown error"}`;
      } catch (e: any) {
        resultEl.style.color = "#a80000";
        resultEl.textContent = "Validation failed: " + (e.message || e);
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-shield-check"></i> Validate';
      }
    });
  });

  document.getElementById("plugins-enable-all-btn")?.addEventListener("click", async () => {
    await setAllPluginsEnabled(plugins, true, rerenderHub);
  });
  document.getElementById("plugins-disable-all-btn")?.addEventListener("click", async () => {
    await setAllPluginsEnabled(plugins, false, rerenderHub);
  });
  document.getElementById("plugins-autoload-all-btn")?.addEventListener("click", () => {
    for (const p of plugins) {
      setPluginAutoloadEnabled(p.name, true);
    }
    rerenderHub();
  });
  document.getElementById("plugins-autoload-none-btn")?.addEventListener("click", () => {
    for (const p of plugins) {
      setPluginAutoloadEnabled(p.name, false);
    }
    rerenderHub();
  });
}

async function setAllPluginsEnabled(plugins: PluginInfo[], enabled: boolean, rerender: () => void) {
  for (const p of plugins) {
    try {
      await typedCall(
        "PluginsService.SetPluginEnabled",
        SetPluginEnabledRequestSchema,
        { pluginName: p.name, enabled },
        EmptySchema,
      );
    } catch (e: any) {
      console.error(`Failed to ${enabled ? "enable" : "disable"} ${p.name}:`, e);
    }
  }
  await initPlugins();
  rerender();
}
