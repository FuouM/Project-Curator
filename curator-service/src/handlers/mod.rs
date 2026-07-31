pub mod common;
pub mod concepts;
pub mod image;
pub mod import;
pub mod misc;
pub mod search;
pub mod settings;
pub mod tags;

use curator_core::detection::DetectionPipeline;
use curator_core::ipc::{EmbeddingModel, Request, Response};
use curator_core::tagger::TaggerEngine;
use curator_core::thumbnail::ThumbnailCache;
use curator_core::vector::{ModelManager, VectorIndex};
use sqlx::SqlitePool;
use std::path::Path;
use std::sync::Arc;
use tracing::{error, info, warn};
use curator_core::image as core_image;

use crate::AppSettings;

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

pub async fn handle_request(
    request: Request,
    db: &SqlitePool,
    model_manager: &ModelManager,
    vector_index: &VectorIndex,
    tagger: &Arc<TaggerEngine>,
    detection: &Arc<DetectionPipeline>,
    ocr: &Arc<curator_core::OcrDetector>,
    data_dir: &Path,
    settings: &Arc<tokio::sync::Mutex<AppSettings>>,
    thumbnail_cache: &ThumbnailCache,
) -> Response {
    match request {
        Request::Ping => Response::Pong,

        Request::RunBenchmark { embedding_model, run_tagger } => {
            let vision_path = match embedding_model {
                EmbeddingModel::ClipVitB32 => model_manager.model_dir().join("vision_model.onnx"),
                EmbeddingModel::MobileClipS2 => model_manager
                    .model_dir()
                    .join("mobileclip_s2/onnx/vision_model.onnx"),
            };
            let target_size = match embedding_model {
                EmbeddingModel::ClipVitB32 => 224,
                EmbeddingModel::MobileClipS2 => 256,
            };
            let run_tagger_val = run_tagger.unwrap_or(true);
            let tagger_path = tagger.model_path();
            info!(
                "RunBenchmark request: embedding_model={:?}, vision_path={:?}, run_tagger={}, tagger_path={:?}, tagger_path_exists={}",
                embedding_model,
                vision_path,
                run_tagger_val,
                tagger_path,
                tagger_path.exists()
            );

            let clip_res = curator_core::run_onnx_benchmark(&vision_path, target_size);
            let tagger_res = if run_tagger_val && tagger_path.exists() {
                match curator_core::run_onnx_benchmark(tagger_path, 512) {
                    Ok((cpu, gpu, err, _)) => (Some(cpu), gpu, err),
                    Err(e) => (
                        None,
                        None,
                        Some(format!("Tagger benchmark failed: {:?}", e)),
                    ),
                }
            } else {
                (None, None, None)
            };

            match clip_res {
                Ok((clip_cpu, clip_gpu, clip_err, has_gpu)) => Response::BenchmarkResult {
                    clip_cpu_time_ms: clip_cpu,
                    clip_gpu_time_ms: clip_gpu,
                    clip_gpu_error: clip_err,
                    tagger_cpu_time_ms: tagger_res.0,
                    tagger_gpu_time_ms: tagger_res.1,
                    tagger_gpu_error: tagger_res.2,
                    has_gpu,
                },
                Err(e) => Response::Error {
                    message: format!("CLIP model benchmark failed: {:?}", e),
                },
            }
        }

        Request::RunTaggerBenchmark => {
            let tagger_path = tagger.model_path();
            let tagger_res = if tagger_path.exists() {
                match curator_core::run_onnx_benchmark(tagger_path, 512) {
                    Ok((cpu, gpu, err, has_gpu)) => (Some(cpu), gpu, err, has_gpu),
                    Err(e) => (
                        None,
                        None,
                        Some(format!("Tagger benchmark failed: {:?}", e)),
                        false,
                    ),
                }
            } else {
                (None, None, Some("Tagger model file not found.".to_string()), false)
            };
            Response::BenchmarkResult {
                clip_cpu_time_ms: 0.0,
                clip_gpu_time_ms: None,
                clip_gpu_error: None,
                tagger_cpu_time_ms: tagger_res.0,
                tagger_gpu_time_ms: tagger_res.1,
                tagger_gpu_error: tagger_res.2,
                has_gpu: tagger_res.3,
            }
        }

        Request::BenchmarkPreprocess { image_path } => {
            let path = std::path::Path::new(&image_path);
            match curator_core::benchmark_preprocess(path, 512, 3) {
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
                    limit,
                },
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
        } => match image::list_images_logic(limit, offset, only_favorites, db).await {
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

        Request::GetImage { image_id } => match image::get_image_logic(image_id, db).await {
            Ok(image) => Response::ImageResult { image },
            Err(e) => Response::Error {
                message: e.to_string(),
            },
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

        Request::GetTaggerStatus => {
            let status = tagger.status();
            Response::TaggerStatusResult {
                loaded: status.loaded,
                model_path: status.model_path,
                total_tags: status.total_tags,
            }
        }

        Request::TagImage {
            image_id,
            threshold,
            force,
        } => {
            let threshold = threshold.unwrap_or(0.5);
            let force = force.unwrap_or(false);
            match image::tag_image_logic(image_id, threshold, force, db, tagger).await {
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
        } => {
            let threshold = threshold.unwrap_or(0.5);
            let force = force.unwrap_or(false);
            let mut processed = 0usize;
            let mut failed = 0usize;
            let mut skipped = 0usize;

            for image_id in image_ids {
                match image::tag_image_logic(image_id, threshold, force, db, tagger).await {
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
                idle_timeout_secs: s.idle_timeout_secs,
                embedding_model: s.embedding_model,
                detection_device: s.detection_device.clone(),
                detection_metrics_device: s.detection_metrics_device.clone(),
                ocr_device: s.ocr_device.clone(),
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
            idle_timeout_secs,
            embedding_model,
            detection_device,
            detection_metrics_device,
            ocr_device,
        } => {
            match settings::update_settings_logic(
                settings::UpdateSettingsParams {
                    db,
                    model_manager,
                    vector_index,
                    tagger,
                    data_dir,
                    settings,
                    clip_device,
                    tagger_device,
                    idle_timeout_secs,
                    embedding_model,
                    detection_device,
                    detection_metrics_device,
                    ocr_device,
                },
            )
            .await
            {
                Ok(s) => Response::SettingsResult {
                    clip_device: s.clip_device,
                    tagger_device: s.tagger_device,
                    idle_timeout_secs: s.idle_timeout_secs,
                    embedding_model: s.embedding_model,
                    detection_device: s.detection_device,
                    detection_metrics_device: s.detection_metrics_device,
                    ocr_device: s.ocr_device,
                },
                Err(e) => Response::Error {
                    message: e.to_string(),
                },
            }
        }

        Request::GetTagStatistics => {
            match tags::get_tag_statistics_logic(db).await {
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

            let tagger_status = tagger.status();
            let settings_val = settings_result;

            let (featured_result, latest_resp) = tokio::join!(
                image::get_featured_image(db, data_dir),
                image::list_images_logic(8, 0, None, db),
            );

            let featured_images = featured_result.into_iter().collect();
            let latest_images = latest_resp.map(|(imgs, _)| imgs).unwrap_or_default();

            Response::DashboardInitResult {
                image_count,
                vector_count,
                pending_jobs,
                preprocessing_jobs,
                tagger_loaded: tagger_status.loaded,
                tagger_model_path: tagger_status.model_path,
                tagger_total_tags: tagger_status.total_tags,
                clip_device: settings_val.clip_device,
                tagger_device: settings_val.tagger_device,
                idle_timeout_secs: settings_val.idle_timeout_secs,
                embedding_model: settings_val.embedding_model,
                detection_device: settings_val.detection_device,
                detection_metrics_device: settings_val.detection_metrics_device,
                ocr_device: settings_val.ocr_device,
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
            match concepts::get_concept_samples_logic(db, concept_id).await {
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
            let yolo_path = det_dir.join("person_detect_v1.1_s/model.onnx");
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
                    has_gpu,
                },
                Err(e) => Response::Error {
                    message: format!("Yolo benchmark failed: {:?}", e),
                },
            }
        }

        Request::RunCcipFeatBenchmark => {
            let det_dir = data_dir.join("models");
            let ccip_feat_path = det_dir.join("ccip-caformer-24-randaug-pruned/model_feat.onnx");
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
                    has_gpu,
                },
                Err(e) => Response::Error {
                    message: format!("CCIP Feature benchmark failed: {:?}", e),
                },
            }
        }

        Request::RunCcipMetricsBenchmark => {
            let det_dir = data_dir.join("models");
            let ccip_metrics_path = det_dir.join("ccip-caformer-24-randaug-pruned/model_metrics.onnx");
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
                    has_gpu,
                },
                Err(e) => Response::Error {
                    message: format!("CCIP Metrics benchmark failed: {:?}", e),
                },
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
            match curator_core::run_single_image_benchmark(model_manager, &filepath).await {
                Ok(res) => Response::SingleImageBenchmarkResult {
                    decode_time_ms: res.decode_time_ms,
                    thumbnail_time_ms: res.thumbnail_time_ms,
                    clip_preprocess_time_ms: res.clip_preprocess_time_ms,
                    tagger_preprocess_time_ms: res.tagger_preprocess_time_ms,
                    yolo_preprocess_time_ms: res.yolo_preprocess_time_ms,
                    ccip_extract_preprocess_time_ms: res.ccip_extract_preprocess_time_ms,
                },
                Err(e) => Response::Error {
                    message: format!("Failed to benchmark image {:?}: {:?}", filepath, e),
                },
            }
        }

        Request::GetRandomImage => match image::get_random_image_logic(db).await {
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

            let (rgb_buf, width, height) = match curator_core::image_decode::decode_rgb(filepath_path) {
                Ok(res) => res,
                Err(e) => return Response::Error { message: format!("Image decode failed: {:?}", e) },
            };

            let img = match core_image::ImageBuffer::<core_image::Rgb<u8>, Vec<u8>>::from_raw(width, height, rgb_buf) {
                Some(i) => i,
                None => return Response::Error { message: "Invalid image buffer".to_string() },
            };

            let ocr_clone = Arc::clone(ocr);
            let detections_res = tokio::task::spawn_blocking(move || ocr_clone.run_ocr(&img)).await;

            let detections = match detections_res {
                Ok(Ok(dets)) => dets,
                Ok(Err(e)) => return Response::Error { message: format!("OCR execution failed: {:?}", e) },
                Err(e) => return Response::Error { message: format!("Task join panicked: {:?}", e) },
            };

            // Save detections to DB
            if let Err(e) = sqlx::query("DELETE FROM image_ocr_detections WHERE image_id = ?")
                .bind(image_id)
                .execute(db)
                .await
            {
                return Response::Error { message: format!("Failed to clear old OCR data: {:?}", e) };
            }

            for det in &detections {
                let p = &det.polygon;
                if let Err(e) = sqlx::query(
                    "INSERT INTO image_ocr_detections (image_id, text, confidence, x0, y0, x1, y1, x2, y2, x3, y3) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
                .execute(db)
                .await
                {
                    return Response::Error { message: format!("Failed to insert OCR detection: {:?}", e) };
                }
            }

            let results: Vec<curator_core::ipc::OcrResult> = match sqlx::query_as(
                "SELECT id, image_id, text, confidence, x0, y0, x1, y1, x2, y2, x3, y3 FROM image_ocr_detections WHERE image_id = ?"
            )
            .bind(image_id)
            .fetch_all(db)
            .await
            {
                Ok(res) => res,
                Err(e) => return Response::Error { message: format!("Failed to retrieve OCR results: {:?}", e) },
            };

            Response::OcrDetectionsResult { image_id, detections: results }
        }

        Request::GetOcrDetections { image_id } => {
            let results: Vec<curator_core::ipc::OcrResult> = match sqlx::query_as(
                "SELECT id, image_id, text, confidence, x0, y0, x1, y1, x2, y2, x3, y3 FROM image_ocr_detections WHERE image_id = ?"
            )
            .bind(image_id)
            .fetch_all(db)
            .await
            {
                Ok(res) => res,
                Err(e) => return Response::Error { message: format!("Failed to query OCR detections: {:?}", e) },
            };

            Response::OcrDetectionsResult { image_id, detections: results }
        }
    }
}

