use crate::handlers::{BenchmarkProgressMap, ImageProcessingBenchmarkProgress};
use crate::AppSettings;
use anyhow::{bail, Result};
use curator_core::ipc::{EmbeddingModel, ModelPrecision, TaggerBenchmarkInfo, TaggerModel};
use curator_core::tagger::TaggerManager;
use curator_ml::{ModelManager, SingleImageBenchmarkResult};
use sqlx::SqlitePool;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::info;

pub async fn get_benchmark_images(db: &SqlitePool, limit: usize) -> Result<Vec<String>> {
    curator_ml::get_benchmark_images(db, limit).await
}

pub async fn run_single_image_benchmark(
    model_manager: &ModelManager,
    filepath: &str,
    settings: &Arc<Mutex<AppSettings>>,
    taggers: &Arc<TaggerManager>,
) -> Result<SingleImageBenchmarkResult> {
    let tagger_spec = {
        let preferred = settings.lock().await.preferred_tagger;
        taggers.engine(&preferred).spec()
    };
    curator_ml::run_single_image_benchmark(model_manager, filepath, tagger_spec).await
}

/// Kicks off the full-library image-processing benchmark in the background.
/// Returns the initial progress snapshot, or an error if a benchmark is
/// already running.
pub async fn start_image_processing_benchmark(
    model_manager: Arc<ModelManager>,
    filepaths: Vec<String>,
    settings: Arc<Mutex<AppSettings>>,
    taggers: Arc<TaggerManager>,
    progress: BenchmarkProgressMap,
) -> Result<ImageProcessingBenchmarkProgress> {
    {
        let mut slot = progress.lock().await;
        if let Some(p) = slot.as_ref() {
            if p.running {
                bail!("An image processing benchmark is already running.");
            }
        }
        *slot = Some(ImageProcessingBenchmarkProgress {
            running: true,
            total: filepaths.len(),
            ..Default::default()
        });
    }

    let progress_task = progress.clone();
    tokio::spawn(async move {
        let tagger_spec = {
            let preferred = settings.lock().await.preferred_tagger;
            taggers.engine(&preferred).spec()
        };
        for (idx, filepath) in filepaths.iter().enumerate() {
            match curator_ml::run_single_image_benchmark(&model_manager, filepath, tagger_spec)
                .await
            {
                Ok(res) => {
                    let mut slot = progress_task.lock().await;
                    if let Some(p) = slot.as_mut() {
                        p.processed = idx + 1;
                        p.read_time_ms += res.read_time_ms;
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
                    let mut slot = progress_task.lock().await;
                    if let Some(p) = slot.as_mut() {
                        p.processed = idx + 1;
                    }
                }
            }
        }
        let mut slot = progress_task.lock().await;
        if let Some(p) = slot.as_mut() {
            p.running = false;
        }
    });

    let snapshot = progress.lock().await;
    Ok(snapshot.as_ref().cloned().unwrap_or_default())
}

pub async fn get_image_processing_benchmark_progress(
    progress: &BenchmarkProgressMap,
) -> ImageProcessingBenchmarkProgress {
    let snapshot = progress.lock().await;
    snapshot.as_ref().cloned().unwrap_or_default()
}

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
        match curator_ml::run_onnx_benchmark(&tagger_path, spec.input_size as usize) {
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

pub struct BenchmarkOutcome {
    pub clip_cpu_time_ms: f64,
    pub clip_gpu_time_ms: Option<f64>,
    pub clip_gpu_error: Option<String>,
    pub tagger_cpu_time_ms: Option<f64>,
    pub tagger_gpu_time_ms: Option<f64>,
    pub tagger_gpu_error: Option<String>,
    pub has_gpu: bool,
    pub taggers: Vec<TaggerBenchmarkInfo>,
}

pub async fn run_benchmark_logic(
    embedding_model: EmbeddingModel,
    run_tagger: Option<bool>,
    model_manager: &ModelManager,
    settings: &Arc<Mutex<AppSettings>>,
    taggers: &Arc<TaggerManager>,
) -> Result<BenchmarkOutcome> {
    let prefer_quantized_clip = settings
        .lock()
        .await
        .model_precisions
        .get(match embedding_model {
            EmbeddingModel::ClipVitB32 => "clip-vit-b32",
            EmbeddingModel::MobileClipS2 => "mobileclip-s2",
        })
        .copied()
        .unwrap_or(ModelPrecision::Original)
        == ModelPrecision::Int8;

    let mut vision_path = match embedding_model {
        EmbeddingModel::ClipVitB32 => model_manager
            .model_dir()
            .join("clip-vit-b32")
            .join("vision_model.onnx"),
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

    info!(
        "RunBenchmark request: embedding_model={:?}, vision_path={:?}, run_tagger={}, tagger_path={:?}, tagger_path_exists={}",
        embedding_model,
        vision_path,
        run_tagger_val,
        tagger_engine.model_path(),
        tagger_engine.model_path().exists()
    );

    let clip_res = curator_ml::run_onnx_benchmark(&vision_path, target_size);

    let model_precisions = settings.lock().await.model_precisions.clone();
    let tagger_infos: Vec<TaggerBenchmarkInfo> = if run_tagger_val {
        taggers
            .all()
            .iter()
            .map(|engine| benchmark_tagger_engine(engine, &model_precisions))
            .collect()
    } else {
        Vec::new()
    };
    let preferred_info = tagger_infos.iter().find(|t| t.key == tagger_spec.key);
    let (tagger_cpu_time_ms, tagger_gpu_time_ms, tagger_gpu_error) = match preferred_info {
        Some(t) => (t.cpu_time_ms, t.gpu_time_ms, t.gpu_error.clone()),
        None => (None, None, None),
    };

    match clip_res {
        Ok((clip_cpu, clip_gpu, clip_err, has_gpu)) => Ok(BenchmarkOutcome {
            clip_cpu_time_ms: clip_cpu,
            clip_gpu_time_ms: clip_gpu,
            clip_gpu_error: clip_err,
            tagger_cpu_time_ms,
            tagger_gpu_time_ms,
            tagger_gpu_error,
            has_gpu,
            taggers: tagger_infos,
        }),
        Err(e) => bail!("CLIP model benchmark failed: {:?}", e),
    }
}

pub async fn run_tagger_benchmark_logic(
    tagger: Option<TaggerModel>,
    settings: &Arc<Mutex<AppSettings>>,
    taggers: &Arc<TaggerManager>,
) -> Result<BenchmarkOutcome> {
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
    Ok(BenchmarkOutcome {
        clip_cpu_time_ms: 0.0,
        clip_gpu_time_ms: None,
        clip_gpu_error: None,
        tagger_cpu_time_ms,
        tagger_gpu_time_ms,
        tagger_gpu_error,
        has_gpu,
        taggers: tagger_infos,
    })
}

pub async fn benchmark_preprocess_logic(
    image_path: &str,
    settings: &Arc<Mutex<AppSettings>>,
    taggers: &Arc<TaggerManager>,
) -> Result<String> {
    let path = Path::new(image_path);
    let input_size = {
        let preferred = settings.lock().await.preferred_tagger;
        taggers.engine(&preferred).spec().input_size
    };
    match curator_ml::benchmark_preprocess(path, input_size, 3) {
        Ok((_decode, _resize, _norm, report)) => {
            info!("Preprocess benchmark:\n{}", report);
            Ok(report)
        }
        Err(e) => bail!("Preprocess benchmark failed: {:?}", e),
    }
}

pub enum DetectionBenchmarkKind {
    Yolo,
    CcipFeat,
    CcipMetrics,
    OcrDet,
    OcrRec,
    OcrCls,
    MangaBubble,
    Safety,
}

pub struct DetectionBenchmarkOutcome {
    pub yolo_cpu_time_ms: Option<f64>,
    pub yolo_gpu_time_ms: Option<f64>,
    pub yolo_gpu_error: Option<String>,
    pub ccip_feat_cpu_time_ms: Option<f64>,
    pub ccip_feat_gpu_time_ms: Option<f64>,
    pub ccip_feat_gpu_error: Option<String>,
    pub ccip_metrics_cpu_time_ms: Option<f64>,
    pub ccip_metrics_gpu_time_ms: Option<f64>,
    pub ccip_metrics_gpu_error: Option<String>,
    pub ocr_det_cpu_time_ms: Option<f64>,
    pub ocr_det_gpu_time_ms: Option<f64>,
    pub ocr_det_gpu_error: Option<String>,
    pub ocr_rec_cpu_time_ms: Option<f64>,
    pub ocr_rec_gpu_time_ms: Option<f64>,
    pub ocr_rec_gpu_error: Option<String>,
    pub ocr_cls_cpu_time_ms: Option<f64>,
    pub ocr_cls_gpu_time_ms: Option<f64>,
    pub ocr_cls_gpu_error: Option<String>,
    pub manga_bubble_cpu_time_ms: Option<f64>,
    pub manga_bubble_gpu_time_ms: Option<f64>,
    pub manga_bubble_gpu_error: Option<String>,
    pub safety_cpu_time_ms: Option<f64>,
    pub safety_gpu_time_ms: Option<f64>,
    pub safety_gpu_error: Option<String>,
    pub has_gpu: bool,
}

fn detection_outcome(
    yolo: Option<(f64, Option<f64>, Option<String>)>,
    ccip_feat: Option<(f64, Option<f64>, Option<String>)>,
    ccip_metrics: Option<(f64, Option<f64>, Option<String>)>,
    ocr_det: Option<(f64, Option<f64>, Option<String>)>,
    ocr_rec: Option<(f64, Option<f64>, Option<String>)>,
    ocr_cls: Option<(f64, Option<f64>, Option<String>)>,
    manga_bubble: Option<(f64, Option<f64>, Option<String>)>,
    safety: Option<(f64, Option<f64>, Option<String>)>,
    has_gpu: bool,
) -> DetectionBenchmarkOutcome {
    let field = |opt: Option<(f64, Option<f64>, Option<String>)>| {
        opt.map(|(cpu, gpu, err)| (Some(cpu), gpu, err))
            .unwrap_or((None, None, None))
    };
    let (yolo_cpu, yolo_gpu, yolo_err) = field(yolo);
    let (ccip_feat_cpu, ccip_feat_gpu, ccip_feat_err) = field(ccip_feat);
    let (ccip_metrics_cpu, ccip_metrics_gpu, ccip_metrics_err) = field(ccip_metrics);
    let (ocr_det_cpu, ocr_det_gpu, ocr_det_err) = field(ocr_det);
    let (ocr_rec_cpu, ocr_rec_gpu, ocr_rec_err) = field(ocr_rec);
    let (ocr_cls_cpu, ocr_cls_gpu, ocr_cls_err) = field(ocr_cls);
    let (manga_cpu, manga_gpu, manga_err) = field(manga_bubble);
    let (safety_cpu, safety_gpu, safety_err) = field(safety);
    DetectionBenchmarkOutcome {
        yolo_cpu_time_ms: yolo_cpu,
        yolo_gpu_time_ms: yolo_gpu,
        yolo_gpu_error: yolo_err,
        ccip_feat_cpu_time_ms: ccip_feat_cpu,
        ccip_feat_gpu_time_ms: ccip_feat_gpu,
        ccip_feat_gpu_error: ccip_feat_err,
        ccip_metrics_cpu_time_ms: ccip_metrics_cpu,
        ccip_metrics_gpu_time_ms: ccip_metrics_gpu,
        ccip_metrics_gpu_error: ccip_metrics_err,
        ocr_det_cpu_time_ms: ocr_det_cpu,
        ocr_det_gpu_time_ms: ocr_det_gpu,
        ocr_det_gpu_error: ocr_det_err,
        ocr_rec_cpu_time_ms: ocr_rec_cpu,
        ocr_rec_gpu_time_ms: ocr_rec_gpu,
        ocr_rec_gpu_error: ocr_rec_err,
        ocr_cls_cpu_time_ms: ocr_cls_cpu,
        ocr_cls_gpu_time_ms: ocr_cls_gpu,
        ocr_cls_gpu_error: ocr_cls_err,
        manga_bubble_cpu_time_ms: manga_cpu,
        manga_bubble_gpu_time_ms: manga_gpu,
        manga_bubble_gpu_error: manga_err,
        safety_cpu_time_ms: safety_cpu,
        safety_gpu_time_ms: safety_gpu,
        safety_gpu_error: safety_err,
        has_gpu,
    }
}

pub async fn run_detection_benchmark_logic(
    kind: DetectionBenchmarkKind,
    data_dir: &Path,
    settings: &Arc<Mutex<AppSettings>>,
) -> Result<DetectionBenchmarkOutcome> {
    let det_dir = data_dir.join("models");
    let model_precisions = settings.lock().await.model_precisions.clone();
    let prefer_quantized = |key: &str| {
        model_precisions
            .get(key)
            .copied()
            .unwrap_or(ModelPrecision::Original)
            == ModelPrecision::Int8
    };

    match kind {
        DetectionBenchmarkKind::Yolo => {
            let mut path = det_dir.join("yolo-person/model.onnx");
            if prefer_quantized("yolo-person") {
                let int8_path = det_dir.join("yolo-person/model_int8.onnx");
                if int8_path.exists() {
                    path = int8_path;
                }
            }
            info!("RunYoloBenchmark request: exists={}", path.exists());
            if !path.exists() {
                bail!("YOLO model file not found.");
            }
            let (cpu, gpu, err, has_gpu) = curator_ml::run_onnx_benchmark(&path, 640)
                .map_err(|e| anyhow::anyhow!("Yolo benchmark failed: {:?}", e))?;
            Ok(detection_outcome(
                Some((cpu, gpu, err)),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                has_gpu,
            ))
        }
        DetectionBenchmarkKind::CcipFeat => {
            let path = det_dir.join("ccip/model_feat.onnx");
            info!("RunCcipFeatBenchmark request: exists={}", path.exists());
            if !path.exists() {
                bail!("CCIP Feature model file not found.");
            }
            let (cpu, gpu, err, has_gpu) = curator_ml::run_onnx_benchmark(&path, 384)
                .map_err(|e| anyhow::anyhow!("CCIP Feature benchmark failed: {:?}", e))?;
            Ok(detection_outcome(
                None,
                Some((cpu, gpu, err)),
                None,
                None,
                None,
                None,
                None,
                None,
                has_gpu,
            ))
        }
        DetectionBenchmarkKind::CcipMetrics => {
            let path = det_dir.join("ccip/model_metrics.onnx");
            info!("RunCcipMetricsBenchmark request: exists={}", path.exists());
            if !path.exists() {
                bail!("CCIP Metrics model file not found.");
            }
            let (cpu, gpu, err, has_gpu) = curator_ml::run_onnx_benchmark_2d(&path, 16, 768)
                .map_err(|e| anyhow::anyhow!("CCIP Metrics benchmark failed: {:?}", e))?;
            Ok(detection_outcome(
                None,
                None,
                Some((cpu, gpu, err)),
                None,
                None,
                None,
                None,
                None,
                has_gpu,
            ))
        }
        DetectionBenchmarkKind::OcrDet => {
            let mut path = det_dir.join("pp-ocrv6-medium/det/inference.onnx");
            if prefer_quantized("pp-ocrv6-medium") {
                let int8_path = det_dir.join("pp-ocrv6-medium/det/inference_int8.onnx");
                if int8_path.exists() {
                    path = int8_path;
                }
            }
            if !path.exists() {
                bail!("OCR Detection model file not found.");
            }
            let (cpu, gpu, err, has_gpu) = curator_ml::run_onnx_benchmark(&path, 960)
                .map_err(|e| anyhow::anyhow!("OCR Detection benchmark failed: {:?}", e))?;
            Ok(detection_outcome(
                None,
                None,
                None,
                Some((cpu, gpu, err)),
                None,
                None,
                None,
                None,
                has_gpu,
            ))
        }
        DetectionBenchmarkKind::OcrRec => {
            let mut path = det_dir.join("pp-ocrv6-medium/rec/inference.onnx");
            if prefer_quantized("pp-ocrv6-medium") {
                let int8_path = det_dir.join("pp-ocrv6-medium/rec/inference_int8.onnx");
                if int8_path.exists() {
                    path = int8_path;
                }
            }
            if !path.exists() {
                bail!("OCR Recognition model file not found.");
            }
            let (cpu, gpu, err, has_gpu) = curator_ml::run_onnx_benchmark_4d(&path, 48, 320)
                .map_err(|e| anyhow::anyhow!("OCR Recognition benchmark failed: {:?}", e))?;
            Ok(detection_outcome(
                None,
                None,
                None,
                None,
                Some((cpu, gpu, err)),
                None,
                None,
                None,
                has_gpu,
            ))
        }
        DetectionBenchmarkKind::OcrCls => {
            let path = det_dir.join("pp-lcnet-cls/inference.onnx");
            if !path.exists() {
                bail!("OCR Classification model file not found.");
            }
            let (cpu, gpu, err, has_gpu) = curator_ml::run_onnx_benchmark_4d(&path, 80, 160)
                .map_err(|e| anyhow::anyhow!("OCR Classification benchmark failed: {:?}", e))?;
            Ok(detection_outcome(
                None,
                None,
                None,
                None,
                None,
                Some((cpu, gpu, err)),
                None,
                None,
                has_gpu,
            ))
        }
        DetectionBenchmarkKind::MangaBubble => {
            let mut path = det_dir.join("manga-bubble-yolo/yolo26n.onnx");
            if prefer_quantized("manga-bubble-yolo") {
                let int8_path = det_dir.join("manga-bubble-yolo/yolo26n_int8.onnx");
                if int8_path.exists() {
                    path = int8_path;
                }
            }
            if !path.exists() {
                bail!("Manga Bubble YOLO model file not found.");
            }
            let (cpu, gpu, err, has_gpu) = curator_ml::run_onnx_benchmark(&path, 1280)
                .map_err(|e| anyhow::anyhow!("Manga Bubble YOLO benchmark failed: {:?}", e))?;
            Ok(detection_outcome(
                None,
                None,
                None,
                None,
                None,
                None,
                Some((cpu, gpu, err)),
                None,
                has_gpu,
            ))
        }
        DetectionBenchmarkKind::Safety => {
            let nsfw_dir = det_dir.join("nsfw-detection-2-mini/onnx");
            let precision = model_precisions
                .get("nsfw-detection-2-mini")
                .copied()
                .unwrap_or(ModelPrecision::Original);

            let path = match precision {
                ModelPrecision::Fp16 => {
                    let fp16_1 = nsfw_dir.join("nsfw-detection-2-mini_fp16.onnx");
                    let fp16_2 = nsfw_dir.join("nsfw-detection-2-mini-fp16.onnx");
                    if fp16_1.exists() {
                        fp16_1
                    } else if fp16_2.exists() {
                        fp16_2
                    } else {
                        nsfw_dir.join("nsfw-detection-2-mini.onnx")
                    }
                }
                ModelPrecision::Int8 => {
                    let int8 = nsfw_dir.join("nsfw-detection-2-mini_int8.onnx");
                    if int8.exists() {
                        int8
                    } else {
                        nsfw_dir.join("nsfw-detection-2-mini.onnx")
                    }
                }
                ModelPrecision::Original => nsfw_dir.join("nsfw-detection-2-mini.onnx"),
            };
            if !path.exists() {
                bail!("Safety model file not found at {:?}", path);
            }
            info!("RunSafetyBenchmark request: path={:?}", path);
            let (cpu, gpu, err) = curator_ml::benchmark_safety_classifier(&path)
                .map_err(|e| anyhow::anyhow!("Safety benchmark failed: {:?}", e))?;
            Ok(detection_outcome(
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                Some((cpu, gpu, err)),
                gpu.is_some(),
            ))
        }
    }
}
