import { describe, expect, it, vi } from "vitest";
import { makeExamineHandler } from "@/lib/server/examine-handler";
import { RetrievalError } from "@/lib/examiner/retriever";
import { CallCapError } from "@/lib/llm/cached-model";

const petition = {
  id: "P0001", visa: "EB-1A", field: "materials science", beneficiary: "the beneficiary",
  artifacts: [{ id: "A01", kind: "record", title: "Reviews", description: "Two reviews in 2021.", claimed_criterion: "judging" }],
};
const RESULT = { petition_id: "P0001", reviews: [], dropped: [], complete: true, unreviewed: [], criterion_risk: { judging: 0.3 }, rfe_risk: 0.9 };
const post = (body: unknown) => new Request("http://x/api/examine", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

describe("POST /api/examine", () => {
  it("examines a valid petition under the given cutoff and returns the result with llm stats", async () => {
    const examine = vi.fn(async () => RESULT);
    const res = await makeExamineHandler({ examine, stats: () => ({ calls: 3 }) })(post({ petition, before: "2026-06-01" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: RESULT, llm: { calls: 3 } });
    expect(examine).toHaveBeenCalledWith(petition, "2026-06-01");
  });

  it("rejects malformed JSON, an invalid petition and a bad cutoff with 400, without examining", async () => {
    const examine = vi.fn(async () => RESULT);
    const handler = makeExamineHandler({ examine, stats: () => ({}) });
    expect((await handler(post("{not json"))).status).toBe(400);
    const bad = await handler(post({ petition: { ...petition, visa: "O-1" } }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/petition/);
    expect((await handler(post({ petition, before: "June 1" }))).status).toBe(400);
    expect(examine).not.toHaveBeenCalled();
  });

  it("maps retrieval outages to 503 and the call cap to 429, never a 200", async () => {
    const down = makeExamineHandler({ examine: async () => { throw new RetrievalError("api down"); }, stats: () => ({}) });
    expect((await down(post({ petition }))).status).toBe(503);
    const capped = makeExamineHandler({ examine: async () => { throw new CallCapError("cap 5 reached"); }, stats: () => ({}) });
    const res = await capped(post({ petition }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/cap/);
  });

  it("returns 500 with the message for anything else", async () => {
    const boom = makeExamineHandler({ examine: async () => { throw new Error("402 budget"); }, stats: () => ({}) });
    const res = await boom(post({ petition }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/402/);
  });
});
