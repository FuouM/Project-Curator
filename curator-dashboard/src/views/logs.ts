import { invoke } from "@tauri-apps/api/core";
import { SafeHtml, html } from "../components";
import { currentLogTab, setCurrentLogTab } from "../state";
import { showErrorAlert } from "../alert";

let fullLogLines: string[] = [];
let linesShownCount = 200;
let lastLogContent = "";
let isUserScrolling = false;
const logLineCache = new Map<string, string>();

function colorizeJsonHtml(jsonStr: string): string {
  return jsonStr.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, (match) => {
    let cls = 'color:#f59e0b'; // number
    if (/^"/.test(match)) {
      if (/:$/.test(match)) {
        cls = 'color:#a5b4fc; font-weight:600;'; // key
      } else {
        cls = 'color:#34d399'; // string
      }
    } else if (/true|false/.test(match)) {
      cls = 'color:#60a5fa; font-weight:600;'; // boolean
    } else if (/null/.test(match)) {
      cls = 'color:#f472b6'; // null
    }
    return `<span style="${cls}">${match}</span>`;
  });
}

function processLogLine(line: string): string {
  if (!line.trim()) return "";

  if (logLineCache.has(line)) {
    return logLineCache.get(line)!;
  }

  // Enforce boundary size on cache to limit memory usage
  if (logLineCache.size > 5000) {
    const keys = logLineCache.keys();
    for (let i = 0; i < 1000; i++) {
      const next = keys.next();
      if (next.done) break;
      logLineCache.delete(next.value);
    }
  }

  // 1. Strip all ANSI escape codes first to prevent timestamp/level parsing interference
  const cleanLine = line.replace(/[\u001b\x1b]\[[0-9;]*m/g, "");

  // 2. Escape HTML entities
  let escaped = cleanLine
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // 3. Extract and format timestamps
  let timestampHtml = "";
  let content = escaped;

  const tsRegex = /^(\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[+\-]\d{2}:?\d{2}|Z)?\]?)\s*/;
  const tsMatch = escaped.match(tsRegex);
  if (tsMatch) {
    timestampHtml = `<span style="color:#71717a; font-weight:500; font-family:var(--sys-font-mono, monospace); margin-right:6px;">${tsMatch[1]}</span>`;
    content = escaped.slice(tsMatch[0].length);
  }

  // 4. Highlight log levels
  content = content.replace(/\b(INFO|WARN|WARNING|ERROR|FATAL|DEBUG|TRACE)\b/g, (lvl) => {
    let color = "#10b981"; // INFO
    const upper = lvl.toUpperCase();
    if (upper === "WARN" || upper === "WARNING") color = "#fbbf24";
    else if (upper === "ERROR" || upper === "FATAL") color = "#f87171";
    else if (upper === "DEBUG") color = "#60a5fa";
    else if (upper === "TRACE") color = "#a78bfa";
    return `<span style="color:${color}; font-weight:600; font-size:10px; text-transform:uppercase;">[${upper}]</span>`;
  });

  // 5. Prettify embedded JSON
  const firstBrace = content.indexOf('{');
  const lastBrace = content.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const rawJsonCandidate = content
      .slice(firstBrace, lastBrace + 1)
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
    try {
      const parsed = JSON.parse(rawJsonCandidate);
      const prettyJson = JSON.stringify(parsed, null, 2);
      const colorized = colorizeJsonHtml(prettyJson);
      const lineCount = prettyJson.split('\n').length;

      const before = content.slice(0, firstBrace);
      const after = content.slice(lastBrace + 1);

      if (lineCount > 8) {
        // Written on a single line to prevent pre-wrap from rendering code indent spacing/newlines as literal DOM spacing gaps
        return before + `<div class="log-json-container" style="margin: 4px 0 4px 12px; border: 1px solid #27272a; background-color: #0c0c0e; border-radius: 3px; overflow: hidden; display: flex; flex-direction: column; box-sizing: border-box;"><div class="log-json-header" style="display: none; background-color: #18181b; color: #a1a1aa; font-size: 10px; padding: 3px 8px; border-bottom: 1px solid #27272a; cursor: pointer; user-select: none; font-weight: 500; box-sizing: border-box;" title="Click to collapse JSON"><i class="bi bi-chevron-bar-up" style="margin-right: 4px;"></i>Collapse Block</div><div class="log-json-content" style="padding: 4px 8px; font-family: 'Consolas', monospace; white-space: pre-wrap; font-size: 10px; line-height: 1.4; color: #e4e4e7; text-align: left; max-height: 120px; overflow: hidden; position: relative; box-sizing: border-box;">${colorized}</div><div class="log-json-footer" data-lines="${lineCount}" style="background-color: #18181b; color: #818cf8; font-size: 10px; padding: 3px 8px; border-top: 1px solid #27272a; cursor: pointer; user-select: none; text-align: center; font-weight: 600; box-sizing: border-box;" title="Click to expand JSON"><i class="bi bi-chevron-bar-down" style="margin-right: 4px;"></i>Expand JSON (${lineCount} lines)</div></div>` + after;
      } else {
        return before + `<div class="log-json-block" style="margin: 4px 0 4px 12px; padding: 4px 8px; background-color: #0c0c0e; border-left: 2px solid #4f46e5; border-radius: 2px; font-family: 'Consolas', monospace; white-space: pre-wrap; font-size: 10px; line-height: 1.4; color: #e4e4e7; text-align: left; border: 1px solid #27272a; box-sizing: border-box;">${colorized}</div>` + after;
      }
    } catch (_) {
      // Leave as is if invalid JSON
    }
  }

  const result = `<div style="margin-bottom: 5px; line-height: 1.4; font-family: var(--sys-font-mono, monospace); font-size: 11px;">${timestampHtml}${content}</div>`;
  logLineCache.set(line, result);
  return result;
}

function renderVisibleLogs(logDiv: HTMLElement) {
  const visibleLines = fullLogLines.slice(-linesShownCount);
  const html = visibleLines.map(line => processLogLine(line)).join("");
  
  const oldScrollHeight = logDiv.scrollHeight;
  const oldScrollTop = logDiv.scrollTop;

  logDiv.innerHTML = html;
  attachLogJsonToggles(logDiv);

  // If the user is viewing history (scrolling up), adjust scroll to prevent jumpiness
  if (isUserScrolling && logDiv.scrollTop < 50) {
    logDiv.scrollTop = oldScrollTop + (logDiv.scrollHeight - oldScrollHeight);
  } else if (!isUserScrolling) {
    logDiv.scrollTop = logDiv.scrollHeight;
  }
}

function attachLogJsonToggles(logDiv: HTMLElement) {
  const containers = logDiv.querySelectorAll(".log-json-container");
  containers.forEach((container) => {
    const header = container.querySelector(".log-json-header") as HTMLElement;
    const content = container.querySelector(".log-json-content") as HTMLElement;
    const footer = container.querySelector(".log-json-footer") as HTMLElement;

    if (!header || !content || !footer) return;

    const toggle = (expand: boolean) => {
      // Anchor scroll position
      const startOffsetTop = container.getBoundingClientRect().top;

      if (expand) {
        content.style.maxHeight = "none";
        header.style.display = "block";
        footer.innerHTML = '<i class="bi bi-chevron-bar-up" style="margin-right: 4px;"></i>Collapse Block';
      } else {
        content.style.maxHeight = "120px";
        header.style.display = "none";
        const lineCount = footer.getAttribute("data-lines") || "?";
        footer.innerHTML = `<i class="bi bi-chevron-bar-down" style="margin-right: 4px;"></i>Expand JSON (${lineCount} lines)`;
      }

      // Sync scroll adjustment instantly in the same thread tick to avoid visual jumps
      const endOffsetTop = container.getBoundingClientRect().top;
      const diff = endOffsetTop - startOffsetTop;
      if (Math.abs(diff) > 0.5) {
        logDiv.scrollTop += diff;
      }
    };

    footer.addEventListener("click", () => {
      const isCollapsed = content.style.maxHeight === "120px" || !content.style.maxHeight || content.style.maxHeight === "";
      toggle(isCollapsed);
    });

    header.addEventListener("click", () => {
      toggle(false);
    });
  });
}

export function setupLogTabs() {
  const dashTab = document.getElementById("log-tab-dashboard");
  const svcTab = document.getElementById("log-tab-service");
  const logDiv = document.getElementById("log-content");

  dashTab?.addEventListener("click", () => {
    setCurrentLogTab("dashboard");
    dashTab.classList.add("active");
    svcTab?.classList.remove("active");
    linesShownCount = 200;
    lastLogContent = "";
    isUserScrolling = false;
    refreshLogs();
  });

  svcTab?.addEventListener("click", () => {
    setCurrentLogTab("service");
    svcTab.classList.add("active");
    dashTab?.classList.remove("active");
    linesShownCount = 200;
    lastLogContent = "";
    isUserScrolling = false;
    refreshLogs();
  });

  // Setup infinite scroll pagination when scrolling to top
  logDiv?.addEventListener("scroll", () => {
    if (!logDiv) return;

    const isAtBottom = logDiv.scrollHeight - logDiv.clientHeight - logDiv.scrollTop < 30;
    isUserScrolling = !isAtBottom;

    if (logDiv.scrollTop === 0 && linesShownCount < fullLogLines.length) {
      linesShownCount = Math.min(fullLogLines.length, linesShownCount + 200);
      renderVisibleLogs(logDiv);
    }
  });
}

export async function refreshLogs() {
  const logDiv = document.getElementById("log-content");
  if (!logDiv) return;
  if (!logDiv.innerHTML || lastLogContent === "") {
    logDiv.innerHTML = `<div style="padding: 12px; color: #a1a1aa; font-family: var(--sys-font-mono, monospace); font-size: 11px; display: flex; align-items: center; gap: 8px;">
      <div class="spinner-ring" style="width: 14px; height: 14px; border-width: 2px;"></div>
      <span>Loading diagnostic logs...</span>
    </div>`;
  }
  try {
    const cmd = currentLogTab === "service" ? "read_service_logs" : "read_logs";
    const logs = await invoke(cmd) as string;
    
    if (logs !== lastLogContent) {
      lastLogContent = logs;
      fullLogLines = logs.split(/\r?\n/);
      renderVisibleLogs(logDiv);
    }
  } catch (e) {
    logDiv.textContent = "Failed to load logs: " + e;
  }
}

export function clearLogsFrontendDom() {
  const logDiv = document.getElementById("log-content");
  if (logDiv) {
    logDiv.innerHTML = "";
  }
  lastLogContent = "";
  logLineCache.clear();
}

export async function clearLogsData() {
  const logDiv = document.getElementById("log-content");
  try {
    const cmd = currentLogTab === "service" ? "clear_service_logs" : "clear_logs";
    await invoke(cmd);
    fullLogLines = [];
    linesShownCount = 200;
    lastLogContent = "";
    isUserScrolling = false;
    logLineCache.clear();
    if (logDiv) logDiv.innerHTML = "";
  } catch (e) {
    showErrorAlert("Failed to clear logs:\n" + e);
  }
}

// ---------------------------------------------------------------------------
// HTML Template
// ---------------------------------------------------------------------------

export function renderLogsHtml(): SafeHtml {
  return html`
    <div class="group-box" style="display: flex; flex-direction: column; flex: 1; min-height: 0;">
      <div class="group-box-title">System Diagnostic Logs</div>
      <div style="display: flex; gap: 8px; margin-bottom: 8px; align-items: center;">
        <div style="display: flex; gap: 0;">
          <button class="win-button log-tab active" id="log-tab-dashboard" style="border-radius: 2px 0 0 2px;">Dashboard</button>
          <button class="win-button log-tab" id="log-tab-service" style="border-radius: 0 2px 2px 0;">Service</button>
        </div>
        <div style="flex: 1;"></div>
        <button class="win-button" id="refresh-logs-btn"><i class="bi bi-arrow-clockwise"></i> Refresh</button>
        <button class="win-button" id="clear-logs-btn"><i class="bi bi-x-lg"></i> Clear</button>
      </div>
      <div id="log-content" style="flex: 1; font-family: 'Consolas', monospace; font-size: 11px; background-color: #1e1e1e; color: #cccccc; border: 1px solid #7a7a7a; padding: 8px; overflow-y: auto; white-space: pre-wrap; word-break: break-all;"></div>
    </div>
  `;
}
