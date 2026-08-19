/**
 * Remote Dynasty Scans JSON contracts and transport result shapes.
 */

export interface ChapterTag {
  type: string;
  name: string;
  permalink: string;
}

export interface ChapterPage {
  name: string;
  url: string;
}

export interface Chapter {
  title: string;
  long_title: string;
  permalink: string;
  tags: ChapterTag[];
  pages: ChapterPage[];
  released_on?: string;
  added_on?: string;
}

export interface SeriesTag {
  type: string;
  name: string;
  permalink: string;
}

export interface SeriesTaggings {
  header?: string;
  title?: string;
  permalink?: string;
  released_on?: string;
  tags?: SeriesTag[];
}

export interface SeriesTaggable {
  type: string;
  name: string;
  permalink: string;
  cover?: string | null;
}

export interface Series {
  name: string;
  type: string;
  permalink: string;
  tags: SeriesTag[];
  cover: string | null;
  link: string | null;
  description: string | null;
  aliases: string[];
  taggings: SeriesTaggings[];
  taggables?: SeriesTaggable[];
}

export interface FeedChapter {
  title: string;
  series: string;
  permalink: string;
  tags: SeriesTag[];
}

export interface Feed {
  chapters: FeedChapter[];
  current_page: number;
  total_pages: number;
}

export interface DirectoryEntry {
  name: string;
  permalink: string;
}

export interface Directory {
  tags: Record<string, DirectoryEntry[]>[];
  current_page: number;
  total_pages: number;
}

export interface SuggestResult {
  id: number;
  name: string;
  type: string;
}

/** Normalized, ordered letter → entries groups from a directory payload. */
export interface DirectoryGroup {
  letter: string;
  entries: DirectoryEntry[];
}

export interface GetTextOptions {
  timeoutMs?: number;
  method?: "GET" | "POST";
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

export interface HttpResponseText {
  status: number;
  body: string;
  etag?: string;
}

export interface FeedRevalidationResult {
  data: Feed;
  isStale: boolean;
  cachedAt?: number;
  etag?: string;
  source: "sqlite" | "network";
  revalidatePromise?: Promise<{ data: Feed; isNew: boolean; etag?: string } | null>;
}

export interface RevalidateOnlineResult {
  status: number;
  data?: Feed;
  etag?: string;
  isNew: boolean;
}

export interface ParsedDynastyUrl {
  kind: "series" | "chapter";
  permalink: string;
}

export type SearchClass =
  | "Chapter"
  | "Anthology"
  | "Doujin"
  | "Issue"
  | "Series"
  | "Author"
  | "Scanlator"
  | "General"
  | "Pairing";

export type SearchSort = "" | "name" | "created_at" | "released_on";

export interface SearchParams {
  q?: string;
  classes?: SearchClass[];
  withTags?: string[];
  withoutTags?: string[];
  sort?: SearchSort;
  page?: number;
}

export interface SearchResultItem {
  kind: "chapter" | "series" | "anthology" | "doujin" | "issue" | "author" | "scanlator" | "tag" | "pairing";
  title: string;
  permalink: string;
  author?: {
    name: string;
    permalink: string;
  };
  doujin?: {
    name: string;
    permalink: string;
  };
  releasedOn?: string;
  tags: ChapterTag[];
}

export interface SearchResultPage {
  items: SearchResultItem[];
  currentPage: number;
  totalPages: number;
  totalEstimated?: number;
  query: string;
}
