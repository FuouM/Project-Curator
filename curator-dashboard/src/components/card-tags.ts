import { html, SafeHtml, ComponentMeta } from './_shared';
import { TagSummary, renderTagPill } from './tag-pill';

export interface ParsedMetadata {
  match_type: string;
  extracted_tags: string[];
  partial?: boolean;
  pixiv_id?: string;
  twitter_id?: string;
  datetime_iso?: string;
  artist?: string;
  raw_matched?: string;
}

export function getTagPillHtml(t: TagSummary, isDeletable = false, imageId = 0): SafeHtml {
  return renderTagPill(t, { isDeletable, imageId });
}

export function renderTagListHtml(tags: TagSummary[], maxVisible = 10): SafeHtml {
  const display = tags.slice(0, maxVisible);
  const extraCount = tags.length - maxVisible;
  return (display.map(t => getTagPillHtml(t)).join("") +
    (extraCount > 0 ? `<span class="tag-pill tag-pill-overflow">+${extraCount} more</span>` : "")) as SafeHtml;
}

export function renderIdentityListHtml(names: { name: string }[] | undefined, style = ""): SafeHtml {
  if (!names || names.length === 0) return "" as SafeHtml;
  const styleAttr = style ? ` style="${style}"` : "";
  return html`<div class="identity-list"${styleAttr}>${names.map(ci => `<span class="tag-pill tag-identity"><i class="bi bi-person-fill"></i> ${ci.name}</span>`).join("")}</div>`;
}

export function renderUserTagsListHtml(tags: TagSummary[] | undefined, style = ""): SafeHtml {
  if (!tags || tags.length === 0) return "" as SafeHtml;
  const styleAttr = style ? ` style="${style}"` : "";
  return html`<div class="user-tags-list"${styleAttr}>${tags.map(t => getTagPillHtml(t)).join("")}</div>`;
}

export function renderCardTagsContainerHtml(img: { tags: TagSummary[] }, isFeatured = false): SafeHtml {
  const tags = img.tags || [];

  // Separate user tags from AI model tags
  const userTags = tags.filter(
    t => t.category === "user" || t.source_name === "user"
  );
  const aiTags = tags.filter(
    t => !(t.category === "user" || t.source_name === "user")
  );

  let userTagsHtml = "";
  if (userTags.length > 0) {
    userTagsHtml = renderUserTagsListHtml(userTags);
  }


  if (aiTags.length === 0) {
    return userTagsHtml as SafeHtml;
  }

  let taggerLabel = "";
  const firstAITag = aiTags.find(t => t.source_name && t.source_name.startsWith("ai:"));
  if (firstAITag) {
    if (firstAITag.source_name === "ai:camie-tagger-v2") {
      taggerLabel = "Camie Tagger v2";
    } else if (firstAITag.source_name === "ai:wd-eva02-tagger-2026-canary") {
      taggerLabel = "WD EVA02";
    } else {
      taggerLabel = (firstAITag.source_name ?? "").replace("ai:", "").toUpperCase();
    }
  } else {
    taggerLabel = "AI TAGGER";
  }

  const tagHtml = isFeatured ? renderTagListHtml(aiTags, aiTags.length) : renderTagListHtml(aiTags);
  const copyText = tags.map(t => t.tag).join(", ").replace(/"/g, "&quot;");

  return html`
    ${userTagsHtml}
    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px; width: 100%;">
      <div style="font-family: monospace; font-size: 10px; font-weight: bold; background-color: var(--sys-control-bg, #fff); border: 1px solid var(--sys-border-dark, #b0b0b0); border-radius: 2px; padding: 2px 6px; color: var(--sys-text-secondary, #666); text-transform: uppercase; letter-spacing: 0.5px; line-height: 1; white-space: nowrap;">${taggerLabel}</div>
      <div style="flex: 1; height: 1px; background-color: var(--sys-border-dark, #b0b0b0);"></div>
      <button type="button" class="tag-copy-btn" data-action="copy-tags" data-copy-tags="${copyText}" title="Copy tags to clipboard">
        <i class="bi bi-clipboard"></i>
      </button>
    </div>
    <div class="tag-list" style="margin-top: 0;">
      ${tagHtml}
    </div>
  `;
}


export function renderParsedMetadataHtml(meta: ParsedMetadata): SafeHtml {
  const parts: string[] = [];

  if (meta.match_type === "anime_screenshot") {
    const animeTag = meta.extracted_tags.find(t => t.toLowerCase().startsWith("anime:"));
    const epTag = meta.extracted_tags.find(t => t.toLowerCase().startsWith("episode:"));
    const animeName = animeTag ? animeTag.split(":").slice(1).join(":") : "Unknown";
    const epNum = epTag ? epTag.split(":").slice(1).join(":") : "?";
    const partialBadge = meta.partial ? ' <span style="font-size: 9px; color: #856404;">(partial)</span>' : "";
    parts.push(`<span class="tag-pill tag-copyright" style="font-size: 10px; font-weight: 600;"><i class="bi bi-film"></i> Anime Screenshot: ${animeName} - ${epNum}${partialBadge}</span>`);
  } else if (meta.match_type === "danbooru") {
    const hashTag = meta.extracted_tags.find(t => t.toLowerCase().startsWith("hash:"));
    const artistTag = meta.extracted_tags.find(t => t.toLowerCase().startsWith("artist:"));
    const hash = hashTag ? hashTag.split(":").slice(1).join(":") : "";
    const artist = artistTag ? artistTag.split(":").slice(1).join(":") : "?";
    const hashDisplay = hash.length > 8 ? `${hash.slice(0, 4)}...${hash.slice(-4)}` : hash;
    const hashLink = hash ? `<a href="https://danbooru.donmai.us/posts?tags=md5%3A${hash}" target="_blank" rel="noopener" style="color: inherit; text-decoration: underline; font-size: inherit;" onmouseover="this.style.textDecoration='none'" onmouseout="this.style.textDecoration='underline'" title="${hash}">${hashDisplay}</a>` : "?";
    parts.push(`<span class="tag-pill tag-copyright" style="font-size: 10px; font-weight: 600;"><i class="bi bi-grid-3x3-gap"></i> ${artist} - ${hashLink}</span>`);
  } else {
    if (meta.datetime_iso) {
      parts.push(`<span class="tag-pill tag-meta" style="font-size: 10px;"><i class="bi bi-clock"></i> 4chan: ${meta.datetime_iso}</span>`);
    } else if (meta.artist) {
      parts.push(`<span class="tag-pill tag-artist" style="font-size: 10px;"><i class="bi bi-person"></i> artist: ${meta.artist}</span>`);
    }
  }

  if (meta.pixiv_id) {
    const pageTag = meta.extracted_tags.find(t => t.startsWith("page:"));
    const pageStr = pageTag ? ` ${pageTag}` : "";
    parts.push(`<span class="tag-pill tag-copyright" style="font-size: 10px;"><i class="bi bi-image"></i> pixiv: <a href="https://www.pixiv.net/en/artworks/${meta.pixiv_id}" target="_blank" rel="noopener" style="color: inherit; text-decoration: underline; font-size: inherit;" onmouseover="this.style.textDecoration='none'" onmouseout="this.style.textDecoration='underline'">${meta.pixiv_id}</a>${pageStr}</span>`);
  }
  if (meta.twitter_id) parts.push(`<span class="tag-pill tag-character" style="font-size: 10px;"><i class="bi bi-twitter"></i> twitter: ${meta.twitter_id}</span>`);

  const fieldTags = new Set<string>();
  if (meta.artist) fieldTags.add(`artist:${meta.artist}`);
  if (meta.pixiv_id) fieldTags.add(`pixiv:${meta.pixiv_id}`);
  if (meta.twitter_id) fieldTags.add(`twitter:${meta.twitter_id}`);
  if (meta.datetime_iso) fieldTags.add(`date:${meta.datetime_iso.split(' ')[0]}`);
  if (meta.match_type === "anime_screenshot") {
    const a = meta.extracted_tags.find(t => t.toLowerCase().startsWith("anime:"));
    const e = meta.extracted_tags.find(t => t.toLowerCase().startsWith("episode:"));
    if (a) fieldTags.add(a);
    if (e) fieldTags.add(e);
  }

  for (const tag of meta.extracted_tags) {
    if (fieldTags.has(tag)) continue;
    if (tag.startsWith('artist:') || tag.startsWith('pixiv:') || tag.startsWith('twitter:')) continue;
    if (tag.startsWith('page:')) continue;
    const tl = tag.toLowerCase();
    if (tl.startsWith('anime:') || tl.startsWith('episode:')) continue;

    let tagClass = "tag-rank-3";
    if (tag.startsWith("date:")) tagClass = "tag-meta";
    else if (tag.startsWith("source:") || tag.startsWith("site:")) tagClass = "tag-meta";
    else if (tag.startsWith("group:")) tagClass = "tag-character";
    else if (tag.startsWith("resolution:")) tagClass = "tag-meta";
    parts.push(`<span class="tag-pill ${tagClass}" style="font-size: 10px; font-family: monospace;">${tag}</span>`);
  }

  return html`${parts.join(" ")}`;
}

export const meta: ComponentMeta = {
  name: "Card Tags & Metadata Info",
  description: "Standard tag clusters and metadata descriptors parsed from active system files.",
  variants: [
    {
      name: "Tagger Cluster",
      render: () => renderCardTagsContainerHtml({
        tags: [
          { tag: "1girl", category: "general", source_name: "ai:camie-tagger-v2" },
          { tag: "solo", category: "general", source_name: "ai:camie-tagger-v2" },
          { tag: "long_hair", category: "general", source_name: "ai:camie-tagger-v2" }
        ]
      })
    }
  ]
};