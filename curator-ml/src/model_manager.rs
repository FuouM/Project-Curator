use crate::onnx::ManagedSession;
use anyhow::{Context, Error};
use curator_media::decode as image_decode;
use curator_proto::contracts::{DevicePreference, EmbeddingModel};
use curator_proto::util::now_secs;
use ndarray::{Array2, Array4};
use ort::{inputs, value::TensorRef};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokenizers::Tokenizer;
use tracing::{info, warn};

pub struct ModelManager {
    model_dir: PathBuf,
    device: Mutex<DevicePreference>,
    active_model: Mutex<EmbeddingModel>,
    vision_session: Mutex<Option<Arc<ManagedSession>>>,
    text_session: Mutex<Option<Arc<ManagedSession>>>,
    tokenizer: Mutex<Option<Tokenizer>>,
    last_used: AtomicU64,
}

impl ModelManager {
    pub fn new<P: AsRef<Path>>(model_dir: P, device: DevicePreference) -> Self {
        Self {
            model_dir: model_dir.as_ref().to_path_buf(),
            device: Mutex::new(device),
            active_model: Mutex::new(EmbeddingModel::ClipVitB32),
            vision_session: Mutex::new(None),
            text_session: Mutex::new(None),
            tokenizer: Mutex::new(None),
            last_used: AtomicU64::new(now_secs()),
        }
    }

    pub fn model_dir(&self) -> &Path {
        &self.model_dir
    }

    pub fn active_model(&self) -> EmbeddingModel {
        *self.active_model.lock().unwrap()
    }

    /// Return true if ONNX sessions are loaded in memory.
    pub fn is_loaded(&self) -> bool {
        let vs = self.vision_session.lock().unwrap();
        let ts = self.text_session.lock().unwrap();
        vs.as_ref().map(|s| s.is_loaded()).unwrap_or(false)
            && ts.as_ref().map(|s| s.is_loaded()).unwrap_or(false)
    }

    /// Seconds since last inference.
    pub fn idle_secs(&self) -> u64 {
        now_secs().saturating_sub(self.last_used.load(Ordering::Relaxed))
    }

    /// Unload all sessions and tokenizer to free memory.
    pub fn unload(&self) {
        let mut vs = self.vision_session.lock().unwrap();
        let mut ts = self.text_session.lock().unwrap();
        let mut tok = self.tokenizer.lock().unwrap();
        if vs.is_some() || ts.is_some() {
            info!("CLIP: unloading sessions (idle {}s)", self.idle_secs());
            if let Some(ref s) = *vs {
                s.unload();
            }
            if let Some(ref s) = *ts {
                s.unload();
            }
            *vs = None;
            *ts = None;
            *tok = None;
        }
    }

    /// Switch the device at runtime. Unloads sessions so they are rebuilt with
    /// the new execution provider on the next inference call.
    pub fn set_device(&self, device: DevicePreference) {
        {
            let mut d = self.device.lock().unwrap();
            *d = device.clone();
        }
        let mut vs = self.vision_session.lock().unwrap();
        let mut ts = self.text_session.lock().unwrap();
        if vs.is_some() || ts.is_some() {
            info!(
                "CLIP: device changed to {:?} — unloading sessions for reload",
                device
            );
            if let Some(ref s) = *vs {
                s.unload();
            }
            if let Some(ref s) = *ts {
                s.unload();
            }
            *vs = None;
            *ts = None;
        }
    }

    pub fn set_active_model(&self, model: EmbeddingModel) {
        {
            let mut am = self.active_model.lock().unwrap();
            if *am == model {
                return;
            }
            *am = model;
        }
        let mut vs = self.vision_session.lock().unwrap();
        let mut ts = self.text_session.lock().unwrap();
        let mut tok = self.tokenizer.lock().unwrap();
        if vs.is_some() || ts.is_some() {
            info!(
                "CLIP: active model changed to {:?} — unloading sessions for reload",
                model
            );
            if let Some(ref s) = *vs {
                s.unload();
            }
            if let Some(ref s) = *ts {
                s.unload();
            }
            *vs = None;
            *ts = None;
            *tok = None;
        }
    }

    /// Ensure both ONNX sessions and tokenizer are loaded. Idempotent.
    fn ensure_loaded(&self) -> Result<(), Error> {
        let is_vision_none = self.vision_session.lock().unwrap().is_none();
        let is_text_none = self.text_session.lock().unwrap().is_none();
        let is_tok_none = self.tokenizer.lock().unwrap().is_none();

        if !is_tok_none && !is_vision_none && !is_text_none {
            return Ok(());
        }

        let active = self.active_model();
        let (tokenizer_path, vision_path, text_path) = match active {
            EmbeddingModel::ClipVitB32 => (
                self.model_dir.join("clip-vit-b32").join("tokenizer.json"),
                self.model_dir
                    .join("clip-vit-b32")
                    .join("vision_model.onnx"),
                self.model_dir.join("clip-vit-b32").join("text_model.onnx"),
            ),
            EmbeddingModel::MobileClipS2 => (
                self.model_dir.join("mobileclip-s2").join("tokenizer.json"),
                self.model_dir
                    .join("mobileclip-s2")
                    .join("onnx")
                    .join("vision_model.onnx"),
                self.model_dir
                    .join("mobileclip-s2")
                    .join("onnx")
                    .join("text_model.onnx"),
            ),
        };
        let device = self.device.lock().unwrap().clone();

        // Tokenizer
        {
            let mut tok = self.tokenizer.lock().unwrap();
            if tok.is_none() {
                info!("Loading Tokenizer from {:?}", tokenizer_path);
                *tok = Some(
                    Tokenizer::from_file(&tokenizer_path)
                        .map_err(|e| anyhow::anyhow!("Failed to parse tokenizer.json: {:?}", e))?,
                );
            }
        }

        // Vision session
        {
            let mut vs = self.vision_session.lock().unwrap();
            if vs.is_none() {
                info!("Loading ONNX Vision Session from {:?}", vision_path);
                *vs = Some(Arc::new(ManagedSession::new(
                    "CLIP Vision",
                    vision_path,
                    device.clone(),
                    1,
                )));
            }
        }

        // Text session
        {
            let mut ts = self.text_session.lock().unwrap();
            if ts.is_none() {
                info!("Loading ONNX Text Session from {:?}", text_path);
                *ts = Some(Arc::new(ManagedSession::new(
                    "CLIP Text",
                    text_path,
                    device,
                    1,
                )));
            }
        }

        Ok(())
    }

    /// Download models and tokenizer. Does NOT create ONNX sessions — those
    /// are created lazily on the first inference call.
    pub fn init(&self) -> Result<(), Error> {
        // Search upwards for onnxruntime.dll starting from current executable path
        if let Ok(exe_path) = std::env::current_exe() {
            let mut current_dir = exe_path.parent();
            let mut found = false;
            for _ in 0..5 {
                if let Some(dir) = current_dir {
                    let candidate = dir.join("onnxruntime.dll");
                    if candidate.exists() {
                        info!("Setting ORT_DYLIB_PATH programmatically to {:?}", candidate);
                        unsafe {
                            std::env::set_var("ORT_DYLIB_PATH", &candidate);
                        }
                        found = true;
                        break;
                    }
                    current_dir = dir.parent();
                } else {
                    break;
                }
            }
            if !found {
                warn!("onnxruntime.dll not found in parent search path");
            }
        }

        fs::create_dir_all(&self.model_dir)?;

        let active = self.active_model();
        info!("{:?} models initialized", active);
        Ok(())
    }

    fn generate_image_embedding_inner(&self, image_path: &Path) -> Result<Vec<f32>, Error> {
        self.ensure_loaded()?;
        self.last_used.store(now_secs(), Ordering::Relaxed);
        let vs_arc = {
            let guard = self.vision_session.lock().unwrap();
            guard
                .as_ref()
                .cloned()
                .context("Vision model not initialized")?
        };

        // 1. Decode image via shared fast decode
        let (rgb_buf, width, height) = image_decode::decode_rgb(image_path)?;

        // 2. Center-crop + resize to target size via fast_image_resize.
        //    `ResizeOptions::crop` crops directly from the decoded buffer, avoiding
        //    the temporary square copy; identical source region and filter as the
        //    legacy manual crop + resize, and consistent with the batch path
        //    (image_decode::decode_and_resize_single_image).
        let size = width.min(height);
        let cx = (width - size) / 2;
        let cy = (height - size) / 2;
        let active = self.active_model();
        let target_size = match active {
            EmbeddingModel::ClipVitB32 => 224,
            EmbeddingModel::MobileClipS2 => 256,
        };

        let crop_ref = fast_image_resize::images::ImageRef::new(
            width,
            height,
            &rgb_buf,
            fast_image_resize::PixelType::U8x3,
        )?;
        let mut dst_image = fast_image_resize::images::Image::from_vec_u8(
            target_size,
            target_size,
            vec![0u8; (target_size * target_size * 3) as usize],
            fast_image_resize::PixelType::U8x3,
        )?;
        let mut resizer = fast_image_resize::Resizer::new();
        let opts = fast_image_resize::ResizeOptions::new()
            .crop(cx as f64, cy as f64, size as f64, size as f64)
            .resize_alg(fast_image_resize::ResizeAlg::Convolution(
                fast_image_resize::FilterType::Bilinear,
            ));
        resizer.resize(&crop_ref, &mut dst_image, Some(&opts))?;

        // 3. Build normalized NCHW tensor. MobileClipS2 uses mean=0/std=1
        //    (equivalent to a raw /255.0); ClipVitB32 uses the canonical CLIP
        //    constants. Pad color [0;3] never surfaces - the crop is square and
        //    fills the tensor exactly.
        let (mean, std) = match active {
            EmbeddingModel::ClipVitB32 => {
                (&crate::preprocess::CLIP_MEAN, &crate::preprocess::CLIP_STD)
            }
            EmbeddingModel::MobileClipS2 => (&[0.0f32; 3], &[1.0f32; 3]),
        };
        let input_array = crate::preprocess::build_tensor(
            dst_image.buffer(),
            target_size,
            target_size,
            target_size,
            mean,
            std,
            &[0u8; 3],
        );

        // 5. Run inference
        let mut embedding = vs_arc.with_session(|session| {
            let outputs = session.run(inputs![TensorRef::from_array_view(&input_array)?])?;
            let output_tensor = outputs
                .get("image_embeds")
                .or_else(|| outputs.get("output_0"))
                .context("Failed to get image embeds output from model")?;
            let (_, data) = output_tensor.try_extract_tensor::<f32>()?;
            Ok(data.to_vec())
        })?;

        let norm = (embedding.iter().map(|&x| x * x).sum::<f32>()).sqrt();
        if norm > 0.0 {
            for val in &mut embedding {
                *val /= norm;
            }
        }

        Ok(embedding)
    }

    pub fn generate_image_embedding<P: AsRef<Path>>(
        &self,
        image_path: P,
    ) -> Result<Vec<f32>, Error> {
        let path = image_path.as_ref();
        let res = self.generate_image_embedding_inner(path);
        if let Err(ref err) = res {
            let is_gpu = {
                let d = self.device.lock().unwrap();
                *d != DevicePreference::Cpu
            };
            if is_gpu {
                warn!(
                    "ONNX vision inference failed (probably GPU/DirectML driver issue): {:?}. Falling back to CPU...",
                    err
                );
                self.set_device(DevicePreference::Cpu);
                return self.generate_image_embedding_inner(path);
            }
        }
        res
    }

    pub fn preprocess_image_batch<P: AsRef<Path>>(
        &self,
        image_paths: &[P],
    ) -> Result<Vec<Result<Vec<u8>, Error>>, Error> {
        let active = self.active_model();
        let target_size = match active {
            EmbeddingModel::ClipVitB32 => 224,
            EmbeddingModel::MobileClipS2 => 256,
        };

        if image_paths.is_empty() {
            return Ok(Vec::new());
        }

        let num_threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .expect("Failed to query hardware parallelism")
            .min(image_paths.len());

        let chunk_size = (image_paths.len() + num_threads - 1) / num_threads;
        let mut preprocessed = Vec::with_capacity(image_paths.len());
        for _ in 0..image_paths.len() {
            preprocessed.push(Err(anyhow::anyhow!("Initialization failed")));
        }

        let paths_vec: Vec<&Path> = image_paths.iter().map(|p| p.as_ref()).collect();

        std::thread::scope(|s| {
            let mut handles = Vec::with_capacity(num_threads);

            for (thread_idx, chunk) in paths_vec.chunks(chunk_size).enumerate() {
                let start_idx = thread_idx * chunk_size;
                let handle = s.spawn(move || -> Vec<(usize, Result<Vec<u8>, Error>)> {
                    let mut resizer = fast_image_resize::Resizer::new();
                    let mut results = Vec::with_capacity(chunk.len());

                    for (local_i, &path) in chunk.iter().enumerate() {
                        let idx = start_idx + local_i;
                        let res = image_decode::decode_and_resize_single_image(
                            path,
                            target_size,
                            &mut resizer,
                        );
                        results.push((idx, res));
                    }
                    results
                });
                handles.push(handle);
            }

            for handle in handles {
                if let Ok(chunk_results) = handle.join() {
                    for (idx, res) in chunk_results {
                        if idx < preprocessed.len() {
                            preprocessed[idx] = res;
                        }
                    }
                }
            }
        });

        Ok(preprocessed)
    }

    fn run_inference_on_preprocessed_batch_inner(
        &self,
        preprocessed: &[Result<Vec<u8>, Error>],
    ) -> Result<Vec<Result<Vec<f32>, Error>>, Error> {
        self.ensure_loaded()?;
        self.last_used.store(now_secs(), Ordering::Relaxed);
        let vs_arc = {
            let guard = self.vision_session.lock().unwrap();
            guard
                .as_ref()
                .cloned()
                .context("Vision model not initialized")?
        };

        let active = self.active_model();
        let target_size = match active {
            EmbeddingModel::ClipVitB32 => 224,
            EmbeddingModel::MobileClipS2 => 256,
        };

        let mut valid_indices = Vec::new();
        for (idx, item) in preprocessed.iter().enumerate() {
            if item.is_ok() {
                valid_indices.push(idx);
            }
        }

        let mut results = Vec::with_capacity(preprocessed.len());
        for _ in 0..preprocessed.len() {
            results.push(Err(anyhow::anyhow!("Skipped due to preprocessing error")));
        }

        if valid_indices.is_empty() {
            for (idx, item) in preprocessed.iter().enumerate() {
                if let Err(e) = item {
                    results[idx] = Err(anyhow::anyhow!("{:?}", e));
                }
            }
            return Ok(results);
        }

        let batch_size = valid_indices.len();
        let mut input_array =
            Array4::<f32>::zeros((batch_size, 3, target_size as usize, target_size as usize));

        for (batch_idx, &orig_idx) in valid_indices.iter().enumerate() {
            if let Ok(resized_buf) = &preprocessed[orig_idx] {
                match active {
                    EmbeddingModel::ClipVitB32 => {
                        let mean = [0.48145466, 0.4578275, 0.40821073];
                        let std = [0.26862954, 0.261_302_6, 0.275_777_1];
                        let slice = input_array.as_slice_mut().unwrap();
                        let batch_offset = batch_idx * 3 * 224 * 224;
                        for c in 0..3 {
                            let inv_scale = 1.0 / (std[c] * 255.0);
                            let sub = mean[c] / std[c];
                            let channel_offset = batch_offset + c * 224 * 224;
                            let c_slice = &mut slice[channel_offset..channel_offset + 224 * 224];
                            for idx in 0..224 * 224 {
                                c_slice[idx] = (resized_buf[idx * 3 + c] as f32) * inv_scale - sub;
                            }
                        }
                    }
                    EmbeddingModel::MobileClipS2 => {
                        let slice = input_array.as_slice_mut().unwrap();
                        let batch_offset = batch_idx * 3 * 256 * 256;
                        let inv_scale = 1.0 / 255.0;
                        for c in 0..3 {
                            let channel_offset = batch_offset + c * 256 * 256;
                            let c_slice = &mut slice[channel_offset..channel_offset + 256 * 256];
                            for idx in 0..256 * 256 {
                                c_slice[idx] = (resized_buf[idx * 3 + c] as f32) * inv_scale;
                            }
                        }
                    }
                }
            }
        }

        let flat_outputs = vs_arc.with_session(|session| {
            let outputs = session.run(inputs![TensorRef::from_array_view(&input_array)?])?;
            let output_tensor = outputs
                .get("image_embeds")
                .or_else(|| outputs.get("output_0"))
                .context("Failed to get image embeds output from model")?;
            let (_, data) = output_tensor.try_extract_tensor::<f32>()?;
            Ok(data.to_vec())
        })?;

        for (batch_idx, &orig_idx) in valid_indices.iter().enumerate() {
            let start = batch_idx * 512;
            let end = start + 512;
            if end <= flat_outputs.len() {
                let mut embedding = flat_outputs[start..end].to_vec();
                let norm = (embedding.iter().map(|&x| x * x).sum::<f32>()).sqrt();
                if norm > 0.0 {
                    for val in &mut embedding {
                        *val /= norm;
                    }
                }
                results[orig_idx] = Ok(embedding);
            } else {
                results[orig_idx] = Err(anyhow::anyhow!("Output tensor size mismatch"));
            }
        }

        // Fill in actual preprocessing errors for failed images
        for (idx, item) in preprocessed.iter().enumerate() {
            if let Err(e) = item {
                results[idx] = Err(anyhow::anyhow!("{:?}", e));
            }
        }

        Ok(results)
    }

    pub fn run_inference_on_preprocessed_batch(
        &self,
        preprocessed: &[Result<Vec<u8>, Error>],
    ) -> Result<Vec<Result<Vec<f32>, Error>>, Error> {
        let res = self.run_inference_on_preprocessed_batch_inner(preprocessed);
        if let Err(ref err) = res {
            let is_gpu = {
                let d = self.device.lock().unwrap();
                *d != DevicePreference::Cpu
            };
            if is_gpu {
                warn!(
                    "ONNX vision batch inference failed (probably GPU/DirectML driver issue): {:?}. Falling back to CPU...",
                    err
                );
                self.set_device(DevicePreference::Cpu);
                return self.run_inference_on_preprocessed_batch_inner(preprocessed);
            }
        }
        res
    }

    pub fn generate_image_embeddings<P: AsRef<Path>>(
        &self,
        image_paths: &[P],
    ) -> Result<Vec<Result<Vec<f32>, Error>>, Error> {
        let preprocessed = self.preprocess_image_batch(image_paths)?;
        self.run_inference_on_preprocessed_batch(&preprocessed)
    }

    fn generate_text_embedding_inner(&self, text: &str) -> Result<Vec<f32>, Error> {
        self.ensure_loaded()?;
        self.last_used.store(now_secs(), Ordering::Relaxed);
        let ts_arc = {
            let guard = self.text_session.lock().unwrap();
            guard
                .as_ref()
                .cloned()
                .context("Text model not initialized")?
        };
        let tok_guard = self.tokenizer.lock().unwrap();
        let tokenizer = tok_guard.as_ref().context("Tokenizer not initialized")?;

        let encoding = tokenizer
            .encode(text, true)
            .map_err(|e| anyhow::anyhow!("Tokenization failed: {:?}", e))?;

        let input_ids = encoding.get_ids();

        // Pad or truncate to exactly 77 tokens (CLIP standard) to prevent dynamic shape errors in DirectML
        let mut padded_ids = vec![0i64; 77];
        let copy_len = input_ids.len().min(77);
        for i in 0..copy_len {
            padded_ids[i] = input_ids[i] as i64;
        }

        let input_ids_array = Array2::<i64>::from_shape_fn((1, 77), |(_, j)| padded_ids[j]);

        let mut embedding = ts_arc.with_session(|session| {
            let outputs = session.run(inputs![
                "input_ids" => TensorRef::from_array_view(&input_ids_array)?
            ])?;
            let output_tensor = outputs
                .get("text_embeds")
                .or_else(|| outputs.get("output_0"))
                .context("Failed to get text embeds output from model")?;
            let (_, data) = output_tensor.try_extract_tensor::<f32>()?;
            Ok(data.to_vec())
        })?;

        let norm = (embedding.iter().map(|&x| x * x).sum::<f32>()).sqrt();
        if norm > 0.0 {
            for val in &mut embedding {
                *val /= norm;
            }
        }

        Ok(embedding)
    }

    pub fn generate_text_embedding(&self, text: &str) -> Result<Vec<f32>, Error> {
        let res = self.generate_text_embedding_inner(text);
        if let Err(ref err) = res {
            let is_gpu = {
                let d = self.device.lock().unwrap();
                *d != DevicePreference::Cpu
            };
            if is_gpu {
                warn!(
                    "ONNX text inference failed (probably GPU/DirectML driver issue): {:?}. Falling back to CPU...",
                    err
                );
                self.set_device(DevicePreference::Cpu);
                return self.generate_text_embedding_inner(text);
            }
        }
        res
    }
}

impl curator_proto::pipeline::SystemNode for ModelManager {
    fn info(&self) -> curator_proto::pipeline::NodeInfo {
        curator_proto::pipeline::NodeInfo {
            id: "clip-embedder",
            label: "CLIP Visual/Text Embedder",
            inputs: vec![
                curator_proto::pipeline::Port {
                    name: "image",
                    type_name: "Image",
                },
                curator_proto::pipeline::Port {
                    name: "text",
                    type_name: "TextMetadata",
                },
            ],
            outputs: vec![curator_proto::pipeline::Port {
                name: "embedding",
                type_name: "EmbeddingVector",
            }],
        }
    }

    fn device(&self) -> DevicePreference {
        self.device.lock().unwrap().clone()
    }

    fn set_device(&self, device: DevicePreference) {
        ModelManager::set_device(self, device);
    }

    fn unload_all(&self) {
        ModelManager::unload(self);
    }

    fn is_loaded(&self) -> bool {
        ModelManager::is_loaded(self)
    }
}
