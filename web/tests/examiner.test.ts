import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { examinePetition, examineProng, reviewTasks, type Retriever } from "@/lib/examiner/examiner";
import { httpRetriever, RetrievalError } from "@/lib/examiner/retriever";
import { criterionRisk, probAtLeast, rfeRisk } from "@/lib/examiner/risk";
import { prongsFor } from "@/lib/examiner/prongs";
import type { PetitionInput } from "@/lib/examiner/mapper";

const petition: PetitionInput = {
  id: "P01", visa: "EB-1A", field: "computational biology", beneficiary: "Dr. Avery Quillfeather",
  artifacts: [
    { id: "A01", kind: "letter", title: "Letter from a startup co-founder", description: "Heads the team.", claimed_criterion: "leading_role" },
    { id: "A02", kind: "record", title: "Peer-review records", description: "Reviews completed.", claimed_criterion: "judging" },
    { id: "A03", kind: "publication", title: "Journal articles", description: "Three articles.", claimed_criterion: null },
  ],
};

const BODY_7 = "The Petitioner did not submit evidence establishing that the organization has a distinguished reputation in the field.";
const BODY_9 = "A leading role should be apparent by its position in the overall organizational hierarchy and the duties performed.";
const passages = [
  { chunk_id: 7, decision_id: "SEP152026_01B2203", body: BODY_7 },
  { chunk_id: 9, decision_id: "SEP172026_06B2203", body: BODY_9 },
];
const retriever = (out = passages): Retriever & { search: ReturnType<typeof vi.fn> } => ({ search: vi.fn(async () => out) });

const review = (citations: { chunk_id: number; decision_id: string; quote: string }[], established = false) => ({
  established, risk: established ? 0.2 : 0.85,
  objection: "The record does not establish the organization's distinguished reputation.", citations,
});
const GOOD = { chunk_id: 7, decision_id: "SEP152026_01B2203", quote: "did not submit evidence establishing that the organization" };
const FAKE = { chunk_id: 99, decision_id: "SEP152026_01B2203", quote: "a quotation from a passage that was never retrieved" };

function scripted(...payloads: unknown[]) {
  const prompts: string[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      const payload = payloads[Math.min(prompts.length - 1, payloads.length - 1)];
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        finishReason: { unified: "stop", raw: undefined },
        usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } },
        warnings: [],
      };
    },
  });
  return { model, prompts };
}

describe("reviewTasks", () => {
  it("makes one task per prong of each claimed criterion, with only the evidence filed under it", () => {
    const tasks = reviewTasks(petition);
    expect(tasks.map((t) => `${t.criterion}/${t.prong.id}`)).toEqual(["leading_role/role", "leading_role/reputation", "judging/whole"]);
    expect(tasks[0].artifacts.map((a) => a.id)).toEqual(["A01"]);
  });
});

describe("examineProng", () => {
  const task = () => reviewTasks(petition)[1]; // leading_role / reputation

  it("retrieves EB-1A reasoning for the criterion and grounds the review in it", async () => {
    const r = retriever();
    const { model, prompts } = scripted(review([GOOD]));
    const out = await examineProng(task(), { model, retriever: r });
    expect(r.search).toHaveBeenCalledWith(expect.stringContaining("reputation"), { criterion: "leading_role", visa: "EB-1A", k: 6 });
    expect(out.status).toBe("reviewed");
    if (out.status !== "reviewed") return;
    expect(out.review.citations).toEqual([GOOD]);
    expect(out.attempts).toBe(1);
    expect(prompts[0]).toContain("distinguished reputation in the field"); // passage bodies shown
    expect(prompts[0]).toContain("Letter from a startup co-founder");
  });

  it("retries once with the problems when a citation is invalid, and keeps a corrected answer", async () => {
    const { model, prompts } = scripted(review([FAKE]), review([GOOD]));
    const out = await examineProng(task(), { model, retriever: retriever() });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("chunk_not_retrieved");
    expect(out).toMatchObject({ status: "reviewed", attempts: 2 });
    if (out.status === "reviewed") expect(out.first_attempt_problems).toHaveLength(1);
  });

  it("drops the objection, and records why, when the retry still cites nothing valid", async () => {
    const { model, prompts } = scripted(review([FAKE]), review([{ ...GOOD, quote: "words that never appear in the passage at all" }]));
    const out = await examineProng(task(), { model, retriever: retriever() });
    expect(prompts).toHaveLength(2);
    expect(out).toMatchObject({ status: "dropped", reason: "invalid_citations", attempts: 2 });
  });

  it("prunes invalid citations on the retry when valid ones remain", async () => {
    const { model } = scripted(review([FAKE]), review([GOOD, FAKE]));
    const out = await examineProng(task(), { model, retriever: retriever() });
    expect(out.status).toBe("reviewed");
    if (out.status !== "reviewed") return;
    expect(out.review.citations).toEqual([GOOD]);
    expect(out.pruned.map((p) => p.reason)).toEqual(["chunk_not_retrieved"]);
  });

  it("does not ask the model when retrieval finds nothing to ground an objection in", async () => {
    const { model, prompts } = scripted(review([GOOD]));
    const out = await examineProng(task(), { model, retriever: retriever([]) });
    expect(out).toMatchObject({ status: "dropped", reason: "no_passages", attempts: 0 });
    expect(prompts).toHaveLength(0);
  });

  it("propagates retrieval failures instead of reviewing without precedent", async () => {
    const failing: Retriever = { search: async () => { throw new RetrievalError("search failed: 503"); } };
    const { model } = scripted(review([GOOD]));
    await expect(examineProng(task(), { model, retriever: failing })).rejects.toThrow(/503/);
  });
});

describe("examinePetition", () => {
  it("reviews every prong and scores RFE risk from the reviews", async () => {
    const { model } = scripted(review([GOOD]));
    const out = await examinePetition(petition, { model, retriever: retriever() });
    expect(out.reviews).toHaveLength(3);
    expect(out.dropped).toHaveLength(0);
    expect(out.criterion_risk.leading_role).toBeCloseTo(1 - 0.15 * 0.15);
    expect(out.rfe_risk).toBe(1); // two claimed criteria can never reach three
  });
});

describe("httpRetriever", () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  it("searches with the filters and fetches each hit's full passage", async () => {
    const fetchFn = vi.fn(async (url: string) =>
      url.includes("/search")
        ? ok({ results: [{ chunk_id: 7, decision_id: "SEP152026_01B2203", snippet: "trunc" }] })
        : ok({ chunk_id: 7, decision_id: "SEP152026_01B2203", body: BODY_7 }));
    const r = httpRetriever("http://api", fetchFn as unknown as typeof fetch);
    const out = await r.search("reputation", { criterion: "leading_role", visa: "EB-1A", k: 6 });
    expect(out).toEqual([{ chunk_id: 7, decision_id: "SEP152026_01B2203", body: BODY_7 }]);
    const searchUrl = new URL(fetchFn.mock.calls[0][0]);
    expect(Object.fromEntries(searchUrl.searchParams)).toMatchObject({ q: "reputation", criterion: "leading_role", visa: "EB-1A", k: "6" });
    expect(fetchFn.mock.calls[1][0]).toBe("http://api/passages/7");
  });
  it("fails loudly on a non-OK response", async () => {
    const r = httpRetriever("http://api", (async () => new Response("index incomplete", { status: 503 })) as unknown as typeof fetch);
    await expect(r.search("q", { criterion: "judging", visa: "EB-1A", k: 6 })).rejects.toThrow(RetrievalError);
  });
});

describe("risk", () => {
  it("computes the probability that at least k independent criteria hold", () => {
    expect(probAtLeast([1, 1, 1], 3)).toBe(1);
    expect(probAtLeast([0.5, 0.5], 1)).toBeCloseTo(0.75);
    expect(probAtLeast([], 1)).toBe(0);
    expect(probAtLeast([0.2], 0)).toBe(1);
  });
  it("fails a criterion when any of its prongs fails", () => {
    expect(criterionRisk([0.5, 0.5])).toBeCloseTo(0.75);
    expect(() => criterionRisk([])).toThrow();
  });
  it("scores RFE risk as the chance fewer than three criteria survive", () => {
    expect(rfeRisk({ a: 0, b: 0, c: 0 })).toBe(0);
    expect(rfeRisk({ a: 0, b: 0 })).toBe(1);
  });
});

describe("cross-language prong table", () => {
  it("knows every prong the Python generator plants as missing", () => {
    const file = path.resolve(__dirname, "../../eval/synthetic/phase5_petitions.json");
    const cases = JSON.parse(readFileSync(file, "utf8")) as { planted_halves: { criterion: string; missing_prongs: string[] }[] }[];
    const halves = cases.flatMap((c) => c.planted_halves);
    expect(new Set(halves.map((h) => h.criterion)).size).toBe(4);
    for (const h of halves) {
      const ids = prongsFor(h.criterion).map((p) => p.id);
      for (const m of h.missing_prongs) expect(ids).toContain(m);
    }
  });
});
