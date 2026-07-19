use anyhow::{Context, Error};
use image::{imageops::FilterType, GenericImageView};
use ndarray::{Array2, Array4};
use ort::{inputs, session::Session, value::TensorRef};
use std::fs;
use std::path::{Path, PathBuf};
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
        let mut options = IndexOptions::default();
        options.dimensions = dimensions;
        options.metric = MetricKind::Cos;
        options.quantization = ScalarKind::F32;

        let index = Index::new(&options).map_err(|e| anyhow::anyhow!("Failed to create Index: {:?}", e))?;
        index.reserve(1000).map_err(|e| anyhow::anyhow!("Failed to reserve initial capacity: {:?}", e))?;

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
            self.index.reserve(capacity + 1000).map_err(|e| anyhow::anyhow!("Failed to expand capacity: {:?}", e))?;
        }
        self.index.add(id, vector).map_err(|e| anyhow::anyhow!("Failed to add vector: {:?}", e))?;
        self.save()?;
        Ok(())
    }

    pub fn search(&self, query: &[f32], limit: usize) -> Result<Vec<(u64, f32)>, Error> {
        let results = self.index.search(query, limit).map_err(|e| anyhow::anyhow!("Search failed: {:?}", e))?;
        
        let mut matches = Vec::new();
        for i in 0..results.keys.len() {
            matches.push((results.keys[i], results.distances[i]));
        }
        Ok(matches)
    }

    pub fn save(&self) -> Result<(), Error> {
        let path_str = self.path.to_str().context("Invalid index path string")?;
        self.index.save(path_str).map_err(|e| anyhow::anyhow!("Failed to save index: {:?}", e))?;
        Ok(())
    }

    pub fn load(&mut self) -> Result<(), Error> {
        let path_str = self.path.to_str().context("Invalid index path string")?;
        self.index.load(path_str).map_err(|e| anyhow::anyhow!("Failed to load index: {:?}", e))?;
        Ok(())
    }
}

pub struct ModelManager {
    model_dir: PathBuf,
    vision_session: Option<std::sync::Mutex<Session>>,
    text_session: Option<std::sync::Mutex<Session>>,
    tokenizer: Option<Tokenizer>,
}

impl ModelManager {
    pub fn new<P: AsRef<Path>>(model_dir: P) -> Self {
        Self {
            model_dir: model_dir.as_ref().to_path_buf(),
            vision_session: None,
            text_session: None,
            tokenizer: None,
        }
    }

    pub fn model_dir(&self) -> &Path {
        &self.model_dir
    }

    pub fn init(&mut self) -> Result<(), Error> {
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

        let vision_path = self.model_dir.join("vision_model.onnx");
        let text_path = self.model_dir.join("text_model.onnx");
        let tokenizer_path = self.model_dir.join("tokenizer.json");

        // Download missing files
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

        // Initialize sessions
        info!("Loading ONNX Vision Session from {:?}", vision_path);
        let mut vision_builder = Session::builder()
            .map_err(|e| anyhow::anyhow!("Failed to build vision session: {:?}", e))?
            .with_intra_threads(1)
            .map_err(|e| anyhow::anyhow!("Failed to set vision threads: {:?}", e))?;

        #[cfg(target_os = "windows")]
        {
            if let Ok(b) = vision_builder.clone().with_execution_providers([ort::ep::DirectML::default().build()]) {
                vision_builder = b;
            }
        }
        #[cfg(target_os = "macos")]
        {
            if let Ok(b) = vision_builder.clone().with_execution_providers([ort::ep::CoreML::default().build()]) {
                vision_builder = b;
            }
        }
        #[cfg(target_os = "linux")]
        {
            if let Ok(b) = vision_builder.clone().with_execution_providers([ort::ep::CUDA::default().build()]) {
                vision_builder = b;
            }
            if let Ok(b) = vision_builder.clone().with_execution_providers([ort::ep::ROCm::default().build()]) {
                vision_builder = b;
            }
        }

        let vision_session = vision_builder
            .commit_from_file(&vision_path)
            .map_err(|e| anyhow::anyhow!("Failed to commit vision session: {:?}", e))?;

        info!("Loading ONNX Text Session from {:?}", text_path);
        let mut text_builder = Session::builder()
            .map_err(|e| anyhow::anyhow!("Failed to build text session: {:?}", e))?
            .with_intra_threads(1)
            .map_err(|e| anyhow::anyhow!("Failed to set text threads: {:?}", e))?;

        #[cfg(target_os = "windows")]
        {
            if let Ok(b) = text_builder.clone().with_execution_providers([ort::ep::DirectML::default().build()]) {
                text_builder = b;
            }
        }
        #[cfg(target_os = "macos")]
        {
            if let Ok(b) = text_builder.clone().with_execution_providers([ort::ep::CoreML::default().build()]) {
                text_builder = b;
            }
        }
        #[cfg(target_os = "linux")]
        {
            if let Ok(b) = text_builder.clone().with_execution_providers([ort::ep::CUDA::default().build()]) {
                text_builder = b;
            }
            if let Ok(b) = text_builder.clone().with_execution_providers([ort::ep::ROCm::default().build()]) {
                text_builder = b;
            }
        }

        let text_session = text_builder
            .commit_from_file(&text_path)
            .map_err(|e| anyhow::anyhow!("Failed to commit text session: {:?}", e))?;

        info!("Loading Tokenizer from {:?}", tokenizer_path);
        let tokenizer = Tokenizer::from_file(&tokenizer_path)
            .map_err(|e| anyhow::anyhow!("Failed to parse tokenizer.json: {:?}", e))?;

        self.vision_session = Some(std::sync::Mutex::new(vision_session));
        self.text_session = Some(std::sync::Mutex::new(text_session));
        self.tokenizer = Some(tokenizer);

        Ok(())
    }

    fn download_if_missing(&self, path: &Path, url: &str, name: &str) -> Result<(), Error> {
        if path.exists() {
            return Ok(());
        }

        info!("Downloading {} from {} to {:?}", name, url, path);
        // Call ureq using its standard API.
        // In ureq 3.x, the API is ureq::get(url).call()
        let agent = ureq::Agent::new_with_defaults();
        let mut response = agent.get(url)
            .call()
            .context("Failed to contact download server")?;

        let mut reader = response.body_mut().as_reader();
        let mut file = fs::File::create(path)?;
        std::io::copy(&mut reader, &mut file)?;
        info!("Successfully downloaded {}.", name);

        Ok(())
    }

    pub fn generate_image_embedding<P: AsRef<Path>>(&self, image_path: P) -> Result<Vec<f32>, Error> {
        let mut session_guard = self.vision_session.as_ref()
            .context("Vision model not initialized")?
            .lock()
            .map_err(|_| anyhow::anyhow!("Vision mutex poisoned"))?;
        
        // 1. Load image and convert to RGB
        let img = image::open(image_path)?;
        let (width, height) = img.dimensions();
        let rgb_img = img.to_rgb8();

        // 2. Center crop and resize to 224x224
        let size = width.min(height);
        let x = (width - size) / 2;
        let y = (height - size) / 2;
        let cropped = image::imageops::crop_imm(&rgb_img, x, y, size, size).to_image();
        let resized = image::imageops::resize(&cropped, 224, 224, FilterType::Triangle);

        // 3. Normalization parameters for CLIP
        let mean = [0.48145466, 0.4578275, 0.40821073];
        let std = [0.26862954, 0.26130258, 0.27577711];

        // 4. Construct N-dimensional array in shape [1, 3, 224, 224]
        let mut input_array = Array4::<f32>::zeros((1, 3, 224, 224));
        for c in 0..3 {
            for row in 0..224 {
                for col in 0..224 {
                    let pixel = resized.get_pixel(col, row);
                    let val = pixel[c] as f32 / 255.0;
                    input_array[[0, c, row as usize, col as usize]] = (val - mean[c]) / std[c];
                }
            }
        }

        // 5. Run inference
        let outputs = session_guard.run(inputs![TensorRef::from_array_view(&input_array)?])?;
        
        // Output from Xenova vision model is usually named "image_embeds" or is the first output
        let output_tensor = outputs.get("image_embeds")
            .or_else(|| outputs.get("output_0"))
            .context("Failed to get image embeds output from model")?;

        let output_ref = output_tensor.try_extract_tensor::<f32>()?;
        
        // Normalize the vector (L2 norm) to ensure cosine distance matches dot product
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
        let mut session_guard = self.text_session.as_ref()
            .context("Text model not initialized")?
            .lock()
            .map_err(|_| anyhow::anyhow!("Text mutex poisoned"))?;
        let tokenizer = self.tokenizer.as_ref().context("Tokenizer not initialized")?;

        // 1. Tokenize query
        let encoding = tokenizer.encode(text, true)
            .map_err(|e| anyhow::anyhow!("Tokenization failed: {:?}", e))?;
        
        let input_ids = encoding.get_ids();
        let seq_len = input_ids.len();

        // 2. Prepare tensors
        let input_ids_array = Array2::<i64>::from_shape_fn((1, seq_len), |(_, j)| input_ids[j] as i64);

        // 3. Run inference
        let outputs = session_guard.run(inputs![
            "input_ids" => TensorRef::from_array_view(&input_ids_array)?
        ])?;

        // Output name is "text_embeds"
        let output_tensor = outputs.get("text_embeds")
            .or_else(|| outputs.get("output_0"))
            .context("Failed to get text embeds output from model")?;

        let output_ref = output_tensor.try_extract_tensor::<f32>()?;
        
        // Normalize vector (L2 norm)
        let mut embedding = output_ref.1.to_vec();
        let norm = (embedding.iter().map(|&x| x * x).sum::<f32>()).sqrt();
        if norm > 0.0 {
            for val in &mut embedding {
                *val /= norm;
            }
        }

        Ok(embedding)
    }
}
