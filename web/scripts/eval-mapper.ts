/**
 * Phase-4 exit gate: run the blind mapper over the 20 seeded synthetic petitions.
 * usage: npx tsx scripts/eval-mapper.ts   → eval/results/phase4_mapper.json
 * Gate: top-1 ≥ 0.90 and every planted mode-A mismatch flagged.
 * Spend bound: ≤ 25 calls × 12k output tokens on Haiku 5.5 (≈ $0.16 worst case); cached.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { findMismatches, mapPetition, SYSTEM, validateMapping, type PetitionInput, type PetitionMapping } from "../lib/examiner/mapper";
import { scoreMapper, type ScoredCase } from "../lib/examiner/mapper-eval";

const ROOT = path.resolve(__dirname, "../..");
const MODEL = "anthropic/claude-haiku-5.5";
const MAX_CALLS = 25;
const CACHE_VERSION = "mapper-v2"; // bump when the prompt template or schema changes
const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env"), "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY missing in .env");
const model = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY })(MODEL);
const cacheDir = path.join(ROOT, ".cache", "mapper");
mkdirSync(cacheDir, { recursive: true });

const cases = JSON.parse(readFileSync(path.join(ROOT, "eval/synthetic/phase4_petitions.json"), "utf8")) as {
  petition: PetitionInput; truth: Record<string, string | null>; planted_mismatches: string[];
}[];

async function main(): Promise<number> {
  let calls = 0;
  const scored: ScoredCase[] = [];
  const failures: string[] = [];
  for (const c of cases) {
    const key = createHash("sha256").update(JSON.stringify([CACHE_VERSION, MODEL, SYSTEM, c.petition])).digest("hex");
    const file = path.join(cacheDir, `${key}.json`);
    let mapping: PetitionMapping;
    try {
      if (existsSync(file)) {
        mapping = validateMapping(c.petition, JSON.parse(readFileSync(file, "utf8")));
      } else {
        if (++calls > MAX_CALLS) throw new Error(`call cap ${MAX_CALLS} reached`);
        mapping = await mapPetition(c.petition, { model });
        writeFileSync(file, JSON.stringify(mapping));
      }
    } catch (err) {
      failures.push(`${c.petition.id}: ${err instanceof Error ? err.message : String(err)}`);
      console.log(`FAILED ${c.petition.id}`);
      continue;
    }
    const flagged = findMismatches(c.petition, mapping).map((f) => f.artifact_id);
    scored.push({
      truth: c.truth,
      predicted: Object.fromEntries(mapping.mappings.map((m) => [m.artifact_id, m.best_criterion])),
      planted: c.planted_mismatches,
      flagged,
    });
    console.log(`${c.petition.id}: flagged ${flagged.join(",") || "-"} | planted ${c.planted_mismatches.join(",")}`);
  }
  const score = scoreMapper(scored);
  const ok = failures.length === 0 && score.top1 >= 0.9 && score.modeARecall === 1;
  const report = { model: MODEL, petitions: cases.length, scored: scored.length, failures, ...score, gate: ok ? "PASS" : "FAIL", api_calls: calls };
  writeFileSync(path.join(ROOT, "eval/results/phase4_mapper.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
  return ok ? 0 : 1;
}

main().then((code) => process.exit(code), (err: unknown) => { console.error(err); process.exit(2); });
