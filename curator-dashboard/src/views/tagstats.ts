import { callService } from "../ipc";
import { switchToSearchWithTag } from "./search";

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

    const categories = ["character", "copyright", "meta", "user"];
    const grouped: Record<string, any[]> = {};
    for (const cat of categories) grouped[cat] = [];
    grouped["other"] = [];

    for (const t of tags) {
      const key = categories.includes(t.category) ? t.category : "other";
      grouped[key].push(t);
    }

    const categoryLabels: Record<string, { label: string; color: string }> = {
      character: { label: "Character", color: "#0c5460" },
      copyright: { label: "Copyright", color: "#511c74" },
      meta: { label: "Meta", color: "#383d41" },
      user: { label: "User", color: "#856404" },
      other: { label: "Other", color: "#4a4a4a" },
    };

    let html = "";
    let catIdx = 0;
    for (const [cat, catTags] of Object.entries(grouped)) {
      if (catTags.length === 0) continue;
      const info = categoryLabels[cat] || categoryLabels.other;
      const maxCount = Math.max(...catTags.map(t => t.count));
      html += `<div class="tagstats-category">
        <div class="tagstats-category-header">
          <div class="tagstats-category-title" style="color: ${info.color};">${info.label} <span class="tagstats-count">(${catTags.length})</span></div>
          <button class="win-button tagstats-chart-toggle" data-chart="chart-${catIdx}" style="font-size: 10px;"><i class="bi bi-bar-chart"></i> Chart</button>
        </div>
        <div class="tagstats-chart" id="chart-${catIdx}" style="display: none;">`;
      for (const t of catTags) {
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
      for (const t of catTags) {
        html += `<span class="tag-pill tagstats-pill tag-${cat || 'tag-rank-3'}" data-tag="${t.tag}" title="${t.tag} (${t.count} images)">${t.tag.replace(/_/g, '_\u200B')} <span class="tagstats-badge">${t.count}</span></span>`;
      }
      html += `</div></div>`;
      catIdx++;
    }
    container.innerHTML = html;

    container.querySelectorAll<HTMLElement>(".tagstats-chart-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const chartId = btn.getAttribute("data-chart");
        const chart = document.getElementById(chartId || "");
        if (chart) {
          const visible = chart.style.display !== "none";
          chart.style.display = visible ? "none" : "block";
          btn.innerHTML = visible
            ? '<i class="bi bi-bar-chart"></i> Chart'
            : '<i class="bi bi-list"></i> Pills';
        }
      });
    });

    container.querySelectorAll<HTMLElement>(".tagstats-bar-row").forEach((row) => {
      row.addEventListener("click", () => {
        const tagName = row.getAttribute("data-tag");
        if (tagName) switchToSearchWithTag(tagName);
      });
    });

    container.querySelectorAll<HTMLElement>(".tagstats-pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        const tagName = pill.getAttribute("data-tag");
        if (tagName) switchToSearchWithTag(tagName);
      });
    });
  } catch (e: any) {
    container.innerHTML = `<p style="color: #a80000;">Error: ${e.message || e}</p>`;
  }
}
