/**
 * POST /api/examine — the examiner over HTTP, so the Python eval harness exercises the one real
 * implementation as a black box. Body: { petition, before? } where `before` (ISO date) binds
 * retrieval to decisions issued before it (the temporal split). Failures are never a 200:
 * 400 bad input, 503 retrieval outage, 429 call cap reached, 500 anything else.
 */
import { petitionSchema } from "@/lib/schemas/petition.zod";
import type { ExaminerResult } from "@/lib/examiner/examiner";
import { RetrievalError } from "@/lib/examiner/retriever";
import { CallCapError } from "@/lib/llm/cached-model";
import type { PetitionInput } from "@/lib/examiner/mapper";

export interface ExamineDeps {
  examine: (petition: PetitionInput, before?: string) => Promise<ExaminerResult>;
  stats: () => object;
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function makeExamineHandler({ examine, stats }: ExamineDeps) {
  return async (req: Request): Promise<Response> => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "body is not JSON" }, 400);
    }
    const raw = (body ?? {}) as { petition?: unknown; before?: unknown };
    const parsed = petitionSchema.safeParse(raw.petition);
    if (!parsed.success) return json({ error: `invalid petition: ${parsed.error.message.slice(0, 500)}` }, 400);
    if (raw.before !== undefined && (typeof raw.before !== "string" || !ISO_DATE.test(raw.before))) {
      return json({ error: "before must be an ISO date (YYYY-MM-DD)" }, 400);
    }
    try {
      const result = await examine(parsed.data as PetitionInput, raw.before as string | undefined);
      return json({ result, llm: stats() }, 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof RetrievalError) return json({ error: `retrieval: ${message}` }, 503);
      if (err instanceof CallCapError) return json({ error: message }, 429);
      return json({ error: message }, 500);
    }
  };
}
