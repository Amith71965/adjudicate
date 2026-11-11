import { describe, expect, it } from "vitest";
import { scoreMerits, type MeritsCase } from "@/lib/merits/merits-eval";
import type { MeritsOutcome } from "@/lib/merits/merits";

const BODY = "the record does not demonstrate that the Petitioner is one of the small percentage at the very top";
const DB = new Map([[11, { chunk_id: 11, decision_id: "D1", body: BODY }]]);
const CITE = { chunk_id: 11, decision_id: "D1", quote: "one of the small percentage at the very top" };

const reviewed = (petition_id: string, favorable: boolean, risk: number, citations = [CITE]): MeritsOutcome => ({
  status: "reviewed", petition_id, attempts: 1, retrieved_chunk_ids: [11], first_attempt_problems: [], pruned: [],
  review: { sustained_acclaim: favorable, top_of_field: favorable, risk, reasoning: "x".repeat(40), citations },
});
const cases: MeritsCase[] = [
  { petition_id: "P01", tier: "strong", pair: 0 }, { petition_id: "P02", tier: "weak", pair: 0 },
  { petition_id: "P03", tier: "strong", pair: 1 }, { petition_id: "P04", tier: "weak", pair: 1 },
];
const good = () => [reviewed("P01", true, 0.2), reviewed("P02", false, 0.8), reviewed("P03", true, 0.3), reviewed("P04", false, 0.7)];

describe("scoreMerits", () => {
  it("passes when every pair is ordered, verdicts match the tier and citations resolve", () => {
    const s = scoreMerits(cases, good(), DB);
    expect(s).toMatchObject({ pairs: 2, ordered_pairs: 2, accuracy: 1, citations: 4, fabricated_citations: 0, dropped: 0 });
    expect(s.gate.passed).toBe(true);
  });

  it("fails when a weak petition scores less risky than its strong twin", () => {
    const out = good();
    out[1] = reviewed("P02", false, 0.1);
    const s = scoreMerits(cases, out, DB);
    expect(s.ordered_pairs).toBe(1);
    expect(s.gate.failures.join(" ")).toMatch(/ordered/);
  });

  it("fails on a wrong verdict and on a citation that does not resolve", () => {
    const out = good();
    out[0] = reviewed("P01", false, 0.2, [{ ...CITE, quote: "words that never appear in that passage at all" }]);
    const s = scoreMerits(cases, out, DB);
    expect(s.confusion).toMatchObject({ strong_unfavorable: 1, weak_unfavorable: 2 });
    expect(s.fabricated_citations).toBe(1);
    expect(s.gate.failures.join(" ")).toMatch(/fabricated/);
  });

  it("counts a dropped review against the gate and leaves its pair unordered", () => {
    const out = good();
    out[3] = { status: "dropped", petition_id: "P04", attempts: 2, retrieved_chunk_ids: [11], reason: "invalid_citations", problems: [] };
    const s = scoreMerits(cases, out, DB);
    expect(s).toMatchObject({ dropped: 1, ordered_pairs: 1 });
    expect(s.gate.failures.join(" ")).toMatch(/dropped/);
  });

  it("rejects outcomes that do not line up with the cases", () => {
    expect(() => scoreMerits(cases, good().slice(1), DB)).toThrow(/one outcome per case/);
  });
});
