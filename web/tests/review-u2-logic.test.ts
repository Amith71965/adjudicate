/**
 * U2 pure logic: which PDF text items hold a cited quote (so the viewer can highlight them),
 * a readable date from a USCIS decision id, and the memo turned into safe blocks for preview.
 */
import { describe, expect, it } from "vitest";
import { decisionDate } from "@/lib/review/format";
import { memoBlocks } from "@/lib/review/memo-view";
import { quoteItems } from "@/lib/review/pdf-highlight";

describe("quoteItems", () => {
  const items = ["In this case, the record shows", "that the letters praise the work, but", "they do not contain", "information indicating that experts", "judge membership. See, e.g., Matter of"];

  it("finds the items a quote spans, across line breaks", () => {
    expect(quoteItems(items, "they do not contain information indicating that experts judge membership.")).toEqual([2, 3, 4]);
  });

  it("matches case and whitespace loosely", () => {
    expect(quoteItems(items, "THEY  do not\ncontain information")).toEqual([2, 3]);
  });

  it("falls back to the opening words when an OCR repair changed the tail", () => {
    // only the words that really match are highlighted, never a guessed tail
    expect(quoteItems(items, "they do not contain information indicating that experts judge membersh1p carefully")).toEqual([2, 3]);
  });

  it("returns nothing rather than guessing", () => {
    expect(quoteItems(items, "the petitioner is a famous juggler")).toEqual([]);
    expect(quoteItems(items, "the")).toEqual([]);
  });
});

describe("decisionDate", () => {
  it("reads the issue date encoded in a decision id", () => {
    expect(decisionDate("AUG172026_02B2203")).toBe("17 Aug 2026");
    expect(decisionDate("JAN012026_01B2203")).toBe("1 Jan 2026");
  });

  it("is empty for an id it cannot read", () => {
    expect(decisionDate("P08")).toBe("");
  });
});

describe("memoBlocks", () => {
  const memo = "# Adjudicate pre-filing review: P01\n\nField: x.\n\n## judging / whole\n\n- JAN012026_01B2203, passage 7: \"q\"\n\n**Resolved by A.** Added <b>reports</b>.";

  it("turns the memo into headings, paragraphs, lists and a bold lead, never raw HTML", () => {
    expect(memoBlocks(memo)).toEqual([
      { kind: "h1", text: "Adjudicate pre-filing review: P01" },
      { kind: "p", parts: [{ text: "Field: x." }] },
      { kind: "h2", text: "judging / whole" },
      { kind: "ul", items: ["JAN012026_01B2203, passage 7: \"q\""] },
      { kind: "p", parts: [{ text: "Resolved by A.", bold: true }, { text: " Added <b>reports</b>." }] },
    ]);
  });
});
