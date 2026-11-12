// Fixes from the Phase-6 silent-failure review: each test names the finding it pins down.
import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { httpRetriever, RetrievalError } from "@/lib/examiner/retriever";
import { independenceTies, nameKey, namesAgree, orgKey } from "@/lib/letters/independence";
import { scoreLetters, type LetterCase } from "@/lib/letters/letters-eval";
import { reviewLetter } from "@/lib/letters/mechanism";
import { describeLetters } from "@/lib/merits/merits";
import { scoreMerits } from "@/lib/merits/merits-eval";
import type { LetterPacket } from "@/lib/letters/types";

describe("name and organization normalization", () => {
  it("#1 reads a comma-less 'Surname Initials' bibliography entry", () => {
    expect(nameKey("Smith J")).toBe("smith|j");
    expect(nameKey("Okafor-Lind TA")).toBe("okafor-lind|t");
  });
  it("#2 folds accents, keeps surname particles, drops suffixes and honorifics after a comma", () => {
    expect(nameKey("Müller, K.")).toBe(nameKey("Klaus Muller"));
    expect(nameKey("van der Berg, J.")).toBe(nameKey("Jan van der Berg"));
    expect(nameKey("John Smith Jr.")).toBe("smith|j");
    expect(nameKey("Smith, Dr. John")).toBe("smith|j");
  });
  it("#3 treats clashing full given names as different people, initials as compatible", () => {
    expect(namesAgree("Li, Wei", "Wen Li")).toBe(false);
    expect(namesAgree("Li, W.", "Wen Li")).toBe(true);
    expect(namesAgree("Dr. Wen Li", "Wen Li")).toBe(true);
  });
  it("#4 keeps campuses of one system apart, strips only known qualifiers", () => {
    expect(orgKey("University of California, Berkeley")).not.toBe(orgKey("University of California, San Diego"));
    expect(orgKey("Corvid Analytics, main campus")).toBe(orgKey("Corvid Analytics"));
  });
  it("#5 never matches on an empty key", () => {
    expect(orgKey("(Google)")).toBe("");
    expect(nameKey("Dr.")).toBe("");
  });
});

describe("independence ties", () => {
  const base = (letters: LetterPacket["letters"], pubAuthors = ["Li, Wei", "Vale, R."]): LetterPacket => ({
    petition_id: "P01", field: "f",
    beneficiary: { name: "Dr. Rowan Vale", affiliations: ["(Google)"], publications: [{ title: "T", authors: pubAuthors }] },
    letters,
  });
  const author = (name: string, affiliations = ["Larchmont College"]) => ({ name, title: "x", affiliations, claimed_independent: true });

  it("#3 does not tie a different person who shares surname and initial", () => {
    const t = independenceTies(base([{ id: "L01", sentences: ["x"], author: author("Wen Li") }]));
    expect(t[0].violation).toBe(false);
  });
  it("#5 does not tie two empty organization keys", () => {
    const t = independenceTies(base([{ id: "L01", sentences: ["x"], author: author("Bram Solvang", ["(Alphabet)"]) }]));
    expect(t[0].ties).toEqual([]);
  });
  it("#6 flags an author who shares the beneficiary's name instead of skipping them", () => {
    const t = independenceTies(base([{ id: "L01", sentences: ["x"], author: author("Rowan Vale") }]));
    expect(t[0].ties).toEqual([{ kind: "same_name", via: "Dr. Rowan Vale" }]);
    expect(t[0].violation).toBe(true);
  });
});

describe("merits inputs and scoring", () => {
  it("#7 says no letters were filed instead of inventing a praise share", () => {
    const text = describeLetters({ letters: 0, independent: 0, weak: 0, assertion_share: 1, boilerplate_pairs: 0, independence_violations: 0 });
    expect(text).toMatch(/No recommendation letters were filed/);
    expect(text).not.toMatch(/%/);
  });

  const DB = new Map([[1, { chunk_id: 1, decision_id: "D", body: "one of the small percentage at the very top of the field" }]]);
  const r = (petition_id: string, fav: boolean, risk: number) => ({
    status: "reviewed" as const, petition_id, attempts: 1, retrieved_chunk_ids: [1], first_attempt_problems: [], pruned: [],
    review: { sustained_acclaim: fav, top_of_field: fav, risk, reasoning: "x".repeat(40), citations: [{ chunk_id: 1, decision_id: "D", quote: "one of the small percentage at the very top" }] },
  });
  it("#11 does not count a weak petition as caught when its risk says it is likely approved", () => {
    const cases = [{ petition_id: "P1", tier: "strong" as const, pair: 0 }, { petition_id: "P2", tier: "weak" as const, pair: 0 }];
    const s = scoreMerits(cases, [r("P1", true, 0.1), r("P2", false, 0.35)], DB);
    expect(s.weak_caught).toBe(0);
    expect(s.gate.passed).toBe(false);
  });
  it("#12 rejects a pair without exactly one strong and one weak petition", () => {
    const cases = [{ petition_id: "P1", tier: "weak" as const, pair: 0 }, { petition_id: "P2", tier: "weak" as const, pair: 0 }];
    expect(() => scoreMerits(cases, [r("P1", false, 0.8), r("P2", false, 0.8)], DB)).toThrow(/pair 0/);
  });
});

it("#13 compares planted boilerplate pairs regardless of their order in the data", () => {
  const c: LetterCase = {
    packet: { petition_id: "P01", field: "f", beneficiary: { name: "B", affiliations: ["O"], publications: [] },
      letters: ["L01", "L02"].map((id) => ({ id, sentences: ["s"], author: { name: "A", title: "T", affiliations: ["X"], claimed_independent: true } })) },
    kinds: { L01: ["context"], L02: ["context"] },
    planted_boilerplate: [["L02", "L01"]],
    planted_violations: [{ letter_id: "L01", kind: "coauthor" }],
    near_misses: [],
  };
  const s = scoreLetters([c], [{
    petition_id: "P01", complete: true, unreviewed: [],
    letters: ["L01", "L02"].map((id) => ({ status: "reviewed" as const, letter_id: id, attempts: 1, labels: ["context" as const], reasons: ["r"], assertions: [], weak: true, first_attempt_problems: [] })),
    boilerplate: [{ a: "L01", b: "L02", shared: 9, passage: "p" }],
    independence: [{ letter_id: "L01", claimed_independent: true, ties: [{ kind: "coauthor", via: "t" }], violation: true }],
  }]);
  expect(s.boilerplate).toMatchObject({ found: 1, false_pairs: 0 });
});

it("#9 sizes the output budget to the letter", async () => {
  let budget = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      budget = options.maxOutputTokens ?? 0;
      return { content: [{ type: "text", text: "{}" }], finishReason: { unified: "stop", raw: undefined }, warnings: [],
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } };
    },
  });
  const sentences = Array.from({ length: 80 }, (_, i) => `Sentence number ${i}.`);
  await reviewLetter({ id: "L01", sentences, author: { name: "A", title: "T", affiliations: ["X"], claimed_independent: true } }, { model, field: "f" });
  expect(budget).toBeGreaterThanOrEqual(80 * 60);
});

it("#15 refuses results from an API that did not apply the section filter", async () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const old = httpRetriever("http://api", vi.fn(async () => ok({ results: [] })) as unknown as typeof fetch);
  await expect(old.search("q", { section: "final_merits", visa: "EB-1A", k: 3 })).rejects.toThrow(RetrievalError);
  const current = httpRetriever("http://api", vi.fn(async () => ok({ results: [], filters: { section: "final_merits", visa: "EB-1A", criterion: null } })) as unknown as typeof fetch);
  await expect(current.search("q", { section: "final_merits", visa: "EB-1A", k: 3 })).resolves.toEqual([]);
});

it("a retriever bound to a cutoff sends it and refuses an answer that did not apply it", async () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const calls: string[] = [];
  const fetchFn = vi.fn(async (url: string) => { calls.push(url); return ok({ results: [], filters: { before: "2026-06-01" } }); });
  await httpRetriever("http://api", fetchFn as unknown as typeof fetch, 1000, { before: "2026-06-01" })
    .search("q", { criterion: "judging", visa: "EB-1A", k: 3 });
  expect(new URL(calls[0]).searchParams.get("before")).toBe("2026-06-01");
  const ignoring = httpRetriever("http://api", (async () => ok({ results: [], filters: {} })) as unknown as typeof fetch, 1000, { before: "2026-06-01" });
  await expect(ignoring.search("q", { criterion: "judging", visa: "EB-1A", k: 3 })).rejects.toThrow(/before/);
});
