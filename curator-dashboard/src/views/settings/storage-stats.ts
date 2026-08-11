import { typedCall } from "../../ipc";
import { StorageStatsResultSchema } from "../../gen/folders_pb";

export async function initStorageStats() {
  const totalDisplay = document.getElementById("storage-total-display");
  const container = document.getElementById("storage-visual-container");
  const tabBar = document.getElementById("storage-tab-bar");
  const tabPie = document.getElementById("storage-tab-pie");
  const tabTree = document.getElementById("storage-tab-tree");

  if (!container) return;

  container.innerHTML = '<div style="font-size:11px;color:#888;"><i class="bi bi-hourglass-split"></i> Loading storage stats...</div>';

  try {
    const resp = await typedCall("FoldersService.GetStorageStats", null, null, StorageStatsResultSchema);
    if (!resp.stats) {
      container.innerHTML = '<div style="font-size:11px;color:#dc3545;">Failed to load storage statistics.</div>';
      return;
    }

    const stats = resp.stats.stats;

    // Helper: format bytes to human readable
    const formatBytes = (bytes: number): string => {
      if (bytes === 0) return "0 Bytes";
      const k = 1024;
      const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
    };

    // Calculate totals
    const totalBytes = stats.reduce((acc: number, s: any) => acc + Number(s.sizeBytes), 0);
    const totalCount = stats.reduce((acc: number, s: any) => acc + Number(s.count), 0);
    if (totalDisplay) {
      totalDisplay.textContent = `Total Storage: ${formatBytes(totalBytes)} (${totalCount} file(s))`;
    }

    // Group stats by Category: Images, GIFs, Videos, Other
    // Initial rich visualization colors restored
    const categoriesMap: Record<string, { size: number; count: number; color: string; textColor: string; borderColor: string; exts: string[] }> = {
      "Images": { size: 0, count: 0, color: "#0078d7", textColor: "#ffffff", borderColor: "#005499", exts: [] },
      "GIFs": { size: 0, count: 0, color: "#28a745", textColor: "#ffffff", borderColor: "#1e7e34", exts: [] },
      "Videos": { size: 0, count: 0, color: "#e0a800", textColor: "#ffffff", borderColor: "#b38600", exts: [] },
      "Other": { size: 0, count: 0, color: "#6c757d", textColor: "#ffffff", borderColor: "#545b62", exts: [] },
    };

    for (const stat of stats) {
      const cat = stat.category;
      if (categoriesMap[cat]) {
        categoriesMap[cat].size += Number(stat.sizeBytes);
        categoriesMap[cat].count += Number(stat.count);
        categoriesMap[cat].exts.push(stat.extension);
      } else {
        categoriesMap["Other"].size += Number(stat.sizeBytes);
        categoriesMap["Other"].count += Number(stat.count);
        categoriesMap["Other"].exts.push(stat.extension);
      }
    }

    const categories = Object.entries(categoriesMap)
      .map(([name, data]) => ({
        name,
        size: data.size,
        count: data.count,
        color: data.color,
        textColor: data.textColor,
        borderColor: data.borderColor,
        percentage: totalBytes > 0 ? (data.size / totalBytes) * 100 : 0,
        exts: data.exts,
      }))
      .filter(c => c.size > 0 || c.count > 0);

    let activeTab: "bar" | "pie" | "tree" = "bar";

    const updateTabs = (selected: "bar" | "pie" | "tree") => {
      activeTab = selected;
      [tabBar, tabPie, tabTree].forEach(t => t?.classList.remove("active"));
      if (selected === "bar") tabBar?.classList.add("active");
      if (selected === "pie") tabPie?.classList.add("active");
      if (selected === "tree") tabTree?.classList.add("active");
      renderChart();
    };

    tabBar?.addEventListener("click", () => updateTabs("bar"));
    tabPie?.addEventListener("click", () => updateTabs("pie"));
    tabTree?.addEventListener("click", () => updateTabs("tree"));

    const renderChart = () => {
      if (totalBytes === 0) {
        container.innerHTML = '<div style="font-size:11px;color:#888;font-style:italic;">No media files indexed yet.</div>';
        return;
      }

      if (activeTab === "bar") {
        renderStackedBar();
      } else if (activeTab === "pie") {
        renderPieChart();
      } else {
        renderTreemap();
      }
    };

    const renderStackedBar = () => {
      let barSegments = "";
      let legendRows = "";

      categories.forEach(cat => {
        if (cat.size === 0) return;
        const w = cat.percentage;
        barSegments += `
          <div style="width: ${w}%; background: ${cat.color}; border: 1.5px solid ${cat.borderColor}; border-right: 1px solid var(--sys-border-dark); height: 100%; box-sizing: border-box;" 
               title="${cat.name}: ${formatBytes(cat.size)} (${cat.count} files, ${cat.percentage.toFixed(1)}%)">
          </div>
        `;

        legendRows += `
          <tr style="font-size:11px; border-bottom: 1px solid var(--sys-border-light);">
            <td style="width:14px;height:14px;padding:6px;"><div style="width:12px;height:12px;background:${cat.color};border:1.5px solid ${cat.borderColor};"></div></td>
            <td style="font-weight:600;padding:6px 8px;color:var(--sys-window-text);">${cat.name}</td>
            <td style="padding:6px 8px;text-align:right;color:var(--sys-window-text);">${formatBytes(cat.size)}</td>
            <td style="padding:6px 8px;text-align:right;color:#888;">${cat.count} file(s)</td>
            <td style="padding:6px 8px;text-align:right;font-weight:600;color:var(--sys-window-text);">${cat.percentage.toFixed(1)}%</td>
          </tr>
        `;
      });

      container.innerHTML = `
        <div style="width:100%;display:flex;flex-direction:column;gap:12px;">
          <div style="width:100%; height:32px; border:1px solid var(--sys-border-dark); background:#f0f0f0; border-radius:2px; display:flex; overflow:hidden; padding: 2px; box-sizing:border-box;">
            ${barSegments}
          </div>
          <table class="curator-table" style="width:100%;max-width:420px;margin-top:4px;border-collapse:collapse;">
            <thead>
              <tr style="border-bottom: 1px solid var(--sys-border-dark); color: #555; text-align:left; font-size:11px;">
                <th colspan="2" style="padding:4px 8px;">Category</th>
                <th style="padding:4px 8px;text-align:right;">Size</th>
                <th style="padding:4px 8px;text-align:right;">Count</th>
                <th style="padding:4px 8px;text-align:right;">Percentage</th>
              </tr>
            </thead>
            <tbody>${legendRows}</tbody>
          </table>
        </div>
      `;
    };

    const renderPieChart = () => {
      let accumulatedAngle = 0;
      let paths = "";
      let legendRows = "";

      categories.forEach(cat => {
        if (cat.size === 0) return;
        
        const percentage = cat.percentage / 100;
        const angle = percentage * 360;
        
        const r = 70; 
        const ir = 38; 
        
        const x1_out = 100 + r * Math.sin((accumulatedAngle * Math.PI) / 180);
        const y1_out = 100 - r * Math.cos((accumulatedAngle * Math.PI) / 180);
        const x1_in = 100 + ir * Math.sin((accumulatedAngle * Math.PI) / 180);
        const y1_in = 100 - ir * Math.cos((accumulatedAngle * Math.PI) / 180);
        
        accumulatedAngle += angle;
        
        const x2_out = 100 + r * Math.sin((accumulatedAngle * Math.PI) / 180);
        const y2_out = 100 - r * Math.cos((accumulatedAngle * Math.PI) / 180);
        const x2_in = 100 + ir * Math.sin((accumulatedAngle * Math.PI) / 180);
        const y2_in = 100 - ir * Math.cos((accumulatedAngle * Math.PI) / 180);
        
        const largeArc = percentage > 0.5 ? 1 : 0;
        
        const d = `
          M ${x1_out} ${y1_out}
          A ${r} ${r} 0 ${largeArc} 1 ${x2_out} ${y2_out}
          L ${x2_in} ${y2_in}
          A ${ir} ${ir} 0 ${largeArc} 0 ${x1_in} ${y1_in}
          Z
        `;
        
        paths += `<path d="${d}" fill="${cat.color}" stroke="${cat.borderColor}" stroke-width="1.5">
          <title>${cat.name}: ${formatBytes(cat.size)} (${cat.percentage.toFixed(1)}%)</title>
        </path>`;

        legendRows += `
          <tr style="font-size:11px; border-bottom:1px solid var(--sys-border-light);">
            <td style="width:14px;height:14px;padding:6px;"><div style="width:12px;height:12px;background:${cat.color};border:1.5px solid ${cat.borderColor};"></div></td>
            <td style="font-weight:600;padding:6px 8px;color:var(--sys-window-text);">${cat.name}</td>
            <td style="padding:6px 8px;text-align:right;color:var(--sys-window-text);">${formatBytes(cat.size)}</td>
            <td style="padding:6px 8px;text-align:right;font-weight:600;color:var(--sys-window-text);">${cat.percentage.toFixed(1)}%</td>
          </tr>
        `;
      });

      container.innerHTML = `
        <div style="width:100%;display:flex;align-items:center;justify-content:flex-start;gap:40px;flex-wrap:wrap;padding: 10px 0;margin-right:auto;">
          <svg width="200" height="200" viewBox="0 0 200 200" style="filter: drop-shadow(0px 1px 3px rgba(0,0,0,0.15)); margin: 0;">
            ${paths}
          </svg>
          <table class="curator-table" style="max-width:320px;flex:1;border-collapse:collapse;margin: 0;">
            <thead>
              <tr style="border-bottom: 1px solid var(--sys-border-dark); color: #555; text-align:left; font-size:11px;">
                <th colspan="2" style="padding:4px 8px;">Category</th>
                <th style="padding:4px 8px;text-align:right;">Size</th>
                <th style="padding:4px 8px;text-align:right;">Percentage</th>
              </tr>
            </thead>
            <tbody>${legendRows}</tbody>
          </table>
        </div>
      `;
    };

    const renderTreemap = () => {
      const width = 480;
      const height = 200;

      interface TreemapItem {
        name: string;
        size: number;
        color: string;
        percent: number;
        textColor: string;
        borderColor: string;
      }

      const items: TreemapItem[] = categories
        .filter(c => c.size > 0)
        .map(c => ({
          name: c.name,
          size: c.size,
          color: c.color,
          percent: c.percentage,
          textColor: c.textColor,
          borderColor: c.borderColor,
        }))
        .sort((a, b) => b.size - a.size);

      let rectsHtml = "";

      const divide = (
        x: number,
        y: number,
        w: number,
        h: number,
        itemList: TreemapItem[],
        vertical: boolean
      ) => {
        if (itemList.length === 0) return;
        if (itemList.length === 1) {
          const item = itemList[0];
          const label = w > 60 && h > 30 ? `<text x="${x + 8}" y="${y + 18}" fill="${item.textColor}" font-size="10" font-weight="600" font-family="'Segoe UI', -apple-system, sans-serif">${item.name}</text>
             <text x="${x + 8}" y="${y + 30}" fill="${item.textColor}" opacity="0.85" font-size="9" font-family="'Segoe UI', -apple-system, sans-serif">${formatBytes(item.size)}</text>` : "";
          rectsHtml += `
            <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${item.color}" stroke="${item.borderColor}" stroke-width="1.5">
              <title>${item.name}: ${formatBytes(item.size)} (${item.percent.toFixed(1)}%)</title>
            </rect>
            ${label}
          `;
          return;
        }

        const sumSize = itemList.reduce((acc: number, it: TreemapItem) => acc + it.size, 0);

        let balanceIndex = 1;
        let runningSum = itemList[0].size;
        for (let i = 1; i < itemList.length - 1; i++) {
          if (Math.abs(2 * (runningSum + itemList[i].size) - sumSize) < Math.abs(2 * runningSum - sumSize)) {
            runningSum += itemList[i].size;
            balanceIndex = i + 1;
          } else {
            break;
          }
        }

        const leftList = itemList.slice(0, balanceIndex);
        const rightList = itemList.slice(balanceIndex);

        const leftRatio = runningSum / sumSize;

        if (vertical) {
          const splitW = w * leftRatio;
          divide(x, y, splitW, h, leftList, !vertical);
          divide(x + splitW, y, w - splitW, h, rightList, !vertical);
        } else {
          const splitH = h * leftRatio;
          divide(x, y, w, splitH, leftList, !vertical);
          divide(x, y + splitH, w, h - splitH, rightList, !vertical);
        }
      };

      divide(0, 0, width, height, items, true);

      container.innerHTML = `
        <svg width="100%" height="200" viewBox="0 0 480 200" preserveAspectRatio="xMinYMid meet" style="border:1px solid var(--sys-border-dark);border-radius:2px;background:var(--sys-window-bg);margin-right:auto;">
          ${rectsHtml}
        </svg>
      `;
    };

    renderChart();

  } catch (err) {
    console.error("Failed to load storage stats:", err);
    container.innerHTML = '<div style="font-size:11px;color:#dc3545;">Error loading storage statistics.</div>';
  }
}