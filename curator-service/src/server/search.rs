use crate::handlers;
use crate::server::internal_status;
use crate::ClientContext;
use curator_core::grpc::common as commonpb;
use curator_core::grpc::search::{
    search_service_server::SearchService, GetCharacterSuggestionsRequest, SearchRequest,
    SearchResult,
};
use std::sync::Arc;
use tonic::{Request as TonicRequest, Response as TonicResponse, Status};

pub struct SearchServiceImpl {
    ctx: Arc<ClientContext>,
}

impl SearchServiceImpl {
    pub fn new(ctx: Arc<ClientContext>) -> Self {
        Self { ctx }
    }
}

#[tonic::async_trait]
impl SearchService for SearchServiceImpl {
    async fn search(
        &self,
        request: TonicRequest<SearchRequest>,
    ) -> Result<TonicResponse<SearchResult>, Status> {
        let req = request.into_inner();
        let preferred_source = super::preferred_source(&self.ctx).await;
        let ffmpeg = handlers::resolve_ffmpeg_path(&self.ctx.data_dir, &self.ctx.settings)
            .await
            .ok();
        let matches = handlers::search::search_logic(
            handlers::search::SearchParams {
                query_text: req.query_text,
                query_image_path: req.query_image_path,
                tag_filter: req.tag_filter,
                filename_filter: req.filename_filter,
                parse_filter: req.parse_filter,
                parse_type: req.parse_type,
                concept_id: req.concept_id,
                character_identity_id: req.character_identity_id,
                ocr_filter: req.ocr_filter,
                ocr_text_search: req.ocr_text_search,
                media_type: req.media_type,
                limit: req.limit as usize,
            },
            &preferred_source,
            &self.ctx.db,
            &self.ctx.model_manager,
            &self.ctx.vector_index,
            &self.ctx.data_dir,
            ffmpeg,
        )
        .await
        .map_err(internal_status)?;
        Ok(TonicResponse::new(SearchResult {
            matches: matches.into_iter().map(Into::into).collect(),
        }))
    }

    async fn get_character_suggestions(
        &self,
        request: TonicRequest<GetCharacterSuggestionsRequest>,
    ) -> Result<TonicResponse<commonpb::TagStatisticsResult>, Status> {
        let req = request.into_inner();
        let tags = handlers::tags::get_character_suggestions_logic(&self.ctx.db, req.query.as_deref())
            .await
            .map_err(|e| internal_status(format!("Failed to fetch character suggestions: {:?}", e)))?;
        Ok(TonicResponse::new(commonpb::TagStatisticsResult {
            tags: tags.into_iter().map(Into::into).collect(),
        }))
    }
}
