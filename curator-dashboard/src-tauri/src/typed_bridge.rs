use prost::Message;
use tonic::transport::Channel;

use curator_proto::grpc::benchmarks as benchmarks_pb;
use curator_proto::grpc::benchmarks::benchmarks_service_client::BenchmarksServiceClient;
use curator_proto::grpc::characters as characters_pb;
use curator_proto::grpc::characters::characters_service_client::CharactersServiceClient;
use curator_proto::grpc::concepts as concepts_pb;
use curator_proto::grpc::concepts::concepts_service_client::ConceptsServiceClient;
use curator_proto::grpc::folders as folders_pb;
use curator_proto::grpc::folders::folders_service_client::FoldersServiceClient;
use curator_proto::grpc::gallery as gallery_pb;
use curator_proto::grpc::gallery::gallery_service_client::GalleryServiceClient;
use curator_proto::grpc::import as import_pb;
use curator_proto::grpc::import::import_service_client::ImportServiceClient;
use curator_proto::grpc::models as models_pb;
use curator_proto::grpc::models::models_service_client::ModelsServiceClient;
use curator_proto::grpc::ocr as ocr_pb;
use curator_proto::grpc::ocr::ocr_service_client::OcrServiceClient;
use curator_proto::grpc::parser as parser_pb;
use curator_proto::grpc::parser::filename_parser_service_client::FilenameParserServiceClient;
use curator_proto::grpc::plugins as plugins_pb;
use curator_proto::grpc::plugins::plugins_service_client::PluginsServiceClient;
use curator_proto::grpc::search as search_pb;
use curator_proto::grpc::search::search_service_client::SearchServiceClient;
use curator_proto::grpc::system as system_pb;
use curator_proto::grpc::system::system_service_client::SystemServiceClient;
use curator_proto::grpc::tagging as tagging_pb;
use curator_proto::grpc::tagging::tagging_service_client::TaggingServiceClient;
use curator_proto::grpc::tags as tags_pb;
use curator_proto::grpc::tags::tags_service_client::TagsServiceClient;
use curator_proto::grpc::tools as tools_pb;
use curator_proto::grpc::tools::tools_service_client::ToolsServiceClient;

fn status_err(e: tonic::Status) -> String {
    format!("{}: {}", e.code(), e.message())
}

fn decode<M: Message + Default>(bytes: &[u8]) -> Result<M, String> {
    M::decode(bytes).map_err(|e| format!("request decode failed: {e}"))
}

/// Routes a typed gRPC method call over the shared Named Pipe channel.
///
/// `method` uses the `Service.Method` convention (e.g. `SystemService.GetStatus`).
/// The request is a prost-encoded protobuf message; empty request types use `()`.
/// The response is returned as prost-encoded bytes; empty response types yield `()`.
///
/// For the four server-streaming RPCs, the bridge reads the first stream item and
/// returns it, then drops the stream. The dashboard relies on unary progress-poll
/// RPCs for the remainder of each job.
#[allow(clippy::unit_arg)]
pub async fn call_typed(
    channel: Channel,
    method: &str,
    request_bytes: &[u8],
) -> Result<Vec<u8>, String> {
    match method {
        // ---- SystemService ----
        "SystemService.Ping" => {
            let mut client = SystemServiceClient::new(channel);
            let resp = client.ping(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "SystemService.GetStatus" => {
            let mut client = SystemServiceClient::new(channel);
            let resp = client.get_status(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "SystemService.GetDashboardInit" => {
            let mut client = SystemServiceClient::new(channel);
            let resp = client.get_dashboard_init(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "SystemService.GetRandomImage" => {
            let mut client = SystemServiceClient::new(channel);
            let resp = client.get_random_image(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "SystemService.GetSettings" => {
            let mut client = SystemServiceClient::new(channel);
            let resp = client.get_settings(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "SystemService.UpdateSettings" => {
            let req = decode::<system_pb::UpdateSettingsRequest>(request_bytes)?;
            let mut client = SystemServiceClient::new(channel);
            let resp = client.update_settings(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "SystemService.ReindexVectors" => {
            let mut client = SystemServiceClient::new(channel);
            let resp = client.reindex_vectors(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "SystemService.ReindexFailedVectors" => {
            let mut client = SystemServiceClient::new(channel);
            let resp = client.reindex_failed_vectors(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }

        // ---- ImportService ----
        "ImportService.ImportImage" => {
            let req = decode::<import_pb::ImportImageRequest>(request_bytes)?;
            let mut client = ImportServiceClient::new(channel);
            let resp = client.import_image(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ImportService.GetImportedFolders" => {
            let mut client = ImportServiceClient::new(channel);
            let resp = client.get_imported_folders(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ImportService.BackfillImageFolders" => {
            let mut client = ImportServiceClient::new(channel);
            let resp = client.backfill_image_folders(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ImportService.BackfillMediaMetadata" => {
            let mut client = ImportServiceClient::new(channel);
            let resp = client.backfill_media_metadata(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ImportService.RescanFolder" => {
            let req = decode::<import_pb::RescanFolderRequest>(request_bytes)?;
            let mut client = ImportServiceClient::new(channel);
            let resp = client.rescan_folder(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ImportService.IndexFolder" => {
            let req = decode::<import_pb::IndexFolderRequest>(request_bytes)?;
            let mut client = ImportServiceClient::new(channel);
            let resp = client.index_folder(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ImportService.RescanSafety" => {
            let mut client = ImportServiceClient::new(channel);
            let resp = client.rescan_safety(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ImportService.GetSafetyRescanProgress" => {
            let mut client = ImportServiceClient::new(channel);
            let resp = client.get_safety_rescan_progress(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ImportService.EphemeralClassifySafety" => {
            let req = decode::<import_pb::EphemeralClassifySafetyRequest>(request_bytes)?;
            let mut client = ImportServiceClient::new(channel);
            let resp = client
                .ephemeral_classify_safety(req)
                .await
                .map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }

        // ---- GalleryService ----
        "GalleryService.GetImage" => {
            let req = decode::<gallery_pb::GetImageRequest>(request_bytes)?;
            let mut client = GalleryServiceClient::new(channel);
            let resp = client.get_image(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "GalleryService.ListImages" => {
            let req = decode::<gallery_pb::ListImagesRequest>(request_bytes)?;
            let mut client = GalleryServiceClient::new(channel);
            let resp = client.list_images(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "GalleryService.SetFavorite" => {
            let req = decode::<gallery_pb::SetFavoriteRequest>(request_bytes)?;
            let mut client = GalleryServiceClient::new(channel);
            let resp = client.set_favorite(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "GalleryService.SetNote" => {
            let req = decode::<gallery_pb::SetNoteRequest>(request_bytes)?;
            let mut client = GalleryServiceClient::new(channel);
            let resp = client.set_note(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "GalleryService.GetThumbnail" => {
            let req = decode::<gallery_pb::GetThumbnailRequest>(request_bytes)?;
            let mut client = GalleryServiceClient::new(channel);
            let resp = client.get_thumbnail(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "GalleryService.PurgeMissingThumbnails" => {
            let mut client = GalleryServiceClient::new(channel);
            let resp = client.purge_missing_thumbnails(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "GalleryService.ClearThumbnailCache" => {
            let mut client = GalleryServiceClient::new(channel);
            let resp = client.clear_thumbnail_cache(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }

        // ---- SearchService ----
        "SearchService.Search" => {
            let req = decode::<search_pb::SearchRequest>(request_bytes)?;
            let mut client = SearchServiceClient::new(channel);
            let resp = client.search(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "SearchService.GetCharacterSuggestions" => {
            let req = decode::<search_pb::GetCharacterSuggestionsRequest>(request_bytes)?;
            let mut client = SearchServiceClient::new(channel);
            let resp = client.get_character_suggestions(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }

        // ---- TagsService ----
        "TagsService.AddTag" => {
            let req = decode::<tags_pb::AddTagRequest>(request_bytes)?;
            let mut client = TagsServiceClient::new(channel);
            let resp = client.add_tag(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "TagsService.RemoveTag" => {
            let req = decode::<tags_pb::RemoveTagRequest>(request_bytes)?;
            let mut client = TagsServiceClient::new(channel);
            let resp = client.remove_tag(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "TagsService.UnblacklistTag" => {
            let req = decode::<tags_pb::UnblacklistTagRequest>(request_bytes)?;
            let mut client = TagsServiceClient::new(channel);
            let resp = client.unblacklist_tag(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "TagsService.GetTagStatistics" => {
            let mut client = TagsServiceClient::new(channel);
            let resp = client.get_tag_statistics(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "TagsService.BackfillTagSource" => {
            let req = decode::<tags_pb::BackfillTagSourceRequest>(request_bytes)?;
            let mut client = TagsServiceClient::new(channel);
            let resp = client.backfill_tag_source(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }

        // ---- TaggingService ----
        "TaggingService.TagImage" => {
            let req = decode::<tagging_pb::TagImageRequest>(request_bytes)?;
            let mut client = TaggingServiceClient::new(channel);
            let resp = client.tag_image(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "TaggingService.TagImageBatch" => {
            let req = decode::<tagging_pb::TagImageBatchRequest>(request_bytes)?;
            let mut client = TaggingServiceClient::new(channel);
            let resp = client.tag_image_batch(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "TaggingService.GetTaggerStatus" => {
            let mut client = TaggingServiceClient::new(channel);
            let resp = client.get_tagger_status(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "TaggingService.EphemeralTagImage" => {
            let req = decode::<tagging_pb::EphemeralTagImageRequest>(request_bytes)?;
            let mut client = TaggingServiceClient::new(channel);
            let resp = client.ephemeral_tag_image(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }

        // ---- CharactersService ----
        "CharactersService.DetectCharacters" => {
            let req = decode::<characters_pb::ImageIdRequest>(request_bytes)?;
            let mut client = CharactersServiceClient::new(channel);
            let resp = client.detect_characters(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "CharactersService.DetectCharactersBatch" => {
            let req = decode::<characters_pb::ImageIdsRequest>(request_bytes)?;
            let mut client = CharactersServiceClient::new(channel);
            let resp = client.detect_characters_batch(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "CharactersService.GetCharacterDetections" => {
            let req = decode::<characters_pb::ImageIdRequest>(request_bytes)?;
            let mut client = CharactersServiceClient::new(channel);
            let resp = client.get_character_detections(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "CharactersService.GetCharacterDetectionsBatch" => {
            let req = decode::<characters_pb::ImageIdsRequest>(request_bytes)?;
            let mut client = CharactersServiceClient::new(channel);
            let resp = client.get_character_detections_batch(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "CharactersService.GetDetectionCrop" => {
            let req = decode::<characters_pb::GetDetectionCropRequest>(request_bytes)?;
            let mut client = CharactersServiceClient::new(channel);
            let resp = client.get_detection_crop(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "CharactersService.GetDetectionCrops" => {
            let req = decode::<characters_pb::GetDetectionCropsRequest>(request_bytes)?;
            let mut client = CharactersServiceClient::new(channel);
            let resp = client.get_detection_crops(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "CharactersService.AssignCharacterIdentity" => {
            let req = decode::<characters_pb::AssignCharacterIdentityRequest>(request_bytes)?;
            let mut client = CharactersServiceClient::new(channel);
            let resp = client.assign_character_identity(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "CharactersService.CreateCharacterIdentity" => {
            let req = decode::<characters_pb::CreateCharacterIdentityRequest>(request_bytes)?;
            let mut client = CharactersServiceClient::new(channel);
            let resp = client.create_character_identity(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "CharactersService.RenameCharacterIdentity" => {
            let req = decode::<characters_pb::RenameCharacterIdentityRequest>(request_bytes)?;
            let mut client = CharactersServiceClient::new(channel);
            let resp = client.rename_character_identity(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "CharactersService.DeleteCharacterIdentity" => {
            let req = decode::<characters_pb::DeleteCharacterIdentityRequest>(request_bytes)?;
            let mut client = CharactersServiceClient::new(channel);
            let resp = client.delete_character_identity(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "CharactersService.ListCharacterIdentities" => {
            let mut client = CharactersServiceClient::new(channel);
            let resp = client.list_character_identities(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "CharactersService.ReidentifyAllDetections" => {
            let mut client = CharactersServiceClient::new(channel);
            let resp = client.reidentify_all_detections(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "CharactersService.SearchByCharacter" => {
            let req = decode::<characters_pb::SearchByCharacterRequest>(request_bytes)?;
            let mut client = CharactersServiceClient::new(channel);
            let resp = client.search_by_character(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "CharactersService.SearchByCharacterBatch" => {
            let req = decode::<characters_pb::SearchByCharacterBatchRequest>(request_bytes)?;
            let mut client = CharactersServiceClient::new(channel);
            let resp = client.search_by_character_batch(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "CharactersService.ListUnassignedDetections" => {
            let mut client = CharactersServiceClient::new(channel);
            let resp = client.list_unassigned_detections(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "CharactersService.DeleteDetection" => {
            let req = decode::<characters_pb::DeleteDetectionRequest>(request_bytes)?;
            let mut client = CharactersServiceClient::new(channel);
            let resp = client.delete_detection(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "CharactersService.UpdateDetectionBoundingBox" => {
            let req = decode::<characters_pb::UpdateDetectionBoundingBoxRequest>(request_bytes)?;
            let mut client = CharactersServiceClient::new(channel);
            let resp = client.update_detection_bounding_box(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "CharactersService.AddDetection" => {
            let req = decode::<characters_pb::AddDetectionRequest>(request_bytes)?;
            let mut client = CharactersServiceClient::new(channel);
            let resp = client.add_detection(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "CharactersService.IdentifyDetection" => {
            let req = decode::<characters_pb::IdentifyDetectionRequest>(request_bytes)?;
            let mut client = CharactersServiceClient::new(channel);
            let resp = client.identify_detection(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "CharactersService.EphemeralDetectCharacters" => {
            let req = decode::<characters_pb::EphemeralDetectCharactersRequest>(request_bytes)?;
            let mut client = CharactersServiceClient::new(channel);
            let resp = client.ephemeral_detect_characters(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "CharactersService.ClearCropCache" => {
            let mut client = CharactersServiceClient::new(channel);
            let resp = client.clear_crop_cache(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }

        // ---- OcrService ----
        "OcrService.RunOcr" => {
            let req = decode::<ocr_pb::ImageIdRequest>(request_bytes)?;
            let mut client = OcrServiceClient::new(channel);
            let resp = client.run_ocr(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "OcrService.GetOcrDetections" => {
            let req = decode::<ocr_pb::ImageIdRequest>(request_bytes)?;
            let mut client = OcrServiceClient::new(channel);
            let resp = client.get_ocr_detections(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "OcrService.EphemeralRunOcr" => {
            let req = decode::<ocr_pb::EphemeralRunOcrRequest>(request_bytes)?;
            let mut client = OcrServiceClient::new(channel);
            let resp = client.ephemeral_run_ocr(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }

        // ---- ConceptsService ----
        "ConceptsService.CreateConcept" => {
            let req = decode::<concepts_pb::CreateConceptRequest>(request_bytes)?;
            let mut client = ConceptsServiceClient::new(channel);
            let resp = client.create_concept(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ConceptsService.ListConcepts" => {
            let mut client = ConceptsServiceClient::new(channel);
            let resp = client.list_concepts(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ConceptsService.UpdateConcept" => {
            let req = decode::<concepts_pb::UpdateConceptRequest>(request_bytes)?;
            let mut client = ConceptsServiceClient::new(channel);
            let resp = client.update_concept(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ConceptsService.DeleteConcept" => {
            let req = decode::<concepts_pb::DeleteConceptRequest>(request_bytes)?;
            let mut client = ConceptsServiceClient::new(channel);
            let resp = client.delete_concept(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ConceptsService.AddConceptSamples" => {
            let req = decode::<concepts_pb::AddConceptSamplesRequest>(request_bytes)?;
            let mut client = ConceptsServiceClient::new(channel);
            let resp = client.add_concept_samples(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ConceptsService.RemoveConceptSample" => {
            let req = decode::<concepts_pb::RemoveConceptSampleRequest>(request_bytes)?;
            let mut client = ConceptsServiceClient::new(channel);
            let resp = client.remove_concept_sample(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ConceptsService.RescanConcept" => {
            let req = decode::<concepts_pb::RescanConceptRequest>(request_bytes)?;
            let mut client = ConceptsServiceClient::new(channel);
            let resp = client.rescan_concept(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ConceptsService.GetConceptSamples" => {
            let req = decode::<concepts_pb::RescanConceptRequest>(request_bytes)?;
            let mut client = ConceptsServiceClient::new(channel);
            let resp = client.get_concept_samples(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ConceptsService.CleanAutoConceptTags" => {
            let req = decode::<concepts_pb::CleanAutoConceptTagsRequest>(request_bytes)?;
            let mut client = ConceptsServiceClient::new(channel);
            let resp = client.clean_auto_concept_tags(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }

        // ---- ModelsService ----
        "ModelsService.GetModelStatus" => {
            let mut client = ModelsServiceClient::new(channel);
            let resp = client.get_model_status(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ModelsService.CancelDownload" => {
            let req = decode::<models_pb::ModelIdRequest>(request_bytes)?;
            let mut client = ModelsServiceClient::new(channel);
            let resp = client.cancel_download(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ModelsService.RemoveModel" => {
            let req = decode::<models_pb::ModelIdRequest>(request_bytes)?;
            let mut client = ModelsServiceClient::new(channel);
            let resp = client.remove_model(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ModelsService.GetDownloadProgress" => {
            let mut client = ModelsServiceClient::new(channel);
            let resp = client.get_download_progress(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ModelsService.QuantizeModel" => {
            let req = decode::<models_pb::QuantizeModelRequest>(request_bytes)?;
            let mut client = ModelsServiceClient::new(channel);
            let resp = client.quantize_model(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ModelsService.GetConversionLogs" => {
            let req = decode::<models_pb::ModelIdRequest>(request_bytes)?;
            let mut client = ModelsServiceClient::new(channel);
            let resp = client.get_conversion_logs(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ModelsService.GetFFmpegStatus" => {
            let mut client = ModelsServiceClient::new(channel);
            let resp = client.get_f_fmpeg_status(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ModelsService.SetFFmpegPath" => {
            let req = decode::<models_pb::SetFFmpegPathRequest>(request_bytes)?;
            let mut client = ModelsServiceClient::new(channel);
            let resp = client.set_f_fmpeg_path(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ModelsService.GetMediaMetadata" => {
            let req = decode::<models_pb::GetMediaMetadataRequest>(request_bytes)?;
            let mut client = ModelsServiceClient::new(channel);
            let resp = client.get_media_metadata(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }

        // ---- ToolsService ----
        "ToolsService.EphemeralConvertImages" => {
            let req = decode::<tools_pb::EphemeralConvertImagesRequest>(request_bytes)?;
            let mut client = ToolsServiceClient::new(channel);
            let resp = client.ephemeral_convert_images(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ToolsService.PathExists" => {
            let req = decode::<tools_pb::PathExistsRequest>(request_bytes)?;
            let mut client = ToolsServiceClient::new(channel);
            let resp = client.path_exists(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ToolsService.TranscodeVideo" => {
            let req = decode::<tools_pb::TranscodeVideoRequest>(request_bytes)?;
            let mut client = ToolsServiceClient::new(channel);
            let resp = client.transcode_video(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ToolsService.GetTranscodeProgress" => {
            let req = decode::<tools_pb::GetTranscodeProgressRequest>(request_bytes)?;
            let mut client = ToolsServiceClient::new(channel);
            let resp = client.get_transcode_progress(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ToolsService.CreateGifFromImages" => {
            let req = decode::<tools_pb::CreateGifFromImagesRequest>(request_bytes)?;
            let mut client = ToolsServiceClient::new(channel);
            let resp = client.create_gif_from_images(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ToolsService.ProcessGifEffects" => {
            let req = decode::<tools_pb::ProcessGifEffectsRequest>(request_bytes)?;
            let mut client = ToolsServiceClient::new(channel);
            let resp = client.process_gif_effects(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ToolsService.SplitGif" => {
            let req = decode::<tools_pb::SplitGifRequest>(request_bytes)?;
            let mut client = ToolsServiceClient::new(channel);
            let resp = client.split_gif(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ToolsService.GetBenchmarkImages" => {
            let req = decode::<tools_pb::GetBenchmarkImagesRequest>(request_bytes)?;
            let mut client = ToolsServiceClient::new(channel);
            let resp = client.get_benchmark_images(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ToolsService.BenchmarkSingleImage" => {
            let req = decode::<tools_pb::BenchmarkSingleImageRequest>(request_bytes)?;
            let mut client = ToolsServiceClient::new(channel);
            let resp = client.benchmark_single_image(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "ToolsService.GetImageProcessingBenchmarkProgress" => {
            let mut client = ToolsServiceClient::new(channel);
            let resp = client
                .get_image_processing_benchmark_progress(())
                .await
                .map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }

        // ---- FoldersService ----
        "FoldersService.GetStorageStats" => {
            let mut client = FoldersServiceClient::new(channel);
            let resp = client.get_storage_stats(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "FoldersService.UpdateFolderPath" => {
            let req = decode::<folders_pb::UpdateFolderPathRequest>(request_bytes)?;
            let mut client = FoldersServiceClient::new(channel);
            let resp = client.update_folder_path(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "FoldersService.DeleteFolder" => {
            let req = decode::<folders_pb::DeleteFolderRequest>(request_bytes)?;
            let mut client = FoldersServiceClient::new(channel);
            let resp = client.delete_folder(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "FoldersService.DetectDuplicateFolders" => {
            let mut client = FoldersServiceClient::new(channel);
            let resp = client.detect_duplicate_folders(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "FoldersService.MergeFolders" => {
            let req = decode::<folders_pb::MergeFoldersRequest>(request_bytes)?;
            let mut client = FoldersServiceClient::new(channel);
            let resp = client.merge_folders(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }

        // ---- BenchmarksService ----
        "BenchmarksService.RunBenchmark" => {
            let req = decode::<benchmarks_pb::RunBenchmarkRequest>(request_bytes)?;
            let mut client = BenchmarksServiceClient::new(channel);
            let resp = client.run_benchmark(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "BenchmarksService.RunTaggerBenchmark" => {
            let req = decode::<benchmarks_pb::RunTaggerBenchmarkRequest>(request_bytes)?;
            let mut client = BenchmarksServiceClient::new(channel);
            let resp = client.run_tagger_benchmark(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "BenchmarksService.BenchmarkPreprocess" => {
            let req = decode::<benchmarks_pb::BenchmarkPreprocessRequest>(request_bytes)?;
            let mut client = BenchmarksServiceClient::new(channel);
            let resp = client.benchmark_preprocess(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "BenchmarksService.RunYoloBenchmark" => {
            let mut client = BenchmarksServiceClient::new(channel);
            let resp = client.run_yolo_benchmark(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "BenchmarksService.RunCcipFeatBenchmark" => {
            let mut client = BenchmarksServiceClient::new(channel);
            let resp = client.run_ccip_feat_benchmark(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "BenchmarksService.RunCcipMetricsBenchmark" => {
            let mut client = BenchmarksServiceClient::new(channel);
            let resp = client.run_ccip_metrics_benchmark(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "BenchmarksService.RunOcrDetBenchmark" => {
            let mut client = BenchmarksServiceClient::new(channel);
            let resp = client.run_ocr_det_benchmark(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "BenchmarksService.RunOcrRecBenchmark" => {
            let mut client = BenchmarksServiceClient::new(channel);
            let resp = client.run_ocr_rec_benchmark(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "BenchmarksService.RunOcrClsBenchmark" => {
            let mut client = BenchmarksServiceClient::new(channel);
            let resp = client.run_ocr_cls_benchmark(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "BenchmarksService.RunMangaBubbleBenchmark" => {
            let mut client = BenchmarksServiceClient::new(channel);
            let resp = client.run_manga_bubble_benchmark(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "BenchmarksService.RunSafetyBenchmark" => {
            let mut client = BenchmarksServiceClient::new(channel);
            let resp = client.run_safety_benchmark(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }

        // ---- PluginsService ----
        "PluginsService.ValidatePlugin" => {
            let req = decode::<plugins_pb::ValidatePluginRequest>(request_bytes)?;
            let mut client = PluginsServiceClient::new(channel);
            let resp = client.validate_plugin(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "PluginsService.ListPlugins" => {
            let mut client = PluginsServiceClient::new(channel);
            let resp = client.list_plugins(()).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "PluginsService.SetPluginEnabled" => {
            let req = decode::<plugins_pb::SetPluginEnabledRequest>(request_bytes)?;
            let mut client = PluginsServiceClient::new(channel);
            let resp = client.set_plugin_enabled(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "PluginsService.ReadPluginFile" => {
            let req = decode::<plugins_pb::ReadPluginFileRequest>(request_bytes)?;
            let mut client = PluginsServiceClient::new(channel);
            let resp = client.read_plugin_file(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "PluginsService.InvokePlugin" => {
            let req = decode::<plugins_pb::InvokePluginRequest>(request_bytes)?;
            let mut client = PluginsServiceClient::new(channel);
            let resp = client.invoke_plugin(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }

        // ---- FilenameParserService ----
        "FilenameParserService.TestFilenamePattern" => {
            let req = decode::<parser_pb::TestFilenamePatternRequest>(request_bytes)?;
            let mut client = FilenameParserServiceClient::new(channel);
            let resp = client.test_filename_pattern(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "FilenameParserService.CompileTokenBlocks" => {
            let req = decode::<parser_pb::CompileTokenBlocksRequest>(request_bytes)?;
            let mut client = FilenameParserServiceClient::new(channel);
            let resp = client.compile_token_blocks(req).await.map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "FilenameParserService.PreviewBatchFilenameParsing" => {
            let req = decode::<parser_pb::PreviewBatchFilenameParsingRequest>(request_bytes)?;
            let mut client = FilenameParserServiceClient::new(channel);
            let resp = client
                .preview_batch_filename_parsing(req)
                .await
                .map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }
        "FilenameParserService.RunBatchFilenameParsing" => {
            let req = decode::<parser_pb::RunBatchFilenameParsingRequest>(request_bytes)?;
            let mut client = FilenameParserServiceClient::new(channel);
            let resp = client
                .run_batch_filename_parsing(req)
                .await
                .map_err(status_err)?;
            Ok(resp.into_inner().encode_to_vec())
        }

        // ---- Streaming RPCs (bridge reads first item only; dashboard polls unary progress) ----
        "ModelsService.DownloadModel" => {
            let req = decode::<models_pb::ModelIdRequest>(request_bytes)?;
            let mut client = ModelsServiceClient::new(channel);
            let mut stream = client.download_model(req).await.map_err(status_err)?.into_inner();
            match stream.message().await.map_err(status_err)? {
                Some(msg) => Ok(msg.encode_to_vec()),
                None => Err("download stream closed before first update".to_string()),
            }
        }
        "ModelsService.ConvertModel" => {
            let req = decode::<models_pb::ModelIdRequest>(request_bytes)?;
            let mut client = ModelsServiceClient::new(channel);
            let mut stream = client.convert_model(req).await.map_err(status_err)?.into_inner();
            match stream.message().await.map_err(status_err)? {
                Some(msg) => Ok(msg.encode_to_vec()),
                None => Err("conversion stream closed before first update".to_string()),
            }
        }
        "ModelsService.DownloadFFmpeg" => {
            let mut client = ModelsServiceClient::new(channel);
            let mut stream = client.download_f_fmpeg(()).await.map_err(status_err)?.into_inner();
            match stream.message().await.map_err(status_err)? {
                Some(msg) => Ok(msg.encode_to_vec()),
                None => Err("ffmpeg download stream closed before first update".to_string()),
            }
        }
        "ToolsService.RunImageProcessingBenchmark" => {
            let req = decode::<tools_pb::RunImageProcessingBenchmarkRequest>(request_bytes)?;
            let mut client = ToolsServiceClient::new(channel);
            let mut stream = client
                .run_image_processing_benchmark(req)
                .await
                .map_err(status_err)?
                .into_inner();
            match stream.message().await.map_err(status_err)? {
                Some(msg) => Ok(msg.encode_to_vec()),
                None => Err("benchmark stream closed before first update".to_string()),
            }
        }

        other => Err(format!("unknown typed method: {other}")),
    }
}
