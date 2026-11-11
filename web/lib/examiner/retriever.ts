/** AAO reasoning retrieval over the FastAPI service (`make api`). Fails loudly, never empty-on-error. */
import type { Passage } from "./citations";

export class RetrievalError extends Error {}

export interface SearchOptions {
  criterion: string;
  visa: "EB-1A";
  k: number;
}

export interface Retriever {
  search(query: string, options: SearchOptions): Promise<Passage[]>;
}

async function getJson(fetchFn: typeof fetch, url: string, timeoutMs: number): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new RetrievalError(`request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new RetrievalError(`${url} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Search returns 600-char snippets; quotes are validated against the full chunk, so fetch it. */
export function httpRetriever(baseUrl: string, fetchFn: typeof fetch = fetch, timeoutMs = 30_000): Retriever {
  const base = baseUrl.replace(/\/$/, "");
  return {
    async search(query, { criterion, visa, k }) {
      const params = new URLSearchParams({ q: query, criterion, visa, k: String(k) });
      const body = await getJson(fetchFn, `${base}/search?${params}`, timeoutMs);
      if (!isRecord(body) || !Array.isArray(body.results)) throw new RetrievalError("search: malformed response");
      return Promise.all(
        body.results.map(async (hit: unknown) => {
          if (!isRecord(hit) || typeof hit.chunk_id !== "number" || typeof hit.decision_id !== "string") {
            throw new RetrievalError("search: malformed hit");
          }
          const p = await getJson(fetchFn, `${base}/passages/${hit.chunk_id}`, timeoutMs);
          if (!isRecord(p) || typeof p.body !== "string" || p.decision_id !== hit.decision_id) {
            throw new RetrievalError(`passage ${hit.chunk_id}: malformed or inconsistent with its search hit`);
          }
          return { chunk_id: hit.chunk_id, decision_id: hit.decision_id, body: p.body };
        }),
      );
    },
  };
}
