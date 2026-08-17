import { html, SafeHtml, ComponentMeta } from "./_shared";

export interface TagSummary {
  tag: string;
  category: string;
  count?: number;
  source_name?: string;
}

export function renderTagPill(
  t: TagSummary,
  options?: { isDeletable?: boolean; imageId?: number },
): SafeHtml {
  let styleClass = "tag-rank-3";

  if (t.source_name === "ai:custom-concepts" || t.source_name === "custom-concept") {
    styleClass = "custom-concept";
  } else {
    switch (t.category) {
      case "user":
        styleClass = "tag-user";
        break;
      case "character":
        styleClass = "tag-character";
        break;
      case "copyright":
        styleClass = "tag-copyright";
        break;
      case "meta":
        styleClass = "tag-meta";
        break;
      case "artist":
        styleClass = "tag-artist";
        break;
    }
  }

  const isDeletable = options?.isDeletable ?? false;
  const imageId = options?.imageId ?? 0;

  const icon =
    styleClass === "custom-concept"
      ? `<i class="bi bi-stars concept-spark"></i> `
      : styleClass === "tag-user"
        ? `<i class="bi bi-tag-fill" style="font-size: 9px; opacity: 0.85;"></i> `
        : "";

  const deleteBtn =
    isDeletable && imageId > 0
      ? ` <span class="tag-remove-btn" data-action="remove-tag" data-image-id="${imageId}" data-tag-name="${t.tag.replace(/'/g, "\\'")}" title="Remove tag"><i class="bi bi-x-lg"></i></span>`
      : "";

  return html`<span class="tag-pill ${styleClass}"
    >${icon}${t.tag.replace(/_/g, "_\u200B")}${deleteBtn}</span
  >`;
}

export const meta: ComponentMeta = {
  name: "Tag Pill",
  description:
    "Category-colored capsules mapping user, meta, artist, copyrights, characters, and custom tags.",
  variants: [
    {
      name: "Tag Pill Types",
      render: () => html`
        <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center;">
          ${renderTagPill({ tag: "user_tag", category: "user" }, { isDeletable: true, imageId: 1 })}
          ${renderTagPill({ tag: "character_name", category: "character" })}
          ${renderTagPill({ tag: "series_copyright", category: "copyright" })}
          ${renderTagPill({ tag: "meta_system", category: "meta" })}
          ${renderTagPill({ tag: "artist_name", category: "artist" })}
          ${renderTagPill({ tag: "custom_concept", category: "general", source_name: "custom-concept" })}
        </div>
      `,
    },
  ],
};
