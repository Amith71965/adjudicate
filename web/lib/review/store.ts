/**
 * Server-side client for the review log and AAO passages behind the FastAPI service
 * (`make api`). Python owns the database (ADR-022); this only speaks HTTP. Every failure
 * throws: a log that is down must never render as "no history yet".
 */
import type { ReviewAction, ReviewEvent } from "./state";

export class ReviewStoreError extends Error {}
/** The log moved on since the caller read it (another tab, a retried request): reload, never append. */
export class ReviewConflictError extends ReviewStoreError {}

export interface Passage {
  chunk_id: number;
  decision_id: string;
  url: string;
  section_kind: string;
  criterion: string | null;
  body: string;
  start_char: number;
  end_char: number;
}

export interface NewEvent {
  item_id: string | null;
  action: ReviewAction;
  note: string;
  actor: string;
  /** id of the last event the caller saw (0: none); the API refuses the write if the log moved */
  expected_last_id: number;
}

export interface ReviewStore {
  events(caseId: string): Promise<ReviewEvent[]>;
  append(caseId: string, event: NewEvent): Promise<ReviewEvent>;
  passage(chunkId: number): Promise<Passage>;
}

const CASE_ID = /^P\d{2,4}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

async function call(fetchFn: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new ReviewStoreError(`request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  if (res.status === 409) throw new ReviewConflictError(`${url} answered 409: ${text.slice(0, 300)}`);
  if (!res.ok) throw new ReviewStoreError(`${url} answered ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new ReviewStoreError(`${url} answered non-JSON: ${text.slice(0, 120)}`);
  }
}

export function httpReviewStore(baseUrl: string, fetchFn: typeof fetch = fetch, timeoutMs = 10_000): ReviewStore {
  const base = baseUrl.replace(/\/$/, "");
  const caseUrl = (caseId: string) => {
    if (!CASE_ID.test(caseId)) throw new ReviewStoreError(`not a case id: ${JSON.stringify(caseId)}`);
    return `${base}/cases/${caseId}/events`;
  };
  return {
    async events(caseId) {
      const url = caseUrl(caseId);
      const body = await call(fetchFn, url, {}, timeoutMs);
      if (!isRecord(body) || !Array.isArray(body.events)) throw new ReviewStoreError(`${url}: malformed response`);
      return body.events as ReviewEvent[];
    },
    async append(caseId, event) {
      const url = caseUrl(caseId);
      const body = await call(fetchFn, url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      }, timeoutMs);
      if (!isRecord(body) || typeof body.id !== "number") throw new ReviewStoreError(`${url}: malformed response`);
      return body as unknown as ReviewEvent;
    },
    async passage(chunkId) {
      if (!Number.isInteger(chunkId) || chunkId < 1) throw new ReviewStoreError(`not a chunk id: ${chunkId}`);
      const url = `${base}/passages/${chunkId}`;
      const body = await call(fetchFn, url, {}, timeoutMs);
      if (!isRecord(body) || typeof body.body !== "string") throw new ReviewStoreError(`${url}: malformed response`);
      return body as unknown as Passage;
    },
  };
}

/**
 * Where a citation's quote sits in its passage, as [start, end) offsets into `body`.
 * Whitespace is compared loosely (the corpus text keeps PDF line breaks); null = not found.
 */
export function locateQuote(body: string, quote: string): [number, number] | null {
  const starts: number[] = []; // starts[i] = offset in body of normalized char i
  let norm = "";
  for (let i = 0; i < body.length; i++) {
    if (/\s/.test(body[i])) {
      if (norm.endsWith(" ") || norm === "") continue;
      norm += " ";
    } else {
      norm += body[i];
    }
    starts.push(i);
  }
  const target = quote.replace(/\s+/g, " ").trim();
  if (!target) return null;
  const at = norm.indexOf(target);
  if (at < 0) return null;
  return [starts[at], starts[at + target.length - 1] + 1];
}
