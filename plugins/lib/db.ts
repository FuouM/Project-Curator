/**
 * Shared SQLite client factory for plugin-scoped databases.
 *
 * The service exposes two generic sandboxed primitives (`PluginDbExecute` /
 * `PluginDbQuery`) that operate on a database file inside
 * `plugin_data/<plugin_id>/`. This module centralizes error unwrapping, row
 * deserialization, and affected-rows parsing so plugins do not duplicate the
 * transport logic (previously re-implemented in
 * `dynasty-scans/src/db/client.ts` and `aria2-downloader/src/ipc.ts`).
 *
 *   const db = createPluginDb("download_history.db");
 *   const rows = await db.query<HistoryRow>(`SELECT * FROM t ORDER BY id DESC`);
 *   const affected = await db.execute(`DELETE FROM t WHERE id = ?`, [id]);
 *
 * The db file is scoped to the currently-loaded plugin by the host facade, so
 * the same helper is safe to share across all plugins in the workspace.
 */

const PH = window.PluginHost;

/** A plain object row returned by the SQLite sandbox. */
export type Row = Record<string, unknown>;

export interface PluginDb {
  /** Runs a write query; resolves to the number of rows affected. */
  execute(sql: string, params?: unknown[]): Promise<number>;
  /** Runs a read query; resolves to rows deserialized as plain objects. */
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** Creates a typed client bound to `dbName` inside the plugin's data dir. */
export function createPluginDb(dbName: string): PluginDb {
  return {
    async execute(sql: string, params: unknown[] = []): Promise<number> {
      const resp = await PH.callService("PluginDbExecute", { db: dbName, sql, params });
      if (resp?.Error) throw new Error(String(resp.Error.message));
      return Number(resp?.PluginDbExecuteResult?.rows_affected ?? 0);
    },
    async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
      const resp = await PH.callService("PluginDbQuery", { db: dbName, sql, params });
      if (resp?.Error) throw new Error(String(resp.Error.message));
      return (resp?.PluginDbQueryResult?.rows ?? []) as T[];
    },
  };
}
