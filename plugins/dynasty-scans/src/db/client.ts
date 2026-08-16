import { DB_NAME } from "../state";
import type { Row } from "../types/db";

const PH = window.PluginHost;

export type { Row };

/** Runs a write query; returns rows affected. */
export async function execute(sql: string, params: unknown[] = []): Promise<number> {
  const resp = await PH.callService("PluginDbExecute", {
    db: DB_NAME,
    sql,
    params,
  });
  if (resp?.Error) throw new Error(String(resp.Error.message));
  return Number(resp?.PluginDbExecuteResult?.rows_affected ?? 0);
}

/** Runs a read query; returns rows as plain objects. */
export async function query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  const resp = await PH.callService("PluginDbQuery", { db: DB_NAME, sql, params });
  if (resp?.Error) throw new Error(String(resp.Error.message));
  return (resp?.PluginDbQueryResult?.rows ?? []) as T[];
}