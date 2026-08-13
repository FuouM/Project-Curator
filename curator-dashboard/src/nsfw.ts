import { applyMediaFilter, clearMediaFilter } from "./media-filter";
import { SafetyScores } from "./types";
import { isClassified, nsfwScore } from "./proto-adapters";

export type NsfwAction = "none" | "blur" | "pixelate" | "hide";

export interface NsfwPrefs {
  action: NsfwAction;
  threshold: number;
}

const STORAGE_KEY = "nsfw-filter";

export const DEFAULT_NSFW_PREFS: NsfwPrefs = { action: "none", threshold: 0.5 };

export function loadNsfwPrefs(): NsfwPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_NSFW_PREFS };
    const parsed = JSON.parse(raw) as Partial<NsfwPrefs>;
    const action = parsed.action === "blur" || parsed.action === "pixelate" || parsed.action === "hide"
      ? parsed.action
      : "none";
    const threshold = typeof parsed.threshold === "number"
      ? Math.min(0.9, Math.max(0.1, parsed.threshold))
      : DEFAULT_NSFW_PREFS.threshold;
    return { action, threshold };
  } catch {
    return { ...DEFAULT_NSFW_PREFS };
  }
}

export function saveNsfwPrefs(prefs: NsfwPrefs): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

export function isNsfwCard(scores: SafetyScores | undefined, threshold: number): boolean {
  if (!scores || !isClassified(scores)) return false;
  return nsfwScore(scores) >= threshold;
}

/** Decorate a gallery card element with the active NSFW effect or blackout toggles. */
export function applyNsfwToCard(card: HTMLElement, scores: SafetyScores | undefined, prefs: NsfwPrefs): void {
  clearMediaFilter(card);
  card.classList.remove("nsfw-blackout");

  if (!isNsfwCard(scores, prefs.threshold)) return;

  if (prefs.action === "hide") {
    card.classList.add("nsfw-blackout");
  } else if (prefs.action === "blur" || prefs.action === "pixelate") {
    applyMediaFilter(card, prefs.action);
  }
}

/** Re-decorate all rendered gallery cards according to the current preferences. */
export function refreshAllNsfw(): void {
  const prefs = loadNsfwPrefs();
  document.querySelectorAll<HTMLElement>(".image-card[data-nsfw]").forEach((card) => {
    let scores: SafetyScores | undefined;
    try {
      scores = JSON.parse(card.dataset.nsfw || "null") as SafetyScores | null ?? undefined;
    } catch {
      scores = undefined;
    }
    applyNsfwToCard(card, scores, prefs);
  });
}