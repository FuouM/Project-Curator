use sqlx::sqlite::{SqliteConnectOptions, SqlitePool};
use std::path::Path;
use tracing::info;

pub mod models;

pub async fn init_db<P: AsRef<Path>>(db_path: P) -> Result<SqlitePool, anyhow::Error> {
    let db_path = db_path.as_ref();

    // Ensure parent directory exists
    if let Some(parent) = db_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    info!("Connecting to SQLite database at {:?}", db_path);
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .synchronous(sqlx::sqlite::SqliteSynchronous::Normal);

    let pool = SqlitePool::connect_with(options).await?;

    info!("Running database migrations...");
    sqlx::migrate!("./migrations").run(&pool).await?;
    info!("Database migrations completed successfully.");

    Ok(pool)
}
