use anyhow::{Context, Error};
use clap::{Parser, Subcommand};
use curator_core::constants::resolve_data_dir;
use curator_core::grpc::benchmarks::benchmarks_service_client::BenchmarksServiceClient;
use curator_core::grpc::benchmarks::RunBenchmarkRequest;
use curator_core::grpc::common::{EmbeddingModel, ImageDetails, SearchMatch, TaggerModel};
use curator_core::grpc::gallery::gallery_service_client::GalleryServiceClient;
use curator_core::grpc::gallery::{GetImageRequest, ListImagesRequest};
use curator_core::grpc::import::import_service_client::ImportServiceClient;
use curator_core::grpc::import::ImportImageRequest;
use curator_core::grpc::plugins::plugins_service_client::PluginsServiceClient;
use curator_core::grpc::plugins::ValidatePluginRequest;
use curator_core::grpc::search::search_service_client::SearchServiceClient;
use curator_core::grpc::search::SearchRequest;
use curator_core::grpc::system::system_service_client::SystemServiceClient;
use curator_core::grpc::tagging::tagging_service_client::TaggingServiceClient;
use curator_core::grpc::tagging::{TagImageBatchRequest, TagImageRequest};
use curator_core::grpc::tags::tags_service_client::TagsServiceClient;
use curator_core::grpc::tags::{AddTagRequest, BackfillTagSourceRequest, RemoveTagRequest};
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

fn tagger_name(value: i32) -> &'static str {
    match value {
        x if x == TaggerModel::Camie as i32 => "camie",
        x if x == TaggerModel::WdEva02 as i32 => "wd-eva02",
        _ => "unknown",
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

    // 2. Connect to the Curator gRPC Service over the shared IPC channel.
    //    Each command uses the domain-specific typed client for its RPC.
    let channel = curator_core::ipc::grpc_helper::connect_ipc()
        .await
        .context("Failed to connect to Curator Service. Is the service running?")?;

    match cli.command {
        Commands::Ping => {
            let mut client = SystemServiceClient::new(channel);
            client
                .ping(())
                .await
                .context("gRPC Ping request failed")?;
            println!("Pong! Curator Service is alive and healthy.");
        }

        Commands::Status => {
            let mut client = SystemServiceClient::new(channel);
            let resp = client
                .get_status(())
                .await
                .context("gRPC GetStatus request failed")?
                .into_inner();
            println!("Curator Database Status:");
            println!("  Images Imported:      {}", resp.image_count);
            println!("  Vectors Indexed:      {}", resp.vector_count);
            println!("  Pending Job Queue:    {}", resp.pending_jobs);
            println!("  Preprocessing Queue:  {}", resp.preprocessing_jobs);
            println!("  RAM Usage:            {} bytes", resp.ram_usage_bytes);
        }

        Commands::Import { path } => {
            let mut client = ImportServiceClient::new(channel);
            let resp = client
                .import_image(ImportImageRequest { path })
                .await
                .context("gRPC ImportImage request failed")?
                .into_inner();
            println!(
                "Successfully imported image/folder ({} item(s)):",
                resp.imported_count
            );
            println!("  First Image ID: {}", resp.image_id);
            println!("  SHA256:         {}", resp.sha256);
            println!("  (Background job scheduled for vector embedding generation)");
        }

        Commands::Tag { action } => {
            let mut client = TagsServiceClient::new(channel);
            match action {
                TagCommands::Add {
                    image_id,
                    tag,
                    category,
                } => {
                    client
                        .add_tag(AddTagRequest {
                            image_id,
                            tag,
                            category,
                        })
                        .await
                        .context("gRPC AddTag request failed")?;
                    println!("Operation completed successfully.");
                }
                TagCommands::Remove { image_id, tag } => {
                    client
                        .remove_tag(RemoveTagRequest { image_id, tag })
                        .await
                        .context("gRPC RemoveTag request failed")?;
                    println!("Operation completed successfully.");
                }
            }
        }

        Commands::Search {
            query,
            image,
            tag,
            limit,
        } => {
            let mut client = SearchServiceClient::new(channel);
            let resp = client
                .search(SearchRequest {
                    query_text: query,
                    query_image_path: image,
                    tag_filter: tag,
                    filename_filter: None,
                    parse_filter: None,
                    parse_type: None,
                    concept_id: None,
                    character_identity_id: None,
                    ocr_filter: None,
                    ocr_text_search: None,
                    media_type: None,
                    limit: limit as u32,
                })
                .await
                .context("gRPC Search request failed")?
                .into_inner();
            print_search_matches(&resp.matches);
        }

        Commands::List { limit, offset } => {
            let mut client = GalleryServiceClient::new(channel);
            let resp = client
                .list_images(ListImagesRequest {
                    limit: limit as u32,
                    offset: offset as u32,
                    only_favorites: None,
                })
                .await
                .context("gRPC ListImages request failed")?
                .into_inner();
            if resp.images.is_empty() {
                println!("No images imported yet.");
            } else {
                println!("Imported Images (showing {} latest):", resp.images.len());
                for img in &resp.images {
                    print_image_details(img);
                }
            }
        }

        Commands::Show { image_id } => {
            let mut client = GalleryServiceClient::new(channel);
            let resp = client
                .get_image(GetImageRequest { image_id })
                .await
                .context("gRPC GetImage request failed")?
                .into_inner();
            if let Some(image) = resp.image {
                print_image_details(&image);
            } else {
                println!("Image {} not found.", image_id);
            }
        }

        Commands::ValidatePlugin { manifest_path } => {
            let mut client = PluginsServiceClient::new(channel);
            let resp = client
                .validate_plugin(ValidatePluginRequest { manifest_path })
                .await
                .context("gRPC ValidatePlugin request failed")?
                .into_inner();
            if resp.valid {
                println!("Plugin manifest is VALID!");
                println!("  Name:    {}", resp.name);
                println!("  Version: {}", resp.version);
            } else {
                println!("Plugin manifest is INVALID!");
                println!("  Error: {}", resp.error.unwrap_or_default());
            }
        }

        Commands::TagAuto {
            image_id,
            threshold,
            force,
            tagger,
        } => {
            let mut client = TaggingServiceClient::new(channel);
            let resp = client
                .tag_image(TagImageRequest {
                    image_id,
                    threshold,
                    force: Some(force),
                    tagger: tagger.as_deref().map(|t| parse_tagger(t) as i32),
                })
                .await
                .context("gRPC TagImage request failed")?
                .into_inner();
            if resp.skipped {
                println!(
                    "Image {} already has AI tags — skipped (use --force to re-tag).",
                    resp.image_id
                );
            } else {
                println!(
                    "Auto-tagged image {} — {} tags applied:",
                    resp.image_id, resp.tags_applied
                );
                for t in &resp.tags {
                    println!(
                        "  [{:<12}] {:<40} ({:.2}%)",
                        t.category,
                        t.tag,
                        t.confidence * 100.0
                    );
                }
            }
        }

        Commands::TagAutoBatch {
            threshold,
            force,
            tagger,
            image_ids,
        } => {
            if image_ids.is_empty() {
                eprintln!(
                    "No image IDs provided; batch will tag ALL images. \
                     This may take a long time. Use Ctrl+C to cancel, \
                     or pass specific IDs: tag-auto-batch <id1> <id2> ..."
                );
            }
            let mut client = TaggingServiceClient::new(channel);
            let resp = client
                .tag_image_batch(TagImageBatchRequest {
                    image_ids,
                    threshold,
                    force: Some(force),
                    tagger: tagger.as_deref().map(|t| parse_tagger(t) as i32),
                })
                .await
                .context("gRPC TagImageBatch request failed")?
                .into_inner();
            println!("Batch auto-tag complete:");
            println!("  Tagged:  {}", resp.processed);
            println!("  Skipped: {} (already had AI tags)", resp.skipped);
            println!("  Failed:  {}", resp.failed);
        }

        Commands::TagBackfill { from, to } => {
            let mut client = TagsServiceClient::new(channel);
            let resp = client
                .backfill_tag_source(BackfillTagSourceRequest {
                    from_tagger: parse_tagger(&from) as i32,
                    to_tagger: parse_tagger(&to) as i32,
                })
                .await
                .context("gRPC BackfillTagSource request failed")?
                .into_inner();
            println!("Tag backfill complete:");
            println!("  Tagged:  {}", resp.processed);
            println!("  Skipped: {} (already had AI tags)", resp.skipped);
            println!("  Failed:  {}", resp.failed);
        }

        Commands::TaggerStatus => {
            let mut client = TaggingServiceClient::new(channel);
            let resp = client
                .get_tagger_status(())
                .await
                .context("gRPC GetTaggerStatus request failed")?
                .into_inner();
            println!("Preferred tagger: {}", tagger_name(resp.preferred_tagger));
            for t in &resp.taggers {
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

        Commands::Benchmark { model } => {
            let emb_model = match model.as_str() {
                "mobileclip-s2" | "mobileclip_s2" => EmbeddingModel::MobileclipS2,
                _ => EmbeddingModel::ClipVitB32,
            };
            let mut client = BenchmarksServiceClient::new(channel);
            let resp = client
                .run_benchmark(RunBenchmarkRequest {
                    embedding_model: emb_model as i32,
                    run_tagger: None,
                })
                .await
                .context("gRPC RunBenchmark request failed")?
                .into_inner();
            print_benchmark_result(&resp);
        }
    }

    Ok(())
}

fn print_search_matches(matches: &[SearchMatch]) {
    if matches.is_empty() {
        println!("No matching images found.");
        return;
    }
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

fn print_benchmark_result(r: &curator_core::grpc::benchmarks::BenchmarkResult) {
    println!("Benchmark Results:");
    println!("GPU Support: {}", if r.has_gpu { "Yes" } else { "No" });
    println!("\nCLIP Vision Model:");
    println!("  CPU: {:.2} ms/image", r.clip_cpu_time_ms);
    if let Some(gpu) = r.clip_gpu_time_ms {
        println!(
            "  GPU: {:.2} ms/image ({:.2}x speedup)",
            gpu,
            r.clip_cpu_time_ms / gpu
        );
    } else {
        println!("  GPU: N/A");
    }
    if let Some(err) = &r.clip_gpu_error {
        println!("  GPU Load Error: {}", err);
    }

    let mut printed_any_tagger = false;
    for t in &r.taggers {
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
        if let Some(cpu) = r.tagger_cpu_time_ms {
            println!("\nTagger (512x512):");
            println!("  CPU: {:.2} ms/image", cpu);
            if let Some(gpu) = r.tagger_gpu_time_ms {
                println!("  GPU: {:.2} ms/image ({:.2}x speedup)", gpu, cpu / gpu);
            } else {
                println!("  GPU: N/A");
            }
        } else {
            println!("\nTagger: N/A");
        }
        if let Some(err) = &r.tagger_gpu_error {
            println!("  Tagger Error: {}", err);
        }
    }
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
