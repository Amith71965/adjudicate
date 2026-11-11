/** Minimal structural type so the check is testable without a live pool. */
export interface Queryable {
  query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
}

export type DbHealth = { ok: true; vector: string } | { ok: false; error: string };

/** Report corpus-DB health. Never throws; never reports ok on a missing extension. */
export async function checkDb(client: Queryable): Promise<DbHealth> {
  try {
    const { rows } = await client.query(
      "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
    );
    const version = rows[0]?.extversion;
    if (typeof version !== "string") {
      return { ok: false, error: "pgvector extension not installed" };
    }
    return { ok: true, vector: version };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
