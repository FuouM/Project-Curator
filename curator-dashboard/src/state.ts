// --- Image Click Setting ---
const IMAGE_CLICK_KEY = "curator-image-click-action";

export function getImageClickAction(): string {
  return localStorage.getItem(IMAGE_CLICK_KEY) || "in-app";
}

export function setImageClickAction(action: string) {
  localStorage.setItem(IMAGE_CLICK_KEY, action);
}

// --- Gallery Per-Page Setting ---
const IMAGES_PER_PAGE_KEY = "curator-gallery-per-page";
const DEFAULT_IMAGES_PER_PAGE = 12;
const PER_PAGE_OPTIONS = [12, 24, 48, 96];

export function getImagesPerPage(): number {
  const stored = localStorage.getItem(IMAGES_PER_PAGE_KEY);
  if (stored) {
    const val = parseInt(stored, 10);
    if (PER_PAGE_OPTIONS.includes(val)) return val;
  }
  return DEFAULT_IMAGES_PER_PAGE;
}

export function setImagesPerPage(val: number) {
  localStorage.setItem(IMAGES_PER_PAGE_KEY, val.toString());
}

// --- Log Tab State ---
export let currentLogTab: "dashboard" | "service" = "dashboard";
export function setCurrentLogTab(tab: "dashboard" | "service") { currentLogTab = tab; }

// --- Gallery/Favorites Pagination ---
export let galleryPage = 0;
export let favoritesPage = 0;
export function setGalleryPage(v: number) { galleryPage = v; }
export function setFavoritesPage(v: number) { favoritesPage = v; }

// --- Selection State ---
export let isSelectMode = false;
export const selectedImageIds = new Set<number>();
export function setIsSelectMode(v: boolean) { isSelectMode = v; }
