use anyhow::Result;
use curator_core::ipc::{EmbeddingModel, TaggerModel};
use curator_core::tagger::TaggerManager;
use curator_core::vector::{ModelManager, VectorIndex};
use sqlx::SqlitePool;
use tracing::{info, warn};

use super::AppSettings;
use super::common::{reindex_all_pending, resolve_source_id};

pub struct UpdateSettingsParams<'a> {
    pub db: &'a SqlitePool,
    pub model_manager: &'a ModelManager,
    pub vector_index: &'a VectorIndex,
    pub taggers: &'a std::sync::Arc<TaggerManager>,
    pub data_dir: &'a std::path::Path,
    pub settings: &'a tokio::sync::Mutex<AppSettings>,
    pub clip_device: Option<curator_core::ipc::DevicePreference>,
    pub tagger_device: Option<curator_core::ipc::DevicePreference>,
    pub tagger_wd_device: Option<curator_core::ipc::DevicePreference>,
    pub idle_timeout_secs: Option<u64>,
    pub embedding_model: Option<EmbeddingModel>,
    pub detection_device: Option<curator_core::ipc::DevicePreference>,
    pub detection_metrics_device: Option<curator_core::ipc::DevicePreference>,
    pub ocr_device: Option<curator_core::ipc::DevicePreference>,
    pub model_precisions:
        Option<std::collections::HashMap<String, curator_core::ipc::ModelPrecision>>,
    pub preferred_tagger: Option<TaggerModel>,
}

pub fn get_app_ram_usage() -> i64 {
    use sysinfo::System;

    let sys = System::new_all();

    let current_pid = sysinfo::get_current_pid().ok();
    let dashboard_name = "curator-dashboard";

    let mut tracked_pids = std::collections::HashSet::new();

    // Add curator-service itself
    if let Some(pid) = current_pid {
        tracked_pids.insert(pid);
    }

    // Add dashboard process(es)
    for (pid, proc) in sys.processes() {
        let name = proc.name().to_string_lossy().to_lowercase();
        if name.contains(dashboard_name) {
            tracked_pids.insert(*pid);
        }
    }

    // Iteratively resolve children/subprocesses
    let mut added = true;
    while added {
        added = false;
        for (pid, proc) in sys.processes() {
            if tracked_pids.contains(pid) {
                continue;
            }
            if let Some(parent_pid) = proc.parent() {
                if tracked_pids.contains(&parent_pid) {
                    tracked_pids.insert(*pid);
                    added = true;
                }
            }
        }
    }

    // Sum RSS memory
    let mut total_memory_bytes = 0u64;
    for pid in &tracked_pids {
        if let Some(proc) = sys.process(*pid) {
            total_memory_bytes += proc.memory();
        }
    }

    total_memory_bytes as i64
}

pub async fn query_status(
    db: &SqlitePool,
    active: EmbeddingModel,
) -> Result<(i64, i64, i64, i64, i64)> {
    let source_name = active.source_name();
    let source_id = resolve_source_id(db, source_name).await.unwrap_or_default();

    let row: (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT 
            (SELECT COUNT(*) FROM images WHERE deleted_at IS NULL) as images,
            (SELECT COUNT(*) FROM image_vectors WHERE vector_state = 'ready' AND source_id = ?) as vectors,
            (SELECT COUNT(*) FROM image_vectors WHERE vector_state = 'pending' AND source_id = ?) as pending,
            (SELECT COUNT(*) FROM image_vectors WHERE vector_state = 'preprocessing' AND source_id = ?) as preprocessing"
    )
    .bind(source_id)
    .bind(source_id)
    .bind(source_id)
    .fetch_one(db)
    .await?;

    let ram = get_app_ram_usage();

    Ok((row.0, row.1, row.2, row.3, ram))
}

pub async fn update_settings_logic(params: UpdateSettingsParams<'_>) -> Result<AppSettings> {
    let UpdateSettingsParams {
        db,
        model_manager,
        vector_index,
        taggers,
        data_dir,
        settings,
        clip_device,
        tagger_device,
        tagger_wd_device,
        idle_timeout_secs,
        embedding_model,
        detection_device,
        detection_metrics_device,
        ocr_device,
        model_precisions,
        preferred_tagger,
    } = params;
    let mut model_changed = false;
    let mut s = settings.lock().await;
    if let Some(ref cd) = clip_device {
        s.clip_device = cd.clone();
    }
    if let Some(ref td) = tagger_device {
        s.tagger_device = td.clone();
    }
    if let Some(ref twd) = tagger_wd_device {
        s.tagger_wd_device = twd.clone();
    }
    if let Some(to) = idle_timeout_secs {
        s.idle_timeout_secs = to;
    }
    if let Some(ref em) = embedding_model {
        if s.embedding_model != *em {
            s.embedding_model = *em;
            model_changed = true;
        }
    }
    if let Some(ref dd) = detection_device {
        s.detection_device = dd.clone();
    }
    if let Some(ref md) = detection_metrics_device {
        s.detection_metrics_device = md.clone();
    }
    if let Some(ref od) = ocr_device {
        s.ocr_device = od.clone();
    }
    if let Some(ref mp) = model_precisions {
        s.model_precisions = mp.clone();
    }
    if let Some(pt) = preferred_tagger {
        if s.preferred_tagger != pt {
            s.preferred_tagger = pt;
        }
    }
    let clip = s.clip_device.clone();
    let tagger_dev = s.tagger_device.clone();
    let tagger_wd_dev = s.tagger_wd_device.clone();
    let idle = s.idle_timeout_secs;
    let active_model = s.embedding_model;
    let det_dev = s.detection_device.clone();
    let det_met_dev = s.detection_metrics_device.clone();
    let ocr_dev = s.ocr_device.clone();
    let model_precs = s.model_precisions.clone();
    let preferred = s.preferred_tagger;
    let enabled_plugins = s.enabled_plugins.clone();
    let s_ffmpeg_path = s.ffmpeg_path.clone();
    let s_tool_paths = s.tool_paths.clone();

    let settings_to_save = s.clone();
    let data_dir_buf = data_dir.to_path_buf();
    drop(s);

    let save_res =
        tokio::task::spawn_blocking(move || crate::save_settings(&data_dir_buf, &settings_to_save))
            .await;
    if let Ok(Err(e)) = save_res {
        warn!("Failed to save settings: {:?}", e);
    }
    if clip_device.is_some() {
        model_manager.set_device(clip.clone());
    }

    if tagger_device.is_some() {
        taggers.camie.set_device(tagger_dev.clone());
    }

    if tagger_wd_device.is_some() {
        taggers.wd.set_device(tagger_wd_dev.clone());
    }

    if model_changed {
        model_manager.set_active_model(active_model);
        if let Err(e) = model_manager.init() {
            return Err(anyhow::anyhow!("Failed to initialize new model: {:?}", e));
        }

        let source_name = active_model.source_name();
        let source_id = resolve_source_id(db, source_name)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to fetch source ID for model change: {:?}", e))?;
        reindex_all_pending(db, vector_index, source_id).await?;
    }

    info!(
        "Settings updated: clip_device={:?}, tagger_device={:?}, tagger_wd_device={:?}, detection_device={:?}, detection_metrics_device={:?}, ocr_device={:?}, model_precisions={:?}, idle_timeout={}s, embedding_model={:?}, preferred_tagger={:?}",
        clip,
        tagger_dev,
        tagger_wd_dev,
        det_dev,
        det_met_dev,
        ocr_dev,
        model_precs,
        idle,
        active_model,
        preferred
    );

    Ok(AppSettings {
        clip_device: clip,
        tagger_device: tagger_dev,
        tagger_wd_device: tagger_wd_dev,
        idle_timeout_secs: idle,
        embedding_model: active_model,
        detection_device: det_dev,
        detection_metrics_device: det_met_dev,
        ocr_device: ocr_dev,
        model_precisions: model_precs,
        preferred_tagger: preferred,
        enabled_plugins,
        ffmpeg_path: s_ffmpeg_path,
        tool_paths: s_tool_paths,
    })
}
