/**
 * Touhou-style loading component featuring a compact spinning Reimu Hakurei red Yin-Yang orb
 * inline with randomized praying maiden flavor text in the middle of the screen.
 */

export const PRAYING_MESSAGES = [
  "Girls are now praying",
  "The maidens are praying",
  "The girls are praying",
  "Girls do their best now and are preparing",
  "Please watch warmly until it is ready",
];

/** Returns a random praying maiden loading message. */
export function getRandomLoadingMessage(): string {
  const idx = Math.floor(Math.random() * PRAYING_MESSAGES.length);
  return PRAYING_MESSAGES[idx];
}

/**
 * Creates and returns a centered loading element with a small inline spinning Reimu Yin-Yang orb.
 */
export function renderLoading(customMessage?: string): HTMLElement {
  const container = document.createElement("div");
  container.className = "ds-loading-screen";
  const msg = customMessage ?? getRandomLoadingMessage();

  container.innerHTML = `
    <svg class="ds-yinyang-spinner" viewBox="0 0 100 100" width="18" height="18" aria-hidden="true">
      <circle cx="50" cy="50" r="46" fill="#ffffff" stroke="#c62828" stroke-width="4" />
      <path d="M 50 4 A 46 46 0 0 1 50 96 A 23 23 0 0 1 50 50 A 23 23 0 0 0 50 4 Z" fill="#e53935" />
      <circle cx="50" cy="27" r="7.5" fill="#e53935" />
      <circle cx="50" cy="73" r="7.5" fill="#ffffff" />
    </svg>
    <span class="ds-loading-text">${msg}…</span>
  `;

  return container;
}

/**
 * Mounts a loading indicator only if an asynchronous task takes longer than `delayMs` (default 140ms).
 * This eliminates the visual flicker when navigating to cached tabs or clicking quickly.
 * Returns a cancel function to be called once loading finishes or is superseded.
 */
export function attachDelayedLoading(
  container: HTMLElement,
  delayMs = 140,
  customMessage?: string,
): () => void {
  let timer: number | null = window.setTimeout(() => {
    timer = null;
    container.innerHTML = "";
    container.appendChild(renderLoading(customMessage));
  }, delayMs);

  return () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
