/**
 * Diagnostic terminal log console utility.
 *
 * Returns a `Logger` function bound to a specific DOM element ID. The element
 * is looked up by ID on every call so this works correctly with Plugin Host's
 * deferred DOM mounting pattern (the element may not exist when createLogger
 * is called at module level).
 *
 * Colors match the app's System Diagnostic Logs console:
 *   info    → #cccccc  (light grey)
 *   success → #10b981  (green)
 *   error   → #f87171  (red)
 */

export type LogKind = "info" | "success" | "error";
export type Logger = (message: string, kind?: LogKind) => void;

const LOG_COLORS: Record<LogKind, string> = {
  info: "#cccccc",
  success: "#10b981",
  error: "#f87171",
};

/**
 * Creates a logger function bound to the DOM element with the given ID.
 *
 * @example
 * // In a plugin module:
 * export const log = createLogger("my-plugin-log");
 * log("Starting...");
 * log("Done.", "success");
 * log("Failed.", "error");
 */
export function createLogger(elementId: string): Logger {
  return function log(message: string, kind: LogKind = "info"): void {
    const box = document.getElementById(elementId);
    if (!box) return;

    const line = document.createElement("div");
    line.style.cssText =
      "font-family:'Consolas',monospace;font-size:11px;line-height:1.4;" +
      `color:${LOG_COLORS[kind]};white-space:pre-wrap;word-break:break-all;`;
    line.textContent = message;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  };
}
