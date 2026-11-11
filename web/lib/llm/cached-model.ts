/**
 * Eval-time model wrapper: disk cache keyed by the full request, a hard cap on provider calls
 * (checked before sending, so a bug cannot overspend), and token accounting. Only clean
 * "stop" results are cached; truncated or failed generations are always refetched.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";

export class CallCapError extends Error {}

export interface CallStats {
  calls: number;
  hits: number;
  inputTokens: number;
  outputTokens: number;
  unknownUsageCalls: number; // provider calls that reported no token usage (cost unknown)
  cacheWriteFailures: number;
}

type GenerateResult = Awaited<ReturnType<NonNullable<LanguageModelMiddleware["wrapGenerate"]>>>;

/** A cache entry, or null if it is unreadable or not the shape we wrote. */
function readEntry(file: string): GenerateResult | null {
  try {
    const entry = JSON.parse(readFileSync(file, "utf8")) as Partial<GenerateResult>;
    if (!Array.isArray(entry.content) || entry.finishReason?.unified !== "stop" || !entry.usage) return null;
    return entry as GenerateResult;
  } catch {
    return null;
  }
}

type Wrappable = Parameters<typeof wrapLanguageModel>[0]["model"];

export function cachedModel(
  model: Wrappable,
  { dir, version, maxCalls }: { dir: string; version: string; maxCalls: number },
): { model: LanguageModel; stats: CallStats } {
  mkdirSync(dir, { recursive: true });
  const stats: CallStats = { calls: 0, hits: 0, inputTokens: 0, outputTokens: 0, unknownUsageCalls: 0, cacheWriteFailures: 0 };
  const wrapped = wrapLanguageModel({
    model,
    middleware: {
      wrapGenerate: async ({ doGenerate, params, model: inner }) => {
        // abortSignal/headers are per-call plumbing, not part of what is being asked.
        const { abortSignal: _signal, headers: _headers, ...request } = params;
        void _signal;
        void _headers;
        const key = createHash("sha256")
          .update(JSON.stringify([version, inner.provider, inner.modelId, request]))
          .digest("hex");
        const file = path.join(dir, `${key}.json`);
        if (existsSync(file)) {
          const cached = readEntry(file);
          if (cached) {
            stats.hits += 1;
            return cached;
          }
          rmSync(file, { force: true }); // corrupt or foreign entry: refetch, never trust
        }
        if (stats.calls >= maxCalls) throw new CallCapError(`call cap ${maxCalls} reached; request not sent`);
        stats.calls += 1;
        const result = await doGenerate();
        const { total: tin } = result.usage.inputTokens;
        const { total: tout } = result.usage.outputTokens;
        if (tin === undefined || tout === undefined) stats.unknownUsageCalls += 1;
        stats.inputTokens += tin ?? 0;
        stats.outputTokens += tout ?? 0;
        if (result.finishReason.unified === "stop") {
          const { content, finishReason, usage, providerMetadata, warnings } = result;
          const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`; // unique: concurrent writers
          try {
            writeFileSync(tmp, JSON.stringify({ content, finishReason, usage, providerMetadata, warnings }));
            renameSync(tmp, file); // atomic: a crash never leaves a half-written entry
          } catch (err) {
            // The response is paid for: return it, and say the cache could not keep it.
            stats.cacheWriteFailures += 1;
            rmSync(tmp, { force: true });
            console.warn(`cache write failed for ${file}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return result;
      },
    },
  });
  return { model: wrapped, stats };
}
