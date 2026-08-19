/**
 * Series detail view: metadata + volume/chapter list, follow toggle, cache
 * refresh. Every permalink comes from the series JSON (never guessed); the
 * "chapter → reader" route carries the full ordered chapter list for prev/next.
 */

import { Route, ChapterRef, decodeEntities, navigate, setActions, setBanner } from "./state";
import {
  SeriesProgressRow,
  followSeries,
  getCachedPageCounts,
  getFollowedSeriesRow,
  getHistoryPermalinks,
  getProgressForSeries,
  unfollowSeries,
} from "./db";
import { Series, SeriesTag, fetchSeries, getSeriesCover, openExternal } from "./api";
import { renderTagPill } from "./components/tag-pill";
import { renderCoverImage } from "./components/cover";
import { renderLoading } from "./components/loading";

interface ChapterMeta extends ChapterRef {
  volumeHeader?: string;
}

export function renderSeries(container: HTMLElement, route: Route): void {
  container.innerHTML = "";
  const permalink = route.seriesPermalink;
  if (!permalink) {
    setBanner("Missing series permalink.");
    return;
  }
  void load(container, permalink, false);
}

async function load(container: HTMLElement, permalink: string, force: boolean): Promise<void> {
  container.innerHTML = "";
  container.appendChild(renderLoading());

  let series: Series;
  try {
    series = await fetchSeries(permalink, force);
  } catch (err) {
    container.innerHTML = "";
    const msg = err instanceof Error ? err.message : String(err);
    setBanner(`Failed to load series: ${msg}`);
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "win-button";
    retry.innerHTML = '<i class="bi bi-arrow-clockwise"></i> Retry';
    retry.addEventListener("click", () => void load(container, permalink, false));
    container.appendChild(retry);
    return;
  }

  let coverPath: string | null = null;
  try {
    coverPath = await getSeriesCover(permalink, series.cover);
  } catch {
    // Cover is decorative; a failed download must not block the page.
  }

  const followed = await getFollowedSeriesRow(permalink);
  const chapters = collectChapters(series);
  const chapterPermalinks = chapters.map((c) => c.permalink);

  let progress = new Map<string, SeriesProgressRow>();
  let cacheCounts = new Map<string, number>();
  let readHistorySet = new Set<string>();
  try {
    const [p, c, h] = await Promise.all([
      getProgressForSeries(permalink),
      getCachedPageCounts(chapterPermalinks),
      getHistoryPermalinks(chapterPermalinks),
    ]);
    progress = new Map(p.map((r) => [r.chapter_permalink, r]));
    cacheCounts = new Map(c.map((r) => [r.chapter_permalink, r.n]));
    readHistorySet = h;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setBanner(`Progress data failed to load: ${msg}`);
  }

  container.innerHTML = "";
  buildBody(container, series, coverPath, chapters, progress, cacheCounts, readHistorySet);
  buildActions(container, series, coverPath, followed !== null, chapters);
}

function collectChapters(series: Series): ChapterMeta[] {
  const out: ChapterMeta[] = [];
  let volumeHeader: string | undefined;
  for (const t of series.taggings ?? []) {
    if (t.header) {
      volumeHeader = t.header;
      continue;
    }
    if (t.title && t.permalink) {
      out.push({
        title: t.title,
        permalink: t.permalink,
        released_on: t.released_on,
        volumeHeader,
      });
    }
  }
  return out;
}

function coverEl(coverPath: string | null, alt: string): HTMLElement {
  return renderCoverImage(coverPath, alt, "ds-cover", "ds-cover-placeholder");
}

function metaRow(label: string, tags: SeriesTag[]): HTMLElement | null {
  if (!tags || tags.length === 0) return null;
  const row = document.createElement("div");
  row.className = "ds-meta-row";

  const lbl = document.createElement("span");
  lbl.className = "ds-meta-label";
  lbl.textContent = label;
  row.appendChild(lbl);

  const pillsWrap = document.createElement("div");
  pillsWrap.className = "ds-meta-pills";
  for (const t of tags) {
    pillsWrap.appendChild(renderTagPill(t, false));
  }
  row.appendChild(pillsWrap);

  return row;
}

function renderSanitizedDescription(container: HTMLElement, htmlOrText: string): void {
  container.innerHTML = "";
  if (!htmlOrText) return;

  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlOrText, "text/html");

  const walk = (node: Node, parentEl: HTMLElement): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = decodeEntities(node.textContent || "");
      if (text) {
        parentEl.appendChild(document.createTextNode(text));
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      const tag = el.tagName.toLowerCase();

      if (tag === "p") {
        const p = document.createElement("p");
        p.style.cssText = "margin:4px 0;";
        for (const child of Array.from(el.childNodes)) {
          walk(child, p);
        }
        if (p.childNodes.length > 0) {
          parentEl.appendChild(p);
        }
      } else if (tag === "br") {
        parentEl.appendChild(document.createElement("br"));
      } else if (tag === "a") {
        const href = el.getAttribute("href") || "";
        const text = decodeEntities(el.textContent?.trim() || "");
        if (href) {
          const a = document.createElement("a");
          a.className = "ds-external-link";
          a.style.cssText =
            "color:var(--sys-primary,#0078d4);text-decoration:underline;cursor:pointer;word-break:break-all;";
          // Show both the text and the full link
          if (text && text !== href) {
            a.textContent = `${text} — ${href}`;
          } else {
            a.textContent = href;
          }
          a.title = href;
          a.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            void openExternal(href);
          });
          parentEl.appendChild(a);
        } else {
          parentEl.appendChild(document.createTextNode(text));
        }
      } else if (tag === "b" || tag === "strong") {
        const b = document.createElement("strong");
        for (const child of Array.from(el.childNodes)) {
          walk(child, b);
        }
        parentEl.appendChild(b);
      } else if (tag === "i" || tag === "em") {
        const em = document.createElement("em");
        for (const child of Array.from(el.childNodes)) {
          walk(child, em);
        }
        parentEl.appendChild(em);
      } else {
        for (const child of Array.from(el.childNodes)) {
          walk(child, parentEl);
        }
      }
    }
  };

  for (const child of Array.from(doc.body.childNodes)) {
    walk(child, container);
  }
}

function buildBody(
  container: HTMLElement,
  series: Series,
  coverPath: string | null,
  chapters: ChapterMeta[],
  progress: Map<string, SeriesProgressRow>,
  cacheCounts: Map<string, number>,
  readHistorySet: Set<string>,
): void {
  const head = document.createElement("div");
  head.className = "ds-series-head";
  head.appendChild(coverEl(coverPath, series.name));

  const info = document.createElement("div");
  info.className = "ds-fill";
  const name = document.createElement("div");
  name.style.cssText = "font-size:14px;font-weight:600;";
  name.textContent = decodeEntities(series.name);
  const typeLine = document.createElement("div");
  typeLine.className = "ds-muted";
  typeLine.textContent = series.type ?? "Series";
  info.appendChild(name);
  info.appendChild(typeLine);

  if (series.description) {
    const desc = document.createElement("div");
    desc.className = "ds-series-desc";
    renderSanitizedDescription(desc, series.description);
    info.appendChild(desc);
  }

  if (series.link) {
    const linkRow = document.createElement("div");
    linkRow.className = "ds-series-desc";
    linkRow.style.cssText = "margin:4px 0;";
    const a = document.createElement("a");
    a.className = "ds-external-link";
    a.style.cssText =
      "color:var(--sys-primary,#0078d4);text-decoration:underline;cursor:pointer;word-break:break-all;";
    a.textContent = `Official / Source Link — ${series.link}`;
    a.title = series.link;
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      void openExternal(series.link!);
    });
    linkRow.appendChild(a);
    info.appendChild(linkRow);
  }

  // Group tags into categorized rows: Author, Scanlation Group, Doujin/Parody, Pairings, Characters, Status/Format, and Tags
  const allTags = series.tags ?? [];
  const authorTags: SeriesTag[] = [];
  const groupMap = new Map<string, SeriesTag>();
  const doujinTags: SeriesTag[] = [];
  const pairingTags: SeriesTag[] = [];
  const characterTags: SeriesTag[] = [];
  const statusTags: SeriesTag[] = [];
  const otherTags: SeriesTag[] = [];

  for (const t of allTags) {
    const type = (t.type ?? "").toLowerCase();
    const nameLower = (t.name ?? "").toLowerCase();
    if (type === "author" || type === "artist") {
      authorTags.push(t);
    } else if (type === "scanlator" || type === "group") {
      groupMap.set(t.permalink || t.name, t);
    } else if (
      type === "doujin" ||
      type === "doujinshi" ||
      type === "copyright" ||
      type === "parody"
    ) {
      doujinTags.push(t);
    } else if (type === "pairing") {
      pairingTags.push(t);
    } else if (type === "character") {
      characterTags.push(t);
    } else if (
      type === "status" ||
      type === "format" ||
      nameLower === "oneshot" ||
      nameLower === "one-shot" ||
      nameLower === "anthology" ||
      nameLower === "completed" ||
      nameLower === "ongoing" ||
      nameLower === "discontinued" ||
      nameLower === "hiatus"
    ) {
      statusTags.push(t);
    } else {
      otherTags.push(t);
    }
  }

  // Also collect any scanlation groups from chapter taggings if not in series.tags
  for (const tagging of series.taggings ?? []) {
    for (const t of tagging.tags ?? []) {
      const type = (t.type ?? "").toLowerCase();
      if (type === "scanlator" || type === "group") {
        if (!groupMap.has(t.permalink || t.name)) {
          groupMap.set(t.permalink || t.name, t);
        }
      }
    }
  }
  const groupTags = Array.from(groupMap.values());

  const metaRows = document.createElement("div");
  metaRows.className = "ds-meta-rows";

  const authorRow = metaRow("Author:", authorTags);
  if (authorRow) metaRows.appendChild(authorRow);

  const groupRow = metaRow("Scanlation Group:", groupTags);
  if (groupRow) metaRows.appendChild(groupRow);

  const doujinRow = metaRow("Doujin:", doujinTags);
  if (doujinRow) metaRows.appendChild(doujinRow);

  const pairingRow = metaRow("Pairings:", pairingTags);
  if (pairingRow) metaRows.appendChild(pairingRow);

  const characterRow = metaRow("Characters:", characterTags);
  if (characterRow) metaRows.appendChild(characterRow);

  const statusRow = metaRow("Status / Format:", statusTags);
  if (statusRow) metaRows.appendChild(statusRow);

  const tagsRow = metaRow("Tags:", otherTags);
  if (tagsRow) metaRows.appendChild(tagsRow);

  if (authorRow || groupRow || doujinRow || pairingRow || characterRow || statusRow || tagsRow) {
    info.appendChild(metaRows);
  }

  head.appendChild(info);
  container.appendChild(head);

  if (series.taggables && series.taggables.length > 0) {
    const taggablesGroup = document.createElement("div");
    taggablesGroup.className = "group-box";
    taggablesGroup.style.cssText = "margin-top:10px;";
    taggablesGroup.innerHTML = `<div class="group-box-title"><i class="bi bi-collection"></i> Series &amp; Anthologies (${series.taggables.length})</div>`;

    const taggablesGrid = document.createElement("div");
    taggablesGrid.style.cssText =
      "display:grid;grid-template-columns:repeat(auto-fill, minmax(200px, 1fr));gap:6px;margin-top:4px;";

    for (const tg of series.taggables) {
      const card = document.createElement("div");
      card.className = "ds-row";
      card.style.cssText =
        "padding:4px 6px;background:var(--sys-bg-active, #f5f5f5);border:1px solid var(--sys-border-light, #e0e0e0);border-radius:3px;cursor:pointer;align-items:center;gap:6px;";
      card.innerHTML = `<i class="bi bi-book" style="color:var(--sys-primary,#0078d4);"></i><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-weight:500;">${decodeEntities(tg.name)}</span><span class="ds-muted" style="font-size:10px;">${tg.type}</span>`;
      card.addEventListener("click", () => {
        navigate({
          view: "series",
          seriesPermalink: tg.permalink,
          seriesName: tg.name,
        });
      });
      taggablesGrid.appendChild(card);
    }
    taggablesGroup.appendChild(taggablesGrid);
    container.appendChild(taggablesGroup);
  }

  if (chapters.length === 0) {
    if (!series.taggables || series.taggables.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ds-muted";
      empty.style.cssText = "margin-top:12px;";
      empty.textContent = "This entry has no chapters or series listed here.";
      container.appendChild(empty);
    }
    return;
  }

  let sortOrder: "asc" | "desc" = "asc";

  const chapterSection = document.createElement("div");
  chapterSection.style.cssText = "display:flex;flex-direction:column;gap:6px;margin-top:10px;";

  const chapterHeader = document.createElement("div");
  chapterHeader.className = "ds-row";
  chapterHeader.style.cssText =
    "justify-content:space-between;align-items:center;padding:4px 2px;border-bottom:1px solid var(--sys-border-light, #ddd);";

  const chapterCount = document.createElement("div");
  chapterCount.style.cssText = "font-size:12px;font-weight:600;";
  chapterCount.textContent = `Chapters (${chapters.length})`;

  const sortBtn = document.createElement("button");
  sortBtn.type = "button";
  sortBtn.className = "win-button";
  sortBtn.style.cssText = "font-size:11px;padding:2px 8px;";

  const updateSortBtn = () => {
    sortBtn.innerHTML =
      sortOrder === "asc"
        ? '<i class="bi bi-sort-numeric-down"></i> Sort: Ascending'
        : '<i class="bi bi-sort-numeric-down-alt"></i> Sort: Descending';
    sortBtn.title =
      sortOrder === "asc"
        ? "Oldest first (click to sort newest first)"
        : "Newest first (click to sort oldest first)";
  };
  updateSortBtn();

  chapterHeader.appendChild(chapterCount);
  chapterHeader.appendChild(sortBtn);
  chapterSection.appendChild(chapterHeader);

  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-direction:column;";
  chapterSection.appendChild(list);

  const renderChapters = () => {
    list.innerHTML = "";
    const items = sortOrder === "asc" ? chapters : [...chapters].reverse();
    let lastVolume: string | undefined;
    for (const ch of items) {
      if (ch.volumeHeader && ch.volumeHeader !== lastVolume) {
        lastVolume = ch.volumeHeader;
        const h = document.createElement("div");
        h.className = "ds-vol-header";
        h.textContent = ch.volumeHeader;
        list.appendChild(h);
      }
      list.appendChild(
        chapterRow(
          ch,
          progress.get(ch.permalink),
          cacheCounts.get(ch.permalink) ?? 0,
          chapters,
          series.permalink,
          series.name,
          readHistorySet.has(ch.permalink),
        ),
      );
    }
  };

  sortBtn.addEventListener("click", () => {
    sortOrder = sortOrder === "asc" ? "desc" : "asc";
    updateSortBtn();
    renderChapters();
  });

  renderChapters();
  container.appendChild(chapterSection);
}

function chapterRow(
  ch: ChapterMeta,
  prog: SeriesProgressRow | undefined,
  cachedCount: number,
  chapterList: ChapterMeta[],
  seriesPermalink: string,
  seriesName: string,
  isReadInHistory: boolean,
): HTMLElement {
  const row = document.createElement("div");
  const isCompleted = prog?.completed === 1;
  const isRead = isCompleted || isReadInHistory;
  const isFullyCached =
    cachedCount > 0 && (prog && prog.page_total > 0 ? cachedCount >= prog.page_total : true);
  row.className = `ds-chapter-row${isRead ? " ds-chapter-read" : ""}`;

  const title = document.createElement("div");
  title.className = "ds-chapter-title";
  title.style.cssText = "display:inline-flex;align-items:center;gap:4px;";
  title.innerHTML = `<span>${decodeEntities(ch.title)}</span>${
    isFullyCached
      ? '<i class="bi bi-cloud-check-fill ds-offline-icon" style="color:var(--sys-primary,#0078d4);font-size:11px;" title="Available Offline (Fully Cached)"></i>'
      : ""
  }`;
  row.appendChild(title);

  const badges: string[] = [];
  if (isCompleted) {
    badges.push("✓ Completed");
  } else if (prog && prog.page_index > 0) {
    badges.push(`page ${prog.page_index + 1}/${prog.page_total}`);
  } else if (isReadInHistory) {
    badges.push("✓ Read");
  }
  if (cachedCount > 0) {
    badges.push(`${cachedCount} cached`);
  }
  if (ch.released_on) {
    badges.push(ch.released_on);
  }
  if (badges.length > 0) {
    const badge = document.createElement("div");
    badge.className = "ds-chapter-badge";
    badge.textContent = badges.join(" · ");
    row.appendChild(badge);
  }

  row.addEventListener("click", () => {
    navigate({
      view: "reader",
      seriesPermalink,
      chapterPermalink: ch.permalink,
      chapterTitle: ch.title,
      seriesName,
      chapterList,
      startPage: prog && prog.completed !== 1 ? prog.page_index : 0,
    });
  });

  return row;
}

function buildActions(
  container: HTMLElement,
  series: Series,
  coverPath: string | null,
  followed: boolean,
  chapters: ChapterMeta[],
): void {
  const seriesPermalink = series.permalink;
  const seriesName = series.name;
  const latest = chapters[chapters.length - 1];

  const toggleFollow = async (btn: HTMLButtonElement): Promise<void> => {
    btn.disabled = true;
    try {
      if (followed) {
        await unfollowSeries(seriesPermalink);
        setBanner(`Unfollowed "${seriesName}".`);
      } else {
        await followSeries({
          permalink: seriesPermalink,
          name: seriesName,
          cover: coverPath,
          latestChapterPermalink: latest?.permalink ?? null,
          latestChapterTitle: latest?.title ?? null,
        });
        setBanner(`Following "${seriesName}".`);
      }
      void load(container, seriesPermalink, false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setBanner(`Follow toggle failed: ${msg}`);
      btn.disabled = false;
    }
  };

  setActions((host) => {
    const followBtn = document.createElement("button");
    followBtn.type = "button";
    followBtn.className = "win-button";
    followBtn.innerHTML = followed
      ? '<i class="bi bi-bookmark-check-fill"></i> Following'
      : '<i class="bi bi-bookmark"></i> Follow';
    followBtn.addEventListener("click", () => void toggleFollow(followBtn));
    host.appendChild(followBtn);

    const refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.className = "win-button";
    refreshBtn.title = "Re-fetch series data from the server";
    refreshBtn.innerHTML = '<i class="bi bi-arrow-clockwise"></i> Refresh';
    refreshBtn.addEventListener("click", () => {
      void load(container, seriesPermalink, true);
    });
    host.appendChild(refreshBtn);

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "win-button";
    openBtn.title = "Open this series in your browser";
    openBtn.innerHTML = '<i class="bi bi-box-arrow-up-right"></i>';
    openBtn.addEventListener("click", () => {
      void openExternal(`https://dynasty-scans.com/series/${seriesPermalink}`);
    });
    host.appendChild(openBtn);
  });
}
