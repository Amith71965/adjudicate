import { describe, expect, it } from "vitest";
import { PRONGS, prongsFor } from "@/lib/examiner/prongs";
import { waiverFindings } from "@/lib/examiner/waiver";
import { validateCitations, type Passage } from "@/lib/examiner/citations";

const CRITS = ["awards", "membership", "published_material", "judging", "original_contributions",
  "scholarly_articles", "display", "leading_role", "high_salary", "commercial_success"] as const;
const row = (id: string, best: string | null, strength: number) => ({
  artifact_id: id, best_criterion: best, strength, rationale: "r",
  scores: CRITS.map((c) => ({ criterion: c, strength: c === best ? strength : 0.05 })),
});

describe("two-part criteria", () => {
  it("decomposes leading role into role and reputation", () => {
    expect(prongsFor("leading_role").map((p) => p.id)).toEqual(["role", "reputation"]);
  });
  it("covers exactly the four two-part criteria; others are single-prong", () => {
    expect(Object.keys(PRONGS).sort()).toEqual(["leading_role", "membership", "original_contributions", "published_material"]);
    expect(prongsFor("judging")).toHaveLength(1);
  });
});

describe("waiver and claim completeness (failure mode D)", () => {
  const artifacts = [
    { id: "A01", claimed_criterion: "judging" },
    { id: "A02", claimed_criterion: null },
    { id: "A03", claimed_criterion: "awards" },
  ];
  const mapping = { petition_id: "P01", mappings: [row("A01", "judging", 0.9), row("A02", "scholarly_articles", 0.85), row("A03", null, 0)] };

  it("flags supported-but-unclaimed criteria with the waiver authority", () => {
    const f = waiverFindings(artifacts, mapping);
    const unclaimed = f.find((x) => x.kind === "unclaimed_supported");
    expect(unclaimed).toMatchObject({ criterion: "scholarly_articles", artifact_ids: ["A02"] });
    expect(unclaimed?.message).toMatch(/O-R-E-/);
  });
  it("flags a claimed criterion with no supporting artifact", () => {
    expect(waiverFindings(artifacts, mapping).some((x) => x.kind === "claimed_unsupported" && x.criterion === "awards")).toBe(true);
  });
  it("flags fewer than three supported claimed criteria", () => {
    expect(waiverFindings(artifacts, mapping).some((x) => x.kind === "below_three")).toBe(true);
  });
});

describe("citation validation", () => {
  const passages: Passage[] = [
    { chunk_id: 7, decision_id: "NOV212025_01B2203", body: "these documents do not sufficiently discuss or otherwise establish the distinguished reputation" },
  ];
  it("accepts a verbatim quote from a retrieved passage", () => {
    expect(validateCitations([{ chunk_id: 7, decision_id: "NOV212025_01B2203", quote: "do not sufficiently discuss or otherwise establish" }], passages)).toEqual([]);
  });
  it("rejects a chunk that was not retrieved, a wrong decision id, and a non-verbatim quote", () => {
    const problems = validateCitations([
      { chunk_id: 99, decision_id: "NOV212025_01B2203", quote: "x" },
      { chunk_id: 7, decision_id: "SEP152026_01B2203", quote: "distinguished reputation" },
      { chunk_id: 7, decision_id: "NOV212025_01B2203", quote: "the organization is world famous" },
    ], passages);
    expect(problems.map((p) => p.reason)).toEqual(["chunk_not_retrieved", "decision_mismatch", "quote_not_verbatim"]);
  });
  it("matches quotes ignoring whitespace and line breaks", () => {
    expect(validateCitations([{ chunk_id: 7, decision_id: "NOV212025_01B2203", quote: "discuss or otherwise\n  establish the distinguished" }], passages)).toEqual([]);
  });
  it("rejects quotes too short to be evidence once whitespace is collapsed", () => {
    const padded = { chunk_id: 7, decision_id: "NOV212025_01B2203", quote: "the" + " ".repeat(27) };
    expect(validateCitations([padded], passages).map((p) => p.reason)).toEqual(["quote_too_short"]);
  });
  it("treats a change of case as not verbatim", () => {
    const shouted = { chunk_id: 7, decision_id: "NOV212025_01B2203", quote: "DO NOT SUFFICIENTLY DISCUSS OR OTHERWISE ESTABLISH" };
    expect(validateCitations([shouted], passages).map((p) => p.reason)).toEqual(["quote_not_verbatim"]);
  });
  it("rejects a repeated citation", () => {
    const c = { chunk_id: 7, decision_id: "NOV212025_01B2203", quote: "do not sufficiently discuss or otherwise establish" };
    expect(validateCitations([c, { ...c, quote: c.quote + " " }], passages).map((p) => p.reason)).toEqual(["duplicate"]);
  });
});

describe("waiver input completeness", () => {
  it("refuses a mapping that omits a claimed artifact instead of calling it unsupported", () => {
    expect(() => waiverFindings([{ id: "A01", claimed_criterion: "judging" }], { mappings: [] })).toThrow(/A01/);
  });
});
