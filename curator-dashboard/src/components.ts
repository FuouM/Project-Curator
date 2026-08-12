// ── Barrel: harmless explicit re-exports of the public API ───────────────────
// Each module also exports a `meta` (or `metas`) showcase footprint. Those are
// intentionally NOT re-exported here (`export *` would collide across modules
// with TS2665); the autodiscovery engine below consumes them from the glob
// namespace instead.

export { html, TOKENS } from './components/_shared';
export type { SafeHtml, ComponentVariant, ComponentMeta } from './components/_shared';

export { maskPath } from './components/path-utils';

export { renderButton } from './components/button';
export type { ButtonOptions } from './components/button';

export { renderInputField } from './components/input-field';
export type { InputOptions } from './components/input-field';

export { renderTagPill } from './components/tag-pill';
export type { TagSummary } from './components/tag-pill';

export { renderStatCard } from './components/stat-card';
export type { StatCardOptions } from './components/stat-card';

export { renderGroupBox } from './components/group-box';

export { renderConceptCard } from './components/concept-card';
export type { ConceptCardProps } from './components/concept-card';

export { renderImageCard } from './components/image-card';
export type { ImageCardOptions } from './components/image-card';

export {
  getTagPillHtml,
  renderTagListHtml,
  renderCardTagsContainerHtml,
  renderParsedMetadataHtml,
} from './components/card-tags';
export type { ParsedMetadata } from './components/card-tags';

export { renderGalleryCardHtml, renderOcrBlockHtml } from './components/gallery-card';
export type { GalleryCardViewData } from './components/gallery-card';

// ── Autodiscovery Engine ─────────────────────────────────────────────────────
// Every module under ./components/** (underscore-prefixed files skipped) may
// export a single `meta` or an array `metas`. Each footprint is registered as
// one SHOWCASE_COMPONENTS entry.

import type { ComponentMeta, ComponentVariant } from './components/_shared';

export interface ComponentShowcase {
  name: string;
  description: string;
  variants: ComponentVariant[];
}

const modules = import.meta.glob('./components/[!_]*.ts', { eager: true });

export const SHOWCASE_COMPONENTS: Record<string, ComponentShowcase> = Object.keys(modules)
  .sort()
  .flatMap((path): [string, ComponentShowcase][] => {
    const mod = modules[path] as { meta?: ComponentMeta; metas?: ComponentMeta[] };
    const fileKey = path.replace(/^\.\/components\//, '').replace(/\.ts$/, '');
    const footprints: ComponentMeta[] = mod.metas ?? (mod.meta ? [mod.meta] : []);
    return footprints.map((fp, index) => {
      const key = footprints.length > 1 ? `${fileKey}:${index}` : fileKey;
      return [key, { name: fp.name, description: fp.description, variants: fp.variants }];
    });
  })
  .reduce((acc, [key, entry]) => {
    acc[key] = entry;
    return acc;
  }, {} as Record<string, ComponentShowcase>);
