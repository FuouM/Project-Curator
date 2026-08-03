use curator_core::db::init_db;
use tempfile::NamedTempFile;
use sqlx::SqlitePool;
use std::time::Instant;

// Simple LCG PRNG
struct SimpleLcg {
    state: u64,
}

impl SimpleLcg {
    fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_mul(1664525).wrapping_add(1013904223);
        self.state
    }
}

async fn setup_large_db() -> (NamedTempFile, SqlitePool) {
    let temp_file = NamedTempFile::new().unwrap();
    let db_path = temp_file.path();
    let pool = init_db(db_path).await.expect("Failed to initialize database");

    // Populate data
    let mut lcg = SimpleLcg::new(42);

    // Insert sources
    sqlx::query("INSERT INTO sources (name, type, manifest) VALUES ('user', 'builtin', '{}')")
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO sources (name, type, manifest) VALUES ('ai:camie-tagger-v2', 'builtin', '{}')")
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO sources (name, type, manifest) VALUES ('ai:clip-vit-b-32', 'builtin', '{}')")
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO sources (name, type, manifest) VALUES ('filename_parser', 'builtin', '{}')")
        .execute(&pool).await.unwrap();

    // Insert 1000 tags
    let mut tx = pool.begin().await.unwrap();
    for i in 0..1000 {
        let name = format!("tag_{}", i);
        let category = match i % 4 {
            0 => "general",
            1 => "artist",
            2 => "character",
            _ => "meta",
        };
        sqlx::query("INSERT INTO tags (name, category) VALUES (?, ?)")
            .bind(&name)
            .bind(category)
            .execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();

    // Insert 5000 images
    let mut tx = pool.begin().await.unwrap();
    for i in 1..=5000 {
        let sha256 = format!("{:064x}", i);
        let phash = format!("{:016x}", lcg.next_u64());
        let filepath = format!("images/image_{}.jpg", i);
        let mtime = 1700000000 + i;
        let favorite = if i % 10 == 0 { 1 } else { 0 };
        sqlx::query("INSERT INTO images (sha256, phash, current_filepath, mtime, favorite, is_missing) VALUES (?, ?, ?, ?, ?, 0)")
            .bind(&sha256)
            .bind(&phash)
            .bind(&filepath)
            .bind(mtime)
            .bind(favorite)
            .execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();

    // Insert image_tags (about 5 tags per image = 25000 links)
    let mut tx = pool.begin().await.unwrap();
    for i in 1..=5000 {
        for j in 0..5 {
            let tag_id = ((i * 7 + j * 13) % 1000) + 1;
            let source_id = if j % 2 == 0 { 1 } else { 2 };
            sqlx::query("INSERT INTO image_tags (image_id, tag_id, source_id, confidence, is_deleted) VALUES (?, ?, ?, 0.8, 0) ON CONFLICT DO NOTHING")
                .bind(i)
                .bind(tag_id)
                .bind(source_id)
                .execute(&mut *tx).await.unwrap();
        }
    }
    tx.commit().await.unwrap();

    // Insert image_parsed_metadata (5000 rows)
    let mut tx = pool.begin().await.unwrap();
    for i in 1..=5000 {
        let artist = if i % 5 == 0 { Some(format!("artist_{}", i % 50)) } else { None };
        let match_type = if i % 2 == 0 { "preset" } else { "custom_regex" };
        let tags_json = serde_json::to_string(&vec![format!("tag_{}", i % 100)]).unwrap();
        sqlx::query("INSERT INTO image_parsed_metadata (image_id, match_type, artist, extracted_tags, raw_matched) VALUES (?, ?, ?, ?, 'raw')")
            .bind(i)
            .bind(match_type)
            .bind(artist)
            .bind(&tags_json)
            .execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();

    // Insert character_identities (100)
    let mut tx = pool.begin().await.unwrap();
    for i in 1..=100 {
        let name = format!("Character {}", i);
        sqlx::query("INSERT INTO character_identities (name) VALUES (?)")
            .bind(&name)
            .execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();

    // Insert character_detections (500)
    let mut tx = pool.begin().await.unwrap();
    for i in 1..=500 {
        let image_id = (i % 5000) + 1;
        let identity_id = if i % 5 != 0 { Some((i % 100) + 1) } else { None };
        let emb = vec![0.1f32; 128];
        let emb_bytes: Vec<u8> = emb.iter().flat_map(|f| f.to_le_bytes().to_vec()).collect();
        sqlx::query("INSERT INTO character_detections (image_id, x0, y0, x1, y1, confidence, ccip_embedding, identity_id) VALUES (?, 0, 0, 100, 100, 0.9, ?, ?)")
            .bind(image_id)
            .bind(&emb_bytes)
            .bind(identity_id)
            .execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();

    (temp_file, pool)
}

#[tokio::test]
async fn run_db_benchmarks() {
    let (_tmp, pool) = setup_large_db().await;

    // Benchmark 1: Query image by id (e.g. get_image_logic)
    {
        let start = Instant::now();
        let _row: (i64, String) = sqlx::query_as("SELECT id, current_filepath FROM images WHERE id = ? AND deleted_at IS NULL")
            .bind(2500i64)
            .fetch_one(&pool)
            .await
            .unwrap();
        println!("Benchmark 1 (Get Image by ID): {:?}", start.elapsed());
    }

    // Benchmark 2: Get image tags (e.g. get_image_logic)
    {
        let start = Instant::now();
        let _rows: Vec<(String, String, f32, Option<String>, bool)> = sqlx::query_as(
            "SELECT t.name, t.category, it.confidence, s.name, (it.is_blacklisted = 1)
             FROM image_tags it
             JOIN tags t ON it.tag_id = t.id
             LEFT JOIN sources s ON it.source_id = s.id
             WHERE it.image_id = ? AND (it.is_deleted = 0 OR it.is_blacklisted = 1)",
        )
        .bind(2500i64)
        .fetch_all(&pool)
        .await
        .unwrap();
        println!("Benchmark 2 (Get Image Tags): {:?}", start.elapsed());
    }

    // Benchmark 3: list_images_logic count query
    {
        let start = Instant::now();
        let _count: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM images WHERE deleted_at IS NULL AND is_missing = 0 AND (0 = 0 OR favorite = 1)",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        println!("Benchmark 3 (List Images Count): {:?}", start.elapsed());
    }

    // Benchmark 4: list_images_logic page query
    {
        let start = Instant::now();
        let _rows: Vec<(i64, String)> = sqlx::query_as(
            "SELECT id, current_filepath FROM images WHERE deleted_at IS NULL AND is_missing = 0 AND (0 = 0 OR favorite = 1) ORDER BY created_at DESC, id DESC LIMIT 50 OFFSET 100",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        println!("Benchmark 4 (List Images Page): {:?}", start.elapsed());
    }

    // Benchmark 5: batch get images details (batch_get_images_logic / fetch_image_details_batch)
    {
        let ids: Vec<i64> = (2000..2050).collect();
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            r#"
            SELECT i.id, i.sha256, i.current_filepath, i.mtime, i.created_at, i.favorite, i.is_missing,
                   t.name, t.category, it.confidence, s.name as source_name
            FROM images i
            LEFT JOIN image_tags it ON it.image_id = i.id AND it.is_deleted = 0
            LEFT JOIN tags t ON it.tag_id = t.id
            LEFT JOIN sources s ON it.source_id = s.id
            WHERE i.id IN ({})
            ORDER BY i.created_at DESC, i.id DESC
            "#,
            placeholders
        );
        let start = Instant::now();
        let mut q = sqlx::query_as::<_, (i64, String, String, i64, String, bool, bool, Option<String>, Option<String>, Option<f32>, Option<String>)>(&sql);
        for id in &ids {
            q = q.bind(id);
        }
        let _rows = q.fetch_all(&pool).await.unwrap();
        println!("Benchmark 5 (Batch Get Details): {:?}", start.elapsed());
    }

    // Benchmark 6: get_tag_statistics_logic
    {
        let start = Instant::now();
        let _rows: Vec<(String, String, i64)> = sqlx::query_as(
            r#"
            SELECT t.name AS tag, t.category AS category, COUNT(*) AS count
            FROM image_tags it
            JOIN tags t ON t.id = it.tag_id
            WHERE it.is_deleted = 0
            GROUP BY it.tag_id
            ORDER BY count DESC
            "#,
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        println!("Benchmark 6 (Tag Statistics): {:?}", start.elapsed());
    }

    // Benchmark 7: get_character_suggestions_logic (LIKE query)
    {
        let start = Instant::now();
        let _rows: Vec<(String, String, i64)> = sqlx::query_as(
            r#"
            SELECT t.name AS tag, t.category AS category, 0 AS count
            FROM tags t
            WHERE t.category = 'character' AND t.name LIKE ?
            ORDER BY t.name ASC
            LIMIT 30
            "#,
        )
        .bind("%char%")
        .fetch_all(&pool)
        .await
        .unwrap();
        println!("Benchmark 7 (Character Suggestions): {:?}", start.elapsed());
    }

    // Benchmark 8: list_identities (Detection pipeline)
    {
        let start = Instant::now();
        let _rows: Vec<(i64, String, i64, String)> = sqlx::query_as(
            "SELECT ci.id, ci.name, COUNT(cd.id) as detection_count, ci.created_at \
             FROM character_identities ci \
             LEFT JOIN character_detections cd ON cd.identity_id = ci.id \
             GROUP BY ci.id \
             ORDER BY ci.id"
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        println!("Benchmark 8 (List Identities): {:?}", start.elapsed());
    }

    // Benchmark 9: load_identity_embeddings in a loop (100 identities)
    {
        let start = Instant::now();
        for i in 1..=100 {
            let _rows: Vec<(Option<Vec<u8>>,)> = sqlx::query_as(
                "SELECT ccip_embedding FROM character_detections WHERE identity_id = ? AND ccip_embedding IS NOT NULL"
            )
            .bind(i)
            .fetch_all(&pool)
            .await
            .unwrap();
        }
        println!("Benchmark 9 (Load 100 Identity Embeddings - loop): {:?}", start.elapsed());
    }

    // Benchmark 10: load_identity_embeddings optimized (single query)
    {
        let start = Instant::now();
        let _rows: Vec<(i64, Option<Vec<u8>>)> = sqlx::query_as(
            "SELECT identity_id, ccip_embedding FROM character_detections WHERE identity_id IS NOT NULL AND ccip_embedding IS NOT NULL"
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        println!("Benchmark 10 (Load Identity Embeddings - optimized single query): {:?}", start.elapsed());
    }

    // Benchmark 11: search_logic phash full-table fetch
    {
        let start = Instant::now();
        let _rows: Vec<(i64, String)> = sqlx::query_as(
            "SELECT id, phash FROM images WHERE phash IS NOT NULL AND deleted_at IS NULL",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        println!("Benchmark 11 (Search Phash Full-table): {:?}", start.elapsed());
    }
}
