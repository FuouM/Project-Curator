pub mod common;
pub mod concepts;
pub mod image;
pub mod import;
pub mod misc;
pub mod search;
pub mod settings;
pub mod tags;

use curator_core::ipc::{EmbeddingModel, Request, Response};
use curator_core::tagger::TaggerEngine;
use curator_core::vector::{ModelManager, VectorIndex};
use sqlx::SqlitePool;
use std::path::Path;
use std::sync::Arc;
use tracing::{error, info, warn};

use crate::AppSettings;

pub(crate) type ImageRow = (
    i64,
    String,
    String,
    i64,
    String,
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
    data_dir: &Path,
    settings: &Arc<tokio::sync::Mutex<AppSettings>>,
) -> Response {
    match request {
        Request::Ping => Response::Pong,

        Request::RunBenchmark { embedding_model } => {
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
            let tagger_path = tagger.model_path();
            info!(
                "RunBenchmark request: embedding_model={:?}, vision_path={:?}, tagger_path={:?}, tagger_path_exists={}",
                embedding_model,
                vision_path,
                tagger_path,
                tagger_path.exists()
            );

            let clip_res = curator_core::run_onnx_benchmark(&vision_path, target_size);
            let tagger_res = if tagger_path.exists() {
                match curator_core::run_onnx_benchmark(tagger_path, 512) {
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
            Ok(images) => Response::ListResult { images },
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

        Request::GetSettings => {
            let s = settings.lock().await;
            Response::SettingsResult {
                clip_device: s.clip_device.clone(),
                tagger_device: s.tagger_device.clone(),
                idle_timeout_secs: s.idle_timeout_secs,
                embedding_model: s.embedding_model,
            }
        }

        Request::UpdateSettings {
            clip_device,
            tagger_device,
            idle_timeout_secs,
            embedding_model,
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
                },
            )
            .await
            {
                Ok(s) => Response::SettingsResult {
                    clip_device: s.clip_device,
                    tagger_device: s.tagger_device,
                    idle_timeout_secs: s.idle_timeout_secs,
                    embedding_model: s.embedding_model,
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
            let latest_images = latest_resp.unwrap_or_default();

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
    }
}

