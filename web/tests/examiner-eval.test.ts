import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { cachedModel, CallCapError } from "@/lib/llm/cached-model";
import { scoreExaminer, type ExaminerCase } from "@/lib/examiner/examiner-eval";
import type { ExaminerResult, ReviewedProng } from "@/lib/examiner/examiner";

function counting(finish: "stop" | "length" = "stop") {
  let calls = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      calls += 1;
      return {
        content: [{ type: "text", text: `answer ${calls}` }],
        finishReason: { unified: finish, raw: undefined },
        usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } },
        warnings: [],
      };
    },
  });
  return { model, calls: () => calls };
}

describe("cachedModel", () => {
  const dir = () => mkdtempSync(path.join(tmpdir(), "adj-cache-"));

  it("serves a repeated request from disk without calling the provider", async () => {
    const inner = counting();
    const d = dir();
    const a = cachedModel(inner.model, { dir: d, version: "v1", maxCalls: 5 });
    const first = await generateText({ model: a.model, prompt: "same" });
    const b = cachedModel(inner.model, { dir: d, version: "v1", maxCalls: 5 });
    const second = await generateText({ model: b.model, prompt: "same" });
    expect(second.text).toBe(first.text);
    expect(inner.calls()).toBe(1);
    expect(b.stats).toMatchObject({ calls: 0, hits: 1 });
    expect(a.stats).toMatchObject({ calls: 1, inputTokens: 100, outputTokens: 20 });
  });

  it("keys on the version, so a prompt-template change refetches", async () => {
    const inner = counting();
    const d = dir();
    await generateText({ model: cachedModel(inner.model, { dir: d, version: "v1", maxCalls: 5 }).model, prompt: "p" });
    await generateText({ model: cachedModel(inner.model, { dir: d, version: "v2", maxCalls: 5 }).model, prompt: "p" });
    expect(inner.calls()).toBe(2);
  });

  it("refuses to send past the call cap", async () => {
    const inner = counting();
    const m = cachedModel(inner.model, { dir: dir(), version: "v1", maxCalls: 1 });
    await generateText({ model: m.model, prompt: "one" });
    await expect(generateText({ model: m.model, prompt: "two", maxRetries: 0 })).rejects.toThrow(CallCapError);
    expect(inner.calls()).toBe(1);
  });

  it("refetches when a cache entry is corrupt instead of failing every run", async () => {
    const inner = counting();
    const d = dir();
    await generateText({ model: cachedModel(inner.model, { dir: d, version: "v1", maxCalls: 5 }).model, prompt: "p" });
    for (const f of readdirSync(d)) writeFileSync(path.join(d, f), "{\"content\": [");
    const again = await generateText({ model: cachedModel(inner.model, { dir: d, version: "v1", maxCalls: 5 }).model, prompt: "p" });
    expect(again.text).toBe("answer 2");
    expect(inner.calls()).toBe(2);
  });

  it("counts calls whose provider reported no usage", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "x" }], finishReason: { unified: "stop", raw: undefined }, warnings: [],
        usage: { inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: undefined, text: undefined, reasoning: undefined } },
      }),
    });
    const m = cachedModel(model, { dir: dir(), version: "v1", maxCalls: 5 });
    await generateText({ model: m.model, prompt: "p" });
    expect(m.stats.unknownUsageCalls).toBe(1);
  });

  it("does not cache a truncated response", async () => {
    const inner = counting("length");
    const d = dir();
    await generateText({ model: cachedModel(inner.model, { dir: d, version: "v1", maxCalls: 5 }).model, prompt: "p" });
    expect(readdirSync(d)).toHaveLength(0);
  });
});

const reviewed = (criterion: string, prong: string, facially_met: boolean, citations = [{ chunk_id: 7, decision_id: "D1", quote: "the organization has a distinguished reputation" }]): ReviewedProng => ({
  status: "reviewed", criterion, prong, artifact_ids: ["A01"], attempts: 1, retrieved_chunk_ids: [7],
  first_attempt_problems: [], pruned: [],
  review: { facially_met, risk: facially_met ? 0.2 : 0.8, objection: "An objection of sufficient length.", citations },
});
const result = (reviews: ReviewedProng[]): ExaminerResult => ({ petition_id: "P01", reviews, dropped: [], criterion_risk: {}, rfe_risk: 0.5 });
const DB = new Map([[7, { chunk_id: 7, decision_id: "D1", body: "Here the organization has a distinguished reputation in its field." }]]);

const baseCase = (reviews: ReviewedProng[], waiverCriteria: string[] = ["scholarly_articles"]): ExaminerCase => ({
  petition_id: "P01",
  claimed: { A01: "leading_role", A02: "membership" },
  planted_halves: [{ artifact_id: "A01", criterion: "leading_role", missing_prongs: ["reputation"] }],
  planted_unclaimed: [{ artifact_id: "A05", criterion: "scholarly_articles" }],
  result: result(reviews),
  waiver: waiverCriteria.map((c) => ({ kind: "unclaimed_supported" as const, criterion: c, artifact_ids: ["A05"], message: "m" })),
});

describe("scoreExaminer", () => {
  const goodReviews = () => [
    reviewed("leading_role", "role", true), reviewed("leading_role", "reputation", false),
    reviewed("membership", "requirement", true), reviewed("membership", "judged", true),
  ];

  it("counts objections and re-verifies every citation against the database", () => {
    const s = scoreExaminer([baseCase(goodReviews())], DB, { minObjections: 4 });
    expect(s.objections).toBe(4);
    expect(s.citations).toBe(4);
    expect(s.fabricated_citations).toBe(0);
    expect(s.gate.passed).toBe(true);
  });

  it("flags a citation that does not resolve to the database passage", () => {
    const bad = goodReviews();
    bad[0] = reviewed("leading_role", "role", true, [{ chunk_id: 8, decision_id: "D1", quote: "the organization has a distinguished reputation" }]);
    const s = scoreExaminer([baseCase(bad)], DB, { minObjections: 4 });
    expect(s.fabricated_citations).toBe(1);
    expect(s.gate.passed).toBe(false);
  });

  it("catches a planted half only when the missing prong is judged not facially_met", () => {
    const missed = goodReviews();
    missed[1] = reviewed("leading_role", "reputation", true);
    const s = scoreExaminer([baseCase(missed)], DB, { minObjections: 4 });
    expect(s.mode_b).toMatchObject({ planted: 1, caught: 0 });
    expect(s.gate.failures.join(" ")).toMatch(/mode B/);
  });

  it("reports false flags on fully evidenced two-part claims without gating on them", () => {
    const flagged = goodReviews();
    flagged[3] = reviewed("membership", "judged", false);
    const s = scoreExaminer([baseCase(flagged)], DB, { minObjections: 4 });
    expect(s.full_claim_prongs).toMatchObject({ total: 2, flagged: 1 });
    expect(s.gate.passed).toBe(true);
  });

  it("catches planted mode D only through an unclaimed_supported finding for that criterion", () => {
    expect(scoreExaminer([baseCase(goodReviews())], DB, { minObjections: 4 }).mode_d.caught).toBe(1);
    const s = scoreExaminer([baseCase(goodReviews(), ["judging"])], DB, { minObjections: 4 });
    expect(s.mode_d.caught).toBe(0);
    expect(s.gate.passed).toBe(false);
  });

  it("fails the gate below the objection floor", () => {
    expect(scoreExaminer([baseCase(goodReviews())], DB, { minObjections: 100 }).gate.passed).toBe(false);
  });
  it("never passes vacuously: no planted cases, or a planted half naming no prong", () => {
    const none = { ...baseCase(goodReviews()), planted_halves: [], planted_unclaimed: [] };
    const s1 = scoreExaminer([none], DB, { minObjections: 4 });
    expect(s1.gate.failures.join(" ")).toMatch(/no planted mode-B/);
    const blank = baseCase(goodReviews());
    blank.planted_halves = [{ artifact_id: "A01", criterion: "leading_role", missing_prongs: [] }];
    expect(scoreExaminer([blank], DB, { minObjections: 4 }).mode_b.caught).toBe(0);
  });

  it("fails the gate when too many prongs were dropped unreviewed", () => {
    const c = baseCase(goodReviews());
    c.result.dropped = [{ status: "dropped", criterion: "judging", prong: "whole", artifact_ids: ["A02"], attempts: 2,
      retrieved_chunk_ids: [7], reason: "invalid_citations", problems: [] }];
    const s = scoreExaminer([c], DB, { minObjections: 4, maxDroppedRatio: 0.05 });
    expect(s.gate.failures.join(" ")).toMatch(/dropped/);
  });
});
