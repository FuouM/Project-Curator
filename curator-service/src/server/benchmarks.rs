use crate::ClientContext;
use crate::handlers;
use crate::server::internal_status;
use curator_core::grpc::benchmarks::{
    BenchmarkPreprocessRequest, BenchmarkResult, DetectionBenchmarkResult,
    PreprocessBenchmarkResult, RunBenchmarkRequest, RunTaggerBenchmarkRequest,
    benchmarks_service_server::BenchmarksService,
};
use std::sync::Arc;
use tonic::{Request as TonicRequest, Response as TonicResponse, Status};

pub struct BenchmarksServiceImpl {
    ctx: Arc<ClientContext>,
}

impl BenchmarksServiceImpl {
    pub fn new(ctx: Arc<ClientContext>) -> Self {
        Self { ctx }
    }
}

fn benchmark_response(outcome: handlers::benchmarks::BenchmarkOutcome) -> BenchmarkResult {
    BenchmarkResult {
        clip_cpu_time_ms: outcome.clip_cpu_time_ms,
        clip_gpu_time_ms: outcome.clip_gpu_time_ms,
        clip_gpu_error: outcome.clip_gpu_error,
        tagger_cpu_time_ms: outcome.tagger_cpu_time_ms,
        tagger_gpu_time_ms: outcome.tagger_gpu_time_ms,
        tagger_gpu_error: outcome.tagger_gpu_error,
        has_gpu: outcome.has_gpu,
        taggers: outcome.taggers.into_iter().map(Into::into).collect(),
    }
}

fn detection_response(
    outcome: handlers::benchmarks::DetectionBenchmarkOutcome,
) -> DetectionBenchmarkResult {
    DetectionBenchmarkResult {
        yolo_cpu_time_ms: outcome.yolo_cpu_time_ms,
        yolo_gpu_time_ms: outcome.yolo_gpu_time_ms,
        yolo_gpu_error: outcome.yolo_gpu_error,
        ccip_feat_cpu_time_ms: outcome.ccip_feat_cpu_time_ms,
        ccip_feat_gpu_time_ms: outcome.ccip_feat_gpu_time_ms,
        ccip_feat_gpu_error: outcome.ccip_feat_gpu_error,
        ccip_metrics_cpu_time_ms: outcome.ccip_metrics_cpu_time_ms,
        ccip_metrics_gpu_time_ms: outcome.ccip_metrics_gpu_time_ms,
        ccip_metrics_gpu_error: outcome.ccip_metrics_gpu_error,
        ocr_det_cpu_time_ms: outcome.ocr_det_cpu_time_ms,
        ocr_det_gpu_time_ms: outcome.ocr_det_gpu_time_ms,
        ocr_det_gpu_error: outcome.ocr_det_gpu_error,
        ocr_rec_cpu_time_ms: outcome.ocr_rec_cpu_time_ms,
        ocr_rec_gpu_time_ms: outcome.ocr_rec_gpu_time_ms,
        ocr_rec_gpu_error: outcome.ocr_rec_gpu_error,
        ocr_cls_cpu_time_ms: outcome.ocr_cls_cpu_time_ms,
        ocr_cls_gpu_time_ms: outcome.ocr_cls_gpu_time_ms,
        ocr_cls_gpu_error: outcome.ocr_cls_gpu_error,
        manga_bubble_cpu_time_ms: outcome.manga_bubble_cpu_time_ms,
        manga_bubble_gpu_time_ms: outcome.manga_bubble_gpu_time_ms,
        manga_bubble_gpu_error: outcome.manga_bubble_gpu_error,
        safety_cpu_time_ms: outcome.safety_cpu_time_ms,
        safety_gpu_time_ms: outcome.safety_gpu_time_ms,
        safety_gpu_error: outcome.safety_gpu_error,
        has_gpu: outcome.has_gpu,
    }
}

async fn detection(
    kind: handlers::benchmarks::DetectionBenchmarkKind,
    ctx: &Arc<ClientContext>,
) -> Result<TonicResponse<DetectionBenchmarkResult>, Status> {
    let outcome =
        handlers::benchmarks::run_detection_benchmark_logic(kind, &ctx.data_dir, &ctx.settings)
            .await
            .map_err(internal_status)?;
    Ok(TonicResponse::new(detection_response(outcome)))
}

#[tonic::async_trait]
impl BenchmarksService for BenchmarksServiceImpl {
    async fn run_benchmark(
        &self,
        request: TonicRequest<RunBenchmarkRequest>,
    ) -> Result<TonicResponse<BenchmarkResult>, Status> {
        let req = request.into_inner();
        let outcome = handlers::benchmarks::run_benchmark_logic(
            crate::server::convert::embedding_from_proto(req.embedding_model),
            req.run_tagger,
            &self.ctx.model_manager,
            &self.ctx.settings,
            &self.ctx.taggers,
        )
        .await
        .map_err(internal_status)?;
        Ok(TonicResponse::new(benchmark_response(outcome)))
    }

    async fn run_tagger_benchmark(
        &self,
        request: TonicRequest<RunTaggerBenchmarkRequest>,
    ) -> Result<TonicResponse<BenchmarkResult>, Status> {
        let req = request.into_inner();
        let outcome = handlers::benchmarks::run_tagger_benchmark_logic(
            crate::server::convert::tagger_from_proto(req.tagger),
            &self.ctx.settings,
            &self.ctx.taggers,
        )
        .await
        .map_err(internal_status)?;
        Ok(TonicResponse::new(benchmark_response(outcome)))
    }

    async fn benchmark_preprocess(
        &self,
        request: TonicRequest<BenchmarkPreprocessRequest>,
    ) -> Result<TonicResponse<PreprocessBenchmarkResult>, Status> {
        let req = request.into_inner();
        let report = handlers::benchmarks::benchmark_preprocess_logic(
            &req.image_path,
            &self.ctx.settings,
            &self.ctx.taggers,
        )
        .await
        .map_err(internal_status)?;
        Ok(TonicResponse::new(PreprocessBenchmarkResult { report }))
    }

    async fn run_yolo_benchmark(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<DetectionBenchmarkResult>, Status> {
        detection(
            handlers::benchmarks::DetectionBenchmarkKind::Yolo,
            &self.ctx,
        )
        .await
    }

    async fn run_ccip_feat_benchmark(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<DetectionBenchmarkResult>, Status> {
        detection(
            handlers::benchmarks::DetectionBenchmarkKind::CcipFeat,
            &self.ctx,
        )
        .await
    }

    async fn run_ccip_metrics_benchmark(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<DetectionBenchmarkResult>, Status> {
        detection(
            handlers::benchmarks::DetectionBenchmarkKind::CcipMetrics,
            &self.ctx,
        )
        .await
    }

    async fn run_ocr_det_benchmark(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<DetectionBenchmarkResult>, Status> {
        detection(
            handlers::benchmarks::DetectionBenchmarkKind::OcrDet,
            &self.ctx,
        )
        .await
    }

    async fn run_ocr_rec_benchmark(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<DetectionBenchmarkResult>, Status> {
        detection(
            handlers::benchmarks::DetectionBenchmarkKind::OcrRec,
            &self.ctx,
        )
        .await
    }

    async fn run_ocr_cls_benchmark(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<DetectionBenchmarkResult>, Status> {
        detection(
            handlers::benchmarks::DetectionBenchmarkKind::OcrCls,
            &self.ctx,
        )
        .await
    }

    async fn run_manga_bubble_benchmark(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<DetectionBenchmarkResult>, Status> {
        detection(
            handlers::benchmarks::DetectionBenchmarkKind::MangaBubble,
            &self.ctx,
        )
        .await
    }

    async fn run_safety_benchmark(
        &self,
        _request: TonicRequest<()>,
    ) -> Result<TonicResponse<DetectionBenchmarkResult>, Status> {
        detection(
            handlers::benchmarks::DetectionBenchmarkKind::Safety,
            &self.ctx,
        )
        .await
    }
}
