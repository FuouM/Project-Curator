import { callService } from "../ipc";
import { switchToSearchWithTag } from "./search";

const MAX_TAGS_PER_CATEGORY = 300;
const categories = ["character", "copyright", "meta", "user"];

const categoryLabels: Record<string, { label: string; color: string }> = {
  character: { label: "Character", color: "#0c5460" },
  copyright: { label: "Copyright", color: "#511c74" },
  meta: { label: "Meta", color: "#383d41" },
  user: { label: "User", color: "#856404" },
  other: { label: "Other", color: "#4a4a4a" },
};

let tagStatsGroups: Record<string, any[]> | null = null;

function renderTagCategorySection(cat: string, catIdx: number, expanded: boolean): string {
  const groups = tagStatsGroups;
  if (!groups) return "";
  const catTags = groups[cat] || [];
  if (catTags.length === 0) return "";

  const info = categoryLabels[cat] || categoryLabels.other;
  const maxCount = Math.max(...catTags.map(t => t.count));
  const showAll = expanded || catTags.length <= MAX_TAGS_PER_CATEGORY;
  const visible = showAll ? catTags : catTags.slice(0, MAX_TAGS_PER_CATEGORY);
  const remaining = showAll ? 0 : catTags.length - visible.length;

  let html = `<div class="tagstats-category" id="tagstats-cat-${catIdx}">
    <div class="tagstats-category-header">
      <div class="tagstats-category-title" style="color: ${info.color};">${info.label} <span class="tagstats-count">(${catTags.length})</span></div>
      <button class="win-button tagstats-chart-toggle" data-chart="chart-${catIdx}" style="font-size: 10px;"><i class="bi bi-bar-chart"></i> Chart</button>
    </div>
    <div class="tagstats-chart" id="chart-${catIdx}" style="display: none;">`;
  for (const t of visible) {
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
  for (const t of visible) {
    html += `<span class="tag-pill tagstats-pill tag-${cat || 'tag-rank-3'}" data-tag="${t.tag}" title="${t.tag} (${t.count} images)">${t.tag.replace(/_/g, '_\u200B')} <span class="tagstats-badge">${t.count}</span></span>`;
  }
  html += `</div>`;
  if (remaining > 0) {
    html += `<button class="win-button tagstats-show-all" data-cat="${cat}" data-idx="${catIdx}" style="font-size: 10px; margin-top: 4px;">Show all ${remaining} more</button>`;
  }
  html += `</div>`;
  return html;
}

function bindTagStatsContainer(container: HTMLElement) {
  container.onclick = (e) => {
    const target = e.target as HTMLElement;
    const chartToggle = target.closest<HTMLElement>(".tagstats-chart-toggle");
    if (chartToggle) {
      const chartId = chartToggle.getAttribute("data-chart");
      const chart = document.getElementById(chartId || "");
      if (chart) {
        const visible = chart.style.display !== "none";
        chart.style.display = visible ? "none" : "block";
        chartToggle.innerHTML = visible
          ? '<i class="bi bi-bar-chart"></i> Chart'
          : '<i class="bi bi-list"></i> Pills';
      }
      return;
    }

    const showAll = target.closest<HTMLElement>(".tagstats-show-all");
    if (showAll) {
      const cat = showAll.getAttribute("data-cat");
      const idx = showAll.getAttribute("data-idx");
      const section = idx ? document.getElementById(`tagstats-cat-${idx}`) : null;
      if (cat && section) {
        section.outerHTML = renderTagCategorySection(cat, parseInt(idx ?? "0", 10), true);
      }
      return;
    }

    const row = target.closest<HTMLElement>(".tagstats-bar-row");
    if (row) {
      const tagName = row.getAttribute("data-tag");
      if (tagName) switchToSearchWithTag(tagName);
      return;
    }

    const pill = target.closest<HTMLElement>(".tagstats-pill");
    if (pill) {
      const tagName = pill.getAttribute("data-tag");
      if (tagName) switchToSearchWithTag(tagName);
      return;
    }
  };
}

export async function refreshTagStats() {
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

    const grouped: Record<string, any[]> = {};
    for (const cat of categories) grouped[cat] = [];
    grouped["other"] = [];

    for (const t of tags) {
      const key = categories.includes(t.category) ? t.category : "other";
      grouped[key].push(t);
    }

    tagStatsGroups = grouped;

    let html = "";
    let catIdx = 0;
    for (const cat of Object.keys(grouped)) {
      html += renderTagCategorySection(cat, catIdx, false);
      if ((grouped[cat] || []).length > 0) catIdx++;
    }

    // Defer DOM mutation + binding to avoid blocking the layout/paint after IPC.
    requestAnimationFrame(() => {
      container.innerHTML = html;
      bindTagStatsContainer(container);
    });
  } catch (e: any) {
    container.innerHTML = `<p style="color: #a80000;">Error: ${e.message || e}</p>`;
  }
}

// ---------------------------------------------------------------------------
// HTML Template
// ---------------------------------------------------------------------------

export function renderTagstatsHtml(): string {
  return `
    <div class="group-box">
      <div class="group-box-title">Tag Distribution &amp; Statistics</div>
      <div id="tagstats-content">
        <p style="color: #666; font-style: italic;">Loading tag statistics...</p>
      </div>
    </div>
  `;
}
