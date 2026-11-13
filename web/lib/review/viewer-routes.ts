/**
 * Handlers behind the browser's preview and viewer routes (U2). FastAPI stays server-side;
 * these validate ids first, then map a missing decision to 404 and an outage to 503, so a
 * preview never silently shows nothing.
 */
import { DECISION_ID, ReviewStoreError, type DecisionStore, type Passage } from "./store";

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function failure(err: unknown): Response {
  if (!(err instanceof ReviewStoreError)) throw err;
  return / answered 404/.test(err.message) ? json({ error: "not found" }, 404) : json({ error: "decision service unavailable" }, 503);
}

const CACHE = { "cache-control": "private, max-age=3600" }; // decisions and passages never change

export function makePassageHandler(store: { passage(id: number): Promise<Passage> }) {
  return async (raw: string): Promise<Response> => {
    const id = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id < 1) return json({ error: "not a passage id" }, 400);
    try {
      const p = await store.passage(id);
      return json({ chunk_id: p.chunk_id, decision_id: p.decision_id, section_kind: p.section_kind, criterion: p.criterion, body: p.body }, 200, CACHE);
    } catch (err) {
      return failure(err);
    }
  };
}

export function makePdfHandler(store: Pick<DecisionStore, "decisionPdf">) {
  return async (id: string): Promise<Response> => {
    if (!DECISION_ID.test(id)) return json({ error: "not a decision id" }, 400);
    try {
      const bytes = await store.decisionPdf(id);
      return new Response(bytes, {
        status: 200,
        headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${id}.pdf"`, ...CACHE },
      });
    } catch (err) {
      return failure(err);
    }
  };
}

export function makeLocateHandler(store: Pick<DecisionStore, "locate">) {
  return async (id: string, quote: string): Promise<Response> => {
    if (!DECISION_ID.test(id)) return json({ error: "not a decision id" }, 400);
    if (!quote.trim() || quote.length > 2000) return json({ error: "a quote of 1 to 2000 characters is required" }, 400);
    try {
      return json(await store.locate(id, quote), 200, CACHE);
    } catch (err) {
      return failure(err);
    }
  };
}
