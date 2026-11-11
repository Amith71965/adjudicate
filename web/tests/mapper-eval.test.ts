import { describe, expect, it } from "vitest";
import { scoreMapper } from "@/lib/examiner/mapper-eval";

describe("scoreMapper", () => {
  it("computes top-1 accuracy, mode-A recall and false flags", () => {
    const s = scoreMapper([
      { truth: { A01: "judging", A02: null, A03: "awards" }, predicted: { A01: "judging", A02: null, A03: "membership" },
        planted: ["A03"], flagged: ["A03", "A01"] },
      { truth: { A01: "display" }, predicted: { A01: "display" }, planted: ["A01"], flagged: [] },
    ]);
    expect(s.top1).toBeCloseTo(3 / 4);
    expect(s.modeARecall).toBeCloseTo(1 / 2);
    expect(s.falseFlags).toBe(1);
    expect(s.artifacts).toBe(4);
  });

  it("refuses to score an empty set", () => {
    expect(() => scoreMapper([])).toThrow(/empty/);
  });
});
