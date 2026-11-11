import { describe, expect, it } from "vitest";
import { boilerplatePairs, shingles } from "@/lib/letters/boilerplate";
import { independenceTies, nameKey, orgKey } from "@/lib/letters/independence";
import { lexiconLabel, superlativeHits } from "@/lib/letters/lexicon";
import type { LetterPacket } from "@/lib/letters/types";

describe("superlative lexicon (the baseline the LLM has to beat)", () => {
  it("finds superlatives on word boundaries, case-insensitively", () => {
    expect(superlativeHits("She is one of the MOST brilliant minds, truly world-class.")).toEqual(
      ["most", "brilliant", "truly", "world-class"],
    );
    expect(superlativeHits("Topology mostly matters to the bestiary.")).toEqual([]);
  });
  it("labels a sentence assertion only when a superlative appears", () => {
    expect(lexiconLabel("Their achievements are remarkable by any standard.")).toBe("assertion");
    // the lexicon's blind spot: vague praise with no superlative word
    expect(lexiconLabel("The importance of this research cannot be overstated.")).toBe("other");
  });
});

describe("boilerplate across letters", () => {
  const block =
    "As an expert in the field I can state that Dr. Rowan Vale has made original contributions " +
    "of major significance. The research of Dr. Rowan Vale has been widely cited and relied upon " +
    "by researchers across the world.";
  const letter = (id: string, sentences: string[]) => ({ id, sentences });

  it("shingles normalized words, ignoring case and punctuation", () => {
    expect([...shingles("A, b. C d!", 3)]).toEqual(["a b c", "b c d"]);
    expect(shingles("too short", 3).size).toBe(0);
  });

  it("flags a pair that shares a copied passage and reports the passage", () => {
    const pairs = boilerplatePairs([
      letter("L01", ["I lead a lab at Fallowmere University.", block, "Their library cut costs by 30 percent."]),
      letter("L02", ["Please accept this letter for Dr. Rowan Vale.", block.replace("As an expert", "As a specialist")]),
      letter("L03", ["I know Dr. Rowan Vale has made original contributions to computing."]),
    ]);
    expect(pairs.map((p) => [p.a, p.b])).toEqual([["L01", "L02"]]);
    expect(pairs[0].passage).toContain("has been widely cited and relied upon by researchers across the world");
    expect(pairs[0].shared).toBeGreaterThan(10);
  });

  it("does not flag letters that only share short stock phrases", () => {
    const pairs = boilerplatePairs([
      letter("L01", ["The work of Dr. Rowan Vale has changed how practitioners think about grids."]),
      letter("L02", ["The work of Dr. Rowan Vale was adopted by two utilities in 2022."]),
    ]);
    expect(pairs).toEqual([]);
  });
});

describe("independence ties", () => {
  it("normalizes printed names to surname plus first initial", () => {
    expect(nameKey("Prof. Tamsin Okafor-Lind")).toBe("okafor-lind|t");
    expect(nameKey("Okafor-Lind, T.")).toBe("okafor-lind|t");
    expect(nameKey("T. Okafor-Lind")).toBe("okafor-lind|t");
    expect(nameKey("Dr. Joaquin Okafor-Lind")).toBe("okafor-lind|j");
  });
  it("normalizes organization names but keeps distinct organizations distinct", () => {
    const k = orgKey("Corvid Analytics");
    expect(orgKey("The Corvid Analytics")).toBe(k);
    expect(orgKey("Corvid Analytics (visiting appointment)")).toBe(k);
    expect(orgKey("Corvid Analytics, main campus")).toBe(k);
    expect(orgKey("Corvid Heritage Society")).not.toBe(k);
  });

  const packet: LetterPacket = {
    petition_id: "P01",
    field: "computing",
    beneficiary: {
      name: "Dr. Rowan Vale",
      affiliations: ["Northsea Grid Consortium", "Corvid Analytics"],
      publications: [{ title: "A benchmark for grids", authors: ["Vale, R.", "Okafor-Lind, T."] }],
    },
    letters: [
      { id: "L01", sentences: ["x"], author: { name: "Dr. Tamsin Okafor-Lind", title: "Professor", affiliations: ["Larchmont College"], claimed_independent: true } },
      { id: "L02", sentences: ["x"], author: { name: "Bram Solvang", title: "Director", affiliations: ["Saltmarsh University", "The Corvid Analytics"], claimed_independent: true } },
      { id: "L03", sentences: ["x"], author: { name: "Dr. Joaquin Okafor-Lind", title: "Professor", affiliations: ["Northsea Heritage Society"], claimed_independent: true } },
      { id: "L04", sentences: ["x"], author: { name: "Prof. Tamsin Okafor-Lind", title: "Professor", affiliations: ["Northsea Grid Consortium"], claimed_independent: false } },
    ],
  };

  it("finds co-authorship and shared affiliations, and flags only letters claimed independent", () => {
    const ties = independenceTies(packet);
    expect(ties.map((t) => [t.letter_id, t.violation])).toEqual([
      ["L01", true], ["L02", true], ["L03", false], ["L04", false],
    ]);
    expect(ties[0].ties).toEqual([{ kind: "coauthor", via: "A benchmark for grids" }]);
    expect(ties[1].ties).toEqual([{ kind: "affiliation", via: "Corvid Analytics" }]);
    expect(ties[2].ties).toEqual([]); // same surname, different initial; look-alike organization
    expect(ties[3].ties.map((t) => t.kind).sort()).toEqual(["affiliation", "coauthor"]); // disclosed, not a violation
  });
});
