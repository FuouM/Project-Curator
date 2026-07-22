use crate::ipc::{DevicePreference, EmbeddingModel};
use anyhow::{Context, Error};
use ndarray::{Array2, Array4};
use ort::{inputs, session::Session, session::builder::SessionBuilder, value::TensorRef};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tokenizers::Tokenizer;
use tracing::{info, warn};
use usearch::{Index, IndexOptions, MetricKind, ScalarKind};

pub struct VectorIndex {
    index: Index,
    path: PathBuf,
}

impl VectorIndex {
    pub fn new<P: AsRef<Path>>(index_path: P, dimensions: usize) -> Result<Self, Error> {
        let path = index_path.as_ref().to_path_buf();
        let options = IndexOptions {
            dimensions,
            metric: MetricKind::Cos,
            quantization: ScalarKind::F32,
            ..Default::default()
        };

        let index =
            Index::new(&options).map_err(|e| anyhow::anyhow!("Failed to create Index: {:?}", e))?;
        index
            .reserve(1000)
            .map_err(|e| anyhow::anyhow!("Failed to reserve initial capacity: {:?}", e))?;

        let mut instance = Self { index, path };
        if instance.path.exists() {
            info!("Loading existing vector index from {:?}", instance.path);
            instance.load()?;
        } else {
            info!("Creating new vector index at {:?}", instance.path);
            if let Some(parent) = instance.path.parent() {
                fs::create_dir_all(parent)?;
            }
            instance.save()?;
        }

        Ok(instance)
    }

    pub fn add(&self, id: u64, vector: &[f32]) -> Result<(), Error> {
        let size = self.index.size();
        let capacity = self.index.capacity();
        if size >= capacity {
            self.index
                .reserve(capacity + 1000)
                .map_err(|e| anyhow::anyhow!("Failed to expand capacity: {:?}", e))?;
        }
        self.index
            .add(id, vector)
            .map_err(|e| anyhow::anyhow!("Failed to add vector: {:?}", e))?;
        self.save()?;
        Ok(())
    }

    pub fn search(&self, query: &[f32], limit: usize) -> Result<Vec<(u64, f32)>, Error> {
        let results = self
            .index
            .search(query, limit)
            .map_err(|e| anyhow::anyhow!("Search failed: {:?}", e))?;

        let mut matches = Vec::new();
        for i in 0..results.keys.len() {
            matches.push((results.keys[i], results.distances[i]));
        }
        Ok(matches)
    }

    pub fn save(&self) -> Result<(), Error> {
        let path_str = self.path.to_str().context("Invalid index path string")?;
        self.index
            .save(path_str)
            .map_err(|e| anyhow::anyhow!("Failed to save index: {:?}", e))?;
        Ok(())
    }

    pub fn load(&mut self) -> Result<(), Error> {
        let path_str = self.path.to_str().context("Invalid index path string")?;
        self.index
            .load(path_str)
            .map_err(|e| anyhow::anyhow!("Failed to load index: {:?}", e))?;
        Ok(())
    }

    pub fn clear(&self) -> Result<(), Error> {
        self.index
            .reset()
            .map_err(|e| anyhow::anyhow!("Failed to reset index: {:?}", e))?;
        self.index
            .reserve(1000)
            .map_err(|e| anyhow::anyhow!("Failed to reserve capacity: {:?}", e))?;
        if self.path.exists() {
            let _ = fs::remove_file(&self.path);
        }
        let path_str = self.path.to_str().context("Invalid index path string")?;
        self.index
            .save(path_str)
            .map_err(|e| anyhow::anyhow!("Failed to save cleared index: {:?}", e))?;
        Ok(())
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub struct ModelManager {
    model_dir: PathBuf,
    device: Mutex<DevicePreference>,
    active_model: Mutex<EmbeddingModel>,
    vision_session: Mutex<Option<Session>>,
    text_session: Mutex<Option<Session>>,
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
        self.vision_session.lock().unwrap().is_some() && self.text_session.lock().unwrap().is_some()
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
            *vs = None;
            *ts = None;
            *tok = None;
        }
    }

    /// Ensure both ONNX sessions and tokenizer are loaded. Idempotent.
    fn ensure_loaded(&self) -> Result<(), Error> {
        // Fast path: already loaded
        if self.tokenizer.lock().unwrap().is_some()
            && self.vision_session.lock().unwrap().is_some()
            && self.text_session.lock().unwrap().is_some()
        {
            return Ok(());
        }

        // Slow path: load everything
        let active = self.active_model();
        let (tokenizer_path, vision_path, text_path) = match active {
            EmbeddingModel::ClipVitB32 => (
                self.model_dir.join("tokenizer.json"),
                self.model_dir.join("vision_model.onnx"),
                self.model_dir.join("text_model.onnx"),
            ),
            EmbeddingModel::MobileClipS2 => (
                self.model_dir.join("mobileclip_s2").join("tokenizer.json"),
                self.model_dir
                    .join("mobileclip_s2")
                    .join("onnx")
                    .join("vision_model.onnx"),
                self.model_dir
                    .join("mobileclip_s2")
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
                let mut builder = Session::builder()
                    .map_err(|e| anyhow::anyhow!("Failed to build vision session: {:?}", e))?
                    .with_intra_threads(1)
                    .map_err(|e| anyhow::anyhow!("Failed to set vision threads: {:?}", e))?;
                apply_device_preference(&mut builder, &device, "CLIP Vision");
                *vs =
                    Some(builder.commit_from_file(&vision_path).map_err(|e| {
                        anyhow::anyhow!("Failed to commit vision session: {:?}", e)
                    })?);
            }
        }

        // Text session
        {
            let mut ts = self.text_session.lock().unwrap();
            if ts.is_none() {
                info!("Loading ONNX Text Session from {:?}", text_path);
                let mut builder = Session::builder()
                    .map_err(|e| anyhow::anyhow!("Failed to build text session: {:?}", e))?
                    .with_intra_threads(1)
                    .map_err(|e| anyhow::anyhow!("Failed to set text threads: {:?}", e))?;
                apply_device_preference(&mut builder, &device, "CLIP Text");
                *ts = Some(
                    builder
                        .commit_from_file(&text_path)
                        .map_err(|e| anyhow::anyhow!("Failed to commit text session: {:?}", e))?,
                );
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
        match active {
            EmbeddingModel::ClipVitB32 => {
                let vision_path = self.model_dir.join("vision_model.onnx");
                let text_path = self.model_dir.join("text_model.onnx");
                let tokenizer_path = self.model_dir.join("tokenizer.json");

                self.download_if_missing(
                    &vision_path,
                    "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model.onnx",
                    "Vision model"
                )?;

                self.download_if_missing(
                    &text_path,
                    "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/text_model.onnx",
                    "Text model"
                )?;

                self.download_if_missing(
                    &tokenizer_path,
                    "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/tokenizer.json",
                    "Tokenizer configuration"
                )?;
            }
            EmbeddingModel::MobileClipS2 => {
                let s2_dir = self.model_dir.join("mobileclip_s2");
                let onnx_dir = s2_dir.join("onnx");
                fs::create_dir_all(&onnx_dir)?;

                let vision_path = onnx_dir.join("vision_model.onnx");
                let text_path = onnx_dir.join("text_model.onnx");
                let tokenizer_path = s2_dir.join("tokenizer.json");

                self.download_if_missing(
                    &vision_path,
                    "https://huggingface.co/Xenova/mobileclip_s2/resolve/main/onnx/vision_model.onnx",
                    "Vision model"
                )?;

                self.download_if_missing(
                    &text_path,
                    "https://huggingface.co/Xenova/mobileclip_s2/resolve/main/onnx/text_model.onnx",
                    "Text model",
                )?;

                self.download_if_missing(
                    &tokenizer_path,
                    "https://huggingface.co/Xenova/mobileclip_s2/resolve/main/tokenizer.json",
                    "Tokenizer configuration",
                )?;
            }
        }

        info!("{:?} models initialized", active);
        Ok(())
    }

    fn download_if_missing(&self, path: &Path, url: &str, name: &str) -> Result<(), Error> {
        if path.exists() {
            return Ok(());
        }

        info!("Downloading {} from {} to {:?}", name, url, path);
        let agent = ureq::Agent::new_with_defaults();
        let mut response = agent
            .get(url)
            .call()
            .context("Failed to contact download server")?;

        let mut reader = response.body_mut().as_reader();
        let mut file = fs::File::create(path)?;
        std::io::copy(&mut reader, &mut file)?;
        info!("Successfully downloaded {}.", name);

        Ok(())
    }

    fn generate_image_embedding_inner(&self, image_path: &Path) -> Result<Vec<f32>, Error> {
        self.ensure_loaded()?;
        self.last_used.store(now_secs(), Ordering::Relaxed);
        let mut session_guard = self
            .vision_session
            .lock()
            .map_err(|_| anyhow::anyhow!("Vision mutex poisoned"))?;
        let _session = session_guard
            .as_mut()
            .context("Vision model not initialized")?;

        // 1. Decode image — turbojpeg for JPEG, png+zlib-rs for PNG, image crate for others
        let img_ref = image_path;
        let data = std::fs::read(img_ref)?;
        let is_jpeg = data.len() >= 2 && data[0] == 0xFF && data[1] == 0xD8;
        let is_png = data.len() >= 8 && data[0..8] == [137, 80, 78, 71, 13, 10, 26, 10];

        let (rgb_buf, width, height) = if is_jpeg {
            let image = turbojpeg::decompress(&data, turbojpeg::PixelFormat::RGB)?;
            (
                image.pixels.to_vec(),
                image.width as u32,
                image.height as u32,
            )
        } else if is_png {
            let decoder = png::Decoder::new(std::io::Cursor::new(&data));
            let mut reader = decoder.read_info()?;
            let w = reader.info().width;
            let h = reader.info().height;
            // Always allocate w*h*4 (max RGBA) — output_buffer_size() can underreport
            // for interlaced or palette-based PNGs, causing "Size of buffer is smaller
            // than required" on next_frame().
            let buf_size = w as usize * h as usize * 4;
            let mut raw = vec![0u8; buf_size];
            let out_info = reader.next_frame(&mut raw)?;
            let pixels = out_info.buffer_size();
            let rgb: Vec<u8> = match out_info.color_type {
                png::ColorType::Rgb => raw[..pixels].to_vec(),
                png::ColorType::Rgba => raw[..pixels]
                    .chunks(4)
                    .flat_map(|c| [c[0], c[1], c[2]])
                    .collect(),
                png::ColorType::Grayscale => {
                    raw[..pixels].iter().flat_map(|&g| [g, g, g]).collect()
                }
                png::ColorType::GrayscaleAlpha => raw[..pixels]
                    .chunks(2)
                    .flat_map(|c| [c[0], c[0], c[0]])
                    .collect(),
                png::ColorType::Indexed => {
                    let palette = reader
                        .info()
                        .palette
                        .as_deref()
                        .context("Indexed PNG has no palette")?;
                    raw[..pixels]
                        .iter()
                        .flat_map(|&idx| {
                            let i = idx as usize * 3;
                            [palette[i], palette[i + 1], palette[i + 2]]
                        })
                        .collect()
                }
            };
            (rgb, w, h)
        } else {
            let img = image::open(img_ref)?;
            let rgb = img.to_rgb8();
            let (w, h) = rgb.dimensions();
            (rgb.into_raw(), w, h)
        };

        // 2. Center crop to square
        let size = width.min(height);
        let cx = (width - size) / 2;
        let cy = (height - size) / 2;
        let mut cropped = vec![0u8; (size * size * 3) as usize];
        for y in 0..size {
            let src_row = ((cy + y) * width + cx) as usize * 3;
            let dst_row = (y * size) as usize * 3;
            let copy_len = (size * 3) as usize;
            cropped[dst_row..dst_row + copy_len]
                .copy_from_slice(&rgb_buf[src_row..src_row + copy_len]);
        }

        // 3. SIMD-accelerated resize to target size
        let active = self.active_model();
        let target_size = match active {
            EmbeddingModel::ClipVitB32 => 224,
            EmbeddingModel::MobileClipS2 => 256,
        };

        let crop_ref = fast_image_resize::images::ImageRef::new(
            size,
            size,
            &cropped,
            fast_image_resize::PixelType::U8x3,
        )?;
        let mut dst_image = fast_image_resize::images::Image::from_vec_u8(
            target_size,
            target_size,
            vec![0u8; (target_size * target_size * 3) as usize],
            fast_image_resize::PixelType::U8x3,
        )?;
        let mut resizer = fast_image_resize::Resizer::new();
        let opts = fast_image_resize::ResizeOptions::new().resize_alg(
            fast_image_resize::ResizeAlg::Convolution(fast_image_resize::FilterType::Bilinear),
        );
        resizer.resize(&crop_ref, &mut dst_image, Some(&opts))?;
        let resized_buf = dst_image.buffer();

        // 4. Construct N-dimensional array in shape [1, 3, target_size, target_size]
        let mut input_array =
            Array4::<f32>::zeros((1, 3, target_size as usize, target_size as usize));
        match active {
            EmbeddingModel::ClipVitB32 => {
                let mean = [0.48145466, 0.4578275, 0.40821073];
                let std = [0.26862954, 0.261_302_6, 0.275_777_1];
                for c in 0..3 {
                    for row in 0..224 {
                        for col in 0..224 {
                            let val = resized_buf[(row * 224 + col) * 3 + c] as f32 / 255.0;
                            input_array[[0, c, row, col]] = (val - mean[c]) / std[c];
                        }
                    }
                }
            }
            EmbeddingModel::MobileClipS2 => {
                for c in 0..3 {
                    for row in 0..256 {
                        for col in 0..256 {
                            let val = resized_buf[(row * 256 + col) * 3 + c] as f32 / 255.0;
                            input_array[[0, c, row, col]] = val;
                        }
                    }
                }
            }
        }

        // 5. Run inference
        let session = session_guard
            .as_mut()
            .context("Vision model not initialized")?;
        let outputs = session.run(inputs![TensorRef::from_array_view(&input_array)?])?;

        let output_tensor = outputs
            .get("image_embeds")
            .or_else(|| outputs.get("output_0"))
            .context("Failed to get image embeds output from model")?;

        let output_ref = output_tensor.try_extract_tensor::<f32>()?;

        let mut embedding = output_ref.1.to_vec();
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

        // Preprocess all images in parallel.
        let mut preprocessed = Vec::with_capacity(image_paths.len());
        for _ in 0..image_paths.len() {
            preprocessed.push(Err(anyhow::anyhow!("Initialization failed")));
        }

        std::thread::scope(|s| {
            let mut handles = Vec::with_capacity(image_paths.len());
            for (idx, path) in image_paths.iter().enumerate() {
                let path_ref = path.as_ref();
                let handle = s.spawn(move || -> Result<Vec<u8>, Error> {
                    let img_ref = path_ref;
                    let data = std::fs::read(img_ref)?;
                    let is_jpeg = data.len() >= 2 && data[0] == 0xFF && data[1] == 0xD8;
                    let is_png = data.len() >= 8 && data[0..8] == [137, 80, 78, 71, 13, 10, 26, 10];

                    let (rgb_buf, width, height) = if is_jpeg {
                        let image = turbojpeg::decompress(&data, turbojpeg::PixelFormat::RGB)?;
                        (
                            image.pixels.to_vec(),
                            image.width as u32,
                            image.height as u32,
                        )
                    } else if is_png {
                        let decoder = png::Decoder::new(std::io::Cursor::new(&data));
                        let mut reader = decoder.read_info()?;
                        let w = reader.info().width;
                        let h = reader.info().height;
                        let buf_size = w as usize * h as usize * 4;
                        let mut raw = vec![0u8; buf_size];
                        let out_info = reader.next_frame(&mut raw)?;
                        let pixels = out_info.buffer_size();
                        let rgb: Vec<u8> = match out_info.color_type {
                            png::ColorType::Rgb => raw[..pixels].to_vec(),
                            png::ColorType::Rgba => raw[..pixels]
                                .chunks(4)
                                .flat_map(|c| [c[0], c[1], c[2]])
                                .collect(),
                            png::ColorType::Grayscale => {
                                raw[..pixels].iter().flat_map(|&g| [g, g, g]).collect()
                            }
                            png::ColorType::GrayscaleAlpha => raw[..pixels]
                                .chunks(2)
                                .flat_map(|c| [c[0], c[0], c[0]])
                                .collect(),
                            png::ColorType::Indexed => {
                                let palette = reader
                                    .info()
                                    .palette
                                    .as_deref()
                                    .context("Indexed PNG has no palette")?;
                                raw[..pixels]
                                    .iter()
                                    .flat_map(|&idx| {
                                        let i = idx as usize * 3;
                                        [palette[i], palette[i + 1], palette[i + 2]]
                                    })
                                    .collect()
                            }
                        };
                        (rgb, w, h)
                    } else {
                        let img = image::open(img_ref)?;
                        let rgb = img.to_rgb8();
                        let (w, h) = rgb.dimensions();
                        (rgb.into_raw(), w, h)
                    };

                    let size = width.min(height);
                    let cx = (width - size) / 2;
                    let cy = (height - size) / 2;
                    let mut cropped = vec![0u8; (size * size * 3) as usize];
                    for y in 0..size {
                        let src_row = ((cy + y) * width + cx) as usize * 3;
                        let dst_row = (y * size) as usize * 3;
                        let copy_len = (size * 3) as usize;
                        cropped[dst_row..dst_row + copy_len]
                            .copy_from_slice(&rgb_buf[src_row..src_row + copy_len]);
                    }

                    let crop_ref = fast_image_resize::images::ImageRef::new(
                        size,
                        size,
                        &cropped,
                        fast_image_resize::PixelType::U8x3,
                    )?;
                    let mut dst_image = fast_image_resize::images::Image::from_vec_u8(
                        target_size,
                        target_size,
                        vec![0u8; (target_size * target_size * 3) as usize],
                        fast_image_resize::PixelType::U8x3,
                    )?;
                    let mut resizer = fast_image_resize::Resizer::new();
                    let opts = fast_image_resize::ResizeOptions::new().resize_alg(
                        fast_image_resize::ResizeAlg::Convolution(
                            fast_image_resize::FilterType::Bilinear,
                        ),
                    );
                    resizer.resize(&crop_ref, &mut dst_image, Some(&opts))?;
                    Ok(dst_image.buffer().to_vec())
                });
                handles.push((idx, handle));
            }

            for (idx, handle) in handles {
                preprocessed[idx] = handle
                    .join()
                    .unwrap_or_else(|_| Err(anyhow::anyhow!("Thread panicked")));
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
        let mut session_guard = self
            .vision_session
            .lock()
            .map_err(|_| anyhow::anyhow!("Vision mutex poisoned"))?;

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
            if let Ok(ref resized_buf) = preprocessed[orig_idx] {
                match active {
                    EmbeddingModel::ClipVitB32 => {
                        let mean = [0.48145466, 0.4578275, 0.40821073];
                        let std = [0.26862954, 0.261_302_6, 0.275_777_1];
                        for c in 0..3 {
                            for row in 0..224 {
                                for col in 0..224 {
                                    let val = resized_buf[(row * 224 + col) * 3 + c] as f32 / 255.0;
                                    input_array[[batch_idx, c, row, col]] =
                                        (val - mean[c]) / std[c];
                                }
                            }
                        }
                    }
                    EmbeddingModel::MobileClipS2 => {
                        for c in 0..3 {
                            for row in 0..256 {
                                for col in 0..256 {
                                    let val = resized_buf[(row * 256 + col) * 3 + c] as f32 / 255.0;
                                    input_array[[batch_idx, c, row, col]] = val;
                                }
                            }
                        }
                    }
                }
            }
        }

        let session = session_guard
            .as_mut()
            .context("Vision model not initialized")?;
        let outputs = session.run(inputs![TensorRef::from_array_view(&input_array)?])?;

        let output_tensor = outputs
            .get("image_embeds")
            .or_else(|| outputs.get("output_0"))
            .context("Failed to get image embeds output from model")?;

        let output_ref = output_tensor.try_extract_tensor::<f32>()?;
        let flat_outputs = output_ref.1;

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
        let mut session_guard = self
            .text_session
            .lock()
            .map_err(|_| anyhow::anyhow!("Text mutex poisoned"))?;
        let _session = session_guard
            .as_mut()
            .context("Text model not initialized")?;
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

        let session = session_guard
            .as_mut()
            .context("Text model not initialized")?;
        let outputs = session.run(inputs![
            "input_ids" => TensorRef::from_array_view(&input_ids_array)?
        ])?;

        let output_tensor = outputs
            .get("text_embeds")
            .or_else(|| outputs.get("output_0"))
            .context("Failed to get text embeds output from model")?;

        let output_ref = output_tensor.try_extract_tensor::<f32>()?;

        let mut embedding = output_ref.1.to_vec();
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

/// Apply GPU/CPU device preference to an ONNX session builder.
pub fn apply_device_preference(
    builder: &mut SessionBuilder,
    device: &DevicePreference,
    model_name: &str,
) {
    match device {
        DevicePreference::Cpu => {
            info!(
                "{}: forced to CPU — skipping GPU execution providers",
                model_name
            );
        }
        DevicePreference::Gpu => {
            let mut registered = false;
            #[cfg(target_os = "windows")]
            {
                if let Ok(b) = builder
                    .clone()
                    .with_execution_providers([ort::ep::DirectML::default().build()])
                {
                    *builder = b;
                    registered = true;
                    info!("{}: using DirectML (GPU)", model_name);
                }
            }
            #[cfg(target_os = "macos")]
            {
                if let Ok(b) = builder
                    .clone()
                    .with_execution_providers([ort::ep::CoreML::default().build()])
                {
                    *builder = b;
                    registered = true;
                    info!("{}: using CoreML (GPU)", model_name);
                }
            }
            #[cfg(target_os = "linux")]
            {
                if let Ok(b) = builder
                    .clone()
                    .with_execution_providers([ort::ep::CUDA::default().build()])
                {
                    *builder = b;
                    registered = true;
                    info!("{}: using CUDA (GPU)", model_name);
                } else if let Ok(b) = builder
                    .clone()
                    .with_execution_providers([ort::ep::ROCm::default().build()])
                {
                    *builder = b;
                    registered = true;
                    info!("{}: using ROCm (GPU)", model_name);
                }
            }
            if !registered {
                warn!(
                    "{}: GPU requested but no provider available — falling back to CPU",
                    model_name
                );
            }
        }
        DevicePreference::Auto => {
            #[cfg(target_os = "windows")]
            {
                if let Ok(b) = builder
                    .clone()
                    .with_execution_providers([ort::ep::DirectML::default().build()])
                {
                    *builder = b;
                    info!("{}: auto-selected DirectML (GPU)", model_name);
                }
            }
            #[cfg(target_os = "macos")]
            {
                if let Ok(b) = builder
                    .clone()
                    .with_execution_providers([ort::ep::CoreML::default().build()])
                {
                    *builder = b;
                    info!("{}: auto-selected CoreML (GPU)", model_name);
                }
            }
            #[cfg(target_os = "linux")]
            {
                if let Ok(b) = builder
                    .clone()
                    .with_execution_providers([ort::ep::CUDA::default().build()])
                {
                    *builder = b;
                    info!("{}: auto-selected CUDA (GPU)", model_name);
                } else if let Ok(b) = builder
                    .clone()
                    .with_execution_providers([ort::ep::ROCm::default().build()])
                {
                    *builder = b;
                    info!("{}: auto-selected ROCm (GPU)", model_name);
                }
            }
        }
    }
}

/// Compute a 64-bit Average Perceptual Hash (aHash) for an image.
pub fn compute_ahash<P: AsRef<Path>>(image_path: P) -> Result<String, Error> {
    let img = image::open(image_path.as_ref())?;
    let resized = img
        .resize_exact(8, 8, image::imageops::FilterType::Nearest)
        .to_luma8();
    let pixels = resized.as_raw();
    let sum: u64 = pixels.iter().map(|&p| p as u64).sum();
    let avg = (sum / 64) as u8;
    let mut hash: u64 = 0;
    for (i, &p) in pixels.iter().enumerate() {
        if p >= avg {
            hash |= 1 << i;
        }
    }
    Ok(format!("{:016x}", hash))
}
