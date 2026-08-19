/**
 * Router & navigation types for the dynasty-scans plugin.
 */

export type ViewName = "library" | "browse" | "series" | "reader" | "cache";

export interface ChapterRef {
  title: string;
  permalink: string;
  released_on?: string;
}

export interface Route {
  view: ViewName;
  /** Which browse sub-tab to show. */
  browseTab?: string;
  seriesPermalink?: string;
  seriesName?: string;
  chapterPermalink?: string;
  chapterTitle?: string;
  /** Ordered chapter list of the containing series (drives prev/next). */
  chapterList?: ChapterRef[];
  /** Page index to jump to when opening the reader. */
  startPage?: number;
  /** Active search query when opening browse with search tab. */
  searchQuery?: string;
  /** Class filter for search tab. */
  searchClass?: string;
  /** Initial included tag filter for search tab. */
  withTag?: string;
}

export interface SessionMangaTab {
  title: string;
  route: Route;
}
