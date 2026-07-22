use anyhow::Result;
use curator_core::ipc::TagSummary;
use sqlx::SqlitePool;

pub async fn resolve_source_id(db: &SqlitePool, name: &str) -> Result<i64> {
    let row: (i64,) = sqlx::query_as("SELECT id FROM sources WHERE name = ? LIMIT 1")
        .bind(name)
        .fetch_one(db)
        .await?;
    Ok(row.0)
}

pub fn sort_tags_by_priority(tags: &mut [TagSummary]) {
    tags.sort_by(|a, b| {
        let priority = |t: &TagSummary| -> i32 {
            if t.source_name.as_deref() == Some("ai:custom-concepts") || t.category == "user" {
                -1
            } else {
                match t.category.as_str() {
                    "character" => 1,
                    "copyright" => 2,
                    "meta" => 3,
                    _ => 4,
                }
            }
        };

        let p_a = priority(a);
        let p_b = priority(b);

        if p_a != p_b {
            p_a.cmp(&p_b)
        } else {
            b.confidence
                .partial_cmp(&a.confidence)
                .unwrap_or(std::cmp::Ordering::Equal)
        }
    });
}
