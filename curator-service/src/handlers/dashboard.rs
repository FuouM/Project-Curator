use super::{image, settings};
use crate::AppSettings;
use anyhow::Result;
use curator_core::ipc::{
    DevicePreference, EmbeddingModel, ImageDetails, ModelPrecision, TaggerModel,
};
use curator_core::tagger::{TaggerManager, TaggerStatusInfo};
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct DashboardInitResult {
    pub image_count: i64,
    pub vector_count: i64,
    pub pending_jobs: i64,
    pub preprocessing_jobs: i64,
    pub tagger_loaded: bool,
    pub tagger_model_path: String,
    pub tagger_total_tags: usize,
    pub clip_device: DevicePreference,
    pub tagger_device: DevicePreference,
    pub tagger_wd_device: DevicePreference,
    pub idle_timeout_secs: u64,
    pub embedding_model: EmbeddingModel,
    pub detection_device: DevicePreference,
    pub detection_metrics_device: DevicePreference,
    pub ocr_device: DevicePreference,
    pub safety_device: DevicePreference,
    pub model_precisions: HashMap<String, ModelPrecision>,
    pub preferred_tagger: TaggerModel,
    pub taggers: Vec<TaggerStatusInfo>,
    pub featured_images: Vec<ImageDetails>,
    pub latest_images: Vec<ImageDetails>,
}

pub async fn get_dashboard_init_logic(
    db: &SqlitePool,
    data_dir: &Path,
    settings: &Arc<Mutex<AppSettings>>,
    taggers: &Arc<TaggerManager>,
    preferred_source: &str,
    vector_source: &str,
) -> Result<DashboardInitResult> {
    let (status_result, settings_result) = tokio::join!(
        async {
            let active = { settings.lock().await.embedding_model };
            settings::query_status(db, active).await
        },
        async { settings.lock().await.clone() },
    );

    let (image_count, vector_count, pending_jobs, preprocessing_jobs, _ram) = status_result?;

    let tagger_statuses = taggers.statuses();
    let tagger_loaded = tagger_statuses.iter().any(|t| t.loaded);
    let tagger_model_path = tagger_statuses
        .iter()
        .find(|t| t.loaded)
        .map(|t| t.model_path.clone())
        .unwrap_or_default();
    let tagger_total_tags = tagger_statuses
        .iter()
        .map(|t| t.total_tags)
        .max()
        .unwrap_or(0);

    let (featured_result, latest_resp) = tokio::join!(
        image::get_featured_image(db, data_dir, preferred_source, vector_source),
        image::list_images_logic(8, 0, None, preferred_source, vector_source, db),
    );

    let featured_images = featured_result.into_iter().collect();
    let latest_images = latest_resp.map(|(imgs, _)| imgs).unwrap_or_default();

    Ok(DashboardInitResult {
        image_count,
        vector_count,
        pending_jobs,
        preprocessing_jobs,
        tagger_loaded,
        tagger_model_path,
        tagger_total_tags,
        clip_device: settings_result.clip_device,
        tagger_device: settings_result.tagger_device,
        tagger_wd_device: settings_result.tagger_wd_device,
        idle_timeout_secs: settings_result.idle_timeout_secs,
        embedding_model: settings_result.embedding_model,
        detection_device: settings_result.detection_device,
        detection_metrics_device: settings_result.detection_metrics_device,
        ocr_device: settings_result.ocr_device,
        safety_device: settings_result.safety_device,
        model_precisions: settings_result.model_precisions,
        preferred_tagger: settings_result.preferred_tagger,
        taggers: tagger_statuses,
        featured_images,
        latest_images,
    })
}
