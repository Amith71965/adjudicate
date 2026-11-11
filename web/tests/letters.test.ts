import { describe, expect, it } from "vitest";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { LETTER_SYSTEM, reviewLetter, reviewPacket } from "@/lib/letters/mechanism";
import type { LetterPacket } from "@/lib/letters/types";

const letter = {
  id: "L01",
  author: { name: "Dr. Bram Solvang", title: "Professor", affiliations: ["Larchmont College"], claimed_independent: true },
  sentences: [
    "I lead the grids group at Larchmont College.",
    "Their controller cut outages from 40 to 9 a year at two utilities.",
    "Their contributions are of major significance to the field.",
  ],
};
const verdicts = (labels: string[], indices = labels.map((_, i) => i)) => ({
  sentences: labels.map((label, i) => ({ index: indices[i], label, reason: "because" })),
});

function scripted(...payloads: unknown[]) {
  const prompts: string[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      const payload = payloads[Math.min(prompts.length - 1, payloads.length - 1)];
      return {
        content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }],
        finishReason: { unified: "stop", raw: undefined },
        usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } },
        warnings: [],
      };
    },
  });
  return { model, prompts };
}

describe("reviewLetter (mode C: assertion without mechanism)", () => {
  it("labels every sentence by index and lists the assertions", async () => {
    const { model, prompts } = scripted(verdicts(["context", "mechanism", "assertion"]));
    const out = await reviewLetter(letter, { model, field: "grid engineering" });
    expect(out).toMatchObject({ status: "reviewed", letter_id: "L01", attempts: 1, labels: ["context", "mechanism", "assertion"], assertions: [2], weak: false });
    expect(prompts[0]).toContain("[1] Their controller cut outages");
    expect(LETTER_SYSTEM).toMatch(/mechanism/);
  });

  it("calls a letter weak when no sentence states a mechanism", async () => {
    const { model } = scripted(verdicts(["context", "assertion", "assertion"]));
    expect(await reviewLetter(letter, { model, field: "f" })).toMatchObject({ weak: true, assertions: [1, 2] });
  });

  it("retries once, naming the gap, when labels skip or repeat a sentence", async () => {
    const { model, prompts } = scripted(verdicts(["context", "assertion", "assertion"], [0, 2, 2]), verdicts(["context", "mechanism", "assertion"]));
    const out = await reviewLetter(letter, { model, field: "f" });
    expect(out).toMatchObject({ status: "reviewed", attempts: 2 });
    expect(prompts[1]).toMatch(/sentence 1 has no label/);
    expect(prompts[1]).toMatch(/sentence 2 is labelled more than once/);
  });

  it("drops the letter when the second answer still does not cover every sentence once", async () => {
    const { model } = scripted(verdicts(["context"]), verdicts(["context", "mechanism", "assertion", "assertion"], [0, 1, 2, 7]));
    const out = await reviewLetter(letter, { model, field: "f" });
    expect(out).toMatchObject({ status: "dropped", reason: "invalid_coverage", attempts: 2 });
    if (out.status === "dropped") expect(out.problems.join(" ")).toMatch(/sentence 7 does not exist/);
  });

  it("retries a schema miss once, then drops it as invalid_output", async () => {
    const { model, prompts } = scripted("not json", "still not json");
    expect(await reviewLetter(letter, { model, field: "f" })).toMatchObject({ status: "dropped", reason: "invalid_output", attempts: 2 });
    expect(prompts).toHaveLength(2);
  });

  it("propagates transport errors instead of dropping the letter", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => { throw new APICallError({ message: "402 budget", url: "u", requestBodyValues: {}, statusCode: 402 }); },
    });
    await expect(reviewLetter(letter, { model, field: "f" })).rejects.toThrow(/402/);
  });
});

describe("reviewPacket", () => {
  const packet: LetterPacket = {
    petition_id: "P01",
    field: "grid engineering",
    beneficiary: { name: "Dr. Rowan Vale", affiliations: ["Corvid Analytics"], publications: [] },
    letters: [letter, { ...letter, id: "L02", author: { ...letter.author, name: "Ingrid Henmarsh", affiliations: ["Corvid Analytics"] } }],
  };

  it("joins sentence reviews with boilerplate and independence findings", async () => {
    const { model } = scripted(verdicts(["context", "mechanism", "assertion"]));
    const out = await reviewPacket(packet, { model, concurrency: 2 });
    expect(out.letters.map((l) => l.status)).toEqual(["reviewed", "reviewed"]);
    expect(out.complete).toBe(true);
    expect(out.boilerplate.map((p) => [p.a, p.b])).toEqual([["L01", "L02"]]); // identical letters
    expect(out.independence.map((t) => t.violation)).toEqual([false, true]);
  });

  it("is incomplete when any letter was dropped", async () => {
    const { model } = scripted("not json");
    const out = await reviewPacket(packet, { model });
    expect(out.complete).toBe(false);
    expect(out.unreviewed).toEqual(["L01", "L02"]);
  });
});
