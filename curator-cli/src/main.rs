use anyhow::{Context, Error};
use clap::{Parser, Subcommand};
use curator_core::ipc::{Request, Response, ImageDetails};
use std::fs;
use std::path::PathBuf;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::ClientOptions;

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
    /// Import an image file
    Import {
        /// Absolute path to the image file
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
    Show {
        image_id: i64,
    },
    /// Validate a plugin's manifest.json file
    ValidatePlugin {
        manifest_path: String,
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
    Remove {
        image_id: i64,
        tag_id: i64,
    },
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
    let token = fs::read_to_string(&key_file)
        .context("Failed to read service key file")?
        .trim()
        .to_string();

    // 2. Map CLI command to IPC Request
    let request = match cli.command {
        Commands::Ping => Request::Ping,
        Commands::Status => Request::GetStatus,
        Commands::Import { path } => Request::ImportImage { path },
        Commands::Tag { action } => match action {
            TagCommands::Add { image_id, tag, category } => Request::AddTag { image_id, tag, category },
            TagCommands::Remove { image_id, tag_id } => Request::RemoveTag { image_id, tag_id },
        },
        Commands::Search { query, tag, limit } => Request::Search { query_text: query, tag_filter: tag, limit },
        Commands::List { limit, offset } => Request::ListImages { limit, offset },
        Commands::Show { image_id } => Request::GetImage { image_id },
        Commands::ValidatePlugin { manifest_path } => Request::ValidatePlugin { manifest_path },
    };

    // 3. Connect to Named Pipe IPC Server
    let pipe_name = r"\\.\pipe\curator_ipc";
    let mut client = ClientOptions::new()
        .open(pipe_name)
        .context("Failed to connect to Curator Service Named Pipe. Is the service running?")?;

    // 4. Perform Handshake (Send Token)
    client.write_all(token.as_bytes()).await?;
    
    let mut auth_buffer = vec![0; 32];
    let n = client.read(&mut auth_buffer).await?;
    let auth_status = String::from_utf8_lossy(&auth_buffer[..n]);
    if auth_status != "AUTH_OK" {
        return Err(anyhow::anyhow!("Service authentication failed: {}", auth_status));
    }

    // 5. Send Request
    let request_str = serde_json::to_string(&request)?;
    client.write_all(request_str.as_bytes()).await?;

    // 6. Read Response
    let mut response_buffer = vec![0; 65536]; // larger buffer for image list/search matches
    let n = client.read(&mut response_buffer).await?;
    let response_str = String::from_utf8_lossy(&response_buffer[..n]);
    let response: Response = serde_json::from_str(&response_str)
        .context("Failed to parse response JSON from service")?;

    // 7. Format and Print Response
    match response {
        Response::Pong => println!("Pong! Curator Service is alive and healthy."),
        Response::Success => println!("Operation completed successfully."),
        Response::Error { message } => println!("Error: {}", message),
        Response::ImportResult { image_id, sha256 } => {
            println!("Successfully imported image:");
            println!("  ID:     {}", image_id);
            println!("  SHA256: {}", sha256);
            println!("  (Background job scheduled for vector embedding generation)");
        }
        Response::StatusResult { image_count, vector_count, pending_jobs } => {
            println!("Curator Database Status:");
            println!("  Images Imported:  {}", image_count);
            println!("  Vectors Indexed:  {}", vector_count);
            println!("  Pending Job Queue: {}", pending_jobs);
        }
        Response::SearchResult { matches } => {
            if matches.is_empty() {
                println!("No matching images found.");
            } else {
                println!("Search Results ({} matches):", matches.len());
                for (idx, m) in matches.iter().enumerate() {
                    println!("{}. [ID: {}] {} (Score: {:.4})", idx + 1, m.id, m.filepath, m.score);
                    if !m.tags.is_empty() {
                        println!("    Tags: {}", m.tags.join(", "));
                    }
                }
            }
        }
        Response::ListResult { images } => {
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
        Response::ValidationResult { name, version, valid, error } => {
            if valid {
                println!("Plugin manifest is VALID!");
                println!("  Name:    {}", name);
                println!("  Version: {}", version);
            } else {
                println!("Plugin manifest is INVALID!");
                println!("  Error: {}", error.unwrap_or_default());
            }
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
        println!("  Tags:    {}", img.tags.join(", "));
    }
    println!("  Created: {}", img.created_at);
    println!();
}
