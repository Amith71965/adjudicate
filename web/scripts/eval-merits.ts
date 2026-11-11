/**
 * Phase-6 exit gate (merits): Kazarian step two over 6 seeded strong/weak pairs that both pass
 * step one. usage: make api (other terminal), then npx tsx scripts/eval-merits.ts [--heldout]
 *   → eval/results/phase6_merits.json (dev) or phase6_merits_heldout.json
 * Gate: every weak petition judged unfavorable, every pair ordered by >= 0.2 risk, 0 fabricated
 * citations (re-verified against freshly fetched passages), nothing dropped. Strong-favorable
 * rate is reported, not gated (ADR-016). Spend bound: <= MAX_CALLS calls on Haiku 5.5, cached.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { Passage } from "../lib/examiner/citations";
import { httpRetriever } from "../lib/examiner/retriever";
import { meritsPass, type MeritsInput, type MeritsOutcome } from "../lib/merits/merits";
import { scoreMerits, type MeritsCase } from "../lib/merits/merits-eval";
import { cachedModel } from "../lib/llm/cached-model";

const ROOT = path.resolve(__dirname, "../..");
const API = process.env.ADJUDICATE_API ?? "http://127.0.0.1:8000";
const MODEL = "anthropic/claude-haiku-5.5";
const PRICE_PER_M = { input: 0.1, output: 0.5 }; // USD, list price used for the estimate
const MAX_CALLS = 30; // 12 petitions + corrective retries
const CACHE_VERSION = "merits-v2"; // bump when the prompt template or schema changes

const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env"), "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY missing in .env");
const { model, stats } = cachedModel(createOpenRouter({ apiKey: env.OPENROUTER_API_KEY })(MODEL), {
  dir: path.join(ROOT, ".cache", "merits"), version: CACHE_VERSION, maxCalls: MAX_CALLS,
});

const HELDOUT = process.argv.includes("--heldout");
const SET = HELDOUT ? "eval/synthetic/phase6_merits_heldout.json" : "eval/synthetic/phase6_merits.json";
const RESULT = HELDOUT ? "eval/results/phase6_merits_heldout.json" : "eval/results/phase6_merits.json";
const raw = JSON.parse(readFileSync(path.join(ROOT, SET), "utf8")) as { input: MeritsInput; tier: "strong" | "weak"; pair: number }[];

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

async function main(): Promise<number> {
  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`retrieval API at ${API} is not healthy (${health?.status ?? "unreachable"}); run \`make api\``);
    return 2;
  }
  const retriever = httpRetriever(API);
  const outcomes: MeritsOutcome[] = [];
  for (const c of raw) {
    const o = await meritsPass(c.input, { model, retriever });
    outcomes.push(o);
    console.log(`${c.input.petition.id} (pair ${c.pair}, ${c.tier}): ${o.status === "reviewed"
      ? `acclaim ${o.review.sustained_acclaim}, top ${o.review.top_of_field}, risk ${o.review.risk}`
      : `dropped: ${o.reason}`}`);
  }

  const cited = [...new Set(outcomes.flatMap((o) => (o.status === "reviewed" ? o.review.citations.map((x) => x.chunk_id) : [])))];
  const db = new Map<number, Passage>();
  for (const id of cited) {
    const res = await fetch(`${API}/passages/${id}`, { signal: AbortSignal.timeout(30_000) });
    if (res.status === 404) continue; // absent from the database: counted as fabricated
    if (!res.ok) throw new Error(`passage ${id}: HTTP ${res.status}`);
    const p = (await res.json()) as Passage;
    if (p.chunk_id !== id) throw new Error(`asked for passage ${id}, API returned ${p.chunk_id}`);
    db.set(id, { chunk_id: p.chunk_id, decision_id: p.decision_id, body: p.body });
  }

  const cases: MeritsCase[] = raw.map((c) => ({ petition_id: c.input.petition.id, tier: c.tier, pair: c.pair }));
  const score = scoreMerits(cases, outcomes, db);
  const cost = (stats.inputTokens * PRICE_PER_M.input + stats.outputTokens * PRICE_PER_M.output) / 1e6;
  const out = {
    phase: 6, part: "merits", model: MODEL, cache_version: CACHE_VERSION, set: SET,
    llm: { ...stats, estimated_cost_usd: Number(cost.toFixed(4)), note: "calls/tokens count this run's provider calls only; cache hits are free" },
    score: { ...score, accuracy: round4(score.accuracy), min_margin: round4(score.min_margin) },
    petitions: outcomes.map((o, i) => ({
      petition_id: o.petition_id, tier: raw[i].tier, pair: raw[i].pair, status: o.status, attempts: o.attempts,
      ...(o.status === "reviewed"
        ? { sustained_acclaim: o.review.sustained_acclaim, top_of_field: o.review.top_of_field, risk: round4(o.review.risk), reasoning: o.review.reasoning, citations: o.review.citations, pruned: o.pruned }
        : { reason: o.reason, problems: o.problems }),
    })),
  };
  writeFileSync(path.join(ROOT, RESULT), JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out.score, null, 2));
  console.log(`llm: ${stats.calls} calls, ${stats.hits} cache hits, ~$${cost.toFixed(4)}`);
  return score.gate.passed ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => {
  console.error(err);
  process.exit(1);
});
