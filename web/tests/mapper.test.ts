import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { findMismatches, mapPetition, MapperError } from "@/lib/examiner/mapper";
import type { PetitionInput, PetitionMapping } from "@/lib/examiner/mapper";

const CRITERIA = ["awards", "membership", "published_material", "judging", "original_contributions",
  "scholarly_articles", "display", "leading_role", "high_salary", "commercial_success"] as const;

const petition: PetitionInput = {
  id: "P01", visa: "EB-1A", field: "computational biology", beneficiary: "Dr. Avery Quillfeather",
  artifacts: [
    { id: "A01", kind: "publication", title: "Peer-reviewed journal articles", description: "Three articles.", claimed_criterion: "leading_role" },
    { id: "A02", kind: "record", title: "Peer-review records", description: "Reviews completed.", claimed_criterion: "judging" },
    { id: "A03", kind: "certificate", title: "Online course", description: "Completion certificate.", claimed_criterion: null },
  ],
};

const row = (best: string | null, strength: number, extra: Record<string, number> = {}) => ({
  best_criterion: best, strength, rationale: "because",
  scores: CRITERIA.map((c) => ({ criterion: c, strength: c === best ? strength : (extra[c] ?? 0.05) })),
});

const GOOD: PetitionMapping = {
  petition_id: "P01",
  mappings: [
    { artifact_id: "A01", ...row("scholarly_articles", 0.92, { leading_role: 0.1 }) },
    { artifact_id: "A02", ...row("judging", 0.9) },
    { artifact_id: "A03", ...row(null, 0.0) },
  ] as PetitionMapping["mappings"],
};

const model = (payload: unknown) =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(payload) }],
      finishReason: { unified: "stop", raw: undefined },
      usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } },
      warnings: [],
    }),
  });

describe("mapPetition", () => {
  it("returns a schema-valid artifacts x criteria matrix", async () => {
    const out = await mapPetition(petition, { model: model(GOOD) });
    expect(out.mappings).toHaveLength(3);
    expect(out.mappings[0].scores).toHaveLength(10);
  });

  it("rejects a mapping that omits or invents an artifact", async () => {
    const missing = { ...GOOD, mappings: GOOD.mappings.slice(0, 2) };
    await expect(mapPetition(petition, { model: model(missing) })).rejects.toThrow(MapperError);
    const extra = { ...GOOD, mappings: [...GOOD.mappings, { ...GOOD.mappings[0], artifact_id: "A99" }] };
    await expect(mapPetition(petition, { model: model(extra) })).rejects.toThrow(/A99/);
  });

  it("rejects a score row that is not exactly the ten criteria", async () => {
    const bad = structuredClone(GOOD);
    bad.mappings[1].scores = bad.mappings[1].scores.slice(0, 9);
    await expect(mapPetition(petition, { model: model(bad) })).rejects.toThrow(/ten criteria/);
  });
});

describe("findMismatches (failure mode A)", () => {
  it("flags evidence filed under a criterion it does not support", () => {
    const flags = findMismatches(petition, GOOD);
    expect(flags).toEqual([
      expect.objectContaining({ artifact_id: "A01", claimed: "leading_role", suggested: "scholarly_articles" }),
    ]);
  });

  it("does not flag a claim that is also a strong fit", () => {
    const both = structuredClone(GOOD);
    both.mappings[0].scores = both.mappings[0].scores.map((s) => (s.criterion === "leading_role" ? { ...s, strength: 0.7 } : s));
    expect(findMismatches(petition, both)).toEqual([]);
  });

  it("never flags artifacts with no claimed criterion", () => {
    expect(findMismatches(petition, GOOD).map((f) => f.artifact_id)).not.toContain("A03");
  });
});

describe("validateMapping (applied to fresh and cached outputs)", () => {
  it("rejects a mapping for a different petition", async () => {
    const { validateMapping } = await import("@/lib/examiner/mapper");
    expect(() => validateMapping(petition, { ...GOOD, petition_id: "P99" })).toThrow(/P99/);
  });

  it("rejects a best_criterion that contradicts the scores", async () => {
    const { validateMapping } = await import("@/lib/examiner/mapper");
    const bad = structuredClone(GOOD);
    bad.mappings[1].best_criterion = "awards";
    expect(() => validateMapping(petition, bad)).toThrow(/best_criterion/);
  });
});
