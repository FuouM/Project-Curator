use super::image;
use crate::AppSettings;
use anyhow::{Result, bail};
use curator_core::ipc::{TagSummary, TaggerModel};
use curator_core::tagger::TaggerManager;
use sqlx::SqlitePool;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::info;

pub async fn tag_image_batch_logic(
    image_ids: Vec<i64>,
    threshold: Option<f32>,
    force: Option<bool>,
    tagger: Option<TaggerModel>,
    settings: &Arc<Mutex<AppSettings>>,
    taggers: &Arc<TaggerManager>,
    db: &SqlitePool,
) -> Result<(usize, usize, usize)> {
    let preferred = { settings.lock().await.preferred_tagger };
    let model = tagger.unwrap_or(preferred);
    let engine = taggers.engine(&model);
    let threshold = threshold.unwrap_or(engine.spec().default_threshold);
    let force = force.unwrap_or(false);

    let mut processed = 0usize;
    let mut failed = 0usize;
    let mut skipped = 0usize;

    for image_id in image_ids {
        match image::tag_image_logic(image_id, threshold, force, db, engine).await {
            Ok(outcome) => {
                if outcome.skipped {
                    skipped += 1;
                } else {
                    processed += 1;
                }
            }
            Err(e) => {
                tracing::warn!("Batch auto-tag failed for image {}: {:?}", image_id, e);
                failed += 1;
            }
        }
    }

    Ok((processed, failed, skipped))
}

pub async fn ephemeral_tag_image_logic(
    path: String,
    threshold: Option<f32>,
    tagger: Option<TaggerModel>,
    settings: &Arc<Mutex<AppSettings>>,
    taggers: &Arc<TaggerManager>,
) -> Result<(String, Vec<TagSummary>)> {
    let preferred = { settings.lock().await.preferred_tagger };
    let engine = taggers.engine(&tagger.unwrap_or(preferred));
    let threshold = threshold.unwrap_or(engine.spec().default_threshold);
    let res = tokio::task::block_in_place(|| engine.tag_image(&path, threshold));
    match res {
        Ok(preds) => {
            info!(
                "EphemeralTagImage {:?}: {} predictions at threshold {}",
                path,
                preds.len(),
                threshold
            );
            let tags: Vec<TagSummary> = preds
                .iter()
                .map(|p| TagSummary {
                    tag: p.tag.clone(),
                    category: p.category.clone(),
                    confidence: p.confidence,
                    source_name: Some(engine.spec().source_name.to_string()),
                    is_blacklisted: false,
                })
                .collect();
            Ok((path, tags))
        }
        Err(e) => bail!("Ephemeral tagging failed: {:?}", e),
    }
}
