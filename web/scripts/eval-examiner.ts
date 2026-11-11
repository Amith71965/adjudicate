/**
 * Phase-5 exit gate: the adversarial examiner over the 16 seeded synthetic petitions.
 * usage: make api (other terminal), then npx tsx scripts/eval-examiner.ts [--heldout]
 *   → eval/results/phase5_examiner.json (dev set) or phase5_examiner_heldout.json
 * The held-out set (unseen half-evidence wordings) is run once, after the prompt is frozen.
 * Gate: >= 100 objections, 0 fabricated citations (re-verified against freshly fetched
 * passages), every planted mode-B half caught, every planted mode-D waiver caught.
 * Spend bound: <= MAX_CALLS calls on Haiku 5.5, all cached on disk (re-runs are free).
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { examinePetition, type ExaminerResult } from "../lib/examiner/examiner";
import { scoreExaminer, type ExaminerCase } from "../lib/examiner/examiner-eval";
import { mapPetition, type PetitionInput } from "../lib/examiner/mapper";
import { httpRetriever } from "../lib/examiner/retriever";
import { waiverFindings } from "../lib/examiner/waiver";
import type { Passage } from "../lib/examiner/citations";
import { cachedModel } from "../lib/llm/cached-model";

const ROOT = path.resolve(__dirname, "../..");
const API = process.env.ADJUDICATE_API ?? "http://127.0.0.1:8000";
const MODEL = "anthropic/claude-haiku-5.5";
const PRICE_PER_M = { input: 0.1, output: 0.5 }; // USD, list price used for the estimate
const MAX_CALLS = 240; // 16 mapper + 140 prong reviews + corrective retries
const CACHE_VERSION = "examiner-v3"; // bump when a prompt template or schema changes

const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env"), "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY missing in .env");
const { model, stats } = cachedModel(createOpenRouter({ apiKey: env.OPENROUTER_API_KEY })(MODEL), {
  dir: path.join(ROOT, ".cache", "examiner"), version: CACHE_VERSION, maxCalls: MAX_CALLS,
});

interface SetCase {
  petition: PetitionInput;
  planted_halves: ExaminerCase["planted_halves"];
  planted_unclaimed: ExaminerCase["planted_unclaimed"];
}
const HELDOUT = process.argv.includes("--heldout");
const SET = HELDOUT ? "eval/synthetic/phase5_heldout_petitions.json" : "eval/synthetic/phase5_petitions.json";
const RESULT = HELDOUT ? "eval/results/phase5_examiner_heldout.json" : "eval/results/phase5_examiner.json";
const cases = JSON.parse(readFileSync(path.join(ROOT, SET), "utf8")) as SetCase[];

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

async function main(): Promise<number> {
  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`retrieval API at ${API} is not healthy (${health?.status ?? "unreachable"}); run \`make api\``);
    return 2;
  }
  const retriever = httpRetriever(API);
  const scored: ExaminerCase[] = [];
  for (const c of cases) {
    const mapping = await mapPetition(c.petition, { model });
    const waiver = waiverFindings(c.petition.artifacts, mapping);
    const result: ExaminerResult = await examinePetition(c.petition, { model, retriever, concurrency: 4 });
    scored.push({
      petition_id: c.petition.id,
      claimed: Object.fromEntries(c.petition.artifacts.map((a) => [a.id, a.claimed_criterion ?? null])),
      planted_halves: c.planted_halves,
      planted_unclaimed: c.planted_unclaimed,
      result,
      waiver,
    });
    const notEst = result.reviews.filter((r) => !r.review.facially_met).map((r) => `${r.criterion}/${r.prong}`);
    console.log(`${c.petition.id}: ${result.reviews.length} reviewed, ${result.dropped.length} dropped, rfe_risk ${result.rfe_risk.toFixed(2)} | not facially met: ${notEst.join(", ") || "-"}`);
  }

  // Re-verify every cited passage against a fresh read of the database (via /passages).
  const cited = [...new Set(scored.flatMap((c) => c.result.reviews.flatMap((r) => r.review.citations.map((x) => x.chunk_id))))];
  const db = new Map<number, Passage>();
  for (const id of cited) {
    const res = await fetch(`${API}/passages/${id}`, { signal: AbortSignal.timeout(30_000) });
    if (res.status === 404) continue; // absent from the database: counted as fabricated
    if (!res.ok) throw new Error(`passage ${id}: HTTP ${res.status}`);
    const p = (await res.json()) as Passage;
    if (p.chunk_id !== id) throw new Error(`asked for passage ${id}, API returned ${p.chunk_id}`);
    db.set(id, { chunk_id: p.chunk_id, decision_id: p.decision_id, body: p.body });
  }

  const score = scoreExaminer(scored, db);
  const cost = (stats.inputTokens * PRICE_PER_M.input + stats.outputTokens * PRICE_PER_M.output) / 1e6;
  const out = {
    phase: 5, model: MODEL, cache_version: CACHE_VERSION, set: SET,
    llm: { ...stats, estimated_cost_usd: Number(cost.toFixed(4)), note: "calls/tokens count this run's provider calls only; cache hits are free" },
    score,
    petitions: scored.map((c) => ({
      // 4 dp: enough for a risk score, and long float digit runs read as SSNs to the PII guard.
      petition_id: c.petition_id, rfe_risk: round4(c.result.rfe_risk),
      criterion_risk: Object.fromEntries(Object.entries(c.result.criterion_risk).map(([k, v]) => [k, round4(v)])),
      complete: c.result.complete, unreviewed: c.result.unreviewed, waiver: c.waiver, dropped: c.result.dropped,
      reviews: c.result.reviews.map((r) => ({
        criterion: r.criterion, prong: r.prong, artifact_ids: r.artifact_ids, attempts: r.attempts,
        facially_met: r.review.facially_met, risk: r.review.risk, objection: r.review.objection, citations: r.review.citations,
      })),
    })),
  };
  writeFileSync(path.join(ROOT, RESULT), JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify({ ...score, fabricated: score.fabricated.slice(0, 5) }, null, 2));
  console.log(`llm: ${stats.calls} calls, ${stats.hits} cache hits, ~$${cost.toFixed(4)}`);
  return score.gate.passed ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => {
  console.error(err);
  process.exit(1);
});
