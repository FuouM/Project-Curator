import { callService } from "../ipc";
import { initPlugins } from "../plugin-host";
import { PluginInfo } from "../types";
import { SafeHtml, html } from "../components";
import { showErrorAlert } from "../alert";

export function renderPluginsHubHtml(): SafeHtml {
  return html`
    <div class="group-box">
      <div class="group-box-title">Installed Plugins</div>
      <div style="display: flex; justify-content: flex-end; gap: 6px; margin-bottom: 10px;">
        <button type="button" class="win-button" id="plugins-enable-all-btn"><i class="bi bi-check2-all"></i> Enable All</button>
        <button type="button" class="win-button" id="plugins-disable-all-btn"><i class="bi bi-x-lg"></i> Disable All</button>
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
    "sidecar_db": "tag-meta",
  };
  const cls = classes[perm] || "tag-meta";
  return `<span class="tag-pill ${cls}" style="font-size: 9px; font-family: monospace;">${perm}</span>`;
}

function pluginRowHtml(p: PluginInfo): string {
  const statusBadge = p.loaded
    ? '<span class="tag-pill custom-concept" style="font-size: 9px;"><i class="bi bi-check-lg"></i> valid manifest</span>'
    : '<span class="tag-pill tag-meta" style="font-size: 9px;"><i class="bi bi-exclamation-triangle"></i> missing / invalid manifest</span>';

  const permsHtml = p.permissions.length > 0
    ? p.permissions.map(permissionBadge).join(" ")
    : '<span style="color:#999;font-size:10px;">none</span>';

  const hooksText = p.hooks.length > 0 ? `${p.hooks.length} hooks` : "no hooks";

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
          <label style="display: flex; align-items: center; gap: 6px; font-size: 11px; cursor: pointer;">
            <input type="checkbox" class="plugin-enabled-toggle" ${p.enabled ? "checked" : ""} />
            <span class="${p.enabled ? "" : "plugin-disabled-label"}">${p.enabled ? "Enabled" : "Disabled"}</span>
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
    const resp = await callService({ ListPlugins: null });
    if ("PluginsListResult" in resp) {
      plugins = resp.PluginsListResult.plugins;
    } else if ("Error" in resp) {
      showErrorAlert("Failed to list plugins:\n" + resp.Error.message);
    }
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
        const resp = await callService({ SetPluginEnabled: { plugin_name: name, enabled: cb.checked } });
        if (!("Success" in resp)) {
          showErrorAlert("Failed to update plugin state: " + (("Error" in resp) ? resp.Error.message : "unknown"));
          cb.checked = !cb.checked;
          return;
        }
        await initPlugins();
        rerenderHub();
      } catch (e: any) {
        showErrorAlert("Failed to update plugin state:\n" + (e.message || e));
        cb.checked = !cb.checked;
      }
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
        const resp = await callService({ ValidatePlugin: { manifest_path: plugin.manifest_path } });
        if ("ValidationResult" in resp) {
          const r = resp.ValidationResult;
          resultEl.style.color = r.valid ? "#107c41" : "#a80000";
          resultEl.innerHTML = r.valid
            ? `<i class="bi bi-check-circle"></i> Valid: ${r.name} v${r.version}`
            : `<i class="bi bi-x-circle"></i> Invalid: ${r.error || "unknown error"}`;
        } else if ("Error" in resp) {
          resultEl.style.color = "#a80000";
          resultEl.textContent = "Validation failed: " + resp.Error.message;
        }
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
}

async function setAllPluginsEnabled(plugins: PluginInfo[], enabled: boolean, rerender: () => void) {
  for (const p of plugins) {
    try {
      await callService({ SetPluginEnabled: { plugin_name: p.name, enabled } });
    } catch (e: any) {
      console.error(`Failed to ${enabled ? "enable" : "disable"} ${p.name}:`, e);
    }
  }
  await initPlugins();
  rerender();
}
