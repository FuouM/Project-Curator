//! Sandboxed SQLite access for plugins (`PluginDbExecute` / `PluginDbQuery`).
//!
//! Databases live under `plugin_data/<plugin_id>/` and are reached through
//! `curator_core::plugin_db_execute` / `plugin_db_query`, so plugin data can
//! never collide with the core `curator.db`.

use std::sync::Arc;
use tonic::Status;

use crate::ClientContext;

pub async fn execute(
    ctx: &Arc<ClientContext>,
    plugin_id: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    let db = params["db"].as_str().unwrap_or("plugin.db");
    let sql = params["sql"]
        .as_str()
        .ok_or_else(|| Status::invalid_argument("missing sql"))?;
    if plugin_id.is_empty() {
        return Err(Status::invalid_argument("missing plugin_id"));
    }
    let params_arr = params["params"].as_array().cloned().unwrap_or_default();
    match curator_core::plugin_db_execute(&ctx.data_dir, plugin_id, db, sql, &params_arr).await {
        Ok(rows_affected) => Ok(serde_json::json!({
            "PluginDbExecuteResult": { "rows_affected": rows_affected }
        })),
        Err(e) => Ok(serde_json::json!({
            "Error": { "message": e.to_string() }
        })),
    }
}

pub async fn query(
    ctx: &Arc<ClientContext>,
    plugin_id: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, Status> {
    let db = params["db"].as_str().unwrap_or("plugin.db");
    let sql = params["sql"]
        .as_str()
        .ok_or_else(|| Status::invalid_argument("missing sql"))?;
    if plugin_id.is_empty() {
        return Err(Status::invalid_argument("missing plugin_id"));
    }
    let params_arr = params["params"].as_array().cloned().unwrap_or_default();
    match curator_core::plugin_db_query(&ctx.data_dir, plugin_id, db, sql, &params_arr).await {
        Ok(rows) => Ok(serde_json::json!({
            "PluginDbQueryResult": { "rows": rows }
        })),
        Err(e) => Ok(serde_json::json!({
            "Error": { "message": e.to_string() }
        })),
    }
}
