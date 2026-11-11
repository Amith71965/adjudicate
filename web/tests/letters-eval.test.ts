import { describe, expect, it } from "vitest";
import { scoreLetters, type LetterCase } from "@/lib/letters/letters-eval";
import type { LetterOutcome, PacketReview } from "@/lib/letters/mechanism";

const reviewed = (letter_id: string, labels: ("mechanism" | "assertion" | "context")[]): LetterOutcome => ({
  status: "reviewed", letter_id, attempts: 1, labels, reasons: labels.map(() => "r"), first_attempt_problems: [],
  assertions: labels.flatMap((l, i) => (l === "assertion" ? [i] : [])), weak: !labels.includes("mechanism"),
});
const sentences = (n: number) => Array.from({ length: n }, (_, i) => `sentence ${i}`);

function makeCase(letters: LetterOutcome[], over: Partial<PacketReview> = {}): { c: LetterCase; r: PacketReview } {
  const c: LetterCase = {
    packet: {
      petition_id: "P01", field: "f",
      beneficiary: { name: "B", affiliations: ["O"], publications: [] },
      letters: ["L01", "L02"].map((id) => ({ id, sentences: sentences(3), author: { name: "A", title: "T", affiliations: ["X"], claimed_independent: true } })),
    },
    kinds: {
      L01: ["context", "mechanism_superlative", "assertion_plain"],
      L02: ["context", "assertion_superlative", "mechanism_plain"],
    },
    planted_boilerplate: [["L01", "L02"]],
    planted_violations: [{ letter_id: "L02", kind: "coauthor" }],
    near_misses: [{ letter_id: "L01", kind: "surname" }],
  };
  const r: PacketReview = {
    petition_id: "P01", letters, complete: true, unreviewed: [],
    boilerplate: [{ a: "L01", b: "L02", shared: 20, passage: "p" }],
    independence: [
      { letter_id: "L01", claimed_independent: true, ties: [], violation: false },
      { letter_id: "L02", claimed_independent: true, ties: [{ kind: "coauthor", via: "t" }], violation: true },
    ],
    ...over,
  };
  return { c, r };
}
const perfect = () => [reviewed("L01", ["context", "mechanism", "assertion"]), reviewed("L02", ["context", "assertion", "mechanism"])];
const score = (x: { c: LetterCase; r: PacketReview }) => scoreLetters([x.c], [x.r]);

describe("scoreLetters", () => {
  it("passes a perfect review and reports the lexicon baseline beside it", () => {
    const s = score(makeCase(perfect()));
    expect(s.mode_c).toMatchObject({ tp: 2, fp: 0, fn: 0, precision: 1, recall: 1 });
    expect(s.mode_c.by_kind.mechanism_superlative).toEqual({ n: 1, flagged: 0 });
    expect(s.lexicon).toHaveProperty("precision");
    expect(s.gate.passed).toBe(true);
  });

  it("fails on low mode-C recall, counting a dropped letter's assertions as missed", () => {
    const dropped: LetterOutcome = { status: "dropped", letter_id: "L02", attempts: 2, reason: "invalid_output", problems: [] };
    const s = score(makeCase([perfect()[0], dropped], { complete: false, unreviewed: ["L02"] }));
    expect(s.mode_c).toMatchObject({ tp: 1, fn: 1, recall: 0.5 });
    expect(s.dropped).toBe(1);
    expect(s.gate.failures.join(" ")).toMatch(/mode C recall/);
    expect(s.gate.failures.join(" ")).toMatch(/dropped/);
  });

  it("fails on low mode-C precision when mechanisms are flagged", () => {
    const s = score(makeCase([reviewed("L01", ["assertion", "assertion", "assertion"]), perfect()[1]]));
    expect(s.mode_c.precision).toBeCloseTo(0.5);
    expect(s.gate.failures.join(" ")).toMatch(/mode C precision/);
  });

  it("fails when a planted boilerplate pair or violation is missed, and counts false ones", () => {
    const s = score(makeCase(perfect(), {
      boilerplate: [],
      independence: [
        { letter_id: "L01", claimed_independent: true, ties: [{ kind: "coauthor", via: "t" }], violation: true },
        { letter_id: "L02", claimed_independent: true, ties: [], violation: false },
      ],
    }));
    expect(s.boilerplate).toMatchObject({ planted: 1, found: 0 });
    expect(s.independence).toMatchObject({ planted: 1, found: 0, false_violations: 1, near_misses_flagged: 1 });
    expect(s.gate.failures.join(" ")).toMatch(/boilerplate/);
    expect(s.gate.failures.join(" ")).toMatch(/independence/);
  });

  it("never passes vacuously with nothing planted", () => {
    const x = makeCase(perfect());
    x.c.planted_boilerplate = [];
    x.c.planted_violations = [];
    x.r.boilerplate = [];
    x.r.independence = x.r.independence.map((t) => ({ ...t, violation: false, ties: [] }));
    expect(score(x).gate.failures.join(" ")).toMatch(/nothing planted/);
  });

  it("rejects reviews that do not line up with the cases", () => {
    const x = makeCase(perfect());
    expect(() => scoreLetters([x.c], [])).toThrow(/one review per case/);
    expect(() => scoreLetters([x.c], [{ ...x.r, petition_id: "P02" }])).toThrow(/P01/);
  });
});
