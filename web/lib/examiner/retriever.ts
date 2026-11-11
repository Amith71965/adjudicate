/** AAO reasoning retrieval over the FastAPI service (`make api`). Fails loudly, never empty-on-error. */
import type { Passage } from "./citations";

export class RetrievalError extends Error {}

export interface SearchOptions {
  criterion?: string; // reasoning on one criterion
  section?: "final_merits" | "criterion" | "analysis"; // reasoning of one kind (step two: final_merits)
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
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new RetrievalError(`${url} answered non-JSON: ${text.slice(0, 120)}`);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Search returns 600-char snippets; quotes are validated against the full chunk, so fetch it. */
export function httpRetriever(baseUrl: string, fetchFn: typeof fetch = fetch, timeoutMs = 30_000): Retriever {
  const base = baseUrl.replace(/\/$/, "");
  return {
    async search(query, { criterion, section, visa, k }) {
      const params = new URLSearchParams({ q: query });
      if (criterion !== undefined) params.set("criterion", criterion);
      if (section !== undefined) params.set("section", section);
      params.set("visa", visa);
      params.set("k", String(k));
      const body = await getJson(fetchFn, `${base}/search?${params}`, timeoutMs);
      if (!isRecord(body) || !Array.isArray(body.results)) throw new RetrievalError("search: malformed response");
      // an API that predates the section filter ignores it silently: require the echo
      if (section !== undefined && (!isRecord(body.filters) || body.filters.section !== section)) {
        throw new RetrievalError(`search: the API did not confirm the section filter "${section}"`);
      }
      const hits: { chunk_id: number; decision_id: string }[] = [];
      for (const hit of body.results as unknown[]) {
        if (!isRecord(hit) || typeof hit.chunk_id !== "number" || typeof hit.decision_id !== "string") {
          throw new RetrievalError("search: malformed hit");
        }
        if (!hits.some((h) => h.chunk_id === hit.chunk_id)) hits.push({ chunk_id: hit.chunk_id, decision_id: hit.decision_id });
      }
      return Promise.all(
        hits.map(async (hit) => {
          const p = await getJson(fetchFn, `${base}/passages/${hit.chunk_id}`, timeoutMs);
          if (!isRecord(p) || typeof p.body !== "string" || !p.body.trim() || p.decision_id !== hit.decision_id) {
            throw new RetrievalError(`passage ${hit.chunk_id}: malformed or inconsistent with its search hit`);
          }
          return { chunk_id: hit.chunk_id, decision_id: hit.decision_id, body: p.body };
        }),
      );
    },
  };
}
