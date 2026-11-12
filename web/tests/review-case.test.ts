/**
 * Phase 8 case model: a synthetic petition + its recorded examiner run → the list of AI
 * claims an attorney must dispose of before export. Only the petition is shown — the
 * synthetic answer key (truth / planted flaws) never reaches the UI.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PetitionInput } from "@/lib/examiner/mapper";
import { buildCase, loadCases, type RecordedRun } from "@/lib/review/cases";

const PETITION: PetitionInput = {
  id: "P90",
  visa: "EB-1A",
  field: "marine robotics",
  beneficiary: "Dr. Example Person",
  artifacts: [
    { id: "A01", kind: "record", title: "Review invitations", description: "Editor emails.", claimed_criterion: "judging" },
    { id: "A02", kind: "contract", title: "Pay statement", description: "Salary survey." },
  ],
};

const CITE = { chunk_id: 7, decision_id: "JAN012026_01B2203", quote: "Petitioners must show that they actually participated in judging." };

const RUN: RecordedRun = {
  petition_id: "P90",
  rfe_risk: 0.6,
  criterion_risk: { judging: 0.5, leading_role: 1 },
  complete: false,
  reviews: [
    { criterion: "judging", prong: "whole", artifact_ids: ["A01"], facially_met: true, risk: 0.5, objection: "Invitations alone are not judging.", citations: [CITE] },
  ],
  waiver: [
    { kind: "unclaimed_supported", criterion: "high_salary", artifact_ids: ["A02"], message: "Evidence supports high_salary but it is not claimed." },
  ],
  dropped: [{ criterion: "leading_role", prong: "role", artifact_ids: ["A01"], reason: "invalid_citations" }],
};

describe("buildCase", () => {
  const c = buildCase(PETITION, RUN, { model: "m", cache_version: "v" });

  it("turns every review, waiver finding and unreviewed prong into an item to dispose of", () => {
    expect(c.items.map((i) => [i.kind, i.id])).toEqual([
      ["manual", "manual:leading_role/role"], // highest risk first: 1.0 for an ungrounded prong
      ["prong", "prong:judging/whole"],
      ["waiver", "waiver:unclaimed_supported:high_salary"],
    ]);
  });

  it("keeps the AI objection with its citations", () => {
    const prong = c.items.find((i) => i.kind === "prong");
    expect(prong).toMatchObject({ objection: "Invitations alone are not judging.", citations: [CITE], risk: 0.5 });
  });

  it("refuses an AI objection with no citation instead of showing it ungrounded", () => {
    const bad = { ...RUN, reviews: [{ ...RUN.reviews[0], citations: [] }] };
    expect(() => buildCase(PETITION, bad, { model: "m", cache_version: "v" })).toThrow(/no citation/);
  });

  it.each([
    [{ ...CITE, quote: "  " }, /quote/],
    [{ ...CITE, chunk_id: 0 }, /chunk/],
    [{ ...CITE, decision_id: "" }, /decision/],
  ])("refuses a citation that cannot be checked: %j", (cite, error) => {
    const bad = { ...RUN, reviews: [{ ...RUN.reviews[0], citations: [cite] }] };
    expect(() => buildCase(PETITION, bad, { model: "m", cache_version: "v" })).toThrow(error);
  });

  it("refuses a run that belongs to another petition", () => {
    expect(() => buildCase(PETITION, { ...RUN, petition_id: "P91" }, { model: "m", cache_version: "v" })).toThrow(/P91/);
  });

  it("refuses a finding that names evidence the petition does not have", () => {
    const bad = { ...RUN, waiver: [{ ...RUN.waiver[0], artifact_ids: ["A99"] }] };
    expect(() => buildCase(PETITION, bad, { model: "m", cache_version: "v" })).toThrow(/A99/);
  });
});

describe("loadCases (committed phase-5 run)", () => {
  const cases = loadCases(path.resolve(__dirname, "../.."));

  it("loads the 16 synthetic cases in id order", () => {
    expect(cases.map((c) => c.id)).toEqual(Array.from({ length: 16 }, (_, i) => `P${String(i + 1).padStart(2, "0")}`));
  });

  it("gives every item a unique id the review log accepts", () => {
    for (const c of cases) {
      const ids = c.items.map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^[a-z]+:[a-z0-9_/:-]{1,80}$/);
    }
  });

  it("never carries the synthetic answer key", () => {
    expect(JSON.stringify(cases)).not.toMatch(/"(truth|planted_halves|planted_unclaimed)"/);
  });
});
