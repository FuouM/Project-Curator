use curator_core::init_db;
use tempfile::NamedTempFile;

#[tokio::test]
async fn test_db_initialization_and_migrations() {
    // Create a temporary file path for the SQLite database
    let temp_file = NamedTempFile::new().unwrap();
    let db_path = temp_file.path();

    // Initialize database (which runs migrations programmatically)
    let pool = init_db(db_path).await.expect("Failed to initialize database");

    // Verify migrations by querying one of the created tables
    let tables: Vec<(String,)> = sqlx::query_as("SELECT name FROM sqlite_master WHERE type='table' AND name='sources'")
        .fetch_all(&pool)
        .await
        .expect("Failed to query database schema");

    assert_eq!(tables.len(), 1, "The 'sources' table was not created by migrations");
}
