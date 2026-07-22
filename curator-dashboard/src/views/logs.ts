import { invoke } from "@tauri-apps/api/core";
import { currentLogTab, setCurrentLogTab } from "../state";

// --- ANSI to HTML Renderer ---
const ANSI_COLORS: Record<number, string> = {
  30: "#000000", 31: "#cd3131", 32: "#0dbc79", 33: "#e5e510",
  34: "#2472c8", 35: "#bc3fbc", 36: "#11a8cd", 37: "#e5e5e5",
  90: "#666666", 91: "#f14c4c", 92: "#23d18b", 93: "#f5f543",
  94: "#3b8eea", 95: "#d670d6", 96: "#29b8db", 97: "#ffffff",
};

function ansiCodeReplacer(_match: string, codes: string): string {
  if (!codes) return "</span>";
  const parts = codes.split(";");
  let out = "";
  for (const p of parts) {
    const code = parseInt(p, 10);
    if (code === 0) {
      out += "</span>";
    } else if (code === 1) {
      out += '<span style="font-weight:bold">';
    } else if (code === 2) {
      out += '<span style="opacity:0.6">';
    } else if (code === 3) {
      out += '<span style="font-style:italic">';
    } else if (code === 4) {
      out += '<span style="text-decoration:underline">';
    } else if (ANSI_COLORS[code]) {
      out += `<span style="color:${ANSI_COLORS[code]}">`;
    }
  }
  return out;
}

function ansiToHtml(text: string): string {
  let result = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  result = result.replace(/\x1b\[([0-9;]*)m/g, ansiCodeReplacer);
  result = result.replace(/\u001b\[([0-9;]*)m/g, ansiCodeReplacer);
  const openCount = (result.match(/<span/g) || []).length;
  const closeCount = (result.match(/<\/span>/g) || []).length;
  for (let i = 0; i < openCount - closeCount; i++) {
    result += "</span>";
  }
  return result;
}

export function setupLogTabs() {
  const dashTab = document.getElementById("log-tab-dashboard");
  const svcTab = document.getElementById("log-tab-service");

  dashTab?.addEventListener("click", () => {
    setCurrentLogTab("dashboard");
    dashTab.classList.add("active");
    svcTab?.classList.remove("active");
    refreshLogs();
  });

  svcTab?.addEventListener("click", () => {
    setCurrentLogTab("service");
    svcTab.classList.add("active");
    dashTab?.classList.remove("active");
    refreshLogs();
  });
}

export async function refreshLogs() {
  const logDiv = document.getElementById("log-content");
  if (!logDiv) return;
  try {
    const cmd = currentLogTab === "service" ? "read_service_logs" : "read_logs";
    const logs = await invoke(cmd) as string;
    logDiv.innerHTML = ansiToHtml(logs);
    logDiv.scrollTop = logDiv.scrollHeight;
  } catch (e) {
    logDiv.textContent = "Failed to load logs: " + e;
  }
}

export async function clearLogsData() {
  const logDiv = document.getElementById("log-content");
  try {
    const cmd = currentLogTab === "service" ? "clear_service_logs" : "clear_logs";
    await invoke(cmd);
    if (logDiv) logDiv.innerHTML = "";
  } catch (e) {
    alert("Failed to clear logs: " + e);
  }
}
