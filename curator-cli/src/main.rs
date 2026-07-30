use anyhow::{Context, Error};
use clap::{Parser, Subcommand};
use curator_core::ipc::{EmbeddingModel, ImageDetails, Request, Response};
use std::fs;
use std::path::PathBuf;


#[derive(Parser, Debug)]
#[command(author, version, about = "Command line client for Project Curator", long_about = None)]
struct Cli {
    #[arg(short, long, default_value = ".curator")]
    data_dir: String,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Ping the Curator Service
    Ping,
    /// Get database and worker queue status
    Status,
    /// Import an image file or directory
    Import {
        /// Absolute path to the image file or folder
        path: String,
    },
    /// Manage tags on images
    Tag {
        #[command(subcommand)]
        action: TagCommands,
    },
    /// Search for images using semantic query or tags
    Search {
        /// Text phrase for CLIP semantic search
        query: Option<String>,

        /// Path to an image file for reverse search
        #[arg(short, long)]
        image: Option<String>,

        /// Exact tag name to filter by
        #[arg(short, long)]
        tag: Option<String>,

        /// Limit the number of search results
        #[arg(short, long, default_value_t = 10)]
        limit: usize,
    },
    /// List all imported images
    List {
        #[arg(short, long, default_value_t = 50)]
        limit: usize,

        #[arg(short, long, default_value_t = 0)]
        offset: usize,
    },
    /// Get details of a specific image
    Show { image_id: i64 },
    /// Validate a plugin's manifest.json file
    ValidatePlugin { manifest_path: String },
    /// Auto-tag a single image with Camie Tagger v2
    TagAuto {
        /// ID of the image to tag
        image_id: i64,

        /// Confidence threshold (0.0–1.0).
        /// 0.50 = balanced (default), 0.65 = high precision, 0.35 = high recall
        #[arg(short, long)]
        threshold: Option<f32>,

        /// Wipe existing AI tags before running
        #[arg(short, long)]
        force: bool,
    },
    /// Auto-tag all images in the library that don't already have AI tags
    TagAutoBatch {
        /// Confidence threshold. Defaults to 0.50 (balanced).
        #[arg(short, long)]
        threshold: Option<f32>,

        /// Wipe existing AI tags before running
        #[arg(short, long)]
        force: bool,

        /// Optional list of specific image IDs (space-separated). If omitted, tags all untagged images.
        image_ids: Vec<i64>,
    },
    /// Show the current status of the Camie Tagger model
    TaggerStatus,
    /// Run CPU vs GPU ONNX model benchmark
    Benchmark {
        /// Embedding model to benchmark ('clip-vit-b-32' or 'mobileclip-s2')
        #[arg(short, long, default_value = "clip-vit-b-32")]
        model: String,
    },
}

#[derive(Subcommand, Debug)]
enum TagCommands {
    /// Add a tag to an image
    Add {
        image_id: i64,
        tag: String,
        #[arg(short, long, default_value = "user")]
        category: String,
    },
    /// Remove a tag from an image (soft-delete)
    Remove { image_id: i64, tag: String },
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    let cli = Cli::parse();
    let data_dir = PathBuf::from(&cli.data_dir);

    // 1. Read Service Key from local data directory
    let key_file = data_dir.join("service.key");
    if !key_file.exists() {
        return Err(anyhow::anyhow!(
            "Service key file not found at {:?}. Is the Curator Service running?",
            key_file
        ));
    }
    let _token = fs::read_to_string(&key_file)
        .context("Failed to read service key file")?
        .trim()
        .to_string();


    // 2. Map CLI command to IPC Request
    let request = match cli.command {
        Commands::Ping => Request::Ping,
        Commands::Status => Request::GetStatus,
        Commands::Import { path } => Request::ImportImage { path },
        Commands::Tag { action } => match action {
            TagCommands::Add {
                image_id,
                tag,
                category,
            } => Request::AddTag {
                image_id,
                tag,
                category,
            },
            TagCommands::Remove { image_id, tag } => Request::RemoveTag { image_id, tag },
        },
        Commands::Search {
            query,
            image,
            tag,
            limit,
        } => Request::Search {
            query_text: query,
            query_image_path: image,
            tag_filter: tag,
            parse_filter: None,
            parse_type: None,
            concept_id: None,
            character_identity_id: None,
            filename_filter: None,
            limit,
        },
        Commands::List { limit, offset } => Request::ListImages {
            limit,
            offset,
            only_favorites: None,
        },
        Commands::Show { image_id } => Request::GetImage { image_id },
        Commands::ValidatePlugin { manifest_path } => Request::ValidatePlugin { manifest_path },
        Commands::TagAuto {
            image_id,
            threshold,
            force,
        } => Request::TagImage {
            image_id,
            threshold,
            force: Some(force),
        },
        Commands::TagAutoBatch {
            threshold,
            force,
            image_ids,
        } => {
            if image_ids.is_empty() {
                // Fetch all image IDs from the service first if no IDs provided.
                // For simplicity we use a large ListImages request.
                eprintln!(
                    "No image IDs provided; batch will tag ALL images. \
                     This may take a long time. Use Ctrl+C to cancel, \
                     or pass specific IDs: tag-auto-batch <id1> <id2> ..."
                );
                Request::TagImageBatch {
                    image_ids: vec![],
                    threshold,
                    force: Some(force),
                }
            } else {
                Request::TagImageBatch {
                    image_ids,
                    threshold,
                    force: Some(force),
                }
            }
        }
        Commands::TaggerStatus => Request::GetTaggerStatus,
        Commands::Benchmark { model } => {
            let emb_model = match model.as_str() {
                "mobileclip-s2" | "mobileclip_s2" => EmbeddingModel::MobileClipS2,
                _ => EmbeddingModel::ClipVitB32,
            };
            Request::RunBenchmark {
                embedding_model: emb_model,
            }
        }
    };

    // 3. Connect to Curator gRPC Service
    let channel = curator_core::ipc::grpc_helper::connect_ipc().await
        .context("Failed to connect to Curator Service. Is the service running?")?;
    let mut client = curator_core::grpc::curator_client::CuratorClient::new(channel);

    // 4. Send Request and Get Response
    let request_str = serde_json::to_string(&request)?;
    let grpc_req = curator_core::grpc::CuratorRequest {
        request_json: request_str,
    };
    let grpc_resp = client.call(grpc_req).await
        .context("gRPC request to Curator Service failed")?;
    let response_str = grpc_resp.into_inner().response_json;

    let response: Response = serde_json::from_str(&response_str).context(
        "Failed to parse response JSON from service.",
    )?;


    // 7. Format and Print Response
    match response {
        Response::Pong => println!("Pong! Curator Service is alive and healthy."),
        Response::Success => println!("Operation completed successfully."),
        Response::Error { message } => println!("Error: {}", message),
        Response::BenchmarkResult {
            clip_cpu_time_ms,
            clip_gpu_time_ms,
            clip_gpu_error,
            tagger_cpu_time_ms,
            tagger_gpu_time_ms,
            tagger_gpu_error,
            has_gpu,
        } => {
            println!("Benchmark Results:");
            println!("GPU Support: {}", if has_gpu { "Yes" } else { "No" });
            println!("\nCLIP Vision Model (224x224):");
            println!("  CPU: {:.2} ms/image", clip_cpu_time_ms);
            if let Some(gpu) = clip_gpu_time_ms {
                println!(
                    "  GPU: {:.2} ms/image ({:.2}x speedup)",
                    gpu,
                    clip_cpu_time_ms / gpu
                );
            } else {
                println!("  GPU: N/A");
            }
            if let Some(err) = clip_gpu_error {
                println!("  GPU Load Error: {}", err);
            }
            println!("\nCamie Tagger v2 Model (512x512):");
            if let Some(cpu) = tagger_cpu_time_ms {
                println!("  CPU: {:.2} ms/image", cpu);
                if let Some(gpu) = tagger_gpu_time_ms {
                    println!("  GPU: {:.2} ms/image ({:.2}x speedup)", gpu, cpu / gpu);
                } else {
                    println!("  GPU: N/A");
                }
            } else {
                println!("  CPU: N/A");
                println!("  GPU: N/A");
            }
            if let Some(err) = tagger_gpu_error {
                println!("  Tagger Error: {}", err);
            }
        }
        Response::ImportResult {
            image_id,
            sha256,
            imported_count,
            ..
        } => {
            println!("Successfully imported image/folder ({} item(s)):", imported_count);
            println!("  First Image ID: {}", image_id);
            println!("  SHA256:         {}", sha256);
            println!("  (Background job scheduled for vector embedding generation)");
        }
        Response::StatusResult {
            image_count,
            vector_count,
            pending_jobs,
            preprocessing_jobs,
        } => {
            println!("Curator Database Status:");
            println!("  Images Imported:      {}", image_count);
            println!("  Vectors Indexed:      {}", vector_count);
            println!("  Pending Job Queue:    {}", pending_jobs);
            println!("  Preprocessing Queue:  {}", preprocessing_jobs);
        }
        Response::SearchResult { matches } => {
            if matches.is_empty() {
                println!("No matching images found.");
            } else {
                println!("Search Results ({} matches):", matches.len());
                for (idx, m) in matches.iter().enumerate() {
                    let info_str = if let Some(dist) = m.hamming_distance {
                        format!(
                            "Match Type: {}, Hamming: {}, Score: {:.4}",
                            m.match_type, dist, m.score
                        )
                    } else {
                        format!("Match Type: {}, Score: {:.4}", m.match_type, m.score)
                    };
                    println!("{}. [ID: {}] {} ({})", idx + 1, m.id, m.filepath, info_str);
                    if !m.tags.is_empty() {
                        let tag_strs: Vec<String> = m
                            .tags
                            .iter()
                            .map(|t| format!("{}({})", t.tag, t.category))
                            .collect();
                        println!("    Tags: {}", tag_strs.join(", "));
                    }
                }
            }
        }
        Response::ListResult { images, .. } => {
            if images.is_empty() {
                println!("No images imported yet.");
            } else {
                println!("Imported Images (showing {} latest):", images.len());
                for img in images {
                    print_image_details(&img);
                }
            }
        }
        Response::ImageResult { image } => {
            print_image_details(&image);
        }
        Response::ValidationResult {
            name,
            version,
            valid,
            error,
        } => {
            if valid {
                println!("Plugin manifest is VALID!");
                println!("  Name:    {}", name);
                println!("  Version: {}", version);
            } else {
                println!("Plugin manifest is INVALID!");
                println!("  Error: {}", error.unwrap_or_default());
            }
        }
        Response::TagImageResult {
            image_id,
            tags_applied,
            skipped,
            tags,
        } => {
            if skipped {
                println!(
                    "Image {} already has AI tags — skipped (use --force to re-tag).",
                    image_id
                );
            } else {
                println!(
                    "Auto-tagged image {} — {} tags applied:",
                    image_id, tags_applied
                );
                for t in &tags {
                    println!(
                        "  [{:<12}] {:<40} ({:.2}%)",
                        t.category,
                        t.tag,
                        t.confidence * 100.0
                    );
                }
            }
        }
        Response::BatchTagResult {
            processed,
            failed,
            skipped,
        } => {
            println!("Batch auto-tag complete:");
            println!("  Tagged:  {}", processed);
            println!("  Skipped: {} (already had AI tags)", skipped);
            println!("  Failed:  {}", failed);
        }
        Response::TaggerStatusResult {
            loaded,
            model_path,
            total_tags,
        } => {
            println!("Camie Tagger v2 Status:");
            println!(
                "  Loaded:     {}",
                if loaded {
                    "Yes"
                } else {
                    "No (lazy — loads on first use)"
                }
            );
            println!("  Model path: {}", model_path);
            println!(
                "  Tag count:  {}",
                if total_tags > 0 {
                    total_tags.to_string()
                } else {
                    "N/A (not loaded)".to_string()
                }
            );
        }
        Response::SettingsResult {
            clip_device,
            tagger_device,
            idle_timeout_secs,
            embedding_model,
            detection_device,
            detection_metrics_device,
        } => {
            println!("Settings:");
            println!("  CLIP device:              {:?}", clip_device);
            println!("  Tagger device:            {:?}", tagger_device);
            println!("  Idle timeout:             {}s", idle_timeout_secs);
            println!("  Embedding model:          {:?}", embedding_model);
            println!("  Detection device:         {:?}", detection_device);
            println!("  Detection metrics device: {:?}", detection_metrics_device);
        }
        Response::PreprocessBenchmarkResult { report } => {
            println!("{}", report);
        }
        Response::TagStatisticsResult { .. } => {
            println!("Tag statistics retrieved.");
        }
        Response::DashboardInitResult { .. } => {
            println!("Dashboard init result received.");
        }
        other => {
            println!("Received response: {:?}", other);
        }
    }

    Ok(())
}

fn print_image_details(img: &ImageDetails) {
    println!("Image ID: {}", img.id);
    println!("  Path:    {}", img.current_filepath);
    println!("  SHA256:  {}", img.sha256);
    println!("  Indexed: {}", img.vector_state);
    if !img.tags.is_empty() {
        let tag_strs: Vec<String> = img
            .tags
            .iter()
            .map(|t| format!("{}({})", t.tag, t.category))
            .collect();
        println!("  Tags:    {}", tag_strs.join(", "));
    }
    println!("  Created: {}", img.created_at);
    println!();
}
