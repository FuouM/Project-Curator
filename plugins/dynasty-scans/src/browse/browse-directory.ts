import { decodeEntities, navigate } from "../state";
import { directoryGroups, fetchDirectory, openExternal } from "../api";
import { renderPager } from "../components/pager";
import { updateBrowseTopPager } from "./browse-controller";
import type { DirectoryGroup } from "../types/api";

export interface DirectoryReload {
  (host: HTMLElement, kind: "series" | "tags", page: number): Promise<void>;
}

/** Renders one alphabetical directory page (series or tags). */
export async function renderDirectory(
  host: HTMLElement,
  kind: "series" | "tags",
  page: number,
  reload: DirectoryReload,
): Promise<void> {
  const url = kind === "series" ? `/series.json?page=${page}` : `/tags.json?page=${page}`;
  const key = `${kind === "series" ? "dir:series" : "dir:tags"}:${page}`;
  const dir = await fetchDirectory(url, key);
  const groups: DirectoryGroup[] = directoryGroups(dir);

  if (groups.length === 0) {
    const empty = document.createElement("div");
    empty.className = "ds-muted";
    empty.textContent = "No entries on this page.";
    host.replaceChildren(empty);
    return;
  }

  const frag = document.createDocumentFragment();

  for (const group of groups) {
    const header = document.createElement("div");
    header.className = "ds-vol-header";
    header.textContent = group.letter;
    frag.appendChild(header);

    const list = document.createElement("div");
    list.style.cssText = "display:flex;flex-direction:column;";
    for (const entry of group.entries) {
      const item = document.createElement("div");
      item.className = "ds-item";
      item.style.cssText =
        "display:flex;align-items:center;justify-content:space-between;padding:3px 6px;";
      const title = document.createElement("div");
      title.className = "ds-item-title ds-fill ds-clickable";
      title.textContent = decodeEntities(entry.name);
      item.appendChild(title);

      const extBtn = document.createElement("button");
      extBtn.type = "button";
      extBtn.className = "win-button";
      extBtn.style.cssText = "font-size:10px;padding:1px 5px;flex-shrink:0;";
      extBtn.title = kind === "series" ? "Open series in browser" : "Search tag in browser";
      extBtn.innerHTML = '<i class="bi bi-box-arrow-up-right"></i>';
      extBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (kind === "series") {
          openExternal(`https://dynasty-scans.com/series/${entry.permalink}`);
        } else {
          openExternal(`https://dynasty-scans.com/search?q=${encodeURIComponent(entry.name)}`);
        }
      });
      item.appendChild(extBtn);

      if (kind === "series") {
        title.addEventListener("click", () => {
          navigate({
            view: "series",
            seriesPermalink: entry.permalink,
            seriesName: entry.name,
          });
        });
      } else {
        title.addEventListener("click", () => {
          void openExternal(`https://dynasty-scans.com/search?q=${encodeURIComponent(entry.name)}`);
        });
      }
      list.appendChild(item);
    }
    frag.appendChild(list);
  }

  const tabId = kind === "series" ? "series-dir" : "tags-dir";
  updateBrowseTopPager(dir.total_pages, dir.current_page, (p) => void reload(host, kind, p), tabId);

  frag.appendChild(
    renderPager(dir.total_pages, dir.current_page, (p) => void reload(host, kind, p)),
  );

  host.replaceChildren(frag);
}
