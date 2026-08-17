import { typedCall } from "../ipc";
import { imageDetailsFromProto } from "../proto-adapters";
import { GetImageRequestSchema, ImageResultSchema } from "../gen/gallery_pb";
import { renderCardTagsContainerHtml } from "../components/card-tags";

export async function refreshCardTags(imgId: number) {
  try {
    const resp = await typedCall(
      "GalleryService.GetImage",
      GetImageRequestSchema,
      { imageId: BigInt(imgId) },
      ImageResultSchema,
    );
    if (!resp.image) return;
    const img = imageDetailsFromProto(resp.image);
    const containerHtml = renderCardTagsContainerHtml(img);
    document.querySelectorAll(`[data-image-id="${imgId}"] .card-tags-container`).forEach((el) => {
      el.innerHTML = containerHtml;
    });
    const featuredCard = document.querySelector(`#featured-day-content [data-image-id="${imgId}"]`);
    if (featuredCard) {
      const featuredDetailsContainer = document.querySelector(
        "#featured-day-content .featured-details .card-tags-container",
      );
      if (featuredDetailsContainer) {
        featuredDetailsContainer.innerHTML = renderCardTagsContainerHtml(img, true);
      }
    }
  } catch (e) {
    console.error("Failed to refresh card tags:", e);
  }
}
