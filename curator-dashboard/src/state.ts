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
export let galleryTotalCount = 0;
export let favoritesTotalCount = 0;
export function setGalleryPage(v: number) { galleryPage = v; }
export function setFavoritesPage(v: number) { favoritesPage = v; }
export function setGalleryTotalCount(v: number) { galleryTotalCount = v; }
export function setFavoritesTotalCount(v: number) { favoritesTotalCount = v; }
export function getGalleryPage(): number { return galleryPage; }
export function getFavoritesPage(): number { return favoritesPage; }
export function getGalleryTotalCount(): number { return galleryTotalCount; }
export function getFavoritesTotalCount(): number { return favoritesTotalCount; }

// --- Infinite Scroll ---
const INFINITE_SCROLL_KEY = "curator-gallery-infinite-scroll";
export let galleryInfiniteScroll = localStorage.getItem(INFINITE_SCROLL_KEY) === "true";
export function setGalleryInfiniteScroll(v: boolean) {
  galleryInfiniteScroll = v;
  localStorage.setItem(INFINITE_SCROLL_KEY, v.toString());
}
export function getGalleryInfiniteScroll(): boolean { return galleryInfiniteScroll; }

// --- Zen Mode ---
const ZEN_MODE_KEY = "curator-gallery-zen-mode";
export let galleryZenMode = localStorage.getItem(ZEN_MODE_KEY) === "true";
if (galleryZenMode) {
  galleryInfiniteScroll = true; // force infinite scroll on if zen mode is saved as true
}
export function setGalleryZenMode(v: boolean) {
  galleryZenMode = v;
  localStorage.setItem(ZEN_MODE_KEY, v.toString());
}
export function getGalleryZenMode(): boolean { return galleryZenMode; }

// --- Full Images Load Toggle ---
const FULL_IMAGES_KEY = "curator-gallery-full-images";
export let galleryFullImages = localStorage.getItem(FULL_IMAGES_KEY) === "true";
export function setGalleryFullImages(v: boolean) {
  galleryFullImages = v;
  localStorage.setItem(FULL_IMAGES_KEY, v.toString());
}
export function getGalleryFullImages(): boolean { return galleryFullImages; }
export const setZenModeFullImages = setGalleryFullImages;
export const getZenModeFullImages = getGalleryFullImages;

// --- Selection State ---
export let isSelectMode = false;
export const selectedImageIds = new Set<number>();
export function setIsSelectMode(v: boolean) { isSelectMode = v; }

// --- Lucky Highlight State ---
export let luckyHighlightId: number | null = null;
export function setLuckyHighlightId(id: number | null) { luckyHighlightId = id; }

// --- Tag Copy Formatting ---
const TAG_COPY_REPLACE_UNDERSCORES_KEY = "curator-tag-copy-replace-underscores";

export function getTagCopyReplaceUnderscores(): boolean {
  return localStorage.getItem(TAG_COPY_REPLACE_UNDERSCORES_KEY) === "true";
}

export function setTagCopyReplaceUnderscores(v: boolean) {
  localStorage.setItem(TAG_COPY_REPLACE_UNDERSCORES_KEY, v.toString());
}

export function formatCopiedTags(text: string): string {
  return getTagCopyReplaceUnderscores() ? text.replace(/_/g, " ") : text;
}
