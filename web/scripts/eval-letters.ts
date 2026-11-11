/**
 * Phase-6 exit gate (letters): mode C, boilerplate and independence over 16 seeded synthetic
 * letter packets. usage: npx tsx scripts/eval-letters.ts [--heldout]
 *   → eval/results/phase6_letters.json (dev) or phase6_letters_heldout.json
 * The held-out set (unseen sentence templates) is run once, after the prompt is frozen on dev.
 * Gate: mode C recall >= 0.9 and precision >= 0.8; every planted boilerplate pair and
 * independence violation found, precision >= 0.8 for both; <= 5% of letters dropped.
 * Spend bound: <= MAX_CALLS calls on Haiku 5.5, cached on disk (re-runs are free). No API needed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { scoreLetters, type LetterCase } from "../lib/letters/letters-eval";
import { reviewPacket, type PacketReview } from "../lib/letters/mechanism";
import { cachedModel } from "../lib/llm/cached-model";

const ROOT = path.resolve(__dirname, "../..");
const MODEL = "anthropic/claude-haiku-5.5";
const PRICE_PER_M = { input: 0.1, output: 0.5 }; // USD, list price used for the estimate
const MAX_CALLS = 120; // ~75 letters per set + corrective retries
const CACHE_VERSION = "letters-v1"; // bump when the prompt template or schema changes

const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env"), "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY missing in .env");
const { model, stats } = cachedModel(createOpenRouter({ apiKey: env.OPENROUTER_API_KEY })(MODEL), {
  dir: path.join(ROOT, ".cache", "letters"), version: CACHE_VERSION, maxCalls: MAX_CALLS,
});

const HELDOUT = process.argv.includes("--heldout");
const SET = HELDOUT ? "eval/synthetic/phase6_letters_heldout.json" : "eval/synthetic/phase6_letters.json";
const RESULT = HELDOUT ? "eval/results/phase6_letters_heldout.json" : "eval/results/phase6_letters.json";
const cases = JSON.parse(readFileSync(path.join(ROOT, SET), "utf8")) as LetterCase[];

// 4 dp: enough for a rate, and long float digit runs read as SSNs to the PII guard.
const round4 = (v: unknown): unknown =>
  typeof v === "number" ? Math.round(v * 1e4) / 1e4
    : Array.isArray(v) ? v.map(round4)
      : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round4(x)])) : v;

async function main(): Promise<number> {
  const reviews: PacketReview[] = [];
  for (const c of cases) {
    const r = await reviewPacket(c.packet, { model, concurrency: 4 });
    reviews.push(r);
    const weak = r.letters.filter((l) => l.status === "reviewed" && l.weak).map((l) => l.letter_id);
    console.log(`${r.petition_id}: ${r.letters.length} letters, ${r.unreviewed.length} dropped | weak: ${weak.join(",") || "-"} | boilerplate: ${r.boilerplate.map((p) => `${p.a}~${p.b}`).join(",") || "-"} | violations: ${r.independence.filter((t) => t.violation).map((t) => t.letter_id).join(",") || "-"}`);
  }
  const score = scoreLetters(cases, reviews);
  // the misses, by sentence, so a reader can judge the detector, not just its rates
  const errors = cases.flatMap((c, i) => c.packet.letters.flatMap((l) => {
    const out = reviews[i].letters.find((x) => x.letter_id === l.id);
    return l.sentences.flatMap((s, j) => {
      const truth = c.kinds[l.id][j];
      const got = out?.status === "reviewed" ? out.labels[j] : "dropped";
      const wrong = truth.startsWith("assertion") !== (got === "assertion");
      return wrong ? [{ petition_id: c.packet.petition_id, letter_id: l.id, index: j, truth, got, sentence: s, reason: out?.status === "reviewed" ? out.reasons[j] : null }] : [];
    });
  }));
  const cost = (stats.inputTokens * PRICE_PER_M.input + stats.outputTokens * PRICE_PER_M.output) / 1e6;
  const out = {
    phase: 6, part: "letters", model: MODEL, cache_version: CACHE_VERSION, set: SET,
    llm: { ...stats, estimated_cost_usd: Number(cost.toFixed(4)), note: "calls/tokens count this run's provider calls only; cache hits are free" },
    score: round4(score),
    mode_c_errors: errors,
    petitions: reviews.map((r) => ({
      petition_id: r.petition_id, complete: r.complete, unreviewed: r.unreviewed,
      boilerplate: r.boilerplate, independence: r.independence,
      letters: r.letters.map((l) => l.status === "reviewed"
        ? { letter_id: l.letter_id, attempts: l.attempts, weak: l.weak, assertions: l.assertions, labels: l.labels }
        : l),
    })),
  };
  writeFileSync(path.join(ROOT, RESULT), JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(round4(score), null, 2));
  console.log(`mode C errors: ${errors.length}; llm: ${stats.calls} calls, ${stats.hits} cache hits, ~$${cost.toFixed(4)}`);
  return score.gate.passed ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => {
  console.error(err);
  process.exit(1);
});
