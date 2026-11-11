/**
 * The examiner as a service: one cached, call-capped model per server process (the same disk
 * cache and version as the Phase-5 eval, so identical requests are free), and a retriever
 * bound to the request's cutoff. Configuration comes from the repo-root .env and environment.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { examinePetition } from "@/lib/examiner/examiner";
import { httpRetriever } from "@/lib/examiner/retriever";
import { cachedModel } from "@/lib/llm/cached-model";
import type { ExamineDeps } from "./examine-handler";

const MODEL = "anthropic/claude-haiku-5.5";
export const EXAMINER_CACHE_VERSION = "examiner-v3"; // shared with scripts/eval-examiner.ts

function config(): Record<string, string> {
  const root = process.env.ADJUDICATE_ROOT ?? path.resolve(process.cwd(), "..");
  let file: Record<string, string> = {};
  try {
    file = Object.fromEntries(
      readFileSync(path.join(root, ".env"), "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
        .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
    );
  } catch {
    // no .env: fall back to the process environment alone
  }
  return { ...file, ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)), ADJUDICATE_ROOT: root };
}

let deps: ExamineDeps | undefined;

export function examinerService(): ExamineDeps {
  if (deps) return deps;
  const env = config();
  if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY missing (repo .env or environment)");
  const maxCalls = Number(env.ADJUDICATE_MAX_CALLS ?? "2000");
  if (!Number.isInteger(maxCalls) || maxCalls <= 0) throw new Error(`ADJUDICATE_MAX_CALLS must be a positive integer, got ${env.ADJUDICATE_MAX_CALLS}`);
  const { model, stats } = cachedModel(createOpenRouter({ apiKey: env.OPENROUTER_API_KEY })(MODEL), {
    dir: path.join(env.ADJUDICATE_ROOT, ".cache", "examiner"), version: EXAMINER_CACHE_VERSION, maxCalls,
  });
  const api = env.ADJUDICATE_API ?? "http://127.0.0.1:8000";
  deps = {
    examine: (petition, before) =>
      examinePetition(petition, { model, retriever: httpRetriever(api, fetch, 30_000, before ? { before } : {}), concurrency: 4 }),
    stats: () => ({ ...stats, model: MODEL }),
  };
  return deps;
}
