//! Generic plugin-data SQLite primitive.
//!
//! Any plugin gets an isolated, backend-owned SQLite database under
//! `<data_dir>/plugin_data/<plugin_id>/` and may run parameterized SQL against it
//! via `plugin_db_execute` / `plugin_db_query`. The `<plugin_id>` and `db` name are
//! guarded so a plugin cannot read or write outside its own directory.

use anyhow::{Result, bail};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Arguments, Column, Row, SqlitePool};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use tokio::sync::RwLock;

use crate::sandbox_path::is_safe_name;

static PLUGIN_POOLS: LazyLock<RwLock<HashMap<PathBuf, SqlitePool>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// Root directory for all plugin data. Created on first use.
pub fn plugin_data_root(data_dir: &Path) -> PathBuf {
    let dir = data_dir.join("plugin_data");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Resolve and open (creating if needed) a plugin-owned database.
/// Cached in-memory across calls for instant sub-millisecond query execution.
pub async fn open_plugin_db(data_dir: &Path, plugin_id: &str, db: &str) -> Result<SqlitePool> {
    if !is_safe_name(plugin_id) {
        bail!("invalid plugin id");
    }
    if !is_safe_name(db) {
        bail!("invalid database name");
    }
    let plugin_dir = plugin_data_root(data_dir).join(plugin_id);
    std::fs::create_dir_all(&plugin_dir)?;
    let path = plugin_dir.join(db);

    {
        let pools = PLUGIN_POOLS.read().await;
        if let Some(pool) = pools.get(&path) {
            return Ok(pool.clone());
        }
    }

    let mut pools = PLUGIN_POOLS.write().await;
    if let Some(pool) = pools.get(&path) {
        return Ok(pool.clone());
    }

    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .synchronous(sqlx::sqlite::SqliteSynchronous::Normal);
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await
        .map_err(|e| anyhow::anyhow!("failed to open plugin database: {e}"))?;

    pools.insert(path, pool.clone());
    Ok(pool)
}

fn bind_value<'q>(
    args: &mut sqlx::sqlite::SqliteArguments<'q>,
    value: impl sqlx::Encode<'q, sqlx::Sqlite> + sqlx::Type<sqlx::Sqlite> + 'q,
) -> Result<()> {
    args.add(value)
        .map_err(|e| anyhow::anyhow!("plugin db parameter bind failed: {e}"))
}

fn build_arguments(params: &[serde_json::Value]) -> Result<sqlx::sqlite::SqliteArguments<'_>> {
    use sqlx::sqlite::SqliteArguments;
    let mut args = SqliteArguments::default();
    for p in params {
        match p {
            serde_json::Value::Null => {
                bind_value(&mut args, Option::<i64>::None)?;
            }
            serde_json::Value::Bool(b) => {
                bind_value(&mut args, *b)?;
            }
            serde_json::Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    bind_value(&mut args, i)?;
                } else if let Some(f) = n.as_f64() {
                    bind_value(&mut args, f)?;
                } else if let Some(u) = n.as_u64() {
                    bind_value(&mut args, u as i64)?;
                } else {
                    bind_value(&mut args, 0i64)?;
                }
            }
            serde_json::Value::String(s) => {
                bind_value(&mut args, s.clone())?;
            }
            other => {
                bind_value(&mut args, serde_json::to_string(other).unwrap_or_default())?;
            }
        }
    }
    Ok(args)
}

fn row_to_json(row: &sqlx::sqlite::SqliteRow) -> serde_json::Value {
    let mut obj = serde_json::Map::new();
    for (i, col) in row.columns().iter().enumerate() {
        let name = col.name().to_string();
        let value = cell_to_json(row, i);
        obj.insert(name, value);
    }
    serde_json::Value::Object(obj)
}

fn cell_to_json(row: &sqlx::sqlite::SqliteRow, i: usize) -> serde_json::Value {
    if let Ok(v) = row.try_get::<Option<i64>, _>(i) {
        return v
            .map(serde_json::Value::from)
            .unwrap_or(serde_json::Value::Null);
    }
    if let Ok(v) = row.try_get::<Option<f64>, _>(i) {
        return v
            .map(serde_json::Value::from)
            .unwrap_or(serde_json::Value::Null);
    }
    if let Ok(v) = row.try_get::<Option<String>, _>(i) {
        return v
            .map(serde_json::Value::from)
            .unwrap_or(serde_json::Value::Null);
    }
    if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(i) {
        return v
            .map(|b| serde_json::Value::String(String::from_utf8_lossy(&b).into_owned()))
            .unwrap_or(serde_json::Value::Null);
    }
    serde_json::Value::Null
}

/// Run a write query against a plugin-owned database; returns rows affected.
pub async fn plugin_db_execute(
    data_dir: &Path,
    plugin_id: &str,
    db: &str,
    sql: &str,
    params: &[serde_json::Value],
) -> Result<u64> {
    let pool = open_plugin_db(data_dir, plugin_id, db).await?;
    let args = build_arguments(params)?;
    let result = sqlx::query_with(sql, args)
        .execute(&pool)
        .await
        .map_err(|e| anyhow::anyhow!("plugin db execute failed: {e}"))?;
    Ok(result.rows_affected())
}

/// Run a read query against a plugin-owned database; returns rows as objects.
pub async fn plugin_db_query(
    data_dir: &Path,
    plugin_id: &str,
    db: &str,
    sql: &str,
    params: &[serde_json::Value],
) -> Result<Vec<serde_json::Value>> {
    let pool = open_plugin_db(data_dir, plugin_id, db).await?;
    let args = build_arguments(params)?;
    let rows = sqlx::query_with(sql, args)
        .fetch_all(&pool)
        .await
        .map_err(|e| anyhow::anyhow!("plugin db query failed: {e}"))?;
    Ok(rows.iter().map(row_to_json).collect())
}
