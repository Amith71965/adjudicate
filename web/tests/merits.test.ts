import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { letterSummary, MERITS_SYSTEM, meritsPass } from "@/lib/merits/merits";
import type { Retriever } from "@/lib/examiner/retriever";
import type { PacketReview } from "@/lib/letters/mechanism";
import type { MeritsInput } from "@/lib/merits/merits";

const BODY = "In the final merits determination, the record does not demonstrate that the Petitioner is one of the small percentage at the very top of the field.";
const passages = [{ chunk_id: 11, decision_id: "SEP172026_06B2203", body: BODY }];
const retriever = (out = passages): Retriever & { search: ReturnType<typeof vi.fn> } => ({ search: vi.fn(async () => out) });

const input: MeritsInput = {
  petition: {
    id: "P02", visa: "EB-1A", field: "grid engineering", beneficiary: "Dr. Rowan Vale",
    artifacts: [
      { id: "A01", kind: "record", title: "Peer review confirmations", description: "Six reviews.", claimed_criterion: "judging" },
      { id: "A02", kind: "publication", title: "Five conference papers", description: "38 citations.", claimed_criterion: "scholarly_articles" },
      { id: "A03", kind: "certificate", title: "Best paper award", description: "National conference.", claimed_criterion: "awards" },
    ],
  },
  step_one: [{ criterion: "judging", risk: 0.2 }, { criterion: "scholarly_articles", risk: 0.15 }, { criterion: "awards", risk: 0.3 }],
  letters: { letters: 4, independent: 1, weak: 3, assertion_share: 0.8, boilerplate_pairs: 1, independence_violations: 1 },
};
const GOOD = { chunk_id: 11, decision_id: "SEP172026_06B2203", quote: "one of the small percentage at the very top of the field" };
const FAKE = { chunk_id: 12, decision_id: "SEP172026_06B2203", quote: "a quotation from a passage nobody retrieved here" };
const answer = (citations: unknown[]) => ({
  sustained_acclaim: false, top_of_field: false, risk: 0.85,
  reasoning: "Six peer reviews and modestly cited papers are routine in the field and do not show acclaim.", citations,
});

function scripted(...payloads: unknown[]) {
  const prompts: string[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return {
        content: [{ type: "text", text: JSON.stringify(payloads[Math.min(prompts.length - 1, payloads.length - 1)]) }],
        finishReason: { unified: "stop", raw: undefined },
        usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } },
        warnings: [],
      };
    },
  });
  return { model, prompts };
}

describe("meritsPass (Kazarian step two)", () => {
  it("weighs the whole record against final-merits reasoning and returns a grounded review", async () => {
    const r = retriever();
    const { model, prompts } = scripted(answer([GOOD]));
    const out = await meritsPass(input, { model, retriever: r });
    expect(out).toMatchObject({ status: "reviewed", petition_id: "P02", attempts: 1, retrieved_chunk_ids: [11] });
    if (out.status === "reviewed") expect(out.review.top_of_field).toBe(false);
    expect(r.search.mock.calls[0][1]).toEqual({ section: "final_merits", visa: "EB-1A", k: 6 });
    for (const needle of [
      "Peer review confirmations", "judging", "chunk_id 11",
      // letter findings in words: raw field names were misread ("assertion_share" as "shared phrasing")
      "80% of letter sentences praise without stating a mechanism",
      "1 letter presented as independent comes from someone tied to the beneficiary",
      "1 pair of letters shares boilerplate",
    ]) {
      expect(prompts[0]).toContain(needle);
    }
    expect(MERITS_SYSTEM).toMatch(/small percentage/);
    expect(prompts[0]).not.toContain("assertion_share");
  });

  it("drops without calling the model when no final-merits reasoning is retrieved", async () => {
    const { model, prompts } = scripted(answer([GOOD]));
    expect(await meritsPass(input, { model, retriever: retriever([]) })).toMatchObject({ status: "dropped", reason: "no_passages", attempts: 0 });
    expect(prompts).toHaveLength(0);
  });

  it("retries a fabricated citation once and drops the review if none survives", async () => {
    const { model, prompts } = scripted(answer([FAKE]), answer([FAKE]));
    const out = await meritsPass(input, { model, retriever: retriever() });
    expect(out).toMatchObject({ status: "dropped", reason: "invalid_citations", attempts: 2 });
    expect(prompts[1]).toMatch(/chunk_not_retrieved/);
  });
});

describe("letterSummary", () => {
  const review: PacketReview = {
    petition_id: "P01", complete: false, unreviewed: ["L03"],
    letters: [
      { status: "reviewed", letter_id: "L01", attempts: 1, labels: ["context", "mechanism", "assertion"], reasons: [], assertions: [2], weak: false, first_attempt_problems: [] },
      { status: "reviewed", letter_id: "L02", attempts: 1, labels: ["context", "assertion", "assertion"], reasons: [], assertions: [1, 2], weak: true, first_attempt_problems: [] },
      { status: "dropped", letter_id: "L03", attempts: 2, reason: "invalid_output", problems: [] },
    ],
    boilerplate: [{ a: "L01", b: "L02", shared: 12, passage: "p" }],
    independence: [
      { letter_id: "L01", claimed_independent: true, ties: [], violation: false },
      { letter_id: "L02", claimed_independent: true, ties: [{ kind: "coauthor", via: "t" }], violation: true },
      { letter_id: "L03", claimed_independent: false, ties: [], violation: false },
    ],
  };

  it("summarizes findings, counting an unreviewed letter as weak, never as a pass", () => {
    expect(letterSummary(review)).toEqual({
      letters: 3, independent: 1, weak: 2, assertion_share: 0.5, boilerplate_pairs: 1, independence_violations: 1,
    });
  });
});
