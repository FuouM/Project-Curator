pub mod common;
pub mod concepts;
pub mod image;
pub mod import;
pub mod misc;
pub mod models;
pub mod plugins;
pub mod search;
pub mod settings;
pub mod tags;

use curator_core::detection::DetectionPipeline;
use curator_core::ipc::{EmbeddingModel, ModelPrecision, Request, Response, TaggerBenchmarkInfo};
use curator_core::tagger::TaggerManager;
use curator_core::thumbnail::ThumbnailCache;
use curator_core::vector::{ModelManager, VectorIndex};
use sqlx::SqlitePool;
use std::path::Path;
use std::sync::Arc;
use tracing::{error, info, warn};
use curator_core::image as core_image;

use crate::AppSettings;

/// Run the CPU/GPU ONNX benchmark for one tagger engine and produce a
/// `TaggerBenchmarkInfo` (prefers the quantized int8 variant when enabled).
fn benchmark_tagger_engine(
    engine: &Arc<curator_core::tagger::TaggerEngine>,
    model_precisions: &std::collections::HashMap<String, ModelPrecision>,
) -> TaggerBenchmarkInfo {
    let spec = engine.spec();
    let prefer_quantized = model_precisions
        .get(spec.key)
        .copied()
        .unwrap_or(ModelPrecision::Original)
        == ModelPrecision::Int8;

    let mut tagger_path = engine.model_path().to_path_buf();
    if prefer_quantized {
        let int8_name = format!("{}_int8.onnx", spec.key);
        let int8_path = tagger_path.with_file_name(&int8_name);
        if int8_path.exists() {
            tagger_path = int8_path;
        }
    }

    let (cpu_time_ms, gpu_time_ms, gpu_error) = if tagger_path.exists() {
        match curator_core::run_onnx_benchmark(&tagger_path, spec.input_size as usize) {
            Ok((cpu, gpu, err, _)) => (Some(cpu), gpu, err),
            Err(e) => (
                None,
                None,
                Some(format!("Tagger benchmark failed: {:?}", e)),
            ),
        }
    } else {
        (None, None, Some("Tagger model file not found.".to_string()))
    };

    TaggerBenchmarkInfo {
        key: spec.key.to_string(),
        name: spec.display_name.to_string(),
        input_size: spec.input_size,
        cpu_time_ms,
        gpu_time_ms,
        gpu_error,
    }
}

pub(crate) type ImageRow = (
    i64,
    String,
    String,
    i64,
    String,
    bool,
    bool,
    Option<String>,
    Option<String>,
    Option<f32>,
    Option<String>,
);

/// Shared live state for a background image-processing benchmark running
/// cross many images. `None` means no benchmark is currently running.
#[derive(Clone, Default)]
pub(crate) struct ImageProcessingBenchmarkProgress {
    pub running: bool,
    pub processed: usize,
    pub total: usize,
    pub decode_time_ms: f64,
    pub thumbnail_time_ms: f64,
    pub clip_preprocess_time_ms: f64,
    pub tagger_preprocess_time_ms: f64,
    pub yolo_preprocess_time_ms: f64,
    pub ccip_extract_preprocess_time_ms: f64,
    pub ocr_det_preprocess_time_ms: f64,
    pub ocr_rec_preprocess_time_ms: f64,
}

pub(crate) type BenchmarkProgressMap =
    Arc<tokio::sync::Mutex<Option<ImageProcessingBenchmarkProgress>>>;

pub async fn handle_request(
    request: Request,
    db: &SqlitePool,
    model_manager: &Arc<ModelManager>,
    vector_index: &VectorIndex,
    taggers: &Arc<TaggerManager>,
    detection: &Arc<DetectionPipeline>,
    ocr: &Arc<curator_core::OcrDetector>,
    data_dir: &Path,
    settings: &Arc<tokio::sync::Mutex<AppSettings>>,
    thumbnail_cache: &ThumbnailCache,
    download_progress: &models::DownloadProgressMap,
    cancel_tokens: &models::CancelTokens,
    benchmark_progress: &BenchmarkProgressMap,
) -> Response {
    let preferred_source = {
        let s = settings.lock().await;
        s.preferred_tagger.source_name().to_string()
    };
    match request {
        Request::Ping => Response::Pong,

        Request::RunBenchmark { embedding_model, run_tagger } => {
            let prefer_quantized_clip = settings
                .lock()
                .await
                .model_precisions
                .get(match embedding_model {
                    EmbeddingModel::ClipVitB32 => "clip-vit-b32",
                    EmbeddingModel::MobileClipS2 => "mobileclip-s2",
                })
                .copied()
                .unwrap_or(curator_core::ipc::ModelPrecision::Original)
                == curator_core::ipc::ModelPrecision::Int8;

            let mut vision_path = match embedding_model {
                EmbeddingModel::ClipVitB32 => model_manager.model_dir().join("clip-vit-b32").join("vision_model.onnx"),
                EmbeddingModel::MobileClipS2 => model_manager
                    .model_dir()
                    .join("mobileclip-s2/onnx/vision_model.onnx"),
            };

            if prefer_quantized_clip {
                let int8_path = vision_path.with_file_name("vision_model_int8.onnx");
                if int8_path.exists() {
                    vision_path = int8_path;
                }
            }

            let target_size = match embedding_model {
                EmbeddingModel::ClipVitB32 => 224,
                EmbeddingModel::MobileClipS2 => 256,
            };
            let run_tagger_val = run_tagger.unwrap_or(true);

            let preferred = { settings.lock().await.preferred_tagger };
            let tagger_engine = taggers.engine(&preferred);
            let tagger_spec = tagger_engine.spec();
            let prefer_quantized_tagger = settings
                .lock()
                .await
                .model_precisions
                .get(tagger_spec.key)
                .copied()
                .unwrap_or(curator_core::ipc::ModelPrecision::Original)
                == curator_core::ipc::ModelPrecision::Int8;

            let mut tagger_path = tagger_engine.model_path().to_path_buf();
            if prefer_quantized_tagger {
                let int8_name = format!("{}_int8.onnx", tagger_spec.key);
                let int8_path = tagger_path.with_file_name(&int8_name);
                if int8_path.exists() {
                    tagger_path = int8_path;
                }
            }

            info!(
                "RunBenchmark request: embedding_model={:?}, vision_path={:?}, run_tagger={}, tagger_path={:?}, tagger_path_exists={}",
                embedding_model,
                vision_path,
                run_tagger_val,
                tagger_path,
                tagger_path.exists()
            );

            let clip_res = curator_core::run_onnx_benchmark(&vision_path, target_size);

            // Benchmark every configured tagger so both models are comparable.
            let model_precisions = settings.lock().await.model_precisions.clone();
            let tagger_infos: Vec<TaggerBenchmarkInfo> = if run_tagger_val {
                taggers.all().iter().map(|engine| {
                    benchmark_tagger_engine(engine, &model_precisions)
                }).collect()
            } else {
                Vec::new()
            };
            let preferred_info = tagger_infos.iter().find(|t| t.key == tagger_spec.key);
            let (tagger_cpu_time_ms, tagger_gpu_time_ms, tagger_gpu_error) = match preferred_info {
                Some(t) => (t.cpu_time_ms, t.gpu_time_ms, t.gpu_error.clone()),
                None => (None, None, None),
            };

            match clip_res {
                Ok((clip_cpu, clip_gpu, clip_err, has_gpu)) => Response::BenchmarkResult {
                    clip_cpu_time_ms: clip_cpu,
                    clip_gpu_time_ms: clip_gpu,
                    clip_gpu_error: clip_err,
                    tagger_cpu_time_ms,
                    tagger_gpu_time_ms,
                    tagger_gpu_error,
                    has_gpu,
                    taggers: tagger_infos,
                },
                Err(e) => Response::Error {
                    message: format!("CLIP model benchmark failed: {:?}", e),
                },
            }
        }

        Request::RunTaggerBenchmark { tagger } => {
            let model_precisions = settings.lock().await.model_precisions.clone();
            let preferred = { settings.lock().await.preferred_tagger };
            let tagger_infos: Vec<TaggerBenchmarkInfo> = match tagger {
                Some(model) => {
                    let engine = taggers.engine(&model);
                    vec![benchmark_tagger_engine(engine, &model_precisions)]
                }
                None => taggers
                    .all()
                    .iter()
                    .map(|engine| benchmark_tagger_engine(engine, &model_precisions))
                    .collect(),
            };

            let preferred_spec = taggers.engine(&preferred).spec();
            let preferred_info = tagger_infos.iter().find(|t| t.key == preferred_spec.key);
            let (tagger_cpu_time_ms, tagger_gpu_time_ms, tagger_gpu_error, has_gpu) = match preferred_info {
                Some(t) => (
                    t.cpu_time_ms,
                    t.gpu_time_ms,
                    t.gpu_error.clone(),
                    t.gpu_time_ms.is_some(),
                ),
                None => (None, None, Some("Tagger model file not found.".to_string()), false),
            };
            Response::BenchmarkResult {
                clip_cpu_time_ms: 0.0,
                clip_gpu_time_ms: None,
                clip_gpu_error: None,
                tagger_cpu_time_ms,
                tagger_gpu_time_ms,
                tagger_gpu_error,
                has_gpu,
                taggers: tagger_infos,
            }
        }

        Request::BenchmarkPreprocess { image_path } => {
            let path = std::path::Path::new(&image_path);
            let input_size = {
                let preferred = settings.lock().await.preferred_tagger;
                taggers.engine(&preferred).spec().input_size
            };
            match curator_core::benchmark_preprocess(path, input_size, 3) {
                Ok((_decode, _resize, _norm, report)) => {
                    info!("Preprocess benchmark:\n{}", report);
                    Response::PreprocessBenchmarkResult { report }
                }
                Err(e) => Response::Error {
                    message: format!("Preprocess benchmark failed: {:?}", e),
                },
            }
        }

        Request::GetStatus => {
            let active = {
                let s = settings.lock().await;
                s.embedding_model
            };
            match settings::query_status(db, active).await {
                Ok((images, vectors, pending, preprocessing)) => Response::StatusResult {
                    image_count: images,
                    vector_count: vectors,
                    pending_jobs: pending,
                    preprocessing_jobs: preprocessing,
                },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }

        Request::ImportImage { path } => {
            let active = {
                let s = settings.lock().await;
                s.embedding_model
            };
            match import::import_image_logic(&path, db, active).await {
                Ok((id, sha256, count, folder_id)) => Response::ImportResult {
                    image_id: id,
                    sha256,
                    imported_count: count,
                    folder_id,
                },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }

        Request::AddTag {
            image_id,
            tag,
            category,
        } => match tags::add_tag_logic(image_id, &tag, &category, db).await {
            Ok(_) => Response::Success,
            Err(e) => Response::Error {
                message: e.to_string(),
            },
        },

        Request::RemoveTag { image_id, tag } => {
            match tags::remove_tag_logic(image_id, &tag, db).await {
                Ok(_) => Response::Success,
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }

        Request::UnblacklistTag { image_id, tag } => {
            match tags::unblacklist_tag_logic(image_id, &tag, db).await {
                Ok(_) => Response::Success,
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }

        Request::Search {
            query_text,
            query_image_path,
            tag_filter,
            filename_filter,
            parse_filter,
            parse_type,
            concept_id,
            character_identity_id,
            ocr_filter,
            ocr_text_search,
            limit,
        } => {
            match search::search_logic(
                search::SearchParams {
                    query_text,
                    query_image_path,
                    tag_filter,
                    filename_filter,
                    parse_filter,
                    parse_type,
                    concept_id,
                    character_identity_id,
                    ocr_filter,
                    ocr_text_search,
                    limit,
                },
                &preferred_source,
                db,
                model_manager,
                vector_index,
            )
            .await
            {
                Ok(matches) => Response::SearchResult { matches },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }

        Request::ListImages {
            limit,
            offset,
            only_favorites,
        } => match image::list_images_logic(limit, offset, only_favorites, &preferred_source, db).await {
            Ok((images, total_count)) => Response::ListResult { images, total_count },
            Err(e) => Response::Error {
                message: e.to_string(),
            },
        },

        Request::SetFavorite { image_id, favorite } => {
            match tags::set_favorite_logic(image_id, favorite, db).await {
                Ok(_) => Response::Success,
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }

        Request::GetThumbnail { image_id, width } => {
            match image::get_thumbnail_logic(image_id, width, thumbnail_cache, db).await {
                Ok((data, is_missing)) => Response::ThumbnailResult { data, is_missing },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }

        Request::PurgeMissingThumbnails => {
            match image::purge_missing_thumbnails_logic(thumbnail_cache, db).await {
                Ok(deleted_count) => Response::PurgeResult { deleted_count },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }

        Request::ClearThumbnailCache => {
            match image::clear_thumbnails_logic(thumbnail_cache).await {
                Ok(deleted_count) => Response::ClearThumbnailCacheResult { deleted_count },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }

        Request::GetImage { image_id } => {
            match image::get_image_logic(image_id, &preferred_source, db).await {
                Ok(image) => Response::ImageResult { image },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        },

        Request::ValidatePlugin { manifest_path } => {
            match misc::validate_plugin_logic(&manifest_path).await {
                Ok((name, version)) => Response::ValidationResult {
                    name,
                    version,
                    valid: true,
                    error: None,
                },
                Err(e) => Response::ValidationResult {
                    name: String::new(),
                    version: String::new(),
                    valid: false,
                    error: Some(e.to_string()),
                },
            }
        }

        Request::ListPlugins => plugins::list_plugins(data_dir, settings).await,

        Request::SetPluginEnabled { plugin_name, enabled } => {
            plugins::set_plugin_enabled(data_dir, settings, &plugin_name, enabled).await
        }

        Request::ReadPluginFile { plugin_name, relative_path } => {
            plugins::read_plugin_file(data_dir, &plugin_name, &relative_path).await
        }

        Request::EphemeralConvertImages {
            conversions,
            quality,
        } => plugins::convert_images(conversions, quality).await,

        Request::PathExists { path } => plugins::path_exists(&path).await,

        Request::GetTaggerStatus => {
            let preferred = { settings.lock().await.preferred_tagger };
            Response::TaggerStatusResult {
                preferred_tagger: preferred,
                taggers: taggers.statuses(),
            }
        }

        Request::TagImage {
            image_id,
            threshold,
            force,
            tagger,
        } => {
            let preferred = { settings.lock().await.preferred_tagger };
            let model = tagger.unwrap_or(preferred);
            let engine = taggers.engine(&model);
            let threshold = threshold.unwrap_or(engine.spec().default_threshold);
            let force = force.unwrap_or(false);
            match image::tag_image_logic(image_id, threshold, force, db, engine).await {
                Ok(outcome) => Response::TagImageResult {
                    image_id,
                    tags_applied: outcome.tags_applied,
                    skipped: outcome.skipped,
                    tags: outcome.tags,
                },
                Err(e) => {
                    error!("TagImage {} failed: {:?}", image_id, e);
                    Response::Error {
                        message: e.to_string(),
                    }
                }
            }
        }

        Request::TagImageBatch {
            image_ids,
            threshold,
            force,
            tagger,
        } => {
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
                        warn!("Batch auto-tag failed for image {}: {:?}", image_id, e);
                        failed += 1;
                    }
                }
            }

            Response::BatchTagResult {
                processed,
                failed,
                skipped,
            }
        }

        Request::BackfillTagSource {
            from_tagger,
            to_tagger,
        } => {
            if from_tagger == to_tagger {
                return Response::Error {
                    message: "from_tagger and to_tagger must differ".to_string(),
                };
            }
            let to_engine = taggers.engine(&to_tagger);
            let to_source = to_tagger.source_name();
            let threshold = to_engine.spec().default_threshold;
            match image::backfill_tag_source_logic(
                db,
                from_tagger.source_name(),
                to_source,
                to_engine,
                threshold,
            )
            .await
            {
                Ok(result) => Response::BatchTagResult {
                    processed: result.processed,
                    failed: result.failed,
                    skipped: result.skipped,
                },
                Err(e) => {
                    error!("BackfillTagSource failed: {:?}", e);
                    Response::Error {
                        message: e.to_string(),
                    }
                }
            }
        }

        Request::ReindexVectors => {
            let active = model_manager.active_model();
            match tags::reindex_vectors_logic(db, vector_index, active).await {
                Ok(_) => Response::Success,
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }

        Request::ReindexFailedVectors => {
            let active = model_manager.active_model();
            match tags::reindex_failed_vectors_logic(db, active).await {
                Ok(count) => Response::ReindexFailedResult { requeued: count },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }

        Request::GetSettings => {
            let s = settings.lock().await;
            Response::SettingsResult {
                clip_device: s.clip_device.clone(),
                tagger_device: s.tagger_device.clone(),
                tagger_wd_device: s.tagger_wd_device.clone(),
                idle_timeout_secs: s.idle_timeout_secs,
                embedding_model: s.embedding_model,
                detection_device: s.detection_device.clone(),
                detection_metrics_device: s.detection_metrics_device.clone(),
                ocr_device: s.ocr_device.clone(),
                model_precisions: s.model_precisions.clone(),
                preferred_tagger: s.preferred_tagger,
                taggers: taggers.statuses(),
            }
        }

        Request::ClearCropCache => {
            match detection.crop_cache.clear().await {
                Ok(_) => Response::Success,
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }

        Request::UpdateSettings {
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
        } => {
            match settings::update_settings_logic(
                settings::UpdateSettingsParams {
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
                },
            )
            .await
            {
                Ok(s) => Response::SettingsResult {
                    clip_device: s.clip_device,
                    tagger_device: s.tagger_device,
                    tagger_wd_device: s.tagger_wd_device,
                    idle_timeout_secs: s.idle_timeout_secs,
                    embedding_model: s.embedding_model,
                    detection_device: s.detection_device,
                    detection_metrics_device: s.detection_metrics_device,
                    ocr_device: s.ocr_device,
                    model_precisions: s.model_precisions,
                    preferred_tagger: s.preferred_tagger,
                    taggers: taggers.statuses(),
                },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }

        Request::GetTagStatistics => {
            match tags::get_tag_statistics_logic(&preferred_source, db).await {
                Ok(tags) => Response::TagStatisticsResult { tags },
                Err(e) => Response::Error {
                    message: format!("Failed to fetch tag statistics: {:?}", e),
                },
            }
        }
        Request::GetCharacterSuggestions { query } => {
            match tags::get_character_suggestions_logic(db, query.as_deref()).await {
                Ok(tags) => Response::TagStatisticsResult { tags },
                Err(e) => Response::Error {
                    message: format!("Failed to fetch character suggestions: {:?}", e),
                },
            }
        }

        Request::GetDashboardInit => {
            let (status_result, settings_result) = tokio::join!(
                async {
                    let active = { settings.lock().await.embedding_model };
                    settings::query_status(db, active).await
                },
                async { settings.lock().await.clone() },
            );

            let (image_count, vector_count, pending_jobs, preprocessing_jobs) = match status_result
            {
                Ok(v) => v,
                Err(e) => {
                    return Response::Error {
                        message: e.to_string(),
                    };
                }
            };

            let settings_val = settings_result;
            let tagger_statuses = taggers.statuses();
            let tagger_loaded = tagger_statuses
                .iter()
                .any(|t| t.loaded);
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
                image::get_featured_image(db, data_dir, &preferred_source),
                image::list_images_logic(8, 0, None, &preferred_source, db),
            );

            let featured_images = featured_result.into_iter().collect();
            let latest_images = latest_resp.map(|(imgs, _)| imgs).unwrap_or_default();

            Response::DashboardInitResult {
                image_count,
                vector_count,
                pending_jobs,
                preprocessing_jobs,
                tagger_loaded,
                tagger_model_path,
                tagger_total_tags,
                clip_device: settings_val.clip_device,
                tagger_device: settings_val.tagger_device,
                tagger_wd_device: settings_val.tagger_wd_device,
                idle_timeout_secs: settings_val.idle_timeout_secs,
                embedding_model: settings_val.embedding_model,
                detection_device: settings_val.detection_device,
                detection_metrics_device: settings_val.detection_metrics_device,
                ocr_device: settings_val.ocr_device,
                model_precisions: settings_val.model_precisions,
                preferred_tagger: settings_val.preferred_tagger,
                taggers: tagger_statuses,
                featured_images,
                latest_images,
            }
        }

        Request::GetImportedFolders => match import::get_imported_folders_logic(db).await {
            Ok(folders) => Response::ImportedFoldersResult { folders },
            Err(e) => Response::Error {
                message: e.to_string(),
            },
        },

        Request::BackfillImageFolders => match import::backfill_image_folders(db).await {
            Ok(count) => Response::BackfillResult {
                images_backfilled: count,
            },
            Err(e) => Response::Error {
                message: e.to_string(),
            },
        },

        Request::UpdateFolderPath { id, new_path } => {
            match import::update_folder_path_logic(id, &new_path, db).await {
                Ok(success) => Response::UpdateFolderPathResult { success },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }

        Request::DeleteFolder { id } => match import::delete_folder_logic(id, db).await {
            Ok(success) => Response::DeleteFolderResult { success },
            Err(e) => Response::Error {
                message: e.to_string(),
            },
        },

        Request::DetectDuplicateFolders => {
            match import::detect_duplicate_folders_logic(db).await {
                Ok(groups) => Response::DuplicateFoldersResult { groups },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }

        Request::MergeFolders {
            keep_folder_id,
            merge_folder_id,
        } => match import::merge_folders_logic(keep_folder_id, merge_folder_id, db).await {
            Ok((success, images_moved)) => Response::MergeFoldersResult {
                success,
                images_moved,
            },
            Err(e) => Response::Error {
                message: e.to_string(),
            },
        },

        Request::CreateConcept {
            name,
            category,
            threshold,
            sample_image_ids,
        } => match concepts::create_concept_logic(
            db,
            &name,
            &category,
            threshold,
            &sample_image_ids,
            model_manager,
        )
        .await
        {
            Ok(concept) => Response::ConceptResult { concept },
            Err(e) => Response::Error {
                message: e.to_string(),
            },
        },

        Request::ListConcepts => match concepts::list_concepts_logic(db).await {
            Ok(concepts) => Response::ConceptListResult { concepts },
            Err(e) => Response::Error {
                message: e.to_string(),
            },
        },

        Request::UpdateConcept {
            id,
            threshold,
            category,
        } => match concepts::update_concept_logic(db, id, threshold, category).await {
            Ok(concept) => Response::ConceptResult { concept },
            Err(e) => Response::Error {
                message: e.to_string(),
            },
        },

        Request::DeleteConcept { id } => match concepts::delete_concept_logic(db, id).await {
            Ok(_) => Response::Success,
            Err(e) => Response::Error {
                message: e.to_string(),
            },
        },

        Request::AddConceptSamples {
            concept_id,
            image_ids,
        } => match concepts::add_concept_samples_logic(db, concept_id, &image_ids, model_manager)
            .await
        {
            Ok(concept) => Response::ConceptResult { concept },
            Err(e) => Response::Error {
                message: e.to_string(),
            },
        },

        Request::RemoveConceptSample {
            concept_id,
            image_id,
        } => {
            match concepts::remove_concept_sample_logic(db, concept_id, image_id, model_manager)
                .await
            {
                Ok(concept) => Response::ConceptResult { concept },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }

        Request::RescanConcept { concept_id } => {
            match concepts::rescan_concept_logic(db, concept_id, model_manager, vector_index).await
            {
                Ok(count) => Response::ConceptRescannedResult {
                    concept_id,
                    tagged_count: count,
                },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }

        Request::GetConceptSamples { concept_id } => {
            match concepts::get_concept_samples_logic(db, concept_id, &preferred_source).await {
                Ok(samples) => Response::ConceptSamplesResult { concept_id, samples },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }

        Request::CleanAutoConceptTags { concept_id } => {
            match concepts::clean_auto_concept_tags_logic(db, concept_id).await {
                Ok(cleaned_count) => Response::AutoConceptTagsCleanedResult { cleaned_count },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }

        Request::TestFilenamePattern {
            filename,
            pattern_or_type,
            rule_type,
            token_config,
        } => {
            let res = curator_core::FilenameParser::test_filename(
                &filename,
                &pattern_or_type,
                &rule_type,
                token_config.as_deref(),
            );
            Response::TestFilenamePatternResult { result: res }
        }

        Request::CompileTokenBlocks { token_config } => {
            let regex = curator_core::FilenameParser::compile_token_blocks(&token_config);
            Response::CompileTokenBlocksResult { regex }
        }

        Request::PreviewBatchFilenameParsing {
            limit,
            pattern_or_type,
            rule_type,
            token_config,
            output_match_type,
        } => {
            match curator_core::FilenameParser::preview_batch(
                db,
                limit,
                &pattern_or_type,
                &rule_type,
                token_config.as_deref(),
                output_match_type.as_deref(),
            )
            .await
            {
                Ok(items) => Response::PreviewBatchFilenameParsingResult { items },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }

        Request::RunBatchFilenameParsing {
            pattern_or_type,
            rule_type,
            token_config,
            output_match_type,
        } => {
            match curator_core::FilenameParser::run_batch(
                db,
                &pattern_or_type,
                &rule_type,
                token_config.as_deref(),
                output_match_type.as_deref(),
            )
            .await
            {
                Ok(res) => Response::RunBatchFilenameParsingResult {
                    total_processed: res.total_processed,
                    matched_count: res.matched_count,
                    tags_created: res.tags_created,
                },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }

        // ── Character Detection ──────────────────────────────────────
        Request::DetectCharacters { image_id } => {
            match detection.detect_image(image_id).await {
                Ok(result) => Response::DetectionResult {
                    image_id: result.image_id,
                    detections: result.detections,
                },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }
        Request::DetectCharactersBatch { image_ids } => {
            match detection.detect_batch(&image_ids).await {
                Ok(results) => Response::DetectionBatchResult { results },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }
        Request::GetCharacterDetections { image_id } => {
            match detection.get_detections(image_id).await {
                Ok(detections) => Response::CharacterDetectionsResult {
                    image_id,
                    detections,
                },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }
        Request::GetCharacterDetectionsBatch { image_ids } => {
            match detection.get_detections_batch(&image_ids).await {
                Ok(results) => Response::DetectionBatchResult { results },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }
        Request::GetDetectionCrop {
            detection_id,
            max_size,
        } => {
            let _size = max_size.unwrap_or(128);
            match detection.load_crop_jpeg(detection_id).await {
                Ok(Some(bytes)) => Response::DetectionCropResult {
                    crop_webp_bytes: bytes,
                },
                Ok(None) => Response::Error {
                    message: "Image file not found".to_string(),
                },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }
        Request::GetDetectionCrops {
            detection_ids,
            max_size,
        } => {
            let _size = max_size.unwrap_or(128);
            let mut crops = Vec::with_capacity(detection_ids.len());
            for detection_id in detection_ids {
                match detection.load_crop_jpeg(detection_id).await {
                    Ok(Some(bytes)) => crops.push(curator_core::detection::DetectionCropEntry {
                        detection_id,
                        crop_webp_bytes: bytes,
                    }),
                    Ok(None) => {}
                    Err(e) => {
                        return Response::Error {
                            message: e.to_string(),
                        };
                    }
                }
            }
            Response::DetectionCropsResult { crops }
        }
        Request::AssignCharacterIdentity {
            detection_id,
            identity_id,
        } => match detection.assign_identity(detection_id, identity_id).await {
            Ok(()) => Response::Success,
            Err(e) => Response::Error {
                message: e.to_string(),
            },
        },
        Request::CreateCharacterIdentity { name } => {
            match detection.create_identity(name).await {
                Ok(id) => Response::CharacterIdentitiesList {
                    identities: vec![curator_core::detection::CharacterIdentity {
                        id,
                        name: String::new(),
                        detection_count: 0,
                        created_at: String::new(),
                    }],
                },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }
        Request::RenameCharacterIdentity { identity_id, name } => {
            match detection.rename_identity(identity_id, name).await {
                Ok(()) => Response::Success,
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }
        Request::DeleteCharacterIdentity { identity_id } => {
            match detection.delete_identity(identity_id).await {
                Ok(()) => Response::Success,
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }
        Request::ListCharacterIdentities => {
            match detection.list_identities().await {
                Ok(identities) => Response::CharacterIdentitiesList { identities },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }
        Request::ReidentifyAllDetections => {
            match detection.reidentify_all().await {
                Ok(result) => Response::ReidentifyResult {
                    total_detections: result.total_detections,
                    matched: result.matched,
                    unmatched: result.unmatched,
                },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }
        Request::SearchByCharacter { identity_id } => {
            match detection.search_by_character(identity_id).await {
                Ok(image_ids) => Response::CharacterSearchResult { image_ids },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }
        Request::SearchByCharacterBatch { identity_ids } => {
            match detection.search_by_character_batch(&identity_ids).await {
                Ok(results) => Response::CharacterSearchBatchResult { results },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }
        Request::ListUnassignedDetections => {
            match detection.list_unassigned_detections().await {
                Ok(detections) => Response::UnassignedDetectionsList { detections },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }
        Request::DeleteDetection { detection_id } => {
            match detection.delete_detection(detection_id).await {
                Ok(()) => Response::Success,
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }
        Request::UpdateDetectionBoundingBox { detection_id, x0, y0, x1, y1 } => {
            match detection.update_detection_bbox(detection_id, x0, y0, x1, y1).await {
                Ok(()) => Response::Success,
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }
        Request::AddDetection { image_id, x0, y0, x1, y1 } => {
            match detection.add_detection(image_id, x0, y0, x1, y1).await {
                Ok(det) => Response::AddDetectionResult { detection: det },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }
        Request::IdentifyDetection { detection_id } => {
            match detection.identify_detection(detection_id).await {
                Ok(ident_id) => Response::IdentifyDetectionResult { identity_id: ident_id },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }

        Request::RunYoloBenchmark => {
            let det_dir = data_dir.join("models");
            let prefer_quantized = settings
                .lock()
                .await
                .model_precisions
                .get("yolo-person")
                .copied()
                .unwrap_or(curator_core::ipc::ModelPrecision::Original)
                == curator_core::ipc::ModelPrecision::Int8;

            let mut yolo_path = det_dir.join("yolo-person/model.onnx");
            if prefer_quantized {
                let int8_path = det_dir.join("yolo-person/model_int8.onnx");
                if int8_path.exists() {
                    yolo_path = int8_path;
                }
            }
            info!("RunYoloBenchmark request: exists={}", yolo_path.exists());

            if !yolo_path.exists() {
                return Response::Error { message: "YOLO model file not found.".to_string() };
            }

            match curator_core::run_onnx_benchmark(&yolo_path, 640) {
                Ok((cpu, gpu, err, has_gpu)) => Response::DetectionBenchmarkResult {
                    yolo_cpu_time_ms: Some(cpu),
                    yolo_gpu_time_ms: gpu,
                    yolo_gpu_error: err,
                    ccip_feat_cpu_time_ms: None,
                    ccip_feat_gpu_time_ms: None,
                    ccip_feat_gpu_error: None,
                    ccip_metrics_cpu_time_ms: None,
                    ccip_metrics_gpu_time_ms: None,
                    ccip_metrics_gpu_error: None,
                    ocr_det_cpu_time_ms: None,
                    ocr_det_gpu_time_ms: None,
                    ocr_det_gpu_error: None,
                    ocr_rec_cpu_time_ms: None,
                    ocr_rec_gpu_time_ms: None,
                    ocr_rec_gpu_error: None,
                    ocr_cls_cpu_time_ms: None,
                    ocr_cls_gpu_time_ms: None,
                    ocr_cls_gpu_error: None,
                    manga_bubble_cpu_time_ms: None,
                    manga_bubble_gpu_time_ms: None,
                    manga_bubble_gpu_error: None,
                    has_gpu,
                },
                Err(e) => Response::Error {
                    message: format!("Yolo benchmark failed: {:?}", e),
                },
            }
        }

        Request::RunCcipFeatBenchmark => {
            let det_dir = data_dir.join("models");
            let ccip_feat_path = det_dir.join("ccip/model_feat.onnx");
            info!("RunCcipFeatBenchmark request: exists={}", ccip_feat_path.exists());

            if !ccip_feat_path.exists() {
                return Response::Error { message: "CCIP Feature model file not found.".to_string() };
            }

            match curator_core::run_onnx_benchmark(&ccip_feat_path, 384) {
                Ok((cpu, gpu, err, has_gpu)) => Response::DetectionBenchmarkResult {
                    yolo_cpu_time_ms: None,
                    yolo_gpu_time_ms: None,
                    yolo_gpu_error: None,
                    ccip_feat_cpu_time_ms: Some(cpu),
                    ccip_feat_gpu_time_ms: gpu,
                    ccip_feat_gpu_error: err,
                    ccip_metrics_cpu_time_ms: None,
                    ccip_metrics_gpu_time_ms: None,
                    ccip_metrics_gpu_error: None,
                    ocr_det_cpu_time_ms: None,
                    ocr_det_gpu_time_ms: None,
                    ocr_det_gpu_error: None,
                    ocr_rec_cpu_time_ms: None,
                    ocr_rec_gpu_time_ms: None,
                    ocr_rec_gpu_error: None,
                    ocr_cls_cpu_time_ms: None,
                    ocr_cls_gpu_time_ms: None,
                    ocr_cls_gpu_error: None,
                    manga_bubble_cpu_time_ms: None,
                    manga_bubble_gpu_time_ms: None,
                    manga_bubble_gpu_error: None,
                    has_gpu,
                },
                Err(e) => Response::Error {
                    message: format!("CCIP Feature benchmark failed: {:?}", e),
                },
            }
        }

        Request::RunCcipMetricsBenchmark => {
            let det_dir = data_dir.join("models");
            let ccip_metrics_path = det_dir.join("ccip/model_metrics.onnx");
            info!("RunCcipMetricsBenchmark request: exists={}", ccip_metrics_path.exists());

            if !ccip_metrics_path.exists() {
                return Response::Error { message: "CCIP Metrics model file not found.".to_string() };
            }

            match curator_core::run_onnx_benchmark_2d(&ccip_metrics_path, 16, 768) {
                Ok((cpu, gpu, err, has_gpu)) => Response::DetectionBenchmarkResult {
                    yolo_cpu_time_ms: None,
                    yolo_gpu_time_ms: None,
                    yolo_gpu_error: None,
                    ccip_feat_cpu_time_ms: None,
                    ccip_feat_gpu_time_ms: None,
                    ccip_feat_gpu_error: None,
                    ccip_metrics_cpu_time_ms: Some(cpu),
                    ccip_metrics_gpu_time_ms: gpu,
                    ccip_metrics_gpu_error: err,
                    ocr_det_cpu_time_ms: None,
                    ocr_det_gpu_time_ms: None,
                    ocr_det_gpu_error: None,
                    ocr_rec_cpu_time_ms: None,
                    ocr_rec_gpu_time_ms: None,
                    ocr_rec_gpu_error: None,
                    ocr_cls_cpu_time_ms: None,
                    ocr_cls_gpu_time_ms: None,
                    ocr_cls_gpu_error: None,
                    manga_bubble_cpu_time_ms: None,
                    manga_bubble_gpu_time_ms: None,
                    manga_bubble_gpu_error: None,
                    has_gpu,
                },
                Err(e) => Response::Error {
                    message: format!("CCIP Metrics benchmark failed: {:?}", e),
                },
            }
        }

        Request::RunOcrDetBenchmark => {
            let det_dir = data_dir.join("models");
            let prefer_quantized = settings
                .lock()
                .await
                .model_precisions
                .get("pp-ocrv6-medium")
                .copied()
                .unwrap_or(curator_core::ipc::ModelPrecision::Original)
                == curator_core::ipc::ModelPrecision::Int8;

            let mut path = det_dir.join("pp-ocrv6-medium/det/inference.onnx");
            if prefer_quantized {
                let int8_path = det_dir.join("pp-ocrv6-medium/det/inference_int8.onnx");
                if int8_path.exists() {
                    path = int8_path;
                }
            }
            if !path.exists() {
                return Response::Error { message: "OCR Detection model file not found.".to_string() };
            }
            match curator_core::run_onnx_benchmark(&path, 960) {
                Ok((cpu, gpu, err, has_gpu)) => Response::DetectionBenchmarkResult {
                    yolo_cpu_time_ms: None,
                    yolo_gpu_time_ms: None,
                    yolo_gpu_error: None,
                    ccip_feat_cpu_time_ms: None,
                    ccip_feat_gpu_time_ms: None,
                    ccip_feat_gpu_error: None,
                    ccip_metrics_cpu_time_ms: None,
                    ccip_metrics_gpu_time_ms: None,
                    ccip_metrics_gpu_error: None,
                    ocr_det_cpu_time_ms: Some(cpu),
                    ocr_det_gpu_time_ms: gpu,
                    ocr_det_gpu_error: err,
                    ocr_rec_cpu_time_ms: None,
                    ocr_rec_gpu_time_ms: None,
                    ocr_rec_gpu_error: None,
                    ocr_cls_cpu_time_ms: None,
                    ocr_cls_gpu_time_ms: None,
                    ocr_cls_gpu_error: None,
                    manga_bubble_cpu_time_ms: None,
                    manga_bubble_gpu_time_ms: None,
                    manga_bubble_gpu_error: None,
                    has_gpu,
                },
                Err(e) => Response::Error { message: format!("OCR Detection benchmark failed: {:?}", e) },
            }
        }

        Request::RunOcrRecBenchmark => {
            let det_dir = data_dir.join("models");
            let prefer_quantized = settings
                .lock()
                .await
                .model_precisions
                .get("pp-ocrv6-medium")
                .copied()
                .unwrap_or(curator_core::ipc::ModelPrecision::Original)
                == curator_core::ipc::ModelPrecision::Int8;

            let mut path = det_dir.join("pp-ocrv6-medium/rec/inference.onnx");
            if prefer_quantized {
                let int8_path = det_dir.join("pp-ocrv6-medium/rec/inference_int8.onnx");
                if int8_path.exists() {
                    path = int8_path;
                }
            }
            if !path.exists() {
                return Response::Error { message: "OCR Recognition model file not found.".to_string() };
            }
            match curator_core::run_onnx_benchmark_4d(&path, 48, 320) {
                Ok((cpu, gpu, err, has_gpu)) => Response::DetectionBenchmarkResult {
                    yolo_cpu_time_ms: None,
                    yolo_gpu_time_ms: None,
                    yolo_gpu_error: None,
                    ccip_feat_cpu_time_ms: None,
                    ccip_feat_gpu_time_ms: None,
                    ccip_feat_gpu_error: None,
                    ccip_metrics_cpu_time_ms: None,
                    ccip_metrics_gpu_time_ms: None,
                    ccip_metrics_gpu_error: None,
                    ocr_det_cpu_time_ms: None,
                    ocr_det_gpu_time_ms: None,
                    ocr_det_gpu_error: None,
                    ocr_rec_cpu_time_ms: Some(cpu),
                    ocr_rec_gpu_time_ms: gpu,
                    ocr_rec_gpu_error: err,
                    ocr_cls_cpu_time_ms: None,
                    ocr_cls_gpu_time_ms: None,
                    ocr_cls_gpu_error: None,
                    manga_bubble_cpu_time_ms: None,
                    manga_bubble_gpu_time_ms: None,
                    manga_bubble_gpu_error: None,
                    has_gpu,
                },
                Err(e) => Response::Error { message: format!("OCR Recognition benchmark failed: {:?}", e) },
            }
        }

        Request::RunOcrClsBenchmark => {
            let det_dir = data_dir.join("models");
            let path = det_dir.join("pp-lcnet-cls/inference.onnx");
            if !path.exists() {
                return Response::Error { message: "OCR Classification model file not found.".to_string() };
            }
            match curator_core::run_onnx_benchmark_4d(&path, 80, 160) {
                Ok((cpu, gpu, err, has_gpu)) => Response::DetectionBenchmarkResult {
                    yolo_cpu_time_ms: None,
                    yolo_gpu_time_ms: None,
                    yolo_gpu_error: None,
                    ccip_feat_cpu_time_ms: None,
                    ccip_feat_gpu_time_ms: None,
                    ccip_feat_gpu_error: None,
                    ccip_metrics_cpu_time_ms: None,
                    ccip_metrics_gpu_time_ms: None,
                    ccip_metrics_gpu_error: None,
                    ocr_det_cpu_time_ms: None,
                    ocr_det_gpu_time_ms: None,
                    ocr_det_gpu_error: None,
                    ocr_rec_cpu_time_ms: None,
                    ocr_rec_gpu_time_ms: None,
                    ocr_rec_gpu_error: None,
                    ocr_cls_cpu_time_ms: Some(cpu),
                    ocr_cls_gpu_time_ms: gpu,
                    ocr_cls_gpu_error: err,
                    manga_bubble_cpu_time_ms: None,
                    manga_bubble_gpu_time_ms: None,
                    manga_bubble_gpu_error: None,
                    has_gpu,
                },
                Err(e) => Response::Error { message: format!("OCR Classification benchmark failed: {:?}", e) },
            }
        }

        Request::RunMangaBubbleBenchmark => {
            let det_dir = data_dir.join("models");
            let prefer_quantized = settings
                .lock()
                .await
                .model_precisions
                .get("manga-bubble-yolo")
                .copied()
                .unwrap_or(curator_core::ipc::ModelPrecision::Original)
                == curator_core::ipc::ModelPrecision::Int8;

            let mut path = det_dir.join("manga-bubble-yolo/yolo26n.onnx");
            if prefer_quantized {
                let int8_path = det_dir.join("manga-bubble-yolo/yolo26n_int8.onnx");
                if int8_path.exists() {
                    path = int8_path;
                }
            }
            if !path.exists() {
                return Response::Error { message: "Manga Bubble YOLO model file not found.".to_string() };
            }
            match curator_core::run_onnx_benchmark(&path, 1280) {
                Ok((cpu, gpu, err, has_gpu)) => Response::DetectionBenchmarkResult {
                    yolo_cpu_time_ms: None,
                    yolo_gpu_time_ms: None,
                    yolo_gpu_error: None,
                    ccip_feat_cpu_time_ms: None,
                    ccip_feat_gpu_time_ms: None,
                    ccip_feat_gpu_error: None,
                    ccip_metrics_cpu_time_ms: None,
                    ccip_metrics_gpu_time_ms: None,
                    ccip_metrics_gpu_error: None,
                    ocr_det_cpu_time_ms: None,
                    ocr_det_gpu_time_ms: None,
                    ocr_det_gpu_error: None,
                    ocr_rec_cpu_time_ms: None,
                    ocr_rec_gpu_time_ms: None,
                    ocr_rec_gpu_error: None,
                    ocr_cls_cpu_time_ms: None,
                    ocr_cls_gpu_time_ms: None,
                    ocr_cls_gpu_error: None,
                    manga_bubble_cpu_time_ms: Some(cpu),
                    manga_bubble_gpu_time_ms: gpu,
                    manga_bubble_gpu_error: err,
                    has_gpu,
                },
                Err(e) => Response::Error { message: format!("Manga Bubble YOLO benchmark failed: {:?}", e) },
            }
        }

        Request::GetBenchmarkImages { limit } => {
            match curator_core::get_benchmark_images(db, limit).await {
                Ok(filepaths) => Response::BenchmarkImagesResult { filepaths },
                Err(e) => Response::Error {
                    message: format!("Failed to fetch benchmark images: {:?}", e),
                },
            }
        }

        Request::BenchmarkSingleImage { filepath } => {
            let tagger_spec = {
                let preferred = settings.lock().await.preferred_tagger;
                taggers.engine(&preferred).spec()
            };
            match curator_core::run_single_image_benchmark(model_manager, &filepath, tagger_spec).await {
                Ok(res) => Response::SingleImageBenchmarkResult {
                    decode_time_ms: res.decode_time_ms,
                    thumbnail_time_ms: res.thumbnail_time_ms,
                    clip_preprocess_time_ms: res.clip_preprocess_time_ms,
                    tagger_preprocess_time_ms: res.tagger_preprocess_time_ms,
                    yolo_preprocess_time_ms: res.yolo_preprocess_time_ms,
                    ccip_extract_preprocess_time_ms: res.ccip_extract_preprocess_time_ms,
                    ocr_det_preprocess_time_ms: res.ocr_det_preprocess_time_ms,
                    ocr_rec_preprocess_time_ms: res.ocr_rec_preprocess_time_ms,
                },
                Err(e) => Response::Error {
                    message: format!("Failed to benchmark image {:?}: {:?}", filepath, e),
                },
            }
        }

        Request::RunImageProcessingBenchmark { filepaths } => {
            {
                let mut slot = benchmark_progress.lock().await;
                if let Some(p) = slot.as_ref() {
                    if p.running {
                        return Response::Error {
                            message: "An image processing benchmark is already running.".to_string(),
                        };
                    }
                }
                *slot = Some(ImageProcessingBenchmarkProgress {
                    running: true,
                    total: filepaths.len(),
                    ..Default::default()
                });
            }

            let progress = benchmark_progress.clone();
            let mm = model_manager.clone();
            let tagger_spec = {
                let preferred = settings.lock().await.preferred_tagger;
                taggers.engine(&preferred).spec()
            };
            tokio::spawn(async move {
                for (idx, filepath) in filepaths.iter().enumerate() {
                    match curator_core::run_single_image_benchmark(&mm, filepath, tagger_spec).await {
                        Ok(res) => {
                            let mut slot = progress.lock().await;
                            if let Some(p) = slot.as_mut() {
                                p.processed = idx + 1;
                                p.decode_time_ms += res.decode_time_ms;
                                p.thumbnail_time_ms += res.thumbnail_time_ms;
                                p.clip_preprocess_time_ms += res.clip_preprocess_time_ms;
                                p.tagger_preprocess_time_ms += res.tagger_preprocess_time_ms;
                                p.yolo_preprocess_time_ms += res.yolo_preprocess_time_ms;
                                p.ccip_extract_preprocess_time_ms += res.ccip_extract_preprocess_time_ms;
                                p.ocr_det_preprocess_time_ms += res.ocr_det_preprocess_time_ms;
                                p.ocr_rec_preprocess_time_ms += res.ocr_rec_preprocess_time_ms;
                            }
                        }
                        Err(e) => {
                            tracing::warn!("Benchmark skipped {}: {:?}", filepath, e);
                            let mut slot = progress.lock().await;
                            if let Some(p) = slot.as_mut() {
                                p.processed = idx + 1;
                            }
                        }
                    }
                }
                let mut slot = progress.lock().await;
                if let Some(p) = slot.as_mut() {
                    p.running = false;
                }
            });

            let snapshot = benchmark_progress.lock().await;
            let p = snapshot.as_ref().cloned().unwrap_or_default();
            Response::ImageProcessingBenchmarkProgress {
                running: p.running,
                processed: p.processed,
                total: p.total,
                decode_time_ms: p.decode_time_ms,
                thumbnail_time_ms: p.thumbnail_time_ms,
                clip_preprocess_time_ms: p.clip_preprocess_time_ms,
                tagger_preprocess_time_ms: p.tagger_preprocess_time_ms,
                yolo_preprocess_time_ms: p.yolo_preprocess_time_ms,
                ccip_extract_preprocess_time_ms: p.ccip_extract_preprocess_time_ms,
                ocr_det_preprocess_time_ms: p.ocr_det_preprocess_time_ms,
                ocr_rec_preprocess_time_ms: p.ocr_rec_preprocess_time_ms,
            }
        }

        Request::GetImageProcessingBenchmarkProgress => {
            let snapshot = benchmark_progress.lock().await;
            let p = snapshot.as_ref().cloned().unwrap_or_default();
            Response::ImageProcessingBenchmarkProgress {
                running: p.running,
                processed: p.processed,
                total: p.total,
                decode_time_ms: p.decode_time_ms,
                thumbnail_time_ms: p.thumbnail_time_ms,
                clip_preprocess_time_ms: p.clip_preprocess_time_ms,
                tagger_preprocess_time_ms: p.tagger_preprocess_time_ms,
                yolo_preprocess_time_ms: p.yolo_preprocess_time_ms,
                ccip_extract_preprocess_time_ms: p.ccip_extract_preprocess_time_ms,
                ocr_det_preprocess_time_ms: p.ocr_det_preprocess_time_ms,
                ocr_rec_preprocess_time_ms: p.ocr_rec_preprocess_time_ms,
            }
        }

        Request::GetRandomImage => match image::get_random_image_logic(db, &preferred_source).await {
            Ok((img, index)) => Response::RandomImageResult { image: img, index },
            Err(e) => Response::Error {
                message: format!("Failed to get random image: {:?}", e),
            },
        },

        Request::RunOcr { image_id } => {
            let row: Option<(String,)> = match sqlx::query_as("SELECT current_filepath FROM images WHERE id = ? AND deleted_at IS NULL")
                .bind(image_id)
                .fetch_optional(db)
                .await
            {
                Ok(r) => r,
                Err(e) => return Response::Error { message: format!("DB Error: {:?}", e) },
            };

            let filepath = match row {
                Some(r) => r.0,
                None => return Response::Error { message: format!("Image {} not found", image_id) },
            };

            let filepath_path = std::path::Path::new(&filepath);
            if !filepath_path.exists() {
                return Response::Error { message: format!("File not found: {:?}", filepath) };
            }

            // Decode is CPU-bound — off the reactor thread.
            let (rgb_buf, width, height) = match tokio::task::block_in_place(|| curator_core::image_decode::decode_rgb(filepath_path)) {
                Ok(res) => res,
                Err(e) => return Response::Error { message: format!("Image decode failed: {:?}", e) },
            };

            let img = match core_image::ImageBuffer::<core_image::Rgb<u8>, Vec<u8>>::from_raw(width, height, rgb_buf) {
                Some(i) => i,
                None => return Response::Error { message: "Invalid image buffer".to_string() },
            };

            let ocr_clone = Arc::clone(ocr);
            let detections_res = tokio::task::spawn_blocking(move || ocr_clone.run_ocr(&img)).await;

            let (detections, bubbles) = match detections_res {
                Ok(Ok(dets)) => dets,
                Ok(Err(e)) => return Response::Error { message: format!("OCR execution failed: {:?}", e) },
                Err(e) => return Response::Error { message: format!("Task join panicked: {:?}", e) },
            };

            // Replace old detections + bubbles and insert new ones in a single transaction
            let mut tx = match db.begin().await {
                Ok(tx) => tx,
                Err(e) => return Response::Error { message: format!("Failed to begin OCR transaction: {:?}", e) },
            };

            if let Err(e) = sqlx::query("DELETE FROM image_ocr_detections WHERE image_id = ?")
                .bind(image_id)
                .execute(&mut *tx)
                .await
            {
                return Response::Error { message: format!("Failed to clear old OCR data: {:?}", e) };
            }

            for det in &detections {
                let p = &det.polygon;
                if let Err(e) = sqlx::query(
                    "INSERT INTO image_ocr_detections (image_id, text, confidence, x0, y0, x1, y1, x2, y2, x3, y3, is_from_bubble) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
                )
                .bind(image_id)
                .bind(&det.text)
                .bind(det.confidence)
                .bind(p[0][0])
                .bind(p[0][1])
                .bind(p[1][0])
                .bind(p[1][1])
                .bind(p[2][0])
                .bind(p[2][1])
                .bind(p[3][0])
                .bind(p[3][1])
                .bind(det.is_from_bubble)
                .execute(&mut *tx)
                .await
                {
                    return Response::Error { message: format!("Failed to insert OCR detection: {:?}", e) };
                }
            }

            if let Err(e) = sqlx::query("DELETE FROM image_ocr_bubble_boxes WHERE image_id = ?")
                .bind(image_id).execute(&mut *tx).await
            {
                return Response::Error { message: format!("Failed to clear old OCR bubbles: {:?}", e) };
            }
            for b in &bubbles {
                if let Err(e) = sqlx::query(
                    "INSERT INTO image_ocr_bubble_boxes (image_id, x1, y1, x2, y2, confidence) VALUES (?, ?, ?, ?, ?, ?)"
                )
                .bind(image_id)
                .bind(b.bbox[0]).bind(b.bbox[1]).bind(b.bbox[2]).bind(b.bbox[3])
                .bind(b.confidence)
                .execute(&mut *tx)
                .await
                {
                    return Response::Error { message: format!("Failed to insert OCR bubble box: {:?}", e) };
                }
            }

            if let Err(e) = tx.commit().await {
                return Response::Error { message: format!("Failed to commit OCR transaction: {:?}", e) };
            }

            let results: Vec<curator_core::ipc::OcrResult> = match sqlx::query_as(
                "SELECT id, image_id, text, confidence, x0, y0, x1, y1, x2, y2, x3, y3, is_from_bubble FROM image_ocr_detections WHERE image_id = ?"
            )
            .bind(image_id)
            .fetch_all(db)
            .await
            {
                Ok(res) => res,
                Err(e) => return Response::Error { message: format!("Failed to retrieve OCR results: {:?}", e) },
            };

            let bubble_box_results: Vec<curator_core::ipc::BubbleBoxResult> = bubbles.iter().map(|b| {
                curator_core::ipc::BubbleBoxResult {
                    x1: b.bbox[0],
                    y1: b.bbox[1],
                    x2: b.bbox[2],
                    y2: b.bbox[3],
                    confidence: b.confidence,
                }
            }).collect();

            Response::OcrDetectionsResult { image_id, detections: results, bubble_boxes: bubble_box_results }
        }

        Request::GetOcrDetections { image_id } => {
            let results: Vec<curator_core::ipc::OcrResult> = match sqlx::query_as(
                "SELECT id, image_id, text, confidence, x0, y0, x1, y1, x2, y2, x3, y3, is_from_bubble FROM image_ocr_detections WHERE image_id = ?"
            )
            .bind(image_id)
            .fetch_all(db)
            .await
            {
                Ok(res) => res,
                Err(e) => return Response::Error { message: format!("Failed to query OCR detections: {:?}", e) },
            };

            let bubble_boxes: Vec<curator_core::ipc::BubbleBoxResult> = match sqlx::query_as(
                "SELECT x1, y1, x2, y2, confidence FROM image_ocr_bubble_boxes WHERE image_id = ?"
            )
            .bind(image_id)
            .fetch_all(db)
            .await
            {
                Ok(res) => res,
                Err(_) => Vec::new(),
            };

            Response::OcrDetectionsResult { image_id, detections: results, bubble_boxes }
        }

        // ── Ephemeral Image Processing (Toolbox) ──────────────────────
        Request::EphemeralTagImage {
            path,
            threshold,
            tagger,
        } => {
            let preferred = { settings.lock().await.preferred_tagger };
            let engine = taggers.engine(&tagger.unwrap_or(preferred));
            let threshold = threshold.unwrap_or(engine.spec().default_threshold);
            let path_for_log = path.clone();
            let res = tokio::task::block_in_place(|| engine.tag_image(&path, threshold));
            match res {
                Ok(preds) => {
                    info!(
                        "EphemeralTagImage {:?}: {} predictions at threshold {}",
                        path_for_log,
                        preds.len(),
                        threshold
                    );
                    let tags: Vec<curator_core::ipc::TagSummary> = preds
                        .iter()
                        .map(|p| curator_core::ipc::TagSummary {
                            tag: p.tag.clone(),
                            category: p.category.clone(),
                            confidence: p.confidence,
                            source_name: Some(engine.spec().source_name.to_string()),
                            is_blacklisted: false,
                        })
                        .collect();
                    Response::EphemeralTagResult { path, tags }
                }
                Err(e) => Response::Error {
                    message: format!("Ephemeral tagging failed: {:?}", e),
                },
            }
        }

        Request::EphemeralRunOcr { path } => {
            let path_path = std::path::Path::new(&path);
            if !path_path.exists() {
                return Response::Error {
                    message: format!("File not found: {:?}", path),
                };
            }

            let (rgb_buf, width, height) =
                match tokio::task::block_in_place(|| curator_core::image_decode::decode_rgb(path_path))
                {
                    Ok(res) => res,
                    Err(e) => {
                        return Response::Error {
                            message: format!("Image decode failed: {:?}", e),
                        }
                    }
                };

            let img = match core_image::ImageBuffer::<core_image::Rgb<u8>, Vec<u8>>::from_raw(
                width, height, rgb_buf,
            ) {
                Some(i) => i,
                None => return Response::Error { message: "Invalid image buffer".to_string() },
            };

            let ocr_clone = Arc::clone(ocr);
            let detections_res =
                tokio::task::spawn_blocking(move || ocr_clone.run_ocr(&img)).await;

            let (detections, bubbles) = match detections_res {
                Ok(Ok(dets)) => dets,
                Ok(Err(e)) => {
                    return Response::Error {
                        message: format!("OCR execution failed: {:?}", e),
                    }
                }
                Err(e) => {
                    return Response::Error {
                        message: format!("Task join panicked: {:?}", e),
                    }
                }
            };

            let det_results: Vec<curator_core::ipc::EphemeralOcrDetection> = detections
                .iter()
                .map(|det| {
                    let p = &det.polygon;
                    curator_core::ipc::EphemeralOcrDetection {
                        text: det.text.clone(),
                        confidence: det.confidence,
                        x0: p[0][0],
                        y0: p[0][1],
                        x1: p[1][0],
                        y1: p[1][1],
                        x2: p[2][0],
                        y2: p[2][1],
                        x3: p[3][0],
                        y3: p[3][1],
                        is_from_bubble: det.is_from_bubble,
                    }
                })
                .collect();

            let bubble_results: Vec<curator_core::ipc::BubbleBoxResult> = bubbles
                .iter()
                .map(|b| curator_core::ipc::BubbleBoxResult {
                    x1: b.bbox[0],
                    y1: b.bbox[1],
                    x2: b.bbox[2],
                    y2: b.bbox[3],
                    confidence: b.confidence,
                })
                .collect();

            info!(
                "EphemeralRunOcr {:?}: {} text detections, {} bubbles",
                path,
                det_results.len(),
                bubble_results.len()
            );
            Response::EphemeralOcrResult {
                path,
                detections: det_results,
                bubble_boxes: bubble_results,
            }
        }

        Request::EphemeralDetectCharacters { path } => {
            let path_ref = std::path::Path::new(&path);
            match detection.detect_image_path(path_ref).await {
                Ok(detections) => {
                    info!(
                        "EphemeralDetectCharacters {:?}: {} detections",
                        path,
                        detections.len()
                    );
                    Response::EphemeralDetectionResult { path, detections }
                }
                Err(e) => Response::Error {
                    message: format!("Ephemeral detection failed: {:?}", e),
                },
            }
        }

        // ── Model Management ─────────────────────────────────────────
        Request::GetModelStatus => {
            models::get_model_status(&data_dir.join("models"), download_progress).await
        }
        Request::DownloadModel { model_id } => {
            models::download_model(&data_dir.join("models"), &model_id, download_progress, cancel_tokens).await
        }
        Request::CancelDownload { model_id } => {
            models::cancel_download(&model_id, download_progress, cancel_tokens).await
        }
        Request::RemoveModel { model_id } => {
            models::remove_model(&data_dir.join("models"), &model_id).await
        }
        Request::GetDownloadProgress => {
            models::get_download_progress(download_progress).await
        }
        Request::QuantizeModel { model_id, format } => {
            models::quantize_model(&data_dir.join("models"), &model_id, &format).await
        }
        Request::ConvertModel { model_id } => {
            models::convert_model(&data_dir.join("models"), &model_id).await
        }
        Request::GetConversionLogs { model_id } => {
            models::get_conversion_logs(&data_dir.join("models"), &model_id).await
        }
    }
}

