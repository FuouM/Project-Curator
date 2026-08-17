export type MediaFilterEffect = "blur" | "pixelate";

/** CSS-pixel region relative to the target's content box. Unset = whole element. */
export interface FilterRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

const EFFECT_CLASSES: Record<MediaFilterEffect, string> = {
  blur: "media-filter-blur",
  pixelate: "media-filter-pixelate",
};

/**
 * Apply an effect to a media element. `region` is unused today (full-image NSFW) but is
 * part of the contract for future mask/bounding-box operations.
 */
export function applyMediaFilter(
  target: HTMLElement,
  effect: MediaFilterEffect,
  region?: FilterRegion,
): void {
  clearMediaFilter(target);
  if (region) {
    applyRegionFilter(target, effect, region);
    return;
  }
  target.classList.add(EFFECT_CLASSES[effect]);
}

/** Remove any applied effect (and inline SVG region instrumentation). */
export function clearMediaFilter(target: HTMLElement): void {
  (Object.keys(EFFECT_CLASSES) as MediaFilterEffect[]).forEach((effect) => {
    target.classList.remove(EFFECT_CLASSES[effect]);
  });
  target.querySelectorAll("[data-media-filter-region]").forEach((el) => el.remove());
}

function applyRegionFilter(
  target: HTMLElement,
  effect: MediaFilterEffect,
  region: FilterRegion,
): void {
  const rect = target.getBoundingClientRect();
  const width = region.width || rect.width;
  const height = region.height || rect.height;
  const x = clamp(region.x, 0, rect.width);
  const y = clamp(region.y, 0, rect.height);
  const rw = clamp(Math.min(width, rect.width - x), 0, rect.width);
  const rh = clamp(Math.min(height, rect.height - y), 0, rect.height);
  if (rw <= 0 || rh <= 0) return;

  const img = target.querySelector<HTMLElement>("img[data-thumb-id]");
  if (!img) return;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("data-media-filter-region", "");
  svg.setAttribute("width", String(rect.width));
  svg.setAttribute("height", String(rect.height));
  svg.style.cssText = `position: absolute; top: 0; left: 0; width: ${rect.width}px; height: ${rect.height}px; pointer-events: none; z-index: 1;`;

  if (effect === "blur") {
    svg.innerHTML = `
      <defs>
        <filter id="media-region-blur" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="18"/>
        </filter>
        <clipPath id="media-region-clip">
          <rect x="${x}" y="${y}" width="${rw}" height="${rh}"/>
        </clipPath>
      </defs>
      <image href="${img.getAttribute("src") || ""}" width="${rect.width}" height="${rect.height}"
        preserveAspectRatio="xMidYMid slice" filter="url(#media-region-blur)" clip-path="url(#media-region-clip)"/>
    `;
  } else {
    svg.innerHTML = `
      <defs>
        <clipPath id="media-region-clip">
          <rect x="${x}" y="${y}" width="${rw}" height="${rh}"/>
        </clipPath>
      </defs>
      <image href="${img.getAttribute("src") || ""}" width="${rect.width}" height="${rect.height}"
        preserveAspectRatio="xMidYMid slice" filter="url(#pixelate-filter)" clip-path="url(#media-region-clip)"/>
    `;
  }
  img.parentElement?.appendChild(svg);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
