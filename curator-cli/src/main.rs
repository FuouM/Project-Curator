use anyhow::{Context, Error};
use clap::{Parser, Subcommand};
use curator_core::constants::resolve_data_dir;
use curator_core::ipc::{EmbeddingModel, ImageDetails, Request, Response, TaggerModel};
use std::fs;
use std::path::PathBuf;

fn parse_tagger(value: &str) -> TaggerModel {
    match value {
        "camie" | "camie-tagger-v2" => TaggerModel::Camie,
        "wd-eva02" | "wd-eva02-tagger-2026-canary" => TaggerModel::WdEva02,
        other => {
            eprintln!(
                "Unknown tagger '{}'. Valid options: 'camie' or 'wd-eva02'. Defaulting to 'camie'.",
                other
            );
            TaggerModel::Camie
        }
    }
}


#[derive(Parser, Debug)]
#[command(author, version, about = "Command line client for Project Curator", long_about = None)]
struct Cli {
    /// Path to the curator data directory. Defaults to `.curator` in the workspace root.
    #[arg(short, long)]
    data_dir: Option<String>,

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
    /// Auto-tag a single image with the preferred tagger
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

        /// Tagger to use: 'camie' or 'wd-eva02'. Defaults to the preferred tagger.
        #[arg(long)]
        tagger: Option<String>,
    },
    /// Auto-tag all images in the library that don't already have AI tags
    TagAutoBatch {
        /// Confidence threshold. Defaults to the tagger's balanced default.
        #[arg(short, long)]
        threshold: Option<f32>,

        /// Wipe existing AI tags before running
        #[arg(short, long)]
        force: bool,

        /// Tagger to use: 'camie' or 'wd-eva02'. Defaults to the preferred tagger.
        #[arg(long)]
        tagger: Option<String>,

        /// Optional list of specific image IDs (space-separated). If omitted, tags all untagged images.
        image_ids: Vec<i64>,
    },
    /// Tag every image already tagged by --from with the --to tagger
    TagBackfill {
        /// Source tagger whose tagged images seed the work set ('camie' or 'wd-eva02')
        #[arg(long)]
        from: String,

        /// Destination tagger to run ('camie' or 'wd-eva02')
        #[arg(long)]
        to: String,
    },
    /// Show the current status of all tagger models
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
    let data_dir = match &cli.data_dir {
        Some(p) => PathBuf::from(p),
        None => resolve_data_dir(),
    };

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
            ocr_filter: None,
            ocr_text_search: None,
            media_type: None,
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
            tagger,
        } => Request::TagImage {
            image_id,
            threshold,
            force: Some(force),
            tagger: tagger.as_deref().map(parse_tagger),
        },
        Commands::TagAutoBatch {
            threshold,
            force,
            tagger,
            image_ids,
        } => {
            if image_ids.is_empty() {
                // Fetch all image IDs from the service first if no IDs provided.
                eprintln!(
                    "No image IDs provided; batch will tag ALL images. \
                     This may take a long time. Use Ctrl+C to cancel, \
                     or pass specific IDs: tag-auto-batch <id1> <id2> ..."
                );
                Request::TagImageBatch {
                    image_ids: vec![],
                    threshold,
                    force: Some(force),
                    tagger: tagger.as_deref().map(parse_tagger),
                }
            } else {
                Request::TagImageBatch {
                    image_ids,
                    threshold,
                    force: Some(force),
                    tagger: tagger.as_deref().map(parse_tagger),
                }
            }
        }
        Commands::TagBackfill { from, to } => Request::BackfillTagSource {
            from_tagger: parse_tagger(&from),
            to_tagger: parse_tagger(&to),
        },
        Commands::TaggerStatus => Request::GetTaggerStatus,
        Commands::Benchmark { model } => {
            let emb_model = match model.as_str() {
                "mobileclip-s2" | "mobileclip_s2" => EmbeddingModel::MobileClipS2,
                _ => EmbeddingModel::ClipVitB32,
            };
            Request::RunBenchmark {
                embedding_model: emb_model,
                run_tagger: None,
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
            taggers,
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

            let mut printed_any_tagger = false;
            for t in &taggers {
                printed_any_tagger = true;
                println!("\n{} ({}x{}):", t.name, t.input_size, t.input_size);
                if let Some(cpu) = t.cpu_time_ms {
                    println!("  CPU: {:.2} ms/image", cpu);
                    if let Some(gpu) = t.gpu_time_ms {
                        println!("  GPU: {:.2} ms/image ({:.2}x speedup)", gpu, cpu / gpu);
                    } else {
                        println!("  GPU: N/A");
                    }
                } else {
                    println!("  CPU: N/A");
                    println!("  GPU: N/A");
                }
                if let Some(err) = &t.gpu_error {
                    println!("  Tagger Error: {}", err);
                }
            }
            if !printed_any_tagger {
                let label = if tagger_cpu_time_ms.is_some() {
                    "Tagger"
                } else {
                    "Camie Tagger v2"
                };
                println!("\n{} (512x512):", label);
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
            ..
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
            preferred_tagger,
            taggers,
        } => {
            println!("Preferred tagger: {:?}", preferred_tagger);
            for t in &taggers {
                println!("Tagger: {} ({})", t.name, t.key);
                println!(
                    "  Loaded:     {}",
                    if t.loaded {
                        "Yes"
                    } else {
                        "No (lazy — loads on first use)"
                    }
                );
                println!("  Model path: {}", t.model_path);
                println!("  Tag count:  {}", t.total_tags);
                println!("  Threshold:  {:.4}", t.default_threshold);
                println!("  Input size: {}x{}", t.input_size, t.input_size);
            }
        }
        Response::SettingsResult {
            clip_device,
            tagger_device,
            tagger_wd_device,
            idle_timeout_secs,
            embedding_model,
            detection_device,
            detection_metrics_device,
            ocr_device,
            model_precisions,
            preferred_tagger,
            taggers,
        } => {
            println!("Settings:");
            println!("  CLIP device:              {:?}", clip_device);
            println!("  Tagger device:            {:?}", tagger_device);
            println!("  Tagger WD device:         {:?}", tagger_wd_device);
            println!("  Idle timeout:             {}s", idle_timeout_secs);
            println!("  Embedding model:          {:?}", embedding_model);
            println!("  Detection device:         {:?}", detection_device);
            println!("  Detection metrics device: {:?}", detection_metrics_device);
            println!("  OCR device:               {:?}", ocr_device);
            println!("  Model precisions:         {:?}", model_precisions);
            println!("  Preferred tagger:         {:?}", preferred_tagger);
            for t in taggers {
                println!(
                    "  Tagger [{}] loaded={} tags={}",
                    t.key, t.loaded, t.total_tags
                );
            }
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
