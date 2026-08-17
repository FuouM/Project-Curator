import { html, SafeHtml, ComponentMeta } from "./_shared";

export function renderPluginNavItemHtml(id: string, label: string, iconClass: string): SafeHtml {
  const viewKey = `extensions-${id}`;
  return html`<li class="nav-item" data-view="${viewKey}">
    <span><i class="${iconClass}"></i></span> ${label}
  </li>`;
}

export function renderSidebarHtml(activeView: string): SafeHtml {
  const navItem = (view: string, icon: string, label: string) =>
    html`<li class="nav-item${view === activeView ? " active" : ""}" data-view="${view}">
      <span><i class="${icon}"></i></span> ${label}
    </li>`;

  return html`
    <aside class="sidebar">
      <ul class="tree-view">
        <li class="tree-node">
          <div class="tree-node-title"><i class="bi bi-folder-fill"></i> Project Workspace</div>
          <ul class="tree-leaf-list">
            ${navItem("dashboard", "bi bi-bar-chart-line", "Dashboard")}
            ${navItem("gallery", "bi bi-image", "Gallery")}
            ${navItem("favorites", "bi bi-star", "Favorites")}
            ${navItem("tagstats", "bi bi-tags", "Tag Statistics")}
            ${navItem("folders", "bi bi-folder2-open", "Imported Folders")}
          </ul>
        </li>
        <li class="tree-node" style="margin-top: 10px;">
          <div class="tree-node-title"><i class="bi bi-folder-fill"></i> Operations</div>
          <ul class="tree-leaf-list">
            ${navItem("import", "bi bi-box-arrow-in-down", "Import Images")}
            ${navItem("search", "bi bi-search", "General Search")}
            ${navItem("characters", "bi bi-bounding-box", "Character Identities")}
            ${navItem("filename-parser", "bi bi-regex", "Filename Parser")}
            ${navItem("toolbox", "bi bi-tools", "Image Toolbox")}
          </ul>
        </li>
        <li class="tree-node" style="margin-top: 10px;">
          <div class="tree-node-title"><i class="bi bi-folder-fill"></i> Extensions</div>
          <ul class="tree-leaf-list">
            ${navItem("plugins", "bi bi-plug", "Plugins")}
          </ul>
          <ul class="tree-leaf-list" id="extensions-nav-list"></ul>
        </li>
        <li class="tree-node" style="margin-top: 10px;">
          <div class="tree-node-title"><i class="bi bi-folder-fill"></i> System Diagnostics</div>
          <ul class="tree-leaf-list">
            ${navItem("logs", "bi bi-journal-text", "Application Logs")}
            ${navItem("benchmark", "bi bi-speedometer", "Hardware Benchmark")}
            ${navItem("settings", "bi bi-gear", "Settings")}
            ${navItem("models", "bi bi-cpu", "Models")}
            ${navItem("components", "bi bi-palette", "Component Stylesheet")}
          </ul>
        </li>
      </ul>
    </aside>
  `;
}

export const meta: ComponentMeta = {
  name: "Navigation Sidebar",
  description:
    "WinForms TreeView-style sidebar navigation with chevron tree nodes, active indicators, and dynamic plugin child levels.",
  variants: [
    {
      name: "Sidebar Root & Tree Nodes",
      render: () => renderSidebarHtml("dashboard"),
    },
    {
      name: "Active View State",
      render: () => renderSidebarHtml("gallery"),
    },
    {
      name: "Plugin Nav Item",
      render: () => html`
        <ul class="tree-view">
          <li class="tree-node">
            <div class="tree-node-title"><i class="bi bi-folder-fill"></i> Extensions</div>
            <ul class="tree-leaf-list">
              ${renderPluginNavItemHtml("example", "Example Plugin", "bi bi-puzzle")}
            </ul>
          </li>
        </ul>
      `,
    },
  ],
};
