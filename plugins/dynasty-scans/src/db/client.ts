import { createPluginDb } from "../../../lib";
import { DB_NAME } from "../state";
import type { Row } from "../types/db";

export type { Row };

/**
 * Plugin-scoped SQLite client bound to `dynasty_reader.db`.
 *
 * Implemented entirely on top of the shared `createPluginDb` factory in
 * `plugins/lib/db.ts` so error unwrapping and row deserialization stay
 * identical across every plugin in the workspace.
 */
const db = createPluginDb(DB_NAME);

/** Runs a write query; returns rows affected. */
export const execute = db.execute;

/** Runs a read query; returns rows as plain objects. */
export const query = db.query;
