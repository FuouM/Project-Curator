use crate::server::internal_status;
use crate::ClientContext;
use curator_core::filename_parser::TokenBlock;
use curator_core::grpc::common::TokenBlock as ProtoTokenBlock;
use curator_core::grpc::parser::{
    filename_parser_service_server::FilenameParserService, CompileTokenBlocksRequest,
    CompileTokenBlocksResult, PreviewBatchFilenameParsingRequest,
    PreviewBatchFilenameParsingResult, RunBatchFilenameParsingRequest,
    RunBatchFilenameParsingResult, TestFilenamePatternRequest, TestFilenamePatternResult,
};
use std::sync::Arc;
use tonic::{Request as TonicRequest, Response as TonicResponse, Status};

pub struct FilenameParserServiceImpl {
    ctx: Arc<ClientContext>,
}

impl FilenameParserServiceImpl {
    pub fn new(ctx: Arc<ClientContext>) -> Self {
        Self { ctx }
    }
}

fn to_token_blocks(proto: Vec<ProtoTokenBlock>) -> Vec<TokenBlock> {
    proto.into_iter().map(Into::into).collect()
}

#[tonic::async_trait]
impl FilenameParserService for FilenameParserServiceImpl {
    async fn test_filename_pattern(
        &self,
        request: TonicRequest<TestFilenamePatternRequest>,
    ) -> Result<TonicResponse<TestFilenamePatternResult>, Status> {
        let req = request.into_inner();
        let result = curator_core::FilenameParser::test_filename(
            &req.filename,
            &req.pattern_or_type,
            &req.rule_type,
            Some(&to_token_blocks(req.token_config)),
        );
        Ok(TonicResponse::new(TestFilenamePatternResult {
            result: result.map(Into::into),
        }))
    }

    async fn compile_token_blocks(
        &self,
        request: TonicRequest<CompileTokenBlocksRequest>,
    ) -> Result<TonicResponse<CompileTokenBlocksResult>, Status> {
        let req = request.into_inner();
        let regex = curator_core::FilenameParser::compile_token_blocks(&to_token_blocks(
            req.token_config,
        ));
        Ok(TonicResponse::new(CompileTokenBlocksResult { regex }))
    }

    async fn preview_batch_filename_parsing(
        &self,
        request: TonicRequest<PreviewBatchFilenameParsingRequest>,
    ) -> Result<TonicResponse<PreviewBatchFilenameParsingResult>, Status> {
        let req = request.into_inner();
        let items = curator_core::FilenameParser::preview_batch(
            &self.ctx.db,
            req.limit as usize,
            &req.pattern_or_type,
            &req.rule_type,
            Some(&to_token_blocks(req.token_config)),
            req.output_match_type.as_deref(),
        )
        .await
        .map_err(internal_status)?;
        Ok(TonicResponse::new(PreviewBatchFilenameParsingResult {
            items: items.into_iter().map(Into::into).collect(),
        }))
    }

    async fn run_batch_filename_parsing(
        &self,
        request: TonicRequest<RunBatchFilenameParsingRequest>,
    ) -> Result<TonicResponse<RunBatchFilenameParsingResult>, Status> {
        let req = request.into_inner();
        let res = curator_core::FilenameParser::run_batch(
            &self.ctx.db,
            &req.pattern_or_type,
            &req.rule_type,
            Some(&to_token_blocks(req.token_config)),
            req.output_match_type.as_deref(),
        )
        .await
        .map_err(internal_status)?;
        Ok(TonicResponse::new(RunBatchFilenameParsingResult {
            total_processed: res.total_processed as u32,
            matched_count: res.matched_count as u32,
            tags_created: res.tags_created as u32,
        }))
    }
}
